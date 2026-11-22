/**
 * Where an XML document's own markup is, and where it is only text that looks
 * like it.
 *
 * Two readers ask this and it is one answer: `fidelity.ts` needs the element
 * content to say which line a loss is on, and `wellformed.ts` needs it to tell a
 * numeric character reference from five characters inside a comment (SIG-586).
 * A second walk for either is how the two would come to disagree about where a
 * comment ends.
 */

/**
 * Where a DOCTYPE declaration ends, which its own grammar decides.
 *
 * A quoted literal may hold a `>` and an internal subset may hold several, so
 * the first `>` is the end of neither -- `indexOf()` over either was a false
 * positive of the bare-`>` row in a document that also had a real loss, which
 * is the class `contentOf()` exists to close and this was one more member of.
 * So the walk tracks a quote and treats `[` as entering the subset, which ends
 * at the matching `]` -- and steps over a comment and a processing instruction
 * in it whole, because an apostrophe or a `]>` in one is text rather than a quote
 * or an end (SIG-586). Without that, `<!-- it's -->` opened a quote nothing
 * closed and the rest of the document was blanked, which hid every numeric
 * reference after it from the check that now depends on this walk.
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
    if (ch === '<' && (source.startsWith('<!--', i) || source.startsWith('<?', i))) {
      const close = source.startsWith('<!--', i) ? '-->' : '?>';
      const at = source.indexOf(close, i + 2);
      if (at === -1) {
        return source.length;
      }
      i = at + close.length - 1;
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
export function contentOf(source: string): string {
  // by code **unit** rather than by code point, which is what makes the offsets
  // below mean anything: every `i` and `end` here is a code-unit offset, out of
  // `indexOf()` and `startsWith()`, so an `Array.from()` array -- whose elements
  // are code points -- drifts one place per astral character before a region.
  // Both halves of that were measured rather than argued. The blanking lands
  // past the region it was for, so a row matches **inside a comment** where the
  // drift exceeds the comment's own prefix, which is the one class this function
  // exists to close; and a blanked astral character becomes a single space, so
  // `content` comes out shorter than `source` and the `line` a report names is
  // the one before. A surrogate half is blanked to a space on its own here,
  // which keeps the lengths equal -- and nothing can split a pair, because every
  // region boundary is ASCII. Found by review.
  const out = source.split('');
  // the line breaks are kept and that is a statement rather than a guard: a
  // code unit is replaced by one code unit either way, so every offset -- and
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
