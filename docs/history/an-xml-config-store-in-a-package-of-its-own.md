# An XML config store, in a package of its own — how it was arrived at

The review rounds, sabotage passes and by-hand audit passes behind
[packages/config-xml/AGENTS.md](../../packages/config-xml/AGENTS.md). The decisions themselves are
there; this is the record of what each round found, which is kept
because a finding nobody wrote down is one somebody re-discovers.

#### What review round 1 found, and it reviewed a source it had invented

`gemini-4-argon-high`, pointed at the commit with the config house rules handed
over first and the XML section withheld so that it could not simply confirm the
author's reasoning. Its shell was **rejected by its own harness**, so every
finding was reasoned -- it said so -- and the identifiers it quoted are not in
this package: `applyDocument`, `assertXmlCanHold`, `cdataChild`,
`promoteAttribute`, `detectStep`, `makeElement`, `removeChildWithIndent`,
`settingAttributes`, `indentOf`, a `UNSAFE_KEYS` in `represent.ts`, a
`reshape()` doing `text.replace(/\r\n|\r/g, '\n')`. **Zero** occurrences of any
of them, checked by grep. It reviewed a plausible implementation of the
description rather than the code.

And it found **eight real defects anyway**, which is the entry worth keeping
rather than the hallucination: of nine findings, seven were real against the
actual code, two were false, and probing one of its questions turned up an
eighth. Every one was measured here before being believed, which is the rule
this file already records about taking an agent at face value -- and the two
false ones are exactly the two where the invented source and the real one part
company on _structure_ rather than on behaviour.

So the useful statement is not "the reviewer was wrong about the code" but:
**a description precise enough to reason from is enough to find defects in an
implementation the reviewer never read.** Which also says what the brief is
worth, since the brief is all it had.

- **`setLeaf()` left an element's attributes behind, and that one writes a file
  the store cannot read back.** The worst defect in this branch. An element holds
  a scalar or named parts and never both, so one becoming a leaf has to stop
  holding both -- and `{ server: 'none' }` over
  `<server host="h"><port>1</port></server>` wrote
  `<server host="h">none</server>`, which is **mixed content the read refuses**:
  a `save()` whose output is a file the next `read()` throws on. Two more shapes
  of the same cause, each a wrong _value_ rather than a throw: `{ server: '' }`
  over `<server host="h"/>` read back as `{ host: 'h' }`, and an emptied list
  over `<p n="a"/>` read back as `[{ n: 'a' }]`.

  The author's own mutation probe had the leaf-becomes-container case in both
  directions and **no attributes on the element**, which is why 58 cases of two
  properties passed over it.

- **A value holding `]]>` crashed `createCDATASection`.** `data contains "]]>"`,
  which is a DOM error naming nothing -- and the value is perfectly
  representable as escaped text, so refusing it would refuse the format's own
  answer. It falls back to a text node, and what is lost is the author's CDATA
  spelling for that one element. The standard `a]]]]><![CDATA[>b` split keeps it
  and was measured working; it produces three CDATA sections and a file nobody
  wants to read, which is the larger of the two costs.

- **An invalid `Date` passed `canRepresent()` and crashed the write.**
  `new Date(NaN).toISOString()` throws `RangeError: Invalid time value`, so a
  `set()` succeeded and a `save()` threw out of the serializer with a message
  about time rather than about a config. The same call `NaN` already gets one
  branch up.

- **`xmlns` is a name the production allows and the DOM refuses.** It is a
  namespace _declaration_ rather than a name, so `createElementNS(null,
  'xmlns')` throws `NAMESPACE_ERR` -- and `root: 'xmlns'` passed a
  hand-written pattern and wrote a document that will not parse, after which the
  store reported its **own output** as unparseable. The root goes through
  `nameable()` now, which is one reader of what an element may be called. Any
  other `xml`-prefixed name is allowed: the spec reserves them, the parser takes
  them, and they round-trip, so refusing would be stricter than the format.

- **A list of fewer than two at a path nothing declared `multiple` changed type
  on a round trip.** One element or none reads back as a **scalar**, so
  `write({ tags: ['a'] })` with no declaration wrote `<tags>a</tags>` and read
  back `'a'`. Refused, with the message naming the fix -- and the refusal
  looking like it depends on the length of the data is a property of the format
  rather than of the check: a repeat is unambiguous and a single occurrence is
  not. What it means in practice is that **the schema is not optional for a list
  at all**, which is the README's own sentence about `multiple` widened by one
  word.

- **A scalar at a path that _is_ declared `multiple` was a silent no-op.** A
  declared list always reads as an array, so `write({ items: '' })` over an
  `<items/>` that means `[]` compared the element's own `''` against the `''` it
  was handed, found them equal, and wrote **nothing** -- the caller asked for a
  scalar and the file went on saying `[]`. `coerceSetting()` refuses the same
  value one layer up with `Expected a list of values`, so the store's refusal is
  that answer earlier.

- **A new element was spliced in front of an inline comment**, so the comment
  came out on the _new_ element's line. Which is the JSONC writer's own finding
  in a second format, and that entry records why it is worse than losing the
  comment: the file says something **false**. The insert steps over horizontal
  whitespace and comments until it meets a line break or anything else.

- **And probing one of its questions found a list inside a list.**
  `[['a','b'],['c']]` reached the file as `<t>a,b</t>` -- `String(['a','b'])` --
  which is the `[object Map]` silent-rewrite class with a comma in it. The inner
  list is an element's own value and has no path, so it is refused. Found by
  following the reviewer's question about nested values rather than by any of its
  findings.

- **Two findings were false, and both are where the invented source and the real
  one differ structurally.** It predicted a corrupted layout from a newline
  inside CDATA and from a single-line container inside a multi-line document, and
  measured both come out correct -- because the step is only _read_ where there
  is no sibling to copy, which its reconstruction did not have. The newline case
  is a real imprecision rather than a defect and was tightened anyway:
  `multiline()` asks about whitespace-only text holding a break, so a break
  inside a value is content. And it reported an unreachable branch in a
  `promoteAttribute()` that does not exist; the real `writeKey()` does one lookup
  and uses it.

#### What review round 2 found, and what reading its findings cost

Nine findings, four real, one half real and declined, and four invalid -- three
of those quoting code that has never existed in this package, which is round 1's
failure mode repeated despite a brief that said to grep for the text first. A
relaunch of the same round against a clean tree added eight more, of which six
were real. So the ratio across the two rounds is **ten real of seventeen**, and
every one had to be measured before it was believed.

- **The first finding was mine rather than the reviewer's, and it is the rule
  this file already records.** It reported that `reshape()` ignores `shape.eol`
  and quoted `const text = out;` -- which is exactly one of the sabotage
  mutations, because the review ran **concurrently with the pass** and read a
  mutated working tree. AGENTS.md's own entry says nothing else touches the tree
  while a pass is live, written down for a `pnpm fmt` in another terminal; a
  review round is the same hazard with a worse signature, because what comes back
  is a confident finding about a defect you introduced on purpose. It cost the
  whole round its credibility until each finding was re-measured, and the round
  was relaunched against a quiescent tree. The tell was there to read: the
  finding said six tests fail against that line, which is the mutation being
  caught.

- **`push()` and `unshift()` threw on every `multiple` path, and the contract was
  ambiguous rather than simply wrong.** `canRepresent`'s own `@param` says "the
  value about to be written" at "the dotted path it is being written to", and core
  handed over the **item** at the **list's** path. That pair is one no
  path-sensitive store can answer, because `set('plugins', 'a')` and
  `push('plugins', 'a')` hand over the identical one -- so this is the ticket's
  deliverable arriving as its opposite: the interface was not implementable from
  outside for the one thing an XML store has to know. There was a test pinning the
  item, which is what made it ambiguous rather than a defect, and what settles it
  is that asking about the **list** loses nothing: every store's check is a walk,
  so the item is still asked about and is now named at the index it lands at --
  `['a', 10n]` is refused at `plugins.1`. Fixed in core, measured end to end, and
  `#spliceEnd` gained the same question because `pop` validated nothing at all:
  a value the store cannot hold reached memory and the refusal waited for
  `save()`, which is the one thing `canRepresent` exists to stop.

- **The `entity` residual row was unreachable and false-positived, and the module
  said so sixty lines above it.** Its own docblock records that the parser reports
  `entity not found` at the `error` level, so such a document is refused at read
  -- and the row matched `/<!ENTITY\s/`, which an **unreferenced** declaration
  satisfies, so a document the docblock calls fine was reported as losing an
  entity. A self-contradiction inside one file, which is the shape a documented
  codebase is most prone to.

  Measuring it found **six more false positives of the same class**, which the
  reviewer did not reach: every row but one misfired inside a comment or a CDATA
  section. A comment's own text is reproduced verbatim -- measured, `&apos;`,
  `&quot;`, `&#65;` and a bare `>` inside one all survive -- so a row matching
  there names a kind, a detail and a line that send the author to a construct
  with nothing wrong with it. Which is worse than having no table, since the
  table is the whole of what makes the message actionable rather than what makes
  the answer true.

  So each row says which text it is matched against and `contentOf()` blanks
  every comment, CDATA section, processing instruction and DOCTYPE at the same
  offsets, which is the JSONC scanner's own trick. **NEL is the one row matched
  against the raw bytes**, and that is why this is per row rather than one rule:
  a comment holding one comes back holding a newline, so blanking would suppress
  a true positive. The split was measured rather than reasoned -- entities and a
  bare `>` survive a comment, NEL and CR do not.

- **`&quot;` was in the table and in no row.** So a document holding one fell
  through to the unexplained-difference fallback, which reports no line, or was
  not reported at all where another row had matched first. And the weak test the
  reviewer named was true of **all six** `formatting` rows rather than that one:
  every row test asserted `kinds(...).toContain('formatting')`, which is exactly
  what the fallback produces, so each was satisfiable without its row existing.
  They assert the detail and the line now, which only a row can produce.

- **`dropChild()` pulled an inline comment onto the previous element's line**, so
  `<b>2</b> <!-- on b -->` removed left `<a>1</a> <!-- on b -->` -- a file saying
  something false, which this repository calls worse than losing the comment
  outright. What settled the fix was **measuring the sibling store** rather than
  inventing an ownership rule: the JSONC writer leaves such a comment on a line
  of its own, and that writer's own residue entry -- "survives onto the line
  above, so it then reads as the surviving entry's" -- is about adjacency rather
  than about being glued to it. So the two stores really did disagree and this
  was the worse one, and matching it is a consistency argument rather than a new
  rule.

- **A single-quoted attribute's whitespace normalization went unreported**,
  because the `spec` row hardcoded `="`. That is the half of the two an author
  most needs, since it is required of every conforming parser rather than
  cosmetic.

- **The astral range was missing from `NAME_START`** while the comment claimed
  XML 1.0's `Name` production, so a key in Linear B or Gothic was refused.
  `@xmldom/xmldom` takes such an element name and round-trips it -- measured --
  so nothing downstream made the refusal right. Widened to exactly
  `[#x10000-#xEFFFF]`, which keeps `U+F0000` refused: the parser is lenient about
  that one and the production is not, and this is the direction to be stricter in.

- **The store kit's own docblock said it costs "nothing" in bytes** where the
  measurement is 102, and `dist.test.ts` carried the pre-store-kit figure beside
  a comment saying it must agree with AGENTS.md. Re-measured rather than copied
  from either: **32,523 B without the kit and 32,625 B with it**, over the same
  seven modules, which is why the comment says to read it again rather than
  carrying it.

- **And "an empty `wouldLose`" was the fourth copy of a wording this file records
  being fixed three times.** The field is **absent**, so a caller who reads
  `wouldLose.length` off it gets a `TypeError`. One copy was real, in
  `fidelity.ts`; the reviewer's second, in the README, is a **fabricated quote**
  -- that file has one mention and it says `absent`, at the commit the round read
  and at every other.

- **Two findings were half real and are declined with the measurement.** Emptying
  a laid-out document leaves `<config>\n</config>` rather than `<config/>`, which
  is the parent's own layout rather than the child's and loses nothing either way;
  the reviewer's second half, a stray blank line on replacement, is measured
  **false**, because `addChild()` clears the text itself. And a redundant
  promotion test really was redundant, which is the entry below.

- **One invalid finding raised a real question about a guard it had invented.** A
  `clearText()` in `applyInto()`'s object branch was unreachable rather than
  redundant: `addChild()` clears before it reads any layout, and an element that
  read as a scalar has no element children, so that is the branch every insert
  into one takes. Measured over eight shapes of leaf-becoming-container, byte for
  byte identical with it gone, so it is deleted rather than commented.

- **And one of its suggested fixes would have made a good test vacuous**, which is
  why a suggestion is measured like anything else. It asked for the coercion test
  to be driven through `createConfigSync()` rather than handed an already-coerced
  number, and doing that **removes what the test pins**: a `saveSync()` claims only
  the paths this process touched, so the overlay leaves `a` as the file has it and
  the store is handed the file's own string, never comparing a number with a
  string at all. So that claim is a whole-document `write()`'s. The half of the
  finding that was right is the other one -- the store reads a schema for
  `multiple` alone, so a `type` in a test's schema is decoration -- and both halves
  are now tests: the diff's, driven directly, and the three-way merge's, driven
  through a `Config`.

#### What the pass over round 2's own fixes found

Eighteen mutations over the guards the round produced, which is the gap every
round leaves: code written in response to a review is code no review and no pass
has seen. **Fifteen caught and three declared**, after ten survivors -- and the
split between them is the thing worth recording, because four of the ten were the
harness being blunt rather than the code being unguarded.

Then three more over a false positive the probe found that no round did: a `>`
inside a DOCTYPE's quoted **system literal**, or inside a quoted literal in its
internal subset, ended the region at the wrong place and left the rest of the
declaration unblanked -- so the bare-`>` row matched it, and a document with a
real loss reported a second, spurious one at line 1. The same class `contentOf()`
exists to close, one member further out, so a DOCTYPE has no literal closer any
more: `doctypeEnd()` walks it, tracking a quote and treating `[` as entering the
subset. All three caught, and the other direction is pinned too -- what follows
the declaration is content, so a row has to be able to match there.

- **Three mutations were equivalent**, and all three were aimed at `contentOf()`'s
  region table by changing an **opener string** rather than the detection:
  `['<!--', '-->']` to `['\u0000nope', '-->']` leaves `startsWith('<!--', i)`
  deciding and `indexOf('-->', from)` finding the same terminator, so the same
  characters are blanked. Aimed at the `startsWith` instead, all three are caught.
  The DOCTYPE's internal subset needed a sharper **input** as well as a sharper
  mutation: with one declaration in it, a scan that stops at the first `>` leaves
  `]>` behind and the bare-`>` row needs a second `>` before the next `<`, so only
  a subset with **two** declarations tells the two readings apart.

- **Four were a test that could not see what it was named for**, and each got the
  input that separates it. A gap holding a line break, where the removed child has
  no indent of its own -- with one, keeping the gap and keeping the indent produce
  the same bytes, because the two strings are identical. A gap with nothing after
  it. The single-quoted attribute row, which was measured by hand and never
  asserted. And the prefixed attribute promotion, which is the entry below.

- **Three are declared, and two of those are measured rather than reasoned.**
  `blank()` keeping the line breaks changes no answer -- a character is replaced by
  one character either way, so every offset and every `line` is the same -- and
  what it buys is that `content` is line for line `source` for a reader comparing
  the two, and that a row anchored with `^` or `/m` would work, which none is
  today. The cursor advance past a blanked region is a cost guard: what it skips
  has just been blanked, so a rescan finds no `<`. Both were fingerprinted over
  eighteen documents with the guard removed, every report identical.
  `trailingTrivia()`'s content half is the third and is a tripwire: a gap between
  two element children that is not whitespace is mixed content, which the read
  refuses.

- **And the redundant promotion test became the one that covers the branch.** Two
  tests used the same unprefixed document and the same value, and the first
  already asserted the whole serialized string -- while no test promoted a
  **prefixed** attribute, so `writeKey()`'s removal against the attribute's own
  namespace could be dropped with all 203 tests green. The second test is that
  document now, and it also records what the promotion does rather than what
  somebody would guess: the new elements take the **parent's** prefix, which is
  `newElement()`'s rule and is right here, since a promoted key is a new element
  and the setting is identified by its local name either way.

#### Round 3 never answered, and what was done in its place

Two launches, both hung in `cursor-agent`'s own reconnect loop with zero bytes
after twenty minutes and five -- the same failure round 1 survived once. The
second was narrowed to the tests and the prose, which is the technique that
landed round 2 after its full-diff attempts died, and it hung too. So three reads
were delivered rather than four, and what stands in for the fourth is this
repository's own work, labelled as such: weaker evidence than a reviewer's,
because nobody who had not written the code read it.

What it found by applying round 3's own brief:

- **The DOCTYPE false positive** above, which is the only runtime defect of the
  three attempts at a round 3 and came from probing the region scanner's
  adversarial shapes.
- **The packaging claims**, each measured rather than left on the strength of
  having been written -- the entry below.
- **An absence-only sweep over every test**, which is the class a deletion pass
  cannot see: a test that passes because nothing happened. Fifteen assertions are
  an absence and thirteen are the claim itself, each pinned from the other side
  by a positive test the pass catches -- `fidelity: always lossless` makes every
  document lossy and is caught, so "this one round-trips" is not standing alone.
  Two were real: `should write it anyway where the caller said lossy` and its
  sibling asserted `not.toThrow()`, which **a save that silently did nothing
  satisfies just as well**. They assert the bytes now. And
  `should name every export in the README` already guards its own vacuity with a
  `names.size).toBeGreaterThan(1)`, which is the shape the rest should copy.

#### What the PR review round found: an errno and a code unit

Two draft comments on the PR, **both confirmed**, and they are the two halves
this ticket's own reading rounds could not reach: one needed a platform nobody
here runs, and the other needed an input nobody had thought to write.

- **A path under a file is `ENOTDIR` on POSIX and absence on Windows, so the
  non-absence read test pinned nothing on the platform it ran on.** All three
  Windows jobs failed where macOS and Linux were green, which is this
  repository's own signature for the fifth time. `isMissing()` is `ENOENT`
  alone -- reading every error as absence was a real defect in core, found by
  review -- so the test points the store at something unreadable and expects it
  to say so. `ENOTDIR` is that on POSIX; Windows reports a path through a file
  as **absent**, so the store answered `{ value: {} }` and the assertion failed.

  The portable fixture was already in the repository, which is what makes this
  the Conventions rule rather than a new one: core's own test of the same claim
  uses **a directory**, which is `EISDIR` everywhere, and it passes on all three
  Windows jobs. Measured locally at `ENOTDIR` against `EISDIR` for the two
  shapes, and the Windows half is CI's own answer rather than a claim about an
  errno -- the directory fixture throws there and the under-a-file one does not,
  which is the whole of what the test needs to be true.

- **And it turned up a second `isMissing()` call site with no test at all.**
  `store.ts` has two, the sync read and the async one, and only the sync was
  pinned -- which is the pair core keeps a test each for. Both are pinned now,
  and the 1:1 pairing is measured rather than assumed: swallowing every error at
  one call site fails exactly the one test named for it and leaves the other
  passing, in both directions.

- **`contentOf()` mixed code points with code units, so a loss report drifted
  after any astral character.** `Array.from(source)` splits into code points
  while every offset the function is handed -- `i` and `end`, out of `indexOf()`
  and `startsWith()` -- is a code **unit**, so the array drifts one place per
  astral character before a region. Which contradicted the function's own
  standing claim that blanking keeps "every offset -- and therefore every
  `line`". Both halves were measured before anything was changed, and they fail
  differently, which is why there are two tests.

  The blanking lands **past** the region it was for, so the first `D` characters
  of a comment stay visible to the content rows -- and where `D` exceeds the
  comment's own prefix a row matches **inside a comment**, which is the one
  class `contentOf()` exists to close. Twelve astral characters in front of
  `<!--<x></x>-->` is the input, and the row reported the `<x></x>` that is in
  the comment.

  And a blanked astral character collapses to one space, so `content` comes out
  **shorter** than `source` -- measured at 55 against 58 for three of them --
  after which `found.index` indexes the shorter string and
  `source.slice(0, found.index)` names **the line before**. Three astral
  characters inside a comment reported line 3 where the real loss is on line 4.

  `source.split('')` is the fix, which is by code unit: a surrogate half is
  blanked to a space on its own, the lengths stay equal, and nothing can split a
  pair because every region boundary is ASCII. Both tests fail against the old
  spelling and **only** those two do -- 2 failed of 217 -- which is what says the
  drift was unpinned rather than covered somewhere else by luck.

#### What the second PR review round found: the same number, three more times

Two comments, both confirmed by **re-measuring** rather than by reading, and
what they are about is round 2's own fix having reached three of the **seven**
places that carry the figure -- the `config/index.ts` docblock, `dist.test.ts`
and its own entry in this file -- leaving four. Which makes it the **third
consecutive pass** here to find a defect in round 2's own output, after the
sabotage pass over its fixes and the PR round's `contentOf()` code-unit drift,
and the first where the defect is a number copied into more places than anybody
had counted.

- **The published README still said the store kit costs "nothing in bytes".**
  Round 2 corrected exactly that claim in the `config/index.ts` docblock and in
  `dist.test.ts`, and left the one copy a **consumer** reads -- so the package
  docs and the module docblock gave a reader two different answers, which is the
  disagreement this PR says it closed. It costs 102 bytes.

- **And AGENTS.md held the stale pair in _three_ places, not the one the review
  named.** The flagged entry said the graph goes from 32,512 B to 32,614 B; the
  write-half entry said the graph "is 32,512 B"; and the read-half entry said
  32,512 B along with a module size of 22,632 B and a `components.mjs` of
  239,927 B. Fixing only the flagged line would have left the file holding two
  different measurements of one thing, which is the failure mode the comment
  itself describes -- so the sweep is `git grep` for the number rather than an
  edit at the line somebody pointed at.

  Measured rather than taken from the three sources that already agreed, because
  three agreeing copies is still one claim: the shipped graph was **32,625 B over
  seven modules** with the module itself at **22,745 B**, and the same tree built
  in a worktree with the six store-kit exports removed is **32,523 B over the
  same seven** -- 102 bytes, confirmed from both ends rather than from the
  subtraction. `components.mjs` is **240,792 B over 27** and the root entry
  **7,518 B over six**, both measured the same way, which is the only comparison
  that means anything.

- **The running tally of how many times the figure has moved is gone, which is
  the class rather than the instance.** It said "six times now" in AGENTS.md,
  "five times now" in `dist.test.ts` and "moved five times" in the round-2 entry
  -- three copies of a number **nobody can re-derive**, which is precisely what
  the sentence it sits in warns against, two lines after warning about it. A
  tally of re-measurements is a second un-checkable figure guarding the first,
  and it had already drifted. What is kept is the instruction to read it again.

- **Nothing asserts any of these**, which is why they drift: the test holds a
  48 kB _ceiling_, about 2.4x over, so ordinary growth never touches it and
  pulling the parser or the renderer onto the entry does. That is the right
  shape -- a test that pinned the exact byte count would fail on every
  unrelated minifier change -- and it is also why the prose is the only thing
  keeping the measurement, and so has to be swept rather than spot-fixed.

#### The sabotage pass, counted in one run against the final tree

**100 mutations, 95 caught, 5 declared.** One run rather than a sum across
rounds, which is what makes the figure re-derivable: three batches over every
source file, a green control first, and the four verdict guards this repository
has learned to need -- a pattern that matched nothing, one that matched more than
once, a replacement equal to its original, and a run that found fewer suites than
the control, each its own verdict rather than a pass. The harness restores on
`SIGINT` and `SIGTERM` as well as on an exception, because a killed pass that
left a mutation behind poisons the next control.

The five that stay are each declared where they live, and only one of them is a
guard in the ordinary sense:

- `applyInto()`'s **per-key diff**, which is a fast path: every path out of
  `writeKey()` either recurses into `applyInto()`, whose own whole-subtree skip
  asks the same question, or writes an attribute whose bytes serialize
  identically. Measured over an attribute, a nested element, a duplicate spelling
  and a list.
- `lossesOf()`'s tail, where the fallback push makes `out` never empty, so
  `out.length > 0 ? out : []` is an **equivalent spelling**.
- `blank()` keeping the line breaks, which is a **statement**: a character is
  replaced by one character either way, so every offset and every `line` is the
  same. Fingerprinted over eighteen documents, every report identical.
- The cursor advance past a blanked region, a **cost guard** for the same reason
  and over the same eighteen.
- `trailingTrivia()`'s content half, a **tripwire**: a gap between two element
  children that is not whitespace is mixed content, which the read refuses.

What the pass found rather than confirmed is under the three headings above: the
two guards covering for each other in the diff, the no-op write test that
compared bytes which are the same either way, and the four cases where a fixture
could not reach the branch it was named for.

#### What the packaging claims come to, measured

Both review rounds listed the manifest, the `exports` map, the build config and
the turbo wiring as regions they did not examine, so each claim was checked
rather than left on the strength of having been written.

- **The published declaration is two names and no `@xmldom/xmldom` at all**,
  which is what `names.ts`'s structural `XmlNode` and `XmlAttr` are for: a
  parser's types in a published `.d.mts` would be a dependency of every consumer
  that reads the store's signature. Measured -- `dist/index.d.mts` holds `xml()`
  and `XmlStoreOptions` and zero references to the parser.
- **What publishes is four files**: the README, `dist/index.mjs`,
  `dist/index.d.mts` and the manifest, which is exactly what the `exports` map
  names and nothing else. `npm pack --dry-run` rather than reading `files`.
- **Both dependencies stay imports**, so the 12.9 kB bundle begins with four
  `import` statements -- `@ttylabs/sigil/i18n`, `/config`, `/paths` and
  `@xmldom/xmldom` -- which is the call `@ttylabs/cli` already makes about the
  runtime. The `/config` one names **six** store-kit symbols, which is what
  settled the count that docblock had wrong.
- **The build's resolved inputs are complete and the package needs no
  `turbo.json` of its own.** `turbo run build --dry-run=json` reports
  `package.json`, every `src/*.ts`, `tsconfig.json`, `tsconfig.build.json` and
  `tsdown.config.ts` -- which is everything its build reads, since it has no
  `scripts/` and no `sigil.json`. So the root's `inputs` covers it and there is
  nothing to override, which is the opposite of `@ttylabs/cli`'s case and for the
  stated reason: nothing here type-checks as part of its build.

  The tracer the other two packages were audited with says nothing here, and that
  is the method's recorded limit rather than a gap: `tsdown` is rolldown, which is
  native, so its reads do not go through node's `fs`. The dry run is the evidence.

- **A symlinked config is written through and a dangling one has its target
  created**, which is the one place this store's use of `writeAtomic()` is
  observable -- the path it hands over. Both are defects core's own PR rounds
  found and fixed, both are a dotfile manager's ordinary state, and the comment
  in the file survives the write either way. The mode is kept too, asserted
  everywhere but Windows, where `chmod` only toggles the read-only flag.
