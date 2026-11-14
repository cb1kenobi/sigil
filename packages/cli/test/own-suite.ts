import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);

/** vitest's package directory, as this package resolves it. */
const vitest = dirname(require.resolve('vitest/package.json'));

/**
 * The argv that runs a scaffolded app's own suite, from the app's directory:
 * what its `test` script runs, `vitest run`, with node directly rather than
 * through a package manager, and vitest's bin found under the
 * `node_modules/vitest` link the test has made in the app. Shared by
 * `new-tui.test.ts` and the guides' `$ npm test` steps (`guides.ts`), and it
 * imports no vitest, because the website's capture script runs those steps with
 * plain `node`.
 *
 * Two flags are added, and both are about how this repository runs the suite
 * rather than about the app.
 *
 * - **`--reporter=default`**, because vitest picks one from the environment:
 *   `minimal` when std-env detects a coding agent, `default` otherwise, and
 *   `github-actions` on top of it on CI. The first time a guide ran on CI it got
 *   a different reporter, in colour, where it had been neither on the machine it
 *   was written on, so the transcript's summary lines matched nothing.
 * - **`--testTimeout=30000`**, because on a Windows runner with sixteen apps at
 *   once a scaffold's first test went past vitest's 5-second default (SIG-426).
 *   These apps linked `@ttylabs/sigil` to the workspace then, and vitest
 *   transformed every module of the runtime itself: 72 ms against 14 for the
 *   same test, and `transform 64%` in the Windows log. They get an installed copy
 *   now (`installSigil()`, SIG-431), which takes the transform away, and the
 *   budget stays until a Windows run shows the default is enough: it costs a
 *   passing run nothing, and it is ours to pay rather than every new app's. The
 *   measurements are "The scaffolded tests keep vitest's 5-second default" under
 *   `sigil new` in `packages/cli/AGENTS.md`.
 */
export const OWN_SUITE: readonly string[] = [
  join(
    'node_modules',
    'vitest',
    (JSON.parse(readFileSync(join(vitest, 'package.json'), 'utf-8')) as { bin: { vitest: string } })
      .bin.vitest
  ),
  'run',
  '--reporter=default',
  '--testTimeout=30000',
];
