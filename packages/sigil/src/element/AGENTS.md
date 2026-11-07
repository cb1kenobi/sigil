# `packages/sigil/src/element` — deliberate decisions

These are the entries from [../../../../AGENTS.md](../../../../AGENTS.md) that are about this directory. Claude Code loads this file when it
works with files here; other agents should read it before changing
anything in this area. The root `AGENTS.md` holds the rules that apply
everywhere and still applies in full.

How each of these was arrived at — the review rounds and sabotage
passes — is under [docs/history/](../../../../docs/history), linked from
the entry it belongs to.

## Deliberate decisions — do not "fix" these

### The element tree

- **Three host types, and the third one is a trapdoor.** `box` lays its children
  out, `text` measures a string, and `raw` paints its own cells. Everything else
  is a component that resolves to these, which is what keeps the layout engine
  small and matches what a terminal can draw. `raw` is designed in rather than
  discovered: a sparkline or an image is a thing the layout engine cannot
  express, and the alternative to a node type for it is somebody reaching for the
  canvas behind the tree's back, after which the tree is wrong about what is on
  screen. It measures like a text and is placed like one; what goes inside the
  box it got is its own business.
- **No fragment: a component produces exactly one node.** A transparent node
  would have to be transparent to layout, to `:nth-child()`, and to paint order,
  which is three different definitions of "not there" -- and the third one is
  found to be wrong months later. The cost is a wrapper box where a list of
  siblings would do, which is a real cost in a flexbox world and is still the
  smaller one. The renderer may add it knowing what it is buying.
- **`key` is carried and read by nobody here.** A keyed list diff needs stable
  identity across renders, and matching on it is the renderer's; retrofitting a
  key into a shipped tree is worse than carrying an unused prop, which is the
  whole of why it exists before anything reads it.
- **The tree records what changed; what that implies is the `Restyler`'s.**
  `Marks` is exactly the four questions the invalidator asks -- props, classes,
  children, sheets -- plus the layout and paint ones, and nothing else. Keeping
  the two apart is what lets either be tested without the other, and it is why a
  mutation is a set membership rather than a call into the cascade.
- **An element carries the colour depth its style was resolved at, for a `raw`
  that paints colours of its own (SIG-326).** Degradation is at resolve time, so
  every colour a sheet or a prop names is one the destination can emit before
  paint reads it -- and a `raw` is the one thing that paints colours nobody
  declared, worked out from the box layout gave it, which an image is thousands
  of. `settleStyles()` writes `Element.colorLevel` beside `style` from the
  `CascadeResult` the restyler kept, which is where the cascade already put the
  depth, so the two are one answer and cannot describe different frames. The
  alternative was the `opts.colorLevel ?? ansi.level` every string facade takes,
  and inside a running app that is a second answer: the renderer refines its
  level from what the terminal replied, and a picture drawn at the environment's
  guess beside a frame drawn at the terminal's is truecolor on a 256-colour
  screen. A field rather than a fourth `RawPaint` argument because the walk that
  calls `rawPaint` does not have the depth -- `renderToString()` has put its
  borrowed media context back by the time it paints -- while the element does,
  from the walk that resolved it. Truecolor until something resolves it, which is
  what an unresolved tree's initial style already means.
- **A subtree not in a tree records nothing.** A page built up before it is
  attached has nothing on screen to invalidate, and marking every `append()`
  would hand the first frame a set naming every element in it. Joining a tree
  carries membership down the whole subtree, so the first mutation after that is
  recorded.
- **`take()` drains rather than the caller clearing.** A mutation made _while_ a
  frame is settling lands in the next set rather than in the one being walked,
  which is the difference between a change arriving a frame late and a change
  being dropped.
- **A text is wrapped once, and paint reads the lines rather than making them
  again.** The cache used to hold the height a text came to and throw away the
  lines it came to -- which is the one thing paint needs, so paint wrapped the
  string a second time at the same width. Half of all the grapheme segmentation
  a help screen did was one of the two passes tokenizing what the other had just
  tokenized. `WrappedText` holds the lines, each line's width and the
  measurement together, because they are one answer to one question, and
  `wrapped()` is public for the same reason `displayText` is: paint lives in
  another module and asking here is what makes the answer one answer.
- **A `nowrap` or `pre` text is cached under one key rather than one per width.**
  It is one line per newline whatever room it was offered, so a key per width was many
  entries holding the same answer -- and worse, layout and paint asking about
  different widths each missed the other's, so a table, whose cells are all
  `nowrap`, paid for the wrap twice over and got slower when the lines were
  first cached. The longest word is worked out only where it can be used, since
  a `nowrap` text cannot be squeezed to it and scanning for it was an answer
  thrown away. `pre` joined it in SIG-207, when it stopped being `normal` under
  another name -- its answer does not depend on the width either, and keying it
  per width would have reopened the miss for every chart, rule and paginator.
- **A text's measurement is cached per width and keyed on the resolved style
  _object_.** The cascade hands back a new `Style` when anything about it changed
  and the same one when nothing did, so comparing the reference answers "does
  this measurement still hold" exactly -- with no list of layout-affecting
  properties to keep in agreement with `LAYOUT_PROPERTIES`. A list would be a
  second copy of that set, and the day they disagree is the day a text is drawn
  at a width it was not measured at.
- **`text-transform` is applied before the measure, not at paint time.**
  `uppercase` is what makes a line wider, which is the reason `LAYOUT_PROPERTIES`
  carries it at all -- so `displayText` is what both the measure and the paint
  read, and they cannot come to disagree about what the string is.
- **A control character is decided here, because the grid only refuses one.** The
  cell grid throws on one rather than dropping it, deliberately: a row is painted
  one call at a time, and a newline that took no cell painted a whole paragraph
  onto one line. That rule is the grid's and it is right; what it needs above it
  is somebody to say what a control character _means_, and that is `displayText`,
  for the same reason `text-transform` is applied there. A tab becomes a space,
  since the grid models no tab stops and a tab that measured one width and
  painted another takes a column off every cell to its right; a newline stays,
  since it is what a line is split on; everything else goes, since there is
  nothing for it to draw. Found as a `RangeError` out of `table()`, where
  `padCell()` had been ordinary string work -- which is also why
  `toDisplayText()` is exported: anything sizing a column has to measure what
  will be _drawn_, and a table that measured the raw string was a column out per
  tab.
- **A `nowrap` text's minimum is its widest line, not its whole string.**
  `stringWidth()` reads a newline as nothing, so a label broken over two lines
  reported the two added together as the narrowest it could be -- and a row beside
  a description placed it twice as wide as it draws, with everything after it
  pushed along. The width was already the widest line; only the minimum
  disagreed.
- **`white-space` is three values, only `normal` wraps, and `pre` and `nowrap`
  are the same answer here.** `Text.#wrap()` is the one place a text reads the
  property, and it asked `whiteSpace === 'nowrap'` -- so `pre` went through
  `wrap()` with `normal`, broke at the box's width and dropped the spaces at a line
  end, and a `'│   '` beside an `x` rendered `│x` (SIG-207). What each value means
  now, and where it departs from CSS:

  | value    | wraps at the box | a space at a line end | a run of spaces | a `\n` |
  | -------- | ---------------- | --------------------- | --------------- | ------ |
  | `normal` | yes              | dropped               | kept            | breaks |
  | `pre`    | no               | kept                  | kept            | breaks |
  | `nowrap` | no               | kept                  | kept            | breaks |

  `pre` is CSS's `pre`, exactly: every space kept, a break only at a newline. A
  line wider than its box is not wrapped and is cut by `text-overflow` where the
  box clips it, which is what not wrapping costs in CSS too.

  `nowrap` departs from CSS and is **left that way on purpose.** CSS's `nowrap`
  collapses a run of spaces to one, drops them at a line end, and reads a newline
  as a space; here it keeps all three, which is what made it the value everything
  that needed a space to survive reached for while `pre` did not work. Every table
  cell, the tree's guides, the prompts' `before`/`caret`/`after` halves, the
  badge's padding and the key-help footer are `nowrap` and rely on it keeping
  spaces, and the collapse would move all of them to buy fidelity to a name. So
  the two differ only in what the author meant: `pre` says the spaces are content,
  `nowrap` says the line must not break. Neither is to be "fixed" toward the
  other, and a built-in already written with one is not to be moved to the other
  for its own sake -- the tree's entry records why it is `nowrap`, and that reason
  did not become wrong.

  `normal` departs from CSS the other way, also on purpose: it is `wrap()`'s rule,
  which keeps leading indentation and interior runs where CSS collapses both, so a
  command inside a note keeps its indent. The one CSS rule it does keep is the
  one with consequences: the whitespace at a line end goes, so a text of nothing
  but spaces measures **zero**. The choice list's pointer column, the palette's
  pointer, the toggle's refused blank names and the typewriter's visible cursor
  are each written around that, and it stays -- a `normal` text that held its
  trailing spaces would be a text that cannot be wrapped without leaving a
  column of them down the right edge.

  The four built-ins that already wrote `pre` -- `chart.ts`, `paginator.ts`,
  `rule.ts` and `calendar.ts` -- were checked by rendering each before and after
  at colour levels 0 and 3, and every byte is the same: each also declares a
  `width` equal to what it draws, which was the half doing the work while `pre`
  was not, and is what `pre` now measures anyway. Their widths stay.

  What `pre` does **not** reach is the template's own whitespace rule. The `ui` tag
  and JSX both join a run that crosses a source line break into one space before
  the string reaches a text, so a literal multi-line `<text white-space="pre">` is
  one line, not HTML's `<pre>` -- the newlines have to arrive through an
  interpolation, which is passed through as it is. That rule is the template's and
  is recorded there. The other reader of the property is `decrypt()`'s
  `limitAt()`, which honours `nowrap` and not `pre`, over a whitespace model of its
  own that drops a trailing gap under either; it is the component's to settle. See
  `test/element/white-space.test.ts`.

- **`resolveStyles()` with no sheets is the degenerate case of the cascade, not a
  second way of resolving a style.** It builds a `Restyler` over no stylesheets,
  which is props and inheritance with nothing matched -- so `box({ padding: '1' })`
  lays out padded without anybody having written a sheet, and there is still only
  one implementation of what a resolved style is. The walk is in document order,
  because a child's inherited values come from its parent's resolved style.
- **`arrange()` matches boxes to elements by index.** That is what the layout
  engine guarantees and says so: `result.children[i]` answers for
  `node.children[i]` whatever `order`, `display: none`, or the same node
  appearing twice did to the placement. Matching by identity would collapse two
  appearances of one node into one box, which is the bug the layout engine
  already carries an entry for.
- **It also writes the two rectangles more than one pass above needs.** The clip
  is one and was always one; `extent` and `scrollable` joined it in SIG-110,
  both taken on the way back up, and the argument is the clip's said twice
  over -- paint culls against the extent, the hit test skips a subtree by it
  and `scrollRange()` reads the scrollable region, so three walks computing
  one union would be three answers to one question. "A scroll box" in
  `src/components` has what each of them is and why the cheaper rule for
  either is unsound.
- **And it collects the elements that have not been _told_ the size it just gave
  them, for a caller that asks.** An optional third argument, a `Set` added to
  rather than cleared, because a caller that lays out twice in one pass must
  not lose the first answer to the second agreeing with it. Not "whose size
  moved", which is what this entry said for one commit and what the mechanism
  stopped being: the size a handler was told is recorded after it returns, so
  a handler that **threw** is asked again even though the box is already at
  its new size -- see "Windowing a long list" in `src/components` for the
  measurement that forced that. What it is all for is `Element.onResize`,
  which is the one hook `arrange()` is the writer behind -- and the dispatch
  is deliberately **not** here, because a handler that builds elements leaves
  them below the cascade and `arrange()` has no sheets to resolve them
  against. A caller that passes no collector sees no change at all, which is
  what keeps a bare `arrange()` a layout rather than a frame.
- **`Element.onLayout` is collected after every layout, because what it depends on
  is another element's box.** SIG-221, for the tooltip, whose bubble has to follow
  an anchor that moves for reasons with no writer it can hear: a scroll of an
  ancestor whose `onScroll` is somebody else's, a sibling that wrapped, an
  animation. `onResize` could not carry it -- it is asked only when the element's
  _own_ size moved, and widening it to "a layout happened" would break the rule
  `should tell nothing where no box changed size` pins. So it is a second hook in
  the same collector and the same dispatch: `settleResized()` calls it after
  `onResize` on an element carrying both, and asks `onResize` its own told-size
  question again there, because being collected for `onLayout` must not tell
  `onResize` about a size it already knows. The handler does the comparing and
  must answer `false` once nothing it reads has moved, or the frame spends every
  pass the bound allows. A tree with no `onLayout` collects exactly what it did.
- **Paint is `z-index` then document order, and `visibility: hidden` skips the
  element rather than the subtree.** Hidden is a skip rather than a return
  because `visibility` inherits: a descendant is hidden because it inherited the
  value, and one that sets `visible` is drawn. That is CSS.
- **The walk fills a box's background and nothing else paints one, and a text
  is handed no ancestor's colour.** Showing through is the painter's: a glyph
  with a `DEFAULT_COLOR` background keeps what is already in the cell, so paint
  order alone puts a box's colour behind its text, its border, a `raw` child, and
  anything painted over it later -- including a text with no coloured ancestor
  that sits on a coloured sibling, which no value carried down the walk could
  reach. See "A glyph keeps the background under it" in `src/canvas`, and
  `test/element/background.test.ts`.
- **`LayoutNode.children` is readonly, because the element tree's children are
  its own.** Nothing in the layout engine writes them, and an implementation
  cannot hand out an array anything may splice.
- **A link is `href` on a text, a reserved name rather than a property (SIG-197).**
  The canvas has carried a link in every cell's style since it was written, and the
  painter wrote `link: ''` for every element, so nothing above the grid could set
  one. A URL is content, not style -- no theme restyles it -- so it is a reserved
  name beside `id` and `tabindex`, and it is **not inherited**: the cells a link
  covers are the cells its text draws, so a box has none of its own to give one,
  and a fill under a linked word is not a link. It is added to the text's glyphs in
  paint, not in `cellStyle()`, for the same reason. A URL holding a control
  character is refused where it is given, because the canvas would refuse it a
  frame later and far away. `renderToString()` at colour level 0 leaves the link
  out with the colours: that level means "write no escape sequence", and the
  cascade cannot drop a link the way it drops a colour because a link is not style.
  Whether the terminal draws OSC 8 at all is the caller's question --
  `supportsHyperlinks()` answers it -- and the live renderer writes whatever it is
  given, as it always has. See `test/element/href.test.ts`.
- **A focus handler is told after the move has committed, and is never re-entered
  (SIG-278).** `onFocusChange` used to run inside `setState()`, between the
  router's two state writes and before `current.set()`, so a handler that moved
  the focus saw a half-done move and finished it twice: a blur handler sending the
  focus on to a third element left two with `:focus` and `.sigil-focus`, and one
  putting the focus back -- a trap -- was a no-op, because `current` still named
  the element it was restoring. Now `setState()` hands the element to `focus.ts`,
  the router's `focus()` commits both states, `current` and the scroll into view
  through `moveFocus()`, and the queue drains when the outermost move lets go. The
  rules, each pinned in `test/input/input.test.ts` or `test/element/element.test.ts`:
  - **Told in the order the states changed, and each told the state it has when
    its turn comes**, nothing if that is what it was last told. So a move a
    handler makes joins the end of the queue rather than nesting, an element a
    later move has already taken the focus back from is not told it had it, and
    in a drain that settles the last word every handler hears is the state its
    element ends in.
  - **A throw stops nothing.** The move stands, every other handler is still
    told, and what was thrown is raised once the queue is empty -- one error as
    itself, more as an `AggregateError` -- which is the graph walk's rule in
    `src/signals/graph.ts`. A throw from the commit itself, an `onScroll` the
    scroll into view woke, is held the same way, since leaving the hold up would
    silence every handler for the life of the process.
  - **A handler that threw is not asked again** until its state flips again, so
    whatever it had not drawn stays undrawn. That is the one disagreement left
    and it is the handler's own: for focus the router moves, the state, `:focus`
    and `current` always agree,
    and a control's class agrees with them for as long as its handler returns.
    Telling it again on the next move was the alternative and is refused, because
    the framework cannot know whether the handler drew before or after it threw,
    and a guess is wrong for one of the two. Chris's decision.
  - **The router is the one writer of the focus while it is moving (review round
    2).** `setState('focus')` while a move is committing or being announced
    throws, naming `focus()`. Taken, the write the queue deferred landed after
    `current` already named the real target: a blur handler restoring itself with
    `setState`, or an `onScroll` the scroll into view woke, left two elements with
    `:focus` and the role while the keys went to one. `moveFocus()` writes the two
    states itself, and the permission is the **one element** it is writing at
    that instant, spent by the write it allows (round 3): `setState()` runs the
    tree's mark callback between its check and its return, and a flag held across
    both writes let that callback write any element's focus -- two focused again
    -- or call `focus()`, whose own `finally` cleared the flag under the router's
    second write. A `focus()` from inside the router's own writes is therefore
    allowed and **wins**: the router counts its moves, the inner one takes the
    element the open move was writing towards as the one losing the focus, and
    the open move stops at its next step rather than putting a second element in
    `:focus`. Each step of a move runs whatever the one before threw, and
    `setState()` announces in a `finally` around the mark, so a throwing mark
    callback cannot leave a state written with `current` naming somebody else.
    A handler that wants the focus moves it with the router's `focus()`,
    which the trap test already spells. Outside a move a direct `setState('focus')`
    is unchanged -- nothing is holding, the queue drains at once and the handler
    runs before `setState()` returns -- but the router knows nothing of it, so
    `:focus` matches and `current` does not name the element. That is what an
    element with no router has, and it is the app's own disagreement.
  - **A drain gives up when it tells one element a hundred times** with `Focus did
    not settle`, for handlers that keep moving the focus round a cycle -- inline,
    that overflowed the stack; a queue would spin for ever. `MAX_PASSES` in
    `src/signals/effect.ts` is the same bound for the same reason. Per element,
    since round 2: a chain that only moves on tells each element at most twice
    however long it is -- gaining the focus and passing it on, and the one that
    keeps it once -- and a total of a hundred gave up on a sixty-control chain at the
    fiftieth. Giving up forgets what the element it stopped on and every one still
    queued were last told, so each is told at its next change whichever way it
    goes -- leaving the old value in place made the element left focused sit
    without the role and skip its next blur as a change it had heard. An element
    whose state cannot be read is forgotten the same way, and the drain releases
    its latch in a `finally`; a throw outside the handler's `try` used to leave it
    set and every later change in the process untold. The `finally` is insurance
    no test reaches -- with the read caught, nothing else in the loop throws.
  - **One queue per process, not per router.** An element does not know which
    router owns it, so the queue cannot be partitioned, and the signals layer's
    batch is global for the same reason. So a `focus()` on one router made from
    another's handler commits at once and returns before its own handlers run;
    they are told when the outermost move in the process lets go, and what they
    throw is raised from that outer call. Draining a nested move's own
    announcements before it returns was the alternative and is refused: the
    nested move a trap makes is on the same router and names the element whose
    handler is running, so draining it re-enters that handler, and a handler that
    writes its class after calling `focus()` overwrites the newer answer.

  History: [docs/history/a-focus-handler-is-told-after-the-move-has-committed.md](../../../../docs/history/a-focus-handler-is-told-after-the-move-has-committed.md).
