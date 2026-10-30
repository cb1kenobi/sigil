import { box, type Element, text as textNode } from '../element/index.js';
import { __ } from '../i18n/index.js';
import { createEffect } from '../renderer/index.js';
import { State } from '../signals/index.js';
import { type Terminal, terminal as defaultTerminal } from '../terminal/index.js';
import { stringWidth } from '../width/index.js';
import { type Mounted, type MountOptions, mountLevel, mountLive } from './mount.js';

/**
 * What a bar says about the pace of the work, beside the percentage.
 *
 * Off unless asked for: a bar that has always drawn `label bar 42%` goes on
 * drawing exactly that, and a rate and a time remaining are two more things on a
 * line that is already as wide as a third of the screen.
 */
export interface ProgressStatsOptions {
  /** Shows the time remaining beside the percentage. Defaults to false. */
  eta?: boolean;
  /** Reads the clock, in milliseconds. Defaults to `performance.now()`; a test passes its own. */
  now?: () => number;
  /** Shows how fast the work is going, in units a second. Defaults to false. */
  rate?: boolean;
  /** What a unit of work is called, shown after the rate: `files` reads `3.2 files/s`. */
  unit?: string;
  /**
   * The estimator's time constant, in milliseconds. Defaults to 5000.
   *
   * How long the estimate takes to forget how fast the work *was* going: a
   * longer window gives a steadier number and is slower to follow a change in
   * pace.
   */
  window?: number;
}

export interface ProgressOptions extends MountOptions, ProgressStatsOptions {
  /** The character drawn for the part still to do. Defaults to a light block. */
  empty?: string;
  /** The character drawn for the part done. Defaults to a full block. */
  filled?: string;
  /** A label shown before the bar. */
  text?: string;
  /** How wide the bar itself is. Defaults to a third of the terminal, 10-40. */
  barWidth?: number;
  /** How often a plain log line is written when there is no terminal, in percent. Defaults to 10. */
  step?: number;
  /** How many units of work there are. Defaults to 100. */
  total?: number;
}

export interface Progress {
  /** How far along, between 0 and `total`. Assigning redraws. */
  current: number;
  /** Stops, leaving the bar on screen. */
  done(text?: string): void;
  /** Moves forward by `delta`, one by default. */
  tick(delta?: number): void;
  /** Stops and erases, leaving nothing behind. */
  stop(): void;
  /** The label. Assigning redraws. */
  text: string;
  /** How much work there is. Assigning redraws. */
  total: number;
  /** Writes a line that stays, above the bar. */
  write(text: string): void;
}

/**
 * Renders the bar itself.
 *
 * @param ratio - How far along, 0 to 1.
 * @param width - How many columns the bar occupies.
 * @param filled - The character for the part done.
 * @param empty - The character for the part left.
 * @returns The bar.
 */
export function renderBar(ratio: number, width: number, filled: string, empty: string): string {
  const columns = Math.max(1, Math.floor(width));

  // the characters may be wider than one column -- a full block is one, but
  // nothing stops a caller passing an emoji -- and a bar measured in characters
  // would then be twice the width it was asked for and wrap
  const per = Math.max(1, stringWidth(filled), stringWidth(empty));
  const cells = Math.max(1, Math.floor(columns / per));

  const clamped = Math.min(1, Math.max(0, Number.isFinite(ratio) ? ratio : 0));
  const done = Math.round(clamped * cells);

  return filled.repeat(done) + empty.repeat(cells - done);
}

/** What a progress bar's tree is driven by, and what the facade writes to. */
export interface ProgressState {
  /** How far along. */
  readonly current: State<number>;
  /**
   * The rate and the time remaining, already worded; empty when there is
   * nothing to say. Written by `trackProgress()` and absent on a state somebody
   * built by hand, which draws without it.
   */
  readonly detail?: State<string>;
  /** The label. */
  readonly label: State<string>;
  /** How much work there is. */
  readonly total: State<number>;
}

/**
 * Builds the state a progress bar's tree reads.
 *
 * @param label - The label.
 * @param total - How much work there is.
 * @returns The signals.
 */
export function progressState(label = '', total = 100): ProgressState {
  return {
    current: new State(0),
    detail: new State(''),
    label: new State(label),
    total: new State(total),
  };
}

export interface ProgressViewOptions {
  /** How wide the bar is, in columns. */
  barWidth: () => number;
  /**
   * How the row lines up with others beside it, for a bar that is one of several.
   *
   * With it, the label is at least as wide as `label()` says and the percentage
   * has a column of its own, so a group of rows reads as a table; without it
   * each row is as wide as what it says, which is what one bar wants.
   */
  columns?: { label: () => number };
  /** The character for the part left. */
  empty: string;
  /** The character for the part done. */
  filled: string;
  /**
   * Whether there is a terminal to draw a bar on.
   *
   * There is no bar in a log file. A bar redrawn a thousand times is a thousand
   * lines of nothing anybody will read, and the percentage is the whole of what
   * it was saying -- so the plain form is the label and a percentage rounded
   * down to `step`, which is what makes consecutive frames identical and lets
   * the backend write one line per change rather than one per tick.
   */
  live: boolean;
  /** How often the plain form changes, in percent. */
  step: number;
}

/**
 * The progress bar, as an element tree.
 *
 * @param state - What it reads.
 * @param opts - How the bar is drawn.
 * @returns The tree.
 */
export function progressView(state: ProgressState, opts: ProgressViewOptions): Element {
  const label = textNode('', { class: 'sigil-progress-label', 'margin-right': 1 });
  const bar = textNode('', { class: 'sigil-progress-bar sigil-accent', 'margin-right': 1 });
  const percent = textNode('', {
    class: 'sigil-progress-percent',
    ...(opts.columns ? { 'min-width': 4, 'text-align': 'right' } : {}),
  });
  const detail = textNode('', {
    class: 'sigil-progress-detail sigil-muted',
    display: 'none',
    'margin-left': 1,
  });

  const ratio = (): number => {
    const total = state.total.get();
    return total > 0 ? state.current.get() / total : 0;
  };

  createEffect(() => {
    const text = state.label.get();
    const width = opts.columns?.label() ?? 0;
    label.setText(text);
    // the margin is what separates it from the bar, so a label nobody set must
    // not leave one: `display: none` takes its margin with it. In a group a
    // row with no label still holds the column its neighbours' labels are in
    label.setProps({
      display: text === '' && width === 0 ? 'none' : 'flex',
      // only in a group: a floor of zero is not the same declaration as none,
      // because it lets the label shrink where the default would not
      ...(opts.columns ? { 'min-width': width } : {}),
    });
  });

  createEffect(() => {
    bar.setText(opts.live ? renderBar(ratio(), opts.barWidth(), opts.filled, opts.empty) : '');
    bar.setProps({ display: opts.live ? 'flex' : 'none' });
  });

  createEffect(() => {
    const whole = Math.floor(Math.min(1, Math.max(0, ratio())) * 100);
    // a bar that finished says so, whatever `step` divides into: stepping alone
    // left `step: 30` ending its log at 90%, and a bar whose last word is 90%
    // is one the reader cannot tell from a build that stopped there
    const shown = opts.live || whole === 100 ? whole : Math.floor(whole / opts.step) * opts.step;
    percent.setText(`${shown}%`);
  });

  // only where there is a bar to be beside: the plain form is a line in a log
  // and a rate in it would change on every tick, which is what stepping the
  // percentage exists to stop
  createEffect(() => {
    const said = opts.live ? (state.detail?.get() ?? '') : '';
    detail.setText(said);
    detail.setProps({ display: said === '' ? 'none' : 'flex' });
  });

  return box({ class: 'sigil-progress' }, label, bar, percent, detail);
}

/**
 * How wide a bar is when nobody said: a third of the screen, 10 to 40.
 *
 * A third so the label and the percentage have room, and bounded so it is
 * neither a stub on a narrow terminal nor absurd on a wide one. One function
 * because a group of bars and a single bar are the same bar.
 *
 * @param asked - The width the caller asked for, if any.
 * @param terminal - What the default is a third of.
 * @returns Columns.
 */
export function resolveBarWidth(asked: number | undefined, terminal: Terminal): number {
  if (asked && asked > 0) {
    return Math.floor(asked);
  }

  return Math.min(40, Math.max(10, Math.floor(terminal.width / 3)));
}

/** How long a time constant is when nobody said, in milliseconds. */
const WINDOW = 5000;

/**
 * Samples closer together than this are folded into the next one, in
 * milliseconds. A rate taken over a millisecond is noise: a loop that ticks
 * five times in one turn would read as five thousand a second.
 */
const MIN_INTERVAL = 100;

/** An estimate past this many seconds is not one anybody can act on. */
const MAX_ETA = 100 * 3600;

export interface RateEstimatorOptions {
  /** Reads the clock, in milliseconds. Defaults to `performance.now()`. */
  now?: () => number;
  /** The time constant, in milliseconds. Defaults to 5000. */
  window?: number;
}

/** How fast work is going, and so how long is left. */
export interface RateEstimator {
  /**
   * How long the rest will take at the current pace, in seconds.
   *
   * @param remaining - Units of work left.
   * @param at - When to ask, in the clock's terms. Defaults to now.
   * @returns Seconds, `0` where nothing is left, or `undefined` while there is
   *   no pace to go on.
   */
  eta(remaining: number, at?: number): number | undefined;
  /**
   * How fast the work is going, in units a second.
   *
   * Decays towards zero while nothing is reported, so a stalled job's estimate
   * lengthens on its own rather than staying at the last good number.
   *
   * @param at - When to ask. Defaults to now.
   * @returns Units a second, or `undefined` before there is anything to go on.
   */
  rate(at?: number): number | undefined;
  /**
   * Starts again from a value, forgetting the pace so far.
   *
   * @param value - Where the work now stands. Defaults to 0.
   */
  reset(value?: number): void;
  /**
   * Reports how far along the work is.
   *
   * @param value - Units done so far. A value lower than the last one starts again.
   * @param at - When it was true. Defaults to now.
   */
  update(value: number, at?: number): void;
}

/**
 * An estimator of rate and time remaining that does not jump.
 *
 * An exponentially weighted moving average of the pace, with a **time**
 * constant rather than a sample count: each sample is weighted by how long it
 * covers, so a loop that reports every millisecond and one that reports every
 * second settle on the same number, and a burst of ticks does not outvote the
 * seconds before it. The first sample is the pace so far, which is the honest
 * answer when it is all there is.
 *
 * @param opts - The clock and the time constant.
 * @returns The estimator.
 */
export function createRateEstimator(opts: RateEstimatorOptions = {}): RateEstimator {
  const now = opts.now ?? ((): number => performance.now());
  const tau = opts.window && opts.window > 0 ? opts.window : WINDOW;

  let lastT = now();
  let lastV = 0;
  let pace: number | undefined;

  const rate = (at = now()): number | undefined => {
    if (pace === undefined) {
      return undefined;
    }
    const idle = at - lastT;
    return idle > 0 ? pace * Math.exp(-idle / tau) : pace;
  };

  return {
    eta(remaining, at) {
      if (remaining <= 0) {
        return 0;
      }
      const per = rate(at);
      if (per === undefined || !(per > 0)) {
        return undefined;
      }
      const seconds = remaining / per;
      return seconds > MAX_ETA ? undefined : seconds;
    },

    rate,

    reset(value = 0) {
      lastT = now();
      lastV = value;
      pace = undefined;
    },

    update(value, at = now()) {
      if (value < lastV) {
        lastT = at;
        lastV = value;
        pace = undefined;
        return;
      }

      const dt = at - lastT;
      if (dt < MIN_INTERVAL) {
        // not consumed: the next sample covers this one's work as well, which
        // is the point of waiting
        return;
      }

      const instant = ((value - lastV) / dt) * 1000;
      pace = pace === undefined ? instant : pace + (1 - Math.exp(-dt / tau)) * (instant - pace);
      lastT = at;
      lastV = value;
    },
  };
}

/**
 * A duration, as a person reads one: `42s`, `3m 05s`, `2h 10m`.
 *
 * Through the catalog, so a locale can word the units. Whole units only: a time
 * remaining is an estimate and a decimal on it is false precision.
 *
 * @param seconds - How long.
 * @returns The text.
 */
export function formatDuration(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  const two = (n: number): string => String(n).padStart(2, '0');

  if (total < 60) {
    return __`${total}s`;
  }
  if (total < 3600) {
    return __`${Math.floor(total / 60)}m ${two(total % 60)}s`;
  }
  return __`${Math.floor(total / 3600)}h ${two(Math.floor((total % 3600) / 60))}m`;
}

/**
 * A rate, as `3.2/s` or `120 files/s`.
 *
 * One decimal below ten and whole numbers above, because that is where a
 * decimal stops being information. The separator is a full stop whatever the
 * locale: the number is not formatted through `Intl`, which costs more to load
 * than anything else in here.
 *
 * @param perSecond - Units a second.
 * @param unit - What a unit is called.
 * @returns The text.
 */
export function formatRate(perSecond: number, unit?: string): string {
  const n = perSecond < 10 ? perSecond.toFixed(1) : String(Math.round(perSecond));
  return unit ? __`${n} ${unit}/s` : __`${n}/s`;
}

/** What `trackProgress()` hands back. */
export interface ProgressTracker {
  /** Reports the state as it now stands, and rewrites its `detail`. */
  update(): void;
}

/**
 * Keeps a bar's rate and time remaining up to date.
 *
 * Called by whoever writes `current` or `total`, after they have: the estimator
 * is fed from the state so the two cannot disagree about where the work is, and
 * `detail` is written here rather than computed by the view so that the view is
 * a function of its state alone. Does nothing, and builds nothing, for a bar
 * that asked for neither a rate nor a time.
 *
 * Says nothing once the work is finished: a time remaining of zero is not
 * information, and an average rate on a finished bar is a summary somebody
 * else's `done()` text is better placed to give.
 *
 * @param state - The bar.
 * @param opts - What to say, and the clock.
 * @returns The tracker.
 */
export function trackProgress(state: ProgressState, opts: ProgressStatsOptions): ProgressTracker {
  if (!state.detail || (!opts.rate && !opts.eta)) {
    return { update() {} };
  }

  const { detail } = state;
  const estimator = createRateEstimator(opts);

  return {
    update() {
      const done = state.current.get();
      const total = state.total.get();
      estimator.update(done);

      const parts: string[] = [];
      if (done < total) {
        const per = estimator.rate();
        if (opts.rate && per !== undefined) {
          parts.push(formatRate(per, opts.unit));
        }
        const left = opts.eta ? estimator.eta(total - done) : undefined;
        if (left !== undefined) {
          parts.push(__`ETA ${formatDuration(left)}`);
        }
      }
      detail.set(parts.join('  '));
    },
  };
}

/**
 * A progress bar, for work whose length is known.
 *
 * Where there is no terminal the bar is not drawn at all: a CI log gets a line
 * every `step` percent instead, because a bar redrawn a thousand times is a
 * thousand lines of nothing anybody will read.
 *
 * @param opts - What it says and how it looks.
 * @returns The bar, drawn at zero.
 */
export function createProgress(opts: ProgressOptions = {}): Progress {
  const filled = opts.filled ?? '█';
  const empty = opts.empty ?? '░';
  const step = opts.step && opts.step > 0 ? opts.step : 10;
  const state = progressState(opts.text ?? '', opts.total && opts.total > 0 ? opts.total : 100);
  // resolved up front rather than off the backend, because `barWidth()` is read
  // by an effect during the very first render -- which happens inside
  // `mountLive()`, before there is a handle to ask
  const terminal = opts.terminal ?? opts.backend?.terminal ?? defaultTerminal;

  const barWidth = (): number => resolveBarWidth(opts.barWidth, terminal);
  const track = trackProgress(state, opts);

  const mounted: Mounted = mountLive(
    // `live` is the resolved level read as a boolean: a bar is what a screen
    // wants and a percentage is what a log wants, and a reduced-motion
    // preference is somebody asking for the second -- a bar that fills is the
    // thing that moves
    (level) => progressView(state, { barWidth, empty, filled, live: level === 'live', step }),
    { ...opts, terminal }
  );

  function clamp(next: number): number {
    return Math.min(state.total.get(), Math.max(0, next));
  }

  /**
   * Settles the graph and paints, which is what every setter here owes.
   *
   * Asks the fold rather than reusing the mount's answer, which is the rule the
   * other three facades' `write()` keeps and is needed here for the same reason
   * one level up: this is the **one** built-in that mounts as it is built, which
   * is what "drawn at zero" means -- so its level is resolved before `main()`
   * has read argv, and a bar built in a command module's own body kept drawing
   * through a `--quiet` run. Measured: `early 0%` and then every update.
   *
   * What it cannot take back is the frame the construction itself painted, and
   * that is the eager mount rather than this: deferring it is what would close
   * the last line, and it would cost the zero frame, which is the piped output
   * this feature promised not to move -- measured, `createProgress()` alone
   * writes `early 0%`. So the residue is one line, in the one order that
   * reaches it. The fold is 0.1 microseconds, against a layout and a paint.
   */
  function draw(): void {
    if (mountLevel({ ...opts, terminal }) === 'quiet') {
      return;
    }
    mounted.frame();
  }

  return {
    get current() {
      return state.current.get();
    },

    set current(next: number) {
      state.current.set(clamp(next));
      track.update();
      draw();
    },

    /**
     * `draw()` is gated and `mounted.done()` is deliberately not.
     *
     * What the mount does on the way out is **give the terminal back** -- the
     * inline backend writes a newline and shows the cursor, and `stop()` erases
     * the region and shows it -- which is not progress at all. A quiet run that
     * left the cursor hidden is the terminal-eating failure `Terminal.restore()`
     * is written for, so those bytes survive quiet the way an error does.
     *
     * Measured on a terminal, for a bar built loud and then asked to be quiet:
     * `stop()` is eleven bytes of erase-and-show and `done()` is eight of
     * newline-and-show, and neither is a percentage. The erase is also what
     * takes the construction frame the comment above calls residue back off a
     * screen, which is the better answer rather than a cost.
     *
     * @param final - What to say instead, if anything.
     */
    done(final?: string): void {
      if (final !== undefined) {
        state.label.set(final);
      }
      state.current.set(state.total.get());
      track.update();
      draw();
      mounted.done();
    },

    /** Gives the terminal back, for the reason `done()` records. */
    stop(): void {
      mounted.stop();
    },

    get text() {
      return state.label.get();
    },

    set text(next: string) {
      state.label.set(next);
      draw();
    },

    tick(delta = 1): void {
      this.current = state.current.get() + delta;
    },

    get total() {
      return state.total.get();
    },

    set total(next: number) {
      state.total.set(next > 0 ? next : 1);
      state.current.set(clamp(state.current.get()));
      track.update();
      draw();
    },

    write(line: string): void {
      // the same question `draw()` asks, for the same reason
      if (mountLevel({ ...opts, terminal }) === 'quiet') {
        return;
      }
      mounted.write(line);
    },
  };
}
