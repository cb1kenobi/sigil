import { box, type Element, text as textNode } from '../element/index.js';
import { createEffect, onCleanup } from '../renderer/index.js';
import { State } from '../signals/index.js';
import { terminal as defaultTerminal } from '../terminal/index.js';
import { stringWidth } from '../width/index.js';
import { type Mounted, type MountOptions, mountLive, writeLine } from './mount.js';
import { unicodeSupported } from './note.js';

/**
 * A spinner's frames, and how long each one lasts.
 *
 * Every frame of a set is the same width, so the text after it never moves, and
 * every set that is not plain ASCII is one cell wide -- which is why there is no
 * emoji set: an emoji is two columns where a terminal knows it is one and one
 * where it does not. `test/components/spinner-frames.test.ts` measures every
 * frame of every set this package ships.
 */
export interface SpinnerFrames {
  /** The frames, in order. */
  readonly frames: readonly string[];
  /** How long each frame lasts, in milliseconds. */
  readonly interval: number;
}

/**
 * The default frames, which are Braille dots: they animate smoothly, sit inside
 * one column, and are far more widely rendered than the block characters a
 * fancier spinner would use.
 */
export const DOTS: SpinnerFrames = {
  frames: ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'],
  interval: 80,
};

/**
 * Frames for a terminal that cannot be trusted with anything but ASCII, and the
 * default on one: `createSpinner()` draws these wherever `unicodeSupported()`
 * says no.
 */
export const LINE: SpinnerFrames = { frames: ['-', '\\', '|', '/'], interval: 130 };

/** A quarter circle that sweeps round. */
export const ARC: SpinnerFrames = { frames: ['◜', '◠', '◝', '◞', '◡', '◟'], interval: 100 };

/** A circle with a quarter filled, turning. */
export const CIRCLE: SpinnerFrames = { frames: ['◴', '◷', '◶', '◵'], interval: 120 };

/** A bar that grows and shrinks inside one cell. */
export const GROW: SpinnerFrames = {
  frames: ['▁', '▃', '▄', '▅', '▆', '▇', '▆', '▅', '▄', '▃'],
  interval: 120,
};

/** An arrow pointing round the compass. */
export const ARROW: SpinnerFrames = {
  frames: ['←', '↖', '↑', '↗', '→', '↘', '↓', '↙'],
  interval: 100,
};

/**
 * A bar bouncing between brackets, in ASCII.
 *
 * The one set wider than a cell, which is safe because it is ASCII: its width is
 * the same on every terminal there is.
 */
export const BOUNCING_BAR: SpinnerFrames = {
  frames: [
    '[    ]',
    '[=   ]',
    '[==  ]',
    '[=== ]',
    '[====]',
    '[ ===]',
    '[  ==]',
    '[   =]',
    '[    ]',
    '[   =]',
    '[  ==]',
    '[ ===]',
    '[====]',
    '[=== ]',
    '[==  ]',
    '[=   ]',
  ],
  interval: 80,
};

/**
 * How a spinner ends, and the mark it leaves.
 *
 * Exported so that `log` draws the same four: a status line and the spinner
 * that preceded it should agree about what a warning looks like.
 */
export const OUTCOME_SYMBOLS = {
  error: '✖',
  info: 'ℹ',
  success: '✔',
  warn: '⚠',
} as const;

/** One of the four ways a spinner settles. */
export type SpinnerOutcome = keyof typeof OUTCOME_SYMBOLS;

export interface SpinnerOptions extends MountOptions {
  /**
   * Draw the ASCII frames, `LINE`, when no `frames` are given. Defaults to what
   * `unicodeSupported()` says of `env` and `platform`, since a terminal that
   * cannot draw box drawing cannot draw braille either. Explicit `frames` win.
   */
  ascii?: boolean;
  /** The environment to read the terminal from. Defaults to `process.env`. */
  env?: Record<string, string | undefined>;
  /**
   * How long each frame lasts, in milliseconds. Defaults to the set's own
   * interval, or 80 for a bare array.
   */
  interval?: number;
  /** The platform to detect for. Defaults to `process.platform`. */
  platform?: string;
  /** What it is doing, shown after the spinner. */
  text?: string;
  /**
   * The frames to cycle: a set such as `ARC`, or an array of your own. Defaults
   * to `DOTS`, or to `LINE` where the terminal cannot be trusted with braille.
   */
  frames?: readonly string[] | SpinnerFrames;
}

export interface Spinner {
  /** Whether it is currently spinning. */
  readonly spinning: boolean;
  /** Stops, leaving `text` behind marked as failed. */
  fail(text?: string): void;
  /** Stops, leaving `text` behind marked as an informational note. */
  info(text?: string): void;
  /** Starts spinning, optionally changing the text first. */
  start(text?: string): Spinner;
  /** Stops and erases, leaving nothing behind. */
  stop(): void;
  /** Stops, leaving `text` behind marked as done. */
  succeed(text?: string): void;
  /** What it is doing. Assigning redraws it. */
  text: string;
  /** Stops, leaving `text` behind marked as a warning. */
  warn(text?: string): void;
  /** Writes a line that stays, above the spinner. */
  write(text: string): void;
}

/** What a spinner's tree is driven by, and what the facade writes to. */
export interface SpinnerState {
  /** How far through the frames, or `undefined` once it has settled. */
  readonly frame: State<number | undefined>;
  /** The mark it settled with, if it has. */
  readonly outcome: State<SpinnerOutcome | undefined>;
  /** What it is doing. */
  readonly label: State<string>;
}

/**
 * Builds the state a spinner's tree reads.
 *
 * @param label - What it is doing.
 * @returns The signals.
 */
export function spinnerState(label = ''): SpinnerState {
  return {
    frame: new State<number | undefined>(undefined),
    label: new State(label),
    outcome: new State<SpinnerOutcome | undefined>(undefined),
  };
}

/**
 * The spinner, as an element tree.
 *
 * One leading element rather than two, because what goes there is one thing at a
 * time: an animation frame while it runs and a mark once it has settled. Hidden
 * outright when there is neither -- a spinner in a CI log has no frames to show
 * and `display: none` is what keeps its margin from becoming a leading space in
 * a line somebody greps.
 *
 * The lead is given the width of what it draws, because a `normal` text drops
 * the whitespace at the end of its last line -- and so did `pre`, until SIG-207 --
 * so a frame such as `'.  '` was drawn one column wide, `'.. '` two and `'   '` none,
 * and the label jumped on every tick of a set whose frames were all three. The
 * rule is the paginator's, for the same reason.
 *
 * @param state - What it reads.
 * @param frames - The frames to cycle: a set, or an array.
 * @returns The tree.
 */
export function spinnerView(
  state: SpinnerState,
  frames: readonly string[] | SpinnerFrames = DOTS
): Element {
  const list = 'frames' in frames ? frames.frames : frames;
  const lead = textNode('', { 'margin-right': 1 });
  const label = textNode(state.label.get(), { class: 'sigil-spinner-text' });

  createEffect(() => {
    const outcome = state.outcome.get();
    const frame = state.frame.get();

    if (outcome) {
      const mark = OUTCOME_SYMBOLS[outcome];
      lead.setText(mark);
      lead.setProps({
        class: `sigil-symbol is-${outcome} sigil-${outcome}`,
        display: 'flex',
        width: stringWidth(mark),
      });
    } else if (frame === undefined) {
      lead.setText('');
      lead.setProps({ class: 'sigil-spinner-frame sigil-accent', display: 'none' });
    } else {
      const drawn = list[frame % list.length] as string;
      lead.setText(drawn);
      lead.setProps({
        class: 'sigil-spinner-frame sigil-accent',
        display: 'flex',
        width: stringWidth(drawn),
      });
    }
  });

  createEffect(() => {
    label.setText(state.label.get());
  });

  return box({ class: 'sigil-spinner' }, lead, label);
}

/**
 * The frames a spinner draws and how fast, out of its options.
 *
 * An explicit set or array always wins, the way an explicit `border` does on a
 * note: an app that asked for `ARC` gets `ARC`. Only the default follows the
 * terminal, through `unicodeSupported()` -- the one place that is decided, as the
 * charts, the note and the rule already ask it -- so a Linux console or
 * `TERM=dumb` spins `LINE` rather than a column of boxes. An empty array is no
 * frames at all and takes the default, as it always has.
 *
 * @param opts - The spinner's options.
 * @returns The set.
 */
export function spinnerFrames(opts: SpinnerOptions = {}): SpinnerFrames {
  const given = opts.frames;
  const set = given === undefined || 'frames' in given ? given : { frames: given, interval: 80 };

  if (set && set.frames.length > 0) {
    return set;
  }

  return (opts.ascii ?? !unicodeSupported(opts.env, opts.platform)) ? LINE : DOTS;
}

/**
 * A spinner, for work whose length is not known.
 *
 * Where there is no terminal there is nothing to animate, so no frame is drawn
 * and no timer is started -- and the canvas backend then writes a line per
 * change rather than one per tick. A CI log gets one line per thing the program
 * started doing, which is what it always got; what has changed is that it falls
 * out of the frame being the same either way rather than out of a second code
 * path.
 *
 * @param opts - What it says and how it looks.
 * @returns The spinner, not yet started.
 */
export function createSpinner(opts: SpinnerOptions = {}): Spinner {
  const frames = spinnerFrames(opts);
  // a set of the caller's own is asked the same question as the option, since
  // an interval of zero is a timer that never lets the process breathe
  const interval =
    opts.interval && opts.interval > 0 ? opts.interval : frames.interval > 0 ? frames.interval : 80;
  const state = spinnerState(opts.text ?? '');
  const running = new State(false);
  const terminal = opts.terminal ?? defaultTerminal;

  /**
   * What is on screen now, or nothing.
   *
   * Nothing is mounted until it is started, because a spinner that has not been
   * started has nothing on screen -- which is what it has always meant and is
   * the one thing a canvas would take away by itself: a renderer paints its
   * first frame as it is built. And nothing is left mounted once it has settled
   * or stopped, because a disposed renderer paints nothing ever again: keeping
   * it made `start()` after `succeed()` a call that set `spinning` to true and
   * changed the screen not at all.
   */
  let mounted: Mounted | undefined;
  let spinning = false;

  function mount(): Mounted {
    mounted ??= mountLive(
      (level) => {
        createEffect(() => {
          // only while something may move and something is running: a pipe has
          // no frames to show and a quiet run has nobody watching, so a timer
          // there would wake the process eighty times a second to render
          // nothing. The resolved level rather than the raw terminal fact,
          // which is what this read used to be -- so `SIGIL_REDUCED_MOTION=1`
          // on a terminal left the spinner spinning, which is the one thing
          // that variable exists to stop
          if (level !== 'live' || !running.get()) {
            return;
          }

          state.frame.set(0);
          const timer = setInterval(() => {
            state.frame.set((state.frame.get() ?? 0) + 1);
          }, interval);
          // the spinner is not a reason to stay alive -- a program that has
          // finished should exit even if somebody forgot to stop it
          timer.unref?.();
          onCleanup(() => clearInterval(timer));
        });

        return spinnerView(state, frames);
      },
      { ...opts, terminal }
    );
    return mounted;
  }

  /**
   * Stops and leaves one final line, which is the only thing a CI log keeps.
   *
   * @param outcome - How it ended.
   * @param final - The text to leave. The current text, if omitted.
   */
  function settle(outcome: SpinnerOutcome, final?: string): void {
    if (final !== undefined) {
      state.label.set(final);
    }
    spinning = false;
    running.set(false);
    state.frame.set(undefined);
    state.outcome.set(outcome);

    // mounted even if it never ran: a `succeed()` on a spinner nobody started
    // still leaves its line, which is what a region asked to `done(final)`
    // always did
    const it = mount();
    // painted before the screen is given back, because `done()` leaves what is
    // on screen where it is and what is on screen is still the frame before this
    it.frame();
    it.done();
    mounted = undefined;
  }

  const spinner: Spinner = {
    fail(final?: string): void {
      settle('error', final);
    },

    info(final?: string): void {
      settle('info', final);
    },

    start(next?: string): Spinner {
      if (next !== undefined) {
        state.label.set(next);
      }

      if (!spinning) {
        spinning = true;
        // whatever it settled as is cleared, so a spinner started again after
        // a `succeed()` shows its frames rather than the tick it ended on
        state.outcome.set(undefined);
        running.set(true);
        mount().frame();
      }

      return spinner;
    },

    get spinning() {
      return spinning;
    },

    stop(): void {
      spinning = false;
      running.set(false);
      mounted?.stop();
      mounted = undefined;
    },

    succeed(final?: string): void {
      settle('success', final);
    },

    get text() {
      return state.label.get();
    },

    set text(next: string) {
      state.label.set(next);
      if (spinning) {
        mounted?.frame();
      }
    },

    warn(final?: string): void {
      settle('warn', final);
    },

    write(line: string): void {
      writeLine(mounted, { ...opts, terminal }, line);
    },
  };

  return spinner;
}
