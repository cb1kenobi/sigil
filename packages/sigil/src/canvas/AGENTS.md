# `packages/sigil/src/canvas` — deliberate decisions

These are the entries from [../../../../AGENTS.md](../../../../AGENTS.md) that are about this directory. Claude Code loads this file when it
works with files here; other agents should read it before changing
anything in this area. The root `AGENTS.md` holds the rules that apply
everywhere and still applies in full.

How each of these was arrived at — the review rounds and sabotage
passes — is under [docs/history/](../../../../docs/history), linked from
the entry it belongs to.

## Deliberate decisions — do not "fix" these

### Canvas

- **A canvas is a rect plus an anchor, and it does not know its anchor.** The
  original ticket asked whether it owns the alternate screen or draws inline;
  that is the wrong question. Every coordinate is relative to the canvas's own
  top-left and every movement the diff emits is relative to where the cursor
  started, so the same grid works parked at the bottom of a scrolling log or at
  the origin of the alternate screen. Absolute positioning would have forced the
  inline case to know a screen row it has no way to learn.
- **A wide cluster leaves a continuation, and overwriting either half takes the
  other with it.** Without the marker there is no answer to "what is in column
  40" for a row containing one wide character, and every clip, overwrite, and
  diff is off by one from there rightwards. Left alone, a survivor is half a
  glyph. A zero-width cluster is refused a cell rather than given one, because
  `graphemes()` has already attached it to what it modifies.
- **A run never starts on a continuation cell.** Writing at that column would put
  the cursor in the middle of a glyph, so a run that would begin there starts at
  the lead instead -- even when the lead itself did not change.
- **The diff starts every frame from the default style, not from the previous
  frame's cell.** A frame ends by resetting, so the terminal's SGR state at the
  start of the next one is default. Diffing against what the old cell looked like
  would emit closing codes for attributes that are not open.
- **An unchanged gap shorter than a cursor move is painted through.** A move
  costs about four bytes, so skipping a two-cell gap is more expensive than
  writing it -- and it avoids a move, which some terminals handle worse than a
  write.
- **Cells hold a style index, not a style.** A grid repeats a handful of styles
  across thousands of cells and the diff's inner loop asks "same style?" once per
  cell. Interning makes that an integer comparison and lets the grid keep its
  styles in a typed array. The table copies what it interns, so a caller reusing
  one object to paint many cells cannot retroactively change what a cell was
  painted with.
- **Extended colours are emitted in the semicolon form**, matching the styler.
  `38:2::255:128:0` is what ITU T.416 specifies and the semicolon form is the
  widespread misreading of it, but the misreading is what got implemented: the
  colon form is a strict subset of terminals and the six-element spelling
  narrower still. The ambiguity the colon form avoids is a problem for _parsers
  inside this library_ -- which is why `reopen()` and `createSgrState()` each had
  to learn about it -- and nothing here passes through either, since the terminal
  is the only reader of the diff's output.
- **A style is interned under a string key.** Packing two colours and the
  attributes into one number is 58 bits: it runs past `Number.MAX_SAFE_INTEGER`
  and rounds the attributes away, so bold truecolor text interned as plain
  truecolor text and rendered unstyled, and unrelated colour pairs collided. The
  string is built once per _distinct_ style rather than once per cell.
- **A partial style is filled and a nonsense one is refused.** A style arrives as
  `Partial<Style>`, so a missing field is `undefined`, and `undefined` reaches
  the terminal as `38;5;undefined` -- output it drops and nobody can trace back.
  `palette()` and `rgb()` refuse out-of-range channels for the same reason rather
  than clamping them, which is the line `assertByte()` takes in the styler.
  Interned styles are frozen, `DEFAULT_STYLE` included -- it is index zero, which
  is what every cell starts with, so handing back the mutable object meant one
  write could make the diff start every frame from a "default" that was not one.
- **A cluster occupies one cell or two, never more.** `graphemeWidth()` sums what
  a cluster contains and can exceed two -- a CJK character with a spacing mark,
  two leading Hangul jamo -- and a grid has no third cell to put that in. Left
  alone, the cluster went into one cell, the cursor advanced by three, and the
  cells between were never drawn while still holding content nothing would paint
  over. `cellWidth()` is the only width the grid asks about.
- **A control character is refused, not dropped.** `\n` is zero width, so it took
  no cell and `put()` returned `0` -- and `write()` only stopped on a
  _positive_-width cluster that failed to land, so a wrapped paragraph painted as
  one concatenated line with no complaint. A grid paints one row per call by
  construction, so the caller has to say which row. Tab is refused too: its width
  depends on a tab stop the grid does not model.
- **`Painter.text()` strips escape sequences rather than painting them.** A cell
  grid expresses styling as a style per cell, so a string carrying its own has
  nowhere to put them -- and painting cluster by cluster puts `[31m` on screen as
  text, because the ESC is zero width and the rest is not. Every existing
  component builds strings like that.
- **A backend must give the canvas its rows before presenting.** Movement is
  relative and downward movement is CUD, which stops at the bottom margin and
  never scrolls -- so a canvas rendered with the cursor on the last row of the
  screen paints every row onto that line. The inline backend's first frame is
  exactly that case; its recipe is `height - 1` newlines then walk back up.
  `DiffResult.column` is never past the last column and `wrapPending` says
  whether the deferred wrap is armed.
- **`fill()` steps by what its cluster consumes and leaves the rectangle short
  rather than overrunning it.** Advancing one column regardless made each
  iteration break the continuation the last one left, so only the final column
  kept its glyph -- and the last `put()` wrote its continuation one column _past_
  the rectangle, over whatever else was painted there. Three columns cannot hold
  two wide clusters, and half of one is worse than a gap.
- **`write()` clips at the left edge and gives up at the right.** `put()` answers
  `0` for any off-grid column, and reading that as "nothing further will land" is
  true walking off the right edge and false at a negative one, where advancing
  walks _into_ the grid -- so `write(-2, 0, 'hello')` on a five-wide grid painted
  nothing at all while `fill()` clipped the same rectangle correctly, and two
  sibling APIs disagreed about what off-grid means. A wide cluster straddling
  column zero is still refused, because a survivor is half a glyph, but only that
  cluster and not the rest of the string. What comes back is the **advance from
  `x`**, not a count of the cells painted: `x + returned` is where a next run goes
  whichever edge clipped this one, it is the same number for a run that fits, and
  a caller that needs to know what landed has `inside()`.
- **The cell class is `CellBuffer`, not `Buffer`.** The shorter name is Node's
  global, and a file that forgets the import gets a byte buffer and a
  deprecation warning rather than a type error.
- **`paint()` clears and redraws the whole frame; there are no damage rects.**
  That settles the question the ticket left open. The diff already reduces a
  whole-frame repaint to the cells that changed, so damage tracking would buy
  back only the painting, and it needs paint and diff to agree about who owns
  invalidation. Revisit when a profile says the painting is the cost.
- **A resize discards both buffers.** The layout is about to run again at the new
  size and repaint everything, and a grid that described a terminal that no
  longer exists is not something to diff against -- keeping it only gives the
  diff something wrong to compare with.
- **`present()` copies the frame forward rather than swapping buffers.**
  Swapping saves an allocation and leaves `back` holding the frame before last,
  which is what the canvas reports as its current contents. A `toString()` that
  lies is a debugging trap worth more than the allocation.
- **The diff is tested by replaying its output against a model terminal, not by
  asserting on its bytes.** Asserting on bytes pins one implementation; replaying
  pins the claim, which is "these bytes turn what is on screen into what should
  be". The model refuses a write past the right edge, and checks after every
  frame that no wide cluster lost its continuation and no continuation lost its
  lead -- _after_, not during, because replacing `漢` with `ab` legitimately
  splits it and the second write is what puts the row back together. What is
  never legitimate is a frame ending with half a glyph on screen. See
  `test/canvas/diff.test.ts`.
- **The model cannot check itself, so `scripts/terminal-probe.mjs` exists.** The
  model and the diff share an author and a mental model, so an assumption wrong
  in both passes green forever -- and the canvas makes several claims only a
  terminal can falsify: that CUD stops at the bottom margin rather than
  scrolling, that a wide cluster at the last column is refused rather than
  wrapped, that the deferred wrap is deferred, that the semicolon form of an
  extended colour is the one terminals take. The probe paints those frames to a
  real terminal and says what you should see; it is run by hand, against every
  terminal worth supporting, and it is the only thing here that puts a byte on
  one.
- **A hyperlink is a style, not a region.** OSC 8 is terminal state that applies
  to everything written after it until it is changed, which is what `Style`
  already models -- so `link` lives there and is interned, compared and diffed
  by the machinery that already does all three. A cell still holds one integer.
  The alternative considered was a third parallel array beside `#chars` and
  `#styles`, marking which attachment each cell belongs to; that earns its keep
  only if something needs a _rectangle_, and nothing does now that passthrough
  images are out. The interning key puts the link last, because everything
  before it is a number of known shape and a comma inside a URL would otherwise
  let one style forge another. A link carrying a control character is refused:
  an OSC sequence runs until its terminator, so one hidden inside the URI ends
  it early and the rest reaches the terminal as commands, and building a URL out
  of user input is the ordinary case rather than the exotic one.
- **`RESET` does not close a hyperlink, and the frame end has to.** SGR and OSC
  are separate state: `\x1b[0m` puts the colours back and leaves the link open
  over whatever is written next, which at the end of a frame is the
  application's own output. `LINK_OFF` is emitted before `RESET` when a link is
  in effect. This is also why `FakeTerminal` had to learn OSC -- it parsed only
  `ESC [`, so an unrecognised link sequence fell through to the text path and
  painted the URL into the grid.
- **Sub-cell drawing picks a character, it does not change the grid.** A braille
  pattern and a half block are ordinary single-width clusters, which is the
  whole reason this is the tier that works everywhere. `Dots` is 2x4 per cell
  and monochrome -- a braille cell is one character, so it carries one
  foreground -- and is for shape: plots, sparklines, anything where the line
  matters more than the colour. `Pixels` is 1x2 with a colour per half, painted
  as an upper block whose foreground is the top pixel and whose background is
  the bottom, and is for pictures. Both skip a cell nothing was drawn in rather
  than painting it blank, which is what lets either sit on a background someone
  else drew; the braille blank is a real character that some fonts draw the dot
  frame for. A solid `Pixels` cell goes out as `█` in one colour rather than as
  a half block over itself, because several terminals render the half blocks a
  pixel short at small font sizes. Out-of-range points are ignored rather than
  refused: a plot clips at its box, and requiring every caller to bounds-check
  each point is how the check ends up in the wrong place.
- **A point the loop cannot step towards is out of range, and it is refused
  before anything loops.** `Dots.line()` is Bresenham, which ends by arriving at
  the end point: `NaN === NaN` is false, a step towards an infinity never
  arrives, and past 2^53 adding one is a no-op -- so `line(1e308, 0, 0, 0)` steps
  forever without moving, exactly the way one missing sample from a plot did,
  painting nothing while it did since `set()` ignores what it cannot place. The
  endpoints are truncated already, so what the guard asks is whether a step of
  one still means something, which is `Number.isSafeInteger` and not
  `Number.isFinite`. A point it can walk to is a different thing and still
  clips, which is the rule above -- including a long line that is merely slow to
  walk, since bounding that is a decision about clipping rather than about a
  loop that cannot end.
- **Every sub-cell entry point answers for a coordinate that is not a number,
  because none of them can.** Each comparison in a bounds check is false for
  `NaN`, so it passed straight through: `Dots.#locate()` reached `DOT_BITS[NaN]`
  and the row lookup threw a `TypeError`, `Dots.charAt()` reached `#cells[NaN]`
  and `String.fromCodePoint(NaN)` threw a `RangeError`, and `Pixels.#index()`
  wrote to index `NaN`, which a typed array drops, then handed `undefined` back
  with `Color` written on it. Three spellings of one hole in three methods whose
  shared contract is to ignore what they cannot place. `charAt()` truncates as
  well, because it builds its own cell index and a fraction reached the same
  `undefined`.
- **The style table is swept on growth, not on every frame.** Interning was the
  only way in and there was no way out, so the table grew for the life of the
  canvas: `paint()` clears the back buffer and interns again, and `Pixels.blit()`
  interns a style per cell, which is a new entry per distinct pixel colour per
  frame -- order of a million `Style` objects a minute at 80x24 and 60fps. Once
  `present()` has copied back over front, the live set is exactly what `front`
  names, and `StyleTable.compact()` keeps those and says where each one moved.
  Sweeping every frame is the obvious version and is wrong in the case that
  matters most: reading the live set walks every cell, which measures 0.013ms
  against an ordinary TUI frame's 0.10ms -- an eighth of the frame, forever, to
  reclaim nothing, since such a table settles at a couple of dozen entries and
  never moves. So the trigger is growth past twice what survived the last sweep,
  with a floor, which bounds the table at twice a frame's own usage and costs an
  integer comparison to the canvas that never needs it. A resize sweeps
  unconditionally and that is the cheap case: both grids come back blank, so
  nothing names a style and there is nothing to walk or remap. Indices move, so
  the sweep rewrites _both_ grids -- `back` is what the next `present()` is
  compared against whether or not anything repainted it -- and nothing outside
  the canvas may call `compact()`, because only the owner of both the table and
  every grid painted with it knows when that is safe.
- **`FakeTerminal` defers the wrap, because `DiffResult` says the diff does.**
  Writing the last column of a row does not advance the cursor -- there is
  nowhere to go, so the terminal stays put and arms a wrap that the next graphic
  character takes, and any cursor movement disarms it. The model walked the
  cursor off the edge instead, which agreed with neither a real terminal nor the
  diff, so asserting `wrapPending` or the clamped `column` would have failed the
  _harness_ and both fields went untested. Now every `replay()` checks all three
  against the model rather than the one test that thought to ask, since a backend
  positions itself by them and cannot see that they are wrong. Modelling it
  found no disagreement with the diff over the wrap itself: the diff already
  assumes the deferred reading, which is why a full row followed by the row below
  it emits CUD before the `\r` and lands where it meant to. It did find one next
  door -- **the model measures with `cellWidth()`, because that is the only width
  the grid and the diff ask about.** It was asking `graphemeWidth()`, which sums
  what a cluster contains and comes to three for a CJK character with a spacing
  mark, so the model ended a column to the right of where the diff said the
  cursor was, refused such a cluster at the second column of a grid that had
  already fitted it into two cells, and reported its own continuation as an
  orphan. Nothing caught it because nothing pointed a replay at that cluster and
  nothing asserted the cursor. Whether a terminal really defers, and what it
  really does with a three-column cluster, are the things neither can answer, and
  are `scripts/terminal-probe.mjs`'s.
- **A backend is where the anchor lives, and an app picks it rather than a
  component.** The canvas is a rect that does not know where it sits; the two
  backends are what know. Inline is the last few rows with the log scrolling
  above, which is what a prompt, a spinner and a progress bar all want; full
  screen is the alternate buffer, for a dashboard or a viewer. A component that
  unilaterally took the screen in the middle of a build log is the failure the
  split exists to make impossible, which is why a backend is constructed by the
  app and cannot be asked for from inside a spinner. They do not nest, and that
  costs nothing to enforce: the live claim is already exclusive, so an inline
  canvas inside a full-screen one is a second holder of a claim that has one.
- **The inline backend reserves its rows with newlines before it paints
  anything.** Downward movement is CUD, which stops at the bottom margin and
  never scrolls -- so a canvas rendered with the cursor on the last row of the
  screen would paint every one of its rows onto that line. `height - 1` newlines
  scroll the log up to make the room, and the walk back up puts the cursor where
  the diff expects to start. Everything after that is relative, because the
  canvas's own row on the screen is not a number anything can learn: the log
  above it moves.
- **Anything that invalidates the screen throws the anchor away rather than
  diffing against it.** A resize, a write above the region, an eviction: the
  rows are given up and reserved again on the next present, which repaints in
  full. After a resize the old frame's row count is not even a number any more --
  it was written at the old width and the terminal rewrapped it wherever it
  liked -- so a diff against it is a diff against a screen that no longer exists.
  A canvas that _shrank_ leaves the rows it gave up blank behind it, which is a
  cost paid where it is visible rather than by walking the log up to close a gap
  nothing else can see.
- **An inline canvas is the terminal's width unless it was given one.** A canvas
  wider than the screen is one whose rows the terminal wraps, and a wrapped row
  is an extra row the cursor arithmetic does not know about -- every erase and
  every move after it is out by as many rows as wrapped. A width passed in is
  kept and not followed, because a caller that named one is describing content
  rather than a screen.
- **What a backend writes ends its lines with CRLF.** A bare `\n` reaches column
  zero only because the line discipline translates it, and ONLCR is off in raw
  mode -- which is where a full-screen app and every prompt live. Untranslated,
  the second line of anything written starts under the end of the first. Found by
  the screen model rather than reasoned out: the model implements the strict
  reading, which is the one a terminal in raw mode gives. The plain-text path a
  pipe gets keeps a bare `\n`, because a carriage return in a log file is not a
  line ending anybody asked for.
- **Leaving the alternate screen is `Terminal.restore()`'s, not a backend's.** A
  CLI that dies on the alternate buffer and never comes back has eaten the user's
  terminal, and `restore()` is what already runs on a signal, on `exit`, and on
  the way out of an uncaught throw -- so `enterAltScreen()` joins the cursor and
  raw mode on that list rather than a backend writing the sequence and hoping to
  get the chance to write the other one. It returns whether it was the call that
  switched, exactly as `hideCursor()` does and for the same reason. `1049` rather
  than `47`: it saves the cursor, switches, and clears in one sequence. The
  screen goes back before the cursor is shown again, so a cursor hidden while the
  alternate buffer was up is put back on the screen somebody is about to look at.
- **A full-screen backend holds what is written to it and flushes it on the way
  out.** There is no "above the region" on a screen with no scrollback, and the
  buffer is thrown away wholesale when it is left -- so a line written there
  would be read by nobody. Held rather than dropped, because a log line the app
  thought it had written is worse than one that arrives late, and the main screen
  is where its reader is. Unbounded on purpose: a cap that silently drops the
  start of a log is its own trap.
- **The backends are replayed against a screen, and it is not `FakeTerminal`.**
  That model is canvas-relative -- every `apply()` starts from the canvas origin,
  which is the only thing the diff's output claims to know about -- and a
  backend's whole job is the part it assumes away. `src/testing/screen.ts` -- which
  was `test/canvas/screen.ts` until it shipped -- has
  rows that scroll off the top, a cursor that survives between frames, and an
  alternate buffer to switch to, so what a test asserts is what the user would be
  looking at. Two models rather than one shared one, for the reason the styler
  and the wrapper keep separate SGR tables: each says what its own layer claims.
- **No passthrough image protocols: Kitty, iTerm2 and Sixel are out.** Fidelity
  is a capability tier the way colour depth already is -- cells always, then
  sub-cell block and braille characters everywhere, and that is where it stops.
  The tier above needs a rectangle of the screen that the cell grid does not
  own, which the diff cannot reason about, and it is unavailable in tmux, over
  most of ssh, in CI, and in Terminal.app. Images are approximated with half
  blocks instead: two pixels per cell, the top as the foreground and the bottom
  as the background, which is nothing but cells and works everywhere.

### Layers and masks: compositing, and the transition it buys

A canvas paints one grid. SIG-103 gives it a stack of them plus a per-cell field
deciding which one shows, which is what a dissolve, a wipe and an iris all are.
`src/canvas/buffer.ts` gains the occupancy bits, `src/canvas/layer.ts` is the
`Layer` and the composite, `src/canvas/mask.ts` is the threshold field and its
generators, and `src/canvas/index.ts` is where the composite runs and where the
style sweep had to grow.

- **A layer is a grid plus an origin, and the origin is the one position the
  canvas is allowed to have.** "A canvas is a rect plus an anchor, and it does
  not know its anchor" is about the _screen_: where the rect sits is a backend's
  business, because the log above an inline canvas moves. A layer's top-left
  relative to the canvas's own is a different number entirely, and it is one
  nothing has to ask the terminal for -- so the thing the canvas refuses to know
  is exactly the thing a layer may. Screen-sized or a sub-rect is the same object
  with a different buffer and a different origin; there is no second shape for "a
  small layer".
- **Nothing below the composite changed.** `diff()` sees `front` against `back`
  and has no idea how `back` got its contents, so this is a pass at the end of
  `paint()` and the wire is whatever the diff makes of the result. That is the
  whole of why it was a small change: `CellBuffer` and `Painter` were already
  exported and `new Painter(layer, styles)` already worked.
- **There is no "nothing here", and that is what occupancy is for.** `clear()`
  fills with `BLANK` in `StyleTable.DEFAULT`, so a space painted in the
  terminal's own colours is indistinguishable from a cell nothing painted.
  Compositing on `char !== BLANK` is wrong in the case anybody writes first: **a
  panel filled with a background colour is opaque and must occlude, and every
  cell of it is a blank.** So a `Uint8Array` sits beside `#chars` and `#styles`,
  set by `put()` and cleared by `clear()`, one byte per cell and 1,920 of them at
  80x24.

  A parallel array rather than a sentinel grapheme, which is the ticket's own
  argument and holds: a sentinel would be a third meaning for a slot that already
  carries two -- `BLANK` and `CONTINUATION` -- and it would have to survive
  `#breakCluster()`, `copyFrom()` and `toLines()`, each of which reads what a cell
  holds for a different reason.

- **The composite replays `put()`; it does not copy arrays.** This is the sharp
  edge of the feature and it is why the grid owns the repair. A layer cell landing
  on a wide cluster below has to take that cluster's **other half** with it, or
  the terminal is told to draw half a character and every column after it on the
  row is shifted. `#breakCluster()` already does exactly that, so going through
  `put()` buys the repair, the clipping at both grids' edges and the refusal of a
  wide cluster with no room for its continuation, for nothing. A raw `set()` on
  the typed arrays is faster and leaves half-glyphs on screen, which is asserted
  rather than asserted-about: the sabotage that replaces the `put()` with raw
  writes fails seven tests.
- **A continuation is skipped, and that is a statement rather than a guard.**
  `put()` would refuse one anyway, since `cellWidth('')` is zero -- so the skip
  changes no answer and says so where it lives. It is the one deliberate survivor
  of the sabotage pass below. What it buys is a `put()` call per continuation
  rather than correctness, and what it says is that a cluster is written once, by
  its lead, which is what writes both of its cells.
- **The mask is sampled once per cluster, at its lead.** A wide cluster is atomic:
  either both of its columns composite or neither does, because revealing one is
  revealing half a character. That is the rule `Painter.overlay()` already keeps
  for the same reason, and it means a field whose threshold falls _between_ a
  cluster's two cells does not split it -- which is the only arrangement that can
  tell a per-cell reading from a per-cluster one, and is what the test for it is
  built out of.
- **Array order is paint order, so the last entry is on top.** The reading
  document order already has everywhere else here, and the one that makes "push a
  layer" mean "put it in front".
- **The composite runs at the end of `paint()`, not at the start of
  `present()`.** `cells` is what a selection reads and `toString()` is what a
  snapshot reads, so both have to describe the frame that will be presented rather
  than the base somebody drew -- a selection taken mid-transition is over the
  composite. The consequence worth knowing is that a threshold moved without a
  `paint()` changes nothing: a frame is a `paint()`, and the composite is a pass
  inside one.
- **Binary per cell, and no alpha.** A "tint what is below" mode needs a
  background colour meaning _transparent_, and `DEFAULT_COLOR` is taken -- it
  means "the terminal's own", which is a different thing. That is an alpha model,
  it is a much larger decision, and nothing here needs one.

#### `sweepStyles()` was silently wrong, which is the half a layer stack changed

- **A layer holds style indices across a `compact()`, so it joins the live set
  and the remap.** The sweep read the live set off `front` alone, on the argument
  that `back` is re-interned from scratch by every `paint()` -- true while the
  canvas owned exactly two grids, and false the moment one persists across frames.
  A dissolve is exactly that: paint both states once and ramp for thirty frames.
  Left alone, the layer's indices are remapped to garbage underneath it.

  It is the shape of bug that ships, which the ticket called correctly: it fires
  only once the table has passed `SWEEP_MIN` **and** doubled, so a demo painting a
  dozen styles never reaches it. `should keep a persistent layer's styles meaning
  what they meant` grows the table to 281 entries over seven frames of forty
  distinct truecolour cells, which is the first frame that qualifies -- and
  `should actually have swept, which is what the test above rests on` is beside it,
  because without that one the first is vacuous: every index still means what it
  meant when nothing moved.

- **The grids are a `Set`, because `remap()` is not idempotent.** It rewrites an
  index through the move map, so a grid rewritten twice lands on
  `moved[moved[i]]`. Two layers legitimately share one buffer -- the same sprite
  at two origins is two `Layer`s over one grid -- so the duplicate is reachable
  rather than pathological, and the sabotage that makes it a list fails four
  tests.
- **A layer is live for exactly as long as it is in `layers`, and two shapes
  reach the window that leaves.** A grid that is not in the array when a sweep
  runs is one whose indices moved underneath it, and nothing can see that: the
  canvas owns the table and the grids it knows about, and a grid it has been
  handed back is not one of them. The obvious shape is a layer taken out and put
  back. The one found by re-reading rather than by a test is a buffer
  **snapshotted or painted before the `present()` that pushes it** -- the window
  is one `present()` wide in both cases, and the ordinary transition never opens
  it, because it snapshots and pushes in the same breath. What to do instead needs
  no new mechanism: leave a parked layer in with its mask's threshold at `-1`,
  which composites nothing, because the mask already means "which cells show".
  Recorded rather than guarded, for the reason `compact()`'s own doc gives --
  registering a buffer at `snapshot()` would be a registration nothing can ever
  unregister, since the canvas cannot know when the caller is done with it.
- **A resize drops the layers, and that is the honest answer rather than a
  convenience.** A transition spanning a resize is undefined because both grids
  are discarded, so a layer that survived one would be a rectangle sized for a
  screen that no longer exists -- and worse, `resize()` calls `styles.compact([])`,
  so its indices would point into a table with one entry in it. Sweeping them
  instead would mean compositing the old screen's content over the new layout,
  which is the fragment-of-the-old-frame failure a full repaint exists to prevent.
- **`back` joined the live walk as well as the remap, and it changes nothing.**
  The sweep runs after `front.copyFrom(back)`, so the two are identical there --
  reading both is the same answer, and it is the more honest statement of what the
  pass is for.

#### The cheap path is `snapshot()`, and it is what survives

- **A transition needs the previous screen's content, and that is the only thing
  here a caller cannot get for themselves.** A dissolve can already be faked
  inside the `paint()` callback by painting conditionally; what cannot be faked is
  that by the time anybody wants a transition, the state that produced the frame
  on screen is gone. `front` is exactly that snapshot and nothing outside can
  reach it, so `snapshot()` plus `layers` is the whole primitive and a transition
  is six lines of app code.
- **A copy rather than the buffer itself.** `present()` writes into `front` on
  every frame, so handing the live one over would give a layer that tracked the
  screen it is supposed to be a snapshot of -- which composites as a no-op, and
  looks exactly like a transition that is not working.
- **The occupancy travels with it, which is what makes a snapshot usable at
  all.** A copy that kept the characters and lost which of them were painted would
  composite as a grid of transparent blanks wherever the frame had nothing on it,
  and the whole point of taking one is that it occludes exactly where the frame
  did.
- **There is no `transition()` helper, and that is a refusal rather than an
  omission.** The ramp is a frame loop's and the canvas does not own one: it has no
  clock, no scheduler and no opinion about how many frames a dissolve takes. That
  is the same split this file already keeps between `scrollTo()` and the key that
  calls it, and between `skip()` and the gesture -- the mechanism is the
  framework's, the gesture is the app's. What the primitive does carry is
  `maskThreshold()`, which is the one piece of arithmetic every caller would get
  wrong once, because both ends are off by one.
- **Into a pipe the whole thing collapses to the end state, for free.** A backend
  with no terminal writes text and deliberately never calls `canvas.present()` --
  there is nothing to repaint -- so `front` stays blank, a layer over the snapshot
  has no occupied cell to composite, and every frame of the ramp is the new state.
  One line of log rather than eighteen half-dissolved ones, from the same code
  that dissolves on a terminal. That is the reduced-motion rule said one layer
  down: an animation with no screen to play on is one that has already finished.
  It falls out rather than being arranged, which is why it is pinned by a test of
  its own -- a behaviour that is right for a reason nobody wrote down is one
  somebody later "fixes".
- **`canvas.painter(cells)` exists because there was no way to build a layer.**
  Found by writing the test rather than by reading the design: a cell holds a style
  **index**, so a grid painted through a table of its own holds indices that mean
  something else here -- `{ fg: palette(5) }` interned as 1 in a fresh table and as
  7 in the canvas's composites as whatever the canvas's 7 happens to be, which is a
  wrong colour on screen rather than an error. `snapshot()` is already correct
  because the canvas painted it; anything else had no sanctioned path at all.

  A method rather than exposing the table, because only something owning both the
  table and every grid painted with it can say when a `compact()` is safe -- which
  is why nothing in `style.ts` calls one, and a caller holding the table could.

#### A selection is the live tree's and a layer is a photograph

- **The highlight shows only where the new frame is visible, and the copy gives
  what is on screen.** Those are two different answers and the pair is the
  decision rather than an inconsistency to iron out. `paintSelection()` runs
  _inside_ the `canvas.paint()` callback -- it is "the selection last, so it is
  over everything the tree drew" -- and the composite runs after the callback, so
  a layer paints over the highlight on every cell it covers. Meanwhile
  `Renderer.selectionText()` reads `backend.canvas.cells`, which **is** the
  composite, so a copy hands over the characters that are on screen.

  Which is the right way round. A selection is a region of the live tree, and a
  snapshot layer is a photograph of a frame that may have had a different
  selection on it or none; highlighting the photograph in the new tree's colours
  would be asserting something about content the tree does not own. So during a
  dissolve the highlight arrives along with the content it belongs to, and the
  copy is what the user can see. Not restructured so that the selection pass runs
  after the composite, which would be a change to the renderer's frame for every
  app taken inside a layers ticket -- the shape this file refuses elsewhere -- and
  would have to invent an answer for a photograph's selectability anyway.

- **A composited cell is masked by the element tree's `selectable`, because a
  layer has none of its own.** `selectableAt()` is computed from the tree, which
  describes the frame that was just painted rather than the photograph over it. A
  layer is a raw grid with no elements, so there is no third answer available: the
  alternatives are the tree's mask, which is what it uses, or treating every
  composited cell as uncopyable, which would make a transition a region nobody can
  copy out of. Recorded as a limit rather than guarded.

#### Masks are their own module, and are the easy half

- **A mask is a `Uint8Array` over a rectangle plus a threshold, and a cell shows
  when `values[i] <= threshold`.** Wipes, irises and dissolves are the same field
  with a different generator, which is the whole argument for the separation: none
  of it knows what a `CellBuffer` is and none of it imports one.
- **A module rather than a subpath.** `@ttylabs/sigil/canvas` exports it, because a
  mask is used _with_ a canvas and anybody who wants one already imports it. A
  `@ttylabs/sigil/mask` would be permanent API surface whose only consumer is the
  thing beside it, which is the argument this file already records for refusing
  `@ttylabs/sigil/figlet`.
- **256 buckets, not one value per cell, which is why the field is a byte
  array.** A permutation of 1,920 distinct ranks does not fit in a byte and nothing
  wants 1,920 steps of a reveal. What a generator produces is a cell's _position
  in the ramp_ scaled to the same 0-255 whatever the rectangle's size, so a caller
  ramping over thirty frames does the same arithmetic for an 80x24 canvas and for a
  three-cell one.
- **Scaled by `count` rather than by `count - 1`.** `floor(i * 256 / n)` spreads
  `n` cells evenly over the buckets, which is what makes a ramp reveal roughly
  `n / 256` cells a step; dividing by `n - 1` puts the first cell at 0 and the last
  at 255 and bunches everything between, which for `n` of two is a transition with
  one step in it.
- **`maskThreshold()` exists because both ends are off by one.** A cell shows at
  `<=` and a field always has cells at zero, so the threshold that reveals
  _nothing_ is `-1` rather than `0`, and the one that reveals everything is
  `MASK_MAX`. The progress is clamped rather than trusted, for the reason the
  decrypt component's own clamp gives: a `NaN` threshold compares false against
  every value, so a reveal driven by one shows nothing for ever with nothing to say
  so.
- **`masked()` says no about a cell it has nothing to say about.** A mask is a
  statement about its own rectangle, and the other reading would make a mask
  narrower than its layer silently reveal the whole right-hand side.
- **A generator's `Random` is clamped, and the clamp is load bearing twice.**
  `unit()` reads a value at or above one as just under it, because this is an index
  multiplier and `1` is one past the end: without it a hostile source swaps a cell
  with `undefined` and leaves a hole in the permutation, and a hole is a value
  nothing reveals, so a cell stays hidden for the whole transition. `NaN` is read
  as zero rather than propagated, for the reason every other reader of a fraction
  here gives.
- **`seeded()` and `Random` moved to `src/util/random.ts`, because there are two
  callers now.** The rule that function was written under is "one algorithm in this
  repository rather than two", and `src/canvas/` may not import `src/components/`
  -- the dependency already runs the other way, since a component imports the
  canvas. Both barrels re-export it, so each answers for the generator its own
  documentation says is injectable and a caller wanting a mask does not drag the
  240 kB component stack in to get a seed. `decrypt.ts` re-exports it through
  `../canvas/index.js` rather than from `src/util/` directly, because that file is
  a `sigil add` entry and a registry component may only import what the package
  exports -- `generate-registry.mjs` refuses the deeper specifier **by name**,
  which is that rule being a build failure rather than a comment, and is how it
  was found.

  And it costs the components path **nothing**, which was worth measuring rather
  than hoping: the obvious worry is that a component reaching `seeded` through the
  canvas barrel drags `mask.ts` and its void-and-cluster class into the chunk
  every app importing `@ttylabs/sigil/components` loads. Measured as the
  transitive byte weight of each entry's own import graph -- which is what an
  unbundled app actually loads -- the barrel route was **196,141 B** against a
  local copy's **196,238 B**: 97 bytes _smaller_, because the duplicate function
  is bigger than the re-export and the mask code is shaken out of the components
  reachability altogether. The canvas entry is 33,796 B either way. So the "one
  algorithm" rule is free here rather than paid for, and `rankAll` appearing in
  the shared `canvas-*.mjs` chunk -- which it does -- is the _canvas_ entry's
  reachability rather than the components entry's.

#### Blue noise against a shuffle, measured

- **Two dissolve generators ship, because the trade is real in both
  directions.** `dissolveMask()` is an even permutation of the ramp, shuffled:
  each step of the threshold takes about the same number of cells. What it does not
  have is spatial evenness _within_ a step -- the cells revealed between two
  thresholds are drawn from the whole rectangle uniformly, so they clump by chance.
  `blueNoiseMask()` is void-and-cluster (Ulichney 1993), which cannot clump,
  because a cell that would is exactly the one it ranks last.
- **The difference is 0.813 against 4.250, and it is the only assertion that can
  see it.** The mean variance of the per-block revealed count over 4x4 blocks at
  half the ramp, over eight seeds. Both generators lay the _same_ even ramp, so the
  histogram -- which is what catches a phase that ranked one cell twice -- cannot
  tell them apart at all; `should spread each step more evenly than a shuffle does`
  is the differential, and replacing the void-and-cluster with a plain shuffle
  fails it and nothing else.
- **What it costs is a frame eighty times the length of the ones after it.**
  Measured over three runs: **8.34 / 8.40 / 8.71ms** for 80x24 and
  **1.10 / 1.13 / 1.15ms** for 40x12, against `dissolveMask()`'s **0.25ms** for the
  same 80x24 and a frame this file already records at 0.10ms. It is generated
  **once**, so a thirty-frame transition pays it on the frame the transition
  starts -- which for a full-screen dissolve is a visible hitch at exactly the
  moment somebody is looking. Build the mask before the transition starts, or reach
  for the shuffle, which is `O(cells)`. That trade is why both ship rather than one.
- **Phase zero needs a _strict_ improvement, or it does not terminate.** The
  published loop moves the tightest cluster into the largest void until "the largest
  void is where the cluster was", and two equal-energy cells then swap back and
  forth for ever -- exact ties are not exotic, since a symmetric arrangement on a
  small rectangle produces them. Requiring the energy to fall makes the total
  strictly decrease each move over a finite set of arrangements, so there is nowhere
  for a cycle to be, and it needs no iteration bound on top.
- **The initial pattern is a partial Fisher-Yates, and that is a hang rather than
  a preference.** "Pick a cell, set it if it is free, try again" terminates only
  for a generator that eventually answers something else: a stuck one -- `() => 1`,
  which the clamp turns into the last index, or `() => NaN`, which it reads as the
  first -- hands back the same cell for ever and the second of `ones` never lands.
  **Found by the test written to assert the clamp, which hung instead of failing**,
  which is the sharpest argument for walking the degenerate inputs there is. A
  shuffle takes `ones` steps whatever the source answers.
- **The three phases share one cursor, and the ranges they used to have could
  overwrite each other.** Phase one ranks the prototype's own cells into
  `order[0..ones-1]` and the two after it fill the rest -- and `half` is not
  reliably above `ones`: for a one-cell rectangle it is below it, so a phase three
  starting at its own `half` would overwrite what phase one had already written.
  Sharing the cursor also means a phase that gives up early is continued from rather
  than skipped over, which is the difference between a short order and one with a
  duplicate in it. `should rank every cell exactly once` walks eight rectangle sizes
  down to 1x1 for exactly that, because a duplicate leaves one cell that never
  reveals and another that reveals twice.
- **Toroidal, as the published algorithm is.** A terminal rectangle has edges and a
  torus does not, so wrapping is a choice: it is taken because the alternative is a
  field whose cells near an edge see less energy and are therefore preferred, which
  puts a visible bias along all four sides of the reveal.
- **An iris is scaled by distance rather than ranked by position.** What decides an
  iris is _how far_ a cell is rather than how many cells are nearer: ranking reveals
  a constant number of cells per step, which makes the circle crawl at the start and
  race at the end. Measured, a centred iris at half the ramp has **307 of 861 cells**
  -- 35.7%, not a quarter, because the disc at the full radius reaches the corners
  and so extends past the rectangle's own edges -- where a ranked field would have
  exactly half.
- **And a row is worth two columns, by default.** A terminal cell is about twice as
  tall as it is wide, so a field built on raw cell distance draws an ellipse twice
  as tall as it is round. `aspect` is the knob and `2` is the usual ratio; a caller
  whose font says otherwise says so.
- **`wipeMask` and `irisMask` ship although the ticket's checklist named only the
  permutation and the blue noise**, because they are what make "masks are not a
  layers feature" a demonstrated claim rather than a sentence -- each is a handful
  of lines over the same field, and `demos/canvas/06-transitions.js` is the caller
  that makes all four one mechanism on screen. That is the rule `which` waited
  eighteen months on, satisfied rather than waived.

> Moved: _What the first review round found_, _What the second review round found, and the shape it came in_, _Two defects this found that predate it_, _What the sabotage pass caught, and the one survivor_ — see [docs/history/layers-and-masks-compositing-and-the-transition-it-buys.md](../../../../docs/history/layers-and-masks-compositing-and-the-transition-it-buys.md).

#### The composite is fuzzed, and the fuzzer was vacuous for its first run

- **240 random composites, checked on the grid and replayed against the model
  terminal.** A scattered base, a scattered layer of its own size at an origin
  that may hang off any edge, and a field that may be open, a wipe, a dissolve or
  arbitrary bytes. What is asserted is the invariant the whole wide-cluster
  argument is about -- no orphaned continuation and no orphaned lead -- plus the
  two properties a transition rests on: **idempotence**, since the second pass
  meets a base already holding the layer's content and `#breakCluster()` has to
  make the same decisions, and **monotonicity** in the threshold, because a cell
  the layer showed at one threshold going back to the base at a higher one is a
  dissolve that flickers rather than resolving.

  Three of six composite mutations are caught by the fuzzer alone -- raw writes in
  place of `put()`, and each half of the cluster repair -- and all six by the
  canvas suite.

- **Its first version asserted nothing at all, and the reason is `seeded()`.**
  It built a fresh `seeded(seed)` per iteration, and xorshift32 **cold-starts
  small** -- the first draw is very nearly linear in the seed, measured at 6.30e-5
  for seed 1 and 1.51e-2 for seed 240, so `1 + floor(random() * 7)` was **1 for
  every one of the 240 seeds**. Every grid was one column wide, which is a grid
  too narrow to hold a wide cluster at all, since `put()` refuses one with no room
  for its continuation. So the corpus contained zero wide clusters, measured, and
  the test passed with the cluster repair _deleted_ and nothing said a word. One
  generator across the loop is what `layout-stress.test.ts` already does for
  exactly this reason, since only its first tree is cold.

  The property is written on `seeded()` now rather than only here, because it is a
  fact about that function which its next caller will meet. Which is also the one
  correction worth recording about this entry: the first version of it said "every
  grid was 1x1", and the measurement says the _width_ collapsed for every seed
  while the height did not -- the sharper statement, and the one that explains why
  no wide cluster was ever written.

  That is the fixture-too-easy failure this file records from the animator and
  from the decrypt pass, arriving through a new door: not a hand-picked input that
  missed the branch, but a **generator** whose output distribution was nothing
  like what the test's shape implied. A sabotage pass cannot find it, because the
  mutation really does survive -- the suite is a true statement about a corpus
  that is not there.

- **So the fuzzer counts what it met and refuses to pass without it.** Four
  counters -- grids that held a surviving wide cluster, composites that painted
  anything at all, composites a mask withheld a cell from, and composites that
  landed on a cell of a wide cluster -- with floors under the measured
  323 / 82 / 37 / 33. The first counts per **grid**, base and layer, so its
  ceiling is 480 where the other three are per composite and theirs is 240; said
  as "of 240" in the first version of this entry, which a review round caught.
  They earned the counting three times over:

  - the 1x1 corpus had **zero** wide clusters in 240 rounds;
  - the second spelling, with origins uniform over two columns past each edge,
    **missed the base entirely on 187 of 240 rounds**, so three quarters of the
    corpus was asserting that nothing composites to nothing. One column and one
    row past each edge reaches every clipping case and leaves the overlap the
    common one;
  - and the fourth counter, added last, said the first three were still not
    enough. `wide` and `overlapped` between them say a wide cluster was generated
    and that _something_ overlapped, which is not the same as the overlap having
    met the cluster -- it had, on **14** of 240 rounds, because `scatter()` wrote
    left to right and the next column took the continuation and the lead with it
    two thirds of the time. Stepping past the continuation a wide cluster just
    left takes it to **33** and takes `wide` from 193 to 323, and a base of whole
    wide clusters is the realistic one anyway, since that is what text painted
    into a grid looks like.

  A fuzzer that reports what it covered is the shape to copy. The invariant it
  checks is worth nothing without it, and nothing in a green suite distinguishes
  "no counterexample exists" from "no example was generated" -- nor, one step
  further in, "the example was generated" from "the example reached the branch".

#### The model terminal moved, and the reason is that there are two readers

`test/canvas/fake-terminal.ts` holds `FakeTerminal` and `replay()`, which were
private to `diff.test.ts`. The composite's claim is the diff's own said one layer
up -- these bytes turn what is on screen into what should be -- because a
composite reaches the screen through the diff and through nothing else, so every
composite case is a replay rather than a read of the grid. Two copies of a model
terminal is two models to come to disagree about the deferred wrap, which is the
thing this repository writes down about every rule it says twice.

It is deliberately not `screen.ts`, which is the backend's and is _screen_-
relative: that one has rows that scroll off the top, a cursor that survives
between frames, and an alternate buffer to switch to. This one is
canvas-relative, because every coordinate the diff emits is, and a backend's job
is the part it assumes away.

What the move buys the composite for nothing is `checkClusters()` and the cursor
assertion, which is the invariant the whole wide-cluster argument is about: no
frame may _end_ with half a glyph on screen, and a backend positions itself by
`DiffResult`'s three fields and cannot see that they are wrong.

The move itself changed no behaviour, and that was checked rather than asserted:
diffed against `main`, the harness body differs by four type annotations that
`isolatedDeclarations` requires of an exported `const`, the `Replayed` interface
it requires of an exported function's object literal, and one paragraph of the
class doc that belongs on the module now. `diff.test.ts`'s own tests are
byte-identical. A refactor inside a feature branch is where a test quietly loses
an assertion, so the diff is the evidence rather than the green suite.

> Moved: _What the ticket got wrong, and what it left open_ — see [docs/history/layers-and-masks-compositing-and-the-transition-it-buys.md](../../../../docs/history/layers-and-masks-compositing-and-the-transition-it-buys.md).
