# The suite removes every directory it makes — how it was arrived at

The measurements behind "The suite removes every directory it makes" in
[packages/sigil/src/testing/AGENTS.md](../../packages/sigil/src/testing/AGENTS.md).
The decisions are there. This is the record of what was measured, kept so that
the numbers do not have to be found again.

SIG-208. `file-picker.test.ts > should leave the root for its parent unless
confined` failed in four of eight full `pnpm test` runs while five tickets were
being merged, and passed every time on its own.

## Measuring a leak exactly

The real tmpdir cannot be counted. Other worktrees and other runs write there
too, so a before-and-after count of it changes for reasons that have nothing to
do with the run being measured. Each project was run against a private
directory instead:

```
TMPDIR=<empty dir> pnpm vitest run --project @ttylabs/<name>
find <empty dir> -mindepth 1 -maxdepth 1 | wc -l
```

`os.tmpdir()` reads `TMPDIR` on macOS and Linux, and `TEMP` or `TMP` on Windows.
The vitest workers inherit it, and so does every child they spawn.
`scripts/temp-leaks.mjs` is this procedure written down.

## Before and after, one run per project

| project                | before | left by                                                                                                                                                                              | after |
| ---------------------- | -----: | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----: |
| `@ttylabs/config-yaml` |    510 | `sigil-yaml-` (`helpers.ts`, `read.test.ts`, `store.test.ts`)                                                                                                                        |     0 |
| `@ttylabs/config-xml`  |    277 | `sigil-xml-` (`helpers.ts`, `store.test.ts`)                                                                                                                                         |     0 |
| `@ttylabs/sigil`       |      4 | `sigil-auto-main-` ×2, `test-sigil/` (5 inside it, growing every run), `sigil-terminal-`                                                                                             |     0 |
| `@ttylabs/cli`         |     20 | `sigil-upd-cache-` 4, `sigil-upd-` 3, `sig141-add-` 3, `sigil-typecheck-` 2, `sigil-close-` 2, `sig141-` 2, `sigil-listing-`, `sigil-close-ok-`, `sigil-close-late-`, `sigil-build-` |     0 |

That is 811 entries per run, against the 520,146 entries the flaking machine had
built up. Every prefix in the ticket's table is in it. The "after" column was
measured twice, by hand and then through `pnpm test:leaks`, and re-checked five
seconds after each run for a late write from a detached worker. There was none.

## The two that were not a missing `rmSync`

`sigil-auto-main-` came from `updates-auto.test.ts`, whose `afterEach` did
remove its directory. Bisecting with `-t` narrowed it to the two tests whose
command fails: `should say nothing after a command that threw` and
`should say nothing when the command set a failing exit code`. Each one left a
directory holding `{"ts":…,"body":{"latest":"1.5.1"}}`, which is real npm's
answer for `mycli` and nothing the test had seeded. The order of events: `main()`
does not wait for the check after a failed command; the check awaits
`compiledHost()` before reading its cache; `afterEach` removes the seeded cache in
that gap; the check finds nothing, recreates the directory, and spawns a worker
that goes to the network.

`test-sigil/` came from `updates.test.ts`, which named a path under a shared
directory through `tmp()` and removed nothing. Its fire-and-forget case still
returns before its worker writes. That is safe as written, because the worker
does not create the directory.

## The file picker

The fixture under tmpdir meant Left read tmpdir. Measured on this machine with
`--reporter=verbose`, `-t "leave the root"`, three runs each:

| fixture                       | `TMPDIR`                  |       time |
| ----------------------------- | ------------------------- | ---------: |
| straight under tmpdir (old)   | empty                     |      80 ms |
| straight under tmpdir (old)   | 200,000 empty directories | 190–197 ms |
| one level under its own (new) | 200,000 empty directories |   78–80 ms |

The old fixture's cost scales with the machine's tmpdir. The new one costs the
same against an empty tmpdir and a stuffed one. The ticket measured 549 ms
against 520k entries, and a full run's load is what pushed that past 2,000.

Measuring it turned up the second dependency. With `TMPDIR` pointed at a long
scratch path, six of the file's tests failed outright on the original code: the
question line is cut from the left to fit 120 columns, and the assertions look
for the whole path in it. macOS's own tmpdir is about 50 characters, which is
why nobody had seen it. The screen is now as wide as the path needs.

## Sabotage

- Commenting out `afterAll(removeTempDirs)` in `config-yaml/test/setup.ts`:
  `pnpm test:leaks @ttylabs/config-yaml` reported `510 left behind`,
  `510 sigil-yaml`. The same in `config-xml`: `277 left behind`, exit 1. Both
  were restored and ran clean, exit 0.
- Replacing `await Promise.all(checks.splice(0))` with `checks.splice(0)` in
  `updates-auto.test.ts`: 59 passed, and two `sigil-auto-main-` directories were
  back. Restored: 0.
- Setting `root = parent` in `file-picker.test.ts`, which puts the fixture back
  under tmpdir: `should leave the root for its parent unless confined` fails.
  Restored: 37 passed against the 200,000-entry `TMPDIR`.
