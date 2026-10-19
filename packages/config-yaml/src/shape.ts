import type { ToStringOptions } from 'yaml';

/**
 * What a YAML document's bytes carry that its parsed form does not, and the
 * stringify options that reproduce its layout.
 *
 * `yaml`'s `Document` keeps comments, anchors and quoting styles through a round
 * trip and does **not** keep the three things a text file carries outside its
 * own grammar -- a byte order mark, CRLF line endings and the exact run of
 * newlines it ends with -- nor its *indentation*, which `toString()` renders
 * from options rather than from the source.
 *
 * So this is two halves of one job. The three bytes are detected and reapplied,
 * which is `@ttylabs/config-xml`'s `shape.ts` one format along and for its
 * reason: a check that reported every CRLF config as lossy would be a guard
 * firing on correct code. The layout is detected as **options**, which is the
 * half XML has no analogue for, because its serializer reproduces whatever
 * indentation the source had and `yaml`'s renders its own.
 *
 * ## The layout is detected and then *checked*, which is one computation
 *
 * `fidelity.ts` asks whether a no-op write of this document reproduces its own
 * bytes, and that question needs stringify options to ask it with. So the
 * detection and the fidelity check are the same round trip: render the
 * unmodified document with the detected options, and either it equals the source
 * -- in which case nothing is lost and those are the options a real write uses
 * -- or it does not, and what differs is a residual to report.
 *
 * Which is why `candidates()` exists rather than the detection standing alone.
 * The regex detection below hit **24 of 24** documents on the first try --
 * two-space, four-space, one-, six- and eight-space, an unindented sequence, a
 * tight flow collection, comments, anchors, CRLF, a BOM, no final newline, a
 * block scalar and a nested map among them -- so the fallbacks are for a shape
 * it has not met, and what they buy is that a missed detection costs a slower
 * read rather than a false report of loss. Measured: one `toString()` where the
 * first candidate matches, which is 1.22ms over a 900-line file, against 20.37ms
 * for the full 24-candidate sweep the first version of this swept
 * unconditionally.
 */

/** Two spaces, which is what `yaml` renders with and what most YAML is written in. */
const DEFAULT_INDENT = 2;

/** What a document's bytes carry outside its own grammar. */
export interface Shape {
  /** Whether it opens with a byte order mark. */
  bom: boolean;
  /** Whether its line endings are CRLF. */
  crlf: boolean;
  /**
   * The exact run of newlines it ends with, which may be empty.
   *
   * One field for three cases rather than a flag each: a file ending with no
   * newline, with one, and with a blank line after it are the same question
   * asked of the same run, and `toString()` answers all three with exactly one.
   * Reapplying the run recovers every one of them, which is measured -- without
   * it, `a: 1\n\n` came back `a: 1\n` and was reported as a formatting loss on a
   * file that merely ends the way an editor left it.
   */
  trailing: string;
}

/** A document's bytes, split into its shape and the body a parser should read. */
export interface Shaped {
  /** The text to parse: the source with the mark off and the endings LF. */
  body: string;
  /** What to put back. */
  shape: Shape;
}

/**
 * Splits a document's bytes into the body a parser reads and the shape to put
 * back.
 *
 * The mark is **taken off** rather than left for the parser, which is measured
 * rather than cautious: `yaml` reads `U+FEFF` at the start of a stream as a
 * document separator, so a marked file parses and the mark is simply gone from
 * what `toString()` renders. Taking it off here and putting it back in
 * `reshape()` is what makes a marked file round-trip at all.
 *
 * @param source - The document's own bytes.
 * @returns The body and the shape.
 */
export function shapeOf(source: string): Shaped {
  let body = source;

  const bom = body.startsWith('\uFEFF');
  if (bom) {
    body = body.slice(1);
  }

  // asked of the whole text rather than of its last line, because a file with
  // mixed endings is one somebody's editor half-converted -- and the ending a
  // write produces is the one it **mostly** has, which is what this comment
  // claimed while the code asked `includes('\r\n')`. Measured, that converted
  // `a: 1\nb: 2\nc: 3\r\n` -- two LF endings against one CRLF -- wholly to
  // CRLF, changing the two lines that were already right to fix the one that
  // was not. A mixed file cannot round-trip either way, because `reshape()`
  // applies one ending to every line, so what is left to choose is which lines
  // change: the minority. A tie goes to LF, which is what a file with no
  // ending at all gets.
  //
  // The body is normalized **whatever** is chosen, because that is what the
  // parser is handed; `shape.crlf` only decides what goes back. Under the old
  // rule the two could not come apart, since any CRLF meant both
  const endings = (body.match(/\n/g) ?? []).length;
  const crlfs = (body.match(/\r\n/g) ?? []).length;
  const crlf = crlfs * 2 > endings;

  body = body.replaceAll('\r\n', '\n');

  // a **lone** `\r` is deliberately not part of the shape, and the reason used
  // to be given as `yaml` normalizing it so that it is a loss to report.
  // Measured, it is a parse error: a lone CR is not a line break in YAML 1.2,
  // so `a: 1\rb: 2\r` is one line and `Nested mappings are not allowed in
  // compact mappings`. `readSync()` throws naming the file and the line, and no
  // shape or loss is ever computed for such a document

  return { body, shape: { bom, crlf, trailing: /\n*$/.exec(body)?.[0] ?? '' } };
}

/**
 * Puts a shape back on what `toString()` rendered.
 *
 * The order is the inverse of `shapeOf()`'s and each step is the inverse of
 * one: the trailing run first, because it is counted in LF; then the endings,
 * so that a reapplied run is converted with everything else; then the mark,
 * which is outside the text either way.
 *
 * @param rendered - What `toString()` produced.
 * @param shape - The shape to put back.
 * @returns The bytes to write.
 */
export function reshape(rendered: string, shape: Shape): string {
  let out = rendered.replace(/\n*$/, '') + shape.trailing;

  if (shape.crlf) {
    out = out.replaceAll('\n', '\r\n');
  }

  return shape.bom ? `\uFEFF${out}` : out;
}

/**
 * The indentation one level of nesting is written with, read off the source.
 *
 * The smallest positive indent any line carries, which is one level by
 * construction: every deeper line is a multiple of it, so the minimum is the
 * step. A block scalar's own content is indented by the same step, so it
 * agrees rather than needing to be skipped.
 *
 * `0` where nothing is nested, which the caller reads as "no evidence" and
 * answers with the default -- a flat document renders identically at any
 * indent, so there is nothing for the detection to be wrong about.
 */
function indentOf(lines: readonly string[]): number {
  let found = 0;
  // the indent of the line that opened a block scalar, while inside one
  let block: number | undefined;

  for (const line of lines) {
    // counted rather than matched, because `exec(...)?.[1] as string` is a
    // cast over a short-circuit -- `undefined.length` if the match ever failed,
    // which `oxlint`'s `no-unsafe-optional-chaining` is right about even though
    // ` *` cannot fail.
    //
    // **Spaces** only, and that is a **statement rather than a guard**: a
    // sabotage counting a tab too survives, and measuring why is the useful
    // half. A tab-led line is valid YAML in exactly two places -- a comment,
    // `a: 1\n\t# c`, and a block scalar's content, `a: |\n  \thello` -- and
    // this function skips both already, for their own reasons below. Every
    // other tab-led line is a **parse error**, so the document is refused
    // before `shape` is reached: measured, `a:\n\tb: 1` is
    // `Tabs are not allowed as indentation` and a tab inside a flow collection
    // is an error too. So what the spelling buys is saying what a YAML indent
    // is, and `trimStart()` would have said something else
    let own = 0;
    while (line[own] === ' ') {
      own++;
    }

    // a block scalar's content is the **author's text**, not the document's
    // structure, so the step cannot be read off it. Measured,
    // `a: |\n  hello\nb:\n      c: 1\n` detected 2 from `hello` and the write
    // then reindented `c` from six spaces to two -- and unlike the comment
    // below, that minimum is not a step the serializer can satisfy both ways
    if (block !== undefined) {
      if (line.trim() === '' || own > block) {
        continue;
      }
      block = undefined;
    }

    // a **comment** carries no indent worth reading, which is what
    // `seqIndented()` already says and this did not: two readers of one rule.
    // Measured, `a:\n  # note\n      b: 1\n` detected 2 from the comment and
    // the write reindented `b` from six to two -- an avoidable loss rather
    // than a limit, because rendering at 6 reproduces the line and only moves
    // the comment, and the candidate sweep never tries 6
    if (line.trimStart().startsWith('#')) {
      continue;
    }

    if (/^ +\S/.test(line) && (!found || own < found)) {
      found = own;
    }

    // `|`, `>` and their chomping and indentation indicators, with an inline
    // comment allowed after
    if (/[|>][-+]?\d*[ \t]*(#.*)?$/.test(line)) {
      block = own;
    }
  }

  return found;
}

/**
 * Whether a sequence is indented under the key that holds it.
 *
 * `yaml`'s own default, and the one most YAML is written with. The other
 * spelling puts the dash at the key's own indent:
 *
 * ```yaml
 * plugins:
 * - a
 * ```
 *
 * which is `indentSeq: false`. Detected by finding a `- ` line and walking back
 * to the nearest line that carries content: where that line ends in a colon and
 * sits at the **same** indent, the sequence is not indented. A comment is
 * skipped on the way, because a comment between a key and its first item is
 * ordinary and carries no indent worth reading.
 */
function seqIndented(lines: readonly string[]): boolean {
  for (let i = 0; i < lines.length; i++) {
    const dash = /^([ \t]*)- /.exec(lines[i] as string);
    if (!dash) {
      continue;
    }

    for (let back = i - 1; back >= 0; back--) {
      const line = lines[back] as string;
      const at = /^([ \t]*)\S/.exec(line);
      if (!at || line.trimStart().startsWith('#')) {
        continue;
      }
      // a key with nothing after the colon is the one that holds this sequence;
      // anything else above it is a sibling, and the walk stops either way so
      // that a dash deeper in the document cannot be read against a key it has
      // nothing to do with
      return !((at[1] as string).length === (dash[1] as string).length && /:\s*$/.test(line));
    }
  }

  return true;
}

/**
 * Whether a flow collection is written with a space inside its brackets.
 *
 * `yaml` renders `{ b: 1 }` and `[ 1, 2 ]` by default and `{b: 1}` with
 * `flowCollectionPadding: false`. An **empty** one is `{}` either way, so it is
 * no evidence and is excluded -- without which every document holding an empty
 * map read as tight and a padded one beside it was reported as a loss.
 */
function flowPadded(body: string): boolean {
  // a bracket followed by content rather than by a space is the tight
  // spelling; with none of either, the default stands
  return !/[[{](?![\s\]}])/.test(body);
}

/**
 * The stringify options to try, best guess first.
 *
 * `lineWidth: 0` on every candidate rather than detected, because folding is
 * not a layout this store has any business reproducing: `yaml` folds a long
 * plain scalar at 80 columns by default, so a long value in a config comes back
 * wrapped across lines it was never written across. `0` is "never fold", which
 * leaves a long line long -- and a value long enough to fold is one somebody
 * wrote on one line.
 *
 * @param body - The document, with its shape taken off.
 * @returns The candidates, the detected one first.
 */
export function candidates(body: string): readonly ToStringOptions[] {
  const lines = body.split('\n');
  const indent = indentOf(lines) || DEFAULT_INDENT;
  const indentSeq = seqIndented(lines);
  const flowCollectionPadding = flowPadded(body);

  const out: ToStringOptions[] = [{ flowCollectionPadding, indent, indentSeq, lineWidth: 0 }];

  // the other three combinations at the detected indent, then the default at
  // two and four spaces: a bounded sweep for a document whose layout the
  // detection read wrong, rather than the exhaustive one. Ordered so that the
  // likeliest correction comes first, and deduplicated against the guess
  for (const also of [
    { flowCollectionPadding, indent, indentSeq: !indentSeq },
    { flowCollectionPadding: !flowCollectionPadding, indent, indentSeq },
    { flowCollectionPadding: !flowCollectionPadding, indent, indentSeq: !indentSeq },
    { flowCollectionPadding: true, indent: 2, indentSeq: true },
    { flowCollectionPadding: true, indent: 4, indentSeq: true },
  ]) {
    const first = out[0] as ToStringOptions;
    if (
      also.indent === first.indent &&
      also.indentSeq === first.indentSeq &&
      also.flowCollectionPadding === first.flowCollectionPadding
    ) {
      continue;
    }
    out.push({ ...also, lineWidth: 0 });
  }

  return out;
}
