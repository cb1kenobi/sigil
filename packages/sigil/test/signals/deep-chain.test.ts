import {
  Computed,
  createEffects,
  hasSinks,
  State,
  Watcher,
  watched,
  unwatched,
} from '../../src/signals/index.js';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';

/**
 * The built signals entry, which the stack-size children import. Built rather
 * than the source because a child is plain node: type stripping erases types
 * and does not rewrite specifiers, so `graph.ts` imported as source works only
 * for as long as it imports nothing -- the first `./x.js` import in it is a
 * module not found in every child. The suite's other children read `dist/` for
 * the same reason, and build it the same way when it is missing.
 */
const dist = join(resolve(dirname(fileURLToPath(import.meta.url)), '../..'), 'dist', 'signals.mjs');

beforeAll(() => {
  // built only when missing, as the suite's other children do: `pnpm test`
  // builds first, while a filtered or watched run reads whatever `dist/` holds
  if (!existsSync(dist)) {
    const root = resolve(dirname(dist), '..');
    const built = spawnSync('pnpm', ['build'], { cwd: root, encoding: 'utf-8' });
    // a build that never started has no output to report, so say what stopped
    // it instead of printing two `undefined`s
    if (built.error || built.status !== 0) {
      throw new Error(
        `build failed:\n${built.error?.message ?? `${built.stdout}\n${built.stderr}`}`
      );
    }
  }
}, 120000);

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

/**
 * What a child runs, by name: `plain` is the fresh-chain scenario -- two reads
 * of the tail too deep to finish, the chain read from the bottom up, a write,
 * and how many links then disagree with what they should hold. `twice` is a
 * chain whose every link reads its source twice, catching each time, and how
 * many runs one read of its tail took.
 */
const scenarios = {
  plain: `
    const s = new State(0);
    const links = [];
    let prev = s;
    for (let i = 0; i < 30000; i++) {
      const p = prev;
      links.push(new Computed(() => p.get() + 1));
      prev = links[i];
    }
    for (let i = 0; i < 2; i++) { try { prev.get(); } catch {} }
    for (const link of links) link.get();
    s.set(100);
    let bad = 0;
    for (let i = 0; i < links.length; i++) if (links[i].get() !== i + 101) bad++;
    console.log('bad=' + bad);
  `,
  twice: `
    const s = new State(0);
    const links = [];
    let runs = 0;
    for (let i = 0; i < 30000; i++) {
      const p = i > 0 ? links[i - 1] : s;
      links.push(new Computed(() => {
        // bounded, so that the failure this guards is a number and not a hang
        if (++runs > 200000) { console.log('runs=' + runs); process.exit(0); }
        let a = 0, b = 0;
        try { a = p.get(); } catch {}
        try { b = p.get(); } catch {}
        return Math.max(a, b) + 1;
      }));
    }
    links[29999].get();
    console.log('runs=' + runs);
  `,
  passonce: `
    const height = new State(1);
    const links = [];
    for (let i = 0; i < 30000; i++) {
      const p = links[i - 1];
      const q = links[i - 2];
      links.push(new Computed(() => (p ? p.get() : 0) + (q ? q.get() * 0 : 0) + height.get()));
      links[i].get();
    }
    height.set(2);
    try { links[29999].get(); } catch {}
    const started = performance.now();
    height.set(3);
    console.log('ms=' + Math.round(performance.now() - started));
  `,
};

/**
 * Runs a scenario in a node with a given native stack.
 *
 * In a child because where the stack runs out decides which line of the graph's
 * own code is at the edge when it does, and one stack size in-process pins one
 * of those lines at most -- the doubling `twice` guards does not reproduce
 * inside the test runner's own worker at all. And because a child can be
 * killed: `passonce` guards a write that, broken, never returns.
 *
 * @param stackSize - The `--stack-size` to run under, in kilobytes.
 * @param scenario - Which scenario to run.
 * @returns What the child printed, and anything it wrote to stderr.
 */
function atStackSize(stackSize: number, scenario: keyof typeof scenarios): Promise<string> {
  const script = `
    const { State, Computed } = await import(${JSON.stringify(pathToFileURL(dist).href)});
    ${scenarios[scenario]}
  `;
  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      [`--stack-size=${stackSize}`, '--input-type=module', '-e', script],
      { timeout: 30_000 }
    );
    let out = '';
    child.stdout.on('data', (chunk) => (out += chunk));
    child.stderr.on('data', (chunk) => (out += chunk));
    child.on('close', () => resolve(`${stackSize}: ${out.trim()}`));
  });
}

/**
 * The stack sizes the children run under. A Windows main thread has a 1 MB
 * stack, so a size past that would crash rather than overflow there.
 */
const sizes = [300, 450, 600, 750, 900];
if (process.platform !== 'win32') {
  sizes.push(1100, 1300, 1500, 1700, 1900);
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

  it('should give a fallback a body returned for a read too deep to finish an edge, so a write reaches it', () => {
    // the error left `refresh()` before `track()` ran, so a body that caught it
    // cached its fallback with no edge to the source it had failed to read --
    // and no write could ever reach it again. The fallback is the body's answer
    // and is cached like one; what changed is that it is no longer final
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

  it('should pass a write through a derivation a too-deep read left dirty, to the effect that read it', () => {
    // the derivation between the chain and the effect was left DIRTY by the
    // failed read, and a write stops at a node already dirty -- so the effect,
    // clean over its error, never heard of the chain again however readable it
    // became. A run that never finished is passed through once instead
    for (const catching of [false, true]) {
      const own = createEffects();
      own.setScheduler(() => {});
      own.setErrorHandler(() => {});
      const { s, links, tail } = chain(false);
      const mid = new Computed(
        catching
          ? () => {
              try {
                return tail.get();
              } catch {
                return -1;
              }
            }
          : () => tail.get()
      );
      const seen: (number | string)[] = [];
      own.effect(() => {
        try {
          seen.push(mid.get());
        } catch {
          seen.push('failed');
        }
      });

      for (const link of links) {
        link.get();
      }
      s.set(5);
      own.flush();
      s.set(6);
      own.flush();
      expect(seen).toEqual([catching ? -1 : 'failed', DEEP + 5, DEEP + 6]);
    }
  });

  it('should hear a chain that comes back to the value it held before a read of it failed', () => {
    // the failed read was recorded at the version the abandoned node was still
    // at, so when it recomputed to the value it held before -- no new version --
    // its reader saw nothing changed: a catching derivation kept its fallback, a
    // catching effect its "failed", and a plain effect never ran again. A
    // derivation that was only asking its sources when they ran out stayed
    // CHECK, and the next write stopped there before the effect behind it
    const modes = ['derivation', 'CHECK derivation', 'catching effect', 'plain effect'] as const;
    for (const mode of modes) {
      const own = createEffects();
      own.setScheduler(() => {});
      const errors: unknown[] = [];
      own.setErrorHandler((err) => errors.push(err));
      const height = new State(1);
      const trigger = new State(0);
      const links: Computed<number>[] = [];
      for (let i = 0; i < DEEP; i++) {
        const above = links[i - 1];
        links.push(new Computed(() => (above ? above.get() : 0) + height.get()));
        links[i].get();
      }
      const tail = links[DEEP - 1];
      // reading the trigger dirties it directly, so its body runs and catches;
      // without, it is CHECK and the error comes out of asking its sources
      const mid = new Computed(() => {
        if (mode === 'derivation') {
          trigger.get();
        }
        try {
          return tail.get();
        } catch {
          return -1;
        }
      });
      const seen: (number | string)[] = [];
      own.effect(() => {
        trigger.get();
        if (mode === 'plain effect') {
          seen.push(tail.get());
          return;
        }
        try {
          seen.push(mode.endsWith('derivation') ? mid.get() : tail.get());
        } catch {
          seen.push('failed');
        }
      });

      // every link dirty, and the read of the tail runs out
      height.set(2);
      trigger.set(1);
      own.flush();
      // back to the value the chain held, and readable again
      height.set(1);
      for (const link of links) {
        link.get();
      }
      own.flush();

      const failed = mode === 'derivation' ? -1 : 'failed';
      expect(seen).toEqual(mode === 'plain effect' ? [DEEP, DEEP] : [DEEP, failed, DEEP]);
      expect(errors).toHaveLength(mode === 'plain effect' ? 1 : 0);
    }
  });

  it('should tell the effect behind a CHECK derivation left incomplete when one of its own sources is written', () => {
    // `mid` reads a state directly as well as the chain. Settling it runs out of
    // stack, so it is left CHECK and incomplete and the effect caches the error.
    // A write to that state raises it to DIRTY rather than passing through it,
    // and a node that was not clean used to stop the walk there -- so the
    // effect kept showing the error with a readable `mid` in front of it
    const own = createEffects();
    own.setScheduler(() => {});
    own.setErrorHandler(() => {});
    const flag = new State(0);
    // every link reads `height` itself, so a write dirties every one of them and
    // settling the tail reruns every body, nested -- which is what runs out
    const height = new State(1);
    const links: Computed<number>[] = [];
    for (let i = 0; i < DEEP; i++) {
      const above = links[i - 1];
      links.push(new Computed(() => (above ? above.get() : 0) + height.get()));
      links[i].get();
    }
    const tail = links[DEEP - 1];
    const mid = new Computed(() => flag.get() + tail.get());
    // the effect reads `trigger` so that it is dirtied directly and its own body
    // runs and catches; CHECK, the error would come out of asking its sources
    const trigger = new State(0);
    const seen: (number | string)[] = [];
    own.effect(() => {
      trigger.get();
      try {
        seen.push(mid.get());
      } catch {
        seen.push('failed');
      }
    });

    // every link dirty, and settling `mid` runs out
    height.set(2);
    trigger.set(1);
    own.flush();
    // the chain read in steps from the top level, then `mid`'s own source written
    for (const link of links) {
      link.get();
    }
    flag.set(1);
    own.flush();

    expect(seen).toEqual([DEEP, 'failed', 1 + 2 * DEEP]);
  });

  it('should refuse a read in steps inside the body that caught the error, and take one from outside', () => {
    // the error says to read the chain in steps from the bottom up, and inside
    // the body that caught it that is refused: every link on the path that
    // failed was cut short in this same read, and is not run again until the
    // next. Taken outside any computed or effect, the steps work, and the
    // effect's next run reads the chain
    const own = createEffects();
    own.setScheduler(() => {});
    own.setErrorHandler(() => {});
    const { s, links, tail } = chain(false);
    const seen: (number | string)[] = [];
    own.effect(() => {
      try {
        seen.push(tail.get());
      } catch {
        try {
          for (let i = 0; i < DEEP; i += 500) {
            links[i].get();
          }
          seen.push(tail.get());
        } catch (err) {
          seen.push((err as Error).message);
        }
      }
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatch(/^Computed chain too deep.*outside any computed or effect$/);

    for (let i = 0; i < DEEP; i += 500) {
      links[i].get();
    }
    s.set(1);
    own.flush();
    expect(seen[1]).toBe(DEEP + 1);
  });

  it('should pass a write through a node a failed read left incomplete only once', async () => {
    // each link reads the two above it, so a write passing through every node it
    // found incomplete -- rather than once, clearing it -- walks every path
    // through the diamond instead of every node: a second write that takes a
    // millisecond never returned. In a child, so that broken it fails rather
    // than hanging the suite
    const result = await atStackSize(900, 'passonce');
    const ms = Number(/ms=(\d+)/.exec(result)?.[1] ?? Infinity);
    expect(ms, result).toBeLessThan(2000);
  }, 60_000);

  it('should not retry a run cut short by the stack within one read, wherever the stack runs out', async () => {
    // the doubling needs the graph's own code to overflow at the edge level
    // after level, which a plain node does at every stack size measured and the
    // test runner's worker does not -- so the bound is asked of children
    const results = await Promise.all(sizes.map((size) => atStackSize(size, 'twice')));
    const runs = results.map((result) => Number(/runs=(\d+)/.exec(result)?.[1] ?? Infinity));
    expect(results.filter((_, i) => !(runs[i] < 50_000))).toEqual([]);
  }, 120_000);

  it('should read a plain chain back exactly after failed reads, wherever the stack runs out', async () => {
    // where the stack runs out decides which line of the graph's own code is at
    // the edge, and a catch that overflowed at the edge once marked a link CLEAN
    // over a value it never committed, which read back `undefined` for good
    const results = await Promise.all(sizes.map((size) => atStackSize(size, 'plain')));
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
    // a computed ran out of stack in its own recursion, which is an answer about
    // that body rather than about a chain -- whether nothing is evaluating around
    // it or another computed is reading it
    const recurse = (n: number): number => recurse(n + 1) + 1;
    let runs = 0;
    const alone = new Computed(() => {
      runs++;
      return recurse(0);
    });
    for (let i = 0; i < 3; i++) {
      expect(() => alone.get()).toThrow('Maximum call stack size exceeded');
    }
    expect(runs).toBe(1);

    runs = 0;
    const inner = new Computed(() => {
      runs++;
      return recurse(0);
    });
    const outer = new Computed(() => inner.get() * 2);
    for (let i = 0; i < 3; i++) {
      expect(() => outer.get()).toThrow('Maximum call stack size exceeded');
    }
    expect(runs).toBe(1);
  });
});
