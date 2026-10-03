/**
 * The renderer: components, effects, and the frame loop.
 *
 * Where the signals, the element tree, the cascade, the layout engine and the
 * canvas are finally one thing. A component is a function of props that builds
 * elements; its body runs **once**; and the reactive parts of what it built are
 * effects that write to nodes in place. There is no virtual tree, no diff and no
 * reconciler -- a signal change runs the one effect that reads it and touches
 * the one node it wrote, and the frame that follows restyles, lays out and
 * paints whatever that disturbed.
 *
 * ```js
 * import { box, text } from '@ttylabs/sigil/element';
 * import { createEffect, render } from '@ttylabs/sigil/renderer';
 * import { State } from '@ttylabs/sigil/signals';
 *
 * const count = new State(0);
 * const view = render(() => {
 *   const label = text('');
 *   createEffect(() => label.setText(`count: ${count.get()}`));
 *   return box({ padding: '1' }, label);
 * });
 *
 * count.set(1); // marks the effect stale, which asks for a frame
 * ```
 *
 * **Nothing dirty means no frame, and no frame means no timer.** A CLI that
 * prints one line never starts a loop: the scheduler is asked for a frame by a
 * signal write or a tree mutation, it sets one timer, and a frame that finds
 * nothing to do sets no other. Frame pacing matters more here than on the web --
 * a terminal over ssh cannot absorb 60fps and a fast local one does not need it
 * -- so frames coalesce to `frameMs`, thirty a second by default.
 */

import { type ColorLevel, supportsColor } from '../ansi/index.js';
import {
	type CanvasBackend,
	createInlineCanvas,
	paintSelection,
	type Selection,
	selectionText,
} from '../canvas/index.js';
import {
	arrange,
	arrangedExtent,
	createTree,
	type Element,
	paint,
	selectableAt,
	settleResized,
	settleStyles,
	type Tree,
} from '../element/index.js';
import { errorHandler as defaultErrorHandler } from '../error-handler.js';
// `capabilities.js` rather than `input/index.js`, and the difference is the whole
// startup argument: that module's only runtime import is the `ESC` byte, while the
// router would drag the focus ring and the key decoder into every renderer bundle
import {
	type Capabilities,
	detectCapabilities,
	type DetectOptions,
	readCapabilities,
} from '../input/capabilities.js';
import type { InputRouter } from '../input/index.js';
import { measureNode } from '../layout/index.js';
import { createEffects, type Effects } from '../signals/index.js';
import {
	Animator,
	Cascade,
	type ColorScheme,
	forcedMotion,
	forcedScheme,
	type ReducedMotion,
	Restyler,
	schemeFromTerminalEnv,
} from '../style/index.js';
import { type Terminal, terminal as defaultTerminal } from '../terminal/index.js';
import { createRoot, disposeOwner, drainMounts, getOwner, type Owner } from './owner.js';

export { For, type ForProps, Show, type ShowProps } from './control.js';
export {
	type BlockModifier,
	enableSelection,
	type SelectionHandle,
	type SelectionOptions,
} from './selection.js';
export {
	type Cleanup,
	type Context,
	createBranch,
	createContext,
	createEffect,
	createRoot,
	type EffectFactory,
	getOwner,
	onCleanup,
	onMount,
	type Owner,
	provideContext,
	runWithOwner,
	useContext,
} from './owner.js';

/** A component: a function of props that builds one element. */
export type Component<P = Record<string, never>> = (props: P) => Element;

/**
 * How long a frame waits for the next one, in milliseconds.
 *
 * Thirty a second. Sixty is what a browser paces to, and a terminal is not a
 * browser: every frame is bytes down a pipe that may be a network, and the
 * things a TUI animates -- a spinner, a progress bar, a clock -- quantize to
 * something slower than this anyway.
 */
const FRAME_MS = 1000 / 30;

export interface RenderOptions {
	/**
	 * Where frames go. Defaults to an inline canvas that follows its content.
	 *
	 * Which backend is the *app's* decision rather than a component's, for the
	 * reason the canvas layer records at length: something that unilaterally took
	 * the screen in the middle of a build log is the failure that split exists to
	 * prevent. Pass a full-screen one for a dashboard.
	 */
	backend?: CanvasBackend;
	/** The stylesheets. Defaults to none, which is props and inheritance. */
	cascade?: Cascade;
	/**
	 * How much colour to resolve for. Defaults to what the terminal reports.
	 *
	 * The same number `@media (color-level: N)` reads and the depth the cascade
	 * degrades to, because one scale is what keeps an author's override and the
	 * automatic ladder from disagreeing about what `2` means.
	 */
	colorLevel?: ColorLevel;
	/**
	 * Whether the destination has a light background or a dark one.
	 *
	 * The top of four sources, and the order is "more specific knowledge about the
	 * same question": this, then `SIGIL_COLOR_SCHEME`, then a reply to an OSC 11
	 * query where `detect()` was called, then `COLORFGBG`, then dark. Unlike
	 * `colorLevel` a value named here is **not** overruled by a reply, because
	 * nothing fills this in on a caller's behalf -- an app that names one may be
	 * painting its own background, so it is stating a fact about its output rather
	 * than guessing at the terminal.
	 */
	colorScheme?: ColorScheme;
	/**
	 * The effect scope. Defaults to one of this renderer's own.
	 *
	 * Its own rather than the module's, which was the first answer and is a trap:
	 * a scope holds one scheduler and one error handler, so a second `render()`
	 * installed its frame loop over the first's. The first renderer then painted
	 * nothing ever again, an effect that threw in *either* tore down whichever
	 * had installed last -- restoring the terminal out from under the other --
	 * and disposing one put back the handlers it had saved rather than the ones
	 * in place. A `createEffect()` inside a component still reaches this loop,
	 * because it asks the owner it was created under rather than the module.
	 */
	effects?: Effects;
	/** Milliseconds between frames. Defaults to 1000/30. */
	frameMs?: number;
	/**
	 * Where the frame loop reads the time. Defaults to `Date.now`.
	 *
	 * Injectable because an animation test that depends on wall time is flaky
	 * forever, which is the same reason `frameMs` is an option -- and a fake timer
	 * that patches `Date.now` happens to work only for as long as nothing else in
	 * the process wants a real clock. One function, asked by the pacing, by the
	 * transitions and by the frame-skip arithmetic, so none of the three can come
	 * to disagree about what time it is.
	 */
	now?: () => number;
	/**
	 * Whether animations run, or collapse to their end state.
	 *
	 * The top of three sources, and the order is the scheme's: this, then
	 * `SIGIL_REDUCED_MOTION`, then whether there is a terminal to animate on. An
	 * app that names one is stating a fact about its output; the variable is the
	 * user correcting the detection; and a pipe, a file or a CI log has no frames
	 * at all, so an animation there would write a line per tick into something
	 * nobody will watch play.
	 */
	reducedMotion?: ReducedMotion;
	/**
	 * How many rows an inline canvas occupies. Defaults to following the content.
	 *
	 * Ignored when `backend` was passed: how big that is, is its owner's.
	 */
	height?: number;
	/**
	 * How many columns an inline canvas occupies. Defaults to the terminal's.
	 *
	 * `'auto'` follows the content instead, which is what a spinner or a prompt
	 * wants: a canvas paints every cell it owns, so one the width of the screen
	 * ends each row with blanks out to the margin -- invisible on screen, and
	 * trailing whitespace in the scrollback once the frame is left behind.
	 *
	 * The default is the terminal's rather than auto, unlike the height, because
	 * the two costs are not the same. A canvas taller than its content reserves
	 * rows of screen that nothing is using, which is always wrong inline; one as
	 * wide as the screen merely writes blanks, which is what an app drawing a
	 * panel wants. Ignored when `backend` was passed.
	 */
	width?: number | 'auto';
	/** Where a throw from a component, an effect or a frame goes. */
	onError?: (error: unknown) => void;
	/** The terminal. Defaults to the process's. */
	terminal?: Terminal;
}

export interface Renderer {
	/**
	 * Whether anything is mid-transition or mid-animation.
	 *
	 * The one thing the animation machinery exposes, and deliberately the only
	 * thing: there is no `onfinish`. An event needs a target identity, a delivery
	 * point inside the frame -- where a handler writing a signal is the
	 * re-entrancy `runFrame()` already refuses -- and a story for an element
	 * unmounted mid-flight. All three have answers and none of them has a caller
	 * yet, which is the rule `which` waited on. What a caller genuinely cannot
	 * observe any other way is whether the loop will keep going, so that is what
	 * is here.
	 */
	readonly animating: boolean;
	/** Where frames are going. */
	readonly backend: CanvasBackend;
	/**
	 * Asks the terminal what it is, and restyles if the answer moved anything.
	 *
	 * **This is the only thing in the library that probes**, and it is a method on
	 * a mounted renderer rather than a step inside `render()` for the reason
	 * SIG-108 exists: a CLI must not pay a round trip to print one line, so
	 * `main()`, `parse()`, the help screen and `renderToString()` write no query
	 * ever. Environment inference stays the default answer and the synchronous one;
	 * this refines it.
	 *
	 * The first frame does not wait for it. A reply that changes the colour level
	 * is published as a media-context change and the frame loop does with it what
	 * it already does with a resize -- a full re-match, a layout and a repaint --
	 * so this is a signal that settles a frame or two in rather than a startup
	 * phase.
	 *
	 * It takes the router rather than building one, because one thing owns stdin
	 * and which backend and which input an app has are the app's decisions. The
	 * order is `render()`, then `createInput({ root: view.root })`, then this.
	 *
	 * @param input - The router. It reads the reply out of the key stream.
	 * @param opts - Which capabilities to ask for.
	 * @returns What came back, which for a terminal that said nothing is nothing,
	 *   and for a renderer that has already gone is nothing without a query being
	 *   written. A query that could not be *written* propagates, for the reason
	 *   `InputRouter.query()` gives: a broken stream is not a quiet terminal.
	 */
	detect(input: InputRouter, opts?: DetectOptions): Promise<Capabilities>;
	/**
	 * Unmounts everything, disposes every effect, and gives the screen back.
	 *
	 * The last frame stays where it was drawn, which inline means in the log,
	 * with the cursor below it -- so ordinary output after this lands where it
	 * looks like it will.
	 *
	 * To erase it instead, call `backend.stop()` *before* this: finishing the
	 * region is what hands the rows back, and afterwards there is no anchor left
	 * for an erase to be relative to, so a `stop()` on the other side of this
	 * quietly does nothing.
	 */
	dispose(): void;
	/** Settles and paints a frame now, whatever the pacing says. */
	frame(): void;
	/** Asks for a frame, for a mutation a signal did not make. */
	invalidate(): void;
	/** Whether this renderer is still mounted. */
	readonly mounted: boolean;
	/** What the component built. Hand this to `createInput()` for keys and focus. */
	readonly root: Element;
	/**
	 * What holds each element's resolved style.
	 *
	 * Exposed because there is one thing only its owner can do and an app
	 * legitimately needs: `touchSheets()`, for a stylesheet swapped at runtime --
	 * a theme change has no other way to say that every rule is stale.
	 */
	readonly restyler: Restyler;
	/**
	 * What is selected, if anything.
	 *
	 * Two cells and a mode, over the painted grid rather than over the tree --
	 * `canvas/selection.ts` records why. The renderer holds it because it is the
	 * thing that paints, and because a selection that moved has to ask for a frame
	 * the way any other change does.
	 */
	readonly selection: Selection | undefined;
	/**
	 * Selects a region, or clears the selection.
	 *
	 * Asks for a frame, and that frame repaints: the highlight is a style override
	 * recomputed from the live selection every time the tree is drawn, so moving
	 * the selection without a repaint would leave the old one on screen.
	 *
	 * @param next - The selection, or `undefined` for none.
	 */
	setSelection(next: Selection | undefined): void;
	/**
	 * The text the selection covers, read off the frame last painted.
	 *
	 * Laid-out text: a paragraph that wrapped comes back with its wrap points in
	 * it, and a two-column row comes back as both columns per line. That is what
	 * selecting from a terminal has always given you, and the rectangular mode is
	 * the answer where it is not what was wanted. Trailing blanks go per line, and
	 * a cell `selectable` excludes comes back as a blank.
	 *
	 * @returns The text, or `''` with nothing selected.
	 */
	selectionText(): string;
	/** The element tree, for anything that wants the marks. */
	readonly tree: Tree;
}

/**
 * Mounts a component and starts the frame loop.
 *
 * @param component - Builds the root element. Runs once, under a root owner.
 * @param opts - The backend, the sheets, and the pacing.
 * @returns The handle.
 */
export function render(component: () => Element, opts: RenderOptions = {}): Renderer {
	const terminal = opts.terminal ?? defaultTerminal;
	const ownBackend = opts.backend === undefined;
	const backend =
		opts.backend ??
		createInlineCanvas({
			height: Math.max(1, opts.height ?? 1),
			terminal,
			// a width of its own for an auto one, which reads backwards and is the
			// point: a canvas built without one follows the terminal by erasing and
			// resizing *itself* on every resize, and an auto-width canvas is already
			// re-measured and resized by the frame -- so a spinner twelve columns
			// wide blinked off and back on every time the window changed by a column
			// it was not using. The starting number is the screen's and the first
			// frame narrows it. A canvas that is neither is left to follow the
			// terminal, because nothing else here would move it
			width:
				typeof opts.width === 'number'
					? Math.max(1, opts.width)
					: opts.width === 'auto'
						? Math.max(1, terminal.width)
						: undefined,
		});
	/**
	 * An inline canvas of our own, with no height named, follows what it draws.
	 *
	 * One row is the default and is useless for anything but a spinner, and the
	 * height a component comes out as is not a number anybody can supply before
	 * it has been laid out.
	 */
	const autoHeight = ownBackend && opts.height === undefined;
	/** The same for the width, which is opt-in for the reason `width` records. */
	const autoWidth = ownBackend && opts.width === 'auto';
	const frameMs = Math.max(0, opts.frameMs ?? FRAME_MS);
	const clock = opts.now ?? Date.now;
	const scope: Effects = opts.effects ?? createEffects();
	const cascade = opts.cascade ?? new Cascade([]);
	const restyler = new Restyler(cascade);
	const animator = new Animator<Element>(cascade);
	const onError = opts.onError ?? ((error: unknown) => defaultErrorHandler(error));

	/**
	 * What the media queries are asked about: the screen.
	 *
	 * The terminal's size rather than the canvas's, and the difference matters in
	 * exactly one case, which is the one that would otherwise be a loop. An
	 * auto-height canvas is as tall as its content, so resolving
	 * `@media (min-height: 10)` against it would let a style decide a height that
	 * decides that style. A query means "how much screen is there", which has an
	 * answer that nothing in the frame can move.
	 */
	/**
	 * What a capability reply refined, kept so that a resize does not undo it.
	 *
	 * `readMedia()` rebuilds the whole context from scratch on every resize, so a
	 * level the terminal told us about has to live somewhere that survives that --
	 * otherwise the refinement lasts exactly until the window changes by a column.
	 *
	 * It sits *above* `opts.colorLevel` rather than below it, and that took a
	 * second look. A caller that names a level reads like a caller who has decided,
	 * and `mountLive()` shows why it is not: every built-in passes
	 * `opts.colorLevel ?? ansi.level`, which is the environment's own guess wearing
	 * the caller's clothes -- so treating a named level as final would mean no
	 * spinner, prompt or table could ever be refined. What actually needs
	 * protecting is a level of *zero*, which is what `NO_COLOR` and a pipe produce,
	 * and `refineColorLevel()` protects it by refusing to raise off that floor
	 * rather than by anything here.
	 */
	let refined: { colorLevel?: ColorLevel; colorScheme?: ColorScheme } = {};

	/**
	 * The scheme, from the most specific source that has an answer.
	 *
	 * A function rather than an expression inside `readMedia()` because `detect()`
	 * has to ask it twice -- before and after recording a reply -- to know whether
	 * the reply changed anything. Two copies of a five-term chain is two chains to
	 * keep in agreement.
	 */
	function scheme(): ColorScheme {
		return (
			opts.colorScheme ?? forcedScheme() ?? refined.colorScheme ?? schemeFromTerminalEnv() ?? 'dark'
		);
	}

	/**
	 * Whether anything should move.
	 *
	 * The terminal is the last term rather than the first, so a pipe collapses
	 * every animation to its end state without an app having to ask -- which is
	 * the same distinction `mountLive()` already makes for a spinner, generalized
	 * from one component to the cascade. `closed` is in it for the reason it is
	 * there: a terminal whose stream has gone is no more a screen than a pipe is.
	 */
	function motion(): ReducedMotion {
		return (
			opts.reducedMotion ??
			forcedMotion() ??
			(terminal.isTTY && !terminal.closed ? 'no-preference' : 'reduce')
		);
	}

	const readMedia = (): void => {
		cascade.media = {
			colorLevel: refined.colorLevel ?? opts.colorLevel ?? supportsColor(),
			// and the scheme reads the other way round from the level, which is not an
			// inconsistency: `opts.colorLevel` is what `mountLive()` fills with the
			// environment's own guess, so a reply has to be able to beat it, while
			// nothing fills `opts.colorScheme` except an app that means it.
			//
			// Four sources, and the order is "more specific knowledge about the same
			// question" all the way down. An app that names one may be painting its own
			// background, so it is stating a fact about its output rather than guessing
			// at the terminal. `SIGIL_COLOR_SCHEME` is the user correcting the
			// detection, so it beats the detection and not the app. A reply is the
			// terminal itself. And `COLORFGBG` is what some terminal put in the
			// environment once, which under tmux may not even be this one.
			//
			// Reading the two variables through one `schemeFromEnv()` put the reply
			// *above* the user's override for a commit, because the override was inside
			// the call that sat under `refined`
			colorScheme: scheme(),
			height: Math.max(1, terminal.height),
			reducedMotion: motion(),
			width: Math.max(1, terminal.width),
		};
	};
	readMedia();

	let disposed = false;
	let failed = false;
	let scheduled = false;
	let timer: ReturnType<typeof setTimeout> | undefined;
	/** When the pending timer is due, so that an earlier request can replace it. */
	let dueAt = 0;
	let last = 0;
	/** Whether the next frame lays out and paints whatever the marks said. */
	let full = true;
	let owner: Owner | undefined;
	let offResize: (() => void) | undefined;
	/** Whether a frame is settling, which is what makes `frame()` safe to call. */
	let settling = false;
	/** What is selected, which the paint pass draws over whatever it drew. */
	let selected: Selection | undefined;
	/**
	 * Whether the next frame has to paint whatever else it finds to do.
	 *
	 * The selection is not an element and not a style, so nothing in `Marks` or in
	 * the restyler's answer can say it moved -- and `full` is the wrong flag,
	 * because that forces a layout and no box has moved. A selection change is
	 * exactly a repaint.
	 */
	let repaint = false;

	/**
	 * Asks for a frame, no sooner than the pacing allows and no later than `after`.
	 *
	 * `after` is what the animator's frame skip is spent through: a step animation
	 * whose next step is eighty milliseconds away sets one timer for eighty
	 * milliseconds rather than waking three times to find nothing quantized
	 * differently. A request that wants the frame *sooner* than one already
	 * pending replaces it, which is what keeps a keystroke from waiting out an
	 * animation's deadline -- so the scheduled time is tracked rather than only
	 * the fact of a timer.
	 *
	 * @param after - The earliest the frame may run, in milliseconds from now.
	 */
	function requestFrame(after = 0): void {
		if (disposed || failed) {
			return;
		}
		const at = clock() + Math.max(after, Math.max(0, frameMs - (clock() - last)));
		if (scheduled && dueAt <= at) {
			return;
		}
		if (timer) {
			clearTimeout(timer);
		}
		scheduled = true;
		dueAt = at;
		timer = setTimeout(
			() => {
				timer = undefined;
				scheduled = false;
				runFrame();
			},
			Math.max(0, at - clock())
		);
		// a frame pending is not a reason for a finished process to stay alive,
		// which is the rule the spinner's own interval already followed. What keeps
		// a real app running is stdin, not the loop that draws for it
		timer.unref?.();
	}

	function teardown(finish: boolean): void {
		if (disposed) {
			return;
		}
		disposed = true;
		if (timer) {
			clearTimeout(timer);
			timer = undefined;
		}
		scheduled = false;
		offResize?.();
		scope.setScheduler(previousScheduler);
		scope.setErrorHandler(previousHandler);
		if (owner) {
			// reported rather than thrown: this is the renderer unmounting rather
			// than a caller who asked, and the rule that one failing cleanup must
			// not leave the rest of the teardown undone is why it collects
			for (const error of disposeOwner(owner, false)) {
				onError(error);
			}
		}

		// and the screen goes back, which is what `dispose()` has always claimed to
		// do and did not. An inline backend holds its rows until it is told
		// otherwise: the anchor stays, and with it the arithmetic that says where
		// the frame's top is relative to the cursor. A `console.log()` after
		// `dispose()` moved the real cursor and left that arithmetic describing
		// somewhere else, so the erase the region does on its way out started two
		// rows *inside* the frame and cleared downwards -- taking the log line with
		// it and leaving the top of the frame behind. `done()` leaves the frame in
		// the log and puts the cursor below it, which is the state the docs
		// describe. Not on the failure path: there the caller wants it erased, and
		// `fail()` calls `stop()` itself
		if (finish) {
			backend.done();
		}
	}

	function fail(error: unknown): void {
		if (failed) {
			return;
		}
		failed = true;
		// the terminal comes back before anything is written about why: a CLI that
		// dies on the alternate buffer with the cursor hidden has eaten the user's
		// shell, and a message printed into a half-drawn frame is unreadable
		try {
			teardown(false);
			backend.stop();
			terminal.restore();
		} finally {
			onError(error);
		}
	}

	/**
	 * What the last `layoutInto()` gave a different size to.
	 *
	 * Lives across frames rather than per call because it is cleared where the
	 * collection begins -- at the top of `layoutInto()`, which is the layout and
	 * lays out twice for an auto-height canvas: clearing between those two would
	 * lose the first one's answer to the second one agreeing with it.
	 */
	const resized = new Set<Element>();

	function layoutInto(): void {
		resized.clear();
		if (!autoHeight && !autoWidth) {
			arrange(root, { height: backend.height, width: backend.width }, resized);
			return;
		}

		// measured rather than laid out and read back, which was the first answer and
		// was wrong in the way that matters: a root with no declared height fills
		// whatever it is given, so `box.height` after a pass at the screen's height
		// is the screen's height -- two rows of content reserved twenty-three rows
		// of terminal. `measureNode()` is what a node would ask for if it could
		// have whatever it wanted, which is the question being asked here
		const room = Math.max(1, terminal.height);
		// a canvas that follows its content is measured at the screen, since that is
		// the most it may have; one whose width is settled is measured at that
		const offered = autoWidth ? Math.max(1, terminal.width) : backend.width;
		const measured = measureNode(root, offered);
		const width = autoWidth ? Math.min(offered, Math.max(1, measured.width)) : backend.width;

		// and the height is asked again at the width the canvas is about to be,
		// because the two are not independent: content that fits in eighty columns
		// and is measured there wraps differently at the forty it came out as, and
		// the height of a wrap that never happens is the wrong number of rows to
		// reserve. One measure where the width did not move, since then the answer
		// above already is the answer
		const content = width === offered ? measured : measureNode(root, width);
		const height = autoHeight ? Math.min(room, Math.max(1, content.height)) : backend.height;

		if (width !== backend.width || height !== backend.height) {
			backend.resize(width, height);
		}

		const result = arrange(root, { height: backend.height, width: backend.width }, resized);

		// and laid out again where it reached further than it measured, which is the
		// same second pass `renderToString()` takes and for the same reason: a row
		// whose children flex is measured with each child offered the whole content
		// box and placed with each given a share, so a question that wraps to two
		// lines in the share it gets was one line in the room it was offered -- and
		// the canvas reserved one row, with the second line clipped off the bottom
		if (autoHeight) {
			const used = Math.min(room, Math.max(1, arrangedExtent(result).height));
			if (used > backend.height) {
				backend.resize(backend.width, used);
				arrange(root, { height: backend.height, width: backend.width }, resized);
			}
		}
	}

	/**
	 * Hands what the tree recorded to the restyler and the animator.
	 *
	 * A function rather than a block inside `settle()` because a frame drains twice:
	 * once for what the effects did, and again for what a resize handler did after
	 * the layout. `take()` drains rather than the caller clearing, so the second
	 * call sees exactly what the handlers touched and nothing else -- which is what
	 * narrows the re-match to the rows a window built and the two spacers whose
	 * heights it wrote, where `renderToString()` has no tree and pays a full one.
	 *
	 * @returns What was recorded, for whoever wants to read it.
	 */
	function drainMarks(): ReturnType<Tree['take']> {
		const marks = tree.take();
		for (const element of marks.classes) {
			restyler.touchClasses(element);
		}
		for (const element of marks.props) {
			restyler.touchProps(element);
		}
		for (const element of marks.children) {
			restyler.touchChildren(element);
		}
		for (const element of marks.removed) {
			// still attached means it was moved rather than removed, and a move is a
			// removal and an insertion -- forgetting one of those would throw away
			// the style of every row a `For` reordered
			if (!element.tree) {
				restyler.forget(element);
				animator.forget(element);
			}
		}
		return marks;
	}

	/**
	 * Style, then layout, then paint: each implies the ones after it, and each is
	 * skipped when nothing asked for it.
	 */
	function settle(): void {
		// 1. run whatever went stale. Effects write to elements, so this is what
		//    produces the marks the rest of the frame reads
		scope.flush();

		// an effect that threw was reported by the scope's error handler, which is
		// `fail()` -- and a handler is called rather than thrown through, so the
		// flush returns normally and this frame would otherwise carry on over a
		// renderer that has already given the screen back: painting onto the
		// restored terminal, and draining mount callbacks against an owner whose
		// cleanups have all run
		if (disposed || failed) {
			return;
		}

		// 2. hand what the tree recorded to the restyler, which is the join between
		//    what changed and what that implies. Without it a restyler kept across
		//    frames re-resolves nothing after the first, and does it silently: the
		//    state really did change and the selector really would match, and the
		//    frame was simply never asked
		const marks = drainMarks();
		const update = settleStyles(root, restyler);

		// 2a. the animation, which sits between the cascade and the screen: the
		//     settle has just written each element's *base* style, so the animator
		//     is shown the change and then writes what is actually presented over
		//     the top. Nothing here touches the restyler, which is the whole of
		//     "an animation writes through to paint rather than marking style
		//     dirty" -- the cascade is not re-run for a frame of an animation
		const at = clock();
		for (const target of update.paint) {
			// the restyler answers in terms of `StyleTarget`, which is what keeps it
			// free of the element tree; what it was handed is this tree's elements
			const element = target as Element;
			animator.observe(element, element.style, at);
		}
		const animated = animator.tick(at);
		/** Puts the presented styles back over the base ones a settle just wrote. */
		const present = (): void => {
			for (const [element, style] of animated.styles) {
				element.style = style;
			}
		};
		present();

		// the restyler answers for what a *style* change implies and cannot answer
		// for the other two. A text that was edited or a `raw` that re-measured
		// changed no style and is a different size, which is `marks.layout`. And a
		// child added, removed or moved changed no style either, while every box
		// after it is somewhere else -- found by a `For` that reordered its rows
		// correctly and drew them in the old order, because the frame had nothing
		// telling it to lay out again
		//
		// an animated *geometry* property is in `LAYOUT_PROPERTIES`, so it really
		// does have to re-lay-out -- which is the one refinement the recorded
		// architecture needed and is why the animator reports the two separately.
		// What makes it affordable is that geometry interpolates in whole cells, so
		// a box going from ten columns to twenty lays out ten times rather than
		// once per frame
		const needLayout =
			full ||
			update.layout.size > 0 ||
			marks.layout.size > 0 ||
			marks.children.size > 0 ||
			animated.layout.size > 0;
		const needPaint =
			needLayout ||
			repaint ||
			update.paint.size > 0 ||
			marks.paint.size > 0 ||
			animated.paint.size > 0;

		if (needLayout) {
			layoutInto();

			// and again for anything the layout told its box had moved, where that
			// changed the tree. The offset is not the only input to a windowed list's
			// window -- the viewport's *height* is the other, and nothing knows that
			// until a layout has run -- so a resize, which writes no offset, used to
			// leave a list holding the window it had: ten rows where forty-one were
			// needed, with thirty rows of the viewport blank until the next scroll.
			//
			// The restyle is what makes this the frame's rather than `arrange()`'s: a
			// handler that *builds* elements leaves them with the shared frozen initial
			// style, which carries none of their props -- measured, a slot built there
			// has `height: auto` and `flex-shrink: 1`, which is both halves of what the
			// windowing rests on. And the marks are drained again rather than left for
			// the next frame, because a new window writes the two spacers' heights with
			// `setProp()`: a kept restyler is marks-driven, so without it those two keep
			// the style they already had and the content box's extent describes the
			// window that has gone. Draining is also what forgets the rows the new
			// window displaced in this frame rather than the next
			settleResized(resized, () => {
				drainMarks();
				settleStyles(root, restyler);
				// and the presented styles again, because `settleStyles()` writes the
				// **base** one onto every element it has a cached style for -- animating
				// ones included. Without this a frame that re-windowed drew every
				// animation at its base value, and worse laid it out there: an animated
				// geometry property is in `LAYOUT_PROPERTIES`, so a width easing from ten
				// to twenty would be placed at ten for that frame. The same order the
				// first pass keeps, which is why it is the same function
				present();
				layoutInto();
			});
		}
		if (needPaint) {
			backend.render((painter, canvas) => {
				paint(root, painter);

				// the selection last, so it is over everything the tree drew -- and
				// recomputed from `selected` every time rather than written into the
				// cells, because a selection is transient state nobody painted and
				// `paint()`'s own `clear()` is what takes the last one off.
				//
				// Nothing at all at colour level 0, which is the rule the prompt caret
				// already follows: the seven attributes go there too, so a reverse-video
				// highlight would be the one sequence `NO_COLOR` could not switch off.
				// The selection still exists and still copies; what is lost is the
				// highlight, on a destination that is a pipe or a user who asked for
				// plain text
				if (selected && cascade.media.colorLevel > 0) {
					paintSelection(painter, selected, {
						height: canvas.height,
						selectable: selectableAt(root, canvas.width, canvas.height),
						width: canvas.width,
					});
				}
			});
		}
		full = false;
		repaint = false;

		// 3. anything waiting to be told it is on screen, now that it has a box
		if (owner) {
			for (const error of drainMounts(owner)) {
				onError(error);
			}
		}

		// 4. and a frame for the animation to carry on in, asked for *here* rather
		//    than by a timer of its own: nothing dirty still means no frame, and an
		//    animation is the one thing that is dirty about the future rather than
		//    about the past. The delay is how long until something would quantize
		//    differently, which is the frame skip spent as a longer sleep rather
		//    than as a wakeup that does nothing
		if (animator.active) {
			requestFrame(animator.nextChange(at, frameMs) ?? 0);
		}
	}

	function runFrame(): void {
		if (disposed || failed || settling) {
			// re-entered from inside an effect that called `frame()`. The flush it
			// would run is a no-op while one is already draining, so what the inner
			// frame would actually do is take the outer frame's marks and paint a
			// half-settled graph -- and the outer frame then finds nothing left to
			// draw. The frame already running is the one that finishes this
			return;
		}
		// whatever was pending is this frame: a frame asked for during mount, or by
		// an effect between two `frame()` calls, would otherwise fire again with
		// nothing to do -- and worse, `scheduled` left standing makes the *next*
		// request a no-op, so a mutation made after this frame's `take()` waits for
		// a timer that has already been consumed
		if (timer) {
			clearTimeout(timer);
			timer = undefined;
		}
		scheduled = false;
		last = clock();
		settling = true;
		try {
			settle();
		} catch (error) {
			fail(error);
		} finally {
			settling = false;
		}
	}

	// installed before the component runs, so that an effect its body creates and
	// then dirties is a frame this renderer hears about
	const previousScheduler = scope.setScheduler(() => requestFrame());
	const previousHandler = scope.setErrorHandler((error) => fail(error));

	let root: Element;
	let tree: Tree;
	try {
		root = createRoot(
			() => {
				// the owner rather than the disposer `createRoot()` hands over:
				// `teardown()` disposes it directly, and reporting what the cleanups
				// threw is the renderer's rather than the caller's
				owner = getOwner();
				return component();
			},
			scope.effect,
			onError
		);
		tree = createTree(root, () => requestFrame());
	} catch (error) {
		// the terminal goes back, and the error goes to the caller rather than to
		// `onError`: `render()` is still on the stack, so there is somebody to hand
		// it to, and reporting it as well is the same failure said twice. A throw
		// from an effect during the *first frame* has no such caller and is
		// reported, which is why the two paths differ
		failed = true;
		teardown(false);
		backend.stop();
		terminal.restore();
		throw error;
	}

	offResize = terminal.onResize(() => {
		if (disposed || failed) {
			return;
		}
		// the selection goes, because it is two cells of a grid that no longer
		// exists: the canvas discards both buffers on a resize for exactly that
		// reason, and a cell pair kept across one names whatever the re-layout
		// happens to put there. Dropped rather than mapped -- there is nothing to
		// map it through, since the content moved and may have rewrapped
		selected = undefined;

		// everything, media queries included: a rule inside `@media (min-width: 100)`
		// may now apply or may now not, and which elements those are is exactly the
		// question a full re-match answers
		publishMedia();
	});

	/**
	 * Publishes a media-context change: a full re-match, a layout, a repaint.
	 *
	 * The same three things a resize does, through the same three calls, because a
	 * capability reply and a resize are the same kind of event -- the answer to a
	 * media query moved. Written once rather than twice for the reason this file
	 * already gives about two implementations of one thing: the day they part is
	 * the day a late reply restyles and a resize does not, or the other way round.
	 */
	function publishMedia(): void {
		readMedia();
		restyler.touchMedia();
		// and the animator, because `prefers-reduced-motion` is one of the queries
		// that moved: whether an animation runs is a live answer, and a running one
		// that the preference now refuses has to stop asking for frames
		animator.touchMedia(clock());
		full = true;
		requestFrame();
	}

	async function detect(input: InputRouter, options: DetectOptions = {}): Promise<Capabilities> {
		if (disposed || failed) {
			// a probe against a renderer that has gone would write a query nothing
			// will read the answer to, and then restyle a tree nobody is painting
			return readCapabilities([]);
		}

		const found = await detectCapabilities(input, {
			...options,
			// what the environment said, which is the floor a reply may raise and may
			// not lower. Read here rather than in the probe, because this is where the
			// question "what are we resolving at" already has an answer
			colorLevel: options.colorLevel ?? (cascade.media.colorLevel as ColorLevel),
		});

		if (disposed || failed) {
			return found;
		}

		// asked again against the level that is on screen *now* rather than only
		// against the one captured before the await, and both halves are the
		// invariant rather than tidiness. `> 0` because the floor may have moved
		// while the probe was out -- a resize re-reads `NO_COLOR`, so a level that was
		// 2 when the query went out can be 0 by the time it comes back, and
		// `refineColorLevel()` only ever saw the old one. `>` because raise-only is
		// the rule, and `!==` would let a reply lower a level a resize had raised
		const level = cascade.media.colorLevel;
		let moved = false;
		if (found.colorLevel !== undefined && level > 0 && found.colorLevel > level) {
			refined = { ...refined, colorLevel: found.colorLevel };
			moved = true;
		}

		// the scheme is the thing this was really built for, and it has no floor to
		// protect: there is no "no scheme" the way there is a level of zero, and what
		// the terminal says about its own background is better evidence than a
		// possibly-stale `COLORFGBG` by definition.
		//
		// **Recorded whatever it says, including when it agrees with what is already on
		// screen**, and that was the bug: a reply was only stored where it *differed*,
		// so a terminal answering light while `COLORFGBG` already said light left
		// nothing behind -- and the next resize, after that variable had gone or
		// changed, fell through to `COLORFGBG` and then to dark over a terminal that
		// had told us the answer.
		//
		// Whether it is a *change* is then a question about the whole chain rather than
		// about the reply, which is why `scheme()` is asked twice. A caller who named
		// one, or a user who forced one, sits above the refinement -- so a reply that
		// disagrees with either of them is recorded and asks for no frame, where
		// comparing the reply to the media context would have spent one on every probe.
		if (found.colorScheme !== undefined) {
			const before = scheme();
			refined = { ...refined, colorScheme: found.colorScheme };
			if (scheme() !== before) {
				moved = true;
			}
		}

		if (moved) {
			publishMedia();
		}

		return found;
	}

	// the first frame is synchronous, so `render()` returns with something on
	// screen rather than with a timer pending
	runFrame();

	return {
		get animating() {
			return animator.active;
		},
		backend,
		detect,
		dispose: () => teardown(true),
		frame: runFrame,
		invalidate: requestFrame,
		get mounted() {
			return !disposed && !failed;
		},
		restyler,
		root,

		get selection() {
			return selected;
		},

		selectionText(): string {
			if (!selected) {
				return '';
			}
			const cells = backend.canvas.cells;
			return selectionText(cells, selected, {
				selectable: selectableAt(root, cells.width, cells.height),
			});
		},

		setSelection(next: Selection | undefined): void {
			if (next === selected) {
				return;
			}
			selected = next;
			repaint = true;
			requestFrame();
		},

		tree,
	};
}
