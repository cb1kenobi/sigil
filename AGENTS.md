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

| Path                     | Contents                                             |
| ------------------------ | ---------------------------------------------------- |
| `src/parser/`            | The parser: commands, options, arguments, registries |
| `src/ansi/`              | SGR styling, strip, color support detection          |
| `src/width/`             | Display width: grapheme clusters, East Asian Width   |
| `src/wrap/`              | Text wrapping, SGR state, terminal width             |
| `src/help/`              | The generated help screen and its two-column layout  |
| `src/terminal/`          | Terminal wrapper, live region, sequences             |
| `src/components/`        | Spinner, progress, table, prompts, key decoding      |
| `src/signals/`           | The reactive graph: state, computed, watcher, effect |
| `src/canvas/`            | Cell buffer, style interning, paint diff, sub-cell   |
| `src/style/`             | Properties, values, selectors, cascade, degradation  |
| `src/layout/`            | The flexbox subset, over whole cells                 |
| `src/infer.ts`           | `initOption()` and `initArg()`, in the type system   |
| `src/util/`              | Shared helpers (type coercion, camelCase, mkdir)     |
| `src/debug/`             | `DEBUG`-driven logger; replaces snooplogg            |
| `src/paths.ts`           | XDG base directories                                 |
| `src/updates/`           | npm update check, run in a spawned worker            |
| `src/error-handler.ts`   | Renders an error and sets the exit code              |
| `src/error-hooks.ts`     | Fires `beforeError` hooks; carries state on an error |
| `scripts/`               | Run by hand: generators, and the real-terminal probe |
| `docs/parser.md`         | Parser reference: syntax, semantics, precedence      |
| `test/parser/commander/` | Ported Commander test cases                          |
| `test/parser/yargs/`     | Ported yargs-parser test cases                       |

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
will replace, and `src/utilities/` — the utility generator. Its commands are not
written yet.

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
- **A `beforeError` hook may replace the error but never suppress it.**
  Returning nothing leaves the error alone, returning a value makes that value
  the error, and a hook that throws is logged and skipped. Suppression would
  have to mean something different at every throw site — what `parse()`
  returns, whether the command still runs — and a rule that cannot hold
  everywhere is worse than no rule. Hooks fire for every throw site, inside
  `parse()` for what `parse()` throws and inside `main()` for everything
  else, innermost command first and the schema last, before rendering and
  before the `errorHandler: false` opt-out. See `test/parser/hooks.test.ts`.
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
  `visibility` and `overflow` are deliberately _not_ layout's: hidden content
  still takes its space, and clipping is M2-64's.
- **`position: relative` offsets the box and `absolute` is refused.** Both halves
  are the rule above applied to the same property: the half that can be
  implemented today is, and the half that cannot stops existing rather than
  parsing into a no-op. `relative` moves the box by its insets from where the
  flow put it and changes nothing else -- the space stays reserved at the
  un-offset position, so siblings are placed as though it never moved and its own
  children move with it, which is CSS. `absolute` throws at parse time saying so,
  because a stylesheet written against a keyword that lays out in flow anyway
  means something different the day out-of-flow layout lands, and that is a
  change nobody can see coming. The alternative was dropping `position` and the
  four insets from the table entirely; it is smaller and equally honest, and it
  was not taken because `relative` is a handful of lines, is what people reach
  for to nudge a border or overlap a label, and is what keeps `top-N` and the
  `inset` shorthand meaningful -- while the property that was actually lying,
  `absolute`, is refused either way. `inset-0` is not part of that argument: it
  is an out-of-flow idiom and on a `relative` box it is an offset of zero.
  `z-index` is left alone: it
  is a paint-order property, it is not in `LAYOUT_PROPERTIES`, and nothing here
  is what would honour it.
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
  to show for it. Pinned by `should lay a percentage-limited text out at the width
it is placed at`.
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

### Style

- **The property table is the single source of truth.** Every property's initial
  value, whether it inherits, and how it is read all live in one object, and
  everything downstream -- the cascade, the layout engine, invalidation,
  animation -- reads it rather than carrying a list of its own. A property is
  added in one place or it is added wrong.
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
- **`position` takes `static` and `relative`, and `absolute` is a parse error.**
  A keyword the layout engine cannot honour is refused rather than accepted and
  ignored, for the reason the Layout entry gives at length; the message names
  `relative` so that the error reads as an answer rather than as a missing
  feature. The insets stay -- `relative` reads all four -- and they are a length
  rather than a count, because pushing a box back the way it came is the ordinary
  use and a negative value is how CSS says it.

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
- **What is deliberately not here: the signal wiring.** An `effect()` per
  reactive binding is the renderer's, and building it now would be an
  architecture guess with nothing to check it against. `Restyler` takes marks
  from whatever calls it.

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
  so it snaps forward to the end of what it landed inside. `truncateCell()` in the table already read text this way;
  the prompt was the one place that did not. See
  `test/components/prompt.test.ts`.
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
  in the order they were added, and only the described command's hooks fire --
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
  hook that ran twice, add to what is there. The argument rules are about the
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

- **An auto-width node is sized around a subtree measured without its own
  percentages.** What is left of the entry above once `measure()` takes its two
  widths separately: a node lays its content out at the width it is drawn at now,
  but an ancestor that is still sizing itself measured that subtree with every
  percentage read as `auto`, so the ancestor can come out too small for what it
  then places. CSS produces the same overflow and browsers live with it; closing
  it needs the containing block known before the subtree is measured, which is
  iteration. The layout invariants allow it -- `checkInvariants()` takes
  `overflow` -- and `should lay a percentage-limited text out at the width it is
placed at` pins the shape of it.
- A subcommand's option used before its subcommand is not protected from being
  consumed as an earlier option's value, because it is not declared yet on the
  pass that reads it. A default command's options are always in that position,
  since it joins the chain only after argv has been walked. See the warning in
  `docs/parser.md` and the pinned tests in
  `test/parser/default-command.test.ts`.

## Conventions

- ESM only. Imports use `.js` extensions even for `.ts` sources.
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
- **An assertion is a call, and `expect(x).to.be.ok` is not one.** Chai spells
  that one as a getter, so it reads to a linter as an expression nobody used --
  and the narrowing it does not do is what made it worse than noise: each of the
  four uses was followed by an `if (result.cmd !== undefined)` wrapping the
  assertions that actually said something, so a command that failed to load
  skipped them and was caught only by the getter. `expect(result.cmd?.name)` is
  what the rest of the suite already writes, says the same thing in one line,
  and fails on the value it was asked about.
