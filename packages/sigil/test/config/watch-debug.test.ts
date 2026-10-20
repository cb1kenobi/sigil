/**
 * That the floor really logs, which is the one claim about `onError` nothing
 * else in this suite can make.
 *
 * `WatchOptions.onError` says there is no default that can be right --
 * `console.error` from a library corrupts a full-screen app's screen and
 * throwing from a timer callback is an uncaught exception -- so the floor is the
 * `sigil:config` debug log, which is **silent unless somebody asked**. Which
 * makes it exactly the kind of thing a test asserts by `not.toThrow()` and
 * thereby says nothing about: a review round found two tests named for the log
 * that would have passed with the logging deleted.
 *
 * So a file of its own. `DEBUG` is read once, at the debug module's own load,
 * from a `const` nothing can reach afterwards -- so the only way to observe the
 * log is to set the variable **before** the import, which `vi.hoisted` is for
 * and which is module-wide, exactly as `vi.mock` is in `watch-fs.test.ts`.
 */

import { createConfigSync, type WatchSource } from '../../src/config/index.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  // before any import, because `debug()` reads `process.env.DEBUG` at load
  process.env.DEBUG = 'sigil:config';
});

/** A source that fires on demand, as in `watch.test.ts`. */
function fakeSource(): WatchSource & { fire: () => void } {
  const listeners = new Set<() => void>();
  const source = ((_path: string, onEvent: () => void) => {
    listeners.add(onEvent);
    return () => void listeners.delete(onEvent);
  }) as WatchSource & { fire: () => void };
  source.fire = (): void => {
    for (const listener of listeners) {
      listener();
    }
  };
  return source;
}

/** A store whose next read the test decides, with a path so it is watchable. */
function stubStore(value: unknown) {
  let held = value;
  const read = () => ({ value: held });
  return {
    format: 'stub',
    read: () => Promise.resolve(read()),
    readSync: read,
    set: (next: unknown) => void (held = next),
    source: '/nowhere/config.json',
  };
}

let logged: string[];
let spy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.useFakeTimers();
  logged = [];
  // the debug stream holds `process.stderr` by reference and calls `.write()` on
  // it, so a spy installed now is seen by a logger built at module load
  spy = vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: unknown) => {
    logged.push(String(chunk));
    return true;
  }) as never);
});

afterEach(() => {
  spy.mockRestore();
  vi.useRealTimers();
});

describe('the floor, where the app named no onError', () => {
  it('should log a handler that threw', () => {
    const store = stubStore({ a: 1 });
    const source = fakeSource();
    const config = createConfigSync({ layers: [{ name: 'u', store }], watch: { source } });
    config.watch(() => {
      throw new Error('unreported');
    });

    store.set({ a: 2 });
    source.fire();
    vi.advanceTimersByTime(50);

    expect(logged.join('')).toContain('unreported');
    expect(logged.join('')).toContain('sigil:config');
  });

  it('should log a read that kept failing', () => {
    const source = fakeSource();
    // it has to read **once** without throwing, because `createConfigSync()`
    // reads every store at construction -- so the failure has to start after
    let broken = false;
    const config = createConfigSync({
      layers: [
        {
          name: 'u',
          store: {
            format: 'stub',
            read: () => Promise.resolve({ value: {} }),
            readSync: () => {
              if (broken) {
                throw new Error('broken json');
              }
              return { value: {} };
            },
            source: '/nowhere/config.json',
          },
        },
      ],
      watch: { source },
    });
    config.watch(() => {});
    broken = true;

    source.fire();
    // the first attempt, then the one retry
    vi.advanceTimersByTime(50);
    expect(logged.join('')).not.toContain('broken json');
    vi.advanceTimersByTime(50);

    expect(logged.join('')).toContain('broken json');
  });

  it('should log both the original and a reporter that threw', () => {
    // the original must not be lost, because losing it is what this path exists
    // to prevent; the reporter's own failure is a second thing worth knowing.
    // The first version logged the original alone, under a comment that read as
    // though it logged the reporter's. Found by review
    const store = stubStore({ a: 1 });
    const source = fakeSource();
    const config = createConfigSync({
      layers: [{ name: 'u', store }],
      watch: {
        onError: () => {
          throw new Error('the reporter itself');
        },
        source,
      },
    });
    config.watch(() => {
      throw new Error('the handler');
    });

    store.set({ a: 2 });
    source.fire();
    expect(() => vi.advanceTimersByTime(50)).not.toThrow();

    const all = logged.join('');
    expect(all).toContain('the handler');
    expect(all).toContain('the reporter itself');
  });
});
