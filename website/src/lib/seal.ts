/**
 * The seal: a signet stamp cut from a 7 by 7 block of terminal cells, with one
 * channel carved through it. SIG-102 chose it and owns the geometry; this is
 * the one place the website writes it down.
 *
 * `fill-rule="evenodd"` is what cuts the channel out of the square, so the path
 * is two subpaths and relies on it. Everything on the site that draws the seal
 * reads it from here: the `Seal` component, the social cards, and
 * `scripts/brand-assets.ts`, which writes `icon.svg`, the lockups and the PNG
 * and ICO files. `icon.svg` has to be a static file for Next to pick it up, so
 * it carries a copy, and `test/brand-assets.test.ts` fails if the two differ.
 */

/** The seal's side in cells. */
export const SEAL_CELLS = 7;

/** The outer square, then the channel. */
export const SEAL_PATH = 'M0 0H7V7H0Z M1 1H5V2H2V3H6V6H2V5H5V4H1Z';

/** The subpaths of an absolute `M`, `H`, `V`, `Z` path, as polygons. */
function polygons(path: string): [number, number][][] {
  const out: [number, number][][] = [];
  let current: [number, number][] = [];
  let x = 0;
  let y = 0;
  for (const [, command, args] of path.matchAll(/([MHVZ])\s*([^MHVZ]*)/g)) {
    const [a, b] = args.trim().split(/\s+/).map(Number);
    if (command === 'M') {
      [x, y] = [a, b];
      current = [[x, y]];
    } else if (command === 'H') {
      x = a;
      current.push([x, y]);
    } else if (command === 'V') {
      y = a;
      current.push([x, y]);
    } else {
      out.push(current);
    }
  }
  return out;
}

/** Even-odd crossing count of a ray to the right of `(px, py)`. */
function inside(polygon: [number, number][], px: number, py: number) {
  let crossings = 0;
  for (let i = 0; i < polygon.length; i++) {
    const [x1, y1] = polygon[i];
    const [x2, y2] = polygon[(i + 1) % polygon.length];
    if (x1 === x2 && x1 > px && py > Math.min(y1, y2) && py < Math.max(y1, y2)) {
      crossings++;
    }
  }
  return crossings % 2 === 1;
}

/**
 * Which cells are inked, `grid[row][column]`, worked out from `SEAL_PATH` by
 * the same even-odd rule an SVG renderer applies to it. For anything that
 * draws pixels rather than paths (the favicon, the app icons), so that a
 * second copy of the shape never exists to drift from the first.
 */
export function sealGrid(): boolean[][] {
  const shapes = polygons(SEAL_PATH);
  return Array.from({ length: SEAL_CELLS }, (_, row) =>
    Array.from(
      { length: SEAL_CELLS },
      (_, column) =>
        shapes.filter((shape) => inside(shape, column + 0.5, row + 0.5)).length % 2 === 1
    )
  );
}
