import { command } from '../src/command.js';
import { options } from '../src/options.js';
import { parse } from '../src/parser/parse.js';
import type { Schema } from '../src/types.js';
import { describe, expect, it } from 'vitest';

/**
 * Fails to compile unless the two types are the same. Invariant in both
 * directions, so a wider or a narrower type is a failure rather than a pass --
 * which is what makes these assertions worth anything, since `unknown` and `any`
 * would otherwise satisfy everything.
 *
 * Checked by `pnpm type-check`, which covers the test tree. The runtime
 * expectations alongside them are what makes the file show up as tests.
 */
type Exact<A, B> =
	(<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
		? true
		: { expected: B; got: A };

function expectType<B>(): <A>(check: Exact<A, B>) => void {
	return () => {};
}

const global = options({
	'-v, --verbose': 'Say more',
	'--port [n]': { default: 8080, type: 'int' },
});

describe('options', () => {
	it('should infer a flag as a boolean that is always there', () => {
		command({
			options: { '-v, --verbose': null, '--no-color': 'Turn color off' },
			run: ({ argv }) => {
				expectType<boolean>()<typeof argv.verbose>(true);
				// a negated flag shares its twin's destination, so the key is `color`
				expectType<boolean>()<typeof argv.color>(true);
			},
		});
		expect(true).toBe(true);
	});

	it('should infer the data type of a valued option', () => {
		command({
			options: {
				'--out [file]': null,
				'--port [n]': { type: 'int' },
				'--when [d]': { type: 'date' },
				'--flagish [b]': { type: 'bool' },
				'--blob [j]': { type: 'json' },
			},
			run: ({ argv }) => {
				expectType<string | undefined>()<typeof argv.out>(true);
				expectType<number | undefined>()<typeof argv.port>(true);
				expectType<Date | undefined>()<typeof argv.when>(true);
				expectType<boolean | undefined>()<typeof argv.flagish>(true);
				expectType<unknown>()<typeof argv.blob>(true);
			},
		});
		expect(true).toBe(true);
	});

	it('should infer choices as a literal union', () => {
		command({
			options: { '--log-level <l>': { choices: ['trace', 'info', 'warn'] } },
			run: ({ argv }) => {
				// and camelCase, and `<l>` making it required so the key is always there
				expectType<'trace' | 'info' | 'warn'>()<typeof argv.logLevel>(true);
			},
		});
		expect(true).toBe(true);
	});

	// `<value>` makes the option itself required, which is why the key is not
	// optional; `[value]` leaves it absent until something sets it
	it('should infer optionality from the hint and the default', () => {
		command({
			options: {
				'--required <v>': null,
				'--optional [v]': null,
				'--defaulted [v]': { default: 'x' },
			},
			run: ({ argv }) => {
				expectType<string>()<typeof argv.required>(true);
				expectType<string | undefined>()<typeof argv.optional>(true);
				expectType<string>()<typeof argv.defaulted>(true);
			},
		});
		expect(true).toBe(true);
	});

	it('should infer multiple as an array', () => {
		command({
			options: {
				'--tag [t]': { multiple: true },
				'--num [n]': { multiple: true, type: 'int' },
				'--mode [m]': { choices: ['a', 'b'], multiple: true },
			},
			run: ({ argv }) => {
				expectType<string[] | undefined>()<typeof argv.tag>(true);
				expectType<number[] | undefined>()<typeof argv.num>(true);
				expectType<('a' | 'b')[] | undefined>()<typeof argv.mode>(true);
			},
		});
		expect(true).toBe(true);
	});

	it('should infer a count flag as a number', () => {
		command({
			options: { '-v': { type: 'count' } },
			run: ({ argv }) => expectType<number>()<typeof argv.v>(true),
		});
		expect(true).toBe(true);
	});

	it('should read a bare word as the name it declares', () => {
		command({
			options: { verbose: 'Say more' },
			run: ({ argv }) => expectType<boolean>()<typeof argv.verbose>(true),
		});
		expect(true).toBe(true);
	});
});

describe('arguments', () => {
	it('should infer names, optionality, and variadics', () => {
		command({
			args: ['<platform>', '[outfile]', '[extras]...'],
			run: ({ argv }) => {
				expectType<string>()<typeof argv.platform>(true);
				expectType<string | undefined>()<typeof argv.outfile>(true);
				expectType<string[] | undefined>()<typeof argv.extras>(true);
			},
		});
		expect(true).toBe(true);
	});

	it('should read every spelling of variadic', () => {
		command({
			args: ['<files...>'],
			run: ({ argv }) => expectType<string[]>()<typeof argv.files>(true),
		});
		command({
			args: ['[files...]'],
			run: ({ argv }) => expectType<string[] | undefined>()<typeof argv.files>(true),
		});
		expect(true).toBe(true);
	});

	it('should infer an object declaration and camelCase its name', () => {
		command({
			args: [{ name: '<entry-file>' }, { choices: ['dev', 'prod'], name: '[mode]' }],
			run: ({ argv }) => {
				expectType<string>()<typeof argv.entryFile>(true);
				expectType<'dev' | 'prod' | undefined>()<typeof argv.mode>(true);
			},
		});
		expect(true).toBe(true);
	});
});

describe('options declared above the command', () => {
	// they resolve -- options resolve across the whole context chain -- and they are
	// not inferred, because a command is typed at its own `command()` call and
	// nothing there knows where in the tree it will be mounted
	it('should be unknown rather than an error', () => {
		command({
			options: { '-w, --watch': null },
			run: ({ argv }) => {
				expectType<boolean>()<typeof argv.watch>(true);
				expectType<unknown>()<typeof argv.verbose>(true);
			},
		});
		expect(true).toBe(true);
	});

	// the way to have them typed, at the cost of declaring them here too
	it('should be typed when the group is spread into the command own options', () => {
		command({
			options: { ...global, '-w, --watch': null },
			run: ({ argv }) => {
				expectType<boolean>()<typeof argv.watch>(true);
				expectType<boolean>()<typeof argv.verbose>(true);
				expectType<number>()<typeof argv.port>(true);
			},
		});
		expect(true).toBe(true);
	});
});

// `unknown` and `any` satisfy any assertion, so the negative cases are what say
// this is real inference rather than a type hole
describe('it is real inference', () => {
	it('should know the type of what was declared, and no more', () => {
		command({
			options: { '--watch': null, '--port [n]': { type: 'int' } },
			run: ({ argv }) => {
				// @ts-expect-error -- a flag is a boolean, not a string
				expectType<string>()<typeof argv.watch>(true);
				// @ts-expect-error -- `type: 'int'` is a number, not a string
				expectType<string | undefined>()<typeof argv.port>(true);
				// a key nothing declared is `unknown`: the command may well be mounted
				// under something that declares it
				expectType<unknown>()<typeof argv.nope>(true);
			},
		});
		expect(true).toBe(true);
	});
});

// a command written as a bare object, or loaded from a module, has nothing to read
describe('what is left wide', () => {
	it('should leave a bare declaration with the argv it always had', () => {
		const schema: Schema = {
			name: 'mycli',
			commands: {
				build: {
					options: { '--watch': null },
					run: ({ argv }) => {
						// nothing narrowed, so every key is `unknown` -- including the one
						// this declaration wrote, which is what says the wrapper is what
						// does the narrowing
						expectType<unknown>()<typeof argv.watch>(true);
						// still readable, which is what every existing schema relies on
						return argv.anythingAtAll;
					},
				},
			},
		};
		expect(schema).toBeTruthy();
	});
});

// every one of these is a rule where the type system and the runtime could drift,
// so each asserts the type and then parses argv to confirm the two agree
describe('rules that are easy to get wrong', () => {
	/** What the parser actually produces for one command's declaration. */
	async function argvOf(decl: Record<string, unknown>, argv: string[]) {
		const state = await parse({
			argv: ['build', ...argv],
			schema: { help: false, name: 'mycli', commands: { build: decl } },
		});
		return state.argv;
	}

	// `initOption()` gives an option with choices an implied hint, so it is valued
	// rather than a flag -- which is the rule most easily missed, because
	// `'--mode': { choices: [...] }` looks like a flag
	it('should read choices as making an option valued', async () => {
		command({
			options: { '--mode': { choices: ['a', 'b'] } },
			run: ({ argv }) => expectType<'a' | 'b' | undefined>()<typeof argv.mode>(true),
		});
		expect(await argvOf({ options: { '--mode': { choices: ['a', 'b'] } } }, [])).toEqual({});
		expect(
			await argvOf({ options: { '--mode': { choices: ['a', 'b'] } } }, ['--mode', 'a'])
		).toEqual({ mode: 'a' });
	});

	// an option that can hold no value, which is what the parser makes of it too:
	// every value is checked against the list and the list has nothing in it
	it('should read an empty choices list as never', async () => {
		command({
			options: { '--mode': { choices: [] } },
			run: ({ argv }) => expectType<never | undefined>()<typeof argv.mode>(true),
		});
		await expect(
			argvOf({ options: { '--mode': { choices: [] } } }, ['--mode', 'x'])
		).rejects.toThrow('Invalid value "x" for option --mode');
	});

	it('should read required written out, either way', async () => {
		command({
			options: { '--out [file]': { required: true }, '--in <file>': { required: false } },
			run: ({ argv }) => {
				expectType<string>()<typeof argv.out>(true);
				expectType<string | undefined>()<typeof argv.in>(true);
			},
		});
		// required, so a parse without it throws rather than returning without it
		await expect(argvOf({ options: { '--out [file]': { required: true } } }, [])).rejects.toThrow(
			/Missing required options/
		);
		expect(await argvOf({ options: { '--in <file>': { required: false } } }, [])).toEqual({});
	});

	// only a flag is negated, and only when `negate` was not turned off
	it('should read negate: false and a valued no- option as their own destination', async () => {
		command({
			options: { '--no-color': { negate: false }, '--no-cheese [type]': null },
			run: ({ argv }) => {
				expectType<boolean>()<typeof argv.noColor>(true);
				expectType<string | undefined>()<typeof argv.noCheese>(true);
			},
		});
		expect(await argvOf({ options: { '--no-color': { negate: false } } }, [])).toEqual({
			noColor: false,
		});
		expect(await argvOf({ options: { '--no-cheese [type]': null } }, ['--no-cheese', 'x'])).toEqual(
			{
				noCheese: 'x',
			}
		);
	});

	// the first part that is a long name or a bare word names the option, so
	// position decides it
	it('should name an option the way the format order does', async () => {
		command({
			options: { 'verbose, --all': null, '--a, --b': null, '-x': null },
			run: ({ argv }) => {
				expectType<boolean>()<typeof argv.verbose>(true);
				expectType<boolean>()<typeof argv.a>(true);
				expectType<boolean>()<typeof argv.x>(true);
			},
		});
		expect(await argvOf({ options: { 'verbose, --all': null } }, [])).toEqual({ verbose: false });
		expect(await argvOf({ options: { '--a, --b': null } }, [])).toEqual({ a: false });
		expect(await argvOf({ options: { '-x': null } }, [])).toEqual({ x: false });
		// and `--all` still answers to the name it was aliased under
		expect(await argvOf({ options: { 'verbose, --all': null } }, ['--all'])).toEqual({
			verbose: true,
		});
	});

	// they share a destination by design, and the pair is undefined until something
	// sets it: the negated flag's implied default gives way to its valued twin
	it('should read a dual option as one destination holding either value', async () => {
		command({
			options: { '--cheese [type]': null, '--no-cheese': null },
			run: ({ argv }) => expectType<string | boolean | undefined>()<typeof argv.cheese>(true),
		});
		const decl = { options: { '--cheese [type]': null, '--no-cheese': null } };
		expect(await argvOf(decl, [])).toEqual({});
		expect(await argvOf(decl, ['--cheese', 'brie'])).toEqual({ cheese: 'brie' });
		expect(await argvOf(decl, ['--no-cheese'])).toEqual({ cheese: false });
	});

	// two flags on one destination: the positive one's default still applies
	it('should read a pair of flags as always set', async () => {
		command({
			options: { '--color': null, '--no-color': null },
			run: ({ argv }) => expectType<boolean>()<typeof argv.color>(true),
		});
		expect(await argvOf({ options: { '--color': null, '--no-color': null } }, [])).toEqual({
			color: false,
		});
	});

	// there is no way to skip it, so the parser promotes it
	it('should promote an optional argument before a required one', async () => {
		command({
			args: ['[a]', '<b>'],
			run: ({ argv }) => {
				expectType<string>()<typeof argv.a>(true);
				expectType<string>()<typeof argv.b>(true);
			},
		});
		await expect(argvOf({ args: ['[a]', '<b>'] }, [])).rejects.toThrow(
			'Missing required arguments: <a> <b>'
		);
		expect(await argvOf({ args: ['[a]', '<b>'] }, ['one', 'two'])).toEqual({ a: 'one', b: 'two' });
	});

	it('should read multiple and required written out on an argument', async () => {
		command({
			args: [{ multiple: true, name: '[rest]' }],
			run: ({ argv }) => expectType<string[] | undefined>()<typeof argv.rest>(true),
		});
		command({
			args: [{ name: '[x]', required: true }],
			run: ({ argv }) => expectType<string>()<typeof argv.x>(true),
		});
		expect(await argvOf({ args: [{ multiple: true, name: '[rest]' }] }, ['a', 'b'])).toEqual({
			rest: ['a', 'b'],
		});
		await expect(argvOf({ args: [{ name: '[x]', required: true }] }, [])).rejects.toThrow(
			/Missing required arguments/
		);
	});

	// `initOption()` reads all three, and a declared one wins over the key
	it('should read a declared format, name, and hint', async () => {
		command({
			options: {
				'--port': { hint: 'n' },
				'--verbose': { name: 'loud' },
				ignored: { format: '--actual [n]', type: 'int' },
			},
			run: ({ argv }) => {
				expectType<string | undefined>()<typeof argv.port>(true);
				expectType<boolean>()<typeof argv.loud>(true);
				expectType<number | undefined>()<typeof argv.actual>(true);
			},
		});
		expect(await argvOf({ options: { '--port': { hint: 'n' } } }, ['--port', '80'])).toEqual({
			port: '80',
		});
		expect(await argvOf({ options: { '--verbose': { name: 'loud' } } }, [])).toEqual({
			loud: false,
		});
		expect(
			await argvOf({ options: { ignored: { format: '--actual [n]', type: 'int' } } }, [
				'--actual',
				'7',
			])
		).toEqual({ actual: 7 });
	});

	// `camelCase()` splits on `-`, `_`, and a space, in runs
	it('should camelCase every separator the parser does', async () => {
		command({
			options: { '--dry_run': null, '--a--b': null },
			args: ['<out_file>'],
			run: ({ argv }) => {
				expectType<boolean>()<typeof argv.dryRun>(true);
				expectType<boolean>()<typeof argv.aB>(true);
				expectType<string>()<typeof argv.outFile>(true);
			},
		});
		expect(await argvOf({ options: { '--dry_run': null } }, [])).toEqual({ dryRun: false });
		expect(await argvOf({ args: ['<out_file>'] }, ['x'])).toEqual({ outFile: 'x' });
	});

	// a default fills the destination whatever else was said, and `undefined` is
	// not a default at all
	it('should read a default as filling the key, and undefined as none', async () => {
		command({
			options: {
				'--out <file>': { default: 'x', required: false },
				'--mode [m]': { default: undefined },
			},
			run: ({ argv }) => {
				expectType<string>()<typeof argv.out>(true);
				expectType<string | undefined>()<typeof argv.mode>(true);
			},
		});
		expect(
			await argvOf({ options: { '--out <file>': { default: 'x', required: false } } }, [])
		).toEqual({ out: 'x' });
		expect(await argvOf({ options: { '--mode [m]': { default: undefined } } }, [])).toEqual({});
	});

	it('should read an argument default as filling its key', async () => {
		command({
			args: [{ default: 'dist.js', name: '[out]' }],
			run: ({ argv }) => expectType<string>()<typeof argv.out>(true),
		});
		expect(await argvOf({ args: [{ default: 'dist.js', name: '[out]' }] }, [])).toEqual({
			out: 'dist.js',
		});
	});

	// two sources can land on one destination, and intersecting them would make a
	// key nothing can be assigned to
	it('should merge a destination an option and an argument share', async () => {
		command({
			options: { '--foo': null },
			args: ['[foo]'],
			run: ({ argv }) => expectType<boolean | string>()<typeof argv.foo>(true),
		});
		expect(await argvOf({ args: ['[foo]'], options: { '--foo': null } }, [])).toEqual({
			foo: false,
		});
		expect(await argvOf({ args: ['[foo]'], options: { '--foo': null } }, ['bar'])).toEqual({
			foo: 'bar',
		});
	});

	// `processArgs()` takes the counting path before it looks at `multiple`
	it('should read a counter as a number however it was declared', async () => {
		command({
			options: { '-v': { multiple: true, type: 'count' } },
			run: ({ argv }) => expectType<number>()<typeof argv.v>(true),
		});
		expect(await argvOf({ options: { '-v': { type: 'count' } } }, ['-v', '-v'])).toEqual({ v: 2 });
	});

	it('should read an argument data type', async () => {
		command({
			args: [
				{ name: '[n]', type: 'int' },
				{ name: '[ns...]', type: 'int' },
			],
			run: ({ argv }) => {
				expectType<number | undefined>()<typeof argv.n>(true);
				expectType<number[] | undefined>()<typeof argv.ns>(true);
			},
		});
		expect(await argvOf({ args: [{ name: '[n]', type: 'int' }] }, ['7'])).toEqual({ n: 7 });
	});
});

describe('the values match the types', () => {
	// the inference is a second implementation of `initOption()`, so the thing
	// worth testing is that the two agree
	it('should produce the argv the types describe', async () => {
		const state = await parse({
			argv: ['build', '--log-level', 'warn', '--tag', 'a', '--tag', 'b', 'src/index.ts'],
			schema: {
				help: false,
				name: 'mycli',
				options: global,
				commands: {
					build: command({
						args: ['<entry>', '[extras]...'],
						options: {
							'--log-level <l>': { choices: ['trace', 'info', 'warn'] },
							'--tag [t]': { multiple: true },
							'--no-color': null,
						},
					}),
				},
			},
		});

		expect(state.argv).toEqual({
			color: true,
			entry: 'src/index.ts',
			logLevel: 'warn',
			port: 8080,
			tag: ['a', 'b'],
			verbose: false,
		});
	});
});
