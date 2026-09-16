import { parse } from '../../../src/parser/parse.js';
import { describe, expect, it } from 'vitest';

/**
 * Ported from yargs-parser's alias, camelCase, count, defaults and env vars
 * blocks — the parts that survive the move to a declared schema.
 *
 * The biggest shape difference is that yargs writes every spelling of an
 * option onto its result (`some-option`, `someOption`, and each alias all
 * carry the value), while here an option has exactly one destination.
 */
describe('yargs: declared options', () => {
	describe('aliases', () => {
		it('should resolve an option by any of its names', async () => {
			const schema = { options: { '-f, --foo, --bar [v]': {} } };
			expect((await parse({ argv: ['-f', 'v'], schema })).argv.foo).to.equal('v');
			expect((await parse({ argv: ['--foo', 'v'], schema })).argv.foo).to.equal('v');
			expect((await parse({ argv: ['--bar', 'v'], schema })).argv.foo).to.equal('v');
		});

		it('should resolve an option by an alias property', async () => {
			const result = await parse({
				argv: ['--zoom', '55'],
				schema: { options: { '-z [v]': { alias: 'zoom', type: 'int' } } },
			});
			expect(result.argv.z).to.equal(55);
		});

		it('should write only the base destination, not every alias', async () => {
			// yargs writes o, some-option and someOption all at once
			const result = await parse({
				argv: ['--some-option', 'val'],
				schema: { options: { '-o, --some-option [v]': {} } },
			});
			expect(Object.keys(result.argv)).to.deep.equal(['someOption']);
			expect(result.argv.someOption).to.equal('val');
		});

		it('should accept a dashed and camelCase spelling of the same name', async () => {
			const schema = { options: { '--some-option [v]': { alias: 'someOption' } } };
			expect((await parse({ argv: ['--some-option', 'v'], schema })).argv.someOption).to.equal('v');
			expect((await parse({ argv: ['--someOption', 'v'], schema })).argv.someOption).to.equal('v');
		});
	});

	describe('camelCase destinations', () => {
		it('should expose a dashed option only as camelCase', async () => {
			// yargs exposes both 'some-option' and 'someOption'
			const result = await parse({
				argv: ['--some-option'],
				schema: { options: { '--some-option': {} } },
			});
			expect(result.argv).to.deep.equal({ someOption: true });
		});

		it('should camelCase a counted option', async () => {
			const result = await parse({
				argv: ['--some-option', '--some-option', '--some-option'],
				schema: { options: { '--some-option': { type: 'count' } } },
			});
			expect(result.argv.someOption).to.equal(3);
		});

		it('should camelCase a default', async () => {
			const result = await parse({
				schema: { options: { '--some-option [v]': { default: 'asdf' } } },
			});
			expect(result.argv.someOption).to.equal('asdf');
		});

		it('should not camelCase a one-character name', async () => {
			const result = await parse({ argv: ['-p', 'hello'], schema: { options: { '-p [v]': {} } } });
			expect(result.argv.p).to.equal('hello');
		});
	});

	describe('count', () => {
		it('should be zero when never given', async () => {
			const result = await parse({ schema: { options: { '--verbose': { type: 'count' } } } });
			expect(result.argv.verbose).to.equal(0);
		});

		it('should count each occurrence', async () => {
			const result = await parse({
				argv: ['--verbose', '--verbose'],
				schema: { options: { '--verbose': { type: 'count' } } },
			});
			expect(result.argv.verbose).to.equal(2);
		});

		it('should count a short group', async () => {
			const result = await parse({
				argv: ['-vvv'],
				schema: { options: { '-v, --verbose': { type: 'count' } } },
			});
			expect(result.argv.verbose).to.equal(3);
		});

		it('should count short and long spellings together', async () => {
			const result = await parse({
				argv: ['--verbose', '--verbose', '-v', '--verbose'],
				schema: { options: { '-v, --verbose': { type: 'count' } } },
			});
			expect(result.argv.verbose).to.equal(4);
		});

		it('should reject count on an option that takes a value', async () => {
			await expect(
				parse({ schema: { options: { '--verbose [v]': { type: 'count' } } } })
			).rejects.toThrow('Only flags can be of type "count"');
		});
	});

	describe('defaults', () => {
		it('should apply a default when the option is absent', async () => {
			const result = await parse({ schema: { options: { '--foo [v]': { default: 99 } } } });
			expect(result.argv.foo).to.equal(99);
		});

		it('should prefer a given value over a default', async () => {
			const result = await parse({
				argv: ['--foo', '5'],
				schema: { options: { '--foo [v]': { type: 'int', default: 99 } } },
			});
			expect(result.argv.foo).to.equal(5);
		});

		it('should throw rather than fall back when given without a value', async () => {
			// yargs falls back to the default here. `[v]` says the option may be
			// left out, not that its value may be, so there is nothing to fall back
			// from -- the command line is wrong
			await expect(
				parse({
					argv: ['--foo'],
					schema: { options: { '--foo [v]': { type: 'number', default: 99 } } },
				})
			).rejects.toThrow('Missing value for option --foo');
		});

		it('should reject an explicitly empty value the type cannot read', async () => {
			// `--foo=` did give a value, and `number` has no reading of an empty one
			await expect(
				parse({
					argv: ['--foo='],
					schema: { options: { '--foo [v]': { type: 'number', default: 99 } } },
				})
			).rejects.toThrow('Invalid number:');
		});

		it('should apply a default to a flag', async () => {
			const result = await parse({ schema: { options: { '--foo': { default: true } } } });
			expect(result.argv.foo).to.equal(true);
		});

		it('should apply defaults on a subcommand only when it matches', async () => {
			const schema = {
				commands: { sub: { options: { '--foo [v]': { default: 'd' } } }, other: {} },
			};
			expect((await parse({ argv: ['sub'], schema })).argv.foo).to.equal('d');
			expect((await parse({ argv: ['other'], schema })).argv.foo).to.equal(undefined);
		});
	});

	describe('environment variables', () => {
		it('should fall back to an environment variable', async () => {
			const result = await parse({
				env: { MY_FOO: 'bar' },
				schema: { options: { '--foo [v]': { env: 'MY_FOO' } } },
			});
			expect(result.argv.foo).to.equal('bar');
		});

		it('should take the first defined of several environment variables', async () => {
			const result = await parse({
				env: { SECOND: 'two' },
				schema: { options: { '--foo [v]': { env: ['FIRST', 'SECOND'] } } },
			});
			expect(result.argv.foo).to.equal('two');
		});

		it('should prefer argv over an environment variable', async () => {
			const result = await parse({
				argv: ['--foo', 'cli'],
				env: { MY_FOO: 'env' },
				schema: { options: { '--foo [v]': { env: 'MY_FOO' } } },
			});
			expect(result.argv.foo).to.equal('cli');
		});

		it('should coerce an environment variable to the declared type', async () => {
			const result = await parse({
				env: { PORT: '3000' },
				schema: { options: { '--port [v]': { type: 'int', env: 'PORT' } } },
			});
			expect(result.argv.port).to.equal(3000);
		});

		it('should fall back to an environment variable for an argument', async () => {
			const result = await parse({
				env: { PORT: '3000' },
				schema: { args: [{ name: '[port]', type: 'int', env: 'PORT' }] },
			});
			expect(result.argv.port).to.equal(3000);
		});
	});

	describe('booleans do not eat the next value', () => {
		it('should not take the next token for a declared flag', async () => {
			const result = await parse({
				argv: ['-t', 'moo'],
				schema: { args: ['[rest...]'], options: { '-t': {} } },
			});
			expect(result.argv.t).to.equal(true);
			expect(result.argv.rest).to.deep.equal(['moo']);
		});

		it('should take an explicit true or false attached to a flag', async () => {
			const schema = { options: { '--verbose': {} } };
			expect((await parse({ argv: ['--verbose=false'], schema })).argv.verbose).to.equal(false);
			expect((await parse({ argv: ['--verbose=true'], schema })).argv.verbose).to.equal(true);
		});

		it('should not collect repeated flags into an array', async () => {
			const result = await parse({
				argv: ['--infinite', '--infinite', '--no-infinite'],
				schema: { options: { '--no-infinite': {} } },
			});
			expect(result.argv.infinite).to.equal(false);
		});
	});
});
