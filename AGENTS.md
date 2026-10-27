# sigil

A framework for building CLI apps in Node.js, and the successor to `cli-kit`.
The heart of it is a multi-pass hierarchical argument parser built for CLIs
that lean heavily on subcommands.

Unqualified `src/...` and `test/...` paths in this file mean
`packages/sigil/src/...` and `packages/sigil/test/...`.

This is a pnpm workspace with four published packages, and the split is load
bearing.

| Package                | Name                   | Dependencies                                       |
| ---------------------- | ---------------------- | -------------------------------------------------- |
| `packages/sigil`       | `@ttylabs/sigil`       | **Zero, and that is a hard constraint**            |
| `packages/cli`         | `@ttylabs/cli`         | Whatever it needs. Provides the `sigil` bin        |
| `packages/config-xml`  | `@ttylabs/config-xml`  | `@ttylabs/sigil` and an XML parser. Opt-in per app |
| `packages/config-yaml` | `@ttylabs/config-yaml` | `@ttylabs/sigil` and a YAML parser. Opt-in per app |

**Zero production dependencies in `@ttylabs/sigil` is a hard constraint.** Anything the
runtime needs — ANSI handling, text wrapping, dotenv, `which`, debug logging,
and everything the 2.0 stack adds on top — gets written there and bundled. Do not add a runtime dependency to `packages/sigil`; if one seems
necessary, raise it rather than adding it.

`@ttylabs/cli` is the opposite: it is a devDependency of the app rather than part
of what the app ships, so it may depend on rollup and anything else it needs.
What it _produces_ has no dependencies. Do not let that licence leak back into
the runtime.

**A config store package is the third shape, and it is what the constraint
allows rather than an exception to it.** The rule is about `@ttylabs/sigil`'s own
dependencies, and the two ways to give an app an XML or a YAML config layer are
dependency injection — the app hands a store a parser — or a separate published
package that depends on one directly. The second is the right read: an app that
wants XML config installs a thing that brings a parser, and an app that does not
pays **nothing**, where injection makes every app wire a parser into a store it
does not otherwise care about. It is also the only way to find out whether
`ConfigStore` is implementable from outside this repository, which is the thing
those tickets were actually for.

There are **two** of them now, and that is worth more than either format: one
implementation proves an interface is writable, two prove it is not shaped
around the first one. Neither needed a line of `@ttylabs/sigil` to change. See
"An XML config store" in `packages/config-xml` and "A YAML config store" in
`packages/config-yaml`.

## Layout

Paths below are inside `packages/sigil/` unless noted.

| Path                           | Contents                                                        |
| ------------------------------ | --------------------------------------------------------------- |
| `src/parser/`                  | The parser: commands, options, arguments, registries            |
| `src/parser/command/routes.ts` | The route rules, shared with `sigil build`                      |
| `src/ansi/`                    | SGR styling, strip, color support detection                     |
| `src/width/`                   | Display width: grapheme clusters, East Asian Width              |
| `src/wrap/`                    | Text wrapping, SGR state, terminal width                        |
| `src/help/`                    | The generated help screen, as an element tree                   |
| `src/terminal/`                | Terminal wrapper, live region, sequences, OSC 52                |
| `src/components/`              | Spinner, progress, table, prompts, scroll box, typewriter, keys |
| `src/signals/`                 | The reactive graph: state, computed, watcher, effect            |
| `src/renderer/`                | Components, the owner tree, control flow, the frame             |
| `src/template/`                | The template IR, the `ui` tag, the JSX runtimes                 |
| `src/canvas/`                  | Cell buffer, style interning, paint diff, selection             |
| `src/style/`                   | Properties, values, selectors, cascade, animation, degradation  |
| `src/theme/`                   | The framework's own sheet, and what a theme is                  |
| `src/layout/`                  | The flexbox subset, over whole cells                            |
| `src/i18n/`                    | The `__` tag, the plural, the locale chain, the catalog         |
| `src/config/`                  | Config layers, the merged view, the stores, JSONC reading       |
| `src/infer.ts`                 | `initOption()` and `initArg()`, in the type system              |
| `src/util/`                    | Shared helpers (type coercion, camelCase, mkdir)                |
| `src/debug/`                   | `DEBUG`-driven logger; replaces snooplogg                       |
| `src/paths.ts`                 | XDG base directories                                            |
| `src/which.ts`                 | Resolving an executable against `PATH`                          |
| `src/updates/`                 | Update check: npm, GitHub or custom, in a spawned worker        |
| `src/error-handler.ts`         | Renders an error and sets the exit code                         |
| `src/error-hooks.ts`           | Fires `beforeError` hooks; carries state on an error            |
| `scripts/`                     | Run by hand: generators, the terminal probe, benchmarks         |
| `docs/parser.md`               | Parser reference: syntax, semantics, precedence                 |
| `test/parser/commander/`       | Ported Commander test cases                                     |
| `test/parser/yargs/`           | Ported yargs-parser test cases                                  |

At the repository root: `demos/` (runnable examples that import `@ttylabs/sigil` by
name, so they need `pnpm build` first, and a workspace member so that the name
resolves), `website/` (the Next.js site), `turbo.json`, `tsconfig.base.json`, and
the shared oxlint and oxfmt configs. Each package extends the base tsconfig and
sets its own `outDir`.

**A demo lives with its _subject_, not with what it imports.** `demos/` has a
directory per subsystem and the one a demo goes in is the layer it is about,
whatever else it reaches for to show it: `style/02-themes.js` imports
`@ttylabs/sigil/components`, `renderer/03-debug.js` imports it too, and
`style/03-animation.js` imports five subpaths including `/renderer` and
`/element` -- none of the three is in `demos/components/`, because a component a
demo draws with is an instrument rather than the thing being demonstrated.
Worth writing down because the rule was never stated and SIG-141's own demo was
filed under `components/` for it: its subject is `resolveOutput()`, which is
`src/style/output.ts`, and the axis it extends is `prefers-reduced-motion`,
whose demo is `style/03-animation.js` -- so the two halves of one fold sat in
two directories, which is the one arrangement that hides the point. It is
`style/05-quiet.js`.

**`packages/` holds the published packages and nothing else.** `packages/*` is
the glob the workspace, turbo, vitest's `projects`, and the coverage `include`
all read, so anything put there joins all four silently -- and the four
entries that belong there are the ones the table above describes. What a new
one costs is written down under "An XML config store" in `packages/config-xml`
and was paid again, identically, for the YAML one: two `--filter` lists, two
guards in `cli.test.ts`, and this paragraph. Which is the entry earning its
keep -- the second time through, the list was a checklist rather than a
discovery. The website is a private Next.js app at the top level, a workspace
member so it shares the lockfile, with its own `website/turbo.json` overriding
the root `build` task's `dist/**` for `.next/**`. `demos/` is the second such
member, for the reason the entry below gives -- neither is under `packages/`,
and neither is published. Turbo captures nothing from an output glob that does
not match, so inheriting the root's would cache a build it never saw and
restore an empty directory on a hit. `pnpm test` and `pnpm coverage` filter
their build to `./packages/*`: a test run has no use for the site, and CI runs
the suite on nine node-and-os combinations.

**Every directory a build writes is in `outputs`, and `registry/**` was the one
that was not.** The same rule the website's override is written for, missed on
the package that grew a second output directory: `@ttylabs/sigil`'s build is
`rimraf dist registry && tsdown && node scripts/generate-registry.mjs`, and
`outputs` named `dist/**` alone -- so a cache hit restored `dist/`, replayed the
generator's own `Wrote 4 registry entries` line, and left **no `registry/` at
all**. `pnpm build` then reported complete success having produced nothing for
`sigil add` to copy, and `files` in that manifest is `["dist", "registry"]`, so
a publish after a cached build ships a package whose registry is missing --
`ships no registry, so it has nothing to add`, to everyone, from a build that
said it wrote one. `test/registry.test.ts` catches a _stale_ entry and a publish
runs no tests, which is why the cache is where this has to be right. `scripts/**`
joined `inputs` for the other half of it: the generator decides what lands in
`registry/`, so editing it has to invalidate the build, and `inputs` replaces
turbo's default rather than adding to it. That last clause is true, and it was
read as saying more than it says -- `inputs` is the task's own file list and not
the whole of its hash, which is the entry below.

**`inputs` is half of a task hash, and a `workspace:` dependency in the root
manifest put every file of both packages in the other half.** The `build` task's
`inputs` names `src/**`, `scripts/**` and the configs and no `test/**`, and it is
exactly as exhaustive as the entry above says: `turbo run build --dry-run=json`
reports the resolved file list per task, and there is no test file in either
package's. Appending one comment to `packages/cli/test/output-forms.test.ts`
moved `@ttylabs/cli#build` from `d84050776124f917` to `eeda063f05221219` and
`@ttylabs/sigil#build` from `563b903ceb08765b` to `22fc8949b4f82ea3` anyway, and
reverting it moved both back exactly -- so the test file's content really was in
both. A task hash is that file list _plus_ a **global** hash, and `inputs`
narrows nothing about the second: turbo folds every file of every workspace
package the **root** manifest depends on into
`globalCacheInputs.hashOfInternalDependencies`, and the root declared
`@ttylabs/sigil` and `@ttylabs/cli` as `workspace:*`. That is the only reading
that accounts for the thing which makes no sense on its face -- an edit under
`packages/cli/test/` moving `@ttylabs/sigil#build`, which depends on nothing in
`@ttylabs/cli` -- because a global hash is shared by every task, so
`website#build` moved with them.

It was pinned rather than inferred, by a detail no other reading predicts: that
map is keyed by **package-relative** path, so the seven paths the two packages
share -- `README.md`, `package.json`, `src/index.ts`, `src/template/index.ts`,
`tsconfig.json`, `tsconfig.build.json` and `vitest.config.ts` -- collide, and one
shadows the other. Editing the `packages/cli` copy of any of the seven left
`hashOfInternalDependencies` exactly where it was, while every file unique to
`packages/cli` moved it and every file in `packages/sigil` did. What that came to
on screen is worth stating precisely, because the global hash is not the only
thing a file can be in, and getting it wrong took two review rounds. `README.md`
is the one of the seven that moves **no task hash at all**. `vitest.config.ts`
moves `@ttylabs/cli#type-check` and nothing else, because that task hashes it on
purpose. The other five move `@ttylabs/cli#build` _and_ `@ttylabs/cli#type-check`,
through those tasks' own `inputs`, and neither `@ttylabs/sigil`'s nor the
website's. That is what `inputs` is for. The collision is a fact about the global hash and
says nothing about a task's own file list. Writing the same relative path into
both packages reproduces it on demand: the `packages/cli` copy moves the internal
hash while it is unique and stops the moment its `packages/sigil` twin exists.
That is a turbo bug in its own right and is left alone; what it is doing here is
proving which mechanism was running.

There is no knob to narrow it -- `globalDependencies` only adds, and nothing in
turbo 2.11.4's schema subtracts -- so the fix is to leave the root with no
internal dependency at all. The only root-level consumer was `demos/`, which
imports `@ttylabs/sigil` by name on purpose; `@ttylabs/cli` at the root was read
by nothing but the `--filter` names in two scripts, which are turbo filters
rather than module resolution. So `demos/` is a workspace member with its own
manifest declaring the dependency where the consumer is, which is the shape
`website` already had and is the more honest statement besides: pnpm links
`demos/node_modules/@ttylabs/sigil` and node resolves it from the demo's own
directory rather than from the repository root. `demos/package.json` has to say
`"type": "module"`, because the demos were ESM by way of the root manifest and a
`package.json` between them and it would make every one of them CommonJS.

What that buys is time and nothing else: a rebuild produces the same bytes, so
nothing was ever _wrong_, which is also why nobody noticed. It is worth being
exact about how much, because the obvious guess is too high. `pnpm test` builds
the two packages first, and that is **0.85s to 1.25s** forced against a few tens
of milliseconds cached -- the spread is the machine and whatever else is running
on it, so a test run after touching a test file was paying about a second, once.
A bare `pnpm build` is where it reads as a real wait: the global hash is shared by
every task, so a `packages/cli/test/` edit also moved `website#build`, and the
Next build behind it is **2.4s** of work over a site the edit could not have
touched.

The answer is not the same for both packages, and the difference is the whole of
the entry two below: a `packages/sigil/test/` edit is now `FULL TURBO`, while a
`packages/cli/test/` edit rebuilds `@ttylabs/cli` alone, because that build really
does read its tests. The website is a hit either way, which is most of the wall
clock.

`hashOfInternalDependencies` is empty, and a README edit, a `demos/` edit, a
`packages/sigil/test/` edit and a brand-new untracked file under
`packages/sigil/test/` each move no task's hash at all. What still invalidates was re-measured rather than assumed:
`src/**` and `scripts/**` per package, `tsconfig.base.json` through
`globalDependencies` -- which still moves every task, the website's included --
and a cache hit still restores `registry/` in full, checked by deleting both
output directories and building from cache. The other global input is
`.gitattributes`, which turbo reads whether or not anybody declares it, and
rightly: it decides how git normalizes a file, so it decides what every file
hashes to. Editing it moves all three builds, and it is the only file outside
`globalDependencies` that does -- `vitest.config.ts`, the linter and formatter
configs, `AGENTS.md`, the READMEs, `lefthook.yml` and the workflows were each
tried and each moved nothing. `type-check` got sharper for free, since it hashes
`test/**` on purpose: a `packages/sigil/test/` edit now moves
`@ttylabs/sigil#type-check` and leaves `@ttylabs/cli#type-check` alone, where both
used to move.

**Taking the blanket hash away exposed a file nothing had ever declared, and
`sigil.json` was it.** The toolchain's build is `node src/sigil.ts build`, which
reads `sigil.json` for `external` and `sourcemap` -- and that file was in no
`inputs` list, so on `main` it reached the hash only as one more file of a root
internal dependency. It was covered by accident, which is the worst way for
anything to be covered: removing the accident is what made it visible, and a fix
that had stopped at "the hash is narrower now" would have shipped the hole.
Measured from both sides. On `main`, editing it moved
`hashOfInternalDependencies` from `a422655ba2e5a3a7` to `f2825ae6905d3e4c` and
`@ttylabs/cli#build` with it. With the root dependencies gone and before
`sigil.json` joined `inputs`, flipping `"sourcemap"` left `@ttylabs/cli#build` on
`8a99ba55d8f24c66`, a forced build at that very hash wrote ten `.map` files where
there had been none, and a restore afterwards handed those sourcemaps back over a
config that says not to produce them -- one cache key naming two different
bundles, with `pnpm build` reporting success over both. `external` is the same
hole and the more consequential half of it, since it decides whether
`oxc-parser` is inlined into a bundle that then cannot load it. This is the
`registry/**` incident in its other form: there a cache hit restored less than
the build wrote, here it restores something the build would not have written.

So `sigil.json` is in `inputs`, beside `tsdown.config.ts`, which is the precedent
-- and `sigil.jsonc` is beside it, because either name is
read and a task's `inputs` has to name both or the one it left out is the hole
this entry is about, back again
in both directions -- a package without the file contributes nothing, and a
package whose build reads one has to say so. The audit that turned up nothing else
is worth recording, because "the one somebody found is fixed" is a weaker claim,
and it was done twice by different means. Reading the passes gives `package.json`,
`tsconfig.json`, `sigil.json`, `tsdown.config.ts` and
`scripts/generate-registry.mjs`, with `entry.mjs` and `noop.js` being paths those
passes synthesize rather than read. Running each build under a tracer over
`fs.readFileSync` and its siblings agrees exactly: outside `src/` and the output
directories, the toolchain's build touches `package.json`, `sigil.json` and
`tsconfig.json` and **nothing at the repository root at all**, and
`@ttylabs/sigil`'s touches `package.json`, `tsdown.config.ts` and
`scripts/generate-registry.mjs`. Where that method stops is the part worth knowing
rather than glossing, and the first version of this entry glossed it: `tsc` is
TypeScript 7, a native binary, and rolldown is native too, so neither one's reads
go through node's `fs` and neither was traced. A tsconfig names what `tsc` reads
in two halves and this said only one of them. The `extends` chain was followed by
hand -- every tsconfig in both packages extends `./tsconfig.json`, both of those
extend `../../tsconfig.base.json`, and that one extends nothing and is in
`globalDependencies`, which is why editing it still moves every task. The half
that was missing is `include`, which is what decides the _files_ compiled, and it
is the entry below.
`should hash every file a build command reads` writes the list out, for the reason
the toolchain's dependencies are written out rather than counted.

**`test/**` really is an input to `@ttylabs/cli#build`, because its build gate is
the app's own `tsc` -- so the honest answer to the ticket is different for each
package.** `sigil build` type-checks with the app's `tsconfig.json`, deliberately
and for a reason recorded above: it is the same command the app's own `type-check`
script runs, so a build agrees with CI by construction rather than by coincidence.
`packages/cli/tsconfig.json` has an `include` of `./src`, `./test` and
`./vitest.config.ts`. So a type error in a **test** fails this package's real
build -- and while `test/**` was out of the hash, `node src/sigil.ts build` exited
**1** while `turbo run build` answered `Tasks: 3 successful` and `FULL TURBO` and
exited **0**. A build reported successful that cannot succeed, which is the same
lie as a cache hit restoring the wrong bytes even though the bytes here are right:
the bundle is made from `src/` and the gate runs before it, so what a hit restores
is a correct `dist/` for the current `src/`. What is lost is the gate.

Nothing can make that untrue while the gate is the app's own `tsc`, and narrowing
the toolchain's type check to `tsconfig.build.json` was the obvious alternative and
is refused: that is a change to what `sigil build` promises **every** app, taken
inside a caching ticket, and it would break the agreement with CI that the promise
exists for. So `packages/cli/turbo.json` says what is true instead -- `test/**`
and `vitest.config.ts` in that package's `build.inputs` -- rather than leaving the
hash to pretend otherwise. It is scoped to the package rather than added to the
root because `@ttylabs/sigil`'s build reads no test: `tsdown` compiles
`tsconfig.build.json`, whose `include` is `./src`, and the generator reads
`src/components/`, which the tracer confirms. Putting `test/**` at the root would
over-invalidate the more expensive of the two builds to describe something only
the cheaper one does.

The ticket asked for a test edit to be a cache hit and that is now true of
`@ttylabs/sigil`, of the website, and not of `@ttylabs/cli` -- which is the
ticket's own escape clause honoured rather than dodged, since its definition of
done was a file **no build reads**. What it costs is `@ttylabs/cli` rebuilding on
a test edit, about half a second, with `@ttylabs/sigil` and the website hit; what
it buys back is `turbo run build` failing when the build fails. Two things guard
it. `should hash the tests into @ttylabs/cli's build, because its build reads
them` is the inverse of its sibling assertion, so the two cannot both be satisfied
by one careless edit. And `inputs` **replaces** rather than extends -- the rule
this whole section is about -- so that override has to repeat the root's list, and
a root entry added later would go missing from the one package that overrode it;
`should let no package override drop a root build input` is the check for exactly
that drift, and adding an entry to the root without repeating it there fails it.
What is _not_ repeated is `outputs`: a package config merges per key, so
`dist/**` and `registry/**` are inherited by both overrides, which is asserted for
both published tasks rather than for `@ttylabs/sigil` alone.

One cosmetic surprise comes with workspace membership: `turbo run build
--dry-run` now lists an `@ttylabs/demos#build` whose command is `<NONEXISTENT>`,
because `demos` has no `build` script. Turbo skips it, `pnpm build` is three tasks
as before, and it is not even new -- `website#type-check` has always been exactly
that, for exactly the same reason.

`the build hash` in `packages/cli/test/cli.test.ts` is the guard, and it reads
turbo's own dry-run rather than `turbo.json`: the manifest is the cause and the
hash is the effect, turbo already has two ways to put a file in the global hash,
and a check that only read `package.json` would go on passing through a third. It
asserts the root manifest separately anyway, so that the failure says what to do
rather than only that a number moved. Two of its eight assertions exist only to
stop the other six going quiet -- the tasks have to resolve, the `reads` table has
to name both published packages, and `hashOfInternalDependencies` has to still be
a key turbo reports, because it is asked about by name and a renamed field would
read as `undefined`, compare equal to the empty string, and pass forever.

`packages/cli/src/` is the bin, `--version`, the schema, `src/report.ts` --
what the toolchain says, as element trees rendered with `renderToString()` -- `src/utilities/` — the utility generator, whose committed output
is `packages/sigil/src/style/utilities.ts` and whose `scripts/` writes it —
`src/template/`, the
analysis pass and the build emitter -- spliced back into an app's modules by
`src/build/compile-templates.ts` -- and `src/build/`, which reads an app off
disk: the app discovered from its manifest and entry, the command tree resolved
ahead of time, the static `desc`/`hidden` lift, the `ui` templates found in a
module, the schema literal all of that is printed as, and the type check — and
`src/build/compile.ts`, which embeds a runtime in what rolldown wrote. Its
commands are `src/commands/`: `add`, `build`, `check`, `new`, `package` and
`reference`. That sentence used to end "its commands are not written yet, and
neither is the bundling stage that feeds `src/build`'s output to rolldown",
which was true when it was written and had been false for a long time — the
shape this file records under `route-info.ts`, where a correct sentence becomes
a wrong one as the tree moves underneath it and nothing in a build reads prose.

`src/i18n/keys.ts` is generated. Regenerate it with
`node scripts/generate-sigil-keys.mjs` from inside `packages/cli`, then
`pnpm fmt`; `the committed key set` in `packages/cli/test/i18n-keys.test.ts`
fails if it and the source have come apart.

`src/width/east-asian-width.ts` is generated. Regenerate it with
`node scripts/generate-east-asian-width.mjs <unicode-version>` from inside
`packages/sigil`, then `pnpm fmt`; the version is pinned in the script so
re-running reproduces what is committed.

## Commands

Run from the repository root. `build`, `test`, and `type-check` fan out through
turborepo; `lint` and `fmt` are repo-wide and run in a single pass.

```
pnpm test          # vitest, every package
pnpm check         # type-check + lint + format check
pnpm build         # tsdown -> packages/*/dist
pnpm fmt           # oxfmt --write
```

`pnpm test <path>`, `pnpm test -t <name>`, and `pnpm test --watch` all work
from the root: tests run through one vitest over both packages rather than
through turbo, so a path argument means what it says. Turbo drives `build` and
`type-check` only.

**`test` and `coverage` name the packages they build, one `--filter` each, and
that spelling is load bearing.** They build first because `@ttylabs/cli`'s tests
read `dist/`, and the filter keeps the website out of a run that has no use for
it. It is written as exact names rather than `--filter='./packages/*'` for two
reasons, and the second is the one that cost a morning:

- pnpm runs a script through `cmd.exe` on Windows, which does not strip single
  quotes. The filter reached turbo with the quotes still attached, so it matched
  no package — and a _name glob_ that matches nothing **exits zero**. The build
  was skipped in silence and vitest then failed on a missing `dist/`, on Windows
  only, on every open branch at once, with an error telling the reader to run
  the build they had just run. Double quotes would also survive `cmd.exe`, but
  they leave the silent no-op armed for whoever edits the filter next.
- An exact name that does not resolve exits **one**. Only a glob can match
  nothing quietly, so spelling the packages out is what makes a wrong filter
  loud. `the root build filter` in `packages/cli/test/cli.test.ts` reads the
  workspace and fails if a package is added without joining the build.

`pnpm --filter @ttylabs/cli dev <args>` runs the toolchain straight from its
source -- `node src/sigil.ts` -- with no build in between, which is the loop to
use when working on it. It needs `@ttylabs/sigil` built, like everything else in
that package, and nothing else.

`pnpm --filter @ttylabs/sigil test` scopes to one package, as does running the script
from inside its directory. **`@ttylabs/cli` needs a build first** -- its source
and its tests import `@ttylabs/sigil` through that package's `exports` map, which points
at `dist/`, so on a fresh clone `pnpm --filter @ttylabs/cli test` and the editor's
type-checking both fail until `pnpm build` has run once. Testing across the real
package boundary is the point; paying for it with a build is the price.

Run `pnpm check` before considering work finished. Formatting is oxfmt with
**two spaces**, single quotes, and a 100-column width — run `pnpm fmt` rather
than matching it by hand.

**Spaces everywhere, including inside the strings the formatter cannot reach.**
`useTabs` was `true` while the JSON override beside it was already `false`
with a `tabWidth` of 2 — so the repository formatted its source with tabs and
its JSON with spaces, which is the opposite of what that override says. The
three code paths that **emitted** a tab into JSON are SIG-154's and were fixed
there, under "Writing a config file back without destroying it" in
`src/config`; the one left is `generate.ts`'s `INDENT`, which bakes the
indentation of the entry `sigil build` generates — and `tree.test.ts` pins
that entry's shape, so the two move together. What a formatter does not touch
at all is string **content**, so a tab also survived in every CSS template
literal, in the source the scaffold writes for a new app, and in the `ui`
templates the demos are read for. Every one of those is indentation somebody
reads, so they are spaces now too.

The sweep is over **tracked files** rather than a glob, and that is not a
preference: `demos/node_modules/@ttylabs/sigil` is a pnpm symlink to
`packages/sigil`, so a `demos/**/*.js` glob matches 325 files of which **276 are
vendored dependencies reached through it** — rewriting them silently, because
`node_modules` is ignored and `git status` says nothing. `pnpm install --force`
is the way back. Done once, here, which is why it is written down.

The one tab left in the tree is in `assert-label.ts`, inside backticks in a
sentence about what that guard lets through: it **is** the character being
described, so replacing it would make the comment false. `test/parser/fixtures/`
is excluded from the formatter and is left alone, and `favicon.ico` holds the
byte for reasons of its own.

## Scope

**The old 1.0 scope is gone.** It was the parser, help, ANSI wrapping, and ANSI
strip, with Titanium CLI as the acceptance test. All four shipped. The goal is
now considerably larger: sigil is a component runtime and a toolchain — the
Next.js for CLIs — and there is no 1.0 without it.

What that adds, bottom to top: a cell-addressable canvas that diffs frames,
cascading stylesheets with real selectors, a flexbox layout engine over whole
cells, transitions and keyframe animations over those cells, TC39-shaped
signals, an element tree, a renderer, compiled templates with one IR behind
several syntaxes, and a `sigil` CLI that builds and packages apps. See the "sigil 2.0" project in Linear; each layer is its own ticket and
each ticket carries the decisions behind it.

The components and the help screen are ported onto it (SIG-76, SIG-77): the
spinner, the progress bar, the table and the four prompts are element trees with
the imperative API as a facade, and help is a template. `src/help/layout.ts`,
`padCell()` and `truncateCell()` are what that deleted.

The acceptance test is now `@ttylabs/cli` itself — a framework whose own
toolchain is not written in it has not been tested by anyone who had to live
with it. The Titanium port follows rather than leads, so that it finds product
problems instead of framework bugs.

What has _not_ changed: the parser, its semantics, and every entry in the list
below.

## Deliberate decisions — do not "fix" these

These look like bugs and are not. Each is intentional and covered by tests.

- **`<value>` in an option format makes the option itself required**, not just
  its value. This diverges from Commander and yargs. Use `[value]` for an
  optional option that takes a value. Asserted in
  `test/parser/options.test.ts`.
- **The default data type is `string`, not `auto`.** `auto` guesses lossily —
  it turns `007` into `7` — and makes static types unusable. It is still
  available per option.
- **Commands resolve against the innermost context; options resolve across the
  whole context chain.** These are deliberately different. Making them the
  same breaks either parent options after a subcommand, or arguments that
  repeat a command name. Both directions are covered in
  `test/parser/regressions.test.ts`.
- **An option consumes the next token unless that token resolves to a declared
  option.** `--name --verbose` leaves `--verbose` alone; `--name --undeclared`
  takes `--undeclared` as the value. Commander errors on any dash-leading
  value, but values legitimately start with a dash and a schema only knows its
  own options. See `test/parser/option-values.test.ts` and `docs/parser.md`.
- **An option takes one value per use; only arguments are variadic.**
  `multiple` collects repeated uses (`--tag a --tag b`) into an array. An
  option never eats consecutive values, so `--tag a b` leaves `b` positional;
  `<files...>` on an _argument_ is how a list of loose values is collected. A
  `...` hint on an option is therefore rejected by `initOption` rather than
  accepted as decoration. Both Commander and yargs diverge here.
- **A counter is never an array, and a string that reaches it is coerced.**
  `type: 'count'` already collects repeated uses, into a number rather than an array, so `multiple`
  on a counter is refused by `initOption()` the way a `...` hint is -- it asks for
  nothing a counter does not do, and the two were read by paths that disagreed:
  the counting path ignored `multiple` when the flag was used and `applyFallback()`
  wrapped the default when it was not, so `argv.v` was `2` used and `[0]` unused.
  The invariant is enforced where the value lands as well as where it is declared,
  because `multiple` stays editable after init and a hook could otherwise put it
  back. `transformValue()` coerces a counter like an `int` for the same reason: a
  value from the environment or a string `default` used to stay a string, so
  `VERBOSE=lots` put the word on a destination the types call a number; an empty
  value is `0`, matching `bool`, and whitespace throws, also matching `bool`.
  Either property alone is consistent, which is what said the combination was the
  bug. A counter reached with an explicit value is **set** to it rather than
  incremented, so `-v -v=5 -v` is `6`: every flag read an attached value as a
  `bool`, which a counter is not, so `-v=2` threw `Invalid boolean: "2"` and
  `-v=false` was accepted and then discarded -- the counting path increments and
  never looks at the value, so it counted up to 1. An explicit value beating the
  name it was reached by is the rule `--flag=false` already follows. Two things
  a counter does not escape, because no type escapes them: a non-string
  `default` passes through untouched, and a negated twin sharing the
  destination writes `false` -- which is why inference types that pair as
  `number | boolean`. See `test/parser/options.test.ts`.
- **An option that takes a value must be given one, required or not.** `<>` and
  `[]` say whether the _option_ has to appear -- `[value]` is an optional option
  that takes a value -- and neither says the value may be left out, so a bare
  `--port` throws `Missing value for option --port` either way. This replaces an
  earlier rule where a valueless use yielded what the data type called empty:
  that made `--port` a value, and a value from argv outranks everything, so
  `PORT=321 mycli --port` answered `0` while `PORT=321 mycli` answered `321`.
- **`--port=` is a value, and an empty one is a value only where the type has
  one.** `string` has an empty value and gets `''`; `bool` and `count` are flags
  and read empty as off; every other type rejects it the way `date` and `json`
  always did. So `--name=` is `''` even on a `<value>` option -- requiredness is
  about the option appearing, not about what it was given -- while `--port=` on
  an `int` throws `Invalid integer`. It is the one way to say "deliberately
  empty", which is why it is not second-guessed.
- **An empty environment variable is read as unset.** `PORT=` in a shell or a
  `.env` file is how a variable gets left blank and almost always means "not
  configured", while an empty value is one most data types now reject -- so
  honoring it literally would fail a parse over a variable nobody meant to set.
  It falls through to `default` instead. A counter still ends at `0` for
  `VERBOSE=`, by way of the flag's own default rather than by coercing the empty
  string.
- **An attached value is taken exactly as typed; only the name is trimmed.**
  `--name=value` splits one token, and trimming both halves made the two
  spellings of one thing disagree: a value in the following token was never
  trimmed, so `--sep=' '` was `''` while `--sep ' '` was `' '` -- and `''` on a
  `<value>` option then failed as a value never given. Whitespace in a value is
  the caller's.
- **What follows `--` goes through whole.** Extra arguments are documented as
  verbatim, and they were flattened from `inputs`, which is the split form:
  `--foo=bar` had been taken apart into a name and a value in the very first
  pass, before anything knew a terminator preceded it, so one extra argument
  arrived as two. Each token is put back as it was typed.
- **A data type rejects what it cannot represent, and whitespace is not
  empty.** An `int` past 2^53-1 used to come back as a different integer --
  `Number('9007199254740993')` is `...992` -- which is the one failure a caller
  cannot detect, so it throws. `number` used to read a whitespace-only value as
  `0`, because `Number(' ')` is `0`, while `int` threw on it. Space around a real
  number is still that number, since `Number()` trims -- only a value with
  nothing else in it is the empty one. `number` rejects an empty or blank
  value for the same reason `int` does -- `Number('')` and `Number(' ')` are both
  `0`, and neither is a number somebody wrote. A `date` has
  its calendar checked before the `Date` is built, because `Date` overflows
  instead of refusing and `2024-02-30` arrived as March 1st -- the wrong day
  rather than the error `9999-99-99` already got. Checked arithmetically and not
  by reading the parts back off the `Date`: those getters are local while the
  value may be UTC, so `2024-06-15T00:00:00Z` is the 14th in Chicago and the
  15th in Auckland, and a round trip rejected real instants depending on where
  it ran.
- **A `date` has its clock checked as well as its calendar, and it takes a UTC
  offset.** The calendar check above stopped at the day, and hour `24` is the
  overflow the `Invalid Date` guard cannot see: `24` is a legal two-digit match
  and `new Date('2024-01-01T24:00:00')` is a perfectly valid `Date` for the next
  midnight, so a value naming January 1st arrived as the 2nd -- the same failure
  `2024-02-30` arrived as March 1st is written down for. Minute and second `60`
  are refused alongside it, so a leap second is this library's answer rather
  than whatever the engine happens to do. Read off the matched text and never
  off the built `Date`, for the reason already recorded: those getters are local
  while the value may be UTC. The offset is the other half of it -- the docs
  said ISO 8601 while `dateRE` took a trailing `Z` and nothing else, so
  `2024-06-15T12:00:00+00:00`, which is what `date -Is` prints, was rejected
  while the `Z` spelling of the same instant was taken. The subset is the
  date-time format ECMAScript specifies and no wider: the basic form
  `20240615`, week and ordinal dates, `±HHMM`, and a space in place of the `T`
  are all outside what `Date` is _specified_ to parse, and an engine's fallback
  heuristics are not a grammar to document. An out-of-range offset is refused
  arithmetically for the reason the clock is, rather than left to `Date`, which
  only happens to reject it. See `test/parser/regressions.test.ts`.
- **`auto` runs the same checks and gives up rather than throwing.** The calendar
  check was added to `date` while `auto` went on matching the same `dateRE` with
  neither half of it, so the defect stayed alive on a second path: `2024-02-30`
  was March 1st and `2024-13-01` an `Invalid Date`, an object whose `getTime()`
  is `NaN` with nothing having said so. That path is also the default one, since
  an undeclared option is coerced with `auto` -- it is reachable without anybody
  writing `type: 'auto'`. Both now read a match through one function, because two
  readers of one pattern disagreeing about what it proves is how the first fix
  reached only one of them -- and it is why the clock and the offset above cost
  nothing to share: they went into that function rather than beside it, so the
  widened pattern and everything that reads it stayed one answer. What follows
  differs and belongs to the caller:
  `date` was asked for a date and throws, while `auto` is a ladder of guesses
  that ends at the string it was handed -- it does not throw on JSON it cannot
  parse either -- so a date-shaped string that is not a date is simply not the
  date guess. Throwing there would fail a parse over an undeclared option nobody
  declared a type for, which is the opposite of what `allowUnknownOptions` is
  for. `auto` still reads a 13-digit epoch as a number rather than a date: the
  two types match different shapes on purpose, and sharing the check does not
  merge them. See `test/parser/regressions.test.ts`.
- **A data type name is matched anchored.** `optionTypesRE` and `argTypesRE`
  were written `/^auto|bool|...|yesno$/`, where the alternation binds looser
  than the anchors -- so the pattern read as `^auto` OR `bool` OR ... OR
  `yesno$` and any string merely containing one of the middle names passed.
  `integer` and `boolean` are the two somebody actually types, and past the
  guard `transformValue()` does not know either name, so it handed back the raw
  string and a `type: 'integer'` option quietly produced `'8080'`.
- **What ships carries no raw control character, because the minifier puts back
  what the source was careful to avoid.** `src/ansi/codes.ts` builds `ESC` with
  `String.fromCharCode(0x1b)` so that a raw control character never sits in
  source, where it is invisible in an editor and in a diff -- and the minifier
  constant-folds that straight back into a raw byte, which undoes the care
  somewhere nobody was looking. A raw `ESC` in a shipped file is a sequence
  waiting for something to print it, and Node prints the offending source line
  on an uncaught error: a crash anywhere inside `style.mjs` wrote
  `ESC ] 8 ; ; ${e}` to the user's terminal -- the hyperlink opener, with the
  template literal unexpanded -- and every line after it, the stack trace
  included, was inside a link nothing ever closed. Measured on a pty: three raw
  `ESC` bytes and one OSC 8 executed, from a one-line script that only called
  `rgb()` with a bad channel. A build step escapes every C0, `DEL` and C1
  character to `\xNN`, which is the same string to JavaScript and inert to a
  terminal, and `test/dist.test.ts` reads the bytes back -- a build that quietly
  stops doing it looks exactly like one that does. `\t`, `\n` and `\r` are left
  alone as the file's own formatting. This is the same rule the alternate screen
  and the cursor already follow: a CLI that dies must not take the terminal with
  it, and that has to hold for the crash as well as for the exit.
- **And the source carries none either, which is the half nobody was checking.**
  The rule above is about what ships; it says a raw control character must never
  sit in source, "where it is invisible in an editor and in a diff" -- and the
  file that enforces it was breaking it. `tsdown.config.ts` wrote its escape
  regex as a character class of _literal bytes_, a NUL among them, and git calls
  a file binary the moment it finds one in the first 8000: so the one file whose
  whole job is keeping raw control characters out of the build had no reviewable
  diff on GitHub at all, showing `Bin 2786 -> 2858 bytes` instead. `canvas/style.ts`
  had the same literal NUL in its link guard, at byte 9376, which the heuristic
  misses -- the identical bug, waiting for the file above it to grow. Neither was
  wrong to the regex engine, and that is the point: what a raw control character
  costs is paid by whoever reads it. Both are written `\u0000` now, and
  `test/sources.test.ts` is the other half of `test/dist.test.ts` -- one reads
  what shipped, one reads what is committed. A handful of tests and demos really
  are describing a terminal's own bytes and hold them literally; they are an
  explicit list rather than an inferred rule, so that the next one is a decision
  somebody makes.
- **The escape pass matches `\p{Cc}`, which is the same idea one step further.**
  A class of `\u0000`-escapes still tripped `no-control-regex`, so it carried an
  `eslint-disable-next-line` -- and in the toolchain's copy of the pass the
  formatter later wrapped the call, moved the regex onto its own line, and left
  the comment above the line it had been written over. The warning came back
  with nobody having edited anything: a suppression a formatter can detach from
  its target is one that stops working silently. `\p{Cc}` is exactly C0, `DEL`
  and C1 -- verified against all 1,112,064 code points -- with `\t`, `\n` and
  `\r` handed back by the replacer rather than carved out of a range. It names
  the set instead of enumerating it, it carries no control character escaped or
  otherwise, and there is no suppression left to keep in place. Both copies say
  it the same way, since two spellings of one rule is how they come to
  disagree.
- **The styler skips an extended color's own parameters.** In the semicolon
  form `38`, `48`, and `58` spread one color over the parameters after them, and
  `reopen()` read those as attributes: `38;2;255;0;0` carries a `0`, was taken
  for a reset, and reopened the whole outer chain on top of the inner color, so
  `ansi.blue(ansi.rgb(255, 0, 0)('x'))` rendered blue. `38;5;39` carries the
  foreground's own close code and did the same. Only the semicolon form skips:
  the colon form carries the whole color inside one parameter, so there is
  nothing after it to skip and skipping anyway swallowed whatever followed.
  `src/wrap/sgr-state.ts` already
  modeled this for the wrapper; the two say it separately rather than sharing a
  module across the styler and the wrapper.
- **An extended color's semicolon form is five parameters or six, and only an
  empty color space says which.** ITU T.416 puts a color space identifier
  between the mode and the channels -- `38;2;;255;0;0` -- and both tables counted
  five, which is the same bug the skip was written to fix, reintroduced by the
  longer spelling: the blue channel was left to be read as an attribute, and a
  blue of `0` is a reset, so `ESC[1;38;2;;255;0;0m` left nothing in effect and
  `ansi.blue()` reopened over a red that came in written the long way. Six is
  taken only when that parameter is _empty_, because a non-empty color space is
  exactly as plausible a red channel and five is what every emitter writes --
  sigil's own output included, which is why nothing it emits was ever affected.
  So `38;2;1;255;0;0` is still a color and a trailing attribute. The colon form
  is untouched either way: `38:2::255:0:0` is one parameter, so there is nothing
  after it to count. Both tables changed and both stayed separate, for the reason
  the entry above gives. See `test/ansi/style.test.ts` and
  `test/wrap/sgr-state.test.ts`.
- **A sequence the wrapper cannot reopen travels with the word it applies to.**
  A break throws away the gap between two words and keeps the effect of the SGR
  that was in it, because opening the next line from the state is what writes
  those attributes back. A hyperlink has no slot in that state -- `sgr-state.ts`
  passes OSC through _untouched_, and untouched only happens when the sequence
  is written out -- so one still pending at a break was deleted: an OSC 8 open in
  front of a word that wrapped took the link away, and a close in the gap left
  every later line, and anything joined onto the result, inside the hyperlink.
  `isSgr()` is what says which of the two a sequence is, asked in one place so
  that the wrapper and the state cannot come to disagree. What is carried is
  written at the start of the next line, after the attributes that line reopens:
  SGR and OSC are separate terminal state, so their order between themselves
  says nothing. See `test/wrap/wrap.test.ts`.
- **`bool` is strict and symmetric.** `true`/`t`/`yes`/`y`/`on`/`1` are
  true, `false`/`f`/`no`/`n`/`off`/`0`/`''` are false, case-insensitively,
  and anything else throws. It does not follow minimist's
  "anything but `'false'`" rule, which made `--flag=0` true, nor
  yargs-parser's "only `'true'`", which makes `--flag=1` false. Every other
  data type already rejects input it cannot parse, and `0`/`1` is the usual
  convention for boolean environment variables.
- **Flags default to `false`, or `true` when negated — never `undefined`.**
  Commander leaves an unspecified flag undefined. A declared flag here always
  has a value, so `argv.verbose` is safe to read without a guard.
- **A bare positional name is optional; `<name>` is required.** Commander
  treats a bare name as required. Brackets are the only thing that decides it
  here, which keeps `args` readable at a glance.
- **`Missing required arguments` names the arguments that are missing, and
  nothing else.** The walk is backwards and used to report every argument
  sitting before one it had already found missing, to collect the trailing run
  of them -- which is the promotion rule said a second time and said less
  accurately. `initArgs()` already makes an optional argument before a required
  one required, so each slot in a run answers for itself, while the run also
  named a slot `applyFallback()` had just filled from a `default` or an
  environment variable: `<a>` with a default and `<b>` with nothing reported
  `<a> <b>` and asked for a value the user had supplied. The parse still fails,
  because `<b>` really is missing; only the message changed. See
  `test/parser/regressions.test.ts`.
- **String `default`s and environment values are coerced to the declared
  type.** So `default: 'yes'` on a flag is `true`, not `'yes'`, and a value
  the type rejects throws — `default: 'black'` on a flag is an error, the
  same way a default of `'nope'` on an `int` is. Non-string defaults pass
  through untouched.
- **The option format string is loose on purpose.** Extra short or long names
  become aliases rather than errors, and a bare word declares `--word`.
  Commander rejects all of those. Genuinely malformed parts — `-ws`,
  `---triple` — still throw.
- **An option and its negated twin share a destination, and the valued one
  owns it.** `'--cheese <type>'` plus `'--no-cheese'` is one destination set
  by two options, as in Commander. Unlike Commander it is order-independent,
  which costs the negated flag its implied `true`: the valued twin decides the
  default, so the pair is `undefined` until something sets it rather than
  silently `true`. A `default` declared on the flag is still honored, and
  `negate: false` opts out of the pairing. See `test/parser/options.test.ts`.
- **Producing the values and judging them are two steps, and `afterParse` fires
  between them.** It used to fire at the end of `parseArgv()`, which is before
  `processArgs()` and `processOptions()` -- the two that write `state.argv` -- so
  a hook named "after parse" saw `{}` there while `state.$` was fully populated,
  and the one thing it is for was the one thing it could not do. The fix is not
  to move it to the end: the README has always documented it as firing "after,
  before validation results are returned", and a hook that fires after the
  judging cannot fix up a value while one that fires before the values exist has
  nothing to fix. So `processArgs()` and `processOptions()` write and apply
  fallbacks, `validateArgs()` and `validateOptions()` do the judging, and the
  hook goes in between. Keeping that window is also what keeps a rule below
  reachable: a hook that replaces an option after its value was read leaves a
  value with no live writer, and it is `validates()` at judging time that stops
  that being a way around `choices`. A parse that throws on the way in -- an
  unexpected argument, a value its type rejects -- still fires no `afterParse`,
  because there is no parse to be after. See `test/parser/hooks.test.ts`.
- **`main()` handles errors instead of rejecting.** A thrown value from
  `parse()` or from the command's `run()` is rendered by `errorHandler()` —
  the message, never a stack — `process.exitCode` is set, and `main()`
  resolves with `undefined`. Its caller is a bin script, so an unhandled
  rejection dumping a stack is the wrong default. `settings.errorHandler:
  false` rethrows instead; a function replaces the handler.
- **`main()` dispatches a `run` on the schema when argv named no command, and
  the schema really is the root command.** `parse()` builds `contexts[0]` from
  `initCommand({ ...schema, ... })` and `copyDeclaration()` carries `run` across
  with everything else, so the root has always _been_ a command carrying the
  schema's `run`, its `args` and its `options` -- and `main()` dispatched only
  the command that **matched**, which the root never is. So that `run` was
  unreachable: a single-command app, which is what `sigil new --single`
  scaffolds, parsed argv and then did nothing at all, exit zero, nothing said.
  Removing that is one `?? state.contexts.at(-1)`, and what makes it a fix
  rather than a change to what `main()` promises every app is that **nothing can
  have depended on it**: code that never ran has no behaviour to preserve, so
  the only app this moves is one carrying a handler it was silently not calling,
  and it moves it towards doing what it said. Which is also why the whole suite
  passed before a test was added -- 7,514 of them, none describing a root `run`.

  The rule is one sentence and deliberately not two: a `run` on the schema is
  what the app does when argv named no command, **whether or not it also
  declares `commands`**. The narrower reading -- only when there are none, which
  would mirror the "nothing ran, so print help" rule's own condition -- was
  refused because it makes a working `run` go silent the day somebody adds a
  commands directory beside it, which is the silent-behaviour-change-on-an-
  unrelated-edit shape this file refuses everywhere. What outranks it is what
  outranks any command: `--help`, `--version`, and a `default` command, that
  last one because dispatching one sets `state.cmd` and an explicit declaration
  about a command with its own name, args and help entry beats the root
  answering by position. Reached through `state.cmd` being unset rather than
  through its `run` being unset, so a **namespace** command argv really did name
  still lists its children instead of the root answering for it.

  The other available fix was scaffolding a hidden `default` command, and it is
  refused twice over: it leaves the framework's own root `run` dead, so an app
  that writes the obvious thing by hand still does nothing, and it costs the
  root help screen the schema's own arguments -- measured, `[who]` leaves the
  usage line, because the argument then belongs to the command. `Schema.run` is
  declared in the types for `Schema.desc`'s recorded reason, a property the
  framework reads being one the types should name, and **not** typed `| null`
  the way `Command.run` is: `initCommand()` refuses a `run` that is not a
  function, so that one permits what the runtime throws on. Covered by
  `test/root-run.test.ts`; the measurements and the sabotage pass are in
  [docs/history/a-run-on-the-schema-which-is-how-a-single-command-app-is-writ.md](docs/history/a-run-on-the-schema-which-is-how-a-single-command-app-is-writ.md).

- **Every hook is one function, not a list of them.** `beforeParse`,
  `afterParse`, `beforeError`, `init`, `parse` and `help` all take a function,
  which is what `transform` and `settings.errorHandler` already take -- so the
  one-element array that every example used to open with is gone, and with it
  four `Array.isArray` checks and the loops behind them. What a list bought was
  registration without coordination: a plugin could append to a command it did
  not declare. That is a wrap now, and the docs say so -- read the hook, replace
  it with one that calls what it found first. Deliberate, because the framework
  has no plugin system to coordinate and a list is a worse default for the
  ninety-nine cases that declare exactly one: it reads as though order matters
  between entries nobody wrote. The `hooks` object is still copied by
  `initCommand()`, for the reason the lists used to be -- a hook that replaces a
  hook on the command it was handed must not reach back into the caller's
  declaration and change what every later parse of that schema does. What is
  _not_ copied any more is a list inside it, because there is no list.
- **A `beforeError` hook may replace the error but never suppress it.**
  Returning nothing leaves the error alone, returning a value makes that value
  the error, and a hook that throws is logged and skipped. Suppression would
  have to mean something different at every throw site — what `parse()`
  returns, whether the command still runs — and a rule that cannot hold
  everywhere is worse than no rule. Hooks fire for every throw site, inside
  `parse()` for what `parse()` throws and inside `main()` for everything
  else, innermost command first and the schema last, before rendering and
  before the `errorHandler: false` opt-out -- one per source, and a hook that
  throws is skipped without stopping the next source's. See
  `test/parser/hooks.test.ts`.
- **A `default` command is dispatched whenever argv named no command, even
  when it declares required arguments.** `default` means the name is implied,
  not that the command is a fallback that steps aside when the arguments are
  inconvenient — so `mycli` with a default `build <entry>` reports
  `Missing required arguments: <entry>` rather than silently doing nothing.
  Only applying it when there are no positionals would also make
  `mycli out.js` an `Unexpected argument`, which is the case a default command
  exists for. Two siblings both marked `default` throw while the schema is
  built; picking one would pick it by registration order. See
  `test/parser/default-command.test.ts`.
- **Undeclared options produce values rather than erroring.** `--foo` is
  `foo: true`, `--foo bar` is `foo: 'bar'`. They resolve after every command
  has been matched, coerce with `auto`, do not read `no-` as negation, and do
  not reach `state._`. `settings.allowUnknownOptions: false` restores the
  `Unknown option` error.
- **An undeclared option never writes a destination something active describes.** An
  undeclared spelling can land on one -- `--verbose` where `-v` is declared
  `{ name: 'verbose' }`, `--logLevel` where `--log-level` is declared -- and it
  arrives with none of what the declaration says: `auto` guessed its value, and the
  declared type, `choices`, `multiple`, and `transform` were all skipped. So the
  declared value stands and the undeclared one is dropped from `argv` rather than
  overwriting it. Dropped rather than an error because pass-through is what
  `allowUnknownOptions` is for, and an unlucky spelling should not fail the parse;
  what was typed is still on `state.$`. Active is every option in the chain plus
  the arguments of the command being run -- an ancestor's arguments are never read
  once a subcommand is dispatched, so they own nothing -- and it is asked at the
  moment of the write, because a `transform` or a hook can add an option while argv
  is still being walked.
- **A value is validated by whoever wrote it.** More than one declaration can reach
  one destination -- a valued option and its negated twin, an option and a
  positional argument of the same name, a nearer context's option of the same
  destination -- and each has its own `choices`. The parser records which
  declaration produced what is on a destination and validates only that pairing, so
  `--cheese brie --no-cheese` is `cheese: false` rather than
  `Invalid value "false" for option --cheese`, and a `false` the valued option
  produced itself is still checked. The old rule -- skip a `false` when a negated
  twin exists -- was a guess at the writer's identity from the value, and it was
  wrong in both directions. A value with no _live_ writer is the exception and is
  checked by every declaration that can reach the destination: that is a value a
  hook wrote on `state.argv` itself, or one whose writer a hook has since replaced,
  and without it a hook would be a way around `choices`. See
  `test/parser/options.test.ts` and `test/parser/regressions.test.ts`.
- **The first bare label in a command name is the name; the rest are
  aliases.** `'build, b'` and `'build b'` declare `build` aliased `b`. A `@` or
  `!` prefixed label is always an alias and names the command only when there
  is no bare label, so `'@ls, list'` is named `list` while `'@b'` alone is
  named `b`. Covered by `test/parser/regressions.test.ts`.
- **A `!` name prefix and an explicit `hidden` are additive.** Either one
  hides a command; an explicit `hidden: false` does not un-hide a `!` prefixed
  name — drop the `!` instead. That holds for a lazily loaded command too: the
  placeholder carries the `!`, the module never sees it. A command that
  declares neither always reads back `hidden: false`, never `undefined`, and a
  non-boolean `hidden` throws. `!` on any label hides the whole command, not
  just that one alias; an alias that should stay out of help without hiding
  the command belongs in the `alias` property, which never reaches the help
  label. Covered by `test/parser/regressions.test.ts`.

- **A command module's default export must be a plain object.** `typeof null` is
  `'object'` and so is an array, so a bare `typeof` check let both past: `null`
  fell through the merge and marked the placeholder loaded, an array merged into
  an empty command, and either way the parse succeeded with a command that has
  no `run` and a load recorded as done -- so `main()` did nothing at all, which
  is a worse answer than the error a string export already got.
- **A package's `exports` is resolved recursively.** The map nests -- `"."`
  holds conditions, a condition holds more, an array is a fallback list -- and
  unwrapping exactly one level left the ordinary
  `{ ".": { "import": "./index.js" } }` as an object, which reached `join()` as
  `[object Object]` and reported the package as having no valid export. Only the
  conditions this loader can honor are read: `import`, `node`, `default`, then
  `require`, since a CommonJS entry still loads. `browser`, `types`, and user
  conditions are skipped rather than guessed at.
- **A path in a command declaration is relative to the file that declared it.**
  A command's own `path` was resolved against the module it came from and the
  subcommands that module declared were not, so a module exporting
  `commands: { all: './all.js' }` -- the layout a large CLI actually wants --
  was looked up from the process's working directory, which for an installed
  CLI is wherever the user was standing and has nothing to do with where the
  command modules live. Three things hold it together. The directory is settled
  before the subcommands are registered rather than after, because registering
  them is what reads their paths. It is carried as `cmd[Internal].baseDir`
  rather than recovered from the command's own resolved `path`, which points
  one directory away from the file that declared it -- and is what a hook reads
  to resolve a path of its own. And it is `resolve()` rather than `join()`, so
  an absolute path stays the answer it already was instead of being hung off a
  base. `loadCommand()` therefore hands `initCommand()` the file system path
  and builds the `file://` URL only for the dynamic `import()`, which is the
  one reader that wants one: `dirname('file:///a/b.js')` is not a directory
  anything can be resolved against. A schema the app wrote inline has no file
  to be relative to, so its own paths still resolve from the working directory
  -- which is why every example passes an absolute one. Covered by
  `test/parser/regressions.test.ts`.
- **A loaded module's declaration is one file's, because the placeholder's
  subcommands are handed over already built.** They are the one thing in the
  merge that a second file wrote, and a merged declaration cannot say which
  directory each half is relative to: a placeholder giving `'./sub/build.js'` as
  its `path` and `'./all.js'` as a subcommand means `all.js` beside the file
  that declared the placeholder and everything `sub/build.js` declares beside
  `sub/build.js`, and one base cannot be both.
  So the placeholder's registry goes into `merged.commands` as initialized
  commands rather than as the paths they were declared as -- `initCommand()`
  hands an initialized command straight back, so registering them again costs
  nothing and resolves nothing -- and every path left in the merge is the
  module's own. Picking the base by where the subcommands came from was the
  first answer and it was wrong in the other direction: it gave the loaded
  command the placeholder's base, so the module's own `path` and anything a
  hook of the module's resolved were read against the wrong directory.
- **A command declares a module to load or a handler to run, and not both.**
  The module at `path` _is_ the command: `loadCommand()` builds the merge from
  its export and fills in only what the module left `undefined`, so an inline
  `run` beside a `path` is a handler that runs on exactly the modules that
  happen not to declare one -- and a path that cannot be read is a hard error
  however good the inline handler was. Neither half is a thing to pick between
  at dispatch time, so it is refused where the schema is built, the way two
  `default` siblings and a `...` hint on an option already are. The `Command`
  interface carried a `file` property alongside `path` for the same stretch,
  which nothing in either package ever read: `[key: string]: unknown` is on that
  interface for custom data, so `{ file: './build.js' }` type-checked,
  registered a command with no module and no handler, and then did nothing when
  dispatched. It is gone.
- **And `Command.choices` went the same way, because a command has no value for a
  list of allowed ones to constrain.** `choices` vets a value against a list, and
  the two places it means something are an `Option` and an `Argument`, each of
  which has one. A command is matched by _name_, so there is nothing on it to vet
  -- which makes this not an unimplemented feature but a property with no coherent
  meaning to implement, and that is the distinction worth keeping: `inSelection()`
  is kept with no caller in `src/` because the question it answers has one right
  answer, and this had no question.

  Measured rather than read, because `[key: string]: unknown` makes the type say
  nothing either way. Nothing in either package read it: every `.choices` in `src/`
  is `opt.choices`, `arg.choices`, or a prompt's own unrelated one, and `infer.ts`
  reads it only off an option or an argument declaration. Nothing validated it
  either, where `initOption()` throws `Expected option choices to be an array` --
  `{ choices: 'not-an-array' }`, `42` and `{ a: 1 }` on a command were each
  accepted, copied onto the internal command by `copyDeclaration()`'s generic array
  pass, and reached `run()` as `cmd.choices` having done nothing. It was not in the
  README's command-property table either, which is the worse half of a dead
  property: a reader meets it in the type through completion and there is no
  documentation to tell them it does nothing.

  Deleting it is **not** a breaking change, which is why it could simply go: the
  index signature is still there, so `{ choices: [...] }` on a command type-checks
  exactly as before and still arrives at `cmd.choices` -- as the custom data it
  always was. Verified after the deletion rather than assumed. What differs is that
  reading it back is `unknown` rather than `readonly unknown[]`, which is the type
  telling the truth.

  `Schema` never had one, and that asymmetry is suggestive rather than decisive:
  `Command` declares nine properties `Schema` does not -- `alias`, `default`,
  `desc`, `examples`, `hidden`, `load`, `path`, `run` and this -- and the other
  eight are each about a command being matched and dispatched, which the root is
  not. The deciding evidence is the reader count rather than the shape, and the
  near miss is `routeInfo`: that one has no _producer_ left in the tree and is read
  in `init-command.ts` on every placeholder, so it is live API that looks dead. A
  property with no reader is dead; a property with no producer is a contract.

- **A path nobody named is a directory _of_ commands; a path somebody named is
  one command.** `commands: './commands'` means every route inside becomes a
  sibling, which is the one place a single path produces more than one command,
  while `commands: { db: './db' }` means one command called `db` however many
  files sit behind it. The asymmetry is what the key is for, and without it
  there is no way to say either thing: a directory that always meant "one
  command" could not express a command tree's root, and one that always meant
  "these commands" could not express a subcommand with children.
- **...and that is as true of a command's `commands` as of the schema's, which
  the _type_ refused for as long as both existed.** `Schema.commands` has always
  been `string | (string | AnyCommand)[] | Record<string, string | AnyCommand>`
  while `Command.commands` was `Record<string, AnyCommand>`, so on a **nested**
  command both spellings in the entry above were a type error -- a path for a
  directory of them, and a path as a value. The runtime read every shape there
  all along, measured on all five: a path, a list of paths, a list of
  declarations, a map of paths and a map of declarations each resolve a nested
  command's subcommands exactly as they do the schema's. So the narrow type
  bought nothing and cost a type error on correct, documented code, in the one
  place a `tsc` would meet it and nothing here would: every case in the suite
  declared its paths on the **schema**, which is why a repository that routes its
  own toolchain had never hit it. It is the same shape as a property the engine
  ignores, inverted -- a feature that works, is documented twice, and will not
  compile -- and the cost fell entirely on apps rather than on anything in here.

  What pins it is a `tsc` rather than the runner, and the sabotage is what says
  so: narrowing it back fails `pnpm check` on four lines of
  `routing.test.ts` while that file's own 56 tests all still pass. The tests are
  there to give the type-check something to check, since `packages/sigil`'s
  `include` covers `./test` -- a runtime assertion cannot see a type that moved.

- **A route is a module file or a subdirectory, and `index` is the directory
  itself.** Inside a directory, a module file -- `.js`, `.mjs`, `.cjs`, `.ts`,
  `.mts` or `.cts` -- is a command named after the file and a subdirectory is a command named after the
  directory, as deep as the tree goes. An `index` module beside them is that
  command -- its `desc`, its `options`, its `run` -- and is never a command
  called `index`, which is one rule rather than two: where there is no directory
  command for it to be, as in a bare `commands: './commands'` whose own command
  is the schema, it is nothing at all. A directory with no `index` is a
  namespace that matches, lists what is under it, and has no `run`. An entry
  whose name starts with a `.` is skipped, because `.gitkeep`, `.DS_Store` and a
  `.git` directory all end up beside command modules and none of them is a
  command anybody wrote. Two routes claiming one name -- a `config.js` beside a
  `config/` -- throw, since keeping one of them keeps whichever `readdir` handed
  over second, which is the file system deciding what an app does; routes are
  registered sorted for the same reason.
- **A lifted description is a cache over the walk, never a manifest.**
  `Route.desc` is `undefined` for everything but a package, because every other
  kind keeps its description _inside the module_ -- so a routed tree lists names
  and nothing else until each module has been imported, and not importing them
  is the whole of what the deferral buys. `Schema.routeInfo` is where a build
  that keeps the walk puts what it lifted -- `sigil build` bakes the tree
  instead, so nothing in this repository fills one, and what stays live is the
  contract such a build fills. It is read where a placeholder is built and
  nowhere else,
  which is what keeps it a cache: the directory is still read, every route it
  finds is still a command, and a route with no entry still works and simply
  lists without a description. That is what stops a command dropped into an
  installed app being _invisible_ rather than merely undescribed, and it is why
  this cannot go stale in a way that loses a command -- only in a way that loses
  a sentence. The filesystem wins wherever it has an answer, so a package's own
  manifest beats a lifted entry: that read is free and cannot go stale, and the
  lift exists to fill what the walk could not say rather than to second-guess
  what it could. A nested directory's entries are carried _down_ the walk rather
  than looked up, for the reason `baseDir` is: a level only knows where it sits
  in the tree because the level above told it. And after the module loads, the
  module's own `desc` wins -- which is what a hand-declared placeholder already
  did, so the lifted case is not a second precedence rule to remember.
- **A directory is walked one level at a time, when something asks.** The walk
  is `loadCommand()`'s rather than the discovery's, which is the same deferral a
  module's import already gets and the reason a tree is worth having: `mycli db
  migrate up` reads `commands/`, `commands/db/` and `commands/db/migrate/` and
  nothing else, so sixty commands cost one `readdir` per level argv actually
  names and one `import`. Walking eagerly would read the whole tree on every
  invocation including `--help` and including a mistyped command -- paid by the
  unbundled apps this exists for, since a built app has its tree baked in. It is
  also what bounds a cycle through a symlink without a guard: nothing walks a
  level nobody asked for, so argv is the bound. The cost is that a subdirectory
  lists by name alone in its parent's help until it is read, which is the rule a
  lazily loaded module already follows -- and is what `sigil build` extracting
  descriptions statically is for.
- **A command module may be TypeScript, and nothing compiles it.** `.ts`, `.mts`
  and `.cts` are routes beside `.js`, `.mjs` and `.cjs`, because every runtime
  this package supports strips types on its own: `engines` says node >=22.19.0
  and stripping has been on by default since 22.18, so there is no capability to
  detect and no flag to document. A `.cts` is still CommonJS and a `.mts` still
  an ES module, since stripping erases annotations and does not rewrite module
  syntax -- and what it cannot erase, an `enum` or a namespace with a runtime
  body, is Node's limit rather than this one. A **declaration file is not a
  route**, which is the half that is invisible until it bites: `deploy.d.ts`
  parses as a name of `deploy.d` and an extension of `.ts`, so left alone it is a
  command called `deploy.d` -- and sitting beside the `deploy.ts` it describes it
  is a second claim on `deploy`, which is the two-routes-one-name error raised
  over a directory with nothing wrong with it. Compiled output is the ordinary
  way to have both. A `.ts` and a `.js` that really do both claim one name still
  throw rather than resolving by a preference order, for the reason the rule
  above gives twice over: a stale build artifact quietly winning is how somebody
  edits the file that is not being loaded. The same goes for two index modules.
  Proved by `packages/cli/test/typescript.test.ts` rather than from inside the
  suite, and that is not a stylistic choice -- vite transforms whatever a test
  file imports, so a test here proves vite can read TypeScript and not that node
  can, and it cannot read a `.cts` at all. A spawned node with no flags is the
  only thing that answers the question, which is the same reason the demos are
  spawned and the same reason a test that needs `dist/` lives in that package.
- **A package names itself, wherever it was found.** A `package.json` name beats
  the directory the package sits in, so a walk that finds `commands/pkg/` whose
  manifest says `routes-pkg` registers `routes-pkg` -- and `pkg` is then not a
  command at all. That is the rule a package a declaration pointed at already
  followed, where a key of `foo` over a path to a package registers whatever the
  package calls itself rather than `foo`, pinned by
  `test/parser/commands.test.ts`. One rule rather than one per way of arriving at
  the same directory. What differs is only what has to be read to learn the name:
  a package pointed at is imported, because its _module_ may rename it again,
  while a package a walk found is named out of its `package.json` -- a file read
  rather than an import, so the name is known in time to match on and the module
  still waits for a match. Reading that manifest per subdirectory of a level
  being walked is what the rule costs, and it is the only thing a level's walk
  reads beyond its own `readdir`. A package is also never walked for routes: its
  `exports` is what says which module is the command, so the files beside it are
  internals rather than subcommands.
- **A uid of `0` is a uid, and `mkdirOwnerSync()` owns what it made and nothing
  else.** Root is `0` and `0` is falsy, so asking `uid && gid` read a caller who
  asked for group `0` -- `wheel`, and the group of every ancestor under `/var`,
  `/usr`, and `/root` -- as a caller who asked for nothing; the walk then put
  the same `0` back through `gid ||= st.gid`, and the falsy `gid` failed the
  guard on the chown pass, so the ownership that was asked for was never
  applied. An explicit `uid: 0` was overwritten by whatever owned the nearest
  existing directory for the same reason. Whether an owner was given is a
  question about `undefined`, so that is what is asked. Both halves of the
  answer are asked about too: a directory `mkdirSync()` has just made as root is
  `0:0`, so a caller asking for `{ uid: 0, gid: 1000 }` matched on the uid alone
  and stopped with the group never applied. The deepest directory that already
  exists is the last one the call did not make, so it is where the chown pass
  stops as well as where an owner is read from -- it used to be looked for only
  in the second case, and the first was given the file system root, which is no
  ceiling: that pass climbs until it meets a directory already owned by the
  target, so a cache under `/var` handed `/var` away along with what it had just
  made. The walk itself stops at the root whether or not it found anything,
  because it climbed until it found a directory and `dirname('/')` is `'/'`: a
  loop that relies on finding something is a loop that can run off the top of
  the filesystem. Reached from the update cache, which a CLI run as root
  creates. See `test/mkdir-owner-sync.test.ts`.
- **A command is fixed once it is initialized, and its declaration containers
  are read-only.** `cmd.args`, `cmd.commands`, and `cmd.options` echo the
  declaration; the parser reads the normalized arguments and the registries at
  `cmd[Internal]`, which are a different shape on purpose. Assigning,
  deleting, or adding to one of those three throws rather than silently
  failing to reconfigure a built command. A hook changes a command through the
  registries it is handed — `options.add()`, `args.push(initArg(...))`,
  `commands.add(await initCommand(...))` — which take effect immediately. The
  Proxy `set` traps that used to stand in for this could never have worked:
  building a command or an option is async and a `set` trap is not. The same
  line is drawn on options and arguments: `choices`, `default`, `multiple`,
  `required`, `transform`, and `type` are read on every parse and are editable
  in place, while `alias`, `env`, `format`, `name`, and `negate` built the
  registry lookups and the destination, so they are read-only too. Covered by
  `test/parser/schema.test.ts`.
- **A live region shows the cursor only if it is what hid it.** `begin()` called
  `terminal.hideCursor()` and recorded the cursor as hidden whatever the call
  did, so a full-screen app that hid the cursor itself and then ran a spinner got
  it back the moment the spinner stopped -- over its own screen, which never
  asked for one. `hideCursor()` already kept the flag that made the second call a
  no-op; it now reports whether it did the work, which is the one question a
  caller that owes a `showCursor()` has to ask. Eviction works out by ordering
  rather than by a second mechanism: the region being evicted finishes, and hands
  the cursor back, before the region evicting it claims and hides again. See
  `test/terminal/live.test.ts`.
- **A terminal takes its `EPIPE` guard off again, and puts it only on the stream
  it wrote to.** The guard is a listener on somebody else's stream -- an `error`
  event with no listener is an uncaught exception, which is how
  `mycli --help | head -1` kills a CLI that did nothing wrong -- and it was the
  one thing `createTerminal()` attached that nothing ever removed: `restore()`
  detaches the `exit` and signal handlers, `onResize()` hands back an
  unsubscribe, and `guarded` was a latch that never reset. It also went on both
  streams at once however few were written, so a terminal that never touched
  stderr still left a listener on it. Both halves surfaced as one warning, and
  only from the suite: `live.test.ts` builds twenty-eight terminals over a fake
  stdout, each of them guarded the real `process.stderr`, and under vitest that
  is one `WritableWorkerStdio` shared by every test in the worker -- so the
  eleventh is Node's ten-listener leak warning, on a stream those tests never
  meant to touch. A CLI makes one terminal per process and never approaches ten,
  which is why nothing shipped was wrong and the rule still is: put back what you
  attached. `writeTo()` is where a guard is attached now, which makes the comment
  the function already carried -- attached on the first write, since a stream
  nothing writes to cannot produce one -- true of each stream rather than of the
  pair, and it happens before the write rather than after, since an `EPIPE` that
  very write provokes arrives as an event. `restore()` detaches them, after its
  own writes, because each of those re-guards the stream it goes to.
  `syncRestore()` deliberately does not: a terminal with nothing left to put back
  is still a terminal being written to, and dropping the guard there would take
  it off in the window where an `EPIPE` from the write that just happened is
  still on its way. A write after a `restore()` guards again, so the teardown
  costs nothing to a caller that carries on. See
  `test/terminal/terminal.test.ts`.

### Paths

- **Every base directory is read through one rule: expand, then require
  absolute.** The XDG spec says a base directory must be absolute and that a
  relative one is to be ignored, so `XDG_CACHE_HOME=./.cache` falls back rather
  than putting a cache in whatever directory the app happened to be started
  from. The `~` is expanded _before_ that is asked, and that ordering is the
  half the module used to disagree with itself about: `XDG_CONFIG_DIRS` always
  expanded its segments and the four `_HOME` variables never did, so
  `XDG_CACHE_HOME=~/.cache` reached `mkdir` as a directory named `~` -- the same
  defect the table's own `~/Library/Caches` entries carry an entry for, fixed
  there and not here. The rule is `baseDir()` and everything asks it: each
  environment variable, each segment of a `_DIRS` list, and each entry of the
  platform table. Two consequences follow from asking it everywhere. An empty
  `_DIRS` segment -- `XDG_CONFIG_DIRS=:/etc/xdg`, or a list with a trailing
  separator -- is a hole rather than a directory, where `expand('')` is `'.'`
  and truthy and `combinePaths()` could not tell it from a real entry, so the
  working directory joined the config search path. And a Windows fallback array
  walks past an entry that did not expand: `expand()` leaves `%LOCALAPPDATA%` as
  it found it when the variable is unset and the literal is truthy, so the array
  stopped at its first entry and `~/AppData/Local`, the fallback the array
  exists for, was unreachable. Absoluteness is `node:path`'s, so it is the
  running platform's -- a drive-relative `C:foo` is absolute nowhere, which is
  the answer Windows itself gives -- and `join`, `normalize` and `delimiter` are
  already bound that way; a second, call-time platform decision for this one
  check is how one line comes to disagree with the next about which platform it
  is on. `~user` is a shell convention `expand()` does not implement, so it stays
  literal and is refused by the same rule rather than becoming a directory named
  `~nobody`, and a `~` with no home to put over it stays a `~` for the same
  reason. That last one needed `home()` fixed to mean it: it was
  `paths ? join(_home, ...paths) : _home` and an array is always truthy, so a
  bare `home()` went through `join()` and there was no way back out --
  `join('')` is `'.'`, so a home the platform could not name came back as the
  working directory, and `expand()` had no falsy value to leave the `~` alone
  over. A real path where there is none is the one failure the caller cannot
  see. See `test/paths.test.ts`.

### `which`

- **Written here, and the shape waited for a caller.** SIG-48 sat in the backlog
  on the rule that a feature nothing needs is a feature designed by guessing,
  and the caller that turned up is `sigil new` asking which package managers are
  installed before it offers a choice between them. Everything below is a
  decision that caller forced rather than one taken in the abstract.
- **A miss is `undefined`, not a throw.** The ordinary use is "is this
  installed", whose usual answer is no -- and a question asked with a `try` is
  one whose common path is an exception. A caller that wants an error writes
  one, and it can say what the executable was _for_, which is a better message
  than anything this could raise.
- **Sync and async share `candidates()`, which is pure.** It is the whole of the
  platform argument -- `PATHEXT`, the delimiter, the quoted entry, the working
  directory -- and the two walks differ only in how they ask whether a file is
  there. Two implementations of _where to look_ is how the two come to disagree
  about `PATHEXT` on the platform neither author runs. It is a generator, so the
  usual case does no work for the ninety entries after the hit, and it is
  exported because the ordering is worth asserting directly rather than through
  a filesystem.
- **The async walk is sequential, and that is not an oversight.** _First_ means
  first in `PATH`, so racing the candidates would buy microseconds across a few
  dozen `stat`s and then have to sort the winners back into the order they were
  already in.
- **Being a file is half the executability test, and `access()` is the other
  half.** A directory called `node` in a `PATH` entry answers `X_OK` happily,
  because searching a directory is what the execute bit means there. And the
  bits are read by the kernel rather than by hand: the question is whether
  _this_ process may execute it, which is the effective uid and gid against
  three sets of bits plus whatever ACLs the filesystem adds. Hand-rolling it
  also gets root wrong in the direction that matters -- root may execute a file
  only if some execute bit is set, and a check that sees uid 0 and says yes
  reports every text file in `/etc` as a program.
- **Windows has no execute bit, so the extension is the whole test.** Requiring
  `X_OK` there would refuse every executable on the platform; the file existing,
  with a name `PATHEXT` accounts for, is what "executable" means. Which is also
  why an extensionless file is _not_ a match on Windows, though it is the only
  kind that matches on POSIX.
- **The empty extension goes first when the name already holds a dot.** `pnpm`
  has to be tried as `pnpm.COM`, `pnpm.EXE`, `pnpm.CMD` and the rest in order,
  while `pnpm.cmd` must not come out as `pnpm.cmd.EXE`. One rule covers both --
  and it keeps the list reachable for `my.tool`, which holds a dot and still
  wants `my.tool.EXE`. Special-casing "has an extension" instead means deciding
  whether `.tool` is one, which is a question about `PATHEXT` that the list
  already answers.
- **The answer carries the candidate's spelling, not the file's.** `PATHEXT` is
  conventionally upper case and almost nothing on disk is, so on Windows --
  where the filesystem is case-insensitive -- `tool.exe` is found by the
  candidate `tool.EXE` and that is the string handed back. Learning the real
  name means a `readdir` per directory, which is a lot of syscalls to make a
  path that already spawns look tidier. Pinned in both directions by a test that
  _probes_ the filesystem rather than reading the platform, since macOS is
  case-insensitive by default and case-sensitive if somebody formatted it that
  way.
- **An empty `PATH` entry is the working directory, and so is a relative one.**
  POSIX says the first, a trailing separator is how anybody meets it, and the
  second is the same statement one directory along -- so both go through
  `resolve()` rather than the empty one being a special case beside a bug.
- **Windows searches the working directory first and strips quotes off an
  entry.** The first is what the shell does, and a caller asking what _would_
  run has to get the same answer. The second is because `PATH` holds whatever
  somebody pasted into it, and a `"C:\Program Files\nodejs"` with the quotes
  left on resolves to a directory that is not there.
- **A name with a separator in it is a path and is never searched for.**
  `./pnpm` names one file, which either is executable or is not; resolving it
  against every `PATH` entry until one hits would make a path mean a search
  after all. The extensions still apply, because `./build` may be `./build.CMD`.
  Windows adds the backslash and the drive-relative `C:pnpm`, which is a path
  with no separator in it at all.
- **`whichAll()` deduplicates.** A shell profile sourced twice is a `PATH` with
  one directory in it twice, which is not two installations -- and a caller
  counting the answers would be told that it was.
- **The platform is read per call rather than bound at module load.** That is
  what makes the `PATHEXT` half testable at all on the machine it is written on,
  which is the same seam `paths.test.ts` already uses. It is not the exception
  `paths.ts` records for absoluteness: that entry is about _one_ check reading
  the platform differently from the line next to it, and here every reader takes
  it from the same argument in `candidates()`.

## Where the subsystem decisions live

The entries that used to sit under "Deliberate decisions — do not "fix" these" are in an
`AGENTS.md` beside the code they are about, so a session loads the ones
for the subsystem it is touching rather than all of them. Claude Code
loads one automatically when it works with a file in that directory;
any other agent should read the file for the area it is changing before
it changes anything there.

**They are not optional reading.** Every entry in them is a decision that
looks like a bug and is not, and the cost of not reading one is the
decision being re-litigated or "fixed".

| decisions for                                                              | entries                                                                                                                                                                                                                                                                                                                                                 |
| -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`packages/cli`](packages/cli/AGENTS.md)                                   | The build: reading an app off disk · Writing the CLI in sigil · `sigil new` · The registry: what `sigil add` copies · `sigil package`: a binary, and which runtime is inside it · A markdown command reference, and a surface snapshot · What the build tells an app's update check to look at                                                          |
| [`packages/config-xml`](packages/config-xml/AGENTS.md)                     | An XML config store, in a package of its own                                                                                                                                                                                                                                                                                                            |
| [`packages/config-yaml`](packages/config-yaml/AGENTS.md)                   | A YAML config store, and the second time an outsider implemented `ConfigStore`                                                                                                                                                                                                                                                                          |
| [`packages/sigil/src/canvas`](packages/sigil/src/canvas/AGENTS.md)         | Canvas · Layers and masks: compositing, and the transition it buys                                                                                                                                                                                                                                                                                      |
| [`packages/sigil/src/completion`](packages/sigil/src/completion/AGENTS.md) | Shell completion, printed from the tree the parser already holds                                                                                                                                                                                                                                                                                        |
| [`packages/sigil/src/components`](packages/sigil/src/components/AGENTS.md) | A scroll box: the scrollbar, scroll-into-view, and culling · A debug overlay: captured console output and frame stats · The built-in components · Prompts and keys                                                                                                                                                                                      |
| [`packages/sigil/src/config`](packages/sigil/src/config/AGENTS.md)         | A layered config module: one merged view over an ordered stack · Writing a config file back without destroying it · A config watcher that survives our own atomic write                                                                                                                                                                                 |
| [`packages/sigil/src/debug`](packages/sigil/src/debug/AGENTS.md)           | Debug logging                                                                                                                                                                                                                                                                                                                                           |
| [`packages/sigil/src/element`](packages/sigil/src/element/AGENTS.md)       | The element tree                                                                                                                                                                                                                                                                                                                                        |
| [`packages/sigil/src/help`](packages/sigil/src/help/AGENTS.md)             | Help                                                                                                                                                                                                                                                                                                                                                    |
| [`packages/sigil/src/i18n`](packages/sigil/src/i18n/AGENTS.md)             | Translating: the English is the key                                                                                                                                                                                                                                                                                                                     |
| [`packages/sigil/src/input`](packages/sigil/src/input/AGENTS.md)           | Input and focus · Key sequences · The mouse · Selection and the clipboard                                                                                                                                                                                                                                                                               |
| [`packages/sigil/src/layout`](packages/sigil/src/layout/AGENTS.md)         | Layout · Out of flow, paint order, and clipping                                                                                                                                                                                                                                                                                                         |
| [`packages/sigil/src/parser`](packages/sigil/src/parser/AGENTS.md)         | Output formats: `run()` returns data, a serializer presents it · A schema's relative paths · An `afterRun` hook: `finally`, `postrun`, and the telemetry seam in one · "Did you mean": the nearest thing the reader could have typed · `:` as a topic separator, a tokenizer alias and nothing more · Sharing options between commands · Type inference |
| [`packages/sigil/src/renderer`](packages/sigil/src/renderer/AGENTS.md)     | Rendering a tree to a string · The renderer                                                                                                                                                                                                                                                                                                             |
| [`packages/sigil/src/signals`](packages/sigil/src/signals/AGENTS.md)       | Signals                                                                                                                                                                                                                                                                                                                                                 |
| [`packages/sigil/src/style`](packages/sigil/src/style/AGENTS.md)           | Light and dark · A quiet axis: one place that decides whether anything may draw · Style · Stylesheets and the cascade · Colour degradation · The utility layer · Style invalidation · Transitions and keyframe animations                                                                                                                               |
| [`packages/sigil/src/template`](packages/sigil/src/template/AGENTS.md)     | Templates                                                                                                                                                                                                                                                                                                                                               |
| [`packages/sigil/src/terminal`](packages/sigil/src/terminal/AGENTS.md)     | Asking the terminal what it is                                                                                                                                                                                                                                                                                                                          |
| [`packages/sigil/src/testing`](packages/sigil/src/testing/AGENTS.md)       | Testing helpers, and the faked TTY our own suite proves you need                                                                                                                                                                                                                                                                                        |
| [`packages/sigil/src/theme`](packages/sigil/src/theme/AGENTS.md)           | Themes                                                                                                                                                                                                                                                                                                                                                  |
| [`packages/sigil/src/updates`](packages/sigil/src/updates/AGENTS.md)       | Updates · What the update check can and cannot survive · An update check that is switched on rather than called                                                                                                                                                                                                                                         |

How each was arrived at — the review rounds, the sabotage passes, the
by-hand audit passes — is in [`docs/history/`](docs/history/), one file
per entry, linked from the entry itself. Read it when you need to know
why rather than what: it is the record of what each round found.

## Known bugs

- A subcommand's option used before its subcommand is not protected from being
  consumed as an earlier option's value, because it is not declared yet on the
  pass that reads it. A default command's options are always in that position,
  since it joins the chain only after argv has been walked. See the warning in
  `docs/parser.md` and the pinned tests in
  `test/parser/default-command.test.ts`.

- **A nested `main()` whose error escapes fires `beforeError` twice**, so a
  schema hook sees **the same error object** two times. Measured over the three
  shapes a composing command can take, which is the distinction that matters: not
  caught is **2 fires of the identical message**, caught and handled is **1**, and
  caught and re-wrapped is **2 of two different errors** -- which is one per error
  and is the documented rule rather than the defect. Twice for a nested _parse_
  failure and twice for a nested `run()` throw, equally. `main()` records `hooksFired` only for its own `parse()`
  (`src/index.ts`), so the error reaching the outer `handleError` has nothing on
  it to say the hooks already ran -- and `collectHooks()` dedupes by hook
  identity _within_ one call, which a second `main()` is not. Found by review
  round 2 of SIG-134, and pre-existing: a nested `main()` has always been
  possible, and what the palette work changed is that the package README now
  documents it as how to compose commands.

  The shape of a fix is the dedupe one step out -- record on the error which
  hooks have fired, the way the state is already carried on it under
  `ErrorState`, so the outer call skips the ones it shares and still fires a
  _different_ schema's. It is not taken here, because error-handling semantics
  for every app is not a thing to change inside a ticket about a palette, which
  is the same refusal the toolchain's type-check narrowing already records. What
  is done instead is that the README's own pipeline **catches**, which is what a
  composing command should do anyway: `errorHandler: false` means the caller
  handles it, so a caller that lets it through is asking for the outer handler to
  report a failure it knows more about than the outer handler does. Worth being
  exact about what that buys, because the first write-up of this implied more:
  catching does not take the second fire away, it makes the second fire be
  **about a different error**. Which is the whole of the complaint -- what is
  wrong is one error reported twice, not two errors reported once each.

## Conventions

- **Every dependency is pinned to an exact version, in every manifest.** A caret
  means a fresh install and a six-month-old lockfile can resolve to different
  trees -- and for a native binary, which `rolldown` and `oxc-parser` both are,
  that is a different binary on somebody's machine with nothing in the diff to
  point at. The lockfile pins the resolution; the manifest pins what is
  _asked_ for, which is what a range widens again the moment anybody reinstalls
  without one. `.npmrc` sets `save-exact=true` so `pnpm add` writes it, and
  `pinned dependencies` in `packages/cli/test/cli.test.ts` asserts it across the
  workspace -- because a setting only the person who ran `pnpm add` sees is a
  setting that drifts, and both ranges this repo has ever had arrived exactly
  that way. A `workspace:` link is not a range and is skipped; a **peer**
  dependency is deliberately left one, since it declares what the toolchain
  accepts from an app rather than what it installs, and pinning `typescript`
  would refuse every app on a different one.
- ESM only. Imports use `.js` extensions even for `.ts` sources -- **except
  inside `packages/cli/src/`, which uses `.ts`**. That is not drift, it is what
  makes `node src/sigil.ts build ...` work: Node's type stripping is erasure and
  does not rewrite specifiers, so a `.js` import of a `.ts` file is a module not
  found. The toolchain is the one package worth running straight from source --
  it is a tool rather than a library, and the alternative is a tsdown build
  between every edit and every try. `@ttylabs/sigil` keeps `.js`, because it is
  only ever consumed through its `exports` map and a `.ts` specifier would buy
  it nothing. `allowImportingTsExtensions` is set on `packages/cli` alone for
  the same reason.
- Internal state hangs off the exported `Internal` symbol, not enumerable
  properties, so schema objects stay clean for consumers. `parse()` stashes the
  state it died with on the error it throws the same way, under `ErrorState`,
  so the error path can still reach the matched command.
- **`init*()` copies, never decorates.** The caller's schema, commands, args,
  and options are read-only inputs: every normalized value and the `Internal`
  symbol land on a new object the library owns. So the same schema object
  parses identically any number of times, a frozen schema parses, and a lazily
  loaded command module — which the ESM loader shares with every other
  importer — is merged into a copy rather than written to. Asserted in
  `test/parser/schema.test.ts`.
- **No Proxies.** Internal commands, arguments, and options are plain objects.
  Anything that has to stay in sync is built once by `init*()`; anything a
  consumer may change afterwards is a property nothing is derived from.
- **A registry's lookup table is null-prototype.** A command really can be named
  `__proto__`, and on a plain object `lookup['__proto__'] = name` goes through
  `Object.prototype`'s accessor and is dropped -- the command registered and
  could never be matched. `OptionRegistry` had the same hole from the other
  side: argv reaches an option by its dashed spelling, which registers fine, but
  the bare name is a key too, so `options.get('__proto__')` could not find an
  option the registry holds -- and the registries are what a hook is handed. The
  inherited members are the other half of it, since `constructor` and `toString`
  read back truthy and answer a lookup nothing declared.
- **A destination is cased by `toUpperCase()`, never by the process locale.**
  `camelCase()` used `toLocaleUpperCase()`, which reads it -- and in Turkish and
  Azeri `i` uppercases to `İ` (U+0130), so every destination a separator built
  moved on a machine set to `tr-TR`: `--log-info` landed on `logİnfo`, as did an
  undeclared option's and an argument's. `src/infer.ts` writes the same rule with
  TypeScript's `Capitalize`, which has no locale, so the types said `logInfo`
  while the runtime did not -- and only there, because `\w` is ASCII and `i` is
  the only letter whose mapping differs, so an en-US CI can never see it. A
  destination is a JavaScript identifier rather than prose, and an identifier has
  no language. Covered by `test/parser/regressions.test.ts`.
- Parser errors are thrown as plain `Error`s with user-facing messages; they
  are what the user sees, so write them accordingly.
- Prefer a regression test named after the defect over a comment explaining it.
- **A demo is part of the published surface, and it was the only part nothing
  checked.** The demos import `@ttylabs/sigil` by name, so they resolve through
  the package's `exports` map and read `dist/` -- which is the point of them, and
  which also puts them outside the type-check: they are `.js` at the repository
  root, nothing runs them, and a named import of an export that no longer exists
  is not a lint error. It is a `SyntaxError` raised when somebody runs the file.
  `06-ansi-and-wrap.js` went on importing `padCell()` for a whole pull request
  after the component rewrite deleted it, with the suite green throughout and the
  README still documenting the export beside it. `packages/cli/test/demos.test.ts`
  is both halves of the answer, and it lives in that package because
  `@ttylabs/cli` is the one whose tests already require a build -- the same
  reason `the root build filter` lives there. It reads every demo's static
  imports and asks the built package for each name, which is a read rather than
  a process and fails naming the export that went missing. Then it spawns each
  one and asks for its exit code and its stderr, because a demo that imports
  fine and then throws is invisible to the first half.
- **A demo may not wrap its whole body in a `catch` that logs, because then it
  cannot fail.** `demos/config/01-layers.js` did, over a `catch` whose comment
  described a refusal nothing in the demo provoked -- so when a rename left a
  `jsonc(user)` call behind, the `ReferenceError` came out as
  `refused: jsonc is not defined` on **stdout**, with exit 0 and no stack frame,
  and `demos.test.ts` passed. Which is that test's own contract honoured exactly:
  it asserts an exit code, an empty stderr and no stack frame, and a demo that
  catches its own `ReferenceError` and prints it as prose satisfies all three.

  The fix is the `catch` rather than the test. With it gone -- a bare
  `try`/`finally`, which is all the cleanup needed -- the same sabotage exits 1
  with a stack and the test fails, verified both ways. A narrow `try` around the
  one statement whose throw is the point is the right shape and is what
  `03-links.js` and `09-errors.js` already have; `04-prompts.js` is the sharper
  version of it, narrowing on `err instanceof PromptError` and **rethrowing**
  anything else. Swept: those three are the only other top-level catches and all
  three are correct.

  The reason this is worth an entry rather than a commit message is that the
  demo's own prose was the thing that hid it. A `catch` describing a case the
  demo had stopped exercising reads as deliberate, so nobody asks what else it
  swallows -- the shape this file keeps recording, with a test-visible cost this
  time rather than only a reader's.

- **The demos are run piped, and that is the interesting half rather than a
  concession to CI.** `demos/README.md` documents what each one does without a
  terminal -- a spinner writes one line per change, a bar one line every ten
  percent, a prompt fails rather than waiting forever on a stdin that will never
  produce a keystroke -- so running them this way checks the documented
  behaviour, and it needs no pty, which is what lets it run on all nine of CI's
  node-and-os combinations. A demo that does not exit `0` with nothing on stderr
  is an explicit list of two rather than an inferred rule, for the reason the
  raw-control-character exceptions already are: `04-prompts.js` is the non-TTY
  rule and exits `1` with the line the README prints, and `09-errors.js` is the
  demo about errors, whose narrative is stdout while what reaches stderr is what
  `errorHandler()` rendered. A stack frame in either stream fails every one of
  them whatever the exit code said, since that is a throw nobody caught -- and
  that is the one check that also catches an unhandled rejection which still
  exits `0`. The watchdog is the other thing worth having: a demo that hangs is
  killed and reported by name, rather than a suite that never finishes. It costs
  about six seconds of wall clock, which is `it.concurrent` over a sequential
  eighteen -- run always, because a check that is skipped is a check that rots.
- **A test's fixtures are platform-specific whenever its subject is, and the
  suite cannot tell you that.** Three Windows failures on one branch had one
  shape: a fixture written the way the author's machine spells things, asserted
  against code that was behaving correctly. A `~` expanded through
  `os.homedir()`, which reads `USERPROFILE` there and `HOME` here, so a test
  setting only `HOME` scaffolded into the runner's real profile directory. A
  path printed through `displayPath()` is forward-slashed everywhere, so an
  expectation built with `join()` is backslashed on Windows and nowhere else.
  And `which`'s own tests wrote extensionless executables joined with `:` --
  neither of which is a program or a delimiter on the platform half of them
  existed to cover. Each passed locally, on macOS and on Linux, and failed on
  three jobs at once. The rule that follows is that a fixture for
  platform-dependent behaviour is written with the same function the subject
  uses -- `delimiter` rather than `':'`, `displayPath()` on both sides -- and
  what genuinely cannot hold on a platform is `it.skipIf`'d rather than left to
  fail there. The cheap check is to run the file with the _other_ platform's
  answers forced, which is what `asWindows()` already exists for: the whole of
  `which.test.ts` passes under win32 semantics on a Mac, and that is a minute
  against a round trip through CI.

  A fourth instance arrived in SIG-127, and it is worth adding because it is a
  shape the three above do not cover and because it was written **immediately
  after** reading this entry. `shake-walk.test.ts` asserted that one of two links
  had been entered with a regex of `/(?:one|two)$`, which matches nothing against
  the `src\one` that `join()` builds on Windows -- so all three Windows jobs failed
  over a walk that had done exactly the right thing, and the other three platforms
  were green. `asWindows()` could not have caught it: that forces what the
  _subject_ reads about its platform, and what was wrong here was the **test's own
  spelling of a path**. So the rule has a sharper form, which is the one to
  remember: a test never writes a separator at all. `basename(path)` is the fix,
  `sep` where a separator really is the subject, and a path compared against
  another path built the same way -- `startsWith(root)` and `slice(root.length)`
  were fine in that same file for exactly that reason.

  **A fifth arrived in SIG-149, and it is an errno rather than a spelling.** A
  test provoked a non-absence read error with a path **under a file**, which
  is `ENOTDIR` on POSIX and reads as **absence** on Windows -- so it pinned
  the claim on two platforms and failed on the third. Neither `asWindows()`
  nor a rule about separators reaches it: what differed is what the filesystem
  answered. The portable way to provoke one is a **directory**, which is
  `EISDIR` everywhere, and core's own test of the same claim already used one.
  So before writing a fixture that depends on a failure, check whether a
  sibling test provokes the same one some other way -- the repository usually
  knows, and the full entry is under "An XML config store, in a package of its
  own" in `packages/config-xml`.

  **A sixth arrived in SIG-144, in both of the shapes this entry already names,
  and the rule has a sharper form because of it: a test never spells a path it
  could ask a function for.** Two tests over one message, both failing on all
  three Windows jobs and nowhere else, and neither was the code. One asserted
  `toContain(out)` where the summary prints through `displayPath()`, which
  forward-slashes -- so the expectation could not match on Windows, and its
  sibling `not.toContain(dir)` could not **fail** there, which is the same slip
  pointing the other way. The other spelled the refresh command as
  `` `sigil reference ${dir} --out ${docs}` ``, and a Windows path holds a `\`,
  which is not in `word()`'s safe class -- so the message correctly **quoted**
  it and the test demanded the bare form.

  What makes it the sharper form rather than a sixth repetition is that
  `asWindows()` reaches neither: both are the test's own spelling of a value the
  subject had already produced. So the fix in each is to ask the producer --
  `displayPath(out)` for the path a reader is shown, and the argument array a
  real shell builds for the command, which is `passed()` and is what the quoting
  tests beside it already did. The second is stronger than the literal it
  replaced besides: it asserts the subcommand and every argument as a shell reads
  them rather than as a concatenation.

- **An assertion is a call, and `expect(x).to.be.ok` is not one.** Chai spells
  that one as a getter, so it reads to a linter as an expression nobody used --
  and the narrowing it does not do is what made it worse than noise: each of the
  four uses was followed by an `if (result.cmd !== undefined)` wrapping the
  assertions that actually said something, so a command that failed to load
  skipped them and was caught only by the getter. `expect(result.cmd?.name)` is
  what the rest of the suite already writes, says the same thing in one line,
  and fails on the value it was asked about.

<!-- BEGIN:turborepo-agent-rules -->

- **A new decision goes beside the code it is about, and the record of how it
  was reached goes under `docs/history/`.** This file was one file for a long
  time and reached **1,997,217 bytes** — about 470k tokens, half of a 1M
  context window, loaded unconditionally by every session through
  [CLAUDE.md](CLAUDE.md) before a single source file was read. Of that, 97.5%
  was one section, `Deliberate decisions`, and 55% of the whole was review
  rounds and sabotage passes: the history of how a decision was reached rather
  than the decision in force. It was growing about 65 KB a day, so this was a
  trend rather than a level.

  So the decisions for a subsystem live in an `AGENTS.md` beside it and are
  loaded when something touches that directory, the history lives in
  `docs/history/`, and what stays here is what applies everywhere. **A new
  entry goes in the subsystem file, not in this one** — appending here is how
  the problem comes back, and it comes back silently, because nothing in a
  build measures a context window. The one thing that belongs here is an entry
  that is true of every package, like this one.

  Which is also why the nested files are called `AGENTS.md` rather than
  something else: about fifty source comments say "AGENTS.md records ..." about
  their own subsystem, and the nearest `AGENTS.md` is now the one that does. A
  comment naming a _section_ resolves through the index above in one hop. The
  cost that is real and is not fixed by naming is that an entry no longer
  always in context is an entry somebody can re-litigate; the index is what
  stands against that, so it names every file and says that reading the one for
  your area is not optional.

- **A byte figure in these files is a measurement as of its own change, not a
  claim about the tree today.** The same root entry is recorded at several
  different values across them, and every one of them was right when it was
  taken -- it is **11,991 B over seven modules** as of this entry, and it will
  not be for long. So a figure is written in the past tense and anchored to the
  change that moved it, which is a sentence that cannot go stale; what a build
  actually checks is the **ceiling** in `packages/sigil/test/dist.test.ts`, set
  about 2x over what an entry is so that ordinary growth never touches it and
  pulling the parser or the renderer onto one does.

  Re-derive rather than reading any of them, and with `staticGraph()` from that
  same test rather than a script of your own: it reads `dist/`, so it needs a
  build first, and a second implementation of "which modules does this entry
  pull in" is how two figures for one entry come to disagree. That is not
  hypothetical -- `dist.test.ts` and the testing entry disagreed about
  `testing.mjs` by 4.4 kB under a comment asserting they were the same figure,
  which is the two-comments-disagreeing defect those comments are themselves
  written about.

  What is deliberately **not** done is chasing every figure on every commit. It
  is wrong again the moment anything is added, and most of these figures are a
  before-and-after of one change rather than a description of the tree -- which
  is evidence for a decision, so rewriting it to today's number would destroy
  the thing it is there for.

# This is NOT the Turborepo you know

Turborepo configuration, task behavior, and CLI commands can vary between installed versions and may differ from your training data. Resolve the `turbo` package from this file's directory or relevant workspace; in monorepos, it may not be visible from the repository root. For example, run `node -p "require.resolve('turbo/package.json')"` from a workspace that depends on `turbo`.

Read `docs/README.md` inside that installed package first, then read the relevant pages from its `docs/` directory before changing Turborepo configuration or commands. Heed deprecation notices. These bundled docs match the installed package version and are available without network access.

This block is written and re-added by `turbo` before repository-scoped commands when an AI agent is detected. In the Turborepo source repository, its template is defined in `crates/turborepo-cli/src/cli/agent_guidance.rs`. Removing the managed block while updates are enabled means a later qualifying invocation will add it again. Set `"agentGuidance": false` in the root `turbo.json` or `turbo.jsonc` to opt out; this does not remove an existing block. Keep the block committed with your work to avoid an uncommitted change on the next agent invocation.
<!-- END:turborepo-agent-rules -->
