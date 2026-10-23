# Layers and masks: compositing, and the transition it buys — how it was arrived at

The review rounds, sabotage passes and by-hand audit passes behind
[packages/sigil/src/canvas/AGENTS.md](../../packages/sigil/src/canvas/AGENTS.md). The decisions themselves are
there; this is the record of what each round found, which is kept
because a finding nobody wrote down is one somebody re-discovers.

#### What the first review round found

Two concrete wrong grids, both confirmed and both fixed. The round was pointed at
the composite's wide-cluster handling, the occupancy bookkeeping, the sweep over
persistent layers, the clipping at each edge and the mask generators, and it
reported the last three clean.

- **A clip could leave half a glyph behind, and that one is the element tree's
  rather than a stray `clipTo()`.** `#breakCluster()` found the other half of a
  cluster through `#at()`, which honours the clip -- so overwriting half of a wide
  cluster whose other half sat one column _outside_ the clip blanked nothing. The
  diff then drew the surviving lead over both columns: the cell inside the clip
  had been changed and the glyph on screen had not. Reachable in an ordinary
  frame, which is what makes it worth fixing rather than noting -- a wide cluster
  drawn by one element across a clip boundary and overwritten by a clipped
  sibling is exactly it, and `Painter.clip()` is how `overflow: hidden` is
  painted.

  The fix is `#onGrid()`, which asks about the grid's bounds and not the clip, and
  the argument is that **the repair is not a paint**: the clip governs what a
  caller may paint, while repairing a cluster is the grid un-painting a cell it
  wrote itself. Both halves are damaged either way -- that is what painting over
  half a cluster means -- and only one of the two answers leaves the grid
  addressable, which is the whole of what the continuation marker is for.
  `restyle()` had the same shape for the same reason and got the same fix, which
  matters more than it looks: `Painter.overlay()` asks `inside()` before it gets
  there, so a selection run inside a clip touching a cluster whose lead is outside
  left the lead in its old style and the glyph rendered in that.

  Pre-existing on `main`, which the round said itself. It is fixed here rather
  than filed because it is a wrong frame the ticket's own test requirement is
  written about -- "no wide cluster may lose its continuation and no continuation
  its lead at the end of a frame" -- and because nothing in the suite asserted the
  old behaviour, so the fix cost nothing to make.

- **Compositing a grid onto itself smeared it, and is refused.**
  `canvas.layers.push({ cells: canvas.cells, x: 1, y: 0 })` reads and writes the
  same arrays left to right, so the walk reads the cell it wrote one column ago:
  `['A','B','C']` came out `['A','A','A']`. Reachable because `cells` and `layers`
  are both public, even though `cells` is documented for reading. A copy per row
  would make the aliasing _work_, which is inventing a feature nobody asked for;
  a `TypeError` names the mistake where it was made, which is the line `rgb()`
  already takes with an out-of-range channel. Nothing in the library pushes
  `canvas.cells`, so this is a guard against a caller rather than against the
  framework.

- **And two sentences that were false about the code beside them.**
  `copyFrom()`'s doc said "must be the same size" over a body that reallocates --
  true of both callers here and not a constraint the method has. And phase zero's
  own comment claimed each move makes "the total" strictly decrease, where the sum
  of the energy _array_ is invariant on a torus: every cell's splat carries the
  same mass wherever it sits. What decreases is the **pairwise** energy, the sum
  over pairs of set cells, which is what the strict comparison actually changes by
  exactly the difference. The termination argument was right and the sentence
  naming it was not, which is the failure a documented codebase is most prone to.

- **Five of its fixes' guards were sabotaged and all five are caught**, after one
  survivor and one deletion. The survivor was a missing test: the re-style case
  covered a clip excluding the _lead_ and not one excluding the continuation,
  which is a different branch. The deletion was an integer check copied into
  `#onGrid()` beside `inside()`'s -- both callers are one column either side of a
  cell that has already been through `#at()`, so `x ± 1` is an integer by the time
  it arrives and the guard could not fire.

#### What the second review round found, and the shape it came in

Pointed at the files the first round's own SKIPPED list named -- the tests, the
public surface, the orderings, and the prose -- it found **no runtime defect and
five sentences that were false about the code beside them**. That is the pattern
this file already records from the windowing work, reproduced exactly: a round
aimed at the same diff confirms, and the findings come from what nobody opened.
It also confirmed all four of the first round's fixes, which is the other half of
that pattern.

- **`restyle()`'s own comment had the composite ordering backwards.** It said "a
  selection is painted over the canvas's own grid after the composite, not over a
  layer" -- and `paintSelection()` runs _inside_ the `canvas.paint()` callback, so
  the highlight lands **before** the layers composite over it. The conclusion was
  right and the reason was inverted, which is the worse of the two ways to be
  wrong: somebody aligning the code with that sentence would move the selection
  pass after the composite and reverse a decision recorded two subsections up.
- **Two measurement comments were stacked over one assertion block**, the stale
  one naming three counters and 193 / 86 / 35 where the live assertions are four
  and 250 / 60 / 25 / 20. An editing slip rather than a claim, and exactly the
  kind a reader believes because it is specific.
- **`323 / 82 / 37 / 33 of 240` is wrong about the first number.** `seen.wide`
  counts per **grid**, base and layer, so its ceiling is 480; the other three are
  per composite. The figure was right and the denominator was not.
- **An assertion's lower bound was vacuous and its comment claimed otherwise.**
  `should open by area rather than by cell count` said the bound "sits clear of
  both numbers", and the lower one was `> 0` -- which a reveal of one cell passes,
  so the upper bound was carrying the whole claim. It is `> 25%` now, and the two
  sabotages that bracket it -- a cubed distance, which reveals almost nothing, and
  one tuned to reveal exactly half as a ranked field would -- each fail it.
- **"A backend with no terminal never calls `present()`" named the wrong
  method**, in two READMEs and in `snapshot()`'s own doc. `render()` always calls
  `backend.present()`; what it returns before is `canvas.present()`. The
  behaviour described is right and a reader checking it would have found the call
  and concluded the sentence was false.

- **And one observation that was right about a gap and wrong about the fix.** The
  round noted the fuzzer's replay compares `toLines()` only, so a style-only
  difference is invisible there. True -- and a style comparison inside the replay
  cannot close it, which is what writing one showed: `replay()` compares the model
  against the grid, and both sides read whatever style the composite wrote, so a
  composite that carried the style one cell along passes. The loop was deleted
  again for being a guard that cannot fire, and `should carry each cell its own
  style, not a neighbour's` replaced it -- three styles side by side against
  **expected** values, which is the only shape that can see it. A differential is
  blind to an error both of its sides share.

#### Two defects this found that predate it

- **A coordinate that is not a whole number crashed the grid, and `NaN` with
  it.** `inside()` answered `true` for `0.5` -- every comparison in it passes --
  so `#at()` produced a fractional index, `#chars[0.5]` was `undefined`, and
  `cellWidth(undefined)` threw out of `graphemeWidth()` three frames inside
  `put()`. `NaN` reached the same place by failing every comparison rather than by
  passing one, and both infinities with it. Pre-existing and reachable through
  `write()`, and what made it _likely_ is a `Layer` origin: it is the first
  coordinate here a caller fills in as a plain field rather than getting from a
  loop. Answered in `inside()` rather than truncated in the one caller that found
  it, because that is where the index arithmetic is -- the same argument the clip
  itself already takes, and it fixes every caller at once. Refused rather than
  rounded, which is the rule a fractional length already follows: a coordinate that
  is not a whole number names no cell, which is the same answer as one past the
  edge.

  What it costs is nothing measurable, which had to be checked because `inside()`
  is asked once per cell by `put()`, by every read through `#at()` and by the
  diff's own `charAt()`. Six interleaved rounds of a full 80x24 paint and present,
  forty samples each: **0.4322ms against 0.4327ms** at the fastest and 0.4507
  against 0.4556 at the median -- noise in both directions, as it has to be, since
  `Number.isInteger` is an intrinsic and the branch is taken on every call either
  way.

- **`copyFrom()` across sizes would have left the occupancy array the wrong
  length**, which is a silent `undefined` on every read out of bounds and a dropped
  write on the way in -- so every cell would have read as holding nothing. No frame
  reaches it, since `present()` and `snapshot()` are both same-size, so it is a
  claim about the method rather than about a path and is asserted as one.

#### What the sabotage pass caught, and the one survivor

Thirty-three mutations, one at a time with the canvas suite run after each.
**Thirty-two caught**, counted against the shipped code in one run rather than
summed across rounds, so the number is re-derivable: 33 applied, 32 caught by the
suite, 1 declared below.

Two smaller passes sit beside it and are counted separately on purpose, because
each asks a different question. **Five** mutations over the guards the first
review round's fixes added, all five caught, and they are written up under that
round. **Four** over the guards the second round's fixes added and the two bounds it
sharpened, all four caught. And **six** aimed at the composite from the other
direction -- can the _fuzzer_ fail at all? -- of which it catches three by itself
and the suite catches all six; the three it cannot see are about what a grid _holds_ rather than about
whether it is structurally sound, which is what the hand-written cases are for.
A grid can be perfectly self-consistent and still hold the wrong characters, and
a differential against the diff cannot see that, because the diff agrees with
whatever the grid says.

The harness reports a pattern that missed, a pattern that matched more than once,
or a replacement equal to its original as its own verdict rather than as a pass,
and it earned that: one mutation's pattern spelled an apostrophe as `\u2019`
where the source has a straight one, so it silently matched nothing and would
have read as "the guard is not load bearing". The same failure happened one level
up, in the _editor_ of the harness -- two `perl` substitutions against the
harness file matched nothing and were caught only by grepping for the result
afterwards, which is exactly the shape this file already records from the
windowing work: a `replace` with no assertion behind it quietly matches nothing
and leaves the old patterns in place. Assert the edit landed.

It fired a third time on the last run, which is the one that says the guard is
worth keeping rather than worth having had: the re-style mutation's pattern
quoted `this.#at(x - 1, y)`, and the first review round's fix changed that line to
`#onGrid()`. The harness reported `PATTERN MISSED` rather than a pass, so a guard
that had stopped being exercised said so instead of reading as one that is not
load bearing. A sabotage harness goes stale every time the code it mutates moves,
which on a branch with review rounds on it is every round.

The one deliberate survivor is the **continuation skip** in `composite()`, and it
is a declared statement rather than a claim: `put()` refuses a zero-width cluster
anyway, so deleting it costs a call per continuation and changes no answer. It
says so where it lives, which is the rule `index()`'s memo and `reachable()`
already follow.

**Two guards were deleted for failing a sabotage**, and both read as load bearing.
`#breakCluster()` set the occupancy on each cell it blanks, on the argument that
the repair leaves a blank _this grid painted_ -- true, and the cell was already
occupied: the only thing that writes a `CONTINUATION` is `put()`, which occupies
both halves of a cluster, so a cell that function reaches was occupied before it
got there. Neither assignment could change an answer. What the behaviour comes to
is asserted instead -- `should keep the orphaned half of a broken cluster
occupied` -- because it is the answer that matters rather than the line, and that
test passes either way, which is exactly the proof the line was dead.

**Four survivors were missing tests rather than dead code**, and each got the one
it was missing: the continuation of a wide cluster being occupied (the composite
never asks about it, so it is `occupiedAt()`'s public answer rather than something
the composite depends on); `copyFrom()` across sizes; `resize()` replacing the
array; and `blueNoiseMask()` reading its source at all -- that last one is the
shape worth noting, because a generator whose randomness was ignored passes
`should reproduce from a seed` trivially, and it took `should read its source, so
two seeds disagree` to make the parameter load bearing.

**And two "survivors" were the harness being blunt rather than the code being
unguarded**, which is the boundary this file already records from the decrypt
pass. A composite-ordering sabotage that _added_ a composite before the draw
while leaving the one after it is two composites to the same answer; _moving_ it
is caught by nine tests. And an iris sabotage that replaced `distance / longest`
with `distance / (longest - 1)` is a different _scaling_ rather than a ranking, so
it produced a nearly identical field and said nothing -- the real mutation sorts
the cells by distance and ranks them, and **that** one needed a test as well,
since nothing yet asserted how many cells an iris reveals part way. So the iris is
in both lists for two different reasons, which is worth saying rather than
double-counting: the sabotage was blunt, and the sharper one found a hole.

#### What the ticket got wrong, and what it left open

- **"`sweepStyles()` would be silently wrong" was right, and the threshold it
  named was right too.** 256 entries _and_ a doubling, which seven frames of forty
  truecolour cells reaches and nothing smaller does.
- **The composite is not where the cost is, and neither is the wire, quite.** The
  ticket's estimate -- O(cells) per frame, 1,920 at 80x24, against a frame already
  at 0.10ms -- holds. What it understates is the **generation**: blue noise at
  80x24 is 8.4ms, eighty-odd frames' worth, paid once on the frame a transition
  starts. That is the number worth knowing before reaching for it, and it is why
  the shuffle ships beside it.
- **The ticket said "masks are not a layers feature" and was right, and then its
  own checklist asked only for the two dissolve generators.** The wipe and the iris
  are what make the claim demonstrable, and they cost a handful of lines each.
- **It did not say how a caller builds a layer**, and there was no way to: a cell
  holds a style index and the canvas does not hand its table out. `painter(cells)`
  is the answer and it was found by writing a test rather than by reading the
  design.
- **It did not say what happens into a pipe**, and the answer is the best one
  available and arrives for free. See the entry above.
- **The composite walks the layer's own cells rather than the overlap**, so a
  layer much larger than the canvas pays for cells it cannot show. Clamping the
  loop bounds to the destination changes no answer -- a cell `put()` would refuse
  is one the clamp skips, a wide cluster whose lead lands one column off either
  edge included -- so it would be a guard nothing can observe, which this file
  deletes rather than keeps. A snapshot is canvas-sized by construction and a
  sprite is small; a ten-thousand-row layer over a twenty-four-row canvas is a
  layer to size differently.
- **Virtualizing the wire is not addressed and is not a gap.** "Scattered
  single-cell reveals are the worst case for run coalescing" is true and is the
  diff's own arithmetic rather than this feature's: each revealed cell is its own
  run plus a four-byte move, so mid-dissolve at 80x24 is a couple of hundred cells
  and about 1.5 kB a frame. Fine over ssh at 30fps, and not the free lunch "only
  the cells that changed" suggests. A blue-noise field does not change that number;
  it changes where the cells are.
- **What is deliberately out**: an alpha model, for the reason above; a
  `transition()` helper, because the ramp is a frame loop's; a per-layer
  `toString()`, which the ticket itself called a separate accessor and which
  nothing needs, since a caller holding a `Layer` already holds its `cells`; and a
  mask whose field is regenerated per frame, which is the shimmer the whole design
  is written against.
