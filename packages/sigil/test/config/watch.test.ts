import {
  createConfigSync,
  object,
  type ConfigChange,
  type ConfigDocument,
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
  reads: () => number;
  set: (next: unknown) => void;
} {
  let held = value;
  let error: unknown;
  let reads = 0;

  const read = (): ConfigDocument => {
    reads++;
    if (error !== undefined) {
      throw error;
    }
    return { value: held };
  };

  return {
    fail: (e: unknown = new Error('mid-write')): void => {
      error = e;
    },
    format: 'stub',
    read: (): Promise<ConfigDocument> => Promise.resolve(read()),
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
    // `Object.hasOwn`, not `b[key] === undefined`: a key written `undefined` is
    // a key the walk has to see, or `{ a: undefined }` and `{}` compare equal
    // and a change between them publishes nothing
    expect(sameValue({ a: undefined }, {})).toBe(false);
  });

  it('should make NaN equal to itself, which an object layer can hold', () => {
    // `Object.is` rather than `===`, or a `NaN` in an object layer reads as
    // moved on every reload
    expect(sameValue(Number.NaN, Number.NaN)).toBe(true);
    expect(sameValue({ a: Number.NaN }, { a: Number.NaN })).toBe(true);
    // and the cost of that choice, which is a change somebody really wrote
    expect(sameValue(0, -0)).toBe(false);
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

    source.fire();
    vi.advanceTimersByTime(50);

    expect(store.reads()).toBeGreaterThan(0);
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

    store.set({ a: 2 });
    source.fire();
    vi.advanceTimersByTime(50);

    expect(fired).toBe(0);
    expect(config.get('a')).toBe(99);
    // and the layer really did reload, so the shadow is what suppressed it
    expect(config.layers[0]?.dirty).toBe(false);
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

  it('should put the latch back after a handler threw', () => {
    // the `finally`, because a layer left deaf for the life of the process is
    // worse than the throw
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

    const { config, source, store } = watched({ a: 1 }, { debounce: 2 ** 40 });
    let fired = 0;
    config.watch(() => fired++);
    store.set({ a: 2 });
    source.fire();
    vi.advanceTimersByTime(2 ** 31);
    expect(fired).toBe(1);
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

  it('should fall back to the debug log where the app named nowhere', () => {
    // there is no default that can be right -- `console.error` from a library
    // corrupts a full-screen app's screen and throwing from a timer is an
    // uncaught exception -- so the floor is the silent one and this says the
    // absence of `onError` is not a crash
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

  it('should log an onError that threw rather than raising it', () => {
    // a reporter with nowhere left to report to: raising from there would take
    // down whatever was being told -- another handler's turn, or a reload
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
