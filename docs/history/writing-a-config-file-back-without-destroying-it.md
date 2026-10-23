# Writing a config file back without destroying it — how it was arrived at

The review rounds, sabotage passes and by-hand audit passes behind
[packages/sigil/src/config/AGENTS.md](../../packages/sigil/src/config/AGENTS.md). The decisions themselves are
there; this is the record of what each round found, which is kept
because a finding nobody wrote down is one somebody re-discovers.

#### What the sabotage pass found, and the two declared survivors

Fifty-six mutations, one at a time with the config suites, the toolchain's own
config tests and `dist.test.ts` run after each. **Fifty-four caught and two
declared**, counted against the shipped tree in one run rather than summed
across rounds, with a green control first and the four verdict guards this
repository has learned to need -- a pattern that matched nothing, one that
matched more than once, a replacement equal to its original, and a run that
found fewer test files than the control, each its own verdict rather than a
pass. The tree is restored on `SIGINT` and `SIGTERM` as well as on an
exception, because a killed pass that left a mutation behind poisons the next
control and reads as a real defect to whoever looks next.

- **Three guards were deleted for being unable to change an answer**, and the
  third is the interesting one. `lineStartAt()`'s `Math.min(offset,
  text.length)` cannot fire, because every caller hands it a span of the text it
  was given. `apply()`'s `touched.clear()` before it adds the whole-layer marker
  cannot either, and that is provable rather than measured: with `''` in the set
  the value `save()` writes **is** that layer's, so applying any path of it over
  itself is a copy of an equal subtree. And `same()`'s structural comparison --
  the array walk and the plain-object walk -- was dead in **every** branch,
  because `node.kind` and `current` agree by construction: the node was scanned
  out of the same text `JSON.parse` produced the value from, so two plain
  objects or two arrays go to `diffObject()` and `diffArray()` and never arrive
  there. What is left is `a === b`, which is also the safe direction to be narrow
  in: this is what decides "no edit", so a comparison that could answer `true`
  for two different structures is the one answer that silently keeps a stale
  value.

- **And a fourth was deleted after the sabotage explained why it was dead -- and
  round 5 put it back, which is the sharpest thing either pass produced.** The
  insertion had a branch for "a comma already follows the last entry", which put
  the new member after that comma and appended a trailing comma of its own so the
  user's style survived. It was deleted as unreachable on the argument that
  `commaAfter()` reads the **blanked** text, where a trailing comma has been
  blanked out, so the only comma it could find is one that is not there --
  measured at the time, with and without it, over a multi-line object, a
  single-line one and an array: byte for byte identical.

  **Both halves of that argument had stopped being true, and the deletion is what
  made it visible.** Review round 1 taught `commaAfter()` to read `ctx.trailing`,
  precisely so an emptied container would stop leaving its trailing comma behind
  -- so it finds one now. And a comma after the last _kept_ entry is not trailing
  at all when the entries after it are being dropped in the same write: that one
  is a **separator**, which was never blanked. So the branch was reachable from
  the moment round 1 landed, and what stood in its place anchored the insertion at
  the value whatever followed it -- which is the defect under "Writing a config
  file back without destroying it".

  The byte-for-byte measurement was sound and said less than it was read as
  saying: it was taken over inputs with **no comment** after the last entry, where
  anchoring before or after the comma produces the same string. That is the
  fixture-too-easy shape this file records about a sabotage verdict, arriving in a
  differential rather than in a test -- a measurement is a statement about the
  inputs it was taken over, and three shapes of object is not the same as the
  grammar.

- **Eight survivors were a test that could not reach the branch it was named
  for**, and each got the input that makes it matter. The sharpest is the
  insertion anchor: `should take a removed key off with its own line` and
  `should take one comma per removal` are all removals with no addition, and
  `should write valid JSON where every key is replaced` drops _every_ key -- so
  the one shape that reaches "a kept entry, a dropped tail, **and** a new key"
  was missing, which is exactly the overlapping edit the anchor rule exists for.
  Then: a comment between a value and its **own** comma, which is one input for
  two guards -- reading the source for the comma finds none and leaves a
  dangling one, and swallowing the gap eats the comment. A closing brace on the
  last value's line. An escaped **quote** inside a string, where the escaped
  `\n` the suite already had agrees in both readings because neither is a
  quote. A `pop()` persisted. And the file mode, which needed **four** modes
  rather than one: the mode the `open` asks for goes through the umask and the
  `chmod` after the close is the one that does not, so at `0o600` under the
  usual `022` the open already gets it right and a test of that alone says
  nothing about the chmod.

- **One guard is root-only and is declared rather than tested**, with the half a
  test can see pinned instead. `sudo mycli config set` leaving a config its
  owner can still edit is a claim no non-root run can make -- a `chown` to your
  own uid succeeds and changes nothing, so the mutation is invisible either way.
  What `atomic-temp.test.ts` asserts is the other direction: a non-root save
  attempts **no** `chown` at all, which is the half that would otherwise fail
  over a file it was going to write correctly.

- **The two declared survivors are both bounds rather than behaviour.**
  `serialize()`'s refusal of a value `JSON.stringify` answers `undefined` for is
  a tripwire `canRepresent()` reaches first, kept for the reason
  `clipboardSequence()`'s own unreachable assertion is. And `lineTriviaEnd()`'s
  `i >= limit` is an **equivalent** guard rather than a dead one: the character
  at `limit` is the closing brace, and the fallthrough at the bottom of that
  loop returns `from` for one anyway -- so deleting it changes no answer, and it
  is kept because a scan that walks to a limit should say what the limit is
  rather than leave a reader to notice that a brace happens to stop it.

- **And a finding about the README test rather than about the code, which is the
  one the sabotage pass could not have produced.** The README shows the file a
  `set('server.port', 9090)` leaves behind, and the test read that block **out of
  the README** -- which is the right direction, since a block quoted in a comment
  is a copy nothing compares. It then derived the _input_ from it by putting the
  port back, which made the whole thing a tautology: any change to the block
  moved both sides together. Measured over five sabotages of the README's own
  block, **four of five survived** -- a reflowed port line, a dropped trailing
  comma, a comment moved onto its own line, and the leading comment deleted --
  and only "the port was not written" was caught.

  The one arrangement that says something is the **expectation** read out of the
  README and the **input** written in the test: the input is a copy of nothing,
  so it has nothing to drift from, and the README's block is then a claim about
  what the writer produces rather than about itself. All five are caught that
  way. Which generalises past this file: reading an expectation out of the
  document under test is sound, and deriving the input from the same place is
  how that becomes a test of nothing.

- **And one hazard the harness itself met, which is worth the entry because it
  is about the tool.** A `pnpm fmt` run in another terminal while the pass was
  mid-mutation reformatted a mutated file, six tests failed over a mutation
  rather than over the code, and `git status` showed a file modified that
  nothing had been written to. Nothing was lost, because the restore is in a
  `finally` and ran; what it cost was five minutes of reading a failure that was
  the harness's. **Nothing else touches the tree while a sabotage pass is
  live**, which is the same rule two writers on one output file already have.

#### What the first review round found, and two of them wrote invalid output

Pointed at the write half with the ticket's requirements and not the rationale.
**Ten findings, every one confirmed against the code before anything was
changed** -- two of them a wrong file on disk, one a guard wider than its own
comment, two comments false about the line beside them, and two tests that could
not fail for the reason their names gave. The shape is the one this file keeps
recording: a round pointed at a diff finds the guards that are **missing** rather
than the ones that are dead, which is the half a sabotage pass is blind to by
construction.

- **Emptying a container with a trailing comma wrote invalid JSON, and the
  comment explaining why it could not was the thing that hid it.** The removal
  entry says a container being emptied "takes every comma in it forwards, where a
  rule about no survivors either side would leave a dangling one and write
  invalid JSON" -- which is true of a **separator** comma and was false of a
  **trailing** one, because a trailing comma is **blanked** by the scan. So
  `commaAfter()` walked over it as whitespace, found nothing, and the entry was
  removed with the comma left behind: `{ "a": 1, }` came out `{ , }`, `[1,]` came
  out `[,]`, and this scanner then refuses both as elisions. Measured on five
  shapes before anything was written.

  The fix is the scan reporting **where** they are, because nothing else can tell
  them apart: blanked, a trailing comma is a space to every walk over
  `ctx.blank`, and watching `ctx.source` instead is no answer either, since a
  comma inside a comment is a comma there too. So `JsoncScan.trailingCommas`
  became `trailing: number[]`, which cost two tests and one fuzzer counter --
  the boolean had exactly three readers, which is what made the widening cheap.

  **And `pendingComma` is not a source offset**, which is the trap inside the
  fix and cost one run to find: `out` holds **chunks**, because a string is
  pushed whole, so `out.join('')` is 1:1 with the source and `out`'s own indices
  are not. The comma of `{"a":1,}` reported as offset 4 rather than 6. The two
  numbers are carried as **one value** so they cannot come apart, which is what
  this file keeps choosing over two variables and a reader who has to prove they
  agree.

- **`save()`'s re-read bought nothing, because the store then diffed the whole
  document against it.** This is the sharper of the two, and the contract it
  breaks is `save()`'s headline: "a path this process wrote is a path that wins,
  and every other key in the file is left exactly as the file has it". A store
  handed a whole document and nothing else can only diff the whole of it, so a
  key **another process** changed between `save()`'s read and the store's own was
  **reverted** -- any key, including every one this process never touched, for as
  long as the save took. Measured: `b` added in that window was removed, and `a`
  changed in it was put back to what the first read saw.

  So the window was the same width as a blind write's and the re-read was spent
  on nothing, which is why `WriteOptions.paths` is the fix rather than narrowing
  the claim. A caller says which dotted paths are its own and the store applies
  those to what it reads, leaving every other key alone. It is **additive and
  optional** on an options object, which is the one shape that does not break
  every implementor -- the reason `ConfigStore` was drawn whole in the read half
  is that adding a required method to an interface cannot be softened by a
  default, and an options field can.

  `save()` passes what `set()`, `delete()` and the array methods recorded, which
  is **exact** rather than a reconstruction. A three-way merge computed from a
  `base` document was the other candidate and is a _guess_ at the same answer: it
  cannot tell a `set()` to the value a key already held from no `set()` at all,
  and `touched` can. `apply()` passes **nothing**, which is that method's own
  replace-rather-than-merge rule reaching the one place that can honour it -- and
  is why the claim is `undefined` rather than every path.

  `overlay()` is the one implementation of what a claimed path means, shared by
  `#staged` and the store, because the two are the two halves of one save and two
  copies of that loop is how they come to disagree.

- **The test for that claim could not see the window, and nor could the three
  written for the fix until the fixture was corrected.** The existing one writes
  the other process's key **before** `save()`, so the re-read already holds it --
  which is a real case and is the before-the-read half. The new ones interpose on
  the store's `read()`, and the first version fired on the **first** read, which
  is `createConfig()`'s: the concurrent write landed before the read the merge
  stages against, so all three passed with the claim removed. Firing on the
  **second** is what reaches the window. The fixture-cannot-reach-the-branch
  shape, in the tests written for the finding about it.

- **`statOf()` read every error as "the file is not there", under a comment
  saying it was for a file that is not there.** So an `EPERM` or an `EIO` on the
  target made `keepOf()` treat it as new: the mode was not carried, the chmod of
  the previous mode was skipped, and a `0o600` config came back world-readable --
  silently, with the open that follows very likely failing anyway but saying
  nothing about what went wrong. Only `ENOENT` is nothing now, and `isMissing()`
  is one predicate shared with the store's own read rather than two.

- **The `fsync()` catch was wider than the documented set, which is the whole
  point of flushing.** AGENTS.md names `EINVAL` and `EPERM`; the `catch` was bare.
  An `EIO` or an `ENOSPC` out of `fsync()` says the bytes may **not** be on disk,
  which is the truncated file this module exists to prevent arriving by the one
  road it was meant to close -- so those are raised and five are swallowed, each
  a filesystem declining the operation itself. Pinned from both sides: a declined
  flush still writes, and a failed one throws and leaves no temp file.

- **A sparse array threw a `TypeError` out of the one function whose job is to
  name what cannot be written**, which is worse than the round expected -- it
  predicted a silent pass. Every array method skips a hole, so
  `[1, , 2].map((it, i) => [...])` answers a _sparse_ array and the walk
  destructured `undefined`. `JSON.stringify` writes a hole as `null`, which is
  the same silent rewrite `NaN` gets and is refused the same way; the walk is by
  index now, and the test pins the refusal against what `JSON.stringify` really
  does rather than against a sentence.

- **A `\r`-only document got a `\n` spliced into it.** `LINE_END` is written for
  exactly this -- "a `\r`-only file is rare and the failure is **silent**, which
  is the combination worth spending four characters on" -- and the one place that
  _writes_ a line rather than reading one had two cases where it needed three.
  U+2028 and U+2029 are declared out: they end a line to every reader worth
  agreeing with and nothing writes a document in them, so inserting a `\n` into
  one is the subset this claims to be rather than a lost case.

- **Two comments in `config.ts` named the new extension where they meant the
  old one.** A bulk prose replace over the rename hit the two sentences whose
  subject was the `.json` file, so each said the new name twice and neither said
  anything true. The body was right in both places, which is the direction that
  catches somebody aligning the code with the comment. The lesson is the replace
  rather than the sentences: a rename done over prose by substitution hits the
  sentences that are _about the other thing_, and those are exactly the ones a
  reader trusts. Both are gone, along with the rename itself -- so the finding is
  recorded here without quoting them, because four occurrences of a dead filename
  in this file is the thing somebody greps and has to rule out.

- **And one test's name promised something it never did.** `should keep the space
  before a closing brace it emptied on one line` never empties a container, so it
  could not have caught the first finding however the name reads. Renamed to the
  claim it makes -- the container padding a removal did not own -- with the
  emptying cases beside it.

Two things the round reported and got **wrong**, which are worth recording
because a review is a set of claims to check. It said the second read "is
required for offsets" -- it is not: a cache would not splice at the wrong
offsets, because the edits are computed against the same text they are applied to
and the result is written whole. What a stale cache does is overwrite blindly,
and the comment in `file.ts` giving offsets as the reason was false in exactly
that way. And it listed a redundant test as worth adding, which was written and
then **deleted**: an `apply()`-in-the-window case fails to the same two sabotages
the pre-existing `apply()` test fails to, so it added nothing.

#### What the first round's own fixes cost, measured

Eighteen sabotages over the new guards, **all eighteen caught** after three
survivors. Each survivor was a missing test rather than dead code, and each is
one the pass could name only because the guard it was aimed at had just been
written: `writeSync()` dropping the claim, which nothing drove synchronously;
`statOf()` swallowing everything, which needed `statSync` made to throw; and
`render()` validating `value` rather than the merged document, which is reachable
only from a **direct** `write()` with a claim, because `set()` checks each value
on the way in.

Two of the eighteen are inverse pairs, which is what makes the claim two-sided
rather than one: `paths` claiming _everything_ fails the `apply()` test where
claiming _nothing_ fails the window tests, and `FLUSH_DECLINED` gaining `EIO`
fails only the new test where emptying it fails only the old one.

#### What the second review round found, and it was all prose and tests

Pointed at the files round 1 listed as **not examined** and told not to re-derive
its premises. It found **no runtime defect in the ten regions round 1 had read**,
and nine findings in the ones nobody had opened: one interface doc that was false
about the field it documents, two tests that could not fail for the reason their
names gave, a copyable fence missing the field a store must honour, a README
example whose flag is inert, and four stale names. Which is the distribution this
file records three times over -- a premise-attacking round confirms, and the
findings come from what nobody opened.

Three of the four stale names had been corrected independently while the round
was running, by sweeping every `sigil.json` in the tree for a present-tense
claim. Worth recording as corroboration rather than as duplication: two routes to
one finding is the strongest evidence either produces, and the sweep is what found
the one the round found too.

- **`Loss`'s own doc said "empty" where the field is absent, which is the fourth
  copy of that wording.** This section already records fixing it in three places,
  and missed the one a **store author** reads: a store aligned with that sentence
  answers `[]`, and then `layer.wouldLose?.length` -- which the README tells every
  caller to use -- is a lie the other way. `layer.wouldLose.length` is a
  `TypeError` today, and the doc said it would not be.

- **`should take lossy per layer the way the README spells it` could not fail,
  and the README example it quotes is why.** Both used a `jsonc()` store, which
  never reports a loss -- so `#assertLossless()` returns at `losses.length === 0`
  before it ever reads `layer.declared.lossy`, and deleting the flag left the test
  green. The README's own prose says it two paragraphs up: "the file stores in here
  never trip it". So the example names `reprinting(path)` now, with a sentence
  saying that `lossy` on a `jsonc()` layer is a flag nothing reads, and the test
  drives a store that really does report one -- asserting the refusal **without**
  the flag beside the write **with** it, which is what makes the flag the thing
  under test.

- **`should mix an option with a setting the way the README says` did not mix.**
  It asserted that a defaulted setting reads back as a number and **built no
  option at all**, so it could not fail if the mixing were broken -- while the
  README's claim is about the _chain_: "argv, then env, then config through the
  chain that already exists". It goes through a real `parse()` now, at all three
  steps, which is the one shape that can see it.

- **The `ConfigStore` fence says it is "drawn whole" and named `WriteOptions`
  without showing it.** So a third-party store copied from the block stops at
  `lossy` and ignores `paths` -- which is round 1's revert-another-process's-key
  defect reintroduced in somebody else's store, by a reader doing exactly what the
  README invited. The fence shows it now, and `should draw WriteOptions whole`
  reads the **real** type's fields so a field added without a fence entry fails
  rather than going quiet.

- **`WritableConfigStore.write()`'s doc stopped at "the whole value".** True and
  incomplete after `paths`: a store author who reads only the first sentence
  ignores the option. It names it and says to read it.

- **Six exported types were in neither the prose nor the catalog** --
  `ConfigLayer`, `ConfigLayerInfo`, `ConfigMerge`, `ConfigOptions`,
  `ConfigSchema`, `ConfigSetting`. An exported type is API an app writes into its
  own signatures, and one nobody can find is one nobody uses. The **class** is
  closed rather than the instance, which is the testing helpers' own answer:
  `should name every export in the README` reads the barrel, so a name added
  without a sentence fails there.

- **`Schema.defaultLocale`'s doc and an i18n test still named `sigil.json`**, and
  the first is live public API on the runtime package -- the one place a reader
  meets the toolchain's config file through completion.

- **And the diagnostic sentence in AGENTS.md was wrong rather than stale**, which
  is the one of the four that is a behaviour claim: it said "the layer, which the
  toolchain calls `sigil.json`", where `configLayer()` names the layer after
  **whichever of the two files it found**. Somebody aligning the diagnostics with
  that sentence reverts the rename on the common path.

Its "Unsure" section was empty, and the one thing it put there instead is worth
keeping: `cli.test.ts`'s `reads` table names only the one of the two config file
names that is **on disk** while `packages/cli/turbo.json` hashes both, and that is
**not** a hole, because `should hash every file a build command reads` is
presence-only `toContain` -- omitting the other fails nothing, and turbo's
resolved inputs cannot hold a file that is not there anyway. A correct reading of
a non-hole is as much of a result as a finding.

Six sabotages over the fixes, **all six caught**, each by exactly the test named
for it -- after two survivors that were the same shape as the findings: the
per-layer README line was quoted in a **comment** rather than read out of the
README, and nothing asserted the fence names `WriteOptions` at all. The
quote-check in that file is an explicit list, which is why a line can be missing
from it; the list is what the sabotage grew.

#### Reading the two rounds' own guards, which nobody had

Code written in response to a review is code no review has seen, and that gap
grows with every round. This is a pass over it -- the trailing-comma offsets, the
claimed paths end to end, `statOf`, `declinesFlush`, the hole refusal, the
three-case `eol` -- plus the test bodies round 2 said it had not read. **It is
this repository's own work and is labelled so**, which is weaker evidence than a
reviewer's: nobody who had not written the code read it.

What it found is **three** things, and the first is the sharpest kind there is.

- **The claimed paths falsified a sentence two paragraphs below the one they
  were documented in.** `save()`'s doc said that a layer coming back holding keys
  it did not hold before "is the file being right about itself, and the
  alternative -- a view that disagrees with the bytes just written -- is the worse
  of the two". With the claim, the view _does_ disagree: the layer is read #1 plus
  this process's changes and the file is read #2 plus them, so `get('b')` answers
  `1` over a file that says `99`. Measured, which is how it was found.

  It is the better trade rather than a regression, and that is the part worth
  keeping: the agreement it gave up was bought by **reverting** that other
  process's key, which is the defect the claim exists to fix. Closing it needs a
  third read to re-stage the layer from, and a third read only moves the window.
  So the honest statement is that a save leaves the layer as stale about somebody
  else's keys as the read it started from, and the next run is where the file is
  read again. Pinned, because a reader who "fixed" it would re-read and think they
  had closed something.

  The shape is the one this file keeps warning about and it happened **inside the
  fix for a review finding**: the paragraph above it was rewritten and the one
  below was not re-read.

- **A claimed path replaces a non-object ancestor the file holds, and `set()`
  refuses one.** `set('a.b', 9)` where this layer's own `a` is a scalar is
  `"a" in user is not an object`; where the **file**'s `a` became one in the save
  window, the overlay wrote `{ b: 9 }` over it. This pass called that asymmetry
  **right** -- at `set()` the caller is there and can fix it, and at save time
  refusing fails a save over somebody else's edit while dropping the claim loses
  this process's write in silence -- and documented it as a decision.

  **That was wrong, and the round below overturned it.** Its input has no
  concurrency in it at all, which is the thing this probe missed by reaching for
  the save window: one direct `write()` with a claim destroys an array, and a
  refusal is actionable where this argument assumed it was not. The entry below
  has it; what is kept here is that a narrower probe of the right mechanism can
  turn a defect into a recorded decision, which is the one failure mode a pass
  by the code's own author has that a round does not.

- **The fuzzer could not see a wrong offset at all.** It is the only exhaustive
  check on the scanner and it asserts `JSON.parse(scan.json)`, which is the
  _blanking_ -- so the field round 1 added was checked by three hand-written cases
  and nothing else, and the span writer is its only reader, which makes a drift
  there an invalid file rather than a failing test. It asserts the property over
  all 400 documents now: every reported offset is a comma in the **source** and a
  space in the **blanked** text.

  Those two are not one assertion, which took a sabotage to establish. `+1` on the
  offset fails the source half and **passes** the blanked half, because the
  character after a trailing comma is usually whitespace, which is a space in both
  -- so with the source check removed the off-by-one survives 400 documents. The
  first mutation aimed at it was reported SURVIVED and that was the harness being
  blunt rather than the line being dead, which is the boundary this file records
  for `FLUSH_DECLINED` and for the iris.

And what it checked and found **right**, which is most of it. Ten degenerate
`paths` inputs: an empty list, an empty string, a path absent in the value, one
whose parent in the value is a scalar, an unsafe key, an inner empty segment, an
array index, and a claim over a file that does not exist -- each either the
documented answer or a refusal naming the path, and none of them destroying a
parent. Seven odd shapes for the offsets: a byte order mark, a comma inside a
string, a comma inside a block comment, a comma inside a line comment, CRLF,
nesting three deep, and an escaped quote before a comma -- every offset a comma
in the source and a space in the blanked text, and every emptied result valid.
The mode claim is asserted over four modes in `write.test.ts`; the `.json`
strictness and the both-at-once refusal are covered in `packages/cli`; and the
absence-only assertions in `config.test.ts` are each the claim itself rather than
a missing positive.

Three sabotages over the three fixes, all three caught once the blunt one was
sharpened.

#### What the third review round found, and the entry above it was wrong

Pointed at the same two things the pass above was -- the guards the first two
rounds added, and the test bodies round 2 said it had not read. It found **five**,
and the first one **overturns a decision the entry above records as correct**,
which is the most useful thing a round has done here: that pass met the same
mechanism, probed a narrower input, and wrote the asymmetry down as a decision.

- **A claimed path replaced a non-object ancestor, and the asymmetry with
  `set()` is a defect rather than a decision.** The entry above found it with a
  **scalar** that another process wrote in the save window, and argued the claim
  should win: refusing fails a save over somebody else's edit, dropping it loses
  this process's write. The round's input has **no concurrency in it at all** --
  `write({ items: { 0: 9 } }, { paths: ['items.0'] })` over
  `{ "items": [1, 2, 3] }`, one call, one file -- and comes out
  `{ "items": { "0": 9 } }` with three elements gone. Which is the input `set()`
  already refuses, reaching a file through a door that answered differently for
  no reason.

  So it is refused, and the scalar case with it. What the first argument missed is
  that a refusal here is **actionable**: nothing is written, the message names the
  path that changed shape, and a re-run reads the new shape and refuses at `set()`
  with the same words. Replacing destroys a structure nobody claimed; dropping the
  claim loses a write in silence; refusing loses neither and says so. The test
  that asserted the old answer was rewritten rather than deleted, because the
  decision moved rather than the behaviour being untested.

  Two inputs the refusal must not take with it, and one of them parted the two
  callers. An **absent** ancestor is created, which is what makes a claim on a key
  the file says nothing about work at all. And a **`null`** one is absent, because
  that is what `null` means everywhere in this module -- which is where the two
  doors disagreed: `#staged` overlays a `copyDocument()` with its nulls already
  dropped, while the store overlays the **parsed** file, where one survives. So
  the condition is "there, not null, and not an object". Copying in the store is
  not the fix and was tried: it drops a `null` the file holds for a key nobody
  claimed, and `editJsonc` then removes it.

- **`writePath()`'s own doc gave refusing as the alternative and said it "would
  make a `set()` fail over what some other layer happens to hold".** False of
  `set()` when it was written -- `#assertWritable()` already refused -- and it was
  the leftover rationale for the replace that then reached a file through
  `overlay()`. Both callers refuse now, so the replace below it is unreachable
  from either and the doc says that instead.

- **`overlay()`'s own empty-path comment contradicted `#staged`.** It said `''`
  is skipped because `apply()` is wholesale and "reaches no overlay at all" --
  and `#staged` really does hand `''` over, since `apply()` puts it in `touched`.
  What stops it reaching a write is `#staged` claiming **no** paths. The
  consequence for a caller is now written down and pinned:
  `write(value, { paths: [''] })` claims nothing at all.

- **`FLUSH_DECLINED` was five codes and one of them was pinned.** Cutting the set
  back to `EINVAL` failed no test, so four of the five were a list nobody could
  change by accident and nobody could change on purpose either -- and what that
  turns into is a declined flush becoming a failed save. Both halves are walks
  now: five declined codes each swallowed, and `EIO`, `ENOSPC` and `EDQUOT` each
  raised with the temp file gone. The mock takes the code from the test, because
  _which_ ones are swallowed is the whole claim.

- **A test's name claimed more than its second fixture showed.** `should leave a
  trailing comma trailing where something still follows it` asserted
  `{ "a": 1, }` -> `{ "b": 2  }`, which has **no** trailing comma -- so the one
  shape that does not keep it was sitting under the name that says it does. It is
  two tests, and the second says what it is: the comma followed the only entry
  there was, that entry is gone, and there is nothing left for it to be trailing
  of.

Its three "Unsure" items were each a gap rather than a defect and each got a
test: a claim over a **nested** object parent, which every other claim test here
reached at the top level only; the `fresh` branch with a claim, which overlays
onto an empty document; and the comment-after-comma shape for the emptying.
Seven sabotages over the five fixes, **all seven caught** -- including both
inverse directions of the ancestor condition, which is what makes "there, not
null, and not an object" three claims rather than one.

#### What the fourth review round found, and five of the six were the last two commits' own prose

Pointed at round 3's fixes -- the newest code, which no round had read -- and at
what round 3 said it skipped. **Six findings, every one confirmed**, and the shape
is worth as much as the content: **five of them are comments written in the two
commits immediately before it**, including both of the ones that had just
corrected a comment a round had found wrong. A round aimed at the previous round's
output is the sharpest one here, and it is the cheapest to arrange.

- **The null exemption's reasoning was backwards in two places, and the code was
  right.** `overlay()`'s doc said the condition "is `Config.#assertWritable`'s own
  rule" and that `null` "reaches here as absent" -- `#assertWritable()` is
  `at !== undefined && !isPlainObject(at)` with **no** null case, so the two really
  do differ and the exemption is a divergence rather than the same rule. And the
  comment on the line said `#staged` overlays "a `copyDocument()` with its nulls
  already dropped", which is **`copyValue()`**: `copyDocument` passes `nulls: true`
  and keeps them, which is the whole reason that function exists. So both callers
  can meet a present `null`, and the exemption is the rule rather than a patch over
  a disagreement between them.

  What makes the divergence right is **which document each walks**, which is the
  thing neither sentence said: a layer's own value went through `copyValue()`, so
  `set()` can never meet a `null` ancestor, and a _document_ went through
  `copyDocument()`, so the overlay can. Aligning the code with either sentence --
  dropping the `!== null` -- fails the create the test pins.

- **`writePath()`'s doc has now been wrong three times, and this is the third.**
  "Both of its callers" became "no caller can reach it", and **one does**: the null
  exemption lets a present `null` through and `writePath()` is what puts `{}` in
  its place, which is how the create happens. The enumeration was wrong too -- six
  functions where there are **eight**, `#settle()` named where `set()` is the
  caller, `delete()` named where it uses `deletePath()`, and `#spliceEnd()` filed
  under `#assertWritable()` when it has none and is unreachable for a different
  reason (it returns early when `readPath()` answers nothing). Which is the same
  universal-claim failure three times in one docblock, each time by somebody fixing
  the previous version of it.

- **A claimed delete through an array is silent where a claimed set throws**, and
  that is the right way round rather than a gap: `deletePath()` has nothing to
  destroy, so it answers `false` and the file keeps what it had, where a set would
  have to replace the ancestor to proceed. One rule in two directions -- a dotted
  path addresses object keys -- and the round offered throwing as the alternative,
  which is refused because a delete with nothing to delete is a no-op everywhere
  else here. Documented and pinned as a pair, so the asymmetry is a decision rather
  than something to tidy.

- **`lineAt()` counted `\n` alone, which `LINE_END` exists to stop.** So a
  `\r`-only file reported every diagnostic "on line 1" -- a comment the scanner
  correctly ended at a `\r` was named at a line it is not on. The one function in
  that module not keeping the module's own rule, and the same class as the `eol`
  fix two rounds earlier. A CRLF is one break rather than two.

- **`atomic.ts`'s module comment named two declined codes where the set has
  five**, and aligning the catch with it would start failing saves on `ENOSYS`,
  `ENOTSUP` and `EOPNOTSUPP`. It points at `declinesFlush()` now rather than
  listing them, which is the only version that cannot go stale.

- **And `#saved()`'s doc said `get()` and the file "are the same thing"**, which
  is the sentence the commit two before it had corrected in `save()` and left here.
  The identical failure in the identical shape: a claim rewritten in one place and
  left standing in another, where aligning the code with the survivor would be the
  third read `save()` records as only moving the window.

Its two "Unsure" items were both read and left. An overlay that throws part way
leaves `into` half-written and nothing persisted -- the store throws in `claim()`
before `writeAtomic()` and `#staged` mutates a local, so the half-change is
discarded; no test asserts the ordering, and what would be asserted is an
in-memory value nobody can see. And the async `writeAtomic()`'s flush codes are
not walked, which is one `declinesFlush()` shared by both paths rather than a
second set.

Three sabotages over the two behavioural fixes, all three caught, including both
directions of the CRLF rule.

#### What the fifth round found: the insertion arithmetic nobody had read

Round 5 was pointed at round 4's own fixes first and then at the regions every
earlier round had listed as **not examined** -- which for four rounds running
included `jsonc-write.ts`'s insertion and removal arithmetic. It found **two
defects that write a wrong file**, and they are the only two findings in five
rounds that break the lossless rule itself rather than a sentence about it. Both
reproduce byte for byte, and both are in the half of the writer that no round had
opened, which is the skipped-list discipline paying off harder than anywhere else
in this file.

- **A new key was spliced in front of the last kept entry's comma and its inline
  comment, so the comment came out describing the new key.** `lineTriviaEnd()`
  documents its `from` as "just past the comma, or just past the value where there
  is none" and `insertInto()` passed `last.span.end`, which is just past the
  **value** always -- so with a comma there the scan met it at its first character,
  took the fallthrough, and returned where it started. Measured:

  ```
  { "a": 1, // comment on a }   + b   ->   { "a": 1,\n\t"b": 2, // comment on a\n}
  ```

  The output parses and keeps the trailing comma, which is why four rounds and a
  56-mutation pass went past it: nothing about the commas is wrong. What is wrong
  is that a comment somebody wrote about `a` now sits after `b`, which is **worse
  than losing it** -- a write that silently makes the file say something false,
  with `wouldLose` reporting nothing because a span store is built on the premise
  that it cannot lose anything. The contradiction between the parameter's own doc
  and its one call site is the whole of the mechanism, and it had been sitting
  there since the writer was first written.

- **A dropped tail stranded its comma, left an indented blank line, or glued a
  removed entry's comment onto the survivor above it.** Three shapes of one cause:
  `removeFrom()` worked an entry at a time, so in a tail of two the first one's
  range ended just before the comma the second was taking -- which left
  `source[end]` a comma rather than a line end, so the line-removal step did not
  fire and the first line survived as a bare indent. Measured:

  ```
  { "a": 1, // keep a\n\t"b": 2,\n}        - b    ->   { "a": 1 // keep a\n\t,\n}
  { "a": 1, // keep a\n\t"b": 2,\n\t"c": 3\n} - b,c  ->   { "a": 1 // keep a\n\t\n}
  { "a": 1,\n\t"b": 2 // comment on b\n}   - b    ->   { "a": 1// comment on b\n}
  ```

  The second violates the guarantee `removeFrom()`'s own comment states in as many
  words -- "what stops a removal leaving an indented blank line behind" -- and the
  third is the comment-moved defect again with the space that was keeping the two
  apart swallowed as the run's own trailing whitespace.

**The fix is four coordinated changes, because the two functions are coupled
through one comma.** That coupling is what made the obvious one-line fix produce
`1,,`: move the anchor past the comma and the unconditional separator writes a
second one.

- **`insertInto()` anchors past the comma and writes the separator only where
  there is not already one to serve**, which is the deleted fourth guard back, for
  the reason the corrected entry above gives. Where the comma it reuses was the
  user's **trailing** comma, one is written after what is added rather than left
  where it was, because the anchor is past it now -- so the style is kept by
  writing it rather than by construction.
- **`removeFrom()` records which comma it took and what went with it**, as
  `Ctx.eaten` and `Ctx.cut`. That is the decoupling: a comma swallowed into a
  removal **range** took the gap after it too, so the anchor cannot go _past_ it or
  it splices inside that range and `applyEdits()` refuses it; a comma deleted **on
  its own** -- which is what happens when a comment sits in the gap -- leaves the
  comment there to be gone past. Two sets rather than a flag, because the two
  answers are different and `insertInto()` reads both. The alternative was for
  `insertInto()` to re-derive the rule, which is the two-readers-of-one-question
  drift this file deletes everywhere else.

  What this said for a while is that the swallowed case means "the anchor has to go
  back to the value", and that is the half a later round falsified: back at the
  value is in front of anything in the gap, so a comment there ended up describing
  the new key. The anchor is the **comma itself** for that case now -- neither past
  it nor back at the value -- and the entry below is where that is argued.

- **`removeFrom()` works a contiguous run at a time**, which is `runsOf()`. A
  run's commas and its lines are one question, and the per-entry version could not
  see the end of the run it was in the middle of.
- **And two narrower rules on the run's own whitespace**: a comma left with
  nothing but whitespace after it on the run's line goes with the line, and the
  run's trailing whitespace is **not** swallowed where doing so would glue a
  comment onto what precedes the range. The second is conditional on what precedes
  being neither whitespace nor the brace, which is what keeps
  `{ "a": 1 /* c */, }` emptying to `{ /* c */ }` rather than to a double space.

**What is left is one residue, written down rather than closed.** A comment on the
**removed** entry's own line survives onto the line above, so it then reads as the
surviving entry's -- `{ "a": 1 // comment on b\n}` above. Preservation is this
module's stated bias and the alternative is deleting a comment somebody wrote, so
it is kept and said out loud; closing it properly means deciding that a comment
sharing a line with an entry belongs to that entry, which is a rule about ownership
rather than about arithmetic and wants its own ticket.

The **kept** entry's own comment is not in that class and was a defect rather than
a residue -- it moved onto the new key, which is the opposite direction. See the
round below.

**Eight sabotages over the four changes, all eight caught**, each by a test named
for it: the anchor reverting to the value (4 tests), the unconditional separator
(3), the trailing comma not written back (2), runs collapsing to single entries
(2), the stranded comma (1), the glue guard (1), and each of `cut` and `eaten` not
being recorded (1 and 3). Seven tests were added with them, plus one that walks all
six inputs through `JSON.parse` of the blanked text -- because a comment in the
wrong place and a dangling comma are two different failures and the pictures only
see the first.

**And one of its findings was refuted, which is why a round is a set of claims
rather than a list of fixes.** It reported `object()` ignoring `WriteOptions.paths`
as data loss, quoting `write()`'s method doc -- and `types.ts` says of the option
itself that "a store may ignore it, in which case its write is total, which is a
coarser answer rather than a wrong one, and is why this is additive rather than a
second method". Permitted, and not reachable through `save()` in any case, since
what `#staged` hands a store already holds the merged document. The two remaining
findings are a `defaultsOf()` question that is arguably the recorded "a non-string
default passes through untouched" rule rather than a defect, and two stale comments
in `config.test.ts`.

#### What the first round of PR review found, and the CI it was reading

Three comments on the pull request, every one confirmed, and two of them defects
this file's own rules are written about. The round is worth recording separately
because it is the first one driven by **CI output** rather than by reading the
diff, and that is what found the two the earlier rounds could not.

- **An atomic write replaced a symlinked config with a plain file**, which is the
  sharpest defect in the whole ticket and the one the lossless rule exists for.
  `rename()` replaces whatever is **at** the path, so a config that is a symlink
  -- which is what `stow`, `chezmoi` and every other dotfile manager makes of one
  -- stopped being a link on the first `save()` that changed anything. Measured
  before anything was written: `lstat` said the link was gone, the link's location
  held the new contents, and the real file in the dotfiles repo kept the old ones,
  so every later edit went to a local copy nobody was tracking. **Nothing reported
  it**, because `keepOf()` and the lossless check both read the path _through_ the
  link and see a file that is perfectly fine.

  `realPathOf()` resolves first and both write paths use the resolved path for
  `keepOf()`, `tempFor()` and the rename, which is what `write-file-atomic` does
  and which also keeps the temp file a sibling of the **real** file, so the rename
  stays on one filesystem. A symlinked **parent** needs nothing, since the temp
  file then lands in the directory the link points at. Anything other than missing
  is raised, because a loop or a permission failure means the write cannot land and
  saying so beats writing somewhere else. Pinned both ways: the test fails on
  `const real = path`.

  What this fix then said about the missing case -- "a path that is not there yet
  resolves to itself, which is the new-file case" -- is the half that was **still
  wrong**, and the entry below is the round that found it: `realpathSync()` answers
  `ENOENT` for a link pointing at nothing just as it does for a path with nothing
  at it, so a **dangling** link went on being replaced. The sentence is corrected
  here rather than left standing, because aligning the code with it is the defect
  put back.

- **Three Windows CI jobs failed, for two independent reasons, and the round named
  one.** The one it named: `chmod` on Windows only toggles the read-only flag, so
  `chmodSync(path, 0o600)` leaves the file at `0o666` and the mode tests compare
  against something the platform cannot hold -- 0o600, 0o640 and 0o660 failed and
  0o666 passed, which is the signature. Skipped on win32 rather than loosened,
  because what they pin is that a 600 config does not come back 644, and that is a
  POSIX claim about a POSIX mode.

  The one it did not name is this file's own Conventions entry, met for the fifth
  time: `.gitattributes` says `text=auto` and lists no `*.md`, so git checks a
  README out with **CRLF** on Windows -- and `readme.test.ts`'s fence pattern
  captures the info string with `.*`, which takes the `\r` with it, so the language
  came back `jsonc\r`, matched no filter, and four tests failed saying
  "expected [] to have a length of 1". The precedent was already in the tree:
  `testing-helpers.test.ts` normalizes for exactly this and its comment says
  "Caught by CI on all three Windows jobs and nowhere else". A rule recorded and a
  fix already written, and the next test to read a file still repeated it -- which
  is the argument for the entry rather than against it.

- **And removing a demo's `catch` broke the mode that `catch` was for**, which is
  the opposite of the mistake it was meant to fix and is mine twice over.
  `demos/config/01-layers.js` has a documented `--bad` mode, named in its own
  header, that builds the runtime layer with a port the schema cannot hold -- so
  the commit claiming the `catch` "described a refusal nothing in the demo
  provoked" was simply false, and with it gone `--bad` ended in a stack trace and
  exit 1 where it used to print the refusal. The demos test runs the default mode
  only, so it could not see either direction.

  What is there now is the `catch` back, gated on `bad` and rethrowing otherwise,
  **and** the layer array hoisted above the `try`. The hoist is the half that makes
  the gate's claim true: with the `json()` and `object()` calls inside the `try`, a
  ReferenceError in one of them reached the gated `catch` and was printed as a
  refusal in `--bad` mode -- measured, which is how the first version of this fix
  was found to be wrong too. With them outside, the only thing inside that can
  throw before the body is `createConfig()` itself, and both modes now exit 1 with
  a stack on a sabotage while `--bad` still prints what it is for.

- **A fourth job failed and is not this branch's**: `updates.test.ts > Check Late`
  on node 26 and macOS, with `Update worker timed out`. Nothing on this branch
  touches `src/updates/` or `src/util/`, checked with a diff against `main` rather
  than by eye, and the other eight jobs pass. A worker deadline on one of nine
  runners is the contention shape this file already records for the layout fuzzer.

#### What the second round of PR review found: the dangling half of the symlink fix

One comment, confirmed, and it is the **first review round on this ticket to find
a defect in a previous round's own fix** -- which is the shape this file already
records from the five reading rounds and had not yet seen from a PR: code written
in response to a review is code no review has seen.

- **A dangling symlink was still replaced by a plain file, so the real target was
  never written.** The first round's fix resolves the path and writes through the
  link, and it covers a link whose target **already exists**: `realpathSync()`
  answers `ENOENT` for a chain that ends at nothing, exactly as it does for a path
  with nothing at it, so reading that as "this is a new file" wrote the plain file
  at the link's own location after all. Which is the identical defect for the one
  state a dotfile manager leaves behind before its target has been created -- a
  `ln -s ~/dotfiles/sigil.json` run before the dotfiles file exists, a repository
  checked out but not laid out, a link left over a rename.

  Measured before anything was written, over three shapes: the link stopped being
  a link, its location held the new contents, and the target was **never created**
  -- including where the target's own directory did not exist either. The test for
  the resolved case could not see any of it, because its target is a real file.

  So the fix is a **bounded walk** that follows the chain by hand, and two things
  about it are not what a reader guesses -- each the commoner half of its pair.
  A target is resolved against the **link's own directory** rather than the working
  directory, because `readlinkSync()` hands back whatever was stored and
  `ln -s ../dotfiles/sigil.json config.json` is the ordinary spelling: a
  cwd-relative resolve is wrong for every relative link there is, and writes into
  whatever directory the process happened to start in. And a **chain** is followed
  to its end, because `a -> b -> c` with nothing at `c` is one `ENOENT` for the
  whole of it and `c` is the file to create. Neither was named by the review;
  both were found by walking the edges before writing the fix, which is the one
  thing that separates a fix from the sentence that asked for it.

  What "resolved against the link's own directory" meant in that first version was
  `resolve(dirname(at), target)`, and the round below is where that is corrected:
  `dirname()` and `resolve()` are **string** work, so the directory it resolves
  against is the one the caller **named** rather than the one that physically
  holds the link. Recorded here because the sentence reads as though the fix were
  complete, and the test beside it could not tell the two apart.

- **The file system bounds the walk, and that measurement is what decided its
  shape.** A chain of **31 or more** dangling links answers `ELOOP` rather than
  `ENOENT` -- measured at 8, 31, 32, 33, 40 and 64 hops, which is `MAXSYMLINKS`
  being 32 -- and `ELOOP` is raised by the resolve above the walk. That sweep is
  macOS's, so the `ELOOP` the cycle test asserts was a **platform claim** this
  machine could not settle: Windows resolves a link through a reparse point and
  reports what `GetFinalPathNameByHandle` gives. CI settled it -- all three
  Windows jobs pass that assertion, along with a dangling, a relative and a
  chained `symlinkSync`, so none of the four fixtures needed the `it.skipIf` the
  Conventions entry about platform fixtures would otherwise have asked for. So the walk's
  input is a chain of at most thirty hops, every cycle is refused before it is
  entered, and no state the file system can be in reaches `MAX_LINKS`. What the
  bound is for is a link that changed **between the two calls**, which is a race
  rather than a shape and is what a dotfiles repo something else is re-linking
  produces. Kept rather than left to the file system, because a loop with no bound
  in a save is a hang -- the rule `mkdirOwnerSync()`'s own climb already follows.

  Which is also why the throw at the bound is **English rather than a catalog
  key**, against the rule that a user's file system is translated: what it stands
  in for is the `ELOOP` the file system itself would have raised, and node's own
  errors on this path are not translated either. A translated sentence standing in
  for an untranslated one is inconsistent in the other direction.

- **The three error codes are each a decision and were each measured.**
  `readlinkSync()` answers `ENOENT` for nothing there, `EINVAL` for something
  there that is **not** a link, and `ENOTDIR` for a path under a file. The first
  two are the end of the walk and everything else is raised, for the reason the
  resolve above it raises one. Both of the first two are unreachable except by the
  same race as the bound -- a path that exists and is not a link is one
  `realpathSync()` would have resolved -- so all three guards are race-only, and
  all three are **pinned** rather than declared, which is the part worth copying.

  `atomic-temp.test.ts` already wraps `node:fs` with a failure code the test
  chooses, for its own stated reason that "_which_ ones are swallowed is the whole
  claim" -- so staging the race is a `readlinkSync` in that same wrapper, and the
  bound is reached by having it return the path it was asked about. That turned
  three declared survivors into three caught mutations, which is strictly better
  than the declaration this file would otherwise have accepted: the established
  harness was already there and the only thing missing was asking it this
  question.

- **A dangling link in a **parent** component is left to fail at
  `mkdirOwnerSync()`, which names it.** Measured: `mkdir` through one answers
  `ENOENT` rather than creating a directory where somebody put a link, which is
  the right answer rather than a gap -- writing through it would be a decision a
  config writer has no business making. Unchanged by the fix, and written down so
  the next reader finds a decision rather than an omission.

- **Eight sabotages, all eight caught**, after two survivors that were the two
  race-only codes and one that was the bound. The bound is caught in **both**
  directions -- deleted it hangs, which is what the harness's own deadline reports,
  and returning the path instead of throwing writes to the link. The relative
  resolve and the chain walk are each caught by exactly the test named for it, and
  neither existed before this round. Nothing turned out to be dead.

#### What the third round of PR review found: lexical `..` against the kernel's

One comment, confirmed, and it falsified a sentence the round before it had
written -- the second PR round in a row to find a defect in its predecessor's own
fix. What it found is one defect class with **two** members, and only the nearer
one was named.

- **A relative target was resolved against the directory the caller _named_
  rather than the one that physically holds the link.** `dirname()` and
  `resolve()` are string work: `resolve()` collapses a `..` lexically, where the
  kernel resolves one against the physical directory. So a link in a directory
  reached through a symlink -- a `~/.config` pointing at a synced folder with a
  `stow`-style relative link inside it, which is the ordinary setup rather than an
  exotic one -- resolved to a sibling of the named directory.

  Measured before anything was written, and it is worse than a wrong target: the
  right file was never written, a `home/dots/` the kernel would **never** resolve
  to was _created_, and the link stayed dangling, so the settings were lost. The
  previous round's own relative test could not see it, because that one puts its
  link in a plain directory -- which is the fixture-cannot-reach-the-branch shape
  this file keeps recording, in the test written for the feature one round
  earlier.

- **And node's own `realpathSync` is lexical about `..` too, which is the member
  the review did not name and the bigger of the two.** It begins with
  `path.resolve()`, so it collapses a `..` before it walks anything --
  `realpathSync.native`, which is `realpath(3)`, does not. Measured over a link
  whose target goes through a symlinked directory and back up, with a distinct
  file at each candidate: the kernel opens `far/other`, `.native` and
  `realpath(3)` both answer `far/other`, and `realpathSync` answers `real/other`.
  A different file.

  Which means the **merged** fix had the same defect on its main path, for a link
  that is not dangling at all: `realPathOf()` answered `real/other`, and
  `keepOf()`, `tempFor()` and the `rename` all then operated on the wrong file.
  Reachable without the walk, so this is not a property of the dangling case.

  So the whole function is `realpathSync.native` now. Every error code the design
  rests on is the same from both, checked rather than assumed: `ENOENT` for a
  dangling link and for nothing there, `ELOOP` for a cycle and for a chain of 31
  or more, `ENOTDIR` under a file, and the same spelling for an ordinary file --
  so the bound's own measurement and the cycle refusal carry over unchanged.

- **Windows draws the lexical line somewhere else, and it took two CI rounds to
  find where.** Every measurement above is POSIX's, and the first attempt --
  `rawJoin()` onto the **raw** `dirname(at)`, with no base resolve -- failed all
  three Windows jobs. The second, with the portable assertions below, failed one.
  Reading those two failures is what located the line:

  Win32 normalizes a path -- `.` and `..` included -- **before** the file system
  sees it, so a `..` in a path _the caller passes_ is collapsed lexically there.
  But a **relative reparse target** is substituted into the directory resolved so
  far, which is the _physical_ one -- so that half matches POSIX. Which is why the
  first attempt was wrong there and only there: it handed `realpath` a path with
  `home/app/..` in it, and Windows collapsed that to `home` before resolving
  `home/app` at all.

  So with the base resolved first, a relative target is platform-independent, and
  the one place the two genuinely disagree is a `..` **inside** the target: POSIX
  resolves it physically, Windows collapses it once substituted. Both are correct
  on their own platform, which is why the code needs no `process.platform`
  anywhere in it -- `realpathSync.native` is each platform's own answer, where
  `resolve()` was Windows's answer on both.

  The two halves of the fix are therefore pinned on different platforms, and that
  is worth knowing before reading the sabotage tally: resolving the base is
  POSIX-visible only through a caller path that holds a `..`, and joining
  un-collapsed is **not POSIX-visible at all**.

  What it cost is the tests, and the Conventions entry about platform fixtures is
  the one that was broken -- they spelled out a POSIX path. The portable claim is
  asserted now, that the write lands where the link points, read back **through
  the link**: that is what the app does next, it needs no path spelled out, and it
  is the sharper discriminator anyway -- the lexical join put the bytes where the
  link does not point, so reading through it fails. The two genuinely POSIX-only
  answers are `it.skipIf`'d with the divergence written into them, which keeps the
  platform difference documented rather than merely survived.

  Measured from the failure rather than assumed, which is the part worth copying:
  the live fixture has a distinct file at **each** candidate, so which one moved is
  the evidence. A fixture that asserted only "the right one changed" could not have
  said that -- and the first write-up of this entry read the first failure as
  "Windows is lexical about `..`", which the second failure then refuted. One CI
  round is a data point rather than a mechanism.

- **And `join()` collapses a `..` itself, which is the fixture hazard this feature
  creates.** The POSIX test for the base resolve first used
  `join(root, 'a', 'link', '..', 'sib', 'c.jsonc')` and could not fail: `join()`
  had already collapsed the `..` to `a/sib` before the subject saw it, so there was
  no `..` in the path under test at all. Measured rather than noticed. It is built
  by concatenation now, which is also the honest statement of where such a path
  comes from -- `expand()` does not normalize, so a layer declared with a path
  holding a `..` is the route.

- **The fix is to stop doing the arithmetic and ask the platform**, which is this
  file's own standing preference -- the only way to agree by construction is to
  _be_ the other party's arithmetic. Three pieces, and the first is the review's
  own suggestion, which turned out to be load bearing for a reason it did not
  give: the **base is resolved first**, so a relative target is read from the
  directory that physically holds the link. Then `rawJoin()` puts the pieces
  together with **nothing** collapsed and `physicalPath()` resolves the deepest
  ancestor that exists, joining the rest back on -- exact rather than a best
  effort, because the part that does not exist cannot hold a symlink and a lexical
  `..` over a path that is _already physical_ is the physical one. `isAbsolute()`
  stops being an optimization and becomes required, since `rawJoin()` of an
  absolute target onto a directory is a path to nowhere.

  Resolving the base and joining un-collapsed are **both** needed and on
  different platforms, which is the part only CI could say: see below.

- **The review asked for one line, and the one line is caught by a test.** Its
  own suggestion -- realpath the link's parent, then join -- fixes the member it
  names and leaves the other: sabotaged in exactly that shape, it fails the
  `..`-after-a-symlinked-directory test. Which is what justifies going past what
  the comment asked for: a measurement rather than taste, and it is the reason
  the deeper member was not written down as a declared limit instead. A limit is
  for a missing feature; a silent write to the wrong file is not one.

- **Sixteen sabotages, fifteen caught and one declared, and the declared one is
  the first in this file whose guard is CI.** Fifteen are the ordinary kind: the
  lexical join, each of the three `realpathSync` sites, `rawJoin()` normalizing,
  both halves of `physicalPath()`, the absolute branch, and the six from the round
  before, so nothing regressed.

  The survivor is `rawJoin()` onto the **raw** `dirname(at)` rather than the
  resolved one -- unreachable on POSIX by **proof** rather than for want of a
  fixture: `realpath(D)` names the same directory as `D`, so any relative path
  resolves identically from either and no POSIX fixture can tell the two apart. It
  is exactly the shape CI failed on, three jobs at once, which is the strongest
  evidence available and is better than a test this machine could run. Written down
  because a survivor with no assertion behind it normally means a guard that is not
  load bearing, and this one is load bearing on a platform the pass cannot reach.

  Its sibling -- `realpathSync` rather than `.native` for the base -- _is_ caught,
  by the one POSIX fixture that can see it, after the `join()` hazard above made
  the first attempt at that fixture vacuous.

#### What the fourth round of PR review found: the kept entry's own comment

One comment, confirmed, and it is the **third PR round in a row to find a defect
in its predecessor's own fix** -- which is now a pattern rather than a run of bad
luck: code written in response to a review is code no review has seen, and the
fix for a comment-placement defect is exactly where the next comment-placement
defect lives.

- **A new key was spliced in front of the kept entry's own inline comment, so the
  comment described the new key.** `{ "a": 1 /* on a */, "b": 2 }` losing `b` and
  gaining `c` came out `"a": 1,` then `"c": 3 /* on a */` -- a file saying
  something **false**, which this module already records as worse than losing the
  comment outright. Measured first, in six shapes: multiline, single-line, an
  array, nested, CRLF, and a dropped tail of two. All six.

  The mechanism is one sentence and it is the previous round's own machinery read
  one step further. `lineTriviaEnd()` bails back to `from` at anything that is not
  trivia, so a comma **sharing the value's line** stops it -- and for a comma the
  removal swallowed the anchor was `from`, the value's end, which is in front of
  everything in the gap. The entry two blocks up said that case "has to go back to
  the value", and that is the half this falsifies.

- **The anchor is the comma itself: neither past it nor back at the value.** Past
  it is inside the removal range and `applyEdits()` refuses the write; back at the
  value is in front of the comment. **At** it is the offset the range starts from,
  and `applyEdits()` orders an insertion before a replacement that starts where it
  does -- which is a rule that block already relied on for a key spliced in where a
  removed one began, so nothing new was needed to make this work.

- **The condition is read off the source, because what `lineTriviaEnd()` returned
  cannot tell you what happened.** It answers `from` both when it bailed and when a
  line end sits exactly at `from`, so a first fix that inferred the bail threw an
  overlapping edit on `{ "a": 1\n\t,\n\t"b": 2 }` -- a comma that **owns a line**
  has the removal start at that line's beginning rather than at the comma. Measured,
  and it is the shape that makes the guard non-obvious: the old code was _correct_
  for both own-line shapes and wrong only for the shared-line one, so a fix has to
  leave the good cases alone.

  So: `eaten && !LINE_END.test(gap)`. No line end in the gap means the comma shares
  the value's line, which means it cannot own one, which means the removal really
  does start at it -- the condition carries its own safety argument rather than
  resting on a comment.

- **Two further conditions were tried and both were measured away, which is the
  part worth copying.** A `comma > from` only ever excluded a comma sitting flush
  against the value, where the anchor is that same offset either way -- redundant,
  and it was also **masking** `eaten`: with it present, removing `eaten` changed no
  output, so the pass reported `eaten` as not load bearing. Two guards covering for
  each other is how a sabotage survivor becomes a wrong conclusion.

  And a `gap.trim() !== ''` excluded a whitespace-only gap, which turned out to be
  the **worse** answer: it moved a space the user had put after their value onto the
  line this writes, where including it leaves the space where they put it. Measured
  both ways. Four conditions down to two, each of the two pinned, and the reduction
  is what made `eaten` observable at all.

- **`eaten` protects three shapes and one of them is invalid JSON.** With it gone,
  a comma the removal **cut** has the anchor reach back in front of the comment
  _after_ it -- the same defect one comment along, in two shapes -- and a comma
  nothing removed is **reused** as the separator, so reaching back writes a second
  one: `"c": 3,,` and nothing parses. That third one is why this is not merely a
  cosmetic guard, and it is in the parseability walk rather than only in a picture.

- **Seven sabotages, all seven caught, nothing declared.** The fix removed, the
  anchor moved past the comma, each of the two conditions, the gap measured the
  wrong way, the separator moved to the insertion point, and `lineTriviaEnd()`
  skipped. Four new tests and four more inputs in the parseability walk, which
  exists because a comment in the wrong place and a dangling comma are two
  different failures and a picture only sees the first.
