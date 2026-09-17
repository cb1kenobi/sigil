import config from '../tsdown.config.js';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf-8'));

// `entry` is typed as string | string[] | Record<string, string>; the config
// uses the record form so the output file names are ours to pick
const entry = config.entry as Record<string, string>;

// './error-handler' -> 'error-handler', '.' -> 'index'
function entryName(subpath: string) {
	return subpath === '.' ? 'index' : subpath.slice(2);
}

describe('package exports', () => {
	it('should not expose the source tree through a wildcard', () => {
		for (const subpath of Object.keys(pkg.exports)) {
			expect(subpath).not.toContain('*');
		}
	});

	it('should point every subpath at a file the build produces', () => {
		for (const [subpath, condition] of Object.entries<any>(pkg.exports)) {
			if (subpath === './package.json') {
				continue;
			}

			const name = entryName(subpath);
			expect(entry, `"${subpath}" has no build entry`).toHaveProperty(name);
			expect(existsSync(resolve(root, entry[name]))).toBe(true);

			expect(condition).toEqual({
				types: `./dist/${name}.d.mts`,
				default: `./dist/${name}.mjs`,
			});
		}
	});

	it('should export every entry the build produces', () => {
		const exported = Object.keys(pkg.exports).map(entryName);
		for (const name of Object.keys(entry)) {
			expect(exported, `entry "${name}" is not exported`).toContain(name);
		}
	});

	it('should have main and types agree with the root export', () => {
		expect(pkg.main).toBe(pkg.exports['.'].default);
		expect(pkg.types).toBe(pkg.exports['.'].types);
	});

	it('should copy the update worker next to the updates entry', () => {
		// updates/index.ts reads the worker off disk relative to its own module
		// URL, so it has to ship alongside dist/updates.mjs
		const copy = config.copy as { from: string }[];
		const from = copy.map((c) => c.from);
		expect(from).toContain('./src/updates/get-version-worker.js');
		for (const file of from) {
			expect(existsSync(resolve(root, file))).toBe(true);
		}
	});
});
