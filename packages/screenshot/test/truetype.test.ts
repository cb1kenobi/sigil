import { FontError, parseFont } from '../src/font/truetype.js';
import { DEFAULT_FONTS } from '../src/fonts.js';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * The TrueType reader, against the bundled JetBrains Mono and against bytes
 * that lie about themselves.
 */

const regular = readFileSync(DEFAULT_FONTS.regular);

/** A copy of the regular face with one byte range overwritten. */
function patched(at: number, bytes: number[]): Uint8Array {
  const copy = new Uint8Array(regular);
  copy.set(bytes, at);
  return copy;
}

/** Where a table starts, read off the directory the way the parser reads it. */
function tableOffset(bytes: Uint8Array, tag: string): number {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let i = 0; i < view.getUint16(4); i++) {
    const record = 12 + i * 16;
    const name = String.fromCharCode(...bytes.subarray(record, record + 4));
    if (name === tag) {
      return view.getUint32(record + 8);
    }
  }
  throw new Error(`no ${tag}`);
}

describe('reading the bundled font', () => {
  const font = parseFont(regular);

  it('should read the metrics a grid is laid out from', () => {
    expect(font.metrics).toMatchObject({
      ascender: 1020,
      descender: -300,
      lineGap: 0,
      unitsPerEm: 1000,
    });
    expect(font.metrics.underlinePosition).toBeLessThan(0);
    expect(font.metrics.strikeoutPosition).toBeGreaterThan(0);
  });

  it('should give every face the same advance, because it is monospace', () => {
    for (const path of Object.values(DEFAULT_FONTS)) {
      const face = parseFont(readFileSync(path));
      for (const char of 'A0 @é─') {
        expect(face.advance(face.glyphFor(char.codePointAt(0) ?? 0)), char).toBe(600);
      }
    }
  });

  it('should map what it has and answer .notdef for what it does not', () => {
    expect(font.glyphFor(0x41)).toBeGreaterThan(0);
    expect(font.glyphFor(0x4e_00)).toBe(0);
    // astral, which only a format 12 table can answer
    expect(font.glyphFor(0x1_f6_00)).toBe(0);
    expect(font.glyphFor(-1)).toBe(0);
  });

  it('should read a simple glyph into closed contours with curves', () => {
    const outline = font.outline(font.glyphFor(0x6f));
    // `o` is two contours, the outside and the counter
    expect(outline).toHaveLength(2);
    expect(outline.flat().some((p) => !p.onCurve)).toBe(true);
  });

  it('should resolve a composite into its components', () => {
    // `É` is `E` and an acute: one contour more than the `E` it is built on
    const e = font.outline(font.glyphFor(0x45));
    const accented = font.outline(font.glyphFor(0xc9));
    expect(accented.length).toBe(e.length + 1);
  });

  it('should read a space as a glyph with nothing to draw', () => {
    expect(font.outline(font.glyphFor(0x20))).toEqual([]);
  });

  it('should refuse a glyph the font does not have', () => {
    expect(() => font.outline(font.numGlyphs)).toThrow(FontError);
    expect(font.advance(font.numGlyphs)).toBe(0);
  });
});

describe('refusing a font it cannot read', () => {
  it('should name CFF rather than misread it', () => {
    expect(() => parseFont(patched(0, [0x4f, 0x54, 0x54, 0x4f]))).toThrow(/CFF/);
  });

  it('should refuse something that is not a font', () => {
    expect(() => parseFont(new TextEncoder().encode('not a font at all'))).toThrow(FontError);
    expect(() => parseFont(new Uint8Array(2))).toThrow(FontError);
  });

  it('should say which table points outside the file', () => {
    // `head`'s directory entry, given an offset past the end
    const view = new DataView(regular.buffer, regular.byteOffset, regular.byteLength);
    let record = -1;
    for (let i = 0; i < view.getUint16(4); i++) {
      if (String.fromCharCode(...regular.subarray(12 + i * 16, 16 + i * 16)) === 'head') {
        record = 12 + i * 16;
      }
    }
    expect(() => parseFont(patched(record + 8, [0x7f, 0xff, 0xff, 0xff]))).toThrow(/head/);
  });

  it('should refuse a truncated file with a FontError rather than a RangeError', () => {
    expect(() => parseFont(regular.subarray(0, 4096))).toThrow(FontError);
  });

  it('should refuse a units-per-em nobody could draw with', () => {
    const head = tableOffset(regular, 'head');
    expect(() => parseFont(patched(head + 18, [0, 0]))).toThrow(/units per em/);
  });
});
