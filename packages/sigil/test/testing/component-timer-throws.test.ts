import { stopwatch, timer } from '../../src/components/clock.js';
import { createDecrypt, decryptReveal, decryptState } from '../../src/components/decrypt.js';
import { showToast } from '../../src/components/toast.js';
import { box } from '../../src/element/index.js';
import { createRoot, render, timed } from '../../src/renderer/index.js';
import { createEffects } from '../../src/signals/index.js';
import { createTestTerminal } from '../../src/testing/index.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * A component's own timer that calls a function the app gave it, over a test
 * terminal (SIG-642).
 *
 * SIG-631 gave `onTimerError()` to the router's timers. These are the component
 * timers that run an app's callback -- the toast's `onClose`, the clock's `now`,
 * the decrypt's `now`, `random` and `onDone` -- which are armed through the same
 * `timed()` and find the hook by way of the terminal they were given. Each of them
 * was an uncaught exception in a test before.
 */

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('a toast whose onClose throws when its timeout ends', () => {
  it('should hand the throw to onTimerError, with the toast gone', () => {
    const ui = createTestTerminal();
    const errors: unknown[] = [];
    ui.onTimerError((error) => void errors.push(error));
    const root = box({});

    const handle = showToast(root, {
      message: 'Saved',
      onClose: () => {
        throw new Error('boom');
      },
      terminal: ui.terminal,
      timeout: 100,
    });
    vi.advanceTimersByTime(99);
    expect(errors).toEqual([]);
    vi.advanceTimersByTime(1);

    expect(errors).toEqual([new Error('boom')]);
    expect(handle.open).toBe(false);
  });

  it('should leave the throw uncaught where no test is listening, as it is in an app', () => {
    const ui = createTestTerminal();
    const root = box({});
    showToast(root, {
      message: 'Saved',
      onClose: () => {
        throw new Error('boom');
      },
      terminal: ui.terminal,
      timeout: 100,
    });

    expect(() => vi.advanceTimersByTime(100)).toThrow('boom');
  });

  it('should stop hearing once the handler is taken off', () => {
    const ui = createTestTerminal();
    const errors: unknown[] = [];
    const off = ui.onTimerError((error) => void errors.push(error));
    off();
    showToast(box({}), {
      message: 'Saved',
      onClose: () => {
        throw new Error('boom');
      },
      terminal: ui.terminal,
      timeout: 100,
    });

    expect(() => vi.advanceTimersByTime(100)).toThrow('boom');
    expect(errors).toEqual([]);
  });
});

describe('a clock whose now throws from its timers', () => {
  /** A `now` that answers until it is told to throw. */
  function clockSource() {
    let at = 0;
    const source = {
      broken: false,
      now: (): number => {
        if (source.broken) {
          throw new Error('boom');
        }
        return at;
      },
      set(ms: number): void {
        at = ms;
      },
    };
    return source;
  }

  it('should hand a throw from the redraw timer to onTimerError', () => {
    const ui = createTestTerminal();
    const errors: unknown[] = [];
    ui.onTimerError((error) => void errors.push(error));
    const source = clockSource();
    const watch = stopwatch({ now: source.now, terminal: ui.terminal }).start();

    source.broken = true;
    vi.advanceTimersByTime(1000);

    expect(errors).toEqual([new Error('boom')]);
    source.broken = false;
    watch.pause();
  });

  it('should hand a throw from the deadline timer to onTimerError', () => {
    const ui = createTestTerminal();
    const errors: unknown[] = [];
    ui.onTimerError((error) => void errors.push(error));
    const source = clockSource();
    // quiet, so the redraw is not armed and the deadline is the one timer
    const down = timer(500, { now: source.now, quiet: true, terminal: ui.terminal }).start();

    source.broken = true;
    vi.advanceTimersByTime(500);

    expect(errors).toEqual([new Error('boom')]);
    source.broken = false;
    down.cancel();
  });

  it('should leave the throw uncaught where no test is listening', () => {
    const ui = createTestTerminal();
    const source = clockSource();
    const down = timer(500, { now: source.now, quiet: true, terminal: ui.terminal }).start();

    source.broken = true;
    expect(() => vi.advanceTimersByTime(500)).toThrow('boom');
    source.broken = false;
    down.cancel();
  });
});

describe('a decrypt whose now throws from its timer', () => {
  it('should hand the throw to onTimerError', () => {
    const ui = createTestTerminal();
    const errors: unknown[] = [];
    ui.onTimerError((error) => void errors.push(error));
    let calls = 0;
    const it = createDecrypt({
      frameMs: 0,
      interval: 10,
      jumble: 100,
      now: () => {
        // the first two are the start and the first frame, which are the effect's
        if (++calls > 2) {
          throw new Error('boom');
        }
        return 0;
      },
      reveal: 400,
      terminal: ui.terminal,
      text: 'secret',
    }).start();

    vi.advanceTimersByTime(10);

    expect(errors).toEqual([new Error('boom')]);
    it.cancel();
  });

  it('should leave the throw uncaught where no test is listening', () => {
    const ui = createTestTerminal();
    let calls = 0;
    const it = createDecrypt({
      frameMs: 0,
      interval: 10,
      jumble: 100,
      now: () => {
        if (++calls > 2) {
          throw new Error('boom');
        }
        return 0;
      },
      reveal: 400,
      terminal: ui.terminal,
      text: 'secret',
    }).start();

    expect(() => vi.advanceTimersByTime(10)).toThrow('boom');
    it.cancel();
  });
});

describe('a decrypt whose random and onDone throw from its timer', () => {
  it('should hand a throw from random to onTimerError', () => {
    const ui = createTestTerminal();
    const errors: unknown[] = [];
    ui.onTimerError((error) => void errors.push(error));
    let broken = false;
    const it = createDecrypt({
      frameMs: 0,
      interval: 10,
      jumble: 100,
      random: () => {
        if (broken) {
          throw new Error('boom');
        }
        return 0.5;
      },
      reveal: 400,
      terminal: ui.terminal,
      text: 'secret',
    }).start();
    // the first frame is the effect's and was drawn with a working generator
    broken = true;

    vi.advanceTimersByTime(10);

    expect(errors).toEqual([new Error('boom')]);
    it.cancel();
  });

  it('should hand a throw from onDone, which decryptReveal() takes from an app, to onTimerError', () => {
    const ui = createTestTerminal();
    const errors: unknown[] = [];
    ui.onTimerError((error) => void errors.push(error));
    const scope = createEffects();
    scope.setScheduler((run) => run());
    const state = decryptState('ab');
    let clock = 0;
    const dispose = createRoot(
      (release) => {
        decryptReveal(state, {
          animate: () => true,
          interval: 10,
          jumble: 0,
          now: () => clock,
          onDone: () => {
            throw new Error('boom');
          },
          random: () => 0.5,
          reveal: 50,
          revealInterval: 10,
          terminal: ui.terminal,
        });
        return release;
      },
      scope.effect,
      (error) => {
        throw error;
      }
    );

    // the first frame hides everything, so the one that finishes is a timer's
    clock = 100;
    vi.advanceTimersByTime(10);

    expect(errors).toEqual([new Error('boom')]);
    dispose();
  });
});

describe('timed()', () => {
  it('should rethrow where there is no stream, which is the process terminal of an app', () => {
    expect(() =>
      timed(undefined, () => {
        throw new Error('boom');
      })()
    ).toThrow('boom');
  });

  it('should rethrow where the stream has no hook', () => {
    const ui = createTestTerminal();

    expect(() =>
      timed(ui.stdin, () => {
        throw new Error('boom');
      })()
    ).toThrow('boom');
  });

  it('should read the hook when the throw happens, so a handler added later is asked', () => {
    const ui = createTestTerminal();
    const run = timed(ui.stdin, () => {
      throw new Error('boom');
    });
    const errors: unknown[] = [];
    ui.onTimerError((error) => void errors.push(error));

    run();

    expect(errors).toEqual([new Error('boom')]);
  });
});

/**
 * A timer armed under a renderer finds the hook of the terminal the renderer was
 * given, so `showToast(app.view, ...)` and a `decryptReveal()` called inside the
 * tree need no `terminal` of their own (SIG-653).
 */
describe('a component timer armed under a renderer, with no terminal of its own', () => {
  it('should hear a toast raised on the renderer, as every example raises one', () => {
    const ui = createTestTerminal();
    const errors: unknown[] = [];
    ui.onTimerError((error) => void errors.push(error));
    const view = render(() => box({}), { terminal: ui.terminal });

    const handle = showToast(view, {
      message: 'Saved',
      onClose: () => {
        throw new Error('boom');
      },
      timeout: 100,
    });
    vi.advanceTimersByTime(100);

    expect(errors).toEqual([new Error('boom')]);
    expect(handle.open).toBe(false);
    view.dispose();
  });

  it('should hear a toast raised on the root element from inside the tree', () => {
    const ui = createTestTerminal();
    const errors: unknown[] = [];
    ui.onTimerError((error) => void errors.push(error));
    const root = box({});
    const view = render(
      () => {
        showToast(root, {
          message: 'Saved',
          onClose: () => {
            throw new Error('boom');
          },
          timeout: 100,
        });
        return root;
      },
      { terminal: ui.terminal }
    );
    vi.advanceTimersByTime(100);

    expect(errors).toEqual([new Error('boom')]);
    view.dispose();
  });

  it('should leave a toast raised on the renderer uncaught where nothing is listening', () => {
    const ui = createTestTerminal();
    const view = render(() => box({}), { terminal: ui.terminal });
    showToast(view, {
      message: 'Saved',
      onClose: () => {
        throw new Error('boom');
      },
      timeout: 100,
    });

    expect(() => vi.advanceTimersByTime(100)).toThrow('boom');
    view.dispose();
  });

  it('should hear a decryptReveal() called directly inside the tree', () => {
    const ui = createTestTerminal();
    const errors: unknown[] = [];
    ui.onTimerError((error) => void errors.push(error));
    const state = decryptState('ab');
    let clock = 0;
    const view = render(
      () => {
        decryptReveal(state, {
          animate: () => true,
          interval: 10,
          jumble: 0,
          now: () => clock,
          onDone: () => {
            throw new Error('boom');
          },
          random: () => 0.5,
          reveal: 50,
          revealInterval: 10,
        });
        return box({});
      },
      { terminal: ui.terminal }
    );

    clock = 100;
    vi.advanceTimersByTime(10);

    expect(errors).toEqual([new Error('boom')]);
    view.dispose();
  });
});

describe('timed(), given an owner', () => {
  it('should read the hook of the terminal the renderer under it was given', () => {
    const ui = createTestTerminal();
    const errors: unknown[] = [];
    ui.onTimerError((error) => void errors.push(error));
    const view = render(() => box({}), { terminal: ui.terminal });

    timed(view.owner, () => {
      throw new Error('boom');
    })();

    expect(errors).toEqual([new Error('boom')]);
    view.dispose();
  });
});
