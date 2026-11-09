# Getting started

This guide builds a small CLI called `my-cli`, from an empty directory to a
bundled executable. It starts from what `sigil new` generates, adds two commands
of its own, tests them, and builds the result.

Nothing here is invented for the page. The source files are the ones a
scaffolded app runs, and the terminal output is what those files print.
`packages/cli/test/guides.test.ts` runs every `my-cli` command shown here against
the files shown here, so if sigil's behaviour changes, the test fails until this
page is updated.

You need Node.js 22.19.0 or newer. That version can run TypeScript directly, so
nothing is compiled while you develop.

## Create the app

`@ttylabs/cli` is the toolchain, and it provides the `sigil` command:

```sh install=cli location=getting-started
npx @ttylabs/cli new my-cli
```

It asks five things:

- Whether to use TypeScript. The default is yes, and `--lang ts` or `--lang js` answers
  it without asking.
- Whether the app has subcommands. The default is a `commands/` directory, and
  `--single` makes the app itself the command.
- Whether to include a full-screen app (TUI). The default is no, and `--tui`
  says yes. If you do, it also asks where to launch it from and which template
  syntax to write it in; see [Building a full-screen app](full-screen-apps.md).
- Which linter to set up: oxlint, eslint, biome, or none. `--linter` answers it.
- Which package manager to use. It only asks this when more than one is
  installed.

After writing the files, it runs `git init` and installs the dependencies.
`--no-git` and `--no-install` skip those steps, and `--yes` takes the defaults
for every question you did not answer with a flag. When it finishes, it prints
the next commands to run:

```console
$ npx @ttylabs/cli new my-cli --yes
...
Created my-cli in /home/you/my-cli.

  cd my-cli
  npm run dev -- --help
```

## What you got

```
my-cli/
  src/index.ts            the schema: the app's name, its options, and where its commands are
  src/commands/hello.ts   one command per file, named after the file
  dev.ts                  runs the app from source
  test/app.test.ts        tests that run the app through the real main()
  sigil.json              toolchain settings
  vitest.config.ts
  tsconfig.json
  package.json
```

It also writes a `README.md`, a `.gitignore`, the linter's config, and a GitHub
Actions workflow that builds release binaries when you push a tag.

`src/index.ts` holds the app's _schema_. With the generated comments removed,
it is this:

```ts
// src/index.ts
export default {
  name: 'my-cli',
  desc: 'What my-cli does',
  options: {
    '-v, --verbose': { desc: 'Say more', type: 'bool' },
  },
  baseDir: import.meta.dirname,
  commands: './commands',
};
```

- `commands: './commands'` makes every module in `src/commands/` a command
  named after its file. A subdirectory becomes a command with subcommands of
  its own. A module is not imported until the command line names it.
- `baseDir` is the directory that `'./commands'` is relative to. Without it,
  the path would be resolved from wherever the user ran the CLI.
- The module **exports** the schema and does not run it. `sigil build` reads
  this file without executing it, so anything the file _did_ would happen at
  build time.

Starting the app is `dev.ts`'s job:

```ts
// dev.ts
import schema from './src/index.ts';
import { main } from '@ttylabs/sigil';

await main({ schema });
```

`main()` reads `process.argv`, finds the command, checks what was passed, and
runs it. When something is wrong, it prints the message and sets the exit code
instead of throwing.

The generated command is a plain object:

```ts
// src/commands/hello.ts
export default {
  desc: 'Say hello',
  args: [{ name: '[who]', desc: 'Who to greet' }],

  run({ argv }: { argv: { who?: string } }) {
    process.stdout.write(`hello ${argv.who ?? 'world'}\n`);
  },
};
```

## Run it

`npm run dev -- <arguments>` runs the app from source. In the rest of this
guide, `my-cli` stands for that command (it is the same as `node dev.ts`).

```console
$ my-cli hello
hello world
$ my-cli hello Ada
hello Ada
$ my-cli --help
Usage: my-cli [options] <command>

What my-cli does

Commands:
  completion  Print a shell completion script
  hello
  help        Show help for a command

Options:
  -v, --verbose  Say more
  -h, --help     Show help for a command
  -q, --quiet    Suppress progress, not results
```

You did not write `--help`, `help`, `completion` or `--quiet`; every app gets
them. `hello` has no description in that list because its description is inside
its module, and listing the commands does not import every module. The built
app shows all of the descriptions (see [Build it](#build-it)). To show them from
source too, or to give a command an alias, describe the commands in a
`commands.json` in `src/commands/`; see
[A `commands.json`](./parser.md#a-commandsjson).

## Add a command

Create `src/commands/deploy.ts`:

```ts
// src/commands/deploy.ts
import { command } from '@ttylabs/sigil';

export default command({
  desc: 'Deploy a service',
  args: [{ name: '<service>', desc: 'What to deploy' }],
  options: {
    '-e, --env [name]': {
      choices: ['staging', 'production'],
      default: 'staging',
      desc: 'Where to deploy it',
    },
    '--retries [n]': {
      default: 3,
      desc: 'How many times to retry',
      env: 'DEPLOY_RETRIES',
      type: 'int',
    },
    '--dry-run': 'Say what would happen, and do nothing',
  },

  run({ argv }) {
    const verb = argv.dryRun ? 'Would deploy' : 'Deploying';
    process.stdout.write(`${verb} ${argv.service} to ${argv.env} (retries: ${argv.retries})\n`);
  },
});
```

The file name is the command name, so this is `my-cli deploy`. Nothing needs to
be registered.

```console
$ my-cli deploy api
Deploying api to staging (retries: 3)
$ my-cli deploy api -e production --dry-run
Would deploy api to production (retries: 3)
$ DEPLOY_RETRIES=5 my-cli deploy api
Deploying api to staging (retries: 5)
$ DEPLOY_RETRIES=5 my-cli deploy api --retries 1
Deploying api to staging (retries: 1)
```

What each piece of the declaration does:

- **`<service>`** is a required argument. `[name]` would make it optional, and
  so would a bare `name`.
- **`-e, --env [name]`** is an option that takes a value. The square brackets
  mean the option itself is optional. `choices` limits what it accepts, and
  `default` fills it in when it is not given.
- **`--retries [n]`** is converted to a number because of `type: 'int'`. It
  falls back to the `DEPLOY_RETRIES` environment variable, and then to the
  default. A value on the command line always wins, then the environment, then
  `default`.
- **`--dry-run`** takes no value, so it is a flag. It is `true` when given and
  `false` otherwise, never `undefined`. Its value is at `argv.dryRun`, because
  dashed names are camel-cased.
- **`command()`** changes nothing at runtime. It exists so that TypeScript can
  read the format strings: `argv.service` is a `string`, `argv.retries` is a
  `number`, and `argv.env` is `'staging' | 'production'`. Without it, a command
  is still a plain object, as `hello.ts` is.

The help screen comes from the same declaration:

```console
$ my-cli deploy --help
Usage: my-cli deploy [options] <service>

Deploy a service

Arguments:
  <service>  What to deploy

Options:
  -e, --env [name]  Where to deploy it (choices: staging, production) (default:
                    staging)
  --retries [n]     How many times to retry (default: 3)
  --dry-run         Say what would happen, and do nothing

Global options:
  -v, --verbose  Say more
  -h, --help     Show help for a command
  -q, --quiet    Suppress progress, not results
```

## When the input is wrong

None of these checks are written in `deploy.ts`. They all come from the
declaration:

```console
$ my-cli deploy
Error: Missing required arguments: <service>
$ my-cli deploy api --env prod
Error: Invalid value "prod" for option --env
$ my-cli deploy api --retries lots
Error: Invalid integer: lots
$ my-cli deplyo api
Error: Unexpected argument "deplyo". Did you mean "deploy"?
```

Each of these is written to stderr, the process exits with code 1, and no stack
trace is printed. A CLI's users need the message, not the stack.

## Options every command shares

`-v, --verbose` is declared on the schema, not on a command, and it still
appears under `Global options` in `deploy --help`. An option resolves across the
whole chain of commands, so a child command sees every option its parents
declared. Both `my-cli -v deploy api` and `my-cli deploy api -v` set
`argv.verbose`.

Because `deploy.ts` is typed by its own `command()` call, and that call does not
know where the command is mounted, the inherited `argv.verbose` is typed as
`unknown` there, even though it is a boolean at runtime.
[Typed argv](../README.md#typed-argv) shows how to share a group of options
with their types.

## Add subcommands

A directory is a command whose subcommands are the files inside it. An `index`
module is the directory's own command:

```ts
// src/commands/db/index.ts
export default {
  desc: 'Database tasks',
};
```

```ts
// src/commands/db/migrate.ts
import { command } from '@ttylabs/sigil';

export default command({
  desc: 'Run pending migrations',
  options: {
    '--to <version>': { desc: 'Stop at this version', type: 'int' },
  },

  run({ argv }) {
    if (argv.to < 1) {
      throw Object.assign(new Error(`There is no version ${argv.to}`), { exitCode: 2 });
    }
    process.stdout.write(`Migrating to version ${argv.to}\n`);
  },
});
```

```console
$ my-cli db migrate --to 7
Migrating to version 7
$ my-cli db migrate
Error: Missing required options: --to
$ my-cli db migrate --to 0
Error: There is no version 0
$ my-cli db
Usage: my-cli db [options] <command>

Database tasks

Commands:
  migrate

Global options:
  -v, --verbose  Say more
  -h, --help     Show help for a command
  -q, --quiet    Suppress progress, not results
```

Two things to notice:

- **`<version>` makes `--to` required.** Angle brackets on an option's value
  mean the _option_ must be given, not only that it takes a value. This is
  different from Commander and yargs. Use `[version]` for an option that is
  optional but takes a value, as `--env` does.
- **A thrown error is the command's failure.** `main()` prints its message and
  sets the exit code. The exit code is 1 unless the error has an integer
  `exitCode` property, as this one does, so `my-cli db migrate --to 0` exits
  with 2.

`db` has no `run`, so naming it lists what is under it.

## Test it

The scaffold already has `test/app.test.ts`. Tests for `deploy` look the same:

```ts
// test/deploy.test.ts
import schema from '../src/index.ts';
import { runCommand } from '@ttylabs/sigil/testing';
import { describe, expect, it } from 'vitest';

describe('deploy', () => {
  it('deploys to staging by default', async () => {
    const ran = await runCommand({ argv: ['deploy', 'api'], schema });

    expect(ran.code).toBe(0);
    expect(ran.out).toBe('Deploying api to staging (retries: 3)\n');
  });

  it('sees the options the app declared', async () => {
    const ran = await runCommand({ argv: ['deploy', 'api', '-v'], schema });

    expect(ran.argv.verbose).toBe(true);
  });

  it('refuses an environment it does not know', async () => {
    const ran = await runCommand({ argv: ['deploy', 'api', '--env', 'prod'], schema });

    expect(ran.code).toBe(1);
    expect(ran.err).toContain('Invalid value "prod" for option --env');
  });
});
```

```console
$ npm test
...
 Test Files  2 passed (2)
      Tests  5 passed (5)
```

`runCommand()` _is_ `main()`, the same function `dev.ts` calls. The difference is
that it returns what `main()` would have written: the exit code, stdout, stderr,
and the `argv` the command received. Always pass `argv`. If you leave it out,
`main()` reads `process.argv`, which inside a test runner holds the runner's own
arguments.

The streams in a test are pipes, not a terminal, so these tests never see color
or a real terminal width. [Testing](testing.md) covers `runOnTerminal()` for
that case, and how to test a prompt or a full-screen app.

## Build it

```console
$ npm run build
...
my-cli (src/index.ts): 4 commands into dist/my-cli.mjs
```

`sigil build` type-checks the app with your `tsconfig.json`, then bundles it into
`dist/my-cli.mjs` plus one chunk per command. The output has no dependencies,
because `@ttylabs/sigil` is bundled into it. That file is the `bin` in
`package.json`.

```console
$ node dist/my-cli.mjs --help
Usage: my-cli [options] <command>

What my-cli does

Commands:
  completion  Print a shell completion script
  db          Database tasks
  deploy      Deploy a service
  hello       Say hello
  help        Show help for a command

Options:
  -v, --verbose  Say more
  -h, --help     Show help for a command
  --version      Print the version
  -q, --quiet    Suppress progress, not results
$ node dist/my-cli.mjs --version
0.0.0
```

The build differs from `dev.ts` in two ways:

- It reads every command's description while building, so the list is complete
  without importing the command modules at runtime.
- It reads the version from `package.json` and adds `--version`. That flag is
  `-v, --version` unless `-v` is already taken, as it is here by `--verbose`.

Two related commands:

- `sigil check` reports what is wrong with the app without building it.
- `sigil package` builds the app and compiles it, with a runtime embedded, into a
  single binary for users who do not have Node installed. See the
  [`@ttylabs/cli` README](../../cli/README.md).

## <a id="agents"></a>Use sigil with an agent

Paste this into your project's `AGENTS.md` or `CLAUDE.md`, so that a coding agent
uses this version of sigil the way it is meant to be used. Every page of these
docs is also available as Markdown, by adding `.md` to its address.

<!-- include agents.md title="AGENTS.md · sigil v{{version}}" event=agent_instructions_copied -->

The block is [`agents.md`](agents.md), beside this guide. The website shows it
here with this version's number filled in.

<!-- /include -->

## Where next

- [Output formats](../README.md#output-formats): a command returns data, and
  `--json` serializes it.
- [`sigil/components`](../README.md#sigilcomponents): spinners, progress bars,
  tables and prompts.
- [Config files](../README.md#config-files): layered config with a schema.
- [`sigil/updates`](../README.md#sigilupdates): tell users when a newer version
  is published.
- [Shell completion](../README.md#shell-completion) and
  [Translating](../README.md#translating).
- [Help](../README.md#help): option groups, examples, and writing your own
  screen.
- [docs/parser.md](parser.md): the full reference for how a command line is
  parsed.
