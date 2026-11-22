/**
 * The one well-formedness rule `@xmldom/xmldom` does not enforce, checked in one
 * scan of the source before the parser sees it (SIG-581).
 *
 * XML 1.0's `Char` production allows tab, newline and carriage return and nothing
 * else below U+0020, so a C0 control character **anywhere** in a document --
 * a name, an attribute list, text, an attribute value, a comment -- makes it not
 * well-formed. `@xmldom/xmldom` 0.9.12 accepts most of those places and, between
 * an element name and what follows, reads one as the whitespace that ends the
 * name: `<server` ESC `port="1"/>` is an element `server` with an attribute
 * `port`, which this store maps to `server.port` -- a config the author did not
 * write. Measured over those places and nowhere does the parser report anything:
 * it has no strict option for this, and `onError` is never called, so a scan of
 * the source is the only place the check can go. It is also what gives the
 * message a line and a column, which the parser cannot for text it never flagged.
 *
 * U+007F and the C1 range are legal in XML 1.0 and are **not** here.
 */

/**
 * Whether a code point is a C0 control character XML 1.0 forbids.
 *
 * Code points rather than a character class, for the reason `represent.ts`'s
 * `badChar()` gives: a class of escapes is what `no-control-regex` is about, and
 * the answer is not a suppression. `badChar()` asks this and adds the characters
 * it refuses for the other reasons, so there is one answer to "is this a
 * forbidden control".
 *
 * @param code - A code point.
 * @returns Whether it is below U+0020 and is not tab, newline or carriage return.
 */
export function forbiddenControl(code: number): boolean {
  return code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d;
}

/** Where a forbidden control character is in a document. */
export interface ControlAt {
  /** The character itself, to be escaped before it is quoted. */
  readonly char: string;
  /** One-based. A line ends at a newline, a carriage return, or both together. */
  readonly line: number;
  /** One-based, counted in characters rather than code units. */
  readonly column: number;
}

/**
 * The first C0 control character XML 1.0 forbids, and where it is.
 *
 * One pass over the code units on the success path and nothing allocated, which
 * is what a read of every config file pays. The line and the column are worked
 * out only for the character that is found.
 *
 * @param text - The document, with any byte order mark already off.
 * @returns Where the first one is, or nothing where there is none.
 */
export function firstControl(text: string): ControlAt | undefined {
  for (let i = 0; i < text.length; i++) {
    if (!forbiddenControl(text.charCodeAt(i))) {
      continue;
    }

    // a line ends at `\n`, `\r` or `\r\n`, which is XML's own line-end
    // normalization and what an editor counts
    const before = text.slice(0, i);
    const breaks = before.match(/\r\n|\r|\n/g);
    const start = Math.max(before.lastIndexOf('\n'), before.lastIndexOf('\r')) + 1;

    return {
      char: text.charAt(i),
      line: (breaks?.length ?? 0) + 1,
      column: Array.from(before.slice(start)).length + 1,
    };
  }

  return undefined;
}
