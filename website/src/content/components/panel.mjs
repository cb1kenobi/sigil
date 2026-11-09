import { runApp } from '@ttylabs/sigil/app';
import { Panel } from '@ttylabs/sigil/components/panel';
import { text } from '@ttylabs/sigil/element';

const app = runApp(() =>
  Panel(
    {
      title: 'processes · 12 of 340',
      annotation: 'sort: cpu',
      footer: '↑↓ select · s sort',
      footerAnnotation: '1–4 of 340',
    },
    text('  PID  NAME          CPU'),
    text('  412  node          8.1'),
    text('  977  postgres      2.4'),
    text('    1  launchd       0.0')
  )
);

process.exitCode = await app.exited;
