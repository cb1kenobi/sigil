import { date } from '../../src/components/date.js';
import { PromptError } from '../../src/components/prompt.js';
import { transformValue } from '../../src/util/transform.js';
import { type ScreenHarness, screenSetup, tick } from './helpers.js';
import { afterEach, describe, expect, it, vi } from 'vitest';

const ENTER = '\r';
const UP = '\u001b[A';
const DOWN = '\u001b[B';
const LEFT = '\u001b[D';
const RIGHT = '\u001b[C';
const TAB = '\t';
const SHIFT_TAB = '\u001b[Z';
const BACKSPACE = '\u007f';

/** Sends keys one at a time, letting the prompt act on each. */
async function type(stdin: { send(chunk: string): void }, ...chunks: string[]) {
  for (const chunk of chunks) {
    stdin.send(chunk);
    await tick();
  }
}

/**
 * The segment under the caret: the run of digits and fill characters the screen
 * model last wrote in reverse video. Read off the model rather than the bytes
 * because a frame is a diff, so the last reverse-video write can be one digit
 * of a segment that changed.
 */
function caret(ui: ScreenHarness): string {
  const at = ui.screen.lastInverse;
  if (!at) {
    return '';
  }
  const line = ui.log[at.row] ?? '';
  let from = at.column;
  let to = at.column;
  while (from > 0 && /[\d_]/.test(line[from - 1] ?? '')) {
    from--;
  }
  while (/[\d_]/.test(line[to + 1] ?? '')) {
    to++;
  }
  return line.slice(from, to + 1);
}

function settle<T>(promise: Promise<T>): Promise<{ error?: Error; value?: T }> {
  return promise.then(
    (value) => ({ value }),
    (error: Error) => ({ error })
  );
}

function ask(opts: Partial<Parameters<typeof date>[0]> = {}, size = {}) {
  const ui = screenSetup(size);
  const answer = date({ colorLevel: 1, message: 'When?', terminal: ui.terminal, ...opts });
  return { answer, ui };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('date()', () => {
  it('should return the initial date untouched on Enter, as a local midnight', async () => {
    const { answer, ui } = ask({ initial: new Date(2024, 5, 15, 13, 45) });

    expect(ui.frame).to.equal('? When? 2024-06-15');
    await type(ui.stdin, ENTER);

    expect(await answer).toEqual(new Date(2024, 5, 15));
  });

  it('should build the answer with the parser, so the two agree on the value', async () => {
    const { answer, ui } = ask({ initial: new Date(2024, 1, 29) });

    await type(ui.stdin, ENTER);

    expect(await answer).toEqual(transformValue('2024-02-29', 'date') as Date);
  });

  it('should start at today, truncated to the date', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(2031, 2, 9, 17, 5, 59));
    const { answer, ui } = ask();

    expect(ui.frame).to.equal('? When? 2031-03-09');
    await type(ui.stdin, ENTER);
    expect(await answer).toEqual(new Date(2031, 2, 9));
  });

  describe('precision', () => {
    it('should show the hour and minute with time', async () => {
      const { answer, ui } = ask({ initial: new Date(2024, 5, 15, 13, 45, 30), time: true });

      expect(ui.frame).to.equal('? When? 2024-06-15 13:45');
      await type(ui.stdin, ENTER);

      // seconds are not shown, so they are not kept
      expect(await answer).toEqual(new Date(2024, 5, 15, 13, 45, 0));
    });

    it('should show the seconds too, which implies time', async () => {
      const { answer, ui } = ask({ initial: new Date(2024, 5, 15, 13, 45, 30), seconds: true });

      expect(ui.frame).to.equal('? When? 2024-06-15 13:45:30');
      await type(ui.stdin, ENTER);

      expect(await answer).toEqual(new Date(2024, 5, 15, 13, 45, 30));
    });

    it('should default to now truncated to the minute with time', async () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date(2031, 2, 9, 17, 5, 59));
      const { answer, ui } = ask({ time: true });

      expect(ui.frame).to.equal('? When? 2031-03-09 17:05');
      await type(ui.stdin, ENTER);
      expect(await answer).toEqual(new Date(2031, 2, 9, 17, 5));
    });
  });

  describe('navigation', () => {
    it('should mark the focused segment and move it with left and right', async () => {
      const { answer, ui } = ask({ initial: new Date(2024, 5, 15) });

      expect(caret(ui)).to.equal('2024');
      await type(ui.stdin, RIGHT);
      expect(caret(ui)).to.equal('06');
      await type(ui.stdin, RIGHT);
      expect(caret(ui)).to.equal('15');
      await type(ui.stdin, LEFT);
      expect(caret(ui)).to.equal('06');

      await type(ui.stdin, ENTER);
      await answer;
    });

    it('should move with tab and shift-tab, and stop at the ends', async () => {
      const { answer, ui } = ask({ initial: new Date(2024, 5, 15) });

      await type(ui.stdin, TAB, TAB, TAB, TAB);
      expect(caret(ui)).to.equal('15');
      await type(ui.stdin, SHIFT_TAB, SHIFT_TAB, SHIFT_TAB, SHIFT_TAB);
      expect(caret(ui)).to.equal('2024');

      await type(ui.stdin, LEFT);
      expect(caret(ui)).to.equal('2024');

      await type(ui.stdin, ENTER);
      await answer;
    });
  });

  describe('stepping', () => {
    it('should step the focused segment with up and down', async () => {
      const { answer, ui } = ask({ initial: new Date(2024, 5, 15) });

      await type(ui.stdin, UP);
      expect(ui.frame).to.equal('? When? 2025-06-15');
      await type(ui.stdin, RIGHT, DOWN, DOWN);
      expect(ui.frame).to.equal('? When? 2025-04-15');
      await type(ui.stdin, RIGHT, UP);

      await type(ui.stdin, ENTER);
      expect(await answer).toEqual(new Date(2025, 3, 16));
    });

    it('should wrap inside a segment without carrying into its neighbour', async () => {
      const { answer, ui } = ask({ initial: new Date(2024, 11, 31) });

      await type(ui.stdin, RIGHT, UP);
      // December up is January, and the year stays where it was
      expect(ui.frame).to.equal('? When? 2024-01-31');
      await type(ui.stdin, DOWN);
      expect(ui.frame).to.equal('? When? 2024-12-31');
      await type(ui.stdin, RIGHT, UP);
      expect(ui.frame).to.equal('? When? 2024-12-01');
      await type(ui.stdin, DOWN);
      expect(ui.frame).to.equal('? When? 2024-12-31');

      await type(ui.stdin, ENTER);
      await answer;
    });

    it('should wrap the clock without carrying', async () => {
      const { answer, ui } = ask({ initial: new Date(2024, 5, 15, 23, 59, 59), seconds: true });

      await type(ui.stdin, RIGHT, RIGHT, RIGHT, UP, RIGHT, UP, RIGHT, UP);
      expect(ui.frame).to.equal('? When? 2024-06-15 00:00:00');

      await type(ui.stdin, ENTER);
      expect(await answer).toEqual(new Date(2024, 5, 15, 0, 0, 0));
    });

    it('should pull the day back to the last day of a shorter month', async () => {
      const { answer, ui } = ask({ initial: new Date(2023, 0, 31) });

      await type(ui.stdin, RIGHT, UP);
      expect(ui.frame).to.equal('? When? 2023-02-28');
      await type(ui.stdin, UP);
      // the day was clamped, so March starts from it rather than from 31
      expect(ui.frame).to.equal('? When? 2023-03-28');

      await type(ui.stdin, ENTER);
      await answer;
    });

    it('should know a leap year from one that is not', async () => {
      const { answer, ui } = ask({ initial: new Date(2024, 1, 29) });

      await type(ui.stdin, UP);
      expect(ui.frame).to.equal('? When? 2025-02-28');
      await type(ui.stdin, DOWN, DOWN, DOWN, DOWN);
      expect(ui.frame).to.equal('? When? 2021-02-28');
      await type(ui.stdin, UP, UP, UP);
      // 2024 again, and the day it lost is not given back
      expect(ui.frame).to.equal('? When? 2024-02-28');

      await type(ui.stdin, RIGHT, RIGHT, UP);
      expect(ui.frame).to.equal('? When? 2024-02-29');
      await type(ui.stdin, UP);
      expect(ui.frame).to.equal('? When? 2024-02-01');

      await type(ui.stdin, ENTER);
      await answer;
    });

    it('should wrap the day at the length of its own month', async () => {
      const { answer, ui } = ask({ initial: new Date(2023, 1, 28) });

      await type(ui.stdin, RIGHT, RIGHT, UP);
      expect(ui.frame).to.equal('? When? 2023-02-01');
      await type(ui.stdin, DOWN);
      expect(ui.frame).to.equal('? When? 2023-02-28');

      await type(ui.stdin, ENTER);
      await answer;
    });
  });

  describe('typing', () => {
    it('should fill a segment with digits and move on when it is full', async () => {
      const { answer, ui } = ask({ initial: new Date(2024, 5, 15) });

      await type(ui.stdin, '1', '9');
      // two of four digits: still the year, shown as it is typed
      expect(ui.frame).to.equal('? When? 19__-06-15');
      expect(caret(ui)).to.equal('19__');
      await type(ui.stdin, '9', '9');
      expect(ui.frame).to.equal('? When? 1999-06-15');
      expect(caret(ui)).to.equal('06');
      await type(ui.stdin, '1', '2');
      expect(caret(ui)).to.equal('15');
      await type(ui.stdin, '0', '3');

      await type(ui.stdin, ENTER);
      expect(await answer).toEqual(new Date(1999, 11, 3));
    });

    it('should take a single digit as the value when the segment is left', async () => {
      const { answer, ui } = ask({ initial: new Date(2024, 5, 15) });

      await type(ui.stdin, RIGHT, '3', RIGHT);
      expect(ui.frame).to.equal('? When? 2024-03-15');

      await type(ui.stdin, ENTER);
      expect(await answer).toEqual(new Date(2024, 2, 15));
    });

    it('should take pending digits on Enter', async () => {
      const { answer, ui } = ask({ initial: new Date(2024, 5, 15) });

      await type(ui.stdin, RIGHT, RIGHT, '2', ENTER);

      expect(await answer).toEqual(new Date(2024, 5, 2));
    });

    it('should read a chunk of several characters as the keys it carries', async () => {
      const { answer, ui } = ask({ initial: new Date(1999, 0, 1) });

      // dashes do nothing, and each full segment moves on by itself
      await type(ui.stdin, '2024-06-15', ENTER);

      expect(await answer).toEqual(new Date(2024, 5, 15));
    });

    it('should refuse anything but a digit', async () => {
      const { answer, ui } = ask({ initial: new Date(2024, 5, 15) });

      await type(ui.stdin, 'a', '-', ' ', '/');
      expect(ui.frame).to.equal('? When? 2024-06-15');
      expect(caret(ui)).to.equal('2024');

      await type(ui.stdin, ENTER);
      await answer;
    });

    it('should clear the pending digits with backspace and leave the value alone', async () => {
      const { answer, ui } = ask({ initial: new Date(2024, 5, 15) });

      await type(ui.stdin, '1', '9');
      expect(ui.frame).to.equal('? When? 19__-06-15');
      await type(ui.stdin, BACKSPACE);
      expect(ui.frame).to.equal('? When? 2024-06-15');

      await type(ui.stdin, ENTER);
      expect(await answer).toEqual(new Date(2024, 5, 15));
    });

    it('should clamp a typed day to the month it is in', async () => {
      const { answer, ui } = ask({ initial: new Date(2023, 1, 1) });

      await type(ui.stdin, RIGHT, RIGHT, '3', '1');
      expect(ui.frame).to.equal('? When? 2023-02-28');

      await type(ui.stdin, ENTER);
      expect(await answer).toEqual(new Date(2023, 1, 28));
    });

    it('should clamp a typed month, and keep the day inside it', async () => {
      const { answer, ui } = ask({ initial: new Date(2023, 0, 31) });

      await type(ui.stdin, RIGHT, '9', '9');
      expect(ui.frame).to.equal('? When? 2023-12-31');
      await type(ui.stdin, LEFT, '0', '0');
      expect(ui.frame).to.equal('? When? 2023-01-31');
      await type(ui.stdin, LEFT, '0', '2');
      expect(ui.frame).to.equal('? When? 2023-02-28');

      await type(ui.stdin, ENTER);
      await answer;
    });

    it('should clamp a typed hour and minute', async () => {
      const { answer, ui } = ask({ initial: new Date(2024, 5, 15, 8, 30), time: true });

      await type(ui.stdin, TAB, TAB, TAB, '2', '9', '9', '9');
      expect(ui.frame).to.equal('? When? 2024-06-15 23:59');

      await type(ui.stdin, ENTER);
      expect(await answer).toEqual(new Date(2024, 5, 15, 23, 59));
    });
  });

  describe('min and max', () => {
    it('should clamp a step that would leave the range to the nearest bound', async () => {
      const { answer, ui } = ask({
        initial: new Date(2024, 5, 15),
        max: new Date(2024, 11, 25),
        min: new Date(2024, 2, 10),
      });

      await type(ui.stdin, UP);
      // 2025-06-15 is past the max
      expect(ui.frame).to.equal('? When? 2024-12-25');
      await type(ui.stdin, DOWN);
      // the year steps back to 2023, which is before the min, so it lands on it
      expect(ui.frame).to.equal('? When? 2024-03-10');

      await type(ui.stdin, ENTER);
      expect(await answer).toEqual(new Date(2024, 2, 10));
    });

    it('should clamp typed digits to the range', async () => {
      const { answer, ui } = ask({
        initial: new Date(2024, 5, 15),
        max: new Date(2024, 11, 25),
        min: new Date(2024, 2, 10),
      });

      await type(ui.stdin, '1', '9', '9', '0');
      expect(ui.frame).to.equal('? When? 2024-03-10');

      await type(ui.stdin, ENTER);
      expect(await answer).toEqual(new Date(2024, 2, 10));
    });

    it('should treat the bounds as inclusive at the precision shown', async () => {
      const { answer, ui } = ask({
        initial: new Date(2024, 5, 15),
        // the afternoon of the 20th is the 20th, and the 20th is allowed
        max: new Date(2024, 5, 20, 15),
        min: new Date(2024, 5, 10, 15),
      });

      await type(ui.stdin, RIGHT, RIGHT, '2', '0');
      expect(ui.frame).to.equal('? When? 2024-06-20');
      await type(ui.stdin, '1', '0');
      expect(ui.frame).to.equal('? When? 2024-06-10');

      await type(ui.stdin, ENTER);
      expect(await answer).toEqual(new Date(2024, 5, 10));
    });

    it('should pull the default start into the range', async () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date(2031, 2, 9));
      const { answer, ui } = ask({ min: new Date(2040, 0, 1) });

      expect(ui.frame).to.equal('? When? 2040-01-01');
      await type(ui.stdin, ENTER);
      expect(await answer).toEqual(new Date(2040, 0, 1));
    });

    it('should report an initial value outside the range on Enter rather than moving it', async () => {
      const { answer, ui } = ask({
        initial: new Date(2020, 0, 1),
        min: new Date(2024, 0, 1),
      });
      const settled = settle(answer);

      await type(ui.stdin, ENTER);
      expect(ui.log.join('\n')).to.contain('Date must not be before 2024-01-01');
      expect(ui.log[0]).to.contain('2020-01-01');

      // the error clears with the next key, and a step lands on the bound it fell short of
      await type(ui.stdin, UP, ENTER);
      expect(await settled).toEqual({ value: new Date(2024, 0, 1) });
    });

    it('should report a value past the max', async () => {
      const { answer, ui } = ask({
        initial: new Date(2030, 0, 1),
        max: new Date(2024, 0, 1),
      });
      const settled = settle(answer);

      await type(ui.stdin, ENTER);
      expect(ui.log.join('\n')).to.contain('Date must not be after 2024-01-01');

      await type(ui.stdin, 'x');
      expect(ui.log.join('\n')).not.to.contain('Date must not be after');

      await type(ui.stdin, '\u0003');
      expect((await settled).error).toBeInstanceOf(PromptError);
    });

    it('should show the bound with the clock when the clock is shown', async () => {
      const { answer, ui } = ask(
        {
          initial: new Date(2024, 5, 15, 9, 0),
          min: new Date(2024, 5, 15, 10, 30),
          time: true,
        },
        { columns: 60 }
      );
      const settled = settle(answer);

      await type(ui.stdin, ENTER);
      expect(ui.log.join('\n')).to.contain('Date must not be before 2024-06-15 10:30');

      await type(ui.stdin, '\u0003');
      await settled;
    });

    it('should refuse a min that is after the max', async () => {
      const { answer } = ask({ max: new Date(2020, 0, 1), min: new Date(2024, 0, 1) });

      await expect(answer).rejects.toThrow('min');
    });

    it('should refuse an invalid Date', async () => {
      const { answer } = ask({ initial: new Date(NaN) });

      await expect(answer).rejects.toThrow('initial');
    });
  });

  describe('validate', () => {
    it('should reject with the message it returns and accept once it passes', async () => {
      const seen: Date[] = [];
      const { answer, ui } = ask({
        initial: new Date(2024, 5, 15),
        validate: (value) => {
          seen.push(value);
          return value.getDay() === 6 ? 'No weekends' : undefined;
        },
      });

      // 2024-06-15 is a Saturday
      await type(ui.stdin, ENTER);
      expect(ui.log.join('\n')).to.contain('No weekends');

      await type(ui.stdin, RIGHT, RIGHT, UP, ENTER);
      expect(await answer).toEqual(new Date(2024, 5, 16));
      expect(seen).toHaveLength(2);
      expect(seen[0]).toEqual(new Date(2024, 5, 15));
    });

    it('should wait for an async validator', async () => {
      const { answer, ui } = ask({
        initial: new Date(2024, 5, 14),
        validate: async () => {
          await new Promise((resolve) => setTimeout(resolve, 5));
          return undefined;
        },
      });

      await type(ui.stdin, ENTER);
      expect(await answer).toEqual(new Date(2024, 5, 14));
    });
  });

  describe('as a prompt', () => {
    it('should reject, naming the question, where there is no terminal', async () => {
      const ui = screenSetup({ isTTY: false });
      const answer = date({ message: 'When?', terminal: ui.terminal });

      await expect(answer).rejects.toThrow(/Cannot prompt for "When\?"/);
    });

    it('should reject when cancelled', async () => {
      const { answer, ui } = ask();
      const settled = settle(answer);

      await type(ui.stdin, '\u0003');
      const { error } = await settled;
      expect(error).toBeInstanceOf(PromptError);
      expect((error as PromptError).aborted).toBe(true);
    });

    it('should settle into the answer, with the caret gone', async () => {
      const { answer, ui } = ask({ initial: new Date(2024, 5, 15) });

      await type(ui.stdin, ENTER);
      await answer;

      expect(ui.frame).to.equal('? When? 2024-06-15');
    });
  });
});
