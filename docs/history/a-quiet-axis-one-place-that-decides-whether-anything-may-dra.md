# A quiet axis: one place that decides whether anything may draw — how it was arrived at

The review rounds, sabotage passes and by-hand audit passes behind
[packages/sigil/src/style/AGENTS.md](../../packages/sigil/src/style/AGENTS.md). The decisions themselves are
there; this is the record of what each round found, which is kept
because a finding nobody wrote down is one somebody re-discovers.

#### What the four review rounds found

Each was aimed differently -- the first at the diff with the ticket and none of
the author's rationale, and each one after it at the previous round's own skipped
list **and** its fixes. That ordering is what this file already records:
the findings come from what nobody opened, and the previous round's fixes are
exactly that.

- **Round 1** found the `write()` leak on all three lazy facades; a `main()` leak
  across two calls; truthiness on a non-boolean, with `setQuiet('false')` and
  `createSpinner({ quiet: 'false' })` each measured; a dead argument in
  `report.ts`; and four pieces of missing prose.

- **Round 2** found `main()`'s restore reversing a command's **own** statement --
  the generation counter above; `sigil build --quiet` still printing both tables;
  five undercounted "two parser-owned flags" enumerations, in `catalog.ts`,
  `catalog.test.ts`, `suggest.ts`, `completion/spec.ts` and the README; and two
  sentences in the demo that were false about what it prints.

- **Round 3** found the generation question again from the other side (a value
  comparison cannot see a command's own write), `createProgress`'s eager mount
  leaking through `draw()` and `write()`, a sink-substitution test whose named
  backend was a second sink -- so the byte assertion passed whether or not
  anything was substituted -- and the `add` declined note. It also asked for the
  prompt's discarded-value asymmetry to be written down, which is the paragraph
  above.

- **Round 4 was aimed at round 3's own fixes and at the prose, and it found the
  nested-`main()` leak** -- which is the one defect in four rounds that is a
  _wrong answer the previous round's fix produced_, and the entry above has it. It
  also found a test helper whose readiness condition was any `?`, which
  `ESC [ ? 25 l` satisfies **inside the first paint**, before the router has
  attached its stdin listener: it worked because a pipe holds what nobody has read
  yet, which is the shape of a test that passes for a reason other than its own.
  Then three sentences false about the code beside them -- `promptText` for the
  export's `text`, a package count read as a line count, and a demo header saying
  its third block writes nothing where the three _components_ do and two
  `console.log` lines stay -- and one assertion that could not fail, since the only
  writer of the string it looked for was the callback the test had just asserted
  did not run.

  Two of its findings were the right answers rather than defects and are now
  written down with their reasons: a mount resolving its level once, and
  `done()`/`stop()` giving the terminal back.

  And it **disputed the `mountLevel()` cost**, which is the entry above: the
  figure is reproducible three times over and theirs is a measurement that passes
  an `env` the real call path does not. Recording both is worth more than
  recording the number.

- **Two findings were refuted rather than fixed**, and both are recorded where
  they live. `--quiet --quiet=false` being quiet is `--help`'s rule, so it is
  pinned and documented rather than changed. And `resize(NaN)` is shared with the
  inline backend, so it is that backend's convention rather than this one's --
  what a sink can reach it through is an app calling `createSinkCanvas()` itself,
  since the renderer floors a width before it resizes.

- **And `sigil new --quiet` deliberately does nothing beyond its own prompts**,
  because the install writes through `stdio: 'inherit'` -- the package manager
  owns that output, which is the measurement "There is no live display in the
  toolchain" already records from the other side. What that measurement says is
  that piped npm wrote **four** lines, all at the end, and that a pty-driven pnpm
  wrote 21 carriage returns and 82 escapes for a fourteen-_package_ install -- so
  the README's reason is right and its count was the package count read as a line
  count, which round 4 caught.

#### What the sabotage pass found, and the two declared survivors

Fifty-five mutations, one at a time, counted against the shipped tree in **one
run** rather than summed across rounds, which is what makes the figure
re-derivable. **Fifty-three caught and two declared.** A green control first, and
the four verdict guards this repository has learned to need: a pattern that
matched nothing, a pattern that matched more than once, a replacement equal to its
original, and a run that found fewer test files than the control are each their
own verdict rather than a pass. The tree is restored on `SIGINT` and `SIGTERM` as
well as on an exception, and the harness **rebuilds both packages** per mutation,
because `packages/cli`'s tests read sigil's `dist/` -- the stale-dist trap this
file records, which without the rebuild makes every mutation in `src/` invisible
to half the suite.

- **One declared survivor is `detectQuiet()`'s `if (!option) return false;`**, and
  it is a fast path rather than a claim: a `ParsedOption` carries a **required**
  `option`, so an `undefined` one matches nothing and the scan below answers
  `false` either way. What it skips is a walk of `state.$` for every app that
  declared its own. What deleting it would cost is the reason it is kept rather
  than removed: the body is `detectVersion()`'s byte for byte, so taking it out
  here alone would make two copies of one function disagree -- which is the rule
  the paragraph above it keeps about the three flags reading argv the same way.

- **The other is `rewindQuiet()`'s own `asked()`**, which is a **tripwire**: its
  one caller passes what `getQuiet()` answered, and `setQuiet()` has
  already refused anything but a boolean for that. It is kept because the slot has
  two writers and that is the one place what the slot may hold is enforced --
  saying it once and trusting the other writer's caller is an invariant held two
  different ways.

- **Eight survived their first pass and every one was a test that could not see
  what it was named for**, which is the shape this file keeps rediscovering. Two
  are the sink's `render()` and `present()`, above -- the emptiness of the canvas
  covering for the absent write. One is the declaration check, which needed an
  explicit `name` to separate `find()` from `has()`. One is `createProgress`'s
  gate, which needed a bar built **before** the request, and one is `stop()`'s
  teardown, which needed its own test because the one beside it asserts `done()`'s.
  One is the `add` declined note, which needed a spawned child with a faked TTY on
  both streams and a key written to its stdin -- `runOnTerminal()` deliberately
  writes nothing to a child's stdin, "a prompt is not what to spawn", so a test of
  a path behind a confirm does both halves itself.

  And **two are that test helper's own claim**, which is the sharpest of the
  eight: taking the latch off, and looking for any `?` rather than the question,
  each left every assertion in the file green. Nothing outside the child can see
  either, because **a pipe holds what nobody has read yet** -- so an early key and
  a repeated one both work and neither is distinguishable from a correct one by
  reading the output. So the helper reports _when_ and _how often_ it answered and
  the test asserts that, which is the only shape that can fail for the reason its
  name gives.

- **One guard was deleted rather than tested**, which is what this repository does
  with one that cannot change an answer: a `=== true` beside `asked()` in
  `resolveOutput()`, where `asked()` has already refused everything that is not a
  boolean.
