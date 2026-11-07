# `packages/screenshot` — deliberate decisions

These are the decisions about this directory. Claude Code loads this file when it
works with files here; other agents should read it before changing anything in
this area. The root [`AGENTS.md`](../../AGENTS.md) holds the rules that apply
everywhere and still applies in full.

## Deliberate decisions — do not "fix" these

### Screenshots: a canvas as SVG or PNG, the TrueType rasterizer, and the bundled font

SIG-325. `src/screenshot.ts` is the entry, `src/grid.ts` reads a frame,
`src/colors.ts` decides the colours, `src/metrics.ts` sizes a cell for both
formats, `src/geometry.ts` draws box drawing, blocks and braille, `src/svg.ts`
writes SVG, `src/rasterize.ts` draws pixels, and `src/font/` is the TrueType
reader and the coverage rasterizer.

- **A package of its own, and the third shape the zero-dependency rule allows.**
  The font and the rasterizer are about a megabyte together, so an app that never
  takes a screenshot pays nothing -- the config stores' reasoning, for the same
  constraint. It depends on `@ttylabs/sigil` and on nothing third-party: the
  TrueType parser and the rasterizer are written here rather than taken from
  `opentype.js` or `fontkit`, because an image library with a dependency tree is
  a cost every app that wants a README image would carry, and the subset a
  monospace grid needs -- `cmap`, `glyf`, the metrics -- is small.
- **The PNG encoder is `@ttylabs/sigil/png` (SIG-114), and there is no second
  one.** One definition per helper, across packages too. `RgbaImage` is that
  module's type, re-exported here rather than redeclared.
- **What `@ttylabs/sigil` had to grow, and why each is in core.** A screenshot
  needs to know what a cell looks like, and a cell holds a style _index_ into a
  table the canvas deliberately does not hand out (only something owning the
  table and every grid can compact it). So `StyleTable.view()` hands out the
  list rather than the table -- a view cannot compact -- and `canvas.snapshot()`
  binds its copy to it, read back with `CellBuffer.cellStyle(x, y)`. A view stays
  right for every index handed out before the next `compact()`, _and after it_:
  interning only appends, and a compaction builds a new list rather than
  rewriting the old one, so a snapshot kept off `layers` keeps a view that still
  says what its indices meant. A snapshot pushed onto `layers` is remapped by a
  sweep, so `remap()` rebinds it -- and `front` and `back` are never bound, so
  nothing on the hot path changed. Pinned by the `a snapshot says what its styles
  are` tests in `packages/sigil/test/canvas/layer.test.ts`, whose sabotage (not
  rebinding) fails the layer case. `rgbChannels()` is `rgb()` read backwards,
  beside the packing so one module knows the layout, and the degrader's private
  copy of the unpack now calls it. The 256-colour table is the degrader's
  `paletteRgb()`, already exported.
- **The OSC 4 query is in core, beside OSC 10 and 11.** `detectCapabilities()`
  takes `foreground` and `palette` as it took `background`, written into the one
  batched round trip. One query per palette entry rather than xterm's list form,
  because a terminal that does not parse the list reads the first pair and drops
  the rest; a reply carrying several pairs is still read. `Capabilities.palette`
  is sixteen long with holes, and absent when nothing could be read.
- **Colour precedence is per colour, not per source.** Options, then the
  terminal, then the built-in palette for the scheme -- so a terminal that answered
  OSC 11 and not OSC 4 keeps its own background and borrows the built-in reds. The
  scheme is the renderer's chain with the reply in it (`colorScheme`,
  `SIGIL_COLOR_SCHEME`, the terminal, `COLORFGBG`, dark), so a frame themed light
  is drawn over the light defaults. `env` is an option because the default reads
  `process.env`, and a test or a CI screenshot passes `{}` to be the same
  everywhere. The built-in palettes keep the two promises sigil's own sheet makes
  of the sixteen: on dark, 0 is background-ish and 8 a grey text can sit in; on
  light, 7 is pale enough to be a pane background and 8 dark enough to read.
- **The input is read structurally, never by `instanceof`.** An app with two
  copies of `@ttylabs/sigil` installed has two `CellBuffer` classes. A grid with
  `charAt`/`styleAt` is a buffer, one with `cellAt` is a testing `Screen`. A
  buffer that cannot say what a non-default index means is **refused** rather
  than drawn in the default colours -- guessing would be reading another table's
  entry under this one's number -- and takes a `styles` table when it has one.
  The `Screen` is drawn in the default colours because it keeps no styling; its
  `lastInverse` caret is deliberately not drawn, since the model says itself that
  it can be stale.
- **A wide cell is whatever the grid says it is.** A lead followed by a
  continuation spans two cells; the width is not recomputed, so a screenshot never
  disagrees with the frame about which column something is in.
- **One geometry for both formats, sized in whole pixels and rounded at 1x.** The
  cell is the advance of `0` and the font's line height, each rounded at 1x and
  then multiplied by `scale` -- so a 2x PNG is exactly twice the 1x one, and the
  SVG (whose coordinates are 1x) declares the PNG's size. Rounding at the device
  size instead gave 17 for 2 x 8.4 and the formats drifted a column apart across a
  wide frame; that was measured before this rule was written. Glyphs are centred
  in the whole-pixel cell, which is a few tenths of a pixel of squeeze -- the trade
  every terminal makes.
- **Box drawing, blocks and braille are geometry in both formats, through a
  `Pen`.** A font's line-drawing glyphs are designed to an em and a line height
  that are not the cell's, so they leave gaps between rows. The same code draws a
  coverage bitmap for a PNG and `<rect>`/`<path>` elements for an SVG. The arm
  table is four digits per character, generated once from the Unicode names and
  written out. The junction rules are in `drawLines()`'s comment, and the tests
  pin the ones that are easy to get wrong: `╬` and `╠` stay open, `╔` turns on
  both sides, `╟`'s single arm stops at the near line. Every split of a block is
  rounded through one function, so `▀` and `▄` cover every row exactly once at odd
  heights. Shades are an even tone rather than a pattern, which would alias. The
  arcs are two 45-degree quadratics per quarter, with constants for the control
  points rather than a `Math.cos()` an engine might round differently.
- **Deterministic by construction, and it is the rasterizer's design rather than
  luck.** Signed-area accumulation is exact arithmetic on IEEE doubles, the curve
  is flattened into a count of segments that depends only on its own points, the
  one non-arithmetic call is `Math.sqrt()`, which IEEE 754 requires to be
  correctly rounded, and nothing calls a transcendental function an engine may
  round its own way or reads the clock, the locale or the system's fonts. Blending is integer. So golden files are compared exactly: SVG
  as text (line endings normalized, since a Windows checkout may convert them),
  PNG as decoded pixels rather than bytes, because the encoder is SIG-114's to
  change. `SIGIL_UPDATE_GOLDEN=1` rewrites them; a missing golden is written
  locally and is a failure in CI. The PNG goldens are on the binary list in
  `packages/sigil/test/sources.test.ts`, by name.
- **Glyphs after every background, lines after every glyph.** An italic or a
  fallback glyph that overhangs its cell is not painted over by its neighbour's
  background, which is what a terminal shows too.
- **A missing glyph is a tofu box, and JetBrains Mono lacks some of sigil's own
  symbols.** `✔`, `✖`, `☐`, `☑`, `☒`, `◐`, `ℹ` and the `◴`-family spinner are not
  in it; a terminal borrows them from a system font and a screenshot has none to
  borrow, by design -- reading system fonts would make the output depend on the
  machine. `font.fallback` is the answer, and the README says so. Substituting a
  near glyph (`✓` for `✔`) was considered and refused: it draws something the
  frame does not hold. A combining mark is drawn from the face its base was found
  in and dropped if that face lacks it; a variation selector and a joiner are
  dropped.
- **Synthesized faces come from the nearest real design.** A single font given as
  `font` is the regular face _only_ -- drawing one font's regular beside the
  bundled bold would be worse than synthesizing the bold from the font asked for.
  Bold is the outline drawn a second time a fraction of the font size along, into
  the same accumulator, which the clamp turns into a union; italic is a 0.2 shear.
  A missing bold italic is the bold sheared, else the italic smeared, else both.
- **An SVG keeps a link only for `http`, `https`, `mailto`, `ftp` and `file`.** An
  SVG opened in a browser follows what it is handed, and a `javascript:` target
  from a terminal's OSC 8 is not to be handed over; the text stays. A target with
  whitespace, a quote, `<`, `>` or a backtick is dropped too. Text is escaped for
  `&`, `<` and `>`, and a character XML cannot hold at all -- a lone surrogate,
  `U+FFFE`, `U+FFFF`, a control -- becomes `U+FFFD`, because one makes the whole
  document unparseable. Rectangles are `crispEdges` and paths are not: two cells'
  rectangles meeting off a device pixel each anti-alias against the background
  and the seam shows, while a crisp arc is a staircase. A run of text sheds the
  ASCII spaces at its ends unless it carries a line -- `trim()` was the first
  spelling and is wrong, since it also takes a two-cell `U+3000`.
- **CFF is refused by name.** An `OTTO` font is a different outline format, and
  "not a TrueType file" would be the wrong diagnosis. Every read in the parser
  goes through one bounds check that throws a `FontError` naming the table, rather
  than the `RangeError` a `DataView` throws on its own.
- **The fonts are read from `../fonts/`, never copied into `dist/`.** That path is
  the same from `src/` and from `dist/`, so the build reads none of them, they are
  not a build input, and a cached `dist/` cannot hold a stale copy. `files` ships
  `fonts/` beside `dist/`, with `OFL.txt` as the licence requires. They are the
  v2.304 release's `fonts/ttf/` files, checked against the git blob hashes of the
  same paths at that tag.

#### What review round 1 found, and what did not reproduce

- **A composite had no output budget.** Depth was capped at eight and breadth
  was not, so a composite naming the one below it six times, six deep, is
  186,624 points from a few hundred bytes -- and eight deep is 6^8 squares,
  allocated before anything is drawn. Reproduced with a built font before the
  fix. A glyph may now expand to `0xFFFF` points, which is the most `maxp` can
  record for an honest one, and past it the read throws a `FontError`.
- **A glyph's bitmap was sized from the outline alone.** Points are 16-bit and a
  font may claim 16 units per em, so one character could ask for an accumulator
  tens of thousands of pixels on a side. `rasterizeOutline()` takes a `window`
  and the PNG path passes the cell plus one cell either side; rows outside are
  never visited and columns are clamped, which keeps the winding of what is
  inside right. The test draws a glyph spanning 32,000 units at 16 per em.
- **Painting into a snapshot after a sweep wrote the new table's numbers under
  the old view.** A snapshot kept off `layers` keeps the pre-sweep view -- right
  for what it holds -- and `canvas.painter(shot)` interns into the post-sweep
  table, so the new cell read back as an old frame's colour. `Painter` now
  re-interns a bound grid through its own table the first time it paints it after
  the two parted, then rebinds; an unbound grid is untouched, so `front` and
  `back` never take the path. Sabotaged (the check skipped): both new tests fail.
- **`fontFamily` reached `<style>` as live CSS.** A `;` or `}` ended the
  declaration and an `@import` followed. A font stack is now names, spaces,
  quotes, commas, dots and hyphens, and anything else is refused.
- **A fallback glyph's synthetic style was read off which slot its face was in.**
  One file given as both `regular` and `bold` loads as one font, so a regular
  character was emboldened. It is read off the cell's attributes now.
- **`SCALED_COMPONENT_OFFSET` was ignored.** A component that sets it has its
  offset put through the matrix; neither flag set stays unscaled, which is the
  default every rasterizer takes, and `UNSCALED_COMPONENT_OFFSET` wins over it.
- **A grid's size was unbounded before it was read.** A structural `Screen`
  claiming 10^7 by 10^7 cells was walked before either format could say the image
  was too big. More than 4096 x 4096 cells is a `RangeError` up front.
- **An OSC 4 index was not trimmed while its colour was.** Both are now.
- **Did not reproduce: "a 2x2 composite applies the off-diagonal terms swapped".**
  The review read the four words as `x' = a*x + b*y`. Apple's TrueType reference
  and FreeType (`ttgload.c` loads them as `xx, yx, xy, yy` and transforms with
  `x' = xx*x + xy*y`) both apply `x' = a*x + c*y`, `y' = b*x + d*y`, which is
  what the code does. A test now pins that convention with a 90-degree rotation,
  so a later "fix" in the other direction fails.

#### What review round 2 found

Round 2 re-read round 1's fixes and probed each; all held, and it found three
small things. Its premise for each was checked before the fix.

- **The `fontFamily` whitelist was ASCII.** `\w` without the `u` flag refused
  `微软雅黑`. Letters, marks and numbers are matched by Unicode property now; `;`,
  `{`, `}`, `(`, `)`, `\`, `@`, `<`, `>` and newlines are still refused, so the
  injection round 1 found stays closed.
- **The cell cap could be stepped round with a zero width.** `0 x 10^12` has a
  product of zero and the rows were still walked. Each side is capped as well.
- **The README's determinism sentence left out `Math.sqrt()`**, which round 1 had
  already corrected here.

There was no round 3, since nothing round 2 found was substantive.
