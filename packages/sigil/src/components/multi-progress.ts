import type { Element } from '../element/index.js';
import { For } from '../renderer/index.js';
import { State } from '../signals/index.js';
import { terminal as defaultTerminal } from '../terminal/index.js';
import { stringWidth } from '../width/index.js';
import { type Mounted, type MountOptions, mountLevel, mountLive } from './mount.js';
import {
  type ProgressState,
  type ProgressStatsOptions,
  progressState,
  progressView,
  type ProgressViewOptions,
  resolveBarWidth,
  trackProgress,
} from './progress.js';

export interface MultiProgressOptions extends MountOptions, ProgressStatsOptions {
  /** How wide each bar itself is. Defaults to a third of the terminal, 10-40. */
  barWidth?: number;
  /** The character drawn for the part still to do. Defaults to a light block. */
  empty?: string;
  /** The character drawn for the part done. Defaults to a full block. */
  filled?: string;
  /**
   * Whether a bar that finished stays in the frame. Defaults to true.
   *
   * A group of six downloads ends as a summary of six. `false` is for a long
   * list where only the bars still going are worth the rows: a finished bar's
   * line is written above the frame instead and its row goes.
   */
  keep?: boolean;
  /** How often a plain log line is written for each bar when there is no terminal, in percent. Defaults to 10. */
  step?: number;
}

export interface MultiProgressBarOptions {
  /** A label shown before the bar. */
  text?: string;
  /** How many units of work there are. Defaults to 100. */
  total?: number;
  /** What a unit is called, for this bar's rate. Defaults to the group's. */
  unit?: string;
}

/** One bar in a `MultiProgress`. */
export interface MultiProgressBar {
  /** How far along, between 0 and `total`. Assigning redraws. */
  current: number;
  /** Finishes this bar at `total`, optionally relabelling it. The others go on. */
  done(text?: string): void;
  /** Whether `done()` or `stop()` has been called on it. */
  readonly finished: boolean;
  /** Takes this bar out of the group, leaving nothing of it behind. */
  stop(): void;
  /** The label. Assigning redraws. */
  text: string;
  /** Moves forward by `delta`, one by default. */
  tick(delta?: number): void;
  /** How much work there is. Assigning redraws. */
  total: number;
}

export interface MultiProgress {
  /** Adds a bar, drawn at zero. */
  add(opts?: MultiProgressBarOptions): MultiProgressBar;
  /** Ends the group, leaving every bar as it stands. */
  done(): void;
  /** Ends the group and erases it, leaving nothing behind. */
  stop(): void;
  /** Writes a line that stays, above the bars. */
  write(text: string): void;
}

/**
 * A group of progress bars, as an element tree.
 *
 * One row per bar, built by `For` so that a bar can be added or taken out
 * without rebuilding the others, and each row keeps its own effects for as long
 * as it is there.
 *
 * @param rows - The bars, in the order they were added.
 * @param labelWidth - How wide the widest label is, so the bars start in a column.
 * @param opts - How each bar is drawn.
 * @returns The tree.
 */
export function multiProgressView(
  rows: State<readonly ProgressState[]>,
  labelWidth: State<number>,
  opts: ProgressViewOptions
): Element {
  const columns = { label: () => labelWidth.get() };

  return For({
    children: (state) => progressView(state, { ...opts, columns }),
    each: () => rows.get(),
    props: { class: 'sigil-multiprogress', 'flex-direction': 'column' },
  });
}

/**
 * Several progress bars at once, in one live region.
 *
 * Each bar is added and finished on its own -- a parallel download, a
 * multi-package install -- and the group is what owns the screen, because two
 * live regions cannot share the bottom of it. Pass `rate` and `eta` for a pace
 * and a time remaining beside each bar.
 *
 * Where there is no terminal there are no bars and no frame: each bar writes a
 * line of its own every `step` percent, labelled, which is what a CI log can
 * follow when six of them are interleaved. A quiet run writes nothing.
 *
 * @param opts - How the bars look and where they draw.
 * @returns The group, with no bars in it yet.
 */
export function createMultiProgress(opts: MultiProgressOptions = {}): MultiProgress {
  const filled = opts.filled ?? '█';
  const empty = opts.empty ?? '░';
  const step = opts.step && opts.step > 0 ? opts.step : 10;
  const keep = opts.keep !== false;
  const terminal = opts.terminal ?? opts.backend?.terminal ?? defaultTerminal;
  const base = { ...opts, terminal };

  const rows = new State<readonly ProgressState[]>([]);
  const labelWidth = new State(0);

  /** Mounted on the first bar, and again on the first one after the group ended. */
  let mounted: Mounted | undefined;

  /**
   * Which run of the group a bar belongs to.
   *
   * A bar from before `done()` or `stop()` is a bar of a screen that has been
   * given back, and a change to it must not paint -- or write a line -- into
   * whatever the terminal is doing now.
   */
  let generation = 0;

  const quiet = (): boolean => mountLevel(base) === 'quiet';

  function mount(): void {
    if (mounted || quiet() || !terminal.isTTY || terminal.closed) {
      return;
    }
    mounted = mountLive(
      (level) =>
        multiProgressView(rows, labelWidth, {
          barWidth: () => resolveBarWidth(opts.barWidth, terminal),
          empty,
          filled,
          live: level === 'live',
          step,
        }),
      base
    );
  }

  /** Lets go of the region, and of the bars that were drawn in it. */
  function release(): void {
    generation++;
    mounted = undefined;
    rows.set([]);
    labelWidth.set(0);
  }

  /**
   * Works the label column out again from the bars that are there.
   *
   * From the rows rather than by growing: a bar that left, or was relabelled
   * shorter, should not keep a column open for a label nobody can see.
   */
  function measure(): void {
    let widest = 0;
    for (const row of rows.get()) {
      widest = Math.max(widest, stringWidth(row.label.get()));
    }
    labelWidth.set(widest);
  }

  /** The plain form of a bar: its label and its percentage, rounded down to `step`. */
  function plain(state: ProgressState): string {
    const total = state.total.get();
    const whole = Math.floor(
      Math.min(1, Math.max(0, total > 0 ? state.current.get() / total : 0)) * 100
    );
    // finished is finished whatever `step` divides into, for the reason the
    // single bar records
    const shown = whole === 100 ? whole : Math.floor(whole / step) * step;
    const label = state.label.get();
    return label === '' ? `${shown}%` : `${label} ${shown}%`;
  }

  function write(text: string): void {
    if (quiet()) {
      return;
    }
    if (mounted) {
      mounted.write(text);
    } else {
      terminal.write(`${text}\n`);
    }
  }

  return {
    add(barOpts = {}): MultiProgressBar {
      const total = barOpts.total && barOpts.total > 0 ? barOpts.total : 100;
      const state = progressState(barOpts.text ?? '', total);
      const track = trackProgress(state, { ...opts, unit: barOpts.unit ?? opts.unit });
      const mine = generation;
      let finished = false;
      let lastLine: string | undefined;

      /**
       * Gets a change in this bar in front of the reader.
       *
       * Asks the fold each time, for the reason the single bar does: a request
       * to be quiet that arrives after the bar was built still applies.
       */
      function draw(): void {
        if (mine !== generation || quiet()) {
          return;
        }
        if (mounted) {
          mounted.frame();
          return;
        }
        // no frame to repaint, so the bar is a line, written when it changes
        const line = plain(state);
        if (line !== lastLine) {
          lastLine = line;
          terminal.write(`${line}\n`);
        }
      }

      function clamp(next: number): number {
        return Math.min(state.total.get(), Math.max(0, next));
      }

      rows.set([...rows.get(), state]);
      measure();
      mount();
      draw();

      const bar: MultiProgressBar = {
        get current() {
          return state.current.get();
        },

        set current(next: number) {
          state.current.set(clamp(next));
          track.update();
          draw();
        },

        done(text?: string): void {
          if (finished) {
            return;
          }
          finished = true;
          if (text !== undefined) {
            state.label.set(text);
            measure();
          }
          state.current.set(state.total.get());
          track.update();

          if (mounted && !keep && mine === generation) {
            // the line a log would have ended on, written above the frame, and
            // the row it came from gone
            const line = plain(state);
            rows.set(rows.get().filter((row) => row !== state));
            measure();
            if (!quiet()) {
              mounted.write(line);
            }
          }
          draw();
        },

        get finished() {
          return finished;
        },

        stop(): void {
          finished = true;
          rows.set(rows.get().filter((row) => row !== state));
          measure();
          if (mounted && mine === generation && !quiet()) {
            mounted.frame();
          }
        },

        get text() {
          return state.label.get();
        },

        set text(next: string) {
          state.label.set(next);
          measure();
          draw();
        },

        tick(delta = 1): void {
          bar.current = state.current.get() + delta;
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
      };

      return bar;
    },

    /**
     * Gives the terminal back, and leaves the bars where they are.
     *
     * Not gated by the fold, for the reason a single bar's `done()` is not:
     * what the mount does on the way out is hand the cursor back, which is not
     * progress.
     */
    done(): void {
      if (mounted && !quiet()) {
        mounted.frame();
      }
      mounted?.done();
      release();
    },

    stop(): void {
      mounted?.stop();
      release();
    },

    write,
  };
}
