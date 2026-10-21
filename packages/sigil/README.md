# sigil

A framework for building CLI apps in Node.js.

At its heart is a multi-pass hierarchical argument parser built for CLIs that
lean heavily on subcommands, with **zero production dependencies**. ANSI
handling, text wrapping, display width, and XDG paths.

```js
import { main } from '@ttylabs/sigil';

await main({
  schema: {
    name: 'mycli',
    desc: 'A demo CLI',
    options: { '-v, --verbose': 'Print more output' },
    commands: {
      build: {
        desc: 'Build the project',
        options: { '--target [name]': { choices: ['esm', 'cjs'], default: 'esm' } },
        args: ['<entry>', '[rest...]'],
        run({ argv }) {
          console.log(argv.target, argv.entry, argv.rest, argv.verbose);
        },
      },
    },
  },
});
```

```
$ mycli build src/index.ts a b --target cjs -v
cjs src/index.ts [ 'a', 'b' ] true
```

`main()` reads `process.argv`, matches a command, validates, and runs it. An
error becomes a message on stderr and a non-zero exit code — never a stack
trace, because the caller is a bin script.

**[docs/parser.md](docs/parser.md)** is the full parser reference: syntax,
semantics, precedence, and every place this parser deliberately differs from
Commander and yargs. This README is the API tour.

**[demos/](../../demos/)** is the same material as runnable files — one idea each,
plain JavaScript, with the commands worth trying at the top of every one.

---

## Contents

- [The root entry](#the-root-entry) — `main()`, `command()`, `options()`, errors
- [Declaring options](#declaring-options)
- [Declaring arguments](#declaring-arguments)
- [Declaring commands](#declaring-commands) — nesting, lazy loading, running one from another
- [Settings](#settings)
- [Hooks](#hooks) — `afterRun`, `beforeError`, and what a hook may not do
- [Help](#help)
- [Shell completion](#shell-completion) — `completion bash`, `completion zsh`
- [Translating](#translating) — `__`, `__n`, catalogs, `SIGIL_LOCALE`
- [Typed argv](#typed-argv)
- [Testing](#testing) — `runCommand()`, `runOnTerminal()`, `createTestTerminal()`, `KEYS`
- [Config files](#config-files) — `createConfig()`, layers, a schema, dotted paths, `save()`
- [Subpath modules](#subpath-modules) — `ansi`, `wrap`, `width`, `help`, `i18n`, `terminal`, `components`, `canvas`, `input`, `style`, `signals`, `paths`, `config`, `which`, `updates`, `testing`

---

## The root entry

```js
import {
  sigil, // parse argv and run the matched command
  command, // identity function that types one command's argv
  options, // identity function that keeps an option group's types
  errorHandler, // the built-in error renderer + exit code
  renderError, // an error as the string that would be printed
  errorExitCode, // the exit code an error implies
} from '@ttylabs/sigil';
```

Every type is exported from the same place — `Schema`, `Command`, `Option`,
`Argument`, `Settings`, `ParseState`, `DataType`, the hook types, and so on.

### `main(opts)`

```ts
await main({
  argv?: string[],      // defaults to process.argv.slice(2)
  schema?: Schema,
  settings?: Settings,
});
```

Resolves with the command's return value; with the `ParseState` when no command
ran or the command returned nothing; with `undefined` when an error was handled.

### `errorHandler`, `renderError`, `errorExitCode`

The built-in handler is what `main()` uses unless you replace it. The pieces
are exported so you can use them from a `settings.errorHandler` of your own:

```js
import { renderError, errorExitCode } from '@ttylabs/sigil';

await main({
  schema,
  settings: {
    errorHandler(err) {
      console.error(`✖ ${renderError(err)}`);
      process.exitCode = errorExitCode(err);
    },
  },
});
```

`settings.errorHandler: false` rethrows instead, so you can `try`/`catch`
around `main()`.

```js
try {
  await main({
    argv: ['--nope'],
    schema,
    settings: { allowUnknownOptions: false, errorHandler: false },
  });
} catch (err) {
  renderError(err); // 'Error: Unknown option "--nope"'
  errorExitCode(err); // 1
}
```

> [!NOTE]
> `parse()` is internal — `main()` is the entry point. The parse state is
> reachable from `main()`'s return value and from every hook.

---

## Declaring options

Options are an object keyed by **format string**. The value is a description
string, or an object, or `null` for neither.

```js
options: {
  '-v, --verbose': 'Print more output',
  '--target [name]': { choices: ['esm', 'cjs'], default: 'esm', desc: 'Output format' },
  '-o, --out-dir [dir]': { default: 'dist', desc: 'Where to write' },
  '--define [pair]': { desc: 'Define a global', multiple: true },
  '--port [n]': { env: 'PORT', type: 'int' },
  '--no-color': 'Disable color',
}
```

```
$ mycli build x.ts --target cjs --define A=1 --define B=2 --no-color
{ entry: 'x.ts', target: 'cjs', define: [ 'A=1', 'B=2' ], color: false, outDir: 'dist' }
```

The format string carries the name, the aliases, and whether a value is taken:

| Format                   | Means                                                       |
| ------------------------ | ----------------------------------------------------------- |
| `--verbose`              | a flag; `argv.verbose` is `true`/`false`, never `undefined` |
| `-v, --verbose`          | the same flag, with a short alias                           |
| `--target [name]`        | takes an **optional** value                                 |
| `--target <name>`        | takes a value **and the option itself is required**         |
| `--no-color`             | a negated flag; writes `false` to `color`                   |
| `--color` + `--no-color` | one destination, two options                                |

> [!IMPORTANT]
> `<value>` makes the **option** required, not just its value — this diverges
> from Commander and yargs. Use `[value]` for an optional option that takes a
> value.

### Option properties

| Property                          | Purpose                                                                                                 |
| --------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `type`                            | `'string'` (default), `'bool'`, `'int'`, `'number'`, `'date'`, `'json'`, `'count'`, `'yesno'`, `'auto'` |
| `default`                         | fills the destination when argv and `env` did not; strings are coerced to `type`                        |
| `env`                             | environment variable(s) to fall back to, before `default`                                               |
| `choices`                         | allowed values; also gives a flag an implied hint, making it valued                                     |
| `multiple`                        | repeated uses collect into an array                                                                     |
| `required`                        | written out, wins over what `<>`/`[]` implied                                                           |
| `transform`                       | `(value, state) => newValue`, run before type coercion, argv values only                                |
| `desc`                            | what help prints; a function for a translated one, see [Translating](#translating)                      |
| `group`                           | puts the option under its own `<group> options:` heading in help                                        |
| `hidden`                          | keep it out of help; it still parses                                                                    |
| `negate`                          | `false` opts a `no-`-named option out of being read as negation                                         |
| `alias`, `format`, `name`, `hint` | override what the format string implied                                                                 |

Precedence for every option and argument is **argv → `env` → `default`**.

Data types, coercion rules, negation, short groups (`-abc`, `-n5`), undeclared
options, and the terminator are all covered in
[docs/parser.md](docs/parser.md#data-types).

---

## Declaring arguments

Positionals are a list of format strings or objects.

```js
args: ['<entry>', '[rest...]'];
```

| Format                    | Means                                          |
| ------------------------- | ---------------------------------------------- |
| `name`                    | optional                                       |
| `<name>`                  | **required**                                   |
| `[name]`                  | optional, explicitly                           |
| `<name...>` / `[name...]` | variadic — collects every remaining positional |

> [!NOTE]
> A bare name is **optional** here; Commander treats it as required. Brackets
> are the only thing that decides it.

The object form takes `choices`, `default`, `desc`, `env`, `multiple`, `name`,
`required`, `transform`, and `type` — the same as an option.

```js
args: [{ name: 'env', choices: ['dev', 'prod'], default: 'dev' }, '[files...]'];
```

Unmatched positionals throw unless `settings.allowUnexpectedArguments` is set.
Matched or not, every positional is also pushed onto `state._`.

---

## Declaring commands

```js
commands: {
  build: {
    desc: 'Build the project',
    options: { '--minify': 'Minify the output' },
    args: ['<entry>'],
    commands: { clean: { run() {} } },   // nested, to any depth
    run({ argv, _, cmd, contexts }) {},
  },
}
```

A command's key is its name. The first bare label is the name and the rest are
aliases, a `!` prefix hides it:

```js
commands: {
  'build, b': { run() {} },   // `build`, aliased `b`
  '!secret': { run() {} },    // works, stays out of help
}
```

### Options resolve across the whole chain

Nothing declares what a command inherits, because nothing has to. A child sees
every option its parents declared — `mycli -v build` and `mycli build -v` both
set `verbose`. Help reads the same chain and lists what is left under
`Global options`.

### The default command

Marked `default`, a command runs when argv named none — which is how a
single-command CLI is written:

```js
await main({
  schema: {
    name: 'bundle',
    commands: {
      build: {
        default: true,
        args: ['<entry>'],
        options: { '--minify': 'Minify' },
        run: ({ argv }) => console.log(argv.entry, argv.minify),
      },
    },
  },
});
```

```
$ bundle src/index.ts --minify
src/index.ts true
```

### Lazy loading

A command can be a path to a module, a directory tree of them, or a package
directory. Nothing is read until the command is matched.

```js
commands: {
  deploy: './commands/deploy.js',   // one module
  db: './commands/db',              // one command, subcommands inside it
}

commands: './commands'              // a directory *of* commands
```

A directory is a tree: a file is a command named after the file, a subdirectory
is a command named after the directory with the routes inside it as its
subcommands, and an `index` module is the directory's own command rather than
one called `index`.

```
commands/
  build.js            →  mycli build
  config/
    index.js          →  mycli config
    set.js            →  mycli config set
  db/
    migrate/
      up.js           →  mycli db migrate up
```

Each level is read when something asks for it, so `mycli db migrate up` reads
three directories and imports one module however large the tree is.

```js
// commands/deploy.js
export default {
  desc: 'Deploy the app',
  options: { '--dry-run': 'Do not actually deploy' },
  run({ argv }) {
    console.log('dryRun =', argv.dryRun);
  },
};
```

A lazily loaded command appears in help by name alone until its module is read,
because its description lives in that module. `help <command>` does load it.

`routeInfo` is how a build that keeps the walk gets those descriptions onto the
help screen without importing anything: it maps route names onto what was lifted
out of them. `sigil build` does not write one — it bakes the whole tree into the
executable it generates, as a `commands` literal with a `desc` and a `load` per
command, which is the `load` shape further down.

```js
commands: './commands',
routeInfo: {
  build: { desc: 'Build the app' },
  db: { desc: 'Database tasks', commands: { migrate: { desc: 'Run migrations' } } },
},
```

It is a **cache over the walk, not a list of what exists**. The directory is
still read, so a command with no entry still works and simply lists without a
description — which is what keeps a command dropped into an installed app from
becoming invisible. Once a module is loaded, its own `desc` is what stands.

`load` is `path` said as a function, for an app that has been bundled:

```js
commands: {
  build: { desc: 'Build the app', load: () => import('./commands/build.js') },
}
```

A bundled app has no file to `stat`, since its command modules are chunks the
bundler named — so `sigil build` emits `load` where the source tree had a
directory to walk, and the deferral survives bundling. Declare `path`, `load`
or `run`, never two of them: they are three answers to "what is this command"
and there is no right one to pick between.

A lazily declared command is a placeholder until it is matched, so nothing above
it knows what it really is until the module arrives. `subcommandLoaded` is where
it becomes knowable — it fires on whatever **declared** the subcommand, once that
subcommand has loaded:

```js
{
  hooks: {
    async subcommandLoaded({ cmd, parent }) {
      await cmd[Internal].options.add({ format: '--dry-run' });
    },
  },
  commands: { migrate: { load: () => import('./migrate.js') } },
}
```

The option is matchable on that same parse, so this is how a parent gives its
subcommands a flag it could not have declared for them in advance. Return a
command instead and it replaces the one that loaded. The schema is the root
command, so declaring the hook there covers every top-level command.

There is deliberately no hook around a command's _own_ load: a command has to be
loaded before anything of its own can fire, so its module body and its `init`
hook already are that moment.

### Command properties

| Property                      | Purpose                                                                          |
| ----------------------------- | -------------------------------------------------------------------------------- |
| `run`                         | `(state) => any`; the handler                                                    |
| `desc`                        | what help prints; a function for a translated one                                |
| `args`, `options`, `commands` | as above                                                                         |
| `default`                     | dispatch when argv named no command                                              |
| `alias`                       | extra names that stay out of the help label                                      |
| `hidden`                      | keep it out of help                                                              |
| `help`                        | a string that replaces the screen, or a renderer that receives the generated one |
| `hooks`                       | `init`, `parse`, `help`, `afterRun`, `beforeError`, `subcommandLoaded`           |
| `path`                        | a module to load the command from, resolved from the file that declared it       |
| `load`                        | that module as a function -- `() => import('./build.js')` -- for a bundled app   |
| `routeInfo`                   | descriptions a build lifted out of the modules a `commands` path points at       |
| `examples`                    | `{ label, text }` pairs for help                                                 |

### Running one command from another

Two things an app wants from its own command tree, and both are one `main()`
call with a list of tokens:

|                |                                                        |
| -------------- | ------------------------------------------------------ |
| **re-routing** | this command decides another should handle the request |
| **executing**  | this command runs another as one step of its own work  |

```js
async run(state) {
  // executing: three commands as three steps of one piece of work
  for (const step of [['clean', '--force'], ['build', 'dist'], ['deploy', 'prod']]) {
    try {
      await main({ argv: step, schema: state.schema, settings: { errorHandler: false } });
    } catch (err) {
      throw new Error(`step \`${step.join(' ')}\` failed: ${err.message}`);
    }
  }
}
```

`state.schema` is the schema the parse used, so a command re-enters the parser
without closing over anything.

**The argv list is the interface, and that is deliberate.** It is the one path
that applies coercion, defaults, `env` fallback, `choices`, `transform`, the
hooks _and_ a lazy load — so what gets dispatched is what you would have typed,
and a value the schema refuses is refused here exactly as it would be from a
shell. You never touch `process.argv` and you never build a _string_; you build
a list of tokens and the parser does the rest.

Two things to know before composing them:

**`errorHandler: false` is what makes a nested call composable.** Left at the
default, a nested `main()` _renders_ the error, sets `process.exitCode` and
resolves `undefined` — so a failed step looks like it succeeded, the caller
carries on, and the message is printed by the inner call rather than by whoever
knows what the step was for.

**And `catch` it**, which is what `errorHandler: false` is asking you to do: the
caller knows what the step was for and the outer handler does not. There is a
reason past tidiness — an error that escapes a nested `main()` reaches the outer
one with nothing on it to say the hooks already ran, so a schema `beforeError`
hook sees **the same error twice**. Catching and re-throwing your own, as above,
still fires twice, but for two _different_ errors, which is one per error and is
the rule rather than the bug; catching and handling fires once. See "Known bugs"
in `AGENTS.md`.

**A nested dispatch does not inherit the outer invocation's root options.** They
are re-read from the argv you pass, so an outer `--verbose` is `false` inside
unless you forward it:

```js
const argv = state.argv.verbose === true ? ['--verbose', ...step] : step;
```

There is **no recursion guard**: two commands that re-route to each other are an
infinite loop, and nothing reports it. **A condition does not make a route
finite** — two commands that each route to the other on a condition that stays
true recurse exactly as an unconditional pair does. What makes a route finite is
that whatever it routes _to_ does no routing of its own; a tree where two of them
might route to each other needs a depth or a visited set, and that is the app's
to carry.

### Reading the command registry

A `run()` is handed `state.contexts` — the chain, innermost first, ending at the
root — and each command carries its registry under the exported `Internal`
symbol. That is what help reads, and what a command palette or a `did you mean`
would read:

```js
import { Internal } from '@ttylabs/sigil';

const root = state.contexts[state.contexts.length - 1];
const registry = root[Internal].commands;

[...registry.values()]; // every sibling
registry.find('b'); // → the `build` command; resolves aliases
registry.get('b'); // → undefined; the raw `Map.get`
registry.default; // the `default` command, if one is declared
```

`values()` yields the commands themselves and `keys()` their canonical names, so
iterating needs no lookup at all. For a lookup, use **`find()`** for a name
anybody typed or wrote, and `get()` only for one already known to be canonical —
it is `Map.get`, so it misses an alias, and passing it a command rather than a
name misses too.

**Calling a command's `run()` off the registry is a trap**, and a quiet one: it
runs, it simply runs over the wrong values.

```js
const clean = registry.find('clean');

await clean.run(state); // (a)
await clean.run({ ...state, cmd: clean, argv: { force: true } }); // (b)
```

In **(a)** the sibling is handed _your_ values, so none of its own options exist
and it does not know which command it is. In **(b)** the value you asked for
arrives, the declared `default` never does, inherited options are gone, and
`choices` is never consulted. And for a **lazily loaded** command it is not
merely wrong but impossible — the registry holds a placeholder with **no `run`**
until a parse loads it, which filesystem routing makes the common case. What the
declaration itself gave is there, so a `{ path, desc }` has its `desc` on the
placeholder and that is what help shows before the module is read; it is `run`
that nothing but a load can supply.

`demos/parser/11-dispatch.js` prints all of it side by side.

---

## Settings

```js
await main({ schema, settings: { allowExtraArguments: true } });
```

| Setting                    | Default  | Effect                                                |
| -------------------------- | -------- | ----------------------------------------------------- |
| `allowExtraArguments`      | `false`  | permit arguments after `--`                           |
| `allowUnexpectedArguments` | `false`  | permit positionals no argument declared               |
| `allowUnknownOptions`      | `true`   | undeclared options produce values instead of erroring |
| `assertCwd`                | `true`   | fail early if the working directory is gone           |
| `errorHandler`             | built-in | `false` rethrows; a function replaces it              |
| `helpExitCode`             | `0`      | the exit code after printing help                     |
| `suggestions`              | `true`   | offer the nearest command or option a typo missed     |

### "Did you mean"

An error about something that did not resolve offers the nearest thing that
would have, read off the registries the parse has already built:

```
$ mycli buidl
Error: Unexpected argument "buidl". Did you mean "build"?

$ mycli help buidl
Error: Unknown command "buidl". Did you mean "build"?
```

A mistyped command reaches `Unexpected argument` rather than `Unknown command`,
because commands resolve against the innermost context and an unmatched token
falls through to the positional arguments. `Unknown option` is offered too, where
`allowUnknownOptions: false` makes one an error at all.

It costs nothing until something is about to throw, and reads no files to do it.
Set `suggestions: false` where something other than a person parses the output.

---

## Hooks

```js
await main({
  schema: {
    hooks: {
      beforeParse: (state) => {}, // before argv is walked
      afterParse: (state) => {}, // `state.argv` is written, nothing is validated yet
      afterRun: ({ cmd, result, ms }) => {}, // run() returned or threw
      beforeError: (err, ctx) => {},
    },
    commands: {
      build: {
        hooks: {
          init: ({ options, args, commands }) => {}, // when the command is built
          parse: ({ cmd, options }) => {}, // when argv matches it
          help: ({ sections, state }) => {}, // when its help is rendered
          afterRun: ({ cmd, result, ms }) => {},
          beforeError: (err, ctx) => {},
        },
        run() {},
      },
    },
  },
});
```

They fire in this order, for one `main()` call:

```
init (at build time) → beforeParse → parse (as each command matches) → afterParse
  → run → afterRun → beforeError
```

The two ends of that are conditional rather than part of every run.
`beforeError` fires only for a run that failed, so a successful one ends at
`afterRun`; and `afterRun` fires only for a command that **ran**, so a parse
that failed goes straight to `beforeError` with nothing before it.

A hook changes a command through the registries it is handed —
`options.add(...)`, `args.push(initArg(...))`,
`commands.add(await initCommand(...))` — which take effect immediately.

### `afterRun`

Fires once the matched command's `run()` has returned **or thrown**, innermost
command first and the schema last, before anything on the error path has
rendered. It is `finally` and `postrun` in one hook, because they are one
moment: a handle to close, a lock to release, a duration to report.

```js
hooks: {
  afterRun({ cmd, result, ms, state }) {
    if (!result.ok) {
      return report.failure(cmd.name, result.error, ms);
    }
    report.success(cmd.name, result.value, ms);
  },
}
```

`result` is a tagged union, so `ok` is what narrows it:

| field          | meaning                                                   |
| -------------- | --------------------------------------------------------- |
| `result.ok`    | `true` where `run()` returned, `false` where it threw     |
| `result.value` | what it returned, on `ok` -- `undefined` is a real answer |
| `result.error` | what it threw, on `!ok` -- anything at all can be thrown  |
| `ms`           | how long `run()` took, off `performance.now()`            |
| `cmd`          | the command that ran                                      |
| `state`        | the parse state it was handed                             |

**`result.value` is what `run()` returned**, not what `main()` answers with:
`main()` substitutes the parse state for a command that returned nothing, and
reporting that as the command's value would be a lie about what the command did.

**It fires for a command that ran**, which is all it claims. A run answered by
`--help` or `--version`, one whose command has no `run`, and one whose parse
failed all have no result to hand over and fire nothing -- `beforeError` is the
hook for that last one.

**"Before `beforeError`" is about this `main()` call.** A command that runs
another with a nested `main()` has already let that call render its own error by
the time it returns, so the sequence a composition sees is the inner call's
`afterRun` and `beforeError`, then the outer call's. Which is each call's own
error path rather than something this ordering could reach.

**It cannot recover.** Whatever it returns is ignored and the `result` it is
handed is frozen, so a failed run stays failed and the error still reports.
`oclif`'s `catch` is a recovery hook; this is a reporting one. A hook that could
turn a failure into a success would have to answer what `main()` returns, what
the exit code is, and whether the error was ever an error -- which is
`beforeError`'s own refusal to allow suppression, one step along.

What the freeze refuses is what the framework is the author of: which case the
result is in, which value or error it holds, and the duration. It does **not**
seal the insides of your own objects -- `result.value` is the object your
command returned and `result.error` is an error a `beforeError` hook may
already mutate -- so a hook that wants to annotate either still can, and a hook
that installs a `beforeError` reaches what is rendered exactly as declaring one
would. Nothing there is a way round the refusal; it is the app's own channels,
reachable from one hook more.

**A hook that throws is reported and skipped.** The next hook still runs, the
result is unchanged, and what it threw goes to `DEBUG=sigil:run`: a failed
cleanup must not cost the user the error they actually needed.

`DEBUG=sigil` prints the pair, which is the timing a command's own body never
had:

```
[2026-01-01T00:00:00.000Z] sigil Executing command "build"
[2026-01-01T00:00:00.000Z] sigil Command "build" returned after 41.028ms
```

There is no `catch`-as-recovery hook, and that is a decision rather than a gap.
See `AGENTS.md`.

### `beforeError`

Fires for every throw site, innermost command first and the schema last, before
the error is rendered -- and after `afterRun` where a command ran, which is not
every throw site: a parse that failed reaches this hook and no `afterRun`. A
hook may **replace** the error but never suppress it: return nothing to leave it alone, return a value to make that
value the error.

```js
hooks: {
  beforeError: (err) =>
    err.code === 'ENOENT' ? new Error('Run `mycli init` first') : undefined,
}
```

Each hook is **one function**, not a list. Two things that both want to happen
go in one hook, or wrap the one that is there:

```js
const previous = cmd.hooks.parse;
cmd.hooks.parse = async (data) => {
  await previous?.(data);
  // ...and yours
};
```

---

## Help

`--help` and a `help` command are added to the root automatically, and only
where your app left room: declare `-h` as `--host` and you keep it, declare
`--help` yourself and you own it entirely. `schema.help: false` adds nothing.

A run that names no command gets the same screen, because a CLI that is all
subcommands has nothing to do without one. An app with a root `run` or a
`default` command has something to do and never sees it.

`schema.version` does the same for `-v, --version`:

```js
await main({
  schema: {
    name: 'mycli',
    version: () => JSON.parse(readFileSync(manifest, 'utf-8')).version,
    commands: './commands',
  },
});
```

A **function** is called only if `--version` is used, which is what an app
reading its own `package.json` wants — doing it eagerly is a file read on every
run, and in a bundle it is one that throws, since `../package.json` off
`import.meta.url` points wherever the bundle was written. `sigil build`
replaces it with the literal it read at build time. A plain string works too.

Leave `version` out and no flag is added. `--help` outranks it: being asked
what a program does and answering with a version string is not an answer.

Help is context-sensitive — it describes the command argv actually reached:

```
$ mycli build --help
Usage: mycli build [options]

Build the project

Options:
  --target [name]  Output format (choices: esm, cjs)

Advanced options:
  --sourcemap        Emit source maps
  --tsconfig [path]  Config file

iOS options:
  --sdk [ver]         iOS SDK version
  --simulator [udid]  Simulator to run on

Global options:
  -v, --verbose  Print more output
  -h, --help     Show help for a command
```

`Advanced options` came from `group: 'Advanced'` on those two options.
`iOS options` came from a `help` hook, which is for options a command must
_describe_ without _parsing_:

```js
hooks: {
  help: [
    ({ sections }) =>
      sections.add({
        title: 'iOS',
        options: { '--sdk [ver]': 'iOS SDK version', '--simulator [udid]': 'Simulator to run on' },
      }),
  ],
}
```

> [!IMPORTANT]
> Help wins over a **missing** required option or argument — `mycli build --help`
> answers what `build` needs instead of complaining it was not given. An
> **invalid** value still throws.

Writing your own screen for one command:

```js
{
  // a string replaces the screen outright
  help: 'Usage: mycli build <entry>\n\nSee https://example.com/docs',
}

{
  // a function receives the generated screen and adds to it
  help: ({ generated }) => `${generated}\n\nDocs: https://example.com/docs`,
}
```

---

## Shell completion

A `completion` command is added to the root, the same way `help` is. Run it with
no shell and it works out which one you are in and tells you how to install it:

```
$ mycli completion
Set up completion for mycli, detected zsh:

  as a file on your $fpath, which compinit autoloads
    mycli completion zsh > "${fpath[1]}/_mycli"

  or sourced from .zshrc, after compinit
    echo 'source <(mycli completion zsh)' >> ~/.zshrc

Then restart your shell.
```

Name the shell and it prints the script instead, which is the form to redirect:

```
$ mycli completion bash > ~/.mycli-completion.bash
$ echo 'source ~/.mycli-completion.bash' >> ~/.bashrc
```

```
# from zsh, where `fpath` is a real array -- in any other shell it is empty and
# the redirect lands on /_mycli
% mycli completion zsh > "${fpath[1]}/_mycli"
# or, from .zshrc after compinit, which needs no file at all:
% source <(mycli completion zsh)
```

The script's own header repeats those recipes, so the file tells you what to do
with it. `schema.completion: false` adds nothing, and an app that declares its
own `completion` keeps it.

Nothing is installed for you yet and nothing is written to your dotfiles. Those
are two separate promises: where a completion script lives is a decision about
your machine, which is the same answer `gh`, `kubectl`, `rustup` and `deno` all
give — and the recipes above go to stderr with a non-zero exit, so
`mycli completion > file` cannot fill the file you wanted a script in.

### What it completes

Everything the schema already said, at every level of the tree:

| At                         | You get                                               |
| -------------------------- | ----------------------------------------------------- |
| `mycli <TAB>`              | the commands and every alias                          |
| `mycli db <TAB>`           | `db`'s subcommands                                    |
| `mycli build --<TAB>`      | `build`'s options **and** everything above it         |
| `mycli build --mode <TAB>` | that option's `choices`                               |
| `mycli --yes <TAB>`        | `true`/`false` for a `bool`, `yes`/`no` for a `yesno` |
| `mycli completion <TAB>`   | the shells, because they are the argument's `choices` |

**Descriptions** come with them in zsh, which has a menu to put them in. bash's
`COMPREPLY` is a list of words and nothing else, so a description reaches the
screen in one of the two shells and is read off the same schema either way.

That `--yes` row is a `bool` that **takes a value** -- `'--yes [v]'` or a
`choices` list, which implies one. A bare flag takes nothing, so there is no
value after it to complete and the next tab offers the next thing on the line.

An **alias** is offered beside the name it belongs to, and typing one still
completes the right subtree: `remove, rm` means `mycli rm --<TAB>` lists
`remove`'s options. That is the one place this differs from what a palette
lists -- a palette shows one row per command, and a completion menu is a list of
tokens, so every token the parser takes is in it.

A `hidden` command is not offered, and neither is anything under it; nor is a
`hidden` option. `--help` and `--version` are, because they are things a user
types.

Anything with no declared values falls back to your shell's own file
completion, which is what `--out <dir>` wants.

### The script is static, and what that costs

Every candidate is baked into the file, so a tab costs no process at all — the
alternative is a script that runs your app on every keypress, which measured at
33–38 ms for a small app and grows with the tree rather than with what is being
completed. What it cannot do is complete a value your
app would have to **compute**: a git branch, a running container, a row in a
database. Nothing in a schema declares one of those today, so nothing is
pretending to.

Regenerate it when the commands, options or `choices` change. The command
imports every command module to read them, so generating a script runs whatever
your modules do at import time — once, when you install completion, rather than
on every tab.

### Which shells

`bash` and `zsh`. bash is written for 3.2, which is what macOS ships, and needs
no `bash-completion` package. fish and PowerShell are not generated: a
completion script is quoted correctly or it is a shell injection, and neither
shell is installed where this was written, so either one would ship as a program
its author had never run.

### A default command

A `default` command is dispatched when argv names no command, so its own
arguments and options are typable at the level above it -- and they are offered
there. `mycli <TAB>` on a default `serve [dir]` offers `dir`'s choices beside the
commands, and `mycli --<TAB>` offers `serve`'s options beside the root's.

Where both declare one spelling, the **parent's** declaration is the one offered,
because that is the one that resolves: `mycli --mode <TAB>` takes the root's
choices and `mycli serve --mode <TAB>` takes `serve`'s. A `hidden` default
contributes nothing, which is `hidden` taken at its word.

### It is an ordinary command, so a required option is required

`completion` is dispatched like any other command, which means an app with a
**required** option still wants one:

```
$ rq completion bash
Error: Missing required options: --token
$ rq --token x completion bash          # fine
```

`--help` and `help` win over a missing required option and this does not. That
is a decision rather than an oversight: making it win means a field on the parse
state and a change to what `parse()` validates for every app, which is not a
thing to add for one command. The failure says exactly what to pass, and
passing it works.

### What it does not offer

A value your app would have to compute, which is the static script's own trade
above.

---

## Translating

The English sentence is the key. There is nothing to invent and nothing to look
up:

```js
import { __, __n } from '@ttylabs/sigil/i18n';

throw new Error(__`Unknown option "${name}"`); // key: Unknown option "{0}"
__n(files.length, '{0} file changed', '{0} files changed'); // key: {0} file changed
```

A catalog is a flat JSON object keyed by those sentences, with `{0}`, `{1}` where
the values go. The slots are numbered rather than named because `${v}` hands the
tag the value and not the name — and numbered slots still **reorder**, which is
the whole reason interpolation beats concatenation:

```json
{
  "Unknown option \"{0}\"": "Unbekannte Option \"{0}\"",
  "Invalid value \"{0}\" for {1}": "Für {1} ist \"{0}\" ungültig",
  "{0} file changed": { "one": "{0} Datei geändert", "other": "{0} Dateien geändert" }
}
```

A plural entry is an object of CLDR categories, selected with
`Intl.PluralRules` — so Polish's four and Arabic's six work without a grammar
written for them. A plain string is taken too, for a language with one form for
every count.

A literal `{0}` in a string with values beside it is escaped `{{0}}`. With no
values it needs no escape.

### Declaring a locale

A locale is a loader on the schema, the shape `Command.load` already is:

```js
export default {
  name: 'mycli',
  locales: {
    de: () => import('./locales/de.json', { with: { type: 'json' } }),
    ja: () => import('./locales/ja.json', { with: { type: 'json' } }),
  },
};
```

A literal specifier inside a dynamic import is the one shape a bundler can see,
follow and split on, so `sigil build` gives each locale a chunk of its own: an
app shipping twelve ships twelve and loads one. A loader is a function and may
do anything, but this is the body to write — it costs about 0.1 ms, where
`node:fs` plus a read and a parse costs about 1.25 ms.

Leave `locales` out and nothing is loaded and no locale is resolved. **English
is not a catalog**: it is the literal already at the call site, so an app with no
translations reads nothing, calls nothing and constructs no `Intl`.

### Which locale

`AppOptions.locale`, then `SIGIL_LOCALE`, then `LC_ALL`, then `LC_MESSAGES`,
then `LANG`, then `Schema.defaultLocale`, then English. `C`, `POSIX` and absent
all mean English and read no catalog.

`defaultLocale` is the **bottom** of that chain, which is what makes it a
default rather than a second `AppOptions.locale`: it says what the app ships in,
and every environment variable still beats it. `sigil build` writes it from
`"locale"` in `sigil.json`, so an app configures it once:

```json
{ "locale": "de" }
```

The runtime cannot read that file — reading one at startup is what `locales`
being a map rather than a directory convention exists to avoid — so the build is
what carries it across, beside the version and the baked tree. An app that wants
its **unbundled** runs to match writes `defaultLocale` in its schema as well,
which is the same asymmetry `version` already has.

POSIX spellings are taken everywhere a tag is: `de_DE.UTF-8`, `pt_BR` and
`de_DE@euro` all resolve, which `Intl` itself refuses for all three. The
fallback chain truncates at `-`, so `de-DE` is served by a `de` catalog and
`zh-Hans-CN` by `zh-Hans` or `zh`.

There is no `--locale` flag, and that is a refusal rather than an omission: a
parse can fail _before_ an option is read, so `mycli --porx --locale=de` throws
about `--porx` while argv is still being walked — and that message is exactly the
one that needed the locale. An app that wants a flag declares it and passes what
it read as `AppOptions.locale`.

### Changing it later

```js
import { setLocale } from '@ttylabs/sigil/i18n';

await setLocale(config.language); // after the app has read its config
```

A string is translated **where it is built**, so a locale set here does not
reach one already rendered. In practice that means a parse error and `--help`
are always in the environment's locale, because both happen before a command
runs — which is the right answer rather than a gap: an app whose parse failed
never got to read its config.

### A description is a thunk

A `__` in the **schema's own object literal** is evaluated when that module is
imported, which is before `main()` is called at all — so a `desc` written as a
value there is always English, however well the app is translated. A `desc` may
be a **function** for exactly this, and it is resolved while the declaration is
initialized, which happens during the parse:

```js
import { __ } from '@ttylabs/sigil/i18n';

export default {
  name: 'mycli',
  desc: () => __`a tool for testing`,
  options: {
    '--where [w]': { desc: () => __`where to put it` },
  },
  args: [{ name: '<entry>', desc: () => __`the entry file` }],
};
```

The same shape `Schema.version` already takes, and for the same reason. It is
resolved **once**, not through a getter, so one declaration has one description
however many times help asks — a lazy one would answer differently after a
`setLocale()`.

An option's shorthand takes one too, since a string there _is_ a `desc`:

```js
options: { '--where [w]': () => __`where to put it` },
```

A **command module** may write either form: its own module is imported during
the parse, so a value there is translated too. The thunk is what lets `sigil
build` do both at once — it reads the key out of a `` desc: __`Build the app` ``
and emits `` () => __`Build the app` `` into the tree it bakes, so the command is
listed in root help **and** described in the user's language. Written as a value
it is still translated at run time, and `sigil build` reports it as computed and
lists the command by name alone.

### The prompts, and what a translated `confirm` accepts

The affordances translate like everything else — the submit hint, the
multiselect hint, the settled answers, `Choose at least one`, and the command
palette's own `Run a command`, `No commands match` and `(skip)` — and `confirm`
is the one with a twist, because its hint names the keys it reads. Translating the
hint on its own would give a prompt that displays `(J/n)` and ignores `j`.

So there is **one** catalog entry, `y/n`, and it is both:

```json
{ "y/n": "j/n" }
```

That draws `(J/n)` — the parens and the capital are the framework's, and the
capital follows `default` — and it accepts `j` for yes. A half may be a whole
word: `"ja/nein"` draws `(Ja/nein)` and the key is still `j`, because the key is
the half's first character.

Two rules worth knowing:

- **`y` and `n` keep working**, on top of whatever the entry named. A hint that
  names a subset is not a lie — `bool` accepts six spellings of true and no hint
  names them — and what gets refused is a hint naming something that does not
  work.
- **The entry wins where the two collide.** A romanized `"n/a"` makes `n` mean
  _yes_, as the reader was told, so English `n` is refused rather than giving one
  keypress both answers.

An entry that is not two halves naming two distinct keys is refused outright:
English stands, and `DEBUG=sigil:i18n` says so.

What does **not** move is `argv`. `--force=y` and `type: 'yesno'` accept
`y`/`yes`/`n`/`no` in every locale, because a value in a shell script must not
mean something different under another `LANG`. A keystroke at an interactive
prompt is the other case, which is why only the prompt's keys gain anything.

Key names are English and modifiers are not: `ctrl-{0}`, `alt-{0}` and
`ctrl-alt-{0}` are keys, so a German catalog writes `Strg+{0}` and the hint reads
`(Strg+d zum Absenden)`. The separator is the catalog's too. The key's own name
stays English, because the letter on the cap — and `enter`, and `tab` — is
printed the same on essentially every keyboard sold.

### A missing translation

It renders the English sentence it was keyed on, silently. That is deliberate: a
partial catalog is the normal state of a translation, and a German build with
seven English messages in it is better than an English one — where printing
`[missing: …]` would replace a working message with a broken one, on the error
path, where the user is already being told something went wrong.

What is loud is the **build**. `sigil check` compares every declared key against
every catalog, both ways, so a key that falls back _forever_ is reported — and a
reworded English sentence shows up as one missing key and one orphan, which is
exactly the "this string changed" signal. `DEBUG=sigil:i18n` logs every miss at
run time.

`SIGIL_KEYS` from `@ttylabs/sigil/i18n-keys` is the list of sigil's own
messages, for a catalog that wants to cover them.

### What is not here

Number, date, currency and list formatting, and locale-aware sorting. Each
`Intl` constructor that needs ICU costs 4–7 ms in a cold process — a quarter of
a whole `--version` run — and the framework has no number to format: every
number in its own messages is a value the user typed, which has to be echoed
verbatim. `Invalid integer: 9007199254740993` must say that integer and not
`9.007.199.254.740.993`. An app that wants one constructs its own, lazily, and
pays the cost where it can see it.

Also not here: ICU MessageFormat or any mini-syntax, and right-to-left layout.

---

## Typed argv

`command()` and `options()` are identity functions that exist for the types.
Wrapping a command reads its format strings and gives `run` a narrow `argv`:

```ts
import { command, options } from '@ttylabs/sigil';

const global = options({
  '-v, --verbose': 'Say more',
  '--port [n]': { default: 8080, type: 'int' },
});

const build = command({
  options: { ...global, '--target [name]': { choices: ['esm', 'cjs'] } },
  args: ['<entry>', '[rest...]'],
  run({ argv }) {
    argv.entry; // string
    argv.rest; // string[] | undefined
    argv.target; // 'esm' | 'cjs' | undefined
    argv.verbose; // boolean
    argv.port; // number
  },
});
```

Wrapping is optional and per command. A command declared as a bare object still
parses identically — it just keeps a wide `argv`.

A command is typed at its own `command()` call, and nothing there knows where in
the tree it will be mounted, so **options inherited from a parent are not in its
types** even though they resolve at runtime. Spreading the group into the
command's own options — as above — is how you get them typed, at the cost of
shadowing the parent's and moving those rows out of `Global options`.

---

## Testing

```js
import { runCommand } from '@ttylabs/sigil/testing';

const ran = await runCommand({ argv: ['build', 'src/index.ts'], schema });

ran.code; // 0
ran.out; // what it wrote to stdout
ran.err; // what it wrote to stderr
ran.argv; // the values the command's run() was handed
ran.error; // the error, where it failed
ran.result; // what main() returned, which for a command that returns a value is that
ran.state; // the parse state
```

`runCommand()` is **`main()`** — the same function your bin calls and the same
one `sigil build` generates a call to — with the three things it writes to the
process read back instead of left there. That matters more than it sounds:
`main()` prints help, writes `--version`, renders an error and sets
`process.exitCode`, which is right for a bin script and useless to a test. It is
deliberately not a reimplementation: a helper that called `parse()` and then
`run()` itself would have to decide, again, that help outranks a missing required
option, that `--version` is answered before the command runs, and what a thrown
value does to the exit code.

Three things to know:

- **Pass `argv`.** Left out, `main()` reads `process.argv`, which under a test
  runner is the runner's own arguments.
- **One at a time.** It patches `write` on both of the process's output streams,
  so two concurrent runs would each capture part of the other's output. A second
  run while one is in flight throws rather than interleaving silently.
- **Turn the console intercept off.** vitest replaces the `console` methods so it
  can attribute output to a test, and a command that writes with `console.log`
  then reaches the reporter instead of the capture — `ran.out` comes back empty
  for a command that works perfectly. `sigil new` writes the config for you:

  ```js
  export default defineConfig({ test: { disableConsoleIntercept: true } });
  ```

### A test runner's streams are pipes

This is the part worth reading even if you never call the rest of it.

A vitest (or jest, or node:test) worker's stdout and stderr have no `isTTY` and
no `columns`. So everything that asks about where it is writing gets the same
answer — not a terminal, no colour, the fallback width — and that is the one case
that cannot fail. **A suite can be entirely green and say nothing at all about
what a user's terminal gets**, and you will not notice, because the test you
wrote passes.

`runOnTerminal()` is how to ask the other question. It spawns your program in a
child whose streams claim to be a terminal:

```js
import { runOnTerminal } from '@ttylabs/sigil/testing';

const terminal = await runOnTerminal({ run: './dist/mycli.mjs', argv: ['check'] });
const piped = await runOnTerminal({ run: './dist/mycli.mjs', argv: ['check'], tty: false });
```

The two differ only where your program **keys something on `isTTY`** — which is
what `sigil check` and `sigil build` do with a report, laying it out and
colouring it for a terminal and writing one line per diagnostic to anything
else, so that `grep` and `awk -F:` still work. A program that writes the same
bytes either way gets the same bytes here, which is the right answer and is also
the thing to check first if a differential surprises you.

| option    | default | what it does                                                           |
| --------- | ------- | ---------------------------------------------------------------------- |
| `run`     | —       | a module to run. Exactly one of this and `source`                      |
| `source`  | —       | an ES module to run inline, via `node --input-type=module -e`          |
| `argv`    | `[]`    | arguments, after the module                                            |
| `tty`     | `true`  | which streams claim to be a terminal; `false` is the pipe control      |
| `columns` | `80`    | `COLUMNS` always, and `stdout.columns` on the streams `tty` names      |
| `rows`    | `24`    | `LINES` always, and `stdout.rows` on the streams `tty` names           |
| `color`   | —       | a level to force, or `false` for none. Omitted, it detects from `TERM` |
| `cwd`     | —       | the working directory                                                  |
| `env`     | `{}`    | variables on top of a sanitised copy of the parent's                   |
| `timeout` | `30000` | how long before it is killed                                           |

What it answers: `{ code, out, err, signal }`.

The useful assertion is usually a **differential** rather than either form on its
own — the two say the same words, and what differs is the wrapping and the
colour. That is the shape of claim a snapshot cannot make, and a snapshot's
baseline is whatever was current the last time somebody regenerated it.

Two traps it closes for you, both of which cost this project a debugging session:

- **The environment decides the colour, not the stream.** A stream claiming to be
  a terminal with no `TERM` behind it still detects level 0 — so a test asserting
  colour would be asserting the one thing that cannot happen. And in the other
  direction, a CI runner sets `CI` and `GITHUB_ACTIONS`, either of which decides
  the level for a destination that claims to be a TTY, so the same test would
  assert a different colour on a laptop than on CI. Every variable the detection
  reads is cleared, and `TERM` is set when a stream claims to be one.
- **Chunks split mid-character.** A `data` event is a `Buffer` of whatever
  arrived, which for a frame full of multi-byte glyphs can end in the middle of
  one. The buffers are concatenated and decoded once, which is where a stray
  `U+FFFD` in an assertion comes from.

There is no pty anywhere in this, because node has no pty and this package has
no dependencies. What it does not prove is that node reports `isTTY` correctly
for a real pty, or anything about terminal _modes_ — raw mode, bracketed paste,
mouse reporting. A claim only a real terminal can falsify belongs in a script you
run by hand against the terminals you care about.

### Prompts, without a pty

A prompt rejects outright when either end is not a terminal — that is what stops
a build hanging on a question nobody can answer — so a prompt is not testable
from a runner at all, and not through `runOnTerminal()` either: a prompt needs
keys delivered over time and the far end held open, and a child whose stdin is
written and closed reports that the stream ended.

`createTestTerminal()` is the answer. It is a terminal and a keyboard,
in-process, with no child and no clock:

```js
import { select, text } from '@ttylabs/sigil/components';
import { createTestTerminal, ctrl, KEYS } from '@ttylabs/sigil/testing';

const ui = createTestTerminal({ columns: 40, rows: 8 });

const name = text({ message: 'Name?', terminal: ui.terminal });
await ui.press('chris', KEYS.enter);
await name; // 'chris'

const pick = select({ choices: ['one', 'two'], message: 'Pick', terminal: ui.terminal });
await ui.press(KEYS.down, KEYS.enter);
await pick; // 'two'
```

- `press(...chunks)` sends each argument as **one read**, which is the
  distinction a prompt acts on: a terminal delivers a keystroke as its own read
  and a paste as one read holding many characters. So `press(KEYS.up, KEYS.enter)`
  is two keystrokes and `press('chris')` is one read of five characters.
- `paste(text)` sends a bracketed paste, which is not the same as typing it: a
  newline inside a paste is content where a typed Enter submits.
- `KEYS` names the sequences — `up`, `enter`, `backspace`, `pageUp`, `shiftTab`
  and the rest — because the bytes are not guessable and a wrong one is a test
  that presses nothing and passes. `ctrl('c')` and `alt('x')` build a chord.
- `ui.viewport` is **what is showing** and `ui.lines` is the **main** buffer —
  the same thing until something switches to the alternate screen, after which
  `lines` is the log behind it. `ui.output` is every byte, for the few claims
  that really are bytes, and `ui.stdin` is the stream itself for anything
  `press()` and `paste()` do not cover.
- `tick()` is exported for those: it lets pending work settle the way `press()`
  does at the end of each read, which is what makes the next assertion see the
  frame. It is `setImmediate` rather than a drain of microtasks, and the
  difference is observable — a prompt queues each key through a promise chain and
  a `validate` may be async, so a fixed number of microtask turns stops part way
  through. Reach for it after writing to `ui.stdin` yourself, or after a signal
  write in a tree of your own.

`createTestTerminal()` takes `columns` (40) and `rows` (8), `env` (none at all,
so nothing is detected from the real environment), `colorLevel` (0 — raise it
for a test that reads `ui.output` for a sequence, remembering that `Screen`
keeps characters rather than colour), `isTTY` (true) and `inputTTY` (follows
`isTTY`). That last one is how to test the path where there is nobody to answer:
with `inputTTY: false` a prompt rejects rather than hanging, which is what stops
a build waiting for ever on a question nothing can answer.

That last one is the other thing worth knowing. A component draws through a
canvas, and a canvas frame is a **diff against the frame before it** — so the
last thing written is a handful of changed cells with cursor movements between
them, and asserting on the bytes says nothing about what anybody is looking at.
The fixture replays them against a screen model instead, which answers the
question you meant: after these frames, what does it look like?

```js
// nothing is drawn until something ticks, which is what `press()` does at the
// end of each read -- so a read before any key needs a `tick()` of its own.
// Read before a key is pressed, so the pointer is still on the first row
await tick();

ui.lines; // ['? Pick', '❯ one', '  two']
ui.screen.cellAt(0, 1); // '❯'
ui.output; // every byte, for the few claims that really are bytes
```

`Screen` is exported for a test that wants to replay bytes itself. It reads
grapheme clusters: a wide cluster takes two columns and leaves the far half
addressable as `''`, so `cellAt()` can say which column something starts in. It
models the sequences the framework emits — cursor moves, erases, the alternate
screen, the cursor's visibility, OSC 52 — and **throws** on one it does not,
which is how it says it has no answer rather than quietly getting a row wrong.
`screenStream(screen)` is the other half of that pair: it wraps a `Screen` as a
TTY write stream, which is what `createTerminal({ stdout })` takes — so a test
that needs a terminal built its own way, rather than the one
`createTestTerminal()` builds, has somewhere to write to. It carries a
`resize(width, height)` that resizes the screen and tells whoever is listening,
the way a window change does.

What `Screen` does **not** model is styling, bar reverse video — a prompt's
caret is reverse video over a cluster, so `screen.lastInverse` is where that is —
which means a claim about _colour_ belongs in a `runOnTerminal()` run, where a
real styler writes real sequences.

### Why it is a subpath and not a package

`@ttylabs/sigil/testing` ships inside the runtime rather than as a
`@ttylabs/test` of its own, for the reason `sigil add` already works that way: an
app depends on `@ttylabs/sigil` at an exact version, so helpers that ship beside
it always match the `main()` they run and the `Terminal` they fake. A separate
package on its own version line could be a release ahead of the runtime under
test, and for `runCommand()` that would mean running a `main()` that is not your
app's.

It costs an app that never imports it **nothing** — measured as the transitive
static import graph of each entry, which is what an unbundled app actually loads:
importing `@ttylabs/sigil` is the same six modules it always was, and the testing
module is reached only by a file that asks for it. A bundler drops it either way.

---

## Config files

`@ttylabs/sigil/config` presents **one merged view over an ordered stack of
layers**. `get()` reads the merged view; `set()` and `delete()` mutate one
layer, because a merged value has no single home to write to.

```js
import { createConfig, json, object } from '@ttylabs/sigil/config';
import { configHome } from '@ttylabs/sigil/paths';

const config = await createConfig({
  schema: {
    'server.port': { type: 'int', default: 8080, env: 'PORT' },
    'editor.theme': { type: 'string', choices: ['light', 'dark'] },
    plugins: { type: 'string', multiple: true, merge: 'concat' },
  },
  layers: [
    { name: 'system', readOnly: true, store: json('/etc/myapp/config.json') },
    { name: 'user', store: json(configHome('myapp', 'config.json')) },
    { name: 'runtime', store: object() },
  ],
});

config.get('server.port'); // 8080, unless a layer or PORT said otherwise
config.get('server'); // { port: 8080 } — the merged subtree
config.has('editor.theme'); // false where nothing configured it
config.set('editor.theme', 'dark'); // into 'runtime', the topmost writable layer
config.set('editor.theme', 'dark', 'runtime'); // or into a named one
config.push('plugins', 'mine');
config.delete('editor.theme');
await config.save(); // and `saveSync()` for an exit handler
```

`createConfigSync()` is the same thing without awaiting, which is the **read-in**
half of what an exit or signal handler needs — `saveSync()` above is the write-out
half, and neither can await. Every accessor is synchronous either way: the layers
are read once, at construction, so `get()` is a lookup in an object already in
memory rather than a promise per read.

`set()` mutates a layer in memory and `save()` persists it. **An app that sets
and exits without saving loses the write** — `config.layers[n].dirty` is there
so an app that wants to warn can.

### Core does not load config, and does not accept one either

Nothing in `main()` or `parse()` calls any of this or takes one. **Options and
config settings are separate, and your app decides how to mix them** — an option
is something a user types for one run, and a config setting is something that
persists, so coupling them means every option wants a config key and every
config key wants an option. Neither is true.

The mixing is one line, in either of two spellings:

```js
// in run(), the explicit version
const port = argv.port ?? config.get('server.port');

// or at schema-build time, which gives argv → env → config through the chain
// that already exists
options: { '--port [n]': { type: 'int', default: config.get('server.port') } }
```

The second works because you load config before you build your schema. What
that gives up, plainly: there is no automatic "this option falls back to this
config key."

It also means there is no `--config` flag in your namespace, and no convention
for what it would be called — the ecosystem does not agree either (`--config` in
eslint, prettier, webpack, rollup and vite; `--config-file` in babel; a
_directory_ in docker; a path **or** a JSON blob in jest). Declare whichever one
your app wants and hand it in as a layer. A file and an inline blob are then not
a conflict at all but two layers, with the inline one on top for the same reason
argv beats the environment.

### The layers

Array order, bottom first, so **later layers win** — the last entry is on top.

A layer is a name, a store, and optionally `readOnly`:

| store           | what it is                                                                        |
| --------------- | --------------------------------------------------------------------------------- |
| `json(path)`    | a JSON file, read as JSONC: `//` and `/* */` comments and trailing commas         |
| `object(value)` | a value your app already has                                                      |
| `object()`      | the in-memory override layer: a run that overrides a setting for its own duration |

Both write. `json()` writes by **editing spans**, so a `save()` changes the
bytes it was asked to and nothing else; `object()` replaces the value it holds,
so a layer over one persists nothing.

A file that is not there reads as an empty layer, which is the ordinary state of
a config file. A file that holds nothing but whitespace reads the same way.
Every other reason a read can fail — a directory where a file was named, a
permission error — is reported.

`readOnly: true` says _this one is not mine to write_, which is a different
statement from a store that cannot be written at all. Both are real: an `/etc`
file your app reads and must not touch is the first, and a format with no writer
is the second. `isWritableStore(store)` is the type guard for the second.

Both are refusals a named mutator or a named `save()` reports, and `save()` with
no name skips a read-only layer rather than refusing it — because "save what
changed" over a stack that holds an `/etc` file is an ordinary thing to ask.

### There is no `.js` layer

Reading one cannot be done synchronously — `import()` is async and there is no
synchronous ESM loader — and one store kind like that forces the whole interface
to carry optional methods and every caller to branch on which half a store
speaks. So an **object layer** takes its place:

```js
const mod = await import('./app.config.js');

const config = await createConfig({
  schema,
  layers: [
    { name: 'defaults', store: object(mod.default) },
    { name: 'user', store: json(configHome('myapp', 'config.json')) },
  ],
});
```

Nothing is lost in capability, only in convenience — and what you gain is control
over _how_ your module is loaded: TypeScript, with arguments, conditionally, or
not at all. It also puts the ESM module cache where the only party that knows
whether it matters can see it: a `.js` layer could never be reloaded, because the
loader caches a module for the life of the process and a cache-busting query
string leaks one per reload. Re-import with a buster if you want to; that is your
leak and your decision.

### `apply()` is how a reload works

```js
config.apply('user', await readMyConfigAgain());
```

**Replace, not merge.** A merge _inside_ a layer would be a second merge
semantics sitting beside the cross-layer one, and the two would then have to
agree about depth and about arrays. Two objects that should merge are two
layers: the stack _is_ the merge.

It works on a read-only layer, because re-reading one is not writing it.

### Watching a config file

A long-running CLI — a dev server, a TUI, a watch mode — wants to know when its
config changed. `config.watch()` is that, in two forms:

```js
// one setting, which is almost always what "reload when config changes" means
const stop = config.watch('server.port', ({ previous, value }) => restart(value));

// or everything that moved
const stopAll = config.watch((changes) => {
  for (const { path, previous, value } of changes) {
    log(`${path}: ${previous} -> ${value}`);
  }
});
```

Each returns a disposer, safe to call more than once. The file watchers start
when the **first** handler registers and stop when the last one goes, so a
config nobody watches opens no file descriptor — and under `fs.watch` it is one
watcher per directory, so two layers in one directory share it. Under `poll` it
is one `watchFile` per file, because that is the whole of what polling has to do.

What a handler is handed is a **diff rather than the fact of a change**, which is
the half that makes this worth having over `fs.watch` plus a re-read of your own.
`config.get(change.path)` always equals `change.value`. And because the merge is
layered, a change in a lower-precedence layer that a higher one **shadows
publishes nothing** — which is the one thing a per-file watcher can never tell
you:

```js
// a system file and a user file, and the user's wins
config.watch('theme', ({ value }) => repaint(value));
// somebody edits the system file's `theme`: nothing fires, because nothing
// an app can see has changed
```

Every layer whose store reports a `source` the watcher can read as a file path
is watched. An **object layer** has no file, so it is not watched — and `apply()`
is how it participates in the diff, which makes `config.watch()` worth calling on
a config of nothing but object layers. A layer whose source is a **URL** is not
watched either, and says so through `onError`.

A **symlinked** config is watched through the link, because that is where the
writer writes: the directory watched is the real file's rather than the link's,
which is what makes a `stow`-style layout work. What that gives up is the link
itself being re-pointed while the app is running.

#### It survives an atomic write, which is the whole point

`fs.watch(file)` is the obvious implementation and it is a feature that works
until the first save and then stops, silently, for the life of the process. A
rename swaps the inode, so a watch registered on the path is watching a file
nothing will ever write to again — which is why an editor that saves atomically
is the known case that breaks `fs.watch`, and `save()` is one. Measured on
macOS over a real temp-plus-rename:

| what was watched             | first rename | second rename |
| ---------------------------- | ------------ | ------------- |
| the **file**                 | one event    | **nothing**   |
| the **directory** holding it | three events | three events  |

So the directory is watched and the event itself is never read — not
`eventType`, not `filename`, both of which differ by platform. Any event means
re-read and compare, which is what makes those differences stop mattering.

Four more things fall out of that, and each is a way a naive watcher fails:

- **A file that does not exist yet** is the ordinary case on a fresh install, and
  `fs.watch` on a missing path throws. So the watcher climbs to the deepest
  existing ancestor and re-targets downward as the directories appear.
- **One logical save is two to five events** — vim writes a backup, truncates and
  renames — so a reload per event reads a truncated file and clobbers a good
  config with nothing. Reloads are debounced (50ms), and more importantly
  **compared**: a reload that produces the value already held publishes nothing.
- **A read that fails mid-write is expected**, so it retries and only a failure
  that persists past another window is reported — with the last good value kept.
- **Your own `save()` fires the watcher**, and the compare handles it: the value
  read back is the one just written, so nothing is published. Which is better
  than suppressing events for a window after a write, because that also swallows
  somebody else's write that landed in the same window.

#### A reload overwrites an unsaved `set()`

**A reload is a reload.** An unsaved `delete()` is restored by one, so an unsaved
`set()` is overwritten by one — two rules there would mean a reloaded layer is
neither what the file says nor what you set. An app that wants its writes to
survive a reload calls `save()` first. The compare means the ordinary case never
arises, and when it does arise the change is dispatched, so an app holding
unsaved values is told.

#### Where a failure goes, and polling

```js
const config = await createConfig({
  layers: [...],
  watch: {
    debounce: 50, // how long to wait for a write to settle
    interval: 1000, // how often to stat, under `poll` and during a climb
    onError: (e) => myLog.error(e), // a handler that threw, or a read that kept failing
    poll: false, // stat instead of using filesystem events
  },
});
```

There is no default for `onError` that can be right — `console.error` from a
library corrupts a full-screen app's screen, and throwing from a timer callback
is an uncaught exception — so the floor is the `sigil:config` debug log, which is
silent unless somebody asked. **An app that watches config should pass
`onError`**, because a config file the user broke is exactly the thing they need
telling about.

`poll: true` is the answer for a **network filesystem or a container bind
mount**, where inotify does not propagate and `fs.watch` silently never fires —
works in dev, dead in Docker, nothing to point at. It is opt-in rather than
guessed at, because nothing in a process can tell a filesystem that will deliver
events from one that will not.

Two limits worth knowing, both named rather than guarded. A change that lands
between the config's own read and your `watch()` call is not delivered **on its
own**, because nothing was watching yet — it is not lost, though: the next event
diffs against the value the config is still holding, so that earlier change
arrives merged into the next publish. And a filesystem event can be **dropped** —
measured at about 3% for a watcher written to immediately after it is created,
under heavy parallel load — which in the steady state costs latency and recovers
on the next write. During a climb it would be permanent, so while the watcher is
not on the directory it wants it re-checks every `interval`. (`interval` has two
jobs: that re-check under `fs.watch`, and how often the file is stat'd under
`poll`. A debounce `setTimeout` runs on every event, and under `poll` a
`watchFile` runs for as long as you are watching; all of them are unref'd, so
none holds the process open.)

### The schema

Config's own schema, declared by dotted path, in the parser's own type
vocabulary:

```js
{
  'server.port': { type: 'int', default: 8080, env: 'PORT' },
  'editor.theme': { type: 'string', choices: ['light', 'dark'] },
  plugins: { type: 'string', multiple: true, merge: 'concat' },
}
```

| property   | what it does                                                                                     |
| ---------- | ------------------------------------------------------------------------------------------------ |
| `type`     | one of `auto`, `bool`, `date`, `int`, `json`, `number`, `string`, `yesno`. `string` when omitted |
| `choices`  | the values this setting accepts                                                                  |
| `default`  | what `get()` answers when no layer and no variable did                                           |
| `desc`     | a one-line description, for an app that lists its own settings                                   |
| `env`      | environment variables that fill it, tried in order                                               |
| `merge`    | `'replace'` (the default) or `'concat'`                                                          |
| `multiple` | whether it holds a list                                                                          |

Both declarations mean the same thing by `int`, by `bool` and by a `choices`
list, because both go through the same `transformValue()` and `assertChoices()`
the parser uses. So a config setting and an option that happen to cover the same
thing cannot come to disagree about what `on` means.

What it does not give is nested object shapes, whole-subtree requiredness or
`oneOf`. For CLI config that is probably not missed, and saying so is better than
a half-built JSON Schema. A path the schema does not declare is readable and
untouched — a config file legitimately holds things your schema has nothing to
say about, so the schema is a partial typing over a free-form document.

### The one precedence chain

**A setting's environment variable, then the layers from last to first, then the
setting's `default`.**

The environment is on top because a variable is a statement about one run and a
file is a persistent one. The default is underneath everything because it is what
your app ships rather than what anybody configured. Both are materialized into
the merge, so `get('server')` holds a defaulted `server.port`.

A variable is read by the same rule an option's `env` is: `PORT=` is **unset**,
while `PORT=0` and `PORT=' '` are values, because only the empty string is falsy
among the values a variable can hold. A `multiple` setting's variable is wrapped
into a one-element list, because a variable can only hand over one value at a
time.

The file's own version of that rule: **a key absent and a key set to `null` are
both "not configured"; a key set to `""` is an empty string.** A `null` is
removed rather than kept, so writing `"theme": null` falls back to the layer
under it rather than shadowing it to `null`. `undefined` goes with it — no
text format can write one, and `config.set('x', argv.x)` with no `--x` is the
ordinary way an app reaches it, so `set()` of either is the `delete()` it means.
A `null` _inside_ an array is data and is kept.

### Values arrive already typed, and a string is still coerced

A JSON or YAML file hands back `true`, `8080` and `{...}` already typed, so
`transformValue()` — which turns a _string_ into a value — is the wrong function
for it. `checkValue(value, type)` sits beside it and reads the same vocabulary:
a string goes straight to `transformValue()`, and anything else is validated
against the type.

Coercing the string is what makes a format with no scalar kind but a string work
at all, and it is what stops `--shake=off`, `SHAKE=off` and `"shake": "off"`
meaning three different things. The vocabulary is strict and symmetric, so
`"nope"` throws rather than becoming a setting nobody chose.

### Arrays

**Replace by default.** A user writing `exclude: [...]` in their own file means
"this is my list", not "append mine to whatever shipped". And `concat` has no
ordering or de-duplication story without further decisions, so defaulting to it
would import those decisions silently.

`merge: 'concat'` is opt-in per key and concatenates in stack order, bottom
first, without de-duplicating.

`push`, `pop`, `unshift` and `shift` exist because `get('x')` hands back a
_merged_ array: mutating it in place would be writing to a computed value rather
than to a store — and the merged view is frozen, so the attempt is loud rather
than silent.

```js
config.push('plugins', 'mine'); // into the topmost writable layer
config.push('plugins', 'mine', 'user'); // or a named one
config.pop('plugins'); // the value removed
```

They append to **that layer's** array rather than to the merged one. With
`merge: 'concat'` that reads as appending to the merged list; with the default
`replace` it appends to that layer's own list, which then replaces what is
underneath. Seeding from the merged value instead would copy a lower layer's
values into this one, after which a change to your defaults never reaches the
user again.

One value per call, so that every mutator has one shape — a path, maybe a value,
maybe a layer. A trailing layer name and a trailing string value cannot be told
apart.

### What `get()` hands back is frozen

It is a computed value you hold a live reference to, so mutating it would change
what a later `get()` answers while changing no layer. `structuredClone()` is how
to take a mutable copy.

Only the structure is frozen, and only the structure is copied on the way in: a
`Date`, a class instance, a `Map` and a function are carried by reference, which
is what lets an object layer hold a plugin.

### Deleting a value that lives in a read-only layer

It throws, and the message names the layer and both ways out:

```
Cannot delete "editor.theme": it is set in <system defaults>, which is read-only.
  Set it in ~/.config/app/config.json to override the value, or
  remove it from /etc/app/config.json.
```

Not a tombstone. TOML cannot represent one, it is a new value concept every store
must support, and it needs a sentinel that can collide with a `null` the user
wrote. The useful half already works without it: `set()` on a writable layer
**shadows** a read-only value. What cannot be expressed is shadowing to _absent_.

### Dotted paths and prototype pollution

`__proto__`, `constructor` and `prototype` are refused as path segments and as
keys anywhere in a document. A dotted path is a _string_, and a string can arrive
from a file in a repository somebody cloned — `set('__proto__.x', 1)` on a plain
object goes through `Object.prototype`'s own accessor and changes the target's
prototype rather than writing a property.

`JSON.parse` puts `__proto__` on an object as an own property rather than through
the accessor, so a file holding one is read without incident — and then the first
`Object.assign({}, config.get('x'))` triggers the setter. A file that holds one is
either a mistake or an attack, and in both cases your app should not start
quietly.

### Writing a file back without destroying it

```js
config.set('server.port', 9090);
config.push('plugins', 'mine');

await config.save(); // every layer that changed
await config.save('user'); // or one of them
config.saveSync(); // which is what an exit handler needs
```

`save()` answers with the layers it wrote, in stack order, and writes nothing
for a layer nothing touched. A write whose text comes out identical touches no
file at all, so the mtime a watcher is reading survives a save that changed
nothing.

**It edits spans rather than reprinting.** To change a value it replaces the
span that value occupies; to add a key it splices one in after the last. So a
comment, a trailing comma, your indentation style, your key order, your line
endings and a missing final newline all survive — not because each is handled
but because the bytes holding them are never rewritten:

```jsonc
// what this app is configured with
{
  "server": {
    "port": 9090, // not 80, which needs root
  },
}
```

That file went through a `set('server.port', 9090)` and `8080` is the only thing
in it that moved.

What it cannot keep is a comment nobody can attach to anything: delete the key a
comment sits above and the comment stays where it was, orphaned, because the
alternative is guessing which comments are about which key.

### The write is atomic, and it keeps what the file was

A temp file beside the target, flushed, and `rename()`d over it — so a crash
mid-write leaves the old file rather than half of either. The temp file goes in
the target's **own directory**, because `rename()` is only atomic within one
filesystem.

The target's permission bits are preserved, or a `600` config comes back `644`.
Its setuid, setgid and sticky bits are not, because re-creating one on a file
this just wrote is a privilege decision a config writer has no business making.
Under `sudo` the file is chowned to the target's own owner, or to the containing
directory's where the file is new — so `sudo mycli config set` does not leave a
root-owned config in somebody's home directory.

The directory is created if it is not there, with the same
parent-directory-owner rule.

### It re-reads before it writes

Each layer's store is read again and **your changes are applied over what it
finds**, so two invocations setting two _different_ keys both survive where a
blind write loses one of them. The paths you changed are what the store is told
are yours — every other key in the file is left exactly as the file has it, even
one another process wrote while the save was running.

The residual race is **last-writer-wins on the same key**, documented rather
than guarded: a lock is the only real fix, nothing has asked for one, and a
half-guard here would read as safety and not be.

A store you write to directly gets the same thing through `WriteOptions.paths`:

```ts
await store.write({ port: 9000 }, { paths: ['port'] });
```

Without it a write is total, which is the only thing `write(value)` can mean on
its own. `apply()` passes nothing for that reason — it replaces a layer rather
than merging into it, so the file is written wholesale.

What follows is worth knowing: a layer the save re-read may come back holding
keys it did not hold before, so `get()` can answer differently after a `save()`
than before it. That is the file being right about itself.

The layer is what **you** read plus what you changed, which is not quite the
bytes: the file is what the store read plus the same changes, so the two differ
for exactly the keys another process wrote in the window — `get('b')` can answer
`1` over a file that says `99`. Closing that needs a third read to re-stage from,
and a third read only moves the window; the next run is where the file is read
again.

### There is no `autoSave`

A `set()` that schedules a write is a `set()` that cannot say the write failed,
which is the silent-loss class every other decision here refuses. `set()` is
synchronous and a store's `write()` may not be, so the two cannot be one call.

What you get instead: a run that sets five keys writes once, and the
temp-plus-rename and the re-read are one operation rather than five.

### A write that would lose something refuses

The thing to guard is not comments, it is **loss** — key order, an anchor, an
indentation style, an XML attribute that was spelled as an attribute. Each is
silent in exactly the same way, and a guard that greps for comments protects
the one people notice and leaves the rest. So:

**A write either preserves everything it was not asked to change, or it names
what it would lose and refuses.**

```
Refusing to write user: comment:4, comment:11, anchor:22 (&defaults) would be lost.
  Pass lossy: true to write anyway, or use a store that can keep what is there.
```

It is asked of the **document** rather than of the store, which matters: a
reprinting store writing a file that has no comments in it loses nothing, and
refusing that write would be a guard firing on correct code. A span store
answers for free because it already parsed the file.

So the file stores in here never trip it — the guard is mostly for a store that
reprints, which a YAML or XML sibling is. `lossy` is per call and per layer and
deliberately never global:

```js
await config.save({ lossy: true }); // this call
layers: [{ name: 'generated', lossy: true, store: reprinting(path) }]; // this layer
```

`reprinting(path)` stands for a store that reprints — the two file stores in
here answer with no loss at all, so `lossy` on a `json()` layer is a flag
nothing ever reads.

Per layer is the legitimate case — this file is generated, so clobber it freely.
A global "allow clobbering" is set once in a scaffold and never thought about
again, which defeats it.

### A value JSON cannot hold is refused where it was written

```js
config.set('server.retries', Infinity);
// user cannot hold the value at "server.retries": JSON has no Infinity
```

`JSON.stringify` has three answers for a value it cannot represent and only one
is loud: it throws for a `BigInt`, answers `undefined` for a function or a
symbol, and **silently rewrites** `NaN` and `Infinity` as `null`, a `Map` or a
`Set` as `{}`, and a class instance as whatever its own enumerable keys happen
to be. The third is why `canRepresent()` exists.

A `Date` passes, and so does anything else with a `toJSON` — `JSON.stringify`
calls that first and never looks at the rest, so an object that said what it is
in JSON has said it.

### `.json` and `.jsonc` are read the same way

```js
json('config.json'); // comments and trailing commas: fine
json('config.jsonc'); // the same reader, the same answer
```

One reader rather than one per extension, so you never have to rename a config
file to put a comment in it. `tsconfig.json` is JSONC under a `.json` name and
so are VS Code's own settings: an extension is a file name rather than a
declaration about the bytes, and a config file is the file people most want to
annotate.

What that gives up is a `Comments are not allowed in ...` message naming the
line. It bought strictness nobody asked for — `json()` never _writes_ a comment,
so reading one strictly could only refuse a file every other tool accepts. If a
file has to stay strict JSON, the thing that says so is whatever consumes it.

### Writing your own store

`ConfigStore` is public API rather than an internal seam, which is why it is
drawn whole:

```ts
interface ConfigStore {
  readonly format: string;
  readonly source?: string;
  read(): Promise<ConfigDocument>;
  readSync(): ConfigDocument;
  canRepresent?(value: unknown, path: string): true | string;
}

interface WritableConfigStore extends ConfigStore {
  write(value: unknown, opts?: WriteOptions): Promise<void>;
  writeSync(value: unknown, opts?: WriteOptions): void;
}

interface ConfigDocument {
  value: unknown;
  wouldLose?: readonly Loss[];
}

interface Loss {
  kind: 'comment' | 'anchor' | 'formatting' | 'declaration' | (string & {});
  line?: number;
  detail?: string;
}

interface WriteOptions {
  lossy?: boolean;
  paths?: readonly string[];
}
```

A `write()` is handed the **whole** value the layer should hold rather than a
list of changes, which is what lets a store choose how to get there: the JSON
stores diff it against the bytes they already hold and splice, where a store
with no editing model reprints and says so through `wouldLose`.

`WriteOptions.paths` is what says which of that value is the caller's. A store
may ignore it and be total, which is a coarser answer rather than a wrong one —
and a store that honours it leaves every key the caller did not claim exactly as
it found it, which is the only way a `save()` can re-read the file and not revert
what another process wrote in the window. `WriteOptions` is in the fence above
for that reason: a store copied from it that stopped at `lossy` would have that
defect back.

`Loss.kind` is open rather than a closed union, because a format this package
has never heard of has trivia this package cannot enumerate.

Both read halves are **required**, and they are two real implementations over one
shared parse rather than one wrapping the other:

```ts
async read() { return this.#parse(await readFile(this.#path, 'utf8')); }
readSync()   { return this.#parse(readFileSync(this.#path, 'utf8')); }
```

A store that genuinely cannot do sync — a remote one — throws from `readSync()`
with its own message saying so. That is strictly better than an optional method:
the failure is localized to the store that has it and worded by the author who
knows why, and no caller branches.

A store has **two refusals and they are different shapes**. _Will not write_ is
the separate interface, so TypeScript enforces it and a type guard narrows.
_Cannot represent this value_ is `canRepresent()`, and it is synchronous because
`set()` is — so a value the format cannot hold is refused at the call that wrote
it rather than discovered by a `save()` in an exit handler. TOML and `null` is
the case it exists for.

`wouldLose` is what this store could not carry through a write. It is **absent**
where nothing would be lost — the field is optional, so a store that edits spans
omits it even over a comment-rich file rather than answering `[]` — and populated
by one that reprints. So read it as `layer.wouldLose?.length`, not
`layer.wouldLose.length`. It reads back on `config.layers`, and `save()` is what
refuses over it.

### JSONC, and what it is not

`//` and `/* */` comments and trailing commas. The flavour `tsconfig.json` and
VS Code's settings are written in -- which is also why `json()` reads a `.json`
this way: those two are JSONC under a `.json` name.

Not JSON5: no single-quoted strings, no unquoted keys, no `+1`, no hex, no `NaN`.
Widening it would be inventing a dialect other tools cannot read.

It strips rather than parses — each comment and trailing comma is replaced with a
space, every newline is kept, and the result goes to `JSON.parse`. So the JSON
value grammar is the reference implementation's rather than a second one here,
and a parse error still points at the character it was about.

A `.json` holding a comment is _reported_ as a comment, naming the line, rather
than reaching `JSON.parse` as `Unexpected token /`.

---

## Subpath modules

Each is independently importable and has no dependencies.

### `sigil/ansi`

```js
import { ansi, createAnsi, strip, hasAnsi, supportsColor } from '@ttylabs/sigil/ansi';

ansi.bold.red('error'); // chainable, cached
ansi.hex('#ff8800')('warn');
ansi.bgRgb(0, 0, 255).white(' info ');
ansi.blue(`a ${ansi.red('b')} c`); // nesting restores the outer style

strip(ansi.bold.red('error')); // 'error'
hasAnsi('x'); // false

ansi.level; // 0-3, detected from the terminal
const forced = createAnsi({ level: 3 });
```

Color support is detected from `TERM`, `COLORTERM`, `FORCE_COLOR`, `NO_COLOR`,
CI variables, and whether the stream is a TTY. `strip()` removes SGR, OSC, DCS,
and CSI sequences, not just colors.

### `sigil/wrap`

```js
import { wrap, terminalWidth, DEFAULT_WIDTH, MAX_WIDTH } from '@ttylabs/sigil/wrap';

wrap('The quick brown fox jumps over the lazy dog and keeps on going', 24);
// The quick brown fox
// jumps over the lazy dog
// and keeps on going

wrap('one two three four five six', { width: 16, indent: '> ' });
// > one two three
// > four five six

terminalWidth(); // COLUMNS, then stream columns, then 80
terminalWidth({ env: { COLUMNS: '72' } }); // 72
```

`COLUMNS` is read first, since it is how a caller states a width the stream
cannot be asked for. The result is capped at `MAX_WIDTH` (100) — long lines are
harder to read than narrow ones — and `opts.max`, `opts.fallback`, `opts.env`,
and `opts.stream` each override a step.

Wrapping is ANSI-aware and grapheme-aware: a style open at a line break is
closed and reopened, so a background color never bleeds into the margin.

### `sigil/width`

```js
import { stringWidth, graphemes, graphemeWidth, unicodeVersion } from '@ttylabs/sigil/width';

stringWidth('日本語'); // 6  — East Asian Wide
stringWidth('á'); // 1  — combining mark
stringWidth('🇯🇵'); // 2  — regional indicator pair
stringWidth('👨‍👩‍👧‍👦'); // 2  — one ZWJ cluster
graphemes('á日🇯🇵'); // ['á', '日', '🇯🇵']
unicodeVersion; // '17.0.0'
```

### `sigil/help`

```js
import { renderHelp, resolveHelp } from '@ttylabs/sigil/help';

await resolveHelp(state); // fires the command's help hooks, then renders
renderHelp(state, { width: 100 }); // renders a context chain directly
```

`HelpOptions` takes `ansi`, `gap`, `indent`, `maxLabel`, `name`, `sections`,
and `width`.

### `sigil/i18n`

```js
import { __, __n, setLocale, locale } from '@ttylabs/sigil/i18n';

__`Unknown option "${name}"`;
__n(n, '{0} file', '{0} files');
await setLocale('de');
locale(); // 'de', or undefined for English
```

See [Translating](#translating). Also `loadCatalog()`, `resolveLocale()`,
`normalizeLocale()`, `localeChain()` and `templateKey()`, and
`SIGIL_KEYS` from `@ttylabs/sigil/i18n-keys`.

### `sigil/terminal`

Owns the terminal's global state: the streams, its size, the cursor, raw mode,
and putting all of it back however the process ends.

```js
import { terminal, createTerminal } from '@ttylabs/sigil/terminal';

terminal.write('hello\n'); // never throws, even into a closed pipe
terminal.isTTY; // whether repainting means anything
terminal.width; // live, uncapped
terminal.height;

const off = terminal.onResize(({ width, height }) => redraw(width, height));

terminal.hideCursor(); // shown again on exit, SIGINT, SIGTERM, or SIGHUP
terminal.setRawMode(true); // left again the same way
terminal.restore(); // or put it all back now
```

`write()` and `writeErr()` swallow the far end going away — `mycli --help |
head -1` closes the pipe the instant `head` has its line, and an `EPIPE` with
no listener is an uncaught exception. After that `terminal.closed` is `true`
and writes are no-ops.

`width` is deliberately **uncapped**, unlike `terminalWidth()`, which stops at
`MAX_WIDTH`: that cap is a readability limit on generated prose, while this is
the real screen, and cursor math needs the real number.

Only one thing may repaint the bottom of the screen — a spinner still ticking
underneath a prompt draws over it — so the live region is a lock:

```js
const claim = terminal.claimLive(() => clearWhatIDrew());

claim.active; // false once something else claims it
claim.release();
```

Nothing is installed on the process until there is something to put back, so
importing this does not give every CLI a signal handler.

#### The live region

`createLiveRegion()` repaints the last few rows in place while everything above
them keeps scrolling — what a spinner, a progress bar, or a prompt draws on.

```js
import { createLiveRegion } from '@ttylabs/sigil/terminal';

const region = createLiveRegion();

for (const frame of ['|', '/', '-', '\\']) {
  region.render(`${frame} Building`, 'Building');
}

region.write('compiled foo.js'); // stays, and lands above the spinner
region.done('✔ Built in 1.2s'); // last frame stays, region released
```

`render()` takes a second argument for what the frame _means_, used when the
output is not a terminal. Piped into a file or a CI log there is no cursor to
move, so frames are not repainted — one line is written per change instead of
one per tick:

```
Building
compiled foo.js
Linking
✔ Built in 1.2s
```

That is the whole of the non-TTY handling: a component animates into `render()`
and does not have to know where it is running. `region.isLive` says which case
it is, for anything that wants to skip the work.

|                         |                                                               |
| ----------------------- | ------------------------------------------------------------- |
| `render(frame, plain?)` | draw, replacing the last frame                                |
| `write(text)`           | output that stays, above the region                           |
| `clear()`               | erase the region, keep the claim                              |
| `done(final?)`          | leave a last frame, release                                   |
| `stop()`                | erase and release                                             |
| `active`, `isLive`      | whether it still holds the region, and whether it can repaint |

A frame's height is measured in **displayed rows** — `stringWidth()` against
the live width, not a count of newlines — so a wrapped line or a CJK label
still walks the cursor up by the right amount. On a resize the previous
frame's height is no longer knowable, so the next repaint cleans from the
cursor down rather than walking up a number it cannot trust.

Creating a second region evicts the first, through the same claim the terminal
hands out.

The clipboard is OSC 52 — a write rather than a mode, so there is nothing for
`restore()` to put back:

```js
import { terminal, copyToClipboard, CLIPBOARD_LIMIT } from '@ttylabs/sigil/terminal';

const copy = copyToClipboard(terminal, 'text to copy');

copy.written; // the bytes reached the stream -- NOT that the clipboard changed
copy.bytes; // how many
copy.refused; // 'empty' or 'too-large', else undefined
copy.truncated; // only ever true with { truncate: true }
```

It works over ssh, which is the whole reason to prefer it to shelling out to
`pbcopy` or `xclip`: the terminal holding the clipboard is the one in front of
the user, not the one the process is running on.

**There is no success to report, and `written` is named for what it can say.** A
terminal does not answer an OSC 52 — no reply, no second query that says whether
the first landed. Several refuse it by default; iTerm2's "Applications in
terminal may access clipboard" is **off** out of the box, and tmux needs `set -g
set-clipboard on` and may put the text in a tmux buffer rather than the system
one. So `written` means the bytes went out, and an app that reports "copied!" is
guessing. Tell the user what was sent and let them paste to find out.

Over `CLIPBOARD_LIMIT` it refuses rather than truncating, because half a block
copied silently is worse than a refusal — `{ truncate: true }` opts in and cuts
on grapheme boundaries. An empty string is refused for a sharper reason: an empty
OSC 52 payload _clears_ the clipboard on most terminals, and "copy nothing" is
not a request to throw away what the user copied an hour ago.

### `sigil/components`

Prompts, a spinner, a progress bar, and a table. Plain functions that render
strings into a live region — no virtual DOM and no reconciler, because the
render target is text: re-rendering a frame and diffing lines _is_ the diff.

#### Prompts

```js
import { text, multiline, password, confirm, select, multiselect } from '@ttylabs/sigil/components';

const name = await text({ message: 'Project name', default: 'my-app' });
const secret = await password({ message: 'Token' });
const ok = await confirm({ message: 'Continue?' });

const target = await select({
  message: 'Target',
  choices: ['esm', 'cjs', { label: 'Both', value: 'both', hint: 'slower' }],
});

const features = await multiselect({
  message: 'Features',
  choices: [{ label: 'TypeScript', selected: true }, { label: 'Tests' }],
  required: true,
});
```

`text()` takes `default`, `placeholder`, `mask`, and a `validate` that may be
async — return a string to reject the answer with that message. Editing keys
are the usual ones: arrows, Home/End, Ctrl-A/E/U, Backspace, Delete. A paste
arrives as one chunk and is read as the keys it carries, not just the first.

#### A multiline answer

```js
import { multiline } from '@ttylabs/sigil/components';

const notes = await multiline({
  message: 'Release notes',
  placeholder: 'what changed, and why',
  initial: process.env.EDITOR_DRAFT,
  rows: 10,
});
```

Enter inserts a newline, so **Ctrl-D is what submits** — `submit` names another
key, and the hint the field draws is generated from it so the two cannot
disagree. `{ meta: true, name: 'enter' }` is Alt-Enter, which is also what
Escape-then-Enter arrives as when the two are pressed in quick succession.

The field **soft wraps**: it wraps for display and the value keeps exactly the
breaks you typed, so a line too wide for the terminal is drawn over two rows and
comes back as one. Up and Down move between the rows on screen with a remembered
goal column, so Up-Up-Down comes back to the column it started in through a short
line. Home, End, Ctrl-A, Ctrl-E, Ctrl-U and Ctrl-K are the **logical line**,
which is what readline means by them; Ctrl-Home and Ctrl-End are the whole value.
Ctrl-Left, Ctrl-Right, Alt-B and Alt-F move by words and Ctrl-W and Alt-D delete
one, crossing a line break the way emacs does. Past `rows` the field scrolls and
keeps the caret visible.

> [!NOTE]
> A pasted block **keeps its line breaks here**, which is the deliberate inverse
> of `text()` — a one-line field flattens them, because obeying a break there is
> what makes a paste submit half an address. Keeping them is the entire point of
> having more than one line.

> [!IMPORTANT]
> A prompt **throws rather than hangs** when there is no terminal — in a
> pipeline, a CI job, or a `cron` entry. Waiting on a stdin that will never
> produce a keystroke is a hung build with no explanation, so `PromptError`
> names the question that went unanswered. `err.aborted` tells the two cases
> apart: `true` is Ctrl-C, `false` is nobody there to ask.

#### Spinner

```js
import { createSpinner } from '@ttylabs/sigil/components';

const spinner = createSpinner({ text: 'Resolving' }).start();

spinner.text = 'Compiling';
spinner.write('compiled foo.js'); // stays, above the spinner
spinner.succeed('Compiled 2 files');
```

`succeed`, `fail`, `warn`, and `info` each stop and leave one marked line.
`stop()` erases and leaves nothing.

#### Progress

```js
import { createProgress } from '@ttylabs/sigil/components';

const bar = createProgress({ text: 'Copying', total: files.length });

for (const file of files) {
  await copy(file);
  bar.tick();
}

bar.done('Copied');
```

The bar sizes itself to a third of the terminal, between 10 and 40 columns,
unless given a `barWidth`.

Both degrade the same way. Piped, there is nothing to animate, so a spinner
writes one line per **change** and a bar one line every `step` percent — not
one per tick:

```
Resolving
Compiling
compiled foo.js
✔ Compiled 2 files
Copying 0%
Copying 50%
Copying 100%
```

#### Table

```js
import { table } from '@ttylabs/sigil/components';

table(rows, {
  columns: [
    { header: 'File', key: 'file', maxWidth: 20 },
    { header: 'Size', key: 'size', align: 'right' },
  ],
});
```

```
File          Size
index.js    1.2 kB
日本語.js    48 kB
🙂emoji.js    3 kB
```

Every one of those lines is exactly 18 columns wide. Columns are sized and
padded with `stringWidth()`, so CJK text and emoji line up where counting
characters would not, and `maxWidth` truncates on grapheme clusters rather
than slicing a surrogate pair in half. No borders — a table in a build log
sits next to everything else that was printed, and rules around it are noise.

`sigil/components` also exports `decodeKeys()` and `renderBar()`, and the state
and the element tree behind each component -- `spinnerView()`, `progressView()`
and `tableView()`, with `spinnerState()` and `progressState()` driving the two
that animate -- so a component tree can use them directly rather than through
the imperative facade. Cutting a line to a width is
`truncate()` in [`sigil/wrap`](#sigilwrap); padding one is a declared width and
`text-align` on a `text` element.

### `sigil/canvas`

A cell-addressable drawing surface, and the diff that puts it on screen.

```js
import { createCanvas, palette, ATTR } from '@ttylabs/sigil/canvas';

const canvas = createCanvas({ width: 20, height: 1 });

canvas.paint((p) => {
  p.text(0, 0, 'Loading', { fg: palette(4), bg: -1, attrs: ATTR.bold });
});

process.stdout.write(canvas.present().output);
```

A canvas is a rect of cells plus a way to reconcile it with what the terminal is
already showing. It is deliberately **not** a rect plus a position: where the
rect sits is a backend's business — inline at the bottom of a scrolling log, or
the whole alternate screen — and nothing above the canvas should know which.
Every coordinate here is relative to the canvas's own top-left, and every
movement the diff emits is relative to where the cursor started.

#### The diff is the point

Redrawing every cell on every frame flickers locally and is unusable over ssh. A
terminal is the one display where the wire between the renderer and the screen is
narrow enough to be the bottleneck, so `present()` compares the frame you painted
against the frame before it and emits only what differs:

```js
canvas.paint((p) => p.text(0, 0, 'hello'));
canvas.present().output; // the first frame is always full: "hello" and the blanks after it

canvas.paint((p) => p.text(0, 0, 'hallo'));
canvas.present().output; // moves the cursor and writes "a"
```

Unchanged runs shorter than a cursor move are painted through rather than
skipped, because a move costs bytes too. A style is emitted only where it
changes, and the frame always ends by resetting — the next thing written is the
app's own output, and it did not ask to be coloured.

#### Cells and wide characters

A cell holds one grapheme cluster. A cluster two columns wide — most CJK, most
emoji — occupies its own cell and leaves a **continuation** in the next one, so
the grid stays addressable by column even where the text is not:

```js
import { CellBuffer, StyleTable } from '@ttylabs/sigil/canvas';

const styles = new StyleTable();
const buffer = new CellBuffer(10, 1);

buffer.put(0, 0, '漢', styles.intern({}));
buffer.charAt(0, 0); // '漢'
buffer.charAt(1, 0); // '' — the continuation
```

`Painter.text()` takes **plain text**, one row per call. A cell grid expresses
styling as a style per cell, so a string carrying its own escape sequences has
nowhere to put them — they are stripped rather than painted, because painting
them writes `[31m` on the screen as visible text.

A control character is refused rather than dropped. A newline has no cell, so
dropping it painted a wrapped paragraph as one concatenated line; the caller has
to say which row each line goes on.

Overwriting either half takes the other with it. Left alone, the survivor is
half a glyph and every column after it on that row is shifted. A zero-width
cluster — a lone combining mark — is refused rather than given a cell, since
`graphemes()` has already attached it to whatever it modifies.

#### Styles

A cell's style is a foreground, a background, and a bitmask of attributes.
Colours are one number whatever their kind, so any two compare with `===`:

| Builder         | What it is                                                |
| --------------- | --------------------------------------------------------- |
| `DEFAULT_COLOR` | the terminal's own, whatever the user set                 |
| `palette(n)`    | `0`–`7` basic, `8`–`15` bright, `16`–`255` the xterm cube |
| `rgb(r, g, b)`  | 24-bit                                                    |

Styles are interned: a cell holds an index into a `StyleTable` rather than an
object, because a grid repeats a handful of styles across thousands of cells and
the diff asks "same style?" once per cell.

Extended colours are emitted in the semicolon form (`38;2;255;128;0`), matching
`sigil/ansi`. That is the spelling every terminal that does 256 or 24-bit colour
accepts; the colon form the specification actually describes is implemented by a
strict subset.

Degrading a colour a terminal cannot show is not this module's job — what it is
handed is what it emits.

#### Reading a frame

`canvas.toString()` and `CellBuffer.toLines()` give the frame as plain text, with
no styling and with continuations contributing nothing — so a line reads the way
it renders. That is what snapshots want, and what makes a failing layout test
readable as a picture. `toString()` trims trailing blanks; `toLines()` does not,
for when the exact width matters.

#### Layers, masks, and transitions

A frame may have **layers** composited over it: a second grid plus where its
top-left sits relative to the canvas's, with an optional mask saying which of its
cells show. The screen position a canvas refuses to know is a backend's; a
layer's origin is canvas-relative, so it is a number the canvas may have.

```js
import { maskThreshold, wipeMask } from '@ttylabs/sigil/canvas';

const mask = wipeMask(canvas.width, canvas.height);
canvas.layers.push({ cells: canvas.snapshot(), mask, x: 0, y: 0 });

for (let frame = 30; frame >= 0; frame--) {
  mask.threshold = maskThreshold(frame / 30); // 1 reveals all of it, 0 none
  canvas.paint(drawTheNewState);
  process.stdout.write(canvas.present().output);
}
canvas.layers.length = 0;
```

`snapshot()` is the point. A dissolve can be faked in the `paint()` callback by
painting conditionally; what cannot is that a transition needs the **previous
screen's content**, and by the time anybody wants one the state that produced it
is gone. That snapshot is the only thing here a caller could not write for
themselves — the rest is `layers`, which is an ordinary array, and the last entry
is on top.

A mask is one byte per cell saying _when_ that cell shows, plus a threshold: a
cell is in when `values[i] <= threshold`. `dissolveMask()` is a shuffled even
ramp, `blueNoiseMask()` is the same ramp spread so no step of it clumps (and
costs about 8ms to generate at 80x24, once), `wipeMask()` is a hard edge, and
`irisMask()` is a circle opening out. Generate one **once** and ramp the
threshold; a per-frame random flickers. `maskThreshold()` is the arithmetic
between a fraction and a threshold, and it exists because both ends are off by
one.

A layer is live for as long as it is in `layers` — its style indices are swept
with the canvas's, so a buffer taken out and put back across a sweep holds
indices that moved. Leave it in with `threshold: -1`, which composites nothing. A
resize drops the stack, because a transition spanning one is undefined. And
`canvas.painter(cells)` is how a layer gets painted: a cell holds a style
_index_, so a grid painted through a table of its own means something else here.

Into a pipe the whole thing collapses to the end state, with no special case: a
backend with no terminal returns before `canvas.present()` -- `render()` does call
`backend.present()`, which is the method that writes the text and skips the diff
-- so there is nothing on screen
to snapshot, the layer composites nothing, and each frame of the ramp is the new
state.

#### What a backend owes it

Movement is relative, and downward movement never scrolls — so **every row of the
canvas has to exist below the cursor before `present()`'s output is written.** A
canvas rendered with the cursor on the last row of the screen paints all of its
rows onto that one line. `DiffResult` also reports `wrapPending`, set when the
last thing written was a row's final column and the terminal's deferred wrap is
armed; any cursor movement clears it, so only a backend that writes immediately
afterwards has to care.

### `sigil/input`

One thing owns stdin: a router that reads it, decodes it, and dispatches.
Components subscribe rather than attaching their own `data` listeners, because
two of those fight over the stream and neither can see what the other consumed.

```js
import { createInput } from '@ttylabs/sigil/input';

const input = createInput({ root: view.root });

input.bind((event) => {
  // every key, ahead of the tree
  if (event.key.ctrl && event.key.name === 'c') quit();
});

input.onPaste((text) => insert(text)); // a bracketed paste, arriving whole
input.onResize(({ width, height }) => redraw());
input.stop(); // puts back only what it turned on
```

A key reaches the bindings, then the focused element, then its ancestors, then
the default action. Bindings come first so that quitting always works — an app
that cannot be quit because a focused text input swallowed Ctrl-C is the failure
that ordering prevents. **Tab is last**, so a component that wants Tab keeps it
by stopping the event rather than by asking to be left out of the focus ring.

A router refuses to exist where stdin is not a terminal. It exists to read keys,
so one that never can is a bug in the app rather than a state to carry through
every dispatch as a branch.

#### The mouse

Opt in, per router. Nothing is reported until you ask for it.

```js
const input = createInput({
  root: view.root,
  mouse: { surface: view.backend, motion: true },
});

input.onMouse((event) => {
  // everything the tree did not claim
  event.kind; // click mousedown mouseup mousemove wheel mouseenter mouseleave
  event.x; // the canvas's own cells, not the screen's
  event.y;
  event.button; // left middle right extra1..4, or undefined
  event.wheel; // up down left right, on a wheel event
  event.target; // the element hit, if any
  event.stop(); // a stopped mousedown suppresses click-to-focus
});
```

`surface` is the canvas backend, because translating a report is the backend's
job: a report is absolute and a canvas is relative to its own top-left. Full
screen is free — the alternate buffer starts at the origin — while an inline
canvas has to learn which screen row it begins on, which costs one cursor report
and is re-learnt whenever the anchor is thrown away by a resize or a write above
the region.

Only the SGR encoding (`1006`) is read. The legacy one writes a coordinate as a
single byte, so it runs out at column 223 — an ordinary width on a wide monitor —
and there is no reason to accept an encoding that cannot describe the screen it
is reporting about. A terminal too old for SGR reports nothing rather than
reporting the left two thirds of itself.

`motion: true` is xterm's `1003`, which reports **every cell the pointer crosses**
for as long as the app runs, over what may be an ssh link. That is what `:hover`,
`mouseenter` and `mouseleave` cost. Without it they match nothing — which is what
they did before there was a mouse at all, so no stylesheet changes meaning by
turning tracking on.

A press captures the pointer, so a drag that wanders off the region still reaches
whatever it started on. The consequence is that `x` and `y` may be outside the
canvas on a captured event, exactly as `clientX` is during a drag in a browser.

#### Turning the mouse on takes text selection away

This is the cost to know about before reaching for any of the above, and it is
not a bug in sigil or in the terminal.

Normally _the terminal_ does the selecting. You drag, it highlights characters,
it remembers which ones, and the system copy shortcut copies them; the program
running inside is not involved and does not even know you dragged. The moment an
app enables mouse reporting, the terminal stops interpreting the mouse and
forwards it to the app instead — so it has no selection of its own, and **the
user's usual copy shortcut stops working.**

Most terminals let the user override that by holding a modifier while dragging,
but which modifier is the terminal's own choice and is nothing an app can detect
or influence: shift in xterm and most of what followed it, and **alt/option in
iTerm2, where shift does nothing at all.**

The system shortcut itself cannot be made to work, and it is worth knowing why
rather than looking for the option. Cmd-C on macOS, and Ctrl-Shift-C in many
Linux terminals, is a menu command belonging to the terminal application: it is
consumed before anything is sent to the program, and there is no byte sequence
for it that a terminal program can receive. There is nothing for sigil to decode,
so nothing it could offer to handle.

So an app that turns tracking on owes the user a way to copy, which is
`enableSelection()`, exported from `@ttylabs/sigil/renderer`:

```js
import { enableSelection } from '@ttylabs/sigil/renderer';

const selection = enableSelection(view, input);

// there is no default binding for copy -- pick one and call copy()
input.bind((event) => {
  if (event.key.ctrl && event.key.name === 'y') {
    event.stop();
    const copy = selection.copy(); // OSC 52, so it works over ssh
    status(copy.written ? `sent ${copy.bytes} bytes` : `refused: ${copy.refused}`);
  }
});
```

Drag to select. Alt-drag selects a rectangle, which is what copies one pane of a
two-column layout without the other. Shift and an arrow key extend a selection
while nothing is focused. A `text` element is selectable by default and a `raw`
one is not, so a sparkline's block characters stay out of the clipboard — the
`selectable` prop overrides either, and it inherits.

Four things about it that are decisions rather than gaps:

- **The selection is over the painted grid, not over the element tree.** The grid
  is what the user is pointing at, it handles wide characters because the cell
  grid already does, and a flexbox tree has no reading order to walk — a
  `row-reverse` of three texts has no answer, and neither does an absolutely
  positioned overlay lying across a paragraph. The cost is that a wrapped
  paragraph copies with its wrap points in it, which is what selecting from a
  terminal has always given you.
- **There is no default binding for copy.** Ctrl-C is the abort and the binding
  order above exists so that an app cannot become unquittable; Ctrl-Shift-C
  reaches a terminal as that same byte. Claiming either would be claiming a key
  the framework cannot hear or one it must not take, so you bind what suits your
  app — the demo uses Ctrl-Y, which keeps vi's yank mnemonic and is a chord a
  text field cannot swallow.
- **The block modifier defaults to `alt`**, which is what Windows Terminal and
  iTerm2 both use for a rectangular selection. In iTerm2 alt is _also_ the
  mouse-reporting override, so an alt-drag there never reaches the app and the
  user gets the terminal's own selection instead — which is the thing they were
  reaching for, so it is left alone. `block: 'ctrl'` is xterm's spelling, for an
  app that wants the block mode reachable everywhere.
- **Nothing is drawn at colour level 0, and the selection still copies.** The
  highlight is reverse video, and at level 0 every attribute is dropped — so a
  piped or `NO_COLOR` run shows no highlight while `copy()` returns the same
  text. The gesture is not the drawing.

### `sigil/style`

The property set: every property a terminal can express, what it starts as, and
whether it inherits.

```js
import { declare, PROPERTIES } from '@ttylabs/sigil/style';

const style = declare({ padding: '1 2', color: 'red', 'flex-grow': '1' });
style.paddingLeft; // 2
style.flexGrow; // 1

PROPERTIES.color.inherits; // true
PROPERTIES.width.initial; // { type: 'auto' }
```

This is the table the rest of the style system reads — the cascade, the layout
engine, invalidation, and animation all ask it rather than keeping lists of
their own, so a property is added in one place.

#### What is in, and what a terminal cannot have

Watering CSS down means dropping what a grid of character cells cannot express,
not dropping the model. Out permanently: `font-family` and `font-size` (the cell
size is the user's, set in their terminal, and not ours to ask about),
`border-radius`, `box-shadow`, transforms, and any fractional length.

The nearest analogues survive under their own names. Weight is `bold`, and its
opposite is `dim` — a terminal attribute rather than a point on an axis, which is
why `font-weight: 600` is an error and `font-weight: bold` is not.

In: the flex properties, the box model, `position`/`top`/`right`/`bottom`/`left`/
`z-index`/`overflow`, and the text properties. Plus one that is terminal-shaped
rather than CSS-shaped — `border-style` names a box-drawing set (`single`,
`double`, `round`, `bold`, `ascii`) rather than a rendering mode, because which
characters to draw with is the only question a terminal border has.

`position` takes `static` and `relative`, and `absolute` is an error rather than
a keyword that parses and lays out in flow anyway. A `relative` box is offset by
its insets from where the flow put it, without moving anything else; the insets
are read nowhere else, which is CSS and is why `position` starts at `static`.

#### One unit, and it is a cell

```js
parseLength('3'); // three cells — a bare number needs no unit
parseLength('4ch'); // the same, for people used to writing it
parseLength('50%'); // a share of the parent
parseLength('auto');
parseLength('1.5'); // throws: a terminal cannot draw half a cell
```

A fractional length is refused rather than rounded. Rounding silently is how a
layout ends up a column out with nobody able to say which declaration did it.

#### Colours

```js
parseColor('red'); // palette index 1
parseColor('#ff8800'); // 24-bit
parseColor('rgb(255, 136, 0)');
parseColor('ansi(208)');
parseColor('default'); // the terminal's own
```

A named colour stays a **palette index** rather than becoming an RGB value: the
basic sixteen are whatever the user's terminal theme says they are, and resolving
`red` to a specific RGB overrides a choice they already made.

#### Inheritance

The CSS rule, because it is the one people already know: text properties inherit,
box and layout properties do not.

```js
const parent = declare({ color: 'red', padding: '4' });
const child = declare({}, parent);

child.color; // red — inherited
child.paddingTop; // 0 — a box is not
```

Setting `color` on a container and having the text inside pick it up is the
single most common thing anyone wants, and it is most of why a cascade beats
styling through props.

#### Shorthands

`padding`, `margin`, `inset`, `gap`, `border`, `flex`, and `flex-flow`, filled
the way CSS fills them — one value for every edge, two for vertical then
horizontal, three leaving the left to match the right.

```js
declare({ padding: '1 2' }).paddingLeft; // 2
declare({ flex: '1' }); // grow 1, shrink 1, basis 0 — as in CSS
declare({ border: 'red' }).borderStyle; // 'single'
```

That last one is the one deliberate divergence: in CSS a `border-color` with no
style draws nothing, which surprises everyone. Here a border given only a colour
is still a border.

A bad value inside a shorthand is reported against the longhand that could not
take it — `padding: 1 nonsense` fails at `padding-right`, which is more use than
saying the shorthand failed.

`transition` and `animation` are shorthands too, and they are the one place a
time needs its unit — see below.

#### Transitions and animations

A terminal is a frame loop, so CSS animation works here. A `transition` animates
a style change caused by anything at all — a class, a theme, a resize, a
`:focus` that just matched — and `@keyframes` plus `animation` runs a named
sequence.

```css
.bar {
  width: 4;
  transition: width 300ms ease-out;
}
.bar.wide {
  width: 30;
}

@keyframes march {
  from {
    left: 0;
  }
  to {
    left: 20;
  }
}
.runner {
  position: relative;
  animation: march 1600ms ease-in-out infinite alternate;
}
```

Nothing in the component changes: adding `wide` is an ordinary class write and
the frame loop does the rest.

**Geometry interpolates in whole cells.** A bar going from 4 to 30 columns has
twenty-seven visible states however long it takes, so the timing function decides
which frames land on which integer — and the frame loop does not wake for a frame
that would paint what is already on screen.

**Colours interpolate in Oklab**, which keeps the perceived lightness two
endpoints average to rather than dipping dark in the middle. Only two 24-bit
colours interpolate: a palette colour is whatever the user's terminal theme says
it is, so there is no honest path between two of them and the value snaps at the
midpoint — which is what CSS does with anything it cannot interpolate. So do
`bold`, `border-style` and `display`.

**A time carries its unit in a shorthand** and may leave it off in a longhand,
because a bare number in `animation` is CSS's iteration count:

```js
declare({ transition: 'width 300ms linear' });
declare({ 'transition-duration': '300' }); // milliseconds, like every time here
declare({ animation: 'march 1s linear 0s infinite alternate' });
```

The timing functions are `linear`, `ease`, `ease-in`, `ease-out`, `ease-in-out`,
`step-start`, `step-end`, `steps(n, position)` and `cubic-bezier(a, b, c, d)` —
whose y coordinates must stay in `[0, 1]`, because an overshoot resolves to a
value no declaration could have written.

One transition and one animation per element: `transition-property` takes a list,
so several properties at one duration is `transition-property: width, height`,
and a comma-separated list of whole transitions is refused rather than read as
its first entry.

#### Nothing moves where there is nothing to move on

`@media (prefers-reduced-motion: reduce)` is an ordinary media query, and the
answer comes from `RenderOptions.reducedMotion`, then `SIGIL_REDUCED_MOTION`,
then whether there is a terminal at all. A pipe, a file and a CI log have no
frames, so every animation there collapses to the state it would have ended on
rather than writing a line per tick.

```sh
SIGIL_REDUCED_MOTION=1 mycli    # or just: mycli | cat
```

`Renderer.animating` says whether anything is in flight. There is no `onfinish`
yet.

### `sigil/themes`

Themes sigil ships, as the CSS an app hands to `themedCascade({ theme })`.

```js
import { themedCascade } from '@ttylabs/sigil/theme';
import { VIOLET } from '@ttylabs/sigil/themes';

const cascade = themedCascade({ theme: VIOLET });
```

| Theme      | What it is                                                 |
| ---------- | ---------------------------------------------------------- |
| `MONO`     | No colour at all — the seven roles told apart by attribute |
| `VIOLET`   | Magenta where the defaults are cyan                        |
| `PHOSPHOR` | Green on black, the way a monochrome monitor did it        |
| `AMBER`    | Yellow and red, for a surface that reads warm              |
| `NEON`     | Magenta and cyan, for a build log that reads at a glance   |

Each is a value for every one of the seven roles — `.sigil-accent`,
`.sigil-muted`, `.sigil-heading`, `.sigil-success`, `.sigil-error`, `.sigil-warn`,
`.sigil-info` — which is the whole of what the role layer is for: seven
declarations restyle a surface wearing a dozen component classes.

**Each colour theme carries two palettes.** The basic sixteen first, then a richer
set inside `@media (min-color-level: 2)`, written per scheme. So a 16-colour
terminal gets the user's own palette, a 256-colour one gets the shade the theme
actually wanted, and a light background gets a value picked for white — with no
`if` anywhere in your app, because the cascade already answers all three questions.

`MONO` is the one without a second palette, and that is what it is: it names no
colour at all, so there is no shade for a richer terminal to improve on. Its own
`@media (prefers-color-scheme: light)` half is about `dim` rather than about a
palette, for the reason the framework sheet's is.

That is why there is no `VIOLET_256` beside `VIOLET`. A pair of exports makes the
app choose, which means reading `ansi.level` and the scheme at startup and getting
it wrong on a terminal it did not anticipate; one theme carrying both cannot be
chosen wrongly, and the two halves are one string so it costs nothing extra to
ship.

**Import them by name.** They are separate exports of their own subpath so that a
bundler drops the ones you did not take, which is measured rather than hoped for:
an app importing `VIOLET` alone bundles `VIOLET` and shakes the rest out.
The subpath is separate from `sigil/theme` for the other half of the same reason —
`theme` is on the path of every app that draws a built-in, and these are not.

There is deliberately **no map of them**, because an enumeration references every
theme and so nothing is unreachable: with one, the same app bundled every one. An
app offering a `--theme` option writes its own map of the themes it chose to
offer, which is the honest version anyway.

**Every colour in the base half is a palette index rather than a hex value**, and
that is what makes a shipped theme safe on a background it cannot see. The tension is
arithmetic: a colour bright enough to read on black is usually too light to read
on white, and measured with WCAG contrast against both `#000` and `#fff`, every
truecolor palette anybody reaches for has entries below 3:1 on one side. An index
delegates the choice to the only actor that knows the background — the user's own
terminal theme. The richer half may name a value precisely _because_ it is written
per scheme — it knows which background it is for.

Your own theme may use truecolor freely, since it knows its audience. What it owes
in exchange is a `@media (prefers-color-scheme: light)` half, because a hex value
picked against one background is a bet on that background. `dim` is the same
question: SGR 2 blends the foreground _towards_ the background, so it is grey on
black one way and grey on white the other. `MONO` is the only theme here that uses
it, and it carries that half.

Switching at runtime **adds** a sheet rather than replacing one, because a
`Cascade` has `add` and no `remove` — so a property the new theme does not mention
keeps whatever the last one said. An app picking one theme at startup never meets
this; a theme _switcher_ prepends a rule turning every role's properties off, which
is what `demos/style/04-theme-switcher.js` does and why.

### `sigil/signals`

The reactive core, shaped like the [TC39 Signals proposal][signals] (stage 1)
rather than invented here — so `Signal.State` and `Signal.Computed` can be
swapped for the native ones when they land, and anyone who has used signals
anywhere already knows them. `effect()`, `flush()`, and the scheduler are sigil's
own: the proposal deliberately leaves scheduling out.

```js
import { Signal, effect } from '@ttylabs/sigil/signals';

const count = new Signal.State(0);
const doubled = new Signal.Computed(() => count.get() * 2);

const stop = effect(() => console.log(doubled.get())); // logs 0 now
count.set(21); // logs 42 on the next microtask
stop();
```

[signals]: https://github.com/tc39/proposal-signals

A `State` is a cell you write. A `Computed` derives from whatever it reads, and
is **lazy** — it does not run until something reads it, and a computed nobody
reads never runs however often its inputs change. Dependencies are recorded on
every run, so a branch that stops reading a signal stops depending on it.

An `effect()` runs immediately and again whenever something it read changed. It
**may write signals** — reacting to a change by setting something else is most
of what an effect is for — and a flush keeps draining until nothing is left
dirty, so an effect that another effect's write dirtied still settles in the same
pass.

It may return a cleanup, which runs before each re-run and once more on dispose:

```js
const stop = effect(() => {
  const off = terminal.onResize(redraw);
  return off;
});
```

Writes are coalesced: a burst settles into one run, on a microtask by default.
`setScheduler()` replaces that — the renderer hands it the frame loop, because a
terminal cannot absorb a repaint per microtask.

```js
import { setScheduler, flush } from '@ttylabs/sigil/signals';

const previous = setScheduler((run) => setTimeout(run, 16));
flush(); // or drive it by hand
setScheduler(previous);
```

Coalescing is about how many times an effect runs, not whether it runs: a signal
written to `1` and back to `0` before the flush re-runs its effects once, with
the value it settled on.

An effect created inside another effect's body belongs to it, and is disposed
when the parent re-runs or is disposed. That is what keeps a component from
leaking an effect per render.

An error thrown by an effect goes to `setErrorHandler()` rather than out of the
flush. Under the default scheduler a rethrow would land in a microtask nobody
catches, which kills the process with a raw stack and skips every bit of error
handling the framework has. The default handler writes the message and sets the
exit code; the renderer replaces it with the real one.

`createEffects()` gives an independent scope — its own watcher, scheduler, queue,
and error handler — for when one global is not enough: two canvases with
different frame loops, or a test that wants isolation.

#### `Signal.subtle`

The sharp edges, under the name the proposal gives them. Reaching for one is a
signal in itself — ordinary code wants `State`, `Computed`, and `effect()`.

| Export                        | What it is                                                                 |
| ----------------------------- | -------------------------------------------------------------------------- |
| `Watcher`                     | Notified that a watched signal may have changed. Never what to do about it |
| `untrack(fn)`                 | Runs `fn` without recording what it reads                                  |
| `currentComputed()`           | The `Computed` being evaluated, if any                                     |
| `watched` / `unwatched`       | Option keys, called when a signal becomes live and stops being             |
| `introspectSources` / `Sinks` | What a node reads, and what reads it                                       |
| `hasSources` / `hasSinks`     | The same questions, answered cheaply                                       |

`watched` and `unwatched` are about being **observed**, not about being read: a
signal read only by a computed that nothing watches is not live, and its
`watched` never fires. That is what makes them the right place to subscribe to
something external — a `SIGWINCH` handler, a file watcher — since the
subscription then lasts exactly as long as something is actually rendering.

A `Watcher` fires at most once until `watch()` is called again, which is what
turns a burst of writes into one notification. The holder schedules, drains with
`getPending()`, and re-arms — which is all `effect()` is.

```js
const w = new Signal.subtle.Watcher(() => queueMicrotask(run));
w.watch(someComputed);

function run() {
  for (const pending of w.getPending()) pending.get();
  w.watch(); // re-arm
}
```

#### What it refuses

A `Computed` may not write a signal, may not read itself, and a `Watcher`'s
notify callback may not touch the graph at all. Each throws rather than being
merely discouraged: all three make the result depend on evaluation order, and
laziness is exactly what makes evaluation order unpredictable.

An **effect** is exempt from the first of those. A derivation has an answer and a
write would make that answer depend on who read it first; an effect has no
answer. `untrack()` is not the escape hatch here — it hides a read, not a write.

An effect may not be `async`. Tracking stops at the first `await`, so nothing
read after it would be a dependency, and the returned promise would be stored as
the cleanup and called on the next run. It throws rather than failing a run
later.

An error thrown by a `Computed` is cached the way a value is, rethrown on every
read until something it depends on changes.

### `sigil/paths`

XDG base directories, per-platform, with `~` expanded.

```js
import {
  cache,
  configHome,
  data,
  state,
  home,
  tmp,
  configDirs,
  dataDirs,
  expand,
} from '@ttylabs/sigil/paths';

cache(); // '/Users/you/Library/Caches'   (darwin)
cache('mycli'); // '/Users/you/Library/Caches/mycli'
configHome(); // '/Users/you/Library/Preferences'
data(); // '/Users/you/Library/Application Support'
configDirs(); // search path, XDG_CONFIG_DIRS included
expand('~/x'); // '/Users/you/x'
```

`XDG_*_HOME` and `XDG_*_DIRS` are honored everywhere. Linux and Windows get
their own tables; other platforms follow the Linux ones.

`configHome()` reads `XDG_CONFIG_HOME` and `configDirs()` reads
`XDG_CONFIG_DIRS`, so each is named for its own variable. It was called
`config()`, which collided in prose with [`sigil/config`](#sigilconfig) — two
things called the same word, one of which is a directory and the other a layered
merge.

### `sigil/config`

`createConfig()`, `createConfigSync()`, the stores and the `ConfigStore`
interface — one merged view over an ordered stack of layers. See
[Config files](#config-files) for the whole of it.

The whole surface, since an exported type is API an app can write into its own
signatures: `createConfig`, `createConfigSync`, `Config`, `isWritableStore`,
`object`, `json`, and the types `ConfigOptions`, `ConfigLayer`,
`ConfigLayerInfo`, `ConfigSchema`, `ConfigSetting`, `ConfigMerge`,
`ConfigDocument`, `ConfigStore`, `WritableConfigStore`, `WriteOptions`,
`WatchOptions`, `WatchSource`, `ConfigChange`, `ConfigChangeHandler`,
`ConfigPathHandler` and `Loss`.

Plus the **store kit** — `writeAtomic`, `writeAtomicSync`, `isMissing`,
`overlay`, `segments` and `isPlainObject` — which is what a store somebody else
wrote needs in order to be _correct_ rather than merely to compile. Each was
deliberately unpublished until something outside asked, and
[`@ttylabs/config-xml`](https://github.com/cb1kenobi/sigil/tree/main/packages/config-xml)
is that caller. What they share is that a sibling reimplementing one would not
merely duplicate it, it would **disagree**: `writeAtomic` is the temp-plus-rename
with the mode, the owner, the symlink chain and the five flush failures it
swallows, `isMissing` is `ENOENT` and nothing else, `overlay` is the whole of
`WriteOptions.paths`, `segments` carries the prototype-pollution guard, and
`isPlainObject` is where the boundary between structure and a leaf is. Every one
of those is a recorded review finding, and it costs 102 bytes, because `json()`
already uses four of the six and what is added is the export statements.

```js
import { createConfigSync, json, object } from '@ttylabs/sigil/config';
```

It imports no parser module at all, which makes it usable from an app that does
not use sigil's parser. The subpath is about 37 kB over seven modules — `paths`,
the type coercion, i18n, the debug logger, the environment-variable rule the
parser shares, the directory creation the update cache shares, and the module
itself — which is a module rather than anything like `sigil/components`.

### `sigil/testing`

`runCommand()`, `runOnTerminal()`, `createTestTerminal()`, `KEYS` and `Screen` —
see **[Testing](#testing)** above, which is where the argument for each of them
is. Listed here so that this section is the whole catalogue of subpaths rather
than most of it.

### `sigil/which`

Resolves an executable name against `PATH`, the way the `which` command does.

```js
import { which, whichAll, whichAllSync, whichSync } from '@ttylabs/sigil/which';

await which('pnpm'); // '/opt/homebrew/bin/pnpm', or undefined
whichSync('pnpm'); // the same, without the await
await whichAll('node'); // every match, in PATH order
await which('./build.sh'); // a path resolves directly rather than searching
```

`undefined` rather than a throw, because the ordinary use is "is this
installed". On Windows the name is tried against each `PATHEXT` extension in
order, a name that already carries one is tried as-is first, and the working
directory is searched ahead of `PATH`. On POSIX a match has to be a file the
process may actually execute, so a directory of the right name is not one.

Pass `path`, `pathExt` or `cwd` to ask about somewhere other than the
environment.

### `sigil/updates`

Checks npm for a newer version in a spawned worker, so the check never blocks
the CLI.

```js
import { check } from '@ttylabs/sigil/updates';

const { current, latest } = await check({
  packageName: 'mycli',
  packageVersion: '1.2.3',
  cacheDir: cache('mycli'),
  // wait: true,          // await the worker instead of firing and forgetting
  // checkInterval: 864e5,
  // distTag: 'latest',
});
```

By default it returns immediately with whatever the cache already had and lets
the worker refresh it for next time.

---

## License

MIT
