# Testing

This guide tests a small CLI with the helpers in `@ttylabs/sigil/testing`: a
command's output and exit code, its errors, what changes on a terminal, a
prompt, and a full-screen app.

Each helper answers a problem that is easy to miss from outside the framework,
so each section explains the problem before the helper. The app is the one `sigil new`
generates, called `my-cli`, with four commands added to give the tests
something to test. [Getting started](getting-started.md) shows how to create
it.

Nothing here is invented for the page. `packages/cli/test/guides.test.ts`
writes every file shown into a freshly generated app, runs every `my-cli`
command shown and compares the output, and then runs `npm test` over the test
files. If a command stops printing what is shown here, or a test shown here
stops passing, that check fails until this page is updated.

## The helpers

Each export of `@ttylabs/sigil/testing` exists because the obvious way to test
a CLI misses something:

| Helper                              | The problem it solves                                                       |
| ----------------------------------- | --------------------------------------------------------------------------- |
| `runCommand()`                      | `main()` writes to the process and sets its exit code, instead of returning |
| `runOnTerminal()`                   | A test runner's streams are pipes, so a test never sees a terminal          |
| `Screen` and `screenStream()`       | A frame is a diff, so its bytes do not say what is on the screen            |
| `createTestTerminal()`              | A prompt refuses to run without a terminal and a keyboard                   |
| `KEYS`, `ctrl()`, `alt()`, `tick()` | The bytes a key sends are not guessable, and drawing is not synchronous     |

They ship inside `@ttylabs/sigil` rather than as a separate package. Your app
depends on `@ttylabs/sigil` at an exact version, so the helpers always match
the `main()` they run and the terminal they fake. Importing
`@ttylabs/sigil/testing` is the only way to load them, so an app that does not
import it pays nothing for them.

`sigil new` already writes a `vitest.config.ts` and one test,
`test/app.test.ts`. The tests on this page use [vitest](https://vitest.dev)
too, and go in `test/` beside it.

## A command's output and exit code

Here is a command to test. It adds up its arguments:

```ts
// src/commands/sum.ts
import { command } from '@ttylabs/sigil';

export default command({
  desc: 'Add numbers up',
  args: [{ name: '<numbers...>', desc: 'What to add', type: 'number' }],
  options: {
    '--max [n]': { desc: 'Refuse a total over this', type: 'number' },
  },

  run({ argv }) {
    const total = argv.numbers.reduce((sum, n) => sum + n, 0);
    if (argv.max !== undefined && total > argv.max) {
      throw Object.assign(new Error(`${total} is over the limit of ${argv.max}`), { exitCode: 2 });
    }
    process.stdout.write(`${total}\n`);
  },
});
```

```console
$ my-cli sum 1 2 3
6
```

A command's `run()` is an ordinary function, but calling it directly skips
everything around it: the parse, the checks, help, and what happens to an
error. `main()` does all of that, and it is what your bin calls. The problem
is that `main()` is built for a bin script. It writes to `process.stdout` and
`process.stderr`, and on failure it sets `process.exitCode` instead of
throwing, so a test that calls it gets nothing back.

`runCommand()` is `main()` with those three things read back:

```ts
// test/sum.test.ts
import schema from '../src/index.ts';
import { runCommand } from '@ttylabs/sigil/testing';
import { describe, expect, it } from 'vitest';

describe('sum', () => {
  it('prints the total', async () => {
    const ran = await runCommand({ argv: ['sum', '1', '2', '3'], schema });

    expect(ran.code).toBe(0);
    expect(ran.out).toBe('6\n');
    expect(ran.err).toBe('');
  });

  it('hands run() the parsed values', async () => {
    const ran = await runCommand({ argv: ['sum', '1', '2', '3'], schema });

    expect(ran.argv.numbers).toEqual([1, 2, 3]);
  });

  it('prints help instead of running', async () => {
    const ran = await runCommand({ argv: ['sum', '--help'], schema });

    expect(ran.code).toBe(0);
    expect(ran.out).toContain('Usage: my-cli sum [options] <numbers...>');
  });
});
```

It takes the same options as `main()`, so the app is configured the way its
bin configures it, and it returns:

| Field    | What it is                                                                    |
| -------- | ----------------------------------------------------------------------------- |
| `code`   | The exit code the run left behind, or `0`                                     |
| `out`    | Everything written to stdout: help, `--version`, and the command's own output |
| `err`    | Everything written to stderr, which is where an error message goes            |
| `argv`   | The parsed values, which is what the command's `run()` received               |
| `error`  | The error object, for a run that failed                                       |
| `result` | What `main()` returned, which is the command's return value if it had one     |
| `state`  | The whole parse state, where the parse got far enough to make one             |

Because it _is_ `main()`, help outranks a missing argument, `--version` is
answered before the command runs, and an error sets the exit code exactly as it
does for your users. A helper that parsed and called `run()` itself would have
to make each of those decisions again, and could make them differently.

Three things to know:

- **Always pass `argv`.** Without it, `main()` reads `process.argv`, which in a
  test runner holds the runner's own arguments.
- **Run one at a time.** `runCommand()` replaces `write` on both of the
  process's output streams while it runs, so two runs at once would each
  capture part of the other's output. A second run while one is in progress
  throws instead. Do not use it in `it.concurrent`.
- **Keep `disableConsoleIntercept`.** vitest replaces the `console` methods so
  that it can show which test printed what, and then a command that prints with
  `console.log` writes to vitest instead of to the capture: `ran.out` comes back
  empty. The `vitest.config.ts` that `sigil new` writes turns that off.

## An error

A failure is part of a command's behaviour, and it is worth testing as much as
the success. `sum` fails in two ways. The parser refuses a value that is not a
number, and the command itself refuses a total over `--max`, with exit code 2:

```console
$ my-cli sum 1 x
Error: Invalid number: x
$ my-cli sum 5 6 --max 10
Error: 11 is over the limit of 10
```

`runCommand()` reports both the way a user sees them: a message on stderr and
an exit code. It also keeps the error object in `ran.error`, so a test can
check what kind of failure it was without matching the message, which may be
translated:

```ts
// test/sum-errors.test.ts
import schema from '../src/index.ts';
import { runCommand } from '@ttylabs/sigil/testing';
import { describe, expect, it } from 'vitest';

describe('sum, given the wrong input', () => {
  it('refuses a value that is not a number', async () => {
    const ran = await runCommand({ argv: ['sum', '1', 'x'], schema });

    expect(ran.code).toBe(1);
    expect(ran.out).toBe('');
    expect(ran.err).toBe('Error: Invalid number: x\n');
  });

  it('fails with the exit code the command chose', async () => {
    const ran = await runCommand({ argv: ['sum', '5', '6', '--max', '10'], schema });

    expect(ran.code).toBe(2);
    expect(ran.error).toBeInstanceOf(Error);
    expect((ran.error as Error).message).toBe('11 is over the limit of 10');
  });

  it('rethrows when the app handles its own errors', async () => {
    const run = runCommand({
      argv: ['sum', '5', '6', '--max', '10'],
      schema,
      settings: { errorHandler: false },
    });

    await expect(run).rejects.toThrow('11 is over the limit of 10');
  });
});
```

`runCommand()` puts `process.exitCode` back the way it found it after every
run. Without that, a test of a failing command would set the test runner's own
exit code, and a suite where every test passed would still exit with 1.

`settings.errorHandler: false` tells `main()` to throw the error instead of
printing it. `runCommand()` does not catch it, because catching it would change
what the setting means, so the run rejects and there is no `ran` to read.

## What a terminal changes

A test runner runs your tests with their output going to pipes, not to a
terminal. A pipe has no `isTTY` and no width, so everything that checks where
it is writing gets the same answer: no terminal, no colour, the default width.
That case cannot fail, so **a suite can pass completely and say nothing about
what your users see in a terminal.**

`runOnTerminal()` runs a program in a child process whose stdout and stderr
claim to be a terminal. The child is the real program, over real pipes, with
`isTTY`, `columns` and `rows` set on its streams the way a terminal sets them.
`tty: false` runs it again as a pipe, which gives you something to compare
against.

Help is a good thing to compare, because sigil colours it on a terminal and
writes plain text anywhere else:

```ts
// test/terminal.test.ts
import { ESC, strip } from '@ttylabs/sigil/ansi';
import { runOnTerminal } from '@ttylabs/sigil/testing';
import { join } from 'node:path';
import { expect, it } from 'vitest';

// the app, run from source the way `npm run dev` runs it
const app = join(import.meta.dirname, '..', 'dev.ts');

it('colours help on a terminal, and only there', async () => {
  const terminal = await runOnTerminal({ argv: ['sum', '--help'], run: app });
  const piped = await runOnTerminal({ argv: ['sum', '--help'], run: app, tty: false });

  expect(terminal.out).toContain(ESC);
  expect(piped.out).not.toContain(ESC);
  // the same words either way: only the colour differs
  expect(strip(terminal.out)).toBe(piped.out);
});
```

Comparing the two runs is usually the useful assertion, rather than pinning
either one to a string. The words should be the same, and what differs should
be what you meant to differ: colour, wrapping, a layout. A program that writes
the same bytes either way gets the same bytes back, so check that first if a
comparison surprises you.

It returns `{ code, out, err, signal }`, and takes:

| Option    | Default | What it does                                                           |
| --------- | ------- | ---------------------------------------------------------------------- |
| `run`     | none    | A module to run. Give exactly one of this and `source`                 |
| `source`  | none    | An ES module to run inline, as `node --input-type=module -e` does      |
| `argv`    | `[]`    | Arguments, after the module                                            |
| `tty`     | `true`  | Which streams claim to be a terminal: `true`, `false`, or a list       |
| `columns` | `80`    | Sets `COLUMNS`, and `columns` on the streams that claim to be one      |
| `rows`    | `24`    | Sets `LINES`, and `rows` on the streams that claim to be one           |
| `color`   | none    | A level to force, or `false` for none. Omitted, it detects from `TERM` |
| `cwd`     | none    | The working directory                                                  |
| `env`     | `{}`    | Variables, on top of a cleaned copy of the parent's environment        |
| `timeout` | `30000` | How long to wait, in milliseconds, before killing it                   |

`tty` takes a list to fake one stream and not the other, such as
`tty: ['stderr']` for a program that reports on stderr.

It handles two things for you that are easy to get wrong:

- **The environment decides the colour, not the stream.** A stream that claims
  to be a terminal still gets no colour if `TERM` is not set, and a CI runner
  sets `CI` or `GITHUB_ACTIONS`, which change the colour level. So
  `runOnTerminal()` clears every variable that colour detection reads, and sets
  `TERM` when a stream claims to be a terminal. Use `color` to ask for a level,
  and `env` to put back anything the program needs.
- **A chunk of output can end in the middle of a character.** The output is
  collected as bytes and decoded once at the end, so a multi-byte character
  split between two chunks does not turn into `U+FFFD`.

There is no pseudo-terminal involved. Node has none built in, and
`@ttylabs/sigil` has no dependencies. So `runOnTerminal()` cannot tell you
anything about terminal modes, such as raw mode, bracketed paste or mouse
reporting. Test those by hand, in the terminals you care about.

It also writes nothing to the child's stdin, so it cannot answer a prompt.
[Driving a prompt](#driving-a-prompt) is how to test one.

## What is on the screen

This command shows a progress bar:

```ts
// src/commands/sync.ts
import { command } from '@ttylabs/sigil';
import { createProgress } from '@ttylabs/sigil/components';

export default command({
  desc: 'Sync the files',
  options: {
    '--files [n]': { default: 40, desc: 'How many files', type: 'int' },
  },

  async run({ argv }) {
    const bar = createProgress({ text: 'Syncing', total: argv.files });
    for (let i = 0; i < argv.files; i++) {
      await new Promise((resolve) => setTimeout(resolve, 5));
      bar.tick();
    }
    bar.done(`Synced ${argv.files} files`);
  },
});
```

When the output is not a terminal, there is nothing to animate, so the bar
writes a line every ten percent instead. Every transcript on this page was
captured that way, with the output going to a pipe:

```console
$ my-cli sync
Syncing 0%
Syncing 10%
Syncing 20%
Syncing 30%
Syncing 40%
Syncing 50%
Syncing 60%
Syncing 70%
Syncing 80%
Syncing 90%
Syncing 100%
Synced 40 files 100%
```

On a terminal it draws one line and redraws it in place. A redraw is a _diff_
against the frame before it: it moves the cursor to the cells that changed and
writes only those. So the bytes a terminal receives are a long run of cursor
movements and fragments, and asserting on them says nothing about what is on
the screen at the end.

`Screen` answers that question. It is a model of a terminal screen: write bytes
to it, and it moves its cursor and fills its cells the way a terminal would.
Then read back what a person would be looking at:

```ts
// test/screen.test.ts
import { runOnTerminal, Screen } from '@ttylabs/sigil/testing';
import { join } from 'node:path';
import { expect, it } from 'vitest';

const app = join(import.meta.dirname, '..', 'dev.ts');

it('draws the progress on one line of a terminal', async () => {
  const terminal = await runOnTerminal({ argv: ['sync'], run: app });

  const screen = new Screen(80, 24);
  screen.write(terminal.out);

  expect(screen.written).toEqual(['Synced 40 files ██████████████████████████ 100%']);
});
```

All those cursor movements come down to one line.

`new Screen(columns, rows)` makes a screen, and `write()` replays bytes onto it.
A sequence cut off at the end of one `write()` is finished by the next one.
Read it back with:

- `viewport`: the rows on the screen, top to bottom, with trailing spaces
  trimmed.
- `log`: everything the main screen has held, including the rows that scrolled
  off the top, and `written`, which is `log` without the blank rows at the end.
- `cellAt(column, row)`: one cell. A wide character, such as `日`, takes two
  columns, and the second holds `''`, so this is how to check which column
  something starts in.
- `row` and `column` for the cursor, `cursorHidden`, `alternate` for whether
  the alternate screen is showing, and `clipboard` for what OSC 52 copied.

It models the sequences sigil writes: cursor movement, erasing, the alternate
screen, the cursor's visibility, and OSC 52. It **throws** on a sequence it
does not model, rather than quietly getting a row wrong. It keeps characters,
not colour, so test colour with `runOnTerminal()` output as above. The one
piece of styling it keeps is reverse video: `lastInverse` is the cell of the
most recent write made in reverse video.

`screenStream(screen)` wraps a `Screen` as a terminal output stream, with
`isTTY`, `columns` and `rows`, which is what `createTerminal({ stdout })` from
`@ttylabs/sigil/terminal` takes. Its `resize(width, height)` resizes the screen
and tells the terminal, the way a window resize does. You only need it to build
a terminal of your own. The test terminal in the next section is built on it
already.

## Driving a prompt

A prompt is the hardest thing to test from a test runner. It needs a terminal
on both ends, and it refuses to start without one, which is what stops a
script or a CI job waiting for an answer nobody can give. That refusal is
worth testing in its own right:

```ts
// src/ask.ts
import { text } from '@ttylabs/sigil/components';
import type { Terminal } from '@ttylabs/sigil/terminal';

export function askName(terminal?: Terminal): Promise<string> {
  return text({
    message: 'Project name',
    terminal,
    validate: (value) => (value.trim() === '' ? 'A project needs a name' : undefined),
  });
}
```

```ts
// src/commands/init.ts
import { askName } from '../ask.ts';
import { command } from '@ttylabs/sigil';

export default command({
  desc: 'Start a project',

  async run() {
    const name = await askName();
    process.stdout.write(`Created ${name}\n`);
  },
});
```

```console
$ my-cli init
Error: Cannot prompt for "Project name" because the input is not a terminal
```

`askName()` takes the terminal to ask on. The command passes nothing, so the
prompt uses the real one; a test passes a fake one. That is the one change a
prompt needs to be testable, and it is why every prompt takes a `terminal`.

`createTestTerminal()` is a terminal and a keyboard in the test's own process,
with no child process and no real clock. Hand its `terminal` to the prompt,
press keys with `press()`, and read the screen:

```ts
// test/ask.test.ts
import { askName } from '../src/ask.ts';
import { PromptError } from '@ttylabs/sigil/components';
import { createTestTerminal, ctrl, KEYS, tick } from '@ttylabs/sigil/testing';
import { describe, expect, it } from 'vitest';

describe('askName', () => {
  it('answers with what was typed', async () => {
    const ui = createTestTerminal();
    const answer = askName(ui.terminal);

    // nothing is drawn until pending work has run, which press() lets happen
    // after each key; before the first key, that is tick()'s job
    await tick();
    expect(ui.lines).toEqual(['? Project name']);

    await ui.press('Ada', KEYS.enter);

    expect(await answer).toBe('Ada');
    expect(ui.lines).toEqual(['? Project name Ada']);
  });

  it('says why an empty name is refused', async () => {
    const ui = createTestTerminal();
    const answer = askName(ui.terminal);

    await ui.press(KEYS.enter);
    expect(ui.lines).toEqual(['? Project name', '  A project needs a name']);

    await ui.press('Ada', KEYS.enter);
    expect(await answer).toBe('Ada');
  });

  it('is cancelled by Ctrl-C', async () => {
    const ui = createTestTerminal();
    // caught before the key is pressed, so the rejection is never unhandled
    const answer = askName(ui.terminal).catch((err: unknown) => err);

    await ui.press(ctrl('c'));

    const err = await answer;
    expect(err).toBeInstanceOf(PromptError);
    expect((err as PromptError).aborted).toBe(true);
  });

  it('refuses when nobody can answer', async () => {
    const ui = createTestTerminal({ inputTTY: false });

    await expect(askName(ui.terminal)).rejects.toThrow('the input is not a terminal');
  });
});
```

The Ctrl-C test attaches its `catch` before pressing the key. `press()` waits
for the prompt to act on each key, so the prompt rejects while `press()` is
still running, and a rejection with nothing attached to it yet is reported by
vitest as an unhandled error, even though the test catches it a moment later.

**Keys.** `press(...reads)` sends each argument as one read from the terminal.
The difference matters: a terminal delivers a keystroke as a read of its own
and a paste as one read of many characters. So `press(KEYS.up, KEYS.enter)` is
two keystrokes, and `press('Ada')` is one read of three characters. Then it
waits for the prompt to act on each one, so the next assertion sees the result.

- `KEYS` names the keys whose bytes are not guessable: `up`, `down`, `left`,
  `right`, `home`, `end`, `pageUp`, `pageDown`, `enter`, `tab`, `shiftTab`,
  `space`, `backspace`, `delete` and `escape`. A wrong sequence would be a test
  that presses nothing and passes, so a misspelt name is a type error.
- `ctrl('c')` is a letter held with Ctrl, and `alt('x')` is a key held with
  Alt.
- `paste(text)` sends a bracketed paste, which is not the same as typing the
  text: a newline inside a paste is part of the text, where a typed Enter
  submits.
- A lone `KEYS.escape` is not acted on straight away. A terminal sends Alt-x as
  Escape followed by `x`, so a prompt waits a moment to see whether anything
  follows the Escape. `press()` does not wait that long, so press another key
  after it, or advance the clock.

`tick()` lets pending work run, which is what `press()` does after each read.
Use it before the first key, as above, or after writing to `ui.stdin` yourself.

**The screen.** The prompt draws onto a `Screen`, and the test terminal reads
it back for you:

| Property   | What it is                                                            |
| ---------- | --------------------------------------------------------------------- |
| `lines`    | Everything the main screen holds, without the blank rows at the end   |
| `viewport` | The rows on the screen now, blank ones included                       |
| `screen`   | The `Screen` itself, for the cursor, `cellAt()`, and the rest         |
| `output`   | Every byte written, for the few things that really are about bytes    |
| `stdin`    | The input stream, for anything `press()` and `paste()` do not cover   |
| `terminal` | The terminal to hand a prompt or an app                               |
| `ansi`     | A styler at `colorLevel`, for a component that takes an `ansi` option |
| `resize()` | Resizes the screen and tells the terminal, as a window resize does    |

`lines` and `viewport` differ once something switches to the alternate screen,
as a full-screen app does: `viewport` is then what is showing, and `lines` is
the main screen behind it.

`createTestTerminal()` takes `columns` (40 by default) and `rows` (8), `env`
(empty, so nothing is detected from the real environment), `colorLevel` (0),
`isTTY` (`true`) and `inputTTY` (the same as `isTTY`). `inputTTY: false` is how
to test what happens when there is nobody to answer, as the last test does.

## A full-screen app

A full-screen app is tested the same way as a prompt: hand `runApp()` the test
terminal, press keys, and read the screen. Here is a small one, written with
the `ui` tag so that Node runs it with nothing compiled:

```ts
// src/counter.ts
import { useApp } from '@ttylabs/sigil/app';
import type { Element } from '@ttylabs/sigil/element';
import { State } from '@ttylabs/sigil/signals';
import { ui } from '@ttylabs/sigil/template';

export const stylesheet = `
  .counter { flex-direction: column; border: round; padding: 0 1 }
`;

export function Counter(): Element {
  const app = useApp();
  const count = new State(0);

  app.input?.bind('enter', () => count.set(count.get() + 1));
  app.input?.bind('q', () => app.exit());

  return ui`
    <box class="counter">
      <text>${() => `Count: ${count.get()}`}</text>
      <text>Enter counts, q quits</text>
    </box>
  `;
}
```

```ts
// src/commands/counter.ts
import { Counter, stylesheet } from '../counter.ts';
import { command } from '@ttylabs/sigil';
import { runApp } from '@ttylabs/sigil/app';

export default command({
  desc: 'Count key presses, full screen',

  async run() {
    process.exitCode = await runApp(Counter, { sheets: [stylesheet] }).exited;
  },
});
```

Like a prompt, a full-screen app refuses to start without a terminal on both
ends:

```console
$ my-cli counter
Error: Cannot run an app because stdin or the output is not a terminal: it needs somebody to type and a screen to draw on
```

The command passes `runApp()` no terminal, so it uses the real one. The test
mounts the component itself, on a test terminal:

```ts
// test/counter.test.ts
import { Counter, stylesheet } from '../src/counter.ts';
import { runApp } from '@ttylabs/sigil/app';
import { createTestTerminal, KEYS } from '@ttylabs/sigil/testing';
import { expect, it } from 'vitest';

// frames are drawn on a clock, about 30 a second, rather than once per key,
// so wait long enough for the next one
const frame = () => new Promise((resolve) => setTimeout(resolve, 50));

it('counts Enter, and gives the screen back on q', async () => {
  const term = createTestTerminal({ columns: 30, rows: 4 });
  const exited = runApp(Counter, {
    detect: false,
    sheets: [stylesheet],
    terminal: term.terminal,
  }).exited;
  await frame();

  await term.press(KEYS.enter, KEYS.enter);
  await frame();
  expect(term.viewport).toEqual([
    '╭────────────────────────────╮',
    '│ Count: 2                   │',
    '│ Enter counts, q quits      │',
    '╰────────────────────────────╯',
  ]);

  await term.press('q');
  expect(await exited).toBe(0);
  expect(term.screen.alternate).toBe(false);
  expect(term.lines).toEqual([]);
});
```

- **Wait for a frame.** A full-screen app draws on a clock rather than once per
  key, so `press()` returning does not mean the screen has been redrawn.
  Waiting 50 milliseconds is enough for the next frame. Wait before the first
  key too: an app that sets something up in `onMount()`, such as which row has
  the focus, does it after its first frame.
- **`detect: false`** skips asking the terminal what it supports, which a test
  terminal cannot answer.
- **The last three lines test the exit.** `exited` resolves with the exit code,
  `0` for `app.exit()`. The alternate screen is gone, and the main screen is
  empty, because the app drew nothing outside the alternate screen.

[Building a full-screen app](full-screen-apps.md) builds a larger app and
tests it the same way.

## Running the tests

`npm test` runs every test file, including the one `sigil new` wrote:

```console
$ npm test
...
 Test Files  7 passed (7)
      Tests  15 passed (15)
```

Everything except the `runOnTerminal()` tests runs in vitest's own process, so
the suite stays fast. Each `runOnTerminal()` call starts a Node process, so use
it for what only a terminal changes, and `runCommand()` for the rest.

## Where next

- [Getting started](getting-started.md) builds the app this guide starts from.
- [Building a full-screen app](full-screen-apps.md) explains `runApp()`,
  components and the `ui` tag.
- [`sigil/components`](../README.md#sigilcomponents) lists every prompt,
  spinner and progress bar, all of which take a `terminal`.
