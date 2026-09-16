# main2

A framework for building CLI apps in Node.js, and the toolchain that packages
them. The heart of it is a multi-pass hierarchical argument parser built for
CLIs that lean heavily on subcommands.

This is a pnpm workspace with two published packages.

| Package                            | Name         | What it is                                                                   |
| ---------------------------------- | ------------ | ---------------------------------------------------------------------------- |
| [`packages/main2`](packages/main2) | `main2`      | The runtime an app is written against. **Zero dependencies, always.**        |
| [`packages/cli`](packages/cli)     | `@main2/cli` | The toolchain. Provides the `main2` bin and may depend on whatever it needs. |

The split exists because the two artifacts answer to different constraints. A
CLI is installed by end users, so install weight is the whole point of the
zero-dependency rule — but a compiler that has to bundle, tree-shake, and emit
a binary has no business rewriting rollup. Keeping them apart lets each be
honest: an app that builds through `@main2/cli` inlines the runtime and ships
no `node_modules` at all, and an app that skips the build still depends on
nothing.

See [`packages/main2/README.md`](packages/main2/README.md) for the API, and
[`packages/main2/docs/parser.md`](packages/main2/docs/parser.md) for the parser
reference.

## Commands

Run from the repository root. `build`, `test`, and `type-check` fan out through
turborepo; `lint` and `fmt` are repo-wide and run in one pass.

```sh
pnpm test          # vitest, every package
pnpm check         # type-check + lint + format check
pnpm build         # tsdown -> packages/*/dist
pnpm fmt           # oxfmt --write
```

To work in one package, run the same scripts from inside it, or use
`pnpm --filter main2 test`.

## Demos

Small runnable examples, one idea each — see [`demos/`](demos). They import
`main2` by name, so they need a build first:

```sh
pnpm build
node demos/parser/01-hello.js
```

## License

MIT
