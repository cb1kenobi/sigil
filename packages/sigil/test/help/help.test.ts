import { ansi } from '../../src/ansi/index.js';
import { stateFromError } from '../../src/error-hooks.js';
import { renderHelp } from '../../src/help/index.js';
import { parse } from '../../src/parser/parse.js';
import type { Schema } from '../../src/types.js';
import { stringWidth } from '../../src/width/index.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const ESC = String.fromCharCode(0x1b);

/**
 * Renders help for whatever context the argv lands in, at a fixed width.
 *
 * `help: false` so that these stay about the renderer: the `--help` flag and the
 * `help` command the parser adds are M2-28's, and asserting them in every
 * expectation here would say nothing about the layout.
 *
 * A parse that throws still gets help rendered, off the state the error carries.
 * That is the whole reason `parse()` stashes it: the errors that most need a
 * usage line -- a missing required option, an unexpected argument -- are the ones
 * that stop it from returning. Wiring `--help` so that it wins over those errors
 * in the first place is M2-28.
 */
async function help(schema: Schema, argv: string[] = [], width = 72) {
	let state;
	try {
		state = await parse({ argv, schema: { help: false, ...schema } });
	} catch (err) {
		state = stateFromError(err);
	}
	return renderHelp(state!, { width });
}

/** The section under a heading, without the heading. */
function sectionOf(text: string, title: string): string[] {
	const lines = text.split('\n');
	const start = lines.indexOf(`${title}:`);
	if (start === -1) {
		return [];
	}
	const rest = lines.slice(start + 1);
	const end = rest.indexOf('');
	return (end === -1 ? rest : rest.slice(0, end)).map((line) => line.trimEnd());
}

// every assertion here is about the text, so the styling is turned off rather
// than written into each expectation
beforeEach(() => {
	ansi.level = 0;
});

afterEach(() => {
	ansi.level = undefined;
});

describe('the usage line', () => {
	it('should name the program from the schema', async () => {
		const text = await help({ name: 'mycli' });
		expect(text.split('\n')[0]).toBe('Usage: mycli');
	});

	it('should be overridable', async () => {
		const text = await help({ name: 'mycli' });
		const state = await parse({ argv: [], schema: { help: false, name: 'mycli' } });
		expect(renderHelp(state, { name: 'other' }).split('\n')[0]).toBe('Usage: other');
		expect(text).toBeTruthy();
	});

	it('should say what there is to type', async () => {
		const schema: Schema = {
			name: 'mycli',
			options: { '-v, --verbose': 'Be loud' },
			commands: { build: {} },
		};
		expect((await help(schema)).split('\n')[0]).toBe('Usage: mycli [options] <command>');
	});

	// leaving the command out runs the default one rather than being an error, so
	// naming one is optional
	it('should make the command optional when one of them is the default', async () => {
		const schema: Schema = {
			help: false,
			name: 'mycli',
			commands: { build: {}, serve: { default: true, run: () => {} } },
		};
		const state = await parse({ argv: ['build'], schema });
		// `build` has no subcommands of its own, so ask the root about its own
		expect(renderHelp({ contexts: [state.contexts[1]!], schema }).split('\n')[0]).toBe(
			'Usage: mycli [command]'
		);
	});

	it('should show the whole command path, outermost first', async () => {
		const schema: Schema = {
			name: 'mycli',
			commands: { build: { commands: { targets: { commands: { list: {} } } } } },
		};
		const text = await help(schema, ['build', 'targets']);
		expect(text.split('\n')[0]).toBe('Usage: mycli build targets <command>');
	});

	it('should show the arguments the way they are typed', async () => {
		const schema: Schema = {
			name: 'mycli',
			commands: {
				build: { args: ['<entry>', '[outfile]', '[files...]'] },
			},
		};
		expect((await help(schema, ['build'])).split('\n')[0]).toBe(
			'Usage: mycli build <entry> [outfile] [files...]'
		);
	});

	it('should say nothing about options or commands when there are none', async () => {
		expect((await help({ name: 'mycli' })).split('\n')[0]).toBe('Usage: mycli');
	});
});

describe('the description', () => {
	it('should follow the usage line, wrapped', async () => {
		const schema: Schema = {
			name: 'mycli',
			commands: {
				build: {
					desc: 'Compile the project into something that can be shipped somewhere else entirely.',
				},
			},
		};
		const text = await help(schema, ['build'], 40);
		expect(text.split('\n').slice(0, 4)).toEqual([
			'Usage: mycli build',
			'',
			'Compile the project into something that',
			'can be shipped somewhere else entirely.',
		]);
	});
});

describe('the commands section', () => {
	it('should list the commands of the context it is in', async () => {
		const schema: Schema = {
			name: 'mycli',
			commands: {
				build: { desc: 'Compile the project', commands: { targets: { desc: 'Show targets' } } },
				serve: { desc: 'Run the dev server' },
			},
		};

		expect(sectionOf(await help(schema), 'Commands')).toEqual([
			'  build  Compile the project',
			'  serve  Run the dev server',
		]);

		// and in `build`, its own
		expect(sectionOf(await help(schema, ['build']), 'Commands')).toEqual([
			'  targets  Show targets',
		]);
	});

	it('should put aliases on the same row as the command', async () => {
		const schema: Schema = {
			name: 'mycli',
			commands: { build: { alias: ['b', 'compile'], desc: 'Compile the project' } },
		};
		expect(sectionOf(await help(schema), 'Commands')).toEqual([
			'  build, b, compile  Compile the project',
		]);
	});

	// `'@b'` is both the name and an alias of itself, and saying it twice says
	// nothing twice
	it('should not repeat a name that is its own alias', async () => {
		const schema: Schema = { name: 'mycli', commands: { '@b': { desc: 'Build' } } };
		expect(sectionOf(await help(schema), 'Commands')).toEqual(['  b  Build']);
	});

	it('should leave out a hidden command', async () => {
		const schema: Schema = {
			name: 'mycli',
			commands: {
				build: { desc: 'Compile the project' },
				ghost: { desc: 'Not shown', hidden: true },
				'!secret': { desc: 'Also not shown' },
			},
		};
		const section = sectionOf(await help(schema), 'Commands');
		expect(section).toEqual(['  build  Compile the project']);
	});
});

describe('the arguments section', () => {
	it('should describe each argument', async () => {
		const schema: Schema = {
			name: 'mycli',
			commands: {
				build: {
					args: [
						{ name: '<entry>', desc: 'The file to start from' },
						{ name: '[outfile]', desc: 'Where to write it', default: 'out.js' },
						{ name: '[extras...]', desc: 'Anything else' },
					],
				},
			},
		};
		expect(sectionOf(await help(schema, ['build']), 'Arguments')).toEqual([
			'  <entry>      The file to start from',
			'  [outfile]    Where to write it (default: out.js)',
			'  [extras...]  Anything else',
		]);
	});

	it('should show the accepted values', async () => {
		const schema: Schema = {
			name: 'mycli',
			commands: {
				build: { args: [{ name: '[mode]', choices: ['dev', 'prod'], desc: 'Which mode' }] },
			},
		};
		expect(sectionOf(await help(schema, ['build']), 'Arguments')).toEqual([
			'  [mode]  Which mode (choices: dev, prod)',
		]);
	});
});

describe('the options sections', () => {
	const schema: Schema = {
		name: 'mycli',
		options: {
			'-v, --verbose': 'Print more about what is happening',
			'--no-color': 'Turn color off',
		},
		commands: {
			build: {
				options: {
					'-w, --watch': 'Rebuild when a file changes',
					'--target [name]': {
						choices: ['node', 'browser'],
						default: 'node',
						desc: 'What to build for',
					},
					'--secret': { desc: 'Nobody sees this', hidden: true },
				},
			},
		},
	};

	it('should list the command own options under Options', async () => {
		expect(sectionOf(await help(schema, ['build']), 'Options')).toEqual([
			'  -w, --watch      Rebuild when a file changes',
			'  --target [name]  What to build for (choices: node, browser) (default:',
			'                   node)',
		]);
	});

	// the point of walking the chain rather than the schema: the options a
	// subcommand inherits are the ones that still work where it is
	it('should list the inherited options under Global options', async () => {
		expect(sectionOf(await help(schema, ['build']), 'Global options')).toEqual([
			'  -v, --verbose  Print more about what is happening',
			'  --no-color     Turn color off',
		]);
	});

	it('should leave out a hidden option', async () => {
		expect(await help(schema, ['build'])).not.toContain('--secret');
	});

	it('should leave out a hidden negated twin', async () => {
		const text = await help({
			name: 'mycli',
			options: { '--cheese [type]': 'Add cheese', '--no-cheese': { hidden: true } },
		});
		expect(sectionOf(text, 'Options')).toEqual(['  --cheese [type]  Add cheese']);
	});

	// the parser resolves options across the chain innermost first, so the outer
	// one cannot be reached from here and listing it would describe nothing
	it('should not list an inherited option the command redeclares', async () => {
		const shadowing: Schema = {
			name: 'mycli',
			options: { '--mode [name]': 'Root mode' },
			commands: { build: { options: { '--mode [name]': 'Build mode' } } },
		};
		const text = await help(shadowing, ['build']);
		expect(sectionOf(text, 'Options')).toEqual(['  --mode [name]  Build mode']);
		expect(sectionOf(text, 'Global options')).toEqual([]);
	});

	// every flag has a default, so printing them is noise rather than information
	it('should not print a default the parser supplied', async () => {
		const text = await help({ name: 'mycli', options: { '--watch': 'Watch' } });
		expect(text).toContain('--watch');
		expect(text).not.toContain('default: false');
	});

	// printing it as it is would show nothing at all, or would not show where it
	// begins and ends
	it('should quote a default that would otherwise be invisible', async () => {
		const text = await help({
			name: 'mycli',
			options: {
				'--empty [v]': { default: '', desc: 'Empty' },
				'--padded [v]': { default: ' x ', desc: 'Padded' },
				'--plain [v]': { default: 'x', desc: 'Plain' },
				'--zero [v]': { default: 0, desc: 'Zero', type: 'int' },
			},
		});
		expect(sectionOf(text, 'Options')).toEqual([
			'  --empty [v]   Empty (default: "")',
			'  --padded [v]  Padded (default: " x ")',
			'  --plain [v]   Plain (default: x)',
			'  --zero [v]    Zero (default: 0)',
		]);
	});

	// a spelling is what gets typed, so a short-only option does not shadow a
	// long one: `mycli build --mode` still reaches the root's
	it('should still list an inherited option whose spelling is not taken', async () => {
		const schema: Schema = {
			name: 'mycli',
			options: { '--mode [name]': 'Root mode' },
			commands: { build: { options: { '-m [name]': 'Build m' } } },
		};
		const text = await help(schema, ['build']);
		expect(sectionOf(text, 'Options')).toEqual(['  -m [name]  Build m']);
		expect(sectionOf(text, 'Global options')).toEqual(['  --mode [name]  Root mode']);
	});

	it('should print a default the schema declared', async () => {
		const text = await help({
			name: 'mycli',
			options: { '--watch': { default: true, desc: 'Watch' } },
		});
		expect(sectionOf(text, 'Options')).toEqual(['  --watch  Watch (default: true)']);
	});

	// a negated flag also answers to the positive spelling, but printing both
	// reads as two options that mean opposite things
	it('should print only the spelling that does what the description says', async () => {
		const text = await help({ name: 'mycli', options: { '--no-color': 'Turn color off' } });
		expect(sectionOf(text, 'Options')).toEqual(['  --no-color  Turn color off']);
	});

	// they share a destination, so one of them is the other one's off switch
	it('should put a negated twin on the same row as the option it pairs with', async () => {
		const text = await help({
			name: 'mycli',
			options: { '--cheese [type]': 'Add cheese', '--no-cheese': undefined },
		});
		expect(sectionOf(text, 'Options')).toEqual(['  --cheese [type], --no-cheese  Add cheese']);
	});

	it('should show a required value in angle brackets and an optional one in square', async () => {
		const text = await help({
			name: 'mycli',
			options: { '--out <file>': 'Where to write', '--in [file]': 'Where to read' },
		});
		expect(sectionOf(text, 'Options')).toEqual([
			'  --out <file>  Where to write',
			'  --in [file]   Where to read',
		]);
	});
});

describe('aliases', () => {
	it('should name the aliases of the command being described', async () => {
		const schema: Schema = {
			name: 'mycli',
			commands: { build: { alias: 'b', desc: 'Compile' } },
		};
		expect(await help(schema, ['build'])).toContain('Alias: b');

		const many: Schema = {
			name: 'mycli',
			commands: { build: { alias: ['b', 'c'], desc: 'Compile' } },
		};
		expect(await help(many, ['build'])).toContain('Aliases: b, c');
	});

	it('should say nothing about the program own aliases', async () => {
		expect(await help({ name: 'mycli' })).not.toContain('Alias');
	});

	// the command is already named on the usage line, and `'@b'` is its own alias
	it('should not name the command as its own alias', async () => {
		const schema: Schema = { name: 'mycli', commands: { '@b': { desc: 'Build' } } };
		expect(await help(schema, ['b'])).not.toContain('Alias');
	});

	it('should wrap a long list of aliases under the label', async () => {
		const schema: Schema = {
			name: 'mycli',
			commands: {
				build: { alias: ['compile-everything', 'make-the-thing', 'bundle-it-all'], desc: 'Build' },
			},
		};
		expect(sectionOf(await help(schema, ['build'], 40), 'Aliases')).toEqual([]);
		const lines = (await help(schema, ['build'], 40)).split('\n');
		const start = lines.findIndex((line) => line.startsWith('Aliases:'));
		expect(lines.slice(start, start + 2)).toEqual([
			'Aliases: compile-everything,',
			'         make-the-thing, bundle-it-all',
		]);
	});
});

describe('examples', () => {
	it('should show the label and the command under it', async () => {
		const schema: Schema = {
			name: 'mycli',
			commands: {
				build: {
					examples: [
						{ label: 'Build once', text: 'mycli build src/index.ts' },
						{ label: 'Rebuild on change', text: 'mycli build src/index.ts --watch' },
					],
				},
			},
		};
		const text = await help(schema, ['build']);
		expect(text.split('\n').slice(-6)).toEqual([
			'Examples:',
			'  Build once',
			'    mycli build src/index.ts',
			'',
			'  Rebuild on change',
			'    mycli build src/index.ts --watch',
		]);
	});

	it('should take a single example as well as a list', async () => {
		const schema: Schema = {
			name: 'mycli',
			commands: { build: { examples: { label: 'Build', text: 'mycli build' } } },
		};
		expect(await help(schema, ['build'])).toContain('    mycli build');
	});

	it('should show a command with no label at the list indent', async () => {
		const schema: Schema = {
			name: 'mycli',
			commands: { build: { examples: { label: '', text: 'mycli build' } } },
		};
		expect((await help(schema, ['build'])).split('\n').slice(-2)).toEqual([
			'Examples:',
			'  mycli build',
		]);
	});
});

describe('layout', () => {
	it('should wrap a description into the column it starts in', async () => {
		const schema: Schema = {
			name: 'mycli',
			options: {
				'-v, --verbose':
					'Print a great deal more about what is happening than anybody needs to know',
			},
		};
		expect(sectionOf(await help(schema, [], 48), 'Options')).toEqual([
			'  -v, --verbose  Print a great deal more about',
			'                 what is happening than anybody',
			'                 needs to know',
		]);
	});

	// one long flag should not squeeze every description into a gutter
	it('should give a label too wide for its column a line of its own', async () => {
		const schema: Schema = {
			name: 'mycli',
			options: {
				'-a, --a': 'Short one',
				'--an-extremely-long-option-name [value]': 'The long one',
			},
		};
		expect(sectionOf(await help(schema, [], 60), 'Options')).toEqual([
			'  -a, --a  Short one',
			'  --an-extremely-long-option-name [value]',
			'           The long one',
		]);
	});

	// wrapping to a handful of columns is a word per line, and running past the
	// terminal's edge is worse still: the terminal wraps it at the margin and the
	// indent is lost
	it('should give up on two columns when there is no room for a description', async () => {
		const schema: Schema = {
			name: 'mycli',
			options: { '-v, --verbose': 'Print more about what is happening' },
		};
		expect(sectionOf(await help(schema, [], 28), 'Options')).toEqual([
			'  -v, --verbose',
			'    Print more about what is',
			'    happening',
		]);
	});

	it('should keep every line within the width', async () => {
		const schema: Schema = {
			name: 'mycli',
			options: {
				'-v, --verbose': 'Print more about what is happening, at length',
				'--target [name]': { choices: ['node', 'browser'], desc: 'What to build for' },
			},
			commands: {
				build: {
					alias: ['compile-everything', 'bundle-it-all'],
					desc: 'Compile the project into something shippable',
				},
				serve: { desc: 'Run a development server on a port nobody is using' },
			},
		};
		for (const width of [24, 30, 40, 60, 80, 100]) {
			// the root screen and a subcommand's, since the sections differ
			const screens = [await help(schema, [], width), await help(schema, ['build'], width)];
			for (const line of screens.join('\n').split('\n')) {
				// measured in columns, not code units, which is the only measurement
				// that means anything once a description is styled
				expect(stringWidth(line), `width ${width}: ${JSON.stringify(line)}`).toBeLessThanOrEqual(
					width
				);
			}
		}
	});

	// a list of names breaks between them; a name and its hint does not
	it('should break a label that does not fit after its commas', async () => {
		const schema: Schema = {
			name: 'mycli',
			commands: {
				build: { alias: ['compile-everything', 'bundle-it-all'], desc: 'Build' },
				serve: { desc: 'Serve' },
			},
		};
		// `serve` still fits its column, so the list stays in two columns and the
		// description of the label that did not fit starts under that column
		expect(sectionOf(await help(schema, [], 30), 'Commands')).toEqual([
			'  build, compile-everything,',
			'  bundle-it-all',
			'         Build',
			'  serve  Serve',
		]);
	});

	// a flag name broken across two lines is a flag nobody can type, which is
	// worse than one line the terminal wraps for us
	it('should print a label wider than the width whole', async () => {
		const schema: Schema = {
			name: 'mycli',
			options: { '--an-extremely-long-option-name [value]': 'The long one' },
		};
		expect(sectionOf(await help(schema, [], 28), 'Options')).toEqual([
			'  --an-extremely-long-option-name [value]',
			'    The long one',
		]);
	});
});

describe('styling', () => {
	it('should bold the headings and dim the parentheticals', async () => {
		ansi.level = 3;
		const schema: Schema = {
			name: 'mycli',
			options: { '--target [name]': { default: 'node', desc: 'What to build for' } },
		};
		const text = await help(schema, [], 72);
		expect(text).toContain(`${ESC}[1mUsage:${ESC}[22m`);
		expect(text).toContain(`${ESC}[1mOptions:${ESC}[22m`);
		expect(text).toContain(`${ESC}[2m(default: node)${ESC}[22m`);
	});

	// the column a description starts in is measured, so the sequences in a
	// styled label must not push it over
	it('should line the columns up even when the labels are styled', async () => {
		ansi.level = 3;
		const schema: Schema = {
			name: 'mycli',
			options: { '-v, --verbose': 'Loud', '--quiet': 'Silent' },
		};
		const text = await help(schema, [], 72);
		const columns = sectionOf(text, `${ESC}[1mOptions${ESC}[22m`)
			.map((line) => ansi.strip(line).indexOf('Loud') + ansi.strip(line).indexOf('Silent'))
			.filter((index) => index > 0);
		expect(new Set(columns).size).toBeLessThanOrEqual(1);
	});
});

describe('empty and odd declarations', () => {
	it('should ignore a description of nothing but whitespace', async () => {
		const schema: Schema = { name: 'mycli', commands: { build: { desc: '   ' } } };
		expect(await help(schema, ['build'])).toBe('Usage: mycli build');
	});

	// nothing in help is worth failing the whole screen over
	it('should render a default that cannot be written as JSON', async () => {
		const circular: Record<string, unknown> = {};
		circular.self = circular;
		const text = await help({
			name: 'mycli',
			options: {
				'--circular [v]': { default: circular, desc: 'Circular' },
				'--big [v]': { default: 10n, desc: 'BigInt' },
			},
		});
		expect(sectionOf(text, 'Options')).toEqual([
			'  --circular [v]  Circular (default: [object Object])',
			'  --big [v]       BigInt (default: 10)',
		]);
	});

	it('should ignore an empty choices list', async () => {
		const text = await help({
			name: 'mycli',
			options: { '--mode [name]': { choices: [], desc: 'Which mode' } },
		});
		expect(sectionOf(text, 'Options')).toEqual(['  --mode [name]  Which mode']);
	});

	it('should render an option with no description', async () => {
		const text = await help({ name: 'mycli', options: { '-x, --extra': undefined } });
		expect(sectionOf(text, 'Options')).toEqual(['  -x, --extra']);
	});

	it('should render a command with no description', async () => {
		const text = await help({ name: 'mycli', commands: { build: {} } });
		expect(sectionOf(text, 'Commands')).toEqual(['  build']);
	});
});

describe('bad input', () => {
	it('should refuse a target with no context chain', () => {
		expect(() => renderHelp({ contexts: [] })).toThrow(
			'Expected a context chain to render help for'
		);
		expect(() => renderHelp(undefined as never)).toThrow(/Expected a context chain/);
	});
});
