import { runApp } from '@ttylabs/sigil/app';
import { Tabs } from '@ttylabs/sigil/components';
import { box, text } from '@ttylabs/sigil/element';

const panel =
  (...lines) =>
  () =>
    box({ 'flex-direction': 'column' }, ...lines.map((line) => text(line)));

const app = runApp(() =>
  Tabs({
    tabs: [
      {
        label: 'Overview',
        children: panel('3 services up, 1 degraded.', 'Last deploy 4 minutes ago.'),
      },
      {
        label: 'Logs',
        children: panel('12:01 deploy started', '12:04 migrations ran', '12:05 deploy finished'),
      },
      { label: 'Network', children: panel('eu-west  41 ms', 'us-east  12 ms') },
    ],
  })
);

process.exitCode = await app.exited;
