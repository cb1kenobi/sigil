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
