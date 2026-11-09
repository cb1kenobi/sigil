import { createMultiProgress } from '@ttylabs/sigil/components/multi-progress';

const downloads = [
  { name: 'react', size: 120, speed: 6 },
  { name: 'typescript', size: 300, speed: 12 },
  { name: 'esbuild', size: 80, speed: 3 },
];
const group = createMultiProgress({ unit: 'kB' });

await Promise.all(
  downloads.map(async ({ name, size, speed }) => {
    const bar = group.add({ text: name, total: size });
    while (bar.current < size) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      bar.tick(speed);
    }
    bar.done(`${name} installed`);
  })
);
group.done();
