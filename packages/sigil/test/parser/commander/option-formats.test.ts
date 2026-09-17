import { parse } from '../../../src/parser/parse.js';
import { describe, expect, it } from 'vitest';

/**
 * Ported from Commander's option.bad-flags.test.js and the declaration half of
 * options.dual-options.test.js.
 *
 * Commander's format string is strict: at most one short and one long name,
 * and a name is mandatory. This parser's is deliberately looser — the first
 * long name becomes the base name and everything else becomes an alias, and a
 * bare word is a valid way to declare `--word`. Only genuinely malformed parts
 * are rejected.
 */
describe('commander: option formats', () => {
	describe('formats this parser accepts that Commander rejects', () => {
		it('should treat two short names as aliases of one option', async () => {
			const schema = { options: { '-a, -b': {} } };
			expect((await parse({ argv: ['-a'], schema })).argv.a).to.equal(true);
			expect((await parse({ argv: ['-b'], schema })).argv.a).to.equal(true);
		});

		it('should treat two short names with a hint as one valued option', async () => {
			const result = await parse({
				argv: ['-b', 'v'],
				schema: { options: { '-a, -b <value>': {} } },
			});
			expect(result.argv.a).to.equal('v');
		});

		it('should let a long name win the base name over two shorts', async () => {
			const result = await parse({
				argv: ['-a'],
				schema: { options: { '-a, -b, --long': {} } },
			});
			expect(result.argv.long).to.equal(true);
		});

		it('should treat extra long names as aliases', async () => {
			const schema = { options: { '--one, --two, --three': {} } };
			expect((await parse({ argv: ['--one'], schema })).argv.one).to.equal(true);
			expect((await parse({ argv: ['--three'], schema })).argv.one).to.equal(true);
		});

		it('should accept a bare word as a long option name', async () => {
			const result = await parse({
				argv: ['--sdkjhskjh'],
				schema: { options: { sdkjhskjh: {} } },
			});
			expect(result.argv.sdkjhskjh).to.equal(true);
		});

		it.each(['-a,-b', '-a|-b', '-a -b'])('should accept %s as a separator', async (format) => {
			const result = await parse({ argv: ['-b'], schema: { options: { [format]: {} } } });
			expect(result.argv.a).to.equal(true);
		});
	});

	describe('formats both reject', () => {
		it('should reject a triple dash', async () => {
			await expect(parse({ schema: { options: { '---triple': {} } } })).rejects.toThrow(
				'Invalid option format: ---triple'
			);
		});

		it('should reject a short name with more than one character', async () => {
			// Without this the part becomes a bare name, registering the untypable
			// long option `---ws` and the destination `Ws`
			await expect(parse({ schema: { options: { '-ws': {} } } })).rejects.toThrow(
				'Invalid option format: -ws'
			);
		});

		it('should reject a lone dash', async () => {
			await expect(parse({ schema: { options: { '-': {} } } })).rejects.toThrow(
				'Invalid option format: -'
			);
		});
	});

	describe('formats both accept', () => {
		it.each([
			['-s', ['-s'], 's'],
			['--long', ['--long'], 'long'],
			['-b, --both', ['-b'], 'both'],
			['--both, -b', ['--both'], 'both'],
			['--ws, --workspace', ['--workspace'], 'ws'],
		])('should accept %s', async (format, argv, dest) => {
			const result = await parse({ argv, schema: { options: { [format]: {} } } });
			expect(result.argv[dest]).to.equal(true);
		});

		it.each(['-b,--both <comma>', '-b|--both <bar>', '-b --both [space]'])(
			'should accept %s with a hint',
			async (format) => {
				const result = await parse({ argv: ['-b', 'v'], schema: { options: { [format]: {} } } });
				expect(result.argv.both).to.equal('v');
			}
		);
	});

	describe('variadic hints', () => {
		it('should reject a variadic hint', async () => {
			// Commander reads `<files...>` as a variadic option that consumes
			// consecutive values; an option here never does, so the hint is
			// refused rather than silently kept as decoration
			await expect(
				parse({
					argv: ['-v', 'a', '-v', 'b'],
					schema: { options: { '-v, --variadic <files...>': { multiple: true } } },
				})
			).rejects.toThrow(
				new TypeError(
					'Option "variadic" hint cannot be variadic; use `multiple: true` to collect repeated uses into an array'
				)
			);
		});

		it('should collect a list by repetition instead', async () => {
			const result = await parse({
				argv: ['-v', 'a', '-v', 'b'],
				schema: { options: { '-v, --variadic <files>': { multiple: true } } },
			});
			expect(result.argv.variadic).to.deep.equal(['a', 'b']);
		});
	});

	describe('an option and its negation declared separately', () => {
		// Commander supports this pair through its DualOptions helper: the two
		// declarations share a destination, the valued one sets it and the negated
		// flag turns it off. Here they are two registry entries keyed apart, so
		// declaration order does not matter — Commander's does matter for the
		// default, see the dual options tests in ../options.test.ts.
		it('should keep both when the valued option is declared last', async () => {
			const result = await parse({
				argv: ['--cheese', 'blue'],
				schema: { options: { '--no-cheese': {}, '--cheese <type>': {} } },
			});
			expect(result.argv.cheese).to.equal('blue');
		});

		it('should keep both when the valued option is declared first', async () => {
			const result = await parse({
				argv: ['--cheese', 'blue'],
				schema: { options: { '--cheese <type>': {}, '--no-cheese': {} } },
			});
			expect(result.argv.cheese).to.equal('blue');
		});

		it.each([
			['the valued option first', { '--cheese <type>': {}, '--no-cheese': {} }],
			['the negated flag first', { '--no-cheese': {}, '--cheese <type>': {} }],
		])('should turn the destination off with %s', async (_label, options) => {
			const result = await parse({ argv: ['--no-cheese'], schema: { options } });
			expect(result.argv.cheese).to.equal(false);
		});
	});
});
