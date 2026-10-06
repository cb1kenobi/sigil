/**
 * A grid to composite over the frame, and what decides which of its cells show.
 *
 * A canvas paints one grid. A layer is a second one, plus where its top-left
 * sits relative to the canvas's -- which is exactly the thing the canvas is
 * allowed to know and the screen position is not. "A canvas is a rect plus an
 * anchor, and it does not know its anchor" is about the *screen*; a layer's
 * origin is canvas-relative, so it is a number this module can have.
 *
 * Nothing below the composite changes. `diff()` sees `front` against `back` and
 * has no idea how `back` got its contents, so this is a pass at the end of
 * `paint()` and the wire is whatever the diff makes of the result.
 */

import { type CellBuffer, CONTINUATION } from './buffer.js';
import { type Mask, masked } from './mask.js';

/**
 * A grid composited over the frame.
 *
 * Screen-sized or a sub-rect is the same object with a different buffer and a
 * different origin; there is no second shape for "a small layer".
 */
export interface Layer {
	/** The grid. Its own size is the layer's size. */
	cells: CellBuffer;
	/**
	 * Which of its cells show, or every occupied one when there is none.
	 *
	 * The mask's coordinates are the layer's own, not the canvas's: a mask is
	 * generated for a rectangle and the layer is what says where that rectangle
	 * went, so moving a layer does not invalidate its mask.
	 */
	mask?: Mask;
	/** Where its left edge sits, relative to the canvas's. */
	x: number;
	/** Where its top edge sits. */
	y: number;
}

/**
 * Composites one layer over a grid, by replaying `put()`.
 *
 * **This is the sharp edge of the whole feature.** Copying the typed arrays
 * across is faster and leaves half-glyphs on screen: a layer cell landing on a
 * wide cluster below has to take that cluster's *other half* with it, or the
 * terminal is told to draw half a character and every column after it on the row
 * is shifted. `put()` already does that repair -- it is `#breakCluster()`, and it
 * is why the grid owns it -- so the composite goes through `put()` and gets the
 * repair, the clipping at both grids' edges and the refusal of a wide cluster
 * with no room for its continuation for nothing.
 *
 * A continuation is skipped rather than written. `put()` would refuse it anyway,
 * since `cellWidth('')` is zero, so the skip is a statement rather than a guard:
 * a cluster is written once, by its lead, which is what writes both of its cells.
 *
 * The walk is over the **layer's** own cells rather than over the overlap, so a
 * layer much larger than the canvas pays for cells it cannot show. Left that way
 * deliberately: clamping the loop bounds to the destination changes no answer --
 * a cell `put()` would refuse is one the clamp skips, including a wide cluster
 * whose lead lands one column off either edge -- so it would be a guard nothing
 * can observe, and the honest answer is that a layer's own size is the layer's
 * size. A snapshot is canvas-sized by construction and a sprite is small; a
 * ten-thousand-row layer over a twenty-four-row canvas is a layer to size
 * differently rather than a loop to narrow.
 *
 * Which is also where the mask is sampled -- **once per cluster, at its lead**.
 * A wide cluster is atomic: either both of its columns composite or neither
 * does, because revealing one is revealing half a character. That is the rule
 * `Painter.overlay()` already keeps for the same reason, and it means a mask
 * whose threshold falls between a cluster's two cells does not split it.
 *
 * @param dest - The grid to composite onto.
 * @param layer - The layer.
 */
export function composite(dest: CellBuffer, layer: Layer): void {
	const src = layer.cells;
	if (src === dest) {
		// refused rather than copied around, because a grid composited onto itself
		// is not a thing anybody means and what it did instead is unreadable: the
		// walk reads and writes the same arrays left to right, so a layer at
		// `x: 1` reads the cell it wrote one column ago and smears the row --
		// `['A','B','C']` came out `['A','A','A']`. A copy per row would make the
		// aliasing *work*, which is inventing a feature; a throw names the mistake
		// where it was made. Reachable because `Canvas.cells` and `Canvas.layers`
		// are both public, and `cells` is documented for reading
		throw new TypeError('Cannot composite a grid onto itself');
	}
	const chars = src.rawChars();
	const styles = src.rawStyles();
	const occupied = src.rawOccupied();
	const { mask } = layer;
	const width = src.width;
	const height = src.height;

	for (let y = 0; y < height; y++) {
		const row = y * width;
		for (let x = 0; x < width; x++) {
			const index = row + x;
			if (occupied[index] === 0) {
				// nothing painted here, which is the one question the characters and
				// the styles cannot answer between them: a blank in the default style
				// is what `clear()` leaves and also what a filled panel is made of
				continue;
			}

			const cluster = chars[index];
			if (cluster === CONTINUATION) {
				continue;
			}

			if (mask && !masked(mask, x, y)) {
				continue;
			}

			dest.put(x + layer.x, y + layer.y, cluster, styles[index]);
		}
	}
}

/**
 * Composites a stack of layers, bottom first.
 *
 * Array order *is* paint order, so the last entry is on top -- which is the
 * reading `z-index`-free document order already has everywhere else in this
 * library, and the one that makes "push a layer" mean "put it in front".
 *
 * @param dest - The grid.
 * @param layers - The stack.
 */
export function compositeAll(dest: CellBuffer, layers: readonly Layer[]): void {
	for (const layer of layers) {
		composite(dest, layer);
	}
}
