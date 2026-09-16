import { parse } from '../../../src/parser/parse.js';
import { describe, expect, it } from 'vitest';

/**
 * Ported from Commander's argument tests: argument.required,
 * argument.variadic, args.variadic, argument.choices,
 * argument.custom-processing, args.literal, command.allowExcessArguments,
 * command.argumentVariations.
 */
describe('commander: arguments', () => {
	describe('required and optional', () => {
		it('should treat <name> as required', async () => {
			await expect(parse({ schema: { args: ['<file>'] } })).rejects.toThrow(
				'Missing required arguments: <file>'
			);
		});

		it('should treat [name] as optional', async () => {
			const result = await parse({ schema: { args: ['[file]'] } });
			expect(result.argv.file).to.equal(undefined);
		});

		it('should treat a bare name as optional', async () => {
			// Commander treats a bare name as required
			const result = await parse({ schema: { args: ['file'] } });
			expect(result.argv.file).to.equal(undefined);
		});

		it('should let an explicit required override the brackets', async () => {
			await expect(
				parse({ schema: { args: [{ name: '[file]', required: true }] } })
			).rejects.toThrow('Missing required arguments: <file>');
		});

		it('should satisfy a required argument from a default', async () => {
			// Commander rejects a default on a required argument outright
			const result = await parse({ schema: { args: [{ name: '<file>', default: 'd' }] } });
			expect(result.argv.file).to.equal('d');
		});
	});

	describe('variadic arguments', () => {
		it('should collect the remaining values', async () => {
			const result = await parse({
				argv: ['id', 'a', 'b', 'c'],
				schema: { args: ['<id>', '[rest...]'] },
			});
			expect(result.argv.id).to.equal('id');
			expect(result.argv.rest).to.deep.equal(['a', 'b', 'c']);
		});

		it('should leave a variadic undefined when nothing is left', async () => {
			// Commander gives an empty array
			const result = await parse({ argv: ['id'], schema: { args: ['<id>', '[rest...]'] } });
			expect(result.argv.id).to.equal('id');
			expect(result.argv.rest).to.equal(undefined);
		});

		it('should collect for a subcommand', async () => {
			const result = await parse({
				argv: ['sub', 'a', 'b', 'c'],
				schema: { commands: { 'sub [rest...]': {} } },
			});
			expect(result.cmd?.name).to.equal('sub');
			expect(result.argv.rest).to.deep.equal(['a', 'b', 'c']);
		});

		it('should use a given value instead of appending to a default array', async () => {
			const result = await parse({
				argv: ['one', 'two'],
				schema: { args: [{ name: '[value...]', default: ['DEFAULT'] }] },
			});
			expect(result.argv.value).to.deep.equal(['one', 'two']);
		});

		it('should fall back to a default array when nothing is given', async () => {
			const result = await parse({
				schema: { args: [{ name: '[value...]', default: ['DEFAULT'] }] },
			});
			expect(result.argv.value).to.deep.equal(['DEFAULT']);
		});

		it('should wrap a single choice value in an array', async () => {
			const result = await parse({
				argv: ['one'],
				schema: { args: [{ name: '<value...>', choices: ['one', 'two'] }] },
			});
			expect(result.argv.value).to.deep.equal(['one']);
		});

		it('should validate every value of a variadic against choices', async () => {
			const result = await parse({
				argv: ['one', 'two'],
				schema: { args: [{ name: '<value...>', choices: ['one', 'two'] }] },
			});
			expect(result.argv.value).to.deep.equal(['one', 'two']);
		});

		it('should reject a variadic argument that is not last', async () => {
			await expect(parse({ schema: { args: ['<rest...>', '[extra]'] } })).rejects.toThrow(
				'Only the last argument can be variadic'
			);
		});
	});

	describe('choices', () => {
		it('should accept a value in choices', async () => {
			const result = await parse({
				argv: ['sm'],
				schema: { args: [{ name: '<size>', choices: ['sm', 'lg'] }] },
			});
			expect(result.argv.size).to.equal('sm');
		});

		it('should reject a value not in choices', async () => {
			await expect(
				parse({ argv: ['xl'], schema: { args: [{ name: '<size>', choices: ['sm', 'lg'] }] } })
			).rejects.toThrow('Invalid value "xl" for argument <size>');
		});
	});

	describe('custom processing', () => {
		it('should use the value returned by transform', async () => {
			const result = await parse({
				argv: ['1e2'],
				schema: {
					args: [
						{
							name: '<n>',
							async transform(v) {
								return Number(v);
							},
						},
					],
				},
			});
			expect(result.argv.n).to.equal(100);
		});

		it('should not call transform when the argument is not specified', async () => {
			let called = false;
			const result = await parse({
				schema: {
					args: [
						{
							name: '[n]',
							default: 'start',
							async transform() {
								called = true;
							},
						},
					],
				},
			});
			expect(called).to.equal(false);
			expect(result.argv.n).to.equal('start');
		});

		it('should hand a variadic transform the whole array', async () => {
			let seen: unknown;
			const result = await parse({
				argv: ['a', 'b'],
				schema: {
					args: [
						{
							name: '[v...]',
							async transform(value) {
								seen = value;
								return (value as string[]).map((s) => s.toUpperCase());
							},
						},
					],
				},
			});
			expect(seen).to.deep.equal(['a', 'b']);
			expect(result.argv.v).to.deep.equal(['A', 'B']);
		});

		it('should run transform before type coercion', async () => {
			const result = await parse({
				argv: ['7'],
				schema: {
					args: [
						{
							name: '<n>',
							type: 'int',
							async transform(v) {
								return `${v}0`;
							},
						},
					],
				},
			});
			expect(result.argv.n).to.equal(70);
		});
	});

	describe('the -- terminator', () => {
		it('should stop processing options', async () => {
			const result = await parse({
				argv: ['--foo', '--', '--bar', 'baz'],
				schema: {
					args: [{ name: 'rest', multiple: true }],
					options: { '-f, --foo': {}, '-b, --bar': {} },
				},
				settings: { allowExtraArguments: true },
			});
			expect(result.argv.foo).to.equal(true);
			expect(result.argv.bar).to.equal(false);
			expect(result._).to.deep.equal(['--bar', 'baz']);
		});

		it('should pass through further terminators verbatim', async () => {
			const result = await parse({
				argv: ['--', 'cmd', '--', '--arg'],
				schema: { args: [{ name: 'rest', multiple: true }] },
				settings: { allowExtraArguments: true },
			});
			expect(result._).to.deep.equal(['cmd', '--', '--arg']);
		});

		it('should leave a known flag after the terminator as an operand', async () => {
			const result = await parse({
				argv: ['--', '--foo'],
				schema: { args: [{ name: 'rest', multiple: true }], options: { '--foo': {} } },
				settings: { allowExtraArguments: true },
			});
			expect(result.argv.foo).to.equal(false);
			expect(result._).to.deep.equal(['--foo']);
		});

		it('should require allowExtraArguments', async () => {
			await expect(parse({ argv: ['--', 'rest'], schema: {} })).rejects.toThrow(
				'Extra arguments are not allowed: rest'
			);
		});
	});

	describe('excess arguments', () => {
		it('should reject an excess argument by default', async () => {
			await expect(parse({ argv: ['excess'] })).rejects.toThrow('Unexpected argument "excess"');
		});

		it('should reject an excess argument after a declared one', async () => {
			await expect(
				parse({ argv: ['file', 'excess'], schema: { args: ['<file>'] } })
			).rejects.toThrow('Unexpected argument "excess"');
		});

		it('should reject an excess argument for a subcommand', async () => {
			await expect(
				parse({ argv: ['sub', 'excess'], schema: { commands: { sub: {} } } })
			).rejects.toThrow('Unexpected argument "excess"');
		});

		it('should allow excess arguments when the setting is on', async () => {
			const result = await parse({
				argv: ['excess'],
				settings: { allowUnexpectedArguments: true },
			});
			expect(result._).to.deep.equal(['excess']);
		});

		it('should not call anything excess when a variadic absorbs it', async () => {
			const result = await parse({
				argv: ['file1', 'file2', 'file3'],
				schema: { args: ['[files...]'] },
			});
			expect(result.argv.files).to.deep.equal(['file1', 'file2', 'file3']);
		});
	});

	describe('argument variations', () => {
		it('should combine inline command arguments with declared properties', async () => {
			const result = await parse({
				argv: ['sub', 'a', 'b', 'c'],
				schema: { commands: { 'sub <first> [second] [rest...]': {} } },
			});
			expect(result.argv.first).to.equal('a');
			expect(result.argv.second).to.equal('b');
			expect(result.argv.rest).to.deep.equal(['c']);
		});
	});
});
