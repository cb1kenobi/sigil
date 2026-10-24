# @ttylabs/cli

The sigil toolchain. It resolves an app's command tree, checks it, and packages
it into an executable that depends on nothing.

This package may depend on whatever it needs — a bundler, a parser — because it
is a devDependency of your app rather than part of what your app ships. The
runtime it compiles against, [`@ttylabs/sigil`](../sigil), stays at zero
dependencies, and so does what this produces.

There is no `sigil dev`. This is a resolver and a compiler, not a server.

## Commands

| Command                    | What it does                                                                                                                                           |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `sigil new`                | Scaffolds an app                                                                                                                                       |
| `sigil check`              | Reads an app and reports what is wrong, without building it                                                                                            |
| `sigil build`              | Bundles it into one executable plus a chunk per command                                                                                                |
| `sigil package`            | Builds it and compiles the result into a single binary with a runtime embedded, for users who have no Node                                             |
| `sigil add`                | Copies a component's source into your app, so you own it                                                                                               |
| `sigil completion [shell]` | Prints a completion script for bash or zsh, or installs one for the shell you are in — this one is the framework's, and every app it builds has it too |
| `sigil reference`          | Writes a markdown command reference, or a stable JSON snapshot of the command surface                                                                  |

`build` runs `check`'s pass rather than replacing it, so an app that builds is
one that checks out, and `package` runs `build`. One pass, three commands that
cannot disagree about what a valid app is.

## Packaging a binary

`sigil build` leaves you an app that still needs a runtime installed.
`sigil package` embeds one, so what you ship is a file somebody downloads and
runs.

```sh
sigil package --runtime bun                     # this machine
sigil package --runtime bun \
  --target darwin-arm64 --target linux-x64 \
  --target windows-x64                          # a release, from one machine
sigil package --runtime node                    # this machine, on Node
```

**You have to pick the runtime.** There is no default, because which one a
binary embeds decides what your app runs on, and that is not something to infer
from whatever happens to be installed where the build ran. Say it once in
`sigil.json` and every invocation and CI step agrees.

|                  | `--runtime bun`                     | `--runtime node`                                   |
| ---------------- | ----------------------------------- | -------------------------------------------------- |
| Your app runs on | Bun                                 | Node, which is what `engines` already says         |
| Startup          | ~16ms                               | ~23ms                                              |
| Binary size      | 85–110 MB                           | ~139 MB                                            |
| Cross-compiles   | Yes, all five targets from any host | No — each target builds on its own machine         |
| macOS signing    | Done for you                        | Ad-hoc automatically; `--sign` for a real identity |
| Needs            | `bun` on `PATH`                     | Node 25.5 or newer                                 |

Startup is the number worth knowing and it is almost all runtime, not app: Node
takes ~19ms to start before your code runs and Bun takes ~4ms. Packaging never
costs startup either way — both binaries answer slightly faster than the
unpackaged app, because there are no module files to find.

Targets are `<platform>-<arch>`: `darwin-arm64`, `darwin-x64`, `linux-arm64`,
`linux-x64`, `windows-x64`, `windows-arm64`. Bun has no runtime for
`windows-arm64`; Node builds only the machine it is running on. A single target
is named after your app, and several at once get the target in the file name, so
a release is `mycli-linux-x64` and `mycli-windows-x64.exe`.

An app that declares `external` packages **cannot** be packaged, and
`sigil package` refuses rather than producing a binary that would die on first
use. An external says that package must be installed where the app runs, and a
binary says nothing has to be — a package carrying a native binding cannot be
inlined at all, so such an app ships as `sigil build` output plus its
`node_modules`. This is why the `sigil` CLI itself cannot be packaged: it
depends on two native bindings.

### Signing, and what is not done for you

On macOS a binary has to be signed to run **at all** — an unsigned one is killed
before it starts, not merely warned about — so `sigil package` ad-hoc signs
what it produces. That is enough for a binary you built to run on the machine
you built it on, and on your CI.

It is **not** enough for a binary somebody downloads. Getting past Gatekeeper
needs an Apple Developer ID and notarization: pass the identity with
`--sign "Developer ID Application: ..."` and run `notarytool` over the result
yourself. Windows is the same shape — Authenticode needs a certificate and
`signtool`, and there is no ad-hoc equivalent, so nothing is signed there by
default.

`sigil new` scaffolds `.github/workflows/release.yml`, which builds every target
on a version tag and attaches them to a GitHub release. It is one job because
Bun cross-compiles; the comment at the top says what to change for Node.

## The command reference, and the surface snapshot

```sh
sigil reference                                  # one document, to stdout
sigil reference --out docs/reference             # a page per command
sigil reference --json --out command-surface.json
sigil reference --check                          # exit non-zero if the pages moved
sigil reference --json --check                   # and the snapshot, which is a second run
```

Two artifacts over one payload. The **markdown** is for reading: usage,
arguments, options, aliases, examples and the subcommand list, with YAML front
matter a docs site can route on. It says everything `--help` says about a
declaration and in the same words -- a default, that an option may be repeated,
which command a bare invocation runs -- because the one artifact that is for
reading should not say less than the screen. The **JSON** is for diffing. A CLI's command
surface is its public API, and nothing in a build notices when it moves — so a
pull request that renames a flag breaks everybody's scripts and reads as a
one-line change. Commit the snapshot, put `sigil reference --json --check` in
CI, and that pull request fails instead.

What counts as a surface change, and what does not:

| In the snapshot                                                                 | Not in it                                      |
| ------------------------------------------------------------------------------- | ---------------------------------------------- |
| every argv path, and every token that reaches it — a command's name and aliases | `desc`, on a command, an option or an argument |
| each option's long and short spellings                                          | `examples`                                     |
| whether an option takes a value, is required, is repeatable, and its data type  | an option's help `group` and its value `hint`  |
| each option's `choices`, spelled the way argv has to type them                  | an option's `default`                          |
| the environment variables an option reads, in declaration order                 | the destination a value lands on in `argv`     |
| each positional's name, position, requiredness, variadicity, type and `choices` | the version, the date, and any path            |
| whether a command or an option is `hidden`                                      | whether an option has a `default` at all       |
| the environment variables an argument reads, in declaration order               |                                                |
| which command is the `default` one a bare invocation runs                       |                                                |
| whether a path has a handler at all, or is a namespace that only lists          |                                                |

Every list in it is sorted except the environment variables: a spelling reaches
an option and a choice is accepted whichever order the declaration wrote them
in, so those are sets and sorting them keeps the snapshot still when nothing
moved. `env` is an ordered list, because the first variable that is **set** is
the one that wins.

The line is **what argv accepts, not what the screen says**. A reworded
description must not fail a check, or nobody can leave the check on. A `default`
is out because it is what the app _does_ rather than what argv _accepts_, and
because a computed one has no stable serialization — a `default: () => …` would
either move the snapshot on every run or have to be called during a doc
generation. What that gives up is stated rather than implied: **nothing in the
snapshot records whether an option has a default**, so adding or removing one is
invisible to the check. `required` is a different question — it says whether the
option has to appear, and an optional option may have a default or not.

Two things _are_ in it that read as behaviour and are not. Which command is the
`default` one decides what a bare invocation does, so moving that mark changes
what `mycli` with no arguments means. And whether a path has a handler at all
separates a command from a namespace that only lists its children — a namespace
gaining a `run` is a path that did nothing and now does something.

`hidden` is in it, and that is the one worth knowing. A hidden command is not
listed and is still **reachable**, so hiding one breaks nobody's script today
and leaves a thing nothing documents. The snapshot records it so the diff shows
it; whether hiding is a breaking change is then a question a reviewer answers
rather than one this tool guesses. Which direction breaks is the same kind of
question: an alias **removed** breaks and one added does not, an option becoming
**required** breaks and becoming optional does not, a positional **losing** its
`...` breaks and gaining one does not. The check says the surface moved; the
diff says which way.

One invocation checks one destination, which is why a CI step is the pair rather
than one line: `--json` is what says which artifact is meant, so the markdown and
the snapshot are two runs exactly as refreshing them is. `package.json`'s own
script is that pair.

`sigil reference` **imports** your app, which is the one thing `sigil build`
refuses to do. It has to: an option and an argument live only inside the module
that declares them — nothing lifts them out of source — so a reference cannot be
a static read. That is also why this is not part of the build: a build must not
run the app, and an opt-in flag would not change what a build _is_. Nothing is
deleted either, ever. A page left over from a command you renamed is reported
and left for you to remove.

## Configuration

`sigil.json`, beside your `package.json`. Every field is optional, and a
command-line flag beats the file. Comments and trailing commas are allowed in
it -- the file is read as JSONC whatever it is called, so you never have to
rename it to annotate it. `sigil.jsonc` is read too, for a project that prefers
to say so in the name; both at once is an error.

```jsonc
{
  "components": "src/components",
  "locale": "de",
  "reference": {
    "out": "docs/reference",
    "snapshot": "command-surface.json",
  },
  "build": {
    "external": ["some-native-package"],
    "name": "mycli",
    "out": "dist",
    "safelist": ["text-red"],
    "shake": true,
    "sourcemap": true,
  },
  "package": {
    "out": "dist",
    "runtime": "bun",
    "target": ["darwin-arm64", "linux-x64", "windows-x64"],
  },
}
```

`external` names packages to import rather than inline. You need it for a
package carrying a **native binding** — nothing inlines a `.node`, so its
JavaScript would be bundled and then look for a binary that is no longer beside
it. Anything listed has to be installed where the app runs, and the build says
so when it finishes.

`name` is only needed when your `package.json` publishes more than one `bin`;
otherwise the executable is named after the one it publishes.

`package.runtime` is the one field with no default, and `sigil package` refuses
to run without it — see "Packaging a binary" above for why. `package.out` falls
back to `build.out` and then to `dist`, since the package is the build plus a
step. `package.target` defaults to the machine the build runs on.

`locale` is the locale your app falls back on, written into the schema the build
generates. It sits at the **bottom** of the locale chain — `SIGIL_LOCALE`,
`LC_ALL`, `LC_MESSAGES` and `LANG` all beat it — so it says what the app ships in
rather than overriding the user. It is here rather than under `build` because it
is a fact about the app rather than a bundler knob, and the build is simply the
only thing that can carry it: the runtime does not read a config file at
startup. It reaches the **built** app only, so an app whose unbundled runs
should match writes `defaultLocale` in its schema too.

`reference` says **where** the command reference goes, not whether to write one:
`sigil reference` with nowhere to put anything prints one document to stdout, so
naming a destination here is how you say it once instead of in every invocation
and every CI step. Both are relative to the app — a reference is a committed
artifact, so an absolute path would be one machine's answer written into a file
every machine reads.

`shake` decides whether the utility stylesheet is cut down to the classes your
source can actually name. It is on by default, it only affects an app that
calls `utilitySheet()`, and the build says what it came to — `25 of 383 utility
rules`. The analysis reads every string literal and template quasi in your own
source, so `class="p-2"` and ``class={`text-${colour}`}`` are both seen: the
first names one class, the second keeps every `text-*` rule. What it cannot see
is a class assembled out of values that are never literals in your source — one
read from a config file, or joined out of an array that came from elsewhere —
and `safelist` is how to keep those — if it dropped _everything_, the build
says so rather than leaving you to notice. `--no-shake` turns it off for one
build.

## Building this package

```sh
pnpm build        # node src/sigil.ts build
```

The toolchain is built by the toolchain — that is what
[SIG-78](https://linear.app/cb1kenobi/issue/SIG-78) is for, and it is the
acceptance test for the whole project. A framework whose own toolchain is not
written in it has not been tested by anyone who had to live with it.

Stage 0 is `node src/sigil.ts`, which runs from source with no build step.
That is deliberate: it is what keeps a broken build able to build its own fix,
and it is the loop to use while working on the toolchain.

`sigil build` reads an app rather than running it — the entry is parsed, never
imported, so an app that opens a connection at module scope does not do it
during a build.

It also says what went **into** the bundle. The zero-dependency promise is
about what sigil adds; everything your app imports is inlined, so the build
lists each package and what its code came to. Those bytes are measured before
minification, which is the only per-package figure a bundler has, so they do
not add up to the chunk sizes above them — they are there to answer "is
something enormous in here, and what".
