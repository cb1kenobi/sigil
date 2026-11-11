# A pty package — the recommendation, and what it was measured on

SIG-288 asked whether sigil should ship a pseudo-terminal, as a package of its own
beside `@ttylabs/config-xml`, `@ttylabs/config-yaml` and `@ttylabs/screenshot`,
so that the terminal element of SIG-287 can host programs that refuse to draw
over pipes. It was labelled a spike, and its last open question was whether the
package is worth building before a caller exists. This is the answer, and the
measurements behind each part of it.

There is no `AGENTS.md` entry for it, because there is no code for one to sit
beside. When the package is built, the decisions below move into its own
`AGENTS.md` and this file becomes their history, which is the shape every other
file in this directory has.

## The recommendation

**Defer the package until SIG-287's emulator exists, and build it then on
`@lydell/node-pty` under Node and `Bun.spawn({ terminal })` under Bun.** Every
other question the ticket asked is settled below. The one that is not is the API,
and that is the reason to wait.

- **Not before a caller.** The terminal element does not exist yet: SIG-287 is in
  Backlog. A package built now would publish an API whose shape is a guess at what
  the emulator wants -- bytes or strings, who decodes a character split across two
  reads, whether the element or the app owns the resize, whether `kill()` means
  `SIGHUP` or `SIGTERM`. Each of those is decided by the first thing that reads
  the output. The root `AGENTS.md` records this rule under `which`: SIG-48 waited
  in the backlog until `sigil new` needed it, because "a feature nothing needs is
  a feature designed by guessing". A pty is the same case. It costs more to get
  wrong, because a published package cannot take its API back.
- **Not `node-pty` itself.** Its one stable release cannot spawn anything on
  macOS, and a pnpm install of its current beta exits 1 until the app approves
  its build script. Both are measured below.
- **Not an addon of our own.** It would repeat node-pty's native code, about
  1,800 lines of C++, and add a release pipeline this repository does not have.
- **And both runtimes, from the start.** node-pty does not work under Bun, and Bun
  has a working pty of its own. A Bun-compiled single binary can carry a pty with
  no native dependency at all, which is the only kind of packaged app that can.

## What was run

Every probe spawned the running `node` (or `bun`) under a pty at 80 x 24, with a
child script that:

1. printed `process.stdin.isTTY`, `process.stdout.isTTY`, `columns` and `rows`;
2. reported its size again after the parent called `resize(100, 40)`, from the
   `'resize'` event or from a 50 ms poll, whichever saw it first;
3. read `quit` from its stdin, which the parent wrote, and exited `7`.

The parent checked the exit code it was given. A second child that never exits
was then killed, and the parent checked that `onExit` fired.

Locally the probes ran on macOS on arm64, under node 24.18.0, node 26.10.0 and bun
1.4.4, with pnpm 12.18.0 and with npm 11.19.1. Docker is not installed on that
machine, so Linux and Windows were measured on CI instead. A temporary commit on
the PR added `@lydell/node-pty` as a devDependency and ran the same probe on all
nine node-and-OS jobs in a child process, so that the pty lived on a main thread
as it would in an app. That commit was reverted before the PR was ready. Its run is
linked under the table below.

## The candidates, measured

### `node-pty` 1.1.0, the latest stable release

- **It cannot spawn on macOS out of the box.** The tarball itself publishes
  `prebuilds/darwin-*/spawn-helper` as `-rw-r--r--`, and node-pty runs that file
  to start every child. So `spawn()` throws `posix_spawnp failed.` That was
  measured with install scripts blocked, and again with them allowed, because its
  `postinstall` does not set the bit either. A `chmod +x` by hand fixed it, and
  the probe then passed. Read off `tar tvzf` of the published tarball, so the
  cause is the package and not the package manager.
- **It has no Linux prebuild.** The tarball carries `darwin-arm64`, `darwin-x64`,
  `win32-arm64` and `win32-x64`. Its install script is
  `node scripts/prebuild.js || node-gyp rebuild`, so on Linux it compiles from
  source, which needs Python and a C++ toolchain wherever the app is installed.
- **It is 15.5 MB to download and 64 MB unpacked**, mostly Windows `.pdb` files
  and winpty.

### `node-pty` 1.2.0-beta.18, the current beta

- **It fixes both defects.** `spawn-helper` is `-rwxr-xr-x`, there are
  `linux-x64` and `linux-arm64` prebuilds, and winpty is gone: Windows uses ConPTY
  only. It is 7.2 MB to download and 26.9 MB unpacked.
- **Every pnpm install of it fails.** pnpm 12 blocks dependency build scripts by
  default and exits **1** with `ERR_PNPM_IGNORED_BUILDS` whenever it skips one.
  So an app that installed `@ttylabs/pty` would fail its own `pnpm install` until
  it added `node-pty` to `allowBuilds`. That is a cost every consumer pays for a
  script whose only job is to check a directory exists. With the scripts blocked
  the prebuild still loads, because `lib/utils.js` looks in `prebuilds/` at run
  time, and the probe passed. npm also blocks the scripts now, but it only warns
  (`install-scripts ... not yet covered by allowScripts`).

### `@lydell/node-pty` 1.2.0-beta.18

- **It is node-pty's own build, repackaged the way esbuild ships.** There is one
  package per platform, `@lydell/node-pty-<platform>-<arch>`, each declared with
  `os` and `cpu`, and all six are optional dependencies of a small front package
  that `require()`s the matching one. Its version tracks node-pty's beta exactly.
  It has **no install script**, so pnpm exits 0 and nothing has to be approved.
- **What lands on disk is one platform's binary.** That is 196 KB on
  darwin-arm64, against 26 MB for the beta it repackages. The published sizes are
  about 100 KB to 170 KB on macOS and Linux and 12 MB on Windows, where the `.pdb`
  files, `conpty.dll` and `OpenConsole.exe` ride along.
- **The binaries are N-API.** The Linux `pty.node` imports only `napi_*` symbols:
  no V8, no libuv, nothing tied to one Node ABI. So one build serves node 22, 24
  and 26, and CI confirms it. It needs **glibc 2.28** or newer (Debian 10, Ubuntu
  18.10, RHEL 8). There is **no musl build**, so Alpine is unsupported, and that
  belongs in the package's README.
- **On Windows it is ConPTY.** `conpty.node` imports `CreatePseudoConsole` and
  `ResizePseudoConsole` from `KERNEL32.dll`, which needs Windows 10 1809 or newer.
  It can also load the bundled `conpty.dll` through `useConptyDll`, a newer
  ConPTY than the OS ships.
- **Who maintains it.** It has a single maintainer, Simon Lydell, and 3.35 million
  downloads a week against node-pty's 5.88 million (npm, the week to 9 November
  2026). A fork has its own supply-chain cost. The exact pin is what limits it:
  a new version is a decision somebody makes, which the root `AGENTS.md` asks of
  every dependency and twice over of a native one.

| probe (`@lydell/node-pty`)                      | `isTTY` | resize seen by | wrote, read back | exit code | `kill()`  |
| ----------------------------------------------- | ------- | -------------- | ---------------- | --------- | --------- |
| macOS arm64, node 24.18.0 and 26.10.0, local    | both    | `'resize'`     | yes              | 7         | `SIGHUP`  |
| macOS arm64, node 22.23.4, 24.22.2, 26.13.0, CI | both    | `'resize'`     | yes              | 7         | `SIGHUP`  |
| Linux x64, node 22.23.4, 24.22.2, 26.13.0, CI   | both    | `'resize'`     | yes              | 7         | `SIGHUP`  |
| Windows x64, node 22.23.4, 24.22.2, 26.13.0, CI | both    | `'resize'`     | yes              | 7         | see below |

The CI rows are [run 42795502112](https://github.com/cb1kenobi/sigil/actions/runs/42795502112),
on the temporary commit `422bd3d7`. `pnpm install` passed on all nine jobs with
`allowBuilds` unchanged, and so did the rest of the suite.

Windows differs from the other two platforms in two ways, and the terminal
element will meet both:

- **The exit is reported about a second late.** On macOS and Linux, `onExit`
  fired 103 to 109 ms after the write, which is the child's own 100 ms delay
  before it exits. On Windows it fired 1,101 to 1,122 ms after the write, on
  every job. After the child exits, node-pty keeps reading ConPTY's output for
  `FLUSH_DATA_INTERVAL`, which is 1,000 ms, and restarts the timer whenever more
  data arrives. Only then does it report the exit (`lib/windowsPtyAgent.js`).
  That is how output written just before the exit gets through, and the second
  is what it costs.
- **`kill()` has no signal to report.** The exit came back as
  `{ exitCode: -1073741510 }`, which is `0xC000013A`, `STATUS_CONTROL_C_EXIT`,
  with no `signal` field. On POSIX it was `{ exitCode: 0, signal: 1 }`. An exit
  reason built from `signal` would read nothing on Windows.

A resize was seen by the child's `'resize'` event on every job. The 50 ms poll
never saw it first. On Windows the event arrived about 50 ms after `resize()`.
On the other two platforms it arrived within a millisecond.

### Bun 1.4.4

- **node-pty does not work under Bun.** Under node, `@lydell/node-pty` passed the
  probe 3 out of 3 times. Under bun it never passed in nine runs. Eight timed out
  after 8 seconds with no output and no exit. The ninth ended with `SIGHUP`
  without the child getting through its script. That held whether the child was
  `bun` or `node`, so the failure is node-pty's addon running inside Bun, not the
  child.
- **Bun has a pty of its own, and it works.** `Bun.spawn(cmd, { terminal: { cols,
  rows, data } })` hands the callback a terminal with `write()`, `resize()`,
  `setRawMode()` and `close()`. The probe passed 3 out of 3 under `bun`: `isTTY`,
  the resize, the write read back and the exit code. The size half also passed
  3 out of 3 from an 89 MB `bun build --compile` binary, with no dependency
  installed at all. `kill()` on the subprocess sends `SIGTERM`, where node-pty's
  sends `SIGHUP`.
- **Windows was not measured.** Bun is not on CI's matrix, and this machine is a
  Mac. Whether `terminal` works there is the first thing the package has to
  measure.

### An N-API addon of our own

Not prototyped, because what it costs can be read off what it would replace.
node-pty's native side is about 1,800 lines of C++: 876 in `unix/pty.cc`, 682 in
`win/conpty.cc`, and the rest in the spawn helper and the console list. All of it
handles edge cases a rewrite would have to find again: why macOS needs a separate
`spawn-helper` binary, and how to drain ConPTY's output pipe before reporting an
exit. Then come the prebuilds:

- a build matrix for six targets, macOS x64 and arm64 included, which CI does not
  build today;
- six platform packages, each published in lockstep, each one more manifest for
  `publish.yml`'s tag check, `pinned dependencies` and the build filters;
- the release job, which is one `ubuntu-latest` job today.

That is a project of its own, and it would deliver what `@lydell/node-pty`
already publishes.

## What the toolchain says about it

- **`sigil build` already handles a native dependency.** It is an `--external`,
  and the build reports it. That is what "A package carrying a native binding is
  left as an import" in `packages/cli/AGENTS.md` is for. `@lydell/node-pty`'s
  front package `require()`s its platform package by a computed name, which no
  bundler can follow, so it has to be external either way.
- **`sigil package` refuses an app with an external**, for the reason that entry
  records: a Node SEA's `require` reaches builtins and nothing else. So under
  Node, **an app that imports a pty cannot be packaged into one binary.** Under
  Bun it can, because `Bun.spawn({ terminal })` is built into the runtime. That
  is the strongest reason for the package to dispatch on the runtime rather than
  only on node-pty. It is also an argument for keeping the dependency out of the
  Bun path: the package should load node-pty only when it is not running under
  Bun.

## Settled for when it is built

Each of these is the answer to one of the ticket's "To settle" items.

- **The implementation.** `@lydell/node-pty`, pinned exactly, under Node.
  `Bun.spawn({ terminal })` under Bun, so node-pty is never loaded there. No addon
  of our own.
- **The platforms.** Prebuilds exist for macOS, Linux (glibc) and Windows, each
  on x64 and arm64, so nothing compiles at install. They are N-API, so one
  binary per platform serves every Node version on the matrix. Windows is
  ConPTY, 10 1809 or newer. The CI table above is the evidence for the nine
  combinations, which are macOS arm64, Linux x64 and Windows x64. The other three
  prebuilds were not run anywhere. musl has no prebuild, and Bun on Windows is
  unmeasured.
- **What a sixth package costs.** It is the checklist SIG-148 wrote and
  SIG-149 and SIG-325 paid again, unchanged except for the count:
  - `@ttylabs/pty` in both `--filter` lists, in `test` and `coverage`;
  - its manifest in `pinned dependencies`, with the count going from 8 to 9,
    and its task and `reads` row in `the build hash`;
  - a row in the root `AGENTS.md` package table, with "five" made "six" in the
    paragraph about `packages/`, and its own `AGENTS.md` in the index;
  - `demos/package.json` declaring it, plus a demo, which also brings it under
    `demos.test.ts`;
  - `turbo.json` needs no edit if it writes only `dist/**`.

  One item is new for a native package: `allowBuilds` in `pnpm-workspace.yaml`
  needs no entry for `@lydell/node-pty`, because it has no script to approve.
  Measured: the temporary commit installed it with that file unchanged, on all
  nine jobs.

- **Whether it is worth it before a caller.** No, for the reason at the top. The
  build is SIG-336, which is blocked by SIG-287.

## Where the API should start

This is a starting point for the follow-up, not a decision, because SIG-287 is
what decides it. The probe used `spawn`, `write`, `onData`, `resize`, `kill` and
the exit code, and all six exist on both backends, so that much is probably the
surface. Two questions are open, and both are places the backends disagree:

- **Bytes or strings.** On POSIX, node-pty decodes
  UTF-8 through the socket's `setEncoding()`, which is a `StringDecoder` and so
  copes with a character split across two reads, and `encoding: null` gives
  `Buffer`s instead. On Windows it delivers strings only: it warns
  `Setting encoding on Windows is not supported` and ignores the option. Bun's
  `data` callback receives a `Uint8Array`. So the package converts in one
  direction whatever it picks. If it picks strings, the decode on the Bun side
  has to be streaming too. `packages/sigil/docs/testing.md` records what
  decoding each chunk separately does to a split character.
- **Which signal `kill()` sends.** node-pty's default is `SIGHUP`, which the probe
  saw, and Bun's is `SIGTERM`, which is also what `ChildProcess.kill()` sends.
  `SIGHUP` suits a terminal being closed. Neither signal means anything on
  Windows. The package has to choose one default and pass it explicitly to both
  backends.
