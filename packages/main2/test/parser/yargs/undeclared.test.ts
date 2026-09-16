import { parse } from '../../../src/parser/parse.js';
import { describe, expect, it } from 'vitest';

/**
 * Ported from yargs-parser's test suite.
 *
 * yargs-parser is schema-less by default: it infers everything from argv and
 * guesses types. The nearest thing here is an undeclared option, so most of
 * yargs' bare `parser([...])` tests land in this file. `settings` is relaxed
 * throughout because yargs never rejects a stray positional value.
 *
 * The recurring divergences: an undeclared option takes the next token only
 * when that token is not itself option-like, short groups are only expanded
 * against a schema, `no-` is not read as negation without a declaration, and
 * `state._` holds raw strings rather than guessed types.
 */
const settings = { allowUnexpectedArguments: true, allowExtraArguments: true };

describe('yargs: undeclared options', () => {
	describe('basics', () => {
		it('should parse a short boolean', async () => {
			const result = await parse({ argv: ['-b'], settings });
			expect(result.argv).to.deep.equal({ b: true });
			expect(result._).to.deep.equal([]);
		});

		it('should parse a long boolean', async () => {
			const result = await parse({ argv: ['--bool'], settings });
			expect(result.argv).to.deep.equal({ bool: true });
		});

		it('should place bare values in _', async () => {
			const result = await parse({ argv: ['foo', 'bar', 'baz'], settings });
			expect(result._).to.deep.equal(['foo', 'bar', 'baz']);
		});

		it('should take the next value for a long option', async () => {
			const result = await parse({ argv: ['--pow', 'xixxle'], settings });
			expect(result.argv.pow).to.equal('xixxle');
			expect(result._).to.deep.equal([]);
		});

		it('should take an empty next value', async () => {
			const result = await parse({ argv: ['--pow', ''], settings });
			expect(result.argv.pow).to.equal('');
		});

		it('should take a value given with =', async () => {
			const result = await parse({ argv: ['--pow=xixxle'], settings });
			expect(result.argv.pow).to.equal('xixxle');
		});

		it('should pair up multiple long options with their values', async () => {
			const result = await parse({
				argv: ['--host', 'localhost', '--port', '555'],
				settings,
			});
			expect(result.argv.host).to.equal('localhost');
			expect(result.argv.port).to.equal(555);
		});

		it('should take an option-like value given with =', async () => {
			const result = await parse({ argv: ['--foo=--bar'], settings });
			expect(result.argv.foo).to.equal('--bar');
		});

		it('should let the last occurrence win', async () => {
			// yargs collects repeats into an array
			const result = await parse({ argv: ['--multi=quux', '--multi=baz'], settings });
			expect(result.argv.multi).to.equal('baz');
		});
	});

	describe('type guessing', () => {
		it('should guess numbers, leaving unparseable values as strings', async () => {
			const result = await parse({
				argv: ['-x', '1234', '-y', '5.67', '-z', '1e7', '-w', '10f', '--hex', '0xdeadbeef'],
				settings,
			});
			expect(result.argv.x).to.equal(1234);
			expect(result.argv.y).to.equal(5.67);
			expect(result.argv.z).to.equal(1e7);
			expect(result.argv.w).to.equal('10f');
			expect(result.argv.hex).to.equal(0xdeadbeef);
		});

		it('should leave positional values as strings', async () => {
			// yargs guesses types for _ as well
			const result = await parse({ argv: ['789'], settings });
			expect(result._).to.deep.equal(['789']);
		});

		it('should strip quotes from a quoted value given with =', async () => {
			const result = await parse({ argv: ['--bar="goodnight moon"'], settings });
			expect(result.argv.bar).to.equal('goodnight moon');
		});

		it('should strip quotes from a value attached without a separator', async () => {
			const result = await parse({ argv: ['--foo"hello world"'], settings });
			expect(result.argv.foo).to.equal('hello world');
		});
	});

	describe('negation', () => {
		it('should not read no- as negation without a declaration', async () => {
			// yargs gives moo: false
			const result = await parse({ argv: ['--no-moo'], settings });
			expect(result.argv).to.deep.equal({ noMoo: true });
		});

		it('should read no- as negation once declared', async () => {
			const result = await parse({ argv: ['--no-moo'], schema: { options: { '--no-moo': {} } } });
			expect(result.argv.moo).to.equal(false);
		});
	});

	describe('negative numbers', () => {
		it('should leave a multi-character negative number as a positional value', async () => {
			const result = await parse({ argv: ['-33', '-177', '33'], settings });
			expect(result._).to.deep.equal(['-33', '-177', '33']);
		});

		it('should take a negative number given with =', async () => {
			const result = await parse({ argv: ['--n2=-55'], settings });
			expect(result.argv.n2).to.equal(-55);
		});

		it('should not take a negative number as the value of an undeclared option', async () => {
			// yargs gives n1: -33; an undeclared option is not known to take a
			// value, so an option-like token is left for the next round
			const result = await parse({ argv: ['--n1', '-33'], settings });
			expect(result.argv.n1).to.equal(true);
			expect(result._).to.deep.equal(['-33']);
		});

		it('should take a negative number as the value of a declared option', async () => {
			const result = await parse({
				argv: ['--n1', '-33'],
				schema: { options: { '--n1 [v]': { type: 'int' } } },
			});
			expect(result.argv.n1).to.equal(-33);
		});

		it('should leave a decimal without a leading digit as a positional value', async () => {
			const result = await parse({ argv: ['-.5', '-0.1', '.1'], settings });
			expect(result._).to.deep.equal(['-.5', '-0.1', '.1']);
		});
	});

	describe('short option groups', () => {
		it('should not expand a group that nothing declares', async () => {
			// yargs expands -cats into c, a, t, s without a schema
			const result = await parse({ argv: ['-cats', 'meow'], settings });
			expect(result.argv).to.deep.equal({});
			expect(result._).to.deep.equal(['-cats', 'meow']);
		});

		it('should expand a group once declared, giving the last one the value', async () => {
			const result = await parse({
				argv: ['-cats', 'meow'],
				schema: { options: { '-c': {}, '-a': {}, '-t': {}, '-s [v]': {} } },
			});
			expect(result.argv).to.deep.equal({ c: true, a: true, t: true, s: 'meow' });
		});

		it('should mix shorts, groups and longs', async () => {
			const result = await parse({
				argv: ['-h', 'localhost', '-fp', '555', 'script.js'],
				schema: { args: ['[rest...]'], options: { '-h [v]': {}, '-f': {}, '-p [v]': {} } },
			});
			expect(result.argv.h).to.equal('localhost');
			expect(result.argv.f).to.equal(true);
			expect(result.argv.p).to.equal('555');
			expect(result.argv.rest).to.deep.equal(['script.js']);
		});
	});

	describe('the lone dash', () => {
		it('should leave a lone dash as a positional value', async () => {
			const result = await parse({ argv: ['-'], settings });
			expect(result._).to.deep.equal(['-']);
		});

		it('should take a lone dash as the value of a declared option', async () => {
			const result = await parse({ argv: ['-n', '-'], schema: { options: { '-n [v]': {} } } });
			expect(result.argv.n).to.equal('-');
		});

		it('should not let a declared flag take a lone dash', async () => {
			const result = await parse({
				argv: ['-b', '-'],
				schema: { args: ['[rest...]'], options: { '-b': {} } },
			});
			expect(result.argv.b).to.equal(true);
			expect(result.argv.rest).to.deep.equal(['-']);
		});

		it('should leave a trailing dash attached to a short name as a positional value', async () => {
			// yargs reads -f- as f='-'
			const result = await parse({ argv: ['-f-'], settings });
			expect(result._).to.deep.equal(['-f-']);
		});
	});

	describe('the terminator', () => {
		it('should pass everything after -- through verbatim', async () => {
			const result = await parse({
				argv: ['--name=meowmers', 'bare', '--', '--not-a-flag', '-', '-h', '--', 'eek'],
				settings,
			});
			expect(result.argv.name).to.equal('meowmers');
			expect(result._).to.deep.equal(['bare', '--not-a-flag', '-', '-h', '--', 'eek']);
		});
	});
});
