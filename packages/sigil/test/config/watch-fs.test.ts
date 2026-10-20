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

import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
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

/** Whether a failing `fs.watch` also removes the directory it was given. */
let vanishOnFail = false;

/** Whether `close()` should throw, which a torn-down watcher really does. */
let failClose = false;

/** One entry per `fs.watchFile` call, as `poll <path> <interval> <persistent>`. */
const polls: string[] = [];

/** The listeners `fs.watchFile` was handed, so a removal can name which. */
const listeners: unknown[] = [];

vi.mock('node:fs', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs')>();

  return {
    ...real,
    // the **listener** is recorded as well as the path, because that is the
    // whole of what the poll disposer claims: `unwatchFile(path, listener)`
    // removes that one, where `unwatchFile(path)` removes *every* listener for
    // the path -- including another config's. The first version of the wrapper
    // discarded it, so the test for the disposer could only assert that a
    // second `stop()` does not throw, which a no-op disposer passes too. Found
    // by review
    unwatchFile(path: string, listener?: unknown): void {
      polls.push(`unwatch ${path} ${listener === undefined ? 'all' : listeners.indexOf(listener)}`);
    },
    watchFile(
      path: string,
      opts: { interval: number; persistent: boolean },
      listener: unknown
    ): unknown {
      listeners.push(listener);
      polls.push(`poll ${path} ${opts.interval} ${opts.persistent}`);
      return undefined;
    },
    watch(path: string, opts: unknown, listener: (t: string, n: string) => void): unknown {
      calls.push(`watch ${path}`);
      if (failWatch > 0) {
        failWatch--;
        // the directory can be made to vanish with the failure, which is the
        // only shape that makes the climb climb: a failure over a directory that
        // is still there is not the directory vanishing, and retrying the same
        // level cannot help
        if (vanishOnFail) {
          rmSync(path, { force: true, recursive: true });
        }
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
// after the mock and through it, exactly as the subject reaches it: the source
// resolves with `realPathOf()`, so a fixture that spelled the expected path any
// other way is comparing against a second answer to the same question
const { realPathOf } = await import('../../src/config/atomic.js');

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'sigil-watch-fs-'));
  calls.length = 0;
  listeners.length = 0;
  live.length = 0;
  polls.length = 0;
  failWatch = 0;
  vanishOnFail = false;
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

  it('should watch the directory the real file is in, not the link', () => {
    // a symlinked config is a supported layout -- `write.test.ts` establishes
    // it as one and `writeAtomic()` resolves through the link on purpose -- so
    // an editor saving the real file replaces an entry in the **target's**
    // directory. Watching the link's own directory is watching a directory the
    // writer never writes in, and the config then answers stale values for the
    // life of the process.
    //
    // Asserted here rather than only in `watch-real.test.ts` because this is
    // the platform-independent half: macOS resolves the link for us -- FSEvents
    // is path-based, measured 6/6 -- so the real test is caught 1 run in 6 with
    // the resolution removed, while this is caught every time on every platform
    const dots = join(root, 'dotfiles');
    const conf = join(root, 'config');
    mkdirSync(dots);
    mkdirSync(conf);
    const real = join(dots, 'config.json');
    const link = join(conf, 'config.json');
    writeFileSync(real, '{}');
    symlinkSync(real, link);

    createSource({})(link, () => {});

    // through **the subject's own resolver** on both sides, because the answer
    // is physical and `/var` is itself a link on macOS -- a path compared
    // against another built the same way, which is this repository's own rule
    // about not spelling one twice.
    //
    // `realPathOf()` rather than `realpathSync`, which is the same rule one
    // step in and is what CI caught: the subject resolves with
    // `realpathSync.native` -- deliberately, because node's own `realpathSync`
    // begins with `path.resolve()` and collapses a `..` lexically where
    // `realpath(3)` does not -- and on Windows the two answer differently for
    // the same path, so this compared two one-element arrays that were not
    // equal. The comment here claimed "`realpathSync` on both sides" while the
    // subject's side was `.native`, which is the prose-against-code failure
    // that made it look checked
    expect(calls).to.deep.equal([`watch ${realPathOf(dots)}`]);
  });

  it('should fall back to the path as named where the real one cannot be found', () => {
    // `realPathOf()` **throws** for anything but the file not being there,
    // because for the writer a failed resolution means the write cannot land.
    // The watcher has a climb that walks past every way a path can be broken,
    // so for it a refusal is one more broken path -- and a throw here would
    // escape `#start()` and kill the whole watch. `ENOTDIR` from a parent that
    // is a regular file is the reachable one; the test above it is the same
    // path and is what caught this when the resolution was first added
    const notADir = join(root, 'cfg');
    writeFileSync(notADir, 'not a directory');

    expect(() => createSource({})(join(notADir, 'config.json'), () => {})).not.toThrow();
    expect(calls).to.deep.equal([`watch ${root}`]);
  });

  it('should climb past something that exists and is not a directory', () => {
    // `statSync()` succeeds for a file, so without asking whether it **is** a
    // directory the watch lands on one -- and then the climb never moves, since
    // a file cannot come to hold the config
    const notADir = join(root, 'cfg');
    writeFileSync(notADir, 'not a directory');
    createSource({})(join(notADir, 'config.json'), () => {});
    expect(calls).to.deep.equal([`watch ${root}`]);
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

  it('should tell the listeners when an error took the directory away', () => {
    // the error branch exists for the platforms where removing the watched
    // directory arrives as an error rather than an event -- and it re-targeted
    // without telling anybody, so `get()` went on answering the deleted file's
    // values for the life of the process. The probe cannot cover it: it tells
    // the listeners only where it **moved**, and the re-target here has already
    // moved. Found by review
    const dir = join(root, 'cfg');
    mkdirSync(dir);
    let told = 0;
    createSource({ interval: 50 })(join(dir, 'config.json'), () => told++);
    const it = watching(dir);

    rmSync(dir, { recursive: true });
    it?.errors[0]?.(new Error('gone'));

    expect(calls.at(-1)).toBe(`watch ${root}`);
    expect(told).toBe(1);
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

  it('should take a disposer called again after the directory was re-registered', () => {
    // the sequence the latch is really for, which a two-listener fixture cannot
    // reach: both disposers called, so the entry is closed and removed from the
    // map, then a third file registered -- which makes a **new** entry -- then
    // the first disposer called again. Without the latch `held` is the old
    // entry, its listener set is empty, so it deletes the new entry from the map
    // and the next registration opens a second watcher on the same directory.
    // Found by review, after a sabotage had reported the latch as inert
    const dir = join(root, 'cfg');
    mkdirSync(dir);
    const source = createSource({});
    const stopA = source(join(dir, 'one.json'), () => {});
    const stopB = source(join(dir, 'two.json'), () => {});
    stopA();
    stopB();
    expect(watching(dir)).toBeUndefined();

    source(join(dir, 'three.json'), () => {});
    expect(watching(dir)).toBeDefined();

    stopA();
    // still exactly one watcher for this directory, and a fourth registration
    // shares it rather than opening a second
    const was = calls.length;
    source(join(dir, 'four.json'), () => {});
    expect(calls.length).toBe(was);
    expect(live.filter((it) => it.path === dir && !it.closed)).toHaveLength(1);
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
    // there. The fixture has to **remove** it, which the first version did not:
    // it left the directory in place and expected two attempts at the same one,
    // which is the behaviour the retry fix deliberately stopped. Found by
    // following a review finding about the comment
    const dir = join(root, 'cfg');
    mkdirSync(dir);
    failWatch = 1;
    vanishOnFail = true;
    createSource({})(join(dir, 'config.json'), () => {});
    // it tried the directory, the directory went, and it climbed one level
    expect(calls).to.deep.equal([`watch ${dir}`, `watch ${root}`]);
    expect(watching(root)).toBeDefined();
  });

  it('should not retry a level that is still there, which cannot have vanished', () => {
    // a failure over a directory that still exists is `EMFILE`, a watcher limit
    // or a permission -- and retrying the same level 32 times in a row, which
    // the probe then repeats every interval, is the recovery path amplifying
    // the pressure it is recovering from. Found by review
    const dir = join(root, 'cfg');
    mkdirSync(dir);
    failWatch = 1000;
    createSource({ interval: 50 })(join(dir, 'config.json'), () => {});
    expect(calls).to.deep.equal([`watch ${dir}`]);
  });

  it('should give up rather than climb forever', () => {
    // a bound on the **depth** now rather than on the attempts, which is what
    // its own comment always claimed: reached only by something deleting a tree
    // underneath us as fast as we can walk it
    const deep = join(root, ...Array.from({ length: 50 }, (_, i) => `d${i}`));
    mkdirSync(deep, { recursive: true });
    failWatch = 1000;
    vanishOnFail = true;
    expect(() => createSource({})(join(deep, 'config.json'), () => {})).not.toThrow();
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
    // and `close()` was **reached**, which `not.toThrow()` alone cannot say: a
    // disposer that never called it passes that assertion too. The mock tracks
    // the flag whether or not the call threw. Found by review
    expect(live[0]?.closed).toBe(true);
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

  it('should keep one probe however many levels it climbs through', () => {
    // two hops, which is what it takes to see this: with one, `settle()` is only
    // reached once with the watch away from where it wants to be, so a version
    // that made a fresh interval per call looks identical
    const a = join(root, 'a');
    const b = join(a, 'b');
    createSource({ interval: 100 })(join(b, 'config.json'), () => {});
    expect(vi.getTimerCount()).toBe(1);

    mkdirSync(a);
    watching(root)?.fire();
    expect(calls.at(-1)).toBe(`watch ${a}`);
    expect(vi.getTimerCount()).toBe(1);

    mkdirSync(b);
    watching(a)?.fire();
    expect(calls.at(-1)).toBe(`watch ${b}`);
    expect(vi.getTimerCount()).toBe(0);
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

  it('should floor the interval, because an interval that is zero is a spin', () => {
    // `debounce` has no floor because zero means "do not wait", which fires
    // once; an interval **repeats**, and `setInterval(fn, 0)` is clamped by node
    // to 1ms -- measured -- so `interval: 0` over a missing directory put a
    // `statSync` of the ancestor chain through a thousand times a second for the
    // life of the process. Clamped rather than fallen back to the default,
    // because somebody who wrote `0` meant "as fast as you can". Found by review
    const delays: unknown[] = [];
    const real = globalThis.setInterval;
    const spy = vi.spyOn(globalThis, 'setInterval').mockImplementation(((
      ...args: Parameters<typeof real>
    ) => {
      delays.push(args[1]);
      return real(...args);
    }) as never);

    try {
      for (const interval of [0, 1, 9]) {
        delays.length = 0;
        createSource({ interval })(join(root, 'a', 'b', 'config.json'), () => {});
        expect(delays, String(interval)).to.deep.equal([10]);
      }
      // and above the floor it is what was asked for
      delays.length = 0;
      createSource({ interval: 250 })(join(root, 'a', 'b', 'config.json'), () => {});
      expect(delays).to.deep.equal([250]);
    } finally {
      spy.mockRestore();
    }
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

describe('the poll source', () => {
  it('should poll the file itself, with no climb and no directory', () => {
    // the finding this module is built around: each poll is a fresh `stat()` of
    // the path, so polling is immune to everything the event source has to
    // handle -- a missing file fires once and goes quiet, it fires when the file
    // appears, it survives a rename-over, and Node already refcounts per path
    const stop = createSource({ interval: 25, poll: true })(
      join(root, 'a', 'b', 'config.json'),
      () => {}
    );
    expect(polls).to.deep.equal([`poll ${join(root, 'a', 'b', 'config.json')} 25 false`]);
    // and no `fs.watch` at all
    expect(calls).to.deep.equal([]);

    stop();
    // its own listener by index, which is the claim the disposer makes
    expect(polls.at(-1)).toBe(`unwatch ${join(root, 'a', 'b', 'config.json')} 0`);
  });

  it('should pass persistent: false, so a CLI that reads config still exits', () => {
    createSource({ poll: true })(join(root, 'config.json'), () => {});
    expect(polls[0]).toContain(' false');
  });

  it('should take the default interval where the caller named none', () => {
    createSource({ poll: true })(join(root, 'config.json'), () => {});
    // Node's own default is 5007ms, which is too slow to notice a change during
    // a run; chokidar's 100ms is ten stats a second forever
    expect(polls[0]).toContain(' 1000 ');
  });

  it('should resolve a relative path, since a store may hold one', () => {
    createSource({ poll: true })('x.json', () => {});
    expect(polls[0]).toContain(join(process.cwd(), 'x.json'));
  });

  it('should take a disposer called more than once', () => {
    // no latch, because `unwatchFile(path, listener)` answers for a listener it
    // does not hold -- so a second call is a no-op rather than a wrong answer.
    //
    // What that rests on is the disposer naming **its own** listener, which is
    // asserted rather than inferred: `unwatchFile(path)` with none removes
    // every listener for the path, so two layers in one file would take each
    // other's watch away. The first version of this test asserted only that a
    // second `stop()` does not throw, which a disposer calling the one-argument
    // form -- or doing nothing at all -- passes too. Found by review
    const at = join(root, 'config.json');
    const first = createSource({ poll: true });
    const stopA = first(at, () => {});
    const stopB = first(at, () => {});

    stopA();
    expect(polls).to.deep.equal([
      `poll ${at} 1000 false`,
      `poll ${at} 1000 false`,
      `unwatch ${at} 0`,
    ]);

    stopB();
    expect(polls.at(-1)).toBe(`unwatch ${at} 1`);

    // and twice over is a no-op rather than a wrong answer
    expect(() => stopA()).not.toThrow();
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
