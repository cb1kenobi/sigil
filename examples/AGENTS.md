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

- **What is worked around, each with a ticket.** The login dialog's Sign in and
  Cancel are in its body with `actions: []`, because an action cannot be disabled
  and a dialog with actions opens on a button rather than on the first field
  (SIG-337). And the dialog borrows an owner: it is opened from `onPress`, which
  has none, so its body is built under a branch of the Account section's owner and
  disposed when `result` settles -- without that, the effect following the focus
  runs for the rest of the app, which was measured (SIG-335).

- **A derived `disabled` is a function handed to the button.** Save, Cancel, Sign
  in and the Account section's two buttons each take one --
  `disabled: () => !form.dirty.get()` -- which the control reads inside its own
  effect. It was a `follow()` helper that mirrored the condition into a `State`
  through an effect of the example's, five times over, until SIG-334 let a
  control's `disabled` be a `Computed` or a function.

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
  `m.attach({ diff, lists, panels })`. The diff pane is the library's `DiffView`,
  which both name, `<DiffView />` and `<${DiffView} />`, over the blocks the
  model builds; until SIG-367 it was a component in a shared module of the
  example's own, `src/diff-pane.ts`. So the twins are each about 140 lines and the
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

- **A hunk is staged as a patch of its own, read and written by the library.**
  Space writes the file's header and the one hunk back, every line as git wrote
  it, to `git apply --cached` (and `--reverse` under `Staged`), which is
  `git add -p`. The patch is read once, by `parsePatch()`, and that read is both
  what the pane draws (`diffView({ files })`) and what `hunkPatch()` writes back:
  the reader keeps each file's header and each hunk's source lines, `\r` and
  `\ No newline at end of file` included, since a hunk at the end of a file with
  no final newline is a different hunk without that line -- `should stage a file
  with no final newline a hunk at a time` is the case. The example had a second
  reader, `splitPatch()`, until SIG-370 gave the library's one the text to write
  back. What is left in `src/parse.ts` is `pathOf()`, which reads the path off
  the names `parsePatch()` returns: the `a/` and `b/` prefixes and the unquoting
  are the client's own `--src-prefix`, `--dst-prefix` and `core.quotepath`
  choices rather than the format. A patch over 4,000 lines is cut, and the hunk
  the cut went through is dropped rather than offered to Space, since its header
  still counts lines it no longer has.

- **The diff pane is a `DiffView` over blocks the model builds, and the model asks
  `diffStops()` what is under the cursor.** `blocksOf()` turns what the pane shows
  into the view's blocks: each section's heading and prose, each patch file as a
  `{ diff: { files } }` block, and a line of prose the cursor stops on for a whole
  file with nothing to draw -- binary, too large, a pure rename, an empty untracked
  file -- each block carrying its section. The view counts its stops with
  `diffStops()` over the same blocks and the model does too, so Space finds the
  stop the view marks by construction; before SIG-367 the example's own pane found
  hunks by the `sigil-diff-hunk` class, the model counted them another way, and the
  pane threw when the two disagreed. `]` and `[` are the view's keys and
  `describeDiffView()` describes them; `n` and `p` are the client's second
  spelling, on the panel; Space is the client's, on the panel, and acts on the
  stop's section -- the untracked file's one hunk stages the file whole, since an
  added file's hunk written from two texts has no `new file mode` for
  `git apply`.

- **The footer follows the focus by describing each pane's keys with its panel
  as the scope.** A list's own moves come from `describeListView()`; the pane's
  actions are `input.describe(key, { scope: panel })`, since they are the panel's
  `onKey` and a function cannot be read for its keys; and the app's own keys --
  `c`, `r`, `1` to `4` -- are fallbacks, so a letter typed into a dialog's field is
  a letter. The four pane keys share one description, which the footer folds into
  `1/2/3/4 pane`. While a dialog is open the footer still lists the app's keys,
  which the dialog swallows: SIG-374.

- **The lit pane is a selector: `.sigil-panel:focus-within { border-color: green
  }`.** It was a class an effect put on -- an effect over `input.focus.current`
  asked each panel whether it `contains()` the focused element and toggled
  `is-active` -- until SIG-372 gave the selector engine the state. The green is the
  one colour in the sheet the roles do not give, since a role class on the panel
  would colour its contents too, and `border-color` does not inherit, so the
  contents keep theirs. The effect is still there for the two things a sheet cannot
  do: the title gains a `▸` (`>` in ASCII), which is what is left of the light at
  colour level 0, and a list taking the focus is what the diff pane shows from then
  on.

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
  drops `\ No newline` (since SIG-370 the library's, and its own tests fail as
  well), a hunk written back without its file header, unstaging
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

- **Following is the list's `tail` (SIG-385).** The log holds `following` as
  a `State` for the panel's `following` / `paused` label and for `F`, which
  writes its opposite, and hands it to `ListView` as `tail`. The list moves the
  cursor to the newest line as lines arrive, stops on a move off it or a wheel
  that takes it out of view, and starts again on End. That was about forty lines
  here: an effect deciding following from the cursor, a write of the new tail's
  key in the same step as the rows, which relied on the list's items effect
  running before its cursor effect, a check of the viewport at each append for a
  wheel the app could not hear, and `F` writing the key itself. The decisions
  are under "A list view that follows its tail" in
  `packages/sigil/src/components/AGENTS.md`; the follow tests here are the ones
  that were written against the app's version, and pass unchanged.

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
  fuzzer's deadline is recorded. A batch grew with the lines held, about 11 of
  18 ms at 200,000, in `ListView` re-keying every row. SIG-386 made the keying
  and the map proportional to the lines that came and went. What still grows
  with the lines held is two comparisons per kept line and the array copies, about
  half a millisecond at 200,000. The README records the figures from before and
  after, both from the same session.

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
  in the tree, and a describe and back with a filter up. Three of the ten -- the
  in-view check, the refilter that keeps following and `F`'s write -- moved into
  the list with SIG-385, whose own pass covers them. Here, `tail` dropped from the
  JSX root fails the follow and the wheel tests for that root, and `F` that only
  stops fails the follow test.

- **A pod in trouble is coloured across its whole row, by the table's
  `rowClass` (SIG-388).** `resourceClass()` in `src/browser.ts` gives a
  `CrashLoopBackOff` pod `sigil-error` and a `Pending` or `ContainerCreating` one
  `sigil-warn`, and both twins pass it to `DataTable`. It replaced `statusCell()`,
  a `format` that drew the STATUS cell as a `TableCellView` carrying the role, so
  the column is plain text now and measured as text. A role rather than a colour,
  so a theme recolours it. `should keep the table live, and draw a pod in trouble
  in its role across the row` mounts at colour level 1, where a role is a colour
  the resolved style can be read back for, and asserts every word of the crashing
  row is red with no role on any cell of its own, and a running row is not.
  Dropping `rowClass` from either twin fails it for that twin.

- **The tables pass `follow`, so the cursor stays on its pod (SIG-502).** The
  README said a table "keyed by namespace and name" kept the cursor on its row
  through every reading, and it did not: `DataTable`'s `follow` defaults to
  `false`, htop's behaviour, which keeps the cursor's place on screen and makes
  whichever row is there current. A key alone decides what the cursor and the
  ticks hold, not whether the cursor rides with its row. Sorted by CPU, every
  reading reorders the pods, so the one under the cursor became another pod
  whenever its place changed, and a rollout taking a worker out from above it
  did the same unsorted. Enter or `l` then opened a pod the reader never chose.
  This is a browser of resources one drills into, as k9s is, so following is
  the right mode. What it costs is the reason the table's default is `false`:
  sorted by a live column, the highlight can move every second. Here it moves with
  the pod the reader picked, which is the thing they are about to open. `should
  keep the cursor on its pod across a reading that reorders the table` sorts by
  CPU, ticks until the pod has moved, and asserts the cursor is still on it.
  Dropping `follow` from either twin fails it for that twin.

- **Not done:** a real cluster; and the log as a pager (SIG-387).

### A file manager in Miller columns, with a preview (SIG-294)

`examples/file-manager`, in the shape of yazi and ranger and borrowing nothing
of theirs but the shape: the directory above, the one the manager is in, and a
preview of the selection, moved through with the arrows or `h`/`j`/`k`/`l`.
Copy, move, rename and delete behind confirms, a filter, and dot files toggled.
The ticket asked whether to ship before highlighting and images landed; both had
(SIG-289, SIG-326), so it previews text highlighted, Markdown rendered and a PNG
in half blocks from the start.

- **Written twice, over a model neither root is.** The git client's shape and
  for its reason: `createModel()` in `src/model.ts` holds the states, the reads,
  the keys and the dialogs, and `root.tsx` and `root.ui.ts` build the three
  panels, the two `ListView`s, the filter bar and the footer, handing back what
  a key reaches through `attach()`. Each panel's `onKey` is assigned in
  `attach()` rather than spelled in both trees, which is one fewer thing for the
  twins to disagree on. The preview is a component in a shared module,
  `src/preview-pane.ts`, named by both.

- **The real file system, through a context, inside directories the tests make.**
  `FilesContext` is `GitContext` again: the directory the manager opens in and
  every call it makes to the disk, which `src/ui.ts` and `src/index.ts` provide
  with `[dir]` or the working directory. `test/fixture.ts` wraps each call to
  count it, so `settle()` waits for what the manager asked of the disk rather
  than for a time. Every copy, move, rename and delete a test runs is inside a
  directory `tempDir()` made, and the assertions read the disk. The contract tests
  run it in the repository with no provider, and it only reads there: Tab, `.`,
  `q` and Ctrl-C change nothing on disk. The `KEYED` entry presses `.` and waits
  for `Hidden files: shown`, which the status line says whatever the directory
  holds.

- **Three test files make directories, so the helper is the example's own
  module.** The git client's entry put the point at which the helper earns its
  place at a second file. `test/fixture.ts` exports `tempDir()` and
  `removeTempDirs()`, and each file registers the `afterAll` itself, since an
  example has no `vitest.config.ts` and so no `setupFiles` to hang it on.
  `tempDir()` resolves the directory's links, because macOS's temp directory is
  behind `/var`, a link, and a path the manager reads back is compared with one
  the test built.

- **Nothing is written over, and only a delete starts its confirm on No.** A
  copy whose name is taken gets the next free one, `a copy.txt` and then
  `a copy 2.txt`, which is what makes copying a file beside itself work. A move
  onto a taken name is refused: a rename of one of them first is the user's
  call, not the manager's. Neither puts a directory inside itself. A move asks
  again whether its name is free after the confirm, because `rename()` replaces
  a file on POSIX and on Windows without a word, and the confirm was time for one
  to appear; `should not write over a file that appeared while the confirm was
  open` writes one there. So copy and move lose nothing and start on Yes, and a
  delete -- which does not go to the trash -- starts on No, the git client's rule
  for what loses work. The checks are plain functions in `src/files.ts`
  (`planPaste()`, `planRename()`, `nameProblem()`, `isInside()`), asked before a
  confirm is shown, and tested without an app.

- **`t` moves to the trash, and `d` still deletes for good (SIG-481).** The
  ticket left open whether trash becomes the default; this keeps today's `d`
  exactly as it was, permanent and starting on No, and adds `t` beside it,
  through `@ttylabs/sigil/trash`. A trash loses nothing another program cannot
  give back, so by the rule above its confirm starts on Yes. The disk usage
  example does the same, with the same key and the same two confirms. Making `d`
  the trash and moving permanent delete to a modifier is the desktop's own
  arrangement and the likely end state; it is not taken here because it changes
  what a key that already deletes does, and that is Chris's call rather than a
  side effect of a helper landing. A trash that is refused leaves the entry and
  the cursor where they were, and the toast gives the entry's name and the
  `cause` of `trash()`'s error, since its message carries the whole path. The
  tests never reach the real trash: `test/fixture.ts` gives the mounted file
  system a `trash` that renames into a directory the test made, and the library's
  own tests cover the platforms.

- **A rename takes a name, never a path.** A `/` is refused everywhere and a `\`
  on Windows, where it separates too, so a rename can never move a file. A name
  that differs only in case is still a rename: on a file system that ignores case
  the new name is "taken" by the file itself, which `same()` asks by device and
  inode.

- **Hidden means a dot file, on every platform.** Windows also has a hidden
  attribute and Node does not read it, so a file Explorer hides is shown unless
  its name starts with a dot. The parent column always shows the directory the
  manager is in, dot directory or not, since that is where it is.

- **Every control character in a name or a file is drawn as `�`.** Not for the
  terminal's sake: a text element drops a control character before it is
  painted, so none reaches the terminal either way (measured, with a raw `ESC` in
  a text). Dropped, though, `bad<ESC>[31mname` is drawn as `bad[31mname`, a name
  that is not the one on disk, and a tab vanishes rather than indents.
  `printable()` from `@ttylabs/sigil/element` replaces one for one, so the
  highlighter's offsets still line up, and keeps `\n` and `\t` in a file for the
  pane to lay out; a tab is spaces to the next stop of four.

- **A preview reads the top of a regular file, and never opens anything else.**
  64 KB, cut back to the last whole line and then to 1,000 lines; a NUL in the
  first 8,000 bytes is binary (git's test); a PNG is decoded whole under 8 MB. A
  FIFO, a socket or a device is a note without being opened, since a read of a
  FIFO waits for a writer that may never come. A read is one at a time and a read
  the cursor overtook is done again for wherever it is when the first ends, so
  holding `j` reads two files rather than one per row.

- **Text is cut, not folded, and drawn by `codeRows()`.** A line is cut at the
  pane's edge behind a gutter of line numbers, the way a pager shows code, and
  drawn as runs of cells that share a token -- which is markdown's private
  `codeRow()` and `diff()`'s highlighted line written a third time, here. That is
  a duplicate of a decision and is recorded as one: a published code view, lines
  with a gutter over `highlightCode()`, is the gap. Markdown and the picture are
  built for the size `onResize` reports, the diff pane's way; the picture asks for
  no more than its own pixels and no more than the pane, inside `contain`.

- **The filter bar is shown with an inline `display` and a forced frame**, the
  log browser's workaround for SIG-384. The rename dialog's field is built under
  a branch of the component's owner and focused once the dialog is open (SIG-335,
  SIG-337), the git client's `owned()`.

- **The lit column is the sheet's: `.sigil-panel:focus-within`.** The git
  client's rule since SIG-372, and with nothing in the model: the column a key
  moved the focus into is lit, the preview once a file's `l` hands it over, and
  neither while the filter bar has it, since the bar is under no panel. `should
  light the column the focus is in, from the sheet` asks the cascade which panels
  the rule matches rather than reading the screen, because the test terminal is
  at colour level 0 and a border colour does not survive to it there.

- **`toMatchObject()` with a regular expression as a value matches any string.**
  Found by the sabotage pass: a test asserting `note: /Not a regular file/` passed
  against a preview that said something else, because vitest reads a `RegExp` as
  an object to take a subset of, and it has no enumerable properties. Every such
  value here is `expect.stringMatching()`.

- **Sabotage before review: fourteen, two survived and have tests now.** The `printable()` in a
  name, the parent column keeping the directory the manager is in, the delete
  confirm starting on Yes, the cursor remembered per directory, the taken-name
  check on a move, the next free copy name, the filter cleared on leaving a
  directory, the tab stop, a file's `l` going to its preview, the `..` test in
  `isInside()`, and the NUL test for binary each fail a test. Opening what is not
  a regular file survived behind the vacuous `toMatchObject()` above, and the
  move's second look at the name survived until the test that writes a file
  while the confirm is open.

- **Review round 1: ten findings, all fixed, eight with a test that fails
  without the fix and two by construction.** A rename is planned inside the
  operation chain rather than before it, so a copy still running ahead of it
  cannot take the name in between -- no test, since the window is the chain's
  and there is nothing left to hold open. A CRLF is a newline before anything is
  cut at one, so a cut no longer leaves its `\r` as a `�`; a read that stopped
  inside a character is decoded with `stream`, so its first bytes are held back
  rather than drawn; a directory read overtaken by a newer one says nothing even
  when it failed; a start spelled in another case is respelled from its
  directory's listing (the last name only), so `./readme.md` selects
  `README.md`; a rename onto another name of the same hard link is refused,
  since `rename()` would succeed and change nothing; a delete's next row is
  found by name, since a change that finished during the confirm replaced every
  entry (the second one without a test); a filter typed in the same read as `/`
  is now tested, which is what pins the forced frame; a real FIFO is listed and
  previewed by a test, which would hang rather than fail if one were opened; and
  the gutter goes where the pane cannot hold it and a cell of text.

- **Review round 2, over round 1's fixes: four findings, three fixed.** A
  case-only rename onto another hard link of the same file passed the inode
  check and did nothing, so a name the directory already lists exactly as typed
  is now taken whatever file it is -- on a file system that ignores case the
  directory lists only the old spelling. Its test can only run where case is
  kept, so it is skipped on a Mac and runs on Linux. A read that ended on a `\r`
  with no newline before it drew half a CRLF as `�`, and drops it now. A refused
  rename or move is a warning, as a refused paste always was, rather than an
  error. Not fixed: case is compared with `toLowerCase()`, not Unicode case
  folding, so a pair a file system folds and JavaScript does not (`i` and `İ`)
  is a name that is taken rather than a case-only rename, and a start spelled
  that way is not respelled. That is the safe direction to be wrong in.

- **Not done:** selecting several files, making a file or a directory,
  opening one in `$EDITOR`, and watching a directory (`R` reads it again).

### A dashboard, in the shape of shadcn's dashboard-01 (SIG-297)

`examples/dashboard`. shadcn's featured block as a list of parts -- a collapsible
sidebar, a header with a search and a menu, cards with trend badges, a chart with
a range selector, a table with sorting, selection, pages and a row menu, light and
dark -- built from sigil's own components, with its own data, names and colours.

- **JSX alone, and built,** for the settings screen's reason: a screen of a dozen
  components whose props are spelled out, all of them checked by the build's
  `tsc`. So there is no `src/ui.ts`.

- **The state is `createDashboard()` in `src/model.ts`, and each region is built
  over it in a module of its own.** The log browser's shape (`useBrowser()`)
  without the twin: the model has no elements, so `test/model.test.ts` drives the
  sort, the search and the pages without a screen, and `test/app.test.ts` drives
  the same state through the keys.

- **The table is sorted, searched and paged before `DataTable` sees it.** A
  `DataTable` sorts the rows it is handed and has no pages, so a page handed to
  it sorts as ten rows and the order stops at the page's edge. The model holds the
  `sort` State the table writes on a heading or a digit, orders the whole list with
  `cellOrder()` -- the table's own comparator, published from
  `components/table` -- over `SORT_VALUES`, which the table's columns read too, and
  cuts a page with `createPaginator()`. The table sorting that page again is a
  no-op that agrees, and `should sort every page by a heading digit` checks that
  page two carries on from page one. A status sorts by how much it needs looking
  at, not by its spelling. A new search goes back to page one.

- **The selection is ids, and outlives a page.** `ListView` never prunes
  `selected`, so ticks on two pages are still there on a third and the row menu
  acts on all of them. Building that found `DataTable` dropping its documented
  `selected` prop on the way to the list -- a table started with nothing ticked and
  an app's State never heard a Space -- which is fixed in
  `packages/sigil/src/components/data-table.ts`, with the regression test beside
  the table's own. A removed project leaves the selection with it.

- **System, Light and Dark, and the two named ones paint their own background.**
  `System` is no theme sheet: the framework's roles over the terminal's colours,
  light or dark as it reports. `Light` and `Dark` are the app saying which it is,
  which `prefers-color-scheme` cannot say -- it asks what the _terminal_ is, and the
  renderer fixes that at start -- so each sheet fills `.sigil-app`, sets every role
  (one left out would fall back to a default chosen for the terminal's scheme, a
  dim grey meant for black drawn on white), and fills the menu, the dialog, the
  toast and the tooltip, which are drawn on the root in the terminal's own colours
  otherwise and would punch a black hole in a white screen. Truecolor, since an
  app's own theme may use it. Swapped with `app.setTheme()` from an effect over the
  theme's State, so `t`, the account menu and a test all reach the screen one way.

- **The row menu opens under the row's right end, found by its classes.** Enter or
  a double click is the table's `onActivate`, and the menu is `openMenu()` beside
  the current row's last cell, an element rather than a point, so it right-aligns
  under the row -- or above it, where the row is too low for it -- and leaves the
  row in view, where a web table's row menu is. Nothing hands out the element a
  row was built as, so `currentRow()` walks the table for the `sigil-list-row`
  that is `is-current`, which `ListView` documents as hooks for a stylesheet. Each
  entry's mnemonic is distinct at its level (`R&edeploy` beside `&Delete...`),
  because a letter two items share only steps the highlight between them; the
  ticked rows' actions are a `Ticked` submenu for the same reason, so `p` still
  pauses the row the menu is about. A double click moves the cursor and activates
  in one handler, before the effect that moves `is-current` has run, so the menu
  settles a frame with `app.view.frame()` before it looks for the row --
  `flush()` from the signals is not enough, since the renderer runs its own
  effects. Both clicks have to arrive in one read for the gap to show, which is
  how the test sends them.

- **A card's badge is rebuilt when its figure moves.** `badgeView()` draws a
  fixed label, so `LiveBadge()` replaces it in an effect. The table's status cell
  is not a badge: ten solid green blocks down one column outshouted everything on
  the screen, so it is a mark and a word in the status's role, as a
  `{ element, width }` cell.

- **The sidebar collapses by a class, and starts collapsed under 100 columns.**
  Ctrl-B, which is shadcn's chord, toggles `is-collapsed` on the panel, and the
  sheet narrows it to 7 -- the panel's padding, the list's pointer and a glyph --
  and hides the labels, the usage gauge and the border's words. The list, its
  cursor and the page are untouched. The width is read once, from
  `app.terminal.width`, and not re-asked on a resize, the system monitor's
  footer's limit.

- **A short terminal gives up the chart before the table.** Media queries on the
  height drop the sparklines at 27 rows, the chart at 21 and the line beside each
  badge at 17; the table's own priorities drop the owner and then the region on a
  narrow one. The legend is in the chart's head, beside the range, rather than
  under the plot, where it would cost a row.

- **The data is generated and the calendar ends on a fixed day.** A seeded
  generator and 16 November 2026, so the tests assert on figures and a
  screenshot does not go stale. Nothing reads `Date.now()` or `Math.random()`.

- **Focus order, and the smoke test.** The sidebar has the focus on mount, so the
  arrows move between pages, and Tab goes to the search, the account menu, the
  range and the table. The harness Tabs four times from there and presses `q`, so
  the search must stay the first stop and not the last: a `q` is a letter there.
  At the harness's 16 rows the chart is not drawn, so its range is no stop and the
  fourth Tab is the rows-per-page dropdown, which takes a letter only where it
  starts an option, and its options are numbers. The spawned run
  presses Down and waits for `Analytics`, which at 60 columns is only in the
  header, since the sidebar starts collapsed there.

- **Not done:** the pages other than the overview, which say they are not drawn;
  re-collapsing the sidebar on a resize; a hover crosshair or an area fill on the
  chart, which shadcn's has and `LineChart` does not; and a `ui`-tag twin.

### A text editor with a Markdown preview (SIG-296)

`examples/editor`. A file tree, tabs over a text area with line numbers and
highlighting, the Markdown drawn beside its source as it is typed, save, a dirty
mark, a dialog before closing or quitting over unsaved work, and a command
palette. It is the hardest test the text area has had, and what it found is
below with the measurements.

- **JSX alone, and built.** The settings example's reason: one screen of props
  spelled out each time, all of them checked by the build's `tsc`. There is no
  `src/ui.ts`, so the harness's same-screen and unbuilt-entry checks do not run
  for it. The model is still a module of its own, `src/editor.ts`, with the root
  handing back what a key reaches through `attach()`, because a text area is
  built per file when it is opened -- which no template says.

- **SIG-289 is done, so the ticket's open question is moot.** The area is handed
  `highlightCode()` and the file's extension as its `lang`, for every file:
  `highlightCode()` marks nothing in a language it does not read, and the
  conditional that withheld it from such a file was deleted for surviving its
  sabotage, since a `State` value is joined on every key either way.

- **One text area per open file, hidden rather than rebuilt.** `Tabs`' rule for
  its panels, applied by hand: each keeps its caret, selection and scroll while
  another file shows. Each is built under a branch of the component's owner,
  because it is built from a key handler (SIG-335), and disposed when its tab
  closes. Showing one paints a frame before the next key, the log browser's
  `redraw()` for SIG-384.

- **A file opens at its first line because the editor types Ctrl-Home.** A text
  area puts the caret at the end of what it is given -- `TextField`'s rule, right
  for a field -- and has no handle to move it ("Not done" in the area's entry), so
  a 50,000-line file opened on its last line. The editor feeds `ESC [1;5H`
  through the router after the area has the focus. Sabotaged, sixteen tests fail.

- **The tab row is built again whenever a label changes.** `tabRowView()` reads
  its labels once ("Tabs", under "Not done"), and a dirty mark changes a label.
  An effect over the labels joined into one string builds a new row, under a
  branch it disposes with the old one, over the one `active` state -- so the
  showing tab survives the rebuild, and a focused row is focused again.

- **Dirty is a comparison, not a flag, and a clean file is not written.** A
  document holds the text as read or last saved and compares, so typing a change
  back out is clean, the settings form's rule. The area keeps `\n` and nothing
  else, so a file is written back with the line ending it was read with -- the
  first in it, `\r\n`, `\r` or `\n` -- and a file with more than one kind is
  made one kind by the first save that writes it. Which is why Ctrl-S on a file
  with no changes writes nothing: review round 1 found the first version
  converting a mixed file on a habitual save while the tab said it was clean.

- **A file that is not UTF-8 is refused, the way a binary one is.**
  `readFileSync(path, 'utf8')` puts U+FFFD in place of every byte it cannot
  decode and says nothing, so a Latin-1 `café` opened as `caf�`, and the first
  save wrote `EF BF BD` over the `E9` -- the same silent conversion as the line
  endings above, with nothing left to convert back from. `read()` decodes with a
  `fatal` `TextDecoder` and says `is not UTF-8`. It keeps the BOM
  (`ignoreBOM: true`), which is what the lenient read did, so a file that has
  one is written back with it. The NUL check reads the bytes first, so a binary
  file is still called binary. A lenient decode fails `should refuse a file that
  is not UTF-8, rather than save U+FFFD over it`, and a stripped BOM fails `should
  write a byte order mark back with the file it was read with`.

- **`q` is an `onKey` on the root, not a fallback.** Quitting over unsaved work
  asks first, and a fallback could not: every fallback on a key runs, so
  `runApp()`'s own `q` would quit beside it without asking. The root's `onKey`
  hears `q` from the tree, the tabs, the preview and the panes' edges, and stops
  it there; a text area and the palette's field type it. The quit dialog starts
  on Cancel and the close dialog on Save, since Save loses nothing and Cancel is
  Escape. With nothing focused, which the editor never leaves it, the runner's
  `q` would still quit unasked.

- **App-wide chords are sequences, and Ctrl-W is one of them.** `bind('ctrl+s')`
  and its siblings come before the focused element, so they work from inside the
  area, and after a dialog's own function binding, so they are quiet while one
  is open. That takes Ctrl-W from the area, which reads it as delete-word; an
  editor's Ctrl-W closes a tab, and Alt-Backspace still deletes a word.

- **The palette reads its cursor in the key handler, never through an effect.**
  The first version moved the cursor to the best match in an effect over the
  ranking, and an Enter that arrived before the next frame -- typing and Enter in
  one burst, which a test's `press()` is and a fast typist is too -- ran the row
  the cursor had been on: `Save`, for a query of `reload`. Effects run with the
  frame. So the field's `onChange` writes the cursor, Up and Down move it over the
  ranking rather than through the list's selection, whose rows are its last
  frame's, and Enter refuses a row the query has since dropped. `should run the
  best match when Enter comes before the next frame` is the regression.
  `commandPalette()` is not used because it is a prompt over a CLI's command
  tree; `rankBy()` and `highlightRuns()` are the half an app's own actions need.
  `openPalette()` hands back the command chosen and the caller runs it, after it
  has put down the flag that keeps a second dialog from opening under the first:
  run inside, Close and Quit -- which ask with dialogs of their own, and so refuse
  while one is open -- did nothing from the palette (review round 1).

- **A preview costs its element count on every key, so it is drawn live only
  while it is small.** Measured as of this change, on arm64 macOS: a key beside
  a 2 kB README is 6.4 ms; beside this file at 51 kB, about 9,000 elements, 145
  ms drawn live and 44.5 ms with the rebuild waiting for a pause -- because a
  frame lays the whole tree out again once any text in it changes, and the area
  changing is a text changing, so the preview is laid out on every key whether
  or not it was rebuilt. So `LIVE_LIMIT` is 16 kB, past it the rebuild waits for
  200 ms without a change, and past 256 kB the preview says it is too long: the
  components' 919 kB decisions file took seven seconds to build and a second a
  key with it showing. Windowing the preview by block was measured and refused:
  most of a decisions file is one list, which is one block. The README has the
  full table.

- **A highlighted 50,000-line file is 29.5 ms a key, and the same file as text is
  2.3.** The difference is `highlightCode()` over the whole value on every key,
  which is SIG-382's incremental highlight, measured and reported rather than
  built here.

- **Its temp directories are removed by the test file**, the git client's
  arrangement and its reason: one file makes directories, and an `afterAll`
  says what a `tempDir()` copy would.

- **Review round 1 found five things, and each has a test that fails without
  its fix:** Close and Quit doing nothing from the palette; `▸ src/` asserted
  where Windows lists `src\`; the line endings above; a long document's preview
  turned off and on again waiting for a pause, because the preview still
  remembered drawing it -- a preview put away has drawn nothing now; and a
  close test of three tabs, where the tab to the right of the middle one is also
  the last, so "always the last" passed it -- it has four. A paste test that a
  paste typed as keys would also have passed now pastes a tab, which a paste
  keeps and a typed Tab indents.

- **Sabotage: nineteen, none survived once a test was added for the one that
  did.** The Ctrl-Home, the line endings, dirty never true, the tab mark, closing
  without asking, the quit dialog starting on Quit, `q` no longer the root's, the
  palette's `onChange` and arrows, the preview always and never waiting, no
  preview limit, no highlighter, no `onCopy`, opening a file twice, the binary
  check, and Ctrl-PageDown not wrapping each fail a named test. Closing a tab
  always showing the first one survived, and `should show the tab to the right of
  one closed, or the one to its left for the last` is what catches it now.
  Highlighting every file rather than only the ones the lexer reads survived and
  the conditional was deleted, above.

- **Not done:** undo, which the area does not have; a new file, a rename and a
  delete from the tree; a search; reading a file changed on disk again; and
  showing the caret's line and column, which the area has no handle to read.

### A disk space visualizer, a size-sorted tree beside a treemap (SIG-474)

`examples/disk-usage`, in the shape of DiskSpace and borrowing nothing of it but
the shape: everything under a directory as a tree down the left with its total,
largest first, and a treemap of the same tree on the right, one rectangle per
file, nested by directory. One selection between the two, `r` to scan again, and
`d` to delete after a confirm. Where the file manager is about the files, this is
about where the space went.

- **JSX alone, and built.** The screen is two panels, a line and a footer, so a
  second syntax would compare a dozen lines of markup; what the example is about
  is the scan and the map, which are plain TypeScript either way. And the tree
  list view's `row` is typed against its items, which is the half of JSX that pays
  here. So there is no `src/ui.ts`, and `--version` is the one `sigil build` bakes.

- **The disk through a context, and every delete inside a directory a test
  made.** `DiskContext` is the file manager's `FilesContext` again, with three
  calls -- `list`, `stat` (an `lstat`) and `remove` -- and the root. `test/fixture.ts`
  wraps each to count it, so `settle()` waits for the disk rather than a time, and
  records every `remove`, so a test asserts the one path that went. Two test files
  make directories, which is the point the git client's entry gave for the helper
  to earn its module. The contract tests run it in the repository with no provider,
  and it only reads there: Tab, `r`, `q` and Ctrl-C. The `KEYED` entry presses `r`
  and waits for `Rescanned`, which a scan somebody asked for always says -- even
  one that threw away a first scan still running, as it is in the spawned run,
  where the key comes on the first frame.

- **The layout is squarified, in half-block pixels.** Bruls, Huizing and van
  Wijk's algorithm keeps rectangles near square, and on a grid of cells a thin
  sliver is a rectangle that cannot be drawn at all. A `Pixels` pixel is a cell
  wide and half a cell tall, which a cell twice as tall as it is wide makes about
  square, so the layout is done in those and square means square on screen. Edges
  are rounded rather than sizes, so two neighbours round their shared edge the same
  way and meet with no gap and no overlap; `squarify()` and `layoutTreemap()` are
  plain functions, and the library's `test/components/treemap.test.ts` asks them at
  sizes from 3 by 3 up.

- **The depth limit is the cell, not a number.** An item that would get fewer than
  nine pixels (`MIN_AREA`: three by three, two by two of colour inside its edge) is
  gathered with the rest of its directory's small items into one tile, labelled
  `37 more` or `+37`. A directory is divided only where it is at least three pixels
  a side and its largest item has room of its own; otherwise it is one tile under
  its own name. So a deep tree on a big screen is drawn deep, and a selection with
  no tile of its own outlines the tile it went into (`treemapMark()`).

- **Colour is the kind of file, never depth.** Seven kinds -- code, text and
  documents, images, audio and video, archives, binaries, other -- because at 16
  colours there are six hues and a grey, one each, and the selection is bright white,
  which none is. At 256 each is an RGB quantized by the library's quantizer; at
  truecolor it is shaded as a cushion (van Wijk and van de Wetering), which is what
  makes nesting show inside a colour. Not at 256: tried there, the cube cut each
  cushion into a few flat bands and moved its hue as it darkened -- a yellow tile
  went olive and then green at its edge, a blue one purple -- so one file read as
  several, of several kinds. Flat colours hold up at 256. Depth was not given the
  colour because it is already drawn, by the nesting and the edges, and the
  question a disk map answers is "what is it", which only a colour says.

- **Two neighbours never merge, at any colour level, because the edge is not a
  colour.** Each tile keeps its last column and row in the terminal's own
  background, and a directory directly under the one mapped keeps one more, so the
  first division reads at a glance. A colour-based edge -- a darker shade, a
  cushion's crease -- is gone at 16 colours, where two code files are the same
  blue. A tile of many files is a checker of two shades rather than solid, which is
  the one difference that survives level 0, where the map is blocks and spaces and
  a selected tile is drawn hollow.

- **Level 0 is `Pixels`' shapes.** At level 0 there is no colour to write, so
  `paintTreemap()` hands `Pixels.blit()` the level and it draws which pixels are on --
  `█`, `▀` or `▄` in the terminal's own colours -- rather than their colours. The
  map decides what is on itself: at level 0 it sets a pixel it wants lit to any
  colour and one it wants dark, a checker's second square and the inside of a
  selected tile among them, to `DEFAULT_COLOR`. This was the map's own blit until
  SIG-476 moved it into `Pixels`; the map still sets a lit pixel to a colour, so
  leaving the level out draws the same blocks with escape sequences in them, which
  `should paint no colour at level 0` fails on. A colour the map picks is quantized
  where it is picked, as the image component does, because degradation happens at
  resolve time and a `raw` paints after it.

- **The map repaints for what its paint reads (SIG-477).** The map and the swatch
  beside each file are `raw`, the image component's trapdoor. The map is built with
  `trackedRaw()`, so the root, the selection and the message it reads while it
  paints are what it is repainted for; it used to be `raw()` beside an effect that
  read the three again and called `invalidatePaint()`. The swatch reads no signal
  and is `raw()`. The layout is cached by the tree's identity
  and the size, so a move of the selection repaints over the same layout. Labels
  are written after the pixels, on a tile's first whole row, and moved off or cut
  short of the outline, which would otherwise lose its corner to a name -- and of
  the band inside it too, which is what stands the outline off the tile beside
  it. A name started on the band had the terminal's own background, so each
  letter kept whatever the half block under it had put in its background: the
  tile's colour in some cells and not in others, moving with the terminal's
  size. That rule moved into the library with the rest of the map (below), where
  `should keep a name off the band inside a mark, and give every letter a colour`
  in `packages/sigil/test/components/treemap.test.ts` fails without it.

- **Every name is black, on its kind's flat colour, at every level -- Chris's
  call.** The ink was black or white for whichever read on the pixel under the
  name's first cell, and that pixel is a cushion's: its kind's colour shaded
  from 0.42 to 1.25 times. Every kind's colour sits near the middle of the
  range, archives' green right on the cut-off, so within one kind some names
  were black and some white. Black on the flat colour reads at 4.8:1 or better
  on all seven kinds (WCAG contrast, measured), white on it at 3.8:1 at best,
  and the sixteen colours already wrote every name in black, so one ink holds
  at every level. The flat colour is the name's background whatever the shading
  under it, since one ink can only read on every name if every name is on one
  colour. In the library the colours are the app's, so it keeps the general form
  of that choice: the ink is picked once per tile, on its flat colour, as
  whichever of black and white has the higher contrast. That is black on all
  seven of this example's kinds, so the map draws what was chosen, and a dark
  colour an app picks still gets white. See "A name's ink is chosen once per
  tile" in `packages/sigil/src/components/AGENTS.md`.

- **The map is the library's `Treemap` (SIG-480).** The layout, the gathering,
  the mark, the paint and the click moved into `@ttylabs/sigil/components/treemap`
  with every decision above, and `src/treemap.ts` went with them. What stayed in
  `map-view.ts` is what is about files: a `DiskNode` read by its `bytes`,
  `children` and `path`; a label with a `/` on a directory drawn whole; the seven
  kinds' colours, handed over as the RGB above 16 colours and the hue of the
  sixteen at 16 (the map works out the darker shade and the bright twin, which are
  the pairs this example used to list); `parent` as `dirname()`, so a file deep in a
  directory drawn whole still outlines that tile; and `moreColor`, which colours a
  tile of gathered items by summing each directory's `mix` rather than counting it
  as its main kind -- the library adds up whole items, and on this repository's own
  scan that turned one tile from code-blue to image-magenta. Measured on that scan
  (28,375 files) at 150 by 45 and 300 by 80, the frame is what it was within the
  noise, and the cells are identical at every level; the bytes are too, but at
  256 colours, where a name is now drawn in black or white as at truecolor rather
  than in the terminal's own foreground. The figures are in the library's entry.

- **The scan is asynchronous, bounded, and shown as it goes.** Every read goes
  through a limiter of 48 in flight and nothing waits on a read while holding a
  place, so a directory waiting for its children never starves them; 178,988 files
  under `/Applications` took 4.2 s, measured as of this change. The scan writes its
  counts into one object and the screen copies them on a 100 ms timer, rather than
  a signal write per file. A scan from `r` keeps the last one on screen until it
  ends; one thrown away -- by another `r`, or by quitting -- changes nothing.

- **What a size is.** A file's length (`st_size`), not the blocks it holds, so one
  tree says one total on all three platforms and the tests can assert it exactly;
  a sparse or compressed file is shown at its length, which is the cost. A
  directory is what is in it, its own entry counting nothing, for the same reason:
  `4096` on Linux, a few hundred on macOS, `0` on Windows. Sizes are in powers of
  1000 with one decimal, `8.2 kB`, as the ticket spelt them and as a disk is sold.

- **Links: never followed, and a hard link counted once.** A symbolic link is
  listed and counts nothing -- its own few bytes differ by platform and Windows
  says `0` -- so a link to `/` costs one `lstat`. The root is the exception: it was
  named, so `createDisk()` resolves it once. A file with more than one name is
  counted at the name that sorts first by code unit, decided after the walk rather
  than by which name a concurrent walk reached first, so two scans of one tree
  agree; the others count `0` and the line under the panes says where it was
  counted. Deleting the counted name moves the bytes to the next one
  (`removePath()`), since deleting one name of a file frees nothing while another
  remains. Identity is `dev:ino` read as bigints, because an NTFS file id can pass
  2^53 and two files would compare equal.

- **A directory on another device is listed and not entered,** as `du -x` reads
  one. Scanning `/` on Linux would otherwise wander into `/proc`, whose `kcore`
  claims 128 TB, and into network mounts. A test cannot make a mount point, so it
  wraps `stat` to report another device for one directory.

- **Delete is permanent and starts on No.** The file manager's rule, for the
  reason it gives: a confirm that loses work starts on the answer that loses
  nothing. (It also said there was no trash that worked the same on three
  platforms without a dependency; SIG-481 wrote one, and `t` below is it.) The message says what is going and how much. The root is not
  deleted from here, and nothing is while a scan runs, since the tree on screen is
  about to be replaced; nor does `r` scan, or `d` ask again, until the disk has
  answered a delete, since a scan under an `rm` reads half of what it removes. A delete takes the sizes down at once, over the tree as it
  is now -- a new tree sharing every subtree it did not touch, so the list keeps
  its rows -- and a delete that fails part of the way scans again, since what is
  left is not something to guess at.

- **`t` moves to the trash, beside `d` (SIG-481).** The file manager's entry
  says why `d` is unchanged and `t` starts on Yes; this one keeps the same keys
  and confirms. Three things differ from a delete. The line says the bytes are
  freed when the trash is emptied rather than that they were freed. A trash that
  `trash()` reports inside the directory scanned -- a home directory on Linux,
  whose trash is `~/.local/share/Trash` -- is scanned again rather than taken
  down, since the bytes only moved within the tree. And a refused trash does not
  scan again: `trash()` moves the item whole or leaves it, so there is nothing to
  read. The guards are the delete's -- not the root, not during a scan, and
  nothing else while it is on its way -- by being one function, `removeSelected()`.

- **The tree's children are a function, and every scan write reloads them.**
  `TreeListView` keeps what a branch's function returned, by value, until it is
  told otherwise -- right for a directory read off the disk, wrong for a tree a
  delete or a rescan replaces, whose branches keep their values and change their
  children. So an effect over the scan calls `reloadAll()` (SIG-479): every open
  branch reads again over the new tree and a closed one when it opens, and the
  cursor, the open set and the scroll stay put. It was a getter until SIG-479 gave
  the tree a way to be told, which routed around the cache rather than using it.
  Each node's choice is still made once, so a read again hands back the same
  objects for a subtree the delete did not touch and the list keeps their rows; and
  a branch is read only when it opens, so a tree of 180,000 names costs what is
  open.

- **Enter is the tree's `onActivate`, described as `map it`.** It was the panel's
  for a while, because `describeListView()` could only say `enter open`, and a
  footer saying `open` beside `map it` is two meanings for one key -- which cost a
  double click on a row, since that is `onActivate` too. SIG-478 gave the
  describers the word: `describeTreeListView(input, tree, { activate: 'map it' })`.
  So a double click on a row maps it, as Enter does, and a click on the map
  selects. The test sends both clicks in one read, as a fast double click arrives.

- **The mouse is on.** A treemap is pointed at, and nothing on screen is text
  worth selecting, which is what a terminal reporting the mouse gives up. With
  motion since SIG-492, so that the line under the panes says what the pointer is
  over on the map -- name, size and share, or `40 more in work` for a tile of
  gathered files -- and the selection again once it leaves. A line rather than a
  tooltip, recorded under "A treemap" in `packages/sigil/src/components`.

- **The map takes the focus, and the arrows on it (SIG-491).** The library's map
  is focusable and moves between tiles by arrow, so the selection's keys --
  Backspace, `d` and `t` -- moved from the tree's panel to the box around both
  panels, where they reach it from either, and are described with that box as the
  scope. A pick on the map, by a click or an arrow, opens the tree down to it and
  no longer moves the focus to the tree: it did so because the map had no keys,
  and now it would take the focus off the map after every arrow. Enter on the map
  is its `onActivate`, `map it`, the tree's word for the tree's Enter.

- **`printable()` is the library's, as the file manager's is.** It was the file
  manager's, written again: a one-line rule, but a rule, and the root file says a
  helper has one definition, while an example is a unit somebody copies, so
  neither could import the other's. SIG-475 published it from
  `@ttylabs/sigil/element`, beside the text element whose set of control
  characters it shares, and both examples import it.

- **Sabotage: ten, two survived, and one of those has a test now.** A delete
  confirm starting on Yes, a device check that enters every directory, an edge
  coloured like the tile, a hard link whose bytes stay with a deleted name, a map
  that does not follow the selection out, a delete allowed during a scan, a
  selected tile drawn solid at level 0, and a failed delete not scanning again each
  fail a test. The hard links counted at whichever name the walk reached first
  survived, because a directory lists in byte order on the machines the suite runs
  on; the test now lists it reversed. The effect that called `invalidatePaint()`
  survived: a frame paints the whole tree once anything changed, and nothing in the
  app changes the map without changing a line of text beside it, so removing it
  changed no screen. SIG-477 replaced it with `trackedRaw()`, and
  `test/map-view.test.ts` mounts the map with nothing beside it, so building it with
  `raw()` again fails both of that file's tests.

- **Review round 1: eight findings, six fixed, each with a test that fails
  without its fix.** `r` and a second `d` were let through once the confirm
  closed and before `rm` returned, so a scan could read a directory half removed
  and put it back; the delete now holds both until the disk answers. A thrown-away
  scan's progress timer ran until its walk next looked at the signal, writing its
  counts over the scan that replaced it; it stops on the abort, and a read it had
  queued is never made. An item with room on paper could be laid as a sliver under
  half a pixel and round to nothing, and selecting it outlined the whole
  directory; `markFor()` now outlines a rest only for an item in it, and nothing
  for one not drawn. A rescan that failed over a tree said only `Scan failed`; it
  says why. A root that could not be listed was called empty. And the symlink test
  returned early where links cannot be made, passing on Windows while asserting
  nothing; it is skipped there now. Also added: the limiter's bound, a file whose
  `lstat` fails, and deleting the hard-link name that did not count. Not fixed: a
  file length past 2^53 bytes, 9 PB, is rounded by `Number()`; no file is that long.

- **Review round 2, over round 1's fixes: three findings, all fixed.** The
  thrown-away-scan test waited on the wall clock and could flake on a slow runner;
  it now waits for the first scan to be inside its read and for the replacement to
  say `Rescanned`. Worse, it had passed its sabotage for the wrong reason: a scan
  held in one subdirectory still rejects as soon as any other branch reads the
  signal, so its timer stopped anyway. Held at its very first read, the timer
  outlives the scan, and removing the fix fails it. A directory mapped with Enter
  that could not be read was still called empty: the map now reads the note off
  the directory it shows. And the queued-read test aborted before anything was
  queued, so a check outside the limiter passed it; it aborts while one read is in
  flight and two wait.

- **Not done:** renaming and opening files, which the ticket put out of scope; a
  filter by name or kind; the blocks a file holds, as against its length;
  and watching the disk, which `r` stands in for.
