# "Did you mean": the nearest thing the reader could have typed — how it was arrived at

The review rounds, sabotage passes and by-hand audit passes behind
[packages/sigil/src/parser/AGENTS.md](../../packages/sigil/src/parser/AGENTS.md). The decisions themselves are
there; this is the record of what each round found, which is kept
because a finding nobody wrote down is one somebody re-discovers.

#### What the first review round found, and it was two limitations rather than a bug

Pointed at the diff with the ticket's requirements and none of the reasoning, it
reported the recurrence correct -- brute-forced against a reference OSA over
about 116,000 pairs, zero differences -- the floors and the ties firing, the
computation failure-path-only at all three sites, and the registries right. What
it found is two **properties** worth writing down rather than two defects, and
each was confirmed against the code before anything was changed.

- **A duplicate candidate ties with itself**, so `nearest('buidl', ['build',
  'build'])` offers nothing where one `build` offers `build`. That is exactly what
  the `Set` in the two producers is for, which was already written down from the
  other side; it is now stated on `nearest()` as a precondition rather than
  guarded, because those two are the only callers there are and `suggest.ts` is
  not exported from any barrel.
- **Nothing normalizes, and the parser is why.** A decomposed `cafe` plus a
  combining acute is two edits from a composed `café` and so offers nothing, and
  the reviewer read that as a soft limitation. It is the right answer, and what
  says so is a measurement rather than an argument: a registry lookup is a plain
  object key, so the parser does not match across the normalization either -- the
  decomposed spelling against a command declared composed is
  `Unexpected argument` naming the decomposed token. Normalizing would offer a
  name the typed token cannot reach, which is the one thing this must not do.
  Pinned as both halves in one test, so somebody "fixing" it meets the reason.

  **What that reason does _not_ cover is a mark case folding itself
  introduced**, which is the entry two below and is the one place this paragraph
  was too broad: the line is whose mark it is, not whether a normal form would
  equate the two.

What it also priced is the one shape where the length pre-filter does not help:
two strings of **equal** length, where the walk is quadratic -- 174ms for a pair
of five thousand characters. Unreachable, because the other side of every
comparison is a command or option name.

#### What the second review round found, and it was all claims rather than code

Pointed at the regions round 1 listed as not opened -- the tests, the prose, the
generated key set, the bundle assertions and the module that was split -- and
told not to re-derive any of round 1's premises. It found **no runtime defect**
and five things worth acting on, four of which are the same shape: a sentence
here stronger than the test beside it.

- **The readdir counts were prose where they could be assertions.** This entry
  said one directory and three directories and the test said `> 0` and `> 2`,
  which a regression to five on both sides would have passed. They are
  `toHaveLength(1)` and `toHaveLength(3)` now, so the numbers above are
  re-derivable from the suite rather than from a run nobody repeats.
- **The corpus figures -- 13, 44, 49 -- were a tally nothing checked**, and the
  fix is to pin the **mechanism** rather than the tally, because the mechanism is
  the claim: `should leave buidl invisible to a subsequence match and one edit from
  build` asserts that `fuzzyMatch()` answers _nothing at all_ for each of six
  transpositions while the distance answers one, and its sibling asserts that
  each abbreviation is more than one edit away and does start at the front. Those
  two are why there are two metrics, said as checks.
- **`--porx` is reused in the `defaultLocale` block where it attracts no
  suggestion**, which is correct -- that schema declares no options -- and reads
  as though it were testing this feature. It says so now, including that an option
  added there would move those three onto the suggesting key.
- **The byte figures are prose, and that is the house's own practice rather than
  an oversight**: the root entry is held by a 20 kB ceiling and the parse chunk by
  a whole-chunk absence, because what is worth pinning is which modules are
  reachable rather than a number that moves with every chunking decision. Said
  here so the next reader knows which of the figures above a re-run is the only
  way to confirm.
- And it priced the one shape the pre-filter cannot help, which is the paragraph
  two above.

#### What a third round found: the dotted capital I, and the line that settles it

An independent round -- driven as focused single-file chunks, because
`cursor-grok-4.6-high` is slow enough to be killed on a whole diff, and because
`cursor-grok-4.6-high-fast` does not exist at all -- found the one real Unicode
gap the two rounds here had missed, and it is **fixed** rather than recorded.
Every measurement below was taken before anything was changed.

`'İ'.toLowerCase()` is **two** code points, `U+0069 U+0307`, and that broke both
halves. `fuzzyMatch()` walks two arrays of code points and compares their
elements, so a two-code-point needle equals no element and the forward pass fails
outright: `fuzzyMatch('İn', 'info')` answered **nothing at all**. And in the
_candidate_ as well -- `fuzzyMatch('inf', 'İnfo')` is nothing, which is a Turkish
app's own command names, in the **palette**. `nearMiss()` failed separately,
because the fold _lengthened_: `İ` against `i` is distance 1 with a shorter length
of 1, which the "something in common" rule refuses.

- **It is `fuzzyMatch()`'s own invariant being false, which is what makes this a
  fix rather than a feature.** That function's model is one folded value per
  unfolded code point -- it is why the indices it reports are indices into the
  unfolded array, which `highlightRuns()` depends on -- and `U+0130` is the one
  code point in Unicode that violates it. Worse, the comment there **said so and
  drew the wrong conclusion**: the fold "may be longer than one code point ...
  which is why this is only ever _compared_ and never used to index", where
  comparing is precisely the thing that breaks. The dangerous-prose shape this
  file keeps recording, in the module it keeps recording it about. Pre-existing
  since the palette shipped, and inherited rather than introduced here.
- **Normalizing is not the fix, which is the obvious guess and was the one
  suggested.** There is no precomposed "i with dot above", so **all four** of NFC,
  NFD, NFKC and NFKD leave the folded `U+0069 U+0307` exactly as it is. Measured,
  and pinned, because a reader will reach for it.
- **What the fix is, is the simple case mapping.** JavaScript gives the **full**
  mapping from SpecialCasing.txt where a matcher wants the **simple** one from
  UnicodeData.txt, which for `U+0130` is `U+0069` and is the first code point of
  the full mapping -- the Turkic locale mapping agrees, which is the corroboration
  available from inside the process. So `fold()` swaps it for `i` before
  lowercasing, after which `toLowerCase()` is one-to-one.
- **The set is a singleton, and that is what makes it safe rather than hopeful.**
  Of all 1,114,112 code points **exactly one** has a lowercase mapping longer than
  itself. 102 have a lengthening _uppercase_ mapping -- `ß` to `SS`, `ﬁ` to `FI` --
  which is why the asymmetry is easy to misjudge and why the count had to be taken
  rather than assumed. So the change cannot alter any answer for a string with no
  `U+0130` in it, which is a containment that can be proved rather than tested
  for. Brute-forced in `fuzzy.test.ts`, one code point at a time, so a later
  Unicode version that adds a second one fails there rather than going quiet in a
  matcher -- and idempotence with it, which `nearMiss()` relies on when it folds
  once for the lengths and hands the folded strings to `distance()`.
- **And it does not reopen the café decision, because the line is whose mark it
  is.** This removes a mark **case folding introduced**; it never touches one the
  **author wrote**. That is sharper than the reason the round-1 entry gave, and it
  has to be, because the café argument -- a suggestion that looks identical on
  screen to what was typed is useless -- does not cover `İ`, which looks nothing
  like `i`. Both are pinned side by side, and `fold()` of a decomposed `cafe` plus
  a combining acute is asserted to be itself.
- **A dotless `ı` stays distinct from `i`**, which is the non-Turkic answer and is
  forced: the locale fold is refused because under `tr-TR` an `I` lowercases to
  that, so a query of `i` would stop matching an `I` on one machine and nowhere
  else. Both capital I's fold to `i` and the dotless lowercase is its own letter.
- **It costs nothing.** Twenty folds of a 100,000-character string are **0.13ms**
  with the swap and **0.15ms** without, because `replaceAll` over a string that
  does not contain it is one scan; the long-token suggestion is 6.25ms against the
  5.9ms recorded above, which is the same number.
- **It also removed a distinction**, which is the tidy half: `nearMiss()` measured
  its lengths on the folded strings _because_ the fold could lengthen, and with a
  one-to-one fold the folded length **is** the raw length. The test that pinned
  the difference is gone, replaced by the brute force that makes it moot, and the
  sabotage of it is now an **equivalent** mutation rather than a survivor.
- **One finding was refuted.** The round reported that `unknownCommand()` lacks
  the `typeof subject === 'string'` narrowing its two siblings have. True of the
  source and correctly absent: that signature is `subject: string` and its only
  caller passes a `string` out of `resolve()`, so a guard there would be the dead
  code this file deletes rather than keeps.

What it checked and found clean, each boundary from both sides: `limit` at 5 and
6, the pre-filter's `>`, the commonness `>=`, the rate `>`, `MIN_ABBREVIATION`,
and the prefix rule.

#### And its second round, which found three assertions that could not fail

Pointed at the files the İ round left alone. **No runtime defect**, and three
findings of the shape this file keeps rediscovering -- an assertion or a sentence
that cannot fail. All three are fixed, and the first one's _measurement_ is
refuted while its _hardening_ stands, which is worth separating.

- **The rate is measured on the shorter of the two, and that is the natural
  misreading.** The round reported that `limit(6)` is 2 for `deploy` and
  `limit(7)` is 2 for `version`, so the comment claiming the rate "allows one"
  was false for two of three rows. It is not: `limit()` is called with
  `shorter = min(qLength, cLength)`, which for `dpl`, `bld` and `ver` is **3**, so
  `limit(3)` is 1 for all three and the comment was right. Applying the rate to
  the _candidate's_ length is the misreading, it has now been made once, and
  `limit()` says so where it is defined so the next reader does not make it.

  The hardening is real, though, and it is the better assertion anyway: the test
  wrote the `1` out, which does not track the rate. Measured both ways rather
  than reasoned about, because the round's own consequence turned out to hold on
  a different input from the one it gave: at a rate of one-per-one, `bld` against
  `build` is distance 2 inside a limit of 3 and becomes a **near miss** -- the new
  assertion fails on it and the old `toBeGreaterThan(1)` passes, so the test had
  stopped pinning why the subsequence half exists at all. So it asserts `nearMiss()` itself
  answers nothing, which is the claim with no arithmetic restated in the test at
  all -- and it makes the pair symmetric, since its twin already asserts
  `fuzzyMatch()` answers nothing. `nearMiss` is exported for it, which costs no
  public surface: `suggest.ts` is in no barrel.

- **`toContain` cannot see the suggesting twin, because the twin _holds_ the
  plain one.** The `defaultLocale` block's comment claimed that an option added
  to that schema "would move these three onto the suggesting key and fail them",
  and it would have failed exactly one of the three: `Unknown option "--porx".
  Did you mean "--port"?` **contains** `Unknown option "--porx"`, so both English
  cases would have gone on passing and only the German one, which asserts
  `UNBEKANNT`, would have noticed. All three assert the whole line now --
  `'Error: ... \n'` -- which is the shape the `through main()` cases already use
  and is what makes that sentence checkable.

- **A name filter asserted empty is vacuous on a rename, which this file refuses
  in as many words.** The guard was
  `[...graph].filter((name) => /^(?:width|strip|codes)-/.test(name))` against
  `[]`, and line 177 of that same file says it outright: a test that only asserts
  an absence "passes forever the day the symbol is renamed, and would then be
  pinning nothing at all". The sharpest of the three, because the entry above
  claims the import swap is _caught_ by this assertion -- with a stale regex that
  sabotage becomes a silent pass.

  It is keyed on a **symbol** now, with a presence half: `'grapheme'` is the
  `granularity` the one `Intl.Segmenter` in the package is constructed with, so
  it is a string literal the minifier keeps where `graphemes` and `Segmenter` are
  a local and a global it may rename, and it is named for exactly what is being
  refused. Absent from the parse chunk's graph, present on `help.mjs`'s, which is
  where segmentation legitimately is because help draws text. The same pair the
  component markers already are, and for the reason recorded there.

  Three mutations over it, all three caught and each by the right half. The
  **import swap** fails the absence, so the claim above holds with the new
  assertion. A **stale marker** -- which is the rename case -- fails the
  presence, where under the name filter it was a silent pass. And putting the
  **name filter back** with stale names fails the presence too, so reverting the
  shape does not reopen the hole.

#### What the sabotage pass found

Thirty-eight mutations, one at a time with a green control first and the
suggestion, i18n and fuzzy suites run after each. **Thirty-five caught, three
declared**, counted against the shipped tree in one run rather than summed across
rounds; three more over the dist assertion are run by hand because they need a
rebuild, and are under the round above.

- **Three survivors, and each is declared.** The **length pre-filter**, for the
  reason above: it cannot change an answer, so nothing can be written that fails
  when it goes. `fold()` taking **no locale argument**, which is a property of the
  source rather than of any behaviour -- measured, `'I'.toLocaleLowerCase()` is
  `'i'` even under `LC_ALL=tr_TR.UTF-8`, so only the explicit-argument form
  differs. And `nearMiss()`'s **folded** length, which is now an _equivalent_
  mutation rather than a survivor: with a one-to-one fold the folded length is the
  raw length, so the two spellings are one expression.
- **Three survived the first pass and every one was a fixture too easy to reach
  the branch it was named for**, which is the shape this file keeps recording.
  Two were the same cause: the option corpus had **two** short options in it, so
  `-x` is one edit from `-v` and from `-p` alike and the **tie** rule covered for
  both the "something in common" guard and the dash stripping. One short option is
  the input that separates them -- and the dash stripping needed a test that goes
  **through a parse**, because the unit test passed a key of its own and so could
  not see the module's.
- The third was the folded length, which only `İ` can see -- it folds to two code
  points, so it is the one character whose raw and folded lengths differ.
- **Nothing turned out to be dead.** Every guard written was either caught or is
  the declared fast path, which for a pass this size is worth saying rather than
  glossing: the two that looked inert were missing tests.
