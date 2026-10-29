import { calendar, calendarView, pickDate } from '../../src/components/calendar.js';
import { date } from '../../src/components/date.js';
import { PromptError } from '../../src/components/prompt.js';
import { type ScreenHarness, screenSetup, tick } from './helpers.js';
import { describe, expect, it } from 'vitest';

const ENTER = '\r';
const UP = '\u001b[A';
const DOWN = '\u001b[B';
const LEFT = '\u001b[D';
const RIGHT = '\u001b[C';
const PAGE_UP = '\u001b[5~';
const PAGE_DOWN = '\u001b[6~';
const HOME = '\u001b[H';
const END = '\u001b[F';

/** A month as the lines it prints, in a locale and week that do not depend on the machine. */
function lines(opts: Parameters<typeof calendar>[0] = {}): string[] {
  return calendar({
    colorLevel: 0,
    date: new Date(2026, 9, 29),
    locale: 'en-US',
    weekStart: 0,
    ...opts,
  }).split('\n');
}

async function type(stdin: { send(chunk: string): void }, ...chunks: string[]) {
  for (const chunk of chunks) {
    stdin.send(chunk);
    await tick();
  }
}

function ask(opts: Partial<Parameters<typeof pickDate>[0]> = {}, size = {}) {
  const ui = screenSetup({ rows: 12, ...size });
  const answer = pickDate({
    colorLevel: 0,
    initial: new Date(2026, 9, 15),
    locale: 'en-US',
    message: 'When?',
    terminal: ui.terminal,
    weekStart: 0,
    ...opts,
  });
  return { answer, ui };
}

/** The screen below the question, one line per week. */
function grid(ui: ScreenHarness): string[] {
  return ui.log.slice(1).map((row) => row.trimEnd());
}

describe('calendar()', () => {
  describe('the month', () => {
    it('should print the title, the weekdays and a row per week', () => {
      expect(lines().map((row) => row.trimEnd())).to.deep.equal([
        '        October 2026',
        ' Su  Mo  Tu  We  Th  Fr  Sa',
        '                  1   2   3',
        '  4   5   6   7   8   9  10',
        ' 11  12  13  14  15  16  17',
        ' 18  19  20  21  22  23  24',
        ' 25  26  27  28  29  30  31',
      ]);
    });

    it('should show only the rows the month uses', () => {
      // February 2026 starts on a Sunday and has 28 days: four weeks, no more
      expect(lines({ date: new Date(2026, 1, 10) })).to.have.length(6);
      // October 2026 spills into a fifth week
      expect(lines()).to.have.length(7);
    });

    it('should know a leap year from one that is not', () => {
      const days = (year: number) =>
        lines({ date: new Date(year, 1, 1) })
          .slice(2)
          .join(' ')
          .split(/\s+/)
          .filter(Boolean);

      expect(days(2024).at(-1)).to.equal('29');
      expect(days(2023).at(-1)).to.equal('28');
    });

    it('should take the month from any day in it', () => {
      expect(lines({ date: new Date(2026, 9, 1) })).to.deep.equal(
        lines({ date: new Date(2026, 9, 31) })
      );
    });

    it('should read a year under 100 as that year and not as 19xx', () => {
      const d = new Date(2000, 0, 1);
      d.setFullYear(50, 2, 1);

      expect(lines({ date: d })[0].trim()).toMatch(/March/);
      expect(lines({ date: d })[0]).toMatch(/\b50\b/);
    });

    it('should indent the whole block', () => {
      const plain = lines();
      const indented = lines({ indent: 3 });

      expect(indented.map((row) => row.slice(3))).to.deep.equal(plain);
    });

    it('should be as wide as the grid and no wider', () => {
      const rows = lines();

      expect(Math.max(...rows.map((row) => row.length))).toBeLessThanOrEqual(28);
      expect(calendarView({ date: new Date(2026, 9, 1) }).width).to.equal(28);
    });
  });

  describe('the week', () => {
    it('should start on Sunday when told 0 and on Monday when told 1', () => {
      expect(lines({ weekStart: 0 })[1].trim()).to.match(/^Su +Mo/);
      expect(lines({ weekStart: 1 })[1].trim()).to.match(/^Mo +Tu.*Su$/);
    });

    it('should move the first day to the column its weekday falls in', () => {
      // 1 October 2026 is a Thursday: the fifth column from Sunday, the fourth from Monday
      expect(lines({ weekStart: 0 })[2].indexOf('1')).to.equal(18);
      expect(lines({ weekStart: 1 })[2].indexOf('1')).to.equal(14);
    });

    it('should take it from the locale when it is not given', () => {
      // the US week starts on Sunday and Germany's on Monday
      expect(lines({ locale: 'en-US', weekStart: undefined })[1].trim()).to.match(/^Su/);
      expect(lines({ locale: 'de', weekStart: undefined })[1].trim()).to.match(/^Mo/);
    });

    it('should refuse a weekStart that is not a weekday', () => {
      expect(() => lines({ weekStart: 7 })).toThrow(/weekStart/);
      expect(() => lines({ weekStart: 1.5 })).toThrow(/weekStart/);
    });
  });

  describe('the language', () => {
    it('should write the month and the weekdays in the locale', () => {
      const rows = lines({ locale: 'de', weekStart: 1, date: new Date(2026, 2, 1) });

      expect(rows[0].trim()).to.equal('März 2026');
      expect(rows[1].trim()).to.match(/^Mo +Di +Mi +Do +Fr +Sa +So$/);
    });

    it('should draw Gregorian numbers whatever calendar the locale prefers', () => {
      // th-TH writes 2569 by default, over days that are Gregorian ones
      expect(lines({ locale: 'th-TH' })[0]).to.match(/2026/);
    });

    it('should fit a name that is longer than the column it sits over', () => {
      const names = lines({ locale: 'fr', weekStart: 1 })[1];

      expect(names.length).toBeLessThanOrEqual(28);
      expect(names.trim().split(/\s+/)).to.have.length(7);
    });

    it('should refuse a locale that is not a language tag', () => {
      expect(() => lines({ locale: 'not a locale' })).toThrow(/locale/);
    });
  });

  describe('selected and highlighted days', () => {
    it('should set the selected day in brackets, which needs no colour', () => {
      const text = lines({ selected: new Date(2026, 9, 29) }).join('\n');

      expect(text).to.contain('[29]');
      expect(text.match(/\[/g)).to.have.length(1);
    });

    it('should mark a highlighted day with a star after it', () => {
      const text = lines({ highlight: [new Date(2026, 9, 3), new Date(2026, 9, 20)] }).join('\n');

      expect(text).to.contain(' 3*');
      expect(text).to.contain('20*');
      expect(text.match(/\*/g)).to.have.length(2);
    });

    it('should show the selection on a day that is also highlighted', () => {
      const text = lines({
        highlight: [new Date(2026, 9, 29)],
        selected: new Date(2026, 9, 29),
      }).join('\n');

      expect(text).to.contain('[29]');
      expect(text).not.to.contain('*');
    });

    it('should ignore a selected or highlighted day in another month', () => {
      const text = lines({
        highlight: [new Date(2026, 10, 3)],
        selected: new Date(2025, 9, 29),
      }).join('\n');

      expect(text).not.to.match(/[[*]/);
    });

    it('should mark days by the day alone, whatever the time of day', () => {
      const text = lines({ highlight: [new Date(2026, 9, 3, 23, 59, 59)] }).join('\n');

      expect(text).to.contain(' 3*');
    });

    it('should paint the selection in reverse and the highlight in the accent when there is colour', () => {
      const out = calendar({
        colorLevel: 1,
        date: new Date(2026, 9, 29),
        highlight: [new Date(2026, 9, 3)],
        locale: 'en-US',
        selected: new Date(2026, 9, 29),
        weekStart: 0,
      });
      const esc = String.fromCharCode(0x1b);

      expect(out).to.contain(`${esc}[7m`);
      expect(out).to.match(new RegExp(`${esc}\\[36m *3\\*`));
    });

    it('should refuse a date that is not a Date', () => {
      expect(() => lines({ selected: new Date(Number.NaN) })).toThrow(/selected/);
      expect(() => lines({ date: new Date(Number.NaN) })).toThrow(/date/);
      expect(() => lines({ highlight: [new Date(Number.NaN)] })).toThrow(/highlight/);
    });
  });
});

describe('pickDate()', () => {
  it('should show the month with the cursor on the initial day, and answer with it', async () => {
    const { answer, ui } = ask();

    expect(ui.log[0]).to.equal('? When? 2026-10-15');
    expect(grid(ui)).toContain('   11  12  13  14 [15] 16  17');
    expect(grid(ui)[0].trim()).to.equal('October 2026');

    await type(ui.stdin, ENTER);
    expect(await answer).toEqual(new Date(2026, 9, 15));
  });

  describe('moving', () => {
    it('should move a day with left and right and a week with up and down', async () => {
      const { answer, ui } = ask();

      await type(ui.stdin, RIGHT);
      expect(ui.log[0]).to.equal('? When? 2026-10-16');
      await type(ui.stdin, LEFT, LEFT);
      expect(ui.log[0]).to.equal('? When? 2026-10-14');
      await type(ui.stdin, DOWN);
      expect(ui.log[0]).to.equal('? When? 2026-10-21');
      await type(ui.stdin, UP, UP);
      expect(ui.log[0]).to.equal('? When? 2026-10-07');

      await type(ui.stdin, ENTER);
      expect(await answer).toEqual(new Date(2026, 9, 7));
    });

    it('should carry into the next month and redraw it', async () => {
      const { answer, ui } = ask({ initial: new Date(2026, 9, 31) });

      await type(ui.stdin, RIGHT);
      expect(ui.log[0]).to.equal('? When? 2026-11-01');
      expect(grid(ui)[0].trim()).to.equal('November 2026');
      await type(ui.stdin, LEFT);
      expect(ui.log[0]).to.equal('? When? 2026-10-31');

      await type(ui.stdin, ENTER);
      await answer;
    });

    it('should carry across a year', async () => {
      const { answer, ui } = ask({ initial: new Date(2026, 11, 31) });

      await type(ui.stdin, RIGHT);
      expect(ui.log[0]).to.equal('? When? 2027-01-01');

      await type(ui.stdin, ENTER);
      expect(await answer).toEqual(new Date(2027, 0, 1));
    });

    it('should change the month with the page keys, keeping the day where it can', async () => {
      const { answer, ui } = ask({ initial: new Date(2026, 0, 31) });

      await type(ui.stdin, PAGE_DOWN);
      // the 31st does not exist in February: it is pulled back, not carried into March
      expect(ui.log[0]).to.equal('? When? 2026-02-28');
      await type(ui.stdin, PAGE_DOWN);
      expect(ui.log[0]).to.equal('? When? 2026-03-28');
      await type(ui.stdin, PAGE_UP, PAGE_UP, PAGE_UP);
      expect(ui.log[0]).to.equal('? When? 2025-12-28');

      await type(ui.stdin, ENTER);
      expect(await answer).toEqual(new Date(2025, 11, 28));
    });

    it('should go to the first and last day of the month with home and end', async () => {
      const { answer, ui } = ask({ initial: new Date(2024, 1, 10) });

      await type(ui.stdin, END);
      expect(ui.log[0]).to.equal('? When? 2024-02-29');
      await type(ui.stdin, HOME);
      expect(ui.log[0]).to.equal('? When? 2024-02-01');

      await type(ui.stdin, ENTER);
      await answer;
    });

    it('should leave the lines under the grid where they are as the month changes', async () => {
      const { answer, ui } = ask({ initial: new Date(2026, 1, 10) });
      const short = ui.log.length;

      await type(ui.stdin, PAGE_DOWN, PAGE_DOWN, PAGE_DOWN, PAGE_DOWN, PAGE_DOWN, PAGE_DOWN);
      // August 2026 takes six rows; February takes four
      expect(ui.log[0]).to.equal('? When? 2026-08-10');
      expect(ui.log.length).toBeGreaterThanOrEqual(short);

      await type(ui.stdin, ENTER);
      await answer;
    });
  });

  describe('min and max', () => {
    it('should stop at the bounds, which are inclusive', async () => {
      const { answer, ui } = ask({
        max: new Date(2026, 9, 20, 15),
        min: new Date(2026, 9, 10),
      });

      await type(ui.stdin, UP, UP);
      expect(ui.log[0]).to.equal('? When? 2026-10-10');
      await type(ui.stdin, LEFT);
      expect(ui.log[0]).to.equal('? When? 2026-10-10');
      await type(ui.stdin, DOWN, DOWN, DOWN);
      expect(ui.log[0]).to.equal('? When? 2026-10-20');
      await type(ui.stdin, PAGE_DOWN);
      expect(ui.log[0]).to.equal('? When? 2026-10-20');

      await type(ui.stdin, ENTER);
      expect(await answer).toEqual(new Date(2026, 9, 20));
    });

    it('should move an initial day outside the range to the nearest bound', async () => {
      const { answer, ui } = ask({
        initial: new Date(2026, 11, 25),
        max: new Date(2026, 9, 20),
      });

      expect(ui.log[0]).to.equal('? When? 2026-10-20');

      await type(ui.stdin, ENTER);
      expect(await answer).toEqual(new Date(2026, 9, 20));
    });

    it('should refuse a min after the max', async () => {
      await expect(
        pickDate({ max: new Date(2026, 0, 1), message: 'x', min: new Date(2026, 5, 1) })
      ).rejects.toThrow(/min/);
    });

    it('should refuse a date that is not a Date', async () => {
      await expect(pickDate({ initial: new Date(Number.NaN), message: 'x' })).rejects.toThrow(
        /initial/
      );
    });
  });

  describe('highlight', () => {
    it('should mark the days it was given in the grid', async () => {
      const { answer, ui } = ask({ highlight: [new Date(2026, 9, 3)] });

      expect(grid(ui).join('\n')).to.contain(' 3*');

      await type(ui.stdin, ENTER);
      await answer;
    });
  });

  describe('as a prompt', () => {
    it('should reject, naming the question, where there is no terminal', async () => {
      const ui = screenSetup({ isTTY: false });

      await expect(pickDate({ message: 'When?', terminal: ui.terminal })).rejects.toThrow(
        /Cannot prompt for "When\?"/
      );
    });

    it('should reject when cancelled', async () => {
      const { answer, ui } = ask();
      const settled = answer.then(
        () => undefined,
        (error: Error) => error
      );

      await type(ui.stdin, '\u0003');
      const error = await settled;
      expect(error).toBeInstanceOf(PromptError);
      expect((error as PromptError).aborted).toBe(true);
    });

    it('should settle into the question and its answer, with the grid gone', async () => {
      const { answer, ui } = ask();

      await type(ui.stdin, ENTER);
      await answer;

      expect(ui.log).to.deep.equal(['? When? 2026-10-15']);
    });
  });
});

describe('date() with a calendar', () => {
  function askDate(opts: Partial<Parameters<typeof date>[0]> = {}) {
    const ui = screenSetup({ rows: 12 });
    const answer = date({
      calendar: { locale: 'en-US', weekStart: 0 },
      colorLevel: 0,
      initial: new Date(2026, 9, 15),
      message: 'When?',
      terminal: ui.terminal,
      ...opts,
    });
    return { answer, ui };
  }

  it('should show the month the field holds, with its day selected', async () => {
    const { answer, ui } = askDate();

    expect(ui.log[0]).to.equal('? When? 2026-10-15');
    expect(grid(ui)[0].trim()).to.equal('October 2026');
    expect(grid(ui).join('\n')).to.contain('[15]');

    await type(ui.stdin, ENTER);
    await answer;
  });

  it('should show nothing more than the field without it', async () => {
    const ui = screenSetup({ rows: 12 });
    const answer = date({
      colorLevel: 0,
      initial: new Date(2026, 9, 15),
      message: 'When?',
      terminal: ui.terminal,
    });

    expect(ui.log).to.deep.equal(['? When? 2026-10-15']);
    await type(ui.stdin, PAGE_DOWN, ENTER);
    expect(await answer).toEqual(new Date(2026, 9, 15));
  });

  it('should follow the field as a segment is stepped', async () => {
    const { answer, ui } = askDate();

    await type(ui.stdin, RIGHT, UP);
    expect(ui.log[0]).to.equal('? When? 2026-11-15');
    expect(grid(ui)[0].trim()).to.equal('November 2026');

    await type(ui.stdin, ENTER);
    expect(await answer).toEqual(new Date(2026, 10, 15));
  });

  it('should change the month with the page keys', async () => {
    const { answer, ui } = askDate({ initial: new Date(2026, 0, 31) });

    await type(ui.stdin, PAGE_DOWN);
    expect(ui.log[0]).to.equal('? When? 2026-02-28');
    await type(ui.stdin, PAGE_UP, PAGE_UP);
    expect(ui.log[0]).to.equal('? When? 2025-12-28');

    await type(ui.stdin, ENTER);
    expect(await answer).toEqual(new Date(2025, 11, 28));
  });

  it('should keep the page keys inside min and max', async () => {
    const { answer, ui } = askDate({ max: new Date(2026, 11, 20) });

    await type(ui.stdin, PAGE_DOWN, PAGE_DOWN, PAGE_DOWN);
    expect(ui.log[0]).to.equal('? When? 2026-12-20');

    await type(ui.stdin, ENTER);
    expect(await answer).toEqual(new Date(2026, 11, 20));
  });

  it('should take the digits typed into a segment before it changes the month', async () => {
    const { answer, ui } = askDate();

    await type(ui.stdin, RIGHT, '0', '3', PAGE_DOWN);
    expect(ui.log[0]).to.equal('? When? 2026-04-15');

    await type(ui.stdin, ENTER);
    await answer;
  });

  it('should settle into the field alone, with the grid gone', async () => {
    const { answer, ui } = askDate();

    await type(ui.stdin, ENTER);
    await answer;

    expect(ui.log).to.deep.equal(['? When? 2026-10-15']);
  });

  it('should reject a calendar option it cannot draw', async () => {
    const { answer } = askDate({ calendar: { weekStart: 9 } });

    await expect(answer).rejects.toThrow(/weekStart/);
  });
});
