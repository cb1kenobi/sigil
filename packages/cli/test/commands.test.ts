import { readRoutes } from '@ttylabs/sigil/routes';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The toolchain routing its own commands.
 *
 * `src/commands/` is the source of truth: adding a command is adding a file,
 * and nothing anywhere writes the list out beside it. What that costs is the
 * descriptions -- a filesystem route keeps its own inside its module -- and
 * what pays for them is `sigil build`, which lifts them statically and bakes
 * them into the tree it generates. So the claims worth pinning are that the
 * routes are what the directory says, and that a built toolchain can name every
 * one of them without importing a single command module to do it.
 */

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const commandsDir = join(root, 'src', 'commands');
const dist = join(root, 'dist');

/** The routes the framework's own reader finds, which is what the CLI walks. */
function routes(): string[] {
	return (readRoutes(commandsDir)?.routes ?? []).map((route) => route.name).sort();
}

describe('the command directory', () => {
	it('should be the four commands and nothing else', () => {
		expect(routes()).toStrictEqual(['add', 'build', 'check', 'new']);
	});

	it('should keep the shared pass out of the routes', () => {
		// `_inspect.ts` is one pass for two commands and is not a command; the
		// `_` prefix is what says so, and this is that rule read from inside the
		// repo that invented it
		expect(existsSync(join(commandsDir, '_inspect.ts'))).toBe(true);
		expect(routes()).not.toContain('_inspect');
	});
});

describe('the built toolchain', () => {
	it.runIf(existsSync(dist))('should name every command in help', () => {
		// the descriptions live in the command modules, and `sigil build` lifts
		// them into the tree it bakes -- so this screen is drawn without loading
		// four command modules, a native parser and a scaffold to do it
		const result = spawnSync(process.execPath, [join(dist, 'sigil.mjs'), '--help'], {
			encoding: 'utf-8',
		});

		expect(result.status).toBe(0);
		for (const name of routes()) {
			expect(result.stdout, name).toContain(name);
		}
		expect(result.stdout).toContain('Copy a component into your app');
		expect(result.stdout).toContain('Build an app into a bundle that depends on nothing');
	});

	it.runIf(existsSync(dist))('should not ship a command directory', () => {
		// it used to, because a runtime walk needs files to find. The baked tree
		// reaches its commands through `load`, so the chunks are the bundler's to
		// name and there is nothing for a walk to read
		expect(existsSync(join(dist, 'commands'))).toBe(false);
	});

	it.runIf(existsSync(dist))('should print a completion script for its own routed tree', () => {
		// the one end-to-end check of the eager load, and it needs a real routed
		// app rather than a fixture: `--external` is declared *inside*
		// `src/commands/build.ts`, which also pulls `oxc-parser` -- a native
		// binding -- in behind it. Nothing lifts an option, so a script naming it
		// is a script that imported the module
		const result = spawnSync(process.execPath, [join(dist, 'sigil.mjs'), 'completion', 'bash'], {
			encoding: 'utf-8',
		});

		expect(result.status, result.stderr).toBe(0);
		expect(result.stdout).toContain("'--external'");
		for (const name of routes()) {
			expect(result.stdout, name).toContain(`'${name}'`);
		}
	});

	it.runIf(existsSync(dist))('should print the same script from source as from the bundle', () => {
		// byte for byte, and both shells, which is sharper than the `--help`
		// comparison below rather than a weaker version of it: the descriptions are
		// what legitimately differ there, and they do not differ *here* because
		// generating a completion script imports every command module itself. So
		// the static lift buys this command nothing and costs it nothing, and
		// `node src/sigil.ts` and `node dist/sigil.mjs` really are one program.
		//
		// It is also what says a generated script parses as the shell it is for:
		// a syntax error would have to be in both.
		const src = resolve(root, 'src', 'sigil.ts');
		const bin = join(dist, 'sigil.mjs');

		for (const shell of ['bash', 'zsh']) {
			const a = spawnSync(process.execPath, [src, 'completion', shell], {
				cwd: root,
				encoding: 'utf-8',
			});
			const b = spawnSync(process.execPath, [bin, 'completion', shell], {
				cwd: root,
				encoding: 'utf-8',
			});

			expect(a.status, `${shell}: ${a.stderr}`).toBe(0);
			expect(b.stdout, shell).toBe(a.stdout);
		}
	});

	it.runIf(existsSync(dist))('should behave the way the source does', () => {
		// the invariant the self-host rests on: `node src/sigil.ts` and
		// `node dist/sigil.mjs` are the same program. `--version` and a bare
		// invocation are where that was false, because both lived in a bin
		// wrapper the build replaces and so were simply absent once built.
		//
		// The descriptions are the one thing that legitimately differs, and it
		// is the lift rather than a divergence: from source they are inside
		// modules nothing has imported, and the built tree has them baked. So
		// this compares what each *does* -- the version, the exit code, the
		// commands offered -- and the test above compares what the built one
		// says.
		const src = resolve(root, 'src', 'sigil.ts');
		const bin = join(dist, 'sigil.mjs');
		const run = (file: string, argv: string[]) =>
			spawnSync(process.execPath, [file, ...argv], { cwd: root, encoding: 'utf-8' });

		expect(run(bin, ['--version']).stdout).toBe(run(src, ['--version']).stdout);

		for (const argv of [[], ['--help']]) {
			const a = run(src, argv);
			const b = run(bin, argv);
			const names = (out: string) =>
				out
					.split('\n')
					.map((line) => line.trim().split(/\s+/)[0])
					.filter((name) => routes().includes(name ?? ''));

			expect(b.status, argv.join(' ') || '(no arguments)').toBe(a.status);
			expect(names(b.stdout), argv.join(' ') || '(no arguments)').toStrictEqual(names(a.stdout));
		}
	});
});
