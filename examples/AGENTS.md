# `examples/` — deliberate decisions

These are the decisions about this directory. Claude Code loads this file when it
works with files here; other agents should read it before changing
anything in this area. The root `AGENTS.md` holds the rules that apply
everywhere and still applies in full.

## Deliberate decisions — do not "fix" these

### A gallery of full-screen apps, in both template syntaxes (SIG-275)

`demos/` shows one idea per file and wires every interactive one by hand, and
until this directory existed no file in the repository used JSX or the `ui` tag
outside a test fixture. `examples/` is where whole apps are written the way an
app author writes them: the TUI counterpart of shadcn's blocks. Both template
frontends are first-class, which was Chris's call: JSX compiled by a build, and
the `ui` tag run by plain `node`.

- **One workspace member per example.** Each has its own manifest declaring
  `@ttylabs/sigil` as `workspace:*`, so it resolves the package by name through
  the `exports` map the way an app outside the repository does -- which is
  `demos/`'s reason for being a member, and it keeps the **root** manifest free
  of workspace dependencies, which is what keeps turbo's global hash empty (root
  `AGENTS.md`, "`inputs` is half of a task hash"). Per example rather than one
  `examples/` member because an example is a unit somebody copies: its manifest
  is the app's manifest, a JSX example needs a build of its own and a `ui`-tag
  one needs none, and a shared member would make every example's build one
  build. `examples/*` in `pnpm-workspace.yaml` is the whole of the wiring.

- **The contract, which `packages/cli/test/examples.test.ts` reads.** An example
  is `examples/<name>/` with:

  | Path                    | What it is                                                                                                                                                                             |
  | ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
  | `package.json`          | `"name": "@ttylabs/example-<name>"`, `"private": true`, `"type": "module"`, `@ttylabs/sigil` as `workspace:*`                                                                          |
  | `src/root*.{tsx,ts,js}` | One per syntax: `root.tsx` for JSX, `root.ui.ts` (or `root.ts`/`root.js` in a `ui`-only example) for the tag. Each exports `App(): Element`, taking no props, and `stylesheet: string` |
  | `src/ui.{ts,js}`        | The entry Node runs unbuilt, when there is a `ui`-tag root; with `src/index.ts`, an entry is `process.exitCode = await runApp(App, { sheets: [stylesheet] }).exited`                   |
  | `bin`, `scripts.build`  | A JSX example only: `"build": "sigil build"` and exactly one `bin`, which is what it builds to                                                                                         |
  | `test/`                 | Tests of the example's own, which vitest picks up as a project named after the package                                                                                                 |

  `App` reaches the app it runs under through `useApp()`: `input` for the router
  and `exit()` to end it. Every example quits with `0` on `q` and with `130` on
  Ctrl-C, and both are `runApp()`'s own: `quitKey` is a fallback, so a text field
  that takes `q` keeps it (SIG-308). `hello` still binds `q` itself, which is
  redundant now and runs first; an example that needs `q` for something else
  passes `quitKey: false` where it calls `runApp()`. Piped,
  with no terminal on both ends, an entry is refused the way `runApp()` refuses:
  exit `1`, nothing on stdout, one line on stderr. There is no `src/start.*`,
  and the contract test fails if one comes back. `examples/system-monitor`
  (SIG-291) follows this contract too, as every example does.

- **The root module is `root`, never `app`, `main`, `cli` or `index`.** All four
  are names `sigil build` looks for an entry under (`ENTRY_NAMES` in
  `packages/cli/src/build/discover.ts`), and a second entry candidate beside the
  real one is the ambiguity `sigil new` already refuses to scaffold: delete
  `src/index.ts` and the build would quietly start bundling a component as an
  app. `src/ui.ts` is not a candidate either, for the same reason.

- **What the twins share lives in a module neither of them is.** `root.ui.ts`
  runs unbuilt, so a `.tsx` anywhere in its import graph is a module Node cannot
  load -- the first version imported `ITEMS` from `root.tsx` and failed exactly
  that way. `src/common.ts` holds the data and the stylesheet. `src/ui.ts`
  spells the schema out a second time for the same reason: `src/index.ts`
  imports `root.tsx`. The twins are the same elements, signals and handlers in
  the same order, not the same lines, and neither file says otherwise.

- **The JSX build is `sigil build`, per example.** It dogfoods the toolchain on
  the shape of app the toolchain is for, and it type-checks: an example that
  builds has passed its own `tsc`. Two devDependencies are load-bearing.
  `@ttylabs/cli` provides the bin, and pnpm writes that shim even when the
  target does not exist yet -- measured by moving `packages/cli/dist` away and
  reinstalling -- so a fresh clone, which installs before it builds, works.
  `typescript` is what the build's type gate resolves **from the app**; without
  it the gate is skipped with a notice rather than failed, so an example that
  dropped it would build unchecked. Both pinned, which `pinned dependencies` in
  `packages/cli/test/cli.test.ts` now asserts for every example manifest it
  finds.

- **The root build task's `inputs` already describe an example, and one that
  type-checks `test/` has to say so.** `turbo run build --dry-run=json` reports
  `package.json`, `tsconfig.json` and every file under `src/` for
  `@ttylabs/example-hello#build`, depending on `@ttylabs/cli#build` and
  `@ttylabs/sigil#build`, with `hashOfInternalDependencies` still empty. A cache
  hit restores `dist/` whole: deleted and rebuilt, it came back as 34 chunks and
  a working bin. What the root list does not cover is a `test/` directory that
  the example's `tsconfig.json` includes, because `sigil build` type-checks with
  that file -- `packages/cli/turbo.json`'s case exactly. Such an example needs a
  `turbo.json` of its own repeating the root inputs plus `test/**`, and
  `should hash everything an example's type check reads into its build` fails
  until it has one, and `should let no package override drop a root build
  input` asks every example build as well as the published ones. `hello` is
  that case: it includes `src` and `test`, as an app `sigil new` scaffolds
  does, so `examples/hello/turbo.json` exists and a test edit rebuilds it.

- **`--version` answers the same from both entries, and only the unbuilt one
  says it.** `sigil build` bakes the manifest's version into the bin and
  replaces whatever the schema said (`generateBin()`), so `src/index.ts`
  declares none; `src/ui.ts` has no build to do that, so it reads
  `../package.json` itself, as a function the way the toolchain's own
  `version()` does. Without it, `node src/ui.ts --version` was an undeclared
  option and opened the app while the bin printed `0.0.0`. `should print the
  package version for --version` spawns every entry from its own directory,
  where there is no manifest, so a read against the working directory fails
  rather than passing because the test stood in the right place. A literal
  `'0.0.0'` would still pass while the manifest says the same: catching it
  needs a copy of the example at another version, outside the workspace, where
  `@ttylabs/sigil` does not resolve.

- **Every example with a build joins `pnpm test`'s build filter by name.** The
  smoke test spawns the built `bin`, so a build the filter skipped is a bundle of
  whatever the source used to be. By exact name, for the reason the packages
  are: a glob that matches nothing exits 0. `should name every example that has a
  build` reads `examples/` and fails for one left out. An example with no
  `build` script is a `ui`-tag one and is not named, since naming it would build
  nothing.

- **Whether a bundle is current is not asked by modification time, because that
  answer is wrong.** The first version compared `dist/hello.mjs` against the
  newest file under `src/`. Measured: touch `src/root.tsx` without changing it,
  run `pnpm build`, and turbo reports a correct cache hit and leaves `dist/`
  alone -- so the bundle is ten seconds older than a source file it is exactly
  right for, and the check would fail after every `git checkout` and back. A
  stale bundle is prevented where it is made instead: `pnpm test` builds first,
  the filter test keeps every example in that build, and `src/**` is in the
  hash. `pnpm --filter @ttylabs/cli test` builds nothing, so a missing bundle
  fails naming the two commands that make it, root `pnpm build` or
  `pnpm --filter @ttylabs/example-<name> build` -- `pnpm build` from
  `packages/cli` is the toolchain's build and leaves the bundle missing. That
  package's script was not given a build of its own: it runs inside root
  `pnpm test` too, after the build the root filter already did.

- **The smoke test runs in-process for behaviour and spawned for the entries,
  and the entries are driven with keys.** `runOnTerminal({ stdin: true })`
  (SIG-309) makes a child's stdin a terminal as its stdout already was, so a
  spawned entry can be typed at; before it, `runOnTerminal()` faked `isTTY` on a
  child's output and never wrote to its stdin, and `createInput()` refuses a stdin
  that is not a terminal, so the harness could only mount a root in-process. That
  half is still the one that walks the whole app: each root is mounted over
  `createTestTerminal()`, walked with Tab, quit with `q` and with Ctrl-C, and has to
  leave the alternate screen, show the cursor and put raw mode back -- raw mode
  being the one thing a spawned child cannot report, which is why it stays here.
  Where an example has more than one root, all of them have to draw the same first
  screen -- the claim the two syntaxes rest on, one IR behind both, checked on a
  real app. Each root is run with `runApp(App, { detect: false, sheets, terminal })`
  -- the runner the entries use, so the harness mounts nothing its own way --
  and the codes asserted are the ones `exited` resolves. The entries are what
  the in-process half cannot see, so the built `bin` and `src/ui.*` are each
  spawned twice. Piped, they have to show `runApp()`'s refusal exactly: exit `1`,
  nothing on stdout, the refusal's own line on stderr (matched by its wording, so
  an entry dying of something else with a `1` is not mistaken for it), and no
  stack. And with a terminal on stdin and stdout, `waitFor()` the first frame,
  press `q`, and the process has to exit `0` with nothing on stderr, no stack, and
  the alternate screen and the cursor given back -- the real `main()`, the
  schema, and the capability queries going out unanswered, none of which the
  in-process half runs. An entry that exits `0` piped has stopped refusing, and
  fails. The built one is
  the only check that `sigil build` produced a bundle that loads. The spawn helper and `STACK` moved out of
  `demos.test.ts` into `packages/cli/test/spawned.ts`, one definition for both.
  It lives in `packages/cli` for `demos.test.ts`'s reason: it needs `dist/`.

- **Vite does follow an example's `tsconfig.json`; vitest's module cache is what
  made it look as though it did not (SIG-312).** The first version of this entry
  said vite ignored the tsconfig: with `jsxImportSource` set to `react`, to a
  package that does not exist, and with the file deleted, `root.tsx` still
  compiled against sigil and every test passed. That was measured and it was
  true, and the cause it was put down to was wrong. Vite 8.2.2 hands the file to
  rolldown's `transformSync` along with a tsconfig resolution cache, which finds
  the nearest `tsconfig.json` above **each file** and reads its `jsx` and
  `jsxImportSource`; `vitest@5.1.0` adds nothing of its own, and neither the root
  config, the package's config, a plugin nor `projects` sets an import source.
  Measured with vite alone, `createServer().transformRequest()` over
  `examples/hello/src/root.tsx` fails with `Failed to resolve import
  "react/jsx-dev-runtime"` once the tsconfig says `react`, and a scratch
  directory with `jsxImportSource: "from-tsconfig"` compiles to
  `from-tsconfig/jsx-dev-runtime`.

  What hid it is `fsModuleCache`, on by default since vitest 5 and stored in
  `node_modules/.vitest-cache`. A transform is cached under a key made of the
  module's id, **its content**, and the config (plugins, resolve, the config
  files' own text); the tsconfig is in none of those, so editing the tsconfig
  alone leaves `root.tsx` byte for byte what it was and the cached output, built
  against whatever the tsconfig said when the cache was written, is served. Same
  tree, `--fsModuleCachePath` pointed at a fresh directory each time: the original
  tsconfig passes; `react` fails with `Cannot find package 'react/jsx-dev-runtime'`;
  `no-such-pkg` fails the same way; **no tsconfig at all** fails too, because
  without one the default import source is `react`. Pointed at a **warm** cache,
  `react` passes against the original's output, and the reverse holds: restoring
  the tsconfig over a cache written while it said `react` keeps failing, which is
  the same hole read from the other side. A cold cache, as on a fresh clone or
  CI, therefore checks the line, and a warm one checks it only when `root.tsx`
  itself changed.

  The decision is that the harness keeps what vite does and does **not** override
  the import source, and the line is guarded by a read that no cache can answer
  for. Pinning `oxc.jsx.importSource` in a vitest config would make the
  in-process twin agree with the build by construction, and would make a wrong
  tsconfig invisible to it for good, which is the opposite of the ticket. The
  build overrides the line on purpose (`packages/cli/AGENTS.md`, "JSX compiles
  against `@ttylabs/sigil`"), so what it checks is not the line but the type
  gate: set to `react`, `sigil build` fails with `TS2875`, and `pnpm test` builds
  first. That gate does not catch every wrong source, though: a package that
  resolves but whose JSX runtime has no types passes `tsc` silently, because
  `tsconfig.base.json` sets `noImplicitAny: false`, which turns off TS7016 and
  TS7026, and the build overrides the import source so it builds too (reviewed
  with a stub `untyped-jsx` package). Only the tsconfig read below catches that
  case. So three things guard it, each from a different side: that gate, a cold
  vitest cache, and `should name sigil as its JSX import source` in
  `examples.test.ts`, which reads each JSX example's `tsconfig.json` (following a
  relative `extends`) and asks for `jsxImportSource` of `@ttylabs/sigil` and a
  `jsx` of `react-jsx` or `react-jsxdev`. That read is the one with no cache in
  front of it. Sabotaged: `react`, no tsconfig, and `jsx: "preserve"` each fail
  it. `guides.test.ts` also fails for `examples/hello` when the line changes,
  because the guide quotes `compilerOptions` whole, but only for that example.

  Not done, and the option that is left: a `defineCacheKeyGenerator` in a plugin
  (the `configureVitest` hook) that adds the nearest tsconfig's text to the key
  of a `.tsx`, which would make the in-process mount itself honest on a warm
  cache. It is not taken here because the hole is vitest's rather than this
  harness's -- every tsconfig setting is invisible to the cache the same way, for
  every project in the workspace -- and a key that follows an `extends` chain
  halfway is worse than a documented gap. When a transform seems to ignore a
  tsconfig, `rm -rf node_modules/.vitest-cache` first (or `vitest --clearCache`).

- **`runApp()` runs every example, and `start()` is gone.** Until SIG-276
  landed, each example carried a hand-wired `start()` shaped like the runner,
  so that moving onto it would be one line per caller. It was: the entries and
  the harness now call `runApp()`, the root components lost their props for
  `useApp()`, and `src/start.ts` was deleted. Two things changed on the way. The
  piped answer is the runner's refusal -- exit `1` and a line on stderr --
  rather than `start()`'s line on stdout and `0`, which was Chris's decision on
  SIG-276: a refusal a script can detect is worth more than a `0` that says
  nothing happened. And an entry sets `process.exitCode` itself, because
  `runApp()` resolves a code and leaves the process's alone.

- **The harness and the guide wait for frames with `frame(app)`, and the polling
  is gone (SIG-309).** A frame is drawn on the renderer's clock rather than once
  per key, and `settled()` -- poll the screen until it stops changing for two frame
  periods -- was the harness's answer while nothing said when the next had
  landed. It cost about 70ms a mount, had three tests of its own for the stalls it
  had to survive (a poll that ran before a frame already due, a window restarted
  after a stall), and was a guess about a clock the renderer owns. `frame(app)`
  from `@ttylabs/sigil/testing` paints one now, so there is nothing to wait for
  and nothing to guard; the helper, its tests and the reasoning are under
  "Typing into a spawned program" in `packages/sigil/src/testing/AGENTS.md`, and
  `QUIET_MS`, `FRAME_MS`, `until()` and the three `settled()` tests went with it.
  `mount()` still calls it once, so a first screen that includes what an
  `onMount` wrote is the one the twins are compared on; that call is not load
  bearing for either example today (removing it fails nothing, since both set
  only a focus, which is a background colour and invisible at level 0), and it is
  there for the first example whose mount draws something.

- **The guide quotes the example rather than being replayed.**
  `packages/sigil/docs/full-screen-apps.md` sits beside `getting-started.md`,
  where an app author finds guides and where the package README links them. It
  cannot be replayed the way that one is -- its app is JSX, which Node will not
  run from source, and its transcripts open a screen that waits for keys -- so
  every code block is headed `// <path>` and has to appear in
  `examples/hello/<path>`, which `guides.test.ts` asserts: `ts` and `tsx` line
  for line, because oxfmt re-indents a fragment inside a fence, and `json` by
  value: a non-empty object that may leave out a top-level key but never part
  of one, so `compilerOptions` is quoted whole and `extends` and `include`,
  which place the example in this repository, are left out. The first rule was
  a plain subset, which let `{}` or a dropped `jsxImportSource` pass. An unheaded
  block fails, because the guide says every file it shows is an excerpt; only
  `console` is exempt. `json` rather than `jsonc` because oxfmt gives a `jsonc`
  fence trailing commas `JSON.parse()` refuses. The testing snippet used to be
  a loose fragment nothing ran, so it is `examples/hello/test/hello.test.ts`
  now, quoted whole, and the suite runs it as the example's own project. The
  example's tests are what make the quoted code code that runs. That test pressed
  after a 50ms wait for the first frame and read after another, on the claim that
  the first row takes the focus in `onMount`, after the first frame, so keys
  pressed before it reach no row. **Re-measured under SIG-309, and that half does
  not hold:** `onMount` runs synchronously at the end of `render()`, `hello`'s
  focus exists before any frame, and a key pressed straight after `runApp()`
  counts. What does lag is the screen, by one frame tick -- so the test now has
  one `frame(app)`, after the keys, and none before. The first one it used to
  have was removed rather than kept as a ritual, and the sabotage that puts it
  back fails nothing, which is the evidence it was never load bearing.

- **`'!examples/*.md'` in the root vitest `projects`.** A projects glob that
  matches a file reads it as a config file, and vitest refuses
  `examples/AGENTS.md` as one with a startup error rather than skipping it.

- **Sabotage, against the first harness: fifteen, none survived, one caught by
  the build rather than the suite, and one test written before the pass.** Dropping the example from the
  build filter, a throw in the JSX body, the two twins disagreeing by one
  letter, no `dispose()`, no `input.stop()`, no `q` binding, a ranged
  devDependency, a `test/` the tsconfig includes but the hash does not, a guide
  excerpt drifting by two words, a wrong package name, the projects glob without
  its `.md` exclusion, a missing bundle, and a non-TTY path that throws: each
  fails the suite. A wrong `jsxImportSource` is caught by `sigil build`'s
  `TS2875`, for the reason above. Removing the Ctrl-C binding would have
  survived the first harness, which only quit on `q`; the Ctrl-C test was added
  for it before the pass, and the binding's removal fails it. `start()` is gone
  now, so the `dispose()` and `input.stop()` sabotages are the runner's to keep,
  and its own suite does.

- **Sabotage, after the move onto `runApp()`: ten, none survived.** An entry
  that exits `0` piped, unbuilt and built; a root that ignores `q`, in either
  syntax; a root that takes props; an entry that throws, which exits `1` but
  prints a stack; an entry that writes to stdout before refusing; an entry that
  exits `1` with some other error line; the twins disagreeing by one letter; and
  a `src/start.ts` left behind. Each fails the suite.

- **Sabotage, after review round 1: ten, none survived.** `settled()` put back
  to counting polls, and its window cut to half a frame; `src/ui.ts` without its
  version, and with one that disagrees with the manifest; the guide's test
  pressing a different key, its `tsconfig` naming `react`, and either block
  losing its heading; the example's `turbo.json` deleted, which the type-check
  hash guard catches, and missing `sigil.json`, which the override guard now
  catches for examples. A missing bundle fails with the message above.

- **Sabotage, after review round 2: eight, none survived.** `settled()` with
  neither stall guard, with a fixed sleep of the round-2 length (110ms), with
  `QUIET_MS` halved, and without
  the restart (the delayed-arming test); the guide's `tsconfig` as `{}`,
  without `jsxImportSource`, and naming `react`; and `src/ui.ts` reading
  `package.json` from the working directory.

- **The system monitor's keys are fallbacks, and that is what SIG-308 was
  built to prove (SIG-308).** The monitor put its keys on the root's `onKey` --
  reached only by bubbling from a focused element, and under a text field, which
  is the one place `q` has to be a letter -- and so it focused the process table
  on mount, again after the filter, and again after the kill dialog, so that
  _something_ was focused. Those three `focus()` calls are gone: the keys are
  `input.fallback()`, which a focused field outranks and which runs with nothing
  focused, and `q` is not the monitor's at all but `runApp()`'s `quitKey`. The
  filter hands the focus to nothing on Enter and on Escape. `Escape` stays an
  `onKey` on the root because it is the field's own key (abandon the filter), and
  it is only meaningful while the field is focused. One behaviour moved, and it is
  better: with the filter focused, Up, Down, PageUp and PageDown now reach
  the table, because the field does not take them (it does take Home and End, as
  cursor motion), where the old handler returned early for everything but Escape.

  The footer's `q quit` is the runner's -- lower case and through `__`, like every
  description the framework lists, so it is the line the monitor wrote and now
  translates -- and it is last because the runner registers it after the body. Removing the focus-first workaround also removed a side effect nobody had
  named: the footer sized itself from the root's laid-out width, which does not
  exist at the first draw, and was cut to a guess of 80 until the focus moved --
  the mount-time `focus()` was what moved it. It reads `app.terminal.width` now,
  which is there at the first draw. Still not re-asked on a resize.

- **Not done:** the focus highlight is a background colour, so at colour level 0
  (a pipe, `NO_COLOR`) nothing on screen says which row has the focus -- what a
  control shows at level 0 is SIG-278's question for every widget, and `hello`
  will follow its answer; the guide's console blocks are illustration, since a
  transcript of a full screen is not a thing to replay; and examples are not on
  the website, which is SIG-298.

### A log and resource browser, in the shape of k9s and lnav (SIG-295)

`examples/log-browser`. It has a live table of resources with a `:` command bar,
a filter and a describe pager, and a log that follows, filters and searches. It
is written twice, as `hello` is, and is the first JSX example bigger than one
screen of code.

- **The twins share a model, and differ only in markup.** `src/browser.ts`
  exports `useBrowser()`, which a root calls in its body. It builds every
  signal, starts the clock, and hands back the handlers and labels. The root
  builds the elements in its own syntax (`DataTable`, `ListView`, `TextField`,
  `Panel`, the log row) and hands the ones the handlers reach back through
  `attach()`. "What the twins share lives in a module neither of them is" is the
  rule above, applied to behaviour as well as data. A twin that held the
  handlers would be a second copy of the app with a different spelling of its
  tree. The view keys are an `onKey` on each view's box, scoped with
  `input.describe()`, so the footer lists what applies to the view that is up.
  The one app-wide key, `:`, is a fallback.

- **The log is a `ListView`, not the pager.** The ticket pointed at the pager
  for `/`. The pager reads its document once, has no filter, and strips colour,
  all recorded under its "Not done" and filed as SIG-387. So the log is a list
  of lines, keyed by an id that rises. The describe view does use the pager,
  because a describe is a document read once. One pager is built per describe,
  under a branch of the app's owner, and disposed when the view goes. A query
  is read in both by `searchPattern()`, which SIG-295 exported from the pager
  rather than copying its literal and smart-case rule. The pager's
  `searchLines()` is not used for the filter, because it stops at
  `MAX_MATCHES`, and a filter that stops part way drops lines without saying
  so.

- **Following is the cursor on the newest line, decided when the cursor
  moves.** An effect over `current` sets `following` to whether the cursor is
  on the tail. An append while following writes the new tail's key into
  `current` in the same step as the new rows. That relies on the list's items
  effect running before its cursor effect, which creation order gives today.
  The follow tests fail if it changes, and SIG-385 asks for this as a mode of
  the list. `F` sets `following` itself, because writing the key the cursor is
  already on wakes nothing; the sabotage that drops it fails the follow test. A
  wheel moves the view and not the cursor. So an append first asks whether the
  cursor's row is still on screen, read off `listControl().scroll.viewport`, and
  stops following if it is not. Otherwise the next line would pull a reader who
  had wheeled up back down.

- **The rows of the log are not reactive; a new search refreshes them.** A
  function child is text, not elements, so a row cannot redraw its match runs
  from a signal without `For`. The row reads the query when it is built, and an
  effect calls `listControl(log).refresh()` when the query changes. That
  rebuilds the rows on screen and nothing else. `should draw a line in its
  level's role` searches for a line already on screen, because a search that
  scrolls builds its rows fresh and would pass without the refresh. Measured:
  with the refresh removed, it fails and nothing else does.

- **A view or the prompt line is shown with an inline `display`, and then a
  frame is forced.** The router hides an element the moment an inline `display:
  none` is written, but only shows one once a frame has restyled it. So focus
  moved into a box just shown is taken back by a key that arrives in the same
  read: `:pods` pasted, or typed fast, sent `pods` to the table, and the `l` in
  it opened a pod's logs. `redraw()` calls `app.view.frame()` after showing,
  which is public and says what it does. `should take a command typed in one
  read` fails without it. SIG-384 asks the router to read a shown inline
  `display` as current, at which point `redraw()` goes.

- **The world is an injected environment, and the cluster keeps its own
  time.** `EnvironmentContext` carries the clock, the history size, the cap,
  the seed and the file. The cluster starts at 09:00 UTC on 2026-11-10 and moves
  only when it is advanced, and every choice is a seeded LCG. Nothing reads
  `Date.now()` or `Math.random()`. That is what lets the contract test compare
  the twins' first screens under the real environment, 50,000 lines included,
  and what lets a test know which pod crashes first. A file is the other feed:
  `fileFeed()` reads it whole, then what was appended, holds half a line until
  its newline, decodes as a stream, and starts again from the top when the file
  gets shorter.

- **The figures are a script's, and the test asserts only what does not
  depend on the machine.** `scripts/measure.ts` times a batch, a page, a search
  and a filter at four sizes, and the README records one run against this
  change. The suite asserts the element count with 50,000 lines (under 2,000
  against about 600 measured), which a log that built a row per line would miss
  by two orders of magnitude, and no time at all, for the reason the layout
  fuzzer's deadline is recorded. A batch grows with the lines held, about 11 of
  18 ms at 200,000, in `ListView` re-keying every row: SIG-386.

- **The mouse is off, and `--mouse` turns it on.** A terminal that reports the
  mouse stops selecting text, and copying a line out of a log matters more here
  than a click. That is the pager's reason, given for the same trade. The wheel
  check above is what `--mouse` makes reachable, and its test runs with the
  mouse on.

- **Sabotage: ten, none survived after four tests were added.** The forced
  frame on opening the prompt, the in-view check on an append, the refresh on a
  new search, the refilter that keeps following, `following.set(true)` on `F`,
  the shown lines trimmed when the log is at its cap, the pager closed with its
  view, the filter kept across a describe, and `key` dropped from the JSX list
  and from the JSX table. The refresh, the trim, the closed pager and the kept
  filter each survived the first pass. Each then got the test that catches it:
  a search for a line already on screen, a log at a cap of 510, no pager left
  in the tree, and a describe and back with a filter up.

- **Not done:** a real cluster; a row coloured whole by its status (SIG-388),
  so the STATUS cell carries the colour as a `TableCellView`; the log as a
  pager (SIG-387); and following as a list mode (SIG-385).
