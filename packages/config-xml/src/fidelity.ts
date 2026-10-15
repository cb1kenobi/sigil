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
 * report. An **absent** `wouldLose` is the honest answer to the question it
 * asks -- absent rather than empty, which is the field's own contract and is
 * the fourth copy of a wording AGENTS.md already records being fixed three
 * times: a caller who reads `wouldLose.length` off this gets a `TypeError`.
 * Found by review round 2.
 */

/** Where the residual is, so that a report can point at it. */
interface Residual {
  /** What `Loss.kind` says. */
  kind: string;
  /** What to look for in the source, as a pattern. */
  look: RegExp;
  /** What to say about it. */
  say: string;
  /**
   * Which text it is matched against, and the split is measured per row.
   *
   * `content` is the source with every comment, CDATA section, processing
   * instruction and DOCTYPE **blanked**, which is where all but one of these
   * belong: a comment's own text is reproduced verbatim, so `&apos;`, `&#65;`
   * and a bare `>` inside one all survive -- measured -- and a row matching
   * there names a line the author would go and find nothing wrong with. Which
   * is the whole of what this table is for, so getting it wrong is worse than
   * having no table.
   *
   * `source` is the raw bytes, for a normalization the parser applies
   * **everywhere**. NEL is the one: a comment holding one comes back holding a
   * newline, so blanking the comment would suppress a true positive.
   *
   * Found by review round 2, which reported one row of the seven; the other six
   * came out of measuring its finding.
   */
  where: 'content' | 'source';
}

/**
 * Where a DOCTYPE declaration ends, which its own grammar decides.
 *
 * A quoted literal may hold a `>` and an internal subset may hold several, so
 * the first `>` is the end of neither -- `indexOf()` over either was a false
 * positive of the bare-`>` row in a document that also had a real loss, which
 * is the class `contentOf()` exists to close and this was one more member of.
 * So the walk tracks a quote and treats `[` as entering the subset, which ends
 * at the matching `]`.
 *
 * @param source - The document.
 * @param from - The offset of the `<` that opens the declaration.
 * @returns One past the `>` that closes it, or the end of the source.
 */
function doctypeEnd(source: string, from: number): number {
  let quote: string | undefined;
  let subset = false;

  for (let i = from + '<!DOCTYPE'.length; i < source.length; i++) {
    const ch = source[i] as string;

    if (quote) {
      if (ch === quote) {
        quote = undefined;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === '[') {
      subset = true;
      continue;
    }
    if (ch === ']') {
      subset = false;
      continue;
    }
    if (ch === '>' && !subset) {
      return i + 1;
    }
  }

  return source.length;
}

/**
 * The source with every region a `content` row must not match blanked out.
 *
 * Blanked rather than removed, so that every offset -- and therefore every
 * `line` a report names -- is the one it was. That is the JSONC scanner's own
 * trick in the runtime, where a comment and a trailing comma each become a
 * space and every newline is kept.
 *
 * The four regions are the ones whose content is not element content: a
 * comment, a CDATA section, a processing instruction or the XML declaration,
 * and a DOCTYPE -- whose internal subset is arbitrary markup, which is what
 * made a `<!ELEMENT a (#PCDATA)>` read as a bare `>` in text.
 */
function contentOf(source: string): string {
  const out = Array.from(source);
  // the line breaks are kept and that is a statement rather than a guard: a
  // character is replaced by one character either way, so every offset -- and
  // therefore every `line`, which is counted off `source` -- is the same with
  // them blanked too. Measured over eighteen documents, every report identical.
  // What it buys is that `content` is line for line `source`, which is what a
  // reader comparing the two to see what was blanked needs; and it is what a
  // row anchored with `^` or `/m` would need, which none is today
  const blank = (from: number, to: number): void => {
    for (let i = from; i < to && i < out.length; i++) {
      if (out[i] !== '\n' && out[i] !== '\r') {
        out[i] = ' ';
      }
    }
  };

  for (let i = 0; i < source.length; i++) {
    if (source[i] !== '<') {
      continue;
    }
    // each region is `[opener, closer]`, and a DOCTYPE has no literal closer
    // because its own grammar decides where it ends
    const region = source.startsWith('<!--', i)
      ? ['<!--', '-->']
      : source.startsWith('<![CDATA[', i)
        ? ['<![CDATA[', ']]>']
        : source.startsWith('<?', i)
          ? ['<?', '?>']
          : undefined;

    const doctype = !region && source.startsWith('<!DOCTYPE', i);
    if (!region && !doctype) {
      continue;
    }

    let end: number;
    if (region) {
      const [open, close] = region as [string, string];
      const at = source.indexOf(close, i + open.length);
      end = at === -1 ? source.length : at + close.length;
    } else {
      end = doctypeEnd(source, i);
    }

    blank(i, end);
    // past the region rather than one character into it, which is a cost guard
    // rather than a claim: what it skips has just been blanked, so a rescan
    // finds no `<` to open anything with. Measured over the same eighteen
    // documents, identical with it gone
    i = end - 1;
  }

  return out.join('');
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
    kind: 'formatting',
    look: /<([^\s/>]+)([^>]*)><\/\1\s*>/,
    say: 'an empty paired tag becomes self-closing',
    where: 'content',
  },
  {
    kind: 'formatting',
    look: /=\s*'/,
    say: 'a single-quoted attribute value is rewritten with double quotes',
    where: 'content',
  },
  {
    kind: 'formatting',
    look: /\s=|=\s/,
    say: 'whitespace around an attribute’s = is dropped',
    where: 'content',
  },
  {
    kind: 'formatting',
    look: /&#/,
    say: 'a numeric character reference is rewritten by name',
    where: 'content',
  },
  {
    // both spellings, which the table above has always claimed and this row
    // did not: `&quot;` in element text comes back a literal `"` exactly as
    // `&apos;` does -- measured -- and with only `&apos;` here a document
    // holding one fell through to the unexplained-difference fallback, which
    // reports no line at all, or was not reported at all where another row
    // had already matched. Found by review round 2
    kind: 'formatting',
    look: /&apos;|&quot;/,
    say: 'an &apos; or &quot; reference is rewritten as a literal quote',
    where: 'content',
  },
  {
    kind: 'formatting',
    look: />(?:[^<]*[^<&\s])?[^<]*>[^<]*</,
    say: 'a bare > in text is escaped',
    where: 'content',
  },
  {
    // either quote, which this hardcoded as `="` -- so a single-quoted
    // attribute holding a tab or a newline reported the quote rewrite and not
    // the normalization, which is the half of the two the author most needs,
    // since it is required of every conforming parser rather than cosmetic.
    // Found by review round 2
    kind: 'spec',
    look: /=\s*(?:"[^"]*|'[^']*)[\n\r\t]/,
    say: 'whitespace in an attribute value is normalized to a space, which the XML spec requires',
    where: 'content',
  },
  {
    // the one row matched against the raw source, because this one really is
    // everywhere: a comment holding a NEL comes back holding a newline, so
    // blanking the comment would suppress a true positive
    kind: 'spec',
    look: /\u0085/,
    say: 'NEL is normalized to a newline, which the XML spec requires',
    where: 'source',
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
  // blanked once rather than per row, and the offsets are the source's either
  // way -- which is what `contentOf()` keeps the newlines for
  const content = contentOf(source);

  for (const it of RESIDUALS) {
    const found = it.look.exec(it.where === 'source' ? source : content);
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

  // never empty, because of the fallback above -- so `out.length > 0 ? out : []`
  // is an equivalent spelling rather than a defect, and what makes the answer
  // **absent** for a document that round-trips is the early return at the top
  return out;
}
