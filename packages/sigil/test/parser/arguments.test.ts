import { parse } from '../../src/parser/parse.js';
import { Argument } from '../../src/types.js';
import { describe, it, expect } from 'vitest';

describe('arguments', () => {
	describe('Error Handling', () => {
		it('should error if argument list is not an array', async () => {
			await expect(
				parse({
					schema: {
						args: null as any,
					},
				})
			).rejects.toThrow('Expected arguments to be an array');

			await expect(
				parse({
					schema: {
						args: 123 as any,
					},
				})
			).rejects.toThrow('Expected arguments to be an array');
		});

		it('should error if argument definition is not an object', async () => {
			await expect(
				parse({
					schema: {
						args: [null as any],
					},
				})
			).rejects.toThrow('Invalid argument definition: null');

			await expect(
				parse({
					schema: {
						args: [123 as any],
					},
				})
			).rejects.toThrow('Invalid argument definition: 123');
		});

		it('should error if argument name is invalid', async () => {
			await expect(
				parse({
					schema: {
						args: [{ name: undefined as any }],
					},
				})
			).rejects.toThrow('Expected argument to have a name');

			await expect(
				parse({
					schema: {
						args: [{ name: '' }],
					},
				})
			).rejects.toThrow('Expected argument to have a name');

			await expect(
				parse({
					schema: {
						args: [{ name: '\n' }],
					},
				})
			).rejects.toThrow('Invalid argument name: "\\n"');
		});

		it('should error if argument definition type is invalid', async () => {
			await expect(
				parse({
					schema: {
						args: [
							{
								name: 'foo',
								type: 'bar',
							},
						],
					},
				})
			).rejects.toThrow('Argument "foo" has unsupported data type "bar"');
		});

		it('should error if argument transform is invalid', async () => {
			await expect(
				parse({
					schema: {
						args: [
							{
								name: 'foo',
								transform: 'bar' as any,
							},
						],
					},
				})
			).rejects.toThrow('Expected argument transform function to be a function');
		});

		it('should error if env is invalid', async () => {
			await expect(
				parse({
					schema: {
						args: [
							{
								name: 'foo',
								env: 123 as any,
							},
						],
					},
				})
			).rejects.toThrow(
				'Expected argument environment variable to be a string or array of strings'
			);
		});
	});

	describe('parse', () => {
		it('should not error with no args', async () => {
			let result = await parse();
			expect(result.$).to.deep.equal([]);
			expect(result._).to.deep.equal([]);
			expect(result.argv).to.deep.equal({});

			result = await parse();
			expect(result._).to.deep.equal([]);
			expect(result.argv).to.deep.equal({});
		});

		it('should error if argument is unexpected', async () => {
			await expect(
				parse({
					argv: ['a'],
				})
			).rejects.toThrow('Unexpected argument "a"');
		});

		it('should handle unnamed arguments', async () => {
			const result = await parse({
				argv: ['a', 'b', 'c'],
				settings: {
					allowUnexpectedArguments: true,
				},
			});
			expect(result._).to.deep.equal(['a', 'b', 'c']);
			expect(result.argv).to.deep.equal({});
		});

		it('should handle named arguments', async () => {
			const result = await parse({
				argv: ['a', 'b', 'c'],
				schema: {
					args: ['first', 'second'],
				},
				settings: {
					allowUnexpectedArguments: true,
				},
			});
			expect(result._).to.deep.equal(['a', 'b', 'c']);
			expect(result.argv).to.deep.equal({
				first: 'a',
				second: 'b',
			});
		});

		it('should error if required argument is missing', async () => {
			await expect(
				parse({
					schema: {
						args: ['<a>'],
					},
				})
			).rejects.toThrow('Missing required arguments: <a>');
		});

		it('should error if required argument is missing after optional argument', async () => {
			await expect(
				parse({
					schema: {
						args: ['a', '<b>', 'c'],
					},
				})
			).rejects.toThrow('Missing required arguments: <a> <b>');
		});

		it('should not error if required argument has default', async () => {
			const result = await parse({
				env: {
					FOO: 'bar',
				},
				schema: {
					args: [{ name: 'foo', env: 'FOO', required: true }],
				},
			});

			expect(result.argv.foo).to.equal('bar');
		});

		it('should try to default to a single env variable', async () => {
			const result = await parse({
				env: {
					FOO: 'bar',
				},
				schema: {
					args: [{ name: 'foo', env: 'FOO' }],
				},
			});

			expect(result.argv.foo).to.equal('bar');
		});

		it('should try to default to multiple env variables', async () => {
			const result = await parse({
				env: {
					BAR: 'baz',
				},
				schema: {
					args: [{ name: 'foo', env: ['FOO', 'BAR'] }],
				},
			});

			expect(result.argv.foo).to.equal('baz');
		});

		it('should allow extra arguments', async () => {
			const result = await parse({
				argv: ['--', 'a', 'b', 'c'],
				settings: {
					allowExtraArguments: true,
				},
			});
			expect(result._).to.deep.equal(['a', 'b', 'c']);
			expect(result.argv).to.deep.equal({});
		});

		it('should error if extra arguments are not allowed', async () => {
			await expect(
				parse({
					argv: ['--', 'a', 'b', 'c'],
				})
			).rejects.toThrow('Extra arguments are not allowed: a b c');
		});

		it('should capture multiple arguments as an array', async () => {
			let result = await parse({
				argv: ['a', 'b', 'c'],
				schema: {
					args: ['first', 'letters...'],
				},
			});
			expect(result._).to.deep.equal(['a', 'b', 'c']);
			expect(result.argv).to.deep.equal({
				first: 'a',
				letters: ['b', 'c'],
			});

			result = await parse({
				argv: ['a', 'b', 'c'],
				schema: {
					args: [
						{ name: 'first', required: true },
						{ name: 'letters', multiple: true },
					],
				},
			});
			expect(result._).to.deep.equal(['a', 'b', 'c']);
			expect(result.argv).to.deep.equal({
				first: 'a',
				letters: ['b', 'c'],
			});
		});

		it('should allow argument name that is a number', async () => {
			const result = await parse({
				argv: ['a'],
				schema: {
					args: [{ name: 123 as any }],
				},
			});
			expect(result._).to.deep.equal(['a']);
			expect(result.argv).to.deep.equal({
				'123': 'a',
			});
		});

		it('should apply defaults to optional arguments', async () => {
			const result = await parse({
				argv: ['a', 'b'],
				schema: {
					args: [
						'a',
						'[b]',
						{
							default: 'foo',
							name: '[c]',
						},
					],
				},
			});
			expect(result._).to.deep.equal(['a', 'b']);
			expect(result.argv).to.deep.equal({
				a: 'a',
				b: 'b',
				c: 'foo',
			});
		});

		it('should camel case argv name', async () => {
			const result = await parse({
				argv: ['dist'],
				schema: {
					args: ['output-dir'],
				},
			});
			expect(result._).to.deep.equal(['dist']);
			expect(result.argv).to.deep.equal({
				outputDir: 'dist',
			});
		});
	});

	describe('transform', () => {
		it('should fire argument callback on parse', async () => {
			const result = await parse({
				argv: ['a'],
				schema: {
					args: [
						{
							name: 'a',
							foo: 'BC',
							async transform(value): Promise<string | undefined> {
								if (typeof value === 'string') {
									return value.toUpperCase() + (this as Argument).foo;
								}
							},
						},
					],
				},
			});
			expect(result._).to.deep.equal(['ABC']);
			expect(result.argv).to.deep.equal({
				a: 'ABC',
			});
		});

		it('should not transform transformed values', async () => {
			const now = Date.now();
			const result = await parse({
				argv: ['a'],
				schema: {
					args: [
						{
							name: 'a',
							type: 'date',
							async transform(value) {
								if (typeof value === 'string') {
									return now;
								}
							},
						},
					],
				},
			});
			expect(result._).to.deep.equal([now]);
			expect(result.argv).to.deep.equal({
				a: now,
			});
		});
	});

	describe('type', () => {
		it('should automatically parse simple data types', async () => {
			const schema = {
				args: [
					{
						name: 'foo',
						type: 'auto',
					},
				],
			};

			let result = await parse({
				argv: ['true'],
				schema,
			});
			expect(result._).to.deep.equal([true]);
			expect(result.argv).to.deep.equal({
				foo: true,
			});

			result = await parse({
				argv: ['false'],
				schema,
			});
			expect(result._).to.deep.equal([false]);
			expect(result.argv).to.deep.equal({
				foo: false,
			});

			const now = new Date();

			result = await parse({
				argv: [now.toISOString()],
				schema,
			});
			expect(result._).to.deep.equal([now]);
			expect(result.argv).to.deep.equal({
				foo: now,
			});

			const nowFormatted = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(
				2,
				'0'
			)}-${String(now.getDate()).padStart(2, '0')}`;
			const now2 = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0);

			result = await parse({
				argv: [nowFormatted],
				schema,
			});
			expect(result._).to.deep.equal([now2]);
			expect(result.argv).to.deep.equal({
				foo: now2,
			});

			result = await parse({
				argv: ['123'],
				schema,
			});
			expect(result._).to.deep.equal([123]);
			expect(result.argv).to.deep.equal({
				foo: 123,
			});

			result = await parse({
				argv: ['3.14'],
				schema,
			});
			expect(result._).to.deep.equal([3.14]);
			expect(result.argv).to.deep.equal({
				foo: 3.14,
			});

			result = await parse({
				argv: ['{"bar": "baz"}'],
				schema,
			});
			expect(result._).to.deep.equal([{ bar: 'baz' }]);
			expect(result.argv).to.deep.equal({
				foo: { bar: 'baz' },
			});

			result = await parse({
				argv: ['bar'],
				schema,
			});
			expect(result._).to.deep.equal(['bar']);
			expect(result.argv).to.deep.equal({
				foo: 'bar',
			});
		});

		it('should parse argument as boolean', async () => {
			const schema = {
				args: [
					{
						name: 'foo',
						type: 'bool',
					},
				],
			};

			let result = await parse({
				argv: ['true'],
				schema,
			});
			expect(result._).to.deep.equal([true]);
			expect(result.argv).to.deep.equal({
				foo: true,
			});

			result = await parse({
				argv: ['no'],
				schema,
			});
			expect(result._).to.deep.equal([false]);
			expect(result.argv).to.deep.equal({
				foo: false,
			});

			result = await parse({
				argv: ['false'],
				schema,
			});
			expect(result._).to.deep.equal([false]);
			expect(result.argv).to.deep.equal({
				foo: false,
			});

			await expect(
				parse({
					argv: ['baz'],
					schema,
				})
			).rejects.toThrow('Invalid boolean: "baz"');
		});

		it('should accept every boolean value on an argument', async () => {
			const schema = {
				args: [
					{
						name: 'foo',
						type: 'bool',
					},
				],
			};

			for (const input of ['true', 't', 'yes', 'y', 'on', '1']) {
				const result = await parse({ argv: [input], schema });
				expect(result.argv.foo, input).to.equal(true);
			}

			for (const input of ['false', 'f', 'no', 'n', 'off', '0']) {
				const result = await parse({ argv: [input], schema });
				expect(result.argv.foo, input).to.equal(false);
			}
		});

		it('should parse argument as date', async () => {
			const schema = {
				args: [
					{
						name: 'foo',
						type: 'date',
					},
				],
			};

			const now = new Date();
			const nowFormatted = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(
				2,
				'0'
			)}-${String(now.getDate()).padStart(2, '0')}`;
			const now2 = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0);

			let result = await parse({
				argv: [`${now.getTime()}`],
				schema,
			});
			expect(result._).to.deep.equal([now]);
			expect(result.argv).to.deep.equal({
				foo: now,
			});

			result = await parse({
				argv: [now.toISOString()],
				schema,
			});
			expect(result._).to.deep.equal([now]);
			expect(result.argv).to.deep.equal({
				foo: now,
			});

			result = await parse({
				argv: [nowFormatted],
				schema,
			});
			expect(result._).to.deep.equal([now2]);
			expect(result.argv).to.deep.equal({
				foo: now2,
			});

			await expect(
				parse({
					argv: ['9999-99-99'],
					schema,
				})
			).rejects.toThrow('Invalid date: "9999-99-99"');
		});

		it('should parse argument as integer', async () => {
			const schema = {
				args: [
					{
						name: 'foo',
						type: 'int',
					},
				],
			};

			const result = await parse({
				argv: ['123'],
				schema,
			});
			expect(result._).to.deep.equal([123]);
			expect(result.argv).to.deep.equal({
				foo: 123,
			});

			await expect(
				parse({
					argv: ['1.23'],
					schema,
				})
			).rejects.toThrow('Invalid integer: 1.23');

			await expect(
				parse({
					argv: ['foo'],
					schema,
				})
			).rejects.toThrow('Invalid integer: foo');
		});

		it('should parse argument as json', async () => {
			const schema = {
				args: [
					{
						name: 'foo',
						type: 'json',
					},
				],
			};

			const result = await parse({
				argv: ['{"bar":"baz"}'],
				schema,
			});
			expect(result._).to.deep.equal([{ bar: 'baz' }]);
			expect(result.argv).to.deep.equal({
				foo: { bar: 'baz' },
			});

			await expect(
				parse({
					argv: ['{{{'],
					schema,
				})
			).rejects.toThrow(/^Invalid JSON:/);
		});

		it('should parse argument as number', async () => {
			const schema = {
				args: [
					{
						name: 'foo',
						type: 'number',
					},
				],
			};

			let result = await parse({
				argv: ['123'],
				schema,
			});
			expect(result._).to.deep.equal([123]);
			expect(result.argv).to.deep.equal({
				foo: 123,
			});

			result = await parse({
				argv: ['3.14'],
				schema,
			});
			expect(result._).to.deep.equal([3.14]);
			expect(result.argv).to.deep.equal({
				foo: 3.14,
			});

			await expect(
				parse({
					argv: ['foo'],
					schema,
				})
			).rejects.toThrow('Invalid number: foo');
		});

		it('should parse argument as yes/no boolean', async () => {
			const schema = {
				args: [
					{
						name: 'foo',
						type: 'yesno',
					},
				],
			};

			let result = await parse({
				argv: ['yes'],
				schema,
			});
			expect(result._).to.deep.equal([true]);
			expect(result.argv).to.deep.equal({
				foo: true,
			});

			result = await parse({
				argv: ['no'],
				schema,
			});
			expect(result._).to.deep.equal([false]);
			expect(result.argv).to.deep.equal({
				foo: false,
			});

			await expect(
				parse({
					argv: ['foo'],
					schema,
				})
			).rejects.toThrow('Value must be "yes" or "no"');
		});
	});
});
