# `packages/cli` — deliberate decisions

These are the entries from [../../AGENTS.md](../../AGENTS.md) that are about this directory. Claude Code loads this file when it
works with files here; other agents should read it before changing
anything in this area. The root `AGENTS.md` holds the rules that apply
everywhere and still applies in full.

How each of these was arrived at — the review rounds and sabotage
passes — is under [docs/history/](../../docs/history), linked from
the entry it belongs to.

## Deliberate decisions — do not "fix" these

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
- **A load that fails says which module it was, and neither branch could before.**
  `Failed to load command module: no chunk` identified nothing at all for a
  bundled app, whose loader is an anonymous closure -- while the export check
  immediately below it in the same function already said which command it was
  reading. Two errors about one failure, disagreeing about whether the reader is
  told where to look. The `path` branch had the hole too and it is narrower than
  it looks, which is why it is worth writing down rather than inferring: a missing
  file never reaches that `catch` at all, since `existsSync()` answers first with
  a message that names the path, and a module whose own `import` is missing
  already reports `imported from <that module>`. What is left is the module that
  exists and will not **parse** -- measured, one that stops mid-declaration
  reports `Unexpected end of input` and names no file whatsoever, so a routed
  tree of sixty commands said only that one of them would not parse. That is the
  case the test is named for. It is `(the "build" command's loader)` for a loader and
  `(<path>)` for a `path`, which is the `source` vocabulary that export check was
  already using. That is also the whole of what "decorate its errors" wanted out
  of a load hook, answered by the message rather than by a seam.
- **And `load` is not a hook, which is the question its being a function
  invites.** It is one of three mutually exclusive answers to "what is this
  command", and every hook here is the opposite in each respect: without a hook
  the command works fine, hooks combine freely, a hook observes or modifies a
  command rather than constituting one, and `initCommand()` **copies** the
  `hooks` object precisely so a hook can replace a hook. Moving `load` under
  `hooks` would also put two of the three exclusive answers at different nesting
  levels, and would make `sigil build` **merge** into an app's existing `hooks`
  object where it now assigns a property -- a new failure mode in generated code,
  bought for nothing. Dynamic command _registration_ is already a hook's job and
  already works: an `init` or `parse` hook is handed the registries and can
  `commands.add(await initCommand(...))`.
- **`subcommandLoaded` is the hook, and it is the parent's rather than the
  command's own.** A hook wrapping a command's own load cannot usefully exist and
  that is the whole of why one looked unbuildable for a while: the command has to
  be loaded before anything of its own can fire, so its module body and its `init`
  hook already _are_ that moment. The direction with nothing in it is a parent
  watching its children arrive, and that one is real -- a command declared with a
  `path` or a `load` is a placeholder until it is matched, so its description, its
  options and its own subcommands are unknowable to anything above it until the
  module lands. An option a parent adds there is matchable on that same parse, the
  way an `init` hook's is, which is what makes it the moment a parent can give its
  subcommands a flag it could not have declared for them in advance.
- **The schema _is_ the root command, so there is one mechanism rather than
  two.** `parse()` builds `contexts[0]` from `initCommand({ ...schema, name:
  schema.name ?? 'global' })` and `initCommand()` copies `hooks`, so a
  `subcommandLoaded` declared on the schema is already the root command's and
  fires for every top-level command with no special case anywhere. That is what
  collapsed the ticket's "whose hook is it" question: the answer is "the parent's"
  and the schema is a parent. `loadCommand()` therefore takes one extra argument
  -- the parent -- rather than a parent and a schema, and `SubcommandLoadedHookData`
  has no optional `parent` to branch on.
- **It fires after _both_ halves of a load, which is what makes "loading a
  command is two events" a non-problem.** A directory command reads its own level
  in `loadCommandDir()` before `fetchModule()` is reached, so the only point at
  which the command is final is after the second -- and `announceLoaded()` is one
  function reached from both of `loadCommand()`'s returns rather than a call beside
  each, because a module that was fetched and one that never existed are the same
  event to whoever declared it.
- **And it fires for a command with no module at all, because the alternative is
  an asymmetry.** An inline `run` loads nothing and a namespace directory with no
  `index` fetches nothing, and a hook that skipped them would show a parent some of
  its subcommands and not others according to how each happened to be declared --
  which is the shape this file records from the animator, where two rows of one
  list behaved differently according to which hook built them. It also means the
  `help` command the framework adds is announced on a parse that named it, which
  is correct rather than noise: it is an ordinary registered subcommand of the
  root, and it is **not** announced on a parse that did not name it, because
  nothing loaded it. Both halves are pinned, since the second is the one that
  would be noise.
- **A replacement is a command, not another module to fetch.** Returning nothing
  leaves the loaded command alone -- so mutating it in place is how to adjust one,
  which is how every other hook changes a command -- and returning one replaces
  it, the way `beforeError` replaces an error. What it may not carry is a `path` or
  a `load`, and that throws: this fires _past_ the fetch, so nothing would read
  one, and such a command would reach the parse with its module never imported and
  nothing saying so. Fetching it instead would be this hook re-entered on its own
  answer. A declaration keeps the replaced command's name unless it brings one,
  because a replacement for `migrate` is a `migrate`, and it is initialized against
  the **parent's** `baseDir` -- the hook is the parent's code, and a path in a
  declaration is relative to the file that declared it. That last one is only
  reachable through a replacement's own `commands`, since `path` and `load` are
  refused, and it survived its first sabotage for exactly that reason.
- **The hook is reached only after both `loaded` flags are set, which bounds
  re-entrancy by construction rather than by a depth count.** A hook that reaches
  back into `loadCommand()` for the command it was just handed takes the early
  return instead of looping. It is also why a hook that throws leaves the command
  marked loaded, which is the opposite of what a module that throws does and is the
  right way round: the module failing means the command is not loaded, while the
  hook failing means it loaded and the parent's own code is what broke, and
  re-importing a module over a buggy hook would run its `init` a second time.
- **Fourteen mutations, fourteen caught.** The one that survived first time was
  the parent's `baseDir`, and it is the entry above: every test for a replacement
  used one that declared no paths at all, so nothing could see which directory it
  was initialized against. Two others are worth recording for what they pin rather
  than for being caught -- reading the parent **after** `contexts.unshift(cmd)`
  rather than before, at each of the two `parse.ts` sites, which hands the hook the
  command that just loaded as its own parent. The first run of the harness also
  reported a pattern matching twice rather than passing over it, because both
  `parse.ts` sites had become the same line of source.

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
- **`export default cmd` is followed to the `const` it names, because that is
  the shape this repo's own rules force.** `--isolatedDeclarations` refuses to
  infer a default export, so an app that has it on _cannot_ write the literal
  inline -- and this toolchain is one of those apps: every command module in it
  ends `export default add`. A lift that stopped at the reference reported "help
  will list this command by name alone" about all four of its own commands,
  which is the acceptance test earning its keep on the first run. `export { cmd
  as default }` resolves the same way, since it is the same statement spelled
  differently. Only a module-scope `const`: a `let` can be reassigned between
  the declaration and the export, so what the binding held when the file was
  read is not what it holds when the module runs, and a lift that guessed there
  would bake a description the app does not have.
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
- **A `__` tag is read, because its key is in the source.** `` desc: __`Build
  the app` `` is as readable as a template literal with no substitutions and
  was reported as computed for a while, which made the lift and a translated
  description a choice between two -- see "Translating: the English is the
  key" in `src/i18n` for what the generated tree then carries. Whether the tag
  is the `__` imported from `@ttylabs/sigil/i18n` is asked through
  `bindings.ts` rather than by spelling, so the shapes that count are the ones
  `findTemplates()` already counts and a local `__` is not one. An
  **interpolated** tag gets a message of its own rather than the generic
  computed one, because the value really is the running app's and "computed
  rather than a string literal" about a tag whose neighbour lifted fine names
  nothing the author can act on.
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
- **Which _shapes_ of that binding count is the other half, and a miss is
  silent.** Getting it wrong in this direction rewrites nothing and says nothing:
  the template is left interpreted, the build's count omits it, and the parser
  stays in the bundle. So a **namespace member** counts -- `import * as t`
  followed by ``t.ui`...` `` is statically the same import, answered off the same
  module record with no scope walk -- and **parentheses come off**, because
  ``(ui)`...` `` is the same call and oxc preserves the parentheses as a node, so
  a matcher reading the tag straight off declined a template with nothing wrong
  with it. A **computed** property does not count even holding a literal:
  `t['ui']` and `t[key]` are the same syntax and only one is readable, and
  reading the easy half of a construct this does not support is worse than
  skipping both -- the rule the static `desc` lift already records for a computed
  key. Neither addition loses a negative: a local `ui` nothing imported, a
  namespace of some other module, a wrong property, and a type-only namespace
  import are all still declined.
- **A name the module binds again is given up on, because there is no scope tree
  to ask.** The bindings come off oxc's module record, which says what was
  imported and nothing about where that name is still the import -- so a
  parameter, a variable or a catch binding of the same name is, to this walk,
  the same name. That was a live defect rather than a documented limit: the entry
  above promises that "a local variable called `ui` is not one", and
  ``function f(ui) { return ui`...` }`` in a module that also imports the tag was
  compiled anyway. Adding the namespace shape made it sharper rather than
  introducing it, because the shadowed name is then the _namespace_ local -- `t`,
  which collides far more often than `ui` does -- and the failure is not even
  quiet: a shadowed ``t.ui`<div class="${x}">` `` is an HTML template this then
  tries to compile, so a build that worked now fails on a file with nothing wrong
  with it. So every name the module binds anywhere else is removed from the
  candidates, module-wide, since per use site is exactly the scope question there
  is no answer to. It over-approximates on purpose: the names are collected off
  the _keys_ a binding hangs off -- `id`, `param`, `params` -- rather than off a
  list of node types, for the reason `walk()` is driven by `visitorKeys`, and
  reading one key too many costs a template that stays interpreted while reading
  one too few costs a rewrite of somebody else's code. That asymmetry is the
  whole of the decision, and it is the same one the entry below makes for a
  barrel: loud and wrong is worse than quiet and right.
- **A tag re-exported through another module is unreachable here, and that is a
  boundary rather than a bug.** `export { ui } from '@ttylabs/sigil/template'` in
  a barrel, imported from the barrel, is the same function at run time and cannot
  be recognised from one parse -- the specifier naming the tag's module is not in
  the file, so the native `code` filter never even calls the handler. Answering
  it means resolving a specifier and reading what is behind it, which is the
  bundler's job; doing it in a parse would be a second module resolver. Such a
  template stays interpreted, which is correct output at the cost of the bundle's
  parser. Worth knowing that the _re-export_ could be warned about cheaply --
  oxc's `staticExports` on the barrel names the specifier, and that file does
  contain it -- while the **use site** cannot be, which is the half that would
  actually help.
- **...and it is not the only one, which is why there is a list rather than a
  sentence.** Calling the barrel "the one remaining miss" was wrong within a day
  of being written. Also uncompiled, each silently, each the same function at run
  time: `const { ui } = t`; `(t).ui`, where the parentheses are around the object
  rather than the tag, so the unwrap does not reach them; `const ui = t.ui`;
  `(ui as any)` and `(ui satisfies ...)`; `(0, ui)`; `ui!` and `t.ui!`, where the
  `!` erases; a dynamic `await import()`; and a specifier written with an escape
  -- `'@ttylabs/sigil/\u0074emplate'`, which oxc decodes, so `findTemplates()`
  finds the template while the substring fast path and the rolldown `code` filter
  both search the raw source and do not. What they share is that answering them
  needs something one parse of one module has not got: another file, or a value
  flow. Enumerated rather than summarised, because the summary is what went
  stale, and because the count cannot see any of them.
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
- **...which is asked after the write, because that is the only place the answer
  exists, and for a while it was asked where there was no answer at all.**
  `rolldown()` builds nothing -- its own documentation says the module graph is
  not built until a method on the bundle is called -- so a check sitting between
  it and `bundle.write()`, which is where this one sat, read an empty array every
  single time. The entry above was true when it was written and had quietly
  stopped being: measured, an app importing `totally-not-a-package` built and
  reported success, and so did one whose JSX reached for `react`. What hid it is
  that a **relative** specifier is a hard error out of rolldown itself, so the
  obvious repro still failed the build; only a **bare** one is downgraded to
  "treating it as an external dependency", which is exactly the shape the gate
  exists for. It was untested, which is how a check comes to be dead.
  Neither plugin hook can host it -- `buildEnd` and `generateBundle` both run
  _before_ the warning is reported, measured -- and `generate()` first with
  `write()` after is worse: the `transform` hook runs again for the second call,
  so every template would be compiled twice and `templates` would come back
  doubled. So it is one write, asked afterwards, and what was written is
  **unwound**: exactly the files rolldown reported, the sourcemaps among them,
  plus any directory of theirs that is now empty -- and the unwind never throws
  over the error it is unwinding for, since `force` covers a file that is not
  there and not a name that turns out to be a directory, which is
  `ERR_FS_EISDIR`. Two guards of the same kind sit in that function, each closing
  something rolldown 1.2.11 cannot produce -- a path that climbs out of `--out`,
  and a removal that fails -- because the one operation there is a delete on a
  failure path, which is not where to rely on somebody else's validation or to
  swap a real diagnostic for one about the file system. A refused build that leaves a
  bundle which would die on first use has answered the question and then handed
  the thing over anyway. The output directory itself is never removed, because
  `--no-clean` means it may hold somebody else's files.
- **The bundle is closed in a `finally`, and there is exactly one leak rather
  than the three the ticket named.** `close()` releases a **native** handle, so
  what it does not release is not something the garbage collector will get to,
  and rolldown's own documentation says to call it even when the build failed --
  and it was written as the statement immediately after `bundle.write()`, which
  is the one path where none of that is true. Measured before anything was
  changed: an `--out` that is an existing file makes `write()` reject with
  `Could not create directory for output chunks: <out>`, and `close()` was never
  reached. An `--out` inside a read-only directory does the same. What the ticket
  also said, and what the first version of this entry repeated, is that the
  unresolved gate, `undo()` and `escapeControls()` could leak it too -- and that
  is **false**: `git show main:packages/cli/src/build/bundle.ts` puts `close()`
  above all four of them, so every one of them already ran with the bundle
  closed. Found by review round 1, and worth keeping because it is the argument
  that was inherited rather than checked.
- **So the wide bracket is about where the correctness lives, not about a second
  leak.** A `finally` around the write alone would have closed the same one
  path. The eager call was right only because nothing between the write and it
  threw, which is a property of the fifty lines under it rather than of the call
  -- everything added since happened to be added _after_ the close, and one
  statement added before it would have brought the leak back with nothing to
  notice. A `finally` over the whole use of the bundle is right by its shape, and
  it closes exactly once on one path, so "was it closed" has one answer to check
  rather than one per exit. The bracket begins where the bundle **exists**, which
  is after `await rolldown()` returns rather than at the call, because a
  `rolldown()` that rejects hands back no reference for anything here to close;
  measured against rolldown 1.2.11, an `options` hook that throws rejects before
  a bundle is constructed and a missing input resolves to one, so there is no
  reachable path where a bundle exists and this function cannot see it.
  `writeEntry()` is before all of it.
- **`close()` never decides what the build answered, on either path.** A
  `finally` that rethrows swaps the real diagnostic for one about releasing a
  handle, which is the rule `undo()` already follows one function along -- and it
  is swallowed on the success path too, rather than raised there, because the
  asymmetry would have to be stated as "releasing the bundle is fatal only when
  everything else worked". What that reading produces is a refused build sitting
  beside a bundle that is complete, escaped and executable: the shape `undo()`
  exists to prevent, with nothing left to unwind. Unlike the two guards in
  `undo()` this one is **reachable** -- measured against rolldown 1.2.11, a
  plugin whose `closeBundle` hook throws throws out of `close()` as a
  `PLUGIN_ERROR`, and this build's one plugin has only a `transform` today.
- **A second `close()` is not a no-op, which is why the eager call was replaced
  rather than joined to the `finally`.** The first version of this said closing
  twice was harmless, from a probe that only asked whether it threw; review round
  2 asked the rest. Measured: a second `close()` resolves and leaves `closed`
  true, and it runs every `closeBundle` hook **again** -- a counting hook reached
  3 after three closes, and a throwing one threw from each. So a joined pair
  would run a plugin's teardown twice for one build, which makes one close a
  correctness argument rather than the tidiness one ("two closes would be two
  answers") it was first written as.
- **Whether `close()` was called is asked by mocking `rolldown`, because the
  bundle is `bundleApp()`'s own.** Nothing outside that function can see it, and
  the alternative is a seam whose only reader would be the test. So
  `test/build/bundle-close.test.ts` wraps the real `rolldown()` the way
  `blame.test.ts` wraps `compile()`: the real bundler runs, the real app is
  bundled, the real files are written, and the wrapper adds a record of the
  `close()` calls and a way to make one fail. `close` is redefined **on the
  instance** rather than reached through a `Proxy`, because rolldown's bundle
  reads private fields off `this` and a proxy receiver fails `write()` with
  `Receiver must be an instance of class` -- measured. It is a file of its own
  because `vi.mock` is hoisted and module-wide, so every test in the file it sat
  in would run through the wrapper. Whether the next `close()` fails is set by
  the same call that clears the record rather than reset in a `beforeEach`,
  because a reset no assertion can see is a guard that reads as load-bearing and
  is not -- review round 1 deleted one and started from `true`, and all four
  tests stayed green.
- **What the record holds is each `close()`'s _outcome_, because a test about a
  `close()` that throws has to be able to see that one did.** Asserting only the
  absence of the thrown message locks the `catch` and not its premise: review
  round 2 deleted the line that arms the failure and all four tests stayed green
  again, which is the same defect one level in. So the mock records
  `close:threw` or `close`, and the two swallow tests assert which -- the second
  time this file was told that a line you can delete while the suite stays green
  is the shape to look for.
- **The command-level pin uses `--no-clean`, because that is what makes an
  existing file reach the write.** `clean()` is a single
  `rmSync(out, { force: true, recursive: true })`, so without the flag an `--out`
  that is a file is simply **deleted** and `write()` makes a directory where it
  was: exit 0, measured. The directory is `write()`'s rather than the clean
  step's, which is the half the first version of this got wrong. A read-only
  parent provokes the same rejection and would have to be skipped on Windows,
  where a mode of `0o500` stops nothing being created inside it, so the file plus
  `--no-clean` is the spelling that runs on all nine of CI's combinations.
- **JSX compiles against `@ttylabs/sigil`, because rolldown's default is
  `react`.** A `.tsx` holding one JSX element built, reported success, and died
  the first time the command was run: `Cannot find package 'react' imported from
  <out>/chunks/show-….mjs`. That is the shape `--external` is written for one
  entry along -- a build that reported success and an executable that dies the
  first time it is used -- and it hit the syntax this file calls _canonical_. It
  was not the template work that caused it: with `MODULE_RE` at its old
  `/\.[cm]?[jt]s$/` and at its current value the output is identical down to the
  content-hashed chunk name, because rolldown transforms a `.tsx` whether or not
  the template plugin's handler is ever called.
- **rolldown reads the app's `tsconfig.json` itself, and that was measured before
  anything was written.** `tsconfig` defaults to `true` and is resolved by
  walking up from each _module_ rather than from the working directory -- proved
  by building an app from a different cwd and watching its own config win. So an
  app naming `jsxImportSource` always built correctly and the defect was only
  ever rolldown's default; byte for byte, such an app's bundle is what it was
  before this changed. Which is also the argument against the other candidate:
  a `sigil.json` key, or a `tsconfig` reader of the build's own, would be a
  second place to say a thing the app's editor and its own `tsc` already obey,
  and reading one means JSONC and an `extends` chain rather than a lookup.
- **`importSource` and nothing else, which is the whole of the decision.**
  Measured against rolldown 1.2.11: `transform.jsx.importSource` beats a
  `jsxImportSource` from the tsconfig, and everything else about the transform
  stays the app's -- `jsx: "react-jsxdev"` still reaches
  `@ttylabs/sigil/jsx-dev-runtime`, `jsx: "react"` still emits
  `React.createElement`, and `jsx: "preserve"` still preserves. Adding
  `runtime: 'automatic'` beside it was tried and **rejected**: it does fix
  `preserve` and the classic runtime, and it silently costs `react-jsxdev` its
  dev runtime, which is a configuration this framework publishes a runtime for
  and whose positions are the only way a JSX frontend carries one. Re-measured
  against rolldown 1.2.11 when `preserve` was closed, because that was the
  candidate for closing it, and the rejection holds -- with a distinction the
  first re-measurement missed. **Which** marker disappears depends on whether the
  output is minified, and only one of the two is what `sigil build` writes:
  unminified, `runtime: 'automatic'` takes the `jsx-dev-runtime` region and
  `_jsxFileName` with it, while **minified**, which is the default, both are
  already gone and what the option removes is the `panel.tsx` string and the
  `fileName` property. That is exactly the marker the `jsx-dev` fixture was built
  to pin -- a string survives minification where an identifier does not -- so the
  test was right and the sentence describing it was measured on the wrong build.
  A third cost turned up with it: the option makes rolldown report a **second**
  `CONFIGURATION_FIELD_CONFLICT`, about `compilerOptions.jsx`, which the
  suppression above does not match because it is scoped to `jsxImportSource`, so
  that path would have printed a warning on every build of exactly the app it was
  meant to fix. Both halves are already pinned, which is the part worth knowing:
  `should leave the rest of the JSX transform to the app` asserts that the bundle
  contains `panel.tsx` **and** that no `CONFIGURATION_FIELD_CONFLICT` reached
  stderr, so adding the option fails that one test twice.
- **`jsx: "preserve"` is refused, and it is refused by _detecting_ it rather
  than by configuring it away.** It is the third door onto "the build reported
  success and the executable dies the first time it is used": rolldown obeys the
  setting, the bundle keeps its JSX, and running it dies with
  `Unexpected token '<'`. The first version of this file said that was worth
  knowing rather than fixing, on two arguments, and the first of them is weaker
  than it looks. `tsc` leaving JSX in place is _useful_ -- a bundler or Babel
  picks it up next -- while a bundle is the end of the pipeline, so there is no
  next tool and the only executable the setting can produce is one that will not
  parse. A setting with no reachable good outcome is not a preference the build
  has to honour. The second argument -- that refusing needs a tsconfig reader of
  the build's own -- is answered by not reading the tsconfig: what the gate asks
  is a question about **what was written**, which needs no config at all and
  answers for every other route to the same end state. Measured, that set is
  smaller than it sounds: `preserve` on a `.tsx` is the **only** tsconfig `jsx`
  value that leaves raw JSX behind -- `react-native`, which `tsc` also treats as
  preserving, is compiled by rolldown -- and `compilerOptions.jsx` does not reach
  a `.jsx` at all, exactly as `jsxImportSource` does not. So configuring would
  have needed to enumerate a set the detection never has to know -- and review
  round 1 widened the sweep without finding another member of it: an `extends`
  chain whose base says `preserve` and a `@jsxRuntime`, `@jsx` or
  `@jsxImportSource` pragma over a `preserve` tsconfig all leave raw JSX, and the
  gate catches each. Two near misses are worth knowing because they look like
  routes and are not. `"jsx": "Preserve"` with a capital P **compiles**, so
  rolldown does not read the value the case-insensitive way `tsc` does. And a
  `.js` holding JSX never reaches the gate at all: rolldown refuses it with
  `[PARSE_ERROR] Unexpected JSX expression` whatever the tsconfig says.
- **The gate parses; it does not search, and that is measured rather than
  cautious.** A regex over minified output is what the ticket warned about, and
  it fired **twice** while this was being written: the runtime's own error
  strings carry `<box>`, `<text>` and `<raw>`, so a probe for `<text` reported
  JSX in bundles that had none, and `panel.tsx`'s doc comment carries the word
  `jsxDEV`, so a probe for that reported the dev transform in a bundle that had
  preserved. What is asked instead is that the chunk's tree holds a `JSXElement`
  or a `JSXFragment`, found by parsing with `lang: 'jsx'` and walking with the
  repo's own `visitorKeys`-driven `walk()`.
- **It asks the tree because a parse differential got it wrong, and the
  differential's failure is the entry worth keeping.** The first version asked
  whether the chunk fails under its own name and _parses_ when the same source is
  offered as `.jsx`, on the reading that the extension moves one axis. It moves
  **two**: oxc reads the _source type_ off the filename as well, so a `.mjs` is
  always a module while a `.jsx` with no `import` or `export` in it is inferred a
  **script** -- and a script may do things a module may not. Every module-only
  error therefore read as "JSX must be why". Reported by the coordinator with an
  Annex B HTML comment, which the build refused with a message naming `jsx` about
  a file holding no JSX at all; hunting the class turned up four more shapes -- a
  `-->` line, and `await` used as a variable, a class name or a label -- and
  nobody had enumerated the set, which is the argument. A JSX **node** is the
  thing the gate is entitled to say, so it says that instead of inferring it.
- **Pinning the source type was the other candidate and it is a false-negative
  machine.** It is the obvious tidy-up once the source type is known to be the
  confounder, and `should still find JSX in a chunk a module is not allowed to be`
  exists to stop somebody taking it: measured over 180 combinations of a name, a
  body and a JSX element, pinning `sourceType: 'module'` on the JSX parse loses
  the JSX in **50** of them -- every chunk that holds real JSX _and_ something a
  module may not do, where the pinned parse fails before the walk can see
  anything. The only job of that parse is to hand the walk a tree, so the
  permissive reading is the right one. The same measurement says pinning the
  _first_ parse changes no answer in any of the 180, so neither is pinned and
  there is one mechanism rather than two masking each other -- which is what the
  first attempt at this fix had, with each of the two sabotages passing because
  the other guard covered it.
- **The first parse is a cost filter, not half the answer.** It cannot change
  what the gate reports, and that is a proof rather than a measurement: JSX is a
  syntax error in JavaScript, so a chunk that parses under its own name cannot
  hold a JSX node and the walk would find nothing. What it buys is that the
  **AST is never deserialized on a build that is fine** -- measured, asking only
  about the errors over 9 chunks is 2.0ms and touching `.program` as well is
  9.9ms, which is why `parses()` and `parseTree()` are two functions. Deleting it
  changes no answer and fails no test, which is what a filter should do and is
  said here so the next reader does not take the silence for a gap.
- **What makes the gate safe is structural, not the corpus.** A chunk is oxc's
  own parse-and-print output of the app's modules, so anything rolldown could
  emit, rolldown has already parsed -- which is why a chunk that parses as
  neither JavaScript nor JSX can be left alone without that being a hole. The
  corpus is corroboration and is worth keeping as such: zero false positives over
  114 chunks (every fixture's bundle, `packages/cli/dist`, `packages/sigil/dist`),
  and 37 hand-built spellings run against the shipped gate -- the coordinator's
  nine, and `a < b > c`, a regex holding `<`, a comparison that looks like a
  generic call, a shebang, top-level `await`, `import.meta`,
  `with { type: "json" }`, `import defer`, `using`, a class static block,
  `#x in o`, `with`, a decorator, an empty chunk, a BOM, CRLF, an emoji string, a
  `<const T,>` arrow, a `<string>y` assertion, an IIFE, a lone sourcemap comment,
  and the five module-only shapes above. Two of those spellings had been recorded
  wrongly before, which is the other reason the structural argument leads now: an
  HTML comment was filed under "parses as both" and does not parse as either.
- **A chunk that parses as neither JavaScript nor JSX is deliberately left
  alone.** Refusing it would be the false positive the ticket said is worse than
  the status quo:
  `oxc-parser` and the oxc inside rolldown are separately versioned, so a grammar
  this one is behind on would read as a broken bundle and fail a build that works.
  What that gives up is the bundle nothing can parse for some other reason, which
  is not this failure and has nobody claiming it. It also settles the sourcemaps
  for free -- a `.map` fails both parses -- which is why the skip for an asset is
  a **cost** guard rather than a correctness one: the maps are the largest files
  in the output -- 288 kB of maps against 111 kB of chunks on the fixture, which
  is 399 kB together and was written down as the maps alone until review round 1
  weighed them -- and reading them takes the pass from 2.33ms to 3.14ms. Finding a test for it took three goes, and the
  two rejected ones say where the line is. A sourcemap proves nothing, because the
  conservative branch excludes it anyway. An asset named `.jsx` proves nothing,
  because its own extension makes the first parse succeed. What is left is two
  things the skip really does decide: an asset with no file behind it is not
  **opened**, and an asset that is JSX under a name that is not -- `notes.map`
  holding `const a = <text>x</text>;`, which is what an app shipping a template as
  an asset looks like -- is not **reported**. The second is the one a
  `try`/`catch` around the read could not fake, which is why both are asserted,
  and it is why this is a cost guard for what rolldown emits rather than for
  everything.
- **What it does not catch is `jsx: "react"`, and that is the boundary rather
  than a gap.** That emits `React.createElement` and parses perfectly: a bundle
  that will not _run_ rather than one that will not _parse_. It is what this file
  already records as the app's own choice, and an app that really does depend on
  React can make it work with `--external react`. The gate proves one thing --
  node cannot load this -- and refuses exactly that.
- **It reads the files rather than `written.output[].code`, which is byte
  identical.** Measured: `write()` hands back exactly what is on disk, sourcemap
  comment included, so reading would have cost nothing. The file is read anyway
  because the whole reason `escapeControls()` exists is that rolldown's
  in-memory view of a chunk and the bytes it finally writes came apart once, and
  a question about whether **node** can parse the bundle has to ask the bytes
  node will read. The cost is 2.7ms for a 9-chunk 111 kB bundle and 4.8ms for 44
  chunks of 182 kB; end to end a `sigil build` of the fixture goes from 118ms to
  121ms, interleaved.
- **The message names `jsx`, because that is the fix.** A message about a syntax
  error in generated code sends the author to the generated code, which is not
  where the problem is. It names the offending chunk too, since an app with one
  `.tsx` among fifty modules has to be able to find it, and it says why
  `preserve` cannot work here rather than only that it did not. The build is
  refused through the same shape as the unresolved-import gate, `undo()`
  included: a bundle that would die the first time it was run is precisely what
  the refusal is about, so leaving it there would answer the question and hand
  the thing over anyway.
- **`parses()` lives beside `parseModule()` rather than beside its caller.**
  There is one definition of "does not parse", and `parseModule()` already
  encodes it as _any_ entry oxc hands back whatever its severity; a second reader
  counting only the ones marked `Error` would be a second answer to one question.
  The two agree today -- measured over those 114 chunks, oxc returns no entry of
  any severity for code that is fine -- and this is about keeping them agreeing.
- **The fixture differs from `jsx-dev/` by one tsconfig field, and it
  type-checks.** `preserve` still checks the JSX against the `JSX` namespace
  `jsxImportSource` names, so `test/fixtures/jsx-preserve/` is an app the build
  has to refuse on its own rather than one the type-check has already refused --
  which is the whole of what makes it worth a fixture. `rawJsxIn()` is exported
  for the reason `undo()` and `MODULE_RE` are: two of its three answers cannot be
  reached through a bundler at all.
- **What it costs is a tsconfig that named a different automatic import source,
  and the escape hatch is the most explicit spelling rather than the least.** A
  per-file `@jsxImportSource` pragma beats this option -- measured -- so an app
  with a genuine reason says so on the file that has the reason. Overriding the
  tsconfig is deliberate rather than reluctant: the JSX in a sigil app has to
  produce sigil `Element`s for anything in the framework to render it, so an app
  that names something else is telling its editor its JSX is not sigil's, which
  is a thing to say on the file that says it rather than once for the app. And
  the case a tsconfig-conditional rule could not have covered is bigger than "an
  app with no tsconfig": measured, `compilerOptions.jsxImportSource` **does not
  reach a `.jsx` at all** -- a `.jsx` beside a tsconfig naming `from-tsconfig`
  still compiled against `react`, while the `.tsx` beside it did not -- so a
  `.jsx` has never been configurable that way in any app, with a tsconfig or
  without. It is the second property the build knows better than the app, after
  `commands`.
- **The conflict warning rolldown emits for that is dropped, and only that
  one.** Setting the option makes rolldown say `compilerOptions.jsxImportSource`
  was overridden -- **without comparing the two values**, measured, so an app
  naming `@ttylabs/sigil`, which is what `sigil new` scaffolds and the only thing
  a sigil app can name, is warned at for being right. A warning that fires on
  correct code teaches people to ignore warnings, which is the rule already
  written down for reading a file off `import.meta.url`. Scoped to the field
  rather than switched off with `checks: { configurationFieldConflict: false }`,
  so a conflict about any other option this build sets still reaches whoever is
  building; matching the message is what that costs and it fails safe, since a
  rewording brings the warning back. It fires once per build, and **a `.ts`
  module is enough** -- measured, since loading the tsconfig is what reports the
  conflict and a TypeScript module loads it whether or not it holds any JSX, so
  every app `sigil new` scaffolds would print it on every build. A `.js` module
  does not, which is the same line the entry below draws. The suppression is
  therefore load-bearing rather than tidy: "an app with no `.tsx` never saw it"
  was the first version of this sentence and it was wrong. Rolldown reports the
  conflict even where the tsconfig did **not** win: a per-file
  `@jsxImportSource` beats both, and the warning still says the option beat the
  tsconfig -- so in that case what is suppressed is a statement that is not true.
- **The fixture has no `tsconfig.json`, and that is the whole of what it pins.**
  `test/fixtures/jsx/` is the only shape the defect had; an app with a config
  naming the import source cannot reproduce it. `test/fixtures/jsx-dev/` is the
  other half and says `react-jsxdev`, so the narrowness above is a test rather
  than a sentence: the development transform passes the module's own file name to
  `jsxDEV`, which is a **string** and therefore survives minification where every
  identifier does not, so `panel.tsx` appearing in the bundle is what fails the
  day somebody adds `runtime: 'automatic'`. Neither has a source-run twin, for
  the reason `templated-tsx` records: node cannot load a `.tsx` at all, so an app
  with one is a built app by construction.
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
- **A package carrying a native binding is left as an import, and the build says
  so.** Nothing inlines a `.node`, and a package like `oxc-parser` or `rolldown`
  is JavaScript around one: the JavaScript resolves perfectly well, gets
  inlined, and then looks for a binary beside a file that is no longer there.
  The build could not see it coming -- the _specifier_ resolved, so there was no
  unresolved import to raise -- and the result was a build that reported success
  and an executable that died the first time it was used. `--external` is the
  answer, and it is deliberately explicit: an app that names one is saying its
  bundle is not self-contained, which is a true thing to say about an app with a
  native dependency and a lie about any other. It is **reported** for the same
  reason, because "these must be installed where the app runs" is not something
  to find out from a crash. An external is not an unresolved import and is not
  counted as one: one is a deliberate answer to "this cannot be inlined" and the
  other is the absence of an answer.
- **The bootstrap runs, and it is what proved the mechanism.** A toolchain built
  by `sigil build --external oxc-parser --external rolldown` checks an app,
  builds an app, and the app it built runs. Before the externals existed it
  built cleanly and then failed on `Cannot find native binding` the moment any
  command that reads source was reached, which is stage 1 of the bootstrap
  failing in the one place the stage-0 escape hatch exists for.
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

#### Compiling an app's templates

`compile-templates.ts` is the splice SIG-73 left out and the last join in a
pipeline whose every other piece was already written and tested: `findTemplates()`
finds each `ui` template and its span, `parse()` reads it into IR with an `Expr`
per interpolation, `analyze()` folds the constants out, `compile()` prints the
JavaScript, and this writes each expression back over its template, the hoisted
block and the imports at the top. A rolldown `transform` runs it on the way in.

- **The payoff is the bundle, and it is _not_ startup -- which the ticket had
  backwards.** SIG-115 promised "a faster first frame and a smaller bundle".
  Measured on a one-template fixture, the bundle goes from 122.9 kB to 116.7 kB
  and the parser's own error string disappears from it, so the tag, the parser and
  the IR walk really do shake out. Startup is **identical**: 39.4ms median either
  way. A template parse is **1.6µs**, so five hundred of them come to 0.8ms
  against node's own 39ms -- parsing templates was never the cost, and a claim
  that it was would have gone on being repeated. What that reframes is the
  _stylesheet_ half of the ticket, which is a different shape: a sheet is parsed
  at startup rather than per render, and 383 rules are 0.63ms with the full
  utility set at 7.29ms. That one may be a real startup win; this one is not.
- **A `transform` rather than a pass over the app's files, and the filter is
  native.** rolldown is what knows which modules are actually reached, so a
  template in a file nothing imports costs nothing. The hook carries a `filter`
  with a `code` pattern and an `id` pattern, which rolldown applies in Rust: a
  module that cannot hold a template never crosses into JavaScript. That is worth
  16ms against 2ms. Parsing every module to find out cost **16ms of a 101ms
  build**; a substring test in the handler brought it to about 7; the native
  filter brings the cost of having the plugin at all to **2ms**, measured
  interleaved rather than sequentially because the noise is a few ms wide.
  Verified rather than assumed: the handler is reached **zero** times for the
  `buildable` fixture and **exactly once** for `templated`. There is deliberately
  no second check inside the handler -- a guard that reads as load-bearing and is
  not is the `nowrap` mistake in `report.ts`, one file along.
- **The source map is not optional, and that is measured.** A rolldown transform
  that returns code without a map does two things and only the first is loud: it
  warns `SOURCEMAP_BROKEN`, and it **drops the module from the map altogether** --
  a two-source map became one and the transformed file was simply not in it.
  Sourcemaps are on by default here, so a code-only transform would quietly cost
  every template-bearing module its map in exchange for a smaller bundle.
  `{ mappings: "" }` is half an answer: it keeps the module listed and maps
  nothing inside it. So the rewrite goes through `magic-string`, which tracks the
  edits and produces a real map. This is also the sourcemap the emitter's own
  entry defers to `sigil build` -- "_where in a module_ that template sat is what
  `sigil build` knows, so the map belongs there" -- and it is why the `loc` values
  the emitter prints stay **template-relative**: those are what make a compiled
  template's error name the same line the interpreted one does, and the module
  position is the map's job rather than theirs.

  What the map resolves to is a span rather than a line, and that is the honest
  limit of it: the replacement for a template is one `overwrite()` over the whole
  tagged expression, so every generated line _inside_ it maps back to the
  template's opening `ui`, not to the line of the template each piece came from.
  A stack frame therefore lands on the right template in the right file, on the
  line the template starts. Everything **around** the splice is exact to the
  character -- that is what `hires: true` buys, verified by decoding the VLQ
  rather than by checking the map is non-empty -- and the prepended imports and
  hoisted block are deliberately unmapped, which is the right answer for code
  that was never in the file. Spreading the interior would mean emitting per-node
  positions from `compile()` and splicing chunk by chunk, which is a real
  redesign for a line number inside generated code somebody is about to read
  beside the template anyway.

- **`magic-string` is a new dependency and `RolldownMagicString` was the
  alternative.** rolldown exports a native MagicString of its own, which would
  have been zero new dependencies -- and it is marked `@experimental`, which is
  not a thing to put on the critical path of every app's build when the
  alternative is the 10 kB library rollup and vite both use for exactly this, and
  which rolldown already brings into the lockfile. `the toolchain's dependencies`
  in `packages/cli/test/cli.test.ts` writes the list out so that taking one is an
  edit somebody makes on purpose; this is that edit.
- **The prefix contract is the caller's, and `choosePrefix()` is the whole of
  it.** `compile()` puts a prefix on every name it generates and cannot check that
  the prefix is free, because it is handed IR rather than a file. It matters both
  ways: outward, a local at the splice site shadows a generated name; inward, an
  interpolated expression is printed back into the scope those locals are declared
  in, so a template whose expression reads `$uie0` would read the generated one.
  The scan is a plain `includes()` over the **whole** module -- comments and
  strings included, which costs a longer name in a module that merely mentions the
  prefix in prose and keeps the search from having to know where it is looking.
  The test for it was **vacuous at first** and is worth knowing why: it declared
  `$ui` and `$ui0` and passed with the scan disabled, because a prefix of `$ui`
  generates `$uie0` and `$uis0` and collides with neither. A collision needs names
  the emitter would actually produce, which is the prefix plus `e0`, `s0`, or an
  imported helper.
- **The imports go after a shebang, not before it.** `#!` is only a shebang on the
  first line, so an `import` in front of it leaves a module whose first line is a
  syntax error to node and which the kernel will not exec either. `'use strict'`
  needs no such care: a module is strict anyway, so an import before it merely
  makes it an ordinary string expression.
- **Nothing is rewritten until every template in the module has parsed.** A
  half-spliced module is a worse thing to hand a bundler than an error, so the IR
  for all of them is built first and a failure throws a `TemplateCompileError`
  naming the file, the line and the column. What is decidable from the IR fails
  the build rather than the frame, which is the rule the utility generator already
  follows by parsing every declaration it generates on the way out.
- **The count is reported, because "no parser shipped" and "no templates" look
  identical from outside.** `sigil build` says `1 command and 1 template into
  ...`, and omits the clause entirely at zero rather than saying "0 templates" --
  the toolchain's own build is the case that reads, since it has none. A build
  that silently compiled none when the author wrote twelve is the failure worth
  being able to see. What it cannot see is a template nothing _claimed_: a shape
  the matcher does not reach leaves the count short with no diagnostic, so the
  count is a signal about templates found rather than a proof that none was
  missed. Which is the whole reason the shapes below are worth being exhaustive
  about.
- **Every shape the matcher misses is silent, so the shapes are the feature.** A
  template that is not claimed produces no error at all -- it is bundled
  interpreted, the count omits it, and the parser stays in the bundle -- so a
  miss costs exactly what the pass exists to buy and says nothing. Three of them
  were shipped in the first version and each was found by review rather than by a
  test. The **extension** was one: `MODULE_RE` gated the `transform` on
  `/\.[cm]?[jt]s$/`, so a `ui` template in a `.tsx` or a `.jsx` was never asked
  about, though `compileTemplates()` compiles one perfectly well -- oxc reads the
  language off the filename, which is why the extension is the right gate and
  why leaving the `x` out was a silent miss rather than a safe one. JSX being the
  canonical syntax is what makes a `.tsx` a _likely_ place for the tag rather
  than an exotic one: the two live side by side in one app. Spelled as two
  alternatives rather than one `x?`, because the eight real extensions are not a
  product of their parts -- there is no `.mtsx` or `.cjsx`, and oxc reads neither
  as JSX, so the lazy spelling admitted four ids whose JSX is a syntax error. The
  other two misses are `findTemplates()`'s and are recorded there -- a namespace
  member and a parenthesized tag -- along with the shadowing defect that
  supporting the first of those made sharper, and with the list of shapes that
  stay unreachable because one parse of one module cannot answer them: a barrel
  re-export, a destructuring, `(t).ui`, an escaped specifier, and the rest.
- **A `.cjs` and a `.cts` are CommonJS, so each of the eight extensions is given
  source it can legally hold -- and one ESM fixture for all eight was asserting
  something about a file that cannot exist.** `should admit every extension the
  compiler can actually read` fed one `import { ui } from ...` module to every
  extension in the list, which passed only because oxc-parser took it. **0.153
  refuses it for a `.cjs`** where 0.152 did not -- measured in an isolated
  install of each, 0 errors against 2 -- so a dependency bump failed exactly one
  test in 5,268 and the failing test was the one in the wrong.

  oxc is **right**, which is what decided the fix. Node refuses ESM syntax in
  both a `.cjs` and a `.cts` and takes `require()` in both, checked by running
  all four rather than inferred from the stripping rule this file already
  records -- so compiling a template in such a module would be the build
  reporting success over a module that cannot load, which is the failure class
  refused under `--external`, under the JSX gate and under the unresolved-import
  gate. The alternative was `parseSync(file, source, { sourceType: 'module' })`,
  which restores the old answer by making `parseModule()` read a file as
  something Node will not, and `should refuse a CommonJS module written as an ES
  module, as Node does` is what fails when somebody reaches for it -- the one
  test in 750 that does, so nothing else here rested on the leniency.

  So the module extensions carry a static import and the two CommonJS ones carry
  a `require`, and what all eight have to do is **parse**. A CommonJS module has
  no static import for the tag to be a binding of, so there is no `ui` to find
  and nothing is claimed: that is the recorded limitation rather than the gap
  this entry's sibling is about -- a template reached through `require()` stays
  interpreted, which is correct output at the cost of the parser staying in the
  bundle, and is the same answer a barrel re-export already gets.

  It does not rest on which of the two oxc refuses today, which is the half worth
  keeping: **0.153 still reads a `.cts` as a module**, so an ESM `.cts` parses
  there and does not in Node. Giving both the `require` fixture is what makes the
  test survive that inconsistency being fixed, and pinning the oxc-only answer
  would have been pinning the bug. The refusal is asserted against
  `parseModule()`'s own `Failed to parse <file>` rather than against oxc's
  wording, so a reword does not fail it and oxc going back to taking this does.
  All three `MODULE_RE` sabotages are still caught after the rewrite -- the
  original `.tsx`/`.jsx` gap, the lazy `x?`, and dropping the CommonJS pair.

- **A whole-module `compile()` failure is attributed by re-compiling each
  template alone.** `compile()` takes a module's templates at once, so what it
  throws names none of them, and the first template's position was the answer for
  one commit: a module whose _second_ template held a bad `<raw>` reported the
  first one's line, which is a location pointing at code the author would read,
  find correct, and be stuck on. A diagnostic that names the wrong line is worse
  than one that names no line, because it is believed. So the culprit is found by
  compiling each on its own until one throws the same message -- the error path
  only, so the happy path pays nothing, and sound in the direction that matters
  since nothing `compile()` does across templates can _rescue_ one that fails
  alone. The parse and analyze failures never had this problem: those are per
  template already.

  Under the match are two ordered fallbacks -- a template that threw _something_,
  then the module's first -- and they exist because the match rests on a property
  of a set of throw sites rather than a guarantee: no message `compile()` throws
  mentions a generated name or an index, so it is the same compiled alone or in a
  batch. Checked against every throw site, the prefix check included, which
  throws one identical message however many templates it was handed and so lands
  on the first template through the _match_. An earlier note claimed that one as
  the fallback's reason and was simply wrong about it. With today's emitter all
  three rules pick the same template -- `compile()` throws on the first failure it
  meets, so there is never an earlier failing template for the match to disagree
  with -- which means no test over the real emitter can tell them apart, and two
  attempts at writing one were green with the branch they named deleted.
  `test/build/blame.test.ts` mocks `compile()` to separate them, because
  machinery nothing exercises is machinery that stops working silently.

#### Shaking an app's stylesheets

`shake.ts` is the stylesheet half of SIG-115 taken together with SIG-81, which
is what both tickets asked for -- shaking and compiling read the same sheet and
should be one pass. The pass does one of the two things they asked for, and the
other is refused with numbers.

- **"Emit the sheet as data" was measured and is a loss.** SIG-115's wording was
  _parse, resolve, mangle scoped class names, and emit them as data rather than
  as source to be parsed at startup_, on the theory that a compiled sheet ships
  no CSS parser. Measured, minified, on this repository's own sheets: the
  utility sheet is 383 rules, **13,343 B** of CSS and **103,246 B** as a JS
  literal, and the framework sheet is 19 rules, **1,390 B** and **5,430 B**. The
  parser that would shake out -- the `Parser` class, the selector cursor and the
  media query reader, measured as the difference between a bundle importing
  `parseStylesheet` and one importing only `Cascade`, `matches` and `keysFor` --
  is **9,067 B**. So emitting the utility sheet as data trades **90 kB for
  0.59 ms**, and emitting the framework sheet's 19 rules would save 5.0 kB and
  0.023 ms only if _no other sheet_ were ever parsed, which is not reachable: an
  app that writes one line of CSS puts the parser back.

  No encoding rescues it, and that is the general statement rather than a fact
  about this printer: **a parsed rule is more information than the CSS that
  produced it.** A `Selector` carries its source, its bucket key, its
  specificity and its steps, all of which the string it was parsed from already
  implies -- so any faithful data form is bigger, and a compact one is a second
  grammar with a decoder, which is the "two spellings of one thing" this file
  records over and over. A parser for a grammar this small is 9 kB, and that is
  the whole of what data could ever buy back.

  What the measurement _does_ say is that shaking is the thing that pays, and it
  pays on both axes at once: fewer rules is fewer bytes **and** less to parse.
  Which is the same finding the template half arrived at from the other side --
  the startup cost stage 2 was supposed to remove was never there, and here the
  bundle cost stage 3 was supposed to remove goes the wrong way.

- **Only the utility sheet is shaken, and that is SIG-81's own argument taken at
  its word.** Hand-written CSS cannot be shaken soundly -- "can this app ever
  produce `class="error"`?" is a question about arbitrary JavaScript -- and a
  hand-written sheet has no bytes in it to win back. The generated vocabulary is
  the opposite on both counts: the build knows the whole grammar that produced
  it, and it is 383 rules an app names a dozen of.

  It is also the only sheet with a **seam**, which is the half that decided it.
  `utilitySheet()` is opt-in, so it is a call in the app's _own source_, and a
  transform can rewrite it -- which is what makes `UTILITY_CSS` unreferenced, so
  the 13.3 kB leaves the bundle rather than being replaced in it. The framework
  sheet has none: nothing in an app calls `frameworkSheet()`, because every
  built-in reaches it through `themedCascade()` from inside the runtime. Every
  candidate for reaching it was rejected -- a `load` interception cannot find it,
  since tsdown chunks `theme/index.ts` in with other code and an app reads the
  published `dist`; a `renderChunk` string replacement is a regex over minified
  output; and a runtime override leaves _both_ copies in the bundle, since the
  original constant is still statically referenced. At 19 rules and 0.023 ms
  that is not a loss worth inventing a seam for.

- **Measured on `test/fixtures/styled/`, which draws with utilities**: 383 rules
  shaken to 25, and the bundle **133,692 B to 122,234 B**. Startup goes with it,
  and by more than the parse alone, because 11.5 kB less source is also less for
  node to read and compile: **34.9 ms against 37.0 ms** at the fastest, 35.8
  against 37.9 at p25, and 36.4 against 38.4 at the median.

  Timed as **60 interleaved pairs** -- one spawn of each per iteration -- rather
  than as two batches, and that is the method rather than a tidy-up. Two batches
  minutes apart disagreed with each other and, run in the other order, with
  themselves: one of them put the shaken build 2 ms _slower_, because something
  else was compiling at the time. Alternating makes whatever the machine is
  doing happen to both, which is the same reason the invalidation benchmark
  reads a median rather than a slowest pass. Run again on a quiet machine the
  interleaved answer moved by 0.1 ms and the numbers above are that run; the
  loaded one said 38.2 against 40.3, which is the same 2 ms carried on larger
  absolutes. The delta is the claim, and it holds at all three points of the
  distribution.

  The rendered output is byte for byte what the unshaken build produces and what
  the app produces run from source, which is what `should render what the
  unshaken sheet does` asserts three ways.

- **The analysis is evidence, not proof, and the direction it falls is the whole
  design.** A class reaches the cascade as a string, so the question is which
  strings the app's source can produce: every string literal and every template
  quasi in the app's own files is tokenized, and a utility survives if some token
  could be it. That is Tailwind's scanner. Like Tailwind's it is unsound in
  exactly one direction -- a class assembled entirely out of values that never
  appear as literals leaves nothing behind and its rule is dropped -- and
  `build.safelist` is the escape hatch that admits it, with `build.shake: false`
  and `--no-shake` for an app that would otherwise need a long one. SIG-81 listed
  three possible answers and leaned towards refusing a computed `class`
  outright; refusing is not available here, because nothing in this pass knows
  _which_ expressions are class values -- a `box({ class: x })`, a JSX attribute
  the app's own `tsc` has not compiled yet, and a `ui` template's `class=${x}`
  are three different shapes and only one of them is this build's to read. So
  the answer is the conservative one with a declared safelist, which is what
  every tool that took the other two ended up with.

- **What makes it better than a regex is that the open ends are read off the
  tree.** A literal sitting next to an interpolation is _open_ on that side, so
  `` `text-${colour}` `` and `'text-' + colour` both leave the token `text-` open
  on the right and every `text-*` utility survives them; a literal with nothing
  beside it is closed and matches by equality, so `'Hello, '` keeps nothing.
  Which end is open is not a property of the characters, and a scanner over raw
  source cannot know it.

  **A string an app builds is a sequence of parts, and the unit is a _run_ of
  the known ones rather than a part.** That is the model, and reading part by
  part is what a review round found five shapes wrong with -- every one of them
  a **dropped** rule. `` `text-` + colour `` and `` colour + `-red` `` put a
  _template_ where a string literal was expected, so the concatenation saw no
  known operand at all and the template was later read on its own as closed;
  `` c += `-red` `` is that again; and `` `${'text-'}${colour}` `` put the
  literal inside an interpolation, where nothing was looking -- the walk found
  it and read it closed with no idea an unknown sat beside it. A run is open on
  an end where an unknown part sits beside it and closed at the ends of the
  expression, and a template literal and a `+` chain are then one rule rather
  than two. It is also _tighter_ where it differs, correctly: `'a' + 'b' + c` is
  the prefix `ab`, where per operand it was a prefix `a` and a both-ends-open
  `b` -- both safe, one of them the string.

  Three details each cost a test. A token is open only when it **touches** the
  open end, so `'Hello, '` before an interpolation makes `Hello` closed --
  without that, every string in an app would be a prefix of something. A `+`
  chain is **flattened** first, because `x + 'b-' + y` parses as `(x + 'b-') + y`
  and a chain whose literals sit at its _ends_ reads the same either way, which
  is why the obvious repro passes with the flattening deleted. And a **tagged**
  template is not a concatenation: its value is whatever the tag returns, so its
  quasis are read as chunks and its interpolations are never folded in --
  folding `` ui`p-${x}` `` would turn the prefix `p-` into whatever `x` happened
  to be. Reading those quasis at all is the only reason a `ui` template's
  `class="p-2"` is visible, since the class sits inside the template's text
  rather than in a string of its own.

  What counts as **known** is a string and nothing else -- a string literal, or
  a template with no interpolations. Not a number, though `'p-' + 2` really is
  `p-2` and folding it would be tighter still: tighter is where a mistake
  _drops_ a rule, so an unknown part simply ends the run and opens its
  neighbours, which is the safe answer for every operand there is.

- **The scan is lazy, and what it costs is measured rather than optimized.** It
  is asked for on the first module that turns out to hold a `utilitySheet()`
  call and never for an app that does not, which is most of them: **0.4 ms**
  for a three-module app, **100 ms** for a 238-module 2.17 MB tree -- 76 ms
  parse, 9 ms walk, 2.5 ms reading the files. The parse is the cost and the
  obvious way to skip it is not available: a file whose raw text holds no token
  any utility could match still might, because a literal's cooked value is not
  its source text and `'\u0070-2'` is `p-2` to the parse and nothing to a
  substring search. Skipping there would be a silent **drop**, which is the one
  direction this analysis does not trade in -- unlike the escaped specifier the
  filters already miss, which is a silent _keep_.

- **Everything uncertain resolves towards keeping, and two guards that did not
  were deleted.** Keeping a rule nothing can match costs 35 bytes; dropping one
  something can match costs a layout subtly wrong in a terminal with nothing to
  point at. So a file that does not parse falls back to a **raw token scan of its
  own text**, which reads identifiers and comments as though they were class
  names -- strictly more conservative than the parse, where skipping the file
  would lose evidence and failing the build would refuse an app over a file
  rolldown never reads. Files nothing imports are scanned too. A `utilitySheet`
  the matcher cannot claim is left alone with the whole sheet behind it, and that
  is correct output rather than a miss: the shaken sheet is a _subset_, so the
  two disagree only about rules the evidence says nothing can match.

  What the walk must not read is a **previous build's output**, which holds the
  whole sheet as a string and is therefore evidence for every rule there is. The
  output directory is excluded, and `clean()` empties it first in any case. A
  _second_, stale output directory elsewhere in the app is the case that gets
  through, and its failure is the safe one: everything is kept and the summary
  says `383 of 383` rather than saying nothing. That is what the count in the
  summary is for, and it is why the summary says nothing at all when no module
  called `utilitySheet()` -- `383 of 383` about an app with no utility sheet in
  its bundle would describe a sheet that is not there.

- **The count describes the sheet the build produced, which is narrower than
  "what is in the bundle".** Two things part them and neither is detectable from
  here. A second call in a shape the matcher cannot claim --
  `const { utilitySheet } = style` -- is left alone with the whole 383-rule sheet
  behind it, so both ship while the count names one; that is the silent miss the
  matcher documents everywhere else, seen from the report's side. And a
  rewritten call that tree-shaking then drops takes its sheet with it, so the
  count names one that is not there at all. Asking the written bundle whether a
  dropped rule survived would catch the first and is refused: it is a substring
  search an app writing its own CSS can fool, which is a false alarm about a
  correct build, and this file already records what a warning that fires on
  correct code teaches people to do.

- **A flag beats the file, and for a _flag_ that is only true in one
  direction.** A declared flag always has a value -- `false`, or `true` when
  negated, never `undefined` -- so an explicit `--shake` is indistinguishable
  from the default and cannot beat a `"shake": false` in `sigil.json`, while
  `--no-shake` over a `"shake": true` works. That is the direction that matters,
  because off is the only thing either flag is offered for, and it is the same
  imprecision `--out` already carries a comment about: what a defaulted option
  holds when nobody passed it is that default rather than `undefined`. Telling
  the two apart means re-reading argv for a spelling, which is a second parser
  disagreeing with the first over a case nobody has. `--sourcemap` is the same
  and always was.

- **Zero is the one count the summary cannot speak for itself, so it gets a
  sentence.** An app that asked for the utility sheet and named none of it is
  either carrying a call it no longer uses or naming its classes somewhere the
  scan cannot see, and the second is the unsound case arriving as a layout that
  is subtly wrong with nothing to point at. Both have the same two answers --
  the safelist, or `--no-shake` -- so both get told. It is a note rather than a
  diagnostic and carries no file or line, because the finding is an absence
  spread over the whole app and a diagnostic naming the `utilitySheet()` call
  would be pointing at the one line that is certainly right. That is also the
  closest thing there is to the dev-mode parity SIG-81 asks for: the unbuilt
  path uses the whole sheet, so the divergence is always one-directional --
  works unbuilt, missing once built -- and what the build can do about it is
  say what it dropped rather than guess which drop was wrong.

  Four guards have been deleted here for failing a sabotage, and they are
  recorded because every one of them read as load-bearing.
  A `claimed` set stopped a `+` chain's literals being read a second time as
  closed; sabotaging it failed no test, and it cannot, because a closed reading
  matches by equality while the open reading it duplicates matches a superset --
  redundant rather than wrong. A `resolve()` on the lookup side of the exclusion
  was dead, because the walk starts at a resolved root and `join()` normalizes;
  the one on the _set_ side is real and is pinned. A template with no
  interpolations was asked how many expressions it had, which its single quasi
  already answers. And a `sites` counter in `bundle.ts` decided whether to report
  at all, which the shaker's own result already decides: the sheet is asked for
  only after a call has been found, so a shaker that has a result rewrote at
  least one site.

  The one guard that survived a sabotage without failing a test and was **kept**
  is `reachable()` in `shakeStyles()`, and it is kept because it is a fast path
  rather than a claim: without it the walk runs and finds nothing, which is the
  same answer, and the case it skips is the common one for this filter -- a
  module importing `Cascade` or `declare` from the same place. It says so.

- **The walk's loop guard is asserted as a count, because it always was one.** The
  `entered` set of real paths is what stops a symlink pointing back up the tree
  being followed forever, and what it is for is **cost** rather than termination:
  the operating system ends an infinite walk anyway, since a path through more
  than MAXSYMLINKS links fails `readdir` with ELOOP and the walk treats that as an
  unreadable directory -- so without the set the recursion stops after about
  thirty levels having read every directory and every file about thirty times
  over. `should walk a symlink loop once rather than once per level` asserted that
  by **timing** the same tree with and without the link and requiring the ratio
  under four, and the test's own name is the reason that was the wrong shape: read
  once rather than once per level is a number, not a duration.

  It flaked, and the numbers say why the obvious hardening was already in place
  and still not enough. Correct behaviour gives ratios of 0.69, 0.93, 0.98, 1.04
  and 1.27 over five full-suite runs -- the loop genuinely costs nothing -- while
  each side's own absolute moves by a factor of 1.8 between runs, 3.2ms to 5.7ms
  on twenty files. One run reported **5.41** and failed a build over a walk with
  nothing wrong with it. The test took the **fastest** of three runs per side,
  which is the right statistic and only helps where contention is intermittent
  _within_ the sampling window: the two sides were timed in separate windows, so a
  sustained stall over one inflates all three of its samples and the minimum with
  them. That is the batched-against-interleaved failure this file already records
  for the style-shaking measurement, met in a suite that runs eighteen workers at
  once. Interleaving would have narrowed it and left a timing test behind.

  `shake-walk.test.ts` counts instead, and `node:fs` is mocked there the way
  `bundle-close.test.ts` mocks `rolldown` and for its reason: the walk is inside
  `scanClassEvidence()`, nothing outside can see what it read, and the alternative
  is a counter on production code whose only reader would be that file. The real
  `readdirSync` and `readFileSync` run and the wrapper only records, filtered to
  the tree so that the rest of the process's reads are none of the count's
  business. What is asserted is exact: two directories and twenty files, no path
  twice, and the same paths whether or not the loop is there -- a loop costs one
  `realpath` and changes no count at all. Removing the `entered` check fails three
  of the four, and the fourth is the tree with no loop in it, which is right.
  A file of its own, because `vi.mock` is hoisted and module-wide.

  It also cost a Windows round trip, which Conventions now records as a fourth
  instance of its own rule: one assertion matched a path with a regex ending in a
  forward slash, so it found nothing against the `src\one` that `join()` builds
  there. The counts and the differential were unaffected, because those compare
  paths against other paths built the same way rather than spelling one.

  Two things about the fourth test are worth knowing, because the first version of
  it asserted the wrong one. The walk records the path it **walked** rather than
  the real path it resolved to -- `join()` builds each path from the link it came
  through -- so a tree reaching a directory through two links reads it once and the
  target's own spelling appears nowhere in what was read; an assertion on
  `startsWith(target)` therefore found nothing and looked like a missing read. And
  which of two links to one directory wins is `readdir` order, so what is asserted
  is that exactly one of them was entered rather than which.

- **The shaken sheet is regenerated, not printed.** `generateUtilities({ only })`
  filters the set the generator produced and prints it the way it always did, so
  a surviving rule's text is byte for byte the text it has in `UTILITY_CSS` and a
  shaken sheet is a **subset** rather than a second sheet that happens to agree
  -- asserted line for line. The alternative was a printer over a parsed
  `Stylesheet`, which is a second spelling of the grammar and the thing this file
  records as how two halves of one library come to disagree. A name nothing
  generates is ignored rather than refused, because a safelist is written by hand
  against a vocabulary that moves between releases.

- **The rewrite is what `utilitySheet()` already is: a hoisted function over a
  `var`, memoized.** `utilitySheet()` memoizes, so a rewrite that parsed per
  call site would be slower than what it replaced -- and it is reached whenever
  it is called, which a `const` is not. A `const` was the first shape and is
  wrong in two ways: it parses the sheet at module evaluation whether or not the
  call is ever reached, and it sits in a temporal dead zone, so a module reached
  through an import cycle before its own body has run throws a `ReferenceError`
  where `utilitySheet()` answered. `var` and a function declaration hoist, so
  neither can. What it is not is the same _object_ across modules the way the
  memo is, which nothing can observe: a `Stylesheet` is frozen and a `Cascade`
  only reads it.

  The head it prepends is an `import`, and that can only ever reach a module
  that already has one: the matcher reads oxc's record of the module's **static
  imports**, which a CommonJS file cannot have -- a `.cjs` calling
  `require('@ttylabs/sigil/style')` passes the filter, finds no binding and is
  declined. A `'use strict'` that stops being the first statement is no loss
  either, since a module is strict anyway. The prefix contract is
  `compileTemplates()`'s, with `$css` in place of `$ui` -- two passes may run
  over one module and two passes choosing one prefix is two sets of names that
  collide. `test/fixtures/styled/src/commands/tpl.ts` is a module both of them
  rewrite, and what it pins is that the two survive each other: what it renders,
  and its entry in the source map with its **original** text in
  `sourcesContent`.

- **An import is a binding, not a spelling, and there is now one implementation
  of that.** `bindings.ts` holds it, because `findTemplates()` asking whether a
  tag is the `ui` from `@ttylabs/sigil/template` and this pass asking whether a
  call is the `utilitySheet` from `@ttylabs/sigil/style` are the same question --
  the alias, the namespace member, the parentheses, the type-only import and the
  name the module binds again all decided once. Same rule `readRoutes()` already
  records for the two route walks. The list of shapes that stay unreachable is
  the same list, and it is under "Every shape the matcher misses is silent".

- **What the build says about a dependency the app declares** is the other item
  SIG-73 left and SIG-115 carried, and it is the same honesty argument: the
  zero-dependency promise is about what _sigil_ adds, an app that imports
  something is bundling it, and a build that silently inlines two megabytes of
  somebody else's library has told the author nothing. So every package whose
  code went into the bundle is reported with its size, `@ttylabs/sigil` included
  -- what the runtime costs is exactly as worth knowing as what a dependency
  costs. It found something on the first run: `magic-string` is **46.3 kB** of
  the toolchain's own bundle.

  A module is the app's **own** when it is inside the app root _and_ under no
  `node_modules`, and a dependency's otherwise. Both halves are load-bearing and
  each alone is wrong in the case the other covers, which is what a review round
  found: an _installed_ dependency lives at `<app>/node_modules/left-pad`, inside
  the root, so "outside the root" alone reports a normally installed app as
  having inlined nothing; a _linked_ one resolves to a real directory with no
  `node_modules` in its path, so "contains `node_modules`" alone reports a bundle
  that inlined the whole runtime as having inlined nothing -- which is every app
  in this repository and exactly what a test written here would have been blind
  to. The owning package is read from the nearest `package.json` above the
  module, which is how node itself decides, cached per directory and caching the
  misses too.

  The bytes are `renderedLength`, which is **after tree shaking and before
  minification** -- measured, not assumed: the sum is identical with `minify` on
  and off. So they do not add up to the chunk sizes printed beside them and are
  not meant to, minification being an output stage that runs after the modules
  are rendered; apportioning a per-module share of it would be inventing
  precision. The column is called `Code` rather than `Size` for that reason. What
  the number is good for is the question anybody asks here -- is something
  enormous in this bundle, and what -- which needs the magnitudes right rather
  than the total.

- **Whether route files co-locate their templates and stylesheets is still
  open, and now for a reason rather than for want of the compile steps.** SIG-74
  could not answer it without them; they exist, and the answer they suggest is
  that there is nothing to co-locate. A template lives in the module that renders
  it, which is already co-located as far as anything can be, and a stylesheet is
  not a file type this build reads at all -- an app's CSS is a string in its own
  source, and the only sheets the build knows about are the two the runtime
  generates. A `panel.css` beside `panel.ts` would mean inventing a file type, a
  resolution rule and an origin for it, which is a feature rather than a
  co-location convention. Revisit it when an app has a sheet big enough to want
  its own file.

### Writing the CLI in sigil

- **The toolchain routes its own commands, and that is what the acceptance test
  means.** `src/commands/` is the source of truth: adding a command is adding a
  file, and `index.ts` no longer writes the tree out beside the directory that
  _is_ the tree. What it declares instead is `commands: './commands'` with the
  `baseDir` SIG-75 added, which is the same declaration `sigil new` scaffolds
  and the same one `sigil build` reads -- so the toolchain is now an ordinary
  app as far as its own passes are concerned. `should read this toolchain's own
  schema as a routed directory` in `test/build/discover.test.ts` is that said
  from the other side.
- **Which immediately cost it its own `--help`, and that is the finding rather
  than a snag.** A filesystem route keeps its description inside the module, so
  a routed `sigil --help` listed four bare names -- worse than what it replaced,
  and shipped by a package whose users would never see a description again. The
  static `desc` lift exists precisely because routing makes name-only help the
  common case; the toolchain is built by tsdown rather than by itself, so
  nothing was lifting anything. `scripts/generate-commands.mjs` **was** that
  lift run as a build step, and it walked with `readRoutes()` -- the _runtime's_
  reader -- so the thing that described the walk could not come to disagree with
  the walk. Past tense throughout: the script is gone, and so is the module
  behind it. The three bullets below are where it went, what was left behind
  when it went, and what that left saying the wrong thing.
- **`pnpm build` is the toolchain building the toolchain, and that deleted the
  bridge.** A hand-run `scripts/generate-commands.mjs` used to do the lift and
  write a committed `src/route-info.ts`, because tsdown knows nothing about
  command trees. `sigil build` has always known: it walks the directory, lifts
  `desc` and `hidden` out of each module, and bakes the tree into the entry it
  generates. So the script, the committed file and its drift check all went in
  the change that stopped needing them, and the toolchain stopped filling the
  schema's `routeInfo` -- the shape to reach for when a generator appears beside
  a build is whether the build should have done it. `routeInfo` itself did
  **not** go, and an earlier wording of this bullet said it had, which is the
  one sentence here capable of causing damage: it is live runtime API, read in
  `init-command.ts` wherever a placeholder is built, and the bullet below is
  what stands between it and the next cleanup.
- **Except the lift-and-print module outlived everything around it, and dead
  code carrying instructions is worse than dead code.**
  `packages/cli/src/build/route-info.ts` -- the _generator_, which is a
  different file from the committed `src/route-info.ts` it generated, and the
  one-directory difference between the two names is most of why this survived a
  change that deleted the other -- was 224 lines reachable only through a barrel
  re-export, with `liftRouteInfo()` and `printRouteInfo()` named nowhere else in
  `src`, `test`, `scripts`, `demos` or `website`. What it printed was a header
  telling the reader to run `node scripts/generate-commands.mjs` and pointing at
  a drift check called `the committed route info`. **Both of those were real and
  both had been deleted**, which is a sharper thing than a header that was
  always wrong: `describe('the committed route info')` lived in
  `test/commands.test.ts` and called these two functions, and the commit that
  made `pnpm build` self-hosting took the suite, the script and the committed
  file and left the printer still describing all three. So the lesson is not
  "somebody wrote a fictional instruction", it is that a **correct** comment
  becomes a false one when what it names is deleted around it, and nothing in a
  build catches a string. An uncalled function is a thing somebody deletes; an
  uncalled function telling you to run a script that is no longer there is a
  thing somebody goes looking for the script for. It was also not merely
  uncalled but **superseded**: `tree.ts` walks with the same `readRoutes()`,
  reads the same `desc` and `hidden` through the same `factsOf()`, prefers a
  package's own manifest the same way, and reports through `diagnostic.ts`
  rather than a flat `problems: string[]` -- so it is the same pass with the
  repo's one diagnostic shape and a `load` per command at the end of it.
  rolldown had been shaking it out, so nothing shipped was wrong and nothing
  measurable is reclaimed; what it cost was paid entirely by whoever read it.
- **What replaced `routeInfo` is not `routeInfo`, and that is why three
  sentences about it were wrong.** `sigil build` emits a `commands` literal
  whose entries carry `desc`, `hidden` and a `load` -- `generateBin()` writes
  `commands` and `version` and nothing else -- so the descriptions arrive as
  what the **placeholder declares**, which the runtime already honoured, rather
  than as a cache beside a walk there no longer is. `Schema.routeInfo` is for a
  build that keeps the walk, which this one does not -- and the README saying
  `sigil build` writes it for you, `RouteInfo`'s own doc comment, and the entry
  above under the route rules had all been saying otherwise. Each was false
  before the module was deleted rather than made false by deleting it, which is
  the only reason to correct them here: the deletion is what removes the last
  thing in the tree those sentences could have been pointing at. Pinned now by
  `a lifted description` in `test/parser/routing.test.ts`, which is the coverage
  that was missing -- `routeInfo` is read throughout `init-command.ts` and was
  tested nowhere at all, and a public API with no producer left in the tree is
  one the next cleanup takes for dead.
- **Stage 2 is the check that the compiler is a fixed point, and it holds.**
  Stage 1 is what stage 0 produces; stage 2 is what _stage 1_ produces, and the
  two are byte-identical. Two runs of one binary agreeing proves only
  determinism -- what two _different_ binaries agreeing proves is that the
  output depends on the source rather than on something about the builder,
  which is the claim "written in itself" actually rests on. It is a test rather
  than a CI step because it costs 336ms, and a check that only runs somewhere
  else is one nobody sees fail until later. Both stages are built _inside_ the
  package, since what `sigil build` emits imports `@ttylabs/sigil`,
  `oxc-parser` and `rolldown` rather than inlining them and node resolves those
  by walking up from the file.
- **It asserts a working fixed point, not only a matching one.** Two identical
  broken binaries satisfy every byte comparison there is, so the stage 2 binary
  is asked for `--help` and then asked to build an app that then runs. A
  self-hosted compiler that cannot compile is a fixed point and nothing else.
- **Testing that guard took two attempts, and the first one is the lesson.**
  Sabotaging the build with a `Date.now()` in the generated entry's _comment_
  changed nothing: the minifier strips comments, so the output was identical
  and the check passed. The guard was not vacuous -- the sabotage was. Injecting
  a value the minifier keeps failed it immediately, naming `sigil.mjs`. The file
  _set_ still matched, because an entry's name is not hashed and only its
  contents moved, which is why the names and the bytes are two assertions.
- **Stage 0 is `node src/sigil.ts`, and it needs no build.** That is what keeps
  a broken build able to build its own fix, and it is why the build script is
  `node src/sigil.ts build` rather than `sigil build`: the bin it would run is
  the thing being produced.
- **From source the commands list by name alone, which is the lift's absence
  rather than a defect.** A filesystem route keeps its description inside its
  module, so an unbuilt tree has nothing to show until something imports one --
  exactly what every unbuilt sigil app does. The built toolchain names and
  describes all four. `should behave the way the source does` compares what each
  one _does_ -- the version, the exit code, the commands offered -- rather than
  the screens byte for byte, because the descriptions are the one thing that
  legitimately differs.
- **The toolchain publishes a bin and nothing else.** `./build`, `./template`
  and `./utilities` are gone, along with every `.d.mts`: it is an app rather than
  a library, `sigil build` emits an executable, and the three subpaths had
  exactly zero real importers anywhere -- every reference in the repo was inside
  a comment. Their declarations were 33 KB of an 85 KB `dist`, `build.d.mts`
  alone 22 KB.
- **`@ttylabs/sigil` is external in that build, and it is the reason the bundle
  is smaller than what tsdown produced.** Inlining the runtime is right for an
  _app_, whose promise is that it ships depending on nothing; the toolchain is a
  devDependency that declares its dependencies and npm installs them. Inlined it
  is 177 KB, external 38 KB, against tsdown's 52 KB of code and 33 KB of types.
- **The build minifies, which needed the control-character escape brought with
  it.** Both tsdown configs minify and `sigil build` did not, so every app it
  built shipped unminified. Turning it on reintroduced the defect
  `packages/sigil`'s own build carries a plugin against: the runtime writes
  `ESC` as `String.fromCharCode()` so a raw control character never sits in
  source, and a minifier folds it straight back. Three of them in one fixture's
  bundle, and three is all it takes -- one opens a hyperlink nothing closes. The
  escape runs over the **written files** rather than in `generateBundle`, which
  is where it started: minification is an output stage that runs after the
  hooks, so the escapes were folded straight back.
- **The options live in `sigil.json`, because there was already a
  `sigil.json`.** `sigil add` read it for where ejected components land and
  `sigil new` writes it, so the question a build option raised was never "config
  file or flags" but "this file or a second one" -- and two files answering for
  one tool is worse than a long script line. `pnpm build` is now
  `node src/sigil.ts build` with nothing after it. A flag beats the file and the
  file beats the default: the file says what this app is always built with, a
  flag says what this invocation wants.
- **One reader, not two.** `readSigilConfig()` is the only thing that opens the
  file, and `readConfig()` in the registry goes through it. One file with two
  readers is two ideas of what it may contain, and the second one to grow a
  field is the one that silently ignores the other's.
- **A `next.config.ts` was the other candidate and is deferred with a reason.**
  It has to be _executed_, and everything else this build does is reading: the
  app's entry is parsed rather than imported precisely so an app that opens a
  connection at module scope does not do it during a build. Running
  app-adjacent code would be a new surface, and none of the four options needs
  computing -- they are literals. The day one of them does is the day to
  revisit it, which is the rule `which` waited on for a caller.
- **A build generates its entry into a directory named after its output, and
  removes it again.** `writeEntry()` used to write `node_modules/.sigil/entry.mjs`
  -- one path per _app_ -- so every concurrent build of one app wrote the same
  file. Two builds of one app at once is ordinary: two terminals, or a script
  producing two `--out` directories. What it produced was not a flaky failure but
  a **silently wrong bundle**, and it is worth stating how silent: two builds
  differing only in `--commands` baked the same tree into both outputs, four runs
  out of four, whichever wrote last winning for both, exit 0 and nothing said.
  This repo's own suite had it -- `output-forms.test.ts` builds the `app` fixture
  twice in one `Promise.all` -- where it passed only because two builds of one
  tree generate identical entries, leaving a torn read as the only way to see it.
  That is the likeliest explanation of an unexplained twelve-failure run that
  never reproduced.

  It cannot move somewhere neutral, which is why this is a subdirectory: the entry
  does `import { main } from '@ttylabs/sigil'`, which resolves by walking up from
  the file, and it reaches the app's own modules relatively. Those specifiers cost
  nothing to move, because `generate.ts` computes them with `relative(from, ...)`
  rather than assuming a depth.

  The name is a hash of the resolved output rather than random, and that is the
  half worth knowing. `mkdtempSync()` was the first version: it is unique per
  invocation, so it closes one case this does not -- two builds of one app to one
  `--out` -- and it costs reproducibility, because the directory name reaches the
  sourcemap as a `sources` entry, so two identical builds would differ in bytes.
  That would have gone unnoticed here, since the toolchain builds with
  `--no-sourcemap` and the bootstrap's byte-identical fixed point never sees it,
  which is luck rather than design. The case the hash gives up is two builds
  already fighting over every file they write, where the entry is the least of
  what they would clobber. So: deterministic, and separated for every pair of
  outputs that does not collide -- which is a weaker sentence than it wants to be,
  and the paragraph below is where the width that makes it true, and the part of it
  that stays false at any width, are written down.

  Removed on the way out, in the same `finally` that closes the bundle, and
  unconditionally -- a refused build has no more use for a generated entry than a
  finished one, and one directory per failure is how `node_modules/.sigil` fills
  up. What that costs is measured rather than assumed: the bundle's sourcemap
  _names_ the entry, so `sources` points at a path that is gone -- and
  `sourcesContent` carries its 914 bytes, verified to be the generated entry, so
  every consumer that honours embedded content still shows it. Only one that
  insists on reading from disk loses it, which for generated code is the less
  useful behaviour anyway. `BundleResult.generated` went with it: it handed back
  that path, nothing in either package read it, and after this it would be a
  published path guaranteed not to exist -- the same call `Command.file` got, for
  the same two reasons.

  **The width is a claim about accident and is worth stating no wider.** Twelve
  characters shipped first, and the review found the hole: 48 bits puts a birthday
  search at 2^24, so twenty million paths turned up `/tmp/sigil-c-10001357` and
  `/tmp/sigil-c-11986969` sharing `94e17cf76917` in about ten seconds -- and
  building two trees into those two outputs put the same one in both bundles, which
  is this defect back with two outputs that share no file at all. Sixteen puts that
  search at 2^32, which is what makes "two real output directories cannot collide"
  true; a pair built on purpose still can, at any width short of the whole digest,
  and the whole digest is refused because this is a name somebody reads in a stack
  trace and the failure it would close is somebody deliberately corrupting their own
  build. The width is pinned by a test rather than left to the comment.

  **Two edges are known and declined, both measured.** Two builds to _one_ `--out`
  is the case the hash gives up, and it is also where the cleanup is unreliable:
  two processes removing one directory means an `rmSync` can throw, and a swallowed
  throw leaves it behind -- a few kB inside `node_modules`, in a case whose bundle
  was already whichever process wrote last. Seen once in four runs by one review
  and **not** in about seventy barrier-synchronised attempts by the next, including
  removals raced against an open file handle, so the rate is unknown and may be
  platform's rather than ours. The `catch` is the right shape whether or not it
  fires; what is not claimed is how often. A `.sigil` the user has replaced with a symlink
  pointing outside the app is removed through the link, which is the same class
  `undo()` documents and declines to close -- and such a build fails anyway, because
  the entry's relative specifiers no longer reach the app.

  **Naming the directory and writing the file are two steps, because only the name
  has to come first.** The path is `rolldown()`'s `input`, so it is chosen before
  the call -- but the file is not: measured against rolldown 1.2.11, `rolldown()`
  resolves an input that does not exist yet and `write()` bundles it happily if it
  has appeared by then, provided the path is **absolute**, which this one is. A
  relative input fails either way, which is what made the first measurement of this
  look like the opposite and is worth knowing before anybody re-measures it. So the
  write happens inside the same `try` that removes the directory, and there is no
  window where one exists with nothing bound to clean it up. That window was real:
  a throw between the two -- while the options object was still being built, say --
  leaked a directory. It was going to be written down as unreachable through
  `sigil build`'s own options, which it is, until the fix turned out to be moving
  two lines.

  **A rolldown virtual module is the design that has none of this, and it was
  tried.** An id shaped like the path it would have had -- `resolveId`/`load`
  returning `generateBin()`'s output, never writing a file -- builds, keeps the
  shebang, and puts the same source in `sourcesContent`; a NUL-prefixed id does
  not, because the relative specifiers need an id that looks like a path inside the
  app. It drops the shared file, the collision and the cleanup together. What it
  gives up is that during `bundle.write()` the entry is a real file somebody can
  read, which is worth something while this is the layer being debugged, and it
  reaches further than a bug fix should: it is the shape to take if this area is
  opened again.

- **`sigil build` empties its output directory, and refuses the one that would
  hurt.** A build that leaves the last one behind publishes the union of every
  build ever run there -- a renamed command's chunk stays, a removed one's
  stays. Doing it here rather than in a `rimraf` beside the call is what makes
  the command the whole of the build. It refuses an `--out` that _is_ the app
  root or sits above it, which is the one way a mistyped path turns a build into
  data loss, and `--no-clean` opts out.
- **Sourcemaps are on by default and `--no-sourcemap` turns them off, because
  "costs nothing" was only true of run time.** They are several times the size
  of the minified code they describe -- 203 KB against 38 KB -- and a package
  that publishes its `dist` publishes them too. The toolchain's own build says
  no; an app debugging its bundle says nothing and keeps them.
- **The published package ships `dist/commands/`, and nothing else would
  work.** Bundled into hashed chunks there is no directory for the walk to read,
  and the built bin fails with `Unsupported command module` -- from source it is
  perfectly happy, which is the shape of bug that reaches users and no test.
  Each command is a tsdown entry, and the entry list is _read off the directory_
  rather than written out, because a hand-kept list beside the directory that is
  the list would drift into a command that works from source and 404s once
  published. `_inspect.ts` keeps its `_`, so it stays a chunk rather than
  becoming an entry, which is that rule read from inside the repo that invented
  it.
- **Routing cost `--version` about 4ms, so `--version` stopped building a
  schema.** The walk is eager -- the top level of `commands/` is read while the
  schema is built, before argv has been looked at -- so answering "what version
  is this" read a directory and pulled the route reader onto the startup path to
  do it: 25.5ms to 29.5ms. `run()` answers before `main()` is called at all now,
  which is 24.3ms, _below_ where it was before routing, because it skips
  building the schema rather than merely skipping the walk.
- **That fast path is the whole of argv, not the flag appearing in it.** Every
  other spelling is a question with a second half that the parser already
  answers, and each answer is a decision written down somewhere: `--help
  --version` is help, because help outranks everything; `check --version` runs
  `check`; `--version extra` is an error about `extra`. A scan that fired
  wherever it saw the flag would have to reproduce all three to avoid changing
  them, and a second parser that disagrees with the first is worth a great deal
  more than four milliseconds. `should leave every other spelling to the parser`
  pins the three.
- **`--help` is unchanged at ~40ms, and that is the walk being the wrong thing
  to optimise.** The help renderer dwarfs a `readdir`, and the lift removes the
  _imports_ from the help path rather than the walk from the startup path.
  Making the walk lazy -- deferred until something actually asks the registry
  what is in it -- would close the general case rather than the one flag, and is
  a decision to take against a profile rather than in advance.
- **The toolchain renders its own reports, and `report.ts` is where they live.**
  It routed its own commands and was built by itself and then assembled its
  output with `process.stderr.write()` and a template literal, which is the half
  of "renders its own output with components" that was still outstanding: a
  framework whose own toolchain builds text by hand has not been tested by
  anyone who had to live with its renderer. So a diagnostic is a flex row, a
  summary is a paragraph of styled runs, and both go through
  `renderToString()`. `table()` was already doing this for `--tree` and the
  chunk sizes; this is the rest of what the toolchain says. `describeApp()` went
  with it -- it was the string form of what `appRuns()` now returns, and once
  both summaries were runs its only remaining reference was a comment claiming
  `failure()` used it, which `failure()` never did. That one stays a string on
  purpose: it returns an `Error`, whose message is text `errorHandler()`
  renders, and an element tree has nowhere to go inside one.
- **A diagnostic wraps in the column it started in, which is what a string
  could not do.** `file:line:column: severity: message` is unchanged -- it is
  what an editor, a terminal and a CI log all already know how to read -- and
  what the drawing adds is the two things text cannot: the severity is coloured,
  and a message too long for the line hangs under itself instead of returning to
  the margin, where it reads as a second diagnostic. That is help's own pattern,
  a flex row whose message column is a **declared** width. It used to be declared
  for the reason help declared its own: a row's intrinsic height was taken with
  every child offered the whole content box while placement hands each one a share,
  so a message that wrapped to three lines in its share measured two in the room it
  was offered and the row after it was painted over the third. SIG-125 closed that
  in the engine, so no app has to write that subtraction to get a correct layout any
  more; this one **stays**, for a second reason it turns out to have had all along.
  The message is built out of `nowrap` words on purpose, so the row's automatic
  minimum is its widest _word_ -- and a report's words are mostly paths. Asked for as
  a share it grows to that minimum, so one long path widens the whole column:
  measured, at 60 columns with a 37-column path in the message, the column went from
  29 to 37 and every line rewrapped. That is the same failure help's own attempt hit,
  which is what says it is a property of a row of unbreakable words rather than of
  either consumer. A `min-width: 0` on the container gets the old output back byte
  for byte and is the worse trade -- three properties for one, and the property
  `wordsView()` exists to _not_ set on its words meaning something else on their
  container. `room` is computed for the `MIN_MESSAGE` threshold in any case, so
  spending it differently saves no arithmetic. Below that threshold the location
  takes the line and the message is indented under it, at the same threshold and
  for the same reason help's list gives up on two columns.
- **The prefix is measured as it will be drawn, on one line.** Both halves are
  rules `table()` already carries for a cell, met here through a file name. A tab
  measures nothing and draws a space, so measuring the raw string leaves the
  message column a column out per tab -- and a path really can hold one, which is
  why `oneLine()` goes through `toDisplayText()` rather than through
  `stringWidth()` alone. And a newline becomes a space, because a location is one
  line by construction: a prefix two lines tall would leave the message indented
  against a line it does not belong to.
- **A message whose whitespace is structure is output somebody captured, not
  prose, and keeping it took three goes.** `typecheck.ts` puts a compiler's whole
  stdout in one when it exited without saying anything parseable, and the
  whitespace is the only structure such a message has. The predicate is a newline,
  **a run of two whitespace characters, or whitespace at the start**, because a
  paragraph splits on `/\s+/` and drops the empty pieces: `expected '  ' here` was
  drawn as `expected ' ' here` and `foo\t\tbar` as `foo bar`, so the terminal
  disagreed with the pipe about what the message _said_. A **single** tab between
  two words deliberately does not match, because a paragraph renders it as one
  space and so would the grid -- `toDisplayText()` draws a tab as a space either
  way -- and matching it would stop one ordinary tab's whole message wrapping for
  no gain. One rule, whitespace that carries information, rather than a newline
  special case.
  **The width is the mechanism, and `white-space` is not.** A `text` at `normal`
  keeps the author's newlines and the spaces inside each line; the only thing it
  does wrong is _reflow_ a line too long for its box, so at 60 columns a code line
  wrapped and the tilde caret under it no longer sat beneath what it pointed at.
  Give the box the content's own width and there is no such line. That is help's
  rule for a label too wide for its column, reached from the other side, measured
  through `toDisplayText()` for the reason the prefix is. The stacked case adds the
  padding on top, because `box-sizing` starts at `border-box` and a width of
  exactly the content leaves every line two columns short -- the rule this file
  already records for a themed table cell, met from the other side.

  Getting there took a wrong turn worth recording. The fix was first written as
  `white-space: nowrap`, which looks like the property that means "verbatim" and is
  a **property that does nothing** here: nothing can exceed its box once the width
  is right, and deleting it changed no output at any width. It also walks into a
  trap on its own, without the width -- `text-overflow` bites on a line wider than
  its box, so a declared column narrower than the content silently **cut** the dump
  to `1 const x: number = "hello h`, which is worse than the reflow it replaced
  because nothing says so. Both were found by sabotage rather than by reading:
  removing the width fails two tests, removing the `nowrap` failed none.

  The entry this replaced claimed such a message was "printed as it stands" and it
  was not, and the test could not see it -- it asserted a short line appeared
  _somewhere_, which survives a reflow. It is a line count now, plus a walk over
  100, 60, 40, 20 and 10 columns asserting every source line survives **with its
  own leading whitespace**: the first version of that walk compared against
  `line.trimStart()`, which excused exactly the loss it was named for at the three
  narrow widths where the border-box cut lived.

- **A terminal gets the laid-out form and a pipe gets one line per diagnostic,
  and the piped output is byte for byte what it was.** This is `tsc --pretty`'s
  split and it exists for the reason that flag does, which the first version of
  this found out the hard way: wrapping every diagnostic broke `grep`. A message
  that wrapped between "string" and "literal" is one
  `grep "a string literal"` no longer matches -- measured, 1 to 0 on this repo's
  own fixture -- and a diagnostic is the one output people really do pipe into
  tooling. So whether there is a terminal decides _what is drawn_ rather than only
  how, which is the rule the spinner and the progress bar already follow, down to
  the promise that comes with it: into a pipe, `sigil check`, `sigil check --tree`
  and `sigil build` are byte for byte what they were before any of this was
  rendered, on every fixture and with the warning count included -- exit codes
  too. `build`'s summary is `, N warnings` rather than the parenthetical the first
  version wrote, because the runs are joined by a space off a terminal and the
  comma is what `main` printed; the comma rides on the run before it, since a run
  is a _word_ and a lone comma would be drawn with a space in front of it. The
  first version of this promise had only ever been checked against `check`, which
  is how the `build` difference survived being written down as verified -- and it
  was checked by hand either way, which is the gap the two entries below close.
  The two forms cannot
  drift in the part that matters, because the location is
  `diagnosticLocation()`'s and both print it -- which is what that function was
  extracted for, and what stopped `formatDiagnostic()` being dead code the moment
  the renderer replaced it. Extracting it was not enough on its own and this
  sentence was false for three commits: the terminal path went on rebuilding
  `file:line:column` by hand, so a tab in a path really was a different location
  in a pipe than on a terminal, and editing the shared function would have changed
  only one of them. `relativeTo` is applied in `writeDiagnostics()` and nowhere
  else for the same reason -- both forms are handed the same diagnostic, so there
  is one thing that formats a location and one thing that rewrites a path. What differs is the wrapping and the colour, which is
  exactly what the destination was asked about. The question is `isTTY` and
  deliberately **not** the colour level: `NO_COLOR` on a real terminal means "no
  colour", not "no layout", and a report that unwrapped itself over it would be
  reading one setting as though it were another.
- **Both forms are spawned and asserted, and what is pinned is the claim rather
  than the bytes.** Nothing in the suite ran either of them. `report.test.ts`
  reaches `report.ts` directly and has to, since a vitest worker's stderr has no
  `columns` and no `isTTY`, so every render through `run()` comes out at the
  fallback width with no colour -- the one case that cannot fail -- while
  `check.test.ts` and `build-command.test.ts` spy on `process.stderr.write` and
  assert on substrings, which survives any amount of wrapping. The byte
  comparison the entry above records was a `diff` against a `main` worktree run
  by hand, which is not a check anybody runs twice, and the `build` regression is
  what that cost. `test/output-forms.test.ts` spawns `dist/sigil.mjs` for both
  forms, which is the precedent `demos.test.ts` set and for its reason: a test
  that renders through vite is not a test of what a user's terminal gets.

  **A snapshot was the obvious answer and is the wrong one.** Its baseline is not
  "what this was before any of it was rendered", it is whatever was current the
  last time somebody regenerated it -- and regenerating is what a failing
  snapshot teaches you to do. The regression this exists for is the proof: a
  snapshot would have flagged ` (2 warnings)` and a regenerate would have blessed
  it, because nothing in a snapshot says which of the two answers is right. So
  each claim is asserted as itself, which is the rule the canvas diff's own tests
  already follow. **One line per record**, counted twice over -- the diagnostics
  by their shape, and then every non-empty line there is, because a wrap in the
  note or in the summary adds a line that is not a diagnostic and only the total
  sees it. **The grep case derived rather than written down**: every place the
  laid-out form broke a line is read back off it, the phrase spanning the break is
  assembled, and the pipe has to contain it while the terminal must not -- the
  1-to-0 measurement automated, and it cannot go quietly stale against a reworded
  message the way a constant would. **The two forms differentially**, since
  `report.ts` claims they differ only in the wrapping and the colour: take the
  colour off, collapse the whitespace, and they are one report. And **the grammar
  of the one line a rewording moves**, because the differential is exactly blind
  to the regression that happened -- both forms are built from the same runs, so
  ` (2 warnings)` changed both and they went on agreeing perfectly. That is the
  argument for having the grammar as well as the differential rather than a
  preference: `/ into \S+, 1 warning$/` is the only assertion in the file that
  fails when the historical defect is put back. What a byte comparison would
  catch and these do not is both forms being reworded together, which is a change
  somebody makes on purpose; what they catch is every way the split fails by
  accident, and each of them names what it is for when it fails.

  **Two of them were vacuous when first written, and the sabotage is what said
  so.** The `awk -F:` test filtered stderr to the lines matching
  `file:line:column:` and then read their fields, so a form that stopped being
  that shape at all left the filter empty and every assertion under it passed --
  the glob that matches nothing, one directory along. It asserts the count first
  now. And the does-not-break-a-path test passed with the laid-out form removed
  entirely, because an unwrapped diagnostic does not break a path either; it
  asserts that the render wrapped before it asserts what the wrapping did to the
  path. Sabotage is the only thing that finds either.

  **What a sabotage catches is worth recording and how many tests it catches is
  not, which took two goes to learn.** The count was written down three times and
  was wrong twice, both times for the same reason and neither time because the code
  moved: a sabotage measured before a test was hardened, and then not measured
  again. Giving a pipe the laid-out form and colour was fourteen before the
  `awk -F:` tests grew their count assertion and is eighteen now; giving a terminal
  the piped form was six before the build-path test grew its `wrapped()` guard and
  is seven. A number in this file that only a re-run can confirm is the stale
  snapshot this entry was written against, arriving one level up -- so what is
  recorded is the shape. Making the piped diagnostics wrap is caught by the
  line counts. Colouring a pipe is caught by those and by the `awk -F:` shape,
  since a coloured location does not start with a file name. Giving a terminal the
  piped form is caught by the hanging indent, the two colour tests, the stacked
  case and both path tests. Dropping the location's column is caught by the
  differential -- and by the hanging-indent test, which cannot find a
  `file:line:column:` to measure from at all, so that one is not the differential
  doing its job however much it looks like it. Breaking a long word the way
  `paragraph()` does is caught by both path tests and both differentials. Writing
  CRLF is caught by the line counts and by the three tests that say a pipe gets a
  bare newline. Two are worth a number because the number _is_ the claim: the
  historical parenthetical fails exactly one assertion, and keying the layout on the
  colour level rather than on `isTTY` fails exactly two -- the `FORCE_COLOR` test
  and the `NO_COLOR` one, which are the two halves of that rule and nothing else.

  **A third vacuity is the build rather than the test, and nothing checks it,
  which is a decision that cost two attempts.** These spawn `dist/sigil.mjs`, so an
  edit to `src/` that has not been rebuilt is asserted against the previous binary:
  `isTerminal()` changed to return `false` with no rebuild passes every one of
  them, and the same edit rebuilt fails. A missing `dist/` is loud -- `existsSync`
  says so and names the build -- while a _stale_ one is silent, which is worse, and
  silent in exactly the loop somebody works in, since `pnpm test` builds first and a
  bare `pnpm vitest run` on one file does not.

  Two proxies for it were written and both fired on correct code. **mtimes** --
  every output against every input, directories counted so a deleted source file is
  not invisible -- fail in a way `pnpm build` cannot clear: a source file's
  timestamp moves without its content changing on a branch switch, a
  `git stash pop`, a revert or a `cp` restore, turbo's hash is then unchanged, so
  the rebuild the message asks for is a cache hit that does not touch `dist/` at
  all, the mtimes never move, and the failure is unsatisfiable. Measured on a
  pristine tree. **Turbo's own hash** is content-based and authoritative, and
  `turbo run build --dry-run=json` is the way to ask it -- and it is still worse
  here, though for one reason now rather than two. The reason that is **gone** was
  the better of the two and is worth keeping written down, because it was a defect
  and not a property: that hash used to move for _any_ modified file in the
  workspace rather than only the task's declared `inputs`, so appending a comment to
  `test/output-forms.test.ts` flipped both `@ttylabs/cli#build` and
  `@ttylabs/sigil#build` from HIT to MISS with `src/` untouched -- the guard would
  have failed for whoever was editing the test, the one situation it runs in most.
  That was the root manifest's `workspace:` dependencies putting every file of both
  packages in turbo's global hash, it is fixed, and the entry under "## Layout"
  records it; a test edit is a cache hit now. The reason that **remains** is enough
  on its own: turbo says MISS after `node src/sigil.ts build`, which is the
  package's own build command and the one to reach for while working on the
  toolchain, because turbo only records what turbo ran -- re-measured, and it
  reports `MISS` over a `dist/` that is freshly and correctly built. Combining the
  two does not rescue either, since that is the same build both of them misread.

  So there is no proxy here that is both satisfiable and quiet on correct code, and
  a check that fires on correct code teaches people to ignore checks -- which this
  file would have been teaching about itself. What actually guarantees a fresh
  `dist/` is the `test` script building first, and the rule this file already
  records: `@ttylabs/cli` needs a build before its tests mean anything, which is
  true of `commands.test.ts` and the demos as well and is answered there the same
  way. The residual hazard is written into the test rather than guarded, and every
  sabotage recorded above was run with a rebuild in between for exactly that
  reason. Worth knowing what the abandoned version got right on its way out, since
  it is the shape anybody trying again will reach for: the floor has to be the
  _oldest_ thing the build wrote, because `dist/sigil.mjs` is a 1.2 kB loader and
  the code these tests are about is in `dist/chunks/report-*.mjs` -- so comparing
  the entry alone let a corrupted chunk with a touched entry pass while failing most
  of the tests under it.

- **The terminal is a spawned child that answers `isTTY`, not a pty.** Node has
  no pty and this repo has no pty dependency; taking one to read a boolean back is
  the kind of decision `the toolchain's dependencies` exists to make deliberate.
  What `report.ts` reads about a destination is `stream.isTTY` and
  `stream.columns` and nothing else -- `ReportStream` is those two fields -- so
  the child is the real binary with real pipes, preloaded with a module that
  defines `isTTY` on its own streams, and `COLUMNS` says the width, which is what
  `terminalWidth()` documents it for. `defineProperty` rather than an assignment,
  because a piped `process.stdout` is not a `tty.WriteStream` and what it does
  with a write to a property it never declared is not a thing to depend on; a
  `data:` URL rather than a file, so the source of the fake sits beside the test
  that explains it. Everything `supportsColor()` reads is cleared out of the
  child's environment first, because `CI` and `GITHUB_ACTIONS` are set on nine of
  the places this runs and either decides the level for a destination claiming to
  be a TTY -- a test that left them alone would assert a different colour on a
  laptop than in CI. What the fake does not prove is that node reports `isTTY`
  correctly for a real pty, which is node's claim rather than this repo's, and it
  says nothing about terminal modes -- `report.ts` writes plain lines and sets
  none. `scripts/terminal-probe.mjs` is where a claim only a real terminal can
  falsify belongs, and none of these is one. The fake is itself sabotage-checked,
  for the reason the tests are: a preload that does nothing fails every test that
  is about the laid-out form, so it is load-bearing rather than decoration. The
  `NO_COLOR` test is among them only because it grew a "did this really lay out"
  guard of its own -- with no terminal at all, both sides of its comparison are the
  piped form and it passed while saying nothing.
- **A width a report is laid out in is not a length to assert, because the
  checkout's own path is in it.** The does-not-break-a-path test first asserted
  that the line holding the `baseDir` warning's absolute path was _wider than the
  terminal_, which is the overflow those two entries describe and is also a
  statement about where the repository happens to be: the line is the 24-column
  hanging indent plus the path, so a fixture path of 56 characters or fewer -- a
  checkout at `/code/sigil` -- fails it on a build with nothing wrong. Measured
  against copies of the fixture at 55, 56 and 57 characters rather than reasoned
  about. The claim it was reaching for needs no width at all: a path that was
  broken appears whole on no line, and one `text-overflow` cut appears on none
  either, so "whole, on exactly one line" is the whole of it. The one place a width
  _is_ asserted is `build`'s output path, where the temp directory is named long on
  purpose -- which is the difference between a number that holds by construction
  and one that holds by luck. Except that it did not hold there either, and the
  second measurement is the one that says so: the summary reports that path
  _relative to the app_, so a `TMPDIR` inside the fixture brings it to 72 columns
  and the long name buys nothing. Both width assertions are gone, and what is left
  is the claim in both places -- whole, on one line.
- **A pipe gets a bare newline, and that is asserted rather than tolerated.** The
  first version of this file stripped a trailing `\r` on the way in, on the theory
  that a line ending is not what these tests are about. It is: a `\r` on the last
  field is exactly what `awk -F:` hands back to whoever is reading it, and the
  plain-text path already records that a carriage return in a log file is not a line
  ending anybody asked for. A strip would have let a switch to CRLF stay green --
  measured, all of them passed with `report.ts` writing `\r\n` -- where asserting
  its absence catches it in the line counts as well as in the three tests named for
  it. The same shape as a property the engine ignores:
  tolerating something quietly is worse than saying what is meant.
- **The differential's own path handling was the Conventions entry about Windows
  fixtures, committed verbatim.** It took the absolute output directory back out of
  both summaries -- `words(text).replaceAll(dir, '<out>')` -- and `dir` is what
  `mkdtempSync()` returned, which on Windows is backslashed, while the summary
  reports that path through `displayPath()`, which forward-slashes it. Across
  drives it is worse: the runner's checkout is on `D:` and its temp directory on
  `C:`, so `relative()` hands back an absolute path and the two spellings never
  meet at all. The replacement matched nothing, the two `mkdtemp` suffixes
  survived, and the two builds' summaries differed by exactly them -- one test, on
  all three Windows jobs, on both of the first two commits, and on no other
  platform. That is the entry already written down twice over: a fixture for
  platform-dependent behaviour is written with the same function the subject uses,
  and an expectation built with `join()` is backslashed on Windows and nowhere
  else. Keyed on the directory's _name_ now, which is a token neither spelling can
  disagree about. Worth knowing that a review round found the same line by a
  different route -- a `TMPDIR` under the fixture -- which is two ways of saying
  that a test must not spell a path a second time.
- **`NO_COLOR` on a terminal is laid out and not coloured, which is the half of the
  rule that had no test.** The `FORCE_COLOR` entry below says that keying the
  laid-out form on the colour level instead would make `NO_COLOR` unwrap every
  diagnostic, and the test for the tidy-up being wrong only ever came at it from the
  `FORCE_COLOR` side. So a terminal run with `NO_COLOR` set has to be
  `strip()` of the ordinary laid-out run, exactly -- same wrapping, no sequences.
  With that, the two halves of "layout follows `isTTY`, colour follows the level"
  each have an assertion, and the tidy-up fails two rather than one.
- **The report asks the stream it is going to, and that is not the process.**
  Diagnostics and summaries go to stderr while `--tree` and the chunk sizes go to
  stdout, so that a tree can be piped without losing the problems -- and those
  are two destinations. `supportsColor()` defaults to `process.stdout` whoever is
  asking, so `sigil check 2>log.txt` from a terminal is a stdout that takes
  colour and a stderr that does not, and a report reaching for the process's own
  styler would fill that file with sequences while being perfectly right about
  the wrong stream. Nothing was wrong before this, because the diagnostics
  carried no colour to put anywhere; colouring them is what makes the rule
  load-bearing, which is why the tables were given an explicit
  `reportLevel(process.stdout)` too. They were right by luck, and right by luck
  is what stops being right when something moves. The width is the same question
  and gets the same answer. `env` is threaded beside the stream because the
  stream is only half of it -- `FORCE_COLOR`, `NO_COLOR`, `TERM` and `COLUMNS`
  all outrank what the stream says, and it is the only way a test can ask about a
  terminal at all, since a vitest worker's stderr is a pipe with no `TERM` behind
  it.
- **`FORCE_COLOR` into a pipe colours the tables and not the diagnostics, and
  that is a consequence rather than an oversight.** The two knobs are
  independent on purpose -- layout follows `isTTY`, colour follows the level --
  so `FORCE_COLOR=3 sigil check --tree | cat` is a coloured table on stdout and
  plain one-line diagnostics on stderr. Measured: two escapes on stdout, none on
  stderr -- and pinned now by `should colour the tree and not the diagnostics
  under FORCE_COLOR`, because an entry saying "do not fix this" is worth less than
  a test that fails when somebody does. It is what `main` did too, since the diagnostics carried no colour at
  all there and the table has always read the process styler, so nothing
  regressed -- and the obvious tidy-up is the one that must not be taken. Keying
  the pretty form on the colour _level_ instead would make `FORCE_COLOR`
  consistent and would make `NO_COLOR` on a real terminal unwrap every
  diagnostic, which is reading one setting as though it were another. The other
  way round -- rendering the one-line form through the cascade so it can be
  coloured -- costs the byte-for-byte promise above for a colour nobody has ever
  had here. So it stays, written down, rather than fixed into something worse.
- **Every prose path in a report is a wrapping row of `nowrap` words, because a
  report's words are mostly paths.** `paragraph()` gives each word `min-width: 0` **on purpose**, so that
  a word too long for the line is broken rather than left to run off the edge --
  that is what `wrap()` does, and a paragraph disagreeing with the wrapper is a
  help screen wider than the terminal. It is the wrong answer for a summary: at 80
  columns a long skip path came out as `.../packages/cli/t` then
  `est/fixtures/app,`, broken mid-token, and `build`'s `into <bin>` does the same
  once that path is long enough. This file already says a path is not prose and
  that wrapping one breaks the thing somebody copies -- that sentence was written
  for `sigil add`'s file list and it covers these two lines as well. So each word
  keeps its automatic minimum, which for a one-word text is the whole of it: the
  row wraps _between_ words and never inside one, and a word longer than the
  terminal overflows the way the location prefix and help's own labels do. `main`
  printed both as one line on a terminal, because nothing wrapped them at all.

  Fixing it for the summary alone was half a fix, and the half left behind was the
  one a user reads first: a **message** embeds a path as readily as a summary
  does. `index.ts:1:35: warning: "commands" is a relative path ...` names the
  directory each side would resolve against, and at 80 columns that path came out
  as `.../test/fixture` then `s/typecheck/broken` -- broken mid-token in the one
  sentence whose whole job is to say which directory. Found by running the repo's
  own `typecheck/broken` fixture while writing down how to test the change by
  hand, which is the argument for doing that at all: the suite renders at the
  fallback width with no terminal, so it had nothing to say about it. So there is
  one `wordsView()` and `paragraph()` is no longer used here at all. The cost is
  that a single word longer than the line overflows instead of being broken, which
  is the right trade when the words are paths and is why a test that had used
  `'x'.repeat(200)` to measure the prefix now uses real ones.

- **Prose wraps whatever the destination is, which is the other half of the rule
  above.** A diagnostic is a record -- something greps it, something jumps to it
  -- so off a terminal it stays on one line. A note is a paragraph somebody reads,
  and `sigil add | less` is still somebody reading it, so the answer there is the
  fallback width rather than one endless line. `writeNote()` is what `sigil add`'s
  three blocks of prose go through now; they were broken at about seventy columns
  once, by hand, which is ragged at forty and needlessly narrow at two hundred,
  and that is what a paragraph was always for. The file list beside them is left
  alone: a path is not prose, and wrapping one would break the thing somebody
  copies out of it.
- **The toolchain's classes are its own, at origin `app`.** `cli-*` rather than
  `sigil-*`: the toolchain is an app, it draws nothing a theme is expected to
  restyle, and it has no business in the vocabulary `FRAMEWORK_CSS` documents.
  The sheet is parsed at origin `app`, which is the later origin, so it beats the
  framework's defaults with an ordinary rule and no `!important` -- and that an
  app sheet can do that is the thing worth proving here rather than asserting.
  It sets colours and attributes only, which is the rule the framework sheet
  keeps for itself and which `test/report.test.ts` pins: geometry stays in props
  where the code that worked it out can see it, and `box-sizing: border-box`
  means a `padding-left` from a sheet is taken _out of_ a width the report
  measured.
- **`render()` takes a builder rather than a tree, because the width is one
  number two things have to agree about.** A diagnostic's message column is a
  _declared_ width, so the caller subtracts from the width it believes the report
  is laid out in while `renderToString()` lays it out in the width `render()`
  works out -- two computations of one number, which is the shape this file
  records over and over as how the two come to disagree. And they can:
  `terminalWidth()` caps at `MAX_WIDTH`, so a caller taking `stream.columns` for
  its width declared a message column for a 200-column terminal inside a grid
  laid out for 100, and since the grid grows to its content what came out was a
  **200-column line** -- nothing truncated, the terminal wrapping it raggedly,
  and nothing to say so. Not reachable from either command, which both asked
  `terminalWidth()`; reachable from the tests, which asked `stream.columns`, and
  from any caller who did the obvious thing. Passing the width _to_ the builder
  makes it unrepresentable rather than a rule to remember, and the type error at
  every call site is what that buys. The width is normalized the way
  `renderToString()` normalizes it, or the builder is handed a number one
  rounding away from the one it is laid out in.
- **A location wider than the terminal keeps its own width, and that is the one
  place a report is deliberately too wide.** The prefix is `nowrap` with no
  declared width, so at a narrow terminal it overflows and the terminal wraps it:
  `a/b/c.ts:1:2: warning:` is 22 columns in a 20-column terminal. That is help's
  own rule for a label -- the grid a string is painted into is as wide as what
  came out, so a name longer than the terminal survives -- and the alternative is
  worse than untidy: `text-overflow` is honoured now, so a bounded prefix would
  be _cut_, and a truncated `file:line:column` is a location nothing can jump to.
  It looks like the width arithmetic failing and is the opposite, which is why it
  is pinned by a test of its own rather than left for somebody to "fix". Wide
  characters really are handled: a CJK path, an emoji message and a combining
  mark all fit, because every measurement goes through `stringWidth()`.
- **The report's tests assert SGR parameters rather than bytes, and strip with
  the library's own `strip()`.** A transition combines what it closes with what it
  opens, so green after bold is `ESC[22;32m` and never `ESC[32m` -- a test
  pinning the latter pins one implementation of the transition rather than the
  claim that something was drawn green, which is the rule the canvas diff's own
  tests already follow. The pattern that reads the parameters back is built from
  the exported `ESC` rather than written as an escape in a character class, which
  is this repo's rule twice over: no raw control character in source, and no
  `no-control-regex` suppression for a formatter to detach from the line it was
  written over. They are asserted against `report.ts` directly rather than
  through `run()`, because a vitest worker's stderr has no `columns` and no
  `isTTY` -- so every render through the CLI comes out at the fallback width with
  no colour, which is the one case that cannot fail. `ReportStream` is an
  interface for exactly that reason. Which is also why it cannot be the whole
  answer, and `output-forms.test.ts` is the other half: what a user's terminal
  gets is what the _binary_ writes, and reaching that means a spawned child rather
  than an interface satisfied in-process.

#### There is no live display in the toolchain, and that is measured

SIG-78 asked whether "a scrolling log with progress underneath" works on the
inline canvas, which is the case the canvas ticket was parked over. The
toolchain turns out **not to be that case**, and the discipline is the one the
build measurement already set: a live progress display for a 180ms build would
be theatre, so measure before writing any of it. Every candidate was measured,
and all three say no.

- **`sigil build` is too fast.** 286ms for five hundred commands, and the read
  passes plus the type check are 140ms on this package. There is nothing to
  animate.
- **The type check is too fast, which is TypeScript 7's doing.** It is the one
  step that spawns a compiler, and the native port answers in 97ms here and
  364ms on a fresh scaffold -- most of the second number being process startup.
  This was the best remaining candidate on the theory that a compiler takes
  seconds, and the theory was two major versions out of date.
- **`sigil new`'s install is the instructive refusal.** It was the chosen
  candidate -- the only command where a user waits, and a package manager's
  output is exactly the scrolling log the ticket describes. It fails in both
  directions at once. **Piped**, the manager detects no TTY and says _nothing at
  all_ until it has finished: npm's four lines of output all arrived at 3907ms of
  a 3928ms run, and pnpm's first chunk at 27ms is followed by silence until
  671ms. There is no log to scroll and no progress to report, so a bar there
  would be reporting a number it invented. **Given a TTY** it is worse: pnpm
  drives the cursor itself, writing `ESC[1A` and an erase-display to repaint its
  own progress -- measured off a pty, 21 carriage returns and 82 escapes for a
  fourteen-package install. That is precisely the "write above the region" that
  makes an inline canvas throw its anchor away, and the anchor is the whole of
  how a canvas knows where its top is. The manager already owns a live region;
  a canvas underneath it would be painting into rows something else is moving.

So `stdio: 'inherit'` is the right answer for an install -- the manager's own
progress, unmediated -- and the toolchain renders text. That is a **finding**
rather than a gap: the question the ticket asked has an answer, and the answer
is that this toolchain is not where a live region earns its keep. What would be
is a command that owns its terminal for seconds and knows its own progress, and
none of these three is that. The measurement scripts are worth re-running before
anybody revisits it, because two of the three numbers are facts about other
people's software and will move.

### `sigil new`

- **The scaffold's `tsconfig.json` is not boilerplate.** `lib: ["esnext"]` and
  `types: ["node"]` are load-bearing: without them `lib.dom` is included, which
  declares `setInterval(): number` and shadows node's `NodeJS.Timeout`, so an
  ejected spinner fails to compile with `Property 'unref' does not exist on type
  'number'` -- on a component whose source already writes `timer.unref?.()`.
  Nothing about the component is wrong and nothing about it can fix it. Found by
  ejecting into a bare app and type-checking it.
- **`jsx` and `jsxImportSource` are the same kind of line, and they were
  missing.** JSX is the canonical syntax for a template here, and an app that
  wrote its first `.tsx` got TS17004 -- "Cannot use JSX unless the `--jsx` flag is
  provided" -- from its editor and from `sigil build`'s own type check. Adding
  `jsx` alone moves it to TS2875 -- "This JSX tag requires the module path
  `react/jsx-runtime` to exist" -- naming a package a sigil app does not depend
  on, so it is the pair or neither. Both were run against a scaffolded app rather
  than recalled. What they buy on top of the
  build already supplying the same import source to the bundler is _agreement_:
  the editor, the app's `tsc` and the build all say `@ttylabs/sigil`, rather than
  the build being right on its own. A JavaScript app still gets no tsconfig at
  all, which is why the build supplies the import source rather than defaulting
  to what one says.
- **An entry exports a schema and something else runs it, so a scaffold writes
  two files.** `sigil build` _parses_ the entry rather than importing it, because
  importing would run the app -- so the entry can only be a module whose default
  export is the schema. That leaves nothing to start it, which is what `dev.ts`
  is. A single module doing both would need `import.meta.main`, which is node 24
  where the floor here is 22.19. The dev runner is deliberately not `src/cli.ts`:
  `cli` is one of the names discovery looks for, and a second entry candidate
  beside the real one is an ambiguity waiting for somebody to delete the wrong
  file.
- **There was a `--link`, and publishing is what removed it.** It pointed a
  scaffolded app at the checkout this toolchain was resolved from, because a
  scaffold that wrote the real version range produced an app that could not
  install while these packages were unpublished. It was always "one line to
  delete on the day the package ships", and a local path in a dependency is the
  kind of thing that keeps working right up until somebody commits it -- so it
  went with the publish rather than staying on as an escape hatch. What it cost
  on the way out is worth keeping: it was **broken**, and only a by-hand install
  could have shown that, since `new.test.ts` deliberately does not install. A
  checkout's packages declare `@ttylabs/sigil` as `workspace:*` between
  themselves, so a manager that installs a local path by _resolving_ its
  dependencies meets a protocol with no workspace to resolve it in, while one
  that _symlinks_ never asks. pnpm's `link:` symlinks and its `file:` resolves;
  npm has no `link:` at all. Exactly opposite -- which is the shape to expect
  from any future "use what is on this machine" flag.
- **A scaffold never names a tool it does not install, and the check for that is
  in the generator.** The linter versions were read off this repository and
  `oxlint` is a devDependency of the _workspace root_ rather than of
  `@ttylabs/cli`, so the lookup answered `undefined`, `JSON.stringify` dropped
  the key, and the app got a `lint` script for a tool nothing installed --
  silently, because a missing JSON value is indistinguishable from one nobody
  wrote. The versions are written down in the scaffold now, as carets rather than
  pins: these are tools whose releases this repository does not track, and
  pinning one hands out whatever was current the day it was written. The app's
  own lockfile is what pins them.
- **Where it goes and what it is called are two questions, so they are two
  inputs.** The argument is validated as an npm package name -- it is the app's
  name and its `bin` as well as its directory -- so it can never hold a
  separator, which made `sigil new ~/projects/my-cli` an error rather than a
  location. It also left an `isAbsolute(name)` branch that could not be reached,
  because the name check runs first and refuses every absolute path: a branch
  that reads as support for a feature and cannot run is the same failure a
  property the layout engine ignores is, one layer along. `--cwd` is the other
  question and the branch is gone. The argument is `[project-name]` rather than
  `[name]` for the same reason -- `name` reads as though a path would do.
- **`--cwd` expands a `~` and does not have to exist.** A tilde only reaches a
  process when the shell did not eat it, which is `--cwd "~/projects"` -- and
  `resolve()` alone would make a directory _called_ `~`, which is the failure
  `paths.ts` already carries an entry for, met from the one place a user hands
  this tool a path to write into. So it goes through `expand()`, the runtime's
  own, rather than a second spelling of it. It is not required to exist because
  the scaffold makes each file's directory as it goes, so naming somewhere new
  is `mkdir -p` rather than an error. The test points `HOME` at a temp directory
  rather than writing to a real one.
- **It asks about what changes the files and works out the rest.** The name, the
  language, and one command versus several have no defensible default for a
  project that does not exist; a linter is a preference and a config file nobody
  enjoys writing twice. Git is just done.
- **Which package manager is a question about the machine, and it used to be
  answered by asking the wrong thing.** It read `npm_config_user_agent`, on the
  argument that a question whose answer is already on the table is not worth
  asking -- and the answer was on the table less often than that assumed. The
  variable is set by the package manager that _invoked_ the process, so running
  the toolchain directly, which is the dev loop and every global install, sets
  nothing at all and the scaffold silently said `npm` to somebody who has not
  used it in years. What _is_ knowable is which ones are installed, which is
  what SIG-48's `which` is for: one installed is not a question, several is a
  real preference that nothing here can infer, and none means a `PATH` this
  cannot see rather than a machine with no package manager on it -- so it says
  `npm`, which ships with node, rather than refusing to finish a scaffold that
  is already written. pnpm is preselected because it is the one somebody went
  and installed on purpose. `--pm` beats all of it, which is also what makes the
  rule testable: the suite owns `PATH` and hands the command a directory of
  fakes, because asking the machine would make the answer depend on what happens
  to be installed on it -- different on every laptop and on each of CI's nine
  combinations.
- **`new` writes without confirming, and `add` does not, because they are not
  the same risk.** `add` puts somebody else's code into a source tree somebody
  already owns, and the file it would overwrite is by construction one they
  edited -- so it prints a plan and stops. `new` writes into a directory it has
  already refused to touch unless it is absent or empty, so there is nothing to
  lose and nothing a listing could warn about: what it printed was a dozen paths
  under a name the user had just typed, followed by a question with one sensible
  answer. The asymmetry is the point rather than an inconsistency to iron out.
- **Removing the listing took the destination with it, which is the half worth
  knowing.** It was the only thing printing where the project went, and the
  closing `cd <name>` had been wrong since `--cwd` existed -- it is the _name_,
  not a path, so `--cwd apps` told the user to `cd demo` from a directory with no
  `demo` in it. The summary names the directory in full and the `cd` is
  `relative()` from the working directory, so it is `cd demo` in the ordinary
  case and `cd apps/demo` under a `--cwd`. Both go through `displayPath`, which
  is what makes them forward-slashed on Windows -- and is what a test asserting
  a `join()`ed path would get wrong there and nowhere else.
- **A `sigil.json` is written rather than left to the convention.** A scaffold is
  exactly where a project's conventions should be explicit, and it is what stops
  `sigil add` having to guess -- and then print the guess, which is what it does
  when there is no config.

### The registry: what `sigil add` copies

- **`sigil add` is an eject, not an install, and that is the divergence from
  shadcn worth stating.** There, nothing is installed and copying is the only
  way to get anything. Here the components ship in `@ttylabs/sigil/components`
  and work with no toolchain involved, so nobody needs `add` to use a spinner.
  The ladder is: theme it with a class, which covers colour and attributes and
  keeps upgrades; override a prop at the call site for one-off geometry; eject
  it when the _structure or behaviour_ has to change, which the cascade cannot
  reach. Only the third costs the component's upgrades.
- **The registry ships in the runtime rather than in the toolchain.** An app
  depends on `@ttylabs/sigil` at an exact version, so the source it ejects
  always matches the API it is ejected from. `@ttylabs/cli` is a devDependency
  on its own version line, and a copy of `spinner.ts` there could be a release
  ahead of the runtime the app actually imports -- which is a component that
  compiles against nothing the app has.
- **The package has to carry sources, because `dist` is not one.** `files` was
  `["dist"]`, so the published package contained no component source at all and
  `add` had nothing to copy. `dist` cannot stand in for it: it is bundled,
  minified, and chunked by something other than module boundaries, so there is
  no `spinner.mjs` in it -- and if there were, minified output is not a thing
  anybody wants in their source tree. `registry/` is generated by
  `packages/sigil/scripts/generate-registry.mjs` during the build, shipped, and
  _not_ committed: it is derived from `src/components/` in full, so a committed
  copy would be a second spelling of those files with nothing keeping the two in
  agreement.
- **The import rewrite does not depend on where the file lands, which is what
  lets it happen at build time.** `../element/index.js` becomes
  `@ttylabs/sigil/element`, read off the tsdown entry map -- the mapping this
  package already writes down twice and `test/exports.test.ts` already keeps in
  agreement. A _sibling_ import goes to `@ttylabs/sigil/components` rather than
  to a copy of the sibling, so ejecting a spinner does not drag `mount.ts` along:
  what those siblings export is public API, and the point of ejecting is to own
  the component rather than the plumbing under it. Both halves together mean
  what ships is byte for byte what lands in the app, so **`add` is a copy anybody
  can audit rather than a transform they have to trust** -- and the generator
  fails the build if a relative specifier survives or an entry imports something
  no published subpath answers for.
- **No seed entry has a `registryDep`, and the field exists anyway.** Every
  import a built-in makes is answered by a published subpath, so there is no
  file to drag along -- which means that machinery ships exercised by nothing in
  this repo. It is in the manifest because a third-party registry will have
  them, and a shape that only describes the easy case is one somebody else
  discovers to be wrong.
- **`add` resolves the registry from the app, never from the toolchain.** That
  is the other half of shipping it in the runtime: `@ttylabs/cli` is a
  devDependency on its own version line, so reading a registry out of its
  dependencies would eject a component a release ahead of what the app imports.
  Resolution goes through the package's `package.json` subpath, which every
  package publishes and which answers wherever the files actually live --
  resolving the package's _main_ would import it, which is a registry running
  code in order to be read.
- **The plan is worked out before anything is written, and the showing and the
  doing read the same one.** `add` puts code from somebody else's package into a
  source tree, so what it will write is printed first. Two walks that agree for
  now is how the printed plan and the written files come to differ, so there is
  one `planAdd()` and `apply()` only writes what it is handed.
- **A file already there stops the run rather than being overwritten.** `--force`
  is the way past it and the message says so, because the thing being overwritten
  is by construction a file somebody edited -- that is what ejecting is for.
- **`add` with nothing named lists, and the listing argues against itself.** "What
  can I add" is the question somebody has at that moment, and an empty usage line
  does not answer it. What the listing says is that most customization needs no
  copy: a built-in is restyled with an ordinary rule against the classes it draws
  with. The same note is printed at the moment of ejecting, naming the classes
  that entry draws with -- a tool that leads with copying teaches people to fork
  what they could have themed.
- **One registry per call.** Two in one plan means two `registryDeps` namespaces,
  and a dep that resolves in one and not the other is a failure nobody could
  read. Refused with the instruction rather than resolved by guessing which
  namespace a name belongs to.
- **A missing entry the user typed is their typo; a missing `registryDep` is the
  registry's bug.** They are reported differently and deliberately: the first
  lists what the registry does have, and the second says the registry is wrong,
  because the user never typed that name and telling them it is unavailable
  would be blaming them for somebody else's manifest.
- **`sigil add` copies TypeScript, whatever the app is written in, and that is a
  deferral rather than an answer.** Emitting JavaScript means stripping types,
  and neither `oxc-parser` nor `rolldown` -- the two the toolchain already has --
  transforms. Taking a dependency for it is a decision worth making on purpose
  rather than as a side effect of a file copy, and it is affordable to wait
  because `engines` requires node >=22.19.0, where type stripping is on by
  default: a `.ts` component runs in a JavaScript app with nothing compiling it,
  which is the rule a command module already follows. What it costs is an app
  whose own tooling is JavaScript-only, and that is the case to revisit it for.
- **An entry is one file, not one export.** `prompt.ts` holds all five prompts,
  and splitting it into five entries means splitting the source -- a refactor of
  the runtime rather than a decision about a registry. `index.ts`, `mount.ts`
  and `keys.ts` are not entries at all: they are the barrel and the plumbing,
  and what is listed is what somebody would want to _edit_.
- **An entry lists the classes it draws with, so the rule it has to keep is
  checkable.** A component styles itself with classes and never with colour
  props, because a prop beats a sheet per property and a colour written into a
  template is one a theme cannot reach without `!important`. The manifest naming
  them is what tells whoever copied the component in what they may restyle, and
  is what a lint over third-party entries would read.
- **An app that ejects needs `lib: ["esnext"]` and `types: ["node"]`, and that
  is a constraint on what `sigil new` scaffolds.** Found by ejecting into a bare
  app and type-checking it: `lib.dom` declares `setInterval(): number`, which
  shadows Node's `NodeJS.Timeout`, so `spinner.ts` failed with
  `Property 'unref' does not exist on type 'number'` -- on a component whose
  source already writes `timer.unref?.()`. Nothing about the component is wrong
  and nothing about it can fix it. Left undiscovered it would have surfaced as a
  confusing bug report from the first person to run `sigil add spinner`.
- **The drift check compares the shipped entry against the component, with only
  the specifier blanked.** Not by dropping import lines: the imported _names_ are
  compared too, and an import may span several lines -- `table.ts` has one, which
  is what caught the first version of this doing it by line. A registry entry is
  `src/components/<name>.ts` with its imports rewritten and nothing else changed,
  so an entry that has quietly become a stale fork fails in
  `test/registry.test.ts` rather than shipping.

### A markdown command reference, and a surface snapshot

`oclif readme` writes a whole command reference into an app's README on publish
and Salesforce generates a doc site from it; sigil generated a help _screen_ and
nothing that outlived the process. The sharper half is
`@oclif/plugin-command-snapshot`, which commits the command surface as JSON so
that a pull request renaming a flag **fails** rather than silently breaking
everybody's scripts. `src/reference/surface.ts` in the runtime is the walk,
`packages/cli/src/reference/` is the two printers, and `sigil reference` is the
command.

#### Where the surface comes from, which the ticket did not ask and which decides everything else

The ticket read as "the extraction is done" -- the build already walks the tree
and `commandCatalog()` already reads the registries -- and those are two
different sources. Measured on this repository's own tree: `ResolvedCommand`
carries `name`, `desc`, `hidden`, `kind` and `module` and **no options and no
arguments**, because nothing lifts an option out of source. So a reference
printed from the build's static walk would be a usage line and a subcommand
list and nothing else.

Which is the question `completionSpec()` already answered, in the same words:
generating from the **live initialized registries** has neither problem, and the
module loading is the cost to pay for it. So this is that answer again, and the
rest of the design falls out of it -- what remained was who imports the app.

#### `commandSurface(schema)` is a published subpath, and the toolchain never sees `Internal`

`@ttylabs/sigil/reference` exports one function: a `Schema` in, plain data out.
Three reasons, and the first is the one that is not a preference.

**`Internal` is a module-private `Symbol()`**, so two copies of the runtime
cannot read each other's internals. A design that handed an _initialized
command_ across the package boundary would break the moment an app pinned a
different `@ttylabs/sigil` -- silently, as an empty reference, which is the worst
class there is. What crosses here is a plain object: an entry exports a schema
(or a function returning one), `command()` is the identity function, so a
command module's declaration is plain data too. Nothing with a symbol on it is
ever handed over.

**The walk needs `loadCommand()`, which is not published and must not be.**
`initCommand` and `loadCommand` on the root barrel would pull the parse chunk
onto the root entry, which `should not load the parser to import the package`
refuses and a 20 kB ceiling would catch. A subpath puts them in a chunk nothing
else reaches. Measured at the time: the root entry was **7,518 B over 6
modules, unchanged** to the byte, and `reference.mjs` **31,215 B over 9
modules** -- reached only by something that imports it, which is the toolchain.
The second figure moved three times while this was being written -- twice by the
review rounds' own fixes and once by round 4's, after this paragraph had
recorded it -- so re-run the measurement rather than reading it here: the module
count is the shape worth knowing, the 20 kB ceiling in `dist.test.ts` is what
holds the root entry, and the subpath's own figure is held by nothing but this
sentence.

**And printing is toolchain work**, which is the rule the utility generator
records: reading `PROPERTIES` and parsing every declaration on the way out is
the toolchain's, and a few hundred rules of CSS is a string constant. Here the
walk is the runtime's because only the runtime can read a registry, and both
printers are `@ttylabs/cli`'s -- so no app pays a byte for a format it will
never print.

What the split leaves is one skew: the toolchain's runtime _interprets_ the
app's declaration, so an app whose runtime is newer and declares something this
one refuses fails here and works there. Loudly, naming the declaration, which is
the same exposure `readAppCommands()` already has. The shape if it ever matters
is `typecheck.ts`'s -- resolve the capability from the app -- and there is no
caller for that.

#### It is a third reader of the registries, and the differential is what keeps it one answer

`commandCatalog()`, `completionSpec()` and this one read the same registries for
three different questions, and none is derivable from either other. A catalog
answers _what can be selected and run_, so a namespace is noise and only
**required** options are listed. Completion answers _what can be typed_, so
`required` and `multiple` are irrelevant and the arguments' values are unioned
rather than kept per position. A reference answers _what does this program
accept_, which needs every option, each positional in its own place, and the
`required`/`multiple` neither of the others records.

So `should reach every command the completion spec reaches` is the differential,
which is the shape `should offer every command the catalog lists` already has.
What is _not_ re-derived is anything either already decides: `tokensFor()` and
the choice-token rule are **imported** from the completion spec, because "which
tokens reach this command" and "what can be typed for this choice" have one
right answer each. `declaredValues()` is that rule lifted out of `valuesFor()`
-- its first branch, with the two words a bare `bool` or `yesno` takes left
behind, because those belong to a menu and a reference records what the
declaration said.

#### Four decisions, and the fourth is the list

**One file or many: both, and the destination decides which.** Many is the
answer for a directory and one is the answer for a pipe, because a pipe has
nowhere to put many -- which is `completion`'s own shape, a script to stdout and
an install that writes files, rather than a refusal to choose. `--out` writes a
page per command plus an index, because that is what a docs site routes on and
the only shape that stays navigable past a dozen commands; with nowhere to put
anything, one document goes to stdout, which is what you pipe and what a README
injection would take. One printer with two layouts: `listed()` decides what a
reference _contains_ and `page()` decides what a page _says_, and the only thing
the two layouts answer differently is how a command is pointed at -- a parameter
rather than a second printer.

A document links **nowhere**, deliberately. An anchor is the obvious answer and
is renderer-specific: how a heading becomes a fragment is GitHub's own rule, and
a subtly wrong link goes nowhere, which is worse than a name that was never a
link.

**On by default: nothing is written unless asked, and `sigil.json` says where
rather than whether.** `sigil reference` with no destination prints and writes
nothing at all, so the worry the ticket named -- a build that writes files
nobody asked for -- never arises. `reference.out` and `reference.snapshot` are
top level rather than under `build`, for the reason `locale` is: `build` is
where the bundler knobs live. Both are relative to the **app** rather than to
the working directory, which is `components`' rule and matters more here: a
reference is a committed artifact, so an absolute path would be one machine's
answer written into a file every machine reads.

**`sigil build` does not write it, and that is the one place this diverges from
the ticket's own checklist.** Four reasons, the first decisive. The build
**parses** the app's entry rather than importing it, and that is not a rule
about surprise -- it is a rule about what a build is, recorded as the reason an
app which opens a connection at module scope does not do it during a build. An
opt-in key makes the surprise go away and does not make the build a different
kind of thing, which is what it would be; taking that inside a documentation
ticket is the shape this file refuses repeatedly. Then: a build writes into
`--out` and nothing else, where a reference lands in the source tree and would
make `git status` dirty after every build with no `clean()` to answer for it. It
would make a reference a built-app-only feature, where generating from the
registries is what makes it work in dev. And it couples a doc generation to a
bundle it has nothing to do with.

**The check fails whatever invoked it, and what this repository puts in front of
it is a test.** `sigil reference --check` compares and exits non-zero, so a CI
step is one line. Failing a _test_ is what this repository does with its own
committed artifacts -- `registry.test.ts` and the turbo hash assertions both
live there -- and `the committed command surface` is that, driven from **source**
rather than from `dist/`: a stale `dist/` is silent, so a test that spawned the
bundle would assert against a binary predating the edit under review, which is
the one failure a drift check cannot have.

#### What counts as a surface change, and what does not

Recorded in the snapshot: every argv path; every token that reaches it, which is
a command's name and its aliases; each option's long and short spellings;
whether an option takes a value, is required and is repeatable, and its data
type; each option's `choices`, spelled the way argv has to type them; the
environment variables an option reads; each positional's name, position,
requiredness, variadicity, type and `choices`; **the environment variables an
argument reads**, which were recorded nowhere until a review round measured
`ENTRY=x mycli` filling a positional; whether a command or an option is
`hidden`; which command is the `default` one a bare invocation runs; and whether
a path has a handler at all or is a namespace that only lists.

Every list in it is sorted **except the environment variables**, and that
exception is the distinction `ordered()` is for: `long`, `short` and `choices`
are sets, because a spelling reaches the option and a choice is accepted
whichever order the declaration wrote them in, so sorting them is what keeps the
snapshot from moving when nothing argv accepts has. `env` is an **ordered** list,
because `envValue()` answers with the first variable that is set -- so the order
is the precedence, and sorting it hid a real change.

The last two were absent and a review round found them. Both read as behaviour
and are not: a `default` command is dispatched when argv named none, so moving
the mark changes what `mycli` on its own means, and a namespace gaining a `run`
is a path that did nothing and now does something.

Not recorded: `desc`, on a command, an option or an argument; `examples`; an
option's help `group` and its value `hint`; an option's `default`; the
destination a value lands on in `argv`; and the version, the date and any path.

The line is **what argv accepts, not what the screen says**, which is the line
the ticket asked for. A reworded description must not fail a check, or nobody
can leave the check on. `default` is out for two reasons rather than one: it is
what the app _does_ rather than what argv _accepts_, and a computed one has no
stable serialization, so a `default: () => ...` would either move the snapshot on
every run or have to be called during a doc generation. What that gives up is
stated rather than implied: **nothing in the snapshot records whether an option
has a default**, so adding or removing one is invisible to the check. The first
version of this said `required` already records it, which is false -- `required`
says whether the option has to appear, and an optional option may have a default
or not. Found by review. `env` is **in**, which is the one addition the ticket did not
name: `PORT=3000 myapp` working is a contract a script relies on, and removing a
variable breaks it exactly as removing a spelling does.

**`hidden` is in it, and that is the one worth thinking about.** A hidden
command is not listed and is still **reachable**, so hiding one breaks nobody's
script today -- which argues for leaving it out -- and leaves a thing nothing
documents, which argues for the opposite. What settles it is that the check is
not "is this breaking?" but "**did the surface move without you saying so?**",
which is `registry.test.ts`'s own temperament: it fails on a _stale_ entry
rather than on a _wrong_ one. So the snapshot records `hidden` and the diff
shows it, and whether hiding is a breaking change is a question a reviewer
answers rather than one this tool guesses.

Which is also why there is no classifier. Direction is what decides breakage --
an alias **removed** breaks and one added does not, an option becoming
**required** breaks and becoming optional does not, a positional **losing** its
`...` breaks and gaining one does not -- and a tool that judged it would be a
second reader of what a surface is, wrong about half the cases. The check says
the surface moved; the diff says which way; the list above says which way is
which.

#### Three places the two readers deliberately disagree

The markdown and the snapshot read one surface, and each drops what the other
needs. Which is the design rather than a wart, and it is why the walk is
faithful: `commandSurface()` records `hidden`, every spelling and every
description, and each printer decides.

**A hidden command gets no page and is in the snapshot.** The sharpest of the
three, and the reason the surface records `hidden` rather than filtering on it.
A hidden command takes its subtree with it, for the reason the catalog records:
a listing that named a hidden command's children would have named the branch
anyway.

**A negated flag's positive spelling is printed nowhere and recorded.**
`--no-clean` also accepts `--clean`, and help deliberately leaves that off the
row because printing both reads as two options that mean opposite things while
the description describes one of them. A reference is a listing, so it follows.
The snapshot keeps both, because both resolve: dropping `--clean` from what argv
accepts would be a surface change, and hiding a row is not.

**Order is faithful in the surface and normalized in the snapshot.** Which
spelling a declaration wrote first is a fact about the declaration, so the walk
keeps declaration order and the markdown reads in it, while the snapshot sorts
the commands by path, the options by their spellings, and each option's own
spellings and environment variables -- so that changing the order a _reference_
reads in is not a change to the surface. The **arguments** are never sorted,
anywhere, because their order is their position and sorting them would hide the
one change a reader most needs to see.

#### The spellings are filtered through the registry, which the obvious reading gets wrong

`initOption()` puts a negated flag's positive spelling in its own `long` --
`--no-cheese` also lists `--cheese` -- and `OptionRegistry.add()` then gives
that spelling to the **valued** twin where there is one, with a `??=`. So a
declaration's own list over-reports, and a reference built from it would document
`--cheese` as reaching the off switch. The short half is the same rule with a
different cause and needs its own test: `#chars[alias] = key` is written with no
`??=`, so two options declaring `-c` means the **second** takes it. Measured both
ways. `registry.find(spelling) === opt` is the exact answer, which is
`tokensFor()`'s own trick one level down.

#### The front matter's values are JSON, and that is both at once

JSON is a subset of YAML, so a front matter whose values are JSON parses as YAML
for a site that wants one **and** is readable with `JSON.parse` by a site that
would rather not take a dependency to read three keys. What it buys is the thing
a hand-rolled `key: value` reader gets wrong: a description holding a colon, a
quote or a `#` is escaped by construction rather than by a rule somebody has to
remember. `title`, `path` as an array, and `description` where there is one.

**Which `oxfmt` would have destroyed, and that is why the artifacts are
excluded from it.** Measured: the formatter rewrites `title: "sigil new"` to
`title: 'sigil new'`, which is valid YAML and is **not** valid JSON -- so
`JSON.parse` refuses it and the contract the website reads these by is gone. It
also aligns the table pipes and collapses the snapshot's arrays, which are
cosmetic by comparison. A generated artifact has one writer; `ignorePatterns`
gains `packages/cli/command-surface.json` and `website/src/reference/**`, which
is the call `test/parser/fixtures/**` already got.

#### A bar is escaped in every cell, and the placeholder is why

A table row is split on its bars **before** anything inside it is parsed, so a
code span is no shelter -- and the value placeholder spells a `choices` list
with `|`, so `--lint [oxlint|eslint|biome|none]` added three columns to its own
row and shifted every cell after it. Found by reading a generated page rather
than by a test, which is why `should give every table row the columns its header
has` exists and why it counts only the bars that are **not** escaped: a counter
that split on every bar would agree with the bug. It counts the **rows** too,
because the column check alone cannot see the other way a cell breaks a table --
a review round's finding, below.

The escaping is `table()`'s, which is the one function that knows a cell sits
between columns. It was `cell()`'s and `code()`'s, and that put it in the wrong
place twice over: a code span built for a _heading_ went through `code()`, so a
program name holding a bar rendered a visible backslash. One reader of "a bar is
a column separator", in the function about columns -- and the header is
deliberately not escaped, since every header this module passes is one of its own
literals and a sabotage of that escape failed nothing.

Which is also why there is no `Values` column. The placeholder already carries
the choices, so a column for them would be the same fact twice -- and in every
table that has none it would be an empty column.

#### Nothing is ever deleted, which is the one place this parts from `--out`

A build owns its output directory: it created it, and `clean()` empties it. A
reference is written into a directory a docs site owns as well, where a
hand-written page sits beside the generated ones -- so a stale page is
**reported** and left, and a `--check` fails over it. Reporting costs the author
one `rm`; deleting costs them a file they wrote, and the guard that would make
deleting safe does not exist: `sigil build`'s own refusal is of the app root and
above, and a destination typed one directory wrong is below it.

Which forced a message per kind rather than one sentence with the kind
interpolated: `sigil reference` writes a missing or an out-of-date file and does
**not** remove a stale one, so telling a reader to run it over a left-over page
is an instruction that does nothing. That is the one shape of wrong message this
file keeps finding.

#### `--check` compares content rather than bytes, which is the CRLF trap answered

`.gitattributes` says `text=auto` and lists no `*.md`, so git checks a markdown
file out with CRLF on Windows while a reference is always written with LF. A byte
comparison would fail `--check` on all three Windows jobs over a tree with
nothing wrong with it, which is the fifth time this repository has been bitten by
that. So both sides are normalized -- which is the more honest question anyway,
since what a check is about is whether the _surface_ moved and a line ending is
not part of it.

Normalized at both readers rather than forced with `eol=lf` in
`.gitattributes`, which would fix this repository and not an app's -- and which
is a **global** turbo input, so editing it invalidates every task's hash for a
gain that is a quiet `git status` on one platform.

#### What it records is what the app declared

`help`, `completion`, `--help` and `--version` are added by `parse()`, so a
surface built by initializing the schema simply does not have them. That is the
answer rather than a filter: an app's snapshot should move when the app moves and
not when the framework does, and what the framework adds is the framework's to
document. It is also what makes the walk callable with no argv, which a generator
has none of.

Options are recorded **where they were declared** and not flattened down the
chain, although an ancestor's resolve at every command below it: recording the
chain would put a root option in every command's entry and make one declaration
N diffs. The inheritance is a fact about the parser rather than about any one
command, so the markdown says it once as prose on each page that has an ancestor
with options.

#### The website consumes it, which is what proves the shape is usable

`website/src/reference/` holds the generated pages, committed, and
`website/src/app/reference/` renders them: the directory is read, the front
matter is parsed with `JSON.parse` per value, the nav is built from `title` and
`path`, and the body goes through `react-markdown` with `remark-gfm`. GFM is not
optional there -- every argument and option list is a table, so without it they
render as paragraphs of pipes.

Committed rather than generated during `next build`, which is the call
`src/i18n/keys.ts` and `src/style/utilities.ts` already make: a generated file in
the tree is one a reviewer can read in the diff, a drift test is what keeps it
honest, and generating at build time would make the website's build depend on
importing the toolchain's own app. `website/turbo.json` already hashes `src/**`,
so the pages are an input without anything being added.

What it proved is worth more than that it renders. Two deps (`react-markdown`,
`remark-gfm`), **eight routes prerendered -- `/`, `/_not-found`, `/reference` and
one per command** -- and `build.html` holding **two real `<table>` elements over
twelve `<tr>`** between them. The first two figures were a route count and a row
count and both were wrong, which a review round caught by counting the source
rather than the build: a prerender includes `_not-found` and the `[slug]` pages
are one per command rather than per file, and a markdown table's `| --- |`
separator is not a row in the HTML. Re-count from `.next/server/app` rather than
reading them here.

`should be a page the website can read` asserts the contract from the package
that has tests, because a front matter the site cannot read is the failure mode a
renderer alone would not catch.

> Moved: _What the sabotage pass found, and the litter it left twice_, _What review round 1 found, and the two it was right about by the wrong reason_, _What review round 2 found, pointed at round 1's fixes and round 1's skipped list_, _What review round 3 found, pointed at round 2's fixes and round 2's skipped list_, _What review round 4 found, and the pattern across four of them_, _What CI found that four review rounds and five sabotage passes did not_, _What the PR review round found: the one string never cleaned_ — see [docs/history/a-markdown-command-reference-and-a-surface-snapshot.md](../../docs/history/a-markdown-command-reference-and-a-surface-snapshot.md).
