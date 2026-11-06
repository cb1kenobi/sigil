import { tasks } from '@ttylabs/sigil/components';

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

await tasks([
  { title: 'Install', task: () => wait(500).then(() => 'Resolved 12 packages') },
  { title: 'Build', task: () => wait(700).then(() => 'Built 10 modules') },
  { title: 'Upload assets', task: () => wait(5_000) },
  { title: 'Invalidate the cache', task: () => wait(300) },
]);
