import { runApp } from '@ttylabs/sigil/app';
import { enableDebugOverlay } from '@ttylabs/sigil/components';
import { box } from '@ttylabs/sigil/element';

// runApp() captures the console into app.logs, so what console.log writes goes
// to the pane rather than over the app
const app = runApp(() => box({}));
enableDebugOverlay(app.view, {
  height: 6,
  input: app.input,
  key: (key) => key.ctrl && key.name === 'g',
  log: app.logs,
  visible: true,
});

console.log('loaded 3 services');
console.warn('eu-west-1 is slow to answer');

process.exitCode = await app.exited;
