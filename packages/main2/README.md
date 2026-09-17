# main2

A framework for building CLI apps in Node.js.

At its heart is a multi-pass hierarchical argument parser built for CLIs that
lean heavily on subcommands, with **zero production dependencies**. ANSI
handling, text wrapping, display width, and XDG paths.

```js
import { main2 } from 'main2';

await main2({
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

`main2()` reads `process.argv`, matches a command, validates, and runs it. An
error becomes a message on stderr and a non-zero exit code — never a stack
trace, because the caller is a bin script.

**[docs/parser.md](docs/parser.md)** is the full parser reference: syntax,
semantics, precedence, and every place this parser deliberately differs from
Commander and yargs. This README is the API tour.

**[demos/](../../demos/)** is the same material as runnable files — one idea each,
plain JavaScript, with the commands worth trying at the top of every one.

---

## Contents

- [The root entry](#the-root-entry) — `main2()`, `command()`, `options()`, errors
- [Declaring options](#declaring-options)
- [Declaring arguments](#declaring-arguments)
- [Declaring commands](#declaring-commands)
- [Settings](#settings)
- [Hooks](#hooks)
- [Help](#help)
- [Typed argv](#typed-argv)
- [Subpath modules](#subpath-modules) — `ansi`, `wrap`, `width`, `help`, `terminal`, `components`, `signals`, `paths`, `updates`

---

## The root entry

```js
import {
  main2, // parse argv and run the matched command
  command, // identity function that types one command's argv
  options, // identity function that keeps an option group's types
  errorHandler, // the built-in error renderer + exit code
  renderError, // an error as the string that would be printed
  errorExitCode, // the exit code an error implies
} from 'main2';
```

Every type is exported from the same place — `Schema`, `Command`, `Option`,
`Argument`, `Settings`, `ParseState`, `DataType`, the hook types, and so on.

### `main2(opts)`

```ts
await main2({
  argv?: string[],      // defaults to process.argv.slice(2)
  schema?: Schema,
  settings?: Settings,
});
```

Resolves with the command's return value; with the `ParseState` when no command
ran or the command returned nothing; with `undefined` when an error was handled.

### `errorHandler`, `renderError`, `errorExitCode`

The built-in handler is what `main2()` uses unless you replace it. The pieces
are exported so you can use them from a `settings.errorHandler` of your own:

```js
import { renderError, errorExitCode } from 'main2';

await main2({
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
around `main2()`.

```js
try {
  await main2({
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
> `parse()` is internal — `main2()` is the entry point. The parse state is
> reachable from `main2()`'s return value and from every hook.

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
await main2({
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

A command can be a path to a module, a directory of them, or a package
directory. The module is not read until the command is matched.

```js
commands: {
  deploy: './commands/deploy.js',   // one module
}

commands: './commands'                // every module in a directory
```

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
| `hooks`                       | `init`, `parse`, `help`, `beforeError`                                           |
| `path`, `file`                | where to load the command from                                                   |
| `examples`                    | `{ label, text }` pairs for help                                                 |

---

## Settings

```js
await main2({ schema, settings: { allowExtraArguments: true } });
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
await main2({
  schema: {
    hooks: {
      beforeParse: [(state) => {}], // before argv is walked
      afterParse: [(state) => {}], // after, before validation results are returned
      beforeError: [(err, ctx) => {}],
    },
    commands: {
      build: {
        hooks: {
          init: [({ options, args, commands }) => {}], // when the command is built
          parse: [({ cmd, options }) => {}], // when argv matches it
          help: [({ sections, state }) => {}], // when its help is rendered
          beforeError: [(err, ctx) => {}],
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
  beforeError: [
    (err) => (err.code === 'ENOENT' ? new Error('Run `mycli init` first') : undefined),
  ],
}
```

---

## Help

`--help` and a `help` command are added to the root automatically, and only
where your app left room: declare `-h` as `--host` and you keep it, declare
`--help` yourself and you own it entirely. `schema.help: false` adds nothing.

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
import { command, options } from 'main2';

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

### `main2/ansi`

```js
import { ansi, createAnsi, strip, hasAnsi, supportsColor } from 'main2/ansi';

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

### `main2/wrap`

```js
import { wrap, terminalWidth, DEFAULT_WIDTH, MAX_WIDTH } from 'main2/wrap';

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

### `main2/width`

```js
import { stringWidth, graphemes, graphemeWidth, unicodeVersion } from 'main2/width';

stringWidth('日本語'); // 6  — East Asian Wide
stringWidth('á'); // 1  — combining mark
stringWidth('🇯🇵'); // 2  — regional indicator pair
stringWidth('👨‍👩‍👧‍👦'); // 2  — one ZWJ cluster
graphemes('á日🇯🇵'); // ['á', '日', '🇯🇵']
unicodeVersion; // '17.0.0'
```

### `main2/help`

```js
import { renderHelp, resolveHelp } from 'main2/help';

await resolveHelp(state); // fires the command's help hooks, then renders
renderHelp(state, { width: 100 }); // renders a context chain directly
```

`HelpOptions` takes `ansi`, `gap`, `indent`, `maxLabel`, `name`, `sections`,
and `width`.

### `main2/terminal`

Owns the terminal's global state: the streams, its size, the cursor, raw mode,
and putting all of it back however the process ends.

```js
import { terminal, createTerminal } from 'main2/terminal';

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
import { createLiveRegion } from 'main2/terminal';

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

### `main2/components`

Prompts, a spinner, a progress bar, and a table. Plain functions that render
strings into a live region — no virtual DOM and no reconciler, because the
render target is text: re-rendering a frame and diffing lines _is_ the diff.

#### Prompts

```js
import { text, password, confirm, select, multiselect } from 'main2/components';

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

> [!IMPORTANT]
> A prompt **throws rather than hangs** when there is no terminal — in a
> pipeline, a CI job, or a `cron` entry. Waiting on a stdin that will never
> produce a keystroke is a hung build with no explanation, so `PromptError`
> names the question that went unanswered. `err.aborted` tells the two cases
> apart: `true` is Ctrl-C, `false` is nobody there to ask.

#### Spinner

```js
import { createSpinner } from 'main2/components';

const spinner = createSpinner({ text: 'Resolving' }).start();

spinner.text = 'Compiling';
spinner.write('compiled foo.js'); // stays, above the spinner
spinner.succeed('Compiled 2 files');
```

`succeed`, `fail`, `warn`, and `info` each stop and leave one marked line.
`stop()` erases and leaves nothing.

#### Progress

```js
import { createProgress } from 'main2/components';

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
import { table } from 'main2/components';

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

`main2/components` also exports `decodeKeys()` and the `padCell()`,
`truncateCell()`, and `renderBar()` helpers the above are built from.

### `main2/signals`

The reactive core, shaped like the [TC39 Signals proposal][signals] (stage 1)
rather than invented here — so `Signal.State` and `Signal.Computed` can be
swapped for the native ones when they land, and anyone who has used signals
anywhere already knows them. `effect()`, `flush()`, and the scheduler are main2's
own: the proposal deliberately leaves scheduling out.

```js
import { Signal, effect } from 'main2/signals';

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
import { setScheduler, flush } from 'main2/signals';

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

### `main2/paths`

XDG base directories, per-platform, with `~` expanded.

```js
import { cache, config, data, state, home, tmp, configDirs, dataDirs, expand } from 'main2/paths';

cache(); // '/Users/you/Library/Caches'   (darwin)
cache('mycli'); // '/Users/you/Library/Caches/mycli'
config(); // '/Users/you/Library/Preferences'
data(); // '/Users/you/Library/Application Support'
configDirs(); // search path, XDG_CONFIG_DIRS included
expand('~/x'); // '/Users/you/x'
```

`XDG_*_HOME` and `XDG_*_DIRS` are honored everywhere. Linux and Windows get
their own tables; other platforms follow the Linux ones.

### `main2/updates`

Checks npm for a newer version in a spawned worker, so the check never blocks
the CLI.

```js
import { check } from 'main2/updates';

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
