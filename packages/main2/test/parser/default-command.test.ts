import { main2 } from '../../src/index.js';
import { parse } from '../../src/parser/parse.js';
import { ErrorState, type ParseState } from '../../src/types.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

describe('default command', () => {
	describe('dispatch', () => {
		it('should dispatch the default command when argv names none', async () => {
			const state = await parse({
				argv: [],
				schema: {
					commands: {
						build: { default: true },
						test: {},
					},
				},
			});

			expect(state.cmd?.name).toBe('build');
			expect(state.contexts.map((c) => c.name)).toStrictEqual(['build', 'global']);
		});

		it('should not add a token to the parsed stream for a name nobody typed', async () => {
			const state = await parse({
				argv: [],
				schema: { commands: { build: { default: true } } },
			});

			// `$` is the classified token stream, and no token named the command
			expect(state.$).toHaveLength(0);
		});

		it('should not dispatch when no command is marked default', async () => {
			const state = await parse({
				argv: [],
				schema: { commands: { build: {}, test: {} } },
			});

			expect(state.cmd).toBeUndefined();
			expect(state.contexts.map((c) => c.name)).toStrictEqual(['global']);
		});

		it('should not dispatch a command whose default is false', async () => {
			const state = await parse({
				argv: [],
				schema: { commands: { build: { default: false } } },
			});

			expect(state.cmd).toBeUndefined();
		});

		it('should let an explicit command name beat the default', async () => {
			const state = await parse({
				argv: ['test'],
				schema: {
					commands: {
						build: { default: true },
						test: {},
					},
				},
			});

			expect(state.cmd?.name).toBe('test');
			expect(state.contexts.map((c) => c.name)).toStrictEqual(['test', 'global']);
		});

		it('should dispatch the default command only once when it is also typed', async () => {
			const state = await parse({
				argv: ['build'],
				schema: { commands: { build: { default: true } } },
			});

			expect(state.cmd?.name).toBe('build');
			expect(state.contexts.map((c) => c.name)).toStrictEqual(['build', 'global']);
			expect(state.$.filter((a) => a.type === 'Command')).toHaveLength(1);
		});

		it('should run the default command from main2()', async () => {
			const result = await main2({
				argv: [],
				schema: { commands: { build: { default: true, run: () => 'built' } } },
			});

			expect(result).toBe('built');
		});

		it('should load a lazily loaded default command module', async () => {
			const state = await parse({
				argv: [],
				schema: {
					commands: {
						foo: {
							default: true,
							path: path.join(__dirname, 'fixtures/simple/foo.js'),
						},
					},
				},
			});

			expect(state.cmd?.name).toBe('foo');
			expect(state.cmd?.desc).toBe('foo!');
			expect(state.contexts[0].desc).toBe('foo!');
		});

		it('should fire the default command parse hook', async () => {
			const names: string[] = [];

			await parse({
				argv: [],
				schema: {
					commands: {
						build: {
							default: true,
							hooks: { parse: [({ cmd }) => void names.push(cmd.name as string)] },
						},
					},
				},
			});

			expect(names).toStrictEqual(['build']);
		});
	});

	describe('arguments', () => {
		it('should bind positional values to the default command', async () => {
			const state = await parse({
				argv: ['out.js'],
				schema: {
					commands: {
						build: { args: ['<entry>'], default: true },
					},
				},
			});

			expect(state.cmd?.name).toBe('build');
			expect(state.argv.entry).toBe('out.js');
			expect(state._).toStrictEqual(['out.js']);
		});

		it('should report the required arguments the default command never got', async () => {
			// the default command is the command that ran, so its own requirements
			// are the ones that apply -- and naming the missing argument beats
			// silently doing nothing
			await expect(
				parse({
					argv: [],
					schema: { commands: { build: { args: ['<entry>'], default: true } } },
				})
			).rejects.toThrow(new Error('Missing required arguments: <entry>'));
		});

		it('should carry the default command on a missing argument error', async () => {
			const err = await parse({
				argv: [],
				schema: { commands: { build: { args: ['<entry>'], default: true } } },
			}).catch((e: unknown) => e);

			const state = (err as { [ErrorState]?: ParseState })[ErrorState];
			expect(state?.cmd?.name).toBe('build');
		});

		it('should apply the default command argument defaults', async () => {
			const state = await parse({
				argv: [],
				schema: {
					commands: {
						build: {
							args: [{ name: 'entry', default: 'index.js' }],
							default: true,
						},
					},
				},
			});

			expect(state.argv.entry).toBe('index.js');
		});

		it('should reject an unexpected argument against the default command', async () => {
			await expect(
				parse({
					argv: ['nope'],
					schema: { commands: { build: { default: true } } },
				})
			).rejects.toThrow(new Error('Unexpected argument "nope"'));
		});

		it('should match a subcommand of the default command', async () => {
			// the default stands in for a name that was never typed, so the token
			// that follows resolves against it exactly as `build all` would
			const state = await parse({
				argv: ['all'],
				schema: {
					commands: {
						build: { commands: { all: {} }, default: true },
					},
				},
			});

			expect(state.cmd?.name).toBe('all');
			expect(state.contexts.map((c) => c.name)).toStrictEqual(['all', 'build', 'global']);
		});
	});

	describe('options', () => {
		it('should resolve an option the default command declares', async () => {
			const state = await parse({
				argv: ['--target', 'esm'],
				schema: {
					commands: {
						build: {
							default: true,
							options: { '--target [name]': 'Where to build to' },
						},
					},
				},
			});

			expect(state.cmd?.name).toBe('build');
			expect(state.argv.target).toBe('esm');
			expect(state.argv).not.toHaveProperty('esm');
		});

		it('should enforce a required option on the default command', async () => {
			await expect(
				parse({
					argv: [],
					schema: {
						commands: {
							build: { default: true, options: { '--target <name>': 'Where to build to' } },
						},
					},
				})
			).rejects.toThrow(new Error('Missing required options: --target'));
		});

		it('should still resolve the options the root declares', async () => {
			const state = await parse({
				argv: ['--verbose'],
				schema: {
					commands: { build: { default: true } },
					options: { '-v, --verbose': 'Print more output' },
				},
			});

			expect(state.cmd?.name).toBe('build');
			expect(state.argv.verbose).toBe(true);
		});
	});

	describe('nesting', () => {
		it('should dispatch a default subcommand of a matched command', async () => {
			const state = await parse({
				argv: ['build'],
				schema: {
					commands: {
						build: {
							commands: {
								all: { default: true },
								one: {},
							},
						},
					},
				},
			});

			expect(state.cmd?.name).toBe('all');
			expect(state.contexts.map((c) => c.name)).toStrictEqual(['all', 'build', 'global']);
		});

		it('should not dispatch a parent default once a sibling was named', async () => {
			const state = await parse({
				argv: ['build', 'one'],
				schema: {
					commands: {
						build: {
							commands: {
								all: { default: true },
								one: {},
							},
						},
					},
				},
			});

			expect(state.cmd?.name).toBe('one');
		});

		it('should not enforce the arguments of a command that cascaded to its default', async () => {
			// only the innermost command's arguments are checked, which is the same
			// rule a typed chain follows: `build all` never checks `build`'s
			const state = await parse({
				argv: [],
				schema: {
					commands: {
						build: {
							args: ['<entry>'],
							commands: { all: { default: true } },
							default: true,
						},
					},
				},
			});

			expect(state.cmd?.name).toBe('all');
			expect(state.argv).not.toHaveProperty('entry');
		});

		it('should cascade from one default command to the next', async () => {
			const state = await parse({
				argv: [],
				schema: {
					commands: {
						build: {
							commands: { all: { default: true } },
							default: true,
						},
					},
				},
			});

			expect(state.cmd?.name).toBe('all');
			expect(state.contexts.map((c) => c.name)).toStrictEqual(['all', 'build', 'global']);
		});
	});

	describe('declaration errors', () => {
		it('should error if two sibling commands are both default', async () => {
			await expect(
				parse({
					argv: [],
					schema: {
						commands: {
							build: { default: true },
							test: { default: true },
						},
					},
				})
			).rejects.toThrow(
				new Error('Only one default command is allowed: "build" and "test" are both default')
			);
		});

		it('should error if two default subcommands are both default', async () => {
			await expect(
				parse({
					argv: ['build'],
					schema: {
						commands: {
							build: {
								commands: {
									all: { default: true },
									one: { default: true },
								},
							},
						},
					},
				})
			).rejects.toThrow(
				new Error('Only one default command is allowed: "all" and "one" are both default')
			);
		});

		it('should allow a default command in each context', async () => {
			const state = await parse({
				argv: ['build'],
				schema: {
					commands: {
						build: { commands: { all: { default: true } } },
						test: { default: true },
					},
				},
			});

			expect(state.cmd?.name).toBe('all');
		});

		it('should ignore a default declared inside a module that is only a path', async () => {
			// nothing loads a command module to find out whether it wants to be the
			// default -- that would load every module a lazy schema was built to
			// avoid loading
			const state = await parse({
				argv: [],
				schema: {
					commands: { solo: path.join(__dirname, 'fixtures/lazy-default/solo.js') },
				},
			});

			expect(state.cmd).toBeUndefined();
		});

		it('should honor a default declared by a command package', async () => {
			// a package is read while the schema is built either way, so its
			// module-declared default is visible when a plain path's is not
			const state = await parse({
				argv: [],
				schema: {
					commands: { pkg: path.join(__dirname, 'fixtures/default-pkg') },
				},
			});

			expect(state.cmd?.name).toBe('pkg');
		});

		it('should error if default is not a boolean', async () => {
			await expect(
				parse({
					argv: [],
					schema: { commands: { build: { default: 'yes' as any } } },
				})
			).rejects.toThrow(new TypeError('Expected default in "build" command to be a boolean'));
		});
	});

	describe('known bugs', () => {
		it('should not protect an option the default command declares from an earlier option', async () => {
			// the same defect as a subcommand's option used before its subcommand:
			// nothing protects an option that is not declared yet, and the default
			// joins the chain only after argv has been walked once. Pinned so the
			// day it is fixed, it is fixed on purpose
			const state = await parse({
				argv: ['--name', '--verbose'],
				schema: {
					commands: { build: { default: true, options: { '-v, --verbose': null } } },
					options: { '--name [value]': null },
				},
			});

			expect(state.argv.name).toBe('--verbose');
			expect(state.argv.verbose).toBe(false);
		});

		it('should resolve the option once the command is named instead', async () => {
			const state = await parse({
				// `--name=` rather than a bare `--name`, which would be a missing
				// value: what is being shown here is that naming the command puts
				// `--verbose` in the chain, so it is protected rather than consumed
				argv: ['build', '--name=', '--verbose'],
				schema: {
					commands: { build: { default: true, options: { '-v, --verbose': null } } },
					options: { '--name [value]': null },
				},
			});

			expect(state.argv.name).toBe('');
			expect(state.argv.verbose).toBe(true);
		});
	});

	describe('errors', () => {
		afterEach(() => {
			vi.restoreAllMocks();
		});

		it('should fire the beforeError hooks for a default command that throws', async () => {
			const fired: string[] = [];

			const err = await parse({
				argv: [],
				schema: {
					commands: {
						build: {
							args: ['<entry>'],
							default: true,
							hooks: { beforeError: [(e) => void fired.push(`build:${(e as Error).message}`)] },
						},
					},
					hooks: {
						beforeError: [(e) => void fired.push(`global:${(e as Error).message}`)],
					},
				},
			}).catch((e: unknown) => e);

			expect((err as Error).message).toBe('Missing required arguments: <entry>');
			expect(fired).toStrictEqual([
				'build:Missing required arguments: <entry>',
				'global:Missing required arguments: <entry>',
			]);
		});

		it('should fire the default command hooks when its module will not load', async () => {
			// the default joins the chain before its module is loaded, so a module
			// that will not load is still an error the command's own hooks see
			const fired: string[] = [];

			const err = await parse({
				argv: [],
				schema: {
					commands: {
						gone: {
							default: true,
							hooks: { beforeError: [() => void fired.push('gone')] },
							path: path.join(__dirname, 'fixtures/nope.js'),
						},
					},
				},
			}).catch((e: unknown) => e);

			expect((err as Error).message).toMatch(/^Command module not found:/);
			expect(fired).toStrictEqual(['gone']);

			const state = (err as { [ErrorState]?: ParseState })[ErrorState];
			expect(state?.cmd?.name).toBe('gone');
		});

		it('should render an error thrown by the default command run()', async () => {
			const fired: unknown[] = [];
			const chunks: string[] = [];
			const exitCode = process.exitCode;

			vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: string | Uint8Array) => {
				chunks.push(chunk.toString());
				return true;
			}) as typeof process.stderr.write);

			const result = await main2({
				argv: [],
				schema: {
					commands: {
						build: {
							default: true,
							hooks: { beforeError: [(e) => void fired.push(e)] },
							run() {
								throw new Error('build failed');
							},
						},
					},
				},
			});

			vi.restoreAllMocks();

			expect(result).toBeUndefined();
			expect(chunks.join('')).toBe('Error: build failed\n');
			expect((fired[0] as Error).message).toBe('build failed');
			expect(process.exitCode).toBe(1);

			process.exitCode = exitCode;
		});
	});
	// the default joins the context chain like any other command, so every
	// rule decided elsewhere has to keep holding for it
	describe('interaction with the rest of the parser', () => {
		it('should dispatch a default declared with a bare alias list', async () => {
			const state = await parse({
				argv: [],
				schema: { commands: { 'build, b': { default: true }, test: {} } },
			});

			expect(state.cmd?.name).toBe('build');
		});

		it('should still resolve that alias when it is typed', async () => {
			const state = await parse({
				argv: ['b'],
				schema: { commands: { 'build, b': { default: true }, test: {} } },
			});

			expect(state.cmd?.name).toBe('build');
		});

		it('should dispatch a hidden default', async () => {
			const state = await parse({
				argv: [],
				schema: { commands: { build: { default: true, hidden: true } } },
			});

			expect(state.cmd?.name).toBe('build');
			expect(state.cmd?.hidden).toBe(true);
		});

		it('should dispatch a "!" prefixed default', async () => {
			const state = await parse({
				argv: [],
				schema: { commands: { '!build': { default: true } } },
			});

			expect(state.cmd?.name).toBe('build');
		});

		it('should reject a default whose variadic argument is not last', async () => {
			await expect(
				parse({
					argv: [],
					schema: { commands: { build: { args: ['<files...>', '[out]'], default: true } } },
				})
			).rejects.toThrow('Only the last argument can be variadic');
		});

		it("should share a destination between the default's negated twins", async () => {
			const state = await parse({
				argv: ['--no-cheese'],
				schema: {
					commands: {
						build: { default: true, options: { '--cheese [type]': {}, '--no-cheese': {} } },
					},
				},
			});

			expect(state.cmd?.name).toBe('build');
			expect(state.argv.cheese).toBe(false);
		});

		it("should bind a loose value to the default's argument, not to the option", async () => {
			const state = await parse({
				argv: ['--tag', 'a', 'b'],
				schema: {
					commands: {
						build: { args: ['[extra]'], default: true, options: { '--tag [v]': {} } },
					},
				},
			});

			expect(state.argv.tag).toBe('a');
			expect(state.argv.extra).toBe('b');
		});
	});
});
