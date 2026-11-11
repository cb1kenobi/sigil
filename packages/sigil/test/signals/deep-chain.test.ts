import {
  Computed,
  createEffects,
  hasSinks,
  State,
  Watcher,
  watched,
  unwatched,
} from '../../src/signals/index.js';
import { describe, expect, it } from 'vitest';

/**
 * A chain this long is far past any native stack this package runs on: the
 * write path used to overflow at a few thousand levels and a read at about two
 * thousand, and the three Node versions CI runs on do not agree on where. So the
 * assertions are about outcomes that hold whatever the limit is -- a value that
 * arrives, or the clear error with nothing cached -- and never about where the
 * stack runs out.
 */
const DEEP = 100_000;

/**
 * A chain of computeds over one state, each adding one to the one before it --
 * the shape of a running offset per row of a long list.
 *
 * @param bottomUp - Read each link as it is made, so every read is one level
 * deep and the chain ends up evaluated, with every edge in place.
 * @returns The state, every link in order, and the tail.
 */
function chain(bottomUp: boolean) {
  const s = new State(0);
  const links: Computed<number>[] = [];
  let prev: State<number> | Computed<number> = s;
  for (let i = 0; i < DEEP; i++) {
    const p = prev;
    const link = new Computed(() => p.get() + 1);
    links.push(link);
    if (bottomUp) {
      link.get();
    }
    prev = link;
  }
  return { s, links, tail: links[links.length - 1] };
}

describe('a deep computed chain', () => {
  it('should reach the tail with the second of two writes, which a half-marked graph never did', () => {
    // the write used to overflow part-way through marking: the version was
    // bumped, the upper part of the chain marked and the lower part not, and
    // the second write stopped at the first node already marked -- so the tail
    // served the value from before both writes, forever, with nothing said
    const { s, tail } = chain(true);
    let notified = 0;
    const w = new Watcher(() => notified++);
    w.watch(tail);

    s.set(1);
    w.watch();
    s.set(2);

    expect(tail.get()).toBe(DEEP + 2);
    expect(notified).toBe(2);

    s.set(3);
    expect(tail.get()).toBe(DEEP + 3);
  });

  it('should settle a deep chain after a write in one read from the tail', () => {
    // no user code is on the stack while a CHECK node asks its sources, so that
    // descent is flat however long the chain is, and what recomputes does it
    // from the bottom up one level at a time
    const { s, links, tail } = chain(true);
    s.set(10);
    expect(tail.get()).toBe(DEEP + 10);
    expect(links[0].get()).toBe(11);
  });

  it('should cut a deep settle off where a value stops changing', () => {
    const s = new State(0);
    let runs = 0;
    const parity = new Computed(() => s.get() % 2);
    let prev: Computed<number> = parity;
    for (let i = 0; i < DEEP; i++) {
      const p = prev;
      prev = new Computed(() => {
        runs++;
        return p.get();
      });
      prev.get();
    }
    const tail = prev;
    runs = 0;

    s.set(2);
    expect(tail.get()).toBe(0);
    expect(runs).toBe(0);

    s.set(3);
    expect(tail.get()).toBe(1);
    expect(runs).toBe(DEEP);
  });

  it('should make every link of a deep chain live, and every one unlive again', () => {
    // incLive and decLive recursed one frame per level, so watching the tail
    // threw part-way through and left the upper counts moved and the lower not
    const events: string[] = [];
    const s = new State(0, {
      [watched]: () => events.push('watched'),
      [unwatched]: () => events.push('unwatched'),
    });
    let prev: State<number> | Computed<number> = s;
    const links: Computed<number>[] = [];
    for (let i = 0; i < DEEP; i++) {
      const p = prev;
      const link = new Computed(() => p.get() + 1);
      link.get();
      links.push(link);
      prev = link;
    }
    const tail = links[links.length - 1];
    const w = new Watcher(() => {});

    w.watch(tail);
    expect(events).toEqual(['watched']);
    expect(hasSinks(s)).toBe(true);
    expect(links.every((link) => link.liveCount === 1)).toBe(true);

    w.unwatch(tail);
    expect(events).toEqual(['watched', 'unwatched']);
    expect(hasSinks(s)).toBe(false);
    expect(links.every((link) => link.liveCount === 0)).toBe(true);
  });

  it('should throw the clear error for a fresh chain too deep to read, and cache nothing', () => {
    // the first read of a fresh chain evaluates it through user code, one body
    // inside the next, so that recursion cannot be flattened. What it must not
    // do is cache the overflow: it used to stay on the link whose body hit the
    // limit, clean and with no edge to the source whose read never finished,
    // so no write and no later read could ever get past it
    const { s, links, tail } = chain(false);

    let first: unknown;
    try {
      tail.get();
    } catch (err) {
      first = err;
    }
    expect(first).toBeInstanceOf(RangeError);
    expect((first as Error).message).toMatch(/^Computed chain too deep/);
    expect((first as Error).cause).toBeInstanceOf(RangeError);

    // a second read is a fresh attempt rather than the cached error handed back
    let second: unknown;
    try {
      tail.get();
    } catch (err) {
      second = err;
    }
    expect((second as Error).message).toMatch(/^Computed chain too deep/);
    expect(second).not.toBe(first);

    // and the same chain read from the bottom up is perfectly readable
    for (const link of links) {
      link.get();
    }
    expect(tail.get()).toBe(DEEP);
    s.set(5);
    expect(tail.get()).toBe(DEEP + 5);
  });

  it('should still cache an ordinary RangeError a body throws', () => {
    // only running out of stack is exempt; any other throw is an answer
    let runs = 0;
    const thrown = new RangeError('Invalid array length');
    const c = new Computed(() => {
      runs++;
      throw thrown;
    });
    expect(() => c.get()).toThrow(thrown);
    expect(() => c.get()).toThrow(thrown);
    expect(runs).toBe(1);
  });

  it('should report an effect whose read was too deep once, rather than on every pass', () => {
    // a derivation is left dirty so a later read retries it, but a flush reads
    // anything not clean as still pending -- an effect left dirty would run on
    // every pass of the drain and be reported a hundred times over
    const own = createEffects();
    own.setScheduler(() => {});
    const errors: unknown[] = [];
    own.setErrorHandler((err) => errors.push(err));
    const { links, tail } = chain(false);
    const reading = new State(false);
    let runs = 0;
    own.effect(() => {
      runs++;
      if (reading.get()) {
        tail.get();
      }
    });

    reading.set(true);
    own.flush();

    expect(runs).toBe(2);
    expect(errors).toHaveLength(1);
    expect((errors[0] as Error).message).toMatch(/^Computed chain too deep/);

    for (const link of links) {
      link.get();
    }
    expect(tail.get()).toBe(DEEP);
  });
});
