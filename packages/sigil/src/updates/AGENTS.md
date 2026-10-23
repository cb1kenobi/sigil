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
- **The parent builds the registry URL; the worker is handed it.** The worker is a
  string piped into `node --input-type=module`, so nothing can import it, stub its
  `https`, or call one function out of it -- anything it computes is observable
  only by making a real request, and a test suite here does not make those.
  Encoding a package name is exactly the kind of thing that has to be pinned by a
  test, so it happens in `registry.ts` where a test can reach it. The rule
  generalizes: what the worker decides for itself is what nothing else can check.
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
