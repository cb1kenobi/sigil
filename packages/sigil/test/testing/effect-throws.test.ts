import { stopwatch } from '../../src/components/clock.js';
import { type App, runApp } from '../../src/renderer/app.js';
import { render } from '../../src/renderer/index.js';
import { createEffects } from '../../src/signals/index.js';
import { createTestTerminal, frame } from '../../src/testing/index.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * A throw from an effect the scheduler flushes in a microtask, over a test
 * terminal (SIG-654).
 *
 * SIG-631 and SIG-642 gave a throw from a *timer* to `onTimerError()`. An effect is
 * not a timer: the clock's `format` runs from the effect that reads `clock.text`,
 * on a flush the scheduler asked for when a tick wrote a signal, and a throw there
 * is the signals layer's to report. The probe this file is the record of asked what
 * a test sees, and the answer is that it is not an uncaught exception, unless the handler it goes to throws -- an
 * effect's error is reported and not rethrown, so there is no microtask for
 * nothing to catch -- and that a test can hear it where it already could.
 */

const apps: App[] = [];

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
});

afterEach(async () => {
  vi.useRealTimers();
  for (const app of apps.splice(0)) {
    app.exit();
    await app.exited;
  }
});

/** A stopwatch whose `format` answers until it is told to throw, as a later tick would. */
function brokenLater(opts: Parameters<typeof stopwatch>[0] = {}) {
  const source = { broken: false };
  const watch = stopwatch({
    ...opts,
    format: (seconds) => {
      if (source.broken) {
        throw new Error('format broke');
      }
      return `${seconds}s`;
    },
    now: () => 0,
  });
  return { source, watch };
}

describe('a clock whose format throws on a later tick, inside an app', () => {
  it('should reach the onError the app gave runApp()', async () => {
    const ui = createTestTerminal({ columns: 30, rows: 6 });
    const errors: unknown[] = [];
    const { source, watch } = brokenLater({ terminal: ui.terminal });
    watch.start();
    const app = runApp(() => watch.view(), {
      detect: false,
      onError: (error) => void errors.push(error),
      terminal: ui.terminal,
    });
    apps.push(app);
    expect(errors).toEqual([]);

    source.broken = true;
    vi.advanceTimersByTime(1000);
    await frame(app);

    expect(errors).toEqual([new Error('format broke')]);
  });

  it('should be shown by the default handler, with the app stopped, when there is no onError', async () => {
    const ui = createTestTerminal({ columns: 30, rows: 6 });
    const { source, watch } = brokenLater({ terminal: ui.terminal });
    watch.start();
    const app = runApp(() => watch.view(), { detect: false, terminal: ui.terminal });
    apps.push(app);
    expect(app.running).toBe(true);

    source.broken = true;
    vi.advanceTimersByTime(1000);
    await frame(app);

    expect(app.running).toBe(false);
    expect(ui.viewport.join('\n')).toContain('Error: format broke');
  });
});

describe('a clock whose format throws on a later tick, read by a bare effect', () => {
  it('should reach setErrorHandler(), and never leave the microtask uncaught', async () => {
    const effects = createEffects();
    const errors: unknown[] = [];
    effects.setErrorHandler((error) => void errors.push(error));
    // over a terminal, because a clock off one is not live and arms no redraw
    const ui = createTestTerminal();
    const { source, watch } = brokenLater({ terminal: ui.terminal });
    watch.start();
    const stop = effects.effect(() => void watch.text);
    try {
      await Promise.resolve();
      expect(errors).toEqual([]);

      source.broken = true;
      vi.advanceTimersByTime(1000);
      await Promise.resolve();

      expect(errors).toEqual([new Error('format broke')]);
    } finally {
      // disposed before the clock is paused: pausing writes a signal
      stop();
      watch.pause();
    }
  });

  it('should keep the effect armed, so the next tick that throws is reported too', async () => {
    const effects = createEffects();
    const errors: unknown[] = [];
    effects.setErrorHandler((error) => void errors.push(error));
    // over a terminal, because a clock off one is not live and arms no redraw
    const ui = createTestTerminal();
    const { source, watch } = brokenLater({ terminal: ui.terminal });
    watch.start();
    const stop = effects.effect(() => void watch.text);
    try {
      source.broken = true;
      vi.advanceTimersByTime(1000);
      await Promise.resolve();
      vi.advanceTimersByTime(1000);
      await Promise.resolve();

      expect(errors).toHaveLength(2);
    } finally {
      stop();
      watch.pause();
    }
  });

  it('should be a line on stderr and an exit code, not an uncaught exception, by default', async () => {
    const effects = createEffects();
    const written: string[] = [];
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      written.push(String(chunk));
      return true;
    });
    const exitCode = process.exitCode;
    // `||=` in the default handler, so what an earlier test left would pass this
    process.exitCode = undefined;
    const ui = createTestTerminal();
    const { source, watch } = brokenLater({ terminal: ui.terminal });
    watch.start();
    const stop = effects.effect(() => void watch.text);
    try {
      source.broken = true;
      vi.advanceTimersByTime(1000);
      await Promise.resolve();

      expect(written).toContain('Error in effect: format broke\n');
      expect(process.exitCode).toBe(1);
    } finally {
      // disposed before the clock is paused: pausing writes a signal, and an
      // effect still watching it would report again, after the spy is gone
      stop();
      watch.pause();
      stderr.mockRestore();
      process.exitCode = exitCode;
    }
  });
});

describe('a clock whose format throws on a later tick, inside render()', () => {
  it('should be written to stderr by the default handler, which leaves the screen empty', () => {
    const ui = createTestTerminal({ columns: 30, rows: 6 });
    const { source, watch } = brokenLater({ terminal: ui.terminal });
    watch.start();
    const written: string[] = [];
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      written.push(String(chunk));
      return true;
    });
    const exitCode = process.exitCode;
    process.exitCode = undefined;
    try {
      const renderer = render(() => watch.view(), { terminal: ui.terminal });
      source.broken = true;
      vi.advanceTimersByTime(1000);
      renderer.frame();

      expect(written.join('')).toContain('format broke');
      expect(process.exitCode).toBe(1);
      expect(renderer.mounted).toBe(false);
      expect(ui.viewport.join('')).toBe('');
    } finally {
      stderr.mockRestore();
      process.exitCode = exitCode;
    }
  });

  it('should reach the onError the caller gave render()', () => {
    const ui = createTestTerminal({ columns: 30, rows: 6 });
    const errors: unknown[] = [];
    const { source, watch } = brokenLater({ terminal: ui.terminal });
    watch.start();
    const renderer = render(() => watch.view(), {
      onError: (error) => void errors.push(error),
      terminal: ui.terminal,
    });

    source.broken = true;
    vi.advanceTimersByTime(1000);
    renderer.frame();

    expect(errors).toEqual([new Error('format broke')]);
  });
});
