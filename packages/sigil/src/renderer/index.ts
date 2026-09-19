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
import { type CanvasBackend, createInlineCanvas } from '../canvas/index.js';
import {
	arrange,
	arrangedExtent,
	createTree,
	type Element,
	paint,
	settleStyles,
	type Tree,
} from '../element/index.js';
import { errorHandler as defaultErrorHandler } from '../error-handler.js';
import { measureNode } from '../layout/index.js';
import { createEffects, type Effects } from '../signals/index.js';
import { Cascade, Restyler } from '../style/index.js';
import { type Terminal, terminal as defaultTerminal } from '../terminal/index.js';
import { createRoot, disposeOwner, drainMounts, getOwner, type Owner } from './owner.js';

export { For, type ForProps, Show, type ShowProps } from './control.js';
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
	/** Where frames are going. */
	readonly backend: CanvasBackend;
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
	const scope: Effects = opts.effects ?? createEffects();
	const cascade = opts.cascade ?? new Cascade([]);
	const restyler = new Restyler(cascade);
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
	const readMedia = (): void => {
		cascade.media = {
			colorLevel: opts.colorLevel ?? supportsColor(),
			height: Math.max(1, terminal.height),
			width: Math.max(1, terminal.width),
		};
	};
	readMedia();

	let disposed = false;
	let failed = false;
	let scheduled = false;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let last = 0;
	/** Whether the next frame lays out and paints whatever the marks said. */
	let full = true;
	let owner: Owner | undefined;
	let offResize: (() => void) | undefined;
	/** Whether a frame is settling, which is what makes `frame()` safe to call. */
	let settling = false;

	function requestFrame(): void {
		if (disposed || failed || scheduled) {
			return;
		}
		scheduled = true;
		const wait = Math.max(0, frameMs - (Date.now() - last));
		timer = setTimeout(() => {
			timer = undefined;
			scheduled = false;
			runFrame();
		}, wait);
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

	function layoutInto(): void {
		if (!autoHeight && !autoWidth) {
			arrange(root, { height: backend.height, width: backend.width });
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

		const result = arrange(root, { height: backend.height, width: backend.width });

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
				arrange(root, { height: backend.height, width: backend.width });
			}
		}
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
			}
		}

		const update = settleStyles(root, restyler);

		// the restyler answers for what a *style* change implies and cannot answer
		// for the other two. A text that was edited or a `raw` that re-measured
		// changed no style and is a different size, which is `marks.layout`. And a
		// child added, removed or moved changed no style either, while every box
		// after it is somewhere else -- found by a `For` that reordered its rows
		// correctly and drew them in the old order, because the frame had nothing
		// telling it to lay out again
		const needLayout =
			full || update.layout.size > 0 || marks.layout.size > 0 || marks.children.size > 0;
		const needPaint = needLayout || update.paint.size > 0 || marks.paint.size > 0;

		if (needLayout) {
			layoutInto();
		}
		if (needPaint) {
			backend.render((painter) => paint(root, painter));
		}
		full = false;

		// 3. anything waiting to be told it is on screen, now that it has a box
		if (owner) {
			for (const error of drainMounts(owner)) {
				onError(error);
			}
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
		last = Date.now();
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
		// everything, media queries included: a rule inside `@media (min-width: 100)`
		// may now apply or may now not, and which elements those are is exactly the
		// question a full re-match answers
		readMedia();
		restyler.touchSize();
		full = true;
		requestFrame();
	});

	// the first frame is synchronous, so `render()` returns with something on
	// screen rather than with a timer pending
	runFrame();

	return {
		backend,
		dispose: () => teardown(true),
		frame: runFrame,
		invalidate: requestFrame,
		get mounted() {
			return !disposed && !failed;
		},
		restyler,
		root,
		tree,
	};
}
