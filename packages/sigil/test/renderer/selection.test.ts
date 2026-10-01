import { ESC } from '../../src/ansi/index.js';
import { createCanvas, createSelection } from '../../src/canvas/index.js';
import { box, text } from '../../src/element/index.js';
import type { InputRouter, MouseHandler, MouseEvent, KeyHandler } from '../../src/input/index.js';
import { enableSelection, render } from '../../src/renderer/index.js';
import { createEffects } from '../../src/signals/index.js';
import { State } from '../../src/signals/index.js';
import type { Terminal } from '../../src/terminal/index.js';
import { beforeEach, describe, expect, it } from 'vitest';

/**
 * Selection through the renderer: the overlay a frame draws, the text it reads
 * back, and the gestures `enableSelection()` turns into one.
 *
 * The pieces each have their own tests -- the geometry over a literal grid, the
 * mask over an arranged tree, the encoder over a string. This is the half none
 * of them can say: that a frame actually draws the highlight, that the text
 * comes off the frame that was painted, and that a drag produces the selection
 * the user drew.
 */

/** A backend over a canvas, with a terminal that collects its writes. */
function harness(width = 20, height = 4) {
	const canvas = createCanvas({ height, width });
	const out: string[] = [];
	const resizeListeners = new Set<(size: { height: number; width: number }) => void>();

	const terminal = {
		height: 24,
		onResize(fn: (size: { height: number; width: number }) => void) {
			resizeListeners.add(fn);
			return () => resizeListeners.delete(fn);
		},
		restore() {},
		width,
		write(chunk: string) {
			out.push(chunk);
			return true;
		},
	} as unknown as Terminal;

	const backend = {
		active: true,
		canvas,
		done() {},
		get height() {
			return canvas.height;
		},
		isLive: true,
		present() {},
		render(draw: (painter: never, canvas: never) => void) {
			canvas.paint(draw as never);
		},
		resize(w: number, h: number) {
			canvas.resize(w, h);
		},
		stop() {},
		terminal,
		get width() {
			return canvas.width;
		},
		write() {},
	};

	return {
		backend: backend as never,
		canvas,
		out,
		/**
		 * The SGR parameter lists the diff emits for the frame last painted.
		 *
		 * The one public way to see what style a cell ended up in: the table is the
		 * canvas's own. Parameters rather than bytes, which is the rule
		 * `report.test.ts` already keeps -- a transition combines what it closes
		 * with what it opens, so pinning a whole sequence pins one implementation of
		 * the transition rather than the claim.
		 */
		sgr() {
			const output = canvas.present({ full: true }).output;
			return [...output.matchAll(new RegExp(`${ESC}\\[([\\d;]*)m`, 'g'))].map((m) =>
				m[1].split(';')
			);
		},
		resize(w: number, h: number) {
			(terminal as { width: number }).width = w;
			(terminal as { height: number }).height = h;
			for (const fn of resizeListeners) {
				fn({ height: h, width: w });
			}
		},
		terminal,
	};
}

/**
 * A router with nothing behind it, which is all the driver asks for.
 *
 * `createInput()` refuses to exist without a TTY on both sides, deliberately,
 * and what the driver uses is four members of the interface -- so this is the
 * structural minimum rather than a mock of a router.
 */
function router() {
	const mousers = new Set<MouseHandler>();
	const binds = new Set<KeyHandler>();
	const focus = new State<undefined | { focusable: boolean }>(undefined);

	return {
		bind(handler: KeyHandler) {
			binds.add(handler);
			return () => void binds.delete(handler);
		},
		focus: { current: focus } as never,
		/** Dispatches a mouse event, the way the router's own `onMouse` step does. */
		mouse(event: Partial<MouseEvent>) {
			const full = {
				button: 'left' as const,
				ctrl: false,
				current: undefined,
				kind: 'mousedown' as const,
				meta: false,
				shift: false,
				stop() {},
				stopped: false,
				target: undefined,
				wheel: undefined,
				x: 0,
				y: 0,
				...event,
			};
			for (const handler of mousers) {
				handler(full as MouseEvent);
			}
		},
		onMouse(handler: MouseHandler) {
			mousers.add(handler);
			return () => void mousers.delete(handler);
		},
		/** Presses a key, the way the router's bindings step does. */
		press(key: { ctrl?: boolean; meta?: boolean; name: string; shift?: boolean }) {
			let stopped = false;
			const event = {
				current: undefined,
				key: { ctrl: false, meta: false, sequence: '', shift: false, ...key },
				paste: false,
				stop() {
					stopped = true;
				},
				get stopped() {
					return stopped;
				},
				target: undefined,
			};
			for (const handler of binds) {
				handler(event as never);
			}
			return stopped;
		},
		setFocus(next: undefined | { focusable: boolean }) {
			focus.set(next);
		},
	};
}

let effects = createEffects();
beforeEach(() => {
	effects = createEffects();
});

/** A column of two texts, which is the tree every test here paints. */
const App = () => box({ 'flex-direction': 'column' }, text('hello world'), text('second line'));

describe('the selection overlay', () => {
	it('should draw the highlight into the frame it painted', () => {
		// a colour level named explicitly, because a vitest worker's stdout is a
		// pipe and `supportsColor()` answers 0 there -- which is the level-0 rule
		// working, and would make this assert nothing
		const h = harness();
		const view = render(App, {
			backend: h.backend,
			colorLevel: 3,
			effects,
			terminal: h.terminal,
		});

		expect(h.sgr()).toEqual([]);

		view.setSelection(createSelection({ x: 6, y: 0 }, { x: 5, y: 1 }));
		view.frame();

		// `7` is inverse, and something closed it again -- a frame that left it open
		// would carry the highlight into whatever is written next
		expect(h.sgr().some((params) => params.includes('7'))).toBe(true);
		expect(view.selectionText()).toBe('world\nsecond');
	});

	it('should draw no highlight at colour level 0, where level 3 draws one', () => {
		// the rule the prompt caret already follows: at level 0 the seven attributes
		// go too, so a reverse-video highlight would be the one sequence `NO_COLOR`
		// could not switch off. The selection still exists and still copies.
		//
		// Both levels in one test on purpose: a vitest worker's own level is 0, so a
		// test that only asserted the absence would pass with the guard deleted
		const sel = createSelection({ x: 6, y: 0 }, { x: 5, y: 1 });
		const drawn = (colorLevel: 0 | 3) => {
			const h = harness();
			const view = render(App, { backend: h.backend, colorLevel, effects, terminal: h.terminal });
			view.setSelection(sel);
			view.frame();
			return { sgr: h.sgr(), text: view.selectionText() };
		};

		expect(drawn(3).sgr.some((params) => params.includes('7'))).toBe(true);
		expect(drawn(0).sgr).toEqual([]);
		// and the copy is the same either way, which is what "what is lost is the
		// highlight" means
		expect(drawn(0).text).toBe('world\nsecond');
		expect(drawn(3).text).toBe('world\nsecond');
	});

	it('should take the highlight off again when the selection goes', () => {
		const h = harness();
		const view = render(App, {
			backend: h.backend,
			colorLevel: 3,
			effects,
			terminal: h.terminal,
		});
		view.setSelection(createSelection({ x: 0, y: 0 }, { x: 4, y: 0 }));
		view.frame();
		// asserted before the half this test is named for, or a frame that never
		// drew the highlight at all passes it: both sides would be empty, which is
		// what a sabotage of the repaint flag found
		expect(h.sgr().some((params) => params.includes('7'))).toBe(true);

		view.setSelection(undefined);
		view.frame();
		expect(h.sgr()).toEqual([]);
	});

	it('should read the text off the frame rather than off the tree', () => {
		// which is the whole model: laid-out text, so a wrapped paragraph copies
		// with its wrap points in it
		const h = harness(6, 4);
		const view = render(() => box({ width: 6 }, text('alpha beta gamma')), {
			backend: h.backend,
			effects,
			terminal: h.terminal,
		});
		view.setSelection(createSelection({ x: 0, y: 0 }, { x: 5, y: 2 }));
		view.frame();
		expect(view.selectionText()).toBe('alpha\nbeta\ngamma');
	});

	it('should follow a selection that moved without anything else changing', () => {
		const h = harness();
		const view = render(App, { backend: h.backend, effects, terminal: h.terminal });

		view.setSelection(createSelection({ x: 0, y: 0 }, { x: 4, y: 0 }));
		view.frame();
		expect(view.selectionText()).toBe('hello');

		view.setSelection(createSelection({ x: 0, y: 1 }, { x: 5, y: 1 }));
		view.frame();
		expect(view.selectionText()).toBe('second');
	});

	it('should answer nothing with nothing selected', () => {
		const h = harness();
		const view = render(App, { backend: h.backend, effects, terminal: h.terminal });
		expect(view.selection).toBeUndefined();
		expect(view.selectionText()).toBe('');
	});

	it('should clear the selection on a resize, because the cells named a screen that has gone', () => {
		const h = harness();
		const view = render(App, { backend: h.backend, effects, terminal: h.terminal });
		view.setSelection(createSelection({ x: 0, y: 0 }, { x: 4, y: 0 }));
		view.frame();
		expect(view.selection).toBeDefined();

		h.resize(30, 10);
		expect(view.selection).toBeUndefined();
		view.frame();
		expect(view.selectionText()).toBe('');
	});

	it('should leave a cell nothing may copy unhighlighted, as well as uncopied', () => {
		// a highlight over something that will not copy is a lie about what a copy
		// would give you -- and the extraction's mask and the overlay's are two
		// separate wirings, so asserting the text alone leaves one of them loose
		const drawn = (selectable: boolean) => {
			const h = harness();
			const view = render(() => box({}, text('private', { selectable })), {
				backend: h.backend,
				colorLevel: 3,
				effects,
				terminal: h.terminal,
			});
			view.setSelection(createSelection({ x: 0, y: 0 }, { x: 6, y: 0 }));
			view.frame();
			return h.sgr().some((params) => params.includes('7'));
		};

		expect(drawn(true)).toBe(true);
		expect(drawn(false)).toBe(false);
	});

	it('should leave a cell nothing may copy out of what it answers', () => {
		const h = harness();
		const view = render(
			() =>
				box(
					{ 'flex-direction': 'column' },
					text('visible'),
					text('private', { selectable: false })
				),
			{ backend: h.backend, effects, terminal: h.terminal }
		);
		view.setSelection(createSelection({ x: 0, y: 0 }, { x: 6, y: 1 }));
		view.frame();
		expect(view.selectionText()).toBe('visible\n');
	});
});

describe('enableSelection', () => {
	function mounted(width = 20, height = 4) {
		const h = harness(width, height);
		const view = render(App, { backend: h.backend, effects, terminal: h.terminal });
		const input = router();
		const selection = enableSelection(view, input as unknown as InputRouter);
		return { h, input, selection, view };
	}

	it('should select nothing for a click with no drag', () => {
		// which is what a terminal does: the press records an anchor and the first
		// motion is what makes a selection
		const { input, view } = mounted();
		input.mouse({ kind: 'mousedown', x: 2, y: 0 });
		input.mouse({ kind: 'mouseup', x: 2, y: 0 });
		expect(view.selection).toBeUndefined();
	});

	it('should select what a drag covered', () => {
		const { input, selection, view } = mounted();
		input.mouse({ kind: 'mousedown', x: 0, y: 0 });
		input.mouse({ kind: 'mousemove', x: 4, y: 0 });
		view.frame();
		expect(selection.text()).toBe('hello');
		expect(view.selection?.mode).toBe('linear');
	});

	it('should make an alt-drag rectangular', () => {
		const { input, view } = mounted();
		input.mouse({ kind: 'mousedown', meta: true, x: 0, y: 0 });
		input.mouse({ kind: 'mousemove', meta: true, x: 4, y: 1 });
		view.frame();
		expect(view.selection?.mode).toBe('block');
		expect(view.selectionText()).toBe('hello\nsecon');
	});

	it('should leave a shift-drag to the terminal', () => {
		// where a terminal honours shift as the override this never sees the report;
		// where it forwards one with the bit set, acting on it would put a selection
		// of ours underneath the terminal's own
		const { input, view } = mounted();
		input.mouse({ kind: 'mousedown', shift: true, x: 0, y: 0 });
		input.mouse({ kind: 'mousemove', shift: true, x: 4, y: 0 });
		expect(view.selection).toBeUndefined();
	});

	it('should clear a selection when a new press starts', () => {
		const { input, view } = mounted();
		input.mouse({ kind: 'mousedown', x: 0, y: 0 });
		input.mouse({ kind: 'mousemove', x: 4, y: 0 });
		expect(view.selection).toBeDefined();
		input.mouse({ kind: 'mousedown', x: 1, y: 1 });
		expect(view.selection).toBeUndefined();
	});

	it('should extend with shift and an arrow when nothing is focused', () => {
		const { input, selection, view } = mounted();
		selection.begin(0, 0);
		input.press({ name: 'right', shift: true });
		input.press({ name: 'right', shift: true });
		view.frame();
		expect(selection.text()).toBe('hel');
	});

	it('should leave shift and an arrow to a focused element', () => {
		// a binding is ahead of the focused element, and shift-arrow inside a text
		// field is that field's -- which is the rule `03-focus.js` already follows
		// for its own `q`
		const { input, selection } = mounted();
		selection.begin(0, 0);
		input.setFocus({ focusable: true });
		expect(input.press({ name: 'right', shift: true })).toBe(false);
		expect(selection.current?.focus).toEqual({ x: 0, y: 0 });
	});

	it('should ignore a key whose name a plain object would answer for', () => {
		// `ARROWS` is null-prototype, which is the rule this repo records for every
		// lookup table: on a plain object `constructor` reads back a truthy function,
		// so the step would have an `x` of `undefined` and the focus would be `NaN`
		const { input, selection } = mounted();
		selection.begin(2, 1);
		for (const name of ['constructor', 'toString', '__proto__']) {
			expect(input.press({ name, shift: true })).toBe(false);
		}
		expect(selection.current?.focus).toEqual({ x: 2, y: 1 });
	});

	it('should ignore an arrow with no shift', () => {
		const { input, selection } = mounted();
		selection.begin(0, 0);
		expect(input.press({ name: 'right' })).toBe(false);
		expect(selection.current?.focus).toEqual({ x: 0, y: 0 });
	});

	it('should start at the origin where shift and an arrow find no selection', () => {
		const { input, view } = mounted();
		input.press({ name: 'down', shift: true });
		expect(view.selection?.anchor).toEqual({ x: 0, y: 0 });
	});

	it('should clamp a keyboard extension to the canvas', () => {
		// unlike a drag, which a capture lets wander off: an arrow key has no
		// capture to honour, and an unclamped focus walking further off the edge
		// every keystroke is a selection that looks stuck
		const { input, selection } = mounted(20, 4);
		selection.begin(0, 0);
		input.press({ name: 'left', shift: true });
		input.press({ name: 'left', shift: true });
		input.press({ name: 'up', shift: true });
		expect(selection.current?.focus).toEqual({ x: 0, y: 0 });
	});

	it('should bind no keys where it was told not to', () => {
		const h = harness();
		const view = render(App, { backend: h.backend, effects, terminal: h.terminal });
		const input = router();
		enableSelection(view, input as unknown as InputRouter, { keys: false });
		expect(input.press({ name: 'right', shift: true })).toBe(false);
		expect(view.selection).toBeUndefined();
	});

	it('should copy the selected text with OSC 52', () => {
		const { h, input, selection, view } = mounted();
		input.mouse({ kind: 'mousedown', x: 0, y: 0 });
		input.mouse({ kind: 'mousemove', x: 4, y: 0 });
		view.frame();

		const copy = selection.copy();
		expect(copy.written).toBe(true);
		expect(h.out).toEqual([`${ESC}]52;c;${Buffer.from('hello').toString('base64')}${ESC}\\`]);
	});

	it('should copy nothing with nothing selected, rather than clearing the clipboard', () => {
		const { h, selection } = mounted();
		expect(selection.copy()).toMatchObject({ refused: 'empty', written: false });
		expect(h.out).toEqual([]);
	});

	it('should take its handlers off and leave the selection where it was', () => {
		const { input, selection, view } = mounted();
		input.mouse({ kind: 'mousedown', x: 0, y: 0 });
		input.mouse({ kind: 'mousemove', x: 4, y: 0 });
		const was = view.selection;

		selection.stop();
		input.mouse({ kind: 'mousedown', x: 2, y: 1 });
		input.press({ name: 'right', shift: true });
		expect(view.selection).toBe(was);
	});
});
