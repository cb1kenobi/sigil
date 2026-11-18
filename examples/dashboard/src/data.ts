/**
 * Everything the dashboard shows, made up here and the same on every run.
 *
 * There is no server behind the example, so the numbers are generated: half a
 * year of daily traffic for a small hosting platform, and the projects running
 * on it. Every choice comes from a seeded generator and the calendar ends on a
 * fixed day, so a screen drawn today is the screen drawn next year -- which is
 * what lets the tests assert on what is drawn, and what keeps a screenshot in a
 * README from going stale. Nothing here reads `Date.now()` or `Math.random()`.
 */

/** The last day the data covers, at midnight UTC. Fixed, so nothing depends on when it runs. */
export const END: number = Date.UTC(2026, 10, 16);

/** How many days of traffic there are: the longest range, and the one before it. */
export const HISTORY: number = 180;

const DAY = 24 * 60 * 60 * 1000;

/**
 * A generator of numbers in `[0, 1)` from a seed: a linear congruential one,
 * which is all a made-up dashboard needs and is the same in every runtime.
 *
 * @param seed - Where it starts.
 * @returns The next number, each call.
 */
export function random(seed: number): () => number {
  let state = Math.abs(Math.trunc(seed)) % 2_147_483_648;
  return () => {
    state = (state * 1_103_515_245 + 12_345) % 2_147_483_648;
    return state / 2_147_483_648;
  };
}

/** One day of the platform's traffic. */
export interface Day {
  /** Requests to the API. */
  readonly api: number;
  /** Midnight UTC, as milliseconds. */
  readonly date: number;
  /** Requests that failed, of both kinds. */
  readonly errors: number;
  /** What was billed that day, in dollars. */
  readonly revenue: number;
  /** Requests for pages. */
  readonly web: number;
}

/**
 * Half a year of traffic, oldest first, ending on {@link END}.
 *
 * Growth of a few percent a month, a weekly shape -- the API quieter at the
 * weekend, pages a little busier -- noise of a few percent, and two bad days,
 * so the error rate has something to say.
 *
 * @param seed - The generator's seed.
 * @param days - How many days.
 * @returns The days.
 */
export function traffic(seed: number = 297, days: number = HISTORY): Day[] {
  const roll = random(seed);
  const noise = (spread: number): number => 1 + (roll() - 0.5) * 2 * spread;
  // two incidents, at fixed distances from the end so each range sees a different number
  const incidents = new Map([
    [days - 12, 5.5],
    [days - 61, 3.2],
  ]);

  return Array.from({ length: days }, (_, i) => {
    const date = END - (days - 1 - i) * DAY;
    const weekday = new Date(date).getUTCDay();
    const weekend = weekday === 0 || weekday === 6;
    const growth = 1 + i * 0.0021;

    const api = Math.round(41_800 * growth * (weekend ? 0.72 : 1) * noise(0.08));
    const web = Math.round(23_600 * growth * (weekend ? 1.12 : 1) * noise(0.1));
    const rate = 0.0036 * noise(0.35) * (incidents.get(i) ?? 1);
    const revenue = Math.round(1_560 * growth * (weekend ? 0.86 : 1) * noise(0.06) * 100) / 100;

    return { api, date, errors: Math.round((api + web) * rate), revenue, web };
  });
}

/** What a project is doing. */
export type Status = 'degraded' | 'healthy' | 'paused';

/** One project on the platform: a row of the table. */
export interface Project {
  /** The share of the last day's requests that failed, as a fraction. */
  readonly errorRate: number;
  /** What identifies it, which the table's cursor and selection hold. */
  readonly id: string;
  readonly name: string;
  /** Who looks after it. */
  readonly owner: string;
  /** Where it runs. */
  readonly region: string;
  /** Requests in the last day. */
  readonly requests: number;
  /** Starred from its row menu, which puts a mark beside its name. */
  readonly starred: boolean;
  readonly status: Status;
}

const NAMES = [
  'atlas',
  'birch',
  'cobalt',
  'delta',
  'ember',
  'fjord',
  'garnet',
  'heron',
  'iris',
  'juniper',
  'kelp',
  'lantern',
  'marlin',
  'nimbus',
  'onyx',
  'pylon',
  'quartz',
  'ripple',
  'sable',
  'tundra',
  'umber',
  'vesper',
  'willow',
  'yarrow',
  'zephyr',
] as const;

const KINDS = ['api', 'web', 'worker', 'cron', 'edge', 'docs', 'auth', 'search'] as const;

/** The regions, as the platform names them. */
export const REGIONS = ['iad1', 'sfo1', 'fra1', 'hnd1', 'gru1', 'syd1', 'cdg1'] as const;

/** The people who own projects. */
export const OWNERS = ['mara', 'tomas', 'ines', 'kofi', 'yuki', 'ravi', 'noor', 'elio'] as const;

/**
 * The projects, in the order they were created.
 *
 * About four in five are healthy, the rest degraded or paused; a paused one has
 * served nothing today. Names never repeat.
 *
 * @param seed - The generator's seed.
 * @param count - How many. At most every name with every kind.
 * @returns The projects.
 */
export function projects(seed: number = 297, count: number = 46): Project[] {
  const roll = random(seed * 7 + 1);
  const pick = <T>(list: readonly T[]): T => list[Math.floor(roll() * list.length)] as T;
  const taken = new Set<string>();
  const out: Project[] = [];

  while (out.length < Math.min(count, NAMES.length * KINDS.length)) {
    const name = `${pick(NAMES)}-${pick(KINDS)}`;
    if (taken.has(name)) {
      continue;
    }
    taken.add(name);

    const draw = roll();
    const status: Status = draw < 0.78 ? 'healthy' : draw < 0.88 ? 'degraded' : 'paused';
    // a long tail: most projects are small and a few are most of the traffic
    const requests = status === 'paused' ? 0 : Math.round(180 * Math.exp(roll() * 9.2));
    const errorRate =
      status === 'paused' ? 0 : status === 'degraded' ? 0.015 + roll() * 0.05 : roll() * 0.009;

    out.push({
      errorRate,
      id: `prj_${(out.length * 7919 + 1009).toString(36).padStart(4, '0')}`,
      name,
      owner: pick(OWNERS),
      region: pick(REGIONS),
      requests,
      starred: false,
      status,
    });
  }
  return out;
}

/** A range the chart and the cards can show. */
export interface Range {
  readonly days: number;
  readonly label: string;
}

/** What the range selector offers, shortest first. */
export const RANGES: readonly Range[] = [
  { days: 7, label: '7 days' },
  { days: 30, label: '30 days' },
  { days: 90, label: '90 days' },
];
