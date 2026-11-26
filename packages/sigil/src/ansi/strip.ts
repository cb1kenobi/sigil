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
 * The other axis is which spelling of an introducer is read. `escOnly` reads the
 * **ESC form only** (SIG-724): the single-byte C1 introducers and the single-byte
 * ST are left out of every alternative, so a C1 character is not part of any sequence
 * and an `ESC ]` string is closed by `BEL` or `ESC \` alone. It is the same shapes
 * with the C1 spellings left off and never a second grammar.
 *
 * @param complete - `true` for the shapes with nothing left off.
 * @param escOnly - `true` to leave the single-byte C1 spellings out.
 * @returns The pattern source, as an alternation.
 */
function grammar(complete: boolean, escOnly = false): string {
  return [
    // OSC -- ESC ] ... terminated by BEL or ST. Used for hyperlinks and window
    // titles, and the payload may contain `;` and spaces.
    string(escOnly ? '\\u001B\\]' : '\\u001B\\]|\\u009D', complete, escOnly),

    // DCS, SOS, PM, and APC -- ESC P/X/^/_ ... terminated by ST
    string(
      escOnly ? '\\u001B[P^_X]' : '\\u001B[P^_X]|[\\u0090\\u0098\\u009E\\u009F]',
      complete,
      escOnly
    ),

    // CSI -- ESC [ parameters intermediates final. SGR is the one that matters
    // here, but cursor movement and erase share the shape.
    `(?:\\u001B\\[${escOnly ? '' : '|\\u009B'})[0-?]*[ -/]*${complete ? '[@-~]' : '(?:[@-~]|$)'}`,

    // everything else -- ESC, optional intermediates, one final byte. A complete
    // one has its final, and with no intermediate it is not an introducer: `ESC [`,
    // `ESC ]`, `ESC P`, `ESC X`, `ESC ^` and `ESC _` open a sequence of another
    // shape, so one that nothing followed is not a two-byte sequence of its own.
    complete ? '\\u001B(?:[ -/]+[0-~]|[0-OQ-WYZ\\\\`-~])' : '\\u001B[ -/]*[0-~]?',
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
 * the single-byte C1 one, or the `ESC` form alone.
 * @param complete - Whether it has to end in a terminator, `BEL`, `ESC \` or
 * U+009C, rather than wherever a terminal stops reading it.
 * @param escOnly - Whether U+009C is left out of the terminators. It still ends
 * the payload, as `CAN` does, so a string it interrupts is one that never ended
 * rather than one that carries on past it.
 * @returns The pattern source.
 */
function string(introducer: string, complete: boolean, escOnly: boolean): string {
  // the payload runs until something ends it, and the empty alternative at the
  // end of the terminator group is what lets an ESC that is not `ESC \` end the
  // payload without being consumed by it
  const ends = complete ? '' : '|\\u0018|\\u001A|';
  const st = escOnly ? '' : '|\\u009C';
  return `(?:${introducer})[^\\u0007\\u0018\\u001A\\u001B\\u009C]*(?:\\u0007|\\u001B\\\\${st}${ends})`;
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
 * The C1 characters that open a string sequence, which `grammar()` spells out in
 * its first two alternatives: the ones that, with nothing to end them, run to the
 * end of what is there.
 */
const unended = /[\u0090\u0098\u009D\u009E\u009F]/gu;

/**
 * What `stripWellFormed()` takes as its third argument.
 */
export interface StripWellFormedOptions {
  /**
   * How an 8-bit C1 character (U+0080 to U+009F) is read. `'sequence'`, the
   * default, is `strip()`'s reading: U+009B opens a CSI, U+009D an OSC, U+0090 a
   * DCS, and U+009C ends a string, so a C1 introducer that something later ends is
   * a whole sequence and takes the text between. `'text'` removes only the `ESC`
   * form -- `ESC [`, `ESC ]`, `ESC P`, `ESC X`, `ESC ^`, `ESC _` and a two-byte
   * `ESC` sequence -- and replaces every C1 character with the replacement, so
   * none of them takes any text. A string sequence opened with `ESC` is then closed
   * by `BEL` or `ESC \` alone, and U+009C inside one is not a terminator.
   *
   * @default 'sequence'
   */
  c1?: 'sequence' | 'text';
}

/**
 * Removes every escape sequence that is whole, and marks what is not (SIG-710).
 *
 * `strip()` is a terminal's reading, and a terminal that meets a lone `ESC` or a
 * C1 introducer starts waiting for the rest of a sequence: `caf\u009F rest` is a
 * DCS that never ends, so `strip()` answers `caf`. For a string a person wrote,
 * and above all one decoded as Latin-1 when it was UTF-8, where the C1 range is
 * the second byte of ordinary punctuation, that eats the text. This reads the same
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
 * keeps its words. Two caveats from the grammar rather than from this, both the
 * terminal's own reading: `ESC` followed by a letter is the two-byte sequence
 * `strip()` has always taken, so `ESC x` is removed as a unit, and a C1 introducer
 * is whole as soon as something ends it -- `U+009B`, a space and an `s` are one
 * CSI, and a U+009D that a later U+009C closes is one OSC, so Latin-1 text with
 * a pair of curly quotes in it can still lose the words between them. What this
 * guards is the introducer that nothing ends, not every C1 character -- unless
 * `options.c1` is `'text'`, which reads no C1 character as an introducer at all.
 *
 * @param str - The string.
 * @param replacement - What stands for an introducer that began nothing, such as
 * `'\uFFFD'`. It should be text that cannot continue a sequence: it is read as
 * part of what follows an unended string sequence, so a parameter byte such as
 * `?` can join a C1 CSI there.
 * @param options - `{ c1: 'text' }` reads only the `ESC` form as a sequence and
 * marks every C1 character (SIG-724); see `StripWellFormedOptions`.
 * @returns The string with the whole sequences gone and the rest kept.
 */
export function stripWellFormed(
  str: string,
  replacement: string,
  options: StripWellFormedOptions = {}
): string {
  const escOnly = options.c1 === 'text';
  if (!hasIntroducer(str)) {
    return str;
  }
  const whole = new RegExp(`^(?:${grammar(true, escOnly)})$`);
  // a C1 character the grammar has no shape for is matched last, so it is the
  // alternative only where nothing above it took the character
  const any = new RegExp(`${grammar(false, escOnly)}|[\\u0080-\\u009F]`, 'g');
  let out = '';
  let from = 0;
  for (let found = any.exec(str); found !== null; found = any.exec(str)) {
    out += str.slice(from, found.index);
    from = any.lastIndex;
    if (!whole.test(found[0])) {
      // one introducer and then text, and the text is read again. A string
      // sequence that was never ended ran to the end of the match, so every
      // string introducer inside it was never ended either and is marked here,
      // in one pass: resuming at each of them instead would run each one to the
      // end of the string, which is quadratic in a run of lone U+009D. What is
      // left cannot hold one, so the second call is over text with nothing in it
      // to loop on
      out +=
        replacement +
        stripWellFormed(
          found[0].slice(1).replace(unended, () => replacement),
          replacement,
          options
        );
    }
  }
  return out + str.slice(from);
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
