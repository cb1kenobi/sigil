# A config watcher that survives our own atomic write — how it was arrived at

The review rounds, sabotage passes and by-hand audit passes behind
[packages/sigil/src/config/AGENTS.md](../../packages/sigil/src/config/AGENTS.md). The decisions themselves are
there; this is the record of what each round found, which is kept
because a finding nobody wrote down is one somebody re-discovers.

#### What the sabotage pass found, and the two it declared

Seventy-seven mutations, one at a time with a green control first and the four
verdict guards this repository has learned to need -- a pattern that matched
nothing, one that matched more than once, a replacement equal to its original,
and a run that found fewer tests than the control, each its own verdict rather
than a pass -- with the tree restored on `SIGINT` and `SIGTERM` as well as on an
exception. **Seventy-five caught and two declared**, in two passes: fifty-nine
over the feature and eighteen over the fixes the review produced, which is the
gap every round leaves.

Three of the verdict guards fired, which is why they are there. One mutation left
a `try` with no `catch` and came back as a **test count moved** rather than as a
guard nothing caught; two more were **equivalent** rather than dead, and both
were aimed at a `try`/`catch` by replacing the `catch` with a `finally` -- where
a `return` inside a `finally` overrides the exception, so the mutation did
exactly what the original did.

Three guards were **deleted** for being inert, and one of the three was a mistake
the review caught: the poll disposer's latch really is inert, because
`unwatchFile(path, listener)` answers for a listener it does not hold; `notify()`'s
copy and membership check are inert because the one caller sets a timer and
disposes nothing; and the fs disposer's latch **is load bearing** for a sequence
a two-listener fixture cannot reach -- see the review entry below.

Eleven survivors were a guard whose fixture could not reach the branch, and each
got the input that makes it matter. Three are worth naming. `Object.hasOwn` in
`sameValue` is covered by the key-count check for `{a: undefined}` against `{}`
and needs **`{a: undefined}` against `{b: undefined}`** -- the same number of
keys, different keys, `undefined` on both sides of the read. The clamp on
`debounce` is invisible to any assertion on the firing, because vitest's fake
timers emulate node's own 32-bit truncation -- so it is read off what
`setTimeout` was **handed**. And the climb probe leaks one interval per hop
without its guard, which needs **two** hops: with one, `settle()` is reached once
with the watch away from where it wants to be and a version that made a fresh
interval per call looks identical.

The two declared survivors are the tests in `createSource()`, and they are
**equivalent spellings** rather than guards: `assertWatch()` refuses a
non-function `source` and a non-boolean `poll`, so what is left of either is
`undefined`, which is falsy. They are written as they are because each says what
the field can hold.

#### What review round 1 found, and it could run nothing at all

Twelve findings and four weak tests, every one confirmed against the code before
it was believed -- and the reviewer's shell was rejected for every call it made,
so all of it is from reading. It said so, which is what made the rest of it
usable. One finding is severe and silent, six more produce a wrong value, a crash
or a silent nothing, and **two of them falsified conclusions the sabotage pass
had just reached**.

- **`diffMerged` dropped a key added under any name `Object.prototype` has, and
  that is the severe one.** `!(k in before)` walks the prototype chain, so
  `'toString' in {}` is `true` and `{}` becoming `{"toString": 42}` left
  `get('toString')` answering `42` with **every handler told nothing** --
  measured, because an empty diff dispatches nothing and even a
  `watch('toString', …)` handler is reached only through that gated dispatch.
  `__proto__` and `constructor` are unreachable only because `copyValue()`
  refuses them; these are ordinary JSON keys nothing refuses.

  The test written for it then found the other half, which is sharper:
  `before[key]` for a key only the prototype has answers with the **inherited
  member**, so `previous` came back as `Object.prototype.toString` -- a function,
  where `get()` on that view answers `undefined`, because `readPath()` reads with
  `Object.hasOwn`. So the diff and `get()` disagreed about what had been there.
  One `own()` helper closes both.

- **The watcher's `error` path re-targeted without telling anybody.** The branch
  exists for the platforms where removing the watched directory arrives as an
  error rather than an event -- so on exactly those, the watch climbed to the
  ancestor and `get()` went on answering the deleted file's values for the life of
  the process. The climb probe cannot cover it either: it tells the listeners only
  where it **moved**, and the re-target in the error handler has already moved.

- **`sameValue` called `getTime()` on anything answering `[object Date]`.** That
  test honours `Symbol.toStringTag`, so a class instance with
  `get [Symbol.toStringTag]() { return 'Date' }` and no such method answers to it
  -- and an object layer carries a class instance by reference. Measured: a
  `TypeError` out of `apply()` **after** the layer was assigned and the view
  recomputed, so the caller was told the apply failed while the config had
  already changed; in a reload the same throw escapes a timer callback. Both
  sides are asked and `getTime` is read before it is called -- and the
  both-sides half needed its own input, because the `getTime` guard alone lets a
  plain object with a matching `getTime` compare equal to a real `Date`.

- **An `async` handler's rejection was unhandled**, which is the one thing
  `onError` says must not happen, on the half of the handlers apps actually write.
  A `try` cannot catch a rejection and the handler types return `void`, which
  TypeScript assigns an `async` function to happily. And fixing the dispatch was
  **not enough**: both registration wrappers discarded the handler's return, so
  there was no promise to catch -- a second defect of the first one's own shape,
  found by the test for the fix. Duck-typed rather than `instanceof Promise`,
  which is false across realms, and the path form needed its own test because the
  all form's passed with the path wrapper still swallowing.

- **`0` and `-0` published after our own save.** `Object.is` reads them as two
  values and `JSON.stringify(-0)` is `"0"`, so `set('n', -0)` plus `save()` writes
  `0`, the reload reads `0`, and handlers were handed a change nobody made --
  which falsified both the comment that chose `Object.is` and `#publish`'s claim
  that the diff after our own write is empty. `sameLeaf()` is `===` with `NaN`
  added back, which gets both ends right in one expression.

- **A URL `source` was watched as a cwd-relative path**, and
  `ConfigStore.source`'s own doc invites one: "a path, a URL, or nothing". Read as
  a path it climbs from `<cwd>/https:/host` to the working directory and watches
  that, which is a watcher that is dead and says nothing. Skipped and **reported**
  now, because a layer with a source looks watchable where one with none does not
  -- matched on `://` rather than on a scheme, which is what keeps a Windows drive
  letter out of it, since `C:\x` is one character before its colon. Both docs say
  the same thing now, which was the other half of the finding.

- **Two of the sabotage pass's own conclusions were wrong**, and this is the
  entry worth reading twice. The fs disposer's `live` latch had just been
  **deleted** as inert on the strength of a survivor, and the reasoning was about
  the two-listener case: `Set.delete` is idempotent and the size check does the
  work. It misses the sequence where it matters -- dispose both listeners, so the
  entry is closed and `dirs.delete(dir)` has run, then register a third file,
  which makes a **new** entry, then call the first disposer again: `held` is the
  old entry, its listener set is empty, so it re-enters the size branch and
  deletes the _new_ entry from the map, after which the next registration opens a
  second `fs.watch` on the same directory.

  And `MAX_CLIMB` did not climb one level per failure, which both its comments
  claimed: `retarget()` recomputes `deepest(dir)`, so a failure that was **not**
  the directory vanishing -- `EMFILE`, a watcher limit, a permission -- retried
  the same directory 32 times synchronously, and the probe then repeated those 32
  attempts every interval for as long as it lasted. Under `EMFILE`, which is the
  failure a long-running watcher is most likely to meet, that is the recovery path
  amplifying the pressure it is recovering from. The loop breaks on a level that
  did not change now, which makes `MAX_CLIMB` a bound on the depth -- and the
  test named for the climb had a fixture that never removed the directory, so it
  could not reach the branch its own name is about.

  What that says about the method is the thing to keep: **a sabotage survivor is
  a statement about the tests, and reasoning forwards from it to "the guard is
  inert" is the error the animator's `isFinite` entry already records.** Twice in
  one pass here, and both times the reasoning traced the route I had in mind
  rather than enumerating the sequences.

- **`interval: 0` was a busy loop**, which is the entry above; a type-correct
  option producing a permanent spin.

- **Four tests could not fail for the reason their names gave.** A reload
  asserted with `reads() > 0`, which the constructor's own read satisfies -- so it
  passed with the reload deleted. A shadowed change asserted with `dirty`, which
  is `false` before the event too, so it passed with the lower layer's watcher
  never registered; it reads the store's own read count now. A latch named for a
  handler's throw, which the dispatch catches first -- where the `finally`'s real
  job is the **three early returns** inside the `try`, since a `return` there
  skips anything after the block. And two named for a log nothing observed.

- **And the demo's own `save()` step wrote to the wrong layer.**
  `config.set('editor.theme', 'dark')` with no layer name picks the **topmost
  writable** one, which in that demo is `runtime`, an in-memory object store -- so
  the user file on disk never moved, no event existed, and the step printed
  "nothing was published" for the wrong reason: not the compare, but nothing
  having been written. In the demo for exactly that rule.

One thing the round got **wrong**, which is why a review is a set of claims to
check: it read the per-layer latch as reachable only through a throw, and
therefore the `finally` as untested. The three early returns are the reachable
case and the sabotage that moves the delete out of the `finally` is caught by
them.

#### What review round 2 found, and the save it could silently undo

Eleven findings, every one confirmed before it was believed, and its shell was
rejected for every call too -- so like the round before it, all of it is from
reading, and it said so. One is **severe and silent with a success return**, four
more produce a wrong answer or a crash, and the rest are prose or a test that
cannot reach what it names. It also **falsified two claims this section makes**,
which is the half worth reading first.

- **A reload landing inside an `await save()` discarded the value being saved,
  and `save()` returned the layer as written.** `#reload()`'s own doc argues that
  `readSync()` makes it atomic -- "a second event's reload cannot start inside it
  and there is no race for a latch to fix" -- which is true of a reload racing a
  reload and says nothing about an **async save**. `save()` yields at
  `await store.read()`, so a debounce firing there cleared `touched`, reassigned
  `value` to the file's own, and `#staged()` then claimed no paths and wrote back
  the document it had read.

  Measured on a store whose `read()` yields across a macrotask, which is what
  `fs.promises.readFile` is: the file kept `{a: 1}`, memory reverted to `1`, and
  the return said `['user']`. Silent data loss with a success return, which is
  the worst class there is -- and worse than the documented "a reload overwrites
  an unsaved `set()`", because here the set was _being persisted_.

  The first attempt to reproduce it **passed**, which is the part worth keeping:
  with `debounce: 0` and a `Promise.resolve()` read, the microtask drains before
  the `setTimeout(0)` macrotask and the read always wins. A race that needs a
  macrotask boundary cannot be staged with microtasks, and a test that stages it
  wrongly reads as the code being fine.

  So `#saving` is a **second latch** rather than a wider `#reloading`, because
  the two refusals mean opposite things about the file: one is already reading
  those bytes, so dropping is right, and the other is about to **write** them, so
  the only way to be right is to read again afterwards. Which is why that refusal
  **re-schedules** and the other does not -- and it terminates by construction,
  since the reload that follows reads back what the save wrote and compares equal
  to what `#saved()` held. Dropping it instead would be the timer-based
  suppression point 6 refuses, swallowing somebody else's write in the same
  window. `saveSync()` needs none of it and provably cannot: it is `readSync`,
  `#staged`, `writeSync`, `#saved` with no `await` in it, so no timer can fire
  inside it.

- **And the save latch was a `Set`, so two overlapping saves of one layer
  released it early -- which is the round-2 finding again, reached through two
  saves rather than one.** `save()` is public and `async`, so two of them for
  one layer overlap on any app that does not await the first, and a `Set`
  records that a save is running rather than **how many**. The first one's
  `finally` therefore deleted the only record while the second was still
  awaiting its own read, and the reload the latch exists to refuse got straight
  through.

  Measured before anything was changed, on the shortest sequence that reaches
  it: `set('a', 2)`, `save()`, then `set('b', 3)` and a second `save()` while
  the first is still awaiting its read -- `#targets()` sees the layer as dirty
  and includes it in both. Release the first, and in the window before the
  second's read resolves a `set('c', 4)` is **discarded from the file and from
  memory** with `save()` reporting success: `dirty` went `false` mid-save,
  `get('c')` answered `undefined`, and the file came back `{a, b, external}`
  with no `c` in it. Which is the same class as the round-2 defect and the same
  reason -- a reload cleared `touched` and reassigned `value` inside a save --
  so the latch was right about what to guard and wrong about when to let go.

  A **depth** per layer is the fix: increment before the `try`, decrement in the
  `finally`, and delete the entry only at the last one out. `#reload()` keeps its
  own `has()`, which a `Map` answers unchanged, so nothing on the refusal side
  moved. `#reloading` needs no depth and that asymmetry is worth stating rather
  than copying: a reload is synchronous from end to end, so it cannot overlap
  itself, and what it guards is re-entrancy from inside its own dispatch rather
  than a second caller.

  `saveSync()` needs none of it either, for the reason already recorded: it is
  `readSync`, `#staged`, `writeSync`, `#saved` with no `await` in it, so no
  timer can fire inside one.

  Found by a review round pointed at the branch after CI went green, which is
  the pattern this file keeps recording -- the previous round's own fix is where
  the next defect is. `should hold the save latch until the last overlapping
  save of a layer is out` is the pin, and what it observes is the **latch**
  rather than the loss: `dirty` mid-save plus the value surviving, because the
  downstream loss needs an interleaving a test should not be built around.
  Sabotaged by making the `finally` delete unconditionally, which fails it with
  `still dirty mid-save: expected false to be true`.

- **And then it only took the latch for the layer the loop had reached, so a
  second dirty layer in the same save lost its changes -- which is the same
  defect a third time, and the latch has now been wrong once about _when_ to let
  go and once about _how many_ to hold.** `#targets()` decides every layer a
  `save()` will write before the loop starts, and the increment sat **inside**
  the loop -- so a later target was unprotected for exactly as long as the
  earlier ones took to read and write. One event in that window is enough, and
  an app with both files in one directory does not even need a second process
  for it: a directory watcher fires for both, so `user`'s own temp-file write is
  itself an event for `local`.

  Measured before anything was changed, on two dirty layers with only the first
  one's read held: `save()` answered `['user', 'local']` while `local`'s file
  came back `{b: 1, external: 9}` -- the `set('b', 2)` **gone from the file and
  from memory**, `get('b')` back to `1`, and nothing reported. The same silent
  loss with a success return, for the third time, by the third route: inside one
  save of one layer, across two overlapping saves of one layer, and now across
  two layers of one save.

  The fix is to take the latch for **every** target before the first `await` and
  release them all in one `finally` after the last, keeping the depth. Which is
  the honest shape rather than the minimal one, because a release keyed on the
  layers that **completed** leaks the latch for the one that threw and for every
  target after it -- and a leaked save latch is not untidy: `#reload()`
  re-schedules rather than dropping, so the layer is deaf for the life of the
  process _and_ re-arms a timer every window for ever. Measured on a save whose
  first write rejects: nothing published, `get()` never saw the other process's
  key, and two timers were still pending ten windows later.

  That third shape **survived** the pass before the test for it was written,
  which is the one worth recording: the two obvious sabotages -- the per-layer
  acquisition and dropping the depth -- are each caught by exactly the test named
  for them, and "release only what was written" was caught by nothing at all. So
  there are three tests and three mutations now, one per axis of the latch:
  `should hold the save latch for every layer one save will write, not one at a
  time`, `should hold the save latch until the last overlapping save of a layer
  is out`, and `should release every latch a failed save took, not only the
  layers it wrote`.

  `saveSync()` needs none of it, for the third time and the same reason: no
  `await`, so no timer fires inside one.

- **The `fs` source watched the directory of the **link**, so a symlinked config
  was never watched where it is written.** `writeAtomic()` resolves through a
  link on purpose -- `realPathOf()` is 80 lines about doing it correctly, and
  `write.test.ts` establishes the layout as first-class -- and the watcher took
  `dirname(resolve(path))`, which is the link's own directory. An editor saving
  the real file replaces an entry in the **target's** directory, so the watch
  sees nothing, the probe believes itself settled, and `get()` answers stale
  values for the life of the process.

  `realPathOf()` is **exported** rather than resolved a second time, which is the
  rule this repository keeps everywhere: two readers of "which file does this path
  name" is exactly how a watcher comes to watch a directory the writer never
  writes in. What it gives up is the link itself being **re-pointed** while the
  app runs, which is the same call `writeAtomic()` made and for the same reason.

  And it needed a **tolerant** wrapper, which the review did not predict and the
  existing suite caught within a minute: `realPathOf()` **throws** for anything
  but the file not being there, because for the writer a failed resolution means
  the write cannot land. `ENOTDIR` is reachable from an ordinary config path whose
  parent is a regular file -- there is a climb test for exactly that shape -- and
  a throw there escapes `#start()` and kills the whole watch. So a refusal falls
  back to the path as named and the climb walks past it, which is what the climb
  is for.

  What it is pinned by is **not** the real-watch test, and the measurement is the
  reason: macOS resolves the link for us -- FSEvents is path-based, 6/6 -- so the
  sabotage that removes the resolution is caught **1 run in 6** there. The
  platform-independent claim is _which directory was watched_, which
  `watch-fs.test.ts` already instruments, and there it is caught every time. Both
  tests exist, and the weak one says in it that it is the integration half.

- **`URL_SOURCE` was dead for every real store, which is the one that
  falsified its own test.** It matched `://`, and a source reaches `#start()`
  through `expand()`, which ends in `normalize()` -- so
  `json('https://host/cfg.json')` reports `https:/host/cfg.json` with **one
  slash** and the guard never fired. Measured end to end: no error, the path
  handed to the source, the climb to the working directory, the dead watcher the
  guard exists to prevent. A scheme with no slashes at all -- `s3:bucket/key`,
  which `ConfigStore.source`'s own doc invites as readily -- was the same hole by
  the other road. And the test that pinned it used a **stub store** whose
  `source` bypassed `expand()`, which is why it passed throughout.

  It is a **scheme of two or more** and a colon now, with nothing about slashes
  in it, which is RFC 3986's production minus the one-character case -- because
  that is exactly a Windows drive letter. All four drive spellings are excluded,
  `C://app` among them, which the `://` form had **matched** and refused. What it
  costs is a relative path whose first segment is two or more characters and a
  colon -- a directory named `data:` -- refused and reported rather than watched;
  an absolute path can never match. Loud and rare beats silent and common.

  **And it was still dead on Windows, for the two-slash form, which is the
  common one.** The round fixed the slashes and the one-character case and left
  the half only one platform produces: win32's `normalize()` reads the `//` as a
  separator and makes the result **explicitly relative**, so
  `normalize('https://host/cfg.json')` is `.\https:\host\cfg.json` -- the
  scheme is no longer at the start of the string and an anchored test misses it
  entirely. `s3:bucket/key` kept firing, because it has no slash to trigger the
  prefix, which is why two of the loop's three cases passed there. Caught by CI
  on all three Windows jobs with macOS and Linux green, which is the **sixth**
  instance of that class this file records -- and the first where what was
  Windows-only was a live guard rather than a fixture.

  An optional `.\` or `./` in front of the scheme is the whole fix, because it
  is the same rule: a source is a URL when a scheme opens it, and the prefix is
  `normalize()`'s own noise in front of one. Measured over thirteen shapes on
  both platforms, POSIX is byte for byte unaffected and the two answers differ
  for exactly the two forms win32 prefixes; all four drive spellings, an
  absolute path, a relative one, a UNC path and a bare filename stay watched on
  both.

  What makes it not regress again is that the Windows shape is now pinned **on
  every platform**, fed as a literal through a stub -- which is the opposite call
  from the test above and for the opposite reason: there a stub bypassed
  `expand()` and hid a dead guard, and here `expand()` on a Mac cannot produce
  the shape under test at all, so a literal is the only way that half is visible
  from one. Both are kept, and the sabotage is the old pattern put back, which
  fails with the same `expected 1 to be +0` CI reported. A sibling pins the
  other direction, since the prefix must not take an ordinary relative path with
  it: `./config.json` and `./a/config.json` are watched.

- **`wouldLose` was frozen at its construction value, which is the field's own
  purpose lying.** `types.ts` documents it as the diagnostic an app consults
  before saving, and the watcher is what makes the file change under a live
  `Config` -- so a layer whose file gained a comment the store cannot carry still
  reported `undefined`. Measured: the value moved to 2 and the diagnostic did
  not. Assigned beside `touched.clear()` rather than past the unchanged early
  return, because it is a fact about the file as last read rather than about
  whether the value moved: a file whose comments changed and whose values did not
  publishes nothing and still has a different answer.

- **`sameValue` read `getTime` and then called it unguarded**, which is the
  previous round's own fix one step along: reading it establishes that it exists
  and not that it answers. A class instance with the `Date` tag and a `getTime()`
  that throws, or a `Date` subclass overriding it, threw out of a **predicate** --
  which `#reload()` calls outside the try that routes a read failure, so it
  escapes a timer callback, and which `apply()` calls after the layer was
  assigned. All three shapes measured.

  Writing the test for it produced the better fix, which is the entry worth
  keeping. The first version answered `false` on a throw, and that is **wrong**
  for two structurally equal plain objects spoofing the tag: they really are the
  same thing, so `false` is a spurious publish on every reload -- the one failure
  this predicate exists to prevent. Falling through to the walk instead covers a
  missing method, one that is not a function, and one that throws, in **one rule**
  rather than a `typeof` pair and a `catch` that each answered half of it. So the
  pair went, and both directions of what is left fail a named test.

- **Two async shapes, and both reached the one thing `onError` exists to
  prevent.** `dispatch()` duck-typed `.then` and then called `.catch`, so a
  handler returning a bare `{ then(res) { res() } }` threw a `TypeError` inside
  the `try` and a handler that **succeeded** was reported as a failure of ours;
  `Promise.resolve()` adopts a thenable instead. And `onError` is typed as
  returning `void`, so an `async` one is assignable -- and a `try` cannot catch a
  rejection, so `onError: async (e) => { await log(e) }` produced an **unhandled
  rejection** from a timer callback. Its failure goes to the debug floor rather
  than back through itself, which would be asking a reporter that just failed to
  report its own failure. The sabotage for the second one makes vitest print
  `Unhandled Rejection`, which is the failure the fix removes.

- **Four sentences were false about the code beside them, and one of them would
  have put a defect back.** `sameValue`'s own header said `Object.is` and said
  that `0` and `-0` read as **different** -- which is the behaviour round 1
  removed with a measurement, so a reader trusting the header would have restored
  the spurious publish after our own write. `watch()`'s doc and the README each
  said "every layer with a `source` is watched" and "one watcher per directory"
  unconditionally, where a URL layer is not watched and `poll` is one `watchFile`
  per **file**. The README said a change landing before `watch()` "is not seen",
  where it is not **lost** -- measured, it arrives merged into the next publish,
  which is a better property than the one claimed. And it said the climb's
  re-check is "the only `interval` there is", two paragraphs from the option whose
  own doc gives it two jobs.

- **And the mtime claim, in three stores, named a mechanism the watcher does not
  have.** `file.ts`, `config-yaml` and `config-xml` each said a no-op write
  "keeps the mtime, which is what the watcher reads". The default watcher reads
  **directory events and file contents** and never stats; only `watchFile` under
  `poll` reads an mtime. What skipping the write really buys is that **no event
  fires at all**, which is the better reason anyway.

- **Three test assertions could not reach what they named, and one of them was
  written in answer to round 1.** The poll disposer's claim is that it names
  **its own** listener -- `unwatchFile(path)` with none removes every listener
  for the path, including another config's -- and the `node:fs` mock **discarded
  the listener argument**, so the test could only assert that a second `stop()`
  does not throw, which a no-op disposer passes too. "Survive a close that
  throws" asserted `not.toThrow()` alone, which a disposer that never calls
  `close()` passes; it asserts the flag the mock already tracked, and is now one
  of **five** tests that catch a never-close where it caught none. And the
  both-sides `getTime` assertion used `{ getTime: () => 5 }`, whose tag is
  `[object Object]`, so `sameValue` exited at the tag conjunction before either
  method was read -- a vacuous test written in answer to the round before it.
  Its replacement took two more goes, which is why the input is spelled out in
  it: a tagged **class** instance is not a plain object, so the catch and the
  walk answer the same `false` and no assertion can tell them apart.

- **The demo slept rather than awaiting, so a dead watcher passed it.**
  `step()` waited a fixed 300ms and reported "(nothing was published)", and
  `demos/README.md` said "every step awaits a real filesystem event" -- so with
  the watcher wholly dead the demo printed that six times and exited 0.
  `demos.test.ts` asks for exit 0 and no stack, which made it an acceptance check
  that could not fail. A step expecting a change now **awaits** it and throws if
  it never comes, verified by sabotaging the built `dist/` the demo actually
  imports: it exits non-zero with a stack. A step expecting silence can only
  wait, and what confirms the watcher survived it is the next step's own change
  arriving, which is the sequencing the tests already use for a negative.

- **One lint warning was mine and is the entry this file already carries.** The
  bare-thenable test trips `unicorn(no-thenable)`, which is right about every
  other object here and wrong for the one test whose subject it is. `pnpm check`
  exits zero over a warning, so the standing instruction is to read one on code
  you just wrote rather than exit past it. Obscuring the key was tried twice and
  serves the linter rather than the reader -- oxlint folds a `const` and flags
  `Object.defineProperty` too -- so it is a **block** disable and enable with the
  reason, rather than a `-next-line` a formatter can detach from its target.

Two things the round got **wrong**, which is why a review is a set of claims to
check. It gave `C://app/config.json` as a case the old pattern **missed**, where
it matched it and therefore refused a Windows path -- the opposite error, and the
one the drive-letter test now covers in all four spellings. And it read the
`#reload()` atomicity comment as covering the save case, which was the whole
finding: the comment is correct about what it says and silent about what it does
not.

**Eighteen sabotages over the round's own fixes, all eighteen caught**, run as
each landed rather than in a pass afterwards -- which is the gap this file
records five times over, since code written in answer to a review is code no
review has seen. Two per behavioural fix, so each is pinned from **both**
directions rather than only against the defect: the save latch removed and the
refusal dropped rather than re-scheduled; the link not resolved and resolved
without the tolerance; the old `://` pattern and a one-character scheme; the
`wouldLose` assignment dropped and moved past the unchanged return; the `getTime`
catch answering `false` and no try at all; `.catch` on the thenable directly and
no async `onError` handling. Three for the both-sides `getTime` guard, because
each conjunct alone had to be tried before the measurement showed they are not
individually observable once the catch falls through. And the demo's was run
against the **built** `dist/` it actually imports, since a `src/` sabotage never
reaches it.
