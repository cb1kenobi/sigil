import { bundleApp } from '../../src/build/bundle.js';
import { discoverApp, readAppCommands } from '../../src/build/discover.js';
import { parseModule } from '../../src/build/parse-module.js';
import { resolveCommandTree } from '../../src/build/tree.js';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, it, expect } from 'vitest';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = resolve(__dirname, '../fixtures/buildable');

let out: string;
let bin: string;
let chunks: readonly { entry: boolean; name: string; size: number }[];

/**
 * Every module specifier the bundle imports, static and dynamic.
 *
 * Read off the parser's own module record rather than matched with a regex.
 * The naive pattern found `Error(\`...command name from "${e}"\`)` -- the word
 * "from" inside a message, followed by a quoted template -- and a test that
 * reports a dependency an app does not have is worse than no test.
 */
function bundleSpecifiers(): string[] {
	const found: string[] = [];

	const walk = (dir: string) => {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			const path = join(dir, entry.name);

			if (entry.isDirectory()) {
				walk(path);
				continue;
			}
			if (!path.endsWith('.mjs')) {
				continue;
			}

			const source = readFileSync(path, 'utf-8');
			const parsed = parseModule(path, source);

			for (const imported of parsed.module.staticImports) {
				found.push(imported.moduleRequest.value);
			}
			for (const exported of parsed.module.staticExports) {
				for (const entry_ of exported.entries) {
					if (entry_.moduleRequest) {
						found.push(entry_.moduleRequest.value);
					}
				}
			}
			for (const dynamic of parsed.module.dynamicImports) {
				// a dynamic import's request is a span rather than a value, because it
				// need not be a literal at all -- and a computed one is not a
				// dependency, it is code choosing a module at run time. Only a literal
				// can name a package the app would have to have installed
				const request = source.slice(dynamic.moduleRequest.start, dynamic.moduleRequest.end);
				if (/^["']/.test(request)) {
					found.push(request);
				}
			}
		}
	};

	walk(out);
	return found.map((specifier) => specifier.replace(/^["'`]|["'`]$/g, ''));
}

/** Runs the built executable. */
function run(...argv: string[]) {
	// `cwd` somewhere unrelated on purpose: a built app must not depend on where
	// it is run from, and the fixture's own directory would hide it if it did
	return spawnSync(bin, argv, { cwd: tmpdir(), encoding: 'utf-8' });
}

/**
 * `sigil build`: one process in, zero dependencies out.
 *
 * The claim the whole ticket rests on, and the only place it can be asserted is
 * against a bundle that was actually written and actually run. Everything above
 * this reads source or prints it; this spawns the result.
 */
describe('bundling an app', () => {
	beforeAll(async () => {
		out = mkdtempSync(join(tmpdir(), 'sigil-build-'));

		const found = discoverApp(app);
		const declared = readAppCommands(found);
		const dir = declared.commands?.kind === 'directory' ? declared.commands.dir : '';
		const tree = resolveCommandTree(dir);

		const result = await bundleApp({ app: found, binName: 'buildable', out, tree });
		bin = result.bin;
		chunks = result.chunks;
	}, 60_000);

	it('should write an executable with the bit set', () => {
		// a shebang without the bit is a file nobody can run
		expect(statSync(bin).mode & 0o111).toBeGreaterThan(0);
		expect(readFileSync(bin, 'utf-8').startsWith('#!/usr/bin/env node')).toBe(true);
	});

	it('should depend on nothing but itself and node', () => {
		// the promise in the ticket's title. Every specifier is either a relative
		// chunk or a node builtin -- a bare one would be a package the built app
		// reaches for at run time, which is the whole thing this exists to avoid
		const bare = bundleSpecifiers().filter(
			(specifier) => !specifier.startsWith('.') && !specifier.startsWith('node:')
		);

		expect(bare).toStrictEqual([]);
	});

	it('should import nothing from outside the output directory', () => {
		// a relative specifier that climbs out of the bundle is the same failure
		// as a bare one wearing a different hat: the app would reach for a file
		// that is not shipped with it
		const escaping = bundleSpecifiers().filter((specifier) => specifier.startsWith('..'));

		expect(escaping).toStrictEqual([]);
	});

	it('should run with no node_modules anywhere near it', () => {
		// the same claim from the other side: it was copied nowhere, but it is run
		// from a directory with no package of any kind above it
		const result = run('--help');

		expect(result.status).toBe(0);
		expect(result.stdout).toContain('Usage: buildable');
	});

	it('should dispatch a command', () => {
		expect(run('greet').stdout.trim()).toBe('hello world');
	});

	it('should dispatch a command with an argument', () => {
		expect(run('greet', 'sigil').stdout.trim()).toBe('hello sigil');
	});

	it('should dispatch a subcommand', () => {
		expect(run('db', 'migrate').stdout.trim()).toBe('migrated');
	});

	it('should have compiled a TypeScript command module', () => {
		// `greet.ts` has type annotations; nothing compiled it before the bundler
		expect(run('greet').status).toBe(0);
	});

	it('should carry the descriptions it baked in', () => {
		// the reason the static lift exists: help that lists commands by name
		// alone is not help, and a built app reads no directories to find out
		const help = run('--help').stdout;

		expect(help).toContain('say hello');
		expect(help).toContain('A fixture app that builds');
	});

	it('should carry the root options the app declared', () => {
		// the generated entry composes the app's schema with the baked tree, so
		// everything the app said other than `commands` survives
		expect(run('--help').stdout).toContain('Say more');
	});

	it('should hide a command it read as hidden', () => {
		const help = run('--help').stdout;

		expect(help).not.toContain('quiet');
		// ...and it still runs, which is what hidden means
		expect(run('quiet').stdout.trim()).toBe('quiet');
	});

	it('should put every command in its own chunk', () => {
		// a literal specifier inside a dynamic import is the one thing a bundler
		// can see, follow and split on -- so the deferral survives bundling rather
		// than being flattened into the entry
		const lazy = chunks.filter((chunk) => !chunk.entry).map((chunk) => chunk.name);

		expect(lazy.some((name) => name.includes('greet'))).toBe(true);
		expect(lazy.some((name) => name.includes('migrate'))).toBe(true);
	});

	it('should keep the entry small, because startup time is the metric', () => {
		// what `--help` pays for is the entry plus what it reaches; the parser and
		// the help renderer are chunks of their own, and no command body is in it
		const entry = chunks.find((chunk) => chunk.entry)!;

		expect(entry.size).toBeLessThan(16 * 1024);
		expect(readFileSync(bin, 'utf-8')).not.toContain('hello ');
	});

	it('should report a non-zero exit code from a command that failed', () => {
		expect(run('nope').status).toBe(1);
	});
});
