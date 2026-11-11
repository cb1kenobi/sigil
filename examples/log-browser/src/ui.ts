/**
 * The `ui` twin, run as it is: `node src/ui.ts [file]`.
 *
 * The same program as `index.ts` over the `ui`-tag root component, so nothing
 * in its import graph needs compiling. The schema is spelled out a second time
 * rather than imported, because `index.ts` imports `root.tsx` and Node cannot
 * load that. It says one thing `index.ts` does not, its `version`, which the
 * build bakes into the bin and nothing bakes into this file -- `hello`'s
 * `src/ui.ts` has the same line, for the reason `examples/AGENTS.md` records.
 */

import { EnvironmentContext, environment } from './browser.ts';
import { App, stylesheet } from './root.ui.ts';
import { main } from '@ttylabs/sigil';
import { runApp } from '@ttylabs/sigil/app';
import { provideContext } from '@ttylabs/sigil/renderer';
import { readFileSync } from 'node:fs';

await main({
  schema: {
    name: 'log-browser',
    desc: 'A log and resource browser in the shape of k9s and lnav',
    version: (): string =>
      JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf-8')).version,
    args: [
      { desc: 'A log file to read and follow, instead of the simulated pods', name: '[file]' },
    ],

    options: {
      '--mouse': 'Scroll with the wheel and click rows, at the cost of the terminal selecting text',
    },

    async run({ argv }: { argv: { file?: string; mouse: boolean } }): Promise<void> {
      const env = environment(argv.file);
      process.exitCode = await runApp(() => provideContext(EnvironmentContext, env, App), {
        mouse: argv.mouse,
        sheets: [stylesheet],
      }).exited;
    },
  },
});
