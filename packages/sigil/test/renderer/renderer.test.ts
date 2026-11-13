import { createCanvas } from '../../src/canvas/index.js';
import { ScrollBox } from '../../src/components/scroll-box.js';
import { box, Element, scrollRange, text } from '../../src/element/index.js';
import { parseCapabilityResponse } from '../../src/input/capabilities.js';
import { createInput } from '../../src/input/index.js';
import {
  createBranch,
  createContext,
  createEffect,
  createRoot,
  For,
  getOwner,
  onCleanup,
  onMount,
  provideContext,
  render,
  runWithOwner,
  Show,
  useContext,
} from '../../src/renderer/index.js';
import { createEffects, effect, flush, sinkCount } from '../../src/signals/index.js';
import { State } from '../../src/signals/index.js';
import { Cascade, parseStylesheet } from '../../src/style/index.js';
import { createTerminal, type Terminal } from '../../src/terminal/index.js';
import { Screen, screenStream } from '../../src/testing/screen.js';
import { seeded } from '../../src/util/random.js';
import { setup } from '../components/helpers.js';
import { runsOf } from '../runs-of.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The renderer.
 *
 * Driven by `frame()` rather than by the clock: the pacing is a `setTimeout` and
 * a test that waits for one is a test that is slow and flaky in equal measure.
 * What the pacing itself promises is asserted separately, by counting frames.
 */

/** A backend over a canvas, with no terminal and a count of what it painted. */
function harness(width = 20, height = 4) {
  const canvas = createCanvas({ height, width });
  const out: string[] = [];
  let painted = 0;
  let presented = 0;

  const resizeListeners = new Set<(size: { height: number; width: number }) => void>();
  const terminal = {
    height: 24,
    onResize(fn: (size: { height: number; width: number }) => void) {
      resizeListeners.add(fn);
      return () => resizeListeners.delete(fn);
    },
    restore() {},
    width,
  } as unknown as Terminal;

  const backend = {
    active: true,
    canvas,
    done() {},
    get height() {
      return canvas.height;
    },
    isLive: true,
    present() {
      presented++;
    },
    render(draw: (painter: never) => void) {
      painted++;
      canvas.paint(draw as never);
    },
    resize(w: number, h: number) {
      canvas.resize(w, h);
    },
    stop() {},
    terminal,
    get width() {
      return canvas.width;
    },
    write(line: string) {
      out.push(line);
    },
  };

  return {
    backend: backend as never,
    get painted() {
      return painted;
    },
    picture() {
      return canvas
        .toString()
        .split('\n')
        .map((row) => row.padEnd(canvas.width, ' ').replaceAll(' ', '.'))
        .join('\n');
    },
    get presented() {
      return presented;
    },
    resize(w: number, h: number) {
      (terminal as { width: number }).width = w;
      (terminal as { height: number }).height = h;
      // the canvas follows, which is what every real backend does: an inline
      // canvas with no width of its own erases and resizes itself on a resize,
      // and a full-screen one is the alternate buffer. Without it the terminal
      // grows while the canvas stays the size it was, so nothing inside it is
      // ever given a different box -- which is the one thing a test about a
      // resize needs to be true
      canvas.resize(w, h);
      for (const fn of resizeListeners) {
        fn({ height: h, width: w });
      }
    },
    terminal,
  };
}

/** The first element in a tree that answers, which is how a component is found. */
function findIn(at: Element, want: (e: Element) => boolean): Element | undefined {
  if (want(at)) {
    return at;
  }
  for (const child of at.children) {
    const found = findIn(child, want);
    if (found) {
      return found;
    }
  }
  return undefined;
}

/**
 * A terminal whose stdin is a TTY nothing is typing on.
 *
 * `createInput()` refuses to exist where stdin is not a terminal, which is the
 * rule a router with nobody to read from is written down for -- so a test about
 * the focus ring needs one of these rather than the `harness()` above, whose
 * terminal has no streams at all.
 */
function keyboard() {
  const stdin = {
    isTTY: true,
    off() {
      return this;
    },
    on() {
      return this;
    },
    pause() {
      return this;
    },
    resume() {
      return this;
    },
    setEncoding() {
      return this;
    },
    setRawMode() {
      return this;
    },
  };

  return {
    terminal: createTerminal({
      env: {},
      isTTY: true,
      proc: { on() {}, pid: 1, removeListener() {} } as never,
      stderr: { isTTY: true, write() {} } as never,
      stdin: stdin as never,
      stdout: { isTTY: true, write() {} } as never,
    }),
  };
}

/** Each test gets its own effect scope, so one never inherits another's. */
let effects = createEffects();
beforeEach(() => {
  effects = createEffects();
});

describe('mounting', () => {
  it('should run a component body exactly once, however much it re-renders', () => {
    // the whole reason signals came first: there is no re-render, so the body is
    // not a function of state that runs again -- the effects inside it are
    const h = harness();
    const count = new State(0);
    let bodies = 0;
    let runs = 0;

    const view = render(
      () => {
        bodies++;
        const label = text('');
        createEffect(() => {
          runs++;
          label.setText(`n=${count.get()}`);
        });
        return box({}, label);
      },
      { backend: h.backend, effects, terminal: h.terminal }
    );

    expect(bodies).toBe(1);
    expect(runs).toBe(1);

    count.set(1);
    view.frame();
    count.set(2);
    view.frame();

    expect(bodies).toBe(1);
    expect(runs).toBe(3);
    expect(h.picture().split('\n')[0]).toBe('n=2.................');
    view.dispose();
  });

  it('should have painted before it returns', () => {
    // a `render()` that comes back with a timer pending and nothing on screen is
    // one every caller has to follow with a wait it cannot name
    const h = harness();
    const view = render(() => box({}, text('hi')), {
      backend: h.backend,
      effects,
      terminal: h.terminal,
    });

    expect(h.painted).toBe(1);
    expect(h.picture().split('\n')[0]).toBe('hi..................');
    view.dispose();
  });

  it('should paint nothing for a frame with nothing to do', () => {
    // nothing dirty means no frame, and the half of that this can see is that a
    // frame which happens anyway does no work
    const h = harness();
    const view = render(() => box({}, text('hi')), {
      backend: h.backend,
      effects,
      terminal: h.terminal,
    });

    expect(h.painted).toBe(1);
    view.frame();
    view.frame();
    expect(h.painted).toBe(1);
    view.dispose();
  });

  it('should coalesce a burst of writes into one frame', () => {
    // which is what the pacing is for: a terminal over ssh cannot absorb a
    // repaint per signal write, and thirty of them here are one frame
    const h = harness();
    const count = new State(0);

    const view = render(
      () => {
        const label = text('');
        createEffect(() => {
          label.setText(`n=${count.get()}`);
        });
        return box({}, label);
      },
      { backend: h.backend, effects, terminal: h.terminal }
    );

    for (let i = 1; i <= 30; i++) {
      count.set(i);
    }
    view.frame();

    expect(h.painted).toBe(2);
    expect(h.picture().split('\n')[0]).toBe('n=30................');
    view.dispose();
  });

  it('should repaint for a mutation no signal made', () => {
    // the tree records it, and what the tree records asks for a frame -- without
    // which an imperative edit from a key handler is invisible until something
    // else happens to draw
    const h = harness();
    let label: Element | undefined;
    const view = render(
      () => {
        label = text('one');
        return box({}, label);
      },
      { backend: h.backend, effects, terminal: h.terminal }
    );

    label?.setText('two');
    view.frame();
    expect(h.picture().split('\n')[0]).toBe('two.................');
    view.dispose();
  });
});

describe('the cascade', () => {
  it('should re-resolve what a state change made match', () => {
    // the join that did not exist: a restyler kept across frames re-resolves
    // only what it was told about, so without the bridge the sheet matched once
    // and the frame was never asked again
    const h = harness();
    const focused = new State(false);
    const sheet = parseStylesheet(`
      .field { color: gray }
      .field:focus { color: cyan }
    `);

    let field: Element | undefined;
    const view = render(
      () => {
        field = box({ class: 'field' }, text('x'));
        createEffect(() => {
          field?.setState('focus', focused.get());
        });
        return box({}, field);
      },
      {
        backend: h.backend,
        cascade: new Cascade([sheet]),
        colorLevel: 3,
        effects,
        terminal: h.terminal,
      }
    );

    expect(field?.style.color).toBe(8);
    focused.set(true);
    view.frame();
    expect(field?.style.color).toBe(6);
    view.dispose();
  });

  it('should re-match everything when the terminal resized', () => {
    // a rule inside a width media query may now apply or may now not, and which
    // elements those are is exactly what a full re-match answers
    const h = harness(20, 4);
    const sheet = parseStylesheet(`
      box { color: gray }
      @media (min-width: 30) { box { color: cyan } }
    `);

    let root: Element | undefined;
    const view = render(
      () => {
        root = box({}, text('x'));
        return root;
      },
      {
        backend: h.backend,
        cascade: new Cascade([sheet]),
        colorLevel: 3,
        effects,
        terminal: h.terminal,
      }
    );

    expect(root?.style.color).toBe(8);
    h.resize(40, 24);
    view.frame();
    expect(root?.style.color).toBe(6);
    view.dispose();
  });
});

describe('lifecycle', () => {
  it('should dispose every effect a component created', () => {
    // a long-running CLI that skips this leaks a watcher per mount, and nothing
    // above can see them to clean up
    const h = harness();
    const count = new State(0);
    let runs = 0;

    const view = render(
      () => {
        const label = text('');
        createEffect(() => {
          runs++;
          label.setText(String(count.get()));
        });
        return box({}, label);
      },
      { backend: h.backend, effects, terminal: h.terminal }
    );

    expect(runs).toBe(1);
    view.dispose();

    count.set(1);
    effects.flush();
    expect(runs).toBe(1);
  });

  it('should run cleanups innermost first and in reverse', () => {
    // the order things were built in, undone: a child's cleanup may read what
    // the parent's is about to tear down
    const order: string[] = [];
    createRoot((dispose) => {
      onCleanup(() => order.push('outer-a'));
      onCleanup(() => order.push('outer-b'));
      createEffect(() => {
        onCleanup(() => order.push('inner'));
      });
      dispose();
    }, effects.effect);

    expect(order).toEqual(['inner', 'outer-b', 'outer-a']);
  });

  it('should run every cleanup even when one throws', () => {
    // what is left behind by a teardown that stopped half way is a subscription
    // nobody can reach to cancel
    const ran: string[] = [];
    expect(() =>
      createRoot((dispose) => {
        onCleanup(() => ran.push('first'));
        onCleanup(() => {
          throw new Error('nope');
        });
        onCleanup(() => ran.push('last'));
        dispose();
      }, effects.effect)
    ).toThrow('nope');

    expect(ran).toEqual(['last', 'first']);
  });

  it('should run onMount once the element has a box', () => {
    // after a frame rather than at the end of the body, because the useful thing
    // to do here is read where the component landed, and during the body there
    // is no answer
    const h = harness();
    const seen: (number | undefined)[] = [];

    const view = render(
      () => {
        const root = box({ height: '2', width: '5' }, text('x'));
        onMount(() => seen.push(root.box?.width));
        return root;
      },
      { backend: h.backend, effects, terminal: h.terminal }
    );

    expect(seen).toEqual([5]);
    view.frame();
    expect(seen).toEqual([5]);
    view.dispose();
  });

  it('should run onMount under the owner of the component it belongs to', () => {
    // queued bare, the callback ran with no owner at all: an effect created
    // there outlived the unmount and the renderer's `dispose()`, an
    // `onCleanup()` was dropped, and a context read its default
    const h = harness();
    const on = new State(true);
    const sig = new State(0);
    const Ctx = createContext('default');
    const seen: { context?: string; owned?: boolean } = {};
    let runs = 0;
    let cleaned = 0;

    const view = render(
      () =>
        provideContext(Ctx, 'provided', () =>
          Show({
            children: () => {
              onMount(() => {
                seen.owned = getOwner() !== undefined;
                seen.context = useContext(Ctx);
                createEffect(() => {
                  sig.get();
                  runs++;
                });
                onCleanup(() => cleaned++);
              });
              return text('x');
            },
            when: () => on.get(),
          })
        ),
      { backend: h.backend, effects, terminal: h.terminal }
    );
    view.frame();
    expect(seen).toEqual({ context: 'provided', owned: true });
    expect(runs).toBe(1);

    // the branch goes, and what its mount callback made goes with it
    on.set(false);
    view.frame();
    expect(cleaned).toBe(1);
    sig.set(1);
    view.frame();
    expect(runs).toBe(1);
    expect(sinkCount(sig)).toBe(0);
    view.dispose();
  });

  it('should take an onMount effect down with the renderer', () => {
    const h = harness();
    const sig = new State(0);
    let runs = 0;
    const view = render(
      () => {
        onMount(() => {
          createEffect(() => {
            sig.get();
            runs++;
          });
        });
        return text('x');
      },
      { backend: h.backend, effects, terminal: h.terminal }
    );
    view.frame();
    expect(runs).toBe(1);

    view.dispose();
    expect(sinkCount(sig)).toBe(0);
  });

  it('should skip the onMount of a component unmounted before its frame', () => {
    // a `Show` that opened and closed again before anything was drawn built a
    // branch that was never on screen, and its owner is gone: there is no box
    // to read, and everything the callback tried would be refused
    const h = harness();
    const on = new State(false);
    const mounted: string[] = [];
    const view = render(
      () =>
        Show({
          children: () => {
            onMount(() => mounted.push('mounted'));
            return text('x');
          },
          when: () => on.get(),
        }),
      { backend: h.backend, effects, terminal: h.terminal }
    );
    view.frame();

    // built by the flush and torn down by the next one, both before a frame
    on.set(true);
    effects.flush();
    on.set(false);
    effects.flush();
    view.frame();
    expect(mounted).toEqual([]);
    view.dispose();
  });

  it('should let a detached callback borrow an owner', () => {
    // a key handler or a settling promise has no owner of its own, and creating
    // an effect from one would otherwise never be disposed
    const h = harness();
    const count = new State(0);
    let runs = 0;
    let owner: ReturnType<typeof getOwner>;

    const view = render(
      () => {
        owner = getOwner();
        return box({}, text('x'));
      },
      { backend: h.backend, effects, terminal: h.terminal }
    );

    runWithOwner(owner, () => {
      createEffect(() => {
        runs++;
        count.get();
      });
    });
    expect(runs).toBe(1);

    view.dispose();
    count.set(1);
    effects.flush();
    expect(runs).toBe(1);
  });
});

describe('context', () => {
  it('should read the nearest provided value', () => {
    const theme = createContext('plain');
    let inner = '';
    let outer = '';

    createRoot((dispose) => {
      outer = useContext(theme);
      provideContext(theme, 'dark', () => {
        inner = useContext(theme);
      });
      dispose();
    }, effects.effect);

    expect(outer).toBe('plain');
    expect(inner).toBe('dark');
  });

  it('should be readable from inside an effect body', () => {
    // the body runs with the creating owner current, so `useContext()` means
    // inside it what it meant outside
    const theme = createContext('plain');
    let seen = '';

    createRoot((dispose) => {
      provideContext(theme, 'dark', () => {
        createEffect(() => {
          seen = useContext(theme);
        });
      });
      dispose();
    }, effects.effect);

    expect(seen).toBe('dark');
  });
});

describe('provideContext() inside an effect body', () => {
  it('should dispose the scope a run opened when the body runs again', () => {
    // the scope was a child of the component and `runWithOwner()` detached what
    // was built in it from the run, so after five writes to `mode` there were
    // six live inner effects -- six runs and six sinks for one write to `tick`
    // -- and not one of the five stale scopes' cleanups had run. A plain nested
    // `createEffect()` gives 1, 1 and 5, and so does this now
    const theme = createContext('plain');
    const mode = new State('a');
    const tick = new State(0);
    let runs = 0;
    let cleanups = 0;

    createRoot(() => {
      createEffect(() => {
        provideContext(theme, mode.get(), () => {
          createEffect(() => {
            tick.get();
            runs++;
          });
          onCleanup(() => cleanups++);
        });
      });
    }, effects.effect);

    for (let i = 0; i < 5; i++) {
      mode.set(`m${i}`);
      effects.flush();
    }
    runs = 0;
    tick.set(1);
    effects.flush();

    expect(runs).toBe(1);
    expect(sinkCount(tick)).toBe(1);
    expect(cleanups).toBe(5);
  });

  it('should undo the scope in the order the run built it', () => {
    const order: string[] = [];
    const theme = createContext('plain');
    const mode = new State(0);

    createRoot(() => {
      createEffect(() => {
        mode.get();
        onCleanup(() => order.push('before'));
        provideContext(theme, 'dark', () => {
          onCleanup(() => order.push('inside'));
        });
        onCleanup(() => order.push('after'));
      });
    }, effects.effect);

    mode.set(1);
    effects.flush();

    expect(order).toEqual(['after', 'inside', 'before']);
  });

  it('should report what a cleanup in the scope threw, as the run reports its own', () => {
    const thrown: unknown[] = [];
    effects.setErrorHandler((error) => void thrown.push(error));
    const theme = createContext('plain');
    const mode = new State(0);
    let before = 0;

    createRoot(() => {
      createEffect(() => {
        mode.get();
        onCleanup(() => before++);
        provideContext(theme, 'dark', () => {
          onCleanup(() => {
            throw new Error('unsubscribe failed');
          });
        });
      });
    }, effects.effect);

    mode.set(1);
    effects.flush();

    expect(thrown.map((e) => (e as Error).message)).toEqual(['unsubscribe failed']);
    expect(before).toBe(1);
  });

  it('should dispose the scope a run opened when the run then throws', () => {
    // a run that failed handed the signals layer no cleanup, so the scope's
    // disposer went out of scope with the run's list: three odd writes left
    // three scopes live, four runs and four sinks for one write to `tick`,
    // where a plain nested `createEffect()` gives one and one
    const errors: unknown[] = [];
    effects.setErrorHandler((error) => void errors.push(error));
    const theme = createContext(0);
    const mode = new State(0);
    const tick = new State(0);
    let runs = 0;
    let cleanups = 0;

    createRoot(() => {
      createEffect(() => {
        const m = mode.get();
        provideContext(theme, m, () => {
          createEffect(() => {
            tick.get();
            runs++;
          });
          onCleanup(() => cleanups++);
        });
        if (m % 2) {
          throw new Error('odd');
        }
      });
    }, effects.effect);

    for (let i = 1; i <= 6; i++) {
      mode.set(i);
      effects.flush();
    }
    runs = 0;
    tick.set(1);
    effects.flush();

    expect(runs).toBe(1);
    expect(sinkCount(tick)).toBe(1);
    expect(cleanups).toBe(6);
    expect(errors.map((e) => (e as Error).message)).toEqual(['odd', 'odd', 'odd']);
  });

  it('should dispose the scope with the run when what it built threw and the body caught it', () => {
    // why the disposer is registered before `fn` runs rather than after: the
    // throw would skip a registration that came after it, and the body that
    // caught the throw goes on to finish the run normally
    const theme = createContext(0);
    const mode = new State(0);
    const tick = new State(0);
    let runs = 0;
    let cleanups = 0;

    createRoot(() => {
      createEffect(() => {
        try {
          provideContext(theme, mode.get(), () => {
            createEffect(() => {
              tick.get();
              runs++;
            });
            onCleanup(() => cleanups++);
            throw new Error('caught');
          });
        } catch {
          // the body recovers, which is the case
        }
      });
    }, effects.effect);

    for (let i = 1; i <= 5; i++) {
      mode.set(i);
      effects.flush();
    }
    runs = 0;
    tick.set(1);
    effects.flush();

    expect(runs).toBe(1);
    expect(sinkCount(tick)).toBe(1);
    expect(cleanups).toBe(5);
  });

  it('should leave a scope opened in a component body to the component', () => {
    // the other half of the rule: outside a run there is no run to belong to,
    // and the scope lives until the component goes
    const theme = createContext('plain');
    const tick = new State(0);
    let runs = 0;
    let dispose = (): void => {};

    createRoot((d) => {
      dispose = d;
      provideContext(theme, 'dark', () => {
        createEffect(() => {
          tick.get();
          runs++;
        });
      });
    }, effects.effect);

    tick.set(1);
    effects.flush();
    expect(runs).toBe(2);

    dispose();
    expect(sinkCount(tick)).toBe(0);
  });
});

describe('an owned effect stopped by hand', () => {
  /**
   * How many cleanups an owner holds, which is where a stopped effect stayed.
   *
   * @param owner - The owner.
   * @returns The length of its cleanup list.
   */
  function held(owner: ReturnType<typeof getOwner>): number {
    return (owner as unknown as { cleanups: unknown[] }).cleanups.length;
  }

  it('should no longer be held by its owner', () => {
    // the disposer was pushed onto the owner's cleanups and never taken back
    // out, so a long-lived owner -- the app root, borrowed by a handler through
    // `runWithOwner()` -- kept every effect it had ever started, closure and
    // all: +218 MB of heap over 200,000 cycles, given back only when the root
    // went
    const count = new State(0);
    let owner: ReturnType<typeof getOwner>;
    createRoot(() => {
      owner = getOwner();
      onCleanup(() => {});
    }, effects.effect);
    const before = held(owner);

    for (let i = 0; i < 100; i++) {
      runWithOwner(owner, () => createEffect(() => void count.get()))();
    }

    expect(before).toBe(1);
    expect(held(owner)).toBe(before);
    expect(sinkCount(count)).toBe(0);
  });

  it('should leave the rest of the teardown in the order it was built', () => {
    const order: string[] = [];
    let stopFirst = (): void => {};
    let dispose = (): void => {};

    createRoot((d) => {
      dispose = d;
      onCleanup(() => order.push('a'));
      stopFirst = createEffect(() => () => order.push('first'));
      onCleanup(() => order.push('b'));
      createEffect(() => () => order.push('second'));
      onCleanup(() => order.push('c'));
    }, effects.effect);

    stopFirst();
    expect(order).toEqual(['first']);

    dispose();
    expect(order).toEqual(['first', 'c', 'second', 'b', 'a']);
  });

  it('should run every cleanup once when one stops a sibling during the teardown', () => {
    // the teardown walks the list by index, so an effect stopped from inside it
    // must not take itself out and move the entries under the walk
    const order: string[] = [];
    let dispose = (): void => {};

    createRoot((d) => {
      dispose = d;
      onCleanup(() => order.push('a'));
      const stop = createEffect(() => () => order.push('effect'));
      onCleanup(() => order.push('b'));
      onCleanup(() => {
        order.push('stop');
        stop();
      });
    }, effects.effect);

    dispose();
    expect(order).toEqual(['stop', 'effect', 'b', 'a']);
  });
});

describe('Show', () => {
  it('should close a branch whose own effect cleared the condition', () => {
    // the branch is built inside `Show`'s effect, so the write landed on a run
    // that was already marked: propagation stopped at it and the run's end
    // marked it clean, and the screen kept a branch whose condition was false
    const h = harness(20, 1);
    const open = new State(true);
    const errors: unknown[] = [];
    const view = render(
      () =>
        Show({
          children: () => {
            // validation on mount deciding the panel should not be open
            createEffect(() => open.set(false));
            return text('open');
          },
          fallback: () => text('closed'),
          when: () => open.get(),
        }),
      { backend: h.backend, effects, onError: (err) => errors.push(err), terminal: h.terminal }
    );
    view.frame();
    view.frame();

    expect(errors).toEqual([]);
    expect(open.get()).toBe(false);
    expect(h.picture()).toBe('closed..............');
    view.dispose();
  });

  it('should mount and dispose a branch as the condition turns', () => {
    const h = harness();
    const on = new State(false);
    const events: string[] = [];

    const view = render(
      () =>
        box(
          {},
          Show({
            children: () => {
              onCleanup(() => events.push('gone'));
              events.push('built');
              return text('yes');
            },
            fallback: () => text('no'),
            when: () => on.get(),
          })
        ),
      { backend: h.backend, effects, terminal: h.terminal }
    );

    expect(h.picture().split('\n')[0]).toBe('no..................');
    expect(events).toEqual([]);

    on.set(true);
    view.frame();
    expect(h.picture().split('\n')[0]).toBe('yes.................');
    expect(events).toEqual(['built']);

    on.set(false);
    view.frame();
    expect(h.picture().split('\n')[0]).toBe('no..................');
    expect(events).toEqual(['built', 'gone']);
    view.dispose();
  });

  it('should not rebuild a branch while presence did not change', () => {
    // a `when` that reads a counter would otherwise tear its branch down and
    // build it again on every tick, losing whatever state the branch held
    const h = harness();
    const count = new State(1);
    let builds = 0;

    const view = render(
      () =>
        box(
          {},
          Show({
            children: () => {
              builds++;
              return text('on');
            },
            when: () => count.get() > 0,
          })
        ),
      { backend: h.backend, effects, terminal: h.terminal }
    );

    expect(builds).toBe(1);
    count.set(2);
    view.frame();
    count.set(3);
    view.frame();
    expect(builds).toBe(1);
    view.dispose();
  });

  it('should hand the branch an accessor, so a value that moved still reaches it', () => {
    // the other half of the rule above, and the one combination that is wrong:
    // a branch kept across a value change has to be able to read the new value.
    // Handed the value itself, a `when` producing one object and then another
    // left the branch describing the first for good -- both are present, so
    // presence never moved, so nothing was ever rebuilt. Found by writing
    // `demos/renderer/02-tasks.js`, whose detail pane is exactly this shape
    const h = harness();
    const ada = { name: 'ada' };
    const grace = { name: 'grace' };
    const user = new State<{ name: string } | undefined>(ada);
    let builds = 0;

    const view = render(
      () =>
        box(
          {},
          Show({
            children: (who) => {
              builds++;
              const label = text('');
              // braced rather than a concise body, because `setText` returns
              // `this` for chaining and `createEffect`'s parameter is
              // `() => void | Cleanup` -- a union, which gives up the
              // return-anything leniency a bare `() => void` would have had
              createEffect(() => {
                label.setText(who().name);
              });
              return label;
            },
            when: () => user.get(),
          })
        ),
      { backend: h.backend, effects, terminal: h.terminal }
    );

    expect(h.picture().split('\n')[0]).toBe('ada.................');

    user.set(grace);
    view.frame();
    expect(h.picture().split('\n')[0]).toBe('grace...............');
    // and the branch was *kept* while it followed, which is what makes the
    // accessor necessary rather than merely sufficient: rebuilding on a value
    // change would have given the same picture and lost the branch's own state
    expect(builds).toBe(1);

    view.dispose();
  });

  it('should leave a build-time read of that accessor a snapshot', () => {
    // the accessor makes a live read *possible*; it does not make a build-time
    // read live, because the branch is not rebuilt while presence holds. Same
    // contract as `For`'s index, and worth pinning so that the one way to follow
    // a value -- read it in an effect -- is not mistaken for two.
    //
    // Named for what it pins rather than for the mechanism: the first version of
    // this said "untracked at build time", and deleting the `untrack()` around the
    // build leaves it green, because the early return is what stops the rebuild.
    // What that `untrack()` really buys has a test of its own, under `For`
    const h = harness();
    const user = new State<{ name: string } | undefined>({ name: 'ada' });

    const view = render(
      () =>
        box(
          {},
          Show({
            // read once, at build time, and never again
            children: (who) => text(who().name),
            when: () => user.get(),
          })
        ),
      { backend: h.backend, effects, terminal: h.terminal }
    );

    user.set({ name: 'grace' });
    view.frame();
    expect(h.picture().split('\n')[0]).toBe('ada.................');
    view.dispose();
  });

  it('should not let the branch builder make the condition depend on what it read', () => {
    // what the `untrack()` around the build buys, which a review round had to
    // refute a claim to find: a builder that reads a signal *directly* rather
    // than in an effect would otherwise subscribe `Show`'s own effect to it, so
    // an unrelated change re-evaluates `when` -- and `when` is where presence
    // comes from, which is the one answer a conditional must not take from
    // somewhere else. The same guard `For` has one block down, and the snapshot
    // test above cannot see it: the early return on an unchanged presence hides
    // the re-run, so what has to be counted is the `when` evaluations
    const effects = createEffects();
    const theme = new State('dark');
    const on = new State(true);
    let conditions = 0;

    createRoot(() => {
      Show({
        children: () => text(theme.get()),
        when: () => {
          conditions++;
          return on.get();
        },
      });
    }, effects.effect);

    expect(conditions).toBe(1);
    theme.set('light');
    effects.flush();
    expect(conditions).toBe(1);

    // and the condition is still live, so this is not a dead `Show`
    on.set(false);
    effects.flush();
    expect(conditions).toBe(2);
  });
});

describe('For', () => {
  it('should drop a row whose own effect removed it from the list', () => {
    // the same write one level down: the reconcile is the effect that was
    // running, so the list it committed was the one before the write
    const h = harness(20, 3);
    const items = new State<readonly string[]>(['a', 'bad', 'c']);
    const errors: unknown[] = [];
    const view = render(
      () =>
        For({
          children: (item) => {
            createEffect(() => {
              if (item === 'bad') {
                items.set(items.get().filter((x) => x !== 'bad'));
              }
            });
            return text(item);
          },
          each: () => items.get(),
          props: { 'flex-direction': 'column' },
        }),
      { backend: h.backend, effects, onError: (err) => errors.push(err), terminal: h.terminal }
    );
    view.frame();
    view.frame();

    expect(errors).toEqual([]);
    expect(items.get()).toEqual(['a', 'c']);
    expect(h.picture().split('\n')).toEqual([
      'a...................',
      'c...................',
      '....................',
    ]);
    view.dispose();
  });

  it('should not re-run the reconcile for the row indices it wrote itself', () => {
    // moving a kept row writes its index, and reading the old one tracked made
    // the reconcile depend on every index it was about to change -- one more
    // pass for every reorder, running to completion before it found nothing to do
    const h = harness();
    const a = { n: 'a' };
    const b = { n: 'b' };
    const items = new State<readonly { n: string }[]>([a, b]);
    let evaluated = 0;

    const view = render(
      () =>
        For({
          children: (item) => text(item.n),
          each: () => {
            evaluated++;
            return items.get();
          },
          props: { 'flex-direction': 'column' },
        }),
      { backend: h.backend, effects, terminal: h.terminal }
    );
    view.frame();
    expect(evaluated).toBe(1);

    items.set([b, a]);
    view.frame();
    view.frame();

    expect(evaluated).toBe(2);
    view.dispose();
  });

  it('should keep a row that moved rather than rebuilding it', () => {
    // keyed by identity: position keying rebuilds every row after the first
    // change, which for a terminal means the focus ring moves under whoever was
    // typing
    const h = harness();
    const a = { name: 'a' };
    const b = { name: 'b' };
    const items = new State<readonly { name: string }[]>([a, b]);
    const built: string[] = [];
    const made = new Map<{ name: string }, Element>();

    const view = render(
      () =>
        box(
          {},
          For({
            props: { 'flex-direction': 'column' },
            children: (item) => {
              built.push(item.name);
              const element = text(item.name);
              made.set(item, element);
              return element;
            },
            each: () => items.get(),
          })
        ),
      { backend: h.backend, effects, terminal: h.terminal }
    );

    expect(built).toEqual(['a', 'b']);
    const firstA = made.get(a);

    items.set([b, a]);
    view.frame();

    expect(built).toEqual(['a', 'b']);
    expect(made.get(a)).toBe(firstA);
    expect(h.picture().split('\n').slice(0, 2)).toEqual([
      'b...................',
      'a...................',
    ]);
    view.dispose();
  });

  it('should dispose a row that left', () => {
    const h = harness();
    const a = { n: 1 };
    const b = { n: 2 };
    const items = new State<readonly { n: number }[]>([a, b]);
    const gone: number[] = [];

    const view = render(
      () =>
        box(
          {},
          For({
            props: { 'flex-direction': 'column' },
            children: (item) => {
              onCleanup(() => gone.push(item.n));
              return text(String(item.n));
            },
            each: () => items.get(),
          })
        ),
      { backend: h.backend, effects, terminal: h.terminal }
    );

    items.set([a]);
    view.frame();
    expect(gone).toEqual([2]);
    view.dispose();
  });

  it('should give a moved row its new index', () => {
    // an accessor rather than a number, because the row that moved is the same
    // row and rebuilding it to tell it where it sits throws away what keying
    // exists to keep
    const h = harness();
    const a = { n: 'a' };
    const b = { n: 'b' };
    const items = new State<readonly { n: string }[]>([a, b]);

    const view = render(
      () =>
        box(
          {},
          For({
            props: { 'flex-direction': 'column' },
            children: (item, index) => {
              const label = text('');
              createEffect(() => {
                label.setText(`${index()}${item.n}`);
              });
              return label;
            },
            each: () => items.get(),
          })
        ),
      { backend: h.backend, effects, terminal: h.terminal }
    );

    expect(h.picture().split('\n').slice(0, 2)).toEqual([
      '0a..................',
      '1b..................',
    ]);

    items.set([b, a]);
    view.frame();
    expect(h.picture().split('\n').slice(0, 2)).toEqual([
      '0b..................',
      '1a..................',
    ]);
    view.dispose();
  });

  it('should hold two rows for an item that appears twice', () => {
    // two equal primitives in a list are a list with two entries in it, not a
    // bug to refuse
    const h = harness();
    const items = new State<readonly string[]>(['x', 'x', 'y']);
    let builds = 0;

    const view = render(
      () =>
        box(
          {},
          For({
            props: { 'flex-direction': 'column' },
            children: (item) => {
              builds++;
              return text(item);
            },
            each: () => items.get(),
          })
        ),
      { backend: h.backend, effects, terminal: h.terminal }
    );

    expect(builds).toBe(3);
    expect(h.picture().split('\n').slice(0, 3)).toEqual([
      'x...................',
      'x...................',
      'y...................',
    ]);
    view.dispose();
  });

  it('should show a fallback while the list is empty', () => {
    const h = harness();
    const items = new State<readonly string[]>([]);

    const view = render(
      () =>
        box(
          {},
          For({
            children: (item) => text(item),
            each: () => items.get(),
            fallback: () => text('empty'),
          })
        ),
      { backend: h.backend, effects, terminal: h.terminal }
    );

    expect(h.picture().split('\n')[0]).toBe('empty...............');
    items.set(['a']);
    view.frame();
    expect(h.picture().split('\n')[0]).toBe('a...................');
    view.dispose();
  });

  it('should keep the focus on a row that moved', () => {
    // the reason keying exists, stated as the thing a user would feel: position
    // keying rebuilds every row after the change, and the focused element is
    // then one nothing is holding any more. Every other `For` test here asserts
    // element identity, which is the mechanism; this asserts the consequence,
    // across the one layer that reads it
    const h = harness();
    const a = { n: 'a' };
    const b = { n: 'b' };
    const items = new State<readonly { n: string }[]>([a, b]);
    const made = new Map<string, Element>();

    const view = render(
      () =>
        box(
          {},
          For({
            children: (item) => {
              const row = box({ focusable: true }, text(item.n));
              made.set(item.n, row);
              return row;
            },
            each: () => items.get(),
            props: { 'flex-direction': 'column' },
          })
        ),
      { backend: h.backend, effects, terminal: h.terminal }
    );

    const input = createInput({ root: view.root, terminal: keyboard().terminal });
    input.focus.focus(made.get('a'));
    expect(input.focus.current.get()).toBe(made.get('a'));

    items.set([b, a]);
    view.frame();

    // the same element, now second in the ring rather than first -- so a Tab
    // from here goes to `b`, which is what "the focus moved with the row" means
    expect(input.focus.current.get()).toBe(made.get('a'));
    expect(input.focus.ring()).toEqual([made.get('b'), made.get('a')]);

    // and then a key, which is what the first version of this test was missing.
    // Placing a row is `insertBefore`, which is a removal followed by an
    // insertion -- so the focus repair has to decide that a row which *ended*
    // attached was never unmounted, and that decision is only taken when a key
    // arrives. Without the key the assertions above hold with the repair
    // repairing unconditionally, which is a sabotage that survived: it would
    // hand the focus to whatever now sits where `a` used to, and the second `J`
    // of a `J J J` in the demo would be moving the wrong row
    input.feed('z');
    expect(input.focus.current.get()).toBe(made.get('a'));

    input.stop();
    view.dispose();
  });

  it('should not let a row reading a signal make the reconcile depend on it', () => {
    // what the `untrack()` around the row builder buys, which nothing asked
    // about: a row body that reads a signal *directly* rather than in an effect
    // -- a theme, a width, a format -- would otherwise be read while the
    // reconcile's own effect is evaluating, so the whole list re-reconciles
    // whenever it moves. One row and one signal is enough to show it; at a
    // hundred rows it is a hundred-row walk for a value one row looked at
    const effects = createEffects();
    const theme = new State('dark');
    const items = new State<readonly { n: string }[]>([{ n: 'a' }]);
    let reconciles = 0;

    createRoot(() => {
      box(
        {},
        For({
          children: (item) => text(`${item.n}-${theme.get()}`),
          each: () => {
            reconciles++;
            return items.get();
          },
        })
      );
    }, effects.effect);

    expect(reconciles).toBe(1);
    theme.set('light');
    effects.flush();
    expect(reconciles).toBe(1);

    // and the list itself still reconciles, so this is not a dead `For`
    items.set([{ n: 'b' }]);
    effects.flush();
    expect(reconciles).toBe(2);
  });
});

describe('For, placing a reorder', () => {
  // counted in `insertBefore` calls, because each is a removal and an insertion
  // that both search the host's children: placing by position moved n-1 rows to
  // take the first one to the end, which made a one-row move quadratic

  /** A `For` of text rows over `initial`, with its moves counted. */
  function list<T>(initial: readonly T[], label: (item: T) => string = String) {
    const effects = createEffects();
    const items = new State<readonly T[]>(initial);
    const built: T[] = [];
    const gone: T[] = [];
    const host = createRoot(
      () =>
        For({
          children: (item) => {
            built.push(item);
            onCleanup(() => gone.push(item));
            return text(label(item));
          },
          each: () => items.get(),
        }),
      effects.effect
    );
    const moves = vi.spyOn(host, 'insertBefore');
    return {
      built,
      gone,
      host,
      moves,
      order: () => host.children.map((row) => row.text),
      set(next: readonly T[]) {
        moves.mockClear();
        items.set(next);
        effects.flush();
      },
    };
  }

  const numbers = (n: number) => Array.from({ length: n }, (_, at) => at);

  it('should move one row to take the first to the end', () => {
    const l = list(numbers(100));
    const next = [...numbers(100).slice(1), 0];
    l.set(next);
    expect(l.order()).toEqual(next.map(String));
    expect(l.moves).toHaveBeenCalledTimes(1);
  });

  it('should move two rows to swap the ends', () => {
    const l = list(numbers(100));
    const next = [99, ...numbers(100).slice(1, -1), 0];
    l.set(next);
    expect(l.order()).toEqual(next.map(String));
    expect(l.moves).toHaveBeenCalledTimes(2);
  });

  it('should move one row to take the last to the front', () => {
    const l = list(numbers(100));
    const next = [99, ...numbers(100).slice(0, -1)];
    l.set(next);
    expect(l.order()).toEqual(next.map(String));
    expect(l.moves).toHaveBeenCalledTimes(1);
  });

  it('should move every row but one to reverse the list', () => {
    const l = list(numbers(20));
    const next = numbers(20).reverse();
    l.set(next);
    expect(l.order()).toEqual(next.map(String));
    expect(l.moves).toHaveBeenCalledTimes(19);
  });

  it('should move nothing for a list in the same order, and only a new row for an insert', () => {
    const l = list(numbers(10));
    l.set(numbers(10));
    expect(l.moves).not.toHaveBeenCalled();

    const next = [0, 1, 2, 3, 4, 100, 5, 6, 7, 8, 9];
    l.set(next);
    expect(l.order()).toEqual(next.map(String));
    expect(l.moves).toHaveBeenCalledTimes(1);
  });

  it('should move only the rows off the longest run already in order, over a shuffle', () => {
    // the bound is exact: a row on a longest increasing run of old positions
    // need not move, and every row off one must -- so the count is n minus the
    // run's length, computed here the quadratic way rather than by the helper
    const random = seeded(345);
    for (let round = 0; round < 20; round++) {
      const n = 1 + Math.floor(random() * 60);
      const next = numbers(n);
      for (let at = n - 1; at > 0; at--) {
        const other = Math.floor(random() * (at + 1));
        [next[at], next[other]] = [next[other], next[at]];
      }
      const best = next.map(() => 1);
      for (let i = 0; i < n; i++) {
        for (let j = 0; j < i; j++) {
          if (next[j] < next[i]) {
            best[i] = Math.max(best[i], best[j] + 1);
          }
        }
      }

      const l = list(numbers(n));
      l.set(next);
      expect(l.order()).toEqual(next.map(String));
      expect(l.moves).toHaveBeenCalledTimes(n - Math.max(...best));
      expect(l.built).toHaveLength(n);
    }
  });

  it('should keep the right row for each copy of a key through a reorder and a removal', () => {
    // a key held three times is three rows, handed out in the order they were
    // held: the first `x` wanted is the first `x` built, and the one nobody
    // asks for any more is the last -- whose cleanup is the one that runs
    const ids = new Map<Element, number>();
    const x = 'x';
    const l = list<string>([x, 'y', x, x]);
    const rows = [...l.host.children];
    for (const [at, row] of rows.entries()) {
      ids.set(row, at);
    }

    l.set(['y', x, x]);

    expect(l.order()).toEqual(['y', 'x', 'x']);
    expect(l.host.children.map((row) => ids.get(row))).toEqual([1, 0, 2]);
    expect(l.built).toHaveLength(4);
    expect(l.gone).toEqual(['x']);
    expect(rows[3].parent).toBeUndefined();
    expect(l.moves).toHaveBeenCalledTimes(1);
  });

  it('should never put a row in front of the first child, mounting or replacing a long list', () => {
    // walking from the end and putting each row in front of the one after it
    // put every row of a first mount at index 0 of the children, and a splice
    // there shifts every child behind it: a 200,000-row mount went from 388ms to
    // 4,781ms. The rows after the last one that stays are appended instead, so a
    // mount and a wholesale replacement only ever add at the end
    const insertBefore = Element.prototype.insertBefore;
    let atFront = 0;
    const spy = vi.spyOn(Element.prototype, 'insertBefore').mockImplementation(function (
      this: Element,
      child,
      before
    ) {
      if (before !== undefined && before === this.children[0]) {
        atFront++;
      }
      return insertBefore.call(this, child, before);
    });
    try {
      const l = list(numbers(3000));
      expect(l.order()).toEqual(numbers(3000).map(String));
      expect(atFront).toBe(0);

      const next = numbers(3000).map((n) => n + 10_000);
      l.set(next);
      expect(l.order()).toEqual(next.map(String));
      expect(l.moves).toHaveBeenCalledTimes(3000);
      expect(atFront).toBe(0);
    } finally {
      spy.mockRestore();
    }
  });

  it('should reconcile a long list of one repeated primitive against itself without building or moving', () => {
    // read through a cursor rather than by `shift()`, which is O(k) for a key
    // held k times and made this quadratic. What is asserted is the outcome a
    // cursor has to keep -- every copy kept, none built, none moved, none
    // disposed -- and, since that outcome is the same either way and only the
    // time differs, that the reconcile takes no copy off the front of an array:
    // nothing on its path shifts one, so a count of zero is the cursor
    const l = list<string>(Array.from({ length: 5000 }, () => 'x'));
    const before = [...l.host.children];

    const shift = vi.spyOn(Array.prototype, 'shift');
    try {
      l.set(Array.from({ length: 5000 }, () => 'x'));
      expect(shift).not.toHaveBeenCalled();
    } finally {
      shift.mockRestore();
    }

    expect(l.host.children.every((row, at) => row === before[at])).toBe(true);
    expect(l.built).toHaveLength(5000);
    expect(l.gone).toEqual([]);
    expect(l.moves).not.toHaveBeenCalled();

    // and shrinking it lets go of the copies past the end, not the ones before
    l.set(Array.from({ length: 4998 }, () => 'x'));
    expect(l.host.children).toHaveLength(4998);
    expect(l.host.children.every((row, at) => row === before[at])).toBe(true);
    expect(before.slice(4998).every((row) => row.parent === undefined)).toBe(true);
    expect(l.gone).toEqual(['x', 'x']);
    expect(l.moves).not.toHaveBeenCalled();
  });
});

describe('Renderer.onDispose()', () => {
  /** A renderer whose cleanup, screen restore and reports land in one list. */
  function mounted() {
    const h = harness();
    const order: string[] = [];
    (h.backend as unknown as { done: () => void }).done = () => order.push('screen');
    const label = text('hi');
    const view = render(
      () => {
        onCleanup(() => order.push('owner'));
        return box({}, label);
      },
      {
        backend: h.backend,
        effects,
        onError: (error) => order.push(`reported ${(error as Error).message}`),
        terminal: h.terminal,
      }
    );
    return { label, order, view };
  }

  it('should fire once, before the owners go and before the screen does', () => {
    const { label, order, view } = mounted();
    view.onDispose(() => {
      // the tree is still whole, and no frame will paint it again
      order.push(`handler mounted=${view.mounted} attached=${label.parent !== undefined}`);
    });

    view.dispose();
    view.dispose();
    expect(order).toEqual(['handler mounted=false attached=true', 'owner', 'screen']);
  });

  it('should fire for a renderer a frame took down, too', () => {
    const h = harness();
    const count = new State(0);
    const fired: string[] = [];
    const view = render(
      () => {
        const label = text('');
        createEffect(() => {
          if (count.get() > 0) {
            throw new Error('boom');
          }
          label.setText('ok');
        });
        return label;
      },
      { backend: h.backend, effects, onError: () => {}, terminal: h.terminal }
    );
    view.onDispose(() => fired.push('gone'));

    count.set(1);
    view.frame();
    expect(view.mounted).toBe(false);
    expect(fired).toEqual(['gone']);
  });

  it('should say failed for a renderer a frame took down, already inside the handler', () => {
    const h = harness();
    const count = new State(0);
    const seen: boolean[] = [];
    const view = render(
      () => {
        const label = text('');
        createEffect(() => {
          if (count.get() > 0) {
            throw new Error('boom');
          }
          label.setText('ok');
        });
        return label;
      },
      { backend: h.backend, effects, onError: () => {}, terminal: h.terminal }
    );
    expect(view.failed).toBe(false);
    view.onDispose(() => seen.push(view.failed));

    count.set(1);
    view.frame();
    expect(seen).toEqual([true]);
    expect(view.failed).toBe(true);
  });

  it('should not say failed for a dispose() whose cleanup threw, which is a decision', () => {
    const h = harness();
    const reports: unknown[] = [];
    const view = render(
      () => {
        onCleanup(() => {
          throw new Error('cleanup broke');
        });
        return text('x');
      },
      { backend: h.backend, effects, onError: (error) => reports.push(error), terminal: h.terminal }
    );
    const seen: boolean[] = [];
    view.onDispose(() => seen.push(view.failed));
    view.dispose();
    expect(seen).toEqual([false]);
    expect(view.mounted).toBe(false);
    expect(reports).toHaveLength(1);
    // the report looks exactly like a failed frame's from `onError`; this is the
    // one place the difference is said
    expect(view.failed).toBe(false);
  });

  it('should report a handler that throws and still run the rest, and the teardown', () => {
    const { order, view } = mounted();
    view.onDispose(() => {
      throw new Error('first');
    });
    view.onDispose(() => order.push('second'));

    view.dispose();
    // and reported once the screen is back, which is the failure path's order
    // and holds for a dispose() too (SIG-348)
    expect(order).toEqual(['second', 'owner', 'screen', 'reported first']);
  });

  it('should not call a handler that unsubscribed, before or during the dispatch', () => {
    const { order, view } = mounted();
    const off = view.onDispose(() => order.push('before'));
    off();
    let offLater = (): void => {};
    view.onDispose(() => {
      order.push('first');
      offLater();
    });
    offLater = view.onDispose(() => order.push('later'));

    view.dispose();
    expect(order).toEqual(['first', 'owner', 'screen']);
  });

  /**
   * `onCleanup()`'s rule for a disposed owner: nothing would ever call it
   * otherwise, and a handler that never runs is the leak this exists to close.
   */
  it('should call a handler given after it has gone at once, and keep nothing', () => {
    const { order, view } = mounted();
    view.dispose();
    order.length = 0;

    const off = view.onDispose(() => order.push('late'));
    expect(order).toEqual(['late']);
    off();

    view.onDispose(() => {
      throw new Error('late');
    });
    expect(order).toEqual(['late', 'reported late']);
  });

  it('should call a handler subscribed by another while they are being called', () => {
    const { order, view } = mounted();
    view.onDispose(() => {
      order.push('outer');
      view.onDispose(() => order.push('inner'));
    });

    view.dispose();
    expect(order).toEqual(['outer', 'inner', 'owner', 'screen']);
  });
});

describe('errors', () => {
  it('should put the terminal back before reporting', () => {
    // a CLI that dies on the alternate buffer with the cursor hidden has eaten
    // the user's shell, and a message printed into a half-drawn frame is
    // unreadable anyway
    const h = harness();
    const order: string[] = [];
    const seen: unknown[] = [];
    (h.terminal as unknown as { restore: () => void }).restore = () => order.push('restored');

    const count = new State(0);
    const view = render(
      () => {
        const label = text('');
        createEffect(() => {
          if (count.get() > 0) {
            throw new Error('boom');
          }
          label.setText('ok');
        });
        return box({}, label);
      },
      {
        backend: h.backend,
        effects,
        onError(error) {
          order.push('reported');
          seen.push(error);
        },
        terminal: h.terminal,
      }
    );

    count.set(1);
    view.frame();

    expect(order).toEqual(['restored', 'reported']);
    expect((seen[0] as Error).message).toBe('boom');
    expect(view.mounted).toBe(false);
  });

  it('should stop rather than throwing the same frame away forever', () => {
    const h = harness();
    let reports = 0;
    const count = new State(0);

    const view = render(
      () => {
        const label = text('');
        createEffect(() => {
          if (count.get() > 0) {
            throw new Error('boom');
          }
          label.setText('ok');
        });
        return box({}, label);
      },
      {
        backend: h.backend,
        effects,
        onError: () => void reports++,
        terminal: h.terminal,
      }
    );

    count.set(1);
    view.frame();
    view.frame();
    view.frame();
    expect(reports).toBe(1);
  });
});

describe('a frame that failed part way', () => {
  it('should stop the frame it failed in rather than finishing it', () => {
    // an effect that throws is *reported* by the scope's handler rather than
    // thrown through it, so the flush returns normally -- and the rest of the
    // frame would then paint onto a terminal the failure had already given back
    // and drain mount callbacks against an owner whose cleanups had all run
    const h = harness();
    const count = new State(0);
    const mounted: string[] = [];

    const view = render(
      () => {
        const first = text('');
        const second = text('');
        // the first effect gives the frame something to paint, so that a frame
        // which carried on past the failure would be visible as a paint after
        // the screen was handed back
        createEffect(() => {
          first.setText(`n=${count.get()}`);
        });
        createEffect(() => {
          if (count.get() > 0) {
            throw new Error('boom');
          }
          second.setText('ok');
        });
        onMount(() => mounted.push('one'));
        return box({ 'flex-direction': 'column' }, first, second);
      },
      { backend: h.backend, effects, onError: () => {}, terminal: h.terminal }
    );

    const paintedBefore = h.painted;
    expect(mounted).toEqual(['one']);

    count.set(1);
    view.frame();

    // nothing was drawn after the screen was given back, though the tree had
    // changed and the frame had every reason to draw
    expect(h.painted).toBe(paintedBefore);
    expect(view.mounted).toBe(false);
  });

  it('should hand a throw from the body to its caller rather than reporting it', () => {
    // `render()` is still on the stack, so there is somebody to hand it to, and
    // reporting it as well is the same failure said twice
    const h = harness();
    const reports: unknown[] = [];

    expect(() =>
      render(
        () => {
          throw new Error('during mount');
        },
        { backend: h.backend, effects, onError: (e) => void reports.push(e), terminal: h.terminal }
      )
    ).toThrow('during mount');

    expect(reports).toEqual([]);
  });
});

/**
 * SIG-348: an `onError` that throws while a teardown reports.
 *
 * Each of the three teardowns reported what a cleanup threw from inside itself,
 * ahead of the backend and the terminal, so an `onError` that threw there left
 * both undone -- and on the failure path the throw then came back to `fail()`,
 * which had already failed and dropped it.
 */
describe('an onError that throws during a teardown', () => {
  /** A harness whose backend and terminal count, and log, what went back. */
  function counted() {
    const h = harness();
    const order: string[] = [];
    const count = { done: 0, restore: 0, stop: 0 };
    const backend = h.backend as unknown as { done: () => void; stop: () => void };
    backend.done = () => {
      count.done++;
      order.push('done');
    };
    backend.stop = () => {
      count.stop++;
      order.push('stop');
    };
    (h.terminal as unknown as { restore: () => void }).restore = () => {
      count.restore++;
      order.push('restore');
    };
    /** Logs what it is handed, then throws it straight back. */
    const onError = (error: unknown): never => {
      order.push(`reported ${(error as Error).message}`);
      throw error;
    };
    return { count, h, onError, order };
  }

  it('should restore the terminal once when a failed frame reports a throwing cleanup', () => {
    const { count, h, onError, order } = counted();
    const n = new State(0);
    const view = render(
      () => {
        onCleanup(() => {
          throw new Error('cleanup broke');
        });
        const label = text('');
        createEffect(() => {
          if (n.get() > 0) {
            throw new Error('boom');
          }
          label.setText('ok');
        });
        return label;
      },
      { backend: h.backend, effects, onError, terminal: h.terminal }
    );

    n.set(1);
    let raised: unknown;
    try {
      view.frame();
    } catch (error) {
      raised = error;
    }

    expect(view.failed).toBe(true);
    expect(count).toEqual({ done: 0, restore: 1, stop: 1 });
    // the screen first, then every report, the failure last
    expect(order).toEqual(['stop', 'restore', 'reported cleanup broke', 'reported boom']);
    // what `onError` threw comes out of the frame rather than being dropped
    expect(raised).toBeInstanceOf(AggregateError);
    expect((raised as AggregateError).errors.map((e: Error) => e.message)).toEqual([
      'cleanup broke',
      'boom',
    ]);
  });

  it('should raise what onError threw from the frame when only the failure is reported', () => {
    const { count, h, onError } = counted();
    const n = new State(0);
    const view = render(
      () => {
        const label = text('');
        createEffect(() => {
          if (n.get() > 0) {
            throw new Error('boom');
          }
          label.setText('ok');
        });
        return label;
      },
      { backend: h.backend, effects, onError, terminal: h.terminal }
    );

    n.set(1);
    expect(() => view.frame()).toThrow('boom');
    expect(count).toEqual({ done: 0, restore: 1, stop: 1 });
    // and the renderer has stopped: a later frame neither restores nor raises
    expect(() => view.frame()).not.toThrow();
    expect(count.restore).toBe(1);
  });

  it('should restore the terminal once when a body that threw has a throwing cleanup', () => {
    const { count, h, onError, order } = counted();
    let raised: unknown;
    try {
      render(
        () => {
          onCleanup(() => {
            throw new Error('cleanup broke');
          });
          throw new Error('during mount');
        },
        { backend: h.backend, effects, onError, terminal: h.terminal }
      );
    } catch (error) {
      raised = error;
    }

    expect(count).toEqual({ done: 0, restore: 1, stop: 1 });
    expect(order).toEqual(['stop', 'restore', 'reported cleanup broke']);
    // the body's error is still the first thing the caller is handed, with what
    // `onError` threw beside it rather than in its place
    expect(raised).toBeInstanceOf(AggregateError);
    expect((raised as AggregateError).errors.map((e: Error) => e.message)).toEqual([
      'during mount',
      'cleanup broke',
    ]);
    // and says the body's message itself, since a writer that renders one line
    // per error shows only an aggregate's own
    expect((raised as AggregateError).message).toContain('during mount');
    expect((raised as AggregateError).cause).toBe((raised as AggregateError).errors[0]);
  });

  it('should restore the terminal when stopping the backend threw, and report that too', () => {
    const { count, h, order } = counted();
    (h.backend as unknown as { stop: () => void }).stop = () => {
      count.stop++;
      throw new Error('stop broke');
    };
    const n = new State(0);
    const view = render(
      () => {
        const label = text('');
        createEffect(() => {
          if (n.get() > 0) {
            throw new Error('boom');
          }
          label.setText('ok');
        });
        return label;
      },
      {
        backend: h.backend,
        effects,
        onError: (e) => void order.push(`reported ${(e as Error).message}`),
        terminal: h.terminal,
      }
    );

    n.set(1);
    view.frame();
    expect(count).toEqual({ done: 0, restore: 1, stop: 1 });
    expect(order).toEqual(['restore', 'reported stop broke', 'reported boom']);
  });

  it('should not restore twice when the renderer failed during mount and onError threw', () => {
    // an effect's first run throws straight out of `createEffect()`, so the way
    // to fail inside the body is a flush of the scope the caller passed: the
    // re-run reports to `fail()`, which gives everything back, and what
    // `onError` throws there reaches the body's catch on its way out
    const { count, h, onError } = counted();
    const n = new State(0);
    expect(() =>
      render(
        () => {
          createEffect(() => {
            if (n.get() > 0) {
              throw new Error('re-run');
            }
          });
          n.set(1);
          effects.flush();
          return text('x');
        },
        { backend: h.backend, effects, onError, terminal: h.terminal }
      )
    ).toThrow('re-run');
    expect(count).toEqual({ done: 0, restore: 1, stop: 1 });
  });

  it('should still hand the body error alone to the caller when onError does not throw', () => {
    const { count, h, order } = counted();
    expect(() =>
      render(
        () => {
          onCleanup(() => {
            throw new Error('cleanup broke');
          });
          throw new Error('during mount');
        },
        {
          backend: h.backend,
          effects,
          onError: (e) => void order.push(`reported ${(e as Error).message}`),
          terminal: h.terminal,
        }
      )
    ).toThrow('during mount');
    expect(count).toEqual({ done: 0, restore: 1, stop: 1 });
    expect(order).toEqual(['stop', 'restore', 'reported cleanup broke']);
  });

  it('should finish the region once when a dispose() reports a throwing cleanup', () => {
    const { count, h, onError, order } = counted();
    const view = render(
      () => {
        onCleanup(() => {
          throw new Error('cleanup broke');
        });
        return text('x');
      },
      { backend: h.backend, effects, onError, terminal: h.terminal }
    );
    view.onDispose(() => {
      throw new Error('handler broke');
    });

    let raised: unknown;
    try {
      view.dispose();
    } catch (error) {
      raised = error;
    }

    // `dispose()` finishes the region and leaves the terminal to its caller, as
    // it always has; what changed is that it now does so whatever `onError` does
    expect(count).toEqual({ done: 1, restore: 0, stop: 0 });
    expect(order).toEqual(['done', 'reported handler broke', 'reported cleanup broke']);
    expect(raised).toBeInstanceOf(AggregateError);
    expect(view.mounted).toBe(false);
    expect(view.failed).toBe(false);
    // and a second dispose() has nothing left to give back or say
    expect(() => view.dispose()).not.toThrow();
    expect(count.done).toBe(1);
  });

  it('should report a cleanup and a backend.done() that both threw on dispose()', () => {
    const { count, h, order } = counted();
    (h.backend as unknown as { done: () => void }).done = () => {
      count.done++;
      order.push('done');
      throw new Error('done broke');
    };
    const view = render(
      () => {
        onCleanup(() => {
          throw new Error('cleanup broke');
        });
        return text('x');
      },
      {
        backend: h.backend,
        effects,
        onError: (e) => void order.push(`reported ${(e as Error).message}`),
        terminal: h.terminal,
      }
    );

    expect(() => view.dispose()).not.toThrow();
    expect(count.done).toBe(1);
    expect(order).toEqual(['done', 'reported cleanup broke', 'reported done broke']);
  });

  it('should still run the cleanups when the terminal unsubscribe throws', () => {
    // a terminal can be the caller's, and its `onResize()` unsubscribe is called
    // in the middle of the unmount, ahead of the owner tree
    const { count, h, order } = counted();
    (h.terminal as unknown as { onResize: () => () => void }).onResize = () => () => {
      throw new Error('unsubscribe broke');
    };
    const view = render(
      () => {
        onCleanup(() => order.push('cleanup'));
        return text('x');
      },
      {
        backend: h.backend,
        effects,
        onError: (e) => void order.push(`reported ${(e as Error).message}`),
        terminal: h.terminal,
      }
    );

    view.dispose();
    expect(count.done).toBe(1);
    expect(order).toEqual(['cleanup', 'done', 'reported unsubscribe broke']);
  });
});

describe('independence', () => {
  it("should not install its frame loop over another renderer's", () => {
    // a scope holds one scheduler and one error handler, so sharing the module's
    // meant a second `render()` stopped the first painting, and an effect that
    // threw in either tore down whichever had installed last
    const a = harness();
    const b = harness();
    const one = new State(0);
    const two = new State(0);

    const first = render(
      () => {
        const label = text('');
        createEffect(() => {
          label.setText(`a=${one.get()}`);
        });
        return box({}, label);
      },
      { backend: a.backend, terminal: a.terminal }
    );
    const second = render(
      () => {
        const label = text('');
        createEffect(() => {
          label.setText(`b=${two.get()}`);
        });
        return box({}, label);
      },
      { backend: b.backend, terminal: b.terminal }
    );

    one.set(1);
    two.set(1);
    first.frame();
    second.frame();

    expect(a.picture().split('\n')[0]).toBe('a=1.................');
    expect(b.picture().split('\n')[0]).toBe('b=1.................');

    // and disposing one leaves the other painting
    first.dispose();
    two.set(2);
    second.frame();
    expect(b.picture().split('\n')[0]).toBe('b=2.................');
    second.dispose();
  });

  it('should fail the renderer whose effect threw, and only that one', () => {
    // a shared scope holds one error handler, so a throw in either tore down
    // whichever had installed last -- restoring the terminal out from under the
    // one that was still running
    const a = harness();
    const b = harness();
    const boom = new State(0);
    const restored: string[] = [];
    (a.terminal as unknown as { restore: () => void }).restore = () => restored.push('a');
    (b.terminal as unknown as { restore: () => void }).restore = () => restored.push('b');

    const first = render(
      () => {
        const label = text('');
        createEffect(() => {
          if (boom.get() > 0) {
            throw new Error('boom');
          }
          label.setText('a');
        });
        return box({}, label);
      },
      { backend: a.backend, onError: () => {}, terminal: a.terminal }
    );
    const second = render(() => box({}, text('b')), {
      backend: b.backend,
      onError: () => {},
      terminal: b.terminal,
    });

    boom.set(1);
    first.frame();

    expect(first.mounted).toBe(false);
    expect(second.mounted).toBe(true);
    expect(restored).toEqual(['a']);
    second.dispose();
  });
});

describe('a builder that throws', () => {
  it('should leave Show able to try again', () => {
    // presence is committed after the branch exists. Committed first, an effect
    // caches what it threw and goes clean -- so the next truthy `when()` matched
    // the recorded presence, returned early, and the host stayed empty for good
    const which = new State(0);
    let explode = true;
    const thrown: unknown[] = [];
    effects.setErrorHandler((error) => void thrown.push(error));

    let host: Element | undefined;
    createRoot(() => {
      host = Show({
        children: (n) => {
          if (explode) {
            throw new Error('nope');
          }
          return text(`v${n()}`);
        },
        when: () => which.get() || false,
      });
    }, effects.effect);

    which.set(1);
    effects.flush();
    expect((thrown[0] as Error).message).toBe('nope');
    expect(host?.children.length).toBe(0);

    // a different truthy value: presence did not change, so only a `showing`
    // that was never committed lets this build
    explode = false;
    which.set(2);
    effects.flush();
    expect(host?.children[0]?.text).toBe('v2');
  });

  it('should leave For describing what is still on screen', () => {
    // the rows built before the throw were owned by nothing -- `rows` never took
    // them, and an effect caches what it threw, so the next reconcile started
    // from the stale list and those branches ran for the life of the `For`
    const a = { n: 'a' };
    const bad = { n: 'bad' };
    const items = new State<readonly { n: string }[]>([a]);
    let live = 0;
    const thrown: unknown[] = [];
    effects.setErrorHandler((error) => void thrown.push(error));

    createRoot(() => {
      For({
        children: (item) => {
          if (item === bad) {
            throw new Error('nope');
          }
          live++;
          onCleanup(() => live--);
          return text(item.n);
        },
        each: () => items.get(),
      });
    }, effects.effect);

    expect(live).toBe(1);

    // `bad` is second, so the row before it is built and then has to be undone
    items.set([{ n: 'c' }, bad]);
    effects.flush();
    expect((thrown[0] as Error).message).toBe('nope');
    expect(live).toBe(1);

    // and the next reconcile starts from what is still there rather than from a
    // list holding a row nothing owns
    items.set([a]);
    effects.flush();
    expect(live).toBe(1);
  });
});

describe('unmounting', () => {
  it('should let the restyler forget a subtree that left', () => {
    // `Restyler` keys its caches by element identity, so a panel shown and
    // hidden for an hour leaves an entry per node per mount with nothing to
    // point at
    const h = harness();
    const on = new State(true);
    let gone: Element | undefined;

    const view = render(
      () =>
        box(
          {},
          Show({
            children: () => {
              gone = box({ class: 'x' }, text('here'));
              return gone;
            },
            when: () => on.get(),
          })
        ),
      { backend: h.backend, effects, terminal: h.terminal }
    );

    expect(gone?.tree).toBeDefined();
    expect(view.restyler.styleOf(gone as Element)).toBeDefined();

    on.set(false);
    view.frame();

    // detached, and the frame that saw it leave is what told the restyler --
    // which keys by element identity and would otherwise hold every node of
    // every branch ever shown, for the life of the renderer
    expect(gone?.tree).toBeUndefined();
    expect(view.restyler.styleOf(gone as Element)).toBeUndefined();
    expect(view.restyler.styleOf(gone?.children[0] as Element)).toBeUndefined();
    view.dispose();
  });

  it('should keep the style of a row that only moved', () => {
    // a move is a removal and an insertion, so forgetting everything that was
    // removed would throw away the style of every row a `For` reordered
    const h = harness();
    const a = { n: 'a' };
    const b = { n: 'b' };
    const items = new State<readonly { n: string }[]>([a, b]);
    const sheet = parseStylesheet(`.row { color: cyan }`);
    const made = new Map<{ n: string }, Element>();

    const view = render(
      () =>
        box(
          {},
          For({
            children: (item) => {
              const element = box({ class: 'row' }, text(item.n));
              made.set(item, element);
              return element;
            },
            each: () => items.get(),
            props: { 'flex-direction': 'column' },
          })
        ),
      {
        backend: h.backend,
        cascade: new Cascade([sheet]),
        colorLevel: 3,
        effects,
        terminal: h.terminal,
      }
    );

    expect(made.get(a)?.style.color).toBe(6);
    items.set([b, a]);
    view.frame();
    expect(made.get(a)?.style.color).toBe(6);
    expect(made.get(a)?.tree).toBeDefined();
    view.dispose();
  });

  it('should refuse to start anything new under a disposed owner', () => {
    // a key handler or a promise landing after unmount is exactly what
    // `runWithOwner()` is for, and exactly where the answer is to do nothing:
    // there is no component left to keep up to date and nothing that would
    // ever dispose the effect
    const h = harness();
    const count = new State(0);
    let runs = 0;
    let owner: ReturnType<typeof getOwner>;

    const view = render(
      () => {
        owner = getOwner();
        return box({}, text('x'));
      },
      { backend: h.backend, effects, terminal: h.terminal }
    );

    view.dispose();
    runWithOwner(owner, () => {
      createEffect(() => {
        runs++;
        count.get();
      });
    });

    expect(runs).toBe(0);
    count.set(1);
    effects.flush();
    expect(runs).toBe(0);
  });

  it('should run a cleanup registered after disposal rather than keeping it', () => {
    const ran: string[] = [];
    let owner: ReturnType<typeof getOwner>;
    createRoot((dispose) => {
      owner = getOwner();
      dispose();
    }, effects.effect);

    runWithOwner(owner, () => onCleanup(() => ran.push('now')));
    expect(ran).toEqual(['now']);
  });

  it('should report what a branch cleanup threw rather than dropping it', () => {
    // `Show` and `For` are not in a position to do anything with a cleanup's
    // throw, and dropping it is how an unmount that failed to unsubscribe
    // something becomes silent
    const h = harness();
    const on = new State(true);
    const reports: unknown[] = [];

    const view = render(
      () =>
        box(
          {},
          Show({
            children: () => {
              onCleanup(() => {
                throw new Error('unsubscribe failed');
              });
              return text('here');
            },
            when: () => on.get(),
          })
        ),
      {
        backend: h.backend,
        effects,
        onError: (error) => void reports.push(error),
        terminal: h.terminal,
      }
    );

    on.set(false);
    view.frame();

    expect((reports[0] as Error).message).toBe('unsubscribe failed');
    expect(view.mounted).toBe(true);
    view.dispose();
  });

  it('should report an onMount throw and stay mounted', () => {
    // a mount callback is not the frame: it runs after one, its throw says
    // nothing about whether the screen is right, and tearing the app down over
    // it would be a worse answer than saying so
    const h = harness();
    const reports: unknown[] = [];

    const view = render(
      () => {
        onMount(() => {
          throw new Error('mount hook');
        });
        return box({}, text('x'));
      },
      {
        backend: h.backend,
        effects,
        onError: (error) => void reports.push(error),
        terminal: h.terminal,
      }
    );

    expect((reports[0] as Error).message).toBe('mount hook');
    expect(view.mounted).toBe(true);
    view.dispose();
  });
});

describe('a builder that throws, going back the way it came', () => {
  it('should leave Show able to return to the presence it had', () => {
    // the inverse of committing presence too early, and just as permanent:
    // tearing the old branch down first left `showing` claiming a branch that
    // was gone, so the presence that came back matched the recorded one and
    // returned early
    const on = new State(false);
    let explode = false;
    const thrown: unknown[] = [];
    effects.setErrorHandler((error) => void thrown.push(error));

    let host: Element | undefined;
    createRoot(() => {
      host = Show({
        children: () => {
          if (explode) {
            throw new Error('nope');
          }
          return text('yes');
        },
        fallback: () => text('no'),
        when: () => on.get(),
      });
    }, effects.effect);

    expect(host?.children[0]?.text).toBe('no');

    explode = true;
    on.set(true);
    effects.flush();
    expect((thrown[0] as Error).message).toBe('nope');
    // the fallback that was on screen is still on screen: nothing was torn down
    // for a branch that never got built
    expect(host?.children[0]?.text).toBe('no');

    // and going back to where it came from is not a no-op
    on.set(false);
    effects.flush();
    expect(host?.children[0]?.text).toBe('no');

    explode = false;
    on.set(true);
    effects.flush();
    expect(host?.children[0]?.text).toBe('yes');
  });

  it('should dispose the row it was part way through building', () => {
    // the branch for the item that threw is created before its builder runs, so
    // tracking finished rows leaves exactly that one alive -- the leak the
    // rollback was written to close, one item along
    const ok = { n: 'ok' };
    const bad = { n: 'bad' };
    const items = new State<readonly { n: string }[]>([ok]);
    let live = 0;
    effects.setErrorHandler(() => {});

    createRoot(() => {
      For({
        children: (item) => {
          live++;
          onCleanup(() => live--);
          if (item === bad) {
            throw new Error('nope');
          }
          return text(item.n);
        },
        each: () => items.get(),
      });
    }, effects.effect);

    expect(live).toBe(1);

    items.set([ok, bad]);
    effects.flush();
    // `bad`'s builder ran, registered a cleanup, and threw: the branch holding
    // that cleanup is disposed with everything else this pass made
    expect(live).toBe(1);
  });

  it('should put back the indexes it had already moved', () => {
    // a row left reading a position the failed pass never placed it at paints
    // the wrong number at the old spot
    const a = { n: 'a' };
    const b = { n: 'b' };
    const bad = { n: 'bad' };
    const items = new State<readonly { n: string }[]>([a, b]);
    const labels = new Map<{ n: string }, Element>();
    effects.setErrorHandler(() => {});

    createRoot(() => {
      For({
        children: (item, index) => {
          if (item === bad) {
            throw new Error('nope');
          }
          const label = text('');
          labels.set(item, label);
          createEffect(() => {
            label.setText(`${index()}${item.n}`);
          });
          return label;
        },
        each: () => items.get(),
      });
    }, effects.effect);

    expect([labels.get(a)?.text, labels.get(b)?.text]).toEqual(['0a', '1b']);

    // `b` is moved to 0 before `bad` throws
    items.set([b, bad, a]);
    effects.flush();

    // and moved back, so no row paints a position it was never placed at. The
    // effect does re-run -- a signal written and written back still re-runs its
    // effects once, with the value it settled on -- and what it paints is right
    expect([labels.get(a)?.text, labels.get(b)?.text]).toEqual(['0a', '1b']);
  });

  it('should not leak a fallback that threw', () => {
    // the fallback is built after `rows` is committed, so it sat outside the
    // rollback: the branch leaked and the list was already empty, which means
    // `each()` never changes again and the effect never retries
    const items = new State<readonly string[]>(['a']);
    let live = 0;
    effects.setErrorHandler(() => {});

    createRoot(() => {
      For({
        children: (item) => text(item),
        each: () => items.get(),
        fallback: () => {
          live++;
          onCleanup(() => live--);
          throw new Error('nope');
        },
      });
    }, effects.effect);

    items.set([]);
    effects.flush();
    expect(live).toBe(0);
  });
});

describe('cleanups inside an effect body', () => {
  it('should report a throw rather than swallowing it', () => {
    // where an unsubscribe belongs, and the one place it failed in silence: the
    // wrapper handed the errors back as an array instead of raising them, so
    // the signals layer had nothing to report
    const thrown: unknown[] = [];
    effects.setErrorHandler((error) => void thrown.push(error));
    const count = new State(0);

    createRoot(() => {
      createEffect(() => {
        count.get();
        onCleanup(() => {
          throw new Error('unsubscribe failed');
        });
      });
    }, effects.effect);

    count.set(1);
    effects.flush();

    expect(thrown.map((e) => (e as Error).message)).toContain('unsubscribe failed');
  });

  it('should run what a run registered before it threw', () => {
    // the cleanup list of a run that threw was never handed to anybody, so an
    // unsubscribe written above the throw never ran -- not on the next run and
    // not at unmount: two of three ran here, one per run that returned
    effects.setErrorHandler(() => {});
    const mode = new State(0);
    let cleanups = 0;
    let dispose = (): void => {};

    createRoot((d) => {
      dispose = d;
      createEffect(() => {
        const m = mode.get();
        onCleanup(() => cleanups++);
        if (m === 1) {
          throw new Error('x');
        }
      });
    }, effects.effect);

    mode.set(1);
    effects.flush();
    expect(cleanups).toBe(2);
    mode.set(2);
    effects.flush();
    dispose();

    expect(cleanups).toBe(3);
  });

  it('should report what the run threw as itself, and with what its cleanups threw', () => {
    const thrown: unknown[] = [];
    effects.setErrorHandler((error) => void thrown.push(error));
    const mode = new State(0);
    const run = new Error('run failed');
    const cleanup = new Error('unsubscribe failed');

    createRoot(() => {
      createEffect(() => {
        const m = mode.get();
        if (m === 1) {
          throw run;
        }
        if (m === 2) {
          onCleanup(() => {
            throw cleanup;
          });
          throw run;
        }
      });
    }, effects.effect);

    mode.set(1);
    effects.flush();
    expect(thrown).toEqual([run]);

    mode.set(2);
    effects.flush();
    expect(thrown).toHaveLength(2);
    const aggregate = thrown[1] as AggregateError;
    expect(aggregate).toBeInstanceOf(AggregateError);
    expect(aggregate.message).toBe('Errors in a failed effect run and its cleanups');
    expect(aggregate.errors).toEqual([run, cleanup]);
  });

  it('should run once what an async body registered before its first await, on the first run', () => {
    // the refusal is made after the body has returned, so whatever it registered
    // before the await is already on the run's list -- and the refusal throws
    // past the composite that would have carried it
    let cleanups = 0;
    let dispose = (): void => {};
    const body = (async () => {
      onCleanup(() => cleanups++);
      await Promise.resolve();
    }) as unknown as () => void;

    createRoot((d) => {
      dispose = d;
      expect(() => createEffect(body)).toThrow(
        new TypeError(
          'An effect may not be async: tracking stops at the first await, so nothing read after it is a dependency'
        )
      );
    }, effects.effect);
    expect(cleanups).toBe(1);

    dispose();
    expect(cleanups).toBe(1);
  });

  it('should run once what an async body registered before its first await, on a re-run', () => {
    const thrown: unknown[] = [];
    effects.setErrorHandler((error) => void thrown.push(error));
    const mode = new State(0);
    let cleanups = 0;
    let dispose = (): void => {};

    createRoot((d) => {
      dispose = d;
      createEffect((() => {
        const m = mode.get();
        onCleanup(() => cleanups++);
        // only the second run is async, so the first can hand over a cleanup
        // the ordinary way and the refusal is the re-run's
        return m === 1 ? Promise.resolve() : undefined;
      }) as () => void);
    }, effects.effect);

    mode.set(1);
    effects.flush();
    // the first run's, before the re-run, and the re-run's own, after its refusal
    expect(cleanups).toBe(2);
    expect(thrown).toHaveLength(1);
    expect(thrown[0]).toBeInstanceOf(TypeError);
    expect((thrown[0] as Error).message).toBe(
      'An effect may not be async: tracking stops at the first await, so nothing read after it is a dependency'
    );

    mode.set(2);
    effects.flush();
    dispose();
    expect(cleanups).toBe(3);
  });

  it('should put the owner back before a failed run cleans up, so what a cleanup registers is kept', () => {
    // the failed run's list is being walked when its cleanups run, so a cleanup
    // that registers another while that run is still current puts it into the
    // list behind the walk, where nothing ever runs it. With the owner put back
    // it goes where the effect was created, here the component, and runs when
    // that goes
    const order: string[] = [];
    let dispose = (): void => {};

    createRoot((d) => {
      dispose = d;
      try {
        createEffect(() => {
          onCleanup(() => {
            order.push('cleanup');
            onCleanup(() => order.push('registered by the cleanup'));
          });
          throw new Error('failed');
        });
      } catch {
        // the component recovers from the effect that failed to start
      }
    }, effects.effect);

    expect(order).toEqual(['cleanup']);

    dispose();
    expect(order).toEqual(['cleanup', 'registered by the cleanup']);
  });
});

describe('re-entrancy', () => {
  it('should not let a frame start from inside one', () => {
    // the inner flush is a no-op while one is draining, so what an inner frame
    // really does is take the outer frame's marks and paint a half-settled
    // graph -- here, one label updated and the next one not yet
    const h = harness();
    const count = new State(0);
    let view: ReturnType<typeof render> | undefined;

    view = render(
      () => {
        const first = text('');
        const second = text('');
        createEffect(() => {
          first.setText(`a=${count.get()}`);
          view?.frame();
        });
        createEffect(() => {
          second.setText(`b=${count.get()}`);
        });
        return box({ 'flex-direction': 'column' }, first, second);
      },
      { backend: h.backend, effects, terminal: h.terminal }
    );

    const before = h.painted;
    count.set(7);
    view.frame();

    // one frame, not two, and the one that happened has both labels in it
    expect(h.painted).toBe(before + 1);
    expect(h.picture().split('\n').slice(0, 2)).toEqual([
      'a=7.................',
      'b=7.................',
    ]);
    view.dispose();
  });

  it('should hand back a dead branch under a disposed owner', () => {
    // asked of `createBranch()` rather than through `Show`, whose own effect
    // never runs there: a live branch parented onto a disposed owner is one
    // nothing will ever walk again, so what runs under it has to start nothing
    const count = new State(0);
    let runs = 0;
    let owner: ReturnType<typeof getOwner>;
    createRoot((dispose) => {
      owner = getOwner();
      dispose();
    }, effects.effect);

    runWithOwner(owner, () => {
      const branch = createBranch();
      runWithOwner(branch.owner, () => {
        createEffect(() => {
          runs++;
          count.get();
        });
      });
    });

    expect(runs).toBe(0);
    count.set(1);
    effects.flush();
    expect(runs).toBe(0);
  });
});

describe('giving the screen back', () => {
  /** A real inline canvas over a modelled screen, which is where this lives. */
  function screened(width = 20, height = 8) {
    const screen = new Screen(width, height);
    const stream = screenStream(screen);
    const terminal = createTerminal({
      env: {},
      isTTY: true,
      proc: { on() {}, pid: 1, removeListener() {} } as never,
      stderr: stream as never,
      stdin: undefined,
      stdout: stream as never,
    });
    return { screen, terminal };
  }

  it('should leave the frame in the log with the cursor below it', () => {
    // an inline backend holds its rows until it is told otherwise, and with the
    // anchor goes the arithmetic that says where the frame's top is relative to
    // the cursor. A `console.log()` after `dispose()` moved the real cursor and
    // left that arithmetic describing somewhere else, so the erase the region
    // does on its way out started two rows *inside* the frame and cleared
    // downwards -- eating the log line and leaving the top of the frame behind
    const { screen, terminal } = screened();
    const view = render(
      () => box({ 'flex-direction': 'column' }, text('one'), text('two'), text('three')),
      { effects, terminal }
    );

    view.dispose();
    terminal.write('after\r\n');

    expect(screen.written).toEqual(['one', 'two', 'three', 'after']);
  });

  it('should leave nothing behind when the backend is stopped first', () => {
    // order matters and the doc says so: finishing the region is what hands the
    // rows back, so an erase on the other side of `dispose()` has no anchor to
    // be relative to and quietly does nothing
    const { screen, terminal } = screened();
    const view = render(() => box({ 'flex-direction': 'column' }, text('one'), text('two')), {
      effects,
      terminal,
    });

    view.backend.stop();
    view.dispose();
    terminal.write('after\r\n');

    expect(screen.written).toEqual(['after']);
  });
});

describe('refining what the terminal is', () => {
  /**
   * A router that answers with whatever it was told to, and nothing else.
   *
   * `detect()` only ever calls `query()`, and the router's own half -- a reply
   * taken out of the key stream, the CPR gate, the deadline -- is asserted in
   * `test/input/capabilities.test.ts` over the real one. What is asserted here is
   * the renderer's half: that a late reply *restyles* rather than being dropped.
   */
  function answering(replies: readonly string[]) {
    const written: string[] = [];
    return {
      written,
      router: {
        query(opts: { write: string }) {
          written.push(opts.write);
          return Promise.resolve(
            replies.map((it) => parseCapabilityResponse(it)).filter((it) => it !== undefined)
          );
        },
      } as never,
    };
  }

  const SHEET = `
    box { color: gray }
    @media (color-level: 3) { box { color: cyan } }
  `;

  it('should publish a late reply as a media change and restyle', async () => {
    const h = harness(20, 4);
    let root: Element | undefined;
    const view = render(
      () => {
        root = box({}, text('x'));
        return root;
      },
      {
        backend: h.backend,
        cascade: new Cascade([parseStylesheet(SHEET)]),
        colorLevel: 2,
        effects,
        frameMs: 0,
        terminal: h.terminal,
      }
    );

    // the first frame did not wait for anything: it painted at the level that was
    // inferred, which is what `probing refines it and never gates it` means
    expect(root?.style.color).toBe(8);
    const painted = h.painted;

    const { router } = answering([`\u001bP>|Ghostty 1.0.1\u001b\\`, `\u001b[?62;c`]);
    const caps = await view.detect(router);
    expect(caps.colorLevel).toBe(3);

    // and the frame the reply asked for arrives on its own, which is the half
    // that silently does nothing when it is not wired up
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(root?.style.color, 'the reply was read and then dropped').toBe(6);
    expect(h.painted, 'nothing repainted').toBeGreaterThan(painted);
    view.dispose();
  });

  it('should let a resize keep the refinement rather than undo it', async () => {
    const h = harness(20, 4);
    let root: Element | undefined;
    const view = render(
      () => {
        root = box({}, text('x'));
        return root;
      },
      {
        backend: h.backend,
        cascade: new Cascade([parseStylesheet(SHEET)]),
        colorLevel: 1,
        effects,
        frameMs: 0,
        terminal: h.terminal,
      }
    );

    const { router } = answering([`\u001bP>|kitty 0.32.2\u001b\\`, `\u001b[?62;c`]);
    await view.detect(router);
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(root?.style.color).toBe(6);

    // `readMedia()` rebuilds the whole context from scratch, so a level the
    // terminal told us about has to survive that or the refinement lasts exactly
    // until the window changes by a column
    h.resize(40, 24);
    view.frame();
    expect(root?.style.color, 'a resize undid what the terminal said').toBe(6);
    view.dispose();
  });

  it('should never raise a level of zero, whatever the terminal says', async () => {
    const h = harness(20, 4);
    let root: Element | undefined;
    const view = render(
      () => {
        root = box({}, text('x'));
        return root;
      },
      {
        backend: h.backend,
        cascade: new Cascade([parseStylesheet(SHEET)]),
        // zero is what `NO_COLOR` and a pipe produce, and a probe that raised it
        // would override a choice the user or the destination already made --
        // the same rule the degrader keeps for a declared palette colour
        colorLevel: 0,
        effects,
        frameMs: 0,
        terminal: h.terminal,
      }
    );

    const { router } = answering([`\u001bP>|Ghostty 1.0.1\u001b\\`, `\u001b[?62;c`]);
    const caps = await view.detect(router);
    expect(caps.colorLevel).toBeUndefined();
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(root?.style.color, 'a level of zero was raised').toBe(-1);
    view.dispose();
  });

  it('should write no query from a renderer that has gone', async () => {
    const h = harness(20, 4);
    const view = render(() => box({}, text('x')), {
      backend: h.backend,
      effects,
      terminal: h.terminal,
    });
    view.dispose();

    const { router, written } = answering([`\u001b[?1;2c`]);
    const caps = await view.detect(router);
    expect(written).toEqual([]);
    expect(caps.responded).toBe(false);
  });
});

describe('a reply that came back to a different screen', () => {
  // `refineColorLevel()` is asked before the await and only ever sees the level
  // that was on screen then. A resize re-reads the environment, so a level that was
  // 2 when the query went out can be 0 -- `NO_COLOR` exported in between -- by the
  // time the reply lands, and a publish that only compared the two would put
  // colour back on a screen that had just been told not to have any
  it('should not raise a level that has since gone to zero', async () => {
    const h = harness(20, 4);
    let root: Element | undefined;
    const view = render(
      () => {
        root = box({}, text('x'));
        return root;
      },
      {
        backend: h.backend,
        cascade: new Cascade([parseStylesheet(`box { color: gray }`)]),
        colorLevel: 0,
        effects,
        frameMs: 0,
        terminal: h.terminal,
      }
    );

    const written: string[] = [];
    const router = {
      query(opts: { write: string }) {
        written.push(opts.write);
        return Promise.resolve(
          [`\u001bP>|Ghostty 1.0.1\u001b\\`, `\u001b[?62;c`]
            .map((it) => parseCapabilityResponse(it))
            .filter((it) => it !== undefined)
        );
      },
    } as never;

    // the floor the probe refines from, as it was before the level moved
    await view.detect(router, { colorLevel: 2 });
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(root?.style.color, 'colour came back on a screen at level zero').toBe(-1);
    view.dispose();
  });
});

describe('learning the background', () => {
  const SHEET = `
    box { color: gray }
    @media (prefers-color-scheme: light) { box { color: blue } }
  `;

  /** Gray for dark, blue for light: the colour that says which half applied. */
  const COLOR = { dark: 8, light: 4 } as const;

  function answering(replies: readonly string[]) {
    return {
      query() {
        return Promise.resolve(
          replies.map((it) => parseCapabilityResponse(it)).filter((it) => it !== undefined)
        );
      },
    } as never;
  }

  /**
   * Mounts and reports which scheme it came up at.
   *
   * Read back rather than assumed, and then answered with the *opposite*: a
   * developer whose `COLORFGBG` says light would otherwise be testing a transition
   * that never happened, which is this repository's own rule about a fixture that
   * depends on the machine it runs on.
   */
  function mount(colorScheme?: 'dark' | 'light') {
    const h = harness(20, 4);
    const cascade = new Cascade([parseStylesheet(SHEET)]);
    let root: Element | undefined;
    const view = render(
      () => {
        root = box({}, text('x'));
        return root;
      },
      {
        backend: h.backend,
        cascade,
        colorLevel: 2,
        ...(colorScheme ? { colorScheme } : {}),
        effects,
        frameMs: 0,
        terminal: h.terminal,
      }
    );
    return {
      at: cascade.media.colorScheme,
      h,
      root: () => root,
      view,
      /** A background whose luminance is on the other side of the midpoint. */
      opposite: cascade.media.colorScheme === 'dark' ? 'rgb:fdfd/f6f6/e3e3' : 'rgb:1c1c/1c1c/1c1c',
      other: cascade.media.colorScheme === 'dark' ? ('light' as const) : ('dark' as const),
    };
  }

  // the half the ticket was written for: env first as the synchronous answer, OSC 11
  // refining it a frame or two later as a media-context change. Sabotage-proofed by
  // asserting that the frame the reply asked for arrives on its own
  it('should restyle when the terminal turns out to be the other way', async () => {
    const m = mount();
    expect(m.root()?.style.color).toBe(COLOR[m.at]);
    const painted = m.h.painted;

    const caps = await m.view.detect(answering([`\u001b]11;${m.opposite}\u0007`, `\u001b[?62;c`]), {
      background: true,
    });
    expect(caps.colorScheme).to.equal(m.other);

    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(m.root()?.style.color, 'the reply was read and then dropped').toBe(COLOR[m.other]);
    expect(m.h.painted, 'nothing repainted').toBeGreaterThan(painted);
    m.view.dispose();
  });

  // unlike the colour level, a named scheme is not overruled by a reply: nothing
  // fills it in on a caller's behalf, so naming one is a statement about what the
  // output is drawn against rather than a guess at the terminal
  it('should let a caller who named a scheme keep it, and not repaint over it', async () => {
    const m = mount('dark');
    const painted = m.h.painted;
    await m.view.detect(answering([`\u001b]11;rgb:ffff/ffff/ffff\u0007`, `\u001b[?62;c`]), {
      background: true,
    });
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(m.root()?.style.color).toBe(COLOR.dark);
    // and no frame was asked for at all: a caller who named one is not asking, so a
    // reply that disagrees is not a change -- publishing anyway is a full re-match
    // and a repaint that change nothing, on every probe, for such an app
    expect(m.h.painted, 'the reply asked for a frame that could change nothing').to.equal(painted);
    m.view.dispose();
  });

  // `readMedia()` rebuilds the context from scratch, so a scheme the terminal told
  // us about has to survive a resize or it lasts until the window moves a column
  it('should keep a learned scheme across a resize', async () => {
    const m = mount();
    await m.view.detect(answering([`\u001b]11;${m.opposite}\u0007`, `\u001b[?62;c`]), {
      background: true,
    });
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(m.root()?.style.color).toBe(COLOR[m.other]);

    m.h.resize(40, 24);
    m.view.frame();
    expect(m.root()?.style.color, 'a resize undid what the terminal said').toBe(COLOR[m.other]);
    m.view.dispose();
  });

  it('should change nothing when the terminal is silent', async () => {
    const m = mount();
    const caps = await m.view.detect(answering([]), { background: true });
    expect(caps.colorScheme).toBeUndefined();
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(m.root()?.style.color).toBe(COLOR[m.at]);
    m.view.dispose();
  });
});

describe('where the scheme comes from', () => {
  /**
   * Four sources, and the order is the whole of the decision.
   *
   * `render()`'s option, then `SIGIL_COLOR_SCHEME`, then an OSC 11 reply, then
   * `COLORFGBG`, then dark. Reading the two variables through one function put the
   * reply *above* the user's override for a commit, because the override was inside
   * the call that sat under the refinement -- which is why the two halves are
   * separate functions and why this test exists.
   */
  const SHEET = `
    box { color: gray }
    @media (prefers-color-scheme: light) { box { color: blue } }
  `;
  const COLOR = { dark: 8, light: 4 } as const;

  function answering(background: string) {
    return {
      query() {
        return Promise.resolve(
          [`\u001b]11;${background}\u0007`, `\u001b[?62;c`]
            .map((it) => parseCapabilityResponse(it))
            .filter((it) => it !== undefined)
        );
      },
    } as never;
  }

  async function schemeOf(
    env: Record<string, string | undefined>,
    opts: { background?: string; colorScheme?: 'dark' | 'light' } = {}
  ) {
    const before = { ...process.env };
    for (const key of ['COLORFGBG', 'SIGIL_COLOR_SCHEME']) {
      delete process.env[key];
    }
    Object.assign(process.env, env);
    try {
      const h = harness(20, 4);
      let root: Element | undefined;
      const view = render(
        () => {
          root = box({}, text('x'));
          return root;
        },
        {
          backend: h.backend,
          cascade: new Cascade([parseStylesheet(SHEET)]),
          colorLevel: 2,
          ...(opts.colorScheme ? { colorScheme: opts.colorScheme } : {}),
          effects,
          frameMs: 0,
          terminal: h.terminal,
        }
      );
      if (opts.background) {
        await view.detect(answering(opts.background), { background: true });
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      const found = root?.style.color === COLOR.light ? 'light' : 'dark';
      view.dispose();
      return found;
    } finally {
      for (const key of ['COLORFGBG', 'SIGIL_COLOR_SCHEME']) {
        delete process.env[key];
      }
      Object.assign(process.env, before);
    }
  }

  const WHITE = 'rgb:ffff/ffff/ffff';
  const BLACK = 'rgb:0000/0000/0000';

  it('should fall back to dark when nothing said', async () => {
    expect(await schemeOf({})).to.equal('dark');
  });

  it('should read COLORFGBG when that is all there is', async () => {
    expect(await schemeOf({ COLORFGBG: '0;15' })).to.equal('light');
  });

  it('should let a reply beat COLORFGBG', async () => {
    expect(await schemeOf({ COLORFGBG: '0;15' }, { background: BLACK })).to.equal('dark');
  });

  // the bug round one found: the reply was above the override rather than below it
  it('should not let a reply beat the user', async () => {
    expect(
      await schemeOf({ COLORFGBG: '0;15', SIGIL_COLOR_SCHEME: 'light' }, { background: BLACK })
    ).to.equal('light');
  });

  it('should let the user beat COLORFGBG', async () => {
    expect(await schemeOf({ COLORFGBG: '15;0', SIGIL_COLOR_SCHEME: 'light' })).to.equal('light');
  });

  // an app that names one may be painting its own background, so it is stating a
  // fact about its output rather than guessing at the terminal
  it('should let the app beat the user and the reply', async () => {
    expect(
      await schemeOf({ SIGIL_COLOR_SCHEME: 'light' }, { background: WHITE, colorScheme: 'dark' })
    ).to.equal('dark');
  });

  /**
   * A reply that *agrees* with what is on screen is still the terminal's answer.
   *
   * Found by review. A reply was recorded only where it differed, so a terminal
   * answering light while `COLORFGBG` already said light left nothing behind -- and
   * the next resize, after that variable had gone, fell through to dark over a
   * terminal that had told us. Which is the shape of the whole ticket: the reply is
   * the truthful source and the variable is the stale one.
   */
  it('should record a reply that agrees, so a lower source cannot replace it', async () => {
    const before = { ...process.env };
    delete process.env.SIGIL_COLOR_SCHEME;
    process.env.COLORFGBG = '0;15';
    try {
      const h = harness(20, 4);
      let root: Element | undefined;
      const view = render(
        () => {
          root = box({}, text('x'));
          return root;
        },
        {
          backend: h.backend,
          cascade: new Cascade([parseStylesheet(SHEET)]),
          colorLevel: 2,
          effects,
          frameMs: 0,
          terminal: h.terminal,
        }
      );
      expect(root?.style.color).toBe(COLOR.light);

      // the terminal agrees with the variable, so nothing on screen moves
      const painted = h.painted;
      await view.detect(answering(WHITE), { background: true });
      await new Promise((resolve) => setTimeout(resolve, 5));
      expect(h.painted, 'a reply that changed nothing asked for a frame').to.equal(painted);

      // and then the variable goes, which is what tmux reattaching looks like
      delete process.env.COLORFGBG;
      h.resize(40, 24);
      view.frame();
      expect(root?.style.color, 'the terminal was overruled by its own absence').toBe(COLOR.light);
      view.dispose();
    } finally {
      delete process.env.COLORFGBG;
      delete process.env.SIGIL_COLOR_SCHEME;
      Object.assign(process.env, before);
    }
  });
});

describe('a canvas that follows what it draws', () => {
  // SIG-130, through the other reader of the same walk. `mountLive()` asks for
  // `width: 'auto'` and names no height, so every spinner, bar, prompt and
  // table reserves the rows `arrangedExtent()` reports -- and a clipped pane
  // used to report the rows nobody can see, so the canvas held three blank rows
  // of the user's scrollback open for the life of the frame
  it('should not reserve rows a clip hides', () => {
    const { terminal } = setup({ columns: 40 });
    const view = render(
      () =>
        box(
          { 'flex-direction': 'column' },
          box(
            { height: 1, overflow: 'hidden', width: 6 },
            box(
              { 'flex-direction': 'column', 'flex-shrink': 0 },
              text('r1'),
              text('r2'),
              text('r3'),
              text('r4')
            )
          )
        ),
      { frameMs: 0, terminal, width: 'auto' }
    );

    expect(view.backend.height).to.equal(1);
    view.dispose();
  });

  // and the second pass still grows it where nothing clips, which is the rule
  // this must not have broken: a row whose description wraps further than it
  // measured is why that pass exists at all
  it('should still reserve rows for overflow nothing clips', () => {
    const { terminal } = setup({ columns: 40 });
    const view = render(
      () =>
        box(
          { 'flex-direction': 'column' },
          box(
            { height: 1, width: 6 },
            box(
              { 'flex-direction': 'column', 'flex-shrink': 0 },
              text('r1'),
              text('r2'),
              text('r3'),
              text('r4')
            )
          )
        ),
      { frameMs: 0, terminal, width: 'auto' }
    );

    expect(view.backend.height).to.equal(4);
    view.dispose();
  });
});

describe('a frame over a windowed list', () => {
  /** A list bounded by the canvas rather than by a height of its own. */
  function loose(count: number): { host: Element; root: Element } {
    const host = ScrollBox({
      props: { 'flex-grow': 1, 'min-height': 0 },
      rows: { count, height: 1, row: (i) => text(`r${i}`, { id: `r${i}` }) },
    });
    return { host, root: box({ 'flex-direction': 'column' }, host) };
  }

  const held = (root: Element): string[] => {
    const out: string[] = [];
    const walk = (at: Element): void => {
      if (at.id?.startsWith('r')) {
        out.push(at.id);
      }
      for (const child of at.children) {
        walk(child);
      }
    };
    walk(root);
    return out;
  };

  it('should rebuild the window when a resize changed the viewport', () => {
    // the defect SIG-132 is filed for, met through the renderer rather than through
    // `renderToString()`: a resize writes no offset, so `onScroll` never fires, and
    // the window a windowed list is holding was built for a viewport that has gone.
    // The frame is what closes it -- `settleResized()` after `layoutInto()`
    const h = harness(12, 10);
    const { root } = loose(500);
    const view = render(() => root, { backend: h.backend, terminal: h.terminal });
    try {
      expect(held(root).length).toBe(10);
      h.resize(12, 40);
      view.frame();
      expect(held(root).length).toBe(40);
      expect(
        h
          .picture()
          .split('\n')
          .filter((line) => line.includes('r'))
      ).toHaveLength(40);
    } finally {
      view.dispose();
    }
  });

  it('should build only what the first frame can show, not the whole list', () => {
    // the second symptom of the one cause: nothing knows the viewport's height
    // before a layout, so a window built for an unknown one used to be every row --
    // ten thousand rows cascaded and arranged for a frame that shows ten
    const h = harness(12, 10);
    const { root } = loose(10_000);
    const view = render(() => root, { backend: h.backend, terminal: h.terminal });
    try {
      expect(held(root)).toStrictEqual(Array.from({ length: 10 }, (_, i) => `r${i}`));
    } finally {
      view.dispose();
    }
  });

  it('should tell an element once per frame rather than once per frame since', () => {
    // the collector is cleared where the layout begins, which for a renderer is the
    // top of `layoutInto()` -- it lays out twice for an auto-height canvas, so the
    // two answers are one answer and the clear cannot sit between them. Left
    // uncleared it grows for the life of the renderer, and every frame asks every
    // element that has ever resized about a box that has not moved
    const h = harness(12, 6);
    let calls = 0;
    const counted = box({ 'flex-shrink': 0, height: 1 }, text('x'));
    counted.onResize = () => {
      calls++;
      return false;
    };
    const view = render(() => box({ 'flex-direction': 'column' }, counted), {
      backend: h.backend,
      terminal: h.terminal,
    });
    try {
      expect(calls, 'the first frame is a change: there was no box and now there is').toBe(1);
      // wider, so the box it stretches to is a different box
      h.resize(13, 6);
      view.frame();
      expect(calls).toBe(2);
      // a third frame that really does lay out -- a resize marks everything, so
      // `layoutInto()` runs -- and moves no box. Left uncleared the set grows for
      // the life of the renderer and every such frame asks everything in it
      h.resize(13, 6);
      view.frame();
      expect(calls, 'a frame that laid out and moved no box tells nothing').toBe(2);
    } finally {
      view.dispose();
    }
  });

  it('should ask the restyler again, or a new window reports the old range', () => {
    // a new window writes the two spacers' heights with `setProp()`, and a kept
    // restyler is marks-driven -- so without draining the marks a second time
    // those two keep the style they had and the content box's extent describes the
    // window that has gone. Measured as exactly that before it was fixed: a range
    // of 500 over a viewport of 8, where it should have been 492
    const h = harness(12, 8);
    const { host, root } = loose(500);
    const view = render(() => root, { backend: h.backend, terminal: h.terminal });
    try {
      const viewport = findIn(host, (e) => e.classes.includes('sigil-scroll-viewport'));
      expect(viewport?.content?.height).toBe(8);
      expect(scrollRange(viewport as Element).y).toBe(492);
    } finally {
      view.dispose();
    }
  });
});

describe('a frame over an element placed by another', () => {
  it('should move it in the frame that scrolled what it follows, before the paint', () => {
    // `onLayout` is dispatched with `onResize`, between the layout and the paint,
    // so a follower placed against a row of a scroll box is drawn beside the row
    // in the very frame the scroll happened in -- the tooltip's case. Hooked on the
    // frame's top instead, it would read the boxes of the layout before the scroll
    // and be drawn a frame late, with nothing asking for the frame that fixes it
    const h = harness(12, 6);
    const rows = Array.from({ length: 10 }, (_, i) => text(`r${i}`));
    const list = ScrollBox({
      children: () => box({ 'flex-direction': 'column' }, ...rows),
      props: { height: 4 },
    });
    const follower = text('<', { left: 6, position: 'fixed', top: 0 });
    follower.onLayout = (it) => {
      const want = rows[3]?.box?.y ?? 0;
      if (it.box?.y === want) {
        return false;
      }
      it.setProp('top', want);
      return true;
    };
    const view = render(() => box({ 'flex-direction': 'column' }, list, follower), {
      backend: h.backend,
      terminal: h.terminal,
    });
    try {
      expect(h.picture().split('\n')[3]).toMatch(/^r3\.*</);
      const viewport = list.children[0]?.children[0] as Element;
      viewport.scrollTo(0, 2);
      const painted = h.painted;
      view.frame();
      expect(h.painted - painted, 'one frame, painted once').toBe(1);
      expect(h.picture().split('\n')[1]).toMatch(/^r3\.*</);
    } finally {
      view.dispose();
    }
  });
});

describe('the settle guard under the frame loop', () => {
  // the frame loop is the scheduler here, a `setTimeout` paced to `frameMs`,
  // which is the one the microtask tests of the guard never ran under
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('should not tear down a renderer whose signal is written faster than a frame', () => {
    // every drain re-arms its watcher before each pass, and a re-arm that finds
    // work announces it -- from inside the flush, so the flush it asked for was
    // counted as *chained*. Under a microtask scheduler that follow-up runs at
    // once, finds nothing, and the chain resets. Under the frame loop it runs a
    // frame later, and a writer faster than a frame has always written again by
    // then -- so every frame was a link, and after a hundred of them the
    // renderer was torn down for a cross-scope cycle that did not exist. A
    // progress bar fed every 5ms went blank after about 3.4 seconds
    const h = harness();
    const n = new State(0);
    const reports: unknown[] = [];
    const view = render(
      () => {
        const label = text('');
        createEffect(() => {
          label.setText(`n=${n.get()}`);
        });
        return box({}, label);
      },
      {
        backend: h.backend,
        effects,
        frameMs: 1000 / 30,
        onError: (error) => void reports.push(error),
        terminal: h.terminal,
      }
    );

    try {
      // ten seconds at a write every 5ms is three hundred frames, three times
      // what the chain bound allows
      const before = h.painted;
      for (let i = 1; i <= 2000; i++) {
        n.set(i);
        vi.advanceTimersByTime(5);
      }
      vi.advanceTimersByTime(100);

      expect(reports).toEqual([]);
      expect(view.mounted).toBe(true);
      expect(h.painted - before).toBeGreaterThan(200);
      expect(h.picture().split('\n')[0]).toBe('n=2000..............');
    } finally {
      view.dispose();
    }
  });

  it('should still report a cycle between the frame loop and another scope', async () => {
    // the other half: what the guard is for has to survive the fix. The
    // renderer's effect writes what a second scope reads and that scope writes
    // back, so each scope's drain settles in a pass and neither reaches its own
    // bound -- only the chain can see it, and it has to under the frame loop too
    const h = harness();
    const a = new State(0);
    const b = new State(0);
    const reports: unknown[] = [];
    const other = createEffects();
    other.setErrorHandler((error) => void reports.push(error));
    const stop = other.effect(() => b.set(a.get() + 1));

    const view = render(
      () => {
        const label = text('');
        createEffect(() => {
          const next = b.get() + 1;
          a.set(next);
          label.setText(`a=${next}`);
        });
        return box({}, label);
      },
      {
        backend: h.backend,
        effects,
        frameMs: 1000 / 30,
        onError: (error) => void reports.push(error),
        terminal: h.terminal,
      }
    );

    try {
      // a hundred and one frames is about 3.4 seconds at thirty a second, and
      // the second scope's flushes are microtasks between them
      await vi.advanceTimersByTimeAsync(10_000);

      expect(reports).toHaveLength(1);
      expect(String(reports[0])).toMatch(/chained flushes/);
    } finally {
      stop();
      view.dispose();
    }
  });
});

describe('a cascade that changes under a mounted tree', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const red = () => parseStylesheet('.field { color: red }');
  const blue = () => parseStylesheet('.field { color: blue }');

  function mountField(cascade: Cascade, h = harness()) {
    let field: Element | undefined;
    const view = render(() => (field = box({ class: 'field' }, text('x'))), {
      backend: h.backend,
      cascade,
      colorLevel: 3,
      effects,
      frameMs: 10,
      terminal: h.terminal,
    });
    return { field: field as unknown as Element, view };
  }

  it('should restyle on its own when a sheet is replaced, with nobody touching the restyler', () => {
    const cascade = new Cascade([red()]);
    const { field, view } = mountField(cascade);
    expect(field.style.color).toBe(1);

    cascade.replace(cascade.sheets[0] as never, blue());
    // a frame is asked for rather than run now, so a swap from inside a handler
    // is safe -- and it arrives by the clock, with no `frame()` call from the caller
    expect(field.style.color).toBe(1);
    vi.advanceTimersByTime(50);
    expect(field.style.color).toBe(4);
    view.dispose();
  });

  it('should restyle for an add and for a remove too', () => {
    const cascade = new Cascade();
    const { field, view } = mountField(cascade);
    const theme = blue();

    cascade.add(theme);
    vi.advanceTimersByTime(50);
    expect(field.style.color).toBe(4);

    cascade.remove(theme);
    vi.advanceTimersByTime(50);
    // nothing left to say it, so the initial value and not the sheet's last word
    expect(field.style.color).toBe(-1);
    view.dispose();
  });

  it('should move the layout when a swapped sheet moves a box', () => {
    const h = harness(12, 2);
    const narrow = parseStylesheet('.field { padding-left: 1 }');
    const wide = parseStylesheet('.field { padding-left: 5 }');
    const cascade = new Cascade([narrow]);
    const { view } = mountField(cascade, h);
    expect(h.picture().split('\n')[0]).toBe('.x..........');

    cascade.replace(narrow, wide);
    vi.advanceTimersByTime(50);
    expect(h.picture().split('\n')[0]).toBe('.....x......');
    view.dispose();
  });

  it('should tell every renderer sharing the cascade, each for its own tree', () => {
    const cascade = new Cascade([red()]);
    const one = mountField(cascade);
    const two = mountField(cascade);

    cascade.replace(cascade.sheets[0] as never, blue());
    vi.advanceTimersByTime(50);
    expect(one.field.style.color).toBe(4);
    expect(two.field.style.color).toBe(4);

    // and one going does not take the other's subscription with it
    one.view.dispose();
    cascade.add(red());
    vi.advanceTimersByTime(50);
    expect(two.field.style.color).toBe(1);
    two.view.dispose();
  });

  it('should let go of the cascade when the renderer goes', () => {
    const cascade = new Cascade([red()]);
    // the guard in the listener makes a leaked subscription invisible from outside,
    // which is what a leak on a *shared* cascade is: the unsubscribe itself is asked
    const real = cascade.onChange.bind(cascade);
    let subscribed = 0;
    let unsubscribed = 0;
    vi.spyOn(cascade, 'onChange').mockImplementation((listener) => {
      subscribed++;
      const off = real(listener);
      return () => {
        unsubscribed++;
        off();
      };
    });
    const { field, view } = mountField(cascade);
    expect(subscribed).toBe(1);
    expect(unsubscribed).toBe(0);
    view.dispose();
    expect(unsubscribed).toBe(1);

    const timers = vi.getTimerCount();
    cascade.add(blue());
    // no frame is asked for by a renderer that is gone, and nothing restyled it
    expect(vi.getTimerCount()).toBe(timers);
    vi.advanceTimersByTime(50);
    expect(field.style.color).toBe(1);
  });
});

describe('a renderer started from an effect', () => {
  // SIG-321. A spinner's `start()` mounts one, and an app calls that from an
  // effect as readily as from anywhere else: nothing the renderer reads on the
  // way is something that effect asked to depend on
  it('should not subscribe the effect to what the component body read', () => {
    const h = harness();
    const label = new State('a');
    let view: ReturnType<typeof render> | undefined;

    expect(
      runsOf(
        () => {
          view = render(() => text(label.get()), {
            backend: h.backend,
            effects,
            terminal: h.terminal,
          });
        },
        () => label.set('b')
      )
    ).toBe(2);
    view?.dispose();
  });

  it('should not subscribe the effect to what an onMount read on the first frame', () => {
    // `render()` paints the first frame before it returns, and the mount
    // callbacks are drained in it
    const h = harness();
    const label = new State('a');
    let view: ReturnType<typeof render> | undefined;

    expect(
      runsOf(
        () => {
          view = render(
            () => {
              onMount(() => label.get());
              return text('x');
            },
            { backend: h.backend, effects, terminal: h.terminal }
          );
        },
        () => label.set('b')
      )
    ).toBe(2);
    view?.dispose();
  });

  it('should not subscribe an effect that called frame() to what a frame handler read', () => {
    const h = harness();
    const label = new State('a');
    const view = render(() => text('x'), { backend: h.backend, effects, terminal: h.terminal });
    view.onFrame(() => label.get());

    expect(
      runsOf(
        () => view.frame(),
        () => label.set('b')
      )
    ).toBe(2);
    view.dispose();
  });

  it('should keep its effects when the effect that started it runs again', () => {
    // the other half of the ticket: an effect created while another's body runs
    // is that body's child and dies when it re-runs, unless something says
    // otherwise. The root says otherwise, so a spinner started from an effect
    // goes on following its own state after that effect has run again
    const h = harness();
    const pass = new State(0);
    const count = new State(0);
    const seen: number[] = [];
    let view: ReturnType<typeof render> | undefined;

    const stop = effect(() => {
      pass.get();
      view ??= render(
        () => {
          createEffect(() => {
            seen.push(count.get());
          });
          return text('x');
        },
        { backend: h.backend, effects, terminal: h.terminal }
      );
    });
    pass.set(1);
    flush();

    count.set(1);
    view?.frame();

    expect(seen).to.deep.equal([0, 1]);
    stop();
    view?.dispose();
  });
});
