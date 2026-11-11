/**
 * The stress workload: the monitor's screen built from the components it is
 * waiting for, with every figure on it changing on every frame.
 *
 * A thousand-row `DataTable` sorted by a live column, so it re-sorts on every
 * reading, and the four live charts: a `Sparkline`, a `LineChart`, a `BarChart`
 * and a `Gauge`. It is not an example of how to write a monitor -- a monitor reads
 * the machine once a second, and this reads a machine that does not exist as
 * often as it is asked -- but it is the screen btop draws, at the rate a
 * renderer is asked to keep up with.
 *
 * Written in the `ui` tag, so it runs under plain `node` the way the monitor
 * does, and fed by `machine.js`.
 */

import { formatBytes } from '../src/data.js';
import { createMachine } from './machine.js';
import {
  BarChart,
  DataTable,
  Gauge,
  LineChart,
  Panel,
  Series,
  Sparkline,
} from '@ttylabs/sigil/components';
import { State } from '@ttylabs/sigil/signals';
import { ui } from '@ttylabs/sigil/template';

/** How many samples the charts keep: a screen's width of them. */
const HISTORY = 200;

/** The layout. Colour comes from the framework's roles, as the monitor's does. */
export const stylesheet = `
  .stress { flex-direction: column; flex-grow: 1 }
  .charts { flex-direction: row; height: 16; flex-shrink: 0 }
  .chart-panel { flex-grow: 1; flex-basis: 0; min-width: 0 }
  .procs { flex-grow: 1; flex-basis: 0; min-height: 0 }
`;

/**
 * The workload, and the one way to move it.
 *
 * @param {{ processes?: number, cores?: number, churn?: number, seed?: number }} [opts] -
 *   The machine's, which `machine.js` documents.
 * @returns {import('./measure.js').Workload & { readonly formatted: number }} `App`
 *   is the screen, which takes no props, as a root does, and `sheets` its
 *   stylesheet; `step()` takes the next reading and writes it to everything on
 *   screen. Nothing draws until the frame, so a step is one frame's worth of
 *   change however many signals it writes. `formatted` counts the table's
 *   `format` calls so far.
 */
export function createStress(opts = {}) {
  const machine = createMachine(opts);
  const first = machine.step();

  const rows = new State(first.processes);
  const cpu = new Series(HISTORY);
  const rx = new Series(HISTORY);
  const tx = new Series(HISTORY);
  const cores = new State(first.cores);
  const memory = new State(first.memory);

  const write = (snap) => {
    rows.set(snap.processes);
    cpu.push((snap.cores.reduce((sum, load) => sum + load, 0) / snap.cores.length) * 100);
    rx.push(snap.net.rx);
    tx.push(snap.net.tx);
    cores.set(snap.cores);
    memory.set(snap.memory);
  };
  write(first);

  // how many cells the table has formatted, which is what the suite reads to say
  // a thousand rows cost what the rows on screen cost
  let formatted = 0;
  /** @param {(value: number) => string} fn */
  const counted = (fn) => (/** @type {unknown} */ value) => {
    formatted++;
    return fn(/** @type {number} */ (value));
  };

  const App = () => {
    const sparkline = Sparkline({
      ascii: false,
      data: cpu,
      max: 100,
      min: 0,
      props: { 'flex-grow': 1 },
    });
    const line = LineChart({
      ascii: false,
      format: (v) => formatBytes(v),
      props: { 'flex-grow': 1 },
      series: [
        { data: rx, label: 'rx', role: 'success' },
        { data: tx, label: 'tx', role: 'warn' },
      ],
    });
    const bars = BarChart({
      ascii: false,
      data: () => cores.get().map((load, i) => ({ label: String(i), value: load * 100 })),
      direction: 'vertical',
      format: (v) => v.toFixed(0),
      max: 100,
      min: 0,
      props: { 'flex-grow': 1 },
      showValues: false,
    });
    const gauge = Gauge({
      ascii: false,
      detail: () => `${formatBytes(memory.get().used)} / ${formatBytes(memory.get().total)}`,
      label: 'mem',
      max: 1,
      min: 0,
      thresholds: { error: 0.9, warn: 0.75 },
      value: () => memory.get().used / memory.get().total,
    });

    const table = DataTable({
      ascii: false,
      columns: [
        { align: 'right', header: 'PID', key: 'pid', width: 7 },
        { header: 'USER', key: 'user', width: 13 },
        {
          align: 'right',
          descendingFirst: true,
          format: counted((v) => v.toFixed(1)),
          header: 'CPU%',
          key: 'cpu',
          width: 6,
        },
        {
          align: 'right',
          descendingFirst: true,
          format: counted((v) => v.toFixed(1)),
          header: 'MEM%',
          key: 'mem',
          width: 6,
        },
        {
          align: 'right',
          format: counted(formatBytes),
          header: 'RSS',
          key: 'rss',
          width: 9,
        },
        { grow: 1, header: 'NAME', key: 'name', minWidth: 8 },
      ],
      key: (p) => p.pid,
      props: { 'flex-grow': 1, 'min-height': 0 },
      rows,
      sort: { column: 'cpu', descending: true },
    });

    return ui`<box class="stress">
      <box class="charts">
        ${Panel({ ascii: false, class: 'chart-panel', title: () => `cpu · ${cpu.get().at(-1)?.toFixed(0) ?? 0}%` }, sparkline)}
        ${Panel({ ascii: false, class: 'chart-panel', title: 'network' }, line)}
        ${Panel({ ascii: false, class: 'chart-panel', title: () => `cores · ${cores.get().length}` }, bars)}
        ${Panel({ ascii: false, class: 'chart-panel', title: 'memory' }, gauge)}
      </box>
      ${Panel({ ascii: false, class: 'procs', title: () => `processes · ${rows.get().length}` }, table)}
    </box>`;
  };

  return {
    App,
    get formatted() {
      return formatted;
    },
    sheets: [stylesheet],
    step: () => write(machine.step()),
  };
}
