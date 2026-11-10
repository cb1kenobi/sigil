/**
 * The browser's state and behaviour, which is everything the two root components
 * share but the markup.
 *
 * Its own module rather than part of either root, for the reason `hello` gives
 * for `common.ts`: the `ui` twin runs unbuilt, so a `.tsx` anywhere in its import
 * graph is a module Node cannot load. `useBrowser()` is called from a root's body,
 * where there is an app and an owner; it builds the signals, starts the clock, and
 * hands back the handlers. The root builds the elements and hands the ones this
 * needs to reach -- a view's box, the list the log is in -- back to `attach()`.
 */

import {
  age,
  createCluster,
  type Deployment,
  type Kind,
  type Pod,
  type Service,
} from './cluster.ts';
import {
  appendLines,
  countMatches,
  fileFeed,
  filterLines,
  type Level,
  LEVELS,
  lineTest,
  type LogLine,
  nextMatch,
} from './logs.ts';
import { useApp } from '@ttylabs/sigil/app';
import {
  type DataTableColumn,
  dataTableControl,
  createPager,
  describeDataTable,
  describeListView,
  listControl,
  rankBy,
  type TableCellView,
} from '@ttylabs/sigil/components';
import { type Element, text } from '@ttylabs/sigil/element';
import type { InputRouter, KeyEvent } from '@ttylabs/sigil/input';
import {
  type Context,
  createBranch,
  createContext,
  createEffect,
  getOwner,
  onCleanup,
  onMount,
  runWithOwner,
  useContext,
} from '@ttylabs/sigil/renderer';
import { Computed, State, untrack } from '@ttylabs/sigil/signals';
import { accessSync, constants } from 'node:fs';
import { resolve } from 'node:path';

/** What the browser reads the world through. `provideContext()` it with a fake in a test. */
export interface Environment {
  /** How many lines of history the simulated log opens with. */
  readonly backlog: number;
  /** Schedules the ticks, and hands back the way to stop them. */
  readonly clock: { every(ms: number, fn: () => void): () => void };
  /** A log file to read and follow instead of the simulated pods' lines. */
  readonly file: string | undefined;
  /** Milliseconds between ticks: how often new lines arrive. */
  readonly interval: number;
  /** The most lines held; the oldest go first past it. */
  readonly maxLines: number;
  /** The simulated cluster's seed. */
  readonly seed: number;
}

/** The real world: a timer, fifty thousand lines of history, and no file. */
export const REAL: Environment = Object.freeze({
  backlog: 50_000,
  clock: {
    every(ms: number, fn: () => void) {
      const id = setInterval(fn, ms);
      return () => clearInterval(id);
    },
  },
  file: undefined,
  interval: 250,
  maxLines: 200_000,
  seed: 42,
});

/**
 * The environment an entry runs the browser in: the real one, reading a log file
 * where one was named. The file is checked here, before the screen is taken, so
 * that a path that cannot be read is an error `main()` reports in one line rather
 * than a failure of the first frame.
 *
 * @param file - The path the command line named, relative to where it was run.
 * @returns The environment.
 * @throws When the file cannot be read.
 */
export function environment(file: string | undefined): Environment {
  if (file === undefined) {
    return REAL;
  }
  const path = resolve(file);
  try {
    accessSync(path, constants.R_OK);
  } catch (error) {
    throw new Error(
      `Cannot read ${file}: ${(error as NodeJS.ErrnoException).code ?? String(error)}`
    );
  }
  return { ...REAL, file: path };
}

/** Outside a provider it is {@link REAL}; `src/ui.ts` and `src/index.ts` provide a file. */
export const EnvironmentContext: Context<Environment> = createContext<Environment>(
  REAL,
  'log-browser'
);

/** What the body shows. */
export type View = Kind | 'describe' | 'logs';

/** What the line under the header is asking for. */
export type Prompt = 'command' | 'filter' | 'grep' | 'search';

/** A command the `:` bar runs, and the other names it answers to. */
export interface Command {
  readonly aliases: readonly string[];
  readonly name: string;
}

/** k9s's resource names and their short forms, and lnav's one way out. */
export const COMMANDS: readonly Command[] = [
  { aliases: ['po', 'pod'], name: 'pods' },
  { aliases: ['svc', 'service'], name: 'services' },
  { aliases: ['deploy', 'dp', 'deployment'], name: 'deployments' },
  { aliases: ['log'], name: 'logs' },
  { aliases: ['q', 'q!'], name: 'quit' },
];

/**
 * The command a `:` line means: the one whose name or alias it is, or else the
 * best fuzzy match, ranked as the command palette ranks -- so `dep` and `dpl`
 * both find `deployments`. `undefined` where nothing matches.
 */
export function resolveCommand(text: string): Command | undefined {
  const typed = text.trim().toLowerCase();
  if (typed === '') {
    return undefined;
  }
  const exact = COMMANDS.find((c) => c.name === typed || c.aliases.includes(typed));
  return exact ?? rankBy(typed, COMMANDS, (c) => c.name)[0]?.item;
}

/** A row of any of the three tables. */
export type Resource = Deployment | Pod | Service;

/** What a table row is keyed by: namespace and name, which outlive every reading. */
export const resourceKey = (row: Resource): string => `${row.namespace}/${row.name}`;

/**
 * A status the eye should stop on, in its role's colour, and `Running` as plain
 * text. A cell that is an element is a `TableCellView`, measured by the width it
 * says it has -- so the column is as wide as the longest status it has shown and
 * no wider, where a declared width would have been the longest one possible.
 */
function statusCell(value: unknown): string | TableCellView {
  const word = String(value);
  const role =
    word === 'CrashLoopBackOff'
      ? 'sigil-error'
      : word === 'Pending' || word === 'ContainerCreating'
        ? 'sigil-warn'
        : undefined;
  return role === undefined
    ? word
    : { element: text(word, { class: role, 'white-space': 'nowrap' }), width: word.length };
}

/** Where a level is drawn from: a role, so a theme recolours it. */
export const LEVEL_ROLE: Record<Level, string> = {
  debug: 'sigil-muted',
  error: 'sigil-error',
  info: '',
  warn: 'sigil-warn',
};

/** What `useBrowser()` hands a root component. */
export interface Browser {
  /** Hands over the elements the handlers reach, and wires the keys to them. */
  attach(parts: Parts): void;
  /** The cluster's clock, `HH:MM:SS`. */
  readonly clock: () => string;
  /** What is being browsed: the simulated cluster, or the file the log is read from. */
  readonly context: string;
  /** The columns of each table. */
  readonly columns: { readonly [K in Kind]: readonly DataTableColumn<Resource>[] };
  /** What the prompt line types into. */
  readonly draft: State<string>;
  /** The log view's state. */
  readonly logs: {
    readonly current: State<number | undefined>;
    readonly following: State<boolean>;
    readonly query: State<string>;
    readonly shown: State<readonly LogLine[]>;
  };
  /** The router, for the key-help footer. */
  readonly input: InputRouter;
  /** A line under the prompt's field: the command `:` would run. */
  readonly hint: () => string;
  /** What Enter on a table row does: describe it. */
  readonly open: (kind: Kind) => (key: string, row: Resource) => void;
  /** What the prompt is asking for, or nothing while it is closed. */
  readonly prompt: State<Prompt | undefined>;
  /** The prompt's own character: `:`, `/` or `&`. */
  readonly promptLabel: () => string;
  /** Each table's rows, as the filter leaves them. */
  readonly rows: { readonly [K in Kind]: Computed<readonly Resource[]> };
  /** The footer's message: what just happened. */
  readonly status: State<string>;
  /** The edits and the Enter of the prompt's field. */
  readonly field: { change(value: string): void; submit(value: string): void };
  /** Each panel's labels. */
  readonly labels: {
    readonly annotation: (view: View) => string;
    readonly footer: (view: View) => string;
    readonly title: (view: View) => string;
  };
  /** Which view is up. */
  readonly view: State<View>;
}

/** The elements a root builds and the handlers reach. */
export interface Parts {
  /** The box the describe pager goes into. */
  readonly describe: Element;
  /** The line the prompt's field sits on. */
  readonly prompt: Element;
  /** The prompt's text field. */
  readonly field: Element;
  /** The log's `ListView`. */
  readonly log: Element;
  /** The three `DataTable`s. */
  readonly tables: { readonly [K in Kind]: Element };
  /** Each view's box, shown while it is up. */
  readonly views: { readonly [V in View]: Element };
}

/** The views `Escape` walks back through, at most. */
const HISTORY = 20;

/**
 * Builds the browser's state for a root component, and starts its clock.
 *
 * @returns The state and the handlers.
 */
export function useBrowser(): Browser {
  const app = useApp();
  // always there under `runApp()`, which refuses to call a component at all
  // without a terminal to read keys from
  const input = app.input;
  if (!input) {
    throw new Error('The log browser needs keys: run it with runApp() on a terminal');
  }
  const env = useContext(EnvironmentContext);
  const owner = getOwner();

  // -- the world --------------------------------------------------------------
  // one counter for every line, whichever feed it came from, so an id is a key
  let id = 0;
  const nextId = (): number => id++;
  const cluster = createCluster({ nextId, seed: env.seed });
  const feed = env.file === undefined ? undefined : fileFeed(env.file, nextId);

  const now = new State(cluster.now());
  const pods = new State(cluster.pods());
  const services = new State(cluster.services());
  const deployments = new State(cluster.deployments());

  // -- the tables -------------------------------------------------------------
  const filter = new State('');
  const ranked = <T extends Resource>(rows: State<readonly T[]>) =>
    new Computed<readonly Resource[]>(() => {
      const query = filter.get();
      const all = rows.get();
      return query === '' ? all : rankBy(query, all, resourceKey).map((r) => r.item);
    });
  const rows = {
    deployments: ranked(deployments),
    pods: ranked(pods),
    services: ranked(services),
  };

  const ago = (since: unknown): string => age(untrack(() => now.get()) - Number(since));
  const columns: Browser['columns'] = {
    deployments: [
      { header: 'NAMESPACE', key: 'namespace', priority: 1 },
      { grow: 1, header: 'NAME', key: 'name', minWidth: 8, priority: 3 },
      {
        align: 'right',
        header: 'READY',
        priority: 2,
        value: (row) => `${(row as Deployment).ready}/${(row as Deployment).desired}`,
      },
      { align: 'right', header: 'AVAILABLE', key: 'available', priority: -1 },
      { align: 'right', format: ago, header: 'AGE', key: 'created' },
    ],
    pods: [
      { header: 'NAMESPACE', key: 'namespace', priority: 1 },
      { grow: 1, header: 'NAME', key: 'name', minWidth: 12, priority: 3 },
      { format: statusCell, header: 'STATUS', key: 'status', priority: 2 },
      {
        align: 'right',
        descendingFirst: true,
        header: 'RESTARTS',
        key: 'restarts',
        priority: 1,
      },
      {
        align: 'right',
        descendingFirst: true,
        format: (cpu) => `${String(cpu)}m`,
        header: 'CPU',
        key: 'cpu',
        priority: 2,
        width: 5,
      },
      {
        align: 'right',
        descendingFirst: true,
        format: (mem) => `${String(mem)}Mi`,
        header: 'MEM',
        key: 'memory',
        priority: 0,
        width: 6,
      },
      { header: 'NODE', key: 'node', priority: -1 },
      { align: 'right', format: ago, header: 'AGE', key: 'started', priority: 0 },
    ],
    services: [
      { header: 'NAMESPACE', key: 'namespace', priority: 1 },
      { grow: 1, header: 'NAME', key: 'name', minWidth: 8, priority: 3 },
      { header: 'TYPE', key: 'type', priority: 0 },
      { header: 'CLUSTER-IP', key: 'clusterIp', priority: 2 },
      { header: 'PORTS', key: 'ports', priority: -1 },
      { align: 'right', format: ago, header: 'AGE', key: 'created' },
    ],
  };

  // -- the log ----------------------------------------------------------------
  const lines = new State<readonly LogLine[]>(
    feed === undefined ? cluster.backlog(env.backlog) : feed.read()
  );
  const level = new State<Level>('debug');
  const source = new State<string | undefined>(undefined);
  const grep = new State('');
  const query = new State('');
  const shown = new State<readonly LogLine[]>([]);
  const current = new State<number | undefined>(undefined);
  const following = new State(true);
  /** The test the shown lines passed, kept so a new batch is tested without the old ones. */
  let keep = lineTest({ filter: '', level: 'debug', source: undefined });

  const tail = (): number | undefined => untrack(() => shown.get()).at(-1)?.id;

  // a filter that changed tests every line again; the cursor goes to the newest
  // line if it was following, and stays on its line otherwise
  createEffect(() => {
    const by = { filter: grep.get(), level: level.get(), source: source.get() };
    untrack(() => {
      keep = lineTest(by);
      shown.set(filterLines(lines.get(), by));
      if (following.get()) {
        current.set(tail());
      }
    });
  });

  // following is being on the newest line: a move off it stops, End and `F`
  // start again. Decided when the cursor moves, which a new line does not do
  createEffect(() => {
    const at = current.get();
    untrack(() => {
      const last = tail();
      following.set(last === undefined || at === last);
    });
  });

  // -- views ------------------------------------------------------------------
  const view = new State<View>(feed === undefined ? 'pods' : 'logs');
  const history: View[] = [];
  const status = new State('');
  const prompt = new State<Prompt | undefined>(undefined);
  const draft = new State('');
  const described = new State<{ kind: Kind; name: string } | undefined>(undefined);

  let parts: Parts | undefined;
  /** The element each view hands the focus to. */
  const target = (v: View): Element | undefined => {
    if (parts === undefined) {
      return undefined;
    }
    if (v === 'logs') {
      return parts.log;
    }
    if (v === 'describe') {
      return pager?.element;
    }
    return dataTableControl(parts.tables[v])?.list;
  };

  /** Whether the app has drawn its first frame, before which there is no frame to force. */
  let mounted = false;
  onMount(() => {
    mounted = true;
  });

  /**
   * Draws a frame now, after something was shown and given the focus.
   *
   * The router asks whether the focused element is displayed before it routes a
   * key, and reads that off the style the last frame resolved as well as off an
   * inline `display`: so a box hidden a moment ago is still hidden to it, inline
   * `flex` or not, until a frame has restyled it -- and the focus put on something
   * inside it is taken back at the next key. `:pods` typed fast, or pasted, is
   * `:` and then four keys in one read, and the four went to the table. A frame
   * here is what makes the box shown before that read is routed.
   */
  const redraw = (): void => {
    if (mounted) {
      app.view.frame();
    }
  };

  /** Shows one view and hides the rest, and gives it the focus. */
  const show = (v: View): void => {
    if (parts === undefined) {
      return;
    }
    // the `display` prop rather than a class, because the router reads a prop
    // that hides the moment it is written, and a class only once a frame has run
    for (const [name, el] of Object.entries(parts.views)) {
      el.setProps({ display: name === v ? 'flex' : 'none' });
    }
    const to = target(v);
    if (to !== undefined && untrack(() => prompt.get()) === undefined) {
      input.focus.focus(to);
    }
    redraw();
  };

  const go = (v: View, remember = true): void => {
    const from = untrack(() => view.get());
    if (remember && from !== v) {
      history.push(from);
      if (history.length > HISTORY) {
        history.shift();
      }
    }
    if (from !== v && from !== 'describe' && v !== 'describe') {
      // a filter is about the table it was typed over, and is still there when a
      // describe is closed on the way back to it
      filter.set('');
    }
    if (from === 'describe' && v !== 'describe') {
      closePager();
    }
    view.set(v);
    show(v);
  };

  const back = (): boolean => {
    const v = history.pop();
    if (v === undefined) {
      return false;
    }
    go(v, false);
    return true;
  };

  // -- the describe pager -----------------------------------------------------
  /** The pager on screen, and the branch its effects belong to. */
  let pager: ReturnType<typeof createPager> | undefined;
  let branch: { dispose(): void } | undefined;

  const closePager = (): void => {
    branch?.dispose();
    pager?.element.remove();
    pager = undefined;
    branch = undefined;
    described.set(undefined);
  };

  const open =
    (kind: Kind) =>
    (_key: string, row: Resource): void => {
      if (parts === undefined) {
        return;
      }
      closePager();
      // a pager reads its document once, so a resource is a new pager, built under
      // a branch of the app's owner so that leaving it disposes what it made
      const made = runWithOwner(owner, () => createBranch());
      branch = made;
      pager = runWithOwner(made.owner, () =>
        createPager({
          content: cluster.describe(kind, row.name),
          props: { 'flex-grow': 1, 'min-height': 0 },
        })
      );
      parts.describe.append(pager.element);
      described.set({ kind, name: row.name });
      go('describe');
    };

  // -- the prompt -------------------------------------------------------------
  const openPrompt = (kind: Prompt, initial = ''): void => {
    if (parts === undefined) {
      return;
    }
    draft.set(initial);
    prompt.set(kind);
    parts.prompt.setProps({ display: 'flex' });
    input.focus.focus(parts.field);
    redraw();
  };

  const closePrompt = (): void => {
    prompt.set(undefined);
    parts?.prompt.setProps({ display: 'none' });
    show(untrack(() => view.get()));
  };

  const logControl = () => (parts === undefined ? undefined : listControl<number>(parts.log));

  /** Moves the log's cursor to the next line a search matches, and says where it went. */
  const seek = (direction: 1 | -1): void => {
    const q = untrack(() => query.get());
    const all = untrack(() => shown.get());
    const at = logControl()?.selection.index() ?? -1;
    const found = nextMatch(all, q, at, direction);
    if (found < 0) {
      status.set(q === '' ? 'no search: press / to search' : `/${q}: no lines match`);
      return;
    }
    current.set((all[found] as LogLine).id);
    status.set(`/${q}: line ${found + 1} of ${all.length}, ${countMatches(all, q)} lines match`);
  };

  const run = (text: string): void => {
    const command = resolveCommand(text);
    if (command === undefined) {
      status.set(text.trim() === '' ? '' : `no command "${text.trim()}"`);
      return;
    }
    if (command.name === 'quit') {
      app.exit(0);
      return;
    }
    if (command.name === 'logs') {
      source.set(undefined);
    }
    go(command.name as View);
    status.set('');
  };

  const field: Browser['field'] = {
    change(value) {
      // a resource filter narrows the table as it is typed, as k9s's does
      if (untrack(() => prompt.get()) === 'filter') {
        filter.set(value);
      }
    },
    submit(value) {
      const kind = untrack(() => prompt.get());
      closePrompt();
      switch (kind) {
        case 'command': {
          run(value);
          break;
        }
        case 'search': {
          // an empty search repeats the last one, the pager's rule and `less`'s
          if (value !== '') {
            query.set(value);
          }
          seek(1);
          break;
        }
        case 'grep': {
          grep.set(value);
          status.set(value === '' ? 'showing every line' : `showing lines with "${value}"`);
          break;
        }
        default: {
          break;
        }
      }
    },
  };

  // -- the clock --------------------------------------------------------------
  const tick = (): void => {
    const batch = cluster.advance(env.interval);
    now.set(cluster.now());
    if (cluster.pods() !== untrack(() => pods.get())) {
      pods.set(cluster.pods());
      deployments.set(cluster.deployments());
    }
    append(feed === undefined ? batch : feed.read());
  };

  /** Adds lines to the log and, while following, moves to the newest of them. */
  const append = (batch: readonly LogLine[]): void => {
    if (batch.length === 0) {
      return;
    }
    const all = appendLines(
      untrack(() => lines.get()),
      batch,
      env.maxLines
    );
    lines.set(all);
    let next = untrack(() => shown.get());
    // the oldest dropped from the log go from the view too: ids rise, so the first
    // still held says where the view starts
    const first = all[0]?.id ?? 0;
    if (next.length > 0 && (next[0] as LogLine).id < first) {
      next = next.filter((line) => line.id >= first);
    }
    const kept = keep === undefined ? [] : batch.filter(keep);
    if (kept.length > 0 || next !== untrack(() => shown.get())) {
      const still = untrack(() => following.get()) && cursorInView();
      shown.set(next.concat(kept));
      if (still) {
        current.set(kept.at(-1)?.id ?? untrack(() => current.get()));
      } else {
        following.set(false);
      }
    }
  };

  /**
   * Whether the cursor's line is on screen, which while following is the newest.
   * A wheel scrolls the view and not the cursor, so a reader who wheeled up while
   * following is reading history: the next line stops following rather than
   * pulling them back down.
   */
  const cursorInView = (): boolean => {
    const control = logControl();
    if (control === undefined) {
      return true;
    }
    const viewport = control.scroll.viewport;
    const height = (viewport.content ?? viewport.box)?.height ?? 0;
    const top = viewport.scroll?.y ?? 0;
    const at = control.selection.index();
    return height === 0 || at < 0 || (at >= top && at < top + height);
  };

  // a row is built once, as it scrolls into view, and draws the search it was
  // built under: a new search builds the rows on screen again, and the rest as
  // they arrive
  createEffect(() => {
    query.get();
    untrack(() => logControl()?.refresh());
  });

  const stopClock = env.clock.every(env.interval, tick);
  onCleanup(stopClock);

  // -- keys -------------------------------------------------------------------
  const tableKeys =
    (kind: Kind) =>
    (event: KeyEvent): void => {
      const k = event.key;
      if (k.ctrl || k.meta || event.paste) {
        return;
      }
      if (k.name === '/') {
        event.stop();
        openPrompt(
          'filter',
          untrack(() => filter.get())
        );
      } else if (k.name === 'l' && kind === 'pods' && parts !== undefined) {
        const key = dataTableControl<string>(parts.tables.pods)?.selection.current.get();
        const pod = untrack(() => pods.get()).find((p) => resourceKey(p) === key);
        if (pod !== undefined) {
          event.stop();
          source.set(pod.name);
          go('logs');
        }
      } else if (k.name === 'escape') {
        if (untrack(() => filter.get()) !== '') {
          event.stop();
          filter.set('');
        } else if (back()) {
          event.stop();
        }
      }
    };

  const logKeys = (event: KeyEvent): void => {
    const k = event.key;
    if (k.ctrl || k.meta || event.paste) {
      return;
    }
    switch (k.name) {
      case '/': {
        event.stop();
        openPrompt('search');
        return;
      }
      case '&': {
        event.stop();
        openPrompt(
          'grep',
          untrack(() => grep.get())
        );
        return;
      }
      case 'n':
      case 'N': {
        event.stop();
        seek(k.name === 'n' ? 1 : -1);
        return;
      }
      case 'F': {
        event.stop();
        if (untrack(() => following.get())) {
          following.set(false);
        } else {
          // the cursor may be on the newest line already, which writes nothing and
          // so decides nothing
          following.set(true);
          current.set(tail());
        }
        return;
      }
      case 'L': {
        event.stop();
        const next = LEVELS[(LEVELS.indexOf(untrack(() => level.get())) + 1) % LEVELS.length];
        level.set(next as Level);
        status.set(next === 'debug' ? 'showing every level' : `showing ${next} and worse`);
        return;
      }
      case 'escape': {
        if (untrack(() => query.get()) !== '') {
          event.stop();
          query.set('');
          status.set('');
        } else if (back()) {
          event.stop();
        }
        return;
      }
      default: {
        return;
      }
    }
  };

  const describeKeys = (event: KeyEvent): void => {
    // the pager takes Escape while it has a search to clear, and lets it through
    // when it has none
    if (event.key.name === 'escape' && back()) {
      event.stop();
    }
  };

  const promptKeys = (event: KeyEvent): void => {
    const k = event.key;
    if (k.name === 'escape') {
      event.stop();
      if (untrack(() => prompt.get()) === 'filter') {
        filter.set('');
      }
      closePrompt();
    } else if (k.name === 'tab' && untrack(() => prompt.get()) === 'command') {
      // completes to what the hint says, rather than moving the focus out of the bar
      event.stop();
      const best = resolveCommand(untrack(() => draft.get()));
      if (best !== undefined) {
        draft.set(best.name);
      }
    }
  };

  const attach = (given: Parts): void => {
    parts = given;
    const { log, tables, views } = given;

    for (const kind of ['pods', 'services', 'deployments'] as const) {
      views[kind].onKey = tableKeys(kind);
    }
    views.logs.onKey = logKeys;
    views.describe.onKey = describeKeys;
    given.prompt.onKey = promptKeys;
    given.prompt.setProps({ display: 'none' });

    // the footer lists what applies to the focus, so each view's keys are scoped
    // to its box and leave with it
    const off: (() => void)[] = [
      describeDataTable(input, tables.pods, tables.services, tables.deployments),
      describeListView(input, log),
    ];
    const say = (keys: string, description: string, scope: Element, priority = 2): void => {
      off.push(input.describe(keys, { description, priority, scope }));
    };
    // Enter is the table's own, which `describeDataTable()` lists as `open`
    for (const kind of ['pods', 'services', 'deployments'] as const) {
      say('/', 'filter', views[kind]);
    }
    say('l', 'logs', views.pods, 3);
    say('/', 'search', views.logs, 3);
    say('n', 'next', views.logs, 1);
    say('&', 'filter', views.logs);
    say('F', 'follow', views.logs);
    say('L', 'level', views.logs);
    say('escape', 'back', views.describe, 3);
    for (const v of ['services', 'deployments', 'logs'] as const) {
      say('escape', 'back', views[v], 0);
    }
    off.push(
      input.fallback(':', () => openPrompt('command'), { description: 'command', priority: 3 })
    );
    onCleanup(() => {
      for (const fn of off) {
        fn();
      }
      closePager();
    });

    show(untrack(() => view.get()));
    if (untrack(() => following.get())) {
      current.set(tail());
    }
  };

  const plural = (n: number, one: string): string =>
    `${n.toLocaleString('en-US')} ${one}${n === 1 ? '' : 's'}`;

  return {
    attach,
    clock: () => new Date(now.get()).toISOString().slice(11, 19),
    columns,
    context: feed === undefined ? 'cluster: simulated' : `file: ${feed.path}`,
    draft,
    field,
    hint: () => {
      if (prompt.get() !== 'command') {
        return '';
      }
      const best = resolveCommand(draft.get());
      return best === undefined ? '' : `→ ${best.name}`;
    },
    input,
    labels: {
      annotation(v) {
        if (v === 'logs') {
          return following.get() ? 'following' : 'paused';
        }
        if (v !== 'describe') {
          const q = filter.get();
          return q === '' ? '' : `/${q}`;
        }
        return '';
      },
      footer(v) {
        if (v !== 'logs') {
          return '';
        }
        const said = [
          query.get() === '' ? '' : `/${query.get()}`,
          grep.get() === '' ? '' : `&${grep.get()}`,
          level.get() === 'debug' ? '' : `${level.get()}+`,
        ].filter(Boolean);
        return said.join(' · ');
      },
      title(v) {
        if (v === 'logs') {
          const all = lines.get().length;
          const on = shown.get().length;
          const who = source.get() ?? feed?.name ?? 'all pods';
          return on === all
            ? `logs · ${who} · ${plural(all, 'line')}`
            : `logs · ${who} · ${on.toLocaleString('en-US')} of ${plural(all, 'line')}`;
        }
        if (v === 'describe') {
          const d = described.get();
          return d === undefined ? 'describe' : `describe · ${d.kind} · ${d.name}`;
        }
        const on = rows[v].get().length;
        const of = { deployments, pods, services }[v].get().length;
        return on === of ? `${v} · ${of}` : `${v} · ${on} of ${of}`;
      },
    },
    logs: { current, following, query, shown },
    open,
    prompt,
    promptLabel: () => {
      switch (prompt.get()) {
        case 'command': {
          return ':';
        }
        case 'grep': {
          return '&';
        }
        default: {
          return '/';
        }
      }
    },
    rows,
    status,
    view,
  };
}
