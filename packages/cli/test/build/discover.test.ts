import { discoverApp, readAppCommands, resolveSpecifier } from '../../src/build/discover.js';
import { resolveCommandTree } from '../../src/build/tree.js';
import type { ResolvedCommand } from '../../src/build/tree.js';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';

const __dirname = dirname(fileURLToPath(import.meta.url));
const apps = resolve(__dirname, '../fixtures/discover');
const repo = resolve(__dirname, '../../../..');

/** The command of a name, for reading one entry at a time. */
function at(commands: readonly ResolvedCommand[], name: string): ResolvedCommand {
	const found = commands.find((command) => command.name === name);
	if (!found) {
		throw new Error(`no "${name}" in [${commands.map((c) => c.name).join(', ')}]`);
	}
	return found;
}

/**
 * Finding the app, which is step one of the pipeline and the one that decides
 * whether anything else has something to work on.
 *
 * "Run it from the app root and it works out the rest" is the whole of what
 * makes a toolchain feel like one, and every shortcut in it is a guess -- so
 * the guesses are pinned here, and the entry it picked is reported rather than
 * assumed.
 */
describe('discovering an app', () => {
	it('should read the one executable the manifest publishes', () => {
		// what the built file should be called, and a better answer than the
		// package name: a scoped package's name is not its executable's
		const app = discoverApp(join(repo, 'packages', 'cli'));
		expect(app.manifest.bin).toBe('sigil');
		expect(app.manifest.name).toBe('@ttylabs/cli');
	});

	it('should say nothing when a manifest publishes several', () => {
		// a single-bundle build has no answer for more than one, so it leaves the
		// question to --name rather than picking one by key order
		const dir = mkdtempSync(join(tmpdir(), 'sigil-bin-'));
		try {
			mkdirSync(join(dir, 'src'), { recursive: true });
			writeFileSync(
				join(dir, 'package.json'),
				JSON.stringify({
					bin: { one: './dist/one.mjs', two: './dist/two.mjs' },
					dependencies: { '@ttylabs/sigil': '*' },
					name: 'two-bins',
				})
			);
			writeFileSync(join(dir, 'src', 'index.js'), 'export default { commands: {} };\n');

			expect(discoverApp(dir).manifest.bin).toBeUndefined();
		} finally {
			rmSync(dir, { force: true, recursive: true });
		}
	});

	it('should find the root and the entry', () => {
		const app = discoverApp(join(apps, 'router-app'));

		expect(app.root).toBe(join(apps, 'router-app'));
		expect(app.entry).toBe(join(apps, 'router-app', 'src', 'index.ts'));
		expect(app.manifest.name).toBe('router-app');
	});

	it('should take the runtime from any kind of dependency', () => {
		// which one an app declares is a packaging decision, and none of them
		// makes it less of a sigil app
		expect(() => discoverApp(join(apps, 'inline-app'))).not.toThrow();
	});

	it('should refuse a directory that does not depend on the runtime', () => {
		// every error after this one would be a worse version of the same message
		expect(() => discoverApp(join(apps, 'not-an-app'))).toThrow(
			/does not depend on @ttylabs\/sigil/
		);
	});

	it('should refuse a directory with no manifest at all', () => {
		expect(() => discoverApp(join(apps, 'router-app', 'src'))).toThrow(/No package\.json in/);
	});

	it('should say what it looked for when there is no entry', () => {
		expect(() => discoverApp(join(apps, 'no-entry'))).toThrow(/Looked for .*--entry/s);
	});

	it('should prefer source over what the manifest names', () => {
		// a published CLI points its `bin` at built output, so following it means
		// parsing a minified bundle whose specifiers are chunk names a bundler
		// invented -- `check` reads what the author edits
		const app = discoverApp(join(apps, 'built-app'));

		expect(app.entry).toBe(join(apps, 'built-app', 'src', 'index.ts'));
		expect(app.entry).not.toContain('dist');
	});

	it('should take an entry the caller names', () => {
		const app = discoverApp(join(apps, 'built-app'), { entry: 'dist/cli.mjs' });
		expect(app.entry).toBe(join(apps, 'built-app', 'dist', 'cli.mjs'));
	});

	it('should refuse an entry the caller names that is not there', () => {
		expect(() => discoverApp(join(apps, 'built-app'), { entry: 'nope.ts' })).toThrow(
			/Entry module not found/
		);
	});

	it('should find this very toolchain, which is the acceptance test', () => {
		// a framework whose toolchain is not written in it has not been tested by
		// anyone who had to live with it
		const app = discoverApp(join(repo, 'packages', 'cli'));

		expect(app.manifest.name).toBe('@ttylabs/cli');
		expect(app.entry).toBe(join(repo, 'packages', 'cli', 'src', 'index.ts'));
	});
});

describe("reading where an app's commands are", () => {
	it('should read a path as a directory for the router to walk', () => {
		const app = discoverApp(join(apps, 'router-app'));
		const { commands } = readAppCommands(app);

		expect(commands?.kind).toBe('directory');
		expect(commands).toMatchObject({ dir: join(apps, 'router-app', 'src', 'commands') });
	});

	it('should resolve that path against the entry, not the working directory', () => {
		const app = discoverApp(join(apps, 'router-app'));
		const { commands } = readAppCommands(app);

		// the entry is `src/index.ts`, so `./commands` is `src/commands`
		expect(commands).toMatchObject({ dir: join(app.entry, '..', 'commands') });
	});

	describe('a schema that writes its commands out', () => {
		it('should read each one', () => {
			const app = discoverApp(join(apps, 'inline-app'));
			const { commands } = readAppCommands(app);

			expect(commands?.kind).toBe('inline');
			expect(commands?.kind === 'inline' ? commands.commands.map((c) => c.name) : []).toStrictEqual(
				['build', 'db', 'inline', 'missing']
			);
		});

		it('should follow a load() to the module beside it', () => {
			// the `.js` to `.ts` fallback is the convention this repo follows
			// itself: a TypeScript ES module imports its neighbour as `./build.js`
			// while the file on disk is `build.ts`
			const app = discoverApp(join(apps, 'inline-app'));
			const { commands } = readAppCommands(app);
			const list = commands?.kind === 'inline' ? commands.commands : [];

			expect(at(list, 'build').module).toBe(
				join(apps, 'inline-app', 'src', 'commands', 'build.ts')
			);
		});

		it("should let the placeholder's description win over the module's", () => {
			// what the placeholder declares is what help shows before the module
			// loads, which is the runtime's merge read from the other side
			const app = discoverApp(join(apps, 'inline-app'));
			const { commands } = readAppCommands(app);
			const list = commands?.kind === 'inline' ? commands.commands : [];

			expect(at(list, 'build').desc).toBe('build it');
		});

		it("should fall back to the module's description when the placeholder has none", () => {
			const app = discoverApp(join(apps, 'inline-app'));
			const { commands } = readAppCommands(app);
			const list = commands?.kind === 'inline' ? commands.commands : [];
			const db = at(list, 'db');

			expect(at(db.commands, 'migrate').desc).toBe('migrate the database');
		});

		it('should nest a subcommand under its parent', () => {
			const app = discoverApp(join(apps, 'inline-app'));
			const { commands } = readAppCommands(app);
			const list = commands?.kind === 'inline' ? commands.commands : [];

			expect(at(list, 'db').commands.map((c) => c.name)).toStrictEqual(['migrate']);
		});

		it('should take a command declared with no module at all', () => {
			const app = discoverApp(join(apps, 'inline-app'));
			const { commands } = readAppCommands(app);
			const list = commands?.kind === 'inline' ? commands.commands : [];

			expect(at(list, 'inline').module).toBeUndefined();
			expect(at(list, 'inline').desc).toBe('declared here, no module');
		});

		it('should report a module that does not resolve as an error', () => {
			// a command whose module is not there is an app that fails when that
			// command is run, which the build has no business shipping
			const app = discoverApp(join(apps, 'inline-app'));
			const { diagnostics } = readAppCommands(app);
			const missing = diagnostics.find((d) => d.message.includes('nope.js'));

			expect(missing?.severity).toBe('error');
			expect(missing?.message).toContain('"missing"');
		});

		it("should read this toolchain's own schema as a routed directory", () => {
			// the toolchain routes its own commands off the filesystem, so the build
			// reading it has to see a directory rather than a written-out list --
			// which is the dogfooding working: what it finds here is what it would
			// find in any app SIG-74 describes
			const app = discoverApp(join(repo, 'packages', 'cli'));
			const { commands } = readAppCommands(app);

			expect(commands?.kind).toBe('directory');
			expect(commands?.kind === 'directory' && commands.dir).toBe(
				join(repo, 'packages', 'cli', 'src', 'commands')
			);
		});

		it("should resolve this toolchain's own tree, descriptions and all", () => {
			// the descriptions live in the modules now, so this is the static lift
			// reading the code its own conventions produce -- which it could not do
			// until it learned to follow `export default cmd` to the const it names
			const app = discoverApp(join(repo, 'packages', 'cli'));
			const { commands } = readAppCommands(app);
			const dir = commands?.kind === 'directory' ? commands.dir : '';
			const { commands: list } = resolveCommandTree(dir);

			expect(list.map((c) => c.name)).toStrictEqual(['add', 'build', 'check', 'new']);
			expect(at(list, 'check').desc).toBe('Check an app without building it');
			expect(at(list, 'build').desc).toBe('Build an app into a bundle that depends on nothing');
			expect(at(list, 'check').module).toBe(
				join(repo, 'packages', 'cli', 'src', 'commands', 'check.ts')
			);
		});

		it('should say nothing about a module it cannot read when the placeholder describes it', () => {
			// every diagnostic the fact lift produces is about what help would show
			// before the module loads, and a placeholder `desc` is exactly that
			// answer -- so `export default check` being a reference is not a
			// problem anybody has
			const app = discoverApp(join(repo, 'packages', 'cli'));
			const { diagnostics } = readAppCommands(app);

			expect(diagnostics.filter((d) => d.severity === 'warning')).toStrictEqual([]);
		});
	});
});

describe('resolving an import specifier', () => {
	const from = join(apps, 'inline-app', 'src');

	it('should swap a .js specifier for the .ts beside it', () => {
		expect(resolveSpecifier(from, './commands/build.js')).toBe(join(from, 'commands', 'build.ts'));
	});

	it('should take an extensionless specifier', () => {
		expect(resolveSpecifier(from, './commands/build')).toBe(join(from, 'commands', 'build.ts'));
	});

	it('should answer undefined for a module that is not there', () => {
		expect(resolveSpecifier(from, './commands/nope.js')).toBeUndefined();
	});

	it('should ignore a bare specifier, which is a package', () => {
		// a package's commands are its own business
		expect(resolveSpecifier(from, '@ttylabs/sigil')).toBeUndefined();
	});
});
