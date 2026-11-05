/**
 * Runs the monitor, unbuilt: `node src/ui.js`.
 *
 * Full screen until `q` (exit 0) or Ctrl-C (130). Without a terminal on both
 * ends `runApp()` refuses: one line on stderr, and exit 1.
 */

import { App, stylesheet } from './root.js';
import { runApp } from '@ttylabs/sigil/app';

process.exitCode = await runApp(App, { sheets: [stylesheet] }).exited;
