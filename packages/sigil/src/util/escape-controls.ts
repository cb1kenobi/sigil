/**
 * What a message may not echo raw, named rather than enumerated.
 *
 * `\p{Cc}` is C0, `DEL` and C1 -- what the build's escape pass names. `\p{Cf}` is
 * the format characters and `\p{Zl}` and `\p{Zp}` are U+2028 and U+2029, which is
 * the class the source check refuses in this repository's own files (SIG-483)
 * for the same reason: each changes what a reader sees without changing what a
 * program reads. The no-break space and the rest of `\p{Zs}` are not here; they
 * are visible, and a value holding one reads as the value it is.
 */
const UNSAFE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu;

/**
 * A value as a message may quote it, with nothing in it a terminal would act on
 * and nothing in it that reads differently from what it is.
 *
 * Every control character becomes `\xNN`, two upper-case hex digits -- the
 * spelling the build's escape pass writes and the one `util.inspect` prints --
 * so `ESC ] 0 ; PWNED BEL` in a mistyped command arrives on stderr as the text
 * `\x1B]0;PWNED\x07` rather than as a sequence that renames the reader's
 * window. `\p{Cc}` is exactly C0, `DEL` and C1, every one of them below
 * U+0100, so two digits suffice for each: U+009B, the one-character CSI, is
 * `\x9B`, which is also what that escape means to JavaScript.
 *
 * **A format character, and U+2028 and U+2029, become `\u{NNNN}`** -- upper-case
 * hex, as above, at least four digits and as many more as the code point needs,
 * which is also what that escape means to JavaScript. Every one but the soft
 * hyphen is above U+00FF, so the two-digit spelling cannot hold them. They are not a terminal's
 * to act on, they are a reader's to be misled by: U+202E, the right-to-left
 * override, makes the terminal draw the rest of the line reversed, so a
 * message reads differently from what was written, and U+200B, U+200C and U+200D
 * are not drawn at all, so two values that print identically can differ. U+2028
 * and U+2029 end a line to JavaScript and are drawn as one by some terminals,
 * which is the forged second line again. U+FEFF, the tag characters and the
 * Arabic number signs are `\p{Cf}` too and go the same way. The soft hyphen,
 * U+00AD, is the one format character the two-digit spelling holds, so it is
 * `\xAD`.
 *
 * **The zero-width joiner is escaped like the rest**, so a joined emoji in an
 * echoed value prints with `\u{200D}` between its parts. That is the honest
 * rendering of what was typed: an echoed value is not prose, and a joiner is
 * the one character of the class a person means -- but nobody can tell from the
 * glyph whether it is there, which is the property the rest of the class is
 * escaped for.
 *
 * **`\t`, `\n` and `\r` are escaped too**, which is where this parts company with
 * the build pass. That pass leaves them alone because they are the file's own
 * formatting; inside a quoted value they are the value's content, and a newline
 * there is the worst of the set rather than the most harmless -- `mycli
 * $'x\nError: something else'` would print a second `Error:` line the program
 * never wrote, which is a forged message rather than a garbled one.
 *
 * The backslash is not escaped, so a value that already held the four
 * characters `\x1B` reads the same as one that held `ESC`. That is the price of
 * not doubling every backslash in a Windows path somebody mistyped, and it is a
 * price only in legibility: what reaches the terminal is inert either way.
 *
 * For a value the framework **echoes** -- argv, an environment variable, a
 * config file, a registry -- and not for the message around it: an app's own
 * error message keeps its SGR, because the error handler writes what it is
 * handed, which is the line SIG-412 drew.
 *
 * @param value - The value, of any type; it is turned into a string first.
 * @returns The string, with each control or format character as `\xNN` or
 * `\u{NNNN}`.
 */
export function escapeControls(value: unknown): string {
  return String(value).replaceAll(UNSAFE, (c) => {
    const code = c.codePointAt(0) ?? 0;
    const hex = code.toString(16).toUpperCase();
    return code < 0x100 ? `\\x${hex.padStart(2, '0')}` : `\\u{${hex.padStart(4, '0')}}`;
  });
}
