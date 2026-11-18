/**
 * The dashboard's state: every signal the screen reads, and every change a key
 * or a menu makes, with no elements in it.
 *
 * The components in the `.tsx` files build the screen over this, and the tests
 * drive it directly as well as through the screen. Two things here are the
 * example's answer to something the framework leaves to the app, and both are
 * recorded in `examples/AGENTS.md`:
 *
 * - **The table is sorted, filtered and paged here, before it reaches
 *   `DataTable`.** The table sorts the rows it is handed, and a page is the rows
 *   it is handed -- so sorting inside it would order one page of ten and leave
 *   the rest where they were. The whole list is sorted with the table's own
 *   comparator (`cellOrder()`) over the sort the table writes, then cut to a
 *   page; the table sorting that page again is a no-op that agrees with it.
 * - **The selection outlives the page.** It is a set of project ids that
 *   `ListView` never prunes, so ticking rows on two pages and opening the menu
 *   on a third acts on all of them.
 */

import {
  type Day,
  END,
  type Project,
  projects as makeProjects,
  RANGES,
  type Range,
  traffic,
} from './data.ts';
import { type Kpi, kpis } from './metrics.ts';
import { THEMES, type ThemeChoice } from './themes.ts';
import type { DataTableSort } from '@ttylabs/sigil/components/data-table';
import { createPaginator, type Paginator } from '@ttylabs/sigil/components/paginator';
import { cellOrder } from '@ttylabs/sigil/components/table';
import { createEffect } from '@ttylabs/sigil/renderer';
import { Computed, State, untrack } from '@ttylabs/sigil/signals';

/** A page the sidebar can show. Only `overview` has a dashboard on it. */
export type SectionId = 'analytics' | 'deployments' | 'overview' | 'projects' | 'settings' | 'team';

/** One entry in the sidebar. */
export interface Section {
  /** One character, drawn whether or not the sidebar is collapsed. */
  readonly ascii: string;
  readonly glyph: string;
  readonly id: SectionId;
  readonly label: string;
}

/** The sidebar, top to bottom. */
export const SECTIONS: readonly Section[] = [
  { ascii: 'O', glyph: '◆', id: 'overview', label: 'Overview' },
  { ascii: 'A', glyph: '◔', id: 'analytics', label: 'Analytics' },
  { ascii: 'P', glyph: '▤', id: 'projects', label: 'Projects' },
  { ascii: 'D', glyph: '▲', id: 'deployments', label: 'Deployments' },
  { ascii: 'T', glyph: '●', id: 'team', label: 'Team' },
  { ascii: 'S', glyph: '✱', id: 'settings', label: 'Settings' },
];

/** What a page of the table can hold, as the rows-per-page dropdown offers it. */
export const PAGE_SIZES: readonly number[] = [5, 10, 20];

/** Where a status sorts: the ones that need looking at first, as the table runs it from the top. */
const STATUS_RANK: Readonly<Record<Project['status'], number>> = {
  degraded: 2,
  healthy: 0,
  paused: 1,
};

/**
 * What each sortable column holds for a project, by the column's key: the value
 * the table sorts by, which the table's columns read too, so the order a page is
 * cut from and the order the table draws it in are one order.
 */
export const SORT_VALUES: Readonly<Record<string, (p: Project) => unknown>> = {
  errorRate: (p) => p.errorRate,
  name: (p) => p.name,
  owner: (p) => p.owner,
  region: (p) => p.region,
  requests: (p) => p.requests,
  status: (p) => STATUS_RANK[p.status],
};

/**
 * Whether a project matches what was typed into the search: every word, in any
 * of its name, owner, region or status, ignoring case.
 *
 * @param project - The project.
 * @param query - What was typed.
 * @returns Whether it is shown.
 */
export function matches(project: Project, query: string): boolean {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const haystack =
    `${project.name} ${project.owner} ${project.region} ${project.status}`.toLowerCase();
  return words.every((word) => haystack.includes(word));
}

/**
 * Orders projects as the table would order them for a sort, so a page cut from
 * the result is a page of the whole list rather than a list of the page.
 *
 * @param list - The projects.
 * @param sort - The column and the direction, or none for the order they came in.
 * @returns A sorted copy.
 */
export function sortProjects(list: readonly Project[], sort: DataTableSort | undefined): Project[] {
  const read = sort === undefined ? undefined : SORT_VALUES[sort.column];
  if (sort === undefined || read === undefined) {
    return [...list];
  }
  const order = cellOrder(undefined, sort.descending === true);
  return [...list].sort((a, b) => order(read(a), read(b)));
}

/** The dashboard's state and what changes it. */
export interface Dashboard {
  /** Every day of traffic, oldest first. */
  readonly days: readonly Day[];
  /** The four cards, for the range and the projects as they are. */
  readonly kpis: Computed<readonly Kpi[]>;
  /** The page of the table, for the paginator. */
  readonly pager: Paginator;
  /** The rows on the current page, sorted. */
  readonly page: Computed<readonly Project[]>;
  /** Every project, as the row menu has left them. */
  readonly projects: State<readonly Project[]>;
  /** What the search field holds. */
  readonly query: State<string>;
  /** Which of {@link RANGES} the chart and the cards show, by position. */
  readonly range: State<number>;
  /** The range itself. */
  readonly rangeNow: Computed<Range>;
  /** Which page the sidebar shows. */
  readonly section: State<SectionId | undefined>;
  /** The ticked rows, by id: kept across pages, searches and sorts. */
  readonly selected: State<ReadonlySet<string>>;
  /** Whether the sidebar is down to its glyphs. */
  readonly collapsed: State<boolean>;
  /** The table's cursor, by id. */
  readonly current: State<string | undefined>;
  /** What the table is sorted by, which a heading or a digit writes. */
  readonly sort: State<DataTableSort | undefined>;
  /** Which of {@link THEMES} is on, by position. */
  readonly theme: State<number>;
  /** The theme itself. */
  readonly themeNow: Computed<ThemeChoice>;
  /** The projects the search leaves, sorted: every page of them. */
  readonly visible: Computed<readonly Project[]>;

  /** Takes projects out, and out of the selection. */
  remove(ids: Iterable<string>): void;
  /** Writes a change into the projects with these ids. */
  update(ids: Iterable<string>, change: (p: Project) => Partial<Project>): void;
}

export interface DashboardOptions {
  /** Whether the sidebar starts collapsed. Defaults to `false`. */
  collapsed?: boolean;
  /** The seed for the made-up data. */
  seed?: number;
}

/**
 * Builds the state, under whatever owner is current: its one effect keeps the
 * paginator's total on the search's result, and goes with that owner.
 *
 * @param opts - Where the sidebar starts, and the seed.
 * @returns The dashboard.
 */
export function createDashboard(opts: DashboardOptions = {}): Dashboard {
  const days = traffic(opts.seed);
  const projects = new State<readonly Project[]>(makeProjects(opts.seed));
  const range = new State(1);
  const rangeNow = new Computed(
    () => RANGES[Math.min(Math.max(0, range.get()), RANGES.length - 1)] as Range
  );
  const theme = new State(0);
  const themeNow = new Computed(() => THEMES[theme.get() % THEMES.length] as ThemeChoice);
  const query = new State('');
  const sort = new State<DataTableSort | undefined>({ column: 'requests', descending: true });
  const selected = new State<ReadonlySet<string>>(new Set());

  const visible = new Computed(() => {
    const q = query.get();
    return sortProjects(
      projects.get().filter((p) => matches(p, q)),
      sort.get()
    );
  });

  const pager = createPaginator({ perPage: 10, total: untrack(() => visible.get().length) });
  createEffect(() => {
    pager.total = visible.get().length;
  });
  // a new search starts at the top of what it found
  let last = untrack(() => query.get());
  createEffect(() => {
    const q = query.get();
    if (q !== last) {
      last = q;
      untrack(() => pager.first());
    }
  });

  const page = new Computed(() => {
    const all = visible.get();
    // read through the state so a page turn, a new size and a new total all redraw
    pager.state.page.get();
    pager.state.perPage.get();
    return pager.slice(all);
  });

  const kpiList = new Computed(() => kpis(days, rangeNow.get().days, projects.get()));

  return {
    collapsed: new State(opts.collapsed ?? false),
    current: new State<string | undefined>(undefined),
    days,
    kpis: kpiList,
    page,
    pager,
    projects,
    query,
    range,
    rangeNow,
    remove(ids) {
      const gone = new Set(ids);
      projects.set(projects.get().filter((p) => !gone.has(p.id)));
      selected.set(new Set([...selected.get()].filter((id) => !gone.has(id))));
    },
    section: new State<SectionId | undefined>('overview'),
    selected,
    sort,
    theme,
    themeNow,
    update(ids, change) {
      const hit = new Set(ids);
      projects.set(projects.get().map((p) => (hit.has(p.id) ? { ...p, ...change(p) } : p)));
    },
    visible,
  };
}

/** The date a chart label shows: `Nov 16`. In UTC, as the data is. */
export function shortDate(ms: number): string {
  return new Date(ms).toLocaleDateString('en-US', {
    day: 'numeric',
    month: 'short',
    timeZone: 'UTC',
  });
}

/** The last day of the data, as the header says it. */
export const TODAY: string = shortDate(END);
