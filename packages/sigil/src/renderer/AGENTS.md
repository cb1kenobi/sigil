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
- **A root and a frame run untracked, because nothing in either is the caller's
  to depend on.** `runWithOwner()` puts the signals layer's _parentage_ aside and
  never put the _consumer_ aside, so `createRoot()` ran a body tracked by whatever
  effect was on the stack -- and `render()` is called from one whenever a
  built-in mounts lazily: a spinner's `start()` from an effect. `spinnerView()`
  reads its label to build the text node, so that effect became a sink of the
  spinner's own label and ran again on every later `s.text = ...`, which is
  SIG-321's 3 runs where 2 belong. A task log's title is the same spinner view.
  The frame is the second half: `render()` paints its first one before it
  returns, a component's methods call `frame()` from wherever they were called,
  and a frame reads frame handlers, the scope's own flush, measures and `onMount`
  callbacks, none of them the caller's. So `createRoot()` untracks and so does
  `runFrame()`, whole, each pinned under `a renderer started from an effect` in
  `test/renderer/renderer.test.ts`. The untracking stops at the root and the
  frame: `runWithOwner()` itself is public and still tracks, because
  `provideContext()` inside an effect body is a caller that may mean its reads to
  be tracked, and `For` and
  `Show` already say `untrack()` where they mean it. The inner effects were never
  parented to the caller -- `unowned()` saw to that -- and a test now says so:
  the renderer keeps its effects when the effect that started it runs again.
- **`onMount` fires after a frame, not at the end of the body.** The useful thing
  to do there is read what the component came out as, and `element.box` has no
  answer until something has laid it out -- so a callback that ran at the end of
  the body could only ever ask questions with no answers. It makes the promise
  the same for a component mounted by the first frame and one a `Show` revealed
  forty frames later. Under a bare `createRoot()` nothing drains the queue and
  the callback never fires, which is the honest answer rather than running it
  early against a tree that has no boxes.
- **...and it runs under the owner of the component that registered it, or not
  at all.** The queue used to hold the bare callback, and the frame that drains
  it runs with no owner -- so an effect created in an `onMount` belonged to
  nothing, outliving both the component's unmount and the renderer's
  `dispose()`, an `onCleanup()` there was dropped, and `useContext()` answered
  the default. Measured on the review's repro: the effect still ran, and still
  held its edge, after the renderer was gone. The callback is queued with the
  owner it was registered under and run through `runWithOwner()`, so it means
  what the body would have meant. The owner can be gone by the time the frame
  lands -- a `Show` that opened and closed again between two frames built a
  branch that was never drawn -- and then the callback is **skipped** rather
  than run against a disposed owner: the component was never on screen, it has
  no box to read, and every effect it tried to start would be refused anyway,
  while a cleanup would run on the spot. Not firing is the same honest answer the
  bare `createRoot()` case gives. See the three `onMount` tests under
  `lifecycle` in `test/renderer/renderer.test.ts`.
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
- **`For` moves only the rows off a longest run already in order, and reads each
  key's queue through a cursor (SIG-345).** Placement used to walk the target
  order and move every row not at its index, which is "out of place" by
  _position_ -- and by that measure taking the first row to the end puts every
  other row out of place, so it was n-1 `insertBefore` calls where one would do,
  each a removal and an insertion that both search the host's children: quadratic
  for a one-row move. `place()` reads where each kept row sits in the host now,
  takes a longest increasing run of those positions with `longestIncreasing()` in
  `src/util/`, leaves the rows on it alone and moves the rest from the end
  backwards, each in front of the row that follows it. That is the fewest moves
  there are, and it is what Solid and Inferno do. Positions come off the host
  rather than off the rows' previous indices, so what is placed against is what is
  on screen. The queue per key is unchanged and so is which copy a key hands out --
  the first one held -- but it is read through an index rather than `shift()`,
  which was O(k) for a key held k times. Measured on `box(text, text)` rows, median
  of seven, before and after (both timings on a loaded machine; the move counts
  are the point):

  | n      | first to end                  | swap ends                 | last to front         |
  | ------ | ----------------------------- | ------------------------- | --------------------- |
  | 1,000  | 999 moves, 1.27ms → 1, 1.24ms | 999, 0.95ms → 2, 0.54ms   | 1, 0.28ms → 1, 0.40ms |
  | 4,000  | 3,999, 6.37ms → 1, 1.77ms     | 3,999, 6.88ms → 2, 1.79ms | 1, 0.94ms → 1, 1.80ms |
  | 16,000 | 15,999, 857ms → 1, 12.8ms     | 15,999, 535ms → 2, 15.0ms | 1, 16.6ms → 1, 14.8ms |

  A list of one repeated primitive reconciled against itself went from 146ms,
  1,030ms and 3,054ms at 20,000, 40,000 and 80,000 to 22ms, 36ms and 43ms. What is
  still quadratic is a reorder that really does move most rows -- a reverse is n-1
  moves and must be -- because each `insertBefore` searches the children; that is
  the element API's cost and not this one's. The tests count `insertBefore` and
  never time anything: first to end, swap ends, last to front, a reverse, an
  insert, and a seeded shuffle whose bound is exact (n minus the longest run,
  computed the quadratic way). Run against the old placement, three of them fail
  -- 99 moves where 1 and 2 belong. The cursor's test pins what a cursor has to
  keep -- every copy kept, none built, moved or disposed, and a shrink letting go
  of the copies past the end -- and passes against `shift()` too, since what
  `shift()` cost was time rather than an answer.

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
  said so. `Element.onLayout` (SIG-221) is dispatched in the same loop, after
  `onResize`, and is what lets a tooltip follow a scrolled anchor in the frame
  that scrolled it -- `Renderer.onFrame()` cannot, since it fires before the
  layout and reads the boxes of the one before. It costs nothing on a frame of an app that has no `onResize`
  or `onLayout` handler anywhere in its tree, which is every app with no windowed
  list or shown tooltip in it: `arrange()` asks the question only of an element carrying the hook, so
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
- **`onDispose()` is for what the owner tree cannot reach, and it fires first.**
  SIG-219. What a component body creates already goes with its owner; what was
  handed the renderer from outside -- a toast raised in a key handler, a binding
  on a router the app goes on owning -- had nothing to tell it the screen was
  gone. The shape is `onFrame()`'s: one function per subscription, an
  unsubscribe back, dispatched over a copy with a membership check, a throw
  reported to `onError` without stopping the rest or the teardown. It fires at
  the top of `teardown()`, after `disposed` is set and **before** the owner tree
  and `backend.done()`, so a handler still has the whole tree to take its own
  part out of -- a modal puts the focus back on an element that is still mounted
  -- and `mounted` already reads `false`. It fires on the failure path too,
  since a failed renderer is just as gone; what a handler throws there is
  reported before the terminal is restored, which is where an owner cleanup's
  throw on that path was already reported, and is left alone with it.
- **A handler given to a renderer that has gone is called at once.** The other
  answer was a no-op, and it is the wrong one for every caller there is: a toast
  raised from a promise that settles after the renderer went would keep its
  timer, which is the leak this exists to close. It is `onCleanup()`'s rule for
  a disposed owner, and it also settles what a handler subscribed by another
  handler mid-dispatch gets -- `disposed` is already true, so it runs at once
  rather than joining a set the loop has copied. Its throw is reported rather
  than raised, so one rule covers a handler whenever it runs. So every caller
  subscribes **last**, after whatever the handler would undo exists. Who
  subscribes is the toast, the modal, the debug overlay and `enableSelection()`;
  the tooltip was checked and does not need to, which its entry says. Sabotage:
  eleven breaks across the seam and its four callers, all caught.
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
- **The restyler is on the handle for reading, and nobody calls `touchSheets()`
  from outside any more (SIG-307).** It was exposed because a stylesheet swapped at
  runtime had no other way to say that every rule is stale. The renderer now
  subscribes to the cascade with `cascade.onChange()` when it mounts and lets go
  in `teardown()`, and any `add()`, `remove()` or `replace()` marks everything
  stale and asks for a frame: a swap from a key handler is safe, and it arrives by
  the clock like any other change. A cascade shared by two renderers tells both.
  The animator is told in the frame, after the restyle, through a flag the
  listener sets -- see "Transitions and keyframe animations" in `src/style`.
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

### Running an app: `runApp()`

SIG-276. `src/renderer/app.ts`, published as `@ttylabs/sigil/app`. Every interactive
demo assembled the same seven steps by hand -- both ends a terminal, `createInput()`,
a cascade, a backend, `render()`, a quit key, and the teardown -- and Ink's whole
first page is `render(<App />)`. `runApp(component, opts)` is those steps once, and
returns an `App`: `exit(code = 0)`, `exited` (a `Promise<number>`), `input`, `view`,
`terminal`, `interactive` and `running`. `useApp()` and `AppContext` are how a component reaches
it.

- **A subpath of its own, which is the exception the root file asks to argue for
  itself, and the argument is the graph.** The runner is the one module that needs
  the renderer, the router and the framework sheet at once, and the renderer keeps
  the other two off its graph on purpose -- `renderer/index.ts` imports
  `capabilities.js` rather than the router for exactly this reason. Measured when
  the first review round's fixes landed: `renderer.mjs` was 160,695 B over 24
  modules and `app.mjs` 201,365 B over 26. The app graph added the router chunk
  (14,423 B), `theme.mjs` (23,669 B) and the runner itself (2,834 B), and it left
  out the 256 B `renderer.mjs` entry shim, because `app.mjs` imports the renderer
  chunk directly -- so 14,423 + 23,669 + 2,834 - 256 = 40,670, which is the
  difference. Folded into `renderer` that was about 25% more on every spinner and
  prompt; folded into `input` it is the whole renderer
  on a router; folded into `components` it is a 455 KB graph to start an app built
  from `box` and `text`. The source sits in `src/renderer/` and the entry points at
  it, which is the `coerce` and `routes` shape: a subpath named for what an app
  imports, a file kept beside the code it composes. `dist.test.ts` pins the split
  with a router string, a framework-sheet selector and the runner's own message,
  each absent from `renderer.mjs`'s graph and present in `app.mjs`'s, so neither half
  passes by a rename.
- **Full screen by default, inline with `fullscreen: false`.** An app owns the
  screen and gives it back exactly as it was, which is what the alternate buffer is;
  inline is for the tool that wants its last frame left in the log, and it follows
  its content's height the way a `render()` with no height does -- the renderer
  builds that backend itself, since an injected one is never auto-sized.
- **The router is built before the component, over a host box, so `useApp().input`
  exists in the body.** A router's `root` is fixed when it is built, and the
  component's own root does not exist until its body has run, so the runner builds a
  host first -- `box({ class: 'sigil-app', 'flex-direction': 'column' })` -- builds
  the router over it, and appends what the component returns. That is the whole
  reason for the host, and it is what lets a control take the focus ring at build
  time if SIG-278 settles that way. A column, so a root with no size of its own
  takes the whole width as a block would; `flex-grow: 1` on it fills the screen.
  And `.sigil-app > * { min-height: 0 }`, in a sheet of the runner's own between
  the theme and the app's sheets, so that it also _stays_ on the screen: the root
  is a flex item, a flex item's automatic minimum is its content, and a column root
  taller than the screen kept that height -- `flex-grow` can only grow it -- so its
  bottom rows were drawn nowhere. The system monitor found it with more cores than
  rows, and every app would have had to know to write the rule. A sheet rather than
  an inline style because an app sheet's own `min-height` on the root has to win,
  and the selectors tie, so the later sheet does. A `cascade` passed whole goes
  without it, which is what passing one whole means.
  `view` is the one thing a body cannot have, because the body is how the renderer
  gets its tree: reading it then throws, naming `onMount()`, rather than answering
  `undefined`.
- **The mouse surface is late-bound, because the router asks where the canvas is
  the moment it is built.** That is before `render()` has made the backend, so the
  first ask finds nothing and answers the way a terminal that said nothing does --
  the origin is unknown and the next report asks again -- and every read after that
  is the backend's own. The alternative was building the backend before `render()`,
  which an inline app cannot do without losing the auto height above.
- **The quit key is `isAbort()`, the first function binding, and 130 -- and it is
  not `q`.** Raw mode makes Ctrl-C a key rather than a signal, so something has to
  bind it, and binding it before the component runs puts it ahead of every binding
  the component makes and ahead of the tree -- a focused field or an open dialog
  cannot swallow it. 130 because that is what a shell reports for a program Ctrl-C
  interrupted, and raw mode is the only reason this was a key instead. `q` is not in
  the default for the same reason it works: a function binding sees every key, so a
  default `q` would be a letter no text field could type. `quit` takes a predicate,
  or `false` for an app that ends itself. **`q` is `quitKey`, a different option on a
  different layer** -- see the next entry.
- **`quitKey` is `q` by default, a fallback, and 0 (SIG-308).** The reason above
  for keeping `q` out of `quit` was that no layer existed that a text field
  outranked; `InputRouter.fallback()` is that layer, and the runner registers
  `quitKey` on it, described as `quit` -- through `__` and in lower case, as every description the framework lists is, and `'quit'` is already in `src/i18n/keys.ts` -- with a priority of 9 so a narrow key-help
  footer drops anything else first. So a field that takes `q` keeps it and every
  other focus, nothing focused included, quits on it. It ends the app with `0`
  rather than 130 because a `q` is the app choosing to go and not an interrupt.
  `quit` is unchanged: it is checked
  first, still 130, and a `quit` predicate that claims `q` wins (`should take a quit
  key of the caller choosing` is still true). `quitKey: false` registers nothing
  and frees the key; the option is one key, so a spec of two throws as `fallback()`
  does.

  Registered **inside the render callback, after the component's body**, for two
  reasons that decide against the obvious place beside the router. A key-help
  footer reads the fallbacks in registration order, and quit goes last where an
  app puts it (the system monitor's footer is `... t theme · q quit`). And a spec
  that cannot be a key throws there exactly as a body that throws does: `render()`
  has given the screen back and the catch under it stops the router and settles
  `exited` with 1, where a throw beside the router would have needed a copy of that
  teardown. Pinned by `should refuse a quitKey of two keys, with the terminal given
  back`.

  **It changes what an existing app does, and every caller was read for it.** An
  app that bound `q` itself -- `bind('q', ...)`, or a function binding -- gets the
  key first and nothing moves: `demos/renderer/01-app.js`, `demos/element/06-panes.js`
  and `examples/hello` all do and are left as they are, their binding now
  redundant and harmless. An app whose elements take `q` as a character keeps it. An
  app whose `q` meant something else and is not stopped anywhere would now quit; none
  in the repository does, and `quitKey: false` is the opt-out. A prompt run over the
  app's router swallows every key while it is up (its binding stops the event first),
  so `q` typed into a prompt does not reach the fallback.

- **`exited` is an exit code -- Chris's decision, and the reason is the design
  rather than the type.** `exit(code = 0)` settles it with `code`; the quit key with
  130; a failure that ended the app with 1, after `onError` has written it; the
  refusal below with 1; a throw from the component's body with 1, though it also
  propagates; stdin ending with 129, 128 plus `SIGHUP`, since a terminal that went
  away is a hang-up, or 1 if it ended in an error, which is reported through
  `onError` like every other failure; and `view.dispose()` from the app's own code
  with 0. There is no generic value. Passing return values up
  through layers of commands and contexts is the Vercel CLI's mistake -- every layer
  coupled to the shape of the one below -- and `process.exitCode` is global state, so
  `runApp()` does neither: it touches neither `process.exitCode` nor `process.exit()`
  and resolves the code. Making it the process's is the app's one line,
  `process.exitCode = await runApp(App).exited`, and inside a command's `run()` the
  same line with nothing returned, for the reason the parser's output-formats entry
  gives: what `run()` returns is the command's answer and is serialized under
  `--format`. **The cost is real and is stated rather than hidden: an author who
  ignores the resolved code exits 0**, after a Ctrl-C or a failure as much as after
  a clean exit. An app that wants a stateful `App` class with an `exitCode` property
  builds one on top. It never rejects, for `main()`'s reason: what awaits this is a
  bin script, and an unhandled rejection dumping a stack over a terminal just given
  back is the wrong default.
- **A failure goes to `onError`, whose default writes one line through the backend
  and sets no exit code.** `renderError()` rather than `errorHandler()`, because the
  latter also writes `process.exitCode`, which is the global this module leaves
  alone -- the 1 is `exited`'s to carry. Through the backend rather than to stderr,
  which is the one way it differs from `render()`'s default: a full-screen backend
  holds a line written while it owns the screen and writes it once the main screen is
  back, so an `onMount` or a frame handler that threw is read afterwards instead of
  drawn into a frame. A failed frame has stopped the backend before it is reported,
  and a stopped backend writes straight through. What is reported while `render()`
  is still running waits in a queue and goes through the backend once there is one,
  because the first frame is painted inside `render()`. Whether a failure ended the
  app is **asked** of the renderer, through `Renderer.failed`, rather than inferred
  from its reports. The first answer inferred it -- a report arriving while the
  renderer was unmounted was the failure -- and that cannot tell a failed frame from
  a cleanup that threw during an unmount somebody chose: both reach `onError` from
  an unmounted renderer, in the same order, through the same teardown. A flag the
  runner set around its own `dispose()` covered `exit()` and missed a
  `view.dispose()` the app called, which settled 1 for the app ending itself the
  moment a cleanup threw. Only the renderer knows which of `fail()` and `dispose()`
  tore it down, so it says: `failed` is set before `fail()`'s teardown starts, so an
  `onDispose()` handler can already read it, and stays `false` for a `dispose()`.
- **Every route out ends the app the same way, each with its code.** `exit()`, the
  quit key, stdin ending, `view.dispose()` and a failed frame -- the last two through
  `Renderer.onDispose()`, which fires on both. A throw from the component's body
  propagates from `runApp()` with the router stopped and the terminal back, which is
  `render()`'s rule: there is a caller on the stack, and inside a command's `run()`
  that caller is `main()`, which renders it and sets the code itself. It **also**
  settles `exited` with 1, because `useApp()` hands the body the handle, and a
  caller that catches the throw and awaits it waited forever -- `finish()` returns
  early once `running` is false, so no later `exit()` could settle it either. A
  sheet or a theme that fails to parse throws the same way, and it is parsed
  **before** the full-screen canvas is built: that canvas subscribes to resizes the
  moment it exists and only its `stop()` lets go, so building it first left a
  listener on stdout holding the canvas for the life of the process, one per
  caught retry. Stdin ending in an error is reported through `onError`, held by
  the backend and written once the screen is back, rather than leaving a 1 with no
  line beside it -- and it is flagged as the failure, so it beats a code `exit()`
  already latched, which its own `exit(1)` could not do as the second call. That
  includes an error whose **event** was still on its way: `destroy(err)` sets
  `errored` at once and emits on `nextTick`, so an `exit(0)` and a destroy in one
  turn had the teardown's microtask take the router's listener off first, and the
  emit then found nobody -- an uncaught exception, crashing a CLI after the screen
  was back, on the way out of a quit it handled. The router owns that guard, under
  "A router stopped over a failed stream" in `src/input`: it tells `onEnd()` from
  inside `stop()`, which `finish()` calls before it reads the code, so the error is
  reported once and the code is 1 whichever of the two orderings it arrived in --
  and only to the app whose router was listening when stdin failed: the next app
  over the same dead stdin chooses its own code. A
  signal is the terminal's own restore handlers, as it always
  was; the runner adds none.
- **The teardown is the renderer, the router, then `restore()`.** The router is the
  half `restore()` cannot do -- raw mode comes back through either, but a `data`
  listener left on stdin holds the process open after the last frame -- and
  `restore()` is the guarantee: a cursor the app hid itself is one no backend owes
  back. The first two are in the reverse of the order they went up, and that is
  tidiness rather than a dependency; the opposite order changed nothing observable.
  **Each step runs whatever the one before threw, and `exited` settles whatever any
  of them threw.** `running` is already false by then, so nothing else could settle
  it, and the router's `stop()` calls `onEnd()` handlers the app registered: one
  that threw used to skip `restore()` and leave `exited` pending forever. What a
  step threw is reported after every step has run, so it reaches a screen that is
  back -- each error once, as itself, with an `AggregateError` from several
  `onEnd()` handlers opened up, because the default writer's line for an aggregate
  is its own message and says that handlers threw rather than what -- and it does
  not change the code -- a teardown that throws is the cleanup
  rule's case, not a failure that ended the app. The settle comes before those
  reports rather than after, which nobody awaiting it can tell apart, since a
  continuation runs on a later microtask; and it leaves an `onError` that throws
  with nothing to stop the settle.
- **`exit()` runs the teardown on a microtask, and the first code wins.** Called
  from the component's body, a synchronous teardown ran before `render()` had
  finished, so the app reported itself gone while `render()` went on to mount, enter
  the alternate screen and paint. A microtask lands after `runApp()` has returned
  whichever context it is called from. A second call does nothing, so a quit key and
  a button arriving together settle `exited` once, with the first. **A failure
  beats an intentional code, though**, and the deferral is why that has to be said:
  an `exit(0)` from the body leaves the first frame to run, and that frame can
  fail, which `fail()` reports and `onDispose()` answers with an `exit()` the first
  call's guard swallowed -- so a crash settled 0, after printing the crash. The
  code is therefore read in `finish()`, as the failure's if one ended the app and
  the latched one otherwise. A cleanup that throws during an **intentional**
  unmount is reported and does not count, since the app was already going by an
  `exit()` that chose its code -- Chris's decision, taken over letting a teardown
  failure beat the code too. Intentional means `exit()`'s teardown and a
  `view.dispose()` the app's own code called, which is the same decision reached by
  another door: both settle with the code that was chosen, 0 for the dispose, and
  `Renderer.failed` above is what makes the rule hold for both. A cleanup that
  throws while a failed frame tears down is part of that failure, which settles 1
  either way.
- **No terminal on both ends is a refusal -- Chris's decision.** Where stdin or the
  output is not a terminal, inline as well as full screen, `runApp()` builds no
  router and no renderer, never calls the component, draws nothing, writes one line
  to stderr through `onError` and settles `exited` with 1 at once. A single frame of
  a full-screen app in a pipe is not useful output, and a refusal a script can detect
  is. A terminal handed in is asked the same question, which is how a test runs one:
  `createTestTerminal()` claims to be a terminal on both streams, and one built with
  `inputTTY: false` or `isTTY: false` is refused like a pipe. The provisional first
  answer -- one inline frame and exit 0 -- is gone with its tests. The two demos on
  the runner exit 1 with that line when piped, and `demos.test.ts` lists them beside
  `04-prompts.js`, which is the same rule for a prompt.
- **`detect` is on by default here and nowhere else.** The rule against probing is a
  CLI paying a round trip to print one line; an app is the long-lived interactive
  program that rule was never about, and the first frame does not wait for the
  answer. **It is not asked of an app already going.** `exit()` from the body, or
  from an effect or an `onMount` of the first frame -- which `render()` also runs --
  leaves the teardown a microtask away, and the renderer's own guard against
  probing a renderer that has gone reads `disposed`, which is not set yet. The probe
  writes XTVERSION and DA1 the moment it is asked, so the terminal answered onto a
  stdin the router stopped reading a microtask later, and the reply landed in the
  shell. A quit while a probe of an app that stayed up is still in flight -- a
  window as long as the terminal takes to answer, a few milliseconds -- is the same
  reply arriving late, and is left: the queries are already written,
  and nothing short of holding the teardown for the deadline would take them back.
- **One hook, `useApp()`, and it throws outside an app.** `useInput()` would be a
  second context for a field of the first. Throwing rather than answering
  `undefined` is because a hook every caller has to guard is a hook nobody guards;
  a component that works with or without an app reads `useContext(AppContext)`.
- **`app.cascade` and `app.setTheme()` (SIG-307).** The runner builds the cascade
  before the component runs, so `app.cascade` -- also through `useApp()` -- is there
  in the body, unlike `view`; it is the one passed as `cascade` where there is one.
  Changing it restyles the app on its own. `setTheme(theme)` takes a `Stylesheet`,
  source text or `undefined`, replaces the theme sheet the runner put in the
  cascade in place (adding one where there was none, removing it for `undefined`),
  and throws before swapping if the source does not parse. It **throws where the
  app was given its own `cascade`**, saying to use `cascade.replace()`, because the
  runner cannot know which sheet of a cascade it did not build is the theme. A
  refused app has neither, and both throw naming the refusal as `view` does --
  before the `cascade` option is looked at, because a refused app has no cascade
  whatever it was given. The
  theme sheet is parsed in `runApp()` and handed to `themedCascade()` as a sheet,
  because a cascade finds a sheet by identity and the one `themedCascade()` parsed
  for itself would not be findable. `src/theme`'s "Switching a theme at runtime"
  has the semantics, including that a sheet not at origin `theme` is refused; the
  system monitor's `t` is `app.setTheme()` and no longer
  scopes its themes under a class on the host.
- **Resize is not something the runner owns.** The renderer re-matches and re-lays
  out on a resize already, and the full-screen backend follows the screen by
  itself, so there is nothing to wire.
- **The debug overlay is one line on top rather than an option.**
  `enableDebugOverlay(app.view, { input: app.input, log: app.logs })`. An option would put the
  overlay's scroll box and log ring on every app's graph for an instrument most
  never open, or make the option an `await import()` whose handle arrives late.
- **The console is captured while the app runs, and replayed only when the app
  fails (SIG-310).** A `console.log()` from the app or a library it calls wrote
  straight into the alternate screen, and the next frame's diff does not know
  those cells changed, so the line stayed as garbage until something repainted
  over it. `runApp()` now calls `captureConsole()` into a ring it owns, 1,000
  lines, before the component's body runs, and exposes it as `app.logs` (on
  `useApp()` too). Nothing reaches the screen while the app runs. `console:
  false` turns it off; so does a capture the app installed itself before
  `runApp()`, which the module-level latch refuses -- the runner **leaves that
  one alone** and `app.logs` is `undefined`, because the patch is global and one
  of the two has to own it. Nothing is patched for a refusal either: an app that
  never draws has nothing to protect.

  _Full screen replays on failure and discards on success._ A failure writes the
  ring to the main screen once it is back: in order, `log`, `info`, `debug`, `dir`
  and `dirxml` to stdout and `warn` and `error` to stderr, as `console` would have
  printed them, with **no level prefix** and before the error report. If the ring
  dropped lines, a stderr note first says how many
  (`5 earlier console lines were dropped (the last 1000 follow)`). **Code `0`
  discards the ring** -- the lines were the app's own scrollback and nothing needs
  explaining. **So does 130, and that was a decision revised in review.** It first
  replayed, on the reading that 130 is what a shell reports for a program somebody
  had to interrupt. The user's decision is the other one: Ctrl-C is the habitual
  way out of a healthy interactive app, so replaying on it would put an app's
  chatter on the screen every time it was quit, and an app that has hung never
  reaches its quit binding in the first place, so 130 is not the code a hang
  produces. Every other non-zero code replays, 129 (the terminal hung up) included,
  to a screen that may not be there. An app's own `exit(130)` is the same number
  and discards too. What counts is the code `exited` settles with, read in
  `finish()` after a failure has been given its say (`replayable()`).

  _What "a crash" covers._ A throw from the component's body (the catch in
  `runApp()`), a failed frame, and **the process ending under a running app**: an
  uncaught throw, an unhandled rejection, a `process.exit(n)`. The last is one
  `exit` listener on the real `process`, attached with the capture and removed by
  `finish()` and the body-throw path, which calls `terminal.restore()` (idempotent,
  so the screen is back whichever handler ran first), puts the console back and
  replays by the process's own exit code. Putting the console back is the part that
  was a defect and not a gap: an `exit` handler of the app's own that logged wrote
  into a ring nobody would read. It is a listener of the runner's rather than a hook
  on `Terminal` because the terminal's restore path is shared by every caller and
  runs on `restore()` called by `fail()` in the middle of a failure, where a replay
  would be early. **A signal is not covered, and the docs say so:** the terminal
  restores on `SIGTERM`, `SIGHUP` and `SIGINT` and re-raises, and the process dies
  by the signal without an `exit` event, so there is no point at which to replay;
  adding a signal listener of the runner's own would change whether the signal
  still kills the process, which is the terminal's entry to settle. The test is a
  spawned child over the built runner, for the reason the TypeScript routes are.

  _Three edges of the `exit` handler, found by the second review round._ **It is
  prepended** (`process.prependListener`), because listeners run in registration
  order and a handler the app registered before `runApp()` would otherwise log
  into the ring this is about to discard, or have its line replayed as ring
  content. **It writes synchronously**, through the stream's file descriptor
  (`writeAll()`, `EAGAIN` retried for up to five seconds, any other error ending the
  write quietly): an `exit` handler runs with no event loop to finish a write that
  could not complete at once, so a replay into a pipe whose reader was behind was
  cut off at exactly the pipe's 65,536 bytes. The terminal has no synchronous write
  of its own to reuse -- its exit restore is a few bytes through `stream.write()` --
  so this is the only one; a stream with no descriptor (a test terminal's) is
  written the ordinary way. The test uses a shell pipe and not a spawned child's
  `stdio: 'pipe'`, which is a socket pair and delivered the whole replay with the
  loss still in place. **And it writes `early`** after the reports, the order the
  body-throw path uses. The probe that was reported for this one (`mount A broke`
  lost beside a `process.exit()` in a second `onMount`) does not reach it: mount
  errors are collected and reported after the whole batch has run, so that report
  was never made. What does reach `early` is a line an inline app logged while
  building, which is what the test pins.

  _The lines go ahead of the error report, which took three moves._ A failed frame
  is reported by `fail()` after it has stopped the backend, and that happens
  **before** the teardown microtask `finish()` runs on. The first answer settled the
  failure inside an `onDispose()` handler, which does run inside `fail()` before
  the backend stops -- and review found what that costs: the dispose handlers run
  **before** `disposeOwner()` runs the cleanups, so the ring was written before a
  cleanup that logged, then `fail()` reported, then `finish()` wrote that tail
  after the report. The second answer is the one that holds: with the default
  reporter the report is **held in `reports`** like every other, so `fail()` stores
  it, and `finish()` writes the lines, the cleanups' among them, and then the
  report. The `onDispose()` settle survives for a custom `onError` only, because
  such a handler writes wherever it likes the moment it is called and the only way
  to put the lines ahead of it is to write them first; a cleanup that logs during
  that teardown lands in the tail after it, which is the best a handler the runner
  cannot hold allows. A first frame that failed inside `render()` has already gone
  when the handler is registered, and its report is held by then, so the lines go
  first there too. Every other route (`exit(n)`, stdin ending) settles in
  `finish()`, once the screen is back and the writes can go straight out. And
  **reports made while the app is up wait in the runner** rather than in the
  backend's held buffer: a report held there is older than the lines the ring
  replays, so the mount error that was thrown early would have printed _above_ the
  lines logged after it. A clean exit writes them with no lines.

  _What a custom `onError` logs through `console` is a report, not a log line._
  The capture took it into the ring, which a clean exit discards -- an
  `onError: (e) => console.error(...)` and an `onMount` that threw made the error
  vanish on `exit(0)` -- and a handler called while the app was up would have been
  writing into a ring rather than the screen. A counter around the custom call
  (`reporting`) makes the ring's `onPush` treat a line pushed inside it as a report:
  held with the others, written after the replay on **any** code, and remembered in
  `diverted` so a failed exit does not replay it a second time. It stays in the
  ring, so `app.logs` and the overlay still show it. It never reaches the alternate
  screen: nothing the handler logs does.

  _The console goes back after the teardown, not before._ A cleanup that logs
  while the tree unmounts is captured like everything else, and a second pass of
  the replay writes that tail (only the entries past the last written one, with no
  second note). It is put back on every way out: `finish()`, a body that throws,
  and the refusal never takes it.

  _Inline writes each line as it arrives and holds nothing._ "Inline" is
  `fullscreen: false`, whatever backend was injected, because it is the option
  that says there is an "above". Each entry goes through `backend.write()` --
  clear the region, write above it, repaint -- to stderr for `warn` and `error`.
  The ring is still kept, so `app.logs` is there and the overlay can show it; it
  is the ring's `onPush` that does the echo, a hook added to `createLogRing()`
  for this because a wrapper around `push()` would have to split a write into
  lines the way the ring does and say it twice -- and the same hook is how a custom
  `onError`'s output is told from the app's. A line logged during the first
  frame, before the backend is returned, waits in the same queue the early
  reports do. Nothing is replayed on failure: it is all out already.

  _The ring and the patch moved to `src/components/console-capture.ts`._
  `debug-overlay.ts` is a scroll box, a pane and a stats line, and the recorded
  reason the overlay is not an option on `runApp()` is that an app which never
  opens it must not carry it -- which the runner now needs the ring and the patch
  of. So those two live in a module that imports nothing of the renderer, the
  element tree or the sheet, and the overlay re-exports them: the surface of
  `@ttylabs/sigil/components` is unchanged. The cost to `app.mjs` was one 1,351 B
  chunk (the whole graph reads 209,538 B over 29 modules as of this change), and
  `dist.test.ts` pins that the pane's strings stay off it. Overlay and runner are
  paired by the app, as the overlay's entry records: `log: app.logs`.

  _Out of scope, and said so in the README._ A bare `process.stdout.write()` and a
  child process's stderr are not the console and still write into the screen.
  `trace` is not patched and is captured anyway, which this entry first had wrong:
  Node builds the stack and hands it to `this.error()`, so it arrives as `error`
  lines, one per frame; `table`, `group`, `time`, `count` and `assert` end in `log`
  or `warn` the same way. `dir()` and `dirxml()` are the two that do not, and
  wrote into the alternate screen past the patch -- found by review, which put
  `process.stdout.write` under a spy and called each method. They are patched now,
  as `log`, with `inspect()` and `customInspect: false` and the caller's options
  the way Node does it, without the colour its stream would have chosen.
  **Overlapping apps:** the capture is one global latch, so an app that starts
  while another holds it gets `logs === undefined`, is not captured, and once the
  first exits its lines reach its own screen. That is the rule for a capture the
  app installed itself, applied to the second runner, and not an error. A live log file to
  `tail -f` from another terminal is a follow-up.

  _Sabotage, fourteen by hand over `app-console.test.ts`:_ the console not put
  back, replaying on a clean exit, no settle in the `onDispose()` handler, reports
  not held, everything to stdout, no dropped note, no inline echo, `console:
  false` ignored, no `written` cursor, no replay on a body that throws, a 500-line
  ring, 130 treated as clean, and inline replaying. Thirteen were caught; the
  fourteenth, a separate `settleFailure()` for the first-frame case, changed no
  answer and was deleted.

  _Sabotage, round two, nine over the review's fixes:_ the `onDispose()` settle for
  the default reporter again, the divert off, the diverted lines replayed twice,
  `dir`/`dirxml` unpatched, `dir` not through `inspect()`, 130 replayed, no `exit`
  listener, the `exit` handler not putting the console back, and the `exit` handler
  replaying on any code. All nine were caught.

  _Sabotage, round three, four over the exit-path fixes:_ no `early` flush,
  `on` instead of `prependListener`, the write through `stream.write()` again, and
  `writeAll()` giving up on `EAGAIN`. All four were caught.

- **Sabotage, in two passes.** The first was twenty-three, with nine survivors: six
  were made to fail by a new test -- the router left listening (twice: on exit and
  on a body that throws), `restore()` dropped, a synchronous `exit()`, an error
  written straight to the terminal while mounted, and `paste: false` ignored -- and
  two were deleted: a `view.frame()` after a non-interactive `render()`, which had
  already painted, and a `running` guard on a probe's rejection, which a stopped
  router cannot produce. The second, after the exit codes and the refusal, was
  thirty-four: fifteen new and nineteen of the first re-run against the new code.
  Thirty-two were caught. One survivor was dead code and is gone -- a `!exiting`
  clause on the failure flag, which `exit()`'s own guard already made irrelevant --
  and the other is the teardown order, declared above. The third, for the first
  review round's four defects, was seven, every one caught: settling the latched
  code over a failure, dropping the unmount guard on the failure flag, the body
  throw left unsettled or settled with the latched code, the canvas built before
  the cascade, and the stdin error dropped or written straight to the terminal.
  Two lines that survived were deleted as unreachable: flagging a stdin error as the
  failure, and resetting the unmount guard after the one teardown there is. **The
  first was wrong to delete**, and the second review round found it: the reasoning
  was that the flag only mattered with an `exit()` latched and its teardown not yet
  run, a microtask an event cannot get in front of. An event emitted synchronously
  in the same turn as the `exit()` does get in front of it -- and one that cannot,
  `destroy(err)`'s `nextTick`, was not harmless but uncaught. A sabotage that
  survives is evidence that no test reaches the line, which is a claim about the
  tests before it is one about the code; the flag is back, with both orderings
  pinned. Stopping a runner-built backend
  in the body-throw path, on top of the reordering, was considered and left out
  for the same reason: reading `render()` from its first line to its `try` around
  the component found nothing that throws once the canvas is built. The fourth, for
  the second round's three, was eight, with one survivor: the router's guard also
  taking itself off on `'close'`, which nothing reaches because a guard is only left
  for an error not yet heard, and that error is emitted exactly once -- so it is
  gone. Caught: the stdin error not flagged, the router not delivering the pending
  error, no guard (an uncaught exception, as well as two failures), the router
  delivering an error it already heard, `failed` reading true after any dispose,
  `finish()` ignoring `view.failed`, and a probe for an app already going. **That
  pass missed the routers that come after**, and the third review round found it:
  every test of the guard used the one router that had been listening, so nothing
  asked what a later router over the same stream did with the `errored` left on
  it. The fifth, for the third round's three, was six, every one caught: claiming
  an error the stream carried at attach, a guard per router, `onEnd()` dispatch
  without a `try`, dispatch that swallowed instead of rethrowing, `finish()` steps
  not isolated, and `finish()` dropping what a step threw. One line was deleted
  before the pass rather than by it: taking a stream back out of the guarded set,
  which a stream destroyed once can never need. The sixth, for the fourth round's
  two -- an app started between a stdin `destroy(err)` and its emit crashed on the
  way out, and a different `'error'` spent the guard -- was eight, every one caught,
  under "A router stopped over a failed stream" in `src/input`; the attach tick
  survived the first run of it and is pinned by a test of its own.
- **Not done:** an `App` handle to a router the caller built, since the host is
  what makes the router exist at build time. Capturing `console.log()` while the
  app owns the screen was on this list until SIG-310 -- see the entry above.
