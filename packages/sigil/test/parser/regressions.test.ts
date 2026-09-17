import { loadCommand } from '../../src/parser/command/load-command.js';
import { parse } from '../../src/parser/parse.js';
import { Argument, Internal } from '../../src/types.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Regression tests for parser correctness fixes. Each block names the defect
 * it guards against; several of these returned a plausible wrong value rather
 * than throwing, so they are easy to reintroduce unnoticed.
 */
describe('regressions', () => {
	describe('short option groups', () => {
		it('should treat an attached value as a value, not more flags', async () => {
			const result = await parse({
				argv: ['-n5'],
				schema: { options: { '-n, --num <n>': { type: 'int' } } },
			});
			expect(result.argv.num).to.equal(5);
		});

		it('should not split a multi-digit negative number into flags', async () => {
			const result = await parse({
				argv: ['--num', '-15'],
				schema: { options: { '-n, --num <n>': { type: 'int' } } },
			});
			expect(result.argv.num).to.equal(-15);
		});

		it('should still expand a group of flags', async () => {
			const result = await parse({
				argv: ['-abc'],
				schema: { options: { '-a': null, '-b': null, '-c': null } },
			});
			expect(result.argv).to.deep.equal({ a: true, b: true, c: true });
		});

		it('should let the last option in a group take the next argument', async () => {
			const result = await parse({
				argv: ['-ab', 'val'],
				schema: { options: { '-a': null, '-b <v>': null } },
			});
			expect(result.argv).to.deep.equal({ a: true, b: 'val' });
		});

		it('should take the rest of the group as the value', async () => {
			const result = await parse({
				argv: ['-abcvalue'],
				schema: { options: { '-a': null, '-b': null, '-c <v>': null } },
			});
			expect(result.argv).to.deep.equal({ a: true, b: true, c: 'value' });
		});

		it('should apply an explicit value to the last flag in a group', async () => {
			const result = await parse({
				argv: ['-ab=false'],
				schema: { options: { '-a': null, '-b': null } },
			});
			expect(result.argv).to.deep.equal({ a: true, b: false });
		});

		it('should resolve a group against a subcommand context', async () => {
			const result = await parse({
				argv: ['build', '-ab'],
				schema: {
					options: { '-a': null },
					commands: { build: { options: { '-b': null } } },
				},
			});
			expect(result.argv).to.deep.equal({ a: true, b: true });
		});
	});

	describe('empty values', () => {
		// `[n]` rather than `<n>` because angle brackets make the option itself
		// required, and a required option rejects an empty value outright
		it('should not coerce an empty value to zero', async () => {
			const result = await parse({
				argv: ['--name='],
				schema: { options: { '--name [n]': { type: 'auto' } } },
			});
			expect(result.argv.name).to.equal('');
		});

		it('should not coerce a blank value to zero', async () => {
			const result = await parse({
				argv: ['--name', ''],
				schema: { options: { '--name [n]': { type: 'auto' } } },
			});
			expect(result.argv.name).to.equal('');
		});
	});

	describe('variadic arguments and later options', () => {
		it('should not drop an option that follows a variadic argument value', async () => {
			const result = await parse({
				argv: ['one', '--foo', 'two'],
				schema: { args: ['[rest...]'], options: { '--foo': null } },
			});
			expect(result.argv.rest).to.deep.equal(['one', 'two']);
			expect(result.argv.foo).to.equal(true);
		});

		it('should not drop an unknown option that follows a variadic argument value', async () => {
			const result = await parse({
				argv: ['one', '--bar'],
				schema: { args: ['[rest...]'] },
			});
			expect(result.argv.rest).to.deep.equal(['one']);
			expect(result.argv.bar).to.equal(true);
		});
	});

	describe('option lookup', () => {
		it('should not resolve a positional value as an option of the same name', async () => {
			const result = await parse({
				argv: ['foo'],
				schema: { args: ['[x]'], options: { '--foo [bar]': null } },
			});
			expect(result.argv.x).to.equal('foo');
		});
	});

	describe('command matching', () => {
		it('should not consume an argument that repeats a command name', async () => {
			const result = await parse({
				argv: ['build', 'build'],
				schema: { commands: { build: { args: ['[x]'] } } },
			});
			expect(result.cmd?.name).to.equal('build');
			expect(result.argv.x).to.equal('build');
		});

		it('should not rematch a nested command name against an outer context', async () => {
			const result = await parse({
				argv: ['a', 'b', 'a'],
				schema: { commands: { a: { commands: { b: { args: ['[x]'] } } } } },
			});
			expect(result.cmd?.name).to.equal('b');
			expect(result.argv.x).to.equal('a');
		});

		it('should still resolve a parent option used after a subcommand', async () => {
			const result = await parse({
				argv: ['build', '--verbose'],
				schema: {
					options: { '--verbose': null },
					commands: { build: {} },
				},
			});
			expect(result.cmd?.name).to.equal('build');
			expect(result.argv.verbose).to.equal(true);
		});

		it('should still resolve a subcommand option used before the subcommand', async () => {
			const result = await parse({
				argv: ['--target', 'x', 'build'],
				schema: { commands: { build: { options: { '--target <t>': null } } } },
			});
			expect(result.cmd?.name).to.equal('build');
			expect(result.argv.target).to.equal('x');
		});
	});

	describe('flag values', () => {
		it('should honor an explicit false on a flag', async () => {
			const result = await parse({
				argv: ['--flag=false'],
				schema: { options: { '--flag': null } },
			});
			expect(result.argv.flag).to.equal(false);
		});

		it('should honor an explicit true on a flag', async () => {
			const result = await parse({
				argv: ['--flag=true'],
				schema: { options: { '--flag': null } },
			});
			expect(result.argv.flag).to.equal(true);
		});

		it('should treat the affirmative form of a negated flag as true', async () => {
			const result = await parse({
				argv: ['--colors'],
				schema: { options: { '--no-colors': null } },
			});
			expect(result.argv.colors).to.equal(true);
		});

		it('should treat an explicit false on a negated flag as a double negative', async () => {
			const result = await parse({
				argv: ['--no-colors=false'],
				schema: { options: { '--no-colors': null } },
			});
			expect(result.argv.colors).to.equal(true);
		});
	});

	describe('choices', () => {
		it('should not validate an option that was never supplied', async () => {
			// `[s]` rather than `<s>` because angle brackets make the option
			// itself required, which is this parser's own convention
			const result = await parse({
				schema: { options: { '--size [s]': { choices: ['sm', 'lg'] } } },
			});
			expect(result.argv.size).to.equal(undefined);
		});

		it('should not validate an optional option that only has a default', async () => {
			const result = await parse({
				schema: { options: { '--size [s]': { choices: ['sm', 'lg'], default: 'sm' } } },
			});
			expect(result.argv.size).to.equal('sm');
		});

		it('should reject an invalid option value', async () => {
			await expect(
				parse({
					argv: ['--size', 'xl'],
					schema: { options: { '--size <s>': { choices: ['sm', 'lg'] } } },
				})
			).rejects.toThrow('Invalid value "xl" for option --size');
		});

		it('should validate every value of a multiple option', async () => {
			await expect(
				parse({
					argv: ['--size', 'sm', '--size', 'xl'],
					schema: { options: { '--size <s>': { choices: ['sm', 'lg'], multiple: true } } },
				})
			).rejects.toThrow('Invalid value "xl" for option --size');
		});

		it('should enforce argument choices', async () => {
			await expect(
				parse({
					argv: ['xl'],
					schema: { args: [{ name: '<size>', choices: ['sm', 'lg'] }] },
				})
			).rejects.toThrow('Invalid value "xl" for argument <size>');
		});

		it('should accept a valid argument value', async () => {
			const result = await parse({
				argv: ['sm'],
				schema: { args: [{ name: '<size>', choices: ['sm', 'lg'] }] },
			});
			expect(result.argv.size).to.equal('sm');
		});

		// `multiple` is about shape, so the shape cannot depend on where the value came
		// from: a string is one value even when it parses to an array
		it('should wrap an environment value that coerces to an array', async () => {
			const options = { '--items [i]': { env: 'ITEMS', multiple: true, type: 'json' } };

			const fromEnv = await parse({
				argv: [],
				env: { ITEMS: '[1,2]' },
				schema: { help: false, options },
			});
			const fromArgv = await parse({
				argv: ['--items', '[1,2]'],
				schema: { help: false, options },
			});

			expect(fromEnv.argv.items).to.deep.equal([[1, 2]]);
			expect(fromEnv.argv.items).to.deep.equal(fromArgv.argv.items);
		});

		// a string default is one value even when it parses to an array, the same way
		// the same text on the command line is one value
		it('should wrap a string default that coerces to an array', async () => {
			const options = { '--items [i]': { default: '[]', multiple: true, type: 'json' } };

			const fromDefault = await parse({ argv: [], schema: { help: false, options } });
			const fromArgv = await parse({ argv: ['--items', '[]'], schema: { help: false, options } });

			expect(fromDefault.argv.items).to.deep.equal([[]]);
			expect(fromDefault.argv.items).to.deep.equal(fromArgv.argv.items);
		});

		it('should wrap an auto environment value that coerces to an array', async () => {
			const result = await parse({
				argv: [],
				env: { ITEMS: '[1,2]' },
				schema: {
					help: false,
					options: { '--items [i]': { env: 'ITEMS', multiple: true, type: 'auto' } },
				},
			});

			expect(result.argv.items).to.deep.equal([[1, 2]]);
		});

		// an array `default` is the list itself, which is the existing rule
		it('should leave an array default as the list', async () => {
			const result = await parse({
				argv: [],
				schema: { help: false, options: { '--tag [t]': { default: ['a', 'b'], multiple: true } } },
			});
			expect(result.argv.tag).to.deep.equal(['a', 'b']);
		});

		// accumulating reads the destination back, so what it reads has to be its own:
		// the rule for a shared destination is that the last writer wins, not that it
		// extends whatever was there
		it('should not let a multiple option extend an argument array', async () => {
			const result = await parse({
				argv: ['a', '-n', '1'],
				schema: {
					help: false,
					args: [{ name: '[tag...]', choices: ['a'] }],
					options: { '-n [v]': { choices: [1], multiple: true, name: 'tag', type: 'int' } },
				},
			});

			// `['a', 1]` used to come out of this, and then failed the option's choices
			expect(result.argv.tag).to.deep.equal([1]);
		});

		it('should not let a counter increment an argument value', async () => {
			const result = await parse({
				argv: ['10', '-v'],
				schema: {
					help: false,
					args: [{ name: '[v]', type: 'int' }],
					options: { '-v': { type: 'count' } },
				},
			});

			// `-v` appeared once, so it is 1 rather than 11
			expect(result.argv.v).to.equal(1);
		});

		// two declarations on one destination replace rather than merge, which is what
		// last-writer-wins means everywhere else and what `src/infer.ts` types: a union
		// of what each source produces, never one value built out of both. An alias is
		// not a second declaration, so it still accumulates.
		it('should let the second declaration of a destination replace the first', async () => {
			const tags = await parse({
				argv: ['cmd', '--tag', 'a', '--label', 'b'],
				schema: {
					help: false,
					options: { '--tag [t]': { multiple: true } },
					commands: { cmd: { options: { '--label [l]': { multiple: true, name: 'tag' } } } },
				},
			});
			expect(tags.argv.tag).to.deep.equal(['b']);

			const counted = await parse({
				argv: ['cmd', '-v', '--verbose'],
				schema: {
					help: false,
					options: { '-v': { name: 'verbose', type: 'count' } },
					commands: { cmd: { options: { '--verbose': { type: 'count' } } } },
				},
			});
			expect(counted.argv.verbose).to.equal(1);
		});

		it('should accumulate across an alias, which is the same declaration', async () => {
			const result = await parse({
				argv: ['--tag', 'a', '-t', 'b'],
				schema: { help: false, options: { '-t, --tag [t]': { multiple: true } } },
			});
			expect(result.argv.tag).to.deep.equal(['a', 'b']);
		});

		it('should still accumulate its own repeated uses', async () => {
			const tags = await parse({
				argv: ['--tag', 'a', '--tag', 'b'],
				schema: { help: false, options: { '--tag [t]': { multiple: true } } },
			});
			expect(tags.argv.tag).to.deep.equal(['a', 'b']);

			const counted = await parse({
				argv: ['-vvv'],
				schema: { help: false, options: { '-v': { type: 'count' } } },
			});
			expect(counted.argv.v).to.equal(3);
		});

		// an option and a positional argument of the same name share a destination,
		// and each has its own `choices`: whoever wrote the value is who it answers
		// to. Validating whatever was on the destination meant the other one's rules
		// were applied to a value it did not produce.
		it('should hold each writer of a shared destination to its own choices', async () => {
			const schema = {
				help: false,
				args: [{ name: 'size', choices: ['big'] }],
				options: { '--size [s]': { choices: ['sm'] } },
			};

			expect((await parse({ argv: ['--size', 'sm'], schema })).argv.size).to.equal('sm');
			expect((await parse({ argv: ['big'], schema })).argv.size).to.equal('big');

			await expect(parse({ argv: ['--size', 'big'], schema })).rejects.toThrow(
				'Invalid value "big" for option --size'
			);
			await expect(parse({ argv: ['sm'], schema })).rejects.toThrow(
				'Invalid value "sm" for argument <size>'
			);
		});
	});

	describe('defaults and environment variables', () => {
		it('should coerce an environment variable to the declared type', async () => {
			const result = await parse({
				env: { N: '42' },
				schema: { options: { '--num <n>': { type: 'int', env: 'N' } } },
			});
			expect(result.argv.num).to.equal(42);
		});

		it('should coerce a string default to the declared type', async () => {
			const result = await parse({
				schema: { options: { '--num <n>': { type: 'int', default: '42' } } },
			});
			expect(result.argv.num).to.equal(42);
		});

		it('should leave a non-string default alone', async () => {
			const result = await parse({
				schema: { options: { '--num <n>': { type: 'int', default: 8080 } } },
			});
			expect(result.argv.num).to.equal(8080);
		});

		it('should wrap an environment fallback for a multiple option', async () => {
			const result = await parse({
				env: { TAG: 'a' },
				schema: { options: { '--tag <t>': { env: 'TAG', multiple: true } } },
			});
			expect(result.argv.tag).to.deep.equal(['a']);
		});

		it('should coerce an argument environment fallback', async () => {
			const result = await parse({
				env: { PORT: '3000' },
				schema: { args: [{ name: '[port]', type: 'int', env: 'PORT' }] },
			});
			expect(result.argv.port).to.equal(3000);
		});

		it('should prefer an environment variable over a default', async () => {
			const result = await parse({
				env: { N: '42' },
				schema: { options: { '--num <n>': { type: 'int', env: 'N', default: 8080 } } },
			});
			expect(result.argv.num).to.equal(42);
		});

		it('should prefer an environment variable over an argument default', async () => {
			const result = await parse({
				env: { PORT: '3000' },
				schema: { args: [{ name: '[port]', type: 'int', env: 'PORT', default: 8080 }] },
			});
			expect(result.argv.port).to.equal(3000);
		});

		it('should reach an environment variable through a flag implicit default', async () => {
			const result = await parse({
				env: { FORCE: 'true' },
				schema: { options: { '--force': { env: 'FORCE' } } },
			});
			expect(result.argv.force).to.equal(true);
		});

		it('should prefer an argv value over an environment variable', async () => {
			const result = await parse({
				argv: ['--num', '7'],
				env: { N: '42' },
				schema: { options: { '--num <n>': { type: 'int', env: 'N', default: 8080 } } },
			});
			expect(result.argv.num).to.equal(7);
		});

		it('should prefer an argv value over a default', async () => {
			const result = await parse({
				argv: ['--num', '7'],
				schema: { options: { '--num <n>': { type: 'int', default: 42 } } },
			});
			expect(result.argv.num).to.equal(7);
		});
	});

	describe('variadic arguments', () => {
		it('should accept <name...>', async () => {
			const result = await parse({
				argv: ['a', 'b'],
				schema: { args: ['<rest...>'] },
			});
			expect(result.argv.rest).to.deep.equal(['a', 'b']);
		});

		it('should accept [name...]', async () => {
			const result = await parse({
				argv: ['a', 'b', 'c'],
				schema: { args: ['<first>', '[rest...]'] },
			});
			expect(result.argv.first).to.equal('a');
			expect(result.argv.rest).to.deep.equal(['b', 'c']);
		});

		it('should still accept [name]...', async () => {
			const result = await parse({
				argv: ['a', 'b', 'c'],
				schema: { args: ['<first>', '[rest]...'] },
			});
			expect(result.argv.first).to.equal('a');
			expect(result.argv.rest).to.deep.equal(['b', 'c']);
		});

		it('should require a variadic declared with angle brackets', async () => {
			await expect(parse({ schema: { args: ['<rest...>'] } })).rejects.toThrow(
				'Missing required arguments: <rest>'
			);
		});
	});

	describe('a variadic argument that is not last', () => {
		it('should allow a variadic as the last argument', async () => {
			const result = await parse({
				argv: ['a', 'b', 'c'],
				schema: { args: ['<first>', '[rest...]'] },
			});
			expect(result.argv.first).to.equal('a');
			expect(result.argv.rest).to.deep.equal(['b', 'c']);
		});

		it('should allow a lone variadic', async () => {
			const result = await parse({ argv: ['a', 'b'], schema: { args: ['[rest...]'] } });
			expect(result.argv.rest).to.deep.equal(['a', 'b']);
		});

		it('should reject a variadic followed by another argument', async () => {
			await expect(parse({ schema: { args: ['<rest...>', '[extra]'] } })).rejects.toThrow(
				'Only the last argument can be variadic: <rest...> is followed by [extra] in the "global" command'
			);
		});

		it('should reject a variadic in the middle', async () => {
			await expect(parse({ schema: { args: ['<first>', '[mid...]', '[last]'] } })).rejects.toThrow(
				'Only the last argument can be variadic: [mid...] is followed by [last] in the "global" command'
			);
		});

		it('should reject two variadics and name the first', async () => {
			await expect(parse({ schema: { args: ['<a...>', '<b...>'] } })).rejects.toThrow(
				'Only the last argument can be variadic: <a...> is followed by <b...> in the "global" command'
			);
		});

		it('should reject the "[name]..." spelling too', async () => {
			await expect(parse({ schema: { args: ['[rest]...', '[extra]'] } })).rejects.toThrow(
				'Only the last argument can be variadic: [rest...] is followed by [extra] in the "global" command'
			);
		});

		it('should reject an explicit multiple that is not last', async () => {
			await expect(
				parse({ schema: { args: [{ name: 'rest', multiple: true }, '[extra]'] } })
			).rejects.toThrow(
				'Only the last argument can be variadic: [rest...] is followed by [extra] in the "global" command'
			);
		});

		it('should reject args declared inline in a command name', async () => {
			await expect(
				parse({ argv: ['build'], schema: { commands: { 'build <files...> [extra]': {} } } })
			).rejects.toThrow(
				'Only the last argument can be variadic: <files...> is followed by [extra] in the "build" command'
			);
		});

		it('should reject args declared on a subcommand', async () => {
			await expect(
				parse({ argv: ['build'], schema: { commands: { build: { args: ['a...', 'b'] } } } })
			).rejects.toThrow(
				'Only the last argument can be variadic: [a...] is followed by [b] in the "build" command'
			);
		});

		it('should reject args declared by a lazy loaded command', async () => {
			const schema = {
				commands: { sub: { path: path.join(__dirname, 'fixtures/variadic/bad-args.js') } },
			};

			// the same schema object must not quietly pass the second time: a
			// failed load leaves the placeholder in place, so it has to be retried
			for (let i = 0; i < 2; i++) {
				await expect(parse({ argv: ['sub'], schema })).rejects.toThrow(
					'Only the last argument can be variadic: <rest...> is followed by [extra] in the "sub" command'
				);
			}
		});

		it('should not promote a later argument before rejecting', async () => {
			const args: Argument[] = [{ name: '[a...]' }, { name: '[b]' }, { name: '<c>' }];
			await expect(parse({ schema: { args } })).rejects.toThrow(
				'Only the last argument can be variadic'
			);
			// promotion runs after the check, and in any case only ever touches
			// the copies the parser owns
			expect(args).to.deep.equal([{ name: '[a...]' }, { name: '[b]' }, { name: '<c>' }]);
		});
	});

	describe('a lazy load that fails', () => {
		it('should throw again instead of passing the second time', async () => {
			const schema = {
				commands: { sub: { path: path.join(__dirname, 'fixtures/variadic/bad-hook.js') } },
			};

			// a command is only fully initialized once its init hooks have run, so
			// a hook that throws leaves the placeholder unloaded and has to run
			// again the next time the command is matched
			for (let i = 0; i < 2; i++) {
				await expect(parse({ argv: ['sub'], schema })).rejects.toThrow('init hook blew up');
			}
		});

		it('should throw again when the same placeholder is reloaded', async () => {
			// every parse now builds its own placeholder, so the retry above no
			// longer pins down the flag itself: load the one placeholder twice
			const { contexts } = await parse({
				argv: [],
				schema: {
					commands: { sub: { path: path.join(__dirname, 'fixtures/variadic/bad-hook.js') } },
				},
			});
			const cmd = contexts[0][Internal].commands.find('sub');
			expect(cmd).to.not.equal(undefined);

			for (let i = 0; i < 2; i++) {
				await expect(loadCommand(cmd!)).rejects.toThrow('init hook blew up');
				expect(cmd![Internal].loaded).to.not.equal(true);
			}
		});
	});

	describe('default data type', () => {
		it('should leave an untyped option value as a string', async () => {
			const result = await parse({
				argv: ['--v', '007'],
				schema: { options: { '--v <x>': null } },
			});
			expect(result.argv.v).to.equal('007');
		});

		it('should leave an untyped argument value as a string', async () => {
			const result = await parse({
				argv: ['007'],
				schema: { args: ['<v>'] },
			});
			expect(result.argv.v).to.equal('007');
		});

		it('should still coerce when a type is declared', async () => {
			const result = await parse({
				argv: ['--v', '007'],
				schema: { options: { '--v <x>': { type: 'int' } } },
			});
			expect(result.argv.v).to.equal(7);
		});
	});

	describe('command hidden', () => {
		it('should not let name parsing overwrite an explicit hidden', async () => {
			const { contexts } = await parse({
				argv: ['visible'],
				schema: { commands: { visible: { hidden: true } } },
			});
			expect(contexts[0].name).to.equal('visible');
			expect(contexts[0].hidden).to.equal(true);
		});

		it('should keep an explicit hidden on a command with inline args', async () => {
			const { contexts } = await parse({
				argv: ['build', 'src'],
				schema: { commands: { 'build, @b <path>': { hidden: true } } },
			});
			expect(contexts[0].name).to.equal('build');
			expect(contexts[0].hidden).to.equal(true);
		});

		it('should keep an explicit hidden on a nested subcommand', async () => {
			const { contexts } = await parse({
				argv: ['outer', 'inner'],
				schema: { commands: { outer: { commands: { inner: { hidden: true } } } } },
			});
			expect(contexts[0].name).to.equal('inner');
			expect(contexts[0].hidden).to.equal(true);
		});

		it('should keep an explicit hidden on a lazy loaded command', async () => {
			const { contexts } = await parse({
				argv: ['secret'],
				schema: {
					commands: {
						secret: { path: path.join(__dirname, 'fixtures/hidden/secret.js') },
					},
				},
			});
			expect(contexts[0].name).to.equal('secret');
			expect(contexts[0].hidden).to.equal(true);
		});

		it('should keep an explicit hidden on the placeholder of a lazy loaded command', async () => {
			const { contexts } = await parse({
				argv: ['plain'],
				schema: {
					commands: {
						plain: { hidden: true, path: path.join(__dirname, 'fixtures/hidden/plain.js') },
					},
				},
			});
			expect(contexts[0].name).to.equal('plain');
			expect(contexts[0].hidden).to.equal(true);
		});

		it('should not let a lazy loaded command un-hide a "!" prefixed name', async () => {
			const { contexts } = await parse({
				argv: ['visible'],
				schema: {
					commands: {
						'!visible': { path: path.join(__dirname, 'fixtures/hidden/visible.js') },
					},
				},
			});
			expect(contexts[0].name).to.equal('visible');
			expect(contexts[0].hidden).to.equal(true);
		});

		it('should still hide a command with a "!" prefixed name', async () => {
			const { contexts } = await parse({
				argv: ['foo'],
				schema: { commands: { '!foo': {} } },
			});
			expect(contexts[0].name).to.equal('foo');
			expect(contexts[0].hidden).to.equal(true);
		});

		it('should not let an explicit false un-hide a "!" prefixed name', async () => {
			const { contexts } = await parse({
				argv: ['foo'],
				schema: { commands: { '!foo': { hidden: false } } },
			});
			expect(contexts[0].hidden).to.equal(true);
		});

		it('should default hidden to false', async () => {
			const { contexts } = await parse({
				argv: ['foo'],
				schema: { commands: { foo: {} } },
			});
			expect(contexts[0].hidden).to.equal(false);
		});
	});

	describe('command name labels', () => {
		it('should treat a second bare label as an alias, not a rename', async () => {
			const schema = { commands: { 'build, b': {} } };

			let { contexts } = await parse({ argv: ['build'], schema });
			expect(contexts[0].name).to.equal('build');

			({ contexts } = await parse({ argv: ['b'], schema }));
			expect(contexts[0].name).to.equal('build');
			expect(contexts[0][Internal].label).to.equal('build, b');
		});

		it('should treat a space separated label as an alias', async () => {
			const schema = { commands: { 'build b': {} } };

			let { contexts } = await parse({ argv: ['build'], schema });
			expect(contexts[0].name).to.equal('build');

			({ contexts } = await parse({ argv: ['b'], schema }));
			expect(contexts[0].name).to.equal('build');
		});

		it('should alias every bare label after the first', async () => {
			const schema = { commands: { 'build, b, compile': {} } };

			for (const name of ['build', 'b', 'compile']) {
				const { contexts } = await parse({ argv: [name], schema });
				expect(contexts[0].name).to.equal('build');
			}

			const { contexts } = await parse({ argv: ['build'], schema });
			expect(contexts[0][Internal].label).to.equal('build, b, compile');
		});

		it('should mix bare and "@" prefixed labels', async () => {
			const schema = { commands: { 'build, @b, compile': {} } };

			for (const name of ['build', 'b', 'compile']) {
				const { contexts } = await parse({ argv: [name], schema });
				expect(contexts[0].name).to.equal('build');
			}
		});

		it('should let a bare label name a command declared after a "@" label', async () => {
			const schema = { commands: { '@ls, list': {} } };

			let { contexts } = await parse({ argv: ['ls'], schema });
			expect(contexts[0].name).to.equal('list');

			({ contexts } = await parse({ argv: ['list'], schema }));
			expect(contexts[0].name).to.equal('list');
			expect(contexts[0][Internal].label).to.equal('ls, list');
		});

		it('should name the command after a prefixed label when there is no bare label', async () => {
			const { contexts } = await parse({
				argv: ['b'],
				schema: { commands: { '@b, @build': {} } },
			});
			expect(contexts[0].name).to.equal('b');
		});

		it('should alias a bare label on a "!" prefixed command', async () => {
			const schema = { commands: { '!build, b': {} } };

			const { contexts } = await parse({ argv: ['b'], schema });
			expect(contexts[0].name).to.equal('b');
			expect(contexts[0].hidden).to.equal(true);
		});

		it('should hide the whole command when any label is "!" prefixed', async () => {
			const schema = { commands: { 'build, !b': {} } };

			let { contexts } = await parse({ argv: ['build'], schema });
			expect(contexts[0].name).to.equal('build');
			expect(contexts[0].hidden).to.equal(true);
			expect(contexts[0][Internal].label).to.equal('build');

			({ contexts } = await parse({ argv: ['b'], schema }));
			expect(contexts[0].name).to.equal('build');
		});

		it('should keep inline arguments out of the aliases', async () => {
			const schema = { commands: { 'build, b <path>': {} } };

			const { argv, contexts } = await parse({ argv: ['b', 'src'], schema });
			expect(contexts[0].name).to.equal('build');
			expect(contexts[0][Internal].label).to.equal('build, b');
			expect(argv.path).to.equal('src');
		});

		it('should combine bare labels with the alias property', async () => {
			const schema = { commands: { 'build, b': { alias: 'compile' } } };

			for (const name of ['build', 'b', 'compile']) {
				const { contexts } = await parse({ argv: [name], schema });
				expect(contexts[0].name).to.equal('build');
			}

			const { contexts } = await parse({ argv: ['build'], schema });
			expect(contexts[0][Internal].label).to.equal('build, b');
		});

		it('should ignore leading, trailing, and doubled separators', async () => {
			for (const name of [' build, b', 'build, b, ', 'build,,b']) {
				const { contexts } = await parse({ argv: ['b'], schema: { commands: { [name]: {} } } });
				expect(contexts[0].name).to.equal('build');
				expect(contexts[0][Internal].label).to.equal('build, b');
			}
		});

		it('should hide the command on a stray "!" label', async () => {
			const { contexts } = await parse({
				argv: ['build'],
				schema: { commands: { 'build, !': {} } },
			});
			expect(contexts[0].name).to.equal('build');
			expect(contexts[0].hidden).to.equal(true);
			expect(contexts[0][Internal].label).to.equal('build');
		});

		it('should ignore a stray "@" label', async () => {
			const { contexts } = await parse({
				argv: ['build'],
				schema: { commands: { 'build, @': {} } },
			});
			expect(contexts[0].name).to.equal('build');
			expect(contexts[0].hidden).to.equal(false);
			expect(contexts[0][Internal].label).to.equal('build');
		});

		it('should carry inline aliases onto a lazy loaded command', async () => {
			const { contexts } = await parse({
				argv: ['b'],
				schema: {
					commands: {
						'build, b': { path: path.join(__dirname, 'fixtures/aliases/build.js') },
					},
				},
			});
			expect(contexts[0].name).to.equal('build');
			expect(contexts[0].desc).to.equal('build it');
			expect([...contexts[0][Internal].aliases]).to.deep.equal(['b']);
			expect(contexts[0][Internal].label).to.equal('build, b');
		});

		it("should merge inline aliases with a lazy loaded command's own alias", async () => {
			const schema = {
				commands: {
					'build, b': { path: path.join(__dirname, 'fixtures/aliases/compile.js') },
				},
			};

			// `compile` comes from the module, so it cannot resolve a command the
			// parser has not loaded yet, but it must survive the merge — and the
			// second pass reuses the very same schema object
			for (const name of ['build', 'b']) {
				const { contexts } = await parse({ argv: [name], schema });
				expect(contexts[0].name).to.equal('build');
				expect([...contexts[0][Internal].aliases].sort()).to.deep.equal(['b', 'compile']);
			}
		});

		it('should throw when a name has no label', async () => {
			await expect(parse({ argv: [], schema: { commands: { ' , ': {} } } })).rejects.toThrow(
				'Unable to determine command name from " , "'
			);
		});
	});
	describe('cross-model review round 1', () => {
		// `--name=value` split the token and then trimmed both halves, while a value
		// in the following token was taken as typed, so the two spellings of the
		// same thing disagreed about whitespace the caller meant
		it('should not trim whitespace out of an attached option value', async () => {
			const schema = { options: { '--name [value]': {} } };

			expect((await parse({ argv: ['--name=  padded  '], schema })).argv.name).to.equal(
				'  padded  '
			);
			expect((await parse({ argv: ['--name', '  padded  '], schema })).argv.name).to.equal(
				'  padded  '
			);
		});

		// trimming turned a value that was one space into `''`, which for a required
		// option then failed as a value that was never given
		it('should accept a single space as a required option value', async () => {
			const result = await parse({
				argv: ['--sep= '],
				schema: { options: { '--sep <value>': {} } },
			});
			expect(result.argv.sep).to.equal(' ');
		});

		// `inputs` is the split form -- `--foo=bar` was taken apart before anything
		// knew a terminator preceded it -- so flattening it made two extras of one
		it('should keep an argument after the terminator whole', async () => {
			const result = await parse({
				argv: ['--', '--foo=bar', '-x=1', 'a=b'],
				schema: {},
				settings: { allowExtraArguments: true },
			});
			expect(result._).to.deep.equal(['--foo=bar', '-x=1', 'a=b']);
		});

		// this once read an empty `int` as 0, to match `number` and `count`. That
		// made `PORT=321 mycli --port` answer 0 while `PORT=321 mycli` answered 321:
		// a valueless use beat the environment by being written during the walk.
		// The rule now runs the other way -- an option that takes a value must be
		// given one, and an empty value is a value only where the type has one
		it('should reject an empty int rather than read it as zero', async () => {
			const schema = { options: { '--port [n]': { type: 'int' } } };

			await expect(parse({ argv: ['--port'], schema })).rejects.toThrow(
				'Missing value for option --port'
			);
			await expect(parse({ argv: ['--port='], schema })).rejects.toThrow('Invalid integer:');
			await expect(parse({ argv: ['--port= '], schema })).rejects.toThrow('Invalid integer:');
		});

		// the case that started it: a valueless use no longer outranks the
		// environment, because there is no longer any such thing
		it('should let the environment answer when argv named the option alone', async () => {
			const schema = { options: { '--port [n]': { env: 'PORT', type: 'int' } } };

			expect((await parse({ argv: [], env: { PORT: '321' }, schema })).argv.port).to.equal(321);
			await expect(parse({ argv: ['--port'], env: { PORT: '321' }, schema })).rejects.toThrow(
				'Missing value for option --port'
			);
		});

		// an empty variable is read as unset, so a blank `PORT=` falls through to
		// the default instead of failing the parse on a value nobody meant to set
		it('should treat an empty environment variable as unset', async () => {
			const result = await parse({
				argv: [],
				env: { PORT: '' },
				schema: { options: { '--port [n]': { default: 8080, env: 'PORT', type: 'int' } } },
			});
			expect(result.argv.port).to.equal(8080);
		});

		// every flag read an attached value as a `bool`, so a counter given a number
		// threw, and a counter given `false` was counted up to 1 -- the counting path
		// increments and never looks at the value
		it('should let an explicit value set a counter', async () => {
			const schema = { options: { '-v, --verbose': { type: 'count' } } };

			expect((await parse({ argv: ['-v=2'], schema })).argv.verbose).to.equal(2);
			expect((await parse({ argv: ['--verbose=5'], schema })).argv.verbose).to.equal(5);
			expect((await parse({ argv: ['-v='], schema })).argv.verbose).to.equal(0);

			// and it sets rather than increments, so what follows counts up from it
			expect((await parse({ argv: ['-v', '-v=5', '-v'], schema })).argv.verbose).to.equal(6);
		});

		it('should reject a counter value that is not a number', async () => {
			await expect(
				parse({ argv: ['-v=false'], schema: { options: { '-v': { type: 'count' } } } })
			).rejects.toThrow('Invalid count: false');
		});

		// the lookup was a plain object, so `#lookup['__proto__'] = name` went
		// through `Object.prototype`'s accessor and was dropped: the command
		// registered and could never be matched
		it('should match a command named __proto__', async () => {
			const result = await parse({
				argv: ['__proto__'],
				schema: { commands: { ['__proto__']: { desc: 'proto' } } },
			});
			expect(result.cmd?.name).to.equal('__proto__');
		});

		// the same plain-object hazard on the option registry. Argv reaches an
		// option by its dashed spelling, which registers fine, so the parse was
		// right -- but the bare name is a key too, and that one was dropped, so
		// `get()` could not find an option the registry holds. The registries are
		// what a hook is handed, so that is somebody's lookup
		it('should find an option named __proto__ by name', async () => {
			const result = await parse({
				argv: ['--__proto__', 'x'],
				schema: { options: { '--__proto__ [v]': {} } },
			});
			const options = result.contexts[0][Internal].options;
			const opt = [...options.values()][0];

			expect(opt.name).to.equal('__proto__');
			expect(options.get('__proto__')).to.equal(opt);
			expect(options.find('--__proto__')).to.equal(opt);
			expect(result.argv.Proto_).to.equal('x');
		});

		// an `exports` map nests, and unwrapping exactly one level left a conditions
		// object that reached `join()` as `[object Object]`
		it('should load a command package with conditional exports', async () => {
			const result = await parse({
				argv: ['conditions'],
				schema: { commands: path.join(__dirname, 'fixtures/good-pkg-export-conditions') },
			});
			expect(result.cmd?.name).to.equal('conditions');
			expect(result.cmd?.desc).to.equal('Conditions command');
		});

		// a fallback array means "the first of these that works", and whether one
		// works is a question about the file system: returning only the first
		// string named a path that does not exist and called the package broken
		it('should try every candidate in an exports fallback array', async () => {
			const result = await parse({
				argv: ['fallback'],
				schema: { commands: path.join(__dirname, 'fixtures/good-pkg-export-fallback') },
			});
			expect(result.cmd?.name).to.equal('fallback');
			expect(result.cmd?.desc).to.equal('Fallback command');
		});

		// `typeof null` is `'object'` and so is an array, so both slipped past the
		// check: the parse succeeded with a command that has no `run`, and the load
		// was recorded as done so it was never retried
		it.each([
			['null', 'null-default.js'],
			['an array', 'array-default.js'],
		])('should reject a command module that default exports %s', async (_label, file) => {
			await expect(
				parse({
					argv: ['foo'],
					schema: { commands: { foo: { path: path.join(__dirname, 'fixtures', file) } } },
				})
			).rejects.toThrow('Command module default export is not a valid command object');
		});
	});
	describe('cross-model review round 2', () => {
		// `dateRE` checks the shape and `Date` does the rest, and `Date` overflows
		// rather than refusing, so a day that does not exist produced the wrong day
		// instead of the error `9999-99-99` already got
		it.each([
			['2024-02-30', '2024-03-01'],
			['2023-02-29', '2023-03-01'],
			['2024-04-31', '2024-05-01'],
			['2024-13-01', 'the next year'],
		])('should reject the impossible date %s', async (value) => {
			await expect(
				parse({ argv: ['--when', value], schema: { options: { '--when <d>': { type: 'date' } } } })
			).rejects.toThrow(`Invalid date: "${value}"`);
		});

		// the control: the round trip must not reject dates that are real, including
		// a leap day, a month end, and the forms that carry a time
		it.each([
			'2024-02-29',
			'2024-01-31',
			'2024-12-31',
			'2024-06-15T12:30:00',
			'2024-06-15T12:30:00Z',
			'2024-06-15T12:30:00.123Z',
		])('should still accept the valid date %s', async (value) => {
			const result = await parse({
				argv: ['--when', value],
				schema: { options: { '--when <d>': { type: 'date' } } },
			});
			expect(result.argv.when).to.be.instanceOf(Date);
		});

		it('should still accept a 13-digit epoch', async () => {
			const result = await parse({
				argv: ['--when', '1718454600000'],
				schema: { options: { '--when <d>': { type: 'date' } } },
			});
			expect((result.argv.when as Date).getTime()).to.equal(1718454600000);
		});

		// `Number('')` and `Number(' ')` are both 0, which would make an empty or
		// blank value parse as zero where every other valued type rejects it
		it('should reject an empty or blank number', async () => {
			const schema = { options: { '--port [n]': { type: 'number' } } };

			await expect(parse({ argv: ['--port='], schema })).rejects.toThrow('Invalid number:');
			await expect(parse({ argv: ['--port= '], schema })).rejects.toThrow('Invalid number:');
			await expect(parse({ argv: ['--port=\t'], schema })).rejects.toThrow('Invalid number:');

			// a real number with space around it is still that number: `Number()`
			// trims, and only a value with nothing else in it is the empty one
			expect((await parse({ argv: ['--port= 42 '], schema })).argv.port).to.equal(42);
		});

		// past 2^53-1 a `number` is not the integer that was written, so an id given
		// to an `int` option came back as a different id and nothing said so
		it('should reject an int too large to be exact', async () => {
			await expect(
				parse({
					argv: ['--id', '9007199254740993'],
					schema: { options: { '--id <n>': { type: 'int' } } },
				})
			).rejects.toThrow('Integer is too large to be exact: 9007199254740993');
		});

		// the control: everything inside the safe range still parses, hex and
		// negatives included
		it.each([
			['9007199254740991', 9007199254740991],
			['-9007199254740991', -9007199254740991],
			['0', 0],
			['-15', -15],
			['0xff', 255],
			['007', 7],
		])('should still accept the int %s', async (value, expected) => {
			const result = await parse({
				argv: ['--id', value],
				schema: { options: { '--id <n>': { type: 'int' } } },
			});
			expect(result.argv.id).to.equal(expected);
		});
	});
	describe('cross-model review round 3', () => {
		// `/^auto|bool|count|date|int|json|number|string|yesno$/` reads as `^auto` OR
		// `bool` OR ... OR `yesno$`: the alternation binds looser than the anchors, so
		// any string merely containing one of the middle names passed the guard. Past
		// it, `transformValue()` does not know that name and hands back the raw
		// string, so a `type: 'integer'` option quietly produced a string
		it.each(['integer', 'boolean', 'autoload', 'stringify', 'number2', 'jsonl'])(
			'should reject the option data type %s',
			async (type) => {
				await expect(
					parse({ argv: ['--port', '8080'], schema: { options: { '--port <n>': { type } } } })
				).rejects.toThrow(`Option "port" has unsupported data type "${type}"`);
			}
		);

		it.each(['integer', 'boolean', 'autoload', 'stringify'])(
			'should reject the argument data type %s',
			async (type) => {
				await expect(
					parse({ argv: ['8080'], schema: { args: [{ name: 'port', type }] } })
				).rejects.toThrow(`Argument "port" has unsupported data type "${type}"`);
			}
		);

		// the control: every name the guard is meant to accept still does
		it.each(['auto', 'bool', 'count', 'date', 'int', 'json', 'number', 'string', 'yesno'])(
			'should still accept the option data type %s',
			async (type) => {
				const flag = type === 'count' || type === 'bool' || type === 'yesno';
				await expect(
					parse({
						argv: [],
						schema: { options: { [flag ? '--on' : '--port [n]']: { type } } },
					})
				).resolves.toBeTruthy();
			}
		);

		// the parts of a date are checked arithmetically rather than by reading them
		// back off the `Date`, because those getters are local while the value may be
		// UTC -- `2024-06-15T00:00:00Z` is the 14th in Chicago and the 15th in
		// Auckland, so a round trip rejected real instants depending on where it ran
		it('should accept a UTC instant whose local day differs', async () => {
			const schema = { options: { '--when <d>': { type: 'date' } } };

			for (const value of [
				'2024-06-15T00:00:00Z',
				'2024-06-15T23:59:59Z',
				'2024-01-01T00:00:00Z',
			]) {
				const result = await parse({ argv: ['--when', value], schema });
				expect((result.argv.when as Date).toISOString()).to.equal(new Date(value).toISOString());
			}
		});
	});
});
