import { type Element, text as textNode } from '../element/index.js';
import { createEffect } from '../renderer/index.js';
import { State } from '../signals/index.js';
import { type MountOptions, mountLevel } from './mount.js';
import { formatDuration } from './progress.js';

/**
 * How a clock writes the time.
 *
 * `words` is `42s`, `3m 05s` and `2h 10m`, through the catalog so a locale can
 * word the units. `clock` is `00:42`, `03:05` and `2:10:00`: digits and colons,
 * which is not a thing a locale words. A function is handed whole seconds.
 */
export type ClockFormat = 'clock' | 'words' | ((seconds: number) => string);

export interface ClockOptions extends Pick<MountOptions, 'quiet' | 'reducedMotion' | 'terminal'> {
  /** How the time is written. Defaults to `words`. */
  format?: ClockFormat;
  /** Reads the clock, in milliseconds. Defaults to `performance.now()`; a test passes its own. */
  now?: () => number;
  /**
   * How often a readout is redrawn, in milliseconds. Defaults to 1000.
   *
   * Redraws land on the boundary rather than a tick after the last one, so a
   * slow turn of the event loop shows once and does not push every later second
   * back. Only a readout is redrawn on this: what `elapsed` and `remaining` say is
   * read off the clock and is never a tick old.
   */
  tick?: number;
}

/** What a stopwatch and a timer have in common. */
export interface Clock {
  /** Milliseconds counted so far, read off the clock. Read in an effect, it re-runs each tick. */
  readonly elapsed: number;
  /**
   * Whether a readout of this clock is drawn: it has been started, and the
   * output is a terminal that repaints.
   *
   * Asked of the quiet fold on each `start()`, the way a facade's `write()` asks.
   */
  readonly live: boolean;
  /** Holds the count where it is. A clock that is not running has no timer. */
  pause(): void;
  /** Whether it is counting. */
  readonly running: boolean;
  /** Back to nothing counted. A clock that was running goes on running from zero. */
  reset(): void;
  /** Starts, or resumes where `pause()` left it. Returns the clock. */
  start(): Clock;
  /** The time, as `format` writes it. Read in an effect, it re-runs each tick. */
  readonly text: string;
  /** The readout, as an element tree. */
  view(): Element;
}

/** Counts up. */
export type Stopwatch = Clock;

/** Counts down from a duration, and says when it gets there. */
export interface Timer extends Clock {
  start(): Timer;
  /** Ends it without it getting there: `done` settles `false` and the clock stops. */
  cancel(): void;
  /**
   * Settles when the count reaches zero: `true` for a timer that ran out and
   * `false` for one that was cancelled.
   *
   * Never rejects. Settles whatever the output is, a quiet run included: a
   * countdown before an action is behaviour, and only its readout is progress.
   * A pending one holds the process open, because somebody is waiting on it --
   * which is the one way this differs from the redraw timer, and the reason a
   * paused timer does not.
   */
  readonly done: Promise<boolean>;
  /** Whether the count has reached zero. */
  readonly finished: boolean;
  /** Milliseconds left, read off the clock. Read in an effect, it re-runs each tick. */
  readonly remaining: number;
}

/**
 * Writes whole seconds as digits: `00:42`, `03:05`, `2:10:00`.
 *
 * @param seconds - How long.
 * @returns The text.
 */
export function formatClock(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  const two = (n: number): string => String(n).padStart(2, '0');
  const hours = Math.floor(total / 3600);
  const rest = `${two(Math.floor((total % 3600) / 60))}:${two(total % 60)}`;
  return hours > 0 ? `${hours}:${rest}` : rest;
}

/** The longest a timer can be asked to wait, in milliseconds: 2^31 - 1. */
const MAX_DELAY = 2147483647;

/**
 * A clock's readout, as an element tree.
 *
 * Hidden outright where the clock is not live, for the reason a bar's rate is: a
 * stopwatch in a log would say `0s` once and then nothing, which is a wrong
 * number rather than a missing one -- and `display: none` is what keeps its margin
 * from becoming a space in a line somebody greps.
 *
 * @param clock - What it reads.
 * @returns The tree.
 */
export function clockView(clock: Pick<Clock, 'live' | 'text'>): Element {
  const readout = textNode('', { class: 'sigil-clock', display: 'none' });

  createEffect(() => {
    const said = clock.live ? clock.text : '';
    readout.setText(said);
    readout.setProps({ display: said === '' ? 'none' : 'flex' });
  });

  return readout;
}

/**
 * The shared half: a count of milliseconds, and what keeps it on screen.
 *
 * The time is never stored. It is `base` plus what has passed since `startedAt`,
 * read off the clock whenever it is asked, so a quiet run -- which draws nothing
 * and ticks nothing -- still answers correctly. What a tick *is*, is a signal
 * written so that whatever read the time in an effect reads it again.
 */
function createClock(limit: number | undefined, opts: ClockOptions): Timer {
  const now = opts.now ?? ((): number => performance.now());
  const tick = opts.tick && opts.tick > 0 ? opts.tick : 1000;
  const format = opts.format ?? 'words';

  const ticks = new State(0);
  const isRunning = new State(false);
  const isLive = new State(false);

  /** What was counted before the current run began. */
  let base = 0;
  let startedAt = 0;
  let redraw: ReturnType<typeof setTimeout> | undefined;
  let deadline: ReturnType<typeof setTimeout> | undefined;

  let settle: (ran: boolean) => void = () => {};
  let settled = false;
  let done = new Promise<boolean>((resolve) => {
    settle = resolve;
  });

  const spent = (): number => {
    const total = base + (isRunning.get() ? Math.max(0, now() - startedAt) : 0);
    return limit === undefined ? total : Math.min(limit, total);
  };

  /** Reads through `ticks`, so that an effect that asks re-runs when it moves. */
  const read = (): number => {
    ticks.get();
    return spent();
  };

  const left = (): number => (limit === undefined ? 0 : Math.max(0, limit - spent()));

  const bump = (): void => {
    ticks.set(ticks.get() + 1);
  };

  const words = (): string => {
    // floor counts up and ceil counts down, so that both are the whole
    // seconds a person would read off a watch: a timer with 400 ms left says
    // `1s`, and says `0s` only when it is over
    const seconds = limit === undefined ? Math.floor(spent() / 1000) : Math.ceil(left() / 1000);
    if (typeof format === 'function') {
      return format(seconds);
    }
    return format === 'clock' ? formatClock(seconds) : formatDuration(seconds);
  };

  function clearTimers(): void {
    clearTimeout(redraw);
    clearTimeout(deadline);
    redraw = undefined;
    deadline = undefined;
  }

  /**
   * Arms the next redraw, on the next boundary of what is shown.
   *
   * Counting up the readout changes when the elapsed time crosses a multiple of
   * a tick; counting down, when the time left does. Unreferenced, like the
   * spinner's: a readout is not a reason for a finished program to stay alive.
   */
  function arm(): void {
    if (!isRunning.get() || !isLive.get()) {
      return;
    }
    const at = limit === undefined ? spent() : left();
    const rest = limit === undefined ? tick - (at % tick) : at % tick || tick;
    redraw = setTimeout(() => {
      redraw = undefined;
      bump();
      arm();
    }, rest);
    redraw.unref?.();
  }

  /** Where a timer ends up: stopped at its limit, with `done` settled. */
  function finish(): void {
    base = limit ?? base;
    isRunning.set(false);
    clearTimers();
    bump();
    if (!settled) {
      settled = true;
      settle(true);
    }
  }

  /** The timer's end. Referenced, because somebody is waiting for it. */
  function watch(): void {
    if (limit === undefined || !isRunning.get()) {
      return;
    }
    deadline = setTimeout(
      () => {
        deadline = undefined;
        // a timer may fire a moment before the clock says it is time, and
        // finishing early would be saying zero while there is still some left
        if (left() > 0) {
          watch();
          return;
        }
        base = limit;
        isRunning.set(false);
        clearTimers();
        bump();
        settled = true;
        settle(true);
        // a delay past what a timer can hold is one it fires at once, so a
        // long countdown is waited for in pieces
      },
      Math.min(left(), MAX_DELAY)
    );
  }

  /** Takes what has been counted into `base`, and stops counting. */
  function freeze(): void {
    if (isRunning.get()) {
      base = spent();
      isRunning.set(false);
    }
    clearTimers();
  }

  const clock = {
    cancel(): void {
      freeze();
      bump();
      if (!settled) {
        settled = true;
        settle(false);
      }
    },

    get done() {
      return done;
    },

    get elapsed() {
      return read();
    },

    get finished() {
      return limit !== undefined && read() >= limit;
    },

    get live() {
      return isLive.get();
    },

    pause(): void {
      freeze();
      bump();
    },

    get remaining() {
      ticks.get();
      return left();
    },

    reset(): void {
      const was = isRunning.get();
      clearTimers();
      base = 0;
      startedAt = now();
      if (settled) {
        // a timer that had run out is a new one: the promise it settled is
        // spent, and whoever awaits the next run needs one of their own
        settled = false;
        done = new Promise<boolean>((resolve) => {
          settle = resolve;
        });
      }
      bump();
      if (was) {
        arm();
        watch();
      }
    },

    get running() {
      return isRunning.get();
    },

    start() {
      if (isRunning.get()) {
        return clock;
      }
      if (limit !== undefined && spent() >= limit) {
        // a duration of zero is over as it starts, and a timer that already
        // ran out stays out until it is reset
        finish();
        return clock;
      }
      // asked now rather than frozen at construction: a clock built in a
      // module's own body exists before `main()` has read argv, so a level read
      // then could never see `--quiet`
      isLive.set(mountLevel(opts) === 'live');
      startedAt = now();
      isRunning.set(true);
      bump();
      arm();
      watch();
      return clock;
    },

    get text() {
      ticks.get();
      isLive.get();
      return words();
    },

    view(): Element {
      return clockView(clock);
    },
  };

  return clock;
}

/**
 * A stopwatch: counts up from nothing while it is running.
 *
 * Signals first and a view second, because the readout is meant to sit beside
 * something else -- `Installing... 12s` is a spinner's text and `clock.text`,
 * and a countdown is a node in a tree the app already has. `elapsed` and `text`
 * are read off the clock, so they are right whenever they are asked; read inside
 * an effect they also re-run once a tick, which is the whole of the reactive
 * part.
 *
 * Only the redraw is gated by the output. On a terminal that repaints, a timer
 * wakes once a second to write a tick; piped, under reduced motion and quiet it
 * starts none, and `view()` draws nothing -- `elapsed` is still correct.
 *
 * @param opts - How the time is written, and where it is drawn.
 * @returns The stopwatch, not yet started.
 */
export function stopwatch(opts: ClockOptions = {}): Stopwatch {
  // the same object a timer is, without the half that is about a limit: a
  // stopwatch has no `done` to await and nothing it could run out of
  return createClock(undefined, opts) as unknown as Stopwatch;
}

/**
 * A timer: counts down from a duration while it is running.
 *
 * `done` is what a countdown before an action awaits. Everything `stopwatch()`
 * says about drawing holds, and nothing it says about timing is gated by the
 * output: the timer runs out in a quiet run, because the action it is a
 * countdown for still has to happen.
 *
 * @param duration - How long, in milliseconds. Zero is over as soon as it starts.
 * @param opts - How the time is written, and where it is drawn.
 * @returns The timer, not yet started.
 */
export function timer(duration: number, opts: ClockOptions = {}): Timer {
  if (typeof duration !== 'number' || !Number.isFinite(duration) || duration < 0) {
    throw new TypeError(`A timer takes a duration in milliseconds, not ${String(duration)}`);
  }
  return createClock(duration, opts);
}
