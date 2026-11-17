/**
 * The chart: requests a day, API and web, over the last 7, 30 or 90 days.
 *
 * The range is a tab row, `tabRowView()`, which is the shape of a segmented
 * control: Left and Right, `1` to `3` and a click pick one while it has the
 * focus, and `r` anywhere cycles it. The row writes `d.range`, and the cards
 * read the same state, so the whole page moves to the new range together.
 *
 * `step: 'fit'` spreads whatever the range holds across the width the layout
 * gives the chart, so seven days and ninety both fill it.
 */

import { RANGES } from './data.ts';
import { compact, requestsOn } from './metrics.ts';
import { type Dashboard, shortDate } from './model.ts';
import { LineChart } from '@ttylabs/sigil/components/chart';
import { unicodeSupported } from '@ttylabs/sigil/components/note';
import { Panel } from '@ttylabs/sigil/components/panel';
import { tabRowView } from '@ttylabs/sigil/components/tabs';
import type { Element } from '@ttylabs/sigil/element';
import { Computed } from '@ttylabs/sigil/signals';

/** What the chart section hands back: the panel, and the tab row the keys reach. */
export interface TrafficView {
  readonly element: Element;
  readonly ranges: Element;
}

/**
 * Builds the chart section.
 *
 * @param d - The dashboard.
 * @returns The panel and its range selector.
 */
export function buildTraffic(d: Dashboard): TrafficView {
  const shown = new Computed(() => d.days.slice(-d.rangeNow.get().days));
  const api = new Computed(() => shown.get().map((day) => day.api));
  const web = new Computed(() => shown.get().map((day) => day.web));
  const span = new Computed((): readonly [string, string] | undefined => {
    const days = shown.get();
    const first = days[0];
    const last = days.at(-1);
    return first === undefined || last === undefined
      ? undefined
      : [shortDate(first.date), shortDate(last.date)];
  });
  const total = (): string => {
    const sum = shown.get().reduce((n, day) => n + requestsOn(day), 0);
    return `${compact(sum)} requests`;
  };

  const mark = unicodeSupported() ? '■' : '#';
  const ranges = tabRowView({
    active: d.range,
    labels: RANGES.map((range) => range.label),
    props: { class: 'ranges' },
  });

  const element = (
    <Panel class="traffic" title="Traffic" annotation={total}>
      <box class="traffic-head">
        <box class="traffic-lede">
          <text class="traffic-what sigil-muted">
            {() => `Requests a day for the last ${d.rangeNow.get().label}`}
          </text>
          <box class="legend">
            <text class="sigil-accent">{`${mark} API`}</text>
            <text class="sigil-warn">{`${mark} Web`}</text>
          </box>
        </box>
        {ranges}
      </box>
      {LineChart({
        format: compact,
        // the legend is in the head, beside the range, where it costs no row
        legend: false,
        min: 0,
        props: { class: 'traffic-chart' },
        series: [
          { data: api, label: 'API', role: 'accent' },
          { data: web, label: 'Web', role: 'warn' },
        ],
        step: 'fit',
        xLabels: span,
      })}
    </Panel>
  );

  return { element, ranges };
}
