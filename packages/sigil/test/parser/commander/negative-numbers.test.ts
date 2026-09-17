import { parse } from '../../../src/parser/parse.js';
import { describe, expect, it } from 'vitest';

/**
 * Ported from Commander's negatives.test.js.
 *
 * Commander needs a number-shaped check to decide whether a dash-leading token
 * is a value or an unknown option, and rejects the ones that are not valid
 * numbers. This parser asks a different question — is this a declared option? —
 * so every one of these is a value, valid number or not, and the digit-option
 * case falls out of short group expansion rather than a special rule. See
 * "How an option gets its value" in docs/parser.md.
 */
describe('commander: negative numbers', () => {
	const schema = { options: { '-o, --optional [value]': {} } };

	// Commander consumes only the entries it can read as a whole number; the
	// rest raise an unknown option error. The trailing comment on each is its
	// reason for rejection there.
	const values = [
		'-.1',
		'-123',
		'-123.45',
		'-1e3',
		'-1e+3',
		'-1e-3',
		'-1.2e3',
		'-1.2e+3',
		'-1.2e-3',
		'-1e-3.0', // Commander: invalid number format
		'-0',
		'-1x', // Commander: whole string is not a number
		'-x-1', // Commander: whole string is not a number
		'-0x1234', // Commander: not a plain number
	];

	it.each(values)('should take %s as the value of a short option', async (value) => {
		const result = await parse({ argv: ['-o', value], schema });
		expect(result.argv.optional).to.equal(value);
	});

	it.each(values)('should take %s as the value of a long option', async (value) => {
		const result = await parse({ argv: ['--optional', value], schema });
		expect(result.argv.optional).to.equal(value);
	});

	// `-0` is the one exception: a single character after a dash is the shape of
	// a short option, and nothing declared it, so it resolves as an undeclared
	// option rather than a positional value
	it.each(values.filter((v) => v !== '-0'))(
		'should take %s as a positional value',
		async (value) => {
			const result = await parse({ argv: [value], schema: { args: ['[value]'] } });
			expect(result.argv.value).to.equal(value);
		}
	);

	it('should read a lone -0 as an undeclared short option', async () => {
		const result = await parse({ argv: ['-0'], schema: { args: ['[value]'] } });
		expect(result.argv['0']).to.equal(true);
		expect(result.argv.value).to.equal(undefined);
	});

	it('should coerce a negative number to the declared type', async () => {
		const result = await parse({
			argv: ['--num', '-15'],
			schema: { options: { '--num <n>': { type: 'int' } } },
		});
		expect(result.argv.num).to.equal(-15);
	});

	it('should not take a declared digit option as a value', async () => {
		// `-9` is protected, which is why `-o` is left with no value at all
		await expect(
			parse({
				argv: ['-o', '-9'],
				schema: { options: { '-o, --optional [value]': {}, '-9': {} } },
			})
		).rejects.toThrow('Missing value for option --optional');
	});

	it('should parse the protected digit option once -o has a value', async () => {
		const result = await parse({
			argv: ['-o=', '-9'],
			schema: { options: { '-o, --optional [value]': {}, '-9': {} } },
		});
		expect(result.argv['9']).to.equal(true);
		expect(result.argv.optional).to.equal('');
	});

	it('should not take a negative number that expands as a declared group', async () => {
		// `-1` is declared, so `-123` expands rather than reading as a number,
		// and the unexpanded remainder is left as a positional value. `-o=` gives
		// the option its value, so what is being tested here is the expansion
		await expect(
			parse({
				argv: ['-o=', '-123'],
				schema: { options: { '-o, --optional [value]': {}, '-1': {} } },
			})
		).rejects.toThrow('Unexpected argument "-23"');
	});

	it('should take negative numbers throughout a mixed command line', async () => {
		const result = await parse({
			argv: ['-10', '-o', '-20', '-m', '-30', '-11'],
			schema: {
				args: ['[value...]'],
				options: { '-o [value]': {}, '-m <value>': {} },
			},
		});
		expect(result.argv.o).to.equal('-20');
		expect(result.argv.m).to.equal('-30');
		expect(result.argv.value).to.deep.equal(['-10', '-11']);
	});
});
