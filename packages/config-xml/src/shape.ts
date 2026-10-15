/**
 * What the serializer normalizes away and this puts back.
 *
 * Three things, each measured against `@xmldom/xmldom` 0.9.12 rather than
 * assumed, and each the same detect-and-reapply: a byte order mark, CRLF line
 * endings, and a trailing newline after the root. None of them is content, all
 * three are things an editor or a platform put there, and a write that dropped
 * one would show up in a diff as every line of the file having changed.
 *
 * The **BOM** is the one that is not merely cosmetic. Measured: `U+FEFF <a/>`
 * parses, reports an `error` through `onError` -- "Unexpected content outside
 * root element" -- and the mark survives into the output as a text node
 * *outside* the root, which is not where an encoding marker belongs. And
 * `U+FEFF <?xml ...?>` **throws**, because the declaration is no longer at
 * position 0. So stripping it before the parse is what makes a BOM-prefixed
 * file readable at all, and reapplying it is what keeps it one.
 *
 * Nothing in here is translated: it throws nothing.
 */

/**
 * The byte order mark, escaped rather than written raw.
 *
 * Which is this repository's own rule about source and is the one it keeps
 * rediscovering: a raw U+FEFF is invisible in an editor and in a diff, so the
 * damage it does is paid by whoever reads it. `oxlint`'s
 * `no-irregular-whitespace` is what caught four of them in this package's
 * comments -- `test/sources.test.ts` checks C0, `DEL` and C1, and a byte order
 * mark is a *format* character rather than a control one, which that file's own
 * entry in AGENTS.md already records as a gap. It is closed now, for the mark
 * alone.
 */
const BOM = '\uFEFF';

/** What a document's bytes carry that its DOM does not. */
export interface Shape {
  /** Whether it began with a byte order mark. */
  readonly bom: boolean;
  /** The line ending to write, or nothing where the document had no line break. */
  readonly eol: '\n' | '\r' | '\r\n' | undefined;
  /**
   * The run of line breaks the document ended with, or nothing.
   *
   * The whole run rather than a boolean, which costs the same and removes a
   * refusal: a file ending in a blank line is reported as a loss by a boolean,
   * because the serializer drops everything after the root and the reapply puts
   * back one break where there were two. Measured.
   */
  readonly trailing: string | undefined;
}

/** The shape a document written from nothing gets. */
export const FRESH: Shape = Object.freeze({ bom: false, eol: undefined, trailing: '\n' });

/**
 * Reads a document's shape off its bytes, and hands back the text to parse.
 *
 * The line ending is **CRLF where the document holds one at all**, rather than
 * whichever came first: a file is written by one editor, so a mixed one is
 * already mangled and either answer rewrites somebody's lines -- and that is
 * reported as a loss either way, so what is left to pick is the simpler rule.
 *
 * A **carriage return alone** is the third flavour and is kept rather than
 * normalized, which is three characters and removes a refusal: without it an
 * old Mac file reports a loss and cannot be written to without `lossy`, for a
 * line ending that is merely extinct rather than wrong. Which is the opposite
 * trade from `LINE_END`'s own entry in the runtime, and for the stated reason:
 * there the failure is **silent**, and here it is reported.
 *
 * @param text - The file's bytes as a string.
 * @returns The shape, and the text with the mark removed.
 */
export function shapeOf(text: string): { shape: Shape; xml: string } {
  const bom = text.startsWith(BOM);
  const xml = bom ? text.slice(BOM.length) : text;
  const eol = xml.includes('\r\n')
    ? '\r\n'
    : xml.includes('\n')
      ? '\n'
      : xml.includes('\r')
        ? '\r'
        : undefined;

  return {
    shape: { bom, eol, trailing: /[\n\r]+$/.exec(xml)?.[0] },
    xml,
  };
}

/**
 * Puts a document's shape back onto what the serializer wrote.
 *
 * The line endings go back **first** and the trailing run after, because the
 * serializer emits `\n` and a `\r\n` document needs every one of them rewritten
 * before a trailing one is added -- the other order appends an `\n` that the
 * rewrite would then have had to find. The run is the document's **own** bytes
 * rather than one break of the detected flavour, which is what makes a file
 * ending in a blank line come back ending in one.
 *
 * `replaceAll('\n', eol)` is safe rather than lucky: the serializer emits no
 * `\r` of its own. A `\r` inside *text* is one the parser already normalized to
 * `\n` on the way in, which is spec-mandated and is in the loss table; a `\r`
 * inside an *attribute* value it normalized to a space, which is also the
 * spec's. So there is no surviving `\r` for this to double.
 *
 * @param out - What the serializer wrote.
 * @param shape - The shape to restore.
 * @returns The bytes to write.
 */
export function reshape(out: string, shape: Shape): string {
  const text = shape.eol && shape.eol !== '\n' ? out.replaceAll('\n', shape.eol) : out;

  return (shape.bom ? BOM : '') + text + (shape.trailing ?? '');
}
