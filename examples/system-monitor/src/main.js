/**
 * Runs the monitor full screen.
 *
 *   node examples/system-monitor/src/main.js
 *
 * Everything here is wiring that SIG-276's app runner exists to replace: the TTY
 * check on both ends, the full-screen backend, the renderer, the router, the
 * quit keys, and the order they are torn down in. `App` is the part that is the
 * monitor.
 */

import { App, monitorCascade } from './app.js';
import { createSampler } from './sampler.js';
import { createFullscreenCanvas } from '@ttylabs/sigil/canvas';
import { createInput, isAbort } from '@ttylabs/sigil/input';
import { render } from '@ttylabs/sigil/renderer';
import { State } from '@ttylabs/sigil/signals';

// both ends, because the keys arrive on one and the frames go to the other:
// `| cat` from a terminal has a TTY stdin and a piped stdout
if (!process.stdin.isTTY || !process.stdout.isTTY) {
  console.log('The system monitor takes the whole screen and reads keys, so it needs a terminal.');
  console.log('Run it without a pipe: node examples/system-monitor/src/main.js');
  process.exit(0);
}

const cascade = monitorCascade();
const shell = new State(undefined);
const sampler = createSampler();

const view = render(() => App({ cascade, sampler, shell }), {
  backend: createFullscreenCanvas(),
  cascade,
});
const input = createInput({ mouse: { surface: view.backend }, root: view.root });

let quitting = false;
const quit = () => {
  if (quitting) {
    return;
  }
  quitting = true;
  input.stop();
  view.dispose();
  process.stdin.unref();
};

// the one key that must work whatever has the focus, so it is a binding, which
// sees every key before anything in the tree does
input.bind((event) => {
  if (isAbort(event.key)) {
    event.stop();
    quit();
  }
});

shell.set({
  host: view,
  input,
  quit,
  restyle: () => {
    view.restyler.touchSheets();
    view.frame();
  },
});
