# A debug overlay: captured console output and frame stats — how it was arrived at

The review rounds, sabotage passes and by-hand audit passes behind
[packages/sigil/src/components/AGENTS.md](../../packages/sigil/src/components/AGENTS.md). The decisions themselves are
there; this is the record of what each round found, which is kept
because a finding nobody wrote down is one somebody re-discovers.

#### What the sabotage pass found, and what it got wrong

Thirty mutations, one at a time with the three affected test files run after
each. **All thirty are caught**, and what the passes found is worth more than the
count -- two defects, two guards that could not change an answer, and two
fixtures too easy to reach the branch they were named for.

- **A real defect: the pane overflowed its own box.** Found sideways, by a
  sabotage of the _follow_ whose test did not exist yet -- the `min-height: 0`
  entry above has the measurement. Forty rows inside a box drawn for six, painted
  through its own bottom border.

- **A real defect the second pass found, and the sabotaged version was
  _better_.** The console restore had a single `restored` latch, and deleting it
  meant the loop ran again on a second call -- which for the one sequence that
  matters, a foreign patch over ours that is later restored, **closes the orphan**
  rather than leaving it. A guard whose removal improves an answer is not a fast
  path, so what replaced it is a per-level record and a retry: the entry above has
  what that comes to.

- **Two guards that could not change an answer, deleted rather than commented.**
  A `done.has(level)` check in front of the retry, which `restoreOne()`'s own
  refusal already answers -- a level already put back is one whose patch is no
  longer ours. And the pane's unchanged-ring fast path is the one survivor that
  **stays**, declared where it lives: without it the two loops run and find
  nothing to do, so no answer changes, and what it buys is not walking five
  hundred rows on every frame of an app whose log is quiet.

- **Two fixtures that could not reach the branch they were named for**, which is
  the shape this file keeps rediscovering. `should follow with no stats line to
  ask for the frame` filled the ring while the pane was **open**, where the sync's
  own append marks the tree and the frame after it comes for free -- so the retry
  it was named for was never reached. It fills the ring while closed now. And
  `should drop its handlers and its exclusions on dispose` asserted that a second
  renderer over the same tree saw it whole, which it does whether or not the first
  cleared anything, because it has sets of its own: that one was **deleted**, and
  the clear is declared where it lives instead.

- **One guard that is declared rather than pinned**, for the reason above:
  `teardown()` clearing its handler and exclusion sets is a reference drop with no
  observable answer -- no frame runs after it, `stats` is not recomputed, and a
  second renderer has sets of its own. It is the category `Restyler.forget()` is
  in, and a test that looked like it pinned it was worse than none.

- **And the harness reported three stale patterns rather than passing over
  them**, which is the guard this file records twice and the third time it has
  earned its keep: every one of them went stale when the follow and the restore
  were rewritten, and a pattern that silently matches nothing is a green suite
  reading as "the guard is not load bearing".

#### What the second review round found, and it was all prose

Eight findings, and **six of them were a comment or a line of documentation
contradicting the code** -- which is the shape this file already records as the
one a documented codebase is _more_ prone to, because the written rule is what
stops the next reader checking the call site. The other two were tests too easy
to fail. Not one was a runtime defect in the five fixes the first round produced,
and the round was pointed at the files the first round had listed as **skipped**,
which is why it found a different kind of thing.

- **The module docblock's own example passed `key: 'f12'`**, a string, to an
  option that had become a predicate in the same commit -- so copying the example
  is a type error and, past that, a `TypeError` out of the router's dispatch. The
  option's own comment two hundred lines below says in as many words that `f12` is
  not a name this decoder produces. The one place somebody copies from was the one
  place not updated.

- **Three comments said "every line draws in a role"**, which is false of `log`.
  The entry above has it.

- **The sheet's own comment said its light half was "one declaration"**, which the
  overlay's background made two. The AGENTS.md entry for it was already correct and
  the sheet was not, which is the direction that catches somebody aligning the code
  with the comment: deleting the second rule leaves a light terminal with index 0
  behind its own dark default foreground.

- **The demo and `demos/README.md` both said "the three fields after `el` are the
  canvas's"**, and there are four, of which the first is `resolved` -- a count the
  cascade hands back rather than a canvas measurement. Two different reasons for
  the same "includes the pane", described as one.

- **And `demos/README.md` said all three renderer demos print one line without a
  terminal**, where this one prints two. A sentence that was true of its two
  neighbours and was extended to cover a third without being re-read.

- **Two tests could not fail.** The role test is the entry above. And the dispose
  test's `stats.elements === 2` was called the exclusion going back, where it is
  only the detachment: `countTree()` walks from the root, so a detached pane is
  uncounted whether or not it is still in the set. What tells the two apart is
  putting the pane **back** in the tree after `dispose()` and finding it counted,
  which is a real statement besides -- a disposed pane is an ordinary element
  again.

- **And the sheet's backtick trap bit while the fix for it was being written.**
  `FRAMEWORK_CSS` is a template literal, so this file already records that it holds
  no backtick -- and a comment added to it holding `` `console.log` `` ended the
  sheet, with the parse error reported twenty lines further down than the character
  that caused it, exactly as that entry predicts. The comment now says so where it
  sits, because the next person to write prose in that string will reach for one.
