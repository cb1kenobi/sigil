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

- **The smoke test runs in-process for behaviour and spawned for the entries.**
  `runOnTerminal()` fakes `isTTY` on a child's output but never writes to its
  stdin, and `createInput()` refuses a stdin that is not a terminal, so a spawned
  child cannot be driven with keys. In-process over `createTestTerminal()` it
  can: each root is mounted, walked with Tab, quit with `q` and with Ctrl-C, and
  has to leave the alternate screen, show the cursor and put raw mode back. Where
  an example has more than one root, all of them have to draw the same first
  screen -- the claim the two syntaxes rest on, one IR behind both, checked on a
  real app. Each root is run with `runApp(App, { detect: false, sheets, terminal })`
  -- the runner the entries use, so the harness mounts nothing its own way --
  and the codes asserted are the ones `exited` resolves. The entries are what
  the in-process half cannot see, so the built `bin` and `src/ui.*` are each
  spawned piped and have to show `runApp()`'s refusal exactly: exit `1`, nothing
  on stdout, the refusal's own line on stderr (matched by its wording, so an
  entry dying of something else with a `1` is not mistaken for it), and no stack.
  An entry that exits `0` piped has stopped refusing, and fails. The built one is
  the only check that `sigil build` produced a bundle that loads. The spawn helper and `STACK` moved out of
  `demos.test.ts` into `packages/cli/test/spawned.ts`, one definition for both.
  It lives in `packages/cli` for `demos.test.ts`'s reason: it needs `dist/`.

- **The in-process JSX twin is compiled by vite, and vite does not follow the
  example's `tsconfig.json` for it.** Measured three ways: with
  `jsxImportSource` set to `react`, to a package that does not exist, and with
  the file deleted, `root.tsx` still compiled against sigil's `jsxDEV` and every
  test passed. How vite arrives at that was not run down. What it means is that
  the tsconfig's JSX lines are checked by `sigil build`, not by vitest: set to
  `react`, the build fails with `TS2875`, and `pnpm test` builds before it tests.
  The same-screen assertion is what proves the in-process twin produced sigil
  elements at all.

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

- **The harness and the guide wait on timers for frames, which is SIG-309.** A
  frame is drawn on the renderer's clock rather than once per key, and nothing
  yet says when the next has landed, so the harness polls the screen until it
  stops changing and the example's own test waits 50ms. Both comments name
  SIG-309, which is the call that would replace them. "Stops changing" is two
  frame periods by the clock (`QUIET_MS`), never a count of polls: the first
  version counted three equal reads 10ms apart, which returned in about 30ms,
  inside one 33ms frame, under a comment saying it had waited one out. And the
  clock only counts while the loop runs (review round 2, probed): node fires
  due timers in the order they fell due, the 10ms poll is armed before a frame
  a change scheduled, so after a stall longer than the window the poll ran
  first and returned the screen from before a frame already due. Two guards: a
  poll arriving more than a frame period after the last restarts the window,
  and a window that looks finished yields past the timers phase
  (`setImmediate`) and reads again. Three tests: changes at 45ms and 95ms with
  a literal floor of 155ms, so a smaller `QUIET_MS` fails, and so does a fixed
  sleep shorter than the floor -- one of 155ms or more passes all three, since
  it outlasts every timer they arm, and no finite set of timings can refuse
  every sleep without an upper bound that would flake under load; a synchronous stall with a change already due, which fails with both
  guards removed; and a stall whose frame is armed by a timer the stall
  delayed, which only the restart sees. Either guard alone passes the second,
  and no deterministic test separates the yield from the restart: the case it
  alone covers is a sub-frame stall where the poll and a frame fall due in one
  tick, which a test can only hit by luck.

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
  example's tests are what make the quoted code code that runs. That test waits
  a frame before the first key, measured: the first row takes the focus in
  `onMount`, after the first frame, so keys pressed before it reach no row, and
  the screen lags a key by one frame tick. Thirty copies run ten at a time did
  not flake: a frame a key scheduled falls due before the 50ms timer set after
  it, and node fires timers in that order however late.

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

  The footer's description of `q` is the runner's, so it reads `q Quit` where the
  monitor wrote `q quit`, and it is last because the runner registers it after the
  body. Removing the focus-first workaround also removed a side effect nobody had
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
