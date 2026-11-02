import { strip } from '../../src/ansi/index.js';
import { keyHelp } from '../../src/components/key-help.js';
import type { Key } from '../../src/components/keys.js';
import {
  describeTabs,
  type Tab,
  type TabsDescriber,
  Tabs,
  tabRowView,
  tabsActive,
} from '../../src/components/tabs.js';
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
import type { MouseButton, MouseEventKind } from '../../src/input/mouse.js';
import { flush, State } from '../../src/signals/index.js';
import { createTerminal, type Terminal } from '../../src/terminal/index.js';
import { themedCascade } from '../../src/theme/index.js';
import { stringWidth } from '../../src/width/index.js';
import { describe, expect, it } from 'vitest';

/**
 * Tabs: the row, the panels, the keys, the click and the overflow.
 *
 * Most of it is driven through the handlers the router would call, for the
 * reason `scroll-box.test.ts` gives; the last block goes through a real router,
 * because whether Tab reaches the row and skips a hidden panel is a question
 * about the ring rather than about the component.
 */

const ESC = String.fromCharCode(0x1b);

/** The tabs as they would be drawn, with colour taken off and the right edge trimmed. */
function picture(host: Element, width = 40): string[] {
  return renderToLines(host, { cascade: themedCascade(), colorLevel: 0, width }).map((line) =>
    strip(line).trimEnd()
  );
}

/** The row inside tabs, or the row itself: what is focused and what the handlers hang off. */
function rowOf(host: Element): Element {
  if (host.classes.includes('sigil-tabs-row')) {
    return host;
  }
  const found = host.children.find((child) => child.classes.includes('sigil-tabs-row'));
  if (!found) {
    throw new Error('no row');
  }
  return found;
}

/** The label of the nth tab, which is what a click lands on. */
function labelOf(host: Element, n: number): Element {
  const labels = rowOf(host).children[0]?.children.filter((child) =>
    child.classes.includes('sigil-tabs-tab')
  );
  const found = labels?.[n];
  if (!found) {
    throw new Error(`no label ${n}`);
  }
  return found;
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

/** A mouse event as the router builds one. */
function mouseEvent(
  kind: MouseEventKind,
  button: MouseButton | undefined = 'left'
): MouseEvent & { claimed: () => boolean } {
  let stopped = false;
  return {
    button,
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
    wheel: kind === 'wheel' ? 'down' : undefined,
    x: 0,
    y: 0,
  };
}

/** Presses a key on the row, then lets the effects that draw it run. */
function press(host: Element, name: string, mods: Parameters<typeof keyEvent>[1] = {}): boolean {
  const event = keyEvent(name, mods);
  rowOf(host).onKey?.(event);
  flush();
  return event.claimed();
}

/** Three tabs, each over a one-line panel. */
function tabs(
  active?: number | State<number>,
  extra: Partial<Parameters<typeof Tabs>[0]> = {}
): Element {
  return Tabs({
    active,
    ascii: false,
    tabs: [
      { children: () => text('the logs'), label: 'Logs' },
      { children: () => text('the settings'), label: 'Settings' },
      { children: () => text('the summary'), label: 'Summary' },
    ],
    ...extra,
  });
}

describe('Tabs', () => {
  it('should draw the labels, a rule with the active stretch heavy, and the active panel', () => {
    expect(picture(tabs())).toEqual([
      ' Logs  Settings  Summary',
      '━━━━━━──────────────────────────────────',
      'the logs',
    ]);
    expect(picture(tabs(1))[1]).toBe(`${'─'.repeat(6)}${'━'.repeat(10)}${'─'.repeat(24)}`);
    expect(picture(tabs(1))[2]).toBe('the settings');
  });

  it('should draw the row with ASCII only when asked to', () => {
    expect(picture(tabs(0, { ascii: true }), 30).slice(0, 2)).toEqual([
      ' Logs  Settings  Summary',
      '======------------------------',
    ]);
  });

  it('should lay a label out by its display width, not its length', () => {
    const host = Tabs({
      active: 1,
      ascii: false,
      tabs: [{ label: 'ab' }, { label: '日本語' }, { label: 'cd' }],
    });
    // the wide label is six columns and two spaces, so the heavy stretch is eight
    expect(picture(host, 20).slice(0, 2)).toEqual([' ab  日本語  cd', '────━━━━━━━━────────']);
    expect(stringWidth('日本語')).toBe(6);
  });

  it('should take escape sequences and line breaks out of a label', () => {
    const host = Tabs({
      ascii: false,
      tabs: [{ label: `${ESC}[31mred\nline${ESC}[0m` }],
    });
    expect(picture(host, 20)[0]).toBe(' red line');
  });

  it('should show the active label in the accent and bold, and the rest muted', () => {
    const host = tabs(1);
    const classes = [0, 1, 2].map((i) => labelOf(host, i).classes);
    expect(classes[1]).toEqual(
      expect.arrayContaining(['sigil-tabs-active', 'sigil-accent', 'sigil-heading'])
    );
    expect(classes[1]).not.toContain('sigil-muted');
    for (const i of [0, 2]) {
      expect(classes[i]).toContain('sigil-muted');
      expect(classes[i]).not.toContain('sigil-accent');
    }
    const out = renderToString(host, { cascade: themedCascade(), colorLevel: 1, width: 30 });
    // the active label is bold cyan; the inactive ones are dim
    expect(out).toContain(`${ESC}[22;1;36mSettings`);
  });

  it('should invert the active label while the row has the focus', () => {
    const host = tabs(1);
    rowOf(host).setState('focus');
    const out = renderToString(host, { cascade: themedCascade(), colorLevel: 1, width: 30 });
    expect(out).toContain(`;1;7;36m Settings `);
    rowOf(host).setState('focus', false);
    expect(
      renderToString(host, { cascade: themedCascade(), colorLevel: 1, width: 30 })
    ).not.toContain(';7;');
  });

  it('should keep the host class and add its own', () => {
    const host = tabs(0, { props: { class: 'mine' } });
    expect(host.classes).toEqual(['mine', 'sigil-tabs']);
  });

  it('should make the row focusable and nothing else', () => {
    const host = tabs();
    expect(host.focusable).toBe(false);
    expect(rowOf(host).focusable).toBe(true);
    expect(labelOf(host, 0).focusable).toBe(false);
  });

  it('should read an active past either end as the nearest tab in the row as well', () => {
    const labels = ['aa', 'bb', 'cc'];
    const heavy = (active: number) =>
      picture(tabRowView({ active, ascii: false, labels }), 12)[1]?.indexOf('━');
    expect(heavy(9)).toBe(8);
    expect(heavy(-4)).toBe(0);
    expect(heavy(Number.NaN)).toBe(0);
    expect(heavy(1.9)).toBe(4);
  });

  it('should read an active past either end as the nearest tab', () => {
    expect(picture(tabs(9))[2]).toBe('the summary');
    expect(picture(tabs(-4))[2]).toBe('the logs');
    expect(picture(tabs(Number.NaN))[2]).toBe('the logs');
  });

  it('should draw a tab with no panel as a label only', () => {
    const host = Tabs({ ascii: false, tabs: [{ label: 'a' }, { label: 'b' }] });
    expect(picture(host, 10)).toEqual([' a  b', '━━━───────']);
  });

  it('should refuse tabs that are not a list with something in it', () => {
    expect(() => Tabs({ tabs: [] })).toThrow('Expected tabs to be a non-empty array');
    expect(() => Tabs({ tabs: 'x' as unknown as Tab[] })).toThrow(
      'Expected tabs to be a non-empty array'
    );
  });

  it('should refuse a tab without a string label', () => {
    expect(() => Tabs({ tabs: [{ label: 3 as unknown as string }] })).toThrow(
      'Expected every tab to have a label that is a string'
    );
  });

  it('should refuse children that are not a builder', () => {
    expect(() =>
      Tabs({ tabs: [{ children: text('x') as unknown as () => Element, label: 'x' }] })
    ).toThrow('Expected tab children to be a function');
  });

  it('should refuse an active that is neither a number nor a State', () => {
    expect(() => Tabs({ active: '1' as unknown as number, tabs: [{ label: 'x' }] })).toThrow(
      'Expected tabs active to be a number or a State'
    );
  });

  it('should refuse a row with no labels', () => {
    expect(() => tabRowView({ labels: [] })).toThrow('Expected tab labels to be a non-empty array');
    expect(() => tabRowView({ labels: [1 as unknown as string] })).toThrow(
      'Expected tab labels to be a non-empty array'
    );
  });
});

describe('the panels', () => {
  it('should lay out only the active panel', () => {
    const host = tabs(1);
    resolveStyles(host);
    arrange(host, { height: 10, width: 40 });
    const panels = host.children[1]?.children ?? [];
    expect(panels.map((p) => (p.box?.height ?? 0) > 0)).toEqual([false, true, false]);
    expect(panels.map((p) => p.classes.includes('is-active'))).toEqual([false, true, false]);
    expect(picture(host).filter((l) => l.startsWith('the '))).toEqual(['the settings']);
  });

  it('should build every panel once, and keep it while another shows', () => {
    const built: string[] = [];
    const host = Tabs({
      tabs: ['a', 'b'].map((label) => ({
        children: () => {
          built.push(label);
          return text(label);
        },
        label,
      })),
    });
    const panel = host.children[1]?.children[0];
    press(host, 'right');
    press(host, 'left');
    press(host, 'right');
    expect(built).toEqual(['a', 'b']);
    expect(host.children[1]?.children[0]).toBe(panel);
  });
});

describe('the keys on the row', () => {
  it('should move to the next tab with Right and the previous with Left', () => {
    const host = tabs();
    expect(press(host, 'right')).toBe(true);
    expect(picture(host)[2]).toBe('the settings');
    expect(press(host, 'right')).toBe(true);
    expect(picture(host)[2]).toBe('the summary');
    expect(press(host, 'left')).toBe(true);
    expect(picture(host)[2]).toBe('the settings');
  });

  it('should leave an arrow that would change nothing to the pane around the row', () => {
    const host = tabs(0);
    expect(press(host, 'left')).toBe(false);
    const last = tabs(2);
    expect(press(last, 'right')).toBe(false);
    expect(picture(last)[2]).toBe('the summary');
  });

  it('should go to the first tab with Home and the last with End', () => {
    const host = tabs(1);
    expect(press(host, 'end')).toBe(true);
    expect(picture(host)[2]).toBe('the summary');
    expect(press(host, 'end')).toBe(false);
    expect(press(host, 'home')).toBe(true);
    expect(picture(host)[2]).toBe('the logs');
    expect(press(host, 'home')).toBe(false);
  });

  it('should go to the nth tab with a number key', () => {
    const host = tabs();
    expect(press(host, '3')).toBe(true);
    expect(picture(host)[2]).toBe('the summary');
    expect(press(host, '1')).toBe(true);
    expect(picture(host)[2]).toBe('the logs');
  });

  it('should claim a number for the tab it is already on, and leave one with no tab behind it', () => {
    const host = tabs(0);
    expect(press(host, '1')).toBe(true);
    expect(press(host, '4')).toBe(false);
    expect(press(host, '9')).toBe(false);
    expect(press(host, '0')).toBe(false);
    expect(picture(host)[2]).toBe('the logs');
  });

  it('should leave Up, Down, Tab, Enter and letters alone', () => {
    const host = tabs(1);
    for (const name of ['up', 'down', 'tab', 'enter', 'space', 'escape', 'a']) {
      expect(press(host, name)).toBe(false);
    }
    expect(picture(host)[2]).toBe('the settings');
  });

  it('should leave a key with a modifier alone', () => {
    const host = tabs(1);
    expect(press(host, 'right', { ctrl: true })).toBe(false);
    expect(press(host, 'left', { meta: true })).toBe(false);
    expect(press(host, 'end', { shift: true })).toBe(false);
    expect(press(host, '3', { ctrl: true })).toBe(false);
    expect(picture(host)[2]).toBe('the settings');
  });

  it('should not read a paste as a keystroke', () => {
    const host = tabs(0);
    const event = keyEvent('right', {}, true);
    rowOf(host).onKey?.(event);
    flush();
    expect(event.claimed()).toBe(false);
    expect(picture(host)[2]).toBe('the logs');
  });

  it('should not put the handler on the host, where a key typed into a panel would reach it', () => {
    expect(tabs().onKey).toBeUndefined();
  });
});

describe('the mouse on a label', () => {
  it('should pick the tab on a left click, and claim the click', () => {
    const host = tabs();
    const click = mouseEvent('click');
    labelOf(host, 2).onMouse?.(click);
    flush();
    expect(click.claimed()).toBe(true);
    expect(picture(host)[2]).toBe('the summary');
  });

  it('should leave the press alone, so the press can focus the row', () => {
    const host = tabs();
    const down = mouseEvent('mousedown');
    labelOf(host, 1).onMouse?.(down);
    flush();
    expect(down.claimed()).toBe(false);
    expect(picture(host)[2]).toBe('the logs');
  });

  it('should leave a right click and the wheel alone', () => {
    const host = tabs();
    const right = mouseEvent('click', 'right');
    const wheel = mouseEvent('wheel', undefined);
    labelOf(host, 1).onMouse?.(right);
    labelOf(host, 1).onMouse?.(wheel);
    flush();
    expect(right.claimed()).toBe(false);
    expect(wheel.claimed()).toBe(false);
    expect(picture(host)[2]).toBe('the logs');
  });
});

describe('the active tab as a State', () => {
  it('should write the state when a key or a click picks a tab', () => {
    const active = new State(0);
    const host = tabs(active);
    press(host, 'right');
    expect(active.get()).toBe(1);
    labelOf(host, 2).onMouse?.(mouseEvent('click'));
    expect(active.get()).toBe(2);
  });

  it('should switch the tab, the rule and the panel when the app writes the state', () => {
    const active = new State(0);
    const host = tabs(active);
    active.set(2);
    flush();
    expect(picture(host)).toEqual([
      ' Logs  Settings  Summary',
      `${'─'.repeat(16)}${'━'.repeat(9)}${'─'.repeat(15)}`,
      'the summary',
    ]);
  });

  it('should hand back the state it made when it was given a number', () => {
    const host = tabs(1);
    const active = tabsActive(host);
    expect(active.get()).toBe(1);
    active.set(0);
    flush();
    expect(picture(host)[2]).toBe('the logs');
    press(host, 'end');
    expect(active.get()).toBe(2);
  });

  it('should hand back the state it was given', () => {
    const active = new State(1);
    expect(tabsActive(tabs(active))).toBe(active);
  });

  it('should refuse an element that is not tabs', () => {
    expect(() => tabsActive(box())).toThrow('Expected an element that Tabs() or tabRowView()');
  });
});

describe('a row that does not fit', () => {
  const names = ['Overview', 'Logs', 'Settings', 'Network', 'Summary'];

  /** The row alone, over five labels that come to 46 columns. */
  function row(active: number | State<number>, width: number): string[] {
    return picture(tabRowView({ active, ascii: false, labels: names }), width).slice(0, 2);
  }

  it('should draw every label and no indicator where they fit', () => {
    const [labels] = row(0, 60);
    expect(labels).toBe(' Overview  Logs  Settings  Network  Summary');
    expect(labels).not.toMatch(/[‹›]/);
  });

  it('should clip on the right and say so while the active tab is at the start', () => {
    const [labels, rule] = row(0, 30);
    expect(labels).toBe('  Overview  Logs  Settings   ›');
    expect(rule).toBe(`─${'━'.repeat(10)}${'─'.repeat(19)}`);
  });

  it('should scroll to bring the active tab into view, and say so on both sides', () => {
    const [labels, rule] = row(2, 22);
    expect(labels).toMatch(/^‹/);
    expect(labels).toMatch(/›$/);
    expect(labels).toContain(' Settings ');
    expect(stringWidth(rule ?? '')).toBe(22);
    // the heavy stretch sits under the label it belongs to
    const at = (labels ?? '').indexOf(' Settings ');
    expect((rule ?? '').slice(at, at + 10)).toBe('━'.repeat(10));
  });

  it('should clip on the left alone at the end', () => {
    const [labels] = row(4, 30);
    expect(labels).toMatch(/^‹/);
    expect(labels).not.toMatch(/›/);
    expect(labels).toMatch(/ Summary$/);
    expect(stringWidth(labels ?? '')).toBeLessThanOrEqual(30);
  });

  it('should fill the room it has rather than leave a gap after the last tab', () => {
    const [labels] = row(4, 36);
    // nothing more is hidden on the right, so everything that fits is shown
    expect(labels).toBe('‹ Logs  Settings  Network  Summary');
  });

  it('should keep the active tab in view while the keys walk the whole row', () => {
    const host = tabRowView({ ascii: false, labels: names });
    const seen: string[] = [];
    for (let i = 0; i < names.length; i++) {
      const [labels] = picture(host, 24);
      seen.push(labels?.includes(` ${names[i]}`) ? 'in' : `OUT:${labels}`);
      press(host, 'right');
    }
    expect(seen).toEqual(['in', 'in', 'in', 'in', 'in']);
    for (let i = names.length - 1; i >= 0; i--) {
      const [labels] = picture(host, 24);
      expect(labels).toContain(` ${names[i]}`);
      press(host, 'left');
    }
  });

  it('should use the room it is given to show more tabs on the left when the row grows', () => {
    const host = tabRowView({ active: 4, ascii: false, labels: names });
    expect(picture(host, 22)[0]).toMatch(/^‹ Network {2}Summary/);
    expect(picture(host, 36)[0]).toBe('‹ Logs  Settings  Network  Summary');
  });

  it('should move the row only when the active tab leaves it', () => {
    const host = tabRowView({ ascii: false, labels: names });
    press(host, 'end');
    const atEnd = picture(host, 24)[0];
    press(host, 'left');
    // the previous tab was already on screen, so nothing slid
    expect(picture(host, 24)[0]).toBe(atEnd);
  });

  it('should draw the indicators with ASCII when asked to', () => {
    const [labels] = picture(tabRowView({ active: 2, ascii: true, labels: names }), 22);
    expect(labels).toMatch(/^</);
    expect(labels).toMatch(/>$/);
  });

  it('should cut a label that is wider than the row, with an ellipsis', () => {
    const [labels, rule] = picture(
      tabRowView({ ascii: false, labels: ['A very long label indeed', 'b'] }),
      12
    );
    expect(labels).toBe('  A very … ›');
    expect(stringWidth(rule ?? '')).toBe(12);
  });

  it('should measure a wide character by its width when it decides what fits', () => {
    const [labels] = picture(
      tabRowView({ active: 1, ascii: false, labels: ['日本語', '日本語', '日本語'] }),
      14
    );
    expect(stringWidth(labels ?? '')).toBeLessThanOrEqual(14);
    expect(labels).toContain(' 日本語 ');
  });

  it('should show everything again when it is given room', () => {
    const host = tabRowView({ active: 3, ascii: false, labels: names });
    expect(picture(host, 22)[0]).toMatch(/‹/);
    expect(picture(host, 60)[0]).toBe(' Overview  Logs  Settings  Network  Summary');
  });

  it('should leave the panels alone when the row scrolls', () => {
    const host = Tabs({
      active: 4,
      ascii: false,
      tabs: names.map((label) => ({ children: () => text(`${label} panel`), label })),
    });
    expect(picture(host, 22)[2]).toBe('Summary panel');
  });
});

describe('describeTabs', () => {
  /** A router that records what it was told. */
  function recorder() {
    const live: Array<{ keys: string; opts: DescribeOptions }> = [];
    const router: TabsDescriber = {
      describe(keys, opts) {
        const entry = { keys, opts };
        live.push(entry);
        return () => void live.splice(live.indexOf(entry), 1);
      },
    };
    return { live, router };
  }

  it('should describe the four keys, scoped to the row', () => {
    const { live, router } = recorder();
    const host = tabs();
    describeTabs(router, host);
    expect(live.map((e) => `${e.keys} ${e.opts.description}`)).toEqual([
      'left previous tab',
      'right next tab',
      'home first tab',
      'end last tab',
    ]);
    expect(live.every((e) => e.opts.scope === rowOf(host))).toBe(true);
  });

  it('should take a row on its own as well as tabs', () => {
    const { live, router } = recorder();
    const row = tabRowView({ labels: ['a'] });
    describeTabs(router, row);
    expect(live.every((e) => e.opts.scope === row)).toBe(true);
  });

  it('should take every description back off', () => {
    const { live, router } = recorder();
    const off = describeTabs(router, tabs(), tabs());
    expect(live).toHaveLength(8);
    off();
    expect(live).toHaveLength(0);
  });

  it('should refuse an element that is not tabs', () => {
    expect(() => describeTabs(recorder().router, box())).toThrow(
      'Expected an element that Tabs() or tabRowView()'
    );
  });
});

interface Harness {
  feed: (chunk: string) => void;
  terminal: Terminal;
}

/** A terminal whose stdin is a TTY nothing is typing on, as `mouse-router.test.ts` builds one. */
function harness(): Harness {
  const listeners = new Map<string, Set<(...args: unknown[]) => void>>();
  const stdin = {
    isTTY: true,
    off(event: string, fn: (...args: unknown[]) => void) {
      listeners.get(event)?.delete(fn);
      return this;
    },
    on(event: string, fn: (...args: unknown[]) => void) {
      let set = listeners.get(event);
      if (!set) {
        set = new Set();
        listeners.set(event, set);
      }
      set.add(fn);
      return this;
    },
    pause() {
      return this;
    },
    resume() {
      return this;
    },
    setEncoding() {
      return this;
    },
    setRawMode() {
      return this;
    },
  };
  const terminal = createTerminal({
    env: {},
    isTTY: true,
    proc: { on() {}, pid: 1, removeListener() {} } as never,
    stderr: { isTTY: true, write: () => true } as never,
    stdin: stdin as never,
    stdout: { isTTY: true, write: () => true } as never,
  });
  return {
    feed(chunk: string) {
      for (const fn of listeners.get('data') ?? []) {
        fn(chunk);
      }
    },
    terminal,
  };
}

/** A canvas at the top-left of the screen, which is all the router asks of one. */
const surface = {
  height: 10,
  locate: async () => true,
  origin: { x: 0, y: 0 },
  toCanvas: (column: number, row: number) => ({ x: column - 1, y: row - 1 }),
  width: 40,
};

/** Lays a tree out, which is what the ring reads `display` off and the hit test reads boxes off. */
function lay(root: Element): void {
  resolveStyles(root);
  arrange(root, { height: 10, width: 40 });
}

describe('tabs under a real router', () => {
  it('should be reached by Tab, skip a hidden panel, and switch on a number key', () => {
    const { feed, terminal } = harness();
    const one = text('one', { focusable: true, id: 'one' });
    const two = text('two', { focusable: true, id: 'two' });
    const host = Tabs({
      ascii: false,
      tabs: [
        { children: () => one, label: 'A' },
        { children: () => two, label: 'B' },
      ],
    });
    const root = box({ 'flex-direction': 'column' }, host);
    lay(root);
    const input = createInput({ root, terminal });

    expect(input.focus.ring()).toEqual([rowOf(host), one]);
    feed('\t');
    expect(input.focus.current.get()).toBe(rowOf(host));
    feed('2');
    flush();
    lay(root);
    expect(input.focus.ring()).toEqual([rowOf(host), two]);
    expect(input.focus.current.get()).toBe(rowOf(host));
    input.stop();
  });

  it('should move on the arrows once the row is focused', () => {
    const { feed, terminal } = harness();
    const host = tabs();
    const root = box({ 'flex-direction': 'column' }, host);
    lay(root);
    const input = createInput({ root, terminal });
    feed('\t');
    feed(`${ESC}[C`);
    feed(`${ESC}[C`);
    flush();
    expect(picture(host)[2]).toBe('the summary');
    feed(`${ESC}[H`);
    flush();
    expect(picture(host)[2]).toBe('the logs');
    input.stop();
  });

  it('should focus the row on a press and switch tab on the click', () => {
    const { feed, terminal } = harness();
    const host = tabs();
    const root = box({ 'flex-direction': 'column' }, host);
    lay(root);
    const input = createInput({ mouse: { surface }, root, terminal });

    // ` Logs ` is columns 0..5 and ` Settings ` columns 6..15: screen column 9, row 1
    feed(`${ESC}[<0;9;1M`);
    feed(`${ESC}[<0;9;1m`);
    flush();

    expect(input.focus.current.get()).toBe(rowOf(host));
    expect(picture(host)[2]).toBe('the settings');
    input.stop();
  });

  it('should list its keys in a key-help footer while the row is focused', () => {
    const { terminal } = harness();
    const host = tabs();
    const root = box({ 'flex-direction': 'column' }, host);
    lay(root);
    const input = createInput({ root, terminal });
    describeTabs(input, host);
    const footer = keyHelp(input, { width: 80 });

    const line = () =>
      renderToString(footer, { cascade: themedCascade(), colorLevel: 0, width: 80 }).trimEnd();

    expect(line()).toBe('');
    input.focus.focus(rowOf(host));
    flush();
    expect(line()).toBe('← previous tab · → next tab · home first tab · end last tab');
    input.stop();
  });
});
