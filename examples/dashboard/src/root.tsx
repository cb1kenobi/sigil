/**
 * The dashboard: a sidebar of pages, a header with a search and a menu, four
 * cards, a chart over a range, and a table of projects -- shadcn's dashboard-01
 * as a list of parts, built from sigil's own.
 *
 * Written in JSX, so `sigil build` compiles it and an editor checks every prop.
 * `App` takes no props and reaches the app through `useApp()`; `src/index.ts`
 * runs it on the real terminal and the tests run it over a fake one. The state
 * is `createDashboard()` in `src/model.ts`, and each region of the screen is
 * built over it in a module of its own. `examples/AGENTS.md` has the reasons,
 * under "A dashboard".
 */

import { Cards } from './cards.tsx';
import { RANGES } from './data.ts';
import { buildHeader } from './header.tsx';
import { createDashboard, SECTIONS } from './model.ts';
import { buildProjects } from './projects.tsx';
import { buildSidebar } from './sidebar.tsx';
import { THEMES } from './themes.ts';
import { buildTraffic } from './traffic.tsx';
import { useApp } from '@ttylabs/sigil/app';
import { describeButton } from '@ttylabs/sigil/components/button';
import { describeLineChart } from '@ttylabs/sigil/components/chart';
import { keyHelp } from '@ttylabs/sigil/components/key-help';
import { describeTabs } from '@ttylabs/sigil/components/tabs';
import type { Element } from '@ttylabs/sigil/element';
import { createEffect, onCleanup, onMount } from '@ttylabs/sigil/renderer';
import { untrack } from '@ttylabs/sigil/signals';

/** Below this many columns the sidebar starts collapsed, so the cards keep their room. */
export const NARROW: number = 100;

/**
 * The layout, and no colour at all: every colour comes from a role class or from
 * the theme, so `System`, `Light` and `Dark` restyle the whole screen.
 *
 * The cards and the chart give way on a short or a narrow terminal rather than
 * squeezing the table to nothing: the media queries drop the sparklines, then
 * the notes, then the chart, while the table keeps its rows.
 */
export const stylesheet = `
  .dash { flex-direction: column; flex-grow: 1; min-height: 0 }
  .body { flex-direction: row; flex-grow: 1; min-height: 0 }

  .sidebar { flex-grow: 0; flex-shrink: 0; width: 20 }
  .sidebar.is-collapsed { width: 7 }
  .sidebar.is-collapsed .nav-label { display: none }
  .nav-list { flex-grow: 1 }
  .usage { flex-direction: column; flex-shrink: 0 }
  .usage-label, .usage-figure { white-space: nowrap; overflow: hidden; text-overflow: ellipsis }
  .sidebar.is-collapsed .usage { display: none }
  .nav-row { flex-direction: row }
  .nav-glyph { flex-shrink: 0 }
  .nav-label { margin-left: 1; white-space: nowrap; overflow: hidden }

  .main { flex-direction: column; flex-grow: 1; min-width: 0; min-height: 0; padding: 0 0 0 1 }
  .header { flex-direction: row; column-gap: 1; height: 1; margin-bottom: 1 }
  .title { flex-shrink: 0 }
  .crumb { flex-grow: 1; flex-shrink: 1; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis }
  .search { flex-direction: row; column-gap: 1; flex-shrink: 1; min-width: 12; width: 32 }
  .search-glyph { flex-shrink: 0 }
  .search-field { flex-grow: 1; min-width: 0 }

  .page { flex-direction: column; flex-grow: 1; min-height: 0 }
  .cards { flex-direction: row; column-gap: 1; flex-shrink: 0 }
  .card { flex-basis: 0; flex-grow: 1; min-width: 0; flex-direction: column }
  .figure { white-space: nowrap; overflow: hidden }
  .card-trend { flex-direction: row; column-gap: 1; overflow: hidden }
  .card-note { flex-grow: 1; flex-shrink: 1; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis }

  .traffic { flex-grow: 0; flex-shrink: 0; height: 13 }
  .traffic-head { flex-direction: row; column-gap: 1 }
  .traffic-lede { flex-direction: column; flex-grow: 1; min-width: 0 }
  .traffic-what { white-space: nowrap; overflow: hidden; text-overflow: ellipsis }
  .legend { flex-direction: row; column-gap: 2 }
  .ranges { flex-shrink: 0 }
  .traffic-chart { flex-grow: 1; min-height: 0 }

  .projects { flex-grow: 1; min-height: 6 }
  .projects-table { flex-grow: 1; min-height: 2 }
  .table-bar { flex-direction: row; column-gap: 1; height: 1 }
  .ticked { flex-grow: 1; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis }
  .bar-label { flex-shrink: 0 }

  .elsewhere { flex-direction: column; flex-grow: 1; padding: 1 2 }
  .elsewhere-title { margin-bottom: 1 }

  .footer { flex-shrink: 0; padding: 0 1 }

  @media (max-height: 33) {
    .traffic { height: 11 }
  }
  @media (max-height: 27) {
    .card-chart { display: none }
    .traffic { height: 9 }
  }
  @media (max-height: 21) {
    .traffic { display: none }
  }
  @media (max-height: 17) {
    .card-trend { display: none }
  }
  @media (max-width: 79) {
    .crumb { display: none }
  }
`;

/**
 * A page the example does not draw: the sidebar has it so the navigation is
 * real, and it says so rather than pretending.
 *
 * @param props - Which page.
 * @returns The page.
 */
function Elsewhere({ label }: { label: () => string }): Element {
  return (
    <box class="elsewhere">
      <text class="elsewhere-title sigil-heading">{label}</text>
      <text class="sigil-muted">
        {() =>
          `This example draws the Overview. ${label()} is where an app would put a page of its own, under the same sidebar, header and keys.`
        }
      </text>
    </box>
  );
}

/**
 * The whole screen.
 *
 * @returns The root.
 */
export function App(): Element {
  const app = useApp();
  const input = app.input;
  if (input === undefined) {
    throw new Error('The dashboard needs keys: run it with runApp() on a terminal');
  }

  const d = createDashboard({ collapsed: app.terminal.width < NARROW });

  // -- what the keys and the menu do -----------------------------------------

  const setTheme = (index: number): void => {
    d.theme.set(index % THEMES.length);
  };
  // the theme follows the state, whatever wrote it: `t`, the menu, or a test
  createEffect(() => {
    const css = d.themeNow.get().css;
    untrack(() => app.setTheme(css));
  });
  // and so does the scheme the sheets resolve against, which a theme that paints
  // its own page has to say: the renderer only knows what the terminal is. `app.view`
  // is not there while this body runs, so the effect is made in `onMount()`, which
  // reads it on the first frame and again whenever a key changes the theme
  onMount(() => {
    createEffect(() => {
      const scheme = d.themeNow.get().scheme;
      untrack(() => app.view.setColorScheme(scheme));
    });
  });
  const toggleSidebar = (): void => d.collapsed.set(!d.collapsed.get());

  const sidebar = buildSidebar(d, input);
  const traffic = buildTraffic(d, input);
  const projects = buildProjects(d, input);
  const focusTable = (): void => {
    d.section.set('overview');
    input.focus.focus(projects.list);
  };
  const header = buildHeader(d, input, { focusTable, setTheme, toggleSidebar });

  const fallback = (key: string, fn: () => void, description: string, priority = 0): void => {
    onCleanup(input.fallback(key, fn, { description, priority }));
  };
  fallback(
    '/',
    () => {
      d.section.set('overview');
      input.focus.focus(header.search);
    },
    'search',
    7
  );
  fallback(
    'r',
    () => {
      d.range.set((d.range.get() + 1) % RANGES.length);
    },
    'range',
    5
  );
  fallback('[', () => void d.pager.previous(), 'pages', 4);
  fallback(']', () => void d.pager.next(), 'pages', 4);
  fallback('t', () => setTheme(d.theme.get() + 1), 'theme', 3);
  fallback('ctrl+b', toggleSidebar, 'sidebar', 2);

  // Tab is the router's own default, so it is described rather than bound
  onCleanup(input.describe('tab', { description: 'next', priority: 8 }));
  onCleanup(describeTabs(input, traffic.ranges));
  onCleanup(describeLineChart(input, traffic.chart));
  onCleanup(describeButton(input, header.menu));

  const showing = (overview: boolean) => (): 'flex' | 'none' =>
    ((d.section.get() ?? 'overview') === 'overview') === overview ? 'flex' : 'none';
  const elsewhere = (): string =>
    SECTIONS.find((section) => section.id === d.section.get())?.label ?? '';

  // the sidebar starts with the focus, so the arrows move between pages and Tab
  // goes on to the search, the menu, the range and the table
  onMount(() => input.focus.focus(sidebar.list));

  return (
    <box class="dash">
      <box class="body">
        {sidebar.element}
        <box class="main">
          {header.element}
          <box class="page" display={showing(true)}>
            <Cards d={d} />
            {traffic.element}
            {projects.element}
          </box>
          <box class="page" display={showing(false)}>
            <Elsewhere label={elsewhere} />
          </box>
        </box>
      </box>
      <box class="footer">{keyHelp(input)}</box>
    </box>
  );
}
