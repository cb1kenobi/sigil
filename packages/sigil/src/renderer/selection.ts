/**
 * Driving a selection from the mouse and the keyboard.
 *
 * The parts underneath are deliberately dumb: a `Selection` is two cells, the
 * canvas knows how to highlight and extract them, the tree knows which cells may
 * be copied, and `copyToClipboard()` knows OSC 52. What is left is the gesture,
 * and that is here rather than in the router for the reason every other decision
 * about what an app does with input is the app's: a drag is a selection only
 * where nothing else wanted it, and `enableSelection()` is how an app says so.
 *
 * **Why this exists at all.** Mouse tracking takes the terminal's own selection
 * away -- a terminal reporting the mouse stops doing its own -- so an app that
 * enabled it has, from the user's point of view, broken copy and paste. The
 * escape hatch is weaker than it looks: which key overrides tracking is the
 * terminal's own, shift in xterm and most of what followed it, and **alt/option
 * in iTerm2, where shift does nothing at all**. Nothing an app can detect or
 * influence. So this gives selection back.
 */

import { createSelection, type Selection, type SelectionMode } from '../canvas/index.js';
import type { InputRouter, MouseEvent } from '../input/index.js';
import {
	type ClipboardCopy,
	type ClipboardOptions,
	copyToClipboard,
} from '../terminal/clipboard.js';
import type { Renderer } from './index.js';

/** Which modifier makes a drag rectangular. */
export type BlockModifier = 'alt' | 'ctrl' | 'none';

export interface SelectionOptions {
	/**
	 * What makes a drag rectangular rather than linear. Alt by default.
	 *
	 * Alt is what Windows Terminal and iTerm2 use for a block selection, so it is
	 * the one people already know -- and it carries a caveat worth knowing before
	 * it reads as a bug: **in iTerm2 alt is also what overrides mouse reporting**,
	 * so an alt-drag there never reaches the app at all. That is not a failure of
	 * this option. What the user gets instead is the terminal's own selection,
	 * which is the thing they were reaching for; and `'ctrl'`, which is xterm's
	 * spelling, is here for an app that wants the block mode reachable everywhere.
	 * `'none'` turns the gesture off and leaves the mode to `begin()`.
	 */
	block?: BlockModifier;
	/** What `copy()` passes through to the clipboard. */
	clipboard?: ClipboardOptions;
	/**
	 * Whether shift and an arrow key extend the selection. On by default.
	 *
	 * Only while **nothing is focused**, which is the rule `03-focus.js` already
	 * follows for its own `q`: a focused text input owns shift-arrow for its own
	 * selection, and a binding sees every key before anything focused does, so
	 * taking it unconditionally would steal it. With nothing focused there is
	 * nothing it could belong to.
	 *
	 * With no selection, shift-arrow starts one at the canvas's own origin, which
	 * is the only cell this layer can name -- an app that wants somewhere else
	 * calls `begin()` first.
	 */
	keys?: boolean;
}

export interface SelectionHandle {
	/** Clears the selection. */
	clear(): void;
	/**
	 * Writes the selected text to the clipboard with OSC 52.
	 *
	 * **There is no default binding for this**, which is settled rather than
	 * missing: Ctrl-C is the abort and the binding order exists so that an app
	 * cannot become unquittable, and Ctrl-Shift-C reaches a terminal as the same
	 * `0x03` Ctrl-C does without the Kitty keyboard protocol. A framework claiming
	 * either would be claiming a key it cannot hear or one it must not take, so an
	 * app binds whatever it likes and calls this.
	 *
	 * @param opts - Overrides whatever `enableSelection()` was given.
	 * @returns What was sent. **Never a claim that the clipboard changed** -- there
	 *   is no reply to an OSC 52, several terminals refuse it, and tmux needs
	 *   `set -g set-clipboard on`.
	 */
	copy(opts?: ClipboardOptions): ClipboardCopy;
	/** What is selected, if anything. */
	readonly current: Selection | undefined;
	/**
	 * Selects from one cell, which is what a drag or a keyboard extension grows.
	 *
	 * @param x - The column, in the canvas's own cells.
	 * @param y - The row.
	 * @param mode - Linear by default.
	 */
	begin(x: number, y: number, mode?: SelectionMode): void;
	/**
	 * Moves the focus end to a cell, keeping the anchor where it was.
	 *
	 * @param x - The column.
	 * @param y - The row.
	 */
	extend(x: number, y: number): void;
	/** Takes the handlers off. The selection itself is left where it was. */
	stop(): void;
	/** The selected text, read off the frame last painted. */
	text(): string;
}

/**
 * Which way an arrow key moves.
 *
 * Null-prototype, which is the rule this repo records for every lookup table it
 * has: on a plain object `constructor` reads back a truthy function, so a key of
 * that name would be a step whose `x` is `undefined` and a focus of `NaN`.
 *
 * The prototype rather than an `Object.hasOwn` beside it, which is **one**
 * mechanism where the convention asks for two -- and the reason is that the
 * second half of that convention is about the *write* side, `lookup['__proto__']
 * = name` going through an accessor and being dropped, which a frozen constant
 * nobody writes to cannot have. Both were written and a sabotage pass found each
 * covered by the other, which is the masking this file already records from the
 * JSX source-type pinning: with two, removing either fails nothing.
 */
const ARROWS: Record<string, { x: number; y: number }> = {
	down: { x: 0, y: 1 },
	left: { x: -1, y: 0 },
	right: { x: 1, y: 0 },
	up: { x: 0, y: -1 },
};
// set afterwards rather than written as a `__proto__` key, which is the rule the
// template's own tables record: that key makes TypeScript type the literal
// loosely, and the point here is the runtime defense rather than the spelling
Object.setPrototypeOf(ARROWS, null);

/** Whether a mouse event carries the modifier that asks for a block. */
function wantsBlock(event: MouseEvent, modifier: BlockModifier): boolean {
	return modifier === 'alt' ? event.meta : modifier === 'ctrl' ? event.ctrl : false;
}

/**
 * Wires a selection up to a router.
 *
 * @param view - The renderer, which holds the selection and paints it.
 * @param input - The router. Mouse tracking has to be on for a drag to arrive.
 * @param opts - The block modifier, the keyboard, and the clipboard options.
 * @returns The handle.
 */
export function enableSelection(
	view: Renderer,
	input: InputRouter,
	opts: SelectionOptions = {}
): SelectionHandle {
	const block = opts.block ?? 'alt';
	const clipboard = opts.clipboard;

	/** Where the current gesture started, and in which mode. */
	let anchor: { mode: SelectionMode; x: number; y: number } | undefined;

	const handle: SelectionHandle = {
		begin(x, y, mode = 'linear'): void {
			anchor = { mode, x, y };
			view.setSelection(createSelection({ x, y }, { x, y }, mode));
		},

		clear(): void {
			anchor = undefined;
			view.setSelection(undefined);
		},

		copy(over?: ClipboardOptions): ClipboardCopy {
			return copyToClipboard(view.backend.terminal, view.selectionText(), {
				...clipboard,
				...over,
			});
		},

		get current() {
			return view.selection;
		},

		extend(x, y): void {
			const from = anchor ?? view.selection?.anchor;
			const mode = anchor?.mode ?? view.selection?.mode ?? 'linear';
			if (!from) {
				handle.begin(x, y, mode);
				return;
			}
			anchor ??= { mode, x: from.x, y: from.y };
			view.setSelection(createSelection(from, { x, y }, mode));
		},

		stop(): void {
			offMouse();
			offKeys?.();
		},

		text(): string {
			return view.selectionText();
		},
	};

	const offMouse = input.onMouse((event) => {
		// shift is left alone, deliberately. Where a terminal honours it as the
		// override this never sees the report at all; where it forwards one with the
		// shift bit set, acting on it would put a selection of ours underneath the
		// terminal's own. Either way the user's muscle memory is the terminal's to
		// serve
		if (event.shift) {
			return;
		}

		if (event.kind === 'mousedown' && event.button === 'left') {
			// the press clears and records, and does **not** select: a click with no
			// drag leaves nothing selected, which is what a terminal does. The first
			// motion report is what makes a selection, which is why `anchor` is kept
			// here rather than as a one-cell selection nobody asked for
			anchor = {
				mode: wantsBlock(event, block) ? 'block' : 'linear',
				x: event.x,
				y: event.y,
			};
			view.setSelection(undefined);
			return;
		}

		if (event.kind === 'mousemove' && anchor && event.button === 'left') {
			view.setSelection(createSelection(anchor, { x: event.x, y: event.y }, anchor.mode));
		}
	});

	const offKeys =
		opts.keys === false
			? undefined
			: input.bind((event) => {
					if (!event.key.shift) {
						return;
					}
					// nothing focused only, for the reason `SelectionOptions.keys` gives:
					// a binding is ahead of the focused element, and shift-arrow inside a
					// text field is that field's
					if (input.focus.current.get() !== undefined) {
						return;
					}
					const step = ARROWS[event.key.name];
					if (!step) {
						return;
					}
					event.stop();

					const at = view.selection?.focus;
					if (!at) {
						// the canvas's own origin, which is the only cell this layer can
						// name without inventing a caret nothing else reads
						handle.begin(0, 0);
						return;
					}
					// clamped, unlike a drag: a press captures the pointer so a drag's
					// focus may legitimately be off the canvas, while an arrow key has no
					// capture to honour -- and an unclamped focus walking further off the
					// edge every keystroke is a selection that looks stuck for as many
					// presses as it took to get there
					handle.extend(
						Math.max(0, Math.min(view.backend.width - 1, at.x + step.x)),
						Math.max(0, Math.min(view.backend.height - 1, at.y + step.y))
					);
				});

	return handle;
}
