import { withoutUnsafe } from './escape-controls.js';

/**
 * A description as one line, with nothing a terminal would act on in it.
 *
 * Every run of whitespace becomes one space and then every control character
 * and every format character goes (SIG-610): the class `escapeControls()` names,
 * so that U+202E -- which reverses the line a menu draws it on -- and the
 * zero-width characters, which are not drawn at all, are not in a description a
 * shell prints on every tab. A joined emoji loses its joiner and a heart its
 * variation selector, which is what that class costs a description.
 *
 * The order matters: `\s+` collapses first so that a newline is replaced
 * by a space rather than removed, which is what joins two wrapped words rather
 * than running them together. A description is one line wherever it is printed
 * -- a shell's completion menu, a table row, a paragraph, a front-matter value --
 * and a raw escape in a file something is about to print is a sequence waiting
 * to be executed.
 *
 * Collapsing is not a substitute for quoting and is not treated as one: a quote
 * or a backtick survives this untouched, and each printer escapes its own.
 *
 * One function for the completion spec and the toolchain's markdown reference,
 * which each wrote it out; published from `@ttylabs/sigil/reference` for the
 * second, because that is the subpath whose surface it is printing.
 *
 * @param text - The description.
 * @returns It on one line, which may be empty.
 */
export function descriptionLine(text: string): string {
  // collapsed again after the strip, because a format character between two
  // spaces leaves two of them
  return withoutUnsafe(text.replaceAll(/\s+/gu, ' ')).replaceAll(/\s+/gu, ' ').trim();
}
