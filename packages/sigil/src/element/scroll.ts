/**
 * Scrolling a clipping box: how far it can go, and how to bring a box into view.
 *
 * The layout engine already scrolls -- `Element.scrollTo()` writes an offset and
 * the placement shifts the boxes by it, deliberately, so that a scrolled child's
 * box *is* where it is drawn. What that leaves out is everything a caller needs
 * to decide *what* to scroll to, and this is that: the range an offset may take,
 * a clamped relative move, and the walk that brings a focused row back on screen.
 *
 * It imports nothing but types, for the reason `hit.ts` does: the input router
 * reads this to keep the focus ring and the clip rect in agreement, and reaching
 * it through a module that touches the layout engine would put the whole drawing
 * stack behind `@ttylabs/sigil/input`.
 */

import type { Box } from '../layout/index.js';
import type { Style } from '../style/index.js';
import type { Element } from './index.js';

/**
 * Whether a box clips what its descendants draw, and so may be scrolled.
 *
 * One expression, said here because three places ask it: the arrange pass, which
 * needs it to narrow the clip and to bound a subtree's extent, this module, and
 * the hit test by way of the clip the first one wrote. `flex.ts` keeps its own
 * copy and that is the boundary rather than drift -- the layout engine takes a
 * `LayoutNode` and may not import the element tree, which is the whole reason it
 * is testable with a literal.
 *
 * @param style - The resolved style.
 * @returns Whether it clips.
 */
export function clipsContent(style: Style): boolean {
	return style.overflow !== 'visible';
}

/** Keeps an offset inside `0..max`, which is what a scroll offset may be. */
function clampOffset(value: number, max: number): number {
	return Math.max(0, Math.min(max, value));
}

/**
 * How far a clipping box can be scrolled on each axis.
 *
 * Read off the **arranged** tree rather than measured again, which is what makes
 * it exact: `Element.scrollable` is where the content reached as the placement
 * actually put it, so the size this compares against is the one on screen rather
 * than an estimate of it. A box nothing has arranged has no such region and
 * reports no range, which is the honest answer -- there is nothing to scroll
 * until something has been laid out.
 *
 * Both rectangles come from one arrange and neither moves when a new offset is
 * written, which is what makes it safe to ask twice before the next frame: two
 * wheel notches in one read of the stream each get the same range, where a
 * version that added the live offset back would hand the second one a list that
 * had grown by however far the first had scrolled.
 *
 * Compared against the **content** box rather than the padding box the clip uses.
 * A child scrolled under the padding is still drawn, as in CSS, so the padding is
 * room the content may reach into; what it may not do is end before the content
 * box does, which is what this bounds.
 *
 * @param viewport - The clipping box.
 * @returns The largest offset each axis may take, never negative.
 */
export function scrollRange(viewport: Element): { x: number; y: number } {
	const inner = viewport.content ?? viewport.box;
	const reach = viewport.scrollable;
	if (!inner || !reach) {
		return { x: 0, y: 0 };
	}

	return {
		x: Math.max(0, reach.x + reach.width - (inner.x + inner.width)),
		y: Math.max(0, reach.y + reach.height - (inner.y + inner.height)),
	};
}

/**
 * Scrolls a clipping box by a relative amount, clamped to what it has.
 *
 * `scrollTo()` floors at zero and deliberately does not know the top end -- it
 * is on the element, which has no idea how big its content came out. This does,
 * because `scrollRange()` reads the arranged tree.
 *
 * @param viewport - The clipping box.
 * @param dx - Cells to scroll right, negative for left.
 * @param dy - Cells to scroll down, negative for up.
 * @returns Whether the offset moved.
 */
export function scrollBy(viewport: Element, dx: number, dy: number): boolean {
	const at = viewport.scroll ?? { x: 0, y: 0 };
	const max = scrollRange(viewport);
	const next = { x: clampOffset(at.x + dx, max.x), y: clampOffset(at.y + dy, max.y) };

	if (next.x === at.x && next.y === at.y) {
		return false;
	}

	viewport.scrollTo(next.x, next.y);
	return true;
}

export interface ScrollIntoViewOptions {
	/**
	 * Cells to keep visible past the element on every side.
	 *
	 * What a list wants so that tabbing to the last visible row still shows the
	 * next one, which is the difference between knowing there is more and finding
	 * out by pressing Tab again.
	 */
	margin?: number;
}

/**
 * How far one axis has to move to bring `start..start + size` into the view.
 *
 * Zero where it already fits. Negative to scroll back towards the start, which is
 * what a box above the fold needs. An element **larger** than the view aligns its
 * start edge rather than its end, because showing the top of a row is the useful
 * half of a row that cannot fit -- that is the `nearest` scrolling CSS does, and
 * it falls out of taking the smaller of the two candidate moves.
 */
function offsetInto(
	start: number,
	size: number,
	viewStart: number,
	viewSize: number,
	margin: number
): number {
	const lead = start - margin;
	const tail = start + size + margin;
	const viewEnd = viewStart + viewSize;

	if (lead < viewStart) {
		return lead - viewStart;
	}
	if (tail > viewEnd) {
		return Math.min(tail - viewEnd, lead - viewStart);
	}
	return 0;
}

/**
 * Scrolls every clipping ancestor until an element is on screen.
 *
 * This is what the focus ring calls, and the reason it has to exist: the ring is
 * rebuilt from the tree and already skips a `display: none` subtree, because
 * there is nothing on screen there to move the focus to. A row below the fold is
 * the analogous case with the opposite answer -- it *is* on screen, somewhere the
 * user cannot see, so the fix is to scroll rather than to skip. Without it,
 * tabbing into a long list moves a highlight nobody can find and the app looks
 * like it stopped responding.
 *
 * Walked innermost outward, carrying what the nearer ancestors have already
 * moved. That accumulation is the part that is easy to get wrong: scrolling an
 * inner box moves the target and leaves the inner box itself where it was, so the
 * next ancestor out has to be asked about where the target has *got to* rather
 * than about the box the last arrange gave it. Scrolling an **outer** box moves
 * the inner one and the target together, which is why the other order would need
 * no accumulation and would also be wrong -- it would scroll the outer box to a
 * position the inner one is about to leave.
 *
 * Every offset comes from one arranged tree, so nothing is re-laid-out in the
 * middle: `scrollTo()` marks layout, and the frame that follows is where the
 * boxes move.
 *
 * @param target - The element to reveal.
 * @param opts - How much room to leave around it.
 * @returns Whether anything scrolled.
 */
export function scrollIntoView(target: Element, opts: ScrollIntoViewOptions = {}): boolean {
	const area = target.box;
	if (!area) {
		// nothing has laid this out, so there is no position to reveal
		return false;
	}

	const margin = Math.max(0, Math.trunc(opts.margin ?? 0));
	let shiftX = 0;
	let shiftY = 0;
	let moved = false;

	for (let at = target.parent; at; at = at.parent) {
		if (!clipsContent(at.style)) {
			continue;
		}
		const inner = at.content ?? at.box;
		if (!inner) {
			continue;
		}

		// where the target has reached, after everything nearer has scrolled. A
		// scroll of `d` moves the content up or left by `d`, so the target's own
		// position falls by exactly that
		const seenX = area.x - shiftX;
		const seenY = area.y - shiftY;

		const dx = offsetInto(seenX, area.width, inner.x, inner.width, margin);
		const dy = offsetInto(seenY, area.height, inner.y, inner.height, margin);
		if (dx === 0 && dy === 0) {
			continue;
		}

		const was = at.scroll ?? { x: 0, y: 0 };
		const max = scrollRange(at);
		const next = { x: clampOffset(was.x + dx, max.x), y: clampOffset(was.y + dy, max.y) };
		if (next.x === was.x && next.y === was.y) {
			continue;
		}

		at.scrollTo(next.x, next.y);
		// the clamped move rather than the asked-for one, or an ancestor that could
		// not go as far as it was told would hand the next one out a lie
		shiftX += next.x - was.x;
		shiftY += next.y - was.y;
		moved = true;
	}

	return moved;
}

/**
 * Whether two rectangles share a cell.
 *
 * Exported for the two walks that cull with it, and written here rather than in
 * each so that paint and the hit test cannot come to disagree about what "off
 * screen" means. A zero-area rectangle overlaps nothing, which is what makes an
 * empty clip cull a whole subtree rather than keeping it.
 *
 * @param a - One rectangle.
 * @param b - The other.
 * @returns Whether they intersect.
 */
export function overlaps(a: Box, b: Box): boolean {
	return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}
