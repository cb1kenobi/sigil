/**
 * The span-and-edit layer: what every text format's writer shares.
 *
 * ## Why spans rather than a tree that reprints itself
 *
 * JSON has no comments; JSONC and YAML do, and a config file somebody
 * hand-wrote is a config file with comments in it. Two ways to keep them
 * through a round trip. A faithful CST per format -- model the trivia, attach
 * comments to nodes, print the tree back -- which is what `yaml`'s document
 * model is and is a large amount of work per format. Or **parse for spans and
 * apply minimal text edits to the original source**: to change a value, replace
 * the span it occupies; to add a key, splice at an offset. Everything untouched
 * stays untouched *by construction*, because it is still the same bytes.
 *
 * The second is already this repository's idiom for modifying somebody else's
 * file. `compile-templates.ts` splices compiled templates back into an app's
 * module against recorded spans rather than reprinting it, and `shake.ts`
 * rewrites `utilitySheet()` call sites the same way.
 *
 * It also makes a **subset reader safer** than a complete one, which is the
 * property the sibling stores rest on: a construct the reader does not
 * understand but nobody edited survives byte for byte, where a reprinter
 * corrupts it. CRLF line endings, a missing final newline, the user's
 * indentation style and their key order all come through for free -- which is
 * the lossless rule stated backwards, since **a span store cannot lose what it
 * was not asked to change.**
 *
 * `magic-string` is what `@ttylabs/cli` uses for the same job and is a
 * dependency, so the applier is written here: ordered splices over a string,
 * which is small.
 *
 * ## What is here and what is not
 *
 * Here: the span and edit types, the applier, and the questions about *text
 * offsets* that no format owns -- which line an offset is on, where that line
 * starts, what it is indented by. The **scanner** reads `LINE_END` and
 * `lineAt()` and the **writer** reads `LINE_END`, `lineStartAt()` and
 * `lineIndent()`, rather than either keeping its own, because two definitions of
 * "a line terminator" is how the two come to disagree about where a comment
 * ended. Which is three functions across two readers rather than "`jsonc.ts`
 * reads the last three", as this said for a commit: that file reads two.
 *
 * Not here: the scanner, the serialization of a *new* value, and the insertion
 * mechanics, which are per format. Same call as the two SGR tables and the two
 * route walks: share the rule and the mechanism, keep the grammars apart.
 *
 * ## It is not public API, yet
 *
 * Nothing outside this package calls it. SIG-152's YAML store edits through
 * `yaml`'s own document model, so it will not; a store written over a parser
 * with *no* editing model would want it. Decide against the first one that
 * does, rather than against one that does not -- which is the rule `which`
 * waited eighteen months on.
 */

/**
 * What ends a line.
 *
 * All four JavaScript calls line terminators rather than `\n` alone: a
 * `\r`-only file is rare and the failure is **silent**, which is the
 * combination worth spending four characters on. Not global, because
 * `RegExp.prototype.test` on a global regex is stateful -- it leaves
 * `lastIndex` past the match, so the next call on a different string starts
 * part way in. One pattern used two ways is how that happens.
 */
export const LINE_END: RegExp = /[\n\r\u2028\u2029]/;

/** A half-open range of a source text. */
export interface Span {
  /** The offset just past it. */
  readonly end: number;
  /** The offset it starts at. */
  readonly start: number;
}

/**
 * One replacement, which is an insertion where `start` and `end` are equal.
 *
 * A single shape rather than an insert and a replace, because the applier's one
 * rule -- ordered and non-overlapping -- is the same question for both and two
 * shapes would be two places to ask it.
 */
export interface Edit {
  /** The offset just past what it replaces. */
  readonly end: number;
  /** The offset it starts at. */
  readonly start: number;
  /** What goes there. */
  readonly text: string;
}

/**
 * Applies edits to a source, left to right.
 *
 * Two edits can share an offset, and what happens then is two rules. **An
 * insertion goes before a replacement** that starts there, which is what lets
 * a new key be spliced in at the offset a removed one starts at -- otherwise
 * every emitter would have to get that order right, and one that has to is one
 * that gets it wrong. **Two insertions keep the order they were emitted in**,
 * which is load bearing rather than tidy: adding a key to an object with no
 * trailing comma needs a `,` after the last value *and* a new member after the
 * line's trivia, and when there is no trivia both land on the same offset.
 * `Array.prototype.sort` is specified stable, which is what makes the second
 * rule one line.
 *
 * Overlap is a **throw** rather than a resolution, and so is an **inverted**
 * span -- the two halves of "ordered and non-overlapping", and the second was
 * missing: `[2, 1)` over `abc` came out `abXbc`, with the text duplicated rather
 * than replaced, because the cursor ends up behind where the slice did. Neither
 * is translated: a malformed pair is a bug in whichever emitter produced it
 * rather than anything a user's file can provoke, so both are bug reports in
 * English like every other invariant in this module.
 *
 * @param source - The text.
 * @param edits - The edits, in any order.
 * @returns The edited text.
 * @throws If two edits overlap, or one ends before it starts.
 */
export function applyEdits(source: string, edits: readonly Edit[]): string {
  if (edits.length === 0) {
    return source;
  }

  // an insertion before a replacement that starts at the same offset, which is
  // a rule here rather than an ordering constraint on every emitter: adding a
  // key to an object whose last member is being removed puts the new member's
  // separator at exactly the offset the removal starts at, and an emitter that
  // had to get that order right is one that gets it wrong
  const sorted = [...edits].sort(
    (a, b) => a.start - b.start || a.end - a.start - (b.end - b.start)
  );
  const out: string[] = [];
  let at = 0;

  for (const edit of sorted) {
    // an inverted span is the other half of "ordered and non-overlapping", and
    // it was the half that corrupted silently rather than throwing: `end` before
    // `start` leaves the cursor behind where the slice ended, so `[2, 1)` over
    // `abc` came out `abXbc` -- the text duplicated rather than replaced. A
    // tripwire like its sibling, since no emitter here produces one; what it
    // buys is that the day one does, it is a bug report rather than a file
    if (edit.end < edit.start) {
      throw new Error(`Inverted config edit: [${edit.start}, ${edit.end}) ends before it starts`);
    }

    if (edit.start < at) {
      throw new Error(
        `Overlapping config edits: [${edit.start}, ${edit.end}) starts inside what has already been written to ${at}`
      );
    }
    out.push(source.slice(at, edit.start), edit.text);
    at = edit.end;
  }

  out.push(source.slice(at));
  return out.join('');
}

/**
 * Counts the line a 0-based offset is on.
 *
 * Counted only when a message needs one, which is the rule the stylesheet
 * parser already keeps: counting newlines per token makes reading a file with
 * nothing wrong with it quadratic in its own length.
 *
 * Every line terminator counts, not `\n` alone, which is `LINE_END`'s own rule
 * met by the one function here that was not keeping it: a `\r`-only file
 * reported every diagnostic "on line 1", so a comment the scanner correctly
 * ended at a `\r` was named at a line it is not on. Found by review. A CRLF is
 * one line rather than two, because the `\n` after a `\r` is the same break.
 *
 * @param text - The source.
 * @param offset - The offset.
 * @returns The 1-based line.
 */
export function lineAt(text: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset && i < text.length; i++) {
    if (LINE_END.test(text[i] as string)) {
      // a CRLF is one break rather than two
      if (text[i] === '\r' && text[i + 1] === '\n') {
        i++;
      }
      line++;
    }
  }
  return line;
}

/**
 * Where the line holding an offset starts.
 *
 * @param text - The source.
 * @param offset - The offset.
 * @returns The offset of the first character of that line.
 */
export function lineStartAt(text: string, offset: number): number {
  // no clamp on `offset`, because every caller hands over a span of this text
  // -- a sabotage of one changed no answer, and a bounds guard that cannot fire
  // is one this repository deletes rather than keeps
  let i = offset;
  while (i > 0 && !LINE_END.test(text[i - 1] as string)) {
    i--;
  }
  return i;
}

/**
 * The leading whitespace of the line holding an offset.
 *
 * What the line is indented by, whatever sits further along it -- which is the
 * question a *new* nested value asks, since it is indented relative to the line
 * its container opened on.
 *
 * @param text - The source.
 * @param offset - The offset.
 * @returns The indentation, which may be empty.
 */
export function lineIndent(text: string, offset: number): string {
  const start = lineStartAt(text, offset);
  let i = start;
  while (i < text.length && (text[i] === ' ' || text[i] === '\t')) {
    i++;
  }
  return text.slice(start, i);
}

/**
 * The indentation an offset owns, or nothing where it does not own its line.
 *
 * A different question from `lineIndent()` and the two are easy to conflate:
 * this one answers "does this thing start a line, and if so how far in", which
 * is what decides whether a new sibling can copy its indentation. `{ "a": 1,
 * "b": 2 }` has two members and neither owns a line, so a third one cannot
 * inherit anything and the container's own line decides instead.
 *
 * @param text - The source.
 * @param offset - The offset.
 * @returns The whitespace back to the line start, or `undefined` where
 * something else sits between.
 */
export function ownLineIndent(text: string, offset: number): string | undefined {
  const start = lineStartAt(text, offset);
  const before = text.slice(start, offset);
  return before.trim() === '' ? before : undefined;
}
