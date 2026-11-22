/**
 * The characters a reader cannot see, written once for every test that has to
 * agree about them (SIG-561).
 *
 * Two checks describe this set and they are different checks: the source check
 * in `sources.test.ts` refuses it in committed files, and the walk and the
 * hostile-value test in `util/escape-controls.test.ts` hold `escapeControls()`
 * to it. Each used to write the class out by hand, so widening the source check
 * left the escape's tests passing against the old class, which is how U+2800
 * got through (SIG-557). They read it from here now, so a change to the class
 * is a change to what all three expect.
 *
 * This is a copy of the class on purpose and not an import of `UNSAFE` from
 * `src/util/escape-controls.ts`: a test that read the code's own class would
 * compare the code with itself and could never fail.
 */

/**
 * The members that draw as nothing, or as a space that is not one: `\p{Cf}`,
 * U+2028 and U+2029, `\p{Default_Ignorable_Code_Point}`, and U+2800, the blank
 * braille pattern, which no property covers. The body of a character class.
 */
const HIDDEN = String.raw`\p{Cf}\p{Zl}\p{Zp}\p{Default_Ignorable_Code_Point}\u{2800}`;

/**
 * **The one deliberate difference between the source check and the escape: the
 * spaces.** `\p{Zs}` but for U+0020 is refused in committed files, because a
 * no-break space in a string is a file name nobody can type and a diff draws as
 * an ordinary one -- and is left alone by `escapeControls()`, because a space is
 * drawn, so an echoed value holding one reads as the value it is.
 */
const SPACES = String.raw`(?! )\p{Zs}`;

/**
 * What committed source may not hold: the hidden characters and the spaces.
 * Global, for `matchAll()`; read `.source` to build another flag set.
 *
 * To widen the class, add to `HIDDEN`, never a third alternative here: `ESCAPED`
 * reads `HIDDEN` and not this, so a member added only here is one the walk test
 * would not hold `escapeControls()` to.
 */
export const INVISIBLE: RegExp = new RegExp(`[${HIDDEN}]|${SPACES}`, 'gu');

/**
 * What `escapeControls()` must write as an escape: a control character, which
 * the source check names beside `INVISIBLE` rather than inside it, and the
 * hidden characters -- everything `INVISIBLE` refuses except the spaces.
 * Not global, so `.test()` carries no `lastIndex` from one call to the next.
 */
export const ESCAPED: RegExp = new RegExp(`[\\p{Cc}${HIDDEN}]`, 'u');
