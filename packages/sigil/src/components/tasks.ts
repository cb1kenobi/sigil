import { strip } from '../ansi/index.js';
import { box, type Element, renderToString, text as textNode } from '../element/index.js';
import { __, __n } from '../i18n/index.js';
import { createEffect, createRoot, For, onCleanup } from '../renderer/index.js';
import { State, untrack } from '../signals/index.js';
import { terminal as defaultTerminal } from '../terminal/index.js';
import { themedCascade } from '../theme/index.js';
import { stringWidth } from '../width/index.js';
import { colorLevelOf } from './color-level.js';
import { type Mounted, type MountOptions, mountLevel, mountLive } from './mount.js';
import {
  createSpinner,
  OUTCOME_SYMBOLS,
  type SpinnerFrames,
  spinnerFrames,
  type SpinnerOptions,
  type SpinnerOutcome,
  type SpinnerState,
  spinnerState,
  spinnerView,
} from './spinner.js';

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
 * the grid cannot know. A carriage return that ends a line is a CRLF's, and is not
 * a redraw -- the redraw's last state is what comes before it.
 *
 * @param text - What was written.
 * @returns The lines, without their breaks.
 */
function toLines(text: string): string[] {
  return (
    strip(text)
      .split(/\r?\n/)
      // one trailing carriage return is the first half of a CRLF that arrived
      // split -- `pump()` breaks on the line feed alone -- and has to go before the
      // rule below, which would otherwise keep what follows it: nothing
      .map((line) => line.replace(/\r$/, ''))
      .map((line) => line.slice(line.lastIndexOf('\r') + 1).replaceAll('\t', '    '))
      .map((line) => line.replaceAll(/\p{Cc}/gu, '').trimEnd())
  );
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
 * Builds a `TaskLog` that owns a region of its own.
 *
 * `tasks()` does not come through here: its windows are rows of the one frame
 * the whole list draws, for the reason two regions cannot share the bottom of
 * the screen. What the two share is `toLines()`, `pump()` and the retention
 * rule, so a window cannot read its input differently depending on who drew it.
 *
 * @param opts - What it says and how it looks.
 * @returns The log.
 */
function buildTaskLog(opts: TaskLogOptions): TaskLog {
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
    const spinner = createSpinner({ ...base, text: title }).start();

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
    dropped += retainLines(kept, line, retain);
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
      const lines = failureLines(kept, dropped, INDENT);
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
 * Adds a chunk of output to what a window keeps, letting the oldest go past
 * `retain`.
 *
 * @param kept - What is kept, oldest first. Changed in place.
 * @param text - What arrived.
 * @param retain - How many to keep.
 * @returns How many were let go.
 */
function retainLines(kept: string[], text: string, retain: number): number {
  let dropped = 0;
  for (const one of toLines(text)) {
    kept.push(one);
    if (kept.length > retain) {
      kept.shift();
      dropped++;
    }
  }
  return dropped;
}

/**
 * What a failure leaves under its title: every line that was kept, and a note
 * that there were more when the oldest were dropped.
 *
 * @param kept - The retained lines, oldest first.
 * @param dropped - How many were let go.
 * @param indent - How far in they go.
 * @returns The lines, indented.
 */
function failureLines(kept: readonly string[], dropped: number, indent: number): string[] {
  const pad = ' '.repeat(indent);
  const lines = kept.map((line) => `${pad}${line}`);
  if (dropped > 0) {
    lines.unshift(`${pad}${__`… earlier output omitted`}`);
  }
  return lines;
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
   * Opens a window of output for this task, under its line.
   *
   * Settled for the task if it is not settled by the time the task ends: a
   * resolved task collapses it and a thrown one leaves what it printed. Asking
   * twice hands back the same window.
   */
  log(opts?: Pick<TaskLogOptions, 'limit' | 'retain'>): TaskLog;
  /** Changes what the task's line says while it runs. */
  message(text: string): void;
  /**
   * Aborted when the list this task belongs to stops early -- a sibling failed
   * under `failFast` -- so that work already running can be told to stop.
   *
   * A task that rejects with the abort settles as cancelled rather than failed:
   * it did what it was asked.
   */
  readonly signal: AbortSignal;
  /**
   * Runs a list of subtasks under this task's line, one level further in.
   *
   * The same function as `tasks()` with its own `concurrency` and `failFast`,
   * drawing into the same frame. A subtask that fails rejects this promise, so
   * the parent fails with it unless it catches -- which is the whole of how a
   * parent's outcome follows its children's.
   */
  tasks(list: readonly Task[], opts?: TaskListOptions): Promise<TaskOutcome[]>;
}

/**
 * What a task may return: nothing, the text to settle on, a `skip()`, or what
 * its subtasks came to -- so that a task which is only a group of subtasks can
 * be `({ tasks }) => tasks([...])`. The last settles on the title, as nothing
 * does.
 */
export type TaskResultValue = string | Skip | void | readonly TaskOutcome[];

/** How a failed task is tried again. */
export interface TaskRetry {
  /** How long to wait before each new attempt, in milliseconds. Defaults to 0. */
  delay?: number;
  /** How many more attempts after the first. */
  tries: number;
}

export interface Task {
  /** Whether it runs at all. A disabled task leaves no line. Defaults to true. */
  enabled?: boolean;
  /**
   * How many more times to run it if it throws: a number of tries, or the tries
   * and a delay between them. Defaults to none.
   *
   * Its line says which retry it is on while it runs. A task that returns
   * `skip()` is not retried, and nor is one cancelled by a sibling's failure.
   */
  retry?: number | TaskRetry;
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

/** How one list runs: on its own, or as a task's subtasks. */
export interface TaskListOptions {
  /**
   * How many tasks run at once. Defaults to 1, which is one after another.
   * `Infinity` runs them all. Each running task has a row of its own.
   */
  concurrency?: number;
  /**
   * Whether the first failure stops the list. Defaults to true.
   *
   * Stopping means nothing new starts and the tasks already running are told
   * through their `signal`, waited for, and left on screen as they end; the
   * first error is then rethrown. `false` runs every task whatever fails and
   * then rejects with an `AggregateError` holding each failure, in list order.
   */
  failFast?: boolean;
}

export interface TasksOptions extends Omit<SpinnerOptions, 'text'>, TaskListOptions {}

/** A line of the frame: a task, a line of a task's window, or what did not fit. */
type Row =
  | { readonly kind: 'task'; readonly node: TaskNode }
  | { readonly depth: number; readonly kind: 'line'; readonly text: State<string> }
  | { readonly depth: number; readonly kind: 'more'; readonly text: string };

/** A task's window, drawn as rows of the list's frame. */
interface TaskWindow {
  dropped: number;
  readonly kept: string[];
  readonly limit: number;
  readonly retain: number;
  /** The rows, made once and filled from the end of `kept`. */
  readonly slots: readonly Extract<Row, { kind: 'line' }>[];
}

/** One task while it is on screen. */
interface TaskNode {
  /** Subtasks, in the order they started. Only the current attempt's. */
  children: TaskNode[];
  readonly depth: number;
  /** Whether a line of this task's output can land between another's. */
  readonly interleaved: boolean;
  readonly parent: TaskNode | undefined;
  /**
   * What a pipe line of this task starts with: its ancestors' titles where its
   * lines interleave, since its position no longer says whose subtask it is.
   */
  readonly path: string;
  /** Its line in the frame, made once so that `For` keeps it. */
  readonly row: Extract<Row, { kind: 'task' }>;
  settled: boolean;
  readonly title: string;
  readonly view: SpinnerState;
  window: TaskWindow | undefined;
}

/** How a task ended, for the list that ran it. */
type Ran =
  | { readonly ok: true; readonly outcome: TaskOutcome }
  | { readonly cancelled: boolean; readonly error: unknown; readonly ok: false };

/**
 * Whether a list can run more than one task at once, refused when it is
 * nonsense rather than read as one: a `concurrency` of zero is a list that never
 * starts, which is a hang rather than a choice.
 *
 * @param value - What was asked for.
 * @returns How many at once.
 */
function concurrencyOf(value: number | undefined): number {
  if (value === undefined) {
    return 1;
  }
  if (value === Infinity || (Number.isInteger(value) && value >= 1)) {
    return value;
  }
  throw new TypeError(__`Expected concurrency to be a positive integer or Infinity`);
}

/**
 * How many more attempts a task gets, and how long between them.
 *
 * @param value - The task's `retry`.
 * @returns The tries and the delay.
 */
function retryOf(value: Task['retry']): Required<TaskRetry> {
  if (value === undefined) {
    return { delay: 0, tries: 0 };
  }
  const { delay = 0, tries } = typeof value === 'number' ? { tries: value } : value;
  if (!Number.isInteger(tries) || tries < 0) {
    throw new TypeError(__`Expected retry to be a whole number of tries`);
  }
  if (!Number.isFinite(delay) || delay < 0) {
    throw new TypeError(__`Expected a retry delay in milliseconds`);
  }
  return { delay, tries };
}

/**
 * Whether a rejection is a task honouring its abort signal.
 *
 * Asked only once the signal has fired. The reason itself, or anything named
 * `AbortError` -- which is what `fetch()`, `spawn()` and `setTimeout()` from
 * `node:timers/promises` reject with when handed an aborted signal, none of them
 * with the reason itself.
 *
 * @param error - What the task threw.
 * @param signal - Its signal.
 * @returns Whether it was cancelled.
 */
function isCancellation(error: unknown, signal: AbortSignal): boolean {
  return (
    signal.aborted &&
    (error === signal.reason ||
      (typeof error === 'object' &&
        error !== null &&
        (error as { name?: unknown }).name === 'AbortError'))
  );
}

/**
 * Waits, or stops waiting when the signal fires.
 *
 * @param ms - How long.
 * @param signal - What cuts it short.
 */
function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const done = (): void => {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener('abort', done, { once: true });
  });
}

/**
 * Keeps what a frame shows inside the screen.
 *
 * A canvas taller than the screen is clipped, so what does not fit has to be
 * chosen rather than left to fall off the bottom. What goes first is what costs
 * least to lose: a subtask that has already settled, oldest first -- a success
 * would be collapsed into its parent anyway and a failure is written out in
 * full when its parent settles -- then window lines, which a failure writes out
 * in full too. Only then are running tasks cut, from the bottom, and the cut is
 * said rather than hidden.
 *
 * @param rows - Everything the frame would show, top to bottom.
 * @param room - How many rows there are.
 * @returns What it shows.
 */
function fitRows(rows: readonly Row[], room: number): Row[] {
  const budget = Math.max(1, Math.floor(room));
  if (rows.length <= budget) {
    return [...rows];
  }

  const rank = (row: Row): number => {
    if (row.kind === 'task') {
      return row.node.settled && row.node.parent !== undefined ? 2 : 0;
    }
    return 1;
  };

  let over = rows.length - budget;
  const drop = new Set<Row>();
  for (const level of [2, 1]) {
    for (const row of rows) {
      if (over === 0) {
        break;
      }
      if (rank(row) === level) {
        drop.add(row);
        over--;
      }
    }
  }

  const kept = rows.filter((row) => !drop.has(row));
  if (kept.length <= budget) {
    return kept;
  }

  const shown = kept.slice(0, budget - 1);
  const hidden = kept.slice(budget - 1).filter((row) => row.kind === 'task').length;
  return [
    ...shown,
    { depth: 0, kind: 'more', text: __n(hidden, '… {0} more running', '… {0} more running') },
  ];
}

/** What a list is run inside: the task it belongs to, and what stops it. */
interface Scope {
  readonly interleaved: boolean;
  readonly parent: TaskNode | undefined;
  readonly signal: AbortSignal;
}

/** One `tasks()` call, and every subtask list under it: one frame, one clock. */
interface Run {
  /** Puts a task on screen, running. */
  open(title: string, scope: Scope): TaskNode;
  /** Builds what an attempt at a task is handed. */
  context(node: TaskNode, scope: Scope): { api: TaskContext; close(): void };
  /** Ends a task that returned, and commits it if it is at the top. */
  finish(node: TaskNode, value: TaskResultValue): TaskOutcome;
  /** Ends a task that threw, and commits it if it is at the top. */
  fail(node: TaskNode, cancelled: boolean): void;
  /** Puts a failed task back to running, under a label that says so. */
  retry(node: TaskNode, label: string): void;
  /** Gives the screen back. */
  end(): void;
}

/**
 * The frame, the clock, and the two forms output takes.
 *
 * **One region and one clock however many tasks run.** Two live regions cannot
 * share the bottom of the screen, so a spinner per task would have them evict
 * each other -- which is why SIG-161 ran the list one at a time. So every task
 * of a run, at every depth, is a row of one `For`, and one timer advances the
 * frame of every row that is spinning. It runs only while one is: a task whose
 * window is open shows its output as the sign of life, as it always did.
 *
 * **A task that settles at the top leaves the frame and is written above it.**
 * The frame only ever holds what is still running, so it is as tall as the
 * concurrency rather than as long as the list, and a written line scrolls where
 * a frame taller than the screen is clipped. The cost is that lines land in the
 * order tasks finished rather than the order they were listed -- which is the
 * order a pipe gets them in too, so a log and a screen tell one story. A
 * subtask stays in its parent's block until the parent settles, and the block
 * then goes up as one: a success as its one line, a failure as its line, its
 * output and every subtask as each one ended.
 *
 * **Where there is no terminal there is no frame**, for the reason
 * `createMultiProgress()` gives: a frame of several rows written to a pipe would
 * repeat every unchanged row on every change. Each task writes a line when it
 * starts and one when it settles, indented by its depth, and each line of its
 * output as it arrives. Lines from tasks that run side by side interleave, so
 * an output line is labelled with its task's title wherever that can happen --
 * the start and settle lines already carry one. A quiet run writes nothing.
 *
 * @param opts - How it looks and where it draws.
 * @returns The run.
 */
function createRun(opts: TasksOptions): Run {
  const terminal = opts.terminal ?? opts.backend?.terminal ?? defaultTerminal;
  const base: TasksOptions = { ...opts, terminal };
  const frames = spinnerFrames(base);
  const interval =
    opts.interval && opts.interval > 0 ? opts.interval : frames.interval > 0 ? frames.interval : 80;
  const cascade = themedCascade(base);
  const colorLevel = colorLevelOf(opts, opts.terminal);

  /** Top-level tasks still in the frame, in the order they started. */
  const top: TaskNode[] = [];
  /** Bumped whenever what the frame holds changes shape. */
  const version = new State(0);
  /** The rows the clock advances. */
  const spinners = new Set<TaskNode>();
  /**
   * Whether any is, as a boolean rather than a count: the clock's effect reads
   * it, and a count would restart the timer -- and its cadence -- every time a
   * task started beside the ones already spinning.
   */
  const spinning = new State(false);
  let tick = 0;
  let live = false;

  const quiet = (): boolean => mountLevel(base) === 'quiet';

  const mounted: Mounted | undefined =
    quiet() || !terminal.isTTY || terminal.closed
      ? undefined
      : mountLive((level) => {
          live = level === 'live';
          createEffect(() => {
            // only while something spins, for the reason the spinner gives: a
            // timer with nothing to animate wakes the process to render nothing
            if (!live || !spinning.get()) {
              return;
            }
            const timer = setInterval(() => {
              tick++;
              for (const node of spinners) {
                node.view.frame.set(tick);
              }
            }, interval);
            timer.unref?.();
            onCleanup(() => clearInterval(timer));
          });

          return For({
            children: (row) => rowView(row, frames),
            each: () => {
              version.get();
              const rows: Row[] = [];
              for (const node of top) {
                flatten(node, rows);
              }
              // a row is kept for the cursor, which sits under the frame
              return fitRows(rows, terminal.height - 1);
            },
            props: { class: 'sigil-tasks', 'flex-direction': 'column' },
          });
        }, base);

  const offResize = mounted ? terminal.onResize(() => changed()) : undefined;

  function changed(): void {
    // untracked, so a task changed from inside an effect does not subscribe that
    // effect to the counter this write bumps
    version.set(untrack(() => version.get()) + 1);
    mounted?.frame();
  }

  function spin(node: TaskNode, on: boolean): void {
    if (on && mounted) {
      node.view.frame.set(live ? tick : undefined);
      spinners.add(node);
    } else {
      node.view.frame.set(undefined);
      spinners.delete(node);
    }
    spinning.set(spinners.size > 0);
  }

  /**
   * How far a pipe line of this task is indented.
   *
   * By depth where the lines are in order, so that a subtask sits under its
   * parent. Not at all where they interleave: the line under a parent may be
   * anybody's, so an indent would claim a parent the line does not have, and
   * the path in front of it says which one it does.
   */
  function pipeIndent(node: TaskNode): string {
    return node.interleaved ? '' : ' '.repeat(node.depth * INDENT);
  }

  /** Writes a plain line in the pipe form. */
  function line(node: TaskNode, text: string): void {
    if (mounted || quiet()) {
      return;
    }
    terminal.write(`${pipeIndent(node)}${node.path}${text}\n`);
  }

  /**
   * A settled task's line, as styled text.
   *
   * The spinner's own view with the outcome set, rendered to a string, so the
   * line written above the frame and the line a lone spinner leaves behind are
   * one drawing rather than two that agree.
   */
  function settledLine(node: TaskNode): string {
    const outcome = node.view.outcome.get() ?? 'success';
    const label = mounted ? node.view.label.get() : `${node.path}${node.view.label.get()}`;
    const pad = mounted ? ' '.repeat(node.depth * INDENT) : pipeIndent(node);
    // the indent is spaces in front rather than a margin, because a string
    // render starts at the root's own box and a margin on it has nothing to be
    // a margin against
    return createRoot((dispose) => {
      try {
        const state = spinnerState(label);
        state.outcome.set(outcome);
        return `${pad}${renderToString(spinnerView(state, frames), {
          cascade,
          colorLevel,
          colorScheme: opts.colorScheme,
          width: stringWidth(OUTCOME_SYMBOLS[outcome]) + 1 + stringWidth(label),
        })}`;
      } finally {
        dispose();
      }
    });
  }

  /** A settled task and, if it failed, everything under it. */
  function block(node: TaskNode): string[] {
    const lines = [settledLine(node)];
    if (node.view.outcome.get() === 'error') {
      if (node.window) {
        lines.push(
          ...failureLines(node.window.kept, node.window.dropped, node.depth * INDENT + INDENT)
        );
      }
      for (const child of node.children) {
        lines.push(...block(child));
      }
    }
    return lines;
  }

  function settle(node: TaskNode, outcome: SpinnerOutcome, label: string): void {
    if (node.settled) {
      return;
    }
    node.settled = true;
    node.view.label.set(label);
    node.view.outcome.set(outcome);
    spin(node, false);
    if (mounted) {
      changed();
    } else if (!quiet()) {
      terminal.write(`${settledLine(node)}\n`);
    }
  }

  /** Takes a finished top-level task out of the frame and writes it above. */
  function commit(node: TaskNode): void {
    if (node.parent || !mounted) {
      return;
    }
    const at = top.indexOf(node);
    if (at !== -1) {
      top.splice(at, 1);
    }
    // repainted without it first, so the frame the write puts back underneath
    // is the one that no longer holds it
    changed();
    mounted.write(block(node).join('\n'));
  }

  function windowOf(node: TaskNode, logOpts: Pick<TaskLogOptions, 'limit' | 'retain'>): TaskWindow {
    const limit = logOpts.limit && logOpts.limit > 0 ? Math.floor(logOpts.limit) : WINDOW;
    const retain = logOpts.retain && logOpts.retain > 0 ? Math.floor(logOpts.retain) : RETAIN;
    const depth = node.depth + 1;
    return {
      dropped: 0,
      kept: [],
      limit,
      retain,
      slots: Array.from({ length: limit }, () => ({
        depth,
        kind: 'line' as const,
        text: new State(''),
      })),
    };
  }

  const run: Run = {
    context(node, scope) {
      let alive = true;
      let opened: TaskLog | undefined;

      const api: TaskContext = {
        log(logOpts = {}) {
          if (opened) {
            return opened;
          }
          const title = node.view.label.get();

          if (!mounted) {
            const feed = (text: string): void => {
              if (!alive || node.settled) {
                return;
              }
              // a subprocess has no idea which task it is printing for, so
              // where that is not said by position its task's title says it
              const prefix = node.interleaved ? `${node.title}: ` : '';
              for (const one of toLines(text)) {
                line(node, `${prefix}${one}`);
              }
            };
            opened = {
              error(text) {
                if (alive) {
                  settle(node, 'error', text ?? title);
                }
              },
              message: feed,
              get settled() {
                return !alive || node.settled;
              },
              stream: (source) => pump(source, feed),
              success(text) {
                if (alive) {
                  settle(node, 'success', text ?? title);
                }
              },
            };
            return opened;
          }

          const window = windowOf(node, logOpts);
          node.window = window;
          // the output is the sign of life now, so the title stops spinning --
          // which is what SIG-161's window did, and what keeps a window that
          // runs for minutes from waking the process for a frame nobody needs
          spin(node, false);
          changed();

          const add = (text: string): void => {
            if (!alive || node.settled) {
              return;
            }
            window.dropped += retainLines(window.kept, text, window.retain);
            const shown = window.kept.slice(-window.limit);
            for (const [i, slot] of window.slots.entries()) {
              slot.text.set(shown[i] ?? '');
            }
            changed();
          };

          opened = {
            error(text) {
              if (alive) {
                settle(node, 'error', text ?? title);
              }
            },
            message: add,
            get settled() {
              return !alive || node.settled;
            },
            stream: (source) => pump(source, add),
            success(text) {
              if (alive) {
                settle(node, 'success', text ?? title);
              }
            },
          };
          return opened;
        },

        message(text: string): void {
          // untracked, whole: this is called from task bodies, which are as likely
          // to be inside an effect as not, and the guard's read of the label would
          // subscribe that effect to the line this very call writes
          untrack(() => {
            if (!alive || node.settled || text === node.view.label.get()) {
              return;
            }
            node.view.label.set(text);
            if (mounted) {
              mounted.frame();
            } else {
              line(node, text);
            }
          });
        },

        signal: scope.signal,

        tasks: (list, listOpts = {}) => runList(run, list, listOpts, node, scope.signal),
      };

      return {
        api,
        close(): void {
          alive = false;
        },
      };
    },

    end(): void {
      offResize?.();
      // everything at the top has been written above by now, so what is left
      // is an empty frame, and erasing it leaves nothing behind
      mounted?.stop();
    },

    fail(node, cancelled) {
      if (cancelled) {
        settle(node, 'info', __`${node.title} (cancelled)`);
      } else {
        settle(node, 'error', node.title);
      }
      commit(node);
    },

    finish(node, value) {
      let outcome: TaskOutcome;
      if (isSkip(value)) {
        // the spinner's `info`: skipped is neither done nor failed, and it is the
        // one outcome that says "this is worth knowing" without saying "this went
        // well"
        const final = value.reason
          ? __`${node.title} (skipped: ${value.reason})`
          : __`${node.title} (skipped)`;
        settle(node, 'info', final);
        outcome = { outcome: 'skip', reason: value.reason, title: final };
      } else {
        const final = typeof value === 'string' && value !== '' ? value : node.title;
        settle(node, 'success', final);
        outcome = { outcome: 'success', title: final };
      }
      commit(node);
      return outcome;
    },

    open(title, scope) {
      const row = { kind: 'task' } as { kind: 'task'; node: TaskNode };
      const node: TaskNode = {
        children: [],
        depth: scope.parent ? scope.parent.depth + 1 : 0,
        interleaved: scope.interleaved,
        parent: scope.parent,
        path:
          scope.interleaved && scope.parent ? `${scope.parent.path}${scope.parent.title}: ` : '',
        row,
        settled: false,
        title,
        view: spinnerState(title),
        window: undefined,
      };
      row.node = node;

      if (scope.parent) {
        scope.parent.children.push(node);
      } else {
        top.push(node);
      }

      if (mounted) {
        spin(node, true);
        changed();
      } else {
        line(node, title);
      }
      return node;
    },

    retry(node, label) {
      node.settled = false;
      node.view.outcome.set(undefined);
      node.view.label.set(label);
      node.window = undefined;
      node.children = [];
      if (mounted) {
        spin(node, true);
        changed();
      } else {
        line(node, label);
      }
    },
  };

  return run;
}

/**
 * A task and what is under it, as the rows of the frame.
 *
 * A running task shows its window and its subtasks; a settled one is its line
 * alone, because a success has nothing left to show and a failure is written
 * out in full when it leaves the frame.
 *
 * @param node - The task.
 * @param rows - Where the rows go.
 */
function flatten(node: TaskNode, rows: Row[]): void {
  rows.push(node.row);
  if (node.settled) {
    return;
  }
  if (node.window) {
    rows.push(...node.window.slots.slice(0, Math.min(node.window.kept.length, node.window.limit)));
  }
  for (const child of node.children) {
    flatten(child, rows);
  }
}

/**
 * One row of the frame, as an element tree.
 *
 * A task's row is the spinner's own view, so a row cannot disagree with a lone
 * spinner about what running and settled look like. A window line is the one
 * `taskLog()` draws, cut rather than wrapped for the reason given there.
 *
 * @param row - The row.
 * @param frames - The frames a running task cycles.
 * @returns The tree.
 */
function rowView(row: Row, frames: SpinnerFrames): Element {
  if (row.kind === 'task') {
    return box({ 'margin-left': row.node.depth * INDENT }, spinnerView(row.node.view, frames));
  }
  if (row.kind === 'more') {
    return textNode(row.text, { class: 'sigil-tasks-more sigil-muted' });
  }
  const view = textNode(row.text.get(), {
    class: 'sigil-tasklog-line sigil-muted',
    'margin-left': row.depth * INDENT,
    'min-width': 0,
    'text-overflow': 'ellipsis',
    'white-space': 'nowrap',
  });
  createEffect(() => {
    view.setText(row.text.get());
  });
  return view;
}

/**
 * Runs one list: its own queue, its own failure policy, its own signal.
 *
 * @param run - The frame it draws into.
 * @param list - The tasks.
 * @param opts - How many at once, and whether a failure stops the rest.
 * @param parent - The task these are subtasks of, if they are.
 * @param outer - What stops the list this one is inside.
 * @returns How each task ended, in list order.
 */
async function runList(
  run: Run,
  list: readonly Task[],
  opts: TaskListOptions,
  parent: TaskNode | undefined,
  outer: AbortSignal | undefined
): Promise<TaskOutcome[]> {
  const concurrency = concurrencyOf(opts.concurrency);
  const failFast = opts.failFast !== false;
  const enabled = list.filter((item) => item.enabled !== false);
  // read up front, so that a bad `retry` is refused before anything has run
  const retries = enabled.map((item) => retryOf(item.retry));

  const controller = new AbortController();
  const stop = (): void => controller.abort(outer?.reason);
  if (outer?.aborted) {
    stop();
  } else {
    outer?.addEventListener('abort', stop, { once: true });
  }

  const scope: Scope = {
    interleaved: (parent?.interleaved ?? false) || Math.min(concurrency, enabled.length) > 1,
    parent,
    signal: controller.signal,
  };

  // filled by index, so it has a gap wherever a task was cancelled and its
  // length is not how many finished -- `done` is
  const results: TaskOutcome[] = [];
  const failures: { at: number; error: unknown }[] = [];
  let done = 0;
  let next = 0;

  async function one(at: number): Promise<Ran> {
    const item = enabled[at] as Task;
    const { delay, tries } = retries[at] as Required<TaskRetry>;
    const node = run.open(item.title, scope);

    for (let attempt = 0; ; attempt++) {
      const context = run.context(node, scope);
      try {
        const value = await item.task(context.api);
        context.close();
        return { ok: true, outcome: run.finish(node, value) };
      } catch (error) {
        context.close();
        const cancelled = isCancellation(error, scope.signal);
        if (!cancelled && attempt < tries && !scope.signal.aborted) {
          run.retry(node, __`${item.title} (retry ${attempt + 1} of ${tries})`);
          if (delay > 0) {
            await pause(delay, scope.signal);
          }
          if (!scope.signal.aborted) {
            continue;
          }
        }
        run.fail(node, cancelled);
        return { cancelled, error, ok: false };
      }
    }
  }

  async function worker(): Promise<void> {
    while (next < enabled.length && !controller.signal.aborted) {
      const at = next++;
      const ran = await one(at);
      if (ran.ok) {
        results[at] = ran.outcome;
        done++;
      } else if (!ran.cancelled) {
        failures.push({ at, error: ran.error });
        if (failFast) {
          controller.abort();
        }
      }
    }
  }

  try {
    const workers = Math.max(1, Math.min(concurrency, enabled.length));
    await Promise.all(Array.from({ length: workers }, worker));
  } finally {
    outer?.removeEventListener('abort', stop);
  }

  if (failures.length > 0) {
    if (failFast) {
      // the one that stopped the list, which is the first to have failed
      throw (failures[0] as { error: unknown }).error;
    }
    const errors = failures.sort((a, b) => a.at - b.at).map((failure) => failure.error);
    throw new AggregateError(
      errors,
      errors.length === 1
        ? String((errors[0] as { message?: unknown } | undefined)?.message ?? errors[0])
        : __n(errors.length, '{0} task failed', '{0} tasks failed')
    );
  }

  if (controller.signal.aborted && done < enabled.length) {
    // stopped from outside before every task ran, which is not a success: the
    // parent this belongs to is being cancelled, and says so with the reason
    throw controller.signal.reason;
  }

  return results.filter((result) => result !== undefined);
}

/**
 * Runs a list of tasks, each with a line of its own: one after another by
 * default, or `concurrency` at a time.
 *
 * A task settles its line as done, with the string it returns if it returned
 * one in place of the title; as skipped, if it returned `skip()`; or as failed,
 * if it threw and had no retries left. A failure stops the list unless
 * `failFast` is `false`, and is rethrown to the caller, who owns what a failure
 * means. A task's `context.tasks()` runs subtasks under its line.
 *
 * @param list - The tasks.
 * @param opts - How many at once, what a failure does, and how the lines look.
 * @returns How each task that ran ended, in list order.
 */
export async function tasks(
  list: readonly Task[],
  opts: TasksOptions = {}
): Promise<TaskOutcome[]> {
  // refused before anything is drawn, so a bad option leaves the screen alone
  concurrencyOf(opts.concurrency);
  for (const item of list) {
    retryOf(item.retry);
  }

  const run = createRun(opts);
  try {
    return await runList(run, list, opts, undefined, undefined);
  } finally {
    run.end();
  }
}
