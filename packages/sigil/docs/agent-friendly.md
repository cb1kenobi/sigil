# Making a CLI agent-friendly

Coding agents run command-line tools the way a script does: they pass arguments,
read stdout, and check the exit code. They can't see a prompt waiting for input,
and they can't tell from a command's name whether running it will delete
something. This guide covers the five things sigil gives an app so an agent can
use it safely: a description of every command's input, a statement of what
running each command does, prompts that never wait, a generated agent skill, and
an MCP server.

The examples continue the `my-cli` app from [Getting started](getting-started.md).
They add two commands: `status`, which only reads, and `deploy`, which asks two
questions.

## Return data, and let `--json` present it

Everything below works best when a command returns its result rather than
printing it. A command that declares `format` gets `--json` (and `--format`),
and sigil writes what `run()` returned:

```ts
// src/commands/status.ts
export default {
  desc: 'Show which version each region runs',
  format: true,
  idempotent: true,
  readOnly: true,

  run() {
    return { eu: '1.3.2', us: '1.4.0' };
  },
};
```

```console
$ my-cli status --json
{
  "eu": "1.3.2",
  "us": "1.4.0"
}
```

An error comes out in the same format, on stderr, with a `code` for a usage
error. See [Output formats](../README.md#output-formats) for the rest.

## Describe the input: the `schema` command

Every app has a `schema` command, added the way `help` and `completion` are. It
prints each runnable command's input as JSON Schema, keyed by the names `run()`
reads (`argv.region`, not `--region`), so an agent can build a correct call
without parsing `--help`:

```console
$ my-cli schema deploy
{
  "commands": [
    {
      "annotations": {
        "destructiveHint": true
      },
      "description": "Ship the current build to a region",
      "inputSchema": {
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "additionalProperties": false,
        "properties": {
          "verbose": {
            "type": "boolean",
            "description": "Say more",
            "default": false
          },
          "region": {
            "type": "string",
            "enum": [
              "us",
              "eu"
            ],
            "description": "Where to ship it"
          },
          "yes": {
            "type": "boolean",
            "description": "Skip the confirmation",
            "default": false
          }
        },
        "type": "object"
      },
      "path": [
        "deploy"
      ]
    }
  ],
  "program": "my-cli"
}
```

`my-cli schema` with no command prints all of them. An option's `choices` become
an `enum`, a type becomes a JSON type, and a required option or argument is
listed in `required`. `schema: false` on the app's schema turns the command off.
`sigil reference --json-schema` prints the same document from the toolchain, for
a build step that wants it in a file.

## Say what running a command does: annotations

Three properties on a command say what running it does:

| Property      | Means                                                     |
| ------------- | --------------------------------------------------------- |
| `readOnly`    | It changes nothing.                                       |
| `destructive` | It may delete or overwrite something.                     |
| `idempotent`  | Running it again with the same input has no extra effect. |

`status` above is `readOnly` and `idempotent`. They appear in the `schema`
output as the MCP tool annotations `readOnlyHint`, `destructiveHint` and
`idempotentHint`, in the generated skill, and in the MCP server's tool list. An
agent uses them to decide whether to ask before running a command, so declare
only what is true: a command that declares none of the three says nothing
either way.

## Never wait on a prompt: name the option that answers it

A prompt with no terminal fails instead of waiting forever. On its own that
failure doesn't tell an agent what to do next. Name the option that answers the
prompt, and pass the `state` that `run()` was given:

```ts
// src/commands/deploy.ts
import type { ParseState } from '@ttylabs/sigil';
import { confirm, select } from '@ttylabs/sigil/components/prompt';

export default {
  desc: 'Ship the current build to a region',
  destructive: true,
  format: true,
  options: {
    '--region [name]': { choices: ['us', 'eu'], desc: 'Where to ship it' },
    '--yes': { desc: 'Skip the confirmation' },
  },

  async run(state: ParseState) {
    const region = await select({
      choices: ['us', 'eu'],
      message: 'Which region?',
      option: '--region',
      state,
    });
    const sure = await confirm({ message: `Ship to ${region}?`, option: '--yes', state });
    return { region, shipped: sure };
  },
};
```

When the option was given, the prompt is skipped and its value is the answer:

```console
$ my-cli deploy --region eu --yes --json
{
  "region": "eu",
  "shipped": true
}
```

When it wasn't and there is no terminal, the run fails with a usage error that
says what to pass. It exits with code 2 and the code `missing-option`:

```console
$ my-cli deploy --yes < /dev/null
Error: Cannot ask "Which region?" without a terminal; pass --region <us|eu>
```

```console
$ my-cli deploy --region eu --json < /dev/null
{
  "error": {
    "message": "Cannot ask \"Ship to eu?\" without a terminal; pass --yes",
    "name": "UsageError",
    "code": "missing-option"
  }
}
```

On a terminal with nothing given, the prompt asks as before. A value from the
option's environment variable or its `default` answers the prompt too. A flag's
implied `false` doesn't, because nobody said it. A given value is checked the
way a typed answer is: a value outside the choices is an `invalid-value` usage
error. [Prompts](../README.md#prompts) has the details.

## Ship a skill: `sigil reference --skill`

Coding agents such as Claude Code load Agent Skills: a `SKILL.md` whose short
description stays in context, with a body the agent reads only when it needs it.
`sigil reference --skill` writes one for the app from its own command
declarations:

```console
$ npx sigil reference --skill
my-cli (src/index.ts): 2 files into skills/my-cli
```

`SKILL.md` lists each command with what running it does, then explains how to
call the app: read the input with `my-cli schema`, ask for `--json` where a
command offers it, pass every value on the command line, and read the exit code
and the usage error codes. `reference.md` beside it has every option of every
command.

For `my-cli`, two rows of its command table read:

```md
| `my-cli deploy` | Ship the current build to a region | **destructive** |
| `my-cli status` | Show which version each region runs | read-only, idempotent |
```

Commit the skill and ship it with the package. If `package.json` has a `files`
list that leaves `skills` out, the command warns, and it never edits the
manifest itself. Keep the skill out of your formatter: a formatter that realigns
its tables makes the next check report a skill nobody changed.
`sigil reference --skill --check` fails when the skill is out of date, which
makes it a good CI step. See
[the command reference](../../cli/README.md#the-command-reference-and-the-surface-snapshot).

## Serve it over MCP: `@ttylabs/mcp`

A skill tells an agent how to run the app. MCP lets an agent call the app's
commands directly, as tools. `@ttylabs/mcp` is a separate package, so an app that
doesn't use it pays nothing:

```sh
npm install @ttylabs/mcp
```

Add one command:

```ts
// src/commands/mcp.ts
import { mcpCommand } from '@ttylabs/mcp';

export default mcpCommand();
```

Then point an MCP client at it. For Claude Code:

```sh
claude mcp add my-cli -- my-cli mcp
```

Every runnable command is a tool, named after its path (`db migrate` is
`db_migrate`). Its input schema is the one `my-cli schema` prints, and its
annotations are the ones the command declares. The `mcp` command itself, hidden
commands and anything named in `mcpCommand({ exclude: [...] })` are left out.

Each call runs the command in a child process of its own, so:

- what `run()` returns is the tool result, and an object is its
  `structuredContent`;
- a usage error comes back with `isError` and its `code`, so an agent can tell a
  call it got wrong from a command that broke;
- the arguments arrive as data, so a value like `-5` is never mistaken for an
  option;
- a command that prints can't corrupt the protocol stream.

A progress bar or spinner the command runs is sent as progress notifications,
when the client asks for them. A prompt is asked of the client's user as an
elicitation, but only when the call's arguments didn't answer it. A client that
can't elicit gets the same "pass `--region`" error as a run without a terminal.

[demos/mcp/01-server.js](../../../demos/mcp/01-server.js) runs a server and a
client together and prints every exchange, and the
[`@ttylabs/mcp` README](../../mcp/README.md) covers the protocol details.

## Which to use

The `schema` command is already there. Returning data, annotations and prompts
that name their option cost a few properties per command, and they help every
caller that has no terminal: an agent, a CI job, or a script. Add the skill when
agents work in repositories that use your CLI, and the MCP server when you want
an agent to call the commands as tools rather than through a shell.
