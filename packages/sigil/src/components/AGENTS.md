# `packages/sigil/src/components` — deliberate decisions

These are the entries from [../../../../AGENTS.md](../../../../AGENTS.md) that are about this directory. Claude Code loads this file when it
works with files here; other agents should read it before changing
anything in this area. The root `AGENTS.md` holds the rules that apply
everywhere and still applies in full.

How each of these was arrived at — the review rounds and sabotage
passes — is under [docs/history/](../../../../docs/history), linked from
the entry it belongs to.

## Deliberate decisions — do not "fix" these

### A scroll box: the scrollbar, scroll-into-view, and culling

SIG-64 landed the engine half of scrolling and left the rest with a sentence
about why. This is the rest: `src/components/scroll-box.ts` is the component,
`src/element/scroll.ts` is the range and the walk that reveals a row, and the
culling is two lines in passes that already existed.

- **The gutter takes a cell, and it takes it whether or not anything can
  scroll.** That settles the ticket's first question, and the argument against
  overlaying is not a preference -- it is that the web's reason for an overlay
  does not exist in a terminal. An overlay scrollbar works there because it is
  translucent over pixels that are still underneath it; a cell holds **one**
  character, so a scrollbar drawn over content does not shade the text, it
  deletes it -- the last character of every row, which for a log of paths is the
  end of every path. What overlaying buys is that nothing reflows when the
  content grows past the window, and that is bought instead by reserving the
  gutter **unconditionally**: it is CSS's `scrollbar-gutter: stable`, it costs one
  column, and it is the one version of the trade that costs nothing in a cell
  grid. Content that fits fills the track rather than hiding it, which says "this
  scrolls and you are seeing all of it" and is one fewer thing moving on screen.
  `scrollbar: false` gives the column back for a list that draws its own
  indicator.
- **The thumb drags, and the press capture SIG-106 landed is the whole reason it
  can.** That settles the second question. While a button is held, the motion and
  the release go to whatever the press landed on wherever the pointer got to -- so
  a drag that wanders off the bar, or off the canvas, still reaches the thumb and
  still ends, which is the failure a scrollbar would otherwise have as its most
  visible bug. Clicking the track above or below the thumb pages towards the
  click. Every offset is computed **from the press** rather than accumulated from
  the last move, so a drag across a long track does not drift by a cell per frame
  of rounding, and a round trip lands exactly where it started.
- **It stops the release _and_ the click, which is the trap `05-drag.js`
  found.** Stopping an event stops it bubbling; it does not cancel a different
  one, and the derived click is a different one. A component that owns a drag and
  does not want the click has to say both, and this is the second component to
  need telling.
- **The bar's first question is what _kind_ of event it is, and that is a claim
  rather than a saving.** It reads like one -- an early return that skips reading
  the geometry for an event it has no answer for -- and with a drag in progress
  the branch below it takes any event carrying a position: a wheel turned over a
  held thumb would scroll to wherever the wheel was reported from, and stop the
  report besides. The first sabotage of it survived, which is how that was found;
  `should leave a wheel alone while the thumb is held, not read it as a move` is
  the test that makes it a claim.
- **The bar is two `raw` elements stacked over one rectangle, and the alternative
  is a thumb one frame late.** The thumb's size and position are questions about
  the laid-out content, and nothing knows how tall the content came out until
  layout has run -- so reading it back into a signal puts the thumb behind the
  content it describes by a frame, visible as a lag on every wheel notch, and
  costs a frame per scroll to do it. A `raw` element paints from the boxes of the
  frame it is in, which is what `raw` is for and the one shape where the thumb
  cannot be out of date. **Two** of them because each needs its own resolved
  style: the track and the thumb carry separate classes, so a theme colours them
  separately through the ordinary cascade, and one element cannot resolve two.
  Both are `position: absolute` with all four insets over a `relative` bar, so
  each fills it and neither takes any space; document order is paint order, so the
  thumb is drawn over the track.
- **`ScrollBox` holds no state, and that is the design rather than an
  omission.** The offset already lives on `viewport.scroll`, which the layout
  engine reads and `scrollTo()` writes -- marking layout and asking for a frame --
  so a signal beside it would be a second copy of one number for the two to
  disagree about. Every handler writes that offset directly. The consequence worth
  knowing is that it needs no renderer at all: a `renderToString()` of a scroll
  box scrolled to row forty prints row forty, which is also how most of its tests
  are written.
- **`Element.extent` is the rectangle three passes share, and it is what makes
  culling sound.** The union of a subtree's boxes, written by `arrange()` on the
  way back up. The obvious cheaper rule -- cull where the element's own box misses
  the clip -- is **wrong**, and wrong in the direction that deletes something from
  the screen: a child with `overflow: visible` is drawn outside its parent, so a
  parent whose box missed the clip would take a visible child with it. It is
  **bounded at a box that clips**, because nothing inside one is painted outside
  its border box however far its content reaches, and that bound is what stops a
  nested scroll region reporting its ten thousand rows to the box around it.

  It is **not** `arrangedExtent()`, and the two are still easy to confuse. That
  one is a separate walk in `renderToString()`, read by the auto-height canvas as
  well, which asks how big a grid has to be to hold what was laid out -- so it
  reads layout boxes rather than elements, it is taken per call rather than
  carried on the tree, and it skips the root's own box unless the root clips,
  because that box is otherwise the space the call was _offered_ rather than the
  space the answer takes. The sentence this replaces said it deliberately did not
  stop at a clipping box and that a box clipped to nothing still grew the grid
  there: a defect, reported by SIG-62, older than this ticket, and closed by
  SIG-130 instead -- where it belonged, because the two answer different
  questions. They take the **same bound at a box that clips** now, for the same
  structural reason and still to two different answers: that one stops there
  because nothing inside is painted outside, and this one because nothing inside
  can ask for more room than the box already asked for. Which is why merging them
  is still wrong: the root's box is the whole of what one needs and, for anything
  but a clipping root, the one thing the other must not read.

- **`Element.scrollable` is the same question with the scroll taken back out, and
  the version that did not was a real defect.** The content box unioned with the
  children's extents, shifted **back** by the offset the placement used. The first
  spelling read the children's extents and added the live offset on afterwards,
  which is correct only until something writes a new one -- and writing one before
  the next frame is exactly what a handler does. Two wheel notches decoded from
  one read of the stream each asked for the range, and the second was handed a
  list that had grown by however far the first had scrolled, so it scrolled past
  the end. Found by a test asserting that a second `scrollBy()` past the end
  reports nothing moved, which is the cheapest shape that could have caught it.
- **Paint culling is 34.82ms to 0.290ms at ten thousand rows, and the script that
  says so is committed.** `scripts/benchmark-paint-cull.mjs`, run by hand like
  `terminal-probe.mjs` and for the same reason read from the other side: a number
  in a pull request is a claim the next reader has to trust, and a script they can
  run is one they can check. 10,000 two-text rows -- 30,003 elements -- in an
  80x24 window, six interleaved rounds of twenty iterations, with the guard turned
  off by **clearing the extents** rather than by a second copy of `paint()`, so
  both sides are one binary; it asserts the two grids are identical before it
  times anything, and refuses to report a number over a cull that changed a cell.
  **34.404 / 34.824 / 35.045ms** before and **0.254 / 0.290 / 0.430ms** after, min
  / median / max, which is **120x** on the median. It is deliberately out of the
  suite: ten thousand rows is a second of arrange per pass against this package's
  ten-second `testTimeout`, with a fuzzer already running beside it, and this
  ticket had to cut a fourteen-second test for exactly that.

  Four runs agree, which is the part worth knowing, because the first three were
  by hand before the script existed and the figures above are the script's. Two
  quiet runs read 37.02 / 38.05 / 38.82 against 0.265 / 0.315 / 0.495 and agree to
  a tenth of a millisecond; one with the suite running beside it reads 40.05
  against 0.367, the same two orders of magnitude on larger absolutes. So the
  spread across runs is a few milliseconds on a thirty-five millisecond number and
  the ratio never moves, which is what interleaving is for -- and the check is
  still the one the style-shaking measurement records: ask whether the baseline
  agrees with the baseline, not whether the alternation was written.

  What it does **not** fix is the arrange, which is **72ms to 81ms** across those
  runs on the same tree and is now the whole frame -- the script prints it beside
  the paint figures for that reason, as context rather than as its subject. That
  is the virtualization argument stated as a number rather than as a worry, and it
  is why this ticket did the first tier only: an element that does not exist is not
  measured, not re-resolved and not painted, and nothing short of not building it
  addresses the 72ms. Which SIG-131 then did -- the 72ms is 0.59ms, under
  "Windowing a long list" below -- so read this paragraph as the measurement that
  filed that ticket rather than as a cost still outstanding.

  It is also worth knowing what shape the win has, because it is not
  `O(visible)`. The content box of a scrolled list still has ten thousand
  children and paint still visits each one to cull it, so the cost is
  `O(children of the scrolled container)` -- 0.119ms at 1,000 rows against
  0.290ms at 10,000, which the script's own row-count argument reproduces. Fast
  enough that it stops being the frame, and not a substitute for a windowed list:
  that one is `O(visible)` and reads 0.58ms at both sizes, which is the
  comparison the entry below is written around.

- **What pins the paint cull is a counter, and the picture beside it answers a
  different question.** `Painter.clip()` **always** invokes its callback and the
  cell grid then drops the writes that fall outside -- which is the rule that
  makes the cull safe, and is also why no comparison of painted cells can see the
  cull being deleted: the rows are drawn, refused, and the grid comes out
  identical. So `should not walk a subtree whose extent misses its clip` is the
  test that fails when the `return` goes, by counting the `raw` elements whose
  `paint` ran. The first version of this called the **picture** the differential
  the whole optimization rested on, and a review round pointed out it stays green
  with the cull deleted -- which is the entry below's failure one file along: a
  credit nothing in a build checks.

  The three sabotages are worth writing out, because what each test is for is not
  what it looks like. Deleting the `return` fails the **counter** and nothing else.
  Culling on `element.box` rather than on `element.extent`, which is the unsound
  rule, fails `should keep a child drawn outside a parent that misses the clip` --
  that tree is the only one where the two rectangles differ, which is the whole
  reason it exists. And an off-by-one in `overlaps()`, a predicate that culls too
  much, fails the **picture** differential and the counter together: that is the
  one that takes a row off the screen, and the picture is what says so in cells.
  So the differential is not redundant and is not the deletion's guard either, and
  both of those sentences had to be measured rather than reasoned.

- **The hit test culls on the same rectangle, and it took two tests because one
  of them could not see it.** The cull cannot change an answer, by construction:
  every box in a subtree is inside its extent, and a hit needs the point to be in
  some box. So it is a fast path, and the first version of this entry said that
  the test asserting it answers the same element as the uncut walk was what pinned
  it -- which was **wrong twice over**. That test never ran an uncut walk at all:
  it asserted the two rows the ordinary child walk returns anyway, so deleting the
  cull left it green. And even written properly a differential cannot fail over a
  fast path, because agreeing is the whole claim.

  So there are two. The **differential** sweeps every cell of the viewport with
  the extents and with them cleared and requires the same answer, which is what
  makes the fast path safe -- the guard is turned off by removing its input rather
  than by a second copy of `hitTest()`, so both sides are one function. The
  **count** is what fails when the cull goes: `hitTest()` asks the cull before it
  asks `paintOrder()`, and `paintOrder()` is what reads `children`, so an element
  whose `children` was read is exactly one the cull let through -- shadowed with a
  recording getter, one row of forty is entered with the extents and all forty
  without. What says it is worth having at all is the measurement: **0.343ms to
  0.079ms** on that tree, four times, per report.

  The first version of this entry said the clear-extents differential was "the
  method the paint cull already used", and a second review round found that
  **nothing on the paint side called `clearExtents()` at all** -- the helper was
  local to the hit-test block and the paint picture was asserted against literals.
  So the sentence credited a method to tests that did not use it, which is the
  same failure one level up from the one it was written to record: an attribution
  nothing in a build checks. `clearExtents()` is module-scope now, both blocks
  read the one helper, and the benchmark does the same thing for the same reason
  -- the paint cull and the hit cull are two readers of one trick rather than two
  spellings of it.

- **`scrollIntoView()` walks innermost outward carrying what the nearer ancestors
  moved.** That accumulation is the part that is easy to get wrong and easy to
  write a test that cannot see. Scrolling an inner box moves the target and leaves
  the inner box where it was, so the next ancestor out has to be asked about where
  the target has **got to** rather than about the box the last arrange gave it;
  scrolling an outer box moves the inner one and the target together, which is why
  the other order would need no accumulation and would also be wrong. What is
  added up is the **clamped** move rather than the asked-for one, or an ancestor
  that could not go as far as it was told hands the next one a lie.

  The first test for it **passed without the accumulation**, and the reason is
  worth recording: the outer box's range stopped at exactly the answer, so the
  unaccumulated reading was clamped to the same number. A trailing spacer inside
  the outer content is what made the two readings differ -- six against ten -- and
  the sabotage is what said the test was saying nothing.

- **An element taller than the view aligns its start.** Showing the top of a row
  that cannot fit is the useful half of it, which is CSS's `nearest`, and it falls
  out of taking the smaller of the two candidate moves rather than needing a
  branch. That `Math.min` also survived its first sabotage, because the test for
  it put the row **above** the view -- where the move is the unconditional one and
  the minimum is never reached. The test that catches it starts the row _inside_
  the view and ends it past the bottom, which is the only place the two candidates
  differ.
- **The focus ring calls it unconditionally.** The ring already skips a
  `display: none` subtree because there is nothing on screen there to move the
  focus to; a row below the fold is that case with the opposite answer -- it is on
  screen, somewhere the user cannot see -- so the fix is to scroll rather than to
  skip. There is no option to turn it off, because a focused element nobody can
  find reads as an app that stopped responding, and that is not a thing to make
  configurable. It is `focus()` rather than `next()` that calls it, so
  click-to-focus and a focus repaired after an unmount get it too.
- **A key is claimed only where the axis has somewhere to go, and then it is
  claimed even where the move is zero.** Those two together are what scroll
  chaining is here: an inner list whose content fits swallows nothing, so Down
  bubbles to the pane around it, while Home in a list already at its top is still
  that list's key -- letting it through would scroll the pane instead, which is
  the one answer nobody meant. Claiming unconditionally was the other option and
  it is the annoying one, since a one-row list that happens to be a scroll box
  would eat every Down in the app. Chaining past an inner box that is merely _at
  its end_ is deliberately not done: it needs "which end" and a definition of
  partial consumption, and an inner box that keeps its own keys is predictable.
- **A page is the viewport less a row.** One line of what you were reading
  survives the jump, which is what every pager does and the reason a page is not
  simply the viewport.
- **The wheel is three lines a notch with a curve over it, and the curve is why a
  long log is usable.** Three because one notch of a real wheel is one detent and
  a terminal reports one event per detent, so a notch has to be worth more than a
  keystroke. The curve multiplies by up to **four** for notches arriving inside
  **120ms** of each other -- a quarter of a second would accelerate a slow,
  deliberate scroll and fifty milliseconds would need a faster wheel than a hand
  produces. Crossing ten thousand rows at three lines a notch is 3,333 notches,
  which is the measurement that makes this a feature rather than a flourish.
  Reversing the **direction** resets the streak as well as the window lapsing,
  because otherwise reversing mid-flick launches the content the other way at full
  speed -- a scroll that overshoots the thing you were trying to get back to.
  Shift takes a vertical turn sideways where there is a horizontal axis, which is
  what every browser and every terminal's own reader do.
- **The thumb is at least one cell and touches an end only at that end.** The
  first is the case a long log is: one row visible in ten thousand rounds to
  nothing, and a scrollbar with nothing in it reads as broken. The second is the
  one a reader believes over their own memory -- a thumb drawn at the top while a
  row is still above it says the list is at its start when it is not -- so offset
  zero is the only thing that draws at the start, the maximum the only thing that
  draws at the end, and everything between is interpolated across the cells in the
  middle. That is the same rule the progress bar keeps for saying it finished.
- **The framework sheet gains two classes and no light half.**
  `.sigil-scroll-track` is `gray` and `.sigil-scroll-thumb` is `cyan`, which are
  palette indices -- so they are whatever the user's own theme renders, and index 8
  is the one a light theme has to render text in. That is the rule the rest of that
  sheet already follows working rather than a gap, and it is why only `dim` ever
  needed a conditional. The geometry stays in props where the component that worked
  it out can see it, which is the rule the sheet keeps for every other built-in.
- **The host's class is added rather than written.** `class` on a props object
  replaces rather than merges, so writing it into the constructor props would let
  a caller passing `class="log"` silently take the component's own class away --
  and with it everything a theme can reach. `flex-direction` goes **after** the
  caller's props for the opposite reason: the bars are placed against it, so a
  caller setting it would be rearranging a layout it cannot see the rest of.
  `focusable` goes before, so a caller may opt out.
- **The host is focusable, so a box holding nothing focusable can still be
  scrolled.** A descendant that takes the focus reaches these keys anyway, since a
  key walks from the focused element up through its ancestors -- so this is for the
  log of plain text, and it is what `08-scroll.js` focuses on startup. Found by
  driving the demo: with nothing focused, the first arrow key goes to the bindings
  and nowhere else, which is the "reported as doing nothing and was working
  perfectly" failure the probe's own entries record, arriving in a demo.
- **`clipsContent()` and `overlaps()` live in `scroll.ts`, which imports nothing
  but types.** The reason is `hit.ts`'s: the focus ring needs `scrollIntoView()`,
  and reaching it through the element barrel would put the layout engine, the
  cascade and the canvas behind `@ttylabs/sigil/input` -- measured at **34.1 kB**
  of static import graph with this module in it, against the 33.0 kB that entry
  already carried and the 100 kB ceiling `should not drag the drawing stack in to
  import the key router` holds. `flex.ts` keeps its own `clips()` and that is the
  boundary rather than drift: the layout engine takes a `LayoutNode` and may not
  import the element tree, which is the whole reason it is testable with a literal.
  `ScrollBox` itself is **3.4 kB** of the components bundle, measured by taking it
  back out of the barrel and rebuilding.
- **A fourteen-second test is a flaky test one busy machine later, and this one
  was both.** `should cap the acceleration` built a **ten-thousand-row** box and
  turned the wheel forty times, and each turn re-lays the tree -- measured at
  **350ms** a `lay()`, 60ms of cascade and 166ms of arrange, so fourteen seconds
  against this package's own ten-second `testTimeout`. It passed and then stopped
  passing with nothing in `src/` having moved, which is the only shape that
  matters here: a test close enough to its timeout to be decided by what else the
  machine is doing says nothing either way.

  What the assertion needs is a range comfortably past its own ceiling -- forty
  notches times twelve lines is 480 -- so **six hundred** rows reads identically
  at a twentieth of the cost, and the file went from 18s to under 1s. Uncapped the
  multiplier reaches twenty, which runs past the range and clamps at 596, so the
  discrimination survived the resize and the sabotage still catches it.

  The slowdown was first blamed on the `flex-shrink: 0` deletion below, which is
  the kind of guess worth measuring before writing down: patched back in and
  rebuilt, the same `lay()` is **351ms against 349ms**. So the deletion really is
  inert, on the one workload where it looked least likely to be, and the test was
  always the cost.

- **Four guards were deleted for failing a sabotage, and each read as load
  bearing.** A `display: none` check in the extent union: the engine gives such a
  child a zero box at the content origin and lays nothing inside it out at all, so
  the union cannot move -- and the property is pinned by a test now, since it is
  what makes the absence correct. And **two** `flex-shrink: 0` declarations, which
  is the more interesting pair. The one on the content wrapper reads as the
  declaration that makes the content overflow, and it changes nothing, because
  what bounds the scroll is the **extent** of what is inside the wrapper rather
  than the wrapper's own box: a squeezed wrapper is one its children overflow, and
  they are drawn, scrolled and counted exactly as before. Verified the hard way as
  well as by the suite -- the demo's output is byte for byte identical with and
  without. The one on the bar was inert for a simpler reason: the viewport beside
  it has a basis of zero and takes only the remainder, so nothing squeezes that
  cell. And the `margin` prop, which is the entry above rather than a guard.

  `union()`'s early return is the one survivor that stays, and it is declared: it
  returns the outer rectangle unchanged where it already holds the inner, which
  allocates nothing for the overwhelmingly common contained child and changes no
  answer. One other survived and grew a test instead -- `scrollable` is written
  only for a box that **clips**, which nothing can currently observe, since
  `scrollRange()` is only ever asked of one. That is a contract the field's own
  doc states, so the answer is to assert it rather than to delete the condition or
  to leave the doc on a reader's goodwill: `should give a box that does not clip no
  region at all` is the pin, and the condition fails it.

- **There is no `margin` prop, and one shipped for a review round.** It was
  clamped, put on the `Axes` the keys and the wheel are gated on, and read by
  neither -- so `ScrollBox({ margin: 5 })` moved by exactly the same amounts as
  one without it, while the prop's own doc claimed the keyboard and the wheel read
  it so that the row at the edge is not the last thing visible. A property that
  parses and does nothing, which this file calls worse than one that does not
  exist, with a doc comment asserting the behaviour on top.

  Deleting it rather than wiring it is the answer because there is nothing to
  wire: a margin means something to `scrollIntoView()`, which is revealing a
  particular box and can leave room past it, and nothing at all to a **relative**
  move -- a key scrolls by a line or a page and a notch by its own three lines,
  and there is no edge for a margin to be measured against. The option is still
  the caller's through `scrollIntoView(row, { margin: 1 })`. What the focus ring
  passes is nothing, and giving a scroll box a margin the **ring** honours means
  the ring reading one off the element, which is a `scroll-margin` property rather
  than a component prop and a decision for whoever needs it.

- **What is deliberately left out.** **Scroll
  chaining** past an inner box at its end, for the reason three entries up --
  and the prose saying otherwise is a finding of its own: the demo and
  `demos/README.md` both said a list _at its end_ hands the key on, which is the
  guard misread as `by === 0` rather than as `range <= 0`, and a reader who
  "fixed" the code to match would have made Home at the top scroll the outer
  pane. The wheel's own comment said it too. Corrected in all three, and the
  reason it is worth an entry is that a comment which would mislead somebody into
  a real bug is worse than one that is merely absent.
  **Arrows and steppers** on the bar, which are two more cells of a one-cell-wide
  gutter and a mouse-only affordance in a keyboard-first medium. And a
  `scrollbar-gutter` **property**, which would be a fourth thing in the style
  table to say what `scrollbar: false` already says to the one component that
  could honour it. **Virtualization** was the fourth entry here and is the
  section below: the 72ms it named is 0.59ms now.

#### Windowing a long list: two spacers, and one hook on the element

SIG-110 left the arrange as the whole frame and said why: "an element that does
not exist is not measured, not re-resolved and not painted, and nothing short of
not building it addresses the 72ms." This is not building it.
`rows` on `ScrollBox` is the component, `rowWindow()` is the arithmetic,
`Element.onScroll` is the one thing the framework had to grow, and
`packages/sigil/scripts/benchmark-virtual-list.mjs` is what measures it.

- **The whole mechanism is two boxes with a declared height, and the four
  contracts a windowed list was supposed to break turn out to be kept for
  free.** That is the finding, and it is what made this a small change rather
  than a large one. The rows the viewport can see are built; a spacer above and
  a spacer below stand in for the rest. Nothing in the layout engine, the
  cascade, the paint walk, `Element.scrollable` or `scrollRange()` knows a
  window is in play -- a spacer is an ordinary box, so the content box's extent
  spans the whole list and the range, the clamp and the **thumb** are the
  answers they would be over every row. Measured rather than argued, and before
  anything else was written: ten thousand two-text rows at 80x24, at seven
  offsets including both ends and one past the end, paint a **byte for byte
  identical** frame and report an identical range. `selectableAt()` agrees cell
  for cell at every offset too, because a spacer draws nothing and only `text`
  and `raw` write to the mask -- which is the rule that walk already followed.

- **A row is kept by its index unless the caller keys it, and is built under an
  owner of its own (SIG-280).** `ScrollRows.key(index)` keeps a built row by what
  it is rather than where it is, so a re-sorted list moves rows instead of showing
  stale ones, and each row's owner is disposed when it leaves the window. Both are
  recorded under "A list view", which is what needed them.

- **`flex-shrink: 0` on the spacers is the single declaration the feature rests
  on, and without it the range is 1.** A box with no children has no
  content-based automatic minimum -- which the layout engine records as a
  decision, for the reason that reporting its declared height froze it at that
  height and pushed it out of a container too short to hold it -- so a spacer
  defaults to `flex-shrink: 1` and is squeezed to **nothing**. Measured in both
  directions on the first probe: with it, a 10,000-row list reports a range of
  9,976 and paints the rows; without it, a range of **1** and an empty viewport.
  It is also the opposite call from the two `flex-shrink: 0` declarations SIG-110
  deleted for being inert, and the difference is exactly the entry above: what
  bounds a scroll is the **extent** of what is inside the content wrapper, so
  squeezing the wrapper changes nothing and squeezing the thing whose height
  _is_ the arithmetic changes everything.

- **Every row gets a slot of exactly the declared height, so "fixed height" is
  true of the tree rather than of the intention.** The ticket asked for the
  decision to be explicit and it is: the first tier is **fixed height only**,
  declared and not estimated. The range is `count * height - viewport`, so a
  height that disagrees with how the rows lay out is a scrollbar that moves
  while you read and a clamp that stops short of the end -- and an estimate
  cannot be corrected without measuring rows nobody built, which is the cost
  being avoided. So the component holds each row to the height it was told
  rather than guessing and apologising: a slot that cannot shrink, which is one
  extra element per visible row and about 25 of them. A row that draws past its
  slot overflows it, which is what the engine does with any overflow and is
  visible rather than silently out by one.

- **Two hooks and one handler, because a window is four numbers and two of them
  move.** `rowWindow()` reads the count, the row height, the offset and the
  viewport's height; the offset is `scrollTo()`'s to write and the viewport's
  height is `arrange()`'s, so each has exactly one place that can say it moved.
  `sync()` recomputes from all four whenever either hook calls it, so the second
  hook added no arithmetic at all -- SIG-132 was somebody calling it, not
  something new for it to work out.

- **`Element.onScroll` is the offset's, because `scrollTo()` is the one
  writer.** A windowed list has to learn that the offset moved, and the obvious
  place to do it is the handlers the component already owns -- the keys, the
  wheel, the dragged thumb. That leaves `scrollIntoView()` out, and the focus
  ring calls that one **unconditionally**, so a row revealed by it would scroll
  under a window built for where the list used to be. `scrollTo()` is the only
  assignment to `scroll` in the library, verified by grep rather than assumed,
  so one hook there answers for all four writers where four `sync()` calls would
  be four places that each have to remember. One function rather than a list,
  for the reason `onKey` is one, and it fires **synchronously** -- the tree the
  frame arranges is the tree the handler left, so there is never a frame drawn
  for a window the offset has already left.

- **`Element.onResize` is the height's, and it is dispatched by whoever ran the
  layout rather than by `arrange()`.** That is structural rather than a
  preference, and it is the whole of why the second half of this feature is a
  change to the **frame**: a handler that _builds_ elements leaves them below the
  cascade, and props are not in a style until something resolves them -- measured,
  a slot built there has `height: auto` and `flex-shrink: 1`, which is both halves
  of what the windowing rests on. `arrange()` cannot fix that by restyling either,
  because it has no `Cascade` to restyle against: `resolveStyles()` matches no
  sheet, so every row would lose its theme. So `arrange()` **collects** and a frame
  dispatches, restyles what the handlers built, and lays out again.

- **What it collects is every element that has not been _told_ the size it now
  has, which is not the same question as "did its size move".** The first version
  asked the second, by reading `content ?? box` before the walk overwrote it -- free,
  since the box the last layout left _is_ the before. The two part on exactly the
  paths where a dispatch did not happen, and one of those is reachable: a row
  builder that **throws** while a resize is rebuilding a window. Measured -- the
  viewport's box is already at its new size when the handler throws, so no later
  layout at that height collected it and the stale window survived every resize back
  to it. Which is SIG-131's own defect one hook along, where "no later scroll to that
  same window could repair it", so it gets the same answer: the size is recorded
  **after** the handler returned, in a `WeakMap` keyed by element rather than a field
  every element would pay a slot for. The other path it closes is the loop giving up
  on its bound, whose last collection is never dispatched; with this, the next frame
  **that lays out** asks again -- which is not the same as the next frame, and is the
  honest version of a sentence that claimed it was: nothing marks layout or asks for a
  frame because the bound was hit, so a tree that needed a fifth pass waits for a
  scroll, a resize or an animated geometry property, with a blank innermost viewport
  rather than an oscillating one. It takes five nested windowed lists to reach, and
  found by review rather than by a test, which is where an overclaiming sentence gets
  found. A `Set` rather than a list for the same reason one step along: a frame that
  lays out twice collects twice, and one element is told once.

- **What it costs a frame with no windowed list in it is nothing measurable.** Six
  interleaved renders of a sixty-entry help screen, forty iterations each: **2.390 /
  2.454 / 2.409ms** before and **2.432 / 2.362 / 2.436ms** after, which is noise in
  both directions. It has to be: the collector is empty, so there is nothing to
  dispatch and the loop's first pass exits. What a `table()` and a help screen print
  is byte for byte what they printed, checked rather than argued.

  `settleResized()` is the one implementation of that loop and both frames call
  it: `renderToString()` and the renderer's own `settle()`. A **bare** `arrange()`
  dispatches nothing, which is why the component's own tests still describe the
  window a single layout produces, and is the cost recorded two entries down.

  The handler **returns whether it changed the tree**, which is the rule
  `hideCursor()` and `setRawMode()` already keep: a caller that owes a second pass
  has one question to ask and only the handler can answer it. `sync()`'s own
  unchanged-window guard is what makes that a `false` on the overwhelming majority
  of frames, so a layout that moved a viewport's width and not its window is one
  `rowWindow()` call and no second layout. Pinned rather than declared -- a width-
  only resize beside a box whose own size never settles is what counts the layouts
  -- which is the one place this differs from SIG-131's treatment of the same
  guard, where there was nothing a count could see.

  The loop is bounded at **four** passes, and the bound is a cycle breaker rather
  than a budget: it exits the moment nothing reports a change, which for the
  ordinary case is after exactly one, because the two spacers hold the content's
  total height at `count * height` whichever rows are built -- so the layout after
  a rebuild gives the viewport the same height again. The headroom is for a
  windowed list **inside** one, which settles a level per pass because the inner
  viewport does not exist until the outer window has been built. A configuration
  that genuinely does not converge is drawn at the last window it reached, which
  is the status quo rather than a new failure.

- **The animator is shown the second settle as well, which is two halves of one
  thing and both were missing.** `animate()` is the function, called once per settle,
  and it observes and then presents. Without the **observe**, a row that first exists
  because a handler built it is never shown to the animator at all: it is in the
  second settle's `Update.paint` and in no other, and the next frame has no mark for
  it, since it now has a cached style and nothing touched it. So `animation: pulse 1s
  infinite` on a row a **resize** revealed never started, while the same row revealed
  by a wheel notch did -- `scrollTo()` runs the handler before the frame, so that one
  is in the first settle's set. Found by review, and the asymmetry is what makes it a
  defect rather than a limitation: two rows of one list behaving differently according
  to which hook built them.

  Asking `tick()` again at an unchanged `now` is what makes that safe: the overrides
  come out equal, so nothing is reported as moved and the presented objects keep their
  identity -- which is the property the measurement cache depends on, read from the
  other side.

  **Which elements the second `observe()` reaches is narrower than the first write-up
  of this said**, and getting it right is the difference between a safety argument and
  a guess. An element is in a settle's `paint` only where `difference()` found its
  style genuinely changed, so an element whose style did not move is not observed
  again at all: the second set is the rows the handler **built**, which have no base
  and so start nothing, plus the elements whose style the handler's own writes
  changed, where a transition starting is correct rather than spurious. The first
  version claimed the guard was `difference()` of one `Style` object against itself
  being empty -- and the cascade hands back a **new** object whenever it re-resolves,
  so identity was never the guard, and that sentence would have survived somebody
  making `difference()` identity-based. Found by review, which is also what made this
  a shorter list than it looked.

  What a re-windowing frame therefore must not do is move an animation nothing
  changed, and `should not move a running animation on a frame that re-windowed` is
  the pin: `tick()` at an unchanged `now` answers the same overrides and `present()`
  puts them back over the base the second settle wrote. `#syncAnimation()` taking a
  live animation of the same name up **in place** rather than committing afresh is
  what keeps its `start` across every frame it is observed on, which is pre-existing
  and is why none of this needed a new rule.

- **And the presented styles go back on after it, which is the other half of the same
  function.** `settleStyles()` sets `element.style` to the
  **base** style for every element the restyler has a cached one for -- animating
  ones included, which is why the first pass writes the animator's presented styles
  _after_ it. A second settle undoes that, so a frame that re-windowed drew every
  animation at its base value and, worse, **laid it out** there: an animated
  geometry property is in `LAYOUT_PROPERTIES`, so a width easing from four to twelve
  is placed at four for that frame. The same two lines in the same order, through the
  same function, which is what makes it one rule rather than two. Pinned on the
  element's **box** as well as on its style, because the box is what says the layout
  used it -- a picture cannot, since a box with a background and no characters draws
  blanks either way. Found by reading the frame rather than by a test, and the test
  came after.

- **`Animator.forget()` forgets the subtree now, which its own doc had always
  claimed.** It exists "for the reason `Restyler.forget()` is: both maps are keyed by
  element identity, so a subtree that was shown and hidden would stay reachable for
  the life of the animator" -- and it deleted the one element it was handed, where the
  restyler recurses. What a frame records as removed is the element whose parent
  dropped it and never its children, so nothing else was going to. A windowed list is
  what makes that unbounded rather than untidy: a notch unmounts a slot holding a row,
  so a ten-thousand-row log scrolled through once left an entry per element ever
  built. `#entries` only ever held something actually animating, so no frame timer
  stayed awake for it, which is why nothing but the memory said so. Pre-existing since
  SIG-62 and fixed here because this is the feature that makes it matter, found by
  review, and it is the shape this file keeps warning about: a comment asserting a
  behaviour the code does not have, which a documented codebase is _more_ prone to
  because the written rule is what stops the reader checking. The children are read
  through a cast rather than through `T`'s constraint, because a constraint of only
  optional properties is a **weak type** TypeScript refuses to match against the
  `{ name: string }` the animator's own tests animate.

- **The marks are drained twice in a frame, and the second time is not
  tidiness.** A new window writes the two spacers' heights with `setProp()`, and a
  kept restyler is marks-driven -- so a frame that re-settled styles without
  draining again left those two carrying the style they already had, and the
  content box's extent then described the window that had gone. Measured as
  exactly that: a range of **500** over a viewport of 8 where it should have been
  492, with the rows painted correctly on top of it, which is the shape that would
  have shipped as "the scrollbar is slightly wrong". `renderToString()` has no
  `Tree` for a `setProp()` to record on at all, so it pays a **full** re-match
  instead and says so. Draining is also what forgets the rows the new window
  displaced in this frame rather than the next.

- **A `scrollTo()` from inside an element's own handler writes and marks without
  dispatching again.** That bounds the recursion by construction rather than by
  a depth count, and what it refuses -- a handler that scrolls the box it was
  called about -- is a loop being described rather than a case anybody has. The
  latch is **per element**, so a handler that scrolls a _different_ viewport
  still reaches that one's handler, which is what a nested list needs. It is put
  back in a `finally`, because a viewport left deaf for the life of the process
  is a worse thing to survive a throw than the throw is. A throw propagates, as
  `onKey`'s does: a scroll handler is the component's own code.

- **`scrollIntoView()` collects its ancestor chain before anything scrolls, and
  that was a real defect rather than tidiness.** The walk was
  `for (let at = target.parent; at; at = at.parent)`, which reads `.parent`
  after each `scrollTo()` -- and `scrollTo()` now dispatches a handler, and
  rebuilding a window is exactly what one is for. Measured over three nested
  clipping boxes with the innermost's handler detaching the one above it: the
  outermost was **never scrolled at all** and `scrollIntoView()` still answered
  `true`. A list taken up front cannot be shortened by what the scrolling does,
  and a detached ancestor is then merely one more box the target is no longer
  inside. The target's own box is read once at the top already, which is why the
  accumulated shift arithmetic survives the target itself being dropped.

- **Rows that stay in the window are kept, not rebuilt, and the reason is the
  focus.** An element that leaves the tree hands the focus on by position, so a
  list rebuilt wholesale would move the focus on every wheel notch. Keeping them
  also keeps each row's resolved style and its text measurement, which are keyed
  on the style **object** and so are worth nothing to a fresh element. The
  reconcile moves only what is out of place, so a scroll of one row is one
  insert rather than a reshuffle of the window -- and a move is a removal and an
  insertion, which is the thing that would have taken the focus off a row that
  stayed.

- **The first window is bounded by the height the host _declared_, and that is a
  floor under it, and calling it a _bound_ was a claim a review round
  falsified.** Nothing has arranged the tree when the component is built, so
  there is no viewport height to read, and the host's own declared height is the
  only number there is. The first version of this entry argued it was an upper
  bound -- the viewport sits inside the host -- and that is only true while the
  host really is the height it declared. A host that can **grow** is the
  counterexample and it is ordinary: `height: 10` with `flex-grow: 1` in a
  forty-row parent is a viewport of forty, where the declared ten left **thirty
  rows blank**. Measured. So the window is built for the **larger** of the two,
  which makes the declaration a floor rather than a ceiling and makes the
  arranged height the thing that wins wherever they disagree.

  `Math.max` rather than `??` for a second measured reason: a height of **0** is
  a measurement and not "not arranged yet". A bordered host of height 2 has a
  content box of zero, and reading that as unknown built all five hundred rows --
  which is the cost the feature exists to avoid, hidden behind the clip, with no
  blank viewport to notice. Over-building by the difference is the safe direction
  and is two rows for a border.

  Where the host declares no height in cells the answer is **no rows**, and that
  is SIG-132 moving a premise rather than reversing a decision. SIG-131 answered
  the whole list there, on the ground that "over-building is a slow frame and
  under-building is a row that is not on screen, so the unknown case resolves
  towards the one that is merely expensive" -- which was sound while nothing
  recomputed a window after a layout, because a window built before one was the
  only window there would ever be. With `onResize`, a frame lays out, tells the
  viewport its height, rebuilds and lays out again **before it paints**, so
  under-building is a row one layout early while over-building is still ten
  thousand rows cascaded and arranged for a frame that shows twenty-four. So the
  hedge is gone and `rowWindow(count, step, offset, 0)` is the arithmetic said
  plainly: a viewport with no cells in it can see nothing.

  A number or a string of digits, and anything else -- a percentage, `auto` -- is
  no floor; matched rather than read through `Number()`, because `Number('50%')`
  is `NaN`, `NaN <= 0` is false, and it would walk straight past `rowWindow()`'s
  unknown-viewport branch and make the window's own length `NaN`. That is **still**
  the failure the matching exists for and it is now the sharper of the two, which
  the old wording had backwards: an empty window is one layout away from being
  filled in, and a `NaN` one is not -- `Math.max(anything, NaN)` is `NaN`, so no
  layout can repair it, and the unchanged-window guard compares `NaN === NaN` as
  false, so every sync rebuilds the same nothing for ever.

- **What it costs is the first layout of the one path that lays out without a
  frame.** A bare `arrange()` and `paint()` of a list that declared no height in
  cells draws an **empty viewport**, because nothing dispatched `onResize`. The
  _first_ one only, which is narrower than it sounds and was checked rather than
  assumed: the spacers mean the range is right while the window is empty -- measured,
  494 over a 500-row list in a six-row viewport -- so the first Down, the first wheel
  notch or any `scrollTo()` at all goes through `onScroll` and fills it. What is left
  is a list nobody has scrolled yet, painted by something that is not a frame. The
  two frames there are both re-window, `renderToString()` is the no-renderer path
  this component is documented for, and a declared height makes even a bare layout
  right -- which is what the demo, the benchmark and every test here do. It also
  cost the benchmark its old shape, since "the optimization turned off by removing
  its input" is no longer reachable: the first-frame section is measured against the
  same rows assembled by hand instead, for the reason under "What is left" below --
  a declared floor cannot reproduce the whole list at a non-zero offset, because
  `rowWindow()` takes `first` from the offset.

- **Which closed the edge the demo found, and the idiomatic spelling no longer
  walks into it.** A height written in a **stylesheet** -- `.log { height: 20 }`,
  which is how everything else in that demo is styled -- is no declared floor, so
  frame one used to build all 20,009 elements and the first scroll was what
  windowed it down to 45: correct, and 200ms of startup for nothing. The frame
  rebuilds before it paints now, so the first frame is `O(visible)` whether the
  height was written in props or in a sheet. `09-virtual.js` still puts it in props
  and the comment there still says why, because the floor is what makes the _first
  layout_ narrow too rather than the layout after it -- one pass against two, and
  the only thing left that a sheet cannot give.

- **Nothing commits until every row in the window has been built, which is
  `Show`'s own order.** `rows.row()` is the caller's code and may throw, and the
  offset is already the new one by the time the window is computed -- so a version
  that wrote `at` and the spacer heights first left `at` claiming a window the
  content box did not hold, with the spacers measuring it, and **no later scroll
  to that same window could repair it**, because the unchanged-window guard sees
  nothing to do. Recovery took a scroll somewhere else and back. `Show` records
  the fix as a rule already: build first and touch nothing on screen until there
  is something to put there, which is also the only order where a failure needs
  no undo. A `made` list to keep a failed pass's slots out of `built` as well was
  written here and deleted for failing its sabotage: a slot cached for a window
  that was never committed is pruned by the next sync's own prune loop, so it
  changes no answer. Found by review.

  **And the offset is the rest of that commit, which a second round found the
  first one had missed.** `scrollTo()` writes the offset and _then_ dispatches, so
  a failed window left the viewport scrolled to somewhere its content box was not
  built for -- the spacer over the whole visible area, blank -- and `scrollTo()` of
  those same coordinates is a no-op, so nothing short of scrolling **elsewhere**
  could repair it. So a throw puts the offset back, which is `For`'s own answer
  rather than a new one: that component rolls back every branch it made and every
  index it had already moved rather than leaving half a commit. Writing it back
  from inside the handler is exactly what the latch makes safe -- a `scrollTo()`
  reached from inside this element's own handler writes and marks without
  dispatching again -- so the latch is a _use_ here and not only a guard.

  It rolls back to the offset the last **settled** window was for, which is kept
  rather than read: inside the handler `viewport.scroll` is already the new one.
  Both exits record it, the commit and the unchanged-window fast path, and a test
  that reached only one of them left the other's assignment surviving its
  sabotage -- which took a row **taller than a cell**, so that a scroll inside one
  row goes through the fast path at all. The first version of the test for the
  whole thing could not see the hole either: it retried the offset by going
  somewhere else and back, which is the one sequence that never reaches
  `scrollTo()`'s equality check.

- **A slot is a **column**, so the row's width is the stretched axis -- and the
  differential could not see that until it compared colour.** "Stretched is what
  rows want, so that a highlight fills the width" is the content box's own
  recorded rule, and a slot in between has to pass it on: with the slot left at
  the default direction, the row's main axis is its width, so a `:focus`
  background stopped at the end of the text. Measured, 2 highlighted cells
  against 11. The reason it went unnoticed for three commits is the finding: the
  differential compared `strip()`ped pictures, so two sides whose slots were 4
  cells wide and 11 cells wide **agreed perfectly** -- a width that differs is
  invisible until something paints a background. It compares the coloured lines
  now, over rows that have one, and the hand-built baseline carries
  `flex-grow: 1` and the same slot direction so that it is the **same tree**
  rather than a similar one. Dropping the direction fails that test; with the
  stripped comparison it failed nothing. Found by self-review rather than by the
  sabotage pass, which is its own boundary again: a pass built out of deletions
  asks whether the code that is there is load bearing, never whether a test can
  see it.

- **`count` is read on every window and the other three are read once, which is
  the line a command's own declaration already draws.** `choices` and `default`
  are read on every parse while `name` and `format` built the registry lookups;
  here `height`, `width` and `row` built the slots and `count` is what the range
  is computed from -- and it is the one of the four that plausibly moves, since a
  log grows. So it is re-read each time the window is, and it is part of what the
  unchanged-window guard compares: a count that grew while the offset stayed
  inside one row is exactly the case that guard would otherwise skip, leaving the
  spacer below at its old height. That case needs a row **taller than a cell** to
  reach at all, because at one cell every offset is a different window and the
  guard never answers -- which is why the first test for it was vacuous and
  survived its sabotage. A list that has to grow while nobody is scrolling was
  left for a later tier here, because it needed a way to ask for a re-sync -- a
  second mechanism beside `onScroll`, with no caller yet. SIG-209 is that tier:
  `scrollControl(host).resync()`, under "A scroll box heard from outside" below.

- **A vertically windowed list's _horizontal_ extent is the widest row that was
  built, and `rows.width` is what closes it.** Found by probing `axis: 'both'`
  and worth the entry because the failure is visible rather than theoretical:
  the cross extent is the union of what exists, so `scrollRange().x` describes
  the window. Measured -- scroll a `both`-axis list right by 20, scroll down
  into shorter rows, and the range collapses to **zero**, so the next horizontal
  scroll clamps the offset back and the view jumps left. Declaring `width` pins
  the cross extent the way `height` pins the vertical one, and with it the same
  sequence keeps its range and the offset goes to 21 rather than to 0. It is
  **optional** because the default `vertical` axis reads that range for nothing,
  and both halves are pinned: the limitation as well as the fix, so that whoever
  meets it finds it written down rather than reported.

- **The content box's `flex-direction: column` is written only where `rows` is
  in play, and writing it unconditionally is visible.** With `rows` the
  component owns the stacking, because the spacers are placed against it --
  left at the default, the slots laid out **side by side** in one row with a
  horizontal overflow, which is how it was found. With `children` the caller's
  own box says which way its content goes, and the content box's direction then
  decides which axis its one child is _stretched_ on: a bordered `children` box
  went from content-width to the whole viewport's width. Probed over eight
  shapes, four axis-and-size combinations and two offsets before a test was
  written, because "the direction cannot matter for one child" is the kind of
  negative claim this file records as unestablishable by tracing the route you
  had in mind.

- **What it is worth, interleaved, on a machine with two other agents on it.**
  Ten thousand two-text rows, 80x24, six rounds alternating per round, load
  average 1.4 to 2.3. The baseline agrees with the baseline:
  `benchmark-paint-cull.mjs` reads 34.66ms / 0.289ms for the paint and 65.8ms for
  the arrange on the same tree, against the 34.82ms / 0.290ms and 72-81ms this
  file already records.

  |                     | whole   | windowed |      |
  | ------------------- | ------- | -------- | ---- |
  | elements            | 40,010  | 105      |      |
  | first frame, total  | 190.6ms | 0.593ms  | 321x |
  | -- of which cascade | 106.5ms | 0.255ms  | 417x |
  | -- of which arrange | 71.6ms  | 0.127ms  | 565x |
  | -- of which build   | 11.1ms  | 0.061ms  | 182x |
  | -- of which paint   | 1.4ms   | 0.151ms  | 9x   |
  | a wheel notch       | 81.4ms  | 0.614ms  | 133x |

  Three runs, medians, agreeing to a few per cent: the total reads 184.6, 190.6
  and 193.6 against 0.596, 0.593 and 0.611, and the notch 79.3, 81.4 and 81.1
  against 0.617, 0.614 and 0.631. So the ratio never moves, which is the check
  this file insists on -- asking whether the baseline agrees with the baseline
  rather than whether the alternation was written. The absolutes are worth
  stating beside the deltas because of the load, not instead of them.

  The notch is read **conservatively**, which matters because the two sides do
  not pay the same things: a scroll marks layout and not style, so the list an
  app writes today re-resolves nothing and its frame is the arrange and the
  paint, while a window is a tree that changed and really does re-resolve -- and
  it is charged the whole `resolveStyles()` of its eighty elements rather than
  the marked subtrees a `Restyler` narrows it to. So the window is charged more
  than it costs and the baseline less, and 133x is a floor.

  The number that carries the argument is not any of those, though. It is that
  the windowed cost is **flat**: at 1,000 rows it is 0.593ms and 0.533ms, and at
  10,000 rows 0.593ms and 0.614ms, while the list beside it goes from 17.8ms and
  5.7ms to 190.6ms and 81.4ms. That is `O(visible)` measured rather than
  claimed -- and it is the thing paint culling could not deliver, since that is
  `O(children of the scrolled container)` and went from 0.119ms at 1,000 rows to
  0.290ms at 10,000.

- **The benchmark's two sides are one binary with the window's input taken
  away.** `rowWindow()` reads the viewport's height, and before the first
  arrange the only height there is is the one the host declared -- so the
  "whole" side is the same `ScrollBox({ rows })`, the same window code and the
  same row builder, with the declaration removed and the host bounded by a flex
  parent instead. A third side is the status quo, `children` holding every row,
  which is what the notch is measured against. All three are required to paint
  the **same** frame at six offsets before anything is timed, which is what
  keeps the hand-assembled side honest: a window that drew something else would
  be faster and wrong.

- **Thirty-six sabotages, thirty-five caught, and one survivor that is a
  declared fast path.** The survivor is the unchanged-window early return in the
  sync: the window's inputs are a handful of numbers, so when none of them moved the work
  below is a `setProp()` to the value it already holds and a reconcile that
  finds everything in place -- no mark, no answer changed, and nothing can be
  written that fails when it goes. It says so where it lives, which is the rule
  `index()`'s memo and `reachable()` already follow. What it buys is every
  scroll _inside_ one row, which for a row taller than a cell is most of them.

  **SIG-132 added twenty-six and caught all twenty-six, and eleven of them took a
  test written for them.** Six survived the first pass and every one was a _cost_ guard
  rather than a claim, which is the state this file usually declares and leaves --
  the loop's exit, the pass bound, the per-pass clear in each of the two frames,
  `arrange()` collecting only what has not been told rather than everything with a
  hook, and
  the return value of that same unchanged-window early return. Each is now pinned,
  and what made that possible is one fixture: a box whose **own size never
  settles**, so the number of times it is told is the number of times the frame
  laid out. Without one, an element whose size settles is collected once however
  many layouts a pass took, and nothing a test can read distinguishes one layout
  from four. Which also closes the one SIG-131 could only declare: the _return_
  from that early return is countable where the early return itself is not, because
  a viewport whose **width** moved and whose window did not is a `sync()` that
  really is asked and really does have to answer `false`.

  **And the harness reported two stale patterns rather than passing over them**, which
  is the guard SIG-131 added for exactly this and the second time it has earned its
  keep: both went stale the moment `present()` became `animate()`, and a pattern that
  silently matches nothing is a green suite reading as "the guard is not load bearing".
  It happened a third time one level up, in the _editor_ of the harness: a `replace`
  with no assertion behind it quietly matched nothing and left the old patterns in
  place, which is the same failure in the tool that checks the tool. The fix is the
  same both times -- assert the edit landed.

  **What the sabotage pass could not find is what the review rounds did**, and every
  one of their findings is a shape a pass built out of deletions is blind to by
  construction. Round 1 found five: three were code that _agrees with itself_ (the
  animator never shown the second settle, the grid height never asked again,
  `Animator.forget()` not recursing) and two were **sentences**. Round 2 found no
  runtime defect at all in the surfaces round 1 had skipped -- `observe()` under a
  second settle, the restructured benchmark, the scrollbar and the keys over an empty
  window, and the pre-branch tests all held -- and its findings were **six more
  sentences**, which is the pattern worth keeping rather than the count.

  All six were the same drift: the collector was documented as "the elements whose
  size moved" in five places and as "told" in three, after the mechanism became the
  second. That is dangerous rather than untidy, and the reviewer said why -- somebody
  aligning the code with the stale comments reintroduces exactly the throw-path defect
  the `told` map exists for. It was introduced **three times** in this one ticket, each
  time by changing the mechanism after writing the prose, and caught once by round 1,
  once by reading the diff, and four more times by round 2. A deletion asks whether
  the code that is there is load bearing; it never asks whether a guard is missing,
  and it cannot read prose at all. Which is the boundary this file already records
  from the selection work, with a much bigger tally on the review's side.

  One of round 2's findings went further than it was reported, which is worth the
  note: it flagged the observe-twice wording as resting on identity where the guard is
  value equality, and following that through found the claim narrower still -- an
  element whose style did not change is not in the second settle's `paint` at all, so
  it is not observed twice, and the test written for the old claim was renamed to what
  it actually pins. A reviewer pointing at the right sentence is worth more than its
  own correction being complete.

  Two of the first round's survivors were the method's own boundary rather than
  missing tests and are worth recording as such. One was a **sabotage that was
  equivalent**: `declaredHeight`'s regex replaced with `Number(value) || 0`,
  where the `|| 0` rescued exactly the `NaN` the regex is for -- so it said
  nothing, and the sharper version, a bare `Number()`, is caught. The other was
  a guard that was simply **dead**: a `Math.max(1, ...)` under the window's
  length, which for any `view` above zero cannot fire, because
  `ceil((at + view) / step)` is at least `floor(at / step) + 1` and clamping
  both ends to the same ceiling keeps the order. Brute-forced over 1.8 million
  combinations of the four inputs, fractional views included, and reached zero
  times -- so it is **deleted** rather than commented, which is what this file
  does with a guard that cannot fire, and the property that has to stay true if
  the expression changes is asserted instead.

  And the harness itself needed the guard this file records twice: two of the
  slot sabotages went **stale** the moment `rows.width` reformatted that
  constructor onto several lines, and a pattern that silently matches nothing is
  a green suite reading as "the guard is not load bearing". So it reports a
  pattern that missed, a pattern that matched more than once and a replacement
  equal to its original as their own verdicts rather than as passes, and it
  verifies the edit landed against the fixed file rather than against `HEAD`.
  All three fired while this was being written -- as did a fourth shape, a test
  whose fixture could not reach the branch it was named for, which is the
  `count`-in-the-guard entry above and happened twice more over the rollback.

  What the two review rounds caught that no sabotage could is worth the tally.
  Round 1 found five, all confirmed: the `??` that read a height of **0** as "not
  arranged yet", the host that **grows** and makes a declared height no bound,
  the committed window a throw could not repair, an exhaustive walk that rejected
  only a _missing_ row, and every element count in the demo and the README being
  wrong. Round 2 was pointed at the regions round 1 said it had skipped, and
  every one of round 1's six premises **held** -- while three new findings came
  out of those regions: the offset half of the rollback, a function doc still
  calling the floor "a sound upper bound" after the code had stopped treating it
  as one, and a test named for the keyboard **and the wheel** that only ever
  pressed a key. That is the pattern this file already records: premise-attacking
  rounds confirm, and the findings come from what nobody opened.

- **The window arithmetic is walked exhaustively rather than sampled.**
  `rowWindow()` is four numbers in and two out, which is where every off-by-one
  a windowed list can have lives -- so `should hold every row a viewport can
  see, at every offset` asserts the _property_, over four row heights, four
  viewport heights and every offset from zero to past the end: about ten
  thousand windows, each checked against every row in the list. The cases beside
  it are the ones worth naming, and the one that is easy to get backwards is the
  extra row: the rows in the window are the ones that intersect
  `offset..offset + view`, which is one more than `view / height` whenever the
  first row is partly scrolled off, and a window short by it is a blank line at
  the bottom that only appears at some offsets.

- **The two shapes of "the window is recomputed when the offset moves and at no
  other time" are closed, and SIG-132 is where.** They were one cause -- the window
  was computed from a viewport height the component knew before any layout -- and
  the fix is the entry under `Element.onResize` above: the height has a hook of its
  own, a frame dispatches it after the layout, restyles what the handlers built and
  lays out again. Both halves of what that replaced are worth keeping, because both
  were measured and because the second one's premise is what made the first look
  acceptable.

  The **resize** was the one that was visibly wrong rather than slow. A list
  bounded by its parent -- `flex-grow: 1`, or a percentage -- laid out at ten rows
  and scrolled, then re-laid-out at forty, held **ten rows where forty-one were
  needed**, so thirty rows of the viewport were blank until the next scroll,
  because a resize writes no offset and `onScroll` never fired. Pinned now in both
  frames: `should rebuild the window when the viewport grew, which writes no
  offset` over `renderToString()` and `should rebuild the window when a resize
  changed the viewport` over a renderer, plus the shrinking direction and a
  coloured differential against a list that declared its height at five offsets.

  The **first frame of a flex-sized list** was the merely-slow one, and it needed
  the pre-layout fallback to change as well as the hook to exist -- re-windowing
  after the layout does not unpay a layout of the whole list, which the ticket's own
  framing of it missed. Measured by `benchmark-virtual-list.mjs`, which grew a
  section for it because a layout cannot answer the question at all: ten thousand
  two-text rows at 80x24 through `renderToLines()`, six interleaved rounds, both
  sides built afresh each round and required to produce identical lines first. The
  flex-sized side goes from **186.0ms to 0.605ms** median -- three runs of each
  binary reading 186.0 / 185.1 / 190.1 before and 0.583 / 0.605 / 0.642 after, so
  about **307x** -- and what the number means is that it now comes within **1.1x** of
  a list that declared its height, 0.605ms against 0.542ms, where it was 330x off.
  Elements built for that frame: **40,010 before, and 10 built with 106 after it**.

  **And the control caught the harness being wrong, which is the entry worth keeping
  rather than the figure.** The first version of this measurement read a 97.7ms
  whole-list first frame against the **190.6ms** this file already records for the
  same workload, and that was written up as the machine being 1.8x quicker -- with
  the delta claimed as sound because the two binaries agreed with each other. The
  file was right and the harness was wrong, which is the rule this repo states and
  that write-up inverted. What halved it was the `whole` side itself: the old one
  turned the optimization off by **removing** the declared height, which SIG-132 made
  mean "no rows", so it was given the whole list's height as a floor instead -- and
  `rowWindow()` takes `first` from the **offset**, so no `view` however large can put
  a row _above_ the offset in the window. At the timed offset, which is deliberately
  the middle of the list, that side built **20,106 elements rather than 40,010**:
  exactly half, exactly the factor. There is no value of a declared height that fixes
  it, so the first-frame section is measured against `children()` -- the same rows
  assembled by hand, which is what an app writes today, is already the notch
  section's baseline, and really does hold every row at every offset. It reads
  **209.2 / 209.4 / 206.9ms** on `main`'s binary and **210.6 / 217.6 / 225.0ms** on
  this one, which is the same number and is what says the harness is sound now.

  Two things follow for whoever measures this next. The sides are no longer "the same
  component with one input removed" for that section, and the one place that purity
  survives is the flex-vs-declared section -- because a frame is what makes the
  flex-sized side work at all. And a number that disagrees with this file by a factor
  of two is a harness to go and read, not a machine to blame; rationalising it cost a
  commit and was caught only by going back to the element count.

  What was refused with that pair, and is now simply done, was a change to the
  **frame** and to `arrange()`'s contract for every caller taken inside a ticket
  about a list. `arrange()`'s contract did move, and it moved by an **optional
  third argument**: it still lays a tree out and returns a `LayoutResult`, and a
  caller that passes no collector sees no behaviour change at all. What a frame
  gained is `settleResized()`, which both frames share rather than each having a
  loop, and the restyle that goes with it -- which is the half `arrange()` could
  not have taken, since it sits below the cascade and has no sheets to resolve
  against.

  **Variable row heights** are still refused, above, with their reason rather than
  deferred for want of time. **Tabbing past the last built row**,
  which wraps rather than scrolling on, because a row nobody built is not in
  the focus ring -- note the direction: a window makes a focus nobody can find
  _unreachable_ rather than fixed, since only on-screen rows exist, and what is
  lost is reaching the ones that do not. A **windowed horizontal** axis, which
  is the same mechanism turned ninety degrees and has no caller -- and which is
  not the cross-axis extent above, since that one is answered by `rows.width`
  rather than deferred. **A list that grows while nobody is scrolling** was here
  for the reason the `count` entry gives, and is `resync()` now (SIG-209). And
  **overscan**, which is one more number than the design needs: a window rebuild
  is 0.26ms of cascade over eighty elements, and rows that stay in the window
  are kept rather than rebuilt, so what a notch costs is the rows that newly
  entered.

### A debug overlay: captured console output and frame stats

Debugging a full-screen app means not being able to print anything. The
full-screen backend holds what is written to it and flushes it on the way out,
and that is right for the reason recorded there -- there is no "above the region"
on a screen with no scrollback, and a log line the app thought it had written is
worse than one that arrives late -- but _after the app exits_ is not when you
need to read it. A `console.log` in an effect that fires thirty times a second is
invisible until the process ends and then arrives as a wall.
`src/components/debug-overlay.ts` is the whole of the feature: a ring, a console
patch, a pane, and three additions to the renderer that the pane needs.

- **The overlay is part of the tree it reports on, so every obvious shape of it
  is a loop or a lie.** That is the finding rather than the framing, and it is why
  the three guards below are structural rather than careful: a stat that counts
  the overlay's own rows is a measurement of the instrument, and a log line
  written by the render path lands somewhere whose change asks for another frame.
  Each of the three has a test named after it and each of those tests fails when
  the guard is deleted -- which is how the sabotage pass found a fourth thing
  nothing was asserting.

- **The ring is plain data with a version counter, and it is deliberately not a
  signal -- which is the ticket's own wording overruled with a reason.** SIG-113
  asked for "a ring buffer signal", and a signal cannot be one here: a write
  notifies its watchers, a notification reaches the renderer's scheduler, and the
  scheduler asks for a frame. So `console.log()` inside an effect would ask for
  the frame that runs the effect that logged. The ring therefore has nothing it
  _could_ ask with, which makes the first hazard unreachable rather than guarded
  -- and what reads it is `Renderer.onFrame()`, which is a frame that was already
  happening. The second half of the ticket's own paragraph is what settles it:
  "writes into the ring do not mark anything dirty on their own".

  The consequence is the honest one and the demo is written around it: in an app
  with nothing else going on, a line logged after the last frame does not appear
  until something else asks for one -- a keystroke, a resize, a signal write.
  There is no loop-free alternative, because showing a line means changing the
  tree and changing the tree means a frame.

- **A ring rather than the unbounded buffer the backend keeps, and the reasoning
  inverts rather than being inconsistent.** That one is unbounded because "a cap
  that silently drops the start of a log is its own trap" -- that log is for
  _keeping_, and it is flushed to the main screen where its reader is. This is for
  _watching_: the last few hundred lines are the ones anybody reads off a pane,
  and an unbounded one behind a live overlay is a leak for the life of the
  process. Five hundred by default.

- **`version` counts changes and each entry carries a `seq`, because one counter
  cannot answer both questions.** A reader compares `version` to find out whether
  it has anything to do, so a `clear()` has to move it -- and the pane's own fast
  path is `log.version === seen`, so a counter that meant "lines ever pushed"
  would leave the rows showing a cleared ring for ever. The sequence numbers are
  what the rows are matched by, and they are carried on the entry rather than
  derived from a position precisely so that a `clear()` leaves the positions
  meaning something different while they go on meaning what they did.

- **A write becomes a line per newline.** The pane draws one row per entry, so a
  write holding a newline would be one row with two lines in it. One _trailing_
  newline goes, because that is the one `console.log` would have added itself; a
  blank line in the middle is a line somebody printed and is kept. Either line
  ending, because what reaches here is whatever somebody passed to `console.log`
  and a string read off a file on Windows carries CRLF.

- **The capacity is checked for being a number rather than floored, and `NaN` is
  why.** `Math.max(1, NaN)` is `NaN`: a ring of `NaN` slots holds `size < NaN`,
  which is false, so the first push wraps into slot `NaN % NaN` and every line
  after it is dropped while `size` stays at zero -- a log that silently captures
  nothing, which is the one failure mode nobody would look for here. The same trap
  `readInt()` and the typewriter's interval already carry an entry for, found by
  the test for the floor rather than by review.

- **Node's own `format()` does the formatting, because the one thing the capture
  must not change is what a message _says_.** A hand-rolled formatter reads
  `console.log('%s items', 3)` as the literal text with the argument after it,
  which is a divergence somebody would hit on their first `%s`. It is a builtin
  rather than a dependency, which the zero-dependency rule already admits
  -- `node:fs`, `node:path` and `node:console` are all in `src/` -- and the
  registry generator leaves a non-relative specifier alone, so the ejected copy
  spells it the same way.

- **Nothing is forwarded to the console it replaced, and that is the feature.**
  Forwarding into a full-screen backend's held buffer is exactly the failure this
  exists for, and forwarding past it to the raw stream would write into the
  alternate screen the renderer is diffing. The ring is the destination.

- **`trace` is not patched, and it is captured anyway (corrected in SIG-310).** This
  entry said it was left alone because replacing it with a formatted line would
  throw the stack away. Measured with a spy on `process.stderr.write`: Node's
  `trace()` builds the stack and hands it to `this.error()`, so with `error`
  patched it arrives as `error` lines, one per frame, and is not left alone at all.
  Seven methods are patched: `debug`, `dir`, `dirxml`, `error`, `info`, `log`,
  `warn`. `dir` and `dirxml` were not on the list and are the two that wrote into
  the alternate screen past it, because Node writes them through its own writer
  rather than the public methods; they are stored as `log`, `dir` through
  `inspect()` with `customInspect: false` and the caller's options, as Node does,
  and `dirxml` through `format()`. `table`, `group`, `time*`, `count` and `assert`
  end in `log` or `warn` and were always captured.

- **The console patch follows "put back what you attached", and reports whether
  this call was the one that changed it.** The rule `hideCursor()`,
  `setRawMode()` and `enableBracketedPaste()` already keep, and it is a _global_
  being guarded, so the latch is module scope: two captures racing over
  `console.log` would each record the other's patch as the original, and whichever
  restored second would put the first one's patch back for ever. A second capture
  is a no-op reporting `installed: false` whose `restore()` returns `false`,
  rather than an error -- two live overlays in one process can happen and is not a
  failure.

- **A method whose current value is no longer ours is left alone, which is that
  rule taken literally.** Somebody else's patch over ours is holding ours as its
  original, so removing theirs would break their restore and assigning our
  original over it would take their patch off without their asking. So the restore
  asks `target[level] === patched[level]` first.

  What that leaves is an **orphan**, and it is inherent rather than a hole: when
  they restore, they put _our_ patch back, and the real method is then held by
  nobody -- so `console.log` goes on pushing into a ring that may be the one nobody
  is reading. Both answers lose one of the two patches, because the two installs
  were not nested, and the one that loses ours is the one that does not break
  somebody else's teardown. So what this does about it is **say so**:
  `restore()` reports whether it put the console back rather than whether it was
  the call that changed something, and a restore that found a method it could not
  put back returns `false`. Reported by the first review round, which is also where
  the alternative was weighed -- holding the latch would make one foreign patch
  refuse every later capture for the life of the process, so the latch is freed
  either way.

- **A throw mid-install unwinds, because half a patched console with nothing
  holding the originals is worse than none of one.** Reachable rather than
  defensive: a property assignment on a frozen console, or on one whose methods
  are accessors, throws -- so the install records what it replaced as it goes and
  the catch puts back exactly the ones it had got to. The latch is left free, so a
  later capture installs.

- **What it costs the bundle is 3,694 bytes of `components.mjs`, measured by
  taking it back out of the barrel and rebuilding.** 36,524 bytes with it against
  32,830 without, which is the same way `ScrollBox`'s own 3.4 kB was measured and
  is about the same size. Re-measured after both review rounds, because the first
  figure read 3,552 and the fixes moved it -- a number in this file that only a
  re-run can confirm is a number that goes stale quietly. `node:util` lands in that chunk and in no other, which
  is the one builtin the components bundle now imports -- a builtin rather than a
  dependency, so the zero-dependency rule is untouched and what it adds to a
  bundle is nothing.

- **`Renderer.onFrame()` fires at the top of a frame, before the effects run, and
  the ordering is the whole of what it is for.** What a handler writes there is
  settled, laid out and painted by the **same** frame that called it, so a pane
  reading some non-reactive source picks its changes up on a frame that was
  already happening rather than asking for one of its own. A handler that ran
  after the paint would be a frame late and would have to ask for another.

  Dispatched over a copy **and** a membership check, which are two rules and not
  one -- the rule the router's bindings, its paste handlers and
  `Terminal.onResize()` already keep. `teardown()` clears the set, and the
  exclusions with it: a handler nothing will ever call and an excluded element
  nothing will ever walk are both references the renderer has no further use for,
  and nothing else can drop them -- `view.dispose()` without `overlay.dispose()`
  is a thing an app does. Cleared rather than replaced, so an unsubscribe a caller
  still holds stays callable. A handler that throws is reported to
  `onError` and the frame carries on, because a frame callback is an observer and
  a failing observer must not take the screen down: that is `onMount`'s rule, and
  raising instead would reach `runFrame()`'s catch, which is `fail()`.

- **It is handed the stats of the frame before it, because a frame cannot report
  on itself.** The numbers are not known until it has finished, and a tree built
  from them would be built after the layout and the paint it is describing. So
  `Renderer.stats` is the last completed frame's and a pane showing it is always
  one frame behind -- which is the honest answer rather than a limitation, since
  the alternative is a stat that reports on the instrument reading it.

- **`gatherStats` is off by default, and a frame nobody asked pays nothing.**
  Every number in a `FrameStats` is one the frame already had in hand: the
  restyler answers with how many elements it re-resolved, the settle knows whether
  it laid out and whether it painted, and the canvas was handed the diff's own
  count of the cells it drew. What turning it on adds is **one walk of the tree
  per frame**, which is what `elements` and `changed` cost, because both leave out
  the subtrees `excludeFromStats()` named and that is a question only a walk
  answers. A flag rather than always-on for the reason the style sweep's growth
  factor is a comparison rather than a walk: an app that never reads the numbers
  should not pay `O(elements)` a frame to produce them.

- **One walk answers both numbers, because two readers of "is this excluded" is
  how the two come to disagree.** `countTree()` asks the question once per
  element, at the top of the walk, and an excluded element's descendants are
  simply never reached -- so the count and the filter cannot come apart. The
  alternative was a walk for the count and an ancestor test for the filter, which
  is the shape that drifts. It allocates nothing per element: the stack is reused
  rather than a set of included elements being built, which is the difference
  between `O(elements)` of work and `O(elements)` of garbage on a frame of a
  ten-thousand-row list.

- **Two of the numbers are the tree's and five are not, and saying which is the
  honest half of the exclusion.** `elements` and `changed` leave out every subtree
  `excludeFromStats()` named, which is what keeps an overlay out of what it
  reports. `resolved` cannot: the restyler answers with a **count** rather than
  with the elements it visited, so there is no set to filter -- and it is kept
  anyway, because it is the number the recorded invalidation measurement is about.
  `bytes`, `cells`, `styles` and `sweeps` cannot either, and for a sharper reason:
  **a cell count cannot be attributed to part of an element tree.** The diff is
  over a grid, and by the time it runs there is no tree left to ask which element
  painted a cell. So an overlay reporting those is reporting on itself along with
  everything else, and that is said in the type rather than left to be discovered.

- **`cells` and `bytes` are zero for a frame that painted nothing, rather than
  what the last one that did cost.** The canvas's numbers describe its last
  `present()`, which for a frame that found nothing to paint is some earlier
  frame -- so reading them straight through reported every quiet frame as having
  cost whatever the last busy one did. Found by the test for a second frame,
  which is the cheapest shape that could have caught it.

- **`DiffResult.cells` is counted in the loop that already walks the cells.** A
  second count over the same grid would be a second answer to one question, and a
  count derived from the output would have to parse it back -- `output.length` is
  bytes and counts the cursor moves and the SGR transitions along with the glyphs.
  A wide cluster is **one** cell, because one glyph was written; the continuation
  beside it is drawn by its lead and is never written on its own -- which a _first_
  frame cannot show, since that one is a full repaint and draws every cell of the
  grid. `Canvas.stats` is a fresh object per read rather than a live one, so a
  caller that keeps a snapshot keeps the numbers it read.

  A **resize** zeroes the last frame's cost, because it takes the grid that frame
  was drawn on: `styles` and `sweeps` are read as of now while `bytes` and `cells`
  described the last `present()`, so a read between a resize and the next frame
  reported a pre-resize frame's cells beside a post-resize style table -- two
  frames in one object. Reported by the first review round. It changes nothing
  about a `FrameStats`, which already zeroes those two for a frame that painted
  nothing, and nothing about a real frame either, since the resize happens inside
  the layout and the paint's own present comes after it.

- **`duration` is measured from after the frame handlers, because the overlay is
  one of them.** A handler that spends two milliseconds rebuilding its rows would
  otherwise make every frame read two milliseconds slower -- the instrument
  measuring itself, in the one direction somebody turns the pane on to look at. So
  what the number is, is the work the frame did; `at` is still the top of the
  frame, because that is when it ran. Pinned with the injected clock, which is the
  only way to say how long anything took without timing it.

  It is the renderer's own clock, which is `Date.now` by default, so a frame under
  a millisecond reads as `0` or `1`. An app that wants better passes `now`, which
  is the one clock the pacing, the transitions and the frame skip all read -- a
  second clock here would be a fourth reader with its own idea of what time it is.

- **The pane is appended to the root, which is sound rather than a liberty.** It
  is `position: fixed`, so it is taken out of flow, takes no space, and does not
  size the parent it was added to -- `measureUncached()` filters out-of-flow
  children out of what a box measures, so an auto-height canvas does not grow for
  it either. The app's layout is what it was, which is what makes
  `enableDebugOverlay(view, opts)` possible at all: the stats, the exclusion and
  the frame callback are all the renderer's, and the renderer does not exist while
  the component body is running. The same shape `enableSelection()` already has.

- **`bottom` with a declared height rather than `top` and `bottom` together.** The
  engine's rule is "two insets, else a declaration": `left` and `right` say how
  wide the pane is, and `bottom` plus `height` say where its bottom edge sits --
  which is the caller's number rather than something to derive from the canvas.

- **`display` is what hides it, not `visibility`.** A `display: none` subtree is
  not laid out at all, where `visibility: hidden` would lay out every row to draw
  none of them -- and the focus ring skips the first and not the second, which for
  a pane full of log lines is the answer that costs nothing while it is closed.

- **`min-height: 0` on the log is the one declaration that is not obvious, and it
  was wrong until a sabotage pointed at it sideways.** A box's automatic minimum
  is content-based, so the log's is its content's -- five hundred rows -- and a
  `flex-basis: 0; flex-grow: 1` cannot shrink below it. Measured: the pane came
  out **forty rows tall inside a box drawn for six**, with the rows painted
  straight through its own bottom border and over whatever the app had drawn under
  it. It is CSS's own idiom for a scrolling pane inside a flex column, and it is
  pinned as the box **and** as the picture, because the box is the mechanism and
  the border is what somebody would have reported.

- **Every line draws in a _role_, apart from an ordinary one, which is why this
  component adds no colour declaration of its own to the sheet.** A line's level is
  de-emphasis, a warning, an error or a note, and each of those already has exactly
  one site in the framework's role vocabulary -- so `.sigil-error { color: magenta }`
  restyles an error here along with everything else. Keyed by the union so that a
  level added without a role is a type error rather than a class no sheet defines,
  which is the rule `SEVERITY_ROLE` already keeps in the toolchain.

  `log` draws in **no** role, because the ordinary case is the default foreground
  -- so an ordinary `console.log` line is the one part of the pane a role rule does
  not reach, and `.sigil-debug-entry` is the hook for it. That is the honest half
  and three comments overclaimed it, each saying "every line draws in a role":
  the module docblock, `LEVEL_ROLE`'s own, and the sheet's. Reported by the second
  review round, which is where every finding of that round came from -- and the
  test named for the rule asserted that the four roles carried a _declaration_,
  which is a claim about `FRAMEWORK_CSS` that would hold with the pane drawing
  every level in nothing at all. It reads the resolved colour off a rendered line
  now, both halves, which is what a theme can actually reach.

- **The background is the sheet's and not a prop, and it was a prop for a
  commit.** A prop beats a sheet per property, so `background-color: black`
  written into the host beat the light half of `.sigil-debug` **and** beat a theme
  rule on the same class -- which is the rule this file already records as "no
  built-in carries a colour in its props", broken by the one component that needed
  a colour badly enough to reach for props. What made it invisible is that the
  prop and the sheet agreed on a dark terminal: the pane looked right everywhere
  anybody was looking, and a light terminal got index 0 behind its own dark
  default foreground. Found by self-review and by the first review round in the
  same hour, and pinned in both schemes and against a theme rule -- the earlier
  test asserted the title and an entry, which the prop did not touch.

- **The one declaration the pane does carry is a _background_, and it is the
  sheet's third declared exception to the role rule.** No role is a background, and
  the pane is the one built-in drawn over the app's own content: a box with no
  background paints nothing in its empty cells, so without it the app shows
  through between the pane's words and the pane is unreadable. Index 0 with a
  light half of index 7, which is the narrowest pair that works on both -- the
  text in the pane is the terminal's own default foreground, so black behind it on
  a dark terminal and white behind it on a light one is in both cases the
  background that foreground was chosen to be legible against. No hex, for the
  reason every colour in that sheet is an index.

  It is **transparent at colour level 0**, which is degradation working rather
  than a gap: the same thing `06-panes.js` already records, where an overlay whose
  only opacity is a background has none there. What is left is the pane's border,
  which is box-drawing characters and survives, with the app's content showing
  between the lines. The two ways to reach level 0 are a pipe, which has no
  overlay to toggle, and a user who asked for no colour.

- **The geometry is in props and the colour is in the sheet, which is the rule
  that sheet keeps for every built-in.** `box-sizing` starts at `border-box`, so a
  `padding-left` from a theme would be taken _out of_ a width the pane worked out
  -- the same thing a themed table cell already records. Six new classes, all of
  them hooks with no rule: `.sigil-debug-head`, `.sigil-debug-title`,
  `.sigil-debug-stats`, `.sigil-debug-log`, `.sigil-debug-list` and
  `.sigil-debug-entry`, beside `.sigil-debug` itself.

- **The rows are kept rather than rebuilt, which is `For`'s own reason.** A row
  still in the ring is the same row, so keeping its element keeps its resolved
  style and its text measurement -- both of which are keyed on the style object
  and are worth nothing to a fresh element. A ring that wrapped once per frame
  would otherwise rebuild five hundred rows to move one. Matched by sequence rather
  than by counting, so a `clear()` followed by a push cannot be mistaken for the
  same lines arriving again.

- **The pane's own writes are not what asks for the next frame, and that is the
  one hazard that does not terminate by itself.** The rows do: a sync that finds
  the ring unmoved writes nothing. The _stats_ line holds the frame number and the
  frame's duration, so it differs on every frame -- and `setText()` marks layout
  and asks for a frame, so writing it unconditionally is a **thirty-a-second spin
  for the life of the process** in which every number shown is a measurement of
  the instrument. So the line skips exactly the frame its own last write asked
  for, which is what makes it stop: that frame finds nothing to do and sets no
  other timer. What it costs is that a steadily animating app updates the line
  every other frame rather than every frame, which is the right trade -- the
  alternative is an app that cannot stop because something is watching it.

- **The follow is `scrollIntoView()` on the last row, and what it waits for is
  that row's _box_ rather than a frame.** Arithmetic of the pane's own would be a
  second answer to "where is that row", and the one function that already knows is
  the one the focus ring calls. What it needs is a row the layout has placed: a row
  with no box is one `scrollIntoView()` returns from without doing anything, which
  is indistinguishable from one that was already visible.

  It was written as "wait one frame", which is right for a row the sync just
  appended and **wrong** for a row appended while the pane was closed -- a hidden
  subtree is not laid out at all, so those rows have no box however many frames
  pass, and the flag was consumed on exactly the frame that could not act.
  Measured: a pane left closed while forty lines arrived opened on **line 0**
  rather than line 39, and so did every later open after a hide. Reported by the
  first review round. Asking about the box is what makes the wait as long as it
  has to be, and it subsumes the one-frame case rather than sitting beside it.

  It also has to be able to ask for the frame that comes after that layout, which
  is one `view.invalidate()` and is bounded at one per pending follow -- a visible
  pane's next layout gives every row a box, so one is enough, and a tree where it
  somehow never does leaves the pane unscrolled rather than asking for a frame per
  frame for ever. The half that needs it is `stats: false`: with the stats line on,
  its own write is what asks for that frame, which is why the first test for this
  passed with the retry deleted.

  The deferral survived the whole first sabotage pass, because not one test had
  asserted that the newest line is the one on screen; it has four now -- `follow`,
  `follow: false`, an open after a hidden fill, and the same with no stats line.

  Unconditional rather than "only when it was already at the bottom", which is
  `tail -f` and is what a pane you toggled on to watch something wants: a line
  arriving while you are reading history pulls you back, and reading history is
  what pausing the app is for. `follow: false` is the opt-out.

- **Which key it is, is a predicate rather than a name, and that is a correction
  the demo forced.** The first version took a `Key.name` and its own documentation
  recommended `f12` -- a name **this decoder never produces**: the named sequences
  are the arrows, the paging keys and the editing keys, and everything else comes
  through as a key whose name is its own escape sequence. So the one documented
  value of the option matched nothing, and no unit test could have seen it,
  because every one of them wrote the name it was asserting. Found by driving the
  demo, which is the argument for having written one.

  A predicate also has no chord grammar to invent, which is the other half of it:
  a key name and a modifier set are two things, and a third spelling of a chord
  beside `Key`'s own fields would be a grammar with one caller. What an app writes
  is `(key) => key.ctrl && key.name === 'g'`. A binding sees **every** key before
  the focused element does, so a bare letter is a letter a text field can no
  longer type -- the handle's `toggle()` is there for an app that wants a guard of
  its own, which is what `03-focus.js` does with its `q`.

- **The overlay disposes itself when the renderer goes, which is the half the app
  forgets.** `view.dispose()` without `overlay.dispose()` is a thing an app
  does, and toggling a pane nothing will paint is harmless -- **stopping the key**
  is not. A binding sees every key before the focused element does, so a dead
  overlay would go on swallowing its key on a router the app still owns. Reported
  by the first review round, and first answered with a `view.mounted` check in the
  binding, which left the binding on the router for good. SIG-219 gave the
  renderer `onDispose()`, and the overlay subscribes last and calls its own
  `dispose()` from it, so the binding comes off and the check went: with the
  subscription in place it could no longer fail a test. `enableSelection()` does
  the same with its `stop()`.

- **`dispose()` puts back what was attached, in reverse.** The frame handler
  first, so that nothing reads a pane being dismantled, then the key, then the
  stats exclusion, then the element. Pinned as a **count** rather than as a
  picture: the pane is detached, so whatever it builds afterwards is invisible
  either way -- what a disposed overlay still reading frames would do is go on
  appending rows to a subtree nobody can see, for the life of the process.
  Deleting the unsubscribe survived every other test here.

- **`format()` is asked of `node:util` when the console is captured, not
  imported (SIG-328).** The ESM import of `node:util` brought `worker_threads`
  and the stream stack in behind it, on the barrel every app that draws anything
  loads, for an overlay most of them never turn on. `process.getBuiltinModule()`
  hands back the module without that, and synchronously.

> Moved: _What the sabotage pass found, and what it got wrong_, _What the second review round found, and it was all prose_ — see [docs/history/a-debug-overlay-captured-console-output-and-frame-stats.md](../../../../docs/history/a-debug-overlay-captured-console-output-and-frame-stats.md).

#### What is deliberately out

- **No file redirect**, which is the first of SIG-113's two open questions and the
  ticket carries its own answer: it is "a different feature wearing the same hat --
  `DEBUG` already writes somewhere", and `src/debug/` is that somewhere. What a
  redirect would be is a second destination with its own rotation, its own
  formatting and its own question about what happens when the file cannot be
  written -- none of which the pane needs, and all of which an app gets today by
  calling its own logger instead of `console.log`. `log.entries()` is there for an
  app that wants to write the ring out itself, which is what the demo does on the
  way out.

- **Full screen only**, which is the second. The inline backend has `write()`,
  which puts a line _above_ the region and re-anchors -- so an inline app can
  already print, and an overlay there would be a second answer to a question that
  has one. Nothing stops `enableDebugOverlay()` being used over an inline canvas
  and nothing about it would break; it simply is not what it is for, and the
  asymmetry is the backends' rather than the overlay's.

- **No `onfinish`-shaped observation of the stats.** `Renderer.stats` is a read
  and `onFrame` is the subscription, which is the two things a pane needs; an
  event per stat would need a delivery point inside the frame, which is the
  re-entrancy `runFrame()` already refuses.

- **The overlay does not capture the console itself.** `captureConsole()` is a
  separate call, because the patch is a global and the overlay is not: an app with
  two renderers has one console, and an overlay that installed one would be an
  overlay whose teardown order decides whether `console.log` still works. The app
  owns the pairing, which is what makes `installed` a statement it can act on.

  **Under `runApp()` the runner is the app, and it makes the call (SIG-310).** It
  captures the console by default into a ring it owns and exposes it as
  `app.logs`, so the pairing is one line in the app --
  `enableDebugOverlay(app.view, { input: app.input, log: app.logs })` -- and the
  overlay still installs nothing. `log` is `undefined` when the runner captured
  nothing (`console: false`, or a capture the app installed first), and an
  overlay given `undefined` makes a ring of its own that nothing fills: pass the
  ring that was passed to your own `captureConsole()`. The ring and the patch
  moved to `console-capture.ts`, re-exported from here, so that the runner can
  have them without the pane; the full decision is under "Running an app" in
  `src/renderer/AGENTS.md`. `createLogRing()` gained `onPush`, called per line
  after it is stored, which is what lets an inline app echo each captured line
  above its region while the ring still keeps it.

- **The pane holds its ring as ordinary children rather than as `rows`, and the
  reason is no longer a missing mechanism.** It was: "a list that has to grow
  while nobody is scrolling is left for a later tier -- it needs a way to ask for
  a re-sync", and adding one inside a ticket about a debug pane would have been a
  change to `ScrollBox`'s contract taken for a pane. SIG-209 added it --
  `scrollControl(host).resync()` -- and the pane still does not switch, because
  what is left is cost rather than capability. At five hundred rows the pane
  costs an arrange of five hundred one-cell texts while it is **open**, which
  against the recorded 10,000-row figures is a couple of milliseconds; closed it
  is `display: none` and not laid out at all. Switching is not one line either:
  the follow is `scrollIntoView()` on the last row's **box**, and a windowed ring
  has no last row built until the window reaches it, so the follow becomes a
  `resync()` and a `scrollTo()` of the range's end, the drop from the front of
  the ring becomes a count that shrinks under a window, and both want tests of
  their own. The day somebody wants a ten-thousand-line ring is still the day to
  pass `rows` -- it is now a refactor of this file, not a feature of another one.

### A subpath per component (SIG-330)

`@ttylabs/sigil/components/<name>` for every component, beside
`@ttylabs/sigil/components`, whose exports did not change. Every subpath is a
name an app can import and so can never quietly change, so what follows was
decided once, for all of them. The runs and the sabotage passes are in
[docs/history/a-subpath-per-component.md](../../../../docs/history/a-subpath-per-component.md).

- **Which modules: every one the barrel already exported from, which is every
  module but `spinner-frames`.** Fifty-five. A rule rather than a curated set,
  for three reasons. It is mechanical, so a test can hold the directory to it.
  The helpers it sweeps in -- `keys`, `mount`, `editing`, `fuzzy`, `catalog`,
  `key-help`, `markdown-parse`, `log-stream` -- were already public through the
  barrel, so their subpath adds a path rather than a name, and without one an app
  that uses `decodeKeys()` would keep importing the barrel for one function and
  pay for every component. And the registry, below, needs every sibling a
  component imports to have a subpath of its own. `spinner-frames` stays out:
  it is the long tail of spinner sets, shipped in the registry and imported by
  nothing in `src/`, so that no app pays for it (SIG-183), and a subpath would
  publish it. `INTERNAL` in `test/component-subpaths.test.ts` is where an
  exception is written, with its reason, so that the next one is a decision.

  `color-level` is the second, for the same reason: SIG-309 put the one rule for
  a component's colour level in its own module and called it from 23 component
  sites, so most ejected components import it as a sibling. It was already in
  the barrel, so its subpath adds a path rather than a name. `owned-hooks` is
  the third, by the same rule: SIG-305's `refuseOwnedHooks()` is called by
  seven components (modal, toast, tooltip, pager, text field, scroll box, tabs)
  and was already in the barrel.

  `console-capture` is the first module the rule met after it was written, and
  it is a subpath for the registry's reason, not an exception. SIG-310 moved the
  log ring and the console patch out of `debug-overlay.ts` so that `runApp()`
  could own them without loading a pane, and the overlay now imports them as a
  sibling. So an ejected overlay has to import `./console-capture.js` from its
  own subpath. `INTERNAL` would have satisfied the drift test and left the
  registry generator refusing the overlay. Its names are in both facades:
  `debug-overlay.ts` re-exports them on purpose ("they are this module's exports
  still", SIG-310), and the overlay's component page documents them under that
  subpath. Both facades export the same bindings, so the barrel's two
  `export *` lines name one thing each, not two, and the union stays exact.
  Moving the names out of the overlay's facade was tried first and failed the
  website's check that a page's subpath exports what the page lists.

- **Named after the file, not the export, with no exceptions.**
  `group-multiselect` rather than `groupMultiselect`. A module exports several
  things -- `prompt.ts` the six prompts and the plumbing under them, `chart.ts`
  five charts, `clock.ts` a stopwatch and a timer -- so naming by export is
  either one name per module picked by taste, which is not a rule, or a subpath
  per export, which means splitting the source and is the refactor the
  registry's "An entry is one file, not one export" already refused. Kebab case
  is every other subpath's spelling (`error-handler`, `jsx-runtime`), and a
  registry entry is named after the same file, so `sigil add spinner` and
  `@ttylabs/sigil/components/spinner` name one thing.

- **A subpath exports what the barrel exports from its module and nothing more,
  which takes a facade.** The obvious build -- the module itself as the entry --
  publishes every `export` in it, and a module exports what its siblings share:
  19 values beyond the barrel's 260, measured off the first build, among them
  `addDays()` for the date prompt, the path prompt's six segment helpers, and
  eight of the prompts' layout functions, with their types. Published, each is a
  name that can never be renamed. So `src/components/subpaths/<name>.ts` is one
  `export { ... } from '../<name>.js'` -- the barrel's list for that module,
  moved rather than copied -- and `index.ts` is `export *` over the facades, plus
  the theme. The list is written once, and a name two facades both export is
  TS2308 in the barrel rather than a name `export *` silently drops.

- **The list is kept honest by the manifest and a test rather than a
  generator.** `exports` has to be literal JSON, so the manifest names every
  subpath; `tsdown.config.ts` reads its component entries off the manifest
  (`componentEntries()`), so those two cannot drift; and
  `test/component-subpaths.test.ts` holds the manifest to the directory -- every
  module has a subpath unless it is `INTERNAL`, every subpath has a module and a
  facade over exactly that module, the barrel is `export *` over exactly those
  facades, and each points at `dist/components/<name>.mjs` and `.d.mts`. Built,
  it asks that every name a subpath exports is the very binding the barrel
  exports, which is what "shared, not copied" means to an app: one module
  instance behind both spellings, so a `PromptError` from a prompt imported one
  way is `instanceof` the class imported the other, and a live region mounted
  through a subpath is one the barrel's components evict. A generator writing the
  manifest was refused, because it is a build editing a committed file that turbo
  hashes as one of that build's inputs.

- **Shared code is in shared chunks, and the barrel is what pays for it.**
  rolldown splits by which entries reach a module, so the stack every component
  is drawn with sits in chunks every subpath reaches and nothing is copied: the
  element tree's and the signal graph's own error messages are each in one
  shipped file, reached from the spinner, the prompts and the progress bar alike.
  All of `dist/`'s `.mjs` went from 646,774 to 672,937 B, and the difference is
  the import and export statements between chunks. What moved is the barrel's
  shape: its component code was one 218 kB file and is now 55 chunks it imports,
  so it went from 473,873 B over 38 modules to 496,422 over 110, and from 15.0 to
  22.4 ms of a fresh node's import. That is inherent rather than a setting: a
  component's code is in one file, and a file that only its subpath loads is one
  the barrel has to load on its own. Building the barrel separately, as one file
  again, was refused -- it is a second copy of every component, so an app that
  used both spellings, which is any app halfway through moving and any app with
  a library that chose the other one, would get two `PromptError` classes and
  two live-region registries. So the barrel is the slow path now, which is the
  reason the README recommends the subpath; an app `sigil build` bundles pays
  nothing for it.

- **Measured, as of SIG-330, on node 26.10 on arm64 macOS.** Medians of 61
  interleaved fresh-process imports, at a load average of about 12 from other
  work, so the milliseconds are relative to each other rather than absolute; the
  root entry is the control. Built is `sigil build` of the `shake-spinner`
  fixture and its `-subpath` twin, the same app importing `createSpinner` the two
  ways: the static graph of what it wrote, and the wall clock of running it,
  medians of 41.

  | one-spinner app                            | modules |   bytes |   ms |
  | ------------------------------------------ | ------: | ------: | ---: |
  | unbundled, barrel, before                  |      38 | 473,873 | 15.0 |
  | unbundled, barrel, after                   |     110 | 496,422 | 22.4 |
  | unbundled, `components/spinner`            |      30 | 194,847 |  8.8 |
  | unbundled, spinner + table + prompt        |      38 | 247,076 | 10.6 |
  | built, barrel, before                      |       7 | 192,671 | 37.0 |
  | built, barrel, after                       |       7 | 192,669 | 36.9 |
  | built, `components/spinner`                |       7 | 158,414 | 36.2 |
  | `@ttylabs/sigil`, before → after (control) |       8 |  12,326 |  3.3 |

  The ticket's baseline, from a scratch build, was 475 KB over 41 modules and
  about 15 ms for the barrel against 195 KB over 29 and about 8 ms for a spinner;
  the subpath lands on it, at one module more for its facade. The built row is the surprise: shaken, the barrel's
  app still loads a 43 kB chunk of prompt code at startup, shared with the lazy
  palette path behind `main()`, and through the subpath that code stays behind
  the palette's `import()` -- 18% less to load, for a millisecond. Every subpath
  has a ceiling at about 2x in `dist.test.ts`'s `CEILINGS`; the barrel kept its
  640 KiB, now 1.32x.

- **An ejected component imports each sibling from its own subpath.** It was
  the barrel, and an ejected spinner importing the barrel loads every component
  to draw itself -- more than the built-in spinner it replaced. Nothing else
  about the rewrite moved: it still happens at build time because it does not
  depend on where the file lands, a sibling is still never copied, and
  `generate-registry.mjs` now refuses a sibling with no subpath of its own. "The
  registry" in `packages/cli/AGENTS.md` carries the same change.

- **A `.d.mts` per subpath, with the shared declarations in shared chunks.** The
  declaration build chunks the way the code does: `components/spinner.d.mts` is
  one import and one export list, and `MountOptions`, `StyledOptions`, `Key` and
  `PromptOptions` are each declared in exactly one file, which a test asserts. All
  the declarations went from 1,060,768 B over 50 files to 1,111,755 over 161, and
  `components.d.mts` from 363,536 B to a 21 kB list of re-exports. The website's
  options reader read that one file, so it follows a name across chunks now --
  and found on the way that `StyledOptions`, declared in the theme's chunk all
  along, had never been read: 51 component pages' list of shared options gained
  the six it brings.

- **`dist/components/` is a directory, so the readers of `dist/` recurse.** The
  subpath `./components/spinner` builds to `dist/components/spinner.mjs`, which
  is what `test/exports.test.ts` already derived from a subpath's name, and which
  reaches the chunks above it as `../x.mjs`. `staticGraph()` followed `./` only
  and would have reported a subpath as one module; it follows both now, and names
  a bundle with `/` however it was reached. `shippedModules()` beside it is every
  bundle, subdirectories included, for the checks over every shipped file -- the
  raw control characters among them, which a top-level read would have passed
  while skipping fifty-five files.

- **What this supersedes.** "The components barrel is not split per component"
  below measured a subpath per component at about 15 kB of 124 when the set was
  five components; at fifty-five, an unbundled one-spinner app pays 41% of the
  barrel's bytes through the subpath. The refusals of a `@ttylabs/sigil/qrcode`
  and a `@ttylabs/sigil/palette` subpath stand as they were written: those are
  top-level names for one component, and `components/qrcode` and
  `components/palette` are those modules' places under this rule, which add no
  name the barrel did not already export.

- **Not done.** The demos and the examples still import the barrel: the README,
  the website, `sigil new`'s scaffold and the agents block teach the subpath, and
  the toolchain's own source uses it, but a demo is about its subject rather than
  its import, and the barrel is what they were written against. Narrowing the
  barrel's module count back down -- grouping its chunks -- would move bytes onto
  every subpath, and is a measurement of its own.

### The built-in components

- **Importing `@ttylabs/sigil` loads no component, and that is now pinned rather
  than merely true.** The root entry exports `main`, `command`, `options` and the
  error handling; the parser and the help screen are reached through
  `await import()`, and the components are only ever reached through
  `@ttylabs/sigil/components`. So importing the package is 5 chunks and 4.1 KB
  against the component set's 18 and 124 KB, and a CLI that prints one line pays
  the first. It was true by _omission_, which is the kind of true that stops
  being true the day somebody adds `export * from './components/index.js'` for
  convenience and nothing says so -- measured at 130 KB when that was tried on
  purpose. `what importing the package costs` in `test/dist.test.ts` walks the
  static import graph of the built bundles, because that is the only place the
  question has an answer: a dynamic import is spelled `import(` and a static one
  is not, and the difference is the whole property. It asserts the symbols are
  _present_ from the components entry as well as absent from the root, since a
  test that only checks an absence passes forever the day the symbol is renamed.
  Class names would not do for the check: `FRAMEWORK_CSS` carries `.sigil-spinner`
  and every one of its siblings and is on the help path, so searching for the
  vocabulary finds the theme and reports the whole component set as loaded when
  none of it is.
- **And the list of symbols is one somebody has to add to, which two components had
  not been.** `IMPLEMENTATIONS` is written out rather than derived, so a component
  added without a name in it is one whose absence from the root entry is pinned by
  nothing that a rename could take away -- which is precisely the vacuity the
  presence half exists to stop, arriving through the door of the list rather than of
  the assertion. `ScrollBox` had been missing since SIG-64 and `createTypewriter`
  since it was written; a review round pointed at the file and found both. Deriving
  the list is the obvious fix and is not available: what belongs in it is one
  _implementation_ per component, and the barrel exports the state builders, the view
  functions and the types beside them, so a derived list would be asserting that
  `typewriterState` is not on the root entry -- true, and not the claim.
- **Superseded by SIG-330, under "A subpath per component" above; kept for the
  measurement it was.** **The components barrel is not split per component,
  because the components are not what it costs.** Reaching for one is 124 KB, of which the component
  implementations are 13.4 KB and the other 111 KB is the stack any single one
  needs -- `style` alone is 41 KB, then layout, canvas, element, signals,
  renderer, ansi, wrap, terminal, width. So a subpath per component saves an
  unbundled app the other components' share plus `input`, which only the prompts
  need: about 15 KB of 124, for five more entries in the exports map and five
  more ways to spell an import. A bundled app already pays nothing for it --
  rolldown shakes the barrel, measured at 84.8 KB for one component against
  97.5 KB for four. The lever that would matter is the 41 KB of `style`, which is
  SIG-81's.
- **They are element trees, and the imperative API is a facade over them.**
  `createSpinner()`, `createProgress()`, `table()` and the four prompts still
  return what they always returned, because not every CLI wants a component tree:
  a build script showing one spinner should not mount a renderer by hand, and the
  existing tests are the regression suite for the rewrite. What is behind them is
  `mountLive()` -- a renderer over an inline canvas, the framework stylesheet, a
  way to write a line above the frame, and two ways to finish. The state each one
  is driven by and the tree each one builds are exported beside the facade, so a
  component tree can use them directly.
- **What the rewrite deleted.** The spinner's `setInterval` is an effect with a
  cleanup, and the line that used to end "which is where a `steps()` keyframe
  animation goes when there is one" was half right: there is one now, and the
  spinner is still driven by that interval. The reason is under "The spinner port
  was measured and refused" -- what a spinner animates is _content_, and there is
  no animatable content property. The clip half of that sentence is gone:
  `arrangedExtent()` stops at a clipping box since SIG-130, so a sprite reel
  behind a clip no longer widens the canvas, and what is left refusing the port is
  the
  content property and the two keyframe costs recorded there. Each prompt's raw-mode handling, `data` listener, decoder, held tail and escape
  timer are the one input router's. The prompts' frame assembly and cursor
  arithmetic are layout. `padCell()` is a declared width and `text-align`, and
  `truncateCell()` is `text-overflow` -- both gone, with `truncate()` in
  `@ttylabs/sigil/wrap` as the one implementation of cutting a line.
- **Whether there is a terminal is settled at the mount and handed to the
  component, because it changes what is drawn rather than only how.** A spinner
  in a CI log has no frames to animate, so it draws none and starts no timer;
  a progress bar has no bar, so it draws a percentage rounded to `step`. The
  backend then writes the frame once per change rather than once per tick, which
  is the live region's rule reached through the canvas instead of through a
  second code path -- and the piped output is byte for byte what it was.
- **A spinner mounts on `start()` and a progress bar mounts on construction**,
  which is what each has always meant: a renderer paints its first frame as it is
  built, so mounting eagerly would put a spinner on screen that nobody started.
  `succeed()` on a spinner nobody started still mounts, because leaving its line
  is what `region.done(final)` always did.
- **A frame that ends up in a log is as wide as what it drew.** A canvas paints
  every cell it owns, so one the width of the screen ends each row with blanks out
  to the margin -- invisible on screen, and trailing whitespace in the scrollback
  once the frame is left behind. `render({ width: 'auto' })` follows the content
  instead, and `mountLive()` asks for it. The default stays the terminal's width,
  because the two costs are not the same: a canvas taller than its content
  reserves rows of screen nothing is using, which is always wrong inline, while
  one as wide as the screen merely writes blanks, which is what an app drawing a
  panel wants.
- **A component's own clock says when the state changes and the frame loop says
  when that reaches the screen.** A spinner tick is a signal write, so the frame
  it asks for is paced with everything else rather than painted from inside a
  timer. The visible consequence is up to one frame's latency on a tick, which at
  eighty milliseconds against thirty frames a second is nothing; the invisible one
  is that a test has to advance both clocks, which is why `frameMs` is an option.
- **A table's column widths are worked out and the rest is the box model.** A
  shared column width across rows is the one thing flexbox cannot do for itself:
  each row would size its own cells and no two rows would agree. So the widths are
  measured and declared, and the padding, the alignment and the truncation are
  properties.
- **A text prompt's field scrolls sideways rather than wrapping.** A canvas is a
  fixed number of columns and a field that runs past the edge is clipped there,
  where the live region wrote the string whole and let the terminal wrap it. A
  wrapped field cannot work here for a reason worth writing down: there is no
  inline layout, so the three pieces the caret splits the value into are three
  flex items, and a wrapped first item leaves the other two beside its _box_
  rather than after its last line. Scrolling is what readline does and it keeps
  the caret on screen, which wrapping in a fixed grid would not.
- **A spinner that settled or was stopped is mounted again when it is started.**
  A disposed renderer paints nothing ever again, so keeping the handle made
  `start()` after `succeed()` a call that set `spinning` to true and changed the
  screen not at all. The signals live on, so the label survives; what is rebuilt
  is the canvas and the tree.
- **A progress bar says it finished whatever `step` divides into.** Stepping the
  percentage down is what makes consecutive frames identical, and with `step: 30`
  it also made the last line `90%` -- a log whose last word is 90% is one the
  reader cannot tell from a build that stopped there.
- **A prompt's head says how it divides its row, and it still has to after
  SIG-125.** The reason it was written down for is gone -- a row's intrinsic height
  was taken with every child offered the whole content box while placement hands
  each one a share, so a question measured at the full width and placed in a share
  of it came out one line tall and a choice list was drawn over the rest of it. No
  app has to write that subtraction any more, and two reasons that were always here
  keep this one. `lines` is the first and it is not
  about the message at all: the choice list subtracts it to size its window, which
  is imperative arithmetic no layout answers. And the width is a
  `min(content, room)` **cap** rather than a share -- whatever follows the message
  has to start where the message ends, so a message that grew into the line would
  push the caret to the far edge. One column is kept back for exactly that. How
  many rows it comes to is worked out in the same place and through the same
  wrapper the text draws with, so the width and the height cannot disagree about
  it.
- **A choice list longer than the screen shows a window of itself.** A canvas is
  a fixed number of rows and what does not fit is clipped, where the live region
  wrote every line and let the terminal scroll -- which was broken in its own way,
  since the repaint then walked the cursor up into the log. The window follows the
  highlight and is recomputed from it, so there is no scroll state to keep in
  agreement: the only thing that has to be true is that the active row is on
  screen.
- **A choice list reserves the cursor's column on every row, and a blank cannot
  do it.** The inactive rows drew a `' '` where the active one drew `❯`, which
  looks like the same one column and is not: `white-space: normal` collapses a run
  of spaces, which is CSS and which this repo already records for a paragraph, so
  a text of nothing but spaces measures **zero** -- and every unselected label sat
  one column left of the selected one. Pinning it on the width of the space was
  the first answer and only the second is structural: the cursor is on every row
  and `visibility: hidden` takes it off the ones that are not active, because
  hidden content still takes its space. So the column is the cursor's own width
  rather than a guess at it, and a wider symbol cannot reopen the gap -- a
  two-column cursor is reserved as two. The text prompt's caret escaped the same
  defect by accident, since `sigil-caret` is `nowrap` and nowrap collapses
  nothing. `should start every label in the same column` is the guard, and two
  window assertions had the old spacing written into them: a test can pin a
  misalignment as readily as an alignment, which is what made this a report rather
  than a failure.
- **A choice can be disabled, a row can be a heading, and the cursor steps over
  both rather than landing and refusing (SIG-157).** `Choice` gained
  `disabled`, `description` and `short`, `choices` may hold a `separator()`, and
  `select()` took `loop` while `multiselect()` took `min` and `max`. The
  decisions that are not obvious from the code:
  - **Skipped, not refused.** A cursor you can put on a row that will not take
    it reads as a key that did nothing, so `seek()` walks to the next choice on
    offer and `initial` moves to one the same way. The walk is at most one lap,
    so a list with nothing on offer ends where it began; that list is refused up
    front with the message an empty one already had, because to the person at the
    keyboard they are the same question. Home and End go to the first and last
    choice _on offer_, not the first and last row.
  - **`disabled` is `true` or a reason, and the reason takes the hint's place.**
    A choice carrying both shows the reason, since the hint describes a choice
    that can be taken. A bare `true` says `disabled`, through `__`. A disabled
    choice is never ticked, `selected` included, and neither `a` nor `i` touches
    it -- select-all that ticked something the cursor cannot reach would leave a
    tick no key could remove.
  - **A heading starts in the cursor's column, over the labels it introduces.**
    A separator row carries the same four parts as a choice with the pointer and
    the box `display: none`, which is what puts it flush left. It is a frozen
    `{ separator }` object from a function rather than a class: a class would be
    an `instanceof` that fails across two copies of the package, and a plain
    shape is checked with `in`.
  - **A description reserves its row whether or not the highlighted choice has
    one**, and only when _some_ choice does. The multiselect's error line is
    reserved the same way for the same reason: showing one must not push the last
    choice off a canvas that is a fixed number of rows. A list where nothing
    describes itself keeps the room it had.
  - **`min` and `max` are judged at Enter and never while ticking.** Stopping the
    fourth Space at a `max` of 3 would make a tick that silently does nothing,
    and select-all would have to decide which three. `required` is `min: 1` and
    an explicit `min` beats it, so `min: 0, required: true` asks for nothing.
    One tick keeps the old message, `Choose at least one`, because translators
    already carry it; any other number is `Choose at least {0}`. Both bounds are
    _asked_ to be whole numbers rather than compared, since every comparison with
    `NaN` is false and a `max` of `NaN` would accept any number of choices and
    say nothing about it.
  - **`a` is select-all and Ctrl-A is still select-all.** Inquirer's checkbox
    spells it `a` and this file's multiselect has always spelled it Ctrl-A; both
    work, and a multiselect has no text field for a bare letter to be wanted by.
    Alt-`a` and Ctrl- or Alt-`i` are not read as either. The hint line is
    unchanged, because it is reserved at narrow widths already and a longer one
    is what `prompt.test.ts` guards against; the keys are in the README and the
    demo instead. That is a discoverability cost, paid knowingly -- and paid back
    by SIG-205, whose key footer lists `a all` and `i invert` and sheds them first
    when the row is short.
  - **Not done:** Inquirer's configurable `shortcuts` (the two keys are fixed),
    a separator that is selectable, and a `loop` on `multiselect()`'s Home and
    End, which it has never had.
  - **The demo runs piped by not being piped.** `demos/components/11-choices.js`
    is two ordinary prompts on a terminal, and with none it drives the same two
    through `createTestTerminal()` and prints the screen after each key. That
    makes it the only prompt demo `demos.test.ts` runs to exit 0 -- the other
    cannot, by the rule that a prompt with nobody to answer it fails.

- **A bracketed paste reaches a text prompt as text, with its line breaks
  flattened.** Obeying one is what makes a paste submit half an address, which is
  the whole reason a terminal brackets a paste. The other prompts register no
  paste handler, so a pasted block is typed in as keys -- which is what a terminal
  that cannot bracket one sends anyway, and what a `y` pasted into a confirm
  should mean.

#### Large text: a FIGlet renderer and the .flf format

SIG-82 asked for banner text and asked four things to be decided rather than
discovered. `src/components/large-text.ts` is the whole of it: `parseFlf()` reads
a font, `renderFiglet()` turns a string into a rectangle of characters, and
`largeTextView()` puts that rectangle in a `text`.

- **It is a component rather than a `font-size`, and that distinction is the
  ticket's own and is load bearing.** The cell size is the user's, so nothing here
  is scaled: one logical character becomes an N by M picture of ordinary cells. A
  `font-size` meaning "this string now occupies three rows" would change how many
  cells a string _consumes_, which puts the cascade in front of the layout
  engine's measure step -- every text measurement would have to resolve a style
  before it knew its own width, which nothing else in the property table does. As
  a component it is a node with an unusually tall intrinsic size, and layout
  already handles those.
- **Full smushing, not kerning first.** That is the first thing the ticket asked
  to be settled, and kerning-only was the alternative: a fraction of the work, and
  acceptable on most fonts. It is refused because the six rules are about sixty
  lines of lookup once the overlap arithmetic exists -- which kerning needs
  anyway, since kerning _is_ that arithmetic with the smush refused -- so the
  saving is small and the cost is paid twice. Shipping kerning first means every
  banner an app drew changes shape in a later release, which is worse than either
  answer on its own. A font declaring smushing is the common case: it is what the
  reference distribution's own fonts declare.
- **No font is bundled, `font` is required, and that is two decisions with two
  reasons.** The first is licensing, and it is the ticket's own instruction: the
  notices inside the fonts the FIGlet distribution ships grant permission to
  _modify_ and say nothing about redistribution, committing a font is a
  distribution decision rather than a file copy, and none of them could be
  verified as clearly permissive from here -- so no third-party `.flf` is
  committed anywhere in this repository. The second is that the look of a banner is
  the app's choice, which is the whole reason the format is supported rather than
  invented: there are hundreds of fonts written and the app drawing the masthead
  has picked one. A default would be bytes every app carries and the app that
  cares replaces.

  Measured, because the ticket asked for a number if anything is bundled and the
  number is the argument for not doing it: the font written for the demos is
  6,205 bytes of `.flf`, and as a string constant with a `blocksFont()` beside it
  `components.mjs` goes from **26,524 to 32,803 bytes** -- a quarter again on the
  one chunk every app that draws anything loads. It is nothing to a _bundled_ app,
  which shakes a constant one unreachable function names, so the cost falls
  entirely on the unbundled apps the deferral elsewhere in this file exists for.
  Required rather than defaulted means a type error rather than a surprise at run
  time. `demos/components/fonts/blocks.flf` is written here, MIT with the rest, and
  is the demo's font rather than the runtime's.

- **The parser is separable as functions and deliberately not as a subpath.**
  `parseFlf()` and `renderFiglet()` import nothing from the element tree, the
  renderer or the cascade, so a `.flf` is read and a banner is rendered with no
  component runtime anywhere and the tests for both are a plain character grid --
  which is what the ticket meant by separable. A `@ttylabs/sigil/figlet` entry was
  the alternative and is refused: it is permanent API surface whose only consumer
  is the component beside it, and what makes the parser testable is that it is a
  pure function rather than that it sits behind a module boundary. One file is
  also one `sigil add` entry, so ejecting the banner takes the format with it,
  which is what somebody ejecting it wants.
- **A `text` element rather than a `raw` one, which is the one place the ticket's
  own sketch was not followed.** It said to measure to `font.height` and paint row
  by row through `Painter.text()`, and that is reaching for the trapdoor when the
  front door works: the rows are joined with newlines into one `nowrap` `text`, so
  a `nowrap` text being one line per newline whatever room it was offered makes the
  intrinsic height the row count and the intrinsic width the widest row, the
  measurement is cached per resolved style, and `color`, `background-color` and
  `bold` inherit because each cell is still one cell. `raw` exists for a thing the
  layout engine cannot express, and a grid of ordinary single-column characters is
  precisely what a `text` expresses. It would also cost a second implementation of
  what a string measures to, and it would stop a banner being copyable --
  `selectable` defaults to false on a `raw`, which is right for a wall of block
  characters nobody wants in their clipboard and wrong for a word somebody wants
  to paste.
- **`Full_Layout` wins and `Old_Layout` is read only where the header has none.**
  That is the precedence the ticket asked to be got right and written down. It is
  the only reading that works in the case it exists for: `Old_Layout` cannot
  express the vertical rules or the fit-by-default bit at all, so in a font
  carrying both it is the lossy summary kept for drivers that predate the other.
  Intersecting them was the alternative and it is wrong in exactly that case,
  holding a modern font down to what its backwards-compatibility field could say.
  Both directions are pinned -- a full layout that says _more_ than the old one and
  one that says _less_ -- because intersecting agrees with the first and not the
  second.
- **The conversion keeps all six rule bits, not five.** `(old & 63) | 128`, because
  the format documents bit 32 of `Old_Layout` as rule 6 exactly as it documents it
  in `Full_Layout`. Masking to five is the version that looks equivalent and is
  dramatic rather than subtle: an old layout of `32` -- smush, and only two
  hardblanks -- comes out as `128`, which is _universal_ smushing and merges
  everything it meets. The bits above the sixth are the vertical rules and are read
  as nothing, which is a font setting them being a full-width font here.
- **A character one column wide never smushes, only kerns.** It is the reference
  implementation's rule, it reads like a kludge, and it is load bearing: a
  one-column `|` merged into its neighbour is simply gone. It is why `smush()`
  takes the two characters' widths rather than being a function of two columns.
- **A hardblank is a visible column everywhere except the last line of the
  render.** The ticket names the two classic bugs and they are the two ends of this:
  drawing it as a literal `$` is the first, and treating it as a space is the
  second. It is visible to the overlap scan, so a space character drawn out of
  hardblanks keeps its width through a smush -- which is what hardblanks are _for_,
  and the font a `$` was read out of is the font that decides, so a `$` in a font
  that nominated `#` is an ordinary `$`. Both halves are pinned against each other:
  the same font with its space glyph drawn out of _spaces_ loses the word gap
  entirely, which is the behaviour hardblanks exist to avoid.
- **The rules are asked in the format's own order, and the order is the whole of
  it.** Rule 6 comes first because it is the one rule a hardblank can take part in,
  and everything after it refuses a hardblank outright. The same ordering holds one
  level down, in what a merged column becomes: a blank gives way _first_, so a blank
  meeting a hardblank yields the hardblank and the hardblank survives to refuse the
  next character. Read the other way round the blank wins, the hardblank is gone,
  and the character after it lands a column early -- which takes three characters to
  see, and has a test with three characters in it.
- **Right-to-left is parsed, reported, and refused by the renderer.** A font that
  declares it throws rather than being rendered the wrong way round, which is the
  rule a property the engine ignores already follows one layer along. Mirroring the
  overlap arithmetic is contained work and it is not work to do blind: there is no
  right-to-left font here to check it against, and the obvious shortcut -- render
  the reversed string left to right -- is _not_ equivalent, because the two compose
  from opposite ends and an accumulated block's two edges are not the same edge. The
  day somebody has `ivrit.flf` is the day to write it, with that font to hand.
- **A character the font does not have is the glyph at code 0, else nothing at
  all.** The format's own answer, and the only one that does not invent a glyph the
  font's author did not draw -- a `?` or a blank the width of a space would both be
  this renderer deciding what a missing letter looks like. The lookup is by code
  point rather than by code unit, so an astral character is one miss rather than two
  halves of one that neither matches.
- **A font that stops partway is read as far as it goes.** Refusing it was the loud
  alternative and it rejects real fonts: the required range is routinely cut short,
  and the renderer already has a defined answer for a character a font lacks, so a
  font with a smaller repertoire is a usable font. What is _not_ kept is a character
  the file ran out in the middle of, because a glyph shorter than `height` would
  break the one promise the intrinsic size makes. And nothing after a cut is read as
  a code tag: a code tag only ever follows the whole required run, so what is left of
  a truncated file is the rows of the character it ran out in -- which was being read
  as a code tag, where `x@` is not a number, so a font that merely stopped early was
  refused outright. Found by the first run of the tests rather than by reasoning.
- **`Codetag_Count` is not read and `Max_Length` is not kept.** The count is
  informational and the reference implementation ignores it, so trusting it would
  stop reading early on a font whose count is wrong -- a font missing characters it
  has, for a field nothing needs. `Max_Length` is derivable from the glyphs and the
  header's value is documented as untrustworthy, so publishing it would be
  publishing a number that can be wrong about what it describes. `baseline` is kept,
  because it cannot be derived and is the one thing a caller aligning a banner
  against ordinary text needs; nothing here reads it, and the doc comment says so.
- **A glyph column is one code point, and the cheap half of that is the padding.**
  The format is a picture drawn with single-column characters, so a column is a
  character and an astral one is still a character. The expensive half is what the
  other reading costs: by code unit the join can land _between_ the halves of a
  surrogate pair, the second is smushed away, and what reaches the screen is a lone
  high surrogate no terminal can draw and no decoder can read -- which is the same
  defect the typewriter's own entry records from the other side. Pinned by a font
  whose glyph holds an astral character, which is the one shape where the two
  readings differ observably. The width the _box_ gets is `stringWidth()` rather
  than a column count, because a font drawn with wide characters is wider on screen
  than its own column arithmetic says and the box has to be the width that will be
  drawn.
- **Neither side of a join can give up more columns than it has.** The reference
  implementation caps the overlap at the arriving character's width alone, and a
  three-column blank arriving on a one-column row then slides two columns past the
  start of it. Capping at the lesser of the two is the fix, and it is what makes the
  all-blank cases answerable at all -- a space glyph drawn out of spaces collapsing
  into its neighbours is correct, and collapsing past them is not.
- **Vertical smushing and a bundled vertical answer are out, and a newline is still
  a line break.** A banner is one line, which is the ticket's own framing, and the
  five vertical rules need a notion of what a line's sub-rows are -- with the one
  that is genuinely hard, vertical line supersmushing, able to _change the height_
  of the result, which is the one number the intrinsic size promises. Refusing a
  newline outright was the other option and it is worse: a newline is ordinary
  input, so the lines are rendered and stacked with no overlap, which is predictable
  and is what a reader expects of a two-line banner.
- **The degenerate inputs were walked rather than reasoned about**, and three of
  them were defects. An empty file, another signature, a signature with nothing
  after it, a hardblank that is a space, a hardblank that is a control character,
  fewer than five numbers, a height that is `0`, `-1`, `3.5`, `six`, `0x3`, twenty digits long or
  absent, a negative comment count, a comment count that overruns the file, a print
  direction that is neither `0` nor `1`, a full layout that is not a number, a code
  tag that is not a number, a code tag in each of the three bases and signed either
  way, a code tag whose glyph rows the file ran out of, a blank line between code
  tags, a `Codetag_Count` that lies, a `Max_Length` that lies, a character whose
  rows disagree in width, a row of nothing but endmarks, a font that stops at `A`, a
  font that stops after ASCII 126, a font with no characters in it at all, a byte
  order mark, CRLF, and a file written with carriage returns alone. The three that
  were wrong: a truncated font was refused rather than tolerated (the entry above),
  the old-layout mask dropped rule 6, and the file's own final newline was being
  read as the last row of a glyph wherever the character before it was short.
- **A font with whitespace after its endmark is a font this cannot read, and that
  is said rather than guessed around.** The format's rule is that the last character
  of the line is the endmark and the whole trailing run of it comes off; with a
  space there, the run that comes off is the glyph's own right-hand padding. It is a
  font the reference implementation cannot read either, and guessing which of the
  two trailing runs was meant is a heuristic that is wrong about the next font.
- **Two sabotages survive out of sixty-four, and both are declared.** The visibility
  bound in `rowOverlap()` is a _bounds_ guard rather than a behaviour one: deleting
  it changes no answer, because the global cap is tighter than the inflated distance
  a phantom column produces, and what it buys is not reading past the end of a row
  and relying on an argument three functions away. The `?? right` in `combine()` is
  unreachable by construction -- the overlap is only ever taken at a distance where
  every visible pair smushes, and at that distance there is exactly one such pair,
  because any other would need a visible column further in than its own last one --
  so it is the type's answer, and it is `right` because that is what universal
  smushing does. Four guards were deleted for failing the pass: a padding branch
  that `repeat(0)` already answered, an early return in `stripEndmark()` that the
  loop below it already answered, an `outWidth === 0` case the cap already answered,
  and a `Math.max(0, ...)` over a value that cannot be negative.
- **One mutation came back a survivor and was the harness being blunt rather than
  the guard being dead**, which is the second of the two failures this file records
  about the method. `readInt()`'s pattern was weakened from `\d+` to `[\d.]+`, and
  that survived -- because `3.5` then reaches `Number.isSafeInteger()`, which refuses
  it. The two guards overlap and neither is redundant: the pattern is the only thing
  that refuses `''`, whitespace, `1e3` and `0x10`, where `Number()` answers `0`, `0`,
  `1000` and `16`, and the safe-integer check is the only thing that refuses `3.5`
  and a twenty-digit field. Weakened to `\w*` instead -- which admits `0x10` and
  nothing the other guard covers -- it is caught. The lesson is the one already
  written down: a mutation that another guard answers for says nothing about the one
  it was aimed at, so the mutation has to be the input that only that guard
  refuses.
- **And the pass found a literal U+FEFF in the source, which `sources.test.ts`
  cannot see.** That file checks C0, `DEL` and C1, and a byte order mark is a
  _format_ character rather than a control one -- so an invisible character sat in
  `src/` and in the test beside it, in the one line whose job is to strip a byte
  order mark, which is the shape this file already records twice. Both are
  `\uFEFF` escapes now -- and that sentence held a **literal** one for as long
  as it existed, which is the fourth instance and the one that makes the point:
  the paragraph recording the hazard was an example of it, invisibly, in the
  one file somebody reads to find out about it. `test/sources.test.ts` refuses
  a byte order mark anywhere in a tracked file now; `oxlint`'s
  `no-irregular-whitespace` is what found this one, in the `@ttylabs/config-xml`
  work, after the same lint had found four more in that package's comments. Widening the check to `\p{Cc}` plus `\p{Cf}` is the obvious
  follow-up and is deliberately not taken here: the repository has two legitimate
  U+200D characters, in `packages/sigil/README.md` and in
  `test/components/typewriter.test.ts`, where they are the joiners inside emoji
  sequences -- so the check needs an allow-list, which is a decision about that test
  rather than about this feature.

#### A typewriter: text that arrives a chunk at a time

SIG-83 asked for text that arrives rather than appears, and asked first whether
it is a component or an animation primitive. It is a component, and the reason
was already written down one section up: what it steps is _content_, and there is
no animatable content property. `src/components/typewriter.ts` is the whole of
it.

- **The "no content property" argument was checked against the code rather than
  taken from the spinner's entry, and it holds in four places.** `content` is not
  in `PROPERTIES` at all, and the property table is the single source of truth.
  `ANIMATABLE_PROPERTIES` is `PROPERTY_NAMES` filtered, so an animation cannot
  name anything the table does not have. `transition-property` throws
  `no such property` for a name outside it. And `src/style/animate.ts` mentions
  neither `setText` nor `displayText`: what an animation produces is a _presented
  style_, which is the one thing it can produce. So `steps()` over a `@keyframes`
  can step a number of cells, a colour or a keyword, and "how many graphemes are
  visible" is none of those. A content property would have to carry the text, be
  interpolated, be degraded and be invalidated, which is a property table entry
  whose value is a string the layout re-measures -- and the entry above already
  refuses it for the spinner.
- **The ticket's three reasons for not animating `width` are two reasons, and the
  one that decides it is measured.** Clipping has landed since the ticket was
  filed (SIG-64, and SIG-130 made `arrangedExtent()` stop at a clipping box), so
  that third reason is stale. What remains was measured on a real sweep -- a
  `text` at its natural width inside an `overflow: hidden` box whose own width
  steps one column at a time:

  **A column sweep reveals every row at once.** At a clip of one column a
  paragraph wrapped into two rows comes out `"a\nd"` -- the first column of row
  one _and_ the first column of row two. At three columns it is `"aaa\nddd"`, so
  the last word of the paragraph is fully on screen while the second word is not
  there at all. That is not a typewriter by any reading, and nothing about the
  sweep can be told to go line by line.

  **And the wide-cluster reason is real but smaller than the ticket says.** The
  ticket says a column sweep "shows half a glyph -- exactly the state the canvas
  diff works to prevent", and the measurement says the canvas does in fact prevent
  it: a two-column cluster with one column left is refused and a blank takes the
  column, which is `CellBuffer.inside()`'s own rule. So at a clip of one column a
  family emoji draws _nothing_, and at two it draws whole. What a sweep actually
  produces is a reveal whose steps and whose glyph boundaries disagree -- a step in
  which the screen does not change -- rather than a corrupted cell. Worth
  correcting rather than repeating, because a reader who trusted the stronger claim
  would go looking for a half-drawn glyph that the grid cannot produce.

  Revealing by cluster makes all of it fall out instead of needing handling: a ZWJ
  family, a flag, a keycap, a combining mark and a Devanagari spacing mark are one
  cluster each, so each is one step, and `revealSteps()` is asserted never to split
  any of them.

- **The position is an offset into the text, not a count of chunks, and that is
  what makes a text change cheap.** A count would have to round back to a chunk
  boundary whenever the chunking moved, and the chunking moves on an ordinary
  append: by word, `hel` then `hello` turns one chunk into another; by grapheme,
  typing a combining mark onto an `a` that is already on screen makes the two one
  cluster two code units long. Rounding back re-reveals what was already on screen,
  which is a stutter on every token a stream appends. An offset survives it, and it
  is moved forward to the end of the step it fell inside the moment anything puts it
  there. The first version gave up on such a position instead, and stalled the reveal
  for the rest of the process; `should not stall when a chunk boundary stops being
  one` is the guard.
- **And the snap is to any step rather than to the first, because a swap can leave
  the position mid-cluster anywhere.** It was written as a special case for the first
  step, which is where the combining mark puts it, and a review round found the other
  shape: swapping one emoji for another leaves the position on the **surrogate the
  two share**, which is a boundary of neither text. Measured, that drew a lone high
  surrogate for one frame before the next step repaired it -- `"x\u{1F600}"` fully
  revealed, then `"x\u{1F601}"`, and the frame came out `x\ud83d`. Forward rather
  than back, because back takes something off the screen that was already on it;
  what forward costs is at most one chunk revealed early, on a text change where the
  content has moved anyway. One rule where there were two, and the first-step case
  falls out of it. `should never leave half a cluster on screen` is the guard, and the
  first-step spelling fails it.
- **A text change keeps as much as the new text still says, which is
  "continue from the common prefix" with the prefix taken on the _text_.** The
  three candidates were restart, continue, and snap. Restarting retypes the whole
  answer on every token a stream appends, which is the case the component is
  first described by; snapping throws away the effect. So the position is clamped
  to the characters the old and new text share: appending continues from where it
  had got to, a divergence re-reveals from the point the two part, and a shorter
  text clamps back. The prefix is of the text rather than of the chunk list for the
  reason above -- a chunk list's own prefix is not stable under an append.
- **The chunker decides where the steps land and the string decides what is
  shown.** That is what makes any chunker safe to pass, including a caller's own: a
  chunk running past the end is clamped, one that adds nothing is dropped, and a
  chunker that loses characters -- or returns nothing at all -- still ends with the
  whole string revealed, because the last step is forced to the end. Without that a
  lossy chunker strands the reveal one character short with the cursor still on,
  which looks like a hung animation rather than like a chunker with a bug in it. Each
  step's chunk is sliced out of the string rather than taken from the chunker, so
  what `Pace` is shown is what reached the screen.
- **Whitespace travels forward, in both chunkers.** `byWord()` puts the whitespace
  in front of the word it belongs to and `byLine()` puts the break in front of the
  line it opens. A space on its own is a step in which the screen does not change,
  which reads as a dropped frame rather than as typing -- and a break revealed at
  the _end_ of a line leaves the cursor dangling on an empty row for one step, where
  a break revealed with the line it opens leaves it where the text just stopped. One
  rule rather than one per chunker.
- **What that buys is a `byWord()` chunk that is never whitespace alone, and it is
  not the same claim about `byLine()`.** A review round caught the overclaim: a
  blank line is a chunk of exactly `"\n"`, so `byLine('a\n\nb')` is
  `['a', '\n', '\nb']` and the middle chunk is whitespace while the text has words
  in it. That is right rather than an exception -- a bare break reveals a blank
  **line**, which is a row appearing, where a bare space reveals nothing at all --
  and `should keep a blank line as its own chunk` is what pins it. Text with no word
  in it at all is one chunk under either, because there is nothing for its
  whitespace to travel to.
- **There is no `byGrapheme`, because `graphemes()` is already it.** It is the
  default chunker and it is exported from `@ttylabs/sigil/width`; a second name for
  one function is how the two come to disagree, which is the rule
  `COLOR_PROPERTIES` and `readRoutes()` already follow. What that costs is
  discoverability from the components barrel, and it is paid by the default being
  the one nobody has to name.

##### The cursor is a character in the text, and that was measured

- **A caret beside the text lands at the end of its _first_ row.** The prompt
  draws its caret as reverse video over a grapheme cluster, and the ticket points
  at it -- but there is no inline layout here, so a caret beside a `text` is a
  second flex item placed beside that text's **box**. Measured: a caret after a
  paragraph wrapped into two rows comes out `hello there world_` / `again friend`,
  which is the AGENTS.md rule the prompt's own field records, arriving one
  component along.
- **Three designs were built and measured before one was kept.** A `paragraph()`
  with the caret as one more word item places it correctly on the last row -- and
  a `column-gap: 1` then sits between the last word and it, so the cursor is one
  column off the write head. Cancelling that with `margin-left: -1` is exact
  everywhere except an exactly-full line, where the item wraps and is pulled to
  `x = -1`: measured, the cursor **disappears** for the two frames per line where
  the line is full. Gluing the caret to the last word by giving the two one item
  fixes that and is correct at every reveal length -- and then misplaces inside an
  over-long word, because the pair's own text wraps and the caret is beside _its_
  box: measured, `super#` / `cal` where the write head is after `al`.
- **So the cursor is a glyph appended to the revealed string, which is right in
  every case there is.** It wraps with the text, it follows the last character
  through a broken over-long word, and it moves to a new row when the row it was
  on filled up -- all measured at every reveal length of a wrapping paragraph, of
  an over-long word, and of text with newlines in it. With no cursor the view
  renders byte for byte what a bare `text` renders, which is the non-regression.
- **What it costs is a class of its own, and what it buys back is colour level 0.** A theme cannot colour the cursor apart from the text, which is a real loss
  and the reason the other two designs were built first. Against it: at level 0
  every attribute is dropped, so the prompt's reverse-video caret is deliberately
  not drawn there at all -- measured, a `.sigil-caret` space comes out as nothing
  -- while a glyph survives `NO_COLOR`. A bug beats a missing feature, and a caret
  in the wrong place is the bug.
- **Which is also why the cursor must be a visible glyph.** A space is not one: a
  `text` of nothing but spaces measures zero at `white-space: normal`, which is the
  defect the choice list's pointer column already records, so a space cursor would
  draw nothing unless it carried `nowrap` and an attribute. That is pinned rather
  than left to be discovered, beside the cases that do work -- a wide cluster, a
  flag, and a cursor of more than one character. `cursor` is a `string`
  rather than a `boolean | string` for the reason `MediaContext.keyword` is a field
  of its own: nothing downstream should have to ask which of two types it was
  handed.
- **It is drawn only while there is more to reveal.** The write head is where the
  next character goes and a finished line has no next character -- which is also
  what keeps a cursor out of the log, and out of the whole text a pipe gets.
- **It does not blink, and that is the frame loop's rule rather than taste.** A
  blink is a second timer with a period of its own, running _after_ the reveal has
  finished, which contradicts "no timer when nothing is revealing" -- a rule the
  ticket itself lists. It is also motion, so it would have to be suppressed under
  a reduced-motion opt-out as well, which means the cursor's appearance would
  depend on a preference nobody connected it to.

##### The pace is the caller's, and the four frame-loop rules

- **`pace(chunk, index)` is how long that chunk is _held_, and a flat interval is
  the default.** The three candidates the ticket names are a constant, a built-in
  with punctuation pauses and jitter, and a curve the caller supplies; building all
  three is what it asks not to do. The curve wins on two arguments. The component
  cannot know the language or the content: a pause after `.` is wrong for `3.14`,
  for `index.ts`, for a file path and for an ellipsis, so a built-in rule is wrong
  for the text the caller actually has -- and `pace: (c) => (c.endsWith('.') ? 400 :
  40)` is the whole feature in the caller's hands. And jitter needs randomness,
  which makes the component non-deterministic: a test that depends on
  `Math.random()` is the same flakiness an injectable clock exists to prevent, and
  a caller who wants jitter supplies a seeded generator.
- **Held _after_ rather than waited _before_, so the first chunk lands on the
  first frame.** A typewriter showing an empty line for an interval before it
  starts reads as a stall, and the after-reading is what makes a punctuation pause
  expressible as a property of the chunk that ends with the full stop rather than
  of the one after it. The consequence worth knowing is that the last chunk's delay
  is never asked for, which is asserted.
- **A pace that answers with nothing usable is read as the interval.** `NaN` would
  schedule immediately and reveal the whole text in one macrotask, which is the one
  failure that looks like the feature being broken rather than like a bad return
  value. A _negative_ one is passed through: `setTimeout` documents a delay under 1
  as 1, so a `Math.max(0, ...)` here was this file saying what the host already
  says, and it failed its sabotage for exactly that reason. The contract is still
  asserted; it is simply kept somewhere else.
- **Every delay is taken when the steps are, because the timer must run no caller
  code at all.** `pace` is the caller's, and the first version called it from inside
  the `setTimeout` -- where a throw is an **uncaught exception**: node prints a stack
  and the process goes, which skips the renderer's teardown and is the opposite of
  the rule that a CLI shows a message rather than a stack. Proved both ways with real
  timers before it was changed, with a pace that starts throwing fifteen
  milliseconds in: from inside the timer the reveal stopped four characters into a
  ten-character string and the throw escaped as an unhandled error, and with the
  delays taken up front the same pace is asked nine times at chunk time and the
  reveal finishes. This is `until()`'s own rule one component along -- a predicate
  that throws ends its own probe, not the process -- reached by moving the caller's
  code into the effect body, where a throw is reported by the machinery that already
  answers for a component that throws. Found by walking the degenerate inputs rather
  than by a test, so `should ask the pace nothing from inside a timer` asserts the
  structural property and its sibling asserts where the error goes. What it costs is
  `steps.length - 1` calls per text change rather than one per step, which is the
  order the chunking already is. The last chunk is skipped rather than computed and
  ignored, because the delay before a chunk is the one in front of it earned -- so a
  caller counting the calls sees the number it should.
- **And the position is settled before any of the caller's code runs, which is the
  other half of the same ordering.** The effect used to compute where to go from a
  position read _before_ `pace`, and then write it -- so a `skip()` from inside a
  `pace` was set and immediately written back over, and the reveal carried on typing.
  Nobody writes that on purpose, and it is the general shape that matters: read, run
  the caller's code, write the stale value. The write moved above the delay loop, so
  the caller is the last word rather than the first, and `should let a pace that
  moves the position have the last word` fails if the two swap back. Found by review.
- **An interval has to be a number `setTimeout` can wait for, and `Infinity` is
  not.** `Infinity >= 0` is true, and node reads a delay past 2^31-1 as 1 -- so
  `interval: Infinity` asked for "never" and got "as fast as possible", while `NaN`
  already fell back to the default through the same comparison. `Number.isFinite`
  makes it one question rather than two answers to it. Found by review, and the kind
  of asymmetry a guard acquires when it is written for the input somebody reported.
- **No timer when nothing is revealing.** The last chunk schedules nothing, so a
  finished typewriter holds no timer, and a reveal that cannot animate starts none
  at all. **The timer is unref'd**, because a program that has finished should exit
  even if somebody forgot to stop it. **The clock is the timer**, and there is
  deliberately no `now` to inject: nothing here measures elapsed time, it only
  schedules, so fake timers are the whole of what a test needs -- where the animator
  has a `now` precisely because it computes how far through a duration it is. An
  option nothing needs is an option designed by guessing, which is the rule `which`
  waited eighteen months for a caller over.
- **The step reads where the reveal has got to at fire time rather than
  capturing it.** A `skip()` while a timer is in flight would otherwise be undone
  by it: the pending step writes a position _behind_ the one the skip reached and
  the text comes back off the screen. The test for that was vacuous in its first
  version and is the entry under the sabotage pass below.
- **The whole string arrives at once in a pipe, in a CI log, and under a
  reduced-motion opt-out, which is one question rather than three.**
  `mountLive()` now hands the build what the _renderer_ resolved, because the
  renderer's `motion()` is the only thing that folds the three sources together --
  the caller's, `SIGIL_REDUCED_MOTION`, and whether there is a screen at all. A
  component asking those three for itself would be a second reader of one rule,
  which is how the two come to disagree about whether a pipe animates. `render()`
  sets `cascade.media` before it runs the component, so the mount holds the cascade
  it built and reads the answer off it; the build callback's second parameter is
  additive, so the spinner, the bar and the prompts were not touched.
- **And it is a function rather than a boolean, which is what makes `done()`
  finish the reveal.** `animate` is read on every run and is gated on the
  typewriter running, so turning it off _is_ the way a reveal ends -- rather than
  `done()` writing the position itself, which would be a second answer to "how
  does a reveal finish" and did in fact disagree: the first version set the
  position and then let the effect re-run over the new text `done()` had been
  handed, which clamped back to the common prefix and left a **truncated** line in
  the log. `should leave the text done() was handed, whole` is the guard.

##### Interruption is a method, not a key

- **`skip()` is the mechanism and the gesture is the app's.** A keypress skipping
  to the end is the right gesture and it does not belong here: the components are
  reachable with no router at all -- `renderToString()` of this one works, and most
  of its tests are written that way -- so a design that _required_ one would narrow
  the component to apps that have a focus ring. An app with a router binds a key to
  `skip()` in one line, which is the same split the scroll box keeps between a
  `scrollTo()` and the key that calls it.
- **`done()` reveals the rest and leaves the line; `stop()` erases.** Which is the
  progress bar's pair, for the progress bar's reasons. `skip()` differs from
  `done()` in that it keeps the typewriter mounted, because a stream may append
  more afterwards -- and it does, which is asserted.

##### What the view does not carry

- **There is no width option, and one was written and deleted for failing its
  sabotage.** A `max-width` of the terminal's looked necessary: an inline canvas
  follows its content, so an auto measure of one long line reads like a canvas two
  thousand columns wide. It is not, and the renderer is why -- `layoutInto()`
  measures an auto-width canvas at `terminal.width` and caps it there, and
  `renderToString()` lays out at the width it was given. Both paths were already
  bounded, the sabotage proved it, and the option was a knob that did nothing.
- **What is not redundant is `min-width: 0` on the text.** The canvas is capped
  either way, so without it a word longer than the terminal keeps its own width and
  is cut off at the canvas edge rather than broken -- which is the rule
  `paragraph()` gives its own words and the reason it gives it. Both halves are
  pinned, one in the view and one through a mounted canvas six columns wide.
- **Two classes and no rule for either.** `.sigil-typewriter` and
  `.sigil-typewriter-text` join the vocabulary comment in `FRAMEWORK_CSS` and get
  no declaration, because there is no colour a typewriter has by default: the text
  is the app's. A class with no rule is still a hook, and giving it an empty rule
  would be a declaration that says nothing. The cursor has no class of its own,
  because it is a character in the text rather than an element -- the entry above is
  why, and `.sigil-typewriter .sigil-caret` is what a caller who wants the prompt's
  caret here would have had to write.

##### The clamp that looked dead and was not

- **`shownOf()` is one function because two readers of one clamp is how the two come
  to disagree**, and the clamp itself is the entry worth keeping: `String.slice`
  reads a negative end as an offset from the **far** end, so `'abc'.slice(0, -1)` is
  `'ab'` -- every character but the last, from a position that means nothing is on
  screen. `revealed` is a public signal an app building its own tree writes, so that
  is reachable rather than theoretical.
- **The first test for it used `-5` and survived its sabotage, because `-5` is the
  one kind of negative where `slice` agrees.** A position past `-length` clamps to
  nothing by itself; only `-1` through `-length` differ. That is the
  fixture-too-easy shape this file records under the animator's `isFinite` guard,
  met again: the sabotage was sound and the fixture could not reach the state that
  makes the guard matter.
- **And the other half of the same clamp really is dead.** `Math.min(value.length,
  at)` changes nothing, because `slice` clamps an end past the string and so the
  length of what comes back is clamped too -- which is the whole of what the cursor
  gate asks about. Deleted, after its own sabotage survived.

> Moved: _What the sabotage pass found_ — see [docs/history/the-built-in-components.md](../../../../docs/history/the-built-in-components.md).

#### What is deliberately out

- **A blinking cursor**, for the reason under the cursor above: a second timer
  running after the reveal has finished.
- **Built-in punctuation pauses and jitter**, with the curve in their place and the
  reason above. A caller gets both in one expression and the component stays
  deterministic.
- **A key binding for `skip()`**, because a component that needs a router is a
  component an app without one cannot draw.
- **Per-chunk styling.** A chunk that arrives in its own colour would make the view
  a `paragraph()` of styled runs rather than one `text`, and then the cursor is back
  to being a flex item beside a box -- which is the measurement this whole design
  came out of. The day somebody wants it, it wants the inline-layout answer rather
  than a second cursor rule.
- **A `now` to inject**, for the reason under the frame-loop rules: nothing here
  measures elapsed time.
- **Noticing that the media context moved after it mounted.** `moving` is read once,
  from what `mountLive()` hands the build, so a terminal that _stops_ being one
  mid-reveal -- a pipe whose far end goes, which sets `closed` and makes `motion()`
  answer `reduce` -- does not collapse the reveal. Measured: it runs to the end at
  its own pace, writing to a stream that swallows it, and holds no timer afterwards.
  So it is bounded, invisible and finite, which is the whole reason it is left: the
  animator needed `touchMedia()` because an infinite animation kept the frame loop
  awake for the life of the process, and a reveal ends. It is also exactly what the
  spinner does with the same `live` flag, so fixing it here alone would be one
  component disagreeing with its neighbour about a question `mountLive()` answers for
  both. The shape of a fix is `touchMedia()`'s and it wants a second caller before it
  is worth a change to what the mount promises.

#### A decrypt effect: masking text that already knows what it says

The Sneakers/CSI effect, as in `bartobri/no-more-secrets`: every non-whitespace
cell becomes a random glyph, the block jumbles for a couple of seconds, and then
each cell resolves at its own random moment over the next few.
`src/components/decrypt.ts` is the whole of it -- a plan, a frame function, a
driver and a facade -- and it needed nothing from the canvas, which is the reason
it is a component rather than the frame effect SIG-103 is.

- **Nothing is ever read back off a grid, which is what makes this not a canvas
  feature.** The general version snapshots what was painted, paints something
  derived from it and ramps a mask over it, which needs transparency and
  compositing and is deliberately v2. This component already holds the true text,
  so which cells are showing their own character is a function of the text, each
  cell's reveal time and how far through it is. `decryptPlan()` and
  `decryptFrameAt()` are that function and they are where every assertion about the
  effect lives -- no renderer, no terminal, no timers.

  Not **pure**, which is the one word the ticket's phrasing invites and which would
  be wrong: a hidden cell draws a _fresh_ glyph on every call, which is what makes
  the jumble move, and `should re-randomize a hidden cell on every call` asserts
  exactly that. They are deterministic given a generator, which is the property a
  test needs and is what the injectable RNG buys. What the ticket's sentence is
  really about is the half that does hold unconditionally -- nothing is read back
  off a grid, because the component is holding the answer.

- **Whitespace is never masked, and it is the single detail the effect rests
  on.** The spaces, the indentation and the line breaks stay where they are, so
  the _shape_ of the text is legible from the first frame while not one word of it
  is. Masking them gives a rectangle of noise, which is a screensaver. `\s` rather
  than a list of the ones a terminal is likely to see, because a non-breaking
  space and an ideographic space hold a line's shape exactly as an ordinary one
  does.
- **A substitute is as wide as what it hides, and a zero-width cluster is never
  hidden at all.** A one-column glyph over a two-column CJK character leaves a
  hole and shifts every cell to its right for the whole animation, so the text
  visibly reflows as it decrypts and lands back where it started -- which is the
  one thing nms gets to take for granted, because it masks a terminal that has
  already laid the text out. The width comes from `cellWidth()`, which is the rule
  `CellBuffer.fill()` already follows when it steps by what its cluster consumes.
  The second half is that rule taken to its end: a combining mark on its own has
  no cell, so a one-column glyph over it would _add_ a column. Asserted as a
  property rather than by example -- `stringWidth()` of every line of every frame,
  over all three alphabets, across a forty-step sweep that runs past the end.
- **A mask entry is a string of the right width rather than one glyph, and that
  is what lets an ASCII set exist.** Measured before anything was written: **every
  CP437 graphic character is one column**, so there is no wide CP437 glyph to
  reach for, and no printable ASCII character is two columns either. So
  `MaskAlphabet.wide` holds two-column _strings_: the default's are the fullwidth
  Latin forms, which are the narrow half's answer in the width a wide cell needs
  and are present wherever the characters they hide are, and `ASCII`'s are pairs.
  The default could have used pairs too and does not, because one glyph per cell
  reads as one character being hidden where two read as two.
- **Two alphabets, as the spinner has two frame sets.** `CP437` is what nms masks
  with and what looks right; `ASCII` is for a terminal that cannot be trusted with
  anything else. `DOTS` and `LINE` is the precedent down to the shape of the
  decision.
- **An empty alphabet half falls back to the default's, per half.** `pick()` over
  an empty list answers `undefined`, which reaches the screen as the _word_ rather
  than as a glyph -- so a caller with narrow glyphs and no wide ones gets the
  default's wide ones rather than `undefined` where a CJK character was.
- **The RNG is injectable and whatever it answers is clamped.** Every visible
  property of this component comes out of it, so without a seed there is nothing to
  assert. The clamp is load bearing in both directions and is the one guard this
  component could not do without: a value above one puts a cell's reveal time past
  the end of the window, so `await decrypt(text)` **never resolves**, and a
  negative one resolves a cell during the jumble. `NaN` is read as zero rather
  than propagated, because every comparison against it is false -- so a cell whose
  reveal time was `NaN` would be both never resolved and never past its time. It
  is clamped to `[0, 1]` _inclusive_, which `pick()` is written to take, because a
  reveal time of exactly the window end should resolve at the window end.
  `seeded()` ships because a component whose documentation says the randomness is
  injectable should carry the thing to inject -- xorshift32, which is the generator
  the layout fuzzer already uses, so there is one algorithm here rather than two,
  and reaching for a package would break the zero-dependency rule.
- **Styled input is stripped and restyled, and the rejected option does not
  work at all.** This is the question the ticket said to settle first, and it was
  settled by measuring rather than by preference: **an element's text cannot carry
  a sequence.** `toDisplayText()` removes the `ESC` as a control character and
  leaves `[31m` printable, so `ESC[31mred` renders as `[31mred` -- measured through
  `renderToString()`, twice, before a line of the component was written. So
  "track the state and re-emit it per frame" puts the _parameters_ of every
  sequence on screen as text rather than putting colour on anything. The ticket's
  premise is what had gone stale: every component used to build a string and hand
  it to a `LiveRegion`, and since the component rewrite the spinner, the progress
  bar and the typewriter all draw through `mountLive()` over a canvas, where
  styling is a style per cell.

  Carrying it _properly_ means an element per run of same-styled cells plus a new
  **SGR-to-`Style` decoder**, and that is a third SGR table beside the styler's
  `reopen()` and the wrapper's `sgr-state.ts` -- which this file records as kept
  separate deliberately, and which would here be a _reverse_ mapping nothing else
  in the library needs. The decoder is what is refused; the elements are not, and
  the entry below is what they turned out to be. What cannot be done with **texts**
  still cannot: three in a row are three flex items placed beside each other's
  **boxes**, so a run that wraps leaves the next one beside its first row, which is
  the typewriter's own recorded reason for using one `text` element -- and stacking
  two of them over one rectangle does not rescue it, because a blank paints a blank
  and the upper one erases the lower, measured as `x x` over `ABC` coming back as
  `x x` rather than `xBC`. Transparency is still SIG-103's. A `raw` is the way
  round it and the reason it is the way round it is that it **skips** the cells it
  does not want, which is what `Dots` and `Pixels` already rely on to sit over
  something somebody else drew.

  So `sgr-state.ts` is **not** imported, and the sharper finding is that it would
  have been the wrong module for the route the ticket recommended anyway. Its job
  is to reconstruct what was in effect at a _break_; masking breaks nothing -- it
  is a one-for-one substitution per cell, so every sequence stays exactly where it
  was relative to the clusters around it. What that route needs is `tokenize()`,
  which is what neither `graphemes()` nor `strip()` can do on its own. The one
  reused is `strip()`, which is what `stringWidth()` already does to its input.

  Nothing else is sanitized, so what a finished animation leaves behind is what it
  was given: a stray control character, a lone surrogate and a CRLF are drawn the
  way the cells say, exactly as for every other component -- and making that true of
  a **tab** took a fix rather than a sentence. The layers paint the plan's own cells,
  so what a cell holds has to be what any other text in this library would draw, and
  a tab is `cellWidth()` zero: the first version of the two layers drew **nothing**
  for one, so `a\tb` came out `ab` where an ordinary `text` draws `a b`. That was
  defensible on its own terms -- a cell of no width has no column to paint in, which
  is what the plan already said by never hiding it -- and it is still the decrypt
  being the one text in the library that disagrees about what a tab is, which is the
  worse of the two costs. The grid models no tab stops precisely so that one answer
  can be shared, and `toDisplayText()` is exported so anything measuring what will be
  drawn can reach it. So `said()` normalises with `strip()` and then
  `toDisplayText()` -- in that order, because stripping second would leave an ESC's
  parameters behind as text, which is the failure the styled-input decision above
  exists for -- and the plan holds a space of width one. `should say what an ordinary
  text says` pins the pairing against the function rather than against a literal, so
  the two cannot drift. What this costs is that the final frame is what the text
  _says_ rather than the argument it was handed, which the plan's own `strip()` had
  already made true for a sequence; `should end at exactly what it says` is that
  assertion renamed to what it checks.

- **The colour is per cell, and two `raw` layers over one rectangle are how.** The
  cipher layer draws the cells that are still hidden and the plain layer draws the
  ones that have resolved, so each carries its own class and resolves its own style
  -- and a character takes the plaintext's colour **the moment it lands** rather
  than when the last one does. That is the scroll bar's own shape, and its own
  recorded reason is this one word for word: the track and the thumb are two
  elements because one element cannot resolve two styles. `.sigil-decrypt-cipher` is `dim` in
  `FRAMEWORK_CSS` with the light half on `gray`, which is where
  `.sigil-decrypt-text.is-masked` used to be and is why nothing about the default
  look moved: the last frame has no cipher cells in it, so a finished decrypt is
  what it always was. `.sigil-decrypt-plain` carries no default, for the reason the
  spinner's text does not.

  The ticket's "optionally in a colour" per _cell_ was written off against the
  per-run **text** elements, and the layout reason it was written off for is still
  true of texts and never applied to a `raw`: a `raw` paints its own cells and
  **skips** the ones it does not want, so the two layers never erase each other and
  there is nothing for transparency to do. The one-element view is gone and so is
  `is-masked`, which the per-cell split subsumes -- a block-level hook with no rule
  behind it would be a class for somebody to wonder about.

- **The cipher layer is the one in flow, and that asymmetry is load bearing.** An
  `absolute` box takes no space and `measureUncached()` filters it out of what its
  parent measures, so something has to say how big the block is -- which is the
  layer whose cells are the text's own widths. The plain layer is `absolute` with
  all four insets, so it fills the same rectangle and reserves nothing, exactly as
  the track and the thumb do, and `.sigil-decrypt` carries the `position: relative`
  that gives those insets a containing block.

  It paints at the **cipher's** box rather than at its own, which reads like a
  detail and is what keeps the two in register: insets resolve against the host's
  _padding_ box while the cipher sits inside the host's padding, so a
  `.sigil-decrypt { padding: 1 }` an app writes would otherwise put every resolved
  character a column left of the cipher it replaces. Reading the boxes of the frame
  it is in is what a `raw` is for, and it is what the scroll thumb already does with
  its viewport.

- **The frame carries cells, because only the frame function knows which is
  which.** `DecryptFrame.lines` is a `DecryptFrameCell` per cluster -- what is
  drawn, whether that is a mask, and how many columns it takes -- built by
  `decryptFrameAt()` while it is deciding, beside the `text` it already produced.
  `text` stays rather than being derived by every reader: it is what the
  no-terminal path writes in one go and what most of this component's assertions
  are written on. `decryptedFrame(text)` is the frame with nothing hidden, which is
  what `decryptState()` starts at and what the no-terminal path sets -- one builder
  rather than a second path that has to agree with this one.

  What that costs is a cell per cluster on the path that does **not** animate,
  which the old comment there was written to avoid. The comment is now half true
  and says so: a pipe still neither draws from the generator nor works out a reveal
  time, and it does build the cells, because the view draws cells and a frame with
  none of them is one it cannot draw.

- **The component wraps its own cells, and the two layers agreeing is what makes
  that safe.** A `text` element wraps a string and that is what the one-element
  view got for nothing. A cell is not a cluster -- `ASCII.wide` hides a two-column
  character with _two_ narrow glyphs -- so there is no cluster-to-cell
  correspondence to map `wrap()`'s answer back through, and the wrap is therefore
  `placeCells()`'s. What matters far more than agreeing with `wrap()` is that the
  two layers agree with **each other**, and that is structural rather than careful:
  one function decides where every cell landed and both layers read it.

  It keeps `wrap()`'s rules anyway, because a block that broke somewhere else from
  the rest of the library is a surprise nobody asked for, and it is a
  **differential** rather than a rule said twice: `should wrap where the wrapper
  does` renders seven texts at nine widths and compares against `wrap()` itself,
  with each line's trailing blanks dropped because the renderer drops them -- which
  is the one place the two legitimately differ, since `wrap()` leaves an indent on
  a line of its own where the word after it could not fit and a row of spaces and
  an empty row are the same row on screen.

  Which **break opportunities** there are is asked of the plan rather than of what
  is drawn -- a hidden cell is never whitespace, so `hidden` settles it before the
  text is looked at. That is what makes the breaks a function of the plan alone,
  and it is what the no-reflow rule needs: a caller whose alphabet held a space
  would otherwise break a jumbling line where the resolved one does not.

- **And it fixed a reflow the one-element view had.** The old one could break
  **inside** a wide cell's ASCII substitute, because `##` is two clusters to a text
  and one cell here -- so `日本語` at three columns wrapped into two rows while
  jumbling and three once resolved, which is the one thing this component is
  written not to do. Measured over a 1,672-render differential against the
  one-element view: **zero** differences besides the tab above and this, which is
  the whole of what two layers changed about what is drawn. `should not reflow as
  it decrypts` is the guard, over four texts, eight widths, three alphabets and a
  forty-step sweep.

- **A control character is refused, and a cell of no column is skipped, and only
  the first of those is a guard.** `CellBuffer.put()` _throws_ on a control
  character rather than dropping it, and a throw from inside paint takes the frame
  and the renderer with it -- so a `raw` has to answer for what `displayText` used
  to answer for on the one-element path. The only way a cell can carry one is a
  caller's own **alphabet**: every C0, DEL and C1 character measures zero columns,
  verified over all of them, so no cluster of a real text can be one. That makes it
  a tripwire rather than a case anybody has, and it is the half that cannot go.

  The width test beside it survived its sabotage and is kept as a declared fast
  path, because `put()` refuses a zero-width cluster a cell of its own -- so what
  it saves is a `painter.text()` call per tab rather than an answer. The two read as
  one rule and are not, which is worth the sentence: the obvious reading is that
  the width rule is what keeps the control characters out, and it is the other way
  round.

- **A cell outside the box it was given is not drawn either, and the two axes are
  two rules.** A row past the bottom is skipped because painting it would draw over
  whatever the layout put underneath, which is the box's `overflow` to decide and
  not this pass's to invent a policy for -- `paintText()`'s own sentence. A row too
  wide is **cut by `text-overflow`**, so the rule is the property's rather than the
  edge's and all four of its modes work. `white-space: nowrap` is honoured for the
  same reason the one-element view honoured it: a property that quietly stopped
  working is worse than one that never did, and both are read off the **cipher**,
  because that is the layer in flow and the one whose box both layers draw into --
  which is also where an app writes them, as it writes them on a `text` rather than
  on the box around one. Neither clamp is observable through an auto-sized
  `renderToString()` where the mode is `clip`, because a cell painted past the grid
  is one the grid refuses, so that test is over a grid bigger than the boxes; an
  `ellipsis` is observable anywhere, because it draws something.

- **The ellipsis is a library change, because nothing smaller could have been
  one.** The paint walk cuts a `text` for free -- it holds the string -- and a `raw`
  paints its own cells, so there is no output for the walk to cut. Nor can the cut
  be pushed into the `Painter`: the two layers each hand over _part_ of a row, so a
  painter-side cut would compute the boundary from half of one. What is shared is
  therefore the **decision** rather than the drawing, and `wrap/index.ts` now
  exports `cutAt(width, mode)` -- which columns survive, and what goes between them.
  `truncate()` reads it instead of inlining the same four branches, and `cutRow()`
  in the component reads it too. Two walks, because a cell is not a cluster:
  `ASCII.wide` hides one two-column character with two narrow glyphs, so there is no
  cluster-to-cell correspondence to map a string's answer back through. One policy,
  because the two disagreeing about where `ellipsis-middle` puts its odd column is
  a wrong column on screen with nothing in a build to catch it.

  **The three pieces are laid end to end rather than against the box's own edges,
  and that is what makes the agreement exact.** `truncate()` concatenates, so a wide
  cluster dropped at either boundary leaves its answer a column narrower; anchoring
  the tail to the right-hand edge instead -- which was the first spelling -- leaves
  the gap _inside_ the line, and the two draw the same text two ways. With the
  pieces compacted, a frame with nothing hidden has a cell per cluster and the two
  answer **the same string for every mode and every width**, which `should cut where
  the truncator does` holds them to over four texts, four modes and nine widths. A
  differential rather than a rule written twice, and it is what caught two of the
  five sabotages below.

  **The marker takes the state of the first cell it hides**, which is the one new
  decision two layers forced. An ellipsis is a cut mark rather than content, so
  neither layer owns it on its own terms, and CSS gives it the block's style where
  there is no single block style here -- which is the whole reason there are two
  elements. Standing for the run it replaced is the only answer that needs no new
  rule, and it is the honest thing for it to say: the mark is drawn in the cipher's
  colour while that cell is still ciphered and in the plaintext's once it has
  landed, because the line is still decrypting and so is the mark. It falls out
  rather than being arranged, since the marker is an ordinary cell carrying an
  ordinary `hidden` and the layers already ask only about that.

  **The cut is cached beside the placement and not folded into it**, because the
  _measure_ must read the uncut rows: `text-overflow` says what is drawn and never
  what a block wants, so a measure that reported the cut width would make the box as
  narrow as the cut it provoked. That is the split `paintText()` already keeps -- it
  measures through `element.wrapped()` and cuts in the paint -- and it is why the cut
  cannot live in `placeCells()` at all, since under `nowrap` the limit is `Infinity`
  while the box is whatever it is and the two widths are not the same number. The
  cache is keyed on the **mode** as well as on the frame and the width, which was the
  one sabotage of the five to survive: a sheet swapped at runtime moves neither of
  the other two, and every other test here builds a fresh view per mode, which is
  the one arrangement that cannot see it.

  With the cut in place, the per-cell `x + cell.width > area.width` test in the layer
  is gone: every cell that reaches the paint is one that fits, and a second answer
  to a question that already has one is what this file keeps deleting.

- **`RawOptions.drawsText` is what gives a decrypt its `selectable` back, and
  `selectable: true` on each layer was the wrong answer to the same question.** A
  `raw` is not selectable unless something says so, which is right for the two in
  this library -- a sparkline and a half-block image, a wall of block characters
  nobody wants in their clipboard. A decrypt is the other kind: those cells _are_
  the text. The first version said so with `selectable: true`, and that is an
  **answer** rather than a default, so it beat everything above it: a pane marked
  `selectable={false}` had its decrypt copied anyway, which is the rule the mask is
  written around, broken by the component it was meant to serve.

  So `defaultFor()` asks the raw what it draws, and a raw that draws text inherits
  exactly as a `text` does. It is on `RawOptions` rather than being a third prop
  value -- `selectable: 'inherit'` -- because it is a property of **what the painter
  draws** rather than of what a caller or a sheet wants: a raw cannot forget what it
  is, where a raw whose props forgot the word would be silently uncopyable. And it
  keeps a sheet out of deciding what may be copied, which is the reason `selectable`
  is a reserved prop rather than a style property in the first place.

  Three claims, because they come apart. That each layer says `drawsText` and
  neither says `selectable` -- the second half is what makes the first observable at
  all, since an answer here would beat the ancestor. That a pane which excludes
  itself excludes the block. And that an explicit `selectable` on the block still
  beats the pane, which is what keeps this a default rather than a second mechanism.
  The copy test needs something **else** to have excluded, since a `true` writes
  nothing until the mask exists -- so it puts a sparkline **above** the block, which
  is both the shape `selectable` is for and a mask the layers must not widen. Each
  layer is asserted directly rather than through the mask, because the two cannot be
  told apart there: the plain layer's rectangle contains the cipher's and is written
  last, so either one alone looks inert. That pair is the entangled kind the tally
  below has an entry about.

- **Per-tick invalidation is not a regression, and it was checked rather than
  assumed.** The effect calls `invalidateMeasure()` on the cipher and
  `invalidatePaint()` on the plain layer; the one-element view called `setText()`,
  which marks **layout** for every value it did not already hold -- which while
  jumbling is every tick. So the old path marked layout per tick too, and the only
  new mark is the one for a frame that drew exactly what the last one drew, which a
  jumble does not produce. Each call says what changed about **its own** element
  rather than what the frame will do about it: a frame coalesces them today, since
  a layout mark repaints everything, which is why the guard reads the marks rather
  than the picture and why it is written against the day paint is narrowed.

- **What two layers cost per frame is nothing, and what they cost on the wire is
  real.** Interleaved, eight rounds of two hundred frames each, medians, with both
  sides asserted to paint the **same grid** for every frame: a 33-cell line is
  **0.0555ms against 0.0462ms**, a three-line 90-cell block **0.1029 against
  0.0913** and a 600-cell block **0.7324 against 0.7081** -- the two layers are
  _faster_, by 16%, 11% and 3%, because a cell walk over data the frame function
  already produced is cheaper than re-wrapping and re-segmenting the whole line the
  way a `text` whose content changed has to. Three runs agree. What it does cost is
  **bytes**: a mixed row is an SGR run per transition rather than one for the line,
  so at truecolor a frame goes from **33 to 83 bytes**, 79 to 158 and 567 to 1,546
  -- 2.5x, which is exactly what per-character colour _is_. At level 0 the counts
  are identical to the byte, because there is no transition to emit.

- **Level 0 is the characters and nothing else, and that is the answer rather
  than a gap.** At level 0 the seven attributes go along with the colour, so both
  layers resolve to the same style and what is left is the glyphs changing -- which
  _is_ the effect. A decrypt asked for plain text gets plain text, which is the
  rule the prompt's caret is the worked example of, and here it costs nothing
  because the effect was never carried by colour: two colours degrade to none and
  the characters are still turning over. Asserted at level 0 and at truecolor in
  both schemes, as every other claim about this sheet is.
- **It resolves when it is over, and `cancel()` resolves too.** Awaiting
  `decrypt(text)` is the API, because unlike a spinner this animation is finite.
  Over rather than _finished_: a promise that rejected on an abort would be a thing
  every caller has to wrap for an outcome nobody considers an error, and a
  rejection out of a command's `run()` is a message and a non-zero exit code, which
  a Ctrl-C is not.
- **An awaited run keeps the process alive, and the unref'd timer every other
  component has is what made `await decrypt()` never return.** The rule the spinner
  and the typewriter keep -- unref the timer, because a program that has finished
  should exit even if somebody forgot to stop it -- is right for them and wrong
  here, and the two entries above are why: this is the one component whose API _is_
  a promise, so a caller awaiting it means the program has **not** finished. With
  the driving timer unref'd and the renderer's frame timer unref'd by design there
  is nothing ref'd left for the loop to do, so node exits instead of settling.
  Reported from a real terminal and reproduced exactly:
  `node demos/components/09-decrypt.js` exited **13** with `Detected unsettled
  top-level await` at the first `await`, having drawn nothing, while the identical
  run **piped** was fine -- because the piped path writes the text once and
  schedules no timer at all, which is why every test, every CI run and a full
  review pass missed it. So `DecryptRevealOptions.hold` refs the timer and the
  facade is what sets it; a component driving its own tree still gets the unref'd
  default, because that app stays alive on its own. What it costs is that a run
  nobody awaits holds the process open until it finishes, which is a bounded couple
  of seconds against a spinner's forever, and which `stop()` and `cancel()` both
  end at once.
- **Which needed a test that spawns, because the claim is about the process rather
  than about a frame.** The component's own suite drives an injected clock, so it
  can say what every frame holds and cannot say whether node was still running when
  the last one landed -- and `demos.test.ts` cannot either, for the reason recorded
  there: it spawns with stdio `ignore` and pipes, so every demo takes the
  no-terminal branch. `packages/cli/test/decrypt-tty.test.ts` fakes a terminal the
  way `output-forms.test.ts` does, awaits a run and looks for a line printed
  **after** the await. Its discriminator is a **masked glyph** rather than a count
  of escape sequences, which was the first spelling and measures the wrong thing: at
  colour level 0 over a one-line canvas a repaint is mostly a carriage return, so an
  animated run emitted **three** escapes. The plaintext and every sequence around it
  are ASCII while the alphabet is CP437, so one character above U+007F is one frame
  that hid something -- 46 of them animated, none piped. The sabotage that proves it
  also had to be verified rather than trusted: the first attempt was a `perl`
  substitution that **silently matched nothing**, the suite stayed green, and that
  reads exactly like a guard which is not load bearing. Anchored on an exact line
  and asserted to have landed, it reproduces the reported exit 13 and fails the
  test.
- **`stop()` keeps the text and `cancel()` erases, which is the opposite way round
  from the spinner and the typewriter.** On those, `stop()` erases. The ticket named
  this spelling and the semantics earn it: for a _finite_ animation "stop" is what
  somebody says when they want it over with rather than gone, and the thing they
  wanted was always the text. `typewriter.done()` is what corresponds to `stop()`
  here and `typewriter.stop()` to `cancel()`.
- **The screen is given back before the promise resolves, on the microtask after
  the run settled.** The animation finishes from inside the effect that is drawing
  it -- the timer's own step, or the effect body for a text with nothing to hide --
  and disposing a renderer from inside its own frame is not a thing to do. So the
  teardown is chained onto the promise: by the time `await decrypt(text)` returns,
  the rows are back and an ordinary `console.log()` lands below the frame rather
  than inside it, which is the already-recorded `console.log()`-after-`dispose()`
  hazard answered rather than inherited. Chained rather than resolved after a bare
  `queueMicrotask(leave)` because the two differ in where a failure goes: a throw
  out of the renderer's disposal is a rejection whoever awaited sees, and would be
  an uncaught exception out of a microtask. `stop()` and `cancel()` do the screen
  **themselves and synchronously**, because a caller writing a line straight after
  either of them must not race a teardown -- and the chained one is idempotent
  through `mounted`, so it then finds nothing to do.
- **A run has a generation, and both halves of that were measured as bugs rather
  than reasoned about.** `start()` after a settled run has to tear the old one down
  _eagerly_: `mount()` reuses whatever is mounted, so a second run over a finished
  run's renderer finds an effect that is not dirty -- nothing animates and nothing
  ever resolves. It presented as a **hang**. And it has to do that _before_ writing
  the new text, because leaving a frame re-runs the effect: with the text set first,
  the line the previous run left behind said what the _second_ run says -- measured
  as `['two', 'two']` where it should be `['one', 'two']`. The counter is the third
  piece: the settled run's own teardown is still queued, and without a generation
  to compare it disposed the renderer the new run had just built, because the only
  thing it had to go on was whether anything was mounted and something is.
- **`stop()` and `cancel()` each turn `running` off themselves, and the teardown
  deliberately does not.** It is not bookkeeping in those two: with the flag left
  on, a `stop()` after the animation finished mounts a fresh renderer whose effect
  reads it as still animating -- so it masks the text all over again and leaves
  _that_ in the log -- and a `cancel()` leaves `decrypting` reading `true`, because
  the frame it was erased on is still a masked one. Both are pinned.

  In the **teardown** it is inert, and a `running.set(false)` there was written and
  deleted again for failing its sabotage: the two methods above do it themselves, so
  the only path left through it is a run that finished, where the frame already says
  nothing is hidden. Which came with a lesson about the method rather than about the
  code -- the deletion then **weakened the generation guard's own fixture**, because
  the discriminator that test had been using was the flag the deletion removed. Two
  guards whose observability was entangled, which one pass could not have seen.

- **Two intervals rather than two mechanisms, which is nms's own shape.** 35ms
  while nothing is resolving and 50ms once things are, one timer rescheduled per
  tick. A glyph is drawn per hidden cell per call, so how often the jumble moves is
  the caller's decision rather than a second schedule inside the frame function.
- **The clock is injectable, unlike the typewriter's.** That file records why it
  has no `now`: it only schedules. This measures how far through a duration it is,
  which is exactly why the animator has one -- so a test can hold the clock still
  and watch the frame not move however many timers fire.
- **A duration that is not a finite non-negative number falls back to the
  default.** The typewriter's own rule for its interval, and here the cost of
  getting it wrong is worse than a wrong delay: `Infinity >= 0` is true, so an
  infinite jumble is a promise nothing will ever settle. A negative one falls back
  rather than clamping to zero, which is what that option already does -- somebody
  who wants it instant writes `0`, and a negative number is a mistake rather than a
  request.
- **A text with nothing to hide costs no timer and finishes at once.** Empty,
  whitespace-only, a lone combining mark: there is no hidden cell, so the first
  frame is already the answer and nothing is scheduled. It falls out of the same
  condition that ends the animation rather than being a case beside it.
- **The first frame is drawn now rather than one tick from now**, because a decrypt
  that showed the real text for one frame before hiding it has given the answer
  away.
- **Not a terminal, no effect**, and a reduced-motion opt-out is the same question
  asked of a screen that exists. The text is written once and the promise resolves:
  a CI log full of noise is worse than no effect at all. Reached through the one
  path that decides it -- turning `animate()` off -- rather than through a second
  mechanism, which is what makes `stop()` snap to the finished text for free.
- **It imports the barrels rather than the modules behind them, and that is a
  constraint rather than a style.** `sigil add` rewrites a component's relative
  imports to the published subpath that answers for each, and neither
  `src/ansi/strip.ts` nor `src/canvas/buffer.ts` is published -- so
  `import { cellWidth } from '../canvas/buffer.js'` fails the _build_ with
  `which no published subpath answers for` rather than failing a test. Found by
  reading the generator rather than by running it, and then checked by running it:
  it is the one rule in this file that no unit test can see, which is what the
  generator's own refusal is for.
- **Fifty-five mutations, one at a time with the suite run after each, and three
  deliberate survivors.** Counted against the shipped code in one run rather than
  summed across rounds, so the number is re-derivable: 55 applied, 50 caught by the
  suite, 2 caught by the build, 3 declared below. Two more were added afterwards for
  guards the pass itself produced -- `min-width: 0`, and the sheet's light half --
  and both are caught.

  Two of the three survivors are a statement _order_ rather than a guard -- the
  settle after the screen in `stop()` and in `cancel()` -- and the sabotage is what
  established that the order is **inert**: a promise resolves on a later turn, so the
  caller cannot run until the method has returned and both spellings look the same
  from outside. The comments said otherwise and now say what is true, which is the
  finding rather than a footnote: what is load bearing is that those two do the
  screen work _at all_, and both of those are caught. The third is a `+` against a
  `*` in the whitespace pattern, which cannot differ because the only caller asks it
  after `width > 0` and no cluster of positive width is the empty string.

  Two more survive the _test_ file and are caught by the **build**, which is the
  honest place for them: the two barrel imports above. Checked by reverting each and
  running `generate-registry.mjs`, which answers `which no published subpath answers
  for`.

  What the pass found that no review round had is worth the tally. Six fixtures could
  not reach the branch they were named for -- `running` off in `cancel()` (nothing
  asserted `decrypting` after one), the generation guard, the listener removal (a
  real `AbortSignal` cannot be asked how many listeners it holds, so it took a
  recording stub), attaching once, the final frame being painted before the screen is
  given back (every run in the file resolved inside its own first frame, where
  `start()` has already painted it), and `min-width: 0`, which is 34 columns against
  12 the moment anything asks. And one guard was _deleted_ for being inert, which is
  the entry above.

  Three bugs came out of writing the tests rather than out of the sabotage, and all
  three were in the restart path: a **hang**, from a second run reusing a finished
  run's renderer; a line in the log that said what the _next_ run says, from setting
  the text before leaving the old frame; and a settled run's queued teardown
  disposing the renderer that had replaced it.

  And three things were wrong in this file's own prose rather than in the code, which
  is the shape a documented codebase is most prone to. `onDone` was documented as
  firing "once" and fires once per **pass** -- measured at three over three text
  changes, and pinned now. `decryptPlan()` and `decryptFrameAt()` were called
  **pure** and are not, which is the entry at the top of this section. And the
  default alphabet's doc counted ninety-two glyphs where there were ninety-five, so
  no count is written down any more and the property is asserted instead -- every
  entry the width its half promises, and none repeated, which is what caught
  `ASCII.wide` shipping `##` twice.

- **The per-cell pass: thirty-eight mutations, thirty-six caught, two declared --
  and the first run of the harness was worth nothing.** It ran `vitest run` with
  paths relative to the **repository root** while `pnpm --filter ... exec` runs in
  the package, so every run matched no test file, exited non-zero, and was recorded
  as the mutation being _caught_: 38 of 38, a perfect score that said nothing at
  all. It is the glob-that-matches-nothing failure this file records for the
  Windows build filter and for the `perl` substitution in the TTY test, arriving
  through a third door -- and the thing that caught it was spot-checking one
  verdict by hand rather than anything in the harness. So it asserts the run found
  the tests now, by count, and treats a run that did not as its own verdict rather
  than as a pass. A sabotage harness needs a control as much as a benchmark does.

  **And a fourteen-mutation pass over the ellipsis and `drawsText`, thirteen caught
  first time.** The survivor is the entry above -- the drawn cache not keyed on the
  mode -- and it is worth the note because it is the only one of the fourteen that
  was a real guard with a missing test rather than a guard the suite already held.
  Four of the thirteen are caught by the `truncate()` differential alone, which is
  the argument for having written it: the head condition, the tail condition, the
  compaction, and `truncate()`'s own composition each fail it and nothing else. Two
  more are the `selectable` pair, and they fail different tests in each direction --
  not reading `drawsText` fails the copy tests, and reading it as an _answer_ rather
  than as a default fails the pane tests -- which is what says the three claims
  really do come apart.

  What the real run then found is the half that matters. Nine survived, five of
  them because the test naming the claim could not see it, and each of those five
  got the test it was missing: breaks taken from the plan rather than from the
  glyphs (an alphabet of _spaces_ is what makes the difference observable); a width
  of zero wrapping at one column; the placement cache keyed on the width as well as
  on the frame, which is what a **resize** is; the plain layer's box being the
  rectangle its insets name, which is what `position: absolute`, the four insets and
  the host's `position: relative` are all for; and each layer's own `selectable`.

  Two of those five are the **entangled** kind this file has an entry about from the
  animator's pass, and they could not have been found one at a time: the cipher's
  `selectable: true` and the plain layer's insets cover for each other, because the
  mask is written per element in paint order and the plain layer's rectangle
  contains the cipher's. Either one alone looks inert. What makes them both
  observable is a sparkline **above** the block -- a mask the layers could widen but
  must not -- plus each layer's own answer asserted directly, which is a claim about
  the decision rather than about a picture and is the honest shape for a pair that
  cannot be separated.

  The two declared survivors are both of the kind this file already keeps: the
  `cell.width > 0` half of `draw`, which `put()`'s own refusal makes inert and which
  is the entry above, and the plain layer's `measure`, which a box given two insets
  never asks -- the scroll bar's `noSize()` said again. And one "caught" is worth
  discounting rather than counting: swapping the two layers' document order fails
  two tests because they read `view.children` positionally, which is not a claim
  about paint order -- the order really is inert here, since the two layers draw
  **disjoint** cells and neither can overpaint the other.

#### A multiline field, and the `raw` node that makes it possible

SIG-94 and the component rewrite settled every editing rule a text field needs,
and SIG-111 is those rules over a list of lines. `src/components/editing.ts` is
the rules, `multiline()` in `src/components/prompt.ts` is the field, and the one
genuinely new thing is a `raw`-backed field with a goal column over it.

- **The field is a `raw` node, and that is the whole of why this ticket existed
  rather than being a loop over the single-line field.** AGENTS.md already
  records why the one-line prompt scrolls sideways instead of wrapping: "there
  is no inline layout, so the three pieces the caret splits the value into are
  three flex items, and a wrapped first item leaves the other two beside its
  _box_ rather than after its last line." A soft-wrapping textarea is that
  problem at every line rather than at one, and three flex items cannot express
  "text, caret, text" flowing across wrapped rows. So the field is the third
  host type -- the one designed in for what the layout engine cannot express:
  it measures like a text, it paints its own cells, the value is wrapped once,
  and the caret is a cell coordinate derived from an offset.

  The **second** caller inside the framework that is not a picture, and the
  decrypt block is the first -- which is worth being right about rather than
  claiming a first, because that block is this one's precedent in three separate
  places: two `raw` layers over one rectangle, `drawsText` rather than
  `selectable: true`, and a component wrapping its own cells because a cell is
  not a cluster. The scroll bar's thumb is a picture; a decrypt cell is a
  character, exactly as a field's is.

- **The caret marks the cluster at the cursor, which is the one rule that
  answers "end of this row or start of the next" without a second rule.** It is
  the single-line field's own rule -- reverse video over a whole grapheme
  cluster -- read as a coordinate: a cursor at a soft break is drawn at the
  start of the next row because that is where the cluster it names was placed.
  Past the last cluster there is nothing to mark, so the caret is a column of
  its own, and it is the **last** row's because every other row's end is the
  next row's start. The alternative is a rule about rows, which then needs a
  second rule for a hard-broken over-long word (where there _is_ no column
  after the row's last character) and a third for a newline. There is one rule
  and no cases, and `should place a soft break at the start of the next row
  rather than past the last` is what pins it.
- **It wraps at one column less than the room**, which is the single-line
  field's own arithmetic said again -- "the caret always takes a column, whether
  it is on a character or past the last one" -- and the alternative is a caret
  at column `width`, which has to be drawn on a row below the one it belongs to.
  That costs a phantom row whose existence depends on where the **cursor** is,
  so pressing End on a full row makes the field a row taller and reflows
  everything under it. One column of display against a layout that moves when
  nothing was edited.
- **Every cluster is placed, including the whitespace a break throws away, and
  that is one declared divergence from `wrap()`.** `wrap()` drops the trailing
  whitespace of a line and is right to: a terminal draws nothing for it. A field
  cannot, because a space is an offset the caret has to be able to sit on -- so
  the gap stays on the row it ended. Whitespace that would then land past the
  wrap column is placed **at** it, so a run of several spaces at a break shares
  one column. They are all blanks, so nothing on screen says so.

  **A single space is never the case this is for**, which is worth stating
  because the first version of this entry got it wrong in both directions. The
  clamp can only bite past the wrap column, a row's content ends at or before
  it, and the box is a column wider -- so one space always has a column of its
  own. What needs the clamp is a **run**: a double space after a full stop, or
  trailing spaces somebody typed. Measured, because the first write-up claimed a
  frequency it had not counted: over a paragraph of this file's own prose at 38,
  60 and 78 columns, a gap landed past the wrap column in **0 of 36 rows**.

  Two alternatives, and the one that is nearly equivalent is the one the
  corrected measurement is about. Letting the row overflow and clipping the
  drawing puts the caret outside the box, which is a caret nobody can see.
  Breaking the gap like a word is total and injective, and it agrees with this
  everywhere a single space is involved -- what it does differently is spread a
  **run** across the break, so five trailing spaces at a break indent the next
  row by four and push the word after them along. The clamp collapses them into
  the last column, where they are blanks. And a phantom row for an invisible
  character is the entry above. `should keep every offset of the value on
  exactly one row` is the property the caret derivation rests on, walked over
  nine values at six widths; `should keep the caret inside the box it reports,
  at every offset` is the other half, over seven values at six widths and at every
  cursor of each -- a different corpus rather than the same one, because the two
  properties are about different inputs: that one wants the values whose _caret_
  is awkward, which is a trailing whitespace run and an over-long word.

- **The caret is never painted on the far half of a wide cluster, and that is
  not about how it looks.** `CellBuffer` carries a write on either half of a wide
  cluster to the other, so a space on the continuation blanks the lead and the
  character is **gone** -- measured, `漢` in a two-column grid with a space at
  column one comes back as two blanks. Found by review rather than by a test, and
  the review had to name the input: a field two columns wide.

  Two columns are the only place it can happen and both routes are reachable. A
  cluster wider than the wrap limit is placed at column zero anyway, because the
  break guard asks `x > 0` and there is nowhere else to put it -- so a field of
  one or two columns holds a row two columns wide, the reported width is the room
  rather than the content plus a caret, and the clamp under `edge` lands on column
  one. And a zero-width cell is clamped to the wrap column by `place()`, so a
  newline after such a cluster is **already** there: `漢\nmore` with End pressed
  on the first line is the same cell, reached without any clamp at all.

  So `caretOn()` is where a caret's column and its text are settled together, and
  it is one rule rather than a guard: the caret takes the cluster that occupies
  the column it ended up in, and a blank only where no cluster does. A wide
  cluster therefore gets **marked** rather than blanked, which is this field's own
  rule -- the caret marks a cluster -- applied to the only cluster there is room
  for. It is wrong about where the next character goes, and in a two-column field
  holding a wide character there is no column that is right about that; it is the
  only answer that keeps the character on screen.

  The uniform rule turned out to be the better answer away from the degenerate
  case too, which is why it is not written as a special case. A control character
  draws nothing, so the column `place()` gave it belongs to the cluster after it
  -- and marking that one says the truer thing, because the next character really
  does go in front of it. Two cursor positions then share a column, which is
  inherent rather than chosen: one of them takes none.

  The first spelling of the fix claimed a positive-width cell's own column is
  never past `edge` and skipped the check for one. That is false at a room of
  one, where `limit` is `max(1, 0)` and therefore **larger** than `edge`: a space
  clamped to the wrap column sits at column one of a one-column field, and
  `should keep the caret inside the box it reports, at every offset` is what said
  so. The property test is what caught the fix to the review's finding, which is
  the argument for having written it as a property.

- **Soft wrap only, and a hard-wrap mode is deliberately out.** A mode that
  inserted real newlines at a column changes what the value _is_, which every
  caller can see -- so it is a decision about the return type of the prompt
  rather than about how the field draws. Left out, it can be added later without
  changing the meaning of a value anybody already depends on; shipped now, every
  caller has to know which mode produced the string it was handed. `should soft
  wrap a line too wide for the field without touching the value` asserts the
  divergence between what is drawn and what comes back.
- **The goal column is a display column rather than an offset.** That is the
  thing every editor gets right and every from-scratch textarea gets wrong: a
  remembered offset drifts left through a short row, and an offset and a column
  stop being the same number the moment a row holds a wide character. So
  Up-Up-Down comes back where it started through a short line **and** through a
  line of CJK, which are two tests rather than one -- a fixture with no wide
  cluster in it cannot tell an offset from a column. Aiming at the far half of a
  wide cluster lands on the cluster rather than between its halves, because
  there is no caret position between them.
- **The goal is kept across a run of vertical moves and given up by everything
  else**, which is the whole of what a goal column is. Cleared _after_ the move,
  because `vertical()` is what reads it; and a paste clears it too, since a
  paste moves the caret without going through the vertical path. Pinned by a
  fixture where the two answers differ -- Up, Left, Up has to aim at the column
  Left left it in, and with the goal kept it aims at the one the first Up
  carried.
- **Home, End, Ctrl-A, Ctrl-E, Ctrl-U and Ctrl-K are the logical line; Up, Down
  and the page keys are the row on screen.** The split looks inconsistent and is
  not: vertical movement is about what the person can see, and a line's ends are
  about what readline means. Three reasons, and the third decided it. Ctrl-A and
  Ctrl-E _are_ readline's names for the ends of a line, so making them mean
  something else is the surprise rather than the consistency; nano, vim and
  emacs all answer the logical line for Home. And the visual reading has a wart
  it cannot avoid -- the last caret position on a soft-wrapped row is **on** its
  last cluster rather than after it, because there is no column after it, which
  is the whole reason the row broke -- so a visual End leaves the caret one
  character short of where "end" reads, and Ctrl-K then leaves that character
  behind. A browser textarea answers visually and has a pixel to put the caret
  in; a cell grid has not. Ctrl-Home and Ctrl-End are the whole value, which is
  the one place a modifier means something here.
- **A pasted block keeps its line breaks, which is the deliberate inverse of
  what `text()` does with one.** The single-line field flattens every run of
  whitespace to one space, on the recorded ground that obeying a break there is
  what makes a paste submit half an address. Here the opposite is true, because
  keeping the breaks is the entire point of having more than one line.
  `pastedLine()` and `pastedBlock()` therefore sit next to each other in
  `editing.ts`, so that the inversion is visible rather than discovered, and the
  test asserts it **as an inversion**: the same bytes through the two fields,
  two answers. CRLF and a lone CR are normalized to `\n`, so the value holds one
  spelling of a line break and every rule above can split on it.
- **A tab is kept in the value and drawn as a space.** Dropping it with the
  other control characters takes the indentation out of pasted code altogether,
  which is worse than one column of it; keeping it and drawing it as anything
  else makes the field the one text in this library that disagrees about what a
  tab is. So the value is faithful and `toDisplayText()` is what the field draws
  through, which is the rule the grid already states: it models no tab stops, so
  a tab that measured one width and painted another would take a column off
  every cell to its right. A **typed** Tab still inserts nothing, which is what
  the single-line field does and is why: a key that put one column of
  indentation in reads as a key that did nothing.
- **An `initial` value goes through the same normalizer a paste does**, so the
  answer cannot hold something no key and no paste could have put there -- and
  `pastedBlock()` is a fixed point, which is what makes normalizing twice safe
  and is asserted. What that buys the paint is that a control character cannot
  reach the field from any route, which matters because `CellBuffer.put()`
  **throws** on one rather than dropping it and a throw from inside paint takes
  the frame and the renderer with it. The guard is kept anyway -- `clusterText()`
  gives a control character no cell and the paint skips a cell of no width --
  because a **lone combining mark** is zero columns, is not a control character,
  and really does reach the value: the grid refuses one a cell, so placing it
  without painting it is what keeps the characters after it in the right column.
- **`drawsText: true` on both layers rather than `selectable: true`.** A `raw`
  is not selectable unless something says so, which is right for a sparkline and
  wrong for a field whose cells _are_ the text. `drawsText` changes the
  **default**, so a `selectable={false}` on a pane still reaches the field the
  way it reaches the texts inside it; an answer would have beaten it, which is
  the loss the flag closes. The decrypt is the precedent and this is the second
  caller. It is on the **caret layer** too, and that is not decoration: the caret
  repaints the cluster under it, so without it that one cell would be the one
  character of the field a selection could not copy.
- **The caret is a second `raw` over the same rectangle, because one element
  cannot resolve two styles.** The scroll bar's shape and the decrypt's: the
  caret carries `.sigil-caret` and is therefore `inverse` through the ordinary
  cascade, so a theme reaches it where it reaches everything else. It paints at
  the **field's** box rather than its own, so that a padding an app writes cannot
  put the caret a column away from the character it marks. At colour level 0 the
  seven attributes go, so no caret is drawn there at all -- which is the rule the
  single-line field's caret already follows and is asserted beside the claim that
  the field is still editable.
- **The layout is computed at a room the component already knows rather than at
  the width the box was given.** That is the rule the single-line field keeps --
  `windowOf()` is handed `head.rest` -- and it is what makes the measure and the
  paint one answer rather than two that have to be kept in agreement. The `raw`
  reports the stored layout's width, which is `min(room, widest + 1)`: the `+ 1`
  is the caret's own column, and it is what makes the caret clamp a no-op
  anywhere but a one-column field, where `limit` cannot be zero and a cell really
  can land on the column the box ends at.
- **`rows` is enumerated rather than clamped, and a submit key nothing can press
  is refused.** Two degenerate inputs, found by walking the options rather than
  by a report, which is the rule the typewriter's own interval already records.
  `Math.min(NaN, anything)` is `NaN`, so a `rows` of `NaN` reached the measure as
  a height of `NaN` and the layout engine was handed a box no arithmetic can
  place -- and a fraction reached it as a fractional height, which is the thing a
  declaration is refused for.

  `Infinity` **passes through**, unlike the typewriter's interval, and the
  difference is what the value means: there it is a wait with no end, and here it
  is a field with no cap of its own, which the terminal's own `Math.min` then
  bounds. Said precisely because the first version of this entry said it and the
  code did the opposite -- a `Number.isFinite()` beside the `>= 1` refused
  `Infinity` while both this entry and the function's own comment claimed the
  `Math.min` was what limited it. `rows >= 1` is the whole of what refuses `NaN`,
  since every comparison against it is false, so the second guard was buying
  nothing and costing the one value the prose named. Found by the second review
  round, pointed at the prose rather than at the code -- which is this file's own
  recorded experience about where a second round's findings come from. A `submit.name` of `''` is a key `decodeKeys()` never
  produces, so the field has no way out at all: it is refused the way a choice
  list with nothing to offer is, rather than by quietly putting the default back
  -- which would be a prompt answered by a key its own hint does not name. Both
  halves are the hang `PromptError` exists for, and the sabotage for the second
  one takes the whole ten-second timeout to be caught, which is what the hang
  looks like.

- **The field grows into its row cap rather than starting there.** A field that
  reserved ten rows for a one-line answer would hold nine blank rows of the
  user's scrollback open for the life of the prompt, which is the auto-height
  canvas's own argument. Past the cap it scrolls, through the same
  `windowStart()` the choice list uses -- the only thing that has to be true is
  that the caret's row is on screen, and recomputing it from the caret means
  nothing to keep in agreement. The cap is the smaller of what the caller asked
  for and what the terminal has left under the question, with the error line
  reserved either way so that showing one does not push the last row off the
  screen.

  Asserted as that property rather than at the end of one sequence, because
  nothing else in the field would notice if it stopped holding: `should keep the
  caret on screen after every key there is` checks it after each of twenty-one
  keys, which is every key the field reads. Bounded by the row cap rather than by
  what the log holds, because a row whose only cell is the caret is a row of
  spaces -- the harness trims it, and the row is still on screen.

- **Submitting is Ctrl-D, and `run()` grew a `claims()` hook because `isAbort()`
  would otherwise take it first.** Ctrl-C and Ctrl-D are both aborts, checked in
  `run()` before any handler sees a key -- which is right for the four prompts
  that have no use for Ctrl-D and wrong for the one whose submit key it is. So a
  handler may say it wants a key the abort rule would take, and **Ctrl-C is
  refused**: an app that cannot be quit because a field swallowed it is the
  failure the binding order exists to prevent, and a field is not entitled to
  that one. The hook is absent for the other four, so the path they take is the
  path they always took -- which `should leave ctrl-d an abort for the
  single-line field beside it` is what holds.
- **Ctrl-D submits an empty field rather than meaning end of input there.** A
  submit key that means two things depending on invisible state is the trap
  Ctrl-C-as-copy is written down for: somebody who wants to submit an empty
  description would find the prompt cancelling instead, with nothing on screen
  to say why. Ctrl-C is the abort and is the one every CLI user knows. And the
  claim is `claims()`'s rather than the key's, so a caller who named another
  submit key gets Ctrl-D back as an abort -- a field that said yes to Ctrl-D
  whatever its submit key was would be answering for a key nothing in it reads.
- **`submit` is a key spec rather than a predicate**, because the hint the field
  draws has to say which key it is. A `(k: Key) => boolean` is more flexible and
  needs a second option beside it for the label, and two options that can
  disagree about one key is how a prompt comes to tell the reader to press
  something that does nothing. `{ meta: true, name: 'enter' }` is Alt-Enter,
  which is also what Escape-then-Enter arrives as when the two are pressed
  inside `ESCAPE_TIMEOUT` of each other -- so the sequence the ticket asked
  about is reachable without the field holding a mode nothing on screen could
  show.
- **Word movement crosses a line break, because a break is whitespace.** That is
  what readline and emacs both do in a buffer with newlines in it, and the
  alternative -- stopping at the start of the line -- is a second rule that Home
  already keeps. Which made the whitespace test a cluster question rather than a
  character one: `graphemes()` keeps `\r\n` together, so `^\s$` read a CRLF as a
  **word** character and word movement walked straight over a line break.
  `^\s+$` is the fix and it has a test of its own, because the field normalizes
  its own line endings -- so that pair reaches the rule only from a value a
  caller handed in, which is exactly the input a guard like this is for.
- **There is no `default`, and that is not an omission.** `text()` has one
  because Enter alone is the common gesture there; here Enter is a newline, so a
  field meant to come up with something in it comes up with it **visible and
  editable**, which is `initial` and is the better answer anyway.
- **One line in the log, which is the house style rather than this field's
  invention.** `select()` leaves its label and `multiselect()` leaves a comma
  list, so a multiline answer leaves its first line and `(+N more lines)`. The
  whole of what was written is the caller's return value; a log holding a
  fifty-line paste per prompt is a log nobody reads. An empty answer says
  `(empty)` rather than nothing, because a prompt that answered and left a blank
  line reads as one that did not.

##### The extraction, and what it was allowed to touch

The ticket's second open question was whether to reimplement the single-line
field on top of the multiline one. It was decided the other way, and the
constraint is worth recording because it shaped every edit.

- **The rules are shared; the single-line field's structure is not touched.**
  `boundary()`, `snap()`, the insertion rule and the two delete rules moved into
  `editing.ts` verbatim and `text()` calls them; everything else about `text()`
  is where it was. Reimplementing it on this field is the cleaner end state and
  it risks regressing a component with a great deal of hard-won behaviour in it,
  which is not a trade worth taking inside a ticket about a second field.
- **`test/components/prompt.test.ts` is the regression suite for it, and it was
  not edited.** All seventy-five of its tests pass unchanged. That is the whole
  check: an extraction that needed a test moved is an extraction that changed
  behaviour, and the test moving is how that gets agreed to rather than noticed.
- **What else moved into `editing.ts` is what both fields read**, and the two
  paste rules, which read each other. `typedText()` is the printable-key rule --
  a character arrives with its name and its sequence the same string, and what
  is inserted is the sequence rather than the name -- and extracting it turned
  the single-line field's last `else if` into an `else`, which is the same
  answer for every key: a key `typedText()` declines inserts nothing, which is
  what the guarded branch did. `wordBefore()` and `wordAfter()` are there with
  one caller, because the question they answer has one right answer and a second
  copy is how two fields come to disagree about where a word starts.
- **The field arithmetic is exported from `prompt.ts` and deliberately not from
  the barrel.** What a multiline field claims is a coordinate, and the screen
  model a component test reads holds characters rather than styling -- the cell
  under the caret holds the same character whether or not a caret was drawn
  there. So `layoutField()`, `offsetIn()`, `lineStart()` and `lineEnd()` are
  asserted directly and the field is asserted through the screen, which is the
  split `rowWindow()` and `thumbExtent()` already keep for the scroll box. Not
  barrel-exported because only the barrel is published: `FieldLayout` is a shape
  this module owes nobody, and a type in the public API is a promise.
- **`fieldLayers()` is there for the same reason and was forced by a sabotage.**
  The two `raw` elements were built inside `multiline()`'s closure, and the only
  way to a cell's `selectable` is `selectableAt()` over an arranged tree -- so
  `drawsText` on either layer was a claim nothing could see, and both survived
  being deleted. As a function of a `FieldFrame` the drawing is testable with no
  terminal and no keystrokes, which is the rule the layout engine and the
  selector engine already keep: it takes the rows, the window and the caret, and
  a test hands it a literal where the component hands it a closure over its own
  state.
- **The screen model advanced one column per character, so a _picture_ over a row
  holding a wide cluster was not to be trusted. That is fixed, and this is the
  report it was found in.** Pre-existing, surfaced by driving this field by hand,
  and worth keeping because it reads exactly like a bug in whatever is being
  tested: a CJK row came back as `日本語 is ihree` after an Up, with the `t`
  apparently replaced by an `i`. The bytes say otherwise -- `ESC[9C ESC[7m i`
  moves to **real** column 9, which is where that `i` already is, so the frame
  changed a style and nothing else -- and the model, which wrote one cell and did
  `column++` whatever the character's width, had put the same `i` in model column
  9, where its own row holds the `t`. `diff.test.ts`'s `FakeTerminal` modelled a
  continuation and that one did not, which was the difference.

  Not fixed here, because it was a shared harness this ticket merely met, and what
  it cost was bounded: `lastInverse` is read off the cursor the diff moved, so a
  caret _coordinate_ was a real column and was sound, and none of this field's
  wide-cluster tests asserts a row's text. It was fixed by SIG-140, which had to
  -- the model ships as `@ttylabs/sigil/testing`'s `Screen` now, and shipping a
  picture that is wrong about any row with one wide character in it is not a thing
  to hand an app author. See "The screen model's wide-cluster defect is fixed,
  not documented": clusters rather than code units, a `''` continuation, and
  `cellAt()` to ask about one. A picture over a wide row is therefore no longer
  the thing to avoid, and `renderToString()` is still where a wide row is
  asserted as cells with no diff in the way.

- **The screen model learnt about reverse video**, which is the one piece
  of styling it keeps. A prompt's caret _is_ styling, so a model holding
  characters alone cannot see it at all; the alternative is a second cursor
  tracker written inside a test, which is a second model of the thing that one is
  for. It records the cell of the **most recent** inverse write, because what a
  test asks is where the caret is now -- a frame repaints, and the caret is the
  last thing painted. Read parameter by parameter rather than by matching the
  whole SGR string, for the reason `report.test.ts` already records: a transition
  combines what it closes with what it opens, so a test for the string would be
  pinning one spelling of it.

  **And it skips an extended colour's own parameters**, which is the bug this
  file records twice and which the first version of this reader made a third
  time: the canvas emits `38;2;7;7;7` for an `rgb(7, 7, 7)` -- verified against
  the diff's own output rather than assumed -- so a naive walk latches reverse
  video on a **channel**, and every cell after it is then recorded as the caret.
  Only the semicolon form skips, because the colon form carries the whole colour
  inside one parameter; six parameters rather than five only where the colour
  space is _empty_, since a non-empty one is as plausible a red channel. A third
  table rather than a shared one, which is the split `reopen()` and
  `sgr-state.ts` already keep deliberately -- and this one says it the same way,
  which is the point. Found by checking the reader against the bytes the canvas
  emits rather than by a test failing, and pinned by `should not read an extended
  colour channel as reverse video` -- which is in `backend.test.ts`, because the
  model is that suite's.

> Moved: _What the sabotage pass found_ — see [docs/history/the-built-in-components.md](../../../../docs/history/the-built-in-components.md).

##### What is deliberately out

- **A hard-wrap mode**, with its reason above: it changes what the value is, and
  it can be added later without changing the meaning of a value anybody already
  depends on.
- **Reimplementing `text()` on this field**, with its reason above.
- **A visual Home and End**, with its reason above -- the wart a cell grid cannot
  avoid.
- **A Tab that inserts one**, for the reason the tab entry gives.
- **Escape-then-Enter as a mode.** It needs the field to remember that Escape
  was pressed, with nothing on screen to say so and a state that fights
  `ESCAPE_TIMEOUT`. `submit: { meta: true, name: 'enter' }` is the same gesture
  through the one mechanism there already is.
- **A `default` for an empty answer**, replaced by `initial`.
- **A kill ring.** Ctrl-W, Ctrl-U and Ctrl-K delete rather than cut, because a
  ring needs a yank key and a rotation and nothing has asked for either. What
  they do is what every one-line prompt in this library already does.

#### Textarea extras: line numbers, a gutter, a limit, and a highlight seam

SIG-196. `lineNumbers`, `gutter`, `charLimit` and `highlight` on `multiline()`.
The field asked for none of them is the tree it always was, and
`multiline.test.ts` was not edited -- the check the extraction above used, used
again. The new tests are `test/components/multiline-extras.test.ts`.

- **On the prompt, and there is no full-screen editor to put them on instead.**
  The ticket asked whether any of this is wanted by a prompt. It is: a prompt that
  asks for a snippet, a query or a config fragment is the case, and a field that
  numbers its lines is how somebody pasting forty of them finds line twelve. A
  full-screen editor is `editor()` (SIG-171), which hands the terminal to the
  person's own; writing a second one here would be the wrong answer to a question
  that one already answers. An app building its own still has `layoutField()` and
  `fieldLayers()`, which are published.
- **`highlight` is handed the whole value, not a line, and that is a departure
  from the ticket's `highlight(line) => runs`.** A block comment or a string that
  runs over a line break is a span a per-line hook cannot express at all, and
  going the other way is three lines -- a highlighter that works by line splits
  on `\n` and keeps a running offset. So the shape that can say more is the one
  given. It is called whenever the value changes and **not** when only the caret
  moves, because the spans are a function of the value alone, and never for the
  placeholder, which is not code anybody wrote.
- **A span names a token, and a token is a class -- never a colour.** A span
  carrying a colour would be a colour the cascade never saw: a theme could not
  reach it, the light half could not correct it, and `NO_COLOR` could not take it
  away, which is everything the theme entries say a built-in's colour must go
  through. So a token becomes `sigil-token-<token>`, and the seven names every
  highlighter emits under some spelling -- `comment`, `function`, `invalid`,
  `keyword`, `number`, `string`, `type` -- also carry a role, so they are coloured
  with no sheet and **no declaration was added to `FRAMEWORK_CSS`**. That is the
  role rule kept rather than excepted. What it costs is that `.sigil-success`
  recolours strings along with every success mark; a theme that wants them apart
  writes `.sigil-token-string`, which is what the narrower hook is for.
- **One `raw` layer per token, made the first time the hook names it.** One
  element cannot resolve two styles, which is the caret's reason, the scroll
  bar's and the decrypt's. The layers are absolute over the field's box and paint
  only their own cells. A layer is never removed when its token stops appearing:
  it paints nothing then, and taking it out would be churn for an empty layer.
- **A bad token name is refused; a bad offset is clipped.** The name is spliced
  into a class list, so `'a b'` would be two classes and reach rules written for
  neither -- refused with a `PromptError`. An offset is arithmetic over a value the
  hook was just handed, so one past the end marks nothing past the end, a `NaN`
  marks nothing, and where spans overlap the later one wins. A hook that throws
  rejects the prompt with what it threw, because the hook is the caller's code.
- **A line is numbered on its first row only.** The number is the value's line,
  and a row is where the field drew a break; numbering rows would renumber
  everything on a resize. `gutterOf()` relies on the one thing `layoutField()`
  promises about a row's `start`: a soft break never falls on a line's first
  cluster, because a row is only broken once something is on it.
- **Two digits from the start.** Ten is the default row cap, so the tenth line is
  one an ordinary answer reaches, and a gutter that widened there would shift
  every character already typed. A hundred lines widen it, which is a paste.
- **The caret's line number is the one not muted, as a second layer.** It is what
  says which line a caret on a continuation row belongs to.
- **The gutter is not copied with the text, and a test found that the first tree
  copied it.** The gutter does not set `drawsText`, so a selection skips it --
  copying lines out of a numbered field and getting the numbers is what every
  editor's gutter exists to avoid. But the caret and token layers are absolute
  with all four insets, so in one positioned box with the gutter their
  `drawsText` covered the gutter's cells and put the numbers back. `fieldBox()`
  gives the gutter and the field a positioned box each, and is a function so that
  `should leave the gutter out of what a selection copies` asks about the tree the
  prompt really builds.
- **`charLimit` counts grapheme clusters, a line break included.** It is the unit
  the caret steps over and the one the count on screen has to agree with, so
  `👨‍👩‍👧` is one. A store that needs code points or bytes checks that in
  `validate`, which already exists for exactly that. A typed key at the limit
  inserts nothing and a paste is cut to what fits rather than refused whole.
- **An `initial` over the limit is refused, a `value` over it is dropped.** That
  is the rule SIG-204 records for every prompt, applied here rather than made up:
  an `initial` is something somebody wrote, and a `value` is usually an earlier
  answer to a question that has changed since.
- **Counting the insertion is enough, and the loop that counted the result is
  gone.** The first `fitted()` cut one cluster at a time until the whole value
  fitted, for "joins that make a value hold more clusters than its parts". There
  are none: at a cluster boundary, segmentation only ever joins -- every rule but
  one forbids a break, and regional indicators re-pairing split a pair only by
  joining the indicator in front of it into another. The loop never ran.
  `should never let a cut insertion past the limit` walks that property over the
  joins there are, at every boundary of every value. One consequence is kept on
  purpose: a combining mark typed into a full field is refused, though it would
  have joined the last cluster, because a count that says full over a field that
  changed anyway is the stranger answer.
- **The count is a row of its own, muted, and the warning role at the limit.**
  A key that inserts nothing otherwise reads as a key that did not work. The row
  cap reserves it, for the reason it already reserves the error line. No catalog
  key: `42/500` has no words in it.
- **Two guards are declared rather than claimed.** The field skips a highlighted
  cell, and the gutter skips the caret's line number, each leaving the cell to the
  layer that paints after it. Both sabotages are **equivalent** -- the later layer
  repaints the cell whole -- so no test can tell; they are kept so that each cell
  has one writer. The sabotage pass on the rest failed a test for every claim.

What is deliberately out: a bundled grammar (the hard constraint); an async
`highlight`, which would need a frame to show while it is pending and nothing has
asked for one; a count without a limit; and a limit in any unit but clusters.

#### A QR code: the encoder, and the two forms a module can be square in

The ticket was two sentences -- "Compact version is like 36 characters by 18
lines. Can we offer a large version too?" -- and the second one is a yes with a
measurement behind it rather than a preference. `src/components/qrcode.ts` is the
whole of it: the encoder, `qrLines()`, `qrcodeView()` and the facade.

- **The encoder is written here, and that is the hard constraint rather than a
  choice.** Zero production dependencies in `@ttylabs/sigil` means `qrcode` and
  every package like it is out, so mode selection, the bit stream, Reed-Solomon
  over GF(256), version and error-correction selection, the function patterns, the
  eight data masks with the penalty score that picks one, and the BCH-coded format
  and version information are all here -- the same answer ANSI handling, text
  wrapping, `which`, dotenv, the East Asian Width table and the `.flf` parser each
  got. It is **8,446 bytes** of `components.mjs`, measured the way `ScrollBox`'s
  3.4 kB and the debug overlay's 3,694 were: taken back out of the barrel and
  rebuilt, 51,556 against 43,110. The root entry is **unchanged at 1,718 bytes**,
  because the components barrel is not on it.
- **Two tables of forty numbers, and everything else derived.** The capacity data
  a QR encoder needs is usually written as a 160-entry table of characters per
  version per level; what is here is the ECC codewords per block and the block
  count per version per level, with the raw module count, the alignment-pattern
  centres and therefore every capacity computed from the symbol's own geometry.
  The reason is this file's own rule about a second list: a tabulated module count
  is a restatement of `alignmentCentres()` that can disagree with it, and the
  disagreement would be a symbol whose codewords do not fill it. The derivation is
  checked against the spec's published figures at both ends -- version 1 and
  version 40, all four levels, all three modes, the capacity and one character
  past it -- which is the other independent source there is.
- **A module has to come out roughly square, and that is what decides the forms
  rather than taste.** A terminal cell is about twice as tall as it is wide, so a
  module drawn as one cell is a module stretched 1:2 and a scanner locating a
  21-module symbol in it is being asked for something it was not designed for. So
  **`compact`** is a half block per cell -- one column by half a cell, which is the
  form the ticket describes, and a version 1 symbol with its quiet zone is 23
  columns by 12 rows -- and **`large`** is two columns by one row, the same symbol
  at 46 by 23, twice the size on both axes. Those ratios are asserted rather than
  described: `should draw a module about square in both` divides the cell counts by
  the module span, and asserts the row count as `2 * cells - span === 1` rather
  than as a tolerance, because the pad below is a known half-row rather than
  noise -- a tolerance wide enough for it at version 1 is wide enough to hide a
  lost row.

  The ticket's "like 36 by 18" is version 4 with a one-module quiet zone, which is
  35 by 18 -- the shape this now produces, and the arithmetic above is where it
  comes from.

- **One column by one row is the squashed third form and is not offered.
  Braille is the interesting refusal, and it is falsifiable rather than
  asserted.** A `Dots` cell is 2x4, so a module would be half a column by a
  quarter of a cell -- square on both axes and four times smaller again, which for
  version 3 is 16 columns by 8 rows against the compact form's 31 by 16. It does
  not work,
  because a braille cell does not **tile**: the dots are discrete with gaps about
  as wide as the dots, so a dark region is a dotted texture rather than a module
  and a camera samples the gap as often as the dot. `Dots` is monochrome besides,
  which is one foreground for a cell that may hold eight modules of two colours.
  Measured rather than argued: a dot grid with a gap the size of the dot, built
  from a real symbol and handed to an independent decoder, **is not found at
  all**, where every form this component does offer is --
  `scripts/verify-qrcode-decode.mjs` prints that beside the other two
  measurements. Both it and the probe draw the braille form with the spec's
  **four**-module quiet zone rather than this component's one, and that is
  deliberate rather than stale: a wider quiet zone is the _favourable_ case for
  the form being refused, so a braille code nothing finds at four is nothing
  found at one either. The probe draws one anyway
  -- labelled as the form expected _not_ to scan -- because a refusal nobody can
  check is worth less than one somebody can.
- **One `text` element, and no `raw`, and the glyph set is the whole reason.**
  `▀` fills its upper half with the **foreground** and its lower half with
  the **background**, so `█ ▀ ▄` and a space spell all four
  combinations of two modules out of _one_ foreground and one background -- which
  the cascade supplies once for the whole code. A QR has two colours in it, not
  one per cell, so what a `raw` would buy is a colour per half-cell that nothing
  here needs. `largeTextView()` is the precedent and it is the right one: a
  `nowrap` text is one line per newline whatever room it was offered, so the
  intrinsic size falls out, the measurement is cached per resolved style, and
  there is no second implementation of what a string measures to. `Pixels` is the
  same answer one layer down -- it _is_ 1x2 half blocks with a colour per half,
  which is the compact form plus the per-half colour this does not want.

  What it buys on top is that the code is **copyable**: `selectable` defaults to
  false on a `raw`, which is right for a sparkline and wrong for a code somebody
  wants to paste into a chat window. So `drawsText` -- which the decrypt block and
  the multiline field are the two existing callers of -- never comes up, because
  there is no `raw` to say it on.

- **The quiet zone is in the matrix, and that is structural rather than tidy.**
  A light border on every side is what a scanner locates the symbol against. It is
  emitted as rows and columns of light modules rather than as CSS padding because
  padding is in **cells**: in the compact form one cell is two modules vertically
  and one horizontally, so a quiet zone counted in cells is one count on one axis
  and another on the other -- a per-form asymmetry a theme writing
  `.sigil-qrcode { padding: 1 }` would silently change, which is the number this
  file already records a theme must never be able to move. In the matrix a theme's
  padding can only _add_ to it.

- **It is one module, where the spec asks four, and the divergence is measured on
  both sides.** What four buys is a camera reading a _printed_ symbol at an angle
  through a blur, which is the medium the spec is written for. A terminal is not
  that medium: the symbol is crisp, axis-aligned, rendered at exact cell
  boundaries, and what a scanner is pointed at is a screen. Handed to an
  independent decoder as a clean bitmap, a code with **no** quiet zone decodes
  perfectly -- so a bitmap's own edge is not what a quiet zone is for. Put the
  same code in a field of **dark** cells, which is what a dark terminal is, and
  `quietZone: 0` is **not found at all** while **one module is enough**. So one is
  where it starts working rather than a guess under it.

  What four costs is eight cells on each axis: version 1 came out 29 by 15 around
  a 21-module symbol, which is more than a third of the width spent on margin in
  a medium whose surrounding page is already blank. At one it is 23 by 12. Both
  halves are asserted by `should put one light module on every side, and the
  spec's four where asked`, so neither the default nor the knob can move without
  the other being read -- and the 168-of-168 decode was **re-derived** at the new
  default rather than inherited from the measurement that chose four.

  `quietZone: 4` is the first thing to reach for when a scanner struggles and the
  `large` form is the second; `quietZone: 0` is still allowed, because a caller
  whose surroundings are already light has a real case. The demo prints one next
  to a wider one so the difference is a thing to try rather than a claim.

- **An odd module-row count gets one pad half-row, it is not a module, and it
  goes to the edge where it cannot be seen -- which is the one place the polarity
  reaches the geometry rather than only the glyphs.** A symbol is
  `4 * version + 17` modules on a side, which is odd for every version, and a
  quiet zone is added twice -- so the span is always odd and a half block per cell
  needs an even number. The alternative is a last cell holding one module and half
  of nothing.

  The pad takes no glyph, and **what an undrawn half cell _is_ differs by
  polarity**, which is the whole of it. Inverted it is the terminal's own
  background, which is the page: invisible at either end, so it goes _above_, and
  that puts the light border in a cell's lower half at both edges and makes the
  first line one uniform strip hugging the symbol. Painted it is the body's own
  `background-color: white`, which is indistinguishable from quiet zone -- so
  wherever it goes it _adds_ a module of border, and the odd span means the
  painted form always has two modules on one edge and one on the other. _Below_
  the grid is where that belongs: a thicker bottom border reads as the gap before
  whatever is printed next, where a thicker top one is the first thing a reader
  sees.

  Both halves were reported from a terminal rather than found by a test, one after
  the other, and each was invisible to every assertion in the file because they
  all read **glyphs** while the complaint is about **colour**. First, `drawn()`
  answered `invert` for a position with no module, so reading past the grid _drew_
  the pad -- which inverted made the last line of every compact symbol a solid row
  of full blocks. Then, with the pad above the grid for both polarities, the
  painted form came out with **two modules of border at the top and one at the
  bottom**: a first row twice as thick as the last, which is what "the first row is
  too thick" was.

  **And there is no arrangement with one module on both edges of the painted form,
  which is what made painting stop being the default.** The border is
  `2 * cells - size` half-rows, `size` is odd for every version, so the total is
  odd -- measured at versions 1, 3, 10 and 40 and quiet zones 1 to 4, it is 3, 5, 7
  and 9 and never even. An odd total cannot split evenly. A cell carries one style,
  so the pad half cannot be painted the page's colour; and an even span needs an
  odd _total_ vertical quiet zone -- `1` and `2` -- which puts a full cell on one
  edge again. So painted is `1, 2` and nothing else is available to it, where
  unpainted is `1, 1` because the leftover half-cell is the page. The entry below
  is what follows from that.

  `should keep the border one module at the top in both polarities` is what makes
  that a check rather than a sentence, and it reads the border back **off the
  rendered glyphs** rather than off the implementation, because the implementation
  is what was in question: each grid row is reconstructed from the half of the cell
  it landed in, a row is border when every module in it is light, and the pad
  counts as a module of border painted and as none inverted. Putting the pad above
  the grid for both polarities fails it, and so does putting it below for both. The
  parity itself is asserted arithmetically over quiet zones 0 to 6 rather than at
  one value, because it depends on both the version and the quiet zone and a single
  case cannot see that.

- **A QR code draws whichever modules match the terminal's own foreground, and
  painting its own two colours is the opt-in.** A scanner expects dark modules on a
  light background, and a terminal already has a light colour and a dark one: on a
  dark terminal the light modules are the foreground and the dark ones are the
  background, and on a light terminal it is the other way round. So the rule is to
  draw whichever module colour _matches the foreground_, which is
  `scheme === 'dark'` and nothing else -- and the result is correctly polarised
  block characters with not one escape sequence in them, at **every** colour level,
  with the quiet zone coming out as a border of drawn blocks on a dark terminal and
  as the page itself on a light one.

  It was the other way round for three commits, painting `color: black;
  background-color: white` above level 0 so that the two colours were known rather
  than borrowed. What that costs is the parity above: a painted code is a white
  rectangle of whole cells and its border can never be even. Reported three times
  from a terminal -- the quiet zone too wide, then the first row too thick, then
  the last -- and the third report is the one that could not be answered by moving
  anything, because `1, 2` is the whole of what painting can do. `paint: true`
  keeps it, for a terminal whose own two colours do not have the contrast a camera
  needs, which is the case it is actually for.

  The polarity rule is `polarity()` either way, and painting is the only branch
  that reads the **level**: it is the one destination with two colours of its own,
  so it draws the dark modules, and at level 0 even that is gone and it falls back
  to the terminal's. Everything else reads the scheme alone.

  It cannot be a cascade answer, which is worth saying because it looks like one:
  which **glyph** is drawn is content rather than style, and `inverse` is an
  attribute level 0 drops along with everything else. So the component reads the
  level and the scheme, which is what `table()` and `largeText()` already do --
  and the scheme defaults through `schemeFromEnv()`, the same function
  `themedCascade()` defaults it through, so the two cannot come to disagree about
  the same destination. `invert` overrides both, for a caller who knows something
  the level and the scheme do not say.

- **The right-hand quiet zone survives because of the background, and the two
  halves of that are different mechanisms.** `renderToString()` drops a trailing
  run of blanks that _show nothing_, and a blank with a background shows
  something -- measured, `ESC[30;47mab   ESC[0m` against `ab` for the same text
  without one. So a **painted** code's light column on the right is painted spaces
  and is kept; on a dark terminal the drawn form ends every line in drawn blocks,
  so there is nothing to drop; and on a _light_ terminal the trailing spaces really
  are dropped and the terminal's own background is the quiet zone, which is the one
  case where the right answer costs nothing. Each line's width is asserted painted
  and unpainted.

- **The sheet's fourth declared exception, and the only one that is a pair.**
  `.sigil-qrcode-paint { color: black; background-color: white }`, which is on the
  class `paint: true` adds rather than on the body, so a code that borrows the
  terminal's own two colours carries no colour at all. Neither of them
  is de-emphasis, a state or an accent, so no role could carry them -- which is
  the same shape `.sigil-caret`, `.sigil-scroll-track` and `.sigil-debug` are
  already written down as, and `should declare on a role, bar four exceptions that
  say why` moved from three to four with the reason. Palette indices rather than
  hex, which is the rule every colour in that sheet follows: the basic sixteen are
  whatever the user's terminal theme says they are, and a theme has to render text
  in black and in white, so whatever it renders them as has the contrast a camera
  needs. No light half, because the two colours are not read against the
  terminal's background at all -- the background _is_ one of them.

- **No colour in its props, which is a test rather than a convention here.** A
  prop beats a sheet per property, so a colour written into the tree is one a
  theme cannot reach without `!important`. `should carry no colour in its props,
  so a theme can reach it` walks the props of both nodes for anything matching
  `/colou?r/i` -- and asserts the class is there, so the absence is a statement
  about a reachable element rather than about an empty object.

- **There is no `@ttylabs/sigil/qrcode` subpath, for `parseFlf()`'s reason.** It
  would be permanent API surface whose only consumer is the component beside it,
  and the property that makes the encoder testable is that it is a pure function
  rather than that it sits behind a module boundary. One file is also one
  `sigil add` entry, so ejecting the component takes the encoder with it -- which
  is what somebody ejecting it wants. The masks under `@ttylabs/sigil/canvas` are
  the same call made the other way and for the same reason: a mask is used _with_
  a canvas, and an encoder is used with the component that draws it.

- **Segments are deliberately not mixed, and what that costs is 31 measured
  payloads rather than an argument.** A payload split into a numeric run and a
  byte run can be a version smaller than one segment of either. `QR_SEGMENTS` in
  the fixture is the same payloads through a reference encoder's own segment
  optimiser and through one segment: **29 of 31 are the same version either way**,
  including an https URL, an otpauth URI, a vCard and a WIFI credential.
  `tel:+15551234567` is one version larger here, and `id ` followed by a hundred
  and twenty digits -- the worst case the shape has -- is **version 8 against
  version 4**. So the decision is free for what a CLI draws and is not free for a
  payload that is mostly one long run of a narrower mode. The shape of the fix is
  a dynamic program over the three modes per version, iterated over the versions
  because the count indicator widens at 10 and 27; it wants a caller who has met
  the second case. The first version of this entry said instead that the split was
  "an optimisation problem whose answer nobody can check by looking at it", which
  is a weak reason for a thing that has a reference to check it against -- the
  numbers replaced it, and a review round then caught the docblock still saying
  "26 of 28" after three vectors moved it to 29 of 31 -- which is a measurement
  the test beside it already falsified, and is the exact shape this file keeps
  warning about.

  It is also what the reference comparison had to be corrected for. The first run
  disagreed with the reference on exactly one of 22 vectors, the otpauth URI, and
  the obvious diagnosis -- that `qrcode`'s penalty rule 4 is `|ceil(pct/5) - 10|`
  where the spec's is `floor(|pct - 50| / 5)`, which really do differ on the
  dark-heavy side -- was **wrong**: computed per mask over that symbol, both
  formulas pick mask 6. What differed was the _bit stream_, because the reference
  had split the payload and this encoder had not. So the fixture asks the
  reference for **one segment in the mode this encoder picks**, which is a
  like-for-like comparison, and the optimiser's answer is kept beside it as the
  cost above. The lesson is the one this file keeps recording: the first
  plausible mechanism for a disagreement is a hypothesis to measure rather than a
  conclusion, and here the measurement took one script and the wrong conclusion
  would have shipped a rule-4 formula copied off another encoder's bug.

- **Kanji mode, ECI and structured append are out.** Kanji encodes a Shift-JIS
  double byte in 13 bits, which is a second character-encoding table for a mode
  that only pays for text that is entirely Japanese -- and the reference encoder
  does not use it either for a `日本語` payload, which is what says byte mode with
  UTF-8 is what readers expect. An ECI header declaring UTF-8 is legal, ignored by
  some readers and refused by a few. Structured append needs a way to draw several
  codes and a reader that reassembles them, and nothing has asked.

- **An empty payload is refused rather than drawn.** `renderFiglet('')` answers
  `[]` and `table([])` answers `''`, so the house precedent for "nothing to draw"
  is to draw nothing -- and a QR is different, because an empty string encodes
  perfectly well into a _valid symbol that scans to nothing_. A caller
  interpolating a value that turned out to be empty gets told where, rather than a
  code somebody photographs twice. That is the `PromptError` rule: a thing with
  nobody to answer it fails loudly.

- **So is a payload that is not a string, and for the same reason one step
  earlier (SIG-302).** Only `''` was refused, and everything else was turned into a
  string on the way in -- `RegExp.test()` and `TextEncoder` both stringify what
  they are handed -- so `qrcode(user.inviteUrl)` with the field missing drew a
  valid code that scans as the word `undefined`, and `null`, `42` and `{}` scanned
  as their spellings. That is the empty string's failure with a word in it, and it
  is harder to see, because the code still prints. It is a `TypeError` checked at
  run time, which the types already rule out and which the options beside it are
  checked at for the same reason: a caller in plain JavaScript, or holding an
  `any`, has no type to stop it. A number is refused rather than read as its
  digits, because guessing what a caller meant is the thing a QR code cannot
  afford -- `String(n)` is one call away.

##### How the codes were established to be scannable

Three layers, and only the third needs a camera. This is the component whose
correctness no test in this package can state, which is the position
`--clipboard` is already in one layer along.

- **And the fixture itself, against the spec rather than against the encoder.**
  The reference matrices are 160 kB of data that nothing in this repository read:
  a mangled row, or metadata transcribed onto the wrong matrix, would make every
  agreement with them worthless. `checkStructure()` is written from the spec's own
  rules -- the three finders with their separators, both timing patterns, the dark
  module, the alignment centres, both copies of the format information computed as
  BCH(15,5) over `0x537` XOR `0x5412`, and both copies of the version information
  as BCH(18,6) over `0x1f25` -- and is applied to **two** subjects: every reference
  matrix, and the encoder's own output for all 160 version-and-level combinations.
  The duplication is the point, which is the reference fixture's argument one layer
  along: a check that asked the encoder where its finders go would answer yes
  whatever they were.

  It came out of the second review round's **worklist** rather than from a finding,
  and it strengthened the encoder's side as much as the fixture's: the
  160-combination test used to check the finders, the timing patterns and the dark
  module, so the alignment patterns and both information areas were covered only
  for the eight versions the vectors happen to reach. Three mutations were added
  for it and all three are caught -- an alignment pattern drawn in the corners a
  finder owns, an alignment pattern with a solid inner ring, and the centres
  starting one module in from the far edge.

  The first version of the check reported **107 problems in a fixture with nothing
  wrong with it**, because it built alignment centres for version 1, which has
  none. Worth recording because the failure mode of a checker is to be wrong about
  the thing it is checking, and the only reason it was not believed is that every
  failure was the same version and the same pattern.

- **The matrix, against an encoder that is not this one.** Twenty-four reference
  symbols in `test/components/qrcode-vectors.ts`, generated with `qrcode@1.5.4` --
  the most widely used JavaScript QR encoder -- and compared **module for
  module**, with the version, the mask and the mode. A decoder written beside the
  encoder from the same mental model passes green forever on an assumption wrong
  in both, which is the failure this file already records for the canvas diff's
  model terminal; a matrix that is byte-identical to somebody else's also implies
  every property such a decoder would have checked, which is why a round-trip
  reader was written, read, and **deleted** rather than kept: it duplicated two of
  the encoder's own 40-entry tables inside the test file, which is the drift this
  file warns about, for a claim the comparison already makes.

  The twenty-four are not a sample, and two more payloads sit beside them whose
  _version_ is asserted without their matrices, for the size reason the fixture
  records. They are the spec's Annex I example; the
  alphanumeric example every tutorial publishes; an ordinary URL; one character at
  L and at H; a numeric tail of one digit; lower case where the upper case would
  be alphanumeric; every alphanumeric punctuation mark; multi-byte UTF-8; astral
  characters; Japanese in byte mode; a real otpauth URI; one digit; one space; the
  punctuation alone; exactly what version 1-L holds and one digit past it; version
  7, the first that carries version information; version 22, which is many blocks
  of two sizes in band 1; version 40 twice, for the 14-bit count indicator and the
  81-block interleave at H; and three the sabotage pass asked for, below.

- **The drawn glyphs, through an independent decoder.** The reference above checks
  the matrix and says nothing about the _drawing_. So the component's own output
  is turned back into the pixels a terminal would paint -- a half block becomes one
  column by two pixel rows, a large module two columns by one -- and handed to
  `jsqr`, which is a locate-and-decode pipeline that knows nothing about this
  encoder. **168 of 168 decoded**, over seven payloads, four error-correction
  levels, both forms and all three destinations -- unpainted against either scheme
  and painted -- each one required to come back as the exact string that went in.
  That is as close as software gets to the phone check, and it is the thing that
  makes the polarity decision and the glyph table claims rather than hopes.

  It decodes with `inversionAttempts: 'dontInvert'`, and that is what makes it a
  check of the **polarity** rather than only of the modules. jsqr attempts both by
  default, so a component drawing the opposite modules builds a negative image it
  reads anyway -- measured, the level-3 row went on passing after painting stopped
  being the default and its expected polarity had gone stale, which is the
  fixture-cannot-reach-the-branch shape arriving in a by-hand script. Each
  destination now names the scheme explicitly too, since `schemeFromEnv()` would
  otherwise make the answer depend on the machine. Flipping one row's expected
  polarity fails 56 of the 168.

- **The exhaustive walk names its mask, which is faster _and_ better coverage.**
  `should produce a well-formed symbol for every version at <level>` took **4.7s**
  as one body over all 160 combinations
  against this package's 10s `testTimeout`, and 87% of it was choosing a mask:
  3,989ms against 472ms for the same 160 encodes, because choosing scores all eight
  over the whole symbol and version 40 is 177x177 read four times per mask. Two
  seconds of headroom is a test decided by what else the machine is doing, which is
  the shape `should cap the acceleration` is already written down for -- and this
  one was **reported failing** rather than caught here, because 18 vitest workers
  on a busy machine is a load a quiet local run does not reproduce.

  Choosing is not what the walk is for: it is the per-version tables, and mask
  _selection_ is pinned by the 24 reference symbols, each of which asserts
  `code.mask` against another encoder's. So the mask is named -- and **cycled**,
  `version % 8`, which is what makes it the better answer rather than only the
  cheaper one: `checkStructure()` reads the mask back out of the format
  information, so what the mask varies is the format BCH, and the penalty score
  over `'x'` reaches **seven** of the eight masks and never 5, where cycling
  reaches all eight twenty times each. Measured: **815ms**, with the next slowest
  test in the file at 201ms.

  **And then it is four tests, one per level, because a deadline is per test and
  a 10s one is calibrated on a quiet machine.** 815ms was a 12x margin and it was
  not enough: the walk timed out on **one job of nine** -- node 26 on macOS --
  over a tree the other eight passed and that had passed 9/9 as a pull request,
  which is the signature of a machine rather than a regression. The runner's own
  log is what says so, and it is worth quoting because the ratio is the whole
  finding: the suite took **100.52s** against about 8s locally and this file
  **34,890ms** against 2,670ms, so it ran ~13x slow -- and 814ms times 12.5 is
  10.2s, just past the line.

  So the fix is the one `should cap the acceleration` already records -- make the
  body cheap rather than move the deadline -- and here it costs **nothing at all**,
  which is what makes it the right one: the same 160 combinations run, each body
  is about 200ms, and the margin goes from 12x to 50x. Raising `testTimeout`
  was the other option and it is refused for the reason the deadline exists: it
  hides the quadratic blowup, and a suite whose slowest test is 200ms wants a
  deadline it cannot reach rather than one calibrated against the worst runner
  anybody has met.

  By **level** for two measured reasons. The cost is even that way, because the
  symbol size is a function of the version alone -- 207/207/208/208ms, which is
  the walk in quarters -- where splitting by version band would put most of it in
  27-40, since cost grows with the square. And each test still cycles
  `version % 8` across all 40 versions, so every one of the four reaches all
  eight masks five times and the twenty above is still the walk's total. All
  three `alignmentCentres()` sabotages are still caught after the split, run one
  at a time: the centres off by one, the count formula, and the version 32 step
  that no other version can reach.

  The script is **committed**, as `scripts/verify-qrcode-decode.mjs`, for
  `benchmark-paint-cull.mjs`'s reason read one layer along: a number in a pull
  request is a claim the next reader has to trust, and a script they can run is
  one they can check. `jsqr` is **not a dependency** of anything -- it is installed
  by hand into a directory outside this repository and passed in, which is how the
  fixture says to regenerate itself and for the same reason: zero production
  dependencies is a hard constraint, and a devDependency taken for a by-hand
  script is still a dependency somebody has to explain. It reproduces all three of
  the numbers this section rests on -- the 168, the quiet zone's boundary and the
  braille refusal -- so none of them is a figure only this branch could produce.

- **The phone, which is `scripts/terminal-probe.mjs --qrcode`.** Six steps, each
  with its own `the claim:` line, and the whole mode says in as many words that
  the check is to scan them. What is genuinely left for a camera is three things
  and they are named: whether your **font** draws a contiguous half block --
  `▀` and `▄` have to meet exactly and several draw them a pixel short
  at small sizes, which is a light seam through every second module row and is the
  one failure the compact form has that the large form does not; whether your
  **colours** have the contrast a camera needs, since the code is drawn at palette
  index 0 on index 7 and those are your theme's; and whether the quiet zone earns
  its place where you are. Two steps are expected to be _harder_ or to fail -- the
  code with no quiet zone, and the braille form -- which is what makes the mode
  falsifiable rather than a demonstration.

> Moved: _What the sabotage pass found, and what it got wrong about itself_, _What the first review round found, and it was almost all prose_, _What the second review round found, and what it could not_ — see [docs/history/the-built-in-components.md](../../../../docs/history/the-built-in-components.md).

##### What is deliberately out

- **Mixed segments**, with the 31-payload measurement above and the shape of the
  fix named.
- **Kanji mode, ECI and structured append**, each with its reason above.
- **A braille form**, with the measurement above -- and drawn in the probe so the
  refusal is checkable.
- **A one-cell-per-module form**, which is the squashed one.
- **A mounted form.** A QR code does not animate: it is a thing printed into a
  log beside everything else, which is why the facade is a string the way
  `table()` and `largeText()` are and why there is no `createQrcode()`.
- **A capacity function.** `qrCapacity(version, ecc, mode)` is genuinely useful
  to a caller deciding whether a payload fits before encoding, and nothing has
  asked -- which is the rule `which` waited eighteen months on. The error a
  payload that does not fit gets names the level and says a lower one holds more,
  which is the thing a caller can act on.
- **Pre-split segments as an escape hatch.** `encodeQr([{ data, mode }, ...])`
  would be the honest way out of the single-segment decision and is API surface
  with no caller; the day somebody has the `tel:` case is the day to add the
  dynamic program instead, which needs no new surface at all.

#### A command palette: the registry read as a list

SIG-112 split this out because it had one unresolved question -- runtime or
`sigil add` -- and the answer is measured rather than argued. The feature is
three layers with a seam between each: `src/components/fuzzy.ts` is the ranking,
`src/components/catalog.ts` is the catalog, and `src/components/palette.ts` is
the UI over both plus the prompts that collect what the chosen command needs.
`fuzzyMatch()` itself has since moved to `src/util/fuzzy.ts`, because the parser
became its second caller and may not import `src/components/` -- see the SIG-143
entry; what is left in that file is `rankBy()` and `highlightRuns()`, which is
the half a list and a highlight need.

- **There is no second catalog, and that is the whole claim.** Names, aliases,
  descriptions, `hidden`, arguments and required options are all things the app
  already told the **parser**, so `commandCatalog()` reads the initialized
  registries back -- at `cmd[Internal]`, which is the shape the parser matches
  against -- exactly as help reads the context chain rather than a separate list
  of what a command inherits. It is checkable rather than a sentence: `should
  read the description off the registry rather than off the declaration` sets a
  `desc` from an `init` hook and the entry carries the hook's, which a palette
  reading a declaration could not do.

  That is the thing neither Ink nor OpenTUI can do cheaply, because neither owns
  an argument parser, and it is why this was worth building for its own sake
  rather than for the feature.

- **The packaging answer is `@ttylabs/sigil/components`, and the measurement is
  what decided it.** The question is what it costs an _unbundled_ app that
  imports the components barrel for a spinner and never opens a palette, so what
  was measured is the transitive static import byte weight of each entry's own
  graph -- the method `test/dist.test.ts`'s `what importing the package costs`
  already uses, and the one the `seeded()` move and `ScrollBox`'s 3.4 kB were
  measured with.

  |                                                      | bytes       | modules |
  | ---------------------------------------------------- | ----------- | ------- |
  | `components.mjs` without the palette                 | 224,288     | 21      |
  | `components.mjs` with the palette in the barrel      | **234,912** | 23      |
  | `components.mjs` with it on `@ttylabs/sigil/palette` | 214,833     | 22      |
  | `palette.mjs`, that subpath's own graph              | 196,981     | 24      |

  So the palette costs the barrel **10,624 B**, and it is accounted for: its own
  code in `components.mjs`, the 1,778 B `transform` chunk, the 154 B `types`
  chunk, and **180 B of class names in `FRAMEWORK_CSS`**, which ships because the
  vocabulary comment is inside the template literal. A subpath would give an app
  that never opens one most of that back, and it is refused by the standard this
  file already set when it measured a subpath _per component_ at about 15 kB of
  124 and kept the barrel. A bundled app pays nothing: a rolldown of an entry
  importing only `createSpinner` comes to **126,679 B** and holds neither
  `commandCatalog` nor the palette's own `No commands match` -- nor, re-measured
  after the merge, `encodeQr` or `qrcodeView` -- so what a bundled app keeps is the
  180 B of sheet comment and nothing else.

  **Every figure here has been taken again after every change that moved it, and
  the merge with the QR code is the fourth.** The table read 223,912 / 214,804 /
  196,257 before the first review round, 224,272 / 214,833 / 196,597 before the
  second and 213,649 / 224,657 / 214,833 / 196,981 on the branch -- and the
  baseline then moved **again** when SIG-136 landed, because a QR encoder in the
  same barrel is 10,255 B of it. The two rows measured against the old baseline
  are kept above for what they are, which is why the first row is now named for
  what it is rather than for `main`: a figure that could only be re-derived by
  checking out a commit nobody has is the stale snapshot this file warns about,
  and the delta is the part that survives a moving baseline. It moved too --
  10,263, then 10,623, then 11,008, now 10,624 -- because what the barrel chunks
  shared code into moves with what else is in it, which is the reason to re-run
  the measurement rather than to carry the number.

- **It does not import the parser, which is the finding rather than the
  worry.** Nothing in `src/components/` had ever imported `src/parser/`, and the
  obvious reading of "a palette reads the command registry" is that it must. It
  does not: it reads them through the `Internal` symbol, which is `src/types.ts`
  and a **154 B** chunk, and it coerces a value with `transformValue()`, which is
  `src/util/transform.ts` and a **1,778 B** chunk. Neither is in `src/parser/`.
  Measured from the other side as well -- importing `parse` itself takes the
  graph to **253,201 B**, about 18 kB more than the barrel that holds the palette
  -- the 29 kB this said is that figure against the _without-palette_ row, which
  is the wrong baseline for it -- and fails the test written for it.

  `src/help/` is the precedent and it reaches further: it imports
  `OptionRegistry` as a _value_, which is a 7,206 B chunk on its graph. So a
  component reading what the parser built is a direction of dependency this
  repository already has, one layer along.

- **It is ejectable since SIG-201, and for most of its life it was not.**
  `sigil add` rewrites a component's relative imports to the published subpath
  that answers for each, and `generate-registry.mjs` refuses a deeper specifier
  **by name**, so adding the palette to `ENTRIES` used to fail the build on
  `../util/transform.js`: the map is built from the tsdown entry list, which had
  no `src/util/` path at all. That refusal was pointing at the real reason --
  the one thing the palette must share with the parser is the function that says
  what a valid value is, so an ejected copy would either import something
  unpublished or carry a **second** reader of the coercion rule. "No second
  catalog" and "no second validator" are the same claim.

  The answer was to publish the one function rather than to let a copy carry its
  own: `@ttylabs/sigil/coerce`, recorded under "`@ttylabs/sigil/coerce`: the
  parser's coercion, published on its own" in `src/parser/AGENTS.md`. The other
  relative import the generator stopped on, `../types.js`, needed no new
  subpath: the root entry does `export * from './types.js'`, so the generator
  now maps `src/types.ts` to `@ttylabs/sigil` (`BARRELLED` in the script). What
  an app that wants only the palette's _appearance_ has is still the ladder this
  file records -- restyle a class, override a prop, or build its own tree over
  `commandCatalog()`, `rankBy()` and `highlightRuns()`.

- **The palette answers with an argv and runs nothing.** Running a selection is
  dispatching a command, which `main()` already does, so `commandPalette()`
  resolves with the argv a person would have typed and the caller passes it to
  `main({ argv })`. That framing is what settles every value question below:
  **the palette types what you would have typed**, so a `choices` list an app
  declared wrongly is refused by the parser here exactly as it is from a shell,
  and nothing in the palette is a second opinion about what a value means.

- **`checkSlotValue()` is the one place a value is asked about, and it asks
  `transformValue()`.** The same function the parser coerces with, so there is one
  answer to "is this valid" rather than a validator that drifts from the parser;
  `choices` is compared against the **coerced** value, which is what
  `assertChoices()` does. What it does _not_ do is keep the coerced value -- the
  string goes into argv and the parser coerces it again, so the parser stays the
  only producer. The messages are the parser's own words, asserted as such:
  `Invalid integer: eight`, `Invalid date: "2024-02-30"`.

  Every value a **field** collects goes through it, **including a declared
  choice**, and for one commit
  it did not: the choices branch spelled a choice with `tokenOf()` and offered it
  unchecked, so a `yesno` argument declaring `choices: [true, false]` was offered
  as `true` and `transformValue('true', 'yesno')` throws -- the palette agreeing
  to a value the parse then refused, which is the one divergence the whole design
  is written against. Found by review, and it made the sentence above false of
  exactly the path a reader would not check.

  The **one** value that does not go through it is a required `bool` or `yesno`,
  which `confirm()` answers and which returns its token straight -- and that is
  safe by construction rather than by checking, because the token is built from
  the type: `yes`/`no` for a `yesno` and `true`/`false` for a `bool`, which is
  exactly the vocabulary each one takes. This entry said "every value" for three
  rounds and a third review round caught it, which is the shape worth noting --
  a universal claim about a function with four callers, falsified by reading the
  fourth.

  Two things came out of that. `tokenOf()` is **type-aware** -- a `yesno` boolean
  is `yes`/`no`, because that is the vocabulary the type takes -- and
  `offeredChoices()` leaves out a choice the check refuses rather than offering
  it. Hiding one is the smaller loss; where it hides them all, `select()` rejects
  by name, which is the right answer for a declaration with no value argv can
  reach. A `date` or a `json` declaration with `choices` is exactly that, because
  `assertChoices()` compares a `Date` and an object by **identity** -- which is
  true of a command line too, and is one of the parser's oddities this inherits on
  purpose rather than papers over.

- **A positional value the parser would read as an option is refused, and that is
  the parser's property surfaced rather than a rule this invents.**
  `optionLikeRE` is `/^--?\w/`, so `-5` and `-foo` arrive as options whatever slot
  they were meant for, and a command line cannot express them either -- `--`
  makes what follows it an _extra_ argument rather than a positional one.
  Accepting one would hand the parser an argv it misroutes, which is the
  divergence the design is written against. An **option's** value is attached
  with an `=`, so `--port=--weird` is fine: the parser splits on the first `=`
  and takes the value exactly as typed.

- **A required option is a slot too, and it is the whole **chain**'s options
  rather than the command's own.** A required option is a value the command needs
  exactly as an argument is, so a palette that listed such a command and did not
  ask would hand the parser an argv it refuses -- `Missing required options`, out
  of a list whose job is to offer things that work. That is outside the ticket's
  scope on purpose.

  The chain is the half that shipped wrong. `validateOptions()` flattens **every**
  context's options and reports a required one with no value, so a root-level
  `'--config <file>'` with no default is enforced when a subcommand runs -- and
  `slotsFor()` read `cmd[Internal].options` alone and asked for none of it. The
  second review round found it, pointed at `parse.ts` rather than at the diff, and
  it is the one defect either round found that the whole design was already
  written against. Pinned end to end: the palette's argv for a `build` under such
  a root parses.

  Arguments are the other way round and are the command's **own**:
  `processArgs()` reads the positional values against `contexts[0]` alone, which
  this file already records as "an ancestor's arguments are never read once a
  subcommand is dispatched, so they own nothing".

  What counts as answered is `processOptions()`'s precedence read back, which is
  sharper than "has a default": an option answers for its destination when it has
  an environment value, or a `default` **the parser will apply** -- and
  `skipDefault` is how a negated twin gives the destination up to its valued twin,
  so the twin's implied default answers for nothing. A destination a nearer
  declaration already fills is not asked for twice, because what
  `validateOptions()` reads is the destination rather than the option -- so two
  contexts both declaring `--config` is one question, asked under the nearer
  spelling, which is also the one argv reaches. A **required argument**, or an
  optional one with a fallback of its own, answers for its destination too, which
  is the "an option and a positional argument of the same name" pair this file
  already records. An optional argument with neither is deliberately not counted,
  because over-skipping is the direction that puts the defect back.

  A **negated** flag is never among the questions and needs no guard: a flag
  always has an implied default, and `validateOptions()` reads the destination the
  valued twin fills.

- **A slot is a projection rather than the declaration, and the two kinds are one
  shape.** An argument and a required option differ in how a value reaches argv
  and in nothing else a prompt cares about, so `PaletteSlot` carries `choices`,
  `desc`, `label`, `multiple`, `required`, `spelling` and `type` and there is one
  prompt builder rather than two that have to agree. Plain data, so a test writes
  one. `type` is `OptionDataType` rather than `ArgDataType` because it is the
  wider of the two -- an option may be a `count` and an argument may not.

- **`spelling` is a dashed spelling and not the bare name**, because
  `OptionRegistry` keys its lookup on what gets typed: an option declared
  `'-p <n>'` is _named_ `p` and has no long spelling, so `--p=5` resolves to
  nothing while `-p=5` does.

  Preferring a long name that is not a `no-` form is a **preference with a
  fallback**, and it shipped as a _filter_ -- which dropped a required option on
  the floor. `initOption()` rewrites a `no-` name only for a flag, so a valued
  `{ format: '--no-color <when>' }` keeps `--no-color` as its only spelling: the
  filter answered nothing, `slotsFor()` skipped the slot, and the palette emitted
  an argv the parse refused with `Missing required options`. Found by review, and
  it falsified two comments at once -- the preference's own, which said both
  spellings resolve, and `spelling === undefined`'s, which said it cannot fire.
  Both spellings do resolve; the filter was what made the second one reachable.

- **An optional slot always gets a prompt that can be left empty, which is one
  sentence where there were four cases.** `confirm()` always answers, so it is
  used only for a **required** `bool` or `yesno` -- an optional one is a text
  field, or the declaration's own default would be unreachable. A `choices` list
  has no way to say "none of them", so an optional one gets a `(skip)` entry in
  front of it. And the token words are each type's own: `true`/`false` for `bool`
  and `yes`/`no` for `yesno`, because `transformValue('true', 'yesno')` **throws**
  -- which is the sharp edge of sharing one function, and is pinned.

- **A variadic slot is a `multiline()` field, one value per line.** Splitting one
  answer on whitespace was the alternative and cannot express a value with a space
  in it; a line each can. What this cannot express is a value containing a
  newline, which is the smaller loss.

  It is asked again until every line is one the parser takes, which is `text()`'s
  own validate loop one level up -- and that is two halves the first version had
  neither of. A multiline field has no `validate`, so the complaint goes in the
  **message** and what was typed comes back as the **`initial` value** to be
  fixed; the loop used to discard the parser's own message and reopen an empty
  field, which is a field that refuses an answer without saying why. Found by
  review.

  A line is a value and an empty line is not a line, and the lines are **not
  trimmed**: `processArgs()` does not trim a positional value, so trimming would
  make the palette hand over something other than what was typed -- the one thing
  it promises not to do -- and would drop a line of spaces, which is a value
  somebody can write on a command line. Also found by review, and pinned by
  `should not trim a variadic value, which the parser does not`.

- **Positional arguments stop at the first one left empty.** A positional slot
  cannot be skipped _over_, and `initArgs()` already promotes an optional argument
  sitting before a required one -- so once one is left out every argument after it
  is optional too and leaving them out is the only coherent reading. The option
  slots are not positional and are asked for either way.

- **`deferred` is the question a palette has, and `loaded` was the wrong one.**
  `cmd[Internal].loaded` says whether `loadCommand()` has _finished_, and it
  starts `false` and is only ever flipped by a dispatch -- so an ordinary inline
  command that argv never named reads as unloaded. Reading it that way stopped the
  walk at the first level and listed every namespace as a command that might have
  a `run`; measured on the demo, `db` was listed and `db migrate` and `db seed`
  were not. What a palette has to know is whether anything is still outstanding,
  which is `loaded` **or there never was a module** -- a `path`, a `load` or a
  `dir`. Found by running the demo, which is the argument for having written one.

- **Nothing is imported to fill in a list.** A command whose module has not been
  read is listed by name alone with no description, which is exactly what help
  does and is the whole of what the deferral buys: a routed tree of sixty commands
  costs one `readdir` per level argv named, and a palette that imported every
  module to draw one frame would spend the saving. Such an entry still **runs**,
  because `parse()` loads the command when argv names it. Asserted by counting the
  loader's calls rather than by reading the list.

  What it costs is that an unread branch lists one level deep, which is help's own
  limitation. An `expand` option that awaited `loadCommand()` is refused for the
  reason the measurement is here at all.

- **A namespace is a command that _holds others_ and runs nothing, which is not
  the same as one with no `run`.** The first gate was "has a `run`", and it left
  **`help`** out of the list -- the one command every schema gets for free, which
  the parser dispatches by setting `state.help` rather than through a handler. So
  a leaf with no `run` is listed and a container is not, and `namespaces: true`
  offers the containers too, because selecting one prints its help and that is a
  coherent thing to do.

- **A `hidden` command takes its subtree with it, and a hidden _context_ does
  not.** `hidden` means "not listed", and a list that named a hidden command's
  children would have named the branch anyway -- one `!` prefix hiding a subtree is
  what somebody writing one means. The exception falls out rather than being
  arranged: a context is in the chain because argv named it, so its subcommands are
  listed from there. A command you are already running is not hidden from you, and
  the alternative is an empty palette at the level you are standing on.

- **The path is from the root, and the chain is walked outward.** `contexts` is
  innermost-first and ends at the root, so the path to a context is that slice
  **reversed** -- which one level of nesting cannot see, since a one-element list
  reverses to itself, and is why the test for it is three deep. Nearer context
  first is help's rule for `Global options` and for the same reason. The path
  matters because commands resolve against the innermost context _only_ -- `mycli
  db build` does not reach the root's `build` -- while dispatching `['build']`
  from the start does.

- **The cycle guard is what bounds the walk, and a second path-keyed dedup could
  never fire.** A registry holds initialized commands and `initCommand()` hands
  one straight back, so a declaration naming a command already in its own subtree
  builds a cycle rather than a copy. There _was_ a `paths` set beside it and a
  sabotage said it was dead: every parent is walked at most once, so a path and a
  child name cannot be produced twice. It is gone. What the surviving guard costs
  is that it is path-**insensitive**: one command registered under two parents is
  listed under both and its own subtree is listed under whichever path the walk
  reached first. Written down rather than fixed, because a path-keyed guard would
  be unbounded on a cycle again.

- **The walk descends unconditionally, which the sabotage pass also found.**
  There was a `!deferred` guard on the recursion, and it changes no answer for a
  directory nobody has walked -- the registry is empty -- while for a placeholder
  that declares subcommands **inline** it hid commands that are real:
  AGENTS.md already records that a placeholder's subcommands are handed over
  already built. So the registry is read whatever it holds, and `deferred` is left
  deciding the entry's own field and the namespace gate. `should list a
  placeholder's inline subcommands, which are real` is the pin, and it needs both
  halves -- without the deferred test the parent is read as a namespace and left
  out.

- **Ranking is a subsequence match with three bonuses, and it is fzf's
  `FuzzyMatchV1` in miniature.** A forward greedy pass to find where the match
  ends, a backward pass from there to find the tightest start, and a third to
  produce the indices -- because greedy alone gets the common case wrong: `ate`
  against `allocate` matches `a` at 0, `t` at 5 and `e` at 7, where the
  consecutive run at the end is what anybody means. A full dynamic program would
  be exact and is not worth it over a few dozen commands. The third pass needs no
  bound and must not be given one, because the backward pass placed every query
  character inside the span it walks.

  The bonuses are a **prefix** hit, a **word boundary** -- after anything that is
  not a letter or a number, and at a lower-to-upper transition, so `migrate` in
  `db migrate` and `Db` in `runDb` are both one -- and a **consecutive** run. The
  order is pinned as a relation rather than as three numbers: a prefix beats a
  boundary beats neither.

- **The table of orderings is the ticket's own ask, and two of its rows are
  filters.** `dbm` over `['db migrate', 'dumb', 'db seed']` is one row, because
  `dumb` holds d, b and m and not in that order -- so the ranking is the filter as
  well as the order. The ties are the length tie-break: `d` over
  `['build', 'deploy', 'db']` is `db`, `deploy`, `build`, where the first two score
  identically and the shorter one wins.

- **An empty query returns the list unsorted, which is not an optimization.**
  Every candidate scores zero, so the length tie-break would put `db` ahead of
  `db migrate` and reorder a list nobody had filtered -- and a catalog is already
  in an order somebody decided. Pinned both ways.

- **The query is taken exactly as typed and is never trimmed or split.** A space
  in it matches a space in the candidate, so `db mig` finds `db migrate` and a
  query of one space ranks everything with a space in it and nothing else.
  Tokenizing would be a second grammar for a reader to hold, and "the whole query
  is a subsequence" is the version nobody has to be told.

- **Matching is per code point and highlighting is per grapheme cluster, and the
  split is forced.** Code points are the unit every fuzzy matcher uses and the one
  that cannot match half a surrogate pair; clusters would be the wrong unit for
  matching, because a query of `e` would then not match a decomposed `é`. But a
  **run** has to be a cluster, because a lone combining mark in a `text` of its own
  measures zero columns and the grid refuses it a cell -- the mark would simply not
  be drawn and the highlight would have eaten a character. So `highlightRuns()`
  marks a cluster when any of its code points matched, and the two are pinned
  together end to end.

  The code-point walk inside it is the one guard a sabotage found untested: with
  `cluster.length` in place of `[...cluster].length` the cursor drifts by one per
  astral character, and the input that sees it is an index **after** a surrogate
  pair -- `highlightRuns('😀ab', [1])`, where the broken reading highlights the
  emoji and not the `a`. The obvious fixture, with the index _inside_ the pair,
  agrees in both readings.

- **Case folding is `toLowerCase()` and never the locale variant**, for the reason
  `camelCase()` already records: the locale one reads the process locale, and in
  Turkish and Azeri `i` cases to `İ` -- so a query of `i` would stop matching an
  `I` on a machine set to `tr-TR` and nowhere else. The result may be longer than
  one code point, which is why it is only ever compared and never used to index.

- **An alias ranks a command without being shown.** `PaletteEntry.search` is the
  label and then the aliases, and `highlightRuns()` ignores an index past the end
  of what it is given -- so a hit in the alias tail highlights nothing and the
  command is still found. What it costs is the one `rankBy()` records: a command
  with aliases loses a score **tie** to one without, which decides nothing but the
  order of two equally good matches. The description is shown and **not** matched,
  because matching prose makes a ranking unpredictable and the label is what gets
  typed.

- **The rows are kept and reordered with `order`, not rebuilt.** One element per
  catalog entry, for `For`'s own reason: a row that is still in the list is the
  same row, so keeping it keeps its resolved style and its text measurement, both
  of which are keyed on the style object and are worth nothing to a fresh element.
  `order` changes where a child is **placed** and not where it lives, so
  `result.children[i]` still answers for `node.children[i]` and nothing above has
  to match a box back to a row that moved. The one input that sees it is a query
  whose ranking disagrees with the registry's alphabetical order -- `z` over
  `['az', 'zz']`.

  Every row is turned off before the ranked ones are drawn, or a row the query no
  longer matches keeps the place it had. And the label box is **emptied** before
  its runs are rebuilt, or two draws over one row read as `buildbuild` -- which the
  obvious description test could not see, because `/build\s+build the app/` matches
  the doubled row starting at the second `build`.

- **`rows` goes through the multiline field's own cap rather than a second
  rule.** `promptRowCap()` is `rows >= 1 ? Math.floor(rows) : fallback`, which is
  what refuses `NaN` -- every comparison against it is false -- and what floors a
  fraction. This read `Math.max(1, opts.rows ?? ...)`, and `Math.max(1, NaN)` is
  `NaN`: `rank >= NaN` is false for every row, so the list went **blank** while
  `shown.length > 0` kept the empty message hidden, and Page Up put `active` on
  `NaN` so Enter stopped answering. `rows: 2.5` was the smaller cousin and showed
  three rows. Found by review, and it is the degenerate-input class this file
  records for the typewriter's interval and for `multiline()`'s own `rows`.

  It is bounded by what the terminal has left either way, so `rows: Infinity` is
  "as many as there is room for" rather than a canvas taller than the screen --
  which is what the field's cap already means. `rowCap()` grew a `fallback`
  parameter so the two share one reader; `multiline()`'s call site did not move.

- **Escape dismisses and resolves with nothing; Ctrl-C is still the abort.** A
  palette is a thing you dismiss, so Escape is not an error. Ctrl-C stays the abort
  every prompt takes, because an app that cannot be quit because a filter field
  swallowed it is the failure the binding order exists to prevent -- and `run()`
  refuses to let any prompt claim it.

- **The prompt plumbing is exported rather than copied, and the surface is the
  same either way.** A palette is a filter field over a list, which is a prompt by
  every structural measure -- a canvas, the one input router, a question, an answer,
  and everything put back whichever way it ends -- and is not one of the six, so it
  lives in its own module and borrows `runPrompt()`. A second reading of that
  function is a second set of answers about the settled/detach ordering, the throw
  that happens on the first frame before there is a handle to tear down, and the
  one-key-at-a-time queue.

  Moving it into a `runner.ts` of its own was the tidier shape and buys **nothing**
  in surface terms, which is why it was not done: an ejected `prompt.ts` has to
  reach the plumbing through the published `exports` map either way, so the same
  ten symbols and two types become public whichever file they sit in. What a move would have
  cost is a refactor of the most delicate component in the repository inside a
  palette ticket. Nothing moved: the bodies are where they were and one export
  block was added, and the only edit to `test/components/prompt.test.ts` is one
  added assertion about the surface that block creates -- no existing test moved,
  which is the check an extraction gets.

  `PROMPT_SYMBOLS` is frozen because it is exported, which is the trap every
  initial value in the property table is frozen against, and is asserted.

- **The palette's classes carry no new declaration, which is the sheet's own
  rule.** Eight class tokens join the vocabulary comment, on three lines, and
  none of them gets a rule -- seven `sigil-palette-*` names and the bare
  `.sigil-palette` the host is drawn with, which is the eighth and is not one of
  the starred seven: the matched runs carry `.sigil-palette-match` **and** the role
  `.sigil-heading`, because `font-weight: bold` already has sites and every
  declaration a built-in shares with another is on a role. The active row is
  `.sigil-accent` the way a choice row is, the description is `.sigil-muted`, and
  the pointer is reserved on every row with `visibility` rather than with a blank
  -- a text of one space measures nothing at all, since `white-space: normal`
  collapses a run of them, and every inactive label would sit one column left.

- **The sheet _is_ the vocabulary, and nothing had been asserting it.** Its own
  doc says to read it as the list of names a theme may restyle, and most of those
  names carry no rule -- they are in the comment. A built-in drawing with a class
  the comment does not name is a hook nobody can find, and nothing in a build
  catches it, because a class is a string in a props object. `should name every
  class a built-in draws with` reads every `sigil-*` class out of
  `src/components/` and `src/help/` -- **70** of them, all present -- which is the
  same read `generate-registry.mjs` already makes, asked as an invariant. 67 is
  the count under `src/components/` alone, which is what this entry said; the
  other three are `sigil-help`, `sigil-help-heading` and `sigil-help-note`, and
  the test asserts `found.size > 40` rather than any of the three, so none of them
  can go stale. Found by a sabotage of the palette's own three lines of comment,
  which failed nothing -- and which failed nothing for a second reason the fix had
  to close: the invariant matched _substrings_, so the sheet naming only
  `.sigil-palette-list` satisfied a search for `sigil-palette`.

> Moved: _What the sabotage pass found, and what the harness had to guard_, _What the first review round found, and it was four wrong argvs_, _What the second review round found, and it was one defect and one sentence_ — see [docs/history/the-built-in-components.md](../../../../docs/history/the-built-in-components.md).

##### Bindings are not listable, and that is SIG-134's to decide

SIG-112 left it here in as many words: "whether bindings are _listable_ is the
same question about the same registry as the palette's, and deciding it twice is
how the two come to disagree." It is decided, and the answer is no.

- **There is no registry to read, which is the whole asymmetry.** The palette is
  cheap because the command registry is a declaration the app already wrote for
  the parser; a palette adds nothing to declare. `InputRouter.bind()` holds
  function bindings in a `Set` and sequences in a trie keyed by canonical key
  spellings, and neither carries anything a screen could show -- so "listable
  bindings" is not reading something that exists, it is adding a `desc` and a
  `group` to every binding, a listing API, a screen, and then a decision about
  what a **function** binding is listed as. That half of the registry has no key
  at all.
- **It is also the one place the palette's own argument does not transfer.** The
  reason only sigil can do a palette cheaply is that it owns an argument parser.
  There is no such asymmetry for key bindings: Ink and OpenTUI could list bindings
  exactly as well, because a binding list is a thing an app declares either way.
- **What a caller wants today, they already have in three lines.** The keys an app
  binds are in its own source in one place, so `select({ choices })` over that list
  is the whole screen -- and it is the honest version, because which bindings are
  worth showing is the app's decision rather than the framework's.

  **Superseded in part by SIG-166** ("A key-help footer generated from key
  bindings"): bindings are listable now, by opting in with a description. The
  asymmetry above still stands for the palette and a function binding, which have
  no key to list.

##### What is deliberately out

- **Ejecting it**, with the reason above: the one thing it must share with the
  parser is not published, so an ejected copy could not be the same palette.
- **A `@ttylabs/sigil/palette` subpath**, refused on the 20,079 B the measurement
  above puts on it against the standard this file already set for a subpath per
  component.
- **Importing a command module to fill in a list.** Not importing is the whole of
  what the deferral buys, and a palette over an unread branch has exactly help's
  limitation.
- **Matching the description.** It is shown and not matched, because matching
  prose makes a ranking unpredictable and the label is what gets typed.
- **Options as palette entries.** The ticket is about commands, and an option is
  reached through the slot prompts once a command has been chosen. A palette over
  every option of every command is a different screen with a different question.
- **A hard-wrap rule for a variadic answer**, and a value containing a newline
  with it, for the reason the `multiline()` entry gives.
- **A key binding that opens it.** A component reachable with no router is worth
  more than one that requires one, and which key opens a palette is the app's: the
  demo makes it a `default` command, which needs no binding at all.

### Prompts and keys

- **A text prompt inserts the key that named itself, and it moves over grapheme
  clusters.** A real character decodes with its `name` and its `sequence` the
  same string, while a named key's name is one the terminal never sent -- `up`
  for `ESC [ A`, `tab` for a `\t`, `unknown` for the bracketed paste marker. The
  test used to be whether the _name_ had a display width, which is true of every
  one of them, so Up typed `up` and Escape typed `escape`; it was false of a
  combining mark, so an NFD paste of `café` arrived as `cafe`. What is inserted
  is the sequence rather than the name, so the two can never disagree, and a C1
  control is refused there because `decodeKeys()` already names every C0 one as
  Enter, Tab, Backspace, or Ctrl with a letter. The cursor is an offset into the
  value rather than an index into its clusters -- inserting and slicing stay
  ordinary string work -- and it only ever lands on a boundary `graphemes()`
  agrees with: `cursor ± 1` walks UTF-16 code units, so a backspace over an emoji
  left its high surrogate in the value and every edit after it worked on a string
  no terminal can draw. An insertion is the one edit that does not move by whole
  clusters, because what was typed can join the cluster after the cursor -- a
  letter typed in front of a lone combining mark makes one cluster of the two --
  so it snaps forward to the end of what it landed inside. The table's
  `truncateCell()` already read text by cluster and the prompt was the one place
  that did not, which is still the split now that `truncate()` has replaced it.
  See `test/components/prompt.test.ts`.
- **The caret is painted into the frame; the terminal's own cursor is not
  moved.** Left, Right, Home and End moved an index nothing drew, so nothing on
  screen changed until the next character was typed and landed somewhere
  surprising. The alternative was to show the cursor for a prompt -- a live
  region hides it, which is right for a spinner -- and walk it to
  `stringWidth(value.slice(0, cursor))`, and it costs the region the one
  invariant its repaint math rests on: that the cursor is where the last frame
  it wrote ended. Every path that erases would have to walk up from wherever the
  caret was left instead, and `done()`, `write()`, `clear()` and eviction would
  each have to agree about it -- a second invariant carried by the whole region
  for one component's benefit. A caret that is part of the frame also needs no
  putting back: a region that is cleared, evicted, or resized owes the terminal
  nothing, and a value wider than the screen wraps with the caret already in the
  right place rather than needing a scrolled view and a column to put it in. It
  is reverse video over a whole grapheme cluster, so a wide character is marked
  across both its columns; past the last character there is nothing to mark, so
  the caret is a column of its own. A styler at level 0 therefore draws no
  caret, which is deliberate: the same setting takes the cyan `?`, the bold
  message, and the dimmed placeholder with it, and a prompt asked for plain text
  gets plain text rather than the one sequence the library decided was too
  important to turn off.
- **A mask is applied per piece of the value, not to the whole of it.** It is a
  column count rather than a substitution -- a two-column emoji is two bullets --
  and masking the value in one go leaves nowhere to put the caret. The pieces are
  split on cluster boundaries and a width is the sum of its parts, so what is
  drawn is the same text it always was, with the bullets standing for the
  character under the caret reversed. Which is why the caret covers two of them
  for an emoji and one for a letter, and why a `mask` wider than one column still
  lines up with itself.
- **`decodeKeys()` is a pure reading of one chunk, and the waiting belongs to
  whatever feeds it.** A terminal sends Alt-x as `ESC x` and Up as `ESC [ A`,
  both in one write, so decoding per chunk is right until the read splits --
  which ssh, a pty under load, and a small read buffer all do. Split, `ESC [`
  and `A` decode as an unknown sequence and a literal `A`, and the `A` is what a
  text prompt puts in somebody's answer: silent corruption, and the reason this
  was worth a timer in the input path rather than a line in this file saying it
  was not. `pendingLength()` says how much of a chunk's tail could still be the
  start of a longer key, measured by the same reader `decodeKeys()` uses so the
  two can never disagree about where the last key starts -- searching for the
  last `ESC` instead finds one inside a sequence that had already finished.
  `run()` holds that tail, joins it to the next chunk, and flushes it after
  `ESCAPE_TIMEOUT` of silence, which is what makes a lone Escape a key rather
  than a wait with no end: nothing follows it, so nothing can complete it. The
  split is made where the chunk arrives rather than inside the queued work,
  because the queue is one chunk at a time and a second chunk landing while the
  first is still being handled would be joined to the same stale remainder.
  Fifty milliseconds because the two failures are not symmetric: too short types
  a stray character into an answer, too long makes Escape feel late. See
  `test/components/keys.test.ts` and `test/components/prompt.test.ts`.
- **A CSI ends on a byte in 0x40-0x7e, and a byte that is neither that nor a
  parameter has ended it.** Anything at all was taken as the terminator, so a
  key pressed while a sequence was still arriving was eaten by it: `ESC [` then
  Ctrl-C was one unknown sequence and a prompt that could not be escaped, and
  `ESC [` then `ESC [ A` stopped at the second ESC and left `[A` to be typed
  into the answer two characters at a time. Holding a half-arrived sequence is
  what made that worth fixing rather than noting -- it widens the window from
  "the same read" to "the same read or the next fifty milliseconds", and Ctrl-C
  is the key most likely to be pressed in it. The sequence now stops in front of
  such a byte and the byte is read as the key it is. The parameters widened to
  ECMA-48's 0x30-0x3f at the same time, because only `[\d;]` was read: the `<`
  a mouse report leads with was taken for the terminator, and `0;1;1M` was typed
  a character at a time after it.

### A number prompt: the parser's reading of a number, in a text field

SIG-159. `src/components/number.ts` is `number(opts): Promise<number>`, and nearly
everything in it is a decision about what it does _not_ own.

- **The prompt asks `transformValue()` what a number is, and has no opinion of its
  own.** The text goes through the parser's `int` -- or `number` with `float` --
  at Enter, so what is refused is what `--port 9007199254740993` is refused for,
  in the parser's own sentence: nothing past 2^53-1, a lone `-` is `Invalid
  integer`, a lone `.` is `Invalid number`. A second reader of the coercion rule
  is how a prompt comes to accept a value the command line then rejects. The
  rules this relies on (whitespace is not empty, empty is rejected for a
  non-string type) never fire for typed text, because the field cannot hold
  whitespace; they are there for a state the filter let through, such as `-`.
- **A key that cannot be part of a number is ignored as it is typed, and nothing
  is shown.** Digits (ASCII only: a fullwidth digit is a digit to a human and a
  `NaN` to `Number()`), a `-` at offset 0 and only when `min` is unset or
  negative, and a `.` only with `float` and only once. No `e`, so `1e3` and
  `Infinity` cannot be written and the field never holds text the prompt would not
  have accepted. The rule runs a character at a time against the value as it
  stands, so a paste is held to the same rule as a keystroke (`1.2.3` pasted into
  a float field is `1.23`). The sign check is `cursor === 0 &&
  !value.startsWith('-')`, and the second half is reachable only by moving Home
  and typing again, which is the test that pins it. That rule alone was not enough
  for the claim above: a digit or a `.` has no position check, so Home on `-5` and
  a `3` wrote `3-5`, which Enter refused and the arrows could not step. Offset 0 of
  a field that starts with `-` is the one slot ahead of the minus, so **nothing**
  is taken there, whatever it is. A paste is flattened through `pastedLine()`
  first, like `text()`'s.
- **Enter outside `[min, max]` is an error line naming the bound, never a clamp.**
  The arrows clamp because they produce a value; Enter judges one somebody typed,
  and handing back a different number from the one on screen is the silent change
  this repository refuses everywhere. The range is checked before `validate`,
  which therefore only ever sees an in-range number. A `default` outside the range
  is held to it as well: an empty answer is an answer.
- **An empty answer is `default`, or `Enter a number` and the prompt asks again.**
  Not a throw, for `text()`'s reason: the person is there.
- **Stepping lands before it steps.** From an empty field (or a lone `-`) the first
  Up or Down puts `default`, else `min`, else `0` in the field, clamped, and the
  presses after it add `step`. Stepping _from_ that base instead turns an empty
  field with `min: 1` into `2` on the first press, which skips the one value the
  person was looking for. A half-written number (`.`) is left alone rather than
  guessed at; the complaint belongs to Enter.
- **Float arithmetic is rounded to the finer of the step's places and the value's.**
  `0.2 + 0.1` is `0.30000000000000004`, and rounding to the step's places is what
  fixes it; rounding to the step's alone also turns `0.125 + 0.1` into `0.23` and
  deletes a digit somebody typed, on an arrow press. Steps are not aligned to a
  grid anchored at `min` (HTML's step base): `min: 1, step: 5` goes 1, 6, 11, and
  a value typed as `4` goes to `9`.
- **A number is written without an exponent or not at all.** `String(1e-7)` is
  `1e-7` and the field refuses an `e`, so a value the prompt wrote itself would be
  text the prompt would not accept; `format()` uses `toFixed()` for those. Past
  1e21 there is no plain spelling, and stepping there does nothing. An `int` that
  would step past `MAX_SAFE_INTEGER` does nothing either.
- **`-0` is `0`.** `Number('-0')` is `-0`, and an answer a caller prints or
  `Object.is`es should not carry a sign nobody asked for.
- **An unusable option rejects the prompt with a `PromptError` instead of asking
  it.** A `step` of zero or less, `min > max`, a non-finite value anywhere, and --
  without `float` -- a fractional `min`, `max`, `step`, `default` or `initial`:
  each is a prompt that could only misbehave later, the way `multiline()` refuses
  a `submit` with no name.
- **The field is `multiline()`'s, not a second one.** `layoutField()` and
  `fieldLayers()` draw it, so the caret, grapheme handling and cursor keys are the
  shared ones; the only editing logic here is which characters may be typed. It
  sits on the question's line like `text()`'s, in a `position: relative` box that
  the caret layer resolves against, with the window kept on the caret's row for an
  answer wider than the room. The caret is drawn at colour level 1 and above, as
  everywhere.
- **It is a registry entry (SIG-201), and two things had to be published for
  that.** This entry used to read "not a registry entry, and that is structural":
  `../util/transform.js` had no subpath, and `layoutField()` and `fieldLayers()`
  were not in the barrel. The first is `@ttylabs/sigil/coerce` (see
  `src/parser/AGENTS.md`); the second is that the barrel now exports
  `layoutField`, `fieldLayers` and the shapes they trade in -- `FieldLayout`,
  `FieldFrame`, `FieldRow`, `FieldCell` -- which is a **public contract taken
  deliberately and narrowly**, because an ejected `number.ts` draws its field with
  exactly those two and importing a name the package does not export fails in the
  app at the import. `multiline()`, `text()` and the rest keep their field
  internals private; only the two functions an ejected copy calls, and the types
  in their signatures, moved. `test/registry.test.ts` asks the built bundle for
  every value name an entry imports, so the next component that reaches for an
  unexported helper fails the build rather than the app. Confirmed by type-checking
  the ejected `date`, `number` and `palette` under `NodeNext` against the built
  package, which is the check that found `layoutField` was missing.
- **Deliberately not done:** thousands separators and units, an `e` for scientific
  notation, hex or other bases (`transformValue()` reads `0x10` as an `int`; the
  field cannot type an `x`), Page Up/Down for a larger step, a held key
  accelerating, `round`, and a range hint on the question line -- the bound is
  named when it is broken, which is when a person needs it.

### A list prompt: a line read as an array

SIG-172. `src/components/list.ts` is `list(opts): Promise<string[]>`, and the
ticket's three questions are answered here.

- **The field is `text()`'s line, as typed -- not chips.** Chips would need the
  line to be a list of widgets with a current one, and every editing key would mean
  two things (move within an entry, move between entries). The line is what a
  person types and fixes with the keys they already know, and the settled answer
  line shows the entries as read. A chip field is a different widget and is not
  here. The field is the registry-capable one (`promptWindow()` and the shared
  editing helpers), so `list` is a registry entry, unlike `number`.
- **A separator is a string or a `RegExp`, both.** A string is matched literally
  (`'.'` is a dot), a pattern is matched wherever it matches, and `/[\s,]+/` is why
  the pattern is worth having: tags and hostnames are typed with commas, spaces or
  both. `String.prototype.split()` is not used for a pattern, because a capture group
  puts its captures into the result as entries and a pattern that can match nothing
  splits between every character. `splitList()` scans with its own `g`-flagged copy
  (so `g` and `y` on the caller's are ignored and its `lastIndex` is never touched)
  and skips a match with nothing in it. An empty string separator is refused with a
  `PromptError`, for the same reason.
- **Trimmed, and an entry with nothing left is dropped, always.** There is no option
  to keep either: `a,,b` giving `['a', '', 'b']` is a list with a hole that every
  caller would have to filter, and whitespace around a comma is how the line is
  written. An empty line is `[]`, never `['']`. Duplicates are kept -- the prompt
  cannot tell a repeat that was meant from one that was not, and `new Set()` is one
  expression for a caller who can.
- **An empty answer is `default`, or `[]`, and "empty" is the entries.** `' , ,'` has
  no entries and takes the default like the empty string, since the default is for
  nothing. The answer is a copy of `default`, and `validate` is given it.
  `validate` receives the entries; a minimum or maximum count is `validate`'s job
  rather than two more options, which is also how `path()` leaves "must exist".
- **`initial` is a string or an array, and an array must survive its own line.** A
  string is the line. An array is joined (`joinList()`: the separator and a space,
  `', '` for a pattern) and then split again: if that does not give the same array
  -- an entry holding the separator, an empty entry, space around an entry, a
  pattern that does not take `', '` -- the prompt rejects with a `PromptError`
  rather than showing a list the first Enter would change.
- **No quoting, no escape.** An entry cannot contain its own separator. A caller who
  needs one picks another separator; quoting rules are a parser in a text field.
- **A paste is `pastedLine()`'s**: line breaks become spaces, so a block pasted one
  host per line with a comma separator is one entry. Turning breaks into the
  separator is possible for a string and not for a pattern, and a rule that holds for
  one of the two is the kind this file avoids.

Deliberately not done: chips; `min`/`max`/`unique`/`required` options; quoting;
completion; and a pasted block's line breaks as separators.

### A masked text prompt: a line that follows a template

SIG-174. `src/components/masked-text.ts` is `maskedText(opts): Promise<string>`
and `applyMask()`, and the ticket's three questions are answered here.

- **The syntax is a template of fixed characters and one-character slots, with a
  `slots` option for the regex.** Textual's has a dozen letters, a required and an
  optional spelling of each, and case flags; the ticket's own examples
  (`(###) ###-####`, `AAAA-####`) are the short end of it. So the built-ins are
  five -- `#` digit, `A` letter, `N` letter or digit, `H` hex digit, `*` anything
  that is not whitespace -- and anything else is a slot the caller names:
  `slots: { K: /[a-z0-9]/i }`, or `{ match, transform }`. That is the "closer to a
  regex per slot" answer without making a template a regex, which would have to be
  parsed to be drawn. The built-ins are ASCII on purpose: they are for codes, and a
  letter from another script is as much a typo in a phone number as a digit is.
  `slots` replaces a built-in of the same character. A backslash escapes the next
  character, which is the one way to draw a `#`. A template with no slot, one
  ending in a backslash, and a slot not named by exactly one character are
  refused, as a `RangeError` from `applyMask()` and a `PromptError` from the prompt.
- **A slot pattern is tested against a whole character.** It is anchored, and its
  `g` and `y` flags are dropped for the reason `splitList()` drops them: a pattern
  that remembers where it matched last answers differently the second time. A
  `transform` runs after the match, so an upper-casing slot accepts both cases, and
  returning `''` refuses the character after all.
- **The answer is the formatted string; the raw characters are one call away.** A
  caller who asked for a phone number wants to store `(555) 123-4567` far more often
  than `5551234567`, and it is what was on screen. An option that changed the return
  type between the two would make the types lie, so `applyMask(template, answer).raw`
  is the other, and works on any value that did not come from a prompt.
- **Typing overwrites; it does not insert.** Inserting pushes every later character
  one slot along, and each has to fit the slot it lands in -- a digit pushed into a
  letter slot has nowhere to go, so the edit would have to be refused or would drop
  something already typed. Overwriting makes every edit local: the slot the caret is
  on changes and no other. The cost is that a character typed in the middle replaces
  one rather than making room, which is also what Textual's does. The state is one
  cell per slot, with gaps allowed -- Delete leaves one -- and the caret is a slot
  index, `0` to `count` (past the last, where there is nothing to type into).
- **The caret is on a slot, never on a fixed character, and steps one slot at a
  time.** That is what makes "cursor skips literals both ways" a property of the
  model and not of a loop that looks for the next slot: Left and Right move by slot,
  Backspace empties the slot before the caret and steps onto it -- across a literal
  in one press -- and End is after the last slot with anything in it, which is where
  typing carries on from. A backspace onto an already empty slot just moves.
- **A key press never consumes a fixed character, and a paste does.** `fill()` takes
  a `skipFixed` flag. Typing is a character for the slot, full stop: in `+1 ###` the
  `1` a person types is a digit, and eating it as the template's own would make that
  prompt untypeable. Pasted text may carry the template's formatting, so the fixed
  characters in front of the slot are passed over in order -- `(555) 123-4567` and
  `5551234567` fill the same ten slots and `+1 555` is not read as starting with a
  digit. It is read left to right with no look-ahead, so `+1 (555)` into `(###)`
  fills a slot with the `1`: the template cannot say which is which, and a rule
  that guessed would be one nobody could predict. What fits nowhere is **dropped**,
  not refused, because `555.123.4567` is an answer a person can use; `applyMask()`
  reports how many in `dropped`. A paste starts at the caret and overwrites from
  there, and a block's line breaks are flattened first, as `text()`'s are.
- **Enter answers when every slot is full, and says so when not.** There is no
  optional slot -- Textual's lowercase spelling -- because an answer that may be
  short is a string that is not the template's shape, and `validate` is where a
  caller who wants one writes the rule. An empty field answers `default` if there is
  one; a field with a gap in it does not, since half-cleared is not empty.
- **`default` and `initial` are read the way a paste is.** Either may be raw or
  formatted. `default` has to fill the template with nothing left over, because it
  is an answer and is returned as the formatted text; `initial` may leave slots
  empty but may not drop a character, because the field would show something other
  than what was given. Both reject the prompt with a `PromptError` naming the
  option, as `list()` does for `initial`.
- **`placeholder` is `text()`'s: dimmed text in an empty field, in place of the blank
  template.** The empty slots are drawn as `_`, dimmed until something is typed; the
  option is for a hint such as `your number`. While a placeholder (or the default)
  stands in for the field the caret is drawn on its first character, so the caret
  and Delete and typing are all held at slot `0` -- a Right that moved a caret nobody
  could see would put the next digit somewhere unexpected. There is no option for the
  blank character. It is a one-line addition when a caller needs `·`.
- **The field is `text()`'s line, windowed with `promptWindow()`, and the entry is
  registry-capable.** Everything it imports is on a published subpath, so
  `sigil add masked-text` ejects it. `Fill in every blank` is the one new message and
  goes through `__`, so it is in `SIGIL_KEYS`.

Deliberately not done: optional slots; an insert mode; a case flag in the template
(a `transform` does it); a configurable blank character; word movement; and a
template that is a regular expression.

### Prompt flows: `group()`, and the session frame

SIG-160. `src/components/group.ts` is the whole of it: `group()`, `isCancel()`,
`intro()`, `outro()` and `cancel()`. It edits no prompt.

- **Cancel stays a throw, and `isCancel()` is a question about what was caught.**
  The ticket asked for a thrown `PromptError`, a returned sentinel, or both. A
  sentinel changes the return type of every prompt -- `text()` would resolve with
  `string | symbol`, and every existing caller would need a narrowing it did not
  have -- to buy a `group()` that can return partial results, which `onCancel`
  already hands over. So every prompt still rejects, `PromptError.aborted` still
  separates Ctrl-C from a prompt with nobody to ask, and `isCancel(err)` is
  exactly `err instanceof PromptError && err.aborted`. The second kind is the
  program being wired wrong and is deliberately **not** a cancel: a `catch` that
  treated it as one would swallow the failure `PromptError` exists to make loud.
- **`onCancel` can replace the rejection and cannot suppress it.** It is called
  with the answers so far and then the cancel is rethrown; throwing, or returning
  an `Error`, throws that instead. That is the `beforeError` rule (a hook may
  replace an error and never swallow one) for the same reason: a group has no
  result to hand back for steps that did not run, so a swallowed cancel would
  have to resolve with something that is not a `T`. It is handed the live answers
  object rather than a copy, because nothing can read it afterwards -- a copy was
  written and deleted for surviving its sabotage. A non-cancel error is rethrown
  untouched and does not call it.
- **A step is handed a copy of the answers, and an answer is defined rather than
  assigned.** A step that writes to its argument must not change what a later step
  reads; and a step called `__proto__` is legal, where an assignment would set
  the prototype and drop the answer.
- **Types: the result is typed by the keys, and a step that reads its argument
  cannot be inferred.** `T` is inferred from what the steps resolve with, through
  a mapped type whose parameter is `Partial<Omit<T, K>>`. A step that _uses_ its
  argument is contextually typed from `T`, which TypeScript is still inferring, so
  it fixes `T` before looking at that step's return and the key comes out
  `unknown`. Measured on TypeScript 7 over four spellings, clack's own shape
  among them; none works. So the documented spelling is to name the shape,
  `group<Shape>({...})`, which types every step and checks each return against
  it. The earlier answers are `Partial` because object keys have an order at
  runtime and none in the type system. Pinned by `tsc`, since `packages/sigil`'s
  `include` covers `./test`.
- **Order is `Object.keys()`'s**, so a key that reads as an integer runs first,
  as it does anywhere in JavaScript. Not worked around.
- **The frame is plain output to stderr, and silent unless both ends are a
  terminal and nobody asked for quiet.** A command's `run()` returns data for a
  serializer and `mycli init --json | jq` has to receive JSON whatever the
  session said around the questions. Stdout not a terminal means the prompts
  reject anyway, so there is no session to frame; stderr not one means `2>log`
  would collect framing. `isTTY` is read as truthy on stderr because a piped Node
  stream has no `isTTY` at all. Quiet is `mountLevel()`'s answer, so `--quiet`
  and `quiet: true` both reach it -- the frame is chrome like a spinner, not a
  dialogue like a prompt. It is not a live region: nothing on it changes, and
  claiming the region would evict a spinner for a line that stays.
- **It is drawn through the cascade, not hard-coded.** One row in a
  `.sigil-session` box: the mark carries `.sigil-symbol` and a role
  (`.sigil-accent`, `.sigil-success`, `.sigil-error`) and the intro message is
  `.sigil-heading`, so a theme restyles it. Marks reuse the spinner's check and
  cross and add a triangle for the intro. There is no ASCII fallback: the
  neighbouring components draw fixed glyphs too (the spinner's `LINE` frames are
  an opt-in), so one here would be the first rather than the pattern.
- **Deliberately not done.** Going back a step -- it needs a step to be re-asked
  with its old answer shown, which no prompt can do without an `initial` the
  existing ones do not take, and they are not edited here. (SIG-204 did both; see
  "Going back a step" below, and note it is `value` rather than `initial`.) Blank
  lines around the frame, so a session adds no rows beyond the three it writes.

### A note: a titled, bordered block

SIG-163 asked for what Clack's `note`/`box` and Ink UI's `Alert` do: frame a
message so it stands out. `src/components/note.ts` is `note()` and `noteView()`,
and the split is `table()` and `tableView()`'s.

- **One component with a `variant`, and `box` and `alert` are not exported.** They
  would be the same function under two more names, and a second spelling of one
  function is how the two come to disagree. `note` was free in the barrel --
  `prompt.ts` has an internal `note` helper and exports `promptNote`, neither of
  which collides -- so the component takes the name the ticket opened with.
- **It shrinks to its message and wraps at the room it is given.** Clack's shape,
  and the one a "next steps" panel wants: a filled line is a box mostly made of
  blanks. The message is a plain `text` that wraps itself, inside a bordered box
  with a `max-width` of the room and a wrapper that does not stretch it. Nothing
  here counts a column of the message. `white-space: pre` was tried first and is
  not needed: this engine wraps every text but a `nowrap` one with `wrap()`, which
  keeps newlines, blank lines and indentation, so a command inside a note keeps
  its indent. The width has a floor of 5 -- a border and a column of padding each
  side and one column inside -- because under it the message has no cell to be in
  and vanished rather than wrapping a letter to a row.
- **The title is an out-of-flow text one row up, because the border has no notion
  of one.** `paintBorder()` draws a border as a whole, so a title is a `position:
  absolute` text at `top: -1` over a `position: relative` box, which resolves
  against the padding box and so lands on the border row. It takes no space, and
  `left`, `right`, or both insets with `text-align: center` are the three
  alignments. A `min-width` is what stops a short message clipping a long title,
  and a title is cut with `truncate()` to what the room leaves. Where the room
  cannot hold the corners, a rule on each side and one column of title, the title
  is left out rather than drawn over a corner.
- **A title is `nowrap` text with an ordinary space either side, and `note()` still
  turns a no-break space in the _message_ back into one.** This entry used to say a
  title ended in a no-break space, because a text dropped the whitespace at the end
  of its last line when it wrapped and " Title " lost the space that keeps the rule
  off the word. That was true of a wrapping text and stopped being true of this one
  with SIG-207: a `nowrap` (or `pre`) text keeps the whitespace at both ends of its
  line, measured again in SIG-277 with `' ab '` on the border row of a bordered box
  -- both spaces drawn under either value. The title is `nowrap`, so the character
  was doing nothing, and it was costing a Panel its trailing space as a different
  character in a screen scrape, which broke the system monitor's own assertions
  (`'─ cpu · 2 cores ─'` does not match a U+00A0). The replacement in `note()` stays
  for the message, where an author may type one and a block read out as a string
  should hold none. `noteView()` no longer hands back a tree with a no-break space in
  its title.
- **Colour is the four state roles, and that needed `border-color` on them.** A
  border colour does not inherit, and `should declare on a role, bar four
  exceptions that say why` allows a declaration only on a role selector, so a
  `.sigil-note.sigil-error` rule was never available. The roles now set
  `border-color` beside `color`, which is also the right statement of what an
  error is. The cost is that the message inherits the role's `color` as well, so
  an `error` note is red all through; a plain `note` carries no role and is the
  terminal's own foreground. A message in the default colour inside a coloured
  border would need a `color` in props, which is the thing built-ins do not do.
  `warning` maps to `.sigil-warn`, for the reason `SpinnerOutcome` does.
- **The ASCII fallback is read off the environment by `unicodeSupported()`.**
  Nothing in the repository decided this before: colour level says nothing about
  box drawing, and the spinner's `LINE` frames are opt-in. It is the
  `is-unicode-supported` heuristic -- off Windows everything but `TERM=linux` and
  `dumb`; on Windows only the terminals known to cope -- taking `env` and
  `platform` the way `terminalWidth()` does, so a test names the terminal it is
  about instead of inheriting the developer's. An explicit `border` always wins.
  `NO_COLOR` does not select ASCII: it is about colour.
- **Escape sequences are dropped from the message and the title.** `text` strips
  control characters and does not interpret them, so a styled string put in
  unmodified printed its `ESC` removed and the rest -- `[31m` -- as literal
  text. Colour is the variant's, so stripping loses nothing a note was meant to
  carry; styled runs inside a message would be a `paragraph()` of runs, and that
  is a different API.
- **String form only, and it ignores `--quiet`.** A note is a result, on
  `table()`'s side of the line the quiet axis draws, and the caller does the
  writing. A live form would be a `mountLive()` of a tree that never changes, which
  is `console.log(note(...))` with a renderer in the way.

What is deliberately not done: vertical padding (a caller adds a blank line, and
Clack's extra rows are most of why its notes look tall); a symbol per variant
(the title is where an app says what kind it is, and at colour level 0 it is all
that does); styled runs in a message; and a title on a side other than the top.

### A panel: words in a border, fitted to the width the layout gave (SIG-277)

`src/components/panel.ts` and `src/components/border-label.ts`. A bordered region
with a `title`, an `annotation`, a `footer` and a `footerAnnotation` set into its
border, which is what every dashboard, file manager and log viewer is made of.

- **A component, not a style property.** The paint pass draws a border as a whole
  and has no notion of a label, there are no pseudo-elements and no `content`, and a
  `border-title` property would be a canvas and layout change for every box in the
  engine to serve one component. What `note()` already did is the precedent: an
  out-of-flow `text` one row over the edge, which takes no space and covers the rule
  cells it sits on. The first title the monitor wrote by hand was the same thing a
  third time, so the label is one helper now.
- **One helper for a label across a border, and `note()` is its first caller.**
  `borderLabelText()` formats a label for a run of border cells (a space, the text
  cut with an ellipsis, a space), `borderLabelProps()` is the declarations that put
  a text on the top or the bottom row, and `fitBorder()` lays one row's two labels
  out for a width. `noteView()` calls the first two with the same arithmetic it had
  inline -- every `note.test.ts` picture passes unchanged -- and `Panel` calls all
  three. It is a sibling file and not an entry in the registry, for the reason
  `mount.ts` is not: an ejected `note.ts` or `panel.ts` imports it from
  `@ttylabs/sigil/components`, where it is published.
- **A panel fits its labels after the layout, because the width is the layout's.**
  `note()` knows its width before it builds anything, since it shrinks to its message
  inside a room it was given. A panel is as wide as its slot, so what a border can
  hold is a question for after the layout and the labels are placed from `onLayout`,
  which a frame dispatches after every layout and which answers whether it changed
  the tree. A label that changes lays out again in the same frame and the second pass
  finds nothing to change. A reactive label is an effect that stores the new text and
  calls the same placement, and a bare `arrange()` dispatches nothing -- the
  contract `onLayout` already documents, and why every panel test goes through
  `renderToLines()`.
- **When a border is too narrow: the annotation goes first, then the label is cut,
  and at the extreme the border is plain, each border on its own.** The rule cell
  beside each corner and a space either side of the text leave a run of `width - 4`
  cells, and a label needs three of them. A label and an annotation share a row only
  if both are whole and a rule cell is left between them; otherwise the annotation
  is dropped and the label takes the row, cut with an ellipsis if it must be. A label
  cut down to nothing but the ellipsis says nothing, so that border is plain instead
  -- `╭─ … ─╮` was what a seven-wide panel drew before. An annotation with no label
  is the only thing on its row, so it is cut rather than dropped. The top row's
  decisions never reach the bottom's: the footer of a panel whose title is cut is
  whole.
- **A right-aligned title packs against the annotation, and a centred one drops it
  if they would touch.** The annotation owns the right end. Right-aligned means
  "towards the right", so the title stands a rule cell short of it, which is the only
  reading where `titleAlign: 'right'` and an annotation can both be on screen. A
  centred title stays centred on the whole border, which means the annotation is the
  thing that gives way.
- **The content is clipped by a box inside the panel, not by the panel.** `overflow:
  hidden` clips to the padding box, which is where the labels sit on the border row
  -- the same reason the monitor's stand-in had an inner `panel-body`. The labels are
  children of the panel and the content is a child of the body.
- **It grows to fill its slot, by a rule in the framework sheet, so a stylesheet can say
  otherwise.** `.sigil-panel { flex-grow: 1 }` is the fifteenth declared exception to
  the role rule (`src/theme`). It was an inline `flex-grow: 1` in the first version,
  which only `props` could undo: a prop beats a sheet, so a panel used as a card in a
  column had no way to stop growing from a stylesheet. The size limits `min-width: 0`
  and `min-height: 0` stay inline, because they are structure and not a default. A
  panel inside a `Pane` is meant to fill it and a bordered region in a layout nearly
  always is; the opposite default would have every use write `'flex-grow': 1`. Rendered
  with no framework sheet at all -- a bare `Cascade` -- it does not grow.
- **The border style is a prop, the colour is the cascade's.** `border-style` is
  inline, as the note, the modal, the toast and the tooltip have it, with `ascii` and
  `border` the same options. `border-color` is not set at all, so a theme restyles
  the border with `.sigil-panel { border-color: cyan }` or its own class and the
  default is the terminal's foreground. **No framework-sheet rule sets a colour**: the
  title is `.sigil-heading` and the rest `.sigil-muted`, which are roles, and a
  border colour would have been one more declared exception to the role rule for a
  decision a theme can make in one line. The one rule the panel does have is
  `.sigil-panel { flex-grow: 1 }`, which is a layout default and not a colour; it is
  the entry above. The classes `sigil-panel`, `-title`,
  `-annotation`, `-footer`, `-footer-annotation` and `-body` are named in the sheet's
  vocabulary comment, which `should name every class a built-in draws with` holds.
- **`:focus-within` was in the ticket and does not exist.** "Focus on a control"
  records why the selector engine has no such state, and nothing here changes that: a
  panel cannot light up because something in it holds the focus. The app says which
  panel is current with a class, or the panel's own contents show their focus. A
  `focus-within` state would be the selector engine's ticket, and it would be wanted
  by exactly this.
- **Content as arguments or as `children`.** `Panel(props, ...children)` is the
  shape the monitor's stand-in had and the ticket asked for; a template hands a
  component its content as `props.children`, so both are read.
- **Not done:** a variant that takes a state role's colour (`variant: 'error'`), which
  is `note()`'s and one `class` away; a title on a side border; a tool that lists the
  panel's keys, since it has none.

### A pane: a size in cells, and an edge that resizes it (SIG-277)

`src/components/pane.ts`. A region whose size is a number of cells, with one edge it
can be resized from. There is no container: any number go in any flex box, and each
owns its own edge. `paneControl(host)` is its handle.

- **The size is a `flex-basis`, which is the main size whichever way the parent runs.**
  A row pane's width and a column pane's height are the same declaration, so sizing
  never reads the parent's `flex-direction`. What does read it is the edge's
  geometry, the arrows and the drag, and those are done at press time or in
  `onLayout`, which re-places the edge when the parent turns from a row into a column
  and says it changed the tree. `flex-grow: 0`, `flex-shrink: 0` and `min-width: 0`:
  the size is the size it was given, and a terminal narrower than the panes' sum makes
  the plain box beside them go to nothing rather than squeezing a pane. That needed
  the layout to read a basis along a column, which it did not: "An auto-height column
  is as tall as the basis its children flex from" in `src/layout`.
- **When the panes ask for more than the parent has, each keeps its minimum and the
  rest is handed out in order.** Capping each at the whole parent, which the first
  version did, left two 15-cell panes in a 12-wide row each 12 wide and the second
  off the canvas with its edge unreachable. `allocate()` is a pure function of the
  panes' wanted sizes and the parent's extent, so every pane computes the same
  answer from its own `onLayout` and no pane reads another's last frame: where the
  asks fit it returns the ask; where the minimums do not fit they are scaled down
  together, so every edge stays on the screen; otherwise each pane gets its minimum
  and the first ones in the document get the remainder. Only a real contention
  triggers it, so a parent that is exactly as big as its panes make it -- an
  auto-height column -- is never a reason to ask for less. What a plain sibling
  claims depends on whether it gives way: one that cannot shrink (`flex-shrink: 0`)
  keeps its basis and is taken off the room, with the parent's gaps; one that can is
  what gives way and claims nothing. Two 15-cell panes beside a
  `width: 10; flex-shrink: 0` box in 30 columns used to leave the second half off the
  screen. Its basis is the size it was placed at only if it does not grow either. A
  box that grows has been drawn at its basis plus whatever the panes left it, so
  claiming that drawn size handed a pane beside it only what it already had: a
  `flex-grow: 1; flex-shrink: 0` box beside a 10-cell pane in 40 columns was drawn at
  30, the pane could not get past 10, and every shrink was one it could not undo.
  Such a box claims `basisOf()` instead -- a `flex-basis` in cells, else what
  `measureNode()` reports -- and not nothing, which was the other fix on offer: it
  cannot shrink below that, so claiming nothing let a size the app set push it off
  the screen. Review of #350 found it.
- **The size state is the app's and is not clamped in place.** `min` and `max` clamp
  where it is read and where a drag writes, and a state an app set out of range
  draws in range and keeps its value, so a terminal that is wide again finds the pane
  as it was left. `min` defaults to 1, since a pane with no cells is `collapsible`'s
  doing and not a default.
- **The edge is a `raw` cell, absolute, and it draws nothing at rest.** It is laid
  over the pane's own last (or first) column with `width: 1` and both vertical insets,
  or the same turned over for a column, so it takes no room and sits on the border of
  a `Panel` in it. At rest the border or the content under it shows. Hovered, held or
  focused from the keyboard it draws a heavy line (`┃`, `━`; `|` and `-` in ASCII) in
  `.sigil-accent`, which a theme restyles through the role. Hover needs the router's
  `motion: true`, as every `:hover` does, and the edge reads it off the `mouseenter`
  and `mouseleave` it is told rather than `element.states`, so one flag per cause says
  why it is lit. Drawing over a panel's corner cells is deliberate: it is the whole
  height of the pane, like a sash in an editor.

  **A focus the pointer gave is not drawn, which is the web's `:focus-visible`.** A
  click focuses the edge so that the arrows land on it, and the first version lit it
  for as long as it held the focus -- so after a click, or a drag that collapsed the
  pane, the line stayed lit with the pointer gone, until something else took the
  focus, which in a layout with nothing else focusable is never. Found by hand in the
  demo. The router focuses after it has dispatched the press, so a focus that arrives
  while a button is down on the edge is the pointer's and is not drawn; one given from
  code -- an app's key moving the focus there -- is drawn at once, and the first arrow,
  Enter or Space the edge handles lights it, since that is when the focus starts to
  matter. A later press takes it back to the pointer's. The alternative, never drawing
  the focus, leaves nobody able to see which edge the arrows will move.

- **A pane with no cells has its edge on the neighbour's cell, and goes above its
  siblings.** An `end` edge on a zero-width pane at the left of the screen would be
  column -1, off the canvas and not reachable, so a pane of no cells takes the other
  inset and lands on the cell beside the boundary. "No cells" is the basis being zero
  and not `collapsed`: a pane that is not collapsible with `min: 0` taken to nothing,
  or one the room has no cell for, is as unreachable as a collapsed one. That cell is
  the neighbour's, and a sibling later in the tree would paint over it, so the host
  takes `z-index: 1` -- or the app's own, if that is higher -- and puts the app's value
  back when it has cells again. The app's value is whatever the host carries that the
  pane did not write, read each layout, so an app that sets it later is not undone. The
  raise is an inline value, which beats a stylesheet's: a z-index given by a sheet
  is overridden by the `max(1, ...)` while the pane has no cells, and is back when it has. It is drawn dim (`.sigil-muted`) with the light glyph,
  so there is something on the screen to say the pane is there.
- **A scrollbar on the edge's cell makes the content keep that cell clear.** The edge
  is on top of the pane's last column and a scroll box that fills a pane has its bar
  there, so every press the bar should take went to the edge and a hover drew `┃`
  over it. A pane looks for `sigil-scroll-bar` elements, in the content, whose cell is
  the edge's, and pads that side of the body by one -- `padding-right`, `-left`,
  `-bottom` or `-top` by axis and side -- so the edge has a column to itself. Asked of
  the boxes the layout placed with the padding it is already keeping added back, so
  keeping the cell clear does not make the next answer "no" and flap. The walk is
  bounded to boxes that reach the edge's cell, and stops at the first bar, so it is not
  the whole body on every layout. A `Panel`
  between the two puts the bar a cell inside the border and nothing is padded. This
  couples the pane to a scroll box's `sigil-scroll-bar` hook, which is published
  vocabulary; the alternatives were a documented rule that no scroll box may fill a
  pane, which the README had been sanctioning, and a warning, which nothing in the
  library has a place to print.
- **A drag moves cells between the pane and its neighbour, and the neighbour is
  looked up when the press lands.** The siblings are read from the parent at that
  moment -- in-flow ones only, so an absolute overlay between them is skipped -- and
  nothing is cached, so a pane added or removed since the last drag is the one found.
  A `Pane` neighbour gives or takes within its own `min` and `max`; a plain box
  gives up what it has down to the least the layout would let it be and absorbs the
  rest through its own `flex-grow`; a collapsed pane gives nothing and stays shut. The pane's own limits and its neighbour's are
  intersected rather than applied in turn, so neither is exceeded by one cell. A
  neighbour a drag cannot satisfy leaves the pane where it was.

  That least is `minimumOf()`: a declared `min-width` or `min-height`, else the
  automatic minimum `measureNode()` reports for its content. Assuming it could give up
  everything -- the first version -- let a pane take cells from a box holding a
  `nowrap` word until the word pushed every later sibling off the screen. And what it
  has to give is worked out from the pair: the cells the two shared when the layout
  last ran, less what the pane already holds. Reading the neighbour's own box instead
  told three Right presses in one input chunk, with no layout between them, that one
  cell was left each time. The one place the pair is the wrong model is a parent that
  is as big as its children make it, where growing the pane makes the parent bigger
  and there is nobody to take from; `shrinkWrapped()` asks the parent and its
  ancestors whether anything hands it a size (a declared one, a `flex-grow`, a
  stretch, the canvas for the root), and unbounded growth is the answer where nothing
  does. The first version used the measured extent against the measure, and a root row
  squeezed exactly full was taken for a shrink-wrapped one.

- **What a drag measures is the distance from the press, from where the layout will
  put the pane.** Not from the edge and not from the box a past frame placed: a key
  pressed twice between two frames moves from where the first left it, which the first
  version got wrong by reading a stale box. The start is `allocate()`.
- **Collapsing is a snap, not a limit.** A `collapsible` pane dragged below half its
  `min` is closed and not a small pane, as a sash in an editor snaps; between half and
  `min` it is `min`. Opening from collapsed by a drag uses the same rule, so it opens at
  `min` or more. A collapse hands its cells to a neighbouring pane, and an expand takes
  them back; the size it had is kept in the size state throughout, which is what `expand()`
  restores.

  So `collapse()` closes the pane or does nothing, and it is what a double-click, Enter
  and Space reach through `toggle()`. Where the pane beside it cannot take every cell --
  a `Pane` whose `max` leaves less room than the collapsing pane holds -- routing it
  through the drag's arithmetic took the pane to what was left instead: still open,
  smaller, the neighbour pushed to its `max`, and the size `expand()` restores written
  over. A drag below the snap is a different request and still moves as far as it can.
  The snap is also at zero whatever the minimum, since half of a `min: 0` is no snap at
  all and a collapse of such a pane zeroed its size and left it open. Review of #350
  found the first; the second turned up writing its test.

- **A double-click is two clicks of the edge inside 400 ms, counted here.** The router
  reports `click` and has no count, and a count is not worth adding to every event for
  one component. The click that ends a drag is not a click on anything -- the edge moved
  under the pointer and came back to it, so the release lands on the edge -- and is
  discarded. Enter and Space do the same from the keyboard.
- **The handle is `paneControl(host)`, which is how `scrollControl()` and `tabsActive()`
  hand out what a component holds.** A template interpolates the element it is given and
  has nowhere to put a second return value, and a `WeakMap` keyed on the host lets a
  neighbour find a pane's limits without the app threading them. It has `size` and
  `collapsed` as states, `edge` as the element that holds the focus, and `resize()`,
  `collapse()`, `expand()` and `toggle()`, each the move a drag makes. `resize()` is not a
  setter: it clamps, it moves a neighbouring pane, and it answers what it took.
- **The edge is focusable and not in the Tab order, which needed the router to learn a
  negative `tabindex`.** See "Input and focus" in `src/input`. A click focuses it, the arrows
  move it a cell and Shift with one five, and a Tab carries on from where it sits.
  Collapsing a pane around a focused row hands the focus on, by the router's rule that an
  element that stops being displayed gives it up; the edge itself is outside the body,
  so a collapse from the edge leaves the focus on the edge and the next arrow opens it. The arrows are the
  physical direction of the edge: Right on an `end` edge grows the pane and on a `start`
  edge shrinks it. The arrows across the axis, and any with Ctrl or Alt, are left for
  whatever is around.
- **Not done:** a `describePane()` for `keyHelp()` (a footer that listed the arrows would
  list them whenever the pointer had focused an edge, which is not when anyone wants them
  taught); `row-reverse` and `column-reverse` parents, whose physical sides are the
  opposite of their main axis; moving a second neighbour when the first has run out; and a
  size as a percentage, which would be a different component.

### An outline: lists, and why it is not called `list`

SIG-181 asked for what Lip Gloss's `list` package and Ink UI's `UnorderedList` and
`OrderedList` draw. `src/components/outline.ts` is `outline()`, `outlineView()` and
`createOutline()`, and the split is `note()` and `noteView()`'s, with a live form
added.

- **It is `outline()` because `list()` was taken.** The ticket says `list()`, and
  `list` in this barrel has been the prompt that reads a line as an array since
  SIG-157, with `splitList()` and `joinList()` beside it. Overloading one name over a
  prompt that returns a promise and a block that returns a string would be a type
  that depends on what the first argument looks like, so the second one took another
  name. `outline` because it covers the ordered and the unordered and the nested
  with one word; `bulletList` was a lie for a numbered one.
- **The enumerator is a function, and the names are shorthand for ones.** That was
  the first open question and the answer is yes: `OutlineEnumerator` is a style name
  or `(info) => string`, so a custom one is a lambda. `info` is
  `{ index, depth, count, item }`, with `index` from 0 whatever `start` says --
  `start` moves what a _named_ counting style draws, since a function that wants an
  offset adds one. An array of enumerators is read by depth and **cycles**, the
  rule a legal outline wants (`1.`, `a.`, `i.`, then `1.` again) and the one a
  default of `['bullet', 'dash']` needs; repeating the last entry was refused
  because it makes a fourth level look like the third.
- **Hanging indent is the box model, not `wrap()`.** The second open question hoped
  for `wrap()`'s `hangingIndent`, which would have kept an item's escape sequences
  across a break. It was not used because the item has to be a `text` element, a
  `text` drops the `ESC` of a sequence and prints the rest as literal characters
  (measured: `\u001B[31mhi` is drawn `[31mhi`), and a row of a marker and a column
  beside it is what lays a nested list at the column its parent's text starts at
  without counting anything. So **escape sequences are dropped from items and
  markers**, as `note()` drops them, and colour is the theme's. A caller who needs
  a styled run inside an item needs `paragraph()` of runs, which is a different API.
- **A row is a marker and a body column, and the nested list is inside the body.**
  The marker is `nowrap`, does not shrink, and carries the gap as padding; the body
  shrinks with `min-width: 0` and holds the text and then the nested list. A wrapped
  line therefore hangs under its own first word and a nested list starts where its
  parent's text does, from the same flex arithmetic rather than from a column of the
  marker being added to a column of the indent.
- **Markers are right-aligned within their own list.** `9.` over `10.` would
  start its text a column apart; padding on the left lines the full stops up, which
  is what Lip Gloss does and what a printed outline looks like. It is per list: a
  nested list measures its own. Roman numerals right-align too, so `i.` over `viii.`
  is a column of tails rather than of heads.
- **A style that cannot write the number draws the number.** Roman numerals stop at
  3999 and have no zero; `alpha` has no letter under 1. `start: 0` on `roman` is
  `0.` rather than an empty marker, which would read as a list with the numbers
  missing, and `alpha` past `z` is `aa`, `ab`, a spreadsheet's columns -- the only
  convention a list that long has.
- **A list with no marker still nests.** `enumerator: 'none'` leaves nothing to hang
  a child from, and a child at the parent's own column is indistinguishable from a
  sibling, so a nested list is indented two columns when the list above drew no
  marker.
- **The live form is a mount whose tree is rebuilt, and where there is no terminal
  it writes once at the end.** `createOutline()` holds the items in a `State` and
  `update()` replaces them whole; the tree is a `For` over a one-element list of the
  current array, so a new array is a changed row and the tree is built again, which
  is the cheapest reading of "items replaced" and needs no keyed diff of nested
  lists. A list has no frames to repaint in a log, and a line per `update()` would
  print the whole list each time, so a pipe gets the final list once from `done()`
  and `stop()` writes nothing. A quiet run writes nothing, through `mountLevel()`
  like every other mount. A malformed list is refused where it is handed over,
  including in `update()`, and the screen keeps what it was showing.
- **String form ignores `--quiet`.** A list is a result, on `table()`'s side of the
  line the quiet axis draws; only `createOutline()` is progress.

What is deliberately not done: a marker with its own colour (a theme restyles
`.sigil-outline-marker`, and a function returning escape sequences is dropped for
the reason above); a checkbox style, which is `enumerator: () => '[ ]'` and a state
the caller holds; a separate item for continuation paragraphs, which is a line break
in the text; and keyed updates, which a caller wanting them builds from
`outlineView()` inside its own reactive tree.

### A date prompt: segments, ISO order, and the parser's own reader

SIG-165. `src/components/date.ts` is the whole of it: `date()` returns a `Date`
from year, month and day segments, with the hour, minute and second added by
`time` and `seconds`.

- **The value is built by the parser and the prompt carries no calendar of its
  own.** The ticket's requirement was that the prompt accept exactly what the
  `date` data type accepts, and the only way two readers cannot disagree about
  what a date is is for there to be one. So Enter turns the segments into
  `YYYY-MM-DD` or `YYYY-MM-DDTHH:mm:ss` and calls `transformValue(text, 'date')`
  -- the checks recorded in the root `AGENTS.md` ("A `date` has its clock checked
  as well as its calendar", "A data type rejects what it cannot represent") are
  therefore the parser's and not a copy. The one piece of arithmetic the prompt
  needs outside that call is how long a month is while a day is being stepped,
  and that is `daysInMonth()` from the same file, exported for it (additively; it
  was the parser's private helper). The clock and calendar are asked about on the
  matched text, never read back off a `Date`, which is the parser's rule and
  holds here for free.
- **It is unreachable by construction that the parser refuses what the prompt
  built, and that is why a test replaces the parser.** Every segment is clamped
  to its range as it is written, so an invalid date cannot be assembled and a
  sabotage that bypasses the call survives a behavioural suite. `date-parser.test.ts`
  mocks `transformValue()` and asserts the text it is given and that the answer is
  what it returns, and that a throw from it is the error line rather than an
  escape. The year `0000` used to have no 29 February in the parser's
  `daysInMonth()` (`Date.UTC` maps years 0-99 to 1900-1999, and 1900 is not a
  leap year), so the prompt could not reach it either; the parser's fix (the
  leap rule written out, see the root `AGENTS.md`) reached the prompt for free,
  because it agrees with the parser by sharing the function.
- **Local time, with no offset, and no timezone option.** The text has no `Z` and
  no offset, which the parser reads as a local date-time, so the answer is the
  wall-clock time the person saw. The prompt reads `initial`, `min` and `max` back
  with the _local_ getters for the same reason: this is the one place where that
  is right, because the value was built local. A wall-clock time a daylight saving
  gap skipped comes back as the engine resolves it, which is the parser's answer
  too. Ranges are compared as fields and not as `Date`s so that a check never
  moves with the zone.
- **Date only by default; ISO order always.** `time` adds hour and minute and
  `seconds` adds the second and implies `time` (seconds with no minutes would be
  a field with nothing in front of it). The segments are year, month, day, then
  the clock, whatever the locale: ordering by locale means the same prompt takes
  `06/15` in one place and `15/06` in another with nothing on screen to say which,
  and the parser's `date` type is ISO only. A `mask` was in the ticket's title and
  is not built -- `time` and `seconds` are the masks that exist, and a free-form
  one would be a second grammar next to the parser's.
- **Stepping wraps inside the segment and never carries.** Up on December is
  January of the same year; Up on 23 is 00 on the same day. Carrying would make
  one key change two segments, which is not what a segment stepper is, and the
  person who wants the next day presses Up on the day. What does change a
  neighbour is the day, because it depends on the month: it is pulled back to the
  last day of a shorter month and is not given back, so 31 January stepped to
  February and on to March is the 28th. Remembering the wanted day would be state
  the field does not show.
- **Digits fill a segment; Backspace clears what was typed into it.** The digits
  are pending until the segment is full or is left (arrow, Tab, Enter, a step),
  and pending digits are shown as typed with `_` for the rest. A full segment
  commits and moves on, except the last. A value is clamped to its segment's range
  when committed, so `99` for a month is 12 and `31` for a day in February is the
  last day. Backspace drops all pending digits and leaves the value as it was,
  rather than one digit at a time: a segment is two or four digits, and a half-typed
  year is retyped faster than it is edited. Anything but a digit does nothing.
  There is no separator-key advance (`-`, `/`, `:`, space), which is one more way
  to type the same thing.
- **`min` and `max` clamp every step and entry, and are inclusive at the precision
  shown.** The bounds are truncated to the fields shown before they are compared,
  so a `max` of three in the afternoon on the 20th allows the 20th in a date-only
  field -- otherwise the last day of the range would be unreachable. A write that
  would leave the range lands on the nearest bound. **Enter is where the error
  line lives** because the only value that can be out of range at that point is an
  explicit `initial`, which is deliberately not moved: moving it would answer a
  question nobody asked, and the person is better told than quietly handed another
  date. The default `initial` (now) is pulled into the range instead, since nobody
  chose it. `min` after `max` and an invalid `Date` reject at the call rather than
  producing a field that can never be answered.
- **The caret is a whole segment in reverse video, painted into the frame.** The
  decision recorded under "Prompts and keys" -- the terminal's own cursor is not
  moved -- applies unchanged, and so does its consequence: at colour level 0 no
  caret is drawn, so the focused segment is not marked there. The classes are
  `sigil-prompt-field`, `sigil-caret`, `sigil-muted` and `sigil-prompt-answer`;
  there is no new one.
- **Ejectable since SIG-201, through `@ttylabs/sigil/coerce`.** It was "not
  ejectable, for the palette's reason": `../util/transform.js` had no published
  subpath, and an ejected copy would have carried a second reader of the calendar,
  which is the thing this component exists not to have. `transformValue()` and
  `daysInMonth()` are published together there, so the copy reads the calendar
  from the parser's own function. `date` is in `generate-registry.mjs`'s
  `ENTRIES`. `date-parser.test.ts` still replaces the parser by mocking
  `util/transform.js`, which works because `util/coerce.ts` is a re-export of it.
- **Deliberately not done.** A timezone or UTC option; locale ordering; a
  free-form mask; a calendar popup; mouse; a range (two dates) prompt; paste
  handling (a pasted block is typed in as keys, as for the other non-text
  prompts, so `2024-06-15` happens to work -- the digits fill the segments and the
  dashes do nothing -- and nothing else is promised); clock injection (a test sets
  the system time).

### A calendar: one grid, three faces

SIG-187. `src/components/calendar.ts` is the whole of it: `calendar()` prints a
month, `pickDate()` asks for a day by moving through one, and
`date({ calendar })` (in `date.ts`) shows the same grid under the date prompt's
field.

- **One grid, built once and written into.** `calendarGrid()` makes a title, a
  weekday row and six rows of seven text nodes, and `update()` changes their text
  and classes. The printer builds it and updates it once; the two prompts update it
  per key. A tree per key would be the alternative and buys nothing, since the
  shape never changes. A row the month does not use is `display: none` for the
  printer and kept (empty) when `stable` is set, which both prompts do: a month
  that is four rows tall in February and six in August would move every line under
  it as the month changes.
- **Month and weekday names are `Intl`'s, not the catalog's.** That was the
  ticket's first question. A catalog entry per month per language is data the
  runtime already carries, and the locale is the i18n module's `locale()` when no
  `locale` option is given, so an app that translates its own output gets a
  calendar in the same language with nothing added. It is formatted with the
  Gregorian calendar and Western digits whatever the locale defaults to: the cells
  are Gregorian days written with `String()`, and a `th-TH` title in the Buddhist
  year over them would be a month that does not exist. A short weekday name is
  clipped to the two columns over its digits (`Mon` is `Mo`, `lun.` is `lu`).
- **Week start is the locale's unless told.** `Intl.Locale#getWeekInfo()` where
  the runtime has it, Sunday where it does not, and `weekStart: 0-6` (0 Sunday, as
  `Date#getDay()`) beats both. The ticket asked Sunday or Monday; any weekday costs
  nothing more and several locales start on Saturday. Tests pass it explicitly,
  because the default is the machine's.
- **A mark on the number, because colour is not guaranteed.** The selected day is
  `[15]` in reverse video; a highlighted day is `3*` in the accent role. A cell is
  four columns: an opening mark, two digits and a closing mark. The prompt's caret
  is paint-only and is not drawn at colour level 0, so a calendar whose only
  signal was reverse video would show nothing under `NO_COLOR`, and a printed
  calendar is the case where that matters most. A day that is selected _and_
  highlighted shows as selected, the thing that moves. Out-of-range days are
  `sigil-muted`, which is dim and is not a mark: they cannot be reached, so nothing
  depends on seeing them.
- **Neighbouring months are blank, not dimmed.** The cells before the first and
  after the last are empty. A dimmed `29 30 31 1 2 3` is the usual grid and was not
  worth a selection rule for days that are not in the month shown.
- **Days are dates by the local getters, and the year is taken whole.** A
  highlighted `Date` is the day it falls on in local time, whatever the clock. The
  calendar builds its own days with `localDate()` (`setFullYear` on a fixed date)
  because `new Date(y, m, d)` reads a year under 100 as 19xx and the parser's
  `date` type accepts `0000`; month lengths are the parser's `daysInMonth()`, as in
  the date prompt, so the two cannot disagree. That makes the `0000` leap-day quirk
  recorded under "A date prompt" the same quirk here.
- **A month change keeps the day where it can and pulls it back where it cannot.**
  31 January a month on is the 28th or 29th of February, not a day in March, and
  it is not given back on the way forward -- the date prompt's rule for stepping
  the month segment, so the grid and the field agree. The year stays inside
  0-9999.
- **`pickDate()` clamps an `initial` outside `min`/`max`; `date()` refuses it on
  Enter.** The date prompt keeps an explicit `initial` out of range so that the
  person is told rather than handed another date, and it has an error line to tell
  them with. This prompt has no field to type a different value into and no error
  line, only a cursor that cannot leave the range, so there is nothing for Enter to
  refuse and the nearest bound is the only answer it can give.
- **`date({ calendar })` is a display that pages, not a second picker.** The ticket
  said "optionally used by the date prompt as a picker". The field's keys already
  do what arrows would do (Up and Down step the focused segment, Left and Right
  move between them) and giving the same keys a second meaning in a calendar mode
  would make the same key do two things depending on state nobody can see. So the
  grid sits under the field showing the day it holds, follows every change to it,
  and gets the one pair of keys the field had no use for: Page Up and Page Down
  change the month, committing any digits typed so far first. `pickDate()` is the
  prompt that moves by day and week.
- **No year paging.** Shift-Page-Up would be the natural key, and the key decoder
  names `ESC [ 5 ; 2 ~` `unknown`: a tilde key's lookup includes the modifier
  parameter. That is the decoder's to fix, under "Prompts and keys", and not inside
  a calendar ticket. Until then a year is twelve Page Downs, or the year segment of
  the date prompt.
- **`calendar` is not an entry, though the reason it gave is gone, and `date` ejects
  through this file's exports.** The reason was `daysInMonth()` having no published
  subpath, which SIG-201 fixed with `@ttylabs/sigil/coerce`; `calendar.ts` still
  imports `../util/transform.js`, so adding it to `ENTRIES` also means pointing
  that at `coerce.js`, and nobody has asked for an ejected calendar. What did
  change is `date.ts`, which now builds on `calendarGrid()`, `addMonths()` and
  `dayKey()`. An ejected `date` imports them from `@ttylabs/sigil/components`
  because a sibling import is rewritten there, so the barrel exports them -- with
  `Day`, `CalendarGrid` and `GridView`, the types in their signatures -- and
  `should import only names the published subpath exports, for date` is the test
  that failed when SIG-187 and SIG-201 met without it. Neither branch was wrong
  alone: one made `date` an entry and the other made it import the calendar.
- **Deliberately not done:** week numbers; a range selection; marking today
  automatically (pass it as `selected`); leading and trailing days from the
  neighbouring months; mouse; a time of day in `pickDate()` (the date prompt is
  the one that has a clock); a `locale`-ordered title is whatever `Intl` writes
  (`2024年6月`), which is why the title is centred over the grid rather than built
  from a month and a year of our own.

### A key-help footer, read off the bindings

- **The line is `router.bindings()`, so it cannot say what the keys do not.**
  `bind(keys, handler, { description, group, priority })` carries the description
  in the same call as the handler, which is the answer to "on `bind()` or a
  separate declaration": a separate one is the hand-written line again. All three
  are optional and **dispatch reads none of them** -- a binding without a
  description behaves as it always did and is not listed, which is also how an app
  keeps a key it would rather not advertise out of the footer. A bad description
  or spec throws and takes the half-registered handler back off, so a refused
  `bind()` leaves no key behind. `src/input/AGENTS.md` has the router's half.
- **Focus scoping is the tree, and it is declared rather than invented.** Today
  only the sequence trie and function bindings are global; the one focus-scoped
  thing is an element's `onKey`, which bubbles from the focused element up through
  its ancestors. A function cannot be read for what keys it handles, so
  `describe(keys, { description, scope })` declares them, and `bindings()` lists a
  scoped entry while `scope` is the focused element or one of its ancestors --
  exactly the walk `dispatch()` makes. That half **can drift from its handler**,
  and the doc says so rather than hiding it; the cost of an element owning its
  keys is that the router cannot see them. A new scoping mechanism for `bind()`
  itself (a binding that fires only inside an element) was refused: it would change
  dispatch for every app, and a pending sequence makes it a question about what a
  held prefix means when focus moves.
- **Dispatch order, so priority is the footer's and order is the router's.**
  App-wide entries first, then scoped ones from the focused element outwards, each
  in registration order. `priority` (higher survives, default 0) decides only what
  is dropped when the line is too wide; it never reorders.
- **Truncation drops whole bindings, lowest priority first, later of two equals,
  and ends in `…`.** The mark's two columns are reserved before the fit is judged,
  or a row that just fit would overflow by the mark that explains it. Widths are
  `stringWidth()`, so a CJK description is two columns a character. A row that
  cannot fit even one line is the bare mark, or nothing at width 0 -- never a
  binding cut in half and never a wrap (`white-space: nowrap`, `flex-shrink: 0`).
- **Bindings sharing a description and group are one line (`↑/↓ move`), at the
  place of the first and at the highest priority among them.** That is what makes
  `bind('up')` and `bind('down')` read as the line in the ticket without a
  key-list syntax. Two bindings of one key and one description are one key.
- **The key names that are words go through `__`, and that departs from the
  prompts on purpose.** `prompt.ts` translates the modifier and leaves `enter` and
  `tab` English, on the ground that nobody types them. A footer _prints_ them, and a
  German footer saying `enter` beside `Strg-s` is the half-translated screen the
  catalog is meant to prevent -- so `enter`, `esc`, `tab`, `space`, `backspace`,
  `delete`, `home`, `end`, `pgup` and `pgdn` are literal `__` calls (a name held in
  a variable would key on `{0}`), arrows are glyphs, and the modifiers nest
  (`ctrl-{0}` and `alt-{0}` are the prompts' own messages; `shift-{0}` is new).
  Descriptions are the app's strings and the app translates them where it writes
  them; the footer never wraps them in `__`.
- **Reactive through two signals, with no new mechanism.** `bindings()` reads the
  focus signal and a revision counter bumped by registering or unregistering a
  description, so an effect re-runs on either. The footer rebuilds its children in
  one effect rather than keeping a pool of rows: it is a handful of nodes, and a
  pool would be the optimisation the palette's `draw()` needed for a catalog.
- **The footer does not claim a key.** `?`, and whether the footer is expanded, are
  the app's: `expanded` is a boolean or a `State<boolean>` and the demo binds `?`
  to it, for the reason the palette does not bind a key to open itself.
- **The width is the layout's, learned through `onResize`, the way the tabs row
  and `TextField` learn theirs (SIG-311).** This entry used to say the footer
  could not know its box, so `width` defaulted to `terminal.width` read inside the
  effect, and that effect re-ran only when the bindings or the focus moved -- so a
  resize left the line fitted to the old width until an unrelated key moved the
  focus. The premise was wrong: nothing has to be laid out inside the effect,
  because a frame dispatches `onResize` after its layout and before its paint, so
  the footer records the room, refits, answers whether that changed the tree, and
  the first frame is already drawn at the right width. `terminal.width` is now only
  the guess the effect fits to before any layout has said, which nothing on the
  screen is drawn from. The system monitor (SIG-291) and the demo both passed a
  width function fed by `input.onResize()` to get round it; neither does now.
- **The short form asks for every line, whatever it kept: `width` the natural
  width of all of them, `max-width: 100%`, `min-width: 0`.** The same loop
  SIG-318 found in `TextField`, met before it could ship. A row is the default
  direction and sizes a child to its content, so a footer that asked for what it
  kept was laid out at the width of its last fit: squeezed once, it dropped a
  binding, was laid out narrower, and was never offered the room back however
  wide the terminal grew. Asking for all of it makes the box independent of what
  was drawn in it. Each declaration has a sabotage of its own in
  `in a running app, sized by its box`: no `onResize` fails both cases, no `width`
  fails the row growing back, no `max-width` fails the column -- a declared width
  is not stretched, and is not clamped to the column either -- and no `min-width`
  fails the row being squeezed at all, since a box's automatic minimum is its
  content's. Three costs are taken knowingly. In a column the box is the natural
  width rather than stretched, which only a background on `.sigil-key-help` would
  show. Between the `…` and whatever follows the footer in a row there is up to
  one dropped line's worth of blank, because the box is the room it was given and
  it shows whole lines. And beside a status, both shrink in proportion unless the
  status says otherwise -- the monitor gives its status `flex-shrink: 0`, since
  what just happened is the line worth keeping whole.
- **An explicit `width` is the app's answer and the layout is not asked.** No
  `onResize` and no declared width, so `width: 60` and `width: () => n` behave
  exactly as they did -- which is what `prompt.ts` passes, fitting its footer to
  the columns it already computed. The long form declares nothing either way: its
  descriptions are cut by the layout's own ellipsis, so it has no room to fit to,
  and holding it to the short form's width would cut a group heading wider than
  the line under it (`should not hold the long form to the width the short form
  asked for`). A draw that would change nothing -- the same lines, the same
  form, the same width asked for -- does nothing and answers `false`, so a resize
  that keeps every line costs no rebuild and a frame no second layout -- `should
  answer a resize that changes no line as no change` asks the hook directly,
  since a frame that lays out once more converges either way and cannot see it.

#### What is deliberately out

- **Replacing the built-in prompts' hint lines.** They kept their own text in this
  change: `select()` and `multiselect()` were being rewritten in another open
  change and the hints are translated strings with their own tests
  (`prompt-i18n.test.ts`). Done since, by SIG-205 -- see "The built-in prompts draw
  the footer" below, which is also where the router question this left open is
  answered.
- **A binding that fires only inside an element.** See above.
- **Listing a function binding.** `bind(handler)` sees every key and has no key to
  name; it is not listed, and `describe()` with a key is how to list what it does.
- **Pagination of an expanded form taller than the terminal.** It lists everything,
  under its groups, and an app with that many keys wants a screen of its own.
- **A `?` toggle, a hide/show key, or a default mouse hover on the footer.**

### The built-in prompts draw the footer

SIG-205. Every prompt that drew a hand-written key hint -- `multiselect()`,
`groupMultiselect()`, `autocompleteMultiselect()`, `multiline()`, `sort()` and
`selectRow()` -- draws the SIG-166 footer under itself instead, and seven hint
keys left the catalog.

- **A prompt grows no router, because it never lacked one and the footer does not
  need one.** The question SIG-166 left was whether "a prompt, which owns no router
  unless it borrows one, should grow one". It rested on a premise that had stopped
  being true before it was written: `run()` has built a router of its own whenever
  none was handed in since the components became element trees. And `keyHelp()`
  takes a `KeyHelpSource` -- `bindings()` and nothing else -- precisely so that
  drawing one does not need a router behind it. So there was nothing to grow.
- **The keys are a table the prompt owns, and nothing is written to the router.**
  `promptKeys()` is that table: `on(keys, run, help)` puts a handler and its
  description in one record, `match(k)` is what `key()` dispatches through, and
  `bindings()` is what the footer reads. One record is both halves, so a listed key
  cannot drift from what it does -- the property `describe()` could not promise an
  element's `onKey`, had here without registering anything on the router.
  Registering with `bind(keys, handler, help)` was the alternative, and it is
  refused twice. It would change dispatch for every app that hands a router in: a
  prompt's one function binding is what makes Ctrl-C go first, what `claims()`
  lets the multiline field take Ctrl-D through, and what queues one key at a time
  behind an async `validate` -- the trie runs after every function binding and has
  none of that. And a borrowed router's list is **the app's footer**: a prompt
  swallows every key while it is up, so reading `router.bindings()` would list the
  app's keys as live under a prompt that eats them, and writing the prompt's own
  into it would put them in the app's footer and leave the app's beside them.
  `should draw its footer from its own keys, and list nothing on the router` pins
  the list as exactly what the app put there, before, during and after.
- **A key is matched the way `bind()` matches one, modifiers and all.** By
  `formatKey()`, so Shift-Down is not Down and Alt-Space is not Space -- the rule
  `confirm()` already keeps for `Y` and Ctrl-Y. That is a behaviour change in the
  six prompts and it is taken knowingly: they read `k.name` and ignored the
  modifiers, so Ctrl-Up moved the cursor and Alt-Enter confirmed. Where a modified
  key meant something it is an entry of its own: `ctrl+a` beside `a` in both
  multiselects, `shift+` and `alt+` arrows in `sort()`. A text field's editing
  keys stay in the chain after the table, because nothing lists them and readline
  modifiers (Ctrl-W, Alt-B) are a vocabulary the table would only restate.
- **What is listed is what nobody would guess, and the arrows are not.** That is
  the line `src/i18n/AGENTS.md` already drew for `select()` -- "tick boxes need
  telling and arrow keys are discoverable" -- applied per key rather than per
  prompt. The arrows, Home, End and the paging keys are entries with no help: they
  dispatch and are not listed, which is the footer's own rule for a binding with no
  description. `sort()` lists `↑/↓ move` **while a row is carried**, because that is
  when an arrow does something an arrow does not usually do; help may be a
  function for that, read again on `refresh()`, which `draw()` calls.
- **`text()`, `password()`, `select()` and `confirm()` draw no footer.** The first
  three never had a hint, and growing one would be a row nobody asked for under
  every one of them. `confirm()` keeps `(Y/n)`: it is one catalog entry deciding
  both what is drawn and what is accepted (`confirmKeys()`), it is where the
  default is shown, and a footer under a one-line question would double its
  height. `selectKey()`'s `(Y/n/a/d/h)` stays for the same reasons -- generated
  from the keys already, so it was never the hand-written line this replaces.
- **The footer is one row under everything, so the head has no tail to reserve.**
  The hint sat beside the question and `headWidths()` capped its reservation at
  half the line; the footer is a row of its own at the bottom, indented under the
  question the way the error line is, so the question takes the whole line and the
  list is windowed against one more row. It never wraps -- what does not fit is
  dropped whole, lowest priority first, and the row ends in `…` -- so "what is
  reserved at narrow widths" is now **exactly one row at every width** rather than
  half a line that wraps. The multiselect's priorities say what survives: Space and
  Enter (3) are the two it cannot be answered without, select-all (2) goes before
  them and invert (1) first, so 40 columns is `space select · a all · enter confirm
  …` and 30 is `space select …`. `headWidths()` keeps its tail parameter for
  `confirm()` and `selectKey()`.
- **The narrow-width tests moved, and each move is the behaviour rather than a
  loosened assertion.** `should not flatten the question to reserve a long hint`
  became `should give the question the whole line now the keys are a footer`;
  `should window the list against the head it drew` -- which asserted a head made
  taller by a wrapped hint, a thing a footer cannot do -- became `should window the
  list against the footer and the error line`, which asserts seven of eight
  choices on ten rows and the footer still on the last one; and the submit-hint
  case asserts `ctrl-d submit`. The `(Y/n)` sweep is untouched, since `confirm()`
  did not move. Every list that is screen-bound shows one row fewer, which moved
  the window and page counts in `sort.test.ts`, `select-row.test.ts`,
  `multiline.test.ts` and `autocomplete-multiselect.test.ts` by exactly that row.
- **A settled answer is no longer reserved for at narrow widths.** It used to be
  written into the hint's element, which inherited the hint's reservation; it is
  an answer element of its own now, which is what `select()` has always had -- so
  below about twenty columns a long settled list clips the way `select()`'s does.
  The same rule for every list prompt rather than a better one for some.
- **`selectRow()` binds a digit per sortable column, and the footer folds them.**
  `enter pick · 1/2/3 sort` rather than `1-3`, and only the columns that sort get
  a digit -- so a table whose middle column does not sort says `1/3`, where the
  hint said `1-3` and named a key that did nothing.
- **The orphaned keys are retired and `sigil check` will say so, which is the
  point.** `(space to select, enter to confirm)`, `(space to grab, enter to
  confirm)`, `(up/down to move, space to drop)`, `(enter to pick)`, `(enter to
  pick, 1 to sort)`, `(enter to pick, 1-{0} to sort)` and `({0} to submit)` went,
  and so did `ctrl-alt-{0}`: the footer nests `ctrl-{0}` around `alt-{0}`, so a
  translator writes each modifier once. Ten came in -- `select`, `all`, `invert`,
  `confirm`, `submit`, `grab`, `drop`, `move`, `pick` and `sort`. An app catalog
  carrying the old seven is told they are orphans and the new ten are missing,
  which is `sigil check` working rather than a regression: a sentence that left
  the framework is exactly what an orphan report is for, and keeping dead keys
  alive to keep a report quiet would be the opposite. The key names a footer
  prints that are words -- `enter`, `space` -- are translated too, which is the
  footer's own recorded departure from the prompts' `keyLabel()`; that function
  had one caller, the multiline hint, and went with it.
- **`promptKeys()` and `promptFooter()` are exported with the rest of the prompt
  plumbing**, for the reason `runPrompt()` is: `group-multiselect.ts`, `sort.ts`,
  `select-row.ts` and `autocomplete.ts` are separate modules and an ejected copy
  of one imports them from `@ttylabs/sigil/components`. A third-party prompt gets
  the same footer for the same price.

### An autocomplete prompt: type to filter, or search a source

SIG-158. `src/components/autocomplete.ts` is a filter field over a ranked list,
which is what the palette already is, so it is modelled on `palette.ts` and
borrows `runPrompt()` and the field helpers rather than reading a key itself.
`select()` and `multiselect()` are untouched.

- **One entry point, `choices` or `source`, and both is an error.** The two ways
  to supply a list differ in who filters it: a static list is ranked here with
  `rankBy()`, and a source _is_ the filter, so what it returns is drawn as it
  comes -- re-ranking it would hide a result the source matched on something the
  label does not show (an id, a description). Taking both would need a rule for
  whose filter wins, which is a rule with no caller; it rejects with a
  `PromptError` naming the question, as does neither and an empty list, in plain
  English like `select()`'s own.
- **A lookup is superseded, not outdated, and the signal is what says which.** The
  previous call is aborted _before_ the next is started, and a result is written
  only if its **own** signal is still live. Comparing the term it was asked about
  with the current one answers a different question -- backspace `ab` to `a` and
  type `b` again and the old `ab` lookup has the right term and the wrong
  lifetime. The rule holds for a rejection as well as a result, and for a result
  that arrives after the prompt ended (`closed`, set by an `onCleanup`, which is
  also what aborts the call in flight when the prompt is cancelled -- `settle()`
  never runs for a Ctrl-C).
- **Enter waits for a lookup in flight.** The list on screen belongs to an
  earlier term while one is out; it is left drawn because blanking it per
  keystroke flickers on a fast source, but answering from it would hand back a row
  for a question no longer being asked. The cost is a source that never settles
  blocks Enter, and Ctrl-C is how out of that.
- **A failed lookup empties the list and says why on the line under it; the next
  keystroke asks again.** That is `validate`'s own channel (one reserved line,
  `sigil-prompt-error`), shared with the status and empty messages because the
  three are never true together. The prompt stays alive, which is the only useful
  answer to a network that may be back by the next key. A source that throws
  synchronously is the same as one that rejects.
- **Only a key that changes the term asks the source.** Arrows, Home, Tab on a
  label already in the field and a backspace at the start of an empty field leave
  it where it was, and each of those calling out would be a request per arrow
  press.
- **Tab completes the label, and Enter answers the value.** Tab writes the
  highlighted _label_ into the field and, for a static list, keeps that same
  choice highlighted: ranking its own label usually puts it first, but two
  choices may share one, and a highlight that jumped to the other would make Tab
  and Enter disagree. For a source the completed label is a new term and is
  looked up as one.
- **No debounce, and the README holds the recipe.** Whether a lookup is worth
  waiting for is the caller's trade, and `signal` is what makes the wait
  cancellable. The prompt calls the source on the opening empty term so that there
  is a list before anything is typed.
- **Rows are rebuilt per draw for the window and not kept per choice.** The
  palette keeps a row per catalog entry because its catalog is fixed; a source
  hands back a different list each time, so there is nothing stable to keep, and a
  window of ten is cheap. A frame is requested by the `setText()`/`append()` the
  draw does, so an answer that arrives with no key behind it is painted by the
  renderer's next paced frame -- which is why the tests wait for one.
- **`toChoice()` and `valueOf()` are exported from the bottom block of
  `prompt.ts`** (as `promptChoice` and `promptValue`) rather than copied, so a
  change to what a `Choice` is made in one place.

- **A disabled choice is left out, not shown and refused.** `select()` keeps one in
  view and steps the cursor over it. This prompt has no cursor to step: a disabled
  choice would be ranked, highlighted, filled in by Tab and taken by Enter, so
  leaving it out of what is offered is the one rule that covers all four. It
  applies to a `source`'s result as well as to `choices`, and a list with nothing
  else in it is refused the way an empty one is. What that costs is that a reason
  for `disabled` is never shown -- it is the lookup's job to say why a thing is not
  there, and a list that is filtered by typing is a poor place for a row that
  cannot be chosen. Found by review after #202 merged: the first version deferred
  this to #196, and by the time that landed the type allowed a flag the prompt
  ignored.

What is deliberately not done:

- **Separators on `Choice`.** `select()` takes them; this prompt has no cursor to
  step over a heading and a filtered list of one has nothing to introduce.
- **The multi-select variant** is below, and is `autocompleteMultiselect()`.
- **Highlighting source results.** A source's match is its own, and marking the
  term inside a label it did not match on would be marking nothing.
- **Escape.** It does nothing, as in `text()` and `select()`; a prompt that
  answers `undefined` is the palette's, which is not asked for a value.

### A searchable multiselect: ticks that outlive the filter

SIG-167. `autocompleteMultiselect()` is in `autocomplete.ts` and is not a second
implementation: both entry points are the one `search()`, and a `multi` argument
is the whole of the difference. Two prompts that each read keys and manage a
lookup would be two sets of answers about superseded lookups, which the entries
above spend most of their length on. It is one registry entry for the same
reason -- ejecting `autocomplete` brings both.

- **Hidden ticks stay ticked, and are counted, not listed.** The ticks are a
  `Map` of value to choice, outside the list: the list is rebuilt for every term
  and a source hands back different rows each time, so a tick kept on a row would
  be lost with the row. The line under the list says `Selected: 3, 1 not shown`,
  and the names are not on it -- a long selection would take the screen, and the
  count is what says the answer is not what is in view. `min` and `max` count the
  hidden ones: the answer is the ticks, and the screen is a view of them.
- **Space toggles and is not typed.** A space cannot be typed into the field. The
  alternative was a different toggle key, and every one was a letter (typed), a
  chord the terminal may eat, or Tab (which completes a label here, and is the
  one key a filtered list needs for it). A pasted term still takes spaces, and
  fuzzy matching does not need one -- `newj` finds `new jersey`.
- **A tick is keyed by `value`, compared as `Map` compares.** A static list's
  choices are stable objects, but a source's are new ones on every call, so
  identity would tick one lookup's `react` and not the next's. Two rows with one
  value are one choice. A source that returns object values built fresh each time
  is not recognised, and the README tells it to give the choice a primitive.
- **The answer is in list order for `choices` and in tick order for a `source`.**
  `multiselect()` answers in list order, which this keeps where a list exists; a
  source has none, and an order derived from the last lookup would change with
  the term.
- **`selected` is read from `choices` only.** A source is asked again on every
  keystroke, so honouring it there would tick a row again after it was unticked.
- **Space waits for a lookup in flight, and Enter does not.** The rows on screen
  belong to an earlier term while one is out, and ticking one is answering from
  it -- the rule Enter already follows in `autocomplete()`. Here Enter confirms
  the ticks, which no lookup can change, so there is nothing to wait for.
- **The line under the list is one line more than `autocomplete()` keeps back**,
  for the tally. It showed the key hint while nothing was ticked, which was
  `multiselect()`'s own string; since SIG-205 it says nothing until something is
  ticked, and a key footer under it -- one more row kept back -- names Space and
  Enter. The single `autocomplete()` has no footer, for `select()`'s reason.
- **`validate` takes the array.** It runs after `min` and `max`; a refusal is
  shown on the foot line and the prompt stays open.

What is deliberately not done:

- **Select all, invert, and a toggle-all key.** `multiselect()` has `a` and `i`;
  here those are letters in the field, and a select-all over a list the term has
  narrowed is ambiguous between the rows shown and the whole list. A caller who
  wants everything passes `selected: true`.
- **Listing the hidden selections.** See above.

### A path prompt: a text field that completes against the file system

SIG-164 asked for the thing Clack's `path`, Bubbles' filepicker and `gum file`
all answer, and observed that there are two widgets in it: a field you type a
path into and a tree you browse. `src/components/path.ts` is the first, and only
the first.

- **The field, and not the tree, and not one component with both modes.** They
  share a question and nothing else: the field's state is a string and a cursor,
  the tree's is a directory and a selection, and a mode flag would make every key
  mean two things. The field is a prompt in the sense `prompt.ts` is about -- a
  value comes back, typed -- so it borrows that file's plumbing the way the
  palette does. The browsing picker is `filePicker()`, below.
- **The answer is the path as typed, with `~` expanded, and resolved only when a
  `root` was given.** Returning a resolved absolute path unasked would take
  something away from the caller who wants a relative one, and handing back `~/x`
  would hand them a path `readFile()` cannot open, because nothing downstream
  honours `~`. `root` is the one option that says "I want to be told where this
  is", so it is the one that resolves. `validate` is given the string that will be
  returned rather than the raw field, so a check like "must exist" is a `stat` of
  what it was handed. A resolved answer loses a trailing separator -- `resolve()`
  does -- while an unresolved one keeps what was typed.
- **Nothing checks that the answer exists, or that it is a directory.**
  `directory` and `extensions` narrow the _candidates_. A prompt for where to
  write wants a path that is not there yet, and whether one has to exist is the
  app's rule, which is what `validate` is for.
- **`~` goes through `paths.ts`, and a `~` that expands to nothing names nothing.**
  `baseDir()` is the one rule for "expand, then require absolute", so `~user/`
  (which `expand()` does not implement) and a `~` with no home both have no
  directory and therefore no candidates, rather than a directory literally called
  `~`. A bare `~` or `C:` is offered as a candidate of its own on Tab, because
  `readdir` cannot list them from where the prompt is and Tab would otherwise find
  nothing at the one place a person types a path and is told there is nowhere to
  go.
- **Candidates are for the whole field, and completing moves the cursor to the
  end.** Completing against the text before the cursor, and keeping what follows
  it, is a second rule for a field a person types left to right.
- **Tab is "the longest prefix everything shares", and only ever longer than what
  was typed.** On a caseless file system the candidates agree with the typed
  segment but not in case, and a shorter shared prefix would undo the person's own
  characters. A single candidate is completed whole, with a separator if it is a
  directory. A highlighted candidate beats the prefix.
- **Enter means the field until a candidate has been highlighted.** Up and Down
  walk the list through a position with nothing highlighted, so there is a way
  back that is not typing. Enter on a highlighted _file_ takes it and submits; on a
  highlighted _directory_ it fills it in and carries on, because a directory is a
  place to go on from far more often than it is an answer -- and in `directory`
  mode a second Enter submits it. Tab never submits.
- **A directory is completed in the separator the person is using.** `C:/Users/`
  is not answered with a backslash. Windows takes both separators and POSIX one: a
  backslash on POSIX is a file name character. The platform is read from
  `node:path`'s own `sep`, and the pure helpers (`splitTyped`, `candidatesOf`,
  `commonPrefix`, `answerOf`) take that as an argument so a test hands them
  `win32` rather than forcing `process.platform`. Case is ignored in matching on
  Windows only; macOS is case-insensitive by default and case-sensitive if
  somebody formatted it so, and a prompt cannot know which.
- **Dotfiles are skipped, and a segment that starts with `.` asks for them.**
  `hidden: true` shows them from the start. Directories sort first and then by
  code unit rather than `localeCompare()`, so the order does not depend on the
  machine's language.
- **One read per directory, cached for the life of the prompt, and that stands in
  for a debounce.** The cost of typing is a `readdir` per directory _level_, and
  the characters between are a filter over what is already in memory. A read that
  fails -- missing, not a directory, no permission -- is cached as empty rather
  than raised. A directory created while the prompt is open is not seen, which is
  the price of the cache.
- **A late read can never be drawn, and a key that only edits never waits for
  one.** A key is applied at once and draws the list from the cache for the value
  as it is _now_; the read for the directory that value names is started in the
  background and the list catches up when it lands, which is what a paste and the
  first listing always did. A read that finishes late fills the cache and can only
  repaint the newer answer. The first version awaited the read at the top of
  **every** key, on the argument that keys are handled one at a time so a read
  cannot answer for the wrong keystroke -- true, and the price was that the same
  queue let one slow `readdir` (a network mount, a stalled disk, a huge directory)
  hold every key behind it, the Backspace that gets away from the directory
  included. Ctrl-C was never held, because the prompt does not queue it, which is
  why this was a freeze rather than a trap.

  **Tab, Enter, Up and Down still wait**, and that is the half that is not
  obvious. They act on the list, so acting before it exists is acting on nothing:
  the first version of the fix waited for none of them and `b`, Down, Down, Tab
  typed ahead of the first read ended with the Downs dropped -- found by the
  suite, as a test that failed only under load. They wait for the directory their
  own value names and nothing else, so typing still never waits, and a key typed
  after one of them queues behind it only for as long as that one read takes.

  The test holds a read open across a keystroke. Its gate is written against the
  path `readdir` is handed -- `resolve()` strips the trailing separator, so a gate
  for `alpha/` held nothing and the test passed whatever the prompt did -- and it
  asserts the read really was held, for that reason.

- **"No matches" is only said about a directory that has been read.** Before the
  read returns there is no answer, and saying so would be a claim about a list
  nobody has seen.
- **Symlinks are followed to decide whether they are directories**, with one
  `stat` each; a dangling link is a file.

What is deliberately not done: completing mid-value;
checking that the answer exists; refreshing a cached directory; fuzzy matching
(a prefix is what a shell does and what a person typing a path expects); showing
file sizes or types in the list.

### A file picker: browse a directory tree with the arrows

SIG-202. `src/components/file-picker.ts`, the other widget SIG-164 named and set
aside. `path()` is for someone who knows the name and this is for someone who
does not: a list of a directory, Right or Enter to go in, Left or Backspace to
come out, and the answer is the entry you land on.

- **A component of its own, and what it shares with `path()` is the half that is
  not the prompt.** The two have different state (a string and a cursor; a
  directory and a highlight), different keys and different frames, so a mode flag
  would make every key mean two things. What is shared is moved out of `path()`
  rather than copied: `candidatesOf()` decides what is on offer, so `directory`,
  `extensions` and `hidden` mean the same in both and the two cannot come to
  disagree about what a file is, and `entryCache()` is the once-per-directory
  read, which `path()` now uses too. Both are exported from the barrel, because
  the registry entry for `file-picker` imports them through
  `@ttylabs/sigil/components` like any sibling, and an ejected copy would
  otherwise reach for a name that is not published. The cache is per prompt, as
  it always was: "shared" is the code, and nothing is remembered between two
  prompts, for the reason a stale directory is already the stated price of the
  cache.
- **The answer is always an absolute path.** The picker is built from a
  directory that has been resolved, so there is no typed spelling to preserve --
  which is the reason `path()` returns what was typed and this does not. `root` is
  where it starts and nothing else; with no `root` that is the working directory.
- **Right goes in, Left comes out, and Enter does what the row is for.** Enter on
  a directory goes in and on a file chooses it, which is the ticket's description.
  `directory` mode inverts that and Right is then what goes in: a prompt for a
  directory that went in on Enter could never answer one. The first row of a
  `directory` list is `.`, the directory being looked at, so a directory with
  nothing in it can still be the answer and Enter on a fresh picker answers where
  it is. Bubbles' `DirAllowed` is the model; the `.` row is what stands in for its
  select key.
- **Left lands on the directory it left, and does not wait for a read.** The
  highlight is a name asked for (`want`) and resolved when the parent's listing
  exists, so going up out of a directory that is slow to read does not hold the
  Left behind the read -- `path()`'s lesson about a Backspace that cannot get
  away, kept. Every key that acts on the list (move, go in, choose) waits for the
  current directory, so keys typed ahead of the first read still land on the list
  they imply. `should not hold Left behind a directory that is slow to read` is
  the check, and awaiting the read first fails it and nothing else.
- **`confine` is a navigation rule and not a sandbox.** Left stops at `root`, and
  that is all it says: a link inside `root` that points out of it is followed, and
  the picker goes up by the logical path it came down, not the link's target. An
  app that has to refuse a path says so in `validate`. At a file system root Left
  has nowhere to go, which is `dirname(dir) === dir` and needs no platform
  branch: `/` and `C:\` are both fixed points. A Windows drive letter is
  somewhere to start and not somewhere to go up to -- listing the drives would
  need a call this package has no portable way to make, so it is not done rather
  than done by guessing at `A:` through `Z:`. `parentOf()` and `entryPath()` take
  the flavour as an argument for `path()`'s reason, and the tests hand them
  `win32`.
- **`.` toggles dotfiles, and sizes and types are not in the list.** There is no
  field to type a dot into, so the key is free; the highlight stays on the same
  name through the toggle, and falls to the top if that name was the one hidden.
  Bubbles shows size and type; `path()` deliberately does not, and a `stat` per
  entry is a read the once-per-directory cache was written not to make. The
  trailing separator on a directory is the whole of the type column.
- **A hand-built list rather than a `ScrollBox`.** The rows are rebuilt per draw
  for the window on screen with `listWindow()` and `promptRowCap()`, as `sort()`
  does: a list that is replaced wholesale on every directory has no row that
  stays attached to an entry, which is what a `ScrollBox` is for, and a prompt
  is not mounted in a full-screen canvas.
- **"No matches" is only said about a directory that has been read**, and in
  `directory` mode that is a list holding only `.`. It reuses the key `path()`
  already has rather than a new one, because the list can be empty from the
  filter as well as from the directory.

What is deliberately not done: typing to filter (that is `path()` and
`autocomplete()`); a drive list; a `~` or Home key; showing sizes or types;
choosing several files; refreshing a cached directory.

### Leveled status lines: `log`

SIG-162. `src/components/log.ts` is the whole of it, and `src/terminal/index.ts`,
`src/terminal/live.ts` and `src/canvas/backend.ts` each grew one small seam so
that a line can land above a live region without the caller holding it.

- **It is not `src/debug/`, and the two must not be merged.** That logger is
  `DEBUG`-driven developer output and says nothing unless asked; `log` is what a
  command tells the person running it and speaks by default. They share a word.
- **Every level goes to stderr.** Not "stderr for `warn` and `error`, stdout for
  the rest", which was the ticket's first question: a command's `run()` returns
  data and a serializer prints it to stdout ("Output formats", root `AGENTS.md`),
  so an `info` line on stdout lands in the middle of `mycli --format json | jq`.
  The data is stdout's and the commentary is stderr's, whichever level it is. The
  stream comes from the terminal (`writeStatus()`), never from `console.*`, so a
  test can capture it.
- **Colour is detected from stderr, not stdout.** `createAnsi({ stream:
  terminal.stderr })`, because `mycli > out.json` leaves stdout a file and stderr
  the screen -- the one `ansi` instance reads stdout and would strip the colour
  from the lines that are for a person. `FORCE_COLOR` and `NO_COLOR` still win,
  being `supportsColor()`'s. A file gets no escape sequence and is **not wrapped**:
  a line cut at 80 columns cannot be grepped whole.
- **Above a live region is the terminal's job, because the claim is the
  terminal's.** `log.info()` has no handle on whatever spinner is running and
  should not need one. `claimLive()` takes an optional `above` callback and
  `Terminal.writeStatus()` calls the holder's, else writes to stderr. The inline
  canvas, the full-screen canvas and `createLiveRegion()` each register theirs; the
  first and third erase, write and repaint, the full-screen one **holds** the line
  and flushes it to stderr (not stdout) on the way out, the rule it already keeps.
  `CanvasBackend.write()` and `LiveRegion.write()` gained an optional `'stderr'`
  second argument for it. This is the existing mechanism extended by a stream, not
  a second one. A stderr that is **not a screen** (`2> errors.log`) skips the erase
  and repaint: there is nothing to get out of the way of and it would only flicker.
- **A carriage return goes with every line feed on a screen** -- the canvas
  backend's `crlf()` reasoning: raw mode turns the terminal's own translation off
  and this cannot see whether it is on.
- **Quiet is per level.** `info`, `success`, `step` and `message` are progress and
  are dropped; `warn` and `error` are never dropped, because "a result is not a
  progress report" (`src/style/output.ts`) and a quiet run that swallowed an error
  would be useless. Asked **per call**, not frozen at construction, because `log`
  is built at module scope before `main()` reads argv (`Spinner.write()`'s rule).
  `quiet: false` opts a logger out of the process-wide request. A non-TTY is the
  `reduce` level, not `quiet`: a log file is where a status line is most wanted.
- **Glyphs are shared, and chosen by the caller.** The four outcomes are the
  spinner's (`OUTCOME_SYMBOLS`, now exported) and `step` is the prompts' pointer
  (`PROMPT_SYMBOLS.cursor`), so a log line and the spinner before it agree about
  what a warning looks like. `LOG_SYMBOLS_ASCII` is chosen with `ascii: true`; no
  neighbour detects a terminal that needs ASCII (`LINE` is the spinner's), and a
  wrong guess prints `?` where a status was.
- **The glyph is drawn in a role and the message is not.** `.sigil-info`,
  `.sigil-success`, `.sigil-warn`, `.sigil-error`, and `.sigil-accent` for `step`;
  no colour in props. A coloured message is a wall of red for a stack trace.
  `message()` with no symbol has no glyph column at all, so its text starts at the
  margin; with one it is uncoloured.
- **Multi-line text is a column beside the glyph**, so the indent is the box
  model's rather than a count of spaces that has to agree with the glyph's width
  (a wide custom symbol is measured by columns). Each line of the caller's text is
  its own node: the layout collapses a newline, and a blank line has to survive.

**Deliberately not done:** a `stream` option to choose stdout, which is a separate
backlog ticket (stderr is the whole answer to `--format json`, and a stdout `log`
is how it gets corrupted); detecting ASCII-only terminals; routing the debug
overlay or `console.*` through it. Structured fields and timestamps were on this
list and are below.

#### Fields and timestamps on a `log` line

SIG-206. Still `src/components/log.ts`; `formatLogFields()` is in it rather than in
a sibling, because a sibling's exports have to be public for the ejected
`registry/log.ts` to import them, and this one is worth exporting anyway.

- **Fields are logfmt-shaped, `key=value` after the message, and are not JSON.**
  `log.info('deployed', { host: 'a', ms: 412 })` is `deployed host=a ms=412`: a
  shape a person greps and a tool splits on a space, with nothing to learn. The
  ticket's other options were refused -- following lines break a grep of one
  event into several rows, and a JSON line is the `--format json` question the
  ticket says to name separately. A logger that wrote JSON lines is a different
  feature and is not started here.
- **Quoting is the whole of the safety, and it is one function.** `token()` writes
  a key or value bare when it is a plain word and quotes it when it is empty or has
  a blank, `"`, `=`, a backslash or a control character. Inside quotes every `\p{Cc}`
  character, `ESC` among them, and `\p{Zl}`/`\p{Zp}` is an escape: `\n`, `\r`, `\t`, and
  `\uXXXX` for the rest. `JSON.stringify()` was not used because it leaves `DEL`,
  the C1 range and U+2028 raw, which is exactly what a reader that splits lines on
  more than `\n` -- or a terminal that obeys a C1 byte -- acts on. The key goes
  through the same function, so it cannot carry a break either. `no line break
  survives` is asserted on the screen and on a file, over every one of those
  characters.
- **The message may be multi-line and the fields never are.** They sit on the last
  line of the message, beside it when they fit and under it, indented with the
  text, when they do not. The fit is decided in `write()` against the width it
  already knows, and a file's width is made from the content so that the fields are
  always beside the message there: a record is one line of a file whatever it holds.
- **Drawn in `.sigil-muted`, the glyph's neighbour and not the message's.** The same
  role a hint is drawn in, so a theme that restyles it reaches every one; the
  classes `.sigil-log-fields`, `.sigil-log-time` and `.sigil-log-line` are hooks
  with no rule of their own.
- **Values are written as what they are, and a status line never throws.** A
  string is itself; an object or array is its JSON; a `Date` is its ISO form; an
  `Error` is its message; anything else is `String()`. `undefined` is left out
  rather than written, which is what makes `{ host: opts.host }` usable without a
  guard. A value `JSON.stringify()` throws on (a cycle, a nested `BigInt`) falls
  back to `String()`, since a log call that raises is worse than an ugly field.
- **A timestamp is an option of the logger, not of a call.** A stamp on some lines
  of a log is one a reader cannot rely on, and a per-call option would be a way to
  write one. `true` is the local `HH:MM:SS`, which is what a person watching wants;
  `'iso'` is the UTC instant, which is what a file read on another machine wants,
  and local versus UTC is chosen by name rather than by a second flag. A function
  takes the `Date` and has line breaks and control characters replaced by a space,
  because a stamp is text a caller wrote and the same rule applies to it as to a
  field. It is a column before the glyph, so a second line hangs under the message
  and not under the clock. There is no process-wide setting: `log` is the process's
  logger and an app that wants stamps builds its own with `createLog()`, which is
  what it does for `ascii` and `symbols`. `now` is the clock, so a test needs no
  fake timers.
- **Quiet is unchanged and is asked first.** A line the quiet axis drops returns
  before it formats a field or reads the clock, so a dropped line has no side
  effect -- a getter on a field and a stub clock are both asserted not called.
  `warn` and `error` are still never dropped.
- **Not done: fields and stamps on `log.stream`.** A stream is a source whose text
  has not all arrived, and where its fields would go -- before the first line,
  after the last -- is a question the ticket for the stream did not ask. A stream
  line carries no stamp either, which is why the option's own doc says so.

### Tasks: a list of work, and a subprocess's output in a window

`src/components/tasks.ts`: `tasks()` runs a list under spinners and `taskLog()` is
the window a task writes a subprocess's output to. SIG-161.

- **Sequential and flat, and that is the ticket's first two questions settled
  rather than deferred.** Concurrent tasks would put several lines in one live
  region, and the region model is one frame owned by one component: two spinners
  alive at once evict each other. Doing it properly means one tree of several
  rows driven by one clock, which is a different component from "a spinner per
  task". Subtasks are the same cost in another dimension. Neither has a caller.
  **Superseded by SIG-203**, which built exactly that component: see "Tasks side
  by side, and subtasks" below. The default is still one at a time.
- **`tasks()` was `createSpinner()` in a loop and had no drawing of its own.** The
  quiet axis, the pipe form (a line when a task starts and one when it settles)
  and the settled marks were the spinner's, so they could not disagree with it.
  SIG-203 replaced the loop with one frame of rows, and kept the agreement by
  drawing each row with `spinnerView()` and each settled line as `spinnerView()`
  rendered to a string, rather than by keeping the loop.
- **A skipped task settles as the spinner's `info`.** There is no fifth outcome
  and none was added: `ℹ title (skipped: reason)` says it is worth knowing
  without saying it went well or badly. `skip()` is a marker the task _returns_
  rather than an error it throws, because a skip is an ordinary outcome and a
  `catch` that did not know the difference would treat it as a failure. The
  string a task returns replaces the title on the done line only; a skip's line is
  always built from the title so the reason is not lost.

  **That holds when the task opened a log window too**, and did not at first: a
  window ended only as `success()` or `error()`, so a task that called `log()` and
  then returned `skip('cached')` settled on `✔ Build (skipped: cached)` -- a step
  that never ran, drawn as one that did, while the outcome in the results said
  `skip`. The window settles `info` internally and the pipe form calls the
  spinner's own `info()`. It is not on `TaskLog`: a caller who wants the
  informational ending has `skip()`, and a fourth public method is a second way to
  say it. `tasks()` hands the task a wrapper without it, so the extra method is
  not reachable at run time either. Found by review.

- **A thrown task fails its line, stops the list, and rethrows.** What the failure
  means is the caller's, which is `main()`'s rule too. The failed line is left on
  screen. A disabled task (`enabled: false`) is not run and leaves no line.
- **`taskLog()` is windowed only where there is a terminal to repaint, and the
  other form is a spinner.** A spinner's frame is the same text appended or
  repainted, so the canvas can decide. A window is not: appended, every change
  would write all of it again. So with no terminal (or a closed one) a log is a
  started spinner whose `write()` is the line and whose `succeed()`/`fail()` is
  the settled line -- title once, lines as they come, one settled line -- and
  quiet is the spinner's own, nothing at all. Reduced motion on a terminal still
  draws the window: it is content that changes, not motion, and the title carries
  no animation.
- **The window is a fixed number of rows shown or hidden, not rows added and
  removed.** The tree never changes shape and the window is one signal. A blank
  line is a row like any other. A line is cut with `text-overflow`
  rather than wrapped: a wrapped line is two rows of a fixed-height window.
- **What a message is, is cleaned before it is shown.** It comes from something
  else's terminal: escape sequences are stripped (a raw one in a cell is a
  corrupted frame), only what follows the last carriage return counts (a progress
  bar redrawing itself), and other control characters go.

  **A carriage return that ends the line is a CRLF's, not a redraw, and goes
  first.** `stream()` breaks on the line feed alone, so a line from a CRLF source
  -- Windows, a pty -- arrives ending in `\r`, and "keep what follows the last
  carriage return" then keeps nothing: every row blank, and `error()` dumping
  blanks, which loses the one thing a failure is owed. The tests that existed fed
  `message('one\ntwo\r\nthree')`, where the split on `\r?\n` removes the `\r`
  before the rule sees it, and a stream of `\n` alone, so neither reached it. One
  trailing `\r` is dropped first, in `toLines()` because both `message()` and
  `stream()` read through it -- and a break that falls between the two halves of
  the CRLF across chunks needs no handling of its own, since `pump()` joins them
  before it splits. Found by review.

- **Success collapses and failure writes the output below the title; it is not
  drawn into the window.** Both are the same frame (`✔`/`✖` title, window
  hidden, then `done()`), and a failure then writes every retained line with
  `terminal.write`. A canvas taller than the screen is clipped, where a written
  line scrolls, and "all of it" is the whole point of the failure case. It writes
  `\r\n`, because it bypasses the backend that does that for every other line.
- **Retention is bounded (1000 lines by default) and says so.** The feed is a
  subprocess, so unbounded retention is a leak with a build behind it. The newest
  are kept, since the end of a log is where the failure is, and a failure says
  that earlier output was dropped. It does not say how many: a count is a plural,
  and a plural key is a catalog entry for a line almost nobody will ever see.
- **Quiet silences the failure output too.** `error()` is progress, as
  `spinner.fail()` is, and the rethrown error is the caller's report. An app that
  wants a failing build's output under `--quiet` prints it itself.
- **`log()` on a task's context adopts the task's spinner rather than starting a
  second one.** Two regions cannot share the bottom of the screen, and the older
  would be left as a frozen frame. On a terminal the spinner is stopped (erased)
  and the window takes its place; in a pipe the spinner _is_ the log, so the title
  is not printed twice. `tasks()` settles an unsettled window itself, as success
  or (on a throw) failure; a window the task settled itself is left alone.
  **Since SIG-203 there is no spinner to adopt**: a task's window is rows of the
  list's one frame, under the task's own row, so the adopt path and the internal
  `info()` ending it needed are gone and `taskLog()` on its own is what it was.
  What it promised is unchanged and its tests are untouched.
- **Not done:** rollback, and a title that animates while a window is open.
  Concurrency, subtasks and retry are SIG-203's, below.

### Tasks side by side, and subtasks

`src/components/tasks.ts` again: `concurrency` and `failFast` on `tasks()`,
`context.tasks()` for subtasks, `retry` on a task, and `context.signal`. SIG-203.
The demo is `demos/components/43-concurrent-tasks.js`.

- **One live region holding a row per task, driven by one clock -- not a spinner
  per task.** A spinner per task is the problem SIG-161 avoided by running one at
  a time: each claims the region and evicts the last. So a run is one `For` over
  every task at every depth, built once per top-level `tasks()` call and shared by
  every `context.tasks()` under it, and one `setInterval` advances the frame of
  every row that is spinning. Each row is `spinnerView()` with a `SpinnerState`
  of its own, so a row cannot disagree with a lone spinner about what running and
  settled look like. The clock runs only while some row spins, which is what keeps
  a task whose window is open from waking the process, as SIG-161's window did.

  **The clock's effect reads a boolean, not a count.** It read the number of
  spinning rows at first, so every task that started beside the others re-ran the
  effect, which cleared the interval and made a new one: four tasks, four
  `setInterval` calls, and a cadence that reset on every start. The test that
  counts them is what found it. `State`'s equality is what makes the boolean work
  -- `true` set over `true` notifies nobody.

- **`concurrency` is a number: 1 by default, a positive integer, or `Infinity`.**
  Anything else is a `TypeError` thrown before anything is drawn, because `0` is a
  list that never starts -- a hang rather than a choice -- and a fraction has no
  reading worth guessing at. A bad `retry` is refused the same way, up front, so
  that a typo in the fifth task does not surface after four have run. Each list
  has its own: three parents at a concurrency of three, each running subtasks at
  three, is nine at once, which is the caller's arithmetic rather than a global
  limit this would have to invent.

- **A task that settles at the top leaves the frame and is written above it, so
  the frame holds only what is running.** That bounds it at the concurrency rather
  than at the length of the list, and a written line scrolls where a frame taller
  than the screen is clipped -- the `keep: false` reasoning from the multi-bar.
  The cost is that lines land in the order tasks _finished_ rather than the order
  they were listed, which was weighed against keeping list order and committing
  only a settled prefix. Completion order won because it is the order a pipe has
  to write them in, so a screen and a log tell one story; and because a prefix
  rule lets one slow first task hold every finished one in the frame. The results
  `tasks()` resolves with are in list order regardless. For a sequential list the
  two orders are the same, which is why every SIG-161 test passed unchanged.

  A task's settled line is `spinnerView()` rendered to a string with its outcome
  set and written with `mounted.write()`, styled -- not a plain string, which would
  have lost the colour on the mark. The frame is repainted without the task
  _before_ the write, so the frame the write puts back underneath is the one that
  no longer holds it. The indent is spaces in front of the string rather than a
  margin, because a string render starts at the root's own box and its margin has
  nothing to be a margin against -- measured: `  ✔ react` came out as `✔ react`.

- **When even the running rows do not fit, what is cheapest to lose goes first,
  and a cut is said.** The budget is the screen's height less the cursor's row.
  First to go are subtasks that have already settled, oldest first: a success is
  collapsed into its parent anyway and a failure is written out whole when the
  parent settles. Then window lines, which a failure writes out whole too. Only
  then are running rows cut, from the bottom, with `… 7 more running` in the last
  row. Queued tasks that have not started are never drawn: a row for each would
  make the frame as long as the list again, which is what the commit rule exists
  to avoid. Recomputed on a resize.

- **Failure is fail fast by default, and fail fast means waiting.** The first
  failure starts nothing new, aborts `context.signal` for every task still
  running, waits for them, and rethrows the first error -- SIG-161's rule
  generalised, and identical to it at a concurrency of one. Waiting is not
  optional: a promise cannot be cancelled from outside, so rejecting at once would
  leave the others writing into a region that had already been given back, and
  the screen has to be returned before the promise settles. A running task that
  ignores the signal ends however it ends and keeps that line.

  **A task that rejects with the abort settles as `ℹ title (cancelled)`**, which
  is the spinner's `info` again rather than a fifth outcome, for the reason a skip
  is: it did what it was told, and `✖` would report two failures where there was
  one. "Rejects with the abort" is the signal's own `reason` or anything named
  `AbortError`, since `fetch()`, `spawn()` and `node:timers/promises` reject with
  an `AbortError` of their own rather than with the reason.

  **`failFast: false` runs every task and rejects with an `AggregateError`**,
  holding each failure in list order -- always an `AggregateError`, so a caller's
  `catch` has one shape to read whether one task failed or five. Its message is
  the failure's own when there is one, so `main()` still prints something useful,
  and `{0} tasks failed` otherwise. Resolving with failed outcomes instead was
  refused: a caller who forgot to look would exit zero over a failed build.

  On screen, every task that started stays, as it ended; one that never started
  leaves no line, as SIG-161's did.

- **Piped, every line is written when it happens, and a line says whose it is
  wherever its position cannot.** Holding a task's lines until it settles would
  make a CI log tidy and a hang invisible, which is the wrong way round: the start
  line is how a log says what was running when the job was killed. So a task
  writes a line when it starts, when its text changes, for each line of its
  output, on each retry, and when it settles -- the multi-bar's precedent, where
  each bar's line is labelled because six of them interleave. A start or settle
  line already carries the title. An output line carries `title: ` in front of it,
  because a subprocess has no idea which task it is printing for. A subtask's
  lines carry its ancestors' titles (`✔ Installing: Fetched react`) and **drop the
  indent**, because under interleaving the line above may be anybody's and an
  indent would claim a parent the line does not have.

  Whether a task's lines can interleave is decided from the options -- its list's
  concurrency, or any ancestor's, capped by how many tasks there are -- and never
  from timing, so the same program writes the same shape every run. A sequential
  run labels nothing and indents subtasks under their parent, which is SIG-161's
  pipe form byte for byte.

- **Subtasks are `context.tasks()`, not a `subtasks` property.** The ordinary case
  is a list the task only knows once it has run -- the packages a resolve found --
  and a declarative list would be a second spelling that could only express the
  other case. Nested as deep as the calls go; each level is `INDENT` further in.
  While a parent runs, its subtasks are shown under it, the settled ones included,
  so the block reads as one thing. When it settles, the block is committed as one:
  a success as its single line, a failure as its line, its own window's output,
  and every subtask as it ended -- `taskLog()`'s rule (a success collapses, a
  failure keeps everything) applied one level up.

  **A parent's outcome follows its children's only through the rejection.** A
  failed subtask rejects `context.tasks()`, which fails the parent unless it
  catches -- and a parent that catches settles however it returns. No separate
  rule derives one from the other, because the one that exists already says it
  and a second would disagree with it the first time a parent caught. A skipped
  subtask does not skip its parent: the parent ran. A list aborted from outside
  before every task ran rejects with the signal's reason, so its parent ends as
  cancelled rather than as a success with half its subtasks missing.

  `TaskResultValue` accepts `TaskOutcome[]` so that a task which is only a group
  can be `({ tasks }) => tasks([...])` and type-check; it settles on the title, as
  returning nothing does.

- **`retry` is per task: a number of further attempts, or `{ tries, delay }`.**
  The row reads `title (retry 1 of 2)` while it tries again, and a pipe gets that
  as a line. Each attempt is handed a fresh context, and the failed attempt's
  window and subtasks are discarded, so a failure shows only the last attempt's
  output -- the one that is the failure. A late call from an earlier attempt that
  is still running is ignored. Not retried: a task that returned `skip()`, which
  is not a failure; a task cancelled by its list; and anything once the list has
  aborted, which also cuts a delay short. The errors of the attempts that were
  retried are not reported; the last one is what is rethrown.

- **Skip was already SIG-161's, and no declarative `skip` was added.** Listr2's
  `skip: () => boolean | string` is `task: () => cond ? skip(reason) : work()`
  spelled a second way. `enabled: false` stays the way to leave no line at all.

- **Quiet draws nothing and changes nothing else**: the tasks run, retries happen,
  and a failure still rejects. Under reduced motion the rows are drawn and no
  timer starts, as a lone spinner's are.

- **Not done:** rollback; a concurrency limit shared across nested lists; a row
  for queued tasks; a declarative `skip` or a function `enabled`; and reporting
  the errors of attempts that a retry recovered from.

### A multiselect with groups: `groupMultiselect()`

SIG-169. `src/components/group-multiselect.ts` is `multiselect()` over
`{ group: choices }`. It is its own module built on the exports at the bottom of
`prompt.ts` (`runPrompt()`, `listWindow()`, the head helpers), the way
`autocomplete()` is, and `multiselect()` and `select()` are untouched: a group
row is a third kind of row beside a choice and a separator, and teaching
`choiceRows()` and `paintChoices()` about it would put a branch for a feature one
prompt has into the two functions all of them share.

- **A group is a selectable row, which is Clack's answer and the default.** The
  ticket asked, and the reason is that "tick the whole area" is the point of
  grouping: a header that only labels is already `separator()`. `selectableGroups:
  false` is the other answer, and it makes the heading a heading in the
  separator's own style and with the separator's rule -- the cursor never lands on
  it -- rather than a second kind of row.
- **The answer is a flat array of values, in listed order.** Not keyed by group:
  a group is a way of picking and is not itself picked, `multiselect()` already
  answers a flat array so the two are interchangeable at a call site, and a caller
  that wants the grouping has the `choices` it passed in. Listed order rather than
  ticked order for the reason `multiselect()` gives. The same value under two
  groups is returned twice; a prompt that guessed it was one thing would be
  guessing about what the caller's values mean.
- **A group's box is derived, never stored.** `◯` none, `◐` some, `◉` all of the
  choices under it _that are on offer_, read off the ticked set on every draw. A
  stored flag is a second copy that ticking one choice by hand has to remember to
  update, and the first path that forgot would show a group `◉` over an unticked
  box. The partial glyph is local to the module and not on `PromptSymbols`:
  that object is frozen and exported, and nothing else draws it.
- **Space on a group ticks all, or clears all when all are ticked -- and a partial
  group ticks.** "All" and "none" are the only two outcomes of a toggle; partial
  has to go one way, and ticking is the way Clack, Inquirer and the select-all
  key in `multiselect()` all take.
- **A disabled choice is outside every group operation.** It is not ticked by its
  group's Space, it does not count towards "all", and `selected` does not tick
  it -- all `multiselect()`'s rule, applied to a group as to `a`. A group with
  nothing on offer is not on offer itself: drawn muted, skipped by the cursor.
- **`min` and `max` count choices and not groups.** A group is not in the
  answer, so counting it would make `max: 2` refuse a group of two. Checked on
  Enter and not while ticking, as `multiselect()` does.
- **No separators inside a group, and a group that is not a list is an error.** The
  groups are the headings; a `separator()` inside one has no meaning and is
  refused with a `PromptError` naming the question instead of being drawn.
  `choices` is a record rather than an array of `{ group, choices }` because that
  is the ticket's shape; the cost is that JavaScript orders integer-like keys
  first, which the README says.
- **Messages are `multiselect()`'s, so there are no new i18n keys.** The hint,
  `Choose at least ...`, `disabled` and `none` are the same strings through the
  same tag.

What is deliberately not done: nesting groups in groups; an `initial` row (the
cursor starts on the first row on offer); descriptions on a group; a group-level
`selected`; and a type that keys the answer by group.

### A sort prompt: pick a row up, carry it, put it down

SIG-173. `src/components/sort.ts` is `sort(opts): Promise<T[]>`, for an answer that
is a permutation rather than a choice. It is a list prompt in the shape
`autocomplete()` already is -- `runPrompt()`, rows rebuilt per draw for the
window, `listWindow()` -- with no field, because nothing is typed.

- **Grab and carry, not modifier-arrows, is the model.** Space picks the
  highlighted row up, Up and Down move _it_ (the highlight goes along), Space puts
  it down. The ticket asked which; a modifier chord is the one a terminal cannot
  be relied on for -- Shift-Up scrolls some emulators' scrollback and Alt-Up is
  eaten by some window managers -- while Space and the plain arrows reach every
  one. So the grab is the model and is what the key footer teaches (the hint line
  did, before SIG-205). Shift or Alt
  with an arrow is _also_ read as a one-place move without a grab, since the key
  decoder already carries the flags and the cost is one boolean; it is a shortcut
  and the documentation does not lean on it.
- **The answer is the values, in order, not indices.** The ticket's other
  question. Indices make the caller index back into a list they just passed in, and
  a `Choice` without a `value` answers with its label as everywhere else
  (`promptValue()`). A caller that wants indices passes `value: index`.
- **Enter answers whether or not a row is in hand.** A row mid-carry stays where
  it was carried to. The alternative -- Enter drops, a second Enter answers --
  makes the commonest gesture (move one thing, confirm) a key longer for the sake
  of a state nobody is confused by: the key footer changes while a row is held.
- **A carried row never wraps; the highlight does (`loop`).** Carrying the first
  row past the top and landing it last is a rotation, not a step, and a stray key
  would do it with no way to see what happened. Home and End are how a row goes to
  an end on purpose.
- **A `disabled` choice is pinned, not left out.** `autocomplete()` leaves one out
  because it has a filtered list to leave it out of; here the answer is a
  permutation, and dropping a row from a permutation is a different claim than
  holding one still. A pinned row keeps its index, the highlight steps over it,
  it cannot be picked up, and it is in the answer where it was. Implemented by
  lifting the choices out of the movable places (`slots`, the indices of the rows
  that are not pinned), reordering _them_, and putting them back, so a carried row
  jumping a pinned one is the same operation as moving one place. A list with no
  movable row is refused as an empty one is. The reason shows where a hint would,
  as in `select()`.
- **Separators are not accepted.** The ticket says `Choice[]`, and a heading in a
  list being reordered would have to say which side of a move it belongs to.
- **Rows are numbered**, padded to the widest place, because the point of the
  prompt is the position: "which is third" should not need counting.
- **The head reserves room for the longer of its two hints.** The grab hint and
  the drop hint are different lengths and swapping one for the other must not make
  the head taller than `room()` believed, which would push the last row off the
  screen -- the failure `headWidths()` documents for the multiselect hint.

What is deliberately not done: an Escape that puts a carried row back where it
was picked up (Escape does nothing in any prompt here), a `validate`, and a
`min`/`max` -- there is no count to constrain in a permutation.

### Aborting a prompt: `signal`

SIG-176. `PromptOptions.signal` and the few lines in `run()` in `prompt.ts` that read
it; every prompt goes through `run()`, so every prompt has it and no prompt was edited.

- **An abort rejects with the signal's own `reason`, not a `PromptError`.** The
  ticket asked which. `AbortSignal.timeout()` rejects with a `TimeoutError` and
  `abort()` with an `AbortError`, and `fetch`, `setTimeout` from `timers/promises`
  and `events.once` all hand those back, so a caller already knows how to tell a
  timeout from an abort and a recipe needs no new vocabulary. It is also the
  honest answer to `isCancel()`: a cancel is a person pressing Ctrl-C, an abort is
  the program deciding, and a `PromptError` with `aborted: true` would make
  `group()` call `onCancel` for a timeout. A non-`PromptError` is rethrown by
  `group()` untouched, which is the rule for everything that is not a cancel.
- **`timeout` is not an option.** `signal: AbortSignal.timeout(ms)` is the whole of
  it, a default is a `catch` on the name, and an option would be a second spelling
  that needs its own reason type. Documented as a recipe in the README.
- **Abort is `fail()`, so it is a cancel's teardown by construction.** The listener
  calls the same function Ctrl-C does: input detached, the router stopped only if
  this prompt built it, the region cleared and the cursor handed back. A router the
  app passed in is left running. `prompt-signal.test.ts` asserts the screen, raw
  mode and cursor against a real cancel's rather than against a list of things to
  restore, for every prompt.
- **The listener goes on last and comes off in `detach()`.** `fail()` is only a
  complete teardown once there is a screen and a router, so the listener is added
  after both exist; the signal is checked before anything is mounted, which is
  what makes an already-aborted signal draw nothing. It sits after the
  nobody-is-there check, so a prompt with no terminal still says that rather than
  the signal's reason. It is removed when the prompt ends either way, so a signal
  that outlives many prompts does not accumulate listeners.
- **Not done.** `group()` takes no signal of its own: pass the same one to each
  step. A signal that aborts between two steps is seen by the next prompt as
  already aborted, which is the behaviour wanted.

### `log.stream`: log lines fed from an async iterable

SIG-179. `src/components/log-stream.ts` is the wrapper and `createLog()` in
`log.ts` owns the six `stream` methods. Neither `typewriter` nor the terminal
changed.

- **It is a feature of `log`, not of `typewriter`.** `typewriter` reveals a string
  it already has, on a clock, as an element tree that repaints; a stream is a
  source whose text is not there yet and has no pace of its own -- it writes what
  arrived, when it arrived. The output is status lines (stderr, the glyph, quiet,
  above a live region), which is `log`'s, so it is `log.stream.<level>()`, the shape
  Clack has. A `typewriter` that takes an async source is a separate thing.
- **Lines are written whole, once final, and never as a partial row.** A line that
  is still growing cannot be written in place under a live region: `writeStatus()`
  asks the holder to erase, write and repaint, and a row left half-written would
  have the region repainted onto its end. So the unit of output is a finished,
  wrapped line, through the same `writeStatus()` as `log.info()` -- no new terminal
  seam. The cost is that a line appears when it is full and not word by word; the
  alternative needs the terminal to know about a cursor parked mid-row.
- **Wrapping calls `wrap()`.** `createStreamWrapper()` re-wraps the line being
  built on every chunk and returns the lines that cannot change: `wrap()` is
  greedy, so every line but the last is final however much follows. A second
  wrapper whose idea of a break could drift from the first's was the thing to
  avoid, and the price is a re-wrap per chunk of one line (a paragraph, since a
  newline in the text ends it). `test/components/log-stream.test.ts` asserts the
  joined output equals `wrap(whole text)` for chunk sizes from 1 up, plain and
  styled.
- **What is held back is exactly what could change.** Everything after the last
  space (a word that may be growing) and a trailing escape sequence the matcher
  cannot yet match (`ESC[3`). The state of the SGR carries across a finished line
  by walking its sequences, and each wrapped line is opened from it.
- **A stream keeps the SGR it is given, and `log.info()` does not.** The element
  tree strips control characters from a text, so a styled message passed to
  `log.info()` loses its `ESC` and draws `[31m` literally -- pre-existing, and left
  alone here. A stream whose point is wrapping across a sequence would be empty of
  meaning if it stripped them, so it writes its lines directly, with the glyph
  drawn through the theme like any other and the text as it came. At colour level
  `0` the lines are stripped, the rule `log` keeps for a file.
- **A quiet stream is drained.** The producer (a model, a pipe) is waiting to be
  read; not reading is not the same as it having nothing to say. `warn` and
  `error` are never quiet, as for the plain methods.
- **A source that throws still has its text written first**, then the promise
  rejects with the same error: half an answer that was shown should be shown whole.
- **Bytes are decoded with a streaming `TextDecoder`**, so a multi-byte character
  cut between two `Uint8Array` chunks comes out whole. A bare string is one chunk.
- **`createStreamWrapper` is exported from the barrel** because the ejected
  `registry/log.ts` rewrites its sibling imports to `@ttylabs/sigil/components`.
- **Only text and SGR reach the terminal.** The source is a subprocess or a model,
  and a terminal obeys what it is handed: a bare `\r` (git, npm and curl draw
  progress with one) returns the cursor, `ESC[2J` clears the screen, OSC 52 writes
  to the clipboard, and any cursor move breaks the erase-and-repaint
  `writeStatus()` does under a spinner. `log.info()` is safe because its element
  tree strips control characters; this path writes strings, so `clean()` in
  `log-stream.ts` does it: every sequence but an SGR goes, and every control
  character but a tab. It runs on the line, never on a chunk (a chunk may end inside
  a sequence), and **before** the wrapper measures, so a dropped sequence or a
  progress frame costs no columns. A bare `\r` is dropped, not honoured as "keep the
  text after it": `10%\r50%` is `10%50%`, which is what `log.info()` gives and is
  never a lie about what the source sent. Found by review of SIG-179.
- **A break is a blank that is text, never one inside a sequence.** `settledAt()`
  walks the tokens, so the space in a window title (`ESC]0;build step one BEL`) or
  in `ESC[2 q` cannot be where a chunk is cut. A review round reported this as
  junk written and real words lost; **that does not reproduce**, and it is worth
  saying so: the sequence matcher takes an unterminated string payload or CSI to
  the end of the text, so `clean()` already dropped a cut sequence whole, and a
  fuzz of 20,000 random chunkings over an alphabet of `ESC`, brackets, spaces and
  terminators found no input where chunked and whole-text output differ, with the
  raw `lastIndexOf(' ')` search or without it. So the walk is a declared survivor,
  not a fix with a test that fails without it: it stops the break depending on the
  matcher's leniency, and its two tests pin the behaviour rather than discriminate.

**Deliberately not done:** writing a partial row (above); an `AbortSignal`;
timestamps and structured fields (a separate ticket); a pace or a cap on how fast
lines are written; a `typewriter` that accepts an async source; making plain
`log.info()` keep SGR.

### A select-by-key prompt: `selectKey()`, numbered, and expanded

SIG-170. `src/components/select-key.ts` is one prompt for what Clack calls
`selectKey` and Inquirer calls `rawlist` and `expand`. `select()` is untouched.

- **One prompt with two options, rather than three functions.** The three differ
  in what is drawn and not in how a key is read: every one of them answers when a
  choice's key is pressed. `numbered` is where the keys come from (the position,
  for a choice that gave none) and `expand` is whether the list is drawn up front
  or after `h`. Three entry points would be three copies of the collision rules,
  and a caller could not ask for a numbered list that expands.
- **A key is one code point, and case does not tell two apart.** `y` and `Y` are
  one key, which is how `confirm()` has always read them, and matching is
  `toLowerCase()` rather than the locale's for `camelCase()`'s reason (Turkish
  `I`). A case-sensitive prompt would let `a` and `A` mean different things in a
  list whose hint shows one of them as a capital, and the capital is already
  spoken for: it marks the key Enter takes. **One code point, not one grapheme**:
  the decoder reads a flag in two pieces as two keys, so a key declared that way
  could never be pressed, and it is refused with the rest rather than accepted
  and unreachable. Whitespace and control characters are refused as keys Enter,
  Tab and Space already are.
- **A bad list is refused where the prompt is asked.** A `PromptError` that names
  the choices -- two with one key, a key that is not one character, no key without
  `numbered`, a tenth unkeyed numbered choice, an `initial` that is not on offer --
  as `number()` refuses a bad `step`. "First wins" was the other answer and it
  hides a choice nobody can reach until somebody presses its key. The check
  includes a **disabled** choice's key: it is not pressable, but enabling it
  later must not turn a working list into a refused one.
- **Numbers are positions among the choices, headings not counted and disabled
  choices counted.** A number that moved when something was disabled would make
  `3` mean a different thing on the same screen from one run to the next. Only
  nine fit in a digit, so the tenth unkeyed choice is refused and says so; a key
  of its own is the way out, and an explicit key that equals another choice's
  number is an ordinary collision.
- **`h` and `?` are kept only with `expand`.** Both are help, `?` being what a
  reader tries and `h` being what Inquirer shows. A choice may not use either
  while `expand` is set, and may use both when it is not. The `expand` line is
  `(y/n/a/d/h)`: only keys that work are in it, so a disabled choice's key is
  left out, and the key Enter takes is the capital, as in `(Y/n)`. Once the list is
  drawn the line goes -- it would be the same keys twice. **Every other key is
  printed folded to lower case**, however the caller wrote it: a capital means
  "Enter takes this" and nothing else, so `{ key: 'Y' }` with no `initial` is
  `(y/n/h)` rather than a line that names a default Enter does not honour. The
  list drawn by `h` shows keys as written, since it carries no such meaning.
- **There is no cursor, so Enter takes `initial` or nothing.** `initial` is a key
  and not an index, because the list is addressed by key everywhere else; a
  highlighted row that arrows moved would be a second way to answer that the hint
  does not name. Without `initial` Enter does nothing. The pointer column is on
  every row either way, hidden where it does not point, so the labels sit where
  `select()`'s do.
- **A disabled choice's key does nothing.** It is not in the lookup, so there is
  no case for it: the row shows the reason, or `disabled` through `__`, which is
  the string `select()` already carries.
- **`description` and `selected` are off the type.** There is no highlighted
  choice to describe and nothing to tick, and a property the prompt reads nowhere
  is one the type should not name. `KeyChoice` is `Choice` without them plus
  `key`.
- **i18n adds no catalog key.** The only text the prompt draws that is not the
  caller's is `disabled`, which is already a key; the refusals are plain English
  like `number()`'s. What is **not** translatable is `h`: `confirm()`'s keys come
  out of a catalog entry (`confirmKeys()`), and a help key would need the same
  mechanism and the same rule about what English is still accepted, for one key.
  Left for whoever translates the prompts' keys further.

What is deliberately not done:

- **A list taller than the screen.** The canvas clips it, and a key in the clipped
  part still answers. This prompt is for a list short enough to hold in the head;
  `select()` windows because it is for the other kind, and a window here would be
  a cursor by another name.
- **Multi-key choices and a key that is a modified key.** `ctrl-d` is not one
  character, and a modifier makes it a different key, as it does everywhere else.
- **A case-sensitive mode.** If an app wants `a` and `A` apart it can say so
  with a flag; nothing here needed it.

### Charts: a sparkline, bars, a braille line chart and a gauge

SIG-186. `src/components/chart.ts` is the whole of it: four functions from numbers
to a string, each with a `*View()` returning `{ element, width }`, and the split is
`note()` and `noteView()`'s. Nothing in `src/canvas/` or `src/style/` changed.

- **Sparkline and bars first, the axis-labelled line chart second, was the ticket's
  first question, and all four shipped together.** They share a scale, a drawing
  type and a printer, so a second ticket would have been a second review of one
  file. The line chart is the only one that needs the sub-cell grid, and it uses
  `Dots` (`canvas/subcell.ts`) directly rather than a `Painter`: a chart is a
  string, and `charAt()` is the whole of the read it needs.
- **Scaling is automatic from the shown values and explicit when `min` and `max`
  are given.** Only a bound the caller left out is read off the data. A caller
  drawing several charts that must mean the same height passes both, and that is
  the documented reason to. Two bounds given the wrong way round throw a
  `RangeError`; one bound given against data that lies on the wrong side of it is
  flattened onto it, not inverted. Bars are the exception to "bottom is the least
  value": they grow from zero, or from the lowest value where some are negative,
  because a bar is a length and `min` defaults to `Math.min(0, ...values)`.
- **`gauge` is not `progress`, and shares only the bar arithmetic.** `progress()` is
  live, moves, and falls back to a percentage on a pipe; a gauge is a reading
  printed once and can be coloured by how bad the reading is. It calls
  `renderBar()` once per half -- the filled character with an empty `empty`, and
  the reverse -- so the cell count and the rounding are the progress bar's and the
  two halves can take different roles without a second copy of the maths.
- **A value that is not a finite number is a gap, never the lowest mark.** In a
  sparkline it is a space, in a line chart it breaks the line instead of being
  bridged, and in a bar chart it is a dash with no bar. Zero and nothing are
  different answers and a trend should not blur them. A series with no extent
  (every value equal) is drawn **in the middle** rather than at the bottom, so a
  flat line is not mistaken for no data.
- **...except a bar, where no extent means nothing to draw.** A sparkline and a
  line chart plot a position, and a flat series at the bottom reads as no data. A
  bar is a length from a baseline, and `min` defaults to `Math.min(0, ...values)`,
  so with every value zero the scale has no extent and `ratioOf()`'s mid-scale
  answer drew **half a bar for each zero** -- activity on a chart of an idle
  period, against the rule above it that a zero draws nothing. `barRatioOf()` is
  `ratioOf()` with that one case answered `0`, used by both bar directions and by
  neither of the others. Found by review, and the existing zero test missed it
  because it had a non-zero value beside the zero, which gives the scale an extent;
  the new tests are all-zero data in each direction and both fail without it. The
  gauge is not affected: it refuses a range with no extent where it is built.
- **A value above the bottom of the scale is at least an eighth of a cell.**
  Rounding a small value to nothing draws it as zero, which is a different
  statement. This is the one place a bar is not rounded to the nearest eighth.
- **A sparkline wider than its room keeps the latest values and scales over the
  ones it shows.** It is a trend and the end of it is the news. Scaling over cut
  values would flatten what is left against a spike nobody can see.
- **Padding is given the width it stands for.** A `text` drops the whitespace at
  the end of its last line, so a segment that is a label's trailing space, a gap
  between columns or an empty stretch of a bar vanished and the columns ran
  together (`buildtestlint`). Every segment has `width: stringWidth(text)` and
  `white-space: pre` for that reason; `chart.test.ts` pins the columns line up.
  Of the two, the width was the one doing the work: `pre` was read as `normal`
  until SIG-207 and dropped the same trailing space. It keeps it now, so the
  two say the same thing and neither was taken out. See `white-space` in [`src/element/AGENTS.md`](../element/AGENTS.md).
- **Colour is a role on the data and nothing on the labels.** `role` is `accent` by
  default, the same role a progress bar's bar takes, and `none` leaves the
  terminal's foreground. A gauge's empty part is `.sigil-muted`, and its bar
  changes to `warn` and `error` at the thresholds the caller names -- there are
  no default thresholds, because what is bad is the app's to say.
- **ASCII follows `unicodeSupported()` from `note.ts`, and is not a second
  heuristic.** Block elements and braille are no safer than box drawing, and a
  caller can say `ascii: true` outright. The line chart keeps its sub-cell grid
  and prints `*` for any cell with a dot in it, so the line is still connected.
- **Several are not done on purpose:** negative bars below a zero baseline. The
  other three this list held -- more than one series in a line chart, axis ticks
  between the top and the bottom label, and a live form -- are SIG-284's, the entry
  below, and the system monitor was the first user that drove them.

### Live charts: fed from signals, sized by the layout (SIG-284)

`Sparkline`, `LineChart`, `BarChart` and `Gauge` in `src/components/chart.ts`, beside
the printed charts, and `Series`, a ring buffer that is a signal. The ticket's five
questions were settled as below. The sabotage runs are in
[docs/history/live-charts-fed-from-signals-sized-by-the-layout.md](../../../../docs/history/live-charts-fed-from-signals-sized-by-the-layout.md).

- **Data: anything with a `get()`, a function, or the values -- and `Series` for
  the case a tick pushes a sample.** The ticket offered `State<readonly number[]>`
  or a ring buffer, and it is both, because they answer different callers. A chart
  reads its source inside an effect, so a `State`, a `Computed`, a function over
  them, and a `Series` all redraw it, and a monitor whose history is derived from a
  `State` of snapshots needs no second copy of it. What a `State` of an array costs
  is a new array a tick and the app writing the slice; `Series(capacity)` writes
  into a ring and moves its start, so a push allocates nothing and the oldest falls
  off. Its `get()` is built once per change and frozen, so ten charts reading one
  series build it once, and a version `State` inside it is what subscribes them.
  `at(-1)` is the latest, which is what a figure beside a sparkline reads. It lives
  in `chart.ts` rather than in `src/signals`, because it is the one shape a chart
  is fed and nothing else in the library wants a ring of numbers.
- **Size: from the layout, through `onResize`, and what a chart asks for is never
  what it last drew.** The host is a box holding a `raw` that measures the size
  the chart asks for -- `width` and `height`, or a default from its data -- and
  paints nothing, with both minimums zero, and an absolutely placed body the rows
  are drawn into. The rows take no space, so the size is the layout's: stretched
  across a column, given what a row leaves with `flex: 1`, as tall as a panel with
  `flex-grow`. Rows in flow were the obvious build and are SIG-318 again: the chart
  would ask for the size it was last drawn at, so a row that squeezed it once would
  keep it squeezed. `should grow back to what it asks for once a row that squeezed
  it has room again` is the test, and a sabotage that measures the drawn size fails
  it and nothing else. A `raw` that painted the chart itself was the other way to
  get the size, and was refused for colour: a `raw` paints styles it resolves
  itself, which is right for a photograph and wrong for a series whose colour is a
  theme role -- a role is a class, and a class reaches a `text`.

  Where the layout leaves the size to the chart, it asks: a `Sparkline` for a column
  a sample of its `Series`' capacity, or of the samples there are; a `LineChart` for
  40 columns and 8 plot rows plus its axis, x labels and legend; a horizontal
  `BarChart` for 40 by a row a bar, a vertical one for its bars' own width and 8
  rows plus its two label rows; a `Gauge` for a bar of 20 and its label and figure.
  An ask that moves with the data -- a sparkline over an array that grows, bars
  added -- re-measures the `raw`. **No growing by default, so no framework-sheet
  rule**: a chart in a column already spans it, `flex: 1` is one prop, and a
  default `flex-grow` would be the sixteenth declared exception to the role rule for
  something the panel's fifteenth already shows the cost of.

- **What a chart has: axes with ticks, a legend, several series in one chart, a role
  per series, and a scale fixed or following what is shown.** The axis names a
  value every four rows or so on a plot tall enough -- `tickRows()` -- so a printed
  chart of the default eight rows is the picture it always was, and a panel thirty
  rows tall has seven labels. Each label is the value at its own row, so a plot of
  ten rows labels `44%` rather than a rounder number half a row away. Several series
  are the line chart's alone: a sparkline's block has one foreground, and grouped
  bars are a different chart. A bar takes a `role` of its own, which is the one
  "series" a bar chart has.

  **Who wins a shared braille cell: both lines' dots, in the colour of the series
  listed later.** The rule the earlier entry left for the first user. Each series is
  drawn into its own `Dots` and into one they share; the shared grid is the
  character, so where two lines cross both are still there, and the colour is the
  last series with a dot in that cell -- paint order, which is the order a reader
  can predict from the call. Most-dots-wins was the alternative and was refused: it
  makes the colour of a crossing depend on the slopes. `should draw both lines
  through a cell they share, in the colour of the later one` pins both halves.

  **A colour per series is a role, and no role was added.** A series names one of
  the six `ChartRole`s; one that names none takes the chart's `role` if it is the
  first and `warn`, `success`, `info`, `error` after that -- the colour roles in an
  order that keeps neighbours apart in the framework's sheet, red last. That is
  semantic roles standing in for a palette, which is a compromise: a `series-2`
  role would be a ninth role and a `palette` question for every theme in
  `src/theme`. What makes it bearable is the hook: every cell of series N carries
  `.sigil-chart-series-N`, which a theme or an app restyles at a later origin than
  the role's, so a dashboard that wants six blues writes six rules. The legend's
  mark carries the same classes as the line, so the two cannot disagree. The
  vocabulary comment names the series, legend, body and sizer classes; no rule was
  added to the sheet.

  The scale follows the data unless `min` and `max` say otherwise, and for a live
  line chart "the data" is the window: what scrolled off the left is not scaled
  over, which is the sparkline's rule from the entry above. The gutter is as wide
  as the labels and the labels are the scale's, so `lineDrawing()` asks until the
  gutter settles -- at once, unless a label gains a digit.

- **Resolution is per chart, and not an option.** A sparkline is eighths of a
  block, a line chart braille, bars eighths across or up, a gauge a block bar. A
  braille sparkline is a `LineChart` with `axis: false`, and a block line chart is a
  `Sparkline` more than one row tall -- which it now is: the live sparkline stacks
  its eighths into an area as tall as its box, `rows * 8` heights, the block graph
  btop draws, and on one row it is the eight heights it always was. So the choice
  the ticket asked about is already the choice between two components, and an
  option on each would be two ways to say it.
- **The printed views stay, and both forms draw with one function per chart.**
  `sparkline()`, `lineChart()`, `barChart()`, `gauge()` and their `*View()`s keep
  their signatures and their pictures -- every test in `chart.test.ts` passes
  unchanged -- and the live charts call the same `sparkRows()`, `lineDrawing()`,
  `barDrawing()` and `gaugeDrawing()` at the size `onResize` reported. Moving the
  views onto the components was refused: a printed chart has no layout to ask, and
  `renderToString()` laying out a host, measuring a `raw` and dispatching a resize
  to print one line is a lot of machinery for a string. Two things widened the
  views additively: `lineChart()` takes several series as `[{ data, label, role }]`
  and a `legend`, and `step`. `step` is the one default that differs between the
  two forms -- `fit` printed, `1` live -- because a printed chart is a whole series
  and a live one is a window onto one; `should be the picture lineChart() prints at
  the same size with step fit` pins that the two are otherwise one drawing.
- **A live line chart scrolls from the right.** The latest sample is at the right
  edge and each one before it a dot column further left, so 40 columns hold the
  last 80 samples and the line moves left as it is pushed to; one sample past the
  left edge is still drawn to, so the line enters from the edge. Stretching a
  growing series across the width, as `fit` does, would squash the whole history
  every tick. A live sparkline is the same rule a column a sample, with the left
  blank until history fills it; a printed one is as wide as its series.
- **A gauge pads its percentage to four columns.** Live, a reading going from 9% to
  10% moved the bar a cell. A `detail` the app writes is its own width, and is the
  app's to pad.
- **A row that did not change is left alone.** The host keeps each row's segments
  and their classes as a signature and rebuilds only a row whose signature moved,
  so a tick that scrolls the plot leaves the axis, the x labels and the legend as
  they were. Simpler than diffing segments, and a chart's rows are few.
- **The new messages are plain, not `__`.** They are programmer errors -- a
  capacity, a step, a size that is not a whole number -- of the kind `chart.ts`
  already threw as plain `RangeError`s, and the key set in `src/i18n/keys.ts` is a
  generated file every parallel branch adding a key would conflict on.
- **Not done:** grouped or stacked bars; a sparkline or bars with several series; a
  time axis that labels more than its two ends; `selectable: false` on a live
  chart's body, which the printed tree does not set either; and a mouse readout of
  the value under the pointer, which is a tooltip's job and wants the samples'
  positions, which a drawing does not keep.

### An image: a picture fitted to the box it got, in half blocks (SIG-326)

`src/components/image.ts` is `imageView()` and the `image()` facade over it.
`Pixels` already drew 1x2 pixels per cell and a caller had no way to get a
picture into it but working out every pixel; this fits one. The box filter is
`resampleImage()` in `src/canvas`, and what it did to the style table is recorded
there under "An image over `Pixels`".

- **A `raw`, sized by layout and resampled to what it was given.** It _asks_ for
  one column per pixel across and a row per two pixels down, or for the room it
  was offered at the picture's proportions where that is less; `width` and
  `height` ask for a size instead, and either alone gives the other from the
  proportions. What it _draws_ at is the box it ended up in, whatever a sheet, a
  flex row or a `width: 50%` made of the request. Both minimums are zero, because
  a picture is drawn at a size rather than having one -- unlike a word, it has
  nothing to protect from a squeeze.
- **A width asked for is a `max-width`, and `measure()` answers the width it is
  handed rather than the one it asked for.** Both were the other way round in
  the first version, and review round 1 found what that cost. The layout asks a
  measuring node at the width it will have -- a `max-width`, padding and border
  already taken off -- and answering the request regardless reserved the rows of
  a 40-column picture for one drawn at 10, left as bands round a letterbox. And a
  declared `width` is what the layout measures a node at however narrow a row
  then flexes it, so a 40-column request squeezed to 17 kept the height of 40.
  As a ceiling the request is still the size where there is room, and a column's
  stretch stops at it rather than widening the picture. A `height` stays a
  `height`, because "fit this many rows" is what it says; a height alone also
  sets the `max-width` its proportions give. `should be as tall as the width it
  got` fails for each half put back on its own.
- **A size asked for in code beats a stylesheet's `max-width`, because it is a
  prop.** Review round 2 found the cost of the move above: a sheet's
  `.sigil-image { max-width: 10 }` used to clamp a requested `width: 40` (min
  and max apply over a width) and stopped doing so the moment the request became
  a `max-width` prop, since a prop replaces a sheet's value for its property.
  Kept, because a prop is this element's inline style and that is the rule
  everywhere here -- a colour a component writes as a prop is one a theme cannot
  reach either -- and `!important` is the escape the cascade keeps for exactly
  this (`applyPropsInto()` skips a locked property). The alternatives were
  worse: a declared `width` is the shrink bug back, and `align-self:
  flex-start` to stop a column's stretch overrides a parent's `center`. A
  sheet's `width` is a different property and still applies, under the request.
  `should keep a size asked for in code over a sheet, as any prop is` pins all
  three.
- **`image()` caps at the terminal only where no size was named.** Round 2
  again: once a height alone became a `max-width` rather than a `width`, the
  facade's render width -- the terminal's, where less than the picture's -- was
  the room the root was laid out in, so a 40-row request on an 8-column terminal
  came out 8 columns of letterbox. A height names a width as surely as a width
  does, so it is laid out at its proportions, terminal or not.
- **In a row it is as tall as its width makes it, and that is the layout's rule
  rather than this component's.** A row stretches a measuring item to the larger
  of the room and its own height, which `src/layout` records for a text whose
  rows past the bottom would otherwise be lost. So a picture whose width gives it
  54 rows in a row 24 tall overflows and is clipped, where a column shrinks it to
  fit. Not special-cased: a `raw` that measured differently in a row from a column
  would be a second layout rule living in a component. `height`, or a column, is
  how to say "fit this many rows".
- **PNG bytes or RGBA, told apart by shape.** A PNG is a byte array and RGBA is
  an object holding one, so `imageView(readFileSync('logo.png'))` and
  `imageView(decodePng(bytes))` are the same picture and there is no flag to get
  wrong. Raw RGBA is first-class because it is the way in for every other
  format: a caller with a JPEG brings a decoder. Either is decoded or checked
  when the view is **built**, so a bad file throws where the caller can catch it
  rather than from inside a frame. Taking bytes puts `@ttylabs/sigil/png` on the
  components entry, which measured 10,323 B of the 15,344 this change added to
  it, and `node:zlib` with it, which an unbundled app importing any component
  paid. Taken, because the alternative is every caller writing the `decodePng()`
  the ticket asked this to do for them, and a component barrel that is 472 KB is
  not where 10 KB is decided; the lever on that number is still SIG-81's.
  SIG-328 took the zlib half back -- the codec asks for it when it decodes, so
  importing the barrel no longer loads it -- and kept the bytes, because decoding
  later would move a bad file's error into a frame or make this asynchronous.
  The measurements are under "What each entry loads at import" in
  `src/testing/AGENTS.md`.
- **`fit` is `contain`, `cover` or `fill`.** The three `object-fit` values that
  mean something without a natural size to fall back on. `contain` is the default
  and may sit half a row down, since `Pixels` has a colour per half; `cover` crops
  centred, through `resampleImage()`'s fractional source rectangle; `fill`
  stretches.
- **The resample is done once per box size, the rest once per frame.** A frame
  repaints every cell, and a box filter over a photograph sixty times a second
  for the same answer is the cost this keeps out of it. The composition over the
  background is per frame, because the background is the grid's and can change
  under a picture that did not; so is the depth, which can be refined by what the
  terminal said. A cell outside the clip is neither composed nor matched.
- **Alpha is mixed with what is under the pixel, and over the terminal's own it
  is drawn or not at half.** `painter.backgroundAt()` is the cell's background,
  read at paint time, so a picture over a sibling or an absolutely placed panel
  mixes with that rather than with an ancestor's colour nobody can see there --
  pinned by a picture laid over two differently coloured cells. `DEFAULT_COLOR`
  is the absence of a colour, and the terminal is not asked for its own, so there
  is nothing to mix with: more than half covered is the pixel and less is the
  terminal showing through, which is the canvas's rule that nothing invents a
  colour. A wholly transparent pixel paints nothing at all rather than the
  background's colour, so `Pixels` skips the cell and a half block's empty half
  keeps whatever is already there. Per-cell alpha that survives a composite is
  SIG-103's, and is not needed for this.
- **The depth is the tree's, read off the element.** A `raw` paints colours
  nobody declared, so it degrades them itself -- and to the depth the rest of the
  frame was resolved at, which is `Element.colorLevel` (recorded in
  `src/element`). An `opts.colorLevel` defaulting to `ansi.level`, which every
  string facade here takes, would be a second answer inside a running app whose
  level was refined from what the terminal said: the frame at 256 colours and the
  picture in truecolor, on exactly the terminals degradation exists for. The
  facade takes one because it builds the tree and so is the one place that says.
- **`quantizeColor()`, not `degradeColor()`.** The degrader's memo is never
  evicted, on the argument that what reaches it is declared colour and an app
  has a few dozen. A photograph is a few thousand colours nobody declared, a
  different few thousand at each size it is drawn at -- so this asks the
  unmemoized half of the same function and keeps its own map, dropped when the
  size or the depth moves and bounded at four entries a pixel besides -- asked
  before a frame adds its own, so the limit it checks is three -- for a
  background animating under a part-transparent picture.
- **At level 0 it draws nothing, keeps its box, and the facade is `''`.** A
  picture with its colour taken away is not a picture, and `NO_COLOR` and a pipe
  both asked for no escape sequences. The box stays reserved inside a tree,
  because a layout that moves when colour goes away is a layout that depends on
  colour. The string facade has no layout to keep the shape of, and a column of
  blank lines the picture's height is a strange thing to write into a log, so it
  returns the empty string.
- **Settled: `renderToString()` supports an image, and it fell out.** It shares
  the painter, the element carries its depth through the same walk, and
  `image()` is that path with a size picked. What is defined is the rule above
  for level 0 and the depth asked for at every other level, and both are tested
  -- the facade's output to the byte at level 3.
- **Settled: no braille mode.** `Dots` is 2x4 and monochrome, the tier that works
  literally everywhere, and it does not make a picture without three decisions
  none of which has one right answer. _Which dots are lit_: a lit dot is the
  foreground, so on a dark terminal bright pixels light and on a light one dark
  ones do, and the scheme is a guess (`colorScheme` is one, and qrcode carries a
  whole entry about getting it wrong). _Threshold or dither_: line art wants a
  threshold and a photograph wants error diffusion, so it is two modes rather than
  one. _What colour_: one foreground for up to eight pixels is an average that
  belongs to none of them. And the QR entry above already measured that braille
  does not **tile** -- the dots have gaps about their own width, so a solid region
  is a texture. The case it was asked for, "level-0-ish terminals", is the case
  this draws nothing for on purpose: a pipe and `NO_COLOR` want no picture, not a
  monochrome one. A caller with line art and an opinion about polarity has `Dots`,
  public since it was written, and a threshold over `resampleImage()`'s output at
  `columns * 2` by `rows * 4` is a loop.
- **No ASCII form, as with the QR code.** The three glyphs are `▀ ▄ █`, which
  are in CP437 and every console font, and there is no ASCII picture worth
  drawing. `unicodeSupported()` is not consulted.
- **Not selectable, by the default a `raw` already has.** `RawOptions.drawsText`
  records the case it was written for -- "a sparkline and a half-block image: a
  wall of block characters nobody wants in their clipboard" -- and this is the
  second of those.
- **Not done.** Animation (a GIF is a decoder and a clock, and the clock is the
  app's), alt text (a picture with nothing drawn has nothing to say on its behalf
  that the app does not know better), passthrough protocols (refused in
  `src/canvas`), and `object-position`.

### Progress: several bars at once, and an ETA

`src/components/progress.ts` gained a rate estimator and `src/components/multi-progress.ts`
is the group. SIG-184.

- **The audit: `createProgress()` computed no ETA and no rate.** It drew a label,
  a bar and a percentage, and nothing about time. Both are opt-in (`rate`, `eta`)
  and off by default, so the line a bar has always drawn is byte for byte what it
  was.
- **The multi-bar is a new component over one live region, not several
  `createProgress()` instances.** Two live regions cannot share the bottom of the
  screen -- the same reason `tasks()` was sequential -- so a second bar would evict
  the first. One tree, a `For` over a `State` list of bar states, one row per bar,
  built from the same `progressView()` the single bar uses, so a row cannot
  disagree with a bar about what it looks like. `For` is what lets a bar be added
  or taken out without rebuilding the others.
- **The estimate is an exponentially weighted moving average with a _time_
  constant (5 s), not a sample count.** Each sample is weighted by the interval it
  covers (`1 - exp(-dt / window)`), so a loop reporting every millisecond and one
  reporting every second settle on the same pace, and a burst of ticks does not
  outvote the seconds before it. The first sample is the pace so far. Samples
  closer than 100 ms are not consumed but folded into the next, because a rate
  over a millisecond is noise. A value lower than the last one starts again. While
  nothing is reported the rate decays with the same constant when it is read, so
  a stalled job's ETA lengthens rather than freezing on the last good number. An
  ETA past 100 hours is not shown.
- **The clock is `performance.now()` and an option.** `now` is what a test moves
  by hand; nothing in the suite sleeps.
- **The rate and the ETA are written when the work moves, and are drawn only when
  there is a bar.** `trackProgress()` writes the worded text to
  `ProgressState.detail` from the setters, so the view stays a function of its
  state. There is no timer: an ETA on a bar that has stopped moving is the last
  one it was given until the next update. Piped, and under reduced motion, the
  detail is not drawn at all -- a rate in a log would be a different line on every
  tick, which is what stepping the percentage exists to prevent. A finished bar
  says neither: a time remaining of zero is not information.
- **Time and rate go through the catalog; the number does not go through `Intl`.**
  `{0}s`, `{0}m {1}s`, `{0}h {1}m`, `ETA {0}`, `{0}/s` and `{0} {1}/s` are keys, so
  a locale words the units. The decimal separator is a full stop in every locale,
  because `Intl.NumberFormat` is +6 ms to load (the i18n module's own note).
- **A group on a terminal is one frame; without one it is a line per bar.** A
  multi-row frame written to a pipe would repeat every unchanged bar on each
  change, so the pipe form is not the mounted frame: each bar writes
  `label NN%` to stdout when its rounded percentage changes (including `0%` when
  added, and `100%` whatever `step` divides into), and `write()` is a plain
  line. The group decides this at the first `add()`, from the terminal, as
  `taskLog()` does. Quiet writes nothing; the bars still keep their values.
- **Finished bars stay, unless `keep: false`.** A group of six downloads should end
  as a summary of six. A list longer than the screen cannot: the canvas is clipped
  where a written line scrolls, so `keep: false` writes the bar's pipe-form line
  above the frame and removes its row.
- **The label column is worked out from the bars that are there**, not grown. A
  bar that left or was relabelled shorter does not keep a column open. A row with
  no label still holds the column, and only a row set to align gets a
  `min-width`: a floor of zero is not the same declaration as none, since it lets a
  single bar's label shrink. The percentage has a four-column right-aligned cell
  in a group. The detail is last and has no reserved width: a canvas paints every
  cell it owns, and a reserved blank at the end of a row is trailing whitespace in
  the log once the frame is left behind.
- **A bar belongs to one run of its group.** `done()` and `stop()` on the group
  give the terminal back, and a bar from before is a bar of a screen that no
  longer exists: a change to it paints nothing and writes nothing. The first
  `add()` afterwards mounts a fresh group, as a spinner remounts on `start()`.
- **Not done:** a timer that counts the ETA down between ticks; an overall bar
  for the group; a bar that is indeterminate until its total is known; locale
  number formatting.

### A toggle prompt: two named states

SIG-168. `src/components/toggle.ts`, a prompt of its own. It returns a boolean, the
way `confirm()` does, and is not `confirm()` with labels.

- **Its own prompt, because the keys are different and the keys are the prompt.**
  `confirm()` is answered by typing a letter, and its hint (`(Y/n)`) is a catalog
  entry that decides both what is drawn and what is accepted. A toggle is answered
  by moving: Left and Right, Tab and Space. Putting `active` and `inactive` on
  `confirm()` would have kept two input models in one function and made the `y`/`n`
  affordance a thing a label could contradict -- `active: 'enabled'` beside a `y`
  that answers it. The ticket's other half (a setting is not a question, so the
  states are not "yes" and "no") is why the defaults are `on` and `off`.
- **The inactive state is on the left, and an arrow says where to go rather than
  switching.** Like a switch with the lit end on the right, and it is what
  prompts' `toggle` does. Left always answers `false` and Right always `true`, so
  pressing Right twice stays on the active state; Tab, Shift-Tab and Space flip.
  Shift-Tab is let through because with two states back and forward are one move.
  Up and Down are not read: a two-state switch has no vertical direction, and
  claiming them would take them from nothing that wants them. Ctrl or Alt with any
  of the keys is a different key, as for `confirm()`.
- **`on` and `off` are the defaults, through `__`.** Two new catalog keys. `yes`
  and `no` already exist and would have cost none, but a setting that reads
  `yes / no` is the confirm the ticket distinguished this from. A caller's own
  `active` and `inactive` are drawn as given and never translated.
- **`initial` defaults to `false`, the left-hand state.** Not `confirm()`'s `true`:
  the left-hand state is where a switch starts, and a setting the person has not
  touched should not read as having been turned on. A non-boolean `initial` is
  refused rather than coerced, because the current state is found by comparing it
  to each side and a truthy string would mark neither and answer with the string.
- **Names are refused where the prompt is asked, not drawn badly.** Blank, because a
  text of nothing but spaces measures zero at `white-space: normal` and the state
  would have a marker and no name; a control character, because both states share a
  line; and the same name twice (compared trimmed), because the answer would be a
  guess about which was meant. All three are a `PromptError` with nothing drawn,
  the way `selectKey()` refuses an unusable list.
- **The marker is what says which is current, and the colour agrees with it.** `◉`
  and `◯` are the multiselect's own symbols, so the answer is readable at colour
  level 0 (a pipe, `NO_COLOR`) where the accent and the dimming are gone. The two
  states are `.sigil-toggle-option` with `.sigil-accent` on the current one and
  `.sigil-muted` on the other: roles only, no colour in props.
- **The states are drawn whole or under the question.** A prompt's head caps what it
  reserves for what follows the message at half the line, which suits a hint that may
  wrap and not this: the canvas clips what runs past its edge, and at 24 columns a
  state came out as `o`. When the message and both states do not fit on one line
  (`message + states + 4` columns) the states take a line of their own, indented
  under the question. What the head reserves then is the longer name, because the
  answer replaces the states on the question's line and a question as wide as the
  screen otherwise clipped its own answer. Measured at 24 and 28 columns; both are
  tests.
- **Settled, it is the question and the name of the state chosen**, in the muted
  answer colour, and the mark goes to success, as `confirm()` does.
- **`signal` is `run()`'s, and nothing here handles it.** Every prompt goes through
  `runPrompt()`, which reads `PromptOptions.signal` (SIG-176); `toggle.test.ts` asserts
  a mid-prompt abort, an already-aborted signal and `AbortSignal.timeout()`, and
  since SIG-211 so does `prompt-signal.test.ts`'s every-prompt table.
- **Not done:** the key-help footer (SIG-166) -- no prompt has adopted it, and its entry
  says adopting it is a decision about whether a prompt grows a router; `y`/`n`
  shortcuts (that is `confirm()`); vim `h`/`l`; clicking a state with the mouse;
  more than two states (that is `select()`); a state that is disabled.

### A badge: a short coloured status label

SIG-178 asked whether a badge is a component or a theme class plus
documentation. `src/components/badge.ts` is `badge()` and `badgeView()`, and the
split is `note()` and `noteView()`'s.

- **A component, because the theme-class answer leaves the hard part to every
  app.** A badge is one styled text, which is the argument for the ticket's other
  answer, and what a class alone cannot do is the two things an app would each
  have to get right: a label that survives colour level 0, and a cell a `table()`
  can hold. The colour is not the component's either way -- the variants are the
  roles `note()` already maps (`warning` is `.sigil-warn`, for the same reason),
  and `neutral` is no role, as `note`'s default is none -- so this adds no
  vocabulary to a theme beyond `.sigil-badge` and five narrower hooks.
- **A role becomes a background by `inverse`, and that is the sheet's fifth
  declared exception.** The roles set `color`, and `.sigil-badge { inverse: true }`
  puts that colour behind the label. The alternative was a `background-color` per
  variant, which restates four colours the roles already own, so a theme would
  recolour `.sigil-success` and still have to be told about its badge. `should
  declare on a role, bar five exceptions that say why` was updated deliberately,
  and its reason is under "Themes".
- **The padding is spaces in the label, with `white-space: nowrap`.** Measured
  before it was written: `padding` paints nothing (the paint pass fills the cells
  of a glyph, not the empty ones around it) and a default `text` drops a
  trailing space; `nowrap` keeps both, and `inverse` then reaches them. A no-break
  space, which `note()` uses for its title, would also work but has to be turned
  back into a space on the way out, which a table cannot do for one cell.
- **At colour level 0 the padding is brackets, and the component decides it.** The
  inverse is dropped there, so `PASS` is `PASS` with spaces around it and a
  badge in a log line is not set apart from what it labels. Which characters are
  drawn is content, not style, so the sheet cannot say it -- the QR code decides
  its glyphs from the level for the same reason. Brackets rather than a symbol or
  the label upper-cased: the label is the app's and is never altered, and `[beta]`
  reads in a pipe. Both forms take two columns, so the width does not depend on the
  level and `badgeView()` can report one `width`. The level is
  `colorLevel ?? ansi.level`, the default a table uses too, so a badge and the
  table around it agree unless one of them is overridden; an override has to be
  mirrored on both, and the cost of not doing so is a shape, not a width.
- **A table cell may be a view, and a string badge cannot be one.** A string cell
  has its escape sequences dropped by `toDisplayText()` -- which is right, it is
  how a stray `ESC` is kept off the screen -- so a styled `badge()` string in a
  cell would print `[7;32m` as text. Rather than special-case escapes in cells,
  `table()` takes a `TableCellView` (`{ element, width }`, the shape every `*View()`
  already returns), measures the column by the declared `width`, and sets the tree
  in a box as wide as the column, justified by `align` and clipped at `maxWidth`.
  Detected by shape, and a finite numeric `width` is required, so a row holding a
  plain object still prints `[object Object]` as it did. Nothing else about a
  table changed: `columnWidths()` reads each cell's width instead of measuring a
  string, which for a string cell is the same `stringWidth()` as before.
- **Escape sequences and line breaks in a label are dropped, and an empty label
  draws nothing** -- a zero-width view and an empty string, not a coloured gap.
  There is no truncation: a badge is a short label, and a table's `maxWidth` is
  what cuts one that is not.
- **String form only, and it ignores `--quiet`**, as `note()` does.

What is deliberately not done: a `muted` or `accent` variant (the ticket named
five, and either is one line in `ROLES` the day a caller wants it); an icon or
symbol per variant; case folding; and a badge carrying a colour in its props.

### A rule: a horizontal divider, with an optional label

SIG-180 asked for what Textual's `Rule` and `ink-divider` draw: a line across the
width, with words in it if wanted. `src/components/rule.ts` is `rule()` and
`ruleView()`, and the split is `note()` and `noteView()`'s.

- **A component, and not a documented border-top recipe.** That settles the
  ticket's question, and the recipe is not available rather than merely worse:
  `border-style` is one value for all four edges and there is no `border-top`, so
  a box that draws only a top line does not exist -- the nearest is a one-row box
  with a border, which is three rows and a rectangle. What the component is worth
  is also the argument the ticket made, a named thing with a theme-driven style and
  a label that aligns, and none of it is a recipe's to carry.
- **A row of three fixed-width texts, and the arithmetic is the component's.** The
  line before the label, the label, the line after it, each `white-space: pre` and
  `flex-shrink: 0` with the width it stands for -- `chart.ts`'s shape, for its
  reason: the rule has already been fitted, and a text drops trailing whitespace
  unless it is given its room. The width is fixed when the tree is built, as
  every `*View()` here is. A `raw` that stretched to whatever the layout gave it
  was the alternative and is not done: it would need a width the string form does
  not have, and the string form is the facade.
- **The label keeps line on both sides, and it is dropped rather than drawn over
  the end.** Two cells of line at the end it leans towards and one at the other,
  and one at each end when centred, with a space either side of the words. Where
  the width cannot hold that around a label of one column the rule is a plain
  line, and a label cut to nothing but its ellipsis is dropped as well -- an
  ellipsis alone says nothing, and `note()` goes without a title the same way. A
  centred label puts the odd cell on the right. The cut is `truncate()`, which may
  come back a column short for a wide character, so the line after the label is
  worked out from what was **measured** rather than from what was asked for.
- **The line style is `line`, and it is not CSS.** "Line style from the theme" is
  half true: the colour and the attributes are, through the cascade, and the
  character is not, because no property carries a character -- `border-style` is a
  character set for a border and this is not one. So `line` is the horizontal of
  the border sets (`single` `─`, `double` `═`, `bold` `━`, `ascii` `-`), and `round`
  is not offered because its horizontal is `single`'s. It falls back to ASCII by
  `unicodeSupported()`, the one place that is decided, and an explicit `line`
  always wins.
- **It is dim, and the label is not.** A divider is there to separate, so the
  default role is `muted`, on the line alone: the words are the one part meant to be
  read, and `sigil-heading` makes them bold. Any other role -- `accent` or a state
  -- is the whole rule's, label included, which is the `note()` rule for its
  variants. `none` carries no role class at all, which is the terminal's own
  foreground. The label's `sigil-muted` is left off rather than overridden, since
  two rules of equal specificity on one element are decided by source order.
- **Escape sequences and line breaks are dropped from the label.** A label is
  words, colour is the role's, and a break would make the rule two rows.
- **String form only, and it ignores `--quiet`.** A rule is a result, on `table()`
  and `note()`'s side of the line, and the caller does the writing.

What is deliberately not done: a rule that follows a resizing layout; a vertical
rule; a label on both sides; and a style set to a pattern such as `- -`.

### A paginator: page state, and a dot or numeric indicator

`src/components/paginator.ts`. SIG-190.

- **It is separate from the windowing in `prompt.ts`, and that settles the
  ticket's first question.** A window's position follows a cursor and moves a row
  at a time over a list that is one thing; a page is a unit the reader steps
  between over content that is in pages. One counter cannot serve both without one
  of them lying about what it is -- a scroll offset is not a multiple of anything,
  and a page number is -- so the paginator shares no state or code with
  `listWindow()` or `ScrollBox`. It is for a wizard, a result set, a help browser.
- **The state is three signals and everything else is a function of them.**
  `page`, `perPage` and `total`; the number of pages, `start`, `end`, and whether
  there is a next are computed from them wherever they are read, so `paginatorView()`
  and the `Paginator` facade cannot disagree about where the page is.
- **`page` counts from zero, and `format()` is handed it counting from one.**
  Zero is what it indexes a list with and what Bubbles' paginator uses; one is
  what a reader is told. The two meet only in the indicator, which converts once.
- **Reads clamp and writes normalize, and both are needed.** A page written past
  the end through `state.page` reads as the last, so a view never shows a page that
  is not there. A `total` that shrinks writes the clamped page back, so growing
  again does not spring it to where it was -- clamping on read alone would have
  done exactly that. A `perPage` that changes keeps the page's **first item** on
  screen (`floor(start / perPage)`) rather than the page number, since page 3 of
  tens and page 3 of fives are different places.
- **Nothing to show is one page, not none.** `pageCount(0, n)` is 1, so an empty
  result set reads `1/1` and a single dot, and `onFirstPage` and `onLastPage` are
  both true. A `perPage` under one is one and a `total` that is not a count is
  nothing, rather than a throw: these are written from application data, and a
  paginator that throws on an empty query is a bug in every caller.
- **Moves report whether they moved.** `next()` on the last page returns `false`
  and changes nothing; there is no wrap-around, because a wizard that wraps from
  the last page to the first is a surprise and a result set that does is rarely
  what anybody meant. A caller that wants one writes `pager.next() || pager.first()`.
- **Indicator styles: dots, numeric, both -- the ticket's second question.** The
  default is dots, one per page with the current one filled and the rest hollow, so
  the position survives with no colour as the filled dot against the hollow ones.
  The roles are `.sigil-accent` and `.sigil-muted`, the ordinary ones, with
  `.sigil-paginator-*` classes beside them as the narrower hook.
- **Past `maxDots` (10) pages the dots give way to the number, whatever the style
  says, and `both` becomes the number alone.** A row of dots that does not fit
  wraps into a different shape on every terminal width, and nobody counts forty of
  them. Ten is the number a reader can still take in at a glance; `maxDots` moves it.
- **The number is not in the message catalog.** `2/5` is not prose, so there is no
  key for `Page {0} of {1}` to translate; `format(page, pages)` is where an app
  words it, in whatever language it already has.
- **The string and the live view are one function.** `slotsFor()` decides the four
  runs -- dots before, the current dot, dots after, the number -- and both
  `pageIndicator()` and `paginatorView()` write them, so the two cannot disagree
  about where a space goes or when dots give way to a number. They are separate
  text nodes because each takes its own role, and each is `white-space: pre` with a
  width, since a text drops the whitespace at the end of its last line and the space
  that separates a run from the next would otherwise be nothing at all. Until
  SIG-207 that was true of `pre` too and the width alone held the space; `pre`
  keeps it now, and the width is what it would measure anyway. See `white-space` in [`src/element/AGENTS.md`](../element/AGENTS.md).
- **The glyphs follow `unicodeSupported()`.** `●` and `○` are not safe where box
  drawing is not, so a Linux console or `TERM=dumb` gets `*` and `.`, as the charts
  do; `ascii` overrides it either way.
- **No key handling.** Bubbles' paginator ships key bindings; this does not. A
  paginator is state and a drawing, and which keys turn the page belongs to the
  app's own router -- the same decision `ScrollBox`'s bindings and `keyHelp()` leave
  to the caller.
- **Not done:** wrap-around; a page that follows a cursor (that is a window); a
  live indicator with a `mountLive()` facade of its own -- it is a tree an app puts
  inside its own, like `calendarView()`; windowing a long row of dots around the
  current page.

### An interactive table: `selectRow()`

`src/components/select-row.ts`. SIG-193. A prompt over `table()`'s columns: a
cursor over rows, Enter answers with the row, a digit sorts. It is a list prompt
in the shape `sort()` is -- `runPrompt()`, the rows rebuilt per draw for the
window, `listWindow()` -- and what is new is that the head of the table is a row of
its own.

- **One column model, which is why `table.ts` exports its pieces.** The ticket's
  first line. `tableCells()`, `tableWidths()` and `tableRowView()` are what
  `tableView()` was already made of, given names and exported, and `tableValue()`
  is the one line that reads a cell off a row, lifted out so that a sort and a
  table cannot disagree about which value a column holds. They are on the
  components barrel and not only exported from the file, because the registry
  rewrites a sibling import to `@ttylabs/sigil/components` -- an ejected
  `select-row.ts` that imported a helper the barrel did not carry would not
  resolve in the app. `Column` is unchanged: what a sort adds (`compare`,
  `sortable`) is `SelectRowColumn extends Column`, so `table()` does not grow two
  properties it would ignore, and a `Column` is still accepted wherever a
  `SelectRowColumn` is.
- **The cursor is on rows and not on cells.** The ticket asked. A cell cursor is
  for a table whose cells are what is picked, and the case that motivated the
  ticket -- a deployment out of a list -- picks a row; every other thing a cell
  cursor would want (an action on one column) is a second prompt over the row it
  returned. Left and Right are left unbound rather than meaning something
  different from every other list here.
- **The answer is the row that went in, by reference.** Not a copy and not an
  index, for the reason `sort()` answers with values: an index makes the caller
  look the row up again in a list they just passed in. It is also what makes a
  sort invisible to the caller -- the table may show the rows in any order and the
  answer is still the object it holds.
- **Sorting is built in, on a digit, with a per-column `compare` for what it
  cannot know.** The ticket asked whether it is built in or the app's job. A
  callback that reorders `rows` would need the prompt to hand control back
  mid-prompt and take new rows, which is a state machine nobody asked for, while
  the column the app cares about is nearly always a string, a number or a date.
  So the common cases are decided here and the rest is `compare(a, b)` on the
  column. A digit rather than a chord or a column cursor for the reason `sort()`
  picked Space: it reaches every terminal and needs no second mode. Pressing it
  again reverses, and a third time clears -- the three states a column can be in
  -- and the nine-column reach is the keyboard's, not a choice. The hint says
  `1-N`, `N` being the last sortable column, so a non-sortable column in the
  middle is a digit that does nothing rather than a gap in the range.
- **The default order is by what the value is, not by its text.** A cell holding
  `9` and one holding `10` order as numbers, which is what a sort is for and what
  the drawn text cannot say; `table()` hands cells to the screen as strings, so
  this reads the row through `tableValue()` and not through the cells. Dates order
  by time, booleans as `0` and `1`, and anything else as text, **case folded and
  then by code unit, not by `localeCompare()`**: `Intl` is the 4-7 ms the i18n
  README refuses to pay for a thing the framework has no use for, and `path.ts`
  already orders by code unit for the same reason. A column that wants a locale
  has the lever. A number comes before a text in one column, so the order is
  total.
- **An empty cell is last whichever way the column runs.** Missing, `null`, `NaN`
  and an invalid `Date` have no place in an ascending order that reversing it
  would improve, so descending does not put a column of blanks on top. It is the
  sorter and not the comparator that says so, which means a custom `compare` is
  never handed an empty value and does not have to write the same guard. The sort
  is stable and descending flips the comparison rather than the list, so rows that
  tie keep the order they came in both ways.
- **The cursor follows its row through a sort.** Sorting finds the row that was
  under the cursor in the new order and puts the cursor back on it, so the thing
  you were looking at does not change under you, and the window scrolls to it. The
  alternative -- the cursor stays on a line number -- moves it to a different
  deployment with no sign that it did, which in a prompt whose answer is the row
  under the cursor is the one thing it must not do silently.
- **The heading is sticky because it is outside the window, and `ScrollBox` is not
  involved.** The ticket guessed it "depends on `ScrollBox`". Every list prompt
  here windows with `listWindow()` over rows rebuilt per draw, and the heading is
  a sibling of that list rather than a row in it, so it cannot scroll away. A
  `ScrollBox` is for content that is bigger than its box and is walked by a
  scrollbar; a prompt's rows are an index and a window, and sixty of them cost
  nothing to rebuild.
- **Widths are measured over every row, once.** A column that took its width from
  the rows on screen would change as the window moved, which is a table that
  breathes. The cost is that the width is fixed at the longest cell anywhere, and
  `maxWidth` is what bounds it. A **sortable heading keeps two columns back for
  its arrow**, added to the measurement of the heading only: turning a sort on
  must not move every column to its right, and the arrow is drawn over the heading
  truncated to leave it room. A column whose cells are wider than its heading
  costs nothing; one whose heading is the widest costs two columns, which is the
  price of a table that holds still. `sortable: false` on every column spends
  none, and then the heading and rows are `table()`'s own lines behind a
  two-column pointer -- which a test pins.
- **A line says where in the table the cursor is, and only when rows are off
  screen.** `n/total` under the rows, spent from the same height the rows have, so
  the question, the heading, the rows and that line add up to what the terminal
  has. A table that fits is the table and nothing else. It is not translated: it is
  two numbers and a slash.
- **`rows` is the data, so the height is `height`.** `sort()`, `autocomplete()` and
  the rest call the cap on their window `rows`, and here `rows` is what `table()`
  already calls the data. One of the two names had to give way, and the data is
  the one the first argument of the sibling function is.
- **Rows are not `disabled` and there is no `multiple`.** Not asked for. A
  disabled row would have to be a column-model property (which row is it, in the
  data, after a sort) and a multi-select table is a different answer type. Both
  are additive.
- **Not done:** an initial sort, which the caller can do to the rows they pass; a
  cell cursor; filtering by typing, which `autocomplete()` is for and which would
  want a second state for what the keys mean; resizing columns.

### A timer and a stopwatch: signals first, and only the readout is quiet

`src/components/clock.ts`. SIG-185.

- **The two questions the ticket left open, settled.** _Component, or a formatted
  signal driven by an interval?_ The second, with a view over it: the readout is
  `Installing... 12s` -- a spinner's text -- or a node in a tree the app already
  has, so a facade that mounts a region of its own would be the one shape nobody
  can put beside anything. There is no `createStopwatch()` that owns the bottom
  of the screen; `mountLive(() => clock.view())` is the one line that is. _Which
  format?_ Both, and the default is words: `42s`, `3m 05s`, `2h 10m` is
  `formatDuration()`, which already goes through the catalog, so a locale words
  it and no key was added. `'clock'` is `00:42` and `2:10:00`, digits and colons,
  which is not a thing a catalog words, and a function is handed whole seconds.
  The words form drops the seconds past an hour, as the ETA it was written for
  does; a stopwatch that runs for hours and wants them says `'clock'`.
- **The time is never stored, and that is what makes quiet cost nothing.** It is
  what was counted before the current run, plus `now() - startedAt`, read off the
  clock whenever it is asked. A signal holding it would be wrong between ticks and
  would be stale for good in a run that ticks never -- and a quiet run is exactly
  that. What a tick is, is a counter written so that whatever read the time in an
  effect reads it again: the getters (`elapsed`, `remaining`, `text`, `running`,
  `live`) read a state and then the clock, so the same property is fresh when read
  plainly and reactive when read in an effect. Not a `Computed`, which would
  memoise on the counter and answer a quiet clock with the value it had when it
  started.
- **Quiet gates the redraw and nothing else.** `mountLevel()` is asked on each
  `start()` -- not at construction, for the reason a facade's `write()` asks: a
  clock built in a module body exists before `main()` has read argv -- and the
  answer is `live`. Not live means no redraw timer, and `view()` is `display:
  none`: piped, under reduced motion and quiet. Hidden rather than drawn once,
  because `0s` written once to a log is a wrong number and not a missing one, which
  is the rule a bar's rate already follows. But a **timer still runs out** in a
  quiet run and `done` still settles, because a countdown before an action is
  behaviour: the action has to happen whether anybody is watching, and a timer that
  stopped counting under `--quiet` would hold it back for ever.
- **Two timers with opposite jobs, and the reference is the difference.** The
  redraw is `unref()`ed, as the spinner's is: a readout is not a reason for a
  finished program to stay alive. The deadline of a `timer()` is **not**, because
  somebody is awaiting `done` and a top-level `await` on a promise nothing will
  settle exits with code 13. It costs a running countdown the process, which is
  what a countdown is; a paused or cancelled one holds nothing. Both are
  `setTimeout` chains rather than an interval, for the reasons below.
- **A redraw lands on the boundary of what is shown, not a tick after the last
  one.** A stopwatch changes when the elapsed time crosses a multiple of the tick,
  a countdown when the time left does, so each redraw is armed for that, taking
  the turn of the event loop that ran late into account instead of pushing every
  later second back by it. Seconds round the way a watch reads them -- down when
  counting up, up when counting down -- so a timer with 400 ms left says `1s` and
  `0s` only when it is over.
- **A timer may fire early, and the deadline does not believe it.** Node can run a
  `setTimeout` a millisecond before it was due. A deadline that finished then
  would say zero with time left, so it asks the clock and waits for the rest. And
  a delay is capped at 2^31 - 1: past it the platform fires at once with a
  warning, and a loop that re-arms for the time left would spin; a long countdown
  is waited for in pieces instead.
- **`done` settles `true` when it runs out and `false` when it is cancelled, and
  never rejects.** A promise that never settles is the worse answer for the code
  awaiting it, and the boolean is what tells the action whether to proceed. A
  timer that ran out stays out until `reset()`, which gives it a new promise: the
  first one is spent and the next run's awaiter needs one of their own. A
  cancelled timer stays stopped until `reset()` for the same reason. Restarting
  it used to run a fresh countdown under a `done` that had already said `false`,
  so the code awaiting it skipped its action while a referenced deadline held
  the process open for nothing. Giving `start()` a new promise was the other
  option, and it was refused: a promise that changes identity on `start()` would
  be a second place a new run begins, beside `reset()`. A
  duration of zero is over as it starts. A duration that is not a finite
  non-negative number throws where it is given.
- **Not done:** a stopwatch with laps; a timer that restarts itself; a facade that
  owns a region; sub-second readouts (`tick` redraws faster and the format still
  speaks whole seconds); a `ref: false` for a countdown that should not hold the
  process.

### More spinner frame sets: seven in the package, the rest as data

`src/components/spinner.ts` and `src/components/spinner-frames.ts`. SIG-183.

- **The two questions the ticket left open, settled.** _How many?_ Seven in
  `@ttylabs/sigil/components` -- `DOTS`, `LINE`, `ARC`, `CIRCLE`, `GROW`, `ARROW`
  and `BOUNCING_BAR`, which is the ticket's own short list less the moon -- and
  twelve more in `spinner-frames.ts`, a registry entry nothing imports. They cost
  **803 B** on the components graph as of this change (337,387 to 338,190 over the
  same 31 modules, the option handling and the width fix included) and nothing on
  the root entry, which stayed at 12,269. That is small enough that the split is
  not really about bytes, and it is worth saying so: what it buys is an entry that
  is a choice rather than a catalogue, and a long tail an app owns once it copies
  it, the way it owns any ejected component. _Frame width?_ One cell everywhere,
  read as the three checks below, and the moon does not ship.
- **"One cell everywhere" is three checks, and the third is the one a width
  cannot say.** Every frame of a set is the same width, so the label never moves.
  Every set that is not plain ASCII is exactly one cell by `stringWidth()`, which
  counts an emoji as two -- that is what refuses the moon, and it would be refused
  even at a constant two, because an emoji is two columns on a terminal whose
  width table knows it and one on a terminal whose table does not. And a set does
  not mix East Asian **Ambiguous** characters with narrow ones: `stringWidth()`
  counts Ambiguous as one, which `src/width/` decided and which is right for a CLI,
  but a terminal in a CJK locale draws it as two, and a set that alternates the two
  kinds jitters there where a set that is all one kind is merely wider. That is
  what refuses `◐◓◑◒` -- the first and third are Ambiguous -- and why `CIRCLE` is
  the quarter-filled `◴◷◶◵`. `GROW` and `ARROW` are all Ambiguous and ship: wider
  in a CJK terminal, still steady. `BOUNCING_BAR` is the one set wider than a cell,
  which is safe because it is ASCII.
- **The test reads a transcribed table, and fails on anything outside it.**
  `test/components/spinner-frames.test.ts` carries the `A` ranges of the seven
  blocks a set draws from, out of `EastAsianWidth.txt` 17.0.0 -- test data rather
  than runtime data, since the runtime counts them as one and has no use for the
  list. A character outside those blocks fails rather than being read as narrow by
  default. Every exported set of both files is enumerated rather than listed, so a
  new one is measured without anybody adding it, and two sets that _must_ fail --
  the moon and the circle halves -- are asked of the same checker, so the checker
  cannot pass by checking nothing.
- **`ARROW`'s diagonals are emoji with a text default, as `OUTCOME_SYMBOLS` are.**
  `↖↗↘↙` carry the Emoji property and draw as text unless a `U+FE0F` asks
  otherwise, which nothing here writes. `✔`, `✖`, `⚠` and `ℹ` are the same kind and
  have been on every settled line since the spinner was written, so refusing the
  arrows would be a rule the package does not otherwise keep.
- **`LINE` is now the default where `unicodeSupported()` says no, and it was
  opt-in before.** The ticket asked for an ASCII fallback, and the fallback was
  already there; what was missing was anything choosing it. `spinnerFrames()` asks
  `unicodeSupported()` -- the one place that is decided, as the note, the rule, the
  charts, the outline and the paginator already ask it -- and takes `ascii`, `env`
  and `platform` the way they do. Explicit `frames` always win, as an explicit
  `border` does on a note: an app that asked for `ARC` gets `ARC`, and one that
  wants a fallback says `frames: unicodeSupported() ? ARC : LINE`. So the
  parentheticals in the session and `log` entries above that call the spinner's
  `LINE` opt-in describe the spinner before this change.
- **`DOTS` and `LINE` changed shape, from an array to `{ frames, interval }`.** One
  shape for every set is what lets each carry its interval, which the ticket asked
  for, and `frames` takes either a set or an array, so `frames: DOTS` reads as it
  always did. What breaks is a reader of `DOTS[0]`, which is now `DOTS.frames[0]`;
  `display.test.ts` was the only one in the repository. `LINE` runs at 130 ms where
  it inherited 80, because four frames at 80 is a blur. A set of the caller's own
  with an interval that is not positive takes 80 rather than a timer that never
  yields, the question the option was already asked.
- **The lead is as wide as what it draws, because a text drops the whitespace at
  the end of its last line.** `'.  '` drew one column, `'.. '` two and `'   '`
  none, so `SIMPLE_DOTS` moved the label every tick -- and so did any array of a
  caller's own with a trailing space, which nothing had tried. The first fix
  written was `white-space: pre`, on the belief that `[    ]` collapsed to `[ ]`;
  the sabotage pass showed that neither was true -- an interior run is kept either
  way and `pre` keeps no trailing one -- so it was taken out rather than left as a
  declaration that does nothing. The declared width is the paginator's answer to
  the same rule, and it is set on the settled mark too, since a width left over
  from a six-cell frame would pad `✔` out to six. That measurement was right for
  its day and stopped being so in SIG-207: `pre` was `normal` under another name,
  and it keeps a trailing space now. The width stays: it is set per frame to what
  the frame measures, which is exactly what a `pre` lead would come to, so moving
  onto `pre` would change no output and would be a second way of saying it. See `white-space` in [`src/element/AGENTS.md`](../element/AGENTS.md).
- **The long tail is a registry entry that is data, and the registry test says
  which.** `should say what %s can be themed with` asserted every entry lists a
  class, and an entry that draws nothing has none. It is an explicit `DATA` list
  rather than an inference, so a component that lost its classes still fails. One
  trap found on the way: the generator rewrites every relative `from '...'` in an
  entry, a doc comment's example included, so the file's own usage example came
  out importing `DOTS_2` from `@ttylabs/sigil/components`, which does not export
  it. The example is written without a specifier now. `test/dist.test.ts` asks
  every shipped file for a glyph only the long tail draws, which is what keeps it
  out of the bundle -- exporting it from the barrel fails all five.
- **Not done:** the settled marks under `ascii` (`✔` and the rest stay as they
  are; `LOG_SYMBOLS_ASCII` is the obvious source, and swapping them is a change to
  what every settled line says that this ticket did not ask for); a spinner named
  by a string, `spinner: 'arc'`, which would put every set in a bundled app's
  graph for want of a static reference to shake by; and a set that carries its own
  ASCII fallback.

### A collapsible: a title that opens and closes, and an accordion of them

`src/components/collapsible.ts`. SIG-192. Textual's `Collapsible`: a focusable
title over a body that is shown or hidden. It is an element-tree component in the
shape `ScrollBox` is -- a function of props that returns the host, with its keys
in `onKey` and its click in `onMouse` -- and not a prompt, because a section does
not answer anything: it sits in a tree beside other things and stays there.

- **The three questions the ticket left open, settled.** _Keys:_ Enter and Space
  flip the focused title, Right opens it and Left closes it -- the tree-view
  convention, and the one `filePicker()` already uses for into and out of a
  directory. Up and Down are **not** bound: moving between the titles of an
  accordion is what the ARIA pattern does with them, and it needs the focus ring,
  which an element does not hold -- a component that wanted it would have to be
  handed the router, which does not exist while the tree that makes it is being
  built. Tab already walks the titles, since a closed body is `display: none` and
  the ring skips it. _Accordion:_ in, as `collapsibleGroup()` handed to each
  member, because it is a dozen lines over the state each member already has and
  the ticket's own description of an accordion is "several of them, one open".
  _Animated height:_ **no**, and instant is the recommendation rather than a
  deferral -- the next bullet is why.
- **Instant, because a height animation here buys little and costs three
  things.** `height: auto` does not interpolate: `mixLength()` snaps between
  `auto` and cells, as CSS does, because `auto` is a question the layout answers
  and not a number. So animating would mean measuring the body after a layout,
  pinning `height` to that many cells, easing from zero, and unpinning at the end
  -- a body that grows while it is open (a log, a lazily filled list) would be
  clipped by the pin until the end, and the first frame would be one layout late,
  which is the lag `ScrollBox` draws its thumb with a `raw` element to avoid. Every
  frame of it also moves **every row below the section**, so the canvas diff,
  which is cheap exactly where little changes, repaints the rest of the screen
  per frame -- over ssh, for a reveal that is three to ten whole-cell states at
  most. And it would be one more thing for reduced motion and quiet to switch off,
  which they would, since the animator does not start a transition under
  `reduce`; instant is what both of those come to anyway. Textual's own
  `Collapsible` does not animate either. An app that wants motion can still put a
  `transition` on the title's colour through the theme hooks.
- **The body is built once and hidden, not unmounted.** `children` runs when the
  section is built, open or not, and closing sets `display: none` on the body. So
  what is inside it -- a scroll offset, a text field's contents, a row windowed by
  a `ScrollBox` -- is the same when it opens again, and the cost is the body's
  elements existing while nobody can see them, which for "show stack" is a few
  texts. Building on first open was the alternative, and it would make the first
  open the one that is different from every other.
- **The title is what is focused, not the host.** A key reaches the focused
  element and then its ancestors. With the handler on the host, Enter typed into
  a field inside an open body would bubble up and close the section around it; on
  the title, which is the body's sibling, it never arrives there. The click is on
  the title for the same reason.
- **`open` is a boolean or a `State<boolean>`, and the state is the one truth.**
  `keyHelp()`'s `expanded` already has that shape. The keys and the click write
  the state; one effect reads it and sets the body's `display`, the marker and the
  `is-open` class. So an app that writes the state opens the section, and nothing
  holds a second copy for the two to disagree about. Anything else for `open` is
  refused where the section is built: a truthy string would read as open and then
  never be `true` again, which is the hole `toggle()` refuses its `initial` over.
- **A group closes the others in that same effect, not in the key handler.** That
  is what makes the rule hold for an app writing a member's state as well as for a
  key or a click. Two members built open leave the later one open, because each
  closes the others as its effect first runs. Closing the open member leaves none
  open: the ARIA accordion allows either and "at least one" would need a rule for
  which one when the app closes them all, which `closeAll()` does. A member built
  inside a component leaves the group with it, through `onCleanup`; one built
  outside any owner stays a member, and closing a section nobody can see costs a
  write.
- **An arrow that would change nothing is not claimed; Enter and Space always
  are.** Right on an open section and Left on a closed one go on to whatever is
  around it -- a horizontal `ScrollBox` gets its arrows back. That is the opposite
  of `ScrollBox`'s own rule, which claims Home at the top, and the difference is
  that a scroll box at its end is still the thing those keys are about, while a
  section that is already open is not what Right is asking for. A key with Ctrl,
  Alt or Shift, and a key that arrived in a paste, are left alone: a pasted line
  ending in a newline is not an Enter on whatever happened to have the focus.
- **The click toggles, not the press.** The press is left to bubble so its default
  action -- focusing the title -- still happens, and a press dragged off the title
  toggles nothing. Only the left button; a wheel goes on to whatever scrolls.
- **Its keys are described by a helper, `describeCollapsible()`.** The key-help
  footer can only list what `describe()` declared, and the router a section would
  describe to is built from the tree the section is in, so it cannot be an option.
  The helper scopes the four keys to each title, which is exactly where they work,
  and returns one disposer. The descriptions go through `__`, as the framework's
  own strings do.
- **A focused title is inverted, and since SIG-278 by the focus role rather than a
  `:focus` rule.** The title's `onFocusChange` puts `.sigil-focus` on it, and that
  role is `inverse`; what follows is why the title shows its focus at all, and was
  written when the sheet said it with `.sigil-collapsible-title:focus { inverse:
  true }` -- "Focus on a control", at the end of this file, retired it. The
  framework sheet had its first `:focus` rule here. Without it a Tab onto a title
  looks like a Tab that did nothing -- a scroll box shows its focus by scrolling, a
  title has nothing else to show it by. The rule was `(0,2,0)` where every other
  rule there was `(0,1,0)`, which cost a theme nothing, because the cascade decides
  origin before specificity; the role that replaced it is `(0,1,0)` like the rest.
  At colour level 0 attributes are dropped and the focus is not shown, which was
  true of the `:focus` rule and is true of the role; the demo says the focus in
  words when piped for that reason. The rule was the sixth declared exception in
  `test/theme.test.ts`'s role invariant, beside the caret and for the reason then
  written as "no role is inversion" -- which `.sigil-focus` made false, and which
  is why the rule could become the role. The marker's one-cell margin is not inverted, since a margin is cells
  nothing paints -- a trailing space in the marker's text was tried instead and is
  measured away. Re-measured in SIG-207 and that is true only of `normal`: the
  marker is `nowrap`, and a `nowrap` (or now `pre`) `'▸ '` keeps its space, so the
  gap could be inverted with no new property. Left as it is, since whether the
  focus bar should span the gap is a design question rather than a defect.
  See `white-space` in [`src/element/AGENTS.md`](../element/AGENTS.md).
- **Not done:** moving the focus to the title when a section is closed by
  something other than its title (an app writing the state, or a group) while the
  focus is inside its body -- an element cannot move the focus, so the focus stays
  on a hidden element until Tab, which is the same thing an app hiding any
  focused subtree gets; Up and Down between an accordion's titles; a `disabled`
  section; a title that is an element rather than a string; and opening by
  default where there is no terminal -- the app knows whether it built a router,
  and a section nobody can open is one it should build open.

### A pager: `less` keys, line numbers, and `/` search over a scroll box

`src/components/pager.ts`. SIG-195. `createPager()` is the element and `page()`
is the facade that puts one on the whole screen until `q`, the way `gum pager`
does.

- **Its own component, not props on `ScrollBox`.** The ticket's first question.
  A scroll box holds no state -- the first decision recorded for it above -- and
  holds any element at all; a pager holds a query, its matches, which one is
  current and whether a search is being typed, and what it holds is text, which
  is the only thing a search can run over. Props would make `ScrollBox` a text
  component with a state. And the keys settle it on their own: `space`, `b`, `d`,
  `u`, `g` and `/` on every scroll box would take the letters from any text field
  inside one. So the pager builds a scroll box with `rows` -- windowed, so ten
  thousand lines cost what the window does -- and adds the keymap, the gutter and
  the search over it, the way `selectRow()` builds on `table()`'s pieces.
- **Search is literal by default, smart case, and a regular expression is the
  app's to turn on.** The second question. What a reader types into a pager is
  mostly text -- a function name, a path, a version -- and `.`, `(` and `[` are in
  all three. `search: 'regex'` reads the query with the `u` flag. Smart case is
  `rg -S`'s: a query with no capital matches either case, one with a capital
  matches exactly, and an escape like `\S` is not counted as a capital somebody
  typed. The regex is an **opt-in rather than a default** because of the one
  hazard nothing here can bound: a pattern that backtracks catastrophically runs
  on this thread and no engine can interrupt a match once started. Everything
  else is bounded -- a pattern that does not compile is reported on the status
  line, an engine error mid-match is caught and reported the same way, and the
  matches stop at `MAX_MATCHES` (100,000, with the count shown as `100000+`).
  It runs on Enter, not per keystroke: an incremental search would run every
  prefix of a pattern, half of which do not compile, and would pay the hazard
  once per key rather than once.
- **A zero-length match counts once per line, and only on a line with no other
  match.** So `^$` steps through the blank lines, as it does in `less`, and `a*`
  -- which matches empty at every column -- steps line by line rather than column
  by column, and on a line with a real `aaa` counts only that. It is drawn as
  nothing, since there is nothing to reverse. `matchAll()` is what makes it safe:
  it advances past an empty match itself, so there is no `lastIndex` loop here to
  get wrong.
- **`n` steps from where the reader is.** The match after the current one while
  the current one is on screen, otherwise the first one at or below the top of the
  window -- and `N` the mirror. So `n` after paging away finds the next match
  below you, which is `less`, rather than dragging you back to where you last
  searched. Both wrap at the ends. A new search lands on the first match at or
  below the top of the window for the same reason.
- **A match is revealed at the top of the window, and only if it is off screen.**
  The top because what follows a match is what the reader went looking for, which
  is `less` again. A folded line is shown from its **first** row where that still
  leaves the match on screen, so a match on a line's second row does not arrive
  with the start of its sentence scrolled off above it. With `wrap: false` the
  view also shifts sideways to put a match past the edge half a window in.
- **Soft wrap by default, at the column and not the word.** The third question.
  `less` folds by default, and a CLI pages help, changelogs and diffs more than
  it pages tables. At the column because `wrap()` breaks prose at words and drops
  the whitespace it breaks at, which is right for a help screen and wrong here:
  a pager shows every character of the file in order, and a match maps to a row
  by offset only when no character moved. `softWrap()` folds by grapheme cluster,
  sends a wide character that would straddle the edge to the next row, and gives
  an empty line one empty row. `wrap: false` is one row per line cut at the edge,
  with Left and Right shifting by half a window -- **the pager's own column
  offset, not the scroll box's horizontal axis**, so the gutter stays put while
  the text moves, which a horizontally scrolled content box could not do.
- **The rows on screen are redrawn in place, because the scroll box keeps them.**
  A windowed list builds a row when it enters the window and keeps it while it
  stays, which is right for the focus and means a highlight that changes, a fold
  at a new width or a sideways shift would otherwise never be seen. So the pager
  keeps the rows `row()` handed out, by index, and rebuilds their children on any
  of the three -- pruning the ones whose slot the scroll box has since taken out,
  which is a slot with no parent. `count` is a getter, since `ScrollRows.count`
  is read on every window and a fold at a new width is a new count.
- **That map is pruned on every scroll, not only before a redraw.** The first
  version pruned inside the redraw alone, which runs on a search, a resize and a
  sideways shift -- so paging through a long document without searching kept every
  row ever built, and the slot each one still points at, which is the windowing
  given back: a million-line log paged with Space held a million element trees,
  and the next search walked them all. The pager's `onScroll` prunes after the
  scroll box has re-windowed -- which is when the box calls it, and the one
  moment what it took out is known -- and its `onResize` does the same after its
  `resync()`. Found in review.
  `should forget the rows a page down scrolled out of the window` counts a
  search's reads of `parent` on rows already off screen, which is what an unbounded
  map costs that a picture cannot show; with the scroll-time prune deleted it reads
  24 of them.
- **The pager reaches its scroll box through `scrollControl()` and hears it
  through `onScroll` and `onResize`.** It used to find the viewport with
  `scrollViewport()` and **wrap** both of the viewport's hooks -- read each one,
  install one that called what it found -- with the order inside `onResize`
  load bearing: refold, redraw and re-anchor first, and only then the scroll
  box's own sync, because that sync reads the new count. That worked and was
  tested, and every word of it was knowledge of another component's internals,
  which a third component on a scroll box would have had to learn again.
  SIG-209 replaced it, under "A scroll box heard from outside" below; what the
  pager owes the box now is one call. The box re-windows before it calls the
  pager's `onResize`, so for a width that moved it has windowed the **old**
  count, and the pager refolds, redraws, re-anchors and **then** calls
  `resync()`. Sabotaged both ways: `resync()` moved above the refold, or left out,
  fails `should re-window for the count a new fold came to, where the top row
  stayed` -- at the top the re-anchor writes no offset, so nothing else would
  make the window read the new count, and the spacer below measured forty rows of
  a thirty-row document.
- **The keys follow the scroll box's rules where they overlap.** A scrolling key
  is claimed only where the document is longer than the window, so a document
  that fits hands Space on, and is claimed even where the move is zero, so `g` at
  the top is still the pager's. A page is the window less a row -- the scroll
  box's own rule, and one line more than `less` keeps. `d` and `u` are half a
  window. Ctrl and Alt chords are left alone, so `ctrl+d` is the app's. `q` is
  claimed only where there is an `onQuit`, so an element in a bigger app lets `q`
  reach the app. Escape clears a search and is not claimed with none to clear.
  While a query is being typed every printable key is the field's, pager letters
  included, and a key the field has no use for -- Tab, a chord -- is left to
  bubble. An empty Enter repeats the last search; Backspace on an empty field
  leaves it.
- **`describe(router)` lists the keys rather than binding them.** They are an
  `onKey`'s, so they are described with `scope` set to the pager, and the key-help
  footer lists them while the pager holds the focus -- the SIG-166 mechanism as it
  was built. The descriptions go through `__` because the component writes them;
  `q` is listed only with an `onQuit`, and Left/Right only with `wrap: false`.
- **A match is reversed, and the current one is the accent reversed.** The seventh
  declared exception to the role rule in `theme/index.ts`, and the same
  declaration as the caret and the badge: standout is what a search highlight has
  been since more(1), and it reads on any background. When it was written no role
  was a reversal; since SIG-278 `.sigil-focus` is one, and a match is still not on
  it, because a match is not the focus and a theme restyling the focus must not
  move every highlight in a pager. The current match adds `.sigil-accent`, so a theme moves it by restyling the accent.
  A highlight that would split a grapheme cluster is widened to whole clusters,
  for the reason `highlightRuns()` gives: a lone combining mark is not drawn.
- **Escape sequences in the input are stripped, not drawn.** Carrying an input's
  own colour through means turning SGR into styled runs, which is a second
  renderer inside one component. Tabs go to the next stop of eight, measured in
  columns, and every other control character is dropped by the rule a `text`
  element already applies. One trailing newline ends the last line rather than
  adding an empty one.
- **`page()` writes the document straight through where either side is not a
  terminal.** Unchanged, escape sequences included, which is what `less` does when
  its output is piped -- the reader is somebody's `grep`, and what they want is the
  text. On a terminal it takes the alternate screen and gives it back on `q` or
  Ctrl-C, both of which **resolve**: leaving is the only thing either can mean, so
  there is no cancel for a caller to tell apart. The mouse is **off** unless asked
  for, because a terminal reporting the mouse stops doing its own selection and
  copying a line out is half of what a pager is for; `less` asks for `--mouse`
  for the same reason. The facade builds its own router rather than taking one,
  since the router's root has to be the tree the pager is in.
- **Twenty-two sabotages, twenty-two caught.** Each named test was broken against
  its code and failed alone or with its neighbours: the zero-length rule, the
  compile guard, the mid-match catch, the literal escaping, smart case and its
  escape skip, the cap, the re-anchor, the refold redraw, `n` from where the reader
  is, the reveal-only-off-screen and first-row rules, the cluster snap, the
  claim-only-where-it-scrolls rule, `q` without `onQuit`, a key the field does not
  want, the page size, the trailing newline, tabs by column, a straddling wide
  character, and the piped write.
- **Not done:** carrying the input's colour through; incremental search; `-F`
  (quit when it fits on one screen); a follow mode that tails a growing input --
  the content is read once, which is now the whole of the reason: the count that
  grows while nobody scrolls is `resync()` since SIG-209, so what is left is a
  `content` that can be appended to, and that is the pager's own API; marks; `&` to
  filter to matching lines; a horizontal scrollbar for `wrap: false`.

### A tree: `tree()`, `selectTree()` and `directoryTree()`

`src/components/tree.ts`. SIG-182. What Lip Gloss's `tree` prints and what
Textual's `Tree` and `DirectoryTree` are: nested data drawn with `├──` and `└──`,
a prompt that opens and closes branches whose children may be read on demand, and
that prompt over a directory.

- **Both halves shipped in one change, because the interactive one is a list
  prompt.** The ticket asked whether to ship the static form first and file the
  interactive one separately. It did not need to be: a tree you pick from is rows
  rebuilt per draw for a window, a cursor, and keys -- `runPrompt()`,
  `listWindow()` and `promptRowCap()`, exactly the machinery `filePicker()` and
  `selectRow()` stand on -- and the directory half is `entryCache()` and
  `candidatesOf()` from `path.ts`. Nothing below the components layer moved. What
  the ticket called "a widget with focus" is a prompt here, as every interactive
  list in this directory is; a focusable element in a full-screen app is a
  different shape, and an app that has one builds it from `treeView()` and its
  own `onKey`.
- **"Rounded" and "plain" are guides, not enumerators, and `enumerator` is
  `outline()`'s, unchanged.** The second open question asked for enumerator styles
  shared with the list ticket. In `outline()`'s vocabulary an enumerator is what
  numbers or bullets an item; the lines a tree draws between items are another
  thing, and calling both `enumerator` would make one option name mean two things
  on two sibling components. So the lines are `guide: 'plain' | 'rounded'`, and
  `enumerator` is the same type with the same names, the same `(info) => string`,
  the same cycling by depth and the same right-alignment, drawn after the guide:
  `├── 1. Install`. It is shared by **code**, not by copy: `outlineMarkers()` and
  `outlineEntries()` are exported from `outline.ts` and put on the barrel for the
  registry's reason (an ejected `tree.ts` imports them through
  `@ttylabs/sigil/components`), so a tree refuses a malformed item with
  `outline()`'s words and numbers a list the way `outline()` does. Lip Gloss
  shares one `Enumerator` type between the two and lets a tree draw `I.` in place
  of `├──`; that is why its list and tree can be mixed and also why a tree drawn
  with a list's enumerator has continuation lines that no longer line up, and it
  was not copied.
- **The items are `outline()`'s, so one value prints either way.** A string, or
  `{ text, items }`. A list starts at the margin; one object is a root, drawn bare
  on its own line with its children hung from the margin -- Lip Gloss's
  `Root()`. `selectTree()` reads the same shape and adds what a prompt needs:
  `value`, `expanded`, and `items` as a function.
- **The static tree is laid out line by line, not as nested boxes, which is the one
  way it parts from `outline()`.** A guide is a column beside an item _and
  everything under it_ that has to turn into `└──` at the last sibling, and a box
  beside a body of unknown height cannot be told where. So each item's text is
  wrapped with `wrap()` to the room its guide leaves, and every line after the
  first carries that item's guide on down -- `│   ` where siblings follow, spaces
  where none do. Escape sequences are dropped from the text, by `outline()`'s
  reader, for `outline()`'s reason.
- **The runs of a line are `white-space: nowrap`, not `pre`.** A guide below the
  last sibling is all spaces, and measured: a `pre` text of `'│   '` beside `'x'`
  renders `│x`, while `nowrap` keeps the four columns. The line is already wrapped,
  so `nowrap` loses nothing. That was `pre` read as `normal`, fixed in SIG-207:
  the two now measure alike, and `nowrap` is kept because it was never wrong.
  See `white-space` in [`src/element/AGENTS.md`](../element/AGENTS.md).
- **Right opens, and on an open branch steps in; Left closes, and on anything
  else steps out.** Textual's and every file manager's tree. Space toggles. Enter
  answers with the highlighted node's `value` -- a branch included, because a tree
  of categories is often asked for a category -- and `leaves: true` makes Enter
  open and close a branch instead, which is what a file picker wants and what
  `directoryTree()` sets unless it is asked for a directory.
- **It draws the SIG-205 key footer, and what it lists follows the highlight.**
  It was written beside that ticket with a hand-written `(enter to pick)` beside
  the question, which is one of the hints SIG-205 retired, so it took the footer
  when the two met rather than bringing the key back. Enter is `pick`, or
  `toggle` on a branch under `leaves`, where picking is not what it does; Space
  is listed only on a branch, since on a leaf it does nothing, and folds with
  Enter as `space/enter toggle` when both toggle. The arrows are answered and not
  listed, by the rule every list prompt keeps -- Left and Right included, which
  is what every file manager's tree does with them. The keys are a `promptKeys()`
  table rather than a chain of `k.name` tests, so they are matched modifiers and
  all, and Left is still the one key that does not wait for an open branch to be
  read. The window is one row shorter for the footer, which moved the window test
  by exactly that row.
- **A function for `items` is called the first time its branch opens, and what it
  returns is kept.** Collapsing and reopening does not call it again, which is
  `entryCache()`'s once-per-directory rule and its price: something added after the
  read is not seen. It is called through a `then`, so a function that throws before
  returning a promise is a rejection like any other. A rejection closes the branch,
  shows the message under the question, and is **not** kept: the next Right calls
  it again, because a branch that failed once (a permission, a network) is the one
  most worth retrying, and a cached failure would leave it closed for good.
- **Keys that move or answer wait for an open branch on screen to be read; Left
  does not.** `filePicker()`'s rule carried over. A Right and a Down typed together
  land on the first child of what Right opened rather than on the next sibling,
  because the children are what the Down implied; and Left is the key that gets
  away from a read that has stalled, so it never waits. A branch closed while its
  read is in flight is not waited for -- its children would not be on screen --
  so closing a stalled branch is a way out rather than a way to wedge every later
  key. `should not hold Left behind a branch that is slow to read` and `should land
  a Down typed behind a Right on the first child of what it opened` are the two
  checks; awaiting before Left fails the first and not awaiting fails the second.
  An open branch still being read is drawn with a trailing `…`.
- **The highlight is a node, not an index.** A read landing above the cursor, or
  a branch opening above it, moves rows; the cursor stays on the thing it was on.
  When what it was on is no longer on screen it falls to the first row.
- **A branch is a node with `items`, even an empty array.** It draws `▸`, opens to
  nothing, and is still a branch -- an empty directory is a directory. A node with
  no `items` is a leaf and draws two spaces where the toggle would be, so leaf and
  branch text line up.
- **A hand-built window rather than a `ScrollBox`**, for `filePicker()`'s reason:
  the rows change wholesale as branches open, so no row stays attached to a node,
  and a prompt is not mounted in a full-screen canvas.
- **`directoryTree()` is `selectTree()` and nothing else.** A root node, open, whose
  `items` is a function that loads the directory through `entryCache()` and filters
  it through `candidatesOf()` -- so `directory`, `extensions` and `hidden` mean what
  they mean in `path()` and `filePicker()`, directories come first, and a directory
  that cannot be read has nothing in it. Each directory is read only when it
  opens, which a test pins by watching `readdir`. The root row is the root's own
  name and the answer is an absolute path; in `directory` mode the root is a row
  like any other, so the directory you started in can be the answer.
- **Not done:** a `.` key to show dotfiles while open (it would mean refiltering
  every directory already read); a live `createTree()` (`outline()` has one because
  its ticket asked for one; this one did not); several answers; typing to filter;
  a guide style past `plain` and `rounded`, which is one more row in a table.

### A scroll box heard from outside: `onScroll`, `onResize` and `resync()`

`src/components/scroll-box.ts`. SIG-209. A component built on a `ScrollBox` used
to hear it by wrapping the viewport's own `Element.onScroll` and
`Element.onResize`, knowing the order inside them, and finding the viewport
through `scrollViewport()`. The pager was the first such component and did all
three. The public surface that replaced it is two props and one lookup:

```js
const rows = { count: lines.length, height: 1, row };
const host = ScrollBox({ onResize, onScroll, props, rows });
const { resync, viewport } = scrollControl(host);
```

- **The scroll hook is an option, one function, and not a subscription.** The
  ticket's first question. An option is the house rule -- every hook here is one
  function, declared by whoever built the thing -- and a subscription on a handle
  would bring a list, an order between its entries, and an unsubscribe for a box
  that usually lives as long as the app. What the option gives up is a component
  that hears a box **somebody else** built and declared, and there is none: the
  pager and the debug overlay both build their own. A component that takes a
  caller's `ScrollBoxProps` and builds the box composes the caller's `onScroll`
  with its own before building, which is composing a function it was handed
  rather than wrapping a hook it found on an element -- and it never needs to know
  which element hook carries it.
- **`onResize` came with it, because the pager could not stop wrapping without
  one.** The ticket asked for a scroll hook and a re-sync, and the pager's resize
  wrap was the half that refolds at a new width. Without a public resize hook the
  pager would have had to keep wrapping `viewport.onResize`, or put a hook on an
  element whose size merely _usually_ moves with the viewport's -- an inference
  about geometry standing in for a contract. It is `ResizeHandler`'s shape passed
  on, return value included: it says whether it changed the tree, because a frame
  lays out again before it paints only where something said so. Measured: a
  handler that edits a label on a width-only resize, where the window has nothing
  to report, leaves the label at the box of the layout before it when its answer
  is dropped.
- **Both hooks run after the window, and that order lives in one place.** The
  viewport's two element hooks are the box's, installed by `ScrollBox()`, and each
  runs the window's `sync()` first and the caller's hook after it. So what a hook
  reads -- which rows are built, the spacers, the offset, the viewport's size --
  is the state that will be laid out. `onResize` running _before_ the sync was the
  other candidate, because then a hook that changes `count` would need no
  `resync()`; it was refused because it splits the two hooks' timing in two, and
  makes "before the box re-windows" a contract a second party has to know --
  which is the very thing the ticket is about. After, uniformly, and a count that
  moved is said with `resync()`. What that costs is one window computed for the
  old count on a width that changed the fold, which is a viewport of rows on a
  terminal resize. The caller's hook is called whatever the sync answered, and the
  two answers are OR-ed: `settleResized()`'s own rule, one level down, that a
  handler being told its box moved is not skipped because another said yes.
- **Every writer of the offset reaches `onScroll`, on a `children` box as well as
  a `rows` one.** It is reached through `Element.onScroll`, which `scrollTo()`
  dispatches and `scrollTo()` is the only writer there is -- so the keys, the
  wheel, a click on the track, a dragged thumb, `scrollIntoView()` and an app's
  own `scrollTo()` and `scrollBy()` all arrive. `should hear every writer of the
  offset` drives a key, a wheel notch, a click on the track, `scrollIntoView()`,
  `scrollBy()` and `scrollTo()` on both shapes, and asks for exactly one call per
  write, carrying the new offset, and none for a write that moved nothing. A `children` box installs the
  element hooks only where a prop asks for them, so a plain one is still not
  collected by `arrange()` at all.
- **The re-sync is a method, not an effect over `count`.** The second question.
  `sync()` is arithmetic over four numbers that runs inside `scrollTo()` and inside
  a frame's resize pass, and both of those are synchronous on purpose: the window
  the frame arranges is the window the offset asked for. A signal dependency in
  it would add a third schedule that is neither, and it would only ever notice a
  count that somebody kept in a signal -- neither caller here does: the pager's
  count is a getter over an array, and the overlay's ring has a version number.
  An app whose count is a signal writes `createEffect(() => { count.get();
  control.resync(); })` in its own graph, which is one line. `resync()` returns
  whether the window changed, which is what an `onResize` that called it adds to
  its own answer, and goes through the same unchanged-window guard as the hooks --
  so a call per appended log line is a `rowWindow()` until the line lands in view.
  On a `children` box it is a no-op that answers `false`.
- **`scrollControl()` replaced `scrollViewport()`, and the lookup did not grow a
  sibling.** `{ resync, viewport }`, frozen, from the same `WeakMap` and for the
  same reason the map exists -- a lookup by class is one a stylesheet could
  break. Retired rather than kept beside it, because two lookups over one map are
  two answers to "what does a component built on a scroll box hold", and the
  first one is `control.viewport`. **It never reached a release**: it landed in
  #234, after `0.0.1`, the only version published, so no ejected `pager.ts` from a
  release imports it -- one ejected from `main` in between would, and its import
  fails loudly at load rather than quietly at run time. The control is handed to
  both hooks as well, so one hook can answer for several boxes without a closure
  per box, which is why `Element`'s hooks are handed the element.
- **A hook that is not a function is refused where the box is built.** A string
  `onScroll` would otherwise throw from inside somebody's `scrollTo()`, naming
  nothing the caller wrote, at the first scroll -- which for a list nobody touches
  is never.
- **A scroll of the same box from inside its own `onScroll` is written and not
  dispatched**, which is `Element.scrollTo()`'s latch passed on unchanged rather
  than worked around: the latch is what bounds the recursion. A hook that moves
  its own box calls `resync()` after it, and the prop says so.
- **The debug overlay still holds its ring as children**, now for cost rather than
  capability; the entry under "A debug overlay" says what switching would take.
  `demos/element/09-virtual.js` is the caller this ticket's own mechanism needed:
  `+` adds a thousand rows while nothing scrolls, and `resync()` is the whole of
  what the demo does about it.
- **Twelve sabotages, twelve caught, each type-checking.** A `children` box
  installing no `onScroll`; the wheel skipping the element hook; `resync()` a
  no-op; the caller's `onResize` before the sync, and its `onScroll`; the
  caller's resize answer dropped; the type check on a hook removed; the pager's
  `resync()` moved above the refold, and left out; the pager's scroll-time prune
  and status redraw each removed; and the caller's `onResize` skipped where the
  sync said yes.

### Going back a step: `value` on every prompt, and Escape in a group

SIG-204. `group()` goes back a step on Escape. The work was not in `group()`: going
back means asking a question again with its answer already given, and there was no
one way to say "start from this answer" to a prompt. Every value-answering prompt
takes a `value` now, `run()` reads a `back` option, and a step is handed both.

- **One option on every prompt, named `value`, typed as the prompt's answer.** The
  alternative was each prompt's own existing option, with `group()` knowing the
  mapping -- `default` for `text()`, an index `initial` for `select()`, `selected`
  per choice for `multiselect()`. Refused because `group()` never sees the prompt:
  a step is an arbitrary function, so the only thing a group can hand it is
  something the step passes on, and that only works if one spelling means the
  same thing to whichever prompt the step asks. An app that runs its own loop
  needs the same thing. `value` is it: `text({ ...step })` and
  `select({ ...step })` read it the same way.
- **Not `initial`, because `initial` already means two things.** It is an index on
  `select()`, `multiselect()`, `sort()` and `selectRow()`, and the starting text or
  state on `multiline()`, `number()`, `date()`, `pickDate()`, `list()`,
  `maskedText()`, `path()`, `toggle()` and `autocomplete()` (where it is filter
  text, not the answer). Making it uniform would have changed the index ones to
  take a value, which on a `select<number>()` cannot be told apart at runtime: an
  app passing `initial: 2` as an index would silently start on the choice whose
  value is 2. `initial` and `selected` keep what they meant, and `value` beats
  them. Where `initial` already was the answer (number, date, toggle, ...) the two
  overlap, and that redundancy is the cost of not breaking the index ones. `value`
  follows the HTML control's attribute, and on a choice list it lines up with
  `Choice.value`: the option names the choice by what it answers with. No option
  was renamed and no existing option changed meaning, so nothing breaks.
- **A choice is found by `promptSameValue()`, which compares the way a `Map`
  compares keys.** That is how `autocompleteMultiselect()` already told ticks
  apart, so it is the existing rule rather than a new one. Objects match only
  themselves, so a step that builds fresh choice objects every time it runs has
  answers that cannot be found again. Deep equality was not added: the answer
  already holds whatever the caller put in `value`, and a primitive or a stable
  object is how to make it findable. `selectRow()` finds its row by identity for
  the same reason.
- **A `value` the prompt cannot show is dropped, not refused, and that differs
  from `initial` on purpose.** `list()` and `maskedText()` refuse an `initial` that
  does not round-trip or fit, `toggle()` refuses a non-boolean, and `number()`
  refuses a fraction without `float`. A `value` falls back to what the prompt
  would have opened on in all of those cases, and on a choice list when no choice
  on offer holds it (a disabled one does not count). An `initial` is something
  somebody wrote, so a bad one is a bug. A `value` is usually an earlier answer to
  a question that has changed since, so a bad one is the expected case when going
  back, and refusing it would make Escape throw. The one thing still refused is an
  `initial` that is itself wrong (`selectKey()`'s `initial` naming no key), even
  beside a `value` that is fine.
- **What each prompt does with it.** Fields open holding it with the caret at the
  end (`text()` flattens a line break the way a paste is flattened). `confirm()`
  reads it as what Enter alone means, so on that prompt it is `default` under a
  second name. On the multiselects it replaces every `selected`, and `[]` means
  nothing is ticked. `sort()` puts the rows it names first, in its order, and the
  rest after them in theirs, so a row added since the last answer lands last and a
  pinned row stays put. `selectKey()` makes it the choice Enter takes.
  `editor()` opens the file holding it, ahead of `default`.
  `selectTree()` highlights the node and opens the branches above it, but reads no
  lazy branch to look for it, so a node under an unread branch is found only once
  something opens that branch. `directoryTree()` opens the directories on the
  path, because the path says which ones they are. A key typed before those reads
  land waits for them, the value is placed, and only then does the key act, which
  is `filePicker()`'s rule. The first version dropped the value on any key and
  acted on the row the key arrived on, so an Enter typed early closed the root
  and the prompt never answered: the timeout CI hit on Windows and on one Ubuntu
  job. Left waits for nothing, so it drops the value at once. After any key has
  acted, a read that turns up the value later does not move the cursor. `filePicker()` opens in the
  directory that holds the value and goes back to `root` if that directory no
  longer has it, and `confine` applies. `autocomplete()` highlights it in the
  first list it offers. On a source, `autocompleteMultiselect()` ticks values it
  has never been shown, labelled by `String()` until the source returns the
  choice that holds them. Otherwise the answer would lose ticks nobody removed.
- **`commandPalette()` takes neither option, and the types say so.** It is not
  asked for a value: it dispatches, and Escape already dismisses it.
  `PaletteOptions` omits `back`. If it did not, `run()` would take Escape before
  the palette could dismiss.
- **The back key is Escape, and only for a prompt asked with `back: true`.**
  Shift-Tab is the usual "previous field" key, and it was the obvious candidate.
  `date()` uses it to go back a segment and `toggle()` uses it to flip, so taking
  it would have cost two prompts a key whenever they ran in a group. A chord, such
  as Ctrl-B, is a key nobody would try. No prompt reads Escape ("Escape does
  nothing in any prompt here"), so taking it costs nothing. "Close this and return
  to where I was" is also what Escape already means to the palette and the pager.
  The earlier decision stands everywhere `back` is not set: a lone prompt still
  ignores Escape, autocomplete still does not answer `undefined`, and sort still
  does not put a carried row back. Inside a group, Escape while carrying a row
  goes back a step and drops the carry.
- **`run()` takes it, before the prompt's own keys, the way Ctrl-C is taken.** It
  does not wait in the one-key queue, since giving up needs nothing from the
  state. It matches only a bare Escape, because Alt-x arrives as `ESC x`. In
  `multiline()` with an Alt-Enter submit, Escape and then Enter pressed more than
  `ESCAPE_TIMEOUT` apart is now a back and then a newline. That case is accepted:
  it only arises in a group, and the Alt-Enter spelling still submits.
- **It rejects with `PromptBack`, which is not a `PromptError`.** The person has
  not left and the program is not miswired, which are the two things
  `PromptError` reports. A `catch` that reads every `PromptError` as "give up"
  must not swallow a back, so `isCancel()` is false for it. `isBack()` sits beside
  `isCancel()` for an app's own loop. Resolving with a sentinel was refused for
  the reason SIG-160 refused one for cancel: it changes every prompt's return
  type.
- **It is listed where a footer is drawn, from the same flag `run()` reads.**
  `promptFooter(keys, columns, back)` appends `esc back` at priority 1, so it is
  dropped before Space and Enter. It is added to what the footer reads rather than
  registered in the key table, because a table entry would be a handler that can
  never run, since `run()` takes Escape first. `text()`, `select()` and
  `confirm()` draw no footer, so nothing there names the key. The README says to
  mention it, and growing a footer under every question was SIG-205's call and is
  not reopened here.
- **A step is handed `(answers, step)`, and `step` is prompt options.** It is
  `{ back?: true, value?: T[K] }`, frozen, and each key is present only when it
  says something. That makes the spread safe on either side:
  `{ value: suggestion, ...step }` opens on the suggestion the first time and on
  the earlier answer after that, where an `undefined` would have overwritten the
  suggestion. `back` is absent on the first step, so Escape there does nothing. A
  `PromptBack` from the first step can only come from a step that asked for `back`
  on its own; it is rethrown untouched as a bug, rather than re-asked, which could
  loop forever. Making the answers argument `Partial<T>` so a step could read its
  own key was the alternative. It was refused because it mixes "an answer" with
  "what I said last time", and the type test that a step cannot read its own
  answer still holds.
- **The dependent-answer rule: going back never skips a step on the way forward,
  and an old answer is a suggestion, never an answer.** After going back from
  step k to step j, every step from j to k is asked again, each handed what it
  last answered as `value`. `answers` holds only the steps before the one being
  asked, so a re-asked step never sees an answer given after it. Two
  alternatives were refused:
  - Keeping later answers that "still hold", so forward skips them. `group()`
    cannot tell which steps read the answer that changed, and keeping one that
    did returns an answer the person never confirmed against the new earlier one.
  - Clearing later answers. That throws away work on every step that did not
    depend on the change.

  A suggestion that still holds costs one Enter. One that no longer does is
  dropped by the prompt: a list that lost the choice, a mask that changed. A
  step that knows its old answer means nothing now has both answers in hand and
  can leave `value` out. Only answers are remembered: a step left with Escape
  before it was answered has nothing to show when it comes back. `onCancel` is
  handed the answers that stand, without any unanswered step's old answer.

- **A step that answers without asking makes Escape look stuck.** Going back to
  it re-runs it, it answers at once, and the step that pressed Escape is asked
  again. `group()` cannot tell a step that prompted from one that computed.
  Detecting whether the step read `back` from what it was handed would be magic.
  Put a computed value inside the step that uses it.
- **The screen is a transcript.** The question being left is erased by `stop()`,
  as on a cancel. The earlier step's settled line stays, and the re-asked
  question is drawn below it. Erasing upward is not done: the region gave those
  rows back at `done()`, nothing records how many there were, and a log line or a
  spinner may have written below them since.
- **How it is pinned.** `test/components/prompt-value.test.ts` has three tables
  over all 23 prompts (`editor()`, SIG-171, is the 23rd): answers with `value` on the submit key alone (each `value`
  is chosen so that it is not where the prompt would have opened anyway), rejects
  with a `PromptBack` on Escape when given `back` and leaves an empty screen, and
  ignores Escape without it. Further cases cover the drop rule per prompt, the
  footer listing, Alt-x and Shift-Tab not being Escape, and the types.
  `test/components/group.test.ts` has the back step, the dependent-answer rule
  with a scripted step, a real `text`/`select`/`confirm` flow driven with Escape,
  and the type of `step`. `demos/components/42-group-back.js` changes the first
  answer, so the second list drops an old answer it no longer offers.

### An editor prompt: `editor()`, and handing the terminal to another program

SIG-171. `src/components/editor.ts`, `test/components/editor.test.ts`, and
`demos/components/44-editor.js`. Inquirer's `editor`, and the shape `git commit`
has: a temporary file, `$VISUAL` or `$EDITOR` opened on it, and the saved text as
the answer.

- **The editor is `editor`, `$VISUAL`, `$EDITOR`, then `vi` -- `notepad` on
  Windows -- and only the last goes through `which()`.** The two variables are the
  user's statement of what to run and are run as written; the platform default is
  a guess nobody made, so it is offered only if `which()` finds it, and with no
  variable and no `vi` the prompt rejects naming the two variables **before
  anything is drawn** -- asking somebody to press Enter to open nothing is the
  wrong order. `vi` because POSIX requires it and it is git's default for that
  reason; `notepad` because Windows has no terminal editor that is always there,
  and it is what Inquirer's `external-editor` falls back to. A blank variable is
  unset, the rule the parser keeps for an environment value. `editor` is there for
  an app with its own setting, which is git's `core.editor`. `resolveEditor(env)` is
  exported so a caller can ask before prompting; the platform is read per call and
  not taken as an argument, which is `which()`'s own rule and why a test forces it
  with the same `defineProperty` seam `which.test.ts` uses.
- **`$EDITOR` is a shell command, so the shell splits it.** `code --wait`, `vim -u
  NONE` and `"/Applications/My Editor.app/bin/edit" -w` are all ordinary values,
  and a tokenizer here would be a second, worse shell -- Inquirer's splits on
  whitespace and breaks the third. git's reading is the precedent: on POSIX it is
  `sh -c '<editor> "$@"' <editor> <file>`, so the file goes in as `$1` and needs no
  quoting at all, whatever the temp directory is called. On Windows it is
  `cmd.exe` through `spawn(..., { shell: true })`, with the file double-quoted into
  the line -- a Windows path cannot hold a `"` -- and the shell is not optional
  there: `code` is `code.cmd`, and node refuses to spawn a `.cmd` without one since
  CVE-2024-27980. A tmp path holding `%` would be expanded by `cmd.exe`; that is
  left, since no default temp directory has one. `should be made under the temp
  directory even when its path holds a space` and `should start the file from
  default, and hand the editor one argument` pin that the editor gets exactly one
  argument for the file on both shells.
- **The terminal is given up by ending the prompt, not by suspending it.** Each
  attempt is a whole `runPrompt()`: Enter _answers_ it, and its teardown -- the
  router stopped, stdin paused with its `data` listener gone, raw mode and the
  paste markers off, the claim released and the cursor shown -- is the teardown
  every answer gets, so nothing is a second implementation of it. The question is
  then drawn again from scratch for a retry, or a one-frame mount leaves the
  answered line. The alternative was a suspend and resume on the live region and
  the router, and it would have to stop a resize handler, the frame pacing and
  every effect from painting over another program's screen; none of that exists
  to stop if the region is gone. A pty probe confirmed the part a test cannot: a
  paused stdin with no listener does not take a byte from an inherited child, and
  vim, a cooked-mode line editor and the next prompt after it all read their keys.
  `should give the terminal up while the editor is open, and take it back after`
  holds the fake editor open and asserts raw mode off, no `data` listener, stdin
  paused, the cursor shown and the SIGINT listener added, then all of it put back.
- **A borrowed `router` is refused**, in the type (`Omit`) and at run time. It is
  the app's and stays running, and a running router reads stdin -- the editor would
  get every other key. The prompt cannot pause it, because a router has no pause:
  that is the suspend this entry declines to build.
- **A line is left on screen while the editor is open, and erased after.** `?
  Commit message Waiting for your editor to close the file…`, because an editor
  that opens a window (`code --wait`) leaves this terminal showing, and a question
  that vanished there is a program that looks hung -- which is git's `hint:
  Waiting for your editor` for the same reason. It is the prompt's own settled
  frame, and its height is worked out from the widths the head is drawn at, so the
  erase walks up exactly what was drawn: `should erase exactly the waiting line, at
  a width that wraps it` writes a line above, wraps the waiting line to four rows,
  and asserts the line above survives. It is erased after a clean exit and after a
  cancel, and **left after a failure**, since a failed editor has usually printed
  why under it and the screen is the only record. A resize while the editor is
  open leaves it too, for the live region's stale-frame reason: rows may linger
  rather than an erase guessing at them. What it cannot know is whether the editor
  used the alternate screen; one that printed lines and did not -- `ed`, or the
  cooked-mode stand-in in the pty probe -- has its last lines erased instead and the
  waiting line kept, which is git's caveat too. The hint and the line say "your
  editor" rather than the command, which is a path and flags and would be half a
  line beside the question; the errors do name it.
- **The temp file is `edit<postfix>` in a `mkdtemp()` directory that exists for one
  run of the editor and no longer.** A directory, because it is private to the
  user and cannot be raced the way a predictable name in a shared temp directory
  can, and because removing it takes the editor's litter too -- vim writes its
  `.swp` and a `~` backup beside the file. One run, because then no path that does
  not open an editor has anything to clean: a Ctrl-C at the question, an abort
  before Enter and a refusal never make one, and a validation retry writes a fresh
  directory from the text held in memory. The file is `0o600`, since an answer may
  be a secret. `postfix` defaults to `.txt` and is refused if it holds a separator
  or a control character, because it is joined into a path inside that directory.
  It is also refused if it holds a `"`, `%` or `!`, on every platform. On Windows
  the path is double-quoted into a `cmd.exe` line, and inside those quotes a `"`
  closes them, so `" & calc & ".md` ran a program. A `%` expands, so `%TEMP%.md`
  named a file nobody wrote, and so does a `!` where delayed expansion is on. Not
  on Windows alone, for the reason `\` is refused on POSIX: a postfix is the
  app's constant, and one that breaks only on the platform its author is not on
  is the case the rule exists for. That is also why the test needs no platform
  seam, since the refusal comes before anything reads the platform. What it does
  not cover is a `%` in the temp directory's own path, which comes from `TEMP`
  rather than from the app.
- **Every exit path removes it, and SIGINT is the editor's.** The removal is a
  `finally` around the spawn, which covers an answer, an editor that exits
  non-zero, one killed by a signal, and a spawn that fails. **SIGINT is ignored for
  the life of the editor**, which is git's rule: Ctrl-C reaches the whole
  foreground group, so behind a window-opening editor it would kill this process,
  orphan the editor and leave the file. The editor decides what Ctrl-C means, and
  an editor that dies of it -- by the signal, or exit 130, which is how `sh` reports
  one, or `STATUS_CONTROL_C_EXIT` on Windows -- is a **cancel**, `aborted: true`,
  measured on a pty with the line erased and the directory gone. A terminal editor
  in raw mode never sees a SIGINT at all. `exit` removes it for a `process.exit()`
  from anywhere, and SIGHUP and SIGTERM remove it and then stand down the way the
  terminal's restore handler does: listeners off, and the signal raised again if
  nothing else is listening, because a CLI that stopped dying on SIGTERM while a
  prompt was open is worse than a file left in `/tmp`. What is not covered is a
  signal with no listener -- SIGKILL, or an app's own SIGINT handler that calls
  `process.exit()`, which `exit` does catch but which leaves the editor running.
  The tests call the added `exit` and `SIGTERM` listeners directly rather than
  emitting the events, which would run the test runner's own.
- **An editor that exits non-zero rejects; it does not ask again.** `{0} exited with
  code {1}` or `{0} was stopped by {1}`, a `PromptError` with `aborted: false`.
  `:cq` is how vim abandons an edit and git aborts the commit on it, and a
  misconfigured `$EDITOR` would otherwise loop on Enter forever. A failing
  `validate` is the one thing that asks again, under the reason, and the editor
  reopens on what was saved byte for byte.
- **`default` is what the file starts with, not a fallback for an empty answer.**
  The ticket names it `default` and Inquirer means this by it. An editor shows the
  file, so the default is visible and editable rather than implied, and an empty
  file is how somebody answers "nothing" -- `''`, never the default back.
  `multiline()` calls the same idea `initial` and refuses `default` for its own
  reason. SIG-204 then gave every prompt a `value`, and here it beats `default` the
  way it beats `initial` there: the file opens holding it, so a step `group()`
  re-asks opens on the answer it was given. A `value` that is not a string is
  dropped, as on every prompt. `back` needed no code: `ask()` hands the options to
  `runPrompt()`, which takes Escape before the prompt's own keys. It applies only
  at the question, since while the editor is open Escape is the editor's, and the
  temporary file does not exist yet at that point, so going back leaves nothing to
  remove. Both are pinned by the shared tables in `prompt-value.test.ts`, which
  run `editor()` with a command that exits without touching the file.
- **The answer has a BOM, CRLF and one trailing line break taken off.** Those are
  how an editor encodes a file rather than what was written -- Notepad has written
  the first two, vim adds the third to every file and Notepad does not -- so an
  untouched default answers the same string on every platform. Further blank lines
  were typed and stay. The default is written verbatim.
- **An abort is honoured when the editor closes, not while it is open.** The signal
  rejects before Enter the way it does for every prompt. Once the editor has the
  terminal, killing it could leave the screen in the alternate buffer and the tty
  in raw mode -- the rule is that a CLI must never take the terminal down with it,
  and that holds for a child it spawned -- and through `sh -c` a kill may not reach
  the editor anyway. So it waits, then rejects with the reason and drops the edit.
- **No footer.** One key, Enter, named in the hint beside the question: the
  `confirm()` argument from "The built-in prompts draw the footer", since a footer
  under a one-line question would double its height. The answered line is the
  question and the answer's first line, through `promptSummary()` -- extracted from
  `multiline()` so the two prompts that answer several lines summarize them one way.
- **`stdio: 'inherit'`, so the editor gets the process's own fds**, whatever streams
  the terminal object wraps. An app drawing to `/dev/tty` with stdout piped would
  hand the editor a pipe; nothing has asked for that, and the fds of a terminal
  object are not always there to pass.
- **`node:child_process` is asked for when the editor opens, not imported, and
  the signal-name table is built on first use (SIG-328).** This is the one
  module in the barrel that spawns, and the barrel is what every app that draws
  anything loads -- and a loop at module level is a statement no tree-shaker can
  drop, so `sigil build` kept it, and the `node:os` import under it, in an app
  that drew a spinner. `process.getBuiltinModule()` is synchronous, so nothing
  about `editor()` changed shape.
- **Not done.** An `editor` given as an argv array rather than a command; waiting
  out the alternate-screen question; `$VISUAL` skipped on a dumb terminal (git's
  rule, and a prompt does not draw on one anyway); a way to accept the default
  without opening the editor.

### Accessible mode: the prompts as lines in and lines out

SIG-177. `asLines()`, `runLine()` and the six line forms are at the end of
`src/components/prompt.ts`; `test/components/prompt-accessible.test.ts` and
`demos/components/46-accessible.js`. Huh's `WithAccessible(true)` is the shape: a
screen reader reads what is written and cannot follow a region that repaints, so
the question is written once, what is typed is echoed where it is typed, and
nothing already written is moved, erased or coloured.

- **The trigger is `accessible` on the prompt, then `SIGIL_ACCESSIBLE`, and never
  a guess.** There is no reliable way to ask whether a screen reader is listening,
  and a guess that came out wrong would hand a sighted person a numbered list for
  every question. A variable at all, where quiet deliberately has none, because the
  two are statements about different things: quiet is about **one invocation**,
  and argv is where that goes; this is about **the person**, true of every
  invocation of every app they run, which is what a shell profile is for. Asking a
  screen-reader user to type `--accessible` on every command of every app is the
  wrong place for it. Namespaced for `SIGIL_REDUCED_MOTION`'s reason -- no
  cross-tool convention exists -- and read with its vocabulary: `1`, `on`, `yes`,
  `true` and their opposites, an empty value unset, anything else undecided. The
  option beats the variable, the most-specific-source rule every fold here keeps,
  and is read strictly, so `accessible: 'false'` falls through to the variable
  rather than reading as on (the `setQuiet('false')` trap). `forcedAccessible()`
  is exported so an app can ask, which is `forcedMotion()`'s shape.
- **It does not lift the non-TTY rule, and that answers the ticket's "does it work
  over a pipe".** No. The rule is about whether anybody is there to answer, and
  the line form is a different way to draw a question, not a different answer to
  that. Over a pipe it would be worse than hanging: it would read whatever the pipe
  carries as answers, and the variable is exported to every process in a pipeline,
  so `cat notes.txt | mycli init` from a screen-reader user's shell would answer
  every question with a line of `notes.txt`. Huh's accessible mode does read a
  pipe; sigil's answer to scripting a prompt is `value` and a flag, not a stdin of
  answers. Both ends are checked as before, with the same message.
- **Raw mode, not the terminal's own cooked mode, with cooked mode's echo done by
  hand.** Cooked mode is what a screen reader is built against, and it was the
  obvious choice. It cannot hide a password; it sends Ctrl-C as SIGINT, which kills
  the process instead of rejecting with an aborted `PromptError`; and a Ctrl-D at
  the start of a line is end of file, after which node's stdin has ended for good
  and the next prompt has nothing to read. So the router reads keys exactly as it
  does for a drawn prompt -- Ctrl-C a key, Escape for `back`, the paste markers, the
  one-key-at-a-time queue for an async `validate` -- and the line form writes back
  what cooked mode would have: the character where it was typed, and `\b \b` for a
  Backspace, which are the very bytes the kernel's `ECHOE` writes. A wide cluster
  is rubbed out with two of each, by `stringWidth()`.
- **Editing is at the end of the line only, and never past its start.** Left,
  Right, Home, End and Delete do nothing, because an edit in the middle of a line
  that is never redrawn has nowhere to be shown -- which is also what they do in
  cooked mode. Backspace and Ctrl-U erase back to the start of the line being typed
  and no further: in `multiline()` a line already ended is a line already read, and
  going back up a row to erase it would be a redraw. So a `value` a multiline
  opens on can be added to and its last line edited, and that limitation is
  accepted rather than worked around.
- **No glyph, no colour, no sequence but the paste markers.** The `?` mark is
  dropped, because a screen reader reads a glyph aloud by name, and so is every
  role drawn in colour, since a role in colour is one it cannot hear. The cursor is
  never hidden, which a magnifier follows. `should write no escape sequence but the
  paste markers` reads the bytes, which is the precise form of "never redrawn". A
  separator is listed when it has a letter or a digit in it and skipped when it
  does not: the default `separator()` is eight box-drawing characters, read aloud
  one name at a time.
- **And no control character a prompt was handed, through the drawn form's own
  `toDisplayText()`** (SIG-249). The line forms wrote their labels, hints,
  descriptions, defaults, refusals and `Chosen:` lines raw, while the drawn form
  never wrote one: a text element takes the control characters out before it
  measures or paints. So `branch\u001b]0;pwned\u0007name` set the window title as
  a line and drew `branch]0;pwnedname` as a list -- and `path()` and `filePicker()`
  list what `readdir` returned, so a file name was enough. What was typed and
  pasted was already filtered, by `typedText()` and `pastedLine()`; the prompt's
  own strings were not. The fix is **one place in the engine rather than one per
  site**: `runLine()` writes every string through `shown()`, which is
  `toDisplayText()` with the breaks spelled `\r\n`, and writes raw only its own
  bytes, the break that ends a line and Backspace's `\b \b`. The sites the ticket
  named were six, and every line form outside `prompt.ts` -- the tree, the picker,
  the search, the published `runLinePrompt()` an ejected prompt asks with -- writes
  through the same engine, so a per-site fix was a list somebody would have had to
  keep complete. Through the element's function rather than a second sanitizer, so
  the two forms of one question cannot come to disagree about what is safe: what
  a sequence introduced is left as the text it is, `]0;pwned`, in both, which says
  something odd was in the label rather than hiding that it was. **The reply is
  not cleaned**, only what is written of it: a Tab completes the ESC of a real
  file name into the reply, and the answer is that file. Backspace measures what
  was echoed, `stringWidth(toDisplayText(...))`, as the drawn field measures,
  because a tab a multiline `value` keeps measures nothing and is echoed as a
  space -- so it is rubbed out as one column. `test/components/prompt-accessible.test.ts`,
  under `a line form writes no control character a prompt was handed`, reads
  every byte; each of its five fails without the fix.
- **What each prompt is as a line.** The six that existed when the ticket was
  written, and the six `prompt.ts` holds.
  - `text()`: the question, `(default: x)` when there is one -- the key `--help`
    already uses -- and the reply. A refusal writes `validate`'s message on the next
    line and asks again **holding the refused reply**, as the drawn field keeps its
    value, so a typo is a Backspace rather than a retype.
  - `password()` (any `mask`): nothing echoed, the default not said -- read aloud is
    shown to everyone in the room -- and a `value` dropped, since text nobody can
    see is not text anybody should be typing after. A refusal asks afresh.
  - `multiline()`: the question names the submit key the way the drawn footer
    spells it (`keyLabel()`, so `ctrl-d`, translated), and a `charLimit`; the reply
    starts on a line of its own; Enter is a line break and the submit key answers.
    The limit is kept by `fitted()`, the drawn field's own cut. Its option refusals
    -- an empty submit name, a bad `charLimit` -- happen first, before anything is
    written, because they are about the options and not about how they are drawn.
  - `confirm()`: the same `(Y/n)` from the same catalog entry, and a whole reply of
    a key or a word -- `y`, `yes`, the catalog's own `yes` -- so `yellow` is
    refused rather than read as yes. Enter alone is the default.
  - `select()`: the list, numbering only what is on offer so the numbers run without
    a gap and every number can be picked; a disabled choice is listed after a dash
    with its reason, a description indented under its choice. Enter alone takes the
    choice the drawn list would have opened on, so `value` and `initial` mean what
    they meant. Numbers only, not labels: a list of versions labelled `18`, `20`,
    `22` makes a reply of `20` mean two things. `Chosen: Multi` follows, because a
    transcript reading `2` does not say what was chosen.
  - `multiselect()`: the same list, and numbers separated by commas or spaces, with
    ranges. The reply **replaces** the selection rather than toggling it, because a
    list of what is wanted stands on its own, where a toggle means holding the
    current ticks in your head across a transcript. Enter alone keeps what was
    ticked, `none` -- the word the drawn prompt already settles on for an empty
    answer -- answers nothing, and `min`, `max` and `required` refuse with the drawn
    prompt's own messages.
  - `number()` (SIG-227): `text()`'s line, `(default: x)` and all, read on Enter
    by the parser (`transformValue()` as `int` or `number`) and then held to `min`,
    `max` and `validate`, in that order and with the drawn prompt's messages. What
    the drawn field refuses **as it is typed** is refused here **when Enter is
    pressed**, with a sentence, because a keystroke that was echoed and then quietly
    dropped is a character the person heard themselves type that the answer does
    not hold. The grammar is still the drawn field's -- digits, one point with
    `float`, a leading `-` -- so `0x10` is refused as `Invalid integer: 0x10`,
    and `1e3` and `Infinity` with `float`, though the parser reads all three: the
    words are the parser's, the grammar is the field's. A `-` is let through whatever `min` says, so it is the range that
    refuses `-5` and says which bound. Up and Down do not step, for the arrows'
    reason: stepping rewrites the reply where nothing can show it.
  - `list()` (SIG-227): `text()`'s line, read with `splitList()`, so a reply reads
    exactly as the drawn field's line does, and a reply with no entries in it
    answers `default`, which the question says joined. Nothing is said after the
    reply, since `api, web` already says what was answered.
  - `path()` (SIG-227): `text()`'s line, answered through `answerOf()` -- `~`
    expanded, `root` applied -- with `validate` handed that form, so the two forms
    of one question cannot answer it differently. The drawn list changes under
    the field with every keystroke, which is the redraw this form has none of, so
    **completion is a shell's** (SIG-232): Tab adds what every candidate shares
    beyond what was typed and echoes only that, the one candidate in full with a
    separator after a directory; a second Tab running, with nothing more to add,
    writes the candidates indented on lines of their own under the reply -- the
    drawn list's order and labels -- and asks again holding it. At 100 candidates
    or more that second Tab **asks first** (SIG-241), readline's
    `Display all 2000 possibilities?` with `confirm()`'s `(y/N)`, on a line of
    its own, and waits for one key: `y` or Space lists, `n`, Backspace, Delete,
    Escape or Enter lists nothing, and either way the question and the reply are
    written again; any other key is refused with `Answer y or n` and the question
    asked again. A first Tab that
    adds nothing is silent, as readline's is, since asking again is how the list
    is asked for. The candidates are the drawn field's from one `completer()`,
    the read, `root`, `~`, dotfiles and `directory`/`extensions` included, so
    the two forms cannot offer different ones. What it is built on, and the
    choices it made, are under "Tab in a line form" below.
  - `maskedText()` (SIG-227): the template is said once in the question as the
    empty field draws it, `(format: (___) ___-____)`, and **only what is typed is
    echoed**, never the template's fixed characters: a `(` nobody typed is a
    character a screen reader reads out as typed, and a Backspace would then have
    to choose between rubbing out a `)` and a digit. The reply is read the way a
    paste is, fixed characters passed over where they come, so `5551234567` and
    `(555) 123-4567` are one answer; `Entered: (555) 123-4567` follows a reply that
    was not already written that way. A character that fits no slot -- one past
    the last included -- is **refused rather than dropped**, the one place this
    parts from the drawn field: there a refused key changes nothing on screen, and
    here it was echoed, so taking the answer without it answers something other
    than what was heard. `fill()` reports the first such character for the
    message. `initial` and `value` open the reply as the formatted text they fill,
    `(555` for three digits.
  - `toggle()` (SIG-227): `confirm()`'s line with the two names, `(off/on)` in the
    order the switch draws them, and the default **said in words**,
    `(default: off)`, rather than by a capital the way `(Y/n)` marks it: a name in
    capitals is spelled out or shouted. A reply is a whole name, case aside, and
    not a first letter, since `on` and `off` share theirs. Names that differ only
    in case, which the drawn switch allows, are told apart by case alone.
  - `selectKey()` (SIG-227): `select()`'s list lettered by the keys, `o) Overwrite`,
    a disabled choice after a dash, and **a reply of a key, never a label or a
    position**. A label can be another choice's key -- `numbered` gives labels of
    `18` and `20` the keys `1` and `2` -- so the one reply that cannot mean two
    things is the one that answers the drawn prompt. Read whole, trimmed, and
    folded the way a keypress is, so `O` is `o` and `ok` is refused. `Chosen:`
    follows, for `select()`'s reason. **The list is written even with `expand`**:
    `expand` spares a sighted reader a list they know, and a screen-reader user
    has no glance to take the summary in with either. Enter alone takes the choice
    `value` or `initial` names, and is refused where there is none.
  - **The line engine is published with the rest of the prompt plumbing**
    (SIG-227), as `runLinePrompt()`, `promptAsLines()`, `promptLineQuestion()` and
    the `PromptLineForm` type, for `promptKeys()`'s reason: these six are modules
    of their own, and `sigil add` rewrites `./prompt.js` to
    `@ttylabs/sigil/components`, so an ejected `number()` has to find them there.
    `registry.test.ts` fails on the first import that is not published, which is
    how this was found. `runLinePrompt()` is a signal-taking promise and so is in
    `PromptName`; it is exempted from both tables rather than given a row, because
    it takes no `accessible` and is always lines, so it fits neither the drawn run
    nor `LineName` -- and every line-form row is it, asked through a prompt.
  - `selectRow()` (SIG-228): `select()` over the rows, each read as one line of
    `Heading: value` pairs joined with commas -- a row of bare values heard in
    order is values nobody can tell apart -- with an empty cell, or a view with no
    text, left out. No sorting: a digit is a number to choose by, and the rows
    are in the order they came. `Chosen:` uses `short`, or the cells joined as the
    drawn prompt settles.
  - `groupMultiselect()` (SIG-228): `multiselect()` over the choices with each
    group as a heading naming the numbers that are its own, `Frontend (3-5)`.
    Ticking a group is that range, which `multiselect()` already reads, so there
    is no second gesture and no number spent on a heading that is not an answer.
    A group with nothing on offer names no range.
  - `sort()` (SIG-228): the list numbered in its order, and the order wanted
    typed as those numbers, `3 1 2`, by `multiselect()`'s reader, so `3-1` is a
    run reversed. The ones left out follow in the order they are in, which makes
    `4` alone "put the fourth first", the move a carry is most often for. A number
    given twice is refused rather than read as either place; a pinned row is
    listed in place with no number and keeps it. Enter alone keeps the order.
  - `date()` and `pickDate()` (SIG-228): the segments typed whole in the order
    they are drawn, `2024-06-15` or `2024-06-15 13:45` (a `T` is taken too), one
    or two digits for each field but the year. The question names the format as
    a picture (`YYYY-MM-DD HH:MM`), says the range -- the drawn grid dims what is
    outside it, which a line cannot -- and the default, which is where the field
    or cursor would have opened. What a date is stays the parser's `date`
    reader's to say, so `2024-02-30` is refused in its words; `date()` shares one
    `judged()` between the drawn Enter and the line, so the two refuse in the
    same order. `pickDate()` answers at local midnight, as drawn; its `highlight`
    marks a picture and is not said.
  - `selectTree()` and `directoryTree()` (SIG-228): **one level at a time**, not
    the whole tree flattened. Flattening was the ticket's starting point and it
    reads every branch to do it -- every directory under the root, and every
    `items` function the drawn prompt calls only when a branch opens. So a level
    is listed under `In <branch>`, which says the depth an indent would have shown
    and a screen reader would not; a leaf answers, a branch is gone into
    (`(go in)`), and `Back to <parent>` is a number like any other. Without
    `leaves` a branch is an answer too, as `this one` at the top of its own level:
    one number per thing a number does. A branch is read the first time it is
    gone into, through the drawn prompt's `open()`, and a read that fails says why
    and stays put -- not kept, so asking again reads again. Coming back up, Enter
    alone is the branch just left; a starting answer opens on its level.
  - `filePicker()` (SIG-228): the same shape over the drawn picker's own read and
    filter: `In <directory>`, a file answers, a directory is gone into, `..` (up a
    level) is Left and is listed only where Left goes somewhere, so `confine`
    holds. With `directory`, `.` (this directory) is the drawn picker's first row
    and is how a directory is picked, from inside it. `No matches` is said for a
    directory with nothing on offer. The `.` key that shows dotfiles has no line;
    `hidden` still decides.
  - `autocomplete()` (SIG-228): the term typed as a line, then what it matches --
    by the same `rankBy()`, or the same source with the same signal, aborted when
    the next lookup starts and when the prompt ends -- as `select()`'s list with
    `Search again` as its last number, since a number is the reply and the term is
    not on screen to edit. A term that leaves one choice answers with it (said
    back as `Chosen:`); one that leaves none, or a lookup that fails, says so and
    asks again holding the term. `value` is the default of the first list.
  - `autocompleteMultiselect()` (SIG-228): the same term, and `multiselect()`'s
    reply over what it matched, replacing the ticks **among those listed**: a
    choice the term hid keeps its tick, the drawn prompt's rule that ticks belong
    to choices and not to the list. `Chosen:` with everything ticked follows each
    list, then `Search again (Enter alone to finish)`. The first term is not
    asked that way, because Enter alone there is the whole list, which is what
    the drawn prompt opens on.
- **Two are drawn whatever the mode, and each has a reason rather than a gap.**
  `commandPalette()`'s list of commands is a `runPrompt()` of its own, and the
  questions it asks after a pick are `text()`, `select()` and `multiline()`, which
  are lines; `editor()` exists to hand the terminal to another program, which no
  line form can stand in for. The option is on `AccessibleOptions`, which only the
  options interfaces of a prompt with a line form extend, so the types do not offer
  it where it would do nothing; the variable cannot be scoped that way and is
  ignored by those two, which the README says. Refusing them would be worse: an app
  the person cannot use at all, over a preference they set to make apps usable.
- **The screen model learned Backspace.** `src/testing/screen.ts` took `\b` as a
  zero-width control and moved nothing, so `ab\b \b` read as `ab `, which is the
  model losing an edit a terminal shows. It moves one column left, stops at the
  first, and from a pending wrap goes to the column before the last, as xterm
  does. `test/testing/screen.test.ts` has the four cases.
- **`test/setup.ts` deletes `SIGIL_ACCESSIBLE`.** The suite drives the drawn
  prompts, and the person most likely to have the variable exported is a developer
  who uses a screen reader -- for whom hundreds of prompt tests would otherwise
  fail. The line-form tests stub it themselves.
- **Not done.** A line form for the rest; saying the keys a line form
  takes beyond what answering needs (`esc` to go back is not announced, as
  `text()` draws no footer for it either); a spinner or a bar that is running while
  a line prompt asks is not evicted, since a line prompt claims no live region; the
  progress components' own accessible form, which is the quiet axis's question.

### Tabs: a row of labels, and the panels it switches

`src/components/tabs.ts`. SIG-189. Textual's `TabbedContent`: `Tabs()` owns the row
and the panels, `tabRowView()` is the row alone, and `describeTabs()` and
`tabsActive()` are the two helpers a router and an app need. An element-tree
component in the shape `Collapsible` is -- a function of props that returns the
host, keys in `onKey`, the click in `onMouse` -- and not a prompt: it answers
nothing and stays in the tree.

- **One component for both halves, and the row exported on its own.** The
  ticket's first question. A row plus a signal the app binds leaves every app
  writing the `Show` per panel and the key map it was filed to avoid, and the row
  has nothing to say without the panels it switches. The row is separable because
  an app drawing its own panels (a router, a `ScrollBox`) wants the labels and the
  keys and nothing else, and it costs nothing: `Tabs()` is `tabRowView()` plus a
  box and one effect.
- **The panels are built once and hidden with `display: none`, not `Show`.**
  `Show` builds on presence and tears the branch down on absence, so switching
  tabs would throw away a panel's scroll offset, a field's contents and a
  `ScrollBox`'s window -- exactly what someone switching to Settings and back does
  not expect to lose. `display: none` is what `Collapsible` already uses for the
  same reason and gets the same two things for free: the engine lays a hidden
  subtree out as nothing, and the focus ring skips it, so Tab walks the row and
  then the showing panel only. The cost is every panel's elements existing while
  nobody sees them; a panel that is expensive to build is the app's to build
  lazily inside its own `children`. Building on first visit was refused as it was
  for the collapsible: it makes the first visit the one that is different.
- **One focusable element, the row; digits and arrows act only there.** Focusing
  each label would make Tab a tab-by-tab walk of the row and need the focus ring
  held by the component. The row takes Left, Right, Home, End and `1` to `9`, and
  the keys reach it only while it is focused, so a digit typed into a field in a
  panel stays in the field -- the reason the handler is on the row and not on the
  host. The cost is that a keyboard user is on the row to switch, then Tab down
  into the panel; there is no binding that switches tabs from inside a panel, and
  it is the app's (`tabsActive(tabs).set()`). A key that changes nothing is not
  claimed, the `Collapsible` rule: Right on the last tab goes to the pane around
  it, and a number with no tab behind it is not ours. A number for the tab already
  showing **is** claimed -- it is a tab key, whatever it did. Paste and modifiers
  are left alone.
- **The click is on each label; no coordinates are read.** Every label is its own
  element with an `onMouse`, so the router's hit test has already decided which
  one was hit and nothing here maps an x to a tab -- which would be a second
  answer to where the labels are, and wrong the moment the row scrolls. The click,
  not the press, as `Collapsible` does, so the press still focuses the row.
- **`active` is a number or a `State<number>`; the state is the one truth.**
  `Collapsible`'s `open` shape, for the same reasons. The keys and the mouse write
  it, one effect reads it, and an app that writes it switches tabs. An index out
  of range reads as the nearest tab rather than throwing, because it is written at
  run time by an app and a refusal there has nowhere to land; a non-number is
  refused at construction. `tabsActive(host)` hands back the state even when a
  number was passed, which is the answer to "read and set the active tab" for an
  app that did not make one -- the collapsible has no such door and an `onChange`
  was not added: the state is already the subscription.
- **The row learns its width through `onResize`, not a prop.** A width prop would
  be right for a static `*View()` and wrong here, where the layout decides: a row
  in a column is the width the parent gives it and changes when the terminal does.
  `Element.onResize` is the hook that exists for a component whose content depends
  on the size the layout gave it (the windowed list's), so the row records the
  width, redraws which labels are in and returns whether it changed the tree.
  Before the first layout, and in a bare `arrange()`, the width is unknown and
  every label is drawn -- the status quo the windowed list records for its first
  layout. A row whose parent sizes it to its content (a flex row with no width)
  never overflows by construction.
- **Overflow is a window of whole labels, with a cell reserved at each end.** The
  narrowest design that works: when the labels (each is its text and a space either
  side) come to more than the width, two cells are kept back for the indicators --
  `‹` on the left when tabs are hidden there, `›` on the right, blanks otherwise,
  `<` and `>` in ASCII -- so a label does not move a column when an indicator
  appears. The first visible tab is **kept** between draws and moves only when the
  active tab would otherwise be out of view, so Right through a long row slides it
  a tab at a time rather than re-centring on every key; when the window reaches the
  last tab it pulls back to use the room it has, so a wide terminal after a narrow
  one does not leave a gap. A label wider than the room is cut with an ellipsis
  rather than clipped. Nothing was windowed with an offset and `overflow: hidden`:
  the indicators need to know which side is clipped, and `scrollIntoView()` needs a
  box the layout has not given a hidden label.
- **The active tab is said by a rule, as well as by colour.** Under the labels runs
  a rule with the active label's stretch drawn heavy (`━`, `=` in ASCII) and in the
  accent. It is the one cue that survives colour level 0 and a screen with no
  attributes, which is where this is read when piped, and it makes the demo's
  output say which tab is active. The labels carry `.sigil-accent` and
  `.sigil-heading` on the active one and `.sigil-muted` on the others: roles only,
  no colour in props.
- **Only the active label shows the row's focus, and since SIG-278 it is the focus
  role that does it.** The row's `onFocusChange` puts `.sigil-focus` on the active
  label, and `sync()` moves it when the active tab changes under a focused row.
  What follows is the retired rule's history, and the reasoning about which part
  inverts still holds. It was the eighth declared exception to the role rule:
  `.sigil-tabs-row:focus .sigil-tabs-active { inverse: true }`. The row is the
  focusable element and nothing else shows that a Tab landed on it; when the rule
  was written there was no `onFocus` to toggle a role class from and no role was
  inversion, so the sheet was the only place -- `onFocusChange` and `.sigil-focus`
  are the gap "Focus on a control", at the end of this file, closed. It was a
  descendant selector keyed on the row's state so that only the active label
  inverted -- inverting the row would shout over every label and the rule, which
  is why the role goes on the label and not the row. The count moved everywhere it
  was written: the test name and list in `test/theme.test.ts`,
  `src/theme/AGENTS.md`, and the sheet's comment.
- **Labels are one line and measured by display width.** `oneLine()` takes escape
  sequences and line breaks out, `stringWidth()` measures, and each label is a
  fixed-width `white-space: pre` text with `flex-shrink: 0`, the shape `ruleView()`
  uses, so a wide character takes its two cells in the row and in the rule beneath.
- **Not done:** wrapping the row onto a second line (Textual scrolls, so does
  this); a `disabled` tab; closing or adding a tab at run time (the tabs are read
  once, the way a table's columns are); a vertical or bottom-edge row; lazy
  panels; switching from inside a panel (Ctrl-PageDown); and moving the focus to
  the row when a panel the focus was in is hidden by an app writing the state --
  the same gap as the collapsible's, since an element cannot move the focus.

### A diff view: `diff()`, a Myers diff written here, and a highlight seam it shares

`src/components/diff.ts`. SIG-198. `diff()` and `diffView()` are `rule()` and
`ruleView()`'s split; the algorithm, the patch reader and the intra-line pass are
exported beside them as pure functions.

- **The diff is computed here, because the dependency is not an option.** A small
  Myers, `O(ND)` with a trace for the walk back, after the common head and tail are
  trimmed -- which is what makes the ordinary case, a few lines changed in a long
  file, cost the trim and nothing else. It is capped at `MAX_EDITS` (2048): past it
  the middle is reported as removed and then added, a **correct** script that is not
  the shortest, because the trace is `O(D^2)` memory and two files that different
  are not worth it. Pinned by replaying the script over both sides, and by comparing
  its length with `n + m - 2 * LCS` for every pair of lists up to four items over
  three letters -- the property, rather than a handful of examples.
- **Input is two texts or a unified patch, and the patch reader is the narrow cut.**
  `---`/`+++` name a file, `@@` opens a hunk, and **the hunk's own counts say where
  it ends**: that is the only way to tell a removed line that starts `-- ` (whose
  patch line is `--- `) from a file header. Everything outside a file header and a
  hunk is skipped, so `diff --git`, `index` and a commit message are harmless, and
  `\ No newline at end of file` is dropped. Not read: renames and binary files as
  anything but skipped text, combined diffs, the context format, and the
  no-newline fact itself -- two texts that differ only in a final newline are the
  same lines here.
- **A patch carries its own context, two texts get `context` (3).** Hunks that
  would meet are one hunk, as a patch writes them, and an empty side starts at the
  line before (`@@ -0,0 +1,2 @@`).
- **Intra-line emphasis is by word, and a pair of lines that share under a third of
  their text gets none.** A character diff of two edited lines matches the letters
  the words happen to share and comes out as confetti; a word is a run of letters,
  a run of space or a mark. When the lines are not edits of each other, marking all
  of both is no emphasis at all, so it marks nothing (`SIMILAR`, 0.3). A gap of only
  whitespace between two changed stretches is part of the change, or `call one two`
  against `call 1 2` is three islands. Removed and added lines are paired in order
  within each run of changes, and a surplus on either side is drawn whole.
- **The emphasis is bold, from `sigil-heading`, and that is the whole of the
  styling cost: no new declaration and no eighth exception.** Every colour is a
  role -- added `sigil-success`, removed `sigil-error`, context `sigil-muted` -- and
  the changed span is the line's role plus the role that is `font-weight: bold`, so
  `theme/index.ts` gained class names in its vocabulary comment and nothing in
  `FRAMEWORK_CSS`, and `should declare on a role, bar seven exceptions` is
  untouched. The honest cost: a theme that gives `.sigil-heading` a colour recolours
  the changed words too, and `.sigil-diff-change` is the hook to put that right.
  At colour level 0 the bold goes with every other attribute, and what is left
  saying which line is which is the `+`/`-` marker. A background was the other
  candidate, refused for being the sheet's eighth exception for what bold does.
- **Every row is a row of fixed-width `white-space: pre` texts, folded by columns
  before it is built.** There is no inline layout, so the gutter, the marker and each
  run of differently-looking cells are siblings that have already been fitted (the
  rule's shape and the paginator's reason), and leading spaces survive because `pre`
  keeps them. Folding is by column and not by word, because it is code and the
  reader should be able to count; a fold row has a blank gutter and no marker so a
  continuation reads as one. A wide character that does not fit starts the next row,
  and one wider than the room is drawn alone and clipped rather than looped on. A
  tab is four columns wherever it falls, because the grid has no tab stops.
- **Side by side needs `DIFF_SIDE_BY_SIDE_MIN_WIDTH` (60) and draws unified under
  it, and the view says which it drew.** Sixty leaves each half about 28 columns, of
  which the gutter, the marker and the separator take a third; under that two lines
  cannot be compared, which is the only reason to put them side by side. The same
  call is therefore safe in a terminal of any width, and `DiffView.layout` tells an
  app which one it got. A removed line sits against the added line that replaces it
  and a surplus leaves the other half blank; the halves fold independently and the
  shorter is padded, so the separator stays in one column.
- **`highlight` is `multiline()`'s hook, with `HighlightSpan` and `tokensOf()`
  shared, and it is called with whole sides.** The old text and the new text for two
  texts -- once each, not once per hunk, because a block comment can begin above a
  hunk and end inside it -- and each hunk's old and new side for a patch, which has
  nothing between its hunks. Line endings arrive as `\n`. A bad token name throws
  the same `PromptError` `multiline()` throws, which is a slightly odd name for a
  non-prompt and was kept to have one validator. `TOKEN_ROLE` is exported from
  `prompt.ts` for it -- the only edit there -- and with `tokensOf()` from the
  components barrel, because the registry test requires an ejected file to import
  only what the package publishes. So both are public now, which suits an app that
  writes a highlighter of its own for a third component.
- **A token is drawn in its role on a changed line and left muted on a context
  line.** On a changed line the token's role replaces the line's colour for those
  cells, so a keyword reads as a keyword and the `+`/`-` and the gutter carry which
  side the line is on; on context the diff is the background and a keyword in full
  colour would be louder than the lines that changed. A token with no role, such as
  an app's own, takes the line's role and carries its class for the app's sheet.
- **String form only, ignoring `--quiet`, and nothing at all for texts that are the
  same.** `diff()` of two equal texts is `''`, like `table([])`, with no
  "no differences" line: that sentence is the caller's to choose and translate.

What is deliberately not done: a grammar or a highlighter; a hunk-level fold
("12 unchanged lines"); word wrapping of code; collapsing identical files in a
multi-file patch; a patch writer; a character-level pass; and a stateful view that
scrolls (a `diffView()` tree sits in a `ScrollBox` or the pager like any other).

### A modal: a dialog over the screen, and who has the input while it is open

`src/components/modal.ts`. SIG-191. `openModal()` and `confirmModal()`: the canvas
could already composite a box above the app and the layout could already take one
out of flow, so the component is the part that was missing -- which keys and which
mouse reports reach what, and where the focus goes afterwards. The toast and the
tooltip were split off as SIG-213 and SIG-214 and are not here.

- **Both, as the ticket recommended: the input is blocked, not only the focus
  trapped. The router can do it for keys and not for the mouse, and each is done
  with the narrowest thing that works.** A function `bind()` sees every key first,
  so the modal's binding takes the key, hands it to the focused element and its
  ancestors **up to the panel** itself, and stops the real event. The router's own
  walk would carry on to the root and the sequence trie sits before it -- both are
  what is below -- so the dialog does that walk over a mirror of the event and the
  router's never happens. An app's `bind('q', quit)` sequence therefore stays quiet
  while a dialog is open, and a row's `onKey` is not reached.
- **The mouse is cut off with a box, not with the router.** Mouse events are
  delivered to the tree before any router-level handler, so there is nothing the
  router could be told that would keep a click off a button under the dialog. The
  hit test is topmost first and a box with no background is hittable, so a
  transparent `position: fixed` box the size of the screen, under the panel,
  catches every report: it lands on the backdrop or inside the panel and on
  nothing below. The backdrop stops what reaches it -- except a `mousedown` that
  came from inside the panel, which is left to bubble because stopping it
  suppresses click-to-focus and a button is focused by being pressed. What leaks
  is that: the press bubbles to the root and to the router's own `onMouse`
  handlers. Narrower than the keys, recorded rather than closed.
- **What a function binding registered _before_ the dialog still sees, and that is
  the Ctrl-C rule rather than a gap.** Bindings run in registration order and a
  later one cannot go first. An app's quit binding is made at startup and sees
  every key first, as it must; a binding made after the dialog opened sees none.
  `isAbort()` keys are not taken by the dialog at all, so a later quit binding
  works as well. Pastes were outside all of this, and are no longer -- the entry
  below.
- **A paste nothing inside claims ends at the panel, and is typed in there.**
  SIG-222. A paste walks the tree from the focused element before the router's
  `onPaste()` handlers see it (SIG-215), so one that bubbles to the panel is one
  nothing inside took whole, and above the panel are the root and the app's own
  handlers -- which is how `50-text-field.js`'s list heard a paste aimed at the
  dialog's button. So the panel's `onPaste` stops it. A focused `TextField`
  inside still has it first, because it is lower in the walk. Stopping a paste
  also cancels the router's fallback, which types it in as keys, so the panel
  does that fallback itself, over the same walk to the panel a key gets: an
  element inside that reads keys and not pastes still has the text, and with
  `paste: true`. The router's fallback was not the answer, because pasted keys
  go through every function binding first, and those are the app's. A pasted key
  that closes the dialog or moves the focus out ends the paste -- what is left
  has nowhere inside to go -- and a lower dialog an app moved the focus into
  types nothing in, since only the top answers. What is still open is a focus an
  app moved **outside** every dialog: the walk then never reaches a panel, so
  the paste goes to the app until the next key pulls the focus back in.
- **Tab is the dialog's own, and the ring is the router's.** The binding moves the
  focus along `input.focus.ring()` filtered to what is inside the panel, wrapping
  and starting from the first element when the focus is outside -- the router's own
  `step()` rule, applied to a subset. Shift-Tab is the same the other way. If the
  focus has got out (an app called `focus()`, or something unmounted) the next key
  puts it back at the initial button before the key is delivered, so a key is never
  handed to a row under the dialog.
- **Focus goes back to what had it, and falls back inside the dialog below.** It is
  recorded at open and restored at close **only if the focus is still inside the
  dialog being closed**: closing a lower dialog under an upper one must not take
  the focus off the upper, and an app that moved the focus on deliberately before
  closing keeps where it put it. If the recorded element has gone or is no longer
  focusable the first element of the pool takes it, and the pool is the ring of the
  dialog now on top rather than the whole ring -- a fallback that stepped out of
  the dialog below would be the escape the trap exists to prevent. Nothing focused
  when it opened is restored as nothing focused.
- **A stack is a per-router list, and only the top answers.** Each dialog registers
  its own binding; every one checks that it is the top and stands aside otherwise,
  so a lower dialog's binding runs first, does nothing, and the upper one's takes
  the key. Escape closes the top only. The list is a `WeakMap` keyed on the router
  rather than module state, so two routers do not share a stack.
- **Escape is the dialog's even when a focused field inside would have wanted it.**
  The binding sees the key before the field does, so a text field inside a dialog
  cannot use Escape to clear itself. `dismissible: false` is the opt-out and the
  buttons are then the only way out.
- **`dispose()` is `close()` with no answer, and `result` always settles.** A
  promise that never settled would hang an `await`, so closing from outside
  resolves it with `undefined`, and closing twice does nothing -- a button and an
  Escape that arrive together settle it once. It takes the binding off the router,
  stops the focus effect, removes the backdrop and then restores the focus.
- **The dialog is opaque with no colour declared, so the sheet gains no exception.**
  A box with no background paints nothing in its empty cells and the debug pane's
  answer is a background colour in the sheet, which is dropped at colour level 0 --
  documented there as the pane being transparent for a user who asked for no
  colour. For a dialog that is the failure rather than a footnote, so the panel
  carries a `raw` first child, absolutely placed over its whole padding box, that
  fills it with blank cells. The grid counts a painted blank as drawn (that is what
  occupancy is for), so the app is hidden at every level, in the terminal's own
  colours. Nothing is declared, so the role invariant's exception count is
  untouched; `.sigil-modal-fill` is the hook for a theme that wants a colour behind
  a dialog, and `cellStyle()` is read off it so that one rule reaches the fill.
- **A focused button is bracketed, not inverted.** `[ Yes ]` against `  No  `, in
  the accent, written by one effect on the focus signal. When this was written the
  collapsible's inverse focus would have needed a `:focus` rule in the sheet, which
  was another exception; since SIG-278 a button could put `.sigil-focus` on its
  label from `onFocusChange` with no exception at all, and that move is SIG-199's,
  when `Button` replaces these. The reason that stands is level 0, where an
  inverse is invisible and the bracket is not -- which is why `Button` keeps the
  brackets and adds the role, under "Focus on a control". The effect reads the signal
  rather than the Tab handler setting it, because a Tab, a click and an app calling
  `focus()` are three routes to one change.
- **The quiet axis is not consulted, which is the prompt rule and the debug
  overlay's.** A dialogue is not progress: a quiet run still shows a dialog it
  opened, and a dialog that vanished under `--quiet` would leave a program waiting
  on an answer nobody was shown. It is the app's own tree, not a mount beside an
  answer, so it is on `render()`'s side of the line `output.ts` draws. There is
  no motion either -- it appears and goes in one frame -- so `reduce` has nothing
  to switch off. Pinned by a test that opens one under `setQuiet(true)`.
- **Under the debug overlay, always.** The backdrop is `z-index: 900` and the pane
  is `1000`, so the instrument stays readable over a dialog whichever was appended
  last. A dialog is above anything the app did not give a `z-index`.
- **`confirmModal()` is a dozen lines over it and is in.** Two buttons, `true` and
  `false`, `initial: 'yes' | 'no'` (default `yes`; a destructive question wants
  `'no'`), and a dismissal is `false` because leaving a question unanswered has
  never meant "go ahead". It is not a second implementation of a dialog.
- **The host is the renderer or any element.** `openModal(view, ...)` and
  `openModal(root, ...)` both work, because all it needs is the element to append
  to and the router whose ring contains it. The latter is what the piped demo and
  the tests use, with no renderer.
- **A renderer host closes the dialog with no answer when it goes.** SIG-219. The
  binding stops every key but the abort, so a dialog opened from a handler and
  left open after `view.dispose()` swallowed the keys of a router the app goes on
  owning, and `result` never settled, which would hang an `await`. It subscribes
  to `onDispose()` last and calls `close()`, which puts the focus back -- the tree
  is still whole when the handler runs -- and settles `undefined`, so
  `confirmModal()` answers `false`, a dismissal's answer. An element host has no
  such signal, and the dialog is the caller's to close.
- **Not done:** a dimmed scrim behind the dialog (no `opacity`, and a transparent
  box is what keeps the app visible); resizing the panel to its content (it has a
  declared `width`, capped at the screen, and grows in height); announcing a
  dialog in accessible mode, which draws prompts as lines and has no screen to lay
  one over; a `mousedown` bubble, and a paste while an app has moved the focus
  outside the dialog, as above; and a drag
  handle. A toast and a tooltip are SIG-213 and SIG-214.

### A styled cell outside `table()`: where a `TableCellView` is wanted

SIG-212. SIG-178 let a `table()` cell be a `TableCellView` -- `{ element, width }`
-- so a badge keeps its colour in one; this asked which other places that lay out
text in cells want the same. The survey answer is **one**, and it already had it.

- **`selectRow()` is the only site, and it took views the day it was written.**
  It builds its cells with `tableCells()`, `tableWidths()` and `tableRowView()`, so
  a view was measured by its `width`, aligned by `align` and cut at `maxWidth` with
  no change -- one implementation of "a cell is a string or a view", shared rather
  than copied, which SIG-193's export of those pieces had already made true. What
  was wrong was the two places `selectRow()` reads a cell as a **value**: the sort,
  and the answered line.
- **A view has no order, so the default sort puts it with the empty cells.**
  `compareCells()` reads an unknown object as `String()` of it, so every view was
  `[object Object]` -- a tie with every other view, and filed _before_ every
  lower-case text, since `[` sorts before a letter. A view in a mixed column now
  goes last both ways, which is the empty-cell rule. It is the **sorter** that
  says so, as it already is for an empty value, and it asks the cell (`.view`)
  rather than the value, because the shape test is `table.ts`'s and a second copy
  of it here is how the two come to disagree.
- **A column's own `compare` is handed the view, not refused it.** Whoever built
  the view knows what it stands for, and a view is checked by shape, so it can
  carry that: `{ ...badgeView('FAIL'), rank: 2 }` is a cell and a sort key.
  Treating a view as empty for `compare` too would make a status column
  unsortable by any means short of a second column holding the status as text.
- **A column of nothing but views gets no digit unless it asks for one.** Its
  digit would draw an arrow and move no row, which is the "the footer names no
  digit that does nothing" rule SIG-193 already keeps; a `compare` or an explicit
  `sortable: true` binds it. Decided once, from the cells the prompt was handed --
  the rows are never changed, so it cannot go stale.
- **The answered line leaves a view out.** It is a string, and a view has no text
  form; `short` is the lever and its doc says so. Inventing one -- an optional
  `text` on `TableCellView` -- would be API with one reader.
- **The colour level stays the caller's.** A view is built at the level it was
  asked for and neither `table()` nor `selectRow()` passes its own down: a view is
  an already-built tree, and rebuilding it at another level needs the function
  that made it, which a `{ element, width }` does not carry. The badge entry
  already says to pass the same `colorLevel` to both, and the cost of not doing so
  is a shape, not a width.

**The sites that do not want one, and why:**

- **`tasks()` titles** are a spinner's label: one string that is also the piped
  line, the `TaskOutcome.title` handed back, and the prefix on interleaved output.
  A view has no text for three of those four.
- **`log` fields** are logfmt data for grep, written to a file unwrapped; a field
  value is a value, and a styled one is the opposite of what the quoting is for.
- **`outline()` items** are paragraphs that wrap with a hanging indent, not cells
  -- and a badge _inside_ an item, which is the case anybody would want, is a run
  in a paragraph rather than a whole-item view.
- **Prompt choice labels** are not changed here, and they are the one place a view
  is plausibly wanted: a status beside a choice. Not as the label, which is what
  `autocomplete()` filters on, what accessible mode reads out and what the answered
  line prints -- as a separate slot beside it. A follow-up, because `prompt.ts` is
  shared and that is a choice-row change of its own.
- **Labels in `bars()` and `createMultiProgress()`, tree labels and tab labels**
  were looked at for the same reason and are text a person reads, measured and cut
  as text; nothing asks for a badge in one.

**Deliberately not done: the longer fix.** A cell that is styled text in general
-- a `paragraph()` of runs -- would make `TableCellView` unnecessary rather than
extend it, and it is what three of the refusals above actually want: a badge
inside a log message, a task title or an outline item. It is a change to how a
`text` holds content rather than to `table()`, and it is the follow-up to file.

### Which exports are prompts: the signal table, derived from the barrel

SIG-211. `test/components/prompt-signal.test.ts` gives every prompt the same
checks: aborted mid-prompt, already aborted, `AbortSignal.timeout()`, and the
screen left as a cancel leaves it. The prompts added after SIG-176 were missing
from it. They all honoured the signal, because they all go through
`runPrompt()`; the table is what would say so the day one stopped.

- **"Is a prompt" is a type computed from the barrel, not a list.** `PromptName`
  maps every export of `src/components/index.ts` and keeps each function that
  answers with a promise and takes an options object whose `signal` is an
  `AbortSignal`. `prompts` is `satisfies Record<Exclude<PromptName, keyof typeof
  EXEMPT>, Ask>`, so a prompt exported without a row is a type error that names
  it. The alternative a list invites is classifying every barrel export as prompt
  or not-prompt. That puts the burden on whoever adds an element, a view or a
  helper, which is most exports, and it is how the classifying list itself gets
  forgotten. Here a non-prompt is out of the union by its own signature, and
  nobody touches the test for it.
- **The guard is `tsc`, not the runner.** A runtime cannot see a type, so
  `pnpm check` is what fails; vitest alone does not. The routing types set that
  precedent. `IMPLEMENTATIONS` in `dist.test.ts` could not be derived, because the
  barrel exports state builders beside each implementation. This list can, because
  "takes a signal and answers with a promise" is a property of the signature.
- **The value's type is checked as well as the key.** `resolveEditor()` takes a
  `Record<string, string | undefined>`, and `'signal'` is a key of that too.
- **`satisfies` cannot catch an empty union, so there is a second check.** Every
  object satisfies an empty record, so a predicate that stopped matching anything
  would let the table pass with every row in place. `expectTypeOf` over the
  table's keys plus the exemptions, compared with `PromptName`, checks the other
  direction.
- **`decrypt()` is the one exemption, and its reason is in the map.** It takes a
  signal and answers with a promise, but it is an animation: an abort erases it
  and resolves. An exemption is an entry with a reason, never an omission.
- **`editor()` and `runPrompt()` are rows, not exemptions.** The editor asks its
  question through `runPrompt()` before it spawns anything, so all three checks
  apply, with a command that is never run. An abort while the editor is open is a
  different contract, and `editor.test.ts` covers it. `runPrompt()` is the engine
  and gets a row of its own with an empty handler set.
- **`toggle.test.ts` keeps its own signal tests.** The table's checks cover
  everything they assert and more, but the two are not identical, so neither was
  deleted.
- **Not done:** accessible mode. It is a second path, `runLine()`, with its own
  abort handling, and `prompt-accessible.test.ts` checks one mid-prompt abort on
  `text()`. Running the table a second time with `accessible: true` would cover
  the six prompts that have a line form. That is a separate change. It was
  SIG-223, below.

### The signal table, run a second time as lines (SIG-223)

`prompt-signal.test.ts` runs the same rows twice, drawn and with
`SIGIL_ACCESSIBLE=1`, so an abort that `runLine()` handles worse than `run()` is
seen. Nothing was found broken. Three sabotages of `runLine()` each failed only
the line run: no `removeEventListener` in `stop()`, an abort that rejects
without `fail()`, and `asLines()` ignoring the variable.

- **One list, two runs, and the exceptions keyed by type.** `LineName` is the
  prompts whose options take `accessible`, read off the barrel the way
  `PromptName` is. `DRAWN_ONLY` is `satisfies Record<Exclude<keyof typeof
  prompts, LineName>, string>`, which is exact both ways: a prompt with no line
  form and no reason is a missing key, and one that gains the option while still
  listed is an excess one. The line run is the table less `DRAWN_ONLY`, so a row
  added for the drawn run joins it without anybody remembering to.
- **The types are checked against what is drawn.** A type saying `accessible`
  does not prove a line form runs, and a line run over the drawn path would pass
  every check and prove nothing. So each row is asked once under the variable,
  and one that writes any sequence but the paste markers must be in `DRAWN_ONLY`
  and one that writes none must not.
- **The variable, not the option, is the switch.** It is how a person turns the
  mode on for every app, and it reaches every row without a second set of rows.
  The option's precedence over it is `prompt-accessible.test.ts`'s.
- **A line form is held to the cancel's bytes, not to an empty screen.** It takes
  nothing back, so an abort leaves the transcript and a fresh line. The check is
  `output` equal to a Ctrl-C's, which is stronger than comparing the log.
- **A cancel takes its listener off the signal, for every row in both runs.** An
  abort's listener is `once` and comes off by itself, so the table only saw a
  leak on the ending that has to remove it by hand once this was added. Stdin's
  `data` listeners are checked back to zero after an abort or a timeout too.
- **Not done:** a timer check. The router's key timer is cleared in `stop()`,
  and the process's active-handle list is shared with the runner, so a count of
  it would be noise.

### A tail that cannot be cut goes under the question (SIG-210)

`toggle()` found that the head's half-line cap clips a tail that cannot wrap, and
fixed itself. SIG-210 asked which other prompts had the same defect.
`promptTailFits()` and `promptUnderHead()` in `prompt.ts` are the fix, and
`selectKey()`, `date()` and `pickDate()` use them.

- **It was measured first, because SIG-205 and SIG-177 had rewritten the hint
  lines since the ticket was filed.** Every head that reserves a tail was rendered
  at 20, 24 and 40 columns under a question long enough to fill the line.
  `confirm()` **did not reproduce**: `(Y/n)` is five columns and the cap keeps it
  whole down to the 13-column floor, which `should keep the hint whole where the
  message has to wrap for it` already pins. So it is unchanged. Three prompts did
  reproduce. `selectKey()`'s expand line came out as `(o/S/d/h` at 20 columns. A
  `date()` field came out as `2024-06-` at 20 and 22, and with `seconds` it lost its
  last digit at **40**, where 19 columns met a cap of 18. `pickDate()`'s field was
  cut the same way as `date()`'s. Every other head reserves nothing, because its
  tail is a field that scrolls or an answer, so it has no fixed tail to cut.
- **The rule is the cut itself, not `toggle()`'s rule.** `promptTailFits()` asks
  the head's own arithmetic whether `rest` covers the tail. So a tail moves only
  where the cap would have cut it, and a question that wraps to keep the tail beside
  it, which is the decision `confirm()`'s test is named after, still does. Moving
  any tail that does not fit on one line with the whole question would also have
  changed every one of these prompts at widths where nothing was wrong. `toggle()`
  keeps its stricter rule and is not migrated. That rule implies this one, because
  states drawn beside a question that fits on one line are never cut, and it is a
  layout choice the toggle's own entry records, with tests.
- **Where the answer settles is decided per prompt, by whether it fits on the
  question's line.** `toggle()` puts the answer back on the head line and reserves
  the longer of its two names, which costs the question a few columns. For
  `selectKey()` that reservation would be the longest label, which takes up to
  half the line from the question for as long as it is asked. So its answer
  settles in the expand line's place, under the question. (SIG-216 kept the
  refusal and replaced the placement: the answer now settles through
  `promptAnswerSlot()`, so it is beside the question where it fits on that line
  even with the expand line under it. See below.) A date field is the
  answer, so it settles where it was drawn. Putting it back on the head line would
  cut it again: ten columns against a cap of eight at 20.
- **The row under the head is indented to the message's column.** That is the
  mark's width plus its margin, worked out from `PROMPT_SYMBOLS` rather than
  written as `2`. In `selectKey()` it holds the hint and the answer, both hidden
  after `h`. A row whose children are all hidden takes no height, so the list opens
  straight under the question with no blank line between. A test pins that.
- **Sabotage: twelve of twelve caught.** The breaks were: the predicate forced
  either way, made off by one, and made blind to the tail's width; the row
  unindented; each prompt never moving its tail; each prompt still reserving the
  tail once it moved; and `selectKey()`'s answer left out of the row. The off-by-one
  is caught only by the beside case at 24 columns. That case is the boundary,
  because a long question beside a tail that fits leaves `rest` exactly the tail's
  width.
- **Not done.** A prompt that reserves nothing for its answer draws that answer in
  whatever is left. Under a question as wide as the line, that is one column, so
  `selectKey()` without `expand` settled `Show the diff` down the right edge as
  `S`, `t`, `d`. `select()` does the same at 40 columns, which was measured, and
  the other list prompts share the arithmetic, which was not. It is
  about the answer rather than a fixed tail, it predates this ticket, and fixing it
  means choosing how much of the question an answer may take in every list prompt,
  so it is left for a ticket of its own. `confirm()` below 13 columns is under the
  floor the head already declares. SIG-216 is that ticket, below.

### A text field: the prompt's editor as an element

`src/components/text-field.ts`. SIG-215. `TextField()` is one editable line that a
tree can hold -- the first caller is `openModal()`'s `body`, whose focus trap a
field joins like anything else focusable.

- **The element first, and the `text()` prompt is not moved onto it here.** It is
  built from what the prompt is built from rather than beside it: `editing.ts` for
  every edit, and `promptWindow()` -- the prompt's own sideways window -- for what
  is on screen. What is _not_ shared yet is the key table and the drawing, which
  the prompt keeps inline; mounting the prompt over the element is a follow-up,
  because a second set of answers about the prompt's settle and its placeholder is
  a change to every `text()` and `password()` and belongs in a ticket of its own.
- **The value is a string to start from or a `State<string>` that is the value,
  the shape `Collapsible`'s `open` and `Tabs`' `active` have.** No handle: an app
  that wants the value passes the state, and `onChange` is called after an edit the
  field made and never after a write the app made, since the app already knows.
  The caret is the field's alone. A write the app makes puts it at the end: the new
  value carries nothing that says where in it the caret belongs, and the end is
  where a typist would be.
- **Tab, Escape and the abort are never the field's, and that is not a guard.** It
  falls out of the key table: none of them is an editing key and none of them types
  anything, so they reach the one branch that hands every unclaimed key on. An
  explicit refusal of the three was written first and deleted for surviving its
  sabotage. Up, Down and any chord nobody bound here go on the same way, so a form
  or a list around the field can have them. The editing keys are claimed even at an
  end -- Left at column zero is still the field's -- because a list or a tab row
  around it moving on a key aimed at the caret is the surprise, which is the
  prompt's own answer.
- **Enter is the field's only when it was given `onSubmit`.** With one, Enter calls
  it and stops. Without one it is not claimed and goes on to whatever holds the
  field. Inside a modal that is the panel, which has no default button, so Enter in
  a field without `onSubmit` does nothing there -- the caller decides what Enter
  means by passing `onSubmit: () => dialog.close(...)`, which is what the demo does.
  A **pasted** line break is a space and never a submission, for the reason the
  prompt flattens a paste: obeying one submits half an address.
- **Validation and an error line are not the element's.** The prompts reserve a
  row for one because a prompt is the whole question; a field is one part of a
  form, and where the error goes, when it is checked and what blocks a submit are
  the form's to say. `onChange` and `onSubmit` are where a caller checks.
- **A focused field claims a paste, and that took a change to the router's
  order.** A router's `onPaste()` handlers ran before anything in the tree saw the
  paste, so an app-wide handler registered at startup took a paste meant for a
  field the app opened later -- inside a modal, a handler _under_ the dialog, which
  is the gap the modal's entry recorded as unclosable "without making a paste into
  a dialog's own field impossible". `Element.onPaste` is offered the paste first,
  on the focused element and then each ancestor, and a router handler sees what
  none of them stopped; `input/AGENTS.md` records why that is the mouse's order
  rather than the keys'. Nothing set `onPaste` on an element before, so nothing
  that worked moved. What it leaves: with a **button** focused in a dialog, an
  unclaimed paste still walks past the backdrop to the root and the router's
  handlers -- the modal could stop it at the backdrop now, and does not yet; and a
  prompt over a **borrowed** router takes pastes through `onPaste()`, so a field
  focused in the app's tree under it would take the paste first.
- **The caret shows only while the field has the focus, so a form of several
  fields shows one.** Since SIG-278 the field's `onFocusChange` puts `.sigil-focus`
  on the caret; until then it was `.sigil-text-field:focus .sigil-text-field-caret
  { inverse: true }`, the sheet's ninth declared exception, the tabs row's shape
  again, written because the field could not know its own focus without a router.
  It can now, from the element, which is the whole of "Focus on a control" at the
  end of this file. One consequence differs from the prompt: the
  prompt leaves the caret's cell undimmed when it sits on a placeholder, and the
  field mutes it, because an unfocused field would otherwise show the hint's first
  letter at full strength as if it had been typed. Focused, that cell is a dimmed
  reversal, which is still a caret.
- **The room is the layout's, learned through `onResize`, the way the tabs row
  learns its width.** `width` declares it; without one the field takes what the
  layout gives -- stretched in a column, its whole value in a row. `min-width: 0`
  is the declaration that makes a field in a row shrink to its share at all: a
  box's automatic minimum is its content's, and a field's content is the whole
  value.
- **The pieces hold the whole value and the host scrolls, because a field that
  drew its window was as wide as its last window (SIG-318).** The entry above said
  the field's content was the whole value while the pieces held only what
  `promptWindow()` kept -- cut to the room the last layout gave. In a column that
  is harmless, since the width is the parent's whatever the field draws. In a row
  with no width the field is as wide as what it draws, so the room and the drawing
  each set the other and could only shrink: empty, it was the placeholder's width;
  one key later it drew `p` and the caret and was laid out two wide; the next key
  was cut to two columns, and from then on it showed the caret and the last letter
  whatever had been typed. Found by the system monitor's filter (SIG-291), which
  worked around it with a `flex-grow` before this was filed.

  So the pieces always hold the whole value and the field asks the layout for all
  of it. Where it gets less, `overflow: hidden` cuts the right of the value off
  and `scrollTo()` takes the left away -- by exactly the columns `promptWindow()`
  drops from the front, so the window is still the prompt's, whole clusters come
  off, and a wide character is never cut in half at the left edge. `overflow:
  hidden` was once written here and deleted for failing its sabotage; it is load
  bearing now, since without it the rest of the value draws over whatever follows
  the field. Getting a scrolled box to paint at all inside a row took a canvas
  fix: `write()` treated column zero as the only left edge, so a run starting
  left of a clip further in painted nothing (`canvas/AGENTS.md`).

  Sabotage: seven, none survived -- no `overflow`, no `scrollTo()`, the offset left
  out of the change signature, an offset of the bare overflow rather than whole
  clusters, the windowed pieces put back, no `min-width: 0`, and the canvas's left
  edge back to column zero alone.

- **A control character the app wrote is drawn as nothing.** The keys cannot type
  one and a paste is flattened, so only a write the app made can carry one -- and
  nothing is what `stringWidth()` measures it as, so the window's arithmetic and
  the drawing agree. The value itself is the caller's and is left as it is.
- **`mask` came for a few lines and `disabled` is a state.** `mask` is the
  `password()` prompt's column-count rule. `disabled` takes the field out of the
  ring through `focusable` and ignores keys and pastes; a field disabled while it
  has the focus keeps it, since there is no router to move it with, and simply does
  nothing.
- **Sabotage: twenty-nine, six survivors, three deletions and one new test.** The
  explicit Tab, Escape and abort refusals (three sabotages of one line) and an
  unchanged-room early return in `onResize` -- `draw()`'s own signature already
  answers "nothing changed" -- were deleted; `overflow: hidden`, above, likewise;
  and `min-width: 0` had no test until `should shrink to its share of a row rather
  than to its content`. The other twenty-four, three of them on the router's new
  order, are caught.
- **Not done:** the prompts sharing this editor; multiline, `number` and
  `maskedText()` variants; clicking to place the caret; a selection; a
  `describe` helper for a key-help footer; and blocking an unclaimed paste at the
  modal's backdrop.

### A text field at rest: a background of its own

`src/theme/index.ts`. SIG-218, which waited on SIG-217. `TextField()` drew nothing
of its own until it had the focus, so an unfocused field was its value and nothing
else -- measured at colour level 1, a label `Name` over a field holding `parser.ts`
rendered `Name\nparser.ts` in both schemes, the field byte for byte a second label.
In the rename dialog of `demos/components/50-text-field.js` nothing said the name
could be edited until the caret appeared. It is now `ESC[100mparser.ts` and eleven
blanks on a dark terminal and `ESC[47m...` on a light one.

- **A background on `.sigil-text-field`, in the framework sheet, across the whole
  host.** Decided in the ticket and kept: an underline marks the characters and the
  caret's cell and leaves the room to the right unmarked, which is the room the
  typing goes into, and a border costs two rows and is opt-in, so a bare field would
  still show nothing. It is the sheet's tenth declared exception to the role rule,
  the overlay's reason again -- no role is a background. It was blocked on SIG-217
  because a text used to wipe its container's background from every cell it drew a
  glyph on, which would have left the value on the terminal's own colour inside a
  grey bar.
- **Index 8 on a dark terminal and 7 on a light one, and not the overlay's pair.**
  The overlay's 0 and 7 are chosen for a pane that must be opaque over the app; a
  field must be _distinct_ from the box around it, and in a modal that box is the
  terminal's own background. Measured as WCAG contrast over the default palettes of
  seven dark and five light terminal setups -- xterm, Terminal.app (Pro and Basic),
  iTerm2, Windows Terminal's Campbell, VS Code's Dark+ and Light+ (read from its
  `terminalColorRegistry.ts`), GNOME's Tango and Solarized -- with the field's
  background against the terminal's:

  | dark      | xterm | Terminal | iTerm2 | Campbell | VS Code | Tango | Solarized |
  | --------- | ----- | -------- | ------ | -------- | ------- | ----- | --------- |
  | index 0   | 1.00  | 1.00     | 1.00   | 1.00     | 1.26    | 1.00  | 1.15      |
  | index 8   | 5.24  | 3.66     | 3.77   | 4.31     | 2.90    | 1.73  | 1.00      |
  | text on 8 | 3.18  | 5.13     | 3.30   | 2.83     | 3.58    | 5.01  | 4.75      |

  | light     | xterm | Terminal | VS Code | Tango | Solarized |
  | --------- | ----- | -------- | ------- | ----- | --------- |
  | index 7   | 1.26  | 1.84     | 7.46    | 1.26  | 1.14      |
  | index 15  | 1.00  | 1.26     | 2.46    | 1.00  | 1.00      |
  | text on 7 | 16.67 | 11.42    | 1.69    | 8.67  | 3.64      |

  Index 0 is the terminal's background exactly in five of the seven dark ones, so
  a field on it vanishes, which is the overlay's pair failing at this job rather
  than a close call. Index 15 is the background exactly in three of the five light
  ones. So 8 and 7, which are the ticket's guess, confirmed rather than assumed.
  Two setups lose and are recorded rather than designed around: **Solarized dark**,
  whose index 8 _is_ its background (`base03`), so a field there is invisible --
  its `base02`, index 0, would have been right, and an app on it says so in one
  rule; and **VS Code's Light+**, whose index 7 is `#555555`, so the default
  `#333333` text sits on it at 1.69:1. The overlay's light half has had that second
  one all along, for the same reason.

- **The placeholder stays on the muted role, and is weaker on the background.**
  Dim is modelled as the foreground half way to the cell's background, which is
  what `src/style` already records SGR 2 as doing; xterm and Alacritty darken
  towards black instead, which on a grey is worse. On the dark side the hint drops
  from 3.42-4.82 on the bare terminal to **1.76-2.53** on index 8 (Solarized's 2.21
  either way, since its field is invisible); on the light side `gray` on index 7
  is 3.12-12.25 where it was 4.00-13.92, and 1.30 on VS Code's Light+. Readable,
  and de-emphasised as it should be, but less so than before. Not overridden: a
  rule giving the placeholder a colour of its own would set a property on the same
  element as `.sigil-muted` at the same specificity, which the sheet refuses
  because source order would decide it, and a theme restyling `.sigil-muted` would
  stop reaching the hint. The measured alternative, `black` on a dark terminal, is
  3.66-5.24 on five of the seven and worse on Tango and Solarized, whose index 0 is
  a tinted grey.
- **Focus changes nothing but the caret.** The caret already says which field the
  keys go to, and it shows on the background for free: SIG-217 keeps the field's
  colour in the caret's cell, so the inverse swap draws a light block on a dark
  terminal's grey. A focus background would be an eleventh exception saying what
  the caret says.
- **A disabled field keeps its background.** A field that cannot be edited now is
  still a field, and a form with one disabled should still read as a form; the
  muted value is what says not now. Dropping it would need a compound
  `.sigil-text-field.is-disabled` rule, and there is no dimmer grey among the
  sixteen to give it instead -- the only darker index on a dark terminal is 0,
  which is the background.
- **At colour level 0 the background is dropped, and that is the known cost.** A
  field at rest is its value again there, and a focused one shows no caret either,
  which SIG-215 already recorded. Not reconsidered for that level in the sheet,
  because the sheet cannot say anything there: degradation drops every colour and
  attribute at resolve time. An answer at level 0 would be _content_, the way the
  badge draws brackets -- brackets or an underscore run around the value -- which
  changes the field's width arithmetic and its caret together and belongs in a
  ticket of its own. The two ways to reach level 0 are a pipe, where there is
  nobody typing, and `NO_COLOR`, where it is a real gap.
- **A theme restyles it and an app can take it away.** `.sigil-text-field {
  background-color: blue }` in a theme beats both halves, and an app's
  `background-color: default` removes it; one class at a later origin each time.
- Tests: `a field at rest` in `test/components/text-field.test.ts` reads each
  cell's resolved background off a painted grid, both schemes, the label above the
  field on the terminal's own colour and the field on its pair across all its
  columns -- focused, placeholder, disabled, level 0 and restyled. Sabotage: the
  base rule deleted fails six, the light half deleted fails four, the overlay's
  `black` in its place fails four, a focus background and a disabled
  `background-color: default` fail two each (one of them the role invariant).

### A slider: a value on a track, by key and by drag (SIG-286)

`src/components/slider.ts`. `Slider()` is a number on a track that a tree can
hold -- a settings screen's volume, a media player's seek bar -- and
`describeSlider()` puts its keys in a key-help footer. An element in the shape
`TextField` is: a function of props that returns the focusable host, the keys in
`onKey`, the pointer in `onMouse`, the focus from `onFocusChange`. The demo is
`demos/components/62-slider.js`; how each answer below was tested, and the
sabotage pass, are in
[docs/history/a-slider-a-value-on-a-track-by-key-and-by-drag.md](../../../../docs/history/a-slider-a-value-on-a-track-by-key-and-by-drag.md).

- **The ticket's first question: `min`, `max` and `step`, and the value is a number
  or a `State<number>`.** The shape `TextField`'s `value`, `Tabs`' `active` and
  `Collapsible`'s `open` already have, for their reasons: a number is where it
  starts, the state is the value, the keys and the pointer write it, and an app
  that writes it moves the thumb. `onChange` is the text field's, called after a
  key or the pointer moved the value and never after a write the app made, since
  the app already knows -- and not called for a key that moved nothing, Left at
  the bottom. No `sliderValue()` accessor the way `Tabs` has `tabsActive()`: that
  door exists because tabs have no `onChange`, and a slider does. Defaults are
  0, 100 and 1, which is HTML's `<input type="range">`.
- **The value is always `min` plus a whole number of steps, and the top is the last
  step at or under `max`.** HTML's rule, and the only one that keeps every value
  reachable by the keys: a range of 0 to 10 in threes ends at 9, and End goes
  there. The steps are counted from `min`, not from zero, so 1 to 21 in fives is
  1, 6, 11. A step's value is `min + i * step` rounded to the decimal places `min`
  and `step` are written with, so three Rights on a step of `0.1` is `0.3` and not
  `0.30000000000000004` -- a value an app compares, prints, or stores in a config
  file, where the noise is a bug report.
- **A value the app writes outside the range or between two steps is drawn at the
  nearest step and left as written.** The tabs' rule for an out-of-range `active`,
  for the same reason: it is written at run time by an app and a refusal has
  nowhere to land, and rewriting the app's state behind its back would be a write
  nobody asked for. The next key moves from the nearest step. `NaN` reads as the
  bottom. What is refused is refused at construction, with a `TypeError`: a
  non-number value, a `min` not below `max`, a non-finite bound, a `step` or `page`
  that is not positive, a `format` that is not a function, a `width` that is not a
  positive whole number -- and a `step` larger than `max` minus `min`. That last one
  used to be read as one step anyway, so `{ min: 0, max: 1, step: 2 }` let End,
  Right, Page Up or a drag write `2` into the app's state and `onChange`, a value
  past `max` that the rule above says cannot exist. No step fits, so there is no
  slider to draw; the default step counts, so `{ max: 0.5 }` is refused too. It is
  asked of the step count, with the tolerance that count already has, rather than
  as `step > max - min`, since `0.3 - 0.1` is `0.19999999999999998` and 0.1 to 0.3
  in 0.2s is a range that holds exactly one step.
- **The ticket's second question: horizontal only.** A vertical slider is a column
  of one-cell rows, and a cell is about twice as tall as it is wide, so the same
  range gets half the resolution in twice the screen -- and every use the ticket
  names (volume, seeking, a settings row) is a row. Nothing asked for vertical, and
  a feature nothing needs is a feature designed by guessing (the root file's
  `which` entry). It is additive later -- an `orientation` prop, Up and Down -- so
  refusing it now closes nothing.
- **The ticket's third question: the label is the app's, the readout is the
  slider's.** A form lines its labels up in a column whose width only the form
  knows, which is why `TextField` has no label either; a settings screen's rows lay
  out the same way whether the control is a field or a slider. The readout is the
  other way round because only the slider can do it right. `05-drag.js`'s
  hand-drawn slider is the trap the layout's `AGENTS.md` records: a readout as wide
  as what it says took a column from its neighbours at exactly `100%` and nowhere
  else, and moved the track. So `format` draws a readout after the track, and its
  width is the widest `format` returns over the range -- every step when there are
  at most a thousand, which is a hundred calls for the default range, and the two
  ends past that, where an integer range's widest is an end anyway. Measured over
  every step rather than at the ends because the ends are not always the widest:
  `-0.5` is wider than `-1` and `1`. A `format` that comes back wider than it
  measured (one that reads a clock) widens the readout rather than being cut: a
  track moving once is better than a value nobody can read. No `format`, no
  readout -- HTML's range shows none either, and a seek bar's `1:23 / 4:56` is
  usually beside it rather than after it.
- **The ticket's fourth question: Left and Right a step, Page Up and Page Down a
  page, Home and End the ends -- and Up and Down are not the slider's.** ARIA's
  slider also takes Up and Down, as increase and decrease. Here they are left to
  bubble, because a settings screen is a column of rows and Up and Down are what a
  form or a list around the slider moves between them with (SIG-199, SIG-280); a
  horizontal slider taking the vertical arrows would be the one control in the
  form that traps them. `page` is in the value's own units, rounded to whole steps
  and never less than one, and defaults to a tenth of the range, so Page Up on a
  0-to-4 range still moves. Modifiers and pastes are left alone, the `Tabs` rule.
- **The keys are claimed at the ends too, which is the text field's rule and not the
  tab row's.** `Tabs` and `Collapsible` hand on a key that would change nothing, so
  Right on the last tab reaches the pane around the row. A slider is the one
  control whose keys are held down: getting from 40 to 0 is Left with the key
  repeating, and it overshoots. Every repeat past the end would reach whatever is
  around the slider -- a list moving its selection, a tab row switching tabs --
  which is `TextField`'s "Left at column zero is still the field's", for a stronger
  reason.
- **A press on the track puts the thumb under the pointer, and holding the button
  drags it.** The press rather than the click, which is where `Tabs` and
  `Collapsible` differ, because the press is when the thumb must move -- a drag
  starts from it, and a slider that moved on release would draw the thumb in the
  wrong place for the whole of the drag. The press is **not** stopped, so it still
  focuses the slider, the pane's edge rule. The moves and the release are stopped:
  the slider owns the drag, so nothing above it acts on it, which is what
  `05-drag.js` does and is why the router's "a stopped `mouseup` does not cancel
  the derived `click`" exists. The click that follows is stopped too, so a row
  around the slider does not take it as well. Any release ends a drag, whatever
  its button says, so a report that lost its button cannot leave the thumb stuck
  to the pointer. The wheel is not the slider's: a slider in a scroll box changing
  value as the page scrolls past is the web's best-known annoyance, and the wheel
  goes on to whatever scrolls.
- **The column is read against where the layout put the track, and clamped there.**
  The pointer's offset into `track.box` over its width less one, the fraction
  `05-drag.js` uses, so the left cell is the bottom and the right cell the top. A
  captured drag reports columns past either end and off the canvas, which is
  where the ends are -- clamped here rather than by the router, for the reason
  `05-drag.js` gives: a captured report really is outside. Before the first layout
  there is no box, and a press moves nothing.
- **`onMouse` is on the track, not the host, and none of the track's parts ever
  leaves the tree.** On the track, so a press on the readout moves nothing. The
  press lands on one of the track's three parts -- the filled stretch, the thumb,
  the rest -- and bubbles to the track; while the button is held the moves and the
  release go to that part, wherever the pointer is. A part with nothing to draw is
  drawn zero wide rather than taken out, which is what `Tabs` does with a part of
  its rule: a press on the rest of the track that the drag then empties would
  otherwise leave the capture holding an element no longer in the tree, and the
  router bubbles a captured event up the target's own ancestry, which would no
  longer reach the track.
- **The track's width is its basis and the layout's, never its drawing.** Learned
  through `onResize`, the tabs row's rule, and drawn to exactly that many cells.
  With no `width`, the track is `flex-basis: 20` and grows and shrinks: the rest
  of a column, twenty columns in a row with no width of its own, its share of a
  row that is short. A basis rather than its content because what it draws is cut
  to the room it was last given, so a track sized by its drawing could only ever
  stay the size it last was -- the text field's SIG-318 in the other direction:
  narrowed once, it never grew back. `min-width: 0` is what lets it take less than
  it drew last. `width` is the **track**'s columns rather than the whole slider's,
  so four sliders with readouts of different widths can still line their tracks
  up, which is what the demo does; the host's `props` take a width for the whole.
- **The focus: `.sigil-focus` on the thumb, and the thumb fills in.** "Focus on a
  control", below, left the glyphs to this ticket. `○` at rest and `●` focused,
  `o` and `O` in ASCII: the same width, in the cell the thumb already holds, so the
  focus moves nothing and is drawn at every level -- which is the one cue at
  colour level 0, where the role's `inverse` is dropped, and in a pipe. Hollow to
  filled rather than another shape because "filled in" already reads as "this
  one" beside the prompts' `◯` and `◉`. The filled stretch and the thumb are
  `.sigil-accent`, the rest of the track `.sigil-muted`, the tabs' rule and its
  heavy `━` against the light `─`. No new role and no framework-sheet exception.
- **Disabled is a state, and it ends a drag.** The text field's `disabled`:
  `focusable` follows it, the keys and the pointer do nothing, the accent parts go
  to `.sigil-muted`, the readout is muted, and a disabled slider shows no focus
  even if it kept the focus it had when it was disabled. A drag in progress ends
  when the slider is disabled, so enabling it again does not resume a drag nobody
  is holding. At colour level 0 a disabled slider is indistinguishable from an
  enabled one at rest, which is the text field's cost too.
- **One effect draws, and it was two.** `draw()` reads the value and `disabled`, so
  the effect that runs it is what redraws on a write the app makes to either. There
  was a second effect reading the value alone, and the sabotage pass found it was
  dead: the disabled effect called `draw()` too, so it had been tracking the value
  all along. The disabled effect now sets classes and nothing else.
- **`describeSlider()` describes the six keys, the arrows above the rest.** `less`,
  `more`, `much less`, `much more`, `minimum`, `maximum`: short, because six
  entries have to fit an 80-column footer and `decrease by a page` did not. The
  arrows carry priority 1, so a narrow footer drops Page Up, Page Down, Home and End
  first. A helper rather than an option, the collapsible's reason: the router is
  built from the tree the slider is in, so it does not exist while the slider is
  being built.
- **`demos/element/05-drag.js` stays drawn by hand.** Its subject is the router's
  capture, and the root file's rule is that a demo lives with its subject: rebuilt
  on `Slider` it would hide the fifteen lines that show what a component does with
  a press, a move and a release, which is the whole of what it is for. Its doc
  comment and the demos README point at `62-slider.js` as what an app should use.
- **Sabotage: thirty-four, five survivors.** One was a sabotage that changed
  nothing, rewritten and caught; one was a test whose helper turned "no button"
  back into `'left'`, fixed; one was a missing test, the track growing back, added;
  `overflow: hidden` on the track was deleted for surviving; and the dead value
  effect, above. The list is in the history file.
- **Not done:** vertical; Up and Down; the wheel; a `commit` callback on release,
  for a seek that should happen once rather than on every move -- the keys have no
  release, so it would be every key anyway, as HTML's `change` is, and an app that
  wants fewer seeks debounces `onChange`; a range with two thumbs; tick marks under
  the track; a vertical readout or a label inside the slider; snapping the app's
  own writes into the state; and a level-0 cue for disabled.

### A toast: a timed message in a corner, and nothing it takes

`src/components/toast.ts`. SIG-213, split from SIG-191. `showToast(host, opts)` puts
a short message in a corner of the screen that goes away by itself. It is the
modal's arrangement -- appended to the root, `position: fixed`, opaque by filling
itself with blanks -- with the input question answered the other way: a modal has
the keys and the mouse while it is open, and a toast has neither, ever.

- **The corner: four of them, `bottom-right` by default, one stack per corner per
  root.** The default is where a status remark does not cover what the app is
  showing at the top, and it is where the eye already goes for one. A centred
  `top` or `bottom` was not asked for and would be a fifth and sixth stack for the
  same job. Each stack is a `position: fixed` column pinned by the two insets that
  name its corner, made the first time a toast lands there and taken out of the
  tree with the last one, so an app with nothing to say has nothing of ours in its
  tree. The stacks are a `WeakMap` keyed on the root, the modal's per-router list
  for the same reason: two screens do not share one.
- **The newest is nearest its corner, at the foot of a bottom stack and the head of
  a top one.** One rule for both, so the latest message is always in the same place
  and the eye does not have to find the end of a column. It also decides what a
  screen too short for the whole stack cuts off: the far end, which is the oldest.
- **How many: three by default, and a fourth pushes the oldest out rather than
  waiting.** A toast is about something that just happened, and one held back until
  there was room would be news by the time it was shown -- "Saved" twelve seconds
  after the save. `max` is per raise and read when that toast arrives, so a caller
  that wants one at a time says `max: 1`. A pushed-out toast closes with `overflow`
  and its timer is cleared there and then.
- **It never takes the focus, and that is by construction rather than by a guard.**
  Nothing in a toast is focusable, and what it says is two strings: there is no
  `body` element, which is what let a modal's field join its trap, and so nothing a
  caller hands it can bring focusability in. It takes no router -- there is no
  `input` option at all -- so it cannot move the focus, bind a key or add a ring
  entry. The tests drive a real router anyway, because the claim is about Tab's
  default and click-to-focus and neither runs for a handler called by hand: the
  focus is where it was when a toast arrives and when it goes, the ring is the
  same with toasts up, Tab walks the app's rows and only those, and a toast raised
  over a modal leaves the focus inside the dialog.
- **Every mouse report that lands on a toast ends there, the press included.** A
  press left to bubble reaches click-to-focus, which focuses the nearest focusable
  _ancestor_ -- so a toast over a focusable panel would move the focus by being
  touched, which is exactly the opposite of the modal's reason for letting a press
  through. A left click dismisses, which is the one thing somebody pointing at a
  toast can want of it. No key dismisses one: Escape belongs to the app or to an
  open dialog, and a toast with a binding would be a toast that takes keys.
- **The stack keeps the toasts at one width, so there is no gap in it for a click
  to fall into.** The stack box has no background and is hittable over its whole
  rectangle, so a ragged column would leave cells beside a narrower toast where a
  click lands on the stack rather than on the app underneath. The default `width`
  is the same for every toast, so the gap only exists where a caller gives two
  toasts in one corner two widths; recorded rather than closed.
- **Above a modal and below the debug overlay: `z-index: 950`.** A toast raised
  while a dialog is open -- "Copied" from a button inside it -- is still news, and
  being above the backdrop costs the dialog nothing, because a toast takes no key
  and stops every mouse report it is given: a click on a toast reaches neither the
  app nor the backdrop, so the modal's "a click outside reaches nothing under it"
  still holds. Below the overlay so the instrument stays readable over both.
- **A toast is a remark beside the answer, so it reads the quiet axis even though
  it is drawn in `render()`'s tree.** The modal's entry puts a dialog on
  `render()`'s side of the line `output.ts` draws, and a toast sits in the same
  tree; what puts it on the other side is its own shape. **It takes itself away,
  which nothing that is the answer does** -- a table, an error, a dialogue and a
  screen all stay until something answers them. So `mountLevel()` is asked, with
  the toast's `quiet` and `terminal`, which is `MountOptions.quiet`'s precedence
  exactly: `true` hides one, `false` shows one under `--quiet` for a toast the app
  has decided is part of its answer, and unset is the process-wide request. Under
  quiet the toast is built but never attached, no timer is started, and it closes
  at once with `quiet` -- synchronously, inside `showToast()`, because it is closed
  before the caller has the handle and a deferred `onClose` would say so later than
  `open` does. `reduce` changes nothing: there is no motion here for it to take
  away, and a test pins that a pipe and a terminal draw the same toast.
- **What happens to a toast that outlives the frame it was raised in, which was the
  ticket's second question, has three halves.** _Quiet is asked once, when it is
  raised_: a toast already showing when quiet is asked for runs out its own time,
  and one raised under quiet is not one that turns up when quiet is lifted. That is
  the mount's "resolved once, so a gate can only suppress", and re-asking per frame
  would make a toast vanish or appear under somebody who did nothing. _It belongs
  to whatever owner raised it_: `onCleanup()` is called unconditionally, so a toast
  raised in a component body goes when the component unmounts, one raised in an
  effect goes when that effect runs again -- the owner tree's rule for anything
  created in a run -- and one raised from a key handler or a promise, which have no
  owner, runs its course or goes with the renderer, below. That is what lets the ordinary case work: a form that
  closes on save raises "Saved" from its key handler, and the toast outlives the
  form. And _it does not outlive the process_: the timer is `unref()`ed, the
  spinner's rule and the clock's redraw, so a program that has finished exits with
  a toast still showing -- the demo ends under a minute-long one to show it.
- **So `onClose` is a callback and there is no promise.** The clock's entry is why:
  a promise awaited at the top level that nothing will settle exits with code 13,
  and an unref'd timer is exactly that. Nothing should wait on a toast anyway. The
  reasons are `timeout`, `dismiss` (a click, `dismiss()`, `dispose()`, or the owner
  going), `overflow` and `quiet`, and it is called once.
- **A renderer that is disposed takes its toasts with it, the moment it goes.**
  SIG-219. A host with `onDispose()` -- which a renderer is -- gets one
  subscription per toast, so a toast raised from a key handler closes with
  `dismiss` when the renderer goes: its timer is cleared and its corner taken out,
  rather than the timer running out over a tree nobody is drawing. A renderer
  that has already gone calls the handler at once, so a toast raised over one
  closes inside `showToast()`, as a quiet one does; that is why it subscribes
  after the timer starts, or there would be no timer to clear. Closing any other
  way unsubscribes, so a renderer does not hold a toast that has gone. A bare
  element host cannot say when it stops being drawn, so a toast over one still
  runs its course -- harmless, since the timer is `unref()`ed and bounded by
  `timeout`, and `Infinity` starts none. A corner the app takes out of the tree
  itself -- clearing its screen -- is noticed at the next raise there: its toasts
  are closed, which clears their timers, rather than put back.
- **`timeout` is a positive number of milliseconds no larger than 2^31 - 1, or
  `Infinity`.** The bound is the clock's: past it `setTimeout` fires at once, and a
  toast that vanished the moment it was asked to stay for a month is the wrong
  answer silently. `Infinity` stays until it is clicked or dismissed and starts no
  timer, so it is not a long timer but none.
- **The fill is the modal's, copied rather than shared.** Three lines over a `raw`
  node, and the reasons are the modal's: a background colour is dropped at colour
  level 0, so the panel paints blanks the grid counts as drawn, in the terminal's
  own colours. Sharing it would mean a public export from the barrel for two
  readers, because a sibling import in an ejected file goes to
  `@ttylabs/sigil/components`. `.sigil-toast-fill` is the hook for a theme that
  wants a colour behind a toast.
- **The variants are `note()`'s, with `note()`'s role table.** `note`, `info`,
  `success`, `warning`, `error`, and `warning` is `.sigil-warn` so that every one
  lands on a role the sheet already declares. The role is on the panel, so the
  border, the title and the message take it together. Escape sequences are dropped
  from both strings, which is `note()`'s rule too: colour is a role's.
- **Sabotage: nineteen, all caught, each one type-checking.** A focusable panel, a
  press left to bubble, no `stop()` at all, no click dismissal, no timer, no
  `clearTimeout`, no `unref`, quiet ignored, `quiet: false` ignored, no
  `onCleanup`, overflow dropping the newest, a top stack appending, a `z-index`
  under the modal's, no fill, the stack's box left behind, a detached corner put
  back with its old toasts, no `strip`, and `max` and `timeout` unchecked.
- **Not done:** pausing the timer while the pointer is over a toast; a key that
  dismisses; a slide-in, which is the thing `reduce` would then have to switch off;
  centred positions; an action button on a toast, which would need the focus and
  is a modal; a queue; and announcing a toast in accessible mode, which draws prompts
  as lines and has no screen to put a corner on.

### A tooltip: text anchored to an element, on hover or on focus

`src/components/tooltip.ts`. SIG-214, split from SIG-191 with the toast.
`attachTooltip(anchor, opts)` hangs a bubble of text on an element the app already
has, and `placeTooltip()` is the arithmetic that decides where it goes, exported
because a dropdown or anything else that sits beside a box wants the same answer.

- **The keyboard's answer is the focus, and it is not a fallback.** Hover needs
  `mouse.motion`, which is opt-in for the wire cost "The mouse" records -- so in
  most apps, and in every app with no mouse at all, nothing ever knows where the
  pointer is. A tooltip that only hover could show would be invisible to all of
  them. So the bubble shows while the anchor is hovered **or** while the focus is
  on the anchor or anything inside it, after the same `delay` either way, and goes
  the moment neither is true. `contains()` rather than identity, because the
  anchor is often a box holding the focusable thing. One delay for both: what it
  is for is a pointer crossing a toolbar or a Tab passing through one, and both
  of those would otherwise draw a bubble at every stop. What a keyboard-only user
  still does not get is a tooltip on an anchor the ring cannot reach, and the
  component does not make one focusable to fix that: changing the ring is the
  app's call, and a tooltip that quietly added a Tab stop would be a worse
  surprise than one that needs a focusable anchor. This is WCAG 1.4.13's shape,
  and the other two halves of it are below.
- **Hover is read off the `hover` state, and an event is only the reminder to
  read it.** The router writes the state on the whole chain before it tells
  anybody, it is not stoppable, and it is `hovered`'s documented reason for not
  being a signal. What the tooltip subscribes to is `input.onMouse()`, and every
  report that reaches it re-reads the anchor's state: the events reaching a router
  handler are the ones the tree did not stop, so an anchor that stops its own
  `mouseleave` -- which also ends the rest of that leave sequence -- would strand a
  bubble that trusted the event, and the next motion anywhere puts it right. The
  timer asks the state again when it fires for the same reason, which is what
  `should not show for a hover that ended in reports the tree stopped` pins. The
  anchor's own `onMouse` and `onKey` are never touched: assigning one would clobber
  an app's click handler on the button the tooltip describes, and wrapping one is
  undone by the next assignment.
- **The bubble is hoverable, so moving onto it keeps it.** Its own `hover` state
  counts as a reason. Placed flush against the anchor with no gap, a pointer moving
  from one to the other does it in one report, so there is no hide delay to tune.
  That is also what makes the last-resort placement below safe: a bubble clamped
  over the anchor is one the pointer is now over, so it does not flicker.
- **Escape dismisses it and is never stopped.** A tooltip holds no keys, so an
  app's own Escape -- a dialog's, a pager's -- still happens: the binding sees it
  first, hides the bubble or cancels the wait, and lets it go on. Dismissed stays
  dismissed until both reasons have gone and one comes back, or a focus-shown
  bubble would reappear one delay later under a user who just asked it to go. An
  Escape with nothing shown and nothing waiting dismisses nothing, so it cannot
  swallow the next hover.
- **It never takes the focus.** The bubble is not focusable, `show()` moves
  nothing, and a click on the bubble lands on an element click-to-focus leaves
  alone. Pinned on both routes, hover and focus.
- **The bubble is `position: fixed` on the anchor's root, found by walking up.** No
  host argument: the outermost ancestor is the box `fixed` resolves against and the
  one that is laid out, so it is the only right answer and the anchor already knows
  it. Out of flow, so it moves nothing; not inside the anchor's parent, so no
  ancestor's `overflow` clips it. `z-index: 950`, above the modal's `900` so a
  tooltip on a button inside a dialog is drawn over the dialog, and below the debug
  overlay's `1000`. Opaque with no colour by the modal's own fill, for the modal's
  reason. An anchor with no parent at all has been taken out of the tree, and shows
  nothing rather than putting a bubble inside itself.
- **It is placed after the layout, because only the layout knows the two sizes.** A
  fresh bubble starts at the root's corner; the first layout measures it, its
  handler places it against the anchor's box and the root's, and the frame lays out
  again before it paints -- so no frame ever shows it in the wrong place. Following
  the anchor never changes its size: a `fixed` box is offered the room to the right
  of its `left`, and the placement never puts it where that is less than its width.
  A resize builds a fresh bubble, which the next layout places against the new
  screen. The handler is `Element.onLayout` since SIG-221, which the next entry is
  about; it was `onResize` before, which is only asked when the bubble's own size
  moves, so a bubble stayed where it was while a scroll moved its anchor.
- **It follows its anchor through `Element.onLayout`, a hook added for it (SIG-221),
  and not through `onScroll` or `Renderer.onFrame()`.** The bubble's own hook is the
  tooltip's to take, and it is asked after every layout, between the layout and the
  paint: the handler compares the anchor's box, the bubble's size and the root's
  box with what it last placed against, and moves the bubble only where one moved.
  A scroll marks layout, so the frame that scrolls is the frame that re-places.
  The two the ticket offered both fail. `onScroll` is one function per element and
  the `ScrollBox` around the anchor already has it -- and an anchor can sit in
  several scrolling ancestors, none of which the tooltip built. `onFrame()` fires at
  the **top** of a frame, before the layout, so it reads the boxes of the layout
  before the scroll: the frame that scrolled would paint the bubble in the old
  place and nothing would ask for the frame that fixes it. It would also need a
  renderer the tooltip is never handed, which the `onDispose()` entry below
  records it does not take. What this costs is one handler call per layout per
  shown bubble, a walk to the root and four box compares; a frame that lays
  nothing out asks nothing, and a frame that moves no anchor lays out once.
- **Following covers every reason the anchor moves, not only a scroll.** The ticket
  left that open, and the mechanism decides it: the handler compares boxes, so a
  row above that wrapped, a sibling that grew, an animated `top`, a root whose own
  width moved and a scroll are one case. Narrowing it to scrolls would have meant
  hearing scrolls, which is the hook it cannot take.
- **An anchor scrolled out of view hides the bubble and keeps it in the tree.** "Out
  of view" is the anchor's box against `element.clip`, the intersection of every
  ancestor's `overflow`, with no cell left; an anchor taken out of the bubble's
  tree -- a windowed list's row the window dropped -- counts too, since its box is
  where it last was rather than anywhere. Hidden with `visibility: hidden`, which
  paint and the hit test both skip, rather than removed: the hook is on the bubble,
  so a bubble taken out would hear nothing and could not come back when the anchor
  does. `shown` stays `true` and `side` reads `undefined` while it is hidden. An
  anchor partly in view is pointed at by the part that is: a three-row anchor with
  its top row scrolled off has its `top` bubble flip below the rows that are left,
  rather than drawn above the viewport.
- **A bubble whose own size moved is sent back to the corner and placed by the
  layout after.** Its words growing at the right edge left it standing where the
  room to its right was less than it now wanted, so it came out wrapped and the
  placement fitted that wrapped size: measured, `setText()` near the right edge
  gave a two-line bubble with room for one. That was so before SIG-221 too, and
  only `should re-place against the right edge when the words grow` found it.
  The corner is where a fresh bubble is measured, so the layout there gives the
  size a bubble built with these words would have had, and the one after places
  it -- three layouts for that frame, inside `settleResized()`'s four. Asked about
  its size alone and not the screen's, because a screen narrow enough to squeeze
  it is a size that moved, and one that is not is a screen the placement answers.
- **The flip is two flips and a clamp, in that order.** The main axis: `side` where
  it fits, else the opposite side where that fits, else whichever has more room,
  with the preferred side keeping a tie. The cross axis: start where the anchor
  starts, and where that runs off the far edge end where the anchor ends -- which is
  what keeps a bubble beside its anchor in a corner, where both flips happen at
  once. Then clamped inside the screen, which only moves it when neither alignment
  fits, and then it may cover the anchor: covering it beats being cut off, and the
  hoverable rule above keeps that from flickering. The clamp takes the far edge
  first, so a bubble wider than the screen starts at its left edge; the layout's
  own available width already prevents that on the real path, and the order is
  pinned through `placeTooltip()` because that is public.
- **`--quiet` hides it, which is the line `output.ts` draws and not the modal's
  answer.** A tooltip is chrome beside the content -- the anchor it describes is
  still there -- and it draws on its own after a timer, with nobody waiting on it,
  so suppressing it can hang nothing. The modal is the other side of the line
  because it is a dialogue somebody waits on. Asked of `resolveOutput()` at every
  show rather than at attach, because an app builds its tree before `main()` has
  read argv. `quiet: false` is the per-tooltip opt-out, the top of the chain the
  way `MountOptions.quiet` is, for a tooltip an app considers content. `reduce`
  changes nothing: there is no motion to take away, and a delay is a wait before
  one frame rather than an animation.
- **Every timer goes on unmount.** `dispose()` clears the wait, takes the bubble
  out, and unsubscribes the mouse, the binding, the resize and the focus effect;
  `onCleanup()` registers it with the owner the tooltip was attached under, so one
  attached inside a component goes with it. Outside any owner the caller disposes.
  The timer is `unref`'d, the decrypt's rule: a tooltip is no reason for a process
  to stay alive.
- **It does not use `Renderer.onDispose()`, and does not need to.** SIG-219
  checked. A tooltip is never handed a renderer -- an anchor and a router are all
  it takes -- so subscribing would mean a new option for no failure: it is
  attached to an element, usually in a body, so the owner takes it; its Escape
  binding never stops a key, so a router the app keeps loses nothing to a stale
  one; and a wait that fires after the renderer went appends a bubble to a tree
  nobody draws and is bounded by `delay`. The toast and the modal adopted the
  seam because each stops something on the app's router or outlives its raiser by
  design; the tooltip does neither.
- **Sabotage: thirty-six, two survivors, two new tests, and four deletions.** The
  clamp's order and the root's own offset both survived and are pinned now. A
  pinned `width` and `height` on the placed bubble, an equal-props early return in
  `onResize`, a `disposed` flag checked in three places and the Escape binding's
  modifier and paste checks were written and deleted for surviving theirs.
- **SIG-221's sabotage: seventeen, and four survived the first round.** Three now
  have a test: the bubble's size left out of the comparison, which is the
  right-edge growth above; the root's box left out, which is
  `should re-place against a root that narrowed with no resize`; and the corner
  pass's flag never reset, which is the second `setText()` in the growth test. The
  fourth, a screen clause in the corner pass's own question, was deleted rather
  than tested, for the reason that entry gives. The other thirteen were caught as
  written, including the four on the hook itself: not dispatched, its answer
  dropped, collected only on a size change, and `onResize` told on every layout.
- **Not done:** a warm-up that shows
  the next tooltip at once after one has just closed; an arrow pointing at the
  anchor; rich content in the bubble; and announcing it in accessible mode, which
  has no screen to put it on.

### A settled answer goes beside the question or under it, never down its edge (SIG-216)

SIG-210 left this behind: most prompts reserve no columns for their answer, so it
was drawn in whatever the question left. `promptAnswerFits()` and
`promptAnswerSlot()` in `prompt.ts` are the fix, beside `promptTailFits()` and
`promptUnderHead()`, and every prompt that settles to an answer line calls the
slot.

- **It was measured first, at 40 columns under a question as wide as the head
  lets it be.** One column was left, and a word that does not fit is clipped
  rather than broken, so an answer came out as the first letter of each of its
  words, one per row. Every list prompt drew `Show the diff` down the last column
  as `S`, `t`, `d`: `select()`, `multiselect()`, `selectKey()` without `expand`,
  `autocomplete()`, `autocompleteMultiselect()`, `groupMultiselect()`,
  `selectTree()`, `selectRow()`, and `multiline()`'s and `editor()`'s one-line
  summaries. `sort()` drew its whole order that way, five rows for
  `Show the diff, Apply, Skip`, and `commandPalette()`'s `build` was `b`. Every
  field prompt cut the answer to its first character, because its answer was
  written into the `nowrap` field: `text()`, `password()`, `list()`,
  `maskedText()`, `path()`, and `filePicker()`, whose answer went into the
  directory line. `number()`'s answer was a node of its own and one word, so it
  was `1`. A question that left some room had the milder
  form: `Show the / diff` hanging in a 12-column gap, and a field one column short
  of its answer drew `Show the dif`.
- **Where an answer does not fit, it goes under the question.** That is
  `promptUnderHead()`'s row, indented to the message, and it costs nothing while
  the question is asked: the row is empty until it settles, and a row whose
  children are hidden takes no height. Reserving room was refused for the reason
  SIG-210 refused it for `selectKey()`: the longest label, or a whole multiselect
  answer, would take up to half the line from the question for as long as it is
  asked, to make room for something that is drawn once at the end.
- **"Fits" is one line, whole.** `promptAnswerFits(rest, answer)` is true only
  where the answer is no wider than what the head left after the message. A
  threshold was considered and refused. "More than N rows" is a number nothing
  measures. "Narrower than the longest word" keeps `Show the / diff` beside, which
  is readable on its own but in a log of settled prompts reads as a column, not an
  answer. Requiring one line also makes it `toggle()`'s whole-line rule for every
  prompt, and the same arithmetic SIG-210's predicate asks of a tail. Moving never
  makes the answer narrower, because under the question there are always more
  columns than beside it. An answer wider than the line still wraps there, whole.
- **The room is the head that is drawn, not one worked out again.**
  `promptTailFits(message, room, answer)` would have been the obvious reuse, and
  it is wrong here. It lays the head out _with_ the answer reserved, so a question
  that has to wrap reports the answer's own width as the room, while the head
  actually drawn reserved nothing and left one column. So the slot takes `rest`
  from the `headWidths()` call the prompt drew its head with.
- **The field prompts move rather than truncate.** An ellipsis loses the answer,
  which is the one thing the settled line is for. So `text()`, `list()`,
  `maskedText()` and `path()` hide the field when they settle and show the answer
  in the slot, which wraps where a field does not. `number()` already settled into
  a node of its own and only changed which node. `filePicker()` hides its
  directory line, which is cut from the front to fit and is right while browsing.
- **One rule for every prompt, including the two that needed nothing.**
  `confirm()` and `toggle()` reserve their answer, so the slot's answer for them is
  "beside" at every width the head reserves for. They go through it anyway, so that
  where the reservation is not enough the answer moves rather than being clipped.
  `toggle()`'s cap is half the line, so a name wider than that wrapped beside the
  question, and a translated `yes` wider than its hint was broken across rows
  beside it. Both are tests. `selectKey()` uses one slot in both of its layouts, so with the expand
  line under the question an answer that fits on the question's line now settles
  beside it rather than in the line's place. SIG-210's refusal to reserve stands.
- **`date()` and `pickDate()` are the exception, and they already agree.** Their
  field _is_ the answer and settles where it was drawn, and SIG-210's tail rule
  moves it under the question exactly where it would be cut. A field cannot wrap,
  so for them the tail rule and this rule come to the same answer.
- **The table is derived from the barrel.** `prompt-answer.test.ts` keys its rows
  by `PromptName`, the union `prompt-signal.test.ts` was already deriving, which
  moved to `helpers.ts` so that the two tables cannot disagree about what a prompt
  is. Each row is asked four times: under a question that fills the line, beside
  one that leaves room, one column short of fitting, and exactly fitting. A prompt
  exported without a row or a reason in `EXEMPT` fails the type-check. The
  exemptions are the prompts whose picture lives somewhere else: an absolute path,
  a spawned editor, a reserved answer, the engine, and `decrypt()`.
- **Sabotage: sixteen of sixteen caught, each still type-checking.** The breaks were: the predicate
  forced either way, made off by one, and made blind to the answer's width; the
  row unindented; `select()`, `sort()`, `selectKey()`, `editor()`, `filePicker()`,
  `selectTree()`, `toggle()` and `confirm()` each never moving; `text()` settling
  into its field again; `list()`'s row left out of the view; and `selectKey()`
  settling under whenever the expand line had moved, as SIG-210 had it. The
  off-by-one is caught only by the exact-width case and the predicate's own test.
- **Not done.** Accessible mode draws prompts as lines and is unaffected.
  `filePicker()`'s directory line while browsing is still cut from the front,
  which is a tail and a decision of its own rather than an answer. A terminal
  resized after a prompt settled keeps the layout it settled in, as every head
  does, because the widths are worked out once when the view is built.

### Markdown: a subset read here, drawn through the theme (SIG-197)

`src/components/markdown-parse.ts` reads, `src/components/markdown.ts` draws.
`parseMarkdown()` returns a plain tree of blocks and inline runs, `markdownView()`
builds it into elements and `markdown()` is the string facade, the shape `note()`
and `noteView()` already have. `supportsHyperlinks()` in `src/ansi/` and `href` on
a text in `src/element/` are the two pieces it needed below it; the element half
is recorded in that directory's file.

- **The subset is what a README, a changelog and `sigil reference` are made of,
  and everything outside it is shown as written.** Read: ATX and setext headings,
  paragraphs and hard breaks, emphasis and strong emphasis, code spans, fenced and
  indented code, bulleted and numbered lists that nest, tight and loose, block
  quotes, GFM pipe tables, thematic breaks, inline, reference and autolinks,
  images, backslash escapes and eleven named entities plus the numeric ones. Not
  read, and **not dropped**: raw HTML and bare URLs -- and, until SIG-224 read them
  (the entry below), `~~strike~~`, footnotes and task boxes. Dropping a construct the parser does not know loses words the author
  wrote -- a `<details>` block is where a README hides its long answer -- while
  showing it as typed loses only formatting, and is what the source looks like.
  Bare URLs are the odd one out, deliberately: a terminal already makes them
  clickable on its own, so recognising them buys nothing on screen.
- **The one thing left out is a YAML front matter block at the very top.** It is
  data for a site generator, and read as CommonMark it is a thematic break
  followed by a setext heading made of its own keys -- which is exactly what
  `sigil reference` writes at the top of every page it gives a file of its own, so
  the renderer the ticket names as a consumer would have drawn each of them with a
  heading reading `description: ...`. A `---` that never closes is markdown.
- **Emphasis and links are CommonMark's own algorithm, because nothing else gets
  the edge cases right.** A recursive "find the closing `*`" is shorter and wrong
  in exactly the cases the ticket listed as edge cases: delimiter runs with their
  flanking rules, a `]` that looks back for its `[`, closer-by-closer matching with
  the rule of three, no link inside a link. So an unterminated `*` is an `*`,
  `snake_case_name` is one word, `*foo**bar*` is one emphasis, and `***x***` is
  strong inside emphasis -- each pinned. The openers a closer has failed against
  are remembered by the token it stopped at, so a long run of unmatched
  delimiters is not searched per closer. **What is not bounded** is a long run of
  `](` with no space in it, where every `]` scans to the end for a destination:
  measured at about a second for 32 KB of `[a](`. The input is the app's own
  document rather than somebody else's, which is why it is written down rather
  than paid for with a limit that would refuse a long `data:` image.
- **The simplifications are uniform rather than case by case.** A tab is expanded
  to the next stop of four everywhere before anything is read -- CommonMark expands
  only where a column is being decided, and a tab counted two ways in one line is
  how two readers come to disagree. A link reference definition is one line. A
  list is loose when a blank line sits between items or between two blocks of one
  item, which a blank inside a nested list does not count towards, because the
  nested list consumes its own.
- **A word is cut at white space, not at the edge of a run.** A paragraph is a
  wrapping row of one-word elements -- the construction `paragraph()` uses, which
  is how inline styling works with no inline layout -- and `paragraph()` makes one
  element per word _per run_, so `**bold**,` came out as `bold ,`: a gap between
  the bold word and its comma. Here a word may be several pieces in several styles
  with no gap between them. A word in several styles that is wider than its line
  wraps between its pieces, and only a word with a piece that is _itself_ wider
  than the line, every piece of it linking to the same place, is made one text in
  the style of its longest piece: a row of texts breaks only between them, so a
  URL folded over three lines put its full stop on a fourth of its own.

  That used to be every over-wide word, with "in practice that is a written-out
  URL with punctuation after it" as the reason it was harmless, and the reason
  was wrong. Chinese and Japanese put no space between words, so a sentence is
  one word however long it is, and a link or a `**strong**` inside it was merged
  away -- with hyperlinks on, the URL is not written out either, so the address
  was gone altogether, which is the worse of the two mistakes the entry below
  weighs. Found by review. Each of the merge's three conditions has a test that
  fails without it: never merging puts the full stop back on its own line,
  merging regardless of width loses the bold, and merging regardless of the link
  loses the link. What wrapping between pieces costs is ragged lines in a long
  CJK run, since a piece goes whole onto the next line rather than being broken
  at the edge -- a shorter line rather than a missing word, which is the trade
  this entry is about.

- **A link is OSC 8 only where the terminal is known to draw one, and otherwise
  its URL is written after its words.** The cost of each wrong guess is not the
  same size: a hyperlink on a terminal that silently swallows OSC 8 prints the
  words and loses the address, with nothing on screen to say there was one; a URL
  written out on a terminal that could have linked it is longer and complete. So
  `supportsHyperlinks()` is a list of terminals that say yes, an unknown terminal
  is a no, and `FORCE_HYPERLINK` is the override for the rest. Colour level 0 is
  always the written-out form, because it means "write no escape sequence", and a
  hyperlink is one. An autolink does not say its URL twice. A relative link is
  resolved against `baseUrl` and otherwise shown and **never** linked, since a
  terminal has nothing to resolve it against; a `#fragment` is its words alone,
  since it points into a document that is not on screen as one. A URL holding a
  control character is neither linked nor shown: the element would refuse it, and
  a text would draw it with the character dropped -- a URL that is not the one the
  document holds. What OSC 8 cannot carry is percent-encoded.
- **Each word of a link is linked, and the gaps between them are not.** The gap is
  an unpainted cell, so the underline and the link close at each space and reopen
  at the next word. Painting the gaps would mean a link knowing it is several
  elements, which is inline layout under another name. Clicking any word of it
  opens it, which is what a link is for.
- **Every colour is a role, and the three things that are not colours are the
  sheet's three new exceptions.** A heading is `.sigil-heading`, the first level
  with `.sigil-accent` too -- a terminal has one size of type, so six levels come
  out as two looks by default, and a `.sigil-markdown-hN` per level is there for a
  theme that wants six. Code, inline and in a block, and a link are the accent; a
  list marker, the quote bar, a written-out URL and an image's description are
  muted, which is what `outline()` does with its markers. Emphasis, strong emphasis
  and a link are italic, bold and underlined by `.sigil-markdown-em`, `-strong` and
  `-link`, recorded under "Themes" in `src/theme`: they are what the author wrote,
  not a colour, and strong is not the heading role or a magenta heading would take
  every strong word with it. An image inside a link takes the link's style rather
  than muted, so that one element never carries two roles that set one property --
  which the light half of muted (`color: gray`) and the accent both would.
- **A table is `table()`'s classes and is narrowed to fit.** `.sigil-table`,
  `-row`, `-cell` and `-head`, so a theme written for one reaches both. Where
  `table()` lets a long row run past the edge -- a log, where the terminal wraps
  it -- a document is read in the terminal, so its widest column gives up a column
  at a time until the table fits, and the cells wrap. A muted rule goes under the
  heading row, which `table()` does not draw: at colour level 0 bold is gone and
  nothing else tells the heading from the rows. Columns are measured with
  `stringWidth()`, so CJK and emoji line up.
- **Code is folded by columns, not wrapped at a space.** A wrap moves characters,
  and code is what a reader copies. Folded at build time because a string is laid
  out as wide as its widest line, and a terminal wrapping a code line instead
  would start the rest of it at column zero, outside the block.
- **The quote bar is a `raw`.** It paints its character down however many rows the
  quote came to, which a text cannot: it would have to know the height before the
  layout had worked it out. ASCII where `unicodeSupported()` says no, with the
  bullets and the rules.
- **What it cost.** `dist/components.mjs` went from 184,052 B to 200,422 B when it
  landed, the parser and the renderer together -- a measurement of this change,
  not of the tree.
- **Deliberately out.** Multi-line reference definitions, HTML entities beyond
  the eleven, and anything CommonMark calls an extension. A highlight seam for code
  blocks was out here too, and SIG-220 added it; SIG-224 took three of GitHub's
  extensions. Both are entries below.

### Markdown code blocks take the app's highlighter (SIG-220)

`highlight?: (code: string, lang: string | undefined) => readonly HighlightSpan[]`
on `MarkdownOptions`. A document with no code block, or no hook, draws exactly as
it did, and none of SIG-197's tests was edited.

- **`diff()`'s hook with the language beside it, and its types, validator and
  roles.** `HighlightSpan`, `tokensOf()` and `TOKEN_ROLE` from `prompt.ts`, so the
  classes are `sigil-token` and `sigil-token-<token>` and the seven names draw in
  the roles they draw in for a diff: one sheet colours both, which is pinned by a
  test that draws one token through each. `lang` is the first word of the info
  string, which is all the parser keeps, and `undefined` rather than `''` where
  there is none -- an indented block, or a bare fence -- so a hook can tell "no
  language" from a language it does not know. The hook is still called for those:
  a highlighter that guesses is the app's to write.
- **Asked once per block, with the whole block, and the spans cut afterwards.** A
  comment over three lines is one span, for the reason `multiline()` gives. The
  code-unit offsets are carried through `split('\n')` and then through `fold()`,
  whose pieces are consecutive slices of the line, so a token a fold breaks is in
  its style on both rows. A cluster takes the token of the unit it starts at,
  which is `diff()`'s rule.
- **A block the hook marked nothing in is drawn as it was, and in one that it
  marked, the rest is the plain foreground rather than the accent.** The accent is
  the role `keyword` draws in, so keeping it under the tokens would hide every
  keyword in the block. And a block the hook returned nothing for -- a language it
  does not know, a `sh` block next to the `js` it does -- would then be the plain
  foreground too, which is code that no longer looks like code. So "marked
  nothing", including spans wholly out of range, takes the unhighlighted path
  untouched: one accent text, as before. A token with no role, an app's own name,
  is the foreground with its class, as it is the line's colour in a diff.
- **A highlighted row is a row of fixed-width `pre` texts, one per run**, which is
  `diff()`'s construction and its reason: one element resolves one style. An empty
  line keeps a row by holding an empty text, since a row with no children lays out
  at no height. `.sigil-markdown-code-row` is the new hook, named in the sheet's
  vocabulary comment; nothing was declared, so the sheet's exceptions are as they
  were.
- **A hook that throws throws out of `markdown()`, a span out of range is clipped,
  and a bad token name is refused with `PromptError`** -- `diff()`'s three answers,
  taken rather than restated. The hook is the caller's code, and a renderer that
  swallowed its failure would draw a document whose code is quietly uncoloured,
  which is the failure nobody can see.
- **The string path is the tree's.** `markdown()` renders `markdownView()`, so
  there is one implementation and a test reads the classes off the tree directly.
- **Inline code spans are never handed to the hook**, because they carry no
  language, and guessing one from a word is a grammar's job. They stay the accent.

### Markdown: GitHub's extensions (SIG-224)

Task lists, strikethrough and footnotes, beside the pipe tables SIG-197 already
read. All four are on by default and there is no switch.

- **On by default, because every one of them falls back to what was typed.** A
  CommonMark-strict document changes meaning under GFM in exactly these four
  places, and in each the drawing still shows the source's own characters where
  it cannot do better. An ASCII task box is `[ ]` and `[x]`, the tildes stay round
  a strikethrough, and a footnote reference with no definition is its brackets.
  The documents a CLI renders are READMEs, changelogs and release notes, and those
  are written on GitHub and previewed there. So an opt-in would be a switch whose
  off position renders them worse than their author saw them. Pipe tables were
  already on without one. A `gfm: false` is cheap to add if a caller turns up who
  needs CommonMark-strict.
- **A strikethrough keeps its tildes on every terminal, and the line is drawn as
  well where colour is.** SGR 9 is dropped at colour level 0 along with every
  other attribute (`src/style`, "Level 0 is plain text"), and level 0 is a pipe
  and `NO_COLOR`. Above level 0 there is still no way to know: no terminal answers
  a query about SGR 9, and one that does not draw it ignores it silently at full
  colour, so it cannot be told from one that does. Struck-out words with no mark on them say
  the opposite of what their author wrote. That is the one failure a reader cannot
  detect, so the tildes are not conditional on anything. This is the hyperlink
  entry's argument again, with the same lopsided cost: a redundant mark against an
  inverted meaning. The tildes are `.sigil-markdown-strike-marker`, outside the
  struck run, and an app that knows its terminal can write `display: none` for
  them, which is pinned. They are **muted**, because in the text's own colour a
  struck `--legacy` read as three pairs of tildes: SGR 9 draws its line at about a
  hyphen's height, so the flag's struck dashes looked like a third pair between the
  real ones, and a deprecated flag is the commonest thing a CLI strikes out.
  Muting them makes them read as markup, the way the footnote reference and a
  written-out URL already do. Inside a link they keep the link's style instead,
  the rule an image follows, because muted and the accent both set a colour. `markdownText()` keeps them for the same reason, and so
  does an image description built with it: plain text has no line to draw, so
  `a ~~b~~` is `a ~~b~~` there, where dropping them as formatting made it `a b`.
  The rule is `strikethrough: true` rather than
  `text-decoration: line-through`, because that shorthand also resets `underline`,
  and a struck link lost its underline. It is the sheet's fourteenth exception
  (`src/theme`).
- **Two tildes, never one.** GitHub takes `~one~` as well. In what a CLI prints,
  one tilde is "about" (`~5s`) or a home directory (`~/.config`), and two of those
  in a paragraph would strike out everything between them. Three or more is text.
  Otherwise it is emphasis's own algorithm: the same flanking rules as `*`, matched
  closer by closer. The rule of three cannot apply, since two and two is never a
  multiple of three. A guard for it was written, failed no sabotage, and was taken
  out as dead code.
- **A task box is read off the start of an item's first paragraph and nowhere
  else.** It is taken from the paragraph rather than from the line, so an item that
  opens with a heading, a quote or indented code is not a task, and a `[x]` mid-sentence or
  outside a list stays text. It has to be followed by white space and something
  else, so `- [x]` alone is text. The parser carries it as `checked` on the list,
  one entry per item and `undefined` for one that is not a task, and only on a list
  that has a task. A list without one is the same object it was, and no test of
  SIG-197's had to change for it. It is read before inline content, so it beats a
  link definition with the label `x`, which is GitHub's order.
- **The box takes the bullet's place, and comes after a number.** GitHub hides the
  bullet of a task item, and `• ☐` is two marks for one item. A number can be what
  a step is referred to by, so it stays, and the boxes are a column of their own
  after it. An item in that list that is not a task keeps the column empty, so
  every item's text starts in one place. The glyphs are `☐` and `☒`. Neither is an
  emoji, while `☑` has an emoji presentation that a terminal can draw two columns
  wide. And `☒` is literally a box with an `x` in it, which is what was typed. In
  ASCII they are `[ ]` and `[x]`, three columns against a bullet's one, so an
  unordered list's markers align left rather than right. Open is `.sigil-muted` and
  ticked is `.sigil-success`, both of them roles, and the glyph says which as well.
- **A footnote reference is `[1]`, numbered by where the document first refers to
  it, and the notes go under a rule at the end.** Superscript digits are a third
  of a cell high, and a reference exists to be seen. The parser numbers them. It
  appends one `footnotes` block, so a consumer of `parseMarkdown()` gets a
  self-contained tree rather than a map to join. A note may refer to another, so
  the notes are read in number order until nothing new is numbered. A reference
  with no definition is its brackets, which is what a reference link to nothing
  already does. **A definition nothing refers to is still drawn**, numbered after
  the rest. GitHub drops it, but SIG-197's rule is that a construct is never
  dropped, and a misspelt reference would otherwise lose the note's words with
  nothing on screen to say so. A definition can interrupt a paragraph. Without
  that, `[^1]: One` on the line after `[^2]: Two` became lazy continuation text of
  the note above it.
- **A reference carries only its own classes.** Inside a link it would otherwise
  take the link's underline and accent, and its `.sigil-muted` would be a second
  role on one element, the conflict the image-in-a-link entry avoids. So the link
  closes before `[1]`.
- **A table is now drawn with `table.ts`'s pieces.** `tableWidths()` measures the
  columns and `tableRowView()` builds every row, each cell a `TableCellView`
  (SIG-212) holding the wrapped words. A markdown table is no longer a second
  construction beside `table()`, only the same rows with two additions: narrowing
  to fit, and the rule under the heading. Every SIG-197 table test passed through
  the change unedited. The GFM checklist was already settled there: the alignment
  row, inline markup in cells, `\|`, a table wider than the room, and `─` with a
  `-` fallback. Each one is pinned now, including the right alignment of every
  line of a wrapped cell. There are still no vertical borders, for `table()`'s
  reason.

### Line forms that list, browse, sort and search (SIG-228)

`selectRow()`, `groupMultiselect()`, `sort()`, `date()`, `pickDate()`,
`selectTree()`, `directoryTree()`, `filePicker()`, `autocomplete()` and
`autocompleteMultiselect()` take `accessible`; what each is as a line is under
"What each prompt is as a line" above. Tests are in
`test/components/prompt-accessible.test.ts`, and all ten left `DRAWN_ONLY`.

- **The engine is published, under SIG-227's names.** `sigil add` rewrites
  `./prompt.js` to `@ttylabs/sigil/components`, and `test/registry.test.ts` fails
  an ejected file that imports a name the barrel does not export, so a prompt in
  a module of its own can only reach the engine through the barrel.
  `runLinePrompt()`, `promptAsLines()`, `promptLineQuestion()` and
  `PromptLineForm` are SIG-227's; this added `promptLineChoice()` (`select()`'s
  numbered list and its reading of a number, as a form), `promptLineList()` (the
  list alone) and `promptLineNumbers()` (`multiselect()`'s reading of numbers and
  ranges), with the types `PromptLineChoice`, `PromptLineRead` and
  `PromptLineReply`. One reading of `3`: `select()`'s and `multiselect()`'s own
  line forms are rebuilt on the same three, not beside them.
- **A reply can lead to another question.** `read()` may return a form, and
  `runLine()` asks it under the reply that led to it, with nothing taken back.
  Browsing, going back up and searching again are each that, inside **one**
  `runLine()`, so there is one router, one abort listener and one Ctrl-C the
  whole way. A chain of separate prompts would hand stdin back between steps,
  and a key typed in the gap, Ctrl-C included, would go nowhere.
- **The first form may have to read first.** `runLinePrompt(opts, () => form)`
  calls the function once the terminal is checked and the keys are bound, writes
  `lead` (the question) at once, and queues what is typed behind the read. So a
  directory or a branch that is slow to read never holds Ctrl-C, Escape or an
  abort behind it -- `filePicker()`'s freeze, which `should be cancelled by
  ctrl-c while the read is still out` pins. A function that throws rather than
  rejecting is refused before anything is written, which is how a malformed tree
  item is refused before a line of the question.
- **The signal table waits for a line form to have asked.** In the line run,
  `asked()` waits for the output to stop moving rather than for a tick, because
  `filePicker()` and `directoryTree()` write their list once a directory read
  lands, and an abort and the Ctrl-C it is held to must land on the same
  transcript. Their rows read `test/debug/`, a directory of one file, so the read
  is well inside the timeout row's 20ms. The drawn run is unchanged.
- **Not done.** Dotfiles toggled from inside `filePicker()`; sorting
  `selectRow()`; saying `pickDate()`'s highlighted days; a flattened view of a
  small static tree, which would read better than levels and would be a second
  rule to learn. The `AccessibleOptions` comment and the `runPrompt` reason in
  `DRAWN_ONLY` were left word for word as SIG-227 has them, so the two branches
  merge without a conflict there; both want a word about these ten afterwards.

### Tab in a line form: keys a form takes itself (SIG-232)

`path()`'s line form completes on Tab; what each Tab does is under "What each
prompt is as a line" above. Tests are in `test/components/prompt-accessible.test.ts`,
under `a line path() completing on Tab` and `a line form with keys of its own`.

- **The engine asks a form about a key before it acts on one, and that is the
  whole addition.** `PromptLineForm.key(k, { reply, repeated })` is optional and
  is asked about every key the queue would press, Enter included, in the order
  typed. Returning nothing hands the key to the engine, which then does exactly
  what it did before; returning `PromptLineKeyDone` -- even `{}` -- takes it.
  `insert` adds to the end of the reply as typing does, through `fit` and `echo`,
  and `lines` are written under the reply, after which the question and the reply
  so far are written again. Those two are the only things a key can do to the
  reply, because they are the only things a line can do without taking something
  back: there is no way to replace or shorten the reply from a handler. (SIG-241
  added a third result, `query`, which asks a question of one key and changes
  the reply not at all -- below.) A form with no `key` is
  pressed through the same synchronous path as before, with nothing awaited, so
  every existing line form is untouched: the one line-form test that changed is
  the one that asserted `path()`'s Tab did nothing. Published as `PromptLineKeyAt` and `PromptLineKeyDone` beside
  `PromptLineForm`; no existing name changed.
- **`repeated` is the engine's, not the form's.** A second Tab is "the same key
  as the last one, with nothing between", and only the engine sees everything
  between: a paste, which a handler is never asked about, and a key some other
  part of the form took. So it compares name and modifiers with the key pressed
  before it in this question; any other key between breaks the run, and a paste
  or the next question clears it. A form counting its own Tabs would count two Tabs
  with a paste between them as two in a row.
- **A Tab waits for its read, and what is typed after it waits behind it.** The
  drawn field lets an editing key past a pending read (`ACTS_ON_LIST`) because it
  redraws the field from the value as it is when the read lands. A line cannot:
  what a Tab adds is echoed where the cursor is, so a character typed after the
  Tab and echoed before the read landed would sit in front of the completion it
  came after. The one-key-at-a-time queue is the rule that keeps the transcript
  in the order typed, and the handler is in it. Ctrl-C, Escape with `back`, an
  abort and the end of input are answered outside the queue as before, so a
  stalled directory never holds them, and a handler that resolves after one of
  them is dropped (`settled` is asked after the await). A handler that throws or
  rejects fails the prompt with what it threw and finishes the line, as a
  `validate` that throws does.
- **Tab with no candidates says `No matches`, the one place this parts from
  readline.** Bash rings the bell and writes nothing. A bell is a control
  character that a screen reader does not reliably announce, and nothing at all
  leaves a screen-reader user unable to tell three things apart: no candidates, a
  Tab that was ambiguous and wants a second, and a read still out. A sighted user
  of the drawn field is told -- `No matches` is drawn under it -- so saying it is
  parity rather than an addition, and it is the catalog entry the drawn field and
  `filePicker()`'s line already use, so no new key. It is said on the first Tab
  because a second would only be nothing again. The ambiguous first Tab stays
  silent, as the ticket asks: a second Tab is the documented way to hear the
  list, and announcing "several" on every first Tab would be a line per keystroke
  for the person who knows what they are typing.
- **Only ever by adding, so case stays as typed.** On a caseless file system a
  candidate can agree with the segment in all but case, and the drawn field
  rewrites the segment in the candidate's spelling. Here the segment was echoed,
  so it stays, and only what comes after is the candidate's. The answer then
  names the same file on that file system either way.
- **One `completer()`, not a copy.** The drawn `path()` had its candidate list,
  its completion and its Tab as closures over its own field; they moved to a
  module-level `completer(base, filter, flavour)` that both forms build once per
  prompt, and the drawn Tab now asks it too. `labelOf()` is the drawn row's label,
  which the line's list uses, so a directory is listed with the same separator in
  both. The drawn `path.test.ts` did not move.
- **Not done.** Completion in any other line form; the engine is ready for one.
  Shift-Tab is not told apart from Tab, as in the drawn field. The threshold
  before a long list was, and is SIG-241's, below.

#### Asking before a long list (SIG-241)

A directory of thousands is thousands of lines on a second Tab, read out one at
a time with no way to stop it short of Ctrl-C. Bash's readline asks first, and
so does this. Tests are under `a line path() asking before a long list` and in
`a line form with keys of its own`.

- **The engine learned to wait for one key, and that is the whole of the engine
  change.** `PromptLineKeyDone.query` is a `PromptLineKeyQuery` -- `ask`, the
  line, and `answer(k)` -- asked under the reply, after `lines` and `insert`, in
  place of the question and reply being written again. Until a key answers it,
  the next key goes to `answer()` and to nothing else: not the reply, not the
  form's `key`. `answer()` returns the lines to write, after which the question
  and the reply are written again -- an empty list writes only those -- or a
  string, which is a complaint: written on a line of its own, then the query
  asked again, still waiting. The answering key is **not echoed**, readline's
  rule, because it answers the question and is not text in the reply; and it
  counts as a key between, so the next Tab is a first one, not a repeat. Optional
  and new, so every form that never returns a `query` runs exactly as it did, and
  no test of an existing form moved. Published as `PromptLineKeyQuery`; no
  existing name changed.
- **Ctrl-C, an abort and the end of input behave as they do everywhere else**,
  because they are answered outside the queue as before: the prompt rejects, the
  question's line is finished with a line break and left where it is, and an
  async `answer()` that resolves afterwards is dropped by the same `settled` check
  as a handler. **Escape is the one key that changes meaning**, and only while a
  query is on screen: with `back` it would leave the whole prompt, and a question
  on screen is what Escape is dismissing, so the query gets it. Before the query
  is written -- a Tab whose read is still out -- Escape goes back as it always did,
  since nothing is on screen to dismiss.
- **A paste sets the query aside rather than answering it.** A paste is text and
  not a key, so `answer()` is not asked; the query's line is ended, the question
  and the reply are written again, and the paste is typed onto the reply, so
  nothing pasted is lost. Someone pasting a path is supplying the answer, not
  asking for the list.
- **The threshold is 100, readline's `completion-query-items`, with its
  comparison: at 100 or more it asks.** So a directory that makes bash ask makes
  this ask too, and the two tests are 99 lists and 100 asks (101 too, to say the
  count is the count). **It is not an option on `path()`**, which the ticket asked
  to be considered: how much a person is willing to hear read out is the person's,
  not the app's -- readline keeps it in the user's `inputrc` rather than in the
  program -- and an app has nothing to choose it with that the default does not
  already know. The same reasoning that made `SIGIL_ACCESSIBLE` a variable; a
  variable for this was not added, since nobody has asked for one.
- **The question is `confirm()`'s vocabulary, not readline's `(y or n)`.**
  `Display all {0} possibilities?` is a plural (`__n`), and the hint is
  `confirmKeys(__`y/n`, false)` -- `(y/N)` -- so the keys accepted are the ones
  the hint names, translated, with English beside them, and no new catalog entry
  is needed for them. The capital says Enter is the default, and **the default is
  no**: Enter is the key pressed by habit, and the answer it gives should be the
  one that does not read out thousands of lines.
- **Which keys answer.** `y` and Space list, as in readline. `n`, Escape and
  Backspace list nothing -- Backspace is readline's `RUBOUT`, which is the byte the
  Backspace key sends -- and so do the Delete key and Enter. A modifier makes it a
  different key, `confirm()`'s rule, so Ctrl-Y is not yes. **Any other key is
  refused** with `confirm()`'s own `Answer y or n` and the question asked again.
  Readline rings the bell and keeps waiting, and a bell is what a screen reader
  does not reliably announce -- `No matches`'s reason -- so the refusal is said.
  Refused rather than read as no, because a letter typed by someone who had not
  yet heard the question is not an answer to it; and refused rather than handed
  on to the reply, because Enter and Tab are keys too, and an Enter that submits a
  reply the person was still completing is the worse surprise.
- **Nothing here is drawn**, SIG-177's rules: the question is a line of plain
  text, the complaint another, and `should write exactly the question, then the
  list or nothing, and no sequence` reads the bytes.
- **Not done.** A pager for a list that is asked for: readline pages it with
  `--More--` when `page-completions` is on, and a pager is a redraw. A setting for
  the threshold, for the reason above.

### Focus on a control: the element is told, and one role shows it (SIG-278)

`src/element/index.ts`, `src/theme/index.ts`. Every Phase 9 widget -- the form
controls (SIG-199), the list (SIG-280), the table (SIG-281), the tree (SIG-282),
the text area (SIG-283), the menus (SIG-285) and the slider (SIG-286) -- has to
show which control the keys go to, and the repository had two answers that
disagreed. The modal's buttons read `input.focus.current` in an effect and wrote
`[ Yes ]` in the accent; the collapsible title, the tab row's active label and the
text field's caret each had a `:focus` rule in the framework sheet, the sixth,
eighth and ninth declared exceptions to the role rule, all three `inverse`. A
widget built next would have picked one at random, and the sheet was gaining an
exception per widget. This is the one answer, and every widget below follows it.

- **`Element.onFocusChange` tells the focused element, so a control needs no router
  to know.** `setState()` calls it whenever the `focus` state flips, which is the
  moment `:focus` starts or stops matching, so a control drawing its focus from it
  and a selector matching it are keyed on one state. They cannot disagree while
  the handler returns; one that throws before it has drawn leaves its drawing
  stale until the state flips again, which is the handler's own, and for focus the
  router moves the state, `:focus` and the router still agree -- review round 1
  found the first wording of this promised more, and that a throw used to break
  the router too. A handler is told only once the router's move has committed, and
  may move the focus itself with the router's `focus()` but not with `setState`:
  "A focus handler is told after the move has committed" in `src/element` has the
  rules. A Tab, a click and an app's
  `focus()` all reach it, because all three go through the router's one `focus()`,
  which is what sets the state -- the same three routes the modal's effect was
  written to cover. The tabs entry above recorded the gap in so many words: "there
  is no `onFocus` to toggle a role class from". It is one handler property beside
  `onKey` and `onPaste`, with their one-function rule.
- **A router at build time was the other answer, and it is refused.** Every
  element component so far -- `TextField`, `Tabs`, `Collapsible`, `ScrollBox` -- is
  built with no router, rendered by `renderToString()` and tested without one. A
  router handed in through context from the app runner (SIG-276) would make each
  control behave one way inside the runner and another outside it, or carry both
  mechanisms -- two answers again, inside one component. So the runner owes this
  nothing: it needs no context for focus, and a control works the same in a
  runner, under `openModal()` with an element host, and in a test.
- **`.sigil-focus` is the eighth role, and it is `inverse`.** The three `:focus`
  rules were one declaration said three times, which is the role rule's own
  definition of a role: a declaration two built-ins share belongs on one. A theme
  now restyles every control's focus with `.sigil-focus { inverse: false;
  text-decoration: underline }` where it had to find three compound selectors,
  and `should restyle the focus of every control with one rule` asserts exactly
  that. `inverse` because it was already the answer three times and it is an
  attribute, right on a light terminal and a dark one alike. The sheet's
  exceptions go from fourteen to eleven, and the rule "every rule here is
  `(0,1,0)`" is true again, since the three retired rules were the only compound
  ones. **Decided by Chris**: a role is vocabulary a theme writes against, so
  adding one was his call, and he made it.
- **Why not a `:focus` selector: the component puts the role on the part, because
  no selector can find it.** A `:focus` rule matches the focused element itself,
  and the part that shows a control's focus is usually below it -- the active tab
  label is two levels under the focusable row, the caret one under the field, a
  list's current row deeper still. Reaching it means a descendant rule, and the
  generic one, `:focus .sigil-focus-mark`, also matches the mark of every control
  nested inside a focused one: a checkbox in a list row while the list has the
  focus, every field of a form inside a focused scroll box. CSS has no way to say
  "the nearest focusable ancestor", so no rule written in the sheet can stop that.
  A child combinator avoids the leak only for marks one level down, which the tab
  row's active label already is not. A rule per widget, keyed on that widget's own
  class, does not leak -- that is what the three retired rules were -- but it is
  one more exception to the role rule for every widget, and it still cannot draw
  anything at colour level 0: there are no pseudo-elements and no `content`
  property here, so a selector can only restyle, never add a marker. `:focus-within`
  is not supported by the selector engine (its states are `:checked`, `:disabled`,
  `:focus` and `:hover`), and it would not help if it were: it matches every
  ancestor of the focused element, which is the same leak from the other side --
  a focused checkbox inside a list would mark the list as well. Told rather than
  matched, the class is on the one part and nowhere else.
- **The shipped themes leave it alone.** A theme is a palette, and the focus is
  the terminal's own two colours swapped, which is the same under every palette:
  `themes.test.ts`'s seven roles are the ones a palette is a value for, and the
  eighth comes from the framework sheet under all of them. One overlap is known
  and left: `MONO` draws `.sigil-error` as `inverse`, so under `MONO` a focused
  part and an error look alike.
- **At colour level 0 a focus is content, in a blank the control already reserves,
  drawn at every level.** Degradation drops `inverse` with every attribute, so a
  role says nothing there. The precedents are the modal's `[ Yes ]` against
  `  Yes  ` and the prompts' `❯` in a pointer column that is `visibility: hidden`
  until its row is active: the marker takes the place of a blank, so the focus
  moves nothing, and it is drawn at every level, so the control needs to know
  nothing about the level -- the badge's level-0 brackets are decided from a level
  handed to it, which a control in a tree is never handed. It comes from the same
  `onFocusChange`. A control whose focus has no blank to stand in -- a tab label,
  a collapsible title, a caret -- shows no focus at level 0, which is the cost
  the three retired rules already recorded and is not widened here.
- **What each widget does.** Provisional where marked, since each ticket may meet
  something this one could not see:
  - **Button** (SIG-199): brackets in its padding, `[ OK ]` against `  OK  `, and
    `.sigil-focus` on the label. When the modal moves onto `Button` its focused
    button changes from accent to the focus role -- a visible change, and decided:
    Chris accepted it.
  - **Checkbox, switch**: `.sigil-focus` on the label, which is the part a reader
    looks at; the value marker (`◉`/`◯`, the switch's states) says the value and
    never the focus. At level 0, the pointer column.
  - **Radio set** (one focusable group): `.sigil-focus` on the highlighted
    option's label, and the pointer column on that option.
  - **List, table, tree** (SIG-280 to SIG-282): the current row is content -- the
    pointer `❯` -- whether or not the widget has the focus, so an unfocused pane
    still shows its selection, and `.sigil-focus` goes across the current row
    while it does. Done for the list by SIG-280, on the row box the table and the
    tree draw through as well. At level 0 a focused pane and an unfocused one look alike: a
    recorded cost, since the pointer is already spent on the selection.
  - **Text area** (SIG-283): `.sigil-focus` on the caret, as `TextField` does; no
    caret at level 0.
  - **Menus** (SIG-285): `.sigil-focus` and the pointer on the highlighted item;
    a menubar's open title takes the role.
  - **Slider** (SIG-286): `.sigil-focus` on the thumb; at level 0 the thumb's
    glyph swaps for one of the same width. Settled there: `○` fills in to `●`,
    `o` to `O` in ASCII -- "A slider", above.
- **`:focus` is still the app's.** Nothing changes for an app writing
  `.panel:focus { border-color: cyan }`; the selector, the state and its
  invalidation are as they were. The framework sheet simply has no `:focus` rule
  of its own any more.
- **Moved onto it here, and tested where they were.** The collapsible title, the
  tab row and the text field each set the role from `onFocusChange`, and their
  existing focus tests pass unchanged through the new path, which is what says
  the look did not move. New: `should tell an element its focus changed when the
  state flips, and only then`, `should tell both ends of a move, in the order the
  states change`, `should move the focus to the new active label while the row
  has the focus`, and the one-rule theme test; and from review round 1, `should
  leave one element focused when a handler moves the focus during a move`,
  `should let a blur handler take the focus back, which is a focus trap`, `should
  finish a move and tell the other end when a handler throws`, `should still tell
  the focus handlers when the scroll a move caused throws`, `should go on telling
  elements their focus after a handler threw`; from round 2, `should give up on a
  cycle and still tell the elements it left behind` in its place, beside the
  refusal, chain, bounce, latch and cross-router tests in `test/input/input.test.ts`
  and `test/element/element.test.ts`; and from round 3, the two tests of the tree's
  mark callback, refused and moving the focus.
- **Sabotage: nine, nine caught.** The role rule deleted (six failures); the
  dispatch removed from `setState()` (eight); dispatched for every state, and
  dispatched before the state changed (one each, the element test); each of the
  three components' handlers removed (two, one and three); the tab row's toggle
  in `sync()` removed, and its focus flag never set (one and three).
- **Review round 1: the hook ran inside the move, and a tabs test could not see a
  class left behind.** A handler that moved the focus left two elements focused,
  a trap could not hold, and a throw left `:focus` and `current` apart; the fix is
  the queue in `src/element/focus.ts`, recorded in `src/element`. Its sabotages:
  the original inline call and unheld commit restored (four failures); the hold
  alone removed (three); the queue alone removed (four); a handler's throw left
  uncaught (four); the turn-time check removed (one, the trap); the commit's throw
  left uncaught (one); the bound removed (the bounded test hangs). The tabs test
  asserted on the frame, where the label it left is muted and an SGR is written as
  a difference from the cell before, so `sync()` adding the role and never taking
  it off passed it on a move to an earlier tab; it now asks the labels' classes in
  both directions, and that sabotage fails it.
- **Review round 2: what wrote the focus without going through `focus()`.** A
  direct `setState('focus')` during a move, a bound that gave up on a long chain
  and left an element deaf, one queue shared by every router, and a latch a throw
  could leave set. All four are in `src/element`'s entry, and the rounds and their
  sabotages are in its history file.
- **Not done:** the modal onto the role, which is SIG-199's when `Button`
  replaces its inline buttons; level-0 markers for the three existing controls,
  which have no blank to put one in; and `:focus-within`, which would not solve
  this, as above, and which nothing has asked for for any other reason.

### A list view: a cursor and a selection by key, over a windowed scroll box (SIG-280)

`src/components/list-view.ts`. A scrolling list of rows with a current row and
keys to move it, as one focusable element -- what a file manager, a log viewer,
`k9s` and `lazygit` are mostly made of. It is two layers, and the lower one is
published because the table (SIG-281) and the tree (SIG-282) are to stand on it.
How each question was settled, the probes and the sabotage pass are in
[docs/history/a-list-view.md](../../../../docs/history/a-list-view.md).

- **It is `ListView`.** The ticket's own suggestion, and the alternatives were all
  taken: `list()` is the prompt that reads a line as an array, `select()` is a
  prompt, and the outline entry above records why one name over a prompt and an
  element is a type that depends on its argument. `List` beside `list` in one
  barrel would differ by a capital, which is a name a reader gets wrong. PascalCase
  because it is an element component, as `ScrollBox`, `TextField` and `Tabs` are.
- **The current row is a key, and multiple selection is a set of keys.**
  `current` is `K | State<K | undefined>` and `selected` is
  `Iterable<K> | State<ReadonlySet<K>>`, the value-or-state shape `Tabs`' `active`
  and `Collapsible`'s `open` have: a value is where it starts, a `State` is the
  state itself, which the keys and the mouse write and the app may write. A key
  defaults to the item, which is right for strings; data fetched again names its
  own with `key`. A single list keeps `selected` empty, because there the current
  row _is_ the selection -- two answers to "what is selected" in one list would be
  two answers to disagree. `selected` is replaced on every write, never mutated,
  since a `State` hears a new value and not a changed one.
- **The selection survives the data changing, by four rules in one place.**
  `setRows(keys, disabled)` settles the cursor: on its key wherever that key now
  is; on the row that took the place of a key that disappeared, or the one before
  it at the end, which is where a reader's eye already is -- not the top; off a row
  that became disabled, to the nearest that is not; and **left on its key** while
  there is no row to be on, so a filter that matched nothing and is cleared finds
  the cursor where it was. And the selection is **never pruned** by `setRows()`: a
  row a filter hides or a collapsed tree node hides is not a row that was deleted,
  so pruning would untick it behind the reader's back -- the searchable multiselect
  entry's "ticks that outlive the filter", for the same reason. An app that deleted
  a row and wants it unselected writes `selected`. Two rows with one key throw,
  because a key is what the cursor and the selection mean by a row.
- **Rows are a render function over `ScrollBox`'s windowing, keyed.** `row(item,
  key)` returns an element or a string, and only the rows in view are built:
  ten thousand rows are a few dozen elements. What the scroll box lacked was
  identity -- it kept a built row by its _index_, so a re-sort showed the old rows
  in the new order. `ScrollRows.key(index)` is the one addition: a built row is
  kept while its key is anywhere in the window, at whatever index, and built again
  when a key it has not seen arrives, and the window's keys are part of the
  unchanged-window guard so a `resync()` after a re-sort rebuilds what moved. The
  list keys a row on its key and its item **together** (a token per key, replaced
  when the item is a different object), so a row is rebuilt exactly when its item
  was replaced -- immutable updates are how a live update reaches the screen, and
  `listControl(list).refresh()` drops every token for data changed in place. The
  cursor and the selection never rebuild a row: they are classes on the row box
  around the app's content, `is-current` and `is-selected`, set from an effect.
- **A row is built under an owner of its own, in the scroll box, for everyone.**
  A row built by a wheel notch ran inside `scrollTo()` with no owner at all, so an
  effect in it -- a component in a row, a cell bound to a signal -- was never
  disposed. `ScrollBox` now builds each row under a branch of the owner it was
  built in, untracked, and disposes it when the row leaves the window; a row whose
  build throws disposes its own branch. That is `For`'s rule, and it is in the
  scroll box rather than the list so a table or a tree drawing rows through either
  gets it. What it cost: `components/scroll-box` imports the renderer now, 136,485
  B to 174,349 B over 28 modules, under the ceiling it already had; the element
  components beside it were already paying for the renderer.
- **The view follows the cursor, and only the cursor.** Every move reveals the
  current row with the arithmetic of a fixed row height -- no row needs to be built
  to be scrolled to -- and an update that does not move the current row (its key
  and its position both unchanged) does not scroll. So a wheel scroll away from the
  cursor is not snapped back by the next live update, while a re-sort that carries
  the current row elsewhere is a move and is followed. A reveal asked for before
  anything laid the list out waits for the scroll box's `onResize`, so a list that
  starts with `current` on row 300 opens showing it. An offset past the end of a
  list that shrank is brought back inside it.
- **Finding: filtering is the app's, and type-to-find is opt-in.** A filter field
  is a second focusable thing with its own keys, layout and editing, and
  `TextField` and `rankBy()` already exist: the items are a `Computed` over the
  field and the data, and the list sees only that its items changed (the demo does
  exactly that, and puts the cursor on the best match when the query changes --
  where the cursor goes on a filter is an app's call). Type-to-find costs no space
  and is worth having, so `find: true` turns it on: a printable key moves to the
  next row whose `label` starts with what was typed in the last second, one letter
  pressed again steps through the rows it begins, and a run of one letter that
  matches nothing as a word steps through that letter. **Off by default** because a
  list that claims letters outranks every fallback while it has the focus, and the
  runner's `quitKey` is one -- `q` would stop quitting the app the moment a list was
  focused. A letter that finds nothing is still claimed, or a miss would reach
  whatever is around the list.
- **Keys: arrows, Page Up/Down, Home/End; vim opt-in; Enter and a double-click
  activate.** A page is the view less one row, the scroll box's and every pager's
  rule. A move stops at the ends rather than wrapping, as `select()` does by
  default, and is **claimed even where it goes nowhere** -- Down on the last row is
  the list's key, the scroll box's rule for a box at its end -- while a list with
  no rows claims nothing. `vim: true` adds `j`/`k`/`g`/`G`, `less`'s spelling and
  the pager's, off by default for the reason `find` is; the two together are
  refused, since both want the letters. Shift, Ctrl or Alt with a move is left for
  what is around the list (a range selection is not drawn here). In a `multiple`
  list Space ticks the current row and Ctrl-A every row that is not disabled, or
  none where every one already is -- the multiselect prompt's `a`, as a chord
  because a letter is a fallback's. Enter calls `onActivate(key, item)`, and is not
  claimed by a list without one. Escape and Tab are never the list's.
- **The mouse: a click moves the cursor, the wheel scrolls the view, a
  double-click activates.** The click and not the press, so the press keeps its
  default action -- focusing the list, which is the one focusable element: the
  scroll box inside it is built `focusable: false` and every key comes to the host.
  In a `multiple` list a click also ticks the row, which makes a multiple list a
  checklist; a double-click's second click activates **without** undoing the
  first one's tick, and is counted only where there is an `onActivate`, so a list
  without one hears two clicks as two clicks. The wheel moves the view and not the
  cursor, as every file manager does. A disabled row takes no click.
  `DOUBLE_CLICK_MS` moved to `@ttylabs/sigil/input` so the pane and the list count
  against one number -- "There is no double-click event" in `src/input`.
- **Disabled rows and the empty state.** `disabled(item)` draws a row
  `.sigil-muted` with `is-disabled`, and the cursor, a click and both kinds of
  tick pass it over; `toggleAll()` leaves a disabled row's tick as it was, the
  multiselect prompt's rule. With no items the scroll box is `display: none` and
  `empty` shows -- a string drawn `.sigil-muted`, or a function that builds an
  element -- defaulting to "Nothing to show", because a blank box reads as a list
  that failed to load.
- **The focus is SIG-278's answer for a list.** The pointer `❯` marks the current
  row whether or not the list has the focus, so an unfocused pane still shows its
  selection; `.sigil-focus` goes across the current row while it does, from
  `onFocusChange`, and moves with the cursor. At colour level 0 a focused list and
  an unfocused one look alike, the cost "Focus on a control" recorded. No theme
  role and no framework-sheet rule was added: every class here is a hook with no
  default, listed in the sheet's comment.
- **`describeListView(router, ...lists)` describes the keys each list claims**,
  scoped to it: the moves always, `j`/`k` with `vim`, Space and Ctrl-A with
  `multiple`, Enter with `onActivate`. Type-to-find is not described, for the reason
  `describeTabs()` leaves the digits out.

**The contract a table and a tree build on.** Either of two layers, and
`ListView` itself is built on the lower one, which is the evidence it is enough:

- `createListSelection<K>({ current?, selected?, multiple? })` is the selection
  with no elements: `current: State<K | undefined>`, `selected:
  State<ReadonlySet<K>>`, `setRows(keys, disabled?)`, `settle()`, `move(by)`,
  `moveTo(index, direction?)`, `first()`, `last()`, `toggle(key?)`, `toggleAll()`,
  and the readers `index()`, `indexOf(key)`, `keyAt(index)`, `isDisabled(index)`,
  `isSelected(key)` and `rowCount`. Every method reads the states untracked, so a
  call from inside an effect depends on nothing. A tree hands it the keys of the
  rows an expanded tree shows; a table hands it its rows in their sorted order.
- `ListView` with a `row` function is the element: a table's row draws its cells,
  a tree's row draws its guides and its marker, and either puts its own keys (Left
  and Right, a sort key) on an element **around** the list, where every key the
  list does not claim bubbles. `listControl(host)` hands back `selection`,
  `scroll` (the scroll box's control), `reveal(key?)`, `refresh()` and
  `activate()`. A row stops a click it handles itself -- a tree's twisty -- and the
  list never sees it.
- `ScrollRows.key` with `ScrollBox` directly, for a component that wants the
  windowing and draws its own cursor.

**Not done:** a range selection (Shift with the arrows, Shift-click), which is a
third piece of state -- an anchor -- and a decision about what a range means over
disabled rows; rows of different heights, which the scroll box's fixed-height
tier refuses for its own recorded reason; a horizontal axis, which a wide table
will want and which is a `ScrollRows.width` passed through; wrapping at the ends,
which `select()` makes an option and nothing here has asked for; and a built-in
filter field, for the reason above.

### Components that take `props`

- **A component's `props` may not carry a hook it owns (SIG-305, review round 1).**
  `ElementProps` takes the seven hooks so that `box({ onKey })` and a template are
  one path, and eight components spread their caller's `props` into a host and
  then assign a hook of their own: `TextField({ props: { onKey: mine } })`
  type-checked, built, and did nothing -- the silent no-op hooks-as-props set out
  to remove, one level up (on main it threw `Unknown property "onKey"`, which was
  a better answer). So a component refuses, at the top of its validation, exactly
  the hooks it assigns on the element those props go to, with a `TypeError`
  naming the component and the hook; and its `props` is typed
  `ElementPropsWithout<...>`, which pins those keys to `undefined` (an `Omit`
  would not: the index signature already admits a hook). `refuseOwnedHooks()` in
  `owned-hooks.ts` is the one definition. `undefined` is let through, since an
  optional prop a caller passed along is not a handler.

  **The type break, accepted.** A value typed `ElementProps` no longer fits these
  components' `props`: `function MyField(p: { props?: ElementProps }) { return
  TextField({ props: p.props }) }`, or a shared `const style: ElementProps`, fails
  with TS2322 where it compiled before hooks were props. Accepted because the
  error is true -- such a value may carry a handler the component would replace
  -- and a forwarder types its own `props` as `ElementPropsWithout<...>` with the
  same hooks. `owned-hooks.test.ts` pins that spelling compiling and the other
  not.

  | component       | hooks it owns on the host its `props` go to     |
  | --------------- | ----------------------------------------------- |
  | `TextField`     | `onKey`, `onPaste`, `onFocusChange`, `onResize` |
  | `ScrollBox`     | `onKey`, `onMouse`                              |
  | `ListView`      | `onKey`, `onFocusChange`                        |
  | `createPager`   | `onKey`                                         |
  | `tabRowView`    | `onKey`, `onFocusChange`, `onResize`            |
  | `openModal`     | `onPaste` (on the panel)                        |
  | `showToast`     | `onMouse` (on the panel)                        |
  | `attachTooltip` | `onLayout` (on the bubble)                      |
  | `Slider`        | `onKey`, `onFocusChange`                        |

  `Collapsible`, `Tabs` and `Show`/`For` assign none on the element their `props`
  reach (a `Collapsible`'s hooks are on its title, `Tabs`' on its row), so they
  keep accepting all seven. `openModal` and `showToast` are not on that list
  although the review brief expected them to be: the modal's panel gets
  `onPaste` and the toast's `onMouse` (a click dismisses it), both assigned after
  the caller's `props` are spread, and `attachTooltip`'s bubble gets `onLayout`.
  Found by the sweep, and in the table.

  **Refused rather than composed.** `ScrollBox` runs its own `onScroll`/`onResize`
  and then the caller's, but those are options of the component with a documented
  order; a hook in `props` has no such contract, and composing would make the
  order whatever the spread happened to be. An app that wants a key before the
  component's puts the handler on the element around it, where a key bubbles to
  it. **Not generalised past `props`:** a component's own callbacks (`onChange`,
  `onSubmit`, `onQuit`) are not element hooks and are untouched.

  `test/components/owned-hooks.test.ts` builds every component with no props and
  reads which hooks it left on the host, so the table above is checked against
  the code: a component that starts assigning another hook fails until it refuses
  that one too. It also asserts the refusal names both, the `undefined` pass, and
  that every hook it does not own is kept.
