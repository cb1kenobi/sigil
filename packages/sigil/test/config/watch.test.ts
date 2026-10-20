import {
  createConfigSync,
  json,
  object,
  type ConfigChange,
  type ConfigDocument,
  type Loss,
  type WatchSource,
  type WritableConfigStore,
} from '../../src/config/index.js';
import { diffMerged, sameValue } from '../../src/config/watch.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

/**
 * A source that fires on demand, which is what makes every test in this file
 * free of sleeps and of the filesystem.
 *
 * The thing `WatchOptions.source` exists for: the debounce, the compare, the
 * retry, the diff and the dispatch are all a function of "something said the
 * file may have moved", and this is that something with a method on it.
 */
function fakeSource(): WatchSource & { fire: () => void; live: () => number } {
  const listeners = new Set<() => void>();
  const source = ((_path: string, onEvent: () => void) => {
    listeners.add(onEvent);
    return () => {
      listeners.delete(onEvent);
    };
  }) as WatchSource & { fire: () => void; live: () => number };

  source.fire = (): void => {
    // a copy, because a handler can stop the watch it was told by
    // eslint-disable-next-line unicorn/no-useless-spread
    for (const listener of [...listeners]) {
      listener();
    }
  };
  source.live = (): number => listeners.size;
  return source;
}

/**
 * A store whose next read the test decides, with no file behind it.
 *
 * `source` is a path because that is what makes a layer watchable, and it is
 * never opened -- the fake source is what fires, so the path is only ever a key.
 */
function stubStore(value: unknown): WritableConfigStore & {
  fail: (error?: unknown) => void;
  hold: (gate: () => Promise<void>) => void;
  lose: (next: readonly Loss[] | undefined) => void;
  reads: () => number;
  set: (next: unknown) => void;
  value: () => unknown;
} {
  let held = value;
  let error: unknown;
  let gate: (() => Promise<void>) | undefined;
  let losses: readonly Loss[] | undefined;
  let reads = 0;

  const read = (): ConfigDocument => {
    reads++;
    if (error !== undefined) {
      throw error;
    }
    return { value: held, wouldLose: losses };
  };

  return {
    fail: (e: unknown = new Error('mid-write')): void => {
      error = e;
    },
    lose: (next: readonly Loss[] | undefined): void => {
      losses = next;
    },
    format: 'stub',
    // a gate the test resolves by hand, which is the only way to put the
    // debounce *inside* an `await save()`: a `Promise.resolve()` settles on a
    // microtask and a `setTimeout` is a macrotask, so the read always wins
    hold: (next: () => Promise<void>): void => {
      gate = next;
    },
    read: async (): Promise<ConfigDocument> => {
      if (gate) {
        await gate();
      }
      return read();
    },
    reads: (): number => reads,
    readSync: read,
    set: (next: unknown): void => {
      error = undefined;
      held = next;
    },
    source: '/nowhere/config.json',
    // writable, so that a `set()` can target the layer a reload overwrites --
    // which is the one rule in this file that needs the two to be the same
    // layer. It really writes, because a store whose `write()` did nothing
    // would be a store that lies the way the interface's own doc refuses
    write: (next: unknown): Promise<void> => {
      held = next;
      return Promise.resolve();
    },
    writeSync: (next: unknown): void => {
      held = next;
    },
    value: (): unknown => held,
  };
}

describe('sameValue', () => {
  it('should compare a Date by its time rather than by identity', () => {
    // the input that makes this not `jsonc-write.ts`'s `same()`:
    // `transformValue()` builds a new `Date` on every read, so identity would
    // report a change every time the file was touched and nothing in it moved
    expect(sameValue(new Date(5), new Date(5))).toBe(true);
    expect(sameValue(new Date(5), new Date(6))).toBe(false);
    expect(sameValue(new Date(5), 5)).toBe(false);
    expect(sameValue(5, new Date(5))).toBe(false);
  });

  it('should walk a plain object and an array structurally', () => {
    expect(sameValue({ a: { b: [1, 2] } }, { a: { b: [1, 2] } })).toBe(true);
    expect(sameValue({ a: { b: [1, 2] } }, { a: { b: [1, 3] } })).toBe(false);
    // length, so a prefix is not the whole list
    expect(sameValue([1, 2], [1, 2, 3])).toBe(false);
    // key count, so an added key is a change even where every shared key agrees
    expect(sameValue({ a: 1 }, { a: 1, b: 2 })).toBe(false);
    expect(sameValue({ a: 1, b: 2 }, { a: 1 })).toBe(false);
    // an array is not a plain object and neither stands in for the other
    expect(sameValue([], {})).toBe(false);
    expect(sameValue({}, [])).toBe(false);
  });

  it('should hold a key an object has from one whose value is undefined', () => {
    // the key **count** answers this one, which is why the input below exists
    expect(sameValue({ a: undefined }, {})).toBe(false);
    // and this is what `Object.hasOwn` is for rather than `b[key] === undefined`:
    // two objects with the same number of keys, different keys, and `undefined`
    // on both sides of the read. Without it the walk compares `undefined` with
    // `undefined` and reports two different objects as the same thing
    expect(sameValue({ a: undefined }, { b: undefined })).toBe(false);
  });

  it('should make NaN equal to itself, which an object layer can hold', () => {
    // or a `NaN` in an object layer reads as moved on every reload
    expect(sameValue(Number.NaN, Number.NaN)).toBe(true);
    expect(sameValue({ a: Number.NaN }, { a: Number.NaN })).toBe(true);
  });

  it('should read 0 and -0 as one number, because our own write cannot tell them apart', () => {
    // `Object.is` read these as two values, which was a spurious publish after
    // **our own save**: `JSON.stringify(-0)` is `"0"`, so a `set('n', -0)` plus
    // `save()` writes `0`, the reload reads `0`, and handlers were handed a
    // change nobody made. Found by review
    expect(sameValue(0, -0)).toBe(true);
    expect(sameValue({ n: -0 }, { n: 0 })).toBe(true);
  });

  it('should not call getTime on something that only claims to be a Date', () => {
    // `Object.prototype.toString` honours `Symbol.toStringTag`, so a class
    // instance can answer `[object Date]` with no such method -- and an object
    // layer carries a class instance by reference. Measured: this threw
    // `e.getTime is not a function` out of `apply()` *after* the layer was
    // assigned, so the caller was told the apply failed while the config had
    // already changed. Found by review
    class Claims {
      get [Symbol.toStringTag](): string {
        return 'Date';
      }
    }
    const one = new Claims();
    expect(() => sameValue(one, new Claims())).not.toThrow();
    expect(sameValue(one, new Claims())).toBe(false);
    // the same instance is still the same instance, by identity
    expect(sameValue(one, one)).toBe(true);
    // and a real Date beside one of these is not a crash either
    expect(() => sameValue(new Date(5), one)).not.toThrow();
    expect(sameValue(new Date(5), one)).toBe(false);
    expect(sameValue(one, new Date(5))).toBe(false);
    // two invalid Dates are the same invalid Date rather than a change on
    // every reload, which is `NaN`'s own rule read through `getTime()`
    expect(sameValue(new Date(Number.NaN), new Date(Number.NaN))).toBe(true);
    // and a `getTime` that **throws** is answered rather than propagated: this
    // is a predicate, so one that throws is one every caller has to guard --
    // and `#reload()` calls it outside the try that routes a read failure, so
    // the throw escapes a timer callback, while `apply()` calls it after the
    // layer was assigned. A pair it cannot compare is reported as *moved*,
    // which is the safe direction. Found by review
    class Hostile {
      get [Symbol.toStringTag](): string {
        return 'Date';
      }
      getTime(): number {
        throw new Error('boom');
      }
    }
    class Bad extends Date {
      override getTime(): number {
        throw new Error('sub');
      }
    }
    expect(() => sameValue(new Hostile(), new Date(5))).not.toThrow();
    expect(sameValue(new Hostile(), new Date(5))).toBe(false);
    expect(sameValue(new Date(5), new Hostile())).toBe(false);
    expect(sameValue(new Bad(), new Bad())).toBe(false);

    // and the method is read on **both** sides before either is called, which
    // needs a **plain object** spoofing the tag to see at all: such a pair has
    // no `getTime`, so the guard falls through to the structural walk and
    // answers `true` for two that really are the same thing -- where entering
    // the branch would throw, be caught, and report a change on every reload.
    //
    // Two vacuous versions came before this one, which is why the input is
    // spelled out. `{ getTime: () => 5 }` tags as `[object Object]`, so
    // `sameValue` exits at the tag conjunction and never reads a method; and a
    // tagged *class* instance is not a plain object, so with the `typeof` guard
    // gone the catch answers `false` and the walk would have too -- the same
    // answer by a different route, which no assertion can tell apart
    const tagged = (): Record<string, unknown> => ({
      get [Symbol.toStringTag](): string {
        return 'Date';
      },
      x: 1,
    });
    expect(sameValue(tagged(), tagged())).toBe(true);
    expect(sameValue(tagged(), { ...tagged(), x: 2 })).toBe(false);

    // and the same where the method is there and **throws**, which is the half
    // a `catch` answering `false` got wrong: two of these are the same thing,
    // so reporting them as moved is a publish on every reload
    const boom = (): number => {
      throw new Error('boom');
    };
    const bad = (): Record<string, unknown> => ({ ...tagged(), getTime: boom });
    expect(sameValue(bad(), bad())).toBe(true);
    expect(sameValue(bad(), { ...bad(), x: 2 })).toBe(false);
  });

  it('should compare anything the merge carries by reference by identity', () => {
    // a `Map`, a class instance or a function is a leaf, so an object layer
    // re-applied with the same one is unchanged and with another one is not
    const fn = (): void => {};
    const map = new Map();
    expect(sameValue(fn, fn)).toBe(true);
    expect(sameValue(map, map)).toBe(true);
    expect(sameValue(new Map(), new Map())).toBe(false);
    expect(sameValue(fn, (): void => {})).toBe(false);
  });
});

describe('diffMerged', () => {
  it('should answer with nothing where nothing moved', () => {
    expect(diffMerged({ a: { b: 1 } }, { a: { b: 1 } })).to.deep.equal([]);
  });

  it('should walk to the leaf that moved rather than to the subtree', () => {
    expect(diffMerged({ a: { b: 1, c: 2 } }, { a: { b: 9, c: 2 } })).to.deep.equal([
      { path: 'a.b', previous: 1, value: 9 },
    ]);
  });

  it('should report a subtree replaced by something else once, at the subtree', () => {
    // not both plain objects, so there is nothing to recurse into
    expect(diffMerged({ a: { b: 1 } }, { a: 5 })).to.deep.equal([
      { path: 'a', previous: { b: 1 }, value: 5 },
    ]);
  });

  it('should report an array as a value rather than walking into it', () => {
    // which is what an app watching `exclude` wants: a list is a value
    expect(diffMerged({ x: [1, 2] }, { x: [1, 3] })).to.deep.equal([
      { path: 'x', previous: [1, 2], value: [1, 3] },
    ]);
  });

  it('should report a key added under a name Object.prototype has', () => {
    // `k in before` walks the prototype chain, so `'toString' in {}` is `true`
    // and an added `toString` never entered the key list at all -- measured,
    // `get('toString')` answered `42` with every handler told nothing. These are
    // ordinary JSON keys: `__proto__` and `constructor` are unreachable only
    // because `copyValue()` refuses them, and nothing refuses these. Found by
    // review
    for (const key of ['toString', 'valueOf', 'hasOwnProperty', 'isPrototypeOf']) {
      expect(diffMerged({}, { [key]: 42 }), key).to.deep.equal([
        { path: key, previous: undefined, value: 42 },
      ]);
    }
    // and one nested, so it is the walk rather than the root
    expect(diffMerged({ s: {} }, { s: { toString: 1 } })).to.deep.equal([
      { path: 's.toString', previous: undefined, value: 1 },
    ]);
  });

  it('should report a key that appeared and one that went', () => {
    expect(diffMerged({ a: 1 }, { b: 2 })).to.deep.equal([
      { path: 'a', previous: 1, value: undefined },
      { path: 'b', previous: undefined, value: 2 },
    ]);
  });

  it('should report a key no dotted path can name at its parent', () => {
    // which is what makes `get(change.path) === change.value` an invariant: a
    // change reported at a key holding a `.` would hand the app a path that
    // reads as a nested one, and `get()` of it answers `undefined`
    expect(diffMerged({ 'a.b': 1 }, { 'a.b': 2 })).to.deep.equal([
      { path: '', previous: { 'a.b': 1 }, value: { 'a.b': 2 } },
    ]);
    // one level in, so the parent is a real path rather than the root
    expect(diffMerged({ s: { 'a.b': 1 } }, { s: { 'a.b': 2 } })).to.deep.equal([
      { path: 's', previous: { 'a.b': 1 }, value: { 'a.b': 2 } },
    ]);
    // and an empty key, which `segments('')` reads as no path at all
    expect(diffMerged({ '': 1 }, { '': 2 })).to.deep.equal([
      { path: '', previous: { '': 1 }, value: { '': 2 } },
    ]);
  });

  it('should not report a dotted key beside an expressible one twice', () => {
    // the whole object is one change where any inexpressible key moved, so the
    // changes never overlap -- without which a reader gets both `s` and `s.ok`
    expect(diffMerged({ s: { 'a.b': 1, ok: 1 } }, { s: { 'a.b': 2, ok: 2 } })).to.deep.equal([
      { path: 's', previous: { 'a.b': 1, ok: 1 }, value: { 'a.b': 2, ok: 2 } },
    ]);
  });

  it('should leave a dotted key that did not move out of it', () => {
    // the inexpressible rule fires on a dotted key that **moved**, not on one
    // that is merely there -- or every config with a flat dotted key in it
    // would report every change at the root
    expect(diffMerged({ s: { 'a.b': 1, ok: 1 } }, { s: { 'a.b': 1, ok: 2 } })).to.deep.equal([
      { path: 's.ok', previous: 1, value: 2 },
    ]);
  });
});

describe('watch()', () => {
  /** A config over one stub layer, with a fake source and a collected log. */
  function watched(value: unknown, opts: { debounce?: number } = {}) {
    const store = stubStore(value);
    const source = fakeSource();
    const errors: unknown[] = [];
    const config = createConfigSync({
      layers: [{ name: 'user', store }],
      watch: { ...opts, onError: (e) => errors.push(e), source },
    });
    return { config, errors, source, store };
  }

  it('should publish what moved when the file did', () => {
    const { config, source, store } = watched({ server: { port: 1, host: 'a' } });
    const seen: readonly ConfigChange[][] = [];
    config.watch((changes) => (seen as ConfigChange[][]).push([...changes]));

    store.set({ server: { port: 2, host: 'a' } });
    source.fire();
    vi.advanceTimersByTime(50);

    expect(seen).to.deep.equal([[{ path: 'server.port', previous: 1, value: 2 }]]);
    expect(config.get('server.port')).toBe(2);
  });

  it('should publish nothing where the reload read what it already held', () => {
    // point 6: **our own write fires the watcher.** The value a reload reads
    // back is the one `save()` just wrote, so the diff is empty -- which is
    // better than suppressing events for a window after a write, because that
    // also swallows somebody else's write in the same window
    const { config, source, store } = watched({ a: 1 });
    let fired = 0;
    config.watch(() => fired++);
    // **after** the watch, because `createConfigSync` already read the store
    // once at construction -- so a `> 0` here passes with the reload deleted,
    // which is what this test is for. Found by review
    const before = store.reads();

    source.fire();
    vi.advanceTimersByTime(50);

    expect(store.reads() - before).toBe(1);
    expect(fired).toBe(0);
  });

  it('should coalesce one logical save into one reload', () => {
    // one save is two to five events -- vim writes a backup, truncates and
    // renames; ours writes a temp file and renames it
    const { config, source, store } = watched({ a: 1 });
    const before = store.reads();
    let fired = 0;
    config.watch(() => fired++);

    store.set({ a: 2 });
    for (let i = 0; i < 5; i++) {
      source.fire();
      vi.advanceTimersByTime(10);
    }
    vi.advanceTimersByTime(50);

    expect(store.reads() - before).toBe(1);
    expect(fired).toBe(1);
  });

  it('should keep the last good value where a read fails, and retry it', () => {
    // a read that lands mid-write is **expected**, so a failure retries and the
    // last good value is kept -- replacing a working config with a parse error
    // because the editor had not finished writing is the worst available outcome
    const { config, errors, source, store } = watched({ a: 1 });
    config.watch(() => {});

    store.fail();
    source.fire();
    vi.advanceTimersByTime(50);

    expect(config.get('a')).toBe(1);
    expect(errors).to.deep.equal([]);

    // the retry, which lands after the file settled
    store.set({ a: 2 });
    vi.advanceTimersByTime(50);

    expect(config.get('a')).toBe(2);
    expect(errors).to.deep.equal([]);
  });

  it('should report a read that kept failing, and keep the last good value', () => {
    const { config, errors, source, store } = watched({ a: 1 });
    config.watch(() => {});

    store.fail(new Error('broken json'));
    source.fire();
    vi.advanceTimersByTime(50);
    expect(errors).to.deep.equal([]);
    vi.advanceTimersByTime(50);

    expect(errors).toHaveLength(1);
    expect((errors[0] as Error).message).toBe('broken json');
    expect(config.get('a')).toBe(1);
  });

  it('should reset the retry when a new event arrives', () => {
    // which falls out of rescheduling from scratch, and is the behaviour the
    // retry wants: a window that keeps being disturbed has not settled
    const { config, errors, source, store } = watched({ a: 1 });
    config.watch(() => {});

    store.fail();
    source.fire();
    vi.advanceTimersByTime(50);
    // the retry is pending; a new event replaces it with a first attempt again
    source.fire();
    vi.advanceTimersByTime(50);
    expect(errors).to.deep.equal([]);
    // so it takes one more window to be reported, rather than that one
    vi.advanceTimersByTime(50);
    expect(errors).toHaveLength(1);
  });

  it('should publish nothing for a change a higher layer shadows', () => {
    // the one thing a per-file watcher can never tell you: what is compared is
    // the merged view rather than the file
    const store = stubStore({ a: 1 });
    const source = fakeSource();
    const config = createConfigSync({
      layers: [
        { name: 'system', store },
        { name: 'user', store: object({ a: 99 }) },
      ],
      watch: { source },
    });
    let fired = 0;
    config.watch(() => fired++);
    const reads = store.reads();

    store.set({ a: 2 });
    source.fire();
    vi.advanceTimersByTime(50);

    expect(fired).toBe(0);
    expect(config.get('a')).toBe(99);
    // and the layer really did **read**, so the shadow is what suppressed the
    // publish rather than nothing having happened. `dirty` was the first
    // spelling of this and is `false` before the event too, so it passed with
    // the watcher never registered. Found by review
    expect(store.reads() - reads).toBe(1);
  });

  it('should hand a path handler its own value rather than a change it was near', () => {
    // the prefix reading over-fires: `{a: 1}` becoming `{a: {b: 2}}` is one
    // change at `a`, and `a.c` is prefix-related to it while being `undefined`
    // on both sides
    const { config, source, store } = watched({ a: 1 });
    const seen: ConfigChange[] = [];
    config.watch('a.c', (change) => seen.push(change));
    let near = 0;
    config.watch('a.b', () => near++);

    store.set({ a: { b: 2 } });
    source.fire();
    vi.advanceTimersByTime(50);

    expect(seen).to.deep.equal([]);
    expect(near).toBe(1);
  });

  it('should fire a path handler when a subtree above it was replaced', () => {
    const { config, source, store } = watched({ s: { port: 1 } });
    const seen: ConfigChange[] = [];
    config.watch('s.port', (change) => seen.push(change));

    store.set({ s: { port: 2 } });
    source.fire();
    vi.advanceTimersByTime(50);

    expect(seen).to.deep.equal([{ path: 's.port', previous: 1, value: 2 }]);
  });

  it('should keep every change path one get() agrees with', () => {
    // the invariant the inexpressible-key rule exists for, asserted over a
    // config holding every shape of it
    const { config, source, store } = watched({ 'a.b': 1, n: { 'x.y': 1, ok: 1 }, p: 1 });
    let changes: readonly ConfigChange[] = [];
    config.watch((it) => (changes = it));

    store.set({ 'a.b': 2, n: { 'x.y': 2, ok: 2 }, p: 2 });
    source.fire();
    vi.advanceTimersByTime(50);

    expect(changes.length).toBeGreaterThan(0);
    for (const change of changes) {
      expect(config.get(change.path), change.path).to.deep.equal(change.value);
    }
  });

  it('should dispatch over a copy and a membership check', () => {
    // the two rules every handler set here keeps, and they are two: without the
    // copy a handler that registers another sees its own event, and without the
    // `has` one that unregistered during the dispatch is called anyway
    const { config, errors, source, store } = watched({ a: 1 });
    const order: string[] = [];
    const stops: (() => void)[] = [];
    let added = 0;

    // the first registration is the one that runs first, so it is the one that
    // can reach the second's disposer -- which does not exist yet, hence the
    // array. Nothing is asserted *inside* a handler, because the dispatch
    // reports a throw rather than raising it, so an assertion there is one a
    // vacuous pass can swallow; `errors` below is what says none was
    config.watch(() => {
      order.push('first');
      stops[0]?.();
      config.watch(() => added++);
    });
    stops.push(config.watch(() => order.push('second')));
    expect(stops).toHaveLength(1);

    store.set({ a: 2 });
    source.fire();
    vi.advanceTimersByTime(50);

    // the second was removed during the dispatch and was not called
    expect(order).to.deep.equal(['first']);
    // and the one registered during it did not see the event it was born in
    expect(added).toBe(0);
    expect(errors).to.deep.equal([]);
  });

  it('should not read a handler that returned a bare thenable as a failure', async () => {
    // reading `.then` establishes that something is a thenable and not that it
    // is a promise: a bare `{ then(res) { res() } }` has no `.catch`, so
    // calling one threw a `TypeError` inside the dispatch's own `try` and a
    // handler that **succeeded** was reported to `onError` as a failure of
    // ours. `Promise.resolve()` adopts it instead. Found by review
    const { config, errors, source, store } = watched({ a: 1 });
    let ran = 0;
    // `no-thenable` is right about every other object in this repository and
    // this construct is the test's whole subject, so it is disabled for exactly
    // these lines and put back. A **block** pair rather than
    // `-next-line`, because that one is a comment a formatter can detach from
    // the line it was written over -- the shape this repository already records
    // going quiet. Obscuring the key was the other option and serves the
    // linter rather than the reader; oxlint folds a `const` and flags
    // `Object.defineProperty` too, so the obscuring would have had to be real
    /* oxlint-disable unicorn/no-thenable */
    config.watch((): unknown => {
      ran++;
      return {
        then(resolve: (value: unknown) => void): void {
          resolve(undefined);
        },
      };
    });
    /* oxlint-enable unicorn/no-thenable */

    store.set({ a: 2 });
    source.fire();
    vi.advanceTimersByTime(50);
    await Promise.resolve();
    await Promise.resolve();

    expect(ran).toBe(1);
    expect(errors).to.deep.equal([]);
  });

  it('should report an async handler that rejected rather than losing it', async () => {
    // a `try` cannot catch a rejection, and the handler types return `void`, so
    // TypeScript takes an `async` one happily: `config.watch(async () => {
    // throw ... })` was an **unhandled rejection** from a timer callback, which
    // is the one thing `onError` says must not happen. Found by review
    const { config, errors, source, store } = watched({ a: 1 });
    let after = 0;
    config.watch(async () => {
      await Promise.resolve();
      throw new Error('async handler');
    });
    config.watch(() => after++);

    store.set({ a: 2 });
    source.fire();
    vi.advanceTimersByTime(50);
    // the rejection lands on a later microtask, which is what fire-and-forget
    // means: nothing awaits the handler
    await Promise.resolve();
    await Promise.resolve();

    expect(after).toBe(1);
    expect(errors).toHaveLength(1);
    expect((errors[0] as Error).message).toBe('async handler');
  });

  it('should report an async path handler that rejected', async () => {
    // the **path** form as well as the whole-view one, because each has its own
    // wrapper and each has to hand the promise back rather than swallow it --
    // the all form's test passed with the path form's return still discarded
    const { config, errors, source, store } = watched({ a: 1 });
    config.watch('a', async () => {
      await Promise.resolve();
      throw new Error('async path');
    });

    store.set({ a: 2 });
    source.fire();
    vi.advanceTimersByTime(50);
    await Promise.resolve();
    await Promise.resolve();

    expect(errors).toHaveLength(1);
    expect((errors[0] as Error).message).toBe('async path');
  });

  it('should report a handler that threw and still run the rest', () => {
    // `onFrame`'s rule: this is an observer of a change, and a failing observer
    // must not stop the others being told about something that really happened
    const { config, errors, source, store } = watched({ a: 1 });
    let after = 0;
    config.watch(() => {
      throw new Error('handler');
    });
    config.watch(() => after++);

    store.set({ a: 2 });
    source.fire();
    vi.advanceTimersByTime(50);

    expect(after).toBe(1);
    expect(errors).toHaveLength(1);
    expect((errors[0] as Error).message).toBe('handler');
  });

  it('should watch nothing until the first handler and stop with the last', () => {
    // the file watchers start when the first handler registers and stop when
    // the last one goes, so a config nobody watches opens no descriptor
    const { config, source } = watched({ a: 1 });
    expect(source.live()).toBe(0);

    const a = config.watch(() => {});
    expect(source.live()).toBe(1);
    const b = config.watch(() => {});
    expect(source.live()).toBe(1);

    a();
    expect(source.live()).toBe(1);
    b();
    expect(source.live()).toBe(0);
  });

  it('should take a disposer called more than once', () => {
    const { config, source } = watched({ a: 1 });
    const stop = config.watch(() => {});
    const other = config.watch(() => {});
    stop();
    stop();
    expect(source.live()).toBe(1);
    other();
    expect(source.live()).toBe(0);
  });

  it('should hold no timer the process has to wait for', () => {
    // `unref()`'d, which is the rule the spinner's timer, the frame timer and
    // the update check already follow: a CLI that reads config and exits exits.
    //
    // A **spy** rather than `vi.getTimerCount()`, which is the shape
    // `animation.test.ts` already uses for this claim and for this reason:
    // vitest's fake timers do not model `unref`, so the count is 1 either way
    // and an assertion on it cannot see the difference
    const unreffed: boolean[] = [];
    const real = globalThis.setTimeout;
    const spy = vi.spyOn(globalThis, 'setTimeout').mockImplementation(((
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
      const { config, source } = watched({ a: 1 });
      config.watch(() => {});
      source.fire();
      expect(unreffed).to.deep.equal([true]);
    } finally {
      spy.mockRestore();
    }
  });

  it('should forget a pending reload when the last handler goes', () => {
    const { config, source, store } = watched({ a: 1 });
    const stop = config.watch(() => {});
    store.set({ a: 2 });
    source.fire();
    stop();
    vi.advanceTimersByTime(50);
    // the reload never ran, so the layer still holds what it read at startup
    expect(config.get('a')).toBe(1);
  });

  it('should overwrite an unsaved set, and say so', () => {
    // **a reload is a reload.** An unsaved `delete()` is restored by one, so an
    // unsaved `set()` is overwritten by one -- and the app is told, which is
    // what makes that affordable
    const { config, source, store } = watched({ a: 1 });
    const seen: ConfigChange[] = [];
    config.watch('a', (change) => seen.push(change));

    config.set('a', 50);
    expect(config.layers[0]?.dirty).toBe(true);

    store.set({ a: 2 });
    source.fire();
    vi.advanceTimersByTime(50);

    expect(config.get('a')).toBe(2);
    expect(seen).to.deep.equal([{ path: 'a', previous: 50, value: 2 }]);
    // and the layer is what the file says, so there is nothing left unsaved
    expect(config.layers[0]?.dirty).toBe(false);
  });

  it('should not let a reload inside an await save() discard what was being saved', async () => {
    // the one interleaving `readSync()` does not make atomic. `save()` yields
    // at its `await store.read()`, so a debounce that fires there used to clear
    // `touched` and reassign `value` -- after which `#staged()` claimed no
    // paths, wrote the document it had read, and `save()` returned the layer as
    // written having silently discarded the `set()`. Measured: the file kept
    // `{a: 1}`, memory reverted to 1, and the return said `['user']`
    const { config, source, store } = watched({ a: 1 });
    config.watch(() => {});

    // a read this test resolves by hand, which is a macrotask yield without a
    // real one -- `Promise.resolve()` would lose to the timer the other way
    let release: () => void = () => {};
    store.hold(
      () =>
        new Promise<void>((r) => {
          release = r;
        })
    );

    config.set('a', 2);
    source.fire();

    const saving = config.save();
    vi.advanceTimersByTime(50);
    release();
    const written = await saving;

    expect(store.value(), 'what reached the file').to.deep.equal({ a: 2 });
    expect(config.get('a'), 'what the config holds').toBe(2);
    expect(written).to.deep.equal(['user']);
  });

  it('should hold the save latch until the last overlapping save of a layer is out', async () => {
    // `save()` is public and `async`, so two of them for one layer overlap on
    // any app that does not await the first -- and the latch was a `Set`, which
    // records that a save is running rather than how many. So the first one's
    // `finally` released it while the second was still awaiting its own read,
    // and the reload the latch exists to refuse got straight through.
    //
    // Measured on the sequence below: `dirty` went **false** mid-save, and the
    // `set()` made in that window was discarded from the file *and* from
    // memory with `save()` reporting success. The round-2 failure this latch is
    // for, reached through two saves rather than one. Found by review
    const { config, source, store } = watched({ a: 1 });
    config.watch(() => {});

    // a resolver per read rather than one gate, because two reads are in
    // flight and releasing them in order is the whole of the interleaving --
    // the single-slot `hold()` the test above it uses would overwrite the
    // first one's resolver with the second's
    const gates: (() => void)[] = [];
    store.hold(() => new Promise<void>((r) => gates.push(r)));

    config.set('a', 2);
    const first = config.save();
    // while the first is awaiting its read, which is where `#targets()` still
    // sees the layer as dirty and so includes it in the second save too
    config.set('b', 3);
    const second = config.save();

    gates[0]?.();
    // three turns: the read resolves, the write resolves, and the `finally`
    // runs -- which is where the `Set` released a latch the second save was
    // still inside
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    // something unsaved for a reload to discard, and a file that moved under
    // us so that the reload has a change to publish
    config.set('c', 4);
    store.set({ a: 2, b: 3, external: 1 });
    source.fire();
    vi.advanceTimersByTime(50);

    expect(config.layers[0]?.dirty, 'still dirty mid-save').toBe(true);
    expect(config.get('c'), 'the set() made in the window').toBe(4);

    gates[1]?.();
    await first;
    await second;

    // and it reaches the file, beside the key the other process wrote, which
    // is the claimed paths doing their own job on top
    expect(store.value()).to.deep.equal({ a: 2, b: 3, c: 4, external: 1 });
  });

  it('should still read a write that landed while the save was in flight', async () => {
    // which is what makes the refusal a *re-schedule* rather than a drop: the
    // event said the file moved, and the save is the one thing that cannot
    // answer what it moved to. Dropping it is the timer-based suppression point
    // 6 refuses -- it swallows somebody else's write in the same window
    const { config, source, store } = watched({ a: 1 });
    const seen: ConfigChange[] = [];
    config.watch('a', (change) => seen.push(change));

    let release: () => void = () => {};
    store.hold(
      () =>
        new Promise<void>((r) => {
          release = r;
        })
    );

    // something to save, or `save()` touches no file and takes no latch --
    // which is `#targets()`'s own rule and is what made the first version of
    // this test pass for the wrong reason
    config.set('a', 2);
    source.fire();
    const saving = config.save('user');
    vi.advanceTimersByTime(50);
    release();
    await saving;

    // somebody else wrote, between our write and the reload we re-scheduled
    store.set({ a: 99 });
    vi.advanceTimersByTime(50);

    expect(seen).to.deep.equal([{ path: 'a', previous: 2, value: 99 }]);
    expect(config.get('a')).toBe(99);
  });

  it('should report what a write would lose as of the latest read', () => {
    // `wouldLose` is documented as the diagnostic an app consults **before**
    // saving, and the watcher is what makes the file change under a live
    // `Config` -- so left at its construction value it is a lying one: watch a
    // layer whose file had no trivia, let an editor add a comment the store
    // cannot carry, and the app is told the write is lossless. Found by review
    const { config, source, store } = watched({ a: 1 });
    config.watch(() => {});
    expect(config.layers[0]?.wouldLose).toBeUndefined();

    store.set({ a: 2 });
    store.lose([{ kind: 'comment', detail: 'line 1' }]);
    source.fire();
    vi.advanceTimersByTime(50);

    expect(config.get('a')).toBe(2);
    expect(config.layers[0]?.wouldLose).to.deep.equal([{ kind: 'comment', detail: 'line 1' }]);

    // and it goes away again, because it is a fact about the file as last read
    // rather than something that accumulates
    store.lose(undefined);
    store.set({ a: 3 });
    source.fire();
    vi.advanceTimersByTime(50);

    expect(config.layers[0]?.wouldLose).toBeUndefined();
  });

  it('should re-read what a write would lose even where the value did not move', () => {
    // the half a value-keyed assignment would miss: a file whose comments moved
    // and whose values did not publishes nothing and still has a different
    // answer, which is why this is assigned beside `touched.clear()` rather
    // than past the unchanged early return
    const { config, source, store } = watched({ a: 1 });
    config.watch(() => {});

    store.lose([{ kind: 'anchor', detail: 'line 4' }]);
    source.fire();
    vi.advanceTimersByTime(50);

    expect(config.layers[0]?.wouldLose).to.deep.equal([{ kind: 'anchor', detail: 'line 4' }]);
  });

  it('should leave the merged view it was holding, object and all', () => {
    // a reload that publishes nothing must change nothing **observable**, and
    // the identity of what `get()` hands back is observable: an app that keeps
    // a reference and compares it -- a memo, a render cache -- would see a
    // change where the file said the same thing
    const { config, source } = watched({ server: { port: 1 } });
    config.watch(() => {});
    const before = config.get('server');

    source.fire();
    vi.advanceTimersByTime(50);

    expect(config.get('server')).toBe(before);
  });

  it('should report a source disposer that threw and still call the rest', () => {
    // put back what was attached, and keep going: a source whose disposer throws
    // must not strand the others
    const stopped: string[] = [];
    const errors: unknown[] = [];
    const config = createConfigSync({
      layers: [
        { name: 'a', store: stubStore({}) },
        { name: 'b', store: stubStore({}) },
      ],
      watch: {
        onError: (e) => errors.push(e),
        source: ((path: string) => () => {
          stopped.push(path);
          throw new Error(`disposer ${stopped.length}`);
        }) as never,
      },
    });

    const stop = config.watch(() => {});
    expect(() => stop()).not.toThrow();
    expect(stopped).toHaveLength(2);
    expect(errors).toHaveLength(2);
  });

  it('should clear dirty on a reload that published nothing', () => {
    // a successful read means the layer **is** what the file says, which is
    // exactly what `dirty` reports -- the compare decides whether to publish,
    // which is a different question
    const { config, source } = watched({ a: 1 });
    config.watch(() => {});
    config.set('a', 1);
    expect(config.layers[0]?.dirty).toBe(true);

    source.fire();
    vi.advanceTimersByTime(50);

    expect(config.layers[0]?.dirty).toBe(false);
  });

  it('should publish an object layer re-applied through apply()', () => {
    // an object layer has no file to watch, so `apply()` is its only way into
    // the diff -- and it is the explicit reload the same rule is stated for
    const config = createConfigSync({ layers: [{ name: 'app', store: object({ a: 1 }) }] });
    const seen: ConfigChange[] = [];
    config.watch('a', (change) => seen.push(change));

    config.apply('app', { a: 2 });

    expect(seen).to.deep.equal([{ path: 'a', previous: 1, value: 2 }]);
  });

  it('should publish nothing for an apply() that changed nothing', () => {
    const config = createConfigSync({ layers: [{ name: 'app', store: object({ a: 1 }) }] });
    let fired = 0;
    config.watch(() => fired++);
    config.apply('app', { a: 1 });
    expect(fired).toBe(0);
  });

  it('should publish nothing for a set(), which is the app telling itself', () => {
    const config = createConfigSync({ layers: [{ name: 'app', store: object({ a: 1 }) }] });
    let fired = 0;
    config.watch(() => fired++);
    config.set('a', 2);
    config.delete('a');
    config.push('list', 1);
    expect(fired).toBe(0);
  });

  it('should latch a layer against a reload reached from inside its own', () => {
    // the per-layer latch, released in a `finally`, which is `scrollTo()`'s own
    // rule. What reaches it is the caller's code running inside the reload: a
    // store's `readSync()`, or -- as here -- a source that fires synchronously
    // from a handler, where the timer is run inside the dispatch
    const { config, source, store } = watched({ a: 1 });
    let fired = 0;
    config.watch(() => {
      fired++;
      if (fired < 5) {
        store.set({ a: fired + 10 });
        source.fire();
        // runs the debounce inside the dispatch, which is the one thing that
        // can re-enter the reload for this layer
        vi.advanceTimersByTime(50);
      }
    });

    store.set({ a: 2 });
    source.fire();
    vi.advanceTimersByTime(50);

    // the inner event was latched out, so the handler ran once -- and the timer
    // it scheduled is still pending rather than lost
    expect(fired).toBe(1);
  });

  it('should keep reloading after a reload that published nothing', () => {
    // the `finally`'s real job, which is **the early returns** rather than a
    // throw: `#reload` returns from inside the `try` three times -- a retry, a
    // report, and an unchanged value -- and a `return` inside a `try` skips
    // anything after the block, so without the `finally` the first unchanged
    // reload would leave the layer latched for the life of the process. A
    // review round read the latch as only reachable by a throw; the sabotage
    // that moves the delete out of the `finally` is caught by this shape
    const { config, source, store } = watched({ a: 1 });
    let fired = 0;
    config.watch(() => fired++);

    // an unchanged read, which takes the early return
    source.fire();
    vi.advanceTimersByTime(50);
    expect(fired).toBe(0);

    store.set({ a: 2 });
    source.fire();
    vi.advanceTimersByTime(50);
    expect(fired).toBe(1);
  });

  it('should keep reloading after a handler threw', () => {
    // a handler's throw never reaches `#reload`, because the dispatch catches
    // it first -- so what this pins is the ordinary exit and that one bad
    // handler does not stop the next reload, rather than the `finally` itself
    const { config, errors, source, store } = watched({ a: 1 });
    let fired = 0;
    config.watch(() => {
      fired++;
      throw new Error('boom');
    });

    store.set({ a: 2 });
    source.fire();
    vi.advanceTimersByTime(50);
    expect(fired).toBe(1);

    store.set({ a: 3 });
    source.fire();
    vi.advanceTimersByTime(50);
    expect(fired).toBe(2);
    expect(errors).toHaveLength(2);
  });

  it('should take the debounce the caller asked for', () => {
    const { config, source, store } = watched({ a: 1 }, { debounce: 500 });
    let fired = 0;
    config.watch(() => fired++);

    store.set({ a: 2 });
    source.fire();
    vi.advanceTimersByTime(499);
    expect(fired).toBe(0);
    vi.advanceTimersByTime(1);
    expect(fired).toBe(1);
  });

  it('should fall back for a debounce that is not a delay, and clamp a huge one', () => {
    // the rule every timer option here keeps: a value that is not a finite
    // number at or above zero is not an instruction, and a finite one past
    // 2^31-1 is clamped rather than read by node as `1`
    for (const debounce of [Number.NaN, -1, Number.POSITIVE_INFINITY, 'x' as never]) {
      const { config, source, store } = watched({ a: 1 }, { debounce });
      let fired = 0;
      config.watch(() => fired++);
      store.set({ a: 2 });
      source.fire();
      vi.advanceTimersByTime(49);
      expect(fired, String(debounce)).toBe(0);
      vi.advanceTimersByTime(1);
      expect(fired, String(debounce)).toBe(1);
    }

    // the clamp is read off what `setTimeout` was **handed**, because vitest's
    // fake timers emulate node's own 32-bit truncation -- so advancing past it
    // fires either way and an assertion on the firing cannot see the clamp
    const delays: unknown[] = [];
    const real = globalThis.setTimeout;
    const spy = vi.spyOn(globalThis, 'setTimeout').mockImplementation(((
      ...args: Parameters<typeof real>
    ) => {
      delays.push(args[1]);
      return real(...args);
    }) as never);

    try {
      const { config, source } = watched({ a: 1 }, { debounce: 2 ** 40 });
      config.watch(() => {});
      source.fire();
      expect(delays).to.deep.equal([2 ** 31 - 1]);
    } finally {
      spy.mockRestore();
    }
  });

  it('should refuse to watch a source that is not a file path, and say so', () => {
    // `ConfigStore.source` is documented as "a path, a URL, or nothing", so the
    // interface invites one -- and read as a path a URL climbs to the working
    // directory and watches that, which is a watcher that is dead and says
    // nothing. Found by review
    //
    // Through **`json()`** rather than a stub whose `source` is written by
    // hand, which is the hole a second review found: a real store's source went
    // through `expand()`, which normalizes, so what the guard was handed was
    // `https:/example.com/config.json` with **one slash** -- and a `://` test
    // never fired for any source this repository can produce. The stub bypassed
    // `expand()`, so the test passed while the guard was dead
    for (const url of [
      'https://example.com/config.json',
      's3://bucket/key',
      // no slashes at all, which the doc invites as readily
      's3:bucket/key',
    ]) {
      const source = fakeSource();
      const errors: unknown[] = [];
      const config = createConfigSync({
        layers: [{ name: 'remote', store: json(url) }],
        watch: { onError: (e) => errors.push(e), source },
      });

      config.watch(() => {});
      expect(source.live(), url).toBe(0);
      expect(errors, url).toHaveLength(1);
      expect((errors[0] as Error).message, url).toContain('not a file path');
    }
  });

  it('should refuse the shape win32 normalize makes of a URL, on every platform', () => {
    // the other half of the same `normalize()`, and the one no `json()` on this
    // platform can produce: on win32 `normalize('https://host/cfg.json')` is
    // `.\\https:\\host\\cfg.json`, because it reads the `//` as a separator and
    // makes the result explicitly relative -- so the scheme is no longer at the
    // start of the string and an anchored test misses it. The guard was dead
    // for the two-slash form, which is the common one, on Windows alone.
    //
    // Caught by CI on all three Windows jobs and nowhere else, which is why
    // these are fed **as literals through a stub** rather than through
    // `json()`. That is the opposite call from the test above and for the
    // opposite reason: there a stub bypassed `expand()` and hid a dead guard,
    // and here `expand()` on this platform cannot produce the shape under test
    // at all, so a literal is the only way the Windows half is visible from a
    // Mac. Both are needed -- the real store pins what this platform produces,
    // and these pin what the other one does
    for (const at of [
      '.\\https:\\example.com\\config.json',
      '.\\s3:\\bucket\\key',
      // and the POSIX spelling of the same prefix, which `normalize()` strips
      // today and which costs nothing to refuse if it ever stops
      './https:/example.com/config.json',
    ]) {
      const source = fakeSource();
      const errors: unknown[] = [];
      const config = createConfigSync({
        layers: [{ name: 'remote', store: { ...json('/tmp/unused.json'), source: at } }],
        watch: { onError: (e) => errors.push(e), source },
      });

      config.watch(() => {});
      expect(source.live(), at).toBe(0);
      expect(errors, at).toHaveLength(1);
      expect((errors[0] as Error).message, at).toContain('not a file path');
    }
  });

  it('should still watch a path whose own first segment merely looks relative', () => {
    // the prefix is `normalize()`'s noise rather than part of a name, so what
    // must not go with it is an ordinary relative path: `./config.json` has no
    // scheme and `./a/config.json` has no colon, and both are watched. The
    // guard reads a colon after the prefix and nothing else
    for (const at of ['./config.json', './a/config.json', '.\\a\\config.json']) {
      const source = fakeSource();
      const errors: unknown[] = [];
      const config = createConfigSync({
        layers: [{ name: 'local', store: { ...json('/tmp/unused.json'), source: at } }],
        watch: { onError: (e) => errors.push(e), source },
      });

      config.watch(() => {});
      expect(errors, at).toHaveLength(0);
      expect(source.live(), at).toBe(1);
    }
  });

  it('should still watch a Windows drive letter, which is not a scheme', () => {
    // one character before the colon, which is what the two-or-more scheme
    // keeps out of the refusal above -- in all four spellings, because `C://x`
    // matched the `://` form the first version used and so was refused
    for (const win of [
      'C:\\app\\config.json',
      'C:/app/config.json',
      'C://app/config.json',
      'C:app',
    ]) {
      const source = fakeSource();
      const config = createConfigSync({
        layers: [{ name: 'win', store: { ...stubStore({}), source: win } }],
        watch: { source },
      });
      config.watch(() => {});
      expect(source.live(), win).toBe(1);
    }
  });

  it('should watch no layer that has no path to watch', () => {
    const source = fakeSource();
    const config = createConfigSync({
      layers: [{ name: 'app', store: object({ a: 1 }) }],
      watch: { source },
    });
    config.watch(() => {});
    expect(source.live()).toBe(0);
  });

  it('should share one registration per layer, and one per watched layer only', () => {
    const source = fakeSource();
    const config = createConfigSync({
      layers: [
        { name: 'a', store: stubStore({}) },
        { name: 'b', store: stubStore({}) },
        { name: 'c', store: object({}) },
      ],
      watch: { source },
    });
    const stop = config.watch(() => {});
    expect(source.live()).toBe(2);
    stop();
    expect(source.live()).toBe(0);
  });

  it('should refuse a watch that cannot mean anything', () => {
    const config = createConfigSync({ layers: [{ name: 'a', store: object({}) }] });
    expect(() => config.watch('a', undefined as never)).toThrow(/needs a handler/);
    expect(() => config.watch(undefined as never)).toThrow(/needs a handler/);
    expect(() => config.watch('', () => {})).toThrow(/without a path/);
    // `segments()`'s own guard, which is the third door a caller's path arrives
    // through
    expect(() => config.watch('__proto__', () => {})).toThrow(/not a safe key/);
    expect(() => config.watch('a..b', () => {})).toThrow(/empty segment/);
  });

  it('should refuse watch options that are not options', () => {
    // `assertEnv()`'s reason: a non-object quietly meant "every default", so an
    // app that mistyped `poll` got events it had decided would never arrive
    for (const watch of [42, 'poll', [], null] as never[]) {
      expect(() => createConfigSync({ watch })).toThrow(/watch options must be an object/);
    }
  });

  it('should refuse a field that has nothing to fall back to', () => {
    // the three with no coercion, where falling back is a **different answer**
    // rather than a default: a `source` that is not a function would silently
    // get the built-in watcher, an `onError` that is not one would send every
    // report to a log nobody reads, and a non-boolean `poll` picks the
    // works-in-dev-dead-in-Docker failure the option exists to prevent
    for (const onError of [42, 'log', {}, null] as never[]) {
      expect(() => createConfigSync({ watch: { onError } })).toThrow(
        /watch onError must be a function/
      );
    }
    for (const source of [42, 'fs', {}, null] as never[]) {
      expect(() => createConfigSync({ watch: { source } })).toThrow(
        /watch source must be a function/
      );
    }
    for (const poll of [1, 0, 'yes', null] as never[]) {
      expect(() => createConfigSync({ watch: { poll } })).toThrow(/watch poll must be a boolean/);
    }
    // and `undefined` is the absence rather than a mistake, which is what makes
    // the refusals above about a value somebody wrote
    expect(() =>
      createConfigSync({ watch: { onError: undefined, poll: undefined, source: undefined } })
    ).not.toThrow();
  });

  it('should report a source that refused one layer and still start the rest', () => {
    const errors: unknown[] = [];
    let started = 0;
    const config = createConfigSync({
      layers: [
        { name: 'a', store: stubStore({}) },
        { name: 'b', store: stubStore({}) },
      ],
      watch: {
        onError: (e) => errors.push(e),
        source: (() => {
          started++;
          if (started === 1) {
            throw new Error('no watch here');
          }
          return () => {};
        }) as never,
      },
    });
    config.watch(() => {});
    expect(started).toBe(2);
    expect(errors).toHaveLength(1);
  });

  it('should not crash where the app named no onError', () => {
    // named for what it asserts: the floor is the `sigil:config` debug log,
    // which is silent without `DEBUG`, so nothing here can see it -- and a test
    // named for the log that asserts `not.toThrow()` would pass with the
    // logging deleted. That claim is in `watch-debug.test.ts`, which sets the
    // variable before the import. Found by review
    const store = stubStore({ a: 1 });
    const source = fakeSource();
    const config = createConfigSync({ layers: [{ name: 'u', store }], watch: { source } });
    config.watch(() => {
      throw new Error('unreported');
    });

    store.set({ a: 2 });
    source.fire();
    expect(() => vi.advanceTimersByTime(50)).not.toThrow();
  });

  it('should not let an onError that threw stop the handler after it', () => {
    // a reporter with nowhere left to report to: raising from there would take
    // down whatever was being told -- another handler's turn, or a reload. What
    // it *logs* is `watch-debug.test.ts`'s, for the reason above
    const store = stubStore({ a: 1 });
    const source = fakeSource();
    const config = createConfigSync({
      layers: [{ name: 'u', store }],
      watch: {
        onError: () => {
          throw new Error('reporter');
        },
        source,
      },
    });
    let after = 0;
    config.watch(() => {
      throw new Error('handler');
    });
    config.watch(() => after++);

    store.set({ a: 2 });
    source.fire();
    expect(() => vi.advanceTimersByTime(50)).not.toThrow();
    expect(after).toBe(1);
  });
});
