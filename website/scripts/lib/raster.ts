import { SEAL_CELLS, sealGrid } from '../../src/lib/seal.ts';
import { crc32, deflateSync, inflateSync } from 'node:zlib';

/**
 * Just enough image encoding to write the site's icons with no dependency.
 *
 * The seal is whole cells, so the favicon and the app icons are not rendered
 * from the SVG by something that anti-aliases; each cell is a square of pixels,
 * stamped. That is the point of the mark (SIG-102: "draw it at multiples of 7
 * so every cell edge lands on a pixel"), and it makes the output exact rather
 * than whatever a rasteriser decided. The PNG is 8-bit RGBA with no filtering,
 * which is what `decodePng` reads back and no more.
 */

export type Rgba = [r: number, g: number, b: number, a: number];

export type Image = { width: number; height: number; data: Uint8Array };

/** `#rrggbb` as an opaque pixel. */
export function hex(color: string): Rgba {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(color);
  if (!m) {
    throw new Error(`expected #rrggbb, got ${color}`);
  }
  return [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16), 255];
}

/**
 * A square image holding the seal.
 *
 * @param size - The image's side in pixels.
 * @param seal - The seal's side in pixels. A multiple of 7, or its cells would
 * not be whole pixels.
 * @param offset - Where the seal's top left corner is. Centered when omitted,
 * which needs `size - seal` to be even.
 * @param ground - The background, or `null` for transparent.
 */
export function sealImage(
  size: number,
  seal: number,
  mark: Rgba,
  ground: Rgba | null,
  offset?: number
): Image {
  if (seal % SEAL_CELLS) {
    throw new Error(`a ${seal}px seal is not a multiple of ${SEAL_CELLS}`);
  }
  const at = offset ?? (size - seal) / 2;
  if (!Number.isInteger(at) || at < 0 || at + seal > size) {
    throw new Error(`a ${seal}px seal does not sit on whole pixels in ${size}px`);
  }

  const cell = seal / SEAL_CELLS;
  const grid = sealGrid();
  const data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const column = Math.floor((x - at) / cell);
      const row = Math.floor((y - at) / cell);
      const inked = grid[row]?.[column] === true && x >= at && y >= at;
      const pixel = inked ? mark : (ground ?? [0, 0, 0, 0]);
      data.set(pixel, (y * size + x) * 4);
    }
  }
  return { width: size, height: size, data };
}

function chunk(type: string, body: Uint8Array) {
  const out = Buffer.alloc(12 + body.length);
  out.writeUInt32BE(body.length, 0);
  out.write(type, 4, 'latin1');
  out.set(body, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + body.length)), 8 + body.length);
  return out;
}

export function encodePng({ width, height, data }: Image): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bit depth
  header[9] = 6; // RGBA

  const rows = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    // the first byte of a row is its filter type, and 0 is none
    rows.set(data.subarray(y * width * 4, (y + 1) * width * 4), y * (width * 4 + 1) + 1);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(rows, { level: 9 })),
    chunk('IEND', new Uint8Array(0)),
  ]);
}

/** Reads back what `encodePng` wrote, and throws on any other kind of PNG. */
export function decodePng(png: Uint8Array): Image {
  const buffer = Buffer.from(png);
  if (buffer.readUInt32BE(0) !== 0x89504e47) {
    throw new Error('not a PNG');
  }
  let width = 0;
  let height = 0;
  const idat: Buffer[] = [];
  for (let at = 8; at < buffer.length;) {
    const length = buffer.readUInt32BE(at);
    const type = buffer.toString('latin1', at + 4, at + 8);
    const body = buffer.subarray(at + 8, at + 8 + length);
    if (type === 'IHDR') {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      if (body[8] !== 8 || body[9] !== 6) {
        throw new Error('only 8-bit RGBA PNGs are read here');
      }
    } else if (type === 'IDAT') {
      idat.push(body);
    }
    at += 12 + length;
  }

  const rows = inflateSync(Buffer.concat(idat));
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    if (rows[y * (width * 4 + 1)] !== 0) {
      throw new Error('only unfiltered rows are read here');
    }
    data.set(rows.subarray(y * (width * 4 + 1) + 1, (y + 1) * (width * 4 + 1)), y * width * 4);
  }
  return { width, height, data };
}

/** An ICO whose frames are PNGs, which every browser that reads an ICO reads. */
export function encodeIco(frames: Image[]): Buffer {
  const pngs = frames.map(encodePng);
  const header = Buffer.alloc(6 + frames.length * 16);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(frames.length, 4);

  let offset = header.length;
  frames.forEach((frame, i) => {
    const at = 6 + i * 16;
    // 256 and over is written as 0
    header[at] = frame.width >= 256 ? 0 : frame.width;
    header[at + 1] = frame.height >= 256 ? 0 : frame.height;
    header.writeUInt16LE(1, at + 4); // colour planes
    header.writeUInt16LE(32, at + 6); // bits per pixel
    header.writeUInt32LE(pngs[i].length, at + 8);
    header.writeUInt32LE(offset, at + 12);
    offset += pngs[i].length;
  });
  return Buffer.concat([header, ...pngs]);
}

/** The frames of an ICO as images, for a test to look at. */
export function decodeIco(ico: Uint8Array): Image[] {
  const buffer = Buffer.from(ico);
  const count = buffer.readUInt16LE(4);
  return Array.from({ length: count }, (_, i) => {
    const at = 6 + i * 16;
    const size = buffer.readUInt32LE(at + 8);
    const offset = buffer.readUInt32LE(at + 12);
    return decodePng(buffer.subarray(offset, offset + size));
  });
}
