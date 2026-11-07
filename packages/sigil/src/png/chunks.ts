/**
 * What the decoder and the encoder agree on: the signature, the colour types,
 * and how a chunk's CRC is computed.
 *
 * `zlib.crc32()` is core on the `engines` floor (node >=22.19), and it is the
 * CRC the PNG specification names -- ISO 3309, the same polynomial zlib's gzip
 * framing uses -- so a table of our own would be a second answer to a question
 * node already answers.
 */
import { crc32 } from 'node:zlib';

/** `\x89PNG\r\n\x1A\n`, written as numbers so that no control byte sits in source. */
export const SIGNATURE: Uint8Array = Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);

/** The five colour types, by the number IHDR writes. */
export const GREY = 0;
export const RGB = 2;
export const INDEXED = 3;
export const GREY_ALPHA = 4;
export const RGBA = 6;

/** How many samples one pixel of a colour type carries. */
export const CHANNELS: Readonly<Record<number, number>> = {
  [GREY]: 1,
  [RGB]: 3,
  [INDEXED]: 1,
  [GREY_ALPHA]: 2,
  [RGBA]: 4,
};

/** The bit depths each colour type allows, from the specification's table. */
export const DEPTHS: Readonly<Record<number, readonly number[]>> = {
  [GREY]: [1, 2, 4, 8, 16],
  [RGB]: [8, 16],
  [INDEXED]: [1, 2, 4, 8],
  [GREY_ALPHA]: [8, 16],
  [RGBA]: [8, 16],
};

/** The largest length a chunk may declare: 2^31 - 1, so it fits a signed int. */
export const MAX_CHUNK_LENGTH = 0x7fffffff;

/**
 * The CRC of a chunk, which covers its type and its data but not its length.
 * `type` and `data` are views into one buffer on the way in and two buffers on
 * the way out, so it is computed in two calls rather than over a copy.
 */
export function chunkCrc(type: Uint8Array, data: Uint8Array): number {
  return crc32(data, crc32(type));
}

/**
 * The bytes one scanline of `width` pixels occupies, without its filter byte.
 * In doubles rather than with bit operators, because a width near 2^31 times
 * 64 bits overflows an int32 long before it overflows a double.
 */
export function rowBytes(width: number, bitsPerPixel: number): number {
  return Math.ceil((width * bitsPerPixel) / 8);
}

/**
 * The seven Adam7 passes as `[x0, y0, dx, dy]`: where each pass starts and how
 * far apart its pixels are. A non-interlaced image is the one pass `[0, 0, 1, 1]`.
 */
export const ADAM7: readonly (readonly [number, number, number, number])[] = [
  [0, 0, 8, 8],
  [4, 0, 8, 8],
  [0, 4, 4, 8],
  [2, 0, 4, 4],
  [0, 2, 2, 4],
  [1, 0, 2, 2],
  [0, 1, 1, 2],
];

/** The single pass a non-interlaced image is. */
export const PROGRESSIVE: readonly (readonly [number, number, number, number])[] = [[0, 0, 1, 1]];

/** How many pixels across and down one pass covers. A pass can be empty. */
export function passSize(
  width: number,
  height: number,
  [x0, y0, dx, dy]: readonly [number, number, number, number]
): [number, number] {
  return [Math.max(0, Math.ceil((width - x0) / dx)), Math.max(0, Math.ceil((height - y0) / dy))];
}
