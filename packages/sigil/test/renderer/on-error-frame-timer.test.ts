import { box, text } from '../../src/element/index.js';
import { createEffect, onMount, render, Show, trackedRaw } from '../../src/renderer/index.js';
import { createEffects, State } from '../../src/signals/index.js';
import { createTestTerminal } from '../../src/testing/index.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * A throwing `onError`, on a frame that fails where nothing is on the stack to
 * catch it (SIG-674).
 *
 * SIG-660 made a failure that arrives through an effect's flush fall back to the
 * default report when `onError` throws. A frame handler, a layout and an
 * `onMount` callback do not arrive through a flush: they throw out of `settle()`
 * into `runFrame()`'s catch, which is `fail()`, and what `onError` threw there was
 * raised out of the timer callback -- an uncaught exception, over a screen that
 * was already back, which `onTimerError()` does not hear either.
 */

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
});

afterEach(() => {
  vi.useRealTimers();
});

/** Stands in for stderr, and gives the exit code back. */
function quietStderr() {
  const written: string[] = [];
  const spy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
    written.push(String(chunk));
    return true;
  });
  const exitCode = process.exitCode;
  process.exitCode = undefined;
  return {
    restore() {
      spy.mockRestore();
      process.exitCode = exitCode;
    },
    text: () => written.join(''),
  };
}

/** An `onError` that logs what it was handed and then throws something of its own. */
function throwing(heard: unknown[]) {
  return (error: unknown): never => {
    heard.push(error);
    throw new Error('onError broke');
  };
}

/** A terminal that hears a timer's throw, which is `onTimerError()`'s. */
function listening() {
  const ui = createTestTerminal({ columns: 30, rows: 6 });
  const timerErrors: unknown[] = [];
  const off = ui.onTimerError((error) => void timerErrors.push(error));
  return { off, timerErrors, ui };
}

describe('a frame that fails on a frame timer, whose onError throws', () => {
  let off: (() => void) | undefined;
  afterEach(() => {
    off?.();
    off = undefined;
  });

  it('should fall back to the default report for a frame handler that threw (SIG-674)', () => {
    const heard: unknown[] = [];
    const t = listening();
    off = t.off;
    const n = new State(0);
    const view = render(
      () => {
        const label = text('');
        createEffect(() => void label.setText(`n=${n.get()}`));
        return label;
      },
      { onError: throwing(heard), terminal: t.ui.terminal }
    );
    view.onFrame(() => {
      throw new Error('observer broke');
    });
    const written = quietStderr();
    try {
      n.set(1);
      // the frame the write asked for runs from a timer, so a throw out of it
      // would be an uncaught exception on real ones
      expect(() => vi.advanceTimersByTime(1000)).not.toThrow();

      // what the frame handler threw is still said, and so is what onError threw
      expect(written.text()).toBe(
        'Error in frame: observer broke\nError in frame error handler: onError broke\n'
      );
      expect(process.exitCode).toBe(1);
    } finally {
      written.restore();
    }
    // and onError heard it first, with the screen given back
    expect(heard.map(String)).toEqual(['Error: observer broke']);
    expect(view.failed).toBe(true);
    // `onTimerError()` is the input router's timers' and never heard this one, so
    // what pins it is that the advance above did not throw
    expect(t.timerErrors).toEqual([]);
  });

  it('should fall back to the default report for a layout that threw (SIG-674)', () => {
    const heard: unknown[] = [];
    const t = listening();
    off = t.off;
    const broken = new State(false);
    const view = render(
      () =>
        box(
          {},
          trackedRaw({
            measure: () => {
              if (broken.get()) {
                throw new Error('layout broke');
              }
              return { height: 1, width: 4 };
            },
            paint: () => {},
          })
        ),
      { onError: throwing(heard), terminal: t.ui.terminal }
    );
    const written = quietStderr();
    try {
      broken.set(true);
      expect(() => vi.advanceTimersByTime(1000)).not.toThrow();

      expect(written.text()).toBe(
        'Error in frame: layout broke\nError in frame error handler: onError broke\n'
      );
      expect(process.exitCode).toBe(1);
    } finally {
      written.restore();
    }
    expect(heard.map(String)).toEqual(['Error: layout broke']);
    expect(view.failed).toBe(true);
    // `onTimerError()` is the input router's timers' and never heard this one, so
    // what pins it is that the advance above did not throw
    expect(t.timerErrors).toEqual([]);
  });

  it('should fall back to the default report for an onMount callback that threw (SIG-674)', () => {
    const heard: unknown[] = [];
    const t = listening();
    off = t.off;
    const shown = new State(false);
    const view = render(
      () =>
        box(
          {},
          Show({
            children: () => {
              onMount(() => {
                throw new Error('mount broke');
              });
              return text('late');
            },
            when: () => shown.get(),
          })
        ),
      { onError: throwing(heard), terminal: t.ui.terminal }
    );
    const written = quietStderr();
    try {
      shown.set(true);
      expect(() => vi.advanceTimersByTime(1000)).not.toThrow();

      expect(written.text()).toBe(
        'Error in frame: mount broke\nError in frame error handler: onError broke\n'
      );
      expect(process.exitCode).toBe(1);
    } finally {
      written.restore();
    }
    expect(heard.map(String)).toEqual(['Error: mount broke']);
    expect(view.failed).toBe(true);
    // `onTimerError()` is the input router's timers' and never heard this one, so
    // what pins it is that the advance above did not throw
    expect(t.timerErrors).toEqual([]);
  });

  it('should say a layout failure once when onError rethrows what it was given (SIG-674)', () => {
    const t = listening();
    off = t.off;
    const broken = new State(false);
    const view = render(
      () =>
        box(
          {},
          trackedRaw({
            measure: () => {
              if (broken.get()) {
                throw new Error('layout broke');
              }
              return { height: 1, width: 4 };
            },
            paint: () => {},
          })
        ),
      {
        onError: (error) => {
          throw error;
        },
        terminal: t.ui.terminal,
      }
    );
    const written = quietStderr();
    try {
      broken.set(true);
      expect(() => vi.advanceTimersByTime(1000)).not.toThrow();

      expect(written.text()).toBe('Error in frame: layout broke\n');
    } finally {
      written.restore();
    }
    expect(view.failed).toBe(true);
  });

  /**
   * A renderer whose `onError` takes what an effect threw and throws over the
   * next thing it is handed, so that `failed` is already set when the throw comes.
   *
   * An `onMount` callback is where that can happen: it runs inside the frame, so
   * `flush()` from it fails an effect through `fail()`, which gives the screen back
   * and reports -- and the callback then throws, or the next one does.
   */
  function failsTwice(ui: ReturnType<typeof createTestTerminal>) {
    const effects = createEffects();
    const heard: unknown[] = [];
    const n = new State(0);
    const shown = new State(false);
    const view = render(
      () =>
        box(
          {},
          Show({
            children: () => {
              createEffect(() => {
                if (n.get() > 0) {
                  throw new Error('effect broke');
                }
              });
              onMount(() => {
                n.set(1);
                effects.flush();
                throw new Error('callback broke');
              });
              return text('late');
            },
            when: () => shown.get(),
          })
        ),
      {
        effects,
        onError: (error) => {
          heard.push(error);
          if (String(error).includes('callback broke')) {
            throw new Error('onError broke');
          }
        },
        terminal: ui.terminal,
      }
    );
    return { heard, shown, view };
  }

  it('should fall back, on a frame timer, for a throw that comes after the renderer failed (SIG-674)', () => {
    const t = listening();
    off = t.off;
    const { heard, shown, view } = failsTwice(t.ui);
    const written = quietStderr();
    try {
      shown.set(true);
      expect(() => vi.advanceTimersByTime(1000)).not.toThrow();

      expect(view.failed).toBe(true);
      expect(heard.map(String)).toEqual(['Error: effect broke', 'Error: callback broke']);
      expect(written.text()).toBe(
        'Error in frame: callback broke\nError in frame error handler: onError broke\n'
      );
      expect(process.exitCode).toBe(1);
    } finally {
      written.restore();
    }
    // `onTimerError()` is the input router's timers' and never heard this one, so
    // what pins it is that the advance above did not throw
    expect(t.timerErrors).toEqual([]);
  });

  it('should raise it from frame(), which has a caller, for the same failure (SIG-674)', () => {
    const t = listening();
    off = t.off;
    const { shown, view } = failsTwice(t.ui);
    const written = quietStderr();
    try {
      shown.set(true);
      // the frame the write asked for is the timer's; this one is the caller's
      let raised: unknown;
      try {
        view.frame();
      } catch (error) {
        raised = error;
      }
      // what `onError` threw, as itself and not wrapped
      expect(raised).toEqual(new Error('onError broke'));
      expect(raised).not.toBeInstanceOf(AggregateError);
      expect(view.failed).toBe(true);
    } finally {
      written.restore();
    }
  });
});

/**
 * Several errors in one frame, and an `onError` that throws for the first (SIG-682).
 *
 * `drainMounts()` has already run every callback and handed back what each threw,
 * and `settle()` told them one at a time with the first throw ending the loop --
 * so the rest were gone. A frame handler's throw ended the dispatch the same way,
 * and the handlers after it never heard the frame at all.
 */
describe('several errors in one frame, whose onError throws for each', () => {
  let off: (() => void) | undefined;
  afterEach(() => {
    off?.();
    off = undefined;
  });

  /** A tree whose `Show` mounts `count` callbacks that each throw their own error. */
  function mounting(
    count: number,
    onError: (error: unknown) => void,
    ui: ReturnType<typeof createTestTerminal>
  ) {
    const shown = new State(false);
    const view = render(
      () =>
        box(
          {},
          Show({
            children: () => {
              for (let i = 1; i <= count; i++) {
                onMount(() => {
                  throw new Error(`mount ${i} broke`);
                });
              }
              return text('late');
            },
            when: () => shown.get(),
          })
        ),
      { onError, terminal: ui.terminal }
    );
    return { shown, view };
  }

  it('should report every onMount error from a frame timer, though onError throws for the first', () => {
    const heard: unknown[] = [];
    const t = listening();
    off = t.off;
    const { shown, view } = mounting(3, throwing(heard), t.ui);
    const written = quietStderr();
    try {
      shown.set(true);
      expect(() => vi.advanceTimersByTime(1000)).not.toThrow();

      expect(written.text()).toBe(
        [
          'Error in frame: mount 1 broke',
          'Error in frame error handler: onError broke',
          'Error in frame: mount 2 broke',
          'Error in frame error handler: onError broke',
          'Error in frame: mount 3 broke',
          'Error in frame error handler: onError broke',
          '',
        ].join('\n')
      );
      expect(process.exitCode).toBe(1);
    } finally {
      written.restore();
    }
    // each one was handed to onError once, in the order it was thrown
    expect(heard.map(String)).toEqual([
      'Error: mount 1 broke',
      'Error: mount 2 broke',
      'Error: mount 3 broke',
    ]);
    expect(view.failed).toBe(true);
    expect(t.timerErrors).toEqual([]);
  });

  it('should tell every frame handler of the frame and report each error, though onError throws', () => {
    const heard: unknown[] = [];
    const t = listening();
    off = t.off;
    const n = new State(0);
    const view = render(
      () => {
        const label = text('');
        createEffect(() => void label.setText(`n=${n.get()}`));
        return label;
      },
      { onError: throwing(heard), terminal: t.ui.terminal }
    );
    const told: string[] = [];
    view.onFrame(() => {
      told.push('one');
      throw new Error('observer 1 broke');
    });
    view.onFrame(() => {
      told.push('two');
      throw new Error('observer 2 broke');
    });
    const written = quietStderr();
    try {
      n.set(1);
      expect(() => vi.advanceTimersByTime(1000)).not.toThrow();

      expect(written.text()).toBe(
        [
          'Error in frame: observer 1 broke',
          'Error in frame error handler: onError broke',
          'Error in frame: observer 2 broke',
          'Error in frame error handler: onError broke',
          '',
        ].join('\n')
      );
    } finally {
      written.restore();
    }
    expect(told).toEqual(['one', 'two']);
    expect(heard.map(String)).toEqual(['Error: observer 1 broke', 'Error: observer 2 broke']);
    expect(view.failed).toBe(true);
    expect(t.timerErrors).toEqual([]);
  });

  it('should hear every onMount error from frame(), and raise everything onError threw', () => {
    const heard: unknown[] = [];
    const t = listening();
    off = t.off;
    const { shown, view } = mounting(2, throwing(heard), t.ui);
    const written = quietStderr();
    try {
      shown.set(true);
      let raised: unknown;
      try {
        view.frame();
      } catch (error) {
        raised = error;
      }
      expect(heard.map(String).slice(0, 2)).toEqual([
        'Error: mount 1 broke',
        'Error: mount 2 broke',
      ]);
      // one throw for each of the two, and none dropped
      expect(raised).toBeInstanceOf(AggregateError);
      expect((raised as AggregateError).errors).toHaveLength(2);
      expect((raised as AggregateError).message).toBe('Errors thrown by onError');
      expect(view.failed).toBe(true);
    } finally {
      written.restore();
    }
  });

  it('should raise a single onError throw as itself from frame(), as before', () => {
    const heard: unknown[] = [];
    const t = listening();
    off = t.off;
    const { shown, view } = mounting(1, throwing(heard), t.ui);
    const written = quietStderr();
    try {
      shown.set(true);
      let raised: unknown;
      try {
        view.frame();
      } catch (error) {
        raised = error;
      }
      expect(raised).toEqual(new Error('onError broke'));
      expect(raised).not.toBeInstanceOf(AggregateError);
    } finally {
      written.restore();
    }
  });

  it('should raise what onError threw for each frame handler from frame(), and tell them all', () => {
    const heard: unknown[] = [];
    const t = listening();
    off = t.off;
    const view = render(() => text('x'), { onError: throwing(heard), terminal: t.ui.terminal });
    const told: string[] = [];
    for (const name of ['one', 'two']) {
      view.onFrame(() => {
        told.push(name);
        throw new Error(`observer ${name} broke`);
      });
    }
    const written = quietStderr();
    try {
      let raised: unknown;
      try {
        view.frame();
      } catch (error) {
        raised = error;
      }
      expect(told).toEqual(['one', 'two']);
      expect(heard.map(String).slice(0, 2)).toEqual([
        'Error: observer one broke',
        'Error: observer two broke',
      ]);
      expect(raised).toBeInstanceOf(AggregateError);
      expect((raised as AggregateError).errors.map(String)).toEqual([
        'Error: onError broke',
        'Error: onError broke',
      ]);
    } finally {
      written.restore();
    }
  });

  it('should write one pair when onError throws for the first error only', () => {
    const heard: unknown[] = [];
    const t = listening();
    off = t.off;
    const { shown, view } = mounting(
      2,
      (error) => {
        heard.push(error);
        if (String(error).includes('mount 1')) {
          throw new Error('onError broke');
        }
      },
      t.ui
    );
    const written = quietStderr();
    try {
      shown.set(true);
      expect(() => vi.advanceTimersByTime(1000)).not.toThrow();
      expect(written.text()).toBe(
        'Error in frame: mount 1 broke\nError in frame error handler: onError broke\n'
      );
    } finally {
      written.restore();
    }
    expect(heard.map(String)).toEqual(['Error: mount 1 broke', 'Error: mount 2 broke']);
    expect(view.failed).toBe(true);
  });

  it('should write each pair for a throw that comes after the renderer failed', () => {
    const heard: unknown[] = [];
    const t = listening();
    off = t.off;
    const effects = createEffects();
    const n = new State(0);
    const shown = new State(false);
    render(
      () =>
        box(
          {},
          Show({
            children: () => {
              createEffect(() => {
                if (n.get() > 0) {
                  throw new Error('effect broke');
                }
              });
              onMount(() => {
                throw new Error('callback 1 broke');
              });
              onMount(() => {
                n.set(1);
                effects.flush();
                throw new Error('callback 2 broke');
              });
              return text('late');
            },
            when: () => shown.get(),
          })
        ),
      {
        effects,
        onError: (error) => {
          heard.push(error);
          if (String(error).includes('callback')) {
            throw new Error('onError broke');
          }
        },
        terminal: t.ui.terminal,
      }
    );
    const written = quietStderr();
    try {
      shown.set(true);
      expect(() => vi.advanceTimersByTime(1000)).not.toThrow();
      expect(written.text()).toBe(
        [
          'Error in frame: callback 1 broke',
          'Error in frame error handler: onError broke',
          'Error in frame: callback 2 broke',
          'Error in frame error handler: onError broke',
          '',
        ].join('\n')
      );
    } finally {
      written.restore();
    }
    expect(heard.map(String)).toEqual([
      'Error: effect broke',
      'Error: callback 1 broke',
      'Error: callback 2 broke',
    ]);
  });
});
