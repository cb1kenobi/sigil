import { nameProblem, scaffold, type ScaffoldOptions } from '../src/scaffold/index.js';
import { spawnSync } from 'node:child_process';
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

/**
 * `sigil new`.
 *
 * The templates are checked here; whether a scaffolded app actually installs,
 * runs, checks and builds is `demos`-shaped work that needs a network and a
 * package manager, so it is done by hand rather than in the suite. What *is*
 * checked is every claim the templates make that can be read without running
 * them -- and the two that bit during development, which were both silent.
 */

const cli = resolve(dirname(fileURLToPath(import.meta.url)), '../src/sigil.ts');

const OPTIONS: ScaffoldOptions = {
	dependency: '0.0.1',
	language: 'ts',
	layout: 'multi',
	linter: 'oxlint',
	name: 'demo',
	toolchain: '0.0.1',
	versions: { '@types/node': '26.6.2', typescript: '7.0.2' },
};

/** The scaffold as a map, for asking about one file. */
function files(overrides: Partial<ScaffoldOptions> = {}): Map<string, string> {
	return new Map(scaffold({ ...OPTIONS, ...overrides }).map((file) => [file.path, file.contents]));
}

/** One file's parsed JSON. */
function json(path: string, overrides: Partial<ScaffoldOptions> = {}): Record<string, never> {
	return JSON.parse(files(overrides).get(path) as string) as Record<string, never>;
}

describe('an app name', () => {
	it.each([
		['', 'A name is required'],
		['.hidden', 'dot or an underscore'],
		['_private', 'dot or an underscore'],
		['@acme/thing', 'scoped'],
		['MyCli', 'lowercase'],
		['my cli', 'lowercase letters'],
	])('should refuse %s', (name, because) => {
		expect(nameProblem(name)).toContain(because);
	});

	it.each(['my-cli', 'mycli', 'my.cli', 'my_cli', 'cli2'])('should take %s', (name) => {
		expect(nameProblem(name)).toBeUndefined();
	});
});

describe('the scaffold', () => {
	it('should name every tool its scripts run', () => {
		// the defect this is here for, and it was silent: the linter's version was
		// read off a manifest that did not have it, `JSON.stringify` dropped the
		// undefined, and the app got a `lint` script for a tool nothing installed
		for (const linter of ['oxlint', 'eslint', 'biome'] as const) {
			const manifest = json('package.json', { linter });
			const scripts = manifest.scripts as Record<string, string>;
			const deps = manifest.devDependencies as Record<string, string>;

			const tool = scripts.lint?.split(' ')[0] as string;
			const named = Object.keys(deps).some((dep) => dep.includes(tool.replace('biome', 'biome')));

			expect(named, `${linter}: nothing in devDependencies provides "${tool}"`).toBe(true);
			for (const [dep, spec] of Object.entries(deps)) {
				expect(spec, `${linter}: ${dep} has no version`).toBeTruthy();
			}
		}
	});

	it('should write no lint script when there is no linter', () => {
		const manifest = json('package.json', { linter: 'none' });
		expect((manifest.scripts as Record<string, string>).lint).toBeUndefined();
		expect(files({ linter: 'none' }).has('.oxlintrc.json')).toBe(false);
	});

	it('should write the linter config the manifest implies', () => {
		expect(files({ linter: 'oxlint' }).has('.oxlintrc.json')).toBe(true);
		expect(files({ linter: 'eslint' }).has('eslint.config.js')).toBe(true);
		expect(files({ linter: 'biome' }).has('biome.json')).toBe(true);
	});

	it('should set lib and types, which an ejected component needs', () => {
		// not boilerplate: lib.dom declares setInterval(): number, which shadows
		// node's NodeJS.Timeout and makes an ejected spinner fail to compile with
		// `Property 'unref' does not exist on type 'number'`
		const options = json('tsconfig.json').compilerOptions as unknown as Record<string, string[]>;
		expect(options.lib).toStrictEqual(['esnext']);
		expect(options.types).toStrictEqual(['node']);
	});

	it('should write no tsconfig for a JavaScript app', () => {
		expect(files({ language: 'js' }).has('tsconfig.json')).toBe(false);
		expect(files({ language: 'js' }).has('src/index.js')).toBe(true);
		expect(files({ language: 'js' }).has('dev.js')).toBe(true);
	});

	it('should say what a relative path in the schema is relative to', () => {
		// the other silent one: without `baseDir` the build resolves './commands'
		// against the entry and the runtime resolves it against the working
		// directory, so the app builds and then cannot start
		const entry = files().get('src/index.ts') as string;
		expect(entry).toContain('baseDir: import.meta.dirname');
		expect(entry).toContain("commands: './commands'");
	});

	it('should not need a baseDir for a single-command app', () => {
		const entry = files({ layout: 'single' }).get('src/index.ts') as string;
		expect(entry).not.toContain('commands:');
		expect(entry).toContain('run(');
	});

	it('should keep the dev runner out of the entry names discovery looks for', () => {
		// `src/cli` is one of them, so a dev runner called that would be a second
		// entry candidate sitting beside the real one
		const paths = [...files().keys()];
		expect(paths).toContain('dev.ts');
		expect(paths).not.toContain('src/cli.ts');
	});

	it('should write a sigil.json so add does not have to guess', () => {
		expect(json('sigil.json')).toStrictEqual({ components: 'src/components' });
	});
});

describe('the command, end to end', () => {
	let dir: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), 'sigil-new-'));
	});

	afterEach(() => {
		rmSync(dir, { force: true, recursive: true });
	});

	/** Spawned through `process.execPath`, since a shebang starts nothing on Windows. */
	function run(...argv: string[]) {
		return spawnSync(process.execPath, [cli, ...argv], { cwd: dir, encoding: 'utf-8' });
	}

	it('should create an app', () => {
		const result = run('new', 'demo', '--yes', '--no-install', '--no-git');
		expect(result.status).toBe(0);
		expect(existsSync(join(dir, 'demo', 'package.json'))).toBe(true);
		expect(existsSync(join(dir, 'demo', 'src', 'index.ts'))).toBe(true);
		expect(existsSync(join(dir, 'demo', 'src', 'commands', 'hello.ts'))).toBe(true);
	});

	it('should name its argument for what it is', () => {
		// it is the project's name *and* its directory, and calling it `name`
		// read as though a path would do -- which it will not, because the name
		// is validated as an npm package name
		expect(run('new', '--help').stdout).toContain('[project-name]');
	});

	it('should create it somewhere else when told to', () => {
		const result = run('new', 'demo', '--cwd', 'apps', '--yes', '--no-install', '--no-git');
		expect(result.status).toBe(0);
		expect(existsSync(join(dir, 'apps', 'demo', 'package.json'))).toBe(true);
	});

	it('should say where it put it, and give a cd that works', () => {
		// the file listing used to be the only thing naming the destination, and
		// `cd <name>` was wrong the moment --cwd sent the project somewhere else
		const result = run('new', 'demo', '--cwd', 'apps', '--yes', '--no-install', '--no-git');

		// both paths are printed through `displayPath`, so they are forward-slashed
		// on every platform -- `join` here would be backslashed on Windows
		expect(result.stdout).toContain(join(dir, 'apps', 'demo').replaceAll('\\', '/'));
		expect(result.stdout).toContain('cd apps/demo');
	});

	/**
	 * A directory holding a fake executable per name, and nothing else.
	 *
	 * The whole question is which package managers are on `PATH`, so the test
	 * has to own `PATH` -- asking the machine would make the answer depend on
	 * what happens to be installed on it, which is different on every developer's
	 * laptop and on each of CI's nine combinations.
	 */
	function withManagers(...names: string[]): string {
		const bin = join(dir, 'bin');
		// emptied first, or a second call in one case inherits the first's
		// executables and is answering a question nobody asked
		rmSync(bin, { force: true, recursive: true });
		mkdirSync(bin, { recursive: true });
		for (const name of names) {
			// a `.cmd` on Windows, where an extensionless file is not a program
			// and `which` is right to say so
			const file = join(bin, `${name}${process.platform === 'win32' ? '.cmd' : ''}`);
			writeFileSync(file, '#!/bin/sh\nexit 0\n');
			chmodSync(file, 0o755);
		}
		return bin;
	}

	/**
	 * The environment, with `PATH` replaced rather than joined by a second key.
	 *
	 * Windows env names are case-insensitive and `process.env` there holds
	 * `Path`, so spreading it and adding `PATH` hands the child both -- and which
	 * one wins is nothing to rely on.
	 */
	function envWithPath(path: string): NodeJS.ProcessEnv {
		const env = { ...process.env };
		for (const key of Object.keys(env)) {
			if (key.toLowerCase() === 'path') {
				delete env[key];
			}
		}
		return { ...env, PATH: path };
	}

	/** Scaffolds with only `names` installed, and answers which manager it chose. */
	function managerFor(...names: string[]): string | undefined {
		const result = spawnSync(
			process.execPath,
			[cli, 'new', 'demo', '--yes', '--no-install', '--no-git'],
			{ cwd: dir, encoding: 'utf-8', env: envWithPath(withManagers(...names)) }
		);
		return /^\s*(\S+) run dev/m.exec(result.stdout)?.[1];
	}

	it('should use the only package manager that is installed', () => {
		expect(managerFor('npm')).toBe('npm');
		rmSync(join(dir, 'demo'), { force: true, recursive: true });
		expect(managerFor('vlt')).toBe('vlt');
		rmSync(join(dir, 'demo'), { force: true, recursive: true });
		expect(managerFor('pnpm')).toBe('pnpm');
	});

	it('should prefer pnpm when there is a choice', () => {
		expect(managerFor('pnpm', 'vlt', 'npm')).toBe('pnpm');
	});

	it('should fall back to npm when pnpm is not one of them', () => {
		expect(managerFor('vlt', 'npm')).toBe('npm');
	});

	it('should say npm when it can find none of them', () => {
		// npm ships with node, so an empty answer is a PATH this cannot see
		// rather than a machine with no package manager on it
		expect(managerFor()).toBe('npm');
	});

	it('should take --pm over what is installed', () => {
		const result = spawnSync(
			process.execPath,
			[cli, 'new', 'demo', '--pm', 'vlt', '--yes', '--no-install', '--no-git'],
			{ cwd: dir, encoding: 'utf-8', env: envWithPath(withManagers('pnpm', 'npm')) }
		);
		expect(result.stdout).toContain('vlt run dev');
	});

	it('should refuse a --pm it does not know', () => {
		const result = run('new', 'demo', '--pm', 'yarn', '--yes', '--no-install', '--no-git');
		expect(result.status).not.toBe(0);
		expect(result.stderr).toContain('yarn');
	});

	it('should take an absolute --cwd', () => {
		const target = join(dir, 'absolute');
		run('new', 'demo', '--cwd', target, '--yes', '--no-install', '--no-git');
		expect(existsSync(join(target, 'demo', 'package.json'))).toBe(true);
	});

	it('should make a --cwd that is not there yet', () => {
		// the scaffold makes each file's directory as it goes, so naming somewhere
		// new is `mkdir -p` rather than an error
		run('new', 'demo', '--cwd', 'a/b/c', '--yes', '--no-install', '--no-git');
		expect(existsSync(join(dir, 'a', 'b', 'c', 'demo', 'package.json'))).toBe(true);
	});

	it('should expand a ~ the shell did not eat', () => {
		// `--cwd "~/projects"` is quoted, so the tilde reaches the process -- and
		// `resolve()` alone would make a directory *called* `~`, which is the
		// failure paths.ts already records.
		//
		// Home is pointed at the temp directory so this never writes to a real
		// one, and it takes *both* variables: `expand()` goes through
		// `os.homedir()`, which reads `HOME` on POSIX and `USERPROFILE` on
		// Windows. Setting only the first passes everywhere it was written and
		// scaffolds into the actual profile directory on the one platform it was
		// not.
		const home = join(dir, 'fake-home');
		const result = spawnSync(
			process.execPath,
			[cli, 'new', 'demo', '--cwd', '~/projects', '--yes', '--no-install', '--no-git'],
			{
				cwd: dir,
				encoding: 'utf-8',
				env: { ...process.env, HOME: home, USERPROFILE: home },
			}
		);

		expect(result.status).toBe(0);
		expect(existsSync(join(home, 'projects', 'demo', 'package.json'))).toBe(true);
		expect(existsSync(join(dir, '~'))).toBe(false);
	});

	it('should still refuse a path as the name', () => {
		// saying where and saying what it is called are two questions, and this is
		// the half that stays a package name
		const result = run('new', 'sub/dir/app', '--yes', '--no-install', '--no-git');
		expect(result.status).not.toBe(0);
		expect(result.stderr).toContain('lowercase letters');
	});

	it('should refuse a directory with something already in it', () => {
		run('new', 'demo', '--yes', '--no-install', '--no-git');
		const again = run('new', 'demo', '--yes', '--no-install', '--no-git');
		expect(again.status).not.toBe(0);
		expect(again.stderr).toContain('not empty');
	});

	it('should refuse a name it cannot use', () => {
		const result = run('new', 'My-CLI', '--yes', '--no-install', '--no-git');
		expect(result.status).not.toBe(0);
		expect(result.stderr).toContain('lowercase');
	});

	it('should link both packages, not just the runtime', () => {
		// linking only `@ttylabs/sigil` left the app depending on an unpublished
		// `@ttylabs/cli`, so the install died on a 404 having got everything else
		// right
		run('new', 'demo', '--yes', '--no-install', '--no-git', '--link');
		const manifest = JSON.parse(readFileSync(join(dir, 'demo', 'package.json'), 'utf-8')) as Record<
			string,
			Record<string, string>
		>;

		expect(manifest.dependencies?.['@ttylabs/sigil']).toMatch(/^file:/);
		expect(manifest.devDependencies?.['@ttylabs/cli']).toMatch(/^file:/);
	});

	it('should ask for published versions when not linking', () => {
		run('new', 'demo', '--yes', '--no-install', '--no-git');
		const manifest = JSON.parse(readFileSync(join(dir, 'demo', 'package.json'), 'utf-8')) as Record<
			string,
			Record<string, string>
		>;

		expect(manifest.dependencies?.['@ttylabs/sigil']).not.toMatch(/^file:/);
	});
});
