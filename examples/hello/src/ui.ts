/**
 * The `ui` twin, run as it is: `node src/ui.ts`.
 *
 * The same program as `index.ts` over the `ui`-tag root component, so nothing
 * in its import graph needs compiling -- Node strips the types and that is the
 * whole of the toolchain. The schema is spelled out a second time rather than
 * imported, because `index.ts` imports `root.tsx` and Node cannot load that.
 */

import { App, stylesheet } from './root.ui.ts';
import { start } from './start.ts';
import { main } from '@ttylabs/sigil';

await main({
  schema: {
    name: 'hello',
    desc: 'The smallest full-screen sigil app',

    async run(): Promise<void> {
      process.exitCode = await start(App, { stylesheet });
    },
  },
});
