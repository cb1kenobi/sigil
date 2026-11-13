/**
 * Printing a command somebody will paste into a shell.
 *
 * A message that says what to run has to say it in a form a shell reads back as
 * the same arguments, and two messages in this package do: `sigil reference`'s
 * refresh command and the type check's "run `tsc` yourself" when it stops
 * reading. One definition, so the two cannot come to disagree about what needs
 * quoting.
 */

/**
 * One argument as a shell would have to read it.
 *
 * Quoted unless it is a single plain word, which is the smaller rule than
 * enumerating what a shell splits on -- and the enumeration was wrong:
 * `/[\s"'\\$`]/u` left `;`, `&`, `|`, `(`, `)` and `<` unquoted, so a
 * destination called `docs/foo;rm` printed a command whose second half is a
 * second command. Measured. The set a shell treats as ordinary is small and
 * known, so that is what is matched rather than the set it does not.
 *
 * **Single** quotes, which is the other half and was `JSON.stringify` -- double
 * quotes, inside which bash, zsh and PowerShell all still expand `$` and a
 * backtick. Measured by having bash parse the printed command: a path ending
 * `foo$HOME` was passed as `foo/Users/chris`, and one ending
 * `` foo`echo PWNED` `` ran the `echo`. A single-quoted string expands nothing
 * at all, and the one character it cannot hold is closed, escaped and reopened,
 * which is the shell's own idiom. Found by review, twice.
 *
 * @param text - The argument.
 * @returns It, safe to paste.
 */
export function word(text: string): string {
  // no `=`, which zsh expands: an unquoted word beginning with one is
  // equals-expansion, so `--out =out` -- a legal directory name -- printed a
  // command that bash passes as `=out` and **zsh** passes as `/bin/ls`'s
  // directory. Measured in the shell this diagnostic is pasted into by default.
  // `foo=bar` is quoted with it, which costs two characters. Found by review
  if (/^[\w./@:+-]+$/u.test(text)) {
    return text;
  }
  return `'${text.replaceAll("'", String.raw`'\''`)}'`;
}
