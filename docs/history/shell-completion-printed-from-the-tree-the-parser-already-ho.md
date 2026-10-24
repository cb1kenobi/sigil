# Shell completion, printed from the tree the parser already holds — how it was arrived at

The review rounds, sabotage passes and by-hand audit passes behind
[packages/sigil/src/completion/AGENTS.md](../../packages/sigil/src/completion/AGENTS.md). The decisions themselves are
there; this is the record of what each round found, which is kept
because a finding nobody wrote down is one somebody re-discovers.

##### What the three review rounds found, and what the sabotage pass found after them

Each round was pointed at the diff with the ticket's constraints and **not** the
rationale, and each later one at the regions the previous round's own SKIPPED
list named plus that round's own fixes. The distribution is the one this file
keeps recording: round 1 found the runtime defects, round 2 found a composition
between two of round 1's fixes plus a wall of stale prose, and round 3 -- aimed
at round 2's output and at the test files, which neither earlier round had read
-- found the subject/predicate split and four more sentences that were false
about the code beside them.

- **Round 1: 13 findings, 12 confirmed and one refuted.** The marker read as a
  substring of the whole file; the apply layer enforcing nothing, so a `foreign`
  plan with no answer wrote; `PromptError.aborted` ignored, so Ctrl-C recited a
  recipe; `byHand()` direction-blind; the rc needle absolute-only, which reports
  `absent` for ever for the population that followed this package's own recipe;
  an unsanitised `program` that wrote `<data home>/evil` one directory up; the
  bash-completion gate not asking about writability; an uninstall's `changes`
  ignoring the rc line; untranslated read failures, which showed translated
  prompts and then node's English; two weak tests and two false comments. What it
  **refuted** is worth as much: it read `app completion zsh` in a pipe as
  reaching the installer, and the dispatcher sends a named shell to the printer
  whatever the terminal is.

- **Round 2: 11 findings, all confirmed.** The foreign-uninstall composition
  above; the apply layer refusing against the stale plan; `spellings()` missing
  `${HOME}` under a comment describing a "longest first" mechanism the code did
  not have; `W_OK` alone passing a `0o200` directory; every byte figure in two
  files stale by 1,218 B with `dist.test.ts` disagreeing with itself; three
  divergent statements of the data-home rule in the probe; the marker's window
  doing the work its comparison was credited with; `byHand()`'s new branch
  ignoring the shell; the program guard narrower than the other reader's; the
  README saying the installer "refuses to touch" a file it asks about and
  replaces; and two assertions that could not fail for the reason their prose
  gave.

- **Round 3: 10 findings, all confirmed, and 5 of them prose.** The
  subject/predicate split, measured on both of its inputs. `replaceable()`'s
  comment promising a property the data structure cannot express.
  `spellings()`'s two remaining edges -- the Windows absolute spelling and the
  root home. `ours()`'s comment claiming it "closes the class". The mode tests
  under root. A TTY comment describing a question that flow never asks, beside
  two `byHand()` branches with no test. The README's `--uninstall` "never asks".
  `dist.test.ts` still quoting the README sentence it had just contradicted. And
  two in the probe: the `ZDOTDIR` tilde, and an existence claim that is three
  questions now.

  It ran in **Ask mode**, so it wrote no report file and could execute nothing;
  what it did instead was `node -e` pure-path probes, and it re-derived every
  byte figure in the branch against the current `dist/` and found them agreeing.

- **The sabotage pass: 38 mutations, 34 caught, 4 declared, 0 not a verdict.** A
  green control first, every edit asserted to have landed, and the tree restored
  on `SIGINT` and `SIGTERM` as well as on an exception -- because a killed pass
  that leaves a mutation behind poisons the next control and reads as a real
  defect to whoever looks next. A pattern that matched nothing, one that matched
  more than once, a replacement equal to its original, a build that failed and a
  run that found fewer test files than the control are each their own verdict.

  The pattern guard fired, which is the fourth time on this branch: the
  forward-slash case went stale when `spellings()` was rewritten and was reported
  `PATTERN MISSED` rather than as a guard that is not load bearing.

  Eight survived the first run and **two of them were the marker tests written
  for the marker findings**, which is the fixture-cannot-reach-the-branch shape
  arriving in the tests written for exactly that shape: round 1's fixture wrote
  `# not the <marker>`, and once round 2 tightened the comparison to equality
  that line was foreign whatever the window was -- so widening the window to the
  whole file changed no answer. And round 2's own fixture quoted the sentence
  without the leading `# `, so a substring check answered no. Both needed the
  marker written as the emitters write it, in two different positions.

  The others were a missing input each. The bash-completion **directory** test,
  whose one reachable input is an executable file -- measured, because a missing
  path and a non-executable file are both refused by the access check anyway.
  Three interactive gates, which needed the "only the line is outstanding" state,
  a foreign install answered **yes**, and a run whose stdout must be empty. And
  the writer's gate, whose whole input is a foreign uninstall with the rc line
  present -- which is round 2's severe finding end to end.

  The four that stay are each declared where they live. Two are the
  forward-slash rewrites, unreachable on POSIX by **proof** rather than for want
  of a fixture -- `sep` is `/` there, so the rewrite is the identity and the
  `Set` collapses to the list POSIX already had -- and pinned by CI, which is the
  same footing `config-yaml`'s own `rawJoin` survivor is on. One is the
  edge-rather-than-home slice, whose consequence `/` subsumes. And one is the
  probe's `ZDOTDIR` expansion, because nothing in the suite drives that file: it
  is run by hand, and what pins it is having driven it.

##### What the first PR review round found: a recipe that could not work if followed

One comment, confirmed and measured in a real zsh before anything was changed,
and it is the class this file calls the worst kind of prose defect: **the zsh
`fpath` recipe both printed forms carry appended the line with `>>`, which lands
below `compinit`, so following it never loads the completion.**

- **`compinit` is the call that scans `$fpath` and builds the autoload table**,
  so a directory added after it is one nothing ever reads -- and an append lands
  at the end of the file, which is below every `compinit` there is. There is no
  arrangement where it works: a plain `.zshrc` runs `autoload -Uz compinit &&
  compinit` in the middle, Oh My Zsh runs it from `oh-my-zsh.sh`, and a
  `compinit` in `.zprofile` runs before `.zshrc` is read at all. Appending is
  below it in all three.

  Measured in zsh 5.9 against a `.zshrc` of the ordinary shape. Appended after
  the `compinit`, `whence -w _mycli` is **`none`**. Moved one line above it, it
  is **`function`** and `$_comps[mycli]` names it. Then the corrected recipe
  followed literally end to end, with the **real** generated script: `_sigil` is
  autoloaded, `$_comps[sigil]` is `_sigil`, and `autoload +X _sigil` loads the
  body, so the file parses as well as registers.

- **And the command carried `# above compinit` as a comment on the very command
  that puts it below**, in a header **every generated script repeats** -- so the
  recipe stated the constraint it was breaking. Which is the shape this file
  keeps recording: prose that would mislead somebody into a real bug is worse
  than prose that is merely absent, and here it was not prose beside the code but
  the output itself.

- **The probe had it right all along, which is what makes this a drift rather
  than a gap.** `terminal-probe.mjs --completion`'s own docblock records that "a
  file on `$fpath` **before** `compinit` registers in zsh 5.9", and its
  throwaway-directory demonstration puts the `fpath=` line before the
  `compinit`. So the correct ordering was measured, written down and
  demonstrated in the same branch whose printed recipe instructed the opposite
  -- two readers of one shell fact, disagreeing, which is exactly what
  `install.ts` is one module to prevent.

- **It was also the one place left offering the append the installer refuses on
  principle.** `installer.ts` is explicit that it writes the file and _prints_
  the rc line, because a `.zshrc` is under version control as often as not and a
  line we appended cannot be told from a line the user wrote when an uninstall
  comes to take it out. The recipes told the reader to do by hand what the
  installer declines to do for them -- and in the one case where it does not even
  work.

- **So `InstallRoute.add` is a line to place rather than a command to run**, and
  both renderers print it: `installComment()` gives the sentence the inner `#`
  the label already takes, so what a reader lifts out of the block is the line
  beneath it, and `instructions()` puts the sentence at the label's indent and
  the line at the command's. The table says what the installer says, which is one
  answer rather than two.

- **An append is refused only where no append can be right**, which is the half
  worth stating so that the asymmetry is not ironed out later. Both survivors
  were measured rather than reasoned about. `source <(app completion zsh)` **must
  be below** `compinit`, because the script's sourced branch calls `compdef`, and
  the end of the file is exactly that -- `$_comps[sigil]` is `_sigil` after
  appending it. A bash `source` line has no ordering at all, since it runs
  `complete -F`, and `complete -p sigil` reads back
  `complete -o default -F _sigil sigil` in bash 3.2. So this is not the dotfile
  principle applied unevenly: it is the one recipe that cannot work, replaced.

- **And bringing the branch up to date moved three baselines, which is the
  figure hazard this file keeps recording arriving through a _merge_ rather than
  through an edit.** The PR had gone `CONFLICTING` once SIG-145 and then SIG-141
  landed, and a `pull_request` workflow runs against the merge ref -- so a
  conflicting PR has none and **GitHub dispatched no run at all**. The timeline is
  the evidence: the tip got a full run while the branch was mergeable, and the
  push after SIG-141 landed produced zero. What that looks like in the checks list
  is two external Socket checks passing, which reads exactly like a quiet green.

  Both conflicts were the pair this file already predicted for this branch, and
  both resolutions are the recorded ones. `src/i18n/keys.ts` is **regenerated**
  rather than hand-merged -- `node scripts/generate-sigil-keys.mjs` from inside
  `packages/cli` -- which produced exactly the union: 102 keys, which is 77 base
  plus this branch's 24 plus the quiet axis's one, with the count in its own
  docblock being the thing that conflicted. And `test/dist.test.ts` took the
  eight-module shape, because that is what the merged tree has, with every figure
  in it **re-measured** rather than picked from a side: the config graph is
  38,239 B over eight, unchanged, while the root entry is **8,166 B** and
  `components.mjs` **242,307 B over 28** -- figures SIG-142 then moved to 11,991 B
  over seven and 245,744 B over 29, which is that entry's own instruction working
  rather than a contradiction -- neither of which either side said,
  since both branches moved them. Four figures in that one file now agree with
  the tree and with each other, which is what its own comment about two comments
  disagreeing asks for.

  The ten-odd copies in **this** file are left alone, deliberately: each records
  what was measured for its own change, so rewriting them to today's number would
  destroy the record rather than correct it. What is kept is the instruction to
  re-measure, which is the entry those figures already carry.

- **Four guards, five sabotages, all five caught, each by the test named for
  it.** Putting the append back fails the two new route tests; dropping the
  render from `installComment()` or from `instructions()` fails the two-readers
  differential, which now walks the `where` **and** the line for the reason that
  differential exists -- a field rendered twice with nothing comparing the two is
  the drift this module's opening is about. Dropping `compinit` from the sentence
  fails the first test, so the sentence is load bearing rather than decoration.
  And giving a route both a working append and a line to place fails the third,
  which is the inverse that keeps the field from spreading: a route with both
  would be telling a reader to do one thing twice. The two appends that stay are
  an **explicit list** rather than a rule about which routes may append, so that
  a third one is a decision somebody makes.

##### What the second PR review round found: the route that was not where the install was

One comment, confirmed and **measured before anything was changed**, and what
makes it worth the entry is where it was: `runInstaller()`'s one line of target
selection, which **four earlier passes had in scope and none flagged** -- the
three reading rounds and the first PR round, with round 3 having read that very
function and come back with a TTY comment and two untested `byHand()` branches.
So this is not the previous round's output being wrong, which is the pattern
this file usually records; it is a line every pass read as an index because the
list it indexes is documented as being in preference order, and never asked
whose preference.

- **The installer always acted on the first resolved route, so an install could
  land beside an earlier one rather than on it.** `runInstaller()` took
  `installTargets(...)[0]`, which is the **table's** preference -- and for bash
  the table's first is `bash-completion`'s own user directory, which resolves the
  moment that directory appears. So the reported sequence: install on a machine
  without it, which goes to `~/.local/share/completions/mycli.bash` with a
  `source` line the reader puts in `.bashrc`; the directory later appears;
  re-run.

  Measured on that sequence before the fix: a **second** copy written at
  `…/bash-completion/completions/mycli`, both files on disk, the result printing
  nothing but `Then restart your shell.` -- naming neither the old file nor the
  `.bashrc` line -- and `mycli completion bash --uninstall` removing the new one
  and leaving the old one with its line still in place. An upgrade that does not
  land and an uninstall that does not uninstall, from a command that reported
  success for both.

  The half this does **not** rest on is which of two copies a shell loads, and
  it is the one only a machine with bash-completion on it can settle: that
  loader is bound with `complete -D`, which bash documents as applying to
  commands with no completion defined, so a `.bashrc` sourcing our script first
  should shadow it. **Unverified here** -- macOS ships bash 3.2, which has no
  `-D` at all, measured -- and `scripts/terminal-probe.mjs --completion` is where
  a reader with one can check it. The defect needs none of it: two copies of our
  own generated script, with nothing printed about one of them and an uninstall
  that leaves it, is wrong whichever wins.

- **So `installTarget()` is a search where there was an index, and the install
  that is there wins.** Three tiers, and `installer.ts`'s is the module because
  it is the half that stats things and because `ours()` is already there -- a
  second marker reader is the drift that module's opening is about. The full
  argument is on the function; what matters here is that tier 1 over tier 2 is
  about **references** rather than about which loader wins, which is what keeps
  it off the unverifiable premise: an rc-bearing route's file is named by a line
  in a startup file, so moving the install off it leaves that line pointing at a
  file nothing updates, where moving off `bash-completion`'s directory leaves a
  file nothing points at.

- **It reads every candidate rather than one, so a path it cannot read refuses
  the run** where the index installed past it. Measured: a _directory_ at
  `<data>/completions/mycli.bash` with `bash-completion`'s route resolving used
  to install there happily and now throws `readOr()`'s own sentence naming the
  path. The safe direction rather than a cost, and the one this function is for
  -- a candidate it cannot read is one where it cannot tell whether an install
  is there, and reading that as "none" is how a second copy gets written beside
  one sitting at the path nobody could look at. A behaviour change either way,
  so it is documented and pinned rather than incidental.

- **What one call cannot finish is a machine holding two of ours**, which the
  defect produced and which following the printed recipes twice produces too. It
  acts on one and the other stays; a second `--uninstall` takes it out, because
  the next run's search then finds it. Written down rather than guessed at,
  because finishing it means a plan that names two files -- and the one thing a
  guess must not do is delete a second file the reader was never shown.

- **Six sabotages, five caught, one declared.** The search deleted fails three
  of the new tests, tier 1 dropped and tier 1 inverted each fail the
  two-installs test, the marker check fails the test named for it, and the
  `user` route made to stop resolving -- which is what the fallback's
  never-empty claim rests on -- fails 59 of that file's 74.

  **Tier 2 is the declared survivor, and it is the rule rather than a guard**:
  it cannot change an answer with the table as it is, because the only
  resolvable route with no rc line is `bash-completion`'s and that is the
  table's own first -- so a target holding ours with no line **is**
  `targets[0]`. Brute-forced rather
  than reasoned, over every reachable state of the two paths -- absent, ours, a
  stranger's, with the directory there and not: twelve cases, zero differences
  against the two-tier spelling. It stays because deleting it leaves the code
  saying a target holding ours wins _only where it also has a line_, which agrees
  today and would prefer the table over an existing install the moment a second
  rc-less route is added after `user` -- this defect, reintroduced by the
  tidy-up.

- **And the marker test the pass first wrote could not see what it was named
  for**, which is the shape this file keeps recording. Ours at `user` with a
  stranger's file at `bash-completion` answers `user` either way, because tier 1
  reaches it on the rc line whether or not the other file counted. The input that
  separates them is the mirror: the bash-completion directory there and **empty**,
  which is where a fresh install goes, with a hand-written file of the user's own
  at our `user` path. Read as ours that is tier 1's, so the command would point
  at their file and offer to replace it with a clean route sitting unused.

- **`pick()` in the test file is `installTarget()` now**, so the helper's name
  stays true: a case that writes a file and then calls it gets the target the
  command would act on rather than the one the table prefers. All 66 cases that
  existed pass unchanged, which is the check a repointed helper gets.

  What it **dropped** is the `toBeDefined()` that helper carried, which was the
  only thing holding "the list is never empty" -- the claim the fallback rests
  on. So that is a test of its own now, named for it, and the sabotage above is
  what says it is load bearing. A claim a helper asserted in passing is one
  nothing names the moment the helper changes.

- **Three of the cases are end to end over the real binary**, which is where
  the claim has to be: what was wrong is what the command _printed_, and a unit
  test of the plan can say which target it picked while saying nothing about a
  result that named neither the old file nor the line. Sabotaged with a
  **rebuild** in front of it, because `completion-install-tty.test.ts` reads
  `dist/` and without one a mutation in `src/` is invisible to it -- the
  stale-dist trap this file records. The index put back fails the two that pin
  the fix and leaves the first-install control green, which is what says the
  control is one.

- **And the comment citing it named a test that did not exist**, which is the
  dead-instruction class this file keeps recording: a reader goes looking for
  `should resolve a user route for every shell, on a machine with nothing on it`
  and finds nothing. Caught by grepping the citation rather than by a round --
  which is the cheapest check there is on a file that cites its own tests this
  often, and the one the previous round's own fix should have had run over it.

##### What the third PR review round found: the compinit line that is not there

One report, from a real machine, and it is the **first PR round on this ticket
to find a defect in its predecessor's own output** by the shortest route there
is: the first round replaced a `>>` append with a line to place, and the
sentence it placed it with names a line most zsh users do not have. Which is
the pattern this file records four times over -- code written in response to a
review is code no review has seen.

- **The message names "your compinit line" over a `.zshrc` that has none, and a
  framework is why.** `compinit` is the call that scans `$fpath` and builds the
  autoload table, so the `fpath` line has to precede it -- and a framework runs
  it for the reader: **Oh My Zsh calls `compinit` from `oh-my-zsh.sh`**, at
  lines 238 and 243 of it, so a `.zshrc` that sources that file holds no
  `compinit` anywhere. Measured by grepping the reporter's own: three matches
  for `oh-my-zsh`, **zero** for `compinit`, with the shell's completion system
  fully set up. So the instruction could not be followed, which is the first
  round's own finding one step along -- there the recipe named a **command** that
  could not work, here it names a **line that is not in the file**.

  It is the commoner case rather than an edge, which is what makes it worth the
  round: a `compinit` line of one's own is what a zsh user with no framework
  writes, and a framework is what most of them have.

- **Three placements measured, in a throwaway `ZDOTDIR` replicating that
  shape.** The `fpath` line **above** `source $ZSH/oh-my-zsh.sh` registers the
  completion -- `$_comps[sigil]` is `_sigil` and `whence -w` says `function` --
  and **below** it registers nothing at all. As **line 1** of the file, above
  everything, it registers: which is what makes "the top of the file" a measured
  instruction rather than a guess, and is the sentence the fix prints. With no
  framework and no `compinit` at all the line alone registers nothing and the
  line plus `autoload -Uz compinit && compinit` registers.

- **So the anchor is read off the startup file, which costs nothing because that
  file is already read.** `rcStateOf()` reads it to decide whether the path is
  named already; asking the same text whether it holds `compinit` is one more
  question of one read, and `RcAnchor` is the answer. A file with a `compinit`
  line keeps the old sentence, which is precise and names a line the reader can
  see; one without gets "the top of" plus the call to paste.

  It is **not** on `RcAddition`, and that is where a dead `where` field sat for
  the whole of SIG-151: written in `resolveRoute()` and read **nowhere**, while
  `planLines()`'s own doc justified its location by it. It could never have
  answered either, which is the point -- that record is built without touching
  the file system, so the knowledge it was shaped for was not available where it
  sat. The dead-property class this file records for `Command.file` and
  `BundleResult.generated`, with the twist that the field was the right idea in
  the wrong module.

- **The `none` sentence does not assert that nothing runs `compinit`, because
  three states share it.** A framework sources one, a framework this does not
  recognise sources one, or there is no completion system at all -- and "nothing
  there runs compinit" is **false** for the first two. So it says what is true of
  all three: that file has no `compinit` line, a framework's own line is what to
  go above if one runs it, and here is the call if nothing does. One key with
  three lines in it rather than three keys, which is the rule the read-only
  `delete` message already keeps: a sentence per line hands a translator
  fragments and no way to reorder them.

  Offering the call to somebody who did not need it is **measured harmless** -- a
  redundant `autoload -Uz compinit && compinit` after Oh My Zsh's own registers
  the completion exactly as without it -- which is what makes one sentence safe
  for all three.

- **Naming the framework's own line was built and refused, and the refusal is a
  measurement rather than taste.** "above your `source $ZSH/oh-my-zsh.sh` line"
  is the most actionable sentence available and it needs a table of what runs
  `compinit`, of which **exactly one entry is measurable here**: Oh My Zsh is
  installed on this machine and prezto, zim and the rest are not, so every other
  row would be this repository guessing -- which is the call the shells map
  already makes, where "adding one is a module plus a run by somebody who has
  that shell". And the fallback it would refine is measured **correct** for Oh My
  Zsh anyway, since line 1 works. A table whose absence is safe is a refinement
  rather than a fix, and it can wait for somebody with those frameworks to hand.

- **The machine-independent recipe says the general thing, because it cannot
  read anything.** `install.ts`'s route table goes into every generated script's
  own header and into the no-terminal instructions, so it is redirected to a
  file, checked in and generated on a build machine -- there is no startup file
  for it to consult. It says "above whatever runs compinit -- yours or your
  framework's" now. That asymmetry is the module's own design read forwards: the
  shown form is machine-independent and the resolved form is this machine's, and
  this is the one place the knowledge is allowed to be specific because it is the
  one place it is known.

- **Seven sabotages, seven caught, and one harness verdict.** The old sentence
  for every state, the anchor pinned each way, a missing file read as
  `compinit`, bash given the zsh sentence, the call dropped from the `none`
  branch, and the recipe's claim put back -- each fails the test named for it.
  The eighth attempt came back `SURVIVED` and was the harness being wrong rather
  than the code unguarded: the replacement left the `if` **unbalanced**, so the
  file did not transform and vitest reported `Tests no tests` with no `×` line
  for the verdict to read. Balanced as `|| true` it fails three tests. Which is
  the fourth distinct way a sabotage pass has been found to be the thing that was
  wrong here, after a stale pattern, an apostrophe spelled as an escape and a
  `vitest run` whose paths missed -- and the reason a run that produced no
  summary is its own verdict.

  One existing assertion was **sharpened** rather than added to: `should print
  the line to add and never add it` writes a `.zshrc` of `# mine`, which is the
  `none` branch, and asserted `toContain('compinit')` -- which **both** branches
  satisfy now, since one names a compinit line and the other says there is none.
  A test that cannot tell them apart would have passed over the message being
  wrong for everybody with a framework.

##### SIG-155: appending the block, and the three guards the sabotage pass had no test for

SIG-151 printed the rc line and listed "editing a dotfile" as deliberately out.
This reverses that on the user's say-so, prompted by Bun's installer, and the
reversal is narrower than it sounds: what is appended is a marked block, and the
two reasons SIG-151 gave each got an answer rather than being overruled.

**The decision the design turned on, and the measurement that settled it.** The
`fpath=(dir $fpath)` line SIG-151 printed is the one line no append can place --
it has to run above `compinit` and `>>` lands below every `compinit` there is,
which is the first PR round's own finding one section above. So the route the
installer takes is the other one zsh has: the script is `source`d and registers
with `compdef`, for which the end of the file is exactly right, and one file has
served both modes since SIG-139 through the `$funcstack[1]` test.

The only argument against that was lazy autoloading, and it was measured before
it was given up. zsh 5.9, 200 iterations per figure, three runs agreeing within
0.01 ms: sourcing sigil's own 11.5 kB script is **0.20 ms** and a 115 kB one --
the pathological 123-path tree the `what a big tree costs` entry records -- is
**1.88 ms**, so the cost is linear and a shell startup notices neither. The
`fpath` route stays in the table as a recipe to follow by hand.

**A runtime guard dissolved `RcAnchor`.** That type's own doc recorded two things
about itself: that its interesting value conflates three states a framework puts
a reader in, and that naming the framework's own line "was built and refused" for
needing a table of which exactly one entry is measurable here. Neither is a
question any more. `(( $+functions[compdef] ))` asks the shell, at startup, what
the static read had to guess -- `compdef` is a function only after `compinit` has
run, which is precisely what the block needs to know.

Verified in zsh 5.9 in all three shapes, with a counter on the guarded branch
rather than only an outcome, because a redundant `compinit` is not free:
measured, a first call is 172 ms on a cold `.zcompdump` and 17.6 ms warm, and a
second is 11.6-12.2 ms whatever the dump. A bare `.zshrc` runs it and registers
`_mycli`; a `.zshrc` with its own `compinit` above skips it and registers; a
framework sourced above with no literal `compinit` in the file -- the Oh My Zsh
shape, which is the row the table could not previously answer -- skips it and
registers. `COMPINIT_LINE`, `addLines()`'s three sentences and four i18n keys
went with the type.

**What the sabotage pass found: three guards with no test, out of twenty.** The
pass broke each guard this ticket added and ran the two completion suites. 17 of
20 were caught on the first run and each survivor was a real gap rather than a
redundant guard.

`applyRc()`'s **block guard** -- the one that stops a second block being appended
over one already there -- had no assertion at all, because every test called that
function once. The test for it is deliberately the _stale plan_ rather than a
second call over a fresh one: the plan is taken while the file is empty, applied,
and applied again, which is the window a dotfile manager rewriting the file lives
in.

`removeRc()`'s **re-read** likewise. The sabotage replaced it with a fallback
span of `{ start: 0, end: 0 }`, which writes an **empty `.zshrc` where the user
had none at all**, and nothing noticed. Two tests now: the file gone in the
window, and -- the one with teeth -- the file still there with the block replaced
by three lines of somebody's own, where a plan trusted for its line numbers would
cut the wrong three.

The third is the one worth recording at length, because the fix took two goes and
the second was still wrong. `blockSpan()` matches a **whole trimmed line**, and
the test for it wrote both markers inside prose -- prose that happened not to
contain the `#` prefix, so no substring match was possible and the sabotage was
vacuous rather than the guard being untested. Rewritten with both markers
embedded in `echo "..."` lines, it was _still_ vacuous against a sabotage of the
`begin` finder alone: with both embedded, `end` refuses the line it is on and
`blockSpan` returns nothing whatever `begin` did. So a fixture that embeds both
markers can only ever test whichever finder runs second. It is one fixture per
marker now, each with the other on a line of its own, and each of the two
`===`-to-`includes()` sabotages fails it. The destructive direction is asserted
alongside, since what a substring match costs is lines of somebody's own file.

**Two bugs in this branch's own work, both caught by writing the thing down.**
The shown block interpolates a machine-independent path, and `rcBlock()` quotes
what it is given -- so the first version produced
`'~/.local/share/completions/_mycli'`, a quoted tilde, which names a directory
called `~`. That is the exact defect the `InstallLine` doc was written about, in
the entry replacing it. Changed to `$HOME` and it was still wrong, because
`$HOME` does not expand inside single quotes either; **double** quotes expand the
variable and still hold a path with a space in it, and the resolved block keeps
`shQuote()` because an absolute path has nothing in it to expand. Which is why
`rcBlock()` takes its path **already quoted** rather than quoting it: the two
callers genuinely differ. `should spell the shown path so that it expands, which
a quoted ~ would not` is the pin, and the single-quote spelling fails it.

**What was measured about the cost, with a `main` worktree built beside the
branch** so that each figure is a difference between two builds rather than one
carried forward. The root entry is **12,009 B over 7 modules** and the parse chunk
**50,566 over 14** on _both_ -- byte for byte, so the second writer costs the
graphs anybody else pays for nothing at all. The printer grew **+497 B**, which
is `rcBlock()` and the two markers sitting in `install.ts` because the emitters'
headers print them, and the interactive graph **+1,145**, module counts unchanged
on both. It also found the figures in the entry stale by two tickets: 258,740 and
62,371 had become 269,189 and 70,756 on `main`, none of it this feature's.

**The three probe recipes were run before the text claiming them was written**,
which is the rule `--completion` exists for. The sourced route answers
`comp=_sigil`, the `fpath` route answers `comp=_sigil`, and bash answers
`complete -o default -F _sigil sigil`. The step about the `compinit` cache is no
longer about the installed route at all -- nothing goes on `$fpath`, so there is
no dump to go stale -- and it says so rather than being deleted, because the
recipe it still applies to is one a reader may follow. What is genuinely open
moved with it: the guard was never run against a real prezto, zinit or zplug, and
a framework that initialises completion lazily is the finding that step now asks
for.

##### What PR #191's review found: three defects from one changed premise

All three are the same root cause, which is the thing worth keeping: `writes`
counting the startup file is a **premise change**, and two separate pieces of
code were resting on the old premise as prose rather than as a condition.

**A second sigil app on zsh never got its block.** `needles` was matched with a
plain `includes()`, and every block of ours names `<dir>/_<program>` -- which
contains `<dir>`. So installing `one` and then `two` had `two`'s directory needle
hit inside `one`'s block: `rcStateOf()` answered `theirs`, the plan said "already
names it", the script was written, and nothing ever sourced `_two`. An install
that reported success and did not work. The file needle had it too, one name
along, since `_one` is a prefix of `_onetwo`.

The fix is `namesPath()`, and what makes it a rule rather than a patch is that
both are one question -- did the needle end where the path ended. `AFTER_PATH`
enumerates what may _follow_ rather than what may continue, because a program
name may hold `-`, `.`, `+` or `@` and `registerable()` leaves that wide. The
existing tests compared the needle **arrays**, which cannot see where a needle
matches; that is the shape to look for.

**The uninstall crashed, and the wrong question hid it.** `planUninstall()`
returns `writes: true` for `rc === 'ours'` even when `file === 'foreign'`, and
the apply is an object literal -- whose properties evaluate in order, so
`applyUninstall()` ran first and threw for a foreign plan. The refusal reached
the generic error handler and `removeRc()` never ran, so the block stayed. Which
is round 2's crash exactly, reintroduced by the premise rather than by the code.

The third defect is the one the review did not name and is why the second was
latent: `question()`'s `foreign` branch carried the old premise as a comment --
"an uninstall never reaches here, because a foreign file is not something to
write" -- so a reader uninstalling was asked **"Replace it?"**, defaulting to no.
Driven, that prints `? Replace it? no` and `Cancelled`; answer `y` and it prints
`Error: Refusing to remove ..., which sigil did not write.` So the wrong question
masked the crash behind an Enter, and a correct-looking default was doing the
hiding.

**Why the unit test could not see it, which is the transferable part.** `should
take its own block out of a startup file beside a script it will not touch`
calls `removeRc()` and _then_ asserts `applyUninstall()` throws -- the opposite
of the production order. It asserted the right outcome of a sequence the command
does not run. There is a test in the production order now, and a TTY test that
drives the real command, which is what found all three: a comment claiming a
branch is unreachable is only as good as the condition somewhere else that makes
it so, and the cheapest check is to run the thing.

**The sabotage pass needed one more fixture after the fixes.** Seven mutations
over the three, six caught immediately; the survivor was `after === undefined`,
end-of-string, which no fixture reached because every one of them wrote a
trailing newline -- and the first attempt at covering it used `shQuote()`, so the
quote was the delimiter and it passed either way. A **bare** path at the end of a
file with no trailing newline is what reaches it, and that is a real `.zshrc`.
The original 20 were re-run after the fixes and all 20 still fail, so none of
them was blunted.

**And the test count was phantom.** The suite read 7,586 where the real figure
is **7,558**: `dist.test.ts` walks `dist/`, and a turbo cache hit skips the
`rimraf`, so a day of branch-hopping and a `main` worktree build had left 95
`.mjs` files where a forced build leaves 67. Checked rather than quoted, which is
the rule this repository already keeps for every byte figure -- +7 over the 7,551
before these fixes, matching the 7 tests added.
