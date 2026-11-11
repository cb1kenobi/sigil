/**
 * Runs a workload full screen over a terminal that only counts, and says what
 * each frame cost.
 *
 * Two ways, because they answer different questions. `measureFrames()` steps
 * the data and paints a frame, one after the other, as fast as it can: that is
 * the frame's own cost -- time, bytes, allocation -- with nothing else in it,
 * and it is the same frames in the same order every run. `measurePaced()` hands
 * the clock back to the renderer and feeds it at a rate, which is the question
 * "does it keep up at 60", and is the one an event loop's other work can move.
 *
 * The terminal writes nowhere. A test terminal would parse every byte into a
 * screen model inside the frame that wrote it, and that parse would be timed as
 * the frame's; this one adds the length and returns.
 */

import { runApp } from '@ttylabs/sigil/app';
import { createTerminal } from '@ttylabs/sigil/terminal';
import { PassThrough } from 'node:stream';
import { getHeapStatistics } from 'node:v8';

/**
 * @typedef {object} Workload
 * @property {() => import('@ttylabs/sigil/element').Element} App - The root, taking no props.
 * @property {() => void | Promise<void>} step - Moves the data on by one reading.
 * @property {readonly (string)[]} [sheets] - Its stylesheets.
 */

/**
 * @typedef {object} Frame
 * @property {number} ms - How long `frame()` took, by `performance.now()`.
 * @property {number} bytes - What it wrote, in UTF-8 bytes.
 * @property {number | undefined} allocated - What it allocated, where V8 says
 *   (`total_allocated_bytes`, which Node 26 reports and earlier ones do not).
 * @property {import('@ttylabs/sigil/renderer').FrameStats | undefined} stats - The
 *   renderer's own account of the frame.
 */

/**
 * A terminal of a given size whose output is counted and dropped.
 *
 * @param {{ columns: number, rows: number, colorLevel?: 0 | 1 | 2 | 3 }} size
 * @returns {{ terminal: import('@ttylabs/sigil/terminal').Terminal, readonly bytes: number }}
 */
export function countingTerminal({ columns, rows, colorLevel = 3 }) {
  let bytes = 0;
  const stdout = {
    columns,
    isTTY: true,
    on() {},
    removeListener() {},
    rows,
    write(/** @type {string} */ chunk) {
      bytes += Buffer.byteLength(chunk);
      return true;
    },
  };
  const stdin = Object.assign(new PassThrough(), {
    isTTY: true,
    setRawMode() {
      return stdin;
    },
  });
  // a stub rather than `process`, so the terminal puts no exit or signal
  // handler on the real one -- the same stub `createTestTerminal()` uses
  const proc = { listenerCount: () => 0, on() {}, removeListener() {} };
  const terminal = createTerminal({
    colorLevel,
    env: {},
    isTTY: true,
    proc,
    stderr: stdout,
    stdin,
    stdout,
  });
  return {
    get bytes() {
      return bytes;
    },
    terminal,
  };
}

/**
 * Mounts a workload with `runApp()`, as an app is run.
 *
 * @param {Workload} workload
 * @param {{ columns: number, rows: number, frameMs?: number }} opts
 */
function start(workload, opts) {
  const sink = countingTerminal(opts);
  const app = runApp(workload.App, {
    console: false,
    detect: false,
    frameMs: opts.frameMs,
    gatherStats: true,
    now: () => performance.now(),
    sheets: workload.sheets,
    terminal: sink.terminal,
  });
  if (!app.running) {
    throw new Error('The workload did not start');
  }
  return { app, sink };
}

/** Lets a reading that resolves on a microtask -- the monitor's sampler -- land. */
async function settle() {
  for (let i = 0; i < 4; i++) {
    await Promise.resolve();
  }
}

/** What V8 has allocated so far, or `undefined` where it does not say. */
const allocated = () => getHeapStatistics().total_allocated_bytes;

/**
 * Steps the data and paints, frame after frame, and records each frame.
 *
 * The first frame is the mount and is left out, as are `warmup` more: they are
 * the JIT's and the first layout's, and a steady state is the question.
 *
 * @param {Workload} workload
 * @param {{ columns?: number, rows?: number, frames?: number, warmup?: number }} [opts]
 * @returns {Promise<{ frames: Frame[], first: Frame, mounted: { bytes: number,
 *   stats: import('@ttylabs/sigil/renderer').FrameStats | undefined } }>} `mounted`
 *   is what `runApp()` wrote before it returned: the alternate screen, the modes,
 *   and the first frame, which paints every cell.
 */
export async function measureFrames(workload, opts = {}) {
  const columns = opts.columns ?? 200;
  const rows = opts.rows ?? 60;
  const count = opts.frames ?? 300;
  const warmup = opts.warmup ?? 30;
  // a frame period nobody reaches, so the renderer's own timer never paints a
  // frame in between: every frame here is one this loop asked for
  const { app, sink } = start(workload, { columns, frameMs: 60_000, rows });
  const view = app.view;
  const mounted = { bytes: sink.bytes, stats: view.stats };

  /** @type {Frame[]} */
  const frames = [];
  const once = async () => {
    await workload.step();
    await settle();
    const bytes = sink.bytes;
    const before = allocated();
    const t0 = performance.now();
    view.frame();
    const ms = performance.now() - t0;
    const after = allocated();
    return {
      allocated: before === undefined || after === undefined ? undefined : after - before,
      bytes: sink.bytes - bytes,
      ms,
      stats: view.stats,
    };
  };

  try {
    const first = await once();
    for (let i = 0; i < warmup; i++) {
      await once();
    }
    for (let i = 0; i < count; i++) {
      frames.push(await once());
    }
    return { first, frames, mounted };
  } finally {
    app.exit(0);
    await app.exited;
  }
}

/**
 * Runs a workload on the renderer's own clock for a while, fed at a rate.
 *
 * @param {Workload} workload
 * @param {{ columns?: number, rows?: number, fps: number, seconds?: number }} opts
 * @returns {Promise<{ painted: number, fed: number, seconds: number, durations: number[],
 *   bytes: number, utilization: number }>}
 */
export async function measurePaced(workload, opts) {
  const columns = opts.columns ?? 200;
  const rows = opts.rows ?? 60;
  const seconds = opts.seconds ?? 5;
  const period = 1000 / opts.fps;
  const { app, sink } = start(workload, { columns, frameMs: period, rows });

  /** @type {number[]} */
  const durations = [];
  let painted = 0;
  let fed = 0;
  // `onFrame` hands each frame the stats of the one before it
  app.view.onFrame((stats) => {
    if (stats?.painted) {
      painted++;
      durations.push(stats.duration);
    }
  });

  const bytes = sink.bytes;
  const elu = performance.eventLoopUtilization();
  const t0 = performance.now();
  const feed = setInterval(() => {
    fed++;
    void workload.step();
  }, period);
  await new Promise((resolve) => setTimeout(resolve, seconds * 1000));
  clearInterval(feed);
  const elapsed = (performance.now() - t0) / 1000;
  const utilization = performance.eventLoopUtilization(elu).utilization;
  const written = sink.bytes - bytes;
  app.exit(0);
  await app.exited;
  return { bytes: written, durations, fed, painted, seconds: elapsed, utilization };
}

/**
 * A percentile of some numbers, by the nearest rank.
 *
 * @param {readonly number[]} values
 * @param {number} p - From 0 to 100.
 */
export function percentile(values, p) {
  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.length === 0) {
    return Number.NaN;
  }
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank - 1))];
}
