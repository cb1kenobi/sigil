/**
 * The monitor: per-core load, memory and network over time, and a process table.
 *
 * Written in the `ui` tag, so it runs under plain `node` with nothing compiling
 * it. `App` is the whole screen and knows nothing about where it is drawn:
 * `main.js` builds the terminal, the router and the renderer around it, and a
 * test builds the same thing over a fake terminal.
 */

import {
  filterProcesses,
  formatBytes,
  pushHistory,
  reselect,
  SORT_ORDER,
  sortProcesses,
} from './data.js';
import { LiveChart, Panel, ProcessTable } from './stand-ins.js';
import {
  confirmModal,
  gaugeView,
  keyHelp,
  lineChartView,
  sparklineView,
  TextField,
} from '@ttylabs/sigil/components';
import { createEffect, For, onCleanup } from '@ttylabs/sigil/renderer';
import { Computed, State, untrack } from '@ttylabs/sigil/signals';
import { ui } from '@ttylabs/sigil/template';
import { parseTheme, themedCascade } from '@ttylabs/sigil/theme';
import { AMBER, MONO, NEON, PHOSPHOR, VIOLET } from '@ttylabs/sigil/themes';

/** How many samples each chart keeps: two minutes at one a second. */
const HISTORY = 120;

/**
 * The layout. Every colour comes from a role class (`sigil-accent`,
 * `sigil-muted`, ...), so a theme restyles the whole screen.
 */
const LAYOUT = `
  .app { flex-direction: column; width: 100%; height: 100% }
  .top { flex-direction: row; flex-grow: 1; flex-basis: 0; min-height: 0 }
  .side { flex-direction: column; flex-grow: 1; flex-basis: 0; min-width: 0 }
  .panel {
    border: round; position: relative; flex-direction: column;
    padding-left: 1; padding-right: 1; min-width: 0; min-height: 0
  }
  .panel-body { flex-direction: column; flex-grow: 1; min-height: 0; overflow: hidden }
  .panel-title { position: absolute; top: -1; left: 1; white-space: pre }
  .cpu { flex-grow: 1; flex-basis: 0 }
  .mem, .net { flex-grow: 1; flex-basis: 0 }
  .procs { flex-grow: 1; flex-basis: 0 }
  .row { flex-direction: row; height: 1; column-gap: 1 }
  /* more cores than rows wrap into a second column, and the columns share the
     width: align-content stretches each line across the panel */
  .cores {
    flex-direction: column; flex-wrap: wrap; flex-grow: 1; min-height: 0;
    align-content: stretch; column-gap: 2
  }
  .core { min-width: 20 }
  .core .figure { width: 4 }
  .label { width: 5; flex-shrink: 0 }
  .figure { width: 10; flex-shrink: 0; text-align: right }
  .live-chart { flex-grow: 1; flex-basis: 0; min-width: 0; min-height: 0 }
  .grow { flex-grow: 1; min-height: 0 }
  .table { flex-direction: column; flex-grow: 1; min-height: 0 }
  .table-body { flex-direction: column; flex-grow: 1; min-height: 0 }
  .table-row.selected { inverse: true }
  .filter { flex-direction: row; height: 1; column-gap: 1 }
  .footer { height: 1; padding-left: 1; column-gap: 2 }
`;

/**
 * Every role back to nothing, so that a theme applied after another one does
 * not inherit what the last one set and this one did not.
 *
 * Restates what `demos/style/04-theme-switcher.js` restates, because a cascade
 * has no way to take a sheet back out: switching is adding, forever.
 */
const RESET = ['accent', 'muted', 'heading', 'success', 'error', 'warn', 'info']
  .map(
    (role) =>
      `.sigil-${role} { color: initial; dim: false; font-weight: normal; ` +
      `text-decoration: none; inverse: false; italic: false }`
  )
  .join('\n');

/** The framework's own roles, restated so that cycling can come back to them. */
const SIGIL = `
  .sigil-accent { color: cyan }
  .sigil-muted { dim: true }
  .sigil-heading { font-weight: bold }
  .sigil-success { color: green }
  .sigil-error { color: red }
  .sigil-warn { color: yellow }
  .sigil-info { color: blue }
  @media (prefers-color-scheme: light) {
    .sigil-muted { color: gray; dim: false }
  }
`;

/** What `t` cycles through. */
export const THEMES = Object.freeze([
  ['sigil', SIGIL],
  ['mono', MONO],
  ['violet', VIOLET],
  ['amber', AMBER],
  ['phosphor', PHOSPHOR],
  ['neon', NEON],
]);

/**
 * The cascade the monitor draws through: the framework's defaults and the layout.
 *
 * @returns {import('@ttylabs/sigil/style').Cascade} A cascade a theme can be added to.
 */
export function monitorCascade() {
  return themedCascade({ sheets: [LAYOUT] });
}

/**
 * @typedef {object} Shell
 * @property {import('@ttylabs/sigil/input').InputRouter} input
 * @property {import('@ttylabs/sigil/components').ModalHost} host - Where a dialog goes.
 * @property {() => void} restyle - Called after a sheet is added to the cascade.
 * @property {() => void} quit
 */

/**
 * @typedef {object} AppProps
 * @property {{ sample(): Promise<import('./sampler.js').Snapshot> }} sampler
 * @property {import('@ttylabs/sigil/style').Cascade} cascade - What `t` adds a theme to.
 * @property {State<Shell | undefined>} shell - The router and the renderer, which
 *   exist only after the tree does: stand-in for SIG-276.
 * @property {{ every(ms: number, fn: () => void): () => void }} [clock] - How the
 *   ticks are scheduled. Defaults to `setInterval`.
 * @property {number} [interval] - Milliseconds between samples. Defaults to 1000.
 * @property {(pid: number) => void} [kill] - Defaults to `process.kill(pid, 'SIGTERM')`.
 */

/** The default clock. */
const realClock = {
  every(ms, fn) {
    const id = setInterval(fn, ms);
    return () => clearInterval(id);
  },
};

/**
 * The whole screen.
 *
 * @param {AppProps} props - Where the data comes from and what it is drawn into.
 * @returns {import('@ttylabs/sigil/element').Element} The root.
 */
export function App(props) {
  const clock = props.clock ?? realClock;
  const kill = props.kill ?? ((pid) => process.kill(pid, 'SIGTERM'));

  // -- state ------------------------------------------------------------------
  const cores = new State(/** @type {number[][]} */ ([]));
  const memory = new State({ history: /** @type {number[]} */ ([]), total: 0, used: 0 });
  const net = new State({ rx: /** @type {number[]} */ ([]), tx: /** @type {number[]} */ ([]) });
  const processes = new State(/** @type {import('./data.js').Process[]} */ ([]));
  const sort = new State(/** @type {keyof typeof import('./data.js').SORTS} */ ('cpu'));
  const filter = new State('');
  const selected = new State(/** @type {number | undefined} */ (undefined));
  const theme = new State(0);
  const status = new State('');

  const rows = new Computed(() =>
    sortProcesses(filterProcesses(processes.get(), filter.get()), sort.get())
  );

  // the selection follows its pid through a re-sort, a refresh and a filter
  let shown = /** @type {readonly import('./data.js').Process[]} */ ([]);
  createEffect(() => {
    const next = rows.get();
    const pid = reselect(
      shown,
      next,
      untrack(() => selected.get())
    );
    shown = next;
    if (pid !== untrack(() => selected.get())) {
      selected.set(pid);
    }
  });

  // -- sampling ---------------------------------------------------------------
  let disposed = false;
  const tick = async () => {
    const snap = await props.sampler.sample();
    if (disposed) {
      return;
    }
    const before = cores.get();
    cores.set(snap.cores.map((load, i) => pushHistory(before[i] ?? [], load * 100, HISTORY)));
    const used = snap.memory.total > 0 ? (snap.memory.used / snap.memory.total) * 100 : 0;
    memory.set({
      history: pushHistory(memory.get().history, used, HISTORY),
      total: snap.memory.total,
      used: snap.memory.used,
    });
    net.set({
      rx: pushHistory(net.get().rx, snap.net.rx, HISTORY),
      tx: pushHistory(net.get().tx, snap.net.tx, HISTORY),
    });
    processes.set(snap.processes);
  };
  void tick();
  const stopClock = clock.every(props.interval ?? 1000, () => void tick());
  onCleanup(() => {
    disposed = true;
    stopClock();
  });

  // -- the cpu panel ----------------------------------------------------------
  // one row per core, keyed by its number rather than by its history: the
  // history is a new array every tick, and `For` keeps a row by identity
  const coreCount = new Computed(() => cores.get().length);
  const coreRow = (index) => {
    const load = () => cores.get()[index]?.at(-1) ?? 0;
    return ui`<box class="row core">
      <text class="label sigil-muted">cpu${String(index)}</text>
      ${LiveChart({
        data: () => cores.get()[index] ?? [],
        draw: (values, size) =>
          sparklineView(values, { max: 100, min: 0, role: 'accent', width: size.width }).element,
      })}
      <text class="figure">${() => `${load().toFixed(0)}%`}</text>
    </box>`;
  };

  const cpu = Panel(
    { class: 'cpu', title: () => `cpu · ${cores.get().length} cores` },
    For({
      children: coreRow,
      each: () => Array.from({ length: coreCount.get() }, (_, i) => i),
      props: { class: 'cores' },
    })
  );

  // -- memory -----------------------------------------------------------------
  const mem = Panel(
    { class: 'mem', title: 'memory' },
    ui`<box class="row">
      ${LiveChart({
        data: () => [memory.get().used, memory.get().total],
        draw: ([used = 0, total = 0], size) =>
          gaugeView(total > 0 ? used / total : 0, {
            detail: `${formatBytes(used)} / ${formatBytes(total)}`,
            min: 0,
            max: 1,
            thresholds: { error: 0.9, warn: 0.75 },
            width: Math.max(4, size.width - 26),
          }).element,
      })}
    </box>`,
    LiveChart({
      class: 'grow',
      data: () => memory.get().history,
      draw: (values, size) =>
        lineChartView(values.length > 1 ? values : [0, 0], {
          format: (v) => `${v.toFixed(0)}%`,
          height: Math.max(1, size.height - 1),
          max: 100,
          min: 0,
          role: 'info',
          width: size.width,
        }).element,
    })
  );

  // -- network ----------------------------------------------------------------
  const netRow = (label, pick, role) =>
    ui`<box class="row">
      <text class="label sigil-muted">${label}</text>
      ${LiveChart({
        data: () => pick(net.get()),
        draw: (values, size) => sparklineView(values, { min: 0, role, width: size.width }).element,
      })}
      <text class="figure">${() => `${formatBytes(pick(net.get()).at(-1) ?? 0)}/s`}</text>
    </box>`;

  const network = Panel(
    { class: 'net', title: 'network' },
    netRow('rx', (n) => n.rx, 'success'),
    netRow('tx', (n) => n.tx, 'warn')
  );

  // -- processes --------------------------------------------------------------
  const table = ProcessTable({
    format: (p, key) => {
      switch (key) {
        case 'cpu':
          return p.cpu.toFixed(1);
        case 'mem':
          return p.mem.toFixed(1);
        case 'rss':
          return formatBytes(p.rss);
        case 'pid':
          return String(p.pid);
        default:
          return String(p[key]);
      }
    },
    rows: () => rows.get(),
    selected,
    sort: () => sort.get(),
  });
  table.element.addClass('grow');

  const field = TextField({
    onSubmit: () => props.shell.get()?.input.focus.focus(table.element),
    placeholder: 'press / to filter',
    value: filter,
  });

  const procs = Panel(
    {
      class: 'procs',
      title: () => `processes · ${rows.get().length} of ${processes.get().length}`,
    },
    ui`<box class="filter">
      <text class="sigil-muted">filter</text>
      ${field}
    </box>`,
    table.element
  );

  // -- the footer -------------------------------------------------------------
  // stand-in for SIG-276: the footer reads the router's bindings, and the router
  // is made after this tree. A source that reads it through the shell signal is
  // what lets the footer redraw the moment it arrives
  // the footer asks for a width before the root exists, and is not told when the
  // layout changes it: it asks again only when the bindings or the focus move
  /** @type {import('@ttylabs/sigil/element').Element | undefined} */
  let root;
  const footer = keyHelp(
    { bindings: () => props.shell.get()?.input.bindings() ?? [] },
    { width: () => Math.max(20, (root?.box?.width ?? 80) - 24) }
  );

  root = ui`<box class="app">
    <box class="top">
      ${cpu}
      <box class="side">${mem}${network}</box>
    </box>
    ${procs}
    <box class="row footer">
      ${footer}
      <text class="sigil-accent">${() => status.get()}</text>
    </box>
  </box>`;

  // -- keys -------------------------------------------------------------------
  const cycleTheme = (shell) => {
    const at = (theme.get() + 1) % THEMES.length;
    theme.set(at);
    const [name, css] = THEMES[at];
    props.cascade.add(parseTheme(`${RESET}\n${css}`));
    shell.restyle();
    status.set(`theme: ${name}`);
  };

  const askKill = async (shell) => {
    const pid = selected.get();
    const p = rows.get().find((it) => it.pid === pid);
    if (!p) {
      return;
    }
    const yes = await confirmModal(shell.host, {
      initial: 'no',
      input: shell.input,
      message: `Send SIGTERM to ${p.name} (pid ${p.pid})?`,
      title: 'Kill process',
    });
    shell.input.focus.focus(table.element);
    if (!yes) {
      return;
    }
    try {
      kill(p.pid);
      status.set(`sent SIGTERM to ${p.pid}`);
    } catch (err) {
      status.set(`could not kill ${p.pid}: ${/** @type {Error} */ (err).message}`);
    }
  };

  // the keys are the root's, reached by bubbling from whatever has the focus,
  // rather than router bindings -- a binding sees every key first, so `q` typed
  // into the filter would quit
  root.onKey = (event) => {
    const shell = props.shell.get();
    if (!shell) {
      return;
    }
    const { key } = event;
    const typing = shell.input.focus.current.get() === field;
    if (typing) {
      // Escape abandons the filter, where Enter keeps it
      if (key.name === 'escape') {
        event.stop();
        filter.set('');
        shell.input.focus.focus(table.element);
      }
      return;
    }
    const handled = () => event.stop();
    switch (key.name) {
      case 'q':
        handled();
        shell.quit();
        return;
      case 'up':
      case 'k':
        handled();
        table.move(-1);
        return;
      case 'down':
      case 'j':
        handled();
        table.move(1);
        return;
      case 'pageup':
        handled();
        table.page(-1);
        return;
      case 'pagedown':
        handled();
        table.page(1);
        return;
      case 'home':
        handled();
        table.home();
        return;
      case 'end':
        handled();
        table.end();
        return;
      case 's': {
        handled();
        const next = SORT_ORDER[(SORT_ORDER.indexOf(sort.get()) + 1) % SORT_ORDER.length];
        sort.set(next);
        status.set(`sorted by ${next}`);
        return;
      }
      case 't':
        handled();
        cycleTheme(shell);
        return;
      case 'x':
        handled();
        void askKill(shell);
        return;
      default:
        if (key.sequence === '/') {
          handled();
          shell.input.focus.focus(field);
        }
    }
  };

  // what the footer lists, once there is a router to list it on
  createEffect(() => {
    const shell = props.shell.get();
    if (!shell) {
      return;
    }
    // untracked: describing a key writes the router's list of bindings, and
    // reading that list back is part of writing it -- tracked, this effect would
    // be its own dependency and never settle
    const undo = untrack(() => [
      shell.input.describe('up', { description: 'select', priority: 3 }),
      shell.input.describe('down', { description: 'select', priority: 3 }),
      shell.input.describe('s', { description: 'sort', priority: 2 }),
      shell.input.describe('/', { description: 'filter', priority: 2 }),
      shell.input.describe('x', { description: 'kill', priority: 2 }),
      shell.input.describe('t', { description: 'theme', priority: 1 }),
      shell.input.describe('q', { description: 'quit', priority: 3 }),
    ]);
    untrack(() => shell.input.focus.focus(table.element));
    onCleanup(() => {
      for (const fn of undo) {
        fn();
      }
    });
  });

  return root;
}
