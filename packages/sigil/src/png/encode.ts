import { chunkCrc, INDEXED, MAX_CHUNK_LENGTH, RGB, RGBA, rowBytes, SIGNATURE } from './chunks.js';
import { filter, NONE, PAETH } from './filters.js';
import { assertRgbaImage, type RgbaImage } from './image.js';
/**
 * Writing a PNG: 8-bit RGBA in, the smallest of the plain encodings out.
 *
 * - **Indexed whenever there are 256 colours or fewer**, counting a colour as
 *   all four channels, at the smallest bit depth that holds the palette -- 1,
 *   2, 4 or 8. A terminal screenshot drawn without anti-aliasing nearly always
 *   qualifies, and indexed was measured at **41% smaller** than truecolour on a
 *   960x640 one -- the same pixels with one row of noise put past 256 colours. Alpha goes in a `tRNS` chunk, and the palette puts its
 *   translucent entries first so that chunk stops at the last one.
 * - **Otherwise RGB, or RGBA when any pixel has alpha below 255.**
 *
 * The filter is picked per row: whichever of the five makes the smallest sum
 * of the row's bytes read as signed, the heuristic the specification suggests
 * and libpng uses. An indexed image is the exception, and is deflated twice --
 * once filtered that way and once with no filter on any row -- keeping the
 * smaller. The specification's advice for a palette is no filter, because an
 * index is a name rather than a quantity and the difference between two of
 * them predicts nothing; that is right for a screenshot, where it was measured
 * at **25% smaller** than the heuristic, and wrong for a greyscale gradient that
 * happens to fit in 256 colours, whose indices *are* quantities because the
 * palette is in the order the gradient met them. Neither rule is right for
 * both, and the second deflate costs less than guessing.
 *
 * Nothing here reads a clock, a locale or an environment, and no ancillary
 * chunk is written, so the same pixels give the same bytes: a screenshot can
 * be committed and diffed.
 */
import { constants, deflateSync } from 'node:zlib';

const encoder = new TextEncoder();

/**
 * The deflate settings, every one spelled out, so that the bytes do not move
 * if a default does. Level 6 rather than 9 because it was measured: on a
 * 960x640 screenshot, 9 was **3x slower** for **0.8% fewer bytes** indexed and
 * 1.7% truecolour, and across the whole of PngSuite 1.4%.
 */
const DEFLATE = { level: 6, memLevel: 9, strategy: constants.Z_DEFAULT_STRATEGY, windowBits: 15 };

/**
 * Encodes 8-bit RGBA as a PNG.
 *
 * Throws a `TypeError` when `image` is not one: dimensions that are not
 * positive whole numbers, or `data` that is not `width * height * 4` bytes.
 */
export function encodePng(image: RgbaImage): Uint8Array {
  // at least one pixel, because a PNG cannot be empty where a picture can
  assertRgbaImage(image, { min: 1, name: 'encodePng()' });
  // a Uint8ClampedArray is read through the same indices, so one type serves both
  const { data, height, width } = image;

  const census = countColours(data);
  const chunks: [string, Uint8Array][] = [];
  let compressed: Uint8Array;

  if (census) {
    const { palette, translucent } = census;
    const depth = palette.length <= 2 ? 1 : palette.length <= 4 ? 2 : palette.length <= 16 ? 4 : 8;
    chunks.push(['IHDR', header(width, height, depth, INDEXED)]);

    const plte = new Uint8Array(palette.length * 3);
    for (let i = 0; i < palette.length; i++) {
      plte[i * 3] = palette[i] >>> 24;
      plte[i * 3 + 1] = (palette[i] >>> 16) & 0xff;
      plte[i * 3 + 2] = (palette[i] >>> 8) & 0xff;
    }
    chunks.push(['PLTE', plte]);

    if (translucent > 0) {
      chunks.push(['tRNS', Uint8Array.from(palette.slice(0, translucent), (c) => c & 0xff)]);
    }

    // both ways, and the smaller kept: see the module comment
    const rows = indexedRows(data, width, height, depth, census.index);
    const stride = rowBytes(width, depth);
    const plain = deflateSync(filterRows(rows, stride, height, 1, false), DEFLATE);
    const adaptive = deflateSync(filterRows(rows, stride, height, 1, true), DEFLATE);
    compressed = adaptive.length < plain.length ? adaptive : plain;
  } else {
    const alpha = hasAlpha(data);
    const channels = alpha ? 4 : 3;
    chunks.push(['IHDR', header(width, height, 8, alpha ? RGBA : RGB)]);
    const rows = truecolourRows(data, width, height, alpha);
    compressed = deflateSync(filterRows(rows, width * channels, height, channels, true), DEFLATE);
  }

  for (let at = 0; at < compressed.length; at += MAX_CHUNK_LENGTH) {
    chunks.push(['IDAT', compressed.subarray(at, at + MAX_CHUNK_LENGTH)]);
  }
  chunks.push(['IEND', new Uint8Array(0)]);

  return assemble(chunks);
}

function header(width: number, height: number, depth: number, colourType: number): Uint8Array {
  const body = new Uint8Array(13);
  const view = new DataView(body.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  body[8] = depth;
  body[9] = colourType;
  // compression, filter method and interlace are all 0: deflate, the five
  // adaptive filters, and no interlacing
  return body;
}

/** The colour of the pixel at byte `p`, as one unsigned 32-bit RGBA number. */
function colourAt(data: Uint8Array, p: number): number {
  return ((data[p] << 24) | (data[p + 1] << 16) | (data[p + 2] << 8) | data[p + 3]) >>> 0;
}

interface Census {
  /** The palette in the order it is written, translucent entries first. */
  palette: number[];
  /** How many of `palette`'s leading entries have alpha below 255. */
  translucent: number;
  /** Each colour's index into `palette`. */
  index: Map<number, number>;
}

/**
 * The image's colours, or `undefined` the moment there are more than 256.
 *
 * Ordered by first appearance within each half, translucent and then opaque,
 * which is a function of the pixels alone -- so the palette, and with it every
 * byte after it, is the same for the same image.
 */
function countColours(data: Uint8Array): Census | undefined {
  const seen = new Set<number>();
  let last = -1;
  for (let p = 0; p < data.length; p += 4) {
    const c = colourAt(data, p);
    if (c !== last) {
      seen.add(c);
      if (seen.size > 256) {
        return undefined;
      }
      last = c;
    }
  }

  const all = [...seen];
  const translucent = all.filter((c) => (c & 0xff) !== 255);
  const palette = [...translucent, ...all.filter((c) => (c & 0xff) === 255)];
  const index = new Map(palette.map((c, i) => [c, i]));
  return { index, palette, translucent: translucent.length };
}

function hasAlpha(data: Uint8Array): boolean {
  for (let p = 3; p < data.length; p += 4) {
    if (data[p] !== 255) {
      return true;
    }
  }
  return false;
}

/** Packed palette indices, one row after another, not yet filtered. */
function indexedRows(
  data: Uint8Array,
  width: number,
  height: number,
  depth: number,
  index: Map<number, number>
): Uint8Array {
  const stride = rowBytes(width, depth);
  const rows = new Uint8Array(stride * height);
  const perByte = 8 / depth;

  let last = -1;
  let lastIndex = 0;
  for (let y = 0; y < height; y++) {
    const start = y * stride;
    for (let x = 0; x < width; x++) {
      const c = colourAt(data, (y * width + x) * 4);
      if (c !== last) {
        lastIndex = index.get(c)!;
        last = c;
      }
      const shift = 8 - depth * ((x % perByte) + 1);
      rows[start + Math.floor(x / perByte)] |= lastIndex << shift;
    }
  }
  return rows;
}

/** RGB or RGBA samples, one row after another, not yet filtered. */
function truecolourRows(
  data: Uint8Array,
  width: number,
  height: number,
  alpha: boolean
): Uint8Array {
  if (alpha) {
    return data;
  }
  const rows = new Uint8Array(width * height * 3);
  for (let p = 0, q = 0; p < data.length; p += 4, q += 3) {
    rows[q] = data[p];
    rows[q + 1] = data[p + 1];
    rows[q + 2] = data[p + 2];
  }
  return rows;
}

/**
 * Puts a filter byte in front of every row. With `adaptive`, each row gets
 * whichever filter gives the smallest sum of its bytes read as signed, ties
 * going to the lower filter type so the choice is a function of the bytes
 * alone; without it, every row gets none.
 */
function filterRows(
  rows: Uint8Array,
  stride: number,
  height: number,
  unit: number,
  adaptive: boolean
): Uint8Array {
  const raw = new Uint8Array((stride + 1) * height);
  const candidate = new Uint8Array(stride);

  for (let y = 0; y < height; y++) {
    const row = rows.subarray(y * stride, (y + 1) * stride);
    const prior = y > 0 ? rows.subarray((y - 1) * stride, y * stride) : undefined;
    const start = y * (stride + 1);

    if (!adaptive) {
      raw[start] = NONE;
      raw.set(row, start + 1);
      continue;
    }

    let best = Infinity;
    for (let type = NONE; type <= PAETH; type++) {
      filter(type, row, prior, unit, candidate);
      let sum = 0;
      for (let i = 0; i < stride && sum < best; i++) {
        const b = candidate[i];
        sum += b < 128 ? b : 256 - b;
      }
      if (sum < best) {
        best = sum;
        raw[start] = type;
        raw.set(candidate, start + 1);
      }
    }
  }
  return raw;
}

/** The signature and the chunks, each framed by its length and its CRC. */
function assemble(chunks: [string, Uint8Array][]): Uint8Array {
  const size = chunks.reduce((n, [, body]) => n + 12 + body.length, SIGNATURE.length);
  const out = new Uint8Array(size);
  const view = new DataView(out.buffer);
  out.set(SIGNATURE);

  let pos = SIGNATURE.length;
  for (const [name, body] of chunks) {
    const type = encoder.encode(name);
    view.setUint32(pos, body.length);
    out.set(type, pos + 4);
    out.set(body, pos + 8);
    view.setUint32(pos + 8 + body.length, chunkCrc(type, body));
    pos += 12 + body.length;
  }
  return out;
}
