/**
 * The first of these variables that is set to something, by the one rule two
 * readers in this library now share.
 *
 * An empty variable is read as unset rather than as an empty value. `PORT=` in
 * a shell or a `.env` file is how a variable gets left blank, and almost always
 * means "not configured" -- while an empty value is one most data types reject,
 * so honoring it literally would fail over a variable nobody meant to set.
 * `--port=` is still the way to give an empty value deliberately, and that one
 * is not second-guessed.
 *
 * Only the empty string is falsy among the values a variable can hold, so `'0'`
 * and `' '` are both values and are returned. That is the whole rule, and it is
 * here rather than inside the parser because `@ttylabs/sigil/config` reads the
 * environment too: a config setting declaring `env` and an option declaring
 * `env` must not come to disagree about what `PORT=` means, which is the
 * two-readers-of-one-question drift this repository has half a dozen entries
 * about. One function, two callers, and a test that says so.
 *
 * @param env - The environment to read, which the parser takes from its state
 * and config takes from its options so that both are testable.
 * @param names - The variables to try, in order.
 * @returns The first value that is set to something, or `undefined`.
 */
export function envValue(
  env: Record<string, string | undefined>,
  names: Iterable<string>
): string | undefined {
  for (const name of names) {
    if (env[name]) {
      return env[name];
    }
  }
}
