# `:` as a topic separator, a tokenizer alias and nothing more — how it was arrived at

The review rounds, sabotage passes and by-hand audit passes behind
[packages/sigil/src/parser/AGENTS.md](../../packages/sigil/src/parser/AGENTS.md). The decisions themselves are
there; this is the record of what each round found, which is kept
because a finding nobody wrote down is one somebody re-discovers.

#### What the sabotage pass found, and the guard that passed its own

Four mutations, one at a time with the new test file run after each. Three are
caught and the fourth was not, which is the only interesting one.

- **Dropping the registry swap** — `if (loaded !== found)` written `if (false)`,
  so a refused path's load is thrown away. Caught by one test, `should keep a
  refused path's loads rather than dropping them`, which is the test that had to
  be constructed rather than found: the obvious assertion is on the **deepest**
  command, and that one resolves either way because reading a directory route's
  level mutates the placeholder in place. What is lost is the intermediate
  command's own module, so the assertion is `config`'s `desc` and `run` rather
  than `set`'s existence.

- **Committing a partial path** — `return undefined` written
  `return chain.length ? chain : undefined`, which is the rule the whole feature
  rests on said wrongly. Caught by **five**: the two values that resolve half way,
  the refused-load test, the `parse` hook divergence, and the help message. Five
  rather than one is what says the rule is load bearing in more than one place.

- **Dropping the separator from the usage line** — caught by two, the `--help`
  form and the `help <path>` form, which are two code paths to one line.

- **Dropping the empty-segment guard** — `segments.some(...)` written
  `return segments`, and **all 40 tests still passed**. The guard changes no
  answer, because `find()` refuses an empty name one step later anyway. What it
  buys is that `db:` -- a trailing colon, which is something a _value_ has --
  never **loads** `db` to find out what is under it. So the choice was to delete
  it as an unreachable guard or to pin what it actually does, and what it does is
  worth keeping: a test counts loads through a `load` function, asserts `0` for
  `db:` and `1` for `db:migrate`, and the second half is there so the count is a
  measurement rather than a schema that cannot load at all. The guard now fails
  its own sabotage.

#### What the by-hand audit found: the help plumbing was already there

The ticket's own risk was the help half -- "a reasonable thing to drop if the
help plumbing turns out to be the expensive half". It turned out to be nothing:
`HelpTarget` has carried a `schema` since the usage line needed a program name,
and `resolveHelp()` already builds `{ contexts, schema: state.schema }`. The
first draft of the help tests called `renderHelp(result.help!)` directly, which
is a `HelpRequest` and has no schema -- so they failed, and the failure read
exactly like missing plumbing. What was missing was the test using the path
`main()` uses.

#### What the self-review found, and both were contracts the space form already kept

Neither was caught by a test, because neither had one. Both are properties the
two `parse.ts` call sites for the space form state in comments, and the first
version of `resolveTopic()` had quietly dropped them.

- **A matched command has to be in the chain before its module loads**, so that
  a module which will not load is an error that command's own `beforeError`
  hooks still see. The first version loaded without committing anything, so
  `db:migrate` over a `db` whose `load` throws fired the schema's hook and not
  `db`'s, where `db migrate` fires both. The walk grows `contexts` as it goes
  now and splices back off what it added when the path is _refused_ -- a
  refusal is a token that was never a path, a throw is a command that really
  did match. Pinned against the space form's own answer rather than in
  isolation, which is what makes it a statement about the two agreeing.

- **A `ParsedCommand` carries the segment as it was typed.** The first version
  recorded `cmd.name`, so `d:m` reaching `db` and `migrate` through their
  aliases put `['db', 'migrate']` on `state.$` where the space form puts what
  argv said. The space form passes `arg.inputs` through for exactly this
  reason.

#### And a measurement that moved a module

The first version put `topicSeparator()`, `splitTopic()` and `resolveTopic()` in
one file under `src/parser/command/`. Everything passed. The bundle is what
objected: `src/help/index.ts` importing that module put `load-command.ts` and
its graph on the `./help` entry, **161,274 B over 22 modules to 178,555 B over
25**, to read a one-character answer. Splitting the dependency-free half into
`src/util/topic.ts` -- which is `src/util/fuzzy.ts`'s own move, made for the
same reason in the same direction -- brings it to 161,674 B over 23, which is
the 291 B shared chunk and nothing else.

Worth recording because the type-check, the linter and all 7,507 tests were
green over the version that cost 17 kB. Nothing in a build measures an entry's
graph except `dist.test.ts`'s ceiling, and that ceiling is on the **root**
entry, which this never touched: 11,991 B over 7 modules before and after, byte
for byte, because none of it is on the path that answers `--version`.
