# Migrating from cli-kit

sigil is the successor to [cli-kit](https://www.npmjs.com/package/cli-kit). The
model is the same: commands nest, each command is a context with its own
options and arguments, and an option declared on a parent is visible to every
command below it. Most of an app's declarations carry over unchanged. What
changes is how the app is started, what a command's handler receives, how hooks
are written, and a handful of parsing rules that sigil makes stricter.

This guide was written against **cli-kit 3.0.0**, its last release. The cli-kit
snippets come from its README and source; they were not run. Every sigil snippet
was run against sigil's own build. The complete programs (the blocks that start
with a file name) and their terminal output are checked by
`packages/cli/test/guides.test.ts`.

If you are starting fresh rather than porting, read
[Getting started](getting-started.md) first. It covers the project layout that
`sigil new` generates, which is the easiest place to move existing commands
into.

## At a glance

| cli-kit                                         | sigil                                                                    |
| ----------------------------------------------- | ------------------------------------------------------------------------ |
| `new CLI({ ... }).exec()`                       | `main({ schema: { ... } })`                                              |
| `action({ argv, _ })`                           | `run({ argv, _ })`                                                       |
| `aliases: ['ls']`                               | `'list, ls'` as the key, or `alias: ['ls']`                              |
| `defaultCommand: 'list'`                        | `default: true` on the `list` command                                    |
| `defaultCommand: fn`                            | `run` on the schema itself                                               |
| `cli.on('exec', ...)` and other hook events     | `hooks: { afterRun() {} }`: one function per hook                        |
| `type: 'positiveInt'`, `min`, `max`, a RegExp   | `type: 'int'` plus a `transform` that throws                             |
| `options: ['Group', { ... }]`                   | `group: 'Group'` on each option                                          |
| `help: { header, footer }`                      | `help` on a command: a string, or a function given the generated screen  |
| `version: '1.2.3'`                              | `version: '1.2.3'` on the schema, or nothing: `sigil build` reads it     |
| `chalk`, `ansi`                                 | `@ttylabs/sigil/ansi`                                                    |
| `Terminal`                                      | `@ttylabs/sigil/terminal`                                                |
| cli-kit's dependencies, installed with your CLI | none: `@ttylabs/sigil` has no dependencies, and `sigil build` bundles it |

## The entry point

cli-kit's README starts with this:

```js
// cli-kit 3.0.0
import CLI from 'cli-kit';

(async () => {
  const { argv, _ } = await new CLI({
    options: {
      '-f, --force': 'use the force',
      '--timeout [value]': {
        desc: 'the timeout duration',
        type: 'int',
      },
    },
  }).exec();

  console.log('options:', argv);
  console.log('args:', _);
})();
```

In sigil there is no class. The CLI is a plain object, the _schema_, and
`main()` runs it:

```js
// mycli.js
import { main } from '@ttylabs/sigil';

const state = await main({
  schema: {
    options: {
      '-f, --force': 'use the force',
      '--timeout [value]': {
        desc: 'the timeout duration',
        type: 'int',
      },
    },
  },
  settings: { allowUnexpectedArguments: true },
});

if (state) {
  console.log('options:', state.argv);
  console.log('args:', state._);
}
```

```console
$ node mycli.js --force --timeout 30 one two
options: { force: true, timeout: 30 }
args: [ 'one', 'two' ]
$ node mycli.js --timeout soon
Error: Invalid integer: soon
```

Two differences show up already:

- **A positional nothing declared is an error.** cli-kit put every positional
  into `_`. sigil reports `Unexpected argument "one"` unless
  `settings.allowUnexpectedArguments` is set. Declaring the arguments, as
  `args: ['[files...]']`, is usually better than setting it.
- **`main()` handles errors itself.** It prints the message to stderr, sets the
  exit code, and resolves with `undefined`, which is why the example checks
  `state`. It never rejects, unless you set `settings.errorHandler: false`.
  cli-kit's `exec()` printed the help screen with the error, and rethrew when
  help was turned off. sigil prints only the message, with a suggestion when
  one fits: `Unexpected argument "deplyo". Did you mean "deploy"?`.

`main()` resolves with what the command's `run` returned, or with the parse
state (`argv`, `_`, `cmd`, `contexts` and more) when no command ran or the
command returned nothing.

### Where the schema lives

A real app does not call `main()` from the module that declares its commands.
`sigil new` generates a `src/index.ts` that **exports** the schema, and a
`dev.ts` that imports it and calls `main()`. `sigil build` reads `src/index.ts`
without running it and generates the executable's own `main()` call. See
[Getting started](getting-started.md#what-you-got).

## Commands

cli-kit:

```js
// cli-kit 3.0.0
new CLI({
  name: 'mycli',
  defaultCommand: 'list',
  commands: {
    'list, ls': {
      desc: 'List things',
      action() {
        console.log('listing');
      },
    },
    remove: {
      aliases: ['rm', 'del'],
      args: ['<name>'],
      desc: 'Remove a thing',
      action({ argv }) {
        console.log(`removing ${argv.name}`);
      },
    },
  },
}).exec();
```

sigil:

```js
// mycli.js
import { main } from '@ttylabs/sigil';

await main({
  schema: {
    name: 'mycli',
    commands: {
      'list, ls': {
        default: true,
        desc: 'List things',
        run() {
          console.log('listing');
        },
      },
      remove: {
        alias: ['rm', 'del'],
        args: ['<name>'],
        desc: 'Remove a thing',
        run({ argv }) {
          console.log(`removing ${argv.name}`);
        },
      },
    },
  },
});
```

```console
$ node mycli.js
listing
$ node mycli.js rm db
removing db
$ node mycli.js --help
Usage: mycli [options] [command]

Commands:
  completion       Print a shell completion script
  help             Show help for a command
  list, ls         List things
  remove, rm, del  Remove a thing

Options:
  -h, --help   Show help for a command
  -q, --quiet  Suppress progress, not results
```

| cli-kit                                 | sigil                                                                                                                     |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `action`                                | `run`                                                                                                                     |
| `aliases`                               | `alias`, or extra names in the key: `'list, ls'`                                                                          |
| `'@ls, list'`                           | the same: a `@` label is an alias, and the first bare label is the name                                                   |
| `'list, !ls'` (a hidden alias)          | **not the same**: `!` on any label hides the whole command. Drop the `!`; every alias is listed in help                   |
| `hidden`                                | `hidden`                                                                                                                  |
| `'ls <dir>'` (arguments in the key)     | the same                                                                                                                  |
| `defaultCommand: 'name'`                | `default: true` on that command. Two siblings marked `default` is an error                                                |
| `defaultCommand: fn`                    | `run` on the schema. It runs when the command line names no command                                                       |
| `defaultCommand` left as `'help'`       | the same behaviour: an app that is all subcommands prints help when none is named                                         |
| `callback` on a command                 | `hooks.parse`, which fires when the command line matches the command                                                      |
| `commands: '/path/to/dir'`              | `commands: './commands'` with `baseDir: import.meta.dirname` on the schema                                                |
| a command module exporting `{ action }` | a module whose default export is a plain object with `run`                                                                |
| `title`                                 | no equivalent                                                                                                             |
| `extensions`                            | no equivalent for running another program. A command's path may name a package directory, and its `package.json` names it |

A directory of commands works the way cli-kit's did, with two additions: a
subdirectory is a command whose subcommands are the files in it, and an `index`
module is the directory's own command. See
[Lazy loading](../README.md#lazy-loading).

### What `run` receives

cli-kit passed `action` an object with `argv`, `_`, `cmd`, `contexts` and a
number of helpers. `run` receives the parse state. The first four have the
same names. The helpers have these replacements:

| cli-kit                        | sigil                                                                                   |
| ------------------------------ | --------------------------------------------------------------------------------------- |
| `argv`, `_`, `cmd`, `contexts` | the same names                                                                          |
| `console`, `terminal`          | `console` and `process.stdout`, or `createTerminal()` from `@ttylabs/sigil/terminal`    |
| `exitCode(2)`, `setExitCode`   | `process.exitCode = 2`, or throw an error with an `exitCode` property                   |
| `help()`                       | `await resolveHelp(state)` from `@ttylabs/sigil/help`, which returns the screen as text |
| `styles`                       | `ansi` from `@ttylabs/sigil/ansi`                                                       |
| `data` (passed to `exec()`)    | module scope, or a closure: `main()` takes no user data                                 |
| `result`                       | the return value of `run`, which `main()` resolves with                                 |

```js
import { resolveHelp } from '@ttylabs/sigil/help';

export default {
  desc: 'Print the help for this command',
  async run(state) {
    process.stdout.write(await resolveHelp(state));
  },
};
```

## Options

Format strings are the same: `-f, --force` is a flag, `--name [value]` takes an
optional value, `--name <value>` takes a value and makes the option required,
and `--no-color` is a negated flag. `desc`, `default`, `env`, `hidden`, `hint`,
`multiple` and `required` keep their meanings. Dashed names are camel-cased, as
they were by default in cli-kit; `--log-level` is `argv.logLevel`. sigil has no
setting to turn that off.

What changed is how values are read. This program shows each difference:

```js
// values.js
import { main } from '@ttylabs/sigil';

await main({
  schema: {
    name: 'values',
    args: ['[files...]'],
    options: {
      '--id [id]': 'An identifier',
      '--force': 'Overwrite what is there',
      '--host [name]': { default: 'localhost', env: 'APP_HOST' },
      '--tag [name]': { multiple: true },
    },
    run({ argv }) {
      console.log(argv);
    },
  },
});
```

**A string stays a string.** cli-kit turned an untyped option's value into a
number when it looked like one, so `--id 007` was `7`. In sigil the default type
is `string`, and you ask for a number with `type: 'int'` or `type: 'number'`:

```console
$ node values.js --id 007
{ id: '007', force: false, host: 'localhost' }
```

**A boolean is strict.** cli-kit read any value other than `false` as true, so
`--force=0` turned the flag on. sigil accepts `true`, `t`, `yes`, `y`, `on` and
`1` as true, and `false`, `f`, `no`, `n`, `off`, `0` and the empty string as
false. Anything else is an error:

```console
$ node values.js --force=0
{ force: false, host: 'localhost' }
$ node values.js --force=maybe
Error: Invalid boolean: "maybe"
```

**The command line beats the environment.** In cli-kit, a set `env` variable
overrode what was typed. In sigil the order is the command line, then `env`,
then `default`:

```console
$ APP_HOST=env.example.com node values.js
{ host: 'env.example.com', force: false }
$ APP_HOST=env.example.com node values.js --host cli.example.com
{ host: 'cli.example.com', force: false }
```

An environment variable set to the empty string counts as unset.

**An option takes one value each time it is used.** `multiple` collects
repeated uses into an array. A value that follows is never taken as a second
value, so `b` here is a positional argument:

```console
$ node values.js --tag a b --tag c
{ tag: [ 'a', 'c' ], files: [ 'b' ], force: false, host: 'localhost' }
```

**An option that takes a value must be given one.** This is true whether the
option is required or not. `[id]` means the option may be left out, not that its
value may:

```console
$ node values.js --id
Error: Missing value for option --id
```

`--id=` is how to pass an empty string on purpose.

**`<value>` still makes the option required.** This is the same as cli-kit. It
is worth knowing if you also read Commander or yargs documentation, because
both treat `<value>` as "takes a required value" without requiring the option.

### Option properties

| cli-kit                                                             | sigil                                                                           |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| `aliases: ['--colour']`                                             | `alias: ['--colour']`, or extra names in the format: `'--color, --colour'`      |
| `callback`                                                          | `transform(value, state)`: return the new value. It runs before type conversion |
| `min`, `max`                                                        | a `transform` that throws (below)                                               |
| `type: /regex/`, `errorMsg`                                         | a `transform` that tests the value and throws an `Error` with your message      |
| `type: 'positiveInt'`                                               | `type: 'int'` plus a `transform`                                                |
| `type: 'file'`                                                      | `type: 'string'`                                                                |
| `bool`, `count`, `date`, `int`, `json`, `number`, `string`, `yesno` | the same names                                                                  |
| an untyped value guessed as a number, date or JSON                  | `type: 'auto'`, which you have to ask for                                       |
| `order`                                                             | no equivalent                                                                   |
| `redact`, the `~` prefix                                            | no equivalent                                                                   |
| `options: ['Group', { ... }]`                                       | `group: 'Group'` on each option, which help prints under `Group options:`       |
| `camelCase: false`                                                  | no equivalent                                                                   |

A range check is a `transform`. It receives the value as it was typed, before
`type` converts it:

```js
// serve.js
import { main } from '@ttylabs/sigil';

await main({
  schema: {
    name: 'serve',
    options: {
      '--port [n]': {
        default: 8080,
        type: 'int',
        transform(value) {
          if (Number(value) < 1 || Number(value) > 65535) {
            throw new Error(`--port must be between 1 and 65535, not ${value}`);
          }
          return value;
        },
      },
    },
    run({ argv }) {
      console.log(`listening on ${argv.port}`);
    },
  },
});
```

```console
$ node serve.js
listening on 8080
$ node serve.js --port 3000
listening on 3000
$ node serve.js --port 0
Error: --port must be between 1 and 65535, not 0
$ node serve.js --port http
Error: Invalid integer: http
```

`transform` is applied to values from the command line only, so the default is
not checked.

## Arguments

The rules are the same as cli-kit's: a bare name or `[name]` is optional,
`<name>` is required, and `...` collects the rest into an array (`'files...'`
works without brackets). The object form takes `name`, `desc`, `type`,
`default`, `env`, `choices`, `multiple`, `required` and `transform`.

The differences:

- A positional that no argument declared is an error, as shown in
  [The entry point](#the-entry-point).
- `hidden`, `min`, `max`, a RegExp `type`, `callback` and the `~` prefix have no
  equivalent on an argument. Use `transform` for the checks.

## Undeclared options

Both produce values. `--foo` is `argv.foo === true` and `--foo bar` is
`argv.foo === 'bar'`. In sigil they never reach `_`, and cli-kit's
`treatUnknownOptionsAsArguments` has no equivalent.
`settings.allowUnknownOptions: false` makes an undeclared option an error.

## Help

| cli-kit                    | sigil                                                                                       |
| -------------------------- | ------------------------------------------------------------------------------------------- |
| `help: true` (the default) | always on: `--help`, `-h` and a `help` command                                              |
| `help: false`              | `help: false` on the schema                                                                 |
| `helpExitCode`             | `settings.helpExitCode`                                                                     |
| `help: { header, footer }` | `help` on a command: a string replaces the screen, a function gets `{ generated }`          |
| `helpTemplateFile`         | no template: a `help` function, or a `help` hook that adds sections                         |
| `showHelpOnError`          | no equivalent: an error prints its message only                                             |
| `version`                  | `version` on the schema, a string or a function; `sigil build` fills it from `package.json` |
| `colors`, `--no-color`     | no option: color follows `NO_COLOR`, `FORCE_COLOR` and whether output is a terminal         |
| `banner`, `--no-banner`    | no equivalent                                                                               |

A footer looks like this:

```js
export default {
  desc: 'Build the project',
  help: ({ generated }) => `${generated}\nDocs: https://example.com/build\n`,
  run() {},
};
```

The [Help](../README.md#help) section of the README and the
[help reference](parser.md#help) cover option groups, examples, and adding
sections for options a command describes but does not parse.

## Hooks

cli-kit's hooks were [hook-emitter](https://www.npmjs.com/package/hook-emitter)
events: `parse`, `finalize`, `exec`, `banner` and `generateHelp`. Any number of
listeners could be added to each. In sigil, hooks are declared in a `hooks`
object on the schema or on a command, and **each hook is one function**:

| cli-kit event  | sigil hook                                                                            |
| -------------- | ------------------------------------------------------------------------------------- |
| `parse`        | `beforeParse` on the schema                                                           |
| `finalize`     | `afterParse` on the schema: `state.argv` is filled in and not yet validated           |
| `exec`         | `afterRun`: fires after `run` returns or throws. It observes and cannot replace `run` |
| `generateHelp` | `help` on a command                                                                   |
| `banner`       | no equivalent                                                                         |
| (none)         | `beforeError`: replace an error before it is printed                                  |
| (none)         | `init`, `parse` and `subcommandLoaded` on a command                                   |

```js
// hooks.js
import { main } from '@ttylabs/sigil';
import { readFile } from 'node:fs/promises';

await main({
  schema: {
    name: 'mycli',
    hooks: {
      afterRun({ cmd, result }) {
        console.log(`${cmd.name} ${result.ok ? 'succeeded' : 'failed'}`);
      },
      beforeError(err) {
        if (err.code === 'ENOENT') {
          return new Error('No config found. Run `mycli init` first.');
        }
      },
    },
    commands: {
      show: {
        async run() {
          console.log(await readFile('mycli.json', 'utf-8'));
        },
      },
    },
  },
});
```

```console
$ node hooks.js show
show failed
Error: No config found. Run `mycli init` first.
```

`beforeError` can return a different error, but it cannot stop the error from
being reported. To make two things happen in one hook, call both from one
function. If code you do not control may have set a hook already, wrap it:

```js
const previous = cmd.hooks.parse;
cmd.hooks.parse = async (data) => {
  await previous?.(data);
  // ...and yours
};
```

Passing an array of functions, the way a list of listeners would be written, is
an error, for example `Expected "afterRun" hook to be a function`.

## Everything else

| cli-kit                | sigil                                                                                       |
| ---------------------- | ------------------------------------------------------------------------------------------- |
| `ansi.strip()`         | `strip()` from `@ttylabs/sigil/ansi`                                                        |
| `chalk`                | `ansi` from `@ttylabs/sigil/ansi`: `ansi.bold.red('error')`                                 |
| `Terminal`             | `createTerminal()` from `@ttylabs/sigil/terminal`                                           |
| `snooplogg`            | not exported. `DEBUG=sigil` prints sigil's own debug log                                    |
| `pluralize`            | `__n(n, '{0} file', '{0} files')` from `@ttylabs/sigil/i18n`                                |
| `types.registerType()` | no equivalent: `transform` on the option                                                    |
| `nodeVersion`          | `engines` in `package.json`. Nothing checks it at runtime                                   |
| `template`             | no equivalent for help. For drawing, see [`sigil/components`](../README.md#sigilcomponents) |

## A checklist

1. Scaffold a new app with `npx @ttylabs/cli new`, or add `@ttylabs/sigil` as a
   dependency.
2. Turn `new CLI({ ... })` into a schema object and call `main({ schema })`.
3. Rename `action` to `run` and `aliases` to `alias`. Remove the `!` from a
   hidden alias, because in sigil it hides the whole command.
4. Replace `defaultCommand` with `default: true` on that command, or with a `run`
   on the schema.
5. Add `type: 'int'` or `type: 'number'` to every option that should be a number.
6. Check every option with an `env` variable: the command line now wins.
7. Replace `min`, `max`, `positiveInt` and RegExp types with a `transform`.
8. Declare every positional argument, or set `allowUnexpectedArguments`.
9. Turn hook listeners into one function per hook.
10. Run `sigil check` and your tests.
