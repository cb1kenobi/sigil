import { PromptError } from '../../src/components/prompt.js';
import { sort, type SortOptions } from '../../src/components/sort.js';
import { type ScreenHarness, screenSetup, tick } from './helpers.js';
import { describe, expect, it } from 'vitest';

const ENTER = '\r';
const SPACE = ' ';
const CTRL_C = '\u0003';
const UP = '\u001b[A';
const DOWN = '\u001b[B';
const HOME = '\u001b[H';
const END = '\u001b[F';
const PAGEUP = '\u001b[5~';
const PAGEDOWN = '\u001b[6~';
const SHIFT_UP = '\u001b[1;2A';
const SHIFT_DOWN = '\u001b[1;2B';
const ALT_DOWN = '\u001b[1;3B';

/** Sends keys one at a time, letting the prompt act on each. */
async function type(stdin: { send(chunk: string): void }, ...chunks: string[]): Promise<void> {
  for (const chunk of chunks) {
    stdin.send(chunk);
    await tick();
  }
}

/** Starts the prompt and reports how it settled. */
function settle<T>(promise: Promise<T>): Promise<{ error?: PromptError; value?: T }> {
  return promise.then(
    (value) => ({ value }),
    (error: PromptError) => ({ error })
  );
}

/** A prompt over a screen, with no theme and no colour. */
function open<T = string>(ui: ScreenHarness, opts: Partial<SortOptions<T>> = {}) {
  return sort<T>({
    ansi: ui.ansi,
    frameMs: 0,
    message: 'Order',
    terminal: ui.terminal,
    ...opts,
  } as SortOptions<T>);
}

/** The list rows on screen, without the head line, the pointer or the place. */
function labels(ui: ScreenHarness): string[] {
  return ui.log
    .map((line) => line.trimEnd())
    .filter((line) => /^\s*(❯\s)?\s*\d+\./.test(line))
    .map((line) => line.replace(/^\s*(❯\s)?\s*\d+\.\s*/, ''));
}

/** The label of the row the pointer is on. */
function pointed(ui: ScreenHarness): string {
  const rows = ui.log.filter((line) => line.includes('❯') && /\d+\./.test(line));
  expect(rows, 'exactly one row has the pointer').toHaveLength(1);
  return rows[0].replace(/^.*\d+\.\s*/, '').trim();
}

const STEPS = ['lint', 'build', 'test', 'deploy'];

describe('sort()', () => {
  it('should draw the list in the order it was given, numbered', async () => {
    const ui = screenSetup({ columns: 60, rows: 10 });
    const answer = settle(open(ui, { choices: STEPS }));

    await tick();

    expect(ui.log.map((line) => line.trimEnd()).filter(Boolean)).toEqual([
      '? Order (space to grab, enter to confirm)',
      '❯ 1. lint',
      '  2. build',
      '  3. test',
      '  4. deploy',
    ]);

    await type(ui.stdin, CTRL_C);
    await answer;
  });

  it('should answer with the list as it was given when nothing is moved', async () => {
    const ui = screenSetup({ columns: 60, rows: 10 });
    const answer = settle(open(ui, { choices: STEPS }));

    await type(ui.stdin, ENTER);

    expect((await answer).value).toEqual(STEPS);
  });

  it('should move the highlight, and not the list, when nothing is picked up', async () => {
    const ui = screenSetup({ columns: 60, rows: 10 });
    const answer = settle(open(ui, { choices: STEPS }));

    await type(ui.stdin, DOWN, DOWN);

    expect(pointed(ui)).toBe('test');
    expect(labels(ui)).toEqual(STEPS);

    await type(ui.stdin, ENTER);
    expect((await answer).value).toEqual(STEPS);
  });

  it('should carry a picked-up row down with the arrows, the highlight going along', async () => {
    const ui = screenSetup({ columns: 60, rows: 10 });
    const answer = settle(open(ui, { choices: STEPS }));

    await type(ui.stdin, SPACE, DOWN, DOWN);

    expect(labels(ui)).toEqual(['build', 'test', 'lint', 'deploy']);
    expect(pointed(ui)).toBe('lint');

    await type(ui.stdin, SPACE, ENTER);
    expect((await answer).value).toEqual(['build', 'test', 'lint', 'deploy']);
  });

  it('should carry a picked-up row up', async () => {
    const ui = screenSetup({ columns: 60, rows: 10 });
    const answer = settle(open(ui, { choices: STEPS, initial: 3 }));

    await type(ui.stdin, SPACE, UP, UP, ENTER);

    expect((await answer).value).toEqual(['lint', 'deploy', 'build', 'test']);
  });

  it('should say how to put the row down while one is held', async () => {
    const ui = screenSetup({ columns: 60, rows: 10 });
    const answer = settle(open(ui, { choices: STEPS }));

    await type(ui.stdin, SPACE);
    expect(ui.log[0]).toContain('(up/down to move, space to drop)');

    await type(ui.stdin, SPACE);
    expect(ui.log[0]).toContain('(space to grab, enter to confirm)');

    await type(ui.stdin, CTRL_C);
    await answer;
  });

  it('should move the highlight again once the row is put down', async () => {
    const ui = screenSetup({ columns: 60, rows: 10 });
    const answer = settle(open(ui, { choices: STEPS }));

    await type(ui.stdin, SPACE, DOWN, SPACE, DOWN);

    expect(labels(ui)).toEqual(['build', 'lint', 'test', 'deploy']);
    expect(pointed(ui)).toBe('test');

    await type(ui.stdin, ENTER);
    expect((await answer).value).toEqual(['build', 'lint', 'test', 'deploy']);
  });

  it('should answer on Enter with a row still in hand where it was carried to', async () => {
    const ui = screenSetup({ columns: 60, rows: 10 });
    const answer = settle(open(ui, { choices: STEPS }));

    await type(ui.stdin, SPACE, DOWN, ENTER);

    expect((await answer).value).toEqual(['build', 'lint', 'test', 'deploy']);
  });

  it('should not carry a row past either end, even where the highlight wraps', async () => {
    const ui = screenSetup({ columns: 60, rows: 10 });
    const answer = settle(open(ui, { choices: STEPS }));

    await type(ui.stdin, SPACE, UP);
    expect(labels(ui)).toEqual(STEPS);
    expect(pointed(ui)).toBe('lint');

    await type(ui.stdin, END, DOWN);
    expect(labels(ui)).toEqual(['build', 'test', 'deploy', 'lint']);

    await type(ui.stdin, ENTER);
    await answer;
  });

  it('should send a carried row to the top or the bottom with Home and End', async () => {
    const ui = screenSetup({ columns: 60, rows: 10 });
    const answer = settle(open(ui, { choices: STEPS, initial: 2 }));

    await type(ui.stdin, SPACE, HOME);
    expect(labels(ui)).toEqual(['test', 'lint', 'build', 'deploy']);

    await type(ui.stdin, END);
    expect(labels(ui)).toEqual(['lint', 'build', 'deploy', 'test']);

    await type(ui.stdin, ENTER);
    expect((await answer).value).toEqual(['lint', 'build', 'deploy', 'test']);
  });

  it('should jump the highlight to the first and last row with Home and End', async () => {
    const ui = screenSetup({ columns: 60, rows: 10 });
    const answer = settle(open(ui, { choices: STEPS }));

    await type(ui.stdin, END);
    expect(pointed(ui)).toBe('deploy');

    await type(ui.stdin, HOME);
    expect(pointed(ui)).toBe('lint');

    await type(ui.stdin, ENTER);
    await answer;
  });

  it('should move a row one place with Shift or Alt and an arrow, without picking it up', async () => {
    const ui = screenSetup({ columns: 60, rows: 10 });
    const answer = settle(open(ui, { choices: STEPS }));

    await type(ui.stdin, SHIFT_DOWN, ALT_DOWN);
    expect(labels(ui)).toEqual(['build', 'test', 'lint', 'deploy']);

    await type(ui.stdin, SHIFT_UP);
    expect(labels(ui)).toEqual(['build', 'lint', 'test', 'deploy']);
    expect(ui.log[0]).toContain('(space to grab, enter to confirm)');

    await type(ui.stdin, ENTER);
    expect((await answer).value).toEqual(['build', 'lint', 'test', 'deploy']);
  });

  it('should wrap the highlight at the ends by default and stop there with loop: false', async () => {
    const ui = screenSetup({ columns: 60, rows: 10 });
    const answer = settle(open(ui, { choices: STEPS }));

    await type(ui.stdin, UP);
    expect(pointed(ui)).toBe('deploy');
    await type(ui.stdin, DOWN);
    expect(pointed(ui)).toBe('lint');
    await type(ui.stdin, ENTER);
    await answer;

    const flat = screenSetup({ columns: 60, rows: 10 });
    const stopped = settle(open(flat, { choices: STEPS, loop: false }));
    await type(flat.stdin, UP);
    expect(pointed(flat)).toBe('lint');
    await type(flat.stdin, END, DOWN);
    expect(pointed(flat)).toBe('deploy');
    await type(flat.stdin, ENTER);
    await stopped;
  });

  it('should answer with a choice value rather than its label', async () => {
    const ui = screenSetup({ columns: 60, rows: 10 });
    const answer = settle(
      open<number>(ui, {
        choices: [
          { label: 'First', value: 1 },
          { label: 'Second', value: 2 },
          { label: 'Third', value: 3 },
        ],
      })
    );

    await type(ui.stdin, SPACE, DOWN, ENTER);

    expect((await answer).value).toEqual([2, 1, 3]);
  });

  it('should start with the highlight on initial', async () => {
    const ui = screenSetup({ columns: 60, rows: 10 });
    const answer = settle(open(ui, { choices: STEPS, initial: 2 }));

    await tick();
    expect(pointed(ui)).toBe('test');

    await type(ui.stdin, ENTER);
    await answer;
  });

  it('should settle to the order on one line', async () => {
    const ui = screenSetup({ columns: 60, rows: 10 });
    const answer = settle(
      open(ui, {
        choices: [{ label: 'Production', short: 'prod' }, 'staging', 'dev'],
      })
    );

    await type(ui.stdin, SPACE, DOWN, ENTER);
    await answer;

    expect(ui.log.map((line) => line.trimEnd()).filter(Boolean)).toEqual([
      '? Order staging, prod, dev',
    ]);
  });
});

describe('sort() with a disabled choice', () => {
  const PINNED = ['install', { disabled: 'always first', label: 'checkout' }, 'build', 'test'];

  it('should keep a pinned choice in its place while the rows around it move', async () => {
    const ui = screenSetup({ columns: 60, rows: 10 });
    const answer = settle(open(ui, { choices: ['a', { disabled: true, label: 'b' }, 'c', 'd'] }));

    await type(ui.stdin, SPACE, DOWN);

    // a jumped over the pinned b and took c's place
    expect(labels(ui)).toEqual(['c', 'b disabled', 'a', 'd']);
    expect(pointed(ui)).toBe('a');

    await type(ui.stdin, ENTER);
    expect((await answer).value).toEqual(['c', 'b', 'a', 'd']);
  });

  it('should step the highlight over a pinned choice', async () => {
    const ui = screenSetup({ columns: 60, rows: 10 });
    const answer = settle(open(ui, { choices: PINNED }));

    await type(ui.stdin, DOWN);
    expect(pointed(ui)).toBe('build');

    await type(ui.stdin, UP);
    expect(pointed(ui)).toBe('install');

    await type(ui.stdin, ENTER);
    expect((await answer).value).toEqual(['install', 'checkout', 'build', 'test']);
  });

  it('should show why a choice is pinned', async () => {
    const ui = screenSetup({ columns: 60, rows: 10 });
    const answer = settle(open(ui, { choices: PINNED }));

    await tick();
    expect(ui.log.join('\n')).toContain('checkout always first');

    await type(ui.stdin, CTRL_C);
    await answer;
  });

  it('should start on the next row that can be moved when initial is a pinned one', async () => {
    const ui = screenSetup({ columns: 60, rows: 10 });
    const answer = settle(open(ui, { choices: PINNED, initial: 1 }));

    await tick();
    expect(pointed(ui)).toBe('build');

    await type(ui.stdin, ENTER);
    await answer;
  });

  it('should refuse a list with nothing in it that can be moved', async () => {
    const ui = screenSetup({ columns: 60, rows: 10 });

    expect((await settle(open(ui, { choices: [] }))).error?.message).toBe(
      '"Order" has no choices to offer'
    );
    expect(
      (await settle(open(ui, { choices: [{ disabled: true, label: 'a' }] }))).error?.message
    ).toBe('"Order" has no choices to offer');
  });
});

describe('sort() over a list longer than the screen', () => {
  const MANY = Array.from({ length: 12 }, (_, i) => `item-${i + 1}`);

  it('should window the list and follow the highlight', async () => {
    const ui = screenSetup({ columns: 60, rows: 6 });
    const answer = settle(open(ui, { choices: MANY }));

    await tick();
    expect(labels(ui)).toEqual(['item-1', 'item-2', 'item-3', 'item-4', 'item-5']);

    await type(ui.stdin, END);
    expect(pointed(ui)).toBe('item-12');
    expect(labels(ui).at(-1)).toBe('item-12');
    expect(labels(ui)).toHaveLength(5);

    await type(ui.stdin, ENTER);
    await answer;
  });

  it('should keep a carried row on screen as it moves out of the window', async () => {
    const ui = screenSetup({ columns: 60, rows: 6 });
    const answer = settle(open(ui, { choices: MANY }));

    await type(ui.stdin, SPACE, DOWN, DOWN, DOWN, DOWN, DOWN, DOWN);

    expect(pointed(ui)).toBe('item-1');
    expect(labels(ui)).toContain('item-1');

    await type(ui.stdin, ENTER);
    expect((await answer).value?.slice(0, 7)).toEqual([
      'item-2',
      'item-3',
      'item-4',
      'item-5',
      'item-6',
      'item-7',
      'item-1',
    ]);
  });

  it('should number the rows to the width of the largest', async () => {
    const ui = screenSetup({ columns: 60, rows: 20 });
    const answer = settle(open(ui, { choices: MANY }));

    await tick();
    expect(ui.log.some((line) => line.includes(' 1. item-1'))).toBe(true);
    expect(ui.log.some((line) => line.includes('12. item-12'))).toBe(true);

    await type(ui.stdin, CTRL_C);
    await answer;
  });

  it('should page the highlight, and a carried row, a screen at a time', async () => {
    const ui = screenSetup({ columns: 60, rows: 6 });
    const answer = settle(open(ui, { choices: MANY }));

    await type(ui.stdin, PAGEDOWN);
    expect(pointed(ui)).toBe('item-5');

    await type(ui.stdin, PAGEUP);
    expect(pointed(ui)).toBe('item-1');

    await type(ui.stdin, SPACE, PAGEDOWN);
    expect(pointed(ui)).toBe('item-1');
    expect(labels(ui)[0]).not.toBe('item-1');

    await type(ui.stdin, ENTER);
    const value = (await answer).value as string[];
    expect(value.indexOf('item-1')).toBe(4);
  });
});

describe('sort() refusals', () => {
  it('should reject where there is no terminal to ask', async () => {
    const ui = screenSetup({ isTTY: false });

    const { error } = await settle(open(ui, { choices: STEPS }));

    expect(error).toBeInstanceOf(PromptError);
  });

  it('should reject as aborted on Ctrl-C', async () => {
    const ui = screenSetup({ columns: 60, rows: 10 });
    const answer = settle(open(ui, { choices: STEPS }));

    await type(ui.stdin, SPACE, DOWN, CTRL_C);

    const { error } = await answer;
    expect(error?.aborted).toBe(true);
  });

  it("should leave the caller's list alone", async () => {
    const ui = screenSetup({ columns: 60, rows: 10 });
    const given = ['a', 'b', 'c'];
    const answer = settle(open(ui, { choices: given }));

    await type(ui.stdin, SPACE, DOWN, ENTER);

    expect((await answer).value).toEqual(['b', 'a', 'c']);
    expect(given).toEqual(['a', 'b', 'c']);
  });
});
