/**
 * The `fs.watch` source: the climb, the re-target and the one watcher per
 * directory.
 *
 * `node:fs` is wrapped the way `atomic-temp.test.ts` wraps it, and for its
 * reason: which directory the source ended up watching is visible nowhere
 * outside, and the alternative is a seam whose only reader would be this file.
 * The real `statSync` runs and the real directories are made; what the wrapper
 * adds is a record of which paths `fs.watch` was called with, a handle on the
 * listener so an event can be delivered with no sleeping, and a way to make one
 * call fail.
 *
 * A file of its own, because `vi.mock` is hoisted and module-wide: every test in
 * the file it sat in would run through the wrapper, which is a thing nobody
 * reading those tests would expect.
 *
 * What is **not** here is whether `fs.watch` really behaves the way this source
 * is built around -- that a file watch dies after the first atomic replace, that
 * a directory watch does not, and that an event in `a` says nothing about
 * `a/b/config.json`. Those are claims about the platform rather than about this
 * code, and `watch-real.test.ts` is where they are measured.
 */

import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/** One entry per `fs.watch` call, as `watch <path>`. */
const calls: string[] = [];

/** The live watchers, so an event can be delivered and a close counted. */
interface Fake {
  closed: boolean;
  errors: ((e: Error) => void)[];
  fire: () => void;
  /** What `fs.watch` was given, because `persistent: false` is a claim. */
  opts: unknown;
  path: string;
}
const live: Fake[] = [];

/** Which call should fail next, and how many times. */
let failWatch = 0;

/** Whether `close()` should throw, which a torn-down watcher really does. */
let failClose = false;

vi.mock('node:fs', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs')>();

  return {
    ...real,
    watch(path: string, opts: unknown, listener: (t: string, n: string) => void): unknown {
      calls.push(`watch ${path}`);
      if (failWatch > 0) {
        failWatch--;
        const e = new Error('ENOENT') as Error & { code: string };
        e.code = 'ENOENT';
        throw e;
      }

      const it: Fake = {
        closed: false,
        errors: [],
        fire: () => listener('rename', 'config.json'),
        opts,
        path,
      };
      live.push(it);

      return {
        close(): void {
          it.closed = true;
          if (failClose) {
            throw new Error('already gone');
          }
        },
        on(event: string, handler: (e: Error) => void): void {
          if (event === 'error') {
            it.errors.push(handler);
          }
        },
      };
    },
  };
});

const { createSource } = await import('../../src/config/watch.js');

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'sigil-watch-fs-'));
  calls.length = 0;
  live.length = 0;
  failWatch = 0;
  failClose = false;
});

afterEach(() => {
  rmSync(root, { force: true, recursive: true });
});

/** The watcher currently pointed at a path, if any. */
function watching(path: string): Fake | undefined {
  return live.find((it) => it.path === path && !it.closed);
}

describe('the fs source', () => {
  it('should watch the directory rather than the file', () => {
    // the one decision this whole module rests on: a rename swaps the inode, so
    // a watch on the path is watching a file nothing will write to again
    const dir = join(root, 'cfg');
    mkdirSync(dir);
    createSource({})(join(dir, 'config.json'), () => {});
    expect(calls).to.deep.equal([`watch ${dir}`]);
  });

  it('should pass persistent: false, which is an FSWatcher unref', () => {
    // at construction rather than `unref()` afterwards, so there is no window
    // in which it is ref'd. Asserted on what `fs.watch` was handed, because the
    // claim is about the option: a count of calls would pass whatever it said
    const dir = join(root, 'cfg');
    mkdirSync(dir);
    createSource({})(join(dir, 'config.json'), () => {});
    expect(live[0]?.opts).to.deep.equal({ persistent: false, recursive: false });
  });

  it('should climb to the deepest existing ancestor of a missing directory', () => {
    // `fs.watch` on a missing path throws ENOENT, measured, and a config file
    // the user has not created yet is the ordinary case on a fresh install --
    // where neither the file nor its directory is there
    createSource({})(join(root, 'a', 'b', 'c', 'config.json'), () => {});
    expect(calls).to.deep.equal([`watch ${root}`]);
  });

  it('should re-target downward as the directories appear', () => {
    // which is **correctness** rather than tidiness: `recursive` is off, so an
    // event in `a` says nothing at all about a write to `a/b/config.json`.
    // Measured on a real filesystem in watch-real.test.ts
    const a = join(root, 'a');
    const b = join(a, 'b');
    const source = createSource({});
    source(join(b, 'config.json'), () => {});
    expect(calls).to.deep.equal([`watch ${root}`]);

    mkdirSync(a);
    watching(root)?.fire();
    expect(calls.at(-1)).toBe(`watch ${a}`);
    expect(watching(root)).toBeUndefined();

    mkdirSync(b);
    watching(a)?.fire();
    expect(calls.at(-1)).toBe(`watch ${b}`);
  });

  it('should re-target upward when the watched directory goes', () => {
    // the same rule both ways round, which is why there is one `retarget()`
    const dir = join(root, 'cfg');
    mkdirSync(dir);
    const source = createSource({});
    source(join(dir, 'config.json'), () => {});
    expect(calls).to.deep.equal([`watch ${dir}`]);

    rmSync(dir, { recursive: true });
    watching(dir)?.fire();
    expect(calls.at(-1)).toBe(`watch ${root}`);
  });

  it('should re-target rather than throw when an error arrives', () => {
    // an `error` event with no listener is an uncaught exception, which is the
    // rule the terminal's EPIPE guard is written for -- and this one really
    // fires, because the directory being watched is one somebody else may
    // delete. On macOS a removal arrives as an ordinary event instead, measured
    const dir = join(root, 'cfg');
    mkdirSync(dir);
    createSource({})(join(dir, 'config.json'), () => {});
    const it = watching(dir);
    expect(it?.errors).toHaveLength(1);

    rmSync(dir, { recursive: true });
    expect(() => it?.errors[0]?.(new Error('gone'))).not.toThrow();
    expect(calls.at(-1)).toBe(`watch ${root}`);
  });

  it('should not re-watch where the deepest ancestor did not move', () => {
    // every event re-targets, so this is what keeps that from closing and
    // reopening a descriptor on each one
    const dir = join(root, 'cfg');
    mkdirSync(dir);
    createSource({})(join(dir, 'config.json'), () => {});
    for (let i = 0; i < 3; i++) {
      watching(dir)?.fire();
    }
    expect(calls).to.deep.equal([`watch ${dir}`]);
  });

  it('should tell every listener in a directory, and only once per event', () => {
    const dir = join(root, 'cfg');
    mkdirSync(dir);
    const source = createSource({});
    let a = 0;
    let b = 0;
    source(join(dir, 'one.json'), () => a++);
    source(join(dir, 'two.json'), () => b++);

    // one watcher for the two of them, which is what "one per directory"
    // comes to when the thing holding the count is the listener set
    expect(calls).to.deep.equal([`watch ${dir}`]);
    watching(dir)?.fire();
    expect([a, b]).to.deep.equal([1, 1]);
  });

  it('should keep the watcher until the last listener in the directory goes', () => {
    const dir = join(root, 'cfg');
    mkdirSync(dir);
    const source = createSource({});
    const stopA = source(join(dir, 'one.json'), () => {});
    const stopB = source(join(dir, 'two.json'), () => {});

    stopA();
    expect(watching(dir)).toBeDefined();
    stopB();
    expect(watching(dir)).toBeUndefined();
  });

  it('should take a disposer called more than once', () => {
    const dir = join(root, 'cfg');
    mkdirSync(dir);
    const source = createSource({});
    const stopA = source(join(dir, 'one.json'), () => {});
    const stopB = source(join(dir, 'two.json'), () => {});

    stopA();
    stopA();
    // without the latch the second call would take the other listener's
    // watcher down with it
    expect(watching(dir)).toBeDefined();
    stopB();
    expect(watching(dir)).toBeUndefined();
  });

  it('should watch each directory separately', () => {
    const a = join(root, 'a');
    const b = join(root, 'b');
    mkdirSync(a);
    mkdirSync(b);
    const source = createSource({});
    source(join(a, 'config.json'), () => {});
    source(join(b, 'config.json'), () => {});
    expect(calls).to.deep.equal([`watch ${a}`, `watch ${b}`]);
  });

  it('should climb again where the directory it just found has gone', () => {
    // the only way `fs.watch` fails after a `statSync` said the directory is
    // there, and each failure is one level nearer a root that does not vanish
    const dir = join(root, 'cfg');
    mkdirSync(dir);
    failWatch = 1;
    createSource({})(join(dir, 'config.json'), () => {});
    // it tried the directory, was refused, and climbed
    expect(calls).to.deep.equal([`watch ${dir}`, `watch ${dir}`]);
    expect(watching(dir)).toBeDefined();
  });

  it('should give up rather than climb forever', () => {
    // a bound on a terminating loop rather than a budget: reached only by
    // something deleting a tree underneath us as fast as we can walk it
    failWatch = 1000;
    expect(() => createSource({})(join(root, 'config.json'), () => {})).not.toThrow();
    expect(calls.length).toBeLessThan(40);
  });

  it('should survive a close that throws', () => {
    // `close()` can throw on a watcher the platform has already torn down, and
    // a teardown that threw would strand every other directory
    const dir = join(root, 'cfg');
    mkdirSync(dir);
    const stop = createSource({})(join(dir, 'config.json'), () => {});
    failClose = true;
    expect(() => stop()).not.toThrow();
  });

  it('should resolve a relative path, since a store may hold one', () => {
    // `expand()` normalizes rather than resolving, so a `json('./x.json')`
    // layer's own `source` is relative -- and `dirname('x.json')` is `.`
    createSource({})('x.json', () => {});
    expect(calls).to.deep.equal([`watch ${process.cwd()}`]);
  });
});

describe('the climb probe', () => {
  // the answer to the one thing no documentation would have said: a **cold**
  // watcher loses its event about 3% of the time under heavy parallel
  // filesystem load, and 0 of 30 times idle, where a warm one does not (0 of 40
  // replacements). In the steady state that costs latency and recovers; during
  // the climb it is **permanent**, because the event that creates the directory
  // is the only one that would ever move the watch down and a watcher created
  // microseconds earlier is exactly the cold one
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('should re-target with no event at all once the directory appears', () => {
    const a = join(root, 'a');
    const b = join(a, 'b');
    createSource({ interval: 100 })(join(b, 'config.json'), () => {});
    expect(calls).to.deep.equal([`watch ${root}`]);

    // no `fire()`: this is the dropped event
    mkdirSync(b, { recursive: true });
    vi.advanceTimersByTime(100);

    expect(calls.at(-1)).toBe(`watch ${b}`);
  });

  it('should tell the listeners when it moved, and not when it did not', () => {
    const b = join(root, 'a', 'b');
    let told = 0;
    createSource({ interval: 100 })(join(b, 'config.json'), () => told++);

    // nothing has appeared, so there is nothing to say -- and a directory that
    // never appears costs one statSync per interval rather than a read
    vi.advanceTimersByTime(500);
    expect(told).toBe(0);

    mkdirSync(b, { recursive: true });
    vi.advanceTimersByTime(100);
    expect(told).toBe(1);
  });

  it('should stop the moment the directory it wants is reached', () => {
    const b = join(root, 'a', 'b');
    createSource({ interval: 100 })(join(b, 'config.json'), () => {});
    expect(vi.getTimerCount()).toBe(1);

    mkdirSync(b, { recursive: true });
    vi.advanceTimersByTime(100);

    // self-limiting: it exists only in the degenerate state
    expect(vi.getTimerCount()).toBe(0);
  });

  it('should run no timer at all where the directory already exists', () => {
    // which is the ordinary case, and is why this costs nothing
    const dir = join(root, 'cfg');
    mkdirSync(dir);
    createSource({})(join(dir, 'config.json'), () => {});
    expect(vi.getTimerCount()).toBe(0);
  });

  it('should start again when the directory it was watching goes', () => {
    const dir = join(root, 'cfg');
    mkdirSync(dir);
    createSource({ interval: 100 })(join(dir, 'config.json'), () => {});
    expect(vi.getTimerCount()).toBe(0);

    rmSync(dir, { recursive: true });
    watching(dir)?.fire();
    expect(calls.at(-1)).toBe(`watch ${root}`);
    // and it is now somewhere it does not want to be, so it keeps asking
    expect(vi.getTimerCount()).toBe(1);
  });

  it('should keep asking after the climb gave up', () => {
    // which makes `MAX_CLIMB` recoverable rather than final
    failWatch = 1000;
    createSource({ interval: 100 })(join(root, 'cfg', 'config.json'), () => {});
    expect(vi.getTimerCount()).toBe(1);

    failWatch = 0;
    mkdirSync(join(root, 'cfg'));
    vi.advanceTimersByTime(100);
    expect(calls.at(-1)).toBe(`watch ${join(root, 'cfg')}`);
  });

  it('should hold no timer the process has to wait for', () => {
    // the rule the debounce keeps, one layer down -- and a spy rather than a
    // count, because vitest's fake timers do not model `unref`
    const unreffed: boolean[] = [];
    const real = globalThis.setInterval;
    const spy = vi.spyOn(globalThis, 'setInterval').mockImplementation(((
      ...args: Parameters<typeof real>
    ) => {
      const handle = real(...args) as ReturnType<typeof real> & { unref?: () => unknown };
      const index = unreffed.push(false) - 1;
      const own = handle.unref;
      if (own) {
        handle.unref = () => {
          unreffed[index] = true;
          return own.call(handle) as never;
        };
      }
      return handle;
    }) as never);

    try {
      createSource({ interval: 100 })(join(root, 'a', 'b', 'config.json'), () => {});
      expect(unreffed).to.deep.equal([true]);
    } finally {
      spy.mockRestore();
    }
  });

  it('should forget the probe when the last listener goes', () => {
    const b = join(root, 'a', 'b');
    const stop = createSource({ interval: 100 })(join(b, 'config.json'), () => {});
    expect(vi.getTimerCount()).toBe(1);
    stop();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('the source the options pick', () => {
  it('should take the one the caller passed over either built-in', () => {
    let asked = 0;
    const source = createSource({
      source: () => {
        asked++;
        return () => {};
      },
    });
    source('/x/config.json', () => {});
    expect(asked).toBe(1);
    expect(calls).to.deep.equal([]);
  });

  it('should use fs.watch unless poll was asked for', () => {
    const dir = join(root, 'cfg');
    mkdirSync(dir);
    createSource({ poll: false })(join(dir, 'config.json'), () => {});
    expect(calls).toHaveLength(1);
  });
});
