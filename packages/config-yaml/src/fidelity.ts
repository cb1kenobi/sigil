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
    saw: ({ was }) => was !== undefined && /^[ \t]*\? /.test(was),
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
    saw: ({ now, was }) => was !== undefined && now === '' && was.trimStart().startsWith('#'),
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
    saw: ({ i, now, source, was }) =>
      (was === '' && source[i - 1] === '') || (now === '' && was === ''),
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
    saw: ({ now, was }) =>
      was !== undefined &&
      now !== undefined &&
      was.trimStart().startsWith('#') &&
      was.trimStart() === now.trimStart(),
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

  for (let i = 0; i < Math.max(was.length, now.length); i++) {
    const at: At = { i, now: now[i], rendered: now, source: was, was: was[i] };

    if (at.was === at.now) {
      continue;
    }

    const found = RECOGNIZERS.find((it) => it.saw(at));
    const detail =
      found?.say ?? 'this line does not survive a round trip through this parser unchanged';

    if (!seen.has(detail)) {
      seen.set(detail, { detail, kind: found?.kind ?? 'formatting', line: i + 1 });
    }
  }

  // never empty, and that is a proof rather than a hope: `split('\n')` is
  // injective, so two strings that differ have line arrays that differ, so some
  // index above is reached and the per-line fallback records something. Which
  // is what makes the **document**-level fallback the sibling store needs
  // unreachable here -- every answer names a line, which is the whole advantage
  // of diffing the two renderings over matching patterns against the source
  return [...seen.values()];
}
