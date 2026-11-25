/**
 * What a message may not echo raw, named rather than enumerated.
 *
 * `\p{Cc}` is C0, `DEL` and C1 -- what the build's escape pass names. `\p{Cf}` is
 * the format characters and `\p{Zl}` and `\p{Zp}` are U+2028 and U+2029, which is
 * the class the source check refuses in this repository's own files (SIG-483)
 * for the same reason: each changes what a reader sees without changing what a
 * program reads. `\p{Default_Ignorable_Code_Point}` is the rest of what Unicode
 * says a renderer draws as nothing, and it is the same name the source check
 * uses: it takes in the Hangul fillers (U+115F, U+3164), the combining grapheme
 * joiner (U+034F) and the variation selectors, which are letters and marks
 * rather than format characters and so are in none of the other classes.
 * `\u{2800}` is the one character the source check names that no property
 * covers: the blank braille pattern, a symbol (`So`) that is neither a space nor
 * default-ignorable and is drawn as a space all the same. The no-break space and the rest of `\p{Zs}` are not here; they are visible, and a
 * value holding one reads as the value it is.
 */
const UNSAFE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Default_Ignorable_Code_Point}\u{2800}]/gu;

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
 * **A format character, U+2028 and U+2029, and any other default-ignorable
 * character become `\u{NNNN}`** -- upper-case hex, as above, at least four
 * digits and as many more as the code point needs, which is also what that
 * escape means to JavaScript. Every one but the soft hyphen is above U+00FF, so
 * the two-digit spelling cannot hold them. They are not a terminal's
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
 * **The default-ignorable characters that are not format characters go the same
 * way**: U+3164 HANGUL FILLER and U+115F HANGUL CHOSEONG FILLER are letters
 * drawn blank, U+034F is a combining mark with no glyph, and the variation
 * selectors (U+FE00 to U+FE0F and U+E0100 to U+E01EF) draw nothing of their own.
 * Each one makes two values print alike that are not. **U+FE0F is escaped too**,
 * so a heart (U+2764) followed by it echoes as the heart and then `\u{FE0F}`,
 * for the reason the joiner below is.
 *
 * **U+2800 BRAILLE PATTERN BLANK goes the same way**, as `\u{2800}`: it draws as
 * a space but is a symbol rather than a space, so a value holding it prints like
 * one holding U+0020 and differs. The rest of the braille block is visible and
 * is left alone.
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
 * @returns The string, with each control, format or default-ignorable character
 * as `\xNN` or `\u{NNNN}`.
 */
export function escapeControls(value: unknown): string {
  return String(value).replaceAll(UNSAFE, (c) => {
    const code = c.codePointAt(0) ?? 0;
    const hex = code.toString(16).toUpperCase();
    return code < 0x100 ? `\\x${hex.padStart(2, '0')}` : `\\u{${hex.padStart(4, '0')}}`;
  });
}

/**
 * A value with every character `escapeControls()` would escape taken out instead
 * (SIG-610).
 *
 * The other answer to the same question, for text that is **written** rather
 * than quoted in a message: a completion script is printed by a shell on every
 * tab, so a U+202E in a description that went into one reversed the line it was
 * drawn on, and escaping it there would change what the shell reads. It is the
 * same class by construction -- the pattern is the one `escapeControls()` uses,
 * not a second one that could drift from it.
 *
 * Nothing is collapsed or trimmed: a caller that wants one line says so
 * around it, as `descriptionLine()` does.
 *
 * @param value - The text.
 * @returns It with each control, format or default-ignorable character removed.
 */
export function withoutUnsafe(value: string): string {
  return value.replaceAll(UNSAFE, '');
}

/**
 * Serialized JSON with every character `escapeControls()` would escape written as
 * a JSON `\u` escape instead (SIG-717).
 *
 * The third answer to the same question, for a document that has to stay the
 * same **value**: `JSON.stringify()` escapes C0 and leaves `DEL`, C1, U+202E and
 * the rest of the class raw, so a choice holding one reached the terminal of
 * whoever printed the schema. Neither of the other two will do -- removing a
 * character changes the value, and `\u{202E}` is not JSON. A `\u` escape parses
 * back to the same string, one per UTF-16 unit so that an astral format
 * character is written as its two surrogates, which is the only spelling JSON
 * has for one. Safe over a whole document because `JSON.stringify()` puts these
 * characters nowhere but inside a string -- with the one exception of the line
 * breaks its indentation writes, which are structure and are handed back as
 * they are. A newline inside a string is already `\n` by then, so every raw one
 * is structure. The first version escaped those too, and the document stopped
 * being JSON at its second character.
 *
 * @param json - Text `JSON.stringify()` wrote.
 * @returns The same JSON, with nothing in it a terminal acts on or hides.
 */
export function escapeUnsafeJson(json: string): string {
  return json.replaceAll(UNSAFE, (char) =>
    char === '\n'
      ? char
      : Array.from(
          { length: char.length },
          (_, i) => `\\u${char.charCodeAt(i).toString(16).padStart(4, '0')}`
        ).join('')
  );
}

/**
 * An error Node raised, with its message made inert and nothing else about it
 * changed (SIG-571).
 *
 * Node's own errors quote the path they failed on -- `EACCES: permission denied,
 * open '<path>'` -- and the path is the app's, as the file system holds it, so a
 * control character in a directory name reached the terminal raw wherever the
 * message was printed. The message is rewritten **on the error that was thrown**
 * rather than on a new one made to wrap it: a caller reads `code`, `errno`,
 * `syscall`, `path` and `dest` off what it caught, `instanceof` and identity
 * still hold, and every one of them stays the real value -- `path` in
 * particular, which code uses to find the file again. A wrapping error with a
 * `cause` would have to copy each of those across and would still be a different
 * object to anything that kept the first one.
 *
 * The old message is replaced in the `stack` too, because
 * V8 builds that header once, when the error is made, and a message edited
 * afterwards leaves the raw one in the stack that `DEBUG=sigil:error` and an
 * uncaught throw both print. Escaping is idempotent -- a backslash is not
 * escaped, so `\x1B` stays `\x1B` -- which is what lets this be applied at more
 * than one level of a call without the second pass changing the first.
 *
 * A value that is not an error, or whose `message` cannot be written, is
 * returned as it came: the rule is for what Node raises, and refusing to throw
 * what was thrown would be a worse failure than the one it prevents.
 *
 * @param error - What was caught.
 * @returns The same value, its message escaped where it is an error.
 */
export function inertError<T>(error: T): T {
  if (typeof error !== 'object' || error === null) {
    return error;
  }

  const it = error as { message?: unknown; stack?: unknown };
  const raw = it.message;
  if (typeof raw !== 'string') {
    return error;
  }

  const safe = escapeControls(raw);
  if (safe === raw) {
    return error;
  }

  try {
    const stack = it.stack;
    it.message = safe;
    if (typeof stack === 'string' && stack.includes(raw)) {
      it.stack = stack.replace(raw, () => safe);
    }
  } catch {
    // a frozen error keeps what it said, and is still thrown
  }

  return error;
}
