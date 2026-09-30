/**
 * Which element is under a point, and the order that answers it.
 *
 * The second caller of the guarantee `arrange()` already makes -- that a box is
 * where its element is drawn -- and it needs no correction pass because of it:
 * scrolling moves the boxes rather than the drawing, deliberately, so everything
 * above can match a box back to an element without knowing how far anything has
 * been scrolled.
 *
 * It walks in **reverse paint order** and takes the first box containing the
 * point, because the topmost thing on screen is the last thing drawn there. There
 * is one implementation of that order and it is here rather than in `paint.js`,
 * though paint is its primary reader: a second implementation of "which child is
 * on top" is a hit test that disagrees with the screen, and this is the module
 * that has to stay light. The input router imports it, and reaching `paint.js` for
 * two lines of arithmetic put the layout engine, the cascade and the canvas into
 * every bundle that only wanted a key router -- measured at 29 kB against 93 kB.
 */

import type { Box } from '../layout/index.js';
import type { Element } from './index.js';

/** Whether a point is inside a rectangle. */
export function contains(area: Box, x: number, y: number): boolean {
	return x >= area.x && y >= area.y && x < area.x + area.width && y < area.y + area.height;
}

/**
 * A box's children in the order they are painted.
 *
 * `z-index` then document order, which is CSS's rule for flex items -- and every
 * child here is one, since `display: flex` is the initial value and the only other
 * one is `none`. So the property applies to all of them rather than to positioned
 * boxes alone, which is both simpler to say and what CSS says for this layout mode.
 *
 * Sorted stably, so children that share a `z-index` keep the order they were
 * written in: the ordering is a way to lift one box over another, not a way to
 * shuffle everything that did not ask.
 *
 * What this does *not* do is let a descendant escape its ancestor. A child with a
 * non-zero `z-index` is painted as a unit -- its own subtree is ordered inside it
 * and cannot reach out past its siblings -- which is a stacking context by another
 * name, and it is what stops `z-index` becoming a global free-for-all that every
 * component fights over with bigger integers.
 *
 * @param element - The parent.
 * @returns Its children, in paint order.
 */
export function paintOrder(element: Element): readonly Element[] {
	const children = element.children;
	// the common case is that nobody asked, and sorting a few hundred children per
	// frame to discover that is work a frame does not need
	if (!children.some((child) => child.style.zIndex !== 0)) {
		return children;
	}
	return [...children].sort((a, b) => a.style.zIndex - b.style.zIndex);
}

/**
 * The element under a point, in the canvas's own coordinates.
 *
 * Two things it honours, both of which already existed somewhere:
 *
 * - **the clip.** A box clipped by an ancestor's `overflow` is not hittable where
 *   it is clipped, and the rectangle it asks about is the one `arrange()` wrote
 *   onto the element, which is the same one paint drew inside.
 * - **`visibility: hidden`**, which skips the element and not its subtree, the way
 *   paint does -- because `visibility` inherits, so a descendant that sets
 *   `visible` is on screen and is hittable whatever its parent said.
 *
 * A box with no background is hittable, which is CSS: transparent is not absent.
 * There is no `pointer-events` here to say otherwise, deliberately -- nothing
 * needs one yet, and a property that parses and does nothing is worse than one
 * that does not exist.
 *
 * @param root - The root element, already arranged.
 * @param x - The column, zero-based, relative to the canvas.
 * @param y - The row, zero-based, relative to the canvas.
 * @returns The topmost element containing the point, or `undefined`.
 */
export function hitTest(root: Element, x: number, y: number): Element | undefined {
	const walk = (element: Element): Element | undefined => {
		const area = element.box;
		if (!area || element.style.display === 'none') {
			// a subtree that was never laid out is not on screen to be hit
			return undefined;
		}

		// children first, and backwards: the last child painted is the one on top.
		// Asked before this element's own box rather than after, and *not* gated on
		// the point being inside this one -- a child with `overflow: visible` is
		// drawn outside its parent and is hittable there, which is the whole reason
		// the clip is a separate question from the box
		const children = paintOrder(element);
		for (let i = children.length - 1; i >= 0; i--) {
			const found = walk(children[i]);
			if (found) {
				return found;
			}
		}

		if (element.style.visibility === 'hidden') {
			return undefined;
		}
		if (!contains(area, x, y)) {
			return undefined;
		}
		if (element.clip && !contains(element.clip, x, y)) {
			return undefined;
		}
		return element;
	};

	return walk(root);
}

/**
 * An element and every ancestor above it, innermost first.
 *
 * What `:hover` is set on, because in CSS the pointer is inside every box that
 * contains it rather than only the innermost -- a `.row:hover` rule has to match
 * the row when the pointer is over the text inside it. It is also what
 * `mouseenter` and `mouseleave` are worked out from, since what was entered is
 * the difference between two of these.
 *
 * @param element - The innermost element, or nothing.
 * @returns The chain, innermost first. Empty for nothing.
 */
export function ancestry(element: Element | undefined): Element[] {
	const chain: Element[] = [];
	for (let at = element; at; at = at.parent) {
		chain.push(at);
	}
	return chain;
}
