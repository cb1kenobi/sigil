import { parse } from '../../../src/parser/parse.js';
import { describe, expect, it } from 'vitest';

/**
 * Ported from Commander's command tests: command.alias, command.nested,
 * command.unknownCommand, command.unknownOption, command.allowUnknownOption,
 * and the parsing behavior expressed by command.parseOptions.
 *
 * Commander's parseOptions() returns `{ operands, unknown }`; the equivalent
 * here is what lands on `state._` versus `state.argv`, so those tests are
 * ported by asserting the split rather than the shape.
 */
describe('commander: commands', () => {
	describe('aliases', () => {
		it('should match a command by its @ alias', async () => {
			const result = await parse({ argv: ['b'], schema: { commands: { 'build, @b': {} } } });
			expect(result.cmd?.name).to.equal('build');
		});

		it('should match a command by an alias property', async () => {
			const result = await parse({
				argv: ['compile'],
				schema: { commands: { build: { alias: ['b', 'compile'] } } },
			});
			expect(result.cmd?.name).to.equal('build');
		});

		it('should match any of several aliases', async () => {
			const schema = { commands: { build: { alias: ['b', 'compile'] } } };
			expect((await parse({ argv: ['b'], schema })).cmd?.name).to.equal('build');
			expect((await parse({ argv: ['compile'], schema })).cmd?.name).to.equal('build');
		});

		it('should accept an alias equal to the command name', async () => {
			// Commander rejects this outright
			const result = await parse({
				argv: ['build'],
				schema: { commands: { build: { alias: 'build' } } },
			});
			expect(result.cmd?.name).to.equal('build');
		});
	});

	describe('nesting', () => {
		it('should resolve a nested subcommand', async () => {
			const result = await parse({
				argv: ['a', 'b', 'c'],
				schema: { commands: { a: { commands: { b: { commands: { c: {} } } } } } },
			});
			expect(result.cmd?.name).to.equal('c');
		});

		it('should resolve a parent option used after a subcommand', async () => {
			const result = await parse({
				argv: ['sub', '--verbose'],
				schema: { options: { '--verbose': {} }, commands: { sub: {} } },
			});
			expect(result.cmd?.name).to.equal('sub');
			expect(result.argv.verbose).to.equal(true);
		});
	});

	describe('unknown commands', () => {
		it('should reject an unknown command when nothing takes arguments', async () => {
			await expect(parse({ argv: ['nope'], schema: { commands: { sub: {} } } })).rejects.toThrow(
				'Unexpected argument "nope"'
			);
		});

		it('should accept an unknown command name as an argument when one is declared', async () => {
			const result = await parse({
				argv: ['nope', 'extra'],
				schema: { args: [{ name: 'rest', multiple: true }], commands: { sub: {} } },
			});
			expect(result.cmd).to.equal(undefined);
			expect(result.argv.rest).to.deep.equal(['nope', 'extra']);
		});

		it('should report the unknown option before the unknown command', async () => {
			// Commander reports the unknown command first; here option-like
			// tokens are resolved before positional values are checked
			await expect(
				parse({
					argv: ['nope', '--NONSENSE'],
					schema: { commands: { sub: {} } },
					settings: { allowUnknownOptions: false },
				})
			).rejects.toThrow('Unknown option "--NONSENSE"');
		});
	});

	describe('unknown options', () => {
		it('should collect an unknown option after a subcommand', async () => {
			const result = await parse({
				argv: ['info', '--NONSENSE'],
				schema: { commands: { info: {} } },
			});
			expect(result.cmd?.name).to.equal('info');
			expect(result.argv.NONSENSE).to.equal(true);
		});

		it('should collect an unknown option after a subcommand argument', async () => {
			const result = await parse({
				argv: ['info', 'a', '--NONSENSE'],
				schema: { commands: { 'info <file>': {} } },
			});
			expect(result.argv.file).to.equal('a');
			expect(result.argv.NONSENSE).to.equal(true);
		});

		it('should reject an unknown option after a subcommand when the setting is off', async () => {
			await expect(
				parse({
					argv: ['info', '--NONSENSE'],
					schema: { commands: { info: {} } },
					settings: { allowUnknownOptions: false },
				})
			).rejects.toThrow('Unknown option "--NONSENSE"');
		});

		it('should reject an unknown global option before a subcommand when the setting is off', async () => {
			await expect(
				parse({
					argv: ['--NONSENSE', 'sub'],
					schema: { commands: { sub: {} } },
					settings: { allowUnknownOptions: false },
				})
			).rejects.toThrow('Unknown option "--NONSENSE"');
		});

		it('should reject an unknown short option when the setting is off', async () => {
			await expect(
				parse({
					argv: ['-m'],
					schema: { options: { '-p, --pepper': {} } },
					settings: { allowUnknownOptions: false },
				})
			).rejects.toThrow('Unknown option "-m"');
		});

		it('should collect an unknown short option by default', async () => {
			const result = await parse({
				argv: ['-m'],
				schema: { options: { '-p, --pepper': {} } },
			});
			expect(result.argv.m).to.equal(true);
			expect(result.argv.pepper).to.equal(false);
		});
	});

	describe('separating options from operands', () => {
		const schema = {
			args: [{ name: 'rest', multiple: true }],
			// `[v]` rather than `<v>`: angle brackets make the option itself
			// required, which is this parser's own convention
			options: { '-f, --foo': {}, '-b, --bar [v]': {} },
		};

		it('should keep operands when there are no options', async () => {
			const result = await parse({ argv: ['one', 'two'], schema });
			expect(result.argv.rest).to.deep.equal(['one', 'two']);
		});

		it('should remove a flag that comes before an operand', async () => {
			const result = await parse({ argv: ['--foo', 'one'], schema });
			expect(result.argv.foo).to.equal(true);
			expect(result.argv.rest).to.deep.equal(['one']);
		});

		it('should remove a flag that comes after an operand', async () => {
			const result = await parse({ argv: ['one', '--foo'], schema });
			expect(result.argv.foo).to.equal(true);
			expect(result.argv.rest).to.deep.equal(['one']);
		});

		it('should remove an option and its value', async () => {
			const result = await parse({ argv: ['--bar', 'v', 'one'], schema });
			expect(result.argv.bar).to.equal('v');
			expect(result.argv.rest).to.deep.equal(['one']);
		});

		it('should remove a long flag=value', async () => {
			const result = await parse({ argv: ['--bar=v', 'one'], schema });
			expect(result.argv.bar).to.equal('v');
			expect(result.argv.rest).to.deep.equal(['one']);
		});

		it('should remove a flag that comes after a subcommand', async () => {
			const result = await parse({
				argv: ['sub', '--foo', 'one'],
				schema: {
					options: { '-f, --foo': {} },
					commands: { 'sub [rest...]': {} },
				},
			});
			expect(result.cmd?.name).to.equal('sub');
			expect(result.argv.foo).to.equal(true);
			expect(result.argv.rest).to.deep.equal(['one']);
		});

		it('should preserve operand order around mixed arguments', async () => {
			const result = await parse({ argv: ['one', '--foo', 'two', '--bar', 'v', 'three'], schema });
			expect(result.argv.rest).to.deep.equal(['one', 'two', 'three']);
			expect(result.argv.foo).to.equal(true);
			expect(result.argv.bar).to.equal('v');
		});

		it('should remove a group of known short flags', async () => {
			const result = await parse({
				argv: ['-fg', 'one'],
				schema: {
					args: [{ name: 'rest', multiple: true }],
					options: { '-f': {}, '-g': {} },
				},
			});
			expect(result.argv.f).to.equal(true);
			expect(result.argv.g).to.equal(true);
			expect(result.argv.rest).to.deep.equal(['one']);
		});

		it('should preserve an unresolvable group of short flags as an operand', async () => {
			const result = await parse({
				argv: ['-xy', 'one'],
				schema: { args: [{ name: 'rest', multiple: true }], options: { '-f': {} } },
			});
			expect(result.argv.rest).to.deep.equal(['-xy', 'one']);
		});

		it('should remove a known short option with a combined required value', async () => {
			const result = await parse({
				argv: ['-bv', 'one'],
				schema,
			});
			expect(result.argv.bar).to.equal('v');
			expect(result.argv.rest).to.deep.equal(['one']);
		});

		it('should remove known flags combined with a trailing valued option', async () => {
			const result = await parse({
				argv: ['-fbv', 'one'],
				schema,
			});
			expect(result.argv.foo).to.equal(true);
			expect(result.argv.bar).to.equal('v');
			expect(result.argv.rest).to.deep.equal(['one']);
		});
	});
});
