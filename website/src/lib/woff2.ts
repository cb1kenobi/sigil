import { brotliDecompressSync } from 'node:zlib';

/**
 * woff2 to sfnt, so that `next/og` can read the fonts the site already ships.
 *
 * The site's fonts are vendored as woff2 (`src/fonts`), which is what a browser
 * wants. `ImageResponse` draws with satori, and satori reads ttf, otf and woff
 * only. The two ways out were a second copy of every face as ttf, committed and
 * kept in step by hand, or decoding the one copy we have. This is the second:
 * the format is a brotli stream over the sfnt tables, with the glyph and
 * `hmtx` tables stored in a transformed, smaller form, and undoing that is the
 * whole of it. W3C WOFF2 recommendation, section 5 onwards.
 *
 * It is not a general decoder. It reads TrueType-flavoured fonts (`glyf`), which
 * is what Google Fonts serves for every face here, and it throws on anything
 * else rather than returning a font that is quietly wrong. It also leaves
 * `head.checkSumAdjustment` as it found it: nothing that draws text reads it.
 */

/** The 63 tags a directory entry can name by index instead of spelling out. */
const KNOWN_TAGS = [
  'cmap',
  'head',
  'hhea',
  'hmtx',
  'maxp',
  'name',
  'OS/2',
  'post',
  'cvt ',
  'fpgm',
  'glyf',
  'loca',
  'prep',
  'CFF ',
  'VORG',
  'EBDT',
  'EBLC',
  'gasp',
  'hdmx',
  'kern',
  'LTSH',
  'PCLT',
  'VDMX',
  'vhea',
  'vmtx',
  'BASE',
  'GDEF',
  'GPOS',
  'GSUB',
  'EBSC',
  'JSTF',
  'MATH',
  'CBDT',
  'CBLC',
  'COLR',
  'CPAL',
  'SVG ',
  'sbix',
  'acnt',
  'avar',
  'bdat',
  'bloc',
  'bsln',
  'cvar',
  'fdsc',
  'feat',
  'fmtx',
  'fvar',
  'gvar',
  'hsty',
  'just',
  'lcar',
  'mort',
  'morx',
  'opbd',
  'prop',
  'trak',
  'Zapf',
  'Silf',
  'Glat',
  'Gloc',
  'Feat',
  'Sill',
];

type Entry = { tag: string; transformed: boolean; origLength: number; length: number };

/** A cursor over bytes, big-endian, with the two variable-length integers. */
class Reader {
  pos = 0;
  readonly bytes: Uint8Array;
  readonly view: DataView;

  constructor(bytes: Uint8Array) {
    this.bytes = bytes;
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }

  u8() {
    return this.bytes[this.pos++];
  }

  u16() {
    const v = this.view.getUint16(this.pos);
    this.pos += 2;
    return v;
  }

  i16() {
    const v = this.view.getInt16(this.pos);
    this.pos += 2;
    return v;
  }

  u32() {
    const v = this.view.getUint32(this.pos);
    this.pos += 4;
    return v;
  }

  tag() {
    const v = String.fromCharCode(...this.bytes.subarray(this.pos, this.pos + 4));
    this.pos += 4;
    return v;
  }

  take(n: number) {
    const v = this.bytes.subarray(this.pos, this.pos + n);
    this.pos += n;
    return v;
  }

  /** UIntBase128: seven bits a byte, high bit set while more follow. */
  base128() {
    let value = 0;
    for (let i = 0; i < 5; i++) {
      const byte = this.u8();
      if (i === 0 && byte === 0x80) {
        throw new Error('woff2: UIntBase128 with a leading zero');
      }
      value = value * 128 + (byte & 0x7f);
      if (!(byte & 0x80)) {
        return value;
      }
    }
    throw new Error('woff2: UIntBase128 longer than five bytes');
  }

  /** 255UInt16: the one-byte common case, with 253, 254 and 255 as escapes. */
  u255() {
    const code = this.u8();
    if (code === 253) {
      return this.u16();
    }
    if (code === 255) {
      return this.u8() + 253;
    }
    if (code === 254) {
      return this.u8() + 506;
    }
    return code;
  }
}

/** Bytes written in order, grown as needed. */
class Writer {
  private bytes = new Uint8Array(1024);
  length = 0;

  private ensure(n: number) {
    if (this.length + n > this.bytes.length) {
      const next = new Uint8Array(Math.max(this.bytes.length * 2, this.length + n));
      next.set(this.bytes);
      this.bytes = next;
    }
  }

  u8(v: number) {
    this.ensure(1);
    this.bytes[this.length++] = v;
  }

  u16(v: number) {
    this.u8((v >> 8) & 0xff);
    this.u8(v & 0xff);
  }

  u32(v: number) {
    this.u16(v >>> 16);
    this.u16(v & 0xffff);
  }

  raw(data: Uint8Array) {
    this.ensure(data.length);
    this.bytes.set(data, this.length);
    this.length += data.length;
  }

  /** Zero-pad to a multiple of four, which every sfnt table is. */
  align4() {
    while (this.length % 4) {
      this.u8(0);
    }
  }

  done() {
    return this.bytes.slice(0, this.length);
  }
}

/** The sign half of a glyf triplet: odd flags are positive. */
const signed = (flag: number, magnitude: number) => (flag & 1 ? magnitude : -magnitude);

/**
 * Decodes one (dx, dy) triplet from the glyph stream, advancing it.
 * Section 5.2 of the recommendation: the flag byte picks one of six packings.
 */
function triplet(glyphs: Reader, flag: number) {
  if (flag < 10) {
    return { dx: 0, dy: signed(flag, ((flag & 14) << 7) + glyphs.u8()) };
  }
  if (flag < 20) {
    return { dx: signed(flag, (((flag - 10) & 14) << 7) + glyphs.u8()), dy: 0 };
  }
  if (flag < 84) {
    const b0 = flag - 20;
    const b1 = glyphs.u8();
    return {
      dx: signed(flag, 1 + (b0 & 0x30) + (b1 >> 4)),
      dy: signed(flag >> 1, 1 + ((b0 & 0x0c) << 2) + (b1 & 0x0f)),
    };
  }
  if (flag < 120) {
    const b0 = flag - 84;
    const b1 = glyphs.u8();
    const b2 = glyphs.u8();
    return {
      dx: signed(flag, 1 + (Math.floor(b0 / 12) << 8) + b1),
      dy: signed(flag >> 1, 1 + (((b0 % 12) >> 2) << 8) + b2),
    };
  }
  if (flag < 124) {
    const b1 = glyphs.u8();
    const b2 = glyphs.u8();
    const b3 = glyphs.u8();
    return {
      dx: signed(flag, (b1 << 4) + (b2 >> 4)),
      dy: signed(flag >> 1, ((b2 & 0x0f) << 8) + b3),
    };
  }
  const dx = glyphs.u16();
  const dy = glyphs.u16();
  return { dx: signed(flag, dx), dy: signed(flag >> 1, dy) };
}

const ARG_WORDS = 0x0001;
const HAVE_SCALE = 0x0008;
const MORE_COMPONENTS = 0x0020;
const HAVE_XY_SCALE = 0x0040;
const HAVE_TWO_BY_TWO = 0x0080;
const HAVE_INSTRUCTIONS = 0x0100;

/** `glyf` and `loca` rebuilt from the transformed `glyf` stream. */
function untransformGlyf(data: Uint8Array) {
  const head = new Reader(data);
  head.u16(); // reserved
  head.u16(); // optionFlags: bit 0 is the overlap bitmap, which only a renderer reads
  const numGlyphs = head.u16();
  const indexFormat = head.u16();
  const sizes = Array.from({ length: 7 }, () => head.u32());

  let offset = head.pos;
  const streams = sizes.map((size) => {
    const stream = new Reader(data.subarray(offset, offset + size));
    offset += size;
    return stream;
  });
  const [nContours, nPoints, flags, glyphs, composites, bboxes, instructions] = streams;

  const bitmapBytes = ((numGlyphs + 31) >> 5) << 2;
  const bitmap = bboxes.take(bitmapBytes);

  const glyf = new Writer();
  const offsets: number[] = [];

  for (let g = 0; g < numGlyphs; g++) {
    offsets.push(glyf.length);
    const contours = nContours.i16();
    const hasBox = (bitmap[g >> 3] & (0x80 >> (g & 7))) !== 0;

    if (contours === 0) {
      continue;
    }

    if (contours === -1) {
      if (!hasBox) {
        throw new Error('woff2: a composite glyph without a bounding box');
      }
      glyf.u16(0xffff);
      for (let i = 0; i < 4; i++) {
        glyf.u16(bboxes.u16());
      }
      // the component records are copied through as written; reading them is
      // only to learn where they end and whether instructions follow
      let more = true;
      let instructed = false;
      while (more) {
        const start = composites.pos;
        const flag = composites.u16();
        composites.u16(); // glyph index
        composites.pos += flag & ARG_WORDS ? 4 : 2;
        if (flag & HAVE_SCALE) {
          composites.pos += 2;
        } else if (flag & HAVE_XY_SCALE) {
          composites.pos += 4;
        } else if (flag & HAVE_TWO_BY_TWO) {
          composites.pos += 8;
        }
        glyf.raw(composites.bytes.subarray(start, composites.pos));
        more = (flag & MORE_COMPONENTS) !== 0;
        instructed ||= (flag & HAVE_INSTRUCTIONS) !== 0;
      }
      if (instructed) {
        const length = glyphs.u255();
        glyf.u16(length);
        glyf.raw(instructions.take(length));
      }
      glyf.align4();
      continue;
    }

    if (contours < 0) {
      throw new Error(`woff2: glyph ${g} has ${contours} contours`);
    }

    const ends: number[] = [];
    let total = 0;
    for (let c = 0; c < contours; c++) {
      total += nPoints.u255();
      ends.push(total - 1);
    }

    const xs: number[] = [];
    const ys: number[] = [];
    const onCurve: boolean[] = [];
    let x = 0;
    let y = 0;
    for (let p = 0; p < total; p++) {
      const flag = flags.u8();
      const { dx, dy } = triplet(glyphs, flag & 0x7f);
      x += dx;
      y += dy;
      xs.push(x);
      ys.push(y);
      onCurve.push((flag & 0x80) === 0);
    }

    const length = glyphs.u255();
    const code = instructions.take(length);

    glyf.u16(contours);
    if (hasBox) {
      for (let i = 0; i < 4; i++) {
        glyf.u16(bboxes.u16());
      }
    } else {
      glyf.u16(Math.min(...xs) & 0xffff);
      glyf.u16(Math.min(...ys) & 0xffff);
      glyf.u16(Math.max(...xs) & 0xffff);
      glyf.u16(Math.max(...ys) & 0xffff);
    }
    for (const end of ends) {
      glyf.u16(end);
    }
    glyf.u16(length);
    glyf.raw(code);
    // flags are written one a point with neither short-vector bit, so every
    // coordinate below is a plain int16 delta: bigger than it could be, and
    // trivially correct
    for (const on of onCurve) {
      glyf.u8(on ? 1 : 0);
    }
    let px = 0;
    for (const v of xs) {
      glyf.u16((v - px) & 0xffff);
      px = v;
    }
    let py = 0;
    for (const v of ys) {
      glyf.u16((v - py) & 0xffff);
      py = v;
    }
    glyf.align4();
  }
  offsets.push(glyf.length);

  const loca = new Writer();
  for (const o of offsets) {
    if (indexFormat === 0) {
      loca.u16(o / 2);
    } else {
      loca.u32(o);
    }
  }

  return { glyf: glyf.done(), loca: loca.done(), numGlyphs, offsets };
}

/** `hmtx` rebuilt: the side bearings a font may leave out are each glyph's `xMin`. */
function untransformHmtx(
  data: Uint8Array,
  numHMetrics: number,
  numGlyphs: number,
  xMin: (glyph: number) => number
) {
  const r = new Reader(data);
  const flags = r.u8();
  const advances = Array.from({ length: numHMetrics }, () => r.u16());
  const proportionalOmitted = (flags & 1) !== 0;
  const monospacedOmitted = (flags & 2) !== 0;

  const out = new Writer();
  for (let g = 0; g < numGlyphs; g++) {
    if (g < numHMetrics) {
      out.u16(advances[g]);
      out.u16((proportionalOmitted ? xMin(g) : r.i16()) & 0xffff);
    } else {
      out.u16((monospacedOmitted ? xMin(g) : r.i16()) & 0xffff);
    }
  }
  return out.done();
}

function checksum(data: Uint8Array) {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let sum = 0;
  for (let i = 0; i < data.length; i += 4) {
    const word =
      i + 4 <= data.length
        ? view.getUint32(i)
        : // the last, short word is zero-padded on the right
          Array.from(data.subarray(i)).reduce((a, b, k) => a + b * 2 ** (24 - 8 * k), 0);
    sum = (sum + word) >>> 0;
  }
  return sum;
}

/** The tables that make a font variable. Without them it is the font's default instance. */
const VARIATION_TABLES = new Set(['fvar', 'gvar', 'avar', 'cvar', 'HVAR', 'MVAR', 'STAT']);

type Options = {
  /**
   * Leave the variation tables out, so the font is its default instance.
   *
   * satori reads `fvar` and trips on the axis names of the subset the site
   * vendors (it looks up a `name` record the subset dropped), and it cannot
   * draw a variable font at any other instance anyway: it would draw the
   * default. So a caller drawing with one asks for exactly that.
   */
  default?: boolean;
};

/** The sfnt a woff2 file holds, as bytes a font parser can read. */
export function woff2ToSfnt(input: Uint8Array, options: Options = {}): Uint8Array {
  const r = new Reader(input);
  if (r.tag() !== 'wOF2') {
    throw new Error('woff2: not a woff2 file');
  }
  const flavor = r.u32();
  if (flavor !== 0x00010000) {
    throw new Error('woff2: only TrueType-flavoured fonts are supported');
  }
  r.u32(); // length
  const numTables = r.u16();
  r.u16(); // reserved
  r.u32(); // totalSfntSize
  const compressedSize = r.u32();
  r.pos = 48; // the rest of the header, which a decoder has no use for

  const entries: Entry[] = [];
  for (let i = 0; i < numTables; i++) {
    const flags = r.u8();
    const index = flags & 0x3f;
    const tag = index === 0x3f ? r.tag() : KNOWN_TAGS[index];
    const version = flags >> 6;
    // glyf and loca are transformed at version 0 and plain at 3; every other
    // table is plain at 0, and hmtx is the one with a transform, at 1
    const transformed = tag === 'glyf' || tag === 'loca' ? version === 0 : version !== 0;
    if (transformed && tag !== 'glyf' && tag !== 'loca' && tag !== 'hmtx') {
      throw new Error(`woff2: unknown transform ${version} on ${tag}`);
    }
    const origLength = r.base128();
    const length = transformed ? r.base128() : origLength;
    entries.push({ tag, transformed, origLength, length });
  }

  const stream = brotliDecompressSync(r.take(compressedSize));
  const raw = new Map<string, Uint8Array>();
  let offset = 0;
  for (const entry of entries) {
    raw.set(entry.tag, stream.subarray(offset, offset + entry.length));
    offset += entry.length;
  }

  const tables = new Map<string, Uint8Array>();
  let rebuilt: ReturnType<typeof untransformGlyf> | undefined;
  for (const entry of entries) {
    const data = raw.get(entry.tag)!;
    if (!entry.transformed) {
      tables.set(entry.tag, data);
    } else if (entry.tag === 'glyf') {
      rebuilt = untransformGlyf(data);
      tables.set('glyf', rebuilt.glyf);
      tables.set('loca', rebuilt.loca);
    }
  }

  const hmtx = entries.find((entry) => entry.tag === 'hmtx');
  if (hmtx?.transformed) {
    const hhea = tables.get('hhea');
    if (!rebuilt || !hhea) {
      throw new Error('woff2: a transformed hmtx without the tables it is read against');
    }
    const glyf = new DataView(rebuilt.glyf.buffer, rebuilt.glyf.byteOffset, rebuilt.glyf.length);
    const numHMetrics = new DataView(hhea.buffer, hhea.byteOffset, hhea.length).getUint16(34);
    tables.set(
      'hmtx',
      untransformHmtx(raw.get('hmtx')!, numHMetrics, rebuilt.numGlyphs, (g) =>
        rebuilt!.offsets[g + 1] > rebuilt!.offsets[g] ? glyf.getInt16(rebuilt!.offsets[g] + 2) : 0
      )
    );
  }

  if (options.default) {
    for (const tag of VARIATION_TABLES) {
      tables.delete(tag);
    }
  }

  const tags = [...tables.keys()].sort();
  const out = new Writer();
  const entrySelector = Math.floor(Math.log2(tags.length));
  const searchRange = 16 * 2 ** entrySelector;
  out.u32(0x00010000);
  out.u16(tags.length);
  out.u16(searchRange);
  out.u16(entrySelector);
  out.u16(tags.length * 16 - searchRange);

  let at = 12 + tags.length * 16;
  for (const tag of tags) {
    const data = tables.get(tag)!;
    for (const ch of tag) {
      out.u8(ch.charCodeAt(0));
    }
    out.u32(checksum(data));
    out.u32(at);
    out.u32(data.length);
    at += Math.ceil(data.length / 4) * 4;
  }
  for (const tag of tags) {
    out.raw(tables.get(tag)!);
    out.align4();
  }
  return out.done();
}
