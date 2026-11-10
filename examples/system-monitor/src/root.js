/**
 * The monitor: per-core load, memory and network over time, and a process table.
 *
 * Written in the `ui` tag, so it runs under plain `node` with nothing compiling
 * it. `App` is the whole screen, mounted by `runApp()`: `src/ui.js` runs it on
 * the real terminal, and the tests run it over a fake one with a fake machine
 * behind `SystemContext`.
 */

import {
  filterProcesses,
  formatBytes,
  pushHistory,
  refuseKill,
  reselect,
  SORT_ORDER,
  sortProcesses,
} from './data.js';
import { LiveChart, ProcessTable } from './stand-ins.js';
import { SystemContext } from './system.js';
import { useApp } from '@ttylabs/sigil/app';
import {
  confirmModal,
  gaugeView,
  keyHelp,
  lineChartView,
  Panel,
  sparklineView,
  TextField,
} from '@ttylabs/sigil/components';
import { createEffect, For, onCleanup, useContext } from '@ttylabs/sigil/renderer';
import { Computed, State, untrack } from '@ttylabs/sigil/signals';
import { ui } from '@ttylabs/sigil/template';
import { AMBER, MONO, NEON, PHOSPHOR, VIOLET } from '@ttylabs/sigil/themes';

/** How many samples each chart keeps: two minutes at one a second. */
const HISTORY = 120;

/** What `t` cycles through. `sigil` is the framework's own roles, with no theme sheet at all. */
const THEMES = Object.freeze([
  ['sigil', undefined],
  ['mono', MONO],
  ['violet', VIOLET],
  ['amber', AMBER],
  ['phosphor', PHOSPHOR],
  ['neon', NEON],
]);

/**
 * The layout, and no colour at all. Every colour comes from a role class
 * (`sigil-accent`, `sigil-muted`, ...), so a theme restyles the whole screen --
 * and the theme is not in here: `t` swaps it with `app.setTheme()`.
 */
export const stylesheet = `
  /* runApp() lets the root shrink to the screen, so the cores wrap */
  .app { flex-direction: column; flex-grow: 1 }
  .top { flex-direction: row; flex-grow: 1; flex-basis: 0; min-height: 0 }
  .side { flex-direction: column; flex-grow: 1; flex-basis: 0; min-width: 0 }
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
  /* the status says what just happened, so it keeps its width and the key-help
     footer beside it takes what is left */
  .status { flex-shrink: 0 }
`;

/**
 * The whole screen.
 *
 * @returns {import('@ttylabs/sigil/element').Element} The root.
 */
export function App() {
  const app = useApp();
  // always there under `runApp()`, which refuses to call a component at all
  // without a terminal to read keys from -- typed as possibly missing for that
  const input = app.input;
  if (!input) {
    throw new Error('The system monitor needs keys: run it with runApp() on a terminal');
  }
  const system = useContext(SystemContext);

  // -- state ------------------------------------------------------------------
  const cores = new State(/** @type {number[][]} */ ([]));
  const memory = new State({ history: /** @type {number[]} */ ([]), total: 0, used: 0 });
  const net = new State({ rx: /** @type {number[]} */ ([]), tx: /** @type {number[]} */ ([]) });
  const processes = new State(/** @type {import('./data.js').Process[]} */ ([]));
  const sort = new State(/** @type {keyof typeof import('./data.js').SORTS} */ ('cpu'));
  const filter = new State('');
  const selected = new State(/** @type {number | undefined} */ (undefined));
  const status = new State('');
  let theme = 0;

  const rows = new Computed(() =>
    sortProcesses(filterProcesses(processes.get(), filter.get()), sort.get())
  );

  // the selection keeps its row through a re-sort, a refresh and a filter, so
  // the highlight stays where the eye left it while the processes move under it.
  // The selection is read untracked: this runs when the rows change, and a move
  // of the selection is not a reason to look again
  let shown = /** @type {readonly import('./data.js').Process[]} */ ([]);
  createEffect(() => {
    const next = rows.get();
    const was = untrack(() => selected.get());
    const pid = reselect(shown, next, was);
    shown = next;
    if (pid !== was) {
      selected.set(pid);
    }
  });

  // -- sampling ---------------------------------------------------------------
  const sampler = system.sampler();
  let disposed = false;
  // the footer line a failed reading put up, so that the next reading to land
  // takes down that line and nothing else the footer has said since
  let failure = '';
  /** Takes a reading and shows it. Resolves to whether it was shown. */
  const read = async () => {
    const snap = await sampler.sample();
    if (disposed) {
      return false;
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
    if (failure && status.get() === failure) {
      status.set('');
    }
    failure = '';
    return true;
  };
  // the reading in flight, if there is one. A reading slower than the interval
  // -- a few thousand processes, a slow `/proc` -- would otherwise overlap the
  // next: two points for one second, and whichever finished last setting the
  // baseline. So a tick that comes while one is out joins it instead, and a kill
  // can wait for it. A reading that fails is reported, the table keeps what it
  // had, and the next tick tries again
  /** @type {Promise<boolean> | undefined} */
  let reading;
  /** Takes a reading, or joins the one in flight. Resolves to whether it was shown. */
  const tick = () => {
    reading ??= read()
      .catch((err) => {
        if (!disposed) {
          failure = `could not read the system: ${/** @type {Error} */ (err).message}`;
          status.set(failure);
        }
        return false;
      })
      .finally(() => {
        reading = undefined;
      });
    return reading;
  };
  void tick();
  const stopClock = system.clock.every(system.interval, () => void tick());
  onCleanup(() => {
    disposed = true;
    stopClock();
    sampler.stop();
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
        lineChartView(values, {
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

  // `flex-grow` gives the field the rest of the row, so its background runs to
  // the panel's edge and a long filter scrolls inside it. Without it the field
  // is as wide as what it holds, which also works (SIG-318)
  const field = TextField({
    onSubmit: () => input.focus.focus(undefined),
    placeholder: 'press / to filter',
    props: { 'flex-grow': 1 },
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

  // -- keys -------------------------------------------------------------------
  const cycleTheme = () => {
    theme = (theme + 1) % THEMES.length;
    const [name, css] = THEMES[theme];
    // the cascade's, so a dialog -- which is appended beside this root, not
    // inside it -- takes the theme too, and the renderer restyles on its own
    app.setTheme(css);
    status.set(`theme: ${name}`);
  };

  // whether a kill is between its dialog and its signal. While it is, `x` does
  // nothing: a second dialog would be answered while the first answer is still
  // waiting to be acted on
  let killing = false;
  const askKill = async () => {
    if (killing) {
      return;
    }
    killing = true;
    try {
      await kill();
    } finally {
      killing = false;
    }
  };
  const kill = async () => {
    const pid = selected.get();
    const p = rows.get().find((it) => it.pid === pid);
    if (!p) {
      return;
    }
    const refused = refuseKill(p.pid, system.pid);
    if (refused) {
      status.set(refused);
      return;
    }
    const yes = await confirmModal(app.view, {
      initial: 'no',
      input,
      message: `Send SIGTERM to ${p.name} (pid ${p.pid})?`,
      title: 'Kill process',
    });
    if (!yes) {
      return;
    }
    // the process may have exited while the dialog was open, and its pid gone to
    // something else. The signal goes to a pid, so first take a reading begun
    // after the answer -- waiting out one already in flight, which began before
    // it -- and send only if that reading landed and still has the same process
    // under the pid. The same process is the same pid and start time: a name or
    // a user can match by chance, and a user column can change from a uid to a
    // name. Quitting at either wait ends it there
    status.set(`checking pid ${p.pid}...`);
    await reading;
    if (disposed) {
      return;
    }
    const landed = await tick();
    if (disposed) {
      return;
    }
    if (!landed) {
      // what matters first, since the footer cuts a long line off
      status.set(`pid ${p.pid} not checked, nothing sent: ${failure}`);
      return;
    }
    const now = processes.get().find((it) => it.pid === p.pid && it.started === p.started);
    if (!now) {
      status.set(`${p.name} (pid ${p.pid}) has exited: nothing sent`);
      return;
    }
    try {
      system.kill(p.pid);
      status.set(`sent SIGTERM to ${p.pid}`);
    } catch (err) {
      status.set(`could not kill ${p.pid}: ${/** @type {Error} */ (err).message}`);
    }
  };

  // the app's keys are fallbacks: they come after the focused element, so `s`
  // typed into the filter is a letter in the filter and not a sort, and they run
  // with nothing focused too, which a key bubbling up from the focused element
  // cannot. `q` is not here: `runApp()` binds it the same way (`quitKey`)
  /** @type {(() => void)[]} */
  const undo = [];
  const key = (/** @type {string} */ spec, /** @type {() => void} */ run, help) =>
    undo.push(input.fallback(spec, run, help));

  key('up', () => table.move(-1), { description: 'select', priority: 3 });
  key('down', () => table.move(1), { description: 'select', priority: 3 });
  // the same two, for hands on the home row, and not listed twice
  key('k', () => table.move(-1));
  key('j', () => table.move(1));
  key('pageup', () => table.page(-1));
  key('pagedown', () => table.page(1));
  key('home', () => table.home());
  key('end', () => table.end());
  key(
    's',
    () => {
      const next = SORT_ORDER[(SORT_ORDER.indexOf(sort.get()) + 1) % SORT_ORDER.length];
      sort.set(next);
      status.set(`sorted by ${next}`);
    },
    { description: 'sort', priority: 2 }
  );
  key('/', () => input.focus.focus(field), { description: 'filter', priority: 2 });
  key('x', () => void askKill(), { description: 'kill', priority: 2 });
  key('t', cycleTheme, { description: 'theme', priority: 1 });

  // the one key that belongs to the field rather than the app: Escape abandons the
  // filter, where Enter keeps it. The field does not take Escape, so it bubbles
  // to the root from there, where it is the `onKey` prop below
  const onKey = (event) => {
    if (event.key.name === 'escape' && input.focus.current.get() === field) {
      event.stop();
      filter.set('');
      input.focus.focus(undefined);
    }
  };

  // -- the footer -------------------------------------------------------------
  // fitted to the room the layout gives it, which is the row less the status
  const footer = keyHelp(input);

  const root = ui`<box class="app" onKey=${onKey}>
    <box class="top">
      ${cpu}
      <box class="side">${mem}${network}</box>
    </box>
    ${procs}
    <box class="row footer">
      ${footer}
      <text class="status sigil-accent">${() => status.get()}</text>
    </box>
  </box>`;

  // and unlisted with the component
  onCleanup(() => {
    for (const fn of undo) {
      fn();
    }
  });

  return root;
}
