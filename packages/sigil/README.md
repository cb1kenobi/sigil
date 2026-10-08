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
- [Hooks](#hooks)
- [Help](#help)
- [Typed argv](#typed-argv)
- [Subpath modules](#subpath-modules) — `ansi`, `wrap`, `width`, `help`, `terminal`, `components`, `canvas`, `input`, `style`, `signals`, `paths`, `which`, `updates`

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
| `desc`                            | what help prints                                                                                        |
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
| `desc`                        | what help prints                                                                 |
| `args`, `options`, `commands` | as above                                                                         |
| `default`                     | dispatch when argv named no command                                              |
| `alias`                       | extra names that stay out of the help label                                      |
| `hidden`                      | keep it out of help                                                              |
| `help`                        | a string that replaces the screen, or a renderer that receives the generated one |
| `hooks`                       | `init`, `parse`, `help`, `beforeError`, `subcommandLoaded`                       |
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

---

## Hooks

```js
await main({
  schema: {
    hooks: {
      beforeParse: (state) => {}, // before argv is walked
      afterParse: (state) => {}, // `state.argv` is written, nothing is validated yet
      beforeError: (err, ctx) => {},
    },
    commands: {
      build: {
        hooks: {
          init: ({ options, args, commands }) => {}, // when the command is built
          parse: ({ cmd, options }) => {}, // when argv matches it
          help: ({ sections, state }) => {}, // when its help is rendered
          beforeError: (err, ctx) => {},
        },
        run() {},
      },
    },
  },
});
```

They fire in this order:

```
init (at build time) → beforeParse → parse (as each command matches) → afterParse → run
```

A hook changes a command through the registries it is handed —
`options.add(...)`, `args.push(initArg(...))`,
`commands.add(await initCommand(...))` — which take effect immediately.

### `beforeError`

Fires for every throw site, innermost command first and the schema last, before
the error is rendered. A hook may **replace** the error but never suppress it:
return nothing to leave it alone, return a value to make that value the error.

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
  config,
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
config(); // '/Users/you/Library/Preferences'
data(); // '/Users/you/Library/Application Support'
configDirs(); // search path, XDG_CONFIG_DIRS included
expand('~/x'); // '/Users/you/x'
```

`XDG_*_HOME` and `XDG_*_DIRS` are honored everywhere. Linux and Windows get
their own tables; other platforms follow the Linux ones.

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
