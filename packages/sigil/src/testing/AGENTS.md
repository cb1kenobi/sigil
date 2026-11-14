# `packages/sigil/src/testing` — deliberate decisions

These are the entries from [../../../../AGENTS.md](../../../../AGENTS.md) that are about this directory. Claude Code loads this file when it
works with files here; other agents should read it before changing
anything in this area. The root `AGENTS.md` holds the rules that apply
everywhere and still applies in full.

How each of these was arrived at — the review rounds and sabotage
passes — is under [docs/history/](../../../../docs/history), linked from
the entry it belongs to.

## Deliberate decisions — do not "fix" these

### Testing helpers, and the faked TTY our own suite proves you need

We test ourselves exhaustively and shipped nothing for the person building on
us. The argument was never that `main()` is hard to call -- it is that this
suite is the evidence that getting it right is non-obvious, and every bit of
that knowledge was undiscoverable from outside this repository.
`src/testing/` is `@ttylabs/sigil/testing`: `runCommand()` over the real
`main()`, `runOnTerminal()` for the spawned child with faked `isTTY`,
`createTestTerminal()` plus `KEYS` for a prompt with no pty, and `Screen`.

- **A test runner's streams are pipes, which is the whole feature.** A vitest
  worker's stdout and stderr have no `isTTY` and no `columns`, so everything
  that asks about a destination gets the same answer -- not a terminal, no
  colour, the fallback width -- and that is the one case that cannot fail. **A
  suite can be entirely green and say nothing at all about what a user's
  terminal gets.** It is not hypothetical here: `report.ts`'s split between a
  laid-out form and a one-line form had every test pass while only the piped
  half had ever been looked at, and a regression in the other half shipped and
  was written down as verified. An app author will not derive that; they will
  write a test that passes at 80 columns with no colour and believe it.

- **It is a subpath of the runtime, and the measurement says that costs
  nothing.** A `@ttylabs/test` on its own version line was the alternative and
  is refused by the argument the registry already records: an app depends on
  `@ttylabs/sigil` at an exact version, so helpers that ship beside it always
  match the `main()` they run and the `Terminal` they fake, while a separate
  package could be a release ahead of the runtime under test -- which for
  `runCommand()` means running a `main()` that is **not the app's**. Two more
  reasons against, each one this file already records elsewhere: `packages/*` is
  the glob the workspace, turbo, vitest's `projects` and the coverage `include`
  all read, so a third package joins all four silently; and a second manifest is
  a second release gate for a thing whose whole job is to agree with the first.
  The first version of this said "three more" and listed two, which is the kind
  of count this file keeps finding stale.

  What a subpath costs is that it is permanent public surface on the package
  every app depends on at **run time**, so the question is the one the palette's
  packaging was decided on: the transitive static import byte weight of each
  entry's own graph, which is what an unbundled app actually loads. Measured
  before and after: the root entry went **7,553 B to 7,532 B** over the same six
  modules -- 21 B _less_, which is a shared chunk boundary moving and is noise --
  against a 20 kB ceiling. `testing.mjs` was **44,328 B over fourteen modules**
  when that was measured and is **48,740 B over fifteen** now, which is the
  figure `dist.test.ts` carries and the reason to re-measure rather than read
  either of them here. It is reached only by a file that imports it, which is a
  test file. The components entry moved 238,535 to 238,700 B for the same reason
  the root one did. So the cost to an app that answers `--version` is zero, and
  `should not load runOnTerminal to import the package` is what keeps it zero --
  with the presence half beside it, because a test that only asserts an absence
  passes forever the day the symbol is renamed.

- **Three of them are asserted through the published subpath as well as through
  `src/`, which is the half the runtime's own suite cannot check.** Everything in
  `packages/sigil/test/testing/` reaches these through vite, so it proves the
  source and says nothing about the `exports` map, the bundle, or whether
  `runCommand()` still reaches the `main()` that was bundled beside it.
  `packages/cli/test/testing-helpers.test.ts` imports by name, which is where a
  test that needs `dist/` belongs -- and it is the file the end-to-end claim is
  in anyway.

- **`runCommand()` is `main()`, and a reimplementation would be a second answer
  to what a parse means.** A helper that called `parse()` and then the command's
  `run()` would have to decide, again, that help outranks a missing required
  option, that `--version` is answered before the command runs, that a schema
  which declares commands and was given none prints help, and what a thrown
  value does to the exit code -- every one of which is a decision `main()` took
  and that this file carries the argument for. So the tests for it are mostly
  _that it is `main()`_: they would fail for a reimplementation and they pass for
  free over the real thing.

  What it adds is the three things `main()` writes to the process rather than
  returning, which is right for a bin script and useless to a test. Both
  `write`s, patched and put back in a `finally`. The **exit code**, read and then
  restored -- left alone, a test for a failing command sets the _test runner's_
  exit code and a green suite reports a crash, which is why `command.test.ts`
  has an `afterEach` asserting it for every test in the file. And the **parse state**, which
  `main()` returns only when the command returned nothing.

- **The state comes off the schema's own hooks, wrapped rather than replaced.**
  `main()` returns `(await run()) ?? state`, so a command that returns a value
  hides it and an error before the command ran returns `undefined`. `afterParse`
  is where it is read, because that fires after `processArgs()` and
  `processOptions()` have written `state.argv` and before anything judges it --
  which is the window that hook exists for, and it means a _failing_ parse still
  reports the values it produced. What is kept is the state **object**, so a
  write made later is in what this reports. `beforeError` is the second wrap and
  it is what puts the error object on the result, which is worth having because
  a message is translated and `instanceof` is not.

  Wrapped is the composition this file documents for a hook that is one function
  rather than a list -- read what is there and call it first -- and a
  `beforeError` that returns a replacement still replaces, because its return
  value is passed straight back: a helper that reported the original would be
  reporting something the app under test never raised. On a **copy** of the
  schema, because a schema is an ordinary object an app exports once, so a
  mutation would leave the wrap behind for every later run in the process.

- **A throw is not swallowed, and `errorHandler: false` is why.** That setting
  means the caller handles it, so a helper that caught it would be a second
  answer to what the setting means. What it costs is the captured output on that
  one path, which is the honest trade: pass no `errorHandler: false` and read
  `err`, `code` and `error`.

- **Two at once is refused rather than queued.** `process.stdout.write` is
  process-wide, so two runs would each capture a share of the other's output,
  which is not a failure anybody would read as one. A queue would make
  `it.concurrent` _look_ like it worked while doubling the wall clock of a suite
  whose whole point is that it is fast, and the fix is one word in the test file.

- **`disableConsoleIntercept` is the day-one detail, and it is measured.**
  vitest replaces the `console` methods so it can attribute output to a test,
  and a command that writes with `console.log` then reaches the reporter instead
  of the capture. Measured on the scaffolded app with its command switched to
  `console.log`: with the option on, two tests pass; with vitest's default,
  `ran.out` is **empty** and the test fails on a command that works perfectly.
  `sigil new` writes the config, with the reason in it.

- **`runOnTerminal()` spawns the real program and fakes three fields, because a
  pty is a dependency taken for a boolean.** What a program reads about its
  destination is `isTTY`, `columns` and `rows` on a stream, so the child is the
  real program over real pipes with an `--import` preload defining those with
  `Object.defineProperty` -- an assignment rather than a definition is a write to
  a property a piped `process.stdout` never declared, and what that does is not a
  thing to depend on. A `data:` URL rather than a file, so there is no temporary
  path to clean up and nothing platform-specific about where it lives.

  SIG-288 measured what a real one would cost and deferred it to a package of
  its own, built when the terminal element needs it -- see
  [docs/history/a-pty-package-outside-the-zero-dependency-core.md](../../../../docs/history/a-pty-package-outside-the-zero-dependency-core.md).
  That package would not change this entry. This module ships inside the
  zero-dependency core, so it can never import one.

  Two traps come with it and both are the fixture's to close. **The environment
  decides the colour, not the stream**: a stream claiming to be a terminal with
  no `TERM` behind it still detects level 0, so a test asserting colour would be
  asserting the one thing that cannot happen -- and a CI runner sets `CI` and
  `GITHUB_ACTIONS`, either of which decides the level for a destination that
  claims to be a TTY, so the same test would assert a different colour on a
  laptop than on each of CI's nine combinations. Every variable the detection
  reads is cleared and `TERM` is set when a stream claims to be one. **Chunks
  split mid-character**: a `data` event is a `Buffer` of whatever arrived, so the
  buffers are concatenated and decoded once rather than per chunk, which is where
  a `U+FFFD` in an assertion comes from -- pinned by 40,000 astral clusters,
  which is well past any pipe buffer.

  The colour variables are cleared **case-insensitively**, which is a Windows
  spelling rather than belt-and-braces: `process.env` is case-insensitive there
  and a spread of it is an ordinary object, so a `Ci` the OS handed over survives
  `delete env.CI` and the run would be deciding from a variable it meant to
  clear, on one platform of the three. Over-clearing is the safe direction --
  nothing reads a lowercase `ci`, and `env` puts back anything a run needs.

- **It writes nothing to the child's stdin unless asked, and a prompt is still
  not what to spawn it for.** This entry said it writes nothing, ever, and gave
  the reason: a prompt needs keys delivered over time and the far end held open,
  and write-and-close reports the stream ended. The reason stands and the
  absolute does not -- `stdin: true` is the opt-in, and "Typing into a spawned
  program" below is what it is. `createTestTerminal()` is still the answer for a
  prompt, because it is in-process with no clock; the spawned handle is for a
  whole program.

- **`runOnTerminal()` never throws, so every refusal is a rejection.** It was an
  `async` function and is not one now (see "Typing into a spawned program"), but
  the rule stands: a function
  that returns a promise and _sometimes_ throws synchronously is one a caller has
  to guard twice, and `.catch()` is the guard they will write. Exactly one of
  `run` and `source` is refused where it is written, because two answers to "what
  is being run" have no right one to pick between and a silent preference is a
  run that ignored half of what it was handed. No `shell`, because a shell means
  quoting rules that differ per platform over arguments a test wrote as strings.

- **A prompt is drivable in-process, and that is what the `proc` stub is for.**
  `run()` rejects outright when either end is not a terminal -- which is what
  stops a build hanging on a question nobody can answer, and is also what makes a
  prompt untestable from a runner -- and what it reads _from_ a terminal is bytes
  on an `InputStream`. Both are satisfiable by objects. The one detail nobody
  guesses is that `createTerminal({ proc })` takes a stub rather than
  `process`: a terminal installs `exit` and signal handlers and an `EPIPE` guard
  per stream, and a suite builds a great many terminals -- which is how
  `live.test.ts` came to leave eleven listeners on the **real** `process.stderr`
  and trip node's leak warning over streams those tests never meant to touch.
  Pinned by building twelve and counting the process's own listeners.

- **`press(...chunks)` sends each argument as one read, which is the distinction
  a prompt acts on.** A terminal delivers a keystroke as its own read and a paste
  as one read holding many characters, so `press(KEYS.up, KEYS.enter)` is two
  keystrokes and `press('chris')` is one read of five characters -- one method
  rather than a `press` and a `type` that differ in a way nobody could guess
  from the names. `paste()` is genuinely different and is its own method: a
  newline inside a bracketed paste is content where a typed Enter submits.

- **The surface lost a `frame` and a `written`, and both were traps rather than
  conveniences.** The harness this grew out of has a `frame` meaning "the last
  row anything was drawn on", which is the whole of a one-line component -- a
  spinner, a progress bar -- and is a trap for anything taller: `ui.frame` on a
  three-row list answers its last row, which nobody would call a frame.
  `lines.at(-1)` is that, spelled so nobody misreads it. `written` was `output`
  split into the chunks it arrived in, and a byte claim reads the stream. Both
  came off while checking that the README's examples were literally true, which
  is the cheapest review there is: what it caught first was a snippet reading
  `ui.lines` _after_ an arrow key and printing the pointer on the row it had left.

- **A size is refused and a delay falls back, which is two rules because they are
  two kinds of value.** `src/testing/numbers.ts` has both and is not re-exported,
  because a second spelling of "is this a count" beside the runtime's own would be
  API nobody asked for. A width is the caller's whole statement about the screen,
  so silently using 80 hides the mistake -- and it is refused by **asking** rather
  than by comparing, since every comparison against `NaN` is false: a
  `Screen(NaN, 8)` builds no rows, places a cluster into an array that grows under
  it, and reports a column nothing is at. A fraction is refused rather than
  floored, which is the rule a fractional length already follows. A `timeout` is
  the other kind and takes the rule every timer option here already has: a value
  that is not a finite number at or above zero is not an instruction, and a
  **finite** one past 2^31-1 is clamped rather than thrown away, because node
  stores a delay as a signed 32-bit integer and reads anything larger as `1`. Both
  reachable from a test file, which is where somebody writes
  `columns: process.stdout.columns` -- `undefined` under a runner.

- **`KEYS` is a written-out union rather than a `Record<string, string>`.** The
  bytes are not guessable and getting one wrong is a test that presses nothing
  and passes -- an unrecognised CSI decodes to a key whose name is its own
  sequence, and a prompt types nothing for it. With a `Record`, `KEYS.pagedown`
  is `undefined` and pressing `undefined` is a read of the word; with the union
  it is a type error. Frozen, because it is exported and a caller that wrote to
  it would change what every test in the process presses. `ctrl()` is arithmetic
  rather than a table -- the sixteen a prompt reads are no more special than the
  ten it does not -- and it refuses anything that is not one ASCII letter,
  because there is no byte for Ctrl with a digit and answering something would be
  a key nothing can press. `shiftTab` is the one shifted key, and that is not an
  omission: the legacy encoding has no spelling for shift with a plain character.

  What pins the bytes is the **decoder**, over every entry rather than four of
  them: `decodeKeys()` of what `KEYS` sends has to be one key whose
  `formatKey()` is the name it is filed under. A pair of literals could agree
  while both were wrong about the bytes, which is the rule the sequence grammar
  already keeps -- and the expectation is derived from the entry's own name, so
  `shiftTab` is checked as `shift+tab` without a second table to go stale.
  All fifteen pass, which is worth knowing: the four that had literals were the
  four nobody would get wrong.

> Moved: _What the sabotage pass found over the helpers_, _What the first review round found, and what it got wrong_, _What the second half of the first round found: the screen model_, _What the second review round found, and it was almost all the tests_, _Reading the prose against the code, which is where the rest of it was_, _Two of the tests were weaker than their names, found by reading them_, _What re-reading the code found that neither the pass nor a reviewer did_ — see [docs/history/testing-helpers-and-the-faked-tty-our-own-suite-proves-you-n.md](../../../../docs/history/testing-helpers-and-the-faked-tty-our-own-suite-proves-you-n.md).

#### The screen model's wide-cluster defect is fixed, not documented

`test/canvas/screen.ts` moved to `src/testing/screen.ts`, and the limitation
this file recorded about it is **gone** rather than written into the public
docs. What it said was that the model advances one column per character, so a
picture over a row holding a wide cluster is not to be trusted -- and the
sentence under "The extraction, and what it was allowed to touch" in
`src/components` that said so has been corrected.

- **It was worse than one column per character: it was one per code unit.**
  `output[i]` indexes code units, so `日` took one column where a terminal gives
  it two, an astral cluster was written as two lone surrogates into two cells,
  and a combining mark took a cell of its own. Shipping that to an app author as
  "the model a frame is replayed against" is shipping a picture that is wrong
  about any row with one wide character in it -- which for a CLI with a Japanese
  locale is every row.

- **So it reads grapheme clusters, measured with `cellWidth()`, and a wide one
  leaves a `''` continuation.** The same convention `CellBuffer` and
  `fake-terminal.ts` already use, for `CellBuffer`'s own reason: without the
  marker there is no answer to "what is in column 40" for a row holding one wide
  character, and every read after it is a column out. `cellWidth()` rather than
  `graphemeWidth()` because the grid and the diff both take two as the most a
  cluster can occupy -- asking what a cluster _contains_ put `fake-terminal.ts` a
  column right of where the diff said the cursor was, which is a mistake already
  made once here. `cellAt()` is the accessor that makes a wide-cluster claim
  assertable at all, since a row read as a string says what the user sees and
  cannot say which column anything starts in.

- **Overwriting either half of a cluster takes the other with it**, which is
  `CellBuffer.#breakCluster()`'s rule one layer up and for the same reason: half
  a glyph is not a state a screen can be in, and a row that kept the survivor
  reads a column wider than itself. The erase paths go through the same repair,
  because writing a space over a continuation and erasing one are the same thing.
  A resize that truncates a row repairs too, since the continuation can be
  exactly what `pop()` took.

  Which turned up a second thing the first fix got wrong: the caret record has to
  go with the cluster it was marking, and the cell that goes is the **lead's** --
  one column left of the continuation being written over, which is a cell the
  write itself never touches. So `#put()` clears the record against every cell it
  changed, the repaired ones included, rather than against the ones it wrote.
  Found by a test, not by reading.

- **The one place it parts company with the grid is a wide cluster with one
  column left.** `CellBuffer` **refuses** it and lets a blank take the column,
  because a grid is a fixed rectangle an app owns; a terminal has a next row and
  wraps the cluster onto it, so that is what this does. The two models answer
  different questions and this one is about a screen. On a screen one column wide
  there is no row it fits on and it is dropped, which is the one answer that
  leaves no half glyph and does not loop looking for one.

- **The existing suite is the regression suite and it did not move.** Which is
  the check a refactor of a shared harness gets, and it is stated as a diff
  rather than as a count, because the counts grew while this was being written
  and a figure nobody can re-derive is the stale snapshot this file keeps finding:
  the whole change to the model's four existing readers -- `backend.test.ts`,
  `components/helpers.ts`, `renderer/mouse.test.ts` and `renderer/renderer.test.ts`
  -- is **four import lines**, and not one assertion in any of them moved.
  Checked with `git diff main...HEAD` over those four rather than inferred from a
  green suite.

  The model's own diff is a larger thing than that, and it grew in two steps: the
  cluster work plus `cellAt()`, an import path and a `' '` spelled as `BLANK`,
  and then the twelve the review round found -- `ESC[H`, `K` and `J`'s modes, the
  held partial sequence, four `lastInverse` cases, the resize cursor, the
  mode-change wrap, the saved-cursor clamp and the dimension guard. The sentence
  this replaces listed only the first step and was substantially false by the end
  of the branch. The text run is segmented up to the next control character rather
  than asking `graphemes()` for the whole remaining string per cluster, which is
  the same answer and is linear rather than quadratic in the length of a frame.

- **`ESC[H` was the one cursor move with no clamp, and it lost every frame after
  it.** Found by walking the hostile inputs rather than by a test: `A`, `B` and
  `C` all clamp, and this set the row to whatever the parameter said -- so
  `ESC[99999H` put the cursor on row 99998, every write after it landed on a row
  that does not exist and was dropped by `#put()`, and the cursor never came
  back. Silent, and every later frame lost. Pre-existing, and it ships now, which
  is what made it worth fixing rather than noting.

  Its **column** parameter was ignored with it: `ESC[5;10H` is row 5 column 10
  and was taken as row 5 column 0. Nothing in this library emits the
  two-parameter form -- the only `H` it writes is a bare `ESC[H` -- so that half
  is for a caller pointing the model at their own output, which is what shipping
  it means.

- **It throws on a sequence it does not model, and the docs say so.** That is
  how it says it has no answer rather than quietly getting a row wrong, and it
  is the same policy the `default` branch already had. Walking the inputs
  confirmed the rest: a tab, a `BEL` and a `NUL` each take no cell rather than
  reaching a row a test reads as a picture; a ZWJ family, a flag and an astral
  character are each one cluster at their real width; an erase that cuts into a
  cluster takes both halves; and a huge or absent parameter on `A`, `B` or `C`
  clamps. A lone surrogate does get a cell, which is the model being faithful to
  what was written rather than a defect -- a terminal draws something there too.

- **What it still does not model is styling, bar reverse video.** That is a
  limitation rather than a defect and is documented where a caller meets it --
  the Testing guide, since SIG-323: a claim about _colour_ belongs in a `runOnTerminal()` run, where a
  real styler writes real sequences a test can read. `lastInverse` is the one
  exception and stays the one exception, because a prompt's caret _is_ styling and
  the cell under it holds the same character either way. An erase still leaves the
  record in place, which is what it always did and is why the doc says a test
  asking whether a caret went away reads the bytes.

#### What is deliberately out, and one finding that is somebody else's ticket

- **No stdin writing in `runOnTerminal()`** was the position when this was
  written, and SIG-309 reversed it: see "Typing into a spawned program".
- **No rewrite of `output-forms.test.ts` onto the fixture.** It would be the
  strongest possible proof that the helper is sufficient for the hardest real
  case here, and it is the regression suite for the two output forms: a refactor
  that needed a test moved is a refactor that changed behaviour, and that one is
  nine hundred lines of exactly the claims nobody should risk weakening inside a
  ticket about helpers. `packages/cli/test/testing-helpers.test.ts` makes the
  narrower claim instead -- the shipped helper is enough to have caught the
  regression that shipped -- against the real binary over the real fixture.
- **No `runRender()` or any helper for `renderToString()`**, which takes its
  width and its colour level as arguments and is already testable from anywhere.
  A helper over a function that needs no helper is API for its own sake.
- **No assertion helpers.** `expect(ran.out).toContain(...)` is the runner's job,
  and a `expectOutput()` of ours would be a vocabulary to learn that works with
  one runner.
- **No demo under `demos/`.** Those are runnable examples of what an app _does_,
  spawned by `demos.test.ts` and read by somebody looking at a terminal; a
  testing helper has nothing to show there. What it has instead is the
  documentation, which is most of the value of the ticket -- the README section
  then, the Testing guide since SIG-323 -- and the scaffold, which puts a working
  one in front of every new app.

- **A root schema's `run` was never dispatched, so `sigil new --single`
  scaffolded an app that did nothing -- reported here and fixed in SIG-150.**
  Found while writing `command.test.ts`, whose first fixture put `run` on the
  schema the way the scaffold does. `main()` ran the command that **matched**
  and the root is never one, so `main({ schema: { name, args, run } })` parsed
  argv, wrote nothing, ran nothing and exited zero. Measured: the as-scaffolded
  single app answered `demo world` with **no output at all**, while the same app
  with the `run` moved into a hidden `default` command answered `hello world`.

  Deferring it was right and the avoidance it cost is the part worth keeping:
  the generated test covered the **multi** layout end to end and asserted
  `--help` for the single layout, which did work, with the measurement written
  down beside it rather than the broken path quietly skipped. What the deferral
  then bought is visible in the fix: `main()` dispatching a root `run` reads as
  a change to every app's semantics and is not one, because a `run` that never
  ran has no behaviour to preserve -- an argument nobody had made while this
  entry was the only place the defect was written down. The full rule is under
  "`main()` dispatches a `run` on the schema" in the root `AGENTS.md`, and the
  single layout's generated test now asserts the greeting the way the multi
  layout's does.

  Its `--help` is wrong in a second way that is **not** fixed and is not this:
  `Usage: demo [options] <command> [who]` names a `<command>` when the only
  commands are the two the framework adds, because the registry is never empty
  and the usage line reads the registry. Left alone deliberately -- it is a
  question about what help prints for an app with no commands of its own, which
  is help's to answer and not a dispatch rule.

### Typing into a spawned program, waiting for a frame, and the colour level (SIG-309)

The examples harness and the system monitor's tests hit the same three limits.
`runOnTerminal()` faked the child's output and never wrote to its stdin, so the
harness mounted each root in-process and the monitor's builder fell back to
`script(1)`; there was no way to wait for a frame, so tests slept 50ms and
polled a screen until it stopped changing; and `createTestTerminal({ colorLevel })`
did not reach `render()`, so the level was said twice. None of them needed a
dependency.

- **Stdin is a terminal the same way stdout is, by the same preload.** The
  child's `process.stdin` gets `isTTY: true`, a `setRawMode()` that accepts the
  call, returns the stream and records the mode on `isRaw`, and the far end is a
  pipe held open. `createInput()` asks `isTTY` and calls `setRawMode` optionally,
  which is all a real app does with stdin, so the whole of the
  `examples/` entries run unmodified: `main()`, the schema, `runApp()`, the
  capability queries going out unanswered. It is the same `defineProperty` module
  rather than a second mechanism, for the reason `streamsOf()` records for the
  other two.

- **It is `stdin: true`, an option of its own, and `tty: true` does not imply
  it.** Stdin has been `/dev/null` since this was written, and a program that
  reads it to the end gets end-of-file at once; on a pipe nobody closes it hangs.
  So the default must not move, and `tty` is about output (`FakeableStream` is
  still `stdout | stderr`). A test that wants both writes both. TERM is set for
  either, since a stream claiming to be a terminal with no `TERM` behind it
  detects level 0.

- **The handle is the promise.** `runOnTerminal()` returns a `Promise` carrying
  `press()`, `paste()`, `waitFor()`, `kill()`, and the child's `screen`,
  `viewport`, `lines` and `output`, because a full-screen program ends when it is
  told to, so the handle has to exist before the promise settles. `await
  runOnTerminal(...)` is what it was, and `.rejects` still works, since it is a
  real promise. It stopped being an `async` function to do this, which is the
  decision the "`runOnTerminal()` never throws" entry above protects the _reason_
  for: every refusal is still a rejection. A refusal is a rejected handle whose
  methods reject with the same error, rather than a handle with nothing on it or
  a synchronous throw. The names and the key vocabulary are
  `createTestTerminal()`'s -- `press(...chunks)`, `paste()`, `viewport`, `lines`,
  `output`, `KEYS`, `ctrl()`, `alt()` -- so one test reads the same in-process
  and spawned, and `checkChunks()` and `bracketed()` are shared so the
  refusals say the same thing.

- **Order is promised and read boundaries are not.** In-process, `press('a', 'b')`
  is two reads, because a `PassThrough` emits synchronously from `write()`. Over
  a pipe the kernel may hand the child two writes as one read, and does so more
  often than not for writes made back to back: measured, `press('a', KEYS.up,
  ctrl('c'))` reached a child as `a`, then `ESC [ A ETX` in one read. Nothing the
  router or a prompt does depends on it -- it joins a held tail with the next
  read and serialises a chunk's keys through one queue -- and `paste()` is the
  distinction that is observable. A test that asserts on read boundaries over a
  pipe is asserting on the kernel; the spawn tests join the bytes instead.

- **`press()` resolves when the bytes are on the pipe, not when the program drew
  what they caused, and that is `waitFor()`.** The program paints on its own
  clock and the only thing this process sees is bytes. `waitFor(text | RegExp)`
  looks at the viewport and at the main buffer of the **replayed screen** --
  never at the raw bytes, because a frame is a diff and the bytes of a repaint
  hold no text a reader could match. It rejects, with the screen in the message,
  if the program exits first or `timeout` (5s) passes, and clears its timer
  either way. The `ready` detector in `quiet-forms.test.ts` looked for a `?` in
  the bytes and was fired by `ESC [ ? 25 l`; reading the screen cannot be.

- **The live screen decodes as a stream and survives what it does not model.**
  A `StringDecoder` feeds the model, so a character split across two `data`
  events is not a `U+FFFD`, while `RanOnTerminal.out` is still concatenated and
  decoded once. The model throws on a sequence it has no answer for, and a throw
  in a `data` handler is an uncaught exception in the test runner; so it is
  caught, remembered, and rethrown from `viewport`, `lines`, `screen` and
  `waitFor()`, where the test is reading. `screen` is guarded too because a model
  that stopped listening during teardown leaves `alternate` and `cursorHidden`
  frozen at what they were, and a test asserting the screen was given back would
  be answered by it.

- **`Screen` models the questions a program asks, as nothing, and only those.**
  Before its first frame an app asks what the terminal is -- `ESC [ c`,
  `ESC [ > q`, `ESC [ ? 2026 $ p`, `ESC [ 14 t`, `ESC [ 6 n` -- and the model
  threw on the first, which for output replayed as it arrives was the first thing
  every full-screen app wrote. The CSI pattern reads the four markers and the
  intermediates now, so a sequence can be told from the plain final byte it
  shares, and `QUESTIONS` lists by marker, intermediates and final the ones known
  to change no cell: `> c`, `= c`, `> q`, `$ p`, `? $ p`, `SP q`, and the kitty
  keyboard `> u`, `< u`, `= u`, with the plain `c`, `t` and `n` in the switch.
  Everything else with a marker or an intermediate **throws**, as it did before
  any of this. The first version passed all of them -- `if (marker || intermediate)
  continue` -- and the reviewer's probe found what that swallowed: `$ z`
  (DECERA, erase a rectangle), `$ x` (DECFRA, fill one), `SP @` (SL, shift
  columns), `' }` (DECIC) and `! p` (DECSTR, a reset that shows the cursor), each
  a sequence that changes cells and each a screen that quietly disagreed with the
  terminal. `$ t` and `$ r` (DECRARA, DECCARA) were worse: their final byte is the
  window operation `t`, so a switch keyed on the final alone would have taken them
  for a question. The list is what sigil sends (`c`, `> c`, `> q`, `$ p`, `6 n`,
  `14 t`, `16 t`) plus what any program might and no cell moves for; a question
  that is missing from it is a loud failure naming the sequence, which is the
  right way round. The harness runs its entries with `detect` on, so the queries
  go out and nobody answers, which is the real case for a CI run with no terminal.

- **What it cannot give a program, and does not claim to.** No mode: nothing is
  cooked or raw, nothing echoes, Ctrl-C is a byte and not a signal. Raw mode is
  recorded on the **child's** `process.stdin.isRaw`, which the parent cannot read;
  a side channel back to the parent (a fourth fd) was refused for a mode that the
  screen model already shows the effect of -- an app that leaves the alternate
  screen and shows the cursor again has run its teardown, which is what restoring
  raw mode rides on. No `resize()`: a child learns its size from `stdout.columns`
  and a `SIGWINCH` that does not exist on Windows. The window size is the one
  `columns` and `rows` set for stdout; a terminal's input has no size to agree
  with.

- **`frame(app)` paints a frame now, and does not wait for one.** The clock is
  `FRAME_MS`, about 30 a second, so a key leaves the screen as it was until the
  next tick, and so does anything an `onMount` wrote. Three shapes were available
  and two refused:

  - `await term.frame()` on the test terminal. The terminal can only see bytes
    written, and a frame that finds nothing dirty writes none, so it would hang
    exactly when the answer is "nothing changed". It also has no way to know there
    is an app at all.
  - An awaitable that resolves on the _next_ frame the renderer paints. Same hang:
    a program with nothing dirty never schedules one.
  - **Forcing one**, through `Renderer.frame()`, whose own doc says "settles and
    paints a frame now, whatever the pacing says". That is deterministic and
    costs no wall clock, which is what removed `settled()` -- two frame periods of
    polling per mount -- from the harness. It takes the app (or the renderer
    `render()` returned), checks `running` first because `view` throws for an app
    that refused, and takes one `tick()` on either side: before, so a key's
    promise chain has run; after, so the effects the frame ran have.

  **A claim this ticket was opened on did not survive measurement:** that a key
  pressed before the first frame reaches no focused element, because the first row
  takes the focus in `onMount`, after the first frame. In-process, `onMount` runs
  synchronously at the end of `render()`, `hello`'s focus exists before any frame,
  and a key pressed straight after `runApp()` counts -- removing the leading
  `frame()` from the guide's test fails nothing. What lags is the screen, by a
  tick, and anything an `onMount` _wrote_ to a signal, which lands in the frame
  after the first paint (`frame.test.ts` pins that one). The old guide paragraph
  saying otherwise is rewritten.

  What it does not do is cover a handler with async work of its own, which is
  `await frame(app)` again: the monitor's `settle()` calls it four times, for a
  sampler that resolves, a state write and the frame it asks for. A spawned
  program paints on its own clock and is `waitFor()`.

  `frame.ts` imports `App` and `Renderer` as **types only**, so it adds nothing to
  `testing.mjs`'s static graph.

- **The colour level is the terminal's.** `Terminal` gained an optional
  `colorLevel`, `TerminalOptions` a matching one, and `render()` reads it between
  an explicit `colorLevel` option and `supportsColor()`: `refined ?? opts ??
  terminal ?? environment`. `runApp()` hands its options to `render()` so it
  inherits it. A test terminal sets it from its own `colorLevel`, **0 by default**,
  which is the `ansi` it already built -- so the level is said once, where it was
  said twice (the monitor's `mount()` passed it to both). An explicit option still
  wins, because a caller who names a level has decided, and the detect reply still
  refines it upward, since `refineColorLevel()` refuses to raise off 0 and nothing
  else changed.

  **A real terminal is unchanged**, and that is what the optional field is for:
  `createTerminal()` without a `colorLevel` leaves it `undefined` and the renderer
  asks the environment as it always did. A getter that detected from the
  terminal's own `env` and stream was the alternative and was refused, because it
  would change what a custom `createTerminal({ stdout })` answers for every app
  that builds one. `frame.test.ts` pins both halves, with `FORCE_COLOR` standing in
  for the environment. The cost, which is deliberate, is that a test terminal at
  its default now renders at level 0 where it used to take the worker's
  environment, which `FORCE_COLOR` in a CI runner could make anything: that is the
  nondeterminism this file records everywhere else. The components
  too, which the first version left: `opts.colorLevel ?? (opts.ansi ??
  defaultAnsi).level` was spelled out at 23 sites and beat the terminal's level
  with the environment's, so a prompt handed `terminal: ui.terminal` and no `ansi`
  -- the README's own `select()` example -- wrote colour on a level-0 test terminal
  under `FORCE_COLOR=3`. They all call `colorLevelOf()` in
  `components/color-level.ts` now: a named `colorLevel`, then a handed `ansi`, then
  the terminal's, then the environment's (`log`'s own stream detection, for the
  one caller that has one). A view builder whose options carry no `terminal`
  passes none, and is unchanged. `color-level.test.ts` imports the prompt after
  setting `FORCE_COLOR`, because the default styler reads its level once.

  **One caller depended on the old order, and said so in a comment**:
  `website/scripts/lib/home-scenes.mjs` drove prompts through
  `createTestTerminal()` under `FORCE_COLOR=1` on the claim that "a terminal handed
  to it is not asked". It is now, so the captured home screens lost their colour
  until the scenes built their terminals at `ansi.level` -- the level the process
  came to -- which is the same screens by the stated rule instead of by the
  accident. `colorLevelOf` is exported from `@ttylabs/sigil/components` because
  `sigil add` copies components out and a sibling file would not travel; the
  website's component list files it under helpers.

- **A failed test must not leave a child behind, and must not be told twice.**
  A test that fails at a `waitFor()`, or at an assertion before `await run`,
  never reaches the line that would end the child, and the child lives until the
  run's own timeout -- 30 seconds by default, 120 in `quiet-forms` -- while the
  base promise then rejects with nobody listening. The reviewer's probe: an
  unhandled rejection at 1.5s from a test that had failed at 0.2s. Three things
  follow, and none of them is a kill on the library's own initiative, which would
  end a program the caller meant to keep:
  - **The tests end their children.** The two migrated tests hold the spawned work
    in `try { ... } finally { run.kill() }`, which is safe after the exit. That is
    the rule for any test that can fail between starting a run and awaiting it,
    and it is in `runOnTerminal()`'s doc comment.
  - **A method that delivers the run's own failure takes the base promise off the
    hook, and no other rejection does.** `waitFor()`, `press()` and `paste()` mark
    the run handled only when the error they reject with _is_ the run's `failure`
    (the spawn error, or the kill for time), so that failure is reported once,
    through whichever API reached it first. The first version marked the run
    handled whenever any method rejected, and round 2 found what that hid: a test
    that expects a wait to fail, catches it, and walks away from a child that is
    killed for time later -- or a `press()` refused for want of `stdin: true` --
    had its run's real failure silenced for the whole run. A method's own refusal,
    or a wait that timed out, says nothing about the run, so a later failure is
    still reported. A refused handle is the exception that proves it: its method
    rejects with the base promise's own error, so it always marks it. `await run`
    still rejects, since marking a promise handled does not settle it differently.
    Marking after the base has already rejected is skipped, since it cannot help
    and only prints Node's "handled asynchronously" warning (the one sabotage
    that survives, because a warning is not something a test observes).
  - **The cause is told to a pending wait before the run rejects with it.** A
    `cwd` that is not there is `spawn ENOENT` as an event, and `waitFor()` said
    "the program exited before the screen showed", which names nothing that
    happened: nothing ever ran. A spawn error and a kill for time are recorded as
    the run's `failure`, handed to every pending wait before the base promise
    rejects, and returned to a later `press()` or `waitFor()` in preference to
    "already exited".

- **Sabotage: fifteen against the helpers, all caught, and two survivors in the
  harness that are said rather than hidden.** `frame()` not painting, and without
  its `running` check; `setRawMode` absent from the preload, `isTTY` absent on
  stdin, and `setRawMode` not recording; the `StringDecoder` replaced by per-chunk
  decoding; `waitFor()` reading the bytes instead of the screen, and its timer left
  uncleared; `tty` implying `stdin`; the model's error left to throw from the
  `data` handler; `Screen` throwing on a query again; `render()` ignoring the
  terminal's level, the terminal's beating an explicit option, and the test
  terminal not passing its level on; and `press()` not waiting for the write. Two
  of those were found by writing the sabotage rather than the test -- the
  screen-versus-bytes one and the timer one had no test until the pass asked.
  In the examples: `hello`'s trailing `frame()` removed fails, the harness's
  spawned `stdin: true` turned off fails, the monitor's `settle()` without its
  `frame()` fails 24 tests. **Survived:** the leading `frame()` in `hello`, which
  is why it is gone, and `mount()`'s call, which is kept for the first example
  whose mount draws something and is said so in `examples/AGENTS.md`.

  **Review round 1 added** the failure paths above, the explicit question list,
  the guarded `screen`, `colorLevelOf()`, and a spawned example test that waits on
  the app's own frame clock (`hello`'s Enter, then `waitFor('1 press')`) because
  `frame()` forces the frame and no in-process example test exercises the clock
  any more. Their sabotage pass is in the commit message.

### The Testing guide is the documentation, and it is run (SIG-323)

`packages/sigil/docs/testing.md` is where these helpers are documented, at
`/docs/testing` on the website, and it is a guide rather than a reference:
each helper with the problem it solves, and a recipe for a command's output
and exit code, an error, what a terminal changes, what is on the screen, a
prompt, and a full-screen app.

- **The README's `## Testing` section is a summary and a link.** Kept under its
  heading, so `#testing` and the table of contents still land, and cut to a
  list of the helpers because two full descriptions of one helper are two that
  can disagree. `should name every export in the Testing guide` in
  `packages/cli/test/testing-helpers.test.ts` moved with it: every export and
  every declared field has to be named in the **guide**, and only where its
  prose names it as an inline code span. A fenced example does not count,
  because the guide's own `sync` command calls `bar.tick()` -- the same hole the
  README version had with `tick`, `alt` and `ctrl`, and the reason the match is
  no longer a bare `includes()`.
- **Its examples are tests, so the replay runs them.** `guides.test.ts` writes
  each `// <path>` block and runs each `$ my-cli` line, as it does for Getting
  started, and a `$ npm test` line is now a step of its own: the app's own
  vitest, linked into the scaffold beside `@ttylabs/sigil`, over every file the
  guide has written by then. It has to exit `0`, and the summary lines the
  transcript shows have to be in its output in that order -- a summary carries a
  start time and a duration, so the transcript elides with `...` and the
  comparison cannot be the exact one a run gets. Getting started's `$ npm test`
  is checked by the same rule now, where it used to be on the skipped list. The
  worker's own `VITEST*` variables are taken out of the environment first, so
  the nested run is the app's suite rather than a confused worker of ours, and
  the website's capture script skips these steps, since there is no fixed
  output to capture. Sabotaged both ways: a test on the page asserting `7` for a
  sum of `6` fails the step and names `sum.test.ts > prints the total`, and a
  transcript claiming `16 passed (16)` fails it on the summary line.
- **The nested vitest names its reporter and runs with `NO_COLOR`.** vitest picks
  both from the environment: under a coding agent std-env's `isAgent` makes it
  `minimal` and plain, and anywhere else -- CI included -- it is `default` and
  coloured, because tinyrainbow colours unless `TERM` is `dumb` and never asks
  the stream. So the first push matched locally and found none of the summary
  lines on all nine CI jobs. `--reporter=default` and `NO_COLOR` make it one
  answer, checked in both environments, and both sabotages still fail in the
  CI-like one. The app's own tests are unaffected: `runOnTerminal()` clears
  `NO_COLOR` in its child, and a test terminal reads no environment.
- **A guide imports a component from its own subpath.** SIG-330 made
  `@ttylabs/sigil/components/<file>` the recommended import, and `guides.test.ts`
  refuses a guide block that imports from the barrel, as the website already
  does for the component pages' examples.
- **It sits third in `GUIDE_SLUGS`, after Getting started and Building a
  full-screen app and before the parser reference.** Its recipes test both
  kinds of app those two build, and both end in a "Test it" section that points
  here, while the parser is a reference rather than a step in the reading
  order.
- **The full-screen recipe is written on SIG-309's helpers, which it had waited
  for.** The first version waited 50 ms for a frame and could only mount the
  component in-process, because `runOnTerminal()` had no TTY stdin. Now the
  in-process test paints with `frame(app)`, and a second test spawns the real
  `my-cli counter` with `stdin: true`, types into it and reads its screen with
  `waitFor()` -- which is the only one of the two that runs the command the
  user runs. The guide absorbed the README's SIG-309 text when the README
  section became a link: the `stdin` option, the handle, `frame()`, the
  terminal's `colorLevel`, and what a spawned run still cannot model.

### The suite removes every directory it makes

SIG-208. `file-picker.test.ts > should leave the root for its parent unless
confined` failed in four of eight full runs and passed every time on its own.
The flake was the symptom. The cause was the rest of the suite: tests in every
package made directories under `os.tmpdir()` and never removed them, and the
test that flaked was the one that read tmpdir itself. On the machine where it
failed, tmpdir held **520,146 entries**, 312,506 of them `sigil-yaml-` and
195,491 `sigil-xml-`. One run of the four projects left **811**: 510, 277, 4
and 20. macOS clears `$TMPDIR` only on reboot, so they piled up across every
pre-commit hook and every local run.

- **Each package has a `test/temp.ts` with `tempDir(prefix)`, and a
  `test/setup.ts` that removes what it made in an `afterAll`.** `setupFiles` in
  each package's `vitest.config.ts` runs that file before every test file, so
  the hook is registered on each file whether or not the file remembers to. A
  helper module that registered `afterAll` at its own top level would also
  work under vitest's default isolation. Under `isolate: false` it would be
  evaluated once per worker, so only the first file would get the hook. A setup
  file is re-run for every file either way.
- **Removal is per file, not per test.** `afterEach` would remove a directory a
  `beforeAll` made, or one made at module level like `runtimes-cache.test.ts`'s
  `box`, before the second test could use it. Per-test isolation already comes
  from each test getting a directory of its own from `mkdtemp`. Removing it
  between tests was never what kept two tests apart. A test whose directory is
  heavy and its own may still remove it as it finishes, with `removeTempDir()`
  in its `onTestFinished` -- not `afterEach`, which is the file's and would
  reach every other test's directory too. `new-tui.test.ts` does it for each app
  it scaffolds and builds (SIG-426): sixteen of them were half of what that
  file's `afterAll` had to remove, and that hook ran past 10 seconds on Windows
  with every test green.
- **A test that removes its own directory reaps its children first, the whole
  tree of each.** When a test times out, vitest aborts its `signal` and runs
  `onTestFinished` straight away, with the test's `await` still pending. So
  the removal has to wait for the children itself: `new-tui.test.ts` keeps each
  child's promise, which settles only on `close`, and its hook awaits them
  before it removes anything. Settling on `close` is the point, which is why
  `spawn()`'s own `signal` option is not used: it rejects at the abort, with
  the child still alive. And ending the child alone does not end what it
  started. A nested `vitest run` uses forked workers, and killing that vitest
  with SIGTERM or SIGKILL on macOS left its worker running under pid 1,
  measured with `ps`. On Windows, where killing a process kills only that
  process, the abort runs `taskkill /pid <pid> /T /F`, which walks the tree by
  parent pid. POSIX has no such call, so `endTree()` reads the tree from `ps`
  and walks it: each process found is sent SIGSTOP before the next look, so
  none can start another in between, and once a look finds nothing new every
  one of them gets SIGKILL. The SIGKILL is in a `finally`, so a look that
  fails still kills everything already stopped; a stopped process would hold
  its directory and never close. A look that fails -- `ps` missing, exiting
  non-zero, killed by its 5-second timeout, or listing nothing -- throws
  naming `ps` rather than reading as a tree with no descendants, which would
  kill the root alone and leave its workers in the directory. That error is
  what the child's promise rejects with, and the hook fails the test with it
  once the directory is removed. `ending a process tree` pins both halves with
  a real root and child, failing the first look and the second; taking the
  `finally` out leaves the root stopped, and taking the checks out leaves
  nothing thrown, and each fails it. Timing out all twelve variants at 250, 350, 450 and
  550 ms left no directory and no process in one, and from 350 ms up every
  abort was a nested vitest's. The first version, which passed the signal to
  `spawn()`, left an orphaned worker at 350 and at 400 ms. A child that never
  closes holds the hook until `REMOVAL_TIMEOUT`, which fails the test and
  leaves the directory to the `afterAll`.
- **The children stay in the suite's own process group, so a Ctrl-C reaches
  them.** Killing a group would be one call, and the second version did it: the
  child spawned `detached` and `process.kill(-pid)` on an abort. Review found
  what that cost. A terminal's Ctrl-C is SIGINT to its foreground group, and a
  detached child is in a session of its own, so the SIGINT never reached it.
  Nothing passed it on either. vitest's main process answers SIGINT by exiting
  a millisecond later without stopping anything it spawned (the logger's
  `addCleanupListeners()`). The `forks.js` workers install no handler at all.
  `@ttylabs/cli` runs its tests in `threads`, and a worker thread is sent no
  signal events: a `process.on('SIGINT')`, `SIGTERM`, `SIGHUP` or `exit` handler
  in a test file never ran when the main process was interrupted, so there is
  nowhere for a test to clean up from. Measured with a nested test that waits
  two minutes, by sending SIGINT to the whole run's group as a terminal does:
  with `detached`, ten processes (five nested vitests and their workers) were
  still running five seconds later, in the app directories. In the suite's
  group, none were. This is how the suite behaved before SIG-426, and a SIGTERM
  sent to the vitest process alone still leaves its children running, as it
  always has. Directories a Ctrl-C leaves behind are a separate thing: no
  `afterAll` runs after one, with or without this.
- **A directory removed early is checked again when the file ends.**
  `removeTempDir()` remembers what it removed, and `removeTempDirs()` fails the
  file over any of it that exists again, after removing it a second time. A
  cleanup that cannot see its own failure is a leak nobody hears about. Proved
  by sabotage: with the reaping taken out, the full `new-tui.test.ts` failed
  on four apps `written to after it was removed`, and nothing was left. It only
  sees a write that lands before the file ends; one after that is what `pnpm
  test:leaks` is for.
- **Removal is asynchronous and concurrent, with a budget of 60 seconds.**
  `REMOVAL_TIMEOUT` in `temp.ts`, given to the `afterAll` in each `setup.ts`.
  `rmSync` over every directory in turn put each one's retries end to end, and
  vitest counts a slow synchronous hook against its 10-second default as well,
  which is the timeout `new-tui.test.ts` hit on Windows after every test had
  passed: Defender scans what a test has just written, so removal there is
  slow. Run together, one directory waiting out its retries no longer holds up
  the rest. The budget is a bound on a hang and not on speed: a directory that
  cannot be removed is not a hang, because `rm` stops retrying and throws.
- **Each directory is tracked, and none of them are nested under a shared
  root.** A per-worker root removed in `afterAll` was the other proposal. It
  saves nothing, because a recursive `rmSync` of one root unlinks the same 510
  directories that 510 calls do. It would also change every path. A path one
  level deeper is a longer path, and two things here already depend on length:
  the file picker's question line, below, and Windows' 260-character limit
  under a `node_modules` tree a cli fixture builds. With `tempDir()` the
  directory is the same one `mkdtempSync()` made before, with the same prefix.
  The only change is that something removes it.
- **One copy per package, not one shared helper.** The four packages are
  separate packages. `@ttylabs/cli` and the config stores reach
  `@ttylabs/sigil` only through its `exports` map. `@ttylabs/sigil/testing` is
  published API for apps, and a helper that needs vitest's `afterAll` does not
  belong in a module that is runner-agnostic on purpose. A file outside every
  package would sit outside each package's `tsconfig` `include`. The file is
  about fifty lines, and the four copies are identical so they can be diffed.
- **A directory that cannot be removed fails the file.** `rm` gets
  `maxRetries: 5` for Windows, where a directory a child has just let go of can
  answer `EBUSY` or `EPERM` for a moment. After that the error is thrown. A
  cleanup that swallows its own failure is a leak nobody hears about, and that
  is the failure this exists to stop.
- **Not every `mkdtempSync` was converted.** The sites that already removed what
  they made, in a `finally` or an `afterEach`, were left alone. Only the leaking
  sites moved to `tempDir()`: the config stores' `helpers.ts` and three stray
  calls, `updates.test.ts`, `terminal/signals.test.ts`, and six cli files.
  Rewriting correct cleanup for consistency would be churn, and
  `pnpm test:leaks` is what holds the line from now on.

Two leaks were not a missing cleanup, and they are the ones worth remembering.

- **`updates-auto.test.ts` removed its cache before the check had read it.**
  After a command that fails, `main()` does not wait for the update check,
  which is correct, because the notice is skipped. But `check()` awaits
  `compiledHost()` before it reads the cache, so `afterEach` removed the seeded
  cache first. The check then found nothing fresh, recreated the directory, and
  spawned a worker that fetched `mycli` from the **real npm registry** and
  wrote the answer into a directory nothing would remove again. That happened
  two times per run, from a file whose header says every case is offline. The
  file now wraps `check()` through `vi.mock` to remember each promise, and both
  `afterEach` hooks await them before removing anything. The wrapper changes
  nothing the check does.
- **A detached worker writing after the file has finished is safe.**
  `updates.test.ts`'s fire-and-forget case returns before its worker has
  written. The worker never creates the cache directory, which is the
  parent's job (`check()` makes it before spawning). So a write that lands
  after `afterAll` fails in the worker and leaves nothing behind. A write that
  lands before it is removed with the rest. `maxRetries` covers the moment in
  between, when a recursive `rmSync` can meet `ENOTEMPTY`.

**The file picker's fixture is one level below a directory the test owns.**
Left from the root goes to its parent and the picker reads and stats it. With
the fixture straight under tmpdir, the parent was tmpdir itself, so the test's
cost was the machine's tmpdir size: 549 ms of `until()`'s 2,000 against 520k
entries on an idle machine, and past the deadline under a full run's load. The
parent now holds `root/` and nothing else. The test asserts the listing is
exactly that, and that `readdir` was never handed `tmpdir()`. The same change
widened its screen to fit the fixture's path. The question line is the
directory being browsed, cut from the left when it does not fit, and a fixed
120 columns failed six tests outright once `TMPDIR` was a long path. That was
the second way the test depended on the machine, and nobody had seen it because
macOS's own tmpdir is short.

**`pnpm test:leaks` is the guard, and it is a script because a test cannot be
one.** A test that counted tmpdir before and after would count every other
process on the machine as well, and it would flake the moment two runs
overlapped. `scripts/temp-leaks.mjs` builds with the build half of the root
`test` script, then runs one project at a time with `TMPDIR`, `TEMP` and `TMP`
pointed at an empty directory of its own. That makes the count exact, and it
also reaches the children a test spawns, which an `afterEach` cannot see. It
prints what was left grouped by prefix, which names the test that made it, and
it exits 1. One project at a time, so that a leak is charged to the package that
made it. The measurements and the sabotage passes are in
[docs/history/the-suite-removes-every-directory-it-makes.md](../../../../docs/history/the-suite-removes-every-directory-it-makes.md).

**A spawned tool's compile cache is the leak no test writes (SIG-422).**
`pnpm test:leaks @ttylabs/cli` reported one `node-compile-cache` left behind,
and no test in the repository makes one. The suite spawns package managers:
`cli.test.ts` runs `pnpm pack --dry-run` in each package, and `new-tui.test.ts`
runs `npm run dev` and `pnpm run dev` against a two-file fixture. The leak is
the package managers' own startup call, made by every one of those processes.
pnpm 12 (`bin/pnpm.mjs`) and npm 11 (`lib/cli.js`) both call
`module.enableCompileCache()` on startup, and with no directory that is
`join(os.tmpdir(), 'node-compile-cache')`. So any child that runs a modern node
CLI writes into the tmpdir. In an ordinary run that is the machine's shared
cache, which the outer `pnpm test` has already made. Under `test:leaks` it is a
new directory nobody removes. tsdown, rolldown and vite make the same call, and
`packages/sigil`'s two tests that run `pnpm build` when `dist/` is missing reach
tsdown through it.

- **The fix is `NODE_DISABLE_COMPILE_CACHE=1` in `test.env`, in the vitest
  config of each package whose tests spawn anything.** That is `sigil` and
  `cli`. The other three spawn nothing. It reaches every process a test spawns
  that inherits `process.env`, and the package managers' own call then returns
  `DISABLED`. A spawn site that builds its env from nothing has to add it
  itself. vitest makes the same choice for the v8 coverage provider, "in
  workers and any process they spawn". It sets the variable itself whenever
  coverage is on with a provider other than istanbul, after it merges the
  project's `env`. So a `pnpm coverage` run already had the cache off, and
  `pnpm test` and `pnpm test:leaks`, which run without coverage, are the runs
  that leaked.
- **Disabling was chosen over redirecting.** `NODE_COMPILE_CACHE=<a tempDir()>`
  would also keep the directory inside one the suite removes. But that variable
  turns the cache **on** for every node process that reads it, including the
  scaffolded app's own `node` and the built bins the suite spawns, which never
  asked for one. Disabling changes only the processes that opted in, and the
  cache changes only how fast they start. Measured on node 24.18: `pnpm pack
  --dry-run` went from 216 to 270 ms with a warm cache and with none, and
  `npm --version` from 51 to 54 ms, across the dozen or so such spawns in a
  run.
- **`compile-cache.test.ts` in each of the two packages is the regression
  test, and it reads the config rather than trusting a child.** CI does not
  run `test:leaks`, so without it the config line could go missing with
  nothing failing. CI runs `pnpm coverage`, where vitest disables the cache on
  its own, so a child reports `DISABLED` whether or not the config says so. The
  first version of the test only spawned a child, and review round 1 found it
  could not fail in CI. So the first case imports the package's own
  `vitest.config.ts` and asserts `test.env`. The second spawns a node that makes
  pnpm's call with its tmpdir pointed at a `tempDir()`, which proves the
  variable has the effect claimed. With the line removed from both configs,
  `pnpm test` fails both cases in each package, and `pnpm coverage` fails the
  config case and passes the spawned one. With it restored, both runs pass.

### What each entry loads at import, and what it only asks for (SIG-328)

SIG-326 put the PNG codec, and `node:zlib` with it, on `@ttylabs/sigil/components`
so that `imageView()` could decode bytes, and moved that entry's ceiling from 448
to 640 KiB to fit. SIG-328 audited every published entry for the same shape --
something only some callers need, loaded by all of them -- and made the safe
changes. The full before-and-after, the A/B runs and the sabotage passes are in
[docs/history/what-each-entry-loads-at-import.md](../../../../docs/history/what-each-entry-loads-at-import.md).

- **One reader of the graph, shared by the test and the script.** `staticGraph()`
  moved out of `test/dist.test.ts` into `test/static-graph.ts`, beside
  `graphBytes()` and `staticBuiltins()`, because a test file cannot be imported
  from outside vitest and the audit had to read the graph the ceilings read.
  `scripts/entry-cost.mjs` prints the table below from it: modules, bytes and the
  builtins each graph imports statically, plus the median wall clock of an
  `await import()` in a fresh node and the builtins `process.moduleLoadList`
  says that import really loaded. Bytes are not the whole story -- `node:https`
  is 3.6 ms and almost no bytes of ours. Re-derive with it rather than reading
  the figures here, which are as of this change.

- **`staticBuiltins()` reads the minifier's spelling only, `from"node:x"`.** The
  update worker is baked into `updates.mjs` as text, and its own imports sit in
  a string literal where they load nothing; a looser pattern reads them as
  imports of the chunk that holds them. `should not read an import that is only
  text in a string` asks that of a module written for it, because the shipped
  chunk stopped being able to: the worker's one remaining import is `node:fs`,
  which the chunk also imports for real, so review round 1 found the old check
  passing for a reader of either spelling. `should still see a static import` is
  the presence half that stops the reader going blind without anyone noticing.

- **Measured, as of SIG-328, on node 26.10 on arm64 macOS.** Medians of 41
  interleaved fresh-process imports of the old and new `dist/`, since a single
  run of the table moves by a millisecond with whatever else the machine is
  doing; `index` is the control.

  | entry        | modules | bytes before → after | import ms before → after | what stopped loading                      |
  | ------------ | ------: | -------------------- | ------------------------ | ----------------------------------------- |
  | `index`      |       8 | 12,326 → 12,326      | 3.03 → 2.95              | nothing (control)                         |
  | `components` |      38 | 473,733 → 473,873    | 15.33 → 14.08            | `zlib`, `child_process`, `worker_threads` |
  | `config`     |       9 | 39,397 → 39,414      | 5.92 → 3.76              | `crypto`                                  |
  | `png`        |       5 | 14,609 → 14,676      | 3.16 → 2.53              | `zlib`                                    |
  | `updates`    |       4 | 18,332 → 18,536      | 6.18 → 2.55              | `https`, `tls`, `http`, `child_process`   |

  The chunk `main()` imports for `updateCheck`, which every run of such an app
  pays whether or not its cache is fresh, went from 6.90 to 3.42 ms. The XML and
  YAML stores inherit the `config` figure and `@ttylabs/screenshot` the `png`
  one, since each reaches the builtin only through those subpaths.

- **A builtin needed only inside a function is `process.getBuiltinModule()`,
  and that is the whole change.** It is synchronous, so `decodePng()`,
  `encodePng()`, every write and `imageView()` kept their signatures, and it
  returns the same module object a static import binds, so `vi.spyOn(https,
  'get')` still sees the worker's call. It is core on the `engines` floor (node
  22.3 added it; the floor is 22.19) and was verified in bun 1.2.23, 1.3.14 and
  1.4.4 -- the update worker is piped into bun on one path, and it fetched over
  https on all three. What moved is when the builtin loads: the first
  `decodePng()` or first save pays it once, and nothing that used to throw at
  import throws later instead, since asking a runtime for one of its own core
  modules does not fail. Six call sites: zlib in `src/png/`, `crypto` in
  `config/atomic.ts`, `https` in the update worker, `child_process` in
  `updates/index.ts` and `components/editor.ts`, `util` in the debug overlay.

- **Two things it is not for.** A builtin a test replaces with `vi.mock()`:
  `getBuiltinModule()` does not go through the module graph, so it would bypass
  the mock silently. That is why `node:fs/promises` stays a static import in
  `components/path.ts`, which the path prompt, the file picker and the tree read
  directories through, and in the config module, at about 0.3 ms -- six test
  files mock it. And a builtin used at module level: the debug
  logger's `class StdioStream extends Writable` needs `node:stream` when the
  module evaluates, and `debug()` is called at load by every logger and returns
  a `Console`, so `node:console` and `node:stream` stay on every entry. They
  cost about 0.35 ms, and taking them off would mean returning something other
  than a `Console` or a Proxy, which this repository does not use.

- **What stayed static, and why.** The codec's **code**, about 10 kB of the
  components entry: `imageView()` decodes when the view is built so that a bad
  file throws where the caller can catch it, and loading the codec later would
  make that asynchronous or move the error into a frame -- both refused in
  src/components/AGENTS.md. Everything else the ticket named was already lazy:
  the update check is one `import()` inside `main()`, completion and the
  installer sit behind the parse chunk's `import()`s, and help and the parser
  are behind `main()`'s. Prompts, the debug overlay, the QR encoder, markdown
  and the editor are **components** and live in the components barrel; the
  largest, the QR encoder, measured 10,255 B of it when SIG-136 added it. `@ttylabs/sigil/testing`'s `child_process`
  is a test helper's. `os`, `path` and `fs` are loaded by node before user code
  runs, or cost nothing measurable.

- **`sigil build` shakes the codec's bytes away, and it was keeping its
  builtin.** A one-spinner app built with `sigil build` carried no codec at all
  -- 192,891 B over seven files against the barrel's 473,733 over 38 -- but it
  still imported `node:zlib`, `node:os` and `node:child_process`: the encoder's
  deflate options were an object at module level reading `constants`, the
  editor built a signal-name table in a loop at module level, and a tree-shaker
  cannot drop a member read or a loop it cannot prove pure. Both are inside
  functions now, the encoder's `TextEncoder` is marked pure, and the same app's
  entry graph imports `console`, `fs`, `path` and `stream` and nothing else.
  Built, it went from 36.3 to 35.4 ms of wall clock; run unbundled from
  `node_modules`, 40.2 to 38.7. So the build does not make this moot, and the
  unbundled app is the one that pays most. `packages/cli/test/build/shake-builtins.test.ts`
  builds the app and an image-drawing twin as its presence half.

- **Every entry has a ceiling now, at about 2x.** Most had none, so an entry
  could double with nothing saying so. `CEILINGS` in `test/dist.test.ts` holds
  the rest, each beside what it measured as of this change, and
  `should hold every published entry to a ceiling` reads the manifest, so a new
  subpath without one fails naming itself. The entries with a test of their own
  keep it: `coerce` went from 24 to 16 KiB and `suggest` from 8 to 3, to meet the
  2x; `index`, `config`, `input` and `png` were already under it. The components
  ceiling stays at 640 KiB, 1.38x, because what this change took out of that
  entry was time and not bytes.

- **The lazy loads are pinned twice, statically and at run time.** `should not
  import ... at load` asserts each builtin is absent from the entry's static
  imports and still asked for through `getBuiltinModule()`; `should load none of
  them` imports the built entry in a fresh node and reads `moduleLoadList`. The
  second exists because a `getBuiltinModule()` at **module level** loads the
  builtin as surely as an import and is in no import list -- which is what the
  encoder's options object would have been with its `constants` spelled
  `zlib().constants`. Each half was proved by putting the import back: every
  sabotage type-checked and failed the tests it should.

- **Recommended rather than done, because each changes a public API.** Per-
  component subpaths -- done since, by SIG-330, under "A subpath per component"
  in `src/components/AGENTS.md`, which also taught `staticGraph()` to follow a
  `../` specifier out of `dist/components/` and added `shippedModules()` for the
  checks over every shipped file: in a scratch build with a spinner as an entry of its own,
  that entry was 194,707 B over 29 modules and 8.4 ms to import, against 475,138
  over 41 and 15.4 ms for the barrel in the same build, so an unbundled one-spinner app would pay about half -- but that is new
  public surface on the package every app depends on, and the split would have to
  be decided for 50 modules at once. And an `imageView()` that takes only RGBA,
  with `decodePng()` left to the caller, which would take the codec's 10 kB off
  the barrel and is a breaking change to a component one release old.
