import { strip } from '../../src/ansi/index.js';
import { keyHelp } from '../../src/components/key-help.js';
import type { Key } from '../../src/components/keys.js';
import { listControl, type ListViewDescriber } from '../../src/components/list-view.js';
import {
  describeTreeListView,
  type TreeListControl,
  treeListControl,
  treeListHeld,
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
import { Computed, flush, State } from '../../src/signals/index.js';
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

    it('should keep a row whose guide alone moved, and draw its new guide (SIG-471)', () => {
      const built: string[] = [];
      const items = new State<TreeChoiceItem[]>(SAMPLE);
      const host = tree({
        expanded: ['src'],
        items,
        row: (node) => {
          built.push(node.text);
          return node.text;
        },
      });
      built.length = 0;

      // `README.md` stops being the last node, and so does `src` when it goes from
      // the end of the list: their guides move, and so do the guides under `src`
      items.set([...SAMPLE, 'LICENSE']);
      flush();
      expect(picture(host)).toEqual([
        '❯ ├── ▾ src',
        '  │   ├──   a.ts',
        '  │   ├── ▸ lib',
        '  │   └──   b.ts',
        '  ├── ▸ docs',
        '  ├──   README.md',
        '  └──   LICENSE',
      ]);
      items.set([items.get()[2] as string, 'LICENSE', SAMPLE[0] as TreeChoiceItem]);
      flush();
      expect(picture(host)).toEqual([
        '  ├──   README.md',
        '  ├──   LICENSE',
        '❯ └── ▾ src',
        '      ├──   a.ts',
        '      ├── ▸ lib',
        '      └──   b.ts',
      ]);
      expect(built).toEqual(['LICENSE']);
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

    it('should move over the rows a Right opened when the next key is in the same read', () => {
      // no frame between the two keys: the tree's walk runs in an effect, so the
      // list has to ask for it before it moves, or Down goes from `src` to `docs`
      // over the rows the last frame walked (SIG-469)
      const host = tree({ items: SAMPLE });
      const { current } = control(host);

      host.onKey?.(keyEvent('right'));
      host.onKey?.(keyEvent('down'));

      expect(current.get()).toBe('a.ts');
    });

    it('should activate a node of the items as they are now when Enter is in the same read', () => {
      const items = new State<TreeChoiceItem[]>(['apple', 'banana']);
      const seen: string[] = [];
      const host = tree({ items, onActivate: (value) => seen.push(value) });

      items.set(['banana']);
      host.onKey?.(keyEvent('enter'));

      expect(seen).toEqual(['banana']);
    });

    it('should walk the rows once per change, however often the list asks for them', () => {
      // every key and every call on the list's control asks the tree for its rows,
      // so a walk that ran each time would cost a walk per key over a tree that did
      // not change. A getter on a node's text counts the walks
      let walks = 0;
      const items: TreeChoiceItem[] = [
        {
          get text() {
            walks++;
            return 'counted';
          },
        },
        'other',
      ];
      const host = tree({ items });
      const before = walks;

      press(host, 'down');
      press(host, 'up');
      listControl(host)?.selection.index();

      expect(walks).toBe(before);
    });

    it('should not walk a change again at the frame when a key already walked it', () => {
      // the key asks for the walk before the frame, and the effect the change woke
      // then finds it walked: one walk for the change, not one for each asker
      let walks = 0;
      const counted = {
        get text() {
          walks++;
          return 'counted';
        },
      };
      const items = new State<TreeChoiceItem[]>([counted, 'other']);
      const host = tree({ items });
      let before = walks;
      items.set([counted, 'other', 'more']);
      flush();
      const one = walks - before;

      before = walks;
      items.set([counted, 'other', 'more', 'again']);
      host.onKey?.(keyEvent('down'));
      flush();

      expect(walks - before).toBe(one);
    });

    it('should not walk again for a source that builds a new tree each time it is read', () => {
      // a `filter()` in a `get()` hands over a new array on every read, so a walk
      // guarded by the array would walk on every key: it is guarded by the reading,
      // which is new only when what the source reads changes
      let walks = 0;
      const counted = {
        get text() {
          walks++;
          return 'counted';
        },
      };
      const all = new State<TreeChoiceItem[]>([counted, 'other']);
      const host = tree({ items: { get: () => all.get().filter(() => true) } });
      const before = walks;

      press(host, 'down');
      press(host, 'up');
      listControl(host)?.selection.index();

      expect(walks).toBe(before);
    });

    it('should draw a change made in place in the same read as a key, and after a key walked one', () => {
      // a source that changes its tree in place and wakes the walk hands over the
      // same tree: the list sees a new reading of it as soon as it asks, and so does
      // the effect after a key walked the change before it
      const tick = new State(0);
      const nodes: TreeChoiceItem[] = [{ items: ['a.ts'], text: 'src' }, 'b'];
      const host = tree({
        items: {
          get: () => {
            tick.get();
            return nodes;
          },
        },
      });

      host.onKey?.(keyEvent('right'));
      host.onKey?.(keyEvent('down'));
      flush();
      expect(control(host).current.get()).toBe('a.ts');

      nodes.push('more');
      tick.set(1);
      host.onKey?.(keyEvent('end'));
      expect(control(host).current.get()).toBe('more');
      flush();

      nodes.push('last');
      tick.set(2);
      flush();
      expect(picture(host).join('\n')).toContain('last');
    });

    it('should let go of its source when it is disposed', () => {
      // the reading of the source is a Computed, and a source holds every sink that
      // read it until the sink lets go: a tree that did not would stay reachable from
      // a long-lived State of items for as long as the State lived
      const items = new State<TreeChoiceItem[]>(['a', 'b']);
      const sinks = (): number => (items as unknown as { sinks: Set<unknown> }).sinks.size;
      for (let i = 0; i < 5; i++) {
        let host: Element | undefined;
        const dispose = createRoot((done) => {
          host = tree({ items });
          return done;
        });
        flush();
        dispose();
        // a key that reaches a tree after it is gone asks for no walk, which would
        // read the source again and take it back
        host?.onKey?.(keyEvent('down'));
        flush();
      }
      expect(sinks()).toBe(0);
    });

    it('should read a lazy branch once when its read asks the list for its rows', () => {
      // the read runs inside a walk, and asking the list's control for its rows asks
      // the tree for a walk: the second ask gets the rows as they were rather than a
      // walk inside the walk, which would call the read again until the stack ran out
      let host: Element | undefined;
      let reads = 0;
      host = tree({
        items: [
          {
            items: () => {
              reads++;
              listControl(host as Element)?.selection.index();
              return ['a.ts'];
            },
            text: 'src',
          },
        ],
      });

      control(host).expand('src');
      press(host, 'down');

      expect(reads).toBe(1);
      expect(control(host).current.get()).toBe('a.ts');
    });

    it('should draw the new rows after a walk whose handing over threw', () => {
      // a Computed may not write, so a walk it asks for -- through the list's
      // control -- cannot hand the list its rows. The next walk has to, rather than
      // taking the one that threw for one that finished and leaving the old rows up.
      // Values none of the old rows had, so no row is kept and handed a new guide --
      // which would throw first, before the walk had recorded anything
      const items = new State<TreeChoiceItem[]>(['a', 'b']);
      const host = tree({ items });
      const count = new Computed(() => {
        items.get();
        return listControl(host)?.selection.rowCount;
      });

      items.set(['x', 'y', 'z']);
      try {
        count.get();
      } catch {
        // what the Computed itself makes of it is not the question
      }
      flush();

      expect(picture(host).slice(0, 3)).toEqual(['❯ ├──   x', '  ├──   y', '  └──   z']);
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

    it('should follow its last row as nodes are added, through the tail it was handed (SIG-470)', async () => {
      const items = new State<TreeChoiceItem[]>(['a', { items: ['x'], text: 'b' }]);
      const tail = new State(true);
      const host = tree({ expanded: ['b'], items, tail }, 3);
      expect(control(host).current.get()).toBe('x');

      items.set([...items.get(), 'c']);
      flush();
      expect(control(host).current.get()).toBe('c');
      expect(picture(host).at(-1)).toBe('❯ └──   c');

      // a branch read at the end: its loading line is not a row the cursor is on, so
      // the branch is the last one until its children land, and then the last child
      const read = deferred<string[]>();
      items.set([...items.get(), { expanded: true, items: () => read.promise, text: 'slow' }]);
      flush();
      expect(control(host).current.get()).toBe('slow');
      read.resolve(['s1', 's2']);
      await landed();
      expect(control(host).current.get()).toBe('s2');
      expect(tail.get()).toBe(true);
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

  describe('when the data behind a read branch changes', () => {
    /** A directory read through a function, over a list the test edits. */
    function files(names: string[]): { calls: () => number; node: TreeChoiceItem } {
      let calls = 0;
      return {
        calls: () => calls,
        node: {
          items: () => {
            calls++;
            return [...names];
          },
          text: 'dir',
        },
      };
    }

    it('should stop showing a child deleted from the data once the branch is reloaded', () => {
      const names = ['a', 'b', 'c'];
      const { node } = files(names);
      const host = tree({ items: [node] });
      press(host, 'right');
      expect(picture(host)).toEqual([
        '❯ └── ▾ dir',
        '      ├──   a',
        '      ├──   b',
        '      └──   c',
      ]);

      names.splice(1, 1);
      flush();
      // kept, which is the point of keeping it -- and why it has to be told
      expect(picture(host)).toContain('      ├──   b');
      expect(control(host).reload('dir')).toBe(true);
      flush();
      expect(picture(host)).toEqual(['❯ └── ▾ dir', '      ├──   a', '      └──   c']);
    });

    it('should keep the cursor on its node across a reload', () => {
      const names = ['a', 'b', 'c'];
      const { node } = files(names);
      const host = tree({ items: [node] });
      press(host, 'right');
      press(host, 'right');
      press(host, 'down');
      press(host, 'down');
      expect(control(host).current.get()).toBe('c');

      names.splice(1, 1);
      control(host).reload('dir');
      flush();
      expect(control(host).current.get()).toBe('c');
      expect(picture(host)).toEqual(['  └── ▾ dir', '      ├──   a', '❯     └──   c']);
    });

    it('should show what the last read found until a read again lands, cursor and all', async () => {
      const reads = [deferred<string[]>(), deferred<string[]>()];
      let calls = 0;
      const host = tree({
        items: [
          { items: () => (reads[calls++] as { promise: Promise<string[]> }).promise, text: 'r' },
        ],
      });
      press(host, 'right');
      reads[0]?.resolve(['a', 'b', 'c']);
      await landed();
      control(host).current.set('c');
      flush();

      expect(control(host).reload('r')).toBe(true);
      flush();
      expect(calls).toBe(2);
      // no loading line where the children were: the cursor has nowhere it would
      // have to go
      expect(control(host).status('r')).toBe('loading');
      expect(picture(host)).toEqual([
        '  └── ▾ r',
        '      ├──   a',
        '      ├──   b',
        '❯     └──   c',
      ]);
      expect(control(host).current.get()).toBe('c');

      reads[1]?.resolve(['a', 'c']);
      await landed();
      expect(control(host).status('r')).toBe('loaded');
      expect(picture(host)).toEqual(['  └── ▾ r', '      ├──   a', '❯     └──   c']);
      expect(control(host).current.get()).toBe('c');
    });

    it('should drop a read again that a second reload() superseded, and keep showing the old answer', async () => {
      const reads = [deferred<string[]>(), deferred<string[]>(), deferred<string[]>()];
      let calls = 0;
      const host = tree({
        items: [
          { items: () => (reads[calls++] as { promise: Promise<string[]> }).promise, text: 'r' },
        ],
      });
      press(host, 'right');
      reads[0]?.resolve(['old']);
      await landed();

      control(host).reload('r');
      flush();
      control(host).reload('r');
      flush();
      expect(calls).toBe(3);
      reads[1]?.resolve(['superseded']);
      await landed();
      expect(picture(host)).toEqual(['❯ └── ▾ r', '      └──   old']);
      reads[2]?.resolve(['new']);
      await landed();
      expect(picture(host)).toEqual(['❯ └── ▾ r', '      └──   new']);
    });

    it('should put the cursor on the branch when a read again fails under it', async () => {
      let fail = false;
      const host = tree({
        items: [
          {
            items: async () => {
              if (fail) {
                throw new Error('gone');
              }
              return ['a', 'b'];
            },
            text: 'r',
          },
        ],
      });
      press(host, 'right');
      await landed();
      control(host).current.set('b');
      flush();

      fail = true;
      control(host).reload('r');
      flush();
      await landed();
      expect(picture(host, 40)).toEqual(['❯ └── ▾ r', '      └──   Could not load: gone']);
      expect(control(host).current.get()).toBe('r');
    });

    it('should leave the open set alone, and show an open branch under the one reloaded', () => {
      let inner = 0;
      const host = tree({
        items: [
          {
            items: () => [
              {
                items: () => {
                  inner++;
                  return ['deep'];
                },
                text: 'sub',
              },
              'leaf',
            ],
            text: 'top',
          },
        ],
      });
      const { expanded } = control(host);
      expanded.set(new Set(['top', 'sub']));
      flush();
      const open = expanded.get();
      expect(inner).toBe(1);

      control(host).reload('top');
      flush();
      expect(expanded.get()).toBe(open);
      // the one reloaded, and not the one under it
      expect(inner).toBe(1);
      expect(picture(host)).toEqual([
        '❯ └── ▾ top',
        '      ├── ▾ sub',
        '      │   └──   deep',
        '      └──   leaf',
      ]);
    });

    it('should hold the scroll where it was across a reload, while the read again is in flight too', async () => {
      const names = Array.from({ length: 30 }, (_, i) => `f${String(i).padStart(2, '0')}`);
      const again = deferred<string[]>();
      let calls = 0;
      const host = tree(
        {
          expanded: ['dir'],
          items: [{ items: () => (++calls === 1 ? [...names] : again.promise), text: 'dir' }],
        },
        5
      );
      control(host).current.set('f20');
      control(host).list.reveal('f20');
      flush();
      picture(host);
      const viewport = control(host).list.scroll.viewport;
      const before = viewport.scroll?.y;
      expect(before).toBeGreaterThan(0);

      // one below the view goes, which moves nothing in it
      expect(control(host).reloadAll()).toBe(true);
      flush();
      picture(host);
      expect(calls).toBe(2);
      expect(viewport.scroll?.y).toBe(before);
      again.resolve(names.slice(0, -1));
      await landed();
      picture(host);
      expect(viewport.scroll?.y).toBe(before);
      expect(control(host).current.get()).toBe('f20');
    });

    it('should read again with the function the node has now, not the one it was read with', () => {
      const first = { items: () => ['before'], text: 'dir' };
      const top = new State<readonly TreeChoiceItem[]>([first]);
      const host = tree({ items: top });
      press(host, 'right');

      // the shape an immutable tree has: a new node, the same value, new children
      top.set([{ items: () => ['after'], text: 'dir' }]);
      flush();
      expect(picture(host)).toEqual(['❯ └── ▾ dir', '      └──   before']);
      control(host).reload('dir');
      flush();
      expect(picture(host)).toEqual(['❯ └── ▾ dir', '      └──   after']);
    });

    it('should wait for a branch read again before reading what is under it, which may be a new node', async () => {
      // an immutable tree: the answer above hands over a new node under the same
      // value, and its function -- not the one the cached node had -- is the one to call
      let oldCalls = 0;
      const mid = (kids: string[], count = false): TreeChoiceItem => ({
        items: () => {
          if (count) {
            oldCalls++;
          }
          return kids;
        },
        text: 'mid',
      });
      let kids = [mid(['v1'], true)];
      const host = tree({
        expanded: ['root', 'mid'],
        items: [{ items: async () => kids, text: 'root' }],
      });
      await landed();
      expect(picture(host)).toEqual(['❯ └── ▾ root', '      └── ▾ mid', '          └──   v1']);
      expect(oldCalls).toBe(1);

      kids = [mid(['v2'])];
      expect(control(host).reloadAll()).toBe(true);
      flush();
      // still the last answer while the one above is out, and the old function
      // is not called for it
      expect(picture(host)).toEqual(['❯ └── ▾ root', '      └── ▾ mid', '          └──   v1']);
      expect(oldCalls).toBe(1);
      await landed();
      expect(picture(host)).toEqual(['❯ └── ▾ root', '      └── ▾ mid', '          └──   v2']);
      expect(control(host).status('mid')).toBe('loaded');
      expect(oldCalls).toBe(1);
    });

    it('should take the reads under a branch out of date when its read again fails', async () => {
      let fail = false;
      let leaf = 'leaf';
      const host = tree({
        expanded: ['top', 'mid'],
        items: [
          {
            items: async () => {
              if (fail) {
                throw new Error('offline');
              }
              return [{ items: () => [leaf], text: 'mid' }];
            },
            text: 'top',
          },
        ],
      });
      await landed();
      expect(picture(host)).toContain('          └──   leaf');

      fail = true;
      control(host).reload('top');
      flush();
      await landed();
      expect(picture(host, 40)).toEqual(['❯ └── ▾ top', '      └──   Could not load: offline']);

      // the answer is gone, so a subtree reload can no longer find what was
      // under it -- which is why the failure marked it
      fail = false;
      leaf = 'new';
      expect(control(host).reload('top', { subtree: true })).toBe(true);
      flush();
      await landed();
      expect(picture(host)).toEqual(['❯ └── ▾ top', '      └── ▾ mid', '          └──   new']);
    });

    it('should walk again when a failure marks a branch the walk had already drawn', async () => {
      // review round 2: an answer kept while its branch was closed names a value
      // shown elsewhere -- which the walk only refuses when both are shown -- and
      // the read again that fails marks that one stale after its row was built
      const later = deferred<TreeChoiceItem[]>();
      let fail = false;
      let reads = 0;
      const host = tree({
        items: [
          {
            items: () => {
              reads++;
              return ['kept'];
            },
            text: 'a',
          },
          {
            items: () => {
              if (fail) {
                throw new Error('gone');
              }
              return later.promise;
            },
            text: 'b',
          },
        ],
      });
      const { collapse, expand, reload } = control(host);
      expand('a');
      expand('b');
      flush();
      collapse('b');
      flush();
      later.resolve([{ items: () => ['x'], text: 'a' }]);
      await landed();
      expand('b');
      flush();
      expect(reads).toBe(1);

      fail = true;
      reload('b');
      flush();
      // a was marked by the failure and read again by the walk it asked for
      expect(reads).toBe(2);
      expect(reload('a')).toBe(true);
    });

    it('should reload a subtree: every read branch under one, open or closed', () => {
      const calls: Record<string, number> = { closed: 0, open: 0, other: 0, top: 0 };
      const counted = (name: string, items: TreeChoiceItem[]) => (): TreeChoiceItem[] => {
        calls[name] = (calls[name] ?? 0) + 1;
        return items;
      };
      const host = tree({
        items: [
          {
            items: counted('top', [
              { items: counted('open', ['o']), text: 'open' },
              // a list in between: a read under it is still in the subtree
              { items: [{ items: counted('closed', ['c']), text: 'closed' }], text: 'plain' },
            ]),
            text: 'top',
          },
          { items: counted('other', ['x']), text: 'other' },
        ],
      });
      const { expanded, reload } = control(host);
      expanded.set(new Set(['top', 'open', 'plain', 'closed', 'other']));
      flush();
      expanded.set(new Set(['top', 'open', 'plain', 'other']));
      flush();
      expect(calls).toEqual({ closed: 1, open: 1, other: 1, top: 1 });

      expect(reload('top', { subtree: true })).toBe(true);
      flush();
      // the open ones at once, the closed one when it opens, and nothing beside
      expect(calls).toEqual({ closed: 1, open: 2, other: 1, top: 2 });
      expect(control(host).expand('closed')).toBe(true);
      flush();
      expect(calls).toEqual({ closed: 2, open: 2, other: 1, top: 2 });

      // a value with no read under it has nothing to forget
      expect(reload('o', { subtree: true })).toBe(false);
    });

    it('should reload every read branch with reloadAll(), and say when there was nothing to', () => {
      let a = 0;
      let b = 0;
      const host = tree({
        items: [
          { items: () => [`a${++a}`], text: 'a' },
          { items: () => [`b${++b}`], text: 'b' },
        ],
      });
      expect(control(host).reloadAll()).toBe(false);
      control(host).expand('a');
      control(host).expand('b');
      flush();
      control(host).collapse('b');
      flush();

      expect(control(host).reloadAll()).toBe(true);
      // already out of date, so nothing more to forget until they are read
      expect(control(host).reloadAll()).toBe(false);
      flush();
      expect([a, b]).toEqual([2, 1]);
      control(host).expand('b');
      flush();
      expect([a, b]).toEqual([2, 2]);
      expect(picture(host)).toEqual(['❯ ├── ▾ a', '  │   └──   a2', '  └── ▾ b', '      └──   b2']);
    });
  });

  describe('values that leave the tree (SIG-487)', () => {
    /** What the tree holds on to, but for the rows it shows. */
    const held = (
      host: Element
    ): Omit<NonNullable<ReturnType<typeof treeListHeld>>, 'rows'> | undefined => {
      const all = treeListHeld(host);
      return all && { kept: all.kept, notes: all.notes, reads: all.reads, seen: all.seen };
    };

    /** A branch whose function counts its calls, under `name`, and hands back `items()`. */
    function counting(
      calls: Record<string, number>,
      name: string,
      items: () => TreeChoiceItem[]
    ): TreeChoiceItem {
      return {
        items: () => {
          calls[name] = (calls[name] ?? 0) + 1;
          return items();
        },
        text: name,
      };
    }

    it('should drop the reads and the values of nodes that leave the tree, and keep what is shown', () => {
      const calls: Record<string, number> = {};
      const deep = counting(calls, 'deep', () => ['z']);
      const a = counting(calls, 'a', () => ['a1', deep]);
      const b = counting(calls, 'b', () => ['b1']);
      const items = new State<TreeChoiceItem[]>([a, b]);
      const host = tree({ expanded: ['a', 'deep', 'b'], items });
      expect(held(host)).toEqual({ kept: 0, notes: 0, reads: 3, seen: 6 });

      items.set([b]);
      flush();
      expect(held(host)).toEqual({ kept: 0, notes: 0, reads: 1, seen: 2 });
      expect(control(host).status('a')).toBe('idle');
      expect(control(host).status('deep')).toBe('idle');
      expect(control(host).status('b')).toBe('loaded');
      expect(picture(host)).toEqual(['❯ └── ▾ b', '      └──   b1']);
      expect(calls).toEqual({ a: 1, b: 1, deep: 1 });
    });

    it('should read an open branch that comes back again, rather than show what it found before', () => {
      let answer = ['old'];
      const calls: Record<string, number> = {};
      const a = counting(calls, 'a', () => answer);
      const items = new State<TreeChoiceItem[]>([a, 'b']);
      const host = tree({ expanded: ['a'], items });

      items.set(['b']);
      flush();
      answer = ['new'];
      items.set([a, 'b']);
      flush();
      expect(calls).toEqual({ a: 2 });
      expect(picture(host)).toEqual(['  ├── ▾ a', '  │   └──   new', '❯ └──   b']);
    });

    it('should keep the reads under a closed branch, which is still in the tree', () => {
      const calls: Record<string, number> = {};
      const deep = counting(calls, 'deep', () => ['z']);
      const a = counting(calls, 'a', () => ['a1', deep]);
      const items = new State<TreeChoiceItem[]>([a]);
      const host = tree({ expanded: ['a', 'deep'], items });
      control(host).collapse('a');
      flush();

      // a new tree is what sets the tree looking for values that went
      items.set([a, 'c']);
      flush();
      expect(held(host)).toEqual({ kept: 0, notes: 0, reads: 2, seen: 5 });
      control(host).expand('a');
      flush();
      expect(calls).toEqual({ a: 1, deep: 1 });
      expect(picture(host)).toEqual([
        '❯ ├── ▾ a',
        '  │   ├──   a1',
        '  │   └── ▾ deep',
        '  │       └──   z',
        '  └──   c',
      ]);
    });

    it('should drop the reads under an answer that a read again replaced', () => {
      let answer: TreeChoiceItem[] = [];
      const calls: Record<string, number> = {};
      const deep = counting(calls, 'deep', () => ['z']);
      answer = ['a1', deep];
      const host = tree({
        expanded: ['a', 'deep'],
        items: [counting(calls, 'a', () => answer)],
      });
      expect(held(host)).toEqual({ kept: 0, notes: 0, reads: 2, seen: 4 });

      answer = ['a1'];
      control(host).reload('a');
      flush();
      expect(held(host)).toEqual({ kept: 0, notes: 0, reads: 1, seen: 2 });
      expect(control(host).status('deep')).toBe('idle');

      // and it is new when it comes back: open, since the open set keeps it, and read
      answer = ['a1', deep];
      control(host).reload('a');
      flush();
      expect(calls).toEqual({ a: 3, deep: 2 });
      expect(picture(host)).toEqual([
        '❯ └── ▾ a',
        '      ├──   a1',
        '      └── ▾ deep',
        '          └──   z',
      ]);
    });

    it('should drop the loading line of a branch that left while its read was out, and the read', async () => {
      const read = deferred<string[]>();
      const items = new State<TreeChoiceItem[]>([{ items: () => read.promise, text: 'slow' }, 'b']);
      const host = tree({ expanded: ['slow'], items });
      expect(held(host)).toEqual({ kept: 0, notes: 1, reads: 1, seen: 2 });

      items.set(['b']);
      flush();
      expect(held(host)).toEqual({ kept: 0, notes: 0, reads: 0, seen: 1 });
      read.resolve(['late']);
      await landed();
      expect(held(host)).toEqual({ kept: 0, notes: 0, reads: 0, seen: 1 });
      expect(picture(host)).toEqual(['❯ └──   b']);
    });

    it('should not look through what it holds when the tree only grew', () => {
      const items = new State<TreeChoiceItem[]>(Array.from({ length: 10_000 }, (_, i) => `n${i}`));
      const host = tree({ items });
      const keys = vi.spyOn(Map.prototype, 'keys');
      try {
        items.set([...items.get(), 'more']);
        flush();
        const sizes = keys.mock.contexts.map((held) => (held as Map<unknown, unknown>).size);
        expect(sizes.filter((size) => size > 10_000)).toEqual([]);
      } finally {
        keys.mockRestore();
      }
      expect(held(host)?.seen).toBe(10_001);
    });

    it('should count a value once that is both shown and under a closed branch', () => {
      const items = new State<TreeChoiceItem[]>([{ items: ['dup', 'gone'], text: 'a' }]);
      const host = tree({ expanded: ['a'], items });
      control(host).collapse('a');
      flush();
      expect(held(host)?.seen).toBe(3);

      // `dup` is met twice, under `a` and at the margin, and `gone` is not met at
      // all: counted twice, the one would hide the other
      items.set([{ items: ['dup'], text: 'a' }, 'dup']);
      flush();
      expect(held(host)?.seen).toBe(2);
    });

    it('should count a value once that is shown before it is met under a closed branch', () => {
      const items = new State<TreeChoiceItem[]>([{ items: ['dup', 'gone'], text: 'a' }]);
      const host = tree({ expanded: ['a'], items });
      control(host).collapse('a');
      flush();

      // the other order from the test above: shown at the margin first, then met
      // under `a`
      items.set(['dup', { items: ['dup'], text: 'a' }]);
      flush();
      expect(held(host)?.seen).toBe(2);
    });

    it('should look for values that left a tree its source changed in place', () => {
      const tick = new State(0);
      const calls: Record<string, number> = {};
      const a = counting(calls, 'a', () => ['x']);
      const nodes: TreeChoiceItem[] = [a, 'b'];
      const host = tree({
        expanded: ['a'],
        items: {
          get: () => {
            tick.get();
            return nodes;
          },
        },
      });
      expect(held(host)).toEqual({ kept: 0, notes: 0, reads: 1, seen: 3 });

      nodes.shift();
      tick.set(1);
      flush();
      expect(held(host)).toEqual({ kept: 0, notes: 0, reads: 0, seen: 1 });
      nodes.unshift(a);
      tick.set(2);
      flush();
      expect(calls).toEqual({ a: 2 });
    });

    it('should keep what was under a branch while a read again of it has failed, so a retry finds it as it was', async () => {
      const calls: Record<string, number> = {};
      const deep = {
        expanded: true,
        ...(counting(calls, 'deep', () => ['z']) as Exclude<TreeChoiceItem, string>),
      };
      let fails = false;
      const a = {
        items: () => {
          calls.a = (calls.a ?? 0) + 1;
          return fails ? Promise.reject(new Error('offline')) : Promise.resolve(['a1', deep]);
        },
        text: 'a',
      };
      const items = new State<TreeChoiceItem[]>([a]);
      const host = tree({ expanded: ['a'], items });
      await landed();
      control(host).collapse('deep');
      flush();

      fails = true;
      control(host).reload('a');
      flush();
      await landed();
      expect(picture(host, 40)).toEqual(['❯ └── ▾ a', '      └──   Could not load: offline']);
      // a new tree while the error shows is no reason to forget what it hides
      items.set([a]);
      flush();
      expect(held(host)?.seen).toBe(4);

      fails = false;
      control(host).reload('a');
      flush();
      await landed();
      // `deep` stays closed, as the reader left it, and is read when it opens
      expect(control(host).expanded.get().has('deep')).toBe(false);
      expect(calls).toEqual({ a: 3, deep: 1 });
      expect(picture(host)).toEqual(['❯ └── ▾ a', '      ├──   a1', '      └── ▸ deep']);
    });

    it('should keep what a failed read replaced through a search during the retry (SIG-521)', async () => {
      const calls: Record<string, number> = {};
      const deep = {
        expanded: true,
        ...(counting(calls, 'deep', () => ['z']) as Exclude<TreeChoiceItem, string>),
      };
      let next: Promise<TreeChoiceItem[]> = Promise.resolve(['a1', deep]);
      const a = {
        items: () => {
          calls.a = (calls.a ?? 0) + 1;
          return next;
        },
        text: 'a',
      };
      const items = new State<TreeChoiceItem[]>([a]);
      const host = tree({ expanded: ['a'], items });
      await landed();
      control(host).collapse('deep');
      flush();

      next = Promise.reject(new Error('offline'));
      control(host).reload('a');
      flush();
      await landed();
      expect(control(host).status('a')).toBe('failed');

      // the retry is in flight, with the branch showing a loading line
      const retry = deferred<TreeChoiceItem[]>();
      next = retry.promise;
      control(host).reload('a');
      flush();
      expect(control(host).status('a')).toBe('loading');
      expect(picture(host, 40)).toEqual(['❯ └── ▾ a', '      └──   Loading…']);
      // what the failure replaced is held while the retry is out, and dropped when it lands
      expect(held(host)?.kept).toBe(1);

      // a new tree, which is what sets the walk looking for values that left
      items.set([a]);
      flush();
      retry.resolve(['a1', deep]);
      await landed();
      // `deep` was not new when the retry landed: still closed as the reader left it,
      // and not read again
      expect(control(host).expanded.get().has('deep')).toBe(false);
      expect(calls).toEqual({ a: 3, deep: 1 });
      expect(held(host)?.kept).toBe(0);
      expect(picture(host)).toEqual(['❯ └── ▾ a', '      ├──   a1', '      └── ▸ deep']);
    });

    it('should keep what a failed read replaced through a retry that fails again (SIG-521)', async () => {
      const calls: Record<string, number> = {};
      const deep = {
        expanded: true,
        ...(counting(calls, 'deep', () => ['z']) as Exclude<TreeChoiceItem, string>),
      };
      let next: Promise<TreeChoiceItem[]> = Promise.resolve(['a1', deep]);
      const a = { items: () => next, text: 'a' };
      const items = new State<TreeChoiceItem[]>([a]);
      const host = tree({ expanded: ['a'], items });
      await landed();
      control(host).collapse('deep');
      flush();

      for (let i = 0; i < 2; i++) {
        next = Promise.reject(new Error('offline'));
        control(host).reload('a');
        flush();
        await landed();
        expect(control(host).status('a')).toBe('failed');
        // the failure holds the answer itself, so it is not held twice
        expect(treeListHeld(host)?.kept).toBe(0);
      }
      // a reload while the second read is out supersedes it, and the kept answer stays
      next = new Promise(() => {});
      control(host).reload('a');
      flush();
      next = Promise.reject(new Error('offline'));
      control(host).reload('a');
      flush();
      await landed();
      items.set([a]);
      flush();
      next = Promise.resolve(['a1', deep]);
      control(host).reload('a');
      flush();
      await landed();
      expect(control(host).expanded.get().has('deep')).toBe(false);
      expect(calls.deep).toBe(1);
    });

    it('should not keep an answer for a value that is no longer a function branch (SIG-521)', async () => {
      let next: Promise<TreeChoiceItem[]> = Promise.resolve(['a1']);
      const items = new State<TreeChoiceItem[]>([{ items: () => next, text: 'a' }]);
      const host = tree({ expanded: ['a'], items });
      await landed();
      next = Promise.reject(new Error('offline'));
      control(host).reload('a');
      flush();
      await landed();
      control(host).collapse('a');
      flush();
      expect(treeListHeld(host)?.kept).toBe(1);

      items.set([{ items: ['q'], text: 'a' }]);
      flush();
      expect(treeListHeld(host)?.kept).toBe(0);
    });

    it('should keep what a failed read replaced while its branch is closed, and through a search (SIG-521)', async () => {
      const calls: Record<string, number> = {};
      const deep = {
        expanded: true,
        ...(counting(calls, 'deep', () => ['z']) as Exclude<TreeChoiceItem, string>),
      };
      let fails = false;
      const a = {
        items: () => {
          calls.a = (calls.a ?? 0) + 1;
          return fails ? Promise.reject(new Error('offline')) : Promise.resolve(['a1', deep]);
        },
        text: 'a',
      };
      const items = new State<TreeChoiceItem[]>([a]);
      const host = tree({ expanded: ['a'], items });
      await landed();
      control(host).collapse('deep');
      flush();

      fails = true;
      control(host).reload('a');
      flush();
      await landed();
      control(host).collapse('a');
      flush();
      expect(control(host).status('a')).toBe('idle');

      items.set([a]);
      flush();
      fails = false;
      control(host).expand('a');
      flush();
      await landed();
      expect(control(host).expanded.get().has('deep')).toBe(false);
      expect(calls).toEqual({ a: 3, deep: 1 });
    });

    it('should keep what a failed read replaced under a branch that is itself closed (SIG-521)', async () => {
      const calls: Record<string, number> = {};
      const deep = {
        expanded: true,
        ...(counting(calls, 'deep', () => ['z']) as Exclude<TreeChoiceItem, string>),
      };
      let fails = false;
      const a = {
        items: () => (fails ? Promise.reject(new Error('offline')) : Promise.resolve(['a1', deep])),
        text: 'a',
      };
      const outer = { items: [a], text: 'outer' };
      const items = new State<TreeChoiceItem[]>([outer]);
      const host = tree({ expanded: ['outer', 'a'], items });
      await landed();
      control(host).collapse('deep');
      flush();

      fails = true;
      control(host).reload('a');
      flush();
      await landed();
      control(host).collapse('a');
      flush();
      control(host).collapse('outer');
      flush();

      items.set([outer]);
      flush();
      expect(held(host)?.kept).toBe(1);
      fails = false;
      control(host).expand('outer');
      control(host).expand('a');
      flush();
      await landed();
      expect(control(host).expanded.get().has('deep')).toBe(false);
      expect(calls).toEqual({ deep: 1 });
    });

    it('should drop what a retry that lands without it takes out of the tree, at once (SIG-521)', async () => {
      const calls: Record<string, number> = {};
      const deep = counting(calls, 'deep', () => ['z']);
      let next: Promise<TreeChoiceItem[]> = Promise.resolve(['a1', deep]);
      const items = new State<TreeChoiceItem[]>([{ items: () => next, text: 'a' }]);
      const host = tree({ expanded: ['a', 'deep'], items });
      await landed();
      expect(held(host)?.seen).toBe(4);

      next = Promise.reject(new Error('offline'));
      control(host).reload('a');
      flush();
      await landed();
      next = Promise.resolve(['a1']);
      control(host).reload('a');
      flush();
      await landed();
      // the answer that replaced the failure's is a different one: `deep` is gone
      expect(held(host)).toEqual({ kept: 0, notes: 1, reads: 1, seen: 2 });
    });

    it('should drop what a failed read replaced when its branch leaves the tree during the retry (SIG-521)', async () => {
      const calls: Record<string, number> = {};
      const deep = {
        expanded: true,
        ...(counting(calls, 'deep', () => ['z']) as Exclude<TreeChoiceItem, string>),
      };
      let next: Promise<TreeChoiceItem[]> = Promise.resolve(['a1', deep]);
      const a = { items: () => next, text: 'a' };
      const items = new State<TreeChoiceItem[]>([a, 'b']);
      const host = tree({ expanded: ['a'], items });
      await landed();
      control(host).collapse('deep');
      flush();

      next = Promise.reject(new Error('offline'));
      control(host).reload('a');
      flush();
      await landed();
      next = new Promise(() => {});
      control(host).reload('a');
      flush();

      // gone while the retry is out, so the answer it kept goes too: back again, it
      // is a new branch, and `deep` is new with it
      items.set(['b']);
      flush();
      expect(held(host)?.kept).toBe(0);
      next = Promise.resolve(['a1', deep]);
      items.set([a, 'b']);
      flush();
      await landed();
      expect(control(host).expanded.get().has('deep')).toBe(true);
      expect(calls.deep).toBe(2);
    });

    it('should read a node that comes back with expanded: true as new, and open it again', () => {
      const node = { expanded: true, items: ['x'], text: 'a' };
      const items = new State<TreeChoiceItem[]>([node, 'b']);
      const host = tree({ items });
      control(host).collapse('a');
      flush();
      // closing sticks while it is in the tree
      items.set([node, 'b', 'c']);
      flush();
      expect(control(host).expanded.get().has('a')).toBe(false);

      items.set(['b', 'c']);
      flush();
      items.set([node, 'b', 'c']);
      flush();
      expect(control(host).expanded.get().has('a')).toBe(true);
    });

    it('should not look for values that left when a branch only opens or closes', () => {
      const leaves = (name: string): string[] =>
        Array.from({ length: 2_000 }, (_, i) => `${name} ${i}`);
      // never opened, so nothing under either can be held: one shown, one under a
      // branch that was open
      const never = { items: leaves('never'), text: 'never' };
      const inner = { items: leaves('inner'), text: 'inner' };
      const big = { items: [...leaves('big'), inner], text: 'big' };
      const items = new State<TreeChoiceItem[]>([big, never, { items: ['x'], text: 'small' }]);
      const host = tree({ expanded: ['big'], items });
      control(host).collapse('big');
      flush();
      expect(held(host)?.seen).toBe(2_004);

      // what is under a closed branch is looked through, a value at a time, only
      // when the tree may have lost some: never for opening one
      const get = vi.spyOn(Map.prototype, 'get');
      try {
        control(host).expand('small');
        flush();
        expect(get.mock.calls.length).toBeLessThan(200);
        get.mockClear();
        items.set([...items.get()]);
        flush();
        expect(get.mock.calls.length).toBeGreaterThan(2_000);
        expect(get.mock.calls.length).toBeLessThan(3_000);
      } finally {
        get.mockRestore();
      }
      expect(held(host)?.seen).toBe(2_005);
    });
  });

  describe('finding a row by its value (SIG-520)', () => {
    it('should hold a row for each row shown and no more, though the walk keeps its map from one walk to the next', () => {
      const items = new State<TreeChoiceItem[]>([{ items: ['x', 'y'], text: 'a' }, 'b', 'c']);
      const host = tree({ expanded: ['a'], items });
      expect(treeListHeld(host)?.rows).toBe(5);

      items.set([...items.get(), 'd']);
      flush();
      expect(treeListHeld(host)?.rows).toBe(6);

      // a node that leaves is not held for, and one that arrives is
      items.set(['b', 'd', 'e']);
      flush();
      expect(treeListHeld(host)?.rows).toBe(3);
      expect(picture(host)).toEqual(['❯ ├──   b', '  ├──   d', '  └──   e']);
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

  it('should draw the rows again once items with two nodes of one value are fixed', () => {
    // the walk throws, and the tree's effect reports it -- once, though the list
    // asks for a walk again whenever it takes its items, and the fixed items are
    // drawn when they arrive
    const written: string[] = [];
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      written.push(String(chunk));
      return true;
    });
    try {
      const items = new State<TreeChoiceItem[]>(['a', 'b']);
      const host = tree({ items });

      items.set(['a', 'a']);
      flush();
      // and once: the cursor moving asks the list for its rows again, which asks
      // for the walk again, which throws again
      press(host, 'down');
      control(host).current.set('b');
      flush();
      expect(written.join('').split('a is used twice')).toHaveLength(2);

      items.set(['a', 'c']);
      flush();
      expect(picture(host).slice(0, 2)).toEqual(['  ├──   a', '❯ └──   c']);
    } finally {
      stderr.mockRestore();
    }
  });

  it('should refuse a source that writes a signal while it is read, and say what to do', () => {
    // the source is read inside a Computed, which is what tells a change of the tree
    // from a read of it, and a Computed may not write -- so a lazy source that sets
    // its own `loading` on the first read is refused with the rule rather than with
    // the signal graph's own words
    const loading = new State(false);
    expect(() =>
      TreeListView({
        items: {
          get: () => {
            loading.set(true);
            return ['a'];
          },
        },
      })
    ).toThrow(
      'A TreeListView reads items.get() inside a Computed, so a source may not write a signal while it is read: write it before, or from an effect'
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

  // a Computed is not a State, so it was taken as the value the cursor starts on,
  // and a change to what it derives from was never read
  it('should refuse a Computed current, which the moves could not write', () => {
    const at = new State('a');
    const current = new Computed(() => at.get());
    expect(() => TreeListView({ current: current as never, items: [{ text: 'a' }] })).toThrow(
      'Expected tree current to be a value or a State, not a Computed, since the tree writes it'
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

  it('should say open for Enter, or the word the options give, for a tree with onActivate', () => {
    const tree = TreeListView({ items: [], onActivate: () => {} });
    const { live, router } = recorder();
    const enter = () =>
      live.filter(([keys]) => keys === 'enter').map(([, opts]) => opts.description);
    const off = describeTreeListView(router, tree);
    expect(enter()).toEqual(['open']);
    off();
    describeTreeListView(router, tree, { activate: 'map it' });
    expect(enter()).toEqual(['map it']);
    expect(live.every(([, opts]) => opts.scope === tree)).toBe(true);
  });

  it('should refuse an empty word for Enter before describing anything', () => {
    const tree = TreeListView({ items: [], onActivate: () => {} });
    const { live, router } = recorder();
    expect(() => describeTreeListView(router, tree, { activate: '' })).toThrow(
      'Expected activate to be a non-empty string'
    );
    expect(live).toHaveLength(0);
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
