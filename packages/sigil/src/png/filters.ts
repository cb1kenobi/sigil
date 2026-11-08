/**
 * The five scanline filters, in both directions.
 *
 * A filter is chosen per row and turns each byte into its difference from a
 * prediction -- the byte to the left, the one above, their average, or the
 * Paeth predictor of the three neighbours. "Left" is one *pixel* back rather
 * than one byte, rounded up to a whole byte for depths under 8, which is
 * `unit`. Every neighbour off the edge of the image is zero, including the row
 * above the first one.
 */

export const NONE = 0;
export const SUB = 1;
export const UP = 2;
export const AVERAGE = 3;
export const PAETH = 4;

/** The specification's Paeth predictor: whichever neighbour is nearest `a + b - c`. */
export function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) {
    return a;
  }
  return pb <= pc ? b : c;
}

/**
 * Reverses one row's filter in place. `row` is the filtered bytes and `prior`
 * the already reconstructed row above, or `undefined` for a pass's first row.
 * Returns `false` for a filter type the specification does not define, so the
 * caller can say which row it was.
 */
export function unfilter(
  type: number,
  row: Uint8Array,
  prior: Uint8Array | undefined,
  unit: number
): boolean {
  const n = row.length;
  switch (type) {
    case NONE:
      return true;
    case SUB:
      for (let i = unit; i < n; i++) {
        row[i] = (row[i] + row[i - unit]) & 0xff;
      }
      return true;
    case UP:
      if (prior) {
        for (let i = 0; i < n; i++) {
          row[i] = (row[i] + prior[i]) & 0xff;
        }
      }
      return true;
    case AVERAGE:
      for (let i = 0; i < n; i++) {
        const left = i >= unit ? row[i - unit] : 0;
        const up = prior ? prior[i] : 0;
        row[i] = (row[i] + ((left + up) >> 1)) & 0xff;
      }
      return true;
    case PAETH:
      for (let i = 0; i < n; i++) {
        const left = i >= unit ? row[i - unit] : 0;
        const up = prior ? prior[i] : 0;
        const corner = prior && i >= unit ? prior[i - unit] : 0;
        row[i] = (row[i] + paeth(left, up, corner)) & 0xff;
      }
      return true;
    default:
      return false;
  }
}

/**
 * Applies `type` to `row` against `prior`, writing the filtered bytes into
 * `out`. The encoder's half: `out` is a separate buffer because the
 * unfiltered row is still needed as the next row's `prior`.
 */
export function filter(
  type: number,
  row: Uint8Array,
  prior: Uint8Array | undefined,
  unit: number,
  out: Uint8Array
): void {
  const n = row.length;
  for (let i = 0; i < n; i++) {
    const left = i >= unit ? row[i - unit] : 0;
    const up = prior ? prior[i] : 0;
    let predicted: number;
    switch (type) {
      case SUB:
        predicted = left;
        break;
      case UP:
        predicted = up;
        break;
      case AVERAGE:
        predicted = (left + up) >> 1;
        break;
      case PAETH:
        predicted = paeth(left, up, prior && i >= unit ? prior[i - unit] : 0);
        break;
      default:
        predicted = 0;
    }
    out[i] = (row[i] - predicted) & 0xff;
  }
}
