/**
 * An image as the codec hands it over and takes it back: 8-bit RGBA, row-major,
 * top row first, four bytes per pixel and no padding between rows -- so
 * `data.length` is always `width * height * 4`, and pixel `(x, y)` starts at
 * `(y * width + x) * 4`.
 *
 * Alpha is straight rather than premultiplied, which is what a PNG stores.
 */
export interface RgbaImage {
  width: number;
  height: number;
  data: Uint8Array;
}

export interface AssertRgbaImageOptions {
  /**
   * Who is asking, which every message opens with: `encodePng()`,
   * `resampleImage()`. Defaults to `an RgbaImage`.
   */
  name?: string;
  /**
   * The smallest width and height allowed. Defaults to 0, because an empty
   * picture is a picture -- it is a PNG that cannot be one, so `encodePng()`
   * asks for 1.
   */
  min?: number;
}

/**
 * Throws a `TypeError` unless `image` is an {@link RgbaImage}: a width and a
 * height that are whole numbers from `min` to 2^31-1, and `data` that is a
 * `Uint8Array` -- or a `Uint8ClampedArray`, which is what a canvas hands back
 * and is the same bytes -- of exactly `width * height * 4` bytes.
 *
 * The one check of the shape both directions of the codec use and everything
 * that reads pixels shares, so that what counts as a picture cannot differ
 * between the encoder and whatever draws one. Refused rather than read as far
 * as it goes: a `data` one row short reads as `undefined`, which arithmetic
 * turns into a `NaN` that something else then throws about, far from the
 * mistake. Anything quoted from the argument has its control characters
 * escaped, because the message is printed to a terminal.
 *
 * The ceiling is IHDR's -- a chunk length, and so a PNG dimension, stops at
 * 2^31-1 -- and is no limit on a picture in practice: one that wide and a pixel
 * tall is eight gigabytes of `data`.
 */
export function assertRgbaImage(
  image: unknown,
  options: AssertRgbaImageOptions = {}
): asserts image is RgbaImage {
  const name = options.name ?? 'an RgbaImage';
  const min = options.min ?? 0;
  const { height, width } = (image ?? {}) as Partial<Record<'height' | 'width', unknown>>;
  const input: unknown = (image as { data?: unknown } | undefined)?.data;

  const dimension = (n: unknown): n is number =>
    Number.isInteger(n) && (n as number) >= min && (n as number) <= MAX_DIMENSION;
  if (!dimension(width) || !dimension(height)) {
    throw new TypeError(
      `${name} expects a width and height that are whole numbers from ${min} to ${MAX_DIMENSION}, got ${quote(width)}x${quote(height)}`
    );
  }
  if (!(input instanceof Uint8Array || input instanceof Uint8ClampedArray)) {
    throw new TypeError(`${name} expects data to be a Uint8Array, got ${describe(input)}`);
  }
  if (input.length !== width * height * 4) {
    throw new TypeError(
      `${name} expects ${width * height * 4} bytes of data for ${width}x${height} RGBA, got ${input.length}`
    );
  }
}

/**
 * The largest width or height, and the largest chunk: the PNG specification
 * caps both at 2^31-1. Defined here rather than in `chunks.ts`, which reads it
 * from here, because that module imports `node:zlib` for its CRC and this one
 * is what `@ttylabs/sigil/canvas` imports to check a picture -- a canvas that
 * resamples pixels has no business loading zlib to do it.
 */
export const MAX_DIMENSION = 0x7fffffff;

/**
 * A value as an error message may quote it. The caller wrote it, but a CLI's
 * error handler prints it, so a control character in it -- a string width, a
 * `Symbol.toStringTag` -- is escaped the way the decoder names a chunk type in
 * hex: `ESC [ 2 J` in a message clears the terminal of whoever reads it.
 */
function quote(value: unknown): string {
  return String(value).replaceAll(
    /\p{Cc}/gu,
    (c) => `\\x${c.charCodeAt(0).toString(16).padStart(2, '0')}`
  );
}

function describe(value: unknown): string {
  return quote(
    typeof value === 'object' ? Object.prototype.toString.call(value).slice(8, -1) : typeof value
  );
}
