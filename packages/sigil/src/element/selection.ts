/**
 * Which cells of a painted frame may be copied, read off the arranged tree.
 *
 * The one thing a selection over the grid cannot answer for itself. A selection
 * is two cells and the text between them -- the canvas's own model, chosen
 * because flexbox has no reading order -- and `raw` cells are the case where
 * that is wrong without help: a sparkline or a half-block image is a wall of
 * block characters that nobody wants in their clipboard. So the tree says which
 * cells hold copyable content and the grid does the rest.
 *
 * A **mask over the grid** rather than a question asked per cell. Hit-testing
 * every selected cell would be the tree walked once per cell; this is one walk
 * per frame with a `Uint8Array` behind it, and the answer is a plain predicate
 * so that `canvas/selection.ts` needs to know nothing about elements.
 */

import type { Box } from '../layout/index.js';
import { paintOrder } from './hit.js';
import type { Element } from './index.js';

/** Whether a cell may be copied, which is what the canvas asks. */
export type Selectable = (x: number, y: number) => boolean;

/** What a `selectable` nobody wrote means, per host type. */
function defaultFor(element: Element, inherited: boolean): boolean {
	// `raw` paints its own cells and they are usually not text: a plot's braille,
	// an image's half blocks. `box` and `text` inherit, so a `selectable={false}`
	// on a pane reaches the texts inside it without this having to know about
	// panes.
	//
	// `drawsText` is a raw saying it is the other kind -- characters somebody is
	// reading rather than a picture -- and such a raw inherits exactly as a text
	// does. Which is what the decrypt component needs, and what it could not have
	// while the only way to be copyable was `selectable={true}`: that is an answer
	// rather than a default, so it stopped an ancestor's `selectable={false}`
	// reaching the block at all. The condition is the raw's own claim and not the
	// property, so a sheet still cannot decide what may be copied
	return element.type === 'raw' && !element.drawsText ? false : inherited;
}

/** The rectangle two boxes both allow. */
function clipped(area: Box, clip: Box | undefined): Box {
	if (!clip) {
		return area;
	}
	const x = Math.max(area.x, clip.x);
	const y = Math.max(area.y, clip.y);
	return {
		height: Math.max(0, Math.min(area.y + area.height, clip.y + clip.height) - y),
		width: Math.max(0, Math.min(area.x + area.width, clip.x + clip.width) - x),
		x,
		y,
	};
}

/**
 * Which cells of a frame hold content that may be copied.
 *
 * Only `text` and `raw` write to the mask, and that is the decision worth
 * knowing: they are the two host types that draw *content*, so the last one
 * painted at a cell is what decides. A `box` only passes inheritance down. The
 * alternative -- every element stamping its own box -- is wrong for a
 * transparent box overlapping a `raw`: it paints nothing there, the sparkline is
 * still what is on screen, and it would have marked those cells copyable.
 *
 * What that leaves outside the question is a box's background and its border,
 * which are always copyable. They are blanks and box-drawing characters, which
 * is what a terminal's own selection hands over too, and trailing blanks are
 * dropped per line in any case -- so `selectable` means content rather than
 * decoration.
 *
 * In paint order, so a `z-index` overlay decides for the cells it covers.
 *
 * @param root - The root element, already arranged.
 * @param width - The grid's width.
 * @param height - The grid's height.
 * @returns A predicate, or `undefined` where every cell may be copied -- which
 *   is a fast path rather than a claim: a tree with no `raw` and no `selectable`
 *   has nothing to exclude, and a mask of all ones is one allocation and a
 *   lookup per cell to say so.
 */
export function selectableAt(root: Element, width: number, height: number): Selectable | undefined {
	if (width <= 0 || height <= 0) {
		return undefined;
	}

	let mask: Uint8Array | undefined;

	const write = (area: Box, clip: Box | undefined, allowed: boolean): void => {
		if (allowed && !mask) {
			// nothing has been excluded yet, so there is nothing for a `true` to put
			// back: the mask is only built once something says no
			return;
		}
		const box = clipped(area, clip);
		if (box.width <= 0 || box.height <= 0) {
			return;
		}
		mask ??= new Uint8Array(width * height).fill(1);

		const left = Math.max(0, box.x);
		const top = Math.max(0, box.y);
		const right = Math.min(width, box.x + box.width);
		const bottom = Math.min(height, box.y + box.height);
		for (let y = top; y < bottom; y++) {
			mask.fill(allowed ? 1 : 0, y * width + left, y * width + right);
		}
	};

	const walk = (element: Element, inherited: boolean): void => {
		if (element.style.display === 'none') {
			// never laid out, so nothing of it is on screen to be copied
			return;
		}

		const allowed = element.selectable ?? defaultFor(element, inherited);

		if (
			(element.type === 'text' || element.type === 'raw') &&
			element.style.visibility !== 'hidden'
		) {
			const area = element.content ?? element.box;
			if (area) {
				write(area, element.clip, allowed);
			}
		}

		for (const child of paintOrder(element)) {
			walk(child, allowed);
		}
	};

	walk(root, true);

	if (!mask) {
		return undefined;
	}
	const bits = mask;
	return (x: number, y: number) =>
		x >= 0 && y >= 0 && x < width && y < height ? bits[y * width + x] === 1 : false;
}
