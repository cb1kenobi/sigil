import { xml } from '../src/index.js';
import { firstForbidden, outsideChar } from '../src/wellformed.js';
import { absent, file, read } from './helpers.js';
import { tempDir } from './temp.js';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * U+FFFE, U+FFFF and a surrogate that is not half of a pair are outside XML
 * 1.0's `Char`, and the store refuses a document that holds one (SIG-587), raw
 * or as a numeric reference.
 *
 * A raw lone surrogate cannot reach the store through a file at all: it is
 * `ED A0 80` or its kin once it is UTF-8, and core's fatal decoder refuses that
 * as invalid UTF-8 before anything here is asked. So the routes that exist are
 * the two `&#...;` spellings and the two raw noncharacters, and an encoded
 * surrogate is pinned as refused by core -- the scan's own handling of a lone
 * surrogate is pinned directly, because a route nobody can take today is one a
 * later change to the reader could open.
 */

/** A file of exactly these bytes. */
function bytes(parts: (string | number[])[]): string {
  const path = join(tempDir('sigil-xml-'), 'config.xml');
  writeFileSync(
    path,
    Buffer.concat(parts.map((p) => (typeof p === 'string' ? Buffer.from(p) : Buffer.from(p))))
  );
  return path;
}

/** What a read of a file says, or what it refused with. */
function refusal(path: string): string {
  try {
    xml(path).readSync();
  } catch (error) {
    return (error as Error).message;
  }

  throw new Error('expected it to refuse');
}

/** The characters with these code units, built rather than written. */
const chr = (...codes: number[]): string => String.fromCharCode(...codes);

const FFFE = [0xef, 0xbf, 0xbe];
const FFFF = [0xef, 0xbf, 0xbf];

describe('U+FFFE and U+FFFF, written raw', () => {
  it.each([
    ['U+FFFE', FFFE, 'U+FFFE'],
    ['U+FFFF', FFFF, 'U+FFFF'],
  ])('should refuse %s in text, an attribute, a comment and a CDATA section', (_n, utf8, name) => {
    const places = [
      ['text', '<config><a>x', 'y</a></config>', 13],
      ['an attribute value', '<config><a b="x', 'y"/></config>', 16],
      ['a comment', '<config><!-- x', ' --><a>1</a></config>', 15],
      ['a CDATA section', '<config><a><![CDATA[x', ']]></a></config>', 22],
      ['an element name', '<config><a', 'b>1</ab></config>', 11],
    ] as const;

    for (const [place, before, after, column] of places) {
      const refused = refusal(bytes([before, utf8, after]));

      expect(refused, place).toMatch(/^Failed to parse .*config\.xml: line 1, column \d+: /);
      expect(refused, place).toContain(
        `line 1, column ${column}: the character ${name} is not allowed`
      );
      // named, not echoed
      expect(refused, place).not.toMatch(new RegExp(`[${chr(0xfffe)}${chr(0xffff)}]`, 'u'));
    }
  });

  it('should refuse a write over a file holding one, leaving it as it was', () => {
    const path = bytes(['<config><a>x', FFFE, 'y</a></config>']);

    expect(() => xml(path).writeSync({ b: '1' })).toThrow(/Failed to parse .*U\+FFFE/);
    expect(read(path)).toBe(`<config><a>x${chr(0xfffe)}y</a></config>`);
  });

  it('should still read U+FFFD, which is the last character Char allows below U+10000', () => {
    expect(xml(file(`<config><a>x${chr(0xfffd)}y</a></config>`)).readSync().value).toStrictEqual({
      a: `x${chr(0xfffd)}y`,
    });
  });
});

describe('U+FFFE, U+FFFF and a surrogate, as a numeric reference', () => {
  it.each([
    ['&#xFFFE;', 'U+FFFE'],
    ['&#xFFFF;', 'U+FFFF'],
    ['&#65534;', 'U+FFFE'],
    ['&#65535;', 'U+FFFF'],
    ['&#xD800;', 'U+D800'],
    ['&#xDBFF;', 'U+DBFF'],
    ['&#xDC00;', 'U+DC00'],
    ['&#xdfff;', 'U+DFFF'],
    ['&#55296;', 'U+D800'],
  ])('should refuse %s in text and in an attribute value', (reference, name) => {
    for (const [text, column] of [
      [`<config><a>x${reference}y</a></config>`, 13],
      [`<config><a b="x${reference}y"/></config>`, 16],
    ] as const) {
      const refused = refusal(file(text));

      expect(refused).toContain('Failed to parse ');
      expect(refused).toContain(
        `line 1, column ${column}: the character reference to ${name} is not allowed in XML`
      );
    }
  });

  it('should refuse a pair of references, each of which is a surrogate on its own', () => {
    // `&#xD83D;&#xDE00;` reads as one astral character, and each half is
    // illegal: the spec's constraint is on the reference
    expect(refusal(file('<config><a>&#xD83D;&#xDE00;</a></config>'))).toContain(
      'column 12: the character reference to U+D83D'
    );
  });

  it('should read the astral character as one reference, and raw as a pair', () => {
    expect(xml(file('<config><a>&#x1F600;</a></config>')).readSync().value).toStrictEqual({
      a: '\u{1F600}',
    });
    expect(
      xml(bytes(['<config><a>', [0xf0, 0x9f, 0x98, 0x80], '</a></config>'])).readSync().value
    ).toStrictEqual({ a: '\u{1F600}' });
  });
});

describe('a lone surrogate, written raw, which is the route a file does not have', () => {
  it.each([
    ['a high surrogate', [0xed, 0xa0, 0x80]],
    ['the last high surrogate', [0xed, 0xaf, 0xbf]],
    ['a low surrogate', [0xed, 0xb0, 0x80]],
    ['the last low surrogate', [0xed, 0xbf, 0xbf]],
    // CESU-8: a pair written as two three-byte surrogates, which is not UTF-8
    ['a pair written as two three-byte sequences', [0xed, 0xa0, 0xbd, 0xed, 0xb8, 0x80]],
  ])('should be refused as invalid UTF-8 before the store sees it: %s', (_what, encoded) => {
    const path = bytes(['<config><a>', encoded, '</a></config>']);
    const refused = refusal(path);

    expect(refused).toMatch(
      /^Failed to read .*config\.xml: it is not UTF-8, the first invalid byte is at offset 11$/
    );
  });

  it('should be refused by an async read and by a write too', async () => {
    const path = bytes(['<config><a>', [0xed, 0xa0, 0x80], '</a></config>']);

    await expect(xml(path).read()).rejects.toThrow(/it is not UTF-8/);
    expect(() => xml(path).writeSync({ b: '1' })).toThrow(/it is not UTF-8/);
  });

  it('should be refused by the scan itself, which is what a later change to the reader meets', () => {
    // `firstForbidden()` is handed a string, and a string can hold one however
    // the bytes could not: this is the half no file reaches today
    expect(firstForbidden('<a>\ud800</a>')).toMatchObject({
      name: 'U+D800',
      via: 'raw',
      column: 4,
    });
    expect(firstForbidden('<a>\udc00</a>')).toMatchObject({ name: 'U+DC00', column: 4 });
    // a high surrogate at the very end, and one followed by another high one
    expect(firstForbidden('<a>\ud83d')).toMatchObject({ name: 'U+D83D', column: 4 });
    expect(firstForbidden(`<a>${chr(0xd83d, 0xd83d, 0xde00)}`)).toMatchObject({
      name: 'U+D83D',
      column: 4,
    });
    // a low one after a pair is lone
    expect(firstForbidden(`<a>${chr(0xd83d, 0xde00, 0xde00)}`)).toMatchObject({
      name: 'U+DE00',
      column: 5,
    });
  });

  it('should count a pair as one column and a lone surrogate as one', () => {
    expect(firstForbidden('<a>\u{1F600}\u{1F600}\ud800')).toMatchObject({ line: 1, column: 6 });
    expect(firstForbidden('<a>\n\u{1F600}\ud800')).toMatchObject({ line: 2, column: 2 });
    expect(firstForbidden('<a>\ud800\ud800')).toMatchObject({ column: 4 });
  });

  it('should not refuse a pair', () => {
    expect(firstForbidden('<a>\u{1F600}\u{10FFFF}\u{10000}</a>')).toBeUndefined();
  });
});

describe('one definition of a character outside Char', () => {
  it('should be the one the write path asks as well', () => {
    const ask = xml(absent()).canRepresent as (v: unknown, p: string) => true | string;

    for (const code of [0x01, 0x1b, 0xd800, 0xdbff, 0xdc00, 0xdfff, 0xfffe, 0xffff]) {
      expect(outsideChar(code), `U+${code.toString(16)}`).toBe(true);
      expect(ask(`a${String.fromCharCode(code)}b`, 'x'), `U+${code.toString(16)}`).not.toBe(true);
    }

    for (const code of [0x09, 0x0a, 0x0d, 0x20, 0x7f, 0x9f, 0xd7ff, 0xe000, 0xfffd]) {
      expect(outsideChar(code), `U+${code.toString(16)}`).toBe(false);
    }
    expect(outsideChar(0x10ffff)).toBe(false);
    expect(outsideChar(0x110000)).toBe(true);
  });

  it('should refuse a write of U+FFFE, U+FFFF and a lone surrogate, creating nothing', () => {
    for (const value of [chr(0xfffe), chr(0xffff), chr(0xd800), chr(0xdfff)]) {
      const path = absent();

      expect(() => xml(path).writeSync({ a: `x${value}y` })).toThrow();
      expect(() => read(path)).toThrow(/ENOENT/);
    }
  });
});
