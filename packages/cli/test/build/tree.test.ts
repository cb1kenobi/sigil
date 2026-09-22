import { generateCommands, specifier } from '../../src/build/generate.js';
import { resolveCommandTree, walkTree, type ResolvedCommand } from '../../src/build/tree.js';
import { Internal, main, type AnyCommand, type ParseState } from '@ttylabs/sigil';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve as resolvePath } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, it, expect } from 'vitest';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = resolvePath(__dirname, '../fixtures/app');
const commandsDir = join(app, 'commands');

/** The command at a path through the tree, for reading one entry at a time. */
function at(commands: readonly ResolvedCommand[], ...path: string[]): ResolvedCommand {
	let here = commands;
	let found: ResolvedCommand | undefined;

	for (const name of path) {
		found = here.find((command) => command.name === name);
		if (!found) {
			throw new Error(`no "${name}" in [${here.map((c) => c.name).join(', ')}]`);
		}
		here = found.commands;
	}

	return found!;
}

/**
 * Resolving a `commands/` tree ahead of time, which is what a built app
 * carries instead of a directory to walk.
 *
 * The two claims this rests on are that the shape matches what the runtime
 * would have walked -- asserted here against a real parse of the same
 * directory -- and that a description the runtime could only learn by importing
 * a module is baked in. Everything else is printing.
 */
describe('resolving a command tree', () => {
	it('should resolve the whole tree in one pass', () => {
		const { commands } = resolveCommandTree(commandsDir);

		expect(commands.map((command) => command.name)).to.deep.equal([
			'build',
			'computed',
			'config',
			'db',
			'deploy',
			'lint',
			'routes-pkg',
			'secret',
		]);
	});

	it('should agree with what the runtime walks', async () => {
		// the whole reason the route rules live in `@ttylabs/sigil/routes`: an app
		// that routed differently bundled and unbundled is the one divergence a
		// user cannot debug, so the two walks are asserted against each other
		// rather than each against its own expectation
		const { commands } = resolveCommandTree(commandsDir, { facts: false });
		const state = (await main({
			argv: [],
			schema: { commands: commandsDir, help: false },
		})) as ParseState;
		const runtime = [...state.contexts[0]![Internal].commands.keys()];

		// the root level, which is where every route rule bites: the `.` and `_`
		// prefixes, the `index` that is not a command of its own, the package that
		// renames itself, and two routes claiming one name. Deeper levels go
		// through the identical `readRoutes()` call, and that they route is what
		// the end-to-end tests below assert by dispatching through them
		expect(commands.map((command) => command.name).sort()).to.deep.equal(runtime.sort());
	});

	it('should bake a description the runtime could only get by importing', () => {
		const { commands } = resolveCommandTree(commandsDir);

		expect(at(commands, 'build').desc).to.equal('build the app');
		expect(at(commands, 'lint').desc).to.equal('lint everything');
		expect(at(commands, 'db', 'migrate', 'up').desc).to.equal('migrate up');
	});

	it('should bake a hidden flag, which has the same problem', () => {
		const { commands } = resolveCommandTree(commandsDir);
		expect(at(commands, 'secret').hidden).to.equal(true);
		expect(at(commands, 'build').hidden).to.equal(undefined);
	});

	it("should read a subdirectory's index module as that subdirectory's command", () => {
		const { commands } = resolveCommandTree(commandsDir);
		const config = at(commands, 'config');

		expect(config.desc).to.equal('configure the app');
		expect(config.module).to.equal(join(commandsDir, 'config', 'index.js'));
		expect(config.commands.map((c) => c.name)).to.deep.equal(['set']);
	});

	it('should leave a namespace with no module rather than inventing one', () => {
		// `db/` has no index, so it matches, lists what is under it, and has
		// nothing to run -- which is the runtime's rule, kept
		const { commands } = resolveCommandTree(commandsDir);
		const db = at(commands, 'db');

		expect(db.module).to.equal(undefined);
		expect(db.desc).to.equal(undefined);
		expect(db.commands.map((c) => c.name)).to.deep.equal(['migrate']);
	});

	it('should recurse as deep as the tree goes', () => {
		const { commands } = resolveCommandTree(commandsDir);
		expect(at(commands, 'db', 'migrate').commands.map((c) => c.name)).to.deep.equal(['down', 'up']);
	});

	it('should describe a package from its manifest rather than its module', () => {
		// a package describes itself in its `package.json`, which is the
		// description the runtime uses -- reading its entry module would mean
		// reading somebody's compiled output to answer a question already answered
		const { commands } = resolveCommandTree(commandsDir);
		const pkg = at(commands, 'routes-pkg');

		expect(pkg.kind).to.equal('package');
		expect(pkg.desc).to.equal('a package that names itself');
	});

	it('should keep an underscore-prefixed entry out of the tree', () => {
		const { commands } = resolveCommandTree(commandsDir);
		const names = commands.map((command) => command.name);

		expect(names).to.not.contain('_helpers');
		expect(names).to.not.contain('_shared');
	});

	it('should report a description it cannot read, with the file it is in', () => {
		const { diagnostics } = resolveCommandTree(commandsDir);

		expect(diagnostics).to.have.lengthOf(1);
		expect(diagnostics[0]!.file).to.equal(join(commandsDir, 'computed.js'));
		expect(diagnostics[0]!.severity).to.equal('warning');
		expect(diagnostics[0]!.message).to.contain('"desc" is computed');
	});

	it('should read no modules at all when facts are off', () => {
		const { commands, diagnostics } = resolveCommandTree(commandsDir, { facts: false });

		expect(diagnostics).to.deep.equal([]);
		expect(at(commands, 'build').desc).to.equal(undefined);
		// the shape is still the shape
		expect(at(commands, 'db', 'migrate', 'up').name).to.equal('up');
	});

	it('should refuse a directory that is itself a package', async () => {
		// the runtime asks `readPackage()` first for an unnamed path, so such a
		// directory is *one* command rather than a directory of them -- and a
		// `commands/` carrying a `"type": "module"` manifest, which is how a
		// package forces ESM on a directory, is one. Walking its routes instead
		// emitted a whole tree where the runtime emits a single command, which is
		// the divergence everything here exists to prevent
		const root = join(__dirname, '../fixtures/pkg-root/commands');

		expect(() => resolveCommandTree(root)).to.throw(/makes it a package/);

		// ...and this is what it would have diverged from: one command, named by
		// the package, with the modules beside it not being commands at all
		const state = (await main({
			argv: [],
			schema: { commands: root, help: false },
		})) as ParseState;
		expect([...state.contexts[0]![Internal].commands.keys()]).to.deep.equal(['everything']);
		expect(await main({ argv: ['everything'], schema: { commands: root, help: false } })).to.equal(
			'one'
		);
	});

	it('should throw on a directory that is not there', () => {
		expect(() => resolveCommandTree(join(app, 'nope'))).to.throw(/Command directory not found/);
	});

	it('should walk parents before children', () => {
		const { commands } = resolveCommandTree(commandsDir, { facts: false });
		const paths = [...walkTree(commands)].map(({ path }) => path.join(' '));

		expect(paths).to.contain('db');
		expect(paths.indexOf('db')).to.be.lessThan(paths.indexOf('db migrate'));
		expect(paths.indexOf('db migrate')).to.be.lessThan(paths.indexOf('db migrate up'));
	});
});

describe('generating a command tree', () => {
	it('should print a lazy import per command', () => {
		const tree = resolveCommandTree(commandsDir);
		const source = generateCommands(tree, { from: app });

		expect(source).to.contain('export const commands = {');
		expect(source).to.contain('build: {');
		expect(source).to.contain('desc: "build the app"');
		expect(source).to.contain('load: () => import("./commands/build.ts")');
	});

	it('should nest subcommands rather than flattening them', () => {
		const tree = resolveCommandTree(commandsDir);
		const source = generateCommands(tree, { from: app });

		expect(source).to.contain('load: () => import("./commands/db/migrate/up.js")');
		expect(source).to.match(/db: \{[\s\S]*migrate: \{[\s\S]*up: \{/);
	});

	it('should emit no load for a namespace, so nothing is ever imported for it', () => {
		const tree = resolveCommandTree(commandsDir, { facts: false });
		const db = at(tree.commands, 'db');
		const source = generateCommands({ commands: [db], diagnostics: [] }, { from: app });

		expect(source).to.not.contain('import("./commands/db")');
		expect(source).to.contain('migrate');
	});

	it('should emit a hidden flag it read and nothing for one it did not', () => {
		const tree = resolveCommandTree(commandsDir);
		const source = generateCommands(tree, { from: app });

		expect(source).to.match(/secret: \{[^}]*hidden: true/);
		// `computed.js` has a desc it could not read, so it gets neither
		expect(source).to.match(/computed: \{\n\t\tload:/);
	});

	it('should emit no name, because the key is the name', () => {
		const tree = resolveCommandTree(commandsDir, { facts: false });
		expect(generateCommands(tree, { from: app })).to.not.contain('name:');
	});

	it('should quote a key that is not an identifier', () => {
		// a command name is whatever a file was called, and `my-command` is the
		// ordinary case rather than the exotic one
		const source = generateCommands(
			{
				commands: [
					{ commands: [], kind: 'module', module: '/app/commands/my-cmd.js', name: 'my-cmd' },
				],
				diagnostics: [],
			},
			{ from: '/app' }
		);
		expect(source).to.contain('"my-cmd": {');
	});

	it('should escape a description rather than trusting it', () => {
		// a description is somebody's prose: a quote, a backslash and a newline
		// are all things it may hold and all things that would break the literal
		const source = generateCommands(
			{
				commands: [
					{
						commands: [],
						desc: 'say "hi"\\ok\nand more',
						kind: 'module',
						module: '/app/commands/a.js',
						name: 'a',
					},
				],
				diagnostics: [],
			},
			{ from: '/app' }
		);

		expect(source).to.contain(String.raw`desc: "say \"hi\"\\ok\nand more"`);
	});

	it('should produce a literal that parses back to the same descriptions', () => {
		// the end-to-end claim, and the only one that matters: what is generated is
		// a schema the runtime reads, and help sees every description without a
		// single module being imported
		const tree = resolveCommandTree(commandsDir);
		const source = generateCommands(tree, { from: app });
		const commands = evaluate(source);

		expect(commands.build.desc).to.equal('build the app');
		expect(commands.db.commands.migrate.commands.up.desc).to.equal('migrate up');
		expect(commands.secret.hidden).to.equal(true);
		expect(typeof commands.build.load).to.equal('function');
	});
});

describe('an import specifier', () => {
	it('should be relative with an explicit ./', () => {
		// a bare `commands/build.js` is a package specifier to every resolver
		// there is, so it would be looked for in node_modules
		expect(specifier('/app', '/app/commands/build.js')).to.equal('./commands/build.js');
	});

	it('should reach upwards when it has to', () => {
		expect(specifier('/app/out', '/app/commands/build.js')).to.equal('../commands/build.js');
	});

	it('should use forward slashes whatever the platform separator is', () => {
		// a backslash in a specifier is an escape rather than a separator, so a
		// Windows build would emit `import("./commands\build.js")` and fail at run
		// time on the machine that produced it
		const written = specifier(commandsDir, join(commandsDir, 'db', 'migrate', 'up.js'));
		expect(written).to.equal('./db/migrate/up.js');
		expect(written).to.not.contain('\\');
	});
});

/**
 * A built app, end to end: the tree resolved, printed, written, imported, and
 * parsed against.
 *
 * Everything above this reads source or prints it. This is the only place that
 * asserts what the output *does*, which is the claim the whole ticket rests on
 * -- a generated tree routes the way the directory it came from did, and help
 * has every description without importing a thing.
 */
describe('a generated tree at run time', () => {
	const out = join(app, 'out');
	const file = join(out, 'commands.mjs');

	/** Writes the fixture app's tree out and imports it. */
	async function build(): Promise<Record<string, AnyCommand>> {
		const tree = resolveCommandTree(commandsDir);
		mkdirSync(out, { recursive: true });
		writeFileSync(file, generateCommands(tree, { from: out }), 'utf-8');

		// a cache buster, so a rebuilt tree is the one that gets imported rather
		// than whatever the ESM loader is still holding from the last run
		const mod = await import(`${pathToFileURL(file).href}?t=${Date.now()}`);
		return mod.commands as Record<string, AnyCommand>;
	}

	it('should dispatch a command as deep as the tree goes', async () => {
		const commands = await build();
		expect(
			await main({ argv: ['db', 'migrate', 'up'], schema: { commands, help: false } })
		).to.equal('up');
	});

	it("should dispatch a subdirectory's own index module", async () => {
		const commands = await build();
		expect(await main({ argv: ['config'], schema: { commands, help: false } })).to.equal(
			'configured'
		);
	});

	it('should dispatch a TypeScript command module', async () => {
		const commands = await build();
		expect(await main({ argv: ['build'], schema: { commands, help: false } })).to.equal('built');
	});

	it('should describe every command without importing one', async () => {
		// the whole point: `--help` over a routes tree used to list sixty commands
		// by name alone, because a description lives inside a module and reading it
		// means importing it
		const commands = await build();
		const state = (await main({ argv: [], schema: { commands, help: false } })) as ParseState;
		const registry = state.contexts[0]![Internal].commands;

		expect(registry.find('build')?.desc).to.equal('build the app');
		expect(registry.find('config')?.desc).to.equal('configure the app');
		expect(registry.find('routes-pkg')?.desc).to.equal('a package that names itself');
		expect(registry.find('secret')?.hidden).to.equal(true);

		// ...and nothing was loaded to learn any of it
		for (const command of registry.values()) {
			expect(command[Internal].loaded, `${command.name} was loaded`).to.equal(false);
		}
	});

	it('should leave a command whose description it could not read undescribed', async () => {
		// exactly where an unbundled one is: described once its module loads, and
		// the build said so at the time
		const commands = await build();
		const state = (await main({ argv: [], schema: { commands, help: false } })) as ParseState;

		expect(state.contexts[0]![Internal].commands.find('computed')?.desc).to.equal(undefined);
		expect(await main({ argv: ['computed'], schema: { commands, help: false } })).to.equal(
			'computed'
		);
	});

	it('should not route an underscore-prefixed module', async () => {
		const commands = await build();
		await expect(
			main({
				argv: ['_helpers'],
				schema: { commands, help: false },
				settings: { errorHandler: false },
			})
		).rejects.toThrow('Unexpected argument "_helpers"');
	});
});

/**
 * Reads a generated module back, without writing it to disk.
 *
 * The `import()` calls are never reached -- nothing here calls a `load` -- so
 * the specifiers do not have to resolve for the literal to be read.
 *
 * @param source - The generated source.
 * @returns The exported tree.
 */
function evaluate(source: string): Record<string, any> {
	const body = `${source}\nreturn commands;`;
	// eslint-disable-next-line no-new-func
	return new Function(body.replace('export const', 'const'))();
}
