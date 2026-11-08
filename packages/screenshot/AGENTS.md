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
  The font and the rasterizer were about a megabyte together when this was
  written, and about two once SIG-329 added the symbol font, so an app that never
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
- **A missing glyph is a tofu box, and the symbols JetBrains Mono lacks are not
  missing any more.** `✔`, `✖`, `☐`, `☒`, `◐`, `ℹ` and the `◴`-family spinner
  are not in it; a terminal borrows them from a system font and a screenshot reads
  none, by design -- reading system fonts would make the output depend on the
  machine. SIG-325 left them to `font.fallback`; SIG-329 bundles a symbol font
  behind every face, which is the section below. Substituting a near glyph (`✓`
  for `✔`) was considered and refused: it draws something the frame does not
  hold. A combining mark is drawn from the face its base was found in and dropped
  if that face lacks it; a variation selector and a joiner are dropped.
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
  same paths at that tag. `DejaVuSans.ttf` and `DejaVu-LICENSE.txt` sit beside
  them on the same terms; where they came from is in the section below.

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

#### Every refusal is decided from the dimensions, before a cell is read

CI timed out on `should refuse an image too large to hold` on all nine jobs, at
10-18 seconds against a 10 second limit. Measured locally before the fix: the
4000 x 4000 `CellBuffer` the test built took 13ms, and `rasterize()` then took
840ms to refuse it -- 316ms even for a structural grid that costs nothing to
build -- because `readShot()` walked all sixteen million cells before the pixel
cap was compared. So the work was before the check, not in the input.

`gridSize()` is the size check on its own, and `rasterize()` asks it and the
pixel cap before `readShot()`. The refusal is 0ms once the fonts are loaded. The
test builds a grid whose dimensions are big and whose cells are free, counts
every cell read and asserts there were none, and times only the refusal, with
the fonts read beforehand. With the old order put back it fails on the count,
31,996,000 reads. The test timeout was not raised.

### A bundled symbol fallback, so sigil's own glyphs never draw as tofu

SIG-329. `fonts/DejaVuSans.ttf` is looked in after every face and every
`fallback`; `findGlyph()` in `src/rasterize.ts` is the whole of the lookup, and
`test/symbols.test.ts` is the guard.

- **DejaVu Sans, because it is the one file that has every one of them.**
  Measured on 2026-11-08 with this package's own font loader against every
  non-ASCII character in `@ttylabs/sigil`'s source strings: JetBrains Mono lacked
  32 symbols the components draw -- `✔ ✖ ℹ`, `☐ ☒`, the spinner frames
  `◐ ◜◝◞◟ ◠◡ ◢◣◤◥ ◰◱◲◳ ◴◵◷ ✷✸✹✺ ⊶⊷`, and `ⁿ ⌠ ⌡` from decrypt's alphabet.
  DejaVu Sans covers all 32 in 757 KB. DejaVu Sans Mono is 341 KB and misses `ℹ`,
  which is the spinner's default `info` symbol, and `⊶ ⊷`; Noto Sans Symbols 2
  (1.2 MB) covers 26 and Noto Sans Math (1.0 MB) 23. The ticket said 33, 25 and
  21, but the list it gave is 32 long -- review round 1 counted it -- and the two
  Noto figures were recounted against those 32. The licence is Bitstream
  Vera's with the DejaVu and Arev notices, permissive on condition that it ships
  with the font, so `DejaVu-LICENSE.txt` is beside it and `files` ships both.
- **Where the file came from, and how that was checked.** The 2.37 release, the
  latest. `ttf/DejaVuSans.ttf` and `LICENSE` were taken from
  `dejavu-fonts-ttf-2.37.zip` on the project's GitHub release, and the release
  carries no digests, so the copy was checked against two other routes to the same
  bytes: the `dejavu-fonts-ttf-2.37.tar.bz2` asset on the same release, and the
  zip as SourceForge serves it, which is where the project published before
  GitHub. The SourceForge zip is byte for byte the GitHub one (SHA-256
  `7576310b...908b0a`, 5,522,795 bytes), and both archives' members hash to what
  is committed: `DejaVuSans.ttf` is `7da195a7...848954`, `LICENSE` is
  `7a083b13...958a93`. Nothing in either archive was run.
- **Behind the faces, behind the caller's `fallback`, and behind every `font`.**
  The order is the styled face, each `fallback` in turn, then this, so a caller
  who has a font they prefer for symbols still gets it -- and a font set that
  names none of the bundled faces still has the symbols, since a custom `font` is
  about how text looks rather than a request for tofu. It is read the first time
  a character is missing from everything in front of it: parsing it is about
  0.2 ms, so that is not a speed claim, but an SVG never looks a glyph up and so
  has no reason to read 757 KB, and nor does a frame the faces cover.
- **Every fallback is drawn at its own em, which it never was.** The glyph cache
  scaled a fallback by the _regular face's_ pixels per unit, so a font whose
  `unitsPerEm` differed from JetBrains Mono's 1000 was drawn out of proportion:
  DejaVu's 2048 came out at 2.048 times its size, a `✔` 17 px wide in an 8 px
  cell. That
  was true of a caller's `fallback` from the day it existed -- including the
  DejaVu Sans Mono the README used to suggest, also 2048 to the em -- and nothing
  caught it because the one test of a fallback used a font built at 1000.
  Reproduced before the fix with DejaVu Sans given as a `fallback` on the code
  as it was. The unit is now the
  face's own; `should draw a fallback at its own em` builds one square at 1000
  and at 2000 units and wants the same pixels, and fails with the old unit.
- **A symbol is drawn at its own size, centred on its advance, and may overhang
  the cells beside it.** That is the rule every glyph already had, and measured
  over the 32 it centres the ink: their side bearings are equal to within 0.13
  px at 14 px, except `ℹ` (0.48 against 0.35) and `⌠ ⌡`, which are the two halves
  of an integral and are designed off-centre on purpose. What it does not do is
  fit: DejaVu's circles and squares are 10.7 px wide in an 8 px cell, so `◐`
  overhangs each neighbour by about 1.3 px -- which is what a terminal does with a
  fallback glyph, and is why glyphs are painted after every background. In sigil
  the neighbour is nearly always a space (`✔ done`, `☐ item`, a spinner and its
  label), and the size matches the text: DejaVu's cap height is 10.2 px at 14 px,
  JetBrains Mono's is 10.2 too.

  Fitting was considered and refused twice. Scaling each glyph down to the
  cell breaks sets that are designed in one frame: `ARC` is `◜◠◝◞◡◟`, where the
  quarters are 5.4 px wide and the halves 12.2, so a per-glyph fit draws one
  arc at two radii. Scaling the whole font by one factor keeps the sets whole but
  puts DejaVu's shapes lower than JetBrains Mono's -- its circles are centred
  3.6 px above the baseline, JetBrains Mono's 5.0 -- and moving them up is a
  constant tuned to one pair of fonts. The cost of not fitting is that two sets
  mix fonts: JetBrains Mono has `◶` and `✶` itself, so `CIRCLE` and `STAR` each
  have one frame that is smaller and higher than the rest. A terminal with these
  two fonts shows exactly that.

- **Fullwidth ASCII, `U+FF01` to `U+FF5E`, is drawn from the ASCII glyph, centred
  across both cells.** None of the bundled fonts has a fullwidth design, a CJK
  font that does is some 16 MB, and decrypt's default alphabet uses 52 of them
  (the ticket said 48). JetBrains Mono's `cmap` does map two, `U+FF5B` and
  `U+FF5D`, to copies of its narrow braces at the narrow advance, so those two
  are drawn from the face rather than rewritten -- centred across the two cells
  all the same, which is the same picture.
  It is the last thing tried before the box, after every font, so a `fallback`
  with real fullwidth glyphs draws those; and the ASCII is looked up through the
  same chain with the cell's style, so a bold `Ａ` is a bold `A`. Centring is the
  ordinary rule with a span of two: at the default size that is four whole pixels
  along from the narrow glyph, so `should draw a fullwidth form as its ASCII
  glyph` can ask for the very same pixels. The rest of the block is not mapped:
  `U+FF5F` onwards are not ASCII, and nothing in sigil draws them.
- **The SVG needs none of this.** Its text is drawn by the viewer's fonts, and a
  browser falls back per character the way a terminal does; WebKit, through
  QuickLook, drew every symbol in the showcase and the fullwidth letters in their
  columns. Embedding DejaVu would put 757 KB into every SVG, and a subset per
  document is a font writer this package does not have. The PNG is the format
  that cannot borrow, so it is the only one that bundles.
- **The guard derives what the components draw rather than listing it.** Two
  halves. Every data export of `@ttylabs/sigil/components` is walked for its
  strings -- the spinner sets, `OUTCOME_SYMBOLS`, `PROMPT_SYMBOLS`,
  `LOG_SYMBOLS`, `CP437`, `ASCII` -- with `treeGlyphs()` in each style and the
  registry's `spinner-frames.ts`, which ships as a file for `sigil add` rather
  than as an export; a new export is covered without being named. Then the
  string and template literals of `packages/sigil/src/components/*.ts`, parsed
  with vitest's own `parseAst()` so comments and regexes are left out, because
  some of what a component draws is a module-private constant no import reaches:
  `markdown.ts`'s `☐ ☒`, `group-multiselect.ts`'s `◐`, `group.ts`'s marks. Each
  cluster is painted into a real canvas and read back as the rasterizer reads it,
  so what never becomes a drawn cell is the canvas's decision -- it refuses a
  control character outright, and a zero-width one takes no cell -- and checked in
  all four styles through `findGlyph()` and `isGeometry()`, which is the decision
  `GlyphCache.cluster()` makes. `findGlyph()` is exported from its module for
  that and is not in the package's index.

  Sabotaged three ways, each of which type-checks. `'⯀'` added to `DOTS` in
  `spinner.ts`, with `@ttylabs/sigil` rebuilt: both halves fail, naming `DOTS`
  and `src/components/spinner.ts`. `'⏀'` added to `STAR` in
  `spinner-frames.ts`: the export half fails, naming `spinner-frames STAR`.
  `group.ts`'s intro mark changed to `'⸺'`: the export half passes, since the
  constant is private, and the literal half fails naming the file -- which is
  the case it exists for. Taking the symbol font and the fullwidth rule out of
  `findGlyph()` fails it with exactly the 32 above and the 52 fullwidth forms,
  and nothing else.

- **What it cost.** `npm pack` of the package, before and after: 557,671 bytes
  packed and 1,165,468 unpacked across nine files, then 947,368 packed and
  1,933,569 unpacked across eleven, as of the review round 1 fix -- the font is
  757,076 of it and its licence 8,816, the rest is this documentation and the
  code. That is the whole of the price, and only an
  app that installs this package pays it.

#### What review round 1 found, and what did not reproduce

- **A combining mark was drawn half a cell to the left of its base.** Every glyph
  was centred on its own advance, and a mark's advance is zero, so its origin was
  the middle of the cell -- while a font with no positioning tables draws a mark
  to the _left_ of its origin, over the glyph before it. So an `é` written as `e`
  and U+0301 had its accent on the cell's left edge. Older than this ticket, and
  made reachable by it: a fullwidth form and a DejaVu symbol were boxes before,
  and a box draws no marks. Reproduced in a 6x PNG before the fix. The base is
  still centred on its advance; the pen then moves past it, and each mark is
  drawn from there, so the origin is in the glyph cache's key -- a mark after
  `✔` and after `ℹ` sits at two different places. `should put a combining mark
  over ...` asks that the mark's ink lie inside the base's, for `e`, `ｅ` and `✔`;
  the old placement fails the first two. The `✔` case passes either way, since
  the tick is wide enough to cover a misplaced accent, and is kept as the symbol
  case rather than as the proof.
- **The counts were wrong.** 32 symbols rather than the ticket's 33, and decrypt
  draws 52 fullwidth forms rather than 48. Corrected above, with the two Noto
  figures recounted at the same time.
- **JetBrains Mono maps `U+FF5B` and `U+FF5D`.** To copies of its narrow braces,
  so "none of the fonts has fullwidth forms" was not true of its `cmap`. Those two
  are drawn from the face, centred across both cells, which is what the rewrite
  would have drawn; the wording says so now, and nothing in the code changed.
