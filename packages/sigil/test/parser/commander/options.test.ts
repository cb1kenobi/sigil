import { parse } from '../../../src/parser/parse.js';
import { describe, expect, it } from 'vitest';

/**
 * Ported from Commander's option tests: options.bool, options.bool.combo,
 * options.bool.small.combined, options.flags, options.camelcase,
 * options.optional, options.required, options.mandatory, options.twice,
 * options.default, options.env, options.choices, options.custom-processing.
 *
 * Where the expected value differs from Commander's, the divergence is called
 * out in a comment. The recurring ones are that flags default to `false`
 * rather than `undefined`, that `<hint>` makes the option itself required, and
 * that an optional option given no value is `''` rather than `true`.
 */
describe('commander: options', () => {
	describe('boolean options', () => {
		it('should default a flag to false when not specified', async () => {
			// Commander leaves it undefined
			const result = await parse({ schema: { options: { '--pepper': {} } } });
			expect(result.argv.pepper).to.equal(false);
		});

		it('should set a flag to true when specified', async () => {
			const result = await parse({
				argv: ['--pepper'],
				schema: { options: { '--pepper': {} } },
			});
			expect(result.argv.pepper).to.equal(true);
		});

		it('should default a negated flag to true when not specified', async () => {
			const result = await parse({ schema: { options: { '--no-cheese': {} } } });
			expect(result.argv.cheese).to.equal(true);
		});

		it('should set a negated flag to false when specified', async () => {
			const result = await parse({
				argv: ['--no-cheese'],
				schema: { options: { '--no-cheese': {} } },
			});
			expect(result.argv.cheese).to.equal(false);
		});

		it('should resolve a flag declared on a subcommand', async () => {
			const result = await parse({
				argv: ['sub', '--pepper'],
				schema: { commands: { sub: { options: { '--pepper': {} } } } },
			});
			expect(result.cmd?.name).to.equal('sub');
			expect(result.argv.pepper).to.equal(true);
		});

		it('should resolve a negated flag declared on a subcommand', async () => {
			const result = await parse({
				argv: ['sub', '--no-cheese'],
				schema: { commands: { sub: { options: { '--no-cheese': {} } } } },
			});
			expect(result.argv.cheese).to.equal(false);
		});

		it('should coerce a string default on a flag to a boolean', async () => {
			// Commander keeps the raw default; here string defaults are coerced
			// to the declared type, and a flag's type is bool
			const result = await parse({
				schema: { options: { '-v, --olives': { default: 'yes' } } },
			});
			expect(result.argv.olives).to.equal(true);
		});

		it('should reject a string default on a flag that is not a boolean', async () => {
			await expect(
				parse({ schema: { options: { '-v, --olives': { default: 'black' } } } })
			).rejects.toThrow('Invalid boolean: "black"');
		});

		it('should leave a non-string default on a flag alone', async () => {
			const result = await parse({ schema: { options: { '-d, --debug': { default: 0 } } } });
			expect(result.argv.debug).to.equal(0);
		});

		it('should not treat no- in the middle of a name as negation', async () => {
			const result = await parse({
				argv: ['--module-no-parse'],
				schema: { options: { '--module-no-parse': {} } },
			});
			expect(result.argv.moduleNoParse).to.equal(true);
		});

		it('should expand a group of short flags', async () => {
			const result = await parse({
				argv: ['-pc'],
				schema: { options: { '-p, --pepper': {}, '-c, --cheese': {} } },
			});
			expect(result.argv.pepper).to.equal(true);
			expect(result.argv.cheese).to.equal(true);
		});
	});

	describe('negated flag combos', () => {
		const schema = { options: { '--no-pepper': {} } };

		it('should let the positive spelling win when it comes last', async () => {
			const result = await parse({ argv: ['--no-pepper', '--pepper'], schema });
			expect(result.argv.pepper).to.equal(true);
		});

		it('should let the negative spelling win when it comes last', async () => {
			const result = await parse({ argv: ['--pepper', '--no-pepper'], schema });
			expect(result.argv.pepper).to.equal(false);
		});

		it('should register both spellings from one declaration', async () => {
			// Commander needs --pepper and --no-pepper declared separately; here
			// one negated declaration registers both
			const result = await parse({ argv: ['--pepper'], schema });
			expect(result.argv.pepper).to.equal(true);
		});

		it('should give a lone negated flag an implicit default of true', async () => {
			const result = await parse({ schema });
			expect(result.argv.pepper).to.equal(true);
		});
	});

	describe('flag formats', () => {
		it.each([
			['-p,--pepper', '-p'],
			['-p,--pepper', '--pepper'],
			['-p|--pepper', '-p'],
			['-p|--pepper', '--pepper'],
			['-p --pepper', '-p'],
			['-p --pepper', '--pepper'],
			['-p, --pepper', '-p'],
			['-p, --pepper', '--pepper'],
		])('should accept %s and resolve %s', async (format, arg) => {
			const result = await parse({ argv: [arg], schema: { options: { [format]: {} } } });
			expect(result.argv.pepper).to.equal(true);
		});

		it('should use the short name as the destination when only a short is declared', async () => {
			const result = await parse({ argv: ['-p'], schema: { options: { '-p': {} } } });
			expect(result.argv.p).to.equal(true);
		});

		it('should use the first long name as the base name', async () => {
			const result = await parse({
				argv: ['--workspace'],
				schema: { options: { '--ws, --workspace': {} } },
			});
			expect(result.argv.ws).to.equal(true);
		});
	});

	describe('camelCase destinations', () => {
		it.each([
			['--my-option', 'myOption'],
			['--my-oPTION', 'myOPTION'],
			['--my-OPTION', 'myOPTION'],
			['--my-special-option', 'mySpecialOption'],
			['--my-SPECIAL-option', 'mySPECIALOption'],
			['--Myoption', 'Myoption'],
		])('should map %s to %s', async (flag, dest) => {
			const result = await parse({ argv: [flag], schema: { options: { [flag]: {} } } });
			expect(result.argv[dest]).to.equal(true);
		});
	});

	describe('option with an optional value', () => {
		const schema = { options: { '--cheese [type]': {} } };

		it('should be undefined when not specified', async () => {
			const result = await parse({ schema });
			expect(result.argv.cheese).to.equal(undefined);
		});

		it('should take the value when specified', async () => {
			const result = await parse({ argv: ['--cheese', 'blue'], schema });
			expect(result.argv.cheese).to.equal('blue');
		});

		it('should throw when specified without a value', async () => {
			// Commander gives true. `[type]` says the option may be left out, not
			// that its value may be, so using it without one is an error
			await expect(parse({ argv: ['--cheese'], schema })).rejects.toThrow(
				'Missing value for option --cheese'
			);
		});

		it('should be an empty string when given an empty value', async () => {
			const result = await parse({ argv: ['--cheese='], schema });
			expect(result.argv.cheese).to.equal('');
		});

		it('should not eat a following declared option', async () => {
			// the protection holds -- `--some-option` is not taken as the value,
			// which is why `--cheese` is reported as having none
			await expect(
				parse({
					argv: ['--cheese', '--some-option'],
					schema: { options: { '--cheese [type]': {}, '--some-option': {} } },
				})
			).rejects.toThrow('Missing value for option --cheese');
		});

		it('should parse the protected option once cheese has a value', async () => {
			const result = await parse({
				argv: ['--cheese=', '--some-option'],
				schema: { options: { '--cheese [type]': {}, '--some-option': {} } },
			});
			expect(result.argv.cheese).to.equal('');
			expect(result.argv.someOption).to.equal(true);
		});

		it('should prefer an explicitly empty value over a default', async () => {
			// Commander gives true, its default untouched. `--cheese=` is a value,
			// and a value from argv beats a default
			const result = await parse({
				argv: ['--cheese='],
				schema: { options: { '--cheese [type]': { default: 'default' } } },
			});
			expect(result.argv.cheese).to.equal('');
		});
	});

	describe('option with a required value', () => {
		it('should error when not specified at all', async () => {
			// Commander leaves it undefined; here <type> makes the option required
			await expect(parse({ schema: { options: { '--cheese <type>': {} } } })).rejects.toThrow(
				'Missing required options: --cheese'
			);
		});

		it('should take the value when specified', async () => {
			const result = await parse({
				argv: ['--cheese', 'blue'],
				schema: { options: { '--cheese <type>': {} } },
			});
			expect(result.argv.cheese).to.equal('blue');
		});

		it('should error when the value is missing', async () => {
			await expect(
				parse({ argv: ['--cheese'], schema: { options: { '--cheese <type>': {} } } })
			).rejects.toThrow('Missing value for option --cheese');
		});

		it('should be satisfied by a default', async () => {
			const result = await parse({
				schema: { options: { '--cheese <type>': { default: 'default' } } },
			});
			expect(result.argv.cheese).to.equal('default');
		});

		it('should be satisfied by an environment variable', async () => {
			const result = await parse({
				env: { FOO: 'bar' },
				schema: { options: { '-p, --port <number>': { env: 'FOO' } } },
			});
			expect(result.argv.port).to.equal('bar');
		});

		it('should still error when the value is missing even with a default', async () => {
			await expect(
				parse({
					argv: ['--cheese'],
					schema: { options: { '--cheese <type>': { default: 'default' } } },
				})
			).rejects.toThrow('Missing value for option --cheese');
		});
	});

	describe('required options and subcommands', () => {
		it('should resolve a required parent option used before a subcommand', async () => {
			const result = await parse({
				argv: ['--cheese', 'blue', 'sub'],
				schema: { options: { '--cheese <type>': {} }, commands: { sub: {} } },
			});
			expect(result.cmd?.name).to.equal('sub');
			expect(result.argv.cheese).to.equal('blue');
		});

		it('should error when a required parent option is missing and a subcommand runs', async () => {
			await expect(
				parse({
					argv: ['sub'],
					schema: { options: { '--cheese <type>': {} }, commands: { sub: {} } },
				})
			).rejects.toThrow('Missing required options: --cheese');
		});

		it('should error when a matched subcommand has an unsatisfied required option', async () => {
			await expect(
				parse({
					argv: ['sub'],
					schema: { commands: { sub: { options: { '--subby <type>': {} } } } },
				})
			).rejects.toThrow('Missing required options: --subby');
		});

		it('should ignore a required option on a subcommand that never matched', async () => {
			const result = await parse({
				argv: ['sub2'],
				schema: { commands: { sub: { options: { '--subby <type>': {} } }, sub2: {} } },
			});
			expect(result.cmd?.name).to.equal('sub2');
			expect(result.argv.subby).to.equal(undefined);
		});
	});

	describe('repeated options', () => {
		it('should keep true when a flag is repeated', async () => {
			const result = await parse({
				argv: ['-d', '-d'],
				schema: { options: { '-d, --debug': {} } },
			});
			expect(result.argv.debug).to.equal(true);
		});

		it('should take the second value for an option with a required value', async () => {
			const result = await parse({
				argv: ['-p', '1', '-p', '2'],
				schema: { options: { '-p, --port <port-number>': {} } },
			});
			expect(result.argv.port).to.equal('2');
		});

		it('should throw on a valueless repeat', async () => {
			// Commander gives true for the second use. A second `--donate` with
			// nothing after it is as much a missing value as a first one
			await expect(
				parse({
					argv: ['--donate', '123', '--donate'],
					schema: { options: { '--donate [amount]': {} } },
				})
			).rejects.toThrow('Missing value for option --donate');
		});

		it('should let an explicitly empty repeat overwrite an earlier value', async () => {
			const result = await parse({
				argv: ['--donate', '123', '--donate='],
				schema: { options: { '--donate [amount]': {} } },
			});
			expect(result.argv.donate).to.equal('');
		});

		it('should let a later value overwrite an earlier empty', async () => {
			const result = await parse({
				argv: ['--donate=', '--donate', '123'],
				schema: { options: { '--donate [amount]': {} } },
			});
			expect(result.argv.donate).to.equal('123');
		});

		it('should collect a multiple option instead of overwriting', async () => {
			const result = await parse({
				argv: ['--tag', 'a', '--tag', 'b'],
				schema: { options: { '--tag <t>': { multiple: true } } },
			});
			expect(result.argv.tag).to.deep.equal(['a', 'b']);
		});

		it('should count repeats of a count flag', async () => {
			const result = await parse({
				argv: ['-v', '-v', '-v'],
				schema: { options: { '-v, --verbose': { type: 'count' } } },
			});
			expect(result.argv.verbose).to.equal(3);
		});

		it('should count a short group of a count flag', async () => {
			const result = await parse({
				argv: ['-vvv'],
				schema: { options: { '-v, --verbose': { type: 'count' } } },
			});
			expect(result.argv.verbose).to.equal(3);
		});
	});

	describe('attached values', () => {
		it('should split a long option on =', async () => {
			const result = await parse({
				argv: ['--pepper=blue'],
				schema: { options: { '-p, --pepper <t>': {} } },
			});
			expect(result.argv.pepper).to.equal('blue');
		});

		it('should split a short option on =', async () => {
			// Commander only splits long options, so it would see the value "=blue"
			const result = await parse({
				argv: ['-p=blue'],
				schema: { options: { '-p, --pepper <t>': {} } },
			});
			expect(result.argv.pepper).to.equal('blue');
		});

		it('should take the rest of a short group as the value', async () => {
			const result = await parse({
				argv: ['-pblue'],
				schema: { options: { '-p, --pepper <t>': {} } },
			});
			expect(result.argv.pepper).to.equal('blue');
		});
	});

	describe('defaults and environment', () => {
		it('should use a default when neither argv nor env supply a value', async () => {
			const result = await parse({
				schema: { options: { '-f, --foo <v>': { env: 'BAR', default: 'default' } } },
			});
			expect(result.argv.foo).to.equal('default');
		});

		it('should prefer an environment variable over a default', async () => {
			const result = await parse({
				env: { BAR: 'env' },
				schema: { options: { '-f, --foo <v>': { env: 'BAR', default: 'default' } } },
			});
			expect(result.argv.foo).to.equal('env');
		});

		it('should use an environment variable when there is no default', async () => {
			const result = await parse({
				env: { BAR: 'env' },
				schema: { options: { '-f, --foo <v>': { env: 'BAR' } } },
			});
			expect(result.argv.foo).to.equal('env');
		});

		it('should prefer argv over both', async () => {
			const result = await parse({
				argv: ['--foo', 'cli'],
				env: { BAR: 'env' },
				schema: { options: { '-f, --foo <v>': { env: 'BAR', default: 'default' } } },
			});
			expect(result.argv.foo).to.equal('cli');
		});

		// These deliberately differ from Commander, which treats any string at
		// all — including '' and 'false' — as true.
		it('should coerce an environment value for a flag', async () => {
			const result = await parse({
				env: { BAR: 'false' },
				schema: { options: { '-f, --foo': { env: 'BAR' } } },
			});
			expect(result.argv.foo).to.equal(false);
		});

		it('should treat a 0 environment value for a flag as false', async () => {
			const result = await parse({
				env: { BAR: '0' },
				schema: { options: { '-f, --foo': { env: 'BAR' } } },
			});
			expect(result.argv.foo).to.equal(false);
		});

		it('should reject an environment value for a flag that is not a boolean', async () => {
			await expect(
				parse({
					env: { BAR: 'sometimes' },
					schema: { options: { '-f, --foo': { env: 'BAR' } } },
				})
			).rejects.toThrow('Invalid boolean: "sometimes"');
		});
	});

	describe('choices', () => {
		it('should accept a value in choices', async () => {
			const result = await parse({
				argv: ['--colour', 'red'],
				schema: { options: { '--colour <shade>': { choices: ['red', 'blue'] } } },
			});
			expect(result.argv.colour).to.equal('red');
		});

		it('should reject a value not in choices', async () => {
			await expect(
				parse({
					argv: ['--colour', 'orange'],
					schema: { options: { '--colour <shade>': { choices: ['red', 'blue'] } } },
				})
			).rejects.toThrow('Invalid value "orange" for option --colour');
		});
	});

	describe('custom processing', () => {
		it('should use the value returned by transform', async () => {
			const result = await parse({
				argv: ['--port', '80'],
				schema: {
					options: {
						'--port <n>': {
							async transform(v) {
								return Number(v) * 2;
							},
						},
					},
				},
			});
			expect(result.argv.port).to.equal(160);
		});

		it('should not call transform when the option is not specified', async () => {
			let called = false;
			const result = await parse({
				schema: {
					options: {
						'--port <n>': {
							default: 'D',
							async transform() {
								called = true;
							},
						},
					},
				},
			});
			expect(called).to.equal(false);
			expect(result.argv.port).to.equal('D');
		});

		it('should run transform before type coercion', async () => {
			const result = await parse({
				argv: ['--port', '1e2'],
				schema: {
					options: {
						'--port <n>': {
							type: 'number',
							async transform(v) {
								return `${v}`;
							},
						},
					},
				},
			});
			expect(result.argv.port).to.equal(100);
		});

		it('should call transform for each occurrence of a multiple option', async () => {
			const seen: unknown[] = [];
			const result = await parse({
				argv: ['-c', 'a', '-c', 'b', '-c', 'c'],
				schema: {
					options: {
						'-c, --collect <v>': {
							multiple: true,
							async transform(v) {
								seen.push(v);
								return v;
							},
						},
					},
				},
			});
			expect(seen).to.deep.equal(['a', 'b', 'c']);
			expect(result.argv.collect).to.deep.equal(['a', 'b', 'c']);
		});

		it('should let transform split a comma separated list', async () => {
			const result = await parse({
				argv: ['--list', 'x,y,z'],
				schema: {
					options: {
						'--list <items>': {
							async transform(v) {
								return `${v}`.split(',');
							},
						},
					},
				},
			});
			expect(result.argv.list).to.deep.equal(['x', 'y', 'z']);
		});
	});
});
