# `packages/sigil/src/parser` — deliberate decisions

These are the entries from [../../../../AGENTS.md](../../../../AGENTS.md) that are about this directory. Claude Code loads this file when it
works with files here; other agents should read it before changing
anything in this area. The root `AGENTS.md` holds the rules that apply
everywhere and still applies in full.

How each of these was arrived at — the review rounds and sabotage
passes — is under [docs/history/](../../../../docs/history), linked from
the entry it belongs to.

## Deliberate decisions — do not "fix" these

### Output formats: `run()` returns data, a serializer presents it

oclif's answer to "give me JSON" is `enableJsonFlag` plus `toSuccessJson()`, and
the two objections to copying it are both right: `--json` is one format of
several people want, and a command that branches on it grows an
`if (json) … else …` with two code paths that drift. `src/format.ts` is the
registry and the serialization, `src/parser/format.ts` is the option and the
detection, and the serialized error is `renderError()`'s third form.

- **The conditional exists because the command is doing both jobs, so the two
  jobs are split.** `run()` returns data, and optionally also draws, exactly as
  today; a serializer is selected by name and presents what was returned. No
  command computes two answers. Which is the shape the quiet axis takes one layer
  along -- a component says what it is and `resolveOutput()` decides whether it
  draws -- and it is why this was a small ticket sitting behind a large one.

- **The registry is on the **schema**, and that is the one place this parts
  company with `setQuiet()`.** A process-wide slot is right for quiet for a
  recorded reason: "the two ends have no other connection -- `--quiet` is read
  while argv is parsed, and a spinner is built later inside a command's `run()`".
  It does not transfer. A format's two ends are the **parse**, which decides
  whether the name is one this app has, and **`main()`**, which serializes the
  value -- and the schema is in hand at both, so a module-level registry would be
  the second mechanism. It would also leak between two schemas in one process,
  which the nested `main()` the palette documents really is, and which quiet needs
  a whole generation token to survive. `sigil build` carries it for free, because
  `formats` is an ordinary schema property and the build spreads the app's schema
  whole.

- **A serializer is synchronous, and that is forced rather than preferred.**
  `errorHandler()` is synchronous, and the serialized error has to come out of the
  same selection the serialized result does -- "a script that gets JSON on success
  and a rendered element tree on failure cannot be scripted against" is the
  ticket's own sentence and is the whole reason the error half exists. So
  `OutputFormat` is `(value: unknown) => string` with no promise anywhere in it,
  which is also the better answer: a serializer that did I/O could fail half way
  through writing an answer it had already begun.

- **`json` ships and nothing else does.** `JSON.stringify` is free, so the
  zero-dependency constraint is untouched, and `yaml`, `xml`, `csv` and `tsv` are
  the app's to register -- the same division the config stores draw. An entry
  named `json` replaces the built-in, which is the declaration-respecting rule
  every free flag here follows, said about a name rather than a spelling.

#### It is per command, which is why it is added in `initCommand()`

- **`--help`, `--version` and `--quiet` go on the root and this does not.** Those
  are questions about the program, and options resolve across the whole chain, so
  one there answers everywhere. A format is not that: a full-screen dashboard has
  no data to serialize, and a `--format` on it would be an option that parses and
  does nothing. So a command opts in with `format: true | string[]`, and the
  option exists exactly where the command said it does.

  What "unknown option" comes to then depends on `allowUnknownOptions`, which is
  **on** by default -- so `mycli dashboard --json` lands on `argv.json` as the
  pass-through that setting is for and nothing serializes, and with it off it is
  the error. The ticket's phrasing assumed the second; both halves are pinned, and
  the second is the one that says the option really is absent rather than present
  and inert.

- **Which is also why it is registered where a command's declaration becomes a
  registry, rather than in `parse()`.** The other three are added by the parse, so
  a surface built by initializing the schema "simply does not have them. That is
  the answer rather than a filter: an app's snapshot should move when the app moves
  and not when the framework does, and what the framework adds is the framework's
  to document." This one is the **app's**: the command declared `format`, so the
  option it got is as much a part of its declared surface as one it wrote out --
  and `initCommand()` is the one place that makes help, the reference, a
  completion script and the parse all see one option rather than four readers each
  adding their own.

- **The option says which tokens select a format and the **command** says what
  they may name, which are two questions and so two fields.**
  `opt[Internal].selectsFormat` is a plain marker, which is how both spellings
  are recognized without a second field saying which is the sugar, and
  `cmd[Internal].formats` holds `true`, the declared names, or `false`.

  This entry read the other way for two commits -- the accepted set was on the
  option, "which is the discipline `baseDir` already keeps: which declaration
  argv resolved against is the registry's answer" -- and that justification was
  **already stale when it was written**, because review round 1 had moved the set
  off the option argv bound to and onto the settled chain for being
  position-dependent. So the placement was being defended by appeal to a
  mechanism that no longer ran, in five places: `mark()`'s doc, which round 1
  corrected, plus `InternalOption.formats`' own doc, two test doc comments and
  this. What is on the option is read from nowhere once the set comes off the
  chain, which is what says the field was in the wrong place rather than merely
  described wrongly -- and `false` has no option to be recorded on at all, which
  is the half that made an opt-out unexpressible. See below.

- **`parserOwned`, which is the whole design said in one field.** The value never
  reaches `argv`, so a command **cannot** branch on it -- offering `argv.format`
  would hand back the conditional this exists to delete. What a command reads
  instead is `state.format`, which is the framework's record rather than the raw
  option value, and the distinction matters: see "Where a command's own human form
  goes" below.

- **There is no `choices` list, and the message is why.** The obvious thing is a
  `choices` list so a bad name is a parse error, and it is refused -- not for want
  of a place to put it, but because the list is `declared ∩ what the schema
  provides`, which is knowable at init for `format: ['json']` and **not** for
  `format: true`, since `initCommand()` has no schema. So `choices` would judge one
  spelling of the declaration and not the other, which is two behaviours for one
  thing. One validation point instead, in `detectFormat()`, which runs before
  anything is validated and so before the command runs -- and what that buys
  beyond consistency is the message: `formatFor()` names what _is_ available, where
  `Invalid value "{0}" for {1}` has the list in hand and does not print it, which
  the suggestion work already records as the better fix and a different ticket.

  What it costs is value completion -- `mycli build --format <TAB>` offers nothing
  -- and no choices in the generated reference. Both are a missing feature rather
  than a wrong answer, and both are additive later: the shape is to thread the
  schema's format names into `initCommand()` the way `baseDir` is threaded, after
  which `choices` answers for both spellings at once.

#### Both spellings, and the ordering rule that needs no special case

- **`--json` is sugar for `--format json`, and the justification is muscle
  memory rather than consistency.** Two spellings of one thing is something this
  repository refuses, so the reason is written down rather than left to look like
  an oversight: `--json` is what everybody types and what every other tool
  accepts, and a framework that made people learn `--format json` instead would be
  spending its users' goodwill on a consistency they did not ask for. Offered only
  where the command accepts `json`, or the sugar would select a format the command
  refuses.

- **One mechanism rather than two, and it generalizes for free.** A format option
  whose value is a **string** names that format; one whose value is `true` names
  the format it is **called after**. So `--json` selects `json` because it is
  called `json`, and a later `--yaml` would get the same thing for nothing. It is
  safe for `--format` because that option takes a value, so its value is always a
  string: a bare `--format` is `Missing value for option --format`, and
  `--format=` is the empty string -- the one way to say "deliberately empty" --
  which is refused as a format name like any other.

- **Last wins**, which is where this parts company with the three flags the parser
  owns: those are _questions_, so any typed true wins in either order, and a format
  is a _value_, so the rule is the one every valued option in this schema already
  follows. `--json --format yaml` is yaml and `--format yaml --json` is json, with
  no rule of its own -- and `--json --json=false` is still json, because a `false`
  names nothing and the first use is the last one that said anything, which is
  `--quiet`'s own reading of a typed no arriving through the last-wins rule rather
  than through a special case.

- **`--output` is not offered and neither is a short form.** `-o`/`--output` means
  an output **file** in gcc, curl, ffmpeg and most of what a user of this framework
  has ever typed, so claiming it for a format name would be taking a spelling that
  already means something else. And unlike `-h`, `-v` and `-q` there is no
  consensus on a short form: `-f` is `--force` or `--file` far more often than it
  is `--format`.

#### Errors are the third form through a seam that already had two

- **`renderError()` reads the format off the state**, so the serialized error and
  the serialized result come out of one selection. `report.ts` in the toolchain
  already keeps a two-forms discipline -- a laid-out form for a terminal and one
  line per record for a pipe -- and this is a third form through the same seam
  rather than a new mechanism. On **stderr**, where an error always goes, with the
  exit code carrying the verdict.

- **The payload is `{ error: { message, name? } }`.** Wrapped, because
  `{"message":…}` is indistinguishable from a command that succeeded and returned a
  `message`. Built from the same `errorMessage()` the human form prints, so the two
  cannot come to disagree about what the error said. `name` is included whenever
  the thrown value has one -- which is uniform for every `Error` and absent for a
  thrown string -- and it is there rather than as a nicety because **a message is
  translated and a name is not**, so a script keyed on the message breaks the
  moment `LANG` moves. `exitCode` is deliberately absent: the process already
  carries the verdict, and putting it in the payload would be the same fact twice.

- **`errorLine()` is its own function, because a fallback that can re-enter what
  it is a fallback for is not one.** `renderError()` falls back to the message
  where the serializer throws on the payload -- a broken serializer must not cost
  the reader the error they actually needed -- and `errorHandler()`'s own catch
  around a replaced renderer falls back to the same plain function rather than to
  the format-aware one.

- **An invalid _value_ is the one seam, and it is pinned rather than
  discovered.** `--port eight` on an `int` throws while argv is being **read**,
  which is before `detectFormat()` has run, so it is reported as a plain message:
  "it failed on the way in", which is the rule already recorded for why help does
  not win over an invalid value. Everything judged _after_ the walk serializes --
  a missing required option, an unexpected argument, a value outside `choices` --
  measured on all four. Detecting the format mid-walk would close half of it and
  is refused: `--json --port x` serializing while `--port x --json` did not is a
  rule nobody can reason about, where consistently-plain is one sentence.

#### Selecting a format implies quiet, and the implication is made where it is read

- **A spinner interleaved with JSON on stdout is unusable**, which is why this
  ticket waited on the quiet axis rather than carrying its own suppression.
  `main()`'s condition is `state.quiet || state.format !== undefined`, one place,
  so `state.quiet` keeps meaning "argv asked" and the implication reads where it
  is made rather than making the flag look as though it had been typed.

#### Where a command's own human form goes, which the demo found

The sharpest question in the design, and the ticket did not name it.

- **The framework decides which presentation reaches the terminal only for what
  **it** draws.** Quiet reaches `mountLive()` -- the spinner, the bar, the
  typewriter, the decrypt -- and it deliberately does not reach a `table()`,
  because that one "hands a string back and the caller does the writing, so quiet
  is the caller's statement about its own `write()`". So a command's own result on
  stdout is the command's, and stdout belongs to the serializer once a format is
  selected: two answers on one stream.

- **It cannot be fixed in the framework, and that is a measurement rather than a
  preference.** `main()` could only suppress a command's stdout by patching
  `process.stdout.write`, and a spawned child writing to the **inherited fd**
  walks straight past such a patch -- so the suppression would be partial, which
  is worse than none, and silently dropping a second answer is the loss class this
  repository refuses everywhere.

- **So there are two honest answers and the demo shows both.** Ask `state.format`
  whether to _present_ the human form, which is one line and is a question about
  presentation rather than the two-answers conditional the design deletes -- the
  value is computed once either way, which is exactly the distinction between this
  and `if (json) … else …`. Or put the human form on **stderr**, so both can be on
  screen at once and a pipe still gets clean data, which is the split `report.ts`
  already makes: its diagnostics and its summary are on stderr precisely so that
  `--tree` can own stdout.

- **Which is why `sigil check` does not adopt this, and that refusal is a finding
  rather than scope discipline.** It is the obvious acceptance test -- its
  diagnostics are already structured data -- and it writes `--tree` to **stdout**,
  so selecting a format would put two answers on one stream and resolving it would
  need `check` to branch. A command whose own answer is on stdout is not a
  candidate for a serialized form unless it gives stdout up, and `--tree` is
  exactly that. The dogfood is `demos/parser/12-formats.js` instead, where `list`
  is the stdout answer and `report` beside it is the stderr one.

  **Its bare run walks every one of its own header's command lines**, which was
  `['list']` until somebody ran it and saw a table -- the one presentation that
  shows none of the design. A reader's own arguments still win, which is every
  parser demo's rule, so the tour is the else branch rather than a replacement.
  What that cost is an `EXPECTED` entry in `demos.test.ts`, because several steps
  write to **stderr** and three set an exit code: `report`'s own human form, an
  unknown format's message, and `boom`'s error through the built-in and through
  each of the app's own serializers. Which is `09-errors.js`'s own shape -- a demo whose narrative is stdout and
  whose stderr is what it exists to show -- so it is declared there with the
  reason rather than avoided by picking steps that keep the stream clean. The
  exit code is cleared per step and printed where there was one, since the tour
  itself completed, and the interleaving on a terminal **is** the claim: the
  table and the JSON are on screen together and `report --json | jq .total` is
  still clean.

  `lines()` is what makes that entry readable, and it is shared rather than a
  second spelling: a dozen-odd lines of exact stderr hand-written as `\r?\n` and
  escaped braces is a wall nobody can edit safely, so the lines are the input and
  the escaping is one function's -- which `09-errors.js`'s two-line entry now
  goes through too, because two ways of saying "this exact stderr" in one table
  is the drift this file deletes everywhere else. Exact rather than loose for
  that file's own reason, and sabotage-checked in both directions: one wrong
  digit in an expected line fails it, and dropping the per-step exit-code reset
  fails the code assertion beside it.

  **And one row is named `charlie "big, loud"`, which is what makes the two
  serializers it ships honest.** A space, a comma and a pair of double quotes is
  the one value every format has to say something different about -- and both of
  the app's own were the naive interpolation, so the comma turned one CSV field
  into two columns and the quotes made the YAML scalar ambiguous. Silently, in a
  demo whose subject is that a serializer an app brings is the app's to get
  right, which is the loss class the built-in `json` refuses at the value one
  layer up. `csvCell()` is RFC 4180 -- wrap on a comma, a quote or a break, and
  double the quotes -- and `yamlScalar()` quotes **always**, because the long
  rule is the one a plain scalar needs and quoting unconditionally is the short
  answer that cannot be got wrong. Both are verified against a parser that is
  not ours rather than by reading: `csv.reader` and the `yaml` package each read
  the name back whole, with the sizes still numbers.

  The error message gained a comma and quotes with it, and `boom --format yaml`
  joined the tour -- which is the step that pins the pair. `demos.test.ts`
  asserts no demo's **stdout**, so the data path's escaping is unpinnable without
  a new mechanism for one demo; the error path's is in the declared stderr, so
  `""alpha""` and `\"alpha\"` sit two lines apart in it and each escaper fails
  that test when it is sabotaged. The step earns its place either way, since the
  same message under two rules side by side is the sharpest way to say escaping
  is per format and the app's.

#### What a command returned, and the three answers to `undefined`

- **A command that opted in and returned `undefined` is refused, naming the
  command.** Three answers were available and only this one can be acted on.
  Printing nothing leaves a script with empty stdout and exit zero, so `jq` fails
  with "Unexpected end of input" and the failure names nothing; printing `null`
  claims the command's answer was `null`, which is a lie if it meant to return
  something. A refusal names the command, goes to stderr and exits non-zero, which
  is what a script's `set -e` is for -- and `--format json` that produces no JSON
  is the property that parses and does nothing, which this file calls worse than
  one that does not exist. `null` itself is a value JSON represents and is
  presented.

- **It runs after the `afterRun` hooks, which is the honest ordering.** The
  command really did return, so a hook that asked what it did is right to have been
  told `ok`; what failed is the presentation, and the error it throws reaches the
  same path every other one does -- serialized in the selected format, because the
  payload is a plain object every serializer can take. Pinned, because the ordering
  is a decision rather than a convenience.

- **`assertSerialized()` is a guard rather than a tripwire, and the built-in is
  what makes it one.** `JSON.stringify` has three answers and two are silent: it
  **throws** for a `BigInt` and a circular structure, which propagates; it answers
  the _value_ `undefined` for a function, a symbol and `undefined` itself, which
  would reach stdout as the word; and it rewrites `NaN` and `Infinity` as `null`.
  The second is reachable through `json` by a command returning a function, so the
  refusal has a real caller. The third was left to JSON for one commit, on the
  argument that a value here is handed to a pipe once where the config module's
  `jsonCanHold()` guards a file somebody reads back -- and a review round measured
  what that argument costs: a `Map` of results piped `{}` and said nothing.
  `lossyAs()` refuses all three families at the value now, so `NaN` is `JSON
  writes NaN as null` naming the path rather than a `null` on somebody's stdout.
  What is still left alone is the residual below, and that is where the
  `jsonCanHold()` comparison belongs.

- **`writeFormatted()` writes exactly one trailing newline**, stripping whatever
  the serializer ended with -- `errorHandler()`'s own rule, which is what keeps a
  CSV serializer that already ends with one from producing a blank line.

#### Two refusals at the declaration, and what each closes

- **A declared name the schema does not provide fails on every run**, rather than
  on the first run that types `--format`. Checked over the chain in
  `detectFormat()` whether or not argv asked, which is the call `initCommand()`
  makes for a non-boolean `hidden`: a declaration that cannot mean anything fails
  where it was written. Only the chain is walked, so a routed tree pays for the
  commands argv named and nothing else -- and a bad declaration on a command
  nobody ran does not refuse the app, which is pinned as the other half.

  Asked as **membership** rather than as a `formatFor()` in a `try`, because that
  function throws two different things -- a name this command cannot present, and
  a `schema.formats` that is not an object of functions -- and catching would
  report the second as the first, which is a message pointing at the wrong
  mistake.

- **A command that left no spelling to select with is refused.** A command that
  declares `format` and also declares both `--format` and `--json` has no way left
  to ask for one, which is a declaration that parses and does nothing. Refused in
  `registerFormats()`, which is the one place both facts are in hand: what the
  command declared, and what the registry would let us add. Only where **neither**
  could be added, which is what keeps the graceful half graceful -- an app that
  claimed `--format` keeps it and still selects with `--json`, exactly as one that
  claimed `-q` keeps `--quiet`.

- **And the asymmetry a merely-_named_ `format` has is `registerQuiet()`'s own.**
  `find()` answers about spellings and `has()` about the key the registry stores an
  option under, which is its name -- so an option spelled `-x` and named `format`
  costs the command the option **entirely**, where a taken `--json` costs it only
  the sugar. Replacing a registry key is a worse thing to do to an app than
  declining to add a spelling.

- **`format: []` is refused rather than read as `false`.** It is "I present no
  format", which `false` already says, and a `--format` that rejects every value is
  a flag that cannot work. Refusing beats the silent reading.

- **`schema.formats` is validated unconditionally**, the way the hooks are:
  `detectFormat()` looks only where a command opted in, so an app with a broken
  `formats` and no command that presents one would otherwise never find out.

#### What it costs, and the i18n line

- **3,825 B on the root entry, which is 11,991 B over seven modules against a 20
  kB ceiling.** The 3,160 B `format` chunk is on that graph for one reason:
  `errorHandler()` serializes an error in the selected format, so it is reachable
  from the error path every app has. Carrying the **resolved serializer** on
  `ParseState` instead would take the chunk off the graph entirely and was weighed
  and refused -- a _name_ is what a reader, a hook and a test want on the state,
  and `formatFor()` is deterministic given the schema, so resolving it twice cannot
  drift. `components.mjs` moved 242,297 to 245,744 B over 29 for the same reason:
  it reaches `error-handler`.

  Every one of those is re-measured rather than carried, and a review round is
  what asked: this bullet read 1,482 B and 9,648 B with an 819 B chunk, which was
  the honest measurement of the **first** commit and went stale the moment round
  one's loss refusal landed -- while `dist.test.ts`, which the rounds did update,
  said 11,991 B. Two figures for one measurement leave a later reader no way to
  tell which was measured, which is the defect that file's own comment is written
  about, so both are the same number now and neither was copied from the other.

- **Four translated keys and five English ones**, which is the line this file
  already draws. `Present the result in this format`, `Present the result as
  JSON`, `Unknown output format "{0}". This command accepts: {1}` and `The "{0}"
  command presents no output formats, so "{1}" cannot be asked for.` are what a
  **user** provokes, so they are keys; `SIGIL_KEYS.length` is the figure, and the
  fourth is the opt-out refusal the second PR round added. Everything else is a
  mistake in the app's own declaration or its own serializer -- a bad `formats`, a
  bad `format`, an empty list, a declared name the app does not provide, a command
  that returned nothing, a serializer that answered with something that is not
  text -- and a translated bug report is one the maintainer cannot read.

> Moved: _What the sabotage pass found, and the two guards covering for each other_, _What the first review round found, and the one thing that was losing data_, _What the second round found, and the report it never wrote_, _Round three never answered, and what was done in its place_, _What the PR review round found, and the copy that ships_, _What the second PR round found: the opt-out that was a spelling of absence_ — see [docs/history/output-formats-run-returns-data-a-serializer-presents-it.md](../../../../docs/history/output-formats-run-returns-data-a-serializer-presents-it.md).

#### What is deliberately out

- **A process-wide `registerFormat()`**, with the leak reason above.
- **`choices` on the option**, with the two-behaviours reason above, and the shape
  of the fix named so that whoever wants value completion finds it.
- **`--output` and a short form**, each with its own reason.
- **An async serializer**, which the synchronous error path forbids.
- **A declared return type per command**, which is the strict answer to "what does
  the data have to be" and is more than anyone has asked for. Loose, with the
  serializer refusing what it cannot represent, which is the ticket's own call.
- **Suppressing a command's own stdout**, with the spawned-child measurement.
- **`sigil check --json`**, with the `--tree` measurement -- which is a finding
  about what a candidate command looks like rather than a gap.
- **A format on `--help` or `--version`**, because help is the answer to the
  question and a version is a question about the program rather than a command's
  answer. Both are pinned so the absence is a decision.

### A schema's relative paths

- **A relative `commands` path meant two different things, and `check` called it
  fine.** The build resolves it against the _entry module's_ directory; the
  runtime had nothing to resolve an inline schema against and fell back to the
  process's working directory. So one `commands: './commands'` produced the tree
  the build baked in _and_ an `Unsupported command module` the moment anybody ran
  the app from source -- with `sigil check` reporting "no problems found" about
  exactly that app. This is the divergence the shared route rules exist to
  prevent, arriving through the one door they do not cover, and neither half of
  the suite could see it: `buildable` uses a relative path and is only ever
  _built_, `ts-app` is only ever _run_ and passes an absolute path. Each half was
  tested; nothing crossed over. Found by scaffolding an app and running it, which
  is what a scaffold is for.
- **`Schema.baseDir` is what closes it, and it is the app's to set.** The plumbing
  already existed -- `initCommand()` has taken a `baseDir` all along, for a
  command declared inside a lazily loaded module -- so this exposes it rather
  than inventing it. `import.meta.dirname` is what an app writes, and the point
  of putting it on the _schema_ rather than resolving the path at the call site
  is that `commands` stays a plain string literal, which is what `sigil build`
  reads without running anything. Any other spelling breaks one side or the
  other: an absolute path computed with `fileURLToPath` runs correctly and is
  unreadable to the build, and a path the dev runner rewrites means the schema
  says one thing to `dev` and another to `build`.
- **The missing `baseDir` is a warning rather than an error, and `check` having
  nothing to say was the worse half.** The _built_ app is genuinely fine and an
  app that only ever ships bundled is not wrong, so failing the build over it
  would refuse a working app. What could not stand is a checker answering "no
  problems found" for an app that throws on startup -- it is the one tool whose
  answer people trust instead of trying it. The diagnostic names the line, says
  which directory each side would resolve against, and gives the one line to add.

### An `afterRun` hook: `finally`, `postrun`, and the telemetry seam in one

oclif gives a command `init()`, `catch()` and `finally()`, plus a `postrun`
hook. Three of those four we have or deliberately refuse; the fourth was
missing. `main()` ended at `return (await cmd.run(state)) ?? state;` with
**nothing after it**, so there was no way to write the thing every app wants: a
handle to close, a lock to release, a duration to report. `src/run-hooks.ts`
fires it, `src/hook-sources.ts` is the walk it shares with `beforeError`, and
the one call site is inside `main()`.

- **`init` is the module being imported, and `catch`-as-recovery is refused.**
  The first is where a command's own setup belongs and there is nothing to add.
  The second is the scope item worth writing down rather than leaving as a gap
  somebody fills in later: oclif's `catch` is a **recovery** hook, and
  `beforeError` is already refused that -- "suppression would have to mean
  something different at every throw site -- what `parse()` returns, whether the
  command still runs -- and a rule that cannot hold everywhere is worse than no
  rule". A hook that could turn a failed run into a successful one has to answer
  what `main()` returns, what the exit code is, and whether the error was ever an
  error, which is that argument one step along. So `AfterRunHook` returns `void`,
  whatever it hands back is ignored, and the result it is handed is frozen --
  the refusal twice over, in the type and at run time.

  The type half is not decoration, and the suite is what said so: the first draft
  of the two tests that assert the runtime ignores a return value **failed
  `pnpm check`**, because `() => 'recovered'` is not assignable to a hook
  returning `void`. So they cast past it, and the cast is the point rather than a
  nuisance -- what is being asserted is the half for the untyped JavaScript
  caller the type cannot reach.

- **`finally` and `postrun` are one hook, because they are one moment.** A
  cleanup, a duration and an exit report all want the same thing: to run after
  `run()` has finished, whichever way it finished. Two hooks would be two
  orderings to keep in agreement and two places to ask whether the command
  failed.

- **It is handed an result rather than a value, and `ok` is the tag.**
  `{ ok: true, value }` or `{ ok: false, error }`, which is what makes it a
  `finally` rather than a success callback: a throw is an **result** rather than
  an exit, so there is one path out of the call site whichever way `run()` went.
  Tagged rather than a value with an optional error beside it because **anything
  at all can be thrown, `undefined` included** -- a shape reading
  `error !== undefined` would report `throw undefined` as a success, and that is
  a test rather than a worry.

- **`result.value` is what `run()` returned, before `main()`'s `?? state`.**
  `main()` answers with the parse state for a command that returned nothing, and
  reporting that as the command's value would be a lie about what the command
  did. It is also what keeps one notion of a command's result, so that a format
  registry reading the same value later reads the same thing -- there is no such
  reader yet, and that half is a shape to keep rather than a fact about the code,
  which a review round was right to make it say. `null` is the second input where
  the two differ, since `??` reads it as nothing too, and it is the one somebody
  writes by accident.

- **Innermost command first, the schema last, through the one walk `beforeError`
  already used.** That ordering is `beforeError`'s own and is right for the same
  two reasons read forwards: a command's own cleanup runs before its parent's,
  and the schema is the only source that sees every command _that ran_, which is
  where telemetry belongs. What makes it one mechanism rather than two is that
  `collectHooks()` moved out of `error-hooks.ts` into `hook-sources.ts`
  parameterized by hook name -- the two firing sites differ in what a return
  value means and in what a throw does, and in nothing at all about whose hook
  fires when. Two copies of that walk is how the command side and the schema side
  come to disagree about ordering.

  Two levels cannot tell `[...contexts, schema]` from `[contexts[0], schema]`,
  which is why the test is three deep: the middle command's own hook is the only
  discriminator there is.

- **A schema hook fires once, and the dedupe is on the hook rather than on its
  source.** The root context is `initCommand()` over a **copy** of the schema, so
  one function is reachable as `contexts.at(-1).hooks.afterRun` and as
  `state.schema.hooks.afterRun`; a `Set` of the hooks is what makes that one
  firing. The other side of the same set is that one function declared on both a
  command and the schema fires once, which is what an app that put one cleanup in
  two places asked for.

- **It fires before `beforeError`, and that is the whole of what makes it a
  `finally`**: a hook flushes its log and the error still reports. `main()` turns
  the throw back into a throw _after_ the hooks, so it reaches `handleError()`
  unchanged -- before the rendering, before a custom `settings.errorHandler`, and
  before the `errorHandler: false` rethrow, each of which is a test rather than a
  sentence.

  "Before `beforeError`" is about **this** `main()` call, which a review round
  was right to ask be qualified: a command running another with a nested `main()`
  has already let that call render its own error by the time it returns, so a
  composition sees the inner call's `afterRun` and `beforeError`, then the
  outer's. That is each call's own error path rather than something this ordering
  could reach.

- **A hook that throws is reported and the next one still runs.** The owner
  tree's rule -- every cleanup runs even when one throws, and what it threw is
  reported rather than replacing the result in flight -- and it is the only one
  that keeps a failed cleanup from costing the user the error they actually
  needed. The sharper half is the **success** path, where there is no error for a
  broken hook to hide behind: a `fireAfterRun()` that let one escape would reach
  `main()`'s own catch and render a cleanup as the command's result. Both
  directions are pinned, as is a rejection, since a hook typed `Promise<void>` is
  one an `async` function satisfies and a `try` cannot catch a rejection it did
  not await.

- **And it does not throw by construction rather than by being careful**: every
  hook is called inside its own `try`, so the loop cannot be left part way
  through, and there is no statement after the loop that can fail. Which is a
  property rather than a claim only since a review round falsified the first
  version of it -- see below.

- **It fires for a command that _ran_, which is all it claims.** A run answered
  by `--help` or by `--version` returns before `cmd.run` is reached; a command
  with no `run` dispatches nothing; a parse that failed never got to a command.
  A `run: null` is in that last group rather than the middle one, which is the
  correction `should fire nothing for a run: null, which initCommand refuses
  outright` carries in full: `Command.run` is typed `| null`, so `null` reads as
  the spelling for "dispatches nothing", and `initCommand()` **refuses** it with
  `Invalid run function` -- so the parse fails and this is silent for the reason
  every parse failure is. That type permits what the runtime throws on, which is
  why `Schema.run` is not spelled the same way. None of those has an result to hand over, and
  inventing one would mean answering `ok` for a run that did not happen. Each is
  a test, and the parse-failure pair is two tests rather than one: a **validation**
  failure and a **coercion** failure are two different throw sites -- one happens
  while argv is being judged and the other while it is being read -- so a test
  that used only the first would pin one of two. Both assert that `beforeError`
  _did_ fire, which is what stops them passing because nothing happened at all.

- **The framework's own `completion` command fires it, and that is the honest
  answer rather than a surprise.** `help` and `--version` return before
  `cmd.run`, and `completion` is an ordinary command with an ordinary `run` --
  which this file already records in as many words, "it is an ordinary command,
  so a required option is still required". So a telemetry hook sees it, and it is
  written down because a reviewer would otherwise report it as a defect.

- **A nested `main()` fires it once per command rather than twice for one, and
  that is why it does not have `beforeError`'s recorded bug.** That one is **one
  error reported twice**, because `main()` records `hooksFired` only for its own
  `parse()`; this is **two commands each reported once**, which is what `afterRun`
  means -- the inner step finished and so did the command that ran it, and a
  telemetry hook wants both. Measured: a schema hook over a `build` that nests a
  `clean` sees `clean:ok` then `build:ok`. Where the inner call rethrows, the
  outer command's result is `{ ok: false }` carrying the **same error object**,
  because that is what the outer command threw -- one result per command rather
  than one error reported twice, which the test asserts by identity.

- **What it costs is nothing measurable, and the in-process number is the one
  that says so.** Six interleaved rounds of 2,000 full `main()` dispatches of a
  command that declares no hook: **0.0266 ms against 0.0259 ms** per dispatch on
  the median, which is the branch _faster_, and main's own six samples span
  0.0239 to 0.0272 -- wider than the apparent delta. Run again against the
  shipped build it is **0.0244 against 0.0231**, the branch faster again and
  every number lower, which is the check this repository insists on: the
  baseline moved more between two runs of one binary than the two binaries
  differ from each other. Spawned, 40 interleaved and
  order-alternated pairs, three runs: `--version` is 30.10 / 29.38 / 29.72 ms
  against 30.21 / 29.19 / 29.76, which is indistinguishable and has to be, since
  `--version` returns before `cmd.run` and none of this is on that path. The
  absolutes are high because three other agents were building; the delta is the
  claim, and the check is that the baseline agrees with the baseline -- main's own
  dispatch median moved 0.9 ms across the three spawned runs, which is more than
  the branch delta.

  Statically it is **+459 bytes on the root entry, 7,518 B to 7,977 B over the
  same six modules** -- no new chunk, because `hook-sources.ts` and
  `run-hooks.ts` are small source modules rolldown folds into the chunk
  `index.mjs` already reached. Against the 20 kB ceiling in `dist.test.ts` that
  is 39%, so the headroom that entry is about did not move. Re-measured after
  every change that moved it, which a review round had to ask for: the figure
  read 7,947 B before round 1's own fixes and 8,014 B before the two guards they
  made redundant were deleted, so a number carried rather than re-run is the
  stale snapshot this file keeps warning about. `dist.test.ts`'s two comments
  about the same entry were stale with it, and the 5.06x ratio the config graph
  quotes is 4.78x now.

- **The timing line is the first consumer of the result, which is why it is
  written off the result rather than off two locals**: it reads the two things a
  hook is handed, so a shape that could not say whether the command failed, or
  how long it took, is a shape it could not have been written over.

  ```
  [2026-01-01T00:00:00.000Z] sigil Executing command "build"
  [2026-01-01T00:00:00.000Z] sigil Command "build" returned after 41.028ms
  ```

  It shares `Executing command`'s namespace rather than taking one of its own,
  because the pair is the point -- one `DEBUG=sigil` gives both halves, and
  splitting them would mean `2>/dev/null` losing one. A hook's **own** failure
  goes to `sigil:run`, which is that module's namespace exactly as
  `error-hooks.ts` owns `sigil:error`.

  Both are `log` and therefore **stdout**, matching `Executing command` and
  `error-hooks.ts`'s own confession for a `beforeError` hook that threw: two
  reports about a user hook that threw, on two streams, would be the
  inconsistency. That a `DEBUG=sigil` line goes to stdout at all is a question
  about every such line there already is rather than about these two, and is left
  alone.

- **`performance.now()` rather than `Date.now()`, and a sabotage is what made
  that a test.** Monotonic, so a system clock that moved mid-command cannot make
  a duration negative, and sub-millisecond, where `Date.now()` reads `0` for
  anything quick -- which is most commands, and a timing line that says `0ms` for
  all of them is one nobody reads twice. Reading the _second_ clock off
  `Date.now()` and the first off `performance.now()` makes `ms` an epoch
  timestamp, about 1.76e12, which satisfies every lower bound there is -- so the
  duration tests carry an **upper** bound of a minute as well. Not the flaky kind
  of upper bound: it is not calibrated against the sleep, it is calibrated against
  the gap between a duration and a timestamp, and a minute sits twenty-nine
  million times under one.

- **A non-function is refused where it is _declared_, and ignored where it is
  assigned later.** `'afterRun'` joined `initCommand()`'s list, which is what
  covers a command -- without it an `afterRun: 'nope'` would parse and then do
  nothing at all, which is the property that parses and silently lies.
  `parse()`'s own check covers the **schema** and needed no telling, because it
  walks `Object.entries(schema.hooks)` and was therefore generic over `afterRun`
  before it existed; it runs first, so its message is the one the schema side
  gives. Two checks rather than one, which is pre-existing and is why the two
  tests assert two different messages.

  A value assigned **later** -- by a `parse` hook, by a `run()`, by another hook
  -- is past every check this framework has, so `collectHooks()` skips it rather
  than confessing. One rule for every hook there is, rather than a fourth
  confession in the one walk that could not have prevented it anyway. A review
  round was right that the three behaviours wanted one written rule; this is it.

- **`runCommand()` needed no wrap, and "by construction" is exactly the kind of
  claim this repository checks rather than states.** `@ttylabs/sigil/testing`
  wraps `afterParse` and `beforeError` on a **copy** of the schema and spreads
  the rest, so a caller's `afterRun` is passed straight through -- and the
  deduping is on **function identity**, so a copy that produced a different
  function would have stopped it firing. It does not: a spread copies the
  reference. Pinned on both paths, a run that returned and a run that threw.
  Nothing was added to `RanCommand`: a test that wants the hook's `result`
  declares an `afterRun`, and a field there would be surface with no caller.
  That one already has a `result` of its own and it is a different thing --
  what `main()` returned, rather than the tagged union `run()` came to -- so
  the two are told apart by `RunResult` rather than by the field name.

> Moved: _What the sabotage pass found, and the two declared survivors_, _What review round 1 found, and the two it got wrong_, _What review round 2 found, and the one it got wrong about the input_, _And the full suite found a test of mine passing for the wrong reason_, _What review round 3 found: no error-path defect, and four figures_ — see [docs/history/an-afterrun-hook-finally-postrun-and-the-telemetry-seam-in-o.md](../../../../docs/history/an-afterrun-hook-finally-postrun-and-the-telemetry-seam-in-o.md).

### "Did you mean": the nearest thing the reader could have typed

`Unknown option "--verbsoe"` tells the reader nothing they did not already know.
`src/parser/suggest.ts` is the whole of it: an edit distance and a subsequence
match over the registries the parse has already built, offered at the three sites
where something did not resolve, and `settings.suggestions: false` is the opt-out.

- **The ticket named the wrong site, and there are three.** It called this "a
  message change plus a call, in the one place that throws `Unknown command`", and
  that place is only ever reached by `mycli help buidl`. Measured by running a
  parse before anything was designed: **a mistyped top-level command does not
  throw `Unknown command` at all.** Commands resolve against the innermost
  context, an unmatched token falls through to the positional arguments, and with
  none left to take it it lands on `Unexpected argument "buidl"` -- which is the
  commonest case by a long way and the one the ticket's framing misses. So the
  sites are `parse.ts`'s `Unexpected argument` (a mistyped command, and the only
  one an ordinary app reaches), `parse.ts`'s `Unknown option` (only where
  `allowUnknownOptions` is `false`, which it is not by default, so the ticket's
  headline example is the one nobody sees), and `help.ts`'s `Unknown command`.

  Which is also why `Unexpected argument` offers **commands** rather than
  arguments: the command pass tries every unmatched token against the innermost
  context whatever its position, so a position where this throws is a position
  where a subcommand name would have matched.

- **Two metrics, because they answer two questions, and the measurement is the
  whole argument.** The ticket's premise was that `rankBy()` is "a better matcher
  than Levenshtein for what people actually mistype", and over a corpus of fifty
  real typos the subsequence match answers **13** and an edit distance **44**,
  where the two together answer **49**. Every transposition is invisible to a
  subsequence match, because `buidl` simply is not a subsequence of `build` --
  which is the ticket's own headline, `--verbsoe` against `--verbose`, and
  twenty-two of the corpus besides. Every abbreviation -- `dpl`, `ver`, `bld` --
  is past any edit-distance floor worth having, and the subsequence match is
  what recovers those five. So neither replaces the other and both earn their
  keep as numbers rather than as a preference.

- **The distance is Damerau rather than Levenshtein, and that is most of the
  feature rather than a refinement.** A transposition is two edits to plain
  Levenshtein, and every floor tight enough to be safe refuses two: measured, the
  same corpus at the same floor answers **44** with the transposition priced at
  one and **17** without it. `verbsoe`, `buidl`, `tset`, `hlep`, `lgoin` and
  seventeen others are all exactly that.

- **The floor is a rate rather than a constant: one slip per three characters,
  with a floor of one, on the shorter of the two.** Swept against the corpus and
  against thirty-six tokens that must offer nothing: a flat cap of **1** answers
  44 and misses a double slip in a long word (`insatlll`, `verisno`), a flat cap
  of **2** answers 46 and offers something for **seven** of the thirty-six --
  `help` for `hello`, `db` for `q`, and something for the empty string -- while
  one-per-three answers 46 by itself and refuses every one of those. It is written
  as a rate because what it states is how often a finger slips, which is a thing
  that scales with the word.

- **And a suggestion has to have something in common with what was typed**, which
  is a distance strictly below the shorter string's own length. That is one line
  and it is load bearing for one reason: a short option is one significant
  character, so `-x` and `-v` differ by one in a string of one and the rate reads
  that as an ordinary slip. Without it every short option in the app is offered
  for every mistyped one, which is the whole feature unusable.

- **A tie is no answer.** Two candidates equally near is one right answer and one
  wrong one, and choosing between them would choose by registration order -- which
  for a directory of command modules is whatever the file system felt like, and is
  what this file refuses everywhere else. So `cat` against `car` and `cab` offers
  nothing, and `ver` against `verbose` and `version` offers nothing, which is
  exactly the case where the reader should be reading help.

- **An abbreviation starts with the same character, which is the principled
  version of a score threshold.** The subsequence half needed a floor and the
  obvious one is a score or a coverage ratio; what it got is a prefix rule,
  because that is what an abbreviation _is_. Measured, it is the difference
  between the subsequence half paying for itself and not: `out` is a subsequence
  of `logout` and is an ordinary output directory, so without the prefix rule the
  five hits it adds cost a false positive on a real argument value. Nobody
  abbreviates `deploy` as `epl`. A one-character query is refused on top, which is
  what stops `a` offering `add`; a floor of three buys nothing over two, so it is
  two and `a` is the input that makes it matter.

- **A near miss beats an abbreviation, and the one miss that ordering costs is
  the honest one.** `inst` is one slip from `init` and an abbreviation of
  `install`, and the reader whose finger slipped is the likelier of the two. It is
  in the table as `inst -> init` rather than being left out of it.

- **One false positive survives and no metric can remove it.** `dist` is one
  character from `list` and is also an ordinary directory name. A token one slip
  from a command name is indistinguishable from a typo of it -- oclif and git have
  the same property -- so it is written down and pinned as the declared limit
  rather than guarded.

- **The candidate set is one level, which is the resolution rule honoured rather
  than a shortcut.** `commandTokens()` reads the innermost context's own registry
  and `optionTokens()` reads every context's, and that asymmetry is deliberate on
  both sides: commands resolve against the innermost context while options resolve
  across the whole chain, so those are exactly the tokens that would have resolved
  where the reader typed one. Suggesting a sibling of the context argv ended up in
  would be offering something that also fails.

  The ticket pointed at `commandCatalog()` instead, whose labels are paths from
  the **root** -- so `migrate` typed at the root would offer `db migrate`, which is
  genuinely typeable and is what oclif's flat command ids give. It is refused for
  two reasons and the first is the one that decides it: a **routed** tree's deeper
  registries are empty until something walks them, so a multi-level suggestion
  would work for an inline schema and silently not for the routed one `sigil new`
  scaffolds -- two apps behaving differently according to how each declared its
  tree, which is the defect shape this file keeps recording. Walking to fix it is
  the thing the deferral exists to avoid. And the catalog is a palette projection
  that builds `slotsFor()` per entry, which a suggestion has no use for.

- **Aliases are candidates and a `hidden` command is not.** An alias is a token
  somebody can type, and a transposed `sl` for a declared `ls` is exactly the typo
  this is for. `hidden` means "not listed", and a suggestion is a listing of one.
  The parser's own `--help`, `--version` and, since the quiet axis landed,
  `--quiet` are in, because they are typeable and real and `--hepl` is worth
  answering -- and so are the **commands** it registers, which is `help` and,
  since shell completion landed, `completion`. The candidate
  lists in `suggest.test.ts` are written out rather than filtered, so a third
  parser-owned command is a test somebody has to extend rather than a set that
  silently grew.

  The candidates are a `Set`, and that is not tidiness: an alias really can be
  declared on two commands -- the registry keeps the last for routing and both
  commands keep it in their own alias set -- so without it the shared spelling
  appears twice, ties with itself, and refuses a suggestion it should have made.

- **An option is compared with its dashes off, on both sides.** With them on,
  `-x` and `-v` are two characters of which one differs, which is the rate reading
  a one-character slip into a two-character string; stripped, they are one
  character each and the "something in common" rule refuses the pair. It is also
  what makes the one case where the _dash_ is the typo work: `--p` against a
  declared `-p` strips to `p` on both sides, which is a distance of nothing and
  the strongest suggestion there is. So an exact match on the stripped names is
  allowed rather than skipped, and it is reachable rather than dead -- a candidate
  whose own spelling equals what was typed cannot be in the list, because the
  parse would have resolved it instead of failing.

- **It is a sentence of its own rather than a suffix, which is three keys instead
  of one.** `Did you mean "{0}"?` appended with a space is one key and is wrong
  for the reason this file's i18n section is written for: the joiner and the order
  are the translator's, and a Japanese catalog wants `。` with no space between the
  two. So each site has a suggesting twin --
  `Unexpected argument "{0}". Did you mean "{1}"?` and its two siblings -- which is
  58 keys where there were 55, each a complete sentence whose slots a translator
  can reorder. `i18n.test.ts` carries a German translation of all three that puts
  the suggestion **first**, which is what makes that a check rather than a claim.

- **It is computed inside the `if` that throws, and the cost is zero rather than
  small.** Every candidate comes from a registry the parse had already populated:
  the root's level is read while the schema is built, and every deeper level was
  read by the `loadCommand()` that put that context in the chain. So a suggestion
  over a **routed** tree is a walk over a `Map` and not one byte of I/O --
  measured, `mycli build` and `mycli buidl` each read **one** directory, and
  `db migrate up` and `db migrate pu` each read **three**, with the typo offering
  `up`. `test/parser/suggest-cost.test.ts` counts `readdirSync` for that and counts
  every call that crosses the boundary into the module for the other half: a
  successful parse does not enter it **at all**, over seven argvs including a
  dispatched subcommand and `--help`.

  What that costs is the deferral's own cost rather than a new one: `pu` typed at
  the **root** offers nothing, because `db/migrate/` has not been read and `up` is
  not a token that resolves there anyway. The same answer help gives.

- **`fuzzyMatch()` moved to `src/util/fuzzy.ts`, because `src/parser/` may not
  import `src/components/`.** That is the move `seeded()` and `Random` already made
  to `src/util/random.ts`, for the same reason and in the same words -- the
  dependency already runs the other way, since `src/help/` imports
  `OptionRegistry` as a value. `rankBy()` and `highlightRuns()` stay where they
  are, because they are the half that is about a _list_ and about _drawing_, and
  `highlightRuns()` is the only thing in that file that reaches for `graphemes()`.
  `@ttylabs/sigil/components` re-exports it, so the public API is exactly what it
  was.

  The layering argument is enough on its own and the bundle agrees with it, which
  was worth measuring rather than assuming: importing `components/fuzzy.js` from
  the parser puts `width`, `strip` and `codes` on the parse chunk's graph and
  takes it from **38,847 B to 43,461 B** over 12 chunks rather than 9. Rolldown
  does **not** shake the segmentation back out, which is the thing a reader would
  guess and which the measurement refutes. `should not drag grapheme segmentation
  in to suggest a command` is the guard, written as a whole-chunk absence rather
  than a byte ceiling because what is being pinned is which modules are reachable.

- **The root entry is untouched, byte for byte.** 7,553 B before and 7,553 B
  after, against the 20 kB ceiling, because `parse()` is behind an
  `await import()` and none of this is on the path that answers `--version`. The
  parse chunk goes from **36,381 B to 38,847 B** -- +2,466 B, +6.8% -- on a chunk
  nobody loads until a parse happens. `components.mjs` moves by **32 bytes**, which
  is the re-export.

- **The cost is bounded by the candidates rather than by argv, and that took a
  measurement to notice.** An edit distance is at least the difference in length,
  so a length pre-filter refuses exactly the pairs the rate would refuse anyway
  and changes no answer -- what it buys is that nothing walks the matrix per
  candidate: a 100,000-character token against twenty-eight ten-character commands
  is **78ms** without it and **5.9ms** with, and an argv token really can be a very
  long path. The 5.9 is the one fold and the one count of the token itself, which
  is why it is not nothing. It is linear rather than quadratic, which is why this
  is a cost guard rather than a hang: the inner loop is over the candidate.

  It must be written `>` rather than `>=`, because a filter tighter than the floor
  it stands in for changes answers -- `instaalll` is two code points longer than
  `install` and two edits from it, and the rate at that length allows two.
  `should offer a candidate at the exact length the rate allows` is the pin, and
  it took constructing the boundary rather than finding a realistic typo.

> Moved: _What the first review round found, and it was two limitations rather than a bug_, _What the second review round found, and it was all claims rather than code_, _What a third round found: the dotted capital I, and the line that settles it_, _And its second round, which found three assertions that could not fail_, _What the sabotage pass found_ — see [docs/history/did-you-mean-the-nearest-thing-the-reader-could-have-typed.md](../../../../docs/history/did-you-mean-the-nearest-thing-the-reader-could-have-typed.md).

#### What is deliberately out

- **A list of suggestions**, which is git's answer ("The most similar commands
  are"). One is an answer and three is a menu, and the floor is what makes one
  right -- with `--help` one line away for the case where the reader wants the
  menu. The tie rule is the honest version of "we cannot tell": it says nothing
  rather than saying three things.
- **Prompting to run it**, which is oclif's. Prompting from an error path means
  prompting where the caller may be a script, which is the rule `PromptError` is
  written for, and the palette is the place for "help me find it".
- **A suggestion on a bad `choices` value.** `--mode=prduction` against
  `choices: ['production', 'development']` is the same mechanism and would be the
  most valuable site of all -- and what is wrong there is that
  `Invalid value "{0}" for {1}` does not **name the choices**, which it has in
  hand. Listing them is the better fix and is a different ticket; guessing one of
  them is the consolation prize for not having listed them.
- **A multi-level suggestion**, with the routed-tree asymmetry above.
- **An `Extra arguments` suggestion.** What follows `--` goes through whole, which
  is a recorded decision, so there is nothing it was meant to be.

### `:` as a topic separator, a tokenizer alias and nothing more

oclif's default is `my:awesome:command`, and Heroku, Salesforce and dokku all
read that way, so it is muscle memory for a lot of people even though nobody
here likes it. `schema.topicSeparator: ':'` is the whole declaration;
`src/util/topic.ts` is the spelling and `src/parser/command/topic.ts` is the
resolution.

- **It is a tokenizer change and not a resolution change, which is why it is
  small.** `parseArgv()` resolves a command by
  `contexts[0][Internal].commands.find(subject)` one token at a time, unshifting
  the match onto the chain -- so a coloned token needs no new resolution path at
  all. One token becomes several commands and the loop that already walks
  `db migrate up` is the loop that walks them. Routes are untouched:
  `db/migrate/up.ts` produces the same tree either way, the baked tree
  `sigil build` emits does not care, and neither does the palette's catalog.

- **The one hazard is that a positional value holds a colon all the time**, and
  the rule that closes it is: try the token **whole** first, because a command
  may legitimately be _named_ with a colon; then split; then use the split only
  if **every** segment resolves as a command against successively inner
  contexts. That is non-destructive by construction rather than by a list of
  exceptions -- a URL, `host:port`, `node:22`, `10:30` and a drive-relative
  `C:foo` are each left alone because `http`, `localhost`, `node`, `10` and `C`
  are not commands. Where the first segment is not one, which is the
  overwhelming case, it costs one `Map` lookup and reads nothing.

  **Trying it whole first is what settles the precedence question, and it has to
  be that way round.** A command literally named `db:migrate:up` wins over a
  path spelled the same way, at any depth, because the registry is asked for the
  whole token before anything is taken apart -- and a literally named command is
  the one spelling that also works with the separator **off**, so it cannot be
  the loser. There is nothing in between whole and segments: a literal
  `db:migrate` is never read as the first _segment_ of `db:migrate:up`, since the
  split is on every separator. A longest-prefix walk is the plausible
  alternative and is refused -- a lookup per prefix on every coloned token, to
  disambiguate a schema that declared one path two ways. Each token still has
  one answer, `db:migrate` reaching the literal and `db:migrate:up` reaching the
  path, and the path stays reachable in the space form. Pinned at three segments
  as well as two, because "the registry has no opinion about how many
  separators are in a name" is a claim rather than an observation.

  `db:bogus` is the sharp half and is what says the rule has to be _every_
  segment rather than the first: `db` really is a command, and taking it would
  leave `bogus` to land on whatever argument `db` declares -- a value eaten by
  a command nobody named. The token reports whole.

- **Both forms work, and that is cheaper than refusing one.** oclif's
  `topicSeparator` is a choice between the two; here the colon form is added
  beside the space form, which the repository would normally refuse as two
  spellings of one thing. The reason it is allowed is arithmetic rather than
  taste: the "every segment resolves" rule means the space form already goes
  through the ordinary loop untouched, so refusing it would be code added to
  take something away. Mixed forms fall out of the same fact --
  `mycli db:migrate up` works because the first token's segments resolve and
  `up` is then an ordinary token -- so they are a test rather than a feature.

- **`' '` and `':'` and nothing else.** A `.` collides with a version number, a
  `-` with option syntax, and a separator the parser has to guard against its
  own grammar is a knob nobody can be given safely. Refused unconditionally in
  `parse()`, beside `outputFormats()` and for its reason: only a coloned token
  would ever read the answer, so an app whose separator is `'/'` would
  otherwise run for months and then refuse the one invocation that used it.

- **An empty segment refuses the token before anything loads**, and that is the
  one guard here that changes no answer. `find()` refuses an empty name
  already, so `db:` would be refused one step later anyway -- after `db` had
  been **loaded** to find out what is under it. A trailing colon is something a
  value has, so what the check buys is that a value never imports a module.
  Pinned by a test that counts loads, because an unreachable guard is a thing
  this repository deletes and the outcome alone cannot tell the two apart -- it
  passed its own sabotage until that test existed.

- **A refused path's loads are recorded rather than dropped, and that is the
  half that could have been a silent lie.** Finding out whether the next
  segment resolves means reading the level above it, and loading is the one
  thing the walk cannot undo. `loadCommand()` answers a second call with the
  **placeholder** it was given, so a load whose result was thrown away would
  mark that placeholder loaded and leave a later match in the same parse
  holding a command with the declaration and none of the module -- no `desc`,
  no `run`, the shape this file already calls worse than an error. So the
  loaded command goes back into its parent's registry, which is the mutation a
  `parse` hook is already handed and which carries the placeholder's aliases,
  label and `default` across. It is also what keeps `subcommandLoaded` firing
  exactly once, since the registry hands the loaded command over and nothing
  loads it again.

  Measured rather than reasoned: `config:bogus config` on a routed tree answers
  with `config`'s own `desc` and `run` with the swap and with neither without
  it. A **directory** route is the case that makes the test subtle, because
  reading the level mutates the placeholder -- so `config:bogus config set`
  resolves `set` either way and only the intermediate command's own module is
  lost. The assertion is on the intermediate command for that reason.

- **A matched command joins the chain before its module loads, and a refused
  path comes back off it.** That is the contract the space form keeps in as
  many words at both of its own call sites -- a module that will not load is an
  error this command's own `beforeError` hooks should still see -- so the walk
  grows `contexts` as it goes rather than committing at the end, and a
  _refusal_ splices back off exactly what it added. The distinction is the one
  the rule rests on: a refusal is a token that was never a path, where a throw
  is a command that really did match. Both are pinned, and the second against
  the space form's own answer rather than in isolation -- `db:migrate` over a
  `db` whose `load` throws fires `db` then the schema, which is what
  `db migrate` fires.

- **One divergence from the space form, and it is intrinsic rather than an
  oversight.** A command contributed by an **ancestor's `parse` hook** is
  reachable by `mycli db migrate` and not by `mycli db:migrate`: that hook
  fires when a command is committed, and no hook on the path may fire until the
  whole path has resolved, so the hook that would add `migrate` has not run
  when `migrate` is looked for. Firing them as the walk went would commit half
  a path that then failed, which is the one thing the atomic rule exists to
  refuse. Options are unaffected, because every hook on the path fires at the
  one token and before the rest of argv is read -- both halves are pinned, the
  option that works and the command that does not.

- **One `ParsedCommand` per command rather than one per token, each carrying
  the segment as it was typed.** Everything downstream counts those entries --
  `asked()` trims a help chain back to the commands argv _named_ -- so a token
  that named three has to count as three or `mycli db:migrate --help` would
  describe the wrong command. The `inputs` is the segment rather than the
  command's name, because `state.$` is what argv said and `d:m` reaching `db`
  and `migrate` through their aliases is exactly the case where the two
  differ.

- **The separator reaches the usage line and deliberately not the command
  list.** A CLI configured for colons whose usage line prints spaces is telling
  the reader to type something other than what it chose, and the usage line is
  the one place help prints a _path_. The `Commands:` list is the children of
  the command being described, so a row is a name rather than a path -- and the
  space form still works, so `migrate` is typeable exactly as printed. oclif
  prints full ids there because its help is flat; ours is hierarchical.

  No plumbing was needed for it, which the ticket expected to be the expensive
  half: `HelpTarget` has carried a `schema` since the usage line needed a
  program name, and `resolveHelp()` already fills it. A caller handing
  `renderHelp()` a bare context chain gets the space form.

- **`help db:migrate` answers through the parse's own rule rather than a second
  one.** `resolve()` tries the name whole, then the split, then refuses -- and
  the message is what that buys. Splitting on the first segment alone would be
  better for `help db:bogus`, which could then say `Unknown command "bogus"`,
  and it would report `Unknown command "http"` about a URL. One rule and one
  message about one token is worth more than a marginally sharper message about
  the case that is already an error.

- **A build carries it for nothing, which is the `formats` precedent.**
  `generateBin()` writes `commands`, `version` and `defaultLocale` over a
  runtime `{ ...schema }`, so an ordinary schema property comes across whole --
  measured on the `buildable` fixture with `topicSeparator: ':'` added:
  `db:migrate` and `db migrate` both run and the built app's usage line reads
  `buildable db:migrate`. No fixture is committed for it, because what would be
  pinned is the spread rather than anything of this feature's.

- **The spelling and the resolution are two modules, and `./help`'s graph is
  why.** `topicSeparator()` and `splitTopic()` are pure functions of a schema
  and a string; `resolveTopic()` needs `loadCommand()`. One module holding both
  put the whole command loader on the `./help` entry's graph to read a
  one-character answer -- measured, **161,274 B over 22 modules to 178,555 B
  over 25**. So the dependency-free half lives in `src/util/topic.ts`, which is
  `src/util/fuzzy.ts`'s own move for its own reason, and help imports only
  that.

  What it comes to is **291 B** of shared chunk: `index.mjs` is **11,991 B over
  7 modules**, byte for byte what it was, because none of this is on the path
  that answers `--version`; `help.mjs` is 161,274 B over 22 to **161,674 B over
  23**; and the parse chunk is 49,573 B over 13 to **50,548 B over 14**.

> Moved: _What the sabotage pass found, and the guard that passed its own_, _What the by-hand audit found: the help plumbing was already there_, _And a measurement that moved a module_ — see [docs/history/as-a-topic-separator-a-tokenizer-alias-and-nothing-more.md](../../../../docs/history/as-a-topic-separator-a-tokenizer-alias-and-nothing-more.md).

#### What is deliberately out

- **A generated completion script that offers the colon form.** Both forms
  work, so what the script offers is typeable -- which makes this a missing
  completion rather than a wrong one, and the distinction is the one this file
  draws for `choices` on a format option. The reason it is missing is that a
  coloned path is **one shell word** with `:` inside bash's own
  `COMP_WORDBREAKS`, so completing it is a rewrite of how `bash.ts` and
  `zsh.ts` read the current word rather than a separator threaded through.
  `path.join(' ')` in both emitters is a **case-arm key** matched against the
  words a shell split, not something a reader is shown, so nothing there is
  printing the wrong separator today.

- **The markdown command reference.** `packages/cli/src/reference/markdown.ts`
  prints a command path a dozen ways, and an app that chose colons would want
  its reference to read in colons. It is a documentation generator rather than
  something a user types against, both forms work, and it carries a surface
  snapshot that every one of those lines would churn -- so it is additive later
  and is a ticket of its own.

- **A suggestion for a mistyped segment.** `mycli db:migrat` reports
  `Unexpected argument "db:migrat"` with no suggestion, because the candidates
  are the innermost context's own tokens and `db:migrat` is near none of them.
  Offering `db:migrate` would mean suggesting a **path**, which is the
  multi-level suggestion already refused one entry along for its own reason --
  a routed tree's deeper registries are empty until something walks them, so it
  would work for an inline schema and silently not for the routed one
  `sigil new` scaffolds. Measured that it offers nothing _wrong_, which is the
  half that matters: `db` is seven edits from `db:migrat` and the rate refuses
  it.

- **A separator on the `Commands:` list**, with the hierarchical-list reason
  above.

- **A per-command separator.** It is a property of the whole CLI -- a tree that
  spelled one level with colons and the next with spaces is a tree nobody can
  read -- so the schema is the only place it can go.

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

### `@ttylabs/sigil/coerce`: the parser's coercion, published on its own

SIG-201. `transformValue()` is what the parser turns a string into a typed value
with, and it had no published home, which is why `date()`, `number()` and the
command palette could not be ejected: `sigil add` rewrites a component's relative
imports to published subpaths and `../util/transform.js` had none. Three
components were copyable for want of one export. The three components' own
entries (`src/components/AGENTS.md`) used to say it was refused for being a new
public surface taken inside a prompt ticket; this is the ticket that takes it, on
purpose.

- **A new subpath, `@ttylabs/sigil/coerce`, and not a name on an existing one.**
  Not the root: the root has a ceiling in `dist.test.ts` and this is parser
  weight, which is what a command that only answers `--version` should not load.
  Not `/components` either: the parser coerces with it, and a subpath named for its
  consumers would have the parser importing from a UI barrel. Measured as of this
  entry: `coerce.mjs` is a 75 B entry over the existing shared `transform` chunk,
  7,529 B over four modules once its imports are counted; the root entry's static
  graph is the same seven modules, 12,264 B before and 12,269 B after -- the five
  bytes are rolldown's chunk names moving because there is one more entry, in
  `src` and `help`, and `test/dist.test.ts` pins that `coerce` is not in the root
  graph. `components.mjs` went from 279,079 B over 30 modules to 279,211 B over 31:
  the extra module is the 75 B entry, since the components now import
  `../util/coerce.js`.
- **`transformValue()` and `daysInMonth()`, not the file.** The entry is
  `src/util/coerce.ts`, a two-name re-export, and not `transform.ts` itself. That
  module also holds `DATA_TYPES`, `OPTION_DATA_TYPES`, `checkValue()` and
  `assertChoices()`, which are the parser's and a config schema's business, and
  publishing the file would make each of them a contract by the act of exporting
  it. What is promised is the **signature of `transformValue(value, type)`**, the
  types it accepts and the **sentences it throws** (`Invalid integer: eight`,
  `Invalid date: "2024-02-30"`): those are the parser's, they are what
  `--port eight` prints, and a prompt that wants the same sentence needs the same
  function. `test/coerce.test.ts` pins the exact export list, so a third name is a
  decision somebody makes.
- **The smaller "coerce a string to a declared type" was considered and refused.**
  A second, narrower function that the parser also called would be a refactor of
  the parser inside a registry ticket, and a function the parser does _not_ call
  would be a second reader of the rule, which is the defect this exists to avoid.
  So there is one function, and the subpath is the face it shows.
- **`daysInMonth()` goes with it.** The date prompt steps a day against the month
  it is in and has to agree with the parser about how long that month is
  (including `Date.UTC`'s reading of years 0-99), so it goes the same way rather
  than being copied into the ejected file.
- **The components import `../util/coerce.js`, and the parser keeps importing
  `transform.js`.** The registry generator maps a source path to a subpath through
  the tsdown entry list, so the path a component writes has to be the entry's.
  `coerce.ts` has no code of its own, so mocking `util/transform.js` in
  `date-parser.test.ts` still replaces the one function both reach.
- **Registry.** `date`, `number` and `palette` are in `ENTRIES`. The generator
  also learned `BARRELLED`: the palette imports a type from `../types.js`, which
  no entry names but the root barrel re-exports whole, so `src/types.ts` maps to
  `@ttylabs/sigil`. `number` additionally needed `layoutField()` and `fieldLayers()`
  in the components barrel (see "A number prompt" in `src/components/AGENTS.md`).
  `test/registry.test.ts` now asks the built bundle for every value name each
  entry imports, which is the check that would have caught the second one.

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
