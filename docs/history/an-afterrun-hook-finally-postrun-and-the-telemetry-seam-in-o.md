# An `afterRun` hook: `finally`, `postrun`, and the telemetry seam in one — how it was arrived at

The review rounds, sabotage passes and by-hand audit passes behind
[packages/sigil/src/parser/AGENTS.md](../../packages/sigil/src/parser/AGENTS.md). The decisions themselves are
there; this is the record of what each round found, which is kept
because a finding nobody wrote down is one somebody re-discovers.

#### What the sabotage pass found, and the two declared survivors

Thirty-seven distinct mutations against the shipped code **in one run**, one at
a time with the six affected test files run after each: **thirty-five caught,
two declared, and no harness verdict**. A green control first, and the four
verdict guards this repository has learned to need -- a pattern that matched
nothing, one that matched more than once, a replacement equal to its original,
and a run that found fewer test files than the control, each its own verdict
rather than a pass. The tree is restored on `SIGINT` and `SIGTERM` as well as on
an exception, because a killed pass that left a mutation behind poisons the next
control.

One run rather than a sum, which took two review rounds to get right. Round 2
asked for the log to be kept, because a tally nobody can re-derive is the same
stale snapshot a byte figure is; round 3 read the log that was kept and found the
prose beside it **still** quoting a different arithmetic -- so what is recorded
now is one invocation over one case file, both on disk, and the figure above is
what that run printed. Nine of the thirty-seven are the fixes review rounds 1
and 2 produced, which is the gap every round leaves: code written in answer to a
review is code no review has seen.

Round 3 also found a real defect **in the harness**: the "edit landed" check was
`count(old) == 0` after the replacement, which is wrong for an _append_ -- whose
replacement contains its own original -- so it reported "edit did not land" for a
mutation that had landed exactly as written. It asks whether the file changed and
holds the replacement now. Which is the fourth distinct way a sabotage harness
has been found to be the thing that was wrong here, after a stale pattern, an
apostrophe spelled as an escape and a `vitest run` whose paths missed.

Both survivors are **equivalent mutations** rather than unguarded code, and the
sharp version of each is caught -- which is the distinction worth keeping,
because reasoning forwards from "no test failed" to "the guard is dead" has
produced a wrong write-up here more than once.

- `typeof hook === 'function'` weakened to `hook !== undefined` survives,
  because the two differ only for a value that is neither, which nothing reaches
  without assigning garbage at run time -- and the per-hook `try` catches the
  `TypeError` either way, so no answer changes. The sharp version, adding every
  source's value including `undefined`, **is** caught: it makes
  `DEBUG=sigil:run` confess a `TypeError` on every command of every app that
  declared nothing, which `should say nothing at all where the app declared no
  hook` is the input for. That test is the claim in its own right as well -- a
  namespace that confesses on every run is noise.
- Taking `fireAfterRun()`'s return value as a replacement result survives,
  because that function returns `Promise<void>`: `undefined ?? result` is
  `result`, so the mutation is self-defeating. Dropping both freezes **and**
  assigning a hook's return onto the result is caught by three tests.

Two guards were **deleted** for failing a sabotage, both in the list
construction and both redundant with the per-source `try`: an
`Array.isArray()` on the chain and a `filter(Boolean)` over it. A `contexts` of
`42` throws out of the spread into one `catch`, and a `contexts` holding a `null`
throws out of `source.hooks` into the other, so each guard was a second answer to
a question that already had one.

#### What review round 1 found, and the two it got wrong

Twelve findings over `git diff main...HEAD`, given the ticket's constraints and
**not** the author's rationale. **One severe defect, one rule worth writing down,
and ten corrections to prose** -- which is the distribution this file keeps
recording for a round aimed at a diff: a deletion-based pass asks whether the code
that is there is load bearing, and a reviewer asks whether a sentence beside it is
true.

- **`collectHooks()` could throw, and then `main()` rejected rather than
  handling.** The severe one, and the module's own doc claimed the opposite ("it
  does not throw -- and not by being careful"). Two reads were outside the guard
  and both are reachable from a command's own `run()`, which is handed the state:
  spreading `state.contexts` after `state.contexts = 42`, and reading
  `state.schema` after somebody redefined it as a throwing getter. Measured
  before anything was changed -- `main()` rejected with
  `TypeError: ((intermediate value) ?? []) is not iterable` and
  `Error: hostile schema`, with **nothing rendered at all**, which is the one
  thing `main()` is documented not to do.

  **And it reproduces on `main` through `beforeError` alone**, which is the
  blast-radius check: the same two inputs, the same rejection, since
  `collectHooks()` was written -- `handleError()` calls it from inside `main()`'s
  own `catch`, so a throw there reaches no handler. Sharing one walk is what makes
  one fix answer for both, and both sides are asserted. Two `try` blocks rather
  than one, because a wrecked `contexts` must not cost the schema its hook; what
  the guard gives up is the **chain**, so a command's own hook is lost and the
  schema's still fires, which is pinned so it is a decision rather than an
  accident.

- **A hook assigned after init has three behaviours and none was written down.**
  The entry above is the rule that answers it.

- **Three "ways round the refusal", all three reproducing and none of them a way
  round it** -- and establishing that took measuring the sibling channel rather
  than arguing. A hook can mutate `result.error` and set its `exitCode`; it can
  mutate the object `result.value` holds; and it can install a `beforeError` that
  then replaces the error. What says none is a hole is that each is a channel the
  app already had: a `beforeError` hook writing `err.message` and `err.exitCode`
  has **exactly** the effect, measured side by side; a command can keep a
  reference to the object it returned and mutate it after returning, measured the
  same way; and `beforeError` may replace an error and may never suppress it, so
  what an `afterRun` reaches by installing one is precisely what declaring one
  reaches. All three are now **differentials** rather than assertions about either
  answer, so deep-freezing the value or the error, or snapshotting the
  `beforeError` set, fails them.

  Deep-freezing was the reviewer's own suggested fix and is refused: it would
  freeze somebody else's object on the way past, take away `beforeError`'s
  documented right to mutate an error, and seal a `Date` or a class instance a
  command handed back. Snapshotting the `beforeError` set before `afterRun` fires
  is refused for its own reason -- a hook installed by a `parse` hook or by a
  `run()` fires, so making `afterRun` the one place where installing one does not
  work would be a special case nobody asked for.

  What was genuinely wrong is the **prose**: the first version of the freeze
  comment said "what is a fact about what happened is the result and the
  duration, and those are the two that cannot be edited after the fact", which is
  false of nested contents. It says what is frozen -- which case the result is
  in, which value or error it holds, and `ms` -- and what is not, with the
  measurements beside it.

- **The freeze _refuses_ a write either way and _confesses_ one only from
  strict-mode code.** An ES module is always strict, so a hook in one is told; a
  hook out of `new Function` or a sloppy `.cjs` body has the write dropped in
  silence and finds out nothing. Which is the host's rule rather than this
  module's, and is the honest limit of "a hook that tried to rewrite what happened
  finds out". Both halves are tests now.

- **And five more sentences were false about the code beside them**: the hook-order
  diagram read as the sequence of every run, where both of its ends are conditional;
  the `beforeError` header said "after `afterRun`" of every throw site, where a
  parse failure reaches it with no `afterRun` at all; "the same value a serializer
  would be handed" asserted a consumer that does not exist; the schema hook's own
  doc said "the only one that sees every command" where it sees every command that
  **ran**; and the README pointed at an `AGENTS.md` entry that had not been written
  yet, which is this section.

Its coverage list named the tests, the README, `init-command.ts` and
`error-handler.ts` as examined, and `testing/command.ts`, the demos, the
`@ttylabs/cli` package and the `dist.test.ts` ceilings as skipped -- which is round
2's worklist rather than a formality.

#### What review round 2 found, and the one it got wrong about the input

Pointed at the files round 1's own coverage list named as **skipped** -- the
whole of `init-command.ts` and `parse.ts`, `load-command.ts`, the `completion`
and `help` commands' own source, `docs/parser.md`, `packages/cli`, the
`dist.test.ts` ceilings -- and at the code round 1's fixes produced, which no
review had seen. Eight findings, **seven confirmed**, and the distribution is
the one this file keeps recording: a round aimed where nobody looked finds
**two mechanism-level surprises nobody had written down, a stale measurement,
and five sentences**, and no new runtime defect in the five files round 1 read.

- **A schema hook fires twice where something replaced it after init**, which
  narrows the "fires once" claim above rather than contradicting the dedupe.
  The root context's `hooks` is a **copy** of the schema's -- which is what
  stops a hook reaching back into the caller's declaration -- so the two objects
  hold the same function until somebody writes to one, and the identity `Set`
  then sees two. One assignment in a `run()` is enough: measured,
  `state.schema.hooks.afterRun = …` gives `['declared', 'replacement']`, and
  the mirror through the root context gives the two the other way round.

  **It reproduces identically on `main` through `beforeError`**, which is the
  blast-radius check and is what makes it the mechanism rather than anything new.
  Not fixed: both sources are needed -- the copy is what a `run()` or a hook
  writes to reach the current run, and the original is what something installing
  a hook before the parse writes to -- so dropping either loses a real case, and
  identity cannot tell a divergence from two different hooks. What a replacement
  wants is to write both, or to wrap rather than replace, which is what the
  README already says. Pinned, so whoever meets it finds a measurement.

- **A lazily loaded command loses its placeholder's hook where the module
  declared _any_ hooks at all.** `loadCommand()` fills a key from the
  placeholder only where the module left it `undefined`, and `hooks` is one key
  -- so a module mentioning an _unrelated_ hook discards the placeholder's
  `afterRun` rather than overriding it. Measured, and measured on `main` for
  `beforeError` too. Every other merged property really is one value; `hooks` is
  a bag of six, and the merge treats it as one where `initCommand()`'s check and
  `collectHooks()` both treat it as six.

  Not fixed, for the reason the entry above gives in a second shape: a per-key
  merge changes what every hook's declaration means on every lazily loaded
  command, which is not a thing to take inside a ticket about one hook. What the
  round also established is the good news -- a module's **own** `afterRun` is
  collected, a bad one is refused by `initCommand()` over the merge with the
  same message an inline declaration gets, and a **default** command's fires
  although argv never named it. All four are tests now, the control included,
  because without it the limitation reads as "a lazily loaded command never
  reaches the walk".

- **The byte figure was stale, and it is the figure this file warns about.**
  It read 7,518 B to 7,947 B and +429; the round measured 8,014 B against the
  dist on disk, and after the two redundant guards came out it is **7,977 B and
  +459**. Which is the number moving three times in one branch -- before round
  1's fixes, after them, and after the deletions they prompted -- so what is
  recorded is the instruction to re-run it. `dist.test.ts`'s own two comments
  about the same entry were stale with it, in the file whose comment says the
  measured figure lives "here and in AGENTS.md and nowhere else" and must agree;
  the config graph's 38,064 B was 37 bytes out on `main` already, and is 38,101 B.

- **`docs/parser.md` never learned the hook exists.** Three tables there -- the
  command-property row, the schema hook table and the command hook table -- and
  none of them had it, so the parser reference and the README disagreed about the
  hook surface. That document is the one `README.md` points a reader at for the
  parser's own semantics, so a reader of it could not have discovered `afterRun`,
  its ordering or its refusal. All three say it now, with a paragraph for the one
  thing that is not like its neighbours: it is the only hook in those tables that
  fires outside `parse()`.

- **"Nothing has set one yet" was false about the exit code, and the framework's
  own `completion` command is the counterexample.** Asked for a script with no
  shell named it writes the reason to stderr, sets `process.exitCode = 1` and
  **returns normally** -- so a hook sees `ok: true` beside an exit code of 1.
  Measured, after the first attempt at reproducing it used `completion bash`,
  which is the form that sets none: the finding needed the bare form, which is
  the reviewer's input rather than the obvious one. The true claim is narrower
  and is in the same paragraph -- no code has been **derived from this result**
  yet, because `errorHandler()` runs after every one of these -- and
  `process.exitCode` is there for a hook that wants what has been set.

- **`initCommand()`'s list is five hooks and `Command.hooks` has six**, so the
  comment this change rewrote -- "one list covers both sides of every hook there
  is" -- was an overclaim of exactly the kind this file treats as a first-class
  defect. `subcommandLoaded` is checked nowhere for a command: measured, a
  `hooks: { subcommandLoaded: 'nope' }` parses, runs fine while nothing loads,
  and fails with a bare `hook is not a function` naming neither the hook nor the
  command the first time a subcommand does. Pre-existing and left alone, because
  adding it changes when a different hook's declaration is refused; the comment
  says which one it does not cover and what that costs.

- **Both sloppy-mode tests could not tell a refused write from a hook that never
  ran.** A `new Function` body closes over nothing, so neither had a side channel
  -- and the second test is _defined_ by the absence of a confession, which makes
  "refused in silence" and "never invoked" the same two assertions. They write
  `d.state.argv.sloppyRan` now, which is an allowed write because `state` is
  mutable, and is the execution witness the strict-mode pair gets for free from
  the confession it provokes.

- **And the trade a wrecked `contexts` makes is wider than the prose said.**
  `push(...iterable)` evaluates the spread whole before it pushes, so an iterable
  that yields two good sources and then throws contributes **neither**, exactly
  as a `42` does -- where the comment described the cost as "a `contexts` that is
  not an array contributes nothing". Not a regression, since the old code spread
  the same way, and the error is never lost either way because the schema is
  collected in a `try` of its own.

**What it got wrong** is worth as much as what it found, and it is one thing: it
reported the `--version` and in-process timing figures as unverifiable under its
own no-benchmark constraint, which is correct, and then listed the sabotage
counts as unverifiable because **no result log survived on disk**. Fair, and
fixed by keeping the run's output beside the case files rather than by arguing:
a tally nobody can re-derive is the same stale snapshot the byte figure was.

It also confirmed, by reading rather than by assuming, the four things most worth
doubting: `fireAfterRun()`'s statements can none of them throw after round 1's
fix; the two `try` blocks leave no read outside a guard; the three differentials
can each fail for the reason their names give; and `packages/cli` declares no
`hooks` the new name collides with and emits none that would drop an `afterRun`
from a built app.

#### And the full suite found a test of mine passing for the wrong reason

Not a reviewer and not the sabotage pass: the one full run at the end printed a
stray `Error: Invalid run function in "noop" command` to stderr, out of a test
named `should fire nothing for a run: null` which captured **stdout**. `run` is
typed `| null`, so `null` reads as the spelling for "this command dispatches
nothing" -- and `initCommand()` refuses it outright, so the parse failed and
`afterRun` was silent for the reason every parse failure is rather than for the
reason the name gave. Which is the defect this file is written against, in a
file written against it, invisible to both the sabotage pass and three review
rounds because the assertion held throughout.

It asserts what `run: null` really does now, with `beforeError` beside it to say
the run failed, and a sibling covers the shape it reads as -- a command with no
`run` at all, which dispatches nothing, prints its help and exits zero. The
lesson is narrower than "read the output": a test that captures one stream and
asserts an absence on the other is one whose premise nothing checks.

#### What review round 3 found: no error-path defect, and four figures

Pointed at **the error paths exhaustively** -- which is where an ordering defect
hides -- at round 2's own skipped list, and at the code round 2's fixes
produced. It walked about thirty-five ways a value can be thrown between
`main()` being called and `main()` returning, measuring each against the built
`dist/` with the hooks counted and both streams captured, and found **no
behaviour defect at all**. The findings are four figures and a harness bug, and
the error-path audit's value is the table rather than a fix.

What it established, and the structural reason each holds:

- **Twenty-one throw sites inside `parse()`, and not one reaches `afterRun`.**
  Every one of them -- a missing required option, a bad `choice`, a coercion
  failure, an unknown option, an unexpected argument, a missing argument, a
  module that will not load, a caller's `transform`, `beforeParse`, `afterParse`,
  `init` or `parse` hook, a `desc` thunk, a `version` function, a missing value,
  an option handed a second value, three shapes of invalid schema, a variadic
  hint and a malformed format -- fires `beforeError` once, `afterRun` zero times,
  resolves `main()`, renders, and exits 1. And **none can reach `run()` first**,
  because `run()` is only invoked after `parse()` _returns_ and every one of
  those leaves through `parse()`'s single catch. The load-failure row is the
  subtle one and is also right: a matched command whose module will not load is
  already in `state.contexts`, so its own `beforeError` sees it, and `run` was
  never called.
- **A deleted working directory** goes through the ordinary path, because
  `assertCwd()` sits inside `main()`'s own `try`: `beforeError` once, `afterRun`
  none. A **catalog loader that rejects** is the one pre-parse failure that
  produces no error at all -- it is logged under `sigil:i18n` and English stays
  in effect, which is the documented rule that a broken translation must not fail
  a parse -- so the command runs and `afterRun` fires `ok: true`.
- **Printing help can fail, and then `beforeError` fires with no `afterRun`.** A
  `help` hook that throws, a `help` renderer that throws, and a `stdout.write`
  that throws mid-help each resolve, render and exit 1. Which is the one "a run
  that never happened" shape where something did fail, and it was pinned nowhere.
- **A thenable is a promise to this code.** `await cmd.run(state)` assimilates
  any `{ then }`, including one whose `then` throws and one whose `then` _getter_
  throws; all three fire `afterRun` exactly once. And `Promise.reject(undefined)`
  carries the tagged union all the way out -- `throw result.error` throws
  `undefined` and the handler renders `Unknown error`.
- **A `run()` that never settles has no result and no answer**, which is worth
  stating because "fires after `run()` returned or threw" quietly assumes a third
  case: `main()`'s promise never settles, `afterRun` never fires, and with no live
  handle the process simply exits 0 with the pending call abandoned. A `finally`
  for a call that never returns is unreachable by construction. The same is true
  of an awaited **hook** that never settles, and of `beforeError`.
- **A hook can throw something nothing can inspect and the walk survives it**,
  which is `safeLog()`'s whole job: `Console.log` formats its argument before
  writing, so a thrown object whose `message` and `name` getters throw throws
  _inside_ the logging of it. Measured safe, as is a hostile
  `inspect.custom`. And a `DEBUG=sigil:run` line written to a stdout that throws
  loses the line rather than the run, because `debug()` writes through an
  intermediate `Writable` whose machinery absorbs it -- which covers the timing
  line too, and it uses the raw `log` rather than `safeLog`.
- **A custom `errorHandler` that throws rejects `main()`, and `afterRun` had
  already fired once.** The rejection is documented -- "that is a bug in the
  handler" -- and the composition was not: a telemetry hook must not lose the run
  because the app's handler is broken.
- **And an `afterRun` that calls `main()` recursively** fires each call's own
  hook once with the right `cmd`, with no interference. There is no reentrancy
  guard, so an _unconditional_ recursion dies of stack -- which is an app
  recursing through a public function, exactly as a `run()` that does it is, and
  that one is a supported shape with a test.

Five of its coverage gaps are closed rather than noted, chosen because each pins
a claim the structural argument was carrying alone: the thenable, the rejection
with `undefined`, the help-printing failure, the uninspectable thrown value, and
the throwing custom handler. The rest are left to the structural argument, which
is strong and is written down: there is one exit from `parse()`.

The four figures, each confirmed by re-measuring:

- **The sabotage tally could not be re-derived from the log round 2 asked be
  kept**, which is that round's own fix being incomplete -- the log was preserved
  and the prose beside it was not reconciled with it. One run over one case file
  now, both on disk.
- **The harness's "edit landed" check was wrong for an append**, which is the
  entry above.
- **`dist.test.ts` held two contradictory figures for the components graph**,
  130 lines apart: 234,912 B over 23 against the 239,929 B over 26 the comment
  round 2 corrected quotes, which is the two-comments-disagreeing defect that
  very comment is written about, surviving in the same file. And the testing
  subpath's comment quoted the root entry at 7,532 B in the present tense, which
  `afterRun` moved -- so that sentence now says it is a measurement of **that**
  change rather than of the tree.
- **`src/completion/index.ts`'s header was a third copy of the root-entry
  figure**, at 7,553 B, in a source header describing the current tree. It states
  the claim -- the entry is exactly what it was without that feature -- and points
  at the two places the number lives, which is the rule `dist.test.ts` states and
  which a header cannot keep by carrying a number nothing re-measures.
