# `packages/sigil/src/renderer` — deliberate decisions

These are the entries from [../../../../AGENTS.md](../../../../AGENTS.md) that are about this directory. Claude Code loads this file when it
works with files here; other agents should read it before changing
anything in this area. The root `AGENTS.md` holds the rules that apply
everywhere and still applies in full.

How each of these was arrived at — the review rounds and sabotage
passes — is under [docs/history/](../../../../docs/history), linked from
the entry it belongs to.

## Deliberate decisions — do not "fix" these

### Rendering a tree to a string

- **A table in a log and a help screen on stdout are element trees, and
  `renderToString()` is where they come back out.** The same layout engine, the
  same painter, the same cell grid a canvas uses -- and then the grid is read
  back as lines rather than diffed against the last frame. That is what let the
  two-column help layout and the table's column arithmetic be deleted rather
  than rewritten: what a string renderer needs that a canvas does not is a way to
  finish a line, and that is the whole of this module.
- **Every line ends in the state it began in.** One joined onto another, or
  written into a log beside something else, must not carry its colour into what
  follows. The link is closed separately from the colours, because SGR and OSC are
  separate state -- the same reason the frame end does it.
- **A blank that shows nothing is written in whatever is already open, and a
  trailing run of them is dropped.** One list decides both, and it is the
  attributes that draw on a space: a background, an underline, a strikethrough,
  an overline, an inverse, and a hyperlink. `bold`, `dim` and `italic` are not on
  it, because a space wears none of them. The first half is what stops a bold
  heading's padding surviving as trailing whitespace nobody can see; the second
  is what stops a paragraph -- which is a row of one-word elements, so the gap
  between two words is an unpainted cell -- closing and reopening its style at
  every space, which turned one dim parenthetical into a sequence per word.
- **It is laid out at the width it was given and painted into a grid as big as
  the layout came to.** `arrangedExtent()` walks the arranged tree, in both
  directions, because `measureNode()` is a guess: a box with a declared width
  reports that width however far its content overflows it, and an item flexed
  against a width its own ancestor was still guessing at can be placed at another.
  It used to be a guess in a third and much commoner way -- a row whose children
  flex was measured with each child offered the whole content box and placed with
  each given a share -- which SIG-125 closed, so a description that wraps one line
  further than the row reserved is no longer the case this exists for. It is still
  what makes a flag name longer than the
  terminal survive -- which is the rule help already had, and which a grid the
  width it was laid out in would have turned into a silent truncation now that
  `text-overflow` is honoured. The height is grown only where the caller named
  none, since a caller that did is describing a box rather than asking how big one
  is; the width is not the caller's to name and always follows the content.
- **And it is a frame rather than a layout, which is what makes a windowed list
  inside one correct.** It dispatches `Element.onResize` through the shared
  `settleResized()` after the layout, restyles what the handlers built and lays out
  again -- the same pass the renderer takes, because a resize answered in one frame
  and not the other is the divergence this file keeps closing. The **growth** pass one
  entry up runs again with it, which took a review round: a handler can grow the tree
  too, and the grid is allocated from `height` rather than from the extent, so a root
  whose `onResize` appended an eight-row child came back as **one line** -- the
  measure saw an empty root and nothing asked again. A `ScrollBox` cannot reach it,
  which is why no test did: it clips, so `arrangedExtent()` stops at its border box,
  and its spacers give the measure the whole list's height before any handler runs. The restyle here is a
  **fresh** `Restyler`, which is a full re-match and is the cost this path has: a
  kept one is marks-driven and there is no `Tree` for a `setProp()` to record
  on, so a spacer whose height a new window just wrote would keep the style it
  already had. Measured as exactly that -- a range of 500 where it should have
  been 492, with the rows painted correctly over the top. See "Windowing a
  long list" in `src/components`.
- **It asks how much room the answer takes, which is not how far the boxes
  reach: a box an ancestor's `overflow` clips away takes none.** That walk had
  no reference to clipping at all, which this file diagnosed twice and left to a
  ticket of its own (SIG-130). What it cost is a grid sized for a box nobody can
  see. Measured, a one-row pane over a four-row column that cannot shrink came
  back as `['r1', '', '', '']` -- four rows, three of them blank, with the clip
  perfectly correct and only `r1` drawn. The **width** half over-allocated
  identically and was masked, because a line's trailing blanks are dropped: a
  ten-column reel in a one-column window printed as one character over a grid
  that was still ten wide, so reading the trimmed string says nothing and the
  test for it asserts the extent.

  The worst of it was not the synthetic case. A `ScrollBox` is the one shipped
  component that clips, and `renderToString()` of a three-row one over fifty rows
  came back as **fifty lines, forty-seven of them blank** -- its own tests all
  pass a height, which skips the second pass entirely, so every one of them
  dodged it. The renderer's auto-height canvas reads the same walk and
  `mountLive()` asks for `width: 'auto'`, so a spinner, bar, prompt or table in a
  clipping layout held those rows of the user's scrollback open for the life of
  the frame.

  What is **not** the rule is "did anything escape": overflow nothing clips still
  grows the grid, which is what makes a flag name longer than the terminal
  survive, and that non-regression is the whole difficulty of the ticket rather
  than a footnote to it. Measured differentially against the old formula over a
  sixty-entry help screen, a long flag, a bare `text` root with a declared width
  and a bordered box: identical in every one, and only the clipped shapes moved.

- **And the whole of it is "a box that clips is where the walk stops", because
  there is no clip _rectangle_ left to read.** The first fix was the obvious one
  -- hand the walk the element tree, read `element.clip`, clamp each box to it,
  and refuse one the clip does not reach -- and it is two guards and a signature
  change more than the answer needs. The stop subsumes them: a clipping box's
  descendants are each clipped to its padding box, which is inside the border box
  it has just contributed, so nothing below can ask for more room. Which means no
  box with a clipping ancestor is ever _visited_, so every box the walk does see
  has no clip at all and its own far edge is exactly right for it. Both guards
  were therefore unobservable through the returned maxima, which is the state this
  file calls dead code rather than defence -- found by a review round pointing at
  something else.

  So `arrangedExtent()` still takes the `LayoutResult`, reaching the style through
  `result.node`, and neither call site moved. That also retires a guard the
  element walk needed and this does not: `layoutNode()` returns before it reaches
  a hidden node's children, so walking elements reads whatever boxes a _previous_
  arrange left under a `display: none` -- measured, a panel laid out visible and
  then hidden still reported its four rows -- while the layout result simply does
  not contain them.

- **The root's own box is the answer where the root clips, and the space it was
  offered where it does not.** The asymmetry is one rule rather than two: a
  clipping box takes room for its whole border box and nothing inside it adds,
  and that is as true of the root as of any other -- while a root that clips
  nothing has a box which is only what the call handed it, which is the reason
  the root is skipped at all.

  It has to be the **border** box and not the padding box it clips its children
  to, which is what the first fix got wrong by asking the children instead: the
  clip is deliberately the padding box, because the border _is_ the edge and a box
  that clipped itself would erase the frame it is drawing -- so the clamped
  children stop one cell inside the border and the grid came out a column short
  of the frame the pane was about to draw. Measured, an eight-column bordered pane
  with `overflow: hidden` rendered at four came back as `┌──────` with the right
  edge gone. The old walk covered it by accident, through an unclamped overflowing
  child. A non-clipping root with a border and nothing reaching that far loses it
  the same way and always has, on `main` identically; that is the root-skip's own
  hole rather than this one's, and it is left alone.

  And it is the root's far **edges** rather than its size, which is the same read
  the walk already takes and is the one place the root differs from every other
  node: `layout()` applies the root's own relative offset, because every other
  node's is applied by the parent that places it and the root has no parent. So
  `result.box.height` is not where the root ends. Measured, that bordered pane at
  `position: relative; top: 2; left: 2` came back as `["", "", "  ┌─────"]` -- the
  top border row alone, with the text and the bottom border past the end of the
  grid, and the right border cut. Floored at zero for the other direction, where
  a negative offset puts the whole box off the first cell and none of it is drawn.
  The **childless** branch reads the same two numbers through the same function,
  because it had the identical hole and had it on `main`: a childless
  `position: relative` root with `top: 2` drew its one row at row two of a one-row
  grid, which is to say nowhere. Found by a second review round pointing at the
  first one's fix.

- **What it costs is a `clipsContent()` call per node, and what it buys is the
  walk.** Six interleaved rounds against the old formula: a sixty-entry help
  screen is **0.00952ms against 0.00439ms** median and a two-hundred-row table
  **0.00739 against 0.00390** -- five and three microseconds, on renders this file
  already records at 8.5ms and 4.7ms. The other direction is the one worth having:
  a ten-thousand-row list inside a 24-row clip is **0.00027ms against 0.15715ms**,
  because it visits three nodes rather than 30,003 to learn how big a one-row
  window is.

- **It costs what the stack costs, and where that cost goes was profiled rather
  than guessed at.** A sixty-entry help screen is 10.2ms against the old string
  builder's 0.42ms, and a two-hundred-row table is 6.3ms against 0.08ms. End to
  end, where a CLI also pays Node's own startup, asking
  `demos/parser/02-options.js` for its help went from 34.7ms to 40.9ms. It is
  linear in the number of _words_ rather than of rows, at about 13 microseconds
  each, because a paragraph is a wrapping row of one-word elements -- so a
  sixty-option screen with twelve-word descriptions is seven hundred elements,
  and one with five hundred options is 168ms, which is the size at which
  somebody would notice.

  The first version of this entry said almost all of it was the cascade, at
  about 3.5 microseconds per element. That was inferred from the invalidation
  entries rather than measured, and a CPU profile says otherwise: the cascade --
  `initialStyle`, `#resolve`, `camel` and `applyPropsInto` together -- is about
  14%, while **grapheme segmentation is 24%**, text wrapping another 9%, and the
  garbage collector 8%. Splitting `graphemes` by who called it is what names the
  actual seam: half of it is `wrap()` reached from `#measureText`, and the other
  half is paint, which walks the clusters again _and wraps the string a second
  time_ because the measurement cached the height it came to and not the lines
  it came to. So the same text is tokenized into clusters at measure time and
  again at paint time, and `stringWidth()` over every word of that screen is
  0.027ms on its own -- the work is not the measuring, it is doing it twice.

  That seam is now closed, and the numbers above are what it cost before:
  a help screen is 8.5ms and a two-hundred-row table 4.7ms, which is a quarter
  and a fifth off, with the rendered output byte for byte what it was. A text is
  wrapped once and paint reads the lines rather than making them again, and the
  property-name lookup the cascade makes per declaration per element is memoised.
  Neither changes a decision -- what a text comes to at a width is still one
  answer, and it is now one answer literally rather than two that agree.

  What did _not_ work is worth as much as what did, because it is the obvious
  thing to try next. `initialStyle()` builds a fifty-property object by writing
  computed keys onto `{}`, which reads like the textbook way to produce a
  dictionary-mode object -- so it was replaced with one template cloned per call.
  That was **slower**, by 27%, and `Object.assign()` in place of the spread was
  slower again, by 47%. Cloning a fifty-property object costs more than building
  one, in this engine, today. It is measured here rather than reasoned about
  because the reasoning was what got it wrong.

- **The media queries are the caller's, apart from the width and the colour
  level.** Those two this call is the authority on; the other half of a query is
  "how much screen is there", which a string being built has no answer to that the
  caller does not already have. The cascade is handed back exactly as it was
  found, because a `table()` inside a running app shares its sheets with the frame
  loop and a media context left behind would be the next frame's answer to a
  question about a screen this render was never about.
- **A newline in a run is a break the author wrote, and a paragraph keeps it.**
  Built as a column of wrapping rows when there is one and as a bare row when
  there is not, since the common case is a single line and an extra flex item for
  nothing is one the layout still has to place. Runs of spaces _are_ collapsed,
  which is what CSS does with `white-space: normal` -- so anything verbatim, an
  example's command line above all, is a `text` rather than a paragraph: two
  spaces lining a flag up in an example are the author's, and a paragraph is
  words with one space between them.
- **A paragraph is a wrapping row of one-word elements, and that is how inline
  styling is done.** There is no inline layout: a `text` wears one style, and
  three texts in a row are three flex items, so a wrapped first item leaves the
  other two beside its _box_ rather than after its last line. What there is
  instead is flexbox, and a wrapping row of words is word wrapping -- the gap
  between two items on a line is the space between two words, a line breaks where
  the next word does not fit, and each word may be styled on its own. That is what
  makes help's dim `(default: ...)` sit on the same line as the description it
  follows, and it costs no new layout mode. A word wider than the line overflows
  rather than being broken, which is what `wrap()` does with one too.

### The renderer

- **A component body runs once, and there is no re-render.** A component is a
  function of props that builds elements; what is reactive about what it built
  are the `createEffect()`s inside it, which write to the node they made. No
  virtual tree, no diff, no reconciler -- a signal change runs the one effect
  that reads it and touches the one node it wrote, and the frame that follows
  restyles, lays out and paints whatever that disturbed. This is the Solid model
  and it is why signals came first. The tax is that control flow has to be
  explicit, which is the entry below.
- **The owner tree is what unmounting means.** Something has to know what a
  component made, because a long-running CLI that does not leaks a watcher per
  mount and nothing above can see them to clean up. So every body runs under an
  owner: `createEffect()` registers with it, `onCleanup()` adds to it, context is
  looked up along it, and disposing it disposes its children first and then its
  own cleanups in reverse -- the order things were built in, undone. Every
  cleanup runs even when one throws, for the reason the signals layer already
  records: what a teardown that stopped half way leaves behind is a subscription
  nobody can reach to cancel. A caller that asked for the disposal gets the
  throw; an unmount the renderer did on its own reports instead.
- **`runWithOwner()` establishes a fresh ownership scope, at both levels, and
  three things had to be put aside for that to be true.** The owner, obviously.
  Then `runCleanups`, or an `onCleanup()` inside it goes to the _effect run_ that
  is on the stack rather than to the owner being borrowed -- which made `For`
  tear down every row at the end of every reconcile, rows that had not gone
  anywhere included. Then the signals layer's own parentage, which is the entry
  below. All three were found by `For` rather than reasoned out, and they are one
  rule said three times: what runs here belongs to this owner.
- **`unowned()` is the ownership twin of `untrack()`, and the renderer is why it
  exists.** An effect created while another effect's body runs is a child of it
  and dies when that body runs again -- which is what stops a component leaking
  an effect per run, and is exactly wrong where something else already owns the
  lifetime. `For`'s reconcile _is_ an effect body, so the implicit parentage
  disposed the effects of every row it had built, and a row that merely moved
  went dead: it kept the text it was last built with and stopped following its
  own state, while looking perfectly alive. Nothing leaks by opting out, because
  the caller opting out is the one that owns the branch and disposes it. See
  `test/signals/effect.test.ts`.
- **`onMount` fires after a frame, not at the end of the body.** The useful thing
  to do there is read what the component came out as, and `element.box` has no
  answer until something has laid it out -- so a callback that ran at the end of
  the body could only ever ask questions with no answers. It makes the promise
  the same for a component mounted by the first frame and one a `Show` revealed
  forty frames later. Under a bare `createRoot()` nothing drains the queue and
  the callback never fires, which is the honest answer rather than running it
  early against a tree that has no boxes.
- **Control flow is components, and they are the runtime primitive.** An `if` in
  a body runs once and a `.map()` builds the list it saw, so a conditional and a
  list have to be `Show` and `For` -- a component is the only thing that can own
  a branch and dispose it. A template compiler emits calls to these rather than
  growing a second way of saying it, so there is one implementation of what
  mounting and unmounting a branch means. Both return a `box`, because a
  component produces exactly one node and this layer has no fragment: that
  wrapper is a flex item and it lays out, which is a real cost, so both take
  `props` and the layout the branch would have had goes there. Getting it wrong
  is visible immediately -- a `For` whose rows should stack writes
  `props: { 'flex-direction': 'column' }` on the `For`, and putting it on the box
  _around_ the `For` puts every row on one line.
- **`Show` disposes its branch rather than hiding it, and rebuilds only when
  presence changed.** A hidden branch is still a branch and its effects still
  run, so a thousand rows behind a closed disclosure cost a thousand rows of
  reactivity; hiding is `visibility` and a different question. Rebuilding on
  every change to what `when` returned rather than on the change in _presence_
  would tear the branch down and build it again on every tick of a counter,
  losing whatever state it held -- so what the branch is handed is read untracked.
- **Which forces `children` to be handed an _accessor_, and the pairing it used to
  have was the one combination that is wrong.** There are two coherent designs and
  this file had already argued for half of each: a branch kept across a value
  change has to be able to _read_ the new value, and a branch handed the value
  itself would have to be rebuilt whenever it moved. `Show` handed over the value
  **and** kept the branch, so a `when: () => user.get()` whose user changed from
  one object to another left the branch describing the first one for the life of
  the process -- both are present, presence never moved, nothing was ever rebuilt.
  Which is the rule this file keeps everywhere else, met in an API signature:
  `children: (value: Truthy<T>) => Element` advertises live narrowed data and
  delivered a snapshot, and something that parses and then silently lies is worse
  than something that does not exist. The fix is the precedent sitting in the same
  file: `For`'s index is an accessor for exactly this reason, in exactly these
  words -- a row that moved is the same row, so telling it where it sits has to be
  a signal it reads. `Show` pays the same tax now, over a `State` holding the last
  present value, written before the early return because a value that moved while
  presence held is the case that early return is taken for. It is never cleared,
  which needs no guard: the only thing that can read it is a branch, and a branch
  exists only while presence held. What the accessor does _not_ do is make a
  build-time read live -- the build runs untracked, so reading it in an effect is
  the one way to follow a value, which is `For`'s contract said again and is pinned
  rather than left to be assumed.

  Found by **using** it rather than by writing it, which is the whole of SIG-118:
  `demos/renderer/02-tasks.js` wanted a detail pane over the task being inspected,
  which is the shape of every detail pane, error banner and selected row there is,
  and it was the first code in this repository to ask `Show` for a value it then
  had to **follow**. Counted rather than guessed at, and counted twice, because the
  first draft said "six of the seven" and the second "fourteen" and both were
  wrong: there are **seventeen** uses on `main` -- **nine** object calls
  (`01-app.js`, `counter-elements.js`, `animation.test.ts`, and six in
  `renderer.test.ts`) and **eight** template or JSX spellings (`counter-jsx.tsx`,
  `counter-tag.js`, three corpus entries, two in `jsx-types.tsx`, and
  `tag.test.ts`) -- and **sixteen** of them pass a boolean or a length comparison
  and ignore the argument entirely. The seventeenth does use it, inside a test
  about retrying a throw, where the branch really is rebuilt -- so even the one
  reader of that argument could not have seen the staleness. The split is written
  out rather than only the total, for the reason the toolchain's dependencies are:
  a number nobody can re-derive is a number that goes stale quietly, and this one
  went stale twice before it was derived at all. The three ordering bugs `For` cost were found by writing `For`;
  this one needed somebody to want something from it.

- **`For` keys by the item, and an index is an accessor.** Identity rather than
  position, because position keying rebuilds every row after the first change,
  which in a terminal moves the focus ring out from under whoever was typing. A
  row that moved is the same row, so telling it where it now sits has to be a
  signal it reads rather than a rebuild -- the rebuild would throw away the thing
  keying exists to keep. An item that appears twice is two rows, so the
  bookkeeping is a queue per key: two equal primitives in a list are a list with
  two entries in it, not a bug to refuse.
- **Nothing dirty means no frame, and no frame means no timer.** The scheduler is
  asked for a frame by a signal write or by a tree mutation, sets one timer, and
  a frame that finds nothing to do sets no other -- so a CLI that prints one line
  never starts a loop. Frames coalesce to `frameMs`, thirty a second, because
  pacing matters more here than on the web: every frame is bytes down a pipe that
  may be a network, and a spinner, a progress bar and a clock all quantize slower
  than that anyway.
- **A tree mutation asks for a frame, which is why `createTree()` takes a
  callback.** Not every change comes from a signal: a key handler that calls
  `setText()` directly is the ordinary case, and without this it is invisible
  until something else happens to draw. The tree already recorded it; the
  callback is only what turns recording into asking.
- **A structural change forces layout, and the restyler cannot say so.** It
  answers for what a _style_ change implies and for nothing else, while two other
  things move boxes: a text that was edited or a `raw` that re-measured, which is
  `marks.layout`, and a child added, removed or moved, which is `marks.children`.
  Found by a `For` that reordered its rows correctly and drew them in the old
  order -- the elements were where they should be and the frame had nothing
  telling it to lay out again.
- **A media query is asked about the screen, not about the canvas.** The
  difference matters in exactly one case and it is the one that would otherwise
  be a loop: an auto-height canvas is as tall as its content, so resolving
  `@media (min-height: 10)` against it lets a style decide a height that decides
  that style. "How much screen is there" has an answer nothing in the frame can
  move. Read again on resize, along with the full re-match a resize already
  forces.
- **An auto-width canvas is given a width, so that the backend stops following
  the terminal.** It reads backwards and it is the point: an inline canvas built
  without a width erases and resizes _itself_ on every resize, and an auto-width
  one is already re-measured and resized by the frame -- so a spinner twelve
  columns wide blinked off and back on every time the window changed by a column
  it was not using. A canvas that is neither auto nor fixed is left to follow the
  terminal, because nothing else would move it.
- **An auto-height canvas is laid out again where it reached further than it
  measured.** The same second pass `renderToString()` takes and for the same
  reason. What that reason _was_ is the common case SIG-125 has since closed: a row
  whose children flex was measured with each child offered the whole content box
  and placed with each given a share, so a prompt's question that wrapped to two
  lines in the share it got was one line in the room it was offered, and the canvas
  reserved one row with the second clipped off the bottom. The pass stays because a
  measure is still a guess in the ways that entry lists -- a declared width that
  overflows, and a percentage against a containing block nothing has settled --
  and because the alternative is trusting an estimate over the tree that was
  actually arranged. `arrangedExtent()` asks the arranged tree rather than asking
  for another estimate. It can only grow the canvas, never shrink it, so a frame
  that measured right pays one comparison -- and since SIG-130 it does not grow it
  for rows a clip hides, which is what had every spinner, bar, prompt and table in
  a clipping layout holding blank rows of the user's scrollback open.
- **And laid out again for what the layout told a size it did not know about, which
  is a different question behind the same shape.** That one asks how tall the
  answer came out; this one asks who needs rebuilding now that there is a box
  to read. `settleResized()` is the loop and both frames call it -- this one
  and `renderToString()` -- so a resize cannot be answered in one and not the
  other. What makes it the frame's rather than `arrange()`'s is the restyle it
  has to do in between, and the renderer drains the tree's marks a **second**
  time to narrow that to what the handlers touched, then shows the animator
  that settle so that an animation on a row the handler built starts at all;
  see "Windowing a long list" in `src/components` for the two defects that
  said so. It costs nothing on a frame of an app that has no `onResize`
  handler anywhere in its tree, which is every app with no windowed list in
  it: `arrange()` asks the question only of an element carrying the hook, so
  the collector is empty and there is nothing to dispatch or lay out again.
  Not "no box changed size", which is what this said and is a different claim
  -- a windowed list's **first** frame always collects, because nothing has
  been told anything yet.
- **An auto-height canvas is measured, not laid out and read back.** That was the
  first answer and it is wrong in the way that matters: a root with no declared
  height fills whatever it is given, so `box.height` after a pass at the screen's
  height _is_ the screen's height -- two rows of content reserved twenty-three
  rows of terminal. `measureNode()` asks what a node would want if it could have
  whatever it wanted, which is the question, and it replaced a two-pass arrange
  that was both slower and wrong.
- **`dispose()` finishes the region, which it had always claimed to do and did
  not.** An inline backend holds its rows until it is told otherwise, and with
  the anchor goes the arithmetic that says where the frame's top is relative to
  the cursor -- so a `console.log()` after `dispose()` moved the real cursor and
  left that arithmetic describing somewhere else. The erase the region does on
  its way out then started two rows _inside_ the frame and cleared downwards,
  taking the log line with it and leaving the top two rows of a box on screen,
  which is how it was reported. `backend.done()` is exactly the documented
  behaviour -- the frame stays in the log, the cursor goes below it -- so the
  teardown calls it, and ordinary output afterwards lands where it looks like it
  will. Not on the failure path: there the caller wants the frame gone, and
  `fail()` calls `stop()` itself. The order is the consequence worth knowing:
  erasing means `backend.stop()` _before_ `dispose()`, because afterwards there
  is no anchor for an erase to be relative to and a `stop()` on the other side
  quietly does nothing.
- **A failure puts the terminal back before it says why, and stops.** A CLI that
  dies on the alternate buffer with the cursor hidden has eaten the user's shell,
  and a message printed into a half-drawn frame is unreadable anyway -- so the
  order is teardown, `backend.stop()`, `Terminal.restore()`, and only then the
  error handler. Stopping is the other half: a renderer that reported and carried
  on would throw the same frame away thirty times a second, so the first failure
  ends the loop and the report happens once.
- **A frame that failed stops being a frame.** An effect that throws is
  _reported_ by the scope's error handler rather than thrown through it, so the
  flush returns normally and the rest of the frame ran over a renderer that had
  already given the screen back -- painting onto the restored terminal, and
  draining mount callbacks against an owner whose cleanups had all run. The
  handler cannot throw instead, because the signals layer is explicit that an
  error in an effect is never rethrown; so the frame asks whether it is still
  alive after the flush. That is the only place it can be asked, and it is why
  `runFrame()` checking on the way in was not enough.
- **A renderer gets its own effect scope, and sharing the module's was a trap.**
  A scope holds one scheduler and one error handler, so a second `render()`
  installed its frame loop over the first's: the first then painted nothing ever
  again, an effect that threw in _either_ tore down whichever had installed last
  -- restoring the terminal out from under the one still running -- and disposing
  one put back the handlers it had saved rather than the ones in place. The
  default is now a scope of its own, and it costs nothing, because
  `createEffect()` asks the owner it was created under for the factory rather
  than reaching for the module.
- **A branch builder that throws undoes its own half, and getting there took
  three orders.** Both control components had the same shape of bug and an effect
  caching what it threw is what made each permanent: the branch never retries
  until a dependency changes, and the recorded state says it has nothing to do.
  `Show` first committed presence _before_ the branch existed, so a `children()`
  that threw left `showing` claiming a branch that was not there and the next
  truthy `when()` returned early. Moving the commit after the build fixed that
  and left the inverse: the old branch was still torn down first, so `showing`
  kept the _old_ presence while what it named was already gone, and going back
  the way it came returned early to an empty host. So `Show` builds first and
  touches nothing on screen until it has something to put there -- which is also
  the only order where a failure needs no undo. `For` cannot do that, since its
  reconcile is a list, so it rolls back instead: every branch it made, _including
  the one it was part way through_, and every index it had already moved, because
  a row left reading a position the failed pass never placed it at paints the
  wrong number at the old spot. Its `fallback` is inside the rollback too -- built
  after `rows` was committed, it was the one branch outside it, and with the list
  already empty `each()` never changes again and the effect never retries.
- **A cleanup written inside an effect body is raised, not collected.** The
  owner tree collects what a teardown threw, because one failing cleanup must not
  leave the rest of it undone -- and the composite the _signals_ layer holds is
  not a teardown, it is that layer's cleanup, which it reports on a re-run and
  raises at `dispose()`. Handing it the array swallowed the throw: an
  `onCleanup()` in an effect body, which is where an unsubscribe belongs, failed
  in silence, while the same call one line up in the component body was reported.
- **A frame does not start from inside a frame.** `frame()` called from an effect
  re-entered `settle()`, and the flush it runs is a no-op while one is already
  draining -- so what the inner frame actually did was take the outer frame's
  marks and paint a half-settled graph, after which the outer frame found nothing
  left to draw. The frame already running is the one that finishes.
- **A disposed owner starts nothing new.** `runWithOwner()` is for a callback
  that outlived the body that registered it -- a key handler, a promise landing
  -- which is exactly the case where the owner may be gone by the time it runs.
  An effect created there would have no component to keep up to date and nothing
  that would ever dispose it, so it is not created. A cleanup registered there
  runs immediately instead, because nothing else ever will and a cleanup that
  never runs is the subscription the owner tree exists to cancel. A branch asked
  for there comes back already disposed, so that what runs under it starts
  nothing either -- a live branch parented onto a disposed owner is one nothing
  will ever walk again.
- **What a branch's cleanup threw is reported, not dropped.** `Show` and `For`
  dispose branches and are in no position to do anything with a throw, and
  `disposeOwner()` hands its errors back rather than raising them -- so they went
  nowhere. The root owner carries a sink that `render()` fills with `onError`;
  where there is none, they are raised, because a `createRoot()` with no renderer
  over it has nowhere to put them and silence is the one answer that is always
  wrong.
- **`Marks` grew a fifth question, and it is the one about an element that is no
  longer here.** `Restyler.forget()` was written for the leak it describes -- an
  unmounted subtree stays reachable for the life of the restyler, which in a TUI
  that shows and hides a panel is unbounded -- and nothing called it, because
  nothing knew what had been removed: `marks.children` names the _parent_, and by
  then the child is already gone from it. `removeChild()` records the child, and
  the frame forgets the ones that ended it detached. Ended, rather than were
  removed: `insertBefore()` is a move and a move is a removal followed by an
  insertion, so forgetting everything recorded would throw away the resolved
  style of every row a `For` reordered.
- **The restyler is on the handle, because one thing only its owner can do is
  something an app needs.** `touchSheets()` is how a stylesheet swapped at
  runtime says that every rule is stale, and a theme change has no other way to
  say it.
- **An `onMount` throw is reported and the renderer stays up.** A mount callback
  is not the frame: it runs after one, its throw says nothing about whether what
  is on screen is right, and tearing the app down over it is a worse answer than
  saying so.
- **What is deliberately deferred, and why it is not an oversight.** Whether
  `main()` grows a way for a command's `run()` to return a view is the parser's
  surface rather than the renderer's, and it wants the component rewrite (SIG-76)
  to say what a view is first. Async components are the harder one: a prompt is
  inherently async and `select()` returns a promise, so "render a tree" and
  "await an answer" have to be reconciled -- and doing it before anything has been
  ported would be a guess with nothing to check it against. `runWithOwner()` is
  the seam either will use, which is why it is public now.

#### Whether the explicit control flow is tolerable, and what the answer is worth

SIG-78 asked whether `Show` and `For` in place of an `if` and a `.map()` are
tolerable in real code or merely defensible in a design document, and SIG-118
asked it again because nothing had answered it. The answer is **yes, with one
real defect and five frictions**, and the evidence is weaker than the ticket
wanted -- which is worth stating first, because it is the part a later reader
needs in order to know what to re-ask.

- **The toolchain could not be the vehicle and was not made into one.** SIG-118
  named three, and `@ttylabs/cli` is the one that cannot work: it imports neither
  `/renderer` nor `/signals`, because a build tool's output is **static** --
  `report.ts` builds one tree per report and hands it to `renderToString()`, and
  there is nothing to react to. Making it reactive to tick the box would answer an
  ergonomics question with a rigged example, which is the opposite of what the
  ticket is for. The Titanium port (SIG-31) is the vehicle that would answer the
  question as asked, since the question is about somebody who did not design the
  API having to use it; it was out of scope, so what is written down here is a
  substitute and is labelled one.
- **A demo is weaker evidence, and the usual reason did not apply.** The ticket's
  own objection is that a demo author reaches for whatever the docs show. Here
  there was nothing to reach for: **no README documented either component** -- not
  the root one, not `packages/sigil/README.md`, not `demos/README.md`, whose only
  occurrence of the word was `Show help for a command` inside a sample help screen
  -- so the only prose about them was the module comment in
  `src/renderer/control.ts` and the entries above, and learning the shape of
  `ShowProps` meant reading the source.
  That is a finding in its own right and the cheapest one here to fix; the README
  section `demos/README.md` now carries is half of it.
- **`demos/renderer/01-app.js` was not evidence either, which is why the ticket
  was right that nothing had exercised them.** It uses both, and `git log` puts it
  in the **same commit as the renderer** -- framework-author code written beside
  the thing it demonstrates. It is also the narrowest possible exercise: a flat
  list, append and pop, one boolean toggle. No reorder, which is the whole reason
  keying exists; no row-local state, which is what keying buys; no nested control
  flow; no derived list; and no `Show` over a value, which is where the defect
  was.
- **So the vehicle is `demos/renderer/02-tasks.js`, and it is driven by hand.**
  It holds state while it is on screen -- each row owns an expansion flag and a
  move counter that nothing above it can see -- and it exercises the five things
  nothing else did: reorder, row-local state surviving one, a `Show` inside a
  `For` row, a filtered list into `each`, and a `Show` whose `when` produces a
  value. It is in the class of demo `demos.test.ts` cannot drive, since that
  spawns with stdin ignored, so it takes the no-terminal branch there and was
  exercised through a spawned child preloaded to answer `isTTY` -- the technique
  `packages/cli/test/output-forms.test.ts` already uses, with enough of a screen
  model to read the frames back. Every claim it makes was read off those frames.
- **What it found is one defect, and it is the entry above.** `Show` handed
  `children` a value and kept the branch, which is the one incoherent pairing of
  the two. It is fixed, pinned twice, and it is the argument for the ticket
  existing: three of the bugs `For` cost were found by _writing_ `For`, and this
  one needed somebody to want a detail pane.
- **What it found that is _not_ a defect** was checked and left alone, because a
  composition that works is worth knowing about too. `onMount` fires for a row
  built forty frames in. A row that arrives and leaves inside one frame is never
  built at all, which is coalescing rather than a dropped cleanup. An inner
  `Show`'s branch is disposed with the row around it. A `Show` whose `when` reads
  `index()` follows a reorder. `For` nests in `For`, `Show` nests in `Show`, a
  reconcile over the same array identity builds nothing, and remove-and-reorder in
  one pass places correctly.
- **What the sabotage pass found that the demo did not: the `untrack()` around
  `For`'s row builder is load bearing and nothing asked about it.** A row body that
  reads a signal **directly** rather than in an effect -- a theme, a terminal
  width, a date format -- is read while the reconcile's own effect is evaluating,
  so without the `untrack()` the whole list re-reconciles every time that signal
  moves. Measured on one row and one signal: two reconciles where there should be
  one, which at a hundred rows is a hundred-row walk for a value one row looked at.
  It has a test now, and so does its sibling in `Show` -- which this entry first
  claimed was **not** a guard, on the strength of a sabotage that survived. A
  review round refuted that, and it was right. Deleting `Show`'s `untrack()`
  subscribes `Show`'s own effect to whatever the builder read, so an unrelated
  signal change re-evaluates `when` -- and `when` is where **presence** comes from,
  which is the one answer a conditional must not take from somewhere else. What
  hid it is that the early return on an unchanged presence swallows the re-run, so
  nothing on screen moves for the obvious fixture and what has to be counted is
  the `when` evaluations. Both guards are pinned now, the second one named for the
  condition rather than for the picture.

  The lesson is the one this file already records twice and reached a third way: a
  **negative** claim about all inputs cannot be established by a sabotage that
  survived. "No test failed" is a statement about the tests. The honest move when
  one survives is the one the entry below takes -- name the input that would make
  the guard matter -- and here the first draft reasoned forward from the survival
  to a mechanism instead, which is exactly the error the `isFinite` entry under
  the animator is written down for.

- **And the demo guard that was wrong in four files, which is a recorded rule that
  was only ever fixed where it was found.** AGENTS.md already says a demo that
  reads keys needs a terminal on **both** sides, because `createInput()`
  refuses to exist unless stdin and the terminal's output are both terminals
  -- the entry is under "Asking the terminal what it is" in `src/terminal` and
  it was written when `01-capabilities.js` had exactly this bug. It was fixed
  there and nowhere else. Measured by spawning each demo with stdin faked as a
  TTY and stdout left a pipe, which is what `| cat` from a terminal is:
  `renderer/01-app.js`, `renderer/02-tasks.js`, `element/03-focus.js` and
  `style/03-animation.js` each drew part of a frame to the pipe and then
  exited **1** with an `InputError` stack over a minified module. All four
  guard both sides now. `demos.test.ts` cannot see it, for the reason that
  entry already gives -- it spawns with stdin `'ignore'`, so every demo takes
  the no-terminal branch -- and the half of this that is a finding rather than
  a fix is that `demos/README.md` was documenting the broken command.
- **And the focus test it found to be saying nothing, which is the discipline
  rather than an aside.** `should keep the focus on a row that moved` first
  asserted the focus and the ring straight after the reorder, and the guard it
  exists for -- `reconcileFocus()` leaving alone an element that _ended_ attached,
  since placing a row is `insertBefore`, which is a removal followed by an
  insertion -- is only consulted **when a key arrives**. So removing that guard
  left the test green: nothing had asked. One `input.feed('z')` after the move is
  the input that makes it matter, and with it the sabotage fails that test and no
  other in either file. The demo had been right about the behaviour all along,
  because `J J J` is three keys.
- **The five frictions, which are the honest answer to "where is it worst".**
  First and worst: **the wrapper tax is paid per use and cannot be inferred**.
  Both components return a `box` because there is no fragment, so every `Show` and
  every `For` must be told the layout the branch would have had -- and in a row
  containing a `Show` containing a `For` that is three wrappers and three `props`
  objects, each of which is silently wrong rather than loud if forgotten. This
  file already records that a `For` whose rows should stack writes
  `'flex-direction': 'column'` on the `For`; what using it adds is that the rule
  does not stay in your head at the third nesting level, and the failure is a
  layout that looks nearly right.

  It is **measured** rather than asserted, because the demo written to answer this
  question paid it wrong: a row's notes are a `Show` whose only child is a `For`,
  and `.notes` -- the class carrying the indent -- went on **both** wrappers, so
  every note was indented twice. Four columns became eight, nothing overflowed,
  nothing threw, and it read as a design choice until a review round counted the
  columns. That is the whole of the complaint in one artefact: the layout a branch
  would have had has to be restated at every level because there is no fragment,
  each restatement is a separate chance to say it twice or not at all, and neither
  mistake is loud. A fragment, or a `display: contents`-shaped box, is the one
  change to this API that would pay for itself; it would not remove the thunks or
  the accessor, which are the parts that are merely verbose rather than wrong.

  Second: **the concise effect body this file calls "the spelling worth
  encouraging" is a type error for most of the element API**, and the mechanism is
  worth writing down because it is not obvious. `createEffect`'s parameter is
  `() => void | Cleanup`, and TypeScript's rule that a function returning anything
  is assignable to a signature returning `void` applies to a bare `() => void` and
  **not** to a union with it -- so the union is what gives that leniency up. Every
  element setter returns `this` for chaining, so
  `createEffect(() => label.setText(x))` does not compile while
  `createEffect(() => a.set(b.get()))` does, and the runtime ignores a non-cleanup
  return either way. Deliberately left alone rather than fixed here: the workaround
  is a pair of braces, the failure is a compile error rather than a wrong answer on
  screen, and both ways to widen it cost something real --
  `(() => void) | (() => Cleanup)` would accept an `async` body, which the current
  type catches and the runtime can only throw about, and a conditional generic that
  keeps both is a signature nobody reading it would understand. Loud and
  inconvenient beats silent and wrong, which is the whole of why this is a note and
  `Show`'s value was a fix. It is invisible in the demos because they are `.js` and
  nothing type-checks them, while JSX is the canonical template syntax -- so an app
  meets it on its first effect and this repository never had to.

  Third: **whether `each` is reactive is invisible at the call site**, and the demo
  has one of each a hundred lines apart. `each: () => item.notes` over a plain
  array gives an effect with no dependencies, so it runs once and never again,
  while `each: visible` re-reconciles whenever the filter or the list moves -- and
  nothing in either spelling says which. Both are correct here, because the notes
  really are fixed; what the pair shows is that the distinction is carried entirely
  by what the thunk happens to read.

  Fourth: **a signal write does not rebuild the tree until a frame settles, so an
  app that wants to act on the new tree in the same handler has to force one.**
  Collapsing the demo's list with `Show` disposes every row, and the focus goes
  with them -- which the ring will not repair, correctly, because nothing focused is
  a legitimate state and the element it would repair _to_ is exactly what has gone.
  So the app puts the focus back itself, and the obvious spelling does not work:
  `listOpen.set(true)` followed by `input.focus.next()` focuses nothing, because
  `set()` only marks the branch stale and `focusables()` walks a tree that still has
  no rows in it. A `view.frame()` in between is the answer. Nothing here is wrong --
  it is the deferred frame this file argues for at length, met from the one
  direction that is not obvious -- and it cost the demo a dead `space` key until
  somebody pressed `n n space`.

  Fifth, and smallest: the focus ring is `input.focus.next()` rather than
  `input.next()`, and no demo called it before this one, so the first guess was
  wrong and the type error was the only thing that said so.

- **How strong this is.** It is a positive result from one app written by somebody
  who had read the renderer's source, which is the weaker of the two things the
  ticket asked for. What it does establish is narrower and still worth having: the
  control flow survives the compositions an app actually reaches for, the one
  place it did not was found within a day of somebody wanting something from it,
  and the frictions above are specific enough to act on. What it does not
  establish is that an author who had only the README could get there -- the
  README had nothing, and that is now the cheapest thing left to improve before
  SIG-31 asks the question properly.
