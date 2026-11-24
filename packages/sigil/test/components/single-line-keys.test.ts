import { autocomplete } from '../../src/components/autocomplete.js';
import { list } from '../../src/components/list.js';
import { number } from '../../src/components/number.js';
import { commandPalette } from '../../src/components/palette.js';
import { path } from '../../src/components/path.js';
import { password, type PromptError, text } from '../../src/components/prompt.js';
import { createInput } from '../../src/input/index.js';
import { parse } from '../../src/parser/parse.js';
import type { ParseState } from '../../src/types.js';
import { type ScreenHarness, screenSetup, tick } from './helpers.js';
import { describe, expect, it } from 'vitest';

/**
 * The key table every single-line field shares (SIG-410).
 *
 * It was written out once per field, and the copies drifted: `text()` ignored
 * Ctrl-W, Ctrl-K, Alt-B, Alt-F and Alt-Backspace while `TextField` took them. The
 * same keys are driven through every field here, over the same value, and each is
 * asked what it holds -- so a field that stops sharing the table, or a new one
 * that never joined it, fails by name rather than being noticed by a user.
 */

const ENTER = '\r';
const CTRL_C = '\u0003';
const CTRL_K = '\u000b';
const CTRL_W = '\u0017';
const CTRL_U = '\u0015';
const LEFT = '\u001b[D';
const HOME = '\u001b[H';
const ALT_B = '\u001bb';
const ALT_D = '\u001bd';
const ALT_F = '\u001bf';
const ALT_BACKSPACE = '\u001b\u007f';
const VALUE = 'foo bar baz';

interface Stdin {
  send(chunk: string): void;
}

/** Sends keys one at a time, letting the prompt act on each. */
async function type(stdin: Stdin, ...chunks: string[]): Promise<void> {
  for (const chunk of chunks) {
    stdin.send(chunk);
    await tick();
  }
}

/** A field put on a screen, and the way to read what it holds. */
interface Asked {
  /** Settles when the field does, which is how a test lets go of it. */
  done: Promise<unknown>;
  /** What the field holds, read off the first row once the message is taken off it. */
  read(): string;
  ui: ScreenHarness;
}

/** The state a parse ends in, which is what the palette reads. */
function appState(): Promise<ParseState> {
  return parse({
    argv: [],
    env: {},
    schema: {
      commands: { build: { run(): void {} } },
      completion: false,
      help: false,
      name: 'mycli',
    },
  });
}

/** Swallows an abort, so that letting go of a field is not an unhandled rejection. */
function quiet(promise: Promise<unknown>): Promise<unknown> {
  return promise.catch((error: PromptError) => error);
}

/** The first row less the mark and the message, which is where the field is. */
function after(ui: ScreenHarness, message: string): string {
  return (ui.log[0] ?? '').replace(new RegExp(`^\\S+ ${message} ?`), '').trimEnd();
}

const fields: Record<string, () => Promise<Asked>> = {
  autocomplete() {
    const ui = screenSetup({ columns: 60, rows: 12 });
    const done = quiet(
      autocomplete({
        ansi: ui.ansi,
        frameMs: 0,
        message: 'Pick',
        source: () => [],
        terminal: ui.terminal,
      } as never)
    );
    return Promise.resolve({ done, read: () => after(ui, 'Pick'), ui });
  },
  list() {
    const ui = screenSetup({ columns: 60 });
    const done = quiet(list({ ansi: ui.ansi, message: 'Pick', terminal: ui.terminal }));
    return Promise.resolve({ done, read: () => after(ui, 'Pick'), ui });
  },
  async palette() {
    const ui = screenSetup({ rows: 12 });
    const done = quiet(commandPalette(await appState(), { ansi: ui.ansi, terminal: ui.terminal }));
    return { done, read: () => after(ui, 'Run a command'), ui };
  },
  path() {
    const ui = screenSetup({ columns: 60, rows: 14 });
    const done = quiet(path({ ansi: ui.ansi, message: 'Pick', terminal: ui.terminal }));
    return Promise.resolve({ done, read: () => after(ui, 'Pick'), ui });
  },
  text() {
    const ui = screenSetup({ columns: 60 });
    const done = quiet(text({ ansi: ui.ansi, message: 'Pick', terminal: ui.terminal }));
    return Promise.resolve({ done, read: () => after(ui, 'Pick'), ui });
  },
};

/** Types the value, sends the keys, and reports what the field holds. */
async function drive(
  open: () => Promise<Asked>,
  value: string,
  ...keys: string[]
): Promise<string> {
  const asked = await open();
  await type(asked.ui.stdin, ...value, ...keys);
  const held = asked.read();
  await type(asked.ui.stdin, CTRL_C);
  await asked.done;
  return held;
}

describe.each(Object.entries(fields))('%s', (_name, open) => {
  it('should take a word off the end with ctrl-w', async () => {
    expect(await drive(open, VALUE, CTRL_W)).toBe('foo bar');
  });

  it('should take the rest of the line off with ctrl-k', async () => {
    expect(await drive(open, VALUE, HOME, ALT_F, CTRL_K)).toBe('foo');
  });

  it('should take a word off the end with alt-backspace', async () => {
    expect(await drive(open, VALUE, ALT_BACKSPACE)).toBe('foo bar');
  });

  it('should take the word after the caret off with alt-d', async () => {
    expect(await drive(open, VALUE, HOME, ALT_F, ALT_D)).toBe('foo baz');
  });

  it('should move back a word with alt-b, so that a character types before it', async () => {
    expect(await drive(open, VALUE, ALT_B, 'x')).toBe('foo bar xbaz');
  });

  it('should move on a word with alt-f, so that a character types after it', async () => {
    expect(await drive(open, VALUE, HOME, ALT_F, 'x')).toBe('foox bar baz');
  });

  it('should still clear to the start with ctrl-u', async () => {
    expect(await drive(open, VALUE, LEFT, CTRL_U)).toBe('z');
  });
});

describe('number()', () => {
  // a number has no spaces, so a word is the whole of it -- which is still the
  // table's answer, and is what the word keys are worth here
  async function held(keys: string[], value = '12345'): Promise<unknown> {
    const ui = screenSetup({ columns: 60 });
    const answer = number({ ansi: ui.ansi, message: 'Port', terminal: ui.terminal });
    await type(ui.stdin, ...value, ...keys, ENTER);
    return answer;
  }

  it('should take the whole of it off with ctrl-w', async () => {
    expect(await held([LEFT, LEFT, CTRL_W, '9'])).toBe(945);
  });

  it('should take the rest of the line off with ctrl-k', async () => {
    expect(await held([LEFT, LEFT, CTRL_K])).toBe(123);
  });

  it('should take the whole of it off with alt-backspace', async () => {
    expect(await held([LEFT, ALT_BACKSPACE, '9'])).toBe(95);
  });

  it('should take the rest of the number off with alt-d, and the start of it with ctrl-u', async () => {
    expect(await held([HOME, ALT_D, '9'])).toBe(9);
    expect(await held([LEFT, LEFT, CTRL_U])).toBe(45);
  });

  it('should jump to the start with alt-b and to the end with alt-f', async () => {
    expect(await held([ALT_B, '9'])).toBe(912345);
    expect(await held([HOME, ALT_F, '9'])).toBe(123459);
  });
});

describe('password()', () => {
  // jumping or deleting by word on a masked value reveals where its spaces are,
  // so it edits one character at a time. Every word key is still claimed and does
  // nothing: a prompt stops every key it reads, so none reaches the app's own
  // handler on a router the prompt shares
  async function held(...keys: string[]): Promise<string | undefined> {
    const ui = screenSetup({ columns: 60 });
    const router = createInput({ terminal: ui.terminal });
    const app: string[] = [];
    const answer = password({ ansi: ui.ansi, message: 'Secret', router, terminal: ui.terminal });
    router.bind((event) => app.push(event.key.name));
    await type(ui.stdin, ...VALUE, ...keys, ENTER);
    router.stop();
    expect(app).toEqual([]);
    return answer;
  }

  it('should claim ctrl-w and ctrl-k and do nothing', async () => {
    expect(await held(CTRL_W)).toBe(VALUE);
    expect(await held(HOME, CTRL_K)).toBe(VALUE);
  });

  it('should claim alt-d and alt-backspace and do nothing', async () => {
    expect(await held(HOME, ALT_D)).toBe(VALUE);
    expect(await held(ALT_BACKSPACE)).toBe(VALUE);
  });

  it('should claim alt-b and alt-f, leaving the caret where it was', async () => {
    // the caret is at the end for the first, and at the start for the second,
    // which Home moved it to
    expect(await held(ALT_B, 'x')).toBe(`${VALUE}x`);
    expect(await held(HOME, ALT_F, 'x')).toBe(`x${VALUE}`);
  });

  it('should still edit a character at a time', async () => {
    expect(await held(LEFT, LEFT, '\u007f', 'x')).toBe('foo bar xaz');
    expect(await held(LEFT, CTRL_U)).toBe('z');
  });
});
