/**
 * Writes `src/route-info.ts` from the modules in `src/commands/`.
 *
 * A thin wrapper: the lift itself is `liftRouteInfo()` in `src/build/`, so that
 * `the committed route info` in `test/commands.test.ts` can compare against the
 * same function rather than against a second copy of it, and so a test that
 * checks for drift does not have to write to the working tree to do it. That is
 * the shape `generate-utilities.mjs` already takes beside this.
 *
 * Run by hand, and by `pnpm build` before tsdown:
 *
 *     node scripts/generate-commands.mjs
 */

import { liftRouteInfo, printRouteInfo } from '../src/build/index.ts';
import { writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'src', 'route-info.ts');

const { problems, routeInfo } = liftRouteInfo(join(root, 'src', 'commands'));

writeFileSync(out, printRouteInfo(routeInfo));

// reported rather than fatal, because a description that could not be read is a
// command that lists without one -- which is where a routed tree started
if (problems.length > 0) {
	process.stderr.write(
		`Could not lift every description:\n  ${problems.map((p) => relative(root, p)).join('\n  ')}\n`
	);
}

process.stdout.write(
	`Wrote ${Object.keys(routeInfo).length} route descriptions to ${relative(root, out)}\n`
);
