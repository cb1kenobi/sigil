/**
 * The watcher's own machinery: the diff, the compare, and the two event
 * sources.
 *
 * What is **not** here is the state -- the handler set, the debounce timers and
 * the reload -- which lives on `Config`, because that is where the layers and
 * the merged view it reads live. Moving it out would move the coupling into a
 * parameter object rather than remove it. What is here is everything that can
 * be a function of its arguments, which is what makes it testable without a
 * config at all.
 *
 * ## Why a naive watcher does not work, measured rather than argued
 *
 * `fs.watch(file)` is the obvious implementation and it is a feature that works
 * until the first save and then stops, silently, for the life of the process.
 * Measured on macOS before any of this was written, over a real
 * temp-plus-rename:
 *
 * | what was watched              | first rename | second rename |
 * | ----------------------------- | ------------ | ------------- |
 * | the **file**                  | one event    | **nothing**   |
 * | the **directory** holding it  | three events | three events  |
 *
 * A rename swaps the inode, so a watch registered on the path is watching a
 * file nothing will ever write to again -- which is exactly why an editor that
 * saves atomically is the known case that breaks `fs.watch`, and ours is one.
 * The directory entry is what changes and the directory's own inode does not,
 * so watching the directory survives a create, a delete, a rename and an atomic
 * replace.
 *
 * ## The event is never read
 *
 * Not `eventType`, not `filename`. `'rename'` and `'change'` are not reliable
 * across platforms and `filename` is documented as provided only where the
 * platform supports it, so it can be `null` -- and a watcher that branches on
 * either behaves differently on macOS, Linux and Windows for reasons nobody can
 * see. **Any event in the watched directory means re-read and compare.**
 *
 * A basename filter is the obvious saving and is refused, on an asymmetry
 * rather than a preference: a filter can only ever *lose* an event, and the one
 * it is most likely to lose is the rename this whole module is named for
 * surviving -- because which name a rename reports is precisely the
 * platform-dependent thing above. Measured, our own write fires
 * `rename config.json.tmp` and `rename config.json` on macOS and the directory's
 * own name on the first event; a filter that guessed wrong there is the feature
 * silently not working. What not filtering costs is a wasted read of a small
 * file, which the compare absorbs.
 *
 * The one thing that costs is a directory with sustained churn -- a cache
 * directory, or `/tmp` -- where a writer other than ours means one `readFileSync`
 * per debounce window for as long as it runs. Named rather than guarded: a
 * config file in a directory something else writes to constantly is a layout to
 * change, and `debounce` is how a caller who cannot buys the window back.
 */

import debug from '../debug/index.js';
import { isPlainObject, readPath } from './dotted.js';
import type { ConfigChange, WatchOptions, WatchSource } from './types.js';
import { statSync, unwatchFile, watch as fsWatch, watchFile, type FSWatcher } from 'node:fs';
import { dirname, resolve } from 'node:path';

const { error: logError } = debug('sigil:config');

/** How long to wait for a write to settle. */
export const DEFAULT_DEBOUNCE = 50;

/** How often to poll under `poll`. */
export const DEFAULT_INTERVAL = 1000;

/**
 * How many times the climb may fail before it gives up.
 *
 * It fails only where the directory it just found has vanished between the
 * `statSync()` and the `fs.watch()`, and each failure means climbing one level
 * nearer a root that does not vanish -- so this is a bound on a loop that
 * terminates rather than a budget, and it is reached only by something
 * deleting a directory tree underneath us as fast as we can walk it.
 */
const MAX_CLIMB = 32;

/**
 * One registration, as the dispatch holds it.
 *
 * Both forms of `watch()` become one of these at registration time, so the
 * dispatch has no branches and one set keeps both forms in registration order.
 * The path form's own compare lives in the closure rather than in the dispatch,
 * which is what makes that true.
 */
export type Watcher = (changes: readonly ConfigChange[], before: unknown, after: unknown) => void;

/**
 * Whether two merged values are the same thing.
 *
 * Deliberately **not** `jsonc-write.ts`'s `same()`, which is `a === b` and says
 * where it lives that identity is "the safe direction to be narrow in" -- there
 * a false `false` costs a no-op edit. Here it is the other way round: this is
 * what decides whether to *publish*, so a false `false` is a spurious
 * notification on every event, and the input that makes that concrete is a
 * `date` setting -- `transformValue()` builds a new `Date` on every read, so
 * identity would report a change each time the file was touched and nothing in
 * it had moved.
 *
 * So: `Object.is` for a leaf, `getTime()` for a `Date`, and a structural walk
 * for a plain object or an array. `Object.is` rather than `===` makes a `NaN`
 * equal to itself, which an object layer can hold and which `===` would report
 * as moved on every reload; what it costs is that `0` and `-0` read as
 * different, which is a change somebody really did write into the file.
 *
 * A `Date` is matched with `Object.prototype.toString` rather than `instanceof`,
 * which is the call `overlay()` already makes for a boxed `String`: `instanceof`
 * is false across realms, and a `Date` from another realm is still a date.
 *
 * Everything else is compared by identity, which is right for what it reaches:
 * a `Map`, a class instance or a function is a leaf the merge carries by
 * reference, so an object layer re-applied with the same one is unchanged.
 *
 * No cycle guard, and that is structural rather than an omission: the merged
 * view is built by `copyValue()`, which refuses a cycle in the structure it
 * copies and carries every leaf by reference -- so a plain object or an array
 * reached by this walk cannot be cyclic.
 *
 * @param a - One value.
 * @param b - The other.
 * @returns Whether an app would see the same thing.
 */
export function sameValue(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) {
    return true;
  }

  const kind = Object.prototype.toString.call(a);
  if (kind === '[object Date]') {
    return (
      Object.prototype.toString.call(b) === '[object Date]' &&
      Object.is((a as Date).getTime(), (b as Date).getTime())
    );
  }

  if (Array.isArray(a)) {
    return Array.isArray(b) && a.length === b.length && a.every((it, i) => sameValue(it, b[i]));
  }

  if (isPlainObject(a) && isPlainObject(b)) {
    const keys = Object.keys(a);
    return (
      keys.length === Object.keys(b).length &&
      keys.every((key) => Object.hasOwn(b, key) && sameValue(a[key], b[key]))
    );
  }

  return false;
}

/**
 * Whether a key can be the last segment of a dotted path.
 *
 * A config file may hold `{"server.port": 8080}`, which is a key *named*
 * `server.port` rather than a nested one -- and `get('server.port')` does not
 * find it, which is this module's own documented state: "an empty or a dotted
 * key is allowed, because core allows both over a JSON layer, and each is
 * unreachable by a dotted path". So a change to one cannot be *reported* at a
 * dotted path either, because the path would name something else.
 *
 * An unsafe key cannot reach the merged view at all -- `copyValue()` refuses
 * one and the schema's own paths go through `segments()` -- so this does not
 * ask about those.
 *
 * @param key - The key.
 * @returns Whether `segments()` would give it back whole.
 */
function expressible(key: string): boolean {
  return key !== '' && !key.includes('.');
}

/**
 * Every dotted path whose merged value moved, with the old and the new.
 *
 * This is the half that makes watching worth having. "The file changed" is the
 * naive payload and it makes every consumer re-read and diff for itself; we
 * hold the previous merged view, so the change set is computable -- and because
 * the merge is layered, **a change in a lower-precedence layer that a higher
 * one shadows produces no change at all**, which is the one thing a per-file
 * watcher can never tell you and is exactly what an app wants to know.
 *
 * Walked to the finest granularity: two plain objects recurse, and anything
 * else is one change at the path it sits at. So replacing a whole subtree is
 * one change at the subtree, and editing one leaf inside it is one change at
 * the leaf. An array is a leaf, because `isPlainObject()` is false for one --
 * which is what an app watching `exclude` wants, since a list is a value rather
 * than a tree.
 *
 * ## A key no dotted path can name is reported at its parent
 *
 * Which is what makes **`get(change.path)` equal `change.value`** an invariant
 * rather than a hope. A change to a key holding a `.` reported at that key would
 * hand the app a path that reads as a nested one, so `get()` of it answers
 * `undefined` -- a wrong answer, handed over by the one field an app is most
 * likely to feed straight back. So where any inexpressible key of an object
 * differs, the whole object is one change at the object's own path, and the
 * walk stops there: coarser, unambiguous, and non-overlapping.
 *
 * @param before - The merged view as it was.
 * @param after - The merged view as it is.
 * @returns The changes, parents before children, in key order.
 */
export function diffMerged(before: unknown, after: unknown): ConfigChange[] {
  const out: ConfigChange[] = [];
  diffInto(before, after, '', out);
  return out;
}

/**
 * One level of `diffMerged()`.
 *
 * @param before - What was there.
 * @param after - What is there.
 * @param at - The dotted path of this level.
 * @param out - Where changes go.
 */
function diffInto(before: unknown, after: unknown, at: string, out: ConfigChange[]): void {
  if (isPlainObject(before) && isPlainObject(after)) {
    const keys = [...Object.keys(before), ...Object.keys(after).filter((k) => !(k in before))];

    // asked before anything is emitted, so that the "one change at the parent"
    // answer and the per-key answers are never both produced for one object
    if (keys.some((key) => !expressible(key) && !sameValue(before[key], after[key]))) {
      out.push({ path: at, previous: before, value: after });
      return;
    }

    for (const key of keys) {
      if (expressible(key)) {
        diffInto(before[key], after[key], at === '' ? key : `${at}.${key}`, out);
      }
    }
    return;
  }

  if (!sameValue(before, after)) {
    out.push({ path: at, previous: before, value: after });
  }
}

/**
 * The registration for `watch(path, handler)`.
 *
 * It reads **its own path** out of both merged views rather than taking a
 * change's value, which makes the rule exact: *a path handler fires when the
 * merged value at its path moved, and is handed that value and the one before
 * it.* The alternative is to match a change's path against the watched one by
 * prefix, which over-fires -- `{a: 1}` becoming `{a: {b: 2}}` is one change at
 * `a`, and a handler watching `a.c` is prefix-related to it while `a.c` is
 * `undefined` on both sides. One `readPath` on each side costs less than the
 * prefix arithmetic and is right.
 *
 * @param path - The watched path.
 * @param parts - Its segments, read once at registration.
 * @param handler - The app's handler.
 * @returns The registration.
 */
export function pathWatcher(
  path: string,
  parts: readonly string[],
  handler: (change: ConfigChange) => void
): Watcher {
  return (_changes, before, after) => {
    const previous = readPath(before, parts);
    const value = readPath(after, parts);
    if (!sameValue(previous, value)) {
      handler({ path, previous, value });
    }
  };
}

/**
 * The registration for `watch(handler)`.
 *
 * @param handler - The app's handler.
 * @returns The registration.
 */
export function allWatcher(handler: (changes: readonly ConfigChange[]) => void): Watcher {
  return (changes) => {
    handler(changes);
  };
}

/**
 * Tells everyone watching, over a copy and a membership check.
 *
 * The two rules every handler set in this repository keeps -- the router's
 * bindings, its paste handlers, `Terminal.onResize()` and `Renderer.onFrame()`
 * -- and they are two rather than one. Without the **copy**, a handler that
 * registers another sees its own event, and whether it does depends on where in
 * the iteration it joined. Without the **membership check**, a handler that
 * unregistered during the dispatch is called anyway, so a one-shot watcher
 * fires twice.
 *
 * A handler that throws is **reported and the rest still run**, which is
 * `onFrame`'s: this is an observer of a change, and a failing observer must not
 * stop the others being told about something that really happened.
 *
 * @param watchers - The registrations.
 * @param changes - What moved.
 * @param before - The merged view as it was.
 * @param after - The merged view as it is.
 * @param onError - Where a throw goes.
 */
export function dispatch(
  watchers: ReadonlySet<Watcher>,
  changes: readonly ConfigChange[],
  before: unknown,
  after: unknown,
  onError: (error: unknown) => void
): void {
  // the copy and the `has`, which are the two rules this is written for
  // eslint-disable-next-line unicorn/no-useless-spread
  for (const watcher of [...watchers]) {
    if (!watchers.has(watcher)) {
      continue;
    }
    try {
      watcher(changes, before, after);
    } catch (e: unknown) {
      onError(e);
    }
  }
}

/**
 * Where a failure goes when the app named nowhere.
 *
 * The `sigil:i18n` answer for a catalog loader that throws, one module along:
 * silent unless somebody asked. Which is the floor rather than a good default,
 * and `WatchOptions.onError` says why there is no good one.
 *
 * @param opts - What the app passed.
 * @returns The reporter.
 */
export function reporter(opts: WatchOptions): (error: unknown) => void {
  const { onError } = opts;
  if (typeof onError === 'function') {
    return (e: unknown) => {
      try {
        onError(e);
      } catch {
        // a reporter that throws has nowhere left to report to, and raising
        // from here would take down whatever was being told -- a reload, or
        // another handler's turn. The same call `beforeError` makes for a hook
        // that throws: logged and skipped
        logError(e);
      }
    };
  }
  return logError;
}

/**
 * How long to wait, as a number a timer can take.
 *
 * The rule every timer option in this library keeps: a value that is not a
 * finite number at or above zero is not an instruction, and a **finite** one
 * past 2^31-1 is clamped rather than thrown away, because node stores a delay
 * as a signed 32-bit integer and reads anything larger as `1` -- so asking for
 * twenty-four days would have fired in a millisecond.
 *
 * @param value - What the app passed.
 * @param fallback - The default.
 * @returns A delay.
 */
export function delay(value: number | undefined, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    return fallback;
  }
  return Math.min(value, 2 ** 31 - 1);
}

/**
 * The source the options ask for.
 *
 * @param opts - How to watch.
 * @returns The source.
 */
export function createSource(opts: WatchOptions): WatchSource {
  if (typeof opts.source === 'function') {
    return opts.source;
  }
  const interval = delay(opts.interval, DEFAULT_INTERVAL);
  return opts.poll === true ? pollSource(interval) : fsSource(interval);
}

/**
 * Polls each path with `fs.watchFile`.
 *
 * Dramatically simpler than the event source, and the reason is the finding
 * this module is built around: **each poll is a fresh `stat()` of the path**, so
 * polling is immune to everything the event source has to handle. Measured, all
 * four:
 *
 * - a missing file fires **once** and then goes quiet, so there is nothing to
 *   climb to and no spurious loop;
 * - it fires when the file appears, so there is no re-target;
 * - it survives a rename-over, and a second one, so there is no inode problem;
 * - `unwatchFile(path, listener)` removes one listener and leaves the others,
 *   so **Node already refcounts per path** and there is no map to keep.
 *
 * One caveat worth knowing: `fs.watchFile`'s options are taken from the *first*
 * call for a given path in the process, so two configs polling one file at two
 * intervals both get the first one's.
 *
 * @param interval - How often to stat.
 * @returns The source.
 */
function pollSource(interval: number): WatchSource {
  return (path, onEvent) => {
    const at = resolve(path);
    const listener = (): void => {
      onEvent();
    };

    // `persistent: false` rather than `unref()` after the fact, for the reason
    // the event source gives: there is no window in which it is ref'd
    watchFile(at, { interval, persistent: false }, listener);

    let live = true;
    return () => {
      if (live) {
        live = false;
        unwatchFile(at, listener);
      }
    };
  };
}

/**
 * Watches the directory each path sits in, with `fs.watch`.
 *
 * Three things it does that the obvious version does not, and each is a
 * measurement rather than a precaution.
 *
 * **It watches the directory**, for the inode reason in this module's own
 * header: a file watch is dead after the first atomic replace, measured.
 *
 * **It climbs to the deepest existing ancestor**, because `fs.watch` on a
 * missing path throws `ENOENT` -- measured -- and a config file the user has
 * not created yet is the ordinary case on a fresh install, where neither
 * `~/.config/app/config.json` nor `~/.config/app` is there. The climb is this
 * repository's own idiom: `mkdirOwnerSync()` walks up to "the deepest directory
 * that already exists" for the ownership pass, and this is the same walk for a
 * different reason. It always finds something, because the root does not
 * vanish.
 *
 * **It re-targets on every event**, which is correctness rather than tidiness
 * and is the measurement that decided the shape. Watching `a` because `a/b` is
 * missing: creating `a/b` fires on the `a` watcher, and then **writing
 * `a/b/config.json` fires nothing at all** -- `recursive` is off, so without
 * moving the watch down the file is never seen. The same rule covers the other
 * direction: removing `a/b` fires on both watchers, so the climb runs again and
 * the watch goes back up to `a`.
 *
 * One `fs.watch` per directory, keyed by the file's own directory, so two layers
 * in one directory share one file descriptor -- which is what "refcounted"
 * comes to when the thing holding the count is the listener set. Per **config**
 * rather than per process: a module-level registry would dedupe two configs over
 * one directory as well, and it is shared mutable state whose lifetime nothing
 * owns, for a shape nobody has.
 *
 * ## And an event can be dropped, which makes a stuck climb permanent
 *
 * Measured, and it is the one thing here that no amount of reading the
 * documentation would have said. A watcher that is **cold** -- created and then
 * written near immediately -- loses its event about 3% of the time under heavy
 * parallel filesystem load, and 0 of 30 times on an idle machine. A **warm**
 * one does not: 0 of 40 replacements under the same load produced no event.
 *
 * In the steady state that costs latency and recovers, because the next write
 * fires and the reload reads whatever the file holds by then. During the
 * **climb** it is permanent: watching `a` because `a/b` does not exist, the one
 * event that would ever move the watch down is the one that creates `a/b`, and
 * a watcher created microseconds earlier is exactly the cold one. Lose it and
 * every write to `a/b/config.json` is invisible for the life of the process --
 * which is the silent-death failure mode point 7 is about, arriving on a
 * filesystem that works.
 *
 * So **while the watch is not on the directory it wants, something keeps
 * asking**: an unref'd interval that re-targets and tells the listeners when it
 * moved. It is self-limiting -- it exists only in the degenerate state and is
 * cleared the moment the real directory is reached -- and it reuses `interval`
 * rather than inventing a number, because it is the same idea as `poll` applied
 * to a narrower question. It also makes `MAX_CLIMB` giving up recoverable
 * rather than final.
 *
 * What is **not** closed is the cold-start drop in the steady state: a write
 * that lands in the moment after `watch()` may wait for the next one. Named
 * rather than guarded, because the guard is a stat per second per layer forever,
 * which is `poll` -- and `poll` is the answer for anybody who cannot accept it.
 *
 * @param interval - How often to re-check while watching the wrong directory.
 * @returns The source.
 */
function fsSource(interval: number): WatchSource {
  /** One directory, with whoever is listening for files in it. */
  interface Dir {
    /** The directory actually being watched, which may be an ancestor. */
    at?: string;
    /** Whoever asked about a file in this directory. */
    listeners: Set<() => void>;
    /** Set while `at` is not the directory wanted, because an event can be lost. */
    probe?: ReturnType<typeof setInterval>;
    /** The watcher, where there is one. */
    watcher?: FSWatcher;
  }

  const dirs = new Map<string, Dir>();

  /** Closes a directory's watcher, if it has one. */
  const close = (dir: Dir): void => {
    const { watcher } = dir;
    dir.at = undefined;
    dir.watcher = undefined;
    if (watcher) {
      // an `error` listener is attached below, so a close that races a removal
      // reports there rather than throwing -- but `close()` itself can throw on
      // a watcher the platform has already torn down, and a teardown that
      // throws would strand every other directory in the loop
      try {
        watcher.close();
      } catch {
        // already gone, which is what we were asking for
      }
    }
  };

  /** The deepest ancestor of a directory that exists right now. */
  const deepest = (dir: string): string => {
    for (let at = dir; ;) {
      try {
        if (statSync(at).isDirectory()) {
          return at;
        }
      } catch {
        // not there, or not ours to stat: climb
      }

      // the walk ends at the root whether or not it found a directory, which is
      // `mkdirOwnerSync()`'s own guard: it relies on finding one in order to
      // stop and `dirname('/')` is `'/'`
      const parent = dirname(at);
      if (parent === at) {
        return at;
      }
      at = parent;
    }
  };

  /** Tells whoever is listening for a file in this directory. */
  const notify = (entry: Dir): void => {
    // a copy and a `has` here too, for the dispatch's own two reasons: one
    // layer's reload can stop another's watch
    // eslint-disable-next-line unicorn/no-useless-spread
    for (const listener of [...entry.listeners]) {
      if (entry.listeners.has(listener)) {
        listener();
      }
    }
  };

  /** Watches one directory, answering whether it took. */
  const open = (dir: string, entry: Dir, at: string): boolean => {
    try {
      const watcher = fsWatch(at, { persistent: false, recursive: false }, () => {
        // the event itself is never read: not `eventType`, not `filename`.
        // Re-target **first**, so that a file in a directory that just appeared
        // is watched before anybody is told it may have changed
        retarget(dir, entry);
        notify(entry);
      });

      // an `error` event with no listener is an uncaught exception, which is
      // the rule the terminal's `EPIPE` guard is written for one subsystem
      // along -- and this one really fires, because the directory being
      // watched is one somebody else may delete. On macOS a removal arrives
      // as an ordinary event instead, measured, which the re-target above
      // already handles; this is the platforms where it does not
      watcher.on('error', () => {
        close(entry);
        retarget(dir, entry);
      });

      entry.at = at;
      entry.watcher = watcher;
      return true;
    } catch {
      // the directory `deepest()` just found has gone, so the caller climbs
      // again -- each failure is one level nearer a root that does not vanish
      return false;
    }
  };

  /**
   * Keeps asking while the watch is not where it wants to be, and stops the
   * moment it is.
   *
   * The whole of the dropped-event answer, and it is this small because the
   * question it asks is the one `retarget()` already answers.
   */
  const settle = (dir: string, entry: Dir): void => {
    if (entry.at === dir) {
      if (entry.probe !== undefined) {
        clearInterval(entry.probe);
        entry.probe = undefined;
      }
      return;
    }

    if (entry.probe !== undefined) {
      return;
    }

    const probe = setInterval(() => {
      // told only where it moved, so a directory that never appears costs one
      // `statSync` per interval rather than a read of a missing file
      if (retarget(dir, entry)) {
        notify(entry);
      }
    }, interval);
    probe.unref?.();
    entry.probe = probe;
  };

  /**
   * Points a directory's watcher at the deepest ancestor that exists, which is
   * both halves of the re-target and the initial watch.
   *
   * @returns Whether the directory being watched moved.
   */
  const retarget = (dir: string, entry: Dir): boolean => {
    const was = entry.at;

    for (let tries = 0; tries < MAX_CLIMB; tries++) {
      const at = deepest(dir);
      if (entry.watcher && at === entry.at) {
        break;
      }

      close(entry);
      if (open(dir, entry, at)) {
        break;
      }
    }

    settle(dir, entry);
    return entry.at !== was;
  };

  return (path, onEvent) => {
    const dir = dirname(resolve(path));
    let entry = dirs.get(dir);

    if (!entry) {
      entry = { listeners: new Set() };
      dirs.set(dir, entry);
      retarget(dir, entry);
    }

    entry.listeners.add(onEvent);
    const held = entry;

    let live = true;
    return () => {
      if (!live) {
        return;
      }
      live = false;
      held.listeners.delete(onEvent);
      if (held.listeners.size === 0) {
        close(held);
        if (held.probe !== undefined) {
          clearInterval(held.probe);
          held.probe = undefined;
        }
        dirs.delete(dir);
      }
    };
  };
}
