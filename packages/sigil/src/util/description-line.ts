/** Every control character, named rather than enumerated. */
const CONTROL = /\p{Cc}/gu;

/**
 * A description as one line, with nothing a terminal would act on in it.
 *
 * Every run of whitespace becomes one space and then every control character
 * goes. The order matters: `\s+` collapses first so that a newline is replaced
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
  return text.replaceAll(/\s+/gu, ' ').replaceAll(CONTROL, '').trim();
}
