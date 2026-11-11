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

import { createGit, GitContext } from './git.ts';
import { App, stylesheet } from './root.ui.ts';
import { main } from '@ttylabs/sigil';
import { runApp } from '@ttylabs/sigil/app';
import { provideContext } from '@ttylabs/sigil/renderer';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

await main({
  schema: {
    name: 'git-client',
    desc: 'A git client in the shape of lazygit',
    version: (): string =>
      JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf-8')).version,
    args: [
      {
        name: 'dir',
        desc: 'The repository, or any directory inside it. Defaults to the working directory',
      },
    ],

    async run({ argv }): Promise<void> {
      const dir = argv.dir as string | undefined;
      const git = createGit({ cwd: dir === undefined ? undefined : resolve(dir) });
      process.exitCode = await runApp(() => provideContext(GitContext, git, App), {
        sheets: [stylesheet],
      }).exited;
    },
  },
});
