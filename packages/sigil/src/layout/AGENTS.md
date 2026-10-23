# `packages/sigil/src/layout` — deliberate decisions

These are the entries from [../../../../AGENTS.md](../../../../AGENTS.md) that are about this directory. Claude Code loads this file when it
works with files here; other agents should read it before changing
anything in this area. The root `AGENTS.md` holds the rules that apply
everywhere and still applies in full.

How each of these was arrived at — the review rounds and sabotage
passes — is under [docs/history/](../../../../docs/history), linked from
the entry it belongs to.

## Deliberate decisions — do not "fix" these

### Layout

- **The layout engine takes a `LayoutNode`, not an element.** Layout is the one
  layer in the stack testable with no terminal, no renderer, and no reactivity --
  lay a tree out, render it to a grid of characters, read the result as a picture
  -- and it keeps that only by not knowing what an element is. The element tree
  will satisfy the interface; so does a literal in a test.
- **Every division goes through `distribute()`.** Seven leftover columns across
  three children means somebody gets three and somebody gets two, and the rule
  for who has to be stable: a layout that reshuffles its rounding between frames
  shimmers, and one whose parts do not add up leaves a gap that moves.
- **`distribute()` floors and carries forward; it does not round.** Rounding
  sends the remainder backwards half the time, which put the spare cell in the
  _middle_ of a row of equal columns -- seven across three came out 2, 3, 2 --
  and contradicted the rule the function exists to keep. Flooring moves the
  remainder forward every time, so it lands on the last column.
- **Layout tests are pictures.** `test/layout/helpers.ts` renders a laid-out tree
  to a grid where each node paints its box with a letter, depth-first. A failing
  assertion that prints two grids says what went wrong; one that prints
  `{ x: 3, y: 0, width: 11, height: 2 }` does not, and there is enough arithmetic
  here for the difference to matter.
- **`order` changes where a child is placed, not where it lives.**
  `result.children[i]` still answers for `node.children[i]` whatever the ordering
  did, because everything above needs to match a box back to its element. Only
  the placement walk is sorted, and stably, so equal orders keep source sequence.
- **A property the layout engine ignores is worse than one that does not exist**,
  because it parses and then silently lies. `box-sizing`, `order`, and
  `align-content` were added to the table and are honoured here for that reason.
  `visibility` is deliberately not layout's: hidden content still takes its
  space. `overflow` is half layout's and the halves are worth separating --
  _clipping_ is the paint walk's, since it is about what reaches the screen, while
  _scrolling_ is read here, because a scrolled child's box has to be where it is
  drawn for anything above to match a box to an element.
- **`position: relative` offsets the box; `absolute` and `fixed` take it out of
  flow.** `relative` moves the box by its insets from where the flow put it and
  changes nothing else -- the space stays reserved at the un-offset position, so
  siblings are placed as though it never moved and its own children move with it,
  which is CSS. The other two are placed against a containing block instead and
  take no space at all: the flow never sees them, so an overlay does not reflow
  the panel underneath it, which is the whole reason anybody reaches for one.
  `absolute` was a parse error for as long as there was no engine to honour it,
  on the rule that a keyword which parses and does nothing is worse than one that
  does not exist; the same rule is what admits it now. `z-index` is still not
  `LAYOUT_PROPERTIES`': it changes what is painted over what, and nothing about
  where a box is.
- **An inset on a `static` box does nothing, and that is not the same lie.** It
  is CSS, it is the interaction everyone already knows, and it cannot be refused
  where the value is read anyway: `position` may be set by a different rule in a
  different sheet, and a declaration is parsed on its own. A declaration whose
  effect depends on another declaration is not a property the engine ignores.
- **A box that _moved_ is excused `checkInvariants()`, and nothing else is.**
  Landing on a sibling or leaving the parent's content box is what `relative` is
  _for_, so the containment and overlap checks skip a pair where either side was
  offset -- a check that fails on the behaviour it is checking is a check that
  gets deleted. Keyed on the used offset rather than on the keyword or on the
  declaration: `position: relative` alone moves nothing, and `top: 0` is a
  declaration that also moves nothing, so excusing either would reopen the net
  for every overflow that happens to sit under one. The helper resolves the
  insets itself rather than asking the engine, because a check that computes its
  own answer is what makes it a check. Everything else on the tree, the offset
  box's own children included, is checked as before.
- **The insets resolve a percentage per axis, unlike the margins.** `top: 50%` is
  half the containing block's height, which is CSS; percentage margins resolve
  against the _width_ on both axes there and here. Copying the margins' rule over
  would have been inventing a second oddity to keep one file consistent with
  itself.
- **An item that cannot flex is frozen at its hypothetical size; everything else
  flexes from its _basis_.** Both halves matter and getting either wrong is
  visible. Flexing from the raw basis leaves a sibling's `min-width`
  unaccounted for while the space is handed out to everyone else, and the
  trailing clamp then pushes that item past the edge with the space already
  spent. Flexing from the _clamped_ size instead pays the minimum twice, so two
  `flex: 1` columns whose content minimums differ come out unequal. The freeze
  condition is CSS §9.7.1 and it is easy to write backwards: freeze an item whose
  basis was clamped _away_ from the direction there is room to move -- a max
  pulling it down while growing, a min pushing it up while shrinking.
- **The automatic minimum is `min(content-based, specified)`.** Reporting the
  declared size flat meant a box with any children could not shrink at all,
  which is every real panel. The empty case and the non-empty case are separate
  branches and were fixed one round apart.
- **A child's declared minimum counts towards what its parent needs.** Measuring
  a shrink-to-fit container from its children's _content_ minimums alone let it
  compute itself smaller than a child's `min-width` would force at placement
  time, and the child ended up outside its parent's box.
- **The automatic minimum is content-based, so a box with no children has none.**
  Reporting its declared height as its minimum froze it at that height and
  pushed it out of a container too short to hold it -- which is the one thing
  shrinking exists to prevent.
- **An over-constrained row of declared widths is squeezed rather than
  overflowing, and what it squeezes moves when the _content_ does.** That is CSS
  -- `flex-shrink` defaults to 1 -- and it is the trap anyone laying a fixed row
  out walks into, because it looks right until one cell's text gets longer. Found
  by `05-drag.js`, reported as a rendering bug: its slider row asked for `9 + 30 +
  6` in a 40-column content box, the `nowrap` track could not shrink below its own
  width, so the label and the value absorbed all five columns -- and when the
  value's _automatic minimum_ grew from three characters to four, at exactly
  `100%` and nowhere else, the extra column came out of the label and shifted the
  whole bar one cell left. Nothing in the engine was wrong and nothing overflowed,
  which is why it reads as a drawing fault rather than as arithmetic. The fix is to
  make the declared widths add up, and the diagnostic is to lay the row out at
  several values and watch whether any box moves.
- **`justify-content` and `align-content` share one divider, and it goes through
  `distribute()`.** A single `Math.floor()` per gap cannot hold a remainder:
  `space-evenly` over seven cells and four slots gave three gaps of one and a
  trailing gap of four, and `space-between` left the last item a cell short of
  the edge it is defined to touch. The main axis was fixed one round before the
  cross axis, which had the identical bug in the identical shape.
- **Every auto margin on a line shares the free space, wherever it sits.** A
  trailing one used to count towards the denominator and then contribute
  nothing, so two adjacent items each pushing away from the other pushed once.
- **`layout()` honours the root's own declared size.** Every other node's is
  resolved by its parent before `layoutNode()` is reached, and the root has no
  parent to do that -- so `layout(panel, { width: 80 })` gave the panel eighty
  columns however wide it said it was.
- **Measurements are cached for the length of one `layout()` call.** Without it a
  node's subtree is re-measured once per ancestor level, which is the node count
  times the depth rather than the node count -- a 5.3x multiplier at eight levels
  deep, on the most expensive operation in the stack. Per call, not persistent:
  content changes between frames and invalidating is the renderer's job.
- **`insets()` already answers for the axis.** Asking it and then swapping main
  for cross again gave a row container the _vertical_ inset as its main one, so
  a `content-box` child with `padding-left` came out three rows tall.
- **A line's cross size is the largest _clamped_ item on it.** Reading the
  unclamped value made a line too short for an item with a `min-height`, and the
  next line started on top of it.
- **Wrapping counts margins.** A five-wide item with a two-wide margin takes
  seven, and deciding on five put two of them on a ten-wide line.
- **Percentage margins resolve against the width, on both axes**, which is what
  CSS does. Resolving against the main axis made one declaration mean one thing
  at measure time and another at placement.
- **Reversing a direction moves main-start to the other edge**, so the
  justification moves with it: `flex-start` on a `row-reverse` is the right.
  Reversing only the list packed it on the left. `wrap-reverse` does the same to
  the cross axis, for `align-content` and for each item's own alignment.
- **A hidden child still gets a result, and results are matched by index.**
  `result.children[i]` answers for `node.children[i]` with no caveat, which is
  what everything above needs to match a box back to its element. Both halves
  were wrong at different times: hidden children were dropped, and rebuilding the
  list by node identity collapsed two appearances of one node into one entry.
- **A text is re-measured at the width it actually got.** Its height depends on
  its width, and the first measure happens at the whole content box before any
  flexing -- so two texts sharing twenty columns each measured twenty wide and
  one row tall, then got ten each and stayed one row.
- **That re-measure is a row's, and a column measures at the right width to begin
  with.** A row's width is its _main_ axis, so the used width is not known until
  `resolveFlexible()` has run and the basis has to stay the unclamped content
  size for the flex algorithm to do the clamping itself. A column's width is its
  _cross_ axis, which never flexes -- the child's own `max-width` is the whole of
  the answer and `makeItem()` knows it before it measures. Measuring at the
  container's width instead wrapped the text for a width the child never got: a
  `max-width: 6` text in a twenty-wide column measured two rows tall and was then
  placed six wide, where it needs six. Patching it at placement time is not the
  fix and could not be: what would have to change there is the column child's
  _main_ size, which `resolveFlexible()` has already handed out and `cursor` has
  already begun placing from. A declared `width` looks like the broken case and
  is not, because `measureUncached()` reads the child's own `width` back off it
  and measures at that -- which is why the obvious repro comes out right. The
  same width has to reach the intrinsic measure as well, or the fix only moves
  the error: a column asked how tall its child was at the container's width, got
  two, and was drawn two rows around a child six rows tall.
- **And the row's own _measure_ re-measures too, because otherwise the placement
  is right about a height the neighbour was never told.** The entry above closes
  the gap inside a row; this one closes the gap between a row and whatever is
  drawn after it, and it was a known bug for as long as the engine has existed
  (SIG-125). `measureUncached()` offered every child the **whole** content box,
  which is a width only one child can have -- so a description beside a label
  measured two lines in the room it was offered, was placed in the column flexing
  gave it where it needs three, and the block after the row started inside it. All
  three shapes of that were reproduced before anything was written: the next
  sibling painted over the third line, the same thing inside a border, and the
  third line drawn straight through a bottom border where the bordered box's own
  cross size came from this measure.

  So the measure runs the placement's own three functions --
  `wrapIntoLines()`, `resolveFlexible()`, `remeasureLine()`, over items
  `makeItem()` built -- rather than a twin of them. Agreeing with the placement is
  the goal, and the only way to agree by construction is to _be_ the placement's
  arithmetic; a second reading of "how tall is this item at the width it got" is
  exactly what had drifted.

- **One round, and it is the same round the percentage case already takes.** The
  items are flexed against `inner`, this measure's own width, so the answer is
  exact wherever `inner` is settled -- which is every row that is a child of a
  column, since a column's cross axis does not flex, and that is the shape a help
  screen, a diagnostic and a prompt head all are. Where it is not settled, flexing
  a guess produces a height for a width the node may not get, which is the
  overflow `MeasureAt.containing` is already written down as preferring and the one
  CSS gives. Iterating would not close that: the width does not converge, it is
  simply not known yet. The alternative considered and rejected was the ticket's
  other option -- a full flex resolution iterated to a fixed point during the
  measure -- which buys nothing here for the reason just given and costs a second
  definition of when a measure has settled.
- **What the measure changes is the cross size and nothing else.** A row's
  `mainTotal` is still what its children ask for, read _before_ anything flexes --
  because max-content is a question about room the items have not been given, and
  `resolveFlexible()` is about to hand out exactly that. Flexing changes heights, so
  it changes the height a row reports and leaves the width alone, which is also why
  SIG-125 could not regress a width anywhere. What that sum _is_ is the entry below:
  the height was put on the placement's own arithmetic there and the width followed
  in SIG-126, which is the ticket that pass filed rather than took.
- **A nowrap row asks for the sum of its items' max-content contributions, and a
  wrapping one for its longest line.** Two formulas because they answer two
  questions, and the nowrap half was the one still on the per-child loop's sum of
  measured _content_ widths -- which misses a `flex-basis` exactly, since
  `measureUncached()` already reports a declared `width`. So a `flex-basis: 40` box
  measured **zero**, and what that cost is worth stating precisely because the first
  write-up of it was wrong in a way that matters: `flex-shrink` defaults to 1, so the
  common case is not an overflow but the box being **shrunk to the zero its row was
  given** -- content simply not on screen, with no escape for `checkInvariants()` to
  catch and nothing to point at. It takes a `flex-shrink: 0` to get the containment
  violation the old "Known bugs" entry described, and a `min-width` of its own to come
  out right.
- **`maxContentMain()` is not `hypotheticalMain()`, and reaching for the second cost
  a review round.** The obvious fix is to sum the number the wrapping branch already
  sums, and it is wrong: the hypothetical main size is the basis flexing starts
  _from_, which is the right number for deciding who shares a line and the wrong one
  for how wide a row wants to be. A `flex-basis: 0; flex-grow: 1` description has a
  hypothetical size of zero, so summing those reports a row's **min-content** width --
  measured, a label-and-description row came out eleven columns instead of twenty-two,
  its description was then placed in five, and it wrapped to seven rows inside a box
  drawn for three. That is SIG-125's own defect, reintroduced by the fix to its
  sibling, and `should not draw through a border it is inside` is what caught it.
  So the contribution is the item's basis when it cannot grow -- it ends there
  whatever room there is -- and its content's max-content size floored under the basis
  when it can, clamped to the item's own limits either way. The wrapping branch keeps
  `hypotheticalMain()`, because a line has to be measured by the number that packed
  it.
- **A nowrap row's _minimum_ counts `flex-shrink`, and that is what keeps the width
  fix from being half a fix.** `minimumMain()` is `resolveFlexible()`'s floor said as
  a function: an item that cannot shrink is frozen at its hypothetical size, and
  everything else is shrunk towards its own clamped minimum. Summing only the second
  would report a minimum of zero for a `flex-shrink: 0` child, which squeezes the row
  back to nothing and draws that child outside it -- the defect above, arriving through
  the minimum after being fixed in the size. It also replaces the loop's
  `Math.max(automatic, declared)` with the placement's `declared ?? automatic`, which
  is the rule the wrapping branch already kept and the second half of SIG-126: a
  `min-width: 0` on a long word is a declaration the automatic minimum does not get a
  say in, and the row used to report the word's own width, so a parent narrower than
  that placed it at a width its child had said it need not keep.
- **`max-width` is _not_ part of that, and it is asserted so that nobody adds it.**
  It is the obvious third divergence and it is unreachable on the main axis:
  `measureUncached()` lays a child's content out at `clamp(declared ?? available, min,
  max)`, so a box child's measured width is already a sum taken inside its own limit --
  and where the content cannot shrink that far, a long word, `clamp()` applies max
  before min so `min` wins, which is CSS. `max-width: 10` around `aa bb cc dd ee ff gg`
  measures 8 and is placed at 8; around a nowrap `supercalifragilistic` it measures 20
  and is placed at 20.
- **Three of `maxContentMain()`'s branches were unpinned when it was first written,
  and a sabotage pass is what said so.** The tests for the reported defect all reach
  the `flexGrow <= 0` path, so every decision on the other one passed with the branch
  removed: dropping the basis floor, dropping the limit clamp, and taking the growable
  branch unconditionally each failed nothing. All three are reachable and each is a
  real wrong layout -- a `flex-grow: 1; flex-basis: 40` box vanishes exactly the way
  the default one did; a growable item under a `max-width: 10` its `min-width: 0` lets
  bind is measured at the twenty its content wants and placed at ten; and offering a
  content size to an item that _cannot_ grow measures a row at twenty and places its
  child at the five its basis says, which is a fifteen-column hole in a row that shrank
  to fit. Each has a test named after what it is for now, and the pattern is the one
  this file keeps rediscovering: the tests written from a bug report cover the path the
  report came in on.
- **What it costs is nothing measurable, and what says so is the fuzzer.** Six
  interleaved rounds of forty iterations, over the same two workloads the entries above
  use: the help screen is **10.38ms against 10.46ms** median and the table **4.61ms
  against 4.69ms**, which is +0.8% and +1.7% with the fastest passes at +0.4% and
  -0.2% -- noise, as it has to be, since one per-item expression replaced another.
  140,000 layouts -- 200 seeds, 100 trees, seven sizes -- run over the same corpus with
  `main`'s engine and with this one: **zero** invariant failures either way, and the
  strict count, which includes the legitimate overflow this file records 41,038 of
  42,000 layouts producing, went from **135,485 to 135,426**. So the change removes 59
  real overflows and creates none, which is the same shape SIG-125's differential had
  and the only number that could carry the argument -- the invariants were already
  clean on `main`.
- **The flexed cross size _replaces_ what the per-child loop found rather than
  being a floor over it.** `Math.max` of the two was the first spelling and it is
  the wrong one, because the loop answers a different question: it reads each
  child's measured height unclamped, while an item's cross size is clamped to that
  child's own `max-height`. A floor therefore measured a row six rows tall around
  a box the placement puts at one, which is the disagreement being fixed, pointing
  the other way. `should honour a max-height the placement honours rather than
  measuring past it` is the guard, and it fails if the `Math.max` comes back.
- **And the reported _minimum_ comes from the same pass, because it is the same
  question with `minHeight` in place of `height`.** `crossMax >= minCrossMax` used to
  hold by construction and with the cross size replaced it does not, so the minimum
  had to be settled too -- and getting there took three spellings, each wrong in a
  direction the previous one was right about. A `Math.max` of the flexed cross and the
  loop's kept a `max-height: 1` over a six-row text reporting `minHeight: 6` beside
  `height: 1`, and a column parent clamps a child's basis **up** to its automatic
  minimum, so the row was placed six rows tall by the very number the pass had just
  corrected. A `Math.min` of them went the other way: two nineteen-column texts in
  twenty columns are one line each before flexing and two rows each after, so the row
  reported `height: 2` and `minHeight: 1`, and a column of `height: 1` squeezed it to
  one row around two rows of text. A clamp on one line and a replacement on several
  was the third, and it was a band-aid over both.

  What settles it is asking each item how short it can be **at the width it was
  given** -- which is what `crossSize` already asks about the height -- and summing
  that per line. So `Item.minCrossSize` sits beside `crossSize`, `remeasureLine()`
  writes both from one measurement, and the special case is gone. Per line rather
  than over every item, because a line cannot be shorter than its own
  shortest-possible tallest item and the lines stack: three one-row items on three
  lines cannot be one row. Both failures above and the multi-line floor are each
  pinned by a test, and each of those tests was written after a sabotage found the
  assertion missing.

- **What it costs is about a tenth of a render, and getting that number took three
  measurements because the first two were taken on a busy machine.** Six alternating
  rounds, forty iterations each, of a sixty-entry help screen and a two-hundred-row
  table: the help screen goes from **10.45ms to 11.46ms** median and 8.06 to 9.11 at
  its fastest, and the table from **5.03ms to 5.49ms** and 4.50 to 4.88 -- **+9.7%**
  and **+9.1%** on the median. Both rows now build items and run the flex resolution
  twice over, once to be measured and once to be placed, and the table pays it six
  hundred `nowrap` cells at a time.

  Interleaved rather than batched, for the reason the style-shaking measurement
  records -- and interleaving was not enough. An earlier run of the same interleaved
  script, with a fuzzer and a review agent running beside it, reported **+2.1%** for
  the help screen and **+12.7%** for the table: the help cost understated by a factor
  of five and the table's overstated, from one run, with alternation already in place.
  What said so is the absolute numbers, which were four times the ones this file
  already records for the same two workloads -- so the check is not "did I alternate"
  but "does the baseline agree with the baseline", and the version to trust is the one
  where a sixty-entry help screen is about 10ms rather than about 45ms.

- **The cache can hold `2^depth` widths per node in principle, and tens in
  practice.** A row measures each child at the content width and again at the share
  flexing gave it, and a child row repeats that for both -- so a leaf under `d` rows
  of genuinely distinct fractions is measured at `2^d` widths. What collapses it is
  that the fractions repeat: a fixed sibling gives `{W, W-k, W-2k}` and uniform
  halving gives `{W, W/2, ...}`, which is one new width per level and a hit after
  that. A help screen is a column, a row, a paragraph row and its words -- depth
  four, and the widths are the terminal's, the description's share, and each word.
  Written down rather than bounded, because the bound would be a cap on a cache
  whose whole job is to be complete for one pass, and the workload that needs one is
  not a screen this engine is asked to draw.
- **`makeItem()` takes a `Block` rather than a `Box`, because its second caller
  knows less about the containing block.** The placement knows all of it: the
  content box is settled, so a percentage on a child resolves against it and the
  width handed out is the width the child gets. The measure may be sizing a node
  whose own width is still a guess, and a `Box` cannot say so -- its `height` is a
  number and the measure has none. So `Block` carries the width, the height, what
  a percentage resolves against, and whether any of it is settled; `width` and
  `containing` are the same number for the placement and part company in the
  measure, for the reason `MeasureAt` already carries at length. `remeasureLine()`
  grew a `definite` argument for the same reason, since a share of a guess is a
  guess.
- **One `makeItem()` per child, and one measure with it.** The per-child loop used
  to take a measure of its own at `inner` while `makeItem()` takes one at
  `inner - margins`, which is the width the child is really placed at -- so a
  margined child was measured **twice, to two answers**, and the parent sized itself
  by the one the placement does not use. The loop reads `item.measured` now, which
  makes the two agree and costs a measure rather than adding one. `Item.measured` is
  stale the moment `remeasureLine()` has run, which is why nothing reads it past the
  flex resolution and why it says so on the field. A consequence of sharing
  `makeItem()` rather than the point of it, and it moved no test.
- **The fuzzer is what says the whole of it is safe, and it is read as a diff rather
  than as a pass.** 140,000 layouts -- 200 seeds, 100 trees, seven sizes -- run over
  the same corpus with `main`'s engine and with this one: **zero** invariant failures
  either way, and the strict count, which includes the legitimate overflow this file
  records 41,038 of 42,000 layouts producing, went from **135,603 to 135,485**. So the
  change removes 118 real overflows and creates none. A pass on its own would have
  said almost nothing here, because the invariants were already clean on `main`; what
  carries the argument is that the one number that moved moved the right way.
- **The width limits are applied in `measureUncached()` and nowhere else,
  because that is where the width they are a percentage _of_ is.** The callers
  hand it the containing width and what is settled about it; clamping at the call
  site as well resolved a `max-width: 50%` against the ten it had just produced,
  so the text wrapped at five and was placed at ten -- the same defect the clamp
  exists to fix, one level along. Neither clamp alone does that, which is what
  made it worth a third review round.
- **`measure()` takes a width to lay content out in and a block to resolve
  percentages against, and they are two arguments because they are two
  questions.** One argument answering both was `MeasureAt`'s reason for existing.
  They are the same number for an ordinary child and they part the moment a limit
  binds: a node whose `max-width` narrowed it wraps at the narrowed width, while
  its `width: 50%` still means half of the block that contains it -- so one number
  could only ever be wrong about one of them, and each caller had picked which.
  Three defects were that one shape. A `width: 10` under a `max-width: 6` was
  drawn six wide with its text wrapped for ten, so a six-row text came out three
  rows and half of it was gone. `makeItem()` resolved a child's `50%` against the
  content box and handed the measure the room left after that child's margin, so
  one declaration meant ten in one line and eight four lines down. And the root
  resolved `width: 50%` against the eight its own `max-width` left it, in forty
  columns, and wrapped its text at four.
- **A percentage against a containing block that is not settled is `auto`, and
  that is the same rule as "only a limit in cells is honoured while measuring",
  reached properly.** `MeasureAt.containing` is `undefined` rather than a number
  while an ancestor is still sizing itself, so every percentage on the node reads
  as `auto` there -- which is CSS, and which is what keeps one node from being
  measured twice to two different answers. The old spelling picked cells because a
  cell limit is the one that cannot move; this says why. What it does not buy is
  agreement between the two passes, and nothing non-iterative can: an auto-width
  column sizes itself around a child measured without the child's `max-width: 50%`
  and then places that child at the nine the percentage comes to, four rows deep
  where the column is two. That overflow is the one every browser produces, and it
  is the better of the two answers available -- the height used to be measured at
  eighteen and the box drawn at nine, so two rows of text were lost with nothing
  to show for it. What closes it for one level of nesting is the re-measure below:
  once flexing has settled an item's main size, the subtree is measured again with
  that size as a _definite_ containing block, the `50%` resolves to nine, and the
  column comes out as tall as the four rows the text needs there. One round of the
  iteration this entry said was needed, taken where the width stops being a guess.
  Pinned by `should lay a percentage-limited text out at the width it is placed
  at`.
- **A container that wraps is measured as the lines it wraps into, and there is
  one function that decides what those lines are.** `flex-wrap` was honoured when
  a line was packed and ignored when the box was sized, which is the same defect a
  property that parses and does nothing is: every auto-sized wrapping box came out
  one line deep with its other lines drawn outside it, and a paragraph -- a
  wrapping row of one-word items, which is how inline styling is expressed here --
  was the case that found it. A _row_ only: the main axis of a wrapping column is
  its height and this function is never told one, so there is no room to pack
  against. The smallest such a container can be on its main axis is its widest
  single item rather than the sum of them, because everything else can be pushed
  onto a line of its own.

  `packLines()` used to be the measuring twin of `wrapIntoLines()`, kept separate
  because the two were handed different things -- one had `Item`s with resolved
  bases and the other had the sizes the measure had just taken -- while following
  one rule. Four things had to match the placement or the measure was a different
  answer to the same question, and each was wrong once: the gap _between_ lines is
  reserved, or a `row-gap` comes out a row short per break; the packing is by
  `flex-basis` rather than by content, or a `flex-basis: 40` child with three
  columns of content is packed at three and placed at forty; it is in `order` order
  rather than source order, or the same three children wrap into two lines and are
  placed into three; and the minimum it clamps with is the placement's --
  `declared ?? automatic`, not the larger of the two, since a `min-width: 0` on a
  word is a declaration the automatic minimum does not get a say in.

  That twin is **gone**, and the reason it existed went with SIG-125: the measure
  builds real `Item`s now, so it calls `wrapIntoLines()` itself and there is
  nothing left to keep in agreement. All four rules above still hold and are now
  held in one place, which is the strictly better version of holding them twice.
  The one number the two spellings shared is `hypotheticalMain()` -- a basis
  clamped to its own limits plus its margins -- which is read by five callers now
  and so is written once: `wrapIntoLines()`, a wrapping row's size and its minimum,
  and both of SIG-126's contributions, since an item that can neither grow nor
  shrink ends up exactly there.

- **The re-measure at the used width is every item's, not only a text's.** A box
  whose children wrap has the same dependency a text does -- its height is a
  question about its width, and the width is not known until flexing has settled
  -- so `remeasureLine()` asks any item with children as well as any item that
  measures. A childless box is the one case skipped, because its height cannot
  move. Left to texts alone, a paragraph came out one line tall: measured at the
  `flex-basis: 0` it starts from rather than at the remainder it was given.
- **A `measure` node reports its declaration rather than its content.** The
  `node.measure` branch reports `declaredWidth ?? content` and
  `declaredHeight ?? content`, with `min(content, declaration)` for the automatic
  minimums, the way the two branches below it already did. What an ancestor
  sizing itself around a node needs is the size the node will be _placed_ at, and
  `makeItem()` places it at its declaration: a `width: 10` text whose content
  wraps to five reported five, so an auto-width column measured itself five wide
  and drew the child outside its own box.
- **Percentage lengths are rounded per box, and no per-box rule can make siblings
  add up.** `resolve()` rounds -- `50%` of five is three -- and the reason
  recorded for it, that two boxes at 50% should still fill the row, is not
  something rounding can deliver: each sibling rounds on its own, so the two ask
  for three each in a five-wide row. What rounding does buy is that a percentage
  never collapses a box that asked for most of a cell: truncation makes those two
  two cells each and leaves a hole, and makes `10%` of five nothing at all. The
  row is put back to exactly full by the _shrink_ pass, which does go through
  `distribute()` -- three and three become three and two. Where the items cannot
  flex the overflow is real and `checkInvariants()` says so. `distribute()` is
  not available here: it hands out one total across weights that partition it,
  and a percentage is not a partition -- siblings' percentages need not sum to
  100%, cross sizes and limits and margins overlap rather than divide, and the
  same declaration is read once while measuring and again while placing, where
  the line it would be distributed over does not exist yet.
- **Pictures cannot check containment, so `checkInvariants()` does.** The picture
  helper paints later nodes over earlier ones, so an overlap is invisible, and it
  bounds-checks against the grid, so anything placed past the edge does not
  appear at all. A fuzzer found five hundred containment violations that
  forty-two picture tests had no way to see.
- **The fuzzer is committed, and it allows overflow rather than checking
  containment.** `test/layout/random.ts` generates trees and shrinks a failing
  one back down; `layout-stress.test.ts` runs five seeds of two hundred on every
  save and prints a seed and a minimal tree, written as the `box()` and `text()`
  calls that build it, when one breaks. The entry above is why it exists and is
  also why it is written down twice: the first version of it was run once, found
  its bugs, and was never committed, so the line saying a fuzzer had found five
  hundred violations described a file that did not exist for as long as anyone
  read it. Containment is the invariant it leaves alone, which is a measurement
  rather than an oversight: 41,038 of 42,000 random layouts escape something,
  because a word longer than the room is an automatic minimum that cannot shrink,
  a declared height in a shorter parent has no axis to flex on, and a `min-width`
  beside a sibling's is a pair of constraints with no solution. Every one of
  those that was shrunk and read was legitimate overflow, which is what CSS does
  and what the `overflow` option exists for -- a check that fires on what the
  engine is supposed to do is a check somebody deletes. What it does check holds
  unconditionally: no negative boxes, siblings clear of each other, and
  `checkPacking()`.
- **A zero-area box is not excused the overlap check, though nothing can be
  painted over one.** `apart` is false against a degenerate rectangle whatever
  sits where it is -- no edge of it is past any edge of anything -- which reads
  like a hole in the check and is its sharpest edge: four of the five defects the
  fuzzer found arrived as a zero-area box reported inside a sibling, and
  loosening the rule to match the intuition would have hidden all four. They were
  one bug, the entry below, rather than the harness artifact they looked like.
  Once it was fixed the strict rule fired zero times in 70,000 layouts.
- **A line's cross size is taken after its text has been re-measured, not
  before.** The two rules above -- a line is as tall as its largest clamped item,
  and a text is re-measured at the width it actually got -- were true in the
  wrong order: the re-measure ran in `placeLine()`, which is after
  `lineCrossSizes` had been read off `item.crossSize` and after the cursor had
  been walked from it. So a wrapping row whose first text wrapped to two rows at
  the width flexing gave it stayed a one-row line, and the next line was placed
  on top of that text's second row. `remeasureLine()` does it between
  `resolveFlexible()` and the line's cross size instead, and `placeLine()` reads
  the height back off the item rather than measuring again, so the height a line
  was sized for and the height its item is placed at cannot come to disagree.
  `stretch` still takes the larger of the room and that height for an item that
  measures -- a text's rows past the bottom of its box are lost, while a box
  crushed by `stretch` merely overflows with its children -- and that is a row's
  rule only, since a column's cross size is its width and stretching is entitled
  to widen it. Found by the fuzzer, through a hundred and nine hand-written tests
  that never put a text that wraps on a line that wraps.
- **A percentage of an unknown size is `auto`.** What CSS does, and what keeps a
  column layout from resolving heights against nothing.
- **`min` wins over `max` where they conflict**, as in CSS, which is what stops a
  box collapsing below its content when a stylesheet says something impossible.
- **A node's size is settled by whoever placed it, and `layoutNode()` never
  clamps it again.** `makeItem()` resolves a child's `min` and `max` against the
  containing block -- the parent's content box, which is what a percentage is
  _of_ -- and the flexible resolution clamps to them; `layout()` does the same
  for the root, whose containing block is the space it was given. Clamping a
  second time on the way down read the same declarations with less to go on, in
  two ways. A percentage resolved against the size just handed out, so a growing
  item under `max-width: 50%` in a ten-wide row was clamped to five, and the five
  was then read back as the base and clamped to three. And `min-height: auto`
  resolved to no minimum at all, because that one lives in a measurement only
  `makeItem()` takes -- so a `max` beat a minimum that is defined to beat it, and
  a three-row text came back one row tall. Either way the box was smaller than
  the hole its siblings' positions had already reserved, which is a gap nothing
  declared and which containment cannot see: a shrunken box is still inside its
  parent and still clear of its siblings. `checkInvariants()` checks the
  observable half instead -- adjacent items on a packed line abut, so a box that
  did not fill its hole moves its neighbour -- because the allocation itself is
  not in the result, which leaves an only child and the last item on a line
  uncovered.
- **The root is measured at the width it has, against the block it was given.**
  Both numbers are needed and they are not the same one: a root `width: 50%` under
  a `max-width` of eight, in forty columns, means half of forty asked for and
  eight received, so the percentage resolves against forty while the text wraps at
  eight. Every candidate for a single argument was wrong -- the clamped width
  wrapped the text at four, and the unclamped one reported a height for a box it
  would not have. This is the case that named the defect, and the entry it
  replaced said the fix "means `measure()` taking a used size as well, which is
  every caller": it was, and it is.

### Out of flow, paint order, and clipping

- **An out-of-flow box is placed against a containing block and takes no space.**
  `absolute` resolves against the padding box of the nearest positioned ancestor,
  which is CSS's containing-block rule and worth keeping because everybody
  already knows it: a dropdown anchors to the panel it was written inside rather
  than to whatever happened to be laying it out. `fixed` resolves against the
  root, which here is the canvas -- a status line pinned to the bottom of a
  full-screen app is what it is for, and a canvas is the only thing a terminal
  app has that answers to "the screen". Both frames are carried down the walk
  rather than found by climbing back up, because the walk already knows what it
  passed.
- **It does not size the parent it was taken out of**, which is CSS and is the
  useful answer: a dropdown that made its panel wider could not then be placed
  inside it. `measureUncached()` filters them out of the children it measures,
  which is the one line that makes "takes no space" true for intrinsic sizing as
  well as for placement.
- **Its size is two insets, else a declaration, else what it measures.** `left`
  and `right` together say how wide the box is, which is what `inset-0` is for;
  otherwise a declared width wins; otherwise it shrinks to fit, which is CSS.
  Where neither inset on an axis is given, the box stays at the content origin
  the flow would have started it from -- CSS's static position read as far as it
  is worth reading, since the real rule describes where a box _would_ have gone
  among siblings laid out without it.
- **Paint order is `z-index` then document order, and a non-zero `z-index` keeps
  its subtree together.** That is CSS's rule for flex items, which is every child
  here: `display: flex` is the initial value and the only other one is `none`, so
  the property applies to all of them rather than to positioned boxes alone --
  simpler to say, and what CSS says for this layout mode. Sorted stably, so
  children that share a value keep the order they were written in. A child
  ordered above its sibling takes its own descendants with it and a descendant's
  own `z-index` orders it _inside_ that child: a stacking context by another
  name, and what stops `z-index` becoming a global free-for-all that every
  component fights over with bigger integers.
- **The clip lives in the cell grid, not in the painter.** `overflow` other than
  `visible` clips what a box's descendants draw to its padding box -- never its
  own border, because the border _is_ the edge and a box that clipped itself
  would erase the frame it is drawing. It is enforced in `CellBuffer.inside()`
  because that is where the rule it needs already lived: a wide cluster with one
  column left is refused and a blank takes the column, which was written for the
  grid's own right edge, and a clip edge is the same edge one column in. Asking
  it anywhere else would be that rule said twice, and the two would come to
  disagree about what half a glyph is.
- **A nested clip intersects rather than replaces.** A panel that clips inside a
  pane that clips cannot paint where its parent could not, which is what the
  nesting means; replacing would let the inner one paint back out over the outer
  one's edge.
- **Scrolling moves the boxes rather than the drawing.** A scrolled child's box
  has to _be_ where it is drawn: everything above matches a box back to an
  element -- paint, and the hit testing input will want -- so an offset applied
  at paint time would make `box` a position nothing is at. It is applied after
  the children are placed rather than by moving the content box before them,
  because the content box is what a percentage resolves against and what the flow
  divides: scrolling must move the result, not the arithmetic. Only a box that
  clips is scrolled, since scrolling what is not clipped moves content out from
  under nothing.
- **A scrollbar is a component, not a layout feature.** The layout knows how far
  a box is scrolled and how tall its content came out; what to draw about that
  -- a track, a thumb, an arrow, nothing at all -- has a dozen answers and
  none of them belong to the engine. One of the dozen is written now, in
  `src/components/scroll-box.ts`, and "A scroll box" in `src/components` is
  where its decisions are.
- **A box that clips is where the walk measuring the grid stops, and that one
  rule is the whole of what the clip owes it.** The rule and its measurements
  are in "Rendering a tree to a string" in `src/renderer`, where
  `arrangedExtent()`'s entry is; what is here is the clipping argument it
  rests on, because it is the same argument `Element.extent` already takes and
  the two are easy to read as one.

  Nothing inside a clipping box is painted outside its **border** box, because
  every descendant is clipped to the **padding** box one cell in -- so the border
  box is an upper bound on the room the whole subtree takes, and the subtree has
  nothing to add to it. That is also why the answer for a clipping root is its
  border box rather than its children clamped to its clip: the clip stops where
  the border begins, deliberately, so clamping the children reports a grid a
  column short of the frame the box is about to draw. Which is the same sentence
  as "a box that clipped itself would erase the frame it is drawing", read from
  the side of whoever has to allocate the cells.

  Two guards were written for this before the stop was, and both were deleted for
  being unobservable: a clamp of each box to its own clip, and a reach test for a
  box the clip misses on the other axis. With the stop in place there is no box
  with a clipping ancestor left to visit, so neither could change an answer.
  `Element.extent` keeps the same bound for its own reason -- it is what makes
  paint culling sound rather than what makes an allocation tight.

- **`DECSTBM` is not used for a scrolled region, and that is a decision rather
  than an omission.** A terminal's own scroll region would move a scrolled pane's
  rows for free, which for a log viewer is the whole cost of the frame. It is
  refused because the canvas's model is a grid it diffs: the diff would have to
  know that some rows moved without anything having painted them, the region is a
  rectangle of _screen_ rather than of canvas, and it cannot be used at all where
  anything is drawn over the scrolled area -- a border, a status line, an overlay
  -- which is most of the cases worth having. Revisit it behind a profile, and
  only for a pane that owns its full width.
