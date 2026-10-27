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
  survived its sabotage. A list that has to grow while nobody is scrolling is
  left for a later tier: it needs a way to ask for a re-sync, which is a second
  mechanism beside `onScroll` and has no caller yet.

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
  rather than deferred. **A list that grows while nobody is scrolling**, for the
  reason the `count` entry gives. And
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

- **`trace` is left alone.** It prints a stack rather than a line, and replacing
  it with a formatted line would throw the stack away -- which is the whole of
  what anybody calls it for. Five methods: `debug`, `error`, `info`, `log`, `warn`.

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

- **The key goes quiet once the renderer has gone, which is the half `dispose()`
  cannot cover.** `view.dispose()` without `overlay.dispose()` is a thing an app
  does, and toggling a pane nothing will paint is harmless -- **stopping the key**
  is not. A binding sees every key before the focused element does, so a dead
  overlay would go on swallowing its key on a router the app still owns. One
  condition, and it makes the failure benign; the pairing is still the app's, which
  is the contract `enableSelection()` already has. Reported by the first review
  round.

- **`dispose()` puts back what was attached, in reverse.** The frame handler
  first, so that nothing reads a pane being dismantled, then the key, then the
  stats exclusion, then the element. Pinned as a **count** rather than as a
  picture: the pane is detached, so whatever it builds afterwards is invisible
  either way -- what a disposed overlay still reading frames would do is go on
  appending rows to a subtree nobody can see, for the life of the process.
  Deleting the unsubscribe survived every other test here.

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

- **The pane does not re-sync a windowed `ScrollBox`.** It holds the ring's rows
  as ordinary children rather than as `rows`, because what a windowed list cannot
  do today is exactly this: "a list that has to grow while nobody is scrolling is
  left for a later tier -- it needs a way to ask for a re-sync, which is a second
  mechanism beside `onScroll` and has no caller yet". This is that caller, and
  adding the mechanism is a change to `ScrollBox`'s contract taken inside a ticket
  about a debug pane. At five hundred rows the cost is an arrange of five hundred
  one-cell texts while the pane is **open**, which measured against the recorded
  10,000-row figures is a couple of milliseconds; closed it is `display: none` and
  is not laid out at all. The day somebody wants a ten-thousand-line ring is the
  day to add the re-sync and pass `rows`.

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
- **The components barrel is not split per component, because the components are
  not what it costs.** Reaching for one is 124 KB, of which the component
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

- **It is deliberately not ejectable, and the reason is structural rather than a
  preference.** `sigil add` rewrites a component's relative imports to the
  published subpath that answers for each, and `generate-registry.mjs` refuses a
  deeper specifier **by name**, so adding the palette to `ENTRIES` fails the
  build. Measured by doing it, which is how the honest version of this sentence
  was arrived at: the first specifier it refuses is `../types.js`, with
  `"../types.js" resolves to src/types.ts, which no published subpath answers
  for` -- and that one is the **generator's own map** rather than a statement about
  the API, because the root barrel does `export * from './types.js'` and so does
  publish `Internal`. The refusal that is about the API is the next relative
  import, `../util/transform.js`: the map is built from the tsdown entry list,
  which has no `src/util/` path at all, so nothing published answers for it. The
  second review round found the first version of this sentence naming the second
  miss. What that refusal is pointing at is the
  real reason: the one thing the palette must share with the parser is the
  function that says what a valid value is, so an ejected copy would either
  import something unpublished or carry a **second** reader of the coercion rule.
  "No second catalog" and "no second validator" are the same claim, and an
  ejected palette cannot keep the second half of it.

  Publishing `transformValue()` was the obvious way round it and is refused:
  that is a new permanent public surface -- "turn a string into a value of a
  declared type, the way the parser does" -- taken inside a palette ticket, which
  is the shape this file refuses repeatedly. What an app that wants to own the
  palette's _appearance_ has instead is the ladder this file already records:
  restyle a class, override a prop, or build its own tree over
  `commandCatalog()`, `rankBy()` and `highlightRuns()`, which are all exported.

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
- **The width is an option because the footer cannot know its box.** It defaults
  to `terminal.width` at each run and accepts `() => n` for an app that resizes;
  reading the laid-out width of the element would need a layout pass inside an
  effect that is itself rebuilding the children.

#### What is deliberately out

- **Replacing the built-in prompts' hint lines.** They keep their own text in this
  change: `select()` and `multiselect()` are being rewritten in another open
  change and the hints are translated strings with their own tests
  (`prompt-i18n.test.ts`). Adopting the footer is a follow-up that has to decide
  whether a prompt, which owns no router unless it borrows one, should grow one.
- **A binding that fires only inside an element.** See above.
- **Listing a function binding.** `bind(handler)` sees every key and has no key to
  name; it is not listed, and `describe()` with a key is how to list what it does.
- **Pagination of an expanded form taller than the terminal.** It lists everything,
  under its groups, and an app with that many keys wants a screen of its own.
- **A `?` toggle, a hide/show key, or a default mouse hover on the footer.**
