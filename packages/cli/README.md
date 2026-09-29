# @ttylabs/cli

The sigil toolchain. It resolves an app's command tree, checks it, and packages
it into an executable that depends on nothing.

This package may depend on whatever it needs — a bundler, a parser — because it
is a devDependency of your app rather than part of what your app ships. The
runtime it compiles against, [`@ttylabs/sigil`](../sigil), stays at zero
dependencies, and so does what this produces.

There is no `sigil dev`. This is a resolver and a compiler, not a server.

## Commands

| Command       | What it does                                                |
| ------------- | ----------------------------------------------------------- |
| `sigil new`   | Scaffolds an app                                            |
| `sigil check` | Reads an app and reports what is wrong, without building it |
| `sigil build` | Bundles it into one executable plus a chunk per command     |
| `sigil add`   | Copies a component's source into your app, so you own it    |

`build` runs `check`'s pass rather than replacing it, so an app that builds is
one that checks out.

## Configuration

`sigil.json`, beside your `package.json`. Every field is optional, and a
command-line flag beats the file:

```json
{
  "components": "src/components",
  "build": {
    "external": ["some-native-package"],
    "name": "mycli",
    "out": "dist",
    "safelist": ["text-red"],
    "shake": true,
    "sourcemap": true
  }
}
```

`external` names packages to import rather than inline. You need it for a
package carrying a **native binding** — nothing inlines a `.node`, so its
JavaScript would be bundled and then look for a binary that is no longer beside
it. Anything listed has to be installed where the app runs, and the build says
so when it finishes.

`name` is only needed when your `package.json` publishes more than one `bin`;
otherwise the executable is named after the one it publishes.

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
