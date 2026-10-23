# Translating: the English is the key — how it was arrived at

The review rounds, sabotage passes and by-hand audit passes behind
[packages/sigil/src/i18n/AGENTS.md](../../packages/sigil/src/i18n/AGENTS.md). The decisions themselves are
there; this is the record of what each round found, which is kept
because a finding nobody wrote down is one somebody re-discovers.

##### What walking the hostile inputs found, which no test had

- **A half's first code point has to be a key somebody can press**, which is one
  input class the "names two distinct keys" rule did not cover. A combining mark
  and a control or format character are each a code point a terminal sends no
  keystroke for -- and the mark is worse than useless, because it attaches itself
  to the `(` the hint opens with: `´a/n` drew `(́a/n)`, whose first half
  advertises `a`, which is not the key. `/[\p{C}\p{M}]/u` on the key refuses both
  and English stands. Measured to separate cleanly from every real key there is:
  `y`, `は`, `👍` and `ß` all pass it, which the second of that guard's two
  sabotages pins -- a version that refused letters as well would refuse
  everything, and asserting only the refusal would not see it.

- **The capital is applied only where pressing what is shown sends the key**, and
  two mappings fail that. A one-to-many uppercase -- `ß` is `SS`, `ﬁ` is `FI` --
  would draw `(SS/n)` over a key of `ß`, so a reader presses `s` and nothing
  happens. And the Turkish dotless `ı` upper-cases to `I`, which is **one code
  point** and still the wrong one, because `I` lowercases to `i`: the glyph on
  screen sends a key the prompt does not read. So the guard is a _round trip_
  rather than a length check, which is the half that catches the second. Both
  leave the half as written, which marks nothing and lies about nothing -- the
  lesser of the two, and the one this file's rule about a hint that lies picks.

- **And two comments were false about the code beside them.** `keyOfHalf()` gave
  the Turkish _uppercase_ hazard, `i` to `İ`, for a function that **lowercases**
  -- where the hazard is `I` to the dotless `ı`, which is what a reader checking
  the comment would have found backwards. And the width comment said the hint
  survives to 14 columns where the measurement and the test both say 13. Neither
  was reachable by a sabotage, which is the boundary this file already records:
  a pass built out of deletions cannot read prose.

- **The demo prints the vocabulary rather than prompting for it**, so the one
  mechanism is demonstrable in a demo that still needs no terminal and that
  `demos.test.ts` drives -- `confirmKeys()` is a function of a catalog entry.
  `demos/i18n/01-translating.js` shows all four rules at once: `(J/n)` from
  `j/n`, `(Tak/nie)` from `tak/nie` with the key still `t`, `(はい/いいえ)` with
  the key `は`, and Polish naming `n` once rather than twice.

- **And the palette had three affordances the inventory missed, because the
  inventory read `prompt.ts`.** `commandPalette()` is not one of the six prompts
  and it borrows `runPrompt()` and draws its own: `Run a command`, `No commands
  match`, and the `(skip)` entry an optional `choices` list offers in place of a
  value -- which is a _prompt_ affordance, since the palette passes it to
  `select()`. Leaving them is the English-in-the-middle-of-German this whole
  feature is about, so they are three more keys and the count is **55**.

  `(skip)` was a module-scope `const` and is a function now, which is the thunk
  rule met one layer along: a `const` there is evaluated when the module is
  imported, which for a component is before `main()` has loaded a catalog. The
  sabotage that makes it eager again is caught, so the per-call lookup is load
  bearing rather than tidy.

##### What the sabotage pass found

Forty-one mutations, one at a time with the four affected suites run after each,
against a green control. **All forty-one are caught**, after two survivors that
were each a fixture too easy to reach the branch it was named for -- which is the
shape this file keeps recording, and both were found by the pass rather than by
review.

- **An astral _emoji_ cannot show that `capitalize()` reads a code point.** It has
  no uppercase mapping, so upper-casing its leading surrogate and rejoining gives
  the original string back and both readings agree. Deseret has one: `\u{10428}`
  upper-cases to `\u{10400}` by code point and to itself by code unit. The
  consequence is cosmetic -- a hint that fails to mark its default, with the _key_
  unaffected, since `keyOfHalf()` is separate and separately pinned -- and it is
  pinned anyway, because the guard is there.

- **Three choices on a ten-row screen cannot show that `lines` counts the tail.**
  There is slack either way, so nothing overflows and the window being one row too
  generous changes no picture. Eight choices at 30 columns is where it bites:
  measured, **eight drawn where seven fit**, filling the screen edge to edge so an
  error would have had nowhere to go. The assertion is `head + shown < rows` --
  the row kept back for the error line is still there -- with `head > 1` beside
  it, or the fixture is not reaching a wrapped hint at all.

Two of the thirty-one are the width decision's own two directions, and each fails
exactly the test named for it: reserving nothing fails `should keep the hint whole
where the message has to wrap for it`, and reserving the tail in full fails
`should not flatten the question to reserve a long hint`. So the cap is pinned
from both sides rather than only against the defect it was written for.

##### What the second review round found, and it was all prose but one

Pointed at what round 1's brief did not name -- the tests, the prose, the prompts
that were _not_ the subject, the public surface and the toolchain. It confirmed
every one of those regions clean: `text()`, `password()` and `select()` read back
to the old `avail - 1` formulas with `tail = ''`, the public surface is the right
subpath with nothing extra exported, the extractor needs no special case, and the
twelve/three/three/55/2/13 figures all check out. Which is the pattern this file
already records: a round aimed where nobody looked finds **six** things, and five
of them are sentences.

- **Round 1's own fix was applied in one place and not the other.** `pairKeys()`
  was corrected to say the hint is built from the **halves**; `confirmKeys()`
  still said "built from the keys", and so did this section. That is the sentence
  that hid the decomposed case, so leaving a copy of it is leaving the thing that
  would put the defect back.

- **And the Turkish direction was fixed in the code and not here.** The comment on
  `keyOfHalf()` names `I` to the dotless `ı`, which is the hazard a function that
  _lowercases_ has; this section still named `i` to `İ`, which is the uppercase
  one. The section is what a later change gets aligned to, so the file being the
  wrong one is the worse way round.

- **Two consecutive sentences about one comment contradicted each other.** "its
  comment now names 6.8 rather than 4.1" sat directly above "It is **7.5 kB**
  since SIG-135" -- and the same diff had already changed that comment to 7.5. The
  first half was false in the commit that updated it.

- **`keyLabel()` claimed there is no test for a bare name**, and the modifier test
  has an `f2` case whose own comment cites the claim. "Cannot fail" is fair about
  the assertion that is missing; "no test" invites deleting the case that is there.

- **And one of the new tests was in the wrong file.** `should not read a modified
  key as an answer` never loads a catalog, so it would survive deleting every `__`
  in the prompts -- the one case in `prompt-i18n.test.ts` that did not depend on
  the feature that file is for. It is beside `confirm()` in `prompt.test.ts` now.

- **The one that is not prose: `sigil check` cannot see a malformed `y/n`.** It
  compares key _sets_, so `"y/n": "ja oder nein"` is a present key -- the runtime
  refuses it and draws English, and the build says nothing. `y/n` is the **first
  key whose value has a grammar**, which is why this is new rather than the
  already-recorded silence about a wrong-shaped value.

  Recorded rather than fixed, because checking it well needs the runtime to _say_
  it refused -- a field on `ConfirmKeys`, or a predicate beside it -- and every
  cheaper test is unsound: comparing the result against English cannot tell a
  refusal from an entry that really is `y/n`, and looking for the entry's halves in
  the hint passes a decomposed `é/n`, whose fallback hint contains `n`. A field on
  a published type, or a second reader of the grammar, is a change to what
  `sigil check` promises taken inside a prompts ticket -- the same call this file
  records for narrowing the toolchain's type check inside a caching ticket. What it
  costs is a `DEBUG=sigil:i18n` line instead of a build warning.

##### And the harness left a mutation in the tree, which is a trap of its own

Four of this feature's patterns went stale as the code under them moved, each
reported as `PATTERN MISSED` rather than as a pass, which is the guard this file
already records working. The new one is worse and is about **killing** the pass:
the restore is in a `finally`, and a `SIGTERM` does not run one -- so a
`pkill -f sabotage.py` left `keyLabel()`'s `ctrl-alt` mutation sitting in the
working tree. Two ways that costs something, and the second is the dangerous one:
it reads as a real defect to whoever looks next, and it poisons the **control**
of the following run, which then reports `FAILING ALREADY` about a tree nothing
is wrong with. Caught here only because `git status` was read before anything
else was believed.

So a harness that mutates a checkout restores on a signal as well as on an
exception, and the first thing to do after one is interrupted is `git status`.
Writing it down because the lesson is about the _tool_ rather than about the
code, which is the category this file keeps finding things in.

##### What the first review round found, and the one thing it got wrong

Pointed at `confirmKeys()`'s hostile inputs, the additive logic, `headWidths()`'s
arithmetic, the comments and the tests. It confirmed the collision logic across
all four combinations, the `ß`/`ı`/`ﬁ` refusals, the fallback table and the
`avail <= 2` clamps -- and found **three** real things plus one claim that was
wrong, which is the ratio worth recording rather than the count.

- **A half whose first _glyph_ is more than its key**, which the lossy-capital
  guard did not reach because the round trip it checks is on the first code
  point. A decomposed `e\u0301/n` has a key of `e` and draws `(É/n)`, so a reader
  pressing the É key sends the precomposed `é` and nothing matches. Making the
  key the whole cluster is not the fix and could not be: `readOne()` decodes a
  keystroke by code point, so a two-code-point key could never match anything. So
  the half is refused and English stands -- the entry above about a catalog
  writing its pair in the form the keyboard produces, promoted from a recorded
  limitation to a guard, because the _hint_ was the half that was wrong rather
  than the keystroke.

  The rule is asked as **`NFC`** rather than as "is the next code point a mark",
  which is the approximation it started as and is too broad by two cases that are
  not lies: an emoji with a variation selector draws the same glyph its base code
  point is the key for, and a flag's two regional indicators have no precomposed
  form at all, so pressing one sends the first indicator -- which is the key. Both
  are accepted and pinned, and only a half whose first glyph really has a
  one-code-point spelling is refused. Which is also the rule said exactly rather
  than approximately: what makes the É case a lie is that the precomposed form is
  the one a keyboard sends.

- **A comment that was false about the line beside it**, and it is the one that
  made the defect above look impossible: `pairKeys()` said the hint is "rendered
  from the keys rather than parsed back out of a string, which is what makes 'the
  hint is the keys' true by construction". It is rendered from the **halves** --
  `(Ja/nein)` draws a whole word and the key is `j` -- so what holds by
  construction is narrower, and saying it loosely is what hid the É case. Which is
  this file's own warning met exactly: the written rule is what stops the reader
  checking.

- **An orphaned JSDoc.** `ENGLISH_PAIR` and its doc were inserted _between_
  `ConfirmKeys`' doc comment and `ConfirmKeys`, so the interface had no
  documentation and the const had two. An editing slip, invisible to every test.

- **And an integration case that did not pin its own name.** `should still accept
  y and n, which no hint has to name` had been fixed once already, to a `j/k`
  catalog so that neither English key is the entry's -- and it still only pressed
  `y` and `n`, so reverting `confirm()` to a hardcoded `ch === 'y'` passed it. The
  catalog did no work. It presses `j` and `k` as well now. Twice wrong in the same
  test, each time caught by somebody reading what it asserts rather than what it
  is called.

**What it got wrong is worth as much**, because a review is a set of claims to
check rather than a list of fixes. It reported that `should window the list
against the head it drew` is half vacuous -- that `head + shown < 10` still holds
with `lines` ignoring the tail, since 1 + 8 is 9. That conflates `lines` with the
head the test **measures**: `head` is `findIndex` over the drawn log, which is 2
rows whatever `lines` answered, so the sum is 10 and the assertion fails. Verified
by running that one mutation against that one test: caught, `expected 10 to be
below 10`. It also reported a bare combining mark as accepted, which was true of
the diff it was given and had been fixed two commits before the review returned.
