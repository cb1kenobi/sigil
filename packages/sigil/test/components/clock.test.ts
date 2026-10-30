import { clockView, formatClock, stopwatch, timer } from '../../src/components/clock.js';
import { mountLive } from '../../src/components/mount.js';
import { createSpinner } from '../../src/components/spinner.js';
import { loadCatalog } from '../../src/i18n/index.js';
import { effect, flush } from '../../src/signals/index.js';
import { setQuiet } from '../../src/style/output.js';
import { screenSetup, setup } from './helpers.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(async () => {
  setQuiet(undefined);
  vi.useRealTimers();
  await loadCatalog(undefined, {});
});

/**
 * A clock a test moves by hand, and the timers with it.
 *
 * Both move together and in steps of a millisecond at most as wide as the
 * request, because a timer that fires in the middle of an advance has to read a
 * clock that has got that far and no further.
 */
function time(): { advance(ms: number): Promise<void>; now(): number } {
  let t = 0;
  return {
    async advance(ms) {
      for (let left = ms; left > 0;) {
        const step = Math.min(left, 50);
        t += step;
        left -= step;
        await vi.advanceTimersByTimeAsync(step);
      }
    },
    now: () => t,
  };
}

/**
 * Every timer set, with the delay it was asked to wait and whether it was
 * unreferenced -- which fake timers cannot say for themselves.
 */
function watchTimers(): { delay: number; unref: boolean }[] & { restore(): void } {
  const real = globalThis.setTimeout;
  const seen = Object.assign([] as { delay: number; unref: boolean }[], { restore: () => {} });
  const spy = vi.spyOn(globalThis, 'setTimeout').mockImplementation(((
    fn: () => void,
    delay: number
  ) => {
    const handle = real(fn, delay);
    const entry = { delay, unref: false };
    seen.push(entry);
    const unref = handle.unref.bind(handle);
    handle.unref = () => {
      entry.unref = true;
      return unref();
    };
    return handle;
  }) as never);
  seen.restore = (): void => {
    spy.mockRestore();
  };
  return seen;
}

describe('formatClock()', () => {
  it.each([
    [0, '00:00'],
    [7, '00:07'],
    [72, '01:12'],
    [3599, '59:59'],
    [3600, '1:00:00'],
    [7384, '2:03:04'],
    [-5, '00:00'],
  ])('should write %s seconds as %s', (seconds, text) => {
    expect(formatClock(seconds)).to.equal(text);
  });
});

describe('stopwatch()', () => {
  it('should count what has passed while it is running', async () => {
    const t = time();
    const watch = stopwatch({ now: t.now, quiet: true }).start();

    await t.advance(12_400);

    expect(watch.elapsed).to.equal(12_400);
    expect(watch.text).to.equal('12s');
  });

  it('should say nothing has passed before it is started', async () => {
    const t = time();
    const watch = stopwatch({ now: t.now, quiet: true });

    await t.advance(5000);

    expect(watch.elapsed).to.equal(0);
    expect(watch.running).to.equal(false);
  });

  it('should hold the count while paused and carry on from it', async () => {
    const t = time();
    const watch = stopwatch({ now: t.now, quiet: true }).start();

    await t.advance(3000);
    watch.pause();
    await t.advance(10_000);
    expect(watch.elapsed).to.equal(3000);
    expect(watch.running).to.equal(false);

    watch.start();
    await t.advance(2000);
    expect(watch.elapsed).to.equal(5000);
  });

  it('should start again from nothing on reset, and keep running if it was', async () => {
    const t = time();
    const watch = stopwatch({ now: t.now, quiet: true }).start();

    await t.advance(4000);
    watch.reset();
    expect(watch.elapsed).to.equal(0);
    expect(watch.running).to.equal(true);

    await t.advance(1000);
    expect(watch.elapsed).to.equal(1000);
  });

  it('should stay stopped on reset if it was stopped', async () => {
    const t = time();
    const watch = stopwatch({ now: t.now, quiet: true }).start();

    await t.advance(4000);
    watch.pause();
    watch.reset();
    await t.advance(1000);

    expect(watch.elapsed).to.equal(0);
    expect(watch.running).to.equal(false);
  });

  it('should write minutes and hours the way the catalog words them', async () => {
    const t = time();
    const watch = stopwatch({ now: t.now, quiet: true }).start();

    await t.advance(72_000);
    expect(watch.text).to.equal('1m 12s');
  });

  it('should write digits when asked for a clock', async () => {
    const t = time();
    const watch = stopwatch({ format: 'clock', now: t.now, quiet: true }).start();

    await t.advance(72_000);
    expect(watch.text).to.equal('01:12');
  });

  it('should hand a format function whole seconds, counted down', async () => {
    const t = time();
    const seen: number[] = [];
    const watch = stopwatch({
      format: (s) => {
        seen.push(s);
        return `<${s}>`;
      },
      now: t.now,
      quiet: true,
    }).start();

    await t.advance(2999);
    expect(watch.text).to.equal('<2>');
    expect(seen).to.deep.equal([2]);
  });

  it('should word the time in the locale it was asked for', async () => {
    await loadCatalog({ de: async () => ({ '{0}m {1}s': '{0} Min. {1} Sek.' }) }, {}, 'de');
    const t = time();
    const watch = stopwatch({ now: t.now, quiet: true }).start();

    await t.advance(72_000);
    expect(watch.text).to.equal('1 Min. 12 Sek.');
  });
});

describe('timer()', () => {
  it('should count down from the duration', async () => {
    const t = time();
    const down = timer(10_000, { now: t.now, quiet: true }).start();

    await t.advance(4000);

    expect(down.remaining).to.equal(6000);
    expect(down.elapsed).to.equal(4000);
    expect(down.text).to.equal('6s');
    expect(down.finished).to.equal(false);
  });

  it('should round what is left up, so it says 0s only when it is over', async () => {
    const t = time();
    const down = timer(2000, { now: t.now, quiet: true }).start();

    await t.advance(1600);
    expect(down.text).to.equal('1s');

    await t.advance(400);
    expect(down.text).to.equal('0s');
    expect(down.finished).to.equal(true);
  });

  it('should settle done with true when it runs out', async () => {
    const t = time();
    const down = timer(3000, { now: t.now, quiet: true }).start();
    let result: boolean | undefined;
    void down.done.then((ran) => {
      result = ran;
    });

    await t.advance(2999);
    expect(result).to.equal(undefined);

    await t.advance(1);
    expect(result).to.equal(true);
    expect(down.running).to.equal(false);
    expect(down.remaining).to.equal(0);
  });

  it('should settle done with false when it is cancelled', async () => {
    const t = time();
    const down = timer(3000, { now: t.now, quiet: true }).start();

    await t.advance(1000);
    down.cancel();

    expect(await down.done).to.equal(false);
    expect(down.running).to.equal(false);
    expect(down.finished).to.equal(false);
    expect(down.remaining).to.equal(2000);
  });

  it('should not run out while it is paused', async () => {
    const t = time();
    const down = timer(3000, { now: t.now, quiet: true }).start();

    await t.advance(1000);
    down.pause();
    await t.advance(60_000);
    expect(down.finished).to.equal(false);
    expect(down.remaining).to.equal(2000);

    down.start();
    await t.advance(2000);
    expect(down.finished).to.equal(true);
  });

  it('should run out as it starts when the duration is zero', async () => {
    const down = timer(0, { quiet: true }).start();

    expect(await down.done).to.equal(true);
    expect(down.finished).to.equal(true);
  });

  it('should be a new timer after it is reset, with a promise of its own', async () => {
    const t = time();
    const down = timer(1000, { now: t.now, quiet: true }).start();
    await t.advance(1000);
    const first = down.done;
    expect(await first).to.equal(true);

    down.reset();
    expect(down.finished).to.equal(false);
    expect(down.done).not.to.equal(first);

    down.start();
    await t.advance(1000);
    expect(await down.done).to.equal(true);
  });

  it('should stay out once it has run out, until it is reset', async () => {
    const t = time();
    const down = timer(1000, { now: t.now, quiet: true }).start();
    await t.advance(1000);

    down.start();
    await t.advance(5000);

    expect(down.running).to.equal(false);
    expect(down.elapsed).to.equal(1000);
  });

  it('should keep the process alive for a countdown, and not for the readout of one', () => {
    const { terminal } = setup({ isTTY: true });
    const handles = watchTimers();
    const down = timer(60_000, { terminal }).start();

    // the redraw is not a reason for a finished program to stay, and a
    // deadline somebody is awaiting is
    expect(handles.find((h) => h.delay === 1000)?.unref).to.equal(true);
    expect(handles.find((h) => h.delay === 60_000)?.unref).to.equal(false);
    down.cancel();
    handles.restore();
  });

  it('should not finish early when the timer fires a moment before the clock agrees', async () => {
    let t = 0;
    const down = timer(1000, { now: () => t, quiet: true }).start();
    let ran = false;
    void down.done.then(() => {
      ran = true;
    });

    // the timer for 1000 ms fires with the clock at 999
    t = 999;
    await vi.advanceTimersByTimeAsync(1000);
    expect(ran).to.equal(false);

    t = 1000;
    await vi.advanceTimersByTimeAsync(1);
    expect(ran).to.equal(true);
  });

  it('should wait out a duration longer than a timer can hold in pieces', async () => {
    const t = time();
    const handles = watchTimers();
    const down = timer(2 ** 31 + 5000, { now: t.now, quiet: true }).start();

    // a delay past 2^31 - 1 is one the platform fires at once, which would
    // spin on a clock that says there is time left
    expect(Math.max(...handles.map((h) => h.delay))).to.equal(2 ** 31 - 1);
    handles.restore();
    expect(down.finished).to.equal(false);
  });

  it.each([[-1], [Number.NaN], [Number.POSITIVE_INFINITY], ['5s' as unknown as number]])(
    'should refuse %s as a duration',
    (duration) => {
      expect(() => timer(duration)).to.throw(TypeError, 'A timer takes a duration in milliseconds');
    }
  );
});

describe('as signals', () => {
  it('should re-run an effect that reads the text, once a tick', async () => {
    const ui = screenSetup();
    const t = time();
    const watch = stopwatch({ now: t.now, terminal: ui.terminal }).start();
    const seen: string[] = [];
    const stop = effect(() => {
      seen.push(watch.text);
    });
    flush();

    await t.advance(3000);
    flush();
    stop();

    expect(seen).to.deep.equal(['0s', '1s', '2s', '3s']);
  });

  it('should re-run an effect when it is paused, though nothing ticks', async () => {
    const t = time();
    const watch = stopwatch({ now: t.now, quiet: true }).start();
    const seen: boolean[] = [];
    const stop = effect(() => {
      seen.push(watch.running);
    });
    flush();

    watch.pause();
    flush();
    stop();

    expect(seen).to.deep.equal([true, false]);
  });

  it('should redraw on the boundary, so a late turn does not push every later second back', async () => {
    const ui = screenSetup();
    let t = 0;
    const watch = stopwatch({ now: () => t, terminal: ui.terminal }).start();
    const seen: string[] = [];
    const stop = effect(() => {
      seen.push(watch.text);
    });
    flush();

    // the first tick is due a second in, and the turn that ran it was 300 ms
    // late: the next is 700 ms away rather than a second
    t = 1300;
    await vi.advanceTimersByTimeAsync(1000);
    flush();
    t = 2000;
    await vi.advanceTimersByTimeAsync(700);
    flush();
    stop();

    expect(seen).to.deep.equal(['0s', '1s', '2s']);
  });

  it('should land a countdown on the boundary of what is left', async () => {
    const ui = screenSetup();
    const t = time();
    const down = timer(2500, { now: t.now, terminal: ui.terminal }).start();
    const seen: string[] = [];
    const stop = effect(() => {
      seen.push(down.text);
    });
    flush();

    await t.advance(2500);
    flush();
    stop();

    expect(seen).to.deep.equal(['3s', '2s', '1s', '0s']);
  });

  it('should honour a tick of its own', async () => {
    const ui = screenSetup();
    const t = time();
    const watch = stopwatch({
      format: (s) => String(s),
      now: t.now,
      terminal: ui.terminal,
      tick: 250,
    }).start();
    let runs = 0;
    const stop = effect(() => {
      void watch.elapsed;
      runs++;
    });
    flush();

    await t.advance(1000);
    flush();
    stop();

    // once to begin with and once a quarter second
    expect(runs).to.equal(5);
  });
});

describe('a clock beside a spinner', () => {
  it('should read as "Installing... 12s" on a terminal', async () => {
    const ui = screenSetup({ columns: 40 });
    const t = time();
    const watch = stopwatch({ now: t.now, terminal: ui.terminal }).start();
    const spin = createSpinner({ ansi: ui.ansi, terminal: ui.terminal, text: 'Installing...' });
    spin.start();
    const stop = effect(() => {
      spin.text = `Installing... ${watch.text}`;
    });

    await t.advance(12_000);
    flush();
    await vi.advanceTimersByTimeAsync(100);
    stop();

    expect(ui.frame).to.contain('Installing... 12s');
    spin.stop();
  });
});

describe('clockView()', () => {
  it('should draw the time on a terminal, in place', async () => {
    const ui = screenSetup({ columns: 20 });
    const t = time();
    const watch = stopwatch({ now: t.now, terminal: ui.terminal }).start();
    const mounted = mountLive(() => watch.view(), { ansi: ui.ansi, terminal: ui.terminal });

    expect(ui.frame).to.equal('0s');
    await t.advance(5000);
    flush();
    await vi.advanceTimersByTimeAsync(100);

    expect(ui.frame).to.equal('5s');
    mounted.stop();
  });

  it('should draw nothing before the clock is started', () => {
    const ui = screenSetup({ columns: 20 });
    const watch = stopwatch({ terminal: ui.terminal });
    const mounted = mountLive(() => clockView(watch), { ansi: ui.ansi, terminal: ui.terminal });

    expect(ui.frame).to.equal('');
    mounted.stop();
  });

  it('should show itself when the clock is started after the tree was built', async () => {
    const ui = screenSetup({ columns: 20 });
    const t = time();
    const watch = stopwatch({ now: t.now, terminal: ui.terminal });
    const mounted = mountLive(() => watch.view(), { ansi: ui.ansi, terminal: ui.terminal });

    watch.start();
    flush();
    await vi.advanceTimersByTimeAsync(100);

    expect(ui.frame).to.equal('0s');
    mounted.stop();
  });

  it('should leave the last time on screen when paused', async () => {
    const ui = screenSetup({ columns: 20 });
    const t = time();
    const watch = stopwatch({ now: t.now, terminal: ui.terminal }).start();
    const mounted = mountLive(() => watch.view(), { ansi: ui.ansi, terminal: ui.terminal });

    await t.advance(3000);
    flush();
    watch.pause();
    flush();
    await t.advance(5000);

    expect(ui.frame).to.equal('3s');
    expect(vi.getTimerCount()).to.equal(0);
    mounted.stop();
  });
});

describe('what a clock does where nothing is drawn', () => {
  it('should start no redraw timer when piped, and still count', async () => {
    const { terminal } = setup({ isTTY: false });
    const t = time();
    const watch = stopwatch({ now: t.now, terminal }).start();

    expect(vi.getTimerCount()).to.equal(0);
    await t.advance(5000);
    expect(watch.elapsed).to.equal(5000);
    expect(watch.live).to.equal(false);
  });

  it('should start no redraw timer under a motion preference on a terminal', () => {
    const { terminal } = setup({ isTTY: true });
    const watch = stopwatch({ reducedMotion: 'reduce', terminal }).start();

    expect(vi.getTimerCount()).to.equal(0);
    expect(watch.live).to.equal(false);
  });

  it('should start no redraw timer when quiet', () => {
    const { terminal } = setup({ isTTY: true });
    const watch = stopwatch({ quiet: true, terminal }).start();

    expect(vi.getTimerCount()).to.equal(0);
    expect(watch.live).to.equal(false);
  });

  it('should ask the process-wide request when it starts, not when it was built', () => {
    const { terminal } = setup({ isTTY: true });
    const watch = stopwatch({ terminal });

    setQuiet(true);
    watch.start();

    expect(watch.live).to.equal(false);
    expect(vi.getTimerCount()).to.equal(0);
  });

  it('should draw nothing, and write nothing, when quiet', async () => {
    const ui = screenSetup({ columns: 20 });
    const t = time();
    const watch = stopwatch({ now: t.now, quiet: true, terminal: ui.terminal }).start();
    const mounted = mountLive(() => watch.view(), {
      ansi: ui.ansi,
      quiet: true,
      terminal: ui.terminal,
    });

    await t.advance(5000);
    flush();
    await vi.advanceTimersByTimeAsync(100);
    mounted.stop();

    expect(ui.output).to.equal('');
  });

  it('should leave a piped log without a readout that would be wrong', async () => {
    const { stdout, terminal } = setup({ isTTY: false });
    const t = time();
    const watch = stopwatch({ now: t.now, terminal }).start();
    const mounted = mountLive(() => watch.view(), { terminal });

    await t.advance(5000);
    flush();
    mounted.done();

    expect(stdout.text.trim()).to.equal('');
  });

  it('should still run a timer out, because the action it counts down to must happen', async () => {
    const t = time();
    const down = timer(3000, { now: t.now, quiet: true }).start();

    await t.advance(3000);

    expect(await down.done).to.equal(true);
  });

  it('should hold no redraw timer once the timer has run out', async () => {
    const { terminal } = setup({ isTTY: true });
    const t = time();
    const down = timer(2000, { now: t.now, terminal }).start();

    await t.advance(2000);

    expect(down.finished).to.equal(true);
    expect(vi.getTimerCount()).to.equal(0);
  });
});
