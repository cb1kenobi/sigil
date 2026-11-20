/**
 * The row of cards: a figure, a badge saying how it moved, the range it moved
 * against, and a sparkline of the days behind it.
 *
 * The figure has a line to itself and the badge leads the line under it, so a
 * narrow card cuts the note first, then the badge, and never the figure.
 *
 * Every card reads `d.kpis`, a `Computed` over the range and the projects, so a
 * new range redraws all four and pausing a project redraws the last one.
 */

import { type Kpi, trendLabel, verdict } from './metrics.ts';
import type { Dashboard } from './model.ts';
import { Badge, type BadgeVariant } from '@ttylabs/sigil/components/badge';
import { Gauge, Sparkline } from '@ttylabs/sigil/components/chart';
import { unicodeSupported } from '@ttylabs/sigil/components/note';
import { Panel } from '@ttylabs/sigil/components/panel';
import type { Element } from '@ttylabs/sigil/element';
import { Computed, untrack } from '@ttylabs/sigil/signals';

/** The badge a card wears: its change, or for a card that is a state, the state. */
export function badgeFor(kpi: Kpi, ascii: boolean): { label: string; variant: BadgeVariant } {
  if (kpi.state !== undefined) {
    return kpi.state;
  }
  if (kpi.change === undefined) {
    return { label: 'new', variant: 'neutral' };
  }
  const tone = verdict(kpi);
  return {
    label: trendLabel(kpi.change, ascii),
    variant: tone === 'good' ? 'success' : tone === 'bad' ? 'error' : 'neutral',
  };
}

/** What one card is handed. */
interface CardProps {
  d: Dashboard;
  /** Which of the four, by position. */
  index: number;
}

/**
 * One card.
 *
 * @param props - The dashboard and which card.
 * @returns The card.
 */
function Card({ d, index }: CardProps): Element {
  const ascii = !unicodeSupported();
  const kpi = (): Kpi => d.kpis.get()[index] as Kpi;
  // one reading for both of the badge's props, so a change is one redraw
  const badge = new Computed(() => badgeFor(kpi(), ascii));
  // a card is a trend or a share of a whole for its life, so which chart it
  // draws is decided once
  const chart = untrack(() => kpi().ratio !== undefined)
    ? Gauge({
        class: 'card-chart',
        props: { 'flex-grow': 1 },
        style: 'line',
        value: () => kpi().ratio ?? 0,
      })
    : Sparkline({
        class: 'card-chart',
        data: () => kpi().spark,
        props: { 'flex-grow': 1, height: 1 },
      });

  return (
    <Panel class="card" footer={() => kpi().footer} title={() => kpi().title}>
      <text class="figure sigil-heading">{() => kpi().value}</text>
      <box class="card-trend">
        <Badge label={() => badge.get().label} variant={() => badge.get().variant} />
        <text class="card-note sigil-muted">{() => kpi().note}</text>
      </box>
      {chart}
    </Panel>
  );
}

/**
 * The four cards in a row.
 *
 * @param props - The dashboard.
 * @returns The row.
 */
export function Cards({ d }: { d: Dashboard }): Element {
  return (
    <box class="cards">
      <Card d={d} index={0} />
      <Card d={d} index={1} />
      <Card d={d} index={2} />
      <Card d={d} index={3} />
    </box>
  );
}
