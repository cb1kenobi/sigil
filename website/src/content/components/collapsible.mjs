import { runApp } from '@ttylabs/sigil/app';
import { Collapsible } from '@ttylabs/sigil/components';
import { box, text } from '@ttylabs/sigil/element';

const app = runApp(() =>
  box(
    { 'flex-direction': 'column' },
    Collapsible({
      title: 'Environment',
      children: () =>
        box({ 'flex-direction': 'column' }, text('NODE_ENV=production'), text('PORT=8080')),
    }),
    Collapsible({
      title: 'Build options',
      open: true,
      children: () =>
        box({ 'flex-direction': 'column' }, text('minify: on'), text('sourcemap: off')),
    })
  )
);

process.exitCode = await app.exited;
