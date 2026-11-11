/**
 * What a full screen that changes on every frame costs: the frame's time, its
 * bytes, its allocation, and whether the loop keeps up at 30 and at 60.
 *
 *   pnpm build && node examples/system-monitor/stress/benchmark.js
 *   pnpm build && node examples/system-monitor/stress/benchmark.js --seconds 10 --frames 600
 *
 * Run by hand and committed for the reason `benchmark-paint-cull.mjs` is: a
 * number in a pull request is a claim the next reader has to trust, and a script
 * they can run is one they can check. The suite holds what does not depend on
 * the machine -- bytes, cells, elements, the style table -- in
 * `test/stress.test.js`; the times are here, where nothing else is running.
 *
 * Two workloads over one machine, 200 by 60, a thousand processes on sixteen
 * cores. `stress` is `app.js`: the screen built from the shipped `DataTable` and
 * the four live charts. `monitor` is the example as it is, with the stand-ins
 * those components are meant to replace. Each is measured twice: frame after
 * frame as fast as they go, which is the frame's own cost, and paced by the
 * renderer at 30 and at 60 frames a second with a reading every frame.
 *
 * Imports `@ttylabs/sigil` by name, so it measures `dist/` -- what ships.
 */

import { createStress } from './app.js';
import { measureFrames, measurePaced, percentile } from './measure.js';
import { createMonitor } from './monitor.js';
import { cpus, totalmem } from 'node:os';
import { PerformanceObserver } from 'node:perf_hooks';
import { parseArgs } from 'node:util';

const { values } = parseArgs({
  options: {
    frames: { default: '300', type: 'string' },
    only: { type: 'string' },
    seconds: { default: '5', type: 'string' },
  },
});
const FRAMES = Number(values.frames);
const SECONDS = Number(values.seconds);

const WORKLOADS = /** @type {const} */ ([
  ['stress', createStress],
  ['monitor', createMonitor],
]);

/** Milliseconds, to two places. */
const ms = (n) => n.toFixed(2);
/** Bytes, in a unit somebody reads. */
const size = (n) =>
  n === undefined
    ? 'n/a'
    : n >= 1024 ** 2
      ? `${(n / 1024 ** 2).toFixed(1)} MiB`
      : n >= 1024
        ? `${(n / 1024).toFixed(1)} KiB`
        : `${Math.round(n)} B`;

/** Garbage collection over a run, from the observer rather than a guess. */
function watchGc() {
  let pauses = 0;
  let total = 0;
  const observer = new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) {
      pauses++;
      total += entry.duration;
    }
  });
  observer.observe({ entryTypes: ['gc'] });
  return async () => {
    // entries are delivered on a later turn, so give them one
    await new Promise((resolve) => setTimeout(resolve, 10));
    observer.disconnect();
    return { pauses, total };
  };
}

console.log(
  `node ${process.version}, ${process.platform} ${process.arch}, ${cpus()[0]?.model ?? 'unknown cpu'}, ` +
    `${cpus().length} cores, ${size(totalmem())}`
);
console.log(`200x60, 1,000 processes, 16 cores; ${FRAMES} frames after 30 to warm up\n`);

for (const [name, make] of WORKLOADS) {
  if (values.only && values.only !== name) {
    continue;
  }
  const gc = watchGc();
  const { first, frames, mounted } = await measureFrames(make(), { frames: FRAMES });
  const { pauses, total } = await gc();
  const times = frames.map((f) => f.ms);
  const bytes = frames.map((f) => f.bytes);
  const allocated = frames.map((f) => f.allocated).filter((n) => n !== undefined);
  const last = frames.at(-1)?.stats;
  const runMs = times.reduce((sum, t) => sum + t, 0);

  console.log(`${name}, frame after frame`);
  console.log(
    `  frame      p50 ${ms(percentile(times, 50))} ms  p99 ${ms(percentile(times, 99))} ms  ` +
      `max ${ms(Math.max(...times))} ms`
  );
  console.log(
    `  bytes      p50 ${size(percentile(bytes, 50))}  max ${size(Math.max(...bytes))}  ` +
      `(the mount, which paints every cell: ${size(mounted.bytes)})`
  );
  console.log(
    `  allocated  p50 ${allocated.length ? size(percentile(allocated, 50)) : 'n/a'} a frame  ` +
      `gc ${pauses} pauses, ${ms(total)} ms (${((total / runMs) * 100).toFixed(0)}% of the frames' time)`
  );
  console.log(
    `  tree       ${last?.elements} elements, ${last?.changed} changed and ${last?.resolved} ` +
      `restyled a frame, ${last?.cells} cells painted`
  );
  console.log(
    `  styles     ${mounted.stats?.styles} interned after the mount, ${first.stats?.styles} after the first reading, ${last?.styles} after ` +
      `${FRAMES + 31}, ${last?.sweeps} sweeps`
  );

  for (const fps of [30, 60]) {
    const paced = await measurePaced(make(), { fps, seconds: SECONDS });
    console.log(
      `  at ${fps}      ${(paced.painted / paced.seconds).toFixed(1)} frames a second painted ` +
        `of ${(paced.fed / paced.seconds).toFixed(1)} readings, frame p50 ` +
        `${ms(percentile(paced.durations, 50))} ms p99 ${ms(percentile(paced.durations, 99))} ms, ` +
        `${size(paced.bytes / paced.seconds)}/s written, event loop ${(paced.utilization * 100).toFixed(0)}% busy`
    );
  }
  console.log('');
}
