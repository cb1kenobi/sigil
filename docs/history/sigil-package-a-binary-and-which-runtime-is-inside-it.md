# `sigil package` — how it was arrived at

The measurements behind
[`sigil package`: a binary, and which runtime is inside it](../../packages/cli/AGENTS.md)
and the correction to [A command per chunk](../../packages/cli/AGENTS.md) in the
same file. The decisions are there; this is the record of what each probe found,
kept because a finding nobody wrote down is one somebody re-discovers — and
because three of these inverted what the ticket assumed.

Machine: macOS 27.0 on arm64, Node 26.10.0, Bun 1.4.4. Every timing is 40
spawns with one warm run discarded, comparing **minima within one run**; the
floor moves by 2–4ms between runs, so figures from different runs are not
comparable and the tables below each come from a single run.

## The ticket's three open questions, and what the answers turned out to be

SIG-138 asked them in this order. Every one came out differently from the way it
was framed.

**"Does lazy command loading survive? Measure rather than assume — if a packaged
binary is 200ms to answer `--version`, that is a worse trade than it looks."**
It survives under Bun untouched, cannot exist at all under Node SEA, and the
200ms fear was backwards in both cases: packaging is _faster_ than not
packaging.

**"Bun or Node, and is it the app's choice or ours?"** The app's, with no
default, for a reason the ticket did not raise: neither runtime is a safe
default. Node is always present but may be too old; Bun is faster by a wide
margin but is not installed anywhere by default.

**"Codesigning and notarization — it has to be in scope or explicitly out of
it."** It turned out not to be one question. Ad-hoc signing is mandatory and
free and had to be in scope; notarization is a separate thing and is out.

## Node SEA cannot consume the build's output, and the reason is not the one in

the ticket

The ticket guessed SEA "wants a single file, which fights the chunked output".
Probed directly, it is much stronger than that. Each of these was run against a
real SEA built with `node --build-sea`, ad-hoc signed so it would execute:

| what was tried inside a SEA                                   | result                                                              |
| ------------------------------------------------------------- | ------------------------------------------------------------------- |
| the ESM entry `sigil build` writes, as the SEA main           | `Cannot use import statement outside a module`, at `embedderRunCjs` |
| `import('./side/chunks/x.mjs')`                               | `ERR_UNKNOWN_BUILTIN_MODULE`                                        |
| `import(pathToFileURL(join(dirname(process.execPath), ...)))` | `ERR_UNKNOWN_BUILTIN_MODULE`                                        |
| `new Function('s', 'return import(s)')(url)`                  | `ERR_UNKNOWN_BUILTIN_MODULE`                                        |
| `require(absolutePathToACjsFileOnDisk)`                       | `ERR_UNKNOWN_BUILTIN_MODULE`                                        |
| `createRequire(...)('./side/chunks/y.cjs')`                   | **works**                                                           |
| `createRequire(...)('./side/chunks/x.mjs')`                   | **works** — `require(esm)`                                          |

So: the embedded main runs as CommonJS, the injected `require` resolves builtins
only, and dynamic `import()` is unavailable in every spelling. `createRequire()`
is the single escape hatch and is wide enough to have built a lazy loader on —
it loads ESM off disk — which is exactly why it is worth recording as **not
taken**: it would mean a bespoke module loader in the generated entry and chunks
shipped beside a binary whose entire purpose is being one file.

The top-level `await` is the other half and is independent of all of it.
rolldown is explicit:

```
[UNSUPPORTED_FEATURE] Top-level await is currently not supported with the 'cjs' output format
```

and `await main({ schema: { ... } })` is the last statement of every entry
`generateBin()` has ever produced. Hence `wrap`.

## Flattening costs nothing, which the entry in AGENTS.md denied

`A command per chunk` ended "Flattening to one file would undo the whole reason
the tree is lazy." Nothing had measured it, because nothing had needed to
flatten. The Node path needs to, so it got measured.

The 13-command `app` fixture, chunked ESM on node against a flattened CJS SEA:

|                         | `--help`   | one command |
| ----------------------- | ---------- | ----------- |
| node, entry + 23 chunks | 40.7ms     | 25.4ms      |
| SEA, one flat file      | **37.1ms** | **23.7ms**  |
| `node -e 0`             | 19.1ms     | 19.1ms      |

Flattening is _faster_. The obvious objection is that the fixture is small, so a
60-command app was generated with 120 referenced helper functions per command —
1.4 MB of source, 1337 kB flat against 1460 kB as entry-plus-chunks:

|                               | `--help` | one command |
| ----------------------------- | -------- | ----------- |
| node, entry (4.7 kB) + chunks | 46.5ms   | 26.9ms      |
| SEA, one flat file (1337 kB)  | 46.2ms   | 27.1ms      |
| `node -e 0`                   | 18.9ms   | 18.9ms      |

Within noise. Two mechanisms explain it, and both matter for how the entry was
rewritten rather than merely corrected:

- V8 **pre-parses** and compiles a function body lazily, so the parse a chunk
  defers was nearly free to begin with.
- `codeSplitting: false` inlines the module but **keeps the `import()`**, so a
  command body is still executed only when its command is matched.

The deferral that matters is of _execution_, and it survives flattening. The one
that was being defended is the _parse_.

A first attempt at the 60-command fixture measured nothing, and it is worth
recording as a trap: the generated helpers were unused, so rolldown tree-shook
all of them and the "1.3 MB" bundle came out at 253 kB. Padding has to be
referenced to survive a bundler.

## Packaging is faster than not packaging

The three forms of the same 13-command app, one run, with a version in the
manifest so `--version` has something to answer:

|                            | `--version` | `--help`   | one command |
| -------------------------- | ----------- | ---------- | ----------- |
| unpackaged, node + chunks  | 24.0ms      | 39.9ms     | 24.7ms      |
| packaged, `--runtime node` | 23.0ms      | 36.6ms     | 23.3ms      |
| packaged, `--runtime bun`  | **15.4ms**  | **23.9ms** | **15.6ms**  |
| `node -e 0`                | 18.7ms      |            |             |
| `bun -e 0`                 | **3.8ms**   |            |             |

The floors are the finding. Node's own startup is 18.7ms of every figure in the
node rows, and nothing about bundling, chunking or packaging moves it. Bun's is
3.8ms. That 15ms gap is larger than every bundle-shape decision in
`packages/cli/AGENTS.md` combined, and it is the actual argument for Bun —
stronger than the cross-compilation the ticket leads with.

A SEA on its own costs nothing either: `./hello` (SEA) at 23.1ms against
`node hello.js` at 24.3ms, same trivial script. SEA is not slow; it is just
unable to express this output shape.

## Signing, which is an execution requirement rather than a distribution one

The ticket filed codesigning under "the part that is easy to underestimate",
about Gatekeeper on somebody else's machine. On Apple Silicon there is a prior
problem:

```
$ node --build-sea=sea.json && ./hello world
$ echo $?
137
$ codesign -dv ./hello
./hello: code object is not signed at all
$ codesign --sign - --force ./hello && ./hello world
hello from sea world
```

137 is SIGKILL. `--build-sea` strips the signature `node` itself ships with, and
the result cannot run on the machine that built it. So ad-hoc signing is not
optional and is not a polish step.

Verified again on a finished `sigil package` output, which is the form the test
relies on — the same binary, signature removed:

```
$ ./fixture-app --version     # as package left it
1.2.3
$ codesign --remove-signature ./fixture-app && ./fixture-app --version
$ echo $?
137
```

That is why the end-to-end test asserting "the binary runs" _is_ the test of the
signing step, and why a code-level sabotage of `sign()` was not needed: removing
the signature from the real artifact proves the causal link more directly than
making the function lie.

Bun needs none of it. Its output reports `adhoc, linker-signed` straight from
`bun build --compile`.

## Rendering parity, which is what says the whole thing is correct

The `styled` fixture draws a panel with utility classes, so one invocation of it
exercises the template compile, the stylesheet shake, the layout engine and the
SGR writer. At `COLUMNS=60`, three ways:

```
287 p-unpkg.txt     # sigil build, chunked ESM, run under node
287 p-node.txt      # sigil package --runtime node, a SEA over flat CJS
287 p-bun.txt       # sigil package --runtime bun
$ cmp p-unpkg.txt p-node.txt && echo IDENTICAL
IDENTICAL
$ cmp p-unpkg.txt p-bun.txt && echo IDENTICAL
IDENTICAL
```

Byte for byte, box-drawing characters and escape sequences included. That is the
claim the rest of this rests on: the entry wrap, the flattening and the embedded
runtime are all invisible to what the app draws.

## Cross-compilation, and what could not be checked here

All five targets from one Mac, in one `sigil package` invocation:

| target       | size     | `file` says                         |
| ------------ | -------- | ----------------------------------- |
| darwin-arm64 | 85.3 MB  | Mach-O arm64                        |
| darwin-x64   | 93.9 MB  | —                                   |
| linux-arm64  | 104.4 MB | —                                   |
| linux-x64    | 104.4 MB | `ELF 64-bit LSB executable, x86-64` |
| windows-x64  | 110.2 MB | `PE32+ executable (console) x86-64` |

The Node SEA equivalent is 138.6 MB, which is the host `node` binary's own size
plus the blob — not something `sigil package` can influence.

**What is not proved:** that the linux and windows binaries run. There is no
docker on this machine and a Mac cannot execute an ELF. `darwin-x64` runs under
Rosetta and does. So the cross-compiled outputs are proved to be the correct
file format and no further; CI has to close that, and claiming otherwise from a
laptop is the kind of thing this repository's Conventions entry on
platform-specific fixtures is written about.

`bun-windows-arm64` does not exist, which is why it is named in a constant
rather than discovered: `bun build --target=bun-windows-arm64` answers with a
usage dump.

## The scaffolded release workflow could not have worked, and only review saw it

Found by the cross-model review on the pull request, after everything above had
been measured and the suite was green on all twelve checks. The two facts were
each written down in this file and nobody had put them together:

- `signsOn()` is a function of the **target** alone, so the pre-flight asks for
  `codesign` whenever a darwin target is named — the finding under "Signing" is
  what forced that, since Bun's own `adhoc, linker-signed` output is SIGKILLed
  anyway.
- `codesign` ships only with macOS.

The workflow `sigil new` scaffolds ran on `ubuntu-latest` and packaged
`darwin-arm64` and `darwin-x64`. So every app made by `sigil new` would have
failed its release at the **Package** step on its first tag, with
`codesign is not installed, or is not on PATH` — in the one file whose whole
purpose is to work without being debugged, on the one run nobody gets to redo.

Nothing in the suite could see it. No test runs a generated workflow, and
`should want codesign for a bun darwin target too` asserts the exact behaviour
that breaks it, so the suite was as green as it could be while being wrong.

### Why the runner moved rather than the rule

The other available fix was one line: re-sign Bun's darwin output only when the
**host** is darwin, leaving Bun's linker signature in place for a cross-build.
It keeps the scaffold on Linux, it is cheaper, and it is refused by the
measurement in "Signing, which is an execution requirement rather than a
distribution one" — that signature is present and not valid, and the binary is
killed with exit 137 on the machine that produced it. Taking that fix means CI
attaching, to a GitHub release, the exact artifact already measured as
unrunnable.

A release that attaches a binary nobody can run is worse than a build that
refuses, because the author sees the refusal and the users see the SIGKILL. So
`runs-on: macos-latest`, which costs nothing else: Bun cross-compiles to Linux
and Windows from a Mac — the table under "Cross-compilation" is five targets
from one Mac — so one job still produces all five.

### The guard, and both of its sabotages

`should run where a darwin binary can be signed, which is a Mac` in
`new.test.ts` reads the `--target` literals out of the generated file and asks
**`assertToolchain()`** about them, with `codesign` off `PATH`. Asking that
rather than looking for `darwin` in the text is the point: the rule about which
targets get signed belongs to `signsOn()`, and a test that spelled it again
would be a second copy free to go on agreeing while the real one moved.

Both halves are load-bearing and both were sabotaged:

| sabotage                                    | what fails                                  |
| ------------------------------------------- | ------------------------------------------- |
| `runs-on: macos-latest` back to `ubuntu`    | the `runs-on` assertion                     |
| the two darwin targets dropped from the job | the refusal, as `.toMatch()` on `undefined` |

The second is the one that matters for a guard of this shape: without it a
workflow that stopped naming a darwin target would satisfy the implication
vacuously.

### Two comments that had become false

Both said the opposite of what the code now does, in the same words, which is
how one sentence copied into a second place goes stale twice. `assertToolchain()`
explained that it asks for `codesign` only where it is needed because asking
otherwise "would refuse a perfectly good cross-compile from Linux, where there
is no `codesign` at all" — and after `signsOn()` became a function of the target,
that is exactly what it does, deliberately, because such a cross-compile is not
perfectly good. The AGENTS.md entry carried the same clause. Both now say what
is true: the refusal is real, and it is the honest form of a binary that would
not run.

A third was stale for an unrelated reason and is corrected while here: an entry
still said `sigil new` writes `"runtime": "bun"` into `sigil.json`, which the
entry above it records as the defect that stopped the picker ever firing.

## The update check, which turned out to be three defects

The ticket flagged "the spawned worker behind the update check, which is the one
place we leave the main thread" as a thing to check before promising Bun. It is
worse than a Bun problem and none of it is caused by packaging. All three went
to SIG-156:

**It is already broken in any built app.** `updates/index.ts` reads
`get-version-worker.js` off `import.meta.url`. The file is copied into
`packages/sigil/dist/` so the package works from `node_modules`, and no bundler
can see a file that is read rather than imported. Measured on an app whose
`run()` calls `check()`:

```
from source: {"current":"1.0.0","latest":"0.0.1"}
built:       Error: ENOENT ... open '.../upd-out/get-version-worker.js'
```

with `sigil build` reporting complete success.

**It is broken under Bun, for a one-token reason.**
`spawn(process.execPath, ['--input-type', 'module'])` — bun reads `module` as a
script path and fails `Script not found "module"`. `bun --input-type=module`
with a script on **stdin** does not work either; it prints the usage text.
Probed for a spelling that works on both:

| spelling                             | node      | bun                         |
| ------------------------------------ | --------- | --------------------------- |
| `['--input-type', 'module']` + stdin | works     | `Script not found "module"` |
| `['--input-type=module']` + stdin    | works     | usage dump                  |
| `['--input-type=module', '-e', src]` | works     | works                       |
| `['-e', src]`                        | works     | works                       |
| `['-']` + stdin                      | **works** | **works**                   |

`['-']` is the minimal change and preserves the piped-string design the
subsystem `AGENTS.md` documents at length — verified with imports, env,
top-level await and an inherited `cwd` all intact.

**It cannot work in a compiled binary on either runtime.** Inside a single
executable `process.execPath` is the app's own binary:

```
execPath: /…/scratchpad/bun/probe
versions.bun: 1.4.4
versions.node: 26.3.0
```

so spawning it re-executes the app. That one is not a spelling fix and needs a
decision, which is why it is in the ticket rather than worked around here.

## The defect dogfooding found, which is why the acceptance test is the toolchain

`sigil package .` in `packages/cli` was run out of curiosity, on the assumption
it would fail cleanly because the toolchain has native dependencies. The two
runtimes failed differently and only one of them failed:

```
$ sigil package . --runtime bun
Error: bun build --compile failed for darwin-arm64:
  error: Could not resolve: "@ttylabs/sigil". Maybe you need to "bun install"?

$ sigil package . --runtime node
Binary  Target            Size  Signed
sigil   darwin-arm64  138.4 MB  ad-hoc
@ttylabs/cli (src/index.ts): 6 commands into 1 node binary, ...

$ ./sigil --version
Error [ERR_UNKNOWN_BUILTIN_MODULE]: No such built-in module: @ttylabs/sigil
```

A 138 MB binary, reported successfully, dead on the first thing anybody types.
Bun's message is merely misleading -- it names `bun install` as the fix for
something no install can fix -- while Node's is the failure this repository
refuses in three other places by name.

It is unreachable rather than merely absent, which is worth being precise about:
a SEA's injected `require` resolves builtins and nothing else, so there is no
`node_modules` anybody could put beside the binary to rescue it. The externals
are not late-bound, they are impossible.

So `assertSelfContained()` is the fourth gate of that class, with no override,
and `sigil package` on a toolchain-shaped app now says what to do instead. The
entry about `rolldown` being a devDependency already said the toolchain cannot
_build_ itself into a standalone bundle; this is the same sentence one step
along, and nobody had followed it there.

## Sabotage pass

Five, four by code mutation and one by artifact mutation.

| sabotage                                            | caught by                                                                            |
| --------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `writeEntry(..., false)` — drop the CJS entry wrap  | both node tests in `package-command.test.ts` (rolldown refuses the bundle)           |
| remove `codeSplitting: false` from the `cjs` form   | both node tests (chunks appear beside the `.cjs`)                                    |
| `assertCompilable()` ignores its `runtime` argument | 2 of 19 in `compile.test.ts`, including the test written for exactly this            |
| remove the pre-flight loop from `package.ts`        | `should write nothing when a target cannot be built`, and the config-precedence test |
| `codesign --remove-signature` on a finished binary  | exit 137, which is what the end-to-end test's "it runs" assertion rests on           |
| the workflow naming `win32-x64`                     | 2 of the release-workflow guards                                                     |
| the workflow dropping `.exe` from an attached file  | `should attach a file for each target`                                               |

A sixth was attempted and abandoned: making `sign()` claim success without
signing. It fails the package's own `tsc` (the build gate is the app's own type
check, and `packages/cli/tsconfig.json` includes `test`), so the mutation never
reaches a test run. The artifact mutation above answers the same question more
directly.

## Two defects found in this work, by the tests rather than by reading

**The `chmod` spelled its own extension.** `bundleApp()` took the entry's
extension from `form` for the write and wrote `.mjs` by hand for the `chmod`, so
the first `--runtime node` run produced a correct 234 kB CommonJS bundle and
then failed with `ENOENT: chmod '.../fixture-app.mjs'`. It is one named
expression read by both now. The two-spellings-of-one-thing shape this
repository records throughout, met while adding a second spelling.

**`package` shipped a private `clean()` that refused a legitimate `--out`.**
Copied from `build` and rewritten, it tested `relative(root, out)` for a leading
`..` — which reads as "outside the app" and was treated as "above the app".
Only the second is dangerous and a sibling directory is an ordinary place to
build into, so `--out /tmp/somewhere` was refused with a message about data
loss. Found by running it. `resolveOut()`, `binName()` and `clean()` are in
`_inspect.ts` now, which is what the module's doc comment was extended to say.

## One thing deliberately not done

The default runtime. Every candidate was considered and each is wrong:

- **Bun**, because it is better on every axis measured — fails on a machine
  without Bun, which is nearly all of them.
- **Node**, because `engines` already names it — needs node >= 25.5 for
  `--build-sea`, which `engines` does not require, so it fails on a supported
  machine. It also decides what the app ships on by defaulting to what happens
  to be running the build.
- **Whichever is installed** — makes the binary's runtime depend on the
  builder's laptop, so two machines produce differently-behaving releases from
  one commit.

So it is required, and the message carries the trade rather than only the names.
`sigil new` is the one place it is answered for you, and the asymmetry is
deliberate: an app with users cannot have that decided for it, and a brand-new
app has no users and needs a release workflow that works on its first tag.
