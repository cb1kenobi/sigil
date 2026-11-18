import { END, HISTORY, projects, random, traffic } from '../src/data.ts';
import {
  change,
  compact,
  dollars,
  errorRate,
  kpis,
  percent,
  trendLabel,
  verdict,
  windows,
} from '../src/metrics.ts';
import { createDashboard, matches, sortProjects } from '../src/model.ts';
import { createRoot } from '@ttylabs/sigil/renderer';
import { flush } from '@ttylabs/sigil/signals';
import { describe, expect, it } from 'vitest';

/**
 * The made-up data, the arithmetic behind the cards, and the state the screen
 * reads -- all of it plain functions and signals, so none of it needs a screen.
 * `app.test.ts` drives the same state through the keys.
 */

describe('the data', () => {
  it('should be the same on every run, and end on the fixed day', () => {
    expect(traffic()).toStrictEqual(traffic());
    expect(projects()).toStrictEqual(projects());
    const days = traffic();
    expect(days).toHaveLength(HISTORY);
    expect(days.at(-1)?.date).toBe(END);
    // one day apart, oldest first
    expect((days[1]?.date ?? 0) - (days[0]?.date ?? 0)).toBe(24 * 60 * 60 * 1000);
  });

  it('should differ for another seed', () => {
    expect(traffic(1)).not.toStrictEqual(traffic(2));
    expect(random(5)()).toBe(random(5)());
  });

  it('should name every project once, and serve nothing from a paused one', () => {
    const list = projects();
    expect(new Set(list.map((p) => p.name)).size).toBe(list.length);
    expect(new Set(list.map((p) => p.id)).size).toBe(list.length);
    for (const p of list.filter((each) => each.status === 'paused')) {
      expect(p.requests).toBe(0);
    }
    // there is something for every status to say
    expect(new Set(list.map((p) => p.status))).toStrictEqual(
      new Set(['degraded', 'healthy', 'paused'])
    );
  });
});

describe('the metrics', () => {
  it('should split the history into the range and the range before it', () => {
    const days = traffic();
    const { current, previous } = windows(days, 30);
    expect(current).toHaveLength(30);
    expect(previous).toHaveLength(30);
    expect(current.at(-1)).toBe(days.at(-1));
    expect(previous.at(-1)).toBe(days.at(-31));
    // a range longer than half the history has a short window before it
    expect(windows(days, 120).previous).toHaveLength(60);
  });

  it('should say how far a figure moved, and nothing where there is no figure before it', () => {
    expect(change(110, 100)).toBeCloseTo(0.1);
    expect(change(90, 100)).toBeCloseTo(-0.1);
    expect(change(5, 0)).toBeUndefined();
    expect(change(5, Number.NaN)).toBeUndefined();
  });

  it('should write figures the way a card has room for', () => {
    expect(compact(812)).toBe('812');
    expect(compact(48_210)).toBe('48.2k');
    expect(compact(3_421_000)).toBe('3.42M');
    expect(compact(123_456_789)).toBe('123M');
    expect(dollars(60_642.4)).toBe('$60,642');
    expect(percent(0.0042)).toBe('0.42%');
  });

  it('should label a trend with an arrow, or a sign in ASCII, and no direction for none', () => {
    expect(trendLabel(0.125, false)).toBe('▲ 12.5%');
    expect(trendLabel(-0.031, false)).toBe('▼ 3.1%');
    expect(trendLabel(0.125, true)).toBe('+12.5%');
    expect(trendLabel(-0.031, true)).toBe('-3.1%');
    expect(trendLabel(0.0001, false)).toBe('0.0%');
  });

  it('should call a falling error rate good news and a falling revenue bad news', () => {
    expect(verdict({ change: -0.1, higherIsBetter: false })).toBe('good');
    expect(verdict({ change: 0.1, higherIsBetter: false })).toBe('bad');
    expect(verdict({ change: -0.1, higherIsBetter: true })).toBe('bad');
    expect(verdict({ change: 0, higherIsBetter: true })).toBe('flat');
    expect(verdict({ change: undefined, higherIsBetter: true })).toBe('flat');
  });

  it('should work the cards out over the range, against the range before', () => {
    const days = traffic();
    const list = projects();
    const [revenue, requests, errors, active] = kpis(days, 7, list);
    const week = days.slice(-7);
    expect(revenue?.value).toBe(dollars(week.reduce((n, day) => n + day.revenue, 0)));
    expect(revenue?.spark).toHaveLength(7);
    expect(requests?.value).toBe(compact(week.reduce((n, day) => n + day.api + day.web, 0)));
    expect(errors?.value).toBe(percent(errorRate(week)));
    expect(errors?.higherIsBetter).toBe(false);
    expect(revenue?.footer).toBe('vs prior 7d');
    const before = days.slice(-14, -7);
    expect(revenue?.note).toBe(`from ${dollars(before.reduce((n, day) => n + day.revenue, 0))}`);

    const live = list.filter((p) => p.status !== 'paused').length;
    expect(active?.value).toBe(String(live));
    expect(active?.ratio).toBeCloseTo(live / list.length);
    expect(active?.note).toBe(`of ${list.length}`);
    expect(active?.footer).toBe(`${list.length - live} paused`);
  });

  it('should count the degraded projects on the last card, and say so when there are none', () => {
    const list = projects();
    const degraded = list.filter((p) => p.status === 'degraded').length;
    expect(kpis(traffic(), 30, list)[3]?.state).toStrictEqual({
      label: `${degraded} degraded`,
      variant: 'warning',
    });
    const healthy = list.map((p) => ({ ...p, status: 'healthy' as const }));
    expect(kpis(traffic(), 30, healthy)[3]?.state).toStrictEqual({
      label: 'all healthy',
      variant: 'success',
    });
  });
});

describe('the dashboard state', () => {
  /** A dashboard under an owner of its own, so its effects go when the test does. */
  function make() {
    return createRoot((dispose) => ({ d: createDashboard(), dispose }));
  }

  it('should match every word of a search, in any field, ignoring case', () => {
    const [p] = projects();
    if (p === undefined) {
      throw new Error('no project');
    }
    expect(matches(p, '')).toBe(true);
    expect(matches(p, p.name.toUpperCase())).toBe(true);
    expect(matches(p, `${p.owner} ${p.region}`)).toBe(true);
    expect(matches(p, `${p.owner} nowhere`)).toBe(false);
  });

  it('should sort every project before cutting a page, so the pages run on from each other', () => {
    const { d, dispose } = make();
    d.sort.set({ column: 'name' });
    const names = d.visible.get().map((p) => p.name);
    expect(names).toStrictEqual([...names].sort());
    const first = d.page.get().map((p) => p.name);
    d.pager.next();
    const second = d.page.get().map((p) => p.name);
    // the second page starts where the first stopped, in the one order
    expect([...first, ...second]).toStrictEqual(names.slice(0, first.length + second.length));
    dispose();
  });

  it('should sort a status by how much it needs looking at, not by its spelling', () => {
    const sorted = sortProjects(projects(), { column: 'status', descending: true });
    expect(sorted[0]?.status).toBe('degraded');
    expect(sorted.at(-1)?.status).toBe('healthy');
  });

  it('should go back to the first page on a new search, and keep the page in range as the results shrink', () => {
    const { d, dispose } = make();
    d.pager.last();
    expect(d.pager.page).toBe(d.pager.pages - 1);
    // an effect runs on the microtask after the write that wakes it
    d.query.set('a');
    flush();
    expect(d.pager.page).toBe(0);
    d.query.set('no such project');
    flush();
    expect(d.page.get()).toStrictEqual([]);
    expect(d.pager.pages).toBe(1);
    dispose();
  });

  it('should take a removed project out of the selection too, and leave the others ticked', () => {
    const { d, dispose } = make();
    const [a, b] = d.projects.get();
    if (a === undefined || b === undefined) {
      throw new Error('no projects');
    }
    d.selected.set(new Set([a.id, b.id]));
    d.remove([a.id]);
    expect(d.projects.get().some((p) => p.id === a.id)).toBe(false);
    expect([...d.selected.get()]).toStrictEqual([b.id]);
    d.update([b.id], () => ({ starred: true }));
    expect(d.projects.get().find((p) => p.id === b.id)?.starred).toBe(true);
    dispose();
  });
});
