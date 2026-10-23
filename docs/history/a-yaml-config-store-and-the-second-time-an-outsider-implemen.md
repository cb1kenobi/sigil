# A YAML config store, and the second time an outsider implemented `ConfigStore` — how it was arrived at

The review rounds, sabotage passes and by-hand audit passes behind
[packages/config-yaml/AGENTS.md](../../packages/config-yaml/AGENTS.md). The decisions themselves are
there; this is the record of what each round found, which is kept
because a finding nobody wrote down is one somebody re-discovers.

#### What the sabotage pass found, and the three it declared

Seventy-eight mutations, one at a time with this package's own suite run after
each. **Seventy-four caught, four declared** -- eighty-eight, eighty-two and six
once the PR review round's own ten are counted, which is a section of its own
below. Counted against the shipped tree in
one run rather than summed across rounds, with every verdict guard this
repository has learned to need: a green control first, and a pattern that matched
nothing, a pattern that matched more than once, a replacement equal to its
original, or a run that found fewer test files than the control each reported as
its own verdict rather than as a pass. The tree is restored on `SIGINT` and
`SIGTERM` as well as on an exception, because a killed pass that left a mutation
behind poisons the next control.

Two of those guards fired and both are the recorded kind. A pattern went
**stale** when a guard it quoted was deleted, and a mutation produced a tree that
would not compile at all, which came back as `HARNESS BROKEN (no summary)` rather
than as a mutation nothing caught.

- **The pass found a literal byte order mark in four files, and the guard that
  catches one could not see them.** This is the **sixth** instance of a hazard
  AGENTS.md already records five of, and the door is a new one: the previous five
  arrived through a shell heredoc, and these arrived through **Python's own string
  literals** in the patch scripts used to edit the files -- `"\uFEFF"` is the
  character in Python exactly as it is in TypeScript. `oxfmt` was the first
  suspect and is innocent, measured: it leaves the escape alone.

  And a **seventh** arrived while this very paragraph was being written, through
  the one door no tooling stands in: the sentence above holds the escape, it was
  written through a **quoted** heredoc, which interprets nothing -- so what
  reached the file was the character because the character is what was emitted,
  by somebody who meant the escape and cannot see the difference. Which is the
  entry's own point turned on its author for the second time, and is why the
  instruction is to **build** the escape rather than to be careful: an invisible
  character is invisible to whoever is typing it too.

  What makes it worth an entry rather than a commit is the **guard**:
  `packages/sigil/test/sources.test.ts` refuses a mark anywhere in a **tracked**
  file, which is the right rule -- a reviewer sees tracked files -- and it means a
  brand-new package is invisible to it until its first commit. The full suite ran
  green over all six marks, because `git ls-files` did not list a package that
  was still untracked. So the trap is the **ordering** rather than the guard, and
  the rule that follows is: a new package's first full-suite run says nothing
  about it until it is committed.

  Six marks replaced, with the escape **built** rather than typed --
  `chr(92) + 'uFEFF'` -- which is what that entry already says to do.

- **It found a false positive in the one thing `fidelity.ts` claimed could not
  have one.** That module's argument against the XML store's table of patterns is
  that a pattern can match inside a comment and name a line with nothing wrong
  with it, where a line diff cannot. The **line** cannot be wrong; the **detail**
  can, and the blank-line row was: `was === '' || now === ''` fires on any
  rendering **shorter** than the source, because the tail then compares against
  nothing. Measured on two documents with no blank line in either -- a flow
  collection written across lines, and `a: 1\nb: 2` against `a: 1`, where what
  differs is that a key is gone.

  So the row is a **run** now -- two consecutive blank lines in the source -- and
  the module says which half of its claim holds. Which is the more useful form of
  the original argument rather than a retraction: the line is exact by
  construction and the cause is a narrow rule with a test.

- **And two more residual shapes, which the probe for that found.** A flow
  collection written across lines renders on one, and a block scalar indented
  past the step is renormalized to the step. The first has a row of its own now;
  the second falls under the indentation row, where the message is accurate. The
  residual went from nine to eleven and the corpus from 33 to 35, which is the
  third time that figure has moved -- and the third time `test/corpus.test.ts`
  rather than a sentence is what carried it.

- **The cap on how many losses are reported was provably dead and is deleted.**
  `seen` is keyed by the sentence and the table had nine possible answers, so a
  cap of ten could never bind. Which is the repository's rule for a guard that
  cannot fire -- and it was about to become a live bug rather than merely dead:
  the new flow-collection row makes ten possible answers, so `seen.size < 10`
  would have blocked the tenth. The bound is asserted instead, read off the
  module so a row added later fails there.

- **Five survivors were a guard with no test, and each got the input that makes
  it matter.** The `isScalar` guard in the key comparator, where two **collection
  keys** both answer `undefined` and compare equal -- so without it `yaml`
  reports `DUPLICATE_KEY`, `assertReadable()` reports _that_ first because it
  consults `doc.errors` before it walks, and the only thing that changes is which
  cause the message names. The anchors-seen set's `typeof name === 'string'`
  guard, which needs an alias spelled **`*undefined`**: without it `String(name)`
  adds that string for every unanchored node, and a forward alias by that name
  then passes. `unshare()` copying an **array**, because `toJS()` shares a
  sequence between an anchor and its aliases exactly as it shares a mapping --
  measured on all three forms. The alias walk descending a **sequence**, without
  which `*b` inside a list is not found, `&b` is not fenced, and a write to
  `base.p` moves `list.0.p`. And the **fallback sweep**, which turned out to be
  load bearing rather than belt and braces -- the entry below.

- **The sweep is reachable, and a bracket in a string is what reaches it.** The
  padding detection is a regex over the whole document, so `a: "[x]"` beside
  `b: { c: 1 }` is evidence it should not have: the detected candidate renders the
  padded collection tight and the document reads as lossy, while the **third**
  candidate is exact. So `wouldLose` is absent for those documents only because
  the sweep corrects the detection, and without it every write to one would be
  refused. A brace in a single-quoted string and a bracket in a **comment** do the
  same. The sequence detection is **not** fooled the same way and is asserted not
  to be: it matches a line's own start, so a `- ` inside a string is on a line
  that does not begin with one.

- **The three that stay are each declared where they live, and a fourth was
  declared on a false premise.** `schema` in `PARSE_OPTIONS` was called an
  **equivalent** mutation on the ground that `yaml` 2.9.1 already defaults to
  1.2 core -- and a review round measured that false: a document naming
  `%YAML 1.1` makes `Document.setSchema` install `yaml-1.1` once the pin is
  gone, after which `yes` is `true`, `017` is `15` and `12:30` is `750`. It is a
  real guard, it had no test, and `should keep 1.2 core over a document that
  names its own version` is the one it now has. `version` on its own is the
  default restated and stays for the reason given: a future `yaml` default must
  not move what a user's file means. The two-pass check in `applyInto()` changes no answer, because `store.ts`
  renders into a document it made itself and the file is written from what that
  returns -- so a half-applied document is unreachable and the file is untouched
  either way; it is kept for that function's own contract, which is the footing
  `clipboardSequence()`'s unreachable assertion is on. And the fewest-losses
  tie-break is **dominated by the ordering**: the detected candidate is first and
  is minimal wherever the detection is right about the indent, measured over the
  four-space sequence, a multi-line flow, a block scalar past the step and a
  document with mixed indentation -- every candidate ties or the detected one
  wins. It is kept because "the closest layout" is the rule and "the first one"
  is correct only by the detection being right.

#### What the review round found, and the two claims above it that were false

Four reviewers, one per pair of modules, each given the constraints and **not**
the rationale so that it could not simply confirm the argument above. Between
them and the probes they left behind, **twenty-six confirmed findings, seven of
them severe** -- every severe one a silent data loss, a silent corruption, or
output the store's own reader refuses. Each was reproduced here before it was
believed, and the two least believable were re-measured independently.

That is a much larger tally than the sabotage pass's, and the reason is the one
this file already records twice: a pass built out of deletions asks whether the
code that is **there** is load bearing. Not one of these is a dead guard. They
are guards that were never written, and prose that does not match the code.

**It also falsified two claims this section makes**, which is the half worth
reading first, because both were stated as proofs.

- **`version` and `schema` are not "equivalent mutations".** The tally below
  declared them a survivor on the ground that `yaml` 2.9.1 already defaults to
  1.2 core. A document that names its **own** version is what separates them:
  with `%YAML 1.1` at the top and `schema` removed, `Document.setSchema` takes
  the directive and installs `yaml-1.1`, after which `yes` is `true`, `017` is
  `15`, `12:30` is `750` and a date is a `Date` -- the whole Norway family the
  pin exists to refuse, arriving through the door the pin was thought not to
  need. A real guard with no test, and no test in the package fed a `%YAML`
  directive. So the declared survivors are **three** rather than four.
- **The line diff can produce a false positive.** "That cannot be a false
  positive by construction: a line it names is a line where the source and a
  no-op write really do differ" was the whole argument for diffing two
  renderings over matching patterns against the source. It held for the _kind_
  and not for the _line_: `lossesOf()` compared `source.split('\n')[i]` with
  `rendered.split('\n')[i]`, so an inserted or deleted line shifted every index
  after it. Measured, `a: 1\n\n\nb: 2\n` renders as `a: 1\n\nb: 2\n` and the
  report named line 4, `b: 2`, which is in the output one line higher -- and
  `Math.max` of the two lengths walked past the end of the source, so
  `a: 1\n# tail\n` reported a **phantom** line 3: the empty string `split`
  leaves after a final newline.

  The claim is true again rather than weakened. The lines are **paired** now:
  the common prefix and suffix come off, which for a document against its own
  re-render is nearly all of it, and what is left is matched by longest common
  subsequence, with a run of gone lines zipped against the run of added lines
  that follows it so that a changed line is still one pair for a recognizer to
  read. No pair names an index either array does not have.

  And a `test/version.test.ts` the options doc cited has never existed in this
  package -- the dead-instruction class this file keeps an entry about, a
  comment naming a file a reader then goes looking for.

##### The seven severe findings, and the design call each one forced

- **A null root was a crash, a silent comment loss, or a silent byte change,
  depending on the door.** `rootOf()` is the fix and it is one reader of one
  rule where there were two: the read said a null root is `{}` and `render()`
  cast `readDocument()`'s `unknown` to a record and handed it to `overlay()`.
  The cast is what silenced the type system, so the return type is the guard
  now. Measured, `set()` plus `saveSync()` over a comment-only file, a `null`,
  a `~`, a `---` or a `...` threw `TypeError: Cannot set properties of null`
  naming no file; `apply()` plus `saveSync()` **succeeded** and dropped the
  file's comment with `wouldLose` **absent**, which is this package's headline
  guarantee broken with nothing reported; and `writeSync(readSync().value)`
  rewrote `null # c` to `{}`. The lossless guard's own remedy crashed too: a
  comment-only file is refused by the guard, and `saveSync({lossy: true})` --
  the fix the message prints -- threw the same TypeError.

  `openRoot()` is the document half, and the shape that forced it is not the
  obvious one: a comment-only file parses with `contents === null` and `setIn()`
  works, while anything with a `---`, and an explicit `null` or `~`, parses with
  `contents` a **scalar** holding null and `setIn()` throws `Expected a YAML
  collection as document contents`. The comments are carried because that
  scalar is where they sit. It runs after the no-op return, so a write that asks
  for nothing still touches nothing -- without that ordering a no-op write of
  `# hi` rendered `{}`.

  XML and JSON were measured on the same inputs and both save correctly, with a
  comment above too, so this one was YAML's alone.

- **A non-string key made a write produce a file the reader refuses.**
  `editsFor()` diffs the value `toJS()` produced, so every segment it builds is
  a string, and `setIn()` matches a path element against the node's own key.
  Measured, `writeSync({'1': 'b'})` over `1: a` left `1: a` and added `"1": b`,
  and the read then refused the result with `Map keys must be unique` -- no
  throw, `save()` exiting normally having written a config nothing can load.
  Same for `true: a`, `2.5: a` and `null: a`. And a delete of such a key was a
  silent no-op where a string key was removed.

  `nativePath()` resolves each segment against the document as the path is
  walked, so a mapping key keeps the key's **own value** and a sequence index
  becomes a **number** -- which matters on its own, because
  `collectionFromPath` builds an array for a numeric key and a mapping for a
  string one, so a new collection reached through a merge key came out
  `{"1": 9}` where `[1, 9, 3]` was asked for. `String(value)` is the same
  widening `samePath()` compares with, deliberately: one rule for "the same path
  segment" rather than two that can disagree.

- **A null key was three different paths and one of them dropped a value.**
  `samePath()` compared `String(a.value)`, which is `'null'`, while `toJS()`'s
  direct-key path stringifies a null key to `''`. Measured, `null: a` beside
  `"": b` read as `{"": "b"}` with the value `a` **gone**, no error and nothing
  thrown; `null: a` beside `"null": b` threw a **false** duplicate-key error;
  and a null key copied by a `<<` landed on `'null'` while the direct key landed
  on `''`, so one document read two paths for one key.

  **The design call is to refuse a null key**, extending the rule one case above
  it rather than inventing one: a collection key is already refused because it
  "names no config path", and a null key names none either. The JSON analogy
  that rule rests on says `'null'` -- `JSON.stringify({[null]: 1})` is
  `{"null":1}` -- while `toJS()` says `''`, which **no dotted path can
  address**, since `get('')` is the whole merged view. An **empty-string** key
  is deliberately still taken: it is equally unreachable, and it is what the
  user literally wrote and what a JSON layer holds, so refusing it would invent
  a divergence from the sibling. A null key is a _different_ key `yaml` maps
  onto that same unreachable path, and inconsistently. `samePath()` stops
  widening null with it, so the reader gets the message that says what is
  actually wrong rather than a false duplicate.

- **A tagged scalar coerced whatever was written onto it.** `setIn()` keeps the
  existing scalar node when the new value is also a scalar, so the old core tag
  re-stringifies it -- and `!!str`, `!!int`, `!!float` and `!!bool` are core
  tags `assertReadable()` keeps, so a user can write such a file. Measured,
  `a: !!bool true` set to the string `'false'` left the file **byte identical**
  and read back boolean `true` -- the write silently not taking -- and
  `a: !!int 5` set to `'nope'` wrote `!!int .nan`, which the next read refuses
  with `Unresolved tag`. `yamlCanHold` allowed every one of them.

  **The design call is to refuse where the type differs**, which is a fourth
  member of the write-refusal family the anchor, the alias and the merge key
  already form, and is the narrowest rule that cannot be subtly wrong: a string
  onto `!!str`, a number onto `!!int` and a boolean onto `!!bool` all
  re-stringify as themselves and round-trip, so those are left alone. Refusing
  every write onto a tagged scalar was the other option and refuses a safe one;
  dropping the tag changes something the write was not asked to change, which
  by this module's own rule would have to be a reported loss.

- **A set descending through a merge key lost keys.** `assertEditable()` refused
  a **deletion** whose immediate parent was the merged map; a set was not
  checked, and a longer path's parent is `c.nest` rather than the merged `c`.
  Measured, asking for `c.nest = {a: 9, b: 2}` wrote `c.nest.a` as a new own
  pair and the read answered `{a: 9}` -- key `b` **gone**, because the own pair
  shadows the whole merged `nest` rather than merging into it. The same shape
  over a sequence came back `{"1": 9}`, an array as a mapping, and appending
  dropped every element. A delete one level deeper threw `yaml`'s own `Expected
  YAML collection at nest. Remaining path: a`, naming neither file nor path.

  **The design call is to refuse any edit whose path passes through a merged
  key, except a set of the merged key itself** -- which is the one case that
  works and is already documented, since `yaml` writes an own pair that shadows
  it and the value round-trips. Every segment of the path is asked about now
  rather than the last one of a drop.

- **An integer past 2^53-1 was silently a different integer.** `intAsBigInt` is
  off and the core int tag resolves with `parseInt`, so `a: 9007199254740993`
  read as `...992` with no error, and the hex spelling read the same. This is
  the framework's own recorded rule broken: the parser's `int` data type
  **throws** on exactly this, because it is "the one failure a caller cannot
  detect".

  **The design call is to refuse it at read**, rather than turning `intAsBigInt`
  on -- which would make every integer in every document a `bigint`, which
  `checkValue()` then refuses on a `number` setting.

  **The test is exactness, asked of the scalar's own source text, and both
  halves of that are a defect the first version had.** It was
  `Number.isSafeInteger` over the **value**, and a PR review round measured what
  that costs in both directions. Over the value it fires on a **float**:
  `a: 1e21` and `a: 1.5e20` were each refused as "the integer", although the
  file wrote a float and the double holds it exactly -- so the store refused a
  file it had written itself, which is the class this whole package is about.
  And `canRepresent()` allowed every number, so `set('a', 2 ** 60)` saved
  `a: 1152921504606847000` and the next load **threw**: a store writing a file
  it cannot read, by the guard that was meant to close exactly that.

  So it is `BigInt(source) !== BigInt(value)`, which is exact and
  base-agnostic -- the hex and octal spellings need no normalizing, since
  `0x20000000000001` is `9007199254740993n` against the `...992n` the double
  holds. A source so long the double cannot hold it at all is its own branch,
  because `BigInt(Infinity)` throws rather than disagreeing. And the mirror is
  in `canRepresent()`, asked of the **text `yaml` will write**, which is what
  keeps the two symmetric.

  Exactness rather than distinctness changes three answers and each is measured:
  **2^53 and 2^54 are taken**, because the file names them unambiguously and the
  double holds them to the digit, where distinctness refused both; `1.5e20` is
  taken written either way, as a float or as `150000000000000000000`; and
  `2 ** 60` and `2 ** 64` are refused at the `set()` rather than at the next
  load. Stated exactly, because the obvious counterexample is not one: the read
  refuses a **source** whose digits the double does not hold and the write
  refuses a **double** whose printing is not the double, so a _literal_ past
  2^53 is neither -- `9007199254740993` in source is already `...992`, and
  writing `9007199254740992` loses nothing. There is no third case.

- **`paths` as a string silently deleted keys, in all three stores.** A string
  is an `Iterable<string>`, so `overlay()`'s own type permitted one and
  iterating it yielded characters. Measured, `write({keep: 3}, {paths: 'ab'})`
  over `{a: 1, b: 2, keep: 3}` claimed `a` and `b`, found neither in the value,
  and deleted both: `json()` wrote `{"keep":3}`, `xml()` wrote
  `<config><keep>3</keep></config>`, and `yaml()` the same.

  **Fixed in core**, because all three share it and a guard in one would leave
  the other two holding it -- the precedent being SIG-149, which moved
  `canRepresent`'s path/item ambiguity into core for the same reason: it is the
  contract the store implements. `Iterable<string>` is kept rather than narrowed
  to an array, because `config.ts` hands over a `Set`, so what is refused is the
  one iterable of strings that is never a list of paths.

##### The rest of it, and the two sentences that were load bearing

Nine moderate findings, each a refusal that failed safe or a value quietly
dropped, and each now named where it happens: an **anchor on a key** was
invisible to every fence, so deleting that key left a document `toString()`
could not even render (`Unresolved alias`) -- only a **removal** is refused,
because editing the value keeps the key and its anchor and round-trips; a
**symbol key** and a **non-index own property of an array** were dropped on the
way out with `canRepresent` saying the value was fine; `yaml(p, 'yml')`,
`['yml']` and `false` each **succeeded** with the format left at `'yaml'`, so
the argument parsed and did nothing, and `yaml(p, null)` was a raw `TypeError`;
an **alias used as a key** was reported as a mapping; the non-specific tag `!`
on a scalar was refused although the core schema resolves it to the scalar's own
text, with the parser reporting neither an error nor a warning; a **shallower
comment** was read as the indent step, so the write reindented the mapping
itself -- `seqIndented()` already skipped a comment and `indentOf()` did not,
two readers of one rule, and a block scalar's content is skipped with it because
there the minimum is not a step the serializer can satisfy both ways; and the
fidelity recognizers named the wrong cause three ways -- every surviving
full-line comment reported as "above an unindented sequence item" with no `- `
in the file, a `? not a key` line inside a literal block reported as an explicit
key, and every `=== ''` test blind on a CRLF file, where a blank line is `"\r"`.

And **four sentences were false about the code beside them**, which is the class
a deletion pass cannot read at all: `applyInto()`'s "every edit is checked
before any is applied" (the check pass runs `assertEditable()` and nothing else,
so `setIn()` and `deleteIn()` can still throw on the apply pass with the
document part-modified -- the **file** is untouched because `store.ts` throws
before `writeAtomic()`); `prettyErrors` described as off when it is the
parser's default, which is on, and the message being one line because of
`split('\n')` rather than because of that; `asPlain()` refusing every object
with "written as a plain mapping" where a `Set` and a typed array are written as
a **sequence** and a boxed primitive as a **scalar**, measured against
`createNode()` -- which contradicted this module's own table; and the DAG
comment claiming an anchor and an alias, which is true of one `createNode()` and
false of the two `setIn()` calls `editsFor()` emits for two new keys.

The one sentence worth keeping as a decision rather than a correction: a no-op
write over a file that **does not survive `yaml`'s own round trip** still
rewrites it, because a direct `write()` is documented not to consult `lossy`.
`# hi\n` renders as `# hi\n\nnull\n`, the fidelity check reports it, and
`save()` refuses -- so the guarantee holds where it is claimed. An **empty**
file becoming `{}` is outside the invariant by construction, because the blank
branch never parses and so has nothing to compare; nothing is lost either way.

##### What it cost, and the sabotage pass over the fixes

**Twenty-four mutations, twenty-four caught** -- one per fix, run with a green
control first and the tree restored on a signal as well as on an exception. Two
needed a second run and both were the harness rather than the code, which is
the third and fourth time this file has had to record that: one pattern went
**stale** when `pnpm fmt` reflowed the condition it quoted onto one line, and
the summary regex required a `passed` count, which a run where **every** suite
fails does not print -- the identical bug this file already records from the
config write pass, reproduced by somebody who had read that entry.

The suite went from **139 tests to 191** in this package, and from 6,750 to
6,804 across the workspace. One pre-existing test was rewritten rather than
deleted: `should take a scalar key of any type` pinned a null key reading as
`''`, which is the behaviour the null-key decision deliberately changed, so it
now pins the types that remain and four tests beside it pin the refusal, the
dropped value it prevents, the empty-string key that is still taken, and the
false duplicate it no longer reports.

#### What the PR review round found: the guard that refused its own output

One comment, confirmed in both of its halves, and it is the **third consecutive
pass here to find a defect in the previous round's own output** -- the review
round's own integer fix, written two commits earlier. Which is the pattern this
file already records: code written in response to a review is code no review has
seen, and that gap grows with every round.

- **The read-time integer refusal fired on floats and the write had no mirror,
  so the store refused a file it had written itself.** Both halves measured
  before anything was changed. Over the **value** rather than the source,
  `a: 1e21`, `a: 1.0e21` and `a: 1.5e20` were each refused as "the integer",
  although the file wrote a float and the double holds it exactly. And
  `canRepresent()` allowed every number, so `set('a', 2 ** 60)` wrote
  `a: 1152921504606847000` and the next load **threw** -- which is the exact
  class this package exists to refuse, introduced by the guard meant to close
  it. The integer entry above has the fix and what it changes.

- **The Scalar's own `source` is what makes the fix exact rather than
  conservative**, and finding it is what turned a two-sided approximation into
  one rule: `BigInt(source) !== BigInt(value)` is base-agnostic, so the hex and
  octal spellings need no normalizing, and it allows 2^53 and
  `150000000000000000000` -- both exact -- where `Number.isSafeInteger` refused
  the first and a decimal-digit pattern would have had to special-case the
  second.

- **A guard was deleted for being provably dead, which the pass found rather
  than the review.** `inexactInteger()` had a `Number.isFinite()` check in front
  of its integer-form test, and `String(Infinity)` is `Infinity` -- not all
  digits -- so the form test already answered for it. The read's non-finite
  branch is a different question and stays: there the _source_ is all digits and
  the value is `Infinity`, which is a real disagreement.

- **And two `oxlint` warnings were mine from the round before, one of them a
  real `TypeError` hazard.** `pnpm check` passes over a warning, so
  `exec(line)?.[1] as string` -- a cast over a short-circuit -- shipped in the
  review-round commit along with a `new Array(n)`. Which is a gap in this
  repository's own standing instruction rather than in the linter: _run `pnpm
  check`_ is satisfied by a run that warns, so a warning on code you just wrote
  has to be read rather than exited-zero past.

**Ten more mutations over the round's own guards, eight caught and two
declared**, which takes this package's pass to **eighty-eight, eighty-two caught
and six declared**. Both new survivors are provable rather than untested, which
is the distinction worth keeping:

- **`indentOf()` counting spaces only cannot be observed**, and measuring why is
  the useful half. A tab-led line is valid YAML in exactly two places -- a
  comment, and a block scalar's content -- and that function skips both already
  for their own reasons; every other tab-led line is a **parse error**, so the
  document is refused before `shape` is reached. So the test that was added
  pins the two **skips**, which is what makes the counting unobservable, rather
  than the counting.
- **The LCS base row is a uniform offset.** Both branches add the same constant,
  so by induction every cell is offset equally and every decision the walk takes
  is a comparison _between_ two cells -- measured over 4,000 random pairs, the
  alignment is identical with a base of 0 and a base of 1.

**And a pass over that commit's own guards found the sign unpinned, which takes
this package to eighty-nine, eighty-three caught and six declared.** The fourth
consecutive pass here to find something in the previous one's output, which is
the pattern rather than a run of luck: `INTEGER_SOURCE` is code the PR round
wrote, and every integer case in the read block is **unsigned**, so dropping
`[-+]?` left all 198 tests green. What that costs is not cosmetic -- every
negative integer past 2^53 then reads back **silently wrong**, which is the
defect the guard exists for, arriving through the one spelling no test covered.

The probe that found it is worth more than the finding, because it is the one
that says the regex has no _other_ hole: every integer form `yaml` resolves under
1.2 core was fed through it and compared against what the pattern matches.
`0b101`, `1_000` and the uppercase `0O`/`0X` prefixes each come back a **string**,
so the regex misses nothing -- and `1e21` and `1.5e20` come back as numbers it
deliberately skips, which is the PR round's own fix rather than a gap.
`BigInt('+5')` was measured rather than assumed, because a `BigInt` that refused
a sign YAML's own int production allows would have been a throw out of the read
for a file with nothing wrong with it.

`-0` is the edge the second test keeps, and it is why the pair is two tests
rather than one: a guard that refused every signed integer there is would pass
the refusal test alone. It goes through the same branch, both `BigInt`s are `0n`
so it is taken, and it reads back as **negative** zero rather than zero --
measured, since `toStrictEqual` tells the two apart and a guess would have
written that assertion the other way round.

#### What the second PR round found: a tag refused and a value's newlines dropped

Two draft comments, **both confirmed**, and they are the fourth consecutive pass
here to find a defect in the previous round's own output -- the cross-model
round's `tagTakes()` and the first PR round's `reshape()` both landed in the two
commits before this. Which is the pattern this file records rather than a run of
bad luck: code written in response to a review is code no review has seen.

- **Every write onto a `!`-tagged scalar was refused, which is a document the
  store reads that it cannot write.** The two halves landed in one commit and
  only one of them knew about the other: `read.ts` keeps the non-specific tag in
  `CORE_TAGS`, so `a: ! true` reads as the string `"true"`, and `tagTakes()`
  replaced the old `typeof` comparison with a switch that has no `'!'` case --
  so `default` refused it and `set('a', 'false')` threw
  `it carries the tag ! ... which would not write false back as itself`. Under
  the `typeof` proxy that same-type write was allowed, so this is a regression
  rather than a gap, confirmed against `b440582`.

  The claim is **false** of a string, measured: `'false'` renders `! "false"`
  and reads back `'false'`, because the core schema resolves `!` on a scalar to
  its own text -- which is the sentence `CORE_TAGS`'s own doc already carried,
  one file away from the switch that contradicted it. Which is also why nothing
  else may: `8080` renders `! 8080` and reads back the **string** `'8080'`,
  `true` the string `'true'` and `null` the string `'null'`, each the silent
  type change the named tags are refused for. It is a **sixth** tag rather than
  one of the five that function's own matrix was measured over, which is why it
  had no case: so it joins `!!str`'s, and both directions are pinned.

- **A keep-chomped block scalar at the end of a document had its own newlines
  dropped, silently.** `reshape()` stripped the render's whole trailing run and
  appended the source's, and the newlines a `|+` ends with are part of its
  **value**. Measured: `set('motd', 'hello\n\n')` into a file ending `a: 1\n`
  rendered `motd: |+\n  hello\n\n`, this cut it to one newline, and the next
  read answered `'hello\n'` -- with the save reporting success,
  `canRepresent()` having allowed the string and `wouldLose` **absent**, because
  the fidelity check asks about the _unmodified_ document. Both directions and
  the blank-file path with them: two trailing newlines edited to three put two
  back, three to two put three back, and a first write into a blank file lost
  them the same way.

- **The suggested fix is insufficient, and the suite is what said so.** It was to
  reapply the shape's run only where the render's own is a single newline, on the
  reading that `toString()` ends a document with exactly one unless a
  keep-chomped scalar is last. `---\n` renders as `---\n\n` -- a run of two with
  no block scalar anywhere in it, because an explicit directives-end marker over
  a null root renders the marker and then an empty content line -- so that rule
  rewrote a no-op write of `---\n` with a trailing blank line it never had, and
  `should touch no file where nothing was asked for` failed on the first run.

  Swept over forty shapes afterwards, those are the only two that end in a run
  of more than one: a null root after `---`, where the run is slack, and a `|+`
  or `>+` scalar last, where it is the value. **The bytes do not separate them**,
  so no byte-level rule exists -- every candidate was tried against the table of
  nine cases and each is wrong about one of them.

  So the **document** answers it, which is the one party that knows: the run is
  kept where the render ends in more than one newline **and** the last value in
  document order is a string ending the same way. Both halves, each refusing a
  shape the other admits and each measured -- without the count, a value `yaml`
  chose to **quote** instead holds such a string and renders a run of one, so a
  file ending `a: "x\\n\\n"` plus a blank line had the blank line read as the
  value's and dropped.

- **`visit()` is the wrong walk for a written document, and that cost a run.**
  The predicate was a `Scalar` visitor, which is what `read.ts` uses -- and
  `setIn()` stores the **plain JS value** it was handed rather than wrapping it
  in a `Scalar`: measured, after `setIn(['motd'], 'hello\n\n')` the pair's value
  is the string itself, and `visit()` skipped not just that value but the whole
  pair, so the last value came back as the one _before_ it and the fix did not
  fire at all. So `lastValue()` walks `items` and reads a node or a raw value
  alike, including a raw object or array a write stored -- each of which is
  reachable and each of which is pinned, because a write of
  `{ nested: { motd: 'hi\n\n' } }` puts one at the end.

- **Ten sabotages, nine caught, one declared.** Three empty-container guards were
  **deleted** for being equivalent: reading one past the end is `undefined`,
  which falls through to the bottom and answers `undefined`, so none of them
  changed an answer. The declared survivor is the newline **threshold** -- inside
  the count guard a structural run can only be a null root's, whose last value is
  not a string at all, so loosening it to one newline changes no answer; it says
  what the condition means where the looser spelling would be true of every block
  scalar there is. And `Shape.trailing`'s own doc said `toString()` answers every
  document with exactly one newline, which is the premise both of these entries
  falsify, so it says what is true instead.

#### What the third PR round found: the exemption that was never load bearing

Two draft comments, **one already fixed and one live**, which is itself the
reason to read a review against the tree rather than against the commit it
names: both were written against `d03f3fc0`, and the `!`-tag refusal one of them
reported had been fixed by the commit after it -- `case '!':` with a test on each
side, and a sabotage of that case fails the one named for it. So what follows is
the other one, and it is the **fifth consecutive pass here to find a defect in
the previous round's own output**: the buried-anchor fence is code the
cross-model round wrote two commits earlier.

- **A kind change carried a collection, so the buried-anchor fence skipped it
  and the save threw `yaml`'s own message.** That fence asks about every prefix
  of the edit path and the exact path, and a subtree taken away whole arrives as
  **one edit at the ancestor** -- so it also asks about the fences **under** that
  path, and it exempted an edit whose value is a collection, on the ground that
  `editsFor()` descends into one rather than replacing it.

  It descends only where the two sides are the **same kind**. A map becoming an
  array, a map becoming a `Date`, an array becoming a map: each falls through to
  the bottom of that walk and arrives as one replacement at the parent carrying
  a collection, which the exemption then waved past. Measured over
  `grp:\n  host: &k example.com\nother: *k\n` before anything was changed:
  `set('grp', ['x'])` followed by `saveSync()`, and a direct
  `writeSync({ grp: ['x'], … })`, each threw
  `Unresolved alias (the anchor must be set before the alias): k` -- `yaml`'s
  own, naming neither the file nor the path, which is exactly the message the
  fence exists to replace. The `Date` shape, the array-to-map shape and the
  key-anchored shape all threw the same.

- **The exemption bought nothing, which is why the fix is to delete it rather
  than to narrow it.** Only two edits can carry a collection value: a **kind
  change**, which is the case to catch, and a **new** key -- and a path the
  document has nothing at can have no fence under it, because every fence is
  read off the document, where `fencesOf()` walks own pairs alone and skips the
  merge key's. So the check runs for every edit now, with no condition in front
  of it.

- **And it was never "pinned from both sides", which is what the entry above
  claimed.** The test named for the other side is a **same-kind** write, so
  `editsFor()` descends and emits no edit at the parent at all: it never reaches
  the exemption. Measured -- deleting the condition failed **nothing**, all 224
  tests green -- which is the vacuous-fixture shape this file keeps recording,
  arriving in the sentence that was meant to say the guard had been checked. The
  third side is a test now: a **new** key whose value is a collection, over a
  document holding an aliased anchor, which must still be writable. Both
  directions are pinned -- putting the exemption back fails the refusal table,
  and loosening the fence's own prefix scoping fails twelve tests, the new-key
  one among them.

- **And two copies of a count the second round had already corrected once.**
  That round found the module docblock claiming "three kinds of path a write
  refuses" where it lists five, and fixed the docblock -- leaving the heading
  above and the test's own `describe` saying three, which is the fixed-in-one-
  place-and-left-in-another shape this file keeps recording. Neither carries a
  count now, because the number is one nobody re-derives and the block it names
  had grown twice since.
