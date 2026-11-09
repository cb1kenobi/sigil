import { runApp } from '@ttylabs/sigil/app';
import { showToast } from '@ttylabs/sigil/components/toast';
import { box, text } from '@ttylabs/sigil/element';

const root = box({ 'flex-direction': 'column', height: 8 }, text('Editing config.json'));
const app = runApp(() => root);

showToast(root, {
  title: 'Saved',
  message: 'config.json is written',
  variant: 'success',
  position: 'top-right',
});

process.exitCode = await app.exited;
