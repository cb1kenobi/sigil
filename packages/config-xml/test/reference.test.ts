import { xml } from '../src/index.js';
import { absent, file, read } from './helpers.js';
import { basename } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * A numeric character reference to a character outside XML 1.0's `Char` is
 * refused, like the character itself (SIG-586).
 *
 * `&#1;` says the character instead of containing it, and `@xmldom/xmldom`
 * resolves it: the config held a control character that the raw scan of SIG-581
 * exists to keep out, written in a form the scan did not see. The `Legal
 * Character` well-formedness constraint says a reference must name a `Char`,
 * so the document is not well-formed either.
 */

/** What a read of a document says, or what it refused with. */
function said(text: string, name = 'config.xml'): string {
  try {
    xml(file(text, name)).readSync();
  } catch (error) {
    return (error as Error).message;
  }

  throw new Error('expected it to refuse');
}

/** The value `a` reads as, in text or in an attribute `b`. */
function valueOf(text: string): unknown {
  return xml(file(text)).readSync().value;
}

describe('a numeric character reference to a character outside Char', () => {
  it.each([
    ['a decimal C0 reference in text', '<config><a>x&#1;y</a></config>', 13, 'U+0001'],
    ['a hex C0 reference in text', '<config><a>x&#x1B;y</a></config>', 13, 'U+001B'],
    ['a lowercase hex digit', '<config><a>x&#x1b;y</a></config>', 13, 'U+001B'],
    ['a reference to NUL', '<config><a>x&#0;y</a></config>', 13, 'U+0000'],
    ['leading zeros', '<config><a>x&#x000001B;y</a></config>', 13, 'U+001B'],
    ['a reference in an attribute value', '<config><a b="x&#1;y"/></config>', 16, 'U+0001'],
    ['a single-quoted attribute value', `<config><a b='x&#x1B;y'/></config>`, 16, 'U+001B'],
    [
      'a reference beside text in an element with attributes',
      '<config><a c="1">&#7;</a></config>',
      18,
      'U+0007',
    ],
  ])('should be refused: %s, naming the file and the place', (_what, text, column, name) => {
    const refused = said(text);

    expect(refused).toContain('Failed to parse ');
    expect(refused).toContain(basename('config.xml'));
    expect(refused).toContain(`line 1, column ${column}`);
    expect(refused).toContain(`the character reference to ${name} is not allowed in XML`);
  });

  it('should be refused, rather than read as the control character', () => {
    // the defect itself: this read as `{ a: 'x<U+0001>y' }`
    expect(() => xml(file('<config><a>x&#1;y</a></config>')).readSync()).toThrow(/Failed to parse/);
  });

  it('should be refused for every C0 code XML 1.0 forbids, in both spellings', () => {
    for (let code = 0; code < 0x20; code++) {
      if (code === 0x09 || code === 0x0a || code === 0x0d) {
        continue;
      }
      for (const reference of [`&#${code};`, `&#x${code.toString(16)};`]) {
        expect(said(`<config><a>${reference}</a></config>`), reference).toMatch(
          /Failed to parse .*line 1, column 12: the character reference to U\+00[0-9A-F]{2} is not allowed in XML/
        );
      }
    }
  });

  it('should count the line, and the column in code points, up to the reference', () => {
    expect(said('<config>\r\n<a>1</a>\r\n<b>&#1;</b></config>')).toContain('line 3, column 4');
    expect(said('<config><a>\u{1F600}&#1;</a></config>')).toContain('line 1, column 13');
  });

  it('should name the first of a raw character and a reference, whichever comes first', () => {
    const ESC = String.fromCharCode(0x1b);

    expect(said(`<config><a>&#1;${ESC}</a></config>`)).toMatch(
      /column 12: the character reference to U\+0001/
    );
    expect(said(`<config><a>${ESC}&#1;</a></config>`)).toMatch(
      /column 12: the character \\x1B is not allowed/
    );
  });

  it('should not read a reference past the last code point as whatever it overflows to', () => {
    // `&#x110000;` came back as two U+DC00 and a reference of twenty digits as a
    // character nobody wrote
    expect(said('<config><a>&#x110000;</a></config>')).toContain('above U+10FFFF');
    expect(said('<config><a>&#99999999999999999999;</a></config>')).toContain('above U+10FFFF');
  });

  it('should not echo a reference of any length', () => {
    const zeros = '0'.repeat(5000);
    const refused = said(`<config><a>&#${zeros}1;</a></config>`);

    expect(refused).toContain('the character reference to U+0001');
    expect(refused.length).toBeLessThan(500);
  });

  it('should be refused by a write as well, leaving the file as it was', () => {
    const text = '<config><a>x&#1;y</a></config>';
    const path = file(text);

    expect(() => xml(path).writeSync({ b: '1' })).toThrow(/Failed to parse .*line 1, column 13/);
    expect(read(path)).toBe(text);
  });
});

describe('a numeric character reference to a character inside Char', () => {
  it.each([
    ['&#9;', '\t'],
    ['&#10;', '\n'],
    ['&#13;', '\r'],
    ['&#x41;', 'A'],
    ['&#65;', 'A'],
    ['&#x7F;', '\u007f'],
    ['&#x85;', '\u0085'],
    ['&#x9F;', '\u009f'],
    ['&#xD7FF;', String.fromCharCode(0xd7ff)],
    ['&#xE000;', String.fromCharCode(0xe000)],
    ['&#xFFFD;', String.fromCharCode(0xfffd)],
    ['&#x1F600;', '\u{1F600}'],
    ['&#128512;', '\u{1F600}'],
    ['&#x10000;', '\u{10000}'],
    ['&#x10FFFF;', '\u{10FFFF}'],
    ['&#0000000000000000065;', 'A'],
  ])('should still read %s in text and in an attribute value', (reference, character) => {
    // an attribute value normalizes a tab, a newline and a carriage return to a
    // space, and text keeps a tab and normalizes a carriage return: neither is
    // what is under test, which is that the document is read at all
    const text = `<config><a>x${reference}y</a><c d="x${reference}y"/></config>`;

    expect(() => valueOf(text), reference).not.toThrow();

    if (!['&#9;', '&#10;', '&#13;'].includes(reference)) {
      expect(valueOf(text)).toStrictEqual({
        a: `x${character}y`,
        c: { d: `x${character}y` },
      });
    }
  });
});

describe('what only looks like a reference', () => {
  // a comment, a CDATA section, a processing instruction and a DOCTYPE hold the
  // five characters as text, and nobody resolves them
  it.each([
    ['a comment', '<config><!-- &#1; &#xFFFF; &#xD800; --><a>1</a></config>'],
    ['a CDATA section', '<config><a><![CDATA[&#1; &#xFFFF;]]></a></config>'],
    ['a processing instruction', '<config><?target &#1; &#xFFFF;?><a>1</a></config>'],
    [
      'an unreferenced entity declaration',
      '<!DOCTYPE config [<!ENTITY e "&#1;">]><config><a>1</a></config>',
    ],
  ])('should be read, in %s', (_where, text) => {
    expect(() => valueOf(text)).not.toThrow();
  });

  it('should still find one after a region that held one', () => {
    expect(said('<config><!-- &#65; --><a>&#1;</a></config>')).toContain('line 1, column 26');
    expect(said('<config><a><![CDATA[&#65;]]>&#1;</a></config>')).toContain('column 29');
  });

  it('should leave a malformed reference to the parser', () => {
    // not a reference at all, so not this check's to say: `&#X41;` is the
    // parser's own error and `&#;` is read as text
    expect(said('<config><a>&#X41;</a></config>')).toContain('Failed to parse');
    expect(said('<config><a>&#X41;</a></config>')).not.toContain('is not allowed in XML');
    expect(said('<config><a>&#X1B;</a></config>')).not.toContain('is not allowed in XML');
    expect(() => valueOf('<config><a>&#;</a></config>')).not.toThrow();
  });
});

describe('what this store writes, which its own read must never refuse', () => {
  it('should not write a character a reference to it would have been refused for', () => {
    // the write side refuses the same set: one definition, asked by both
    for (const value of ['\u0001', '\u001b']) {
      const path = absent();

      expect(() => xml(path).writeSync({ a: `x${value}y` })).toThrow();
      expect(() => read(path)).toThrow(/ENOENT/);
    }
  });
});
