# `packages/sigil/src/width` — deliberate decisions

These are the entries from [../../../../AGENTS.md](../../../../AGENTS.md) that are about this directory. Claude Code loads this file when it
works with files here; other agents should read it before changing
anything in this area. The root `AGENTS.md` holds the rules that apply
everywhere and still applies in full.

How each of these was arrived at — the review rounds and sabotage
passes — is under [docs/history/](../../../../docs/history), linked from
the entry it belongs to.

## Deliberate decisions — do not "fix" these

### Plain ASCII never builds a segmenter

- **`graphemes()` splits plain ASCII by code unit, and `stringWidth()` measures
  it by length, and both ask the same `asciiOnly`.** SIG-243. Building the first
  `Intl.Segmenter` in a process loads ICU, and every app's `--help` paid for it:
  `stringWidth()` already had an ASCII fast path, but the wrapper does not
  measure through `stringWidth()` -- `tokenize()` splits each run between
  escape sequences with `graphemes()` and measures each cluster with
  `graphemeWidth()`, so `wrap()` under the element's `measure` under layout built
  a segmenter for help's own all-ASCII text. That was the **only** path: a probe
  wrapping every `Intl` constructor and function, `localeCompare`, `normalize`
  and the `toLocale*` methods, loaded ahead of a real `--help` on an app of eight
  commands, saw one `new Intl.Segmenter` from that stack and nothing else -- in
  plain and in colour, at 80 columns and at 30, for `--help` and for `help build`,
  and for the toolchain's own `sigil --help`. After the change it sees nothing at
  all in any of them.

  The shortcut is in `graphemes()` rather than in `tokenize()` because
  `graphemes()` is the one place a segmenter is reached from: putting it there
  takes the canvas's text writer, truncation, the pager and the clipboard off ICU
  for plain ASCII in the same line, and it leaves one definition of plain text
  rather than a second one beside the wrapper. `asciiOnly` stays module-private,
  since nothing outside this module needs to ask once `graphemes()` does, and the
  segmenter moved to `segment.ts`, which is not in the published `width` entry,
  so the suite can run the full path without making it API.

- **Plain means printable ASCII, `U+0020` to `U+007E`, and nothing wider.** It is
  the one set where every code unit is a cluster of its own one column wide, so
  the shortcut cannot change an answer: no grapheme break rule joins two of them,
  and none is an emoji or wide. Everything else is left to the full path rather
  than reasoned about, and the two that look safe are not. A **tab** is its own
  cluster, but its width is `0` -- it is a `Cc` -- where `length` says `1`. `CR
  LF` is the one pair in ASCII the segmenter joins. `ESC` opens a sequence, and a
  printable character followed by a combining mark is one cluster with it, which
  is why the test is over the whole string rather than character by character.
  `charWidth()` keeps its own per-code-point ASCII test: that is a different
  question about one code point, not a second definition of a plain string.

- **The segmenter is built when something is first segmented, never at module
  load.** It already was; it is pinned now, because an eager one would put the
  ICU load back on every process that imports the module, which is all of them.

- **Measured, as of SIG-243**, on node 26.10.0 on macOS, with `main`'s dist and
  this change's interleaved in one loop, ten warm-up pairs, ABBA order, `--help`
  on an app of eight commands. Over 100 pairs: a minimum of 44.47 ms before and
  38.97 ms after, a median of 45.74 ms and 40.74 ms. Two runs of 60 pairs agree,
  at minimums of 44.36 against 38.87 and 45.25 against 40.13, and medians of
  45.90 against 40.64 and 48.17 against 42.77. About 5 ms, then -- slightly more
  than the first `new Intl.Segmenter` itself, which was 5.07 to 5.11 ms
  in-process before the change, because segmenting the text cost something on
  top of building the segmenter. It is the 4 ms SIG-238 expected from moving the
  sort and did not find, which `src/help/AGENTS.md` records.

  `test/width/segmenter.test.ts` holds both halves. `an all-ASCII screen` counts
  constructions over a fresh module graph, for measuring, wrapping and truncating
  plain ASCII and for rendering a narrow help screen in colour, with a control
  that non-ASCII text builds exactly one. `the plain ASCII shortcut` is the
  differential: a second module graph whose `width` module has no shortcut at
  all, and every string of a corpus -- controls, tabs, `CR LF`, `ESC` and SGR and
  OSC 8, CJK, Hangul jamo, combining marks, a ZWJ family, a skin tone, a flag, a
  keycap, a lone surrogate, and 400 seeded random mixtures of them -- split,
  measured, tokenized, wrapped, truncated and rendered by both. Sabotaged: always
  segmenting fails the two counting tests; widening plain to `\x00-\x7F` fails
  five; letting a tab through fails the width and wrap differentials; an eager
  segmenter fails all three counting tests. And with plain widened again,
  dropping the full graph's `graphemes` override turns the tokenize differential
  green while the others stay red -- which is what says that override is what
  makes the downstream comparisons mean anything.

### One code unit is one cluster

- **`graphemes()` hands a string of one code unit back as it is, whatever the
  code unit is (SIG-290).** It does not answer which characters are safe, which the
  entry above refuses to reason about. It is about length: a grapheme break rule
  joins a character to a neighbour, and a string of one code unit has no
  neighbour. A box-drawing line, a braille cell, a combining mark on its own and
  half a surrogate pair are each one cluster to the segmenter, because there is
  nothing else in the string. So the shortcut cannot change an answer, and the
  differential below holds it to that.

  It matters because a border is painted one cell at a time. `paintBorder()`
  calls `painter.text()` with one character per cell, which reaches
  `graphemes()` through the canvas's writer, and every cell of every edge of
  every panel went to the segmenter on every frame. On the full-screen stress
  workload (a 200-by-60 screen of five bordered panels; "A full-screen
  performance budget" in `src/renderer`), the change took the frame's p50 from
  11.49 to 12.01 ms down to 9.56 to 10.01 ms, interleaved, three runs each. That
  is about 16%. The bytes it wrote were identical.

  `stringWidth()` is left alone. It still strips and segments a one-character
  string that is not ASCII, because nothing measured needed it. The two are not
  in conflict: `asciiOnly` is still the one definition of plain text that both
  ask. This is a statement about clusters, which only `graphemes()` produces.
  Widening the shortcut to the box-drawing, block and braille ranges was not done
  either. It would have bought the horizontal edges too, but only as a claim about
  which characters never join, and that is the reasoning this file refuses. A
  horizontal edge written as one string is a question for `paintBorder()`, which
  no measurement has asked yet.

  `test/width/segmenter.test.ts` holds both halves. `should build no segmenter
  to split one code unit` splits eight single code units and renders a bordered
  box with an ASCII label, and asserts that no segmenter was built. The
  differential corpus gained a box-drawing line, a braille cell, a lone combining
  mark, a lone joiner, a lone surrogate and a lone `\r`. When the shortcut was
  sabotaged (`length === -1`), the counting test failed and the differential
  still passed, which is the right way round: the shortcut changes no answer, and
  only the cost shows it.

### What turns a text-default character into a two-column emoji

- **A cluster is one two-column emoji when its base is `Emoji_Presentation`, or
  when something in the cluster asks a text-default base to be one. Three things
  do, not one.** SIG-359. `isEmoji()` knew only the presentation selector, so
  `U+270C U+1F3FD`, a fully-qualified RGI emoji with no selector in it, fell to
  the per-code-point sum. The base is text by default and one column, the tone
  is two, so `stringWidth()` said three while `cellWidth()` clamped to two.
  Layout, `wrap()` and `truncate()` budgeted a column the canvas never painted.
  The three, each tested in `isEmoji()`:

  - **VS16 immediately after an `Emoji` base.** This rule was already there.
  - **A skin tone immediately after an `Emoji_Modifier_Base`.** Not after any
    `Emoji`, which is the obvious spelling and is wrong: a digit, `#`, `*` and
    `™` are `Emoji` and none of them takes a tone, so `1 U+1F3FD` is a digit
    with a swatch beside it, three columns, as before. It has to be immediately
    after for the same reason the selector does: `U+261D U+0301 U+1F3FD` puts a
    mark between them, so the tone is not about the base and the cluster stays
    the sum. Nine bases are text by default (U+261D, U+26F9, U+270C, U+270D,
    U+1F3CB, U+1F3CC, U+1F574, U+1F575, U+1F590), and the tests cover all nine.
    For this form 2 matched four of six terminals in review, where 3 matched
    only VTE.
  - **A joiner followed by an `Extended_Pictographic`, anywhere in the
    cluster.** That is the unqualified ZWJ form. Four sequences in the test file
    changed width under it: the heart on fire `U+2764 U+200D U+1F525`, the
    mending heart `U+2764 U+200D U+1FA79`, the broken chain
    `U+26D3 U+200D U+1F4A5` and the rainbow flag `U+1F3F3 U+200D U+1F308`.
    `RGI_Emoji` under the `v` flag does _not_ match them, so it cannot stand in
    for this test. **Terminals disagree about this form.** Read from source in
    review: iTerm2 and kitty advance one column, while Ghostty, WezTerm and
    Windows Terminal advance two. Two is chosen because it is the width of the
    fully-qualified form of the same sequence, and the terminals that widen a
    joined cluster give it. The segmenter keeps a pictograph after a joiner in
    one cluster only when a pictograph, followed by nothing but extending
    marks, came before that joiner (GB11). So the pair means the joiner joined
    two pictographs, and the base is not checked. A prepended character (GB9b)
    can come ahead of the first pictograph, as in `U+0600 U+2764 U+200D U+1F525`,
    and that is two columns as well. A joiner alone is not enough: `U+00A9 U+200D`
    with nothing after it joins nothing, and stays one column.

  The joiner in that regular expression is written as the escape `\u{200D}`,
  because the escape reads unambiguously and the raw character is invisible: a
  raw one makes the pattern read as "any pictograph", and an editor that drops
  it silently makes every cluster of more than one code point that holds a
  pictograph two columns, `U+2764 U+FE0E` among them. The first version of this
  change shipped a raw joiner there, put in by an editing tool that decoded the
  escape on the way in. The formatter was checked and is not the cause: it
  keeps a regex escape byte for byte.

  What keeps its width is enumerated in `test/width/text-default-emoji.test.ts`:
  - A digit, `#` and `*` alone, and before a mark or a joiner: one column.
  - A lone tone: two columns, because it is `Emoji_Presentation`.
  - A lone joiner and a lone selector: zero.
  - A text-default pictograph with no selector, no tone and no joined
    pictograph: one column.
  - A tone after something it cannot modify: the sum, which `cellWidth()`
    clamps like any other over-wide cluster.

  The same file asserts that `stringWidth()` and `cellWidth()` agree on every
  single cluster in it that fits in two cells. Two rules can combine, and these
  are not in the tests:
  - A joined pictograph wins over a swatch. `U+00A9 U+1F3FD U+200D U+1F525` is
    two columns where it was three, because the tone is an extending mark and
    GB11 still joins.
  - VS15 does not undo either new rule. `U+2764 U+FE0E U+200D U+1F525` and
    `U+261D U+1F3FD U+FE0E` are both two, where both were three.
    `U+261D U+FE0E U+1F3FD` stays three, because the tone is not immediately
    after the base.

  Sabotaged:
  - An `Emoji` base for the tone fails the three swatch cases.
  - A bare joiner for the ZWJ rule fails the two trailing-joiner cases.
  - Requiring an `Extended_Pictographic` base fails the prepended case.
  - The original `isEmoji()` fails every widened case and passes every
    unchanged-width case.

  `isEmoji()` returns as soon as it finds a cluster of one code point, before
  any of the new tests. Most clusters that are not ASCII are one code point, so
  CJK, Latin and Devanagari text pay nothing for them. The property escapes are
  older than every Node this package supports. Only which code points a newer
  Unicode adds to each can differ, which is why the tests use none added
  recently.
