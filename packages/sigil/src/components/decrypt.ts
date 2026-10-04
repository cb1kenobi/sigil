/**
 * A decrypt effect: text that arrives unreadable and resolves into itself.
 *
 * The Sneakers/CSI effect, as in `bartobri/no-more-secrets`. Every non-whitespace
 * cell becomes a random glyph, the whole thing jumbles for a couple of seconds,
 * and then each cell resolves at a random moment spread over the next few --
 * three phases, and the middle one is what makes the last one read as decryption
 * rather than as typing.
 *
 * **Whitespace is never masked, and that is the detail the effect rests on.** The
 * spaces, the indentation and the line breaks stay exactly where they are, so the
 * *shape* of the text is legible from the first frame while not one word of it is.
 * Masking them instead gives a solid rectangle of noise, which is a screensaver.
 *
 * It is a component rather than a canvas frame effect, which is the one design
 * question worth stating. The general version -- snapshot what was painted, paint
 * something derived from it, ramp a mask over it -- needs transparency and
 * compositing and is deliberately v2. This needs neither, because nothing is ever
 * read back off a grid: the component holds the true text, so a frame is a
 * function of the text, each cell's reveal time, and how far through it is.
 *
 * It is a component rather than a keyframe animation for the reason the spinner
 * and the typewriter are: what it animates is *content*, and there is no
 * animatable content property.
 */

// the barrels rather than the modules behind them, which is not a style preference:
// `sigil add` rewrites a component's relative imports to the published subpath that
// answers for each, and neither `src/ansi/strip.ts` nor `src/canvas/buffer.ts` is
// published -- so the generator refuses the entry outright rather than shipping one
// that cannot resolve once it is in somebody's app
import { strip } from '../ansi/index.js';
import { cellWidth } from '../canvas/index.js';
import { box, type Element, text as textNode } from '../element/index.js';
import { createEffect, onCleanup } from '../renderer/index.js';
import { State } from '../signals/index.js';
import { terminal as defaultTerminal } from '../terminal/index.js';
import { graphemes } from '../width/index.js';
import { type Mounted, type MountOptions, mountLive } from './mount.js';

/** How long the jumble lasts before anything resolves, in milliseconds. */
const JUMBLE = 2000;

/** How long the resolutions are spread over after it, in milliseconds. */
const REVEAL = 5000;

/** How often a hidden cell draws a new glyph while jumbling, in milliseconds. */
const JUMBLE_TICK = 35;

/** And once cells are resolving, which nms slows down for the same reason. */
const REVEAL_TICK = 50;

/**
 * A source of randomness, in `[0, 1)`.
 *
 * Injectable because every visible property of this component comes out of it:
 * which glyph hides a cell and when each cell resolves. Without a seed there is
 * nothing to assert, and "run it and look" is not a test.
 *
 * Whatever it answers is read as a fraction: a value outside the range, a `NaN`
 * or an infinity is clamped rather than trusted, because a reveal time past the
 * window is an animation that never finishes and `await decrypt(text)` would
 * simply never resolve.
 */
export type Random = () => number;

/**
 * The glyphs a hidden cell can show, in the two widths a cell grid has.
 *
 * Two lists rather than one because **a substitute has to be as wide as what it
 * hides**. A one-column glyph over a two-column CJK character leaves a hole and
 * shifts every cell to its right for the whole animation, so the text visibly
 * reflows as it decrypts and lands back where it started -- which is the one
 * thing nms gets to take for granted, because it masks a terminal that has
 * already laid the text out. The rule is `CellBuffer.fill()`'s, which steps by
 * what its cluster consumes rather than by one column a time, read one layer up.
 *
 * An entry of `wide` is two columns and need not be one cluster, which is what
 * lets an ASCII-only set cover a wide character at all: there is no printable
 * ASCII character two columns wide, so `ASCII` pairs them. The default set has
 * real two-column glyphs and uses them, because one glyph per cell reads as one
 * character being hidden where two read as two.
 */
export interface MaskAlphabet {
	/** Glyphs that occupy one column. */
	readonly narrow: readonly string[];
	/** Strings that occupy two. One wide glyph, or two narrow ones. */
	readonly wide: readonly string[];
}

/**
 * The default glyphs: CP437's graphic characters, which is what nms masks with.
 *
 * The box drawing, the blocks, the Greek, the mathematical operators and the
 * handful of ASCII punctuation marks CP437 shares with everything else -- dense,
 * unreadable, and in every font a terminal is likely to have.
 *
 * The wide half is the fullwidth Latin forms, which is the same answer the narrow
 * half gives in the width a wide cell needs: a character per cell, and present
 * wherever the CJK characters it is hiding are.
 *
 * No count is written down here, because a count in a comment is a number that goes
 * stale the first time somebody adds a glyph -- this one said ninety-two of what
 * were already ninety-five. What is asserted instead is the property: every entry
 * is the width its half promises, and no entry is repeated.
 */
export const CP437: MaskAlphabet = {
	narrow: [
		...'░▒▓│┤╡╢╖╕╣║╗╝╜╛┐└┴┬├─┼╞╟╚╔╩╦╠═╬╧╨╤╥╙╘╒╓╫╪┘┌█▄▌▐▀',
		...'αßΓπΣσµτΦΘΩδ∞φε∩≡±≥≤⌠⌡÷≈°∙·√ⁿ²■',
		...'!#$%&*+/<=>?@\\^~',
	],
	wide: [
		...'！＃＄％＆＊＋／＜＝＞？＠＼＾～０１２３４５６７８９ＡＢＣＤＥＦＧＨＩＪＫＬＭＮＯＰＱＲＳＴＵＶＷＸＹＺ',
	],
};

/**
 * Glyphs for a terminal that cannot be trusted with anything but ASCII.
 *
 * `DOTS` and `LINE` are the precedent: a default set that looks right, and one
 * that is certain to render. Its wide entries are pairs, for the reason
 * `MaskAlphabet` gives -- no printable ASCII character is two columns.
 */
export const ASCII: MaskAlphabet = {
	narrow: [...'!#$%&*+-/0123456789:;<=>?@ABCDEFGHIJKLMNOPQRSTUVWXYZ[\\]^_{|}~'],
	wide: ['##', '%%', '&&', '**', '++', '//', '<>', '==', '?@', '[]', '{}', '~~', '$$', '@@', '&%'],
};

/**
 * A seeded generator, so that a run reproduces.
 *
 * xorshift32, which is the generator the layout fuzzer already uses -- one
 * algorithm in this repository rather than two. It is shipped because a component
 * whose documentation says the randomness is injectable should carry the thing to
 * inject: a demo that reproduces and a test that asserts both want one, and
 * reaching for a package would break the rule that this runtime has no
 * dependencies.
 *
 * @param seed - Any integer. Zero is read as a fixed non-zero seed, because
 *   xorshift32 has no way out of it.
 * @returns The generator.
 */
export function seeded(seed: number): Random {
	let state = seed >>> 0 || 0x9e37_79b9;
	return () => {
		state ^= state << 13;
		state >>>= 0;
		state ^= state >>> 17;
		state ^= state << 5;
		state >>>= 0;
		return state / 0x1_0000_0000;
	};
}

/**
 * A fraction, whatever the source answered.
 *
 * The clamp is the whole of what makes the component safe to hand somebody
 * else's generator, and it is load bearing in both directions: a value above one
 * puts a cell's reveal time past the end of the window, so `await decrypt(text)`
 * never resolves, and a negative one resolves a cell during the jumble, which is
 * the one invariant the effect has. `NaN` is read as zero rather than propagated,
 * because every comparison against it is false -- so a cell whose reveal time was
 * `NaN` would be both never resolved and never past its time.
 *
 * One inclusive of its top end, which `pick()` is written to take: a reveal time
 * of exactly the window end resolves at the window end, where a fraction forced
 * just under it would leave the last cell resolving a tick early for no reason
 * anybody could see.
 *
 * @param random - The source.
 * @returns A number in `[0, 1]`.
 */
function unit(random: Random): number {
	const value = random();
	return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0;
}

/**
 * One of a list, by a fraction that may be exactly one.
 *
 * @param list - What to choose from. Must not be empty.
 * @param fraction - A number in `[0, 1]`.
 * @returns The entry.
 */
function pick<T>(list: readonly T[], fraction: number): T {
	return list[Math.min(list.length - 1, Math.floor(fraction * list.length))] as T;
}

/**
 * A duration in milliseconds, or the default for anything that is not one.
 *
 * `Number.isFinite` rather than a bare comparison, for the reason the
 * typewriter's interval records: `Infinity >= 0` is true, and an infinite jumble
 * is an animation that asks for "never" -- which here is worse than a wrong
 * delay, because it is a promise nothing will ever settle. A negative value falls
 * back the same way rather than clamping to zero, which is what that option
 * already does: somebody who wants it instant writes `0`, and a negative number
 * is a mistake rather than a request.
 *
 * @param value - What the caller said.
 * @param fallback - What to use instead.
 * @returns The duration.
 */
function ms(value: number | undefined, fallback: number): number {
	return value !== undefined && Number.isFinite(value) && value >= 0 ? value : fallback;
}

/** One cell of the text: what it really is, and when it stops hiding. */
export interface DecryptCell {
	/** The real grapheme cluster. */
	readonly cluster: string;
	/** Whether anything hides it at all. */
	readonly hidden: boolean;
	/** When it resolves, in milliseconds from the start. Zero when nothing hides it. */
	readonly reveal: number;
	/** How many columns it occupies: one, or two. */
	readonly width: number;
}

/** The schedule a frame is read off: the cells, and when the last one resolves. */
export interface DecryptPlan {
	/** When everything has resolved, in milliseconds. Zero when nothing is hidden. */
	readonly duration: number;
	/** The cells, one list per line. */
	readonly lines: readonly (readonly DecryptCell[])[];
	/** The text the plan is of, with any escape sequences taken out. */
	readonly text: string;
}

/** How long each phase lasts, and where the randomness comes from. */
export interface DecryptPlanOptions {
	/** How long the jumble lasts before anything resolves. Defaults to 2000ms. */
	jumble?: number;
	/** Randomness in `[0, 1)`. Defaults to `Math.random`. */
	random?: Random;
	/** How long the resolutions are spread over. Defaults to 5000ms. */
	reveal?: number;
}

/**
 * Whether a cluster is whitespace, and therefore never hidden.
 *
 * Asked of the whole cluster rather than of its first character, so that a space
 * carrying a combining mark is not read as a space. `\s` and not a list of the
 * ones a terminal is likely to see: a non-breaking space and an ideographic space
 * hold a line's shape exactly as an ordinary one does.
 *
 * `+` rather than `*` is not a guard and does not read as one: the only caller
 * asks this after `width > 0`, and no cluster of positive width is the empty
 * string, so the two spell the same predicate here. It is `+` because that is
 * what "is whitespace" means, and it survived its sabotage for exactly that
 * reason rather than for want of a test.
 */
const WHITESPACE = /^\s+$/u;

/**
 * The schedule for a text: which cells hide, and when each stops.
 *
 * **Escape sequences are taken out, and that is the styled-input decision.** An
 * element's text cannot carry them: `toDisplayText()` removes the `ESC` and
 * leaves the rest printable, so `ESC[31mred` is drawn as `[31mred` -- measured,
 * not assumed. Re-emitting the state per frame therefore puts the parameters of
 * every sequence on screen as text rather than putting colour on anything. See
 * the module's entry in AGENTS.md for what the alternative would have cost.
 *
 * Nothing else is sanitized here, so the text a finished animation leaves behind
 * is the text it was given: a tab, a stray control character and a lone surrogate
 * are the element's to draw, exactly as they are for every other component.
 *
 * A cell is hidden unless it is whitespace or occupies no column at all. The
 * second half is the width rule taken to its end: a combining mark on its own has
 * no cell of its own, so a one-column glyph over it would *add* a column, which
 * is the reflow the rule exists to prevent.
 *
 * @param text - What to decrypt.
 * @param opts - The durations and the randomness.
 * @returns The plan.
 */
export function decryptPlan(text: string, opts: DecryptPlanOptions = {}): DecryptPlan {
	const clean = strip(text);
	const random = opts.random ?? Math.random;
	const jumble = ms(opts.jumble, JUMBLE);
	const spread = ms(opts.reveal, REVEAL);
	const lines: DecryptCell[][] = [];
	let duration = 0;

	for (const line of clean.split('\n')) {
		const cells: DecryptCell[] = [];

		for (const cluster of graphemes(line)) {
			const width = cellWidth(cluster);
			const hidden = width > 0 && !WHITESPACE.test(cluster);
			// drawn only for a cell that hides, so that the stream a seed produces
			// does not shift when the whitespace in a text does -- and so that a
			// text with nothing to hide consumes nothing at all
			const reveal = hidden ? jumble + unit(random) * spread : 0;

			cells.push({ cluster, hidden, reveal, width });
			duration = Math.max(duration, reveal);
		}

		lines.push(cells);
	}

	return { duration, lines, text: clean };
}

/** What is on screen, and whether any of it is still hidden. */
export interface DecryptFrame {
	/** Whether any cell is still showing a glyph that is not its own. */
	readonly masked: boolean;
	/** What to draw, newlines and all. */
	readonly text: string;
}

/**
 * The frame a plan shows at a moment, with each hidden cell freshly disguised.
 *
 * A new glyph is drawn per hidden cell per call, which is what makes the jumble
 * move: the caller decides how often to ask, and nms's two speeds -- fast while
 * nothing is resolving, slower once things are -- are two intervals rather than
 * two mechanisms.
 *
 * @param plan - The schedule.
 * @param at - How far through, in milliseconds.
 * @param alphabet - The glyphs to hide with. `CP437` by default.
 * @param random - Randomness in `[0, 1)`. Defaults to `Math.random`.
 * @returns The frame.
 */
export function decryptFrameAt(
	plan: DecryptPlan,
	at: number,
	alphabet: MaskAlphabet = CP437,
	random: Random = Math.random
): DecryptFrame {
	// an empty list would make `pick()` answer `undefined`, which reaches the
	// screen as the word rather than as a glyph. Falling back to the default is
	// the only answer that still draws the effect, and it is per half: a caller
	// with narrow glyphs and no wide ones gets the default's wide ones
	const narrow = alphabet.narrow.length > 0 ? alphabet.narrow : CP437.narrow;
	const wide = alphabet.wide.length > 0 ? alphabet.wide : CP437.wide;
	const lines: string[] = [];
	let masked = false;

	for (const cells of plan.lines) {
		let line = '';

		for (const cell of cells) {
			if (!cell.hidden || at >= cell.reveal) {
				line += cell.cluster;
				continue;
			}
			masked = true;
			line += cell.width === 2 ? pick(wide, unit(random)) : pick(narrow, unit(random));
		}

		lines.push(line);
	}

	return { masked, text: lines.join('\n') };
}

/** What a decrypt's tree is driven by, and what the driver writes to. */
export interface DecryptState {
	/**
	 * The frame on screen.
	 *
	 * One signal holding both halves rather than two beside each other, because
	 * "what is drawn" and "is any of it still hidden" are one answer: the second
	 * is read off the first while it is being built, and two signals written
	 * together are two things that can come to disagree about the same frame.
	 */
	readonly frame: State<DecryptFrame>;
	/** The real text. */
	readonly text: State<string>;
}

/**
 * Builds the state a decrypt's tree reads.
 *
 * @param text - What to decrypt.
 * @returns The signals.
 */
export function decryptState(text = ''): DecryptState {
	return {
		// nothing rather than the text, which is `typewriterState()`'s own `revealed:
		// 0` and is the safer of the two by exactly the thing this component is for: a
		// state whose first frame is the plaintext is one that leaks it to anything
		// that draws before the driver has run. Nothing can observe the blank through
		// `createDecrypt()`, because the driver's effect runs as the tree is built and
		// has already written a frame by the time the view's effect reads one -- so
		// this is about an app that builds its own tree and wires the two up in the
		// other order
		frame: new State<DecryptFrame>({ masked: false, text: '' }),
		text: new State(text),
	};
}

/**
 * The decrypt effect, as an element tree.
 *
 * **One `text` element, holding the newlines.** That is the typewriter's decision
 * and it is taken here for its reasons and one of its own. A text wraps at the
 * width it is given and keeps the breaks the author wrote, so a block of lines
 * lays itself out; and the alternative -- an element per line, or per run of
 * same-state cells so that resolved characters could take a colour of their own
 * -- cannot work, because three texts in a row are three flex items placed beside
 * each other's *boxes*, so a run that wraps leaves the next one beside its first
 * row. What colour there is is therefore the whole block's, and `is-masked` is
 * what a sheet reaches it by.
 *
 * `min-width: 0` rather than the automatic minimum, which for a text is its
 * longest word: the canvas is capped at the terminal either way, so without it a
 * word longer than the terminal keeps its width and is cut off at the canvas edge
 * rather than broken. That is the rule `paragraph()` gives its own words, and a
 * text that disagreed with `wrap()` about an over-long word is a frame wider than
 * the terminal it was asked to fit.
 *
 * @param state - What it reads.
 * @returns The tree.
 */
export function decryptView(state: DecryptState): Element {
	const body = textNode('', { class: 'sigil-decrypt-text', 'min-width': 0 });

	createEffect(() => {
		const frame = state.frame.get();
		body.setText(frame.text);
		// the class list is diffed by the element, so this is a write per
		// transition rather than one per tick
		body.setProps({
			class: frame.masked ? 'sigil-decrypt-text is-masked' : 'sigil-decrypt-text',
		});
	});

	return box({ class: 'sigil-decrypt' }, body);
}

export interface DecryptRevealOptions extends DecryptPlanOptions {
	/**
	 * The glyphs to hide a cell with. `CP437` by default.
	 */
	alphabet?: MaskAlphabet;
	/**
	 * Whether the effect runs, or the text simply appears.
	 *
	 * False for a pipe, a file, a CI log and a reduced-motion opt-out, which is
	 * one question rather than four: `mountLive()` hands the build what the
	 * renderer resolved, and the renderer's own answer already folds a missing
	 * terminal in. A build log gets the line it would have got anyway.
	 *
	 * A function rather than a boolean because it is also what says the animation
	 * is *running*: turning it off is how `stop()` snaps to the finished text,
	 * through the one path that finishes rather than through a second mechanism
	 * beside it.
	 */
	animate: () => boolean;
	/**
	 * Whether the driving timer keeps the process alive. False by default.
	 *
	 * The timer is unref'd otherwise, which is the spinner's rule and is right for
	 * a component driving its own tree: that app stays alive on its own -- stdin,
	 * its own frame loop -- and a decrypt somebody forgot to stop must not be what
	 * holds a finished program open.
	 *
	 * It is wrong for an **awaited** run, and that is the one case this exists for.
	 * `await decrypt(text)` is the headline API, so the caller is waiting and the
	 * program has *not* finished -- with the timer unref'd there is nothing ref'd
	 * left for the loop to do, so node exits before the animation can settle the
	 * promise. Measured: `node demos/components/09-decrypt.js` on a terminal exited
	 * **13** with `Detected unsettled top-level await` at the first `await`, having
	 * drawn nothing, while the identical run piped was fine -- because the piped
	 * path never schedules a timer at all. A no-op ref'd timer beside this one was
	 * the alternative and is worse: it is a second thing to clear on every exit,
	 * and it says "stay alive" in a place that knows nothing about whether there is
	 * animating left to do.
	 *
	 * What it costs is that a run nobody awaits keeps the process alive until it
	 * finishes, which is a bounded couple of seconds rather than a spinner's
	 * forever, and which `stop()` and `cancel()` both end at once.
	 */
	hold?: boolean;
	/** How often a hidden cell redraws while jumbling. Defaults to 35ms. */
	interval?: number;
	/** What time it is. Defaults to `Date.now`. */
	now?: () => number;
	/**
	 * Called when a pass has nothing hidden left, which is **once per pass** rather
	 * than once per component.
	 *
	 * The effect re-runs whenever the text moves, so a text replaced with one that
	 * has nothing to hide calls this again -- measured, three times over three
	 * changes. Making it once is the facade's, because "once" is a fact about a
	 * *run* and only the thing holding the promise knows where a run begins.
	 */
	onDone?: () => void;
	/** How often a hidden cell redraws once cells are resolving. Defaults to 50ms. */
	revealInterval?: number;
}

/**
 * Drives the effect: one timer, rescheduled per tick.
 *
 * Call it inside a component body, beside `decryptView()`. It is the half an app
 * building its own tree would otherwise have to write, and it is where the four
 * rules the frame loop asks for live.
 *
 * **No timer when nothing is hidden.** The frame that resolves the last cell
 * schedules nothing, so a finished decrypt holds no timer and a CLI that prints
 * one line never acquires a frame loop at all. **The timer is unref'd unless
 * `hold` says otherwise**, because a program that has finished should exit even if
 * somebody forgot to stop it -- and because an awaited run is one that has *not*
 * finished, which is the whole of what `hold` is for and is documented there.
 * **The clock is injectable**, unlike the typewriter's: this measures how far
 * through a duration it is rather than only scheduling, which is exactly why the
 * animator has a `now` and the typewriter has none. And **`onDone` fires from the
 * effect body or from the timer**, whichever pass runs out of hidden cells -- once
 * per pass, which the facade in front of this narrows to once per run.
 *
 * @param state - What it writes.
 * @param opts - Whether to animate, how long each phase is, and what to hide with.
 */
export function decryptReveal(state: DecryptState, opts: DecryptRevealOptions): void {
	const alphabet = opts.alphabet ?? CP437;
	const random = opts.random ?? Math.random;
	const now = opts.now ?? Date.now;
	const jumble = ms(opts.jumble, JUMBLE);
	const fast = ms(opts.interval, JUMBLE_TICK);
	const slow = ms(opts.revealInterval, REVEAL_TICK);

	createEffect(() => {
		const value = state.text.get();

		if (!opts.animate()) {
			// `strip()` rather than the caller's string, which is the same reading
			// `decryptPlan()` takes -- one answer to "what does this say", shared by the
			// path that animates and the path that does not. Asked before the plan is
			// built rather than after, so a pipe neither draws from the generator nor
			// builds a cell per character of a text it is about to print in one go
			state.frame.set({ masked: false, text: strip(value) });
			opts.onDone?.();
			return;
		}

		const plan = decryptPlan(value, { ...opts, random });
		const start = now();
		let timer: ReturnType<typeof setTimeout> | undefined;

		const step = (): void => {
			const at = now() - start;
			const frame = decryptFrameAt(plan, at, alphabet, random);
			state.frame.set(frame);

			if (!frame.masked) {
				// nothing left to hide, so nothing is scheduled: this is both how the
				// animation ends and why a text with no hidden cell in it -- empty,
				// whitespace, a lone combining mark -- costs no timer at all
				opts.onDone?.();
				return;
			}

			timer = setTimeout(step, at < jumble ? fast : slow);
			if (!opts.hold) {
				// a decrypt is not a reason to stay alive -- unless somebody is awaiting
				// this one, which is what `hold` says and why it is the facade that sets it
				timer.unref?.();
			}
		};

		// the first frame now rather than one tick from now: a decrypt that showed
		// the real text for one frame before hiding it has given the answer away
		step();
		onCleanup(() => clearTimeout(timer));
	});
}

/**
 * What a decrypt takes.
 *
 * `animate` is not among them, and that is the one option a caller must not have:
 * whether the effect runs is settled by the terminal and the motion preference,
 * which the mount answers, and an option would be a way to ask for two hundred
 * frames of noise in a CI log.
 */
export interface DecryptOptions
	extends MountOptions, Omit<DecryptRevealOptions, 'animate' | 'onDone'> {
	/**
	 * Aborts the animation, which erases and resolves.
	 *
	 * A signal rather than only a method because the thing that aborts a decrypt
	 * is usually somewhere else -- a key handler, a shutdown path -- and an
	 * already-aborted one is handled too, so a caller does not have to check.
	 * The listener is removed when the animation ends however it ended, which is
	 * the rule every other listener in this library keeps: put back what you
	 * attached.
	 */
	signal?: AbortSignal;
	/** What to decrypt. */
	text?: string;
}

export interface Decrypt {
	/**
	 * Erases what was drawn, leaves nothing behind, and resolves.
	 *
	 * What `stop()` is on a spinner and a typewriter. It is spelled differently
	 * here because this animation is *finite*: "stop" is what somebody says when
	 * they want it over with rather than gone, and what they wanted was the text.
	 */
	cancel(): void;
	/** Whether anything is still hidden. */
	readonly decrypting: boolean;
	/**
	 * Resolves when the animation is over, however it ended.
	 *
	 * Over rather than *finished*: `cancel()` and an abort resolve it too. A
	 * promise that rejected on an abort would make `await decrypt(text)` a thing
	 * every caller has to wrap, for an outcome nobody considers an error -- and a
	 * rejection out of a command's `run()` is a message and a non-zero exit code,
	 * which a Ctrl-C is not.
	 *
	 * A fresh one per run, so a `start()` after a settled animation is awaitable
	 * again.
	 */
	readonly done: Promise<void>;
	/** Starts, optionally replacing the text first. */
	start(text?: string): Decrypt;
	/** Snaps to the finished text, leaves it behind, and resolves. */
	stop(): void;
	/**
	 * What is being decrypted. Assigning restarts the effect over the new text.
	 *
	 * Which is also what `done` then answers for: a text replaced mid-run is a new
	 * animation, so the promise resolves when *that* one is over -- and a
	 * replacement with nothing to hide resolves it at once, because there is
	 * nothing left to decrypt.
	 */
	text: string;
	/** Writes a line that stays, above the frame. */
	write(text: string): void;
}

/**
 * A decrypt effect, for text that should arrive unreadable.
 *
 * Where there is no terminal -- and under a reduced-motion opt-out, which is the
 * same question asked of a screen that exists -- the text is written once and the
 * promise resolves, because there is nothing to animate and a CI log full of noise
 * is worse than no effect at all. That is the live region's own rule, reached
 * through the canvas rather than through a second code path, and it is the same
 * paragraph `createSpinner()` carries.
 *
 * Nothing is mounted until it is started, for the reason a spinner is not: a
 * renderer paints its first frame as it is built, so mounting eagerly would put
 * noise on screen that nobody asked to be decrypted.
 *
 * @param opts - What to decrypt, how long it takes, and what to hide it with.
 * @returns The decrypt, not yet started.
 */
export function createDecrypt(opts: DecryptOptions = {}): Decrypt {
	const state = decryptState(opts.text ?? '');
	const terminal = opts.terminal ?? defaultTerminal;
	const running = new State(false);

	let mounted: Mounted | undefined;
	/** Resolves the current run, or `undefined` once that run has settled. */
	let settle: (() => void) | undefined;
	/** Taken off the caller's signal when the run is over, however it ended. */
	let listening: (() => void) | undefined;
	/**
	 * Which run is current, so that a settled one's teardown stays its own.
	 *
	 * The teardown below is queued on a microtask, and a `start()` in that window
	 * is a second run with its own renderer -- which the first run's teardown would
	 * otherwise dispose, because the only thing it had to go on was whether
	 * anything was mounted and something is. A counter rather than capturing the
	 * mount, because what has to be compared is "is this still the current run"
	 * rather than "is this the same renderer": the two part company the moment a
	 * run is started, torn down and started again inside one tick.
	 */
	let run = 0;

	/**
	 * Leaves the last frame where it was drawn and gives the screen back.
	 *
	 * On the microtask after the run settled rather than inside it, because the
	 * animation finishes from inside the effect that is drawing it -- the timer's
	 * own `step()`, or the effect body for a text with nothing to hide -- and
	 * disposing a renderer from inside its own frame is not a thing to do. What
	 * the caller sees is still ordered, because `done` is this promise: by the
	 * time `await decrypt(text)` returns, the screen has been given back and an
	 * ordinary `console.log()` lands below the frame rather than inside it.
	 *
	 * Idempotent through `mounted`, which is what lets `stop()` and `cancel()` do
	 * the screen themselves and stay synchronous -- a caller writing a line
	 * straight after either of those must not race a teardown.
	 *
	 * It deliberately does **not** turn `running` off, and a `running.set(false)`
	 * here was written and deleted again for failing its sabotage. `stop()` and
	 * `cancel()` each do it themselves -- which is load bearing there, because a
	 * `stop()` after the animation finished mounts a fresh renderer whose effect
	 * would read it as still animating and mask the text all over again -- so the
	 * only path through here is a run that finished, where nothing reads it: the
	 * frame says nothing is hidden, so `decrypting` is already false, and the next
	 * `start()` sets it on and builds a renderer of its own.
	 */
	function leave(): void {
		const it = mounted;
		if (it === undefined) {
			return;
		}
		mounted = undefined;
		// painted before the screen is given back, because `done()` leaves what is
		// on screen where it is and what is on screen is still the frame before this
		it.frame();
		it.done();
	}

	/**
	 * A promise for one run, with the screen given back before it resolves.
	 *
	 * Chained rather than resolved after a `queueMicrotask(leave)`, because the two
	 * differ in where a failure goes: a throw out of the renderer's own disposal is
	 * a rejection here, which whoever awaited `done` sees, and would be an uncaught
	 * exception out of a bare microtask -- which is the one thing a CLI must not do.
	 *
	 * @returns The promise, with `settle` armed to resolve it.
	 */
	function begin(): Promise<void> {
		const mine = ++run;
		return new Promise<void>((resolve) => {
			settle = resolve;
		}).then(() => {
			if (mine === run) {
				leave();
			}
		});
	}

	let done = begin();

	/** Settles the run, once, and detaches whatever it attached. */
	function finish(): void {
		if (settle === undefined) {
			return;
		}
		listening?.();
		listening = undefined;
		const resolve = settle;
		settle = undefined;
		resolve();
	}

	function mount(): Mounted {
		mounted ??= mountLive(
			(live, motion) => {
				const moving = live && motion !== 'reduce';
				decryptReveal(state, {
					...opts,
					// gated on `running` as well, which is what makes `stop()` snap to the
					// finished text rather than needing to write the frame itself -- and
					// what makes a decrypt stopped before it ever started leave its text
					animate: () => moving && running.get(),
					// this facade is the one that hands back a promise, so its timer is
					// what has to keep the loop alive long enough to settle it
					hold: true,
					onDone: finish,
				});
				return decryptView(state);
			},
			{ ...opts, terminal }
		);
		return mounted;
	}

	const decrypt: Decrypt = {
		cancel(): void {
			// off before the mount is dropped, which is what keeps a `stop()` after
			// this from reading it as still animating
			running.set(false);
			// the screen before the settle reads as the thing that matters and is not:
			// a promise resolves on a later turn, so the caller cannot run until this
			// method has returned and both orders look the same from outside. What is
			// load bearing is that the erase happens here at all rather than being
			// left to the teardown the settle queues, which is a microtask away
			mounted?.stop();
			mounted = undefined;
			finish();
		},

		get decrypting() {
			return running.get() && state.frame.get().masked;
		},

		get done() {
			return done;
		},

		start(next?: string): Decrypt {
			if (settle === undefined) {
				// the run that settled gives its screen back here rather than on the
				// microtask it queued, because `mount()` below reuses whatever is
				// mounted: a second run over the first one's renderer finds an effect
				// that is not dirty, so nothing animates and nothing ever resolves.
				// Measured as a hang rather than reasoned about.
				//
				// Before the new text is written rather than after, which is the other
				// half of the same ordering: leaving a frame re-runs the effect, so a
				// text set first was the text the *previous* run left behind -- two
				// lines in the log both saying what the second one says
				leave();
				done = begin();
			}
			if (next !== undefined) {
				state.text.set(next);
			}

			const signal = opts.signal;
			if (signal !== undefined && listening === undefined) {
				if (signal.aborted) {
					// nothing is mounted, so nothing is drawn and nothing has to be
					// erased: a decrypt aborted before it began is one that never
					// claimed the screen, and `done` still answers
					decrypt.cancel();
					return decrypt;
				}
				const abort = (): void => decrypt.cancel();
				signal.addEventListener('abort', abort, { once: true });
				listening = () => signal.removeEventListener('abort', abort);
			}

			// no guard against starting twice, for the reason the typewriter has
			// none: the signal refuses an equal write, so the effect is not re-run
			// and the frame after it has nothing new to draw
			running.set(true);
			mount().frame();
			return decrypt;
		},

		stop(): void {
			// turning it off is what snaps to the finished text, through the one path
			// that does: writing the frame here as well would be a second answer to
			// "how does a decrypt finish", and the two would come to disagree
			running.set(false);

			// mounted even if it never ran, which is what a `stop()` on a decrypt
			// nobody started means: the text is what it had to say
			const it = mount();
			it.frame();
			it.done();
			mounted = undefined;
			// after the screen for the reason `cancel()` records, which is that the
			// order is not what matters: the settle is what makes `done` resolve, and
			// the teardown it queues then finds nothing mounted
			finish();
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

	return decrypt;
}

/**
 * Decrypts a text and resolves when it is over.
 *
 * The whole of the API for the ordinary case, which is one animation a caller
 * waits for:
 *
 * ```js
 * await decrypt('the launch codes are 0000');
 * ```
 *
 * @param text - What to decrypt.
 * @param opts - How long it takes, and what to hide it with.
 * @returns Over.
 */
export function decrypt(text: string, opts: DecryptOptions = {}): Promise<void> {
	return createDecrypt({ ...opts, text }).start().done;
}
