/** C0, `DEL` and C1, named rather than enumerated, as the build's escape pass names them. */
const CONTROL = /\p{Cc}/gu;

/**
 * A value as a message may quote it, with nothing in it a terminal would act on.
 *
 * Every control character becomes `\xNN`, two upper-case hex digits -- the
 * spelling the build's escape pass writes and the one `util.inspect` prints --
 * so `ESC ] 0 ; PWNED BEL` in a mistyped command arrives on stderr as the text
 * `\x1B]0;PWNED\x07` rather than as a sequence that renames the reader's
 * window. `\p{Cc}` is exactly C0, `DEL` and C1, every one of them below
 * U+0100, so two digits always suffice: U+009B, the one-character CSI, is
 * `\x9B`, which is also what that escape means to JavaScript.
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
 * @returns The string, with each control character as `\xNN`.
 */
export function escapeControls(value: unknown): string {
  return String(value).replaceAll(
    CONTROL,
    (c) => `\\x${c.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}`
  );
}
