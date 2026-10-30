import { PromptError } from '../../src/components/prompt.js';
import { selectKey, type SelectKeyOptions } from '../../src/components/select-key.js';
import { type ScreenHarness, screenSetup, tick } from './helpers.js';
import { describe, expect, it } from 'vitest';

const ENTER = '\r';
const CTRL_C = '\u0003';
const CTRL_Y = '\u0019';
const DOWN = '\u001b[B';

/** Sends keys one at a time, letting the prompt act on each. */
async function type(stdin: { send(chunk: string): void }, ...chunks: string[]) {
  for (const chunk of chunks) {
    stdin.send(chunk);
    await tick();
  }
}

/** Starts the prompt and reports how it settled, for `prompt.test.ts`'s reason. */
function settle<T>(promise: Promise<T>): Promise<{ error?: PromptError; value?: T }> {
  return promise.then(
    (value) => ({ value }),
    (error: PromptError) => ({ error })
  );
}

/** A prompt over a screen, with no theme and no colour. */
function open<T = string>(ui: ScreenHarness, opts: Partial<SelectKeyOptions<T>> = {}) {
  return selectKey<T>({
    ansi: ui.ansi,
    message: 'File exists',
    terminal: ui.terminal,
    ...opts,
  } as SelectKeyOptions<T>);
}

/** What the screen shows now, one row per entry, blank rows dropped. */
function rows(ui: ScreenHarness): string[] {
  return ui.log.map((line) => line.trimEnd()).filter((line) => line !== '');
}

const ACTIONS = [
  { key: 'o', label: 'Overwrite', value: 'overwrite' },
  { key: 's', label: 'Skip', value: 'skip' },
  { key: 'd', label: 'Show the diff', value: 'diff' },
];

describe('selectKey() by key', () => {
  it('should list each choice with the key that answers it', async () => {
    const ui = screenSetup({ rows: 10 });
    const answer = settle(open(ui, { choices: ACTIONS }));

    await tick();

    expect(rows(ui)).toEqual([
      '? File exists',
      '  o) Overwrite',
      '  s) Skip',
      '  d) Show the diff',
    ]);

    await type(ui.stdin, CTRL_C);
    await answer;
  });

  it("should answer with a choice's value as soon as its key is pressed", async () => {
    const ui = screenSetup({ rows: 10 });
    const answer = settle(open(ui, { choices: ACTIONS }));

    await type(ui.stdin, 's');

    expect((await answer).value).toBe('skip');
  });

  it('should answer with the label when a choice has no value', async () => {
    const ui = screenSetup({ rows: 10 });
    const answer = settle(open(ui, { choices: [{ key: 'a', label: 'All' }] }));

    await type(ui.stdin, 'a');

    expect((await answer).value).toBe('All');
  });

  it('should ignore a key that no choice has, and wait', async () => {
    const ui = screenSetup({ rows: 10 });
    const answer = settle(open(ui, { choices: ACTIONS }));

    await type(ui.stdin, 'x', DOWN, ' ');
    await type(ui.stdin, 'd');

    expect((await answer).value).toBe('diff');
  });

  it('should not answer for Enter when nothing is the default', async () => {
    const ui = screenSetup({ rows: 10 });
    const answer = settle(open(ui, { choices: ACTIONS }));

    await type(ui.stdin, ENTER);
    expect(rows(ui)[0]).toBe('? File exists');

    await type(ui.stdin, 'o');
    expect((await answer).value).toBe('overwrite');
  });

  it('should leave the question and its answer in the log', async () => {
    const ui = screenSetup({ rows: 10 });
    const answer = settle(open(ui, { choices: ACTIONS }));

    await type(ui.stdin, 'd');
    await answer;

    expect(rows(ui)).toEqual(['? File exists Show the diff']);
  });

  it("should leave a choice's `short` in the log in place of its label", async () => {
    const ui = screenSetup({ rows: 10 });
    const answer = settle(
      open(ui, { choices: [{ key: 'd', label: 'Show the diff, then ask again', short: 'Diff' }] })
    );

    await type(ui.stdin, 'd');
    await answer;

    expect(rows(ui)).toEqual(['? File exists Diff']);
  });

  it('should take a heading between the choices and give it no key', async () => {
    const ui = screenSetup({ rows: 10 });
    const answer = settle(
      open(ui, {
        choices: [{ separator: 'Existing' }, ACTIONS[0], { separator: 'Other' }, ACTIONS[1]],
      })
    );

    await tick();

    expect(rows(ui)).toEqual(['? File exists', 'Existing', '  o) Overwrite', 'Other', '  s) Skip']);

    await type(ui.stdin, 's');
    expect((await answer).value).toBe('skip');
  });

  it('should show a hint beside the label', async () => {
    const ui = screenSetup({ rows: 10 });
    const answer = settle(
      open(ui, { choices: [{ hint: 'cannot be undone', key: 'o', label: 'Overwrite' }] })
    );

    await tick();

    expect(rows(ui)[1]).toBe('  o) Overwrite cannot be undone');

    await type(ui.stdin, CTRL_C);
    await answer;
  });
});

describe('selectKey() and case', () => {
  it('should answer for a capital letter as for the lower case one', async () => {
    const ui = screenSetup({ rows: 10 });
    const answer = settle(open(ui, { choices: ACTIONS }));

    await type(ui.stdin, 'S');

    expect((await answer).value).toBe('skip');
  });

  it('should answer for a key declared in capitals by the lower case one', async () => {
    const ui = screenSetup({ rows: 10 });
    const answer = settle(open(ui, { choices: [{ key: 'Q', label: 'Quit', value: 'quit' }] }));

    await tick();
    expect(rows(ui)[1]).toBe('  Q) Quit');

    await type(ui.stdin, 'q');
    expect((await answer).value).toBe('quit');
  });

  it('should refuse two choices whose keys differ only by case', async () => {
    const ui = screenSetup({ rows: 10 });
    const { error } = await settle(
      open(ui, {
        choices: [
          { key: 'y', label: 'Yes' },
          { key: 'Y', label: 'Yes to all' },
        ],
      })
    );

    expect(error).toBeInstanceOf(PromptError);
    expect(error?.message).toBe(
      '"File exists" cannot be asked: "Yes" and "Yes to all" both use the key "Y" (case does not tell keys apart)'
    );
  });

  it('should not read a key held with a modifier as the key', async () => {
    const ui = screenSetup({ rows: 10 });
    const answer = settle(open(ui, { choices: [{ key: 'y', label: 'Yes', value: true }] }));

    await type(ui.stdin, CTRL_Y, '\u001by');
    expect(rows(ui)[0]).toBe('? File exists');

    await type(ui.stdin, 'y');
    expect((await answer).value).toBe(true);
  });
});

describe('selectKey() refusing a list that cannot work', () => {
  it('should refuse two choices that share a key, naming both', async () => {
    const ui = screenSetup({ rows: 10 });
    const { error } = await settle(
      open(ui, {
        choices: [
          { key: 's', label: 'Skip' },
          { key: 's', label: 'Stop' },
        ],
      })
    );

    expect(error?.message).toBe(
      '"File exists" cannot be asked: "Skip" and "Stop" both use the key "s" (case does not tell keys apart)'
    );
  });

  it('should refuse a key that is not one character', async () => {
    const ui = screenSetup({ rows: 10 });
    const { error } = await settle(open(ui, { choices: [{ key: 'ab', label: 'Both' }] }));

    expect(error?.message).toBe(
      '"File exists" cannot be asked: the `key` of "Both" is "ab", which is not one character'
    );
  });

  it.each(['', ' ', '\t', '\u001b'])('should refuse %j as a key', async (key) => {
    const ui = screenSetup({ rows: 10 });
    const { error } = await settle(open(ui, { choices: [{ key, label: 'Odd' }] }));

    expect(error).toBeInstanceOf(PromptError);
    expect(error?.message).toContain('which is not one character');
  });

  it('should take an emoji that is one code point as a key', async () => {
    const ui = screenSetup({ rows: 10 });
    const answer = settle(open(ui, { choices: [{ key: '🍕', label: 'Pizza', value: 'pizza' }] }));

    await type(ui.stdin, '🍕');

    expect((await answer).value).toBe('pizza');
  });

  it('should refuse a key that is several code points, which no keypress is', async () => {
    const ui = screenSetup({ rows: 10 });
    const { error } = await settle(open(ui, { choices: [{ key: '🇳🇴', label: 'Norway' }] }));

    expect(error?.message).toContain('which is not one character');
  });

  it('should refuse a choice with no key when the prompt is not numbered', async () => {
    const ui = screenSetup({ rows: 10 });
    const { error } = await settle(open(ui, { choices: ['Overwrite'] }));

    expect(error?.message).toBe(
      '"File exists" cannot be asked: "Overwrite" has no `key`, and `numbered` is not set'
    );
  });

  it('should refuse a list with nothing in it, and one with nothing on offer', async () => {
    const ui = screenSetup({ rows: 10 });

    expect((await settle(open(ui, { choices: [] }))).error?.message).toBe(
      '"File exists" has no choices to offer'
    );
    expect(
      (await settle(open(ui, { choices: [{ disabled: true, key: 'a', label: 'A' }] }))).error
        ?.message
    ).toBe('"File exists" has no choices to offer');
  });

  it('should refuse an `initial` that is not the key of a choice', async () => {
    const ui = screenSetup({ rows: 10 });
    const { error } = await settle(open(ui, { choices: ACTIONS, initial: 'z' }));

    expect(error?.message).toBe(
      '"File exists" cannot be asked: `initial` "z" is not the key of a choice on offer'
    );
  });

  it('should refuse an `initial` that names a disabled choice', async () => {
    const ui = screenSetup({ rows: 10 });
    const { error } = await settle(
      open(ui, {
        choices: [ACTIONS[0], { disabled: true, key: 'x', label: 'Delete' }],
        initial: 'x',
      })
    );

    expect(error?.message).toContain('`initial` "x" is not the key of a choice on offer');
  });

  it('should reject where there is no terminal rather than wait', async () => {
    const ui = screenSetup({ isTTY: false, rows: 10 });
    const { error } = await settle(open(ui, { choices: ACTIONS }));

    expect(error).toBeInstanceOf(PromptError);
    expect(error?.message).toContain('Cannot prompt for "File exists"');
  });
});

describe('selectKey() and a disabled choice', () => {
  const CHOICES = [
    ACTIONS[0],
    { disabled: 'read only', key: 'x', label: 'Delete' },
    { disabled: true, key: 'z', label: 'Zap' },
  ];

  it('should show the reason, or `disabled`, where a hint would be', async () => {
    const ui = screenSetup({ rows: 10 });
    const answer = settle(open(ui, { choices: CHOICES }));

    await tick();

    expect(rows(ui)).toEqual([
      '? File exists',
      '  o) Overwrite',
      '  x) Delete read only',
      '  z) Zap disabled',
    ]);

    await type(ui.stdin, CTRL_C);
    await answer;
  });

  it('should do nothing for the key of a disabled choice', async () => {
    const ui = screenSetup({ rows: 10 });
    const answer = settle(open(ui, { choices: CHOICES }));

    await type(ui.stdin, 'x', 'z');
    expect(rows(ui)[0]).toBe('? File exists');

    await type(ui.stdin, 'o');
    expect((await answer).value).toBe('overwrite');
  });

  it('should still keep a disabled choice key from being shared', async () => {
    const ui = screenSetup({ rows: 10 });
    const { error } = await settle(
      open(ui, {
        choices: [
          { disabled: true, key: 'x', label: 'Delete' },
          { key: 'x', label: 'Extract' },
        ],
      })
    );

    expect(error?.message).toContain('"Delete" and "Extract" both use the key "x"');
  });
});

describe('selectKey() with a default', () => {
  it('should answer with the `initial` choice on Enter', async () => {
    const ui = screenSetup({ rows: 10 });
    const answer = settle(open(ui, { choices: ACTIONS, initial: 's' }));

    await type(ui.stdin, ENTER);

    expect((await answer).value).toBe('skip');
  });

  it('should take `initial` as a key, whatever its case', async () => {
    const ui = screenSetup({ rows: 10 });
    const answer = settle(open(ui, { choices: ACTIONS, initial: 'S' }));

    await type(ui.stdin, ENTER);

    expect((await answer).value).toBe('skip');
  });

  it('should point at the choice Enter takes, and keep the other labels aligned with it', async () => {
    const ui = screenSetup({ rows: 10 });
    const answer = settle(open(ui, { choices: ACTIONS, initial: 's' }));

    await tick();

    expect(rows(ui)).toEqual([
      '? File exists',
      '  o) Overwrite',
      '❯ s) Skip',
      '  d) Show the diff',
    ]);

    await type(ui.stdin, CTRL_C);
    await answer;
  });

  it('should still answer with another choice when its key is pressed', async () => {
    const ui = screenSetup({ rows: 10 });
    const answer = settle(open(ui, { choices: ACTIONS, initial: 's' }));

    await type(ui.stdin, 'd');

    expect((await answer).value).toBe('diff');
  });
});

describe('selectKey() numbered', () => {
  it('should number the choices that have no key, from 1', async () => {
    const ui = screenSetup({ rows: 10 });
    const answer = settle(open(ui, { choices: ['Red', 'Green', 'Blue'], numbered: true }));

    await tick();

    expect(rows(ui)).toEqual(['? File exists', '  1) Red', '  2) Green', '  3) Blue']);

    await type(ui.stdin, '2');
    expect((await answer).value).toBe('Green');
  });

  it('should not count a heading as a position', async () => {
    const ui = screenSetup({ rows: 10 });
    const answer = settle(
      open(ui, { choices: ['Red', { separator: 'Cool' }, 'Green'], numbered: true })
    );

    await tick();
    expect(rows(ui)).toEqual(['? File exists', '  1) Red', 'Cool', '  2) Green']);

    await type(ui.stdin, '2');
    expect((await answer).value).toBe('Green');
  });

  it('should keep a disabled choice its number, so the others do not shift', async () => {
    const ui = screenSetup({ rows: 10 });
    const answer = settle(
      open(ui, {
        choices: [{ disabled: true, label: 'Red' }, 'Green', 'Blue'],
        numbered: true,
      })
    );

    await type(ui.stdin, '1');
    await type(ui.stdin, '3');

    expect((await answer).value).toBe('Blue');
  });

  it('should let a choice with a key of its own keep it, and number the rest by position', async () => {
    const ui = screenSetup({ rows: 10 });
    const answer = settle(
      open(ui, { choices: ['Red', { key: 'q', label: 'Quit' }, 'Blue'], numbered: true })
    );

    await tick();
    expect(rows(ui)).toEqual(['? File exists', '  1) Red', '  q) Quit', '  3) Blue']);

    await type(ui.stdin, '3');
    expect((await answer).value).toBe('Blue');
  });

  it('should refuse an explicit key that is the number another choice was given', async () => {
    const ui = screenSetup({ rows: 10 });
    const { error } = await settle(
      open(ui, { choices: ['Red', { key: '1', label: 'One' }], numbered: true })
    );

    expect(error?.message).toContain('"Red" and "One" both use the key "1"');
  });

  it('should refuse a tenth unkeyed choice, which has no single digit', async () => {
    const ui = screenSetup({ rows: 20 });
    const labels = Array.from({ length: 10 }, (_, i) => `Item ${i + 1}`);
    const { error } = await settle(open(ui, { choices: labels, numbered: true }));

    expect(error?.message).toBe(
      '"File exists" cannot be asked: "Item 10" is choice 10, past the ninth, and needs a `key` of its own'
    );
  });

  it('should take a tenth choice that has a key', async () => {
    const ui = screenSetup({ rows: 20 });
    const labels: (string | { key: string; label: string })[] = Array.from(
      { length: 9 },
      (_, i) => `Item ${i + 1}`
    );
    labels.push({ key: 'z', label: 'Last' });
    const answer = settle(open(ui, { choices: labels, numbered: true }));

    await type(ui.stdin, 'z');

    expect((await answer).value).toBe('Last');
  });
});

describe('selectKey() expanded', () => {
  const CHOICES = [
    { key: 'y', label: 'Yes', value: 'yes' },
    { key: 'n', label: 'No', value: 'no' },
    { key: 'a', label: 'All', value: 'all' },
    { key: 'd', label: 'Diff', value: 'diff' },
  ];

  it('should show one line of keys and not the list', async () => {
    const ui = screenSetup({ rows: 10 });
    const answer = settle(open(ui, { choices: CHOICES, expand: true }));

    await tick();

    expect(rows(ui)).toEqual(['? File exists (y/n/a/d/h)']);

    await type(ui.stdin, CTRL_C);
    await answer;
  });

  it('should capitalise the key Enter takes, as the yes-or-no prompt does', async () => {
    const ui = screenSetup({ rows: 10 });
    const answer = settle(open(ui, { choices: CHOICES, expand: true, initial: 'n' }));

    await tick();

    expect(rows(ui)).toEqual(['? File exists (y/N/a/d/h)']);

    await type(ui.stdin, ENTER);
    expect((await answer).value).toBe('no');
  });

  it('should print a capital only on the key Enter takes', async () => {
    const ui = screenSetup({ rows: 10 });
    const answer = settle(
      open(ui, {
        choices: [
          { key: 'Y', label: 'Yes', value: 'yes' },
          { key: 'N', label: 'No', value: 'no' },
          { key: 'Q', label: 'Quit', value: 'quit' },
        ],
        expand: true,
        initial: 'n',
      })
    );

    await tick();

    expect(rows(ui)).toEqual(['? File exists (y/N/q/h)']);

    await type(ui.stdin, CTRL_C);
    await answer;
  });

  it('should print no capital where Enter takes nothing', async () => {
    const ui = screenSetup({ rows: 10 });
    const answer = settle(
      open(ui, {
        choices: [
          { key: 'Y', label: 'Yes', value: 'yes' },
          { key: 'n', label: 'No', value: 'no' },
        ],
        expand: true,
      })
    );

    await tick();

    expect(rows(ui)).toEqual(['? File exists (y/n/h)']);

    await type(ui.stdin, CTRL_C);
    await answer;
  });

  it('should answer from the line without ever showing the list', async () => {
    const ui = screenSetup({ rows: 10 });
    const answer = settle(open(ui, { choices: CHOICES, expand: true }));

    await type(ui.stdin, 'a');

    expect((await answer).value).toBe('all');
    expect(rows(ui)).toEqual(['? File exists All']);
  });

  it.each(['h', 'H', '?'])('should show the list when %s is pressed', async (help) => {
    const ui = screenSetup({ rows: 10 });
    const answer = settle(open(ui, { choices: CHOICES, expand: true }));

    await type(ui.stdin, help);

    expect(rows(ui)).toEqual(['? File exists', '  y) Yes', '  n) No', '  a) All', '  d) Diff']);

    await type(ui.stdin, 'd');
    expect((await answer).value).toBe('diff');
  });

  it('should keep answering by key once the list is shown', async () => {
    const ui = screenSetup({ rows: 10 });
    const answer = settle(open(ui, { choices: CHOICES, expand: true }));

    await type(ui.stdin, 'h', 'h', 'n');

    expect((await answer).value).toBe('no');
  });

  it('should leave out of the line a key that does nothing', async () => {
    const ui = screenSetup({ rows: 10 });
    const answer = settle(
      open(ui, {
        choices: [CHOICES[0], { disabled: true, key: 'n', label: 'No' }, CHOICES[2]],
        expand: true,
      })
    );

    await tick();
    expect(rows(ui)).toEqual(['? File exists (y/a/h)']);

    await type(ui.stdin, CTRL_C);
    await answer;
  });

  it('should leave out of the line the headings, and put them back with the list', async () => {
    const ui = screenSetup({ rows: 10 });
    const answer = settle(
      open(ui, { choices: [{ separator: 'Answers' }, CHOICES[0], CHOICES[1]], expand: true })
    );

    await tick();
    expect(rows(ui)).toEqual(['? File exists (y/n/h)']);

    await type(ui.stdin, 'h');
    expect(rows(ui)).toEqual(['? File exists', 'Answers', '  y) Yes', '  n) No']);

    await type(ui.stdin, CTRL_C);
    await answer;
  });

  it.each(['h', '?'])(
    'should refuse a choice that uses %s, which is kept for help',
    async (key) => {
      const ui = screenSetup({ rows: 10 });
      const { error } = await settle(open(ui, { choices: [{ key, label: 'Hold' }], expand: true }));

      expect(error?.message).toBe(
        `"File exists" cannot be asked: "Hold" uses the key "${key}", which \`expand\` keeps for help`
      );
    }
  );

  it('should leave `h` to a choice when the prompt is not expanded', async () => {
    const ui = screenSetup({ rows: 10 });
    const answer = settle(open(ui, { choices: [{ key: 'h', label: 'Hold', value: 'hold' }] }));

    await type(ui.stdin, 'h');

    expect((await answer).value).toBe('hold');
  });

  it('should number the choices and expand them as well', async () => {
    const ui = screenSetup({ rows: 10 });
    const answer = settle(open(ui, { choices: ['Red', 'Green'], expand: true, numbered: true }));

    await tick();
    expect(rows(ui)).toEqual(['? File exists (1/2/h)']);

    await type(ui.stdin, 'h');
    expect(rows(ui)).toEqual(['? File exists', '  1) Red', '  2) Green']);

    await type(ui.stdin, '2');
    expect((await answer).value).toBe('Green');
  });
});
