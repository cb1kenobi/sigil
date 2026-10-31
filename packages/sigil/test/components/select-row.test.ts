import { PromptError } from '../../src/components/prompt.js';
import { compareCells, selectRow, type SelectRowOptions } from '../../src/components/select-row.js';
import { table } from '../../src/components/table.js';
import { type ScreenHarness, screenSetup, tick } from './helpers.js';
import { describe, expect, it } from 'vitest';

const ENTER = '\r';
const CTRL_C = '\u0003';
const UP = '\u001b[A';
const DOWN = '\u001b[B';
const HOME = '\u001b[H';
const END = '\u001b[F';
const PAGEDOWN = '\u001b[6~';

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

interface Deployment {
  age: number;
  name: string;
  region: string;
}

const DEPLOYMENTS: Deployment[] = [
  { age: 12, name: 'web', region: 'eu-west' },
  { age: 3, name: 'api', region: 'us-east' },
  { age: 40, name: 'Worker', region: 'ap-south' },
  { age: 7, name: 'db', region: 'us-east' },
];

const COLUMNS = [
  { header: 'Name', key: 'name' },
  { header: 'Region', key: 'region' },
  { align: 'right' as const, header: 'Age', key: 'age' },
];

/** A prompt over a screen, with no theme and no colour. */
function open<R extends Deployment = Deployment>(
  ui: ScreenHarness,
  opts: Partial<SelectRowOptions<R>> = {}
) {
  return selectRow<R>({
    ansi: ui.ansi,
    columns: COLUMNS,
    frameMs: 0,
    message: 'Which deployment?',
    rows: DEPLOYMENTS as R[],
    terminal: ui.terminal,
    ...opts,
  });
}

/** The screen without its blank lines or trailing blanks. */
function screen(ui: ScreenHarness): string[] {
  return ui.log.map((line) => line.trimEnd()).filter(Boolean);
}

/** The body rows on screen, without the heading and the pointer. */
function body(ui: ScreenHarness): string[] {
  return screen(ui)
    .slice(2)
    .filter((line) => !/^\s+\d+\/\d+$/.test(line))
    .map((line) => line.replace(/^(❯| ) /, ''));
}

/** The first column of the row the pointer is on. */
function pointed(ui: ScreenHarness): string {
  const rows = ui.log.filter((line) => line.startsWith('❯'));
  expect(rows, 'exactly one row has the pointer').toHaveLength(1);
  return (rows[0] as string).replace(/^❯\s/, '').split(/\s\s+/)[0] as string;
}

describe('selectRow()', () => {
  it('should draw the heading and the rows in the columns table() would', async () => {
    const ui = screenSetup({ columns: 60, rows: 10 });
    const answer = settle(open(ui));

    await tick();

    expect(screen(ui)).toEqual([
      '? Which deployment? (enter to pick, 1-3 to sort)',
      '  Name    Region      Age',
      '❯ web     eu-west      12',
      '  api     us-east       3',
      '  Worker  ap-south     40',
      '  db      us-east       7',
    ]);

    await type(ui.stdin, CTRL_C);
    await answer;
  });

  it('should print what table() prints for the same declaration, where nothing sorts', async () => {
    const ui = screenSetup({ columns: 60, rows: 10 });
    const columns = COLUMNS.map((column) => ({ ...column, sortable: false }));
    const answer = settle(open(ui, { columns }));

    await tick();

    // one definition does both: the heading and the rows are table()'s own lines,
    // behind a two-column pointer. A sortable heading keeps room for its arrow,
    // which is the only way the two differ
    expect(
      screen(ui)
        .slice(1)
        .map((line) => line.slice(2))
    ).toEqual(
      table(
        DEPLOYMENTS.map((row) => ({ ...row })),
        { columns }
      )
        .split('\n')
        .map((line) => line.trimEnd())
    );

    await type(ui.stdin, CTRL_C);
    await answer;
  });

  it('should answer with the row that was passed in, not a copy', async () => {
    const ui = screenSetup({ columns: 60, rows: 10 });
    const answer = settle(open(ui));

    await type(ui.stdin, DOWN, ENTER);

    expect((await answer).value).toBe(DEPLOYMENTS[1]);
  });

  it('should answer with an array row as it was given', async () => {
    const ui = screenSetup({ columns: 60, rows: 10 });
    const rows = [
      ['a', 1],
      ['b', 2],
    ];
    const answer = settle(
      selectRow({ ansi: ui.ansi, frameMs: 0, message: 'Pick', rows, terminal: ui.terminal })
    );

    await type(ui.stdin, DOWN, ENTER);

    expect((await answer).value).toBe(rows[1]);
  });

  it('should infer the columns from the first row when none are declared', async () => {
    const ui = screenSetup({ columns: 60, rows: 10 });
    const answer = settle(
      selectRow({
        ansi: ui.ansi,
        frameMs: 0,
        message: 'Pick',
        rows: [{ id: 1, tag: 'x' }],
        terminal: ui.terminal,
      })
    );

    await tick();

    expect(screen(ui).slice(1)).toEqual(['  id    tag', '❯ 1     x']);

    await type(ui.stdin, CTRL_C);
    await answer;
  });

  it('should start on the row asked for, and wrap unless told not to', async () => {
    const ui = screenSetup({ columns: 60, rows: 10 });
    const answer = settle(open(ui, { initial: 3 }));

    await tick();
    expect(pointed(ui)).toBe('db');

    await type(ui.stdin, DOWN);
    expect(pointed(ui)).toBe('web');

    await type(ui.stdin, UP);
    expect(pointed(ui)).toBe('db');

    await type(ui.stdin, ENTER);
    expect((await answer).value).toBe(DEPLOYMENTS[3]);

    const flat = screenSetup({ columns: 60, rows: 10 });
    const stopped = settle(open(flat, { loop: false }));
    await type(flat.stdin, UP);
    expect(pointed(flat)).toBe('web');
    await type(flat.stdin, END, DOWN);
    expect(pointed(flat)).toBe('db');
    await type(flat.stdin, HOME);
    expect(pointed(flat)).toBe('web');
    await type(flat.stdin, CTRL_C);
    await stopped;
  });

  it('should reject a table with no rows, the way an empty list is', async () => {
    const ui = screenSetup({ columns: 60, rows: 10 });
    const { error } = await settle(open(ui, { rows: [] }));

    expect(error).toBeInstanceOf(PromptError);
    expect(error?.message).toContain('no rows');
  });

  it('should reject where there is nobody to answer', async () => {
    const ui = screenSetup({ columns: 60, isTTY: false, rows: 10 });
    const { error } = await settle(open(ui));

    expect(error).toBeInstanceOf(PromptError);
    expect(error?.message).toContain('not a terminal');
  });

  it('should leave the question and the row behind once answered', async () => {
    const ui = screenSetup({ columns: 60, rows: 10 });
    const answer = settle(open(ui));

    await type(ui.stdin, DOWN, ENTER);
    await answer;

    expect(screen(ui)).toEqual(['? Which deployment? api, us-east, 3']);
  });

  it('should say what was picked in the caller own words when `short` is given', async () => {
    const ui = screenSetup({ columns: 60, rows: 10 });
    const answer = settle(open(ui, { short: (row) => row.name }));

    await type(ui.stdin, DOWN, ENTER);
    await answer;

    expect(screen(ui)).toEqual(['? Which deployment? api']);
  });

  describe('sorting', () => {
    it('should sort a number column as numbers, so 7 comes before 12', async () => {
      const ui = screenSetup({ columns: 60, rows: 10 });
      const answer = settle(open(ui));

      await type(ui.stdin, '3');

      expect(screen(ui).slice(1, 2)).toEqual(['  Name    Region    Age ▲']);
      expect(body(ui).map((line) => line.split(/\s+/)[0])).toEqual(['api', 'db', 'web', 'Worker']);

      await type(ui.stdin, CTRL_C);
      await answer;
    });

    it('should fold case when it sorts text, so Worker does not come before api', async () => {
      const ui = screenSetup({ columns: 60, rows: 10 });
      const answer = settle(open(ui));

      await type(ui.stdin, '1');

      expect(body(ui).map((line) => line.split(/\s+/)[0])).toEqual(['api', 'db', 'web', 'Worker']);

      await type(ui.stdin, CTRL_C);
      await answer;
    });

    it('should reverse on a second press and restore the original order on a third', async () => {
      const ui = screenSetup({ columns: 60, rows: 10 });
      const answer = settle(open(ui));
      const names = (): string[] => body(ui).map((line) => line.split(/\s+/)[0] as string);

      await type(ui.stdin, '3');
      expect(names()).toEqual(['api', 'db', 'web', 'Worker']);

      await type(ui.stdin, '3');
      expect(names()).toEqual(['Worker', 'web', 'db', 'api']);
      expect(screen(ui)[1]).toBe('  Name    Region    Age ▼');

      await type(ui.stdin, '3');
      expect(names()).toEqual(['web', 'api', 'Worker', 'db']);
      expect(screen(ui)[1]).toBe('  Name    Region      Age');

      await type(ui.stdin, CTRL_C);
      await answer;
    });

    it('should keep the cursor on the row it was on, wherever the sort sends it', async () => {
      const ui = screenSetup({ columns: 60, rows: 10 });
      const answer = settle(open(ui));

      await type(ui.stdin, DOWN, DOWN);
      expect(pointed(ui)).toBe('Worker');

      await type(ui.stdin, '3');
      expect(pointed(ui)).toBe('Worker');

      await type(ui.stdin, ENTER);
      expect((await answer).value).toBe(DEPLOYMENTS[2]);
    });

    it('should answer with the row under the cursor in the sorted order', async () => {
      const ui = screenSetup({ columns: 60, rows: 10 });
      const answer = settle(open(ui));

      await type(ui.stdin, '3', HOME, ENTER);

      expect((await answer).value).toBe(DEPLOYMENTS[1]);
    });

    it('should keep rows that tie in the order they came in, both ways', async () => {
      const ui = screenSetup({ columns: 60, rows: 10 });
      const answer = settle(open(ui));
      const names = (): string[] => body(ui).map((line) => line.split(/\s+/)[0] as string);

      await type(ui.stdin, '2');
      // api and db are both us-east, and api is first in the data
      expect(names()).toEqual(['Worker', 'web', 'api', 'db']);

      await type(ui.stdin, '2');
      expect(names()).toEqual(['api', 'db', 'web', 'Worker']);

      await type(ui.stdin, CTRL_C);
      await answer;
    });

    it('should place a row with no value last whichever way the column runs', async () => {
      const ui = screenSetup({ columns: 60, rows: 10 });
      const rows = [{ n: 2 }, { n: undefined }, { n: 1 }, { n: null }, { n: Number.NaN }];
      const answer = settle(
        selectRow({
          ansi: ui.ansi,
          columns: [{ header: 'N', key: 'n' }],
          frameMs: 0,
          message: 'Pick',
          rows,
          terminal: ui.terminal,
        })
      );
      // read off the raw lines: a row whose cell is empty is a blank-looking row
      // that `screen()` would have dropped
      const cells = (): string[] =>
        ui.log.slice(2, 2 + rows.length).map((line) => line.replace(/^(❯| ) /, '').trim());

      await type(ui.stdin, '1');
      expect(cells()).toEqual(['1', '2', '', '', 'NaN']);

      await type(ui.stdin, '1');
      expect(cells()).toEqual(['2', '1', '', '', 'NaN']);

      await type(ui.stdin, CTRL_C);
      await answer;
    });

    it('should leave a column alone when it is marked not sortable, and say so in the hint', async () => {
      const ui = screenSetup({ columns: 70, rows: 10 });
      const answer = settle(
        open(ui, {
          columns: [
            { header: 'Name', key: 'name' },
            { header: 'Region', key: 'region', sortable: false },
          ],
        })
      );

      await tick();
      expect(screen(ui)[0]).toBe('? Which deployment? (enter to pick, 1 to sort)');

      await type(ui.stdin, '2');
      expect(body(ui).map((line) => line.split(/\s+/)[0])).toEqual(['web', 'api', 'Worker', 'db']);
      expect(screen(ui)[1]).toBe('  Name    Region');

      await type(ui.stdin, CTRL_C);
      await answer;
    });

    it('should offer no sort at all where no column can be sorted', async () => {
      const ui = screenSetup({ columns: 70, rows: 10 });
      const answer = settle(open(ui, { columns: [{ key: 'name', sortable: false }] }));

      await tick();
      expect(screen(ui)[0]).toBe('? Which deployment? (enter to pick)');

      await type(ui.stdin, CTRL_C);
      await answer;
    });

    it('should use a column compare in place of the default', async () => {
      const ui = screenSetup({ columns: 60, rows: 10 });
      const answer = settle(
        open(ui, {
          columns: [
            { header: 'Name', key: 'name', compare: (a, b) => String(a).length - String(b).length },
          ],
        })
      );

      await type(ui.stdin, '1');

      expect(body(ui).map((line) => line.trim())).toEqual(['db', 'web', 'api', 'Worker']);

      await type(ui.stdin, CTRL_C);
      await answer;
    });

    it('should not move the columns when a sort turns the arrow on', async () => {
      const ui = screenSetup({ columns: 60, rows: 10 });
      const answer = settle(open(ui));
      const widths = (): number[] =>
        screen(ui)
          .slice(1)
          .map((line) => line.length);

      await tick();
      const before = widths();
      await type(ui.stdin, '1');

      expect(widths()).toEqual(before);

      await type(ui.stdin, CTRL_C);
      await answer;
    });

    it('should ignore a digit that names no column', async () => {
      const ui = screenSetup({ columns: 60, rows: 10 });
      const answer = settle(open(ui));

      await type(ui.stdin, '9', '0');

      expect(screen(ui)[1]).toBe('  Name    Region      Age');
      expect(body(ui)[0]).toContain('web');

      await type(ui.stdin, CTRL_C);
      await answer;
    });
  });

  describe('a table longer than the screen', () => {
    const MANY = Array.from({ length: 30 }, (_, i) => ({ id: i, name: `row ${i}` }));
    const base = (ui: ScreenHarness) => ({
      ansi: ui.ansi,
      columns: [
        { header: 'Id', key: 'id' },
        { header: 'Name', key: 'name' },
      ],
      frameMs: 0,
      message: 'Pick',
      rows: MANY,
      terminal: ui.terminal,
    });

    it('should keep the heading on screen while the rows scroll, and say where it is', async () => {
      const ui = screenSetup({ columns: 40, rows: 8 });
      const answer = settle(selectRow(base(ui)));

      await tick();
      // eight rows: the question, the heading, a position line, and four of thirty
      expect(screen(ui)).toEqual([
        '? Pick (enter to pick, 1-2 to sort)',
        '  Id    Name',
        '❯ 0     row 0',
        '  1     row 1',
        '  2     row 2',
        '  3     row 3',
        '  4     row 4',
        '  1/30',
      ]);

      await type(ui.stdin, END);
      expect(screen(ui).slice(0, 2)).toEqual([
        '? Pick (enter to pick, 1-2 to sort)',
        '  Id    Name',
      ]);
      expect(screen(ui).at(-1)).toBe('  30/30');
      expect(screen(ui).at(-2)).toBe('❯ 29    row 29');

      await type(ui.stdin, CTRL_C);
      await answer;
    });

    it('should draw no position line where every row fits', async () => {
      const ui = screenSetup({ columns: 60, rows: 10 });
      const answer = settle(open(ui));

      await tick();

      expect(screen(ui).some((line) => /\d+\/\d+$/.test(line))).toBe(false);

      await type(ui.stdin, CTRL_C);
      await answer;
    });

    it('should take a page at a time, and stop at the ends', async () => {
      const ui = screenSetup({ columns: 40, rows: 8 });
      const answer = settle(selectRow(base(ui)));

      await type(ui.stdin, PAGEDOWN);
      expect(pointed(ui)).toBe('4');

      await type(ui.stdin, HOME, PAGEDOWN, PAGEDOWN, PAGEDOWN);
      expect(pointed(ui)).toBe('12');

      await type(ui.stdin, CTRL_C);
      await answer;
    });

    it('should honour `height` as the most body rows it will take', async () => {
      const ui = screenSetup({ columns: 40, rows: 20 });
      const answer = settle(selectRow({ ...base(ui), height: 3 }));

      await tick();

      // two body rows and the position line, which is what three rows of height
      // comes to once the table has to say where it is
      expect(screen(ui).filter((line) => /row \d/.test(line))).toHaveLength(2);

      await type(ui.stdin, CTRL_C);
      await answer;
    });

    it('should keep the columns the same width as the window moves', async () => {
      const ui = screenSetup({ columns: 40, rows: 8 });
      const rows = [
        { id: 1, name: 'a' },
        ...Array.from({ length: 12 }, (_, i) => ({ id: i + 2, name: `a${'b'.repeat(i)}` })),
      ];
      const answer = settle(selectRow({ ...base(ui), rows }));

      await tick();
      const first = screen(ui)[1];
      await type(ui.stdin, END);

      // the heading is the one line that is the same row both times
      expect(screen(ui)[1]).toBe(first);

      await type(ui.stdin, CTRL_C);
      await answer;
    });

    it('should keep the cursor on its row through a sort that moves it off screen', async () => {
      const ui = screenSetup({ columns: 40, rows: 8 });
      const answer = settle(selectRow(base(ui)));

      await type(ui.stdin, '1', '1');
      expect(pointed(ui)).toBe('0');
      expect(screen(ui).at(-1)).toBe('  30/30');

      await type(ui.stdin, ENTER);
      expect((await answer).value).toBe(MANY[0]);
    });
  });

  it('should reject as aborted on Ctrl-C, like every prompt', async () => {
    const ui = screenSetup({ columns: 60, rows: 10 });
    const answer = settle(open(ui));

    await type(ui.stdin, CTRL_C);

    expect((await answer).error?.aborted).toBe(true);
  });
});

describe('compareCells()', () => {
  it.each([
    [9, 10, -1],
    [10, 9, 1],
    [2, 2, 0],
    [1n, 2, -1],
    [new Date(2020, 0, 1), new Date(2021, 0, 1), -1],
    [false, true, -1],
    ['alpha', 'Zeta', -1],
    ['a', 'A', 1],
    ['10', '9', -1],
    [5, 'five', -1],
    ['five', 5, 1],
    [undefined, 1, 1],
    [1, null, -1],
    [Number.NaN, 'x', 1],
    [new Date(Number.NaN), 0, 1],
  ])('should order %s against %s as %s', (a, b, sign) => {
    expect(Math.sign(compareCells(a, b))).toBe(sign);
  });

  it('should treat two empty cells as equal', () => {
    expect(compareCells(undefined, null)).toBe(0);
    expect(compareCells(Number.NaN, undefined)).toBe(0);
  });
});
