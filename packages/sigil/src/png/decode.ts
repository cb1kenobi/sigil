import { __ } from '../i18n/index.js';
import {
  ADAM7,
  CHANNELS,
  chunkCrc,
  DEPTHS,
  GREY,
  GREY_ALPHA,
  INDEXED,
  MAX_CHUNK_LENGTH,
  passSize,
  PROGRESSIVE,
  RGBA,
  rowBytes,
  SIGNATURE,
} from './chunks.js';
import { unfilter } from './filters.js';
import type { RgbaImage } from './image.js';
import { zlib } from './zlib.js';
/**
 * Reading a PNG: chunks in, 8-bit RGBA out.
 *
 * Every colour type at every bit depth the specification allows, the palette
 * and `tRNS`, the five filters, and Adam7. The output has one shape whatever the
 * file held, so a consumer never branches on the format: 16-bit samples are
 * rounded to 8, low depths are scaled up to the full range, and alpha is 255
 * wherever the file said nothing about it.
 *
 * A malformed file throws a plain `Error` and never returns part of an image.
 * The other half of that is never *working* on part of one without a bound:
 * IHDR's dimensions say exactly how many bytes the image data inflates to, and
 * that figure is handed to `inflateSync()` as `maxOutputLength`, so a stream
 * that inflates without end stops at the size of the image rather than at the
 * size of the machine.
 */
import { constants } from 'node:buffer';

/** What `decodePng()` takes besides the bytes. */
export interface DecodePngOptions {
  /**
   * The most pixels an image may declare, checked against IHDR before anything
   * is inflated or allocated. Defaults to 2^28 -- a 16384 by 16384 image, whose
   * RGBA output is 1 GiB.
   */
  maxPixels?: number;
}

/** The default `maxPixels`. */
export const MAX_PIXELS: number = 2 ** 28;

interface Header {
  width: number;
  height: number;
  depth: number;
  colourType: number;
  interlaced: boolean;
}

/** A chunk type as text, or as hex when it is not the four letters it must be. */
function typeName(bytes: Uint8Array): string | undefined {
  for (const b of bytes) {
    if (!((b >= 0x41 && b <= 0x5a) || (b >= 0x61 && b <= 0x7a))) {
      return undefined;
    }
  }
  return String.fromCharCode(...bytes);
}

function hex(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join(' ');
}

/**
 * Decodes a PNG into 8-bit RGBA.
 *
 * Throws an `Error` saying what is wrong when the bytes are not a PNG this
 * decoder can read in full: a bad signature, a CRC that does not match, a
 * chunk out of order or missing, image data that is short, long or corrupt,
 * or an image larger than `options.maxPixels`.
 */
export function decodePng(bytes: Uint8Array, options?: DecodePngOptions): RgbaImage {
  if (!(bytes instanceof Uint8Array)) {
    throw new TypeError('decodePng() expects a Uint8Array');
  }
  // checked rather than coerced: the cap is a comparison, and `NaN > n` is
  // false, so a cap that is not a number would lift it rather than fail
  const maxPixels = options?.maxPixels ?? MAX_PIXELS;
  if (typeof maxPixels !== 'number' || Number.isNaN(maxPixels) || maxPixels < 0) {
    throw new TypeError('decodePng() expects maxPixels to be a number of pixels, or Infinity');
  }

  if (bytes.length < SIGNATURE.length || SIGNATURE.some((b, i) => bytes[i] !== b)) {
    throw new Error(__`Not a PNG file: the signature does not match`);
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let pos = SIGNATURE.length;

  let header: Header | undefined;
  let palette: Uint8Array | undefined;
  // seen separately from `palette`, which stays undefined for the PLTE a
  // truecolour image may carry and ignore -- one of them, not two
  let paletteSeen = false;
  let transparency: Uint8Array | undefined;
  const data: Uint8Array[] = [];
  let previous = '';

  for (;;) {
    if (pos + 8 > bytes.length) {
      throw new Error(__`Truncated PNG: the file ends before its IEND chunk`);
    }

    const length = view.getUint32(pos);
    const typeBytes = bytes.subarray(pos + 4, pos + 8);
    const type = typeName(typeBytes);
    if (type === undefined) {
      throw new Error(__`Invalid PNG: a chunk type of bytes ${hex(typeBytes)} at offset ${pos}`);
    }
    if (length > MAX_CHUNK_LENGTH) {
      throw new Error(__`Invalid PNG: the ${type} chunk declares a length of ${length}`);
    }
    if (pos + 12 + length > bytes.length) {
      throw new Error(__`Truncated PNG: the ${type} chunk runs past the end of the file`);
    }

    const body = bytes.subarray(pos + 8, pos + 8 + length);
    if (chunkCrc(typeBytes, body) !== view.getUint32(pos + 8 + length)) {
      throw new Error(__`Corrupt PNG: the CRC of the ${type} chunk does not match its data`);
    }
    pos += 12 + length;

    if (header === undefined) {
      if (type !== 'IHDR') {
        throw new Error(__`Invalid PNG: the first chunk is ${type}, not IHDR`);
      }
      header = readHeader(body, maxPixels);
      previous = type;
      continue;
    }

    // IDAT chunks must be consecutive: the stream is one stream split up, and
    // anything between two halves of it is a file put together wrongly
    if (type === 'IDAT') {
      if (data.length > 0 && previous !== 'IDAT') {
        throw new Error(__`Invalid PNG: the IDAT chunks are not consecutive`);
      }
      data.push(body);
    } else if (type === 'IEND') {
      break;
    } else if (type === 'IHDR') {
      throw new Error(__`Invalid PNG: more than one ${type} chunk`);
    } else if (type === 'PLTE') {
      if (paletteSeen) {
        throw new Error(__`Invalid PNG: more than one ${type} chunk`);
      }
      if (data.length > 0 || transparency !== undefined) {
        throw new Error(__`Invalid PNG: the ${type} chunk is out of order`);
      }
      palette = readPalette(body, header);
      paletteSeen = true;
    } else if (type === 'tRNS') {
      if (transparency !== undefined) {
        throw new Error(__`Invalid PNG: more than one ${type} chunk`);
      }
      if (data.length > 0 || (header.colourType === INDEXED && palette === undefined)) {
        throw new Error(__`Invalid PNG: the ${type} chunk is out of order`);
      }
      transparency = readTransparency(body, header, palette);
    } else if (type.charCodeAt(0) < 0x61) {
      // an upper-case first letter is the specification's own flag for a
      // chunk a decoder may not skip, so one this decoder does not know is a
      // file it cannot read correctly rather than one it can read without.
      // A lower-case one is ancillary -- gamma, text, time, physical size --
      // and is skipped, its CRC having been checked like every other's
      throw new Error(__`Unsupported PNG: an unknown critical chunk ${type}`);
    }

    previous = type;
  }

  if (data.length === 0) {
    throw new Error(__`Invalid PNG: there is no IDAT chunk`);
  }
  if (header.colourType === INDEXED && palette === undefined) {
    throw new Error(__`Invalid PNG: an indexed image with no PLTE chunk`);
  }

  return render(header, inflate(data, header), palette, transparency);
}

function readHeader(body: Uint8Array, maxPixels: number): Header {
  if (body.length !== 13) {
    throw new Error(__`Invalid PNG: IHDR is ${body.length} bytes rather than 13`);
  }

  const view = new DataView(body.buffer, body.byteOffset, body.byteLength);
  const width = view.getUint32(0);
  const height = view.getUint32(4);
  const [depth, colourType, compression, filtering, interlace] = body.subarray(8);

  if (width === 0 || height === 0 || width > MAX_CHUNK_LENGTH || height > MAX_CHUNK_LENGTH) {
    throw new Error(__`Invalid PNG: an image of ${width}x${height} pixels`);
  }
  if (!(colourType in DEPTHS)) {
    throw new Error(__`Invalid PNG: colour type ${colourType} does not exist`);
  }
  if (!DEPTHS[colourType].includes(depth)) {
    throw new Error(
      __`Invalid PNG: bit depth ${depth} is not allowed for colour type ${colourType}`
    );
  }
  if (compression !== 0) {
    throw new Error(__`Unsupported PNG: compression method ${compression}`);
  }
  if (filtering !== 0) {
    throw new Error(__`Unsupported PNG: filter method ${filtering}`);
  }
  if (interlace > 1) {
    throw new Error(__`Unsupported PNG: interlace method ${interlace}`);
  }
  if (width * height > maxPixels) {
    throw new Error(
      __`PNG too large: ${width}x${height} pixels is more than the ${maxPixels} allowed`
    );
  }

  return { colourType, depth, height, interlaced: interlace === 1, width };
}

/** The palette as RGBA quads, opaque until a `tRNS` chunk says otherwise. */
function readPalette(body: Uint8Array, header: Header): Uint8Array | undefined {
  if (header.colourType === GREY || header.colourType === GREY_ALPHA) {
    throw new Error(__`Invalid PNG: a PLTE chunk in a greyscale image`);
  }

  const entries = body.length / 3;
  if (!Number.isInteger(entries) || entries < 1 || entries > 256) {
    throw new Error(__`Invalid PNG: a PLTE chunk of ${body.length} bytes`);
  }

  // a palette in a truecolour image is a suggestion for a display that cannot
  // show truecolour, and the pixels never index it
  if (header.colourType !== INDEXED) {
    return undefined;
  }

  const quads = new Uint8Array(entries * 4);
  for (let i = 0; i < entries; i++) {
    quads[i * 4] = body[i * 3];
    quads[i * 4 + 1] = body[i * 3 + 1];
    quads[i * 4 + 2] = body[i * 3 + 2];
    quads[i * 4 + 3] = 255;
  }
  return quads;
}

/**
 * The `tRNS` chunk. For an indexed image it is written into the palette's
 * alpha and nothing is returned; for greyscale and truecolour it is the one
 * sample value, at the image's own depth, that means "transparent".
 */
function readTransparency(
  body: Uint8Array,
  header: Header,
  palette: Uint8Array | undefined
): Uint8Array {
  const { colourType } = header;

  if (colourType === GREY_ALPHA || colourType === RGBA) {
    throw new Error(__`Invalid PNG: a tRNS chunk in an image that already has alpha`);
  }

  if (colourType === INDEXED) {
    const entries = palette ? palette.length / 4 : 0;
    if (body.length > entries) {
      throw new Error(
        __`Invalid PNG: a tRNS chunk of ${body.length} entries for a palette of ${entries}`
      );
    }
    for (let i = 0; i < body.length; i++) {
      palette![i * 4 + 3] = body[i];
    }
    return body;
  }

  const expected = colourType === GREY ? 2 : 6;
  if (body.length !== expected) {
    throw new Error(
      __`Invalid PNG: a tRNS chunk of ${body.length} bytes for colour type ${colourType}`
    );
  }
  return body;
}

/** How many bytes the image data inflates to: every pass's rows, each with its filter byte. */
function inflatedSize({ width, height, depth, colourType, interlaced }: Header): number {
  const bits = depth * CHANNELS[colourType];
  let total = 0;
  for (const pass of interlaced ? ADAM7 : PROGRESSIVE) {
    const [w, h] = passSize(width, height, pass);
    if (w > 0 && h > 0) {
      total += (rowBytes(w, bits) + 1) * h;
    }
  }
  return total;
}

function inflate(chunks: Uint8Array[], header: Header): Uint8Array {
  const expected = inflatedSize(header);
  if (expected > constants.MAX_LENGTH) {
    throw new Error(
      __`PNG too large: ${header.width}x${header.height} pixels is more than this runtime can hold`
    );
  }

  const stream = chunks.length === 1 ? chunks[0] : Buffer.concat(chunks);
  let raw: Uint8Array;
  try {
    raw = zlib().inflateSync(stream, { maxOutputLength: expected });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ERR_BUFFER_TOO_LARGE') {
      throw new Error(
        __`Corrupt PNG: the image data inflates to more than the ${expected} bytes a ${header.width}x${header.height} image needs`,
        { cause: err }
      );
    }
    throw new Error(__`Corrupt PNG: the image data does not inflate: ${(err as Error).message}`, {
      cause: err,
    });
  }

  if (raw.length !== expected) {
    throw new Error(
      __`Corrupt PNG: the image data inflates to ${raw.length} bytes rather than ${expected}`
    );
  }
  return raw;
}

/**
 * Unfilters `raw` in place, pass by pass, and writes each pass's pixels into
 * their places in the RGBA output.
 */
function render(
  header: Header,
  raw: Uint8Array,
  palette: Uint8Array | undefined,
  transparency: Uint8Array | undefined
): RgbaImage {
  const { width, height, depth, colourType, interlaced } = header;
  const channels = CHANNELS[colourType];
  const bits = depth * channels;
  const unit = Math.max(1, bits >> 3);
  const out = new Uint8Array(width * height * 4);
  const write = writer(header, palette, transparency, out);

  let offset = 0;
  for (const pass of interlaced ? ADAM7 : PROGRESSIVE) {
    const [w, h] = passSize(width, height, pass);
    if (w === 0 || h === 0) {
      continue;
    }

    const stride = rowBytes(w, bits);
    let prior: Uint8Array | undefined;
    for (let y = 0; y < h; y++) {
      const type = raw[offset];
      const row = raw.subarray(offset + 1, offset + 1 + stride);
      if (!unfilter(type, row, prior, unit)) {
        throw new Error(__`Corrupt PNG: scanline ${y} has filter type ${type}`);
      }
      write(row, w, pass[1] + y * pass[3], pass[0], pass[2]);
      prior = row;
      offset += stride + 1;
    }
  }

  return { data: out, height, width };
}

type RowWriter = (row: Uint8Array, count: number, y: number, x0: number, dx: number) => void;

/**
 * The function that turns one unfiltered row of samples into RGBA pixels, picked
 * once per image rather than branched on per pixel.
 */
function writer(
  { width, depth, colourType }: Header,
  palette: Uint8Array | undefined,
  transparency: Uint8Array | undefined,
  out: Uint8Array
): RowWriter {
  // the transparent sample value for greyscale and truecolour, at the image's
  // own depth -- compared before a 16-bit sample is reduced, since two
  // different 16-bit values can round to one 8-bit one
  const key =
    transparency && colourType !== INDEXED
      ? Array.from(
          { length: transparency.length / 2 },
          (_, i) => (transparency[i * 2] << 8) | transparency[i * 2 + 1]
        )
      : undefined;

  if (colourType === INDEXED) {
    const quads = palette!;
    const entries = quads.length / 4;
    const mask = (1 << depth) - 1;
    return (row, count, y, x0, dx) => {
      for (let i = 0; i < count; i++) {
        const bit = i * depth;
        const index = (row[bit >> 3] >> (8 - depth - (bit & 7))) & mask;
        if (index >= entries) {
          throw new Error(
            __`Corrupt PNG: palette index ${index} is outside a palette of ${entries}`
          );
        }
        out.set(quads.subarray(index * 4, index * 4 + 4), (y * width + x0 + i * dx) * 4);
      }
    };
  }

  if (depth < 8) {
    // greyscale only: the other colour types start at 8
    const mask = (1 << depth) - 1;
    const scale = 255 / mask;
    const transparent = key ? key[0] : -1;
    return (row, count, y, x0, dx) => {
      for (let i = 0; i < count; i++) {
        const bit = i * depth;
        const v = (row[bit >> 3] >> (8 - depth - (bit & 7))) & mask;
        const p = (y * width + x0 + i * dx) * 4;
        out[p] = out[p + 1] = out[p + 2] = v * scale;
        out[p + 3] = v === transparent ? 0 : 255;
      }
    };
  }

  const channels = CHANNELS[colourType];
  const size = depth >> 3;
  // a 16-bit sample rounded to the nearest 8-bit one: v / 257, rounded. 257
  // is odd, so there is never a tie to break, and `(v + 128) / 257` floored
  // is that rounding without a float
  const sample =
    size === 1
      ? (row: Uint8Array, i: number) => row[i]
      : (row: Uint8Array, i: number) => (row[i * 2] << 8) | row[i * 2 + 1];
  const reduce = size === 1 ? (v: number) => v : (v: number) => ((v + 128) / 257) | 0;

  return (row, count, y, x0, dx) => {
    for (let i = 0; i < count; i++) {
      const s = i * channels;
      const p = (y * width + x0 + i * dx) * 4;
      if (colourType === GREY) {
        const v = sample(row, s);
        out[p] = out[p + 1] = out[p + 2] = reduce(v);
        out[p + 3] = key && v === key[0] ? 0 : 255;
      } else if (colourType === GREY_ALPHA) {
        out[p] = out[p + 1] = out[p + 2] = reduce(sample(row, s));
        out[p + 3] = reduce(sample(row, s + 1));
      } else {
        const r = sample(row, s);
        const g = sample(row, s + 1);
        const b = sample(row, s + 2);
        out[p] = reduce(r);
        out[p + 1] = reduce(g);
        out[p + 2] = reduce(b);
        out[p + 3] =
          colourType === RGBA
            ? reduce(sample(row, s + 3))
            : key && r === key[0] && g === key[1] && b === key[2]
              ? 0
              : 255;
      }
    }
  };
}
