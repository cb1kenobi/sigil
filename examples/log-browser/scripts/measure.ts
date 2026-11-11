/**
 * What a log costs as it grows: run by hand, `node scripts/measure.ts`, after
 * `pnpm build` at the repository root.
 *
 * Mounts the `ui`-tag root over a 120 by 40 test terminal with a clock this
 * script turns, opens the log, and times the things a reader does to it at four
 * sizes of history: a new batch of lines arriving while it follows, a page up, a
 * search and the `n` after it, and a filter typed with `&`. Each is the work and
 * the frame that draws it, by wall clock -- `frame()` paints at once, so the time
 * around it is the whole cost -- with the median of a run of them, and the number
 * of elements the tree held at the end, which is what windowing keeps flat.
 *
 * Not a test: figures from a shared machine under a parallel suite are noise, and
 * `examples/log-browser/README.md` records what this printed, against the change
 * that printed it.
 */

import { EnvironmentContext, type Environment, REAL } from '../src/browser.ts';
import { App, stylesheet } from '../src/root.ui.ts';
import { runApp } from '@ttylabs/sigil/app';
import { provideContext } from '@ttylabs/sigil/renderer';
import { createTestTerminal, frame, KEYS } from '@ttylabs/sigil/testing';
import { performance } from 'node:perf_hooks';

const SIZES = [500, 5_000, 50_000, 200_000];
const RUNS = 30;

const median = (xs: number[]): number => {
  const sorted = [...xs].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] as number;
};

const rows: string[][] = [];

for (const backlog of SIZES) {
  const term = createTestTerminal({ columns: 120, rows: 40 });
  let tick: () => void = () => {};
  const env: Environment = {
    ...REAL,
    backlog,
    clock: {
      every(_ms, fn) {
        tick = fn;
        return () => {};
      },
    },
  };
  const started = performance.now();
  const app = runApp(() => provideContext(EnvironmentContext, env, App), {
    detect: false,
    gatherStats: true,
    now: () => performance.now(),
    sheets: [stylesheet],
    terminal: term.terminal,
  });
  await frame(app);
  const open = performance.now() - started;

  const input = app.input;
  if (!input) {
    throw new Error('the app refused to start');
  }
  // the work and the frame that draws it, synchronously: a batch written or a key
  // fed in, then a frame forced, which runs every effect the write woke, lays out
  // and paints -- so the time between is the whole cost and none of it is waiting
  const timed = (fn: () => void): number => {
    const t = performance.now();
    fn();
    app.view.frame();
    return performance.now() - t;
  };
  const key = (keys: string) => () => input.feed(keys);

  timed(key(':logs\r'));

  const appends: number[] = [];
  for (let i = 0; i < RUNS; i++) {
    appends.push(timed(() => tick()));
  }
  const pages: number[] = [];
  for (let i = 0; i < RUNS; i++) {
    pages.push(timed(key(KEYS.pageUp)));
  }
  const search = timed(key('/upstream\r'));
  const nexts: number[] = [];
  for (let i = 0; i < 10; i++) {
    nexts.push(timed(key('n')));
  }
  const grep = timed(key('&warn\r'));
  const elements = app.view.stats?.elements ?? 0;

  app.exit(0);
  await app.exited;
  rows.push([
    backlog.toLocaleString('en-US'),
    open.toFixed(0),
    median(appends).toFixed(2),
    median(pages).toFixed(2),
    search.toFixed(2),
    median(nexts).toFixed(2),
    grep.toFixed(2),
    String(elements),
  ]);
}

const head = [
  'lines',
  'open ms',
  'append ms',
  'page up ms',
  'search ms',
  'n ms',
  '& ms',
  'elements',
];
process.stdout.write(`| ${head.join(' | ')} |\n| ${head.map(() => '---').join(' | ')} |\n`);
for (const row of rows) {
  process.stdout.write(`| ${row.join(' | ')} |\n`);
}
