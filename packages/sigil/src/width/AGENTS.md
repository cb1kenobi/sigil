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
