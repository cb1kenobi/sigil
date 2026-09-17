# main2

A framework for building CLI apps in Node.js, and the successor to `cli-kit`.
The heart of it is a multi-pass hierarchical argument parser built for CLIs
that lean heavily on subcommands.

Unqualified `src/...` and `test/...` paths in this file mean
`packages/main2/src/...` and `packages/main2/test/...`.

This is a pnpm workspace with two published packages, and the split is load
bearing.

| Package          | Name         | Dependencies                                |
| ---------------- | ------------ | ------------------------------------------- |
| `packages/main2` | `main2`      | **Zero, and that is a hard constraint**     |
| `packages/cli`   | `@main2/cli` | Whatever it needs. Provides the `main2` bin |

**Zero production dependencies in `main2` is a hard constraint.** Anything the
runtime needs — ANSI handling, text wrapping, dotenv, `which`, debug logging,
and everything the 2.0 stack adds on top — gets written there and bundled. Do not add a runtime dependency to `packages/main2`; if one seems
necessary, raise it rather than adding it.

`@main2/cli` is the opposite: it is a devDependency of the app rather than part
of what the app ships, so it may depend on rollup and anything else it needs.
What it _produces_ has no dependencies. Do not let that licence leak back into
the runtime.

## Layout

Paths below are inside `packages/main2/` unless noted.

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
| `src/canvas/`            | Cell buffer, style interning, and the paint diff     |
| `src/style/`             | The style property set, its values, and shorthands   |
| `src/layout/`            | The flexbox subset, over whole cells                 |
| `src/infer.ts`           | `initOption()` and `initArg()`, in the type system   |
| `src/util/`              | Shared helpers (type coercion, camelCase, mkdir)     |
| `src/debug/`             | `DEBUG`-driven logger; replaces snooplogg            |
| `src/paths.ts`           | XDG base directories                                 |
| `src/updates/`           | npm update check, run in a spawned worker            |
| `src/error-handler.ts`   | Renders an error and sets the exit code              |
| `src/error-hooks.ts`     | Fires `beforeError` hooks; carries state on an error |
| `scripts/`               | Generators, run by hand and their output committed   |
| `docs/parser.md`         | Parser reference: syntax, semantics, precedence      |
| `test/parser/commander/` | Ported Commander test cases                          |
| `test/parser/yargs/`     | Ported yargs-parser test cases                       |

At the repository root: `demos/` (runnable examples that import `main2` by
name, so they need `pnpm build` first), `turbo.json`, `tsconfig.base.json`, and
the shared oxlint and oxfmt configs. Each package extends the base tsconfig and
sets its own `outDir`.

`packages/cli/src/` is a skeleton — the bin, `--version`, and the schema the
filesystem router will replace. Its commands are not written yet.

`src/i18n/` is an empty placeholder.

`src/width/east-asian-width.ts` is generated. Regenerate it with
`node scripts/generate-east-asian-width.mjs <unicode-version>` from inside
`packages/main2`, then `pnpm fmt`; the version is pinned in the script so
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

`pnpm --filter main2 test` scopes to one package, as does running the script
from inside its directory. **`@main2/cli` needs a build first** -- its source
and its tests import `main2` through that package's `exports` map, which points
at `dist/`, so on a fresh clone `pnpm --filter @main2/cli test` and the editor's
type-checking both fail until `pnpm build` has run once. Testing across the real
package boundary is the point; paying for it with a build is the price.

Run `pnpm check` before considering work finished. Formatting is oxfmt with
tabs, single quotes, and a 100-column width — run `pnpm fmt` rather than
matching it by hand.

## Scope

**The old 1.0 scope is gone.** It was the parser, help, ANSI wrapping, and ANSI
strip, with Titanium CLI as the acceptance test. All four shipped. The goal is
now considerably larger: main2 is a component runtime and a toolchain — the
Next.js for CLIs — and there is no 1.0 without it.

What that adds, bottom to top: a cell-addressable canvas that diffs frames,
cascading stylesheets with real selectors, a flexbox layout engine over whole
cells, TC39-shaped signals, an element tree, a renderer, compiled templates
with one IR behind several syntaxes, and a `main2` CLI that builds and packages
apps. See the "main2 2.0" project in Linear; each layer is its own ticket and
each ticket carries the decisions behind it.

The acceptance test is now `@main2/cli` itself — a framework whose own
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
- **`main2()` handles errors instead of rejecting.** A thrown value from
  `parse()` or from the command's `run()` is rendered by `errorHandler()` —
  the message, never a stack — `process.exitCode` is set, and `main2()`
  resolves with `undefined`. Its caller is a bin script, so an unhandled
  rejection dumping a stack is the wrong default. `settings.errorHandler:
false` rethrows instead; a function replaces the handler.
- **A `beforeError` hook may replace the error but never suppress it.**
  Returning nothing leaves the error alone, returning a value makes that value
  the error, and a hook that throws is logged and skipped. Suppression would
  have to mean something different at every throw site — what `parse()`
  returns, whether the command still runs — and a rule that cannot hold
  everywhere is worse than no rule. Hooks fire for every throw site, inside
  `parse()` for what `parse()` throws and inside `main2()` for everything
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
  no `run` and a load recorded as done -- so `main2()` did nothing at all, which
  is a worse answer than the error a string export already got.
- **A package's `exports` is resolved recursively.** The map nests -- `"."`
  holds conditions, a condition holds more, an array is a fallback list -- and
  unwrapping exactly one level left the ordinary
  `{ ".": { "import": "./index.js" } }` as an object, which reached `join()` as
  `[object Object]` and reported the package as having no valid export. Only the
  conditions this loader can honor are read: `import`, `node`, `default`, then
  `require`, since a CommonJS entry still loads. `browser`, `types`, and user
  conditions are skipped rather than guessed at.
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
- **Pictures cannot check containment, so `checkInvariants()` does.** The picture
  helper paints later nodes over earlier ones, so an overlap is invisible, and it
  bounds-checks against the grid, so anything placed past the edge does not
  appear at all. A fuzzer found five hundred containment violations that
  forty-two picture tests had no way to see.
- **A percentage of an unknown size is `auto`.** What CSS does, and what keeps a
  column layout from resolving heights against nothing.
- **`min` wins over `max` where they conflict**, as in CSS, which is what stops a
  box collapsing below its content when a stylesheet says something impossible.

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
  on. `position` starts at `static` and that is _not_ an exception: only a
  positioned ancestor is a containing block, so defaulting to `relative` would
  make every box an anchor an `absolute` descendant stops at.
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
- **The property table is frozen, definitions included.** The initial values were
  frozen and the slots holding them were not, which is the same TypeScript
  fiction one level up: `PROPERTIES.width.initial = cells(7)` changed what
  `declare()` returned for every style in the process.
- **Margins take a length and paddings take a count.** `auto` is how a box is
  centred and how it is pushed to one end, and a negative margin is a real
  thing; neither is true of padding.

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
  otherwise spin forever with nothing said about which two.
- **An error in an effect is reported, never rethrown.** Under the default
  microtask scheduler a rethrow lands in a microtask nobody catches: Node prints
  a raw stack and kills the process, skipping `main2()`'s error handling, the
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
  announce every newly watched computed as a change.
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
  driving frames -- two canvases with different loops, a library using main2
  inside a host that also does, or two tests in one file where the first leaves a
  scheduler that never ran and the second is dead before it starts.
- **Coalescing is about how many times an effect runs, not whether it runs.** A
  signal written to `1` and back to `0` before the flush still re-runs its
  effects, once, with the value it settled on. Nothing records what a signal held
  before a burst, and both writes were real changes when they happened.

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

## Known bugs

- **`afterParse` fires before `state.argv` exists.** The hook runs at the end of
  `parseArgv()`, which is before `processArgs()` and `processOptions()` write
  anything, so `state.argv` is `{}` inside it while `state.$` is populated. The
  one thing a hook named "after parse" is for is the one thing it cannot do.
  Found while writing `--version` for `@main2/cli`, which reads the state
  `main2()` returns instead. Do not reach for `afterParse` to read a parsed
  value until this is fixed.
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
- Parser errors are thrown as plain `Error`s with user-facing messages; they
  are what the user sees, so write them accordingly.
- Prefer a regression test named after the defect over a comment explaining it.
