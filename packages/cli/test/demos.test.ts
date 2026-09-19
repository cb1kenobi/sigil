import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The demos import `@ttylabs/sigil` by name, so they go through the package's
 * `exports` map and read `dist/` -- which is the one part of the surface no
 * other test covers. Nothing type-checks them, and a named import of an export
 * that no longer exists is not a lint error: it is a `SyntaxError` at the point
 * somebody runs the file, which is after it shipped.
 *
 * `06-ansi-and-wrap.js` went on importing `padCell()` for a whole pull request
 * after the component rewrite deleted it, and the suite was green the entire
 * time. This is the cheap half of the answer -- every named import a demo
 * makes has to be something the built package actually exports -- and it is
 * static, so it costs a read rather than 28 spawned processes.
 */

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const demos = resolve(root, 'demos');

/** Every `.js` under `demos/`, including the command modules in subdirectories. */
function scripts(dir: string): string[] {
	const found: string[] = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) {
			found.push(...scripts(path));
		} else if (entry.name.endsWith('.js')) {
			found.push(path);
		}
	}
	return found.sort();
}

interface DemoImport {
	names: string[];
	specifier: string;
}

/**
 * The static imports a demo makes from `@ttylabs/sigil`. Only the named ones
 * carry a promise this test can check; a namespace or default import merely
 * has to resolve, which importing the module proves on its own.
 */
function imports(source: string): DemoImport[] {
	const found: DemoImport[] = [];
	const re = /import\s+([^'"]*?)\s*from\s*'(@ttylabs\/sigil(?:\/[^']+)?)'/g;
	for (const match of source.matchAll(re)) {
		const clause = match[1] ?? '';
		const braces = /\{([^}]*)\}/.exec(clause);
		const names = braces
			? braces[1]
					.split(',')
					.map((part) => part.trim())
					.filter(Boolean)
					// `a as b` is a promise about `a`, which is the exported name
					.map((part) => part.split(/\s+as\s+/)[0]!.trim())
			: [];
		found.push({ names, specifier: match[2]! });
	}
	return found;
}

describe('the demos', () => {
	const files = scripts(demos);

	it('should have been found', () => {
		// a glob that matches nothing passes every assertion below it
		expect(files.length).toBeGreaterThan(20);
	});

	for (const file of files) {
		const name = relative(root, file);
		const declared = imports(readFileSync(file, 'utf-8'));
		if (declared.length === 0) {
			continue;
		}

		it(`should import what ${name} says it does`, async () => {
			for (const { names, specifier } of declared) {
				const module = (await import(specifier)) as Record<string, unknown>;
				for (const exported of names) {
					expect(Object.hasOwn(module, exported), `${specifier} exports ${exported}`).toBe(true);
				}
			}
		});
	}
});
