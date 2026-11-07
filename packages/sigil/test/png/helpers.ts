import { crc32, deflateSync } from 'node:zlib';

/**
 * Builds PNG files by hand, chunk by chunk, so that a test can make exactly the
 * malformation it is about. The CRC is right unless `crc` says otherwise.
 */

const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

export interface Chunk {
  type: string;
  body: Uint8Array;
  crc?: number;
  /** A declared length that disagrees with the body. */
  length?: number;
}

export function chunk(
  type: string,
  body: ArrayLike<number> = [],
  extra: Partial<Chunk> = {}
): Chunk {
  return { body: Uint8Array.from(body), type, ...extra };
}

export function png(...chunks: Chunk[]): Uint8Array {
  const parts: number[] = [...SIGNATURE];
  for (const { type, body, crc, length } of chunks) {
    const typeBytes = Buffer.from(type, 'latin1');
    const len = length ?? body.length;
    parts.push((len >>> 24) & 0xff, (len >>> 16) & 0xff, (len >>> 8) & 0xff, len & 0xff);
    parts.push(...typeBytes, ...body);
    const sum = crc ?? crc32(body, crc32(typeBytes));
    parts.push((sum >>> 24) & 0xff, (sum >>> 16) & 0xff, (sum >>> 8) & 0xff, sum & 0xff);
  }
  return Uint8Array.from(parts);
}

export function ihdr(
  width: number,
  height: number,
  depth = 8,
  colourType = 0,
  {
    compression = 0,
    filter = 0,
    interlace = 0,
  }: { compression?: number; filter?: number; interlace?: number } = {}
): Chunk {
  const body = new Uint8Array(13);
  const view = new DataView(body.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  body.set([depth, colourType, compression, filter, interlace], 8);
  return chunk('IHDR', body);
}

/** An IDAT holding `raw` -- filter bytes and samples -- deflated. */
export function idat(raw: ArrayLike<number>): Chunk {
  return chunk('IDAT', deflateSync(Uint8Array.from(raw)));
}

export const IEND: Chunk = chunk('IEND');

/** A whole greyscale file of 8-bit samples, every row unfiltered. */
export function grey(rows: number[][]): Uint8Array {
  return png(ihdr(rows[0].length, rows.length), idat(rows.flatMap((row) => [0, ...row])), IEND);
}

/** The RGBA of every pixel, as `[r, g, b, a]` tuples, for readable assertions. */
export function pixels(data: Uint8Array): number[][] {
  const out: number[][] = [];
  for (let i = 0; i < data.length; i += 4) {
    out.push([data[i], data[i + 1], data[i + 2], data[i + 3]]);
  }
  return out;
}
