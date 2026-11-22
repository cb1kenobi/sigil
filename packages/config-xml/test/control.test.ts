import { xml } from '../src/index.js';
import { absent, file, read } from './helpers.js';
import { basename } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * A C0 control character is not XML 1.0, and the store refuses a document that
 * holds one (SIG-581).
 *
 * `@xmldom/xmldom` reads one between an element name and what follows as the
 * whitespace that ends the name, so `<server`, ESC, `port="1"/>` was an element
 * `server` with an attribute `port` and the store mapped it to `server.port`: a
 * config its author did not write. The characters are built with
 * `String.fromCharCode()` rather than written as escapes, so that nothing between
 * an editor and this file can turn one into the raw byte.
 */

/** The character with a code, built rather than written. */
const char = (code: number): string => String.fromCharCode(code);

const ESC = char(0x1b);

/** What a read of a document says, or what it refused with. */
function said(text: string, name = 'config.xml'): string {
  try {
    xml(file(text, name)).readSync();
  } catch (error) {
    return (error as Error).message;
  }

  throw new Error('expected it to refuse');
}

/** Every C0 code XML 1.0 forbids: all of them but tab, newline and carriage return. */
const FORBIDDEN = Array.from({ length: 0x20 }, (_, code) => code).filter(
  (code) => code !== 0x09 && code !== 0x0a && code !== 0x0d
);

describe('a document holding a C0 control character', () => {
  /**
   * Each place `xmldom` accepts one, measured: the first two are the ones it
   * reads as whitespace, so the document means something else; the next two
   * keep the character and put it in a value; the last two it already refuses
   * with a message of its own, which this check replaces with one that names the
   * character and the place.
   */
  it.each([
    ['after an element name', `<config><server${ESC}port="1"/></config>`, 1, 16],
    ['between two attributes', `<config><server a="1"${ESC}b="2"/></config>`, 1, 22],
    ['before the end of a tag', `<config><server a="1"${ESC}/></config>`, 1, 22],
    ['in an attribute value', `<config><a b="x${ESC}y"/></config>`, 1, 16],
    ['in text', `<config><a>x${ESC}y</a></config>`, 1, 13],
    ['in a comment', `<config><!-- x${ESC}y --><a>1</a></config>`, 1, 15],
    ['in a CDATA section', `<config><a><![CDATA[x${ESC}y]]></a></config>`, 1, 22],
    ['on a later line', `<config>\n  <a>1</a>\n  <b>x${ESC}y</b>\n</config>`, 3, 7],
  ])('should be refused %s, naming the file and the place', (_place, text, line, column) => {
    const refused = said(text);

    expect(refused).toContain(`Failed to parse `);
    expect(refused).toContain(basename(`config.xml`));
    expect(refused).toContain(`line ${line}, column ${column}`);
    expect(refused).toContain('\\x1B');
  });

  it('should be refused, rather than read as a different config', () => {
    // the defect itself: this read as `{ server: { port: '1' } }`
    expect(() => xml(file(`<config><server${ESC}port="1"/></config>`)).readSync()).toThrow(
      /Failed to parse/
    );
  });

  it('should be refused for every C0 character XML 1.0 forbids, NUL included', () => {
    for (const code of FORBIDDEN) {
      const refused = said(`<config><a${char(code)}b="1"/></config>`);

      expect(refused, `U+${code.toString(16).padStart(4, '0')}`).toMatch(
        /Failed to parse .*line 1, column 11: the character \\x[0-9A-F]{2} is not allowed in XML/
      );
    }
  });

  it('should not echo the character in the message', () => {
    const refused = said(`<config><a>${ESC}]0;PWNED${char(0x07)}</a></config>`);

    expect(refused).toContain('\\x1B is not allowed');
    expect(refused).not.toMatch(/\p{Cc}/u);
  });

  // a file name holding a control character cannot be created on Windows, which
  // is why `path-escape.test.ts` skips there too
  it.skipIf(process.platform === 'win32')('should not echo one in the file name either', () => {
    const refused = said(`<config><a>${ESC}</a></config>`, `a${ESC}b.xml`);

    expect(refused).toContain('a\\x1Bb.xml');
    expect(refused).not.toMatch(/\p{Cc}/u);
  });

  it('should not read a file of nothing but a control character as an empty config', () => {
    // `trim()` counts the vertical tab and the form feed as whitespace and XML
    // does not: the file was read as `{}` and a write replaced it
    const vt = char(0x0b) + char(0x0c);
    const path = file(vt);

    expect(() => xml(path).readSync()).toThrow(/Failed to parse .*line 1, column 1/);
    expect(() => xml(path).writeSync({ a: '1' })).toThrow(/Failed to parse/);
    expect(read(path)).toBe(vt);
  });

  it('should count a line end of any kind once, and a code point as one column', () => {
    // CRLF is one line end, a lone CR is another, and an astral character is one
    // column rather than the two code units it is stored as
    expect(said(`<config>\r\n<a>1</a>\r\n<b>${ESC}</b></config>`)).toContain('line 3, column 4');
    expect(said(`<config>\r<a>1</a>\r<b>${ESC}</b></config>`)).toContain('line 3, column 4');
    expect(said(`<config><a>\u{1F600}${ESC}</a></config>`)).toContain('line 1, column 13');
  });

  it('should be located without counting a byte order mark as a column', () => {
    expect(said(`${char(0xfeff)}<config><a>${ESC}</a></config>`)).toContain('line 1, column 12');
  });

  it('should be refused by a write as well, leaving the file as it was', () => {
    // every write parses what is on disk first, so a file the read refuses is a
    // file nothing is written over
    const text = `<config><server${ESC}port="1"/></config>`;
    const path = file(text);

    expect(() => xml(path).writeSync({ a: '1' })).toThrow(/Failed to parse .*line 1, column 16/);
    expect(read(path)).toBe(text);
  });
});

describe('what XML 1.0 allows below U+0020, and above it', () => {
  it('should read a tab, a newline and a carriage return', () => {
    expect(xml(file(`<config>\r\n\t<a\tb="1"/>\n</config>`)).readSync().value).toStrictEqual({
      a: { b: '1' },
    });
  });

  it('should read DEL and the C1 range, which the Char production allows', () => {
    // the whole of U+007F to U+009F is inside `[#x20-#xD7FF]`; NEL is read
    // as a line end by the parser, which is a different matter and is in the
    // README's table
    for (const code of [0x7f, 0x80, 0x9b, 0x9f]) {
      expect(
        xml(file(`<config><a>x${char(code)}y</a></config>`)).readSync().value,
        `U+${code.toString(16)}`
      ).toStrictEqual({ a: `x${char(code)}y` });
    }
  });
});

describe('what this store writes, which its own read must never refuse', () => {
  /** Every C0 code, the three allowed ones included. */
  const C0 = Array.from({ length: 0x20 }, (_, code) => code);

  it('should refuse a forbidden control in a value at set(), so it is never written', () => {
    for (const code of FORBIDDEN) {
      const store = xml(absent());
      const held = (store.canRepresent as (v: unknown, p: string) => true | string)(
        `a${char(code)}b`,
        'x'
      );

      expect(held, `U+${code.toString(16)}`).not.toBe(true);
    }
  });

  it('should refuse a forbidden control in a key and in a path segment', () => {
    for (const code of FORBIDDEN) {
      const store = xml(absent());
      const ask = store.canRepresent as (v: unknown, p: string) => true | string;

      expect(ask('v', `a${char(code)}b`), `segment U+${code.toString(16)}`).not.toBe(true);
      expect(ask({ [`a${char(code)}b`]: 'v' }, ''), `key U+${code.toString(16)}`).not.toBe(true);
    }
  });

  it('should refuse a write the format cannot hold before it touches the file', () => {
    for (const code of FORBIDDEN) {
      const path = absent();
      const store = xml(path);

      expect(() => store.writeSync({ a: `x${char(code)}y` }), `value U+${code}`).toThrow();
      expect(() => store.writeSync({ [`a${char(code)}b`]: '1' }), `key U+${code}`).toThrow();
      // nothing was created
      expect(() => read(path)).toThrow(/ENOENT/);
    }
  });

  it('should read back whatever it did write, for every C0 character in every place', () => {
    // the invariant the ticket asks for: nothing the write path accepts is a
    // document the read then refuses. Asked of every C0 code -- the three XML
    // keeps included -- as a value, a key, and the root, over a file that exists
    for (const code of C0) {
      for (const make of [
        (c: string) => ({ a: `x${c}y` }),
        (c: string) => ({ [`a${c}b`]: 'v' }),
        (c: string) => ({ a: { [`b${c}`]: 'v' } }),
      ]) {
        const path = file(`<config><keep>1</keep></config>`);
        const store = xml(path);

        try {
          store.writeSync({ keep: '1', ...make(char(code)) }, { lossy: true });
        } catch {
          // refused where it was written, which is the other acceptable answer
          continue;
        }

        expect(() => xml(path).readSync(), `U+${code.toString(16)}`).not.toThrow();
      }
    }
  });

  it('should refuse a root element name holding one', () => {
    for (const code of FORBIDDEN) {
      expect(() => xml(absent(), { root: `a${char(code)}b` })).toThrow(/not a usable XML root/);
    }
  });
});
