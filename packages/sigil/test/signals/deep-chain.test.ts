import {
  Computed,
  createEffects,
  hasSinks,
  State,
  Watcher,
  watched,
  unwatched,
} from '../../src/signals/index.js';
import { spawn } from 'node:child_process';
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
function chain(bottomUp: boolean, catching = false) {
  const s = new State(0);
  const links: Computed<number>[] = [];
  let prev: State<number> | Computed<number> = s;
  for (let i = 0; i < DEEP; i++) {
    const p = prev;
    // a link that catches is a body falling back when its read fails, which is
    // the shape that can swallow the error and cache the fallback
    const link = new Computed(
      catching
        ? () => {
            try {
              return p.get() + 1;
            } catch {
              return -1;
            }
          }
        : () => p.get() + 1
    );
    links.push(link);
    if (bottomUp) {
      link.get();
    }
    prev = link;
  }
  return { s, links, tail: links[links.length - 1] };
}

/**
 * Runs the fresh-chain scenario in a node with a given native stack: two reads
 * of the tail too deep to finish, the chain read from the bottom up, a write,
 * and then every link compared with what it should hold.
 *
 * In a child because where the stack runs out decides which line of the graph's
 * own code is at the edge when it does, and one stack size in-process pins one
 * of those lines at most. Both regressions this covers were found by moving it.
 *
 * @param stackSize - The `--stack-size` to run under, in kilobytes.
 * @param catching - Whether every link catches a failed read and falls back.
 * @returns How many links were wrong, and anything the child wrote to stderr.
 */
function atStackSize(stackSize: number, catching: boolean): Promise<string> {
  const graph = new URL('../../src/signals/graph.ts', import.meta.url).href;
  const script = `
    const { State, Computed } = await import(${JSON.stringify(graph)});
    const s = new State(0);
    const links = [];
    let prev = s;
    for (let i = 0; i < 30000; i++) {
      const p = prev;
      links.push(new Computed(${
        catching
          ? '() => { try { return p.get() + 1; } catch { return -1; } }'
          : '() => p.get() + 1'
      }));
      prev = links[i];
    }
    for (let i = 0; i < 2; i++) { try { prev.get(); } catch {} }
    for (const link of links) link.get();
    s.set(100);
    let bad = 0;
    for (let i = 0; i < links.length; i++) if (links[i].get() !== i + 101) bad++;
    console.log('bad=' + bad);
  `;
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [
      `--stack-size=${stackSize}`,
      '--input-type=module',
      '-e',
      script,
    ]);
    let out = '';
    child.stdout.on('data', (chunk) => (out += chunk));
    child.stderr.on('data', (chunk) => {
      // Node 22 announces type stripping on stderr; anything else is the answer
      if (!/ExperimentalWarning|--trace-warnings/.test(String(chunk))) {
        out += chunk;
      }
    });
    child.on('close', () =>
      resolve(`${stackSize}/${catching ? 'catching' : 'plain'}: ${out.trim()}`)
    );
  });
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

  it('should report a CHECK effect over a deep chain of dirty links once, which settling its sources did not', () => {
    // every row's height changing at once dirties every link of a running
    // offset, so settling the effect's one source runs the whole chain through
    // user code before the effect's body can -- and that throw used to come out
    // of the asking, leave the effect CHECK, and be retried on every pass: a
    // hundred reports and then "did not settle"
    const own = createEffects();
    own.setScheduler(() => {});
    const errors: string[] = [];
    own.setErrorHandler((err) => errors.push((err as Error).message));
    const heights = Array.from({ length: DEEP }, () => new State(1));
    const offsets: Computed<number>[] = [];
    for (let i = 0; i < DEEP; i++) {
      const above = offsets[i - 1];
      offsets.push(new Computed(() => (above ? above.get() : 0) + heights[i].get()));
      offsets[i].get();
    }
    const tail = offsets[DEEP - 1];
    const seen: number[] = [];
    own.effect(() => {
      seen.push(tail.get());
    });

    for (const height of heights) {
      height.set(2);
    }
    own.flush();
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/^Computed chain too deep/);

    // the effect kept its edge, so the next write that reaches it once the
    // chain is readable runs it again
    for (const offset of offsets) {
      offset.get();
    }
    heights[0].set(5);
    own.flush();
    expect(seen).toEqual([DEEP, 2 * DEEP + 3]);
    expect(errors).toHaveLength(1);
  });

  it('should not cache a fallback a body returned for a read too deep to finish', () => {
    // the error left `refresh()` before `track()` ran, so a body that caught it
    // cached its fallback with no edge to the source it had failed to read --
    // and no write could ever reach it again
    const { s, links, tail } = chain(false);
    const safe = new Computed(() => {
      try {
        return tail.get();
      } catch {
        return -1;
      }
    });
    expect(safe.get()).toBe(-1);

    for (const link of links) {
      link.get();
    }
    expect(safe.get()).toBe(DEEP);
    s.set(5);
    expect(safe.get()).toBe(DEEP + 5);
  });

  it('should run an effect again that caught a read too deep to finish, once the chain is readable', () => {
    const own = createEffects();
    own.setScheduler(() => {});
    own.setErrorHandler(() => {});
    const { s, links, tail } = chain(false);
    const seen: (number | string)[] = [];
    own.effect(() => {
      try {
        seen.push(tail.get());
      } catch {
        seen.push('failed');
      }
    });

    for (const link of links) {
      link.get();
    }
    s.set(5);
    own.flush();
    expect(seen).toEqual(['failed', DEEP + 5]);
  });

  it('should leave no fallback behind in a chain whose every link catches a failed read', () => {
    // each link that caught returned -1 and committed it, so the links above
    // read -1 + 1, and the one at the edge of the stack held no edge to its
    // source -- a tail stuck at a number nowhere near the chain's. Several
    // fresh chains, because the worst of it showed only once the graph's code
    // was optimized: then the engine ran out at the call into `get()` itself,
    // where no code of the graph's runs to notice
    for (let round = 0; round < 4; round++) {
      const { s, links, tail } = chain(false, true);
      tail.get();

      for (const link of links) {
        link.get();
      }
      expect(tail.get()).toBe(DEEP);
      s.set(100);
      expect(tail.get()).toBe(DEEP + 100);
      expect(links.findIndex((link, i) => link.get() !== i + 101)).toBe(-1);
    }
  });

  it('should never leave a link clean over a value it did not commit, wherever the stack runs out', async () => {
    // two defects, each found only by moving where the stack runs out: the
    // catch in a run first runs cold at the edge of the stack and can overflow
    // itself, and so can the commit after a body that caught one and returned
    // -- and either way the link was marked CLEAN over nothing and read back
    // `undefined` or a fallback from then on. A Windows main thread has a
    // 1 MB stack, so a size past that would crash rather than overflow there
    const sizes = [300, 450, 600, 750, 900];
    if (process.platform !== 'win32') {
      sizes.push(1100, 1300, 1500, 1700, 1900);
    }
    const results = await Promise.all(
      sizes.flatMap((size) => [atStackSize(size, false), atStackSize(size, true)])
    );
    expect(results.filter((result) => !result.endsWith('bad=0'))).toEqual([]);
  }, 120_000);

  it('should throw rather than exhaust the heap on a cycle among CHECK computeds', () => {
    // a disposed computed read again by what it used to read is a cycle the
    // asking walks round. The recursion this replaced ran out of stack at once;
    // a loop over its own stack pushed until the heap ran out, which is a crash
    // rather than an error
    const s = new State(0);
    const y = new Computed(() => s.get());
    let readB = false;
    const box: { a?: Computed<number> } = {};
    const b = new Computed(() => (box.a as Computed<number>).get() + y.get());
    const a = new Computed(() => (readB ? b.get() : 1));
    box.a = a;
    expect(b.get()).toBe(1);
    a.dispose();
    readB = true;
    expect(a.get()).toBe(1);

    s.set(1);
    expect(() => a.get()).toThrow('A Computed may not read itself');
    expect(() => a.get()).toThrow('A Computed may not read itself');
  });

  it('should cache a body that overflows in its own code, under the engine message', () => {
    // a computed nothing else was evaluating around ran out of stack in its own
    // recursion, which is an answer about that body rather than about a chain
    let runs = 0;
    const recurse = (n: number): number => recurse(n + 1) + 1;
    const c = new Computed(() => {
      runs++;
      return recurse(0);
    });
    for (let i = 0; i < 3; i++) {
      expect(() => c.get()).toThrow('Maximum call stack size exceeded');
    }
    expect(runs).toBe(1);
  });
});
