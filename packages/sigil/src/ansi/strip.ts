import { ESC } from './codes.js';

/**
 * The grammar, written once and read two ways.
 *
 * `matcher()` and `strip()` read it **loose**, which is the terminal's reading:
 * every sequence runs to wherever it stops, and one that is cut short is still
 * matched to the end of what there is. `stripWellFormed()` also needs to know
 * which of those matches is a sequence a terminal would have carried out, and
 * that is the **complete** reading: the same four shapes, each held to the
 * piece the loose one lets go -- a string sequence to a real terminator, a CSI
 * to its final byte, an `ESC` to the byte it escapes. Two spellings of one
 * grammar is how a match and the test of whether it was complete come to
 * disagree, so the difference between them is the three places `complete` is read and no more.
 *
 * @param complete - `true` for the shapes with nothing left off.
 * @returns The pattern source, as an alternation.
 */
function grammar(complete: boolean): string {
  return [
    // OSC -- ESC ] ... terminated by BEL or ST. Used for hyperlinks and window
    // titles, and the payload may contain `;` and spaces.
    string('\\u001B\\]|\\u009D', complete),

    // DCS, SOS, PM, and APC -- ESC P/X/^/_ ... terminated by ST
    string('\\u001B[P^_X]|[\\u0090\\u0098\\u009E\\u009F]', complete),

    // CSI -- ESC [ parameters intermediates final. SGR is the one that matters
    // here, but cursor movement and erase share the shape.
    `(?:\\u001B\\[|\\u009B)[0-?]*[ -/]*${complete ? '[@-~]' : '(?:[@-~]|$)'}`,

    // everything else -- ESC, optional intermediates, one final byte. A complete
    // one has its final, and it is not `[`: `ESC [` is a CSI introducer that no
    // parameter or final followed, so it is not a two-byte sequence of its own.
    complete ? '\\u001B[ -/]*[0-Z\\\\-~]' : '\\u001B[ -/]*[0-~]?',
  ].join('|');
}

/**
 * Every escape sequence a terminal might be handed, in the order the
 * alternation has to try them.
 *
 * The generic two-character form at the end would otherwise swallow the `[` of
 * a CSI sequence or the `]` of an OSC and leave the parameters behind as text,
 * so the framed sequences come first.
 *
 * The string sequences -- OSC, DCS, and the rest -- run to their terminator,
 * but they also stop at everything a terminal stops them at: `CAN` and `SUB`
 * cancel one, and an `ESC` that is not the `ESC \` of a string terminator ends
 * one and begins something else. A sequence that just runs off the end of the
 * string ends there. Without that, one unterminated OSC would swallow every
 * printable character after it.
 *
 * What this does not model is a sequence interrupted mid-parameter by a control
 * character -- `ESC [ 3 1 LF m` is, to a terminal, a line feed performed in the
 * middle of `ESC[31m`. Matching that needs the state machine rather than a
 * regular expression, and the failure is in the safe direction: the parameter
 * bytes survive as text rather than real text being eaten.
 */
const sequences = grammar(false);

/**
 * One of the sequences that frames a string payload.
 *
 * @param introducer - The alternation that opens it, both the `ESC` form and
 * the single-byte C1 one.
 * @param complete - Whether it has to end in a terminator, `BEL`, `ESC \` or
 * U+009C, rather than wherever a terminal stops reading it.
 * @returns The pattern source.
 */
function string(introducer: string, complete: boolean): string {
  // the payload runs until something ends it, and the empty alternative at the
  // end of the terminator group is what lets an ESC that is not `ESC \` end the
  // payload without being consumed by it
  const ends = complete ? '' : '|\\u0018|\\u001A|';
  return `(?:${introducer})[^\\u0007\\u0018\\u001A\\u001B\\u009C]*(?:\\u0007|\\u001B\\\\|\\u009C${ends})`;
}

/**
 * Matches one escape sequence, and nothing else.
 *
 * Built fresh per call rather than shared, because a `g` flagged regex carries
 * `lastIndex` and sharing one across calls makes `test()` and `exec()` answer
 * differently depending on what ran before.
 *
 * Exported because removing sequences is not the only thing anything wants to
 * do with them: the wrapper has to find them in order to keep them out of a
 * column count and out of the middle of a line break, which is the opposite of
 * stripping them.
 *
 * @returns The matcher.
 */
export function matcher(): RegExp {
  return new RegExp(sequences, 'g');
}

/**
 * Removes every escape sequence from a string.
 *
 * This is the first half of measuring a styled string honestly -- a sequence
 * occupies no columns at all, so nothing can be measured until they are gone.
 * It is only the first half: what is left is still text whose width is not its
 * length, since a lone control character prints nothing, a combining mark
 * prints on top of what came before, and an East Asian character takes two
 * columns. That is the display-width module's job, not this one's.
 *
 * @param str - The string to strip.
 * @returns The string with no escape sequences left in it.
 */
export function strip(str: string): string {
  return hasIntroducer(str) ? str.replace(matcher(), '') : str;
}

/**
 * Removes every escape sequence that is whole, and marks what is not (SIG-710).
 *
 * `strip()` is a terminal's reading, and a terminal that meets a lone `ESC` or a
 * C1 introducer starts waiting for the rest of a sequence: `caf\u009F rest` is a
 * DCS that never ends, so `strip()` answers `caf`. For a string a person wrote,
 * and above all one decoded as Latin-1 when it was UTF-8, where the C1 range is
 * ordinary letters' second bytes, that eats the text. This reads the same
 * grammar the other way, as the complete shapes `grammar(true)` names, so
 * what it removes is exactly the sequences `strip()` would remove **that have an
 * end**:
 *
 * - SGR and every other CSI, up to its final byte;
 * - OSC, DCS, SOS, PM and APC, up to a `BEL`, `ESC \` or U+009C terminator;
 * - `ESC`, any intermediates, and the byte it escapes.
 *
 * Anything that matches `strip()`'s pattern and is not that -- an OSC run off the
 * end of the string, or cancelled by `CAN` or `SUB`; a CSI with no final byte;
 * `ESC [` alone; a bare `ESC` -- is one introducer and then text. The
 * introducer is replaced by `replacement` and what follows it is kept, read
 * again, so a second introducer inside it gets the same answer. A C1 character
 * that `strip()` does not treat as an introducer (U+0080 to U+008F, U+0091 to
 * U+0097, U+0099, U+009A and U+009C) starts nothing and is replaced the same way:
 * it is as lone as a lone one gets.
 *
 * Unterminated is decided rather than defaulted, because it is the one case
 * where a sequence is plausibly meant: `ESC ] 0 ; title` cut off at the end of
 * a string. It is not removed. Its introducer is replaced and its parameters
 * stay as text, which is the same answer as `caf\u009D rest` needs and is the
 * safe one -- a string that was meant to be an OSC loses its effect, which a
 * drawn cell had no way to carry out anyway, where one that was never meant to be
 * keeps its words. One caveat from the grammar rather than from this: `ESC`
 * followed by a letter is the two-byte sequence `strip()` has always taken, so
 * `ESC x` is removed as a unit.
 *
 * @param str - The string.
 * @param replacement - What stands for an introducer that began nothing, such as
 * `'\uFFFD'`.
 * @returns The string with the whole sequences gone and the rest kept.
 */
export function stripWellFormed(str: string, replacement: string): string {
  if (!hasIntroducer(str)) {
    return str;
  }
  const whole = new RegExp(`^(?:${grammar(true)})$`);
  // a C1 character the grammar has no shape for is matched last, so it is the
  // alternative only where nothing above it took the character
  return str.replace(new RegExp(`${sequences}|[\\u0080-\\u009F]`, 'g'), (found) =>
    whole.test(found) ? '' : replacement + stripWellFormed(found.slice(1), replacement)
  );
}

/**
 * Whether a string holds anything `strip()` acts on: an `ESC`, or a single-byte
 * C1 character (U+0080 to U+009F).
 *
 * This is not `hasAnsi()`. That asks whether a whole sequence is there, and the
 * answer can change when the string is cut: `\u009b12` is a sequence and
 * `\u009b12中` is not, so a slice of a string with no sequence in it can still
 * have one. Every sequence starts with one of these characters, so a string
 * without one is a string that `strip()` leaves alone, and so is every slice of
 * it. That is what a caller measuring a string piece by piece needs to know.
 *
 * @param str - The string to test.
 * @returns `true` when `strip()` may remove something from it or a slice of it.
 */
export function hasIntroducer(str: string): boolean {
  return str.includes(ESC) || hasC1(str);
}

/**
 * Whether a string contains an escape sequence.
 *
 * @param str - The string to test.
 * @returns `true` when at least one sequence is present.
 */
export function hasAnsi(str: string): boolean {
  return matcher().test(str);
}

/**
 * The single-byte C1 introducers, which start a sequence without an `ESC` in
 * front of them. Rare, but `strip()` would otherwise have to run the full
 * matcher over every string to find out, and the common case is a string with
 * no sequences in it at all.
 *
 * @param str - The string to test.
 * @returns `true` when the string contains a C1 introducer.
 */
function hasC1(str: string): boolean {
  for (let i = 0; i < str.length; i++) {
    const code = str.charCodeAt(i);
    if (code >= 0x80 && code <= 0x9f) {
      return true;
    }
  }
  return false;
}
