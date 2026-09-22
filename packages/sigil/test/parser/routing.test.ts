import { isPrivateRoute } from '../../src/parser/command/routes.js';
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
				'private-index',
				'routes-pkg',
			]);
		});
	});

	/**
	 * A `_` prefix is the one way to keep something out of the tree that is
	 * otherwise a perfectly good route: a helper module, a shared component, a
	 * fixture directory. Without it `commands/_helpers.js` is a command called
	 * `_helpers`, which is a footgun the moment a routes tree is the normal way
	 * to write an app.
	 *
	 * It is enforced here rather than only in the build because the two walks
	 * have to agree -- an app that routes differently bundled and unbundled is
	 * the one divergence a user cannot debug.
	 */
	describe('an underscore-prefixed entry', () => {
		it('should not be a command', async () => {
			const result = await parse({ schema: { commands: routes } });
			const names = [...result.contexts[0][Internal].commands.keys()];
			expect(names).to.not.contain('_helpers');
			expect(names).to.not.contain('_shared');
		});

		it('should not be reachable by name', async () => {
			await expect(parse({ argv: ['_helpers'], schema: { commands: routes } })).rejects.toThrow(
				'Unexpected argument "_helpers"'
			);
		});

		it('should keep a private directory out of the tree', async () => {
			await expect(parse({ argv: ['_shared'], schema: { commands: routes } })).rejects.toThrow(
				'Unexpected argument "_shared"'
			);
		});

		it('should leave an underscore in the middle of a name alone', () => {
			// the rule is the prefix and only the prefix; a name is never searched
			// for an underscore somewhere inside it
			expect(isPrivateRoute('my_command.js')).to.equal(false);
			expect(isPrivateRoute('_my-command.js')).to.equal(true);
			expect(isPrivateRoute('.gitkeep')).to.equal(true);
		});

		it("should not be a directory's own index module either", async () => {
			// `private-index/` holds `_index.js` and `real.js`: the prefix takes the
			// index the same way it takes any other route, so the directory is a
			// namespace with nothing to run rather than a command whose `run` came
			// from a module somebody had deliberately hidden
			const result = await parse({ argv: ['private-index'], schema: { commands: routes } });
			expect(result.cmd?.name).to.equal('private-index');
			expect(result.cmd?.run).to.equal(undefined);
			expect(result.cmd?.desc).to.equal(undefined);
			expect([...result.cmd![Internal].commands.keys()]).to.deep.equal(['real']);
		});

		it('should still be one command when a declaration names it', async () => {
			// a path somebody wrote is an explicit statement and gets the command it
			// asked for, which is the same asymmetry as a path nobody named being a
			// directory *of* commands while a named one is *one* command
			const result = await parse({
				argv: ['helpers'],
				schema: { commands: { helpers: path.join(routes, '_helpers.js') } },
			});
			expect(result.cmd?.name).to.equal('helpers');
			expect(result.cmd?.desc).to.equal('not a command');
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
	/**
	 * `load` is `path` said as a function rather than as a file, and it exists
	 * for one reason: a bundled app has no file to read. Its command modules are
	 * chunks a bundler named, reached by a dynamic `import()` the bundler
	 * rewrote, so `sigil build` emits a loader where the unbundled tree had a
	 * path -- and the deferral, which is most of the startup-time argument for
	 * having a tree at all, survives bundling.
	 */
	describe('a generated tree', () => {
		it('should load a command from its loader', async () => {
			const result = await parse({
				argv: ['build'],
				schema: {
					commands: {
						build: {
							load: () => Promise.resolve({ default: { desc: 'built', run: () => 'ran' } }),
						},
					},
				},
			});
			expect(result.cmd?.name).to.equal('build');
			expect(result.cmd?.desc).to.equal('built');
			expect(await result.cmd?.run?.(result as never)).to.equal('ran');
		});

		it('should not call the loader until the command is matched', async () => {
			let called = 0;
			const load = () => {
				called++;
				return Promise.resolve({ default: { run: () => 'ran' } });
			};

			await parse({ argv: [], schema: { commands: { build: { load }, other: { load } } } });
			expect(called).to.equal(0);

			await parse({ argv: ['build'], schema: { commands: { build: { load }, other: { load } } } });
			expect(called).to.equal(1);
		});

		it('should keep a description the tree baked in when the module has none', async () => {
			// the whole point of lifting `desc` statically is that help has it
			// before the module loads; the module's own still wins where it has one
			const result = await parse({
				argv: ['build'],
				schema: {
					commands: {
						build: { desc: 'baked at build time', load: () => Promise.resolve({ default: {} }) },
					},
				},
			});
			expect(result.cmd?.desc).to.equal('baked at build time');
		});

		it("should let the module's own description win over the baked one", async () => {
			const result = await parse({
				argv: ['build'],
				schema: {
					commands: {
						build: {
							desc: 'baked',
							load: () => Promise.resolve({ default: { desc: 'from the module' } }),
						},
					},
				},
			});
			expect(result.cmd?.desc).to.equal('from the module');
		});

		it('should take a loader that hands back the command rather than a module', async () => {
			// so that a loader is not silently a different contract from an import
			const result = await parse({
				argv: ['build'],
				schema: { commands: { build: { load: () => Promise.resolve({ desc: 'bare' }) } } },
			});
			expect(result.cmd?.desc).to.equal('bare');
		});

		it('should carry the placeholder subcommands a generated tree declared', async () => {
			const result = await parse({
				argv: ['db', 'migrate'],
				schema: {
					commands: {
						db: {
							commands: {
								migrate: { load: () => Promise.resolve({ default: { run: () => 'migrated' } }) },
							},
							load: () => Promise.resolve({ default: { desc: 'the database' } }),
						},
					},
				},
			});
			expect(result.cmd?.name).to.equal('migrate');
			expect(await result.cmd?.run?.(result as never)).to.equal('migrated');
		});

		it('should refuse a loader beside a run', async () => {
			await expect(
				parse({
					schema: {
						commands: { build: { load: () => Promise.resolve({}), run: () => undefined } },
					},
				})
			).rejects.toThrow('Cannot combine "load" with "run" in the "build" command');
		});

		it('should refuse a loader beside a path', async () => {
			// both name the module that is the command, so only one of them can be
			await expect(
				parse({
					schema: {
						commands: {
							build: { load: () => Promise.resolve({}), path: path.join(routes, 'build.js') },
						},
					},
				})
			).rejects.toThrow('Cannot combine "load" with "path" in the "build" command');
		});

		it('should refuse a loader that is not a function', async () => {
			await expect(
				parse({ schema: { commands: { build: { load: 'nope' as never } } } })
			).rejects.toThrow('Invalid load function in "build" command');
		});

		it('should report a loader that throws', async () => {
			await expect(
				parse({
					argv: ['build'],
					schema: { commands: { build: { load: () => Promise.reject(new Error('no chunk')) } } },
				})
			).rejects.toThrow('Failed to load command module: no chunk');
		});

		it('should refuse a loader whose module is not a command object', async () => {
			// named by the command rather than by a file, because there is no file
			await expect(
				parse({
					argv: ['build'],
					schema: { commands: { build: { load: () => Promise.resolve({ default: null }) } } },
				})
			).rejects.toThrow(/not a valid command object: the "build" command's loader/);
		});

		it('should try the loader again after one that threw', async () => {
			// a module that throws must throw again the next time the command is
			// matched rather than quietly resolving to the placeholder
			let attempts = 0;
			const load = () => {
				attempts++;
				return Promise.reject(new Error('flaky'));
			};
			const schema = { commands: { build: { load } } };

			await expect(parse({ argv: ['build'], schema })).rejects.toThrow('flaky');
			await expect(parse({ argv: ['build'], schema })).rejects.toThrow('flaky');
			expect(attempts).to.equal(2);
		});
	});
});
