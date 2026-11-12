# `packages/sigil/src/help` — deliberate decisions

These are the entries from [../../../../AGENTS.md](../../../../AGENTS.md) that are about this directory. Claude Code loads this file when it
works with files here; other agents should read it before changing
anything in this area. The root `AGENTS.md` holds the rules that apply
everywhere and still applies in full.

How each of these was arrived at — the review rounds and sabotage
passes — is under [docs/history/](../../../../docs/history), linked from
the entry it belongs to.

## Deliberate decisions — do not "fix" these

### Help

- **`--version` is the framework's, for the reason `--help` is, and the reason
  is sharper than convenience.** Every CLI has one and each used to write it:
  declare the option, parse, read `argv.version` back and print. That works
  until the app is built -- `sigil build` generates the executable and calls
  `main()`, so whatever the app's own bin did _around_ `main()` is not in the
  bundle. The toolchain's own `--version` printed **nothing at all** once it was
  built with itself, and exited zero doing it, which is the worst shape a
  divergence can take. `node src/sigil.ts --version` and
  `node dist/sigil.mjs --version` have to be the same program, and the schema is
  the one thing the build carries across whole -- so that is where the version
  goes. `schema.help: false` has no twin: leaving `version` out is the opt-out,
  because an app that names no version has nothing to answer with.
- **A version may be a function, and that is what a bundle needs.** An app
  reading its own `package.json` is the ordinary case, and doing it eagerly is a
  file read on every run -- including the runs that never ask. In a bundle it is
  worse than wasted: `../package.json` off `import.meta.url` points wherever the
  bundle was written, so the read _throws_, and putting it in the schema turned
  a silent `--version` into a crash on every invocation. A function is called
  only when `--version` was used, and `sigil build` replaces it outright with
  the literal it read from the manifest at build time. So the function is the
  unbundled answer, the string is the built one, and neither is a file read at
  startup. This is the entry about a bundled app not reading files relative to
  `import.meta.url`, met from the inside and answered rather than warned about.
- **Help outranks it, which is the rule help already had.** `mycli --help
  --version` prints help: being asked what a program does and answering with a
  version string is not an answer. `detectHelp()` is asked first and
  `detectVersion()` only when it found nothing, so the ordering is one line
  rather than a precedence table.
- **A run that named no command gets the help screen, and `main()` is what
  prints it.** A CLI that is all subcommands has nothing to do without one, and
  printing nothing tells the reader neither what went wrong nor what is
  available. It was the toolchain's own bin that did this, which is the same
  bug `--version` had: a built CLI printed nothing where the source printed
  help. Three things have to be true, and each of them is a test that said so.
  The app declared `commands`, because a schema that declares none is one being
  used as a parser and a help screen is not what that caller asked for -- and
  the `help` command added to every schema means the _registry_ is never empty,
  so the declaration is what has to be asked about. `help` is not `false`, since
  that means the app owns what help means. And nothing else answered: a command
  with a `run`, a `default` command, `--help` and `--version` all leave before
  it. `HelpRequest.via` grew `'empty'` to say which of the three reached it.
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
  each, none for a default -- from the innermost one rather than by counting
  them, so a typed subcommand of a default is still what is described (SIG-340,
  under "`--help` is trimmed from the innermost command argv named" in
  `src/parser/AGENTS.md`).
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
  screen, which is the same call `formatValue()` makes for a default that cannot be
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
  the order the schema wrote them. Commands used to be registered as their
  initialization resolved, so one with subcommands of its own landed after its
  siblings and sorting was the only stable thing to print. SIG-230 made a
  registry's order its declaration order, so that reason is gone, and the sort
  stays for the ones that are left. A registry is not only the schema's: the
  parser appends `help` and `completion` after the app's commands, a hook's
  `commands.add()` appends wherever it runs, and a routed directory has no
  declaration order to keep, only the walk's own sort. And a sorted list is the
  one a reader can scan for a name. Printing declaration order instead would
  change every app's help screen, which is a decision of its own rather than a
  correction to this entry.
- **And it sorts by code unit, not by `localeCompare`.** SIG-238. `localeCompare`
  reads the process locale, so one app's help listed in two orders on two
  machines -- the defect SIG-235 fixed for the route walk and the generated
  output, here on a screen rather than in a file. `path.ts` and the table's
  default sort already order a list a person reads by code unit for that reason,
  and `src/i18n/AGENTS.md` records locale-aware sorting as out of scope. It is
  `byCodeUnit()`, and the palette's catalog uses it too, since its base order is
  help's. What that does to a name is put upper case before lower -- `B` before
  `a` -- and `-` before `_`, so `a-b` before `a_b`. No collation agrees with
  either, which is how `should sort the commands by code unit` fails under
  `localeCompare` on any machine rather than only on one set to a language that
  happens to disagree.

  It is not the speed-up it looks like, and the measurement is why. The first
  `localeCompare` in a cold process costs about 4 ms and `--help` paid it --
  3.76 to 3.97 ms in-process, over the 19 calls one screen of eight commands
  makes. But that cost is ICU loading, and ICU is shared: the wrapper builds an
  `Intl.Segmenter` to measure help's text, ASCII or not, and once
  `localeCompare` stops paying the load the segmenter does -- 1.3 to 1.4 ms
  before this change and 4.9 ms after. So what it saves is the collator's own
  share. Interleaved over 100 pairs of `--help` on an app of eight commands,
  node 26.10.0 on macOS, as of SIG-238: a minimum of 44.75 ms before and 44.32
  ms after, a median of 46.63 ms and 46.45 ms. Two earlier runs of 60 pairs
  agree, at medians of 47.25 against 46.97 and 47.58 against 47.15. A quarter
  to half a millisecond, then: the change stands on the order, and the 4 ms is
  there for whoever gives the wrapper's measurement an ASCII path that never
  builds a segmenter. SIG-243 did, and an all-ASCII `--help` builds none now:
  the measurement is under "Plain ASCII never builds a segmenter" in
  `src/width/AGENTS.md`.

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
- **The description column is told its width, and after SIG-125 that is a choice
  rather than a necessity.** `width - column` was the one piece of arithmetic help
  kept, and the reason was a measurement: a row's intrinsic height was taken with
  every child offered the whole content box while placement hands each one a share,
  so a description that wrapped to three lines in its share measured two lines tall
  in the room it was offered and the block after it was drawn over the third. That
  is closed in the engine now, so a plain `flex-basis: 0; flex-grow: 1` lays out
  correctly here -- which is the whole point of the fix, and it is why an app writing
  an ordinary row needs no subtraction of its own.

  Help keeps its own, and the attempt to drop it is worth recording because it looked
  free. Over ten widths and three contexts the two produced byte-identical screens,
  and both reasons they are not equivalent are outside that corpus.

  It **overflows the terminal** where a description's longest word is wider than the
  column. `paragraph()` gives each word `min-width: 0`, so a paragraph's own minimum
  looks like nothing -- but a wrapping row's minimum is `hypotheticalMain()` of its
  items, which clamps each word's _measured_ width rather than its declared minimum.
  Measured: `supercalifragilisticexpialidocious` beside a ten-column label in forty
  columns came out as a **46-column** row with the word whole, where the declared
  width breaks it at 28 and the screen stays 40. A paragraph disagreeing with the
  wrapper is a help screen wider than the terminal, which is what `min-width: 0` on
  the words is there to prevent.

  And it is **slower**. A declared width makes the post-flex re-measure the same
  question the first measure answered, so the words are measured once; a share is a
  different width, so they are measured twice. Interleaved over six rounds of a
  sixty-entry screen the share is **11.46ms to 12.81ms** median, **+11.8%**, and +16.7%
  at its fastest -- roughly what the engine fix itself costs, spent again for nothing
  visible.

  The two one-column branches declare a width for a third reason that never had
  anything to do with the defect: their parent is a _column_ with
  `align-items: flex-start`, so the description's width is a cross size that never
  flexed and there is no share to ask for.

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
- **The help label is the name string's, and the `alias` property never reaches
  it -- nor the `Alias:` block.** The root `AGENTS.md` has said since M2-20 that
  an alias which should stay out of help without hiding the command belongs in
  the `alias` property, "which never reaches the help label", and
  `docs/parser.md` and the README said the same. The code never did. M2-20
  (`eb5a883`) recorded the rule and built the field that carries it --
  `parseName()`'s `label`, the bare and `@` labels in the order they were
  written, never a `!` one and never the property -- and `22d57a5` carried that
  label across a lazy load "for help", with regression tests asserting
  `'build, b'` plus `alias: 'compile'` labels as `build, b`. Seven hours later
  the first help renderer (`53a2f03`) built every row from
  `[cmd.name, ...aliases]` instead, and nothing has read `label` since; its
  commit message lists the help decisions worth knowing and aliases are not one
  of them, and its tests used property aliases as the ordinary way to put a name
  on a row. So it was drift with no recorded reason rather than a later
  decision, and SIG-225 restored the record: `rm` beside `remove` stopped being
  printed. The cost of the drift was that the rule had no spelling at all -- with
  every alias in help there was no way to give a command a name that answers
  without being advertised, which is the one thing the property was for.

  The `Alias:` block on a command's own screen follows the label rather than
  `aliases`, for the same reason: it is help, and an alias listed there is
  advertised to exactly the reader most likely to adopt it. Listing it there
  alone would also make the rule depend on which screen was asked for. The
  screen is still _reachable_ by a property alias -- `mycli help rm` and
  `mycli rm --help` describe `remove` -- and the usage line names the command by
  its name, so the reader learns the name they should have typed. A `!` label
  is left out of that block too, which is what `label` has always meant by it.
  The label is read in the order it was written, so `'@ls, list'` prints
  `ls, list` where it used to print `list, ls`: that is the order the author
  chose, and the order `label` has always held.

  **A `!` or `@` at the start of an `alias` property entry is refused** by
  `initCommand()`, which is the other half: it used to be registered literally,
  so `alias: '!ls'` answered to `!ls` and help printed `list, !ls`. Neither of
  the other readings holds. Hiding that one alias means nothing once the
  property never reaches help, and hiding the whole command -- what `!` means in
  a name string -- would be a second spelling of `hidden: true`. Stripping it
  is worse than either: `!` in a name string hides the command, so a stripped
  `!ls` would publish a command its author tried to hide, which is the
  `'!build, b'` trap the root entry refuses. `@` would be harmless to strip, and
  is refused anyway so that the property has one rule -- it takes names, and
  name-string syntax is a mistake to say out loud rather than to guess at. Only
  the first character is checked: `l!` is a name, if an odd one. Covered by
  `test/help/help.test.ts` and `test/parser/regressions.test.ts`.

  **The label is read by one function, and help is one of three readers.**
  SIG-225 left shell completion and the `sigil reference` markdown listing
  every alias, and SIG-229 brought both in line, because each is a listing. The
  split that was `helpNames()` here is `labelNames()` in
  `src/parser/command/label.ts` now, so the menu, the reference and this screen
  ask one function which names a command publishes rather than each splitting
  `label` themselves. What still reads `aliases` is everything that matches a
  typed word -- the parser, "did you mean", the palette's search, the
  completion script's resolving arms -- and the surface snapshot, which records
  what argv accepts rather than what a screen lists.

  **And it is handed the parent's registry, because a label is a claim about
  what a name runs.** SIG-239. Two siblings may share an alias and the later
  declaration wins it, so `'build, go'` beside a later `'ship, go'` printed `go`
  on both rows while `go` ran `ship`. `labelNames(cmd, registry)` keeps a label
  only where `find()` answers with `cmd`, asked while the screen is drawn, so
  the `Commands:` rows and the described command's `Alias:` block both follow
  a module that loads and takes a spelling. Why this is a listing rule and not
  a refusal is under "What is not refused, and the case for it" in
  `src/parser/AGENTS.md`.

  **And what it lists is what routes, which a lazily loaded module's own name
  string does not.** SIG-316. A routed module is loaded because argv matched the
  name the _registry_ knows it by -- a file name, a `commands` key, a
  placeholder's name and `alias` -- so `name: 'list, ls'` inside `list.ts` could
  never route `ls`, and `loadCommand()` carried the module's label over the
  placeholder's whenever the module renamed the command. `mycli help list` then
  printed `Alias: ls` beside a command `mycli ls` refused with `Unexpected
  argument`. Reproduced over every arrival -- a directory walk, a route one level
  down, a directory's `index`, a declared `path` and a `load` -- and all five
  published the module's spelling; completion and the markdown reference did not,
  because they walk without writing back and so read the placeholder the registry
  still holds. Help is the only reader of the _loaded_ command, which is why it
  was the only listing that disagreed.

  So `loadCommand()` keeps the placeholder's label whether or not the module
  renamed, which is one assignment where it was a condition. The module's
  spellings still register, and still settle a shared one by declaration order and
  still refuse one that is a sibling's name -- those rules are about what the
  registry holds, and are untouched -- they are simply not advertised. The
  decision was to leave help alone from routing rather than teach routing to read
  a module: a level's walk would have to import every module to learn its names,
  which is what the deferral exists to avoid. `sigil check` and `sigil build` warn
  about the declaration instead (`packages/cli/AGENTS.md`, the entry that begins
  "...and a module that declares one is warned about"), and SIG-324 is the real fix:
  a routed directory's `commands.json` declares those spellings where the walk can
  read them without importing anything, and the warning now points there. An
  alias it declares routes and is left out of help, as the `alias` property is.

  Three consequences, none of them new defects. A module that renames the command
  to something else (`name: 'show'` under the key `list`) lists the placeholder's
  spellings as its aliases and still names `show` on the usage line, which is a
  name that does not route and was before this; the rename is the unroutable part
  and the warning names it. A module that brings a spelling a sibling published
  takes it in the registry of the process that loaded it, so that sibling stops
  listing it there while a fresh process would -- an omission rather than a false
  claim, and `labelNames()` asks the registry on purpose. And a `subcommandLoaded`
  hook's replacement still brings its own label: it is the parent's own code
  rather than a module, SIG-239 pinned it, and the ticket was about modules.
  Pinned by `help showed a routed module's name alias, but the alias did not
  run` in `test/parser/regressions.test.ts`, with the two SIG-239 cases that
  asserted the opposite rewritten rather than deleted.
