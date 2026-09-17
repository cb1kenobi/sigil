import { initOption } from '../../src/parser/option/init-option.js';
import { parse } from '../../src/parser/parse.js';
import {
	Internal,
	Option,
	type ParseState,
	type Schema,
	type Transformer,
} from '../../src/types.js';
import { describe, it, expect } from 'vitest';

describe('options', () => {
	describe('Error Handling', () => {
		it('should error if options is invalid', async () => {
			await expect(
				parse({
					schema: {
						options: 123 as any,
					},
				})
			).rejects.toThrow(new TypeError('Expected options to be an object'));

			await expect(
				parse({
					schema: {
						options: null as any,
					},
				})
			).rejects.toThrow(new TypeError('Expected options to be an object'));
		});

		it('should error if option is invalid', async () => {
			await expect(
				parse({
					schema: {
						options: {
							foo: 123 as any,
						},
					},
				})
			).rejects.toThrow(new TypeError('Expected option to be an object'));
		});

		it('should error if format is invalid', async () => {
			await expect(
				parse({
					schema: {
						options: {
							'': null,
						},
					},
				})
			).rejects.toThrow(new TypeError('Expected option format to be a non-empty string'));

			await expect(
				parse({
					schema: {
						options: {
							'--f(': null,
						},
					},
				})
			).rejects.toThrow(new TypeError('Invalid option format: --f('));

			await expect(
				parse({
					schema: {
						options: {
							'--f"': null,
						},
					},
				})
			).rejects.toThrow(new TypeError('Invalid option format: --f"'));

			await expect(
				parse({
					schema: {
						options: {
							"--f'": null,
						},
					},
				})
			).rejects.toThrow(new TypeError("Invalid option format: --f'"));
		});

		it('should error if the hint is variadic', async () => {
			const err = new TypeError(
				'Option "files" hint cannot be variadic; use `multiple: true` to collect repeated uses into an array'
			);

			await expect(
				parse({
					schema: {
						options: {
							'--files <files...>': null,
						},
					},
				})
			).rejects.toThrow(err);

			await expect(
				parse({
					schema: {
						options: {
							'--files': { hint: 'files...' },
						},
					},
				})
			).rejects.toThrow(err);
		});

		it('should error if option transform is invalid', async () => {
			await expect(
				parse({
					schema: {
						options: {
							'--foo': {
								transform: 'bar' as any,
							},
						},
					},
				})
			).rejects.toThrow('Expected option transform function to be a function');
		});

		it('should error if option env is invalid', async () => {
			await expect(
				parse({
					schema: {
						options: {
							'--foo': {
								env: 123 as any,
							},
						},
					},
				})
			).rejects.toThrow(
				new TypeError('Expected option environment variable to be a string or array of strings')
			);
		});
	});

	describe('format', () => {
		it('should use long option for the name', async () => {
			const result = await parse({
				schema: {
					options: {
						'--force': null,
					},
				},
			});
			const { options } = result.contexts[0][Internal];
			const force = options.get('force');
			expect(force).to.deep.equal({
				default: false,
				format: '--force',
				name: 'force',
				type: 'bool',
			});
			expect(force?.[Internal].short.has('--force')).to.equal(false);
			expect(force?.[Internal].long.has('--force')).to.equal(true);
			expect(force?.[Internal].label).to.equal('--force');
		});

		it('should parse short and long options', async () => {
			const result = await parse({
				schema: {
					options: {
						'-f, --force | --forced': 'Use the force',
					},
				},
			});
			const { options } = result.contexts[0][Internal];
			const force = options.get('force');
			expect(force).to.deep.equal({
				default: false,
				desc: 'Use the force',
				format: '-f, --force | --forced',
				name: 'force',
				type: 'bool',
			});
			expect(force?.[Internal].short.has('-f')).to.equal(true);
			expect(force?.[Internal].short.has('--force')).to.equal(false);
			expect(force?.[Internal].long.has('-f')).to.equal(false);
			expect(force?.[Internal].long.has('--force')).to.equal(true);
			expect(force?.[Internal].long.has('--forced')).to.equal(true);
			expect(force?.[Internal].label).to.equal('--force');
		});

		it('should parse short option with name in object', async () => {
			const result = await parse({
				schema: {
					options: {
						'-f': {
							name: 'force',
						},
					},
				},
			});
			const { options } = result.contexts[0][Internal];
			const force = options.get('force');
			expect(force).to.deep.equal({
				default: false,
				format: '-f',
				name: 'force',
				type: 'bool',
			});
			expect(force?.[Internal].short.has('-f')).to.equal(true);
			expect(force?.[Internal].short.has('--force')).to.equal(false);
			expect(force?.[Internal].long.has('-f')).to.equal(false);
			expect(force?.[Internal].long.has('--force')).to.equal(false);
		});

		it('should parse name from format', async () => {
			const result = await parse({
				schema: {
					options: {
						force: {},
					},
				},
			});
			const { options } = result.contexts[0][Internal];
			const force = options.get('force');
			expect(force).to.deep.equal({
				default: false,
				format: 'force',
				name: 'force',
				type: 'bool',
			});
			expect(force?.[Internal].long.has('--force')).to.equal(true);
		});

		it('should parse short and long option with required value', async () => {
			const result = await parse({
				argv: ['--directory', '/foo'],
				schema: {
					options: {
						'-d, --directory <path>': {},
					},
				},
			});
			const { options } = result.contexts[0][Internal];
			const dir = options.get('directory');
			expect(dir).to.deep.equal({
				format: '-d, --directory <path>',
				hint: 'path',
				name: 'directory',
				required: true,
				type: 'string',
			});
			expect(dir?.[Internal].short.has('-d')).to.equal(true);
			expect(dir?.[Internal].long.has('--directory')).to.equal(true);
		});

		it('should parse short and long option with option value', async () => {
			const result = await parse({
				schema: {
					options: {
						'-d, --directory [path]': {},
					},
				},
			});
			const { options } = result.contexts[0][Internal];
			const dir = options.get('directory');
			expect(dir).to.deep.equal({
				format: '-d, --directory [path]',
				hint: 'path',
				name: 'directory',
				type: 'string',
			});
			expect(dir?.[Internal].short.has('-d')).to.equal(true);
			expect(dir?.[Internal].long.has('--directory')).to.equal(true);
		});

		it('should parse ignore dupes', async () => {
			const result = await parse({
				schema: {
					options: {
						'--foo --bar --foo --bar': {},
					},
				},
			});
			const { options } = result.contexts[0][Internal];
			const dir = options.get('foo');
			expect(dir).to.deep.equal({
				default: false,
				format: '--foo --bar --foo --bar',
				name: 'foo',
				type: 'bool',
			});
			expect(dir?.[Internal].long.has('--foo')).to.equal(true);
			expect(dir?.[Internal].long.has('--bar')).to.equal(true);
		});
	});

	describe('multiple', () => {
		it('should parse multiple option value', async () => {
			const result = await parse({
				argv: ['--include', 'foo'],
				schema: {
					options: {
						'--include <file>': {
							multiple: true,
						},
					},
				},
			});
			const { options } = result.contexts[0][Internal];
			const inc = options.get('include');
			expect(inc).to.deep.equal({
				format: '--include <file>',
				hint: 'file',
				multiple: true,
				name: 'include',
				required: true,
				type: 'string',
			});
			expect(inc?.[Internal].long.has('--include')).to.equal(true);
		});
	});

	describe('negate', () => {
		it('should parse negated option', async () => {
			const result = await parse({
				schema: {
					options: {
						'--no-colors': {},
					},
				},
			});
			const { options } = result.contexts[0][Internal];
			const colors = options.get('colors');
			expect(colors).to.deep.equal({
				default: true,
				format: '--no-colors',
				name: 'colors',
				negate: true,
				type: 'bool',
			});
			expect(colors?.[Internal].long.has('--no-colors')).to.equal(true);
		});

		it('should parse auto negate option', async () => {
			let result = await parse({
				argv: ['--no-colors'],
				schema: {
					options: {
						'--no-colors': {},
					},
				},
			});
			expect(result.argv.colors).to.equal(false);

			result = await parse({
				schema: {
					options: {
						'--no-colors': {},
					},
				},
			});
			expect(result.argv.colors).to.equal(true);
		});

		it('should parse negated option', async () => {
			let result = await parse({
				argv: ['--no-colors'],
				schema: {
					options: {
						colors: {
							negate: true,
						},
					},
				},
			});
			expect(result.argv.colors).to.equal(false);

			result = await parse({
				schema: {
					options: {
						colors: {
							negate: false,
						},
					},
				},
			});
			expect(result.argv.colors).to.equal(false);
		});
	});

	describe('negated aliases', () => {
		it('should negate through a short alias', async () => {
			const result = await parse({
				argv: ['-C'],
				schema: { options: { '-C, --no-colors': {} } },
			});
			expect(result.argv.colors).to.equal(false);
		});

		it('should still turn a negated flag on through the positive spelling', async () => {
			const result = await parse({
				argv: ['--colors'],
				schema: { options: { '-C, --no-colors': {} } },
			});
			expect(result.argv.colors).to.equal(true);
		});

		it('should not negate a flag that suppressed negation', async () => {
			const result = await parse({
				argv: ['--no-colors'],
				schema: { options: { '--no-colors': { negate: false } } },
			});
			// `negate: false` means the `no-` is part of the name, so the flag is
			// simply present
			expect(result.argv.noColors).to.equal(true);
		});

		it('should let an explicit value beat the name it was reached by', async () => {
			const result = await parse({
				argv: ['-C=false'],
				schema: { options: { '-C, --no-colors': {} } },
			});
			expect(result.argv.colors).to.equal(true);
		});
	});

	/**
	 * A valued option and its negated flag declared separately — Commander's
	 * "dual options" — resolve to the same name and the same destination. They
	 * are two options keyed apart in the registry, so both survive in either
	 * declaration order, and the valued twin owns the destination's default.
	 */
	describe('dual options', () => {
		type Order = [string, Record<string, Option>];

		const orders: Order[] = [
			['valued first', { '--cheese <type>': {}, '--no-cheese': {} }],
			['negated first', { '--no-cheese': {}, '--cheese <type>': {} }],
		];

		const optional: Order[] = [
			['valued first', { '--cheese [type]': {}, '--no-cheese': {} }],
			['negated first', { '--no-cheese': {}, '--cheese [type]': {} }],
		];

		const defaulted: Order[] = [
			['valued first', { '--cheese [type]': { default: 'mozzarella' }, '--no-cheese': {} }],
			['negated first', { '--no-cheese': {}, '--cheese [type]': { default: 'mozzarella' } }],
		];

		const flagDefault: Order[] = [
			['valued first', { '--cheese [type]': {}, '--no-cheese': { default: true } }],
			['negated first', { '--no-cheese': { default: true }, '--cheese [type]': {} }],
		];

		const flags: Order[] = [
			['positive first', { '--cheese': {}, '--no-cheese': {} }],
			['negated first', { '--no-cheese': {}, '--cheese': {} }],
		];

		const shorts: Order[] = [
			['valued first', { '-c, --cheese <type>': {}, '-C, --no-cheese': {} }],
			['negated first', { '-C, --no-cheese': {}, '-c, --cheese <type>': {} }],
		];

		const envs: Order[] = [
			[
				'valued first',
				{ '--cheese [type]': { env: 'CHEESE' }, '--no-cheese': { env: 'NO_CHEESE' } },
			],
			[
				'negated first',
				{ '--no-cheese': { env: 'NO_CHEESE' }, '--cheese [type]': { env: 'CHEESE' } },
			],
		];

		// `help: false` because the count is the point: the parser's own `--help`
		// would be a third option and say nothing about the pairing
		it.each(orders)('should register both options, %s', async (_label, options) => {
			const result = await parse({ argv: ['--no-cheese'], schema: { help: false, options } });
			const { options: registry } = result.contexts[0][Internal];
			expect(registry.size).to.equal(2);
			expect(registry.find('--cheese')?.hint).to.equal('type');
			expect(registry.find('--no-cheese')?.negate).to.equal(true);
			expect(registry.find('--cheese')?.[Internal].dest).to.equal(
				registry.find('--no-cheese')?.[Internal].dest
			);
		});

		it.each(orders)('should set the value from the valued twin, %s', async (_label, options) => {
			const result = await parse({ argv: ['--cheese', 'blue'], schema: { options } });
			expect(result.argv.cheese).to.equal('blue');
		});

		it.each(orders)(
			'should turn the destination off with the flag, %s',
			async (_label, options) => {
				// the flag also satisfies the requirement the valued twin declares
				const result = await parse({ argv: ['--no-cheese'], schema: { options } });
				expect(result.argv.cheese).to.equal(false);
			}
		);

		it.each(orders)('should keep the valued twin required, %s', async (_label, options) => {
			await expect(parse({ schema: { options } })).rejects.toThrow(
				'Missing required options: --cheese'
			);
		});

		it.each(orders)('should still demand a value for --cheese, %s', async (_label, options) => {
			await expect(parse({ argv: ['--cheese'], schema: { options } })).rejects.toThrow(
				'Missing value for option --cheese'
			);
		});

		it.each(defaulted)('should let the valued twin own the default, %s', async (_l, options) => {
			const result = await parse({ schema: { options } });
			expect(result.argv.cheese).to.equal('mozzarella');
		});

		it.each(optional)('should not imply a boolean default, %s', async (_label, options) => {
			const result = await parse({ schema: { options } });
			expect(result.argv.cheese).to.equal(undefined);
		});

		it.each(flagDefault)('should keep a default declared on the flag, %s', async (_l, options) => {
			const result = await parse({ schema: { options } });
			expect(result.argv.cheese).to.equal(true);
		});

		it.each(flags)('should pair two flags, %s', async (_label, options) => {
			expect((await parse({ schema: { options } })).argv.cheese).to.equal(false);
			expect((await parse({ argv: ['--cheese'], schema: { options } })).argv.cheese).to.equal(true);
			expect((await parse({ argv: ['--no-cheese'], schema: { options } })).argv.cheese).to.equal(
				false
			);
		});

		it.each(shorts)('should keep the short name of each twin, %s', async (_label, options) => {
			expect((await parse({ argv: ['-c', 'blue'], schema: { options } })).argv.cheese).to.equal(
				'blue'
			);
			expect((await parse({ argv: ['-C'], schema: { options } })).argv.cheese).to.equal(false);
		});

		it.each(envs)('should let the valued twin win the environment, %s', async (_l, options) => {
			const result = await parse({
				env: { CHEESE: 'brie', NO_CHEESE: 'true' },
				schema: { options },
			});
			expect(result.argv.cheese).to.equal('brie');
		});

		it.each([
			['valued first', { '--cheese <type>': {}, '--no-cheese': { default: false } }],
			['negated first', { '--no-cheese': { default: false }, '--cheese <type>': {} }],
		] as Order[])(
			'should let a default on the flag satisfy the requirement, %s',
			async (_label, options) => {
				const result = await parse({ schema: { options } });
				expect(result.argv.cheese).to.equal(false);
			}
		);

		it.each([
			['valued first', { '--cheese <type>': {}, '--no-cheese': { env: 'NO_CHEESE' } }],
			['negated first', { '--no-cheese': { env: 'NO_CHEESE' }, '--cheese <type>': {} }],
		] as Order[])(
			'should let the environment on the flag satisfy the requirement, %s',
			async (_label, options) => {
				const result = await parse({ env: { NO_CHEESE: 'false' }, schema: { options } });
				expect(result.argv.cheese).to.equal(false);
			}
		);

		it.each([
			['valued first', { '--cheese [type]': { choices: ['brie', 'gouda'] }, '--no-cheese': {} }],
			['negated first', { '--no-cheese': {}, '--cheese [type]': { choices: ['brie', 'gouda'] } }],
		] as Order[])('should let the flag out of the choices, %s', async (_label, options) => {
			expect((await parse({ argv: ['--no-cheese'], schema: { options } })).argv.cheese).to.equal(
				false
			);
			expect(
				(await parse({ argv: ['--cheese', 'brie'], schema: { options } })).argv.cheese
			).to.equal('brie');
			await expect(parse({ argv: ['--cheese', 'blue'], schema: { options } })).rejects.toThrow(
				'Invalid value "blue" for option --cheese'
			);
		});

		it.each([
			[
				'valued first',
				{ '--cheese [type]': { default: 'mozzarella' }, '--no-cheese': { env: 'NO_CHEESE' } },
			],
			[
				'negated first',
				{ '--no-cheese': { env: 'NO_CHEESE' }, '--cheese [type]': { default: 'mozzarella' } },
			],
		] as Order[])(
			'should let the environment on either twin beat a default on the other, %s',
			async (_label, options) => {
				const result = await parse({ env: { NO_CHEESE: 'false' }, schema: { options } });
				expect(result.argv.cheese).to.equal(false);
			}
		);

		it.each([
			[
				'valued first',
				{ '--cheese [type]': { choices: ['brie', 'gouda'], type: 'auto' }, '--no-cheese': {} },
			],
			[
				'negated first',
				{ '--no-cheese': {}, '--cheese [type]': { choices: ['brie', 'gouda'], type: 'auto' } },
			],
		] as Order[])(
			'should still check a value of its own against choices, %s',
			async (_label, options) => {
				// the twin exemption is for the `false` the flag produces, not for
				// every false the valued option could parse for itself
				expect((await parse({ argv: ['--no-cheese'], schema: { options } })).argv.cheese).to.equal(
					false
				);
				await expect(parse({ argv: ['--cheese', 'false'], schema: { options } })).rejects.toThrow(
					'Invalid value "false" for option --cheese'
				);
			}
		);

		it.each([
			['valued first', { '--cheese [type]': { choices: ['brie'] }, '--no-cheese': {} }],
			['negated first', { '--no-cheese': {}, '--cheese [type]': { choices: ['brie'] } }],
		] as Order[])(
			'should let the flag turn off a value that was already given, %s',
			async (_label, options) => {
				// the flag wrote the destination last, so the `false` on it is the flag's
				// and answers to the flag rather than to the valued twin's choices. This
				// threw `Invalid value "false" for option --cheese` on a legal command line.
				expect(
					(await parse({ argv: ['--cheese', 'brie', '--no-cheese'], schema: { options } })).argv
						.cheese
				).to.equal(false);

				// and the other way round, which always worked
				expect(
					(await parse({ argv: ['--no-cheese', '--cheese', 'brie'], schema: { options } })).argv
						.cheese
				).to.equal('brie');
			}
		);

		it.each([
			[
				'valued first',
				{ '--cheese [type]': { choices: ['brie'], default: false }, '--no-cheese': {} },
			],
			[
				'negated first',
				{ '--no-cheese': {}, '--cheese [type]': { choices: ['brie'], default: false } },
			],
		] as Order[])(
			'should check a default of its own against choices even with a twin, %s',
			async (_label, options) => {
				// the valued twin owns the destination's default, so the `false` on it is
				// its own and is not the flag's exemption. Having a twin used to excuse it,
				// which made one declaration fine or an error depending on the pairing.
				await expect(parse({ argv: [], schema: { options } })).rejects.toThrow(
					'Invalid value "false" for option --cheese'
				);
			}
		);

		it('should check a value a hook wrote itself', async () => {
			// a value that did not come through the parser has no writer to attribute it
			// to, so every declaration that can reach the destination checks it. Only
			// validating a value you wrote would otherwise make a hook a way around
			// `choices`.
			await expect(
				parse({
					argv: [],
					schema: {
						help: false,
						options: { '--cheese [type]': { choices: ['brie'] }, '--no-cheese': {} },
						hooks: {
							beforeParse: [
								(state) => {
									state.argv.cheese = 'gouda';
								},
							],
						},
					},
				})
			).rejects.toThrow('Invalid value "gouda" for option --cheese');
		});

		it('should let the last of two identical declarations win', async () => {
			const result = await parse({
				argv: ['-c', 'blue'],
				schema: { help: false, options: { '--cheese <type>': {}, '-c, --cheese <kind>': {} } },
			});
			const { options } = result.contexts[0][Internal];
			expect(options.size).to.equal(1);
			expect(options.find('--cheese')?.hint).to.equal('kind');
			expect(result.argv.cheese).to.equal('blue');
		});

		it('should not pair a flag whose negation was suppressed', async () => {
			const result = await parse({
				argv: ['--cheese', 'blue'],
				schema: {
					help: false,
					options: { '--cheese <type>': {}, '--no-cheese': { negate: false } },
				},
			});
			const { options } = result.contexts[0][Internal];
			expect(options.size).to.equal(2);
			expect(result.argv.cheese).to.equal('blue');
			// `negate: false` opts out of the pairing, so it keeps its own
			// destination rather than sharing `cheese`
			expect(result.argv.noCheese).to.equal(false);
		});

		// pairing has to hold alongside the two option decisions that landed
		// separately: an option takes one value, and `bool` is strict
		it.each(orders)('should still take only one value, %s', async (_label, options) => {
			const result = await parse({
				argv: ['--cheese', 'blue', 'extra'],
				schema: { args: ['[extra]'], options },
			});
			expect(result.argv.cheese).to.equal('blue');
			expect(result.argv.extra).to.equal('extra');
		});

		it.each(orders)(
			'should let the negated twin satisfy a required %s',
			async (_label, options) => {
				expect((await parse({ argv: ['--no-cheese'], schema: { options } })).argv.cheese).to.equal(
					false
				);
				await expect(parse({ argv: [], schema: { options } })).rejects.toThrow(
					'Missing required options: --cheese'
				);
			}
		);

		it.each([
			['valued first', { '--cheese [type]': { type: 'bool' }, '--no-cheese': {} }],
			['negated first', { '--no-cheese': {}, '--cheese [type]': { type: 'bool' } }],
		] as Order[])('should coerce a bool twin strictly, %s', async (_label, options) => {
			expect((await parse({ argv: ['--cheese=0'], schema: { options } })).argv.cheese).to.equal(
				false
			);
			await expect(parse({ argv: ['--cheese=maybe'], schema: { options } })).rejects.toThrow();
		});
	});

	describe('type', () => {
		it('should error if option definition type is invalid', async () => {
			await expect(
				parse({
					schema: {
						options: {
							'--foo': {
								type: 'bar',
							},
						},
					},
				})
			).rejects.toThrow('Option "foo" has unsupported data type "bar"');
		});

		it('should parse option with auto type', async () => {
			const schema = {
				options: {
					'--foo <bar>': {
						type: 'auto',
					},
				},
			};

			let result = await parse({
				argv: ['--foo', 'true'],
				schema,
			});
			expect(result.argv).to.deep.equal({
				foo: true,
			});

			result = await parse({
				argv: ['--foo', 'false'],
				schema,
			});
			expect(result.argv).to.deep.equal({
				foo: false,
			});

			const now = new Date();

			result = await parse({
				argv: ['--foo', now.toISOString()],
				schema,
			});
			expect(result.argv).to.deep.equal({
				foo: now,
			});

			const nowFormatted = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(
				2,
				'0'
			)}-${String(now.getDate()).padStart(2, '0')}`;
			const now2 = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0);

			result = await parse({
				argv: ['--foo', nowFormatted],
				schema,
			});
			expect(result.argv).to.deep.equal({
				foo: now2,
			});

			result = await parse({
				argv: ['--foo', '123'],
				schema,
			});
			expect(result.argv).to.deep.equal({
				foo: 123,
			});

			result = await parse({
				argv: ['--foo', '3.14'],
				schema,
			});
			expect(result.argv).to.deep.equal({
				foo: 3.14,
			});

			result = await parse({
				argv: ['--foo', '{"bar": "baz"}'],
				schema,
			});
			expect(result.argv).to.deep.equal({
				foo: { bar: 'baz' },
			});

			result = await parse({
				argv: ['--foo', 'bar'],
				schema,
			});
			expect(result.argv).to.deep.equal({
				foo: 'bar',
			});
		});

		it('should parse long option as boolean', async () => {
			const schema = {
				options: {
					'--foo <bar>': {
						type: 'bool',
					},
				},
			};

			let result = await parse({
				argv: ['--foo', 'true'],
				schema,
			});
			expect(result.argv).to.deep.equal({
				foo: true,
			});

			result = await parse({
				argv: ['--foo', 'no'],
				schema,
			});
			expect(result.argv).to.deep.equal({
				foo: false,
			});

			result = await parse({
				argv: ['--foo', 'false'],
				schema,
			});
			expect(result.argv).to.deep.equal({
				foo: false,
			});

			await expect(
				parse({
					argv: ['--foo', 'baz'],
					schema,
				})
			).rejects.toThrow('Invalid boolean: "baz"');
		});

		it('should parse short option as boolean', async () => {
			const schema = {
				options: {
					'-f <bar>': {
						type: 'bool',
					},
				},
			};

			let result = await parse({
				argv: ['-f', 'true'],
				schema,
			});
			expect(result.argv).to.deep.equal({
				f: true,
			});

			result = await parse({
				argv: ['-f', 'no'],
				schema,
			});
			expect(result.argv).to.deep.equal({
				f: false,
			});

			result = await parse({
				argv: ['-f', 'false'],
				schema,
			});
			expect(result.argv).to.deep.equal({
				f: false,
			});

			await expect(
				parse({
					argv: ['-f', 'baz'],
					schema,
				})
			).rejects.toThrow('Invalid boolean: "baz"');
		});

		it('should accept every boolean value on a valued option', async () => {
			const schema = { options: { '--foo <bar>': { type: 'bool' } } };

			for (const input of ['true', 't', 'yes', 'y', 'on', '1', 'ON', 'Y']) {
				const result = await parse({ argv: ['--foo', input], schema });
				expect(result.argv.foo, input).to.equal(true);
			}

			for (const input of ['false', 'f', 'no', 'n', 'off', '0', 'OFF', 'N']) {
				const result = await parse({ argv: ['--foo', input], schema });
				expect(result.argv.foo, input).to.equal(false);
			}
		});

		it('should parse option as date', async () => {
			const schema = {
				options: {
					'--foo <bar>': {
						type: 'date',
					},
				},
			};

			const now = new Date();
			const nowFormatted = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(
				2,
				'0'
			)}-${String(now.getDate()).padStart(2, '0')}`;
			const now2 = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0);

			let result = await parse({
				argv: ['--foo', `${now.getTime()}`],
				schema,
			});
			expect(result.argv).to.deep.equal({
				foo: now,
			});

			result = await parse({
				argv: ['--foo', now.toISOString()],
				schema,
			});
			expect(result.argv).to.deep.equal({
				foo: now,
			});

			result = await parse({
				argv: ['--foo', nowFormatted],
				schema,
			});
			expect(result.argv).to.deep.equal({
				foo: now2,
			});

			await expect(
				parse({
					argv: ['--foo', '9999-99-99'],
					schema,
				})
			).rejects.toThrow('Invalid date: "9999-99-99"');
		});

		it('should parse option as integer', async () => {
			const schema = {
				options: {
					'--foo <bar>': {
						type: 'int',
					},
				},
			};

			const result = await parse({
				argv: ['--foo', '123'],
				schema,
			});
			expect(result.argv).to.deep.equal({
				foo: 123,
			});

			await expect(
				parse({
					argv: ['--foo', '1.23'],
					schema,
				})
			).rejects.toThrow('Invalid integer: 1.23');

			await expect(
				parse({
					argv: ['--foo', 'foo'],
					schema,
				})
			).rejects.toThrow('Invalid integer: foo');
		});

		it('should parse option as json', async () => {
			const schema = {
				options: {
					'--foo <bar>': {
						type: 'json',
					},
				},
			};

			const result = await parse({
				argv: ['--foo', '{"bar":"baz"}'],
				schema,
			});
			expect(result.argv).to.deep.equal({
				foo: { bar: 'baz' },
			});

			await expect(
				parse({
					argv: ['--foo', '{{{'],
					schema,
				})
			).rejects.toThrow(/^Invalid JSON:/);
		});

		it('should parse option as number', async () => {
			const schema = {
				options: {
					'--foo <bar>': {
						type: 'number',
					},
				},
			};

			let result = await parse({
				argv: ['--foo', '123'],
				schema,
			});
			expect(result.argv).to.deep.equal({
				foo: 123,
			});

			result = await parse({
				argv: ['--foo', '3.14'],
				schema,
			});
			expect(result.argv).to.deep.equal({
				foo: 3.14,
			});

			await expect(
				parse({
					argv: ['--foo', 'foo'],
					schema,
				})
			).rejects.toThrow('Invalid number: foo');
		});

		it('should parse option as yes/no boolean', async () => {
			const schema = {
				options: {
					'--foo <bar>': {
						type: 'yesno',
					},
				},
			};

			let result = await parse({
				argv: ['--foo', 'yes'],
				schema,
			});
			expect(result.argv).to.deep.equal({
				foo: true,
			});

			result = await parse({
				argv: ['--foo', 'no'],
				schema,
			});
			expect(result.argv).to.deep.equal({
				foo: false,
			});

			await expect(
				parse({
					argv: ['--foo', 'foo'],
					schema,
				})
			).rejects.toThrow('Value must be "yes" or "no"');
		});
	});

	describe('type (flag)', () => {
		it('should error if short option definition type is invalid', async () => {
			await expect(
				parse({
					schema: {
						options: {
							'--foo': {
								type: 'bar',
							},
						},
					},
				})
			).rejects.toThrow('Option "foo" has unsupported data type "bar"');

			await expect(
				parse({
					schema: {
						options: {
							'--foo': {
								type: 'int',
							},
						},
					},
				})
			).rejects.toThrow("Option flags must have type of 'auto', 'bool', 'count', or 'yesno'");
		});

		it('should parse flag with auto type', async () => {
			const result = await parse({
				argv: ['--foo'],
				schema: {
					options: {
						'--foo': {
							type: 'auto',
						},
					},
				},
			});
			expect(result.argv).to.deep.equal({
				foo: true,
			});
		});

		it('should parse long option as boolean', async () => {
			const result = await parse({
				argv: ['--foo'],
				schema: {
					options: {
						'--foo': {
							type: 'bool',
						},
					},
				},
			});
			expect(result.argv).to.deep.equal({
				foo: true,
			});
		});

		it('should parse long option as yes/no boolean', async () => {
			const result = await parse({
				argv: ['--foo'],
				schema: {
					options: {
						'--foo': {
							type: 'yesno',
						},
					},
				},
			});
			expect(result.argv).to.deep.equal({
				foo: true,
			});
		});

		it('should accept every truthy value for a flag', async () => {
			for (const input of ['true', 'True', 'TRUE', 't', 'yes', 'YES', 'y', 'on', '1']) {
				const result = await parse({
					argv: [`--foo=${input}`],
					schema: { options: { '--foo': { type: 'bool' } } },
				});
				expect(result.argv.foo, input).to.equal(true);
			}
		});

		it('should accept every falsey value for a flag', async () => {
			for (const input of ['false', 'False', 'FALSE', 'f', 'no', 'NO', 'n', 'off', '0', '']) {
				const result = await parse({
					argv: [`--foo=${input}`],
					schema: { options: { '--foo': { type: 'bool' } } },
				});
				expect(result.argv.foo, input).to.equal(false);
			}
		});

		it('should reject a flag value that is not a boolean', async () => {
			for (const input of ['baz', 'ture', '2', 'null']) {
				await expect(
					parse({
						argv: [`--foo=${input}`],
						schema: { options: { '--foo': { type: 'bool' } } },
					})
				).rejects.toThrow(`Invalid boolean: "${input}"`);
			}
		});

		it('should let a negated flag invert an explicit boolean value', async () => {
			const schema = { options: { '--no-cheese': {} } };

			for (const input of ['no', 'false', '0', 'off', '']) {
				const result = await parse({ argv: [`--no-cheese=${input}`], schema });
				expect(result.argv.cheese, input).to.equal(true);
			}

			for (const input of ['yes', 'true', '1', 'on']) {
				const result = await parse({ argv: [`--no-cheese=${input}`], schema });
				expect(result.argv.cheese, input).to.equal(false);
			}
		});

		it('should reject a negated flag value that is not a boolean', async () => {
			await expect(
				parse({ argv: ['--no-cheese=maybe'], schema: { options: { '--no-cheese': {} } } })
			).rejects.toThrow('Invalid boolean: "maybe"');
		});

		it('should not lose no/yes when a yesno flag is normalized to bool', async () => {
			const schema = { options: { '--foo': { type: 'yesno' } } };

			let result = await parse({ argv: ['--foo=no'], schema });
			expect(result.argv.foo).to.equal(false);

			result = await parse({ argv: ['--foo=yes'], schema });
			expect(result.argv.foo).to.equal(true);
		});

		it("should error if option is not a flag and has type 'count'", async () => {
			await expect(
				parse({
					schema: {
						options: {
							'--foo <value>': {
								type: 'count',
							},
						},
					},
				})
			).rejects.toThrow('Only flags can be of type "count"');
		});

		it('should count multiple instances of a flag', async () => {
			const result = await parse({
				argv: ['-vvvvv'],
				schema: {
					options: {
						'-v, --verbose': {
							type: 'count',
						},
					},
				},
			});
			expect(result.argv.verbose).to.equal(5);
		});

		// a counter already collects repeated uses, and the two properties were read
		// by code paths that disagreed: `-v -v` counted to 2 while an unused `-v`
		// came back as `[0]`, so the value changed shape depending on argv
		it("should error if a counter also declares 'multiple'", async () => {
			const err = new TypeError(
				'Option "verbose" cannot be a counter and collect; `type: \'count\'` already counts repeated uses'
			);

			await expect(
				parse({
					argv: ['-vv'],
					schema: {
						options: {
							'-v, --verbose': { multiple: true, type: 'count' },
						},
					},
				})
			).rejects.toThrow(err);
		});

		it('should error before argv is read, so an unused counter is rejected too', async () => {
			await expect(
				parse({
					argv: [],
					schema: {
						options: {
							'-v, --verbose': { multiple: true, type: 'count' },
						},
					},
				})
			).rejects.toThrow('cannot be a counter and collect');
		});

		// `multiple: false` is not asking for anything, so there is nothing to reject
		it("should allow a counter that declares 'multiple' false", async () => {
			const result = await parse({
				argv: ['-vv'],
				schema: {
					options: {
						'-v, --verbose': { multiple: false, type: 'count' },
					},
				},
			});
			expect(result.argv.verbose).to.equal(2);
		});

		// `multiple` stays editable after init -- it is read on every parse -- so the
		// shape has to hold at the point of use and not only at the declaration
		it('should not wrap a counter a hook made multiple', async () => {
			const schema: Schema = {
				commands: {
					build: {
						options: { '-v, --verbose': { type: 'count' } },
						hooks: {
							init: [
								({ options }) => {
									options.find('-v')!.multiple = true;
								},
							],
						},
					},
				},
			};

			expect((await parse({ argv: ['build'], schema })).argv.verbose).to.equal(0);
			expect((await parse({ argv: ['build', '-vv'], schema })).argv.verbose).to.equal(2);
		});

		// a counter is an int that argv increments rather than writes, so a value
		// arriving from anywhere else is coerced the same way
		it('should coerce a counter that comes from the environment', async () => {
			const result = await parse({
				argv: [],
				env: { VERBOSE: '3' },
				schema: {
					options: { '-v, --verbose': { env: 'VERBOSE', type: 'count' } },
				},
			});
			expect(result.argv.verbose).to.equal(3);
		});

		it('should coerce a counter with a string default', async () => {
			const result = await parse({
				argv: [],
				schema: { options: { '-v, --verbose': { default: '3', type: 'count' } } },
			});
			expect(result.argv.verbose).to.equal(3);
		});

		it('should reject a counter value that is not a number', async () => {
			await expect(
				parse({
					argv: [],
					env: { VERBOSE: 'lots' },
					schema: {
						options: { '-v, --verbose': { env: 'VERBOSE', type: 'count' } },
					},
				})
			).rejects.toThrow('Invalid count: lots');
		});

		// a counter is a flag, and `bool` -- the other flag type -- reads an empty
		// value as false, so an environment variable that is set and says nothing is 0
		it('should read an empty counter value as zero', async () => {
			const result = await parse({
				argv: [],
				env: { VERBOSE: '' },
				schema: { options: { '-v, --verbose': { env: 'VERBOSE', type: 'count' } } },
			});
			expect(result.argv.verbose).to.equal(0);
		});

		// a transform runs before coercion, so it cannot hand a counter a string either
		it('should reject a transform that takes a counter off a number', async () => {
			await expect(
				parse({
					argv: ['-v'],
					schema: {
						options: {
							'-v, --verbose': { transform: async () => 'lots', type: 'count' },
						},
					},
				})
			).rejects.toThrow('Invalid count: lots');
		});
	});

	describe('aliases', () => {
		it("should register a single alias '--bar'", async () => {
			const result = await parse({
				schema: {
					options: {
						'--foo': {
							alias: '--bar',
						},
					},
				},
			});
			const { options } = result.contexts[0][Internal];
			const inc = options.get('foo');
			expect(inc).to.deep.equal({
				alias: '--bar',
				default: false,
				format: '--foo',
				name: 'foo',
				type: 'bool',
			});
			expect(inc?.[Internal].long.has('--foo')).to.equal(true);
			expect(inc?.[Internal].long.has('--bar')).to.equal(true);
		});

		it("should register a single alias 'bar'", async () => {
			const result = await parse({
				schema: {
					options: {
						'--foo': {
							alias: 'bar',
						},
					},
				},
			});
			const { options } = result.contexts[0][Internal];
			const inc = options.get('foo');
			expect(inc).to.deep.equal({
				alias: 'bar',
				default: false,
				format: '--foo',
				name: 'foo',
				type: 'bool',
			});
			expect(inc?.[Internal].long.has('--foo')).to.equal(true);
			expect(inc?.[Internal].long.has('--bar')).to.equal(true);
		});

		it('should register multiple aliases as a string', async () => {
			const result = await parse({
				schema: {
					options: {
						'--foo': {
							alias: '--bar, --baz',
						},
					},
				},
			});
			const { options } = result.contexts[0][Internal];
			const inc = options.get('foo');
			expect(inc).to.deep.equal({
				alias: '--bar, --baz',
				default: false,
				format: '--foo',
				name: 'foo',
				type: 'bool',
			});
			expect(inc?.[Internal].long.has('--foo')).to.equal(true);
			expect(inc?.[Internal].long.has('--bar')).to.equal(true);
			expect(inc?.[Internal].long.has('--baz')).to.equal(true);
		});

		it('should register multiple aliases as an array', async () => {
			const result = await parse({
				schema: {
					options: {
						'--foo': {
							alias: ['-f', '--bar', '--baz'],
						},
					},
				},
			});
			const { options } = result.contexts[0][Internal];
			const inc = options.get('foo');
			expect(inc).to.deep.equal({
				alias: ['-f', '--bar', '--baz'],
				default: false,
				format: '--foo',
				name: 'foo',
				type: 'bool',
			});
			expect(inc?.[Internal].short.has('-f')).to.equal(true);
			expect(inc?.[Internal].long.has('--foo')).to.equal(true);
			expect(inc?.[Internal].long.has('--bar')).to.equal(true);
			expect(inc?.[Internal].long.has('--baz')).to.equal(true);
		});

		it('should error if alias is invalid', async () => {
			await expect(
				parse({
					schema: {
						options: {
							'--foo': {
								alias: 123 as any,
							},
						},
					},
				})
			).rejects.toThrow(new TypeError('Expected option alias to be a string or list of strings'));

			await expect(
				parse({
					schema: {
						options: {
							'--foo': {
								alias: [null, 123] as any,
							},
						},
					},
				})
			).rejects.toThrow(new TypeError('Expected option alias to be a string or list of strings'));

			await expect(
				parse({
					schema: {
						options: {
							'--foo': {
								alias: '-',
							},
						},
					},
				})
			).rejects.toThrow(new TypeError('Invalid option alias "-"'));
		});
	});

	describe('parse', () => {
		it('should error if option is unknown', async () => {
			await expect(
				parse({
					argv: ['--foo'],
					settings: { allowUnknownOptions: false },
				})
			).rejects.toThrow('Unknown option "--foo"');
		});

		// an undeclared option's value was guessed with `auto` and reached argv without
		// the declared type, `choices`, `multiple`, or `transform`, so it does not get
		// to overwrite a destination something declared
		it('should not let an undeclared option overwrite a declared destination', async () => {
			const result = await parse({
				argv: ['--verbose'],
				schema: { help: false, options: { '-v': { name: 'verbose', type: 'count' } } },
			});

			// `-v` is declared short-only with an explicit name, so `--verbose` is not one
			// of its spellings -- but `verbose` is the destination it owns
			expect(result.argv.verbose).to.equal(0);
			// and what was typed is still there for anything that wants it
			expect(result.$.some((parsed) => parsed.type === 'UnknownOption')).to.equal(true);
		});

		// an argument's `transform` runs while the parsed values are being walked and may
		// add an option, so what owns a destination cannot be decided before the walk
		it('should not let an undeclared option overwrite an option a transform added', async () => {
			const result = await parse({
				argv: ['seed', '--tag', '007'],
				schema: {
					help: false,
					args: [
						{
							name: '[seed]',
							transform: (async (value, state) => {
								const { options } = (state as ParseState).contexts[0][Internal];
								await options.add(await initOption({ format: '--tag [t]', type: 'string' }));
								return value;
							}) as Transformer,
						},
					],
				},
			});

			// `--tag` is declared `string`; the undeclared write had `auto` make it the
			// number 7, and used to land anyway
			expect(Object.hasOwn(result.argv, 'tag')).to.equal(false);
			expect(result.argv.seed).to.equal('seed');
		});

		// only the innermost context's arguments are read, so an ancestor's own
		// arguments own nothing once a subcommand is dispatched: dropping the value
		// protected a destination that was never going to be filled
		it('should let an undeclared option through when only an ancestor declares the argument', async () => {
			const result = await parse({
				argv: ['build', '--mode', 'x'],
				schema: { help: false, args: ['[mode]'], commands: { build: {} } },
			});

			expect(result.argv.mode).to.equal('x');
		});

		it('should not let an undeclared option overwrite an argument destination', async () => {
			const result = await parse({
				argv: ['--mode', 'fast'],
				schema: { help: false, args: [{ name: 'mode', choices: ['slow'] }] },
			});

			expect(Object.hasOwn(result.argv, 'mode')).to.equal(false);
		});

		it('should still produce a value for an undeclared option that collides with nothing', async () => {
			const result = await parse({
				argv: ['--other', 'x'],
				schema: { help: false, options: { '--real': {} } },
			});

			expect(result.argv).to.deep.equal({ other: 'x', real: false });
		});

		it('should parse a flag using long name', async () => {
			const result = await parse({
				argv: ['--foo'],
				schema: {
					options: {
						'--foo': {},
					},
				},
			});

			expect(result.argv.foo).to.equal(true);
		});

		it('should default flags to false', async () => {
			const result = await parse({
				schema: {
					options: {
						'--foo': {},
					},
				},
			});

			expect(result.argv.foo).to.equal(false);
		});

		it('should parse a short flag', async () => {
			const result = await parse({
				argv: ['-f'],
				schema: {
					options: {
						'-f, --foo': {},
					},
				},
			});

			expect(result.argv.foo).to.equal(true);
		});

		it('should parse a short flag with name', async () => {
			const schema = {
				options: {
					'-f': { name: 'foo' },
				},
			};
			const result = await parse({
				argv: ['-f'],
				schema,
			});

			expect(result.argv.foo).to.equal(true);

			await expect(
				parse({
					argv: ['--foo'],
					schema,
					settings: { allowUnknownOptions: false },
				})
			).rejects.toThrow('Unknown option "--foo"');
		});

		it('should parse several short flags', async () => {
			const result = await parse({
				argv: ['-fgh'],
				schema: {
					options: {
						'-f, --foo': {},
						'-g, --bar': {},
						'-h, --baz': {},
					},
				},
			});

			expect(result.argv.foo).to.equal(true);
			expect(result.argv.bar).to.equal(true);
			expect(result.argv.baz).to.equal(true);
		});

		it('should parse an option with arg value', async () => {
			const result = await parse({
				argv: ['--output-dir', 'dist'],
				schema: {
					options: {
						'--output-dir <path>': {},
					},
				},
			});
			expect(result.argv.outputDir).to.equal('dist');
		});

		it('should parse an option with = value', async () => {
			const result = await parse({
				argv: ['--output-dir=dist'],
				schema: {
					options: {
						'--output-dir <path>': {},
					},
				},
			});
			expect(result.argv.outputDir).to.equal('dist');
		});

		it('should parse an option with immediate quoted value', async () => {
			const schema = {
				options: {
					'-m, --message <msg>': {},
				},
			};

			let result = await parse({
				argv: ['--message"hello"'],
				schema,
			});
			expect(result.argv.message).to.equal('hello');

			result = await parse({
				argv: ["--message'hello'"],
				schema,
			});
			expect(result.argv.message).to.equal('hello');

			result = await parse({
				argv: ['-m"hello"'],
				schema,
			});
			expect(result.argv.message).to.equal('hello');

			result = await parse({
				argv: ["-m'hello'"],
				schema,
			});
			expect(result.argv.message).to.equal('hello');
		});

		it('should parse several short flags followed by a value', async () => {
			const result = await parse({
				argv: ['-fgh', 'a.txt'],
				schema: {
					options: {
						'-f, --foo': {},
						'-g, --bar': {},
						'-h, --baz <file>': {},
					},
				},
			});

			expect(result.argv.foo).to.equal(true);
			expect(result.argv.bar).to.equal(true);
			expect(result.argv.baz).to.equal('a.txt');
		});

		it('should parse several short flags followed by an equals value', async () => {
			const result = await parse({
				argv: ['-fgh=a.txt'],
				schema: {
					options: {
						'-f, --foo': {},
						'-g, --bar': {},
						'-h, --baz <file>': {},
					},
				},
			});

			expect(result.argv.foo).to.equal(true);
			expect(result.argv.bar).to.equal(true);
			expect(result.argv.baz).to.equal('a.txt');
		});

		it('should error if a required option is missing', async () => {
			await expect(
				parse({
					argv: [],
					schema: {
						options: {
							'--foo <bar>': '',
						},
					},
				})
			).rejects.toThrow('Missing required options: --foo');
		});

		it('should error if invalid option choice', async () => {
			await expect(
				parse({
					argv: ['--foo', 'baz'],
					schema: {
						options: {
							'--foo <bar>': {
								choices: ['bar', 'wiz'],
							},
						},
					},
				})
			).rejects.toThrow('Invalid value "baz" for option --foo');
		});

		it('should use default if required option is not specified', async () => {
			const result = await parse({
				schema: {
					options: {
						'--output <path>': {
							default: 'dist',
						},
					},
				},
			});
			expect(result.argv.output).to.equal('dist');
		});

		it('should try to default to a single env variable', async () => {
			const result = await parse({
				env: {
					OUTPUT: 'dist',
				},
				schema: {
					options: {
						'--output [path]': {
							env: 'OUTPUT',
						},
					},
				},
			});

			expect(result.argv.output).to.equal('dist');
		});

		it('should try to default to multiple env variables', async () => {
			const result = await parse({
				env: {
					OUTPUT: 'dist',
				},
				schema: {
					options: {
						'--output <path>': {
							env: ['DIST', 'OUTPUT'],
						},
					},
				},
			});

			expect(result.argv.output).to.equal('dist');
		});

		it('should overwrite multiple instances of same option if not multiple', async () => {
			const result = await parse({
				argv: ['-f', 'a.txt', '-f', 'b.txt', '--file', 'c.txt'],
				schema: {
					options: {
						'-f, --file <path>': {},
					},
				},
			});

			expect(result.argv.file).to.equal('c.txt');
		});

		it('should parse multiple instances of same option', async () => {
			const result = await parse({
				argv: ['-f', 'a.txt', '-f', 'b.txt', '--file', 'c.txt'],
				schema: {
					options: {
						'-f, --file <path>': {
							multiple: true,
						},
					},
				},
			});

			expect(result.argv.file).to.deep.equal(['a.txt', 'b.txt', 'c.txt']);
		});
	});

	describe('transform', () => {
		it('should fire argument callback on parse', async () => {
			const result = await parse({
				argv: ['--foo', 'a'],
				schema: {
					options: {
						'--foo <bar>': {
							foo: 'BC',
							async transform(value) {
								if (typeof value === 'string') {
									return value.toUpperCase() + (this as Option).foo;
								}
							},
						},
					},
				},
			});
			expect(result.argv).to.deep.equal({
				foo: 'ABC',
			});
		});

		it('should not transform transformed values', async () => {
			const now = Date.now();
			const result = await parse({
				argv: ['--foo', 'a'],
				schema: {
					options: {
						'--foo <bar>': {
							type: 'date',
							async transform(value) {
								if (typeof value === 'string') {
									return now;
								}
							},
						},
					},
				},
			});
			expect(result.argv).to.deep.equal({
				foo: now,
			});
		});
	});
});
