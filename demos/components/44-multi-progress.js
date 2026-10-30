/**
 * Several progress bars at once, each with a rate and a time remaining.
 *
 *   node demos/components/44-multi-progress.js
 *   node demos/components/44-multi-progress.js | cat     <- a labelled line per bar
 *
 * Four "downloads" of different sizes and speeds share one live region. Each bar
 * is added and finished on its own; the pace and the ETA beside it come from an
 * estimator that averages over time, so the number settles rather than flickers.
 *
 * Piped, there are no bars to repaint, so every bar writes its own line every
 * `step` percent -- and no rate, which would be different on every line.
 */
import { createMultiProgress } from '@ttylabs/sigil/components';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const downloads = [
  { name: 'react', size: 120, speed: 6 },
  { name: 'typescript', size: 300, speed: 12 },
  { name: 'esbuild', size: 80, speed: 3 },
  { name: 'vite', size: 200, speed: 9 },
];

const group = createMultiProgress({ eta: true, rate: true, step: 25, unit: 'kB' });

await Promise.all(
  downloads.map(async ({ name, size, speed }, i) => {
    // started a moment apart, so the bars are added while others are running
    await sleep(i * 250);
    const bar = group.add({ text: name, total: size });

    while (bar.current < size) {
      await sleep(50);
      bar.tick(speed);
    }
    bar.done(`${name} installed`);
  })
);

group.write('4 packages installed');
group.done();
