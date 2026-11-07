/**
 * `@ttylabs/sigil/png`: a PNG codec with no dependency beyond `node:zlib`.
 *
 * Decoding is what lets an image be drawn at all, and encoding is what a
 * screenshot writes. Both go through one shape, {@link RgbaImage}, so raw RGBA
 * is also the way in for any other format: a caller holding a JPEG brings its
 * own decoder and hands this the pixels.
 */
export { decodePng, MAX_PIXELS, type DecodePngOptions } from './decode.js';
export { encodePng } from './encode.js';
export type { RgbaImage } from './image.js';
