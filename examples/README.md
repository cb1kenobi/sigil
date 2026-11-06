# Examples

Complete full-screen apps built with sigil: the terminal's counterpart of a
component gallery. `demos/` shows one idea per file; this shows what the ideas
add up to when somebody writes an app.

Each one is a workspace member, so it imports `@ttylabs/sigil` by name exactly
as an app outside this repository would. Build once from the repository root,
then run whichever you like:

```console
$ pnpm build
$ pnpm --filter @ttylabs/example-hello start       # the JSX twin, built
$ pnpm --filter @ttylabs/example-hello start:ui    # the ui-tag twin, unbuilt
```

Or from inside an example's directory, `pnpm start` and `pnpm start:ui`.

Every example quits on `q`, and on Ctrl-C. Without a terminal on both sides,
piped into `cat` for example, an example refuses: it draws nothing, writes one
line to stderr, and exits `1`.

| Example                            | What it shows                                                                                                                                                                                                                                                                                                                                                            |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [hello](./hello)                   | The smallest full-screen app, written twice: in JSX, compiled by `sigil build`, and in the `ui` tag, run by plain `node`. The two draw the same screen, and a test checks that they do.                                                                                                                                                                                  |
| [system-monitor](./system-monitor) | A btop-shaped monitor in the `ui` tag, run by plain `node` (`pnpm start`): per-core sparklines, memory and network charts, and a process table that refreshes every second under a selection that keeps its row, with sort, filter, kill behind a confirm dialog, and theme switching. The panel, chart and table are stand-ins until SIG-277, SIG-284 and SIG-281 land. |

## Two syntaxes, one app

The template frontends are equals, and the examples show both:

- **JSX**, compiled by a build. An editor type-checks every prop, so a
  misspelt one is an error before anything runs. Node strips types but does not
  compile JSX, so a `.tsx` module only ever runs as `sigil build` wrote it.
- **The `ui` tag**, run as it is. Node strips the types, and there is no other
  step. A misspelt prop inside a template is refused at runtime instead.

Both produce the same element tree, because both compile to the same IR.

## Writing one

[Building a full-screen app](../packages/sigil/docs/full-screen-apps.md) walks
through `hello` from an empty directory. The shape every example follows, and
what the smoke test in `packages/cli/test/examples.test.ts` reads, is in
[AGENTS.md](./AGENTS.md).
