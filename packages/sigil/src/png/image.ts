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
