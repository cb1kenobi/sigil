import { contentOf } from './content.js';
import { escapeControls } from '@ttylabs/sigil/error-handler';

/**
 * The one well-formedness rule `@xmldom/xmldom` does not enforce, checked in one
 * scan of the source before the parser sees it (SIG-581, SIG-586, SIG-587).
 *
 * XML 1.0's `Char` production is
 * `#x9 | #xA | #xD | [#x20-#xD7FF] | [#xE000-#xFFFD] | [#x10000-#x10FFFF]`, so
 * a C0 control character other than tab, newline and carriage return, a
 * surrogate that is not half of a pair, U+FFFE and U+FFFF make a document not
 * well-formed **anywhere** in it -- a name, an attribute list, text, an
 * attribute value, a comment. `@xmldom/xmldom` 0.9.12 accepts all of them and,
 * between an element name and what follows, reads a C0 one as the whitespace
 * that ends the name: `<server` ESC `port="1"/>` is an element `server` with an
 * attribute `port`, which this store maps to `server.port` -- a config the
 * author did not write. Measured over those places and nowhere does the parser
 * report anything: it has no strict option for this, and `onError` is never
 * called, so a scan of the source is the only place the check can go. It is also
 * what gives the message a line and a column, which the parser cannot for text
 * it never flagged.
 *
 * A **numeric character reference** is the same rule said another way, and the
 * spec's `Legal Character` constraint is what makes it one: `&#1;`, `&#x1B;`,
 * `&#xD800;` and `&#xFFFF;` are refused for the same reason the characters are.
 * `@xmldom/xmldom` resolves each to the character, and `&#xD83D;&#xDE00;` to an
 * astral character built from two references that are each illegal. A reference
 * past U+10FFFF is refused too: the parser answers it with a character it made
 * up.
 *
 * ## References are found in the source, not in the parsed values
 *
 * The other shape was to walk the DOM after the parse and refuse a value holding
 * a character outside `Char`. It sees what a reference resolved to, and it
 * cannot see where: a text node has no line, so the message would be the one
 * thing the raw check was written to give and this one could not. A walk also
 * cannot tell `&#1;` from a raw character that was already refused, and it
 * misses the place the parser **discards** a character, which is why the raw
 * check is a scan in the first place. So the scan reads the source, where a
 * reference is five ordinary characters, and what it needs to know is which of
 * them are references -- which is a question about where markup is. A comment, a
 * CDATA section, a processing instruction and a DOCTYPE hold `&#1;` as text
 * that nobody resolves, so a document with one there is fine, and `contentOf()`
 * is what already answers where element content is: it is the blanking the
 * write-loss report uses, at the same offsets, and a second walk for the same
 * question would come to disagree about where a comment ends. A `<` cannot be in
 * an attribute value (the parser refuses it), so a region opener never hides
 * inside one.
 *
 * What a **raw** character is checked against is the whole source, comments and
 * CDATA included, because there it is the character itself and not a reference
 * to one.
 *
 * U+007F and the C1 range are legal in XML 1.0 and are **not** here.
 */

/**
 * Whether a code point is one XML 1.0's `Char` production does not allow.
 *
 * Code points rather than a character class, for the reason `represent.ts`'s
 * `badChar()` gives: a class of escapes is what `no-control-regex` is about, and
 * the answer is not a suppression. `badChar()` asks this and adds the characters
 * it refuses for the other reason, so there is one answer to "is this outside
 * `Char`", for the read and for the write.
 *
 * A surrogate here is **any** surrogate code point: asked of a code point out of
 * a string iterated by code point -- `badChar()`'s case -- only an unpaired one
 * is ever one, and asked of a number out of a reference every one is illegal.
 * The scan below pairs code units up itself before it asks.
 *
 * @param code - A code point, or what a numeric reference names.
 * @returns Whether it is outside `Char`.
 */
export function outsideChar(code: number): boolean {
  return (
    (code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) ||
    (code >= 0xd800 && code <= 0xdfff) ||
    code === 0xfffe ||
    code === 0xffff ||
    code > 0x10ffff
  );
}

/** Where a character outside `Char` is in a document. */
export interface ForbiddenAt {
  /**
   * What to call it in a message: `\x1B` for a C0 control character written
   * raw, `U+FFFE` for the rest. Never the character, which a terminal would act
   * on -- or, for a lone surrogate, print as U+FFFD.
   */
  readonly name: string;
  /** Whether the document holds the character or a numeric reference to it. */
  readonly via: 'raw' | 'reference';
  /** One-based. A line ends at a newline, a carriage return, or both together. */
  readonly line: number;
  /** One-based, counted in code points: a pair is one, and a lone surrogate is one. */
  readonly column: number;
}

/**
 * A numeric reference: decimal, or hex with a lowercase `x`, which is the only
 * one XML has and the only one the parser resolves (`&#X41;` is an error of its
 * own).
 */
const REFERENCE = /&#(?:x([0-9A-Fa-f]+)|([0-9]+));/g;

/** What a code point is called in a message. */
function nameOf(code: number, via: 'raw' | 'reference'): string {
  if (code > 0x10ffff) {
    return 'a code point above U+10FFFF';
  }
  if (via === 'raw' && code < 0x20) {
    return escapeControls(String.fromCharCode(code));
  }
  return `U+${code.toString(16).toUpperCase().padStart(4, '0')}`;
}

/** The one-based line and column of an offset, the column in code points. */
function locate(text: string, at: number): { line: number; column: number } {
  // a line ends at `\n`, `\r` or `\r\n`, which is XML's own line-end
  // normalization and what an editor counts
  const before = text.slice(0, at);
  const breaks = before.match(/\r\n|\r|\n/g);
  const start = Math.max(before.lastIndexOf('\n'), before.lastIndexOf('\r')) + 1;

  return {
    line: (breaks?.length ?? 0) + 1,
    column: Array.from(before.slice(start)).length + 1,
  };
}

/**
 * What a numeric reference names. A digit string too long for a number is
 * `Infinity`, which is above the last code point like any other number that big,
 * so a file of a megabyte of zeros and nines needs no cap of its own.
 */
function referenced(hex: string | undefined, decimal: string | undefined): number {
  return hex === undefined ? Number.parseInt(decimal as string, 10) : Number.parseInt(hex, 16);
}

/**
 * The first character outside `Char` XML 1.0 forbids, raw or as a numeric
 * reference, and where it is.
 *
 * One pass over the code units on the success path and nothing allocated, which
 * is what a read of every config file pays; the references are looked for only
 * in a document that holds a `&#` at all, since blanking the markup is a copy.
 * The line and the column are worked out only for the character that is found.
 *
 * @param text - The document, with any byte order mark already off.
 * @returns Where the first one is, or nothing where there is none.
 */
export function firstForbidden(text: string): ForbiddenAt | undefined {
  let at = -1;
  let code = 0;

  for (let i = 0; i < text.length; i++) {
    const unit = text.charCodeAt(i);

    // half of a pair is not forbidden, and the pair is one character: skipping
    // the second unit is what makes `\u{1F600}` read and `\uD83D` alone not
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = text.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        i++;
        continue;
      }
    }

    if (outsideChar(unit)) {
      at = i;
      code = unit;
      break;
    }
  }

  let via: 'raw' | 'reference' = 'raw';

  // only before the raw one, which is what "first" means
  if (text.includes('&#')) {
    const content = contentOf(text);
    REFERENCE.lastIndex = 0;

    for (
      let m = REFERENCE.exec(content);
      m && (at === -1 || m.index < at);
      m = REFERENCE.exec(content)
    ) {
      const named = referenced(m[1], m[2]);
      if (outsideChar(named)) {
        at = m.index;
        code = named;
        via = 'reference';
        break;
      }
    }
  }

  if (at === -1) {
    return undefined;
  }

  return { name: nameOf(code, via), via, ...locate(text, at) };
}
