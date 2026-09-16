import { ansi } from '../../src/ansi/index.js';
import { resolveHelp } from '../../src/help/index.js';
import main2 from '../../src/index.js';
import { parse } from '../../src/parser/parse.js';
import { Internal, type Schema } from '../../src/types.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/** What `main2()` wrote to stdout, and the exit code it left behind. */
async function run(schema: Schema, argv: string[], settings?: Record<string, unknown>) {
	const written: string[] = [];
	const write = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
		written.push(String(chunk));
		return true;
	});
	const before = process.exitCode;

	try {
		await main2({ argv, schema, settings: settings as never });
		return { code: process.exitCode, out: written.join('') };
	} finally {
		write.mockRestore();
		process.exitCode = before;
	}
}

beforeEach(() => {
	ansi.level = 0;
});

afterEach(() => {
	ansi.level = undefined;
});

describe('the --help flag', () => {
	it('should be added to a schema that did not declare one', async () => {
		const state = await parse({ argv: [], schema: { name: 'mycli' } });
		const { options } = state.contexts[0][Internal];
		expect(options.find('--help')).toBeTruthy();
		expect(options.find('-h')).toBeTruthy();
	});

	it('should not put its value on argv', async () => {
		// a flag always has a value, and this one is the parser's business
		expect((await parse({ argv: [], schema: {} })).argv).toEqual({});
		expect((await parse({ argv: ['--help'], schema: {} })).argv).toEqual({});
	});

	it('should print help instead of running the command', async () => {
		const run1 = vi.fn();
		const schema: Schema = { name: 'mycli', commands: { build: { desc: 'Build', run: run1 } } };
		const { code, out } = await run(schema, ['build', '--help']);
		expect(run1).not.toHaveBeenCalled();
		expect(out).toContain('Usage: mycli build');
		expect(code).toBe(0);
	});

	it('should answer for the command it was typed after', async () => {
		const schema: Schema = {
			name: 'mycli',
			commands: { build: { desc: 'Build', commands: { targets: { desc: 'Targets' } } } },
		};
		expect((await run(schema, ['--help'])).out).toContain('Usage: mycli [options] <command>');
		expect((await run(schema, ['build', '--help'])).out).toContain('Usage: mycli build');
		expect((await run(schema, ['build', 'targets', '--help'])).out).toContain(
			'Usage: mycli build targets'
		);
	});

	// answering with the default command's screen hides every other command
	it('should answer for the program when argv named no command', async () => {
		const schema: Schema = {
			name: 'mycli',
			commands: {
				build: { desc: 'Build', run: () => {} },
				serve: { default: true, desc: 'Serve', run: () => {} },
			},
		};
		const { out } = await run(schema, ['--help']);
		expect(out).toContain('Usage: mycli [options] [command]');
		expect(out).toContain('build');
		expect(out).toContain('serve');
		// and still for the command when argv did name it
		expect((await run(schema, ['serve', '--help'])).out).toContain('Usage: mycli serve');
	});

	it('should keep the short form for an app that wants it', async () => {
		const schema: Schema = { name: 'mycli', options: { '-h, --host [name]': 'The host' } };
		const state = await parse({ argv: [], schema });
		const { options } = state.contexts[0][Internal];
		expect(options.find('-h')?.name).toBe('host');
		// the long form is still free, so help still has one
		expect(options.find('--help')).toBeTruthy();
		expect(options.find('--help')?.[Internal].short.size).toBe(0);
	});

	// the only reading of a declaration that means anything
	it('should leave an app that declares --help entirely alone', async () => {
		const run1 = vi.fn();
		const schema: Schema = {
			name: 'mycli',
			options: { '--help': 'Whatever this app means by it' },
			commands: { build: { run: run1, desc: 'Build' } },
		};
		const { out } = await run(schema, ['build', '--help']);
		expect(out).toBe('');
		expect(run1).toHaveBeenCalled();
		// and it is the app's value, so it does reach argv
		const state = await parse({ argv: ['--help'], schema });
		expect(state.argv.help).toBe(true);
	});

	// typed and true: `--help=false` is somebody typing it and saying no
	it('should not answer a flag that was turned off', async () => {
		const run1 = vi.fn();
		const schema: Schema = { name: 'mycli', commands: { build: { desc: 'Build', run: run1 } } };
		expect((await run(schema, ['build', '--help=false'])).out).toBe('');
		expect(run1).toHaveBeenCalled();
		expect((await run(schema, ['build', '--help=true'])).out).toContain('Usage: mycli build');
	});

	// a declaration of any spelling that resolves to `--help` is a declaration:
	// a negated flag answers to the positive spelling too
	it('should treat a declared --no-help as the app own', async () => {
		const schema: Schema = { name: 'mycli', options: { '--no-help': 'The app own' } };
		const state = await parse({ argv: ['--help'], schema });
		expect(state.help).toBeUndefined();
		expect(state.argv.help).toBe(true);
	});

	// the registry stores an option under its name, so one spelled `-x` and named
	// `help` holds the key an added `--help` would take
	it('should not replace an option that took the name help', async () => {
		const schema: Schema = {
			name: 'mycli',
			options: { '-x': { desc: 'The app own', name: 'help' } },
		};
		const state = await parse({ argv: ['-x'], schema });
		expect(state.help).toBeUndefined();
		expect(state.argv.help).toBe(true);
		const { options } = state.contexts[0][Internal];
		expect(options.get('help')?.desc).toBe('The app own');
		expect(options.size).toBe(1);
	});

	// options resolve across the chain innermost first, so the nearer one wins
	// where it applies and the root's applies everywhere else
	it('should let a subcommand -h shadow it only where the subcommand is', async () => {
		const run1 = vi.fn();
		const schema: Schema = {
			name: 'mycli',
			commands: {
				build: { desc: 'Build', options: { '-h, --host [name]': 'The host' }, run: run1 },
			},
		};
		expect((await run(schema, ['build', '-h', 'example.com'])).out).toBe('');
		expect(run1).toHaveBeenCalled();
		expect((await run(schema, ['build', '--help'])).out).toContain('Usage: mycli build');
		// before the subcommand there is no subcommand to shadow it
		expect((await run(schema, ['-h', 'build'])).out).toContain('Usage: mycli build');
	});

	it('should add nothing when help is turned off', async () => {
		const state = await parse({ argv: [], schema: { help: false, name: 'mycli' } });
		const { commands, options } = state.contexts[0][Internal];
		expect(options.find('--help')).toBeUndefined();
		expect(commands.find('help')).toBeUndefined();
		expect((await run({ help: false, name: 'mycli' }, ['--help'])).out).toBe('');
	});
});

// `mycli build --help` is asking what `build` needs, and answering "you did not
// say" is not an answer
describe('short-circuiting', () => {
	const schema: Schema = {
		name: 'mycli',
		options: { '--config <file>': 'Required config' },
		commands: {
			build: { args: ['<entry>'], desc: 'Build', options: { '--out <dir>': 'Required out' } },
		},
	};

	it('should win over a missing required option', async () => {
		const { code, out } = await run(schema, ['build', '--help']);
		expect(out).toContain('Usage: mycli build');
		expect(out).not.toContain('Missing required');
		expect(code).toBe(0);
	});

	it('should win over a missing required argument', async () => {
		const state = await parse({ argv: ['build', '--help'], schema });
		expect(state.help?.via).toBe('option');
		expect(state.help?.contexts[0]?.name).toBe('build');
	});

	it('should still throw when help was not asked for', async () => {
		await expect(parse({ argv: ['build'], schema })).rejects.toThrow(/Missing required/);
	});

	// everything that throws while argv is being read throws: only the validation
	// that runs after the walk defers to help
	it('should not rescue a missing option value', async () => {
		const required: Schema = { name: 'mycli', options: { '--name <value>': 'A name' } };
		await expect(parse({ argv: ['--name', '--help'], schema: required })).rejects.toThrow(
			/Missing value for option/
		);
	});

	it('should not answer a --help that argv put past the terminator', async () => {
		await expect(parse({ argv: ['build', '--', '--help'], schema })).rejects.toThrow(
			/Extra arguments are not allowed/
		);
	});

	// an invalid value is not a missing one: the parse died on the way in, before
	// there was anything to answer about
	it('should not rescue a value that will not coerce', async () => {
		const typed: Schema = { name: 'mycli', options: { '--count [n]': { type: 'int' } } };
		await expect(parse({ argv: ['--count', 'abc', '--help'], schema: typed })).rejects.toThrow(
			/Invalid integer/
		);
	});
});

describe('the help command', () => {
	const schema: Schema = {
		name: 'mycli',
		commands: {
			build: {
				desc: 'Build',
				args: ['<entry>'],
				commands: { targets: { desc: 'Targets' } },
			},
		},
	};

	it('should describe the program when given nothing', async () => {
		const { code, out } = await run(schema, ['help']);
		expect(out).toContain('Usage: mycli [options] <command>');
		expect(out).toContain('build');
		expect(code).toBe(0);
	});

	it('should describe the command it was given', async () => {
		expect((await run(schema, ['help', 'build'])).out).toContain('Usage: mycli build');
	});

	// the chain above it has to be the same chain, or the inherited options would
	// be the wrong ones
	it('should describe a command several levels down', async () => {
		const { out } = await run(schema, ['help', 'build', 'targets']);
		expect(out).toContain('Usage: mycli build targets');
	});

	it('should find a command by an alias', async () => {
		const aliased: Schema = { name: 'mycli', commands: { build: { alias: 'b', desc: 'Build' } } };
		expect((await run(aliased, ['help', 'b'])).out).toContain('Usage: mycli build');
	});

	it('should report a command it cannot find', async () => {
		await expect(parse({ argv: ['help', 'nope'], schema })).rejects.toThrow(
			'Unknown command "nope"'
		);
	});

	// the path after itself, not every positional there is
	it('should read the path after itself', async () => {
		const { out } = await run({ ...schema, settings: undefined } as Schema, [
			'help',
			'build',
			'targets',
		]);
		expect(out).toContain('Usage: mycli build targets');
	});

	// the command form is the more specific of the two: somebody who typed
	// `help build` named the command they meant
	it('should win over the flag when both are present', async () => {
		expect((await run(schema, ['help', 'build', '--help'])).out).toContain('Usage: mycli build');
	});

	// `commands.find()` answers to aliases, and an alias is a declaration
	it('should leave an app that aliases something else to help alone', async () => {
		const run1 = vi.fn();
		const aliased: Schema = {
			name: 'mycli',
			commands: { deploy: { alias: 'help', desc: 'Deploy', run: run1 } },
		};
		expect((await run(aliased, ['help'])).out).toBe('');
		expect(run1).toHaveBeenCalled();
	});

	it('should leave an app that declares its own help command alone', async () => {
		const run1 = vi.fn();
		const own: Schema = {
			name: 'mycli',
			commands: { help: { desc: 'The app own help', run: run1 } },
		};
		const { out } = await run(own, ['help']);
		expect(out).toBe('');
		expect(run1).toHaveBeenCalled();
	});
});

describe('helpExitCode', () => {
	const schema: Schema = { name: 'mycli' };

	it('should be zero by default', async () => {
		// being asked what a command does and answering is not a failure
		expect((await run(schema, ['--help'])).code).toBe(0);
	});

	it('should honor what the app asked for', async () => {
		expect((await run(schema, ['--help'], { helpExitCode: 2 })).code).toBe(2);
		expect((await run(schema, ['help'], { helpExitCode: 64 })).code).toBe(64);
	});

	// assigning one would turn printing help into a crash
	it('should ignore a value that is not an exit code', async () => {
		for (const helpExitCode of [-1, 256, 1.5, Number.NaN, 'two', null]) {
			expect((await run(schema, ['--help'], { helpExitCode })).code, `${helpExitCode}`).toBe(0);
		}
	});
});

describe('Command.help', () => {
	it('should print a string instead of the generated screen', async () => {
		const schema: Schema = {
			name: 'mycli',
			commands: { notes: { desc: 'Notes', help: 'Read the manual.' } },
		};
		expect((await run(schema, ['notes', '--help'])).out).toBe('Read the manual.\n');
	});

	it('should let a function add to the generated screen', async () => {
		const schema: Schema = {
			name: 'mycli',
			commands: {
				notes: {
					desc: 'Notes',
					help: ({ generated }) => `${generated}\n\nSee the manual.`,
				},
			},
		};
		const { out } = await run(schema, ['notes', '--help']);
		expect(out).toContain('Usage: mycli notes');
		expect(out.trimEnd().endsWith('See the manual.')).toBe(true);
	});

	it('should hand the function the command and the state', async () => {
		const seen: string[] = [];
		const schema: Schema = {
			name: 'mycli',
			commands: {
				notes: {
					desc: 'Notes',
					help: ({ cmd, state }) => {
						seen.push(cmd.name, String(state.help?.via));
						return 'x';
					},
				},
			},
		};
		await run(schema, ['notes', '--help']);
		expect(seen).toEqual(['notes', 'option']);
	});

	it('should wait for a function that returns a promise', async () => {
		const schema: Schema = {
			name: 'mycli',
			commands: { notes: { desc: 'Notes', help: async () => 'later' } },
		};
		expect((await run(schema, ['notes', '--help'])).out).toBe('later\n');
	});

	// which is how a function that only wants to look declines to replace it
	// it leaves through `main2()`'s one error path like anything else
	it('should let a function that throws become the error', async () => {
		const schema: Schema = {
			name: 'mycli',
			commands: {
				notes: {
					desc: 'Notes',
					help: () => {
						throw new Error('help is broken');
					},
				},
			},
		};
		const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
		try {
			const { out } = await run(schema, ['notes', '--help']);
			expect(out).toBe('');
			expect(String(stderr.mock.calls[0]?.[0])).toContain('help is broken');
		} finally {
			stderr.mockRestore();
		}
	});

	it('should keep the generated screen when the function returns nothing', async () => {
		const schema: Schema = {
			name: 'mycli',
			commands: { notes: { desc: 'Notes', help: () => undefined } },
		};
		expect((await run(schema, ['notes', '--help'])).out).toContain('Usage: mycli notes');
	});

	// `beforeError` walks the chain argv walked, and `help notes` never walked into
	// `notes` -- it asked about it. `notes --help` does, and its hook fires there.
	it('should fire the command own beforeError only when argv went through it', async () => {
		const fired: string[] = [];
		const schema: Schema = {
			name: 'mycli',
			commands: {
				notes: {
					desc: 'Notes',
					help: () => {
						throw new Error('help is broken');
					},
					hooks: { beforeError: [() => void fired.push('notes')] },
				},
			},
		};
		const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
		try {
			await run(schema, ['help', 'notes']);
			expect(fired).toEqual([]);
			await run(schema, ['notes', '--help']);
			expect(fired).toEqual(['notes']);
		} finally {
			stderr.mockRestore();
		}
	});

	it('should be used by the help command as well as the flag', async () => {
		const schema: Schema = {
			name: 'mycli',
			commands: { notes: { desc: 'Notes', help: 'Read the manual.' } },
		};
		expect((await run(schema, ['help', 'notes'])).out).toBe('Read the manual.\n');
	});
});

describe('resolveHelp()', () => {
	it('should describe the state as it stands when there is no request', async () => {
		const state = await parse({ argv: [], schema: { help: false, name: 'mycli' } });
		expect(await resolveHelp(state, { width: 40 })).toBe('Usage: mycli');
	});

	it('should take the same layout options as renderHelp', async () => {
		const state = await parse({
			argv: ['--help'],
			schema: { name: 'mycli', options: { '--long-one [v]': 'A description of it' } },
		});
		const text = await resolveHelp(state, { indent: 6, width: 60 });
		expect(text).toContain('      --long-one [v]');
	});
});
