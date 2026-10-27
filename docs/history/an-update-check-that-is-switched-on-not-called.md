# An update check that is switched on rather than called — how it was arrived at

The measurements behind
[packages/sigil/src/updates/AGENTS.md](../../packages/sigil/src/updates/AGENTS.md)
and the update-check section of [packages/cli/AGENTS.md](../../packages/cli/AGENTS.md).
The decisions are there; this is the record of what each probe found, which is
kept because a finding nobody wrote down is one somebody re-discovers.

Follows [the-update-check-cannot-survive-a-build-a-bun-or-a-binary.md](the-update-check-cannot-survive-a-build-a-bun-or-a-binary.md),
which made `check()` work in a built app, a Bun and a binary. This is the
request that came after it: calling `check()` is a step every app has to place,
compare and word for itself, so it became `updateCheck: true` on the schema.

#### The pty runs, which are the claim

Everything in the suite is offline and drives `main()` with a seeded cache; none
of it is a real terminal. The claim is that a _built_ app prints the notice at
one, so it was checked with `script -q /dev/null`, which gives the child a pty.
A built `sigil build` app, cache seeded to say `2.0.0`, app version `1.0.0`:

| situation                        | result                                                                          |
| -------------------------------- | ------------------------------------------------------------------------------- |
| at a terminal                    | `the command ran`, blank line, `A new version of … is available: 1.0.0 → 2.0.0` |
| piped                            | `the command ran` only                                                          |
| terminal, `CI=1`                 | `the command ran` only                                                          |
| terminal, `NO_UPDATE_NOTIFIER=1` | `the command ran` only                                                          |
| terminal, `--quiet`              | `the command ran` only                                                          |
| terminal, `--help`               | no notice                                                                       |

The same run on a packaged Bun binary printed the notice, which is the
in-process path. The arrow is `e2 86 92`, correct UTF-8: it first looked like a
`�` and was `cat -v` mangling the display, checked with `xxd` against a plain
`node -e` write rather than assumed.

#### A binary's default leaves the cache empty

The finding that shaped the documentation. A packaged Bun binary, cold cache, at
a terminal, against the real npm registry (a manual probe; no test does this):

|                               | cold run                    | cache afterwards | warm run       |
| ----------------------------- | --------------------------- | ---------------- | -------------- |
| default, best-effort          | ~1 s (pty startup included) | **empty**        | no notice ever |
| `linger: true`                | 424 ms                      | written          | 47 ms          |
| baseline, check not asked for | —                           | —                | 42 ms          |

The first timing loop reported 26 ms and an empty cache for **both** modes and
looked like `linger` not working. It was the harness: redirecting `script`'s
stdout to `/dev/null` changed how it allocated the pty, and the binary ran
without waiting. `DEBUG=sigil:updates` showed the check running and the cache
written, which is what said the harness was wrong and the code was not. Piping
through `cat` instead gave the table above.

So a fast CLI's fetch never completes under the default, because the process
exits first. Not flipped: with `linger`, a network that never answers costs
`timeout` on **every** run (a failed fetch writes no cache, so the next run is
stale too), where a refused connection or a DNS failure returns at once. That
trade is the app's, so it is documented on the property.

#### Sabotage

Four guards, each removed and the suite run. Three failed tests as they should:
the environment gate (3), `isNewer` degraded to `!==` (6), and awaiting the
notice before the command instead of after it (3).

**The fourth survived, and the sabotage had not applied.** Dropping the
exit-code gate left all 47 passing, which read as a test that could not see the
gate. A debug run with the gate removed showed no notice either way. The cause
was the formatter: it had split `await (await updates)?.()` across three lines,
so the string replace matched nothing and the "sabotaged" code was the real
code. The same false assurance this file's neighbours record for a guard that
reads as load-bearing and is not -- in the opposite direction, a sabotage that
reads as applied and is not. The fix was to restructure the code so it formats
on one line, assert in the sabotage script that the replacement matched, and
rerun: the exit-code test then fails as it should.

#### What the first tests got wrong

- **`settings` is `main()`'s option, not the schema's.** The "command that
  threw" case put `settings: { errorHandler: false }` on the schema, so the
  default handler swallowed the error and `rejects.toThrow` found a resolved
  promise. It reads like a test failing for a real reason and was a misplaced
  property.
- **`pnpm test` found the chunk move before the feature did.** Adding
  `auto.ts` made the worker string a shared chunk, so `dist/updates.mjs` became a
  few re-exports and the dist guard, which read that file alone, failed on both
  assertions. It reads `staticGraph('updates.mjs')` now. The same run found the
  committed key list one short of the source, because the new notice is a `__`
  message; regenerated, and the test reads `dist/`, so it needed a rebuild first.
- **`--out` is relative to the app.** The first pty build used a path relative to
  the working directory, wrote under the app, and the run reported
  `Cannot find module` for a file that existed elsewhere. The first attempt's
  output went to `/dev/null`, so the failure arrived as an empty `ls`.

#### A checker given on its own

`updateCheck: githubChecker({ repo })` is `{ checker }` said shorter, asked for
because a binary has exactly one thing to say and the object form made it say it
one level down. The runtime half is `isChecker()` and a four-line normalizer. The
interesting half was the build.

- **An earlier answer here was wrong, and the change is what made it right.** It
  said a binary that sets `checker` in its schema needs no `sigil.json` entry.
  It did: writing `githubChecker` means importing `@ttylabs/sigil/updates`, which
  is the _import_ signal `sigil package` refuses on, and the schema reader's
  exemption for a `checker` only covered the _schema_ signal. Found by reading
  the gate rather than by a test, because no test packaged an app that did both.
  `package.ts` now lets a schema that names its checker satisfy the import
  signal as well, and a packaged-Bun test covers the app that does it with no
  `sigil.json` at all.
- **The refusal it was written for still holds**, and that is pinned from the
  other side: an app that imports a builder, never gives it to `updateCheck`, and
  switches the check on with `true` is still refused. Relaxing a check is only
  safe if the case it existed for still gets it.
- **`objectLiteral()` looks through a call with one object argument**, so asked
  first it reads `githubChecker({ repo })` as the options `{ repo }`. The call is
  matched first, as a binding of the import. Sabotaged by dropping the match:
  three tests fail, the bare github, bare npm and parenthesized cases.
- **Three sabotages, three caught**: the relaxed gate put back (the packaged test
  fails), the builder match removed (three reader tests), and the runtime
  normalization removed (three `updateCheckOptions` tests).
