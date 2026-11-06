/**
 * Runs the monitor, unbuilt: `node src/ui.js`.
 *
 * Full screen until `q` (exit 0) or Ctrl-C (130). Without a terminal on both
 * ends `runApp()` refuses: one line on stderr, and exit 1.
 *
 * Through `main()` rather than `runApp()` alone, so that `--help` and
 * `--version` answer the way every sigil app's do. Nothing builds this file, so
 * nothing bakes a version into it: it reads the manifest beside `src/`, as a
 * function so that only `--version` pays for the read. `hello`'s `src/ui.ts`
 * does the same, for the reason `examples/AGENTS.md` records.
 */

import { App, stylesheet } from './root.js';
import { main } from '@ttylabs/sigil';
import { runApp } from '@ttylabs/sigil/app';
import { readFileSync } from 'node:fs';

await main({
  schema: {
    name: 'system-monitor',
    desc: 'A system monitor in the shape of btop and htop',
    version: () =>
      JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf-8')).version,

    async run() {
      process.exitCode = await runApp(App, { sheets: [stylesheet] }).exited;
    },
  },
});
