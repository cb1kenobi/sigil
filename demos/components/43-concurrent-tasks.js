/**
 * Tasks side by side, subtasks under a parent, a retry, and a failure policy.
 *
 *   node demos/components/43-concurrent-tasks.js
 *   node demos/components/43-concurrent-tasks.js | cat     <- the same run, with no terminal
 *
 * `tasks()` with a `concurrency` runs that many at once, each with a row of its
 * own -- in one live region, driven by one clock, so the rows never evict each
 * other the way one spinner per task would. A task's `context.tasks()` runs a
 * list of subtasks one level in, with its own concurrency. A task that finishes
 * leaves the frame and is written above it, so the frame is as tall as what is
 * running rather than as long as the list.
 *
 * Piped there is no frame: a line when each task starts and one when it settles,
 * indented by depth, in the order it happened -- and a line of a task's output is
 * labelled with its title, because tasks running side by side interleave.
 */
import { skip, tasks } from '@ttylabs/sigil/components';

const sleep = (ms, signal) =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      reject(signal.reason);
    });
  });

const packages = [
  { name: 'react', ms: 700 },
  { name: 'typescript', ms: 1100 },
  { name: 'esbuild', ms: 500 },
  { name: 'vite', ms: 900 },
  { name: 'vitest', ms: 600 },
];

let flaky = 0;

await tasks(
  [
    {
      title: 'Installing 5 packages',
      async task({ tasks: sub }) {
        // five fetches, three at a time, each a row under the parent; the parent
        // succeeds because none of them threw, and collapses to one line
        await sub(
          packages.map(({ name, ms }) => ({
            title: `Fetching ${name}`,
            async task({ signal }) {
              await sleep(ms, signal);
              return `Fetched ${name}`;
            },
          })),
          { concurrency: 3 }
        );
        return 'Installed 5 packages';
      },
    },
    {
      title: 'Checking the registry',
      // fails twice and then works: the row says which retry it is on
      retry: { tries: 2, delay: 200 },
      async task() {
        await sleep(300);
        if (++flaky < 3) {
          throw new Error('ECONNRESET');
        }
        return 'Registry reachable';
      },
    },
    {
      title: 'Generating types',
      async task({ log }) {
        const out = log({ limit: 3 });
        for (let i = 1; i <= 6; i++) {
          out.message(`wrote types/module-${i}.d.ts`);
          await sleep(150);
        }
      },
    },
    { title: 'Seeding the cache', task: () => skip('already warm') },
  ],
  { concurrency: 3 }
);

// with `failFast: false` every task runs whatever fails, and the rejection is an
// AggregateError holding each failure -- caught here by name, so any other throw
// still fails the demo
try {
  await tasks(
    [
      { title: 'Linting', task: () => sleep(400) },
      {
        title: 'Type checking',
        async task() {
          await sleep(250);
          throw new Error('error TS2322');
        },
      },
      { title: 'Testing', task: () => sleep(600) },
    ],
    { concurrency: Infinity, failFast: false }
  );
} catch (error) {
  if (!(error instanceof AggregateError)) {
    throw error;
  }
}
