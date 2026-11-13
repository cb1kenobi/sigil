# A full-screen performance budget — how it was measured

This is the record behind "A full-screen performance budget" in
[packages/sigil/src/renderer/AGENTS.md](../../packages/sigil/src/renderer/AGENTS.md)
and "One code unit is one cluster" in
[packages/sigil/src/width/AGENTS.md](../../packages/sigil/src/width/AGENTS.md).
The decisions are in those files. This file covers the runs, the profiles, the
comparison and the sabotage pass that the decisions rest on.

Everything was measured on node 26.10.0, macOS, an Apple M5 Pro with 18 cores and
48 GiB. Five other agents were building and testing in sibling worktrees the
whole time, so the load average was between 18 and 31. Each figure was taken at
least three times, and the spread is given. Treat the absolute times as a busy
machine's; the ratios between interleaved runs are the stronger evidence.

## The four questions, as the ticket put them

1. **The workload.** It was asked for at 200 by 60, with a 1,000-row live table
   and four live charts, at 30 and at 60 frames a second. It was built that way.
   The charts are one of each kind SIG-284 shipped. "Live" was taken at its worst:
   every row is a new object on every reading, two processes exit and two start,
   and the sort is by CPU, so the order changes on every frame. A real monitor
   reads once a second. This one reads on every frame, because the question is
   what the renderer costs when everything moves.

   The alternative was the monitor itself, fed a fast synthetic machine. That
   would share the most code, but its stand-ins would be measured, and the
   README says they will be deleted. So the monitor is measured as well, as a
   second workload on the same machine (`stress/monitor.js`), but the budget is
   the components'.

2. **What to measure.**
   - Frame time at p50 and p99, both frame after frame and paced.
   - Bytes written per frame, counted in UTF-8 at the sink.
   - Allocation per frame, from V8's `total_allocated_bytes`.
   - The style table's size and sweeps, from `FrameStats`.
   - The tree's counts (elements, changed, restyled, cells), also from `FrameStats`.

   Allocation counts were considered as well. V8 exposes no count of objects
   allocated, only bytes. The heap sampling profiler gives where the bytes went
   but not a count, so it was used for diagnosis and not as a measure.

3. **How it is enforced.** Ceilings on counts in the suite, and a benchmark run by
   hand for the times. The reasons are in the renderer entry.

4. **The comparison.** Ink and OpenTUI, in a throwaway project in scratch,
   installed with `npm install --save-exact` and named in no manifest of this
   repository. The scripts are at the end of this file.

## The fix, A against B

A was `main`'s `dist/` with the `graphemes()` shortcut disabled, built into a
scratch directory. B was the branch's `dist/`. They were run interleaved, ABABAB,
`benchmark.js --only stress --seconds 2`, with the load average at 23 to 24:

| run | frame p50 A | frame p50 B | frame p99 A | frame p99 B |
| --- | ----------- | ----------- | ----------- | ----------- |
| 1   | 12.01 ms    | 10.01 ms    | 17.93 ms    | 15.09 ms    |
| 2   | 11.49 ms    | 9.56 ms     | 16.63 ms    | 13.62 ms    |
| 3   | 11.59 ms    | 9.80 ms     | 17.01 ms    | 14.25 ms    |

Allocation went from 22.0 to 22.1 MiB a frame down to 21.4 to 21.5. GC pauses
went from 391 to 417 ms per run down to 304 to 326. The bytes were identical:
3.9 KiB at p50 and 4.3 KiB at most, on both sides.

The first sighting came from an unminified build of each side, three runs each,
and it agreed: 11.33 to 11.63 ms before and 9.86 to 10.07 ms after.

## Where the frame goes

A CPU profile was taken over 230 frames of the stress workload. The build was
unminified, so the function names could be read. The recipe:

1. Copy `tsdown.config.ts` with `minify: false`.
2. Build it into scratch with `npx tsdown -c <copy> -d <scratch>/plain --no-dts`.
3. Run with `node --import <hooks> --cpu-prof`. The hooks file is a
   `registerHooks()` resolve hook that maps `@ttylabs/sigil/<x>` to
   `<scratch>/plain/<x>.mjs`.

Inclusive time, as a share of the whole profile, before the fix:

| what                                    | share |
| --------------------------------------- | ----- |
| the frame (`runFrame`)                  | 84%   |
| restyle (`settleStyles`)                | 28%   |
| layout (`arrange`)                      | 23%   |
| paint, including the diff               | 15%   |
| effects: the charts' and table's redraw | 14%   |
| the table's sorted rows (`Computed`)    | 12%   |
| garbage collection                      | 11%   |
| `Intl.Segmenter` (`segment`, self)      | 14%   |

The segmenter's time broke down by caller like this:

- `paintBorder` → `Painter.text` → `CellBuffer.write` → `graphemes`: 6.4%
- `stringWidth` from the text measure: 2.6%
- `segmentNode`'s width: 1.5%
- `paintText`: 1.4%
- `wrap`'s tokenizer: 0.9%

The first of these is the fix.

The heap sampling profiler, run with `includeObjectsCollectedByMajorGC` and
`includeObjectsCollectedByMinorGC` at a 4 KiB interval, saw 2.7 GB over 110
frames. The top self allocators:

- `resolveSheets`: 17.6%
- `makeItem`: 5.5%
- `readSettings`: 4.9%
- `measureUncached`: 4.7%
- `margins`: 3.0%
- `CellBuffer.text`: 2.8%
- `match`: 2.6%
- `remeasureLine`: 2.4%

Inclusive, `settleStyles` was 39% and `arrange` 34%. SIG-381 is filed for this.

The table and the charts were split by running the workload with one half
removed. Unminified, single runs, before the fix:

| variant     | frame p50 | allocated | elements | changed | restyled |
| ----------- | --------- | --------- | -------- | ------- | -------- |
| both        | 12.83 ms  | 23.3 MiB  | 1,064    | 845     | 876      |
| table only  | 6.83 ms   | 13.9 MiB  | 481      | 451     | 454      |
| charts only | 6.18 ms   | 11.7 MiB  | 586      | 394     | 422      |

Both halves rebuild nearly everything they show on every reading. They are
SIG-378 and SIG-379.

## The paced runs

These are from `benchmark.js` after the fix. Four runs; the first three are the
`--seconds 2` B runs above, and the fourth is a full `--seconds 5` run.

| rate | painted a second | frame p50        | frame p99         | written a second | event loop |
| ---- | ---------------- | ---------------- | ----------------- | ---------------- | ---------- |
| 30   | 28.3 to 28.6     | 9.59 to 10.11 ms | 13.02 to 15.75 ms | 98 to 108 KiB    | 29 to 31%  |
| 60   | 55.0 to 57.4     | 9.70 to 11.05 ms | 11.92 to 23.67 ms | 212 to 213 KiB   | 60 to 68%  |

The monitor as written, paced, in one run: 3.57 ms at p50 and 4.22 ms at p99 at
30, with the event loop 10% busy; 3.70 ms and 4.45 ms at 60, 22% busy. It painted
25.8 frames a second of 28.6 readings at 30, because two readings that land
inside one frame period are one frame. Its sampler is asynchronous, so a reading
can arrive after the frame it was meant for has been asked for.

## Counts are the same on every run and every node

The deterministic counts of 60 and 300 frames were identical on node 24.18.0 and
26.10.0, and on repeated runs of each. Over 60 frames after five to warm up:

| count                               | value          |
| ----------------------------------- | -------------- |
| bytes, the mount (all 12,000 cells) | 16,693         |
| bytes, the most in a frame          | 4,142          |
| bytes, the 60 frames together       | 217,925        |
| cells, the most in a frame          | 2,114          |
| restyled, the most in a frame       | 935            |
| changed, the most in a frame        | 901            |
| elements, fewest to most            | 1,043 to 1,059 |
| styles                              | 7              |
| sweeps                              | 0              |
| `format` calls a frame              | 123            |

Over 300 frames the figures were 4,416 bytes at most, 2,227 cells, 948 restyled,
1,043 to 1,071 elements, still 7 styles, and no sweep. The ceilings were set from
the 60-frame figures, because that is what the test runs.

`total_allocated_bytes` was `undefined` on 24.18.0. The benchmark prints `n/a`
for it there.

## Sabotage

Each break was made in source and built, and the stress test was run. Each was
then restored, and the restore was checked with `git diff`.

| break                                                      | what failed                                               |
| ---------------------------------------------------------- | --------------------------------------------------------- |
| `present()` always diffs in full                           | frame bytes: 17,085 > 8,500                               |
| `DataTable` formats every new row, declared width or not   | `format` calls: 3,123 > 250                               |
| `rowWindow()` returns every row                            | elements: 11,592 > 2,200                                  |
| chart segments get a background that varies by text length | styles: 72 > 14, and nothing else                         |
| chart segments get a colour from a module counter          | frame bytes, and the repeatability test                   |
| the machine uses `Math.random()`                           | the repeatability test alone                              |
| `graphemes()` without the one-code-unit shortcut           | `should build no segmenter to split one code unit`, alone |

## Ink and OpenTUI

The versions were Ink 8.0.0 with React 19.3.1, which brought react-reconciler
0.34.0 and yoga-layout 3.2.1, and `@opentui/core` 0.8.3, which runs on node 26
through FFI. Both ran on node 26.10.0 like sigil.

Each draws the same seeded machine with the same sort, at 200 by 60. Neither has
a windowed table, so each draws only the rows that fit. The charts are sigil's
own string charts set in a text node: coloured at level 3 in Ink, and uncoloured
in OpenTUI, whose text renderable takes no escape sequences. The cpu chart is the
one-row `sparkline()`, against the stress workload's fourteen-row block graph.
Both of those differences favour the comparison, not sigil.

Ink is timed from the state update to its `onRender` callback, which Ink calls
after it has written the frame. That includes one scheduler hop. Its own
`renderTime`, which covers its output pass alone, was 4.1 to 4.6 ms at p50.
OpenTUI is timed from writing the reading into the renderables to the end of
`renderOnce()` on the test renderer, which paints and diffs and writes nowhere.
For bytes, the CLI renderer was used with a stream that counts, and a frame was
over at its `frame` event.

Interleaved with the stress workload, three rounds, load average 19 to 22:

| renderer                       | frame p50         | frame p99         | bytes a frame | allocated        |
| ------------------------------ | ----------------- | ----------------- | ------------- | ---------------- |
| sigil stress                   | 9.75 to 10.31 ms  | 13.67 to 16.27 ms | 3.9 KiB       | 21.5 MiB         |
| sigil, the monitor's stand-ins | 3.44 to 3.65 ms   | 5.01 to 5.81 ms   | 6.0 KiB       | 7.0 MiB          |
| Ink                            | 12.53 to 12.95 ms | 20.89 to 22.00 ms | 15,955 B      | 41.3 to 41.4 MiB |
| Ink, `incrementalRendering`    | 15.15 to 16.02 ms | 22.06 to 24.91 ms | 11,265 B      | 46.7 MiB         |
| OpenTUI, test renderer         | 5.30 to 5.40 ms   | 7.97 to 10.68 ms  | (no output)   | 8.9 to 9.0 MiB   |
| OpenTUI, CLI renderer          | 5.34 to 5.43 ms   | 9.25 to 9.39 ms   | 16,356 B      | 8.9 to 9.0 MiB   |

A second set of three rounds was run after the scripts were tidied, with the load
average at 25 to 31. The bytes and the allocation were identical. The times all
moved up, and they moved unevenly:

- sigil stress was 11.48, 20.00 and 13.25 ms.
- Ink was 14.36, 14.58 and 27.81 ms.
- OpenTUI was 5.89, 6.05 and 8.76 ms.

In one round Ink came out ahead of sigil. That is what a single round under that
load is worth, and why the first set, under less load, is the one quoted.

To run it again, in an empty directory whose `package.json` is
`{ "type": "module" }`:

```
npm install --save-exact ink@8.0.0 react@19.3.1 @opentui/core@0.8.3
SIGIL=<this repository> node ink-stress.mjs
SIGIL=<this repository> node ink-stress.mjs --incremental
SIGIL=<this repository> node --no-warnings ot-stress.mjs
SIGIL=<this repository> node --no-warnings ot-stress.mjs --cli
```

`pnpm build` has to have run in this repository first: the scripts import the
stress machine from `examples/` and the string charts from `packages/sigil/dist`.

`common.mjs`:

```js
// What both comparisons share with sigil's stress workload: the machine, the
// sort, the history and the chart strings. SIGIL is the repository's root.
const root = process.env.SIGIL;
const { createMachine } = await import(`${root}/examples/system-monitor/stress/machine.js`);
const { formatBytes } = await import(`${root}/examples/system-monitor/src/data.js`);
export const charts = await import(`${root}/packages/sigil/dist/components.mjs`);
export const { createAnsi } = await import(`${root}/packages/sigil/dist/ansi.mjs`);
export { formatBytes };

export const W = 200;
export const H = 60;
export const CHART_ROWS = 16;
export const FRAMES = 300;
export const WARMUP = 30;
/** The rows of the table that fit: the panel's border, its title and the heading. */
export const BODY_ROWS = H - CHART_ROWS - 3;
export const WIDTHS = [7, 13, 6, 6, 9];

export function percentile(values, p) {
  const s = [...values].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1))];
}

/** A reading a frame: the machine moved, the rows sorted by CPU, the history pushed. */
export function createFeed() {
  const machine = createMachine();
  const hist = { cpu: [], rx: [], tx: [] };
  const push = (k, v) => {
    hist[k].push(v);
    if (hist[k].length > W) hist[k].shift();
  };
  return () => {
    const snap = machine.step();
    push('cpu', (snap.cores.reduce((a, b) => a + b, 0) / snap.cores.length) * 100);
    push('rx', snap.net.rx);
    push('tx', snap.net.tx);
    const rows = [...snap.processes].sort((a, b) => b.cpu - a.cpu);
    return { hist, rows, snap };
  };
}

/** The four charts as strings, at a panel's inner width. */
export function drawCharts({ hist, snap }, ansi) {
  const width = W / 4 - 2;
  const { barChart, gauge, lineChart, sparkline } = charts;
  return [
    sparkline(hist.cpu, { ansi, ascii: false, max: 100, min: 0, width }),
    lineChart(
      [
        { data: hist.rx, label: 'rx', role: 'success' },
        { data: hist.tx, label: 'tx', role: 'warn' },
      ],
      { ansi, ascii: false, format: formatBytes, height: CHART_ROWS - 6, step: 1, width }
    ),
    barChart(
      snap.cores.map((load, i) => ({ label: String(i), value: load * 100 })),
      {
        ansi,
        ascii: false,
        direction: 'vertical',
        height: CHART_ROWS - 5,
        max: 100,
        min: 0,
        showValues: false,
        width,
      }
    ),
    gauge(snap.memory.used / snap.memory.total, {
      ansi,
      ascii: false,
      detail: `${formatBytes(snap.memory.used)} / ${formatBytes(snap.memory.total)}`,
      label: 'mem',
      thresholds: { error: 0.9, warn: 0.75 },
      width: width - 30,
    }),
  ];
}

/** A process as the table's six cells. */
export function cells(p) {
  return [
    String(p.pid).padStart(7),
    p.user.padEnd(13).slice(0, 13),
    p.cpu.toFixed(1).padStart(6),
    p.mem.toFixed(1).padStart(6),
    formatBytes(p.rss).padStart(9),
    p.name,
  ];
}
```

`ink-stress.mjs`:

```js
// node ink-stress.mjs [--incremental]
import {
  BODY_ROWS,
  cells,
  CHART_ROWS,
  createAnsi,
  createFeed,
  drawCharts,
  FRAMES,
  H,
  percentile,
  W,
  WARMUP,
  WIDTHS,
} from './common.mjs';
import { Box, render, Text } from 'ink';
import { PassThrough } from 'node:stream';
import { getHeapStatistics } from 'node:v8';
import React, { useState } from 'react';

const h = React.createElement;
const ansi = createAnsi({ level: 3 });
const incremental = process.argv.includes('--incremental');

let bytes = 0;
const stdout = Object.assign(new PassThrough(), { columns: W, isTTY: true, rows: H });
stdout.write = (chunk, enc, cb) => {
  bytes += Buffer.byteLength(chunk);
  (typeof enc === 'function' ? enc : cb)?.();
  return true;
};
const stdin = Object.assign(new PassThrough(), {
  isTTY: true,
  ref() {},
  setRawMode() {},
  unref() {},
});

const step = createFeed();
let setData;
const Panel = ({ children, title, ...props }) =>
  h(
    Box,
    { borderStyle: 'round', flexDirection: 'column', ...props },
    h(Text, null, title),
    children
  );
const cell = (text, i, bold) =>
  h(
    Box,
    { flexGrow: i === 5 ? 1 : 0, key: i, marginRight: 2, width: WIDTHS[i] },
    h(Text, { bold, wrap: 'truncate' }, text)
  );

function App() {
  const [data, set] = useState(step);
  setData = set;
  const [cpu, net, bars, mem] = drawCharts(data, ansi);
  const titles = [
    `cpu · ${data.hist.cpu.at(-1).toFixed(0)}%`,
    'network',
    `cores · ${data.snap.cores.length}`,
    'memory',
  ];
  return h(
    Box,
    { flexDirection: 'column', height: H, width: W },
    h(
      Box,
      { flexDirection: 'row', height: CHART_ROWS },
      ...[cpu, net, bars, mem].map((chart, i) =>
        h(Panel, { flexBasis: 0, flexGrow: 1, key: i, title: titles[i] }, h(Text, null, chart))
      )
    ),
    h(
      Panel,
      { flexGrow: 1, title: `processes · ${data.rows.length}` },
      h(
        Box,
        { flexDirection: 'row' },
        ...['PID', 'USER', 'CPU%', 'MEM%', 'RSS', 'NAME'].map((t, i) => cell(t, i, true))
      ),
      ...data.rows
        .slice(0, BODY_ROWS)
        .map((p) =>
          h(Box, { flexDirection: 'row', key: p.pid }, ...cells(p).map((c, i) => cell(c, i, false)))
        )
    )
  );
}

let rendered = () => {};
const app = render(h(App), {
  alternateScreen: true,
  exitOnCtrlC: false,
  incrementalRendering: incremental,
  interactive: true,
  maxFps: 10_000,
  onRender: () => rendered(),
  patchConsole: false,
  stderr: stdout,
  stdin,
  stdout,
});
await new Promise((resolve) => setTimeout(resolve, 50));

// from the state update to Ink's `onRender`, which it calls after writing the
// frame: React's reconcile, Yoga's layout, Ink's output and the write
const frames = [];
for (let i = 0; i < WARMUP + FRAMES; i++) {
  const next = step();
  // past the throttle window, so the update renders at once
  await new Promise((resolve) => setTimeout(resolve, 2));
  const before = { allocated: getHeapStatistics().total_allocated_bytes, bytes };
  const done = new Promise((resolve) => (rendered = resolve));
  const t0 = performance.now();
  setData(next);
  await done;
  const ms = performance.now() - t0;
  if (i >= WARMUP) {
    frames.push({
      allocated: getHeapStatistics().total_allocated_bytes - before.allocated,
      bytes: bytes - before.bytes,
      ms,
    });
  }
}
app.unmount();
const of = (key) => frames.map((f) => f[key]);
console.log(
  `ink${incremental ? ' incremental' : ''}: p50 ${percentile(of('ms'), 50).toFixed(2)} ms, p99 ${percentile(of('ms'), 99).toFixed(2)} ms, ` +
    `${percentile(of('bytes'), 50)} B a frame, ${(percentile(of('allocated'), 50) / 2 ** 20).toFixed(1)} MiB allocated`
);
process.exit(0);
```

`ot-stress.mjs`:

```js
// node --no-warnings ot-stress.mjs [--cli]
import {
  BODY_ROWS,
  cells,
  CHART_ROWS,
  createAnsi,
  createFeed,
  drawCharts,
  FRAMES,
  H,
  percentile,
  W,
  WARMUP,
  WIDTHS,
} from './common.mjs';
import { BoxRenderable, createCliRenderer, TextRenderable } from '@opentui/core';
import { createTestRenderer } from '@opentui/core/testing';
import { PassThrough, Writable } from 'node:stream';
import { getHeapStatistics } from 'node:v8';

// a text renderable takes no escape sequences, so the charts go in uncoloured
const ansi = createAnsi({ level: 0 });
const cli = process.argv.includes('--cli');

// the test renderer paints and diffs and writes nowhere; the CLI renderer writes
// to a stream that counts, and a frame is over when it says so
let bytes = 0;
let renderer;
let renderOnce;
if (cli) {
  const stdout = Object.assign(
    new Writable({ write: (chunk, _, cb) => ((bytes += chunk.length), cb()) }),
    { columns: W, getColorDepth: () => 24, isTTY: true, rows: H }
  );
  const stdin = Object.assign(new PassThrough(), {
    isTTY: true,
    ref() {},
    setRawMode: () => stdin,
    unref() {},
  });
  renderer = await createCliRenderer({
    consoleMode: 'disabled',
    exitOnCtrlC: false,
    exitSignals: [],
    height: H,
    maxFps: 1000,
    screenMode: 'alternate-screen',
    stdin,
    stdout,
    targetFps: 1000,
    useKittyKeyboard: null,
    useMouse: false,
    width: W,
  });
  renderOnce = async () => {
    const done = new Promise((resolve) => renderer.once('frame', resolve));
    renderer.requestRender();
    await done;
    await new Promise((resolve) => setImmediate(resolve));
  };
} else {
  ({ renderer, renderOnce } = await createTestRenderer({ height: H, width: W }));
}

const step = createFeed();
const box = (opts) => new BoxRenderable(renderer, opts);
const text = () => new TextRenderable(renderer, { content: '' });
const panel = (title, opts = {}) =>
  box({
    border: true,
    borderStyle: 'rounded',
    flexDirection: 'column',
    flexGrow: 1,
    title,
    ...opts,
  });
const column = box({ flexDirection: 'column', height: H, width: W });
const top = box({ flexDirection: 'row', height: CHART_ROWS });
const panels = ['cpu', 'network', 'cores', 'memory'].map((title) => panel(title, { flexBasis: 0 }));
const chartTexts = panels.map((p) => {
  const t = text();
  p.add(t);
  top.add(p);
  return t;
});
const procs = panel('processes');
const row = (labels) => {
  const line = box({ flexDirection: 'row', height: 1 });
  const texts = labels.map((label, i) => {
    const cell = box({ flexGrow: i === 5 ? 1 : 0, marginRight: 2, width: WIDTHS[i] });
    const t = new TextRenderable(renderer, { content: label });
    cell.add(t);
    line.add(cell);
    return t;
  });
  procs.add(line);
  return texts;
};
row(['PID', 'USER', 'CPU%', 'MEM%', 'RSS', 'NAME']);
// a pool rewritten in place: there is no keyed reconciler, so this is how an app writes it
const pool = Array.from({ length: BODY_ROWS }, () => row(['', '', '', '', '', '']));
column.add(top);
column.add(procs);
renderer.root.add(column);

const apply = (data) => {
  drawCharts(data, ansi).forEach((chart, i) => (chartTexts[i].content = chart));
  panels[0].title = `cpu · ${data.hist.cpu.at(-1).toFixed(0)}%`;
  panels[2].title = `cores · ${data.snap.cores.length}`;
  procs.title = `processes · ${data.rows.length}`;
  pool.forEach((texts, i) => {
    const values = data.rows[i] ? cells(data.rows[i]) : ['', '', '', '', '', ''];
    texts.forEach((t, j) => (t.content = values[j]));
  });
};
apply(step());
await renderOnce();

// from writing the reading into the renderables to the end of the frame
const frames = [];
for (let i = 0; i < WARMUP + FRAMES; i++) {
  const next = step();
  const before = { allocated: getHeapStatistics().total_allocated_bytes, bytes };
  const t0 = performance.now();
  apply(next);
  await renderOnce();
  const ms = performance.now() - t0;
  if (i >= WARMUP) {
    frames.push({
      allocated: getHeapStatistics().total_allocated_bytes - before.allocated,
      bytes: bytes - before.bytes,
      ms,
    });
  }
}
renderer.destroy();
const of = (key) => frames.map((f) => f[key]);
console.log(
  `opentui${cli ? ' cli' : ''}: p50 ${percentile(of('ms'), 50).toFixed(2)} ms, p99 ${percentile(of('ms'), 99).toFixed(2)} ms, ` +
    `${cli ? `${percentile(of('bytes'), 50)} B a frame, ` : ''}${(percentile(of('allocated'), 50) / 2 ** 20).toFixed(1)} MiB allocated`
);
process.exit(0);
```
