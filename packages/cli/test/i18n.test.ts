import { appKeys, checkCatalogs, findKeys, readAppCatalogs } from '../src/build/i18n.ts';
import { __, __n, loadCatalog, templateKey } from '@ttylabs/sigil/i18n';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

afterEach(async () => {
	await loadCatalog(undefined, {});
});

/** A module that imports the tag, around one expression. */
const moduleAround = (expr: string): string =>
	`import { __, __n } from '@ttylabs/sigil/i18n';\nexport const out = ${expr};\n`;

/** The keys the extractor finds in one expression. */
const keysOf = (expr: string): string[] =>
	findKeys('app.ts', moduleAround(expr)).map((found) => found.key);

describe('the extractor and the running tag', () => {
	// every shape of template this repository writes, plus the ones that are
	// easy to get wrong: an empty literal, slots at both ends, a newline, a
	// literal brace, and an interpolation that is not a bare identifier
	const shapes = [
		'__`Options:`',
		'__`Unknown option "${"--x"}"`',
		'__`Invalid value "${1}" for ${"--p"}"`',
		'__`${"a"} leading slot`',
		'__`trailing slot ${"z"}`',
		'__`${"a"}${"b"}`',
		'__``',
		'__`two\nlines`',
		'__`a literal {0} brace`',
		'__`a {{0}} escape`',
		'__`${1 + 2} an expression`',
		'__`tab\tand quote "q"`',
		'__`unicode ✓ and emoji 😀 ${"v"}`',
	];

	it.each(shapes)('should agree about the key for %s', (expr) => {
		const [key, ...rest] = keysOf(expr);

		expect(rest, 'one template, one key').toEqual([]);
		expect(key, 'the extractor read no key').toBeTypeOf('string');
	});

	it.each(shapes)('should look that key up at run time, for %s', async (expr) => {
		// the differential, and the one that matters: a catalog is built from the
		// key the *extractor* reported, and the tag is then evaluated for real. If
		// the two readings of the key rule had come apart the lookup would miss and
		// the answer would be the English -- which is exactly how `sigil check`
		// would come to report a missing key for a string that works
		const [key] = keysOf(expr);

		await loadCatalog({ de: async () => ({ [key]: 'HIT' }) }, {}, 'de');

		const run = new Function('__', '__n', `return ${expr};`) as (
			tag: typeof __,
			plural: typeof __n
		) => string;

		expect(run(__, __n)).toBe('HIT');
	});

	it('should read the parts through the one key function, not a copy of it', () => {
		// `templateKey()` is exported from the runtime precisely so there is one
		// implementation; this pins that the extractor is calling it rather than
		// agreeing with it by coincidence
		expect(keysOf('__`a ${1} b ${2} c`')).toEqual([templateKey(['a ', ' b ', ' c'], [])]);
	});
});

describe('finding the keys', () => {
	it('should find a plural, keyed on its singular', () => {
		const found = findKeys('app.ts', moduleAround("__n(2, 'Alias:', 'Aliases:')"));

		expect(found).toEqual([
			{ column: 20, key: 'Alias:', kind: 'plural', line: 2, plural: 'Aliases:' },
		]);
	});

	it('should find an aliased import', () => {
		const source = `import { __ as t } from '@ttylabs/sigil/i18n';\nexport const x = t\`Options:\`;\n`;

		expect(findKeys('app.ts', source).map((f) => f.key)).toEqual(['Options:']);
	});

	it('should find a namespace member', () => {
		const source = `import * as i from '@ttylabs/sigil/i18n';\nexport const x = i.__\`Options:\`;\n`;

		expect(findKeys('app.ts', source).map((f) => f.key)).toEqual(['Options:']);
	});

	it('should find a parenthesized tag', () => {
		const source = `import { __ } from '@ttylabs/sigil/i18n';\nexport const x = (__)\`Options:\`;\n`;

		expect(findKeys('app.ts', source).map((f) => f.key)).toEqual(['Options:']);
	});

	it('should find a tag nested inside another tag`s interpolation', () => {
		// which is how the parser composes `Invalid value "{0}" for {1}` with the
		// `option {0}` that goes in its second slot -- so the walk has to carry on
		// into a template it has already claimed
		expect(keysOf('__`outer ${__`inner`}`')).toEqual(['outer {0}', 'inner']);
	});

	it('should decline a tag the module binds again', () => {
		// `reboundNames()` is module-wide, which is why `t` was refused as the
		// tag's name: a parameter called `t` anywhere in a file would drop every
		// string in it
		const source =
			`import { __ } from '@ttylabs/sigil/i18n';\n` +
			`function f(__) { return __\`Options:\`; }\n` +
			`export const x = f(String);\n`;

		expect(findKeys('app.ts', source)).toEqual([]);
	});

	it('should decline a tag nothing imported', () => {
		expect(findKeys('app.ts', 'const __ = String.raw;\nexport const x = __`Options:`;\n')).toEqual(
			[]
		);
	});

	it('should decline a plural whose singular is not a literal', () => {
		// a key this pass cannot know is declined rather than guessed at: the
		// string still translates, and what is lost is only being told it is there
		expect(keysOf('__n(2, singular, plural)')).toEqual([]);
	});

	it('should read a template with no substitutions as the literal it is', () => {
		expect(keysOf('__n(2, `Alias:`, `Aliases:`)')).toEqual(['Alias:']);
	});
});

describe('comparing the catalogs', () => {
	const check = (catalog: Record<string, string>, keys: string[], framework: string[] = []) =>
		checkCatalogs({
			catalogs: [{ catalog, locale: 'de' }],
			file: '/app/src/index.ts',
			framework,
			keys,
		}).map((d) => d.message);

	it('should name an app key the catalog has no translation for', () => {
		// the app's own are few and each is a specific string somebody wrote, so
		// naming it is what makes it fixable
		expect(check({}, ['Options:'])).toEqual([
			'"de" has no translation for "Options:"; it will render in English',
		]);
	});

	it('should count the framework`s keys rather than naming each', () => {
		// a line per key turns the normal state of a half-finished translation into
		// a wall -- measured at 35 for one catalog -- and a wall is what teaches
		// people to stop reading warnings
		expect(check({}, [], ['a', 'b', 'c'])).toEqual([
			'"de" translates 0 of sigil\'s own 3 messages; the other 3 render in English. ' +
				'SIGIL_KEYS from "@ttylabs/sigil/i18n-keys" is the list.',
		]);
	});

	it('should say nothing about the framework once every key is carried', () => {
		expect(check({ a: 'A', b: 'B' }, [], ['a', 'b'])).toEqual([]);
	});

	it('should count what is carried, not only what is missing', () => {
		expect(check({ a: 'A' }, [], ['a', 'b', 'c'])[0]).toContain("translates 1 of sigil's own 3");
	});

	it('should report a key nothing asks for', () => {
		expect(check({ 'Old wording': 'Alte Formulierung' }, [])).toEqual([
			'"de" translates "Old wording", which nothing asks for; the English may have been reworded',
		]);
	});

	it('should report a reword as one of each, which is the signal it is', () => {
		// the known weakness of keying on the English, and the reason the check is
		// both directions: a copy-edit orphans the translation, and what the
		// translator needs to see is which string changed
		const messages = check({ 'Old wording': 'Alte Formulierung' }, ['New wording']);

		expect(messages).toHaveLength(2);
		expect(messages[0]).toContain('no translation for "New wording"');
		expect(messages[1]).toContain('translates "Old wording"');
	});

	it('should not call a framework key the app also uses an orphan', () => {
		// an app that writes `__`Options:`` itself shares the framework's key,
		// which is the merge keying on the English buys -- and it must not then be
		// reported from both sides
		expect(check({ 'Options:': 'Optionen:' }, ['Options:'], ['Options:'])).toEqual([]);
	});

	it('should say nothing about a complete catalog', () => {
		expect(check({ 'Options:': 'Optionen:', own: 'eigen' }, ['own'], ['Options:'])).toEqual([]);
	});

	it('should warn rather than fail, because the app works in English', () => {
		const diagnostics = checkCatalogs({
			catalogs: [{ catalog: {}, locale: 'de' }],
			file: '/app/src/index.ts',
			framework: ['Options:'],
			keys: ['own'],
		});

		expect(diagnostics).not.toHaveLength(0);
		expect(diagnostics.every((d) => d.severity === 'warning')).toBe(true);
	});

	it('should report each locale separately', () => {
		const messages = checkCatalogs({
			catalogs: [
				{ catalog: {}, locale: 'de' },
				{ catalog: { own: 'propre' }, locale: 'fr' },
			],
			file: '/app/src/index.ts',
			framework: [],
			keys: ['own'],
		}).map((d) => d.message);

		expect(messages).toEqual(['"de" has no translation for "own"; it will render in English']);
	});
});

describe('reading an app`s catalogs', () => {
	const fixture = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'i18n');

	it('should follow a literal import specifier to the file', async () => {
		// statically, never by running the app: importing the entry would run it,
		// which is the rule the whole build keeps
		const { discoverApp } = await import('../src/build/discover.ts');
		const read = readAppCatalogs(discoverApp(fixture));

		expect(read.declared).toBe(true);
		expect(read.catalogs.map((c) => c.locale)).toEqual(['de']);
		expect(read.catalogs[0]?.catalog['Hello, {0}!']).toBe('Hallo, {0}!');
	});

	it('should say which loader it could not read rather than reporting a clean catalog', async () => {
		const { discoverApp } = await import('../src/build/discover.ts');
		const read = readAppCatalogs(discoverApp(fixture));

		expect(read.diagnostics).toHaveLength(1);
		expect(read.diagnostics[0]?.message).toContain('the loader for "fr"');
		expect(read.diagnostics[0]?.severity).toBe('warning');
	});

	it('should find the app`s own keys across its modules', () => {
		const keys = appKeys(fixture);

		// the entry's two, and one from a command module -- so the walk really is
		// the whole tree rather than the entry alone
		expect(keys).toContain('Hello, {0}!');
		expect(keys).toContain('{0} file changed');
		expect(keys).toContain('Building...');
		expect(keys).toContain('Where to put it');
	});

	it('should answer nothing for an app that declares no locales', async () => {
		const { discoverApp } = await import('../src/build/discover.ts');
		const read = readAppCatalogs(discoverApp(join(fixture, '..', 'app')));

		expect(read).toEqual({ catalogs: [], declared: false, diagnostics: [] });
	});
});
