import {
  type Choice,
  type ChoiceEntry,
  multiselect,
  PROMPT_SYMBOLS,
  PromptError,
  select,
  separator,
} from '../../src/components/prompt.js';
import { type ScreenHarness, screenSetup, tick } from './helpers.js';
import { describe, expect, it } from 'vitest';

/**
 * What a choice list can say about a choice: that it is not on offer, that it is
 * a heading rather than a choice, that it has more to say than its label, and
 * what it reads as once answered.
 *
 * A separate file from `prompt.test.ts` so that file stays the regression suite
 * for the rewrite: an addition that needed one of those cases moved would be a
 * change to behaviour that was already there.
 */

const ENTER = '\r';
const UP = '\u001b[A';
const DOWN = '\u001b[B';
const HOME = '\u001b[H';
const END = '\u001b[F';
const SPACE = ' ';

/** Sends keys one at a time, letting the prompt act on each. */
async function type(stdin: { send(chunk: string): void }, ...chunks: string[]): Promise<void> {
  for (const chunk of chunks) {
    stdin.send(chunk);
    await tick();
  }
}

/**
 * Which row the pointer is on.
 *
 * Read off the picture, which is what a person sees, rather than off any state
 * the prompt keeps.
 *
 * @param ui - The harness.
 * @returns The text of the highlighted row, without the pointer.
 */
function pointed(ui: ScreenHarness): string {
  const rows = ui.log.filter((line) => line.includes(PROMPT_SYMBOLS.cursor));
  expect(rows, 'exactly one row has the pointer').toHaveLength(1);
  return rows[0].replace(PROMPT_SYMBOLS.cursor, '').trim();
}

/** Starts a select and hands back the harness and the answer. */
function ask<T = string>(
  choices: readonly ChoiceEntry<T>[],
  extra: { initial?: number; loop?: boolean; rows?: number } = {}
): { answer: Promise<T>; ui: ScreenHarness } {
  const ui = screenSetup({ rows: extra.rows });
  const answer = select<T>({
    ansi: ui.ansi,
    choices,
    initial: extra.initial,
    loop: extra.loop,
    message: 'Pick',
    terminal: ui.terminal,
  });
  return { answer, ui };
}

describe('a separator in select()', () => {
  it('should be skipped by the cursor in both directions', async () => {
    const { answer, ui } = ask(['one', separator('Group'), 'two']);

    await tick();
    expect(pointed(ui)).to.equal('one');

    await type(ui.stdin, DOWN);
    expect(pointed(ui)).to.equal('two');

    await type(ui.stdin, UP);
    expect(pointed(ui)).to.equal('one');

    await type(ui.stdin, DOWN, ENTER);
    expect(await answer).to.equal('two');
  });

  it('should draw its label as a heading no choice can be mistaken for', async () => {
    const { ui } = ask([separator('Fruit'), 'apple', separator('Veg'), 'leek']);

    await tick();
    const rows = ui.log.map((line) => line.trim());

    expect(rows).to.include('Fruit');
    expect(rows).to.include('Veg');
    expect(pointed(ui)).to.equal('apple');
  });

  it('should start on the first choice even when initial names a separator', async () => {
    const { answer, ui } = ask([separator('Group'), 'one', 'two'], { initial: 0 });

    await type(ui.stdin, ENTER);

    expect(await answer).to.equal('one');
  });

  it('should leave the heading rule to a default label', async () => {
    const { ui } = ask(['one', separator(), 'two']);

    await tick();

    expect(ui.log.join('\n')).to.contain(separator().separator);
  });
});

describe('a disabled choice in select()', () => {
  const choices: Choice<string>[] = [
    { label: 'free' },
    { disabled: 'needs a licence', label: 'pro' },
    { disabled: true, label: 'team' },
    { label: 'oss' },
  ];

  it('should be passed over by the cursor, and never returned', async () => {
    const { answer, ui } = ask(choices);

    await type(ui.stdin, DOWN);
    expect(pointed(ui)).to.equal('oss');

    await type(ui.stdin, UP);
    expect(pointed(ui)).to.equal('free');

    await type(ui.stdin, DOWN, ENTER);
    expect(await answer).to.equal('oss');
  });

  it('should show the reason where a hint would be', async () => {
    const { ui } = ask(choices);

    await tick();

    expect(ui.log.join('\n')).to.contain('pro needs a licence');
  });

  it('should say disabled when there is no reason', async () => {
    const { ui } = ask(choices);

    await tick();

    expect(ui.log.join('\n')).to.contain('team disabled');
  });

  it('should move initial to the next choice on offer', async () => {
    const { answer, ui } = ask(choices, { initial: 1 });

    await type(ui.stdin, ENTER);

    expect(await answer).to.equal('oss');
  });

  it('should wrap past it from the last choice to the first', async () => {
    const { answer, ui } = ask(choices, { initial: 3 });

    await type(ui.stdin, DOWN, ENTER);

    expect(await answer).to.equal('free');
  });

  it('should send Home and End to the nearest choice on offer', async () => {
    const { answer, ui } = ask([
      separator('Top'),
      { disabled: true, label: 'first' },
      'second',
      'third',
      { disabled: true, label: 'last' },
    ]);

    await type(ui.stdin, END);
    expect(pointed(ui)).to.equal('third');

    await type(ui.stdin, HOME);
    expect(pointed(ui)).to.equal('second');

    await type(ui.stdin, ENTER);
    expect(await answer).to.equal('second');
  });

  it('should refuse a list with nothing on offer, as it does an empty one', async () => {
    const ui = screenSetup();

    await expect(
      select({
        ansi: ui.ansi,
        choices: [{ disabled: true, label: 'no' }, separator('only a heading')],
        message: 'Pick',
        terminal: ui.terminal,
      })
    ).rejects.toThrow('has no choices to offer');
  });
});

describe('loop in select()', () => {
  it('should stop at the first choice rather than wrapping when false', async () => {
    const { answer, ui } = ask(['one', 'two', 'three'], { loop: false });

    await type(ui.stdin, UP, ENTER);

    expect(await answer).to.equal('one');
  });

  it('should stop at the last choice rather than wrapping when false', async () => {
    const { answer, ui } = ask(['one', 'two', 'three'], { initial: 2, loop: false });

    await type(ui.stdin, DOWN, ENTER);

    expect(await answer).to.equal('three');
  });

  it('should stop at the last choice on offer, not at a disabled one beyond it', async () => {
    const { answer, ui } = ask(['one', 'two', { disabled: true, label: 'three' }], {
      initial: 1,
      loop: false,
    });

    await type(ui.stdin, DOWN, ENTER);

    expect(await answer).to.equal('two');
  });

  it('should wrap by default', async () => {
    const { answer, ui } = ask(['one', 'two', 'three']);

    await type(ui.stdin, UP, ENTER);

    expect(await answer).to.equal('three');
  });
});

describe('a description in select()', () => {
  const choices: Choice<string>[] = [
    { description: 'The quick one', label: 'fast' },
    { label: 'plain' },
    { description: 'The careful one', label: 'safe' },
  ];

  it('should show the highlighted choice description under the list', async () => {
    const { ui } = ask(choices);

    await tick();
    expect(ui.log.join('\n')).to.contain('The quick one');
    expect(ui.log.join('\n')).not.to.contain('The careful one');

    await type(ui.stdin, DOWN, DOWN);
    expect(ui.log.join('\n')).to.contain('The careful one');
    expect(ui.log.join('\n')).not.to.contain('The quick one');
  });

  it('should show nothing for a choice without one', async () => {
    const { ui } = ask(choices);

    await type(ui.stdin, DOWN);

    expect(ui.log.join('\n')).not.to.contain('The quick one');
    expect(ui.log.join('\n')).not.to.contain('The careful one');
  });

  it('should keep a row back for it, so that the last choice stays on screen', async () => {
    // the question takes one row, the description one, which leaves two of three
    const many = ['a', 'b', 'c', 'd', 'e'].map((label): Choice<string> => ({
      description: `about ${label}`,
      label,
    }));
    const { ui } = ask(many, { rows: 4 });

    await type(ui.stdin, END);

    expect(pointed(ui)).to.equal('e');
    expect(ui.log.join('\n')).to.contain('about e');
  });

  it('should go with the list once answered', async () => {
    const { answer, ui } = ask(choices);

    await type(ui.stdin, ENTER);
    await answer;

    expect(ui.log.join('\n')).not.to.contain('The quick one');
  });
});

describe('short', () => {
  it('should be what select() leaves behind once answered', async () => {
    const { answer, ui } = ask<string>([
      { label: 'Production (us-east-1)', short: 'prod', value: 'p' },
    ]);

    await type(ui.stdin, ENTER);

    expect(await answer).to.equal('p');
    const text = ui.log.join('\n');
    expect(text).to.contain('prod');
    expect(text).not.to.contain('us-east-1');
  });

  it('should be what multiselect() joins into its answered line', async () => {
    const ui = screenSetup();
    const answer = multiselect({
      ansi: ui.ansi,
      choices: [
        { label: 'TypeScript (recommended)', short: 'ts' },
        { label: 'Linting (oxlint)', short: 'lint' },
      ],
      message: 'Pick',
      terminal: ui.terminal,
    });

    await type(ui.stdin, SPACE, DOWN, SPACE, ENTER);

    expect(await answer).to.deep.equal(['TypeScript (recommended)', 'Linting (oxlint)']);
    expect(ui.log.join('\n')).to.contain('ts, lint');
  });
});

/** Starts a multiselect and hands back the harness and the answer. */
function pick<T = string>(
  choices: readonly ChoiceEntry<T>[],
  extra: { max?: number; min?: number; required?: boolean } = {}
): { answer: Promise<T[]>; ui: ScreenHarness } {
  const ui = screenSetup({ rows: 10 });
  const answer = multiselect<T>({
    ansi: ui.ansi,
    choices,
    message: 'Pick',
    terminal: ui.terminal,
    ...extra,
  });
  return { answer, ui };
}

describe('a disabled choice in multiselect()', () => {
  const choices: Choice<string>[] = [
    { label: 'a' },
    { disabled: 'not yet', label: 'b', selected: true },
    { label: 'c' },
  ];

  it('should never be ticked, whatever selected says', async () => {
    const { answer, ui } = pick(choices);

    await type(ui.stdin, ENTER);

    expect(await answer).to.deep.equal([]);
  });

  it('should be passed over by the cursor, so Space cannot reach it', async () => {
    const { answer, ui } = pick(choices);

    await type(ui.stdin, DOWN, SPACE, ENTER);

    expect(await answer).to.deep.equal(['c']);
  });

  it('should keep a separator out of the answer and out of the cursor path', async () => {
    const { answer, ui } = pick(['a', separator('More'), 'b']);

    await type(ui.stdin, DOWN, SPACE, ENTER);

    expect(await answer).to.deep.equal(['b']);
  });
});

describe('select-all and invert in multiselect()', () => {
  const choices: Choice<string>[] = [
    { label: 'a' },
    { disabled: true, label: 'b' },
    { label: 'c' },
    { label: 'd' },
  ];

  it('should tick everything on offer with a, and leave a disabled choice out', async () => {
    const { answer, ui } = pick(choices);

    await type(ui.stdin, 'a', ENTER);

    expect(await answer).to.deep.equal(['a', 'c', 'd']);
  });

  it('should untick everything with a second a', async () => {
    const { answer, ui } = pick(choices);

    await type(ui.stdin, 'a', 'a', ENTER);

    expect(await answer).to.deep.equal([]);
  });

  it('should tick what is left when some are already ticked', async () => {
    const { answer, ui } = pick(choices);

    await type(ui.stdin, SPACE, 'a', ENTER);

    expect(await answer).to.deep.equal(['a', 'c', 'd']);
  });

  it('should still take ctrl-a for select-all', async () => {
    const { answer, ui } = pick(choices);

    await type(ui.stdin, '\u0001', ENTER);

    expect(await answer).to.deep.equal(['a', 'c', 'd']);
  });

  it('should flip every choice on offer with i', async () => {
    const { answer, ui } = pick(choices);

    await type(ui.stdin, SPACE, 'i', ENTER);

    expect(await answer).to.deep.equal(['c', 'd']);
  });

  it('should not read an alt-modified a or i as either', async () => {
    const { answer, ui } = pick(choices);

    await type(ui.stdin, '\u001ba', '\u001bi', ENTER);

    expect(await answer).to.deep.equal([]);
  });
});

describe('min and max in multiselect()', () => {
  it('should refuse fewer than min, naming the number', async () => {
    const { answer, ui } = pick(['a', 'b', 'c'], { min: 2 });

    await type(ui.stdin, SPACE, ENTER);
    expect(ui.log.join('\n')).to.contain('Choose at least 2');

    await type(ui.stdin, DOWN, SPACE, ENTER);
    expect(await answer).to.deep.equal(['a', 'b']);
  });

  it('should refuse more than max, naming the number', async () => {
    const { answer, ui } = pick(['a', 'b', 'c'], { max: 1 });

    await type(ui.stdin, 'a', ENTER);
    expect(ui.log.join('\n')).to.contain('Choose at most 1');

    await type(ui.stdin, 'a', SPACE, ENTER);
    expect(await answer).to.deep.equal(['a']);
  });

  it('should keep the message required has always had for a minimum of one', async () => {
    const { answer, ui } = pick(['a'], { min: 1 });

    await type(ui.stdin, ENTER);
    expect(ui.log.join('\n')).to.contain('Choose at least one');

    await type(ui.stdin, SPACE, ENTER);
    expect(await answer).to.deep.equal(['a']);
  });

  it('should let min override what required implies', async () => {
    const { answer, ui } = pick(['a', 'b'], { min: 0, required: true });

    await type(ui.stdin, ENTER);

    expect(await answer).to.deep.equal([]);
  });

  it.each([
    ['a max that is not a number', { max: Number.NaN }],
    ['a fractional min', { min: 1.5 }],
    ['a negative min', { min: -1 }],
  ])('should reject %s rather than accept any number of choices', async (_name, extra) => {
    const ui = screenSetup();

    await expect(
      multiselect({
        ansi: ui.ansi,
        choices: ['a', 'b'],
        message: 'Pick',
        terminal: ui.terminal,
        ...extra,
      })
    ).rejects.toBeInstanceOf(PromptError);
  });

  it('should reject a min greater than its max', async () => {
    const ui = screenSetup();

    await expect(
      multiselect({
        ansi: ui.ansi,
        choices: ['a', 'b'],
        max: 1,
        message: 'Pick',
        min: 2,
        terminal: ui.terminal,
      })
    ).rejects.toThrow('min greater than its max');
  });

  it('should refuse a list with nothing on offer', async () => {
    const ui = screenSetup();

    await expect(
      multiselect({
        ansi: ui.ansi,
        choices: [{ disabled: true, label: 'a' }],
        message: 'Pick',
        terminal: ui.terminal,
      })
    ).rejects.toThrow('has no choices to offer');
  });
});
