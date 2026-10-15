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
  readonly eol: '\n' | '\r\n' | undefined;
  /** Whether it ended with a line break. */
  readonly trailing: boolean;
}

/** The shape a document written from nothing gets. */
export const FRESH: Shape = Object.freeze({ bom: false, eol: undefined, trailing: true });

/**
 * Reads a document's shape off its bytes, and hands back the text to parse.
 *
 * The line ending is whichever the **first** break in the file is, rather than
 * a count: a file is written by one editor, a mixed one is a file something has
 * already mangled, and picking a majority would rewrite the minority's lines
 * silently. One answer, taken from the first thing that said anything.
 *
 * @param text - The file's bytes as a string.
 * @returns The shape, and the text with the mark removed.
 */
export function shapeOf(text: string): { shape: Shape; xml: string } {
  const bom = text.startsWith(BOM);
  const xml = bom ? text.slice(BOM.length) : text;
  const eol = xml.includes('\r\n') ? '\r\n' : xml.includes('\n') ? '\n' : undefined;

  return {
    shape: { bom, eol, trailing: /[\n\r]$/.test(xml) },
    xml,
  };
}

/**
 * Puts a document's shape back onto what the serializer wrote.
 *
 * The line endings go back **first** and the trailing break after, because the
 * serializer emits `\n` and a `\r\n` document needs every one of them rewritten
 * before a trailing one is added -- the other order appends an `\n` that the
 * rewrite would then have had to find.
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
  let text = shape.eol === '\r\n' ? out.replaceAll('\n', '\r\n') : out;

  if (shape.trailing) {
    text += shape.eol ?? '\n';
  }

  return shape.bom ? BOM + text : text;
}
