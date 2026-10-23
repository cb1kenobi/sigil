# Output formats: `run()` returns data, a serializer presents it — how it was arrived at

The review rounds, sabotage passes and by-hand audit passes behind
[packages/sigil/src/parser/AGENTS.md](../../packages/sigil/src/parser/AGENTS.md). The decisions themselves are
there; this is the record of what each round found, which is kept
because a finding nobody wrote down is one somebody re-discovers.

#### What the sabotage pass found, and the two guards covering for each other

Thirty-nine mutations, one at a time with the five affected suites run after
each. **All thirty-nine are caught**, after two survivors and one stale pattern,
and the interesting half is not the count. A green control first, and the four
verdict guards this repository has learned to need -- a pattern that matched
nothing, one that matched more than once, a replacement equal to its original,
and a run that found fewer test files than the control, each its own verdict
rather than a pass -- with the tree restored on `SIGINT` and `SIGTERM` as well as
on an exception.

- **The stale pattern was the formatter's**, which is the shape this file records
  from seven earlier passes: `oxfmt` reflowed `formatFor()`'s `available` onto two
  lines after the case was written, so it matched nothing and read as a guard that
  is not load bearing.

- **And the two survivors were two guards covering for each other**, which is the
  shape recorded for `eaten` and for the `claimed` set. `renderError()` has a
  catch of its own around the serializer, and `errorHandler()` has one around a
  replaced renderer -- and with the first in place either spelling of the second
  produced the same text, so neither mutation could be seen.

  Separating them found a **better answer** rather than a missing test, which is
  what makes it worth the entry. `errorHandler()`'s fallback was the plain line,
  on the reading that "a fallback that could re-enter whatever just threw is not
  a fallback" -- and what threw there is the **caller's** `render`, not ours, so
  re-entering our own format-aware renderer cannot loop and is the answer the
  reader asked for: falling back to the plain form would silently drop the format
  in the one case where the app's own renderer is what is broken. So the fallback
  is `renderError(err, ctx)` and the inner catch is what makes that safe.

  Both are pinned now, and each needed an input nothing else in the suite
  reaches: `renderError()` called **directly**, which is what makes its own catch
  load bearing rather than redundant -- it is exported for a caller to wrap, so
  `decorate(renderError(err, ctx))` has to get text -- and `errorHandler()` with a
  **replaced** `render` that throws while a format is selected, which is the only
  place the outer fallback's choice is observable.

#### What the first review round found, and the one thing that was losing data

`muse-wonder-1.0-high` through `cursor-agent`, pointed at the diff with the
ticket's own requirements and **not** the rationale, so that it could not simply
confirm the argument above. **Ten confirmed findings plus three documentation
ones**, every one reproduced here before it was believed -- and the distribution
is the one this file keeps recording: not one of them is a dead guard, which is
the half a sabotage pass is blind to by construction. Three were a wrong answer
on a reachable path, four were an input that parsed and then did something nobody
meant, and the rest were prose that was false about the code beside it.

- **The `json` built-in silently lost nested data, which is the severe one.**
  `JSON.stringify` has three answers for a value it cannot hold and only one is
  loud, and the design had argued for leaving the silent two to JSON "for the
  reason `jsonCanHold()` in the config module records refusing it: there, a value
  is being written back to a file somebody will read again, and here it is being
  handed to a pipe once". That reasoning is wrong about **which** losses are at
  stake. A `Map` of results reaches a pipe as `{}`, a function or an `undefined`
  value has its **key dropped**, and `NaN` and both infinities are `null` -- so a
  command returning a `Map` piped an empty object and nothing said a word, which
  is the one thing the house rules name directly.

  The framework already refused a _top-level_ `undefined` for exactly this
  reason, which is what makes the nested case the same rule half applied.

  `lossyAs()` is the answer and a **replacer** is the mechanism, which is the
  reviewer's own suggestion and is better than the hand walk that was weighed
  against it: a replacer sees what `JSON.stringify` sees, so `toJSON` and a boxed
  primitive need no special case, and it carries the **path** -- `this` is the
  holder and a holder is always visited before the values under it, so one
  `WeakMap` is enough. Measured on fourteen shapes before anything was written,
  and on twenty-one afterwards.

  Two decisions inside it are not the obvious ones. It is **not** `jsonCanHold()`
  from the config module, and the two differ on purpose: that one asks whether a
  value survives a write and a read _back_, so it refuses a class instance, where
  this asks only whether JSON writes what it was given once -- so a class
  instance is written as its fields, which is what the app asked for. And the
  `{}` family is asked of **`JSON.stringify` itself** rather than of a prototype
  table, because `new Number(5)` is a non-plain object with no own keys that JSON
  writes as `5`: a table keyed on the prototype refuses a value that is written
  faithfully, and asking what JSON will write cannot be wrong about what JSON will
  write. An empty `Map` is the one value this calls a loss that holds nothing to
  lose, which is correct -- a `Map` is `{}` whether or not it has entries, so the
  app's serialization is wrong regardless of what is in it now.

  It costs **1,615 B on every app's root entry**, and that cannot be deferred for
  the reason the rest of the chunk cannot: `renderError()` is synchronous by
  design, so there is no `await import()` on the path that reaches it. Measured by
  replacing `json()`'s body with a plain `JSON.stringify` and letting the shaker
  drop what nothing then reaches -- which is the walk's **own** cost, where the
  2,341 B this and `dist.test.ts` each said for a while is what round one's whole
  commit added, four other fixes included. A figure means what its measurement
  asked, so the method is written beside it.

- **The accepted set was position-dependent, which is the one a format must not
  be.** `detectFormat()` read `accepts` off the option argv **bound to**, and a
  token resolves against the contexts known at that moment -- so `db --format json
  list`, on a `db` that accepts everything and a `list` narrowed to `['yaml']`,
  bound to `db`'s option and `list`'s narrowing was never applied: exit 0, the
  JSON on stdout. `db list --format json` refused it correctly, so one command
  line had two answers depending on where the token sat.

  The set comes off the **settled chain** now -- `state.contexts` is
  innermost-first, so the first command that declared one governs, which is the
  parser's own nearer-declaration rule. `--json` is the sharper half of the test,
  because the sugar itself is only there because an _ancestor_ offered it: `list`
  accepts only yaml, so no `--json` was added to its registry and the one that
  resolves is `db`'s. Which is options resolving across the chain, and is exactly
  why what a token may **name** has to be the nearest command's answer rather than
  the answer of whichever registry holds the option.

  The existing test could not see it, and its own name said why: it "only ever
  places the token _after_ the subcommand name". And `mark()`'s doc was the
  sentence that made the defect look impossible -- it claimed the accepted set
  "that comes with it is the nearer one's without anything having to ask", which is
  true of the _option_ and false of the _set_.

- **An async serializer cost two unhandled rejections, not just a confusing
  message.** The type says `string` and a JavaScript app is not bound by it, and
  `got object` sends the author to look at their data rather than at their
  signature. The half that costs something is that the promise is **discarded** --
  by `writeFormatted()` and again by the error path, which serializes the payload
  with the same serializer -- so one that _rejects_ took the process down with two
  unhandled rejections about an answer nothing was waiting for. Measured.
  `assertSerialized()` names a promise and swallows its rejection, which is safe
  because the throw below it is the report.

- **Three inputs `outputFormats()` took and should not have, all measured.** An
  **array** _works_: `Object.entries` keys it by index, so `formats: [fn]` mints a
  format called `0` and `--format 0` selects it. A **`Map`** -- which is the shape
  anybody reaching for a registry writes -- contributes **nothing**, so an app that
  had declared yaml was told `This command accepts: json`. And `{ '': fn }` made
  `--format=`, which is the one way argv says "deliberately empty", select a
  format. A fourth came with them: a format **name holding a control character**
  reached stderr raw in the `This command accepts:` list and executed on the
  terminal, which is the rule this repository keeps for every byte it emits.

  All four are refused where the declaration was written. `isRecord()` is a local
  predicate with two readers in the module rather than the config module's
  published `isPlainObject()`, and that is a layering call with a measurement
  behind it: that one is `@ttylabs/sigil/config` public API with about fifty
  readers across three packages, so moving it to `src/util/` -- the answer this
  repository has reached for three times -- is a change to published API taken
  inside a ticket about output formats.

- **The demo destroyed the error it was written to demonstrate.** `boom --format
  csv` printed `name,size` and nothing else, because `toCsv` read `value.rows`
  and the failure path hands over `{ error: { message, name } }`. So the one demo
  of "errors are data too" showed two formats losing the error, and
  `renderError()`'s catch did not fire because the serializer did not throw -- it
  returned a string. Which is the fact an app author most needs and the README did
  not state: **a serializer is handed both of a run's two answers.** Both
  serializers branch on it now, the README says so with the shape, and
  `demos/README.md` says why the extra command is in the list.

- **`renderError()`'s motivating example was the one case that does not
  serialize.** It gave `--format json` on a command "whose `--port` was given a
  letter" as what the format-aware path is for, and measured: `Invalid integer:
  eight` is a **plain line**, in either token order, because a value its type
  rejects throws while argv is being **read** and `detectFormat()` runs after the
  walk and before the judging. `Missing required options` and `Unexpected
  argument` are both payloads.

  Which is the same boundary the help rule already draws in the same place, and
  it is now pinned by a test over both token orders rather than described -- so
  finding 3's "make the seam an explicit recorded acceptance" is a check. Moving
  `detectFormat()` earlier would not close it: the throw is inside the pass that
  reads the option, so there is no earlier point that has both the token and a
  settled chain.

- **And four sentences were false about the code beside them**, one of which
  contradicted its own file nine lines up. `format.ts`'s header and the README
  both said "no command branches at all" / "what stops a command branching on it
  at all" -- while the README's own previous paragraph says reading `state.format`
  is "a question about presentation", and the demo's `list` does exactly that
  branch, because stdout belongs to the serializer once a format was selected.
  `mark()`'s doc said `parserOwned` means a command **cannot** branch on it,
  where what is off `argv` is the **name**. And `demos/README.md`'s table row
  said "out of one `run()` with no branch in it".

  The true statement is narrower and is what all four say now: no command branches
  on _which_ format, which is the `if (json) … else …`; whether one was selected
  is a different question and is `state.format`. Plus one minor:
  `SerializedError.name` was documented as present "where it has one that says
  more than `Error`", and `Error` is included -- deliberately, because a script
  asking "is this an `Error` or a `TypeError`" needs the field either way.

- **Two tests could not fail for the reason their names gave**, which is the
  class the round found last and the one this suite refuses elsewhere. The
  `--version` test had no `default` command, so there was nothing for a format to
  present and stdout was the version whether or not `--version` won; it has one
  now, so a `--version` that stopped short-circuiting prints the JSON. And the
  BigInt test asserted `toContain('BigInt')` against JSON's own message, which
  says nothing about _which_ value -- it is one row of a ten-row table over every
  silent loss now, each asserting the path, with an inverse table beside it over
  the five values JSON holds faithfully so that a refusal widened to cover one of
  those fails rather than going quiet.

- **One minor was left as a comment rather than a change.** `writeFormatted()`
  and `renderError()` re-resolve with `accepts = true` rather than with the
  command's own narrowing, which is safe by construction: `detectFormat()` set
  `state.format` only after `formatFor()` had judged the name against the chain's
  set, so a name that is there is one that passed, and `true` is a superset.
  Passing the narrowing again would mean a second field on `ParseState` answering
  a question already answered.

- **And one process error of mine is worth recording with them.** The reviewer
  flagged uncommitted modifications to two source files that it had not made --
  because I edited the tree while the round was running. AGENTS.md's own rule says
  nothing else touches the tree while a sabotage pass is live; a review round is
  the same hazard with a worse signature, because what comes back is a confident
  finding about a defect you introduced on purpose. The same thing happened to the
  config write work from a `pnpm fmt` in another terminal.

#### What the second round found, and the report it never wrote

`muse-wonder-1.0-high` again, pointed at round one's own **output** plus the
regions round one had not opened -- which is this file's own recorded practice
and is the sharpest arrangement: code written in response to a review is code no
review has seen. It **died twice with zero bytes and exit 0**, which is the
`cursor-agent` failure this file already records from the YAML store's rounds,
and it wrote no report either time.

What it left behind is four probe files in the working tree, and they are worth
more than a report: **eight defects in round one's own `lossyAs()`**, every one
reproduced here before it was believed, and a thorough adversarial pass over the
chain rule that came back **clean on every case**. So the round counts, and it
counts for the thing a report would have compressed away -- the probes name the
inputs. The relevant process note is below: it also **edited the reviewed tree**,
which is the hazard round one already demonstrated in the other direction.

- **The sharpest is a wrong value written rather than a loss let through.** The
  `{}` test asked `JSON.stringify(value) === '{}'` to tell an object JSON writes
  as its own fields from one it has no mapping for -- which serializes the
  subtree a **second** time, so every getter under it ran twice and the value
  written was the **second read**: measured, a getter returning a counter wrote
  `2` where plain `JSON.stringify` writes `1`. And a **stateful** getter
  defeated the check outright, which is the hole rather than the cost: one
  answering a `Map` on the first call and a number on the second passed and
  wrote the number, so on the run where the order was the other way round the
  `Map` reached a pipe as `{}`. It is also **quadratic**, since the whole subtree
  is re-serialized at every non-plain object in it.

  So the question is asked of the value's own shape instead, which invokes
  nothing and is `O(1)`: `SerializeJSONProperty` unwraps a boxed primitive and
  otherwise writes the object's own enumerable string keys, so it writes `{}`
  exactly when there are none and it is not boxed. The boxed test is the
  **internal slot** -- `Number.prototype.valueOf` throws for anything without
  `[[NumberData]]`, and that slot is set only by `new Number()` -- because that
  is what the specification itself asks, where a `Symbol.toStringTag` read is
  forgeable and `instanceof` is realm-dependent. A boxed **symbol** is
  deliberately not in that list, because `JSON.stringify(Object(Symbol()))` is
  `{}` and it belongs to the key test.

- **Four values JSON silently changes were getting through**, each measured. A
  boxed `Number` holding `NaN` or an infinity is written as `null`. A boxed
  `BigInt` makes `JSON.stringify` throw. A **named property on an array** is
  dropped, which is the headline "a key is dropped" class arriving through the
  one door the first spelling skipped entirely -- `lossyAs()` returned early for
  an array -- and is the call the XML store already makes about a non-index own
  property. And a property on a boxed primitive goes the same way.

  The inverses are narrow and are pinned beside them, because a refusal widened
  to cover one of these would break a working app: a boxed string's own index
  keys **are** the string, an array with only index keys is written, and a typed
  array with bytes in it is written as an object of indices.

- **An empty key reported no path at all.** The path was keyed on `key === ''`
  for the root, and `{ '': NaN }` is a path whose one segment is the empty
  string -- so the one case where a reader most needs the location lost it. The
  `WeakMap` holds **segments** now, where an empty list is the root and a
  one-segment list holding `''` is a path, and the path is printed through
  `JSON.stringify` -- a key holding a quote or a newline came out of a bare
  interpolation unreadable.

- **Two hostile reads escaped as somebody else's message.** A `Proxy` whose
  `getPrototypeOf` trap throws reported `proto boom` where `JSON.stringify`
  writes `{}`, because `isRecord()` asks a question JSON never asks; and a `then`
  **getter** that throws reported itself out of `assertSerialized()`, whose whole
  job is to report what the serializer answered. Both are guarded, and there is
  one bracket over every read of somebody else's object in `unwritten()` --
  answering `undefined` rather than reporting, because a value whose own
  introspection throws is one `JSON.stringify` is about to meet and throw about
  with a message that names the trap.

- **And `Object` is the one kind name that says nothing**, which is reachable:
  `Object.create({ inherited: 1 })` is not a record, has no own keys and reports
  `Object`. The generic sentence is the honest half, and the path is what
  identifies it.

- **What is left is a residual, written down rather than closed**, and three of
  the four are structurally out of a replacer's reach. `-0` is written as `0`,
  and refusing it would refuse a value any arithmetic produces for a difference
  `JSON.parse` cannot observe. A **symbol-keyed** or **non-enumerable** property
  is dropped, and that is the JavaScript convention for "not part of the data" --
  used by this very framework, whose `Internal` symbol hangs metadata off every
  command, so refusing it would refuse an app returning anything this framework
  built. Which is the opposite call from the XML store, and the two differ for
  the reason `jsonCanHold()` and this differ: that one writes a **file** read
  back, where a dropped key changes the round trip. An **invalid `Date`** is
  written as `null` because its own `toJSON` has already turned it into one
  before the replacer sees it -- the same hole the config module records in its
  own JSON store. And an **empty typed array** is refused while a full one is
  written, which is the one place the answer depends on the data: no rule
  separates "this kind is always `{}`" from "this instance happens to be empty",
  because `Object.keys(new Map([['k', 1]]))` is also empty.

- **The chain rule came back clean, which is the other half of the round.** Its
  own probes walked the accepted set through a `default` command that joins the
  chain after argv is walked, a parent narrower than its child and a child
  narrower than its parent, both token orders for each, `help list` against `list
  --help`, and a bad name against `--help` and `--version`. Every one is the
  answer round one's fix is written for: position-independent, nearest
  declaration governing, and a bad name winning over `--help` as documented.

  Two consequences it surfaced are worth recording rather than fixing. A command
  whose **declaration** names a format the schema does not provide fails every
  run, `--version` included, which is the documented "a declaration that cannot
  mean anything fails where it was written" applied to the cheap path. And `help
  list` does **not** check `list`'s declaration where `list --help` does, because
  `help`'s chain is `['help', root]` -- which is the deferral working rather than
  an inconsistency, since `help list` dispatches `help`.

- **And the process note is the one worth keeping.** The reviewer wrote four
  probe files into the tree it was reviewing, despite being told not to, and it
  is the same hazard round one met from the other side -- there I edited the tree
  while it was reading and it reported my own edits as findings. The answer for
  both is a **git worktree**: the probes were harvested into one and re-run
  against the fix there, which is how the eight were confirmed without touching
  the branch.

#### Round three never answered, and what was done in its place

Four launches of `cursor-agent --model muse-wonder-1.0-high`, every one a
**zero-byte exit 0**, and the deaths got _earlier_ rather than later: the last
two produced nothing at all, where round two at least left its probes. A
single-focus chunk at `-medium`, which is the technique this file records as the
one that landed a round on the YAML store, died the same way. So the retrying
stopped at four, which is the rule this repository already keeps about a
subagent that stalls.

What stands in its place is **this repository's own work against round three's
brief, labelled as such** -- which is the precedent the YAML store set and is
weaker evidence than a reviewer's for the stated reason: nobody who had not
written the code read it. A sabotage pass is the part of it that is not weaker,
because a mutation is a fact rather than an opinion.

- **Thirty-eight mutations, thirty-seven caught, one declared.** A green control
  first and the four verdict guards, and three of the four fired, which is the
  argument for having them: the summary regex required a `passed` count, which a
  run where **every** suite fails does not print -- the identical bug this file
  records **twice**, reproduced a third time by somebody who had read both
  entries, and it reported 33 of 40 mutations as `HARNESS BROKEN` rather than as
  passes. The suite-count guard then caught a second one, which is the glob that
  matches nothing: `test/readme.test.ts` does not exist -- the config module's is
  at `test/config/readme.test.ts` -- so vitest ignored the path, one suite ran
  where two were named, and the control said `1 suites`. And a run backgrounded
  through `nohup` was killed partway and left a mutation in the worktree, which
  is why the pass runs in the foreground.

- **Two guards were deleted for being unable to change an answer**, and the
  first is two guards covering for each other -- the shape round one already
  found once. `isRecord()` had a `try` around its `getPrototypeOf` for a `Proxy`
  that refuses the question, and `lossyAs()` has a bracket over every read of
  somebody else's object: with the second in place the first cannot change an
  answer, and the proxy test passes either way. The bracket is the one guard now
  and the reason is written where it is. And `isRecord()`'s `Array.isArray` was
  dead on every path: an array's prototype is `Array.prototype`, so the test
  below answers `false` anyway, and both callers that care ask `Array.isArray`
  first.

- **Four survivors were a guard with no test, and each got the input that makes
  it matter.** Both halves of `isIndex()`: a key of `"00"` is a named property
  JSON drops, which `/^[0-9]+$/` reads as an index, and `"4294967295"` is one
  past the last index an array can have. The `Object`-name fallback, whose input
  is `Object.create({ inherited: 1 })` -- not a record, no own keys, and it
  reports a kind named `Object`, which names nothing. And **`assertDeclared()`
  walking the whole chain**, which is the sharpest of the four: checking only
  the nearest declaration leaves a broken one on an **ancestor** unreported for
  every run that reaches a child with a good one, which contradicts the comment
  beside it and this section's own claim that such a declaration fails on every
  run.

- **The one declared survivor is a tripwire rather than a guard.** `mark()`'s
  `if (!opt) return false` cannot be reached: every caller looks the option up
  immediately after adding it, and `OptionRegistry.add()` throws rather than
  declining. It is kept because `add()` answers `void`, so the lookup cannot be
  avoided, and the honest alternative is a `TypeError` from the next line --
  which is the footing `clipboardSequence()`'s own unreachable assertion is on.

- **`OutputFormat` was published and named nowhere, and `SerializedError` was
  the opposite.** The first is in `dist/index.d.mts`, so it is a type an app
  writes into its own signatures, and the README did not mention it -- which is
  the class `testing-helpers.test.ts` closed for its own section, an export
  nobody can find. The second is the payload the README now tells every
  serializer to branch on and was **not** exported at all, so an app following
  that instruction had nothing to narrow to. It moved to `types.ts` beside
  `OutputFormat`, which is where the other public types are, and both are named
  in the README.

- **And the header claimed `Unknown option` where the answer is silence.**
  `parser/format.ts` said that a command which did not opt in answers
  `mycli dashboard --format json` with `Unknown option` "rather than a silent
  no-op" -- and measured, it exits **0** and serializes nothing, because
  `allowUnknownOptions` defaults to true and an undeclared option produces a
  value rather than erroring. The _test_ was honest all along: it asserts the
  empty output **and** the `Unknown option "--format"` an app that turned the
  setting off gets. So what was wrong is the sentence, which is the dangerous
  half -- a reader would report the silence as a bug. What the opt-in really
  buys is said instead: the option is in no registry, so it is on no help
  screen, in no reference and in no completion script.

- **Every command line in the demo's own header was run**, which no round had
  done, and every one of them does what the header says. `demos/README.md`'s piped
  lines likewise.

- **And one measurement of mine was wrong in the way this file keeps
  recording.** Regenerating `src/i18n/keys.ts` looked like it had produced an
  **empty** key set -- 108 deletions -- and the generator had written 107 keys
  correctly: it writes unformatted output and `pnpm fmt` is the documented
  second step, so a `grep -c "^  '"` against the unformatted file matched
  nothing. A figure that disagrees is a harness to go and read. The committed set
  is byte for byte what the generator produces.

#### What the PR review round found, and the copy that ships

Two comments, **both confirmed before they were believed**, and both are prose
contradicting the code beside it -- which makes this the **fourth** pass here to
find a defect in its predecessor's own output, after rounds two and three each
did the same. That is the pattern this file records rather than a run of bad
luck: code written in answer to a review is code no review has seen, and the
cheapest round to arrange is the one aimed at the last round's fixes.

- **The `Unknown option` claim was fixed in the module and left in the
  declaration, which is the copy that ships.** Round three's own entry above
  records correcting that sentence in `parser/format.ts`, and
  `Command.format`'s doc said it too -- so the fix landed in the one a
  maintainer reads and not in the one that **ships**: `Command` is re-exported
  by `index.d.mts` out of the `types-*.d.mts` chunk the doc physically sits in,
  which is what an editor shows an app author on hover. Measured end to end before anything was
  changed: `mycli dashboard --format json` on a command that did not opt in
  exits **0** and serializes nothing, and `Unknown option "--format"` is the
  answer only with `allowUnknownOptions: false`. Which is the
  fixed-in-one-place-and-left-in-another class, in the worse of the two places.

- **And the second paragraph of the same doc was the fifth copy of a sentence
  round one corrected in four.** It said whether the command's own drawing
  reaches the terminal "is the framework's decision, so there is no `if (json)`
  to write", where the framework **cannot** decide that -- it could only suppress
  a command's own stdout by patching `process.stdout.write`, which a spawned
  child writing to the inherited fd walks straight past. `format.ts`, the README
  and `demos/README.md` each say the narrow thing already: no command branches on
  **which** format, and a command drawing its own human form to stdout reads
  `state.format` or draws to stderr. The declaration now says it too.

- **The figures were measured rather than copied from either side, and what a
  figure means depends on what its measurement asked.** `dist.test.ts` said
  11,991 B and AGENTS.md said 9,648 B, and the comment in that file claims to
  record "the same figure AGENTS.md records, because two comments disagreeing
  about one measurement leave a later reader with no way to tell which was
  measured" -- so the disagreement was in the file whose own comment is written
  about it. Re-measured: the root entry is **11,991 B over seven modules**
  against `main`'s 8,166 B over six, so the delta is **3,825 B** rather than
  either side's 1,482 or 3,823; the `format` chunk is **3,160 B**; and
  `components.mjs` is **245,744 B over 29** against `main`'s 242,297.

  The **loss refusal** is the one worth the entry, because the two numbers in
  the tree were both honest and were answers to different questions.
  **1,615 B** is the walk's own cost, measured by replacing `json()`'s body with
  a plain `JSON.stringify` in a worktree and letting the shaker drop what
  nothing then reaches -- and 2,341 B is what round one's **whole commit** added,
  which is the chain-rule fix, the async serializer, the `outputFormats()`
  refusals and the control-character guard as well. Neither figure was wrong; the
  sentence naming one of them was. So the method is written beside the number,
  which is the only thing that stops the next reader comparing two measurements
  of two different things.

- **And `assertSerialized()`'s bullet still said JSON's `NaN` rewrite "is left
  alone", which round one's own fix had made false.** Measured:
  `{ a: NaN }` through `--json` is `JSON writes NaN as null (at "a")` on stderr
  with exit 1, and so is an infinity. What is still left alone is the residual --
  `-0`, a symbol key, a non-enumerable property, an invalid `Date` and an empty
  typed array -- which is where the `jsonCanHold()` comparison belongs and where
  that bullet now points.

**Four adjacent enumerations were short by one, and this change is what made
them so.** Not named by the round, and the same class as its second finding: the
parser-owned set is `--help`, `--version`, `--quiet` and now `--format` with its
`--json` sugar, and `completion/spec.ts`, `suggest.ts`, `catalog.ts` and the
README each still said three. Which is the defect the quiet axis already records
five instances of, arriving a sixth time -- so each is corrected with the
measurement rather than only the count: the generated bash script lists
`--format` and `--json` beside `--help` and `--quiet`, `--formt` answers `Did you
mean "--format"?` and `--jsn` answers `--json`.

`catalog.ts`'s needed more than a number, which is why counting is not the whole
of it. Its parser-owned skip is a **declared statement** whose safety argument is
that a flag carries a `false` default and the ask pass skips a flag for not being
`required` -- and `--format` is the one parser-owned option that is **not** a
flag, so neither step covers it. What makes it inert there is a third route the
comment did not have: it carries no `env` and no `default`, so there is no way
for it to join `answered` at all, and it is declared `[name]` rather than
`<name>`, so the ask pass skips it too. A count corrected without the clause
would have left the argument false for exactly the option that was added.

The other three readings of that set are each a **contrast** rather than a count
-- `format.ts` twice and `AGENTS.md` once, each naming the three to say what
`--format` is not -- and `catalog.test.ts`'s is correctly scoped: "the flags the
parser adds" really are three, because `--format` is not a flag and is added per
command on opt-in rather than to every schema. Swept and written down so the next
reader finds a decision rather than four more sites to correct.

#### What the second PR round found: the opt-out that was a spelling of absence

Two comments, **both confirmed before they were believed**, and they are the
**second consecutive PR round here to find a defect in its predecessor's own
output**: the chain fix round 1 landed is what made `false` unexpressible, and
the CSV example round 1 corrected in the demo is the one it left in the README.
Which is the pattern this file records rather than a run of bad luck -- code
written in answer to a review is code no review has seen, and the cheapest round
to arrange is the one aimed at the last round's fixes.

- **`format: false` could not opt a subcommand out of an ancestor's format, and
  the error then blamed it for a declaration it had declined.** The severe one.
  Options resolve across the chain and `registerFormats()` folded `false` into
  absence, so a `dashboard` under a `db` that declares `format: true` took the
  parent's `--json`. Measured on the reviewer's own input before anything was
  changed: `mycli db dashboard --json` turned on quiet, **ran the dashboard**, and
  then exited 1 with `The "dashboard" command returned nothing to present as
  "json". A command that declares "format" has to return the data it presents.` --
  a message naming the one declaration the command had explicitly refused. A
  command that returned a value instead had it **serialized over its own
  opt-out**, exit 0, with nothing saying so.

  The cause is the entry above: the accepted set lived on the option, and `false`
  adds no option. So the declaration is recorded on the **command** and
  `detectFormat()` walks `state.contexts` innermost-first reading it, `false`
  included -- which is the parser's own nearest-declaration rule applied to a
  value that could not previously take part in it. Nothing about a positive
  declaration moved: a command that declared `format` and did not throw has a
  marked option in its own registry, so "the first context with a marked option"
  and "the first context that declared" are the same context, measured.

- **What `false` then does with a token is a **refusal** rather than silence**,
  which is the reviewer's own second option taken over its first. Ignoring it
  makes `--json` a token that parses and does nothing, which this file calls worse
  than one that does not exist; `Unknown option` would be a lie, because the
  option is declared by the ancestor, resolves, and is on its help screen. And a
  name the command **cannot present** already throws, so presenting none is that
  question with the empty answer and gets the same treatment -- which is one rule
  rather than a second. One new key, since a user's argv provokes it: 108.

  It names the command that **ran** rather than the one that declared the `false`,
  and the two differ only for a tree whose middle declared it and whose leaf
  declared nothing -- where the statement is still true of the leaf, because it
  inherits the opt-out. Pinned, so the choice is a decision rather than an
  accident.

- **What is **not** stopped at the opt-out is the validation**, which is the half
  a careless fix loses: every declaration in the chain is still checked, because a
  command naming a format the schema does not provide is a mistake wherever in the
  chain it sits and a child opting out does not excuse its parent. `should still
  refuse a bad declaration above an opted-out command` is the pin, and the
  sabotage that stops the walk fails exactly it.

- **The README's CSV serializer wrote broken data, and it is the version round 1
  had already corrected in the demo.** Three defects, each **silent**, and read
  back through a real CSV parse rather than compared to a string: a row named
  `charlie "big, loud"` came out as `['charlie "big', ' loud"', '31']` -- three
  fields where the header names two -- because the name was interpolated
  unescaped; the error message came out as `['cannot read \a', 'b\""']`, two
  fields of nonsense, because `JSON.stringify` writes `\"` where CSV wants `""`;
  and `'error' in value` is a `TypeError` for the `null` this very section says
  the framework presents.

  The example an app author copies being the naive one while the demo beside it
  carries `csvCell()` with a comment explaining why is the
  fixed-in-one-place-and-left-in-another shape, in the worse of the two places.

- **And the reviewer's fix was itself incomplete, which a test is what found.**
  Guarding the `in` moves the throw rather than closing it: `isError(null)` is
  then `false` and the data branch reads `null.rows`. Measured -- `should not
  throw for the null the framework presents` failed on the first run with `Cannot
  read properties of null (reading 'rows')`. So both branches are guarded, and
  the demo's own `toCsv` took the same `?.` so that the two agree; it was
  unreachable there, because that demo's commands return `{ rows }` or throw.

- **Nothing in this repository checked a block of the main README, which is how
  it shipped.** The config README's own test closed that class for its page --
  "a block quoted in a comment is a copy nothing compares" -- and the main one
  had nothing. So `the README's CSV serializer` reads the fenced block **out of
  the README**, evaluates it, registers it as a format, and runs it through a
  real `main()`: the hostile name and the hostile message each have to read back
  whole through an independent RFC 4180 parse, `null` and a primitive must not
  throw, and the two escaping helpers have to be character for character the
  demo's. Each of the five sabotages of the README's text fails exactly one of
  them.

- **`docs/parser.md` never learned `format` exists**, which is the gap this file
  already records for `afterRun` one feature along: that document is the one the
  README points a reader at for the parser's own semantics, and a reader of it
  could not have discovered the option, let alone the opt-out. One row in the
  command-property table and a section saying that the nearest declaration
  governs.

**What it costs is 118 B on the `load-command` chunk and nothing anywhere else.**
The root entry is **11,991 B over seven modules**, `components.mjs` 245,744 B over
29 and the `format` chunk 3,160 B -- all three unchanged to the byte, re-measured
against the base commit in a forced build rather than inferred, because the
opt-out is `detectFormat()`'s and that is behind the `await import()` every entry
figure here is about. `parse-*.mjs` did not move either.

**Eleven sabotages, eleven caught**, each by a small named set rather than by the
suite at large -- the two halves of the recording, the refusal, the validation
walk, the command the message names, the option's marker, and all five of the
README's and the demo's escaping. Run again after `oxfmt` reflowed the test file,
because a pattern that goes stale reads as a guard that is not load bearing.
