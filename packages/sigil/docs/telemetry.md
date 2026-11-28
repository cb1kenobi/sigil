# Telemetry

This guide adds usage telemetry to a sigil app with two hooks: `afterRun` for a
command that ran, and `beforeError` for one that never started.

Telemetry is code you run on someone else's machine and data they never chose to
send, so it has to follow three rules:

- It asks first, and `DO_NOT_TRACK` always wins.
- It never slows a command down.
- It never records what the user typed.

This guide shows how to follow all three. The app is the one `sigil new` generates,
called `my-cli`. [Getting started](getting-started.md) shows how to create it.

Nothing here is invented for the page. `packages/cli/test/guides.test.ts` writes
every file shown into a freshly generated app, runs every `my-cli` command shown
and compares the output, and then runs `npm test` over the test file. If a
command stops printing what is shown here, or the test stops passing, that check
fails until this page is updated.

## What sigil gives you

sigil has no telemetry of its own. It sends nothing, has no endpoint, and does
not decide for your app whether to ask. What it gives you is two hooks on the
schema that between them see every run:

| Hook          | Fires                                               | What it is handed                     |
| ------------- | --------------------------------------------------- | ------------------------------------- |
| `afterRun`    | After a command's `run()` returned or threw         | the command, its result, its duration |
| `beforeError` | Before any error is shown, including a failed parse | the error, and the parse state if any |

A run that fails to parse never gets to a command, so `afterRun` never fires for
it, and a typo is exactly the kind of run you most want to count. A command that
throws fires both hooks, `afterRun` first. The [Hooks](../README.md#hooks)
section of the README covers both in full: their order, what they may change,
and what happens when one throws.

A hook on the **schema** sees every command, which is why telemetry goes there
rather than on each command.

## Ask first

Nothing should be recorded before the user has said yes. In `my-cli`, the answer
comes from the environment on every run:

```ts
// src/telemetry/consent.ts

/** Whether this run may record anything, and why not when it may not. */
export type Consent = 'on' | 'debug' | 'off' | 'do-not-track';

/**
 * Read from the environment on every run, so nothing is recorded until the user
 * has said yes, and a "no" takes effect straight away.
 */
export function consent(env: NodeJS.ProcessEnv = process.env): Consent {
  // https://consoledonottrack.com -- any value at all means no
  if (env.DO_NOT_TRACK) {
    return 'do-not-track';
  }
  switch (env.MY_CLI_TELEMETRY) {
    case '1':
      return 'on';
    case 'debug':
      return 'debug';
    default:
      return 'off';
  }
}
```

- **`DO_NOT_TRACK` is checked first.** It is the one switch that works across
  every tool that honours it, so a user who set it once should never have to
  find your variable as well. It wins over everything, a `debug` included.
- **Off until switched on.** `MY_CLI_TELEMETRY=1` is a yes and anything else is
  a no. If your app asks once and remembers the answer instead, read that answer
  here, after `DO_NOT_TRACK`. Ask only when stdin and stdout are a terminal: a
  prompt in a CI job or a pipe waits for an answer that never comes.
- **`debug` prints each event instead of sending it**, so anyone can see exactly
  what would leave their machine.

A user also needs a way to find out what the app is doing. A `telemetry` command
tells them:

```ts
// src/commands/telemetry.ts
import { consent, type Consent } from '../telemetry/consent.ts';
import { command } from '@ttylabs/sigil';

const STATUS: Record<Consent, string> = {
  on: 'Telemetry is on. Set MY_CLI_TELEMETRY=0 to turn it off.',
  debug: 'Telemetry is in debug mode: each event is printed to stderr and not sent.',
  off: 'Telemetry is off. Set MY_CLI_TELEMETRY=1 to share anonymous usage data.',
  'do-not-track': 'Telemetry is off, because DO_NOT_TRACK is set.',
};

export default command({
  desc: 'Say whether my-cli shares usage data',

  run() {
    process.stdout.write(`${STATUS[consent()]}\n`);
  },
});
```

```console
$ my-cli telemetry
Telemetry is off. Set MY_CLI_TELEMETRY=1 to share anonymous usage data.
$ MY_CLI_TELEMETRY=1 my-cli telemetry
Telemetry is on. Set MY_CLI_TELEMETRY=0 to turn it off.
$ DO_NOT_TRACK=1 MY_CLI_TELEMETRY=1 my-cli telemetry
Telemetry is off, because DO_NOT_TRACK is set.
```

Say in your README what is collected, where it goes, and how to turn it off,
before anyone installs the app rather than after.

## Leave out what the user typed

What the user typed is the most tempting thing to record and the one thing you
must not. A single argv can hold a token, a password, a customer's name, or a
path with a username in it. You cannot tell those apart from safe values, so
record none of them:

- **Not argv, and not `state.$orig`.** Record the command the parser matched,
  spelled the way the app declares it. A typed alias and a typo then both arrive
  as the command they meant, or as no command.
- **Not option or argument values**, for the same reason. If you want to know
  which options are used, take their names from the options your app
  _declares_, never from argv: an undeclared option's name is whatever the user
  typed, and `--ghp_Abc123=1` is a name.
- **Not an error's message.** Messages repeat what was typed:
  `Invalid value "hunter2" for option --password`. A `UsageError` has a `code`
  for exactly this, and any other error has a class name.
- **Not paths, the working directory, the hostname, or the username.** Add the
  app's version or the platform if you need them, but every field you add makes
  one event easier to trace back to one person.

So an event is a handful of names and numbers:

```ts
// src/telemetry/event.ts
import { UsageError } from '@ttylabs/sigil';

/** One run, as telemetry records it. Nothing in it came from argv. */
export interface TelemetryEvent {
  /** The command, as the app declares it: `my-cli db migrate`. */
  command: string;
  ok: boolean;
  /** A `UsageError` code or an error's class name, where `ok` is false. */
  error?: string;
  /** How long `run()` took, in whole milliseconds, where a command ran. */
  ms?: number;
}

/** The commands argv matched, by their declared names: never what was typed. */
export function commandOf(state: { contexts: { name: string }[] } | undefined): string {
  return (state?.contexts ?? [])
    .map((cmd) => cmd.name)
    .toReversed()
    .join(' ');
}

/** What went wrong, by name: never the message, which can repeat what was typed. */
export function errorOf(err: unknown): string {
  if (err instanceof UsageError) {
    return err.code;
  }
  return err instanceof Error ? err.name : typeof err;
}
```

`state.contexts` is the chain of commands argv matched, innermost first and the
app itself last, which is why it is reversed. Each entry is the declared
command, so its `name` is the declared name whichever alias was typed.

## Send without waiting

A command that has finished should exit. Both hooks are awaited, so a hook that
waits on the network adds the request to every run, and a slow or unreachable
endpoint adds its timeout. Not awaiting a `fetch()` does not help either: the
open socket keeps the process alive until the request settles, so the user
still waits for the prompt to come back.

What does not wait is a process of its own. Start a runtime with the event,
detach it, and let this one exit:

```ts
// src/telemetry/send.ts
import { consent } from './consent.ts';
import type { TelemetryEvent } from './event.ts';
import { spawn } from 'node:child_process';

/** Where events go. A `.example` name never resolves: put your own here. */
const ENDPOINT = 'https://telemetry.my-cli.example/v1/events';

/**
 * The sender, as a script rather than a file, so that it survives `sigil build`
 * bundling the app into one module.
 */
const SENDER = `
fetch(process.env.TELEMETRY_ENDPOINT, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: process.env.TELEMETRY_EVENT,
  signal: AbortSignal.timeout(10_000),
}).catch(() => {});
`;

/** Records one event, where the user said yes. */
export async function record(event: TelemetryEvent): Promise<void> {
  const mode = consent();
  if (mode === 'debug') {
    process.stderr.write(`telemetry: ${JSON.stringify(event)}\n`);
  } else if (mode === 'on') {
    await send(JSON.stringify(event));
  }
}

async function send(body: string): Promise<void> {
  // imported here rather than at the top: it is the update check's entry, and
  // a run with telemetry off has no reason to load it
  const { compiledHost } = await import('@ttylabs/sigil/updates');

  // in a binary from `sigil package` there is no runtime to start, so send
  // from this process and wait for it, briefly
  if (await compiledHost()) {
    await fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
      signal: AbortSignal.timeout(500),
    }).catch(() => {});
    return;
  }

  // NODE_OPTIONS can name loaders and flags the sender does not have, and
  // without MY_CLI_TELEMETRY a child that turns out to be this app (see "In a
  // single binary") records nothing, rather than spawning again
  const { MY_CLI_TELEMETRY: _consent, NODE_OPTIONS: _options, ...env } = process.env;
  const child = spawn(process.execPath, ['-e', SENDER], {
    detached: true,
    env: { ...env, TELEMETRY_ENDPOINT: ENDPOINT, TELEMETRY_EVENT: body },
    stdio: 'ignore',
    windowsHide: true,
  });
  // a runtime that will not start is an `error` event, and one nobody listens
  // for crashes the app after its command has already succeeded
  child.on('error', () => {});
  child.unref();
}
```

- **`detached`, `stdio: 'ignore'` and `unref()` together** are what let this
  process exit at once. A pipe to the child would hold it open just as a socket
  does, so the child gets none.
- **The event goes in the environment**, not in argv, where any user on the
  machine could read it in a process list.
- **The sender swallows its own failures.** Nobody is watching it, and a
  network that is down is not something to report.
- **`compiledHost()` decides between the two**, and the next section says why
  a binary cannot spawn. It comes from `@ttylabs/sigil/updates`, which is where
  the update check asks the same question, and is imported only once there is
  something to send.
- **A hook that throws cannot break the command.** sigil catches it and logs it,
  under `DEBUG=sigil:run` for `afterRun` and `DEBUG=sigil:error` for
  `beforeError`, or `DEBUG='sigil:*'` for both. A bug in `record()` costs you an
  event, not the user their output or their exit code. That is a backstop, not
  a reason to throw.

Sending each event as it happens is the simplest way to do it. If your app runs
often, write events to a file in its cache directory and send them in batches
from a later run. That way one process sends many events and nothing has to
happen on every run.

## Record every run

With those three files, the hooks are a few lines on the schema:

```ts
// src/index.ts
import { commandOf, errorOf } from './telemetry/event.ts';
import { record } from './telemetry/send.ts';
import type { Schema } from '@ttylabs/sigil';

/** The runs `afterRun` recorded, so that `beforeError` does not record them again. */
const recorded = new WeakSet<object>();

export default {
  name: 'my-cli',
  desc: 'What my-cli does',
  options: {
    '-v, --verbose': { desc: 'Say more', type: 'bool' },
  },
  baseDir: import.meta.dirname,
  commands: './commands',

  hooks: {
    async afterRun({ result, ms, state }) {
      recorded.add(state);
      await record({
        command: commandOf(state),
        ok: result.ok,
        error: result.ok ? undefined : errorOf(result.error),
        ms: Math.round(ms),
      });
    },

    async beforeError(err, state) {
      if (state === undefined || !recorded.has(state)) {
        await record({ command: commandOf(state), ok: false, error: errorOf(err) });
      }
    },
  },
} satisfies Schema;
```

- **`afterRun` is every command that ran**, whether `run()` returned or threw.
  `result.ok` says which, and `ms` is how long `run()` took, measured by sigil
  with `performance.now()`. A run answered by `--help` or `--version` runs no
  command, so it fires nothing.
- **`beforeError` is every run that failed before a command started**: a
  mistyped command, a missing argument, a value its type rejects. It resolves
  to nothing, so the error is left as it is and shown as usual.
- **One failure is one event.** A command that throws fires `afterRun` and then
  `beforeError` for the same run, so `afterRun` remembers the parse state it was
  handed and `beforeError` skips a state it has seen. `state` is undefined for
  an error raised before there was one, such as an invalid schema, and that is
  recorded too.
- **`satisfies Schema`** types each hook's arguments without changing what the
  module exports, and `sigil build` reads the schema through it.

`debug` shows what each run records. A typo is recorded as the app itself
failing with `unexpected-argument`. The error message, printed below the event,
repeats what was typed, and the event does not:

```console
$ MY_CLI_TELEMETRY=debug my-cli helo Ada
telemetry: {"command":"my-cli","ok":false,"error":"unexpected-argument"}
Error: Unexpected argument "helo". Did you mean "hello"?
$ MY_CLI_TELEMETRY=debug my-cli hello Ada Grace
telemetry: {"command":"my-cli hello","ok":false,"error":"unexpected-argument"}
Error: Unexpected argument "Grace"
$ DO_NOT_TRACK=1 MY_CLI_TELEMETRY=debug my-cli helo Ada
Error: Unexpected argument "helo". Did you mean "hello"?
```

A command that ran is recorded with its duration as well, as
`{"command":"my-cli hello","ok":true,"ms":0}`.

## In a single binary

`sigil package` builds an executable with a runtime inside it. There,
`process.execPath` is your app itself rather than a runtime, so spawning it
would start your CLI again, with `-e` as its arguments, instead of running the
sender. `compiledHost()` is what tells `send()` it is in one: the build bakes
the answer into what `sigil package` produces, and for a binary something else
compiled it probes the runtime, `node:sea` on Node and `Bun.main` on Bun.

So in a binary `send()` posts the event itself and waits for it, for at most
half a second, on a run the user opted into. That is the cost of having no
runtime to hand the request to. If half a second is too much, defer instead:
write the event to a file and send the file's events at the start of the next
run, while that run's own command is working.

A binary built some way `compiledHost()` cannot recognise would still be
spawned, and would relaunch the app instead of sending. That is why `send()`
leaves `MY_CLI_TELEMETRY` out of the child's environment: the relaunched copy
then records nothing, rather than spawning again.

## Test it

The rules above are the kind that break quietly, so test them. In debug mode
each event is a line on stderr, which `runCommand()` hands back as `err`:

```ts
// test/telemetry.test.ts
import schema from '../src/index.ts';
import type { Schema } from '@ttylabs/sigil';
import { runCommand } from '@ttylabs/sigil/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';

/** The events one run recorded, read back from what debug mode printed. */
async function events(argv: string[], app: Schema = schema): Promise<unknown[]> {
  const ran = await runCommand({ argv, schema: app });
  return ran.err
    .split('\n')
    .filter((line) => line.startsWith('telemetry: '))
    .map((line) => JSON.parse(line.slice('telemetry: '.length)) as unknown);
}

describe('telemetry', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('records the command and not what was passed to it', async () => {
    vi.stubEnv('MY_CLI_TELEMETRY', 'debug');
    const recorded = await events(['hello', 'Ada', '--token', 'hunter2']);

    expect(recorded).toEqual([{ command: 'my-cli hello', ok: true, ms: expect.any(Number) }]);
    expect(JSON.stringify(recorded)).not.toMatch(/Ada|token|hunter2/);
  });

  it('records a command that throws once, by its class name', async () => {
    vi.stubEnv('MY_CLI_TELEMETRY', 'debug');
    const app = {
      ...schema,
      commands: {
        fail: {
          run() {
            throw new TypeError('Cannot read /home/ada/.secrets');
          },
        },
      },
    };

    expect(await events(['fail'], app)).toEqual([
      { command: 'my-cli fail', ok: false, error: 'TypeError', ms: expect.any(Number) },
    ]);
  });

  it('records a failed parse once, by its code', async () => {
    vi.stubEnv('MY_CLI_TELEMETRY', 'debug');

    expect(await events(['helo', 'Ada'])).toEqual([
      { command: 'my-cli', ok: false, error: 'unexpected-argument' },
    ]);
  });

  it('records nothing when DO_NOT_TRACK is set', async () => {
    vi.stubEnv('MY_CLI_TELEMETRY', 'debug');
    vi.stubEnv('DO_NOT_TRACK', '1');

    expect(await events(['hello'])).toEqual([]);
    expect(await events(['helo'])).toEqual([]);
  });
});
```

```console
$ npm test
...
 Test Files  2 passed (2)
      Tests  6 passed (6)
```

The second test gives the app a command of its own by spreading the schema, so
the hooks under test are the real ones. The first passes an option the app never
declared, `--token`: sigil accepts it and puts it on `argv`, and the event still
leaves it out. [Testing](testing.md) covers `runCommand()` and the other helpers.

## Before you ship it

- `DO_NOT_TRACK` turns it off, whatever else is set.
- Nothing is sent until the user has said yes, and a command tells them which
  way it is set.
- The README says what is collected, where it goes, and how to turn it off.
- An event holds declared names, codes and numbers, and nothing from argv, an
  error message, or the file system.
- No hook waits on the network, except in a binary built by `sigil package`,
  which waits half a second at most rather than spawning itself.
- A test fails if a typed value reaches an event.
