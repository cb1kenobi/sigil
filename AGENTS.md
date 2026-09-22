# sigil

A framework for building CLI apps in Node.js, and the successor to `cli-kit`.
The heart of it is a multi-pass hierarchical argument parser built for CLIs
that lean heavily on subcommands.

Unqualified `src/...` and `test/...` paths in this file mean
`packages/sigil/src/...` and `packages/sigil/test/...`.

This is a pnpm workspace with two published packages, and the split is load
bearing.

| Package          | Name             | Dependencies                                |
| ---------------- | ---------------- | ------------------------------------------- |
| `packages/sigil` | `@ttylabs/sigil` | **Zero, and that is a hard constraint**     |
| `packages/cli`   | `@ttylabs/cli`   | Whatever it needs. Provides the `sigil` bin |

**Zero production dependencies in `@ttylabs/sigil` is a hard constraint.** Anything the
runtime needs — ANSI handling, text wrapping, dotenv, `which`, debug logging,
and everything the 2.0 stack adds on top — gets written there and bundled. Do not add a runtime dependency to `packages/sigil`; if one seems
necessary, raise it rather than adding it.

`@ttylabs/cli` is the opposite: it is a devDependency of the app rather than part
of what the app ships, so it may depend on rollup and anything else it needs.
What it _produces_ has no dependencies. Do not let that licence leak back into
the runtime.

## Layout

Paths below are inside `packages/sigil/` unless noted.

| Path                           | Contents                                             |
| ------------------------------ | ---------------------------------------------------- |
| `src/parser/`                  | The parser: commands, options, arguments, registries |
| `src/parser/command/routes.ts` | The route rules, shared with `sigil build`           |
| `src/ansi/`                    | SGR styling, strip, color support detection          |
| `src/width/`                   | Display width: grapheme clusters, East Asian Width   |
| `src/wrap/`                    | Text wrapping, SGR state, terminal width             |
| `src/help/`                    | The generated help screen, as an element tree        |
| `src/terminal/`                | Terminal wrapper, live region, sequences             |
| `src/components/`              | Spinner, progress, table, prompts, key decoding      |
| `src/signals/`                 | The reactive graph: state, computed, watcher, effect |
| `src/renderer/`                | Components, the owner tree, control flow, the frame  |
| `src/template/`                | The template IR, the `ui` tag, the JSX runtimes      |
| `src/canvas/`                  | Cell buffer, style interning, paint diff, sub-cell   |
| `src/style/`                   | Properties, values, selectors, cascade, degradation  |
| `src/theme/`                   | The framework's own sheet, and what a theme is       |
| `src/layout/`                  | The flexbox subset, over whole cells                 |
| `src/infer.ts`                 | `initOption()` and `initArg()`, in the type system   |
| `src/util/`                    | Shared helpers (type coercion, camelCase, mkdir)     |
| `src/debug/`                   | `DEBUG`-driven logger; replaces snooplogg            |
| `src/paths.ts`                 | XDG base directories                                 |
| `src/updates/`                 | npm update check, run in a spawned worker            |
| `src/error-handler.ts`         | Renders an error and sets the exit code              |
| `src/error-hooks.ts`           | Fires `beforeError` hooks; carries state on an error |
| `scripts/`                     | Run by hand: generators, and the real-terminal probe |
| `docs/parser.md`               | Parser reference: syntax, semantics, precedence      |
| `test/parser/commander/`       | Ported Commander test cases                          |
| `test/parser/yargs/`           | Ported yargs-parser test cases                       |

At the repository root: `demos/` (runnable examples that import `@ttylabs/sigil` by
name, so they need `pnpm build` first), `website/` (the Next.js site), `turbo.json`,
`tsconfig.base.json`, and the shared oxlint and oxfmt configs. Each package extends
the base tsconfig and sets its own `outDir`.

**`packages/` holds the published packages and nothing else.** `packages/*` is
the glob the workspace, turbo, vitest's `projects`, and the coverage `include`
all read, so anything put there joins all four silently -- and the two entries
that belong there are the ones the table above describes. The website is a
private Next.js app at the top level, a workspace member so it shares the
lockfile, with its own `website/turbo.json` overriding the root `build` task's
`dist/**` for `.next/**`. Turbo captures nothing from an output glob that does
not match, so inheriting the root's would cache a build it never saw and restore
an empty directory on a hit. `pnpm test` and `pnpm coverage` filter their build
to `./packages/*`: a test run has no use for the site, and CI runs the suite on
nine node-and-os combinations.

`packages/cli/src/` is the bin, `--version`, the schema the filesystem router
will replace, `src/utilities/` — the utility generator — `src/template/`, the
analysis pass and the build emitter, and `src/build/`, which reads an app off
disk: the app discovered from its manifest and entry, the command tree resolved
ahead of time, the static `desc`/`hidden` lift, the `ui` templates found in a
module, the schema literal all of that is printed as, and the type check. Its commands are not written yet, and neither is the bundling stage
that feeds `src/build/`'s output to rolldown.

`src/i18n/` is an empty placeholder.

`src/width/east-asian-width.ts` is generated. Regenerate it with
`node scripts/generate-east-asian-width.mjs <unicode-version>` from inside
`packages/sigil`, then `pnpm fmt`; the version is pinned in the script so
re-running reproduces what is committed.

## Commands

Run from the repository root. `build`, `test`, and `type-check` fan out through
turborepo; `lint` and `fmt` are repo-wide and run in a single pass.

```
pnpm test          # vitest, every package
pnpm check         # type-check + lint + format check
pnpm build         # tsdown -> packages/*/dist
pnpm fmt           # oxfmt --write
```

`pnpm test <path>`, `pnpm test -t <name>`, and `pnpm test --watch` all work
from the root: tests run through one vitest over both packages rather than
through turbo, so a path argument means what it says. Turbo drives `build` and
`type-check` only.

**`test` and `coverage` name the packages they build, one `--filter` each, and
that spelling is load bearing.** They build first because `@ttylabs/cli`'s tests
read `dist/`, and the filter keeps the website out of a run that has no use for
it. It is written as exact names rather than `--filter='./packages/*'` for two
reasons, and the second is the one that cost a morning:

- pnpm runs a script through `cmd.exe` on Windows, which does not strip single
  quotes. The filter reached turbo with the quotes still attached, so it matched
  no package — and a _name glob_ that matches nothing **exits zero**. The build
  was skipped in silence and vitest then failed on a missing `dist/`, on Windows
  only, on every open branch at once, with an error telling the reader to run
  the build they had just run. Double quotes would also survive `cmd.exe`, but
  they leave the silent no-op armed for whoever edits the filter next.
- An exact name that does not resolve exits **one**. Only a glob can match
  nothing quietly, so spelling the packages out is what makes a wrong filter
  loud. `the root build filter` in `packages/cli/test/cli.test.ts` reads the
  workspace and fails if a package is added without joining the build.

`pnpm --filter @ttylabs/cli dev <args>` runs the toolchain straight from its
source -- `node src/sigil.ts` -- with no build in between, which is the loop to
use when working on it. It needs `@ttylabs/sigil` built, like everything else in
that package, and nothing else.

`pnpm --filter @ttylabs/sigil test` scopes to one package, as does running the script
from inside its directory. **`@ttylabs/cli` needs a build first** -- its source
and its tests import `@ttylabs/sigil` through that package's `exports` map, which points
at `dist/`, so on a fresh clone `pnpm --filter @ttylabs/cli test` and the editor's
type-checking both fail until `pnpm build` has run once. Testing across the real
package boundary is the point; paying for it with a build is the price.

Run `pnpm check` before considering work finished. Formatting is oxfmt with
tabs, single quotes, and a 100-column width — run `pnpm fmt` rather than
matching it by hand.

## Scope

**The old 1.0 scope is gone.** It was the parser, help, ANSI wrapping, and ANSI
strip, with Titanium CLI as the acceptance test. All four shipped. The goal is
now considerably larger: sigil is a component runtime and a toolchain — the
Next.js for CLIs — and there is no 1.0 without it.

What that adds, bottom to top: a cell-addressable canvas that diffs frames,
cascading stylesheets with real selectors, a flexbox layout engine over whole
cells, TC39-shaped signals, an element tree, a renderer, compiled templates
with one IR behind several syntaxes, and a `sigil` CLI that builds and packages
apps. See the "sigil 2.0" project in Linear; each layer is its own ticket and
each ticket carries the decisions behind it.

The components and the help screen are ported onto it (SIG-76, SIG-77): the
spinner, the progress bar, the table and the four prompts are element trees with
the imperative API as a facade, and help is a template. `src/help/layout.ts`,
`padCell()` and `truncateCell()` are what that deleted.

The acceptance test is now `@ttylabs/cli` itself — a framework whose own
toolchain is not written in it has not been tested by anyone who had to live
with it. The Titanium port follows rather than leads, so that it finds product
problems instead of framework bugs.

What has _not_ changed: the parser, its semantics, and every entry in the list
below.

## Deliberate decisions — do not "fix" these

These look like bugs and are not. Each is intentional and covered by tests.

- **`<value>` in an option format makes the option itself required**, not just
  its value. This diverges from Commander and yargs. Use `[value]` for an
  optional option that takes a value. Asserted in
  `test/parser/options.test.ts`.
- **The default data type is `string`, not `auto`.** `auto` guesses lossily —
  it turns `007` into `7` — and makes static types unusable. It is still
  available per option.
- **Commands resolve against the innermost context; options resolve across the
  whole context chain.** These are deliberately different. Making them the
  same breaks either parent options after a subcommand, or arguments that
  repeat a command name. Both directions are covered in
  `test/parser/regressions.test.ts`.
- **An option consumes the next token unless that token resolves to a declared
  option.** `--name --verbose` leaves `--verbose` alone; `--name --undeclared`
  takes `--undeclared` as the value. Commander errors on any dash-leading
  value, but values legitimately start with a dash and a schema only knows its
  own options. See `test/parser/option-values.test.ts` and `docs/parser.md`.
- **An option takes one value per use; only arguments are variadic.**
  `multiple` collects repeated uses (`--tag a --tag b`) into an array. An
  option never eats consecutive values, so `--tag a b` leaves `b` positional;
  `<files...>` on an _argument_ is how a list of loose values is collected. A
  `...` hint on an option is therefore rejected by `initOption` rather than
  accepted as decoration. Both Commander and yargs diverge here.
- **A counter is never an array, and a string that reaches it is coerced.**
  `type: 'count'` already collects repeated uses, into a number rather than an array, so `multiple`
  on a counter is refused by `initOption()` the way a `...` hint is -- it asks for
  nothing a counter does not do, and the two were read by paths that disagreed:
  the counting path ignored `multiple` when the flag was used and `applyFallback()`
  wrapped the default when it was not, so `argv.v` was `2` used and `[0]` unused.
  The invariant is enforced where the value lands as well as where it is declared,
  because `multiple` stays editable after init and a hook could otherwise put it
  back. `transformValue()` coerces a counter like an `int` for the same reason: a
  value from the environment or a string `default` used to stay a string, so
  `VERBOSE=lots` put the word on a destination the types call a number; an empty
  value is `0`, matching `bool`, and whitespace throws, also matching `bool`.
  Either property alone is consistent, which is what said the combination was the
  bug. A counter reached with an explicit value is **set** to it rather than
  incremented, so `-v -v=5 -v` is `6`: every flag read an attached value as a
  `bool`, which a counter is not, so `-v=2` threw `Invalid boolean: "2"` and
  `-v=false` was accepted and then discarded -- the counting path increments and
  never looks at the value, so it counted up to 1. An explicit value beating the
  name it was reached by is the rule `--flag=false` already follows. Two things
  a counter does not escape, because no type escapes them: a non-string
  `default` passes through untouched, and a negated twin sharing the
  destination writes `false` -- which is why inference types that pair as
  `number | boolean`. See `test/parser/options.test.ts`.
- **An option that takes a value must be given one, required or not.** `<>` and
  `[]` say whether the _option_ has to appear -- `[value]` is an optional option
  that takes a value -- and neither says the value may be left out, so a bare
  `--port` throws `Missing value for option --port` either way. This replaces an
  earlier rule where a valueless use yielded what the data type called empty:
  that made `--port` a value, and a value from argv outranks everything, so
  `PORT=321 mycli --port` answered `0` while `PORT=321 mycli` answered `321`.
- **`--port=` is a value, and an empty one is a value only where the type has
  one.** `string` has an empty value and gets `''`; `bool` and `count` are flags
  and read empty as off; every other type rejects it the way `date` and `json`
  always did. So `--name=` is `''` even on a `<value>` option -- requiredness is
  about the option appearing, not about what it was given -- while `--port=` on
  an `int` throws `Invalid integer`. It is the one way to say "deliberately
  empty", which is why it is not second-guessed.
- **An empty environment variable is read as unset.** `PORT=` in a shell or a
  `.env` file is how a variable gets left blank and almost always means "not
  configured", while an empty value is one most data types now reject -- so
  honoring it literally would fail a parse over a variable nobody meant to set.
  It falls through to `default` instead. A counter still ends at `0` for
  `VERBOSE=`, by way of the flag's own default rather than by coercing the empty
  string.
- **An attached value is taken exactly as typed; only the name is trimmed.**
  `--name=value` splits one token, and trimming both halves made the two
  spellings of one thing disagree: a value in the following token was never
  trimmed, so `--sep=' '` was `''` while `--sep ' '` was `' '` -- and `''` on a
  `<value>` option then failed as a value never given. Whitespace in a value is
  the caller's.
- **What follows `--` goes through whole.** Extra arguments are documented as
  verbatim, and they were flattened from `inputs`, which is the split form:
  `--foo=bar` had been taken apart into a name and a value in the very first
  pass, before anything knew a terminator preceded it, so one extra argument
  arrived as two. Each token is put back as it was typed.
- **A data type rejects what it cannot represent, and whitespace is not
  empty.** An `int` past 2^53-1 used to come back as a different integer --
  `Number('9007199254740993')` is `...992` -- which is the one failure a caller
  cannot detect, so it throws. `number` used to read a whitespace-only value as
  `0`, because `Number(' ')` is `0`, while `int` threw on it. Space around a real
  number is still that number, since `Number()` trims -- only a value with
  nothing else in it is the empty one. `number` rejects an empty or blank
  value for the same reason `int` does -- `Number('')` and `Number(' ')` are both
  `0`, and neither is a number somebody wrote. A `date` has
  its calendar checked before the `Date` is built, because `Date` overflows
  instead of refusing and `2024-02-30` arrived as March 1st -- the wrong day
  rather than the error `9999-99-99` already got. Checked arithmetically and not
  by reading the parts back off the `Date`: those getters are local while the
  value may be UTC, so `2024-06-15T00:00:00Z` is the 14th in Chicago and the
  15th in Auckland, and a round trip rejected real instants depending on where
  it ran.
- **A `date` has its clock checked as well as its calendar, and it takes a UTC
  offset.** The calendar check above stopped at the day, and hour `24` is the
  overflow the `Invalid Date` guard cannot see: `24` is a legal two-digit match
  and `new Date('2024-01-01T24:00:00')` is a perfectly valid `Date` for the next
  midnight, so a value naming January 1st arrived as the 2nd -- the same failure
  `2024-02-30` arrived as March 1st is written down for. Minute and second `60`
  are refused alongside it, so a leap second is this library's answer rather
  than whatever the engine happens to do. Read off the matched text and never
  off the built `Date`, for the reason already recorded: those getters are local
  while the value may be UTC. The offset is the other half of it -- the docs
  said ISO 8601 while `dateRE` took a trailing `Z` and nothing else, so
  `2024-06-15T12:00:00+00:00`, which is what `date -Is` prints, was rejected
  while the `Z` spelling of the same instant was taken. The subset is the
  date-time format ECMAScript specifies and no wider: the basic form
  `20240615`, week and ordinal dates, `±HHMM`, and a space in place of the `T`
  are all outside what `Date` is _specified_ to parse, and an engine's fallback
  heuristics are not a grammar to document. An out-of-range offset is refused
  arithmetically for the reason the clock is, rather than left to `Date`, which
  only happens to reject it. See `test/parser/regressions.test.ts`.
- **`auto` runs the same checks and gives up rather than throwing.** The calendar
  check was added to `date` while `auto` went on matching the same `dateRE` with
  neither half of it, so the defect stayed alive on a second path: `2024-02-30`
  was March 1st and `2024-13-01` an `Invalid Date`, an object whose `getTime()`
  is `NaN` with nothing having said so. That path is also the default one, since
  an undeclared option is coerced with `auto` -- it is reachable without anybody
  writing `type: 'auto'`. Both now read a match through one function, because two
  readers of one pattern disagreeing about what it proves is how the first fix
  reached only one of them -- and it is why the clock and the offset above cost
  nothing to share: they went into that function rather than beside it, so the
  widened pattern and everything that reads it stayed one answer. What follows
  differs and belongs to the caller:
  `date` was asked for a date and throws, while `auto` is a ladder of guesses
  that ends at the string it was handed -- it does not throw on JSON it cannot
  parse either -- so a date-shaped string that is not a date is simply not the
  date guess. Throwing there would fail a parse over an undeclared option nobody
  declared a type for, which is the opposite of what `allowUnknownOptions` is
  for. `auto` still reads a 13-digit epoch as a number rather than a date: the
  two types match different shapes on purpose, and sharing the check does not
  merge them. See `test/parser/regressions.test.ts`.
- **A data type name is matched anchored.** `optionTypesRE` and `argTypesRE`
  were written `/^auto|bool|...|yesno$/`, where the alternation binds looser
  than the anchors -- so the pattern read as `^auto` OR `bool` OR ... OR
  `yesno$` and any string merely containing one of the middle names passed.
  `integer` and `boolean` are the two somebody actually types, and past the
  guard `transformValue()` does not know either name, so it handed back the raw
  string and a `type: 'integer'` option quietly produced `'8080'`.
- **What ships carries no raw control character, because the minifier puts back
  what the source was careful to avoid.** `src/ansi/codes.ts` builds `ESC` with
  `String.fromCharCode(0x1b)` so that a raw control character never sits in
  source, where it is invisible in an editor and in a diff -- and the minifier
  constant-folds that straight back into a raw byte, which undoes the care
  somewhere nobody was looking. A raw `ESC` in a shipped file is a sequence
  waiting for something to print it, and Node prints the offending source line
  on an uncaught error: a crash anywhere inside `style.mjs` wrote
  `ESC ] 8 ; ; ${e}` to the user's terminal -- the hyperlink opener, with the
  template literal unexpanded -- and every line after it, the stack trace
  included, was inside a link nothing ever closed. Measured on a pty: three raw
  `ESC` bytes and one OSC 8 executed, from a one-line script that only called
  `rgb()` with a bad channel. A build step escapes every C0, `DEL` and C1
  character to `\xNN`, which is the same string to JavaScript and inert to a
  terminal, and `test/dist.test.ts` reads the bytes back -- a build that quietly
  stops doing it looks exactly like one that does. `\t`, `\n` and `\r` are left
  alone as the file's own formatting. This is the same rule the alternate screen
  and the cursor already follow: a CLI that dies must not take the terminal with
  it, and that has to hold for the crash as well as for the exit.
- **And the source carries none either, which is the half nobody was checking.**
  The rule above is about what ships; it says a raw control character must never
  sit in source, "where it is invisible in an editor and in a diff" -- and the
  file that enforces it was breaking it. `tsdown.config.ts` wrote its escape
  regex as a character class of _literal bytes_, a NUL among them, and git calls
  a file binary the moment it finds one in the first 8000: so the one file whose
  whole job is keeping raw control characters out of the build had no reviewable
  diff on GitHub at all, showing `Bin 2786 -> 2858 bytes` instead. `canvas/style.ts`
  had the same literal NUL in its link guard, at byte 9376, which the heuristic
  misses -- the identical bug, waiting for the file above it to grow. Neither was
  wrong to the regex engine, and that is the point: what a raw control character
  costs is paid by whoever reads it. Both are written `\u0000` now, and
  `test/sources.test.ts` is the other half of `test/dist.test.ts` -- one reads
  what shipped, one reads what is committed. A handful of tests and demos really
  are describing a terminal's own bytes and hold them literally; they are an
  explicit list rather than an inferred rule, so that the next one is a decision
  somebody makes.
- **The styler skips an extended color's own parameters.** In the semicolon
  form `38`, `48`, and `58` spread one color over the parameters after them, and
  `reopen()` read those as attributes: `38;2;255;0;0` carries a `0`, was taken
  for a reset, and reopened the whole outer chain on top of the inner color, so
  `ansi.blue(ansi.rgb(255, 0, 0)('x'))` rendered blue. `38;5;39` carries the
  foreground's own close code and did the same. Only the semicolon form skips:
  the colon form carries the whole color inside one parameter, so there is
  nothing after it to skip and skipping anyway swallowed whatever followed.
  `src/wrap/sgr-state.ts` already
  modeled this for the wrapper; the two say it separately rather than sharing a
  module across the styler and the wrapper.
- **An extended color's semicolon form is five parameters or six, and only an
  empty color space says which.** ITU T.416 puts a color space identifier
  between the mode and the channels -- `38;2;;255;0;0` -- and both tables counted
  five, which is the same bug the skip was written to fix, reintroduced by the
  longer spelling: the blue channel was left to be read as an attribute, and a
  blue of `0` is a reset, so `ESC[1;38;2;;255;0;0m` left nothing in effect and
  `ansi.blue()` reopened over a red that came in written the long way. Six is
  taken only when that parameter is _empty_, because a non-empty color space is
  exactly as plausible a red channel and five is what every emitter writes --
  sigil's own output included, which is why nothing it emits was ever affected.
  So `38;2;1;255;0;0` is still a color and a trailing attribute. The colon form
  is untouched either way: `38:2::255:0:0` is one parameter, so there is nothing
  after it to count. Both tables changed and both stayed separate, for the reason
  the entry above gives. See `test/ansi/style.test.ts` and
  `test/wrap/sgr-state.test.ts`.
- **A sequence the wrapper cannot reopen travels with the word it applies to.**
  A break throws away the gap between two words and keeps the effect of the SGR
  that was in it, because opening the next line from the state is what writes
  those attributes back. A hyperlink has no slot in that state -- `sgr-state.ts`
  passes OSC through _untouched_, and untouched only happens when the sequence
  is written out -- so one still pending at a break was deleted: an OSC 8 open in
  front of a word that wrapped took the link away, and a close in the gap left
  every later line, and anything joined onto the result, inside the hyperlink.
  `isSgr()` is what says which of the two a sequence is, asked in one place so
  that the wrapper and the state cannot come to disagree. What is carried is
  written at the start of the next line, after the attributes that line reopens:
  SGR and OSC are separate terminal state, so their order between themselves
  says nothing. See `test/wrap/wrap.test.ts`.
- **`bool` is strict and symmetric.** `true`/`t`/`yes`/`y`/`on`/`1` are
  true, `false`/`f`/`no`/`n`/`off`/`0`/`''` are false, case-insensitively,
  and anything else throws. It does not follow minimist's
  "anything but `'false'`" rule, which made `--flag=0` true, nor
  yargs-parser's "only `'true'`", which makes `--flag=1` false. Every other
  data type already rejects input it cannot parse, and `0`/`1` is the usual
  convention for boolean environment variables.
- **Flags default to `false`, or `true` when negated — never `undefined`.**
  Commander leaves an unspecified flag undefined. A declared flag here always
  has a value, so `argv.verbose` is safe to read without a guard.
- **A bare positional name is optional; `<name>` is required.** Commander
  treats a bare name as required. Brackets are the only thing that decides it
  here, which keeps `args` readable at a glance.
- **`Missing required arguments` names the arguments that are missing, and
  nothing else.** The walk is backwards and used to report every argument
  sitting before one it had already found missing, to collect the trailing run
  of them -- which is the promotion rule said a second time and said less
  accurately. `initArgs()` already makes an optional argument before a required
  one required, so each slot in a run answers for itself, while the run also
  named a slot `applyFallback()` had just filled from a `default` or an
  environment variable: `<a>` with a default and `<b>` with nothing reported
  `<a> <b>` and asked for a value the user had supplied. The parse still fails,
  because `<b>` really is missing; only the message changed. See
  `test/parser/regressions.test.ts`.
- **String `default`s and environment values are coerced to the declared
  type.** So `default: 'yes'` on a flag is `true`, not `'yes'`, and a value
  the type rejects throws — `default: 'black'` on a flag is an error, the
  same way a default of `'nope'` on an `int` is. Non-string defaults pass
  through untouched.
- **The option format string is loose on purpose.** Extra short or long names
  become aliases rather than errors, and a bare word declares `--word`.
  Commander rejects all of those. Genuinely malformed parts — `-ws`,
  `---triple` — still throw.
- **An option and its negated twin share a destination, and the valued one
  owns it.** `'--cheese <type>'` plus `'--no-cheese'` is one destination set
  by two options, as in Commander. Unlike Commander it is order-independent,
  which costs the negated flag its implied `true`: the valued twin decides the
  default, so the pair is `undefined` until something sets it rather than
  silently `true`. A `default` declared on the flag is still honored, and
  `negate: false` opts out of the pairing. See `test/parser/options.test.ts`.
- **Producing the values and judging them are two steps, and `afterParse` fires
  between them.** It used to fire at the end of `parseArgv()`, which is before
  `processArgs()` and `processOptions()` -- the two that write `state.argv` -- so
  a hook named "after parse" saw `{}` there while `state.$` was fully populated,
  and the one thing it is for was the one thing it could not do. The fix is not
  to move it to the end: the README has always documented it as firing "after,
  before validation results are returned", and a hook that fires after the
  judging cannot fix up a value while one that fires before the values exist has
  nothing to fix. So `processArgs()` and `processOptions()` write and apply
  fallbacks, `validateArgs()` and `validateOptions()` do the judging, and the
  hook goes in between. Keeping that window is also what keeps a rule below
  reachable: a hook that replaces an option after its value was read leaves a
  value with no live writer, and it is `validates()` at judging time that stops
  that being a way around `choices`. A parse that throws on the way in -- an
  unexpected argument, a value its type rejects -- still fires no `afterParse`,
  because there is no parse to be after. See `test/parser/hooks.test.ts`.
- **`main()` handles errors instead of rejecting.** A thrown value from
  `parse()` or from the command's `run()` is rendered by `errorHandler()` —
  the message, never a stack — `process.exitCode` is set, and `main()`
  resolves with `undefined`. Its caller is a bin script, so an unhandled
  rejection dumping a stack is the wrong default. `settings.errorHandler:
false` rethrows instead; a function replaces the handler.
- **Every hook is one function, not a list of them.** `beforeParse`,
  `afterParse`, `beforeError`, `init`, `parse` and `help` all take a function,
  which is what `transform` and `settings.errorHandler` already take -- so the
  one-element array that every example used to open with is gone, and with it
  four `Array.isArray` checks and the loops behind them. What a list bought was
  registration without coordination: a plugin could append to a command it did
  not declare. That is a wrap now, and the docs say so -- read the hook, replace
  it with one that calls what it found first. Deliberate, because the framework
  has no plugin system to coordinate and a list is a worse default for the
  ninety-nine cases that declare exactly one: it reads as though order matters
  between entries nobody wrote. The `hooks` object is still copied by
  `initCommand()`, for the reason the lists used to be -- a hook that replaces a
  hook on the command it was handed must not reach back into the caller's
  declaration and change what every later parse of that schema does. What is
  _not_ copied any more is a list inside it, because there is no list.
- **A `beforeError` hook may replace the error but never suppress it.**
  Returning nothing leaves the error alone, returning a value makes that value
  the error, and a hook that throws is logged and skipped. Suppression would
  have to mean something different at every throw site — what `parse()`
  returns, whether the command still runs — and a rule that cannot hold
  everywhere is worse than no rule. Hooks fire for every throw site, inside
  `parse()` for what `parse()` throws and inside `main()` for everything
  else, innermost command first and the schema last, before rendering and
  before the `errorHandler: false` opt-out -- one per source, and a hook that
  throws is skipped without stopping the next source's. See
  `test/parser/hooks.test.ts`.
- **A `default` command is dispatched whenever argv named no command, even
  when it declares required arguments.** `default` means the name is implied,
  not that the command is a fallback that steps aside when the arguments are
  inconvenient — so `mycli` with a default `build <entry>` reports
  `Missing required arguments: <entry>` rather than silently doing nothing.
  Only applying it when there are no positionals would also make
  `mycli out.js` an `Unexpected argument`, which is the case a default command
  exists for. Two siblings both marked `default` throw while the schema is
  built; picking one would pick it by registration order. See
  `test/parser/default-command.test.ts`.
- **Undeclared options produce values rather than erroring.** `--foo` is
  `foo: true`, `--foo bar` is `foo: 'bar'`. They resolve after every command
  has been matched, coerce with `auto`, do not read `no-` as negation, and do
  not reach `state._`. `settings.allowUnknownOptions: false` restores the
  `Unknown option` error.
- **An undeclared option never writes a destination something active describes.** An
  undeclared spelling can land on one -- `--verbose` where `-v` is declared
  `{ name: 'verbose' }`, `--logLevel` where `--log-level` is declared -- and it
  arrives with none of what the declaration says: `auto` guessed its value, and the
  declared type, `choices`, `multiple`, and `transform` were all skipped. So the
  declared value stands and the undeclared one is dropped from `argv` rather than
  overwriting it. Dropped rather than an error because pass-through is what
  `allowUnknownOptions` is for, and an unlucky spelling should not fail the parse;
  what was typed is still on `state.$`. Active is every option in the chain plus
  the arguments of the command being run -- an ancestor's arguments are never read
  once a subcommand is dispatched, so they own nothing -- and it is asked at the
  moment of the write, because a `transform` or a hook can add an option while argv
  is still being walked.
- **A value is validated by whoever wrote it.** More than one declaration can reach
  one destination -- a valued option and its negated twin, an option and a
  positional argument of the same name, a nearer context's option of the same
  destination -- and each has its own `choices`. The parser records which
  declaration produced what is on a destination and validates only that pairing, so
  `--cheese brie --no-cheese` is `cheese: false` rather than
  `Invalid value "false" for option --cheese`, and a `false` the valued option
  produced itself is still checked. The old rule -- skip a `false` when a negated
  twin exists -- was a guess at the writer's identity from the value, and it was
  wrong in both directions. A value with no _live_ writer is the exception and is
  checked by every declaration that can reach the destination: that is a value a
  hook wrote on `state.argv` itself, or one whose writer a hook has since replaced,
  and without it a hook would be a way around `choices`. See
  `test/parser/options.test.ts` and `test/parser/regressions.test.ts`.
- **The first bare label in a command name is the name; the rest are
  aliases.** `'build, b'` and `'build b'` declare `build` aliased `b`. A `@` or
  `!` prefixed label is always an alias and names the command only when there
  is no bare label, so `'@ls, list'` is named `list` while `'@b'` alone is
  named `b`. Covered by `test/parser/regressions.test.ts`.
- **A `!` name prefix and an explicit `hidden` are additive.** Either one
  hides a command; an explicit `hidden: false` does not un-hide a `!` prefixed
  name — drop the `!` instead. That holds for a lazily loaded command too: the
  placeholder carries the `!`, the module never sees it. A command that
  declares neither always reads back `hidden: false`, never `undefined`, and a
  non-boolean `hidden` throws. `!` on any label hides the whole command, not
  just that one alias; an alias that should stay out of help without hiding
  the command belongs in the `alias` property, which never reaches the help
  label. Covered by `test/parser/regressions.test.ts`.

- **A command module's default export must be a plain object.** `typeof null` is
  `'object'` and so is an array, so a bare `typeof` check let both past: `null`
  fell through the merge and marked the placeholder loaded, an array merged into
  an empty command, and either way the parse succeeded with a command that has
  no `run` and a load recorded as done -- so `main()` did nothing at all, which
  is a worse answer than the error a string export already got.
- **A package's `exports` is resolved recursively.** The map nests -- `"."`
  holds conditions, a condition holds more, an array is a fallback list -- and
  unwrapping exactly one level left the ordinary
  `{ ".": { "import": "./index.js" } }` as an object, which reached `join()` as
  `[object Object]` and reported the package as having no valid export. Only the
  conditions this loader can honor are read: `import`, `node`, `default`, then
  `require`, since a CommonJS entry still loads. `browser`, `types`, and user
  conditions are skipped rather than guessed at.
- **A path in a command declaration is relative to the file that declared it.**
  A command's own `path` was resolved against the module it came from and the
  subcommands that module declared were not, so a module exporting
  `commands: { all: './all.js' }` -- the layout a large CLI actually wants --
  was looked up from the process's working directory, which for an installed
  CLI is wherever the user was standing and has nothing to do with where the
  command modules live. Three things hold it together. The directory is settled
  before the subcommands are registered rather than after, because registering
  them is what reads their paths. It is carried as `cmd[Internal].baseDir`
  rather than recovered from the command's own resolved `path`, which points
  one directory away from the file that declared it -- and is what a hook reads
  to resolve a path of its own. And it is `resolve()` rather than `join()`, so
  an absolute path stays the answer it already was instead of being hung off a
  base. `loadCommand()` therefore hands `initCommand()` the file system path
  and builds the `file://` URL only for the dynamic `import()`, which is the
  one reader that wants one: `dirname('file:///a/b.js')` is not a directory
  anything can be resolved against. A schema the app wrote inline has no file
  to be relative to, so its own paths still resolve from the working directory
  -- which is why every example passes an absolute one. Covered by
  `test/parser/regressions.test.ts`.
- **A loaded module's declaration is one file's, because the placeholder's
  subcommands are handed over already built.** They are the one thing in the
  merge that a second file wrote, and a merged declaration cannot say which
  directory each half is relative to: a placeholder giving `'./sub/build.js'` as
  its `path` and `'./all.js'` as a subcommand means `all.js` beside the file
  that declared the placeholder and everything `sub/build.js` declares beside
  `sub/build.js`, and one base cannot be both.
  So the placeholder's registry goes into `merged.commands` as initialized
  commands rather than as the paths they were declared as -- `initCommand()`
  hands an initialized command straight back, so registering them again costs
  nothing and resolves nothing -- and every path left in the merge is the
  module's own. Picking the base by where the subcommands came from was the
  first answer and it was wrong in the other direction: it gave the loaded
  command the placeholder's base, so the module's own `path` and anything a
  hook of the module's resolved were read against the wrong directory.
- **A command declares a module to load or a handler to run, and not both.**
  The module at `path` _is_ the command: `loadCommand()` builds the merge from
  its export and fills in only what the module left `undefined`, so an inline
  `run` beside a `path` is a handler that runs on exactly the modules that
  happen not to declare one -- and a path that cannot be read is a hard error
  however good the inline handler was. Neither half is a thing to pick between
  at dispatch time, so it is refused where the schema is built, the way two
  `default` siblings and a `...` hint on an option already are. The `Command`
  interface carried a `file` property alongside `path` for the same stretch,
  which nothing in either package ever read: `[key: string]: unknown` is on that
  interface for custom data, so `{ file: './build.js' }` type-checked,
  registered a command with no module and no handler, and then did nothing when
  dispatched. It is gone.
- **A path nobody named is a directory _of_ commands; a path somebody named is
  one command.** `commands: './commands'` means every route inside becomes a
  sibling, which is the one place a single path produces more than one command,
  while `commands: { db: './db' }` means one command called `db` however many
  files sit behind it. The asymmetry is what the key is for, and without it
  there is no way to say either thing: a directory that always meant "one
  command" could not express a command tree's root, and one that always meant
  "these commands" could not express a subcommand with children.
- **A route is a module file or a subdirectory, and `index` is the directory
  itself.** Inside a directory, a module file -- `.js`, `.mjs`, `.cjs`, `.ts`,
  `.mts` or `.cts` -- is a command named after the file and a subdirectory is a command named after the
  directory, as deep as the tree goes. An `index` module beside them is that
  command -- its `desc`, its `options`, its `run` -- and is never a command
  called `index`, which is one rule rather than two: where there is no directory
  command for it to be, as in a bare `commands: './commands'` whose own command
  is the schema, it is nothing at all. A directory with no `index` is a
  namespace that matches, lists what is under it, and has no `run`. An entry
  whose name starts with a `.` is skipped, because `.gitkeep`, `.DS_Store` and a
  `.git` directory all end up beside command modules and none of them is a
  command anybody wrote. Two routes claiming one name -- a `config.js` beside a
  `config/` -- throw, since keeping one of them keeps whichever `readdir` handed
  over second, which is the file system deciding what an app does; routes are
  registered sorted for the same reason.
- **A directory is walked one level at a time, when something asks.** The walk
  is `loadCommand()`'s rather than the discovery's, which is the same deferral a
  module's import already gets and the reason a tree is worth having: `mycli db
migrate up` reads `commands/`, `commands/db/` and `commands/db/migrate/` and
  nothing else, so sixty commands cost one `readdir` per level argv actually
  names and one `import`. Walking eagerly would read the whole tree on every
  invocation including `--help` and including a mistyped command -- paid by the
  unbundled apps this exists for, since a built app has its tree baked in. It is
  also what bounds a cycle through a symlink without a guard: nothing walks a
  level nobody asked for, so argv is the bound. The cost is that a subdirectory
  lists by name alone in its parent's help until it is read, which is the rule a
  lazily loaded module already follows -- and is what `sigil build` extracting
  descriptions statically is for.
- **A command module may be TypeScript, and nothing compiles it.** `.ts`, `.mts`
  and `.cts` are routes beside `.js`, `.mjs` and `.cjs`, because every runtime
  this package supports strips types on its own: `engines` says node >=22.19.0
  and stripping has been on by default since 22.18, so there is no capability to
  detect and no flag to document. A `.cts` is still CommonJS and a `.mts` still
  an ES module, since stripping erases annotations and does not rewrite module
  syntax -- and what it cannot erase, an `enum` or a namespace with a runtime
  body, is Node's limit rather than this one. A **declaration file is not a
  route**, which is the half that is invisible until it bites: `deploy.d.ts`
  parses as a name of `deploy.d` and an extension of `.ts`, so left alone it is a
  command called `deploy.d` -- and sitting beside the `deploy.ts` it describes it
  is a second claim on `deploy`, which is the two-routes-one-name error raised
  over a directory with nothing wrong with it. Compiled output is the ordinary
  way to have both. A `.ts` and a `.js` that really do both claim one name still
  throw rather than resolving by a preference order, for the reason the rule
  above gives twice over: a stale build artifact quietly winning is how somebody
  edits the file that is not being loaded. The same goes for two index modules.
  Proved by `packages/cli/test/typescript.test.ts` rather than from inside the
  suite, and that is not a stylistic choice -- vite transforms whatever a test
  file imports, so a test here proves vite can read TypeScript and not that node
  can, and it cannot read a `.cts` at all. A spawned node with no flags is the
  only thing that answers the question, which is the same reason the demos are
  spawned and the same reason a test that needs `dist/` lives in that package.
- **A package names itself, wherever it was found.** A `package.json` name beats
  the directory the package sits in, so a walk that finds `commands/pkg/` whose
  manifest says `routes-pkg` registers `routes-pkg` -- and `pkg` is then not a
  command at all. That is the rule a package a declaration pointed at already
  followed, where a key of `foo` over a path to a package registers whatever the
  package calls itself rather than `foo`, pinned by
  `test/parser/commands.test.ts`. One rule rather than one per way of arriving at
  the same directory. What differs is only what has to be read to learn the name:
  a package pointed at is imported, because its _module_ may rename it again,
  while a package a walk found is named out of its `package.json` -- a file read
  rather than an import, so the name is known in time to match on and the module
  still waits for a match. Reading that manifest per subdirectory of a level
  being walked is what the rule costs, and it is the only thing a level's walk
  reads beyond its own `readdir`. A package is also never walked for routes: its
  `exports` is what says which module is the command, so the files beside it are
  internals rather than subcommands.
- **A uid of `0` is a uid, and `mkdirOwnerSync()` owns what it made and nothing
  else.** Root is `0` and `0` is falsy, so asking `uid && gid` read a caller who
  asked for group `0` -- `wheel`, and the group of every ancestor under `/var`,
  `/usr`, and `/root` -- as a caller who asked for nothing; the walk then put
  the same `0` back through `gid ||= st.gid`, and the falsy `gid` failed the
  guard on the chown pass, so the ownership that was asked for was never
  applied. An explicit `uid: 0` was overwritten by whatever owned the nearest
  existing directory for the same reason. Whether an owner was given is a
  question about `undefined`, so that is what is asked. Both halves of the
  answer are asked about too: a directory `mkdirSync()` has just made as root is
  `0:0`, so a caller asking for `{ uid: 0, gid: 1000 }` matched on the uid alone
  and stopped with the group never applied. The deepest directory that already
  exists is the last one the call did not make, so it is where the chown pass
  stops as well as where an owner is read from -- it used to be looked for only
  in the second case, and the first was given the file system root, which is no
  ceiling: that pass climbs until it meets a directory already owned by the
  target, so a cache under `/var` handed `/var` away along with what it had just
  made. The walk itself stops at the root whether or not it found anything,
  because it climbed until it found a directory and `dirname('/')` is `'/'`: a
  loop that relies on finding something is a loop that can run off the top of
  the filesystem. Reached from the update cache, which a CLI run as root
  creates. See `test/mkdir-owner-sync.test.ts`.
- **A command is fixed once it is initialized, and its declaration containers
  are read-only.** `cmd.args`, `cmd.commands`, and `cmd.options` echo the
  declaration; the parser reads the normalized arguments and the registries at
  `cmd[Internal]`, which are a different shape on purpose. Assigning,
  deleting, or adding to one of those three throws rather than silently
  failing to reconfigure a built command. A hook changes a command through the
  registries it is handed — `options.add()`, `args.push(initArg(...))`,
  `commands.add(await initCommand(...))` — which take effect immediately. The
  Proxy `set` traps that used to stand in for this could never have worked:
  building a command or an option is async and a `set` trap is not. The same
  line is drawn on options and arguments: `choices`, `default`, `multiple`,
  `required`, `transform`, and `type` are read on every parse and are editable
  in place, while `alias`, `env`, `format`, `name`, and `negate` built the
  registry lookups and the destination, so they are read-only too. Covered by
  `test/parser/schema.test.ts`.
- **A live region shows the cursor only if it is what hid it.** `begin()` called
  `terminal.hideCursor()` and recorded the cursor as hidden whatever the call
  did, so a full-screen app that hid the cursor itself and then ran a spinner got
  it back the moment the spinner stopped -- over its own screen, which never
  asked for one. `hideCursor()` already kept the flag that made the second call a
  no-op; it now reports whether it did the work, which is the one question a
  caller that owes a `showCursor()` has to ask. Eviction works out by ordering
  rather than by a second mechanism: the region being evicted finishes, and hands
  the cursor back, before the region evicting it claims and hides again. See
  `test/terminal/live.test.ts`.
- **A terminal takes its `EPIPE` guard off again, and puts it only on the stream
  it wrote to.** The guard is a listener on somebody else's stream -- an `error`
  event with no listener is an uncaught exception, which is how
  `mycli --help | head -1` kills a CLI that did nothing wrong -- and it was the
  one thing `createTerminal()` attached that nothing ever removed: `restore()`
  detaches the `exit` and signal handlers, `onResize()` hands back an
  unsubscribe, and `guarded` was a latch that never reset. It also went on both
  streams at once however few were written, so a terminal that never touched
  stderr still left a listener on it. Both halves surfaced as one warning, and
  only from the suite: `live.test.ts` builds twenty-eight terminals over a fake
  stdout, each of them guarded the real `process.stderr`, and under vitest that
  is one `WritableWorkerStdio` shared by every test in the worker -- so the
  eleventh is Node's ten-listener leak warning, on a stream those tests never
  meant to touch. A CLI makes one terminal per process and never approaches ten,
  which is why nothing shipped was wrong and the rule still is: put back what you
  attached. `writeTo()` is where a guard is attached now, which makes the comment
  the function already carried -- attached on the first write, since a stream
  nothing writes to cannot produce one -- true of each stream rather than of the
  pair, and it happens before the write rather than after, since an `EPIPE` that
  very write provokes arrives as an event. `restore()` detaches them, after its
  own writes, because each of those re-guards the stream it goes to.
  `syncRestore()` deliberately does not: a terminal with nothing left to put back
  is still a terminal being written to, and dropping the guard there would take
  it off in the window where an `EPIPE` from the write that just happened is
  still on its way. A write after a `restore()` guards again, so the teardown
  costs nothing to a caller that carries on. See
  `test/terminal/terminal.test.ts`.

### Layout

- **The layout engine takes a `LayoutNode`, not an element.** Layout is the one
  layer in the stack testable with no terminal, no renderer, and no reactivity --
  lay a tree out, render it to a grid of characters, read the result as a picture
  -- and it keeps that only by not knowing what an element is. The element tree
  will satisfy the interface; so does a literal in a test.
- **Every division goes through `distribute()`.** Seven leftover columns across
  three children means somebody gets three and somebody gets two, and the rule
  for who has to be stable: a layout that reshuffles its rounding between frames
  shimmers, and one whose parts do not add up leaves a gap that moves.
- **`distribute()` floors and carries forward; it does not round.** Rounding
  sends the remainder backwards half the time, which put the spare cell in the
  _middle_ of a row of equal columns -- seven across three came out 2, 3, 2 --
  and contradicted the rule the function exists to keep. Flooring moves the
  remainder forward every time, so it lands on the last column.
- **Layout tests are pictures.** `test/layout/helpers.ts` renders a laid-out tree
  to a grid where each node paints its box with a letter, depth-first. A failing
  assertion that prints two grids says what went wrong; one that prints
  `{ x: 3, y: 0, width: 11, height: 2 }` does not, and there is enough arithmetic
  here for the difference to matter.
- **`order` changes where a child is placed, not where it lives.**
  `result.children[i]` still answers for `node.children[i]` whatever the ordering
  did, because everything above needs to match a box back to its element. Only
  the placement walk is sorted, and stably, so equal orders keep source sequence.
- **A property the layout engine ignores is worse than one that does not exist**,
  because it parses and then silently lies. `box-sizing`, `order`, and
  `align-content` were added to the table and are honoured here for that reason.
  `visibility` is deliberately not layout's: hidden content still takes its
  space. `overflow` is half layout's and the halves are worth separating --
  _clipping_ is the paint walk's, since it is about what reaches the screen, while
  _scrolling_ is read here, because a scrolled child's box has to be where it is
  drawn for anything above to match a box to an element.
- **`position: relative` offsets the box; `absolute` and `fixed` take it out of
  flow.** `relative` moves the box by its insets from where the flow put it and
  changes nothing else -- the space stays reserved at the un-offset position, so
  siblings are placed as though it never moved and its own children move with it,
  which is CSS. The other two are placed against a containing block instead and
  take no space at all: the flow never sees them, so an overlay does not reflow
  the panel underneath it, which is the whole reason anybody reaches for one.
  `absolute` was a parse error for as long as there was no engine to honour it,
  on the rule that a keyword which parses and does nothing is worse than one that
  does not exist; the same rule is what admits it now. `z-index` is still not
  `LAYOUT_PROPERTIES`': it changes what is painted over what, and nothing about
  where a box is.
- **An inset on a `static` box does nothing, and that is not the same lie.** It
  is CSS, it is the interaction everyone already knows, and it cannot be refused
  where the value is read anyway: `position` may be set by a different rule in a
  different sheet, and a declaration is parsed on its own. A declaration whose
  effect depends on another declaration is not a property the engine ignores.
- **A box that _moved_ is excused `checkInvariants()`, and nothing else is.**
  Landing on a sibling or leaving the parent's content box is what `relative` is
  _for_, so the containment and overlap checks skip a pair where either side was
  offset -- a check that fails on the behaviour it is checking is a check that
  gets deleted. Keyed on the used offset rather than on the keyword or on the
  declaration: `position: relative` alone moves nothing, and `top: 0` is a
  declaration that also moves nothing, so excusing either would reopen the net
  for every overflow that happens to sit under one. The helper resolves the
  insets itself rather than asking the engine, because a check that computes its
  own answer is what makes it a check. Everything else on the tree, the offset
  box's own children included, is checked as before.
- **The insets resolve a percentage per axis, unlike the margins.** `top: 50%` is
  half the containing block's height, which is CSS; percentage margins resolve
  against the _width_ on both axes there and here. Copying the margins' rule over
  would have been inventing a second oddity to keep one file consistent with
  itself.
- **An item that cannot flex is frozen at its hypothetical size; everything else
  flexes from its _basis_.** Both halves matter and getting either wrong is
  visible. Flexing from the raw basis leaves a sibling's `min-width`
  unaccounted for while the space is handed out to everyone else, and the
  trailing clamp then pushes that item past the edge with the space already
  spent. Flexing from the _clamped_ size instead pays the minimum twice, so two
  `flex: 1` columns whose content minimums differ come out unequal. The freeze
  condition is CSS §9.7.1 and it is easy to write backwards: freeze an item whose
  basis was clamped _away_ from the direction there is room to move -- a max
  pulling it down while growing, a min pushing it up while shrinking.
- **The automatic minimum is `min(content-based, specified)`.** Reporting the
  declared size flat meant a box with any children could not shrink at all,
  which is every real panel. The empty case and the non-empty case are separate
  branches and were fixed one round apart.
- **A child's declared minimum counts towards what its parent needs.** Measuring
  a shrink-to-fit container from its children's _content_ minimums alone let it
  compute itself smaller than a child's `min-width` would force at placement
  time, and the child ended up outside its parent's box.
- **The automatic minimum is content-based, so a box with no children has none.**
  Reporting its declared height as its minimum froze it at that height and
  pushed it out of a container too short to hold it -- which is the one thing
  shrinking exists to prevent.
- **`justify-content` and `align-content` share one divider, and it goes through
  `distribute()`.** A single `Math.floor()` per gap cannot hold a remainder:
  `space-evenly` over seven cells and four slots gave three gaps of one and a
  trailing gap of four, and `space-between` left the last item a cell short of
  the edge it is defined to touch. The main axis was fixed one round before the
  cross axis, which had the identical bug in the identical shape.
- **Every auto margin on a line shares the free space, wherever it sits.** A
  trailing one used to count towards the denominator and then contribute
  nothing, so two adjacent items each pushing away from the other pushed once.
- **`layout()` honours the root's own declared size.** Every other node's is
  resolved by its parent before `layoutNode()` is reached, and the root has no
  parent to do that -- so `layout(panel, { width: 80 })` gave the panel eighty
  columns however wide it said it was.
- **Measurements are cached for the length of one `layout()` call.** Without it a
  node's subtree is re-measured once per ancestor level, which is the node count
  times the depth rather than the node count -- a 5.3x multiplier at eight levels
  deep, on the most expensive operation in the stack. Per call, not persistent:
  content changes between frames and invalidating is the renderer's job.
- **`insets()` already answers for the axis.** Asking it and then swapping main
  for cross again gave a row container the _vertical_ inset as its main one, so
  a `content-box` child with `padding-left` came out three rows tall.
- **A line's cross size is the largest _clamped_ item on it.** Reading the
  unclamped value made a line too short for an item with a `min-height`, and the
  next line started on top of it.
- **Wrapping counts margins.** A five-wide item with a two-wide margin takes
  seven, and deciding on five put two of them on a ten-wide line.
- **Percentage margins resolve against the width, on both axes**, which is what
  CSS does. Resolving against the main axis made one declaration mean one thing
  at measure time and another at placement.
- **Reversing a direction moves main-start to the other edge**, so the
  justification moves with it: `flex-start` on a `row-reverse` is the right.
  Reversing only the list packed it on the left. `wrap-reverse` does the same to
  the cross axis, for `align-content` and for each item's own alignment.
- **A hidden child still gets a result, and results are matched by index.**
  `result.children[i]` answers for `node.children[i]` with no caveat, which is
  what everything above needs to match a box back to its element. Both halves
  were wrong at different times: hidden children were dropped, and rebuilding the
  list by node identity collapsed two appearances of one node into one entry.
- **A text is re-measured at the width it actually got.** Its height depends on
  its width, and the first measure happens at the whole content box before any
  flexing -- so two texts sharing twenty columns each measured twenty wide and
  one row tall, then got ten each and stayed one row.
- **That re-measure is a row's, and a column measures at the right width to begin
  with.** A row's width is its _main_ axis, so the used width is not known until
  `resolveFlexible()` has run and the basis has to stay the unclamped content
  size for the flex algorithm to do the clamping itself. A column's width is its
  _cross_ axis, which never flexes -- the child's own `max-width` is the whole of
  the answer and `makeItem()` knows it before it measures. Measuring at the
  container's width instead wrapped the text for a width the child never got: a
  `max-width: 6` text in a twenty-wide column measured two rows tall and was then
  placed six wide, where it needs six. Patching it at placement time is not the
  fix and could not be: what would have to change there is the column child's
  _main_ size, which `resolveFlexible()` has already handed out and `cursor` has
  already begun placing from. A declared `width` looks like the broken case and
  is not, because `measureUncached()` reads the child's own `width` back off it
  and measures at that -- which is why the obvious repro comes out right. The
  same width has to reach the intrinsic measure as well, or the fix only moves
  the error: a column asked how tall its child was at the container's width, got
  two, and was drawn two rows around a child six rows tall.
- **The width limits are applied in `measureUncached()` and nowhere else,
  because that is where the width they are a percentage _of_ is.** The callers
  hand it the containing width and what is settled about it; clamping at the call
  site as well resolved a `max-width: 50%` against the ten it had just produced,
  so the text wrapped at five and was placed at ten -- the same defect the clamp
  exists to fix, one level along. Neither clamp alone does that, which is what
  made it worth a third review round.
- **`measure()` takes a width to lay content out in and a block to resolve
  percentages against, and they are two arguments because they are two
  questions.** One argument answering both was `MeasureAt`'s reason for existing.
  They are the same number for an ordinary child and they part the moment a limit
  binds: a node whose `max-width` narrowed it wraps at the narrowed width, while
  its `width: 50%` still means half of the block that contains it -- so one number
  could only ever be wrong about one of them, and each caller had picked which.
  Three defects were that one shape. A `width: 10` under a `max-width: 6` was
  drawn six wide with its text wrapped for ten, so a six-row text came out three
  rows and half of it was gone. `makeItem()` resolved a child's `50%` against the
  content box and handed the measure the room left after that child's margin, so
  one declaration meant ten in one line and eight four lines down. And the root
  resolved `width: 50%` against the eight its own `max-width` left it, in forty
  columns, and wrapped its text at four.
- **A percentage against a containing block that is not settled is `auto`, and
  that is the same rule as "only a limit in cells is honoured while measuring",
  reached properly.** `MeasureAt.containing` is `undefined` rather than a number
  while an ancestor is still sizing itself, so every percentage on the node reads
  as `auto` there -- which is CSS, and which is what keeps one node from being
  measured twice to two different answers. The old spelling picked cells because a
  cell limit is the one that cannot move; this says why. What it does not buy is
  agreement between the two passes, and nothing non-iterative can: an auto-width
  column sizes itself around a child measured without the child's `max-width: 50%`
  and then places that child at the nine the percentage comes to, four rows deep
  where the column is two. That overflow is the one every browser produces, and it
  is the better of the two answers available -- the height used to be measured at
  eighteen and the box drawn at nine, so two rows of text were lost with nothing
  to show for it. What closes it for one level of nesting is the re-measure below:
  once flexing has settled an item's main size, the subtree is measured again with
  that size as a _definite_ containing block, the `50%` resolves to nine, and the
  column comes out as tall as the four rows the text needs there. One round of the
  iteration this entry said was needed, taken where the width stops being a guess.
  Pinned by `should lay a percentage-limited text out at the width it is placed
at`.
- **A container that wraps is measured as the lines it wraps into.**
  `flex-wrap` was honoured when a line was packed and ignored when the box was
  sized, which is the same defect a property that parses and does nothing is:
  every auto-sized wrapping box came out one line deep with its other lines drawn
  outside it, and a paragraph -- a wrapping row of one-word items, which is how
  inline styling is expressed here -- was the case that found it. `packLines()` is
  the measuring twin of `wrapIntoLines()`, kept separate because the two are
  handed different things while following one rule. A _row_ only: the main axis of
  a wrapping column is its height and this function is never told one, so there is
  no room to pack against. The smallest such a container can be on its main axis
  is its widest single item rather than the sum of them, because everything else
  can be pushed onto a line of its own.

  Four things have to match the placement or the measure is a different answer to
  the same question, and each was wrong once. The gap _between_ lines is reserved,
  or a `row-gap` comes out a row short per break and the block under it is drawn
  on. The packing is by `flex-basis` rather than by content, or a `flex-basis: 40`
  child with three columns of content is packed at three and placed at forty. It
  is in `order` order rather than source order, or the same three children wrap
  into two lines and are placed into three. And the minimum it clamps with is the
  placement's -- `declared ?? automatic`, not the larger of the two, which is what
  the container's own sizing needs one line above: a `min-width: 0` on a word is a
  declaration the automatic minimum does not get a say in, and taking the larger
  packed a long word at its own width where the placement shrinks it to the line.

- **The re-measure at the used width is every item's, not only a text's.** A box
  whose children wrap has the same dependency a text does -- its height is a
  question about its width, and the width is not known until flexing has settled
  -- so `remeasureLine()` asks any item with children as well as any item that
  measures. A childless box is the one case skipped, because its height cannot
  move. Left to texts alone, a paragraph came out one line tall: measured at the
  `flex-basis: 0` it starts from rather than at the remainder it was given.
- **A `measure` node reports its declaration rather than its content.** The
  `node.measure` branch reports `declaredWidth ?? content` and
  `declaredHeight ?? content`, with `min(content, declaration)` for the automatic
  minimums, the way the two branches below it already did. What an ancestor
  sizing itself around a node needs is the size the node will be _placed_ at, and
  `makeItem()` places it at its declaration: a `width: 10` text whose content
  wraps to five reported five, so an auto-width column measured itself five wide
  and drew the child outside its own box.
- **Percentage lengths are rounded per box, and no per-box rule can make siblings
  add up.** `resolve()` rounds -- `50%` of five is three -- and the reason
  recorded for it, that two boxes at 50% should still fill the row, is not
  something rounding can deliver: each sibling rounds on its own, so the two ask
  for three each in a five-wide row. What rounding does buy is that a percentage
  never collapses a box that asked for most of a cell: truncation makes those two
  two cells each and leaves a hole, and makes `10%` of five nothing at all. The
  row is put back to exactly full by the _shrink_ pass, which does go through
  `distribute()` -- three and three become three and two. Where the items cannot
  flex the overflow is real and `checkInvariants()` says so. `distribute()` is
  not available here: it hands out one total across weights that partition it,
  and a percentage is not a partition -- siblings' percentages need not sum to
  100%, cross sizes and limits and margins overlap rather than divide, and the
  same declaration is read once while measuring and again while placing, where
  the line it would be distributed over does not exist yet.
- **Pictures cannot check containment, so `checkInvariants()` does.** The picture
  helper paints later nodes over earlier ones, so an overlap is invisible, and it
  bounds-checks against the grid, so anything placed past the edge does not
  appear at all. A fuzzer found five hundred containment violations that
  forty-two picture tests had no way to see.
- **The fuzzer is committed, and it allows overflow rather than checking
  containment.** `test/layout/random.ts` generates trees and shrinks a failing
  one back down; `layout-stress.test.ts` runs five seeds of two hundred on every
  save and prints a seed and a minimal tree, written as the `box()` and `text()`
  calls that build it, when one breaks. The entry above is why it exists and is
  also why it is written down twice: the first version of it was run once, found
  its bugs, and was never committed, so the line saying a fuzzer had found five
  hundred violations described a file that did not exist for as long as anyone
  read it. Containment is the invariant it leaves alone, which is a measurement
  rather than an oversight: 41,038 of 42,000 random layouts escape something,
  because a word longer than the room is an automatic minimum that cannot shrink,
  a declared height in a shorter parent has no axis to flex on, and a `min-width`
  beside a sibling's is a pair of constraints with no solution. Every one of
  those that was shrunk and read was legitimate overflow, which is what CSS does
  and what the `overflow` option exists for -- a check that fires on what the
  engine is supposed to do is a check somebody deletes. What it does check holds
  unconditionally: no negative boxes, siblings clear of each other, and
  `checkPacking()`.
- **A zero-area box is not excused the overlap check, though nothing can be
  painted over one.** `apart` is false against a degenerate rectangle whatever
  sits where it is -- no edge of it is past any edge of anything -- which reads
  like a hole in the check and is its sharpest edge: four of the five defects the
  fuzzer found arrived as a zero-area box reported inside a sibling, and
  loosening the rule to match the intuition would have hidden all four. They were
  one bug, the entry below, rather than the harness artifact they looked like.
  Once it was fixed the strict rule fired zero times in 70,000 layouts.
- **A line's cross size is taken after its text has been re-measured, not
  before.** The two rules above -- a line is as tall as its largest clamped item,
  and a text is re-measured at the width it actually got -- were true in the
  wrong order: the re-measure ran in `placeLine()`, which is after
  `lineCrossSizes` had been read off `item.crossSize` and after the cursor had
  been walked from it. So a wrapping row whose first text wrapped to two rows at
  the width flexing gave it stayed a one-row line, and the next line was placed
  on top of that text's second row. `remeasureLine()` does it between
  `resolveFlexible()` and the line's cross size instead, and `placeLine()` reads
  the height back off the item rather than measuring again, so the height a line
  was sized for and the height its item is placed at cannot come to disagree.
  `stretch` still takes the larger of the room and that height for an item that
  measures -- a text's rows past the bottom of its box are lost, while a box
  crushed by `stretch` merely overflows with its children -- and that is a row's
  rule only, since a column's cross size is its width and stretching is entitled
  to widen it. Found by the fuzzer, through a hundred and nine hand-written tests
  that never put a text that wraps on a line that wraps.
- **A percentage of an unknown size is `auto`.** What CSS does, and what keeps a
  column layout from resolving heights against nothing.
- **`min` wins over `max` where they conflict**, as in CSS, which is what stops a
  box collapsing below its content when a stylesheet says something impossible.
- **A node's size is settled by whoever placed it, and `layoutNode()` never
  clamps it again.** `makeItem()` resolves a child's `min` and `max` against the
  containing block -- the parent's content box, which is what a percentage is
  _of_ -- and the flexible resolution clamps to them; `layout()` does the same
  for the root, whose containing block is the space it was given. Clamping a
  second time on the way down read the same declarations with less to go on, in
  two ways. A percentage resolved against the size just handed out, so a growing
  item under `max-width: 50%` in a ten-wide row was clamped to five, and the five
  was then read back as the base and clamped to three. And `min-height: auto`
  resolved to no minimum at all, because that one lives in a measurement only
  `makeItem()` takes -- so a `max` beat a minimum that is defined to beat it, and
  a three-row text came back one row tall. Either way the box was smaller than
  the hole its siblings' positions had already reserved, which is a gap nothing
  declared and which containment cannot see: a shrunken box is still inside its
  parent and still clear of its siblings. `checkInvariants()` checks the
  observable half instead -- adjacent items on a packed line abut, so a box that
  did not fill its hole moves its neighbour -- because the allocation itself is
  not in the result, which leaves an only child and the last item on a line
  uncovered.
- **The root is measured at the width it has, against the block it was given.**
  Both numbers are needed and they are not the same one: a root `width: 50%` under
  a `max-width` of eight, in forty columns, means half of forty asked for and
  eight received, so the percentage resolves against forty while the text wraps at
  eight. Every candidate for a single argument was wrong -- the clamped width
  wrapped the text at four, and the unclamped one reported a height for a box it
  would not have. This is the case that named the defect, and the entry it
  replaced said the fix "means `measure()` taking a used size as well, which is
  every caller": it was, and it is.

### Out of flow, paint order, and clipping

- **An out-of-flow box is placed against a containing block and takes no space.**
  `absolute` resolves against the padding box of the nearest positioned ancestor,
  which is CSS's containing-block rule and worth keeping because everybody
  already knows it: a dropdown anchors to the panel it was written inside rather
  than to whatever happened to be laying it out. `fixed` resolves against the
  root, which here is the canvas -- a status line pinned to the bottom of a
  full-screen app is what it is for, and a canvas is the only thing a terminal
  app has that answers to "the screen". Both frames are carried down the walk
  rather than found by climbing back up, because the walk already knows what it
  passed.
- **It does not size the parent it was taken out of**, which is CSS and is the
  useful answer: a dropdown that made its panel wider could not then be placed
  inside it. `measureUncached()` filters them out of the children it measures,
  which is the one line that makes "takes no space" true for intrinsic sizing as
  well as for placement.
- **Its size is two insets, else a declaration, else what it measures.** `left`
  and `right` together say how wide the box is, which is what `inset-0` is for;
  otherwise a declared width wins; otherwise it shrinks to fit, which is CSS.
  Where neither inset on an axis is given, the box stays at the content origin
  the flow would have started it from -- CSS's static position read as far as it
  is worth reading, since the real rule describes where a box _would_ have gone
  among siblings laid out without it.
- **Paint order is `z-index` then document order, and a non-zero `z-index` keeps
  its subtree together.** That is CSS's rule for flex items, which is every child
  here: `display: flex` is the initial value and the only other one is `none`, so
  the property applies to all of them rather than to positioned boxes alone --
  simpler to say, and what CSS says for this layout mode. Sorted stably, so
  children that share a value keep the order they were written in. A child
  ordered above its sibling takes its own descendants with it and a descendant's
  own `z-index` orders it _inside_ that child: a stacking context by another
  name, and what stops `z-index` becoming a global free-for-all that every
  component fights over with bigger integers.
- **The clip lives in the cell grid, not in the painter.** `overflow` other than
  `visible` clips what a box's descendants draw to its padding box -- never its
  own border, because the border _is_ the edge and a box that clipped itself
  would erase the frame it is drawing. It is enforced in `CellBuffer.inside()`
  because that is where the rule it needs already lived: a wide cluster with one
  column left is refused and a blank takes the column, which was written for the
  grid's own right edge, and a clip edge is the same edge one column in. Asking
  it anywhere else would be that rule said twice, and the two would come to
  disagree about what half a glyph is.
- **A nested clip intersects rather than replaces.** A panel that clips inside a
  pane that clips cannot paint where its parent could not, which is what the
  nesting means; replacing would let the inner one paint back out over the outer
  one's edge.
- **Scrolling moves the boxes rather than the drawing.** A scrolled child's box
  has to _be_ where it is drawn: everything above matches a box back to an
  element -- paint, and the hit testing input will want -- so an offset applied
  at paint time would make `box` a position nothing is at. It is applied after
  the children are placed rather than by moving the content box before them,
  because the content box is what a percentage resolves against and what the flow
  divides: scrolling must move the result, not the arithmetic. Only a box that
  clips is scrolled, since scrolling what is not clipped moves content out from
  under nothing.
- **A scrollbar is a component, not a layout feature.** The layout knows how far
  a box is scrolled and how tall its content came out; what to draw about that --
  a track, a thumb, an arrow, nothing at all -- has a dozen answers and none of
  them belong to the engine.
- **`DECSTBM` is not used for a scrolled region, and that is a decision rather
  than an omission.** A terminal's own scroll region would move a scrolled pane's
  rows for free, which for a log viewer is the whole cost of the frame. It is
  refused because the canvas's model is a grid it diffs: the diff would have to
  know that some rows moved without anything having painted them, the region is a
  rectangle of _screen_ rather than of canvas, and it cannot be used at all where
  anything is drawn over the scrolled area -- a border, a status line, an overlay
  -- which is most of the cases worth having. Revisit it behind a profile, and
  only for a pane that owns its full width.

### The element tree

- **Three host types, and the third one is a trapdoor.** `box` lays its children
  out, `text` measures a string, and `raw` paints its own cells. Everything else
  is a component that resolves to these, which is what keeps the layout engine
  small and matches what a terminal can draw. `raw` is designed in rather than
  discovered: a sparkline or an image is a thing the layout engine cannot
  express, and the alternative to a node type for it is somebody reaching for the
  canvas behind the tree's back, after which the tree is wrong about what is on
  screen. It measures like a text and is placed like one; what goes inside the
  box it got is its own business.
- **No fragment: a component produces exactly one node.** A transparent node
  would have to be transparent to layout, to `:nth-child()`, and to paint order,
  which is three different definitions of "not there" -- and the third one is
  found to be wrong months later. The cost is a wrapper box where a list of
  siblings would do, which is a real cost in a flexbox world and is still the
  smaller one. The renderer may add it knowing what it is buying.
- **`key` is carried and read by nobody here.** A keyed list diff needs stable
  identity across renders, and matching on it is the renderer's; retrofitting a
  key into a shipped tree is worse than carrying an unused prop, which is the
  whole of why it exists before anything reads it.
- **The tree records what changed; what that implies is the `Restyler`'s.**
  `Marks` is exactly the four questions the invalidator asks -- props, classes,
  children, sheets -- plus the layout and paint ones, and nothing else. Keeping
  the two apart is what lets either be tested without the other, and it is why a
  mutation is a set membership rather than a call into the cascade.
- **A subtree not in a tree records nothing.** A page built up before it is
  attached has nothing on screen to invalidate, and marking every `append()`
  would hand the first frame a set naming every element in it. Joining a tree
  carries membership down the whole subtree, so the first mutation after that is
  recorded.
- **`take()` drains rather than the caller clearing.** A mutation made _while_ a
  frame is settling lands in the next set rather than in the one being walked,
  which is the difference between a change arriving a frame late and a change
  being dropped.
- **A text is wrapped once, and paint reads the lines rather than making them
  again.** The cache used to hold the height a text came to and throw away the
  lines it came to -- which is the one thing paint needs, so paint wrapped the
  string a second time at the same width. Half of all the grapheme segmentation
  a help screen did was one of the two passes tokenizing what the other had just
  tokenized. `WrappedText` holds the lines, each line's width and the
  measurement together, because they are one answer to one question, and
  `wrapped()` is public for the same reason `displayText` is: paint lives in
  another module and asking here is what makes the answer one answer.
- **A `nowrap` text is cached under one key rather than one per width.** It is
  one line per newline whatever room it was offered, so a key per width was many
  entries holding the same answer -- and worse, layout and paint asking about
  different widths each missed the other's, so a table, whose cells are all
  `nowrap`, paid for the wrap twice over and got slower when the lines were
  first cached. The longest word is worked out only where it can be used, since
  a `nowrap` text cannot be squeezed to it and scanning for it was an answer
  thrown away.
- **A text's measurement is cached per width and keyed on the resolved style
  _object_.** The cascade hands back a new `Style` when anything about it changed
  and the same one when nothing did, so comparing the reference answers "does
  this measurement still hold" exactly -- with no list of layout-affecting
  properties to keep in agreement with `LAYOUT_PROPERTIES`. A list would be a
  second copy of that set, and the day they disagree is the day a text is drawn
  at a width it was not measured at.
- **`text-transform` is applied before the measure, not at paint time.**
  `uppercase` is what makes a line wider, which is the reason `LAYOUT_PROPERTIES`
  carries it at all -- so `displayText` is what both the measure and the paint
  read, and they cannot come to disagree about what the string is.
- **A control character is decided here, because the grid only refuses one.** The
  cell grid throws on one rather than dropping it, deliberately: a row is painted
  one call at a time, and a newline that took no cell painted a whole paragraph
  onto one line. That rule is the grid's and it is right; what it needs above it
  is somebody to say what a control character _means_, and that is `displayText`,
  for the same reason `text-transform` is applied there. A tab becomes a space,
  since the grid models no tab stops and a tab that measured one width and
  painted another takes a column off every cell to its right; a newline stays,
  since it is what a line is split on; everything else goes, since there is
  nothing for it to draw. Found as a `RangeError` out of `table()`, where
  `padCell()` had been ordinary string work -- which is also why
  `toDisplayText()` is exported: anything sizing a column has to measure what
  will be _drawn_, and a table that measured the raw string was a column out per
  tab.
- **A `nowrap` text's minimum is its widest line, not its whole string.**
  `stringWidth()` reads a newline as nothing, so a label broken over two lines
  reported the two added together as the narrowest it could be -- and a row beside
  a description placed it twice as wide as it draws, with everything after it
  pushed along. The width was already the widest line; only the minimum
  disagreed.
- **`resolveStyles()` with no sheets is the degenerate case of the cascade, not a
  second way of resolving a style.** It builds a `Restyler` over no stylesheets,
  which is props and inheritance with nothing matched -- so `box({ padding: '1' })`
  lays out padded without anybody having written a sheet, and there is still only
  one implementation of what a resolved style is. The walk is in document order,
  because a child's inherited values come from its parent's resolved style.
- **`arrange()` matches boxes to elements by index.** That is what the layout
  engine guarantees and says so: `result.children[i]` answers for
  `node.children[i]` whatever `order`, `display: none`, or the same node
  appearing twice did to the placement. Matching by identity would collapse two
  appearances of one node into one box, which is the bug the layout engine
  already carries an entry for.
- **Paint is `z-index` then document order, and `visibility: hidden` skips the
  element rather than the subtree.** Hidden is a skip rather than a return
  because `visibility` inherits: a descendant is hidden because it inherited the
  value, and one that sets `visible` is drawn. That is CSS.
- **`LayoutNode.children` is readonly, because the element tree's children are
  its own.** Nothing in the layout engine writes them, and an implementation
  cannot hand out an array anything may splice.

### Rendering a tree to a string

- **A table in a log and a help screen on stdout are element trees, and
  `renderToString()` is where they come back out.** The same layout engine, the
  same painter, the same cell grid a canvas uses -- and then the grid is read
  back as lines rather than diffed against the last frame. That is what let the
  two-column help layout and the table's column arithmetic be deleted rather
  than rewritten: what a string renderer needs that a canvas does not is a way to
  finish a line, and that is the whole of this module.
- **Every line ends in the state it began in.** One joined onto another, or
  written into a log beside something else, must not carry its colour into what
  follows. The link is closed separately from the colours, because SGR and OSC are
  separate state -- the same reason the frame end does it.
- **A blank that shows nothing is written in whatever is already open, and a
  trailing run of them is dropped.** One list decides both, and it is the
  attributes that draw on a space: a background, an underline, a strikethrough,
  an overline, an inverse, and a hyperlink. `bold`, `dim` and `italic` are not on
  it, because a space wears none of them. The first half is what stops a bold
  heading's padding surviving as trailing whitespace nobody can see; the second
  is what stops a paragraph -- which is a row of one-word elements, so the gap
  between two words is an unpainted cell -- closing and reopening its style at
  every space, which turned one dim parenthetical into a sequence per word.
- **It is laid out at the width it was given and painted into a grid as big as
  the layout came to.** `arrangedExtent()` walks the arranged tree, in both
  directions, because `measureNode()` is a guess in two ways: a row whose children
  flex is measured with each child offered the whole content box and placed with
  each given a share, and a box with a declared width reports that width however
  far its content overflows it. So a description that wrapped one line further
  than it measured is painted rather than lost, and a flag name longer than the
  terminal survives -- which is the rule help already had, and which a grid the
  width it was laid out in would have turned into a silent truncation now that
  `text-overflow` is honoured. The height is grown only where the caller named
  none, since a caller that did is describing a box rather than asking how big one
  is; the width is not the caller's to name and always follows the content.
- **It costs what the stack costs, and where that cost goes was profiled rather
  than guessed at.** A sixty-entry help screen is 10.2ms against the old string
  builder's 0.42ms, and a two-hundred-row table is 6.3ms against 0.08ms. End to
  end, where a CLI also pays Node's own startup, asking
  `demos/parser/02-options.js` for its help went from 34.7ms to 40.9ms. It is
  linear in the number of _words_ rather than of rows, at about 13 microseconds
  each, because a paragraph is a wrapping row of one-word elements -- so a
  sixty-option screen with twelve-word descriptions is seven hundred elements,
  and one with five hundred options is 168ms, which is the size at which
  somebody would notice.

  The first version of this entry said almost all of it was the cascade, at
  about 3.5 microseconds per element. That was inferred from the invalidation
  entries rather than measured, and a CPU profile says otherwise: the cascade --
  `initialStyle`, `#resolve`, `camel` and `applyPropsInto` together -- is about
  14%, while **grapheme segmentation is 24%**, text wrapping another 9%, and the
  garbage collector 8%. Splitting `graphemes` by who called it is what names the
  actual seam: half of it is `wrap()` reached from `#measureText`, and the other
  half is paint, which walks the clusters again _and wraps the string a second
  time_ because the measurement cached the height it came to and not the lines
  it came to. So the same text is tokenized into clusters at measure time and
  again at paint time, and `stringWidth()` over every word of that screen is
  0.027ms on its own -- the work is not the measuring, it is doing it twice.

  That seam is now closed, and the numbers above are what it cost before:
  a help screen is 8.5ms and a two-hundred-row table 4.7ms, which is a quarter
  and a fifth off, with the rendered output byte for byte what it was. A text is
  wrapped once and paint reads the lines rather than making them again, and the
  property-name lookup the cascade makes per declaration per element is memoised.
  Neither changes a decision -- what a text comes to at a width is still one
  answer, and it is now one answer literally rather than two that agree.

  What did _not_ work is worth as much as what did, because it is the obvious
  thing to try next. `initialStyle()` builds a fifty-property object by writing
  computed keys onto `{}`, which reads like the textbook way to produce a
  dictionary-mode object -- so it was replaced with one template cloned per call.
  That was **slower**, by 27%, and `Object.assign()` in place of the spread was
  slower again, by 47%. Cloning a fifty-property object costs more than building
  one, in this engine, today. It is measured here rather than reasoned about
  because the reasoning was what got it wrong.

- **The media queries are the caller's, apart from the width and the colour
  level.** Those two this call is the authority on; the other half of a query is
  "how much screen is there", which a string being built has no answer to that the
  caller does not already have. The cascade is handed back exactly as it was
  found, because a `table()` inside a running app shares its sheets with the frame
  loop and a media context left behind would be the next frame's answer to a
  question about a screen this render was never about.
- **A newline in a run is a break the author wrote, and a paragraph keeps it.**
  Built as a column of wrapping rows when there is one and as a bare row when
  there is not, since the common case is a single line and an extra flex item for
  nothing is one the layout still has to place. Runs of spaces _are_ collapsed,
  which is what CSS does with `white-space: normal` -- so anything verbatim, an
  example's command line above all, is a `text` rather than a paragraph: two
  spaces lining a flag up in an example are the author's, and a paragraph is
  words with one space between them.
- **A paragraph is a wrapping row of one-word elements, and that is how inline
  styling is done.** There is no inline layout: a `text` wears one style, and
  three texts in a row are three flex items, so a wrapped first item leaves the
  other two beside its _box_ rather than after its last line. What there is
  instead is flexbox, and a wrapping row of words is word wrapping -- the gap
  between two items on a line is the space between two words, a line breaks where
  the next word does not fit, and each word may be styled on its own. That is what
  makes help's dim `(default: ...)` sit on the same line as the description it
  follows, and it costs no new layout mode. A word wider than the line overflows
  rather than being broken, which is what `wrap()` does with one too.

### Themes

- **A theme is a stylesheet origin, and the framework's own defaults are the
  origin below it.** That settles the question SIG-77 left open. Every built-in
  draws itself with classes and carries no colour in its props, `src/theme/`
  holds the sheet that gives those classes their colours at origin `framework`,
  and an app restyling one writes an ordinary rule with an ordinary selector --
  no `!important`, no specificity contest -- because its own sheet is a later
  origin. A theme sits between the two, so it may restyle every built-in without
  touching what an app said about its own components, and an app may still beat
  the theme. One axis of the cascade doing all three jobs rather than three
  mechanisms to keep in agreement.
- **No built-in carries a colour in its props.** A prop beats a sheet per
  property, so a colour written into a template is one a theme cannot reach
  without `!important` -- which is the trap `!important` exists to get out of
  rather than a thing to walk into.
- **The framework sheet sets no layout property a component did not already ask
  for in props.** A theme that changed a prompt's padding would move the caret,
  and the component is what knows where that goes. Colours and attributes only --
  and that is a rule a _theme_ keeps or does not, because a theme is ordinary CSS
  over an ordinary cascade and nothing enforces it. Where a built-in worked its
  own geometry out, a layout property from a theme is a number the component never
  heard about: `box-sizing` starts at `border-box`, so
  `.sigil-table-cell { padding-left: 3 }` takes three columns _out of_ a width the
  table measured and a narrow column comes out empty. That is what CSS does with a
  border-box width; what the defaults can promise is only that they do not do it.
- **`FRAMEWORK_CSS` is the vocabulary, and it is one string rather than a set of
  files.** Read it as the list of names a theme may restyle. The state classes
  are spelled `is-*` because they are states rather than kinds: `:focus` is the
  cascade's own and is used where it applies, and these are the ones a terminal
  has no pseudo-class for.
- **Parsed once, and a cascade built per call.** A `Stylesheet` is frozen and a
  `Cascade` only reads it, so parsing per spinner would be the same work per
  component per process; the cascade differs per call because the sheets do, and
  it holds a bucket index over them.

### Style

- **The property table is the single source of truth.** Every property's initial
  value, whether it inherits, and how it is read all live in one object, and
  everything downstream -- the cascade, the layout engine, invalidation,
  animation -- reads it rather than carrying a list of its own. A property is
  added in one place or it is added wrong.
- **An element's style before the cascade has spoken is one shared frozen
  object.** `LayoutNode` needs a style so that a tree can be laid out before
  anything has resolved one, and building a fifty-property one per element meant
  every element paid for two -- the one its constructor made and the one the
  cascade replaced it with. Frozen for the reason the initial values are: a style
  is the cascade's to write, and an element that mutated a shared one would be
  rewriting what every unsettled element in the process looks like.
- **Every `Length` is frozen, and so is every initial value.** `readonly` is a
  TypeScript fiction at runtime, and one shared `AUTO` was the initial value of
  ten properties -- so a single in-place mutation anywhere downstream, which is
  the obvious optimization in a layout resolver, rewrote `width`, `height`, every
  `min` and `max`, `flex-basis`, and all four insets on every style in the
  process. `canvas/style.ts` freezes interned styles for exactly this reason.
- **`auto` and `none` are different answers.** `width: auto` means size to
  content; `max-width: none` means unbounded. One sentinel for both made
  `max-width: none` -- an ordinary declaration -- impossible to write.
- **A number is read against a CSS `<number>` grammar, not by `Number()`.**
  `Number('0x10')` is 16, and hex is not CSS syntax; the parser's own `int` takes
  it deliberately for CLI arguments and should not leak in here by accident of
  reaching for the same function. An integer past 2^53-1 is refused for the
  reason the parser's data types already record: it comes back as a _different_
  integer, which is the one failure a caller cannot detect.
- **A boolean property reads the same vocabulary as the parser's `bool`** --
  `yes`, `on`, `1`, and the empty string all mean there what they mean here. A
  second, narrower spelling of one idea is how two parts of one library come to
  disagree about what `on` means.
- **A shorthand resets every longhand it covers, including the ones a given use
  did not mention.** That is CSS, and it is why `border: red` famously draws
  nothing there. `border` and `flex-flow` were leaving the omitted half alone, so
  `border: single` after a `border-color: red` kept the red.
- **Initial values follow CSS except where a terminal changes the answer, and
  each exception is written down.** `box-sizing` starts at `border-box`, because
  `width: 20` meaning twenty columns on screen is what everybody means and a
  border silently making it twenty-two is the surprise. `display` starts at
  `flex`. `z-index` starts at `0` rather than `auto`, since the paint order is
  flat enough that "does not establish a stacking context" has nothing to bite
  on. `position` starts at `static` and that is _not_ an exception: the insets
  are read only on a `relative` box, so defaulting to `relative` would make every
  stray `top` in a stylesheet move something.
- **`background-color` and `text-overflow` do not inherit**, as in CSS. A
  container's background showing through its children is paint order, not the
  cascade; pushing the value down would make every descendant _own_ that colour.
  The text decorations do inherit here, which CSS reaches by propagating lines
  across descendants rather than by inheritance -- a cell grid has no box
  structure to do that with, so this is the deliberate simplification.
- **A property name resolves in both spellings, and in any case for the kebab
  one.** `background-color` in a stylesheet and `backgroundColor` in a props
  object are both written; aliases and shorthands resolve both ways too, which
  they did not at first. Lowercasing is what a case-insensitive kebab lookup
  needs and exactly what destroys the camelCase one, so the two are tried
  separately rather than funnelled through one normalization that cannot serve
  both. `BackgroundColor` is not recognised and is not meant to be -- the
  camelCase spelling is a JavaScript identifier, and identifiers have a case.
- **One unit, and it is a cell.** A bare number is cells; `ch` is accepted as a
  synonym because people type it. A fractional length is _refused_ rather than
  rounded: rounding silently is how a layout ends up a column out with nobody
  able to say which declaration did it.
- **A named colour stays a palette index.** The basic sixteen are whatever the
  user's terminal theme says they are, so resolving `red` to a specific RGB
  overrides a choice they already made.
- **`text-overflow` is read off the text's own box and bites only where a line
  does not fit.** It parsed and did nothing for as long as there was nothing that
  had to fit text into a column, which is the rule about a property the engine
  ignores said one layer along -- and the table's `truncateCell()` was what it
  was supposed to be. It applies to a line wider than the box it was given,
  which for wrapped text never happens, so in practice it is what
  `white-space: nowrap` costs: exactly as in CSS. Read off the text element
  rather than inherited, so a container setting it does not silently cut every
  descendant. The cut itself is `truncate()` in `@ttylabs/sigil/wrap`, which is
  one implementation with four modes rather than a helper per caller.
- **The attribute properties are derived from the table, like the colour ones.**
  `flag()` is used for the terminal's seven attributes and for nothing else, so
  what it was asked to build is the answer -- and a hand-written list is a second
  list to keep in agreement, which is the entry `COLOR_PROPERTIES` already
  carries.
- **Every numeric parser refuses an empty value.** `Number('')` and `Number(' ')`
  are both `0`, so an empty declaration reads back as a real-looking zero -- the
  same trap the parser's `number` and `int` data types already carry an entry
  for. `50%` minus its sign is exactly the string that reaches this.
- **`font-weight`, `font-style`, and `text-decoration` map onto the attributes a
  terminal has.** They are the spellings people reach for, and refusing them to
  insist on `bold: true` would be pedantry. A _numeric_ weight is still an error,
  because there is no axis between bold and normal to put `600` on.
- **A border given only a colour is still a border.** CSS draws nothing for a
  `border-color` with no `border-style`, which surprises everyone; this defaults
  the style to `single`. It is the one deliberate divergence in the shorthands.
- **A shorthand reports against the longhand that could not take the value.**
  Shorthands expand to source text and the longhand parsers do the reading, so
  `padding: 1 nonsense` fails at `padding-right` rather than at `padding` -- the
  shorthand could not have said which part was wrong. That means each longhand
  has to carry its _own_ name; the padding parsers all said "padding", which is
  the message the shorthand would have given anyway.
- **Every lookup table here is null-prototype, and every lookup uses
  `Object.hasOwn`.** The same entry Conventions already carries for the parser's
  registries, rediscovered: on a plain object `constructor` and `toString` read
  back truthy, so `isKnownProperty('constructor')` was true and
  `declare({ constructor: 'red' })` was a `TypeError` from somewhere inside
  rather than an error anybody could act on.
- **A CSS property that maps onto two longhands resets both.** `font-weight:
normal` did and `font-weight: bold` did not, so a `bold` left an earlier `dim`
  standing. Same rule as `border` and `flex-flow`, and the same bug in a third
  place.
- **`none` parses only where "no limit" is a thing to say.** Accepting it on all
  fourteen length properties made `width: none` and `margin: none` parse and then
  behave as `auto` or as zero -- not CSS, and not what the author meant.
- **A keyword list is frozen too, not just the slot holding it.** `Object.freeze`
  on a definition freezes the reference, and `parseKeyword` closes over the same
  array -- so a push onto `PROPERTIES.display.keywords` made `display: grid`
  parse. Same hole as the one below, one level further in.
- **The property table is frozen, definitions included.** The initial values were
  frozen and the slots holding them were not, which is the same TypeScript
  fiction one level up: `PROPERTIES.width.initial = cells(7)` changed what
  `declare()` returned for every style in the process.
- **Margins take a length and paddings take a count.** `auto` is how a box is
  centred and how it is pushed to one end, and a negative margin is a real
  thing; neither is true of padding.
- **`position` takes all four keywords, and the insets are a length.** `absolute`
  was a parse error for as long as there was no out-of-flow engine, on the rule
  that a keyword which parses and does nothing is worse than one that does not
  exist -- and the same rule admits it, and `fixed`, now that there is one. What
  the table offers is what the engine honours, which is also what the utility
  generator builds a rule per entry from, so `absolute` returning to `keywords`
  is what puts `absolute` in the utility set. The insets are a length rather than
  a count because pushing a box back the way it came is the ordinary use and a
  negative value is how CSS says it.

### Stylesheets and the cascade

- **The sheet supplies defaults and props win, per property.** A sheet setting
  `color` and a prop setting `padding` both apply, and the prop only beats the
  sheet on properties it actually names -- which is where `style=""` sits in a
  browser, so it is the familiar rule rather than a new one. The useful
  consequence is a fast path: a prop write cannot change any _other_ element's
  resolved style, so it skips the cascade entirely. `resolveSheets()` hands back
  a `CascadeResult` that a caller keeps, and `applyProps()` re-applies props over
  it with no selector matched and nothing else touched.
- **No attribute selectors.** They were in the original sketch and are
  deliberately out: if a rule can match on a prop, then writing a prop can
  restyle some other element and the fast path above disappears. State a
  component would have expressed as `[disabled]` goes through a class or a state
  pseudo-class instead. Cheap trade for a clean invalidation boundary, and the
  error message says so rather than reading as an unimplemented feature.
- **The selector engine takes a `StyleNode`, not an element**, for the reason
  the layout engine takes a `LayoutNode`: this is the layer testable with no
  terminal, no renderer, and no reactivity, and it keeps that only by not
  knowing what an element is. There is no bag of attributes on it, which is the
  same decision as the one above seen from the other side.
- **The cascade sorts by layer, then origin, then specificity, then source
  order.** The standard algorithm with the one axis a terminal UI needs added;
  inventing a different one buys nothing and costs everyone's intuition. The
  layer axis is what the utility layer (SIG-80) proves is necessary:
  `.button { padding: 4 }` and `.p-2 { padding: 2 }` are both `(0,1,0)`, so
  without layers the winner is whichever sheet happened to be concatenated last.
  It is here now rather than later because retrofitting an ordering axis into a
  shipped cascade changes the meaning of every stylesheet written against it.
- **The three layers are fixed and an author cannot declare more.** `base`, then
  `components`, then `utilities`. Fixed is smaller and nobody has a case for a
  fourth; `@layer mine` and the bare `@layer a, b;` ordering statement are both
  refused rather than quietly accepted, since the second would be a lie.
- **A rule outside an `@layer` block is in `components`.** That is where a
  hand-written app or component sheet belongs -- it is precisely what the
  utilities layer has to be able to beat -- and it is why the default is not the
  CSS answer, where unlayered rules outrank every layer.
- **`!important` inverts origin and layer, and nothing else.** Specificity and
  source order are never inverted, which is CSS. The inversion is the whole
  reason `!important` is retained: a component copied in by `sigil add` that
  bakes `color="red"` into its template would otherwise be unthemeable with no
  recourse. The convention that goes with it is that component templates set
  classes, not style props.
- **Props are the band between normal and important, and they never carry a
  precedence.** Applying them last and skipping the properties an important
  declaration won says exactly the same thing as giving them a band of their
  own, and it is the fast path rather than a second pass over the rules.
  `CascadeResult.locked` is how that survives being cached.
- **The cascade hands back a plain resolved style per element; interning is the
  canvas's business.** That settles the question the ticket left open. A
  resolved `Style` is fifty-odd properties that mostly differ per element, while
  a canvas cell style is a foreground, a background, and some attributes
  repeated across thousands of cells -- interning pays there and not here, and
  the renderer maps one to the other at paint time.
- **A rule's selector list reports the highest specificity that matched.** A
  rule written `#go, box { ... }` behaves as though it were written once per
  selector, which is CSS; matching it once per bucket and keeping the best is
  how one rule with several selectors avoids being counted twice.
- **Matching is right-to-left and rules are bucketed by their rightmost simple
  selector** -- an id, else the last class, else the type, else the universal
  bucket -- so an element only tests rules that could possibly match it. Worth
  keeping in proportion: browsers optimize this hard because they have ten
  thousand elements and ten thousand rules, and a terminal UI has a couple of
  hundred of each. Naive may simply be the permanent answer; see SIG-65.
- **An element with no parent is a first child.** It has no siblings, so it is
  the first of them, which is what browsers answer for the root element.
- **`:hover` parses and matches nothing.** Mouse tracking does not exist yet and
  the selector engine must not assume it never will; a selector that reads
  correctly and matches nothing is an answer, and one that throws is a missing
  feature somebody works around with a class they then cannot remove.
- **Types, classes, and ids match case-sensitively; keywords do not.** They are
  JavaScript-land names rather than CSS keywords, so `Box` and `box` are
  different elements, while `:FOCUS` and `inherit` are read in any case the way
  every property name already is.
- **`inherit`, `initial`, and `unset` are cascade-level and a value parser never
  sees one.** `inherit` is not a colour, and it is not fourteen other things
  either, so they are recognised once rather than added to every grammar --
  which is also why `readDeclarations()` refuses them: "what does this
  declaration set" has no answer for `inherit` without a parent, and only
  `declare()` and the cascade have one. `currentcolor` is deliberately not among
  them: it needs a resolution order of its own -- a value depending on another
  property of the same element, resolved after the winners are picked -- and
  nothing needs it yet.
- **A shorthand carries the longhands it covers, next to its expander.** The
  cascade asks for the set before there is a value to expand, since
  `padding: inherit` has to reach all four edges, and a list kept in a second
  table is a list that drifts. The three multi-longhand aliases -- `font-weight`,
  `font-style`, `text-decoration` -- carry theirs the same way.
- **One scale for colour in a media query, and it is `ColorLevel`'s 0-3.** CSS's
  `color` feature counts bits per component; a second, narrower spelling of a
  scale the library already has is how two parts of one library come to disagree
  about what `2` means. Media types and `not`/`only` are out: there is one
  medium, and the other two exist to hide queries from parsers that predate them.
- **An unknown property in a stylesheet is an error, not a skipped
  declaration.** CSS skips because the web has to survive a sheet written for a
  browser that does not exist yet; a CLI ships its sheet with its runtime, so a
  typo is a bug and reporting it where it was written is worth more than
  forward-compatibility nobody needs.
- **A stylesheet error says which line, and the line is counted only when one is
  thrown.** The parser carries indices rather than lines, because counting
  newlines per rule makes parsing a sheet with nothing wrong with it quadratic
  in its own length.
- **Comments are removed by the cursor, not by each reader.** A comment may sit
  anywhere, mid-selector included, and every reader downstream would otherwise
  have to know that -- and a semicolon inside one is not a declaration boundary.
- **A backslash escapes the next character in an identifier, and the name that
  comes back is unescaped.** `.md\:flex-row` is how a class _called_
  `md:flex-row` is written, because the colon means something else to this
  grammar -- which is what Tailwind does and why its class names are legal CSS.
  What the name is compared against is the class an element carries, so it is
  the unescaped form that is stored. CSS's hex escapes (`\3a `) are deliberately
  not read: nothing generates them and they carry a trailing-space rule that is
  its own source of surprises.

### Colour degradation

- **Degradation happens at resolve time, not at paint time.** The cascade
  produces a resolved style and degradation is the last pass over it, so the
  canvas only ever holds colours the terminal can actually emit and the diff
  never compares a colour against its own approximation. The depth it degrades
  to is `media.colorLevel` -- the same number `@media (color-level: N)` reads, so
  an author's override and the automatic ladder cannot disagree about what depth
  they are on.
- **Level 2 never _lands_ on `0`-`15`, and level 2 never _rewrites_ them
  either.** Those sixteen are whatever the user's theme says they are, so
  quantizing an ordinary colour onto one makes the answer depend on a setting
  nothing here can read -- the cube and the grey ramp are fixed by the spec and
  are the only targets. A colour _declared_ as one of the sixteen is the other
  half of the same rule and passes through untouched, because AGENTS.md already
  records that a named colour stays a palette index. Getting this backwards
  turned a declared `blue` into the cube's `#0000ff` and overrode a choice the
  user had already made.
- **Matching is in Oklab, not in RGB.** The sixteen are perceptually scattered
  rather than evenly spaced, so RGB distance picks visibly wrong answers --
  `#ff8800` is numerically nearer xterm's green than its red, and perceptually
  nowhere near it. Oklab over CIELAB because it is simpler and better behaved
  around blues; either beats RGB, which is the thing actually worth avoiding.
- **Nothing is invented at level 0.** Colour is dropped and no attribute is
  synthesised to carry what it meant: turning red into bold makes red and blue
  both bold, which preserves the emphasis while destroying the distinction it is
  pretending to keep. The rule that follows is a rule for components rather than
  for the degrader -- do not encode meaning in colour alone -- and it is an
  accessibility argument as much as a compatibility one.
- **Level 0 is plain text, attributes included.** Not only the colours: the seven
  attributes go too, which is what the styler has always meant by it -- at level
  0 `ansi.bold()` hands back the string it was given, so this is parity with the
  library's own behaviour rather than a new rule. The two ways a process arrives
  at level 0 are a pipe and `NO_COLOR`, and neither wants `ESC[1m` in the file it
  is writing. It is also what makes a prompt asked for plain text plain: the
  caret is `inverse`, and a caret drawn at level 0 would be the one sequence
  nothing could switch off. Done in `degradeInto()` rather than at emission, so
  the canvas and the string renderer cannot come to disagree about it -- the same
  reason degradation happens at resolve time at all.
- **A background degrades exactly like a foreground.** The argument for treating
  it differently is that a wrong background is more visible, and that argues for
  a _better_ match rather than a _different_ one; Oklab is already the better
  match, and a second metric would be two tables and two sets of surprises.
- **`NO_COLOR` comes through this path rather than short-circuiting.**
  `supportsColor()` already reads it and answers `0`, the renderer puts that on
  `media.colorLevel`, and level 0 drops colour. One mechanism is easier to
  reason about than two, and it means `@media (color-level: 0)` is a thing an
  author can write.
- **A `CascadeResult` carries the depth it was resolved at.** A prop can name a
  colour, so the fast path has to degrade too -- and a `level` argument on
  `applyProps()` defaulting to truecolor is a fast path that silently disagrees
  with `resolve()` on exactly the terminals degradation exists for. The depth
  travels with the result that was resolved at it.
- **The colour properties are read off the property table, not listed again.**
  A hand-written list is a second list to keep in agreement, and a fourth colour
  property that it missed would parse and cascade and then quietly skip
  degradation -- a wrong colour on screen with nothing to point at. Same rule
  `INHERITED` already follows.
- **The Oklab `b` row is the value that sums to zero, not the published
  transcription.** For D65 white the LMS rows each sum to one, so `l`, `m` and
  `s` are all 1 and the `a` and `b` rows have to sum to exactly zero or a grey
  acquires chroma. The `a` row does; the published `b` row leaves a residue of
  3.7e-8, a bias in one direction on every neutral colour there is. The test
  pins the property rather than the digits.
- **The memo is never evicted, because what reaches it is a declared colour.** An
  app has a few dozen of those, not the 16.7 million a cap would be protecting
  against -- a gradient painted cell by cell goes to the canvas directly and
  never passes through the cascade at all.
- **The basic sixteen are matched against the xterm defaults.** Terminal themes
  make them unknowable, and being wrong for somebody running Solarized is a
  smaller failure than refusing to degrade.

### The utility layer

Lives in `packages/cli/src/utilities/`, because it is a generator and a
stylesheet rather than anything the runtime knows about.

- **A utility is a generated stylesheet rule, and nothing in the runtime knows
  the difference.** `p-2` is `.p-2 { padding: 2 }` -- the same class selector,
  the same specificity, the same cascade. No new resolution path, no new
  precedence rule, nothing added to the matching engine. It is a rule rather
  than an implementation detail because the obvious optimization breaks it: the
  moment somebody special-cases `class="p-2"` into a direct property write it
  becomes a parallel mechanism with its own precedence, its own bugs, and a
  divergence from the cascade that only shows up where nobody tested.
- **The keyword lists live on the property table, not in the generator.** They
  used to be reachable only inside each parser's closure, so the table could say
  whether a string was accepted but not what a property accepts -- and a
  generator had to carry a second copy of all sixteen lists and go quietly out
  of date. `fromKeywords()` puts one list where both the parser and the
  generator read it, so a keyword added to a property gets its utility free.
  What that list holds is what the engine accepts rather than what CSS has, and
  `position` is where the two part: `absolute` is a parse error, so it is out of
  the list as well, and the two utilities generated are the two that do
  something. Leaving it in would have generated a rule that the generator's own
  parse-on-the-way-out then refuses -- the build failing closed, which is that
  check working, and still not a table worth shipping.
- **What the table cannot supply is the naming, and that is the honest split.**
  The table knows `justify-content` takes `space-between`; that the utility is
  spelled `justify-between` is ours to decide, and every invented name is one
  somebody has to learn. Tailwind's spelling wherever it exists, ours only where
  a terminal has no web analogue -- `border` meaning one cell of single-line
  border, because a terminal border has exactly one width and `border-2` has
  nothing to mean here.
- **Every generated declaration is parsed on the way out.** A utility that names
  a property the table does not have, or a value the property would refuse,
  fails the build rather than shipping a rule that silently matches nothing.
  This caught `bright-black` on the first run: a fine class name and not a
  colour `parseColor()` takes, which is the hyphenated-class/unhyphenated-value
  split this file is built on.
- **Two utilities of one name is an error.** A class that quietly applies both
  is the failure a generated vocabulary is most prone to, and it happened
  immediately: `hidden` was `display: none` and `visibility: hidden` at the same
  time. Visibility's is `invisible` now, which is Tailwind's spelling anyway.
- **The whole base set ships; there is no scanner.** Tailwind's central problem
  is that the utility space is combinatorially enormous, so it cannot ship them
  all. Here the scale is bounded by the medium -- spacing is a handful of cells
  because there is nothing between one cell and two, there are sixteen colours,
  and the property set is fifty-odd entries -- so the base set is a few hundred
  rules and shipping it whole is much simpler than deciding what to leave out.
- **Arbitrary values are deliberately out.** `p-[13]` and `text-[#ff8800]` are
  what make the space unbounded again, and they are the reason a scanner has to
  exist at all. They are SIG-81's, along with the question of what a computed
  `class` expression does, which should be answered once rather than twice.
- **Two variants are better here than on the web, and two are missing.**
  `md:flex-row` is the responsive problem a TUI actually has and nothing solves
  well today; `c16:text-red` is SIG-61's "give the author control" in a shape
  people already know. Not `hover:` until mouse tracking exists, and not `dark:`
  -- a terminal has no such mode.
- **`@apply` is one statement, and an `@apply` in a comment is not one.** The
  name list stops at `;`, `{` or `}`: a regex of `[^;}]+` also matched a brace,
  so `@apply foo { bar: 1; }` swallowed the block after it and a missing
  semicolon ran the list on into the next declaration. Whatever followed the
  last name is put back, since a source transform that eats the space before a
  `}` is one whose output nobody can diff.
- **A comment inside an `@apply` is trivia, not a boundary.** The first fix
  split the source on comments and expanded each side, which made
  `@apply p-1 /* and */ mt-2;` expand half of itself and leave the rest behind
  as a declaration the parser then choked on. Comments are trivia everywhere
  else in a stylesheet -- `#trivia()` and `#until()` in the parser already treat
  them that way -- and this reads them the same. An `@apply` that lives wholly
  inside a comment is still just a note about `@apply`, and an unterminated
  comment is an error rather than a hole to walk through.
- **`@apply` expands at build time into the component layer.** That is where the
  cascade's layer ordering puts a component rule, so an app can still override
  it with a utility -- which is the whole reason `@apply` works in Tailwind.
  Expanding at build time is also what keeps the runtime ignorant: what it sees
  is a component rule with ordinary declarations in it. A _variant_ cannot be
  applied and says so, because it is a rule in another context rather than a set
  of declarations.

### Style invalidation

- **Props do not participate in invalidation.** Props override the sheet per
  property and there are no attribute selectors, so writing a prop cannot change
  any _other_ element's resolved style -- there is no rule that could have
  matched differently. A prop write therefore skips style resolution entirely,
  re-applies props over the kept `CascadeResult`, and marks paint. That is the
  common case for a component updating itself and it costs nothing. It only
  holds because attribute selectors are out, which is why those two decisions
  are one decision.
- **Three dirty bits, each implying the ones after it.** `style`, `layout`,
  `paint`. A style change can move a box so it implies layout; a layout change
  moves what is on screen so it implies paint. `DIRTY_ORDER` is the order a
  frame settles them in and the order they imply each other in.
- **Naive, and measured rather than asserted.** A full re-match of 201 elements
  against 100 rules is 0.67ms median, 1.05ms at p95 -- once per frame at most.
  Browsers build invalidation sets because they have two orders of magnitude
  more of both. Start naive, expect naive to win permanently, and measure before
  believing otherwise. What must not happen is an architecture where the
  optimization could not be added: the seam is the set of elements `update()`
  re-resolves, and narrowing that set is the whole of what an invalidation set
  would do.
- **A class change restyles the subtree and the siblings, not the tree.** A
  combinator reaches downwards and sideways from an element, never up, so those
  are the only elements whose match can depend on it. Sideways is the half that
  is easy to forget and visible immediately when wrong: `:nth-child()` and
  `+`/`~` mean inserting a child changes what its siblings match, and none of
  those siblings changed in any way an element-level check would see.
- **The walk is in document order, because a child's inherited values come from
  its parent's _resolved_ style.** The parent has to have been resolved first,
  which is also why the prop path is a branch inside the walk rather than a pass
  after it. _When_ a parent forces its children is the entry below, and it is
  not "whenever it was restyled" -- that wording is what both of the misses
  below were compatible with.
- **Styles are compared by value, not by identity.** A `Length` is an object and
  two resolutions of `width: 4` produce two equal objects, so comparing by
  identity reports every property as changed on every restyle and makes the
  dirty bits mean nothing. Shallow is enough -- the only non-primitive a style
  holds is a `Length`, and `JSON.stringify` on this path is not.
- **`LAYOUT_PROPERTIES` sits next to the property table.** It is the one thing
  about the property set that cannot be derived from the definitions: the table
  knows what `white-space` accepts and cannot know that changing it re-wraps
  text. Three that surprise people -- `borderStyle` is layout because a border
  takes a cell on each edge while its _colour_ does not, and `textTransform` and
  `whiteSpace` are layout because both change how wide a text measures. One that
  surprises the other way: `visibility` is paint-only, because hidden content
  still takes its space, which is the layout engine's own recorded decision.
- **The resolved style does not live in a `Computed`, and that is settled rather
  than deferred.** It would make invalidation fall out of the signal graph for
  free, and it costs a graph node per element per property -- thousands for a
  tree of hundreds -- against a full re-match already measured at well under a
  millisecond. It also lands on the signals layer's own known limitation: edges
  are strong and bidirectional, so every element ever removed stays reachable
  until its sources die. Elegance that buys nothing measurable and costs a
  lifecycle problem.
- **An animation writes through to paint rather than marking style dirty.**
  Not built yet, decided now: marking style dirty every frame drags the whole
  cascade behind a 60fps animation, which is the one workload where the naive
  re-match above stops being free.
- **The signal wiring is the renderer's, and it is now written.** `Restyler`
  still takes marks from whatever calls it -- that seam did not move -- and
  `render()` is what calls it, draining `Tree.take()` into `touchClasses()`,
  `touchProps()` and `touchChildren()` once per frame. Before it existed, an app
  that kept a `Restyler` across frames got one that re-resolved _nothing_ after
  the first, silently: the state really did change, the selector really would
  match, and the frame was never asked. `demos/element/03-focus.js` is what found
  it -- Tab moved the focus ring and the `:focus` highlight stayed where it
  started -- and it still writes the bridge out by hand, because it predates the
  renderer and demonstrates the layer below it.

### Canvas

- **A canvas is a rect plus an anchor, and it does not know its anchor.** The
  original ticket asked whether it owns the alternate screen or draws inline;
  that is the wrong question. Every coordinate is relative to the canvas's own
  top-left and every movement the diff emits is relative to where the cursor
  started, so the same grid works parked at the bottom of a scrolling log or at
  the origin of the alternate screen. Absolute positioning would have forced the
  inline case to know a screen row it has no way to learn.
- **A wide cluster leaves a continuation, and overwriting either half takes the
  other with it.** Without the marker there is no answer to "what is in column
  40" for a row containing one wide character, and every clip, overwrite, and
  diff is off by one from there rightwards. Left alone, a survivor is half a
  glyph. A zero-width cluster is refused a cell rather than given one, because
  `graphemes()` has already attached it to what it modifies.
- **A run never starts on a continuation cell.** Writing at that column would put
  the cursor in the middle of a glyph, so a run that would begin there starts at
  the lead instead -- even when the lead itself did not change.
- **The diff starts every frame from the default style, not from the previous
  frame's cell.** A frame ends by resetting, so the terminal's SGR state at the
  start of the next one is default. Diffing against what the old cell looked like
  would emit closing codes for attributes that are not open.
- **An unchanged gap shorter than a cursor move is painted through.** A move
  costs about four bytes, so skipping a two-cell gap is more expensive than
  writing it -- and it avoids a move, which some terminals handle worse than a
  write.
- **Cells hold a style index, not a style.** A grid repeats a handful of styles
  across thousands of cells and the diff's inner loop asks "same style?" once per
  cell. Interning makes that an integer comparison and lets the grid keep its
  styles in a typed array. The table copies what it interns, so a caller reusing
  one object to paint many cells cannot retroactively change what a cell was
  painted with.
- **Extended colours are emitted in the semicolon form**, matching the styler.
  `38:2::255:128:0` is what ITU T.416 specifies and the semicolon form is the
  widespread misreading of it, but the misreading is what got implemented: the
  colon form is a strict subset of terminals and the six-element spelling
  narrower still. The ambiguity the colon form avoids is a problem for _parsers
  inside this library_ -- which is why `reopen()` and `createSgrState()` each had
  to learn about it -- and nothing here passes through either, since the terminal
  is the only reader of the diff's output.
- **A style is interned under a string key.** Packing two colours and the
  attributes into one number is 58 bits: it runs past `Number.MAX_SAFE_INTEGER`
  and rounds the attributes away, so bold truecolor text interned as plain
  truecolor text and rendered unstyled, and unrelated colour pairs collided. The
  string is built once per _distinct_ style rather than once per cell.
- **A partial style is filled and a nonsense one is refused.** A style arrives as
  `Partial<Style>`, so a missing field is `undefined`, and `undefined` reaches
  the terminal as `38;5;undefined` -- output it drops and nobody can trace back.
  `palette()` and `rgb()` refuse out-of-range channels for the same reason rather
  than clamping them, which is the line `assertByte()` takes in the styler.
  Interned styles are frozen, `DEFAULT_STYLE` included -- it is index zero, which
  is what every cell starts with, so handing back the mutable object meant one
  write could make the diff start every frame from a "default" that was not one.
- **A cluster occupies one cell or two, never more.** `graphemeWidth()` sums what
  a cluster contains and can exceed two -- a CJK character with a spacing mark,
  two leading Hangul jamo -- and a grid has no third cell to put that in. Left
  alone, the cluster went into one cell, the cursor advanced by three, and the
  cells between were never drawn while still holding content nothing would paint
  over. `cellWidth()` is the only width the grid asks about.
- **A control character is refused, not dropped.** `\n` is zero width, so it took
  no cell and `put()` returned `0` -- and `write()` only stopped on a
  _positive_-width cluster that failed to land, so a wrapped paragraph painted as
  one concatenated line with no complaint. A grid paints one row per call by
  construction, so the caller has to say which row. Tab is refused too: its width
  depends on a tab stop the grid does not model.
- **`Painter.text()` strips escape sequences rather than painting them.** A cell
  grid expresses styling as a style per cell, so a string carrying its own has
  nowhere to put them -- and painting cluster by cluster puts `[31m` on screen as
  text, because the ESC is zero width and the rest is not. Every existing
  component builds strings like that.
- **A backend must give the canvas its rows before presenting.** Movement is
  relative and downward movement is CUD, which stops at the bottom margin and
  never scrolls -- so a canvas rendered with the cursor on the last row of the
  screen paints every row onto that line. The inline backend's first frame is
  exactly that case; its recipe is `height - 1` newlines then walk back up.
  `DiffResult.column` is never past the last column and `wrapPending` says
  whether the deferred wrap is armed.
- **`fill()` steps by what its cluster consumes and leaves the rectangle short
  rather than overrunning it.** Advancing one column regardless made each
  iteration break the continuation the last one left, so only the final column
  kept its glyph -- and the last `put()` wrote its continuation one column _past_
  the rectangle, over whatever else was painted there. Three columns cannot hold
  two wide clusters, and half of one is worse than a gap.
- **`write()` clips at the left edge and gives up at the right.** `put()` answers
  `0` for any off-grid column, and reading that as "nothing further will land" is
  true walking off the right edge and false at a negative one, where advancing
  walks _into_ the grid -- so `write(-2, 0, 'hello')` on a five-wide grid painted
  nothing at all while `fill()` clipped the same rectangle correctly, and two
  sibling APIs disagreed about what off-grid means. A wide cluster straddling
  column zero is still refused, because a survivor is half a glyph, but only that
  cluster and not the rest of the string. What comes back is the **advance from
  `x`**, not a count of the cells painted: `x + returned` is where a next run goes
  whichever edge clipped this one, it is the same number for a run that fits, and
  a caller that needs to know what landed has `inside()`.
- **The cell class is `CellBuffer`, not `Buffer`.** The shorter name is Node's
  global, and a file that forgets the import gets a byte buffer and a
  deprecation warning rather than a type error.
- **`paint()` clears and redraws the whole frame; there are no damage rects.**
  That settles the question the ticket left open. The diff already reduces a
  whole-frame repaint to the cells that changed, so damage tracking would buy
  back only the painting, and it needs paint and diff to agree about who owns
  invalidation. Revisit when a profile says the painting is the cost.
- **A resize discards both buffers.** The layout is about to run again at the new
  size and repaint everything, and a grid that described a terminal that no
  longer exists is not something to diff against -- keeping it only gives the
  diff something wrong to compare with.
- **`present()` copies the frame forward rather than swapping buffers.**
  Swapping saves an allocation and leaves `back` holding the frame before last,
  which is what the canvas reports as its current contents. A `toString()` that
  lies is a debugging trap worth more than the allocation.
- **The diff is tested by replaying its output against a model terminal, not by
  asserting on its bytes.** Asserting on bytes pins one implementation; replaying
  pins the claim, which is "these bytes turn what is on screen into what should
  be". The model refuses a write past the right edge, and checks after every
  frame that no wide cluster lost its continuation and no continuation lost its
  lead -- _after_, not during, because replacing `漢` with `ab` legitimately
  splits it and the second write is what puts the row back together. What is
  never legitimate is a frame ending with half a glyph on screen. See
  `test/canvas/diff.test.ts`.
- **The model cannot check itself, so `scripts/terminal-probe.mjs` exists.** The
  model and the diff share an author and a mental model, so an assumption wrong
  in both passes green forever -- and the canvas makes several claims only a
  terminal can falsify: that CUD stops at the bottom margin rather than
  scrolling, that a wide cluster at the last column is refused rather than
  wrapped, that the deferred wrap is deferred, that the semicolon form of an
  extended colour is the one terminals take. The probe paints those frames to a
  real terminal and says what you should see; it is run by hand, against every
  terminal worth supporting, and it is the only thing here that puts a byte on
  one.
- **A hyperlink is a style, not a region.** OSC 8 is terminal state that applies
  to everything written after it until it is changed, which is what `Style`
  already models -- so `link` lives there and is interned, compared and diffed
  by the machinery that already does all three. A cell still holds one integer.
  The alternative considered was a third parallel array beside `#chars` and
  `#styles`, marking which attachment each cell belongs to; that earns its keep
  only if something needs a _rectangle_, and nothing does now that passthrough
  images are out. The interning key puts the link last, because everything
  before it is a number of known shape and a comma inside a URL would otherwise
  let one style forge another. A link carrying a control character is refused:
  an OSC sequence runs until its terminator, so one hidden inside the URI ends
  it early and the rest reaches the terminal as commands, and building a URL out
  of user input is the ordinary case rather than the exotic one.
- **`RESET` does not close a hyperlink, and the frame end has to.** SGR and OSC
  are separate state: `\x1b[0m` puts the colours back and leaves the link open
  over whatever is written next, which at the end of a frame is the
  application's own output. `LINK_OFF` is emitted before `RESET` when a link is
  in effect. This is also why `FakeTerminal` had to learn OSC -- it parsed only
  `ESC [`, so an unrecognised link sequence fell through to the text path and
  painted the URL into the grid.
- **Sub-cell drawing picks a character, it does not change the grid.** A braille
  pattern and a half block are ordinary single-width clusters, which is the
  whole reason this is the tier that works everywhere. `Dots` is 2x4 per cell
  and monochrome -- a braille cell is one character, so it carries one
  foreground -- and is for shape: plots, sparklines, anything where the line
  matters more than the colour. `Pixels` is 1x2 with a colour per half, painted
  as an upper block whose foreground is the top pixel and whose background is
  the bottom, and is for pictures. Both skip a cell nothing was drawn in rather
  than painting it blank, which is what lets either sit on a background someone
  else drew; the braille blank is a real character that some fonts draw the dot
  frame for. A solid `Pixels` cell goes out as `█` in one colour rather than as
  a half block over itself, because several terminals render the half blocks a
  pixel short at small font sizes. Out-of-range points are ignored rather than
  refused: a plot clips at its box, and requiring every caller to bounds-check
  each point is how the check ends up in the wrong place.
- **A point the loop cannot step towards is out of range, and it is refused
  before anything loops.** `Dots.line()` is Bresenham, which ends by arriving at
  the end point: `NaN === NaN` is false, a step towards an infinity never
  arrives, and past 2^53 adding one is a no-op -- so `line(1e308, 0, 0, 0)` steps
  forever without moving, exactly the way one missing sample from a plot did,
  painting nothing while it did since `set()` ignores what it cannot place. The
  endpoints are truncated already, so what the guard asks is whether a step of
  one still means something, which is `Number.isSafeInteger` and not
  `Number.isFinite`. A point it can walk to is a different thing and still
  clips, which is the rule above -- including a long line that is merely slow to
  walk, since bounding that is a decision about clipping rather than about a
  loop that cannot end.
- **Every sub-cell entry point answers for a coordinate that is not a number,
  because none of them can.** Each comparison in a bounds check is false for
  `NaN`, so it passed straight through: `Dots.#locate()` reached `DOT_BITS[NaN]`
  and the row lookup threw a `TypeError`, `Dots.charAt()` reached `#cells[NaN]`
  and `String.fromCodePoint(NaN)` threw a `RangeError`, and `Pixels.#index()`
  wrote to index `NaN`, which a typed array drops, then handed `undefined` back
  with `Color` written on it. Three spellings of one hole in three methods whose
  shared contract is to ignore what they cannot place. `charAt()` truncates as
  well, because it builds its own cell index and a fraction reached the same
  `undefined`.
- **The style table is swept on growth, not on every frame.** Interning was the
  only way in and there was no way out, so the table grew for the life of the
  canvas: `paint()` clears the back buffer and interns again, and `Pixels.blit()`
  interns a style per cell, which is a new entry per distinct pixel colour per
  frame -- order of a million `Style` objects a minute at 80x24 and 60fps. Once
  `present()` has copied back over front, the live set is exactly what `front`
  names, and `StyleTable.compact()` keeps those and says where each one moved.
  Sweeping every frame is the obvious version and is wrong in the case that
  matters most: reading the live set walks every cell, which measures 0.013ms
  against an ordinary TUI frame's 0.10ms -- an eighth of the frame, forever, to
  reclaim nothing, since such a table settles at a couple of dozen entries and
  never moves. So the trigger is growth past twice what survived the last sweep,
  with a floor, which bounds the table at twice a frame's own usage and costs an
  integer comparison to the canvas that never needs it. A resize sweeps
  unconditionally and that is the cheap case: both grids come back blank, so
  nothing names a style and there is nothing to walk or remap. Indices move, so
  the sweep rewrites _both_ grids -- `back` is what the next `present()` is
  compared against whether or not anything repainted it -- and nothing outside
  the canvas may call `compact()`, because only the owner of both the table and
  every grid painted with it knows when that is safe.
- **`FakeTerminal` defers the wrap, because `DiffResult` says the diff does.**
  Writing the last column of a row does not advance the cursor -- there is
  nowhere to go, so the terminal stays put and arms a wrap that the next graphic
  character takes, and any cursor movement disarms it. The model walked the
  cursor off the edge instead, which agreed with neither a real terminal nor the
  diff, so asserting `wrapPending` or the clamped `column` would have failed the
  _harness_ and both fields went untested. Now every `replay()` checks all three
  against the model rather than the one test that thought to ask, since a backend
  positions itself by them and cannot see that they are wrong. Modelling it
  found no disagreement with the diff over the wrap itself: the diff already
  assumes the deferred reading, which is why a full row followed by the row below
  it emits CUD before the `\r` and lands where it meant to. It did find one next
  door -- **the model measures with `cellWidth()`, because that is the only width
  the grid and the diff ask about.** It was asking `graphemeWidth()`, which sums
  what a cluster contains and comes to three for a CJK character with a spacing
  mark, so the model ended a column to the right of where the diff said the
  cursor was, refused such a cluster at the second column of a grid that had
  already fitted it into two cells, and reported its own continuation as an
  orphan. Nothing caught it because nothing pointed a replay at that cluster and
  nothing asserted the cursor. Whether a terminal really defers, and what it
  really does with a three-column cluster, are the things neither can answer, and
  are `scripts/terminal-probe.mjs`'s.
- **A backend is where the anchor lives, and an app picks it rather than a
  component.** The canvas is a rect that does not know where it sits; the two
  backends are what know. Inline is the last few rows with the log scrolling
  above, which is what a prompt, a spinner and a progress bar all want; full
  screen is the alternate buffer, for a dashboard or a viewer. A component that
  unilaterally took the screen in the middle of a build log is the failure the
  split exists to make impossible, which is why a backend is constructed by the
  app and cannot be asked for from inside a spinner. They do not nest, and that
  costs nothing to enforce: the live claim is already exclusive, so an inline
  canvas inside a full-screen one is a second holder of a claim that has one.
- **The inline backend reserves its rows with newlines before it paints
  anything.** Downward movement is CUD, which stops at the bottom margin and
  never scrolls -- so a canvas rendered with the cursor on the last row of the
  screen would paint every one of its rows onto that line. `height - 1` newlines
  scroll the log up to make the room, and the walk back up puts the cursor where
  the diff expects to start. Everything after that is relative, because the
  canvas's own row on the screen is not a number anything can learn: the log
  above it moves.
- **Anything that invalidates the screen throws the anchor away rather than
  diffing against it.** A resize, a write above the region, an eviction: the
  rows are given up and reserved again on the next present, which repaints in
  full. After a resize the old frame's row count is not even a number any more --
  it was written at the old width and the terminal rewrapped it wherever it
  liked -- so a diff against it is a diff against a screen that no longer exists.
  A canvas that _shrank_ leaves the rows it gave up blank behind it, which is a
  cost paid where it is visible rather than by walking the log up to close a gap
  nothing else can see.
- **An inline canvas is the terminal's width unless it was given one.** A canvas
  wider than the screen is one whose rows the terminal wraps, and a wrapped row
  is an extra row the cursor arithmetic does not know about -- every erase and
  every move after it is out by as many rows as wrapped. A width passed in is
  kept and not followed, because a caller that named one is describing content
  rather than a screen.
- **What a backend writes ends its lines with CRLF.** A bare `\n` reaches column
  zero only because the line discipline translates it, and ONLCR is off in raw
  mode -- which is where a full-screen app and every prompt live. Untranslated,
  the second line of anything written starts under the end of the first. Found by
  the screen model rather than reasoned out: the model implements the strict
  reading, which is the one a terminal in raw mode gives. The plain-text path a
  pipe gets keeps a bare `\n`, because a carriage return in a log file is not a
  line ending anybody asked for.
- **Leaving the alternate screen is `Terminal.restore()`'s, not a backend's.** A
  CLI that dies on the alternate buffer and never comes back has eaten the user's
  terminal, and `restore()` is what already runs on a signal, on `exit`, and on
  the way out of an uncaught throw -- so `enterAltScreen()` joins the cursor and
  raw mode on that list rather than a backend writing the sequence and hoping to
  get the chance to write the other one. It returns whether it was the call that
  switched, exactly as `hideCursor()` does and for the same reason. `1049` rather
  than `47`: it saves the cursor, switches, and clears in one sequence. The
  screen goes back before the cursor is shown again, so a cursor hidden while the
  alternate buffer was up is put back on the screen somebody is about to look at.
- **A full-screen backend holds what is written to it and flushes it on the way
  out.** There is no "above the region" on a screen with no scrollback, and the
  buffer is thrown away wholesale when it is left -- so a line written there
  would be read by nobody. Held rather than dropped, because a log line the app
  thought it had written is worse than one that arrives late, and the main screen
  is where its reader is. Unbounded on purpose: a cap that silently drops the
  start of a log is its own trap.
- **The backends are replayed against a screen, and it is not `FakeTerminal`.**
  That model is canvas-relative -- every `apply()` starts from the canvas origin,
  which is the only thing the diff's output claims to know about -- and a
  backend's whole job is the part it assumes away. `test/canvas/screen.ts` has
  rows that scroll off the top, a cursor that survives between frames, and an
  alternate buffer to switch to, so what a test asserts is what the user would be
  looking at. Two models rather than one shared one, for the reason the styler
  and the wrapper keep separate SGR tables: each says what its own layer claims.
- **No passthrough image protocols: Kitty, iTerm2 and Sixel are out.** Fidelity
  is a capability tier the way colour depth already is -- cells always, then
  sub-cell block and braille characters everywhere, and that is where it stops.
  The tier above needs a rectangle of the screen that the cell grid does not
  own, which the diff cannot reason about, and it is unavailable in tmux, over
  most of ssh, in CI, and in Terminal.app. Images are approximated with half
  blocks instead: two pixels per cell, the top as the foreground and the bottom
  as the background, which is nothing but cells and works everywhere.

### Input and focus

- **One thing owns stdin, and it is the router.** Every prompt used to set raw
  mode, attach its own `data` listener, decode, and put it all back -- which
  works exactly as long as there is one prompt. Two at once fight over the
  stream and neither can see what the other consumed. The router reads, decodes
  through `decodeKeys()`, and dispatches; components subscribe rather than
  listen. The holding-a-split-sequence machinery is the prompt's, moved rather
  than rewritten: `pendingLength()` says what could still be the start of a
  longer key and `ESCAPE_TIMEOUT` is what makes a lone Escape a key rather than
  a wait with no end.
- **A router refuses to exist where stdin is not a terminal.** `PromptError`'s
  rule generalized: a prompt with nobody to answer it fails loudly rather than
  hanging, and a router exists to read keys -- so one that never can is a bug in
  the app rather than a state to carry through every dispatch as a branch. An app
  that runs without input does not build one.
- **Bindings, then the focused element, then its ancestors, then the default.**
  A binding sees every key first, which is where quitting belongs: an app that
  cannot be quit because a focused input swallowed Ctrl-C is the failure the
  order exists to prevent. Tab is _last_, so a component that wants it -- a
  completion, a cell in a grid -- keeps it by stopping the event rather than by
  asking to be excluded from something.
- **An event is stoppable, or a text input's Left is also the list's "previous
  item".** The key reaches the focused element and every ancestor after it, and
  the only thing that can know the key was meant for the input is the input.
- **`onKey` is one function on the element, not a list of listeners.** The same
  argument the parser's hooks settled on: a list reads as though order mattered
  between entries nobody wrote, and a component that wants two things to happen
  writes one handler that does both.
- **The ring is rebuilt from the tree on every move rather than kept.** It
  reorders itself as the tree does, and there is nothing to keep in agreement --
  a couple of hundred elements walked on a keystroke is not a cost worth a cache
  that can be wrong. It skips a `display: none` subtree, read off the _resolved_
  style rather than the prop, because there is nothing on screen there to move
  the focus to.
- **Focus is a signal, and the `:focus` state is what it writes.** The signal is
  what a frame reacts to; the state is what the cascade matches, which is what
  makes an input that highlights when focused zero lines of component code. One
  source with the other derived, rather than two things to keep in agreement.
- **Nothing focused is a legitimate state.** An earlier version repaired the
  focus on every key, which also _grabbed_ it when there was none -- so the first
  Tab landed on the second element, because the first key had quietly focused
  the first. Repair is only for the element that has gone.
- **A focused element that is unmounted hands focus on by position.** Dropping it
  into nothing reads as an app that stopped responding: every key then goes to
  the bindings and nowhere else. What is kept is where it sat in the ring, not
  which element it was, because the element is exactly what has gone.
- **`focusable` and `tabindex` are reserved props.** Everything a prop names that
  this list does not is a style property, and the cascade refuses one it does not
  know -- so a typo is an error rather than a value nothing reads. A `tabindex`
  implies `focusable`, because giving something a place in the ring and then
  leaving it out of the ring is not a thing anybody means.
- **A paste arrives whole, and bracketed paste joins the restore list.** Without
  the markers a pasted block arrives as though it had been typed, so a newline in
  the middle of an address is Enter and a text input submits half of it. With
  them the router holds what is between `ESC [ 200 ~` and `ESC [ 201 ~` -- across
  chunk boundaries, since a paste splits like anything else -- and hands it over
  as text. Nobody wanting it whole is not an error: it is then typed in, which is
  what a terminal that cannot bracket a paste sends anyway. `Terminal.restore()`
  turns the mode off for the reason it leaves the alternate screen: a CLI that
  dies with it on hands the user a shell that puts `ESC [ 200 ~` into every
  paste, which has to be reset by hand.
- **A router puts back only the raw mode it turned on.** `setRawMode()` reports
  whether it was the call that changed anything, which is the rule `hideCursor()`
  and `enableBracketedPaste()` already follow -- a prompt inside a full-screen app
  that is already raw must not take the app out of it when the prompt is
  answered, because the app is still reading keys and what it gets back is a
  cooked stream that echoes.
- **One thing owns stdin, and a prompt will borrow it.** `PromptOptions.router`
  is what makes the rule true in an app that prompts: an app that already has a
  router -- a full-screen one, which needed one to have a focus ring at all --
  hands it over, the prompt binds to it, and the prompt takes only its own
  handlers back off. A prompt with no router builds one, which is correct only
  because nothing else is reading at the time; that is the ordinary case and it
  is not every case, and two prompts at once over two routers would both read
  every key.
- **The stream ending is the router's to report, for the reason keys are.** A
  prompt waiting on a key has to be told when none will ever arrive, or it waits
  forever -- and that is a question about stdin, which the router owns. A
  listener of its own for that one event would be the private stdin handling the
  router exists to replace, kept alive for a single case. `onEnd()` fires for the
  stream ending and for it erroring, since what a caller does about either is the
  same thing.
- **Resize is the router's to carry and the renderer's to mean.** The event
  belongs with the other one a terminal produces, so an app subscribes in one
  place for the two halves of one frame. What it _means_ -- re-evaluate the width
  and height media queries, re-lay out, repaint whole rather than diff against a
  grid that described a different screen -- is a frame's, and is deliberately not
  decided here.
- **A handler set is dispatched over a copy _and_ a membership check, because
  the two directions want opposite things.** A handler registered while an event
  is being dispatched does not receive that event, and one removed during it is
  not called -- and a bare `for..of` over the `Set` gives only the second, while a
  snapshot on its own gives only the first. Without the copy, a component that
  binds a key in response to being focused has that new binding see the very key
  that focused it, and whether it does depends on where in the iteration it
  joined. Without the check, the copy re-runs a handler that has just
  unsubscribed: a one-shot binding fires twice, and a dialog torn down by Escape
  still hands Escape to the handlers it was tearing down. The rule reads as the
  copy alone right up until it is written down, which is how the terminal's
  resize notify came to carry a comment justifying the snapshot by the one case
  the snapshot breaks -- both are fixed, and both halves are pinned by a test
  that fails when either is removed. Bindings, paste handlers, resize handlers,
  and `Terminal.onResize()` all say it the same way. See
  `test/input/input.test.ts`.
- **Mouse tracking is a follow-up, not a no.** It would give `:hover`,
  click-to-focus and a scroll wheel, and it costs a capability check and a mode
  that must go back on exit. The event model does not preclude it, which is why
  the type is `KeyEvent` rather than `Event`: a mouse event can join it without
  either having to become the other. The Kitty keyboard protocol is the same
  shape of answer, opt-in by query, and worth having the day something needs a
  key the legacy encoding cannot spell.

### The renderer

- **A component body runs once, and there is no re-render.** A component is a
  function of props that builds elements; what is reactive about what it built
  are the `createEffect()`s inside it, which write to the node they made. No
  virtual tree, no diff, no reconciler -- a signal change runs the one effect
  that reads it and touches the one node it wrote, and the frame that follows
  restyles, lays out and paints whatever that disturbed. This is the Solid model
  and it is why signals came first. The tax is that control flow has to be
  explicit, which is the entry below.
- **The owner tree is what unmounting means.** Something has to know what a
  component made, because a long-running CLI that does not leaks a watcher per
  mount and nothing above can see them to clean up. So every body runs under an
  owner: `createEffect()` registers with it, `onCleanup()` adds to it, context is
  looked up along it, and disposing it disposes its children first and then its
  own cleanups in reverse -- the order things were built in, undone. Every
  cleanup runs even when one throws, for the reason the signals layer already
  records: what a teardown that stopped half way leaves behind is a subscription
  nobody can reach to cancel. A caller that asked for the disposal gets the
  throw; an unmount the renderer did on its own reports instead.
- **`runWithOwner()` establishes a fresh ownership scope, at both levels, and
  three things had to be put aside for that to be true.** The owner, obviously.
  Then `runCleanups`, or an `onCleanup()` inside it goes to the _effect run_ that
  is on the stack rather than to the owner being borrowed -- which made `For`
  tear down every row at the end of every reconcile, rows that had not gone
  anywhere included. Then the signals layer's own parentage, which is the entry
  below. All three were found by `For` rather than reasoned out, and they are one
  rule said three times: what runs here belongs to this owner.
- **`unowned()` is the ownership twin of `untrack()`, and the renderer is why it
  exists.** An effect created while another effect's body runs is a child of it
  and dies when that body runs again -- which is what stops a component leaking
  an effect per run, and is exactly wrong where something else already owns the
  lifetime. `For`'s reconcile _is_ an effect body, so the implicit parentage
  disposed the effects of every row it had built, and a row that merely moved
  went dead: it kept the text it was last built with and stopped following its
  own state, while looking perfectly alive. Nothing leaks by opting out, because
  the caller opting out is the one that owns the branch and disposes it. See
  `test/signals/effect.test.ts`.
- **`onMount` fires after a frame, not at the end of the body.** The useful thing
  to do there is read what the component came out as, and `element.box` has no
  answer until something has laid it out -- so a callback that ran at the end of
  the body could only ever ask questions with no answers. It makes the promise
  the same for a component mounted by the first frame and one a `Show` revealed
  forty frames later. Under a bare `createRoot()` nothing drains the queue and
  the callback never fires, which is the honest answer rather than running it
  early against a tree that has no boxes.
- **Control flow is components, and they are the runtime primitive.** An `if` in
  a body runs once and a `.map()` builds the list it saw, so a conditional and a
  list have to be `Show` and `For` -- a component is the only thing that can own
  a branch and dispose it. A template compiler emits calls to these rather than
  growing a second way of saying it, so there is one implementation of what
  mounting and unmounting a branch means. Both return a `box`, because a
  component produces exactly one node and this layer has no fragment: that
  wrapper is a flex item and it lays out, which is a real cost, so both take
  `props` and the layout the branch would have had goes there. Getting it wrong
  is visible immediately -- a `For` whose rows should stack writes
  `props: { 'flex-direction': 'column' }` on the `For`, and putting it on the box
  _around_ the `For` puts every row on one line.
- **`Show` disposes its branch rather than hiding it, and rebuilds only when
  presence changed.** A hidden branch is still a branch and its effects still
  run, so a thousand rows behind a closed disclosure cost a thousand rows of
  reactivity; hiding is `visibility` and a different question. Rebuilding on
  every change to what `when` returned rather than on the change in _presence_
  would tear the branch down and build it again on every tick of a counter,
  losing whatever state it held -- so what the branch is handed is read untracked.
- **`For` keys by the item, and an index is an accessor.** Identity rather than
  position, because position keying rebuilds every row after the first change,
  which in a terminal moves the focus ring out from under whoever was typing. A
  row that moved is the same row, so telling it where it now sits has to be a
  signal it reads rather than a rebuild -- the rebuild would throw away the thing
  keying exists to keep. An item that appears twice is two rows, so the
  bookkeeping is a queue per key: two equal primitives in a list are a list with
  two entries in it, not a bug to refuse.
- **Nothing dirty means no frame, and no frame means no timer.** The scheduler is
  asked for a frame by a signal write or by a tree mutation, sets one timer, and
  a frame that finds nothing to do sets no other -- so a CLI that prints one line
  never starts a loop. Frames coalesce to `frameMs`, thirty a second, because
  pacing matters more here than on the web: every frame is bytes down a pipe that
  may be a network, and a spinner, a progress bar and a clock all quantize slower
  than that anyway.
- **A tree mutation asks for a frame, which is why `createTree()` takes a
  callback.** Not every change comes from a signal: a key handler that calls
  `setText()` directly is the ordinary case, and without this it is invisible
  until something else happens to draw. The tree already recorded it; the
  callback is only what turns recording into asking.
- **A structural change forces layout, and the restyler cannot say so.** It
  answers for what a _style_ change implies and for nothing else, while two other
  things move boxes: a text that was edited or a `raw` that re-measured, which is
  `marks.layout`, and a child added, removed or moved, which is `marks.children`.
  Found by a `For` that reordered its rows correctly and drew them in the old
  order -- the elements were where they should be and the frame had nothing
  telling it to lay out again.
- **A media query is asked about the screen, not about the canvas.** The
  difference matters in exactly one case and it is the one that would otherwise
  be a loop: an auto-height canvas is as tall as its content, so resolving
  `@media (min-height: 10)` against it lets a style decide a height that decides
  that style. "How much screen is there" has an answer nothing in the frame can
  move. Read again on resize, along with the full re-match a resize already
  forces.
- **An auto-width canvas is given a width, so that the backend stops following
  the terminal.** It reads backwards and it is the point: an inline canvas built
  without a width erases and resizes _itself_ on every resize, and an auto-width
  one is already re-measured and resized by the frame -- so a spinner twelve
  columns wide blinked off and back on every time the window changed by a column
  it was not using. A canvas that is neither auto nor fixed is left to follow the
  terminal, because nothing else would move it.
- **An auto-height canvas is laid out again where it reached further than it
  measured.** The same second pass `renderToString()` takes and for the same
  reason: a row whose children flex is measured with each child offered the whole
  content box and placed with each given a share, so a prompt's question that
  wraps to two lines in the share it gets was one line in the room it was offered
  -- and the canvas reserved one row with the second clipped off the bottom.
  `arrangedExtent()` asks the arranged tree rather than asking for another
  estimate. It can only grow the canvas, never shrink it, so a frame that
  measured right pays one comparison.
- **An auto-height canvas is measured, not laid out and read back.** That was the
  first answer and it is wrong in the way that matters: a root with no declared
  height fills whatever it is given, so `box.height` after a pass at the screen's
  height _is_ the screen's height -- two rows of content reserved twenty-three
  rows of terminal. `measureNode()` asks what a node would want if it could have
  whatever it wanted, which is the question, and it replaced a two-pass arrange
  that was both slower and wrong.
- **`dispose()` finishes the region, which it had always claimed to do and did
  not.** An inline backend holds its rows until it is told otherwise, and with
  the anchor goes the arithmetic that says where the frame's top is relative to
  the cursor -- so a `console.log()` after `dispose()` moved the real cursor and
  left that arithmetic describing somewhere else. The erase the region does on
  its way out then started two rows _inside_ the frame and cleared downwards,
  taking the log line with it and leaving the top two rows of a box on screen,
  which is how it was reported. `backend.done()` is exactly the documented
  behaviour -- the frame stays in the log, the cursor goes below it -- so the
  teardown calls it, and ordinary output afterwards lands where it looks like it
  will. Not on the failure path: there the caller wants the frame gone, and
  `fail()` calls `stop()` itself. The order is the consequence worth knowing:
  erasing means `backend.stop()` _before_ `dispose()`, because afterwards there
  is no anchor for an erase to be relative to and a `stop()` on the other side
  quietly does nothing.
- **A failure puts the terminal back before it says why, and stops.** A CLI that
  dies on the alternate buffer with the cursor hidden has eaten the user's shell,
  and a message printed into a half-drawn frame is unreadable anyway -- so the
  order is teardown, `backend.stop()`, `Terminal.restore()`, and only then the
  error handler. Stopping is the other half: a renderer that reported and carried
  on would throw the same frame away thirty times a second, so the first failure
  ends the loop and the report happens once.
- **A frame that failed stops being a frame.** An effect that throws is
  _reported_ by the scope's error handler rather than thrown through it, so the
  flush returns normally and the rest of the frame ran over a renderer that had
  already given the screen back -- painting onto the restored terminal, and
  draining mount callbacks against an owner whose cleanups had all run. The
  handler cannot throw instead, because the signals layer is explicit that an
  error in an effect is never rethrown; so the frame asks whether it is still
  alive after the flush. That is the only place it can be asked, and it is why
  `runFrame()` checking on the way in was not enough.
- **A renderer gets its own effect scope, and sharing the module's was a trap.**
  A scope holds one scheduler and one error handler, so a second `render()`
  installed its frame loop over the first's: the first then painted nothing ever
  again, an effect that threw in _either_ tore down whichever had installed last
  -- restoring the terminal out from under the one still running -- and disposing
  one put back the handlers it had saved rather than the ones in place. The
  default is now a scope of its own, and it costs nothing, because
  `createEffect()` asks the owner it was created under for the factory rather
  than reaching for the module.
- **A branch builder that throws undoes its own half, and getting there took
  three orders.** Both control components had the same shape of bug and an effect
  caching what it threw is what made each permanent: the branch never retries
  until a dependency changes, and the recorded state says it has nothing to do.
  `Show` first committed presence _before_ the branch existed, so a `children()`
  that threw left `showing` claiming a branch that was not there and the next
  truthy `when()` returned early. Moving the commit after the build fixed that
  and left the inverse: the old branch was still torn down first, so `showing`
  kept the _old_ presence while what it named was already gone, and going back
  the way it came returned early to an empty host. So `Show` builds first and
  touches nothing on screen until it has something to put there -- which is also
  the only order where a failure needs no undo. `For` cannot do that, since its
  reconcile is a list, so it rolls back instead: every branch it made, _including
  the one it was part way through_, and every index it had already moved, because
  a row left reading a position the failed pass never placed it at paints the
  wrong number at the old spot. Its `fallback` is inside the rollback too -- built
  after `rows` was committed, it was the one branch outside it, and with the list
  already empty `each()` never changes again and the effect never retries.
- **A cleanup written inside an effect body is raised, not collected.** The
  owner tree collects what a teardown threw, because one failing cleanup must not
  leave the rest of it undone -- and the composite the _signals_ layer holds is
  not a teardown, it is that layer's cleanup, which it reports on a re-run and
  raises at `dispose()`. Handing it the array swallowed the throw: an
  `onCleanup()` in an effect body, which is where an unsubscribe belongs, failed
  in silence, while the same call one line up in the component body was reported.
- **A frame does not start from inside a frame.** `frame()` called from an effect
  re-entered `settle()`, and the flush it runs is a no-op while one is already
  draining -- so what the inner frame actually did was take the outer frame's
  marks and paint a half-settled graph, after which the outer frame found nothing
  left to draw. The frame already running is the one that finishes.
- **A disposed owner starts nothing new.** `runWithOwner()` is for a callback
  that outlived the body that registered it -- a key handler, a promise landing
  -- which is exactly the case where the owner may be gone by the time it runs.
  An effect created there would have no component to keep up to date and nothing
  that would ever dispose it, so it is not created. A cleanup registered there
  runs immediately instead, because nothing else ever will and a cleanup that
  never runs is the subscription the owner tree exists to cancel. A branch asked
  for there comes back already disposed, so that what runs under it starts
  nothing either -- a live branch parented onto a disposed owner is one nothing
  will ever walk again.
- **What a branch's cleanup threw is reported, not dropped.** `Show` and `For`
  dispose branches and are in no position to do anything with a throw, and
  `disposeOwner()` hands its errors back rather than raising them -- so they went
  nowhere. The root owner carries a sink that `render()` fills with `onError`;
  where there is none, they are raised, because a `createRoot()` with no renderer
  over it has nowhere to put them and silence is the one answer that is always
  wrong.
- **`Marks` grew a fifth question, and it is the one about an element that is no
  longer here.** `Restyler.forget()` was written for the leak it describes -- an
  unmounted subtree stays reachable for the life of the restyler, which in a TUI
  that shows and hides a panel is unbounded -- and nothing called it, because
  nothing knew what had been removed: `marks.children` names the _parent_, and by
  then the child is already gone from it. `removeChild()` records the child, and
  the frame forgets the ones that ended it detached. Ended, rather than were
  removed: `insertBefore()` is a move and a move is a removal followed by an
  insertion, so forgetting everything recorded would throw away the resolved
  style of every row a `For` reordered.
- **The restyler is on the handle, because one thing only its owner can do is
  something an app needs.** `touchSheets()` is how a stylesheet swapped at
  runtime says that every rule is stale, and a theme change has no other way to
  say it.
- **An `onMount` throw is reported and the renderer stays up.** A mount callback
  is not the frame: it runs after one, its throw says nothing about whether what
  is on screen is right, and tearing the app down over it is a worse answer than
  saying so.
- **What is deliberately deferred, and why it is not an oversight.** Whether
  `main()` grows a way for a command's `run()` to return a view is the parser's
  surface rather than the renderer's, and it wants the component rewrite (SIG-76)
  to say what a view is first. Async components are the harder one: a prompt is
  inherently async and `select()` returns a promise, so "render a tree" and
  "await an answer" have to be reconciled -- and doing it before anything has been
  ported would be a guess with nothing to check it against. `runWithOwner()` is
  the seam either will use, which is why it is public now.

### Templates

- **The toolchain is proved by a spawned `tsc` and a spawned node, not from
  inside the suite.** Everything in `test/template/` reaches JSX by calling
  `jsx()` and `jsxs()` directly, which is what the transform emits -- so it
  proves the runtime and cannot prove `jsxImportSource` resolving
  `@ttylabs/sigil/jsx-runtime`, the `exports` map answering for that subpath, or
  node importing what `tsc` wrote. `packages/cli/test/template.test.ts` is the
  other half, for the reason `typescript.test.ts` and the demos already live
  there: vite transforms whatever a test file imports, and a spawned process is
  the whole difference. Not theoretical -- `jsx-dev-runtime` did not exist for a
  while and every test passed throughout, because the production transform never
  asks for it and nothing compiled a `.tsx` for real.
- **The three fixtures behind that test are one component written three ways**
  -- by hand, through the tag, as JSX -- and asserting they agree is the
  differential invariant taken across the package boundary. They began as an
  ergonomics comparison for choosing the design, in a directory called
  `prototype/` that nothing ran; the comparison did its job once, and what was
  worth keeping was the check, so it became one. A `.tsx` fixture is excluded
  from its package's own tsconfig and checked by the one the test drives, since
  the package pass has no `jsx` settings and should not grow them for a fixture.
- **Two frontends, one IR, one emitter.** JSX and the `ui` tag both build
  `IRNode`s and both hand them to `emit()`, so there is exactly one
  implementation of what a template _means_. Build-time and runtime parsing
  separately is the failure SIG-69 exists to prevent: a template that behaves
  differently after `sigil build` than it did in development is close to
  undebuggable. `test/template/tag.test.ts` asserts the two build the same tree
  from the same template, and it has already caught a divergence introduced by
  a fix to something else.
- **JSX is the canonical syntax and the `ui` tag is the zero-build one, because
  Node's type stripping does not handle JSX and will not.** Stripping is erasure
  and JSX is a transform, so a `.tsx` command module cannot run under the rule
  recorded above that a command module may be TypeScript with nothing compiling
  it. What JSX buys in exchange is what a tagged template cannot have: prop type
  checking, completion, go-to-definition and rename, in every editor, with no
  extension installed.
- **A function-valued prop or child is reactive; a value is static.** `{count}`
  is reactive, `{count()}` is a snapshot, `{() => count() * 2}` is reactive. It
  is the convention `renderer/control.ts` already follows, where `ShowProps.when`
  is `() => T`. Solid reaches fine-grained JSX by compiling `{count() * 2}` into
  a getter and pays for it by having JSX mean different things compiled and
  uncompiled; here no compiler rewrites an expression, so a build step is a
  **pure optimizer** -- it may hoist, fold, resolve class names and pre-measure,
  and it may not change what anything evaluates to. The price is
  `{() => count() * 2}`, which for CLI-sized templates is cheap, and `{count}`
  for the bare accessor is shorter than Solid's `{count()}`.
- **The interpolation is `${}` because it is the only one there is.** A template
  literal splits on `${}` and nothing else, so `{expr}` arrives as literal text
  and evaluating it would need `new Function` -- which the backends rule out.
  Not a preference.
- **A component is interpolated in the tag, never named.** `<${Counter} />`,
  because a tag function has no scope to look a name up in: the alternatives are
  a registry, which costs tree-shaking, or this. Host elements stay bare, since
  `box`, `text` and `raw` are the only three and need no lookup.
- **`jsx` and `jsxs` are not the same function, and aliasing them is a
  divergence.** `props.children` is a _single child_ in `jsx` and a _list_ in
  `jsxs`. Treating both as a list flattened `<Kind>{[a]}</Kind>` into one child
  and handed the component `a` where the tag handed it `[a]` -- the same
  template, two trees. An array reaching `jsx()` is one child that happens to be
  an array.
- **Whitespace follows JSX's rule rather than one of our own.** Each line is
  trimmed of the indentation that exists only because the template spans lines,
  blank lines go, and what is left joins with a single space. The first rule --
  drop any run containing a newline -- was right between two elements and wrong
  inside prose: `hello` and `world` on two lines came out `helloworld`, and JSX's
  transform joins them with a space, so the two frontends were different
  languages. A run with no newline in it is the author's, which is what keeps
  the trailing space in `<text>Enter your email: </text>`.
- **A component's whitespace-only text children are dropped; a host element's
  are not.** A host's whitespace is content. A component's children are data it
  interprets, and a stray space is never part of that -- one space before an
  expression made `props.children` the array `[' ', fn]`, so
  `<${Show}> ${(v) => ...}</>` failed with `props.children is not a function`
  while the same template across two lines worked. This is the one place the
  frontends diverge from JSX on purpose, and they diverge together.
- **A boolean in text position is absent rather than the word it spells.**
  `{cond && 'ready'}` is empty when `cond` is false, which is what JSX has
  always done. `appendValue()` skipped a boolean and `stringify()` did not, so
  one rule said twice disagreed: empty as a box's child and the word `false`
  inside a `<text>`. `0` is still `"0"` -- a number is a value somebody meant to
  show.
- **An element in text position is refused, and the check is where the node
  is.** There is no inline layout, so a `<box>` inside a `<text>` has nowhere to
  go. Asked before the content is assembled rather than inside `textValue()` for
  two reasons: JSX evaluates a child before the call, so a nested host arrives
  already built and wrapped as a _slot_ rather than as an element node -- left
  to a `kind` check it was painted as `[object Object]` -- and the node is where
  the source position still is. It is asked in two places for that second
  reason: `textPart()` refuses an element _node_, where the child's own position
  is, and `applyText()` refuses an element that arrived as a slot, where only
  the `<text>`'s position is left. Both refuse before anything is built, because
  an effect's throw is reported rather than raised -- so the dynamic spelling of
  it used to hand back an empty text node and a log where the static spelling
  threw.
- **`<raw>` refuses children rather than discarding them.** It paints its own
  cells, so a child has nowhere to go, and JSX had already built it and left its
  effects on the owner before it was dropped. The rule a property the engine
  ignores already follows: parsing something and doing nothing with it is worse
  than not accepting it.
- **The IR is not serializable, and that is the expression decision rather than
  a second one.** An expression is opaque JavaScript, so `${() => count()}` is a
  closure and no design makes it data. The payoff the ticket wanted -- shipping
  the IR as data to skip shipping a parser -- is already delivered by the build
  emitter producing JS source, which tree-shakes the parser out anyway.
- **Control flow stays `Show` and `For` rather than becoming IR node kinds.**
  SIG-69 originally asked for the opposite and `renderer/control.ts` had already
  recorded the reason against it: those two are the one implementation of what
  mounting and unmounting a branch means, and a second definition in the IR is a
  second thing to keep in agreement. A build emitter that wants something
  tighter recognizes the imported bindings by name.
- **A source position is optional on an IR node, because the production JSX
  transform passes none.** `jsxDEV` carries a file, line and column; `jsx`
  carries nothing; the `ui` tag always knows its line. So an error points at the
  template from the tag and from a dev build, and not from a release one --
  which is the transform's asymmetry rather than ours, and is why `loc` is not
  required.
- **The host prop types are derived from the property table, not listed beside
  it.** `Style` carries every longhand and its resolved type; the shorthands and
  aliases are literal unions on their own tables. `Kebab<>` and `Camel<>` are
  `kebab()` and `camelCase()` written in the type system, so both spellings are
  offered in both directions -- `isKnownProperty('flexFlow')` is true at runtime,
  and offering only the kebab key made `<box flexFlow="column" />` a type error
  and a runtime success.
- **The one list that is written out is the colour properties, and a test pins
  it.** `Color` is `number`, and a conditional type cannot tell a colour from a
  padding -- `T extends Color` matched every numeric property, so
  `<box paddingTop={1} />` was a type error while `<box color={39} />` was legal,
  which is both answers backwards. A colour is spelled and never counted:
  `parseColor()` refuses `"39"`. `test/template/props.test.ts` asserts the list
  against `COLOR_PROPERTIES`, and `test/template/jsx-types.tsx` -- checked by
  `tsconfig.jsx.json` under `pnpm check` -- is what fails if the widening comes
  back, because the runtime test cannot see it.
- **A table that a mapped type reads must keep its keys through the declaration
  emitter.** `keyof typeof SHORTHANDS` was a union inside the package and
  `string` in the published `.d.mts`, because the emitter widens the table to
  `Record<string, Shorthand>` -- so the mapped type became an index signature and
  let every misspelled prop through, for consumers only. Two things caused the
  widening and both are fixed: an `as unknown as Record<...>` cast on the
  literal, and a `__proto__: null` key, which makes TypeScript type the literal
  loosely. The tables close with `satisfies` against a written union and set the
  null prototype with `Object.setPrototypeOf()` afterwards, which is the same
  runtime defense with the keys intact.

- **The two emitters share every leaf, and disagree only about _when_.**
  `emit()` decides the shape of a tree and hands every leaf decision -- is this
  prop reactive, what does this content come to, what does a slot append -- to
  `applyProp()`, `applyText()`, `appendValue()`, `rawElement()` and
  `rootElement()`. The build emitter in `@ttylabs/cli` calls the same five. So
  the two cannot come to _disagree_ about what a prop or a child means; they can
  only differ over which of those answers was settled ahead of time, and
  settling one ahead of time is the definition of a pure optimizer. The shape it
  replaced had one implementation of the thunk rule inside `emit()` and would
  have grown a second inside the toolchain, which is the drift SIG-72 exists to
  prevent, written as code rather than as a promise.
- **`parse()` is separable from `emit()`, and `Expr` is the hole that leaves.**
  A compiler reads a template out of a file, so every `${...}` in it is text:
  the shape of the tree is knowable and what was interpolated is not. It parses
  with _this_ parser, an `Expr` per interpolation, because a toolchain with a
  parser of its own is the second parser this design cannot afford -- the day
  the two disagreed about whitespace or about a closing tag is the day a
  template means one thing before `sigil build` and another after. So `Expr`
  lives in the IR rather than in `@ttylabs/cli`: nothing at runtime makes one,
  and every helper above refuses one by name rather than letting a prop object
  reach the cascade several layers from the mistake. Two `Expr`s are compared by
  their source rather than by identity, since a compiler makes a fresh one per
  interpolation and `</${Counter}>` is never the same object as the
  `<${Counter}>` it closes.
- **The analysis pass rewrites the IR rather than marking it.** SIG-69 handed
  this over as marks, with the warning that marks nothing reads are marks that
  go stale; the answer to that is not to be careful with the marks, it is to
  have none. A fold is written into the IR, so the build emitter prints
  `text("Counter")` because the node says one literal child -- not because a
  flag beside it claims the children were static. There is no second copy of the
  truth to keep in agreement, and the rewritten IR still runs through `emit()`,
  which is what makes "the analyzer may not change what anything builds" a test
  over the corpus rather than a sentence in a comment.
- **What it folds is a `<text>`'s content and a box child that is already a
  string.** Both are exactly what `applyText()` and `appendValue()` do at run
  time, done once instead of per mount; adjacent literals merge only inside a
  `<text>`, because a box's two text children are two flex items and merging
  them there would delete one. It is conservative about anything that is not a
  primitive, since `textValue()` throws on an element and a fold must not turn a
  run-time error into a build-time one. The asymmetry is worth knowing: `${7}`
  folds on the interpreted path and _cannot_ on the build path, where it is an
  `Expr` -- so the two paths run different code and are asserted to produce the
  same tree, which is the whole point of the corpus.
- **A static prop object is hoisted; a static subtree is not.** Hoisting a
  subtree is the optimization everybody reaches for first and it is unsound
  here: Solid hoists a DOM template and _clones_ it per use, and an `Element`
  cannot be cloned -- it is mutable, it has one parent, and a component body
  runs once per instance, so a subtree at module scope would be one tree shared
  by every row of a `For`. That is not a faster right answer. The prop objects
  are safe because `Element.#apply()` reads one and never keeps it; they are
  deduplicated by their source, so two elements with the same props share one,
  and frozen, so a future that keeps one is loud rather than silent. A
  _component's_ props object is never hoisted however static it is: a component
  is handed that object and may keep it, add to it, or pass it on.
- **The constructor takes the static props only where no name is repeated.** Two
  props of one name are written in order and the last one wins, and lifting the
  literal one into the constructor reverses that: `color=${x}` followed by
  `color="red"` is red until the signal moves, and would have been `x` from the
  first frame. Nobody writes it, and the fix is to stop reordering rather than
  to reason about when reordering is safe. Pinned end to end by a corpus entry
  rather than only by the shape of the output, because what is wrong about it is
  a frame and not a line of source.
- **What is decidable from the IR fails the build rather than the frame.** An
  element inside a `<text>`, a `<raw>` with children, a `<raw>` whose measure is
  a value rather than an expression: all answerable without running anything, so
  they are compile errors -- the same rule the utility generator follows by
  parsing every declaration it generates on the way out. It is also why
  `emitRaw()` asks about children _before_ it asks about the measure and the
  paint: children are the half a compiler can answer, and two emitters reporting
  two different faults about one element is the divergence they exist to avoid.
  A component the IR holds as a live function is the one thing the compiler
  refuses that the interpreter accepts, and it has to: there is no source to
  print, and that shape is how a template reaches the IR at run time rather than
  how it reaches a file.
- **The output is JavaScript, it is formatted, and it carries positions rather
  than a source map.** JavaScript because emitting TypeScript is one more thing
  in the pipeline in exchange for typed props nobody reads -- the app's own
  `.tsx` is where its types are. Formatted because it is going to be read
  whatever the intent. Positions rather than a source map because this emitter
  is handed the quasis of one template and not a file: _where in a module_ that
  template sat is what `sigil build` knows, so the map belongs there. What it
  can do it does -- each `loc` is printed into the helper calls that can throw,
  so a compiled template's error names the same line the interpreted one does.
- **It compiles the tag rather than JSX, and it does not find templates in a
  file.** Neither is a gap. A `.tsx` is compiled by the app's own TypeScript
  toolchain into `jsx()` calls, which carry no parser to shake out; the tag is
  the frontend that ships one, so it is the one worth compiling -- and any
  frontend that can produce IR with `Expr` in it, SIG-71's YAML and JSON
  included, compiles through the same emitter. Finding the templates in a
  module, and knowing where to write each expression and the module-scope
  statements back, is SIG-73's, which already owns reading an app off disk. The
  consequence
  worth knowing is that a `ui` template written _inside_ an interpolation is
  printed back verbatim and stays interpreted: an expression is not the
  compiler's to read, and the pipeline will find those the same way it found the
  outer one.
- **Resolving class names and pre-measuring are deferred with reasons rather
  than omitted.** SIG-69 named both as this pass's work. A resolved class name
  needs the app's stylesheets, which the build owns and one template does not
  have. A measurement needs a width and a resolved style, and a text's
  measurement is cached per width and keyed on the resolved style _object_ --
  so at build time there is no width to pre-measure at and no style to key on.
  They are the build's once it has an app to read.
- **Every name the generated code uses carries the prefix, imports included.**
  That was the whole of what `prefix` was documented to promise and the imports
  were taken bare anyway, which is the one that looks safe and is not: the
  interpreted emitter holds a function reference and never does a scope lookup,
  while the compiled one is spliced into a module this compiler has never seen.
  A component whose prop is called `text` puts a `text` in scope, and
  `const $e0 = text("")` then calls it -- `TypeError: text is not a function`,
  from a template with nothing wrong with it, in the one emitter that cannot
  have the problem's mirror. So `CompiledImport` carries a local beside the
  imported name and the output reads `text as $text`. Found by review rather
  than by the corpus, because a corpus of templates cannot say what is in scope
  where its output lands -- which is why an entry may now ask to be built with
  every imported name **shadowed** by a local. Which names those are is read off
  the compiled module's own imports rather than listed, for the reason
  `COLOR_PROPERTIES` and `INHERITED` are: the list went stale on the first try,
  naming `raw`, which the emitter never imports, and missing `rawElement` and
  `rootElement`, which it does -- so it shadowed a name nothing used and left
  two real ones uncovered.
- **The prefix is a contract, it cuts both ways, and an empty one is refused.**
  It must not occur anywhere in the module the output is spliced into, and that
  is the caller's to guarantee rather than something the emitter can check,
  because it is handed IR and not a file. Outward is the entry above: a local at
  the splice site shadows a generated name. Inward is the same problem read
  backwards, and is the one nobody thinks of -- an interpolated expression is
  printed back into the scope the generated locals are declared in, so a
  template whose expression reads a free variable called `$e0` reads the
  generated `$e0` instead of the author's. Neither is reachable by a caller that
  scans the module for its prefix before choosing it, which is a substring
  search and is `sigil build`'s to do. An empty prefix is refused outright,
  because it hands back bare imports -- the first bug again -- and it is what a
  caller reaches by passing something falsy rather than by meaning it.
- **`__proto__` is written as a computed key, and it is hardening rather than a
  fix.** Written plainly or quoted it is prototype sugar, so
  `Object.freeze({ "__proto__": "x" })` has no own property of that name and the
  prop would be dropped on the way into the constructor. Nothing observable
  depends on it today: `Element`'s prop store is a plain object, so the
  interpreted path's `#props["__proto__"] = "x"` is swallowed by
  `Object.prototype`'s setter and both paths end up with nothing -- measured,
  not reasoned. It is closed anyway because the rule this repo already records
  for the parser's registries is that a name really can be `__proto__`, and the
  day that store becomes null-prototype is the day this becomes a divergence
  nobody would be looking for here.
- **`compile()` takes a module's templates, not one template.** Imports, the
  hoisted block and the prefix are all facts about a _module_; compiling one
  template at a time made the caller merge all three, and merging is where one
  answer becomes several. Twenty templates each asking for `text` under their
  own prefix is twenty aliases for one import, and two templates that share a
  prop set share nothing. One call, one prefix, one hoisted block that
  deduplicates across every template in the file -- and `renderImports()` stays,
  because printing is still worth doing in one place.
- **A printed expression gets a newline before its closing paren when it could
  open a line comment.** An expression ending `foo // why` swallows whatever
  follows it on that line, which is the `)` the emitter has just written: a
  `SyntaxError` in the generated module, again from a template with nothing
  wrong with it. Asked with `includes('//')` rather than by tokenizing, which is
  sound in the direction that matters -- a source with no `//` in it cannot open
  one, and a `//` inside a string costs a newline and nothing else. `(0, expr)`
  was the other candidate and is wrong: it unbinds `this`, so the component
  callee `(0, scope.Show)` would stop being a method call. The callee goes
  through the same function as every other expression now, since it was the one
  written out in two places -- which is how one of them comes to be missing a
  rule the other has.
- **Both sides of the differential test are generated from one corpus, and
  nothing about a divergence is loud.** A compiled template that builds a
  slightly different tree renders, lays out and paints perfectly happily; the
  only person who finds out is the one who ran `sigil build` and noticed their
  app changed. So `test/template-corpus.ts` is data, and `test/emitters.test.ts`
  generates three builders per entry -- interpreted, analyzed, compiled -- into
  modules it imports, comparing the element structure, every element's resolved
  style, and the painted grid in full colour, before and after a signal write.
  Generated rather than hand-written for the reason the fixtures behind
  `template.test.ts` are one component written three ways, and one more besides:
  two hand-written sides can be quietly edited to agree, and one corpus cannot.
  The expression _source_ is what is shared, so the interpreter and the compiler
  are provably given the same expressions to evaluate.

### The build: reading an app off disk

Lives in `packages/cli/src/build/`. Four passes over a tree of source files,
none of which runs any of it, and then rolldown. The bundler is stage five and
is not written yet; everything below produces source and data, which is what
makes it testable with a fixture directory and no bundler at all.

- **The route rules live in `@ttylabs/sigil/routes`, because there are two
  walks.** The runtime's reads one level when argv names it; the build's reads
  every level ahead of time. They have to agree _exactly_ -- an app that routes
  differently bundled and unbundled is the one divergence a user cannot debug,
  since both halves are behaving as designed -- so neither of them decides
  anything. `readRoutes()` answers "what is in this directory" and both callers
  read the answer: the names, the six extensions, the declaration file that is
  not a route, the `.` and `_` prefixes, the `index` that is the directory
  itself, the package that renames itself out of its own manifest, and the
  collision between two routes claiming one name. It was a refactor rather than
  a new module -- `init-command.ts` had all of it as private functions -- and
  the point of moving it is that a second copy is a copy that drifts. Same rule
  `LAYOUT_PROPERTIES` and `COLOR_PROPERTIES` already follow, except that this
  one drifts into an app that works until it is built.
- **A `_` prefix is not a route, and that is a decision somebody makes rather
  than a thing that was always true.** A `.` is not a route because nothing
  starting with one ever was -- `.gitkeep`, `.DS_Store`, a `.git` directory.
  A `_` is the one way to put a helper module, a shared component, a fixture, or
  a `__tests__` directory inside a `commands/` tree without it becoming a
  command, and without it `commands/_helpers.js` _is_ a command called
  `_helpers`, which is a footgun the moment a routes tree is the normal way to
  write an app. SIG-74 deliberately did not invent it, since nothing had decided
  it; it belongs here because the build and the runtime walk have to agree on
  it. It is the prefix and only the prefix, so `my_command.js` is `my_command`.
  It takes an index module too -- a `_index.js` is a helper that happens to be
  called index, not the directory's own command -- which is why `isPrivateRoute()`
  is asked in `routeName()` _and_ in `indexEntry()`: one rule with two readers,
  because `_` hiding a module from the listing and then loading it as the
  directory itself is the one combination that makes no sense.
- **...but it is a rule about a walk, not about a path somebody wrote.**
  `commands: { helpers: './_helpers.js' }` is `mycli helpers`, because a
  declaration naming a path is an explicit statement. That is the same asymmetry
  already recorded for a path nobody named being a directory _of_ commands while
  a named one is _one_ command. It is also why the check is not inside
  `moduleName()`, which is asked about full paths from a declaration as well as
  about entries from a listing and could not tell the two apart.
- **A `commands/` directory that is itself a package is refused rather than
  walked.** The runtime asks `readPackage()` _first_ for a path nobody named, so
  such a directory is **one** command rather than a directory of them -- and a
  `commands/package.json` carrying `{ "type": "module" }`, which is how a
  package forces ESM on a directory, is one. Walked instead, the build emitted a
  whole tree where the runtime emits a single command, which is precisely the
  divergence the shared rules exist to prevent, and it took a test asserting both
  halves against each other to see it. It cannot be resolved correctly either,
  which is why this is a refusal and not a special case: the runtime names such a
  package from the module it _imports_ -- `cmd.name ?? pkg.name` -- and the build
  cannot read that without running it. The error says to declare it under a key,
  which makes it one named command, or to drop the manifest. A side benefit: an
  unnamed one is refused by the runtime too, with
  `Expected command name to be a non-empty string`, and the build now says what
  is actually wrong.

- **`load` is `path` said as a function, and it exists because a bundled app has
  no file to read.** Its command modules are chunks a bundler named, reached by
  a dynamic `import()` the bundler rewrote, so `path` -- a file to `stat` and a
  `file://` URL to build -- has nothing to point at. `sigil build` emits
  `load: () => import('./commands/build.js')` where the unbundled tree had a
  directory to walk, and the deferral that makes `mycli --help` fast survives
  bundling instead of being flattened into the entry chunk. A literal specifier
  inside a dynamic import is the one thing a bundler can see, follow and split
  on, which is what makes this the shape rather than a registry or a manifest.
  Otherwise it is `path` exactly: the module _is_ the command, its default export
  is merged over what the declaration left `undefined`, and it is not called
  until the command is matched. So `fetchModule()` is where the two part company
  and the whole merge below it is shared -- a second copy of that merge is a
  second set of answers about aliases, labels and `hidden`.
- **It is refused beside `path` and beside `run`.** Three answers to "what is
  this command" and no right one to pick between them, which is the rule
  `path` and `run` already follow -- and picking silently is what makes it a
  trapdoor. A `load` beside a `path` would fetch the module twice by two
  mechanisms and merge whichever won.
- **A loader gets no `baseDir`, because there is no file for a path to be
  relative to.** A bundled module declaring a `path` is already asking for a
  file that is not there, so it resolves from the working directory -- which is
  the answer a schema written inline already gets, and is why every example
  passes an absolute path.
- **A loader that hands back the command rather than a module is taken.** `.default`
  is read the way an imported module's is, so `() => import('./build.js')` is
  the whole of the ordinary use; not reading past it would make a loader
  silently a different contract from an import.
- **The module is read, never imported, and that is the same deferral from the
  other end.** A command module is allowed to do things at top level -- read a
  config file, open a connection, exit -- so the build parses it. `oxc-parser`
  is the parser rolldown already embeds, so the toolchain has one and not two,
  and it reads every extension a route may have with no compile step of its own.
  A node's `start` and `end` are **UTF-16 code unit offsets**, which `slice()`
  takes directly; they are not UTF-8 byte offsets, which is the other plausible
  convention and the one that would corrupt every sliced expression the moment a
  module held a non-ASCII character -- silently, and only for that app. Pinned by
  `should slice an expression by string index rather than by byte`, because a
  parser that changed its mind about this would look exactly like one that had
  not. A line and a column are counted only when a diagnostic is built, which is
  the rule the stylesheet parser already follows: counting newlines per node
  makes reading a module with nothing wrong with it quadratic in its own length.
- **`desc` and `hidden` are lifted statically, and this is the part with no
  runtime answer.** A lazily loaded command appears in help by name alone
  because its `desc` is inside its module and reading it means importing it.
  That was rare when a `path` was hand-written; filesystem routing makes it the
  common case, so a root `--help` over a routes tree listed sixty commands by
  name alone -- which is not help. The runtime cannot fix it, and that is not a
  gap in it: not importing is the entire point of the deferral. So the build
  reads each module and bakes the answer into what it emits. A built app answers
  a question an unbundled one can only answer after a load, and that asymmetry
  is the point rather than a divergence to avoid: unbundled is the one that is
  wrong, and the `!` name prefix already exists precisely because `hidden` could
  not be seen in time.
- **`name` and `alias` are deliberately _not_ lifted.** They are the two it
  would be tempting to bake next and doing so would be a bug: they decide
  _routing_, and the runtime rule is that only the placeholder's name can match,
  because a command has to be matched before the module that renames it can be
  loaded. Baking a module's own `name` would make a command reachable bundled
  under a spelling that does not resolve unbundled, which is exactly what the
  shared route rules exist to prevent.
- **A computed value is reported, never guessed, and the severity is the
  interesting half.** `desc: greeting()` cannot be read from source, and both
  obvious answers are wrong -- inventing something, or failing the build. It is a
  **warning** with a file and a line: the command keeps the description it would
  have had unbundled, which is none until it loads, and the author is told which
  file and why. A module with no default export at all is an **error**, because
  the runtime would refuse it too and the build is merely finding out first. An
  `export { cmd as default }` is a warning rather than an error for the same
  reason read backwards: the runtime takes it, so what is wrong is what this pass
  can read rather than the module.
- **A spread is the case that looks harmless.** `export default { ...base, hidden: true }`
  may well carry a `desc` inside `base` and nothing here can see it, so an absent
  `desc` beside a spread is _reported_ rather than taken as "there is none" --
  which is the difference between a description the build missed and one nobody
  wrote.
- **It looks through the wrappers that change nothing and stops at the one that
  might not.** `command()` is documented as the identity function and exists only
  so inference reaches a nested literal; `as` and `satisfies` are type syntax that
  erases; parentheses are nothing at all. A call is unwrapped whatever it is
  _called_, because the name is the app's to choose -- imported under an alias, or
  a wrapper of the app's own -- so matching on `command` would miss the ordinary
  case. What that costs is a `withDefaults({ desc: 'a' }, ...)` whose own body
  overrides `desc`, which is a warning-free wrong answer, and it is why the unwrap
  stops at a call with exactly _one_ argument that is an object literal: a wrapper
  doing anything more interesting than passing its argument through almost always
  takes something else too.
- **A computed key is unreadable even when it holds a string.** `['desc']` and
  `[key]` are the same syntax and only one of them is readable, and a pass that
  reads the easy half of a construct it does not support is worse than one that
  skips both -- because the half it skipped is silent. A template literal with no
  substitutions _is_ read, since `` `build the app` `` is a string somebody wrote
  and refusing it would make the two spellings of one thing disagree. A
  non-boolean `hidden` is refused rather than read as truthy, because the runtime
  throws on one rather than coercing it: reading `hidden: 1` as `true` would bake
  a value the app it came from refuses to start with.
- **A package is described from its manifest rather than from its entry
  module.** That is the description the runtime uses, so taking the same one is
  what keeps the two walks agreeing. Reading its entry would mean reading
  somebody's compiled output, where a `desc` is very likely computed, to answer a
  question its `package.json` has already answered.
- **A module that does not parse throws rather than warning.** Guessing past a
  syntax error is how a build comes to report a missing description for a file
  whose real problem is a missing brace.
- **`findTemplates()` matches the tag as a _binding_, not as a spelling.** A
  template is `ui` only because something imported `ui` from
  `@ttylabs/sigil/template`, and the name at the call site is whatever the import
  called it -- `import { ui as html }` is the same tag, and a local variable
  called `ui` is not one. The binding is read off oxc's own module record, which
  answers it without a scope walk; a type-only import is skipped because it
  erases. This is the question `emit()` answers by holding the function itself,
  and getting it wrong means rewriting a stranger's template literal into calls
  it never asked for.
- **Only the outermost template is claimed.** A `ui` written inside an
  interpolation stays interpreted, which is already recorded: an expression is
  not the compiler's to read, so it is printed back verbatim and the runtime tag
  handles it there. Returning both would be worse than useless -- the outer
  template's expression source is a span of the original module, so it still
  holds the inner template's text, and splicing a compiled replacement for both
  writes the inner one twice. So the walk claims a tagged template and does not
  descend into it.
- **The walk is driven by oxc's `visitorKeys` rather than by a list of node
  types.** A hand-written list is a second copy of the grammar, and the day the
  parser grows a node this file has not heard of is the day a template inside it
  stops being found -- silently, since a template nobody found is simply not
  compiled.
- **The generated tree emits no `name`, because the key is the name.** A `name`
  beside it would be a second answer to the same question. A namespace directory
  emits no `load` at all, so nothing is ever imported for it, which keeps the
  runtime's behaviour of matching, listing and having nothing to run. And a
  `desc` the extractor could not read is simply absent, which leaves the command
  exactly where an unbundled one is.
- **A specifier is a specifier, not a path.** `relative()` answers with the
  platform's separator, and a backslash in an import specifier is an escape
  rather than a separator -- so a Windows build would emit
  `import("./commands\build.js")` and fail at run time on the machine that
  produced it. Every specifier is written with forward slashes and carries an
  explicit `./`, since a bare `commands/build.js` is a _package_ specifier to
  every resolver there is. A description is escaped with `JSON.stringify` and
  then ` `/` ` on top, because those two are line terminators to a
  JavaScript parser and JSON leaves them raw -- prose is somebody else's and may
  hold a quote, a backslash or a newline.
- **The app is discovered, not assumed, and `@ttylabs/sigil` in the manifest is
  what makes a directory one.** Asked before anything else, because every error
  after it would be a worse version of the same message -- "no `commands/`
  directory" is a poor way to say "this is not a sigil app". Any kind of
  dependency counts, since which one an app declares is a packaging decision
  and none of them makes it less of an app.
- **Source before the manifest, because `bin` usually names built output.** The
  obvious entry is `bin`, and following it means parsing a minified bundle whose
  import specifiers are chunk names a bundler invented -- `packages/cli`'s own
  `bin` points at `dist/sigil.mjs`, so the toolchain would have been unable to
  read itself. `check` reads what the author edits and what the build will
  compile, so it looks for `src/index.*` and the rest of the conventions first
  and falls back to what the manifest names only when there is none. That is a
  heuristic, so the entry it picked is **reported** in the summary rather than
  assumed, and `--entry` overrides it: a guess nobody can see is the kind that
  costs an afternoon.
- **An app's `commands` is read off its entry, and it is one of two things.** A
  path is the filesystem router, which `resolveCommandTree()` already walks; an
  object is the schema having written its commands out, which is already the
  tree. Both are read from source, because running the entry would run the app --
  the same reason a command module is parsed rather than imported.
- **The outermost object literal with a `commands` property is the schema.** A
  command may hold `commands` of its own, so everything nested inside one is a
  subcommand the walk reaches anyway. More than one _outermost_ schema in a
  module is an ambiguity this cannot resolve, and choosing by source order would
  be choosing by accident, so it says so and asks for `--commands`.
- **A `load: () => import('./check.js')` is followed to the `check.ts` beside
  it.** Not a guess: a TypeScript ES module imports its neighbour with a `.js`
  specifier while the file on disk is `.ts`, which is the convention this repo
  follows itself and is written down under Conventions. Without the swap every
  command a schema declares through `load` would come back unresolved, which is
  an `error` -- a command whose module is not there is an app that fails when
  that command is run.
- **What the placeholder declares wins, and silences the module's diagnostics.**
  The runtime's merge read from the other side: a `desc` on the placeholder is
  what help shows before the module loads, so a module that cannot be read
  statically is not a problem anybody has. Found by dogfooding --
  `src/commands/check.ts` ends `export default check`, a _reference_ rather than
  a literal, because `--isolatedDeclarations` refuses to infer a default export
  -- and the warning it produced claimed "help will list this command by name
  alone", which was simply false. An `error` still comes through, because a
  module with no default export at all is unusable however well it is described.
- **A schema that names commands this cannot read is reported once.** The first
  version said it twice -- a warning that `commands` was computed, then an error
  that no `commands` was found -- and the second was wrong, since it had been
  found and not read. `readAppCommands()` answers `found` separately from
  `commands` so the caller can tell "there is none" from "there is one I cannot
  read".

- **`build` type-checks, and SIG-73 leaned the other way.** The ticket asked
  "does `build` type-check, or is that the app's own `tsc`? Delegating is
  simpler and faster", and the answer is that it checks: an app that builds and
  then fails its own `tsc` has been told it is fine by the tool whose job is to
  say so, and simpler-and-faster does not buy that back. A type error is
  **fatal**, because "it type-checks" has to mean the build stops -- a warning
  nobody reads is the same as not checking. It is a gate rather than a pass that
  produces anything: nothing here emits, since Node strips types on its own and
  the bundler handles the rest.
- **It checks with the _app's_ compiler and the _app's_ config, both resolved
  from the app.** `typescript` is an **optional peer dependency** rather than a
  dependency, so the build never brings one of its own. A bundled TypeScript
  would check the app with a compiler the app never chose, and a version skew in
  a type checker is not a small disagreement -- it is new errors on code that
  was fine, or silence on code that is not, with the editor and CI saying the
  opposite. The `tsconfig.json` is looked for in the app's root and **nowhere
  above it**, which is where this deliberately parts company with `tsc`: walking
  up finds a monorepo's own config, whose `include` describes a different
  program, so the build would report errors about files the app does not contain
  and miss the ones it does.
- **It runs the CLI rather than the programmatic API, and that is a version
  decision rather than laziness.** TypeScript 7 is the native port: its root
  export is a version string, `createProgram` is gone, and the replacement lives
  under `typescript/unstable/` and says so in the specifier. TypeScript 5 and 6
  have the old API and not the new one. Supporting an app on any of the three
  through the API means two adapters, one written against a surface that has
  announced it will move. `tsc --noEmit --pretty false` is the one interface all
  three have, it has not changed in a decade, and it is the same command the
  app's own `type-check` script runs -- so the build agrees with CI by
  construction rather than by coincidence. Spawning is the **build's** to do and
  the one-process rule is about the **output**: nothing `sigil build` emits may
  spawn anything, and a compiler invoking a compiler is ordinary. It is invoked
  as `node <bin/tsc>` rather than executed, because that file is a Node script
  behind a shebang and a shebang is not how anything starts on Windows.
- **Nothing to check is not a failure, and a check that did not happen is.** An
  app with no `tsconfig.json` is a JavaScript app and is skipped with a reason;
  an app with one but no resolvable `typescript` is skipped with a different
  reason that says what to install. What is _not_ tolerated is a compiler that
  exited non-zero without saying anything parseable -- a `composite` project
  that cannot be told `--noEmit`, an option it does not know -- because
  swallowing that reports a clean type-check for a check that never ran. The raw
  output becomes the diagnostic instead.
- **One diagnostic shape across every pass, in `diagnostic.ts`.** The static
  lift, the type check and whatever bundling turns up are reported together, so
  there is one reporter and one `isFatal()` rather than a second vocabulary --
  which is how two halves of one build come to disagree about whether something
  was fatal. The type checker's paths are made absolute on the way in, because
  it is run with the app as its cwd and writes relative ones, and a report
  holding both spellings is one nobody can sort.
- **The type-check fixtures are excluded from the package's own tsconfig.**
  `test/fixtures/typecheck/broken/` holds a deliberate type error, and a suite
  that fails on its own fixture is a suite nobody can run. Same exclusion the JSX
  template fixture already needs, for the same reason.

- **rolldown is a devDependency of the app, and what the build produces still
  depends on nothing.** Three dependency questions that are easy to conflate and
  are not the same: `@ttylabs/sigil` has none and that stays a hard constraint;
  `@ttylabs/cli` is a devDependency of an app, like `tsc`, so it may take a
  bundler and a parser; and the _output_ is the app plus sigil's runtime inlined,
  which depends on nothing because sigil has nothing to bring and a bundler is a
  compiler rather than a runtime -- nothing it emits imports it. rolldown rather
  than rollup because tsdown already builds this repo with it, so there is one
  bundler and not two, and because it embeds the same oxc the extraction pass
  reads. `the toolchain's dependencies` in `packages/cli/test/cli.test.ts` writes
  them out rather than counting them, so taking a new one is an edit somebody
  makes on purpose.
- **The toolchain runs from its own source, and that is a different thing from
  building itself.** `node packages/cli/src/sigil.ts build ...` works with no
  build step, which is the dev loop the acceptance test wants -- edit a pass,
  run it against a fixture, see the bundle. What it does _not_ do is make
  `@ttylabs/cli` self-buildable, and the two got conflated once: `sigil build`
  can never produce a standalone bundle of it, because `oxc-parser` and
  `rolldown` are **native `.node` binaries** and no bundler inlines those. The
  published bin imports them externally and npm installs them, which is correct
  and is why the toolchain is a devDependency rather than a bundled artifact. A
  zero-dependency bundle is a promise about _apps_, and an app with a native
  dependency is the one kind that cannot have one.
- **Running from source costs the angle-bracket type assertion.** `<Error>e` is
  ambiguous with JSX, so Node's stripper refuses it outright rather than
  guessing -- `(e as Error)` is the spelling that survives. That is the same
  rule already recorded for a command module, where an `enum` or a namespace
  with a runtime body is Node's limit rather than this package's, met from the
  inside for the first time.

- **`sigil build` generates the executable rather than looking for one, which
  is the Next.js answer.** Next never hunts for your entry, because you do not
  write one: routes are a directory convention, config is found by filename, and
  the framework supplies the server -- `output: 'standalone'` literally
  _generates_ `server.js`. The same applies here. A sigil bin is a shebang, an
  import and a call to `main()`; nobody should have to write it, and a build
  that goes looking can pick the wrong file. That is not hypothetical: this
  package's own `bin` names `dist/sigil.mjs`, so a build that followed the
  manifest would have parsed its own minified output.
- **The generated entry composes rather than transforms.** It imports the app's
  schema module and spreads it, then passes `commands` over the top -- so there
  is no source rewriting anywhere, and everything the app said about its name,
  options and hooks survives untouched. `commands` is the one property the build
  knows better than the app does. A schema export may be a function, because a
  schema that reads the environment has to be built rather than declared, and it
  is called exactly where the app would have called it.
- **The namespace is spread before it is read.** `app.default ?? app.schema` is
  a _static_ reference to a named export the module need not have, and a bundler
  resolves that at build time -- rolldown warns that it will always be
  undefined. `{ ...app }` asks at run time, which is when the answer is known.
- **An import the bundler cannot resolve is an error, not a warning.** Left
  alone it becomes an _external_, so the bundle reaches for it at run time and
  the zero-dependency promise is broken with nobody told. Found immediately: a
  fixture app with no real `node_modules` built "successfully" while importing
  `@ttylabs/sigil` at run time.
- **A command per chunk, because the deferral is the point.** A literal
  specifier inside a dynamic import is the one thing a bundler can see, follow
  and split on, so `load: () => import('./commands/build.js')` becomes a chunk
  and rolldown rewrites the specifier. Measured on the fixture app: a 3.2 kB
  entry with the parser, the help renderer and every command body in chunks of
  their own. Flattening to one file would undo the whole reason the tree is
  lazy.
- **`--bin` is refused beside a filesystem command directory.** An executable of
  the app's own is bundled as it stands, so whatever `commands` it declares is
  what it gets -- and a router bundled that way reads directories that are not
  beside the executable. A run-time failure the build can see coming is a build
  error.
- **The zero-dependency claim is asserted by parsing the output, not by grepping
  it.** The naive pattern matched `Error(\`...command name from "${e}"\`)`-- the
word "from" inside a message followed by a quoted template -- and a test that
reports a dependency an app does not have is worse than no test. The module
record also tells a *computed* dynamic import from a literal one, which
matters:`import(pathToFileURL(path).href)` survives into every bundle from
  the runtime's own path loader, and it is code choosing a module rather than a
  package the app must have installed.
- **A bundled app cannot read files relative to `import.meta.url`, and that is
  the app's problem rather than the build's.** Found by building this toolchain
  with itself: `version()` reads `../package.json` off its own module URL, which
  points somewhere else once the bundle is written to another directory. Every
  bundler has this property. It is deliberately _not_ warned about, because the
  pattern is also how an app correctly locates something it ships alongside, and
  a warning that fires on correct code teaches people to ignore warnings. It is
  also not a thing to fix here: the toolchain is not a bundleable app at all,
  for the native-binary reason above, and its own bin is built by tsdown into
  `dist/`, where `../package.json` resolves exactly as that function's comment
  says it does.
- **`_inspect.ts` is one pass for two commands, and the `_` prefix is this
  repo's own rule read from the inside.** `check` is that pass and a report;
  `build` is that pass, the same report, and a bundle. Two implementations that
  agree for now is how the fast one stops meaning anything. Nothing walks
  `src/commands/` today, but it will once the CLI routes itself, and a helper
  that quietly became a command called `_inspect` is the footgun the prefix was
  invented for.

- **`sigil check` and `sigil build` are both wired, and both are the whole of
  what they claim.** `packages/cli/src/index.ts` records
  that a command which exists and refuses is worse than one that does not exist
  yet, because only the second is honest in `--help` -- so a `build` that cannot
  bundle would be exactly the thing that comment was written against. What the
  read passes add up to on their own is a **complete** `check`, which is what
  `tsc --noEmit` and `astro check` are -- and it stayed that once bundling
  landed rather than being absorbed: `build` runs the same pass through
  `_inspect.ts`, so a failure in one is a failure in the other and the two
  cannot come to disagree about what a valid app is. `build` refuses an app that
  does not check out, because finding out at run time what a compiler knew at
  build time is the thing a build is for.
- **The CLI declares its own `check` the way `sigil build` generates an app's
  commands: a `desc` on the placeholder and a `load` beside it.** Dogfooding,
  and it pays immediately -- the module behind it imports `oxc-parser`, which is
  a native binary, so leaving it on the startup path would make
  `sigil --version` load a parser it never uses. The `desc` sits on the
  placeholder so `sigil --help` can describe the command without any of that,
  which is the static `desc` lift solving its own author's problem.
- **A tree that cannot exist is a diagnostic, not a stack.** Two routes claiming
  one name, or a `commands/` that is really a package, throw out of
  `resolveCommandTree()` -- which is right for a library and wrong for a
  command, where it would take the process down with a trace. `check` catches
  and reports, so every way an app can be wrong arrives through one channel.
- **`--tree` goes to stdout and the diagnostics go to stderr.** The tree is data
  somebody asked for and can be piped; the problems are not, and piping the tree
  must not lose them. It is printed with the framework's own `table()`, which is
  the acceptance test working as intended -- a framework whose toolchain is not
  written in it has not been tested by anyone who had to live with it -- and it
  gets the column arithmetic right for free.
- **A command loaded from a module annotates its export `AnyCommand`.**
  `--isolatedDeclarations` refuses to infer a default export, and `Command` is
  the wrong annotation for the reason that type exists: a command whose `run`
  takes a narrow `argv` is not assignable to one whose `run` takes the wide
  default, because a function parameter is contravariant. Nothing is lost by
  annotating, since `command()` has already typed the literal's own `run` and a
  module-loaded command is one the schema above could not have inferred into
  anyway.

- **The end-to-end test writes the tree out, imports it, and parses against
  it.** Everything else in `test/build/` reads source or prints it; `a generated
tree at run time` is the only place that asserts what the output _does_, which
  is the claim the whole thing rests on -- a generated tree routes the way the
  directory it came from did, and help has every description without importing
  anything. It asserts that last part by reading `loaded` back off every
  registered command, because "the description is right" and "nothing was
  imported to learn it" are two claims and only the second one is the feature.

### The built-in components

- **They are element trees, and the imperative API is a facade over them.**
  `createSpinner()`, `createProgress()`, `table()` and the four prompts still
  return what they always returned, because not every CLI wants a component tree:
  a build script showing one spinner should not mount a renderer by hand, and the
  existing tests are the regression suite for the rewrite. What is behind them is
  `mountLive()` -- a renderer over an inline canvas, the framework stylesheet, a
  way to write a line above the frame, and two ways to finish. The state each one
  is driven by and the tree each one builds are exported beside the facade, so a
  component tree can use them directly.
- **What the rewrite deleted.** The spinner's `setInterval` is an effect with a
  cleanup, which is where a `steps()` keyframe animation goes when there is one.
  Each prompt's raw-mode handling, `data` listener, decoder, held tail and escape
  timer are the one input router's. The prompts' frame assembly and cursor
  arithmetic are layout. `padCell()` is a declared width and `text-align`, and
  `truncateCell()` is `text-overflow` -- both gone, with `truncate()` in
  `@ttylabs/sigil/wrap` as the one implementation of cutting a line.
- **Whether there is a terminal is settled at the mount and handed to the
  component, because it changes what is drawn rather than only how.** A spinner
  in a CI log has no frames to animate, so it draws none and starts no timer;
  a progress bar has no bar, so it draws a percentage rounded to `step`. The
  backend then writes the frame once per change rather than once per tick, which
  is the live region's rule reached through the canvas instead of through a
  second code path -- and the piped output is byte for byte what it was.
- **A spinner mounts on `start()` and a progress bar mounts on construction**,
  which is what each has always meant: a renderer paints its first frame as it is
  built, so mounting eagerly would put a spinner on screen that nobody started.
  `succeed()` on a spinner nobody started still mounts, because leaving its line
  is what `region.done(final)` always did.
- **A frame that ends up in a log is as wide as what it drew.** A canvas paints
  every cell it owns, so one the width of the screen ends each row with blanks out
  to the margin -- invisible on screen, and trailing whitespace in the scrollback
  once the frame is left behind. `render({ width: 'auto' })` follows the content
  instead, and `mountLive()` asks for it. The default stays the terminal's width,
  because the two costs are not the same: a canvas taller than its content
  reserves rows of screen nothing is using, which is always wrong inline, while
  one as wide as the screen merely writes blanks, which is what an app drawing a
  panel wants.
- **A component's own clock says when the state changes and the frame loop says
  when that reaches the screen.** A spinner tick is a signal write, so the frame
  it asks for is paced with everything else rather than painted from inside a
  timer. The visible consequence is up to one frame's latency on a tick, which at
  eighty milliseconds against thirty frames a second is nothing; the invisible one
  is that a test has to advance both clocks, which is why `frameMs` is an option.
- **A table's column widths are worked out and the rest is the box model.** A
  shared column width across rows is the one thing flexbox cannot do for itself:
  each row would size its own cells and no two rows would agree. So the widths are
  measured and declared, and the padding, the alignment and the truncation are
  properties.
- **A text prompt's field scrolls sideways rather than wrapping.** A canvas is a
  fixed number of columns and a field that runs past the edge is clipped there,
  where the live region wrote the string whole and let the terminal wrap it. A
  wrapped field cannot work here for a reason worth writing down: there is no
  inline layout, so the three pieces the caret splits the value into are three
  flex items, and a wrapped first item leaves the other two beside its _box_
  rather than after its last line. Scrolling is what readline does and it keeps
  the caret on screen, which wrapping in a fixed grid would not.
- **A spinner that settled or was stopped is mounted again when it is started.**
  A disposed renderer paints nothing ever again, so keeping the handle made
  `start()` after `succeed()` a call that set `spinning` to true and changed the
  screen not at all. The signals live on, so the label survives; what is rebuilt
  is the canvas and the tree.
- **A progress bar says it finished whatever `step` divides into.** Stepping the
  percentage down is what makes consecutive frames identical, and with `step: 30`
  it also made the last line `90%` -- a log whose last word is 90% is one the
  reader cannot tell from a build that stopped there.
- **A prompt's head says how it divides its row.** The same piece of arithmetic
  the help template kept, for the same reason: a row's intrinsic height is taken
  with every child offered the whole content box and placed with each given a
  share, so a question measured at the full width and placed in a share of it came
  out one line tall -- and a choice list was drawn over the rest of the question.
  The message is given a declared width, which is measured at the width it will be
  placed at, and one column is kept back so that a question as long as the
  terminal still leaves somewhere for the caret to be. How many rows that comes to
  is worked out in the same place and through the same wrapper the text draws
  with, so the width and the height cannot disagree about it -- and that is what
  the list below subtracts, rather than assuming the question is one line.
- **A choice list longer than the screen shows a window of itself.** A canvas is
  a fixed number of rows and what does not fit is clipped, where the live region
  wrote every line and let the terminal scroll -- which was broken in its own way,
  since the repaint then walked the cursor up into the log. The window follows the
  highlight and is recomputed from it, so there is no scroll state to keep in
  agreement: the only thing that has to be true is that the active row is on
  screen.
- **A bracketed paste reaches a text prompt as text, with its line breaks
  flattened.** Obeying one is what makes a paste submit half an address, which is
  the whole reason a terminal brackets a paste. The other prompts register no
  paste handler, so a pasted block is typed in as keys -- which is what a terminal
  that cannot bracket one sends anyway, and what a `y` pasted into a confirm
  should mean.

### Prompts and keys

- **A text prompt inserts the key that named itself, and it moves over grapheme
  clusters.** A real character decodes with its `name` and its `sequence` the
  same string, while a named key's name is one the terminal never sent -- `up`
  for `ESC [ A`, `tab` for a `\t`, `unknown` for the bracketed paste marker. The
  test used to be whether the _name_ had a display width, which is true of every
  one of them, so Up typed `up` and Escape typed `escape`; it was false of a
  combining mark, so an NFD paste of `café` arrived as `cafe`. What is inserted
  is the sequence rather than the name, so the two can never disagree, and a C1
  control is refused there because `decodeKeys()` already names every C0 one as
  Enter, Tab, Backspace, or Ctrl with a letter. The cursor is an offset into the
  value rather than an index into its clusters -- inserting and slicing stay
  ordinary string work -- and it only ever lands on a boundary `graphemes()`
  agrees with: `cursor ± 1` walks UTF-16 code units, so a backspace over an emoji
  left its high surrogate in the value and every edit after it worked on a string
  no terminal can draw. An insertion is the one edit that does not move by whole
  clusters, because what was typed can join the cluster after the cursor -- a
  letter typed in front of a lone combining mark makes one cluster of the two --
  so it snaps forward to the end of what it landed inside. The table's
  `truncateCell()` already read text by cluster and the prompt was the one place
  that did not, which is still the split now that `truncate()` has replaced it.
  See `test/components/prompt.test.ts`.
- **The caret is painted into the frame; the terminal's own cursor is not
  moved.** Left, Right, Home and End moved an index nothing drew, so nothing on
  screen changed until the next character was typed and landed somewhere
  surprising. The alternative was to show the cursor for a prompt -- a live
  region hides it, which is right for a spinner -- and walk it to
  `stringWidth(value.slice(0, cursor))`, and it costs the region the one
  invariant its repaint math rests on: that the cursor is where the last frame
  it wrote ended. Every path that erases would have to walk up from wherever the
  caret was left instead, and `done()`, `write()`, `clear()` and eviction would
  each have to agree about it -- a second invariant carried by the whole region
  for one component's benefit. A caret that is part of the frame also needs no
  putting back: a region that is cleared, evicted, or resized owes the terminal
  nothing, and a value wider than the screen wraps with the caret already in the
  right place rather than needing a scrolled view and a column to put it in. It
  is reverse video over a whole grapheme cluster, so a wide character is marked
  across both its columns; past the last character there is nothing to mark, so
  the caret is a column of its own. A styler at level 0 therefore draws no
  caret, which is deliberate: the same setting takes the cyan `?`, the bold
  message, and the dimmed placeholder with it, and a prompt asked for plain text
  gets plain text rather than the one sequence the library decided was too
  important to turn off.
- **A mask is applied per piece of the value, not to the whole of it.** It is a
  column count rather than a substitution -- a two-column emoji is two bullets --
  and masking the value in one go leaves nowhere to put the caret. The pieces are
  split on cluster boundaries and a width is the sum of its parts, so what is
  drawn is the same text it always was, with the bullets standing for the
  character under the caret reversed. Which is why the caret covers two of them
  for an emoji and one for a letter, and why a `mask` wider than one column still
  lines up with itself.
- **`decodeKeys()` is a pure reading of one chunk, and the waiting belongs to
  whatever feeds it.** A terminal sends Alt-x as `ESC x` and Up as `ESC [ A`,
  both in one write, so decoding per chunk is right until the read splits --
  which ssh, a pty under load, and a small read buffer all do. Split, `ESC [`
  and `A` decode as an unknown sequence and a literal `A`, and the `A` is what a
  text prompt puts in somebody's answer: silent corruption, and the reason this
  was worth a timer in the input path rather than a line in this file saying it
  was not. `pendingLength()` says how much of a chunk's tail could still be the
  start of a longer key, measured by the same reader `decodeKeys()` uses so the
  two can never disagree about where the last key starts -- searching for the
  last `ESC` instead finds one inside a sequence that had already finished.
  `run()` holds that tail, joins it to the next chunk, and flushes it after
  `ESCAPE_TIMEOUT` of silence, which is what makes a lone Escape a key rather
  than a wait with no end: nothing follows it, so nothing can complete it. The
  split is made where the chunk arrives rather than inside the queued work,
  because the queue is one chunk at a time and a second chunk landing while the
  first is still being handled would be joined to the same stale remainder.
  Fifty milliseconds because the two failures are not symmetric: too short types
  a stray character into an answer, too long makes Escape feel late. See
  `test/components/keys.test.ts` and `test/components/prompt.test.ts`.
- **A CSI ends on a byte in 0x40-0x7e, and a byte that is neither that nor a
  parameter has ended it.** Anything at all was taken as the terminator, so a
  key pressed while a sequence was still arriving was eaten by it: `ESC [` then
  Ctrl-C was one unknown sequence and a prompt that could not be escaped, and
  `ESC [` then `ESC [ A` stopped at the second ESC and left `[A` to be typed
  into the answer two characters at a time. Holding a half-arrived sequence is
  what made that worth fixing rather than noting -- it widens the window from
  "the same read" to "the same read or the next fifty milliseconds", and Ctrl-C
  is the key most likely to be pressed in it. The sequence now stops in front of
  such a byte and the byte is read as the key it is. The parameters widened to
  ECMA-48's 0x30-0x3f at the same time, because only `[\d;]` was read: the `<`
  a mouse report leads with was taken for the terminator, and `0;1;1M` was typed
  a character at a time after it.

### Signals

- **The read is recorded after the refresh, not before.** `Computed.get()`
  refreshes and then calls `track()`, because what a consumer records is the
  producer's _version_ and a computed being read for the first time is about to
  change it. Recording first stored a version the producer had already left
  behind, so the dependent re-ran once spuriously after every first read -- the
  cache off by one rather than exact. It looks like an ordering
  nicety and it is the difference between caching and not. Pinned by "should not
  re-run a dependent when its own value did not change" in
  `test/signals/signals.test.ts`.
- **`watched` and `unwatched` are about being observed, not about being read.**
  A signal read only by a computed that nothing watches is not live and its
  `watched` never fires. Liveness is counted and propagates transitively through
  computeds, which is more work than firing on the first reader -- and it is the
  only version that makes the callbacks usable for what they are for:
  subscribing to something external for exactly as long as something is
  rendering. Firing on any reader would subscribe on behalf of a computed that
  nobody will ever read again.
- **A recompute sweeps its old dependencies afterwards rather than clearing them
  first.** Clearing up front is simpler and makes a source that is read both
  before and after lose its last live sink and immediately regain it, firing
  `unwatched` then `watched` for a dependency that never went away. Anything
  that subscribes in those callbacks would tear down and rebuild a subscription
  on every recompute.
- **A `Computed` that writes, that reads itself, or a `Watcher` callback that
  touches the graph all throw.** Each makes the result depend on evaluation
  order, and laziness is precisely what makes evaluation order unpredictable --
  the same program gives different answers depending on who read what first.
  Merely discouraging them means the bug surfaces later, somewhere else.
- **An effect may write a signal; a `Computed` still may not.** Reacting to a
  change by setting something else is most of what an effect is _for_ -- focus
  moving, a resize landing on a width, a dirty bit going up -- and banning it
  would have made the whole layer useless to the renderer. The ban on a
  _derivation_ writing stands, because a derivation has an answer and a write
  makes that answer depend on evaluation order. An effect has no answer. An
  effect body is a `Computed` carrying an internal `effectBody` marker, which is
  the only thing that lifts the ban.
- **A flush drains until nothing is dirty, not once.** It follows from the
  above: an effect that writes can dirty an effect that already ran this pass,
  and stopping after one pass would leave that one a frame behind. The watcher is
  re-armed _before_ each pass, so a write made during one schedules the next.
  There is a bound, because two effects each writing what the other reads would
  otherwise spin forever with nothing said about which two. The bound stops the
  drain and only the drain; the entry below is what stops the scheduler.
- **A flush that gave up re-arms silently, and the flush it had already asked
  for does nothing.** The bound leaves the cycling effects dirty, which is
  correct, and a bare `watch()` re-arm announces whatever is dirty, which is
  also correct -- and together they are a livelock. The give-up announced the
  cycle, the announcement scheduled a flush, that flush gave up and announced it
  again: `Effects did not settle` once per microtask with the event loop never
  idling, and under a synchronous scheduler an unbounded recursion out of the
  `set()` that started it, because `flushing` is back to `false` by the time the
  `finally` re-arms. So `Watcher.rearm()` arms without looking, and a `stalled`
  latch -- set by a drain that gave up, cleared by the next notification --
  makes the flush that the failed drain's own writes already asked for a no-op.
  Armed is not deaf: a later clean-to-dirty transition anywhere in the scope is
  still heard, and the first thing the next drain does is `getPending()`, so the
  effects left dirty are retried by it. The one thing that changes what a drain
  would do and announces nothing is a _disposal_ -- which is how a caller breaks
  a cycle -- so disposing while stalled takes the latch off and announces what is
  still pending. Without that, an effect the give-up left dirty swallows every
  later write to it, since propagation stops at a node already dirty, and the
  flush that would have caught it is the one the latch refuses. A disposal made
  from _inside_ the drain that gave up -- by an effect body, or by an error
  handler that shuts the cycle down -- counts too, and telling it from the
  scope's own churn is what took two attempts. A cycling drain disposes effects
  all by itself, because an effect re-running tears its children down first, so
  "something was disposed while draining" fires on every pass of a drain going
  nowhere and cannot, by counting, tell breaking the cycle from the cycle
  running -- three ways of counting were tried and each was the storm again one
  level slower. The question is not how many but _who_: the machinery knows
  exactly which disposals are its own, because it is the one making them, so
  `teardown` brackets `runCleanups()` and a disposal raised inside it is not
  evidence of anything. What is left is a disposal the caller made, which is the
  one thing that changes what the next drain would do and announces nothing of
  its own. It clears the latch for exactly one retry: if the cycle really was
  broken the retry settles, and if it was not, the next give-up latches again
  with no new disposal to clear it. An
  effect dirty for an
  innocent reason during a failed settle is not stranded by it -- every pass
  runs everything pending, so it ran a hundred times -- and a `flush()` the
  _caller_ asked for is never refused, since breaking the cycle by disposing an
  effect announces nothing and that call is how they find out it worked. The
  error rate settles at once per failed settle rather than once per `set()`: a
  burst of writes is already coalesced into one flush, and the report belongs to
  the flush that could not settle. A drain whose error handler _threw_ takes the
  same exit, which is the same failure one level up -- announcing work whose
  report throws asks for that throw forever. See `test/signals/effect.test.ts`.
- **The bound counts work passes, not loop iterations.** The check for "anything
  left?" happens at the _start_ of a pass, so the last pass's own work was never
  looked at: a chain needing exactly `MAX_PASSES` passes did all of it, settled,
  and was reported as a cycle anyway -- with the right values sitting there
  already computed. Ninety-nine was clean, a hundred was a lie, a hundred and one
  was the truth. A false "did not settle" is a lie of exactly the kind that
  erodes trust in the true one, so the loop asks once more before it reports.
- **A flush refuses to drain into a run that has not finished.** An effect body
  may write, and a synchronous scheduler flushes that write where it happens --
  which during an effect's _first_ run is from inside the `get()` that is running
  it. The drain then reached that very computed and asked it for the value it was
  in the middle of producing: `A Computed may not read itself`, once per pass, a
  hundred times, on top of the one report a cycle actually deserves. The
  `flushing` guard never covered it, because an initial run is not part of any
  drain. `bodies` is counted across the whole run rather than around the body
  alone -- the body returning is not the run finishing, and the commit and the
  dependency sweep come after it -- and the refused flush is asked for again on
  the way out, since clearing `queued` had left nothing else to ask. Nested
  creation unwinds to the outermost run first, which is why it is a count rather
  than a flag.
- **A cycle between two scopes is bounded by the chain, since `MAX_PASSES`
  cannot see it.** The pass bound is per scope by construction: two scopes
  writing what the other reads settle in a pass or two each, announce the other's
  work on the way out, and neither ever reaches its own bound -- so it spun
  forever reporting nothing at all, which is the failure the bound exists to
  prevent one level up. A flush asked for while any scope was already flushing is
  _chained_, counted across scopes, and a hundred and one of them in a row is
  reported and stalled the same way an in-scope cycle is. Recorded when the flush
  is queued rather than when it runs, because a microtask flush runs after the one
  that scheduled it has finished and by then there is nothing left to ask. A flush
  nobody was mid-flush for starts the count again, so ordinary reactivity never
  approaches it. Worth knowing that the synchronous spelling of this cycle damps
  itself out instead: each write lands on a run further up the stack that has not
  committed, and a notification to a computed that is mid-run is swallowed by its
  own commit.
- **An error in an effect is reported, never rethrown.** Under the default
  microtask scheduler a rethrow lands in a microtask nobody catches: Node prints
  a raw stack and kills the process, skipping `main()`'s error handling, the
  `beforeError` hooks, and any chance of putting the terminal back -- the exact
  opposite of the rule that a CLI shows a message and not a stack. Errors go to
  `setErrorHandler()`, whose default writes the message and sets the exit code,
  and which the renderer replaces with the real handler. The watcher is re-armed
  either way: one bad effect silently ending all future reactivity is worse than
  a loud failure.
- **A `flush()` run from inside a notify callback is allowed; a read from the
  callback itself is not.** A scheduler may run its flush synchronously, which is
  what a frame loop driving its own timing does. That is only compatible with the
  callback's ban on touching the graph because the flush is the work the callback
  _scheduled_ rather than the callback -- which is what `outsideNotify()` marks.
  Without it a synchronous scheduler threw out of the `set()` that triggered it
  and left the watcher disarmed for the life of the process.
- **An effect created inside another effect's body dies with it.** Otherwise a
  component that creates an effect while rendering leaks one per render, and
  nothing above can see them to clean up. The initial run is `untrack`ed for the
  same reason: without it the child registers as a dependency of the parent.
- **`Computed.dispose()` exists and the proposal has no such thing.** Garbage
  collection would be enough if the edges pointed the other way, but a source
  holds its sinks in a `Set`, so a long-lived signal keeps every computed that
  ever read it reachable. An effect that is disposed has to say so.
- **An effect that returns a promise throws; any other non-cleanup return is
  ignored.** A promise stored as the cleanup is called on the _next_ run and
  fails with "previous is not a function", one run later and nowhere near the
  mistake -- and tracking stopped at the first `await` anyway. Everything else is
  let through, because `effect(() => a.set(b.get()))` is the spelling worth
  encouraging and a concise arrow body returns whatever its last call did.
- **A recompute marks its sources rather than swapping the map.** `sources`
  stays whole for the whole run -- the old set plus whatever has been read so
  far -- and is swept at the end against a per-run `seen` set. Swapping in an
  empty map is the obvious implementation and it breaks liveness: `incLive` and
  `decLive` walk `producerSources()`, so anything that changes a computed's
  liveness _while it is evaluating_ -- an effect disposing itself, a watcher
  added from inside a body -- walks a half-built set and leaves the counts
  wrong. It surfaces much later, as an `unwatched` that never fires or one that
  fires while something is still watching.
- **A recompute commits its value before it sweeps, and a sweep that throws
  leaves the computed dirty.** The sweep is the half of `#run()` that runs user
  code again -- dropping a source fires its `unwatched` -- and it used to run
  from inside the `finally`, which had already set the state to `CLEAN` and had
  not yet written `#value`. So a callback that threw escaped the caller once and
  then every read after it handed back the value from _before_ the recompute,
  clean, with nothing left to say the run had happened: a `get()` that throws is
  a bad frame, a `get()` that quietly answers last frame's value forever is a
  bug nobody can see. Each edge is now removed on its own, so one throwing
  callback does not leave the sources after it in the walk still holding an edge,
  and the errors are raised together the way `State.set()` raises a watcher's.
  `dispose()` had the identical shape and the identical fix: a throw there took
  the rest of the release with it and skipped `sources.clear()`, so the computed
  stayed reachable from every source after the first -- the leak `dispose()`
  exists to close. See `test/signals/signals.test.ts`.
- **The dirty-after-a-failed-sweep rule is a derivation's, and an effect body is
  exempt.** A derivation is a pure function of what it read, so the retry costs a
  recomputation and buys a cache nobody has to trust. An effect body has already
  run and already written whatever it writes, and a flush reads anything not
  `CLEAN` as still pending -- so marking one dirty ran it a second time in the
  same flush and turned one write to a counter into two. The re-run is the
  observable thing there rather than the price of being careful. See
  `test/signals/effect.test.ts`.
- **A liveness walk happens before its callback, not after.** A `watched` or
  `unwatched` that throws then leaves the counts consistent and only its own
  error escapes. The other order skips the walk entirely and strands every
  source one short, after which no later watcher can make them live again.
- **A bare `watch()` re-arm looks for what went stale while it was disarmed.** A
  watcher is only told about a node going from clean to dirty, and propagation
  stops at a node already dirty -- so a computed left dirty across a re-arm is
  never announced again: the next write walks into it, finds it dirty, stops,
  and the watcher waits forever. Only a _bare_ re-arm checks; a computed is
  dirty from construction, so checking while signals are being added would
  announce every newly watched computed as a change. A holder that _gave up_
  wants the opposite and calls `rearm()`, which is the entry above.
- **A cleanup that throws on a re-run is reported, not rethrown.** Letting it
  escape the effect body before `fn()` has read anything makes the sweep drop
  every dependency, leaving the effect alive, watched, and deaf to the signals
  it was watching -- a cleanup failing should not silently unsubscribe the effect
  from the world. At `dispose()` it does throw, because there the caller asked.
- **Replacing a scheduler hands it any flush the old one was given.** A
  scheduler that was asked and is then thrown away without running takes the
  pending work with it, which reads as reactivity having stopped.
- **A source dropped in the same run that the computed gains a watcher fires
  `watched` and then `unwatched`.** Known and left alone: the counts end
  correct, and avoiding the transient means deferring every liveness change to
  the end of a run, which is a larger redesign than the flicker is worth.
- **An unwatched `Computed` that is dropped is not collected.** Edges are strong
  and bidirectional, so a long-lived `State` keeps every computed that ever read
  it reachable through its sink set. The proposal solves this with generation
  numbers; we have `Computed.dispose()` instead, and `effect()` calls it. A bare
  `new Signal.Computed()` that is read once and dropped leaks its edge until the
  source dies. Known, and it matters most in exactly this project's target -- a
  long-running TUI -- so it gets revisited if a real graph ever grows large
  enough to notice.
- **Effects come in scopes, and the module-level ones are a default scope.**
  `createEffects()` gives an independent watcher, scheduler, queue, and error
  handler. One global scheduler is a trap the moment there is more than one thing
  driving frames -- two canvases with different loops, a library using sigil
  inside a host that also does, or two tests in one file where the first leaves a
  scheduler that never ran and the second is dead before it starts.
- **Coalescing is about how many times an effect runs, not whether it runs.** A
  signal written to `1` and back to `0` before the flush still re-runs its
  effects, once, with the value it settled on. Nothing records what a signal held
  before a burst, and both writes were real changes when they happened.

### Debug logging

- **A `DEBUG` namespace is a literal with one wildcard, and a pattern that will
  not compile turns logging off rather than the library.** Every token is
  escaped except `*`, which becomes `.*?`. Nothing was escaped before, so
  `DEBUG='('` threw a `SyntaxError` out of `enable()` -- which runs at module
  load, behind every entry point there is -- and the import died before `main()`
  existed to render it as a message, while the quieter half of it had
  `DEBUG='sigil.updates'` matching `sigilXupdates` too. The `new RegExp` calls
  are wrapped anyway, because escaping is a claim about a grammar and the cost
  of being wrong about that one is a library nobody can import; `metaRE` is
  declared above the call that reads it for the same reason, since a `const`
  further down the file is in its temporal dead zone at load and that is the
  identical dead import with a `ReferenceError` on it.
- **A pattern that names nothing leaves logging off.** `,,`, whitespace, and a
  lone `-` all reach the token loop and add neither an allowed namespace nor an
  excluded one, and they used to fall through to the `/./` that means
  "everything the exclusions left" -- so a `DEBUG` naming nothing at all turned
  every logger in the process on. Covered by `test/debug/debug.test.ts`.

### Help

- **`--help` and a `help` command are added to the root, and only where the app
  left room.** Options resolve across the whole context chain, so one `--help`
  on the root answers everywhere. Nothing is added over the top of a
  declaration: an app whose `-h` means `--host` keeps it and gets `--help`
  without the short form, and an app that declares `--help` itself gets neither
  the flag nor the short-circuit, because it owns what `--help` means.
  `schema.help: false` adds nothing at all. See `test/help/wiring.test.ts`.
- **The help flag's value never reaches `argv`.** A flag always has a value, so
  an added `--help` would put `help: false` on every app's parsed values. The
  option is marked `parserOwned` and is skipped by both fallback passes and by
  the write in `processArgs()`. An app that declares `--help` itself owns the
  value, and that one does reach `argv`.
- **Help wins over a missing required option or argument, and nothing else.**
  `parse()` detects the request after walking argv and before validating, so
  `mycli build --help` answers what `build` needs instead of complaining that it
  was not given. An _invalid_ value still throws: it failed on the way in, while
  argv was being read, and there was never a question to answer.
- **`--help` with no command named describes the program, not the default
  command.** A default command is in the context chain without argv having named
  it, and answering with its screen would hide every other command there is. The
  chain is trimmed to the commands argv actually named -- one `ParsedCommand`
  each, none for a default.
- **An option's `group` makes a section; a `help` hook contributes one.** Both
  are the same idea -- a titled list of options -- and they differ in what they
  are for. A group is the command's own options, split up, and still shadows
  what it inherits. A contributed section is shown and not parsed, which is the
  whole reason it exists: a `build` command has to describe every platform's
  options while only the platform that was named may parse. Options that should
  do both are added to the registry by a `parse` hook, which already works.
  Sections come after the command's own groups and before the inherited options,
  in the order they were added, and only the described command's hook fires --
  an ancestor's sections would appear under a command that has nothing to do
  with them. See `test/help/sections.test.ts`.
- **A section title and a `group` are checked, and `Global` is taken.** Either
  becomes a heading on a line of its own, so a newline or a control character in
  one is rejected while the schema is built rather than when somebody asks for
  help, and surrounding whitespace is trimmed. `Global` is refused because help
  writes `Global options` itself and two headings of one name on a screen
  describe options in different scopes. A `group` mutated after init into
  something that cannot be a heading gets no heading rather than a broken
  screen, which is the same call `format()` makes for a default that cannot be
  written as JSON.
- **A section used twice is one section.** Two platforms sharing a title, or a
  hook that added to it twice, add to what is there. The argument rules are about the
  list, so they are applied to the whole of the merged one, and nothing is kept
  until everything validated -- an `add()` that throws leaves the section it was
  merging into alone.
- **Shadowing counts every option, including a hidden one.** Being hidden is
  about whether help lists an option, not about whether it resolves: a command
  with a hidden `--mode` is still the `--mode` that argv reaches, so the root's
  is not what to describe.
- **A `help` hook that asks for the help it is contributing to is refused.** It
  is handed the state, which is all `resolveHelp()` needs, so it is an easy
  mistake and a stack overflow is a poor way to find it. What such a hook wants
  is `Command.help`, which is handed the generated screen.
- **A string `Command.help` builds no screen and fires no hook.** It replaces
  the screen outright, so a command that writes its own help cannot be stopped
  by a hook failing on the way to not using the generated one.
- **`HelpHookData` does not spread `InternalCommandBase`**, unlike every other
  command hook's data, because that carries a `state` of its own -- the
  command's `InternalState` -- and what a help hook wants under that name is the
  parse state. The registries worth having are named instead.
- **Help sorts commands and does not sort options.** Options are registered in
  the order the schema wrote them. Commands are registered as their
  initialization resolves, and one with subcommands of its own resolves after
  its siblings, so the registry's order is not the schema's and sorting is the
  only stable thing to print.
- **A lazily loaded command appears in help by name alone** until its module is
  read, because its description and its `hidden` are in that module. Hiding one
  is what the `!` name prefix is for. `help <command>` does load the module,
  since it is describing that one command.

- **The screen is a template, and `layout.ts` is gone.** A row is a flex row, the
  label column is a declared width, the description takes what is left and wraps
  in it, and an indent is padding -- so the two-column widths, the `pad()`, the
  wrapping calls and the indent arithmetic all went. What stayed is what help
  _decides_: which rows there are, what a label reads as, when a label is too wide
  to share a line with its description, and when there is not enough room for two
  columns at all. Every entry above about what help says is unchanged, and the
  rendered screen is byte for byte what it was.
- **The description column is told its width rather than growing into it.** The
  one piece of arithmetic help kept, and it is a measurement rather than a
  preference: a row's intrinsic height is taken with every child offered the whole
  content box while placement hands each one a share, so a description that wraps
  to three lines in its share measures two lines tall in the room it was offered
  and the block after it is drawn over the third. A declared width is measured at
  the width it will be placed at, which is the whole of what this needs. One
  subtraction, against the padding, the wrapping and the alignment it gave up.
- **A hanging indent is a flex row.** `Usage:` and `Alias:` are a bold label and
  a paragraph beside it, so every line of the paragraph starts at the paragraph's
  left edge. There is no `hangingIndent` option anywhere here because a row is
  one.
- **A parenthetical is a run rather than a string carrying its own escapes.**
  `(choices: ...)` and `(default: ...)` are dim, and a cell grid has nowhere to
  put a sequence that arrived inside a string -- the painter strips them. They are
  runs in a paragraph instead, which is what keeps them on the same line as the
  description when they fit.
- **A label too wide for its column keeps its own width.** It is stretched to the
  box it sits in otherwise, and now that `text-overflow` is honoured that is a
  truncation rather than an overhang -- which would quietly turn "a name wider
  than the width is printed whole" into "a name wider than the width is cut". The
  grid a string is painted into is as wide as what came out, so the name survives
  and the terminal wraps it, which is the answer that entry already gave.
- **The default help stylesheet is a framework origin.** That settles the other
  question the ticket left open, and it is the same answer themes get: an app that
  wants its command list in a different colour writes `.sigil-help-heading {
color: magenta }` and beats the default with an ordinary rule, which is only true
  because the default is an earlier origin rather than a rule in the same one.

### Sharing options between commands

- **Nothing declares what a command inherits, because nothing has to.** Options
  resolve across the whole context chain, so a child sees its parent's; the tree
  the parser walks is the only place that relationship lives. Help reads the same
  chain -- the described command, then each ancestor outward, with what is left
  under `Global options` -- so there is no second mechanism to keep in agreement.
  An earlier `inherits` property was added so that _inference_ could reach a
  parent, and removed again: it was a claim about the schema that the schema
  already made, it needed a runtime check of its own to stay honest, and it bought
  types that spreading a group into the command's own options also buys.
- **`options()` is the identity function.** It exists for the types: a `const`
  type parameter keeps `type: 'int'` from widening to `string`, so a group is
  still worth inferring from wherever it is used.

### Type inference

- **`src/infer.ts` is `initOption()` and `initArg()` written again in the type
  system.** That is the cost and there is no way around it: knowing that
  `'--port <n>'` with `type: 'int'` produces a non-optional `port: number` means
  reading the format string the way the parser reads it. The rules there move
  when those functions move, and `test/infer.test.ts` pins the pairs that are
  easy to get wrong -- including negative cases, since `unknown` and `any`
  satisfy any assertion and would otherwise make the whole file vacuous.
- **Inference happens at a call, not at a literal.** A nested object literal is
  checked against the declared type of the property it sits on, and checking does
  not re-infer that type's parameters. So `command()` is a function rather than a
  type: a bare literal inside `commands` keeps `Record<string, unknown>` and a
  wrapped one gets the narrow `argv`. Wrapping is optional and per command.
- **Anything wide contributes `Record<string, unknown>`, and that is deliberate.**
  An index signature in an intersection makes every key on it `unknown`, which is
  the honest answer when nothing was narrowed. `any` is checked first and counts
  as wide -- it arrives through `AnyCommand`, and left alone it satisfies the
  tuple walk and recurses on itself forever.
- **`AnyCommand` is `Command<any, any>`, not the wide defaults.** A command
  whose `run` takes a narrow `argv` is not assignable to one whose `run` takes a
  wide one, because a function parameter is contravariant, so every `commands` map
  would reject its own contents.
- **`choices` is `readonly unknown[]`.** `as const` is what produces a literal
  union, and a readonly array was not assignable to `unknown[]` -- which silently
  failed the constraint and made the whole declaration read as wide.
- **Nothing in `src/infer.ts` imports anything.** The rules read the shape of a
  declaration rather than its declared type, so `types.ts` imports it without a
  cycle.
- **The inference does not decide whether a schema is valid.** A variadic argument
  that is not last, `type: 'count'` on a valued option, and a format the parser
  rejects such as `'---triple'` are all things it throws on, and the types describe
  them as though they had worked. Validity is the parser's to report, with a
  message that says what to do; a type error would say less, and the code never
  runs either way.
- **A command's own declaration is typed and everything else in `argv` is
  `unknown`.** `InferArgv` intersects what it read with `Record<string, unknown>`
  rather than merging it: a merge would spread the index signature over the
  declared keys and make those `unknown` too. The keys it cannot see are the ones
  the commands above declared, which do resolve at runtime -- a command is typed at
  its own `command()` call and nothing there knows where in the tree it will be
  mounted -- so an error about a value that is genuinely there would be the wrong
  answer. A command that wants them typed spreads the group into its own options,
  and pays for it by shadowing what is above and moving those rows out of
  `Global options`.
- **A destination two sources share is merged, not intersected.** An `&` of a
  `boolean` and a `string` on one key is `never`, a key nothing can be assigned to,
  and an option and a positional argument of the same name really do both write to
  one destination. A shared key holds the union and is always there if either
  source fills it.
- **A declared `format`, `name`, or `hint` is read**, because `initOption()` reads
  all three and each changes the answer: a `format` wins over the key it was
  written under, a `name` wins over what the format would have named, and a `hint`
  makes a flag valued.
- **A default fills a destination whatever else was said**, including alongside
  `required: false`, which stops the parse demanding the option without stopping
  the fallback filling it. `default: undefined` is not a default -- `applyFallback()`
  skips it.
- **The rules that are easy to get wrong, and are therefore pinned by a test that
  also parses argv to confirm:** `choices` gives an option an implied hint and so
  makes it _valued_ rather than a flag; an empty `choices` list is `never`, because
  the parser rejects every value against it; `required` written out wins over what
  `<>` or `[]` implied, in both directions; only a _flag_ is negated and only when
  `negate` is not `false`, so `'--no-cheese [type]'` lands on `noCheese`; the first
  part of a format that is a long name or a bare word names the option, so position
  decides it and `'verbose, --all'` is `verbose`; a dual option is one destination
  holding either value and is optional, because the negated flag's implied default
  gives way to its valued twin; a pair of _flags_ on one destination is always set,
  because the positive one's default still applies; an optional argument before a
  required one is promoted; and `multiple`, `required`, `type`, and `choices`
  written out on an argument object are all read.

### Paths

- **Every base directory is read through one rule: expand, then require
  absolute.** The XDG spec says a base directory must be absolute and that a
  relative one is to be ignored, so `XDG_CACHE_HOME=./.cache` falls back rather
  than putting a cache in whatever directory the app happened to be started
  from. The `~` is expanded _before_ that is asked, and that ordering is the
  half the module used to disagree with itself about: `XDG_CONFIG_DIRS` always
  expanded its segments and the four `_HOME` variables never did, so
  `XDG_CACHE_HOME=~/.cache` reached `mkdir` as a directory named `~` -- the same
  defect the table's own `~/Library/Caches` entries carry an entry for, fixed
  there and not here. The rule is `baseDir()` and everything asks it: each
  environment variable, each segment of a `_DIRS` list, and each entry of the
  platform table. Two consequences follow from asking it everywhere. An empty
  `_DIRS` segment -- `XDG_CONFIG_DIRS=:/etc/xdg`, or a list with a trailing
  separator -- is a hole rather than a directory, where `expand('')` is `'.'`
  and truthy and `combinePaths()` could not tell it from a real entry, so the
  working directory joined the config search path. And a Windows fallback array
  walks past an entry that did not expand: `expand()` leaves `%LOCALAPPDATA%` as
  it found it when the variable is unset and the literal is truthy, so the array
  stopped at its first entry and `~/AppData/Local`, the fallback the array
  exists for, was unreachable. Absoluteness is `node:path`'s, so it is the
  running platform's -- a drive-relative `C:foo` is absolute nowhere, which is
  the answer Windows itself gives -- and `join`, `normalize` and `delimiter` are
  already bound that way; a second, call-time platform decision for this one
  check is how one line comes to disagree with the next about which platform it
  is on. `~user` is a shell convention `expand()` does not implement, so it stays
  literal and is refused by the same rule rather than becoming a directory named
  `~nobody`, and a `~` with no home to put over it stays a `~` for the same
  reason. That last one needed `home()` fixed to mean it: it was
  `paths ? join(_home, ...paths) : _home` and an array is always truthy, so a
  bare `home()` went through `join()` and there was no way back out --
  `join('')` is `'.'`, so a home the platform could not name came back as the
  working directory, and `expand()` had no falsy value to leave the `~` alone
  over. A real path where there is none is the one failure the caller cannot
  see. See `test/paths.test.ts`.

### Updates

- **A package name is percent-encoded into the registry URL and out of the cache
  filename.** It is one path segment and it is not a filename, and a scoped name
  -- which is what this framework publishes under -- was wrong as both.
  Interpolated raw, `/-/package/@ttylabs/sigil/dist-tags` asks for a package
  called `@ttylabs` with `/sigil/dist-tags` trailing. registry.npmjs.org happens
  to accept `%40scope%2Fname`, `@scope%2fname` and the raw slash alike --
  verified by hand against the real endpoint, never from the suite -- but
  `registryURL` is the caller's, and a self-hosted registry behind a
  path-normalizing proxy owes nothing.
- **The cache filename was a collision, not a broken write.** Worth saying plainly,
  because the obvious reading of `join(cacheDir, '@ttylabs/sigil-latest.json')` is
  a file in a directory nobody created, and that is not what happened: `check()`
  creates `dirname()` of the whole path, so the scope was created too and the
  cache merely scattered a level down. What was actually broken is that a dash
  cannot separate a name from a tag when a name may contain one -- `a-b` at tag
  `c` and `a` at tag `b-c` were one file, and two packages sharing a cache file
  share a version, so one of them is told the wrong thing to upgrade to. The
  transform therefore has to be _injective_, which percent-encoding is; the `@`
  separator is the same argument, since `encodeURIComponent()` leaves `-` alone
  but never leaves an `@`, so splitting on it recovers exactly what went in.
- **The parent builds the registry URL; the worker is handed it.** The worker is a
  string piped into `node --input-type=module`, so nothing can import it, stub its
  `https`, or call one function out of it -- anything it computes is observable
  only by making a real request, and a test suite here does not make those.
  Encoding a package name is exactly the kind of thing that has to be pinned by a
  test, so it happens in `registry.ts` where a test can reach it. The rule
  generalizes: what the worker decides for itself is what nothing else can check.
- **The worker times out its own request, because nothing else will.** `https.get()`
  has no timeout, and on the default `wait: false` path the parent's timer is
  unreffed precisely so the check costs the run nothing -- so a registry that
  accepts the connection and then says nothing left a node process alive for as
  long as its socket was, with the CLI that spawned it long gone. It is an
  inactivity timeout, which covers a stall partway through a response as well as a
  first byte that never comes; destroying the request surfaces through the `error`
  handler that already exits non-zero. `timeout: 0` opts out in the worker the same
  way it skips the timer in the parent, and a whitespace-only `REQUEST_TIMEOUT`
  is refused rather than read as that opt-out, because `Number(' ')` is `0` and a
  variable nobody meant to set must not be how the timeout gets switched off.
  What it does not cover is a registry that dribbles: one byte every
  `timeout - 1` ms resets an inactivity timer forever. That is the same deadline
  the parent's timer means when the parent is still alive, and closing it in the
  orphan case means a second, absolute timer whose expiry would have to mean
  something different from the option's name -- left alone deliberately, and
  written down here rather than discovered again.
- **The response gets its own `error` listener, because the timeout does not
  cover a body that stops half way.** A connection dropped mid-body destroys the
  socket, and the inactivity timer goes with it, while `end` never comes because
  the response did not finish -- so nothing settles the promise and the worker
  waits forever. It does not surface as an uncaught exception either, which is
  why it reads as a process that simply never exits. Measured, not reasoned; it
  is untested in the suite for the same reason the URL moved out of the worker,
  since reaching it means a real TLS server dropping a real connection.
- **Unreffing the child's stdin cannot cost the worker the script it is being
  fed.** An unflushed write is a libuv _request_, not a handle, and `unref()` only
  touches handles -- measured: a parent with every pipe unreffed still stays alive
  for a two-megabyte write to a child that is not reading. So stdin joins its two
  siblings in the loop rather than being the one pipe left holding the event loop
  open on a path whose whole point is to hold nothing.

## Known bugs

- **A row's intrinsic height does not account for flexing, so a block after one
  can be drawn over.** `measureUncached()` measures every child at the whole
  content box while placement hands each one a share, and the two part company
  the moment a child's height is a question about its width: a description that
  wraps to three lines in the column it is placed in measures two lines tall in
  the room it was offered, so the container reserves one row too few and the next
  block starts inside it. The placement itself is right -- `remeasureLine()`
  settles each item at the width flexing gave it -- and `renderToString()` sizes
  its grid from the arranged tree, so nothing is _lost_; what is wrong is the row
  a neighbour was promised. The way round it is to declare the width, which is
  what the help template does and why help lays out exactly. Closing it properly
  means running the flex resolution during the measure, which is `resolveFlexible()`
  reached from a function that has no content box to build items against. Pinned
  by `should be as tall as the layout turned out to be` and by the declared-width
  case beside it in `test/element/string.test.ts`.
- A subcommand's option used before its subcommand is not protected from being
  consumed as an earlier option's value, because it is not declared yet on the
  pass that reads it. A default command's options are always in that position,
  since it joins the chain only after argv has been walked. See the warning in
  `docs/parser.md` and the pinned tests in
  `test/parser/default-command.test.ts`.

## Conventions

- **Every dependency is pinned to an exact version, in every manifest.** A caret
  means a fresh install and a six-month-old lockfile can resolve to different
  trees -- and for a native binary, which `rolldown` and `oxc-parser` both are,
  that is a different binary on somebody's machine with nothing in the diff to
  point at. The lockfile pins the resolution; the manifest pins what is
  _asked_ for, which is what a range widens again the moment anybody reinstalls
  without one. `.npmrc` sets `save-exact=true` so `pnpm add` writes it, and
  `pinned dependencies` in `packages/cli/test/cli.test.ts` asserts it across the
  workspace -- because a setting only the person who ran `pnpm add` sees is a
  setting that drifts, and both ranges this repo has ever had arrived exactly
  that way. A `workspace:` link is not a range and is skipped; a **peer**
  dependency is deliberately left one, since it declares what the toolchain
  accepts from an app rather than what it installs, and pinning `typescript`
  would refuse every app on a different one.
- ESM only. Imports use `.js` extensions even for `.ts` sources -- **except
  inside `packages/cli/src/`, which uses `.ts`**. That is not drift, it is what
  makes `node src/sigil.ts build ...` work: Node's type stripping is erasure and
  does not rewrite specifiers, so a `.js` import of a `.ts` file is a module not
  found. The toolchain is the one package worth running straight from source --
  it is a tool rather than a library, and the alternative is a tsdown build
  between every edit and every try. `@ttylabs/sigil` keeps `.js`, because it is
  only ever consumed through its `exports` map and a `.ts` specifier would buy
  it nothing. `allowImportingTsExtensions` is set on `packages/cli` alone for
  the same reason.
- Internal state hangs off the exported `Internal` symbol, not enumerable
  properties, so schema objects stay clean for consumers. `parse()` stashes the
  state it died with on the error it throws the same way, under `ErrorState`,
  so the error path can still reach the matched command.
- **`init*()` copies, never decorates.** The caller's schema, commands, args,
  and options are read-only inputs: every normalized value and the `Internal`
  symbol land on a new object the library owns. So the same schema object
  parses identically any number of times, a frozen schema parses, and a lazily
  loaded command module — which the ESM loader shares with every other
  importer — is merged into a copy rather than written to. Asserted in
  `test/parser/schema.test.ts`.
- **No Proxies.** Internal commands, arguments, and options are plain objects.
  Anything that has to stay in sync is built once by `init*()`; anything a
  consumer may change afterwards is a property nothing is derived from.
- **A registry's lookup table is null-prototype.** A command really can be named
  `__proto__`, and on a plain object `lookup['__proto__'] = name` goes through
  `Object.prototype`'s accessor and is dropped -- the command registered and
  could never be matched. `OptionRegistry` had the same hole from the other
  side: argv reaches an option by its dashed spelling, which registers fine, but
  the bare name is a key too, so `options.get('__proto__')` could not find an
  option the registry holds -- and the registries are what a hook is handed. The
  inherited members are the other half of it, since `constructor` and `toString`
  read back truthy and answer a lookup nothing declared.
- **A destination is cased by `toUpperCase()`, never by the process locale.**
  `camelCase()` used `toLocaleUpperCase()`, which reads it -- and in Turkish and
  Azeri `i` uppercases to `İ` (U+0130), so every destination a separator built
  moved on a machine set to `tr-TR`: `--log-info` landed on `logİnfo`, as did an
  undeclared option's and an argument's. `src/infer.ts` writes the same rule with
  TypeScript's `Capitalize`, which has no locale, so the types said `logInfo`
  while the runtime did not -- and only there, because `\w` is ASCII and `i` is
  the only letter whose mapping differs, so an en-US CI can never see it. A
  destination is a JavaScript identifier rather than prose, and an identifier has
  no language. Covered by `test/parser/regressions.test.ts`.
- Parser errors are thrown as plain `Error`s with user-facing messages; they
  are what the user sees, so write them accordingly.
- Prefer a regression test named after the defect over a comment explaining it.
- **A demo is part of the published surface, and it was the only part nothing
  checked.** The demos import `@ttylabs/sigil` by name, so they resolve through
  the package's `exports` map and read `dist/` -- which is the point of them, and
  which also puts them outside the type-check: they are `.js` at the repository
  root, nothing runs them, and a named import of an export that no longer exists
  is not a lint error. It is a `SyntaxError` raised when somebody runs the file.
  `06-ansi-and-wrap.js` went on importing `padCell()` for a whole pull request
  after the component rewrite deleted it, with the suite green throughout and the
  README still documenting the export beside it. `packages/cli/test/demos.test.ts`
  is both halves of the answer, and it lives in that package because
  `@ttylabs/cli` is the one whose tests already require a build -- the same
  reason `the root build filter` lives there. It reads every demo's static
  imports and asks the built package for each name, which is a read rather than
  a process and fails naming the export that went missing. Then it spawns each
  one and asks for its exit code and its stderr, because a demo that imports
  fine and then throws is invisible to the first half.
- **The demos are run piped, and that is the interesting half rather than a
  concession to CI.** `demos/README.md` documents what each one does without a
  terminal -- a spinner writes one line per change, a bar one line every ten
  percent, a prompt fails rather than waiting forever on a stdin that will never
  produce a keystroke -- so running them this way checks the documented
  behaviour, and it needs no pty, which is what lets it run on all nine of CI's
  node-and-os combinations. A demo that does not exit `0` with nothing on stderr
  is an explicit list of two rather than an inferred rule, for the reason the
  raw-control-character exceptions already are: `04-prompts.js` is the non-TTY
  rule and exits `1` with the line the README prints, and `09-errors.js` is the
  demo about errors, whose narrative is stdout while what reaches stderr is what
  `errorHandler()` rendered. A stack frame in either stream fails every one of
  them whatever the exit code said, since that is a throw nobody caught -- and
  that is the one check that also catches an unhandled rejection which still
  exits `0`. The watchdog is the other thing worth having: a demo that hangs is
  killed and reported by name, rather than a suite that never finishes. It costs
  about six seconds of wall clock, which is `it.concurrent` over a sequential
  eighteen -- run always, because a check that is skipped is a check that rots.
- **An assertion is a call, and `expect(x).to.be.ok` is not one.** Chai spells
  that one as a getter, so it reads to a linter as an expression nobody used --
  and the narrowing it does not do is what made it worse than noise: each of the
  four uses was followed by an `if (result.cmd !== undefined)` wrapping the
  assertions that actually said something, so a command that failed to load
  skipped them and was caught only by the getter. `expect(result.cmd?.name)` is
  what the rest of the suite already writes, says the same thing in one line,
  and fails on the value it was asked about.
