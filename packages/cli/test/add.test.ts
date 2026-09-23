import {
	CONFIG_FILE,
	DEFAULT_REGISTRY,
	findAppRoot,
	loadRegistry,
	parseSpec,
	planAdd,
	readConfig,
	type Registry,
} from '../src/registry/index.js';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

/**
 * `sigil add`, over a throwaway app.
 *
 * The app is real -- a manifest and a `node_modules/@ttylabs/sigil` symlinked
 * at the built package -- because everything worth checking here is about
 * resolution: a registry is found in the *app's* dependencies rather than the
 * toolchain's, and a fixture that stubbed that out would be checking the stub.
 * It needs a build, like everything else in this package.
 */

const sigil = resolve(dirname(fileURLToPath(import.meta.url)), '../../sigil');

let root: string;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), 'sigil-add-'));
	writeFileSync(
		join(root, 'package.json'),
		JSON.stringify({ dependencies: { '@ttylabs/sigil': '*' }, name: 'app', type: 'module' })
	);
	mkdirSync(join(root, 'node_modules', '@ttylabs'), { recursive: true });
	symlinkSync(sigil, join(root, 'node_modules', '@ttylabs', 'sigil'), 'dir');
});

afterEach(() => {
	rmSync(root, { force: true, recursive: true });
});

/** The default registry, as the app resolves it. */
function registry(): Registry {
	return loadRegistry(root, DEFAULT_REGISTRY);
}

describe('a registry spec', () => {
	it('should read a bare name as the default registry', () => {
		expect(parseSpec('spinner')).toStrictEqual({ entry: 'spinner', pkg: DEFAULT_REGISTRY });
	});

	it('should take two segments for a scoped package', () => {
		// `@acme/components` is a package and `components/date-picker` is not, so
		// this counts rather than splitting on the last slash
		expect(parseSpec('@acme/components/date-picker')).toStrictEqual({
			entry: 'date-picker',
			pkg: '@acme/components',
		});
	});

	it('should take one segment for an unscoped package', () => {
		expect(parseSpec('acme/date-picker')).toStrictEqual({
			entry: 'date-picker',
			pkg: 'acme',
		});
	});

	it('should refuse a package with no entry in it', () => {
		expect(() => parseSpec('@acme/components')).toThrow(/names a package but no entry/);
	});
});

describe('finding the app', () => {
	it('should find the nearest manifest above the directory', () => {
		const deep = join(root, 'src', 'commands');
		mkdirSync(deep, { recursive: true });
		expect(findAppRoot(deep)).toBe(resolve(root));
	});

	it('should not run off the top of the filesystem', () => {
		// `dirname('/')` is `'/'`, so a walk that relies on finding something is
		// one that never ends
		expect(() => findAppRoot('/')).toThrow(/No package.json/);
	});
});

describe('where components land', () => {
	it('should follow the app into src/ when there is one', () => {
		mkdirSync(join(root, 'src'));
		expect(readConfig(root)).toStrictEqual({
			components: join('src', 'components'),
			declared: false,
		});
	});

	it('should sit at the root when there is no src/', () => {
		expect(readConfig(root)).toStrictEqual({ components: 'components', declared: false });
	});

	it('should say when it was told rather than guessing', () => {
		// the plan prints which it was, because a guess nobody can see is the kind
		// that costs an afternoon -- and this one writes files
		writeFileSync(join(root, CONFIG_FILE), JSON.stringify({ components: 'src/ui' }));
		expect(readConfig(root)).toStrictEqual({ components: 'src/ui', declared: true });
	});

	it('should refuse an absolute directory', () => {
		writeFileSync(join(root, CONFIG_FILE), JSON.stringify({ components: '/etc' }));
		expect(() => readConfig(root)).toThrow(/must be relative/);
	});

	it('should refuse an empty one', () => {
		writeFileSync(join(root, CONFIG_FILE), JSON.stringify({ components: '' }));
		expect(() => readConfig(root)).toThrow(/non-empty/);
	});
});

describe('loading a registry', () => {
	it('should find one in the app rather than in the toolchain', () => {
		// the property the whole design rests on: an ejected component matches the
		// runtime the app has pinned, which is only true if it came from there
		const found = registry();
		expect(found.pkg).toBe(DEFAULT_REGISTRY);
		expect(Object.keys(found.manifest.entries)).toContain('spinner');
	});

	it('should say so when the package is not installed', () => {
		expect(() => loadRegistry(root, '@acme/nope')).toThrow(/is not installed/);
	});

	it('should say so when a package ships no registry', () => {
		// an ordinary dependency that is not a registry: the message has to tell
		// those apart, because "not installed" would send somebody to npm
		const pkg = join(root, 'node_modules', 'plain');
		mkdirSync(pkg, { recursive: true });
		writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name: 'plain', version: '1.0.0' }));
		expect(() => loadRegistry(root, 'plain')).toThrow(/ships no registry/);
	});
});

describe('planning an add', () => {
	it('should write nothing', () => {
		// the plan is shown before anything happens, and that is only honest if
		// working it out has no effect
		const target = join(root, 'components');
		planAdd(registry(), ['spinner'], target, root);
		expect(() => readConfig(root)).not.toThrow();
		expect(existsSync(join(target, 'spinner.ts'))).toBe(false);
	});

	it('should name the files it would write, relative to the app', () => {
		const plan = planAdd(registry(), ['spinner'], join(root, 'src', 'components'), root);
		expect(plan.entries).toStrictEqual(['spinner']);
		expect(plan.files.map((file) => file.shown)).toStrictEqual(['src/components/spinner.ts']);
		expect(plan.files[0]?.exists).toBe(false);
	});

	it('should report an entry the registry does not have', () => {
		const plan = planAdd(registry(), ['sparkline'], join(root, 'components'), root);
		expect(plan.missing).toStrictEqual(['sparkline']);
		expect(plan.files).toStrictEqual([]);
	});

	it('should notice a file that is already there', () => {
		const target = join(root, 'components');
		mkdirSync(target, { recursive: true });
		writeFileSync(join(target, 'spinner.ts'), '// mine');

		const plan = planAdd(registry(), ['spinner'], target, root);
		expect(plan.files[0]?.exists).toBe(true);
	});

	it('should ask for each entry once however many times it is named', () => {
		const plan = planAdd(registry(), ['spinner', 'spinner'], join(root, 'components'), root);
		expect(plan.entries).toStrictEqual(['spinner']);
		expect(plan.files).toHaveLength(1);
	});

	it('should pull a dependency in and say that it did', () => {
		// no seed entry has one, so this builds a registry that does: the
		// machinery ships exercised by nothing in this repo otherwise, and a
		// shape that only describes the easy case is one somebody discovers to be
		// wrong
		const fake: Registry = {
			dir: join(sigil, 'registry'),
			manifest: {
				entries: {
					base: {
						classes: ['sigil-table'],
						desc: 'base',
						files: [{ from: 'table.ts', to: 'base.ts' }],
						imports: [],
						registryDeps: [],
					},
					leaf: {
						classes: ['sigil-spinner'],
						desc: 'leaf',
						files: [{ from: 'spinner.ts', to: 'leaf.ts' }],
						imports: [],
						registryDeps: ['base'],
					},
				},
				name: 'fake',
				version: '0.0.0',
			},
			pkg: 'fake',
		};

		const plan = planAdd(fake, ['leaf'], join(root, 'components'), root);

		// the dependency first, so a file is never written before what it imports
		expect(plan.entries).toStrictEqual(['base', 'leaf']);
		expect(plan.pulled).toStrictEqual(['base']);
		expect(plan.files.map((file) => file.shown)).toStrictEqual([
			'components/base.ts',
			'components/leaf.ts',
		]);
	});

	it('should refuse a registry that names a dependency it does not have', () => {
		const broken: Registry = {
			dir: join(sigil, 'registry'),
			manifest: {
				entries: {
					leaf: {
						classes: [],
						desc: 'leaf',
						files: [{ from: 'spinner.ts', to: 'leaf.ts' }],
						imports: [],
						registryDeps: ['gone'],
					},
				},
				name: 'broken',
				version: '0.0.0',
			},
			pkg: 'broken',
		};

		// reported as the registry's bug rather than as a missing entry: the user
		// never typed "gone", so telling them it is not available would be
		// blaming them for it
		expect(() => planAdd(broken, ['leaf'], join(root, 'components'), root)).toThrow(
			/bug in the registry/
		);
	});
});

describe('the command, end to end', () => {
	const cli = resolve(dirname(fileURLToPath(import.meta.url)), '../src/sigil.ts');

	/**
	 * Runs the toolchain against the throwaway app.
	 *
	 * Through `process.execPath` rather than by executing the file: a shebang is
	 * not how anything starts on Windows, which is the rule the build already
	 * follows for `tsc` and which its own bundle test had to learn.
	 */
	function run(...argv: string[]) {
		return spawnSync(process.execPath, [cli, ...argv], { cwd: root, encoding: 'utf-8' });
	}

	it('should list what the registry has when given nothing', () => {
		const result = run('add');
		expect(result.status).toBe(0);
		expect(result.stdout).toContain('spinner');
		expect(result.stdout).toContain('table');
		// the ladder, printed where somebody is deciding whether to eject at all
		expect(result.stdout).toContain('restyled with an');
	});

	it('should copy a component in', () => {
		const result = run('add', 'spinner', '--yes');
		expect(result.status).toBe(0);
		expect(existsSync(join(root, 'components', 'spinner.ts'))).toBe(true);
	});

	it('should say where it decided to put things', () => {
		// a guess nobody can see is the kind that costs an afternoon, and this one
		// writes files
		expect(run('add', 'spinner', '--yes').stdout).toContain(`no ${CONFIG_FILE}`);
	});

	it('should name the classes rather than only the files', () => {
		// ejecting is the last resort, so the thing that would have avoided it is
		// printed at the moment of ejecting
		expect(run('add', 'spinner', '--yes').stdout).toContain('.sigil-spinner-frame');
	});

	it('should refuse to overwrite without being told to', () => {
		expect(run('add', 'spinner', '--yes').status).toBe(0);

		const again = run('add', 'spinner', '--yes');
		expect(again.status).not.toBe(0);
		expect(again.stderr).toContain('--force');
	});

	it('should overwrite when it is told to', () => {
		run('add', 'spinner', '--yes');
		const forced = run('add', 'spinner', '--yes', '--force');
		expect(forced.status).toBe(0);
		expect(forced.stdout).toContain('overwrites');
	});

	it('should name what the registry does have when asked for something it does not', () => {
		const result = run('add', 'sparkline', '--yes');
		expect(result.status).not.toBe(0);
		expect(result.stderr).toContain('spinner');
	});

	it('should refuse two registries in one call', () => {
		// two `registryDeps` namespaces in one plan, where a dep resolving in one
		// and not the other is a failure nobody could read
		const result = run('add', 'spinner', '@acme/x/y', '--yes');
		expect(result.status).not.toBe(0);
		expect(result.stderr).toContain('One registry at a time');
	});

	it('should copy something that then runs', () => {
		// the claim the whole ticket rests on: what lands is a working component,
		// not a file that merely looks like one
		run('add', 'spinner', '--yes');
		writeFileSync(
			join(root, 'go.ts'),
			[
				"import { createSpinner } from './components/spinner.ts';",
				"const s = createSpinner({ text: 'ejected' });",
				's.start();',
				"s.succeed('it runs');",
			].join('\n')
		);

		const ran = spawnSync(process.execPath, [join(root, 'go.ts')], {
			cwd: root,
			encoding: 'utf-8',
		});

		expect(ran.status).toBe(0);
		expect(ran.stdout).toContain('it runs');
	});
});
