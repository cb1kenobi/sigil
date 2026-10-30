import {
  autocompleteMultiselect,
  type AutocompleteMultiselectOptions,
} from '../../src/components/autocomplete.js';
import { PromptError } from '../../src/components/prompt.js';
import { type ScreenHarness, screenSetup, tick } from './helpers.js';
import { describe, expect, it, vi } from 'vitest';

const ENTER = '\r';
const SPACE = ' ';
const TAB = '\t';
const CTRL_C = '\u0003';
const BACKSPACE = '\u007f';
const UP = '\u001b[A';
const DOWN = '\u001b[B';

/** Sends keys one at a time, letting the prompt act on each. */
async function type(stdin: { send(chunk: string): void }, ...chunks: string[]) {
  for (const chunk of chunks) {
    stdin.send(chunk);
    await tick();
  }
}

/** Waits for a frame the renderer paced itself, for an answer with no key behind it. */
async function frame(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 10));
  await tick();
}

/** Starts the prompt and reports how it settled, with the handler attached first. */
function settle<T>(promise: Promise<T>): Promise<{ error?: PromptError; value?: T }> {
  return promise.then(
    (value) => ({ value }),
    (error: PromptError) => ({ error })
  );
}

/** A prompt over a screen, with no theme and no colour. */
function open<T = string>(
  ui: ScreenHarness,
  opts: Partial<AutocompleteMultiselectOptions<T>> = {}
) {
  return autocompleteMultiselect<T>({
    ansi: ui.ansi,
    frameMs: 0,
    message: 'Pick',
    terminal: ui.terminal,
    ...opts,
  } as AutocompleteMultiselectOptions<T>);
}

/** What the screen shows now, one row per entry, blank rows dropped. */
function rows(ui: ScreenHarness): string[] {
  return ui.log.map((line) => line.trimEnd()).filter((line) => line !== '');
}

const REGIONS = ['us-east-1', 'us-west-2', 'eu-central-1', 'ap-south-1'];
const HINT = '  (space to select, enter to confirm)';

describe('autocompleteMultiselect() over a static list', () => {
  it('should draw a tick box on every row, and say how to use them', async () => {
    const ui = screenSetup({ rows: 10 });
    const answer = settle(open(ui, { choices: REGIONS }));

    await tick();

    expect(rows(ui)).toEqual([
      '? Pick',
      '  ❯ ◯ us-east-1',
      '    ◯ us-west-2',
      '    ◯ eu-central-1',
      '    ◯ ap-south-1',
      HINT,
    ]);

    await type(ui.stdin, CTRL_C);
    await answer;
  });

  it('should tick the highlighted choice on Space, and untick it on a second', async () => {
    const ui = screenSetup({ rows: 10 });
    const answer = settle(open(ui, { choices: REGIONS }));

    await type(ui.stdin, SPACE);
    expect(rows(ui).slice(1, 3)).toEqual(['  ❯ ◉ us-east-1', '    ◯ us-west-2']);
    expect(rows(ui).at(-1)).toBe('  Selected: 1');

    await type(ui.stdin, SPACE);
    expect(rows(ui).slice(1, 2)).toEqual(['  ❯ ◯ us-east-1']);
    expect(rows(ui).at(-1)).toBe(HINT);

    await type(ui.stdin, CTRL_C);
    await answer;
  });

  it('should answer with every ticked value on Enter, not with the highlighted row', async () => {
    const ui = screenSetup({ rows: 10 });
    const answer = settle(open(ui, { choices: REGIONS }));

    await type(ui.stdin, SPACE, DOWN, DOWN, SPACE, DOWN, ENTER);

    expect((await answer).value).toEqual(['us-east-1', 'eu-central-1']);
  });

  it('should answer with an empty list when nothing is ticked and nothing is required', async () => {
    const ui = screenSetup({ rows: 10 });
    const answer = settle(open(ui, { choices: REGIONS }));

    await type(ui.stdin, ENTER);

    expect((await answer).value).toEqual([]);
  });

  it('should answer in the order of the list, whatever order they were ticked in', async () => {
    const ui = screenSetup({ rows: 10 });
    const answer = settle(open(ui, { choices: REGIONS }));

    await type(ui.stdin, DOWN, DOWN, DOWN, SPACE, UP, UP, UP, SPACE, ENTER);

    expect((await answer).value).toEqual(['us-east-1', 'ap-south-1']);
  });

  it("should answer with a choice's value, and with its label when it has none", async () => {
    const ui = screenSetup({ rows: 10 });
    const answer = settle(
      open<number | string>(ui, {
        choices: [{ label: 'Production', value: 3 }, { label: 'Staging' }],
      })
    );

    await type(ui.stdin, SPACE, DOWN, SPACE, ENTER);

    expect((await answer).value).toEqual([3, 'Staging']);
  });

  it('should start with a `selected` choice ticked', async () => {
    const ui = screenSetup({ rows: 10 });
    const answer = settle(
      open(ui, { choices: ['a', { label: 'b', selected: true }, { label: 'c', selected: true }] })
    );

    await tick();
    expect(rows(ui).slice(1, 4)).toEqual(['  ❯ ◯ a', '    ◉ b', '    ◉ c']);

    await type(ui.stdin, ENTER);
    expect((await answer).value).toEqual(['b', 'c']);
  });

  it('should narrow the list as a term is typed, and tick from what is left', async () => {
    const ui = screenSetup({ rows: 10 });
    const answer = settle(open(ui, { choices: REGIONS }));

    await type(ui.stdin, 'e', 'u');
    expect(rows(ui)).toEqual(['? Pick eu', '  ❯ ◯ eu-central-1', HINT]);

    await type(ui.stdin, SPACE, ENTER);
    expect((await answer).value).toEqual(['eu-central-1']);
  });

  it('should leave the ticks on the choices when the filter changes', async () => {
    const ui = screenSetup({ rows: 10 });
    const answer = settle(open(ui, { choices: REGIONS }));

    await type(ui.stdin, SPACE, 'e', 'u');
    // us-east-1 is hidden by "eu" but still ticked, and the line says so
    expect(rows(ui)).toEqual(['? Pick eu', '  ❯ ◯ eu-central-1', '  Selected: 1, 1 not shown']);

    await type(ui.stdin, BACKSPACE, BACKSPACE);
    expect(rows(ui).slice(1, 2)).toEqual(['  ❯ ◉ us-east-1']);
    expect(rows(ui).at(-1)).toBe('  Selected: 1');

    await type(ui.stdin, ENTER);
    expect((await answer).value).toEqual(['us-east-1']);
  });

  it('should answer with a choice the filter was hiding when Enter was pressed', async () => {
    const ui = screenSetup({ rows: 10 });
    const answer = settle(open(ui, { choices: REGIONS }));

    await type(ui.stdin, SPACE, 'e', 'u', SPACE, ENTER);

    expect((await answer).value).toEqual(['us-east-1', 'eu-central-1']);
  });

  it('should not type a space into the field', async () => {
    const ui = screenSetup({ rows: 10 });
    const answer = settle(open(ui, { choices: REGIONS }));

    await type(ui.stdin, 'u', SPACE);

    expect(rows(ui)[0]).toBe('? Pick u');

    await type(ui.stdin, CTRL_C);
    await answer;
  });

  it('should take a space in a pasted term', async () => {
    const ui = screenSetup({ rows: 10 });
    const answer = settle(open(ui, { choices: ['new york', 'new jersey', 'newark'] }));

    await type(ui.stdin, '\u001b[200~new j\u001b[201~');

    expect(rows(ui).slice(0, 2)).toEqual(['? Pick new j', '  ❯ ◯ new jersey']);

    await type(ui.stdin, CTRL_C);
    await answer;
  });

  it('should complete a label on Tab and still tick on Space', async () => {
    const ui = screenSetup({ rows: 10 });
    const answer = settle(open(ui, { choices: REGIONS }));

    await type(ui.stdin, 'a', 'p', TAB, SPACE, ENTER);

    expect((await answer).value).toEqual(['ap-south-1']);
  });

  it('should do nothing on Space when nothing matches', async () => {
    const ui = screenSetup({ rows: 10 });
    const answer = settle(open(ui, { choices: REGIONS }));

    await type(ui.stdin, 'z', 'z', SPACE);
    expect(rows(ui)).toEqual(['? Pick zz', '  No matches', HINT]);

    await type(ui.stdin, ENTER);
    expect((await answer).value).toEqual([]);
  });

  it('should leave the question and the ticked labels in the log', async () => {
    const ui = screenSetup({ rows: 10 });
    const answer = settle(
      open(ui, { choices: [{ label: 'us-east-1', short: 'east' }, 'us-west-2', 'eu-central-1'] })
    );

    await type(ui.stdin, SPACE, DOWN, DOWN, SPACE, ENTER);
    await answer;

    expect(rows(ui)).toEqual(['? Pick east, eu-central-1']);
  });

  it('should say none when nothing was ticked', async () => {
    const ui = screenSetup({ rows: 10 });
    const answer = settle(open(ui, { choices: REGIONS }));

    await type(ui.stdin, ENTER);
    await answer;

    expect(rows(ui)).toEqual(['? Pick none']);
  });

  it('should leave room for the tally under the list', async () => {
    const ui = screenSetup({ rows: 6 });
    const answer = settle(open(ui, { choices: REGIONS }));

    await tick();
    // 6 rows: the question, the foot, the tally, and three choices
    expect(ui.log.length).toBeLessThanOrEqual(6);
    expect(rows(ui)).toEqual([
      '? Pick',
      '  ❯ ◯ us-east-1',
      '    ◯ us-west-2',
      '    ◯ eu-central-1',
      HINT,
    ]);

    await type(ui.stdin, CTRL_C);
    await answer;
  });
});

describe('autocompleteMultiselect() and min, max and required', () => {
  it('should refuse an empty answer when required, and say how many', async () => {
    const ui = screenSetup({ rows: 10 });
    const answer = settle(open(ui, { choices: REGIONS, required: true }));

    await type(ui.stdin, ENTER);
    expect(rows(ui).join('\n')).toContain('Choose at least one');

    await type(ui.stdin, SPACE, ENTER);
    expect((await answer).value).toEqual(['us-east-1']);
  });

  it('should take min as the fewest, naming the number', async () => {
    const ui = screenSetup({ rows: 10 });
    const answer = settle(open(ui, { choices: REGIONS, min: 2 }));

    await type(ui.stdin, SPACE, ENTER);
    expect(rows(ui).join('\n')).toContain('Choose at least 2');

    await type(ui.stdin, DOWN, SPACE, ENTER);
    expect((await answer).value).toEqual(['us-east-1', 'us-west-2']);
  });

  it('should refuse more than max, and clear the message on the next key', async () => {
    const ui = screenSetup({ rows: 10 });
    const answer = settle(open(ui, { choices: REGIONS, max: 1 }));

    await type(ui.stdin, SPACE, DOWN, SPACE, ENTER);
    expect(rows(ui).join('\n')).toContain('Choose at most 1');

    await type(ui.stdin, SPACE);
    expect(rows(ui).join('\n')).not.toContain('Choose at most 1');

    await type(ui.stdin, ENTER);
    expect((await answer).value).toEqual(['us-east-1']);
  });

  it('should count a tick the filter is hiding against max', async () => {
    const ui = screenSetup({ rows: 10 });
    const answer = settle(open(ui, { choices: REGIONS, max: 1 }));

    await type(ui.stdin, SPACE, 'e', 'u', SPACE, ENTER);
    expect(rows(ui).join('\n')).toContain('Choose at most 1');

    await type(ui.stdin, SPACE, ENTER);
    expect((await answer).value).toEqual(['us-east-1']);
  });

  it('should count a tick the filter is hiding against min', async () => {
    const ui = screenSetup({ rows: 10 });
    const answer = settle(open(ui, { choices: REGIONS, required: true }));

    // nothing matches "z", so nothing is on screen to tick -- the one tick made
    // before it is still what satisfies `required`
    await type(ui.stdin, SPACE, 'z', ENTER);

    expect((await answer).value).toEqual(['us-east-1']);
  });

  it.each([
    ['a min that is not a whole number', { min: 1.5 }],
    ['a negative min', { min: -1 }],
    ['a max that is NaN', { max: Number.NaN }],
    ['a max that is not a whole number', { max: 2.5 }],
  ])('should refuse %s', async (_name, extra) => {
    const ui = screenSetup({ rows: 10 });
    const settled = await settle(open(ui, { choices: REGIONS, ...extra }));

    expect(settled.error?.message).toMatch(/not a whole number/);
  });

  it('should refuse a min greater than its max', async () => {
    const ui = screenSetup({ rows: 10 });
    const settled = await settle(open(ui, { choices: REGIONS, max: 1, min: 2 }));

    expect(settled.error?.message).toMatch(/min greater than its max/);
  });

  it('should hand the validator the values and keep the prompt open when it refuses', async () => {
    const ui = screenSetup({ rows: 10 });
    const validate = vi.fn((values: string[]) => (values.length < 2 ? 'Need two' : undefined));
    const answer = settle(open(ui, { choices: REGIONS, validate }));

    await type(ui.stdin, SPACE, ENTER);
    expect(rows(ui).join('\n')).toContain('Need two');
    expect(validate).toHaveBeenCalledWith(['us-east-1']);

    await type(ui.stdin, DOWN, SPACE, ENTER);
    expect((await answer).value).toEqual(['us-east-1', 'us-west-2']);
  });
});

describe('autocompleteMultiselect() and a disabled choice', () => {
  it('should not offer a disabled choice, and not tick it even when it is `selected`', async () => {
    const ui = screenSetup({ rows: 10 });
    const answer = settle(
      open(ui, {
        choices: [{ disabled: true, label: 'prod', selected: true }, 'dev', { label: 'qa' }],
      })
    );

    await tick();
    expect(rows(ui).slice(0, 3)).toEqual(['? Pick', '  ❯ ◯ dev', '    ◯ qa']);

    await type(ui.stdin, SPACE, ENTER);
    expect((await answer).value).toEqual(['dev']);
  });

  it('should refuse a list in which every choice is disabled', async () => {
    const ui = screenSetup({ rows: 10 });
    const settled = await settle(open(ui, { choices: [{ disabled: true, label: 'a' }] }));

    expect(settled.error?.message).toMatch(/no choices to offer/);
  });
});

describe('autocompleteMultiselect() over a source', () => {
  const NAMES = ['react', 'redux', 'express', 'axios'];
  const lookup = (term: string) => NAMES.filter((name) => name.includes(term));

  it('should keep a tick when a later lookup does not return that choice', async () => {
    const ui = screenSetup({ rows: 10 });
    const answer = settle(open(ui, { source: (term) => lookup(term) }));

    await frame();
    await type(ui.stdin, SPACE);
    await type(ui.stdin, 'e', 'x');
    await frame();

    expect(rows(ui)).toEqual(['? Pick ex', '  ❯ ◯ express', '  Selected: 1, 1 not shown']);

    await type(ui.stdin, BACKSPACE);
    await frame();
    expect(rows(ui).slice(1, 2)).toEqual(['  ❯ ◉ react']);

    await type(ui.stdin, ENTER);
    expect((await answer).value).toEqual(['react']);
  });

  it('should answer in the order ticked, since a source has no list order', async () => {
    const ui = screenSetup({ rows: 10 });
    const answer = settle(open(ui, { source: (term) => lookup(term) }));

    await frame();
    await type(ui.stdin, DOWN, DOWN, SPACE, UP, UP, SPACE, ENTER);

    expect((await answer).value).toEqual(['express', 'react']);
  });

  it('should not tick a row while a lookup is out, and should still confirm', async () => {
    let resolve!: (names: string[]) => void;
    const ui = screenSetup({ rows: 10 });
    const answer = settle(
      open(ui, {
        source: (term) =>
          term === ''
            ? NAMES
            : new Promise<string[]>((res) => {
                resolve = res;
              }),
      })
    );

    await frame();
    await type(ui.stdin, SPACE, 'x');
    // the list on screen is the empty term's, and its first row is not what is
    // being looked at any more: a second Space would untick it if it counted
    await type(ui.stdin, SPACE);
    expect(rows(ui).join('\n')).toContain('Searching...');
    expect(rows(ui).at(-1)).toBe('  Selected: 1');

    await type(ui.stdin, ENTER);
    expect((await answer).value).toEqual(['react']);
    resolve([]);
  });

  it('should leave a source result marked `selected` unticked', async () => {
    const ui = screenSetup({ rows: 10 });
    const answer = settle(open(ui, { source: () => [{ label: 'a', selected: true }, 'b'] }));

    await frame();
    expect(rows(ui).slice(1, 3)).toEqual(['  ❯ ◯ a', '    ◯ b']);

    await type(ui.stdin, ENTER);
    expect((await answer).value).toEqual([]);
  });

  it('should abort the lookup in flight when the prompt is answered', async () => {
    const ui = screenSetup({ rows: 10 });
    let signal: AbortSignal | undefined;
    const answer = settle(
      open(ui, {
        source: (_term, s) => {
          signal = s;
          return new Promise<string[]>(() => {});
        },
      })
    );

    await tick();
    await type(ui.stdin, ENTER);
    await answer;

    expect(signal?.aborted).toBe(true);
  });
});

describe('autocompleteMultiselect() where it cannot work', () => {
  it('should refuse to exist where the input is not a terminal', async () => {
    const ui = screenSetup({ inputTTY: false });
    const settled = await settle(open(ui, { choices: REGIONS }));

    expect(settled.error?.message).toMatch(/not a terminal/);
  });

  it('should refuse to be given neither choices nor a source', async () => {
    const ui = screenSetup({ rows: 10 });
    const settled = await settle(open(ui, {}));

    expect(settled.error?.message).toMatch(/needs either choices or a source/);
  });

  it('should refuse to be given both', async () => {
    const ui = screenSetup({ rows: 10 });
    const settled = await settle(open(ui, { choices: REGIONS, source: () => [] }));

    expect(settled.error?.message).toMatch(/both choices and a source/);
  });

  it('should leave Ctrl-C the abort every prompt takes', async () => {
    const ui = screenSetup({ rows: 10 });
    const answer = settle(open(ui, { choices: REGIONS }));

    await type(ui.stdin, CTRL_C);

    expect((await answer).error?.aborted).toBe(true);
  });
});
