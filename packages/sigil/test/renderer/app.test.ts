import { createSinkCanvas } from '../../src/canvas/index.js';
import { box, type Element, text } from '../../src/element/index.js';
import { type App, AppContext, runApp, useApp } from '../../src/renderer/app.js';
import { createEffect, onCleanup, onMount, useContext } from '../../src/renderer/index.js';
import { State } from '../../src/signals/index.js';
import { createTestTerminal, ctrl, KEYS, tick } from '../../src/testing/index.js';
import { afterEach, describe, expect, it, vi } from 'vitest';

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
  it('should draw on the alternate screen and give the screen back when Ctrl-C ends it, with 130', async () => {
    const { app, term } = start(() => text('hello app'));
    app.view.frame();

    expect(term.screen.alternate).toBe(true);
    expect(term.viewport[0]).toBe('hello app');
    expect(term.stdin.rawMode).toBe(true);
    expect(app.interactive).toBe(true);

    await term.press(ctrl('c'));
    // what a shell reports for a program Ctrl-C interrupted
    expect(await app.exited).toBe(130);

    expect(app.running).toBe(false);
    expect(term.screen.alternate).toBe(false);
    expect(term.stdin.rawMode).toBe(false);
    expect(app.view.mounted).toBe(false);
    // and stdin is let go of, which is what lets the process end: raw mode alone
    // comes back through `restore()`, but a `data` listener holds the loop open
    expect(term.stdin.listenerCount('data')).toBe(0);
  });

  it('should end on Ctrl-D too, which is the rest of isAbort()', async () => {
    const { app, term } = start(() => text('x'));
    await term.press(ctrl('d'));
    expect(await app.exited).toBe(130);
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

  it('should settle exited with the code exit() was given, once', async () => {
    const { app } = start(() => text('x'));
    app.exit(3);
    app.exit(4);
    expect(await app.exited).toBe(3);
  });

  it('should settle exited with 0 for an exit() given no code', async () => {
    const { app } = start(() => text('x'));
    app.exit();
    expect(await app.exited).toBe(0);
  });

  it('should touch neither process.exitCode nor process.exit()', async () => {
    const quit = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    try {
      const { app } = start(() => text('x'));
      app.exit(7);
      expect(await app.exited).toBe(7);
      expect(process.exitCode).toBeUndefined();
      expect(quit).not.toHaveBeenCalled();
    } finally {
      quit.mockRestore();
    }
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
    // the app ending itself, which is a clean exit
    expect(await app.exited).toBe(0);
    expect(app.running).toBe(false);
  });

  it('should end with 129 when stdin ends, which is a terminal hanging up', async () => {
    const { app, term } = start(() => text('x'));
    term.stdin.end();
    expect(await app.exited).toBe(129);
    expect(app.running).toBe(false);
  });

  it('should end with 1 when stdin ends in an error', async () => {
    const { app, term } = start(() => text('x'));
    term.stdin.destroy(new Error('stdin broke'));
    expect(await app.exited).toBe(1);
  });

  it('should report the error stdin ended in, once the screen is back, rather than dropping it', async () => {
    const { app, term } = start(() => text('x'));
    app.view.frame();
    term.stdin.destroy(new Error('stdin broke'));
    expect(await app.exited).toBe(1);
    expect(term.screen.alternate).toBe(false);
    // written once, on the main screen: the backend held it while the app owned
    // the screen, the way it holds every other failure's line
    expect(term.lines.join('\n')).toContain('stdin broke');
    expect(term.output.split('stdin broke')).toHaveLength(2);
  });

  it('should hand the error stdin ended in to onError', async () => {
    const reports: unknown[] = [];
    const { app, term } = start(() => text('x'), { onError: (error) => reports.push(error) });
    term.stdin.destroy(new Error('stdin broke'));
    expect(await app.exited).toBe(1);
    expect(reports.map(String)).toEqual(['Error: stdin broke']);
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
    expect(await app.exited).toBe(1);

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
    expect(term.stdin.listenerCount('data')).toBe(0);
    expect(term.screen.alternate).toBe(false);
  });

  it.each([
    ['', false],
    [' after exit() was called', true],
  ])(
    'should settle exited with 1 when the component body throws%s, rather than leaving it pending',
    async (_, exitFirst) => {
      const term = createTestTerminal({ columns: 30, rows: 6 });
      let held: App | undefined;
      expect(() =>
        runApp(
          () => {
            held = useApp();
            if (exitFirst) {
              held.exit(4);
            }
            throw new Error('body broke');
          },
          { detect: false, mouse: { motion: true }, terminal: term.terminal }
        )
      ).toThrow('body broke');
      // the handle `useApp()` gave the body is one a caller can keep, and the app
      // failed -- so 1, whatever code the body asked for before it threw
      const settled = await Promise.race([held?.exited, tick(20).then(() => 'pending')]);
      expect(settled).toBe(1);
      expect(held?.running).toBe(false);
      // and the router is let go of with everything it turned on: listeners, raw
      // mode and the mouse tracking a shell would otherwise go on receiving
      for (const event of ['data', 'end', 'error']) {
        expect(term.stdin.listenerCount(event)).toBe(0);
      }
      expect(term.stdin.rawMode).toBe(false);
      expect(term.output).toContain('\u001b[?1003l');
      expect(term.output).toContain('\u001b[?1006l');
    }
  );

  it('should drop every resize subscription when a stylesheet fails to parse', () => {
    const term = createTestTerminal({ columns: 30, rows: 6 });
    // counted at the terminal, which is what both the router and a full-screen
    // canvas subscribe through -- and the canvas does it the moment it is built
    const live = new Set<object>();
    const onResize = term.terminal.onResize.bind(term.terminal);
    term.terminal.onResize = (handler) => {
      const token = {};
      live.add(token);
      const off = onResize(handler);
      return () => {
        live.delete(token);
        off();
      };
    };
    expect(() =>
      runApp(() => text('x'), { detect: false, sheets: ['/*'], terminal: term.terminal })
    ).toThrow(/unterminated comment/);
    expect(live.size).toBe(0);
    expect(term.stdin.rawMode).toBe(false);
    expect(term.stdin.listenerCount('data')).toBe(0);
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
    // survived, so the app ended itself; and the exit code is the app's to set
    expect(await app.exited).toBe(0);
    expect(term.screen.alternate).toBe(false);
    expect(term.lines.join('\n')).toContain('mount broke');
    expect(process.exitCode).toBeUndefined();
  });

  it('should hold an error reported after it started until the screen is back', async () => {
    const { app, term } = start(() => text('still up'));
    let thrown = false;
    app.view.onFrame(() => {
      if (!thrown) {
        thrown = true;
        throw new Error('frame handler broke');
      }
    });
    app.view.invalidate();
    app.view.frame();

    expect(app.running).toBe(true);
    expect(term.viewport.join('\n')).not.toContain('frame handler broke');

    app.exit();
    await app.exited;
    expect(term.lines.join('\n')).toContain('frame handler broke');
  });

  it('should end cleanly when exit() is called while the component is still being built', async () => {
    const { app, term } = start(() => {
      useApp().exit(4);
      return text('never shown for long');
    });
    expect(await app.exited).toBe(4);
    expect(app.view.mounted).toBe(false);
    expect(term.screen.alternate).toBe(false);
    expect(term.stdin.rawMode).toBe(false);
  });

  it('should put back a cursor the app hid itself, which no backend owes', async () => {
    const { app, term } = start(() => {
      useApp().terminal.hideCursor();
      return text('x');
    });
    app.exit();
    await app.exited;
    const out = term.output;
    expect(out.lastIndexOf('\u001b[?25h')).toBeGreaterThan(out.lastIndexOf('\u001b[?25l'));
  });

  it('should not ask for bracketed paste with paste false', async () => {
    const { term } = start(() => text('x'), { paste: false });
    await tick();
    expect(term.output).not.toContain('\u001b[?2004h');
  });

  it.each([
    ['stdin is not a terminal', { inputTTY: false }, {}],
    ['the output is not a terminal', { isTTY: false }, {}],
    ['it was asked to draw inline', { inputTTY: false }, { fullscreen: false }],
  ] as const)(
    'should refuse with one line and 1, drawing nothing, when %s',
    async (_, terminalOpts, appOpts) => {
      const term = createTestTerminal({ columns: 30, rows: 6, ...terminalOpts });
      let built = false;
      const app = runApp(
        () => {
          built = true;
          return text('a frame nobody asked for');
        },
        { terminal: term.terminal, ...appOpts }
      );

      expect(await app.exited).toBe(1);
      expect(built).toBe(false);
      expect(app.interactive).toBe(false);
      expect(app.running).toBe(false);
      expect(app.input).toBeUndefined();
      expect(() => app.view).toThrow(/refused/);
      expect(term.stdin.rawMode).toBe(false);
      // nothing drawn: no alternate screen, no cursor hidden, no frame -- and one
      // line, which went to stderr (the test terminal's one stream holds both)
      expect(term.output).not.toContain('\u001b[?1049h');
      expect(term.output).not.toContain('\u001b[?25l');
      expect(term.output).not.toContain('a frame nobody asked for');
      expect(term.output).toMatch(
        /^Error: Cannot run an app because stdin or the output is not a terminal[^\n]*\n$/
      );
      expect(process.exitCode).toBeUndefined();
    }
  );

  it('should write the refusal to stderr and nothing to stdout', async () => {
    const out: string[] = [];
    const err: string[] = [];
    const { createTerminal } = await import('../../src/terminal/index.js');
    const proc = { listenerCount: () => 0, on: () => {}, removeListener: () => {} };
    const terminal = createTerminal({
      isTTY: false,
      proc,
      stderr: { write: (chunk: string) => err.push(chunk) > 0 },
      stdout: { write: (chunk: string) => out.push(chunk) > 0 },
    });
    const app = runApp(() => text('x'), { terminal });
    expect(await app.exited).toBe(1);
    expect(out).toEqual([]);
    expect(err.join('')).toMatch(/^Error: Cannot run an app because .*\n$/);
    expect(err.join('').split('\n')).toHaveLength(2);
  });

  it('should end with 1 after a failed frame reported through the default onError', async () => {
    const boom = new State(false);
    const { app, term } = start(() => {
      const label = text('');
      createEffect(() => {
        if (boom.get()) {
          throw new Error('frame broke by default');
        }
        label.setText('fine');
      });
      return label;
    });
    app.view.frame();
    boom.set(true);
    app.view.frame();

    expect(await app.exited).toBe(1);
    expect(term.lines.join('\n')).toContain('frame broke by default');
    expect(process.exitCode).toBeUndefined();
  });

  it('should end with 1 when the first frame fails inside runApp()', async () => {
    // a resize handler runs inside the first frame's layout, and `render()` paints
    // that frame before it returns -- so the failure is reported before there is a
    // renderer to ask whether it is still mounted
    const reports: unknown[] = [];
    const { app, term } = start(
      () => {
        const label = text('x');
        label.onResize = () => {
          throw new Error('first frame broke');
        };
        return label;
      },
      { onError: (error) => reports.push(error) }
    );

    expect(app.view.mounted).toBe(false);
    expect(await app.exited).toBe(1);
    expect(reports).toHaveLength(1);
    expect(term.screen.alternate).toBe(false);
  });

  it('should settle exited with 1 when the first frame fails after exit(0) was latched in the body', async () => {
    // `exit()` from the body defers its teardown so that the first frame still
    // runs -- and that frame can fail, which is a crash rather than the success
    // the body asked for
    const reports: unknown[] = [];
    const { app, term } = start(
      () => {
        useApp().exit(0);
        const label = text('x');
        label.onResize = () => {
          throw new Error('first frame broke');
        };
        return label;
      },
      { onError: (error) => reports.push(error) }
    );
    expect(await app.exited).toBe(1);
    expect(reports.map(String)).toEqual(['Error: first frame broke']);
    expect(term.screen.alternate).toBe(false);
  });

  it('should settle exited with 1 when a later frame fails after exit() was latched in it', async () => {
    const go = new State(false);
    const reports: unknown[] = [];
    const { app } = start(
      () => {
        const held = useApp();
        createEffect(() => {
          if (go.get()) {
            held.exit(0);
          }
        });
        createEffect(() => {
          if (go.get()) {
            throw new Error('frame broke after exit');
          }
        });
        return text('x');
      },
      { onError: (error) => reports.push(error) }
    );
    app.view.frame();
    go.set(true);
    app.view.frame();
    expect(await app.exited).toBe(1);
    expect(reports.map(String)).toEqual(['Error: frame broke after exit']);
  });

  it('should keep the code exit() chose when a cleanup throws on the way out', async () => {
    const reports: unknown[] = [];
    const { app } = start(
      () => {
        onCleanup(() => {
          throw new Error('cleanup broke');
        });
        return text('x');
      },
      { onError: (error) => reports.push(error) }
    );
    app.exit(3);
    // the app was already going by an exit that chose its code; a cleanup that
    // throws on the way is reported, and is not the failure that ended it
    expect(await app.exited).toBe(3);
    expect(reports.map(String)).toEqual(['Error: cleanup broke']);
  });

  it('should settle exited with 0 when a cleanup throws during a view.dispose() the app called', async () => {
    const { app, term } = start(() => {
      onCleanup(() => {
        throw new Error('cleanup on dispose');
      });
      return text('x');
    });
    app.view.frame();
    // read inside the unmount, which is when the runner's own handler runs
    const seen: boolean[] = [];
    app.view.onDispose(() => seen.push(app.view.failed));
    app.view.dispose();
    expect(seen).toEqual([false]);
    // an unmount the app's own code asked for is as intentional as `exit()`, so
    // its cleanup throwing is reported -- once, on the main screen -- and does not
    // turn the app ending itself into a failure
    expect(await app.exited).toBe(0);
    expect(term.screen.alternate).toBe(false);
    expect(term.lines.join('\n')).toContain('cleanup on dispose');
    expect(term.output.split('cleanup on dispose')).toHaveLength(2);
  });

  it('should settle exited with 1 when stdin errors after exit() latched a code, before the teardown', async () => {
    const reports: unknown[] = [];
    const { app, term } = start(() => text('x'), { onError: (error) => reports.push(error) });
    app.exit(0);
    // in the same turn, so the listener is still there and the teardown is not
    term.stdin.emit('error', new Error('stdin broke after exit'));
    expect(await app.exited).toBe(1);
    expect(reports.map(String)).toEqual(['Error: stdin broke after exit']);
  });

  it('should report, not crash on, the error stdin was destroyed with after exit() latched a code', async () => {
    const { app, term } = start(() => text('x'));
    app.view.frame();
    app.exit(0);
    // `destroy(err)` emits a tick later, which is after the teardown's microtask
    // has taken the router's listener off -- an `'error'` nobody listens for is
    // an uncaught exception, on the way out of a quit the app handled
    term.stdin.destroy(new Error('late stdin'));
    expect(await app.exited).toBe(1);
    expect(term.screen.alternate).toBe(false);
    // the event is still on its way, and something is there to take it
    expect(term.stdin.listenerCount('error')).toBe(1);
    await tick();
    // and it took itself off with it
    expect(term.stdin.listenerCount('error')).toBe(0);
    expect(term.lines.join('\n')).toContain('late stdin');
    expect(term.output.split('late stdin')).toHaveLength(2);
  });

  it.each([
    ['after the emit', true],
    ['before the emit, in the same turn', false],
  ])(
    'should let the next app over a stdin that failed under the last one choose its own code, started %s',
    async (_, afterTick) => {
      const term = createTestTerminal({ columns: 30, rows: 6 });
      const first = runApp(() => text('first'), { detect: false, terminal: term.terminal });
      first.exit(0);
      term.stdin.destroy(new Error('old stdin'));
      expect(await first.exited).toBe(1);
      if (afterTick) {
        await tick();
      }

      // the stream still carries `errored`, which is history to a router that was
      // not listening when it failed: claiming it re-reported an error that ended
      // somebody else, beat this app's own 0, and left a guard for an emit that
      // was not coming again
      const reports: unknown[] = [];
      const next = runApp(() => text('next'), {
        detect: false,
        onError: (error) => reports.push(error),
        terminal: term.terminal,
      });
      apps.push(next);
      next.exit(0);
      expect(await next.exited).toBe(0);
      expect(reports).toEqual([]);
      // one guard at most -- the first app's, while its emit is still to come
      expect(term.stdin.listenerCount('error')).toBe(afterTick ? 0 : 1);
      await tick();
      expect(term.stdin.listenerCount('error')).toBe(0);
    }
  );

  it('should report each error several throwing onEnd handlers threw during the teardown, once', async () => {
    const reports: unknown[] = [];
    const { app, term } = start(() => text('x'), { onError: (error) => reports.push(error) });
    app.input?.onEnd(() => {
      throw new Error('handler one');
    });
    app.input?.onEnd(() => {
      throw new Error('handler two');
    });
    app.exit(0);
    term.stdin.destroy(new Error('late stdin'));
    expect(await app.exited).toBe(1);
    // the router's aggregate opened up: each as itself, rather than one line
    // saying that handlers threw
    expect(reports.map(String)).toEqual([
      'Error: late stdin',
      'Error: handler one',
      'Error: handler two',
    ]);
  });

  it('should not crash when an app starts between a stdin destroy and its emit, and exits', async () => {
    const term = createTestTerminal({ columns: 30, rows: 6 });
    term.stdin.destroy(new Error('gap'));
    // the only router there will be, attached after `errored` was set and before
    // the emit: its teardown takes the emit's only listener off
    const reports: unknown[] = [];
    const app = runApp(() => text('x'), {
      detect: false,
      onError: (error) => reports.push(error),
      terminal: term.terminal,
    });
    apps.push(app);
    app.exit(0);
    // a failure from before it started, so it chooses its own code
    expect(await app.exited).toBe(0);
    expect(reports).toEqual([]);
    expect(term.stdin.listenerCount('error')).toBe(1);
    await tick();
    expect(term.stdin.listenerCount('error')).toBe(0);
  });

  it("should settle exited when an onEnd handler of the app's own throws during the teardown", async () => {
    const reports: unknown[] = [];
    const { app, term } = start(() => text('x'), { onError: (error) => reports.push(error) });
    app.input?.onEnd(() => {
      throw new Error('handler broke');
    });
    app.exit(0);
    // told from inside `stop()`, which is inside the teardown: a throw there cut
    // the teardown short before `restore()` and before `exited` settled
    term.stdin.destroy(new Error('late stdin'));
    const settled = await Promise.race([app.exited, tick(20).then(() => 'pending')]);
    expect(settled).toBe(1);
    expect(reports.map(String)).toEqual(['Error: late stdin', 'Error: handler broke']);
    expect(term.screen.alternate).toBe(false);
    expect(term.stdin.rawMode).toBe(false);
    expect(app.running).toBe(false);
  });

  it.each([
    [
      'the body',
      () => {
        useApp().exit(0);
        return text('gone');
      },
    ],
    [
      "the first frame's onMount",
      () => {
        const app = useApp();
        onMount(() => app.exit(0));
        return text('gone');
      },
    ],
  ])('should not probe the terminal for an app %s already ended', async (_, component) => {
    const term = createTestTerminal({ columns: 30, rows: 6 });
    const written: string[] = [];
    const write = term.terminal.write.bind(term.terminal);
    term.terminal.write = (chunk) => {
      written.push(String(chunk));
      return write(chunk);
    };
    const app = runApp(component, { terminal: term.terminal });
    apps.push(app);
    expect(await app.exited).toBe(0);
    await tick();
    // neither XTVERSION nor the DA1 every probe ends on: a reply would come back
    // on a stdin nobody reads any more, and land in the shell
    expect(written.join('')).not.toContain('\u001b[>q');
    expect(written.join('')).not.toContain('\u001b[c');
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

  it('should keep a root that grows on the screen when its content is taller than the screen', () => {
    // a flex item's automatic minimum is its content, so without the host's rule
    // the root is twelve rows tall on a six-row screen and its bottom edge is
    // drawn nowhere -- the trap the system monitor walked into with 18 cores
    const lines = Array.from({ length: 10 }, (_, i) => text(`line ${i}`));
    const { app, term } = start(() =>
      box(
        { border: 'ascii', 'flex-direction': 'column', 'flex-grow': 1, overflow: 'hidden' },
        ...lines
      )
    );
    app.view.frame();
    expect(term.viewport[5]).toBe(`+${'-'.repeat(28)}+`);
  });

  it('should let the app sheets give the root a minimum of their own', () => {
    const lines = Array.from({ length: 10 }, (_, i) => text(`line ${i}`));
    const { app, term } = start(
      () =>
        box(
          { border: 'ascii', class: 'root', 'flex-direction': 'column', 'flex-grow': 1 },
          ...lines
        ),
      { sheets: ['.root { min-height: auto }'] }
    );
    app.view.frame();
    // the author asked for the content minimum back, so the bottom edge is off screen
    expect(term.viewport[5]).toBe(`|line 4${' '.repeat(22)}|`);
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
  it('should run as written, and settle with 0 when Enter ends it', async () => {
    function App() {
      const app = useApp();
      app.input?.bind((event) => {
        if (event.key.name === 'enter') {
          event.stop();
          app.exit();
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
    expect(await app.exited).toBe(0);
  });
});

describe('useApp()', () => {
  it('should throw outside runApp(), where AppContext reads undefined', () => {
    expect(() => useApp()).toThrow(/outside runApp/);
    expect(useContext(AppContext)).toBeUndefined();
  });
});
