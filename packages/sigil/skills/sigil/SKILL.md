---
name: sigil
description: Guidance for writing and changing an app built on @ttylabs/sigil, the zero-dependency framework for Node command-line apps and full-screen terminal apps. It covers commands and file-based routing, options and arguments, errors and exit codes, JSON output, prompts, spinners and progress, full-screen apps with signals and components, styling, config files, translation, update checks and testing, and it lists the places where sigil deliberately behaves differently from Commander, yargs, React, Ink and chalk. Use it before adding or changing a command, an option, a prompt, a full-screen screen, reactive state, config handling or a test in a project that depends on @ttylabs/sigil, and before adding an npm package for something sigil already provides.
---

# sigil

`@ttylabs/sigil` is the runtime of a sigil app: the argument parser, help,
errors, prompts, components, a renderer for full-screen apps, signals, config
and test helpers. It has no dependencies of its own and is ESM only. The
toolchain, `@ttylabs/cli`, provides the `sigil` command (`sigil new`,
`sigil check`, `sigil build`, `sigil package`, `sigil add`) and has its own
skill at `node_modules/@ttylabs/cli/skills/sigil-cli/SKILL.md`. Read that one
before building, packaging or editing `sigil.json`.

This file is about what is easy to get wrong. The details are in the docs that
ship beside it, and every section below links to them:

- [README.md](../../README.md): the API tour, one section per subpath.
- [docs/getting-started.md](../../docs/getting-started.md): a new app, from
  `sigil new` to a build.
- [docs/parser.md](../../docs/parser.md): the full parser reference.
- [docs/full-screen-apps.md](../../docs/full-screen-apps.md): a full-screen app,
  in JSX and in the `ui` tag.
- [docs/testing.md](../../docs/testing.md): the test helpers, with recipes.
- [docs/agents.md](../../docs/agents.md): the short block an app's `AGENTS.md`
  carries. This skill agrees with it and goes further.

Those docs are written for the repository, so their links into `src/`,
`examples/`, `demos/` and the other packages lead nowhere inside
`node_modules`. Read the exported types in `dist/` instead of `src/`, and the
examples on GitHub (`cb1kenobi/sigil`).

## Task map

| To do this                       | Import from                                           | Read                                                                                                                      |
| -------------------------------- | ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Add a command                    | `@ttylabs/sigil` (`command()`)                        | [Add a command](../../docs/getting-started.md#add-a-command), [Commands and routing](#commands-and-routing)               |
| Add subcommands                  | a directory under `src/commands/`                     | [Add subcommands](../../docs/getting-started.md#add-subcommands), [Routes](../../docs/parser.md#routes)                   |
| Add an option or an argument     | `@ttylabs/sigil`                                      | [Options and arguments](#options-and-arguments), [Declaring options](../../README.md#declaring-options)                   |
| Share options between commands   | `@ttylabs/sigil` (`options()`)                        | [Sharing options](../../docs/parser.md#sharing-options-between-commands)                                                  |
| Fail with a message and a code   | nothing: throw an `Error`                             | [Errors and exit codes](#errors-and-exit-codes), [Errors](../../docs/parser.md#errors)                                    |
| Print JSON for scripts           | nothing: `format: true` and return data               | [Output for people and for scripts](#output-for-people-and-for-scripts), [Output formats](../../README.md#output-formats) |
| Color and text layout            | `@ttylabs/sigil/ansi`, `/wrap`, `/width`              | [`sigil/ansi`](../../README.md#sigilansi), [`sigil/wrap`](../../README.md#sigilwrap)                                      |
| Ask a question                   | `@ttylabs/sigil/components/prompt`                    | [Prompts and progress](#prompts-and-progress), [Prompts](../../README.md#prompts)                                         |
| Show a spinner, a bar or a table | `@ttylabs/sigil/components/spinner`, `/progress`, ... | [`sigil/components`](../../README.md#sigilcomponents)                                                                     |
| Build a full-screen app          | `@ttylabs/sigil/app`, `/element`, `/renderer`         | [Full-screen apps](#full-screen-apps), [docs/full-screen-apps.md](../../docs/full-screen-apps.md)                         |
| State and effects                | `@ttylabs/sigil/signals`, `/renderer`                 | [State and effects](#state-and-effects), [`sigil/signals`](../../README.md#sigilsignals)                                  |
| Styling and themes               | a stylesheet string, `@ttylabs/sigil/themes`          | [The stylesheet](../../docs/full-screen-apps.md#the-stylesheet), [`sigil/themes`](../../README.md#sigilthemes)            |
| Read and write config files      | `@ttylabs/sigil/config`, `@ttylabs/sigil/paths`       | [Config files](#config-files), [Config files](../../README.md#config-files)                                               |
| Translate messages               | `@ttylabs/sigil/i18n`                                 | [Translating](../../README.md#translating)                                                                                |
| Tell users about a new version   | `updateCheck` on the schema, `@ttylabs/sigil/updates` | [`sigil/updates`](../../README.md#sigilupdates)                                                                           |
| Test it                          | `@ttylabs/sigil/testing`                              | [Testing](#testing), [docs/testing.md](../../docs/testing.md)                                                             |

## Use sigil instead of adding a package

Every app gets these with nothing installed. Adding the package beside sigil
means two parsers, two color detectors or two prompt engines that disagree.

| Instead of                           | Use                                                                                      |
| ------------------------------------ | ---------------------------------------------------------------------------------------- |
| commander, yargs, minimist, meow     | `main()` and `command()` from `@ttylabs/sigil`                                           |
| chalk, kleur, picocolors, strip-ansi | `ansi` and `strip()` from `@ttylabs/sigil/ansi`                                          |
| string-width, wrap-ansi              | `stringWidth()` from `@ttylabs/sigil/width`, `wrap()` from `@ttylabs/sigil/wrap`         |
| inquirer, prompts, enquirer, @clack  | `@ttylabs/sigil/components/prompt`, and `group()` from `@ttylabs/sigil/components/group` |
| ora, cli-spinners                    | `createSpinner()` from `@ttylabs/sigil/components/spinner`                               |
| cli-progress                         | `createProgress()` from `@ttylabs/sigil/components/progress`                             |
| cli-table3, table                    | `table()` from `@ttylabs/sigil/components/table`                                         |
| ink, react, blessed                  | `runApp()` from `@ttylabs/sigil/app`, with JSX or the `ui` tag                           |
| conf, cosmiconfig, rc                | `createConfig()` from `@ttylabs/sigil/config`                                            |
| env-paths, xdg-basedir               | `configHome()` and `cache()` from `@ttylabs/sigil/paths`                                 |
| update-notifier                      | `updateCheck: true` on the schema                                                        |
| which                                | `which()` from `@ttylabs/sigil/which`                                                    |
| trash                                | `trash()` from `@ttylabs/sigil/trash`, which never deletes                               |
| i18next                              | `__` from `@ttylabs/sigil/i18n`                                                          |

Import a component from its own subpath, such as
`@ttylabs/sigil/components/spinner`, not from the `@ttylabs/sigil/components`
barrel, which loads every component.

`--help`, a `help` command, `completion` and `-q, --quiet` are generated for
every app, and a built app gets `--version`. Do not declare them by hand.

## Commands and routing

- **The schema module exports, and does not run.** `src/index.ts` exports the
  schema (`name`, global `options`, `baseDir: import.meta.dirname` and
  `commands: './commands'`) and a separate runner calls `main()`. `sigil build`
  reads the schema without executing it.
- **A file is a command named after the file.** `src/commands/deploy.ts` is
  `mycli deploy`, and nothing is registered by hand. A subdirectory is a command
  whose subcommands are the files inside it, and its `index` module is the
  directory's own command, never a command called `index`. A directory with no
  `index` lists what is under it.
- **The file name routes, and the module cannot.** A module is imported only
  after argv has matched its file, so a `name`, `alias` or `default: true`
  inside it does nothing for routing. Put descriptions, aliases, `hidden` and
  `default` in a `commands.json` beside the modules, keyed by file name without
  the extension. An alias there is held to the rules of a route's name: one that is
  empty, holds whitespace, a `,` or a `/`, starts with `<`, `[`, `!` or `@`, or
  holds a control or format character, is refused, as is one in a command's own
  `alias` property, and the error says what to write instead. See [A `commands.json`](../../docs/parser.md#a-commandsjson)
  and [A module's own name does not route](../../docs/parser.md#a-modules-own-name-does-not-route).
- **A route's name is taken literally.** A file named `!x.ts`, `@x.ts` or
  `my cmd.ts`, or one holding a control or format character, is refused rather than read as hidden, aliased or two names.
  Files starting with `.` are skipped, a `.d.ts` is never a route, and a
  `deploy.ts` beside a `deploy.js` (or a `config.ts` beside a `config/`) throws.
- **A command module's default export is a plain object**, usually wrapped in
  `command()`. A command declares exactly one of `path`, `load` or `run`; two
  of them throws. See
  [`path`, `load`, and `run` are one choice](../../docs/parser.md#path-load-and-run-are-one-choice).
- **Names in an inline map:** `'build, b'` is `build` aliased `b`, a leading `!`
  hides a command, and the `alias` property adds names that stay out of help --
  plain names, held to the rules of a route's name.
- **A single-command app puts `run` on the schema.** The schema is the root
  command, and its `run` runs when argv names no command, even if `commands`
  is added later. A command marked `default: true` runs when argv names none,
  and reports its missing required arguments rather than stepping aside. See
  [A single-command app](../../README.md#a-single-command-app).
- **Paths are relative to the file that declared them.** A schema written
  inline has no file, so set `baseDir` or pass absolute paths, or they resolve
  from wherever the user ran the CLI.
- **Hooks are one function each, never a list.** To add to a hook that is
  already there, wrap it and call the previous one. A built command is fixed:
  `cmd.args`, `cmd.options` and `cmd.commands` throw when written. A hook
  changes a command through the registries it is handed. See
  [Changing a command from a hook](../../docs/parser.md#changing-a-command-from-a-hook).
- **To run one command from another, call `main()` again** with a list of
  tokens, `schema: state.schema` and `settings: { errorHandler: false }`, and
  catch what it throws. Never call another command's `run()` off the registry:
  it runs over the wrong values, and a lazily loaded one has no `run` yet. See
  [Running one command from another](../../README.md#running-one-command-from-another).
- **Settings go on the schema** (`settings: { ... }`) when the app is built.
  `sigil build` generates its own `main({ schema })` call, so settings passed
  to `main()` in a dev runner are lost in the build.

## Options and arguments

These differ from Commander and yargs on purpose and are covered by tests. Do
not "fix" them. The full list is
[Differences from Commander and yargs](../../docs/parser.md#differences-from-commander-and-yargs).

- **`<value>` makes the option itself required.** `--to <version>` fails with
  `Missing required options: --to` when the option is left out. Use `[value]`
  for an optional option that takes a value.
- **An option that takes a value must be given one.** A bare `--name`, required
  or not, throws `Missing value for option --name`. It does not become `true`
  and does not fall back to `default`. `--name=` is an explicit empty value,
  which a `string` accepts and an `int` rejects.
- **A flag is `false` when absent, never `undefined`**, and `true` when
  negated. `--no-color` writes `false` to `argv.color`, and `--color` with
  `--no-color` is one destination.
- **The default type is `string`.** A value stays a string unless the option
  sets `type`: `'int'`, `'number'`, `'bool'`, `'date'`, `'json'`, `'count'`,
  `'yesno'` or `'auto'`. `auto` is opt-in because it guesses lossily (`007`
  becomes `7`).
- **String defaults and environment values are coerced to the type.**
  `default: 'nope'` on an `int` throws, and a non-string default passes through
  untouched. An empty environment variable counts as unset.
- **`bool` is strict.** `true`, `t`, `yes`, `y`, `on`, `1` and `false`, `f`,
  `no`, `n`, `off`, `0`, the empty string, in any case. Anything else throws.
- **An option takes one value per use.** `multiple: true` collects repeated
  uses (`--tag a --tag b`), and `--tag a b` leaves `b` positional. Only an
  argument is variadic (`<files...>`); a `...` hint on an option is refused,
  and so is `multiple` on a `count`.
- **An option takes the next token unless it is a declared option.**
  `--name --verbose` leaves `--verbose` alone, and `--name -15` takes `-15`.
- **Undeclared options produce values** (`--foo` is `foo: true`, coerced with
  `auto`) instead of erroring. Set `settings: { allowUnknownOptions: false }`
  to refuse them.
- **A bare argument name is optional**, as is `[name]`. Only `<name>` is
  required.
- **Precedence is argv, then `env`, then `default`.** `transform` runs on argv
  values only, before coercion.
- **Dashed names are camel-cased:** `--dry-run` is `argv.dryRun`.
- **Options resolve across the whole command chain**, so a subcommand sees its
  parents' options. Its `command()` types do not, because a command does not
  know where it is mounted: an inherited option is `unknown` in `argv`. Spread
  an `options()` group into the command's own options to type it. See
  [Typed argv](../../README.md#typed-argv).

## Errors and exit codes

- **To fail, throw an `Error`.** `main()` writes `Error: <message>` to stderr
  with no stack, sets the exit code to 1 and resolves rather than rejecting.
  Give the error an integer `exitCode` from 0 to 255 for another code:
  `throw Object.assign(new Error('There is no version 0'), { exitCode: 2 })`.
  What the parser rejects about argv is a `UsageError` (from `@ttylabs/sigil`)
  with a `code` such as `missing-option`, and exits 2; throw one yourself for a
  bad invocation your own code finds. Test for it with `instanceof`, not the
  message.
- **Never call `process.exit()`.** sigil sets `process.exitCode` so buffered
  output still flushes; do the same.
- **Write messages for the person running the CLI.** They are all the user
  sees. `DEBUG=sigil:error` shows the stack when you need it, and `DEBUG=sigil`
  shows each command and how long it took.
- **Quote input you did not write through `escapeControls()`** from
  `@ttylabs/sigil/error-handler`, so a hostile file or branch name cannot put
  an escape sequence on the user's terminal, reverse the line with a bidi
  override, or hide a character that is drawn as nothing or as a blank. The parser does this for its own messages.
- **In a `catch` that shows what went wrong, use `errorMessage()`** from
  `@ttylabs/sigil`. It takes anything that can be thrown and never throws
  itself, where `err.message` or `String(err)` can.
- **A `beforeError` hook may replace the error, never swallow it.** Return a
  new error, or nothing to leave it alone. To handle errors yourself, pass
  `settings: { errorHandler: false }` and catch around `main()`. See
  [The root entry](../../README.md#the-root-entry).

## Output for people and for scripts

- **Return data and set `format: true`; do not add a `--json` option.** The
  command then accepts `--json` and `--format json`, and `main()` serializes
  what `run()` returned to stdout. An error leaves the same way, as
  `{ "error": { "message", "name" } }` on stderr (plus `code` for a usage error), with the exit code unchanged.
- **Without a format, a return value is not printed.** Write the human form
  yourself, and skip it when a format was asked for:

  ```ts
  import { command } from '@ttylabs/sigil';

  export default command({
    desc: 'List services',
    format: true,
    run({ format }) {
      const rows = [{ name: 'api', up: true }];
      if (format === undefined) {
        for (const row of rows) process.stdout.write(`${row.name}\n`);
      }
      return { rows };
    },
  });
  ```

- **A command that declares `format` must return something.** Returning
  `undefined` under `--json` is an error naming the command. The built-in JSON
  writer also refuses values JSON would silently change, such as a `Map`.
- **`--quiet` and `--format` silence progress, not results.** Spinners, bars
  and the typewriter go quiet with nothing wired up; errors, help, a `table()`
  and prompts still appear. See
  [`--quiet`: nothing is drawn at all](../../README.md#--quiet-nothing-is-drawn-at-all).
- **Color comes from `ansi`** in `@ttylabs/sigil/ansi` (`ansi.bold.red('x')`,
  `ansi.hex('#ff8800')`), which detects support from the stream, `TERM`,
  `NO_COLOR`, `FORCE_COLOR` and CI variables, rather than checking `isTTY`
  yourself.
- **Draw names from outside the app through `printable()`** from
  `@ttylabs/sigil/element`, which shows each control character as `�` instead
  of dropping it.

## Prompts and progress

- **A prompt rejects when there is no terminal.** It throws a `PromptError`
  from `@ttylabs/sigil/components/prompt` naming the question, rather than
  hanging in a pipe or CI. `err.aborted` is `true` for Ctrl-C. So accept every
  answer as an argument or an option too, and prompt only for what is missing:

  ```ts
  const name = argv.name ?? (await text({ message: 'Project name' }));
  ```

  `canReadKeys()` from `@ttylabs/sigil/input` answers whether a prompt would
  ask, so work that only a prompt needs can be skipped.

- **Every prompt takes `value`**, an answer to start from, and a `signal` to
  abort it. Aborting rejects with the signal's own `reason`, not a
  `PromptError`, so a default after a delay is `AbortSignal.timeout(10_000)`
  and a `.catch()` that returns the default when `err.name` is
  `'TimeoutError'` and rethrows anything else.
- **Ask several questions with `group()`** from
  `@ttylabs/sigil/components/group`. Escape goes back a step, and `isCancel()`
  tells a cancel from a missing terminal.
- **Accessible mode** (`accessible: true`, or `SIGIL_ACCESSIBLE=1`) asks the
  prompts as plain lines for screen readers. See
  [Accessible mode](../../README.md#accessible-mode-prompts-as-plain-lines).
- **A spinner:** `createSpinner({ text }).start()`, then `spinner.succeed()`,
  `spinner.fail()` or `spinner.stop()`. `spinner.write()` writes a line that
  stays above the spinner. See
  [Spinner](../../README.md#spinner) and [Progress](../../README.md#progress).

## Full-screen apps

Read [docs/full-screen-apps.md](../../docs/full-screen-apps.md) first. The
habits that break here come from React and Ink:

- **A component runs once.** There is no re-render, no virtual DOM and no
  `useState`. State lives in a `State` from `@ttylabs/sigil/signals`, and the
  parts that change are functions the tree calls again:
  `{() => String(count.get())}` updates, `{count.get()}` is read once and never
  moves. See [The root component, in JSX](../../docs/full-screen-apps.md#the-root-component-in-jsx).
- **Conditionals and lists are `Show` and `For`** from
  `@ttylabs/sigil/renderer`, because an `if` or a `.map()` in a body runs once.
  `when` and `each` are functions. `Show` hands its children an accessor, not
  the value, and `For` keys rows by item and hands each an index accessor. Both
  wrap their content in a box, so layout for the rows goes on their `props`.

  ```tsx
  <box class="list">
    <Show when={() => error.get()}>{(err) => <text>{() => String(err())}</text>}</Show>
    <For each={() => names.get()}>{(name: string) => <text>{name}</text>}</For>
  </box>
  ```

  In the `ui` tag a component goes in as `<${For} ...>`, since a tag has no
  scope to look names up in.

- **Inside a component, use `createEffect()` and `onCleanup()`** from
  `@ttylabs/sigil/renderer`, not a bare `effect()`. They belong to the
  component and are disposed with it. `onMount()` runs after the first frame
  that drew the component, which is when its layout exists.
- **Call `useApp()` in the component body** and keep what it returns:
  `app.input` is the key router and `app.exit()` ends the app. A key handler or
  a promise that settles later has no owner of its own; capture `getOwner()` in
  the body and use `runWithOwner()` if it must create effects or read context.
- **`runApp()` resolves an exit code and never sets one.** Open the app from a
  command, set the code and return nothing (a return value would be presented
  as the command's answer under `--json`):

  ```ts
  export default {
    desc: 'Open the dashboard',
    async run(): Promise<void> {
      const { runApp } = await import('@ttylabs/sigil/app');
      const { App, stylesheet } = await import('../ui/app.tsx');

      process.exitCode = await runApp(App, { sheets: [stylesheet] }).exited;
    },
  };
  ```

  Ctrl-C ends the app with 130 and `q` with 0 unless a focused field takes it.
  Without a terminal on both ends `runApp()` writes one line and resolves 1.

- **Keep components out of `src/commands/`.** A `.tsx` is not a route and Node
  cannot import one from source, so load it with a dynamic import inside
  `run`, as above, which also keeps the renderer off every other command's
  path. `sigil new --tui` writes this shape.
- **`console.log()` is captured while the app runs**, into `app.logs`, and
  written out only when the app fails. A bare `process.stdout.write()` is not
  captured and writes straight onto the screen.
- **Styling is CSS over cells.** Lengths are whole cells, `border: round` draws
  a box, `:focus` and `:focus-within` are set by the router, and
  `focusable` puts an element in the Tab ring. Pass a theme from
  `@ttylabs/sigil/themes` as `runApp()`'s `theme`, and swap it with
  `app.setTheme()`.
- **Use the shipped views for data**: `ListView`, `TreeListView`, `DataTable`,
  `DiffView`, `Treemap`, `Panel`, `confirmModal()`, `showToast()`, each from its
  own subpath. The list, tree and table build only the rows in view. See
  [Lists, trees and other views](../../docs/full-screen-apps.md#lists-trees-and-other-views)
  and [Which example to read](../../docs/full-screen-apps.md#which-example-to-read).
- **Cells you paint yourself** go in a `trackedRaw()` from
  `@ttylabs/sigil/renderer`, built inside a component, so it repaints when a
  signal it read changes. A plain `raw` element does not.
  In a template, write `<raw tracked measure={...} paint={...} />`; a `<raw>`
  without `tracked` is a plain one.

## State and effects

`@ttylabs/sigil/signals` follows the TC39 Signals proposal: `State`,
`Computed`, `effect()` and `untrack()`. See
[`sigil/signals`](../../README.md#sigilsignals).

- **The graph is synchronous.** Writes are coalesced and effects run once per
  burst, on a microtask by default or on the renderer's frame in a full-screen
  app. `flush()` runs pending effects now.
- **A `Computed` may not write a signal or read itself**, and either throws. An
  effect may write.
- **An effect may not be `async`.** Returning a promise from an effect body
  throws, because tracking stops at the first `await`.
- **There is no async signal primitive.** Load asynchronously by hand: read the
  signals you depend on before the first `await`, write the result into a
  `State` when it lands, and drop answers that a newer request overtook, with a
  counter:

  ```ts
  const rows = new State<Row[]>([]);
  const problem = new State<unknown>(undefined);
  let latest = 0;

  async function load(query: string): Promise<void> {
    const token = ++latest;
    try {
      const next = await fetchRows(query);
      if (token === latest) rows.set(next);
    } catch (err) {
      if (token === latest) problem.set(err);
    }
  }

  // in a component: the body stays synchronous. It reads query, starts the
  // load and returns nothing
  createEffect(() => {
    void load(query.get());
  });
  ```

  A load that can finish after the component is gone should also check a flag
  that an `onCleanup()` sets. The file manager in the repository's `examples/`
  is a complete app written this way.

## Config files

`createConfig()` from `@ttylabs/sigil/config` is one merged view over a stack
of named layers, bottom first, so later layers win. It is async; use
`createConfigSync()` where an `await` cannot go. Each layer has a `store`:
`json(path)` reads JSON with comments and trailing commas, and `object(value)`
holds values the app already has. See [Config files](../../README.md#config-files).

```ts
import { createConfig, json, object } from '@ttylabs/sigil/config';
import { configHome } from '@ttylabs/sigil/paths';

const config = await createConfig({
  schema: { 'server.port': { type: 'int', default: 8080, env: 'PORT' } },
  layers: [
    { name: 'user', store: json(configHome('myapp', 'config.json')) },
    { name: 'runtime', store: object() },
  ],
});
config.get('server.port');
```

- **Core does not load config.** `main()` never reads a config file and there
  is no automatic `--config` option. Mix the two yourself, as
  `argv.port ?? config.get('server.port')`, or load config first and use it as
  an option's `default`.
- **`config.set()` changes memory and `config.save()` writes.** There is no
  auto-save, so an app that sets and exits without saving loses the write.
- **What `config.get()` returns is frozen.** Take a mutable copy with
  `structuredClone`.
- **There is no `.js` config layer.** Import the module yourself and pass
  `object(mod.default)`.

## Testing

Read [docs/testing.md](../../docs/testing.md). The helpers come from
`@ttylabs/sigil/testing`.

- **`runCommand()` is `main()` with its output read back**: `code`, `out`,
  `err`, `argv`, `error`. Always pass `argv`, or it reads the test runner's
  own arguments. Run one at a time, never in `it.concurrent`, and keep
  `disableConsoleIntercept` in the vitest config `sigil new` wrote, or output
  written with `console.log()` is lost.
- **Under vitest, pass `importModule: (url) => import(url)`** when a command
  imports a `.tsx` component, so vite compiles it. See
  [A full-screen app](../../docs/testing.md#a-full-screen-app).
- **Test streams are pipes**, so color and terminal width are never seen.
  `runOnTerminal()` runs a program in a child process that has a terminal.
- **A full-screen app** runs on a fake terminal:
  `const term = createTestTerminal({ columns: 60, rows: 16 })`, then
  `runApp(App, { detect: false, sheets: [stylesheet], terminal: term.terminal })`.
  Drive it with `term.press()` and `KEYS`, and read `term.viewport` after
  `await frame(app)`, because frames are drawn on a clock and not once per key.
  See [Testing it](../../docs/full-screen-apps.md#testing-it).
