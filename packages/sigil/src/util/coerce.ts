/**
 * The published face of `transform.ts`: `@ttylabs/sigil/coerce`.
 *
 * `transform.ts` is the parser's own module and carries more than a reader
 * outside the repository should be promised -- the data type sets, `checkValue()`,
 * `assertChoices()` -- so the entry is this file and not that one. What is
 * re-exported is the two functions an ejected `date()`, `number()` or command
 * palette needs, and nothing a config schema or an option initializer does.
 *
 * Re-exports only, with no code of its own: there is one `transformValue()`, and
 * an app that coerces with this one gets the answer the parser gives.
 */
export { daysInMonth, transformValue } from './transform.js';
