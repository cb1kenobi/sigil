import { runApp } from '@ttylabs/sigil/app';
import { confirmModal } from '@ttylabs/sigil/components';
import { box, text } from '@ttylabs/sigil/element';

const root = box(
  { 'flex-direction': 'column', height: 8 },
  text('parser.ts'),
  text('canvas.ts'),
  text('layout.ts')
);
// inline, under the prompt, so the app is as tall as its list
const app = runApp(() => root, { fullscreen: false });

const sure = await confirmModal(root, {
  input: app.input,
  title: 'Delete it?',
  message: 'parser.ts will be gone for good.',
  width: 36,
});
app.exit(sure ? 0 : 1);
