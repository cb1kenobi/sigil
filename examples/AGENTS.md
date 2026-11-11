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

  | Path                    | What it is                                                                                                                                                                                                                                     |
  | ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
  | `package.json`          | `"name": "@ttylabs/example-<name>"`, `"private": true`, `"type": "module"`, `@ttylabs/sigil` as `workspace:*`                                                                                                                                  |
  | `src/root*.{tsx,ts,js}` | One per syntax: `root.tsx` for JSX, `root.ui.ts` (or `root.ts`/`root.js` in a `ui`-only example) for the tag. Each exports `App(): Element`, taking no props, and `stylesheet: string`                                                         |
  | `src/ui.{ts,js}`        | The entry Node runs unbuilt, when there is a `ui`-tag root; with `src/index.ts`, an entry is `process.exitCode = await runApp(App, { sheets: [stylesheet] }).exited`, with whatever other option the app needs (`settings` turns the mouse on) |
  | `bin`, `scripts.build`  | A JSX example only: `"build": "sigil build"` and exactly one `bin`, which is what it builds to                                                                                                                                                 |
  | `test/`                 | Tests of the example's own, which vitest picks up as a project named after the package                                                                                                                                                         |

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

- **The full-screen budget's workload lives beside the system monitor, in
  `stress/`, and is not part of the example (SIG-290).** `stress/app.js` is the
  monitor's screen built from `DataTable` and the four live charts.
  `stress/machine.js` is a seeded machine with a thousand processes that move on
  every reading. `stress/monitor.js` feeds the same machine to the monitor's own
  `App` through `SystemContext`, so the stand-ins and the components they wait for
  are measured on one input. `stress/measure.js` is the harness and
  `stress/benchmark.js` the script run by hand. `test/stress.test.js` holds the
  counts to ceilings, and it runs as the example's own project.

  `stress/` sits beside `src/` so the contract above is untouched: none of it is
  a root, an entry or a `start`, and `src/` stays the app somebody copies. Why the
  budget is here rather than in `packages/sigil/scripts/`, what it measured, and
  why the suite holds counts and no time are under "A full-screen performance
  budget" in `packages/sigil/src/renderer/AGENTS.md`. That entry is about the
  renderer, and this directory only houses the workload.

- **Not done:** the focus highlight is a background colour, so at colour level 0
  (a pipe, `NO_COLOR`) nothing on screen says which row has the focus -- what a
  control shows at level 0 is SIG-278's question for every widget, and `hello`
  will follow its answer; the guide's console blocks are illustration, since a
  transcript of a full screen is not a thing to replay; and examples are not on
  the website, which is SIG-298.

### A settings screen and a login form (SIG-293)

`examples/settings`. The two blocks a web developer looks for first, and the
caller SIG-199's form controls were waiting for: a sidebar of sections, a radio
set, a slider, a switch, checkboxes and text fields, Save and Cancel over an
unsaved-changes state, and a login form in a dialog. It found three gaps, each a
ticket and each marked where the example works around it. How each answer below
was tested, and the sabotage pass, are in
[docs/history/a-settings-screen-and-a-login-form.md](../docs/history/a-settings-screen-and-a-login-form.md).

- **JSX alone, and built.** SIG-275 asked for the two syntaxes to be compared
  once and each later example to pick one; `hello` is the comparison and the
  system monitor picked the tag. A form is where JSX pays: a dozen controls whose
  props are spelled out each time, all of them checked by the build's `tsc`. So
  there is no `src/ui.ts`, the harness's same-screen check and unbuilt-entry
  checks do not run for it, and `--version` comes from the version `sigil build`
  bakes into the bin.

- **The ticket's open question: a field's error line is the form's, and the form
  is `src/form.ts`.** SIG-215 settled that a field does not own validation, and
  this is where it went. `createForm(initial, checks)` holds a `State` per field,
  which the control is handed and writes, and a `Computed` error per field from a
  check that is handed _every_ value -- so a check can be about two fields: the
  phone number is required only while SMS is ticked, and ticking SMS re-runs the
  phone's check. On top of those: `dirty`, `errors` in declaration order,
  `valid`, `commit()` for Save, `revert()` for Cancel, and `touch()`.

  Where it is shown is two places, and they differ on purpose. **Under the
  field**, a row reserved whether or not it says anything (`Problem` in
  `rows.tsx`, the row the prompts keep for theirs, so an error appearing moves
  nothing), blank until the field is _touched_ and from then on following every
  key, so a fix takes it away at once. **In the bar beside Save**, at once and
  whichever section the field is in: `Can't save: Phone: SMS needs a phone number`
  while the Notifications section is showing, with Profile marked `!` in the
  sidebar. A disabled Save with no reason anywhere on screen is the trap the bar
  exists for; a field's own line waiting is what keeps a half-typed address from
  being called wrong. Enter on a form that cannot be saved, and Enter in the
  login's password while it is invalid, touch every field, since a submit the
  form refused has to say why.

- **Touched is the focus leaving a field once, read off the router.** Not the
  first edit: `not an email address` after typing `a` is about a value nobody has
  finished. `touchOnLeave()` watches `input.focus.current` in an effect rather
  than the field's own `onFocusChange`, because `TextField` owns that hook and
  refuses it in `props` (SIG-305's table).

- **Not extracted, and SIG-338 is the extraction.** The settings screen and the
  login dialog use different halves of `createForm()` -- one saves and reverts,
  the other only checks and submits -- which is evidence it is one shape. It is
  not evidence of the published API: where it lives (it has no elements, so not
  under `components/`), whether `touchOnLeave()` and its router come with it, and
  whether the error row is published as an element are questions a second app
  answers better than a guess. The root file's one-definition rule is not
  strained, since nothing else defines it.

- **The sections are built once and hidden with `display: none`.** `Tabs`' rule
  for its panels: a hidden section is out of the focus ring, and keeps a field's
  contents and caret while another is showing. A `Show` per section would build
  each again on every visit.

- **Appearance is the first section, and the smoke test is why the order is
  written down.** The harness Tabs four times from the first screen and quits on
  `q`, and a text field keeps a typed `q` (SIG-308) -- so a screen that opened on
  Profile would put the fourth stop in a field and the quit into its value. It is
  also the right first section, and the reason is recorded so that a reorder
  knows what it is moving. The sidebar starts with the focus, so Down shows the
  next section: that is the `KEYED` entry the spawned run presses, waiting for
  `Pause all`.

- **The mouse is on in the entry**, because a settings screen is clicked as
  often as typed at, and `runApp()` leaves it off unless asked. The contract
  line above now says an entry may pass options.

- **What is worked around, each with a ticket.** `follow()` mirrors a `Computed`
  into a `State` for a control's `disabled`, used five times (SIG-334). The login
  dialog's Sign in and Cancel are in its body with `actions: []`, because an
  action cannot be disabled and a dialog with actions opens on a button rather
  than on the first field (SIG-337). And the dialog borrows an owner: it is opened
  from `onPress`, which has none, so its body is built under a branch of the
  Account section's owner and disposed when `result` settles -- without that, the
  effect following the focus runs for the rest of the app, which was measured
  (SIG-335).

- **The status line is cut with an ellipsis, never wrapped.** At 60 columns the
  SMS reason is wider than the bar, and the text wrapped: its second line drew
  over the key-help row under the height-1 bar, where the one blank the footer
  leaves between `tab` and `next` let the `m` of `number` through, as
  `tabmnext`. `white-space: nowrap` and `text-overflow: ellipsis`, and `should
  cut a long status with an ellipsis rather than wrap it into the footer`.

- **No guard against a second sign-in while one is on its way.** The fields take
  `busy` as their `disabled` and the button follows it, so nothing can submit
  twice; the guard was written and deleted for surviving its sabotage.

- **The tests pin a box-drawing terminal through the environment.** The panels'
  borders, the list's pointer and the sidebar's marks come from
  `unicodeSupported()`, and a Windows runner says ASCII, so `settings.test.ts`
  stubs `TERM` and `WT_SESSION` for every test and the screens it asserts are the
  same on every runner.

- **Sabotage: twenty-three, two survived by design.** The list, and what each
  survivor was, is in the history file.

- **Not done:** saving anywhere but memory, which is the config module's and not
  this example's subject; a confirm before `q` quits with unsaved changes; the
  theme radio applying a theme; a level-0 cue for a focused text field, which
  SIG-278 records as the caret's cost; and a `ui`-tag twin.

### The git client (SIG-292)

`examples/git-client`: lazygit's shape -- files, branches and the log down the
left, a diff on the right -- staging files and hunks, switching branches, and a
commit message in a text area. What it settled:

- **The git client is both syntaxes on a real app, and the model is the module
  neither root is (SIG-292).** `hello` showed the twins on three rows; the system
  monitor stayed `ui`-only and its README left "a JSX version" for later. The git
  client is the first whole app written twice, and what made that cheap is where
  the line between the twins falls: `root.tsx` and `root.ui.ts` build the tree --
  the panels, the three `ListView`s and their rows, the pane, the footer -- and
  everything else is `createModel()` in `src/model.ts`, which both call from
  their body: the states, every git call, the keys, the dialogs and the toasts.
  The roots hand back the parts a key or the focus reaches through
  `m.attach({ diff, lists, panels })`. The diff pane is a component in a shared
  module (`src/diff-pane.ts`) that both name, `<DiffPane />` and
  `<${DiffPane} />`, because it is built from elements and effects and a template
  would say nothing about it. So the twins are each about 140 lines and the
  model is the rest, and `should draw the same screen in every syntax` compares
  two first screens that hold three panels, three lists and a diff.

- **It runs real git, through a context, against repositories its tests make.**
  `GitContext` is the system monitor's `SystemContext` shape: `App` takes no
  props, so the directory git runs in and the environment it gets come through a
  context that a test provides and the entries default to the working directory
  (or the `[dir]` argument). Nothing is faked: `test/app.test.ts` makes a
  repository under the temp directory for every test, drives the client over a
  test terminal, and asserts on `git` itself -- `diff --cached`, `log`,
  `branch --show-current`, the files on disk -- not on the screen alone. Git there
  is told nothing about the machine: `GIT_CONFIG_NOSYSTEM`, a `GIT_CONFIG_GLOBAL`
  file of the test's own that sets `init.defaultBranch`, `core.autocrlf=false` and
  `commit.gpgsign=false`, an identity in `GIT_AUTHOR_*` and `GIT_COMMITTER_*`, a
  `GIT_CEILING_DIRECTORIES` at the test's temp directory, and every other `GIT_*`
  variable dropped. That is one list for four machines: a CI runner with no
  identity, a laptop that signs every commit, a Windows runner whose system
  config turns `autocrlf` on, and a `GIT_DIR` or `GIT_INDEX_FILE` a hook left in
  the environment, which would point git at the repository the tests are run
  from. `settle()` waits for the client's own git calls to finish -- the context
  is wrapped to count them -- rather than for a time, since a Windows runner
  spawns git several times slower than a Mac.

- **Its temp directories are removed by the test file, not by a sixth
  `temp.ts`.** "The suite removes every directory it makes" in
  `packages/sigil/src/testing/AGENTS.md` keeps one identical copy of `tempDir()`
  per package, wired through each package's `setupFiles`. An example has no
  `vitest.config.ts` and adding one, a `test/setup.ts` and a copy of the helper
  for one file would be three files to say what an `afterAll` says. So
  `app.test.ts` records each directory it makes and removes them in an `afterAll`
  with `maxRetries: 5` and no catch -- the same removal, failing the file the same
  way -- which is the shape that entry leaves alone ("the sites that already
  removed what they made"). A second test file that makes directories is the
  point at which the helper earns its copy.

- **The contract tests run it in the repository it is developed in, and it only
  reads there.** `examples.test.ts` mounts every root in-process and spawns every
  entry from `src/` and `dist/`, with no provider, so the client runs against
  whatever checkout the suite is in: it presses Tab, `2`, `q` and Ctrl-C, none of
  which writes. Every git the client runs has `GIT_OPTIONAL_LOCKS=0`, so even the
  status read does not refresh the index and take `index.lock` from a `git commit`
  the developer is running beside the suite -- the setting editors that poll git
  use for that reason, and `test/git.test.ts` holds it, since nothing a test can
  see from a repository changes without it. What the contract tests see is
  whatever the checkout holds, which is why the `KEYED` entry for it waits for
  `checkout`, a word the footer shows once `2` has focused the branches whether
  or not the directory is a repository at all.

- **One git at a time.** Every call goes through one promise chain: two Spaces
  pressed quickly are two `git add`s, and two gits writing one index is one of
  them failing on `index.lock`. An action reads the repository again after it,
  through the same chain, so the refresh sees what the action wrote. A diff asked
  for while one is already waiting is the same request -- holding `j` down asks
  for one diff, of wherever the cursor is when it runs, not one per row -- and
  quitting aborts the git in flight, so the shell does not get the terminal back
  under a `git log` still writing.

- **Destructive means it loses work git cannot give back, and that is behind
  `confirmModal()` with `initial: 'no'`.** Discarding a file's unstaged changes
  (`git checkout -- <path>`), deleting an untracked file (`git clean -f`), and
  deleting a branch (`git branch -d`, which git itself refuses for one that is
  not merged). Enter and Escape are both No, so a reflexive key loses nothing; the
  tests answer No both ways and then Tab to Yes. Staging, unstaging, committing
  and switching are not destructive and do not ask: each is undone by another
  key, and a switch that would overwrite changes is refused by git, which the
  client shows rather than forcing. Discard leaves staged changes alone and says
  so when there is nothing unstaged, because throwing away what somebody staged
  deliberately is the one discard nobody means.

- **A hunk is staged as a patch of its own, read by the example's own reader.**
  Space writes the file's header and the one hunk back, every line as git wrote
  it, to `git apply --cached` (and `--reverse` under `Staged`), which is
  `git add -p`. `parsePatch()` keeps neither the raw lines nor
  `\ No newline at end of file`, so a hunk at the end of a file with no final
  newline would be a different hunk -- `should stage a file with no final newline
  a hunk at a time` is the case -- and `splitPatch()` in `src/parse.ts` is a
  second reader for it. That is a duplicate of a decision and is recorded as one:
  SIG-370 is the ticket for a reader that does both. A patch over 4,000 lines is
  cut, and the hunk the cut went through is dropped rather than offered to Space,
  since its header still counts lines it no longer has.

- **The diff pane rebuilds `diffView()` at the width the layout gives it.**
  `diffView()` draws for a width it is told and has no view that scrolls, so the
  pane is a `ScrollBox` whose `onResize` builds every row again when the width
  changes -- before the frame paints, and answered as a change -- and whose
  hunks are found by the `sigil-diff-hunk` class on their header rows, each row
  behind a one-cell mark that is `▌` (`>` in ASCII) for the hunk under the
  cursor. Reading the class couples the example to `diffView()`'s output, which
  is the reason SIG-367 exists. The model counts the hunks one way and the pane
  draws them another, so the pane throws if the two disagree rather than putting
  the mark on the wrong rows.

- **The footer follows the focus by describing each pane's keys with its panel
  as the scope.** A list's own moves come from `describeListView()`; the pane's
  actions are `input.describe(key, { scope: panel })`, since they are the panel's
  `onKey` and a function cannot be read for its keys; and the app's own keys --
  `c`, `r`, `1` to `4` -- are fallbacks, so a letter typed into a dialog's field is
  a letter. The four pane keys share one description, which the footer folds into
  `1/2/3/4 pane`. While a dialog is open the footer still lists the app's keys,
  which the dialog swallows: SIG-374.

- **The lit pane is a class an effect puts on, because there is no
  `:focus-within`.** An effect over `input.focus.current` asks each panel whether
  it `contains()` the focused element and toggles `is-active`, and the sheet gives
  that a green border -- the one colour in the sheet the roles do not give, since a
  role class on the panel would colour its contents too. The title also gains a
  `▸` (`>` in ASCII), which is what is left of it at colour level 0. SIG-372 is the
  selector this stands in for.

- **A dialog's body is built under a branch of the component's owner.** The
  commit dialog's `TextArea` is over the app's draft and the new-branch dialog's
  `TextField` is a field, and both are built in a key handler, which has no owner
  -- so their effects would outlive the dialog and go on following the draft.
  `owned()` builds them under `runWithOwner(owner, createBranch)` and disposes the
  branch when `result` settles, which is the settings example's answer to the same
  hole; SIG-335 is the ticket for `openModal()` doing it, and SIG-337 for opening
  on the field rather than on a button, which the client does by focusing it
  straight after `openModal()`. Enter is a newline in the commit message, so the
  commit is Ctrl-S, an `onKey` on a box around the area, which the dialog's key
  walk reaches because the area leaves the chord alone. Escape keeps the draft.

- **Every format git prints for it is the machine one.** `status
  --porcelain=v1 -z`, `for-each-ref` with `%00` between fields, and `log -z` with
  a unit separator, so a path with a space or a subject with a `|` reads as
  itself, and Windows reads as macOS does: git prints `/` on every platform, and
  the one path the client builds itself, for reading an untracked file, is joined
  with `/` rather than through `node:path`, so it is one spelling of the path git
  printed. The settings that change what git prints -- `color.ui`,
  `core.quotepath`, `diff.noprefix`, `diff.mnemonicPrefix`, `diff.relative` --
  are passed with `-c` on every call, so a user's config cannot hand the parser a
  patch `git apply` will not take back.

- **Sabotage: seventeen, one survived and has a test now.** A patch reader that
  drops `\ No newline`, a hunk written back without its file header, unstaging
  without `--reverse`, a discard confirm that starts on Yes, a discard and a
  branch delete with no confirm at all, deleting the branch checked out, a branch
  cursor that does not start on it, a hunk cursor that never moves, Ctrl-S
  unbound, an empty message committed, an untracked file not drawn, Escape doing
  nothing in the diff, the panes' keys described with no scope, an action not
  followed by a refresh, and a rename's source read as a path of its own: each
  fails the example's tests. A commit that kept its draft survived, because
  nothing opened the dialog a second time; the commit test now does.

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
