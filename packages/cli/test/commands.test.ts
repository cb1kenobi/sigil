import { liftRouteInfo, printRouteInfo } from '../src/build/index.js';
import { ROUTE_INFO } from '../src/route-info.js';
import { readRoutes } from '@ttylabs/sigil/routes';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The toolchain routing its own commands.
 *
 * `src/commands/` is the source of truth and `src/route-info.ts` is a cache
 * over it, so everything here is about the two not coming apart -- and about
 * the published package still having files for the walk to find, which is the
 * half that passes from source and fails once installed.
 */

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const commandsDir = join(root, 'src', 'commands');

/** The routes the framework's own reader finds, which is what the CLI will walk. */
function routes(): string[] {
	return (readRoutes(commandsDir)?.routes ?? []).map((route) => route.name).sort();
}

describe('the committed route info', () => {
	it('should be what the lift produces today', () => {
		// the same drift check the utility sheet carries, and for the same reason:
		// this file is committed so `node src/sigil.ts` works on a fresh clone
		// with no build, which is exactly what lets it go quietly stale.
		//
		// Compared in memory rather than by running the generator, because a test
		// that regenerates writes to the working tree to find out whether it
		// needed to -- and then the answer is always no.
		const { problems, routeInfo } = liftRouteInfo(commandsDir);

		expect(problems).toStrictEqual([]);
		expect(routeInfo).toStrictEqual(ROUTE_INFO);
	});

	it('should be spelled the way the committed file spells it', () => {
		// the printed form as well as the value, since what is committed is
		// source: a printer that stopped matching the formatter would leave every
		// regeneration dirtying the tree
		const { routeInfo } = liftRouteInfo(commandsDir);

		expect(printRouteInfo(routeInfo)).toBe(
			readFileSync(join(root, 'src', 'route-info.ts'), 'utf-8')
		);
	});

	it('should describe every command the filesystem has', () => {
		// a route with no entry still works and simply lists without a
		// description, so this is not a correctness guard -- it is the guard
		// against somebody adding a command and nobody noticing help got worse
		expect(Object.keys(ROUTE_INFO).sort()).toStrictEqual(routes());
	});

	it('should say what each module says', () => {
		// the lift is a snapshot of the module, and the two disagreeing is how
		// `--help` comes to describe a command differently before and after it is
		// loaded
		for (const [name, info] of Object.entries(ROUTE_INFO)) {
			const source = readFileSync(join(commandsDir, `${name}.ts`), 'utf-8');
			expect(source, `${name} lost the desc the lift recorded`).toContain(`desc: '${info.desc}'`);
		}
	});

	it('should not describe the shared pass, which is not a command', () => {
		expect(existsSync(join(commandsDir, '_inspect.ts'))).toBe(true);
		expect(ROUTE_INFO).not.toHaveProperty('_inspect');
	});
});

describe('the built package', () => {
	const dist = join(root, 'dist');

	it.runIf(existsSync(dist))('should ship a directory for the walk to read', () => {
		// bundled into hashed chunks there is no `dist/commands/` at all, and the
		// published bin fails with `Unsupported command module` -- which passes
		// every test that runs from source
		for (const name of routes()) {
			expect(existsSync(join(dist, 'commands', `${name}.mjs`)), `dist/commands/${name}.mjs`).toBe(
				true
			);
		}
	});

	it.runIf(existsSync(dist))('should name every command in help without importing one', () => {
		// the whole point of the lift: the descriptions are on screen and the
		// four command modules, a native parser and a scaffold are not loaded
		const result = spawnSync(process.execPath, [join(dist, 'sigil.mjs'), '--help'], {
			encoding: 'utf-8',
		});

		expect(result.status).toBe(0);
		for (const [name, info] of Object.entries(ROUTE_INFO)) {
			expect(result.stdout).toContain(name);
			expect(result.stdout).toContain(info.desc);
		}
	});
});
