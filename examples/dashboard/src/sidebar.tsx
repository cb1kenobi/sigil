/**
 * The sidebar: the workspace's pages, and who is signed in.
 *
 * A `ListView` of the sections in a panel, so the arrows move between pages and
 * the page follows the cursor, as the settings example's sidebar does. Ctrl-B
 * collapses it to its glyphs -- shadcn's sidebar uses the same chord -- which is
 * a class on the panel that the stylesheet narrows it with and hides the labels
 * under: the list, its cursor and the page it shows are untouched by it.
 */

import { compact, requestsOn } from './metrics.ts';
import { type Dashboard, type Section, type SectionId, SECTIONS } from './model.ts';
import { Gauge } from '@ttylabs/sigil/components/chart';
import { describeListView, ListView } from '@ttylabs/sigil/components/list-view';
import { unicodeSupported } from '@ttylabs/sigil/components/note';
import { Panel } from '@ttylabs/sigil/components/panel';
import type { Element } from '@ttylabs/sigil/element';
import type { InputRouter } from '@ttylabs/sigil/input';
import { createEffect, onCleanup } from '@ttylabs/sigil/renderer';

/** Who the example is signed in as: a made-up person, as everything else here is. */
export const USER = 'mara';

/** The workspace's name, in the sidebar's border. */
export const WORKSPACE = 'Larkspur';

/** The plan's allowance of requests over thirty days, which the gauge under the pages fills. */
export const QUOTA = 3_000_000;

/** What the sidebar hands back: the panel, and the list the keys reach. */
export interface SidebarView {
  readonly element: Element;
  readonly list: Element;
}

/**
 * Builds the sidebar.
 *
 * @param d - The dashboard.
 * @param input - The router, which the list's keys are described to.
 * @returns The panel and its list.
 */
export function buildSidebar(d: Dashboard, input: InputRouter): SidebarView {
  const ascii = !unicodeSupported();

  const list = ListView<Section, SectionId>({
    current: d.section,
    items: SECTIONS,
    key: (section) => section.id,
    props: { class: 'nav-list' },
    row: (section) => (
      <box class="nav-row">
        <text class="nav-glyph">{ascii ? section.ascii : section.glyph}</text>
        <text class="nav-label">{section.label}</text>
      </box>
    ),
    scrollbar: false,
  });

  // what the plan allows against the last thirty days, whatever range the
  // chart shows: a quota is monthly, and the chart's range is a view
  const used = (): number => d.days.slice(-30).reduce((n, day) => n + requestsOn(day), 0);

  // the labels in the border go with the width, and so does the usage: a
  // collapsed sidebar is the glyphs and nothing else
  const element = (
    <Panel
      class="sidebar"
      footer={() => (d.collapsed.get() ? '' : USER)}
      title={() => (d.collapsed.get() ? '' : WORKSPACE)}
    >
      {list}
      <box class="usage">
        <text class="usage-label sigil-muted">Pro plan usage</text>
        <text class="usage-figure">{() => `${compact(used())} of ${compact(QUOTA)}`}</text>
        {Gauge({
          props: { class: 'usage-gauge' },
          style: 'line',
          thresholds: { error: 0.95, warn: 0.8 },
          value: () => used() / QUOTA,
        })}
      </box>
    </Panel>
  );
  createEffect(() => {
    element.toggleClass('is-collapsed', d.collapsed.get());
  });

  onCleanup(describeListView(input, list));
  return { element, list };
}
