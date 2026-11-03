import { autocomplete, autocompleteMultiselect } from '../../src/components/autocomplete.js';
import { pickDate } from '../../src/components/calendar.js';
import { date } from '../../src/components/date.js';
import { filePicker } from '../../src/components/file-picker.js';
import { groupMultiselect } from '../../src/components/group-multiselect.js';
import { group, isBack } from '../../src/components/group.js';
import { list } from '../../src/components/list.js';
import { maskedText } from '../../src/components/masked-text.js';
import { number } from '../../src/components/number.js';
import { path } from '../../src/components/path.js';
import {
  confirm,
  forcedAccessible,
  multiline,
  multiselect,
  password,
  PromptBack,
  PromptError,
  runLinePrompt,
  select,
  separator,
  text,
} from '../../src/components/prompt.js';
import { selectKey } from '../../src/components/select-key.js';
import { selectRow } from '../../src/components/select-row.js';
import { sort } from '../../src/components/sort.js';
import { toggle } from '../../src/components/toggle.js';
import { directoryTree, selectTree } from '../../src/components/tree.js';
import { baseDir } from '../../src/paths.js';
import { type ScreenHarness, screenSetup, tick } from './helpers.js';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve, sep } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The prompts that have a line form, asked as lines, for a screen reader.
 *
 * Read through the screen model, because what is claimed is the transcript: the
 * question written once, what was typed after it, and nothing ever moved. The
 * one claim made about bytes is the strongest one -- that nothing but the paste
 * markers was written as an escape sequence at all, which is what "never
 * redrawn" means once it is said precisely.
 */

/**
 * A `readdir` that can be held, standing in for the real one -- `path.test.ts`'s
 * seam. Hoisted because `vi.mock` is; with no gate it is the real `readdir`, so
 * every other test here reads the real file system.
 */
const reads = vi.hoisted(() => ({
  gate: undefined as Promise<void> | undefined,
}));

vi.mock('node:fs/promises', async (original) => {
  const actual = await original<typeof import('node:fs/promises')>();
  return {
    ...actual,
    readdir: (async (...args: unknown[]) => {
      await reads.gate;
      return (actual.readdir as (...args: unknown[]) => unknown)(...args);
    }) as unknown as typeof actual.readdir,
  };
});

afterEach(() => {
  vi.unstubAllEnvs();
  reads.gate = undefined;
});

/** Starts a prompt and reports how it settled, listening before any key is sent. */
function settle<T>(promise: Promise<T>): Promise<{ error?: unknown; value?: T }> {
  return promise.then(
    (value) => ({ value }),
    (error: unknown) => ({ error })
  );
}

/** Sends keys one at a time, letting the prompt act on each. */
async function type(stdin: { send(chunk: string): void }, ...chunks: string[]): Promise<void> {
  for (const chunk of chunks) {
    stdin.send(chunk);
    await tick();
  }
}

/** A harness tall enough that a transcript never scrolls off the model. */
function lines(): ScreenHarness {
  return screenSetup({ columns: 100, rows: 24 });
}

/** The output with the paste markers taken out, which the router writes. */
function written(ui: ScreenHarness): string {
  return ui.output.replaceAll('\u001b[?2004h', '').replaceAll('\u001b[?2004l', '');
}

/** The escape sequences in the output, the paste markers aside. */
function sequences(ui: ScreenHarness): string[] {
  // eslint-disable-next-line no-control-regex
  return written(ui).match(/\u001b[^\u001b]{0,8}/g) ?? [];
}

/** Waits for a line form that reads a directory before it asks to have asked. */
async function settleOutput(ui: ScreenHarness): Promise<void> {
  let seen = ui.output;
  for (let still = 0, round = 0; still < 4 && round < 100; round++) {
    await new Promise((resolve) => setTimeout(resolve, 5));
    still = ui.output === seen ? still + 1 : 0;
    seen = ui.output;
  }
}

const ENTER = '\r';
const CTRL_C = '\u0003';
const CTRL_D = '\u0004';
const CTRL_U = '\u0015';
const BACKSPACE = '\u007f';
const ESCAPE = '\u001b';
const LEFT = '\u001b[D';
const UP = '\u001b[A';
const TAB = '\t';
const PASTE_START = '\u001b[200~';
const PASTE_END = '\u001b[201~';

describe('forcedAccessible()', () => {
  it('should read the words a boolean property reads, either way', () => {
    for (const on of ['1', 'on', 'yes', 'true', ' TRUE ']) {
      expect(forcedAccessible({ SIGIL_ACCESSIBLE: on })).toBe(true);
    }
    for (const off of ['0', 'off', 'no', 'false']) {
      expect(forcedAccessible({ SIGIL_ACCESSIBLE: off })).toBe(false);
    }
  });

  it('should leave an empty or unreadable value undecided', () => {
    expect(forcedAccessible({})).toBeUndefined();
    expect(forcedAccessible({ SIGIL_ACCESSIBLE: '' })).toBeUndefined();
    expect(forcedAccessible({ SIGIL_ACCESSIBLE: 'please' })).toBeUndefined();
  });
});

describe('the trigger', () => {
  it('should ask as lines when SIGIL_ACCESSIBLE says so', async () => {
    vi.stubEnv('SIGIL_ACCESSIBLE', '1');
    const ui = lines();
    const answer = text({ ansi: ui.ansi, message: 'Name?', terminal: ui.terminal });

    await type(ui.stdin, 'ok', ENTER);

    expect(await answer).toBe('ok');
    expect(ui.log).toEqual(['Name? ok']);
  });

  it('should let the option beat the variable', async () => {
    vi.stubEnv('SIGIL_ACCESSIBLE', '1');
    const ui = lines();
    const answer = text({
      accessible: false,
      ansi: ui.ansi,
      message: 'Name?',
      terminal: ui.terminal,
    });

    await type(ui.stdin, 'ok', ENTER);

    expect(await answer).toBe('ok');
    // the drawn prompt's mark, which the line form never writes
    expect(ui.log[0]).toMatch(/^[?✔] Name\?/);
  });

  it('should not read a string as on', async () => {
    const ui = lines();
    const answer = text({
      // the trap `setQuiet()` records: a truthy reading turns this on
      accessible: 'false' as unknown as boolean,
      ansi: ui.ansi,
      message: 'Name?',
      terminal: ui.terminal,
    });

    await type(ui.stdin, 'ok', ENTER);

    expect(await answer).toBe('ok');
    expect(ui.log[0]).not.toBe('Name? ok');
  });

  // the non-TTY rule is about whether anybody is there, and the line form is a
  // way to draw a question -- so a pipe still refuses, before anything is written
  it('should still refuse a stdin that is not a terminal', async () => {
    const ui = screenSetup({ inputTTY: false });
    const { error } = await settle(
      text({ accessible: true, message: 'Name?', terminal: ui.terminal })
    );

    expect(error).toBeInstanceOf(PromptError);
    expect((error as PromptError).aborted).toBe(false);
    expect((error as Error).message).toBe(
      'Cannot prompt for "Name?" because the input is not a terminal'
    );
    expect(ui.output).toBe('');
  });

  it('should still refuse a stdout that is not a terminal', async () => {
    const ui = screenSetup({ inputTTY: true, isTTY: false });
    const { error } = await settle(
      select({ accessible: true, choices: ['a'], message: 'Pick', terminal: ui.terminal })
    );

    expect((error as Error).message).toMatch(/because the input is not a terminal/);
  });
});

describe('a line text()', () => {
  it('should write the question once and echo what is typed after it', async () => {
    const ui = lines();
    const answer = text({ accessible: true, message: 'Name?', terminal: ui.terminal });

    await type(ui.stdin, 'c', 'h', 'r', 'i', 's', ENTER);

    expect(await answer).toBe('chris');
    expect(ui.log).toEqual(['Name? chris']);
  });

  it('should write no escape sequence but the paste markers, so nothing is redrawn', async () => {
    const ui = lines();
    const answer = text({
      accessible: true,
      message: 'Name?',
      terminal: ui.terminal,
      validate: (v) => (v === 'no' ? 'Not that' : undefined),
    });

    await type(ui.stdin, 'n', 'o', ENTER, 'abc', BACKSPACE, ENTER);

    expect(await answer).toBe('noab');
    // the cursor is never hidden, which a magnifier follows; nothing is erased
    // with a sequence, and nothing is coloured
    expect(sequences(ui)).toEqual([]);
  });

  it('should leave stdin as it found it', async () => {
    const ui = lines();
    const before = ui.stdin.listenerCount('data');
    const answer = text({ accessible: true, message: 'Name?', terminal: ui.terminal });
    await tick();

    expect(ui.stdin.rawMode).toBe(true);

    await type(ui.stdin, 'x', ENTER);
    await answer;

    expect(ui.stdin.rawMode).toBe(false);
    expect(ui.stdin.listenerCount('data')).toBe(before);
  });

  it('should say its default and answer with it on an empty reply', async () => {
    const ui = lines();
    const answer = text({
      accessible: true,
      default: 'anonymous',
      message: 'Name?',
      terminal: ui.terminal,
    });

    await type(ui.stdin, ENTER);

    expect(await answer).toBe('anonymous');
    expect(ui.log).toEqual(['Name? (default: anonymous)']);
  });

  it('should erase with backspace the way a terminal echoes it, by cluster', async () => {
    const ui = lines();
    const answer = text({ accessible: true, message: 'Q', terminal: ui.terminal });

    await type(ui.stdin, 'ab', '👍', BACKSPACE, BACKSPACE, ENTER);

    expect(await answer).toBe('a');
    expect(ui.log).toEqual(['Q a']);
    // two columns for the emoji, one for the letter: the bytes cooked mode writes
    expect(ui.output).toContain('\b\b  \b\b\b \b');
  });

  it('should clear the reply with ctrl-u', async () => {
    const ui = lines();
    const answer = text({ accessible: true, message: 'Q', terminal: ui.terminal });

    await type(ui.stdin, 'throw away', CTRL_U, 'kept', ENTER);

    expect(await answer).toBe('kept');
    expect(ui.log).toEqual(['Q kept']);
  });

  it('should ignore the keys that edit somewhere other than the end', async () => {
    const ui = lines();
    const answer = text({ accessible: true, message: 'Q', terminal: ui.terminal });

    await type(ui.stdin, 'ac', LEFT, 'b', ENTER);

    expect(await answer).toBe('acb');
  });

  it('should take a paste with its line breaks flattened', async () => {
    const ui = lines();
    const answer = text({ accessible: true, message: 'Q', terminal: ui.terminal });

    await type(ui.stdin, PASTE_START, 'one\ntwo', PASTE_END, ENTER);

    expect(await answer).toBe('one two');
  });

  it('should write a refusal under the reply and ask again holding it', async () => {
    const ui = lines();
    const answer = text({
      accessible: true,
      message: 'Port',
      terminal: ui.terminal,
      validate: (v) => (/^\d+$/.test(v) ? undefined : 'A number, please'),
    });

    await type(ui.stdin, '80x', ENTER, BACKSPACE, ENTER);

    expect(await answer).toBe('80');
    expect(ui.log).toEqual(['Port 80x', 'A number, please', 'Port 80']);
  });

  it('should open on a value, editable', async () => {
    const ui = lines();
    const answer = text({ accessible: true, message: 'Q', terminal: ui.terminal, value: 'abc' });

    await type(ui.stdin, BACKSPACE, 'd', ENTER);

    expect(await answer).toBe('abd');
    expect(ui.log).toEqual(['Q abd']);
  });

  it('should cancel on ctrl-c, leave the transcript, and start a fresh line', async () => {
    const ui = lines();
    const result = settle(text({ accessible: true, message: 'Q', terminal: ui.terminal }));

    await type(ui.stdin, 'hal', CTRL_C);
    const { error } = await result;

    expect(error).toBeInstanceOf(PromptError);
    expect((error as PromptError).aborted).toBe(true);
    expect(ui.log).toEqual(['Q hal']);
    expect(ui.output.endsWith('\r\n')).toBe(true);
    expect(ui.stdin.rawMode).toBe(false);
  });

  it('should reject with the reason of a signal that aborts', async () => {
    const ui = lines();
    const controller = new AbortController();
    const result = settle(
      text({ accessible: true, message: 'Q', signal: controller.signal, terminal: ui.terminal })
    );
    await tick();

    controller.abort(new Error('gone'));
    const { error } = await result;

    expect((error as Error).message).toBe('gone');
    expect(ui.stdin.rawMode).toBe(false);
  });

  it('should go back on Escape only when asked with back', async () => {
    const ui = lines();
    const result = settle(
      text({ accessible: true, back: true, message: 'Q', terminal: ui.terminal })
    );

    await type(ui.stdin, ESCAPE);
    await new Promise((resolve) => setTimeout(resolve, 80));
    const { error } = await result;

    expect(error).toBeInstanceOf(PromptBack);
  });

  it('should reject when input ends', async () => {
    const ui = lines();
    const result = settle(text({ accessible: true, message: 'Q', terminal: ui.terminal }));
    await tick();

    ui.stdin.end();
    const { error } = await result;

    expect((error as Error).message).toBe('Input ended before the prompt was answered');
  });
});

describe('a line password()', () => {
  it('should echo nothing, say no default, and answer what was typed', async () => {
    const ui = lines();
    const answer = password({
      accessible: true,
      default: 'hunter2',
      message: 'Password:',
      terminal: ui.terminal,
    });

    await type(ui.stdin, 's3cret', BACKSPACE, ENTER);

    expect(await answer).toBe('s3cre');
    expect(ui.log).toEqual(['Password:']);
    expect(ui.output).not.toContain('hunter2');
    expect(ui.output).not.toContain('\b');
  });

  it('should still answer with the default on an empty reply', async () => {
    const ui = lines();
    const answer = password({
      accessible: true,
      default: 'hunter2',
      message: 'Password:',
      terminal: ui.terminal,
    });

    await type(ui.stdin, ENTER);

    expect(await answer).toBe('hunter2');
  });

  it('should not open on an earlier answer nobody can see', async () => {
    const ui = lines();
    const answer = password({
      accessible: true,
      message: 'Password:',
      terminal: ui.terminal,
      value: 'old',
    });

    await type(ui.stdin, 'new', ENTER);

    expect(await answer).toBe('new');
  });
});

describe('a line multiline()', () => {
  it('should name the submit key, break lines on Enter, and submit on it', async () => {
    const ui = lines();
    const answer = multiline({ accessible: true, message: 'Notes', terminal: ui.terminal });

    await type(ui.stdin, 'one', ENTER, 'two', CTRL_D);

    expect(await answer).toBe('one\ntwo');
    expect(ui.log).toEqual(['Notes (ctrl-d to submit)', 'one', 'two']);
  });

  it('should honour a submit key of its own', async () => {
    const ui = lines();
    const answer = multiline({
      accessible: true,
      message: 'Notes',
      submit: { meta: true, name: 'enter' },
      terminal: ui.terminal,
    });

    await type(ui.stdin, 'a', ENTER, 'b', '\u001b\r');

    expect(await answer).toBe('a\nb');
    expect(ui.log[0]).toBe('Notes (alt-enter to submit)');
  });

  it('should not erase past the start of the line being typed', async () => {
    const ui = lines();
    const answer = multiline({ accessible: true, message: 'Notes', terminal: ui.terminal });

    await type(ui.stdin, 'ab', ENTER, 'c', BACKSPACE, BACKSPACE, BACKSPACE, 'd', CTRL_D);

    expect(await answer).toBe('ab\nd');
  });

  it('should keep to a character limit and say what it is', async () => {
    const ui = lines();
    const answer = multiline({
      accessible: true,
      charLimit: 3,
      message: 'Notes',
      terminal: ui.terminal,
    });

    await type(ui.stdin, 'abcdef', CTRL_D);

    expect(await answer).toBe('abc');
    expect(ui.log[0]).toBe('Notes (at most 3 characters) (ctrl-d to submit)');
  });

  it('should still refuse its options before asking anything', async () => {
    const ui = lines();
    const { error } = await settle(
      multiline({ accessible: true, charLimit: 0, message: 'Notes', terminal: ui.terminal })
    );

    expect((error as Error).message).toMatch(/charLimit/);
    expect(ui.output).toBe('');
  });

  it('should keep a refused reply to edit', async () => {
    const ui = lines();
    const answer = multiline({
      accessible: true,
      message: 'Notes',
      terminal: ui.terminal,
      validate: (v) => (v.includes('\n') ? undefined : 'Two lines'),
    });

    await type(ui.stdin, 'one', CTRL_D, ENTER, 'two', CTRL_D);

    expect(await answer).toBe('one\ntwo');
    expect(ui.log).toEqual([
      'Notes (ctrl-d to submit)',
      'one',
      'Two lines',
      'Notes (ctrl-d to submit)',
      'one',
      'two',
    ]);
  });
});

describe('a line confirm()', () => {
  it('should take a key or a word, and Enter alone for the default', async () => {
    for (const [reply, expected] of [
      ['y', true],
      ['YES', true],
      ['n', false],
      ['no', false],
      ['', true],
    ] as const) {
      const ui = lines();
      const answer = confirm({ accessible: true, message: 'Go?', terminal: ui.terminal });

      await type(ui.stdin, ...(reply ? [reply] : []), ENTER);

      expect(await answer).toBe(expected);
      expect(ui.log[0]).toBe(`Go? (Y/n) ${reply}`.trimEnd());
    }
  });

  it('should refuse anything else and ask again', async () => {
    const ui = lines();
    const answer = confirm({
      accessible: true,
      default: false,
      message: 'Go?',
      terminal: ui.terminal,
    });

    await type(ui.stdin, 'yep', ENTER, 'y', ENTER);

    expect(await answer).toBe(true);
    expect(ui.log).toEqual(['Go? (y/N) yep', 'Answer y or n', 'Go? (y/N) y']);
  });
});

describe('a line select()', () => {
  const choices = [
    separator('Warm'),
    { hint: 'hot', label: 'Red', value: 'r' },
    { disabled: 'sold out', label: 'Orange', value: 'o' },
    separator(),
    { description: 'Like the sea', label: 'Blue', value: 'b' },
    'Green',
  ];

  it('should number what can be chosen and list the rest', async () => {
    const ui = lines();
    const answer = select({ accessible: true, choices, message: 'Colour', terminal: ui.terminal });

    await type(ui.stdin, '2', ENTER);

    expect(await answer).toBe('b');
    expect(ui.log).toEqual([
      'Colour',
      '  Warm',
      '  1. Red (hot)',
      '  - Orange (sold out)',
      // a rule of box-drawing characters is a picture, and is not written
      '  2. Blue',
      '    Like the sea',
      '  3. Green',
      'Choose a number from 1 to 3 (default: 1) 2',
      'Chosen: Blue',
    ]);
  });

  it('should answer the highlight it would have opened on, by value or initial', async () => {
    const ui = lines();
    const answer = select({
      accessible: true,
      choices,
      message: 'Colour',
      terminal: ui.terminal,
      value: 'Green',
    });

    await type(ui.stdin, ENTER);

    expect(await answer).toBe('Green');
    expect(ui.log).toContain('Choose a number from 1 to 3 (default: 3)');
  });

  it('should refuse a number that names nothing and ask again', async () => {
    const ui = lines();
    const answer = select({ accessible: true, choices, message: 'Colour', terminal: ui.terminal });

    await type(ui.stdin, '4', ENTER, 'x', ENTER, '1', ENTER);

    expect(await answer).toBe('r');
    expect(ui.log.filter((line) => line.startsWith('Enter'))).toEqual([
      'Enter a number from 1 to 3',
      'Enter a number from 1 to 3',
    ]);
  });

  it('should still refuse a list with nothing on offer', async () => {
    const ui = lines();
    const { error } = await settle(
      select({ accessible: true, choices: [], message: 'Colour', terminal: ui.terminal })
    );

    expect((error as Error).message).toBe('"Colour" has no choices to offer');
  });
});

describe('a line multiselect()', () => {
  const choices = [
    { label: 'a', selected: true },
    { label: 'b' },
    { disabled: true, label: 'c' },
    { label: 'd', selected: true },
    { label: 'e' },
  ];

  it('should take numbers and ranges, and replace the selection with them', async () => {
    const ui = lines();
    const answer = multiselect({
      accessible: true,
      choices,
      message: 'Letters',
      terminal: ui.terminal,
    });

    await type(ui.stdin, '4, 1-2', ENTER);

    expect(await answer).toEqual(['a', 'b', 'e']);
    expect(ui.log).toEqual([
      'Letters',
      '  1. a',
      '  2. b',
      '  - c (disabled)',
      '  3. d',
      '  4. e',
      'Choose numbers from 1 to 4, separated by commas (default: 1, 3) 4, 1-2',
      'Chosen: a, b, e',
    ]);
  });

  it('should keep what was ticked on an empty reply, and take none for nothing', async () => {
    const kept = lines();
    const first = multiselect({ accessible: true, choices, message: 'L', terminal: kept.terminal });
    await type(kept.stdin, ENTER);
    expect(await first).toEqual(['a', 'd']);

    const cleared = lines();
    const second = multiselect({
      accessible: true,
      choices,
      message: 'L',
      terminal: cleared.terminal,
    });
    await type(cleared.stdin, 'None', ENTER);
    expect(await second).toEqual([]);
    expect(cleared.log.at(-1)).toBe('Chosen: none');
  });

  it('should refuse a token it cannot read, and a count outside min and max', async () => {
    const ui = lines();
    const answer = multiselect({
      accessible: true,
      choices,
      max: 2,
      message: 'L',
      min: 1,
      terminal: ui.terminal,
    });

    await type(ui.stdin, '9', ENTER, 'none', ENTER, '1-3', ENTER, '2', ENTER);

    expect(await answer).toEqual(['b']);
    expect(ui.log.filter((line) => !line.startsWith('  ') && !line.startsWith('Choose n'))).toEqual(
      [
        'L',
        '"9" is not a number from 1 to 4',
        'Choose at least one',
        'Choose at most 2',
        'Chosen: b',
      ]
    );
  });
});

describe('a line number()', () => {
  it('should say its default and answer with it on an empty reply', async () => {
    const ui = lines();
    const answer = number({
      accessible: true,
      default: 8080,
      message: 'Port',
      terminal: ui.terminal,
    });

    await type(ui.stdin, ENTER);

    expect(await answer).toBe(8080);
    expect(ui.log).toEqual(['Port (default: 8080)']);
  });

  it("should refuse what the drawn field refuses as typed, in the parser's words", async () => {
    const ui = lines();
    const answer = number({ accessible: true, message: 'N', terminal: ui.terminal });

    await type(ui.stdin, 'abc', ENTER, CTRL_U, '0x10', ENTER, CTRL_U, '-', ENTER);
    await type(ui.stdin, CTRL_U, ENTER, '42', ENTER);

    expect(await answer).toBe(42);
    expect(ui.log).toEqual([
      'N abc',
      'Invalid integer: abc',
      'N 0x10',
      // the parser reads `0x10` as 16, and the drawn field would not let it be typed
      'Invalid integer: 0x10',
      'N -',
      'Invalid integer: -',
      'N',
      'Enter a number',
      'N 42',
    ]);
  });

  it('should hold the reply to the range and ask again holding it', async () => {
    const ui = lines();
    const answer = number({
      accessible: true,
      max: 10,
      message: 'N',
      min: 1,
      terminal: ui.terminal,
      validate: (n) => (n % 2 ? 'Even, please' : undefined),
    });

    await type(ui.stdin, '0', ENTER, BACKSPACE, '11', ENTER, BACKSPACE, BACKSPACE, '-3', ENTER);
    await type(ui.stdin, BACKSPACE, BACKSPACE, '5', ENTER, BACKSPACE, '6', ENTER);

    expect(await answer).toBe(6);
    expect(ui.log).toEqual([
      'N 0',
      'Must be at least 1',
      'N 11',
      'Must be at most 10',
      // a `-` below a `min` of 0 is the range's to refuse, which says so
      'N -3',
      'Must be at least 1',
      'N 5',
      'Even, please',
      'N 6',
    ]);
  });

  it('should take a fraction only with float', async () => {
    const whole = lines();
    const int = number({ accessible: true, message: 'N', terminal: whole.terminal });
    await type(whole.stdin, '0.5', ENTER, CTRL_U, '2', ENTER);
    expect(await int).toBe(2);
    expect(whole.log[1]).toBe('Invalid integer: 0.5');

    const part = lines();
    const float = number({ accessible: true, float: true, message: 'N', terminal: part.terminal });
    await type(part.stdin, '1e3', ENTER, CTRL_U, 'Infinity', ENTER, CTRL_U, '-.25', ENTER);
    expect(await float).toBe(-0.25);
    // both are numbers to the parser, and neither can be typed in the drawn field
    expect(part.log.filter((line) => line.startsWith('Invalid'))).toEqual([
      'Invalid number: 1e3',
      'Invalid number: Infinity',
    ]);
  });

  it('should open on a value, editable, and not step on Up', async () => {
    const ui = lines();
    const answer = number({ accessible: true, message: 'N', terminal: ui.terminal, value: 12 });

    await type(ui.stdin, UP, '3', ENTER);

    expect(await answer).toBe(123);
    expect(ui.log).toEqual(['N 123']);
  });
});

describe('a line list()', () => {
  it('should read the reply the way the drawn field does', async () => {
    const ui = lines();
    const answer = list({ accessible: true, message: 'Tags', terminal: ui.terminal });

    await type(ui.stdin, 'api, web ,, db', ENTER);

    expect(await answer).toEqual(['api', 'web', 'db']);
    expect(ui.log).toEqual(['Tags api, web ,, db']);
  });

  it('should say its default and answer with it on a reply with no entries', async () => {
    const ui = lines();
    const answer = list({
      accessible: true,
      default: ['a', 'b'],
      message: 'Tags',
      terminal: ui.terminal,
    });

    await type(ui.stdin, ', ,', ENTER);

    expect(await answer).toEqual(['a', 'b']);
    expect(ui.log).toEqual(['Tags (default: a, b) , ,']);
  });

  it('should open on initial joined, and keep a refused reply to edit', async () => {
    const ui = lines();
    const answer = list({
      accessible: true,
      initial: ['a', 'b'],
      message: 'Hosts',
      separator: ' ',
      terminal: ui.terminal,
      validate: (items) => (items.length < 3 ? 'Three, please' : undefined),
    });

    await type(ui.stdin, ENTER, ' c', ENTER);

    expect(await answer).toEqual(['a', 'b', 'c']);
    expect(ui.log).toEqual(['Hosts a b', 'Three, please', 'Hosts a b c']);
  });
});

describe('a line path()', () => {
  it('should answer what was typed', async () => {
    const ui = lines();
    const root = import.meta.dirname;
    const answer = path({ accessible: true, message: 'File', root, terminal: ui.terminal });

    await type(ui.stdin, 'prompt-', ENTER);

    expect(await answer).toBe(resolve(root, 'prompt-'));
    expect(ui.log).toEqual(['File prompt-']);
  });

  it('should answer as typed without a root, and expand a ~', async () => {
    const plain = lines();
    const typed = path({ accessible: true, message: 'File', terminal: plain.terminal });
    await type(plain.stdin, 'notes.txt', ENTER);
    expect(await typed).toBe('notes.txt');

    const home = lines();
    const tilde = path({ accessible: true, message: 'File', terminal: home.terminal });
    await type(home.stdin, '~', ENTER);
    expect(await tilde).toBe(baseDir('~'));
  });

  it('should hand validate the answer in the form it is returned in', async () => {
    const ui = lines();
    const root = import.meta.dirname;
    const seen: string[] = [];
    const answer = path({
      accessible: true,
      message: 'File',
      root,
      terminal: ui.terminal,
      validate: (v) => {
        seen.push(v);
        return seen.length === 1 ? 'Not that one' : undefined;
      },
      value: 'a',
    });

    await type(ui.stdin, ENTER, 'b', ENTER);

    expect(await answer).toBe(resolve(root, 'ab'));
    expect(seen).toEqual([resolve(root, 'a'), resolve(root, 'ab')]);
    expect(ui.log).toEqual(['File a', 'Not that one', 'File ab']);
  });
});

describe('a line path() completing on Tab', () => {
  let root: string;

  /** Wide enough that no temporary path wraps, wherever the platform puts one. */
  const wide = (): ScreenHarness => screenSetup({ columns: 1000, rows: 40 });

  /** A line `path()` over the fixture. */
  const ask = (ui: ScreenHarness, extra: Partial<Parameters<typeof path>[0]> = {}) =>
    path({ accessible: true, message: 'File', root, terminal: ui.terminal, ...extra });

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'sigil-accessible-path-'));
    await mkdir(join(root, 'src'));
    await writeFile(join(root, 'src', 'index.ts'), '');
    await writeFile(join(root, 'notes.md'), '');
    await writeFile(join(root, 'report-2024.txt'), '');
    await writeFile(join(root, 'report-2025.txt'), '');
    await writeFile(join(root, '.env'), '');
  });

  afterEach(async () => {
    await rm(root, { force: true, recursive: true });
  });

  it('should complete a unique candidate in full, echoing only what it adds', async () => {
    const ui = wide();
    const answer = ask(ui);

    await type(ui.stdin, 'n', TAB);
    await settleOutput(ui);
    await type(ui.stdin, ENTER);

    expect(await answer).toBe(join(root, 'notes.md'));
    expect(ui.log).toEqual(['File notes.md']);
    // every byte, so the `n` typed is not written a second time by the Tab
    expect(written(ui)).toBe('File notes.md\r\n');
  });

  it('should add the prefix the candidates share, and nothing on a Tab with no more', async () => {
    const ui = wide();
    const answer = ask(ui);

    await type(ui.stdin, 'r', TAB);
    await settleOutput(ui);
    expect(ui.log).toEqual(['File report-202']);

    await type(ui.stdin, '5', TAB);
    await settleOutput(ui);
    // one candidate left, completed in full
    expect(ui.log).toEqual(['File report-2025.txt']);

    await type(ui.stdin, ENTER);
    expect(await answer).toBe(join(root, 'report-2025.txt'));
  });

  it('should list the candidates on a second Tab and ask again holding the reply', async () => {
    const ui = wide();
    const answer = ask(ui);

    await type(ui.stdin, 'r', TAB, TAB);
    await settleOutput(ui);
    await type(ui.stdin, '4', ENTER);

    expect(await answer).toBe(join(root, 'report-2024'));
    expect(ui.log).toEqual([
      'File report-202',
      '  report-2024.txt',
      '  report-2025.txt',
      'File report-2024',
    ]);
  });

  it('should be silent on a first Tab that adds nothing, and list on the second', async () => {
    const ui = wide();
    const answer = settle(ask(ui));

    await type(ui.stdin, TAB);
    await settleOutput(ui);
    expect(ui.log).toEqual(['File']);

    await type(ui.stdin, TAB);
    await settleOutput(ui);
    await type(ui.stdin, CTRL_C);
    await answer;

    // directories first, by code unit, and no dotfile: the drawn list's order and filter
    expect(ui.log).toEqual([
      'File',
      `  src${sep}`,
      '  notes.md',
      '  report-2024.txt',
      '  report-2025.txt',
      'File',
    ]);
  });

  it('should not count two Tabs with a key between them as a second Tab', async () => {
    const ui = wide();
    const answer = settle(ask(ui));

    await type(ui.stdin, 'report-202', TAB, '4', BACKSPACE, TAB);
    await settleOutput(ui);
    await type(ui.stdin, CTRL_C);
    await answer;

    expect(ui.log).toEqual(['File report-202']);
  });

  it('should say No matches on a Tab with no candidates, and ask again holding the reply', async () => {
    const ui = wide();
    const answer = ask(ui);

    await type(ui.stdin, 'z', TAB);
    await settleOutput(ui);
    await type(ui.stdin, 'q', ENTER);

    expect(await answer).toBe(join(root, 'zq'));
    expect(ui.log).toEqual(['File z', 'No matches', 'File zq']);
  });

  it('should complete a directory with a separator, and carry on inside it', async () => {
    const ui = wide();
    const answer = ask(ui);

    await type(ui.stdin, 's', TAB);
    await settleOutput(ui);
    expect(ui.log).toEqual([`File src${sep}`]);

    await type(ui.stdin, TAB);
    await settleOutput(ui);
    await type(ui.stdin, ENTER);

    expect(await answer).toBe(join(root, 'src', 'index.ts'));
    expect(ui.log).toEqual([`File src${sep}index.ts`]);
  });

  it('should offer what the drawn field offers: dotfiles on a dot, and the options', async () => {
    const dotted = wide();
    const dot = ask(dotted);
    await type(dotted.stdin, '.', TAB);
    await settleOutput(dotted);
    await type(dotted.stdin, ENTER);
    expect(await dot).toBe(join(root, '.env'));

    const dirs = wide();
    const dir = ask(dirs, { directory: true });
    await type(dirs.stdin, TAB);
    await settleOutput(dirs);
    await type(dirs.stdin, ENTER);
    // `src` is the only directory, so the one candidate
    expect(dirs.log).toEqual([`File src${sep}`]);
    expect(await dir).toBe(join(root, 'src'));

    const typed = wide();
    const ext = settle(ask(typed, { extensions: ['md'] }));
    await type(typed.stdin, TAB, TAB);
    await settleOutput(typed);
    await type(typed.stdin, CTRL_C);
    await ext;
    expect(typed.log).toEqual(['File', `  src${sep}`, '  notes.md', 'File']);
  });

  it('should hold the keys typed after a Tab until its read lands, in the order typed', async () => {
    const ui = wide();
    let release!: () => void;
    reads.gate = new Promise((resolve) => (release = resolve));
    const answer = ask(ui);

    await type(ui.stdin, 'r', TAB, '5', ENTER);
    // the read is still out, so neither what the Tab adds nor what follows it
    // has been written
    expect(ui.log).toEqual(['File r']);

    release();
    expect(await answer).toBe(join(root, 'report-2025'));
    expect(ui.log).toEqual(['File report-2025']);
  });

  it('should be cancelled by ctrl-c while a Tab is still reading', async () => {
    const ui = wide();
    let release!: () => void;
    reads.gate = new Promise((resolve) => (release = resolve));
    const result = settle(ask(ui));

    await type(ui.stdin, 'r', TAB, CTRL_C);
    const { error } = await result;
    expect((error as PromptError).aborted).toBe(true);
    expect(ui.stdin.rawMode).toBe(false);

    // the read landing afterwards adds nothing to a question nobody is asking
    release();
    await settleOutput(ui);
    expect(ui.log).toEqual(['File r']);
  });

  it('should write no escape sequence but the paste markers while completing', async () => {
    const ui = wide();
    const answer = ask(ui);

    await type(ui.stdin, 'z', TAB, BACKSPACE, 'r', TAB, TAB);
    await settleOutput(ui);
    await type(ui.stdin, '5', TAB);
    await settleOutput(ui);
    await type(ui.stdin, ENTER);

    expect(await answer).toBe(join(root, 'report-2025.txt'));
    expect(sequences(ui)).toEqual([]);
  });
});

describe('a line path() asking before a long list', () => {
  let fixture: string;

  /** Tall enough that a list of a hundred and one never scrolls off the model. */
  const tall = (): ScreenHarness => screenSetup({ columns: 1000, rows: 260 });

  /**
   * A line `path()` rooted in one of the fixture's directories, so nothing is
   * typed before the Tab and no separator is spelled.
   */
  const ask = (ui: ScreenHarness, dir: string, extra: Partial<Parameters<typeof path>[0]> = {}) =>
    path({
      accessible: true,
      message: 'File',
      root: join(fixture, dir),
      terminal: ui.terminal,
      ...extra,
    });

  /** The names in a directory of `count`: `f-0` on, so a first Tab adds `f-`. */
  const names = (count: number): string[] => Array.from({ length: count }, (_, i) => `f-${i}`);

  /** The list a yes writes, in the drawn list's order, which is by code unit. */
  const listed = (count: number): string[] =>
    names(count)
      .sort()
      .map((name) => `  ${name}`);

  const QUESTION_AT = 'Display all 100 possibilities? (y/N)';

  beforeAll(async () => {
    fixture = await mkdtemp(join(tmpdir(), 'sigil-accessible-many-'));
    // one under the threshold, at it, and one over
    for (const [dir, count] of [
      ['under', 99],
      ['at', 100],
      ['over', 101],
    ] as const) {
      await mkdir(join(fixture, dir));
      await Promise.all(names(count).map((name) => writeFile(join(fixture, dir, name), '')));
    }
  });

  afterAll(async () => {
    await rm(fixture, { force: true, recursive: true });
  });

  /** Tab, Tab, and waits for the question or the list. */
  async function tabTab(ui: ScreenHarness): Promise<void> {
    await type(ui.stdin, TAB);
    await settleOutput(ui);
    await type(ui.stdin, TAB);
    await settleOutput(ui);
  }

  it('should list one short of the threshold without asking', async () => {
    const ui = tall();
    const answer = ask(ui, 'under');

    await tabTab(ui);
    await type(ui.stdin, '7', ENTER);

    expect(await answer).toBe(join(fixture, 'under', 'f-7'));
    expect(ui.log).toEqual(['File f-', ...listed(99), 'File f-7']);
  });

  it('should ask instead of listing at the threshold, and wait for a key', async () => {
    const ui = tall();
    const result = settle(ask(ui, 'at'));

    await tabTab(ui);
    expect(ui.log).toEqual(['File f-', QUESTION_AT]);

    await type(ui.stdin, CTRL_C);
    await result;
  });

  it('should ask over the threshold, saying how many', async () => {
    const ui = tall();
    const result = settle(ask(ui, 'over'));

    await tabTab(ui);
    expect(ui.log).toEqual(['File f-', 'Display all 101 possibilities? (y/N)']);

    await type(ui.stdin, CTRL_C);
    await result;
  });

  it.each([
    ['y', 'y'],
    ['Y', 'Y'],
    ['Space', ' '],
  ])('should list on %s, then ask again holding the reply', async (_, key) => {
    const ui = tall();
    const answer = ask(ui, 'at');

    await tabTab(ui);
    await type(ui.stdin, key);
    await settleOutput(ui);
    // the key that answered is not echoed: it answered the question, not the reply
    expect(ui.log).toEqual(['File f-', QUESTION_AT, ...listed(100), 'File f-']);

    await type(ui.stdin, '42', ENTER);

    expect(await answer).toBe(join(fixture, 'at', 'f-42'));
    expect(ui.log).toEqual(['File f-', QUESTION_AT, ...listed(100), 'File f-42']);
  });

  it.each([
    ['n', 'n'],
    ['N', 'N'],
    ['Backspace', BACKSPACE],
    ['Delete', '\u001b[3~'],
    ['Enter', ENTER],
  ])('should list nothing on %s, and ask again holding the reply', async (_, key) => {
    const ui = tall();
    const answer = ask(ui, 'at');

    await tabTab(ui);
    await type(ui.stdin, key);
    await settleOutput(ui);
    expect(ui.log).toEqual(['File f-', QUESTION_AT, 'File f-']);

    await type(ui.stdin, '9', ENTER);

    // Backspace answered the question and erased nothing, and Enter answered it
    // rather than the prompt
    expect(await answer).toBe(join(fixture, 'at', 'f-9'));
    expect(ui.log).toEqual(['File f-', QUESTION_AT, 'File f-9']);
  });

  it('should list nothing on Escape, even with back', async () => {
    const ui = tall();
    const answer = ask(ui, 'at', { back: true });

    await tabTab(ui);
    await type(ui.stdin, ESCAPE);
    // a lone Escape waits out the router's timeout before it is a key
    await new Promise((resolve) => setTimeout(resolve, 80));
    await settleOutput(ui);
    expect(ui.log).toEqual(['File f-', QUESTION_AT, 'File f-']);

    await type(ui.stdin, '9', ENTER);

    expect(await answer).toBe(join(fixture, 'at', 'f-9'));
    expect(ui.log).toEqual(['File f-', QUESTION_AT, 'File f-9']);
  });

  it('should go back on Escape with back once the question is answered', async () => {
    const ui = tall();
    const result = settle(ask(ui, 'at', { back: true }));

    await tabTab(ui);
    await type(ui.stdin, 'n');
    await settleOutput(ui);
    await type(ui.stdin, ESCAPE);
    await new Promise((resolve) => setTimeout(resolve, 80));
    const { error } = await result;

    expect(error).toBeInstanceOf(PromptBack);
  });

  it('should refuse any other key during the question, and ask it again', async () => {
    const ui = tall();
    const answer = ask(ui, 'at');

    await tabTab(ui);
    // a letter, a third Tab and a modified y are none of them answers
    await type(ui.stdin, 'x');
    await settleOutput(ui);
    await type(ui.stdin, TAB);
    await settleOutput(ui);
    await type(ui.stdin, '\u0019'); // ctrl-y
    await settleOutput(ui);
    await type(ui.stdin, 'n');
    await settleOutput(ui);
    await type(ui.stdin, '3', ENTER);

    // nothing refused was typed into the reply
    expect(await answer).toBe(join(fixture, 'at', 'f-3'));
    expect(ui.log).toEqual([
      'File f-',
      QUESTION_AT,
      'Answer y or n',
      QUESTION_AT,
      'Answer y or n',
      QUESTION_AT,
      'Answer y or n',
      QUESTION_AT,
      'File f-3',
    ]);
  });

  it('should take the key that answered as one between, so the next Tab is a first', async () => {
    const ui = tall();
    const result = settle(ask(ui, 'at'));

    await tabTab(ui);
    await type(ui.stdin, 'n');
    await settleOutput(ui);
    await type(ui.stdin, TAB);
    await settleOutput(ui);
    // silent, as any first Tab that adds nothing is
    expect(ui.log).toEqual(['File f-', QUESTION_AT, 'File f-']);

    await type(ui.stdin, TAB);
    await settleOutput(ui);
    expect(ui.log).toEqual(['File f-', QUESTION_AT, 'File f-', QUESTION_AT]);

    await type(ui.stdin, CTRL_C);
    await result;
  });

  it('should set the question aside for a paste, and type the paste', async () => {
    const ui = tall();
    const answer = ask(ui, 'at');

    await tabTab(ui);
    await type(ui.stdin, PASTE_START + '12' + PASTE_END);
    await settleOutput(ui);
    expect(ui.log).toEqual(['File f-', QUESTION_AT, 'File f-12']);

    await type(ui.stdin, ENTER);

    expect(await answer).toBe(join(fixture, 'at', 'f-12'));
    expect(ui.log).toEqual(['File f-', QUESTION_AT, 'File f-12']);
  });

  it('should be cancelled by ctrl-c while the question waits', async () => {
    const ui = tall();
    const result = settle(ask(ui, 'at'));

    await tabTab(ui);
    await type(ui.stdin, CTRL_C);
    const { error } = await result;

    expect(error).toBeInstanceOf(PromptError);
    expect((error as PromptError).aborted).toBe(true);
    expect(ui.stdin.rawMode).toBe(false);
    // the question stays where it is, and the next output starts under it
    expect(written(ui)).toBe(`File f-\r\n${QUESTION_AT} \r\n`);
  });

  it('should reject with the reason of a signal that aborts while the question waits', async () => {
    const ui = tall();
    const controller = new AbortController();
    const result = settle(ask(ui, 'at', { signal: controller.signal }));

    await tabTab(ui);
    controller.abort(new Error('gone'));
    const { error } = await result;

    expect((error as Error).message).toBe('gone');
    expect(ui.stdin.rawMode).toBe(false);
  });

  it('should reject when input ends while the question waits', async () => {
    const ui = tall();
    const result = settle(ask(ui, 'at'));

    await tabTab(ui);
    ui.stdin.end();
    const { error } = await result;

    expect((error as Error).message).toBe('Input ended before the prompt was answered');
  });

  it('should write exactly the question, then the list or nothing, and no sequence', async () => {
    const no = tall();
    const declined = ask(no, 'at');
    await tabTab(no);
    await type(no.stdin, 'n');
    await settleOutput(no);
    await type(no.stdin, ENTER);
    await declined;
    expect(written(no)).toBe(`File f-\r\n${QUESTION_AT} \r\nFile f-\r\n`);

    const yes = tall();
    const accepted = ask(yes, 'at');
    await tabTab(yes);
    await type(yes.stdin, 'x');
    await settleOutput(yes);
    await type(yes.stdin, 'y');
    await settleOutput(yes);
    await type(yes.stdin, ENTER);
    await accepted;
    expect(written(yes)).toBe(
      `File f-\r\n${QUESTION_AT} \r\nAnswer y or n\r\n${QUESTION_AT} \r\n` +
        listed(100)
          .map((line) => `${line}\r\n`)
          .join('') +
        'File f-\r\n'
    );
    expect(sequences(yes)).toEqual([]);
  });
});

describe('a line maskedText()', () => {
  const template = '(###) ###-####';

  it('should say the template, echo only what is typed, and say what it read', async () => {
    const ui = lines();
    const answer = maskedText({
      accessible: true,
      message: 'Phone',
      template,
      terminal: ui.terminal,
    });

    await type(ui.stdin, '5551234567', ENTER);

    expect(await answer).toBe('(555) 123-4567');
    expect(ui.log).toEqual([
      'Phone (format: (___) ___-____) 5551234567',
      'Entered: (555) 123-4567',
    ]);
  });

  it('should take the reply formatted, and say nothing more', async () => {
    const ui = lines();
    const answer = maskedText({
      accessible: true,
      message: 'Phone',
      template,
      terminal: ui.terminal,
    });

    await type(ui.stdin, '(555) 123-4567', ENTER);

    expect(await answer).toBe('(555) 123-4567');
    expect(ui.log).toEqual(['Phone (format: (___) ___-____) (555) 123-4567']);
  });

  it('should refuse a character that fits nowhere rather than drop it', async () => {
    const ui = lines();
    const answer = maskedText({ accessible: true, message: 'P', template, terminal: ui.terminal });

    await type(ui.stdin, '555x', ENTER, BACKSPACE, ENTER, '12345678', ENTER, BACKSPACE, ENTER);

    expect(await answer).toBe('(555) 123-4567');
    expect(ui.log.filter((line) => !line.startsWith('P '))).toEqual([
      '"x" does not fit (___) ___-____',
      'Fill in every blank',
      // one past the last slot is refused too, not cut off
      '"8" does not fit (___) ___-____',
      'Entered: (555) 123-4567',
    ]);
  });

  it('should say its default and answer with it on an empty reply', async () => {
    const ui = lines();
    const answer = maskedText({
      accessible: true,
      default: '5551234567',
      message: 'Phone',
      template,
      terminal: ui.terminal,
    });

    await type(ui.stdin, ENTER);

    expect(await answer).toBe('(555) 123-4567');
    expect(ui.log).toEqual(['Phone (format: (___) ___-____) (default: (555) 123-4567)']);
  });

  it('should open on initial as far as it fills, and apply a slot transform', async () => {
    const opened = lines();
    const phone = maskedText({
      accessible: true,
      initial: '555',
      message: 'P',
      template,
      terminal: opened.terminal,
    });
    await type(opened.stdin, '1234567', ENTER);
    expect(await phone).toBe('(555) 123-4567');
    expect(opened.log[0]).toBe('P (format: (___) ___-____) (5551234567');

    const keyed = lines();
    const key = maskedText({
      accessible: true,
      message: 'Key',
      slots: { K: { match: /[a-z]/i, transform: (ch) => ch.toUpperCase() } },
      template: 'KK-KK',
      terminal: keyed.terminal,
    });
    await type(keyed.stdin, 'abcd', ENTER);
    expect(await key).toBe('AB-CD');
    expect(keyed.log).toEqual(['Key (format: __-__) abcd', 'Entered: AB-CD']);
  });
});

describe('a line toggle()', () => {
  it('should name both states, say the default in words, and take a whole name', async () => {
    const ui = lines();
    const answer = toggle({
      accessible: true,
      active: 'enabled',
      inactive: 'disabled',
      initial: true,
      message: 'Notifications',
      terminal: ui.terminal,
    });

    await type(ui.stdin, 'DISABLED', ENTER);

    expect(await answer).toBe(false);
    expect(ui.log).toEqual(['Notifications (disabled/enabled) (default: enabled) DISABLED']);
  });

  it('should keep the state it opened in on Enter alone', async () => {
    for (const [opts, expected] of [
      [{}, false],
      [{ initial: true }, true],
      [{ initial: true, value: false }, false],
    ] as const) {
      const ui = lines();
      const answer = toggle({ ...opts, accessible: true, message: 'Q', terminal: ui.terminal });

      await type(ui.stdin, ENTER);

      expect(await answer).toBe(expected);
      expect(ui.log).toEqual([`Q (off/on) (default: ${expected ? 'on' : 'off'})`]);
    }
  });

  it('should refuse a first letter, which on and off share, and ask again', async () => {
    const ui = lines();
    const answer = toggle({ accessible: true, message: 'Q', terminal: ui.terminal });

    await type(ui.stdin, 'o', ENTER, CTRL_U, 'on', ENTER);

    expect(await answer).toBe(true);
    expect(ui.log).toEqual([
      'Q (off/on) (default: off) o',
      'Answer off or on',
      'Q (off/on) (default: off) on',
    ]);
  });

  it('should tell apart two names that differ only in case by their case', async () => {
    const ui = lines();
    const answer = toggle({
      accessible: true,
      active: 'On',
      inactive: 'on',
      message: 'Q',
      terminal: ui.terminal,
    });

    await type(ui.stdin, 'ON', ENTER, CTRL_U, 'On', ENTER);

    expect(await answer).toBe(true);
    expect(ui.log[1]).toBe('Answer on or On');
  });
});

describe('a line selectKey()', () => {
  const choices = [
    separator('When it exists'),
    { key: 'o', label: 'Overwrite', value: 'overwrite' },
    { hint: 'keep yours', key: 's', label: 'Skip', value: 'skip' },
    { disabled: 'no diff tool', key: 'd', label: 'Diff', value: 'diff' },
    separator(),
    { key: 'a', label: 'All', short: 'all of them', value: 'all' },
  ];

  it('should list the choices by their keys, and take a key', async () => {
    const ui = lines();
    const answer = selectKey({
      accessible: true,
      choices,
      initial: 's',
      message: 'File exists',
      terminal: ui.terminal,
    });

    await type(ui.stdin, 'O', ENTER);

    expect(await answer).toBe('overwrite');
    expect(ui.log).toEqual([
      'File exists',
      '  When it exists',
      '  o) Overwrite',
      '  s) Skip (keep yours)',
      '  - Diff (no diff tool)',
      // a rule of box-drawing characters is a picture, and is not written
      '  a) All',
      'Choose a key (default: s) O',
      'Chosen: Overwrite',
    ]);
  });

  it('should refuse a label, a position and a disabled key', async () => {
    const ui = lines();
    const answer = selectKey({ accessible: true, choices, message: 'F', terminal: ui.terminal });

    await type(ui.stdin, 'Overwrite', ENTER, CTRL_U, '1', ENTER, CTRL_U, 'd', ENTER);
    // with no `initial` Enter alone has nothing to take
    await type(ui.stdin, CTRL_U, ENTER, 'a', ENTER);

    expect(await answer).toBe('all');
    expect(ui.log.filter((line) => line.startsWith('Enter'))).toEqual([
      'Enter one of o, s, a',
      'Enter one of o, s, a',
      'Enter one of o, s, a',
      'Enter one of o, s, a',
    ]);
    expect(ui.log.at(-1)).toBe('Chosen: all of them');
  });

  it('should take a numbered choice by its number, and Enter alone for value', async () => {
    const numbered = lines();
    const node = selectKey({
      accessible: true,
      choices: ['Node 18', 'Node 20'],
      message: 'Runtime',
      numbered: true,
      terminal: numbered.terminal,
    });
    await type(numbered.stdin, '2', ENTER);
    expect(await node).toBe('Node 20');
    expect(numbered.log.slice(1, 3)).toEqual(['  1) Node 18', '  2) Node 20']);

    const kept = lines();
    const again = selectKey({
      accessible: true,
      choices,
      initial: 's',
      message: 'F',
      terminal: kept.terminal,
      value: 'all',
    });
    await type(kept.stdin, ENTER);
    expect(await again).toBe('all');
    expect(kept.log).toContain('Choose a key (default: a)');
  });

  it('should write the list with expand too', async () => {
    const ui = lines();
    const answer = selectKey({
      accessible: true,
      choices,
      expand: true,
      message: 'F',
      terminal: ui.terminal,
    });

    await type(ui.stdin, 's', ENTER);

    expect(await answer).toBe('skip');
    expect(ui.log).toContain('  o) Overwrite');
  });

  it('should still refuse its options before asking anything', async () => {
    const ui = lines();
    const { error } = await settle(
      selectKey({
        accessible: true,
        choices: [{ key: 'h', label: 'Help me', value: 1 }],
        expand: true,
        message: 'F',
        terminal: ui.terminal,
      })
    );

    expect((error as Error).message).toMatch(/keeps for help/);
    expect(ui.output).toBe('');
  });
});

describe('the six line forms SIG-227 added', () => {
  // a directory of its own for path(), whose Tab and drawn list both read one:
  // the working directory is whatever the runner was started in. Two names that
  // share nothing, so the first Tab adds nothing and `a` then Tab completes
  let fixture: string;

  beforeEach(async () => {
    fixture = await mkdtemp(join(tmpdir(), 'sigil-accessible-forms-'));
    await writeFile(join(fixture, 'alpha.txt'), '');
    await writeFile(join(fixture, 'beta.txt'), '');
  });

  afterEach(async () => {
    await rm(fixture, { force: true, recursive: true });
  });

  // each asked through a refusal and an answer, which is the most a line form
  // writes, and held to the same bytes rule as the first six
  it.each([
    [
      'number',
      (ui: ScreenHarness) => number({ accessible: true, message: 'Q', terminal: ui.terminal }),
      ['x', ENTER, CTRL_U, '1', ENTER],
    ],
    [
      'list',
      (ui: ScreenHarness) =>
        list({
          accessible: true,
          message: 'Q',
          terminal: ui.terminal,
          validate: (v) => (v.length ? undefined : 'No'),
        }),
      [ENTER, 'a', ENTER],
    ],
    [
      'path',
      (ui: ScreenHarness) =>
        path({
          accessible: true,
          message: 'Q',
          root: fixture,
          terminal: ui.terminal,
          validate: (v) => (v ? undefined : 'No'),
        }),
      [TAB, ENTER, 'a', TAB, ENTER],
      // only the fixture completes `a` to this, so a row that read anywhere else fails
      () => join(fixture, 'alpha.txt'),
    ],
    [
      'maskedText',
      (ui: ScreenHarness) =>
        maskedText({ accessible: true, message: 'Q', template: '##', terminal: ui.terminal }),
      ['1', ENTER, '2', ENTER],
    ],
    [
      'toggle',
      (ui: ScreenHarness) => toggle({ accessible: true, message: 'Q', terminal: ui.terminal }),
      ['x', ENTER, CTRL_U, 'on', ENTER],
    ],
    [
      'selectKey',
      (ui: ScreenHarness) =>
        selectKey({
          accessible: true,
          choices: [{ key: 'a', label: 'A' }],
          message: 'Q',
          terminal: ui.terminal,
        }),
      ['x', ENTER, CTRL_U, 'a', ENTER],
    ],
  ] as [string, (ui: ScreenHarness) => Promise<unknown>, string[], (() => unknown)?][])(
    'should write no escape sequence from %s() but the paste markers',
    async (_, ask, keys, answered) => {
      const ui = lines();
      const answer = settle(ask(ui));

      await type(ui.stdin, ...keys);

      const settled = await answer;
      expect(settled.error).toBeUndefined();
      if (answered) {
        expect(settled.value).toBe(answered());
      }
      expect(sequences(ui)).toEqual([]);
      expect(ui.stdin.rawMode).toBe(false);
    }
  );

  it.each(['number', 'list', 'path', 'maskedText', 'toggle', 'selectKey'] as const)(
    'should ask %s() as lines when SIGIL_ACCESSIBLE says so, and drawn when the option says not',
    async (name) => {
      vi.stubEnv('SIGIL_ACCESSIBLE', '1');
      const ask = (ui: ScreenHarness, accessible?: boolean): Promise<unknown> => {
        const base = { accessible, message: 'Q', terminal: ui.terminal };
        switch (name) {
          case 'number':
            return number(base);
          case 'list':
            return list(base);
          case 'path':
            return path({ ...base, root: fixture });
          case 'maskedText':
            return maskedText({ ...base, template: '#' });
          case 'toggle':
            return toggle(base);
          case 'selectKey':
            return selectKey({ ...base, choices: [{ key: 'a', label: 'A' }] });
        }
      };

      const line = lines();
      const asked = settle(ask(line));
      await tick();
      expect(sequences(line)).toEqual([]);
      expect(line.log[0]).toMatch(/^Q/);
      await type(line.stdin, CTRL_C);
      await asked;

      const drawn = lines();
      const shown = settle(ask(drawn, false));
      await tick();
      // a drawn prompt colours and moves, which a line form never does
      expect(sequences(drawn)).not.toEqual([]);
      await type(drawn.stdin, CTRL_C);
      await shown;
    }
  );
});

describe('a group asked as lines', () => {
  it('should go back a step and offer the earlier answer', async () => {
    const ui = lines();
    const answers = group<{ name: string; ok: boolean }>({
      name: (_, step) =>
        text({ ...step, accessible: true, message: 'Name?', terminal: ui.terminal }),
      ok: (_, step) =>
        confirm({ ...step, accessible: true, message: 'Ok?', terminal: ui.terminal }),
    });

    await type(ui.stdin, 'ann', ENTER, ESCAPE);
    await new Promise((resolve) => setTimeout(resolve, 80));
    await type(ui.stdin, 'e', ENTER, 'n', ENTER);

    expect(await answers).toEqual({ name: 'anne', ok: false });
    // a transcript: the step left with Escape stays, and the re-asked one is below
    expect(ui.log).toEqual(['Name? ann', 'Ok? (Y/n)', 'Name? anne', 'Ok? (Y/n) n']);
    expect(isBack(new PromptBack())).toBe(true);
  });
});

describe('a line selectRow()', () => {
  const rows = [
    { age: 3, name: 'api', region: 'us-east' },
    { age: 12, name: 'web', region: '' },
  ];
  const columns = [
    { header: 'Name', key: 'name' },
    { header: 'Region', key: 'region' },
    { header: 'Age', key: 'age' },
  ];

  it('should read each row as one line, every cell after its heading', async () => {
    const ui = lines();
    const answer = selectRow({
      accessible: true,
      columns,
      message: 'Which deployment?',
      rows,
      terminal: ui.terminal,
    });

    await type(ui.stdin, '2', ENTER);

    expect(await answer).toBe(rows[1]);
    expect(ui.log).toEqual([
      'Which deployment?',
      '  1. Name: api, Region: us-east, Age: 3',
      // an empty cell says nothing rather than `Region:` and silence
      '  2. Name: web, Age: 12',
      'Choose a number from 1 to 2 (default: 1) 2',
      'Chosen: web, 12',
    ]);
    expect(sequences(ui)).toEqual([]);
  });

  it('should open on the row it was given, and say a row by its own short', async () => {
    const ui = lines();
    const answer = selectRow({
      accessible: true,
      columns,
      message: 'Which?',
      rows,
      short: (row) => row.name,
      terminal: ui.terminal,
      value: rows[1],
    });

    await type(ui.stdin, ENTER);

    expect(await answer).toBe(rows[1]);
    expect(ui.log.slice(-2)).toEqual(['Choose a number from 1 to 2 (default: 2)', 'Chosen: web']);
  });

  it('should read bare cells where there is no heading', async () => {
    const ui = lines();
    const answer = selectRow({
      accessible: true,
      head: false,
      message: 'Which?',
      rows: [['a', 'b']],
      terminal: ui.terminal,
    });

    await type(ui.stdin, ENTER);

    expect(await answer).toEqual(['a', 'b']);
    expect(ui.log[1]).toBe('  1. a, b');
  });
});

describe('a line groupMultiselect()', () => {
  const choices = {
    Backend: ['Express', { disabled: 'retired', label: 'Koa' }, 'Fastify'],
    Frontend: ['React', 'Vue', { label: 'Svelte', selected: true }],
    Nothing: [{ disabled: true, label: 'Old' }],
  };

  it('should head each group with the numbers that are its own', async () => {
    const ui = lines();
    const answer = groupMultiselect({
      accessible: true,
      choices,
      message: 'Features',
      terminal: ui.terminal,
    });

    // a whole group is its range, and a number from another is added to it
    await type(ui.stdin, '4-5, 1', ENTER);

    expect(await answer).toEqual(['Express', 'Vue', 'Svelte']);
    expect(ui.log).toEqual([
      'Features',
      '  Backend (1-2)',
      '  1. Express',
      '  - Koa (retired)',
      '  2. Fastify',
      '  Frontend (3-5)',
      '  3. React',
      '  4. Vue',
      '  5. Svelte',
      // a group with nothing on offer names no range
      '  Nothing',
      '  - Old (disabled)',
      'Choose numbers from 1 to 5, separated by commas (default: 5) 4-5, 1',
      'Chosen: Express, Vue, Svelte',
    ]);
  });

  it('should keep its min, max and value', async () => {
    const ui = lines();
    const answer = groupMultiselect({
      accessible: true,
      choices,
      max: 1,
      message: 'F',
      terminal: ui.terminal,
      value: ['Fastify'],
    });

    await type(ui.stdin, '1-2', ENTER, ENTER);

    expect(await answer).toEqual(['Fastify']);
    expect(ui.log).toContain('Choose at most 1');
    expect(ui.log).toContain('Choose numbers from 1 to 5, separated by commas (default: 2)');
  });
});

describe('a line sort()', () => {
  it('should take the order as numbers, those left out following in theirs', async () => {
    const ui = lines();
    const answer = sort({
      accessible: true,
      choices: ['lint', 'build', 'test', 'deploy'],
      message: 'Run the steps in this order',
      terminal: ui.terminal,
    });

    await type(ui.stdin, '3 1', ENTER);

    expect(await answer).toEqual(['test', 'lint', 'build', 'deploy']);
    expect(ui.log).toEqual([
      'Run the steps in this order',
      '  1. lint',
      '  2. build',
      '  3. test',
      '  4. deploy',
      'Type the numbers in the order you want them (default: 1 2 3 4) 3 1',
      'Order: test, lint, build, deploy',
    ]);
    expect(sequences(ui)).toEqual([]);
  });

  it('should keep the order on Enter alone, and read a range backwards as reversed', async () => {
    const kept = lines();
    const first = sort({
      accessible: true,
      choices: ['a', 'b', 'c'],
      message: 'Q',
      terminal: kept.terminal,
    });
    await type(kept.stdin, ENTER);
    expect(await first).toEqual(['a', 'b', 'c']);

    const reversed = lines();
    const second = sort({
      accessible: true,
      choices: ['a', 'b', 'c'],
      message: 'Q',
      terminal: reversed.terminal,
    });
    await type(reversed.stdin, '3-1', ENTER);
    expect(await second).toEqual(['c', 'b', 'a']);
  });

  it('should refuse a number given twice, or one that names nothing, holding the reply', async () => {
    const ui = lines();
    const answer = sort({
      accessible: true,
      choices: ['a', 'b', 'c'],
      message: 'Q',
      terminal: ui.terminal,
    });

    await type(ui.stdin, '2 2', ENTER, BACKSPACE, '1', ENTER);

    expect(await answer).toEqual(['b', 'a', 'c']);
    expect(ui.log.slice(4)).toEqual([
      'Type the numbers in the order you want them (default: 1 2 3) 2 2',
      '2 is given more than once',
      'Type the numbers in the order you want them (default: 1 2 3) 2 1',
      'Order: b, a, c',
    ]);
  });

  it('should leave a pinned row where it is, unnumbered', async () => {
    const ui = lines();
    const answer = sort({
      accessible: true,
      choices: ['a', { disabled: 'always first', label: 'setup' }, 'b', 'c'],
      message: 'Q',
      terminal: ui.terminal,
      value: ['c'],
    });

    await type(ui.stdin, '3', ENTER);

    // `value` put c first, so 3 is b, which goes before the rest
    expect(await answer).toEqual(['b', 'setup', 'c', 'a']);
    expect(ui.log.slice(0, 5)).toEqual([
      'Q',
      '  1. c',
      '  - setup (always first)',
      '  2. a',
      '  3. b',
    ]);
  });
});

describe('a line date()', () => {
  it('should name the format and the range, and take the date typed', async () => {
    const ui = lines();
    const answer = date({
      accessible: true,
      max: new Date(2024, 11, 31),
      message: 'Due',
      min: new Date(2024, 0, 1),
      terminal: ui.terminal,
      value: new Date(2024, 5, 15),
    });

    await type(ui.stdin, '2024-7-4', ENTER);

    expect(await answer).toEqual(new Date(2024, 6, 4));
    expect(ui.log).toEqual([
      'Due (YYYY-MM-DD, from 2024-01-01 to 2024-12-31, default: 2024-06-15) 2024-7-4',
    ]);
    expect(sequences(ui)).toEqual([]);
  });

  it('should answer where the field would open on Enter alone', async () => {
    const ui = lines();
    const answer = date({
      accessible: true,
      message: 'Due',
      terminal: ui.terminal,
      value: new Date(2024, 5, 15),
    });

    await type(ui.stdin, ENTER);

    expect(await answer).toEqual(new Date(2024, 5, 15));
  });

  it('should refuse a reply of the wrong shape, a day there is not, and one out of range', async () => {
    const ui = lines();
    const answer = date({
      accessible: true,
      message: 'Due',
      min: new Date(2024, 0, 1),
      terminal: ui.terminal,
      validate: (d) => (d.getDay() === 0 ? 'Not a Sunday' : undefined),
      value: new Date(2024, 5, 15),
    });

    await type(ui.stdin, 'June', ENTER, CTRL_U, '2024-02-30', ENTER, CTRL_U, '2023-12-31', ENTER);
    await type(ui.stdin, CTRL_U, '2024-06-16', ENTER, CTRL_U, '2024-06-17', ENTER);

    expect(await answer).toEqual(new Date(2024, 5, 17));
    expect(ui.log.filter((line) => !line.startsWith('Due'))).toEqual([
      'Enter a date as YYYY-MM-DD',
      // the parser's own refusal, which is what decides a day is not one
      expect.stringMatching(/2024-02-30/),
      'Date must not be before 2024-01-01',
      'Not a Sunday',
    ]);
  });

  it('should ask for the clock where it shows one', async () => {
    const ui = lines();
    const answer = date({
      accessible: true,
      message: 'At',
      terminal: ui.terminal,
      time: true,
      value: new Date(2024, 5, 15, 9, 0),
    });

    await type(ui.stdin, '2024-06-15', ENTER, ' 13:45', ENTER);

    expect(await answer).toEqual(new Date(2024, 5, 15, 13, 45));
    expect(ui.log).toEqual([
      'At (YYYY-MM-DD HH:MM, default: 2024-06-15 09:00) 2024-06-15',
      'Enter a date as YYYY-MM-DD HH:MM',
      'At (YYYY-MM-DD HH:MM, default: 2024-06-15 09:00) 2024-06-15 13:45',
    ]);
  });
});

describe('a line pickDate()', () => {
  it('should take a day typed, at local midnight, inside its range', async () => {
    const ui = lines();
    const answer = pickDate({
      accessible: true,
      max: new Date(2026, 11, 31),
      message: 'Day',
      min: new Date(2026, 9, 1),
      terminal: ui.terminal,
      value: new Date(2026, 9, 15),
    });

    await type(
      ui.stdin,
      '2026-09-30',
      ENTER,
      CTRL_U,
      '2026-02-29',
      ENTER,
      CTRL_U,
      '2026-10-20',
      ENTER
    );

    expect(await answer).toEqual(new Date(2026, 9, 20));
    expect(ui.log[0]).toBe(
      'Day (YYYY-MM-DD, from 2026-10-01 to 2026-12-31, default: 2026-10-15) 2026-09-30'
    );
    expect(ui.log[1]).toBe('Date must not be before 2026-10-01');
    expect(ui.log[3]).toMatch(/2026-02-29/);
    expect(sequences(ui)).toEqual([]);
  });

  it('should answer the day the cursor would open on, pulled into the range', async () => {
    const ui = lines();
    const answer = pickDate({
      accessible: true,
      message: 'Day',
      min: new Date(2026, 9, 1),
      terminal: ui.terminal,
      value: new Date(2020, 0, 1),
    });

    await type(ui.stdin, ENTER);

    expect(await answer).toEqual(new Date(2026, 9, 1));
  });
});

describe('a line selectTree()', () => {
  const items = [
    { items: ['Apple', 'Pear'], text: 'Fruit' },
    'Bread',
    { items: async () => ['Carrot'], text: 'Veg' },
  ];

  it('should list a level at a time, going in and back out by number', async () => {
    const ui = lines();
    const answer = selectTree({
      accessible: true,
      items,
      leaves: true,
      message: 'Pick',
      terminal: ui.terminal,
    });

    await type(ui.stdin, '1', ENTER, '3', ENTER, '3', ENTER);
    await tick();
    await type(ui.stdin, '1', ENTER);

    expect(await answer).toBe('Carrot');
    expect(ui.log).toEqual([
      'Pick',
      '  1. Fruit (go in)',
      '  2. Bread',
      '  3. Veg (go in)',
      'Choose a number from 1 to 3 (default: 1) 1',
      'In Fruit',
      '  1. Apple',
      '  2. Pear',
      '  3. Back to the top',
      'Choose a number from 1 to 3 (default: 1) 3',
      // the top again, opening on the branch just come back out of
      'Pick',
      '  1. Fruit (go in)',
      '  2. Bread',
      '  3. Veg (go in)',
      'Choose a number from 1 to 3 (default: 1) 3',
      'In Veg',
      '  1. Carrot',
      '  2. Back to the top',
      'Choose a number from 1 to 2 (default: 1) 1',
      'Chosen: Carrot',
    ]);
    expect(sequences(ui)).toEqual([]);
  });

  it('should offer a branch itself as an answer without leaves', async () => {
    const ui = lines();
    const answer = selectTree({
      accessible: true,
      items: { items: [{ items: ['x'], text: 'inner' }], text: 'root' },
      message: 'Pick',
      terminal: ui.terminal,
    });

    await type(ui.stdin, '2', ENTER, '1', ENTER);

    expect(await answer).toBe('inner');
    expect(ui.log).toEqual([
      'Pick',
      'In root',
      '  1. root (this one)',
      '  2. inner (go in)',
      'Choose a number from 1 to 2 (default: 1) 2',
      'In inner',
      '  1. inner (this one)',
      '  2. x',
      '  3. Back to root',
      'Choose a number from 1 to 3 (default: 1) 1',
      'Chosen: inner',
    ]);
  });

  it('should open on a starting answer, and say why a branch would not open', async () => {
    const ui = lines();
    let reads = 0;
    const answer = selectTree({
      accessible: true,
      items: [
        { items: ['a', 'b'], text: 'g' },
        {
          items: () => {
            reads++;
            throw new Error('offline');
          },
          text: 'remote',
        },
      ],
      leaves: true,
      message: 'Pick',
      terminal: ui.terminal,
      validate: (v) => (v === 'a' ? 'Not a' : undefined),
      value: 'b',
    });

    await type(ui.stdin, ENTER);
    expect(await answer).toBe('b');
    expect(ui.log.slice(0, 5)).toEqual([
      'Pick',
      'In g',
      '  1. a',
      '  2. b',
      '  3. Back to the top',
    ]);
    expect(ui.log).toContain('Choose a number from 1 to 3 (default: 2)');

    const again = lines();
    const second = selectTree({
      accessible: true,
      items: [
        { items: ['a', 'b'], text: 'g' },
        {
          items: () => {
            reads++;
            throw new Error('offline');
          },
          text: 'remote',
        },
      ],
      leaves: true,
      message: 'Pick',
      terminal: again.terminal,
      validate: (v) => (v === 'a' ? 'Not a' : undefined),
    });
    // a read that failed is asked again, rather than kept
    await type(again.stdin, '2', ENTER, '2', ENTER, '1', ENTER, '1', ENTER, '2', ENTER);
    expect(await second).toBe('b');
    expect(reads).toBe(2);
    expect(again.log.filter((line) => line === 'offline' || line === 'Not a')).toEqual([
      'offline',
      'offline',
      'Not a',
    ]);
  });
});

describe('a line form with keys of its own', () => {
  it('should hand a key the form does not take to the engine, as before', async () => {
    const ui = lines();
    const seen: string[] = [];
    const answer = runLinePrompt<string>(
      { message: 'Q', terminal: ui.terminal },
      {
        ask: 'Q ',
        echo: true,
        key(k) {
          seen.push(k.name);
        },
        read: (reply) => ({ value: reply }),
      }
    );

    await type(ui.stdin, 'a', 'b', BACKSPACE, 'c', ENTER);

    expect(await answer).toBe('ac');
    expect(seen).toEqual(['a', 'b', 'backspace', 'c', 'enter']);
    expect(ui.log).toEqual(['Q ac']);
  });

  it('should add to the end through fit, write lines under the reply, and ask again', async () => {
    const ui = lines();
    const repeats: boolean[] = [];
    const answer = runLinePrompt<string>(
      { message: 'Q', terminal: ui.terminal },
      {
        ask: 'Q ',
        echo: true,
        // at most four characters, which an insert is held to like typing
        fit: (reply, inserted) => inserted.slice(0, Math.max(0, 4 - reply.length)),
        key(k, { repeated }) {
          if (k.name !== 'tab') {
            return;
          }
          repeats.push(repeated);
          return repeated ? { lines: ['one', 'two'] } : { insert: 'xyz' };
        },
        read: (reply) => ({ value: reply }),
      }
    );

    await type(ui.stdin, 'a', 'b', TAB, TAB, PASTE_START + 'q' + PASTE_END, TAB, ENTER);

    expect(await answer).toBe('abxy');
    // a paste between two Tabs makes the second a first again
    expect(repeats).toEqual([false, true, false]);
    expect(ui.log).toEqual(['Q abxy', 'one', 'two', 'Q abxy']);
    expect(sequences(ui)).toEqual([]);
  });

  it('should take a key a handler returns an empty result for, and do nothing with it', async () => {
    const ui = lines();
    const answer = runLinePrompt<string>(
      { message: 'Q', terminal: ui.terminal },
      {
        ask: 'Q ',
        echo: true,
        key: (k) => (k.name === 'x' ? {} : undefined),
        read: (reply) => ({ value: reply }),
      }
    );

    await type(ui.stdin, 'a', 'x', 'b', ENTER);

    expect(await answer).toBe('ab');
    expect(ui.log).toEqual(['Q ab']);
  });

  it('should ask a question of one key after its lines, and hand it the next key alone', async () => {
    const ui = lines();
    const asked: string[] = [];
    const answers: string[] = [];
    const answer = runLinePrompt<string>(
      { message: 'Q', terminal: ui.terminal },
      {
        ask: 'Q ',
        echo: true,
        key(k) {
          asked.push(k.name);
          if (k.name !== 'tab') {
            return;
          }
          return {
            insert: 'b',
            lines: ['first'],
            query: {
              ask: 'Sure? ',
              // a promise, which holds the keys behind it like any handler
              answer: async (key) => {
                answers.push(key.name);
                return key.name === 'k' ? ['done'] : 'Press k';
              },
            },
          };
        },
        read: (reply) => ({ value: reply }),
      }
    );

    await type(ui.stdin, 'a', TAB, 'z', 'k', 'c', ENTER);

    expect(await answer).toBe('abc');
    // the form's handler was not asked while the question waited
    expect(asked).toEqual(['a', 'tab', 'c', 'enter']);
    expect(answers).toEqual(['z', 'k']);
    expect(ui.log).toEqual(['Q ab', 'first', 'Sure?', 'Press k', 'Sure?', 'done', 'Q abc']);
    expect(sequences(ui)).toEqual([]);
  });

  it('should drop an answer that lands after ctrl-c', async () => {
    const ui = lines();
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    const result = settle(
      runLinePrompt<string>(
        { message: 'Q', terminal: ui.terminal },
        {
          ask: 'Q ',
          echo: true,
          key: (k) =>
            k.name === 'tab'
              ? {
                  query: {
                    ask: 'Sure? ',
                    answer: async () => {
                      await held;
                      return ['late'];
                    },
                  },
                }
              : undefined,
          read: (reply) => ({ value: reply }),
        }
      )
    );

    await type(ui.stdin, TAB, 'y', CTRL_C);
    const { error } = await result;
    expect((error as PromptError).aborted).toBe(true);

    release();
    await settleOutput(ui);
    expect(written(ui)).toBe('Q \r\nSure? \r\n');
  });

  it('should reject with what a handler throws, and finish the line', async () => {
    const ui = lines();
    const result = settle(
      runLinePrompt<string>(
        { message: 'Q', terminal: ui.terminal },
        {
          ask: 'Q ',
          echo: true,
          key: async () => {
            throw new Error('no');
          },
          read: (reply) => ({ value: reply }),
        }
      )
    );

    await type(ui.stdin, 'a');
    const { error } = await result;

    expect((error as Error).message).toBe('no');
    expect(written(ui)).toBe('Q \r\n');
    expect(ui.stdin.rawMode).toBe(false);
  });
});

describe('a line form that reads before it asks', () => {
  it('should be cancelled by ctrl-c while the read is still out', async () => {
    const ui = lines();
    const result = settle(
      selectTree({
        accessible: true,
        // a branch that opens itself and never finishes reading: a stalled mount
        items: [{ expanded: true, items: () => new Promise<string[]>(() => {}), text: 'slow' }],
        message: 'Pick',
        terminal: ui.terminal,
      })
    );
    await tick();

    // the question is up before the read it waits on has landed
    expect(ui.log).toEqual(['Pick']);
    await type(ui.stdin, CTRL_C);
    const { error } = await result;

    expect((error as PromptError).aborted).toBe(true);
    expect(ui.stdin.rawMode).toBe(false);
  });

  it('should refuse a malformed item before writing anything', async () => {
    const ui = lines();
    const { error } = await settle(
      selectTree({
        accessible: true,
        items: [42 as unknown as string],
        message: 'Pick',
        terminal: ui.terminal,
      })
    );

    expect((error as Error).message).toMatch(/Expected each item/);
    // the router's paste markers on and off, and not a line of the question
    expect(ui.log).toEqual([]);
    expect(sequences(ui)).toEqual([]);
    expect(ui.stdin.rawMode).toBe(false);
  });
});

describe('a line directoryTree() and filePicker()', () => {
  let root: string;

  /** Wide enough that no temporary path wraps, wherever the platform puts one. */
  const wide = (): ScreenHarness => screenSetup({ columns: 1000, rows: 40 });

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'sigil-accessible-'));
    await mkdir(join(root, 'lib'));
    await mkdir(join(root, 'src'));
    await writeFile(join(root, 'src', 'index.ts'), '');
    await writeFile(join(root, 'notes.md'), '');
  });

  afterEach(async () => {
    await rm(root, { force: true, recursive: true });
  });

  it('should browse a directory tree a directory at a time', async () => {
    const ui = wide();
    const answer = directoryTree({
      accessible: true,
      message: 'File?',
      root,
      terminal: ui.terminal,
    });

    await settleOutput(ui);
    await type(ui.stdin, '2', ENTER);
    await settleOutput(ui);
    await type(ui.stdin, '1', ENTER);

    expect(await answer).toBe(join(root, 'src', 'index.ts'));
    expect(ui.log).toEqual([
      'File?',
      `In ${basename(root)}${sep}`,
      `  1. lib${sep} (go in)`,
      `  2. src${sep} (go in)`,
      '  3. notes.md',
      'Choose a number from 1 to 3 (default: 1) 2',
      `In src${sep}`,
      '  1. index.ts',
      `  2. Back to ${basename(root)}${sep}`,
      'Choose a number from 1 to 2 (default: 1) 1',
      `Chosen: ${join(root, 'src', 'index.ts')}`,
    ]);
    expect(sequences(ui)).toEqual([]);
  });

  it('should browse with filePicker(), coming back out onto the directory it left', async () => {
    const ui = wide();
    const answer = filePicker({
      accessible: true,
      confine: true,
      message: 'File?',
      root,
      terminal: ui.terminal,
    });

    await settleOutput(ui);
    await type(ui.stdin, '2', ENTER);
    await settleOutput(ui);
    await type(ui.stdin, '2', ENTER);
    await settleOutput(ui);
    await type(ui.stdin, '3', ENTER);

    expect(await answer).toBe(join(root, 'notes.md'));
    expect(ui.log).toEqual([
      'File?',
      `In ${root}`,
      `  1. lib${sep}`,
      `  2. src${sep}`,
      '  3. notes.md',
      'Choose a number from 1 to 3 (default: 1) 2',
      `In ${join(root, 'src')}`,
      '  1. index.ts',
      '  2. .. (up a level)',
      'Choose a number from 1 to 2 (default: 1) 2',
      // confined, so the top has no way further up, and Enter alone is the
      // directory just come back out of
      `In ${root}`,
      `  1. lib${sep}`,
      `  2. src${sep}`,
      '  3. notes.md',
      'Choose a number from 1 to 3 (default: 2) 3',
      `Chosen: ${join(root, 'notes.md')}`,
    ]);
  });

  it('should pick a directory as `.` from inside it, with directory', async () => {
    const ui = wide();
    const answer = filePicker({
      accessible: true,
      confine: true,
      directory: true,
      message: 'Dir?',
      root,
      terminal: ui.terminal,
    });

    await settleOutput(ui);
    await type(ui.stdin, '3', ENTER);
    await settleOutput(ui);
    await type(ui.stdin, ENTER);

    expect(await answer).toBe(join(root, 'src'));
    expect(ui.log.slice(0, 5)).toEqual([
      'Dir?',
      `In ${root}`,
      '  1. . (this directory)',
      `  2. lib${sep}`,
      `  3. src${sep}`,
    ]);
    expect(ui.log).toContain(`In ${join(root, 'src')}`);
    expect(ui.log).toContain('No matches');
  });

  it('should open on a starting answer', async () => {
    const ui = wide();
    const answer = filePicker({
      accessible: true,
      message: 'File?',
      root,
      terminal: ui.terminal,
      value: join(root, 'src', 'index.ts'),
    });

    await settleOutput(ui);
    await type(ui.stdin, ENTER);

    expect(await answer).toBe(join(root, 'src', 'index.ts'));
    expect(ui.log[1]).toBe(`In ${join(root, 'src')}`);
  });
});

describe('a line autocomplete()', () => {
  const choices = ['us-east-1', 'us-west-2', 'eu-central-1'];

  it('should search with the term and list what it matches', async () => {
    const ui = lines();
    const answer = autocomplete({
      accessible: true,
      choices,
      message: 'Region',
      terminal: ui.terminal,
    });

    await type(ui.stdin, 'us', ENTER, '2', ENTER);

    expect(await answer).toBe('us-west-2');
    expect(ui.log).toEqual([
      'Region us',
      '  1. us-east-1',
      '  2. us-west-2',
      '  3. Search again',
      'Choose a number from 1 to 3 (default: 1) 2',
      'Chosen: us-west-2',
    ]);
    expect(sequences(ui)).toEqual([]);
  });

  it('should answer a term that leaves one choice, and hold one that leaves none', async () => {
    const ui = lines();
    const answer = autocomplete({
      accessible: true,
      choices,
      message: 'Region',
      terminal: ui.terminal,
    });

    await type(ui.stdin, 'zz', ENTER, CTRL_U, 'eu', ENTER);

    expect(await answer).toBe('eu-central-1');
    expect(ui.log).toEqual(['Region zz', 'No matches', 'Region eu', 'Chosen: eu-central-1']);
  });

  it('should search again from the list, holding the term', async () => {
    const ui = lines();
    const answer = autocomplete({
      accessible: true,
      choices,
      message: 'Region',
      terminal: ui.terminal,
    });

    await type(ui.stdin, 'us', ENTER, '3', ENTER, '-ea', ENTER);

    expect(await answer).toBe('us-east-1');
    expect(ui.log.slice(5)).toEqual(['Region us-ea', 'Chosen: us-east-1']);
  });

  it('should ask a source, and say what it refused with', async () => {
    const ui = lines();
    const terms: string[] = [];
    const answer = autocomplete({
      accessible: true,
      message: 'Package',
      source: async (term) => {
        terms.push(term);
        if (term === 'x') {
          throw new Error('registry down');
        }
        return [`${term}-a`, `${term}-b`];
      },
      terminal: ui.terminal,
      validate: (v) => (v === 'p-a' ? 'Taken' : undefined),
    });

    await type(ui.stdin, 'x', ENTER, BACKSPACE, 'p', ENTER, ENTER, '2', ENTER);

    expect(await answer).toBe('p-b');
    expect(terms).toEqual(['x', 'p']);
    expect(ui.log.filter((line) => line === 'registry down' || line === 'Taken')).toEqual([
      'registry down',
      'Taken',
    ]);
  });

  it('should open its first list on its value', async () => {
    const ui = lines();
    const answer = autocomplete({
      accessible: true,
      choices,
      message: 'Region',
      terminal: ui.terminal,
      value: 'eu-central-1',
    });

    await type(ui.stdin, ENTER, ENTER);

    expect(await answer).toBe('eu-central-1');
    expect(ui.log).toContain('Choose a number from 1 to 4 (default: 3)');
  });
});

describe('a line autocompleteMultiselect()', () => {
  const choices = ['red', 'green', 'blue', 'black'];

  it('should tick among what a term matched, and keep ticks the term hid', async () => {
    const ui = lines();
    const answer = autocompleteMultiselect({
      accessible: true,
      choices,
      message: 'Colours',
      terminal: ui.terminal,
    });

    await type(ui.stdin, 're', ENTER, '1', ENTER, 'bl', ENTER, '1-2', ENTER, ENTER);

    expect(await answer).toEqual(['red', 'blue', 'black']);
    expect(ui.log.filter((line) => line.startsWith('Chosen') || line.startsWith('Search'))).toEqual(
      [
        'Chosen: red',
        'Search again (Enter alone to finish) bl',
        'Chosen: red, blue, black',
        'Search again (Enter alone to finish)',
      ]
    );
    expect(sequences(ui)).toEqual([]);
  });

  it('should untick what a reply leaves out, and refuse below min', async () => {
    const ui = lines();
    const answer = autocompleteMultiselect({
      accessible: true,
      choices: [{ label: 'red', selected: true }, 'green'],
      message: 'Colours',
      min: 1,
      terminal: ui.terminal,
    });

    await type(ui.stdin, ENTER, 'none', ENTER, ENTER, 'g', ENTER, '1', ENTER, ENTER);

    expect(await answer).toEqual(['green']);
    expect(ui.log).toContain('Choose numbers from 1 to 2, separated by commas (default: 1) none');
    expect(ui.log).toContain('Choose at least one');
  });
});
