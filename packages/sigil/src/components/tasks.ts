import { strip } from '../ansi/index.js';
import { box, type Element, text as textNode } from '../element/index.js';
import { __ } from '../i18n/index.js';
import { createEffect } from '../renderer/index.js';
import { State } from '../signals/index.js';
import { terminal as defaultTerminal } from '../terminal/index.js';
import { type Mounted, type MountOptions, mountLevel, mountLive } from './mount.js';
import { createSpinner, type Spinner, spinnerState, spinnerView } from './spinner.js';

/** How many lines of output a `taskLog()` shows at once. */
const WINDOW = 6;

/** How many lines of output a `taskLog()` keeps for a failure to show. */
const RETAIN = 1000;

/** How far an output line is indented under its title. */
const INDENT = 2;

const SKIPPED: unique symbol = Symbol('sigil.skip');

/** What a task returns to say it chose not to run. See `skip()`. */
export interface Skip {
  readonly [SKIPPED]: true;
  /** Why, if the task said. */
  readonly reason?: string;
}

/**
 * Marks a task as skipped, for a task that finds at run time that it has nothing
 * to do.
 *
 * A value rather than a thrown error: a skip is an ordinary outcome of the
 * work, and a task that threw to say so would be indistinguishable from one
 * that failed to the first `catch` that did not know the difference.
 *
 * @param reason - Why, shown beside the title.
 * @returns The marker to return.
 */
export function skip(reason?: string): Skip {
  return Object.freeze({ [SKIPPED]: true as const, reason });
}

function isSkip(value: unknown): value is Skip {
  return typeof value === 'object' && value !== null && SKIPPED in value;
}

export interface TaskLogOptions extends MountOptions {
  /**
   * How many lines are kept for a failure to show. Defaults to 1000.
   *
   * Bounded because the thing feeding this is a subprocess, and a build that
   * prints a million lines is not a reason for the one writing it down to run
   * out of memory. The newest are kept, since the end of a log is where the
   * failure is.
   */
  retain?: number;
  /** How many lines of output are shown at once. Defaults to 6. */
  limit?: number;
  /** What the work is, shown above the output. */
  title: string;
}

export interface TaskLog {
  /** Writes a line of the work's output into the window. Several lines are several. */
  message(line: string): void;
  /** Whether it has been settled with `success()` or `error()`. */
  readonly settled: boolean;
  /**
   * Feeds the window from a stream, a line at a time, and resolves when it ends.
   *
   * A chunk is not a line, so what arrives is split on its breaks and a line
   * that straddles two chunks is joined back up.
   */
  stream(source: AsyncIterable<string | Uint8Array>): Promise<void>;
  /** Ends the work as done, and takes the output with it. */
  success(text?: string): void;
  /** Ends the work as failed, and leaves everything it printed on screen. */
  error(text?: string): void;
}

/**
 * One chunk of output, as the lines it holds.
 *
 * Cleaned because it came from something else's terminal: an escape sequence in
 * a canvas cell is a corrupted frame, a carriage return is a progress bar that
 * redraws itself and only its last state is a line, and a tab is a column count
 * the grid cannot know.
 *
 * @param text - What was written.
 * @returns The lines, without their breaks.
 */
function toLines(text: string): string[] {
  return strip(text)
    .split(/\r?\n/)
    .map((line) => line.slice(line.lastIndexOf('\r') + 1).replaceAll('\t', '    '))
    .map((line) => line.replaceAll(/\p{Cc}/gu, '').trimEnd());
}

/**
 * The window, as an element tree: the title, then up to `limit` lines under it.
 *
 * The rows exist up front and are shown or hidden rather than added and
 * removed, so the tree never changes shape and what the window holds is one
 * signal. The title is a spinner's, minus the animation: the settled marks are
 * the spinner's own, and the work is not something that spins -- its output is
 * the sign of life.
 *
 * @param title - What the title row reads.
 * @param lines - What the window shows, newest last.
 * @param limit - How many rows there are.
 * @returns The tree.
 */
function taskLogView(
  title: ReturnType<typeof spinnerState>,
  lines: State<readonly string[]>,
  limit: number
): Element {
  const rows = Array.from({ length: limit }, () =>
    textNode('', {
      class: 'sigil-tasklog-line sigil-muted',
      display: 'none',
      'margin-left': INDENT,
      // one row per line whatever the width, cut rather than wrapped: the
      // window is a fixed height, and a wrapped line is two rows of it
      'min-width': 0,
      'text-overflow': 'ellipsis',
      'white-space': 'nowrap',
    })
  );

  createEffect(() => {
    const shown = lines.get();
    for (const [i, row] of rows.entries()) {
      const line = shown[i];
      row.setText(line ?? '');
      row.setProps({ display: line === undefined ? 'none' : 'flex' });
    }
  });

  return box({ class: 'sigil-tasklog', 'flex-direction': 'column' }, spinnerView(title), ...rows);
}

/**
 * Builds a `TaskLog`, over a spinner somebody already started if there is one.
 *
 * @param opts - What it says and how it looks.
 * @param adopt - A running spinner to settle in place of starting one, which is
 *   how `tasks()` hands its task's line over without printing the title twice.
 * @returns The log.
 */
function buildTaskLog(opts: TaskLogOptions, adopt?: Spinner): TaskLog {
  const { limit: asked, retain: keep, title, ...mountOpts } = opts;
  const limit = asked && asked > 0 ? Math.floor(asked) : WINDOW;
  const retain = keep && keep > 0 ? Math.floor(keep) : RETAIN;
  const terminal = opts.terminal ?? defaultTerminal;
  const base = { ...mountOpts, terminal };

  /**
   * Whether there is a window to draw at all.
   *
   * Asked of the terminal as well as of the fold, which a spinner does not need:
   * a spinner's frame is the same text whether it is repainted or appended, so
   * the canvas can decide. A window is not -- appended, each change would write
   * the whole of it again -- so a log with nobody to repaint for takes the other
   * form, which is the spinner's: the title once, each line as it comes, and a
   * settled line. Reduced motion is still a terminal, and a window is content
   * that changes rather than motion, so it stays.
   */
  const windowed = mountLevel(base) !== 'quiet' && terminal.isTTY && !terminal.closed;

  let settled = false;

  if (!windowed) {
    const spinner = adopt ?? createSpinner({ ...base, text: title }).start();

    const feed = (line: string): void => {
      if (settled) {
        return;
      }
      for (const one of toLines(line)) {
        spinner.write(one);
      }
    };

    return {
      error(text?: string): void {
        if (!settled) {
          settled = true;
          spinner.fail(text ?? title);
        }
      },

      message: feed,

      get settled() {
        return settled;
      },

      stream: (source) => pump(source, feed),

      success(text?: string): void {
        if (!settled) {
          settled = true;
          spinner.succeed(text ?? title);
        }
      },
    };
  }

  // the task's own line is erased before the window takes its place, because
  // two regions cannot share the bottom of the screen and the older one would
  // be left behind as a frozen frame
  adopt?.stop();

  const view = spinnerState(title);
  const shown = new State<readonly string[]>([]);
  const kept: string[] = [];
  let dropped = 0;

  const mounted: Mounted = mountLive(() => taskLogView(view, shown, limit), base);
  mounted.frame();

  function add(line: string): void {
    if (settled) {
      return;
    }
    for (const one of toLines(line)) {
      kept.push(one);
      if (kept.length > retain) {
        kept.shift();
        dropped++;
      }
    }
    shown.set(kept.slice(-limit));
    mounted.frame();
  }

  /** Collapses the window into the title row, and leaves that where it is. */
  function settle(outcome: 'error' | 'success', text: string | undefined): boolean {
    if (settled) {
      return false;
    }
    settled = true;
    if (text !== undefined) {
      view.label.set(text);
    }
    view.outcome.set(outcome);
    shown.set([]);
    // painted before the screen is given back, for the reason the spinner's
    // `settle()` records: `done()` leaves what is on screen where it is
    mounted.frame();
    mounted.done();
    return true;
  }

  return {
    error(text?: string): void {
      if (!settle('error', text)) {
        return;
      }
      // the output is written below the title rather than drawn into the
      // window, because what a failure is owed is all of it and the window is
      // `limit` rows: a canvas taller than the screen is clipped, where a
      // written line simply scrolls
      const lines = kept.map((line) => `${' '.repeat(INDENT)}${line}`);
      if (dropped > 0) {
        lines.unshift(`${' '.repeat(INDENT)}${__`… earlier output omitted`}`);
      }
      if (lines.length > 0) {
        // `\r\n` because this bypasses the backend that writes it for every other
        // line, and a bare `\n` only reaches column zero if the line discipline is
        // translating -- which raw mode turns off
        terminal.write(`${lines.join('\r\n')}\r\n`);
      }
    },

    message: add,

    get settled() {
      return settled;
    },

    stream: (source) => pump(source, add),

    success(text?: string): void {
      settle('success', text);
    },
  };
}

/**
 * Reads a stream a line at a time into a callback.
 *
 * @param source - Chunks of text or bytes.
 * @param line - Called with each line, without its break.
 */
async function pump(
  source: AsyncIterable<string | Uint8Array>,
  line: (text: string) => void
): Promise<void> {
  const decoder = new TextDecoder();
  let pending = '';

  for await (const chunk of source) {
    pending += typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true });
    const parts = pending.split('\n');
    pending = parts.pop() ?? '';
    for (const part of parts) {
      line(part);
    }
  }

  pending += decoder.decode();
  if (pending !== '') {
    line(pending);
  }
}

/**
 * A window of a subprocess's output under a title: the most recent lines while
 * it runs, gone when it succeeds and all of it kept when it fails.
 *
 * Where there is no terminal there is nothing to repaint, so the window is not
 * drawn: the title is written once, each line as it arrives, and a settled line
 * at the end -- which is what a spinner leaves in a log, and what a CI log wants
 * from a build. A quiet run writes nothing at all.
 *
 * @param opts - The title, and how tall the window is.
 * @returns The log, drawn.
 */
export function taskLog(opts: TaskLogOptions): TaskLog {
  return buildTaskLog(opts);
}

/** What a task is handed. */
export interface TaskContext {
  /**
   * Opens a window of output for this task, in place of its spinner.
   *
   * Settled for the task if it is not settled by the time the task ends: a
   * resolved task collapses it and a thrown one leaves what it printed.
   */
  log(opts?: Pick<TaskLogOptions, 'limit' | 'retain'>): TaskLog;
  /** Changes what the task's line says while it runs. */
  message(text: string): void;
}

/** What a task may return: nothing, the text to settle on, or a `skip()`. */
export type TaskResultValue = string | Skip | void;

export interface Task {
  /** Whether it runs at all. A disabled task leaves no line. Defaults to true. */
  enabled?: boolean;
  /** The work. */
  task(context: TaskContext): TaskResultValue | Promise<TaskResultValue>;
  /** What it is, shown while it runs. */
  title: string;
}

/** How one task ended. */
export interface TaskOutcome {
  /** Why it was skipped, if it said. */
  reason?: string;
  /** `skip` for a task that chose not to run, `success` for one that did. */
  outcome: 'skip' | 'success';
  /** What its line settled on. */
  title: string;
}

/**
 * Runs a list of tasks one after another, each under a spinner.
 *
 * A task settles its line as done, with the string it returns if it returned
 * one in place of the title; as skipped, if it returned `skip()`; or as failed,
 * if it threw -- in which case the failed line stays on screen, nothing after it
 * runs, and the error is rethrown to the caller, who owns what a failure means.
 *
 * @param list - The tasks.
 * @param opts - How the spinners look and where they draw.
 * @returns How each task that ran ended.
 */
export async function tasks(
  list: readonly Task[],
  opts: MountOptions = {}
): Promise<TaskOutcome[]> {
  const results: TaskOutcome[] = [];

  for (const item of list) {
    if (item.enabled === false) {
      continue;
    }

    const spinner = createSpinner({ ...opts, text: item.title }).start();
    let opened: TaskLog | undefined;

    const context: TaskContext = {
      log(logOpts = {}) {
        opened ??= buildTaskLog({ ...opts, ...logOpts, title: spinner.text }, spinner);
        return opened;
      },

      message(text: string): void {
        spinner.text = text;
      },
    };

    let value: TaskResultValue;
    try {
      value = await item.task(context);
    } catch (error) {
      if (opened) {
        opened.error(item.title);
      } else {
        spinner.fail(item.title);
      }
      throw error;
    }

    if (isSkip(value)) {
      // the spinner's `info`: skipped is neither done nor failed, and it is the
      // one outcome that says "this is worth knowing" without saying "this went
      // well"
      const final = value.reason
        ? __`${item.title} (skipped: ${value.reason})`
        : __`${item.title} (skipped)`;
      if (opened) {
        // `success()` is a no-op on a window the task already settled
        opened.success(final);
      } else {
        spinner.info(final);
      }
      results.push({ outcome: 'skip', reason: value.reason, title: final });
    } else {
      const final = typeof value === 'string' && value !== '' ? value : item.title;
      if (opened) {
        // `success()` is a no-op on a window the task already settled
        opened.success(final);
      } else {
        spinner.succeed(final);
      }
      results.push({ outcome: 'success', title: final });
    }
  }

  return results;
}
