import { strip } from '../../src/ansi/index.js';
import { badgeView } from '../../src/components/badge.js';
import {
  DataTable,
  type DataTableColumn,
  type DataTableControl,
  dataTableControl,
  type DataTableDescriber,
  type DataTableProps,
  type DataTableSort,
  describeDataTable,
  fitColumns,
} from '../../src/components/data-table.js';
import { keyHelp } from '../../src/components/key-help.js';
import type { Key } from '../../src/components/keys.js';
import {
  arrange,
  box,
  type Element,
  renderToLines,
  renderToString,
  resolveStyles,
} from '../../src/element/index.js';
import {
  createInput,
  type DescribeOptions,
  type KeyEvent,
  type MouseEvent,
} from '../../src/input/index.js';
import { flush, State } from '../../src/signals/index.js';
import { createTestTerminal, KEYS } from '../../src/testing/index.js';
import { themedCascade } from '../../src/theme/index.js';
import { describe, expect, it } from 'vitest';

/**
 * The data table: a list view with a heading, an order, and widths.
 *
 * The list under it has its own suite, so what is asserted here is what the table
 * adds -- the heading and the arrow, sorting by a click and by a digit, the column
 * widths and which columns a narrow table keeps -- and the one property the ticket
 * exists for, which is the list's answer reached through the table: rows that
 * change every second while the selection stays on its row and the view stays
 * where it was. That block is the htop case, driven tick by tick.
 */

/** The table as drawn, colour taken off and the right edge trimmed. */
function picture(host: Element, width = 40): string[] {
  return renderToLines(host, { cascade: themedCascade(), colorLevel: 0, width }).map((line) =>
    strip(line).trimEnd()
  );
}

/** A key event as the router builds one, with a record of whether it was stopped. */
function keyEvent(
  name: string,
  mods: Partial<Pick<Key, 'ctrl' | 'meta'>> = {}
): KeyEvent & {
  claimed: () => boolean;
} {
  let stopped = false;
  const key: Key = {
    ctrl: mods.ctrl ?? false,
    meta: mods.meta ?? false,
    name,
    sequence: '',
    shift: false,
  };
  return {
    claimed: () => stopped,
    current: undefined,
    key,
    paste: false,
    stop(): void {
      stopped = true;
    },
    get stopped() {
      return stopped;
    },
    target: undefined,
  };
}

/** A left click as the router delivers one. */
function click(): MouseEvent & { claimed: () => boolean } {
  let stopped = false;
  return {
    button: 'left',
    claimed: () => stopped,
    ctrl: false,
    current: undefined,
    kind: 'click',
    meta: false,
    shift: false,
    stop(): void {
      stopped = true;
    },
    get stopped() {
      return stopped;
    },
    target: undefined,
    wheel: undefined,
    x: 0,
    y: 0,
  };
}

/** The control, which every table has. */
function control<K = number>(host: Element): DataTableControl<K> {
  const found = dataTableControl<K>(host);
  if (!found) {
    throw new Error('no control');
  }
  return found;
}

/**
 * Presses a key the way the router delivers it: to the focused list first, and
 * then, unless it stopped there, to the table around it.
 */
function press(host: Element, name: string, mods: Parameters<typeof keyEvent>[1] = {}): boolean {
  const event = keyEvent(name, mods);
  control(host).list.onKey?.(event);
  if (!event.stopped) {
    host.onKey?.(event);
  }
  flush();
  return event.claimed();
}

/** Every element under one, itself included. */
function every(at: Element, out: Element[] = []): Element[] {
  out.push(at);
  for (const child of at.children) {
    every(child, out);
  }
  return out;
}

/** The heading cell whose text starts with a word. */
function heading(host: Element, word: string): Element {
  const found = every(host).find(
    (e) => e.classes.includes('sigil-table-head') && (e.text ?? '').trim().startsWith(word)
  );
  if (!found) {
    throw new Error(`no heading ${word}`);
  }
  return found;
}

/** Clicks a heading, then lets the effects run. */
function clickHeading(host: Element, word: string): boolean {
  const event = click();
  heading(host, word).onMouse?.(event);
  flush();
  return event.claimed();
}

interface Proc {
  cpu: number;
  name: string;
  pid: number;
  user: string;
}

const PROCS: readonly Proc[] = [
  { cpu: 0.1, name: 'launchd', pid: 1, user: 'root' },
  { cpu: 12.5, name: 'node', pid: 42, user: 'chris' },
  { cpu: 3, name: 'WindowServer', pid: 7, user: '_windowserver' },
];

const COLUMNS: readonly DataTableColumn<Proc>[] = [
  { align: 'right', header: 'PID', key: 'pid' },
  { header: 'USER', key: 'user', priority: -1 },
  {
    align: 'right',
    descendingFirst: true,
    format: (cpu) => (cpu as number).toFixed(1),
    header: 'CPU%',
    key: 'cpu',
  },
  { grow: 1, header: 'NAME', key: 'name', minWidth: 6 },
];

/** A process table, `height` rows tall with its heading, with no scrollbar unless asked. */
function procs(over: Partial<DataTableProps<Proc, number>> = {}, height = 6): Element {
  return DataTable<Proc, number>({
    ascii: false,
    columns: COLUMNS,
    key: (p) => p.pid,
    props: { height },
    rows: PROCS,
    scrollbar: false,
    ...over,
  });
}

/** A deterministic generator, so a run of ticks is the same run every time. */
function random(seed: number): () => number {
  let n = seed;
  return () => {
    n = (n * 1_103_515_245 + 12_345) % 2_147_483_648;
    return n / 2_147_483_648;
  };
}

describe('fitColumns()', () => {
  const at = (width: number, more: Partial<Parameters<typeof fitColumns>[0][number]> = {}) => ({
    min: width,
    width,
    ...more,
  });

  it('should give every column its width while nothing has said how much room there is', () => {
    expect(fitColumns([at(3), at(5)], Number.POSITIVE_INFINITY, 2)).toEqual([3, 5]);
  });

  it('should hide the lowest priority first, the rightmost among equals, and never the last column', () => {
    const columns = [at(4), at(4, { priority: -1 }), at(4), at(4)];
    // 4 + 2 + 4 + 2 + 4 + 2 + 4 is 22: one column short of room for all four
    expect(fitColumns(columns, 21, 2)).toEqual([4, undefined, 4, 4]);
    expect(fitColumns(columns, 15, 2)).toEqual([4, undefined, 4, undefined]);
    expect(fitColumns(columns, 1, 2)).toEqual([4, undefined, undefined, undefined]);
  });

  it('should narrow a column toward its minimum before hiding anything, the one with most to give first', () => {
    const columns = [at(10, { min: 4 }), at(6, { min: 2 }), at(3, { priority: -1 })];
    // 10 + 6 + 3 and two gaps of 1 is 21; 17 is four short, taken from the
    // ten-wide column until it has no more to give than the six-wide one
    expect(fitColumns(columns, 17, 1)).toEqual([7, 5, 3]);
    // the minimums, 4 + 2 + 3 and the gaps, fit in 11, so nothing is hidden
    expect(fitColumns(columns, 11, 1)).toEqual([4, 2, 3]);
    // one cell short of the minimums, so the lowest priority goes, and the seven
    // over are taken evenly, the rightmost first where the two have as much to give
    expect(fitColumns(columns, 10, 1)).toEqual([6, 3, undefined]);
  });

  it('should hand the room left over to the columns that grow, by their share, the remainder from the left', () => {
    const columns = [at(3, { grow: 1 }), at(3), at(3, { grow: 2 })];
    // 9 and two gaps is 11, so 8 are left: a third and two thirds, 2 and 5, and
    // the one left over to the leftmost that grows
    expect(fitColumns(columns, 19, 1)).toEqual([6, 3, 8]);
  });
});

describe('DataTable()', () => {
  it('should draw a heading over the cells, lined up past the pointer, with the arrow on the sorted column', () => {
    const host = procs({ sort: { column: 'cpu', descending: true } });
    expect(picture(host, 48).slice(0, 4)).toEqual([
      '    PID  USER           CPU% ▼  NAME',
      '❯    42  chris            12.5  node',
      '      7  _windowserver     3.0  WindowServer',
      '      1  root              0.1  launchd',
    ]);
  });

  it('should line the heading up past the marks of a multiple table too', () => {
    const host = procs({ multiple: true, selected: [7] });
    expect(picture(host, 48).slice(0, 3)).toEqual([
      '      PID  USER             CPU%  NAME',
      '❯ ◯     1  root              0.1  launchd',
      '  ◯    42  chris            12.5  node',
    ]);
  });

  it('should line the heading up in ASCII, where a mark is three cells', () => {
    const host = procs({ ascii: true, multiple: true, sort: { column: 'pid' } });
    expect(picture(host, 48).slice(0, 2)).toEqual([
      '      PID ^  USER             CPU%  NAME',
      '> [ ]     1  root              0.1  launchd',
    ]);
  });

  it('should keep two columns back on a sortable heading, so turning a sort on moves nothing', () => {
    const host = procs({ columns: [{ header: 'NAME', key: 'name' }], rows: [PROCS[1] as Proc] });
    const before = picture(host);
    control(host).sortBy('name');
    flush();
    expect(picture(host)[0]).toBe('  NAME ▲');
    // `node` is narrower than the heading, so the column is the heading and two
    expect(before.slice(0, 2)).toEqual(['  NAME', '❯ node']);
    const pinned = procs({
      columns: [{ header: 'NAME', key: 'name', sortable: false }],
      rows: [PROCS[1] as Proc],
    });
    expect(picture(pinned)[0]).toBe('  NAME');
    expect(picture(pinned)[1]).toBe('❯ node');
  });

  it('should draw what format says and sort by the value, which is the bytes and not the text', () => {
    const files = [
      { bytes: 2_000_000, name: 'b' },
      { bytes: 900, name: 'a' },
      { bytes: 30_000, name: 'c' },
    ];
    const host = DataTable({
      ascii: false,
      columns: [
        { key: 'name' },
        {
          align: 'right',
          format: (n) =>
            (n as number) >= 1e6
              ? `${(n as number) / 1e6} MB`
              : (n as number) >= 1e3
                ? `${(n as number) / 1e3} kB`
                : `${n as number} B`,
          key: 'bytes',
        },
      ],
      head: false,
      key: (f) => f.name,
      props: { height: 3 },
      rows: files,
      scrollbar: false,
      sort: { column: 'bytes' },
    });
    expect(picture(host)).toEqual(['❯ a  900 B', '  c  30 kB', '  b   2 MB']);
  });

  it('should take a value function for a cell the key cannot reach, and draw a view as a cell', () => {
    const rows = [
      { meta: { state: 'PASS' }, name: 'lint' },
      { meta: { state: 'FAIL' }, name: 'test' },
    ];
    const host = DataTable({
      ascii: false,
      columns: [
        { key: 'name' },
        {
          format: (state) => badgeView(state as string, { colorLevel: 0 }),
          key: 'state',
          value: (row) => row.meta.state,
          width: 6,
        },
      ],
      head: false,
      key: (r) => r.name,
      props: { height: 2 },
      rows,
      scrollbar: false,
      sort: { column: 'state' },
    });
    expect(picture(host)).toEqual(['❯ test  [FAIL]', '  lint  [PASS]']);
  });

  it('should never format a column whose width is declared in order to measure it', () => {
    let formatted = 0;
    const host = procs({
      columns: [
        { key: 'pid' },
        {
          format: (name) => {
            formatted++;
            return String(name);
          },
          key: 'name',
          width: 10,
        },
      ],
      rows: Array.from({ length: 1000 }, (_, i) => ({ cpu: 0, name: `p${i}`, pid: i, user: '' })),
    });
    picture(host);
    // the rows on screen -- six, since no column has a heading -- and nothing else
    expect(formatted).toBe(6);
  });

  describe('sorting', () => {
    it('should sort on a click on a heading: its first direction, the other way, and back as they came', () => {
      const host = procs();
      const order = () =>
        picture(host, 48)
          .slice(1, 4)
          .map((line) => line.trim().split(/\s+/).at(-1));
      expect(order()).toEqual(['launchd', 'node', 'WindowServer']);

      expect(clickHeading(host, 'NAME')).toBe(true);
      expect(order()).toEqual(['launchd', 'node', 'WindowServer']);
      expect(control(host).sort.get()).toEqual({ column: 'name', descending: false });
      clickHeading(host, 'NAME');
      expect(order()).toEqual(['WindowServer', 'node', 'launchd']);
      clickHeading(host, 'NAME');
      expect(control(host).sort.get()).toBeUndefined();
      expect(order()).toEqual(['launchd', 'node', 'WindowServer']);

      // CPU is descendingFirst: the busiest process is what a first sort is for
      clickHeading(host, 'CPU%');
      expect(order()).toEqual(['node', 'WindowServer', 'launchd']);
      expect(heading(host, 'CPU%').classes).toContain('is-sorted');
      clickHeading(host, 'CPU%');
      expect(order()).toEqual(['launchd', 'WindowServer', 'node']);
    });

    it('should sort on a digit, the column it numbers, and leave a digit with nothing to sort alone', () => {
      const host = procs({
        columns: [
          ...COLUMNS.slice(0, 3),
          { ...(COLUMNS[3] as DataTableColumn<Proc>), sortable: false },
        ],
      });
      picture(host, 48);
      expect(press(host, '1')).toBe(true);
      expect(control(host).sort.get()).toEqual({ column: 'pid', descending: false });
      expect(press(host, '3')).toBe(true);
      expect(control(host).sort.get()).toEqual({ column: 'cpu', descending: true });
      // NAME does not sort, and there is no fifth column
      expect(press(host, '4')).toBe(false);
      expect(press(host, '5')).toBe(false);
      expect(press(host, '1', { ctrl: true })).toBe(false);
      expect(clickHeading(host, 'NAME')).toBe(false);
      expect(control(host).sort.get()).toEqual({ column: 'cpu', descending: true });
    });

    it('should keep the cursor on its row through a sort, and the view on the cursor', () => {
      const rows = Array.from({ length: 50 }, (_, i) => ({
        cpu: i,
        name: `p${String(i).padStart(2, '0')}`,
        pid: i,
        user: '',
      }));
      const host = procs({ rows }, 6);
      control(host).selection.current.set(3);
      flush();
      picture(host);

      clickHeading(host, 'CPU%');
      const lines = picture(host);
      expect(control(host).selection.current.get()).toBe(3);
      expect(lines.find((line) => line.startsWith('❯'))).toContain('p03');
    });

    it('should put an empty value last whichever way the column runs', () => {
      const rows = [
        { cpu: Number.NaN, name: 'gone', pid: 9, user: '' },
        { cpu: 2, name: 'b', pid: 2, user: '' },
        { cpu: 1, name: 'a', pid: 1, user: '' },
      ];
      const host = procs({
        columns: [{ key: 'name' }, { key: 'cpu' }],
        head: false,
        rows,
        sort: { column: 'cpu' },
      });
      const names = () => picture(host).map((line) => line.slice(2).trim().split(/\s+/)[0]);
      expect(names().slice(0, 3)).toEqual(['a', 'b', 'gone']);
      control(host).sort.set({ column: 'cpu', descending: true });
      flush();
      expect(names().slice(0, 3)).toEqual(['b', 'a', 'gone']);
    });

    it('should follow a sort an app writes, and refuse one that names no column', () => {
      const sort = new State<DataTableSort | undefined>(undefined);
      const host = procs({ sort });
      picture(host, 48);
      sort.set({ column: 'user', descending: false });
      flush();
      expect(picture(host, 48)[1]).toContain('_windowserver');
      expect(picture(host, 48)[0]).toContain('USER ▲');
      expect(() => procs({ sort: { column: 'nope' } })).toThrow(
        'Expected data table sort to name a column: nope is not one'
      );
    });
  });

  describe('column widths', () => {
    it('should hide the lowest priority column first as the table narrows, and give the room to the one that grows', () => {
      const host = procs({ sort: { column: 'cpu', descending: true } });
      expect(picture(host, 30).slice(0, 2)).toEqual([
        '    PID  CPU% ▼  NAME',
        '❯    42    12.5  node',
      ]);
      expect(control(host).shown()).toEqual(['pid', 'cpu', 'name']);
      // USER's digit goes with it
      expect(press(host, '2')).toBe(false);

      expect(picture(host, 22)[0]).toBe('    PID  CPU% ▼');
      expect(control(host).shown()).toEqual(['pid', 'cpu']);

      // and they come back when there is room again
      expect(picture(host, 48)[0]).toBe('    PID  USER           CPU% ▼  NAME');
      expect(control(host).shown()).toEqual(['pid', 'user', 'cpu', 'name']);
    });

    it('should narrow a column that may before hiding one, cutting its cells with an ellipsis', () => {
      const host = procs();
      // 2 + 5 + 13 + 6 + 6 + three gaps of 2 is 38: NAME at its minimum, and
      // nothing hidden
      expect(picture(host, 40)[3]).toBe('      7  _windowserver     3.0  WindowS…');
    });

    it('should widen a column to the widest cell it has held, and not narrow it when that row goes', () => {
      const rows = new State<readonly Proc[]>(PROCS);
      const host = procs({ columns: [{ key: 'user' }, { key: 'pid' }], head: false, rows });
      expect(picture(host)[0]).toBe('❯ root           1');

      rows.set(PROCS.filter((p) => p.user !== '_windowserver'));
      flush();
      // a live column that gave its width back would move every column to its
      // right on the tick the widest row left, and back on the tick it returned
      expect(picture(host)[0]).toBe('❯ root           1');

      rows.set([...rows.get(), { cpu: 0, name: 'x', pid: 99, user: 'a-much-longer-user' }]);
      flush();
      expect(picture(host)[0]).toBe('❯ root                1');

      // refresh() measures again from the rows there are
      rows.set(PROCS.slice(0, 2));
      flush();
      control(host).refresh();
      expect(picture(host)[0]).toBe('❯ root   1');
    });

    it('should hold a declared width and a maximum', () => {
      const host = procs({
        columns: [
          { key: 'user', maxWidth: 6 },
          { key: 'name', width: 4 },
        ],
        head: false,
      });
      expect(picture(host).slice(0, 3)).toEqual([
        '❯ root    lau…',
        '  chris   node',
        '  _wind…  Win…',
      ]);
    });

    it('should follow columns an app replaces: one hidden, one widened', () => {
      const columns = new State<readonly DataTableColumn<Proc>[]>(COLUMNS);
      const host = procs({ columns });
      expect(picture(host, 48)[0]).toBe('    PID  USER             CPU%  NAME');

      columns.set([
        COLUMNS[0] as DataTableColumn<Proc>,
        { ...(COLUMNS[3] as DataTableColumn<Proc>), grow: 0, width: 20 },
      ]);
      flush();
      expect(picture(host, 48).slice(0, 2)).toEqual(['    PID  NAME', '❯     1  launchd']);
      expect(control(host).shown()).toEqual(['pid', 'name']);
    });
  });

  describe('live rows', () => {
    /** A machine of `n` processes whose CPU moves every tick, and whose processes come and go. */
    function machine(n: number, seed: number) {
      const roll = random(seed);
      let next = n + 1;
      const rows = new State<readonly Proc[]>(
        Array.from({ length: n }, (_, i) => ({
          cpu: Math.round(roll() * 1000) / 10,
          name: `proc-${i + 1}`,
          pid: i + 1,
          user: 'chris',
        }))
      );
      /** A second: every process gets a new reading, two exit and two start. */
      const tick = (keep: ReadonlySet<number>): void => {
        const now = rows.get().filter((p, i) => keep.has(p.pid) || (i * 7 + next) % 97 !== 0);
        const exited = rows.get().length - now.length;
        const started = Array.from({ length: Math.max(2, exited) }, () => {
          const pid = next++;
          return { cpu: 0, name: `proc-${pid}`, pid, user: 'chris' };
        });
        rows.set([...now, ...started].map((p) => ({ ...p, cpu: Math.round(roll() * 1000) / 10 })));
        flush();
      };
      return { rows, tick };
    }

    it('should keep the selection on its process and the view where it was while every row changes, htop-style', () => {
      const { rows, tick } = machine(200, 3);
      const host = procs({ multiple: true, rows }, 11);
      const { scroll, selection } = control(host);
      picture(host);
      selection.moveTo(60);
      selection.toggle();
      selection.moveTo(64);
      flush();
      picture(host);
      const pid = selection.current.get() as number;
      const ticked = selection.selected.get();
      let y = scroll.viewport.scroll?.y as number;
      expect(y).toBe(55);

      let moved = 0;
      for (let second = 0; second < 30; second++) {
        tick(new Set([pid, ...ticked]));
        const lines = picture(host);
        expect(selection.current.get()).toBe(pid);
        expect(selection.selected.get()).toBe(ticked);
        expect(lines.find((line) => line.startsWith('❯'))).toMatch(new RegExp(`\\s${pid}\\s`));
        // processes that exit above the cursor carry it up the screen, and the view
        // moves only once it would otherwise leave the top: by exactly that much
        const now = scroll.viewport.scroll?.y as number;
        expect(now).toBe(Math.min(y, selection.index()));
        moved += now === y ? 0 : 1;
        y = now;
      }
      // both halves were exercised: ticks that left the view alone, and ticks that
      // had to follow the cursor
      expect(moved).toBeGreaterThan(0);
      expect(moved).toBeLessThan(30);
      // only the rows on screen were ever built, every tick
      expect(every(host).filter((e) => e.classes.includes('sigil-list-row'))).toHaveLength(10);
    });

    it('should hold the view still while every value changes and nobody exits', () => {
      const rows = new State<readonly Proc[]>(
        Array.from({ length: 100 }, (_, i) => ({ cpu: 0, name: `p${i}`, pid: i, user: '' }))
      );
      const host = procs({ rows }, 11);
      const { scroll, selection } = control(host);
      picture(host);
      selection.moveTo(40);
      flush();
      // the wheel takes the view away from the cursor, which stays where it was
      scroll.viewport.scrollTo(0, 70);
      picture(host);
      const roll = random(5);
      for (let second = 0; second < 10; second++) {
        rows.set(rows.get().map((p) => ({ ...p, cpu: Math.round(roll() * 100) })));
        flush();
        picture(host);
        expect(scroll.viewport.scroll?.y).toBe(70);
        expect(selection.current.get()).toBe(40);
      }
    });

    it('should follow the selected process through a re-sort by a live column, and keep it on screen', () => {
      const { rows, tick } = machine(200, 11);
      const host = procs({ rows, sort: { column: 'cpu', descending: true } }, 11);
      const { selection } = control(host);
      picture(host);
      selection.moveTo(5);
      flush();
      const pid = selection.current.get() as number;
      const places = new Set<number>();

      for (let second = 0; second < 30; second++) {
        tick(new Set([pid]));
        const lines = picture(host);
        expect(selection.current.get()).toBe(pid);
        expect(lines.find((line) => line.startsWith('❯'))).toMatch(new RegExp(`\\s${pid}\\s`));
        places.add(selection.index());
      }
      // and it really did move: a re-sort by CPU carried it about the table
      expect(places.size).toBeGreaterThan(5);
    });

    it('should leave the cursor on the row that took the place of a process that exited', () => {
      const rows = new State<readonly Proc[]>(PROCS);
      const host = procs({ rows });
      control(host).selection.current.set(42);
      flush();
      rows.set(PROCS.filter((p) => p.pid !== 42));
      flush();
      expect(control(host).selection.current.get()).toBe(7);
    });
  });

  it('should keep the heading over the empty state', () => {
    const host = procs({ empty: 'No processes', rows: [] });
    expect(picture(host, 48).slice(0, 2)).toEqual([
      '    PID  USER      CPU%  NAME',
      'No processes',
    ]);
  });

  it('should pass the list its activation and its disabled rows', () => {
    const opened: number[] = [];
    const host = procs({
      disabled: (p) => p.pid === 42,
      onActivate: (pid) => opened.push(pid),
    });
    picture(host, 48);
    press(host, 'down');
    press(host, 'enter');
    expect(opened).toEqual([7]);
  });

  it('should refuse what it cannot use', () => {
    expect(() => DataTable({ columns: [], rows: 'abc' as never })).toThrow(
      'Expected data table rows to be an array, a State or a Computed'
    );
    expect(() => DataTable({ columns: 'abc' as never, rows: [] })).toThrow(
      'Expected data table columns to be an array, a State or a Computed'
    );
    expect(() => DataTable({ columns: ['a', 'a'], rows: [] })).toThrow(
      'Expected every data table column to have a name of its own: a is used twice'
    );
    expect(() => DataTable({ columns: [{ key: 'a', value: 3 as never }], rows: [] })).toThrow(
      'Expected data table column value to be a function'
    );
    expect(() => DataTable({ columns: [], key: 'id' as never, rows: [] })).toThrow(
      'Expected data table key to be a function'
    );
    expect(() => DataTable({ columns: [], props: { onKey: () => {} } as never, rows: [] })).toThrow(
      'onKey'
    );
  });

  it('should name a column with no key by its place', () => {
    const host = DataTable({
      ascii: false,
      columns: [{ header: 'A' }, { header: 'B' }],
      props: { height: 3 },
      rows: [
        ['x', 2],
        ['y', 1],
      ],
      scrollbar: false,
      sort: { column: '1' },
    });
    expect(picture(host).slice(0, 3)).toEqual(['  A    B ▲', '❯ y    1', '  x    2']);
  });

  it('should hand nothing to dataTableControl() for an element no table built', () => {
    expect(dataTableControl(box())).toBeUndefined();
  });
});

describe('describeDataTable()', () => {
  /** A router that records what it was told. */
  function recorder(): { live: Array<[string, DescribeOptions]>; router: DataTableDescriber } {
    const live: Array<[string, DescribeOptions]> = [];
    return {
      live,
      router: {
        describe(keys, opts) {
          const entry: [string, DescribeOptions] = [keys, opts];
          live.push(entry);
          return () => live.splice(live.indexOf(entry), 1);
        },
      },
    };
  }

  it('should describe the list keys and a digit per column on screen that sorts, scoped to the list', () => {
    const host = procs();
    const { live, router } = recorder();
    picture(host, 48);
    const off = describeDataTable(router, host);
    flush();
    const digits = () => live.filter(([keys]) => /^\d$/.test(keys)).map(([keys]) => keys);
    expect(digits()).toEqual(['1', '2', '3', '4']);
    expect(live.every(([, opts]) => opts.scope === control(host).list)).toBe(true);
    expect(live.map(([keys]) => keys)).toEqual(expect.arrayContaining(['up', 'down', 'home']));

    // USER hidden by a narrow terminal takes its digit with it
    picture(host, 30);
    flush();
    expect(digits()).toEqual(['1', '3', '4']);

    off();
    expect(live).toHaveLength(0);
  });

  it('should refuse an element that is not a table', () => {
    expect(() => describeDataTable(recorder().router, box())).toThrow(
      'Expected an element that DataTable() returned'
    );
  });
});

describe('a table under a real router', () => {
  it('should be reached by Tab, move on the arrows, sort on a digit, and list its keys', async () => {
    const term = createTestTerminal({ columns: 48, rows: 10 });
    const host = procs({}, 6);
    const root = box({ 'flex-direction': 'column' }, host);
    renderToString(root, { width: 48 });
    resolveStyles(root);
    arrange(root, { height: 10, width: 48 });
    const input = createInput({ root, terminal: term.terminal });
    describeDataTable(input, host);
    const footer = keyHelp(input, { width: 80 });

    await term.press(KEYS.tab, KEYS.down, '3');
    flush();
    expect(input.focus.current.get()).toBe(control(host).list);
    expect(control(host).sort.get()).toEqual({ column: 'cpu', descending: true });
    // the cursor stayed on pid 42, which the sort moved to the top
    expect(control(host).selection.current.get()).toBe(42);
    expect(
      renderToString(footer, { cascade: themedCascade(), colorLevel: 0, width: 80 })
    ).toContain('1/2/3/4 sort');
    input.stop();
  });
});
