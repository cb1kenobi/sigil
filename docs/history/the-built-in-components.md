# The built-in components — how it was arrived at

The review rounds, sabotage passes and by-hand audit passes behind
[packages/sigil/src/components/AGENTS.md](../../packages/sigil/src/components/AGENTS.md). The decisions themselves are
there; this is the record of what each round found, which is kept
because a finding nobody wrote down is one somebody re-discovers.

##### What the sabotage pass found

Forty-nine mutations against the final code, one at a time with the file's own
suite run after each. **Forty-eight are caught**, and the interesting half is not
the count: six guards turned out to be dead, one test turned out to be vacuous, and
two claims had no test at all.

Four of the forty-nine are there to answer one question about the suite rather than
about a guard -- could any assertion hold if the component simply drew nothing? A
view whose text is set to `''`, a view with no text child at all, a reveal that
never advances, and a mount that never happens are each caught by dozens of tests,
so the answer is no. Worth asking, because a component whose tests are mostly
`expect(log).to.deep.equal([])` can pass while drawing nothing, and three of this
one's are exactly that shape.

The harness reports a pattern that missed, a pattern that matched more than once
and a replacement equal to its original as their own verdicts rather than as
passes, and it needed to: three earlier rounds went **stale** as the code changed
under them, and a pattern that silently matches nothing is a green suite reading as
"the guard is not load bearing". The final tally is one run against one tree.

- **Three guards were dead because the signal layer already answers.**
  `State.set()` returns early when the new value equals the old, so a guard against
  an `append('')`, a second `start()`, and a write of a position that did not move
  were each a guard that could not fire. All three are gone and the properties they
  were standing for are asserted instead -- which is what `should change nothing on
  an append of nothing` and `should change nothing on a second start()` are for.
  Worth knowing because the spinner keeps the same `if (!spinning)` guard and is
  right to: there is a `state.outcome.set(undefined)` inside it, and here there was
  nothing.
- **Three more were dead for arithmetic reasons.** An early return for an empty
  string in `revealSteps()` could not change an answer, because no step can have an
  end past zero. A check for the end of the reveal inside the schedule was subsumed
  by the one under it, which answers `-1` for the same input. And the view's own
  clamp of the position was subsumed by `String.slice`, which clamps both ends, and
  by a comparison that behaves the same at both. Deleted rather than commented,
  which is what this file does with a guard that cannot fire.
- **One survivor stays and is declared.** `if (next < 1)` catches two things: the
  `-1` that is how the end of a reveal arrives, and a `0` that cannot be reached,
  because the snap above leaves the position at or past the end of the first step.
  Weakening it to `next < 0` therefore fails nothing; _removing_ it fails eight
  tests. It stays as one comparison rather than two, because what it would otherwise
  be is an unreachable `steps[-1]` and a crash, and the comment says which half
  fires.
- **One test was vacuous in the way this file keeps rediscovering.** `should not be
  undone by a step that was already in flight` advanced a hundred milliseconds and
  asserted the final position, so a step that had captured where it was going wrote
  a position behind the skip, rescheduled, and **caught back up** before the
  assertion ran -- green, with the text having come off the screen and gone on
  again. One interval is what makes it say anything.
- **And two claims had nothing asserting them, both found by the sabotage rather
  than by review.** Renaming `.sigil-typewriter-text` failed no test, so a theme
  written against the class could have stopped applying silently -- the registry
  reads the classes out of the source, so it agrees with whatever the source says.
  And `mountLive()` building its cascade from `{}` rather than from the caller's
  options failed no test in `components/`, `theme.test.ts` or `renderer/`, which is
  a hole older than this ticket: nothing anywhere asserted that a theme handed to a
  _mounted_ built-in reaches it. Both have tests now, and the second one closes a
  gap for every component rather than only this one.

##### What the sabotage pass found

Sixty-one mutations, one at a time with the component suite -- and the screen
model's own tests -- run after each. **All sixty-one are caught** bar seven, and
the seven are each declared where they live. The interesting half is not the
count: twelve survived the first pass, and what each of those twelve turned out
to be is the finding.

- **Four were a guard with a missing test, and each got the input that makes it
  matter.** `lineStart()`'s guard at zero, which `lastIndexOf` needs because it
  reads a negative `fromIndex` as _zero_ rather than as nowhere -- so a value
  that **starts** with a newline answered 1 for a cursor at 0, and the test for
  it used `'ab\ncd'`, which has no newline there to find. `offsetIn()`'s trailing
  column, below. The break test counting the gap, where the fixture happened to
  break at the same place either way -- `'aa bb'` in five columns is the input
  where it does not. And Ctrl-C being unclaimable, which needs a field that
  _would_ claim it: with any other submit key `claims()` says no to Ctrl-C by
  itself, so the refusal in `run()` was covered by the one thing it is not about.
- **Two were a fixture that could not reach the branch it was named for.** The
  paste giving the goal column up pressed Home first -- and Home clears the goal
  itself, so the paste's own clear was never the thing being asked about. And
  `move()`'s clamp, whose test walked a placeholder short enough to fit on one
  row, so the vertical move it was meant to provoke never called `offsetIn()` at
  all.
- **Two were `drawsText`, which nothing could see** -- and closing that is what
  `fieldLayers()` is. The two `raw` layers were built inside `multiline()`'s
  closure, so the only way to the elements was through a mounted prompt and the
  only way to a cell's `selectable` is `selectableAt()` over an arranged tree.
  As a function of a `FieldFrame` they are testable with no terminal and no
  keystrokes, which is the rule the layout engine and the selector engine
  already keep. Three claims came with it: both layers say `drawsText`, neither
  writes a `selectable` of its own, and a pane that excludes itself excludes the
  field -- which is the half an answer could not do and is the whole reason the
  flag exists.
- **Two were guards that were genuinely inert and are gone.** A `Math.min` of
  the window and the box's own height in the field's paint: the measure asks for
  exactly `visible` rows, so the two are the same number, and where a parent
  gives it more, drawing the extra rows would be drawing outside the _window_
  rather than inside the box -- so the window is the one bound. And a second
  bound on `area.height` and `area.width` in the caret's paint, written for a box
  squeezed below what the measure asked for, which this component cannot produce.
  The caret's **window** bound is real and took something _around_ the field to
  see: a caret painted outside the window lands on whatever the layout put there,
  and with nothing there the grid refuses the cell and the guard reads as inert.
  The fixture is the field between two rows that are not its, in both directions.
- **One was a `raw` painting a cluster the grid refuses**, and it is a tripwire
  rather than a case anybody has: `clusterText()` gives a control character no
  text, so nothing the field produces reaches it. What does is a `FieldCell`
  somebody else built, which is what the test hands it -- and `put()` _throws_ on
  a control character rather than dropping it, so what the guard is standing
  against is a frame and a renderer taken down from inside paint.
- **And seven are declared, five of them because the sabotage is _equivalent_
  rather than the code dead.** That is the shape this file already records from
  the FIGlet pass, and it is most of what is left once the real guards have
  tests: `clusterText()`'s newline branch, because `cellWidth('\n')` is zero --
  measured -- so the cell is unpaintable either way and what the branch buys is
  that no raw `\n` can reach `put()`; `typedText()` reading the sequence rather
  than the name, and refusing a key with a modifier held, because past its own
  `name === sequence` guard the two **are** the same string and a modified key's
  sequence is never its name; and the empty-input and empty-range fast paths in
  `insertAt()` and `deleteRange()`, where the slicing and the snap answer the
  same for a boundary cursor. `wordAfter()`'s clamp is the fifth: a negative
  offset is already past every cluster's start, so it behaves as zero. Its twin
  in `wordBefore()` is **not** equivalent and has a test -- the loop breaks at
  once there, so the fallback hands a negative offset straight back -- which is
  the pair worth knowing about, because the two functions look symmetrical and
  are not.
- **And `move()`'s snap and clamp are the sixth, declared for a different
  reason.** It cannot change an answer,
  because the one way an offset from the wrong string gets there is with a value
  of `''` and every rule below answers the same for any offset into that; what
  it buys is that the invariant is asserted where a cursor is written rather than
  assumed of each reader.

**And the harness reported a survivor it should have reported as its own
failure**, which is the third time this file has had to record that a sabotage
pass needs guarding as much as the code does. The replacement for the screen
model's clearing branch removed the `}` that closed the `if` above it, so what it
left behind was unbalanced -- and the run came back with no failures and no
harness complaint, which reads exactly like a guard that is not load bearing. The
balanced replacement fails the test named for it. So a harness that checks the
pattern matched once and that the replacement differs is checking two of the
three things: the third is that what it wrote is still the language.

Two findings came from writing the property tests rather than from the pass, and
both are about the delete paths. The cursor invariant is **inductive** -- it
starts at a boundary and every path takes a boundary to a boundary -- and a
delete can break it: both ends of the range are boundaries of the _old_ value,
and splicing puts two characters next to each other that were not. `e`, a tab and
a combining acute is three clusters; take the tab out and it is one, with the
cursor one code unit inside it. A pair of regional indicators does it with **no
control character at all**, so it is reachable from a single-line field too, where
it drew half a flag either side of the caret. `deleteRange()` snaps, which makes
the invariant total; and the property test had to be narrowed to the boundaries,
because walking every offset asserts something the functions do not claim and
cannot -- handed a cursor inside a surrogate pair, a delete splices inside it,
which is what `boundary()`'s own doc records and is byte for byte what the
single-line field did before any of this was extracted.

##### What the sabotage pass found, and what it got wrong about itself

Forty-four mutations, one at a time with the component's and the theme's suites
run after each. **Forty-three are caught and one is declared.** Thirty-seven of
them were applied before the first review round, four more over the guards that
round produced, and three over the function-pattern coverage the second round's
worklist bought; the figure above is one run against the shipped tree rather than
a sum across rounds, which is what makes it re-derivable. The interesting half is
not the count.

- **The harness's first run was vacuous and the harness said so was a pass.**
  `registry.test.ts` was in the suite list, and it compares the shipped registry
  entry against the source byte for byte -- so it fails on **any** edit to
  `qrcode.ts`. Two real survivors were therefore reported as "caught by 1: the
  registry", which is a universal catcher rather than a statement about a guard.
  Found by reading what caught each mutation rather than the count, which is the
  fifth distinct way this repository has had a sabotage round turn out to be
  saying nothing -- after a stale pattern, an apostrophe spelled as an escape, a
  `perl` substitution that matched nothing, and a `vitest run` whose paths were
  relative to the wrong directory. The harness already reported a pattern that
  missed, one that matched more than once, and a replacement equal to its original
  as their own verdicts; it now also refuses a run that found fewer tests than the
  control, and the control itself is a run of the untouched tree.
- **One mutation was caught by the formatter rather than by a test**, which is the
  stale-pattern guard earning its keep a sixth time: `pnpm fmt` had reflowed
  penalty rule four onto one less tab than the pattern quoted, so the round
  reported `PATTERN MISSED` instead of a pass.
- **A real defect, found by the reference vectors on their first run: the
  zigzag's timing-column shift did not carry.** The data placement walks column
  pairs from the right, and the pair that would straddle the vertical timing
  pattern is shifted one left -- and the shift has to _carry_, so the pairs after
  it are 3-2 and 1-0. Written as a local computed from the loop variable rather
  than as an assignment to it, column 4 is visited twice and **column 0 never**,
  which is a symbol that differs from every other encoder's in its last four
  columns and in nothing else. Twenty-one of twenty-two vectors failed on exactly
  those four columns of four rows, which is what made it diagnosable in one read.
  This is the argument for a reference fixture in one sentence: the structural
  checks -- finders, timing patterns, the dark module, 160 version-and-level
  combinations -- all passed throughout.
- **One guard was dead and is deleted.** `EXP[255] = EXP[0]`, which every
  implementation of this field writes. `multiply()` indexes
  `EXP[(LOG[a] + LOG[b]) % 255]`, so the index is 0 to 254 and 255 is never read;
  the table is 255 long now, which makes the property structural rather than a
  comment.
- **Three survivors were the harness being blunt rather than the code being
  unguarded**, which is the boundary this file records from the FIGlet pass. The
  generator's carry term replaced with `result[j + 1] ?? 0` is _equivalent_, since
  `undefined ?? 0` XORs nothing; the short blocks' missing column replaced with
  `column < block.length` is equivalent, because that is what the two block sizes
  come to; and dropping the `inside` test in favour of optional chaining is
  equivalent, because a negative array index answers `undefined`. Each has a
  sharper mutation now -- a wrapping read, `if (true)`, and `(inside || true)` --
  and all three are caught.
- **Three survivors were a fixture that could not reach the branch, and each got
  the input that makes it matter -- found by searching for that input rather than
  by reasoning forwards from the survival.** Version 32's alignment step, which
  the spec puts at 26 where the formula comes to 28, so no symbol but version 32
  can see it and no vector was one: `q`.repeat(791) at H is version 32, and it
  catches that mutation and **only** that one. The mask tie-break, `here < score`
  rather than `<=`, which needs two masks with _identical_ penalties: found by
  searching six thousand random payloads, `5s3e-_wdt:43:bcd1x` at Q scores 464 on
  both mask 3 and mask 6, and the reference encoder agrees the lower-numbered one
  wins. And penalty rule four's weight of ten, which for most payloads is zero on
  every mask because the dark proportion sits inside one 5% step: the same search
  found `_y-6uj9oyvu_dg4otl-gw25:aziy` at L, where the weight picks mask 7 and
  dropping it picks mask 2. Each of those three vectors is caught by exactly one
  named test, which is what says the search found the right input rather than a
  bigger hammer.
- **Two of the four mutations the review round's fixes earned were equivalent,
  and the reviewer predicted one of them.** The overflow message's
  `COUNT_BITS[mode][2]` replaced with a flat `14` changes no figure: measured over
  all twelve combinations of level and mode, the three band-2 widths floor to the
  same held capacity as a flat 14, because a difference of a bit or two cannot
  cross a 10-, 11- or 8-bit group boundary at version 40's sizes. Band 0's widths
  do differ, by one character in eleven of the twelve, so the mutation is band 0
  now and is caught. It is also the finding that bought a free cross-check: those
  twelve figures are the spec's own version 40 capacities, so `should name the
  published capacity in the message, for every mode and level` is a **second** path
  to a number the encoding test already reaches by encoding -- a capacity
  derivation that drifted would have to drift in both to stay quiet.
- **The one declared survivor is the terminator at capacity, and it is an
  equivalence rather than a fast path.** The spec shortens or omits the four-bit
  terminator for a payload that exactly fills its version, and dropping the
  capacity condition changes no byte: the extra bits are zeros, and the loop that
  writes them writes past the end of a `Uint8Array`, which drops them. It stays,
  and says so where it lives, because what the function means is "the terminator
  is shortened at capacity" rather than "a typed array is tolerant of an
  overflow" -- and the day the buffer stops being one is the day the difference is
  a wrong codeword.

##### What the first review round found, and it was almost all prose

Thirteen findings, **every one confirmed**, and the shape is the one this file
already records: a round pointed at a diff finds sentences. The encoder's
arithmetic was checked against the spec by hand -- the degree-7 generator
expanded coefficient by coefficient against the published polynomial, the format
bits for L mask 0 as `0x77C4`, the version bits for 7, version 32's alignment
centres, all eight masks, the four penalty weights, both finder windows, and
spot-checks of the two capacity tables -- and **nothing in it was wrong**. Of the
thirteen findings, nine were a comment or a sentence that was false about the code
beside it, two were a vacuous test, one was a misleading error message, and one
was a gap in a file that is not in this diff at all.

- **`generator()`'s own doc comment had the coefficient order backwards**, which
  is the most dangerous finding of the thirteen. It said "highest-degree-last"
  and the array is highest-degree-**first** -- `[0]` is the coefficient of
  `x^(degree-1)`, which is the order `remainder()` reads, since that takes
  `result[0]` as the high coefficient before the shift. Verified by expanding
  degree 7: `[127, 122, 154, 164, 11, 68, 117]` is `alpha^87` through `alpha^21`,
  the spec's own polynomial read left to right. Somebody reversing the array to
  match the comment would emit a wrong ECC codeword for every block there is,
  which is the failure the comment-aligns-the-code hazard describes exactly.
- **The zigzag's direction comment claimed a flip that does not happen.** It said
  the timing-column shift "flips it for everything left of the timing pattern",
  and `(right + 1) & 2` is the same bit for 6 and 5, for 4 and 3, and for 2 and 1
  -- measured over all six. What the assignment changes is which columns are
  visited and nothing else, which the comment above it already said. Compensating
  for the flip would reverse every pair left of column 6.
- **The module-row count is always odd, so the padding's even branch is
  unreachable -- and the test's own comment named an odd number as the even
  case.** A symbol is `4 * version + 17` modules on a side, which is odd for
  every version, and a quiet zone is added twice, which is even. The test had
  gone looking for an even span and offered "a quiet zone of 3 on version 2,
  which is 31" as one; 31 is odd, and so is every other span there is, checked
  over 40 versions and nine quiet zones. The expression stays written as a parity,
  because the parity is the _reason_ it adds one rather than a case it handles,
  and `should be an odd number of module rows for every version` is what makes
  that a checked fact instead of a sentence.
- **Two tests were vacuous about the thing they are named for.** `should draw the
  dark modules wherever it can paint its own colours` looped the levels and then
  drew with `invert: false` **itself**, so the level never reached `polarity()`
  and deleting the `level > 0` branch left it green -- the branch was pinned by
  its neighbours, which is not the same as being pinned by its own test. It
  compares the drawn output at each level against the un-inverted drawing now, and
  against a level-0 dark terminal, which must differ. And the overflow-message
  test asserted only that the level is named, which survived the message's real
  defect.
- **The overflow message named a capacity that was not the mode's.** It computed
  the held figure from a fourteen-bit count indicator whatever the mode and
  labelled it "bytes" for all three, so a numeric payload over capacity was told a
  number it was nowhere near -- 2,331 against the 5,596 digits version 40-M
  actually holds. It names the mode and that mode's own capacity now, and the
  three figures the test asserts -- 5,596, 3,391 and 2,331 -- are the published
  version 40-M capacities, so the arithmetic is cross-checked rather than
  self-consistent.
- **A `form` that is neither of the two was drawn as compact.** TypeScript refuses
  it and a JavaScript caller is not typed, so `form: 'Large'` drew the wrong code
  and said nothing -- which is the parses-and-does-nothing shape, and is refused
  now the way an unknown error-correction level already was.
- **`test/dist.test.ts`'s `IMPLEMENTATIONS` had no entry for this component**,
  which is the gap that file's own comment is written about: "a component added
  without a name here is one whose absence from the root entry is pinned by
  nothing it can be renamed out of", after `ScrollBox` and `createTypewriter` had
  each been missing. A third instance, found by a round that read a file outside
  the diff.
- **The probe drew three of the four form-and-polarity combinations while the
  module doc claimed four.** The large form was never shown inverted, which is
  what a `| cat` of a large code looks like. The step was added rather than the
  claim weakened, because the claim is the useful one.
- **Three more sentences were simply false about their neighbours**: the demo said
  level H is two versions larger than L for its payload, where it is one (L and M
  are version 3, Q and H are version 4); the sheet comment and the probe heading
  said level 0 is the inverted form without the scheme qualification, where
  `polarity()` reads both and a pipe with `SIGIL_COLOR_SCHEME=light` is not
  inverted; and the `café naïve` vector's `why` said "the character count is
  the byte count" of a string that is ten characters and twelve bytes, which is
  the opposite of the thing it is in the list for.
- **One finding was found twice, independently and within the hour.** The demo and
  the probe printed a code's size with `String.length`, which above colour level 0
  counts the SGR that paints the two colours -- so a 37-column code was reported
  as 49 on a colour terminal and correctly at level 0, where there is no sequence
  to count. Both now measure through `strip()` and `stringWidth()`, which is what
  every other size in this repository is measured through and for the table's own
  reason. Worth recording as a near-miss about the method rather than about the
  bug: it was found by printing the number and reading it, which is the one check
  no test in the suite makes, because a vitest worker's stdout has no colour.

##### What the second review round found, and what it could not

The round was pointed at the files round 1 listed as skipped, which is the half
this file records as the one that pays -- measured over ten rounds, a round that
re-attacks the previous round's premises confirms them and finds nothing new,
while the only findings of the last round come from a file no round had opened.
It is the shortest entry here because **the reviewer looped**: three attempts, two
of them with the eight-item worklist and one with a short single-focus prompt, and
each came back `Agent Looping Detected` rather than a review. So the worklist was
done by hand, and what follows is what that turned up rather than what a reviewer
said. Recorded as a limitation rather than glossed: the regions below were read by
the same person who wrote them, which is weaker evidence than the first round's
and is the reason this entry says what it checked rather than only what it found.

- **The fixture had nothing checking it, which is the worklist's own first item
  and is the biggest thing this round bought.** It is up under "How the codes
  were established to be scannable", because what it produced belongs with the
  other two layers rather than in a round's notes: one helper over two subjects,
  and three more mutations, all caught.
- **One existing count elsewhere in AGENTS.md had become false.** The Themes
  section said `.sigil-caret`, `.sigil-scroll-track` and `.sigil-debug` are "the
  three declared exceptions" and named the invariant as `should declare on a role,
  bar three exceptions that say why` -- a test title that no longer exists, since
  the test was renamed to four in this change and the sentence was not. Found by
  asking the question the worklist asks rather than by reading the diff, which is
  the only way to find it: the stale sentence is four hundred lines from anything
  the diff touches. The other counts were checked and hold -- seven roles, the
  light half's two rules, and the themes' "all seven roles".
- **One `the claim:` line was imprecise, which matters because those are promises
  to somebody holding a camera.** The inverted step said a scanner that reads the
  painted codes and not that one "is why the polarity is worked out rather than
  fixed", which conflates two things: the inverted code **is** correctly polarised
  -- dark modules on dark, light on light, exactly as the painted ones -- so a
  scanner that refuses it is reporting its terminal's own contrast rather than a
  polarity it cannot read. It says that now.
- **The probe had never been run, and running it is what says the mode works.**
  Driven through a faked terminal on both streams, with a key fed per prompt: all
  seven steps draw, all seven `the claim:` lines print, 5,455 full blocks and 190
  braille cells reach the stream. Worth doing because every other claim about that
  mode is a claim about a file nothing executes -- `demos.test.ts` spawns the demos
  and nothing spawns the probe.
- **Neither `--qrcode` nor `--clipboard` exits on its own once its steps are
  done**, measured over a piped stdin that stays open: both are still running
  after twelve seconds, which is the pipe keeping node's stdin handle referenced
  rather than anything either mode does. Shared behaviour rather than something
  this change introduced, which is why it is written down rather than fixed inside
  a ticket about a QR code.
- **The eject was run rather than assumed, and it needs nothing of the
  scaffold.** `sigil add qrcode` into a bare app copies one file whose four
  imports are all rewritten to published subpaths, and the ejected copy
  **type-checks clean** -- with `lib: ["esnext"]` and `types: ["node"]`, which is
  what `sigil new` writes, and also with the **default** lib, which is the half
  worth knowing: `spinner.ts` needs those two lines, because `lib.dom` declares
  `setInterval(): number` and shadows `NodeJS.Timeout`, and this component holds
  no timer and no DOM-shadowed global, so it adds no constraint of its own.
  Checked both ways rather than inferred from the spinner's entry.
- **The rest of the worklist is clean, and saying which is the point of having
  one.** `--qrcode` needs no `finally`, because `key()` puts raw mode back itself
  after every key and the mode sets no mode and queries nothing -- which is
  `--clipboard`'s position and not `--mouse`'s. The barrel exports all twelve
  public names and no name it does not declare, checked by reading both sides
  rather than by eye. The registry entry resolves every import to a published
  subpath, which the generator refuses by name otherwise. The demos table row is
  the same 128 characters as its eight neighbours. And no new file holds a raw
  control character, a byte order mark or a zero-width joiner, which is the half
  `test/sources.test.ts` checks for `src/` and nothing checks for `demos/` or
  `scripts/`.

##### What the sabotage pass found, and what the harness had to guard

Sixty mutations, one at a time with the six affected suites run after each.
**Fifty-four caught by an assertion, one by the worker dying, five declared** --
and the review rounds added sixteen more over their own fixes, seven and nine,
all caught by exactly the test named for each. Seventy-six in all.

The one that kills the worker is the **cycle guard**: without it the walk
recurses forever, vitest's worker exits during `started` state, and there is no
summary line to read. The harness reports that as `HARNESS BROKEN: no vitest
summary` rather than as a pass, which is the guard doing its job on a verdict it
genuinely cannot form -- and the behaviour is the strongest catch there is.

Which is what the harness is for. It reports a pattern that matched nothing, a
pattern that matched more than once, and a replacement equal to its original as
their own verdicts rather than as passes, and it refuses to answer at all unless
vitest reported the right number of suites, because a `vitest run` whose paths
miss exits non-zero and reads exactly like every mutation being caught. A green
control runs first.

All three of those earned it on this branch. Six patterns went **stale** when the
formatter reflowed a line and the review fixes moved three others, and reported
`PATTERN MISSED` rather than five more guards looking dead. And the summary regex
itself was wrong twice over: it required a `passed` count, which a run where
**every** suite failed does not print, so a single-suite re-run answered
`HARNESS BROKEN` eight times in a row. The total in parentheses is the one number
that line always has.

What the pass found is worth more than the count.

- **Two guards were deleted for being unable to fire**: the `paths` dedup beside
  the cycle guard, and the `!deferred` test on the walk, both above. This entry
  said three and named `parserOwned` in `slotsFor()` as the third, and that was
  **false in two ways** -- caught by a later review round reading the file the
  sabotage pass had reported on. The guard was never deleted and is still there;
  and `--help` is not "the only option the parser adds", since `version.ts` marks
  `--version` the same way. What is true is that it is **inert**, measured: with
  the `continue` removed the whole suite passes. It is kept rather than deleted
  because what makes deleting it safe is two steps rather than one impossibility
  -- a flag carries a `false` default, so its destination would join `answered`,
  which is harmless only because the ask pass skips a flag for not being
  `required`. It says that where it lives now. Its test is renamed to the claim
  it really makes, that the options every schema gets for free are not asked for.

- **One guard was deleted.** The empty-label early return in `highlightRuns()`
  is gone, because `graphemes('')` yields nothing and the loop answers `[]` on its
  own.

- **And one was reframed, wrongly, which is the pass's own boundary showing.**
  The `--no-` skip in `spellingOf()` was called a **preference** rather than a
  guard, on the argument that a negated flag always has an implied default so
  `slotsFor()` never asks for one. That argument is sound and the conclusion was
  not: the skip was a **filter**, and the first review round found the shape it
  dropped -- a valued `'--no-color <when>'`, which keeps one long spelling because
  `initOption()` rewrites a `no-` name only for a flag. A sabotage of it was
  _caught_, by a test over the dual spelling, so the pass said the line was load
  bearing and said nothing about what it was load bearing for. A deletion asks
  whether code that is there matters; it never asks whether the thing that matters
  is the thing you wrote down.

- **Nine survivors were missing tests, and each got the input that makes it
  matter** -- reasoned backwards from "what would make this guard load bearing"
  rather than forwards from "no test failed". The code-point walk in
  `highlightRuns()`; the deferred-placeholder-with-subcommands case, which is one
  input for two guards; the three-deep path reversal; a non-array `choices` on an
  **argument**, which `initArg()` does not validate and `assertChoices()` ignores,
  so projecting one through would refuse every value for a declaration the parse is
  happy with; an optional `bool`; a required variadic answered with nothing; the
  `order` property; the row reset; and the label rebuild.

- **Five survivors stay and are declared where they live.** Two are fast paths in
  `fuzzy.ts` -- the empty-query early answer and the length guard, both of which
  the three passes below them answer the same way. One is a **narrowing** rather
  than a guard: `spelling === undefined` in `slotsFor()` cannot fire, because
  `initOption()` refuses a declaration that names no spelling, and it is what lets
  the slot carry a `string` without a cast. One is a fast path in the draw: a row
  that is `display: none` is neither measured nor painted, so rewriting its runs
  changes no answer. And one is unreachable today with a reason: the `positional &&`
  on the stop condition, because an option slot is always required and a required
  slot is never answered empty -- it is written because the rule is about positions,
  and "any empty answer stops the rest" is a different rule that happens to agree.

- **And the packaging test's own sabotage sharpened what it claims.** Importing
  `initArg` from `src/parser/` leaves the graph where it was, because that module is
  a leaf rolldown puts in this chunk -- so the test pins `parse.ts` specifically
  rather than everything under `src/parser/`. Importing `parse` itself fails it and
  takes the graph to 253,201 B. Its first spelling looked for `parseArgv`, which the
  minifier renames, so the marker was in no bundle at all and the assertion said
  nothing; it asserts the marker's **presence** somewhere in `dist/` before
  asserting its absence from the graph, which is the rule the component list in that
  file already keeps.

##### What the first review round found, and it was four wrong argvs

The round was pointed at the three new files, the parser functions they share,
the tests, and the prose, and it was told not to run anything. It reported the
three passes of `fuzzyMatch()`, `highlightRuns()`, the `run` export and the
`Object.freeze` as holding, and then found **four places that hand the parser an
argv it refuses** plus one degenerate input and five stale sentences. Every one
was confirmed against the code before anything was changed, and each fix is
pinned by a test the sabotage of that fix fails -- seven mutations, seven caught,
each by exactly the test named for it.

- **The `--no-` preference was a filter, and it dropped a required option.** The
  entry under `spelling` has it. The shape is
  `{ format: '--no-color <when>' }`, which `initOption()` leaves with one long
  spelling because it rewrites a `no-` name only for a flag.
- **A declared choice was offered unchecked.** The entry under
  `checkSlotValue()` has it, and the sharp input is a `yesno` argument with
  `choices: [true, false]`.
- **A variadic line was trimmed, and a refused one was discarded in silence.**
  Two findings about one loop; the entry under the variadic slot has both.
- **`rows: NaN` blanked the list.** Its own entry above.
- **And five sentences were false about the code beside them**, which is the
  finding this file keeps calling the dangerous one: the `--no-` comment's "both
  spellings resolve", `spelling === undefined`'s "cannot fire", the module doc's
  and `checkSlotValue()`'s "the one place a value is asked about", the variadic
  loop's "the same shape as the one `text()` already has", and `demos/README.md`
  on `--steps`. That last one is the smallest and the most instructive: the README
  said `--steps` is absent "because it has a default" and the demo declared it
  `'--steps [n]'`, so it was absent because it is **optional** and the default
  never came into it. Corrected by changing the demo to `'--steps <n>'`, which is
  the shape the sentence describes and the one worth demonstrating.

Three things it confirmed are worth recording, because they are the claims a
reader would doubt. The third pass of `fuzzyMatch()` stays in range, by the
invariant its comment states. The `seen` guard's path-insensitivity is already
written down. And `fromEnv()` reads the same truthiness `envValue()` does, so
`""` is unset while `"0"` and `" "` are values. It did **not** verify the byte
figures, because it was told not to build.

##### What the second review round found, and it was one defect and one sentence

Round 2 was told not to re-attack round 1's premises and to work from round 1's
own "not examined" list first, which is the shape this file already records:
measured over ten rounds on this repository, a premise-attacking round confirms
and finds nothing new, while the findings come from the files nobody opened. Both
of its findings came from that list, and it confirmed every one of round 1's
fixes against the code.

- **A required option on an **ancestor** was never asked for**, which is the
  entry above. It came from reading `parse.ts` rather than the diff --
  `validateOptions()` flattens every context's options -- and it is the one defect
  either round found that the whole design was already written against: the
  palette's own rule is that a command it listed and could not run is worse than
  one it did not list, and this was that rule applied to the chain the parser
  already walks. Nine mutations over the fix, nine caught, and four of those
  needed a tree **two deep** or an argv that **named a command**: at one level
  `[child, cmd, ...above]` with an empty `above` is already the right answer, so a
  one-level fixture cannot see the chain being carried at all.
- **And one sentence named the wrong refusal**, which is the ejectable entry
  above. Adding the palette to `ENTRIES` does fail the build; the first specifier
  the generator refuses is `../types.js` rather than `../util/transform.js`, and
  only the second of those is a statement about the public API.

It also found the harness's own summary regex, twice over. The first spelling
required a `passed` count, which a run where **every** suite failed does not
print -- so it answered `HARNESS BROKEN` for eight mutations in a row rather than
`caught`, which is the right way for a harness to be wrong and is exactly what
the three verdict guards are for. The total in parentheses is the one number the
line always has.
