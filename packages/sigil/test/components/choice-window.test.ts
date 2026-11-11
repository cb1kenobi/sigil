import { multiselect, select, separator } from '../../src/components/prompt.js';
import { Element } from '../../src/element/index.js';
import { screenSetup, tick } from './helpers.js';
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * SIG-369: `select()` and `multiselect()` built five elements for every choice
 * and wrote props on every one of them on every key, with the rows outside the
 * window kept in the tree as `display: none` -- so a key cost the length of the
 * list. A `select()` Down was 30.9ms at a thousand choices and 458.6ms at sixteen
 * thousand, the figures `src/components/AGENTS.md` records. The
 * tree holds the window's rows now, and these pin that as counts rather than as
 * time: what is built and what is written is the same at fifty choices as at
 * five thousand.
 */

const ENTER = '\r';
const CTRL_C = '\u0003';
const UP = '\u001b[A';
const DOWN = '\u001b[B';
const SPACE = ' ';
const HOME = '\u001b[H';
const END = '\u001b[F';

/** Sends keys one at a time, letting the prompt act on each. */
async function type(stdin: { send(chunk: string): void }, ...chunks: string[]) {
  for (const chunk of chunks) {
    stdin.send(chunk);
    await tick();
  }
}

/** Counts every write to an element made while `work` runs. */
async function writes(work: () => Promise<void>): Promise<number> {
  const spies = [
    vi.spyOn(Element.prototype, 'insertBefore'),
    vi.spyOn(Element.prototype, 'removeChild'),
    vi.spyOn(Element.prototype, 'setProps'),
    vi.spyOn(Element.prototype, 'setText'),
  ];
  try {
    await work();
    return spies.reduce((sum, spy) => sum + spy.mock.calls.length, 0);
  } finally {
    for (const spy of spies) {
      spy.mockRestore();
    }
  }
}

afterEach(() => {
  vi.restoreAllMocks();
});

/** What building a prompt over `count` choices costs, and what the keys cost after it. */
async function cost(
  kind: 'multiselect' | 'select',
  count: number,
  keys: string[]
): Promise<{ build: number; keys: number }> {
  const ui = screenSetup({ columns: 40, rows: 10 });
  const choices = Array.from({ length: count }, (_, i) => `item ${i}`);
  const ask = kind === 'select' ? select : multiselect;
  let answer: Promise<unknown> = Promise.resolve();

  const build = await writes(async () => {
    answer = ask({ ansi: ui.ansi, choices, message: 'Pick', terminal: ui.terminal }).catch(
      () => undefined
    );
    await tick();
  });
  const pressed = await writes(() => type(ui.stdin, ...keys));

  await type(ui.stdin, CTRL_C);
  await answer;
  return { build, keys: pressed };
}

describe('a choice list builds only the rows on screen', () => {
  // past the bottom of the window and back, a page each way, and a tick: every
  // path the window takes, none of which reaches the far end of either list
  const keys = [...Array(12).fill(DOWN), ...Array(12).fill(UP), DOWN, SPACE, DOWN];

  for (const kind of ['select', 'multiselect'] as const) {
    it(`should build ${kind}() at fifty choices what it builds at five thousand`, async () => {
      const small = await cost(kind, 50, []);
      const large = await cost(kind, 5000, []);

      expect(large.build).to.be.greaterThan(0);
      expect(large.build).to.equal(small.build);
    });

    it(`should write as much per key in ${kind}() at five thousand choices as at fifty`, async () => {
      const small = await cost(kind, 50, keys);
      const large = await cost(kind, 5000, keys);

      expect(large.keys).to.be.greaterThan(0);
      expect(large.keys).to.equal(small.keys);
    });

    // Up from the first choice wraps to the last, which at five thousand is a
    // jump of the whole window: a rebuild of the rows on screen and nothing more,
    // so it costs what the same jump over fifty does
    it(`should cost a jump to the end of ${kind}() what a window of rows costs`, async () => {
      const small = await cost(kind, 50, [UP, DOWN]);
      const large = await cost(kind, 5000, [UP, DOWN]);

      expect(large.keys).to.be.greaterThan(0);
      expect(large.keys).to.equal(small.keys);
    });
  }

  it('should cost End and Home in select() what a window of rows costs', async () => {
    const small = await cost('select', 50, [END, HOME]);
    const large = await cost('select', 5000, [END, HOME]);

    expect(large.keys).to.be.greaterThan(0);
    expect(large.keys).to.equal(small.keys);
  });
});

/** What is on screen, one string. */
function drawn(ui: { log: string[] }): string {
  return ui.log.join('\n');
}

describe('a choice list whose rows are built as the window moves', () => {
  /** The numbers of the rows on screen, top to bottom, and the highlighted one. */
  function shown(frame: string): { active: number; rows: number[] } {
    let active = -1;
    const rows: number[] = [];
    for (const line of frame.split('\n')) {
      const match = /item (\d+)/.exec(line);
      if (match) {
        rows.push(Number(match[1]));
        if (line.startsWith('❯')) {
          active = Number(match[1]);
        }
      }
    }
    return { active, rows };
  }

  // the window is rebuilt by taking out what left and putting in what entered,
  // and the second half has an order to get right in each direction: a row that
  // came in at the top goes in front of the rows kept, and one at the bottom
  // after them
  it('should keep the rows in order and the highlight among them whichever way it moves', async () => {
    const ui = screenSetup({ columns: 40, rows: 8 });
    const choices = Array.from({ length: 40 }, (_, i) => `item ${i}`);
    const answer = select({ ansi: ui.ansi, choices, message: 'Pick', terminal: ui.terminal });
    const keys = [
      ...Array(10).fill(DOWN),
      ...Array(10).fill(UP),
      END,
      ...Array(9).fill(UP),
      HOME,
      UP,
    ];

    let height = 0;
    for (const key of keys) {
      await type(ui.stdin, key);
      const { active, rows } = shown(drawn(ui));
      height ||= rows.length;

      expect(rows.length, drawn(ui)).to.equal(height);
      expect(rows, drawn(ui)).to.deep.equal(
        Array.from({ length: rows.length }, (_, i) => (rows[0] as number) + i)
      );
      expect(rows, drawn(ui)).to.include(active);
    }
    expect(height).to.be.greaterThan(1);

    await type(ui.stdin, ENTER);
    expect(await answer).to.equal('item 39');
  });

  it('should draw a heading and a disabled row the window scrolls onto', async () => {
    const ui = screenSetup({ columns: 40, rows: 6 });
    const answer = multiselect({
      ansi: ui.ansi,
      choices: [
        'item 0',
        'item 1',
        'item 2',
        'item 3',
        separator('later'),
        { disabled: 'not yet', label: 'item 4', value: 'item 4' },
        { hint: 'the last', label: 'item 5', selected: true, value: 'item 5' },
      ],
      message: 'Pick',
      terminal: ui.terminal,
    });

    // up from the first is the last, and down from the last is the first:
    // `multiselect()` has no Home or End, and wrapping is the jump it does have
    await type(ui.stdin, UP);
    expect(drawn(ui)).to.contain('later');
    expect(drawn(ui)).to.contain('item 4 not yet');
    expect(drawn(ui)).to.contain('❯ ◉ item 5 the last');
    expect(drawn(ui)).not.to.contain('item 0');

    await type(ui.stdin, DOWN);
    expect(drawn(ui)).to.contain('❯ ◯ item 0');
    expect(drawn(ui)).not.to.contain('later');

    await type(ui.stdin, ENTER);
    expect(await answer).to.deep.equal(['item 5']);
  });

  // a drawn row is written `display: flex` as a prop, as it was when a row off
  // screen was written `none`, and a prop beats a sheet -- so a theme hiding the
  // rows is overruled on every row the window builds, a heading's included, the
  // first window's and the ones a scroll brings in alike
  it('should write display: flex on every row it draws, which a theme cannot hide', async () => {
    const choices = [separator('top'), ...Array.from({ length: 20 }, (_, i) => `item ${i}`)];
    for (const ask of [select, multiselect] as const) {
      const ui = screenSetup({ columns: 40, rows: 6 });
      const answer = ask({
        ansi: ui.ansi,
        choices,
        message: 'Pick',
        terminal: ui.terminal,
        theme: '.sigil-choice { display: none }',
      }).catch(() => undefined);

      await tick();
      expect(drawn(ui)).to.contain('top');
      expect(shown(drawn(ui)).rows).to.include(0);

      await type(ui.stdin, UP);
      const { active, rows } = shown(drawn(ui));
      expect(active, drawn(ui)).to.equal(19);
      expect(rows.length, drawn(ui)).to.be.greaterThan(1);

      await type(ui.stdin, CTRL_C);
      await answer;
    }
  });
});
