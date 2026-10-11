import { parse } from '../../src/parser/parse.js';
import {
	commandTokens,
	distance,
	nearest,
	nearMiss,
	optionTokens,
	unexpectedArgument,
} from '../../src/parser/suggest.js';
import { Internal, type Settings } from '../../src/types.js';
import { fuzzyMatch } from '../../src/util/fuzzy.js';
import { describe, expect, it } from 'vitest';

/** A realistic command vocabulary, which is what the table ranks against. */
const CMDS = [
	'build',
	'deploy',
	'dev',
	'start',
	'test',
	'lint',
	'format',
	'clean',
	'install',
	'add',
	'remove',
	'publish',
	'login',
	'logout',
	'init',
	'run',
	'serve',
	'watch',
	'check',
	'info',
	'list',
	'new',
	'help',
	'version',
	'db',
	'migrate',
	'config',
	'upgrade',
];

/** The option spellings an ordinary app declares, as they are typed. */
const OPTS = [
	'--verbose',
	'--version',
	'--port',
	'--help',
	'--quiet',
	'--config',
	'--output',
	'--force',
	'--watch',
	'--no-color',
	'--dry-run',
	'--max-workers',
	'-v',
	'-p',
];

/** What an option spelling is compared as: the dashes come off both sides. */
const stripped = (s: string) => s.replace(/^-+/, '');

describe('distance()', () => {
	// the transposition is the whole reason this is not plain Levenshtein, where
	// each of these is two edits -- and every floor tight enough to be safe
	// refuses two
	it.each([
		['buidl', 'build'],
		['verbsoe', 'verbose'],
		['tset', 'test'],
		['hlep', 'help'],
		['lgoin', 'login'],
	])('should price a transposition of %s at one edit', (typo, want) => {
		expect(distance(typo, want)).toBe(1);
	});

	it.each([
		['', '', 0],
		['a', '', 1],
		['', 'abc', 3],
		['build', 'build', 0],
		['buld', 'build', 1],
		['builld', 'build', 1],
		['bulld', 'build', 1],
		['abc', 'xyz', 3],
	])('should answer %s against %s with %i', (a, b, want) => {
		expect(distance(a, b)).toBe(want);
	});

	it('should be symmetric', () => {
		for (const [a, b] of [
			['buidl', 'build'],
			['dpl', 'deploy'],
			['', 'x'],
			['a', 'abcdef'],
		] as const) {
			expect(distance(a, b)).toBe(distance(b, a));
		}
	});

	it('should fold case', () => {
		expect(distance('BUILD', 'build')).toBe(0);
		expect(distance('Buidl', 'build')).toBe(1);
	});

	// by code unit a surrogate pair is two edits from nothing, so an astral typo
	// is twice as far from its candidate as it should be
	it('should count an astral character as one edit rather than two', () => {
		expect(distance('\u{1F600}', '')).toBe(1);
		expect(distance('a\u{1F600}b', 'ab')).toBe(1);
		expect(distance('\u{1F600}\u{1F601}', '\u{1F601}\u{1F600}')).toBe(1);
	});
});

describe('why there are two metrics', () => {
	// the measurement the whole design rests on, written as the mechanism rather
	// than as the tally: a transposition is not a subsequence, so the subsequence
	// match answers *nothing at all* -- and it is one edit, so the distance sees
	// it. The ticket's own headline, `verbsoe`, is one of these
	it.each([
		['buidl', 'build'],
		['verbsoe', 'verbose'],
		['tset', 'test'],
		['hlep', 'help'],
		['lgoin', 'login'],
		['deplyo', 'deploy'],
	])('should leave %s invisible to a subsequence match and one edit from %s', (typo, want) => {
		expect(fuzzyMatch(typo, want)).toBeUndefined();
		expect(distance(typo, want)).toBe(1);
		expect(nearest(typo, [want])).toBe(want);
	});

	// ...and the other way, which is why the subsequence match stays. Asserted
	// against `nearMiss()` itself rather than against a distance and a literal
	// rate: the rate is measured on the **shorter** of the two, so these are
	// allowed one slip rather than the two the candidate's own length would
	// suggest -- and a test that wrote the `1` out would stay green if the rate
	// changed under it, where this one tracks whatever the near miss decides
	it.each([
		['dpl', 'deploy'],
		['bld', 'build'],
		['ver', 'version'],
	])('should leave %s to the subsequence match alone, past %s', (abbreviation, want) => {
		expect(nearMiss(abbreviation, [want], (x) => x)).toBeUndefined();
		expect(fuzzyMatch(abbreviation, want)?.matched[0]).toBe(0);
		expect(nearest(abbreviation, [want])).toBe(want);
	});
});

describe('the table of what suggests and what does not', () => {
	/**
	 * The table the ticket asked for: what was typed, and what it should offer.
	 *
	 * `undefined` is a row that must offer **nothing**, which is half the point:
	 * a wrong suggestion is worse than none, because it sends the reader
	 * somewhere. Every row is a pair somebody would really type -- the typos are
	 * transpositions, omissions, insertions and substitutions, and the negatives
	 * are the tokens that turn up in a first positional slot.
	 */
	const TABLE: [typed: string, expected: string | undefined][] = [
		// transpositions, which a subsequence match cannot see at all
		['buidl', 'build'],
		['bulid', 'build'],
		['biuld', 'build'],
		['deplyo', 'deploy'],
		['isntall', 'install'],
		['insatll', 'install'],
		['strat', 'start'],
		['tset', 'test'],
		['tets', 'test'],
		['fomrat', 'format'],
		['clena', 'clean'],
		['loign', 'login'],
		['lgoin', 'login'],
		['verison', 'version'],
		['upgarde', 'upgrade'],
		['confgi', 'config'],
		['chekc', 'check'],
		['cehck', 'check'],
		['hepl', 'help'],
		['hlep', 'help'],
		['remvoe', 'remove'],
		['reomve', 'remove'],
		// omissions and insertions
		['buld', 'build'],
		['depoy', 'deploy'],
		['deploty', 'deploy'],
		['instal', 'install'],
		['sart', 'start'],
		['publsh', 'publish'],
		['pubish', 'publish'],
		['verson', 'version'],
		['migrat', 'migrate'],
		['serv', 'serve'],
		// two slips in a long word, which the rate allows and a flat cap of one
		// does not
		['insatlll', 'install'],
		['verisno', 'version'],
		// case is folded, because a name is a name rather than prose
		['BUILD', 'build'],
		['Deploy', 'deploy'],
		// abbreviations, which the edit distance cannot see and the subsequence
		// match is for
		['dpl', 'deploy'],
		['bld', 'build'],
		['ver', 'version'],
		// ...and the one the ordering costs, which is the honest one: `inst` is
		// one slip from `init` and an abbreviation of `install`, and a near miss
		// is the stronger statement about what a finger did
		['inst', 'init'],
		// tokens that are not typos of anything here
		['foo', undefined],
		['xyz', undefined],
		['zzzzz', undefined],
		['hello', undefined],
		['1234', undefined],
		['', undefined],
		['q', undefined],
		['a', undefined],
		// the things a first positional argument really is
		['./some/path.js', undefined],
		['package.json', undefined],
		['README.md', undefined],
		['index.ts', undefined],
		['src', undefined],
		['lib', undefined],
		['bin', undefined],
		['app', undefined],
		['main', undefined],
		['out', undefined],
		['tmp', undefined],
		['prod', undefined],
		['staging', undefined],
		['v2', undefined],
		['*.ts', undefined],
	];

	it.each(TABLE)('should offer %o the command %o', (typed, expected) => {
		expect(nearest(typed, CMDS)).toBe(expected);
	});

	/**
	 * The declared limit, and it is not fixable by any metric there is.
	 *
	 * `dist` is one character from `list`, which is the strongest typo signal
	 * there is, and it is also an ordinary directory name. Nothing can tell a
	 * token that is one slip from a command name from a typo of it -- oclif and
	 * git have the same property -- so it is written down rather than guarded.
	 */
	it('should offer a command for a token one slip from one, whatever it meant', () => {
		expect(nearest('dist', CMDS)).toBe('list');
	});

	const OPTION_TABLE: [typed: string, expected: string | undefined][] = [
		// the ticket's own headline, and it is a transposition
		['--verbsoe', '--verbose'],
		['--verboes', '--verbose'],
		['--prot', '--port'],
		['--quite', '--quiet'],
		['--ouput', '--output'],
		['--confgi', '--config'],
		['--dryrun', '--dry-run'],
		['--no-colour', '--no-color'],
		['--max-wokrers', '--max-workers'],
		['--maxworkers', '--max-workers'],
		// the one case where the *dash* is the typo, which is why the stripping
		// allows an exact match on the names
		['--p', '-p'],
		// a short option is one character, so two of them have nothing in common
		// and neither is offered for the other
		['-x', undefined],
		['-z', undefined],
		// and the ordinary negatives
		['--zzz', undefined],
		['--xyzzy', undefined],
		['--', undefined],
	];

	it.each(OPTION_TABLE)('should offer %o the option %o', (typed, expected) => {
		expect(nearest(typed, OPTS, stripped)).toBe(expected);
	});

	it('should offer nothing where two candidates are equally near', () => {
		// choosing between them would choose by registration order, which for a
		// directory of command modules is whatever the file system felt like
		expect(nearest('cat', ['car', 'cab'])).toBeUndefined();
		expect(nearest('ver', ['verbose', 'version'])).toBeUndefined();
	});

	// the two guards that close this are load bearing *individually*, and a
	// candidate list with two short options in it is where that cannot be seen:
	// `-x` is one edit from `-v` and from `-p` alike, so the tie rule covers for
	// both of them. One short option is the input that separates them
	it('should not offer one short option for another, which is one character against one', () => {
		expect(nearest('-x', ['-v', '--verbose'], stripped)).toBeUndefined();
		// ...and the long spelling it shares a prefix with is still offered
		expect(nearest('--verbsoe', ['-v', '--verbose'], stripped)).toBe('--verbose');
	});

	it('should not offer one single-character token for another', () => {
		// nothing in common: two characters that simply differ, which is what a
		// distance at or past the shorter string's own length means
		expect(nearest('x', ['b'])).toBeUndefined();
		expect(nearest('x', ['b', 'd'])).toBeUndefined();
	});

	// the length pre-filter stands in for the rate and must be no tighter than
	// it: `instaalll` is two code points longer than `install` and two edits from
	// it, and the rate at that length allows two -- so a filter written `>=`
	// rather than `>` refuses a pair the floor it is standing in for accepts
	it('should offer a candidate at the exact length the rate allows', () => {
		expect(nearest('instaalll', ['install'])).toBe('install');
	});

	it('should offer nothing from an empty candidate list', () => {
		expect(nearest('buidl', [])).toBeUndefined();
	});

	it('should refuse a subsequence that is not a prefix', () => {
		// `out` is a subsequence of `logout` and is an ordinary directory name,
		// which is what the prefix rule is for
		expect(nearest('out', ['logout'])).toBeUndefined();
		expect(nearest('log', ['logout'])).toBe('logout');
	});

	it('should refuse a one-character abbreviation', () => {
		expect(nearest('a', ['add'])).toBeUndefined();
		expect(nearest('ad', ['add'])).toBe('add');
	});
});

describe('the candidate lists', () => {
	it('should hold a command name and every alias, each once', async () => {
		const { contexts } = await parse({
			argv: [],
			schema: {
				commands: {
					// `rm` is an alias of two commands, which the registry keeps for
					// routing on whichever was added last -- and both commands keep it
					delete: { alias: 'rm', run() {} },
					remove: { name: 'remove, rm', run() {} },
					secret: { hidden: true, run() {} },
					'!bang': { run() {} },
				},
			},
		});

		// `help` is in because the parser registers it as an ordinary subcommand of
		// the root, and it is as typeable as any other -- `hepl` is a typo worth
		// answering. `secret` and `!bang` are out, because the app said not to
		// list them and a suggestion is a listing of one
		expect([...commandTokens(contexts[0])].sort()).toEqual(['delete', 'help', 'remove', 'rm']);
	});

	it('should offer a shared alias rather than tying it with itself', async () => {
		const { contexts } = await parse({
			argv: [],
			schema: {
				commands: {
					delete: { alias: 'rm', run() {} },
					remove: { name: 'remove, rm', run() {} },
				},
			},
		});

		expect(nearest('mr', commandTokens(contexts[0]))).toBe('rm');
	});

	it('should hold every option spelling across the chain, and no hidden one', async () => {
		const { contexts } = await parse({
			argv: ['build'],
			schema: {
				commands: {
					build: { options: { '--target [t]': 'x' }, run() {} },
				},
				options: {
					'-q, --quiet': 'x',
					'--secret': { hidden: true },
				},
				// so that `--version` is registered at all: an app that names no
				// version has nothing to answer with, which is the recorded opt-out
				version: '1.0.0',
			},
		});

		// the parser's own two are in, because they are typeable and real, and the
		// subcommand's `--target` is in because options resolve across the chain
		expect([...optionTokens(contexts)].sort()).toEqual([
			'--help',
			'--quiet',
			'--target',
			'--version',
			'-h',
			'-q',
			'-v',
		]);
	});
});

describe('through a parse', () => {
	const schema = () => ({
		commands: {
			build: { args: ['[entry]'], run() {} },
			deploy: { run() {} },
			secret: { hidden: true, run() {} },
			db: { commands: { migrate: { run() {} }, seed: { run() {} } }, run() {} },
		},
		name: 'mycli',
		options: { '--verbose': 'x', '--port [n]': { type: 'int' as const } },
	});

	async function failing(argv: string[], settings?: Settings): Promise<string> {
		const err = await parse({ argv, schema: schema(), settings }).catch((e: unknown) => e);
		expect(err, `${argv.join(' ')} produced no error`).toBeInstanceOf(Error);
		return (err as Error).message;
	}

	// the premise the ticket had wrong: a mistyped top-level command does not
	// throw `Unknown command` at all. Commands resolve against the innermost
	// context, an unmatched token falls through to the positional arguments, and
	// with none left to take it this is where it lands
	it('should suggest a command on the unexpected argument a mistyped one becomes', async () => {
		expect(await failing(['buidl'])).toBe('Unexpected argument "buidl". Did you mean "build"?');
	});

	it('should suggest from the innermost context rather than from the whole tree', async () => {
		// `migrate` is a subcommand of `db`, and from the root it is not a token
		// that resolves -- so the root offers nothing for a typo of it, while the
		// `db` context offers it
		expect(await failing(['migarte'])).toBe('Unexpected argument "migarte"');
		expect(await failing(['db', 'migarte'])).toBe(
			'Unexpected argument "migarte". Did you mean "migrate"?'
		);
	});

	it('should suggest nothing where nothing is near', async () => {
		expect(await failing(['./out/index.js'])).toBe('Unexpected argument "./out/index.js"');
	});

	it('should not suggest a hidden command', async () => {
		expect(await failing(['secrte'])).toBe('Unexpected argument "secrte"');
	});

	it('should suggest an option where the pass-through is off', async () => {
		expect(await failing(['--verbsoe'], { allowUnknownOptions: false })).toBe(
			'Unknown option "--verbsoe". Did you mean "--verbose"?'
		);
	});

	it('should suggest a command on help`s own unknown-command error', async () => {
		expect(await failing(['help', 'buidl'])).toBe('Unknown command "buidl". Did you mean "build"?');
		expect(await failing(['help', 'db', 'migarte'])).toBe(
			'Unknown command "migarte". Did you mean "migrate"?'
		);
	});

	// byte for byte what each of the three said before any of this existed
	it.each([
		[['buidl'], 'Unexpected argument "buidl"'],
		[['help', 'buidl'], 'Unknown command "buidl"'],
	])('should say %o as it always did under suggestions: false', async (argv, want) => {
		expect(await failing(argv, { suggestions: false })).toBe(want);
	});

	it('should say the unknown option as it always did under suggestions: false', async () => {
		expect(await failing(['--verbsoe'], { allowUnknownOptions: false, suggestions: false })).toBe(
			'Unknown option "--verbsoe"'
		);
	});

	// the module's own key rather than one a test passed in: this schema declares
	// exactly one short option -- `-h`, which the parser adds -- so with the
	// dashes left on, `-x` is one edit from it in a string of two and the rate
	// reads that as an ordinary slip. Two short options would hide it behind the
	// tie rule, which is how the first fixture for it said nothing
	it('should not offer a short option for a mistyped one of its own', async () => {
		expect(await failing(['-x'], { allowUnknownOptions: false })).toBe('Unknown option "-x"');
	});

	it('should suggest the parser`s own flags, which are typeable', async () => {
		expect(await failing(['--hepl'], { allowUnknownOptions: false })).toBe(
			'Unknown option "--hepl". Did you mean "--help"?'
		);
	});

	// an undeclared option produces a *value* by default, which is a recorded
	// decision -- so there is no error to suggest on, and this is why the
	// ticket's headline site is the one an ordinary app never reaches
	it('should leave an undeclared option alone where the pass-through is on', async () => {
		const { argv } = await parse({ argv: ['--verbsoe'], schema: schema() });
		expect(argv.verbsoe).toBe(true);
	});
});

describe('degenerate inputs', () => {
	it('should take a subject that is not a string without offering anything', async () => {
		const { contexts } = await parse({
			argv: [],
			schema: { commands: { build: { run() {} } } },
		});

		// the narrowing rather than a guard: `inputs[0]` is an `unknown` on a
		// parsed value, and every reachable one is a token out of argv
		expect(unexpectedArgument(undefined, contexts[0])).toBe('Unexpected argument "undefined"');
		expect(unexpectedArgument(42, contexts[0])).toBe('Unexpected argument "42"');
	});

	it('should answer for a context with an empty registry', async () => {
		const { contexts } = await parse({ argv: [], schema: { options: { '--x': 'x' } } });
		// `help` alone, which the parser adds, and nothing is near it
		expect(commandTokens(contexts[0])).toEqual(['help']);
		expect(unexpectedArgument('buidl', contexts[0])).toBe('Unexpected argument "buidl"');
	});

	it('should not read a candidate off the prototype chain', () => {
		// the registries are null-prototype for exactly this reason, and
		// `nearest()` walks a list rather than a lookup -- so the one thing to
		// pin is that a hostile name is an ordinary candidate
		expect(nearest('__prot__', ['__proto__'])).toBe('__proto__');
		expect(nearest('constructo', ['constructor'])).toBe('constructor');
	});

	// `U+0130` is the one code point in Unicode whose lowercase is longer than
	// itself, and `fuzzyMatch()` compares code point against code point -- so
	// before it was folded one-to-one, a dotted capital I anywhere in either
	// string made the match answer nothing at all. In the *candidate* as well,
	// which is a Turkish app's own command names
	it.each([
		['\u0130', 'i'],
		['\u0130nit', 'init'],
		['\u0130NIT', 'init'],
		['init', '\u0130nit'],
	])('should read %s and %s as the same letter', (typed, candidate) => {
		expect(nearest(typed, [candidate])).toBe(candidate);
		expect(distance(typed, candidate)).toBe(0);
	});

	it('should match an abbreviation through a dotted capital I, in either string', () => {
		expect(fuzzyMatch('\u0130n', 'info')?.matched).toEqual([0, 1]);
		expect(fuzzyMatch('in', '\u0130nfo')?.matched).toEqual([0, 1]);
		expect(nearest('\u0130nf', ['information'])).toBe('information');
	});

	it('should keep a dotless i distinct from an i, which is the non-Turkic answer', () => {
		// the locale fold is refused for the reason `fold()` records -- under
		// `tr-TR` an `I` lowercases to this -- so the two are different letters
		// here and a one-character pair has nothing in common
		expect(distance('\u0131', 'i')).toBe(1);
		expect(nearest('\u0131', ['i'])).toBeUndefined();
	});

	it('should offer nothing across a Unicode normalization, as the parser matches none', async () => {
		const composed = 'caf\u00e9';
		const decomposed = 'cafe\u0301';

		expect(nearest(decomposed, [composed])).toBeUndefined();

		// and that is the right answer rather than a gap: a registry lookup is a
		// plain object key, so the parser does not match across it either -- a
		// suggestion of the composed name would be one the typed token cannot
		// reach. The dotted capital I above is not the same case and is fixed: that
		// one removes a mark **case folding introduced**, where this is a mark the
		// author wrote
		const err = await parse({
			argv: [decomposed],
			schema: { commands: { [composed]: { run() {} } } },
		}).catch((e: unknown) => e);

		expect((err as Error).message).toBe(`Unexpected argument "${decomposed}"`);
	});

	it('should fold an astral candidate without splitting it', () => {
		expect(nearest('\u{1F600}uild', ['build'])).toBe('build');
		expect(nearest('buil\u{1F600}', ['build'])).toBe('build');
	});
});

describe('what a suggestion reads off', () => {
	it('should read the alias set the registry built rather than the declaration', async () => {
		// the same claim `commandCatalog()` makes: a command a hook added is a
		// command a suggestion can offer, because what is read is the initialized
		// registry rather than the declaration
		const { contexts } = await parse({
			argv: [],
			schema: {
				commands: { build: { run() {} } },
				hooks: {
					async beforeParse(state) {
						const { initCommand } = await import('../../src/parser/command/init-command.js');
						state.contexts[0][Internal].commands.add(
							await initCommand({ name: 'deploy', run() {} })
						);
					},
				},
			},
		});

		expect(contexts[0][Internal].commands.has('deploy')).toBe(true);
		expect(nearest('deplyo', commandTokens(contexts[0]))).toBe('deploy');
	});
});
