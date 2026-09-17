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
		).rejects.toThrow(new TypeError('Expected "beforeParse" hook to be an array of functions'));

		await expect(
			parse({
				schema: {
					hooks: {
						beforeParse: [123 as any],
					},
				},
			})
		).rejects.toThrow(new TypeError('Expected "beforeParse" hook to be an array of functions'));
	});

	it('should fire hooks during parsing', async () => {
		const result = {
			beforeParseCalled: false,
			afterParseCalled: false,
		};

		await parse({
			schema: {
				hooks: {
					beforeParse: [
						() => {
							result.beforeParseCalled = true;
						},
					],
					afterParse: [
						() => {
							result.afterParseCalled = true;
						},
					],
				},
			},
		});

		expect(result).toStrictEqual({
			beforeParseCalled: true,
			afterParseCalled: true,
		});
	});

	describe('beforeError', () => {
		it('should error if beforeError hooks are invalid', async () => {
			await expect(
				parse({
					schema: {
						hooks: {
							beforeError: 123 as any,
						},
					},
				})
			).rejects.toThrow(new TypeError('Expected "beforeError" hook to be an array of functions'));

			await expect(
				parse({
					schema: {
						hooks: {
							beforeError: [123 as any],
						},
					},
				})
			).rejects.toThrow(new TypeError('Expected "beforeError" hook to be an array of functions'));
		});

		it('should error if a command beforeError hook list is invalid', async () => {
			// a hook list that silently never fires is worst on the error path
			await expect(
				parse({
					schema: {
						commands: {
							build: {
								hooks: {
									beforeError: (() => {}) as any,
								},
							},
						},
					},
				})
			).rejects.toThrow(
				new TypeError('Expected command beforeError hooks to be an array of functions')
			);
		});

		it('should not fire when parsing succeeds', async () => {
			const calls: unknown[] = [];

			await parse({
				argv: ['--name', 'bob'],
				schema: {
					hooks: { beforeError: [(err) => void calls.push(err)] },
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
						beforeError: [
							(e, s) => {
								seen = e;
								state = s;
							},
						],
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
								beforeParse: [
									() => {
										throw new Error('beforeParse exploded');
									},
								],
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
					schema.hooks = { ...schema.hooks, beforeError: [(err) => void calls.push(err)] };

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
				schema: { hooks: { beforeError: [(e) => void calls.push(e)] } },
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
								beforeError: [
									(_e, s) => {
										calls.push('foo');
										state = s;
									},
								],
							},
							path: path.join(__dirname, 'fixtures/does-not-exist.js'),
						},
					},
					hooks: { beforeError: [() => void calls.push('schema')] },
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
					hooks: { beforeError: [() => replacement] },
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
					hooks: { beforeError: [() => new Error('nicer message')] },
				},
			});

			expect((err as { [ErrorState]?: ParseState })[ErrorState]?.cmd?.name).toBe('build');
		});

		it('should replace with a value that is not an error', async () => {
			const err = await failing({
				argv: [],
				schema: {
					hooks: { beforeError: [() => 'just a string'] },
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
					hooks: { beforeError: [() => undefined, async () => {}] },
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
						beforeError: [
							(e) => {
								(e as Error).message = `${(e as Error).message} (try --help)`;
							},
						],
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
						beforeError: [
							async (e) => {
								await Promise.resolve();
								return new Error(`wrapped: ${(e as Error).message}`);
							},
						],
					},
					options: { '--name <value>': 'Your name' },
				},
			});

			expect((err as Error).message).toBe('wrapped: Missing required options: --name');
		});

		it('should skip a hook that throws and keep the error it was given', async () => {
			const calls: string[] = [];

			const err = await failing({
				argv: [],
				schema: {
					hooks: {
						beforeError: [
							() => {
								calls.push('first');
								throw new Error('hook exploded');
							},
							(e) => {
								calls.push((e as Error).message);
							},
						],
					},
					options: { '--name <value>': 'Your name' },
				},
			});

			// the hook's own failure never takes the original error's place, and
			// the hooks after it still run
			expect((err as Error).message).toBe('Missing required options: --name');
			expect(calls).toEqual(['first', 'Missing required options: --name']);
		});

		it('should skip a hook whose promise rejects', async () => {
			const err = await failing({
				argv: [],
				schema: {
					hooks: {
						beforeError: [async () => Promise.reject(new Error('hook exploded'))],
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
									hooks: { beforeError: [record('web')] },
									options: { '--target <name>': 'Where to build to' },
								},
							},
							hooks: { beforeError: [record('build')] },
						},
					},
					hooks: { beforeError: [record('schema')] },
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
								beforeError: [(e) => new Error(`build: ${(e as Error).message}`)],
							},
							options: { '--target <name>': 'Where to build to' },
						},
					},
					hooks: {
						beforeError: [(e) => new Error(`cli: ${(e as Error).message}`)],
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
					hooks: { beforeError: [(err) => void calls.push(err)] },
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
						afterParse: [
							async (state) => {
								const { options } = state.contexts[0][Internal];
								await options.add(await initOption({ choices: ['two'], format: '--mode [m]' }));
							},
						],
					},
				},
			})
		).rejects.toThrow('Invalid value "three" for option --mode');
	});
});
