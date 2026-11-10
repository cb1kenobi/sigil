import { strip } from '../../src/ansi/index.js';
import { keyHelp } from '../../src/components/key-help.js';
import type { Key } from '../../src/components/keys.js';
import {
  createListSelection,
  describeListView,
  type ListControl,
  listControl,
  ListView,
  type ListViewDescriber,
  type ListViewProps,
} from '../../src/components/list-view.js';
import {
  arrange,
  box,
  type Element,
  renderToLines,
  renderToString,
  resolveStyles,
  text,
} from '../../src/element/index.js';
import {
  createInput,
  type DescribeOptions,
  type KeyEvent,
  type MouseEvent,
} from '../../src/input/index.js';
import { createEffect, onCleanup } from '../../src/renderer/index.js';
import { Computed, flush, State } from '../../src/signals/index.js';
import { createTestTerminal, ctrl, KEYS } from '../../src/testing/index.js';
import { themedCascade } from '../../src/theme/index.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The list view, and the selection under it that a table and a tree share.
 *
 * The selection is tested on its own first, because it is the half published for
 * other components to stand on and its rules -- a cursor on a key, a set of keys,
 * both surviving the rows changing -- are separable from anything drawn. The
 * element is driven through the handlers the router would call, for the reason
 * `scroll-box.test.ts` gives, and the last block goes through a real router.
 */

const ESC = String.fromCharCode(0x1b);

/** The rows as they would be drawn, with colour taken off and the right edge trimmed. */
function picture(host: Element, width = 24): string[] {
  return renderToLines(host, { cascade: themedCascade(), colorLevel: 0, width }).map((line) =>
    strip(line).trimEnd()
  );
}

/** A key event as the router builds one, with a record of whether it was stopped. */
function keyEvent(
  name: string,
  mods: Partial<Pick<Key, 'ctrl' | 'meta' | 'shift'>> = {},
  paste = false
): KeyEvent & { claimed: () => boolean } {
  let stopped = false;
  const key: Key = {
    ctrl: mods.ctrl ?? false,
    meta: mods.meta ?? false,
    name,
    sequence: '',
    shift: mods.shift ?? false,
  };
  return {
    claimed: () => stopped,
    current: undefined,
    key,
    paste,
    stop(): void {
      stopped = true;
    },
    get stopped() {
      return stopped;
    },
    target: undefined,
  };
}

/** A left click as the router delivers one, with a record of whether it was stopped. */
function click(kind: MouseEvent['kind'] = 'click'): MouseEvent & { claimed: () => boolean } {
  let stopped = false;
  return {
    button: 'left',
    claimed: () => stopped,
    ctrl: false,
    current: undefined,
    kind,
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

/** Presses a key on the list, then lets the effects that draw it run. */
function press(host: Element, name: string, mods: Parameters<typeof keyEvent>[1] = {}): boolean {
  const event = keyEvent(name, mods);
  host.onKey?.(event);
  flush();
  return event.claimed();
}

/** The control, which every list has. */
function control<K = string>(host: Element): ListControl<K> {
  const found = listControl<K>(host);
  if (!found) {
    throw new Error('no control');
  }
  return found;
}

/** Every element under one, itself included. */
function every(at: Element, out: Element[] = []): Element[] {
  out.push(at);
  for (const child of at.children) {
    every(child, out);
  }
  return out;
}

/** The rows on screen, in order: the boxes a click lands on. */
function rowsOf(host: Element): Element[] {
  return every(host).filter((e) => e.classes.includes('sigil-list-row'));
}

/** The row drawing a piece of text. */
function rowWith(host: Element, label: string): Element {
  const found = rowsOf(host).find((row) =>
    every(row).some((e) => e.text === label || e.text?.trim() === label)
  );
  if (!found) {
    throw new Error(`no row ${label}`);
  }
  return found;
}

/** `n` strings, `item 0` onwards. */
function numbered(n: number): string[] {
  return Array.from({ length: n }, (_, i) => `item ${i}`);
}

/**
 * A list in a viewport `height` rows tall, drawn once so it has a layout. No
 * scrollbar unless asked, so a picture is the rows and nothing beside them.
 */
function list<T = string, K = T>(
  over: Partial<ListViewProps<T, K>> & Pick<ListViewProps<T, K>, 'items'>,
  height = 5
): Element {
  const host = ListView<T, K>({ ascii: false, props: { height }, scrollbar: false, ...over });
  picture(host);
  return host;
}

describe('createListSelection()', () => {
  it('should start on the first row that is not disabled, once it has rows', () => {
    const sel = createListSelection<string>();
    expect(sel.current.get()).toBeUndefined();

    sel.setRows(['a', 'b', 'c'], (i) => i === 0);

    expect(sel.current.get()).toBe('b');
    expect(sel.index()).toBe(1);
  });

  it('should move by one and by a page, passing over disabled rows and stopping at the ends', () => {
    const sel = createListSelection<string>();
    sel.setRows(['a', 'b', 'c', 'd', 'e'], (i) => i === 1 || i === 4);

    expect(sel.move(1)).toBe(true);
    expect(sel.current.get()).toBe('c');
    expect(sel.move(-1)).toBe(true);
    expect(sel.current.get()).toBe('a');
    expect(sel.move(-1)).toBe(false);
    // a page past the end lands on the last row that can be the cursor
    expect(sel.move(10)).toBe(true);
    expect(sel.current.get()).toBe('d');
    expect(sel.move(1)).toBe(false);
    expect(sel.first()).toBe(true);
    expect(sel.current.get()).toBe('a');
    expect(sel.last()).toBe(true);
    expect(sel.current.get()).toBe('d');
  });

  it('should keep the cursor on its key when the rows are re-sorted under it', () => {
    const sel = createListSelection<string>({ current: 'c' });
    sel.setRows(['a', 'b', 'c', 'd']);
    expect(sel.index()).toBe(2);

    sel.setRows(['d', 'c', 'b', 'a']);

    expect(sel.current.get()).toBe('c');
    expect(sel.index()).toBe(1);
  });

  it('should put the cursor on the row that took the place of one that went', () => {
    const sel = createListSelection<string>({ current: 'c' });
    sel.setRows(['a', 'b', 'c', 'd']);

    sel.setRows(['a', 'b', 'd']);
    expect(sel.current.get()).toBe('d');

    // and on the one before it, where the last row went
    sel.setRows(['a', 'b']);
    expect(sel.current.get()).toBe('b');
  });

  it('should move off a row that became disabled under it, to the nearest that is not', () => {
    const sel = createListSelection<string>({ current: 'b' });
    sel.setRows(['a', 'b', 'c']);

    sel.setRows(['a', 'b', 'c'], (i) => i === 1);

    expect(sel.current.get()).toBe('c');
  });

  it('should keep its key while there is no row to be on, and come back to it', () => {
    const sel = createListSelection<string>({ current: 'b' });
    sel.setRows(['a', 'b', 'c']);

    // a filter that matches nothing, and then everything again
    sel.setRows([]);
    expect(sel.current.get()).toBe('b');
    expect(sel.index()).toBe(-1);
    sel.setRows(['a', 'b'], () => true);
    expect(sel.current.get()).toBe('b');
    sel.setRows(['a', 'b', 'c']);

    expect(sel.current.get()).toBe('b');
    expect(sel.index()).toBe(1);
  });

  it('should refuse two rows with one key', () => {
    const sel = createListSelection<string>();
    expect(() => sel.setRows(['a', 'b', 'a'])).toThrow('a is used twice');
  });

  it('should be the states it was handed, and write them', () => {
    const current = new State<string | undefined>('b');
    const selected = new State<ReadonlySet<string>>(new Set(['a']));
    const sel = createListSelection({ current, multiple: true, selected });
    sel.setRows(['a', 'b', 'c']);

    sel.move(1);
    sel.toggle();

    expect(current.get()).toBe('c');
    expect([...selected.get()]).toEqual(['a', 'c']);
  });

  it('should toggle a row, and refuse a disabled row, a missing key and a single selection', () => {
    const sel = createListSelection<string>({ multiple: true });
    sel.setRows(['a', 'b', 'c'], (i) => i === 1);

    expect(sel.toggle('a')).toBe(true);
    expect(sel.isSelected('a')).toBe(true);
    expect(sel.toggle('a')).toBe(true);
    expect(sel.isSelected('a')).toBe(false);
    expect(sel.toggle('b')).toBe(false);
    expect(sel.toggle('z')).toBe(false);

    const single = createListSelection<string>();
    single.setRows(['a']);
    expect(single.toggle('a')).toBe(false);
    expect(single.toggleAll()).toBe(false);
    expect(single.selected.get().size).toBe(0);
  });

  it('should select every row with toggleAll(), and then none, leaving disabled and hidden keys alone', () => {
    const sel = createListSelection<string>({ multiple: true, selected: ['b', 'gone'] });
    sel.setRows(['a', 'b', 'c'], (i) => i === 1);

    sel.toggleAll();
    expect([...sel.selected.get()].toSorted()).toEqual(['a', 'b', 'c', 'gone']);
    sel.toggleAll();
    expect([...sel.selected.get()].toSorted()).toEqual(['b', 'gone']);
  });

  it('should never prune the selection when the rows change, since a hidden row is not a deleted one', () => {
    const sel = createListSelection<string>({ multiple: true, selected: ['a', 'c'] });
    sel.setRows(['a', 'b', 'c']);

    // a collapsed tree node, or a filter, hides `c`
    sel.setRows(['a', 'b']);
    expect([...sel.selected.get()]).toEqual(['a', 'c']);
    sel.setRows(['a', 'b', 'c']);
    expect(sel.isSelected('c')).toBe(true);
  });

  it('should put a key an app wrote that is no row back on one with settle()', () => {
    const sel = createListSelection<string>();
    sel.setRows(['a', 'b', 'c']);
    sel.move(1);

    sel.current.set('nope');

    expect(sel.settle()).toBe(true);
    expect(sel.current.get()).toBe('b');
  });

  it('should depend on nothing when a method is called inside an effect', () => {
    const sel = createListSelection<string>({ multiple: true });
    sel.setRows(['a', 'b']);
    let runs = 0;
    const dispose = createEffect(() => {
      runs++;
      sel.index();
      sel.isSelected('a');
    });

    sel.move(1);
    sel.toggle('a');
    flush();

    expect(runs).toBe(1);
    dispose();
  });

  it('should refuse a selected that is neither keys nor a State', () => {
    expect(() => createListSelection({ selected: 42 as never })).toThrow(
      'Expected list selected to be an iterable of keys or a State'
    );
  });
});

describe('ListView()', () => {
  it('should draw a pointer on the current row, and a mark on each row for a multiple list', () => {
    const single = list({ items: ['alpha', 'beta'] });
    expect(picture(single).slice(0, 2)).toEqual(['❯ alpha', '  beta']);

    const multiple = list({ items: ['alpha', 'beta'], multiple: true, selected: ['beta'] });
    expect(picture(multiple).slice(0, 2)).toEqual(['❯ ◯ alpha', '  ◉ beta']);
  });

  it('should draw with ASCII where asked', () => {
    const host = list({
      ascii: true,
      items: ['alpha', 'beta'],
      multiple: true,
      selected: ['beta'],
    });
    expect(picture(host).slice(0, 2)).toEqual(['> [ ] alpha', '  [x] beta']);
  });

  it('should build only the rows in view, so ten thousand cost what five do', () => {
    const host = list({ items: numbered(10_000) }, 5);

    expect(rowsOf(host)).toHaveLength(5);
    expect(every(host).length).toBeLessThan(60);
    expect(picture(host)[0]).toBe('❯ item 0');
  });

  it('should take a row function, a string or an element, and hand it the key', () => {
    const seen: unknown[] = [];
    const host = list({
      items: [
        { id: 7, name: 'seven' },
        { id: 8, name: 'eight' },
      ],
      key: (item) => item.id,
      row: (item, key) => {
        seen.push(key);
        return key === 7 ? `#${item.name}` : text(item.name.toUpperCase());
      },
    });

    expect(picture(host).slice(0, 2)).toEqual(['❯ #seven', '  EIGHT']);
    expect(seen).toEqual([7, 8]);
  });

  it('should draw a disabled row muted and keep the cursor off it', () => {
    const host = list({ disabled: (item) => item === 'a', items: ['a', 'b'] });

    expect(control(host).selection.current.get()).toBe('b');
    expect(rowWith(host, 'a').classes).toEqual(
      expect.arrayContaining(['is-disabled', 'sigil-muted'])
    );
    press(host, 'up');
    expect(control(host).selection.current.get()).toBe('b');
  });

  describe('keys', () => {
    it('should move on the arrows, a page on Page Up and Page Down, and to the ends on Home and End', () => {
      const host = list({ items: numbered(20) }, 5);
      const { selection } = control(host);

      expect(press(host, 'down')).toBe(true);
      expect(selection.current.get()).toBe('item 1');
      // a page is the view less one row, so a row of context survives the jump
      press(host, 'pagedown');
      expect(selection.current.get()).toBe('item 5');
      press(host, 'pageup');
      expect(selection.current.get()).toBe('item 1');
      press(host, 'end');
      expect(selection.current.get()).toBe('item 19');
      press(host, 'home');
      expect(selection.current.get()).toBe('item 0');
      press(host, 'up');
      expect(selection.current.get()).toBe('item 0');
    });

    it('should claim a move that goes nowhere, and leave every key alone when there are no rows', () => {
      const host = list({ items: ['a'] });
      expect(press(host, 'up')).toBe(true);
      expect(press(host, 'end')).toBe(true);

      const empty = list({ items: [] });
      expect(press(empty, 'down')).toBe(false);
      expect(press(empty, 'home')).toBe(false);
    });

    it('should leave a move with Shift, Ctrl or Alt, a paste, Tab and Escape to whatever is around it', () => {
      const host = list({ items: numbered(3) });

      expect(press(host, 'down', { shift: true })).toBe(false);
      expect(press(host, 'down', { ctrl: true })).toBe(false);
      expect(press(host, 'down', { meta: true })).toBe(false);
      expect(press(host, 'tab')).toBe(false);
      expect(press(host, 'escape')).toBe(false);
      const pasted = keyEvent('down', {}, true);
      host.onKey?.(pasted);
      expect(pasted.claimed()).toBe(false);
      expect(control(host).selection.current.get()).toBe('item 0');
    });

    it('should call onActivate with the key and the item on Enter, and leave Enter alone without one', () => {
      const seen: unknown[] = [];
      const host = list({
        items: [{ id: 'x', n: 1 }],
        key: (item) => item.id,
        onActivate: (key, item) => seen.push([key, item.n]),
      });
      expect(press(host, 'enter')).toBe(true);
      expect(seen).toEqual([['x', 1]]);

      const plain = list({ items: ['a'] });
      expect(press(plain, 'enter')).toBe(false);
    });

    it('should select the current row on Space and every row on Ctrl-A, in a multiple list only', () => {
      const host = list({ items: ['a', 'b', 'c'], multiple: true });
      const { selection } = control(host);

      expect(press(host, 'space')).toBe(true);
      press(host, 'down');
      press(host, 'space');
      expect([...selection.selected.get()]).toEqual(['a', 'b']);
      expect(picture(host).slice(0, 3)).toEqual(['  ◉ a', '❯ ◉ b', '  ◯ c']);
      expect(press(host, 'a', { ctrl: true })).toBe(true);
      expect([...selection.selected.get()].toSorted()).toEqual(['a', 'b', 'c']);
      press(host, 'a', { ctrl: true });
      expect(selection.selected.get().size).toBe(0);

      const single = list({ items: ['a'] });
      expect(press(single, 'space')).toBe(false);
      expect(press(single, 'a', { ctrl: true })).toBe(false);
    });

    it('should take j, k, g and G only where vim keys were asked for', () => {
      const plain = list({ items: numbered(5) });
      expect(press(plain, 'j')).toBe(false);

      const host = list({ items: numbered(5), vim: true });
      const { selection } = control(host);
      press(host, 'j');
      press(host, 'j');
      expect(selection.current.get()).toBe('item 2');
      press(host, 'k');
      expect(selection.current.get()).toBe('item 1');
      press(host, 'G');
      expect(selection.current.get()).toBe('item 4');
      press(host, 'g');
      expect(selection.current.get()).toBe('item 0');
      expect(press(host, 'x')).toBe(false);
    });

    it('should refuse type-to-find and vim keys together, since both want the letters', () => {
      expect(() => ListView({ find: true, items: [], vim: true })).toThrow(
        'A list takes type-to-find or vim keys, and not both'
      );
    });
  });

  describe('type-to-find', () => {
    let now = 0;
    beforeEach(() => {
      now = 10_000;
      vi.spyOn(Date, 'now').mockImplementation(() => now);
    });
    afterEach(() => {
      vi.restoreAllMocks();
    });

    const fruit = ['apple', 'apricot', 'banana', 'blueberry', 'cherry'];

    it('should take no letters unless asked', () => {
      const host = list({ items: fruit });
      expect(press(host, 'b')).toBe(false);
      expect(control(host).selection.current.get()).toBe('apple');
    });

    it('should move to the next row a typed prefix starts, and extend it while typing is quick', () => {
      const host = list({ find: true, items: fruit });
      const { selection } = control(host);

      expect(press(host, 'b')).toBe(true);
      expect(selection.current.get()).toBe('banana');
      now += 200;
      press(host, 'l');
      expect(selection.current.get()).toBe('blueberry');
      // a pause starts again
      now += 2000;
      press(host, 'a');
      expect(selection.current.get()).toBe('apple');
    });

    it('should step through the rows one letter begins when it is pressed again, and wrap', () => {
      const host = list({ find: true, items: fruit });
      const { selection } = control(host);

      press(host, 'a');
      expect(selection.current.get()).toBe('apricot');
      now += 100;
      press(host, 'a');
      expect(selection.current.get()).toBe('apple');
    });

    it('should claim a letter that finds nothing, and pass over disabled rows and items with no label', () => {
      const host = list({
        disabled: (item) => item === 'banana',
        find: true,
        items: fruit,
      });
      const { selection } = control(host);

      expect(press(host, 'z')).toBe(true);
      expect(selection.current.get()).toBe('apple');
      now += 5000;
      press(host, 'b');
      expect(selection.current.get()).toBe('blueberry');
    });

    it('should match the label it is given, whatever the items are', () => {
      const host = list({
        find: true,
        items: [{ name: 'Zed' }, { name: 'Yak' }],
        label: (item) => item.name,
      });
      press(host, 'y');
      expect(control<{ name: string }>(host).selection.current.get()?.name).toBe('Yak');
    });
  });

  describe('the mouse', () => {
    let now = 0;
    beforeEach(() => {
      now = 10_000;
      vi.spyOn(Date, 'now').mockImplementation(() => now);
    });
    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('should move the cursor to a clicked row, and ignore a disabled one', () => {
      const host = list({ disabled: (item) => item === 'c', items: ['a', 'b', 'c'] });
      const { selection } = control(host);

      const event = click();
      rowWith(host, 'b').onMouse?.(event);
      flush();
      expect(event.claimed()).toBe(true);
      expect(selection.current.get()).toBe('b');

      rowWith(host, 'c').onMouse?.(click());
      flush();
      expect(selection.current.get()).toBe('b');
    });

    it('should toggle a clicked row in a multiple list', () => {
      const host = list({ items: ['a', 'b'], multiple: true });
      const { selection } = control(host);

      rowWith(host, 'b').onMouse?.(click());
      flush();
      now += 1000;
      rowWith(host, 'a').onMouse?.(click());
      flush();

      expect([...selection.selected.get()]).toEqual(['b', 'a']);
      expect(selection.current.get()).toBe('a');
    });

    it('should activate on a double-click, which does not undo the toggle the first click made', () => {
      const seen: string[] = [];
      const host = list({ items: ['a', 'b'], multiple: true, onActivate: (key) => seen.push(key) });
      const { selection } = control(host);

      rowWith(host, 'b').onMouse?.(click());
      now += 150;
      rowWith(host, 'b').onMouse?.(click());
      flush();
      expect(seen).toEqual(['b']);
      expect([...selection.selected.get()]).toEqual(['b']);

      // two clicks further apart are two clicks
      now += 1000;
      rowWith(host, 'a').onMouse?.(click());
      now += 1000;
      rowWith(host, 'a').onMouse?.(click());
      flush();
      expect(seen).toEqual(['b']);
    });

    it('should take only the click, so the press still focuses the list', () => {
      const host = list({ items: ['a'] });
      const press_ = click('mousedown');
      rowWith(host, 'a').onMouse?.(press_);
      expect(press_.claimed()).toBe(false);
    });
  });

  describe('the empty state', () => {
    it('should show what it says when there are no items, and the rows when there are', () => {
      const items = new State<readonly string[]>([]);
      const host = list({ empty: 'No files', items });
      expect(picture(host)[0]).toBe('No files');

      items.set(['a']);
      flush();
      expect(picture(host)[0]).toBe('❯ a');
      items.set([]);
      flush();
      expect(picture(host)[0]).toBe('No files');
    });

    it('should say something by default, and build an element where it is given one', () => {
      expect(picture(list({ items: [] }))[0]).toBe('Nothing to show');
      expect(picture(list({ empty: () => text('— none —'), items: [] }))[0]).toBe('— none —');
    });
  });

  describe('data that changes', () => {
    it('should follow a State or a Computed of items, keeping the cursor and the selection on their keys', () => {
      const raw = new State([3, 1, 2]);
      const sorted = new Computed(() => raw.get().toSorted((a, b) => a - b));
      const host = list({ items: sorted, multiple: true, selected: [2] });
      const { selection } = control<number>(host);
      press(host, 'down');
      expect(selection.current.get()).toBe(2);

      raw.set([30, 2, 1, 3]);
      flush();

      expect(picture(host).slice(0, 4)).toEqual(['  ◯ 1', '❯ ◉ 2', '  ◯ 3', '  ◯ 30']);
    });

    it('should rebuild the row of an item that was replaced, and keep every other row', () => {
      const items = new State([
        { id: 'a', cpu: 1 },
        { id: 'b', cpu: 2 },
      ]);
      const host = list({
        items,
        key: (item) => item.id,
        row: (item) => `${item.id} ${item.cpu}%`,
      });
      const before = rowsOf(host);

      items.set([items.get()[0] as { id: string; cpu: number }, { id: 'b', cpu: 9 }]);
      flush();

      expect(picture(host).slice(0, 2)).toEqual(['❯ a 1%', '  b 9%']);
      const after = rowsOf(host);
      expect(after[0]).toBe(before[0]);
      expect(after[1]).not.toBe(before[1]);
    });

    it('should keep the rows that stayed in view when the items are re-sorted', () => {
      const items = new State(['a', 'b', 'c']);
      const host = list({ items });
      const a = rowWith(host, 'a');

      items.set(['c', 'b', 'a']);
      flush();
      picture(host);

      expect(rowWith(host, 'a')).toBe(a);
      expect(rowsOf(host).at(-1)).toBe(a);
    });

    it('should rebuild the rows in view with refresh(), for items changed in place', () => {
      const item = { label: 'old' };
      const host = list({ items: [item], key: () => 'only', row: (it) => it.label });

      item.label = 'new';
      picture(host);
      expect(picture(host)[0]).toBe('❯ old');
      control(host).refresh();
      expect(picture(host)[0]).toBe('❯ new');
    });

    it('should follow the cursor when it moves, and not when the data under it merely updates', () => {
      const items = new State(numbered(50));
      const host = list({ items }, 5);
      const viewport = control(host).scroll.viewport;

      press(host, 'end');
      picture(host);
      expect(viewport.scroll?.y).toBe(45);

      // the wheel scrolls the view without moving the cursor
      viewport.scrollTo(0, 10);
      items.set([...items.get()]);
      flush();
      picture(host);
      expect(viewport.scroll?.y).toBe(10);

      // a re-sort that moves the current row is a move, and is followed
      items.set(items.get().toReversed());
      flush();
      picture(host);
      expect(viewport.scroll?.y).toBe(0);
      expect(picture(host)[0]).toBe('❯ item 49');
    });

    it('should bring an offset past the end of a list that shrank back inside it', () => {
      const items = new State(numbered(50));
      const host = list({ items }, 5);
      press(host, 'end');
      picture(host);

      items.set(numbered(8));
      flush();
      picture(host);

      expect(control(host).scroll.viewport.scroll?.y).toBe(3);
      expect(picture(host).at(-1)).toBe('❯ item 7');
    });

    it('should bring a view scrolled past the end of a list that shrank back, where the cursor did not move', () => {
      const items = new State(numbered(50));
      const host = list({ items }, 5);
      const viewport = control(host).scroll.viewport;
      // the wheel took the view away from the cursor, which is still on the first row
      viewport.scrollTo(0, 40);
      picture(host);

      items.set(numbered(8));
      flush();

      expect(viewport.scroll?.y).toBe(3);
      expect(picture(host)).toEqual(['  item 3', '  item 4', '  item 5', '  item 6', '  item 7']);
    });

    it('should reveal a cursor that starts below the view once there is a layout to reveal it in', () => {
      const host = ListView({
        ascii: false,
        current: 'item 30',
        items: numbered(40),
        props: { height: 5 },
        scrollbar: false,
      });
      expect(picture(host).at(-1)).toBe('❯ item 30');
    });

    it('should dispose what a row started when the row leaves the view', () => {
      let alive = 0;
      const host = list(
        {
          items: numbered(100),
          row: (item) => {
            alive++;
            onCleanup(() => alive--);
            return item;
          },
        },
        5
      );
      expect(alive).toBe(5);

      press(host, 'end');
      picture(host);
      expect(alive).toBe(5);
      expect(rowsOf(host)).toHaveLength(5);
    });
  });

  describe('the focus', () => {
    it('should put the focus role across the current row while the list has the focus, and move it with the cursor', () => {
      const host = list({ items: ['a', 'b'] });

      expect(rowWith(host, 'a').classes).not.toContain('sigil-focus');
      host.onFocusChange?.(host, true);
      expect(rowWith(host, 'a').classes).toContain('sigil-focus');
      press(host, 'down');
      expect(rowWith(host, 'a').classes).not.toContain('sigil-focus');
      expect(rowWith(host, 'b').classes).toContain('sigil-focus');
      expect(rowWith(host, 'b').classes).toContain('is-current');

      host.onFocusChange?.(host, false);
      expect(rowWith(host, 'b').classes).not.toContain('sigil-focus');
      // the pointer stays: an unfocused pane still shows its selection
      expect(picture(host)[1]).toBe('❯ b');
    });
  });

  it('should refuse what it cannot use', () => {
    expect(() => ListView({ items: 'abc' as never })).toThrow(
      'Expected list items to be an array, a State or a Computed'
    );
    expect(() => ListView({ items: [], row: 'x' as never })).toThrow(
      'Expected list row to be a function'
    );
    expect(() => ListView({ empty: 3 as never, items: [] })).toThrow('Expected list empty');
    expect(() => ListView({ items: [], props: { onKey: () => {} } as never })).toThrow('onKey');
  });

  it('should hand nothing to listControl() for an element no list built', () => {
    expect(listControl(box())).toBeUndefined();
  });
});

describe('describeListView()', () => {
  /** A router that records what it was told. */
  function recorder(): { live: Array<[string, DescribeOptions]>; router: ListViewDescriber } {
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

  it('should describe only the keys a list claims, scoped to it', () => {
    const plain = ListView({ items: [] });
    const { live, router } = recorder();
    const off = describeListView(router, plain);
    expect(live.map(([keys]) => keys)).toEqual(['up', 'down', 'pageup', 'pagedown', 'home', 'end']);
    expect(live.every(([, opts]) => opts.scope === plain)).toBe(true);
    off();
    expect(live).toHaveLength(0);

    const full = ListView({ items: [], multiple: true, onActivate: () => {}, vim: true });
    describeListView(router, full);
    expect(live.map(([keys]) => keys)).toEqual(
      expect.arrayContaining(['j', 'k', 'space', 'ctrl+a', 'enter'])
    );
  });

  it('should refuse an element that is not a list', () => {
    expect(() => describeListView(recorder().router, box())).toThrow(
      'Expected an element that ListView() returned'
    );
  });
});

describe('a list under a real router', () => {
  /** Lays a tree out, which is what the ring reads `display` off and the hit test reads boxes off. */
  function lay(root: Element): void {
    resolveStyles(root);
    arrange(root, { height: 10, width: 40 });
  }

  /** A canvas at the top-left of the screen, which is all the router asks of one. */
  const surface = {
    height: 10,
    locate: async () => true,
    origin: { x: 0, y: 0 },
    toCanvas: (column: number, row: number) => ({ x: column - 1, y: row - 1 }),
    width: 40,
  };

  it('should be reached by Tab, as one stop, and move on the arrows', async () => {
    const term = createTestTerminal({ columns: 40, rows: 10 });
    const host = ListView({ items: numbered(30), props: { height: 5 } });
    const after = text('after', { focusable: true });
    const root = box({ 'flex-direction': 'column' }, host, after);
    renderToString(root, { width: 40 });
    lay(root);
    const input = createInput({ root, terminal: term.terminal });

    expect(input.focus.ring()).toEqual([host, after]);
    await term.press(KEYS.tab, KEYS.down, KEYS.down, KEYS.pageDown);
    flush();
    expect(input.focus.current.get()).toBe(host);
    // a page is the five-row view less one
    expect(control(host).selection.current.get()).toBe('item 6');
    await term.press(ctrl('a'));
    expect(control(host).selection.selected.get().size).toBe(0);
    input.stop();
  });

  it('should focus the list on a press and move the cursor on the click', async () => {
    const term = createTestTerminal({ columns: 40, rows: 10 });
    const host = ListView({ items: ['a', 'b', 'c'], props: { height: 5 } });
    const root = box({ 'flex-direction': 'column' }, host);
    renderToString(root, { width: 40 });
    lay(root);
    const input = createInput({ mouse: { surface }, root, terminal: term.terminal });

    // the second row of the screen is `b`
    await term.press(`${ESC}[<0;5;2M`, `${ESC}[<0;5;2m`);
    flush();

    expect(input.focus.current.get()).toBe(host);
    expect(control(host).selection.current.get()).toBe('b');
    input.stop();
  });

  it('should list its keys in a key-help footer while it has the focus', () => {
    const term = createTestTerminal({ columns: 80, rows: 10 });
    const host = ListView({ items: ['a'], multiple: true, onActivate: () => {} });
    const root = box({ 'flex-direction': 'column' }, host);
    lay(root);
    const input = createInput({ root, terminal: term.terminal });
    describeListView(input, host);
    const footer = keyHelp(input, { width: 80 });
    const line = () =>
      renderToString(footer, { cascade: themedCascade(), colorLevel: 0, width: 80 }).trimEnd();

    expect(line()).not.toContain('move');
    input.focus.focus(host);
    flush();
    expect(line()).toContain('↑/↓ move');
    expect(line()).toContain('space select');
    expect(line()).toContain('enter open');
    input.stop();
  });
});
