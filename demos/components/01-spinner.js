/**
 * A spinner, for work whose length is not known.
 *
 *   node demos/components/01-spinner.js
 *   node demos/components/01-spinner.js | cat     <- the same run, with no terminal
 *
 * Piped, there is nothing to animate, so it writes one line per change instead
 * of one per frame. That is the whole of the CI handling.
 */
import { createSpinner } from '@ttylabs/sigil/components';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const spinner = createSpinner({ text: 'Resolving dependencies' }).start();
await sleep(700);

spinner.text = 'Compiling';
await sleep(400);

// output that stays, and lands above the spinner rather than through it
spinner.write('compiled src/index.js');
await sleep(400);
spinner.write('compiled src/cli.js');
await sleep(400);

spinner.succeed('Compiled 2 files');

const failing = createSpinner({ text: 'Uploading' }).start();
await sleep(600);
failing.fail('Upload failed: connection reset');

createSpinner({ text: 'Checking for updates' }).start().warn('Version 2.0.0 is available');
createSpinner({ text: 'Cache' }).start().info('Nothing to do');
