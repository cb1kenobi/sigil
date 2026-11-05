import { createSinkCanvas } from '../../src/canvas/index.js';
import { box, type Element, text } from '../../src/element/index.js';
import { type App, AppContext, runApp, useApp } from '../../src/renderer/app.js';
import { createEffect, onMount, useContext } from '../../src/renderer/index.js';
import { State } from '../../src/signals/index.js';
import { createTestTerminal, ctrl, KEYS, tick } from '../../src/testing/index.js';
import { afterEach, describe, expect, it } from 'vitest';

/**
 * `runApp()`: the seven steps every interactive program used to write by hand,
 * driven through the testing terminal -- which is the seam an example's smoke
 * test uses, so these double as the proof that one can be written.
 *
 * `detect: false` throughout, except where the probe is what is being asked
 * about: a query nobody answers waits out its deadline, and a test that is not
 * about the probe has no reason to write one.
 */

const apps: App[] = [];

/** Runs an app over a test terminal, remembering it so a failed test still ends it. */
function start(component: () => Element, opts: Parameters<typeof runApp>[1] = {}) {
  const term = createTestTerminal({ columns: 30, rows: 6 });
  const app = runApp(component, { detect: false, terminal: term.terminal, ...opts });
  apps.push(app);
  return { app, term };
}

afterEach(async () => {
  for (const app of apps.splice(0)) {
    app.exit();
    await app.exited;
  }
  process.exitCode = undefined;
});

describe('runApp()', () => {
  it('should draw on the alternate screen and give the screen back when Ctrl-C ends it', async () => {
    const { app, term } = start(() => text('hello app'));
    app.view.frame();

    expect(term.screen.alternate).toBe(true);
    expect(term.viewport[0]).toBe('hello app');
    expect(term.stdin.rawMode).toBe(true);
    expect(app.interactive).toBe(true);

    await term.press(ctrl('c'));
    await app.exited;

    expect(app.running).toBe(false);
    expect(term.screen.alternate).toBe(false);
    expect(term.stdin.rawMode).toBe(false);
    expect(app.view.mounted).toBe(false);
  });

  it('should end on Ctrl-D too, which is the rest of isAbort()', async () => {
    const { app, term } = start(() => text('x'));
    await term.press(ctrl('d'));
    await app.exited;
    expect(app.running).toBe(false);
  });

  it('should hand the component the router while its body is still running', () => {
    let seen: App | undefined;
    let ring: Element[] = [];
    const row = text('row', { focusable: true });
    const { app } = start(() => {
      seen = useApp();
      // the router exists at build time, which is the whole reason the host is
      // built before the component: a control can ask for the ring in its body
      ring = [...(seen.input?.focus.ring() ?? [])];
      return box({}, row);
    });

    expect(seen).toBe(app);
    expect(seen?.input).toBeDefined();
    expect(seen?.input).toBe(app.input);
    // empty while building -- the row is not in the tree yet -- and there after
    expect(ring).toEqual([]);
    expect(app.input?.focus.ring()).toEqual([row]);
  });

  it('should settle exited with the value exit() was given, once', async () => {
    const { app } = start(() => text('x'));
    const typed = app as App<string>;
    typed.exit('first');
    typed.exit('second');
    await expect(typed.exited).resolves.toBe('first');
  });

  it('should see the quit key before a focused element that claims every key', async () => {
    const row = text('greedy', { focusable: true });
    const claimed: string[] = [];
    row.onKey = (event) => {
      claimed.push(event.key.name);
      event.stop();
    };
    const { app, term } = start(() => box({}, row));
    app.input?.focus.focus(row);

    await term.press('a');
    await term.press(ctrl('c'));
    await app.exited;

    expect(claimed).toEqual(['a']);
    expect(app.running).toBe(false);
  });

  it('should leave Ctrl-C to the app when quit is false', async () => {
    const { app, term } = start(() => text('x'), { quit: false });
    await term.press(ctrl('c'));
    await tick();
    expect(app.running).toBe(true);
  });

  it('should take a quit key of the caller choosing', async () => {
    const { app, term } = start(() => text('x'), { quit: (key) => key.name === 'q' });
    await term.press(ctrl('c'));
    await tick();
    expect(app.running).toBe(true);
    await term.press('q');
    await app.exited;
    expect(app.running).toBe(false);
  });

  it('should end when the renderer is disposed from a handler', async () => {
    const { app } = start(() => text('x'));
    app.view.dispose();
    await app.exited;
    expect(app.running).toBe(false);
  });

  it('should end when stdin ends, since nobody is left to type', async () => {
    const { app, term } = start(() => text('x'));
    term.stdin.end();
    await app.exited;
    expect(app.running).toBe(false);
  });

  it('should end when a frame fails, with the terminal back before the error is reported', async () => {
    const boom = new State(false);
    const reports: Array<{ alternate: boolean; error: unknown; raw: boolean }> = [];
    const { app, term } = start(
      () => {
        const label = text('');
        createEffect(() => {
          if (boom.get()) {
            throw new Error('frame broke');
          }
          label.setText('fine');
        });
        return label;
      },
      {
        onError: (error) =>
          reports.push({ alternate: term.screen.alternate, error, raw: term.stdin.rawMode }),
      }
    );
    app.view.frame();
    expect(term.screen.alternate).toBe(true);

    boom.set(true);
    app.view.frame();
    await app.exited;

    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({ alternate: false, raw: false });
    expect(String(reports[0]?.error)).toContain('frame broke');
    expect(term.screen.alternate).toBe(false);
    expect(term.stdin.rawMode).toBe(false);
    expect(app.running).toBe(false);
  });

  it('should give the terminal back and rethrow when the component body throws', () => {
    const term = createTestTerminal({ columns: 30, rows: 6 });
    expect(() =>
      runApp(
        () => {
          throw new Error('body broke');
        },
        { detect: false, terminal: term.terminal }
      )
    ).toThrow('body broke');
    expect(term.stdin.rawMode).toBe(false);
    expect(term.screen.alternate).toBe(false);
  });

  it('should write an error reported while it owns the screen once the screen is back', async () => {
    const { app, term } = start(() => {
      onMount(() => {
        throw new Error('mount broke');
      });
      return text('still up');
    });
    app.view.frame();

    // a mount that throws is reported and the app stays up, so the line waits
    // for the main screen rather than being drawn into the middle of a frame
    expect(app.running).toBe(true);
    expect(term.viewport[0]).toBe('still up');
    expect(term.lines.join('\n')).not.toContain('mount broke');

    app.exit();
    await app.exited;
    expect(term.screen.alternate).toBe(false);
    expect(term.lines.join('\n')).toContain('mount broke');
    expect(process.exitCode).toBe(1);
  });

  it('should draw one inline frame and end at once when nobody can type', async () => {
    const term = createTestTerminal({ columns: 30, inputTTY: false, rows: 6 });
    const app = runApp(() => box({ 'flex-direction': 'column' }, text('one'), text('two')), {
      terminal: term.terminal,
    });
    await app.exited;

    expect(app.interactive).toBe(false);
    expect(app.input).toBeUndefined();
    expect(term.screen.alternate).toBe(false);
    expect(term.output).not.toContain('\u001b[?1049h');
    expect(term.lines).toEqual(['one', 'two']);
  });

  it('should draw inline under the log, following its content, with fullscreen false', async () => {
    const { app, term } = start(() => text('inline row'), { fullscreen: false });
    app.view.frame();
    expect(term.screen.alternate).toBe(false);
    expect(term.lines).toEqual(['inline row']);
    expect(app.view.backend.height).toBe(1);

    app.exit();
    await app.exited;
    // and the last frame is left in the log, which is what inline is for
    expect(term.lines).toEqual(['inline row']);
  });

  it("should style through the app's sheets", () => {
    const { app, term } = start(
      () => box({ 'flex-direction': 'column' }, text('shown'), text('gone', { class: 'gone' })),
      { sheets: ['.gone { display: none }'] }
    );
    app.view.frame();
    expect(term.viewport.slice(0, 2)).toEqual(['shown', '']);
  });

  it('should draw through the framework sheet, under the app sheets', () => {
    const muted = text('quiet', { class: 'sigil-muted' });
    const loud = text('loud', { class: 'sigil-muted' });
    // at a colour level, because level 0 drops every attribute at resolve time
    const { app } = start(() => box({}, muted, box({ class: 'loud' }, loud)), {
      colorLevel: 1,
      sheets: ['.loud .sigil-muted { dim: false }'],
    });
    app.view.frame();
    // the framework's role, which a bare `render()` would not have applied
    expect(muted.style.dim).toBe(true);
    // and the app's own sheet beats it
    expect(loud.style.dim).toBe(false);
  });

  it('should give a root with no size of its own the whole width, as a block would', () => {
    const { app, term } = start(() => box({ border: 'ascii' }, text('x')));
    app.view.frame();
    expect(term.viewport[0]).toBe(`+${'-'.repeat(28)}+`);
  });

  it('should fill the screen with a root that grows', () => {
    const { app, term } = start(() => box({ border: 'ascii', 'flex-grow': 1 }, text('x')));
    app.view.frame();
    expect(term.viewport[5]).toBe(`+${'-'.repeat(28)}+`);
  });

  it('should quit on Ctrl-C ahead of a binding the component made that takes every key', async () => {
    const { app, term } = start(() => {
      useApp().input?.bind((event) => event.stop());
      return text('x');
    });
    await term.press(ctrl('c'));
    await app.exited;
    expect(app.running).toBe(false);
  });

  it('should leave nothing on the main screen when an effect exits in the middle of a frame', async () => {
    const leave = new State(false);
    const { app, term } = start(() => {
      const label = text('drawn on the alternate screen');
      createEffect(() => {
        if (leave.get()) {
          useApp().exit();
        }
      });
      return label;
    });
    app.view.frame();
    leave.set(true);
    app.view.frame();
    await app.exited;

    expect(term.screen.alternate).toBe(false);
    expect(term.lines).toEqual([]);
  });

  it('should deliver a click to the element under it with mouse on', async () => {
    const clicks: string[] = [];
    const button = text('press', { focusable: true });
    button.onMouse = (event) => {
      if (event.kind === 'click') {
        clicks.push(`${event.x},${event.y}`);
      }
    };
    const { app, term } = start(() => box({}, button), { mouse: true });
    app.view.frame();

    // column 2 row 1, one-based, is cell 1,0 -- inside `press`
    await term.press('\u001b[<0;2;1M', '\u001b[<0;2;1m');
    expect(clicks).toEqual(['1,0']);
  });

  it('should take a backend of the caller choosing', () => {
    const term = createTestTerminal({ columns: 30, rows: 6 });
    const backend = createSinkCanvas({ terminal: term.terminal });
    const app = runApp(() => text('nowhere'), { backend, detect: false, terminal: term.terminal });
    apps.push(app);
    app.view.frame();
    expect(app.view.backend).toBe(backend);
    expect(term.lines.join('')).not.toContain('nowhere');
  });

  it('should ask the terminal what it is by default, and not wait for it to exit', async () => {
    const term = createTestTerminal({ columns: 30, rows: 6 });
    const app = runApp(() => text('x'), { terminal: term.terminal });
    apps.push(app);
    await tick();
    // primary device attributes, the query every probe ends on
    expect(term.output).toContain('\u001b[c');
    app.exit();
    await app.exited;
    expect(app.running).toBe(false);
  });

  it('should refuse to answer view while the component is being built', () => {
    let thrown: unknown;
    start(() => {
      try {
        void useApp().view;
      } catch (error) {
        thrown = error;
      }
      return text('x');
    });
    expect((thrown as Error).message).toMatch(/onMount/);
  });
});

describe('the README example', () => {
  it('should run as written, and settle with what Enter saved', async () => {
    function App() {
      const app = useApp();
      app.input?.bind((event) => {
        if (event.key.name === 'enter') {
          event.stop();
          app.exit('saved');
        }
      });
      return box({ 'flex-grow': 1 }, text('Enter saves, Ctrl-C quits'));
    }

    const term = createTestTerminal({ columns: 40, rows: 10 });
    const app = runApp(App, { detect: false, terminal: term.terminal });
    apps.push(app);
    app.view.frame();
    expect(term.viewport[0]).toContain('Enter saves');
    await term.press(KEYS.enter);
    expect(await app.exited).toBe('saved');
  });
});

describe('useApp()', () => {
  it('should throw outside runApp(), where AppContext reads undefined', () => {
    expect(() => useApp()).toThrow(/outside runApp/);
    expect(useContext(AppContext)).toBeUndefined();
  });
});
