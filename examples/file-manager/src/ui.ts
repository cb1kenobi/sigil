/**
 * The `ui` twin, run as it is: `node src/ui.ts`.
 *
 * The same program as `index.ts` over the `ui`-tag root component, so nothing in
 * its import graph needs compiling -- Node strips the types and that is the whole
 * of the toolchain. The schema is spelled out a second time rather than imported,
 * because `index.ts` imports `root.tsx` and Node cannot load that.
 *
 * It says one thing `index.ts` does not: its `version`. `sigil build` bakes the
 * manifest's version into the bin it writes, and nothing builds this file, so it
 * reads the manifest beside `src/` itself -- as a function, so that only
 * `--version` pays for the read. `hello`'s `src/ui.ts` does the same, for the
 * reason `examples/AGENTS.md` records.
 */

import { createFiles, FilesContext } from './files.ts';
import { App, stylesheet } from './root.ui.ts';
import { main } from '@ttylabs/sigil';
import { runApp } from '@ttylabs/sigil/app';
import { provideContext } from '@ttylabs/sigil/renderer';
import { readFileSync } from 'node:fs';

await main({
  schema: {
    name: 'file-manager',
    desc: 'A file manager in Miller columns, with a preview',
    version: (): string =>
      JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf-8')).version,
    args: [
      {
        name: 'dir',
        desc: 'Where to open, or a file to open beside. Defaults to the working directory',
      },
    ],

    async run({ argv }): Promise<void> {
      const files = createFiles({ start: argv.dir as string | undefined });
      process.exitCode = await runApp(() => provideContext(FilesContext, files, App), {
        sheets: [stylesheet],
      }).exited;
    },
  },
});
