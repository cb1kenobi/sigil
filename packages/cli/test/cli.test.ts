import { run, schema, version } from '../src/index.js';
import config from '../tsdown.config.js';
import { readRoutes } from '@ttylabs/sigil/routes';
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf-8'));

/**
 * Captures whatever is written to the real stdout. `run()` writes through the
 * framework, so there is no stream to inject.
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

describe('@ttylabs/cli', () => {
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
			expect(schema().name).toBe('sigil');
			expect(Object.keys(pkg.bin)).toEqual(['sigil']);
		});

		it('should name its version rather than declaring the flag', () => {
			// the framework adds `-v, --version` and answers it, the way it adds
			// `--help` -- which is what keeps the built CLI and the source one the
			// same program, since `sigil build` calls `main()` itself and whatever
			// a bin wrapped around it is not in the bundle
			// it declares no root options at all now: `-v, --version` was the only
			// one, and the framework owns both the flag and the answer
			expect(schema().options).toBeUndefined();
			expect(typeof schema().version).toBe('function');
			expect((schema().version as () => string)()).toBe(pkg.version);
		});

		it('should route its commands off its own filesystem', () => {
			// the toolchain is the acceptance test, so it uses the router it ships
			// rather than a map written out beside it. `baseDir` is what makes the
			// path mean this directory instead of wherever the user was standing
			expect(schema().commands).toBe('./commands');
			expect(schema().baseDir).toBeTypeOf('string');
		});

		it('should route only commands that are the whole of what they claim', () => {
			// a command that exists and refuses is worse than one that does not
			// exist yet, because only the second is honest in --help. All four are
			// complete: `add` copies, `check` reads, `build` bundles and runs
			// `check`'s pass rather than replacing it, and `new` scaffolds.
			const dir = join(root, 'src', 'commands');
			const names = (readRoutes(dir)?.routes ?? []).map((route) => route.name).sort();

			expect(names).toEqual(['add', 'build', 'check', 'new']);
		});

		it('should keep the shared pass out of the command list', () => {
			// `_inspect.ts` is one pass for two commands and is not a command; the
			// `_` prefix is what says so, and this is that rule read from inside
			// the repo that wrote it
			const dir = join(root, 'src', 'commands');
			const names = (readRoutes(dir)?.routes ?? []).map((route) => route.name);

			expect(existsSync(join(dir, '_inspect.ts'))).toBe(true);
			expect(names).not.toContain('_inspect');
		});
	});

	describe('--version', () => {
		// it has no use for the command tree, and since the toolchain started
		// routing its own commands it was paying to build one
		it('should answer without reading the command directory', () => {
			const result = spawnSync(process.execPath, [join(root, 'src', 'sigil.ts'), '--version'], {
				cwd: root,
				encoding: 'utf-8',
				env: { ...process.env, DEBUG: 'sigil*' },
			});

			expect(result.stdout.trim()).toBe(version());
			expect(result.stderr).not.toContain('Walking command directory');
		});

		it('should leave every other spelling to the parser', async () => {
			// the fast path is the whole of argv rather than the flag appearing in
			// it, because each of these is a question with a second half that the
			// parser already answers -- and a scan here that reproduced them would
			// be a second parser to keep in agreement
			for (const argv of [
				['--help', '--version'],
				['--version', '--help'],
				['help', '--version'],
			]) {
				const out = captureStdout();
				try {
					await run(argv);
				} finally {
					out.restore();
				}
				expect(out.text, argv.join(' ')).toContain('Usage: sigil');
			}
		});

		it('should refuse an argument beside it rather than answering', () => {
			// spawned, because this one is rendered by the framework's error
			// handler on its way to stderr rather than written by `run()`
			const result = spawnSync(
				process.execPath,
				[join(root, 'src', 'sigil.ts'), '--version', 'extra'],
				{ cwd: root, encoding: 'utf-8' }
			);

			expect(result.stderr).toContain('extra');
			expect(result.stdout).not.toContain(version());
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
			expect(out.text).toContain('sigil');
			expect(out.text).toContain('--version');
		});

		it('should not print the version when it was not asked for', async () => {
			const out = captureStdout();
			try {
				await run([]);
			} finally {
				out.restore();
			}
			expect(out.text).not.toContain(pkg.version);
		});

		it('should print help when no command was named', async () => {
			// a CLI that is all subcommands has nothing to do without one, and
			// printing nothing at all tells the reader neither what went wrong nor
			// what is available
			const out = captureStdout();
			try {
				await run([]);
			} finally {
				out.restore();
			}

			expect(out.text).toContain('Usage: sigil');
			expect(out.text).toContain('check');
		});

		it('should print the same screen --help prints', async () => {
			// the two spellings of one question, and a second screen built another
			// way is a second thing to keep in agreement
			const bare = captureStdout();
			try {
				await run([]);
			} finally {
				bare.restore();
			}

			const asked = captureStdout();
			try {
				await run(['--help']);
			} finally {
				asked.restore();
			}

			expect(bare.text).toBe(asked.text);
		});

		it('should leave the exit code alone when it prints help for no command', async () => {
			// being asked what the program does and answering is not a failure
			const out = captureStdout();
			try {
				await run([]);
			} finally {
				out.restore();
			}
			expect(process.exitCode).toBeFalsy();
		});

		it('should answer --version rather than printing help', async () => {
			const out = captureStdout();
			try {
				await run(['--version']);
			} finally {
				out.restore();
			}

			expect(out.text.trim()).toBe(pkg.version);
			expect(out.text).not.toContain('Usage:');
		});

		it('should not print help when a command ran quietly', async () => {
			// `main()` hands back the state for a command whose `run` returned
			// nothing, so "nothing was named" and "something ran quietly" are told
			// apart by the command rather than by the return value
			const out = captureStdout();
			const err = vi
				.spyOn(process.stderr, 'write')
				.mockImplementation((() => true) as typeof process.stderr.write);
			try {
				await run(['check', resolve(root, 'test/fixtures/app')]);
			} finally {
				out.restore();
				err.mockRestore();
			}

			expect(out.text).not.toContain('Usage: sigil');
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
			// `deps.neverBundle` rather than `external`, which tsdown deprecated;
			// the claim is unchanged, which is why this asserts the behaviour a
			// line below rather than only the spelling
			expect(pkg.dependencies).toHaveProperty('@ttylabs/sigil', 'workspace:*');
			expect(config.deps?.neverBundle).toContain('@ttylabs/sigil');
			expect(config).not.toHaveProperty('external');
		});

		it('should declare every dependency it has taken, and no more', () => {
			// the toolchain is a devDependency of an app rather than part of what
			// the app ships, so it may depend on whatever it needs -- a bundler, a
			// parser -- and what it *produces* still depends on nothing. That
			// licence is exactly what must not leak back into `@ttylabs/sigil`,
			// whose zero-dependency manifest is asserted by its own suite.
			//
			// Written out rather than counted, so that taking a new one is an edit
			// somebody makes on purpose and can be asked about in review.
			expect(Object.keys(pkg.dependencies).sort()).toEqual([
				'@ttylabs/sigil',
				'oxc-parser',
				'rolldown',
			]);
		});
	});

	/**
	 * Every dependency is pinned to an exact version, in every manifest in the
	 * workspace.
	 *
	 * A caret means a fresh install and a six-month-old lockfile can resolve to
	 * different trees, and for a native binary -- rolldown and oxc-parser both --
	 * that is a different binary on somebody's machine with nothing in the diff
	 * to point at. The lockfile pins the resolution; this pins what the manifest
	 * *asks* for, which is what a range widens the moment anybody reinstalls
	 * without one.
	 *
	 * Asserted rather than left to `.npmrc`, because `save-exact` is only seen by
	 * whoever ran `pnpm add` -- a caret written by hand, or by a tool that does
	 * not read it, arrives with nothing to stop it.
	 */
	describe('pinned dependencies', () => {
		const manifests = [
			'package.json',
			'packages/sigil/package.json',
			'packages/cli/package.json',
			'website/package.json',
		].map((path) => ({
			json: JSON.parse(readFileSync(resolve(root, '../..', path), 'utf-8')) as Record<
				string,
				Record<string, string> | undefined
			>,
			path,
		}));

		it('should find every manifest it means to check', () => {
			// a path that stopped resolving would pass this suite by checking
			// nothing, which is the failure mode a list of paths has
			expect(manifests).toHaveLength(4);
			for (const { json, path } of manifests) {
				expect(json.name, `${path} has no name`).toBeDefined();
			}
		});

		it('should pin every dependency and devDependency exactly', () => {
			const ranged: string[] = [];

			for (const { json, path } of manifests) {
				for (const field of ['dependencies', 'devDependencies'] as const) {
					for (const [name, spec] of Object.entries(json[field] ?? {})) {
						// a workspace link is not a version range; it resolves to the
						// package in this repo whatever anybody publishes
						if (spec.startsWith('workspace:')) {
							continue;
						}
						if (!/^\d+\.\d+\.\d+(?:-[\w.]+)?$/.test(spec)) {
							ranged.push(`${path}: ${field}.${name} = ${spec}`);
						}
					}
				}
			}

			expect(ranged).toStrictEqual([]);
		});

		it('should leave a peer dependency as a range, because that is what one is', () => {
			// a peer declares what the toolchain *accepts* from the app rather than
			// what it installs, so pinning it would refuse an app on any other
			// TypeScript -- which is the opposite of the point
			expect(pkg.peerDependencies).toHaveProperty('typescript');
			expect(pkg.peerDependencies.typescript).toMatch(/^>=/);
		});

		it('should tell pnpm to keep writing exact versions', () => {
			const npmrc = readFileSync(resolve(root, '../../.npmrc'), 'utf-8');
			expect(npmrc).toMatch(/^save-exact=true$/m);
		});
	});

	describe('the fixtures', () => {
		const fixtures = resolve(root, 'test/fixtures');

		/** Every file under `test/fixtures`, relative to the repository root. */
		const files = (function walk(dir: string): string[] {
			return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
				const path = join(dir, entry.name);
				return entry.isDirectory() ? walk(path) : [path];
			});
		})(fixtures);

		/**
		 * The ones git refuses to track.
		 *
		 * `check-ignore` exits 1 when it matched nothing, which is the good case
		 * here rather than a failure to run.
		 */
		const ignored = (() => {
			const result = spawnSync('git', ['check-ignore', '--stdin'], {
				cwd: resolve(root, '../..'),
				encoding: 'utf-8',
				input: files.join('\n'),
			});
			return result.stdout
				.split('\n')
				.filter(Boolean)
				.map((path) => path.replaceAll('\\', '/'));
		})();

		it('should find the fixtures it means to check', () => {
			// a walk that stopped finding anything would pass the test below by
			// checking nothing, which is the failure mode a directory scan has
			expect(files.length).toBeGreaterThan(20);
		});

		it('should track every fixture that is an input', () => {
			// `dist` and `node_modules` in the root .gitignore are unanchored, so
			// they match at any depth -- including a fixture whose whole point is
			// to be called one of them. `discover/built-app/dist/cli.mjs` was
			// caught by that: absent from a clone, present for whoever generated
			// it once, so the suite was green locally and red in CI with an error
			// that named the discovery code rather than the missing file.
			//
			// What may legitimately be ignored is output a test writes, and the
			// two places that happens say so with a `.gitignore` of their own or
			// sit under a `node_modules` this repo never commits into.
			const unexpected = ignored.filter(
				(path) => !path.includes('/out/') && !path.includes('/node_modules/')
			);
			expect(unexpected).toStrictEqual([]);
		});

		it('should track the built-app fixture in particular', () => {
			// the one that actually broke, named so that a future change to the
			// negation above fails on the case rather than on the rule
			expect(existsSync(join(fixtures, 'discover/built-app/dist/cli.mjs'))).toBe(true);
			expect(ignored.some((path) => path.includes('built-app/dist'))).toBe(false);
		});
	});

	describe('the root build filter', () => {
		// `pnpm test` and `pnpm coverage` build the packages before vitest runs,
		// because `the built bin` above reads `dist/`. The filter that picks those
		// packages is the one thing between a green suite and four failures whose
		// message points at the wrong cause.
		const rootPkg = JSON.parse(readFileSync(resolve(root, '../../package.json'), 'utf-8')) as {
			scripts: Record<string, string>;
		};

		const filtered = ['test', 'coverage'];

		it('should not quote an argument the way only a POSIX shell understands', () => {
			// pnpm runs a script through `cmd.exe` on Windows, which does not strip
			// single quotes -- so `--filter='./packages/*'` arrived at turbo with the
			// quotes still on, matched no package, and *exited zero*. The build was
			// skipped in silence and vitest then failed on a missing `dist/`, on
			// Windows only, on every branch at once.
			for (const [name, script] of Object.entries(rootPkg.scripts)) {
				expect(script, `the "${name}" script`).not.toContain("'");
			}
		});

		it('should name every package it has to build', () => {
			// read off the workspace rather than repeated here: a third package under
			// `packages/` must join the build or fail this test. It cannot go missing
			// quietly, which is what a glob allows -- turbo exits 0 when a *name
			// glob* matches nothing, and only an exact name that does not resolve
			// fails loudly. That is why these are spelled out.
			const packages = readdirSync(resolve(root, '..'), { withFileTypes: true })
				.filter((entry) => entry.isDirectory())
				.map(
					(entry) =>
						(
							JSON.parse(
								readFileSync(resolve(root, '..', entry.name, 'package.json'), 'utf-8')
							) as { name: string }
						).name
				);

			expect(packages.length).toBeGreaterThan(1);

			for (const script of filtered) {
				for (const name of packages) {
					expect(rootPkg.scripts[script], `the "${script}" script`).toContain(`--filter=${name}`);
				}
			}
		});

		it('should build before it tests, and stop if the build fails', () => {
			for (const script of filtered) {
				expect(rootPkg.scripts[script]).toMatch(/^turbo run build .*&& vitest/);
			}
		});
	});

	describe('the built bin', () => {
		// these read `dist/`, which the root `pnpm test` builds first. Asserting
		// against `src/` instead would be worse than no test: the shebang and the
		// bundling are things only the *build* can get wrong, so a check that
		// never opens the build output cannot fail for the reason it exists.
		const bin = resolve(root, 'dist/sigil.mjs');

		function built(): string {
			if (!existsSync(bin)) {
				throw new Error(
					`${bin} is missing -- run \`pnpm build\` before these tests, or the root ` +
						`build filter matched no packages (see "the root build filter" below)`
				);
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
			// `sigil` is a real dependency, and inlining it would ship a second copy
			// of the framework to anyone who also depends on it directly. The import
			// lands in whichever chunk tsdown puts the entry's code in, so this asks
			// the build as a whole rather than guessing at a file
			const chunks = readdirSync(dirname(bin))
				.filter((name) => name.endsWith('.mjs'))
				.map((name) => readFileSync(resolve(dirname(bin), name), 'utf-8'));

			expect(chunks.some((chunk) => /from\s*["']@ttylabs\/sigil["']/.test(chunk))).toBe(true);
		});

		it('should answer --version when run as a real process', () => {
			const result = spawnSync(process.execPath, [bin, '--version'], { encoding: 'utf-8' });
			expect(result.status).toBe(0);
			expect(result.stdout.trim()).toBe(pkg.version);
		});

		it('should answer --help when run as a real process', () => {
			const result = spawnSync(process.execPath, [bin, '--help'], { encoding: 'utf-8' });
			expect(result.status).toBe(0);
			expect(result.stdout).toContain('sigil');
			expect(result.stdout).toContain('--version');
		});

		it('should fail loudly on an argument it does not understand', () => {
			const result = spawnSync(process.execPath, [bin, 'nonsense'], { encoding: 'utf-8' });
			expect(result.status).not.toBe(0);
			expect(result.stderr).not.toBe('');
		});
	});
});
