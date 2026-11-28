# @ttylabs/mcp

A sigil app's commands as [MCP](https://modelcontextprotocol.io) tools, served
over stdio. Add one command and an agent can call every other one.

```sh
npm install @ttylabs/mcp
```

```js
import { mcpCommand } from '@ttylabs/mcp';

export default {
  name: 'mycli',
  commands: {
    mcp: mcpCommand(),
    // ...the app's own commands
  },
};
```

Then point an MCP client at it. For Claude Code:

```sh
claude mcp add mycli -- mycli mcp
```

## What it serves

Every runnable command is a tool, named by its path joined with `_`
(`db migrate` is `db_migrate`, the root's own `run` is the program's name):

- **`inputSchema`** is the command's input as JSON Schema, from `inputSchemas()`
  in `@ttylabs/sigil/reference` -- the same document `mycli schema` prints, keyed
  by the destination `run()` reads.
- **`annotations`** are what the command declares about running it:
  `readOnly`, `destructive` and `idempotent` become `readOnlyHint`,
  `destructiveHint` and `idempotentHint`, and only what was declared is sent.
- **Left out:** the `mcp` command itself and anything under it, a hidden
  command, a namespace that only lists its subcommands, and anything named in
  `exclude`:

```js
mcpCommand({ exclude: ['db migrate'], version: '1.2.3' });
```

Two commands whose paths fold to one tool name are refused when the server
starts, naming both, so an agent never calls a different command after an
unrelated edit.

## What a call does

Each call runs in **a child process**: the app's own entry, started again as
`mycli mcp --mcp-call`. The child takes the call over an IPC channel and hands
the arguments to `main()` as `input`, keyed by destination -- never rebuilt as
argv, which cannot say a positional that starts with a dash. So a command is
matched, parsed, validated and run exactly as from a terminal, and:

| The command              | The tool result                                                  |
| ------------------------ | ---------------------------------------------------------------- |
| returned an object       | its JSON as text, and the object as `structuredContent`          |
| returned anything else   | its JSON as text                                                 |
| returned nothing         | what it printed to stdout, as text                               |
| threw a usage error      | `isError`, the message, and `{ error: { name, message, code } }` |
| threw anything else      | `isError`, the message, and its name                             |
| exited without answering | `isError`, and what it wrote to stderr                           |

A command that prints never reaches the protocol, because its stdout is the
child's, and nothing process-wide -- the exit code, the quiet axis, the locale,
the working directory -- carries from one call into the next. A cancelled call
is killed and not answered.

A single executable built by `sigil package` starts itself the same way, with
no script argument; a Bun-compiled binary is recognized by its virtual
`/$bunfs/` entry.

## Progress and questions

A call can report progress and ask questions while it runs, over the same IPC
channel the call arrived on:

- **Progress.** A progress bar or spinner the command runs becomes
  `notifications/progress` for the call, when the client sent a
  `_meta.progressToken` with it. A bar reports where it is out of its total; a
  spinner, which has no measure, reports its message and a count of its updates.
  Progress is only ever sent growing, which the specification requires.
- **Questions.** A `text()`, `confirm()`, `select()` or `multiselect()` prompt the
  command reaches becomes an `elicitation/create` request to the client, when the
  client declared the `elicitation` capability. The client's user answers it, and
  the answer is held to the prompt's rules as a typed one is. A decline is a
  cancelled prompt. A multi-select needs protocol `2025-11-25`, and a choice list
  is offered by its labels, so two choices sharing a label cannot be asked. A
  `password()` is never asked: the specification says a server must not request
  sensitive information this way.
- **A client that cannot elicit** gets the prompt's own failure, as with no
  terminal, rather than a call that hangs.

## The protocol

Newline-delimited JSON-RPC 2.0 on stdin and stdout, written by hand rather than
over the official SDK, which would be this package's only dependency. It answers
`initialize` (negotiating `2025-11-25`, `2025-06-18`, `2025-03-26` or
`2024-11-05`), `ping`, `tools/list` and `tools/call`, honors
`notifications/cancelled`, and sends `notifications/progress` and
`elicitation/create`. `serverInfo` is the schema's `name` and `version`,
and `instructions` its `desc`.
