import {
  groupMultiselect,
  type GroupMultiselectOptions,
} from '../../src/components/group-multiselect.js';
import { PromptError, separator } from '../../src/components/prompt.js';
import { type ScreenHarness, screenSetup, tick } from './helpers.js';
import { describe, expect, it } from 'vitest';

const ENTER = '\r';
const SPACE = ' ';
const UP = '\u001b[A';
const DOWN = '\u001b[B';
const HOME = '\u001b[H';
const END = '\u001b[F';
const CTRL_C = '\u0003';

/** Sends keys one at a time, letting the prompt act on each. */
async function type(stdin: { send(chunk: string): void }, ...chunks: string[]): Promise<void> {
  for (const chunk of chunks) {
    stdin.send(chunk);
    await tick();
  }
}

/** What the screen shows now, blank rows dropped. */
function rows(ui: ScreenHarness): string[] {
  return ui.log.map((line) => line.trimEnd()).filter((line) => line !== '');
}

/** Starts a prompt and hands back the harness and the answer. */
function ask<T = string>(
  choices: GroupMultiselectOptions<T>['choices'],
  extra: Partial<GroupMultiselectOptions<T>> = {},
  height = 14
): { answer: Promise<T[]>; ui: ScreenHarness } {
  const ui = screenSetup({ columns: 60, rows: height });
  const answer = groupMultiselect<T>({
    ansi: ui.ansi,
    choices,
    message: 'Pick',
    terminal: ui.terminal,
    ...extra,
  });
  // a prompt that is cancelled at the end of a test rejects, and a rejection
  // nothing was listening to is an unhandled one
  answer.catch(() => undefined);
  return { answer, ui };
}

const FEATURES = {
  Backend: ['Express', 'Fastify'],
  Frontend: ['React', 'Vue', 'Svelte'],
};

describe('groupMultiselect() drawing', () => {
  it('should list each group with its choices indented under it', async () => {
    const { answer, ui } = ask(FEATURES);

    await tick();

    expect(rows(ui)).toEqual([
      '? Pick (space to select, enter to confirm)',
      '❯ ◯ Backend',
      '    ◯ Express',
      '    ◯ Fastify',
      '  ◯ Frontend',
      '    ◯ React',
      '    ◯ Vue',
      '    ◯ Svelte',
    ]);

    await type(ui.stdin, CTRL_C);
    await answer.catch(() => undefined);
  });
});

describe('a group row in groupMultiselect()', () => {
  it('should tick every choice under it on Space', async () => {
    const { answer, ui } = ask(FEATURES);

    await type(ui.stdin, SPACE, ENTER);

    expect(await answer).toEqual(['Express', 'Fastify']);
  });

  it('should clear every choice under it when they are all ticked', async () => {
    const { answer, ui } = ask(FEATURES);

    await type(ui.stdin, SPACE, SPACE, ENTER);

    expect(await answer).toEqual([]);
  });

  it('should tick the rest, not clear, when only some are ticked', async () => {
    const { answer, ui } = ask(FEATURES);

    await type(ui.stdin, DOWN, SPACE, UP, SPACE, ENTER);

    expect(await answer).toEqual(['Express', 'Fastify']);
  });

  it('should show a half-ticked group as partial', async () => {
    const { answer, ui } = ask(FEATURES);

    await type(ui.stdin, DOWN, SPACE);

    expect(rows(ui).slice(1, 4)).toEqual(['  ◐ Backend', '❯   ◉ Express', '    ◯ Fastify']);

    await type(ui.stdin, CTRL_C);
    await answer.catch(() => undefined);
  });

  it('should show a group as ticked once its last choice is ticked by hand', async () => {
    const { answer, ui } = ask(FEATURES);

    await type(ui.stdin, DOWN, SPACE, DOWN, SPACE);

    expect(rows(ui)[1]).toBe('  ◉ Backend');

    await type(ui.stdin, CTRL_C);
    await answer.catch(() => undefined);
  });

  it('should start ticked when every choice under it is selected', async () => {
    const { answer, ui } = ask({
      G: [
        { label: 'a', selected: true },
        { label: 'b', selected: true },
      ],
    });

    await tick();

    expect(rows(ui)[1]).toContain('◉ G');

    await type(ui.stdin, ENTER);
    expect(await answer).toEqual(['a', 'b']);
  });

  it('should return values in the order they are listed, not the order they were ticked', async () => {
    const { answer, ui } = ask(FEATURES);

    // Frontend's React first, then Backend's group
    await type(ui.stdin, DOWN, DOWN, DOWN, DOWN, SPACE, HOME, SPACE, ENTER);

    expect(await answer).toEqual(['Express', 'Fastify', 'React']);
  });
});

describe('a disabled choice in groupMultiselect()', () => {
  const choices = {
    G: ['a', { disabled: 'not yet', label: 'b', selected: true }, 'c'],
  };

  it('should be left alone by its group, and never ticked by selected', async () => {
    const { answer, ui } = ask(choices);

    await type(ui.stdin, SPACE, ENTER);

    expect(await answer).toEqual(['a', 'c']);
  });

  it('should not stop the group reading as ticked once the rest are', async () => {
    const { answer, ui } = ask(choices);

    await type(ui.stdin, SPACE);

    expect(rows(ui)[1]).toContain('◉ G');
    expect(rows(ui)[3]).toContain('not yet');

    await type(ui.stdin, CTRL_C);
    await answer.catch(() => undefined);
  });

  it('should be passed over by the cursor', async () => {
    const { answer, ui } = ask(choices);

    await type(ui.stdin, DOWN, DOWN, SPACE, ENTER);

    expect(await answer).toEqual(['c']);
  });

  it('should leave a group with nothing on offer out of the cursor path', async () => {
    const { answer, ui } = ask({ Dead: [{ disabled: true, label: 'x' }], Live: ['y'] });

    await type(ui.stdin, SPACE, ENTER);

    expect(await answer).toEqual(['y']);
  });

  it('should reject when nothing is on offer', async () => {
    const { answer } = ask({ Dead: [{ disabled: true, label: 'x' }] });

    await expect(answer).rejects.toThrow('has no choices to offer');
  });
});

describe('selectableGroups: false in groupMultiselect()', () => {
  it('should step over a heading and start on the first choice', async () => {
    const { answer, ui } = ask(FEATURES, { selectableGroups: false });

    await tick();

    expect(rows(ui).slice(1, 3)).toEqual(['Backend', '❯   ◯ Express']);

    await type(ui.stdin, SPACE, ENTER);
    expect(await answer).toEqual(['Express']);
  });

  it('should never let Space tick a whole group', async () => {
    const { answer, ui } = ask(FEATURES, { selectableGroups: false });

    await type(ui.stdin, UP, SPACE, ENTER);

    // up from Express wraps to Svelte, the last choice on offer
    expect(await answer).toEqual(['Svelte']);
  });

  it('should walk to the ends by Home and End', async () => {
    const { answer, ui } = ask(FEATURES, { selectableGroups: false });

    await type(ui.stdin, END, SPACE, HOME, SPACE, ENTER);

    expect(await answer).toEqual(['Express', 'Svelte']);
  });
});

describe('select-all and invert in groupMultiselect()', () => {
  it('should tick every choice on `a` and clear them on a second `a`', async () => {
    const { answer, ui } = ask(FEATURES);

    await type(ui.stdin, 'a');
    expect(rows(ui)[1]).toContain('◉ Backend');
    await type(ui.stdin, 'a', 'a', ENTER);

    expect((await answer).length).toBe(5);
  });

  it('should flip each choice on `i`', async () => {
    const { answer, ui } = ask({ G: [{ label: 'a', selected: true }, 'b'] });

    await type(ui.stdin, 'i', ENTER);

    expect(await answer).toEqual(['b']);
  });
});

describe('min, max and required in groupMultiselect()', () => {
  it('should refuse an empty selection when required', async () => {
    const { answer, ui } = ask(FEATURES, { required: true });

    await type(ui.stdin, ENTER);

    expect(rows(ui).join('\n')).toContain('Choose at least one');

    await type(ui.stdin, SPACE, ENTER);
    expect(await answer).toEqual(['Express', 'Fastify']);
  });

  it('should count choices and not groups against max', async () => {
    // Backend's group is two choices, which is allowed
    const { answer, ui } = ask(FEATURES, { max: 2 });

    await type(ui.stdin, SPACE, ENTER);

    expect(await answer).toHaveLength(2);
  });

  it('should refuse more than max on Enter, naming the limit', async () => {
    // Frontend's group is three choices, which is not
    const { answer, ui } = ask(FEATURES, { max: 2 });

    await type(ui.stdin, DOWN, DOWN, DOWN, SPACE, ENTER);

    expect(rows(ui).join('\n')).toContain('Choose at most 2');

    await type(ui.stdin, SPACE, ENTER);
    expect(await answer).toEqual([]);
  });

  it('should reject a min greater than max', async () => {
    const { answer } = ask(FEATURES, { max: 1, min: 2 });

    await expect(answer).rejects.toThrow('min greater than its max');
  });
});

describe('groupMultiselect() input', () => {
  it('should reject a separator inside a group', async () => {
    const { answer } = ask({ G: ['a', separator('x') as never] });

    await expect(answer).rejects.toBeInstanceOf(PromptError);
  });

  it('should reject a group that is not a list', async () => {
    const { answer } = ask({ G: 'a' as never });

    await expect(answer).rejects.toThrow('not a list');
  });

  it('should reject no groups at all', async () => {
    const { answer } = ask({});

    await expect(answer).rejects.toThrow('has no choices to offer');
  });

  it('should return a value that is not the label', async () => {
    const { answer, ui } = ask({
      G: [
        { label: 'One', value: 1 },
        { label: 'Two', value: 2 },
      ],
    });

    await type(ui.stdin, SPACE, ENTER);

    expect(await answer).toEqual([1, 2]);
  });

  it('should wrap the cursor unless loop is false', async () => {
    const wrapped = ask(FEATURES);
    await type(wrapped.ui.stdin, UP, SPACE, ENTER);
    expect(await wrapped.answer).toEqual(['Svelte']);

    const stopped = ask(FEATURES, { loop: false });
    await type(stopped.ui.stdin, UP, SPACE, ENTER);
    expect(await stopped.answer).toEqual(['Express', 'Fastify']);
  });

  it('should settle on the labels that were ticked', async () => {
    const { answer, ui } = ask({ G: [{ label: 'Alpha', short: 'A' }, 'Beta'] });

    await type(ui.stdin, SPACE, ENTER);
    await answer;

    expect(rows(ui)).toEqual(['? Pick A, Beta']);
  });

  it('should show a description only while its choice is highlighted', async () => {
    const { answer, ui } = ask({ G: [{ description: 'About a', label: 'a' }, 'b'] });

    await type(ui.stdin, DOWN);
    expect(rows(ui).join('\n')).toContain('About a');
    await type(ui.stdin, DOWN);
    expect(rows(ui).join('\n')).not.toContain('About a');

    await type(ui.stdin, CTRL_C);
    await answer.catch(() => undefined);
  });

  it('should keep the highlighted row on screen in a list taller than the terminal', async () => {
    const choices = { Big: Array.from({ length: 20 }, (_, i) => `item-${i}`) };
    const { answer, ui } = ask(choices, {}, 8);

    await type(ui.stdin, END);

    expect(rows(ui).join('\n')).toContain('❯   ◯ item-19');
    expect(ui.log.length).toBeLessThanOrEqual(8);

    await type(ui.stdin, CTRL_C);
    await answer.catch(() => undefined);
  });
});
