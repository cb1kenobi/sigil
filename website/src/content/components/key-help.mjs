import { runApp, useApp } from '@ttylabs/sigil/app';
import { keyHelp } from '@ttylabs/sigil/components/key-help';
import { box, text } from '@ttylabs/sigil/element';

const app = runApp(() => {
  const { input } = useApp();
  input.bind('r', () => {}, { description: 'refresh' });
  input.bind('d', () => {}, { description: 'deploy' });
  input.bind('?', () => {}, { description: 'help' });
  return box({ 'flex-direction': 'column' }, text('3 services running'), keyHelp(input));
});

process.exitCode = await app.exited;
