# A layered config module: one merged view over an ordered stack — how it was arrived at

The review rounds, sabotage passes and by-hand audit passes behind
[packages/sigil/src/config/AGENTS.md](../../packages/sigil/src/config/AGENTS.md). The decisions themselves are
there; this is the record of what each round found, which is kept
because a finding nobody wrote down is one somebody re-discovers.

#### Two of these headings collided, and that is how the prose went in the wrong section

The two blocks above were first inserted under `#### What the first review round
found` -- and there are **two** of those, so a `replace` on the heading landed
under the canvas layers section a thousand lines away, where the text reads as
a finding about a composite nobody made. This file already records the rule, from
the debug overlay: "Two `What the sabotage pass found` sections in one file is one
somebody greps for and reads the wrong one of." It is one somebody _edits_ the
wrong one of too, which is the sharper half, and the headings in this section are
named for what they found so that there is nothing to collide with.

#### What the sabotage pass found, and the one declared survivor

Seventy-eight mutations, one at a time, with the config suites, `dist.test.ts`
and `options.test.ts` run after each. **Seventy-seven caught and one declared**,
counted against the shipped tree in one run rather than summed across rounds, so
the figure is re-derivable. A green control first, and the four verdict guards
this repository has learned to need: a pattern that matched nothing, a pattern
that matched more than once, a replacement equal to its original, and a run that
found fewer test files than the control are each their own verdict rather than a
pass -- and the tree is restored on `SIGINT` and `SIGTERM` as well as on an
exception, because a killed pass that left a mutation behind poisons the next
control.

Two of those guards fired. A pattern went **stale** when the formatter reflowed
the line it quoted, which is the shape this file records from four earlier
passes. And one mutation **hung** -- making the unterminated-block-comment check
unreachable leaves the scan unable to advance -- so the run produced no summary
and was reported as `HARNESS BROKEN` rather than as a pass; rewritten to swallow
rather than to loop, it is caught by two tests.

**Six survived the first pass and every one was a test that could not see what it
was named for**, which is the shape this file keeps rediscovering:

- **The restore after a refused mutation, both halves.** A refusal never
  recomputes, so the merged view still answers what it answered -- which means
  every assertion about the _failing_ call passes whether or not the layer was put
  back. What makes it visible is the **next** mutation: without the restore the
  layer holds the value that was refused and the recompute that mutation triggers
  refuses it again. `should not let a refused set poison the next one` is the
  input, and its sibling covers the restore that _deleted_ where there had been a
  value.
- **`readPath()`'s `Object.hasOwn`.** Without it, `at[part]` on a plain object
  answers for every member the object inherits -- so `config.get('toString')` was
  `Object.prototype.toString`. `constructor` is refused as a path segment
  outright, which is why the obvious probe says nothing; `toString`,
  `hasOwnProperty` and `valueOf` are not, and they are the test.
- **The `concat` lookup's dotted path.** Built as the merge walks down, so a
  **top-level** setting cannot tell a correct lookup from one that forgot the
  parent -- every concat test used one. A `server.tags` fixture is what sees it,
  with its mirror asserting that a bare `tags` is not that path.
- **The two coercion-site copies**, which is the subtler pair. The merge's own
  tripwire catches the same key, so a _construction_ fixture passes either way;
  what the copies buy is the **message**, which names the setting the value came
  through where the merge can only name the layer. And the `multiple` branch is a
  separate branch, so a scalar fixture leaves it unpinned.

**One guard was deleted for being unreachable** rather than tested, which is what
this repository does with one: `apply()`'s rollback around its recompute.
`copyValue()` has already run inside `coerceLayer()` by then, so a second walk of
the same value cannot find an unsafe key -- five lines of machinery for a path
nothing can take.

**And one survivor is declared**, which is the recompute's **placement** inside
`#settle()`'s `try` rather than after it. Nothing can reach it today, for the
reason the deletion above gives; it is one statement's position rather than any
code, and the failure it is for is unrecoverable -- a throw from the merge with
the recompute outside leaves the layer holding what it had just written, after
which every later mutation throws again over a value nobody can see. Kept for the
reason `clipboardSequence()`'s own unreachable assertion is.

#### What the first review round found, and the third prototype door

Seven findings, every one confirmed against the code before anything was
changed, and the shape is the one this file keeps recording: a round pointed at
the diff with the ticket's constraints and **not** the rationale finds the
guards that are missing rather than the ones that are dead. Five were runtime
defects, one was a schema check that reported the wrong thing, and two were
stale names in comments. It also confirmed nine regions clean by reading, which
is the half worth having written down.

- **A `__proto__` smuggled through `JSON.parse` polluted a merge copy's
  prototype, and that is the finding of the round.** The prototype guard had two
  doors -- a path segment and a key in a document -- and `transformValue()` is a
  **third**: a `type: 'json'` or `type: 'auto'` setting whose value is the
  _string_ `'{"__proto__":{"polluted":true}}'` enters as a string, which has no
  keys to refuse, and becomes an object with an own `__proto__` **after** the
  ingest copy. The merge's own copy then skipped the check -- it was conditional
  on a `where` the merge did not pass, on the argument that a value the merge
  copies has already been through a door -- and did `out['__proto__'] = ...` on a
  fresh `{}`, which sets its prototype.

  Measured on all three routes it is reachable by, which is a file, an
  environment variable and a schema `default`: `config.get('data').polluted` was
  `true`, and the value was **not frozen**, because `isPlainObject()` is false
  for an object whose prototype is neither `Object.prototype` nor `null` -- so
  `deepFreeze()` walked past it and a later layer at that path replaced rather
  than merged. Not global `Object.prototype` pollution, and that is the one
  mitigating thing about it.

  So the check is **unconditional** now: every copy refuses, and the three
  coercion sites pass a label of their own so the message names where the value
  came from rather than naming the merge. The merge's own check stays and is
  declared a tripwire, because "nothing can reach here" is the claim that had
  just been wrong -- which is the rule this file already records for a negative
  claim about all callers: it cannot be established by tracing the route you had
  in mind.

  And the comment in `dotted.ts` was part of the defect rather than beside it:
  it said that past the two doors "nothing internal can be handed one", which is
  what made the merge's conditional look safe.

- **`null` was "not configured" only at a _declared_ setting's path.** The rule
  lived in `coerceSetting()`, which runs per declared setting, so
  `{ "x": null }` with no schema answered `null` and `has('x')` was `true` --
  contradicting `has()`'s own doc and the rule as this file states it. A document
  says nothing the same way whether or not a schema named the key, so the drop
  moved into `copyValue()`, which is every door a value enters by.

  Two edges came with it and both are stated rather than discovered. A `null`
  **inside an array** is kept, because there it is data rather than a format
  saying nothing. And `set(path, null)` is now the `delete()` it means: leaving
  it as a stored value would be a `set()` whose result a re-read of the same file
  would not reproduce, which is the round trip SIG-154 would hit.

- **`writePath()` replaced an array with an object, which is silent data
  loss.** `set('items.0', 9)` over `{ items: [1, 2, 3] }` left `{ "0": 9 }` and
  the list was gone -- measured. The comment there argued _for_ replacing, on the
  ground that refusing "would make a `set()` fail over what some other layer
  happens to hold", and that reasoning was wrong twice over: `writePath()` writes
  into **one** layer, so no other layer is involved, and an array carries more
  than a scalar does.

  Refused now, for any non-plain-object on the way down rather than for an array
  specially, because the two halves disagree either way: `readPath()` does not
  walk an array, so `get('items.0')` is `undefined` until a `set()` has already
  destroyed the list, and `push`/`pop` treat the same path as a list. A dotted
  path addresses object keys and the array methods are how a list is changed. The
  message names the **ancestor** that is not an object rather than the whole
  path, since that is the part somebody has to fix.

- **A line comment ended at `\n` alone, so a `\r`-only file lost every key after
  the first comment.** `{ "a": 1 // c\r "b": 2 }` ran the comment to the end of
  the document, `"b"` was blanked, and `JSON.parse` succeeded over the remains --
  a key dropped with **no error at all**, which is the worst way for a scan to be
  wrong. It ends at any of the four line terminators JavaScript has now.

  ` ` and ` ` are the interesting half: neither is JSON whitespace, so
  a document holding one outside a string was never valid JSON -- and ending the
  comment there turns a silent truncation into a **refusal**, which is the better
  of the two answers available. Pinned as that rather than as a parse, because
  the parse cannot succeed either way.

- **A non-string `env` in a schema threw `TypeError: env is not iterable` from
  `envOf()`** -- an error about the wrong thing, naming nothing. `readSchema()`
  refuses it where the declaration was written, with the empty name beside it,
  because `envValue()` would look one up and a variable has a name.

- **And two comments named functions this commit does not have**:
  `assertSafeValue()`, which is `copyValue()`, and `save()` without saying it is
  SIG-154's. The first is the dangerous one, for the reason above.

What it confirmed clean, by reading, is worth recording because each is
something a later reader would doubt: `deletePath()`'s pruning indices,
`createConfigSync()` really not awaiting, the `concat` path built for nested
keys, the setting-inside-a-setting check, the `set`/`push` rollback, the
`#writable` and `#readOnlyOwner` walks, `#spliceAdd`/`#spliceEnd`, the
pending-comma tracking in every nesting case, and `checkValue()` against
`transformValue()` type by type. It also confirmed the whole-layer validation
fix found by self-review in the same pass, and said in as many words not to
treat it as open.

Two things it said it had **not** verified, and both were checked afterwards:
that the old `init-arg`/`init-option` regexes named exactly the `DATA_TYPES`
set, which the sorted-list assertion in `check-value.test.ts` now pins; and
every check the pre-migration `readSigilConfig()` had, which is walked under
the migration entry above.

#### Walking the degenerate inputs, which found four things no guard was aimed at

A pass over what an untyped caller can hand this -- the thing this file records
for the typewriter's interval and for `multiline()`'s `rows` -- and the yield is
higher here than usual, because every one of the four is reachable from a shape
an app writes on purpose rather than by a typo.

- **`undefined` is beside `null`, because neither is a value and a key holding
  one is neither of the two states this module has.** `config.set('x', argv.x)`
  with no `--x` is the ordinary spelling, and it made a **phantom key**:
  `Object.keys(config.get())` reported `x` while `has('x')` answered `false`,
  which is the one combination the ticket's own rule leaves no room for. So
  `copyValue()` drops a key whose value is `undefined` alongside one set to
  `null`, and `set(path, undefined)` deletes the way `set(path, null)` already
  did -- one rule said in the two places a value arrives rather than a second
  mechanism. An `undefined` **inside an array** is kept, for the reason a `null`
  there is kept: an element is data, and what a JSON round trip does to it is the
  format's business.

- **A value that refers back to itself was `Maximum call stack size exceeded`,
  out of the copy, the merge and the freeze alike -- and it is reachable from
  exactly the thing the object layer is for.** That layer exists so an app can
  hand over a value it built in code, which is where a plugin holding a reference
  back to its own registry is ordinary; no text format can produce one, so this is
  the object layer's own edge rather than a shape a file can reach. Refused rather
  than carried, because neither the merge nor the freeze has an answer for one.
  The check **removes what it added** on the way out, which is what makes it a
  cycle check rather than a seen-twice one: a value referenced twice is a DAG and
  is copied twice, exactly as it was before. Both halves are pinned, and the
  `seen.delete` has a test of its own -- which is the half a reader would call
  tidiness.

- **A file store with no path reported a directory nobody named.** `expand('')`
  is `'.'`, so `json('')` came back `Failed to read .: EISDIR: illegal operation
  on a directory` -- a true sentence about the wrong thing -- and `json(undefined)`
  threw a raw `TypeError` out of `expand()` itself. Refused where the store is
  built rather than at the read, which is the rule a `...` hint on an option
  already follows.

- **An environment that is not one meant "no variable is set anywhere".**
  `envValue()` reads a key off it and reading one off a number answers `undefined`
  without throwing, so `createConfig({ env: 42 })` resolved every `env` setting to
  nothing and said so to nobody. A wrong answer rather than an error, which is the
  direction this file refuses.

Three things it checked and left alone, because each is the right answer rather
than a wart. `object(null)` is an empty layer, because `null` is "not configured"
and a layer holding nothing is a layer holding nothing -- where `object(42)` and
`object([])` are both refused by the store's own "not an object". A schema of
`{}` is a config with no settings, which is what every layer in this repository's
own `readSigilConfig()` had before the schema existed. And a two-hundred-segment
path resolves, because `segments()` has no depth limit and nothing about a deep
path is ambiguous -- a cap would be a number somebody has to justify.

Six sabotages over the four, all six caught, each by the test named for it. The
harness's own pattern guard earned its keep once: the `seen.delete` removal was
written with four tabs where the source has three, so it silently matched nothing
and the run read as a guard that is not load bearing -- which is the shape this
file records for its own harness three times over, met a fourth way.

#### Walking the comma shapes, which found the scanner wider than its own rule

A pass over every arrangement of a comma a document can hold, taken while round 3
was running rather than from a finding. Twenty-two shapes through `scanJsonc()`
and `parseJsonc()` -- a comma before a comment before a closer, a nested trailing
comma, `/*` inside a string, a quote inside a block comment, `//` after a
backslash escape, a lone `/`, each of the four line terminators, a BOM, CRLF, two
commas, a comma that is not trailing -- and **twenty of the twenty-two were
right**.

- **The two that were not are `[,]` read as `[]` and `{,}` as `{}`.** A trailing
  comma is one that **separated** something, and after an opener or another comma
  there is nothing in front of it -- so those are **elisions**, which this flavour
  does not have and which VS Code's own parser refuses. The scanner was
  mis-classifying its own one rule rather than making a format decision: it armed
  a pending comma unconditionally and blanked it at the closer, which for `[,]`
  left `[ ]`.

  Not a wrong _value_ -- `[]` is the only reading `[,]` has -- which is why it
  took walking the shapes rather than a bug report. What it was is a divergence
  from the one sentence that says what this format is: "the flavour
  `tsconfig.json` and VS Code's settings are written in".

  Four lines: the last non-trivia character is tracked, and a comma arms only
  where that character is neither an opener nor another comma. Measured on all
  nine comma arrangements -- `[1,]` and `[1, /* c */]` still read, `[,1]`,
  `{,"a":1}`, `[,,]` and `[[,]]` are refused as they were, and the two that were
  accepted now are not.

- **The 400-seed differential fuzzer agreed throughout**, which is what says the
  change is narrow: it compares the scan against `JSON.parse` over JSON-valid
  documents, where no elision can appear. And it is what caught the second
  sabotage -- dropping `last = c` from the closer branch, which makes `[{},]`
  read a stale character -- where the hand tests caught the first. Two guards, two
  different inputs.

#### What the second review round found, and it was twelve tests and sentences

Round 2 was pointed at the eight regions round 1 said it had skipped -- the
tests, the prose, the demo as a program, the public surface, the migration check
by check, `transform.ts`, the `paths` rename and i18n -- and told not to
re-derive round 1's premises. It found **no runtime defect in the five files
round 1 had read**, and twelve findings in the regions nobody had opened: six
tests that cannot fail for the reason their names give, five sentences that are
false about the code beside them, and one divergence between two functions whose
comment says they agree. Which is the distribution this file already records
twice over, arriving a third time.

It had to be driven as **three focused chunks plus the whole-scope prompt**,
because `cursor-grok-4.6-high-fast` died three times on the full diff -- twice
with a cursor-side `RetriableError` and once silently with zero bytes. That is
the technique the sequence work already records for the same model, and the
chunks are what landed first; the whole-scope relaunch finished later and
independently found three of the same six tests, which is worth knowing as
corroboration rather than as duplication.

- **Six tests could not fail for the reason their names give, and every one was
  confirmed by running the sabotage the reviewer named.** The sharpest is `should
  name the writable layer by its source where it has one`, which is named for a
  branch **no core store can reach**: `here` is `target.store.source ?? name` on
  the _writable_ layer, and the only writable core store is `object()`, which has
  no source -- so the test pinned the right-hand side and its own comment admitted
  it. It is two tests now, one named for the fallback and one that reaches the
  source through a writable store of the caller's own, which is what `ConfigStore`
  is a public interface for and what SIG-154's file store will be.

  `should refuse a set into a path inside a declared setting` wrote `other.port`
  over a declared `other.port`, which is an ordinary **exact-path** refusal -- so
  a pass coercing only the setting at the path it was handed survived it, which is
  the whole thing the whole-layer walk is for. The fixture is `set('server.port',
  1)` against a declared `server` now, and that sabotage fails two tests.

  `should throw, naming the layer and both ways out` asserted the owner and `to
  override the value` and never the **destination**, which is the other of the two
  ways out -- and carried an `expect(user).to.be.a('string')` over an unused
  fixture, which is the tell. `should refuse a string where a list of classes was
  meant` matched any complaint about that field, so an `Invalid string` -- the
  opposite diagnosis -- satisfied it. And `should leave no polluted prototype on
  anything it handed out` had a payload with no `__proto__` in it at all.

- **That last one was a sentence as well as a weak test, and the sentence was
  simply false.** It claimed "nothing `get()` answers with may have a prototype
  that is not `Object.prototype`", and a `Date`, a class instance and a `Map` all
  come back with their own prototype **and unfrozen** -- which is the documented
  behaviour and the thing that makes an object layer able to hold a plugin.
  Measured on all three. The claim is about what this module **built**, and the
  test asserts both halves now: a plain object nested two deep from the json
  coercion and from the document alike is `Object.prototype` and frozen, and the
  app's own object comes back by identity.

- **The dist parser-reach test was absence-only over markers that are in no
  bundle at all.** `parseArgv` and `initOption` are names the minifier renames --
  `grep -l` over every `dist/*.mjs` finds neither -- so two of its four absence
  halves could never fail. That is the `mergeLayers` disease this file records one
  block up, in the test written immediately after it. All four markers are string
  literals now, each with a **presence** half.

  And the markers alone are not enough, which is the part that needed measuring:
  `export { initArg } from '../parser/argument/init-arg.js'` in the config barrel
  adds an `init-arg-*.mjs` chunk and pulls the parse chunk in **not at all**, so
  no fixed marker set keyed on `parse`'s own literals can see it. So the module
  **count** is asserted too -- six, which is the list the byte figure is over, so
  the two cannot come apart. That sabotage fails two tests where it used to
  survive entirely.

- **`checkValue()` and `transformValue()` disagreed about a number as a `date`,
  under a comment saying they agree.** `dateIntRE` is `/^\d{13}$/`, and the check
  was `isFinite(value) && value > 0` -- so `8080` was a date in 1969 where
  `"8080"` throws, and `1.5` was one too, truncated to the epoch, which is a value
  no spelling of this type accepts. A file holding `"when": 8080` is a port
  somebody put on the wrong line, and the whole reason `checkValue()` exists is
  that a file and an option cannot come to disagree. Narrowed to a 13-digit
  integer, and pinned as a **differential** over thirteen numbers rather than as a
  sentence -- `checkValue(n)` and `transformValue(String(n))` must answer the same
  thing -- so widening it back fails.

- **The README's own `set()` example threw as published, and the test written to
  catch that said it had been fixed.** `config.set('editor.theme', 'dark',
  'user')` names a `jsonc()` layer -- the factory that became `json()` -- which
  that ticket did not make writable. It
  was found once already -- `readme.test.ts` runs with `'runtime'` and asserts
  `'user'` throws -- and the **README was not changed**, while that test's comment
  claimed it had been. So the published line stayed broken for another commit
  behind a test that reads as covering it, which is worse than no test.

  Fixed, and the **class** is closed rather than the instance:
  `readme.test.ts` now reads `README.md` and asserts that every line it quotes in
  a comment is a line the README has. A comment quoting a file is a copy of that
  file, and a copy nothing compares is one that drifts -- which is this
  repository's own warning about prose, met inside the test written to check
  prose. Putting the published spelling back fails it.

- **Four more sentences, each false about the code beside it.** The barrel's
  opening lists the boilerplate every CLI writes -- "read it, merge it, write it
  back without truncating it" -- with nothing saying which half this is, so it
  reads as a feature list and contradicts the README two sections along; it now
  says the write half is SIG-154's and why. `wouldLose` was documented as "empty"
  in three places and the field is **absent** where nothing is lost, so
  `wouldLose.length` is a `TypeError` and `?.length` is the way to read it. The
  README's "about 20 kB over six modules" listed **five**, missing the
  `env-value` chunk the parser shares -- and the dist comment's claim that the
  figure is "here and in AGENTS.md and nowhere else" was false while it did, so
  that now says the measured figure is in two places and the README carries a
  rounded one. And the toolchain's leftover-check inventory named one check where
  there are four.

- **What it confirmed clean is worth recording, because it is most of the
  surface.** The `(opts, docs)` constructor, the eleven exported types, the
  `exports` map against the tsdown entry, `scanJsonc`/`lineAt`/`Setting` staying
  unexported, the `DATA_TYPES`/`OPTION_DATA_TYPES` membership against the old
  regexes name for name, the whole `paths.config()` sweep -- every remaining
  mention is the rename being explained -- and the translated-versus-English split
  message by message, with none found on the wrong side. The demo's comments
  match the lines under them.

  It also reached the `null`-as-absent class in the migration **independently**,
  which had already been found here by walking the inputs. Two routes to one
  finding is the strongest evidence either produces.

#### What the third round found, and the review half of it never ran

Round 3 was pointed at the one thing nobody had read: **the guards the first two
rounds and the input walks added**. Code written in response to a review is code
no review has seen, which is a gap that grows with every round -- so the regions
were `copyInto()`'s cycle guard, `assertEnv()`, the file store's path refusal,
the narrowed `date` branch, the `undefined` rule's entry points, the JSONC
scanner's comma shapes, and the fuzzer's own corpus.

**The reviewer almost never answered.** `cursor-grok-4.6-high-fast` failed five
times across this ticket -- three on round 2's full diff and both of round 3's
chunks -- with a cursor-side `RetriableError: exceeded max retries` or silently
at zero bytes. Round 2 landed because it was split into chunks; round 3's chunks
died, and a sixth attempt at a single-question prompt about the fuzzer did come
back: "the test is sound". Which is **not** corroboration of anything below, and
saying so is the point -- it read the file after the three counters had been
added, so it confirms the fix and is no evidence at all about the hole the fix
closed. A reviewer that arrives late reviews what it finds.

So **round 3 is this repository's own work and is labelled as such**, which is
weaker evidence than a reviewer's and is the honest statement: the findings below
were reached by probing, and nobody who had not written the code read them.

What that does **not** weaken is the findings themselves, each of which is a
measurement.

- **The exported `Config` constructor had no `assertEnv()` behind it.** That
  constructor's own doc says `readSchema()` and `assertLayers()` are called there
  as well as in the factories "because this has to be correct when called
  directly" -- and `assertEnv()`, added in the degenerate-input walk, went on the
  two factories only. So `new Config({ env: 42 }, docs)` accepted it, which is the
  one public door with no check behind it, through the class the barrel exports.
  Measured on five values: four refused by the factory and all five accepted by
  the constructor.

- **An array was an environment.** `envValue([], ['PORT'])` reads a key off it and
  answers `undefined`, which is exactly the silent "no variable is set anywhere"
  the guard was written to refuse -- so refusing a number and accepting an array
  was the guard half-applied. `Object.create(null)` is accepted and is pinned, for
  the opposite reason: a null-prototype record is a perfectly good environment and
  the rule is about shape rather than about prototype.

- **`push(undefined)` stored a hole, where `set(undefined)` deletes.** The rule
  this ticket arrived at is that neither `null` nor `undefined` is a value, and
  `set()` keeps it by deleting -- but a list has nothing to delete, so appending
  one was stored: `config.push('plugins', argv.plugin)` with no `--plugin` put an
  `undefined` in somebody's list, which the first write turns into `null` and
  which reads back as data. Refused, and a **`null` is not** -- a `null` inside an
  array is data rather than a format saying nothing, which is the one place the
  two part company. Both halves are pinned for both methods.

  Checked at every other door at the same time, and the other five were already
  right: `apply()` of an object holding one drops it, `apply(undefined)` is
  refused, a schema `default` of `undefined` is not a default, and an environment
  value of `undefined` is unset.

- **The scanner's trailing-comma rule was wider than the format it claims to
  be**, which is its own entry above -- `[,]` read as `[]`.

- **And the fuzzer met five shapes and counted two.** Measured over its 400
  seeds: 181 documents hold a string containing a comment marker or a separator,
  170 nest, 132 carry a block comment with a newline in it -- and the floors were
  comments and trailing commas alone. So **one line** made it vacuous: dropping
  `','`, `'}'`, `'//'` and `'/*'` from `prims` leaves a corpus that never puts a
  comment marker inside a string, with both counters passing and the differential
  green. Three more floors, each verified by the generator change that trips it,
  which is the rule that file's own comment states and did not keep.

- **Eight cycle shapes and twenty-two comma shapes were probed and the rest were
  right.** A cycle through an array, through an object, a self-referencing array,
  a three-long cycle, a sibling cycle, a DAG shared at two depths, a
  two-hundred-deep chain, and a cycle below a `Date` -- which is _not_ walked,
  because a `Date` is carried by reference, and is the one of the eight where
  accepting is correct. The `date` boundary was checked at `1e12`, `9999999999999`,
  `1e13`, a fraction, a negative and `-0`.
