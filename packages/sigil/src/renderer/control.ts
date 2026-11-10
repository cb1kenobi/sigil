/**
 * Control flow, as components.
 *
 * This is the tax a component body that runs once has to charge, and it should
 * be read as a deliberate decision rather than discovered. An `if` in a body
 * runs once and never again; a `.map()` builds the list it saw and nothing else.
 * So a conditional and a list are *components*, because a component is the only
 * thing that can own a branch and dispose it when the branch goes away.
 *
 * They are the runtime primitive rather than a convenience over one: a template
 * compiler (SIG-69) emits calls to these rather than growing a second way of
 * saying the same thing, so there is one implementation of what mounting and
 * unmounting a branch means.
 *
 * Both return a `box`, because a component produces exactly one node and this
 * layer has no fragment. That is a real cost in a flexbox world -- the wrapper is
 * a flex item and it lays out -- so both take `props`, and a `Show` inside a row
 * is usually written with `display: 'contents'`-shaped intent that does not exist
 * here: give the wrapper the layout the branch would have had.
 */

import { box, type Element, type ElementProps } from '../element/index.js';
import { State, untrack } from '../signals/index.js';
import { longestIncreasing } from '../util/longest-increasing.js';
import { createBranch, createEffect, type Owner, runWithOwner } from './owner.js';

/** Whatever `when` produced, where it counts as present. */
type Truthy<T> = Exclude<T, false | null | undefined>;

export interface ShowProps<T> {
  /** Built when `when` is absent. */
  fallback?: () => Element;
  /** The wrapper's own props. */
  props?: ElementProps;
  /**
   * Builds the branch.
   *
   * Handed an accessor onto what `when` produced rather than the value itself,
   * for the reason `For`'s index is one: the branch is kept while presence
   * holds, so a value passed at build time is frozen the moment the branch was
   * built. Reading the accessor inside an effect is how a branch follows a
   * value that changed without presence changing with it.
   */
  children: (value: () => Truthy<T>) => Element;
  /** Read reactively; `false`, `null` and `undefined` are absent. */
  when: () => T;
}

/**
 * Mounts a branch while `when` is present, and disposes it when it is not.
 *
 * Disposes rather than hides: a hidden branch is still a branch, its effects
 * still run, and a list of a thousand rows behind a closed disclosure still
 * costs a thousand rows of reactivity. Hiding is `visibility` and it is a
 * different question.
 *
 * The branch is rebuilt only when presence *changes*, not on every change to
 * what `when` returned -- a `when` that reads a counter would otherwise tear its
 * branch down and build it again on every tick, losing whatever state the branch
 * held.
 *
 * Which is why `children` is handed an **accessor** rather than the value. The
 * two go together and only one pairing is coherent: a branch kept across a value
 * change has to be able to read the new value, and a branch handed the value
 * itself would have to be rebuilt whenever it moved -- which is the thing the
 * paragraph above refuses. Handing over the value *and* keeping the branch is the
 * one combination that is wrong, and it is what this used to do: a
 * `when: () => user.get()` whose user changed from one object to another left the
 * branch rendering the first one for good, because presence never moved.
 *
 * @param props - The branch, the condition, and the wrapper's props.
 * @returns The wrapper element.
 */
export function Show<T>(props: ShowProps<T>): Element {
  const host = box(props.props ?? {});
  let dispose: (() => void) | undefined;
  let showing: boolean | undefined;
  /**
   * The last value `when` produced while present, so that the accessor the
   * branch holds is live. Never cleared: the only thing that can read it is a
   * branch, and a branch only exists while presence held -- so there is no
   * window in which it answers for an absence.
   */
  const current = new State<Truthy<T> | undefined>(undefined);

  createEffect(() => {
    const value = props.when();
    const present = value !== false && value !== null && value !== undefined;
    // written before the early return, because a value that moved while
    // presence held is exactly the case the early return is taken for
    if (present) {
      current.set(value as Truthy<T>);
    }
    if (present === showing) {
      return;
    }

    // built first, and nothing that is on screen is touched until it is. Every
    // other order leaves a failure half done, and both halves were written
    // before this one: committing `showing` first left it claiming a branch
    // that had thrown, and tearing the old branch down first left `showing`
    // claiming a branch that was gone. Either way the effect caches what it
    // threw and goes clean, so the presence that came back matched the recorded
    // one and returned early -- and the host stayed empty for good
    const build = present ? () => props.children(() => current.get() as Truthy<T>) : props.fallback;
    let branch: { dispose: () => void; owner: Owner } | undefined;
    let built: Element | undefined;
    if (build) {
      branch = createBranch();
      try {
        built = runWithOwner(branch.owner, () => untrack(build));
      } catch (error) {
        branch.dispose();
        throw error;
      }
    }

    dispose?.();
    dispose = branch?.dispose;
    // one child by construction, since a component produces exactly one node.
    // Emptied by asking for the first one until there is none rather than by
    // walking `children`, which hands back the live array -- removing while
    // iterating that skips every other entry
    while (host.children[0]) {
      host.children[0].remove();
    }
    showing = present;
    if (built) {
      host.append(built);
    }
  });

  return host;
}

export interface ForProps<T> {
  /** Read reactively. */
  each: () => readonly T[];
  /** Built while the list is empty. */
  fallback?: () => Element;
  /** The wrapper's own props. */
  props?: ElementProps;
  /**
   * Builds one row.
   *
   * The index is an accessor rather than a number because a row that moved
   * keeps its element: it is the same row, so rebuilding it to tell it where it
   * now sits would throw away the thing keying exists to keep. Reading the
   * accessor in an effect is how a row follows its own position.
   */
  children: (item: T, index: () => number) => Element;
}

interface Row<T> {
  dispose: () => void;
  element: Element;
  index: State<number>;
  item: T;
}

/**
 * Mounts one branch per item, keyed by the item itself.
 *
 * Keyed by identity rather than by position, which is what makes a list that
 * reorders keep each row's element -- and with it the row's effects, its focus,
 * and anything else attached to that element. Position keying rebuilds every row
 * after the first change, which for a terminal means the focus ring moves under
 * whoever was typing.
 *
 * Identity means an item that appears twice is two rows, so the bookkeeping is a
 * queue per key rather than one entry: two equal primitives in a list are a list
 * with two entries in it, not a bug to refuse.
 *
 * A reorder moves the fewest rows it can: the kept rows on a longest run that is
 * already in order stay where they are and only the rest are moved, so taking
 * the first row to the end is one move and swapping the two ends is two.
 *
 * @param props - The list, the row builder, and the wrapper's props.
 * @returns The wrapper element.
 */
export function For<T>(props: ForProps<T>): Element {
  const host = box(props.props ?? {});
  let rows: Row<T>[] = [];
  let fallback: { dispose: () => void; element: Element } | undefined;

  createEffect(() => {
    const items = props.each();

    // a queue per key, read through a cursor rather than by `shift()`: that is
    // O(k) for a key held k times, so a list of one repeated primitive was
    // quadratic to reconcile against itself
    const spare = new Map<T, { next: number; rows: Row<T>[] }>();
    for (const row of rows) {
      const held = spare.get(row.item);
      if (held) {
        held.rows.push(row);
      } else {
        spare.set(row.item, { next: 0, rows: [row] });
      }
    }

    /** Branches this pass built, and where each kept row's index came from. */
    const made: { dispose: () => void }[] = [];
    const moved: { from: number; row: Row<T> }[] = [];

    try {
      const next: Row<T>[] = [];
      for (const [at, item] of items.entries()) {
        const held = spare.get(item);
        const kept = held && held.next < held.rows.length ? held.rows[held.next++] : undefined;
        if (kept) {
          // the same row, possibly somewhere else: tell it where, and leave
          // everything it built alone
          // untracked: the next line writes this index, and a reconcile that read it
          // tracked would depend on a signal it is in the middle of changing
          moved.push({ from: untrack(() => kept.index.get()), row: kept });
          kept.index.set(at);
          next.push(kept);
          continue;
        }

        const branch = createBranch();
        made.push(branch);
        const index = new State(at);
        const element = runWithOwner(branch.owner, () =>
          untrack(() => props.children(item, () => index.get()))
        );
        next.push({ dispose: branch.dispose, element, index, item });
      }

      for (const held of spare.values()) {
        for (const row of held.rows.slice(held.next)) {
          row.element.remove();
          row.dispose();
        }
      }

      if (next.length > 0 && fallback) {
        fallback.element.remove();
        fallback.dispose();
        fallback = undefined;
      }

      place(host, next);

      rows = next;

      if (next.length === 0 && !fallback && props.fallback) {
        const branch = createBranch();
        made.push(branch);
        const element = runWithOwner(branch.owner, () => untrack(props.fallback as () => Element));
        fallback = { dispose: branch.dispose, element };
        host.append(element);
      }
    } catch (error) {
      // a reconcile that threw undoes its own half and leaves `rows` and
      // `fallback` describing what is still on screen. Everything it built goes
      // -- including the branch it was part way through, which is why `made`
      // takes the branch rather than the finished row -- and every index it had
      // already moved goes back, since an effect caches what it threw and a row
      // left reading a position this pass never placed it at paints the wrong
      // number at the old spot
      for (const branch of made) {
        branch.dispose();
      }
      for (const { from, row } of moved) {
        row.index.set(from);
      }
      throw error;
    }
  });

  return host;
}

/**
 * Puts `rows`' elements into `host` in order, moving as few of them as it can.
 *
 * Moving only what is out of place matters twice over: `insertBefore` marks the
 * parent's children dirty, so a list that re-inserts every row restyles every
 * sibling of every row, and each one is a removal and an insertion that both
 * search the children, so a move costs the length of the list. The first answer
 * walked the target order and moved every row not already at its index -- which
 * is "out of place" by position, and by that measure taking the first row to the
 * end puts every other row out of place: n-1 moves, each O(n), for what is one
 * move. So the question is asked by order instead. The rows already in `host`
 * that lie on a longest increasing run of their current positions are in order
 * relative to one another and stay; every other row, the new ones among them, is
 * moved in front of the row that follows it, walking from the end so that the
 * row it goes in front of is already where it belongs.
 *
 * Positions are read off `host` rather than off the rows' previous indices, so
 * what is on screen is what is placed against, whatever put it there.
 *
 * @param host - The wrapper the rows belong in.
 * @param rows - The rows, in the order they are wanted.
 */
function place(host: Element, rows: readonly { element: Element }[]): void {
  const now = new Map<Element, number>();
  for (const [at, child] of host.children.entries()) {
    now.set(child, at);
  }

  /** Which of `rows` are in `host` already, and where each of those sits. */
  const present: number[] = [];
  const from: number[] = [];
  for (const [at, row] of rows.entries()) {
    const was = now.get(row.element);
    if (was !== undefined) {
      present.push(at);
      from.push(was);
    }
  }

  const stays = new Uint8Array(rows.length);
  for (const k of longestIncreasing(from)) {
    stays[present[k]] = 1;
  }

  let before: Element | undefined;
  for (let at = rows.length - 1; at >= 0; at--) {
    const { element } = rows[at];
    if (!stays[at]) {
      host.insertBefore(element, before);
    }
    before = element;
  }
}
