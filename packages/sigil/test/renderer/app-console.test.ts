import { captureConsole, createLogRing } from '../../src/components/console-capture.js';
import { enableDebugOverlay } from '../../src/components/debug-overlay.js';
import { box, type Element, text } from '../../src/element/index.js';
import { type App, runApp, useApp } from '../../src/renderer/app.js';
import { createEffect, onCleanup, onMount } from '../../src/renderer/index.js';
import { State } from '../../src/signals/index.js';
import { createTestTerminal, ctrl, tick } from '../../src/testing/index.js';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * `runApp()` and the console (SIG-310): a `console.log()` while the app owns the
 * screen is captured rather than written into the frame the diff is keeping, and
 * a failed exit replays it once the screen is back.
 *
 * Every write the terminal sees is recorded with the stream it went to and
 * whether the alternate screen was up at that moment, because the claims here
 * are about order and place -- the lines before the report, on the main screen,
 * stdout and stderr apart -- and a joined string answers none of them.
 */

/** One write the terminal saw. */
interface Write {
  alternate: boolean;
  stream: 'stderr' | 'stdout';
  text: string;
}

/** A control sequence, built rather than written so that no control character sits in source. */
const CSI = new RegExp(`${String.fromCharCode(0x1b)}\\[[0-9;?]*[A-Za-z]`, 'g');

const LEVELS = ['debug', 'error', 'info', 'log', 'warn'] as const;
const pristine = Object.fromEntries(LEVELS.map((level) => [level, console[level]]));

const apps: App[] = [];

/** A test terminal whose stdout and stderr writes are recorded, told apart. */
function watch() {
  const term = createTestTerminal({ columns: 30, rows: 6 });
  const writes: Write[] = [];
  const t = term.terminal;
  const write = t.write.bind(t);
  const writeErr = t.writeErr.bind(t);
  t.write = (chunk: string): boolean => {
    writes.push({ alternate: term.screen.alternate, stream: 'stdout', text: chunk });
    return write(chunk);
  };
  t.writeErr = (chunk: string): boolean => {
    writes.push({ alternate: term.screen.alternate, stream: 'stderr', text: chunk });
    return writeErr(chunk);
  };
  return { term, writes };
}

/** Runs an app over a watched terminal, remembering it so a failed test still ends it. */
function start(component: () => Element, opts: Parameters<typeof runApp>[1] = {}) {
  const { term, writes } = watch();
  const app = runApp(component, { detect: false, terminal: term.terminal, ...opts });
  apps.push(app);
  return { app, term, writes };
}

/**
 * What was written on the main screen, as `stream: text` per line.
 *
 * Control sequences and carriage returns are taken out: a held line is written
 * with CRLF because the terminal is still raw when the backend lets go of it,
 * and the inline backend writes its erase in the same chunk as the line. Neither
 * is the claim; the text, its stream and its order are.
 */
function plain(writes: readonly Write[]): string[] {
  return writes
    .filter((w) => !w.alternate)
    .flatMap((w) =>
      w.text
        .replace(CSI, '')
        .replace(/\r/g, '')
        .split('\n')
        .filter((line) => line !== '')
        .map((line) => `${w.stream}: ${line}`)
    );
}

afterEach(async () => {
  for (const app of apps.splice(0)) {
    app.exit();
    await app.exited;
  }
  // a test that failed with the capture up must not leave the next one without a
  // console of its own
  for (const level of LEVELS) {
    console[level] = pristine[level] as (typeof console)[typeof level];
  }
  process.exitCode = undefined;
});

describe('runApp() and the console', () => {
  describe('full screen', () => {
    it('should capture a console write instead of drawing it into the alternate screen', async () => {
      const { app, term, writes } = start(() => text('hello'));
      app.view.frame();
      const before = writes.length;

      console.log('stray line');
      console.warn('stray warning');
      app.view.invalidate();
      app.view.frame();

      expect(term.viewport[0]).toBe('hello');
      expect(term.viewport.join('\n')).not.toContain('stray');
      expect(
        writes
          .slice(before)
          .map((w) => w.text)
          .join('')
      ).not.toContain('stray');
      expect(app.logs?.entries().map((e) => [e.level, e.text])).toEqual([
        ['log', 'stray line'],
        ['warn', 'stray warning'],
      ]);
    });

    it('should capture what the component body logs, and hand the ring out through useApp()', () => {
      let seen: App | undefined;
      const { app } = start(() => {
        seen = useApp();
        console.info('from the body');
        return text('x');
      });

      expect(seen?.logs).toBe(app.logs);
      expect(app.logs?.capacity).toBe(1000);
      expect(app.logs?.entries().map((e) => e.text)).toEqual(['from the body']);
    });

    it('should format a message the way console does', () => {
      const { app } = start(() => text('x'));
      console.log('%s items, %d%%', 'three', 50);
      expect(app.logs?.entries().map((e) => e.text)).toEqual(['three items, 50%']);
    });

    it('should discard the ring on a clean exit, writing nothing on the main screen', async () => {
      const { app, writes } = start(() => text('x'));
      console.log('chatter');
      console.error('also chatter');
      app.exit(0);

      expect(await app.exited).toBe(0);
      expect(plain(writes)).toEqual([]);
      expect(writes.map((w) => w.text).join('')).not.toContain('chatter');
    });

    it('should replay the ring to the main screen when the exit code is not zero', async () => {
      const { app, term, writes } = start(() => text('x'));
      console.log('first');
      console.warn('second');
      console.info('third');
      console.error('fourth');
      console.debug('fifth');
      app.exit(3);

      expect(await app.exited).toBe(3);
      // in order, each to the stream the console would have used, with no prefix
      expect(plain(writes)).toEqual([
        'stdout: first',
        'stderr: second',
        'stdout: third',
        'stderr: fourth',
        'stdout: fifth',
      ]);
      // and after the screen was back, not into the alternate buffer being left
      expect(writes.filter((w) => w.text.includes('first') || w.text.includes('fifth'))).toSatisfy(
        (list: Write[]) => list.every((w) => !w.alternate)
      );
      expect(term.screen.alternate).toBe(false);
    });

    it('should discard the ring for Ctrl-C, which is the habitual way out of a healthy app', async () => {
      const { app, term, writes } = start(() => text('x'));
      console.log('before the interrupt');
      console.error('and a warning');
      await term.press(ctrl('c'));

      expect(await app.exited).toBe(130);
      expect(plain(writes)).toEqual([]);
    });

    it('should discard the ring for an exit(130) of the app own, which is the same code', async () => {
      const { app, writes } = start(() => text('x'));
      console.log('before');
      app.exit(130);

      expect(await app.exited).toBe(130);
      expect(plain(writes)).toEqual([]);
    });

    it('should replay when stdin hangs up under it, which is 129', async () => {
      const { app, term, writes } = start(() => text('x'));
      console.log('before the hang-up');
      term.stdin.end();

      expect(await app.exited).toBe(129);
      expect(plain(writes)).toEqual(['stdout: before the hang-up']);
    });

    it('should write the lines before the error report of a failed frame', async () => {
      const boom = new State(false);
      const { app, writes } = start(() => {
        const label = text('');
        createEffect(() => {
          if (boom.get()) {
            throw new Error('frame broke');
          }
          label.setText('fine');
        });
        return label;
      });
      app.view.frame();
      console.log('what led up to it');
      console.error('a warning sign');
      boom.set(true);
      app.view.frame();

      expect(await app.exited).toBe(1);
      const lines = plain(writes);
      expect(lines.slice(0, 2)).toEqual(['stdout: what led up to it', 'stderr: a warning sign']);
      expect(lines[2]).toContain('frame broke');
      expect(lines).toHaveLength(3);
    });

    it('should write the lines before a report made earlier, because they led to it', async () => {
      const { app, writes } = start(() => {
        onMount(() => {
          throw new Error('mount broke');
        });
        return text('still up');
      });
      app.view.frame();
      console.log('logged after the mount broke');
      // reported while the app stayed up, so it waits -- and waits behind the lines
      expect(plain(writes)).toEqual([]);

      app.exit(2);
      await app.exited;
      const lines = plain(writes);
      expect(lines[0]).toBe('stdout: logged after the mount broke');
      expect(lines[1]).toContain('mount broke');
    });

    it('should still write a report after a clean exit, without the lines', async () => {
      const { app, writes } = start(() => {
        onMount(() => {
          throw new Error('mount broke');
        });
        return text('still up');
      });
      app.view.frame();
      console.log('discarded');
      app.exit();

      expect(await app.exited).toBe(0);
      const lines = plain(writes);
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain('mount broke');
    });

    it('should write what a cleanup logs during a failed frame before the error report', async () => {
      const boom = new State(false);
      const { app, writes } = start(() => {
        onCleanup(() => console.log('cleanup says goodbye'));
        const label = text('');
        createEffect(() => {
          if (boom.get()) {
            throw new Error('frame broke');
          }
          label.setText('fine');
        });
        return label;
      });
      app.view.frame();
      console.log('before');
      boom.set(true);
      app.view.frame();

      expect(await app.exited).toBe(1);
      const lines = plain(writes);
      expect(lines.slice(0, 2)).toEqual(['stdout: before', 'stdout: cleanup says goodbye']);
      expect(lines[2]).toContain('frame broke');
      expect(lines).toHaveLength(3);
    });

    it('should never lose what a custom onError logs through console, on a clean exit', async () => {
      const { app, writes } = start(
        () => {
          onMount(() => {
            throw new Error('mount broke');
          });
          return text('x');
        },
        { onError: (error) => console.error('APP ERROR:', (error as Error).message) }
      );
      app.view.frame();
      console.log('chatter that a clean exit discards');
      app.exit(0);

      expect(await app.exited).toBe(0);
      // on the main screen, on stderr, once -- and the chatter is still discarded
      expect(plain(writes)).toEqual(['stderr: APP ERROR: mount broke']);
      expect(
        writes
          .filter((w) => w.alternate)
          .map((w) => w.text)
          .join('')
      ).not.toContain('APP ERROR');
    });

    it('should write what a custom onError logs after the replay, and only once, on a failure', async () => {
      const { app, writes } = start(
        () => {
          onMount(() => {
            throw new Error('mount broke');
          });
          return text('x');
        },
        { onError: (error) => console.error('APP ERROR:', (error as Error).message) }
      );
      app.view.frame();
      console.log('what led up to it');
      app.exit(2);

      expect(await app.exited).toBe(2);
      expect(plain(writes)).toEqual([
        'stdout: what led up to it',
        'stderr: APP ERROR: mount broke',
      ]);
    });

    it('should not draw what a custom onError logs into the alternate screen', async () => {
      const boom = new State(false);
      const { app, term, writes } = start(
        () => {
          createEffect(() => {
            if (boom.get()) {
              throw new Error('frame broke');
            }
          });
          return text('x');
        },
        { onError: (error) => console.error('APP ERROR:', (error as Error).message) }
      );
      app.view.frame();
      boom.set(true);
      app.view.frame();

      expect(await app.exited).toBe(1);
      expect(plain(writes)).toEqual(['stderr: APP ERROR: frame broke']);
      expect(term.screen.alternate).toBe(false);
    });

    it('should capture console.dir() and console.dirxml(), which do not go through the public methods', () => {
      const out = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
      try {
        const { app } = start(() => text('x'));
        console.dir({ a: { b: { c: { d: 1 } } } }, { depth: 0 });
        console.dirxml({ b: 2 });

        expect(out).not.toHaveBeenCalled();
        expect(app.logs?.entries().map((e) => [e.level, e.text])).toEqual([
          ['log', '{ a: [Object] }'],
          ['log', '{ b: 2 }'],
        ]);
      } finally {
        out.mockRestore();
      }
    });

    it('should write the lines ahead of a custom onError as well', async () => {
      const seen: string[] = [];
      const boom = new State(false);
      const { app, writes } = start(
        () => {
          createEffect(() => {
            if (boom.get()) {
              throw new Error('frame broke');
            }
          });
          return text('x');
        },
        {
          onError: (error) => {
            seen.push(`handler saw ${(error as Error).message} after ${plain(writes).length}`);
          },
        }
      );
      app.view.frame();
      console.log('line one');
      boom.set(true);
      app.view.frame();
      await app.exited;

      expect(plain(writes)).toEqual(['stdout: line one']);
      expect(seen).toEqual(['handler saw frame broke after 1']);
    });

    it('should write the lines ahead of the report when the first frame fails inside runApp()', async () => {
      const { app, writes } = start(() => {
        console.log('logged while building');
        const label = text('x');
        label.onResize = () => {
          throw new Error('first frame broke');
        };
        return label;
      });

      expect(await app.exited).toBe(1);
      const lines = plain(writes);
      expect(lines[0]).toBe('stdout: logged while building');
      expect(lines[1]).toContain('first frame broke');
    });

    it('should replay, and then rethrow, when the component body throws', () => {
      const { term, writes } = watch();
      expect(() =>
        runApp(
          () => {
            console.log('before the throw');
            console.warn('and a warning');
            throw new Error('body broke');
          },
          { detect: false, terminal: term.terminal }
        )
      ).toThrow('body broke');

      expect(plain(writes)).toEqual(['stdout: before the throw', 'stderr: and a warning']);
      expect(console.log).toBe(pristine.log);
    });

    it('should say how many lines the ring dropped before replaying what it kept', async () => {
      const { app, writes } = start(() => text('x'));
      for (let i = 0; i < 1005; i++) {
        console.log(`line ${i}`);
      }
      app.exit(1);
      await app.exited;

      const lines = plain(writes);
      expect(lines[0]).toBe('stderr: 5 earlier console lines were dropped (the last 1000 follow)');
      expect(lines).toHaveLength(1001);
      expect(lines[1]).toBe('stdout: line 5');
      expect(lines.at(-1)).toBe('stdout: line 1004');
    });

    it('should not mention a drop when nothing was dropped', async () => {
      const { app, writes } = start(() => text('x'));
      console.log('only line');
      app.exit(1);
      await app.exited;
      expect(plain(writes)).toEqual(['stdout: only line']);
    });

    it('should capture a log from a cleanup that runs during the teardown', async () => {
      const { app, writes } = start(() => {
        onCleanup(() => console.log('cleaning up'));
        return text('x');
      });
      console.log('running');
      app.exit(4);
      await app.exited;

      expect(plain(writes)).toEqual(['stdout: running', 'stdout: cleaning up']);
    });

    it('should put the console methods back on every way out', async () => {
      const ways: ((app: App, term: ReturnType<typeof createTestTerminal>) => Promise<void>)[] = [
        async (app) => app.exit(),
        async (app) => app.exit(2),
        async (_app, term) => term.press(ctrl('c')),
        async (_app, term) => {
          term.stdin.end();
        },
      ];
      for (const way of ways) {
        const { app, term } = start(() => text('x'));
        expect(console.log).not.toBe(pristine.log);
        await way(app, term);
        await app.exited;
        for (const level of LEVELS) {
          expect(console[level]).toBe(pristine[level]);
        }
      }
    });

    it('should put the console back after a failed frame', async () => {
      const boom = new State(false);
      const { app } = start(() => {
        createEffect(() => {
          if (boom.get()) {
            throw new Error('frame broke');
          }
        });
        return text('x');
      });
      app.view.frame();
      boom.set(true);
      app.view.frame();
      await app.exited;
      expect(console.log).toBe(pristine.log);
    });

    it('should not capture once the app has gone', async () => {
      const { app, writes } = start(() => text('x'));
      app.exit(1);
      await app.exited;
      const before = app.logs?.size;
      // the real console again: this one is not the app's to keep
      expect(console.log).toBe(pristine.log);
      expect(app.logs?.size).toBe(before);
      expect(writes.length).toBeGreaterThan(0);
    });

    it('should show what it captured in the debug overlay, live', async () => {
      const { app, term } = start(() => box({ 'flex-grow': 1 }, text('app')));
      app.view.frame();
      const overlay = enableDebugOverlay(app.view, {
        height: 5,
        log: app.logs,
        stats: false,
        visible: true,
      });
      console.log('shown in the pane');
      app.view.invalidate();
      app.view.frame();
      app.view.invalidate();
      app.view.frame();

      expect(overlay.log).toBe(app.logs);
      expect(term.viewport.join('\n')).toContain('shown in the pane');
    });
  });

  describe('inline', () => {
    it('should write a captured line above the region at once, to the stream the console uses', async () => {
      const { app, term, writes } = start(() => text('live'), { fullscreen: false });
      app.view.frame();
      const before = writes.length;

      console.log('to stdout');
      console.warn('to stderr');

      const lines = plain(writes.slice(before));
      expect(lines).toContain('stdout: to stdout');
      expect(lines).toContain('stderr: to stderr');
      expect(term.lines.join('\n')).toContain('to stdout');
      // the region is repainted under it
      expect(term.lines.join('\n')).toContain('live');

      app.exit();
      expect(await app.exited).toBe(0);
    });

    it('should write a line the body logs, once the backend is there', async () => {
      const { app, term } = start(
        () => {
          console.log('from the body');
          return text('live');
        },
        { fullscreen: false }
      );
      app.exit();
      await app.exited;
      expect(term.lines.join('\n')).toContain('from the body');
    });

    it('should hold nothing and replay nothing on a failed exit', async () => {
      const { app, writes } = start(() => text('live'), { fullscreen: false });
      app.view.frame();
      console.log('written already');
      const before = writes.length;
      app.exit(1);
      await app.exited;

      const after = writes
        .slice(before)
        .map((w) => w.text)
        .join('');
      expect(after).not.toContain('written already');
    });

    it('should keep the ring for app.logs all the same', () => {
      const { app } = start(() => text('live'), { fullscreen: false });
      console.log('kept');
      expect(app.logs?.entries().map((e) => e.text)).toEqual(['kept']);
    });
  });

  describe('opting out', () => {
    it('should leave the console alone with console: false', async () => {
      // a stand-in for the console's own `log`: nothing the runner does may replace it
      const own = vi.spyOn(console, 'log').mockImplementation(() => {});
      try {
        const { app, writes } = start(() => text('x'), { console: false });

        expect(app.logs).toBeUndefined();
        expect(console.log).toBe(own);
        console.log('not captured');
        expect(own).toHaveBeenCalledWith('not captured');

        app.exit(1);
        await app.exited;
        // and nothing replayed: there is no ring to replay
        expect(plain(writes)).toEqual([]);
      } finally {
        own.mockRestore();
      }
    });

    it('should leave a capture the app installed itself alone, and have no logs', async () => {
      const ring = createLogRing();
      const mine = captureConsole(ring);
      try {
        const patched = console.log;
        const { app, writes } = start(() => text('x'));

        expect(mine.installed).toBe(true);
        expect(app.logs).toBeUndefined();
        console.log('goes to the app ring');
        expect(ring.entries().map((e) => e.text)).toEqual(['goes to the app ring']);

        app.exit(1);
        await app.exited;
        // theirs is still the live one, and nothing was replayed from it
        expect(console.log).toBe(patched);
        expect(plain(writes)).toEqual([]);
        expect(ring.size).toBe(1);
      } finally {
        mine.restore();
      }
      expect(console.log).toBe(pristine.log);
    });

    it('should give an app that starts under another one no logs, and leave its console alone', async () => {
      const first = start(() => text('A'));
      const second = start(() => text('B'));

      expect(first.app.logs).toBeDefined();
      expect(second.app.logs).toBeUndefined();

      first.app.exit();
      await first.app.exited;
      // the console is the real one again, so the second app's lines are now its own
      // screen's business: nothing captures them
      expect(console.log).toBe(pristine.log);
      second.app.exit();
      await second.app.exited;
    });

    it('should patch nothing where it refuses to start', async () => {
      const term = createTestTerminal({ inputTTY: false });
      const app = runApp(() => text('x'), { detect: false, terminal: term.terminal });

      expect(app.logs).toBeUndefined();
      expect(console.log).toBe(pristine.log);
      expect(await app.exited).toBe(1);
      await tick();
    });
  });
});

/**
 * A throw nobody caught, a rejection nobody handled, or a `process.exit()` ends the
 * process under a running app. Only a real process can say what happens then, so
 * this runs the built runner in a child: its test terminal forwards every write as
 * a line of JSON on stdout, and the console it logs through is the child's own.
 */
describe('runApp() when the process ends under it', () => {
  const dist = new URL('../../dist/', import.meta.url).href;

  /** Runs `body` in a child over a watched terminal; returns what it wrote. */
  function child(body: string) {
    const source = `
      const { runApp } = await import(${JSON.stringify(`${dist}app.mjs`)});
      const E = await import(${JSON.stringify(`${dist}element.mjs`)});
      const T = await import(${JSON.stringify(`${dist}testing.mjs`)});
      const term = T.createTestTerminal({ columns: 30, rows: 6 });
      const t = term.terminal;
      const w = t.write.bind(t);
      const we = t.writeErr.bind(t);
      const tell = (stream, chunk) =>
        process.stdout.write('W|' + stream + '|' + term.screen.alternate + '|' + JSON.stringify(chunk) + '\\n');
      t.write = (c) => (tell('out', c), w(c));
      t.writeErr = (c) => (tell('err', c), we(c));
      const app = runApp(() => E.text('x'), { detect: false, terminal: t });
      app.view.frame();
      ${body}
    `;
    const ran = spawnSync(process.execPath, ['--input-type=module', '-e', source], {
      encoding: 'utf8',
    });
    const writes: Write[] = [];
    const raw: string[] = [];
    for (const line of ran.stdout.split('\n')) {
      const match = /^W\|(out|err)\|(true|false)\|(.*)$/.exec(line);
      if (match) {
        writes.push({
          alternate: match[2] === 'true',
          stream: match[1] === 'err' ? 'stderr' : 'stdout',
          text: JSON.parse(match[3] as string) as string,
        });
      } else if (line !== '') {
        raw.push(line);
      }
    }
    return { raw, status: ran.status, stderr: ran.stderr, writes };
  }

  it('should replay the ring and put the console back when a timer throws', () => {
    const ran = child(`
      console.log('context before the crash');
      process.on('exit', () => console.log('exit handler speaks'));
      setTimeout(() => { throw new Error('async crash'); }, 5);
    `);

    expect(ran.status).toBe(1);
    expect(ran.stderr).toContain('async crash');
    expect(plain(ran.writes)).toEqual(['stdout: context before the crash']);
    // after the screen was back, and a handler of the app own wrote normally
    expect(ran.writes.every((w) => !w.alternate || !w.text.includes('context'))).toBe(true);
    expect(ran.raw).toEqual(['exit handler speaks']);
  });

  it('should replay for process.exit() with a code, and discard it for 0', () => {
    const failed = child(`console.log('kept'); process.exit(3);`);
    expect(failed.status).toBe(3);
    expect(plain(failed.writes)).toEqual(['stdout: kept']);

    const clean = child(`console.log('dropped'); process.exit(0);`);
    expect(clean.status).toBe(0);
    expect(plain(clean.writes)).toEqual([]);
  });
});
