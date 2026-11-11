# `packages/sigil/src/updates` — deliberate decisions

These are the entries from [../../../../AGENTS.md](../../../../AGENTS.md) that are about this directory. Claude Code loads this file when it
works with files here; other agents should read it before changing
anything in this area. The root `AGENTS.md` holds the rules that apply
everywhere and still applies in full.

How each of these was arrived at — the review rounds and sabotage
passes — is under [docs/history/](../../../../docs/history), linked from
the entry it belongs to.

## Deliberate decisions — do not "fix" these

### Updates

- **A package name is percent-encoded into the registry URL and out of the cache
  filename.** It is one path segment and it is not a filename, and a scoped name
  -- which is what this framework publishes under -- was wrong as both.
  Interpolated raw, `/-/package/@ttylabs/sigil/dist-tags` asks for a package
  called `@ttylabs` with `/sigil/dist-tags` trailing. registry.npmjs.org happens
  to accept `%40scope%2Fname`, `@scope%2fname` and the raw slash alike --
  verified by hand against the real endpoint, never from the suite -- but
  `registryURL` is the caller's, and a self-hosted registry behind a
  path-normalizing proxy owes nothing.
- **The cache filename was a collision, not a broken write.** Worth saying plainly,
  because the obvious reading of `join(cacheDir, '@ttylabs/sigil-latest.json')` is
  a file in a directory nobody created, and that is not what happened: `check()`
  creates `dirname()` of the whole path, so the scope was created too and the
  cache merely scattered a level down. What was actually broken is that a dash
  cannot separate a name from a tag when a name may contain one -- `a-b` at tag
  `c` and `a` at tag `b-c` were one file, and two packages sharing a cache file
  share a version, so one of them is told the wrong thing to upgrade to. The
  transform therefore has to be _injective_, which percent-encoding is; the `@`
  separator is the same argument, since `encodeURIComponent()` leaves `-` alone
  but never leaves an `@`, so splitting on it recovers exactly what went in.
- **The parent decides everything; the worker is handed it.** The worker is a
  string piped into a runtime, so nothing can import it, stub its `https`, or
  call one function out of it -- anything it computes is observable only by
  making a real request, and a test suite here does not make those. The rule
  generalizes: what the worker decides for itself is what nothing else can
  check.

  It used to be the registry URL alone, and the worker still read the dist tag
  out of the response. Now it decides **nothing**: the parent hands it a URL
  and some headers, and it caches the response **verbatim**, so reading a
  version out of a body is `versionFrom()` in the parent where a test reaches
  it. That is what made a GitHub checker free rather than a second worker --
  the two differ only in a URL and which key the version sits under, both of
  which are now data.

  What it costs is a cache format change, and the cost is paid rather than
  worked around -- by one rule that turns out to cover two cases. **A cache
  is stale when it is old or when this checker cannot read a version out of
  it.** A cache written by an older sigil holds `version` and no `body` at
  all, which is the first; an app whose `updateCheck` changed is the second,
  because the cache file is keyed by package name and dist tag rather than by
  checker, so yesterday's npm dist-tags sit where today's GitHub release
  should be and `versionFrom()` finds nothing at `tag_name`. Either way the
  entry is fresh and unreadable, and left alone that is `latest: undefined`
  for a whole `checkInterval` on an app that looks like it is checking.

  It refetches on every run whose answer carries no version, and that is the
  right way round rather than a cost: an answer with no version in it is not
  a successful check, and caching it is how a check comes to look like it is
  working.

- **A cache stamped in the future is stale, with a minute of tolerance (SIG-376).**
  Only "too old" was asked, `ts + checkInterval >= now`, so a cache written
  while the clock was ahead -- a bad RTC, a VM resumed from a snapshot, a home
  directory restored from another machine -- was fresh until real time caught up
  with it. Measured: stamped 400 days ahead, `check({ wait: true })` answered
  from it in 1 ms with no fetch, and would have for 401 days, with `force` the
  only way out. Fresh is now `ts <= now + 60s` **and**
  `ts + checkInterval >= now`. The minute is for a clock NTP nudged back between
  the run that wrote the cache and the one reading it, which is jitter rather than a wrong clock and
  should not cost a fetch per run; it is not more because a stamp further ahead
  than that is the case this exists for. A `ts` that is not a number is stale
  too, and asked by type rather than left to the comparison: a string of
  digits holding the current time passes `ts <= now` numerically and then
  `ts + checkInterval` concatenates into something twenty digits long, so only
  a type check catches it. A number that is not finite needs no guard of its
  own: Infinity fails `ts <= now`, -Infinity fails the age check and NaN fails
  both, which is why there is no `Number.isFinite()` beside the `typeof`. The worker writes `ts` and never reads it, and
  `notifyInterval` is still a `TODO` with no stamp of its own, so the rule has
  one definition, `isFreshStamp()` in `stamp.ts`, and two readers: `check()`,
  and `sigil package`'s runtime-listing cache (`cached()` in
  `packages/cli/src/build/runtimes.ts`, SIG-420, the entry below). Tested in
  `test/updates.test.ts` against a local listener that counts connections.

- **The worker times out its own request, because nothing else will.** `https.get()`
  has no timeout, and on the default `wait: false` path the parent's timer is
  unreffed precisely so the check costs the run nothing -- so a registry that
  accepts the connection and then says nothing left a node process alive for as
  long as its socket was, with the CLI that spawned it long gone. It is an
  inactivity timeout, which covers a stall partway through a response as well as a
  first byte that never comes; destroying the request surfaces through the `error`
  handler that already exits non-zero. `timeout: 0` opts out in the worker the same
  way it skips the timer in the parent, and a whitespace-only `REQUEST_TIMEOUT`
  is refused rather than read as that opt-out, because `Number(' ')` is `0` and a
  variable nobody meant to set must not be how the timeout gets switched off.
  What it does not cover is a registry that dribbles: one byte every
  `timeout - 1` ms resets an inactivity timer forever. That is the same deadline
  the parent's timer means when the parent is still alive, and closing it in the
  orphan case means a second, absolute timer whose expiry would have to mean
  something different from the option's name -- left alone deliberately, and
  written down here rather than discovered again.
- **The response gets its own `error` listener, because the timeout does not
  cover a body that stops half way.** A connection dropped mid-body destroys the
  socket, and the inactivity timer goes with it, while `end` never comes because
  the response did not finish -- so nothing settles the promise and the worker
  waits forever. It does not surface as an uncaught exception either, which is
  why it reads as a process that simply never exits. Measured, not reasoned; it
  is untested in the suite for the same reason the URL moved out of the worker,
  since reaching it means a real TLS server dropping a real connection.
- **The body is bounded, at `MAX_BODY_BYTES`, and the bound is 16 MiB.** It was
  appended to a string for as long as the registry kept sending, so an endless
  answer grew it until the runtime ran out of memory -- in the spawned case, a
  process nobody is watching, and in the in-process case the CLI itself. Past the
  bound the fetch rejects and destroys the request, which is the same exit the
  timeout takes. 16 MiB is deliberately far over anything a checker should be
  pointed at: a dist-tags answer is a few hundred bytes, a GitHub release with
  every asset listed is a few hundred kilobytes, and an abbreviated packument for
  a package with thousands of versions still fits -- so a custom checker pointed
  at something large but legitimate keeps working, and what is refused is a body
  no version lookup needs. The bytes are kept as bytes and decoded once at the
  end, because decoding each chunk turned a character split across two of them
  into two replacement characters. Tested by faking `https.get()` in process
  rather than serving TLS, since the bound is about bytes and a certificate is
  not.
- **Unreffing the child's stdin cannot cost the worker the script it is being
  fed.** An unflushed write is a libuv _request_, not a handle, and `unref()` only
  touches handles -- measured: a parent with every pipe unreffed still stays alive
  for a two-megabyte write to a child that is not reading. So stdin joins its two
  siblings in the loop rather than being the one pipe left holding the event loop
  open on a path whose whole point is to hold nothing.
- **What a fresh stamp is has one definition, `isFreshStamp()`, and it is
  published because two packages keep a stamped cache (SIG-420).** A finite
  number, no more than `CLOCK_TOLERANCE` (a minute) ahead of the clock and no
  more than `maxAge` behind it. `check()` reads its cache through it, and so does
  `sigil package` for its runtime listings in `packages/cli/src/build/runtimes.ts`,
  which had the same "only too old" defect SIG-376 found here. It lives in
  `stamp.ts` and is exported from this subpath rather than from a new one: the
  toolchain already imports `@ttylabs/sigil/updates`, and a cache that says when
  it was written is what this subpath is about, so a subpath for one function had
  nothing to argue with. Two copies of the rule is how one of them comes to
  accept a stamp the other refuses. Tested in `test/updates-stamp.test.ts`,
  directly with a fixed `now` and once through `check()` against a local
  listener that counts connections.

### What the update check can and cannot survive

Three defects, one mechanism: the worker was a separate file, fed to a
runtime, through a spelling only Node accepts. The measurements are in
[docs/history/the-update-check-cannot-survive-a-build-a-bun-or-a-binary.md](../../../../docs/history/the-update-check-cannot-survive-a-build-a-bun-or-a-binary.md).

- **The worker is one module, imported on one path and piped on the other,
  which is what stops there being two fetchers.** `check()` imports
  `worker.ts` when the app is a single-file executable, and `workerSource()`
  reads the same file as **text** and pipes it into the runtime on every other
  path. Being both costs two rules and neither is this module's invention: it
  imports `node:` builtins and **types** and nothing else, because a piped
  script cannot resolve a relative import and an `import type` erases; and it
  is TypeScript piped into a runtime that strips types on the way in, which
  every runtime this package supports does -- `engines` says node >=22.19.0,
  stripping has been on by default since 22.18, and `bun -` reads it natively.
  That is the same guarantee that already lets a command module be a `.ts`.
  Verified piped on both runtimes for `import type`, top-level `await` and an
  appended call.

  The alternative was a second fetcher for the in-process path and it is
  refused: the two would share the checker and nothing else, and forty lines
  of `https` plumbing in two copies is how one of them comes to handle a
  dropped connection and the other does not.

- **It is `['-']`, not `['--input-type', 'module']`.** Bun reads the
  space-separated form as a **script path** and fails with
  `Script not found "module"`, and `bun --input-type=module` with a script on
  stdin prints its usage text instead -- so the default update check could not
  run at all on one of the two runtimes this framework packages apps with. A
  bare `-` reads a module from stdin on both, with imports, env, top-level
  `await` and the inherited `cwd` all intact. It is `WORKER_ARGV` rather than
  a literal because the first test of it grepped `index.ts` for the flag and
  matched **the comment explaining the flag**; a constant the spawn and the
  assertion share cannot do that.

- **The worker is baked into `dist/` as a string, because a file nothing
  imports is a file no bundler can see.** `get-version-worker.js` was read off
  a path relative to `import.meta.url`, which points wherever the bundle was
  written -- so it worked from `node_modules` and every app `sigil build`
  produced died on `ENOENT` the first time it checked for an update, with the
  build reporting complete success. The root `AGENTS.md` entry about an app
  reading files relative to `import.meta.url` says that is the app's problem;
  this was the **framework's own module** doing it, which that entry does not
  cover.

  `tsdown.config.ts` replaces `worker-source.ts` wholesale with the bytes.
  From source there is nothing to replace it and the file is right there,
  which is what keeps the worker lintable and type-checked and what keeps both
  paths piping the same text. Two things guard it, because this is exactly the
  shape that works from source and fails once built: `test/dist.test.ts` reads
  the shipped bundle for both ends of the worker and for the **absence** of a
  worker file to read -- leaving one there would let a build that stopped
  baking go on working from `node_modules` while every bundled app failed --
  and `packages/cli/test/update-check.test.ts` builds an app that calls
  `check()` and runs it. Removing the plugin fails both, and the built app
  reports `ENOENT ... worker.ts`, which is the original defect exactly.

  The plugin also refuses a `worker-source.ts` with more than one export,
  because replacing a module whole means an export added later works from
  source and vanishes once bundled -- which is this same defect again. That
  is not hypothetical: it happened once while this was being written.

- **A compiled binary has no runtime to spawn, so it checks in process -- and
  checks nothing until it is told what to check.** Inside a single-file
  executable `process.execPath` is **the app's own binary**, so the spawned
  path would re-execute the CLI rather than start a runtime. Answering "not
  compiled" wrongly is therefore not a check that fails, it is an app that
  runs itself again, which is why `compiledHost()` has runtime probes under
  the baked answer rather than trusting the build alone: `Bun.main` is
  `/$bunfs/root/<name>` in a Bun executable and the real path otherwise, and
  `node:sea`'s `isSea()` answers for Node -- asked second and inside a `try`,
  because that builtin does not exist on Bun at all.

  The probes run even when the build already said `compiled: false`, and that
  is a decision rather than an oversight: a `sigil build` bundle somebody
  then compiles themselves is a binary whose baked answer is wrong, and the
  thing it would do is re-execute the app. What it costs was measured rather
  than assumed -- the `node:sea` import is **0.1ms**, and the Bun branch
  never reaches it -- so there is nothing here worth trading correctness
  for.

  npm stays the default for an app that is **not** compiled and there is
  deliberately no default for one that is. npm is the right answer for
  something somebody installed and a guess for a binary somebody downloaded,
  which may well not be published anywhere -- and a check that silently never
  reports anything is worse than none, because the app looks like it has the
  feature.

- **What that costs is the one thing spawning bought, and the default keeps
  the promise rather than the result.** A worker outlives the CLI; an
  in-process fetch cannot. So the default unreffs the request's socket, which
  is why this is `node:https` rather than `fetch()` -- `fetch()` exposes no
  handle to unref, so with it the only available behaviour is holding the
  process open, and "costs the run nothing" is the promise the default path
  exists for. Measured in a Bun binary: the default returns in 6ms and the
  cache is **empty** at exit, `linger: true` and the cache is written.

  That emptiness is the honest cost of the chosen default, not a bug -- a fast
  CLI will not outlive its own check. `linger` holds the loop open after the
  CLI's work is done and `wait` holds up `check()` itself; they are two
  options rather than one because they wait in different places.

- **The baked answer reaches `check()` as a `define`, not through the
  schema.** The version and the default locale are baked into the schema
  literal because that is what `main()` is handed -- and `check()` is a
  library function an app calls wherever it likes, with no schema in its hand.
  `transform.define` is the one thing that can replace a value inside a
  dependency the bundle inlined, verified against rolldown 1.2.15 reaching a
  module under `node_modules`. Unbuilt, nothing replaces it and the read goes
  through `typeof`, which is the one operator legal on a name nothing
  declared.

  Three answers rather than two, and the third is the one worth naming:
  `checker` present is what to check, `checker: null` is the app declaring it
  checks **nothing**, and the key **absent** is the app having said nothing at
  all. Only the third falls through to the npm default, and collapsing the
  first two would make `"type": "none"` mean "use npm" in an installed app.

- **A runtime that cannot be started is an `error` on the child, and so is a
  script it never read -- each on its own emitter.** The worker listened for
  `close` and nothing else, and a spawn that fails -- `ENOENT` or `EACCES` on
  `process.execPath` -- is not an exit code: it is an `error` on the
  `ChildProcess`, and one with no listener is an uncaught exception. On the
  default path that lands after `main()` has resolved, so a command that
  succeeded printed its output, then a Node stack, and exited **1** -- measured,
  with `execPath` pointed at a file that is not there (SIG-248). The listener
  rejects the same promise `close` settles, which on the fire-and-forget path
  is already caught and logged; `close` still follows, with a code of `-2`, and
  finds the promise settled. With `wait` the caller gets a rejection it can
  catch, the same as a timeout, and `beginUpdateCheck()` catches that too.

  The audit the ticket asked for found a second one: the three pipes are
  emitters of their own and none had a listener either. A runtime that exits
  without reading stdin closes the read end, and a write still in flight fails
  `EPIPE` on `worker.stdin` -- measured with `true` as the runtime and a
  two-megabyte script. Each pipe now logs and does nothing more, because
  `close` still comes and is what says how the worker ended. It cannot be
  provoked with the real script today, which at about nine kilobytes is written
  into the pipe buffer before the child has started; `test/updates-pipes.test.ts`
  swaps in a script that does not fit, which is what the real one becomes the
  day it grows. The in-process path was checked and has nothing missing:
  `fetchJSON()` listens on the request and the response, a socket's errors
  reach the request, and the cache writes are synchronous inside a promise
  somebody catches.

  The spawn failure is tested from `packages/cli/test/update-check.test.ts`
  rather than from here, because what it costs is a real process's exit code
  and stderr -- and a spawned node can only import this package from `dist/`,
  since its sources import `.ts` files by `.js` specifiers.

### An update check that is switched on rather than called

`Schema.updateCheck` and `src/updates/auto.ts`. `check()` is the mechanism and
this is the policy around it -- when a person is there to be told, what to look
up, and when to say it -- so that an app writes one line instead of a call it has
to place, a result it has to compare and a message it has to word. The probes
and the pty runs are in
[docs/history/an-update-check-that-is-switched-on-not-called.md](../../../../docs/history/an-update-check-that-is-switched-on-not-called.md).

- **It is the schema's, and `sigil.json`'s `updateCheck` is a different thing
  with the same name on purpose.** The schema says _whether_: it is where an app
  already declares its `name`, its `version` and its hooks, and a switch for
  something `main()` does belongs beside them. `sigil.json` says _where to look_,
  and exists because a binary has no default and a bundle cannot read that file
  at run time. Neither implies the other: declaring a checker enables nothing,
  because `check()` called by hand has always worked that way, and switching the
  check on declares nothing, because an installed app needs no declaration. A
  binary needs both, and `sigil package` refuses one that has only the first.

- **Nothing is fetched where nothing can be shown.** The notice is for a person
  at a terminal, so `skipReason()` is asked _before_ the check starts rather than
  before it prints: stderr is not a terminal, `--quiet` or a `--format` was asked
  for, `CI` is set, or `NO_UPDATE_NOTIFIER` is. A script that runs a CLI two
  hundred times a day should not spawn a worker, write a cache and make a request
  on each to learn something nobody will read. The two environment variables are
  the conventions that exist -- `CI` is set by every CI system, and
  `NO_UPDATE_NOTIFIER` is what update-notifier has taught a decade of tools to
  honour, so a user who set it once has set it for everything -- and `''`, `0` and
  `false` read as _off_, because `CI=false` is how a variable is turned off and
  honouring it literally would silence the check for somebody who said no.

- **It is started before the command and reported after it, and each half has a
  reason.** In an app with a runtime the worker outlives the CLI either way. In a
  single-file executable the fetch happens in this process and can only finish
  while it is alive, so the command's own running time is the window it gets, and
  a check begun after the work is a check begun on the way out of the door. It is
  _reported_ after the work and only after work that succeeded: a notice
  following an error is a second thing to read at the worst moment, `--help` and
  `--version` return before a command runs, and a command that set a failing exit
  code has said it did not succeed. Last, so it is the final thing on the
  terminal rather than something the command's own output scrolls past.

- **What it reports is the previous run's answer, and the first run says
  nothing.** That is `check()`'s own contract -- it returns what the cache held
  and refreshes it for next time -- and the alternative is a command that waits
  on a registry before it starts. A fresh install is told on its second run.

- **`isNewer()` is semver order, and a version it cannot read is never newer.**
  `latest !== current` tells somebody running a build _ahead_ of the published
  one -- a developer on `main`, a release candidate -- that they are out of date,
  on every run, forever. Pre-releases follow semver: a release outranks any
  pre-release of it, numeric identifiers compare as numbers and rank below
  words, and the shorter set is the smaller. A calendar version or a git sha is
  not semver and is never called newer: a check that cannot tell says nothing,
  and the alternative is a notice on every run for a scheme nobody declared a
  comparison for. An app whose versions are not semver writes its own `message`.

- **A pre-release or build identifier is never empty (SIG-376).** `VERSION_RE`
  had the dot inside the identifier class, so `1.0.0-a..b` was a pre-release
  of `a`, `''` and `b`, and newer than `1.0.0-a` -- and `1.0.0-a.`, `1.0.0-.a`
  and `1.0.1+a..b` were all read too. Semver forbids an empty identifier, so
  each part is now dot-separated non-empty identifiers, with the dot outside
  the class, which keeps every repetition unambiguous and the match linear.
  This pattern is also the gate that keeps a hostile registry answer or a
  poisoned cache off the terminal, so the change
  could only narrow it: the tests pin that an escape sequence, a C1 `CSI`, a
  NUL, a `DEL`, a space, a tab, a newline or a carriage return inside a
  version is still unreadable, and write out the fourteen kinds of valid
  version that still compare as they did. Those cases were run against the old
  pattern as well, and passed there, which is what "as before" means.

- **The version is trimmed where it is read out of the answer, not where it is
  compared.** `isNewer()` trims both sides, so a registry answering `"\r1.0.1"`
  was newer than `1.0.0` -- and the notice printed what `versionFrom()` handed
  back, which still held the carriage return, so the line read
  `1.0.0 → \r1.0.1` and the terminal drew the rest of it over its own start.
  Trimming in `versionFrom()` is one reader for every consumer: the notice, a
  custom `message`, and an app calling `check()` itself all get the same string
  `isNewer()` judged. An answer that is only whitespace carries no version, so
  it is the stale-cache case above rather than an empty `latest`. Nothing past
  whitespace can reach the notice, because `VERSION_RE` is anchored and a version
  it cannot read is never newer.

- **The default text says a newer version exists and not how to get it.** An npm
  package, a downloaded binary and a Homebrew formula are each updated
  differently, and a command that is right for one is a wrong instruction for the
  other two. `message` is how an app that knows says so; an empty string prints
  nothing. It goes through `__`, so it is translatable, and
  `src/i18n/keys.ts` carries its key.

- **The package name is baked from the manifest, because the program and its
  package are different facts.** `@ttylabs/cli` publishes `sigil`, and an
  automatic check has the schema's `name` in hand and not the package's. The
  build writes the manifest name into the baked config whether or not anything
  was declared, and the order is `packageName` option, then the baked name, then
  `schema.name` -- the last being right for the unscoped, same-named package that
  is most apps and wrong for the rest, which is what the first two are for.

- **No cache directory means no check, not a check that never reports.** The
  fire-and-forget path leaves its answer in the cache, so without one it would
  spawn a worker on every run and never tell anyone anything -- which is worse
  than not checking. The directory defaults to `cache(<program name>)`, encoded,
  since a scoped name would otherwise make its scope a directory.

- **A binary needs `linger: true`, and the default is the one that was chosen,
  not the one that works.** Measured on a packaged Bun binary at a terminal, with
  a cold cache: the default left the cache **empty** after the run, so no notice
  ever appeared for a CLI that exits in milliseconds; `linger: true` took about
  0.4 s on that one run, wrote the cache, and the next run cost 47 ms against a
  42 ms baseline. The default stays best-effort because that was decided for
  `check()` -- it costs the run nothing, which is the promise the unreffed socket
  exists to keep -- and because flipping it for the automatic path has a cost
  that is not obvious: with `linger`, a network that _never answers_ costs
  `timeout` on **every** run, since a failed fetch writes no cache and so the
  next run is stale too. A refused connection or a DNS failure returns at once,
  so the common offline case is cheap and a blackholed one is not. That trade
  belongs to the app, so it is documented on the property rather than chosen for
  everyone.

- **Nothing in it can fail the command.** An update notice is the least
  important thing the program prints. `beginUpdates()` in `main()` cannot reject,
  `beginUpdateCheck()` catches everything it does including a `version` function
  that throws, and the finisher catches a `message` that throws -- each tested,
  because a bug in a notice is not an excuse for a non-zero exit.

- **`updateCheck` takes a checker on its own, and tells it from the options by
  shape.** A binary has one thing to say -- where to look -- and `{ checker: x }`
  was a level of nesting around exactly that. `isChecker()` is a `type` and a
  `url` that are strings and a `path` that is a list, and the options cannot
  satisfy it: the ones that name a place do it through `checker`, so none of
  them is called `type` or `url`. The bare form is `{ checker }` and nothing else,
  normalized in one function (`updateCheckOptions()`) so the schema's value is
  read in one place. A half-written checker is _options_ -- its `type` and `url` are
  ignored, so in plain JavaScript it checks npm, silently -- and the types are
  what catch it, since the options have no such properties and a literal with
  them is an excess-property error. Refusing it at run time was left alone: the
  check cannot fail the command, so the refusal would be a log line.

- **The graph stays clean for an app that did not ask.** `auto.ts` is reached by
  one dynamic `import()`, inside `main()`, behind `schema.updateCheck`. The worker
  string, the cache and the spawn are in chunks `index.mjs` reaches only through
  it -- checked by reading `dist/`, since a static `import` added to the wrong
  module would put the 8.9 kB worker string -- a 14.7 kB chunk with the check around
  it, as of this change -- into every app, and no test of the feature would notice. The worker's chunk is shared with `updates.mjs` now, so the dist guard
  reads `staticGraph('updates.mjs')` rather than the entry alone.

- **The parent never loads `node:https`, because the worker asks for it
  (SIG-328).** The parent imports `worker.ts` for `WORKER_ARGV`, `WORKER_ENTRY`
  and the in-process fetch, so a static `import https` there put `tls`, `net`
  and `http` on every run of an app that declares `updateCheck` -- a fresh
  cache, which is most runs, included. `fetchJSON()` asks
  `process.getBuiltinModule('node:https')` instead, which is synchronous, hands
  back the object `vi.spyOn(https, 'get')` spies on, and works piped: the worker
  fetched over https on node 24.18 and 26.10 and on bun 1.2.23, 1.3.14 and
  1.4.4. It still imports `node:` builtins and types and nothing else, so the
  piping rule above holds. `child_process` in `index.ts` is asked for at the
  spawn for the same reason. The chunk `main()` imports went from 6.90 to 3.42 ms
  of a fresh node's import. The comment in `worker.ts` is two lines on purpose:
  the file is baked into `dist/` as text, comments and all.
