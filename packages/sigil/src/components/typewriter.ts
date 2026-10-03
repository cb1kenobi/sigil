/**
 * A typewriter: text that arrives rather than appears.
 *
 * A splash screen typing itself out, a log line landing word by word, an agent's
 * answer streaming in. It takes a string and a way of cutting it into chunks, and
 * reveals one chunk at a time.
 *
 * **It reveals by chunk rather than by column, and that is the whole design.**
 * The classic CSS typewriter animates `width` over `overflow: hidden`, which
 * cannot work here: a wide cluster is two columns, so a column-at-a-time sweep
 * shows half a glyph -- exactly the state the canvas diff works to prevent -- and
 * a ZWJ emoji is one chunk that a sweep would cut into pieces. It also only works
 * on one line, because a column sweep reveals left to right on every row at once,
 * which is not what anybody means by a paragraph typing itself out. Cutting the
 * text where `graphemes()` says one character ends and the next begins makes the
 * wide cluster, the combining mark, the flag and the family emoji fall out rather
 * than need handling.
 *
 * It is a component rather than a keyframe animation, for the reason the spinner
 * is: what it steps is *content*, and there is no animatable content property.
 */

import { box, type Element, text as textNode } from '../element/index.js';
import { createEffect, onCleanup } from '../renderer/index.js';
import { State, untrack } from '../signals/index.js';
import { terminal as defaultTerminal } from '../terminal/index.js';
import { graphemes } from '../width/index.js';
import { type Mounted, type MountOptions, mountLive } from './mount.js';

/** How long a chunk is held before the next one, when nothing says otherwise. */
const INTERVAL = 40;

/** Cuts text into the chunks a reveal steps through. */
export type Chunker = (value: string) => readonly string[];

/** How long one chunk is held before the next, in milliseconds. */
export type Pace = (chunk: string, index: number) => number;

/**
 * Words, each carrying the whitespace that precedes it.
 *
 * Whitespace travels *forward* -- `byLine()` does the same -- so that no chunk
 * reveals nothing: a space on its own is a step in which the screen does not
 * change, which reads as a dropped frame rather than as typing. A newline is
 * whitespace too, so a line break arrives with the first word of its line.
 *
 * Any whitespace after the last word joins that word's chunk, so the chunks
 * always concatenate back to the string they came from.
 *
 * @param value - The text.
 * @returns The chunks, in order.
 */
export function byWord(value: string): string[] {
	const chunks: string[] = [];
	const words = /\s*\S+/g;
	let end = 0;

	for (let found = words.exec(value); found !== null; found = words.exec(value)) {
		chunks.push(found[0]);
		end = words.lastIndex;
	}

	const tail = value.slice(end);
	if (tail !== '') {
		if (chunks.length > 0) {
			chunks[chunks.length - 1] += tail;
		} else {
			chunks.push(tail);
		}
	}

	return chunks;
}

/**
 * Lines, each carrying the break that precedes it.
 *
 * Forward for the reason `byWord()` is, and it is the half that reads oddly until
 * you watch it: a break revealed at the *end* of a line leaves the cursor
 * dangling on an empty row for one step, while a break revealed with the line it
 * opens leaves it sitting where the text just stopped.
 *
 * @param value - The text.
 * @returns The chunks, in order.
 */
export function byLine(value: string): string[] {
	return value
		.split('\n')
		.map((line, index) => (index === 0 ? line : `\n${line}`))
		.filter((chunk) => chunk !== '');
}

/** One step of a reveal: where it lands, and the text it put on screen. */
export interface RevealStep {
	/** The chunk this step reveals. */
	readonly chunk: string;
	/** How much of the text is shown once it has been taken. */
	readonly end: number;
}

/**
 * The steps a reveal takes through a string.
 *
 * The chunker decides where the steps land and the *string* decides what is
 * shown, which is what makes any chunker safe to pass. A chunk that runs past the
 * end is clamped, one that adds nothing is dropped, and a chunker that loses
 * characters -- or returns nothing at all -- still ends with the whole string
 * revealed, because the last step is forced to the end. Without that a lossy
 * chunker would strand the reveal one character short with the cursor still on,
 * which looks like a hung animation rather than like a chunker with a bug in it.
 *
 * Each step's `chunk` is sliced out of the string rather than taken from the
 * chunker, so that `Pace` is shown what reached the screen: a caller pausing
 * after a full stop is asking about the text, and the two part company exactly
 * when the chunker is wrong.
 *
 * @param value - The text being revealed.
 * @param chunk - How to cut it.
 * @returns The steps, in order. Empty for an empty string.
 */
export function revealSteps(value: string, chunk: Chunker): RevealStep[] {
	const steps: RevealStep[] = [];
	const length = value.length;
	let at = 0;

	for (const piece of chunk(value)) {
		const end = Math.min(at + piece.length, length);
		if (end > at) {
			steps.push({ chunk: value.slice(at, end), end });
			at = end;
		}
		// a fast path and nothing more: every chunk after the end clamps to the end,
		// so `end > at` is false and none of them is pushed. What it buys is the
		// walk, for a chunker that answers with far more chunks than the string has
		// characters in it
		if (at >= length) {
			break;
		}
	}

	if (at < length) {
		steps.push({ chunk: value.slice(at), end: length });
	}

	return steps;
}

/** How many characters two strings begin the same way. */
function shared(a: string, b: string): number {
	const limit = Math.min(a.length, b.length);
	let at = 0;
	while (at < limit && a.charCodeAt(at) === b.charCodeAt(at)) {
		at++;
	}
	return at;
}

/** What a typewriter's tree is driven by, and what the facade writes to. */
export interface TypewriterState {
	/**
	 * How much of the text is on screen, as an offset into it.
	 *
	 * An offset rather than a count of chunks, because the chunk boundaries move
	 * when the text does and an offset survives that. Appending `a` to `hel` and
	 * re-chunking by word turns one chunk into another, and appending a combining
	 * mark turns `a` into one cluster two code units long -- so a count of chunks
	 * would have to round back to a boundary and re-reveal what was already on
	 * screen, which is a visible stutter on every append.
	 *
	 * It is therefore allowed to sit inside a cluster for exactly as long as it
	 * takes the next step to land, which is the only moment anything can put it
	 * there.
	 */
	readonly revealed: State<number>;
	/** What is being typed. */
	readonly text: State<string>;
}

/**
 * Builds the state a typewriter's tree reads.
 *
 * @param text - What to type.
 * @returns The signals.
 */
export function typewriterState(text = ''): TypewriterState {
	return { revealed: new State(0), text: new State(text) };
}

export interface TypewriterViewOptions {
	/**
	 * What to draw at the write head. Nothing by default.
	 *
	 * A character rather than an attribute over a cell, which is the one decision
	 * in this component that is not the obvious one. The prompt's caret is reverse
	 * video over the cluster the cursor is on, and that cannot work here for a
	 * reason the layout records: there is no inline layout, so a caret beside a
	 * `text` is a second flex item placed beside that text's *box* -- which for
	 * text that wraps is the end of its **first** row. Measured: a caret after a
	 * two-row paragraph lands at the end of row one.
	 *
	 * Putting it in the string instead is always right -- it wraps with the text,
	 * it follows the last character through a broken over-long word, and it moves
	 * to a new row when the row it was on filled up. What it costs is a class of
	 * its own, so a theme cannot colour the cursor apart from the text. It buys
	 * back the thing a reverse-video caret loses: at colour level 0 every
	 * attribute is dropped, so the prompt's caret is deliberately not drawn there
	 * at all, and a glyph is what survives `NO_COLOR`.
	 *
	 * It is drawn only while there is more to reveal, because the write head is
	 * where the next character goes and a finished line has no next character --
	 * which is also what keeps a cursor out of the log.
	 */
	cursor?: string;
}

/**
 * The typewriter, as an element tree.
 *
 * One `text` element, because one is all it takes: a `text` wraps at the width it
 * is given and keeps the newlines the author wrote, so the revealed prefix of a
 * paragraph lays itself out.
 *
 * Nothing here bounds that width, and a `max-width` of the terminal's was written
 * and deleted again for failing its sabotage: an auto-width canvas is measured at
 * the terminal and capped there by the renderer, and `renderToString()` lays out
 * at the width it was given, so both paths were already bounded.
 *
 * What is *not* redundant is `min-width: 0` rather than the automatic minimum,
 * which for a text is its longest word. The canvas is capped either way, so
 * without it a word longer than the terminal keeps its width and is cut off at the
 * canvas edge rather than broken -- which is the rule `paragraph()` gives its own
 * words, and the reason it gives it: a text that disagreed with `wrap()` about an
 * over-long word is a frame wider than the terminal it was asked to fit.
 *
 * @param state - What it reads.
 * @param opts - The cursor and what bounds the text.
 * @returns The tree.
 */
export function typewriterView(state: TypewriterState, opts: TypewriterViewOptions = {}): Element {
	const body = textNode('', { class: 'sigil-typewriter-text', 'min-width': 0 });

	createEffect(() => {
		const value = state.text.get();
		const at = Math.max(0, Math.min(value.length, state.revealed.get()));
		// the cursor only while there is a write head for it to be at
		const head = opts.cursor !== undefined && at < value.length ? opts.cursor : '';
		body.setText(value.slice(0, at) + head);
	});

	return box({ class: 'sigil-typewriter' }, body);
}

export interface TypewriterRevealOptions {
	/**
	 * Whether the reveal is gradual, or the whole text arrives at once.
	 *
	 * False in a pipe, in a CI log, and under a reduced-motion opt-out, which is
	 * one question rather than three: `mountLive()` hands the build what the
	 * renderer resolved, and the renderer's own answer already folds a missing
	 * terminal in. A build log with one line per keystroke is what this is for.
	 *
	 * A function rather than a boolean because it is also what says the typewriter
	 * is *running*, and that moves: `done()` turns it off and the whole text has to
	 * arrive at once, including the text `done()` was handed. Read on every run, so
	 * turning it off is what finishes the reveal rather than a second mechanism
	 * beside it.
	 */
	animate: () => boolean;
	/** How to cut the text. Graphemes by default. */
	chunk?: Chunker;
	/** How long each chunk is held before the next. A flat `interval` by default. */
	pace?: Pace;
	/** The flat delay, in milliseconds. Defaults to 40. */
	interval?: number;
}

/**
 * Drives the reveal: one timer, rescheduled per chunk.
 *
 * Call it inside a component body, beside `typewriterView()`. It is the half an
 * app building its own tree would otherwise have to write, and it is where all
 * four rules the frame loop asks for live.
 *
 * **No timer when nothing is revealing.** The last chunk schedules nothing, so a
 * finished typewriter holds no timer and a CLI that prints one line never
 * acquires a frame loop. **The timer is unref'd**, because a program that has
 * finished should exit even if somebody forgot to stop it. **The clock is the
 * timer**, and there is deliberately no `now` to inject: nothing here measures
 * elapsed time, it only schedules, so fake timers are the whole of what a test
 * needs -- where the animator has a `now` precisely because it computes how far
 * through a duration it is.
 *
 * **And the text may change under it.** A reveal keeps as much as the new text
 * still says: the position is clamped to the characters the old and new text
 * share, so appending continues from where it had got to and a divergence
 * re-reveals from the point where the two part. Restarting instead would retype
 * the whole answer on every token a stream appends, which is the case this exists
 * for; snapping would throw the effect away.
 *
 * @param state - What it writes.
 * @param opts - Whether to animate, how to cut, and how fast.
 */
export function typewriterReveal(state: TypewriterState, opts: TypewriterRevealOptions): void {
	const chunk = opts.chunk ?? graphemes;
	const flat = opts.interval !== undefined && opts.interval >= 0 ? opts.interval : INTERVAL;
	const pace = opts.pace;
	/** The text the position on screen is an offset into, for the prefix rule. */
	let shown = '';

	createEffect(() => {
		const value = state.text.get();
		// untracked: a step writes this signal, and an effect that read it here
		// would re-run -- and re-chunk the whole string -- once per chunk, which is
		// quadratic in the length of the text for no answer that changes
		const was = untrack(() => state.revealed.get());
		const kept = Math.min(was, shared(shown, value));
		shown = value;

		if (!opts.animate()) {
			state.revealed.set(value.length);
			return;
		}

		const steps = revealSteps(value, chunk);

		// the first chunk lands on the first frame rather than one interval later: a
		// typewriter showing an empty line before it starts reads as a stall, and it
		// is what makes `pace` unambiguously the time a chunk is *held* -- so the
		// delay before a chunk is the one the chunk in front of it earned, and the
		// last chunk's is never used.
		//
		// It is `<` rather than `=== 0` because the clamp above can leave the
		// position *inside* the first step: typing a combining mark onto an `a` that
		// is already on screen makes the two one cluster, so a position of 1 is a
		// cluster boundary that has stopped being one. Snapping forward to the end of
		// the step it fell into is what keeps that from stalling the whole reveal,
		// which `=== 0` did -- the schedule below has no previous chunk to take a
		// delay from and gave up
		let at = kept;
		if (steps.length > 0 && at < steps[0]!.end) {
			at = steps[0]!.end;
		}
		state.revealed.set(at);

		let timer: ReturnType<typeof setTimeout> | undefined;

		const hold = (index: number): number => {
			const earned = pace === undefined ? flat : pace(steps[index]!.chunk, index);
			// a pace that answers with nothing usable is read as the flat interval
			// rather than as zero: `NaN` would schedule immediately and reveal the
			// whole text in one macrotask, which is the one failure that looks like
			// the feature being broken rather than like a bad return value.
			//
			// A negative one is passed through, because `setTimeout` documents a delay
			// under 1 as 1 -- so a `Math.max(0, ...)` here was this file saying what
			// the host already says, and it failed its sabotage for exactly that
			// reason. The contract is still asserted; it is simply kept somewhere else
			return Number.isFinite(earned) ? earned : flat;
		};

		const schedule = (): void => {
			const now = state.revealed.get();
			// the step this would take, or none. Nothing left to reveal answers `-1`
			// here, so there is no separate check for the end: a guard for it was
			// written and deleted again for being subsumed by this one
			const next = steps.findIndex((step) => step.end > now);
			// there is no chunk in front of the next one to take a delay from. `-1` is
			// how the end of the reveal arrives and is the half that fires; `0` cannot
			// be reached, because the snap above leaves the position at or past the end
			// of the first step, and it is caught by the same comparison rather than
			// by a second one
			if (next < 1) {
				return;
			}

			timer = setTimeout(
				() => {
					// where the reveal has got to is read again at fire time rather than
					// captured, so that a `skip()` while a timer was in flight cannot be
					// undone by it: a captured step would write a position behind the one the
					// skip reached, and the text would come back off the screen
					const from = state.revealed.get();
					const index = steps.findIndex((step) => step.end > from);
					if (index < 0) {
						return;
					}
					state.revealed.set(steps[index]!.end);
					schedule();
				},
				hold(next - 1)
			);
			// a typewriter is not a reason to stay alive
			timer.unref?.();
		};

		// untracked, for the same reason the position above is read untracked: this
		// call happens inside the effect body, so a tracked `revealed` here would
		// make every step re-run the effect and re-chunk the whole string
		untrack(schedule);
		onCleanup(() => clearTimeout(timer));
	});
}

/**
 * What a typewriter takes.
 *
 * `animate` is not among them, and that is the one option a caller must not have:
 * whether the reveal is gradual is settled by the terminal and the motion
 * preference, which the mount answers, and an option would be a way to ask for
 * one frame per keystroke in a CI log.
 */
export interface TypewriterOptions extends MountOptions, Omit<TypewriterRevealOptions, 'animate'> {
	/** What to draw at the write head. Nothing by default. */
	cursor?: string;
	/** What to type. */
	text?: string;
}

export interface Typewriter {
	/** Types more on the end, continuing from where the reveal had got to. */
	append(more: string): void;
	/** Reveals the rest, leaves the text behind, and gives the screen back. */
	done(final?: string): void;
	/** What is on screen. */
	readonly revealed: string;
	/** Whether there is more to reveal. */
	readonly revealing: boolean;
	/** Reveals the rest at once, and keeps going. */
	skip(): void;
	/** Starts typing, optionally replacing the text first. */
	start(text?: string): Typewriter;
	/** Stops and erases, leaving nothing behind. */
	stop(): void;
	/** What is being typed. Assigning keeps whatever prefix still holds. */
	text: string;
	/** Writes a line that stays, above the typewriter. */
	write(text: string): void;
}

/**
 * A typewriter, for text that should arrive rather than appear.
 *
 * Where there is no terminal -- and under a reduced-motion opt-out, which is the
 * same question asked of a screen that exists -- the whole text is emitted at
 * once rather than one frame per character, so a CI log gets the line it would
 * have got anyway rather than one line per keystroke.
 *
 * Nothing is mounted until it is started, for the reason a spinner is not: a
 * renderer paints its first frame as it is built, so mounting eagerly would put
 * text on screen that nobody asked to be typed.
 *
 * @param opts - What to type, how to cut it, and how fast.
 * @returns The typewriter, not yet started.
 */
export function createTypewriter(opts: TypewriterOptions = {}): Typewriter {
	const state = typewriterState(opts.text ?? '');
	const terminal = opts.terminal ?? defaultTerminal;
	const running = new State(false);

	let mounted: Mounted | undefined;

	function mount(): Mounted {
		mounted ??= mountLive(
			(live, motion) => {
				const moving = live && motion !== 'reduce';
				typewriterReveal(state, {
					...opts,
					// gated on `running` as well, which is what makes `done()` finish the
					// reveal rather than needing to write the position itself -- and what
					// makes a typewriter mounted by a `done()` it never started leave its
					// text rather than type it out to nobody
					animate: () => moving && running.get(),
				});
				return typewriterView(state, { cursor: opts.cursor });
			},
			{ ...opts, terminal }
		);
		return mounted;
	}

	const typewriter: Typewriter = {
		append(more: string): void {
			// nothing is done about an append of nothing, and nothing has to be: the
			// text is the same string, so the signal refuses the write and the frame
			// after it finds nothing to draw. A guard here failed its sabotage
			state.text.set(state.text.get() + more);
			mounted?.frame();
		},

		done(final?: string): void {
			if (final !== undefined) {
				state.text.set(final);
			}
			// turning it off is what reveals the rest, through the one path that
			// does: writing the position here as well would be a second answer to
			// "how does a reveal finish", and the two would come to disagree
			running.set(false);

			// mounted even if it never ran, which is what a `done()` on a typewriter
			// nobody started means: the text is what it had to say
			const it = mount();
			it.frame();
			it.done();
			mounted = undefined;
		},

		get revealed() {
			const value = state.text.get();
			return value.slice(0, Math.max(0, Math.min(value.length, state.revealed.get())));
		},

		get revealing() {
			return running.get() && state.revealed.get() < state.text.get().length;
		},

		skip(): void {
			state.revealed.set(state.text.get().length);
			mounted?.frame();
		},

		start(next?: string): Typewriter {
			if (next !== undefined) {
				state.text.set(next);
			}
			// no guard against starting twice, for the reason `append()` has none: the
			// signal refuses an equal write, so the reveal is not rescheduled and the
			// frame after it has nothing to draw
			running.set(true);
			mount().frame();
			return typewriter;
		},

		stop(): void {
			running.set(false);
			mounted?.stop();
			mounted = undefined;
		},

		get text() {
			return state.text.get();
		},

		set text(next: string) {
			state.text.set(next);
			mounted?.frame();
		},

		write(line: string): void {
			if (mounted) {
				mounted.write(line);
				return;
			}
			// nothing has claimed the screen, so there is nothing to write above
			terminal.write(line.endsWith('\n') ? line : `${line}\n`);
		},
	};

	return typewriter;
}
