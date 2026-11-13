/**
 * A string as a regular expression that matches exactly it.
 *
 * `RegExp.escape()` is the standard answer and is not there at the Node 22.19
 * floor `engines` names, so this is the stand-in until it is. Every character
 * the pattern grammar gives a meaning to outside a class is escaped -- `\`, `^`,
 * `$`, `.`, `*`, `+`, `?`, `(`, `)`, `[`, `]`, `{`, `}` and `|` -- each with a
 * backslash, which is an identity escape that is legal with and without the `u`
 * and `v` flags. The result is meant for `new RegExp()`, which takes the pattern
 * as a string and so never needs a `/` escaped: that is a delimiter of the
 * literal syntax, not of the grammar.
 *
 * One function rather than one per caller, which is the rule the root
 * `AGENTS.md` writes down for a helper across packages as well as inside one:
 * the pager's literal search and three of `sigil build`'s rolldown filters each
 * spelled the class out separately, and the pager's copy had picked up a `/` the
 * others did not have. The toolchain imports this one from
 * `@ttylabs/sigil/reference`, the subpath `byCodeUnit()` reached it through.
 *
 * Not the debug logger's: a `DEBUG` namespace escapes everything here **but**
 * `*`, because `*` is its wildcard, so that is a different function rather than
 * a copy of this one.
 *
 * @param text - What to match literally.
 * @returns The pattern source.
 */
export function escapeRegExp(text: string): string {
  return text.replaceAll(/[\\^$.*+?()[\]{}|]/g, '\\$&');
}
