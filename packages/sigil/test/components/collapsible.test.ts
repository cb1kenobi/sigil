import { strip } from '../../src/ansi/index.js';
import {
  Collapsible,
  type CollapsibleDescriber,
  collapsibleGroup,
  describeCollapsible,
} from '../../src/components/collapsible.js';
import { keyHelp } from '../../src/components/key-help.js';
import type { Key } from '../../src/components/keys.js';
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
import { createRoot } from '../../src/renderer/index.js';
import { flush, State } from '../../src/signals/index.js';
import { createTerminal, type Terminal } from '../../src/terminal/index.js';
import { themedCascade } from '../../src/theme/index.js';
import { describe, expect, it } from 'vitest';

/**
 * A collapsible: the title, the body, the keys, the click and the group.
 *
 * Most of it is driven through the handlers the router would call, for the
 * reason `scroll-box.test.ts` gives; the last block goes through a real router,
 * because whether Tab reaches the title and skips a closed body is a question
 * about the ring rather than about the component.
 */

const ESC = String.fromCharCode(0x1b);

/** The section as it would be drawn, with colour taken off and the right edge trimmed. */
function picture(host: Element, width = 24): string[] {
  return renderToLines(host, { cascade: themedCascade(), colorLevel: 0, width }).map((line) =>
    strip(line).trimEnd()
  );
}

/** The title inside a section, which is what is focused and what the handlers hang off. */
function titleOf(host: Element): Element {
  const found = host.children.find((child) => child.classes.includes('sigil-collapsible-title'));
  if (!found) {
    throw new Error('no title');
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

/** Presses a key on a section's title, then lets the effect that draws it run. */
function press(host: Element, name: string, mods: Parameters<typeof keyEvent>[1] = {}): boolean {
  const event = keyEvent(name, mods);
  titleOf(host).onKey?.(event);
  flush();
  return event.claimed();
}

/** A section over two lines of detail. */
function section(
  open?: boolean | State<boolean>,
  extra: Partial<Parameters<typeof Collapsible>[0]> = {}
): Element {
  return Collapsible({
    ascii: false,
    children: () =>
      box({ 'flex-direction': 'column' }, text('at a (a.js:1)'), text('at b (b.js:2)')),
    open,
    title: 'Show stack',
    ...extra,
  });
}

describe('Collapsible', () => {
  it('should draw only the title while closed', () => {
    expect(picture(section())).toEqual(['▸ Show stack']);
  });

  it('should draw the body under the title, indented past the marker, while open', () => {
    expect(picture(section(true))).toEqual(['▾ Show stack', '  at a (a.js:1)', '  at b (b.js:2)']);
  });

  it('should draw the marker in ASCII when asked to', () => {
    expect(picture(section(false, { ascii: true }))).toEqual(['> Show stack']);
    expect(picture(section(true, { ascii: true }))[0]).toBe('v Show stack');
  });

  it('should hang a wrapped title under its own text rather than under the marker', () => {
    const host = Collapsible({ ascii: false, title: 'Advanced options for the build' });
    expect(picture(host, 16)).toEqual(['▸ Advanced', '  options for', '  the build']);
  });

  it('should keep the host class and add an is-open state class', () => {
    const host = section(true, { props: { class: 'mine' } });
    expect(host.classes).toEqual(['mine', 'sigil-collapsible', 'is-open']);
    press(host, 'enter');
    expect(host.classes).toEqual(['mine', 'sigil-collapsible']);
  });

  it('should build the body once and keep it while closed', () => {
    let built = 0;
    const host = Collapsible({
      children: () => {
        built++;
        return text('body');
      },
      title: 'x',
    });
    const body = host.children[1];
    press(host, 'enter');
    press(host, 'enter');
    press(host, 'enter');
    expect(built).toBe(1);
    expect(host.children[1]).toBe(body);
  });

  it('should take no body at all', () => {
    const host = Collapsible({ ascii: false, open: true, title: 'Nothing here' });
    expect(picture(host)).toEqual(['▾ Nothing here']);
  });

  it('should make the title focusable and nothing else', () => {
    const host = section(true);
    expect(host.focusable).toBe(false);
    expect(titleOf(host).focusable).toBe(true);
  });

  it('should show the focus on the title by inverting it', () => {
    const host = section();
    titleOf(host).setState('focus');
    const out = renderToString(host, { cascade: themedCascade(), colorLevel: 1, width: 24 });
    // the marker and the title, each inverted; the margin between them is a cell
    // nothing paints, which is what a margin is
    expect(out).toBe(`${ESC}[7;36m▸${ESC}[27;39m ${ESC}[7mShow stack${ESC}[0m`);
  });

  it('should refuse a title that is not a string', () => {
    expect(() => Collapsible({ title: 42 as unknown as string })).toThrow(
      'Expected a collapsible title to be a string'
    );
  });

  it('should refuse an open that is neither a boolean nor a State', () => {
    expect(() => Collapsible({ open: 'yes' as unknown as boolean, title: 'x' })).toThrow(
      'Expected collapsible open to be a boolean or a State'
    );
  });

  it('should refuse children that are not a builder', () => {
    expect(() =>
      Collapsible({ children: text('x') as unknown as () => Element, title: 'x' })
    ).toThrow('Expected collapsible children to be a function');
  });

  it('should refuse a group that collapsibleGroup() did not make', () => {
    expect(() => Collapsible({ group: { closeAll() {} }, title: 'x' })).toThrow(
      'Expected collapsible group to come from collapsibleGroup()'
    );
  });
});

describe('the keys on a collapsible title', () => {
  it('should flip it with Enter', () => {
    const host = section();
    expect(press(host, 'enter')).toBe(true);
    expect(picture(host)[0]).toBe('▾ Show stack');
    expect(press(host, 'enter')).toBe(true);
    expect(picture(host)).toEqual(['▸ Show stack']);
  });

  it('should flip it with Space', () => {
    const host = section();
    expect(press(host, 'space')).toBe(true);
    expect(picture(host)).toHaveLength(3);
  });

  it('should open it with Right and close it with Left', () => {
    const host = section();
    expect(press(host, 'right')).toBe(true);
    expect(picture(host)).toHaveLength(3);
    expect(press(host, 'left')).toBe(true);
    expect(picture(host)).toHaveLength(1);
  });

  it('should let an arrow that would change nothing reach the pane around it', () => {
    const closed = section(false);
    expect(press(closed, 'left')).toBe(false);
    const open = section(true);
    expect(press(open, 'right')).toBe(false);
  });

  it('should leave Up, Down and Tab alone', () => {
    const host = section();
    for (const name of ['up', 'down', 'tab', 'home', 'escape']) {
      expect(press(host, name)).toBe(false);
    }
    expect(picture(host)).toHaveLength(1);
  });

  it('should leave a key with a modifier alone', () => {
    const host = section();
    expect(press(host, 'enter', { ctrl: true })).toBe(false);
    expect(press(host, 'space', { meta: true })).toBe(false);
    expect(press(host, 'right', { shift: true })).toBe(false);
    expect(picture(host)).toHaveLength(1);
  });

  it('should not read a pasted newline as an Enter', () => {
    const host = section();
    const event = keyEvent('enter', {}, true);
    titleOf(host).onKey?.(event);
    flush();
    expect(event.claimed()).toBe(false);
    expect(picture(host)).toHaveLength(1);
  });

  it('should not toggle on a key typed into something focused inside the body', () => {
    const host = section(true);
    // a key reaches the focused element and then its ancestors: the host, never
    // the title beside it
    expect(host.onKey).toBeUndefined();
  });
});

describe('the mouse on a collapsible title', () => {
  it('should flip it on a left click, and claim the click', () => {
    const host = section();
    const click = mouseEvent('click');
    titleOf(host).onMouse?.(click);
    flush();
    expect(click.claimed()).toBe(true);
    expect(picture(host)).toHaveLength(3);
  });

  it('should leave the press alone, so the press can focus the title', () => {
    const host = section();
    const down = mouseEvent('mousedown');
    titleOf(host).onMouse?.(down);
    flush();
    expect(down.claimed()).toBe(false);
    expect(picture(host)).toHaveLength(1);
  });

  it('should leave a right click and the wheel alone', () => {
    const host = section();
    const right = mouseEvent('click', 'right');
    const wheel = mouseEvent('wheel', undefined);
    titleOf(host).onMouse?.(right);
    titleOf(host).onMouse?.(wheel);
    flush();
    expect(right.claimed()).toBe(false);
    expect(wheel.claimed()).toBe(false);
    expect(picture(host)).toHaveLength(1);
  });
});

describe('a collapsible over a State', () => {
  it('should write the state when a key flips it', () => {
    const open = new State(false);
    const host = section(open);
    press(host, 'enter');
    expect(open.get()).toBe(true);
  });

  it('should open and close when the app writes the state', () => {
    const open = new State(false);
    const host = section(open);
    open.set(true);
    flush();
    expect(picture(host)).toHaveLength(3);
    open.set(false);
    flush();
    expect(picture(host)).toHaveLength(1);
  });
});

describe('an exclusive group', () => {
  /** Three members of one group, each over its own state. */
  function accordion(first = false) {
    const group = collapsibleGroup();
    const states = [new State(first), new State(false), new State(false)];
    const hosts = states.map((open, i) =>
      Collapsible({ children: () => text(`body ${i}`), group, open, title: `s${i}` })
    );
    return { group, hosts, states };
  }

  it('should close the open member when another is opened by a key', () => {
    const { hosts, states } = accordion(true);
    press(hosts[1] as Element, 'enter');
    expect(states.map((s) => s.get())).toEqual([false, true, false]);
  });

  it('should close the open member when another is opened by a click', () => {
    const { hosts, states } = accordion(true);
    titleOf(hosts[2] as Element).onMouse?.(mouseEvent('click'));
    flush();
    expect(states.map((s) => s.get())).toEqual([false, false, true]);
  });

  it('should close the open member when the app opens another through its state', () => {
    const { states } = accordion(true);
    states[1]?.set(true);
    flush();
    expect(states.map((s) => s.get())).toEqual([false, true, false]);
  });

  it('should let the open member close and leave none open', () => {
    const { hosts, states } = accordion(true);
    press(hosts[0] as Element, 'enter');
    expect(states.map((s) => s.get())).toEqual([false, false, false]);
  });

  it('should leave the later of two members built open as the open one', () => {
    const group = collapsibleGroup();
    const a = new State(true);
    const b = new State(true);
    Collapsible({ group, open: a, title: 'a' });
    Collapsible({ group, open: b, title: 'b' });
    flush();
    expect([a.get(), b.get()]).toEqual([false, true]);
  });

  it('should close every member on closeAll()', () => {
    const { group, states } = accordion(true);
    group.closeAll();
    flush();
    expect(states.map((s) => s.get())).toEqual([false, false, false]);
  });

  it('should not touch a section outside the group', () => {
    const { hosts } = accordion();
    const outside = new State(true);
    Collapsible({ open: outside, title: 'other' });
    press(hosts[0] as Element, 'enter');
    expect(outside.get()).toBe(true);
  });

  it('should drop a member whose component has gone', () => {
    const group = collapsibleGroup();
    const gone = new State(true);
    const dispose = createRoot((dispose) => {
      Collapsible({ group, open: gone, title: 'gone' });
      return dispose;
    });
    dispose();
    const kept = new State(false);
    const host = Collapsible({ group, open: kept, title: 'kept' });
    press(host, 'enter');
    // a member that left the group is not closed by one that is still in it
    expect(gone.get()).toBe(true);
  });
});

describe('describeCollapsible', () => {
  /** A router that records what it was told. */
  function recorder() {
    const live: Array<{ keys: string; opts: DescribeOptions }> = [];
    const router: CollapsibleDescriber = {
      describe(keys, opts) {
        const entry = { keys, opts };
        live.push(entry);
        return () => void live.splice(live.indexOf(entry), 1);
      },
    };
    return { live, router };
  }

  it('should describe the four keys, scoped to the title', () => {
    const { live, router } = recorder();
    const host = section();
    describeCollapsible(router, host);
    expect(live.map((e) => `${e.keys} ${e.opts.description}`)).toEqual([
      'enter toggle',
      'space toggle',
      'right open',
      'left close',
    ]);
    expect(live.every((e) => e.opts.scope === titleOf(host))).toBe(true);
  });

  it('should take every description back off', () => {
    const { live, router } = recorder();
    const off = describeCollapsible(router, section(), section());
    expect(live).toHaveLength(8);
    off();
    expect(live).toHaveLength(0);
  });

  it('should refuse an element that is not a collapsible', () => {
    const { router } = recorder();
    expect(() => describeCollapsible(router, box())).toThrow(
      'Expected an element that Collapsible() returned'
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
  width: 24,
};

/** Lays a tree out, which is what the ring reads `display` off and the hit test reads boxes off. */
function lay(root: Element): void {
  resolveStyles(root);
  arrange(root, { height: 10, width: 24 });
}

describe('a collapsible under a real router', () => {
  it('should be reached by Tab, skip a closed body, and open with Enter', () => {
    const { feed, terminal } = harness();
    const inside = text('inside', { focusable: true, id: 'inside' });
    const host = Collapsible({ children: () => inside, title: 'Advanced' });
    const after = text('after', { focusable: true, id: 'after' });
    const root = box({ 'flex-direction': 'column' }, host, after);
    lay(root);
    const input = createInput({ root, terminal });

    // the closed body is not laid out, so the ring holds the title and `after`
    expect(input.focus.ring()).toEqual([titleOf(host), after]);

    feed('\t');
    expect(input.focus.current.get()).toBe(titleOf(host));
    feed('\r');
    flush();
    lay(root);
    expect(input.focus.ring()).toEqual([titleOf(host), inside, after]);
    input.stop();
  });

  it('should focus the title on a press and open it on the click', () => {
    const { feed, terminal } = harness();
    const host = section();
    const root = box({ 'flex-direction': 'column' }, host);
    lay(root);
    const input = createInput({ mouse: { surface }, root, terminal });

    // press and release of the left button on the title's text, at screen (3, 1)
    feed(`${ESC}[<0;3;1M`);
    feed(`${ESC}[<0;3;1m`);
    flush();

    expect(input.focus.current.get()).toBe(titleOf(host));
    expect(picture(host)).toHaveLength(3);
    input.stop();
  });

  it('should list its keys in a key-help footer while the title is focused', () => {
    const { terminal } = harness();
    const host = section();
    const root = box({ 'flex-direction': 'column' }, host);
    lay(root);
    const input = createInput({ root, terminal });
    describeCollapsible(input, host);
    const footer = keyHelp(input, { width: 60 });

    const line = () =>
      renderToString(footer, { cascade: themedCascade(), colorLevel: 0, width: 60 }).trimEnd();

    expect(line()).toBe('');
    input.focus.focus(titleOf(host));
    flush();
    expect(line()).toBe('enter/space toggle · → open · ← close');
    input.stop();
  });
});
