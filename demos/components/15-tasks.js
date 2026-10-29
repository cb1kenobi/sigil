/**
 * A list of work, and a subprocess's output in a window.
 *
 *   node demos/components/15-tasks.js
 *   node demos/components/15-tasks.js | cat     <- the same run, with no terminal
 *
 * `tasks()` runs each task in turn under a spinner. `taskLog()` is what a task
 * writes a subprocess's output to: the last few lines while it runs, nothing
 * once it succeeds, and every line of it once it fails -- which is the only part
 * of a failing build anybody reads.
 *
 * Piped, there is no window to repaint, so the title is written once, each line
 * as it arrives, and a settled line at the end.
 */
import { skip, taskLog, tasks } from '@ttylabs/sigil/components';
import { spawn } from 'node:child_process';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Runs a node one-liner, feeding what it prints to a log, and rejects if it fails. */
async function run(log, script) {
  const child = spawn(process.execPath, ['-e', script], { stdio: ['ignore', 'pipe', 'pipe'] });
  const exited = new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (code) =>
      code === 0 ? resolve() : reject(new Error(`exited with code ${code}`))
    );
  });
  await Promise.all([log.stream(child.stdout), log.stream(child.stderr), exited]);
}

const build = (fail) => `
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  (async () => {
    for (let i = 1; i <= 10; i++) {
      console.log('compiling src/module-' + i + '.ts');
      await wait(60);
    }
    ${fail ? "console.error('error TS2322: Type string is not assignable to type number'); process.exit(1);" : ''}
  })();
`;

await tasks([
  {
    title: 'Resolving dependencies',
    async task({ message }) {
      await sleep(300);
      message('Fetching 12 packages');
      await sleep(400);
      return 'Resolved 12 packages';
    },
  },
  {
    title: 'Generating bindings',
    task: () => skip('nothing changed'),
  },
  {
    enabled: false,
    title: 'Never shown',
    task: () => {},
  },
  {
    title: 'Building',
    async task({ log }) {
      // the window replaces the spinner: ten lines go by, six stay, and a
      // success takes all of them with it
      await run(log({ limit: 6 }), build(false));
      return 'Built 10 modules';
    },
  },
]);

// a failure keeps everything it printed, and the rejection is the caller's
try {
  await tasks([
    {
      title: 'Type checking',
      async task({ log }) {
        await run(log({ limit: 3 }), build(true));
      },
    },
    {
      title: 'Never runs',
      task: () => {},
    },
  ]);
} catch (error) {
  if (!(error instanceof Error) || !error.message.startsWith('exited with code')) {
    throw error;
  }
}

// and a window can be used without a list
const log = taskLog({ title: 'Linting', limit: 2 });
for (const file of ['src/a.ts', 'src/b.ts', 'src/c.ts']) {
  log.message(`checked ${file}`);
  await sleep(150);
}
log.success('Linted 3 files');
