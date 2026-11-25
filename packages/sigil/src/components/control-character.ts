/**
 * Refusing a control character in a glyph a caller configures (SIG-685).
 *
 * A spinner's frames, a bar's `filled` and `empty`, a page indicator's dots and
 * an outline's marker are drawn as text and sized with `stringWidth()`, and the
 * two disagree about a control character: the tree draws a tab as a space while
 * `stringWidth()` counts it as nothing, so the cell the glyph owns came out one
 * column short per tab. A glyph holding one is a mistake rather than content, so
 * it is refused where it is configured -- the answer a toggle's state names and
 * a text area's gutter mark already gave, now written once.
 *
 * The set is `\p{Cc}`, which is C0, `DEL` and C1 and includes `\t`, `\n` and
 * `\r`. It is the rule the build's own escape pass and `escapeControls()` name,
 * and the one the toggle and the gutter used when each wrote it for itself.
 * `\p{Cf}` is not in it: a format character is drawn as nothing and measures as
 * nothing, so the two agree about it.
 */

import { escapeControls } from '../util/escape-controls.js';

/** A control character: C0, `DEL` and C1. */
const CONTROL = /\p{Cc}/u;

/**
 * Whether a string holds a control character.
 *
 * @param value - The string to ask about.
 * @returns `true` if it holds one.
 */
export function holdsControl(value: string): boolean {
  return CONTROL.test(value);
}

/**
 * Why a glyph cannot be drawn, or `undefined` if it can.
 *
 * The value is quoted with every control character escaped, since the message is
 * what a developer's terminal prints and the value is exactly what should not
 * reach it raw. This is the message a toggle's state name is refused with, which
 * says it as a prompt's refusal rather than a thrown error.
 *
 * @param what - What the glyph is, as the message names it: `spinner frames[1]`.
 * @param value - The glyph.
 * @returns The message, or `undefined` if the glyph holds no control character.
 */
export function controlFault(what: string, value: string): string | undefined {
  return holdsControl(value)
    ? `Expected ${what} to hold no control character, got "${escapeControls(value)}"`
    : undefined;
}

/**
 * Throws if a glyph holds a control character.
 *
 * @param what - What the glyph is, as the message names it: `spinner frames[1]`.
 * @param value - The glyph.
 * @throws A `TypeError` naming `what` and quoting `value`, if it holds one.
 */
export function refuseControl(what: string, value: string): void {
  const fault = controlFault(what, value);
  if (fault !== undefined) {
    throw new TypeError(fault);
  }
}
