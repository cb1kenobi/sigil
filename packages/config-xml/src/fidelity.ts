import type { Loss } from '@ttylabs/sigil/config';

/**
 * What a write would lose, asked of the **document** rather than of the format.
 *
 * Which is `WriteOptions.lossy`'s own rule and this is the store it was written
 * for: a DOM store writing a file that has no trivia in it loses nothing, and
 * refusing that write would be a guard firing on correct code. So the answer is
 * computed per file, by round-tripping the source against itself -- parse,
 * serialize, reapply the shape, compare. Equal means the field is **absent**,
 * which is how `layer.wouldLose?.length` reads it, and unequal means the
 * specific normalization is named.
 *
 * ## What `@xmldom/xmldom` 0.9.12 preserves, measured
 *
 * Over thirty-two documents, seventeen round-trip byte for byte -- comments, the
 * XML declaration, a DOCTYPE, CDATA sections, attribute order, processing
 * instructions, namespace prefixes, `xml:space`, a default namespace, and the
 * user's indentation. Which is six of the eight losses a reprinting writer has,
 * and is the whole reason this store writes at all.
 *
 * ## What it does not, which is the complete residual
 *
 * | what | becomes | kind |
 * | -- | -- | -- |
 * | `<a></a>` | `<a/>` | `formatting` |
 * | `a='1'` | `a="1"` | `formatting` |
 * | `<a b = "1"/>` | `<a b="1"/>` | `formatting` |
 * | `&#38;` | `&amp;` | `formatting` |
 * | `&apos;` and `&quot;` | `'` and `"` | `formatting` |
 * | a bare `>` in text | `&gt;` | `formatting` |
 * | a newline, tab or CR in an attribute value | a space | spec |
 * | NEL (U+0085) in text | a newline | spec |
 *
 * ## An internal DTD entity is **refused at read** rather than reported here
 *
 * A review round named it as the residual that matters, as a silent corruption
 * rather than a renormalization: `<!DOCTYPE a [<!ENTITY e "hi">]><a>&e;</a>`
 * serializes with `&amp;e;`, so the reference stops referring to the entity.
 * That is right about the serializer and it is not a `wouldLose` case, which is
 * measured rather than argued: `@xmldom/xmldom` reports **`entity not found`**
 * at the `error` level while parsing one, so the store refuses the document
 * where it was written.
 *
 * Which is the stronger answer and the reason is that the loss is not
 * cosmetic: the parser cannot expand the entity, so the *value* this store
 * would read is the four characters `&e;` where the document says `hi`. A
 * wrong value is not something to write down in a loss table and carry on
 * from. A declaration nothing references round-trips untouched -- also measured
 * -- so a document is refused for the reference rather than for the DOCTYPE.
 *
 * The last two rows are **required of every conforming parser**:
 * attribute-value normalization and line-ending normalization are in the XML
 * spec, so they are not this store's to avoid and a reader who hits one is
 * reading a document whose own bytes no conforming tool would preserve.
 *
 * CRLF and a trailing newline are **not** in the table, and that is a review
 * round's finding rather than an omission: they are detect-and-reapply, so a
 * check run on the raw serialize would report a loss every CRLF config does not
 * actually suffer and refuse unless somebody said `lossy` -- the guard firing on
 * correct code, again. `reshape()` runs first and then this compares.
 *
 * ## What it cannot see
 *
 * A read-time round trip answers "would re-serializing this document as it
 * stands lose anything", which is **not** a bound on what a `set()` will do. It
 * cannot see edit-induced loss: an unprefixed insert into a namespaced
 * document, or a CDATA section written over. Both of those are closed in
 * `write.ts` rather than reported here -- the first by `createElementNS`, the
 * second by diffing before touching anything -- which is the right place for
 * them, because a loss a store can avoid is one it should avoid rather than
 * report. An empty `wouldLose` is the honest answer to the question it asks.
 */

/** Where the residual is, so that a report can point at it. */
interface Residual {
  /** What `Loss.kind` says. */
  kind: string;
  /** What to look for in the source, as a pattern. */
  look: RegExp;
  /** What to say about it. */
  say: string;
}

/**
 * The residuals, each matched against the **source** rather than diffed out of
 * the comparison.
 *
 * A diff of two serializations says *that* they differ and not *what* about
 * them differs, and what a user can act on is the second. So the comparison
 * decides whether to report anything at all and these decide what to say,
 * which is the division `wouldLose` already implies by carrying a `kind` and a
 * `detail` rather than a pair of strings.
 */
const RESIDUALS: readonly Residual[] = [
  {
    kind: 'entity',
    // an entity declared in an internal DTD subset and then referenced. The
    // reference is what the serializer corrupts, so the declaration is what
    // says the document has one to corrupt
    look: /<!ENTITY\s/,
    say: 'an internal DTD entity reference is written back as literal text',
  },
  {
    kind: 'formatting',
    look: /<([^\s/>]+)([^>]*)><\/\1\s*>/,
    say: 'an empty paired tag becomes self-closing',
  },
  {
    kind: 'formatting',
    look: /=\s*'/,
    say: 'a single-quoted attribute value is rewritten with double quotes',
  },
  { kind: 'formatting', look: /\s=|=\s/, say: 'whitespace around an attribute’s = is dropped' },
  { kind: 'formatting', look: /&#/, say: 'a numeric character reference is rewritten by name' },
  {
    kind: 'formatting',
    look: /&apos;/,
    say: 'an &apos; reference is rewritten as a literal quote',
  },
  {
    kind: 'formatting',
    look: />(?:[^<]*[^<&\s])?[^<]*>[^<]*</,
    say: 'a bare > in text is escaped',
  },
  {
    kind: 'spec',
    look: /="[^"]*[\n\r\t]/,
    say: 'whitespace in an attribute value is normalized to a space, which the XML spec requires',
  },
  {
    kind: 'spec',
    look: /\u0085/,
    say: 'NEL is normalized to a newline, which the XML spec requires',
  },
];

/**
 * What a write of this document would lose, or nothing where it would lose
 * nothing.
 *
 * Compared against the document's **own bytes**, mark and all, rather than
 * against the body that was parsed: `reshape()` puts the mark back, so
 * comparing the reshaped output against the stripped body reports every
 * BOM-prefixed file as lossy -- which is the CRLF contradiction a review round
 * found, arriving through the third thing that is detect-and-reapply.
 *
 * @param source - The document's own bytes.
 * @param rendered - What a no-op write of it would produce, reshaped.
 * @returns The losses, or nothing.
 */
export function lossesOf(source: string, rendered: string): readonly Loss[] | undefined {
  if (rendered === source) {
    return undefined;
  }

  const out: Loss[] = [];

  for (const it of RESIDUALS) {
    const found = it.look.exec(source);
    if (!found) {
      continue;
    }
    out.push({
      detail: it.say,
      kind: it.kind,
      line: source.slice(0, found.index).split(/\r\n|[\n\r]/).length,
    });
  }

  // the documents differ and nothing above says why, which is a normalization
  // this table has not met. Reported rather than swallowed, because the
  // decision the lossless rule makes is about *whether* something is lost and
  // an unexplained difference is still something lost -- the table is what
  // makes a message actionable rather than what makes the answer true
  if (out.length === 0) {
    out.push({
      detail: 'the document does not survive a round trip through this parser unchanged',
      kind: 'formatting',
    });
  }

  return out;
}
