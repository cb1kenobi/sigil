# Syntax highlighting: a lexer per language — how it was arrived at

The settling of the ticket's open questions, the measurements, the review
findings and the sabotage pass behind "Syntax highlighting: a lexer per language,
and one seam for four components" in
[packages/sigil/src/components/AGENTS.md](../../packages/sigil/src/components/AGENTS.md)
and "A syntax token's role is the theme's table" in
[packages/sigil/src/theme/AGENTS.md](../../packages/sigil/src/theme/AGENTS.md).
The decisions are there; this is the record of how they were reached. SIG-289.

Machine: arm64 macOS, node 26.10.0, with five other agents building and testing
alongside, so the milliseconds are worth reading against each other rather than
as absolutes.

#### The questions the ticket left open

- **Tree-sitter, or a small lexer? Both?** The lexer, in core, now; tree-sitter as
  a package of its own, filed as SIG-380. The constraint decides where tree-sitter
  can live and nothing decides that it has to come first: the seam it would fill
  is the one this ticket settled, so the package is one function of that shape and
  needs nothing here to change. Its WASM load is asynchronous and every seam is
  synchronous, which is a question for that package -- an async factory that
  resolves to a synchronous highlighter is the likely answer -- and not one this
  ticket had to answer.
- **Tokens to roles.** `TOKEN_ROLE` already existed, in `prompt.ts`, for the seven
  names the seams had shipped with. It moved to `src/theme` and grew to eighteen,
  every new name a role and none a declaration, so the framework sheet's exception
  count did not move. The theme entry has the mapping and its reasons.
- **One interface?** Nearly already: the four seams shared `HighlightSpan`,
  `tokensOf()` and the roles. What differed was that markdown's hook took a
  language and the others did not. `Highlighter`, `(code, lang?) => spans`, is the
  one type now, and each component hands it what it knows of the language.

#### Checking that the seam change moved nothing

Every existing test of the four seams -- `multiline-extras.test.ts`,
`text-area.test.ts`, `diff.test.ts` and `markdown.test.ts` -- passed without an
edit, and `pnpm check` type-checked every hook those files declare, of both the
one-parameter and the two-parameter shape, against the new type. The website's
captured option tables changed in four places, all of them the type's name and the
new `lang` options.

#### Measurements

`highlightCode()` over this repository's own files, from the built package:

| input                                                     |    size |  lines |  spans |   time |
| --------------------------------------------------------- | ------: | -----: | -----: | -----: |
| `src/components/*.ts` and `src/parser/*.ts`, concatenated | 1.93 MB | 52,603 | 58,777 | ~28 ms |
| `src/components/AGENTS.md`, as Markdown                   |  844 kB |      – |  7,800 | ~16 ms |
| `.github/workflows/test.yml`, as YAML                     | 5,093 B |      – |    124 | 0.4 ms |

So the text area's 50,000-line case costs a keystroke about what SIG-283 measured
for its regex highlighter, and incremental highlighting is SIG-382.

The pathological inputs in `linear time` -- thirty of them, a million characters
each -- took at most 44 ms with every guard in place, against a two-second
deadline.

#### Review findings, before and after the first test

- **Markdown's closer searches were per line.** The first version built its
  `finder()`s inside the per-line function, so a line with a `[` and no `]` after
  it ran `indexOf()` to the end of the document -- from every such line. Found by
  reading the lexer back before a test was written, and made per document.
- **An `\s` the shell loop had no case for was a word of no characters**, and the
  loop never advanced: a no-break space hung it. The word now takes at least one
  character, and a test types one.
- **A spread was read as a member access**, so `...Foo` lost its type colour: the
  third `.` of `...` had no `.` after it. A `.` with a `.` on either side is not a
  member access.
- **Looking at real files** found the shell lexer's two worst readings: a `"$(cd
  "$d")"` -- a substitution inside a string, with quotes of its own -- ended the
  string at the inner quote, and every `case` pattern was coloured as the command it
  is not. A `$(` inside double quotes is now read as a command with the string
  carrying on after its `)`, and a `case` pattern is a word.

#### Sabotage

Seventeen sabotages, each type-checking, each run against
`test/components/highlight.test.ts` and restored from a copy compared byte for
byte afterwards.

| sabotage                                             | first pass, 200,000 chars | second pass, 1,000,000 chars |
| ---------------------------------------------------- | ------------------------- | ---------------------------- |
| a regular expression that failed is looked for again | caught, 12.7 s            | caught, timed out            |
| the shell's `${` search is `indexOf()` per call      | **survived**              | caught, 15.1 s               |
| Markdown's searches are made per line                | **survived**              | caught, 3.3 to 7.9 s         |
| a code span's closer is searched for per opener      | caught, 3.1 s             | caught, 3.3 s                |
| a shell word may be no characters long               | caught, hung              | --                           |
| the third `.` of a spread is a member access         | caught                    | --                           |
| any `}` closes a template hole                       | caught                    | --                           |
| a fenced block is never read in its own language     | caught                    | --                           |
| a `$(` inside double quotes is string                | caught                    | --                           |
| a `case` pattern is a command                        | caught                    | --                           |
| a JSON string before a `:` is a string               | caught, by three tests    | --                           |
| a YAML block scalar's lines are read as YAML         | caught                    | --                           |
| every `---` line is a patch header                   | caught, by two tests      | --                           |
| `variable` has no role                               | caught                    | --                           |
| a diff side's language ignores the other side's name | caught                    | --                           |
| a text area hands its highlighter no `lang`          | caught                    | --                           |
| a prompt hands its highlighter no `lang`             | caught                    | --                           |

The two survivors are the finding worth keeping. Both sabotages replaced a
remembered search with a fresh `indexOf()` per call, which is quadratic -- and
`indexOf()` scans at memory speed, so at 200,000 characters the quadratic finished
in well under the two-second deadline. A deadline only tells the shapes apart
where the quadratic is far past it, so the inputs went to a million characters,
where the guarded lexers take at most 44 ms and every unguarded one takes seconds.
