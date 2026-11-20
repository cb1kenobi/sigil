import type * as ListViewModule from '../../src/components/list-view.js';
import { TreeListView } from '../../src/components/tree-list-view.js';
import type { TreeChoiceItem } from '../../src/components/tree.js';
import { renderToLines } from '../../src/element/index.js';
import { flush, State } from '../../src/signals/index.js';
import { describe, expect, it, vi } from 'vitest';

/**
 * How many rows a change of a tree makes its list key again (SIG-471).
 *
 * A list asks `key` only for the rows a change added, where the rows it holds are
 * the ones it last keyed with some dropped off the front and some added at the end
 * (SIG-386). The tree's rows are its own objects, so whether that holds is the
 * tree's to keep: a row whose guide alone moved has to be the object it was. The
 * key function the tree hands its list is wrapped here and counted, which is the
 * one place that says how many rows were keyed. In a file of its own because the
 * wrap is a module mock.
 */

const counted = vi.hoisted(() => ({ keys: 0 }));

vi.mock('../../src/components/list-view.js', async (importOriginal) => {
  const real = await importOriginal<typeof ListViewModule>();
  return {
    ...real,
    ListView: ((props) => {
      const key = props.key;
      return real.ListView({
        ...props,
        key: key
          ? (item) => {
              counted.keys++;
              return key(item);
            }
          : undefined,
      });
    }) as typeof real.ListView,
  };
});

/** A tree in a viewport ten rows tall, drawn once so it has a layout. */
function tree(items: State<TreeChoiceItem[]>, expanded: string[] = []): void {
  const host = TreeListView({ ascii: false, expanded, items, props: { height: 10 } });
  renderToLines(host, { width: 40 });
}

/** How many rows the list keyed for one change of the items. */
function keyed(items: State<TreeChoiceItem[]>, next: TreeChoiceItem[]): number {
  counted.keys = 0;
  items.set(next);
  flush();
  return counted.keys;
}

describe('TreeListView() keying its rows', () => {
  it('should key only the nodes appended, however many rows it holds', () => {
    const items = new State<TreeChoiceItem[]>(Array.from({ length: 10_000 }, (_, i) => `n${i}`));
    tree(items);

    // the last node's guide moves from └ to ├, which is not a row of its own: the
    // first row is keyed to find where the old rows start, and the three added ones
    expect(keyed(items, [...items.get(), 'a', 'b', 'c'])).toBe(4);
  });

  it('should key only the node appended after an open branch, whose rows all moved their guides', () => {
    const children = Array.from({ length: 5_000 }, (_, i) => ({ text: `child ${i}` }));
    const items = new State<TreeChoiceItem[]>([
      { items: ['x'], text: 'first' },
      { items: children, text: 'last' },
    ]);
    tree(items, ['first', 'last']);

    // every row under `last` goes from └'s indent to │'s
    expect(keyed(items, [...items.get(), 'after'])).toBe(2);
  });

  it('should key every row where a node was replaced, which is a row the list has not seen', () => {
    const items = new State<TreeChoiceItem[]>(Array.from({ length: 1_000 }, (_, i) => `n${i}`));
    tree(items);
    const now = items.get();

    // the limit, pinned so that it is a decision: a replaced node is a new item to
    // the list, and the list's fast path is for rows kept as they were
    expect(keyed(items, [...now.slice(0, 500), 'other', ...now.slice(501)])).toBe(1_000 + 1);
  });
});
