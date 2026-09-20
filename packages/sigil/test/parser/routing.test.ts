import { parse } from '../../src/parser/parse.js';
import { Internal } from '../../src/types.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const routes = path.join(__dirname, 'fixtures/routes');

/**
 * A directory of command modules is a tree rather than a list: a subdirectory
 * is a command with the commands inside it as its subcommands, and an `index`
 * module beside them is that command itself.
 *
 * Every level is read when something asks for it and not before, which is the
 * same promise a lazily loaded module already makes and is what the tree is
 * worth having for.
 */
describe('filesystem routing', () => {
	describe('the tree', () => {
		it('should register a file in the directory as a command', async () => {
			const result = await parse({ argv: ['build'], schema: { commands: routes } });
			expect(result.cmd?.name).to.equal('build');
			expect(result.cmd?.desc).to.equal('build the app');
		});

		it('should register a subdirectory as a command with subcommands', async () => {
			const result = await parse({ argv: ['config', 'set'], schema: { commands: routes } });
			expect(result.cmd?.name).to.equal('set');
			expect(result.contexts.map((c) => c.name)).to.deep.equal(['set', 'config', 'global']);
		});

		it("should run a directory's own index module", async () => {
			const result = await parse({ argv: ['config'], schema: { commands: routes } });
			expect(result.cmd?.name).to.equal('config');
			expect(result.cmd?.desc).to.equal('configure the app');
			expect(await result.cmd?.run?.(result as never)).to.equal('configured');
		});

		it('should not register an index module as a command of its own', async () => {
			const result = await parse({ argv: ['config'], schema: { commands: routes } });
			expect(result.cmd?.[Internal].commands.find('index')).to.equal(undefined);
			expect([...result.cmd![Internal].commands.keys()].sort()).to.deep.equal(['get', 'set']);
		});

		it('should recurse as far as argv names', async () => {
			const result = await parse({ argv: ['db', 'migrate', 'up'], schema: { commands: routes } });
			expect(result.cmd?.desc).to.equal('migrate up');
			expect(result.contexts.map((c) => c.name)).to.deep.equal(['up', 'migrate', 'db', 'global']);
		});

		it('should leave a directory with no index module runnable by nobody', async () => {
			// `deploy` is a namespace: it matches and lists what is under it, and
			// there is no module for it to have a `run` from
			const result = await parse({ argv: ['deploy'], schema: { commands: routes } });
			expect(result.cmd?.name).to.equal('deploy');
			expect(result.cmd?.run).to.equal(undefined);
			expect([...result.cmd![Internal].commands.keys()]).to.deep.equal(['prod']);
		});

		it('should take a directory holding nothing but an index module', async () => {
			const result = await parse({ argv: ['only-index'], schema: { commands: routes } });
			expect(result.cmd?.desc).to.equal('nothing beside it');
			expect(result.cmd?.[Internal].commands.size).to.equal(0);
		});

		it('should skip a dot-prefixed entry', async () => {
			const result = await parse({ schema: { commands: routes } });
			const names = [...result.contexts[0][Internal].commands.keys()];
			expect(names).to.not.contain('.hidden-not-a-route');
			// `help` is the parser's own, added to the root alongside `--help`, and
			// `routes-pkg` is `pkg/` under the name its own package.json gives it
			expect(names.sort()).to.deep.equal([
				'build',
				'clash',
				'config',
				'db',
				'deploy',
				'help',
				'only-index',
				'routes-pkg',
			]);
		});
	});

	describe('a package the walk found', () => {
		it('should be named by its package.json rather than by its directory', async () => {
			// the directory is `pkg/` and the package calls itself `routes-pkg`; a
			// package names itself, which is what a package a declaration pointed at
			// has always done
			const result = await parse({ argv: ['routes-pkg'], schema: { commands: routes } });
			expect(result.cmd?.name).to.equal('routes-pkg');

			// and the directory name is not a second way to reach it
			await expect(parse({ argv: ['pkg'], schema: { commands: routes } })).rejects.toThrow(
				'Unexpected argument "pkg"'
			);
		});

		it('should be named and described without being imported', async () => {
			// both answers come out of `package.json`, which is a file read rather
			// than an import -- so the name is known in time to match on and the
			// module still waits for a match
			const result = await parse({ schema: { commands: routes } });
			const pkg = result.contexts[0][Internal].commands.get('routes-pkg');
			expect(pkg?.[Internal].loaded).to.equal(false);
			expect(pkg?.desc).to.equal('a package found by the walk');
		});

		it('should resolve its entry through exports when it is matched', async () => {
			const result = await parse({ argv: ['routes-pkg'], schema: { commands: routes } });
			expect(result.cmd?.[Internal].loaded).to.equal(true);
			expect(result.cmd?.desc).to.equal('the package module itself');
		});

		it('should not have its own directory walked for subcommands', async () => {
			// `exports` says which module is the command, so the files beside it are
			// the package's internals rather than routes
			const result = await parse({ argv: ['routes-pkg'], schema: { commands: routes } });
			expect([...result.cmd![Internal].commands.keys()]).to.deep.equal([]);
		});
	});

	describe('one level at a time', () => {
		/**
		 * `clash/` holds a `dupe.js` and a `dupe/`, which is an error -- and the
		 * error is what makes the laziness observable: walked while the schema was
		 * built it would throw before argv was read at all, so a parse that never
		 * mentions `clash` proves nothing under it was ever read.
		 */
		it('should not walk a directory nobody named', async () => {
			const result = await parse({ argv: ['build'], schema: { commands: routes } });
			expect(result.cmd?.name).to.equal('build');

			const clash = result.contexts.at(-1)?.[Internal].commands.get('clash');
			expect(clash?.[Internal].loaded).to.equal(false);
			expect(clash?.[Internal].commands.size).to.equal(0);
		});

		it('should walk a directory when argv names it', async () => {
			await expect(parse({ argv: ['clash'], schema: { commands: routes } })).rejects.toThrow(
				/Two entries in .* both declare a "dupe" command: "dupe" and "dupe\.js"/
			);
		});

		it('should leave a level it did not reach unread', async () => {
			const result = await parse({ argv: ['db'], schema: { commands: routes } });
			const migrate = result.cmd?.[Internal].commands.get('migrate');
			expect(migrate?.[Internal].loaded).to.equal(false);
			expect(migrate?.[Internal].commands.size).to.equal(0);
		});
	});

	describe('TypeScript', () => {
		const ts = path.join(__dirname, 'fixtures/routes-ts');

		it('should route a .ts file', async () => {
			const result = await parse({ argv: ['deploy'], schema: { commands: ts } });
			expect(result.cmd?.name).to.equal('deploy');
			expect(result.cmd?.desc).to.equal('deploy the app');
		});

		it('should take a .mts index module', async () => {
			const result = await parse({ argv: ['settings'], schema: { commands: ts } });
			expect(result.cmd?.desc).to.equal('settings are on');
		});

		it('should register a .cts subcommand', async () => {
			// registered here and *loaded* in `packages/cli/test/typescript.test.ts`,
			// which spawns a real node: vite transforms anything this suite imports
			// and cannot read a `.cts`, while node strips its types and loads it as
			// the CommonJS the extension says it is
			const result = await parse({ argv: ['settings'], schema: { commands: ts } });
			const edit = result.cmd?.[Internal].commands.get('edit');
			expect(edit?.name).to.equal('edit');
			expect(edit?.[Internal].path).to.match(/edit\.cts$/);
		});

		it('should resolve a package whose exports names a .ts entry', async () => {
			const result = await parse({ argv: ['pkg-ts'], schema: { commands: ts } });
			expect(result.cmd?.desc).to.equal('the TypeScript package module');
		});

		it('should not route a declaration file', async () => {
			// `deploy.d.ts` parses as a name of `deploy.d` and an extension of
			// `.ts`, so left alone it is a command called `deploy.d` -- and beside
			// the `deploy.ts` it describes it is a second claim on `deploy`, which
			// would be the collision error on a directory that is perfectly ordinary
			const result = await parse({ schema: { commands: ts } });
			const names = [...result.contexts[0][Internal].commands.keys()];
			expect(names).to.not.contain('deploy.d');
			expect(names.sort()).to.deep.equal(['deploy', 'help', 'pkg-ts', 'settings']);
		});

		it('should refuse a .ts and a .js claiming one name', async () => {
			// the same rule two routes of one name already follow. Picking one by a
			// preference order is how somebody edits the file that is not loaded
			await expect(
				parse({ schema: { commands: path.join(__dirname, 'fixtures/routes-clash-ts') } })
			).rejects.toThrow(/both declare a "build" command/);
		});
	});

	describe('a named path', () => {
		it('should make one command out of a directory', async () => {
			const result = await parse({
				argv: ['settings', 'set'],
				schema: { commands: { settings: path.join(routes, 'config') } },
			});
			expect(result.cmd?.name).to.equal('set');
			expect(result.contexts.map((c) => c.name)).to.deep.equal(['set', 'settings', 'global']);
		});

		it('should refuse a directory with no command in it', async () => {
			await expect(
				parse({ schema: { commands: { nope: path.join(__dirname, 'fixtures/empty') } } })
			).rejects.toThrow('Unsupported command module');
		});
	});

	describe('path and run together', () => {
		it('should refuse a command declaring both', async () => {
			await expect(
				parse({
					schema: {
						commands: {
							build: { path: path.join(routes, 'build.js'), run: () => undefined },
						},
					},
				})
			).rejects.toThrow('Cannot combine "path" with "run" in the "build" command');
		});

		it('should refuse a module declaring both', async () => {
			await expect(
				parse({
					argv: ['both'],
					schema: { commands: { both: path.join(__dirname, 'fixtures/path-and-run.js') } },
				})
			).rejects.toThrow('Cannot combine "path" with "run"');
		});
	});
});
