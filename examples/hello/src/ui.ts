/**
 * The `ui` twin, run as it is: `node src/ui.ts`.
 *
 * The same program as `index.ts` over the `ui`-tag root component, so nothing
 * in its import graph needs compiling -- Node strips the types and that is the
 * whole of the toolchain. The schema is spelled out a second time rather than
 * imported, because `index.ts` imports `root.tsx` and Node cannot load that.
 *
 * It says one thing `index.ts` does not: its `version`. `sigil build` bakes the
 * manifest's version into the bin it writes, so `node dist/hello.mjs --version`
 * prints it -- and nothing builds this file, so without a version of its own
 * `--version` is an option nobody declared and the app runs instead. Read off
 * the manifest beside `src/`, a path that holds only unbuilt, which is why the
 * build replaces an app's version rather than keeping it; and as a function,
 * so that only `--version` reads it. The toolchain's own `version()` in
 * `packages/cli/src/index.ts` is the same read.
 */

import { App, stylesheet } from './root.ui.ts';
import { main } from '@ttylabs/sigil';
import { runApp } from '@ttylabs/sigil/app';
import { readFileSync } from 'node:fs';

await main({
  schema: {
    name: 'hello',
    desc: 'The smallest full-screen sigil app',
    version: (): string =>
      JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf-8')).version,

    async run(): Promise<void> {
      process.exitCode = await runApp(App, { sheets: [stylesheet] }).exited;
    },
  },
});
