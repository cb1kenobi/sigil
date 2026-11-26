---
name: sigil-cli
description: Explains the sigil toolchain, the `sigil` command from `@ttylabs/cli` - check, build, package, add, reference, new and completion - for an agent working in an app built on `@ttylabs/sigil`. Covers what each command reads, writes and refuses, how to run each one without a terminal, what `sigil.json` means, and the toolchain behavior that looks like a bug and is deliberate - the build type-checks with the app's own tsconfig, reads modules without running them, empties its output directory, and adds `--version`. Use it before building or packaging an app, ejecting a component with `sigil add`, generating a command reference, editing `sigil.json`, or acting on an error or warning that `sigil check` or `sigil build` printed.
---

# The sigil toolchain

`@ttylabs/cli` is a devDependency of the app and provides the `sigil` command.
It reads an app, checks it, bundles it into an executable that depends on
nothing, and can compile that into a single binary. This skill is about the
toolchain. Writing the app itself (the schema, commands, options, components,
rendering, testing) is the runtime's skill, at
`node_modules/@ttylabs/sigil/skills/sigil/SKILL.md`.

The full user documentation is the package [README](../../README.md). This
file is the short version plus the things an agent tends to get wrong.

## Commands at a glance

| Command            | Reads                  | Writes                         | Prompts?                        |
| ------------------ | ---------------------- | ------------------------------ | ------------------------------- |
| `sigil check`      | the app, never runs it | nothing                        | no                              |
| `sigil build`      | the app, never runs it | `dist/`, emptied first         | no                              |
| `sigil package`    | the app, never runs it | `release/`                     | for the runtime, unless told    |
| `sigil add`        | the installed registry | `src/components/` (by default) | to confirm, unless `--yes`      |
| `sigil reference`  | **imports** the app    | stdout, or where `--out` says  | no                              |
| `sigil new`        | nothing                | a new directory                | for every choice, unless passed |
| `sigil completion` | nothing                | stdout when a shell is named   | when no shell is named          |

- `check`, `build`, `package` and `reference` take the app's root as an
  optional `[dir]` argument and default to the working directory. `add` takes no
  directory: it uses the nearest `package.json` at or above the working
  directory, so run it from the app.
- A directory is an app when its `package.json` depends on `@ttylabs/sigil`.
  The schema module is found by convention (`src/index`, then `src/main`,
  `src/cli` and a few more) and the one chosen is printed in the summary, as in
  `app1 (src/index.ts)`. `--entry` overrides it.
- `build` runs `check`'s pass, and `package` runs `build`'s. They cannot
  disagree about what a valid app is, so a clean `sigil check` is the fast way
  to know a build will get past its checks.
- Errors fail the command with exit code 1 and the line `Error: N errors in
  <app>`. Warnings never stop a build.
- `-q`/`--quiet` suppresses progress (the size tables and the summary line),
  not diagnostics or errors.
- In a scaffolded app the scripts are `build`, `check` and `package`, so
  `pnpm run build` (or the app's package manager) is `sigil build`.

## Running without a terminal

An agent has no terminal to answer a prompt. A prompt with no terminal fails
with `Cannot prompt for "..." because the input is not a terminal` and exit 1,
having written nothing. Pass the answer instead:

```sh
sigil new my-cli --yes --no-install --no-git   # every default; the name is required with --yes
sigil new my-cli --lang ts --layout multi --linter oxlint --pm pnpm --no-tui
sigil add spinner --yes                        # --force as well to overwrite an existing file
sigil package --runtime bun                    # or "package": { "runtime": "bun" } in sigil.json
sigil completion zsh                           # a named shell prints the script
```

- `sigil new` asks for language, layout, full-screen app, template syntax,
  linter and package manager. `--yes` takes the defaults for anything not
  passed (TypeScript, a commands directory, no full-screen app, oxlint, and
  pnpm when it is installed). It refuses a directory that exists and is not
  empty.
- `sigil package` with no runtime from a flag or `sigil.json`, and nobody to
  ask, stops and explains the two choices. There is no default runtime on
  purpose.
- `sigil completion` with no shell named is an installer that edits a shell
  startup file after asking. Without a terminal it prints the instructions and
  exits 1. Name the shell (`bash` or `zsh`) to get the script on stdout.

## Tasks

| To                                      | Run                                                       | Read                                                                     |
| --------------------------------------- | --------------------------------------------------------- | ------------------------------------------------------------------------ |
| Find out what is wrong without building | `sigil check`, with `--tree` to see the resolved commands | [check](#sigil-check)                                                    |
| Build the app                           | `sigil build`                                             | [build](#sigil-build)                                                    |
| Make it a single binary                 | `sigil package --runtime bun`                             | [package](#sigil-package), [README](../../README.md#packaging-a-binary)  |
| Release for several platforms           | `sigil package --runtime bun --target linux-x64 ...`      | [README](../../README.md#packaging-a-binary)                             |
| Ship a macOS binary other people run    | `sigil package --sign "<identity>"`, then notarize        | [README](../../README.md#signing-and-what-is-not-done-for-you)           |
| Customize a built-in component          | restyle its classes first; `sigil add <name> --yes`       | [add](#sigil-add)                                                        |
| Keep docs of the command surface        | `sigil reference --out docs/reference`                    | [reference](#sigil-reference)                                            |
| Fail CI when a flag or command moves    | `sigil reference --json --check`                          | [README](../../README.md#the-command-reference-and-the-surface-snapshot) |
| Configure the build once for every run  | edit `sigil.json`                                         | [sigil.json](#sigiljson), [README](../../README.md#configuration)        |
| Add a full-screen app to a new project  | `sigil new my-cli --tui` or `--tui-command <name>`        | [README](../../README.md#a-full-screen-app-in-the-scaffold)              |

## `sigil check`

Reads the app and reports what is wrong, without bundling. It runs the type
check, resolves the command tree, reads every command module's description,
checks translations and templates, looks at the `dev` runner, and reads
`sigil.json` (or `sigil.jsonc`). `--tree` prints the tree it resolved, to
stdout; diagnostics go to stderr.

The config is read in full, whichever command will use each section, through
the reader `build` uses: a bad value, a section that is not an object, an
`updateCheck` that cannot be baked (a `repo` that is not `owner/name`, a
`registry` or a custom `url` that is not an absolute `https://` URL), a
`package.runtime` or `package.target` that is not one, or both `sigil.json` and
`sigil.jsonc` at once is an error from `check`, in the words the command that
reads it gives.

What `check` does **not** do, so only `build` or `package` finds it:

- It does not bundle, so an import that cannot be resolved (a package that is
  not installed, say) is a `build` error and not a `check` one.
- It does not know how the build will be run. A `build.out` that would empty
  the app's own source (`"out": "src"`, or `"."`) is an error from `check`,
  judged as `build` would with no flags: so a `"out": "."` that you only ever
  build with `--no-clean` is still reported, and an `--out` given on the command
  line is not seen. A module only the bundle reads, inside `out`, is `build`'s
  to refuse, and so is `package`'s refusal of a non-empty `build.external`.

### Rules the toolchain enforces

These are the runtime's routing rules (its skill explains them); this is what
`check` and `build` do about each. Errors stop a build; warnings do not.

- **Error:** a route whose file or directory name has whitespace, a `,`, a
  `/` or a control or format character, or starts with `<`, `[`, `!` or `@`. A route is named exactly as its
  file. Rename it, and alias or hide it in a `commands.json` instead.
- **Error:** an alias that is empty, has whitespace, a `,` or a `/`, starts
  with `<`, `[`, `!` or `@`, or holds a control or format character -- in a
  `commands.json`, or in the `alias` property of a command written in the
  schema. An alias is held to the same rules as a route's name, the error says
  what to write instead (`hidden` rather than a leading `!`), and a
  `commands.json` is refused whole.
- **Error:** two routes claiming one name, such as `deploy.ts` beside a
  `deploy/` directory.
- **Warning:** `name`, `alias` or `default: true` inside a routed command
  module. The module loads only after argv matched its file name, so these do
  nothing. Put them in the `commands.json` beside the module.
- **Warning:** a `commands.json` entry that names no file or directory there.
  It is ignored.
- **Warning:** a `desc` the build cannot read as a literal (a template with a
  substitution, a variable). Help then lists that command by name alone.
- **Warning:** settings passed to `main` in the `dev` runner (`dev.ts` or
  `dev.js`). The built app generates its own call, so they do not reach it. Put
  them in `settings` on the schema.
- A module whose name starts with `_` (`_util.ts`) is not a command, which is
  how to keep a helper inside `src/commands/`.

### The type check

`check`, `build` and `package` run the app's own TypeScript (`tsc --noEmit`,
resolved from the app) against the app's own `tsconfig.json`. That is the same
command as the app's `type-check` script, so:

- **A type error in a test fails the build** whenever the tsconfig's `include`
  covers `test/`, as the scaffold's does. Fix the test; do not narrow the
  tsconfig to get a build through.
- With no `tsconfig.json` in the app root (a JavaScript app), or no
  `typescript` installed, it prints `Not type-checked: ...` and carries on.
  That is a note, not a failure.

## `sigil build`

Bundles the app into `dist/<name>.mjs` plus a chunk per command under
`dist/chunks/`, then prints the chunk sizes and which packages were inlined.
`<name>` is the app's `bin` name from `package.json`, or `--name`.

### Read, never run

The build parses the app's modules and never imports them, so module-level code
does not run at build time. What follows from that:

- **The build generates the executable.** It imports the schema module and
  calls `main` itself. The schema module should export the schema and not call
  `main`; the `dev` runner is not bundled at all.
- **Descriptions are lifted statically.** `desc` and `hidden` are read from
  each command module's source and baked in, so the built app's help describes
  every command without loading its module. Run from source, a routed command
  is listed without a description until its module loads, unless a
  `commands.json` describes it. A missing description in `dev` output is not a
  bug.
- **`--version` comes from the build, unless the schema states one.** The
  build bakes the `version` in `package.json` into the schema, which is what
  gives the built app its `--version`. A `version` string the schema declares
  wins over it, so source and built answer the same. A `version` _function_ is
  still replaced by the manifest's (when it has one), because it reads a path a
  bundle moves. Compute a version in a function, not an eager string: a string
  read from a file path or `npm_package_version` is kept as it is.
  Running from source has no `--version` unless the schema declares one. Do
  not add the option by hand.
- **A path from `import.meta.url` moves.** Once bundled, a module lives in
  `dist/`, so reading a file relative to its own URL reads from there.

### Output and `dist/`

- **The output directory is emptied before every build.** Anything else kept in
  `dist/` is deleted. `--no-clean` keeps it.
- It refuses to empty a directory that holds the app or any file the build
  reads, so `--out .` or `--out src` fail rather than deleting source.
- A failed build (a type error, say) leaves the previous `dist/` as it was.
- Everything the app imports is inlined. A package listed in `external` (in
  `sigil.json`, or `--external`, repeatable) stays an import and must be
  installed where the app runs; that is for packages carrying a native binding.
- `--bin <file>` bundles an executable of your own instead of the generated
  one, and is refused beside a commands directory, because a bundle has no
  directories to walk.

## `sigil.json`

Beside `package.json`. Every field is optional, and the full list with
examples is in the README's [Configuration](../../README.md#configuration).

- It is read as JSONC whatever it is called: comments and trailing commas are
  fine in `sigil.json`. `sigil.jsonc` is also read; having both is an error.
- **A key the toolchain does not know is ignored, not reported**, at the top
  level and inside a section. A misspelled key silently does nothing; check
  spelling against the README.
- Values are coerced the way an option's are: `"sourcemap": "off"` is `false`,
  and `"sourcemap": "nope"` is an error naming the setting.
- A flag beats the file, but for `shake` and `sourcemap` only in the off
  direction: `--no-shake` beats `"shake": true`, and nothing on the command
  line turns back on what the file turned off.
- `build.external` lists packages to import rather than inline. An app that
  declares any cannot be packaged.
- `build.sourcemap` writes the `.map` files (on by default). `build.shake`
  trims the utility stylesheet to the classes the source names (on by default),
  and `build.safelist` keeps classes the source builds dynamically -- a `?:`
  with a literal in a branch and a literal on either side of `||` or `??` are
  read, but `.concat()`, `.join()`, `&&`, a helper call and any other computed
  class need the safelist.
- `package.runtime` is the one field with no default. `package.out` defaults
  to `release` and does not follow `build.out`.
- `components` is where `sigil add` writes. `reference.out` and
  `reference.snapshot` are where `sigil reference` writes. `locale` is the
  built app's fallback locale. `updateCheck` says where the update check looks,
  and its `type` is required.

## `sigil package`

Runs the build's checks and bundle, then compiles a single binary with a
runtime embedded into `release/`. It does **not** refresh `dist/`; the bundle
it embeds is staged under `node_modules/.sigil/`. Run `sigil build` as well if
`dist/` is what ships.

- The runtime is required: `--runtime bun` or `--runtime node`, optionally
  pinned (`bun@<version>`), or `package.runtime` in `sigil.json`. A runtime that
  is not installed is downloaded, verified and cached.
- Bun cross-compiles: one machine can build several `--target`s
  (`darwin-arm64`, `darwin-x64`, `linux-arm64`, `linux-x64`, `windows-x64`).
  Node builds only the machine it runs on, and refuses another target.
- It refuses, rather than produce a binary that cannot work:
  - an app with `external` packages, since a binary cannot load them;
  - an app that imports `@ttylabs/sigil/updates` without an `updateCheck` in
    `sigil.json` (use `"type": "none"` to say it checks nothing);
  - `--runtime node` for an app with top-level `await` in its own modules.
- macOS binaries are ad-hoc signed automatically, because an unsigned one is
  killed before it runs. So a darwin target needs `codesign`, which only macOS
  has. Distribution needs `--sign` with a Developer ID and notarization, which
  you do yourself. Windows binaries are not signed.
- `sigil new` scaffolds `.github/workflows/release.yml`, which packages every
  Bun target on a version tag. It runs on macOS for that reason. Its actions are
  pinned to commit SHAs (`.github/dependabot.yml` moves them), the install skips
  lifecycle scripts, and the release token reaches only the step that uses it.

## `sigil add`

Copies a component's source from the registry in the app's installed
`@ttylabs/sigil` into the app, so the source matches the runtime the app uses.

- **It is an eject, not an install.** Every component already works from its
  subpath, such as `@ttylabs/sigil/components/spinner`, with no `add`. Restyle
  a component with an ordinary rule against the classes it draws with (the plan
  lists them), which keeps it following the framework. Eject only when the
  structure or behavior has to change.
- **What it copies stops following the framework.** Upgrading
  `@ttylabs/sigil` does not touch the copy. After ejecting, import the copy
  from the app's own source rather than the package subpath, or nothing
  changes.
- With no component named, it lists what the registry has.
- It writes to `components` in `sigil.json`, else a conventional directory,
  and prints which. `--dir` overrides both.
- It needs `--yes` without a terminal. It refuses to overwrite a file that is
  there unless `--force`; read the existing file first, since it was probably
  edited.
- It copies TypeScript even into a JavaScript app; Node runs it without a
  compile step. The copy imports its plumbing from `@ttylabs/sigil` subpaths.
- A third-party registry is an installed package, named as
  `sigil add <package>/<entry>`, and one call takes one registry.

## `sigil reference`

Generates a markdown command reference or a JSON snapshot of the command
surface. Unlike `build`, it **imports** the app, because options and arguments
exist only inside the modules that declare them. Details are in the README's
[command reference section](../../README.md#the-command-reference-and-the-surface-snapshot).

```sh
sigil reference --out docs/reference                # a markdown page per command
sigil reference --json --out command-surface.json   # the snapshot
sigil reference --check                             # in CI: exit 1 if the pages moved
sigil reference --json --check                      # and the snapshot, a second run
sigil reference --json-schema                       # each command's input, as JSON Schema
sigil reference --skill                             # the app's own agent skill, in skills/<name>
```

- Put both destinations in `sigil.json` (`reference.out`,
  `reference.snapshot`) and every run, including CI, needs no `--out`. With a
  snapshot path configured, `--json` writes the file rather than printing.
- `--check` with no destination is an error: there is nothing to compare.
- One run handles one artifact, so CI runs the markdown check and the
  `--json` check separately.
- The snapshot records what argv accepts (commands, aliases, option spellings,
  types, `choices`, positionals, `hidden`, `default`), not descriptions or
  default values. A failing `--check` means the CLI's public surface changed:
  refresh it only if the change is intended, and say so in the pull request.
- It never deletes anything. A page for a renamed command is reported and left
  for you to remove.

## `sigil new`

Scaffolds an app: the schema in `src/index.ts`, commands in `src/commands/`
(or one root command with `--layout single`), a `dev` runner that starts it
from source, tests, `sigil.json`, `AGENTS.md` and `CLAUDE.md`, and the release
workflow. A full-screen app in JSX has no `dev` runner: Node cannot run JSX, so
its `dev` script is `sigil build --quiet` and then the bundle.
`--lang js` scaffolds JavaScript with no tsconfig, which means no type check.
`--no-install` and `--no-git` skip the install and `git init`. See
[Running without a terminal](#running-without-a-terminal) for the flags that
replace each question.

## `sigil completion`

The same completion every built app has, for `sigil` itself.
`sigil completion bash` or `sigil completion zsh` prints a script; with no
shell named it offers to install one, and `--uninstall` removes it.
