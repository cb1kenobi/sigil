import type { Loss } from '@ttylabs/sigil/config';

/**
 * What a write would lose, asked of the **document** rather than of the format.
 *
 * Which is `WriteOptions.lossy`'s own rule: a store writing a file that has
 * nothing in it the serializer renormalizes loses nothing, and refusing that
 * write would be a guard firing on correct code. So the answer is computed per
 * file, by rendering the unmodified document with the options `shape.ts`
 * detected and comparing -- which is the same round trip that *chose* those
 * options, so the fidelity check and the layout detection are one computation
 * rather than two that could disagree.
 *
 * ## Why this is a line diff rather than a table of patterns
 *
 * `@ttylabs/config-xml` names its residual with a table of
 * regexes matched against the source, and its own entry records what that
 * costs: a pattern that matches inside a comment or a CDATA section "names a
 * line the author would go and find nothing wrong with", which took a
 * `contentOf()` pass blanking four kinds of region to close. YAML is worse for
 * that -- a `#` inside a quoted scalar is not a comment, and quoting in YAML
 * has five spellings -- so the same design would need a scalar-aware blanking
 * pass and would still be a guess.
 *
 * So what is compared is the **two renderings, line by line**, and what is
 * reported is the first line of each kind of difference. The **line** is then
 * exact by construction: a line this names is a line where the source and a
 * no-op write really do differ. And it is strictly more informative than the
 * table, because the fallback -- a difference no recognizer has a name for --
 * still carries the line, where XML's can only say that the document differs.
 *
 * What is **not** exact by construction is the **detail**, which this module
 * claimed for one commit and which the sabotage pass falsified: a recognizer
 * can be wrong about the cause of a difference that is really there. The
 * blank-line row was, on two documents with no blank line in either. So each
 * row is narrow on purpose and each has a test of its own.
 *
 * There is no cap on how many entries this reports, and there was one: the
 * table has nine possible answers -- the rows below plus the per-line fallback
 * -- and `seen` is keyed by the sentence, so a cap of ten could never bind.
 * Deleted rather than commented, which is what this repository does with a
 * guard that cannot fire, and `test/fidelity.test.ts` asserts the bound that
 * makes it unnecessary.
 *
 * ## What `yaml` 2.9.1's `Document.toString()` renormalizes, measured
 *
 * Over the thirty-five documents in `test/corpus.test.ts`, twenty-four
 * round-trip byte for byte once the shape and the detected layout are applied --
 * comments, anchors, aliases, merge keys, block scalars, quoting styles, flow
 * collections, CRLF, a byte order mark, a trailing blank line, no final newline,
 * an integer key, and one-, two-, four-, six- and eight-space indentation among
 * them. Both counts are asserted there rather than written down. The complete
 * residual is eleven:
 *
 * | what | becomes |
 * | -- | -- |
 * | `a: 1   # c` | `a: 1 # c` |
 * | `a: 1\t# c` | `a: 1 # c` |
 * | a blank line run inside the document | one blank line |
 * | `a: 1\n# tail` | `a: 1\n\n# tail` |
 * | `? a\n: 1` | `a: 1` |
 * | a folded scalar's own line breaks | one folded line |
 * | `!!str 5` | `!!str "5"` |
 * | an indented comment above an **unindented** sequence item | column 0 |
 * | a flow collection written across lines | one line |
 * | a block scalar indented past the step | the step |
 * | four-space indent with an unindented sequence | a two-space indent |
 *
 * The comment row is narrow and was found by a test that asserted the wrong
 * thing: `yaml` renders a sequence item's own `commentBefore` at the item's
 * indent, so with `indentSeq: false` an indented comment above it moves to
 * column 0. A comment above an *indented* item keeps its indent, and so does
 * one above a mapping key, which is why this is one row rather than the general
 * case.
 *
 * The last is the one `shape.ts` cannot recover and it is the parser's own
 * limitation rather than a detection failure: measured,
 * `{ indent: 4, indentSeq: false }` does not reproduce
 * `a:\n    b:\n    - 1` -- `yaml` indents the sequence by the step whatever
 * `indentSeq` says once the step is not two.
 *
 * ## What it cannot see
 *
 * A read-time round trip answers "would re-serializing this document as it
 * stands lose anything", which is **not** a bound on what a `set()` will do. It
 * cannot see edit-induced loss, and the three kinds YAML has -- a write through
 * an alias, a delete of a merged key, an edit of an aliased anchor -- are each
 * closed in `write.ts` rather than reported here. Which is the right place for
 * them, because a loss a store can avoid is one it should avoid rather than
 * report. So an **absent** `wouldLose` -- absent rather than empty, which is
 * that field's own contract -- is the honest answer to the question this asks.
 */

/** The two renderings and the line being looked at. */
interface At {
  /** The line index, zero-based. */
  i: number;
  /** The rendered line, or nothing where the rendering is shorter. */
  now: string | undefined;
  /** Every rendered line, for a recognizer that has to look back. */
  rendered: readonly string[];
  /** Every source line, for the same reason. */
  source: readonly string[];
  /** The source line, or nothing where the source is shorter. */
  was: string | undefined;
}

/** What to say about a pair of lines that differ, and what to call it. */
interface Recognizer {
  /** What `Loss.kind` says. */
  kind: string;
  /** Whether this is what differs about the two lines. */
  saw: (at: At) => boolean;
  /** What to say about it. */
  say: string;
}

/** The whitespace a line opens with. */
function indentOf(line: string): string {
  return /^[ \t]*/.exec(line)?.[0] ?? '';
}

/**
 * Whether the line being looked at is inside a folded block scalar.
 *
 * The one recognizer that has to look **back**, and the reason is measured:
 * `a: >\n  l1\n  l2` renders as `a: >\n  l1 l2`, so the line carrying the `>`
 * is **identical** in both and the walk never stops on it -- what differs is the
 * content two lines down, which says nothing about folding on its own. So the
 * marker is found by walking up to the nearest line indented less than this one,
 * which is the block's own header.
 */
function underFolded(at: At): boolean {
  const here = at.was;
  if (here === undefined || here.trim() === '') {
    return false;
  }

  for (let up = at.i - 1; up >= 0; up--) {
    const line = at.source[up] as string;
    if (line.trim() === '') {
      continue;
    }
    if (indentOf(line).length < indentOf(here).length) {
      return /:\s*>[+-]?\s*(?:#.*)?$/.test(line);
    }
  }

  return false;
}

/**
 * Each asked of the **pair** of lines rather than of the source, so that a
 * match is a statement about a difference that is really there.
 *
 * Ordered most specific first: the first one that recognizes the pair names it,
 * and the fallback below catches a difference none of them has met.
 */
/**
 * The largest alignment table `align()` will build, past which it pairs
 * index-wise within the changed region.
 *
 * A million cells is a thousand changed lines against a thousand, which no
 * config file reaches once the common prefix and suffix are off -- and the
 * fallback is the old whole-file behaviour narrowed to the region, so the worst
 * a document past it gets is the report it used to get.
 */
const LCS_CELLS = 1_000_000;

/**
 * The next line after `i` that is neither blank nor a comment.
 *
 * What the comment-indent row needs in order to name the sequence item it is
 * about, rather than reporting every surviving comment as one.
 */
function nextContent(source: readonly string[], i: number): string {
  for (let at = i + 1; at < source.length; at++) {
    const line = (source[at] as string).replace(/\r$/, '');
    if (line.trim() !== '' && !line.trimStart().startsWith('#')) {
      return line;
    }
  }
  return '';
}

/**
 * Whether a line is blank, with a CRLF ending taken off first.
 *
 * `lossesOf()` splits on `\n` and keeps the `\r`, deliberately -- so that a
 * line-ending change is still something the diff can see -- which left every
 * recognizer that asked `=== ''` blind on a CRLF file: a blank line there is
 * `"\r"`. Measured, `a: 1\r\n\r\n\r\nb: 2\r\n` reported the bare "does not
 * survive" sentence where the LF spelling of the same file named the collapsed
 * run, and the trailing-comment row missed the same way.
 */
function isBlank(line: string | undefined): boolean {
  return line !== undefined && line.replace(/\r$/, '') === '';
}

const RECOGNIZERS: readonly Recognizer[] = [
  {
    kind: 'comment',
    saw: ({ now, was }) =>
      was !== undefined &&
      now !== undefined &&
      /[ \t]{2,}#|\t#/.test(was) &&
      / #/.test(now) &&
      was.replace(/[ \t]+#/, ' #') === now,
    say: 'the whitespace before an inline comment is normalized to one space',
  },
  {
    kind: 'formatting',
    // the **rendered** line is asked about as well, or any line that merely
    // starts with `? ` is reported as an explicit key being rewritten -- which
    // for a `? not a key` line inside a literal block is a sentence about a
    // construct that is not there. Measured: only its indent had moved, and the
    // indentation row below would have said so
    saw: ({ now, was }) =>
      was !== undefined && /^[ \t]*\? /.test(was) && (now === undefined || !/^[ \t]*\? /.test(now)),
    say: 'an explicit "? key" is rewritten as an ordinary key',
  },
  {
    kind: 'formatting',
    saw: ({ now, was }) =>
      was !== undefined && now !== undefined && !was.includes('"') && /!!\S+ "/.test(now),
    say: 'a tagged scalar is rewritten with quotes',
  },
  {
    kind: 'formatting',
    saw: underFolded,
    say: "a folded block scalar's own line breaks are re-folded",
  },
  {
    kind: 'comment',
    // a line only the **rendering** has, which is what an inserted blank now is:
    // paired alignment reports it with no source half at all, where the index
    // walk used to compare the comment against the blank and read that as the
    // comment changing. `At.i` is the source line the blank sits in front of,
    // so this asks about that line rather than about a `was` there is none of
    saw: ({ i, now, source, was }) =>
      was === undefined && isBlank(now) && (source[i] ?? '').trimStart().startsWith('#'),
    say: 'a blank line is added before a comment at the end of the document',
  },
  {
    // a **run**, which is two consecutive blank lines in the source rather than
    // one blank line anywhere. `was === '' || now === ''` was the first rule and
    // it is a false positive on any rendering that is **shorter** than the
    // source: measured, `a: [\n  1,\n  2,\n]` renders on one line, so the tail
    // compares against nothing and the row claimed a collapsed run about a
    // document with no blank line in it -- and so did `a: 1\nb: 2` against
    // `a: 1`, where what differs is that a key is gone. Which falsifies this
    // module's own claim that a line diff cannot produce a false positive: the
    // **line** is right either way and the **detail** was wrong, and a detail
    // that names the wrong cause is the thing a table of patterns is criticised
    // for one paragraph up. Found by the sabotage pass rather than by a test
    kind: 'formatting',
    // `now === '' && was === ''` was the second disjunct and was unreachable:
    // the walk only ever asks about a pair that differs. CRLF-tolerant, because
    // a blank line in a CRLF file is `"\r"` rather than `''`.
    //
    // It looks **both** ways, because which blank of a run is the one reported
    // gone is the alignment's choice rather than a fixed one: where the lines
    // before the run are identical they come off as the common prefix and the
    // **second** blank is left over, and where something earlier in the file
    // also changed the subsequence match takes the **first**. Measured on the
    // demo's own file, which changes line 1 as well -- looking back alone
    // dropped it to the bare "does not survive" sentence there while naming the
    // run correctly for a file whose first line is untouched
    saw: ({ i, source, was }) => isBlank(was) && (isBlank(source[i - 1]) || isBlank(source[i + 1])),
    say: 'a run of blank lines is collapsed to one',
  },
  {
    // a flow collection written across lines, which `yaml` renders on one --
    // reported as the per-line fallback before this row existed, which named
    // the line and not the cause
    kind: 'formatting',
    saw: ({ was }) => was !== undefined && /[[{][ \t]*$/.test(was),
    say: 'a flow collection written across lines is rendered on one',
  },
  {
    // ahead of the general indentation row below, because the cause is
    // different and so is what a reader would do about it: this is one comment
    // moving rather than the document's layout being unrenderable
    kind: 'comment',
    // the **sequence** this names has to be in the file. Without that test any
    // full-line comment whose text survived was reported as a comment above an
    // unindented sequence item: measured, `a:\n      # note\n  b: 1\n` has no
    // `- ` anywhere and got this sentence, where what moved it was the
    // document's indentation and the row below says so accurately
    saw: ({ i, now, source, was }) =>
      was !== undefined &&
      now !== undefined &&
      was.trimStart().startsWith('#') &&
      was.trimStart() === now.trimStart() &&
      /^[ \t]*- /.test(nextContent(source, i)),
    say: "a comment above an unindented sequence item is moved to the item's own indent",
  },
  {
    kind: 'formatting',
    saw: ({ now, was }) =>
      was !== undefined &&
      now !== undefined &&
      indentOf(was) !== indentOf(now) &&
      was.trimStart() === now.trimStart(),
    say: 'the indentation is rewritten, which this layout cannot be rendered with',
  },
];

/**
 * What a write of this document would lose, or nothing where it would lose
 * nothing.
 *
 * @param source - The document's own bytes.
 * @param rendered - What a no-op write of it would produce, reshaped.
 * @returns The losses, or nothing.
 */
/** A source line paired with the rendered line it became, where there is one. */
interface Aligned {
  /** The rendered line index, or nothing for a source line that is gone. */
  now?: number;
  /** The source line index, or nothing for a line only the rendering has. */
  was?: number;
}

/**
 * Pairs the source's lines with the rendering's.
 *
 * Index alignment -- `source[i]` against `rendered[i]` -- is what this used to
 * do, and it falsified the claim the whole design rests on. An inserted or
 * deleted line shifts every index after it, so a line that **survived** was
 * reported as not surviving: measured, `a: 1\n\n\nb: 2\n` renders as
 * `a: 1\n\nb: 2\n` and the report named line 4, `b: 2`, which is in the output
 * one line higher. And `Math.max` of the two lengths walked past the end of the
 * source, so `a: 1\n# tail\n` reported a **phantom** line 3: the empty string
 * `split` leaves after a final newline.
 *
 * So the lines are paired instead. The common prefix and the common suffix come
 * off first, which for a document against its own re-render is nearly all of
 * it, and what is left is matched by longest common subsequence. A pair with
 * both halves is a line that changed; one with only a source index is a line
 * that is gone; one with only a rendered index is a line that was added. No
 * pair names an index either array does not have, so a reported line is a real
 * line of the file again -- which is what makes "it cannot be a false positive"
 * true rather than merely written down.
 *
 * The table is bounded: the trim makes the middle small in practice, and a
 * middle past `LCS_CELLS` falls back to pairing index-wise within it, which is
 * the old behaviour over a region rather than over the file.
 *
 * @param was - The source's lines.
 * @param now - The rendering's lines.
 * @returns The pairs, in source order.
 */
function align(was: readonly string[], now: readonly string[]): readonly Aligned[] {
  let head = 0;
  while (head < was.length && head < now.length && was[head] === now[head]) {
    head++;
  }

  let tail = 0;
  while (
    tail < was.length - head &&
    tail < now.length - head &&
    was[was.length - 1 - tail] === now[now.length - 1 - tail]
  ) {
    tail++;
  }

  const a = was.slice(head, was.length - tail);
  const b = now.slice(head, now.length - tail);
  const out: Aligned[] = [];

  if (a.length * b.length > LCS_CELLS) {
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
      out.push({
        ...(i < b.length ? { now: head + i } : {}),
        ...(i < a.length ? { was: head + i } : {}),
      });
    }
    return out;
  }

  // the base row and column are zero, which is the LCS definition -- and
  // filling them with any other constant is a **declared sabotage survivor**
  // rather than a hole: both branches below add the same constant, so by
  // induction every cell is offset equally, and every decision the walk takes
  // is a *comparison between two cells*. Measured over 4,000 random pairs, the
  // alignment is identical with a base of 0 and a base of 1
  const lcs: number[][] = Array.from({ length: a.length + 1 }, () =>
    Array.from({ length: b.length + 1 }, () => 0)
  );

  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      (lcs[i] as number[])[j] =
        a[i] === b[j]
          ? ((lcs[i + 1] as number[])[j + 1] as number) + 1
          : Math.max((lcs[i + 1] as number[])[j] as number, (lcs[i] as number[])[j + 1] as number);
    }
  }

  let i = 0;
  let j = 0;

  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      i++;
      j++;
      continue;
    }
    // the line with more of the common subsequence behind it is the one that
    // stays; its partner is the one that was added or removed
    if (((lcs[i + 1] as number[])[j] as number) >= ((lcs[i] as number[])[j + 1] as number)) {
      out.push({ was: head + i });
      i++;
      continue;
    }
    out.push({ now: head + j });
    j++;
  }

  for (; i < a.length; i++) {
    out.push({ was: head + i });
  }
  for (; j < b.length; j++) {
    out.push({ now: head + j });
  }

  return coalesce(out);
}

/**
 * Zips a run of gone lines with the run of added lines that follows it.
 *
 * A line whose *text* changed is not in the common subsequence either way, so
 * the walk above emits it as a line gone and a line added -- which is the
 * truth and is useless to a recognizer, every one of which compares the source
 * line against the rendered line it became. A reindented line, a comment whose
 * spacing moved, a re-folded scalar: each is one line against one line, and
 * each would otherwise fall through to the bare "does not survive" sentence
 * with the cause lost.
 *
 * So a maximal run of gone lines immediately followed by a run of added ones is
 * paired off index-wise, which is what a diff calls a replace. The overlap pairs
 * up and whatever is left over on either side stays a line gone or a line added,
 * so nothing is invented: the pairing is only ever within one changed region,
 * never across an unchanged line.
 *
 * @param pairs - The pairs as the walk produced them.
 * @returns The same pairs with each replace run zipped.
 */
function coalesce(pairs: readonly Aligned[]): readonly Aligned[] {
  const out: Aligned[] = [];

  for (let at = 0; at < pairs.length;) {
    let gone = at;
    while (gone < pairs.length && (pairs[gone] as Aligned).now === undefined) {
      gone++;
    }

    let added = gone;
    while (added < pairs.length && (pairs[added] as Aligned).was === undefined) {
      added++;
    }

    const left = pairs.slice(at, gone);
    const right = pairs.slice(gone, added);

    if (left.length === 0 && right.length === 0) {
      out.push(pairs[at] as Aligned);
      at++;
      continue;
    }

    for (let k = 0; k < Math.max(left.length, right.length); k++) {
      out.push({
        ...(k < right.length ? { now: (right[k] as Aligned).now } : {}),
        ...(k < left.length ? { was: (left[k] as Aligned).was } : {}),
      });
    }

    at = added;
  }

  return out;
}

export function lossesOf(source: string, rendered: string): readonly Loss[] | undefined {
  if (rendered === source) {
    return undefined;
  }

  const was = source.split('\n');
  const now = rendered.split('\n');
  // one entry per *kind* of difference rather than one per differing line: a
  // reindented file differs on every line, and ten entries all saying so is a
  // wall nobody reads to the end of. Keyed by the sentence, so the first line
  // of each kind is what a reader is pointed at
  const seen = new Map<string, Loss>();

  for (const pair of align(was, now)) {
    // a line only the rendering has is reported against the source line it
    // sits in front of, because that is the line a reader has to look at --
    // clamped to the file, so an addition at the end names its last line
    const i = pair.was ?? Math.min(pair.now ?? 0, was.length - 1);
    const at: At = {
      i,
      now: pair.now === undefined ? undefined : now[pair.now],
      rendered: now,
      source: was,
      was: pair.was === undefined ? undefined : was[pair.was],
    };

    const found = RECOGNIZERS.find((it) => it.saw(at));
    const detail =
      found?.say ?? 'this line does not survive a round trip through this parser unchanged';

    if (!seen.has(detail)) {
      seen.set(detail, { detail, kind: found?.kind ?? 'formatting', line: i + 1 });
    }
  }

  // never empty, and that is a proof rather than a hope: two strings that
  // differ cannot have identical line arrays, so the trim above cannot consume
  // all of both and `align()` yields at least one pair. Which is what makes the
  // **document**-level fallback the sibling store needs unreachable here --
  // every answer names a line of the file, which is the whole advantage of
  // diffing the two renderings over matching patterns against the source
  return [...seen.values()];
}
