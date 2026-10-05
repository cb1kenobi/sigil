import { initOption } from '../../src/parser/option/init-option.js';
import { parse } from '../../src/parser/parse.js';
import {
	ErrorState,
	Internal,
	type BeforeErrorHook,
	type ParseOptions,
	type ParseState,
} from '../../src/types.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Runs `parse()` and returns whatever it threw.
 */
function failing(opts: Parameters<typeof parse>[0]): Promise<unknown> {
	return parse(opts).then(
		() => {
			throw new Error('Expected parse() to throw');
		},
		(err: unknown) => err
	);
}

describe('hooks', () => {
	it('should error if hooks are invalid', async () => {
		await expect(
			parse({
				schema: {
					hooks: 123 as any,
				},
			})
		).rejects.toThrow(new TypeError('Expected hooks to be an object of hook names and callbacks'));

		await expect(
			parse({
				schema: {
					hooks: {
						beforeParse: 123 as any,
					},
				},
			})
		).rejects.toThrow(new TypeError('Expected "beforeParse" hook to be a function'));

		// an array is what a hook used to be, so it is the wrong shape somebody is
		// most likely to write -- and a list that silently never fires is the worst
		// way to find out
		await expect(
			parse({
				schema: {
					hooks: {
						beforeParse: [() => {}] as any,
					},
				},
			})
		).rejects.toThrow(new TypeError('Expected "beforeParse" hook to be a function'));
	});

	it('should fire hooks during parsing', async () => {
		const result = {
			beforeParseCalled: false,
			afterParseCalled: false,
		};

		await parse({
			schema: {
				hooks: {
					beforeParse: () => {
						result.beforeParseCalled = true;
					},
					afterParse: () => {
						result.afterParseCalled = true;
					},
				},
			},
		});

		expect(result).toStrictEqual({
			beforeParseCalled: true,
			afterParseCalled: true,
		});
	});

	it('should hand afterParse the values the parse produced', async () => {
		// the hook ran at the end of `parseArgv()`, which is before `processArgs()`
		// and `processOptions()` -- the two that write `state.argv` -- so a hook
		// named "after parse" saw `{}` there while `state.$` was fully populated.
		// The one thing it is for was the one thing it could not do, and reading a
		// parsed value meant waiting for what `main()` returns instead
		const seen: Record<string, unknown>[] = [];

		await parse({
			argv: ['--version', 'file.txt'],
			env: { PORT: '8080' },
			schema: {
				args: ['<entry>'],
				help: false,
				options: {
					'-v, --version': { type: 'bool' },
					'--port [n]': { env: 'PORT', type: 'int' },
				},
				hooks: { afterParse: (state) => void seen.push({ ...state.argv }) },
			},
		});

		// argv as it walked in, the environment fallback included
		expect(seen).toEqual([{ entry: 'file.txt', port: 8080, version: true }]);
	});

	it('should fire afterParse before a value is judged', async () => {
		// producing the values and judging them are two steps, and the hook goes
		// between them -- which is where it has always been documented to fire,
		// "after, before validation results are returned". A hook that fires after
		// the judging could not fix up a value, and one that fires before the values
		// exist has nothing to fix
		const state = await parse({
			argv: ['--mode', 'loud'],
			schema: {
				help: false,
				options: { '--mode [m]': { choices: ['quiet'] } },
				hooks: {
					afterParse: (s) => {
						s.argv.mode = 'quiet';
					},
				},
			},
		});

		expect(state.argv.mode).toBe('quiet');
	});

	describe('beforeError', () => {
		it('should error if a beforeError hook is invalid', async () => {
			await expect(
				parse({
					schema: {
						hooks: {
							beforeError: 123 as any,
						},
					},
				})
			).rejects.toThrow(new TypeError('Expected "beforeError" hook to be a function'));

			await expect(
				parse({
					schema: {
						hooks: {
							beforeError: [() => {}] as any,
						},
					},
				})
			).rejects.toThrow(new TypeError('Expected "beforeError" hook to be a function'));
		});

		it('should error if a command beforeError hook is invalid', async () => {
			// a hook that silently never fires is worst on the error path, and an
			// array is the shape it used to be
			await expect(
				parse({
					schema: {
						commands: {
							build: {
								hooks: {
									beforeError: [() => {}] as any,
								},
							},
						},
					},
				})
			).rejects.toThrow(new TypeError('Expected command beforeError hook to be a function'));
		});

		it('should not fire when parsing succeeds', async () => {
			const calls: unknown[] = [];

			await parse({
				argv: ['--name', 'bob'],
				schema: {
					hooks: { beforeError: (err) => void calls.push(err) },
					options: { '--name [value]': 'Your name' },
				},
			});

			expect(calls).toHaveLength(0);
		});

		it('should fire with the error and the in-flight state', async () => {
			let seen: unknown;
			let state: ParseState | undefined;

			const err = await failing({
				argv: ['build'],
				schema: {
					commands: { build: { options: { '--target <name>': 'Where to build to' } } },
					hooks: {
						beforeError: (e, s) => {
							seen = e;
							state = s;
						},
					},
				},
			});

			expect(seen).toBe(err);
			expect((err as Error).message).toBe('Missing required options: --target');
			expect(state?.cmd?.name).toBe('build');
		});

		describe('throw sites', () => {
			const cases: {
				name: string;
				message: string;
				opts: ParseOptions;
			}[] = [
				{
					name: 'a missing required option',
					message: 'Missing required options: --name',
					opts: { argv: [], schema: { options: { '--name <value>': 'Your name' } } },
				},
				{
					name: 'an invalid choice',
					message: 'Invalid value "pink" for option --color',
					opts: {
						argv: ['--color', 'pink'],
						schema: { options: { '--color [value]': { choices: ['red', 'blue'] } } },
					},
				},
				{
					name: 'a bad data type',
					message: 'Invalid integer: abc',
					opts: {
						argv: ['--count', 'abc'],
						schema: { options: { '--count [value]': { type: 'int' } } },
					},
				},
				{
					name: 'an unknown option',
					message: 'Unknown option "--nope"',
					opts: {
						argv: ['--nope'],
						schema: {},
						settings: { allowUnknownOptions: false },
					},
				},
				{
					name: 'an unexpected argument',
					message: 'Unexpected argument "wat"',
					opts: { argv: ['wat'], schema: {} },
				},
				{
					name: 'a missing required argument',
					message: 'Missing required arguments: <src>',
					opts: { argv: [], schema: { args: ['<src>'] } },
				},
				{
					name: 'a command module that will not load',
					message: 'Command module not found',
					opts: {
						argv: ['foo'],
						schema: {
							commands: { foo: path.join(__dirname, 'fixtures/does-not-exist.js') },
						},
					},
				},
				{
					name: 'a transform the caller supplied',
					message: 'transform exploded',
					opts: {
						argv: ['--name', 'bob'],
						schema: {
							options: {
								'--name [value]': {
									transform: () => {
										throw new Error('transform exploded');
									},
								},
							},
						},
					},
				},
				{
					name: 'a beforeParse hook the caller supplied',
					message: 'beforeParse exploded',
					opts: {
						argv: [],
						schema: {
							hooks: {
								beforeParse: () => {
									throw new Error('beforeParse exploded');
								},
							},
						},
					},
				},
				{
					name: 'an invalid schema, before there is a state at all',
					message: 'Expected argv to be an array',
					opts: { argv: 'nope' as never, schema: {} },
				},
				{
					name: 'an option handed a second consecutive value',
					message: 'Unexpected argument "b"',
					opts: { argv: ['--tag', 'a', 'b'], schema: { options: { '--tag [v]': {} } } },
				},
				{
					name: 'a variadic hint on an option',
					message: 'Invalid option format: <v>...',
					opts: { argv: [], schema: { options: { '--tag <v>...': {} } } },
				},
				{
					name: 'a value bool refuses to coerce',
					message: 'Invalid boolean: "maybe"',
					opts: {
						argv: ['--flag=maybe'],
						schema: { options: { '--flag [v]': { type: 'bool' } } },
					},
				},
				{
					name: 'a bad choice on a paired valued twin',
					message: 'Invalid value "blue" for option --cheese',
					opts: {
						argv: ['--cheese', 'blue'],
						schema: {
							options: { '--cheese [type]': { choices: ['brie'] }, '--no-cheese': {} },
						},
					},
				},
				{
					name: 'a required valued twin nothing satisfied',
					message: 'Missing required options: --cheese',
					opts: { argv: [], schema: { options: { '--cheese <type>': {}, '--no-cheese': {} } } },
				},
				{
					name: 'a variadic argument that is not last',
					message: 'Only the last argument can be variadic',
					opts: { argv: [], schema: { args: ['<rest...>', '[extra]'] } },
				},
				{
					name: 'a variadic argument that is not last inside a subcommand',
					message: 'Only the last argument can be variadic',
					opts: {
						argv: ['build'],
						schema: { commands: { build: { args: ['<files...>', '[out]'] } } },
					},
				},
			];

			for (const { name, message, opts } of cases) {
				it(`should fire for ${name}`, async () => {
					const calls: unknown[] = [];
					const schema = opts.schema as NonNullable<ParseOptions['schema']>;
					schema.hooks = { ...schema.hooks, beforeError: (err) => void calls.push(err) };

					const err = await failing(opts);

					expect((err as Error).message).toContain(message);
					expect(calls).toEqual([err]);
				});
			}
		});

		it('should fire when reading the parse options is what threw', async () => {
			// the schema is read before anything else the caller can throw from,
			// so its hooks are reachable even then
			const calls: unknown[] = [];

			const err = await failing({
				get argv(): string[] {
					throw new Error('bad argv getter');
				},
				schema: { hooks: { beforeError: (e) => void calls.push(e) } },
			});

			expect((err as Error).message).toBe('bad argv getter');
			expect(calls).toEqual([err]);
		});

		it('should fire a command hook when its own module will not load', async () => {
			// the command matched, so it is in the context chain by the time the
			// module behind it fails to load
			const calls: string[] = [];
			let state: ParseState | undefined;

			const err = await failing({
				argv: ['foo'],
				schema: {
					commands: {
						foo: {
							hooks: {
								beforeError: (_e, s) => {
									calls.push('foo');
									state = s;
								},
							},
							path: path.join(__dirname, 'fixtures/does-not-exist.js'),
						},
					},
					hooks: { beforeError: () => void calls.push('schema') },
				},
			});

			expect((err as Error).message).toContain('Command module not found');
			expect(calls).toEqual(['foo', 'schema']);
			expect(state?.cmd?.name).toBe('foo');
		});

		it('should replace the error when a hook returns one', async () => {
			const replacement = new Error('nicer message');

			const err = await failing({
				argv: [],
				schema: {
					hooks: { beforeError: () => replacement },
					options: { '--name <value>': 'Your name' },
				},
			});

			expect(err).toBe(replacement);
		});

		it('should carry the parse state onto a replacement error', async () => {
			// swapping the error out must not cost the renderer its usage line
			const err = await failing({
				argv: ['build'],
				schema: {
					commands: { build: { options: { '--target <name>': 'Where to build to' } } },
					hooks: { beforeError: () => new Error('nicer message') },
				},
			});

			expect((err as { [ErrorState]?: ParseState })[ErrorState]?.cmd?.name).toBe('build');
		});

		it('should replace with a value that is not an error', async () => {
			const err = await failing({
				argv: [],
				schema: {
					hooks: { beforeError: () => 'just a string' },
					options: { '--name <value>': 'Your name' },
				},
			});

			expect(err).toBe('just a string');
		});

		it('should not let a hook suppress the error', async () => {
			// returning nothing is what a hook that only looks returns, so it
			// can only ever mean "leave the error alone"
			const err = await failing({
				argv: [],
				schema: {
					hooks: { beforeError: () => undefined },
					options: { '--name <value>': 'Your name' },
				},
			});

			expect((err as Error).message).toBe('Missing required options: --name');
		});

		it('should let a hook mutate the error in place', async () => {
			const err = await failing({
				argv: [],
				schema: {
					hooks: {
						beforeError: (e) => {
							(e as Error).message = `${(e as Error).message} (try --help)`;
						},
					},
					options: { '--name <value>': 'Your name' },
				},
			});

			expect((err as Error).message).toBe('Missing required options: --name (try --help)');
		});

		it('should await an async hook', async () => {
			const err = await failing({
				argv: [],
				schema: {
					hooks: {
						beforeError: async (e) => {
							await Promise.resolve();
							return new Error(`wrapped: ${(e as Error).message}`);
						},
					},
					options: { '--name <value>': 'Your name' },
				},
			});

			expect((err as Error).message).toBe('wrapped: Missing required options: --name');
		});

		it('should skip a hook that throws and keep the error it was given', async () => {
			// one hook per source now, so the hook that still has to run is the next
			// source's: the command's throws and the schema's is handed the error
			// unharmed. That is the same claim -- a hook's own failure never takes
			// the original error's place, and never stops the hooks after it
			const calls: string[] = [];

			const err = await failing({
				argv: ['build'],
				schema: {
					commands: {
						build: {
							hooks: {
								beforeError: () => {
									calls.push('command');
									throw new Error('hook exploded');
								},
							},
							options: { '--name <value>': 'Your name' },
						},
					},
					hooks: {
						beforeError: (e) => {
							calls.push((e as Error).message);
						},
					},
				},
			});

			expect((err as Error).message).toBe('Missing required options: --name');
			expect(calls).toEqual(['command', 'Missing required options: --name']);
		});

		it('should skip a hook whose promise rejects', async () => {
			const err = await failing({
				argv: [],
				schema: {
					hooks: {
						beforeError: async () => Promise.reject(new Error('hook exploded')),
					},
					options: { '--name <value>': 'Your name' },
				},
			});

			expect((err as Error).message).toBe('Missing required options: --name');
		});

		it('should fire command hooks before the schema hooks', async () => {
			const calls: string[] = [];
			const record = (label: string): BeforeErrorHook => {
				return () => void calls.push(label);
			};

			await failing({
				argv: ['build', 'web'],
				schema: {
					commands: {
						build: {
							commands: {
								web: {
									hooks: { beforeError: record('web') },
									options: { '--target <name>': 'Where to build to' },
								},
							},
							hooks: { beforeError: record('build') },
						},
					},
					hooks: { beforeError: record('schema') },
				},
			});

			// innermost first, the way the error itself travels out
			expect(calls).toEqual(['web', 'build', 'schema']);
		});

		it('should hand each hook what the hook before it made of the error', async () => {
			const err = await failing({
				argv: ['build'],
				schema: {
					commands: {
						build: {
							hooks: {
								beforeError: (e) => new Error(`build: ${(e as Error).message}`),
							},
							options: { '--target <name>': 'Where to build to' },
						},
					},
					hooks: {
						beforeError: (e) => new Error(`cli: ${(e as Error).message}`),
					},
				},
			});

			expect((err as Error).message).toBe('cli: build: Missing required options: --target');
		});

		it('should fire a schema hook only once', async () => {
			// the outermost context is the schema itself, so a naive walk of the
			// context chain plus the schema would fire it twice
			const calls: unknown[] = [];

			await failing({
				argv: ['build'],
				schema: {
					commands: { build: { options: { '--target <name>': 'Where to build to' } } },
					hooks: { beforeError: (err) => void calls.push(err) },
				},
			});

			expect(calls).toHaveLength(1);
		});
	});

	// a hook that replaces an option after its value was read leaves the writer on
	// record pointing at the object the replacement evicted. Every live declaration
	// then read that value as somebody else's, so nothing validated it at all.
	it('should validate a value whose writer a hook replaced', async () => {
		await expect(
			parse({
				argv: ['--mode', 'three'],
				schema: {
					help: false,
					name: 'mycli',
					options: { '--mode [m]': { choices: ['three'] } },
					hooks: {
						afterParse: async (state) => {
							const { options } = state.contexts[0][Internal];
							await options.add(await initOption({ choices: ['two'], format: '--mode [m]' }));
						},
					},
				},
			})
		).rejects.toThrow('Invalid value "three" for option --mode');
	});

	describe('subcommandLoaded', () => {
		const loads = (desc: string) => () => Promise.resolve({ default: { desc } });

		it('should fire on the command that declared the subcommand', async () => {
			const seen: [string, string][] = [];

			await parse({
				argv: ['db', 'migrate'],
				schema: {
					name: 'mycli',
					commands: {
						db: {
							hooks: {
								subcommandLoaded({ cmd, parent }) {
									seen.push([parent.name, cmd.name]);
								},
							},
							commands: { migrate: { load: loads('run migrations') } },
						},
					},
				},
			});

			expect(seen).to.deep.equal([['db', 'migrate']]);
		});

		it('should fire on the schema for a top-level command, which is the root command', async () => {
			// the schema is initialized into the root command, so its hook reaches
			// a top-level command through the same mechanism rather than a second one
			const seen: string[] = [];

			await parse({
				argv: ['build'],
				schema: {
					name: 'mycli',
					hooks: {
						subcommandLoaded({ cmd }) {
							seen.push(cmd.name);
						},
					},
					commands: { build: { load: loads('build it') } },
				},
			});

			expect(seen).to.deep.equal(['build']);
		});

		it('should hand over the loaded command rather than the placeholder', async () => {
			let desc: string | undefined;

			await parse({
				argv: ['build'],
				schema: {
					name: 'mycli',
					hooks: {
						subcommandLoaded({ cmd }) {
							desc = cmd.desc;
						},
					},
					commands: { build: { load: loads('from the module') } },
				},
			});

			// the merge has happened by the time the parent is told, which is the
			// whole reason it fires after the fetch rather than around it
			expect(desc).to.equal('from the module');
		});

		it('should fire for a subcommand with no module at all', async () => {
			// an inline `run` loads nothing, and a parent that saw only its
			// module-backed subcommands would see some of its children and not
			// others according to how each happened to be declared
			const seen: string[] = [];

			await parse({
				argv: ['build'],
				schema: {
					name: 'mycli',
					hooks: {
						subcommandLoaded({ cmd }) {
							seen.push(cmd.name);
						},
					},
					commands: { build: { run() {} } },
				},
			});

			expect(seen).to.deep.equal(['build']);
		});

		it('should fire for a namespace directory with no index module', async () => {
			// `loadCommandDir()` read the level and no module was fetched, which is
			// the other half of "loading a command is two events"
			const seen: string[] = [];

			await parse({
				argv: ['deploy'],
				schema: {
					name: 'mycli',
					commands: path.join(__dirname, 'fixtures/routes'),
					hooks: {
						subcommandLoaded({ cmd }) {
							seen.push(cmd.name);
						},
					},
				},
			});

			expect(seen).to.deep.equal(['deploy']);
		});

		it('should not fire on a command that did not declare it', async () => {
			const seen: string[] = [];

			await parse({
				argv: ['build'],
				schema: {
					name: 'mycli',
					commands: {
						build: { load: loads('build it') },
						db: {
							hooks: {
								subcommandLoaded({ cmd }) {
									seen.push(cmd.name);
								},
							},
							commands: { migrate: { run() {} } },
						},
					},
				},
			});

			expect(seen).to.deep.equal([]);
		});

		it('should let a parent add an option to the subcommand that just loaded', async () => {
			// the use the hook exists for: a module's command is not knowable until
			// it has loaded, and this is the first moment a parent can reach it --
			// still early enough for the option to be matchable on this same parse
			const state = await parse({
				argv: ['build', '--extra', 'yes'],
				schema: {
					name: 'mycli',
					hooks: {
						async subcommandLoaded({ cmd }) {
							await cmd[Internal].options.add({ format: '--extra [v]' });
						},
					},
					commands: { build: { load: loads('build it') } },
				},
			});

			expect(state.argv.extra).to.equal('yes');
		});

		it('should replace the subcommand when the hook returns one', async () => {
			let ran = false;

			const state = await parse({
				argv: ['build'],
				schema: {
					name: 'mycli',
					hooks: {
						subcommandLoaded() {
							return {
								desc: 'the replacement',
								run() {
									ran = true;
								},
							};
						},
					},
					commands: { build: { load: loads('from the module') } },
				},
			});

			expect(state.cmd?.desc).to.equal('the replacement');
			await state.cmd?.run?.(state as never);
			expect(ran).to.equal(true);
		});

		it('should keep the replaced name when the replacement brought none', async () => {
			// a replacement for `build` is a `build`, so repeating the name it is
			// replacing would be noise
			const state = await parse({
				argv: ['build'],
				schema: {
					name: 'mycli',
					hooks: {
						subcommandLoaded() {
							return { desc: 'the replacement' };
						},
					},
					commands: { build: { load: loads('from the module') } },
				},
			});

			expect(state.cmd?.name).to.equal('build');
		});

		it('should take a replacement that names itself', async () => {
			const state = await parse({
				argv: ['build'],
				schema: {
					name: 'mycli',
					hooks: {
						subcommandLoaded() {
							return { name: 'renamed', desc: 'the replacement' };
						},
					},
					commands: { build: { load: loads('from the module') } },
				},
			});

			expect(state.cmd?.name).to.equal('renamed');
		});

		it("should resolve a replacement's own relative paths against the parent", async () => {
			// a replacement may not name a module of its own -- the refusals below --
			// but it may declare `commands`, and a path in a declaration is relative
			// to whatever declared it. The hook is the parent's code, so the parent's
			// directory is what it is relative to
			const state = await parse({
				argv: ['build', 'foo'],
				schema: {
					name: 'mycli',
					baseDir: __dirname,
					hooks: {
						subcommandLoaded() {
							return { commands: { foo: { path: './fixtures/simple/foo.js' } } };
						},
					},
					commands: { build: { load: loads('from the module') } },
				},
			});

			expect(state.cmd?.name).to.equal('foo');
			expect(state.cmd?.desc).to.equal('foo!');
		});

		it('should refuse a replacement declaring a path, which is a module to fetch', async () => {
			// the module has already been loaded, so nothing would read one -- such
			// a command would reach the parse with its module never imported
			await expect(
				parse({
					argv: ['build'],
					schema: {
						name: 'mycli',
						hooks: {
							subcommandLoaded() {
								return { path: path.join(__dirname, 'fixtures/simple/foo.js') };
							},
						},
						commands: { build: { load: loads('from the module') } },
					},
				})
			).rejects.toThrow(/subcommandLoaded hook returned a command declaring "path"/u);
		});

		it('should refuse a replacement declaring a loader', async () => {
			await expect(
				parse({
					argv: ['build'],
					schema: {
						name: 'mycli',
						hooks: {
							subcommandLoaded() {
								return { load: loads('another one') };
							},
						},
						commands: { build: { load: loads('from the module') } },
					},
				})
			).rejects.toThrow(/subcommandLoaded hook returned a command declaring "load"/u);
		});

		it('should leave the subcommand alone when the hook returns nothing', async () => {
			const state = await parse({
				argv: ['build'],
				schema: {
					name: 'mycli',
					hooks: {
						subcommandLoaded() {
							// explicitly nothing
						},
					},
					commands: { build: { load: loads('from the module') } },
				},
			});

			expect(state.cmd?.desc).to.equal('from the module');
		});

		it('should fire when help loads a command to describe it', async () => {
			// `help <command>` is a load like any other, and a parent told about its
			// subcommands only when argv ran one would be told inconsistently.
			// `help` itself is in there because it is an ordinary registered
			// subcommand of the root -- the one the framework added -- and argv named
			// it; it is announced for the same reason every other module-less command
			// is, and only when it is actually matched
			const seen: string[] = [];

			await parse({
				argv: ['help', 'build'],
				schema: {
					name: 'mycli',
					hooks: {
						subcommandLoaded({ cmd }) {
							seen.push(cmd.name);
						},
					},
					commands: { build: { load: loads('build it') } },
				},
			});

			expect(seen).to.deep.equal(['help', 'build']);
		});

		it('should not announce the help command on a parse that never named it', async () => {
			// the sibling above shows `help` being announced because argv asked for
			// it. What would be noise is announcing it on every parse there is
			const seen: string[] = [];

			await parse({
				argv: ['build'],
				schema: {
					name: 'mycli',
					hooks: {
						subcommandLoaded({ cmd }) {
							seen.push(cmd.name);
						},
					},
					commands: { build: { load: loads('build it') } },
				},
			});

			expect(seen).to.deep.equal(['build']);
		});

		it('should fire for a default command, which argv never named', async () => {
			const seen: string[] = [];

			await parse({
				argv: [],
				schema: {
					name: 'mycli',
					hooks: {
						subcommandLoaded({ cmd }) {
							seen.push(cmd.name);
						},
					},
					commands: { build: { default: true, load: loads('build it') } },
				},
			});

			expect(seen).to.deep.equal(['build']);
		});

		it('should let a throw out, the way an init hook does', async () => {
			await expect(
				parse({
					argv: ['build'],
					schema: {
						name: 'mycli',
						hooks: {
							subcommandLoaded() {
								throw new Error('the parent blew up');
							},
						},
						commands: { build: { load: loads('build it') } },
					},
				})
			).rejects.toThrow('the parent blew up');
		});
	});
});
