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
  select,
  separator,
  text,
} from '../../src/components/prompt.js';
import { selectKey } from '../../src/components/select-key.js';
import { toggle } from '../../src/components/toggle.js';
import { baseDir } from '../../src/paths.js';
import { type ScreenHarness, screenSetup, tick } from './helpers.js';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * The prompts that have a line form, asked as lines, for a screen reader.
 *
 * Read through the screen model, because what is claimed is the transcript: the
 * question written once, what was typed after it, and nothing ever moved. The
 * one claim made about bytes is the strongest one -- that nothing but the paste
 * markers was written as an escape sequence at all, which is what "never
 * redrawn" means once it is said precisely.
 */

afterEach(() => {
  vi.unstubAllEnvs();
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
function sequences(ui: ScreenHarness): string[] {
  const rest = ui.output.replaceAll('\u001b[?2004h', '').replaceAll('\u001b[?2004l', '');
  // eslint-disable-next-line no-control-regex
  return rest.match(/\u001b[^\u001b]{0,8}/g) ?? [];
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
  it('should answer what was typed, and complete and list nothing', async () => {
    const ui = lines();
    // a directory with files in it on every platform, so a list had something to show
    const root = import.meta.dirname;
    const answer = path({ accessible: true, message: 'File', root, terminal: ui.terminal });

    await type(ui.stdin, 'prompt-', TAB, TAB, ENTER);

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
          terminal: ui.terminal,
          validate: (v) => (v ? undefined : 'No'),
        }),
      [TAB, ENTER, 'a', TAB, ENTER],
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
  ] as [string, (ui: ScreenHarness) => Promise<unknown>, string[]][])(
    'should write no escape sequence from %s() but the paste markers',
    async (_, ask, keys) => {
      const ui = lines();
      const answer = settle(ask(ui));

      await type(ui.stdin, ...keys);

      expect((await answer).error).toBeUndefined();
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
            return path(base);
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
