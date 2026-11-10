import { strip } from '../../src/ansi/index.js';
import { keyHelp } from '../../src/components/key-help.js';
import type { Key } from '../../src/components/keys.js';
import { listControl, type ListViewDescriber } from '../../src/components/list-view.js';
import {
  describeTreeListView,
  type TreeListControl,
  treeListControl,
  TreeListView,
  type TreeListViewProps,
} from '../../src/components/tree-list-view.js';
import { directoryRoot, type TreeChoiceItem } from '../../src/components/tree.js';
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
import { createRoot } from '../../src/renderer/index.js';
import { flush, State } from '../../src/signals/index.js';
import { createTestTerminal, KEYS } from '../../src/testing/index.js';
import { themedCascade } from '../../src/theme/index.js';
import { tempDir } from '../temp.js';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

/**
 * The tree list view: a `ListView` whose rows are the open part of a tree.
 *
 * What the list already does -- the cursor's moves, the ticks, the windowing, the
 * focus role -- is `list-view.test.ts`'s and is not tested again here. This file
 * is what the tree adds: the walk that decides the rows and draws the guides,
 * Right and Left, where the cursor goes when a branch closes over it, and a branch
 * read on demand, including a read that fails and one still running when its
 * branch is closed. Driven through the handlers the router would call, as the list
 * is, and the last block goes through a real router.
 */

const ESC = String.fromCharCode(0x1b);

/** The rows as they would be drawn, with colour taken off and the right edge trimmed. */
function picture(host: Element, width = 32): string[] {
  return renderToLines(host, { cascade: themedCascade(), colorLevel: 0, width })
    .map((line) => strip(line).trimEnd())
    .filter((line) => line !== '');
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

/** Presses a key on the tree, then lets the effects that draw it run. */
function press(
  host: Element,
  name: string,
  mods: Parameters<typeof keyEvent>[1] = {},
  paste = false
): boolean {
  const event = keyEvent(name, mods, paste);
  host.onKey?.(event);
  flush();
  return event.claimed();
}

/** The control, which every tree has. */
function control<T = string>(host: Element): TreeListControl<T> {
  const found = treeListControl<T>(host);
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

/** The element drawing a piece of text, trimmed. */
function drawing(host: Element, label: string): Element {
  const found = every(host).find((e) => e.text?.trim() === label);
  if (!found) {
    throw new Error(`nothing draws ${label}`);
  }
  return found;
}

/** The twisty in front of a node's text: the element just before the label. */
function twistyOf(host: Element, label: string): Element {
  const node = drawing(host, label).parent as Element;
  return node.children[node.children.indexOf(drawing(host, label)) - 1] as Element;
}

/** Lets a promise the test settled land, and the effects it woke run. */
async function landed(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
  flush();
}

/** A promise and the two ends of it, for a read the test settles by hand. */
function deferred<T>(): {
  promise: Promise<T>;
  reject: (err: unknown) => void;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, reject, resolve };
}

/**
 * The tree most tests use:
 *
 *   src (a.ts, lib (x.ts, y.ts), b.ts)   docs (guide.md)   README.md
 */
const SAMPLE: TreeChoiceItem[] = [
  {
    items: ['a.ts', { items: ['x.ts', 'y.ts'], text: 'lib' }, 'b.ts'],
    text: 'src',
  },
  { items: ['guide.md'], text: 'docs' },
  'README.md',
];

/** A tree in a viewport `height` rows tall, drawn once so it has a layout. */
function tree<T = string>(
  over: Partial<TreeListViewProps<T>> & Pick<TreeListViewProps<T>, 'items'>,
  height = 10
): Element {
  const host = TreeListView<T>({ ascii: false, props: { height }, scrollbar: false, ...over });
  picture(host);
  return host;
}

describe('TreeListView()', () => {
  describe('drawing', () => {
    it('should draw the guides and the twisties with treeGlyphs(), and a pointer on the current row', () => {
      const host = tree({ expanded: ['src', 'lib'], items: SAMPLE });

      expect(picture(host)).toEqual([
        '❯ ├── ▾ src',
        '  │   ├──   a.ts',
        '  │   ├── ▾ lib',
        '  │   │   ├──   x.ts',
        '  │   │   └──   y.ts',
        '  │   └──   b.ts',
        '  ├── ▸ docs',
        '  └──   README.md',
      ]);
    });

    it('should draw a root node bare, with its children hung from the margin', () => {
      const host = tree({
        guide: 'rounded',
        items: { expanded: true, items: ['one', 'two'], text: 'root' },
      });

      expect(picture(host)).toEqual(['❯ ▾ root', '  ├──   one', '  ╰──   two']);
    });

    it('should draw with ASCII where asked', () => {
      const host = tree({ ascii: true, expanded: ['docs'], items: SAMPLE });

      expect(picture(host)).toEqual([
        '> |-- + src',
        '  |-- - docs',
        '  |   `--   guide.md',
        '  `--   README.md',
      ]);
    });

    it('should open a node built with expanded: true, and write that into the open set', () => {
      const expanded = new State<ReadonlySet<string>>(new Set());
      const host = tree({
        expanded,
        items: [
          { expanded: true, items: [{ expanded: true, items: ['deep'], text: 'b' }], text: 'a' },
        ],
      });

      expect(picture(host)).toEqual(['❯ └── ▾ a', '      └── ▾ b', '          └──   deep']);
      expect([...expanded.get()]).toEqual(['a', 'b']);
    });

    it('should read expanded: true only the first time a node is seen, so closing it sticks', () => {
      const items = new State<TreeChoiceItem[]>([{ expanded: true, items: ['x'], text: 'a' }]);
      const host = tree({ items });
      press(host, 'left');
      expect(picture(host)).toEqual(['❯ └── ▸ a']);

      // the same node handed over again, as a live update would
      items.set([{ expanded: true, items: ['x'], text: 'a' }]);
      flush();
      expect(picture(host)).toEqual(['❯ └── ▸ a']);
    });

    it('should hand a row function the node and what it needs to draw it', () => {
      const seen: unknown[] = [];
      const host = tree({
        expanded: ['src'],
        items: [{ items: [{ text: 'a.ts', value: 'A' }], text: 'src' }],
        row: (node, info) => {
          seen.push([node.text, info]);
          return info.branch ? text(node.text.toUpperCase()) : `${node.text} (${info.depth})`;
        },
      });

      expect(picture(host)).toEqual(['❯ └── ▾ SRC', '      └──   a.ts (1)']);
      expect(seen).toEqual([
        ['src', { branch: true, depth: 0, expanded: true, status: 'idle', text: 'src' }],
        ['a.ts', { branch: false, depth: 1, expanded: false, status: 'idle', text: 'a.ts' }],
      ]);
    });

    it('should draw a node on one line, with its escape sequences dropped', () => {
      const host = tree({ items: [`${ESC}[1mbold${ESC}[22m\nnext`] });
      expect(picture(host)).toEqual(['❯ └──   bold next']);
    });

    it('should keep the rows it built when a sibling opens, and rebuild the one that changed', () => {
      const built: string[] = [];
      const host = tree({
        items: SAMPLE,
        row: (node) => {
          built.push(node.text);
          return node.text;
        },
      });
      built.length = 0;

      control(host).expand('docs');
      flush();
      picture(host);

      // `docs` draws a new twisty and `guide.md` is new; `src` and `README.md`
      // moved or stayed and are kept
      expect(built.sort()).toEqual(['docs', 'guide.md']);
    });

    it('should show the empty state for an empty tree', () => {
      expect(picture(tree({ empty: 'No files', items: [] }))).toEqual(['No files']);
    });
  });

  describe('keys', () => {
    it('should open a closed branch on Right, and step onto its first child on the next', () => {
      const host = tree({ items: SAMPLE });
      const { current, expanded } = control(host);

      expect(press(host, 'right')).toBe(true);
      expect([...expanded.get()]).toEqual(['src']);
      expect(current.get()).toBe('src');

      expect(press(host, 'right')).toBe(true);
      expect(current.get()).toBe('a.ts');
    });

    it('should leave Right alone on a leaf and on an open branch with nothing in it', () => {
      const host = tree({ expanded: ['empty'], items: [{ items: [], text: 'empty' }, 'leaf'] });

      expect(press(host, 'right')).toBe(false);
      expect(control(host).current.get()).toBe('empty');
      press(host, 'down');
      expect(press(host, 'right')).toBe(false);
    });

    it('should close an open branch on Left, and step to the parent from anything else', () => {
      const host = tree({ expanded: ['src', 'lib'], items: SAMPLE });
      const { current, expanded } = control(host);
      current.set('x.ts');
      flush();

      expect(press(host, 'left')).toBe(true);
      expect(current.get()).toBe('lib');
      expect(press(host, 'left')).toBe(true);
      expect([...expanded.get()]).toEqual(['src']);
      expect(current.get()).toBe('lib');
      expect(press(host, 'left')).toBe(true);
      expect(current.get()).toBe('src');
    });

    it('should leave Left alone on a closed node at the margin', () => {
      const host = tree({ items: SAMPLE });
      expect(press(host, 'left')).toBe(false);
    });

    it('should step from a node at the margin to the root on Left', () => {
      const host = tree({ items: { expanded: true, items: ['one'], text: 'root' } });
      control(host).current.set('one');
      flush();

      expect(press(host, 'left')).toBe(true);
      expect(control(host).current.get()).toBe('root');
    });

    it('should open and close a branch on Space in a single tree, and leave a leaf alone', () => {
      const host = tree({ items: SAMPLE });
      const { current, expanded } = control(host);

      expect(press(host, 'space')).toBe(true);
      expect(expanded.get().has('src')).toBe(true);
      expect(press(host, 'space')).toBe(true);
      expect(expanded.get().has('src')).toBe(false);

      current.set('README.md');
      flush();
      expect(press(host, 'space')).toBe(false);
    });

    it('should tick on Space in a multiple tree, and not open anything', () => {
      const host = tree({ items: SAMPLE, multiple: true });
      const { expanded } = control(host);

      expect(press(host, 'space')).toBe(true);
      expect([...control(host).list.selection.selected.get()]).toEqual(['src']);
      expect(expanded.get().size).toBe(0);
    });

    it('should activate on Enter with the value and the node, and leave Enter alone without a handler', () => {
      const calls: unknown[] = [];
      const host = tree({
        items: [{ items: ['x'], text: 'src', value: 'SRC' }],
        onActivate: (value, node) => calls.push([value, node.text]),
      });
      expect(press(host, 'enter')).toBe(true);
      expect(calls).toEqual([['SRC', 'src']]);

      expect(press(tree({ items: SAMPLE }), 'enter')).toBe(false);
    });

    it('should take h and l for Left and Right with vim keys, and only then', () => {
      const plain = tree({ items: SAMPLE });
      expect(press(plain, 'l')).toBe(false);

      const host = tree({ items: SAMPLE, vim: true });
      expect(press(host, 'l')).toBe(true);
      expect(control(host).expanded.get().has('src')).toBe(true);
      expect(press(host, 'h')).toBe(true);
      expect(control(host).expanded.get().has('src')).toBe(false);
    });

    it('should leave an arrow with a modifier, and a paste, to whatever is around it', () => {
      const host = tree({ items: SAMPLE });

      expect(press(host, 'right', { shift: true })).toBe(false);
      expect(press(host, 'right', { ctrl: true })).toBe(false);
      expect(press(host, 'right', { meta: true })).toBe(false);
      expect(press(host, 'right', {}, true)).toBe(false);
      expect(control(host).expanded.get().size).toBe(0);
    });

    it('should move over the open rows with the list keys, passing a closed branch by', () => {
      const host = tree({ expanded: ['src'], items: SAMPLE });
      press(host, 'end');
      expect(control(host).current.get()).toBe('README.md');
      press(host, 'up');
      expect(control(host).current.get()).toBe('docs');
      press(host, 'up');
      expect(control(host).current.get()).toBe('b.ts');
    });
  });

  describe('the cursor when a branch closes over it', () => {
    it('should go to the branch that closed, not to the row that took its place', () => {
      const host = tree({ expanded: ['src', 'lib'], items: SAMPLE });
      const { current, expanded } = control(host);
      current.set('y.ts');
      flush();

      // the app closes `src`, two levels up; the row that takes y.ts's place is
      // `README.md`, which is nobody's idea of where the cursor was
      expanded.set(new Set(['lib']));
      flush();

      expect(current.get()).toBe('src');
      expect(picture(host)[0]).toBe('❯ ├── ▸ src');
    });

    it('should go to the branch whose twisty was clicked', () => {
      const host = tree({ expanded: ['src'], items: SAMPLE });
      const { current } = control(host);
      current.set('b.ts');
      flush();

      const event = click();
      twistyOf(host, 'src').onMouse?.(event);
      flush();

      expect(event.claimed()).toBe(true);
      expect(control(host).expanded.get().has('src')).toBe(false);
      expect(current.get()).toBe('src');
    });

    it('should leave a node deleted from an open branch to the list, which takes the row that took its place', () => {
      const items = new State<TreeChoiceItem[]>([{ items: ['a', 'b', 'c'], text: 'dir' }]);
      const host = tree({ expanded: ['dir'], items });
      const { current } = control(host);
      current.set('b');
      flush();

      items.set([{ items: ['a', 'c'], text: 'dir' }]);
      flush();

      expect(current.get()).toBe('c');
    });

    it('should keep the cursor where it is when a branch elsewhere closes', () => {
      const host = tree({ expanded: ['src', 'docs'], items: SAMPLE });
      const { current } = control(host);
      current.set('guide.md');
      flush();

      control(host).collapse('src');
      flush();
      expect(current.get()).toBe('guide.md');
    });
  });

  describe('state', () => {
    it('should be the states it was handed, and write them', () => {
      const expanded = new State<ReadonlySet<string>>(new Set(['src']));
      const current = new State<string | undefined>('b.ts');
      const selected = new State<ReadonlySet<string>>(new Set());
      const host = tree({ current, expanded, items: SAMPLE, multiple: true, selected });

      expect(control(host).expanded).toBe(expanded);
      expect(control(host).current).toBe(current);
      expect(picture(host)[3]).toBe('❯ ◯ │   └──   b.ts');

      press(host, 'space');
      expect([...selected.get()]).toEqual(['b.ts']);
      press(host, 'left');
      expect(current.get()).toBe('src');
      press(host, 'left');
      expect(expanded.get().has('src')).toBe(false);
    });

    it('should open and close what an app writes into the open set', () => {
      const expanded = new State<ReadonlySet<string>>(new Set());
      const host = tree({ expanded, items: SAMPLE });

      expanded.set(new Set(['docs']));
      flush();
      expect(picture(host)).toContain('  │   └──   guide.md');
    });

    it('should leave the branches under a closed one open, so they come back with it', () => {
      const host = tree({ expanded: ['src', 'lib'], items: SAMPLE });
      const { collapse, expand, expanded } = control(host);

      collapse('src');
      flush();
      expect([...expanded.get()]).toEqual(['lib']);
      expand('src');
      flush();
      expect(picture(host)).toContain('  │   │   └──   y.ts');
    });

    it('should keep a tick on a node a branch closed over, since hidden is not deleted', () => {
      const host = tree({ expanded: ['src'], items: SAMPLE, multiple: true, selected: ['a.ts'] });
      control(host).collapse('src');
      flush();
      expect([...control(host).list.selection.selected.get()]).toEqual(['a.ts']);
    });

    it('should follow a State of items, keeping the cursor on its value', () => {
      const items = new State<TreeChoiceItem[]>(['b', 'c']);
      const host = tree({ current: 'c', items });

      items.set(['a', 'b', 'c']);
      flush();
      expect(control(host).current.get()).toBe('c');
      expect(picture(host)).toEqual(['  ├──   a', '  ├──   b', '❯ └──   c']);
    });

    it('should toggle the current node from the control, and report what changed', () => {
      const host = tree({ items: SAMPLE });
      const { collapse, expand, toggle } = control(host);

      expect(expand()).toBe(true);
      expect(expand()).toBe(false);
      expect(toggle()).toBe(true);
      expect(collapse()).toBe(false);
    });

    it('should be the list underneath, which listControl() answers for too', () => {
      const host = tree({ items: SAMPLE });
      expect(control(host).list).toBe(listControl(host));
      expect(host.classes).toEqual(expect.arrayContaining(['sigil-list', 'sigil-tree-list-view']));
    });
  });

  describe('reading a branch on demand', () => {
    it('should read a branch the first time it opens, with a loading line while it runs', async () => {
      const read = deferred<string[]>();
      let calls = 0;
      const host = tree({
        items: [
          {
            items: () => {
              calls++;
              return read.promise;
            },
            text: 'remote',
          },
        ],
      });
      expect(calls).toBe(0);

      press(host, 'right');
      expect(calls).toBe(1);
      expect(control(host).status('remote')).toBe('loading');
      expect(picture(host)).toEqual(['❯ └── ▾ remote', '      └──   Loading…']);

      read.resolve(['one', 'two']);
      await landed();
      expect(control(host).status('remote')).toBe('loaded');
      expect(picture(host)).toEqual(['❯ └── ▾ remote', '      ├──   one', '      └──   two']);

      // kept: closing and opening again does not read again
      press(host, 'left');
      press(host, 'right');
      expect(calls).toBe(1);
      expect(picture(host)).toHaveLength(3);
    });

    it('should never land the cursor on the loading line', async () => {
      const read = deferred<string[]>();
      const host = tree({ items: [{ items: () => read.promise, text: 'remote' }, 'after'] });
      press(host, 'right');
      press(host, 'down');
      expect(control(host).current.get()).toBe('after');
      press(host, 'up');
      expect(control(host).current.get()).toBe('remote');
      // Right on a branch still being read is claimed and goes nowhere yet
      expect(press(host, 'right')).toBe(true);
      expect(control(host).current.get()).toBe('remote');
    });

    it('should take a function that returns a list at once, with no loading line', () => {
      const host = tree({ items: [{ items: () => ['now'], text: 'sync' }] });
      press(host, 'right');
      expect(picture(host)).toEqual(['❯ └── ▾ sync', '      └──   now']);
    });

    it('should say why a read failed under the branch, keep the branch open, and read again on Right', async () => {
      let fail = true;
      let calls = 0;
      const host = tree({
        items: [
          {
            items: async () => {
              calls++;
              if (fail) {
                throw new Error('EACCES: permission denied');
              }
              return ['inside'];
            },
            text: 'locked',
          },
        ],
      });

      press(host, 'right');
      await landed();
      expect(control(host).status('locked')).toBe('failed');
      expect(picture(host, 60)).toEqual([
        '❯ └── ▾ locked',
        '      └──   Could not load: EACCES: permission denied',
      ]);
      const line = drawing(host, 'Could not load: EACCES: permission denied');
      expect(line.classes).toContain('sigil-error');

      fail = false;
      expect(press(host, 'right')).toBe(true);
      await landed();
      expect(calls).toBe(2);
      expect(picture(host)).toEqual(['❯ └── ▾ locked', '      └──   inside']);
    });

    it('should read a failed branch again when it is closed and opened, however that is done', async () => {
      let calls = 0;
      const host = tree({
        items: [
          {
            items: () => {
              calls++;
              return Promise.reject(new Error('offline'));
            },
            text: 'remote',
          },
        ],
      });
      const { expanded } = control(host);

      press(host, 'right');
      await landed();
      expect(calls).toBe(1);

      // the app closes and reopens it through the state, with no key involved
      expanded.set(new Set());
      flush();
      expanded.set(new Set(['remote']));
      flush();
      await landed();
      expect(calls).toBe(2);
    });

    it('should keep a read going when its branch is closed, and open again on what it found', async () => {
      const read = deferred<string[]>();
      let calls = 0;
      const host = tree({
        items: [
          {
            items: () => {
              calls++;
              return read.promise;
            },
            text: 'slow',
          },
        ],
      });

      press(host, 'right');
      press(host, 'left');
      expect(picture(host)).toEqual(['❯ └── ▸ slow']);
      read.resolve(['found']);
      await landed();
      // closed, so nothing under it, and not read again when it opens
      expect(picture(host)).toEqual(['❯ └── ▸ slow']);
      press(host, 'right');
      expect(calls).toBe(1);
      expect(picture(host)).toEqual(['❯ └── ▾ slow', '      └──   found']);
    });

    it('should read again on opening a branch whose read failed while it was closed', async () => {
      const first = deferred<string[]>();
      let calls = 0;
      const host = tree({
        items: [
          {
            items: () => (++calls === 1 ? first.promise : ['second']),
            text: 'slow',
          },
        ],
      });

      press(host, 'right');
      press(host, 'left');
      first.reject(new Error('timed out'));
      await landed();
      press(host, 'right');
      expect(calls).toBe(2);
      expect(picture(host)).toEqual(['❯ └── ▾ slow', '      └──   second']);
    });

    it('should drop a read that reload() superseded when it lands', async () => {
      const reads = [deferred<string[]>(), deferred<string[]>()];
      let calls = 0;
      const host = tree({
        items: [
          { items: () => (reads[calls++] as { promise: Promise<string[]> }).promise, text: 'r' },
        ],
      });
      press(host, 'right');
      expect(control(host).reload('r')).toBe(true);
      flush();
      expect(calls).toBe(2);

      // the superseded read lands first, while the one that replaced it is still
      // in flight: it is dropped rather than taken for the answer
      reads[0]?.resolve(['stale']);
      await landed();
      expect(picture(host)).toEqual(['❯ └── ▾ r', '      └──   Loading…']);
      reads[1]?.resolve(['new']);
      await landed();
      expect(picture(host)).toEqual(['❯ └── ▾ r', '      └──   new']);
    });

    it('should forget a closed branch on reload() and read it the next time it opens', async () => {
      let calls = 0;
      const host = tree({ items: [{ items: () => [`v${++calls}`], text: 'r' }] });
      press(host, 'right');
      press(host, 'left');
      expect(control(host).reload('r')).toBe(true);
      expect(control(host).reload('r')).toBe(false);
      flush();
      expect(calls).toBe(1);
      press(host, 'right');
      expect(picture(host)).toEqual(['❯ └── ▾ r', '      └──   v2']);
    });

    it('should count a function that throws, a list that is not one, and a malformed node as a failed read', async () => {
      const host = tree({
        items: [
          {
            items: () => {
              throw new Error('boom');
            },
            text: 'throws',
          },
          { items: async () => 'nope' as never, text: 'not a list' },
          { items: async () => [42 as never], text: 'bad node' },
        ],
      });
      const { expand, status } = control(host);
      expand('throws');
      expand('not a list');
      expand('bad node');
      flush();
      await landed();

      expect(status('throws')).toBe('failed');
      expect(picture(host, 100)).toEqual([
        '❯ ├── ▾ throws',
        '  │   └──   Could not load: boom',
        '  ├── ▾ not a list',
        '  │   └──   Could not load: Expected items to be an array',
        '  └── ▾ bad node',
        '      └──   Could not load: Expected each item to be a string or an object with a text string',
      ]);
    });

    it('should say a read failed when its function rejected with a null-prototype object', async () => {
      // `String(Object.create(null))` is a TypeError, so the line that said why
      // a read failed threw instead, and the branch never left `loading`
      const host = tree({
        items: [{ items: () => Promise.reject(Object.create(null)), text: 'odd' }],
      });
      press(host, 'right');
      await landed();

      expect(control(host).status('odd')).toBe('failed');
      expect(picture(host, 60)).toEqual([
        '❯ └── ▾ odd',
        '      └──   Could not load: Unknown error',
      ]);
    });

    it('should not land a read whose tree has been disposed', async () => {
      const read = deferred<string[]>();
      let host!: Element;
      const dispose = createRoot((done) => {
        host = tree({ items: [{ items: () => read.promise, text: 'r' }] });
        return done;
      });
      press(host, 'right');
      dispose();
      read.resolve(['late']);
      await landed();
      expect(control(host).status('r')).toBe('loading');
    });

    it('should browse a directory with directoryRoot(), and read it again on reload()', async () => {
      const root = tempDir('sigil-tree-list-');
      mkdirSync(join(root, 'sub'));
      writeFileSync(join(root, 'sub', 'one.txt'), '');
      writeFileSync(join(root, 'top.txt'), '');

      const host = tree({ items: directoryRoot({ root }) }, 12);
      const name = root.split(/[\\/]/).at(-1) as string;
      /** Waits for the disk, which is slower than a turn of the event loop. */
      const shows = (end: string) =>
        vi.waitFor(() => {
          flush();
          expect(picture(host, 80).some((line) => line.endsWith(end))).toBe(true);
        });

      await shows('top.txt');
      const lines = picture(host, 80);
      expect(lines[0]).toContain(name);
      expect(lines[1]).toContain('sub');
      expect(lines[2]).toContain('top.txt');

      const sub = join(root, 'sub');
      control(host).expand(sub);
      await shows('one.txt');

      writeFileSync(join(root, 'sub', 'two.txt'), '');
      control(host).reload(sub);
      await shows('two.txt');
    });
  });

  describe('the mouse', () => {
    it('should open a branch on a click on its twisty, without moving the cursor', () => {
      const host = tree({ items: SAMPLE });
      const event = click();
      twistyOf(host, 'docs').onMouse?.(event);
      flush();

      expect(event.claimed()).toBe(true);
      expect(control(host).expanded.get().has('docs')).toBe(true);
      expect(control(host).current.get()).toBe('src');
    });

    it('should open a disabled branch from its twisty, while the cursor passes it by', () => {
      const host = tree({ disabled: (node) => node.text === 'src', items: SAMPLE });
      expect(control(host).current.get()).toBe('docs');

      twistyOf(host, 'src').onMouse?.(click());
      flush();
      expect(control(host).expanded.get().has('src')).toBe(true);
      expect(control(host).current.get()).toBe('docs');
    });

    it('should give a leaf no twisty to click', () => {
      const host = tree({ items: SAMPLE });
      expect(twistyOf(host, 'README.md').onMouse).toBeUndefined();
    });
  });

  it('should refuse two nodes with one value', () => {
    expect(() => TreeListView({ items: ['same', { text: 'other', value: 'same' }] })).toThrow(
      'Expected every tree node to have a value of its own: same is used twice'
    );
  });

  it('should refuse what it cannot use', () => {
    expect(() => TreeListView({ items: 42 as never })).toThrow(
      'Expected tree items to be an array, a root node, a State or a Computed'
    );
    expect(() => TreeListView({ items: [], row: 'x' as never })).toThrow(
      'Expected tree row to be a function'
    );
    expect(() => TreeListView({ expanded: 7 as never, items: [] })).toThrow(
      'Expected tree expanded to be an iterable of values or a State'
    );
    expect(() =>
      TreeListView({ items: [{ items: 'x' as never, text: 'a' }], expanded: ['a'] })
    ).toThrow('Expected items to be an array');
    expect(() => TreeListView({ items: [], props: { onKey: () => {} } as never })).toThrow(
      'TreeListView'
    );
  });

  it('should hand nothing to treeListControl() for an element no tree built', () => {
    expect(treeListControl(box())).toBeUndefined();
  });
});

describe('describeTreeListView()', () => {
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

  it("should describe the list's keys and the tree's, scoped to it", () => {
    const plain = TreeListView({ items: [] });
    const { live, router } = recorder();
    const off = describeTreeListView(router, plain);
    expect(live.map(([keys]) => keys)).toEqual(
      expect.arrayContaining(['up', 'down', 'right', 'left', 'space'])
    );
    expect(live.every(([, opts]) => opts.scope === plain)).toBe(true);
    off();
    expect(live).toHaveLength(0);

    // Space is the list's in a multiple tree, and h and l come with vim
    const full = TreeListView({ items: [], multiple: true, vim: true });
    describeTreeListView(router, full);
    const space = live.filter(([keys]) => keys === 'space');
    expect(space.map(([, opts]) => opts.description)).toEqual(['select']);
    expect(live.map(([keys]) => keys)).toEqual(expect.arrayContaining(['h', 'l']));
  });

  it('should refuse an element that is not a tree, before describing anything', () => {
    const { live, router } = recorder();
    expect(() => describeTreeListView(router, TreeListView({ items: [] }), box())).toThrow(
      'Expected an element that TreeListView() returned'
    );
    expect(live).toHaveLength(0);
  });
});

describe('a tree under a real router', () => {
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

  it('should be reached by Tab and opened and closed with the arrows', async () => {
    const term = createTestTerminal({ columns: 40, rows: 10 });
    const host = TreeListView({ items: SAMPLE, props: { height: 8 } });
    const root = box({ 'flex-direction': 'column' }, host);
    renderToString(root, { width: 40 });
    lay(root);
    const input = createInput({ root, terminal: term.terminal });

    await term.press(KEYS.tab, KEYS.right, KEYS.right);
    flush();
    expect(input.focus.current.get()).toBe(host);
    expect(control(host).current.get()).toBe('a.ts');
    await term.press(KEYS.left, KEYS.left);
    flush();
    expect(control(host).current.get()).toBe('src');
    expect(control(host).expanded.get().size).toBe(0);
    input.stop();
  });

  it('should open a branch on a click on its twisty, reaching it through the hit test', async () => {
    const term = createTestTerminal({ columns: 40, rows: 10 });
    const host = TreeListView({ ascii: true, items: SAMPLE, props: { height: 8 } });
    const root = box({ 'flex-direction': 'column' }, host);
    renderToString(root, { width: 40 });
    lay(root);
    const input = createInput({ mouse: { surface }, root, terminal: term.terminal });

    // `  |-- + docs`: the twisty is the seventh column of the second row
    await term.press(`${ESC}[<0;7;2M`, `${ESC}[<0;7;2m`);
    flush();
    expect(control(host).expanded.get().has('docs')).toBe(true);
    expect(control(host).current.get()).toBe('src');
    input.stop();
  });

  it('should list its keys in a key-help footer while it has the focus', () => {
    const term = createTestTerminal({ columns: 80, rows: 10 });
    const host = TreeListView({ items: ['a'] });
    const root = box({ 'flex-direction': 'column' }, host);
    lay(root);
    const input = createInput({ root, terminal: term.terminal });
    describeTreeListView(input, host);
    const footer = keyHelp(input, { width: 80 });
    const line = () =>
      renderToString(footer, { cascade: themedCascade(), colorLevel: 0, width: 80 }).trimEnd();

    expect(line()).not.toContain('expand');
    input.focus.focus(host);
    flush();
    expect(line()).toContain('expand');
    expect(line()).toContain('collapse');
    input.stop();
  });
});
