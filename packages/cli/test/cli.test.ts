import { run, schema, version } from '../src/index.js';
import config from '../tsdown.config.js';
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf-8'));

/**
 * Captures whatever is written to the real stdout, the way `main2.test.ts`
 * captures stderr. `run()` writes through the framework, so there is no stream
 * to inject.
 */
function captureStdout() {
	const chunks: string[] = [];
	const spy = vi.spyOn(process.stdout, 'write').mockImplementation(((
		chunk: string | Uint8Array
	) => {
		chunks.push(chunk.toString());
		return true;
	}) as typeof process.stdout.write);

	return {
		restore: () => spy.mockRestore(),
		get text() {
			return chunks.join('');
		},
	};
}

describe('@main2/cli', () => {
	let exitCode: typeof process.exitCode;

	beforeEach(() => {
		exitCode = process.exitCode;
	});

	afterEach(() => {
		// a leaked exit code would fail the entire test run
		process.exitCode = exitCode;
		vi.restoreAllMocks();
	});

	describe('version()', () => {
		it('should report the version from its own manifest', () => {
			expect(version()).toBe(pkg.version);
		});
	});

	describe('schema()', () => {
		it('should name the program after the bin', () => {
			expect(schema().name).toBe('main2');
			expect(Object.keys(pkg.bin)).toEqual(['main2']);
		});

		it('should declare --version', () => {
			expect(schema().options).toHaveProperty('-v, --version');
		});

		it('should declare no commands until there are commands to declare', () => {
			// a command that exists and refuses is worse than one that does not
			// exist yet, because only the second is honest in --help
			expect(schema().commands).toEqual({});
		});
	});

	describe('run()', () => {
		it('should print the version for --version', async () => {
			const out = captureStdout();
			try {
				await run(['--version']);
			} finally {
				out.restore();
			}
			expect(out.text.trim()).toBe(pkg.version);
		});

		it('should print help for --help', async () => {
			const out = captureStdout();
			try {
				await run(['--help']);
			} finally {
				out.restore();
			}
			expect(out.text).toContain('main2');
			expect(out.text).toContain('--version');
		});

		it('should not print the version when it was not asked for', async () => {
			const out = captureStdout();
			try {
				await run([]);
			} finally {
				out.restore();
			}
			expect(out.text).toBe('');
		});
	});

	describe('package wiring', () => {
		it('should build an entry for every exported subpath', () => {
			const entry = config.entry as Record<string, string>;
			for (const [subpath, condition] of Object.entries<any>(pkg.exports)) {
				if (subpath === './package.json') {
					continue;
				}
				const name = subpath === '.' ? 'index' : subpath.slice(2);
				expect(entry, `"${subpath}" has no build entry`).toHaveProperty(name);
				expect(existsSync(resolve(root, entry[name]))).toBe(true);
				expect(condition).toEqual({
					types: `./dist/${name}.d.mts`,
					default: `./dist/${name}.mjs`,
				});
			}
		});

		it('should build an entry for the bin', () => {
			const entry = config.entry as Record<string, string>;
			for (const target of Object.values<string>(pkg.bin)) {
				const name = target.replace(/^\.\/dist\//, '').replace(/\.mjs$/, '');
				expect(entry, `bin "${target}" has no build entry`).toHaveProperty(name);
			}
		});

		it('should depend on the runtime rather than bundling it', () => {
			expect(pkg.dependencies).toEqual({ main2: 'workspace:*' });
			expect(config.external).toContain('main2');
		});
	});

	describe('the built bin', () => {
		// these read `dist/`, which the root `pnpm test` builds first. Asserting
		// against `src/` instead would be worse than no test: the shebang and the
		// bundling are things only the *build* can get wrong, so a check that
		// never opens the build output cannot fail for the reason it exists.
		const bin = resolve(root, 'dist/main2.mjs');

		function built(): string {
			if (!existsSync(bin)) {
				throw new Error(`${bin} is missing -- run \`pnpm build\` before these tests`);
			}
			return readFileSync(bin, 'utf-8');
		}

		it('should lead with a shebang', () => {
			// without it the published bin is not executable by a shell, and nothing
			// else in the build would notice
			expect(built().startsWith('#!/usr/bin/env node')).toBe(true);
		});

		// NTFS has no execute bit and npm does not rely on one there -- it writes
		// a `.cmd` shim instead -- so the question only means something on POSIX
		it.skipIf(process.platform === 'win32')('should be executable', () => {
			// npm preserves the mode it was packed with, so a bin that lost its
			// executable bit here is a bin nobody can run after installing
			expect(statSync(bin).mode & 0o111).not.toBe(0);
		});

		it('should leave the runtime as an import rather than inlining it', () => {
			// `main2` is a real dependency, and inlining it would ship a second copy
			// of the framework to anyone who also depends on it directly. The import
			// lands in whichever chunk tsdown puts the entry's code in, so this asks
			// the build as a whole rather than guessing at a file
			const chunks = readdirSync(dirname(bin))
				.filter((name) => name.endsWith('.mjs'))
				.map((name) => readFileSync(resolve(dirname(bin), name), 'utf-8'));

			expect(chunks.some((chunk) => /from\s*["']main2["']/.test(chunk))).toBe(true);
		});

		it('should answer --version when run as a real process', () => {
			const result = spawnSync(process.execPath, [bin, '--version'], { encoding: 'utf-8' });
			expect(result.status).toBe(0);
			expect(result.stdout.trim()).toBe(pkg.version);
		});

		it('should answer --help when run as a real process', () => {
			const result = spawnSync(process.execPath, [bin, '--help'], { encoding: 'utf-8' });
			expect(result.status).toBe(0);
			expect(result.stdout).toContain('main2');
			expect(result.stdout).toContain('--version');
		});

		it('should fail loudly on an argument it does not understand', () => {
			const result = spawnSync(process.execPath, [bin, 'nonsense'], { encoding: 'utf-8' });
			expect(result.status).not.toBe(0);
			expect(result.stderr).not.toBe('');
		});
	});
});
