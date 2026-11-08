/**
 * Resampling a picture to the size it is drawn at.
 *
 * `Pixels` is a grid of colours one across and two down per cell, and a picture
 * almost never arrives at that size: a 1920-wide photograph into eighty columns
 * is a downscale of 24 across and, at two pixels per cell row, of about forty
 * down. Nearest-neighbour at that ratio reads one source pixel in every few
 * hundred and draws noise. A box filter -- every source pixel that lands in a
 * destination pixel, averaged by how much of it lands there -- is the right
 * filter for a large downscale, and it is the whole of what this module does.
 *
 * The cell's aspect is not this module's business, and that is what keeps it
 * one function: a `Pixels` pixel is half a cell tall and one cell wide, which a
 * terminal cell about twice as tall as it is wide makes square, so a picture
 * resampled to `columns` by `rows * 2` pixels is a picture drawn at its own
 * proportions. The arithmetic of fitting one into a box lives with the
 * component that has a box.
 *
 * The picture is `RgbaImage`, the shape `@ttylabs/sigil/png` decodes to and
 * the one a caller bringing their own decoder hands in, checked by the codec's
 * own `assertRgbaImage()`: one definition of both, in the codec.
 */

// from the module rather than the subpath's barrel: the barrel is the codec,
// about 10 kB that checking a shape has no use for
import { assertRgbaImage, type RgbaImage } from '../png/image.js';

/** A rectangle of a picture, in its pixels. It may be fractional. */
export interface ImageRect {
  height: number;
  width: number;
  x: number;
  y: number;
}

/**
 * Which source pixels one destination pixel covers along one axis, and how much
 * of each.
 *
 * Fractional at both ends, which is the half of a box filter that a sum over
 * whole pixels gets wrong: 1,002 rows into 48 is 20.875 a row, so most
 * destination rows start and end part of the way through a source row, and
 * counting that row whole in both of them weights it twice.
 */
interface Span {
  /** The first source index. */
  first: number;
  /** How much each source index from `first` contributes, summing to one. */
  weights: Float64Array;
}

/**
 * The spans for one axis.
 *
 * @param start - Where the region being resampled starts, in source pixels.
 * @param length - How long it is, in source pixels.
 * @param size - How many source pixels the axis has, which bounds the reads.
 * @param count - How many destination pixels it becomes.
 * @returns One span per destination pixel.
 */
function spans(start: number, length: number, size: number, count: number): Span[] {
  const scale = length / count;
  const out: Span[] = [];

  for (let i = 0; i < count; i++) {
    const from = Math.max(0, start + i * scale);
    const to = Math.min(size, start + (i + 1) * scale);
    const first = Math.min(size - 1, Math.floor(from));
    // an upscale makes a destination pixel narrower than a source one, and a
    // destination pixel narrower than a sliver can round to an empty interval;
    // it still lands *somewhere*, and that somewhere is the pixel it is inside
    const last = Math.max(first + 1, Math.min(size, Math.ceil(to)));
    const weights = new Float64Array(last - first);

    let total = 0;
    for (let j = first; j < last; j++) {
      const w = Math.max(0, Math.min(to, j + 1) - Math.max(from, j));
      weights[j - first] = w;
      total += w;
    }
    if (total === 0) {
      weights[0] = 1;
      total = 1;
    }
    for (let k = 0; k < weights.length; k++) {
      weights[k] /= total;
    }

    out.push({ first, weights });
  }

  return out;
}

/**
 * Resamples a picture, or a rectangle of one, to a size, with a box filter.
 *
 * Every destination pixel is the average of the source pixels under it, each
 * weighted by how much of it is under it -- which at a large downscale is the
 * correct filter rather than merely a cheap one, and at an upscale degenerates
 * into the nearest pixel blended with its neighbour across a seam. Done in two
 * passes, across and then down, so a 1920x1080 photograph costs one read of
 * each source pixel rather than one per destination pixel it touches.
 *
 * **Averaged premultiplied.** A transparent pixel still has a colour in its
 * three bytes, usually black, and averaging those straight drags every edge of
 * a cut-out towards it -- the dark fringe round a resized logo. Weighting each
 * colour by its own alpha is what makes a pixel that is not there contribute
 * nothing but its transparency. What comes back is straight alpha again, which
 * is the shape that went in.
 *
 * @param image - The picture.
 * @param width - The width to resample to, in pixels.
 * @param height - The height to resample to, in pixels.
 * @param from - The rectangle of the picture to resample. All of it, if omitted;
 *   clamped to the picture where it reaches past an edge.
 * @returns A new picture of exactly `width` by `height`.
 * @throws A `TypeError` for a picture that is not an `RgbaImage`, which is
 *   `assertRgbaImage()`'s, and a `RangeError` for a size to resample to that is
 *   not a whole number of pixels.
 */
export function resampleImage(
  image: RgbaImage,
  width: number,
  height: number,
  from?: ImageRect
): RgbaImage {
  assertRgbaImage(image, { name: 'resampleImage()' });
  if (!Number.isSafeInteger(width) || width < 0 || !Number.isSafeInteger(height) || height < 0) {
    throw new RangeError(
      `Invalid resample size ${String(width)}x${String(height)}: expected whole numbers of pixels`
    );
  }

  const data = new Uint8Array(width * height * 4);
  if (width === 0 || height === 0 || image.width === 0 || image.height === 0) {
    return { data, height, width };
  }

  const region = clampRect(from, image);
  const across = spans(region.x, region.width, image.width, width);
  const down = spans(region.y, region.height, image.height, height);

  // only the source rows some destination row reads are resampled across: a
  // crop of the middle third reads the middle third
  const rowFirst = down[0].first;
  const rowLast = down[height - 1].first + down[height - 1].weights.length;
  const rows = rowLast - rowFirst;

  // premultiplied red, green and blue, then alpha, per destination column per
  // source row. Float32 because the next pass is a weighted sum of these and
  // rounding to bytes in between is a second quantization nobody asked for
  const wide = new Float32Array(rows * width * 4);
  const source = image.data;
  const stride = image.width * 4;

  for (let row = 0; row < rows; row++) {
    const base = (rowFirst + row) * stride;
    for (let x = 0; x < width; x++) {
      const { first, weights } = across[x];
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let k = 0; k < weights.length; k++) {
        const at = base + (first + k) * 4;
        const alpha = source[at + 3] * weights[k];
        r += source[at] * alpha;
        g += source[at + 1] * alpha;
        b += source[at + 2] * alpha;
        a += alpha;
      }
      const out = (row * width + x) * 4;
      wide[out] = r;
      wide[out + 1] = g;
      wide[out + 2] = b;
      wide[out + 3] = a;
    }
  }

  for (let y = 0; y < height; y++) {
    const { first, weights } = down[y];
    for (let x = 0; x < width; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let k = 0; k < weights.length; k++) {
        const at = ((first - rowFirst + k) * width + x) * 4;
        const w = weights[k];
        r += wide[at] * w;
        g += wide[at + 1] * w;
        b += wide[at + 2] * w;
        a += wide[at + 3] * w;
      }
      const out = (y * width + x) * 4;
      // a pixel nothing opaque landed in has no colour to un-premultiply, and
      // black is what a transparent pixel conventionally carries
      if (a > 0) {
        data[out] = byte(r / a);
        data[out + 1] = byte(g / a);
        data[out + 2] = byte(b / a);
      }
      data[out + 3] = byte(a);
    }
  }

  return { data, height, width };
}

/**
 * A rectangle of the picture, inside it.
 *
 * @param rect - What was asked for, if anything.
 * @param image - The picture it is a rectangle of.
 * @returns The part of it the picture has.
 * @throws A `RangeError` for a rectangle with nothing of the picture in it,
 *   which has no pixels to average and so no answer that is not invented.
 */
function clampRect(rect: ImageRect | undefined, image: RgbaImage): ImageRect {
  if (rect === undefined) {
    return { height: image.height, width: image.width, x: 0, y: 0 };
  }
  const x = Math.max(0, rect.x);
  const y = Math.max(0, rect.y);
  const right = Math.min(image.width, rect.x + rect.width);
  const bottom = Math.min(image.height, rect.y + rect.height);
  // asked as "is there area" rather than as four comparisons, because every one
  // of those is false for `NaN` and a rectangle of `NaN` would pass them all
  if (!(right - x > 0 && bottom - y > 0)) {
    throw new RangeError(
      `Invalid resample rectangle ${String(rect.x)},${String(rect.y)} ${String(rect.width)}x${String(rect.height)}: nothing of a ${image.width}x${image.height} image is inside it`
    );
  }
  return { height: bottom - y, width: right - x, x, y };
}

/** A channel worked out in floating point, back into a byte. */
function byte(value: number): number {
  return Math.min(255, Math.max(0, Math.round(value)));
}
