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
- **Unreffing the child's stdin cannot cost the worker the script it is being
  fed.** An unflushed write is a libuv _request_, not a handle, and `unref()` only
  touches handles -- measured: a parent with every pipe unreffed still stays alive
  for a two-megabyte write to a child that is not reading. So stdin joins its two
  siblings in the loop rather than being the one pipe left holding the event loop
  open on a path whose whole point is to hold nothing.

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
