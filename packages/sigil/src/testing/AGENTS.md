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

- **It writes nothing to the child's stdin, so a prompt is not what to spawn.**
  A prompt needs keys delivered over time and the far end held open: write and
  close, and the router reports the stream ended and the prompt rejects with
  exactly that. An async handle that holds stdin open and writes on demand is a
  bigger API than this, and `createTestTerminal()` already answers the question
  in-process, so the surface says no rather than half-yes.

- **`runOnTerminal()` is `async`, so every refusal is a rejection.** A function
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

- **It throws on a sequence it does not model, and the README says so.** That is
  how it says it has no answer rather than quietly getting a row wrong, and it
  is the same policy the `default` branch already had. Walking the inputs
  confirmed the rest: a tab, a `BEL` and a `NUL` each take no cell rather than
  reaching a row a test reads as a picture; a ZWJ family, a flag and an astral
  character are each one cluster at their real width; an erase that cuts into a
  cluster takes both halves; and a huge or absent parameter on `A`, `B` or `C`
  clamps. A lone surrogate does get a cell, which is the model being faithful to
  what was written rather than a defect -- a terminal draws something there too.

- **What it still does not model is styling, bar reverse video.** That is a
  limitation rather than a defect and is documented in the README where a caller
  meets it: a claim about _colour_ belongs in a `runOnTerminal()` run, where a
  real styler writes real sequences a test can read. `lastInverse` is the one
  exception and stays the one exception, because a prompt's caret _is_ styling and
  the cell under it holds the same character either way. An erase still leaves the
  record in place, which is what it always did and is why the doc says a test
  asking whether a caret went away reads the bytes.

#### What is deliberately out, and one finding that is somebody else's ticket

- **No stdin writing in `runOnTerminal()`**, for the reason above.
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
  testing helper has nothing to show there. What it has instead is the README
  section, which is most of the value of the ticket, and the scaffold, which puts
  a working one in front of every new app.

- **A root schema's `run` is never dispatched, so `sigil new --single`
  scaffolds an app that does nothing -- and that is reported rather than
  fixed here.** Found while writing `command.test.ts`, whose first fixture put
  `run` on the schema the way the scaffold does. `main()` runs the command that
  **matched** and the root is never one, so `main({ schema: { name, args, run } })`
  parses argv, writes nothing, runs nothing and exits zero. Measured: the
  as-scaffolded single app answers `demo world` with **no output at all**, while
  the same app with the `run` moved into a hidden `default` command answers
  `hello world`. Its `--help` is wrong in a second way besides -- `Usage: demo
  [options] <command> [who]` names a required `<command>` when the only command
  is `help`.

  It is consistent with what this file already says -- "a schema that declares
  none is one being used as a parser" -- so what is wrong is the scaffold using a
  parser as an app, and both available fixes are a design decision somebody
  should take on their own terms: `main()` dispatching a root `run` is a change
  to every app's semantics, and a hidden default command loses `[who]` from the
  root help screen, which was measured too. Taking either inside a ticket about
  test helpers is the shape this file refuses repeatedly. So the generated test
  covers the **multi** layout end to end -- the default, and the one where a
  command really is dispatched -- and asserts `--help` for the single layout,
  which does work. A scaffold test that avoided the broken path _silently_ would
  be the dishonest version; this is the same avoidance with the measurement
  written down beside it.
