import { parse } from '../../src/parser/parse.js';
import { describe, expect, it } from 'vitest';

/**
 * How an option gets its value, and what happens when nothing follows it.
 *
 * The central decision here (M2-13) is that a declared option consumes the
 * next token unless that token resolves to an option something declared. So
 * `--name --verbose` leaves `--verbose` alone, while `--name --undeclared`
 * takes `--undeclared` as the value, because values do legitimately start
 * with a dash and nothing in the schema says otherwise.
 */
describe('option values', () => {
	describe('undeclared options', () => {
		it('should treat an undeclared option with nothing after it as true', async () => {
			const result = await parse({ argv: ['--foo'] });
			expect(result.argv).to.deep.equal({ foo: true });
			expect(result._).to.deep.equal([]);
		});

		it('should take an attached value', async () => {
			const result = await parse({ argv: ['--foo=bar'] });
			expect(result.argv).to.deep.equal({ foo: 'bar' });
		});

		it('should take the next token as its value', async () => {
			const result = await parse({ argv: ['--foo', 'bar'] });
			expect(result.argv).to.deep.equal({ foo: 'bar' });
		});

		it('should guess the data type of its value', async () => {
			const result = await parse({ argv: ['--age', '20'] });
			expect(result.argv).to.deep.equal({ age: 20 });
		});

		it('should not take another option-like token as its value', async () => {
			const result = await parse({ argv: ['--foo', '--bar'] });
			expect(result.argv).to.deep.equal({ foo: true, bar: true });
		});

		it('should camelCase the destination', async () => {
			const result = await parse({ argv: ['--dry-run'] });
			expect(result.argv).to.deep.equal({ dryRun: true });
		});

		it('should not read no- as negation', async () => {
			const result = await parse({ argv: ['--no-color'] });
			expect(result.argv).to.deep.equal({ noColor: true });
		});

		it('should accept an undeclared short option', async () => {
			const result = await parse({ argv: ['-x', '1'] });
			expect(result.argv).to.deep.equal({ x: 1 });
		});

		it('should let the last occurrence win', async () => {
			const result = await parse({ argv: ['--foo', 'a', '--foo', 'b'] });
			expect(result.argv).to.deep.equal({ foo: 'b' });
		});

		it('should leave an unresolved short group alone', async () => {
			const result = await parse({
				argv: ['-abc'],
				settings: { allowUnexpectedArguments: true },
			});
			expect(result.argv).to.deep.equal({});
			expect(result._).to.deep.equal(['-abc']);
		});

		it('should not take a matched command as its value', async () => {
			const result = await parse({
				argv: ['--foo', 'build'],
				schema: { commands: { build: {} } },
			});
			expect(result.cmd?.name).to.equal('build');
			expect(result.argv).to.deep.equal({ foo: true });
		});

		it('should throw when allowUnknownOptions is false', async () => {
			await expect(
				parse({ argv: ['--foo'], settings: { allowUnknownOptions: false } })
			).rejects.toThrow('Unknown option "--foo"');
		});
	});

	describe('missing values', () => {
		// `<>` and `[]` say whether the *option* has to appear, not whether its
		// value may be left out: `[value]` is an optional option that takes a
		// value, so using it without one is the same mistake either way
		it.each([
			['required', '--name <value>'],
			['optional', '--name [value]'],
		])('should throw when a %s option is given no value', async (_kind, format) => {
			await expect(
				parse({ argv: ['--name'], schema: { options: { [format]: null } } })
			).rejects.toThrow('Missing value for option --name');
		});

		// `--name=` did give a value. Whether an empty one is allowed is the data
		// type's question, and `string` is a type that has an empty value
		it('should give an empty value to a string option', async () => {
			for (const format of ['--name <value>', '--name [value]']) {
				const result = await parse({ argv: ['--name='], schema: { options: { [format]: null } } });
				expect(result.argv, format).to.deep.equal({ name: '' });
			}
		});

		// ...and most types do not have one, so they reject it like any other
		// value they cannot read
		it.each([
			['number', 'Invalid number'],
			['int', 'Invalid integer'],
			['date', 'Invalid date'],
			['json', 'Invalid JSON'],
		])('should reject an empty value for %s', async (type, message) => {
			await expect(
				parse({ argv: ['--age='], schema: { options: { '--age [value]': { type } } } })
			).rejects.toThrow(message);
		});

		it('should still reject a value of the wrong type', async () => {
			await expect(
				parse({
					argv: ['--age', 'hello'],
					schema: { options: { '--age <value>': { type: 'number' } } },
				})
			).rejects.toThrow('Invalid number: hello');
		});
	});

	describe('a token that looks like an option', () => {
		// the protection is unchanged: a declared option is not swallowed as a
		// value. What changed is how that shows -- `--name` is left with no value,
		// which is now an error rather than an empty string
		it.each([
			['a declared option', ['--name', '--age', '20'], { '--age <value>': { type: 'number' } }],
			['a declared flag', ['--name', '--silent'], { '--silent': null }],
			['a declared short option', ['--name', '-s'], { '-s, --silent': null }],
			['a resolvable short option group', ['--name', '-ab'], { '-a': null, '-b': null }],
			['the terminator', ['--name', '--', 'rest'], {}],
		])('should not consume %s', async (_what, argv, options) => {
			await expect(
				parse({
					argv,
					schema: { options: { '--name [value]': null, ...options } },
					settings: { allowExtraArguments: true },
				})
			).rejects.toThrow('Missing value for option --name');
		});

		// the same for a required option, which is the same error for the same
		// reason -- `<>` and `[]` differ on whether the option must appear, not on
		// whether its value may be left out
		it('should throw when a required option is followed by a declared option', async () => {
			await expect(
				parse({
					argv: ['--name', '--age', '20'],
					schema: {
						options: { '--name <value>': null, '--age <value>': { type: 'number' } },
					},
				})
			).rejects.toThrow('Missing value for option --name');
		});

		// and the token that was protected is parsed as itself, once the option
		// ahead of it has a value of its own
		it('should parse the protected token once the option has a value', async () => {
			const result = await parse({
				argv: ['--name=', '--silent'],
				schema: { options: { '--name [value]': null, '--silent': null } },
			});
			expect(result.argv).to.deep.equal({ name: '', silent: true });
		});

		it('should consume an undeclared option', async () => {
			const result = await parse({
				argv: ['--name', '--age', '20'],
				schema: {
					args: [{ name: 'args', multiple: true }],
					options: { '--name [value]': null },
				},
			});
			expect(result.argv).to.deep.equal({ name: '--age', args: ['20'] });
		});

		it('should keep the whole token when it carries an attached value', async () => {
			const result = await parse({
				argv: ['--name', '--age=20'],
				schema: { options: { '--name [value]': null } },
			});
			expect(result.argv).to.deep.equal({ name: '--age=20' });
		});

		it('should let an explicit empty value opt out of consuming it', async () => {
			const result = await parse({
				argv: ['--name=', '--age', '20'],
				schema: { options: { '--name [value]': null } },
			});
			expect(result.argv).to.deep.equal({ name: '', age: 20 });
		});

		it('should let an attached value be an option-like string', async () => {
			const result = await parse({
				argv: ['--name=--verbose'],
				schema: { options: { '--name <value>': null, '--verbose': null } },
			});
			expect(result.argv).to.deep.equal({ name: '--verbose', verbose: false });
		});

		it('should still take a negative number as a value', async () => {
			const result = await parse({
				argv: ['--num', '-15'],
				schema: { options: { '--num <n>': { type: 'int' } } },
			});
			expect(result.argv).to.deep.equal({ num: -15 });
		});
	});
});
