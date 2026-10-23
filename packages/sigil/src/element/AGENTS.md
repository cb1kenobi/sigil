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
- **A `nowrap` text is cached under one key rather than one per width.** It is
  one line per newline whatever room it was offered, so a key per width was many
  entries holding the same answer -- and worse, layout and paint asking about
  different widths each missed the other's, so a table, whose cells are all
  `nowrap`, paid for the wrap twice over and got slower when the lines were
  first cached. The longest word is worked out only where it can be used, since
  a `nowrap` text cannot be squeezed to it and scanning for it was an answer
  thrown away.
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
- **Paint is `z-index` then document order, and `visibility: hidden` skips the
  element rather than the subtree.** Hidden is a skip rather than a return
  because `visibility` inherits: a descendant is hidden because it inherited the
  value, and one that sets `visible` is drawn. That is CSS.
- **`LayoutNode.children` is readonly, because the element tree's children are
  its own.** Nothing in the layout engine writes them, and an implementation
  cannot hand out an array anything may splice.
