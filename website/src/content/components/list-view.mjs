import { runApp } from '@ttylabs/sigil/app';
import { ListView } from '@ttylabs/sigil/components/list-view';

const app = runApp(() =>
  ListView({
    items: [
      { name: 'api-7d9f', status: 'Running' },
      { name: 'worker-5c2a', status: 'Running' },
      { name: 'cron-81bb', status: 'Completed' },
      { name: 'db-0', status: 'Terminating' },
      { name: 'cache-3e1', status: 'Running' },
    ],
    key: (pod) => pod.name,
    row: (pod) => `${pod.name.padEnd(14)}${pod.status}`,
    disabled: (pod) => pod.status === 'Terminating',
    multiple: true,
  })
);

process.exitCode = await app.exited;
