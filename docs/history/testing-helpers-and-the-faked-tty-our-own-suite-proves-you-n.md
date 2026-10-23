# Testing helpers, and the faked TTY our own suite proves you need — how it was arrived at

The review rounds, sabotage passes and by-hand audit passes behind
[packages/sigil/src/testing/AGENTS.md](../../packages/sigil/src/testing/AGENTS.md). The decisions themselves are
there; this is the record of what each round found, which is kept
because a finding nobody wrote down is one somebody re-discovers.

#### What the sabotage pass found over the helpers

A hundred and five mutations, one at a time, each run with a **rebuild** in front of it --
which is not tidiness: `packages/cli/test/testing-helpers.test.ts` reads `dist/`,
so without the rebuild a mutation in `src/` is invisible to it and every verdict
about the fixture would be about the previous build. **A hundred and four caught, one
declared.** A green control first, and the harness reports a pattern that matched
nothing, a pattern that matched more than once, a replacement equal to its
original, and a run that found fewer suites than the control as their own
verdicts rather than as passes. It restores on a **signal** as well as on an
exception, because a `SIGTERM` does not run a `finally` and a mutation left in
the tree poisons the next control -- which this file already records happening.

Every one of those guards earned its keep, and three of the four verdict guards
fired while this was being written: two patterns went stale when the formatter
reflowed the lines they quoted, and one mutation was not type-valid, so the build
failed and the run would otherwise have read as caught.

The fixture itself is in the set, which is the one the ticket asked for: a
preload that defines nothing fails **six** tests, two of them in the end-to-end
file -- including the one that says a terminal sees colour a pipe cannot. So the
fake is load bearing rather than decoration. Counted by running that one
mutation and reading the names, because the harness prints the first three and
the first write-up of this said "five, three of them" from the summary line.

**The one declared survivor is `press()`'s per-chunk loop**, and it is a statement
about what the method does rather than a claim about what it buys. Joining the
chunks and ticking once changes no answer for any prompt here, because the router
joins a held tail with the next read and serialises the keys of one chunk through
the same queue -- measured, including the frame count, which is seven either way.
What is **not** inert is the `tick()` inside it, and finding the input that shows
that is the entry below.

**Two guards were deleted for failing a sabotage**, and one of them was a whole
function. `isState()` and the fallback that read the state off `main()`'s own
return are gone: `afterParse` fires for every parse that produced a state and
`beforeError` reports one for every parse that threw after `state` existed, so
there is no path where the fallback is the only answer. Reasoning backwards from
the survival is what found that, rather than forwards from "no test failed" --
the forward reading would have been a test for a command that returns a
state-shaped object, which is a fixture invented to keep dead code alive. The
other was a **dedupe** in `streamsOf()`: `Object.defineProperty` with
`configurable: true` is idempotent, so a stream named twice is one definition
written twice. What is left there is the **copy**, which is the point -- what the
function returns is ours rather than the caller's array.

**Six survivors were a fixture that could not reach the branch**, and each one
is worth the entry. The `beforeError` wrap reporting the state survived because
every fixture for it used a **validation** failure, where `afterParse` has
already reported the same object -- so the input is a parse that throws _before_
it, which is a value its type rejects: measured, `afterParse` fires **zero**
times for `--port eight` and the wrap is the only thing that answers. The test
that had been named for "the values a failing parse still produced" was
describing that input and asserting neither the values nor the state, so it is
two tests now, one per kind of failure.

The **resize** cursor adjustment survived because `min(row, height - 1)` is right
whenever the cursor is at the bottom, which is where the fixture had left it --
the two readings part only with the cursor further up. And the **alternate
screen** clearing the caret survived because the only test near it asserted the
_resize_ clearing one; what it needed was an inverse write, a switch, and a look.

The `proc` stub survived because `attachRestore()` is
**lazy**: a terminal nothing has asked anything of attaches nothing to either
process, so the count matched whatever `proc` was -- the test calls
`hideCursor()` now, and asserts it returned `true`. `tick()`'s `setImmediate`
survived because a microtask drain is enough for a `PassThrough`, which emits
`data` synchronously from `write()`; what it is not enough for is everything
_downstream_ of the key, and an async `validate` is the input -- measured, two
`await Promise.resolve()`s leave the validator's message off the screen where a
`setImmediate` puts it there. And the zero-width-cluster skip survived because
a mark `graphemes()` attached to a base is never a lone cluster: a **lone**
combining mark is, and without the skip it is written into a cell the cursor
never leaves, so it comes back inside the row a test reads as a picture.

#### What the first review round found, and what it got wrong

Twelve findings over `command.ts`, `spawn.ts` and `numbers.ts`, pointed at the
implementation with the ticket's constraints and **not** at the rationale.
**Nine confirmed and fixed, three refuted.** Every one of the nine is a thing a
deletion-based pass cannot find, which is the boundary this file keeps
recording: eight of them are a _missing_ guard rather than a dead one, and the
ninth is a comment that was false about the code under it.

Two were about agreeing with the runtime, which is the class that matters most
here, because a helper that disagrees with `main()` is a helper that lies about
the app.

- **`replaced ?? err` disagreed with `fireBeforeError()`'s own predicate**,
  which is `result !== undefined`. So a `beforeError` hook returning `null`
  really does replace the error there, while this reported the original -- one
  wrap disagreeing with the runtime about the same return value, and the kind of
  thing nobody would think to test. It is `=== undefined` now, pinned by a hook
  that returns `null` and by the `Unknown error` the runtime renders for it.
- **A `Uint8Array` is a shape `Writable.write` accepts and `Buffer.isBuffer`
  refuses**, so a write of `new Uint8Array([0xc3, 0xa9])` reached a test as
  `"195,169"`. And an **encoding** is the caller's: `write('c3a9', 'hex')` puts
  `é` on the stream, so reading the string as it came is reading the wrong text.
  Both now go through the same buffer path the split-character fix built.

One was the comment this file had already congratulated itself about.

- **The latch fix was half a fix, and the comment claimed the whole of it.** The
  three reads that save what is about to be replaced sat _outside_ the `try`,
  under a comment saying "everything past the latch is inside" -- so a
  `process.stdout.write` somebody redefined as a throwing getter leaves the latch
  set for the life of the process, which is the same defect the previous commit
  had closed for the other reachable shape. Everything is inside now and each
  restore is guarded on having read something, since a throw from the read itself
  leaves nothing to put back and assigning `undefined` over a stream's `write`
  would be the fixture breaking the process it was only meant to observe.

Four were hostile inputs the typed signature does not stop, and a test file is
where untyped JavaScript gets written.

- **`tty` reaches the generated preload as a property _reference_.** A
  `tty: 'stdout'` is a string, which `.map()` walks a character at a time into
  `process.s`, and `tty: ['stdout;console.log(1)//']` is arbitrary code in the
  child. Refused by name now, with `Array.isArray` in front of the spread for the
  one input the name check cannot reach -- a `tty: 42` is not iterable.
- **An empty `run` or `source` counted as given.** `''` is not `undefined`, so
  `run: ''` spawned `node ''` and `source: ''` spawned a module that does nothing
  and exits zero: a run that looks like it worked.
- **`opts.columns ?? 80` swallowed a `null`**, which is exactly the value
  `cells()` exists to name rather than hide -- and `Number.isInteger(1e20)` is
  true, where a screen of 1e20 columns is an allocation nothing survives. It is
  `=== undefined` and `isSafeInteger` now, the second being the rule the parser's
  own `int` type already records.
- **A watchdog of zero is not a watchdog.** `setTimeout(fn, 0)` fires on the next
  tick and kills the child before it has written anything, so `timeout: 0` read
  as "no wait" and did the opposite. The floor is one millisecond, and there is
  deliberately no way to turn the watchdog off: a fixture that can hang a suite
  for ever is the thing it is there for.

Two were about what a run is isolated from.

- **The colour _scheme_ and the motion preference leaked.** `COLOUR_ENV` named
  what `supportsColor()` reads and nothing else, so `SIGIL_COLOR_SCHEME`,
  `COLORFGBG` and `SIGIL_REDUCED_MOTION` were copied through -- and a child that
  drew a help screen with the parent's scheme left behind comes out light on a
  laptop and dark on CI, which is the same failure `CI` and `FORCE_COLOR` are
  cleared for one property along.
- **`Object.assign(env, opts.env)` left two casings of one variable** in the
  block handed to `spawn`, because `process.env` is case-insensitive on Windows:
  a `Term` over a `TERM` is two keys for one variable and which one the child
  sees is unspecified. The overlay removes the other casing first, and `env`
  still goes on top, which is what makes it the escape hatch.

**What it got wrong**, recorded because a reviewer being wrong is ordinary and
the refutations are as much a part of the read as the fixes:

- **It called the timeout path a leak** -- "kill then reject; child/stdio not
  reaped", and the timer not `unref`'d. Neither holds. The timer has _fired_ by
  then, so there is nothing to clear; `SIGKILL` ends the child and node destroys
  its stdio when it exits, so the `'data'` listeners die with it; and the timer
  is deliberately not unref'd, because a run in flight is a promise somebody is
  awaiting and a process that exited under it would be the bug.
- **It wanted `timeout: '100'` coerced.** A string is not a finite number, and
  falling back is the rule every timer option in this library already follows --
  written down for the typewriter's interval and for the sequence deadline. A
  helper that coerced where the runtime refuses would be the disagreement the
  first two findings are about, pointing the other way.
- **It wanted `opts.env` applied _under_ the colour options**, so that `color`
  could not be overridden. That is backwards: `env` going on top is what makes it
  the escape hatch for a variable the sanitising cleared, it is documented and
  asserted, and a caller who sets both `color: false` and
  `env: { FORCE_COLOR: '3' }` has asked for the conflict. Only the Windows casing
  half of that finding was real.

#### What the second half of the first round found: the screen model

Pointed at `terminal.ts` and `screen.ts`, which the first half had explicitly
not read. **Twelve confirmed and fixed**, and the shape of them is worth more
than the count: almost every one is a sequence or an input the model had simply
never been asked about, because the only thing that had ever fed it was this
repository's own canvas writing whole frames. Shipping it is what makes a
caller's own output the input.

The sharpest is about a sequence this package **publishes**: `ERASE_LINE` is
`ESC[2K`, and the model blanked _from the cursor_ for it -- so a caller using
the constant the library hands out would have had the model agree about the
wrong span. Published rather than written, which is the precise statement:
nothing in `src/` emits it, only re-exports it, so this is a caller's path
rather than an in-repo one. The first version of this entry said "reachable from
inside the library", which is the overclaim this file keeps warning about,
caught by going and looking for the writers. `ESC[1K` was the same, and two of `J`'s three modes
cleared **no cell at all**: `ESC[2J` and `ESC[1J` each parsed, disarmed the wrap
and erased nothing.

Four were the cursor ending up somewhere nothing is, which is the class the
`ESC[H` clamp was already in.

- **A resize left the cursor at the index it had** while the content moved up
  from under it: shrinking a four-row screen to two takes two rows off the top,
  so what the cursor was on is two rows higher or gone -- and
  `min(row, height - 1)` happens to be right whenever the cursor is at the
  bottom, which is why the first fixture for it agreed with the defect. The class
  doc said the viewport "grows or shrinks from the bottom", which is half true:
  growing pushes, and shrinking takes the top, which is what a terminal does. So
  what was wrong was the sentence.
- **A cursor the alternate screen saved was restored unclamped**, so a resize
  while it was up left `#saved` off the grid and every write after
  `ESC[?1049l` was dropped for ever -- the `ESC[H` defect by another route.
- **A mode change disarmed the deferred wrap**, and `enableBracketedPaste()`
  writes `ESC[?2004h` to stdout: a full-width frame followed by one had its next
  character overwrite the last column instead of wrapping. A mode change moves no
  cursor, so there is nothing to disarm.
- **A sequence split across two `write()` calls threw.** A terminal holds; this
  refused, and a caller replaying captured output chunks it wherever the pipe
  did. An incomplete _tail_ is held for the next call now, and a **complete**
  sequence with no answer here still throws, which is the diagnostic worth
  keeping rather than guessing past.

Three were `lastInverse`, which is the one thing the model keeps about styling
and so the one thing a caller trusts it for: it survived a **scroll** naming a
fresh blank row, survived an **erase** that blanked its own cell, and survived a
switch to the **alternate screen** pointing at a buffer nobody is looking at.
The class doc's "a frame that draws no caret leaves the last one in place" is
about a frame rather than about a write of blanks, which the plain-write rule
already cleared for.

And four were untyped inputs reaching a shipped helper. **`tick(Infinity)` is a
loop with no end** in a function a test awaits, and `tick(0)`, `tick(NaN)` and
`tick(-1)` each settle **nothing** while looking like they settled something --
which is worse, because the assertion after one fails for a reason nobody would
guess. `ctrl(undefined)` threw a `TypeError` out of `toLowerCase()` rather than
the error it documents. `alt(undefined)` produced `ESC` and then the **word**
`undefined`, which a prompt types in a character at a time. And
`createTestTerminal({ columns: null })` silently used 40, which is the `??`
mistake `runOnTerminal()` had in the other half of the round. `press()` and
`paste()` both refuse a non-string now, as **rejections** rather than
synchronous throws, which is `runOnTerminal()`'s own rule.

Two documentation findings came with them and both were real. `lines` is the
**main** buffer, so after `ESC[?1049h` it is the log behind the alternate screen
rather than what is showing -- and the README called both it and `viewport`
"what is on screen". And `press()` promised that the next assertion sees the
frames its reads caused, where a lone `KEYS.escape` is held for
`ESCAPE_TIMEOUT` and no number of turns of the event loop makes it a key; the
`alt()` doc already said so and `press()`'s did not.

#### What the second review round found, and it was almost all the tests

Pointed at what round 1's own coverage list said it had skipped -- the tests,
the prose, the scaffold, the moved harness's existing readers and the packaging
-- and told not to re-litigate round 1's premises. **Twelve findings, all
confirmed**, and the distribution is the one this file keeps recording: it found
**no runtime defect at all** in the four implementation files round 1 had
examined, and its findings came from the files nobody had opened. Five were a
test that could not fail for the reason its name gives, five were prose, and two
were a check whose list was short of the name that matters.

The sharpest is one of my own guards. **`should name every export in the
README` was a substring search over the whole file**, so `tick` matched
`bar.tick()` four hundred lines away, `alt` matched `alt-{0}` and `ctrl` matched
`ctrl-{0}` -- all of them somebody else's prose. Deleting every mention of the
helper left it green, which is this ticket's own complaint applied to the guard
written for it. Scoped to the `## Testing` section, it **failed immediately**:
`tick` really was undocumented, and is now the one export with a bullet of its
own.

Three more tests were weaker than their names.

- **`should show what is on screen rather than what the last frame changed` had
  no diffing frame in it.** After one tick the first paint is a _full_ frame, so
  every byte of the prompt is in the last write and asserting `output` would have
  passed too -- the claim needs a key **after** the paint, and the discrimination
  is that `lines` still shows the message where the chunk that caused the move
  does not.
- **`should put the streams back, so a later write is not captured` never did
  the second half.** It compared the identity of `write` and stopped, so a
  restore that put back a _different_ function that still captured would have
  passed. It writes afterwards and checks the bytes went to the stream rather
  than into the capture.
- **`should name every tool its scripts run` only walked the linters**, which is
  what it was written for -- and the `test` script arrived later naming `vitest`,
  so dropping `vitest` from the devDependencies while leaving the script was the
  same defect on a second script and this stayed green. Verified by running that
  sabotage: it now fails exactly that test. Every script is walked, with the
  three that are not packages as an explicit list.
- **And `should fake only the streams it was named` never asked about the
  size.** `tty: ['stderr']` asserted which streams claim to be terminals and not
  that `stdout.columns` stayed the pipe's own -- which is the case the README
  table overclaimed about, below, and is the shape
  `testing-helpers.test.ts`'s own terminal run has.

Five were prose, and two of them were sentences I had already written down as
corrected elsewhere.

- **The README still said `ui.lines` is "what is on screen".** The _type_ doc had
  been corrected and the README bullet had not, which is the worse half: aligning
  the getter with that sentence would make `lines` track the alternate buffer.
- **The `cellAt()` sample does not draw.** It says to read before any key is
  pressed and has no `tick()`, and nothing is painted until something ticks -- so
  copying the fragment gets `[]` and `undefined`. Which is the same class as the
  example read at the wrong moment, one step further on: the fix for that one
  moved the _comment_ and not the code.
- **The option table overclaimed `columns` and `rows`.** `COLUMNS` and `LINES`
  are always set; a stream's own `columns` is faked only where `tty` named it. My
  own edit to that table introduced the overclaim, in the commit that fixed it
  silently matching nothing.
- **The `runOnTerminal()` sample's comments describe `sigil check`**, not any
  program: a `run` that writes the same bytes either way gets the same bytes
  here, and the paragraph presented the split as what the helper is _for_.
- **`## Subpath modules` had no `### sigil/testing`** while the catalogue on line
  62 listed one, so a reader using that section as the list of subpaths would not
  find it.

And two were a measurement and a list. **`dist.test.ts` said 41.7 kB where
AGENTS said 44,328 B** -- one measurement, two comments, and a later reader with
no way to tell which was measured. And **the import-cost lists did not name
`runCommand`**, which is the export an app actually imports: dropping it from
the barrel while leaving the module reachable kept the presence half green. That
is this file's own rule about an absence-only test, applied to the one name that
matters most, and AGENTS already cited that test as the thing keeping the cost
zero "with the presence half beside it".

It also confirmed, against the code, the things most worth doubting: the four
existing readers changed by an import path and nothing else, `fake-terminal.ts`
is a second model on purpose rather than a new inconsistency, the generated TS
and JS tests compile and resolve, the `exports` map and the tsdown entry agree,
and the single-layout scaffold is a recorded decision rather than a defect.

#### Reading the prose against the code, which is where the rest of it was

Round 2's own discipline, applied to this change's documentation. **Six
findings, all of them prose or a check that was missing**, which is the ratio
this file keeps recording for a round aimed at what nobody opened.

- **`screenStream` was exported and documented nowhere**, which is this ticket's
  own complaint one level in: an export nobody can find. Four **option fields**
  were the same -- `colorLevel`, `inputTTY`, `stdin` and `result`. Both are
  pinned now, against the README and read off the **declarations** rather than
  the barrel source, so a re-export or a field added without a sentence is
  caught: `should name every export in the README` and the field walk beside it.
- **The README's examples were read at the wrong moment.** `ui.lines` was shown
  as `['? Pick', '❯ one', '  two']` in a block that follows a Down keypress,
  where the pointer has moved to the second row. Found by _running_ the examples
  rather than by reading them, which is the cheapest review there is -- and it is
  what turned up the two surface names worth dropping.
- **The option table's `columns` and `rows` rows were edited with a `replace`
  that had no assertion behind it**, so the edit silently matched nothing after
  the formatter had reflowed the table and the table went on describing the old
  behaviour. That is the failure this file records about its own sabotage
  harness, met in a documentation edit: assert the edit landed.
- **A `####` heading collided with the debug overlay's.** Two
  `What the sabotage pass found` sections in one file is one somebody greps for
  and reads the wrong one of.
- **And five counts in this entry were wrong**, each caught by going and
  measuring rather than by re-reading: "three more reasons" listing two, "five
  tests, three of them in the end-to-end file" where it is six and two, "three
  guards deleted" where it is two, "four survivors" where it is six, and a diff
  described as the cluster work alone after twelve review findings had been added
  to it. The pattern is worth more than the list: every one of them was written
  from a summary line or from an earlier draft rather than from the thing itself,
  and this file already says a figure nobody can re-derive goes stale quietly.

#### Two of the tests were weaker than their names, found by reading them

Which is round 2's own discipline applied to this change's tests rather than to
its code, and both were the same shape: an assertion that holds for a reason
other than the one it is named for.

- **`should clear what a CI runner sets` was vacuous on a laptop.** It read
  `CI`, `GITHUB_ACTIONS` and `COLORTERM` back out of the child and asserted they
  were absent -- which they are on any development machine, because nothing sets
  them there. So it pinned the clearing on CI and nothing at all locally. It sets
  them in the **parent** first now, in a `try`/`finally`. The clearing was pinned
  anyway, by the case-insensitive test one along, which is the only reason this
  was a weak test rather than an unguarded line.
- **The piped-form shape test matched almost any line.** `/^(?:\S.*?: (?:error|warning):|\S)/`
  has a `|\S` alternative, so it would have passed over a wrapped form entirely.
  It asks only about the lines that carry a severity -- the note and the summary
  are not diagnostics -- and requires the whole
  `file:line:column: severity: message` of each.

#### What re-reading the code found that neither the pass nor a reviewer did

Three, all in `runCommand()`, and all of the shape a deletion-based pass is blind
to by construction -- code that agrees with itself.

- **The re-entrancy latch was set outside the `try`**, so a throw between setting
  it and entering the block left it set for the **life of the process** and every
  later run refused with "already running". Reachable because `wrap()` reads the
  caller's schema: a property of theirs that throws on the way out is the shape
  of it. This fix was **half** a fix and the review round below found the rest --
  the three reads that save what is about to be replaced were still outside, and
  each restore is guarded on having read something now, because a throw from the
  read itself leaves nothing to put back.
- **A command writing one character in two buffers reached a test as two
  replacement characters.** `process.stdout.write` takes a string or a `Buffer`,
  and the capture coerced each chunk as it arrived -- which is the same trap
  `runOnTerminal()` closes on the other side of a pipe, met here because the two
  take the same two shapes. The chunks are kept as they came and a **run** of
  buffers is decoded together.
- **A `beforeError` hook of the caller's that threw cost this the error it was
  called about.** The framework logs and skips a hook that throws, so ours threw
  with it and `report.onError` was never reached: a run whose app had a broken
  hook reported `error: undefined`, which says the run did not fail. The error is
  reported either way now, and the state is reported _before_ the caller's hook
  runs rather than after.
