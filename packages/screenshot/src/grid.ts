import { CONTINUATION, DEFAULT_STYLE, type Style } from '@ttylabs/sigil/canvas';

/**
 * What a screenshot reads: a grid of cells, whatever held them.
 *
 * Two things hold a frame. `canvas.snapshot()` is a `CellBuffer` bound to the
 * style table that painted it, so every cell says what it looks like. The
 * testing `Screen` is a terminal model that keeps characters and no styling at
 * all -- it is replayed from the bytes a backend wrote, and its own header says
 * colour is not something to assert against it -- so a screenshot of one is the
 * text in the default colours, which is still the thing a test wants to save
 * when it fails.
 *
 * Both are read structurally rather than by `instanceof`: an app that ends up
 * with two copies of `@ttylabs/sigil` installed has two `CellBuffer` classes,
 * and a screenshot is not the place to discover that.
 */

/** A `CellBuffer`, as far as a screenshot reads one. */
export interface CellGrid {
  readonly height: number;
  readonly width: number;
  /** The grapheme in a cell, `''` for the far half of a wide one. */
  charAt(x: number, y: number): string;
  /** The style a cell is drawn in, or `undefined` when the grid cannot say. */
  cellStyle(x: number, y: number): Style | undefined;
  /** The style index, for a grid whose styles come from `options.styles`. */
  styleAt(x: number, y: number): number;
}

/** A testing `Screen`, as far as a screenshot reads one. */
export interface ScreenGrid {
  readonly height: number;
  readonly width: number;
  /** The grapheme in a cell, `''` for the far half of a wide one. */
  cellAt(column: number, row: number): string | undefined;
}

/** Anything a screenshot can be taken of. */
export type Shootable = CellGrid | ScreenGrid;

/** Something that resolves a style index, which a `StyleTable` is. */
export interface StyleLookup {
  get(index: number): Style;
}

/** One cell as a screenshot draws it. */
export interface ShotCell {
  /** The grapheme cluster, or `''` on the far half of a wide one. */
  readonly char: string;
  readonly style: Style;
  /** How many cells it spans: `0` for a continuation, `1`, or `2`. */
  readonly width: 0 | 1 | 2;
}

/** The frame, read. */
export interface Shot {
  readonly cells: readonly ShotCell[];
  readonly height: number;
  readonly width: number;
}

/** The most cells a screenshot reads. */
const MAX_CELLS = 4096 * 4096;

function isCellGrid(input: Shootable): input is CellGrid {
  return (
    typeof (input as CellGrid).charAt === 'function' &&
    typeof (input as CellGrid).styleAt === 'function'
  );
}

function isScreenGrid(input: Shootable): input is ScreenGrid {
  return typeof (input as ScreenGrid).cellAt === 'function';
}

/**
 * Reads every cell of a frame.
 *
 * A wide cluster is whatever its next cell says it is: a lead followed by a
 * continuation spans two cells. That is the grid's own record rather than a
 * width recomputed here, so a screenshot never disagrees with the frame about
 * where a column is -- and a lead whose continuation was lost at the right edge
 * is drawn in the one cell it has.
 *
 * @param input - The frame.
 * @param styles - What resolves a style index on a grid that is not bound.
 * @returns The cells, row by row.
 */
export function readShot(input: Shootable, styles?: StyleLookup): Shot {
  if (input === null || typeof input !== 'object') {
    throw new TypeError('Expected a CellBuffer from canvas.snapshot() or a testing Screen');
  }
  const width = input.width;
  const height = input.height;
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 0 || height < 0) {
    throw new TypeError(`Invalid grid size ${String(width)}x${String(height)}`);
  }
  // a grid this big is not a terminal: 4096 by 4096 cells is a terminal some
  // 32,000 pixels across at the default size, and every cell is read before
  // either format can say the image is too large
  if (width * height > MAX_CELLS) {
    throw new RangeError(`A grid of ${width}x${height} cells is too large to screenshot`);
  }

  let charAt: (x: number, y: number) => string;
  let styleAt: (x: number, y: number) => Style;
  if (isCellGrid(input)) {
    charAt = (x, y) => input.charAt(x, y);
    styleAt = (x, y) => {
      const bound = typeof input.cellStyle === 'function' ? input.cellStyle(x, y) : undefined;
      if (bound) {
        return bound;
      }
      const index = input.styleAt(x, y);
      if (styles) {
        return styles.get(index);
      }
      // the default is index 0 in every table there is, so it needs no table
      if (index === 0) {
        return DEFAULT_STYLE;
      }
      throw new TypeError(
        'This grid cannot say what its styles are: pass canvas.snapshot(), or the StyleTable it ' +
          'was painted with as `styles`'
      );
    };
  } else if (isScreenGrid(input)) {
    charAt = (x, y) => input.cellAt(x, y) ?? ' ';
    styleAt = () => DEFAULT_STYLE;
  } else {
    throw new TypeError('Expected a CellBuffer from canvas.snapshot() or a testing Screen');
  }

  const cells: ShotCell[] = [];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const char = charAt(x, y);
      if (char === CONTINUATION) {
        cells.push({ char, style: styleAt(x, y), width: 0 });
        continue;
      }
      const wide = x + 1 < width && charAt(x + 1, y) === CONTINUATION;
      cells.push({ char, style: styleAt(x, y), width: wide ? 2 : 1 });
    }
  }
  return { cells, height, width };
}
