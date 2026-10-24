# `packages/sigil/src/completion` — deliberate decisions

These are the entries from [../../../../AGENTS.md](../../../../AGENTS.md) that are about this directory. Claude Code loads this file when it
works with files here; other agents should read it before changing
anything in this area. The root `AGENTS.md` holds the rules that apply
everywhere and still applies in full.

How each of these was arrived at — the review rounds and sabotage
passes — is under [docs/history/](../../../../docs/history), linked from
the entry it belongs to.

## Deliberate decisions — do not "fix" these

### Shell completion, printed from the tree the parser already holds

A CLI framework with no tab completion is incomplete, and it is the cheapest of
the oclif-parity gaps because there is no data to invent: every name, alias,
description, `hidden` and `choices` a shell could offer is something the app
already declared to the parser. So the work is a printer rather than an
extractor. `src/completion/spec.ts` reads the tree, `bash.ts` and `zsh.ts` print
it, `shells.ts` is the set, and `src/parser/completion.ts` is the `completion`
command, wired beside `registerHelp()` and `registerVersion()`.

- **The script is static, and the number that decided it is not the one the
  ticket guessed.** The alternative is a script that shells out on every tab --
  `app --completions-for "$COMP_LINE"` -- which can complete a value a command
  _computes_ and pays a process per keypress. The ticket put that at about 24ms,
  which is `--version`'s cost; answering a completion query is a **parse**.
  Measured here on node 26, forty spawns per figure, three runs agreeing within
  a millisecond: `node -e 'process.exit(0)'` is **24-26ms**, a `parse()` of a
  two-command inline app **32-33ms**, and a `parse()` of a three-level **routed**
  tree -- one `readdir` and one `import` per level argv names -- **36-38ms**. So
  a tab is **eight milliseconds of work above a bare node start** on the
  smallest app there is and **twelve** on a small routed one, which is 33-38ms
  of wall clock per keypress, and it grows with the tree rather than with what
  is being completed.

  **The figure this entry first carried was 49.6ms and was wrong by a factor**,
  which is worth keeping rather than quietly correcting: it put a two-command
  `main()` parse at almost exactly what `--help` costs on the same machine, and
  the rule this file already states is that a number which disagrees by that
  much is a harness to go and read rather than a machine to blame. The most
  likely cause is a harness whose app rendered a screen -- a failed parse or an
  implied help -- which is the renderer rather than the parse, and it is stated
  as a hypothesis because the harness is gone. The decision does not move: 35ms
  a tab is still perceptible, it still scales with the tree, and the half that
  decided it was never the milliseconds anyway.

  The other half is that **nothing in the data model declares a value
  completer**. `choices`, `bool` and `yesno` are lists the app has already
  written down; "ask the command what the valid values are" would be a new
  declaration surface on `Option`, which is a feature rather than a printer. And
  a dynamic script is the static script _plus_ a subprocess, so the dynamic shape
  is strictly the larger one. What is built is therefore the smaller thing that is
  honestly complete, and what it cannot do -- a branch name, a running container,
  a row in a database -- it says it cannot do rather than half-doing.

- **Static, and generated at _run time_ by the app rather than at build time by
  the toolchain -- which is the shape the ticket's own framing of "static" did
  not name.** `sigil build` emitting `app.bash` was the obvious reading and it
  cannot work: `ResolvedCommand` carries `name`, `desc`, `hidden`, `kind` and
  `module` and **no options and no arguments**, because nothing lifts an option.
  Getting them means reading an app's source for them, which is the extractor
  this is not -- and an _unbundled_ app never runs `sigil build` at all, so the
  whole dev loop would have no completion. Generating from the live initialized
  schema has neither problem and is still a static script: the data is baked into
  the file, so a tab costs no process.

- **So the printer is in the runtime, and that costs the root entry nothing.**
  `@ttylabs/cli` is the natural home for a pure printer -- it is toolchain work
  like the utility generator -- and it is the wrong one here, because the command
  is the _app's_ and what `sigil build` produces depends on nothing. Measured:
  the root entry's static import graph was **7,553 bytes before and after**, since
  `run` reaches the emitters through `await import()` exactly as `main()` reaches
  the parser and the help screen. The emitters are **one chunk of 15,943 bytes
  and nothing else** -- taken as the difference between that chunk's graph and
  the parse chunk's, which is the honest form of "nothing else loads": every
  module they need was already on the parse path, so the figure is the emitters
  themselves. What the parse path grows by is `registerCompletion()` and the two
  shell names: the parse chunk went **18,685 bytes against 19,145**, which is 460
  bytes. Interleaved, same binary, with `completion: false` as the one input
  removed, sixty spawns: **48.86ms against 48.76ms** and 49.08 against 48.55 --
  noise in both directions, twice.

  Both byte figures moved between the first measurement and the last, which is
  the reason to re-derive rather than carry one: the emitters were 12.5 kB and
  the parse chunk 504 bytes before the review rounds, and three fixes and the
  prose around them account for the difference. A figure in this file that only
  a re-run can confirm is the stale snapshot it warns about elsewhere -- so what
  is written down is how to take it again, and `node .scratch` is not where that
  lives: the parse delta is `completion: false` against nothing in one build,
  and the emitters' figure is the set difference of the two chunk graphs.

- **`shells.ts` is a module of its own, and statically imported, which reads
  backwards and is the cheaper of the two.** The names are needed while the
  _schema_ is built -- they are the `shell` argument's `choices` -- and the
  emitters are needed only when a script is printed, which are two different
  moments and the first is every invocation of every app. A dynamic import for
  two short strings is a second module fetch per run; a static one is folded into
  the chunk the parse is already in. `Record<ShellName, …>` in `index.ts` is what
  keeps the list and the emitters one set: TypeScript refuses a missing key and
  refuses an extra, so a shell added without an emitter is a type error.

- **bash and zsh, because those are the two that can be run here.** oclif ships
  bash, zsh and PowerShell, and fish has the nicest model of the four. The rule a
  generated script lives by is that it is quoted correctly or it is a shell
  injection, so what ships is what can be _executed_ in the shell it is for:
  `bash --version` on this machine is **3.2.57** and `zsh` is **5.9**, and both
  emitters are checked by sourcing their output and driving a real completion.
  Neither `fish` nor `pwsh` is installed here at all, so either emitter would
  ship as a program its own author had never executed -- which is the thing
  `scripts/terminal-probe.mjs` exists for, in its own words, because the model
  and the diff share an author and an assumption wrong in both passes green
  forever. The suite's own `bash -n` and `zsh -n` are `skipIf` the shell is
  absent, since CI is nine node-and-os combinations, so a fish emitter would
  also be unchecked wherever fish is not installed. `SHELLS` is a map, so adding
  one is a module and a run by somebody who has that shell.

  Also deliberately not the reason: that fish or PowerShell is _hard_. fish's
  model is the nicest of the four and its escaping is one rule (`'` and `\`
  inside single quotes); PowerShell's is a fourth regime with a different
  completion API. Either could be written in an afternoon by somebody who could
  run it.

- **A named shell prints to stdout; a missing one says how to install, to
  stderr.** `app completion bash > …` is unchanged and is what `gh`, `kubectl`,
  `rustup` and `deno` all do -- both generated headers document that redirect, so
  the scriptable form stays a printer and the `> file` idiom cannot break.

  What changed is the **bare** form, and the reason is that the old answer was the
  worst one available: `Missing required arguments: <shell>` names the grammar
  rather than the thing to do, at a reader who does not necessarily know which
  shell they are in. So `[shell]` is optional -- omitted, `$SHELL` is read and the
  routes for that shell are printed, or the shells it can print for are named when
  it cannot tell. Detection is on the **basename**, because the value is a path and
  `/bin/zsh`, `/usr/local/bin/bash` and `/opt/homebrew/bin/bash` are two answers; a
  version suffix is deliberately not read, since guessing there is how `csh` comes
  back as something it is not. An invalid name is still an error, because `choices`
  is judged on the way in and the short-circuit below is only over what is
  _missing_.

  It is stderr and a non-zero exit, which is this being the better **error** rather
  than an answer: `app completion > file` must not fill the file the reader wanted
  a script in, and a script that read the exit code still sees that no shell was
  named. What makes it exit zero is having installed something, which is the
  installer's.

- **The install routes are one module with two readers, which is what stops them
  drifting.** They were text inside each emitter's header template, and printing
  them as instructions would have been a second copy of "a zsh completion is a file
  called `_app` on `$fpath`" -- the copy that goes stale being whichever one the
  reader is not looking at. `installHint()` is data, `installComment()` renders it
  as the script's own `#` block and `instructions()` renders it for a terminal, so
  the script and the command cannot disagree about where a completion goes. The
  same rule `readRoutes()` keeps for the two route walks. `should carry the same
  install routes in the %s script as it prints as instructions` is the guard, and it
  reads every command out of the hint rather than asserting a spelling.

- **A missing required value is not an error for this command, and the old
  reading made it unreachable.** `validateOptions()` flattens every context's
  options, so on an app with a required global option `app completion zsh` threw
  `Missing required options: --token` -- the one command an app cannot reimplement,
  refused on exactly the apps that have global options, with a message naming an
  option that has nothing to do with what was asked. `--help` and `help` escape it
  because `detectHelp()` runs before anything is validated, which is a recorded
  ordering; this had nothing.

  It was written down as a decision rather than an oversight -- "making it win
  means a field on `ParseState` and a change to what `parse()` validates for every
  app, which is not a thing to add for one command" -- and the cost in that
  sentence is the thing that was wrong. It is an **internal** `needsNoValues` on
  the command and one shared `asked()` predicate the two validators call, so there
  is no public surface and no second rule: `state.help` is the flag and the `help`
  command, and `needsNoValues` is a parser-added command that answers out of the
  **schema**, where there is no work for a missing value to be missing from. The
  `help` command deliberately does not carry it, because `state.help` already says
  it there and a second marker would be a guard that cannot fire.

  Only the **missing** checks read it, which is what keeps `app completion fish` an
  error. And a sabotage pass is what found the one thing this made invisible:
  with the missing check skipped, `<shell>` and `[shell]` behave identically at the
  throw site, so every test about the no-shell path passed either way -- the
  spelling is observable in **help**, which is what tells a reader whether they have
  to name one, and that is where it is pinned.

- **The command is free and visible, with `schema.completion: false` to opt
  out.** The same argument `--version` settled and it lands harder: a completion
  script is printed from the tree, the options and the `choices` the _parser_
  holds, so an app writing its own would reimplement this walk -- and `sigil
  build` generates the executable and calls `main()`, so a command an app wrapped
  around `main()` is not in the bundle, which is the divergence `--version` is
  already written down for. Visible rather than hidden because a
  framework-supplied command nobody can discover is a feature nobody uses, so it
  is a row on the help screen rather than a sentence in a README. Nothing is added
  over a declaration: an app with its own `completion`, or an alias for one, keeps
  it -- asked with `find()`, which answers about the aliases too, for the reason
  `registerHelp()` asks both `find()` and `has()`.

  A gate on `schema.commands !== undefined` was considered and refused, which is
  the one place this parts from `main()`'s own reading of that property. There,
  "a schema that declares none is one being used as a parser" is right about a
  _help screen_; it is wrong here, because a single-command CLI with forty options
  is exactly the app that most wants option completion.

- **It is an ordinary command, so a required option is still required -- and the
  first reason written down for that was false.** `rq completion bash` on an app
  declaring `'--token <t>'` answers `Missing required options: --token`, where
  `rq --help` and `rq help` both print help: those two are _detected_ before
  anything is validated, which is written down as help having to win because
  "answering 'you did not say' is not an answer". The same sentence reads true of
  a script, so the asymmetry needs a reason.

  The reason first given was that suppressing validation is all-or-nothing, so a
  `state.completion` beside `state.help` would take the `<shell>` argument's own
  `choices` with it and a wrong shell would fall from the parser's message to the
  emitter's. **That is not what the code does.** `!state.help` gates only the two
  _missing-value_ throws -- `validateArgs()`'s `missingArguments` and
  `validateOptions()`'s `missingOptions` -- while both `assertChoices()` calls run
  unconditionally. Measured: `ch zzz --help`, on an app whose `[mode]` has
  `choices: ['a', 'b']`, answers `Invalid value "zzz" for argument <mode>` rather
  than printing help. So the surgical version is available and would work.

  What it costs is the actual reason, and it is a shape this file refuses
  elsewhere: a field on `ParseState` and a change to what `parse()` validates,
  for **every** app, taken inside a ticket about a printer -- which is the same
  call as narrowing the toolchain's type check inside a caching ticket, and as
  the frame change refused inside a ticket about a list and then taken in one of
  its own. Against it: the failure is loud, it names exactly what to pass, and
  `rq --token x completion bash` works. So it stays an ordinary command, and
  whoever picks the follow-up up has the mechanism written down -- gate the two
  missing-value throws and nothing else, because the choices checks are already
  unconditional.

- **The walk imports every command module, and that is the one place it is
  right.** A description and `hidden` live inside a module and an option lives
  **only** there -- `sigil build` lifts the first two and nothing lifts the third
  -- so a script for a routed or a bundled app cannot know what `db migrate`
  accepts without importing `db/migrate.js`. Generating one is the moment to pay
  for that: it is a one-off a user runs when they install completion rather than a
  per-keypress cost, and reading everything is what a compiler does, which is the
  argument `tree.ts` already makes for the build's own walk. Measured on the
  toolchain's own routed tree, which pulls `oxc-parser` in: **60ms** for the whole
  thing, node's startup included.

  What it costs is written down rather than hedged. A command module is allowed to
  do things at top level -- read a config file, open a connection, exit -- and this
  imports all of them. A module that throws takes the script with it rather than
  leaving a gap: the app is broken for that command anyway, and a completion script
  is installed once and forgotten, so a silently incomplete one is the failure that
  lasts. And an eager walk raises errors the lazy runtime only raises for the level
  argv named -- two routes claiming one name, three directories down -- which is
  `sigil check`'s finding arriving through a door nobody expected.

- **`hidden` falls out, and eager loading makes it _better_ than the catalog's
  answer.** Asked twice and the two are not the same question. Before the import,
  because a `!` name prefix or a lifted `hidden` is on the placeholder and there
  is no reason to read a module whose command will not be offered. After it,
  because `hidden` is additive and a module may set it -- which only an import can
  say. So a routed command that hides itself in its own module is listed by
  `commandCatalog()`, which never imports anything, and is **not** offered here.
  Both are right about the question each is asked, and the test asserts both sides
  of it.

- **An alias is offered _and_ resolved, which is the one place this diverges from
  what a palette lists.** `PaletteEntry` keeps aliases out of its label on purpose
  -- a palette shows one row per command -- and a completion menu is a list of
  _tokens_, so every token the parser takes belongs in it. Both halves were needed
  and the second is the one that is a wrong answer rather than a missing one: a
  `remove` aliased `rm` is unreachable by prefix, and `mycli rm <TAB>` has to
  resolve to `remove`'s subtree or the rest of the line completes against the
  root. So the generated `__x_known` path predicate became `__x_resolve`, a
  mapping from (path, word) to the **canonical** path, which keeps every other
  arm keyed on one spelling and is also the one place the subcommand names are
  written down for the walk.

  Which tokens those are is asked of the registry rather than read off the
  command: `find()` is what decides where a token goes, and an alias a sibling's
  name shadows reaches the sibling, so offering it would offer a token that
  completes something else. Nothing refuses such a schema, so the registry's own
  answer is the only exact one.

- **bash has two word models and `COMP_WORDBREAKS` governs two different
  things, and conflating them shipped two wrong insertions.** This is the
  longest entry here because the first version of it got the mechanism wrong in
  a way that no hand-fed test could see, and the correction is the whole of what
  the bash emitter now does differently from the zsh one.

  **Axis one is how the line is split**, and it is a version difference both
  manuals state. bash 3.2 says `COMP_WORDS` is "split on shell metacharacters
  as the shell parser would separate them"; bash 4.0 changed it to "split into
  words as readline would split it, using `COMP_WORDBREAKS`". So `--tag
  host:port` is **one** word in 3.2 and **five** in 4 and later, and
  `--mode=fast` is one and three. Measured in a real bash 3.2 through a pty,
  under `complete -F`, `complete -o default -F` and `-o default -o nospace`
  alike: `host:port` and `--mode=host:port` each arrive whole, so 3.2 really
  does not break on either character.

  **Axis two is what readline replaces**, and it is the same in every version:
  only what follows the **last** character of the word that is in
  `$COMP_WORDBREAKS`. Measured by reading the bytes readline wrote before
  inserting -- `--mode=fa` then TAB emits two backspaces, so it is replacing
  `fa` and not the word.

  The two axes are independent, and the first version of this entry read axis
  two off axis one: it assumed that a shell which hands the word over whole
  also replaces the whole word, and built the prefix-carrying branch on that.
  bash 3.2 is the counterexample and is the commonest bash on a Mac -- it hands
  the word over whole **and** replaces only the tail. So the shipped script
  completed `--mode=fa` to **`--mode=--mode=fast`** and `--tag host:po` to
  **`--tag host:host:port`**, both measured against the generated script in a
  real bash. The colon half was reported by an independent review as a _missing_
  completion, which is what it is on bash 4 and later, where the lookup fails
  instead; on 3.2 it is a wrong line. Neither was reachable from any hand-fed
  word list, because every one of those had the two axes tied together.

  **One mechanism answers both.** `__x_join` rejoins whatever the shell split --
  a raw word that is nothing but break characters sat between two words with no
  space, and so does whatever follows a logical word that now ends in one --
  which is a no-op on 3.2 and the fix on 4 and later. `__x_keep` then finds how
  much of the current word readline will keep, by scanning it backwards for the
  last character in `$COMP_WORDBREAKS`. And `__x_add` filters a candidate by the
  **whole** word and inserts it with that kept prefix taken off, which is
  bash-completion's `__ltrim_colon_completions` generalised to every break
  character rather than to `:`.

  So the `--opt=` prefix is still passed -- a candidate for `--mode=fa` is the
  word `--mode=fast` and that is what `cur` has to be filtered against -- and
  what comes back off the front is decided at run time rather than by a branch.
  A shell whose owner took `=` and `:` out of `COMP_WORDBREAKS` gets the whole
  `--mode=fast` inserted, which is correct there and is the third regime the
  test drives. The `prev = '='` branch is **gone**, because a rejoined
  `--mode=fast` is one word and the `-*=*` branch is the only one left -- one
  branch where there were two, and it is the one a real bash reaches.

  It matches `-*=*` rather than `--*=*`, because a **short** option takes an
  attached value too -- `-p=5` resolves, which is what `spellingOf()`'s own
  entry records from the other side.

  zsh needs none of it, confirmed in a real zsh through a pty rather than taken
  from the report: `cx go --tag host:po` completes to `host:port` and `cx go
  --tag` lists `a:b host:port plain`. Its completion system owns the word
  splitting, `compset -p` is what moves the insertion point, and a colon in a
  _value_ is escaped `\:` for `_describe` already.

  **What is driven, and what is fed.** bash 3.2 is driven for real -- through a
  pty for the insertion, which is the only place the backspaces are visible, and
  through `COMP_WORDS` for the candidate lists. The bash 4 and later half is fed
  the word list those manuals specify, because **no bash 4 or 5 is installed
  where this was written**, and the test says so where it lives rather than
  implying a run that did not happen. That is the same standard fish and
  PowerShell were refused under, with the difference that the split is a
  documented behaviour rather than a whole escaping grammar. The driver also
  asserts that `=` and `:` really are in the default `COMP_WORDBREAKS` of the
  bash running it, so a bash whose default differs fails there rather than
  passing quietly.

- **A `default` command's own arguments and options are offered at the level
  above it, and that was measured both ways before anything was written.** A
  default command is dispatched when argv names no command, so it _is_
  `contexts[0]`: a bare positional at its parent is one of its arguments. The
  obvious worry is that its options are the parser's known soft spot -- an option
  used before the command it belongs to is not protected from being read as an
  earlier option's value -- and that is about _protection_ rather than about
  whether they resolve. They do, with their declared types:
  `deep --port=notanumber` answers `Invalid integer` rather than storing the
  string, which is what says the declaration is being read rather than
  `allowUnknownOptions` quietly taking it.

  What the shadowing order is had to be measured too, and it is the opposite of
  what the chain suggests. Once the default has joined, `contexts` is
  `[serve, root]`, so serve is innermost -- and at the _parent_ the root's
  declaration is what resolves: over one `--mode [m]` on each with different
  `choices`, `sh --mode slow` is taken and `sh --mode fast` is refused, while
  `sh serve --mode fast` is taken and `sh serve --mode slow` is refused. So the
  default goes **last** in the option chain here and nearest once its name has
  been typed. A **hidden** default contributes nothing, which is `hidden` taken at
  its word: it says do not list this command, and a completion menu is a listing,
  including of the values it would take.

- **Every candidate is a _quoted `case` pattern_, which is what makes bash
  exact.** bash matches a `case` pattern literally wherever it is quoted, so a
  command called `*` is a pattern that matches `*` and nothing else. That is why
  the data is `case` arms rather than a word list for `compgen -W`: a word list is
  split on `IFS` and re-globbed, so a name with a space arrives as two candidates
  and a name with a `*` matches everything. Prefix filtering is `case "$c" in
  "$cur"*)`, where the quoted half is literal and the trailing `*` is the only
  glob -- `compgen`'s job done with no subshell and no quoting left to go wrong.
  Written for bash **3.2**, which is what macOS ships: no associative arrays, no
  `mapfile`, and no dependency on `bash-completion`, which rules out
  `_init_completion`.

- **Every local the function declares carries the generated prefix, and the one
  that forced that is `path`.** In zsh `path` is a **special** parameter tied to
  `PATH`, so a function declaring `local path=''` runs with no `$PATH` at all --
  measured, `whence -p ls` inside one finds nothing and `${#PATH}` is 0. The
  completion function calls into the whole completion system, which is
  third-party shell code and may run an external command, so emptying `$PATH`
  for the duration of a tab is unambiguously wrong whether or not it bites
  today. Found by reading the emitted zsh as a _program_ rather than by reading
  the emitter, which is the only way that kind of defect surfaces: nothing about
  the generator looks wrong, and `zsh -n` and every completion driven through it
  pass either way. The bash emitter prefixes it too, for one spelling across the
  two rather than because bash needs it -- bash has no such parameter. Pinned by
  a stub that reports `${#PATH}` from inside the function, which is the only
  place the answer differs.

- **`setopt localoptions no_ksh_arrays` is one option, and `emulate -L zsh` was
  the first fix and broke a real completion.** A user who set `ksh_arrays` makes
  every array zero-based, so `$words[i]` is the word after the one the walk
  meant and `app db <TAB>` offered the root's commands -- measured. The obvious
  fix is `emulate -L zsh`, which resets every option at once, and `localoptions`
  scopes what it changed over everything the function _calls_: driven through a
  pty, `_files` then failed with `no matches found: *:globbed-files` and
  completed a file from the working directory instead of the option's values. So
  the fix is the one option that was wrong and nothing else moves. A sourced
  function is the reason the option is reachable at all -- `compinit` loads a
  `_name` off `$fpath` with `autoload -Uz`, which gets zsh's own emulation, and
  `source <(app completion zsh)` does not.

  The guard needed **two** assertions and the first one passed without it, which
  is the fixture-cannot-reach-the-branch shape again: the path walk is the half
  the report came in on, and the `prev` lookup is a second reader of the same
  one-based assumption. And the _driver_ was wrong about the very option it was
  set up to exercise -- `$#words` under `ksh_arrays` is the **length of element
  zero**, so it handed the function a `CURRENT` of 5 for a four-word line and
  the option before the cursor read as empty. `${#words[@]}` is right under
  both. A harness that is wrong about the option it is testing reports the
  subject as broken, which is where fifteen minutes went.

- **A command with no token left at all is skipped, and that one is a syntax
  error in the whole script rather than one command missing from it.**
  `tokensFor()` drops a spelling a sibling answers to, because the registry keys
  by name _and_ alias and a later registration overwrites -- so a sibling
  declared after `ship` and aliased `ship` takes `ship`'s own name away from it.
  With nothing left, `tokens.map(...).join('|')` is the empty string and the arm
  reads `) __sd_next='ship' ;;`, which `bash -n` reports as `syntax error near
  unexpected token ')'`: every command in the file is gone rather than the one.
  Found by review, and it is why `bash -n` is worth running over a schema with
  nothing wrong with it.

- **A name no shell can offer is dropped, which is `typeable()` met on a name
  rather than on a value.** `oneLine()` and `typeable()` were applied to
  descriptions and to `choices` and not to a command's own name or an option's
  spellings -- so a newline in a name broke the `_describe` element it was in,
  which is the thing `spec.ts` collapses descriptions for, and an escape in one
  reached the screen on every tab. The filter is in `tokensFor()` beside the
  registry test, so one rule answers both.

- **A program name with a leading dash is refused, because quoting does not
  help.** Quote removal happens before a builtin reads its words, so
  `complete -o default -F _x '-D'` is `complete: -D: invalid option` and the name
  is never registered -- measured, rather than inferred from the `#compdef`
  comment, which was the shape the review reported. Refused where the spec is
  built, beside the multi-word refusal, which is the rule a `...` hint on an
  option already follows.

- **zsh offers subcommands and arguments together, and `_describe`'s own exit
  code is why it did not.** It answers zero when it had nothing to offer, so a
  function written as `_subs && return` stops at the subcommands and never
  reaches the arguments -- and a parent with both is ordinary, because a
  `default` command's positionals are offered at its parent. bash adds both
  lists to one `COMPREPLY` and never had it. An `__x_added` flag is what makes
  the two agree, and the `--` terminator was the same disagreement in the other
  direction: zsh gave up where bash's `-o default` offers files.

- **A `case` _subject_ is quoted for the reader and a `case` _pattern_ for the
  shell, and only the second is load bearing.** `case "$word" in` is the one
  deliberate survivor of the sabotage pass: neither shell splits or globs the
  subject of a `case`, measured over `*` and `a b` in `zsh -f` under
  `sh_word_split`, `glob_subst`, `nounset`, `ksh_glob` and `extendedglob`, and
  in bash with a matching file present. So nothing can be written that fails
  when the quotes go, and they stay because the bash emitter already spelled it
  that way and a shell reader expects it. What _is_ load bearing is bash's
  `case "$__c" in "$cur"*)`: a `cur` of `a*` unquoted there is a pattern rather
  than a prefix and offers every candidate beginning `a`. Both halves are in the
  pass, one as a survivor with its measurement and one as a catch.

- **zsh needs a second escaping on top of the shell's, because `_describe` reads
  the element itself.** Each element is a single-quoted `value:description` and
  `'` is written `'\''` exactly as in bash -- and `_describe` then splits on the
  first `:` that is not backslash-escaped, so a `:` in a _value_ has to be `\:` or
  the value is cut in half, and a `\` has to be doubled or it escapes what follows
  it. Both are done to the value, which is the half that gets inserted into the
  command line; the description is left alone, because everything after the first
  colon is the description whatever is in it and escaping a backslash there would
  only print it twice.

- **One file serves both zsh install modes, and the `$funcstack[1]` test is what
  makes that work.** A zsh completion is normally a file called `_app` on `$fpath`
  that `compinit` autoloads, tagged by a first line of `#compdef app`, and such a
  file ends by _calling_ its function. The obvious thing to do with a command that
  prints a script is `source <(app completion zsh)`, where that call runs the
  completion function with no completion to do. Inside an autoload the function's
  own name is on the stack and when sourced it is not, so the sourced case
  registers with `compdef` instead. Measured both ways: with the branch, sourcing
  registers `_mycli` for `mycli`; without it, zsh writes four `can only be called
  from completion function` errors and registers nothing at all.

- **A description is collapsed to one line and stripped of control characters; a
  _value_ holding one is dropped instead.** Collapsing first, because a
  description is shown on one line in every shell that shows one and zsh's
  `_describe` takes line-oriented pairs -- a newline inside a correctly quoted
  string is still a broken list. Then the control characters go, which is this
  repository's rule for what it ships: a raw escape in a file the shell prints on
  every tab is a sequence waiting to be executed. Neither is a substitute for
  quoting and neither is treated as one.

  A value is the opposite call for the opposite reason: it is _inserted into the
  command line_, so cleaning one would type a token that is not the value. It is
  dropped, which is honest about a value that was never completable, and the
  whitespace in one is left alone because a value really may contain a space and
  every emitter quotes it.

- **The pattern that answers "is this a control character" has no `g` flag, and
  the one that replaces has.** `test()` on a global regex is stateful: it leaves
  `lastIndex` past the match, so the next call on a different string starts part
  way in and answers `false` for a string that holds one. One pattern used two
  ways is how that happens, so there are two patterns -- and the test for it needs
  **two** values with control characters in them, because with one the
  statefulness never bites.

- **A declared `choices` list is the whole answer, including when nothing in it
  can be typed.** Found by the sabotage pass: the code had a
  `values.length > 0 ? dedupe(values) : undefined`, and what it changes is only
  whether an unusable list reads as `[]` or as absent -- which every reader asks
  with `?.length`, so it was dead. What is _not_ dead is that the choices branch
  returns rather than falling through: `choices: []` is a list the parser refuses
  every value against, so reaching the type's own two words would offer `true` and
  `false` where the parse answers `Invalid value`. The conditional is gone and the
  property is asserted instead.

- **A `yesno`'s boolean choices are offered as the words they are typed as.** A
  `yesno` coerces `yes` to `true`, so the tokens that reach a `choices: [true,
  false]` are `yes` and `no` -- offering `true` would offer a token the choice
  check then refuses, which is the divergence the whole design is written against.
  The same rule `tokenOf()` already keeps for the palette's prompts.

- **The program name is refused unless it is a single word, because one of the
  three places it appears cannot be quoted.** A script names its program in
  `complete -F`, in `compdef` and in zsh's `#compdef` first line -- and that last
  one is a _comment_ `compinit` reads, so there is no quoting available at all.
  `oneLine()` has already flattened any newline out of it, which is what stops a
  second line being written into that comment; refusing the whitespace that is
  left makes the line safe by construction rather than by escaping, and a
  `schema.name` that is not one word is a bug in the app rather than something to
  guess at.

  The _function_ name is the other thing no quote can close, and it is sanitized
  to `[A-Za-z0-9_]`: `_my;cli() { … }` parses perfectly well, defines a function
  called `cli`, and leaves `complete -F _my` naming one that is not there. Two
  programs whose names differ only in a character that is not a letter, a digit or
  an underscore collide there, which matters only if both are installed and is the
  same collision `complete -F` would have had anyway.

- **What a big tree costs is bytes rather than time, and both were measured.**
  The script is `O(paths x options reachable there)`, because an ancestor's
  options are typable at every path below it and each arm lists what resolves
  there. The tree that says so, written out so it can be rebuilt: sixty
  commands, each declaring eight valued options with two spellings each -- `-a,
  --oN-M <v>` -- and three choices apiece, and each carrying one subcommand that
  declares the same eight. That is **123 paths** -- the sixty, their sixty subs,
  the root, `completion` and `help` -- and the script's option arms list
  **2,046** spellings between them, which is the multiplication said as a number
  and is well under the 3,001 the arithmetic suggests, because a sub's own `-a`
  shadows its parent's and the dedupe keeps the nearer one. It comes to **99 kB**
  of bash and **123 kB** of zsh, both generated in **9ms** in process, and
  sourcing the bash script and running one completion is **5ms** including
  bash's own startup, measured over twenty cycles three times. The toolchain's
  own six-command tree is **6.3 kB** of bash and **9.7 kB** of zsh through the
  published bin, which takes **40-50ms** end to end -- node's startup and the
  eager module load, not the printing.

  So the thing to watch is a wide tree under a root with many options, and the
  lever if it ever matters is to stop repeating an ancestor's options per path --
  which would mean the walk asking a chain of `case` statements rather than one,
  and is a redesign to take against a measurement rather than in advance.

- **The differential with `commandCatalog()` is the ticket's own ask, and the two
  walks answer different questions.** A catalog answers _what can be selected and
  run_, so a namespace is noise and a command's **required** options are the
  values it needs; completion answers _what can be typed_, so every path segment
  counts -- `db` has to be typed to reach `db migrate` -- and every option is a
  candidate whether it is required or not. So the catalog is asked with
  `namespaces: true`, which is the same set, and the root is this one's alone:
  a catalog lists commands to run and the program itself is not one.

  Two readers of one registry rather than one implementation, because the walk
  needs `loadCommand()` and `catalog.ts` imports nothing but types on purpose --
  which is a documented property of that file and the reason every assertion
  about what a palette lists can be written against a literal.

- **What says the generator produced a _program_ rather than plausible text.**
  Three things, and the first two run in the suite. `bash -n` and `zsh -n` over
  the emitted script, skipped where the shell is absent, because CI is nine
  node-and-os combinations -- and what `-n` answers is **syntax** rather than
  safety, which the comment above it used to overclaim: `echo $(whoami)` parses,
  so the injection rule is held by the assertions on the bytes and by the drivers
  that run the script and read what it offered. What `-n` does catch is a quote
  or a pattern that ended a construct early, which is how a description reaches
  the grammar at all, and it is what caught an empty `case` pattern from a
  command with no token left. A **bash driver** that does what readline does -- set
  `COMP_WORDS` and `COMP_CWORD`, call the function, read `COMPREPLY` back -- under
  `-u`, because a user's shell may have it and bash 3.2 errors on
  `"${empty[@]}"`.

  What that driver cannot see is the **insertion**, which is where two defects
  lived: a candidate list can be perfectly right and still come out doubled on
  the line, because what readline replaces is narrower than the word. Seeing it
  needs a pty and a read of the backspaces readline writes before inserting,
  which is a by-hand run rather than a test -- so the suite asserts the
  _candidates_ each word regime has to produce, which is the same claim in the
  one form a test can hold, and the `COMP_WORDBREAKS` entry has the
  measurement.

  And a **zsh driver** with the completion system stubbed:
  `compset`, `_describe` and `_files` replaced by functions that print what they
  were handed, so what is asserted is that the function asks the right questions
  with the right data, and those three actually doing their jobs is zsh's claim
  rather than this file's. No pty, no sleeps, no timing -- which is the shape this
  repository insists on after a timing test flaked one busy machine later.

  The one thing only a pty can say was done **by hand** and is not in the suite: a
  `zpty`-driven zsh 5.9 with a real `compinit`, which is what confirmed the menu
  shows descriptions, that the hostile description is printed rather than run, and
  that zsh groups two spellings of one option onto one row. A `zpty` test with
  sleeps in it is the fourteen-second test this file already has an entry about.

  zsh filters by prefix itself, inside `_describe`, so the function offers the
  whole set at a position and the current word narrows it; bash is the other way
  round and filters in the script. That is why the two drivers expect different
  things for the same line, and it is worth knowing before reading either.

  **And every recipe the script's own header prints was followed, against the
  real toolchain's own script, because an instruction a reader follows to a
  broken result is the one kind of prose defect that costs them an afternoon.**
  `source <(sigil completion zsh)` registers `_sigil` for `sigil`; the same
  script saved as `_sigil` on a directory prepended to `$fpath` and picked up by
  `compinit` registers the same thing -- which is the `$funcstack[1]` branch
  answering correctly on both sides. And `source`ing the bash script leaves
  `complete -p sigil` reading back `complete -o default -F _sigil sigil`, with
  `sigil <TAB>` offering all six commands. None of that is in the suite: it needs
  a `compinit`, an `fpath` and a built binary at once, which is three things a
  unit test should not be arranging.

  And the one check that needs a real routed app rather than a fixture is in
  `packages/cli/test/commands.test.ts`, where the published bin generates a
  script for the toolchain's own tree: `--external` is declared _inside_
  `src/commands/build.ts`, which pulls `oxc-parser` -- a native binding -- in
  behind it, so a script naming that option is a script that imported the module.
  Beside it is the sharper half of the self-host invariant: the script is **byte
  for byte identical** from `node src/sigil.ts` and from `node dist/sigil.mjs`,
  in both shells. The `--help` comparison next to it deliberately compares what
  each one _does_ rather than what it says, because the descriptions legitimately
  differ there -- and they do not differ here, because generating a script imports
  every module itself. So the static `desc` lift buys this command nothing and
  costs it nothing, which is a thing worth knowing before somebody wonders why
  completion does not need it.

- **Seventy-six sabotages, seventy-five caught and one declared, after twelve
  survivors and one defect the pass found plus one it could not.** Counted
  against the shipped tree in one run rather than summed across rounds, which is
  what makes the figure re-derivable: sixty-four before any review round, nine
  over the guards the first two produced, and three over the word-model fix --
  all twelve of those caught first time, which is what arriving with a test
  does. Eleven of the bash cases went stale in one run when that fix rewrote the
  function, and the harness reported each as `PATTERN MISSED` rather than as a
  pass; they are regenerated from the file by line rather than retyped, which is
  the technique the escaping already forced once. The declared survivor is the `case`
  subject above, with its measurement. The defect the pass found is the dead
  conditional; the one it could not is `local path`, which no deletion expresses
  and which reading the output as a shell program is what turned up.
  Of the twelve survivors, one was dead code, two were a guard with no test at all -- the zsh `compset` and the
  `$funcstack` install branch, because nothing drove zsh until a driver was
  written for them -- and nine were a guard whose _fixture_ could not reach the
  branch it was named for. Reasoned backwards from "what input would make this
  matter", never forwards from "no test failed". Worth naming four of them,
  because each is a shape rather than an oversight.

  The control-character filter needed **two** control values, for the statefulness
  reason above. The empty-value filter needed a `choices: ['', 'fine']`, which
  nothing had. The hidden-placeholder guard -- the one that says a module whose
  command will not be offered is never imported -- was pinned by a counter the
  fixture increments, and the ESM loader caches a module: an earlier test in the
  same file had already paid the import, so the counter read as unchanged whatever
  the guard did. It has a fixture directory of its own now, which nothing else
  touches.

  And the function-name test was **fooled by the very mangling it was written
  for**. It read the name out of `complete -F` and ran `declare -F $name` in
  bash; unquoted, `declare -F _my;cli` is `declare -F _my`, which fails, followed
  by `cli` -- which the broken definition really did define, so the script exited
  zero. Quoting the name in the driver is the fix, and the lesson is the one this
  file keeps recording about a sabotage verdict: it is a statement about the test,
  and a test that splits the same way the defect does agrees with it.

  The harness reported a pattern as its own verdict rather than as a pass
  **twenty-six** times while this was being written, and that is the guard
  earning its keep for the seventh time here: a pattern that silently matches
  nothing reads exactly like a guard that is not load bearing. The twenty-six
  are two classes and both are worth separating. **Fifteen** went stale because
  the code under them moved -- three when `__x_add` grew a prefix parameter and
  the two empty-array guards moved with it, two when the alias work turned
  `__x_known` into `__x_resolve`, and **ten in one run** after the review fixes,
  which is the class every pass on a branch with review rounds on it will meet
  and the reason to re-run the whole pass rather than the new cases. **Ten**
  were the harness author's own escaping: the emitters write `\t` and `\${` as
  _source text_ inside a template literal, so a pattern written with real tabs
  matches nothing, and the fix was to read the lines out of the file rather than
  retype them. One matched twice, because two identical guard lines exist and
  the pattern needed a line of context.

  It also refuses a run that found fewer tests than the control, runs a green
  control first, and restores on `SIGINT` and `SIGTERM` as well as on an
  exception -- because a killed pass that left a mutation in the tree poisons the
  next control and reads as a real defect to whoever looks next.

- **What the two review rounds found, which the sabotage pass could not: four
  wrong shell programs and five sentences.** Round 1 was pointed at the diff with
  the requirements and not the rationale, and asked specifically about the quoting
  of each emitted script and about anything that parses and then does nothing. It
  reported ten findings and **every one was confirmed against the code**, which is
  a ratio worth recording rather than the count: `local path`, the `ksh_arrays`
  walk, the greedy `compset -P '*='`, zsh giving up on `--` where bash offers
  files, zsh never reaching the arguments when a command has subcommands, a
  dash-leading program name, the empty-token `case` arm, a `CompletionCommand.desc`
  nothing reads, a `values: []` the two emitters treated as absent, and a stale
  function name in a comment. Four of those are a script that is _wrong as a shell
  program_ rather than a guard that is missing, which is the class a pass built
  out of deletions cannot express at all -- a deletion asks whether the code that
  is there is load bearing, and `compset -P '*='` is code that is there and does
  the wrong thing.

  Round 2 was pointed at what round 1 said it had skipped -- the test file, the
  prose, and the generated scripts read as programs -- and told not to re-litigate
  round 1's premises. It found **no new runtime defect** and its findings were a
  shipped signature and **five weak tests plus three wrong README rows**, which is
  the pattern this file already records twice over: a premise-attacking round
  confirms, and the findings come from the files nobody opened. The signature is
  the sharpest of them, because it is the one that was in shipped code:
  `registerCompletion()` documented `@returns What was added` while returning
  `undefined` after a successful add, because an earlier edit aborted before
  writing. It is `Promise<void>` now, which is what it always was -- and `void` is
  right rather than a concession, since `registerHelp()` and `registerVersion()`
  hand back handles only because something _detects_ them, and nothing detects an
  ordinary command.

  The five weak tests are each a shape rather than an oversight. The
  alias-ownership test counted the token rather than asking who owned it, so
  dropping `ship` from the sibling and leaving `build` claiming it passed. The
  required-option test stopped at the parse, so the README's `rq --token x
  completion bash  # fine` was unbacked by anything that ran it. The `bash -n`
  comment claimed the injection rule, which `-n` cannot answer -- `echo $(whoami)`
  parses -- so it now says what syntax checking is for and names the quoting block
  and the drivers as where the claim really lives. The default-`COMP_WORDBREAKS`
  branch was a single case, which is the configuration every unconfigured shell is
  in. And the stubbed-zsh `compset` assertion claimed an insertion the stub cannot
  observe, so it pins the _offset_ instead and leaves what happens to the word to
  the pty test.

  The three README rows were each false of one shell or of one declaration:
  descriptions are zsh's and bash's `COMPREPLY` is words alone; `mycli --flag
  <TAB>` offers nothing, because a bare flag takes no value and the bool words are
  a _valued_ one's; and `mycli completion zsh > "${fpath[1]}/_mycli"` is a zsh
  array, so from bash it is empty and the redirect lands on `/_mycli`. A recipe
  that is broken if followed is the worst of the three.

  **Two findings were refuted, both measured rather than argued.** The unquoted
  `case` subject is the entry above. And dash-leading positional `choices` -- `-1`
  beside `1` -- really are unreachable through the script, and that is the parser's
  own rule rather than the printer's: `optionLikeRE` is `/^--?\w/`, so the parser
  reads `-1` as an option too and a command line cannot express it either. A
  script that offered it would be offering a value the parse then refuses, which
  is the divergence the whole design is written against.

- **A third review round, independent and pointed at the emitted scripts as
  programs, found the word-model defect and refuted three things -- two of them
  because its scope could not see `spec.ts`.** Which is worth recording as a
  property of _scoping a round_ rather than of the round: told to read the two
  emitters, it reported inputs that are refused upstream and reported them
  honestly as what the emitters would do with them.

  Refuted: a newline in the program name injecting through the `#compdef` line
  and the header recipes -- `APPNAME=$'foo\necho …'` exits 1 with `"…" is not a
  name a shell can register for`, since `completionSpec()` refuses any program
  name holding whitespace. A leading-dash program name reaching `complete -o
  default -F _D '-D'` -- the same guard, the same message, which is the earlier
  round's own fix holding; adding `--` to those builtins would be defence in
  depth over an unreachable input. And an empty `case` pattern from empty
  `tokens` or `spellings` -- the reachable route is a sibling's alias shadowing
  another command's name, which is the earlier fix, and `spellings: []` is
  unreachable because `initOption()` refuses an option that names no spelling.

  Confirmed clean by it, with citations, and worth naming so the next round
  knows what has been read: every quoting of `"`, a backtick, `$`, `\`, `!`,
  `*`, `[`, `#`, `%`, `:`, a leading dash and non-ASCII inside the single-quote
  wrapper; the backslash-before-colon ordering in a zsh _value_; `compset -p $((
  ${#opt} + 1 ))` against the greedy form; the `path` prefixing; the
  `no_ksh_arrays` setopt and the one-based walk; and bash 3.2 compliance -- no
  associative arrays, no `mapfile`, no `compopt`, index-append rather than `+=`.

- **Twenty-four test schemas in six files gained `completion: false`, and that is
  the honest churn rather than a reason to narrow the feature.** A free command in
  every app's namespace changes every existing app's help screen, which is **forty**
  failing tests across help, the catalog, the palette, routing and the build's
  tree walk. All but three are in files whose own comments already say
  `help: false` is there to keep the parser's free additions out of expectations,
  so the fix is one more word in the same place -- and `catalog.test.ts`'s twenty
  failures are one shared helper, which is what says the churn is concentrated
  rather than spread. Two more are `routing.test.ts` asserting a registry's
  contents, where the expected list grows a `'completion'` beside the `'help'` the
  comment there already explains. The last is `tree.test.ts`'s comparison of
  the build's walk against the runtime's: the build resolves an app's **routes**,
  and `completion` and `help` are commands the parser adds to whatever it was
  handed, so comparing the walks means turning both off -- a built app grows them
  at run time exactly as an unbundled one does, which is why that is not a
  divergence.

  **And eleven demos gained the same line, for a reason the tests do not have.**
  A test turns it off so an expectation does not move; a demo turns it off
  because it is one idea each, and a free row on a `--help` screen is a row the
  file did not write and is not about. `help` stays, because `07-help.js` is
  about exactly that, and `completion` is demonstrated nowhere -- which is what
  makes the rule stateable rather than tidiness. `10-palette.js` is the one that
  keeps it and is the interesting one: the palette reads the **registry** rather
  than the declaration, so the one command the app never declared is the row that
  proves it, which is that demo's whole claim. The three demos that pass their
  own `argv` and never parse `--help` -- `09-errors.js`, `05-quiet.js` and the
  config four -- needed nothing, and a line there would have been noise. Measured
  rather than swept: twelve demos showed the row and one of the twelve should.

- **Two keys joined `SIGIL_KEYS`, which is the one place this is an app's user's
  business rather than a developer's.** `@ttylabs/cli`'s own output is
  deliberately not translated because its reader is a developer; a `completion`
  command the _framework_ adds to every app has a description an app's user reads,
  which is exactly the class `Show help for a command` and `Print the version` are
  already in. So `Print a shell completion script` and `The shell to generate for`
  are keys, and the count went from 55 to 57.

  The script's own header comments are **not** keys, and that is a decision rather
  than an omission: a shell script's comment is part of a program, translating one
  would put shell instructions in a catalog where no translator could check them,
  and it is the same line this file already draws around a command name being the
  API the user types. The refusal over a program name that is not one word stays
  English too, for the reason the 139 developer-facing errors do: it is a bug
  report in the app.

- **What is deliberately out.** A **value completer** on `Option`, which is the
  dynamic script's whole purpose and is a new declaration surface taken inside a
  printer's ticket. **fish and PowerShell**, with the verifiability reason above
  and the note that the shape is a map, so adding one is a module plus a run by
  somebody who has that shell. **An `install` subcommand** -- which SIG-151
  built, as the bare `app completion` rather than as a second command, and the
  subsection below is where that is argued; the entry here said "above" and
  pointed at nothing, which is a cross-reference nobody could follow. **A
  `--name` override** for the program the script registers for: `schema.name` is what
  `Usage:` already prints and what `gh` and `kubectl` hardcode, and an override is
  a second answer to which program this is. **A published
  `@ttylabs/sigil/completion` subpath**, because nothing outside needs one -- the
  tests import `../src/completion/index.js` directly, which is what every test in
  that package does -- and a subpath is permanent API surface. And **suppressing the file fallback where
  a command declares no positional arguments**, which zsh could do precisely and
  bash 3.2 cannot: `compopt` is bash 4, so the choice there is files everywhere or
  files nowhere, and files-nowhere costs `--out <TAB>` the one thing it wants.
  Two shells disagreeing about what they offer is worse than both being loose in
  the same direction.

#### Installing it, which is the same table read a third time

SIG-139 made `app completion` say _how_ to install a script; SIG-151 makes it do
the installing. `src/completion/install.ts` grew the route table that says where
each shell looks, `installer.ts` is the plan and the writing,
`interactive.ts` is the flow, and `parser/completion.ts` is one `if` that
dispatches between the printer and the installer.

- **The bare `app completion` is the installer, rather than an `install`
  subcommand.** Which is the shape SIG-139 left as "deliberately out" and is
  reversed here for a reason rather than on taste: `app completion` with no shell
  named already **printed the recipes** and exited non-zero, so it was a command
  whose entire output was instructions for a thing it could have done. A second
  command would leave that one in place beside it, and then the useless spelling
  is the shorter one. Naming a shell still prints the script, which is the
  redirect form every other tool has and is what `gh`, `kubectl`, `rustup` and
  `deno` all do -- so nothing that worked stopped working, and what changed is
  the spelling that did nothing useful.

- **It writes the script file and, since SIG-155, a marked block in the startup
  file -- and the two reasons it used not to each have an answer rather than
  being overruled.** SIG-151 printed the line, on two grounds. A `.zshrc` is very
  often under version control and routinely written by a dotfile manager, which
  is a reason to **ask** and not a reason never to -- and it was already asking:
  the plan names both files before the one question, so a yes is an answer about
  both and a no leaves everything as it was. And "a line we added and a line they
  added look identical afterwards, so an uninstall would have to edit a file it
  did not write", which is what a **marker** answers. `addedBy()` and
  `blockEnd()` are that, and they are the asymmetry this module already draws
  over the script file, one file along: a block carrying both is ours and comes
  out, and a line carrying neither is somebody's and is described instead. It is
  also the shape every installer that edits a dotfile uses, Bun's `# bun` comment
  included, which is where the ticket came from.

  The printed **recipes** say the same thing now, and for one commit they did
  not: the zsh `fpath` route offered an `echo ... >> ~/.zshrc`, which is the
  append SIG-151 declined and is also the one that cannot work, because `>>`
  lands below `compinit`. See "What the first PR review round found" in
  `docs/history/shell-completion-printed-from-the-tree-the-parser-already-ho.md`
  -- which until that branch's second round sat a thousand lines away inside
  the multiline field's section, a `#####` heading landing in the wrong `####`
  block, so this very "see below" pointed _above_. The sixth instance of the
  collision this file already records, and the reason the two rounds are
  numbered now.

  What stays asymmetric is which file each direction may destroy, and it is
  **stricter** on the file the user owns. A foreign _script_ at our path is
  offered for replacement on a default-no question, because a generated file
  somebody edited is the ordinary upgrade case; a foreign _line_ in a startup
  file is never edited in either direction and no answer makes it so. There is
  nothing to upgrade there and a `.zshrc` is not a file to take a guess in.

- **Three questions decide the route, and the one table has three readers
  now.** `installHint()` already said where each shell looks, because the
  generated script's own header prints the recipes and so does the no-TTY
  branch; the installer resolves the same table rather than knowing a path of its
  own. `should carry the same install routes in the %s script as it prints as
  instructions` was already the guard for two of the three and covers the third
  for free, because what the installer resolves is the table's `id`.

  Resolved **by id** rather than by position or by label, which the first version
  did: a route list reordered would have moved every target.

- **`~/.local/share/completions` rather than `paths.data()`, and that is not
  the house rule being broken.** `paths.data()` on macOS is
  `~/Library/Application Support`, which is right for a cache and wrong here for
  a measurable reason: **bash-completion's own fallback is
  `${XDG_DATA_HOME:-$HOME/.local/share}` on every platform**, so a completion
  written where `paths.data()` says is a file bash-completion never looks in. So
  the base is `XDG_DATA_HOME` through `paths.baseDir()` -- the same rule every
  other base in this repository reads, which expands a leading `~` and then
  requires the result to be absolute -- falling back to `~/.local/share`.

  `baseDir()` is **exported** for it rather than reimplemented, which is the one
  change SIG-151 made to `paths.ts` and is the rule this file keeps everywhere
  else: a second reader of "which directory does this variable name" is how two
  halves of one tool come to disagree about `XDG_DATA_HOME=./data`.

- **Both shells are sourced now, because the sourced line is the one an append
  can place.** A zsh completion is conventionally a file called `_app` that
  `compinit` autoloads off `$fpath`, and that is the route SIG-151 printed -- and
  it is the one line no append can put where it goes: `fpath=(dir $fpath)` has to
  run **above** `compinit`, and `>>` lands below every `compinit` there is.
  Measured in zsh 5.9 against a `.zshrc` of the ordinary shape: appended after
  the `compinit`, `whence -w _mycli` is `none`; moved one line above it,
  `function`. So the route the installer **takes** is the other one zsh has --
  the script is sourced and registers with `compdef`, for which the end of the
  file is exactly right -- and one file has served both modes since SIG-139
  through the `$funcstack[1]` test, so neither the script nor its path moved.

  What that gives up is lazy autoloading, and it was measured before it was given
  up: in zsh 5.9 over 200 iterations with three runs agreeing, sourcing sigil's
  own 11.5 kB script is **0.20 ms** and a 115 kB one **1.88 ms**. A shell startup
  does not notice either, which is what makes the robust install the cheap one
  too. The `fpath` route stays in the table as a recipe to follow by hand, since
  it is a perfectly good way to load a completion and is still what
  `"${fpath[1]}"` is for.

  So both shells' `user` routes need a block, and
  **bash-completion's user directory needs none at all** -- which is why it is
  offered first for bash where it is there, and is the one route whose author has
  never run it. Offered first rather than _acted on_ first, which is the
  distinction the second PR round is about: the table's order decides where a
  **new** install goes, and `installTarget()` decides which route to act on,
  which is wherever one already is.

  That route is gated on three questions rather than one, and the third was found
  by the sabotage pass: the path has to **exist**, be a **directory**, and be
  both **writable and searchable**. Measured, each one answers an input the
  others do not -- a missing path is `ENOENT` out of `accessSync` and a
  non-executable file is `EACCES`, so for those two the route is skipped whether
  or not anything asked what kind of thing is there, while an **executable file**
  passes `W_OK | X_OK` outright and the route is then offered over a path
  `writeAtomic()` fails on with `ENOTDIR`. Existence is the version check there
  is: `BASH_COMPLETION_VERSINFO` is set inside a bash that loaded it and reaches
  no environment this process has, and the directory existing means something
  installed a user completion into it, which a bash-completion older than 2.8
  would not have done -- it read `~/.bash_completion.d` and never creates this
  one.

- **`ZDOTDIR` is read through the same `baseDir()`, and the bash startup file is
  the first of three that is a file.** `.bashrc` first, because that is where a
  completion conventionally goes; `.bash_profile` next, because macOS Terminal
  starts a **login** shell, which reads that and not `.bashrc`. A directory
  called `.bashrc` is not a file and is skipped, which `statSync().isFile()`
  answers and `existsSync()` does not -- the probe had the second and is the
  entry below.

- **`writeAtomic()` rather than `writeFileSync()`, and it is the one from
  `config/atomic.ts`.** Which is 80 lines about doing it correctly and is not a
  thing to write twice: the temp-plus-rename, the mode preserved so a `0o600`
  file stays one, the owner put back under `sudo` so a root-run install does not
  leave a file its owner cannot edit, and the **symlink chain resolved through
  `realpathSync.native`** so a `~/.local/share/completions/_app` that a dotfile
  manager made a link into a repository is written **through** rather than
  replaced. `mkdirOwnerSync()` comes with it, so the directory is free. Both are
  published for this caller, which is the second time the store kit has earned
  being public.

- **There are three markers now, and the two new ones are what let a block be
  taken back out.** `addedBy()` is `generatedBy()` with one word changed, and
  deliberately: the two answer the same question about two different files, so a
  reader who has met one recognises the other. `blockEnd()` is the half that
  makes an extent a fact rather than a guess -- without it the span of a block is
  "as many lines as `rcBlock()` would write today", which is a claim about the
  version that wrote the block rather than the version reading it, so a block
  whose shape changed between releases would be cut by the new one's line count.
  With it, `blockSpan()` either finds both and knows exactly what to remove or
  finds one and refuses, which is the direction every other guess here resolves
  in. A file holding the opening comment and no closing one is `theirs` and is
  described.

- **The marker in the script's own header is how it knows one of its own, and it
  is a whole header line rather than a substring of the file.** `# zsh
  completion for \`app\`, generated by sigil.`is written by both emitters, so a
  file holding it in its first three lines is generated output and anything else
  is somebody's. Both halves were review findings and each is a file somebody
  wrote being destroyed: a substring search over the **whole file** read a note
  quoting the sentence fifty lines down as ours and`planUninstall()` unlinked it
  on one default-yes Enter, and a substring search over the **window** read a
  hand-written second line that mentions the marker the same way.

  It **narrows** the class rather than closing it, which the comment claimed for
  a commit: a file one of whose first three lines is _exactly_ that comment is
  still read as ours. Accepted rather than closed, because no marker scheme can
  do better -- that file is byte for byte indistinguishable in its header from a
  generated script somebody edited the body of, which is the ordinary upgrade
  case and **must** be replaceable. What the design buys instead is that the cost
  of the false positive is one Enter on a question that named the path.

- **The two directions are not symmetric about a stranger's file, and that is
  the decision rather than an oversight.** An **install** over a foreign file
  asks, defaulting to no, and replaces on a yes; an **uninstall** of one is
  refused outright and never offered. Which is `planUninstall()`'s own sentence:
  replacing a generated path is the ordinary upgrade case and is worth asking
  about, where deleting a stranger's file gains nothing a `rm` would not.

- **Both apply paths re-read the file, because a plan is a snapshot and a
  question takes time.** A plan that said `create` was an answer about bytes
  that may no longer be there: the question can sit on screen indefinitely, and a
  second terminal, a dotfile manager or an editor can put a file at the target in
  that window. Found by review.

  What the re-read does **not** close is that a yes about one stranger's file
  covers a _different_ stranger's file that arrived in the same window, and the
  comment claimed the opposite for a commit. Kept rather than tightened, for two
  reasons: the question names the **path** and nothing else, so a yes is an
  answer about that path and the bytes were never shown for it to be an answer
  about; and the destructive direction is refused at any age. Tightening it would
  mean carrying the planned bytes on the plan so that a yes could be refused in
  exactly the case the user said yes to. Pinned so that it is checked rather than
  declared.

- **`writes` and `changes` are two questions, and SIG-155 moved the gap between
  them to the other direction.** `writes` is whether there is anything to write
  or remove; `changes` is whether anything at all is outstanding. Under SIG-151
  the gap was on the **install** side: a script already current with a startup
  file that never got its line was `changes` and not `writes`, because a question
  about something this only ever **printed** is asking permission to do nothing --
  and then saying "nothing to do" to a yes, which is what it did until the
  command was driven by hand. The block is written now, so that case is a write
  and the two agree there: it asks, and `should ask, and write only the block,
  where only the block is outstanding` is that driven end to end.

  What is left is the **uninstall**, and the state that keeps the pair apart is
  `theirs`: a line the user wrote is still only ever printed, so a script already
  gone with such a line still in the file is `changes` and not `writes`. Which is
  exactly the shape the original defect had -- a **foreign uninstall** whose
  `changes` counted the rc line and whose `writes` was false by design reached
  the writer anyway, and its refusal came out of the generic error handler as a
  crash. Two fixes each right alone, composed into one, and which one you got
  depended on a line in a file this does not write. Found by SIG-151's review
  round 2, and its fixture is a `theirs` line now rather than a block of ours,
  because a block of ours **is** a write and the old fixture would no longer
  reproduce what it is named for.

  The sabotage pass then measured which direction the writer's gate decides:
  `applyInstall()` answers `false` for a `current` plan itself, so for an install
  it is redundant and the uninstall is the whole of it.

  **And moving that boundary brought the round-2 crash back twice over, which is
  what a changed premise costs.** Two things rested on "a foreign file is nothing
  to write, so `writes` is false and an uninstall does not ask", and the block
  counting made both false. `runInstaller()`'s apply is an object literal, whose
  properties evaluate in order, so `applyUninstall()` ran before `removeRc()` and
  its refusal for a foreign plan reached the generic error handler as a crash
  with the block left behind -- the gate is `plan.file === 'update'` now, so the
  script is left and the block still goes. And `question()`'s `foreign` branch
  carried that reasoning as a comment: a reader uninstalling was asked "Replace
  it?" about a removal, defaulting to no, which both read wrong and **hid the
  crash** behind an Enter that cancelled. It is `action === 'install'` now rather
  than relying on a condition elsewhere. Both reported on PR #191.

  What made them invisible is worth more than either fix. The unit test for the
  pair calls `removeRc()` first and `applyUninstall()` second, which is the
  **opposite** of the production order -- so it asserted the right outcome of the
  wrong sequence. `should take its own block out in the order the command applies
  them` is written in the production order for that reason, and the TTY test
  beside it drives the real command, which is what found all three.

- **One name, one program, and the shared predicate was the half that was
  already shared.** `registerable()` was asked by both readers and
  `completionSpec()` asked it of `oneLine(name)` while the installer asked it of
  the raw string -- so the predicate agreed and the **subject** did not. Measured
  on both inputs: `name: 'my<ESC>cli'` wrote a header naming `mycli` into a file
  called `_my<ESC>cli` whose marker was built from the raw name, so the first
  install wrote and **every re-run read its own file as foreign** -- it asked
  before replacing the script it had just written, and `--uninstall` refused to
  remove it at all. An installed completion nothing could maintain or take back
  out. And `name: ' mycli '` was served by the printer and threw on the install
  path, because `installTargets()` runs before `completionScript()` does.

  `programOf()` is the one reader now, and the `?? 'app'` fallback went with it:
  a nameless app reaching the **uninstall** direction, which builds no script and
  so met no other guard, was looking for a file called `_app`. Found by review
  round 3, which is the shared-predicate-unshared-subject shape.

- **The markers are asked before the needles, and asking in the other order
  answered `theirs` about our own block.** A block of ours holds the script's
  path, so it satisfies the needles too -- which would have left `--uninstall`
  with nothing it was allowed to remove. The narrower question, whose yes is the
  only one that permits an edit, goes first.

- **And there are two needles, because SIG-151's own installs name a different
  path.** That version's line named the completions **directory** and this one's
  block names the **script**, so a needle of the script alone finds nothing in
  such a file -- and a machine with a perfectly good `fpath` install would have
  had a second registration appended underneath it, the completion loaded twice,
  from a command that said it had added something the reader did not need. So the
  directory is a needle too for zsh, and that install reads as handled. It is
  also what makes a second sigil app on such a setup need nothing, which is the
  property the single needle was originally written for. bash gets the script
  alone, because nothing bash does reads a directory off a variable and its own
  SIG-151 recipe was a `source` of exactly this path.

- **A needle matches only where the path **ends**, and a plain substring search
  was a silent install failure.** Every block of ours names `<dir>/_<program>`,
  which _contains_ `<dir>` -- so the directory needle hit inside the first
  installed app's block and every app after it read as `theirs`: the plan said
  "already names it", the script was written, and nothing ever sourced it. An
  install that reported success and did not work, which is the worse half. The
  file needle had the same defect one name along, since `_one` is a prefix of
  `_onetwo`. Reported on PR #191, where the tests only compared the needle
  _arrays_ and so could not see where a needle matched.

  `namesPath()` is the rule and it is a rule about a **path** rather than a
  special case for the directory, because both are the same question: did the
  needle end where the path ended. What may follow is enumerated from the other
  side on purpose -- what may _continue_ a path is every character a program name
  can hold, and `registerable()` leaves that wide, so `-`, `.`, `+` and `@` are
  all in it. So `AFTER_PATH` is the shell delimiters instead: whitespace, a
  quote of either kind, `)`, `:`, `;`, `,`, and the **end of the file**, which is
  the one that is an absence rather than a character and is the one the first
  sabotage pass walked past, because every fixture ended in a newline. Walked
  with `indexOf` rather than a regex, since a path is full of characters a
  pattern would have to escape and an escaping bug reads as a needle that never
  matches -- which is the silent direction again.

  It keeps both answers it has to: `fpath=(<dir> $fpath)` still counts, because
  a space follows, and `<dir>/_one` does not, because a `/` does.

- **An rc line is recognised by the **path** rather than by the line, in four
  spellings.** Somebody who added it themselves wrote their own quoting and their
  own order, and the path is the granularity a human checks at. The four are the
  absolute path, `~`, `$HOME` and `${HOME}` -- and the `~` one is **this
  package's own output**, since every generated header and every printed recipe
  writes one, so an absolute-only needle reported `absent` for ever for exactly
  the population that did what they were told. `${HOME}` is the braced form a
  hand-maintained dotfile uses because it survives concatenation, and it was the
  one the first version missed.

  Three details are not decoration and each was a review finding. The home has to
  end at a **separator**, or a needle that merely shares its prefix derives
  `$HOMEa/...`, naming a different variable. The forward-slash rewrite covers the
  **absolute** spelling too, because `join()` backslashes it on Windows where a
  Git Bash user writes `C:/Users/ann/...`. And the slice is from the **edge**
  rather than from the home, because a home of `/` -- which is what a root
  account has in a container -- otherwise loses the separator and derives
  `~home/u/...`. That last one has no observable consequence, measured: `/` is the
  only home the old slice drops a separator for, and there every home-relative
  spelling trivially _contains_ the absolute one, which is in the same list -- so
  a test written for it passed against the defect and was deleted rather than
  shipped.

- **Which shell is a `select()` rather than a `confirm()`, and `$SHELL` is the
  **login** shell.** `$SHELL` is what the login shell was set to, so a zsh
  started from bash still reports bash -- which is why the detection is an
  **initial** on a list rather than a question with a yes. An arrow key is the
  override, and where `$SHELL` names nothing this knows there is no initial and
  the list is the whole question. Driven end to end, because the one thing a unit
  test of the plan cannot say is whether the arrow key reaches it.

- **Every word of the interaction goes to stderr.** `createTerminal()` defaults
  to stdout, and this command's stdout is the script -- so a settled
  `? Which shell? zsh` would land in whatever `app completion zsh > file` was
  redirected into the moment the two forms met. Which is the same call
  `report.ts` makes about asking the stream it is going to, and it also moves the
  **gate**: the prompts refuse unless the terminal they draw on and stdin are
  both terminals, so a bare `app completion > file` from a terminal asks rather
  than refusing. Found by driving the command rather than by a test.

- **With nobody to ask it prints what SIG-139 printed, and Ctrl-C is not that.**
  A pipe, a CI job, `stdin` closed: `PromptError` is what the prompts throw and
  what `byHand()` catches, so the no-TTY branch is the recipes and a non-zero
  exit -- byte for byte what the command did before an installer existed, which
  is what the three pre-existing tests for it assert. `PromptError` carries an
  `aborted` flag, so a Ctrl-C says `Cancelled` rather than reciting a recipe
  nobody asked for. Found by review round 1, which is the half the shared error
  type makes free and the first version read as one case.

  And the recipe is **direction-aware**: an uninstall with a target prints the
  `rm`, and one without prints the shell to name. Both of the second branch's
  halves had no test at all, because every other no-TTY uninstall names a shell.
  Found by review rounds 1 and 3, once each, which is the same hole refilled with
  new code.

- **What it costs is `+199,081 B` over 25 modules on the one path that asks a
  question, and nothing anywhere else.** Which is the whole packaging argument:
  `confirm()` and `select()` are the components barrel, so a statically imported
  one would put the prompt stack behind `app completion bash > file` -- the
  scriptable form, which asks nothing. So the flow is a third module behind an
  `await import()`, and the measurement is better than "small": the body written
  inline took the parse chunk from 21,291 B to 22,527, and moving it out leaves
  **21,176** -- 115 bytes _below_ where it started, because the no-TTY fallback
  text that used to be inline went with it. The printer's own graph was 62,371 B
  over 12 modules and the interactive one 258,740 over 36. The root entry was
  **7,518 B** then and unchanged by this.

  Those two figures are **as of SIG-155**, re-derived with `staticGraph()`
  against a `main` worktree built beside the branch, so each is a difference
  between two builds rather than a figure carried forward: the interactive graph
  is 270,334 B over 41 modules and the printer's 71,253 over 16. Editing the
  startup file cost the printer **+497 B** -- `rcBlock()` and the two markers,
  which `install.ts` holds because the emitters' headers print them -- and the
  interactive graph **+1,145**, with the module count unchanged on both. The
  graphs anybody else pays for moved by **nothing at all**, byte for byte:
  `index.mjs` is 12,009 B over 7 modules and the parse chunk 50,566 over 14,
  identical on both builds, which is the packaging argument holding after the
  feature grew a second writer.

  The ticket's estimate was +180 kB and it held. Re-measure rather than quote:
  these moved by 1,218 B when SIG-151's review round 1's fixes landed in
  `interactive.ts` and nobody re-ran the one measurement the comment says to,
  which review round 2 caught -- and then the pair it was corrected to, 258,740
  and 62,371, was two tickets stale by the time SIG-155 re-ran them, the printer
  having grown 8,385 B and the interactive graph 10,449 since, none of it either
  feature's -- and the same pass found AGENTS.md recording the components barrel at
  **124 kB**, which was four themes and a smaller component set ago and was
  **240,792 B over 27** when this was measured. `components.mjs` grows with what is
  in it, so a figure in this file that only a re-run can confirm is the stale
  snapshot it warns about: three _other_ live copies of that barrel's size said
  239,929 B over 26, from before SIG-136's QR encoder landed, and they are
  corrected with it -- four copies of one measurement at two values is exactly
  the disagreement one of those entries is itself written about.

  `config.mjs` moved too, from 38,101 B over seven modules to **38,239 over
  eight**, because `atomic.ts` is now shared with the installer: 138 bytes of
  preamble for the sharing, which is the honest form of what the store kit costs.

- **The block runs a `compinit` only where nothing has, and the test for that is
  a runtime one -- which is what deleted `RcAnchor`.** That type was a
  three-valued answer to "which line does the `fpath` line have to go above", read
  by grepping the startup file for the word, and its own doc records both that the
  interesting value conflates three states a framework puts a reader in and that a
  table of what runs `compinit` "was built and refused" for having exactly one
  measurable entry. `(( $+functions[compdef] ))` asks the shell at startup instead
  and needs no table: `compdef` is a function only after `compinit` has run, which
  is precisely the question.

  Verified in zsh 5.9 in all three shapes, with a counter on the guarded branch,
  because a redundant `compinit` is **~12 ms** of somebody's shell startup rather
  than nothing -- measured, 172 ms for a first call on a cold `.zcompdump`, 17.6
  warm, and 11.6-12.2 for a second whatever the dump. A bare `.zshrc` runs it and
  registers `_mycli`; a `.zshrc` with its own `compinit` above skips it and
  registers; the Oh My Zsh shape -- a framework sourced above with no literal
  `compinit` in the file -- skips it and registers. `should guard its own compinit
  rather than reading the startup file for one` is that as one set of bytes over
  three startup files, which is the sharpest form of the claim: three files that
  used to produce three different messages now produce one block.

  What went with it is the stale-`.zcompdump` worry "Then restart your shell" was
  written against, and that is worth recording rather than deleting: the installed
  route puts nothing on `$fpath`, so there is no dump in the path to go stale. It
  still applies to the `fpath` recipe a reader may follow by hand, which is where
  `--completion`'s own step now scopes it.

  It is still the case that nothing here **runs** anything: the `compinit` is a
  line in the user's own file, which they approved, rather than this process
  reaching into a shell it does not own.

- **`scripts/terminal-probe.mjs --completion` is where the claims only a
  terminal can settle went.** Five steps, each with its own `the claim:` line:
  what the installer reads and what `$SHELL` is, the bash-completion route whose
  author has never run it, the recipes run in a throwaway directory so that
  nothing touches a home, the `compinit` cache, and what it does to a startup
  file.

  SIG-155 moved two of those and the open question moved with them. The third
  step's zsh recipe is the **sourced** route now, which is what the installer
  takes, with the `fpath` one kept beside it because that one is still a recipe a
  reader may follow -- all three were run before the text was written, and
  `comp=_mycli`, `comp=_mycli` and `complete -o default -F _sigil sigil` is what
  they answer here. The fourth step is no longer about the installed route at all,
  for the reason under the `compinit` guard, and says so rather than being
  deleted. And what is genuinely open is now the **guard** rather than the cache:
  it was verified against a bare `.zshrc`, one with its own `compinit`, and a
  framework sourced above with no literal `compinit`, and never against a real
  prezto, zinit or zplug -- a framework that initialises completion lazily or
  after its own `.zshrc` hook is the finding that step asks for. It
  prints the **shell expression** for the bash-completion directory rather than a
  path it worked out, because a path worked out here is the second reader
  `install.ts` is written against -- and the two rules genuinely part company for
  `XDG_DATA_HOME=./data`, which the text names rather than papering over.

  Three of its own statements were divergent readings of a rule stated elsewhere,
  which is the thing a probe must not be: `existsSync` where the installer asks
  `isFile()`, `~/.zshrc` where `ZDOTDIR` moves it, and then -- in the code written
  to fix the second -- `isAbsolute(zdot)` where `baseDir()` expands a leading `~`
  first. Found by review rounds 2 and 3. Driven under `ZDOTDIR=~/zdot` and read
  `/Users/chris/zdot/.zshrc` back, which is the installer's own answer.

##### Keeping the tests out of the real home

- **`node:os` is mocked, not only `HOME` stubbed, and both halves are load
  bearing.** `paths.home()` memoizes `homedir()` on first read, so a variable set
  after any other test in the worker has already asked is too late -- and
  `vi.mock` is hoisted above every import, so the first ask in the file gets the
  fake. The _variables_ are stubbed as well, because `expand()` reads `%VAR%` on
  Windows and because a second reader added later should find a fake there too.
  This repository has already been bitten by a test that scaffolded into the
  runner's real profile directory because it set only `HOME`, which is why both
  are written down rather than one.

  The first assertion in the file is that `homedir()` **is** the fake, so a mock
  that stopped working is a failure rather than 60 tests quietly writing into
  somebody's home.

- **The home is emptied and recreated per case rather than only created.** It is
  one directory for the whole file, so a `.bashrc` one case wrote is a `.bashrc`
  the next case's `firstExisting()` finds -- which is a test passing on a fixture
  it did not set up, and is how an `EEXIST` creating `.bashrc` as a directory
  turned up.

- **The spawned half points `HOME`, `USERPROFILE` and `XDG_DATA_HOME` at a
  `mkdtemp` box per case**, and `XDG_DATA_HOME` is what the installer reads
  first -- so even a `homedir()` that somehow answered the real home would put
  the script under the box.

- **And the three mode-based cases are skipped where a mode bit means nothing,
  which is two platforms rather than one.** Root passes
  `accessSync(dir, W_OK | X_OK)` on a directory with neither bit set, so a
  rootful CI container would fail them over a premise that is false for the
  runner rather than for the code -- review round 2 flagged the first of the
  two gate cases and round 3 caught the second inheriting it unremarked. And
  **Windows**, where `chmod` only toggles the read-only flag: a `0o200` or
  `0o500` directory is still writable _and_ searchable, and a file chmod-ed
  `0o600` reads back `0o666`. Which is the rule this file already records for
  `write.test.ts`'s own mode cases, and which cost this branch all three Windows
  jobs with the other six green -- the **sixth** instance of the signature
  Conventions names, and the first where one predicate covered two unrelated
  reasons. What stays pinned on both is the half that is not about a bit: the
  executable-file case asks `isDirectory()`, which answers the same for
  everybody.

- **And a test never spells a separator, which the route differential did.** The
  claim is that a route's printed `commands` name the path the installer
  resolved, and `commands` are **shell text** -- forward-slashed on every
  platform -- while `target.file` comes from `join()`. So it compared
  `~\.local\share\...` against `~/.local/share/...` and failed on Windows
  alone. The fix is `replaceAll(sep, '/')` on the test's side, which is the rule
  Conventions states in its sharper form: compare a path against another path
  built the way the subject builds it, and never write the separator.

> Moved: _What the three review rounds found, and what the sabotage pass found after them_, _What the first PR review round found: a recipe that could not work if followed_, _What the second PR review round found: the route that was not where the install was_, _What the third PR review round found: the compinit line that is not there_, _SIG-155: appending the block, and the three guards the sabotage pass had no test for_ — see [docs/history/shell-completion-printed-from-the-tree-the-parser-already-ho.md](../../../../docs/history/shell-completion-printed-from-the-tree-the-parser-already-ho.md).

##### What is deliberately out

- **Editing a line this did not write**, which is what is left of SIG-151's
  refusal to edit a dotfile at all and is the half that stands: a `.zshrc` is
  often under version control, there is nothing in one to upgrade, and a wrong
  guess there is somebody's shell. So `theirs` is reported in both directions and
  `removeRc()` cuts only a span `blockSpan()` found.
- **An Oh My Zsh route, which would need no startup-file line at all and is the
  shape the bash side already has.** Oh My Zsh puts `$ZSH_CACHE_DIR/completions`
  on `$fpath` itself, at line 68 of `oh-my-zsh.sh`, so a `_app` dropped there is
  loaded with **nothing added to any file** -- measured, and its own `charm`
  plugin writes a generated completion into exactly that directory, which is as
  close to a sanctioned location as a framework offers. `omz reload` clears only
  the compdump, so it is not swept. That is `bash-completion`'s own user
  directory one shell along, gate and all: the directory existing is what stands
  in for a version check, because `$ZSH` is set only inside a zsh that sourced
  the file and reaches no environment this process has.

  Refused **here** rather than refused outright, and the distinction matters: it
  is a new `RouteId`, a tier in `installTarget()`'s search, an uninstall path and
  a row in every script's header, taken inside a round about a sentence -- which
  is the call this file records for narrowing the toolchain's type check inside a
  caching ticket. It also writes into another tool's **cache** directory, where
  `bash-completion`'s is an XDG data directory documented for user completions,
  so the two are not on the same footing and that is a decision somebody should
  take on its own terms. What the message fix buys in the meantime is that the
  one-line edit it asks for is followable, which it was not.

- **An `--install` flag or an `install` subcommand**, with the reason at the top:
  the bare spelling was already a command whose whole output was instructions.
- **Running `compinit` or sourcing anything**, which is a shell's own business
  and would be this process reaching into one it does not own.
- **fish and PowerShell**, which is SIG-139's refusal unchanged and unaffected:
  the routes are a map keyed by shell, so a third one is a route plus an emitter
  plus a run by somebody who has that shell.
- **A `--path` override** for where the script goes. `XDG_DATA_HOME` is the
  knob the format already has, the routes are what the header and the
  instructions print, and a fourth spelling of "where does this go" is a second
  answer to the question the table exists to answer once.
- **Tightening the replace window to the planned bytes**, with the reason under
  the re-read: the question names the path, and the destructive direction is
  refused at any age.
- **Finishing a machine that holds two of ours in one call**, with the reason
  under `installTarget()`: it would mean a plan that names two files and a
  question about both, and a guess there deletes a second file the reader was
  never shown. One call acts on one of them and a second `--uninstall` takes the
  other out.
- **A demo under `demos/`**, and that is a decision rather than an omission.
  `demos.test.ts` spawns each one with the **real** environment, so a demo of
  this writes a script into the runner's own home -- which is the one thing this
  ticket's tests are built to make impossible. And it spawns with stdin
  `'ignore'`, so such a demo would take the no-TTY branch and print the recipes
  SIG-139 already prints, exiting 1: a third entry in that file's two-demo
  exception list, shaped exactly like the thing a demo cannot show. The real
  thing is driven by `terminal-probe.mjs --completion`, which asks a human to
  run the two recipes in a throwaway directory, and by
  `packages/cli/test/completion-install-tty.test.ts`, which spawns the real
  binary over a faked terminal with `HOME` pointed at a box.
