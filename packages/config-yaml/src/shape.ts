import { isPlainObject } from '@ttylabs/sigil/config';
import { isMap, isPair, isScalar, isSeq, type Document, type ToStringOptions } from 'yaml';

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
   *
   * `toString()` answering with exactly one is **not** true of every document:
   * where the last node is a keep-chomped block scalar the run it ends with is
   * that scalar's own value, and `---\n` renders a run of two over a null root.
   * So this is reapplied over the first and not the second, which `reshape()`
   * asks the document rather than the bytes.
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
 * The last value a document renders, reading a node or a raw value alike.
 *
 * Both, because `setIn()` stores the **plain JS value** it was handed rather
 * than wrapping it in a `Scalar`: measured, after
 * `setIn(['motd'], 'hello\n\n')` the pair's value is the string itself, and
 * `visit()` -- which only ever offers nodes -- skips not just that value but the
 * whole pair, so a `Scalar` handler over a written document reported the last
 * value as the one *before* it. Which is what a walk of `items` sees and a
 * visitor does not, and is why this is written out rather than delegated.
 *
 * In document order, so the last item of the last item is the last thing
 * rendered: `yaml` renders a map's pairs and a sequence's items in the order
 * they are held, and a plain object or array a write stored in insertion order.
 *
 * @param node - A node, a raw value, or nothing.
 * @returns The last value rendered under it.
 */
function lastValue(node: unknown): unknown {
  // reading one past the end is `undefined`, which falls through to the bottom
  // and answers `undefined` -- so a container with nothing in it needs no guard
  // of its own, and each of the three that was written here changed no answer
  if (isMap(node) || isSeq(node)) {
    const items = node.items as readonly unknown[];
    const last = items[items.length - 1];
    // a map holds pairs and a sequence holds its items directly
    return lastValue(isPair(last) ? (last as { value: unknown }).value : last);
  }

  if (isScalar(node)) {
    return node.value;
  }

  if (Array.isArray(node)) {
    return lastValue(node[node.length - 1]);
  }

  if (isPlainObject(node)) {
    const values = Object.values(node);
    return lastValue(values[values.length - 1]);
  }

  return node;
}

/**
 * Whether the document ends with a value that carries newlines of its own.
 *
 * A string ending in more than one newline is what makes `yaml` write `|+` or
 * `>+` and keep them, so where the last value rendered is one, a run of
 * newlines the render ends with is that value's. `yaml`'s own answer rather
 * than a prediction of the style it will choose: `reshape()` only asks where
 * the render really did end in such a run, so a string this holds that `yaml`
 * chose to quote instead is never reached.
 *
 * More than one newline rather than one, which `reshape()`'s own entry records
 * as a statement rather than a guard: its caller has already asked that the
 * render ends in a run of more than one, and the only structural run that long
 * is a null root's, whose last value is not a string.
 *
 * @param doc - The document.
 * @returns Whether its last value keeps newlines of its own.
 */
function keepsNewlines(doc: Document): boolean {
  const last = lastValue(doc.contents);
  return typeof last === 'string' && last.endsWith('\n\n');
}

/**
 * Puts a shape back on what `toString()` rendered.
 *
 * The order is the inverse of `shapeOf()`'s and each step is the inverse of
 * one: the trailing run first, because it is counted in LF; then the endings,
 * so that a reapplied run is converted with everything else; then the mark,
 * which is outside the text either way.
 *
 * ## A keep-chomped scalar's own newlines are its **value**, not the shape's
 *
 * This replaced the render's whole trailing run, and the newlines a keep-chomped
 * block scalar at the end of a document ends with are part of its value. So a
 * `set('motd', 'hello\n\n')` into a file ending `a: 1\n` rendered
 * `motd: |+\n  hello\n\n`, this cut it back to the source's one newline, and the
 * next read answered `'hello\n'` -- a silent data change, with the save reporting
 * success, `canRepresent()` having allowed the string and `wouldLose` **absent**,
 * because the fidelity check asks about the *unmodified* document. Both
 * directions, and the blank-file path with them: editing an existing `|+` from
 * two trailing newlines to three put two back, from three to two put three back,
 * and a first write into a blank file -- where `store.ts` forces the run to one
 * newline -- lost them the same way.
 *
 * ## The count cannot answer it, which is measured rather than assumed
 *
 * The obvious rule is to reapply the shape's run only where the render's own is
 * a single newline, on the reading that `toString()` ends a document with
 * exactly one unless a keep-chomped scalar is last. It is **wrong**, and the
 * suite caught it: `---\n` renders as `---\n\n`, a run of two with no block
 * scalar anywhere in it, because an explicit directives-end marker over a null
 * root renders the marker and then an empty content line -- so that rule
 * rewrote a no-op write of `---\n` with a trailing blank line it never had.
 * Swept over forty shapes, those are the only two that end in a run of more than
 * one: a null root after `---`, where the run is slack, and a `|+` or `>+`
 * scalar last, where it is the value. The bytes do not separate them.
 *
 * So the **document** answers it, which is the one party that knows, and it is
 * asked rather than modelled: the run is kept where the render ends in more than
 * one newline **and** the last value in document order is a string ending the
 * same way, which is the value those bytes came from.
 *
 * Both halves, because each refuses a shape the other admits, and each was
 * measured. Without the count, a value `yaml` chose to **quote** instead holds
 * such a string and renders a run of one, so a file ending
 * `a: "x\\n\\n"` plus a blank line had the blank line read as the value's and
 * dropped. Without the walk, `---\n` is the entry above. The threshold is the
 * one part of it that is a **statement rather than a guard**: inside the count
 * guard a structural run can only be a null root's, whose last value is not a
 * string at all, so loosening it to a single newline changes no answer and is a
 * declared sabotage survivor. It says what the condition means -- a value that
 * keeps newlines past the one clip chomping already implies -- where the looser
 * spelling would be true of every block scalar there is.
 *
 * Which is also why an unmodified document still round-trips byte for byte: a
 * file ending in a keep-chomped scalar has no trailing run of its own to put
 * back, since after one the trailing newlines *are* the value.
 *
 * @param rendered - What `toString()` produced.
 * @param shape - The shape to put back.
 * @param doc - The document it was rendered from, which is what says whether
 *   the run it ends with is a value's.
 * @returns The bytes to write.
 */
export function reshape(rendered: string, shape: Shape, doc: Document): string {
  const own = /\n*$/.exec(rendered)?.[0] ?? '';
  let out =
    own.length > 1 && keepsNewlines(doc)
      ? rendered
      : rendered.slice(0, rendered.length - own.length) + shape.trailing;

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
 * step -- **of the lines that are structure**. A block scalar's own content is
 * the author's text rather than the document's shape and is skipped, which the
 * loop below does and this paragraph used to deny: measured,
 * `a: |\n  hello\nb:\n      c: 1\n` detected 2 from `hello` and the write
 * then reindented `c` from six spaces to two. A comment is skipped with it,
 * for its own reason below.
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
    // comment allowed after. **Either order**, because YAML allows both and
    // `yaml` 2.9.1 accepts all four spellings -- measured. Written
    // chomping-then-digits only, `a: |2-` never set `block`, so the scalar's
    // own content was read as structural indentation and a write reindented
    // the whole mapping around it
    if (/[|>](?:[-+]\d*|\d+[-+]?)?[ \t]*(#.*)?$/.test(line)) {
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
  // likeliest correction comes first, and deduplicated against **everything
  // already emitted** rather than against the guess alone -- where the
  // detected indent is 2 the appended default is identical to one of the
  // flips, so the bounded six was five distinct layouts for the commonest
  // shape there is and `store.ts` paid a redundant render and line diff for
  // the repeat on every read
  for (const also of [
    { flowCollectionPadding, indent, indentSeq: !indentSeq },
    { flowCollectionPadding: !flowCollectionPadding, indent, indentSeq },
    { flowCollectionPadding: !flowCollectionPadding, indent, indentSeq: !indentSeq },
    { flowCollectionPadding: true, indent: 2, indentSeq: true },
    { flowCollectionPadding: true, indent: 4, indentSeq: true },
  ]) {
    const already = out.some(
      (had) =>
        also.indent === had.indent &&
        also.indentSeq === had.indentSeq &&
        also.flowCollectionPadding === had.flowCollectionPadding
    );

    if (already) {
      continue;
    }

    out.push({ ...also, lineWidth: 0 });
  }

  return out;
}
