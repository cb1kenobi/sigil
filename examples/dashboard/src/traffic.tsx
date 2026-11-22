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
 *
 * Both series are shaded under their lines, as shadcn's area chart is, and the
 * pointer over the plot draws a rule at the day under it with a tooltip saying
 * that day's figures -- the crosshair, which needs `mouse: { motion: true }`, so
 * `src/index.ts` asks for it. The chart takes the focus too, and Left and Right
 * step the rule between days, so a keyboard reads a day's figures as a pointer
 * does.
 */

import { RANGES } from './data.ts';
import { compact, requestsOn } from './metrics.ts';
import { type Dashboard, shortDate } from './model.ts';
import { LineChart } from '@ttylabs/sigil/components/chart';
import { unicodeSupported } from '@ttylabs/sigil/components/note';
import { Panel } from '@ttylabs/sigil/components/panel';
import { tabRowView } from '@ttylabs/sigil/components/tabs';
import type { Element } from '@ttylabs/sigil/element';
import type { InputRouter } from '@ttylabs/sigil/input';
import { Computed } from '@ttylabs/sigil/signals';

/** What the chart section hands back: the panel, the chart, and the tab row the keys reach. */
export interface TrafficView {
  /** The line chart, which takes the focus and whose keys the footer describes. */
  readonly chart: Element;
  readonly element: Element;
  readonly ranges: Element;
}

/**
 * Builds the chart section.
 *
 * @param d - The dashboard.
 * @param input - The router, which the crosshair follows the pointer through.
 * @returns The panel, the chart and its range selector.
 */
export function buildTraffic(d: Dashboard, input: InputRouter): TrafficView {
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
  /** What the crosshair's tooltip says: the day, and both figures for it. */
  const readout = (index: number): string => {
    const day = shown.get()[index];
    return day === undefined
      ? ''
      : `${shortDate(day.date)}\nAPI ${compact(day.api)}\nWeb ${compact(day.web)}`;
  };

  const mark = unicodeSupported() ? '■' : '#';
  const ranges = tabRowView({
    active: d.range,
    labels: RANGES.map((range) => range.label),
    props: { class: 'ranges' },
  });

  const chart = LineChart({
    crosshair: { input, text: readout },
    fill: true,
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
      {chart}
    </Panel>
  );

  return { chart, element, ranges };
}
