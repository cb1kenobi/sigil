/**
 * A scroll box: a clipping viewport, a scrollbar, and the three ways to move it.
 *
 * The layout engine has scrolled since SIG-64 and deliberately stopped there --
 * "a scrollbar is a component, not a layout feature. The layout knows how far a
 * box is scrolled and how tall its content came out; what to draw about that has
 * a dozen answers and none of them belong to the engine." This is one of the
 * dozen, written as a component so that an app that wants a different one writes
 * a different component rather than a different engine.
 *
 * ```js
 * import { ScrollBox } from '@ttylabs/sigil/components';
 * import { box, text } from '@ttylabs/sigil/element';
 *
 * const view = ScrollBox({
 *   props: { height: 10, width: 40 },
 *   children: () => box({ 'flex-direction': 'column' }, ...rows.map((r) => text(r))),
 * });
 * ```
 *
 * ## It holds no state of its own
 *
 * There are no signals here, and that is the design rather than an omission. The
 * scroll offset already lives somewhere -- `viewport.scroll`, which the layout
 * engine reads and `scrollTo()` writes, marking layout and asking for a frame --
 * so a signal beside it would be a second copy of one number for the two to
 * disagree about. Every handler writes that offset directly and the next frame
 * follows. Which means `ScrollBox` works with no renderer mounted at all: a
 * `renderToString()` of one scrolled to row forty prints row forty.
 *
 * ## And the thumb is drawn rather than placed
 *
 * The thumb's size and position are a question about the laid-out content, and
 * nothing knows how tall the content came out until layout has run. Reading it
 * back into a signal would put the thumb one frame behind the content it
 * describes -- visible as a lag on every wheel notch. So the bar is two `raw`
 * elements stacked over one rectangle, each painting from the boxes of the frame
 * it is in: the track underneath and the thumb over it, in document order, each
 * carrying its own class and therefore its own resolved style. That is what `raw`
 * is for, and it is the one shape where the thumb cannot be out of date.
 */

import {
	box,
	cellStyle,
	type Element,
	type ElementProps,
	raw,
	type RawPaint,
	scrollBy,
	scrollRange,
} from '../element/index.js';
import type { KeyEvent, MouseEvent } from '../input/index.js';

/** Which axes a scroll box scrolls, and therefore which bars it draws. */
export type ScrollAxis = 'both' | 'horizontal' | 'vertical';

export interface ScrollBoxProps {
	/**
	 * Which axes scroll. Defaults to `vertical`.
	 *
	 * It decides three things together, because they are one decision: which
	 * scrollbar is drawn, which keys are claimed, and whether the content keeps
	 * its own width or is stretched to the viewport's.
	 */
	axis?: ScrollAxis;
	/** The content. Built once, like any component's children. */
	children: () => Element;
	/*
	 * There is deliberately no `margin`, and one was here and read by nothing.
	 *
	 * It is `scrollIntoView()`'s option and means something there -- how much to
	 * keep visible past a row being revealed -- and it means nothing to a relative
	 * move: a key scrolls by a line or a page, a notch by its own three lines, and
	 * there is no edge for a margin to be measured against. The prop doc claimed
	 * the keyboard and the wheel read it, which they never did, so it was a
	 * property that parses and does nothing: the thing this repo records as worse
	 * than one that does not exist, found by review.
	 *
	 * Reaching the option is still the caller's: `scrollIntoView(row, { margin: 1 })`.
	 * What the focus ring passes is nothing, and giving a scroll box a margin the
	 * ring honours means the ring reading one off the element -- a `scroll-margin`
	 * property rather than a component prop, and a decision for whoever needs it.
	 */
	/** The host box's own props: the height it is given, a border, a class. */
	props?: ElementProps;
	/**
	 * Whether to draw a scrollbar at all. Defaults to `true`.
	 *
	 * `false` keeps every other half of the component -- the clip, the keys, the
	 * wheel, the gutter it would have reserved is not reserved -- which is what a
	 * list that draws its own indicator wants.
	 */
	scrollbar?: boolean;
}

/** The glyph a track cell draws. One cell, so no width arithmetic. */
const TRACK_CELL = '│';

/** The glyph a horizontal track cell draws. */
const TRACK_CELL_H = '─';

/** The glyph a thumb cell draws, on both axes. */
const THUMB_CELL = '█';

/**
 * A wheel notch is three lines, which is the convention every toolkit follows.
 *
 * Three rather than one because one notch of a real wheel is one *detent* and a
 * terminal reports one event per detent, so a notch has to be worth more than a
 * keystroke or the mouse is slower than the keyboard.
 */
const WHEEL_LINES = 3;

/**
 * How long a notch counts as part of the same flick.
 *
 * A quarter of a second would accelerate a slow, deliberate scroll; fifty
 * milliseconds would need a faster wheel than a hand produces. 120ms is about
 * eight notches a second, which is a flick rather than a walk.
 */
const WHEEL_WINDOW = 120;

/** The most a flick is multiplied by, so a long log is crossed and not jumped. */
const WHEEL_MAX = 4;

/** What a bar draws: where the thumb starts along the track, and how long it is. */
interface Thumb {
	size: number;
	start: number;
}

/**
 * Where the thumb sits on a track, given what is above and below it.
 *
 * Three properties hold it together and each is the kind of thing that reads as a
 * rendering bug when it is missing.
 *
 * The thumb is **at least one cell**, because a thumb rounded away is a scrollbar
 * with nothing in it -- which is exactly what a long log would produce, since the
 * ratio there is the one that rounds to zero.
 *
 * It touches an end **only at that end**. A thumb drawn at the top while one row
 * is still above it says the list is at its start when it is not, and a reader
 * believes the scrollbar over their own memory of pressing Down. So offset zero is
 * the only thing that draws at the start, the maximum offset the only thing that
 * draws at the end, and everything between is interpolated across the cells in
 * the middle -- which is what the `span - 2` is.
 *
 * Content that **fits** fills the track. Hiding the bar instead is the other
 * option and it costs a reflow the moment the content grows, which is the whole
 * reason the gutter is reserved in the first place; a full thumb says "this
 * scrolls, and you are seeing all of it", which is true and is one fewer thing
 * moving on screen.
 *
 * @param track - The track's length in cells.
 * @param viewport - How much of the content is visible.
 * @param content - How much there is.
 * @param offset - How far it is scrolled.
 * @returns The thumb's extent along the track.
 */
export function thumbExtent(
	track: number,
	viewport: number,
	content: number,
	offset: number
): Thumb {
	if (track <= 0) {
		return { size: 0, start: 0 };
	}
	if (viewport <= 0 || content <= viewport) {
		return { size: track, start: 0 };
	}

	const size = Math.max(1, Math.min(track, Math.round((viewport / content) * track)));
	const span = track - size;
	const range = content - viewport;

	if (span <= 0 || offset <= 0) {
		return { size, start: 0 };
	}
	if (offset >= range) {
		return { size, start: span };
	}
	if (span === 1) {
		// one spare cell and two ends that have claimed it: either answer is a lie
		// about one of them, so the start is the one that is also the honest answer
		// for a track too short to say anything
		return { size, start: 0 };
	}

	return {
		size,
		start: Math.min(span - 1, Math.max(1, 1 + Math.round((offset / range) * (span - 2)))),
	};
}

/** A `raw` element's measure, for one whose size is its four insets. */
function noSize(): { height: number; width: number } {
	return { height: 0, width: 0 };
}

/**
 * Builds a scroll box.
 *
 * @param props - The content, the axes, and the host's own props.
 * @returns The host element.
 */
export function ScrollBox(props: ScrollBoxProps): Element {
	const axis = props.axis ?? 'vertical';
	const vertical = axis === 'both' || axis === 'vertical';
	const horizontal = axis === 'both' || axis === 'horizontal';
	const bars = props.scrollbar ?? true;

	const content = box({
		class: 'sigil-scroll-content',
		// no `flex-shrink: 0`, and one was written here and deleted for failing its
		// sabotage. It reads as the declaration that makes the content overflow --
		// `flex-shrink` defaults to 1, so the wrapper really is squeezed to the room
		// there is -- and it changes nothing, because what bounds the scroll is the
		// *extent* of what is inside the wrapper rather than the wrapper's own box.
		// A squeezed wrapper is one its children overflow, and they are drawn,
		// scrolled and counted exactly as before: measured, the demo's output is
		// byte for byte the same with it and without
		//
		// its cross size is its own only where the cross axis scrolls too: stretched
		// is what rows want, so that a highlight fills the width
		...(horizontal ? { 'align-self': 'flex-start' } : {}),
	});
	content.append(props.children());

	const viewport = box(
		{
			class: 'sigil-scroll-viewport',
			// the one box that clips, and therefore the one box that scrolls
			overflow: 'hidden',
			'flex-direction': 'column',
			// basis zero and grow one: take the room there is rather than the room
			// the content wants, which is the difference between a viewport and a box
			// that grew until nothing overflowed it
			'flex-basis': 0,
			'flex-grow': 1,
			'min-height': 0,
			'min-width': 0,
		},
		content
	);

	const row = box(
		{
			class: 'sigil-scroll-row',
			'flex-direction': 'row',
			'flex-basis': 0,
			'flex-grow': 1,
			'min-height': 0,
		},
		viewport
	);

	const host = box({
		// focusable, so that a box holding nothing focusable can still be scrolled
		// from the keyboard. A descendant that takes the focus reaches these keys
		// anyway, since a key walks from the focused element up through its
		// ancestors -- and it is before the spread, so an app may opt out
		focusable: true,
		...props.props,
		// after the spread: the bars are placed against it, so an app that set it
		// would be rearranging a layout it cannot see the rest of
		'flex-direction': 'column',
	});
	// added rather than written into the props, so that an app's own `class` is
	// kept: `class` replaces rather than merges, and a component that let a caller
	// silently take its class away would be a component a theme cannot reach
	host.addClass('sigil-scroll');
	host.append(row);

	if (bars && vertical) {
		row.append(scrollbar('vertical', viewport, false));
	}
	if (bars && horizontal) {
		// a column short where a vertical bar takes the last one, which leaves the
		// corner empty rather than drawing a track under a track -- and makes the
		// horizontal track exactly as long as the viewport is wide, which is what
		// its arithmetic is about
		host.append(scrollbar('horizontal', viewport, bars && vertical));
	}

	wireKeys(host, viewport, { horizontal, vertical });
	wireWheel(host, viewport, { horizontal, vertical });

	return host;
}

/** The viewport's content box, or nothing before anything has arranged it. */
function viewportOf(viewport: Element): { height: number; width: number } | undefined {
	return viewport.content ?? viewport.box;
}

/**
 * One scrollbar: a track and a thumb over the same rectangle.
 *
 * Both children are `position: absolute` with all four insets, so each fills the
 * bar's padding box and neither takes any space -- which is what lets them share
 * one rectangle. Document order is paint order, so the thumb is drawn over the
 * track, and each carries its own class so that a theme can colour the two
 * separately through the ordinary cascade.
 *
 * @param axis - Which bar this is.
 * @param viewport - The clipping box it describes.
 * @param corner - Whether to stop a column short for a vertical bar.
 * @returns The bar element.
 */
function scrollbar(axis: 'horizontal' | 'vertical', viewport: Element, corner: boolean): Element {
	const down = axis === 'vertical';

	const geometry = (area: { height: number; width: number }): Thumb => {
		const inner = viewportOf(viewport);
		const range = scrollRange(viewport);
		const offset = viewport.scroll ?? { x: 0, y: 0 };

		return down
			? thumbExtent(area.height, inner?.height ?? 0, (inner?.height ?? 0) + range.y, offset.y)
			: thumbExtent(area.width, inner?.width ?? 0, (inner?.width ?? 0) + range.x, offset.x);
	};

	const cells = (name: string, paint: RawPaint): Element =>
		raw(
			{ measure: noSize, paint },
			{
				bottom: 0,
				class: name,
				left: 0,
				position: 'absolute',
				right: corner ? 1 : 0,
				top: 0,
			}
		);

	const track = cells('sigil-scroll-track', (painter, area, element) => {
		const style = cellStyle(element.style);
		const glyph = down ? TRACK_CELL : TRACK_CELL_H;
		const run = down ? area.height : area.width;
		for (let i = 0; i < run; i++) {
			painter.text(down ? area.x : area.x + i, down ? area.y + i : area.y, glyph, style);
		}
	});

	const thumb = cells('sigil-scroll-thumb', (painter, area, element) => {
		const style = cellStyle(element.style);
		const { size, start } = geometry(area);
		for (let i = 0; i < size; i++) {
			painter.text(
				down ? area.x : area.x + start + i,
				down ? area.y + start + i : area.y,
				THUMB_CELL,
				style
			);
		}
	});

	const bar = box(
		{
			class: `sigil-scroll-bar is-${axis}`,
			// the insets on the two children resolve against this box's padding box,
			// which only a positioned ancestor provides
			position: 'relative',
			// a reserved gutter rather than an overlay, and reserved whether or not
			// anything can scroll: see the module note on why a terminal cannot
			// overlay one. A `flex-shrink: 0` beside it was deleted for the reason
			// the content's was -- nothing squeezes this cell, because the viewport
			// beside it has a basis of zero and takes only the remainder
			...(down ? { width: 1 } : { height: 1 }),
		},
		track,
		thumb
	);

	wireDrag(bar, viewport, axis, () => {
		const area = thumb.box;
		return area ? { area, thumb: geometry(area) } : undefined;
	});

	return bar;
}

/** Which axes a box owns, which is what the keys and the wheel are gated on. */
interface Axes {
	horizontal: boolean;
	vertical: boolean;
}

/**
 * Arrows, PageUp/PageDown and Home/End, on the axes this box owns.
 *
 * Claimed only where the axis **has somewhere to go**, which is what gives scroll
 * chaining for free: an inner box whose content fits swallows nothing, so the key
 * bubbles to whatever is outside it. Claiming unconditionally was the other
 * option and it is the annoying one -- a one-row list that happens to be a scroll
 * box would eat every Down in the app.
 *
 * A box **at its end** is a different thing and still claims the key: it has a
 * range, so the guard lets it through, and `by` clamping to zero is what makes
 * the press do nothing. That is deliberate -- Home in a list already at its top
 * is still that list's key, and letting it bubble would scroll the pane around it
 * instead -- so do not read the guard as "chains when it runs out". Chaining
 * there needs "which end" and a definition of partial consumption, and is
 * refused under "A scroll box" in AGENTS.md.
 *
 * A page is the viewport less a row, so that one line of what you were reading
 * survives the jump. That is what every pager does and it is the reason a page is
 * not simply the viewport.
 */
function wireKeys(host: Element, viewport: Element, axes: Axes): void {
	host.onKey = (event: KeyEvent): void => {
		const inner = viewportOf(viewport);
		const range = scrollRange(viewport);
		const at = viewport.scroll ?? { x: 0, y: 0 };
		const page = Math.max(1, (inner?.height ?? 1) - 1);

		/** Which axis the key is about, and how far along it. */
		let sideways = false;
		let by = 0;

		switch (event.key.name) {
			case 'up': {
				by = -1;
				break;
			}
			case 'down': {
				by = 1;
				break;
			}
			case 'pageup': {
				by = -page;
				break;
			}
			case 'pagedown': {
				by = page;
				break;
			}
			case 'left': {
				sideways = true;
				by = -1;
				break;
			}
			case 'right': {
				sideways = true;
				by = 1;
				break;
			}
			// Home and End answer for whichever axis this box has, vertical first,
			// because a list is the common case
			case 'home': {
				sideways = !axes.vertical;
				by = sideways ? -at.x : -at.y;
				break;
			}
			case 'end': {
				sideways = !axes.vertical;
				by = sideways ? range.x - at.x : range.y - at.y;
				break;
			}
			default: {
				return;
			}
		}

		if (sideways ? !axes.horizontal || range.x <= 0 : !axes.vertical || range.y <= 0) {
			return;
		}

		// claimed even where `by` is zero -- Home in a list already at its top is
		// still this box's key, and letting it bubble would scroll the pane around
		// it instead, which is the one answer nobody meant
		scrollBy(viewport, sideways ? by : 0, sideways ? 0 : by);
		event.stop();
	};
}

/**
 * The wheel, with an acceleration curve.
 *
 * Three lines a notch, multiplied by how fast the notches are arriving: a flick
 * crosses a ten-thousand-row log and a deliberate turn still moves three lines.
 * Without it a long log is unusable, which is the only reason the curve is here
 * rather than a constant.
 *
 * The streak resets when the **direction** changes as well as when the window
 * lapses, because reversing mid-flick otherwise launches the content the other
 * way at full speed -- a scroll that overshoots in the direction you were trying
 * to get back from.
 *
 * Shift makes a vertical wheel scroll horizontally where there is a horizontal
 * axis, which is what a terminal's own reader and every browser do.
 */
function wireWheel(host: Element, viewport: Element, axes: Axes): void {
	let lastAt = 0;
	let lastDir: string | undefined;
	let streak = 0;

	host.onMouse = (event: MouseEvent): void => {
		if (event.kind !== 'wheel' || !event.wheel) {
			return;
		}

		const sideways =
			event.wheel === 'left' || event.wheel === 'right' || (event.shift && axes.horizontal);
		const back = event.wheel === 'up' || event.wheel === 'left';
		const range = scrollRange(viewport);

		if (sideways ? !axes.horizontal || range.x <= 0 : !axes.vertical || range.y <= 0) {
			// an axis with nothing to scroll gives the report up, so a box whose
			// content fits hands the wheel to the pane around it. A box already at
			// its *end* still has a range and still claims the turn -- chaining
			// there would need "which end" and a definition of partial consumption,
			// and is deliberately not done
			return;
		}

		const now = Date.now();
		streak = now - lastAt <= WHEEL_WINDOW && event.wheel === lastDir ? streak + 1 : 0;
		lastAt = now;
		lastDir = event.wheel;

		const lines = WHEEL_LINES * Math.min(WHEEL_MAX, 1 + Math.floor(streak / 2));
		const by = back ? -lines : lines;

		scrollBy(viewport, sideways ? by : 0, sideways ? 0 : by);
		event.stop();
	};
}

/**
 * Dragging the thumb, and clicking the track to page.
 *
 * The press capture SIG-106 landed is what makes this possible: while a button is
 * held, every motion and the release go to whatever the press landed on wherever
 * the pointer got to -- so a drag that wanders off the bar, or off the canvas
 * entirely, still reaches the thumb and still ends.
 *
 * Every offset is computed from the press rather than accumulated from the last
 * move, so a drag across a long track does not drift by a cell per frame of
 * rounding.
 *
 * It stops the release **and** the click, which is the trap AGENTS.md records:
 * stopping an event stops it bubbling and does not cancel a different one, so a
 * component that owns a drag and does not want the derived click has to say both.
 */
function wireDrag(
	bar: Element,
	viewport: Element,
	axis: 'horizontal' | 'vertical',
	read: () =>
		| { area: { height: number; width: number; x: number; y: number }; thumb: Thumb }
		| undefined
): void {
	const down = axis === 'vertical';
	let drag: { from: number; offset: number } | undefined;

	bar.onMouse = (event: MouseEvent): void => {
		if (event.kind === 'mouseup') {
			drag = undefined;
			event.stop();
			return;
		}
		if (event.kind === 'click') {
			// not a second answer to the press that produced it
			event.stop();
			return;
		}
		if (event.kind !== 'mousedown' && event.kind !== 'mousemove') {
			// a wheel over the bar, and the enter and leave either side of it: left
			// to bubble, so the wheel reaches the box this bar belongs to
			return;
		}

		const state = read();
		if (!state) {
			return;
		}

		const { area, thumb } = state;
		const whole = scrollRange(viewport);
		const track = down ? area.height : area.width;
		const pointer = down ? event.y : event.x;
		const origin = down ? area.y : area.x;
		const inner = viewportOf(viewport);
		const range = down ? whole.y : whole.x;
		const at = viewport.scroll ?? { x: 0, y: 0 };
		const offset = down ? at.y : at.x;

		if (event.kind === 'mousedown') {
			const local = pointer - origin;
			if (local >= thumb.start && local < thumb.start + thumb.size) {
				drag = { from: pointer, offset };
			} else {
				// the track above or below the thumb pages towards the click, which is
				// what a terminal pager and every scrollbar do
				const page = Math.max(1, (down ? (inner?.height ?? 1) : (inner?.width ?? 1)) - 1);
				const by = local < thumb.start ? -page : page;
				scrollBy(viewport, down ? 0 : by, down ? by : 0);
			}
			event.stop();
			return;
		}

		if (drag) {
			const span = track - thumb.size;
			if (span > 0) {
				const moved = ((pointer - drag.from) * range) / span;
				const next = Math.round(drag.offset + moved);
				scrollBy(viewport, down ? 0 : next - at.x, down ? next - at.y : 0);
			}
			event.stop();
		}
	};
}
