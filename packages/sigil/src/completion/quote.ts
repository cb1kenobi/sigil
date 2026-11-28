/**
 * What a shell word is made of, written once.
 *
 * Three readers need the same few decisions and they must not drift: the two
 * emitters quote a word for a script (`bashQuote()`, `zshQuote()`), the bash
 * script quotes a candidate as it is inserted (`__x_put`, which is shell code
 * written out by `./bash.ts`), and `quoteWord()` in `./words.ts` quotes a
 * candidate a REPL inserts into a line. "Which characters are safe bare" is the
 * first of them and "how a character that is not safe to print is written" the
 * second, and a copy of either goes stale in whichever place nobody is reading.
 *
 * It imports `escapeControls()` and nothing else, so it can be on the root
 * entry's graph without anything the emitters need coming with it.
 */

import { escapeControls } from '../util/escape-controls.js';

/**
 * The punctuation a word may hold bare, besides letters and digits.
 *
 * `[:alnum:]_@%+=:,./-` is what the bash script tests a candidate against before
 * it reaches for `printf %q` (SIG-414), and the part that is not a character
 * class the shell defines is this. `quoteWord()` reads the same string, with
 * letters and digits taken as the Unicode ones where bash's `[:alnum:]` is
 * whatever the locale says -- so a word is bare in both exactly when neither
 * could mistake it for anything else (`quoteWord()` also quotes a leading `=`, which zsh
 * and not bash expands). `-` is last so it is a hyphen in a class.
 */
export const SAFE_PUNCTUATION = '_@%+=:,./-';

/**
 * A string as one shell word, single-quoted.
 *
 * POSIX single-quoting, which is one rule rather than bash's and zsh's: a path
 * this interpolates into a startup file comes out of `homedir()` and may hold a
 * space -- `~/Library/Application Support` is the obvious one -- or a quote, and
 * an unquoted line is a shell injection into a file that runs on every login.
 * `bashQuote()` is this function, so the two cannot come to disagree about what
 * a quoted word is.
 *
 * @param text - What to quote.
 * @returns It, as one word.
 */
export function shQuote(text: string): string {
  return `'${text.replaceAll("'", "'\\''")}'`;
}

/**
 * Whether one character is one that must not be written raw.
 *
 * The question is `escapeControls()`'s, asked of one character at a time, so
 * the class -- the C0 and C1 controls, the format characters, U+2028 and
 * U+2029, the default-ignorable code points and U+2800 -- is defined once
 * (SIG-576, SIG-483).
 *
 * @param char - One character.
 * @returns Whether it is in that class.
 */
export function isUnsafeChar(char: string): boolean {
  return escapeControls(char) !== char;
}

/**
 * The inside of a `$'...'` quote for a string: what a shell reads as that string
 * with nothing in it a terminal would act on.
 *
 * Each character `isUnsafeChar()` names is its UTF-8 **bytes**, each as `\xNN`:
 * inside `$'...'` that escape is one byte in bash and in zsh, so it is the one
 * spelling that names the same string in bash 3.2, which has no `\u`, and in zsh
 * under any locale. The backslash and the quote are the two characters the form
 * needs for itself; everything else is as it stands.
 *
 * @param text - What to write.
 * @returns The text to put between `$'` and `'`.
 */
export function ansiCBody(text: string): string {
  let body = '';
  for (const char of text) {
    if (isUnsafeChar(char)) {
      for (const byte of Buffer.from(char)) {
        body += `\\x${byte.toString(16).toUpperCase().padStart(2, '0')}`;
      }
    } else if (char === '\\' || char === "'") {
      body += `\\${char}`;
    } else {
      body += char;
    }
  }
  return body;
}
