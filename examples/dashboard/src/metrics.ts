/**
 * What the cards say, worked out from the data: plain functions, so the
 * arithmetic is tested without a screen.
 */

import type { Day, Project } from './data.ts';

/** One card: a figure, how it moved, and what that movement is against. */
export interface Kpi {
  /**
   * How far the figure moved against the range before, as a fraction -- `0.125` is
   * up an eighth -- or `undefined` where there is nothing to compare with.
   */
  readonly change: number | undefined;
  /** Whether a rise is good news, which decides the badge's colour. */
  readonly higherIsBetter: boolean;
  /**
   * How full, between 0 and 1, for a card drawn with a gauge rather than a
   * sparkline: `undefined` for one with a sparkline.
   */
  readonly ratio?: number;
  /** What the card's bottom border says: what the change is against. */
  readonly footer: string;
  /** A short line beside the badge: where the figure was before. */
  readonly note: string;
  /** One value a day, for the sparkline. */
  readonly spark: readonly number[];
  /**
   * What the badge says for a card that is a state rather than a change, which
   * the active-projects card is: `undefined` for a card whose badge is its change.
   */
  readonly state?: { readonly label: string; readonly variant: 'success' | 'warning' };
  readonly title: string;
  /** The figure, written out. */
  readonly value: string;
}

/**
 * The last `days` days and the `days` before them.
 *
 * @param all - Every day, oldest first.
 * @param days - How long a window is.
 * @returns The two windows; the earlier one is short or empty where the history is.
 */
export function windows(all: readonly Day[], days: number): { current: Day[]; previous: Day[] } {
  const end = all.length;
  const start = Math.max(0, end - days);
  return {
    current: all.slice(start, end),
    previous: all.slice(Math.max(0, start - days), start),
  };
}

/**
 * How far `now` moved from `before`, as a fraction.
 *
 * @param now - This window's figure.
 * @param before - The last window's.
 * @returns The change, or `undefined` where the last window had nothing to compare with.
 */
export function change(now: number, before: number): number | undefined {
  if (!Number.isFinite(now) || !Number.isFinite(before) || before === 0) {
    return undefined;
  }
  return (now - before) / before;
}

const sum = (days: readonly Day[], of: (day: Day) => number): number =>
  days.reduce((total, day) => total + of(day), 0);

/** Requests of both kinds on a day. */
export const requestsOn = (day: Day): number => day.api + day.web;

/** The share of a window's requests that failed. */
export function errorRate(days: readonly Day[]): number {
  const requests = sum(days, requestsOn);
  return requests === 0 ? 0 : sum(days, (day) => day.errors) / requests;
}

/**
 * A count, short: `812`, `48.2k`, `3.42M`. Three significant figures past a thousand,
 * which is what a card has room for.
 *
 * @param n - The count.
 * @returns It written out.
 */
export function compact(n: number): string {
  const abs = Math.abs(n);
  const three = (x: number): string =>
    x >= 100 ? x.toFixed(0) : x >= 10 ? x.toFixed(1) : x.toFixed(2);
  if (abs >= 1e9) {
    return `${three(n / 1e9)}B`;
  }
  if (abs >= 1e6) {
    return `${three(n / 1e6)}M`;
  }
  if (abs >= 1e3) {
    return `${three(n / 1e3)}k`;
  }
  return String(Math.round(n));
}

/**
 * Dollars, whole, with separators: `$48,210`.
 *
 * `en-US` named rather than the process's locale, so the figure is the same on
 * every machine the tests run on.
 *
 * @param n - Dollars.
 * @returns It written out.
 */
export function dollars(n: number): string {
  return `$${Math.round(n).toLocaleString('en-US')}`;
}

/**
 * A fraction as a percentage with two decimals: `0.0042` is `0.42%`.
 *
 * @param n - The fraction.
 * @returns It written out.
 */
export function percent(n: number): string {
  return `${(n * 100).toFixed(2)}%`;
}

/**
 * A change as a badge says it: the direction as an arrow, and the size.
 *
 * @param delta - The change, as a fraction.
 * @param ascii - Whether to say the direction with a sign rather than an arrow.
 * @returns `▲ 12.5%`, `▼ 3.1%`, or `+12.5%` and `-3.1%` in ASCII; `0.0%` for no move.
 */
export function trendLabel(delta: number, ascii: boolean): string {
  const size = `${Math.abs(delta * 100).toFixed(1)}%`;
  if (size === '0.0%') {
    return size;
  }
  if (ascii) {
    return `${delta > 0 ? '+' : '-'}${size}`;
  }
  return `${delta > 0 ? '▲' : '▼'} ${size}`;
}

/**
 * Whether a change is good news, bad news, or none.
 *
 * @param kpi - The card.
 * @returns `good`, `bad`, or `flat` where it did not move or cannot be compared.
 */
export function verdict(kpi: Pick<Kpi, 'change' | 'higherIsBetter'>): 'bad' | 'flat' | 'good' {
  if (kpi.change === undefined || Math.abs(kpi.change) < 0.0005) {
    return 'flat';
  }
  return kpi.change > 0 === kpi.higherIsBetter ? 'good' : 'bad';
}

/**
 * The four cards, for a range.
 *
 * Revenue, requests and the error rate are over the range and compared with the
 * range before it: the badge is the change, the note is the figure it changed
 * from, and the border says what that was. Active projects is about now, from
 * the table's own rows, so pausing a project in the table moves it; its badge
 * counts the degraded ones and its border the paused.
 *
 * @param all - Every day, oldest first.
 * @param days - The range.
 * @param list - The projects as they are now.
 * @returns The cards, in the order they are drawn.
 */
export function kpis(all: readonly Day[], days: number, list: readonly Project[]): Kpi[] {
  const { current, previous } = windows(all, days);
  const footer = `vs prior ${days}d`;
  const before = (text: string): string =>
    previous.length === 0 ? 'nothing before' : `from ${text}`;
  const revenue = sum(current, (day) => day.revenue);
  const revenueBefore = sum(previous, (day) => day.revenue);
  const requests = sum(current, requestsOn);
  const requestsBefore = sum(previous, requestsOn);
  const rate = errorRate(current);
  const rateBefore = errorRate(previous);
  const active = list.filter((project) => project.status !== 'paused').length;
  const degraded = list.filter((project) => project.status === 'degraded').length;

  return [
    {
      change: change(revenue, revenueBefore),
      footer,
      higherIsBetter: true,
      note: before(dollars(revenueBefore)),
      spark: current.map((day) => day.revenue),
      title: 'Revenue',
      value: dollars(revenue),
    },
    {
      change: change(requests, requestsBefore),
      footer,
      higherIsBetter: true,
      note: before(compact(requestsBefore)),
      spark: current.map(requestsOn),
      title: 'Requests',
      value: compact(requests),
    },
    {
      change: change(rate, previous.length === 0 ? Number.NaN : rateBefore),
      footer,
      higherIsBetter: false,
      note: before(percent(rateBefore)),
      spark: current.map((day) => day.errors / Math.max(1, requestsOn(day))),
      title: 'Error rate',
      value: percent(rate),
    },
    {
      change: undefined,
      footer: `${list.length - active} paused`,
      higherIsBetter: true,
      note: `of ${list.length}`,
      ratio: list.length === 0 ? 0 : active / list.length,
      spark: [],
      state:
        degraded === 0
          ? { label: 'all healthy', variant: 'success' }
          : { label: `${degraded} degraded`, variant: 'warning' },
      title: 'Active projects',
      value: String(active),
    },
  ];
}
