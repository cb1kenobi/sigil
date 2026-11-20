/**
 * Live charts: a sparkline, a line chart, bars and a gauge, fed from signals and
 * sized by the layout.
 *
 *   node demos/components/60-live-charts.js        <- live, ten samples a second; q to quit
 *   node demos/components/60-live-charts.js | cat  <- piped: the same tree, ticked by hand
 *
 * A small monitor. Each core is a `Series` -- a ring buffer that is also a signal --
 * and a `Sparkline` beside its name; `flex: 1` gives it whatever the row leaves, and
 * it shows as many of the latest samples as it has columns. Under them a
 * `LineChart` draws two series in braille, two samples to a cell, scrolling left as
 * they are pushed to, shaded under each line, with a legend; it takes the rows its
 * panel has. Point at it and a rule stands at the sample under the pointer, with a
 * tooltip saying both values there -- the crosshair, which is why the mouse is on
 * with motion. Beside it a
 * `BarChart` of the busiest processes reads a `State`, and a `Gauge` turns yellow
 * and then red at the thresholds it was given.
 *
 * Nothing here builds a chart twice. A sample is pushed, the charts that read it
 * redraw, and a terminal that is resized hands each chart its new box -- widen the
 * window and every one of them fills the extra columns.
 *
 * Piped, there is no clock and no screen, so the same tree is ticked by hand and
 * printed at two widths: the charts are the size of the room, not of the data. Then
 * it is run on a test terminal and a pointer report is typed at the line chart, so
 * the crosshair is printed too.
 */
import { runApp, useApp } from '@ttylabs/sigil/app';
import {
  BarChart,
  Gauge,
  keyHelp,
  LineChart,
  Panel,
  Series,
  Sparkline,
} from '@ttylabs/sigil/components';
import { box, renderToString, text } from '@ttylabs/sigil/element';
import { createEffect, onCleanup } from '@ttylabs/sigil/renderer';
import { State } from '@ttylabs/sigil/signals';
import { createTestTerminal, frame } from '@ttylabs/sigil/testing';
import { themedCascade } from '@ttylabs/sigil/theme';

const live = process.stdin.isTTY && process.stdout.isTTY;

const HEIGHT = 20;
const CORES = 4;

/** The same noise every run, so that the piped output is the same every run. */
function noise(seed) {
  let state = seed;
  return () => {
    state = (state * 1103515245 + 12345) % 2147483648;
    return state / 2147483648;
  };
}

/** Where every number on the screen comes from, and the one thing that moves them. */
function source() {
  const random = noise(7);
  const cores = Array.from({ length: CORES }, () => new Series(120));
  const user = new Series(240);
  const system = new Series(240);
  const memory = new State(0.42);
  const procs = new State({ node: 0, rollup: 0, tsc: 0, vitest: 0 });
  const load = Array.from({ length: CORES }, (_, i) => 20 + i * 15);

  const tick = () => {
    for (const [i, core] of cores.entries()) {
      load[i] = Math.min(100, Math.max(0, load[i] + (random() - 0.5) * 30));
      core.push(load[i]);
    }
    const busy = load.reduce((sum, value) => sum + value, 0) / CORES;
    user.push(busy * 0.7 + random() * 5);
    system.push(busy * 0.25 + random() * 3);
    memory.set(Math.min(1, Math.max(0.2, memory.get() + (random() - 0.45) * 0.04)));
    procs.set({
      node: Math.round(load[0] * 0.8),
      rollup: Math.round(load[1] * 0.6),
      tsc: Math.round(load[2] * 0.9),
      vitest: Math.round(load[3] * 0.7),
    });
  };

  return { cores, memory, procs, system, tick, user };
}

/**
 * The sheet: the cores' panel as tall as its rows, a label column, and the two
 * panels of the bottom row sharing the rest.
 */
const sheet = `
  .cores { flex-grow: 0 }
  .label { width: 6 }
  .figure { width: 5 }
  .half { flex: 1; min-width: 0 }
`;

/**
 * The tree, built once; everything in it reads the source. With a router, the line
 * chart follows the pointer through it.
 */
function scene(data, input) {
  const coreRow = (core, i) => {
    const figure = text('', { class: 'figure' });
    // the figure is the one thing here that is not a chart, so it is an effect
    createEffect(() => {
      figure.setText(`${String(Math.round(core.at(-1) ?? 0)).padStart(4)}%`);
    });
    return box(
      { 'flex-direction': 'row' },
      text(`cpu${i}`, { class: 'label sigil-muted' }),
      Sparkline({ data: core, max: 100, min: 0, props: { flex: 1 } }),
      figure
    );
  };

  const cpu = Panel(
    { props: { class: 'cores' }, title: `cpu · ${CORES} cores` },
    ...data.cores.map(coreRow)
  );

  const history = Panel(
    { props: { class: 'half' }, title: 'load' },
    LineChart({
      // a rule at the sample under the pointer, and a tooltip saying both values
      ...(input === undefined ? {} : { crosshair: { input } }),
      fill: true,
      format: (value) => `${Math.round(value)}%`,
      max: 100,
      min: 0,
      props: { 'flex-grow': 1 },
      series: [
        { data: data.user, label: 'user' },
        { data: data.system, label: 'system' },
      ],
    })
  );

  const side = Panel(
    { props: { class: 'half' }, title: 'processes' },
    BarChart({ data: data.procs, max: 100, props: { 'flex-grow': 1 } }),
    Gauge({
      label: 'mem',
      thresholds: { error: 0.85, warn: 0.6 },
      value: data.memory,
    })
  );

  return box(
    { 'flex-direction': 'column', height: HEIGHT },
    cpu,
    box({ 'flex-direction': 'row', 'flex-grow': 1 }, history, side)
  );
}

/**
 * The monitor as an app: the scene, ticking, over the key help. `q` and Ctrl-C are
 * the runner's own.
 *
 * @param data - The source.
 * @param tick - Whether to tick on a clock.
 */
function monitor(data, tick) {
  return () => {
    const { input } = useApp();
    if (tick) {
      const timer = setInterval(data.tick, 100);
      onCleanup(() => clearInterval(timer));
    }
    return box(
      { 'flex-direction': 'column' },
      scene(data, input),
      box({ 'margin-top': 1 }, keyHelp(input))
    );
  };
}

if (live) {
  const data = source();
  for (let i = 0; i < 30; i++) {
    data.tick();
  }
  // inline, under the prompt, and with motion: the crosshair follows a pointer
  // with no button held, which is a report for every cell it crosses
  const app = runApp(monitor(data, true), {
    fullscreen: false,
    mouse: { motion: true },
    sheets: [sheet],
  });
  process.exitCode = await app.exited;
} else {
  const data = source();
  const root = scene(data);
  const cascade = themedCascade({ sheets: [sheet] });

  // an effect runs on the microtask after the write that wakes it
  const settle = () => new Promise((resolve) => setImmediate(resolve));

  /** Prints the tree at a width under a heading. */
  const show = async (label, width) => {
    await settle();
    const body = renderToString(root, { cascade, colorLevel: 0, height: HEIGHT, width });
    console.log(`-- ${label}\n${body}\n`);
  };

  for (let i = 0; i < 12; i++) {
    data.tick();
  }
  await show('twelve samples in: the history fills in from the right', 72);

  for (let i = 0; i < 60; i++) {
    data.tick();
  }
  await show('sixty more: the line has scrolled, and the sparklines are full', 72);

  await show('the same tree at 52 columns: every chart is the size of its box', 52);

  // the pointer needs a screen, so the same monitor runs on a test terminal and a
  // pointer report is typed at it: an SGR report counts from one, and 35 is a move
  // with nothing held
  const term = createTestTerminal({ colorLevel: 0, columns: 72, rows: HEIGHT + 2 });
  const app = runApp(monitor(data, false), {
    console: false,
    detect: false,
    mouse: { motion: true },
    sheets: [sheet],
    terminal: term.terminal,
  });
  await frame(app);
  const ESC = String.fromCharCode(0x1b);
  await term.press(`${ESC}[<35;20;12M`);
  await frame(app);
  await frame(app);
  const screen = term.viewport.map((line) => line.trimEnd()).join('\n');
  console.log(
    `-- the pointer on the load chart: a rule at that sample, and its values\n${screen}\n`
  );
  app.exit(0);
  await app.exited;
}
