import {
	__,
	__n,
	type Catalog,
	confirmKeys,
	loadCatalog,
	locale,
	localeChain,
	type Locales,
	normalizeLocale,
	resolveLocale,
	setLocale,
} from '../src/i18n/index.js';
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * Puts the module back to English with no loader map, which is the state every
 * case starts from. `loadCatalog(undefined, {})` is an ordinary public call
 * rather than a reset written for the suite, which is why there is no
 * test-only export to do it.
 */
afterEach(async () => {
	await loadCatalog(undefined, {});
});

/** A catalog that reorders its slots, which is what translation is for. */
const de: Catalog = {
	'Alias:': { one: 'Alias:', other: 'Aliasse:' },
	'Invalid value "{0}" for {1}': 'Für {1} ist "{0}" ungültig',
	'Unknown option "{0}"': 'Unbekannte Option "{0}"',
};

/** Loads a catalog under one tag, resolved from `LANG`. */
const useGerman = (catalog: Catalog = de): Promise<void> =>
	loadCatalog({ de: async () => catalog }, { LANG: 'de_DE.UTF-8' });

describe('the tag', () => {
	it('should answer English with no catalog loaded', () => {
		expect(__`Invalid value "${8080}" for ${'--port'}`).toBe('Invalid value "8080" for --port');
	});

	it('should key on the English with numbered slots', async () => {
		await useGerman();

		// the key is `Invalid value "{0}" for {1}` -- the literal parts with the
		// interpolations numbered -- and the translation reorders them, which is
		// the whole reason this is not `%s`
		expect(__`Invalid value "${8080}" for ${'--port'}`).toBe('Für --port ist "8080" ungültig');
	});

	it('should fall back to the English sentence for a key no catalog has', async () => {
		await useGerman();

		expect(__`Missing value for option ${'--port'}`).toBe('Missing value for option --port');
	});

	it('should render a partial catalog as the mixture it is', async () => {
		// the normal state of a translation, and the case that decides the whole
		// silent-at-runtime rule: a German build with some English sentences in it
		// is better than an English one, and loud-at-runtime would make it worse
		await useGerman();

		expect(__`Unknown option "${'--porx'}"`).toBe('Unbekannte Option "--porx"');
		expect(__`Unexpected argument "${'x'}"`).toBe('Unexpected argument "x"');
	});

	it('should take a string with no interpolation at all', async () => {
		await loadCatalog({ de: async () => ({ Options: 'Optionen' }) }, {}, 'de');

		expect(__`Options`).toBe('Optionen');
	});

	it('should fall back to the raw text for an escape only a tag may carry', () => {
		// `\unicode` is invalid in an untagged template and legal in a tagged one,
		// where the engine hands the tag `undefined` for that part. Both the key
		// and the English fall back to the raw text, so neither returns less than
		// it was given -- the one place those two could have disagreed
		const run = new Function('__', 'return __`a \\unicode b`;') as (tag: typeof __) => string;

		expect(run(__)).toBe('a \\unicode b');
	});

	it('should leave a slot no value names exactly as it was', async () => {
		// what makes a literal `{0}` safe in a string with no values, so nothing
		// has to be escaped in the overwhelmingly common case.
		//
		// With a catalog, because the range check is inside `fill()` and the
		// English path never reaches it -- the first version of this asserted the
		// same string through `zip()` and so said nothing about the guard
		await loadCatalog({ de: async () => ({ 'see {0} for more': 'siehe {0} für mehr' }) }, {}, 'de');

		expect(__`see {0} for more`).toBe('siehe {0} für mehr');
	});

	it('should leave a slot no value names alone on the English path too', () => {
		expect(__`see {0} for more`).toBe('see {0} for more');
	});

	it('should unescape {{ and }}', async () => {
		await loadCatalog({ de: async () => ({ 'a {{0}} b {0}': 'A {{0}} B {0}' }) }, {}, 'de');

		expect(__`a {{0}} b ${'V'}`).toBe('A {0} B V');
	});

	it('should fall back rather than print an object for a plural entry', async () => {
		// a catalog that answers the wrong shape has drifted from the source, which
		// is `sigil check`'s to report -- what it must not do is replace a working
		// sentence with `[object Object]`
		await loadCatalog(
			{ de: async () => ({ Arguments: 'Argumente', Options: { other: 'Optionen' } }) },
			{},
			'de'
		);

		// the sibling is what stops this going vacuous: without it, a catalog that
		// failed to load at all answers the same English and the test says nothing
		expect(__`Arguments`).toBe('Argumente');
		expect(__`Options`).toBe('Options');
	});
});

describe('the plural', () => {
	it('should select on count with no catalog loaded', () => {
		expect(__n(1, 'Alias:', 'Aliases:')).toBe('Alias:');
		expect(__n(2, 'Alias:', 'Aliases:')).toBe('Aliases:');
		expect(__n(0, 'Alias:', 'Aliases:')).toBe('Aliases:');
	});

	it('should key on the singular', async () => {
		await useGerman();

		expect(__n(1, 'Alias:', 'Aliases:')).toBe('Alias:');
		expect(__n(2, 'Alias:', 'Aliases:')).toBe('Aliasse:');
	});

	it('should put the count in {0} and anything else after it', () => {
		expect(__n(1, '{0} file in {1}', '{0} files in {1}', 'src')).toBe('1 file in src');
		expect(__n(7, '{0} file in {1}', '{0} files in {1}', 'src')).toBe('7 files in src');
	});

	it('should select the category a locale actually uses, not English', async () => {
		// Polish has `one`, `few`, `many` and `other`, and `Intl.PluralRules` knows
		// which is which -- so a grammar for plurals buys nothing a category object
		// does not already have
		await loadCatalog(
			{
				pl: async () => ({
					'{0} file': { few: '{0} pliki', many: '{0} plików', one: '{0} plik', other: '{0} pliku' },
				}),
			},
			{},
			'pl'
		);

		expect(__n(1, '{0} file', '{0} files')).toBe('1 plik');
		expect(__n(3, '{0} file', '{0} files')).toBe('3 pliki');
		expect(__n(25, '{0} file', '{0} files')).toBe('25 plików');
	});

	it('should take a plain string for a language with one form', async () => {
		// Japanese, Chinese and Korean have one form for every count, so an object
		// would say nothing the string does not
		await loadCatalog({ ja: async () => ({ 'Alias:': 'エイリアス:' }) }, {}, 'ja');

		expect(__n(1, 'Alias:', 'Aliases:')).toBe('エイリアス:');
		expect(__n(9, 'Alias:', 'Aliases:')).toBe('エイリアス:');
	});

	it('should fall back to `other` for a category the catalog left out', async () => {
		await loadCatalog({ pl: async () => ({ 'a {0}': { other: 'O {0}' } }) }, {}, 'pl');

		expect(__n(3, 'a {0}', 'b {0}')).toBe('O 3');
	});

	it('should fall back to English for a key no catalog has', async () => {
		await useGerman();

		expect(__n(2, 'Argument:', 'Arguments:')).toBe('Arguments:');
	});
});

describe('the keys a yes-or-no prompt accepts', () => {
	// one catalog entry decides what is drawn *and* what is accepted, so a hint
	// translated on its own cannot end up naming a key nothing reads. Asserted
	// here rather than through a prompt because it is a function of a string and a
	// boolean, which is the split `rowWindow()` and `thumbExtent()` already keep
	it('should draw the English pair with the default capitalized', () => {
		expect(confirmKeys('y/n', true)).to.deep.equal({ hint: '(Y/n)', no: ['n'], yes: ['y'] });
		expect(confirmKeys('y/n', false)).to.deep.equal({ hint: '(y/N)', no: ['n'], yes: ['y'] });
	});

	it('should accept the key a translated pair names, and keep English beside it', () => {
		const keys = confirmKeys('j/n', true);

		expect(keys.hint).to.equal('(J/n)');
		expect(keys.yes).to.deep.equal(['j', 'y']);
		// `n` means no in both, so there is nothing to add and nothing to refuse
		expect(keys.no).to.deep.equal(['n']);
	});

	it('should refuse an English key the pair gave the other meaning', () => {
		// the hint is what is on screen, so it is authoritative and English is
		// additive: a romanized `n/a` has `n` meaning *yes*, as the reader was told,
		// and accepting English `n` as no would give one keypress both answers
		const keys = confirmKeys('n/a', true);

		expect(keys.hint).to.equal('(N/a)');
		expect(keys.yes).to.deep.equal(['n', 'y']);
		expect(keys.no).to.deep.equal(['a']);
		expect(keys.no).to.not.include('n');
	});

	it('should refuse English y where the pair made it the no key', () => {
		// the mirror of the case above, which a fixture that only moved the yes half
		// would not reach
		const keys = confirmKeys('t/y', true);

		expect(keys.yes).to.deep.equal(['t']);
		expect(keys.no).to.deep.equal(['y', 'n']);
		expect(keys.yes).to.not.include('y');
	});

	it('should take the first character of a word, not the word', () => {
		// a single character is the degenerate case of that rule rather than a second
		// rule, so a locale that spells the words out gets `(Ja/nein)` and `j`/`n`
		const keys = confirmKeys('ja/nein', true);

		expect(keys.hint).to.equal('(Ja/nein)');
		expect(keys.yes).to.deep.equal(['j', 'y']);
		expect(keys.no).to.deep.equal(['n']);
		expect(confirmKeys('ja/nein', false).hint).to.equal('(ja/Nein)');
	});

	it('should capitalize by code point too, which emoji cannot show', () => {
		// an astral *emoji* has no uppercase mapping, so reading its first code unit
		// instead answers the same string and the guard looks inert. Deseret has one:
		// `\u{10428}` upper-cases to `\u{10400}`, while upper-casing its leading
		// surrogate is a no-op and rejoining gives the original back. Found by a
		// sabotage that survived a fixture built out of thumbs
		expect(confirmKeys('\u{10428}/n', true).hint).to.equal('(\u{10400}/n)');
		expect(confirmKeys('\u{10428}/n', true).yes).to.deep.equal(['\u{10428}', 'y']);
	});

	it('should read a character by code point rather than by code unit', () => {
		// an astral character is one key rather than half a surrogate pair, which is
		// the rule `highlightRuns()` already keeps -- and a key that is half a pair
		// is one no terminal can send and no comparison can match
		const keys = confirmKeys('\u{1F44D}/\u{1F44E}', true);

		expect(keys.yes).to.deep.equal(['\u{1F44D}', 'y']);
		expect(keys.no).to.deep.equal(['\u{1F44E}', 'n']);
		expect(keys.hint).to.equal('(\u{1F44D}/\u{1F44E})');
	});

	it('should lowercase the key it reads, so the capital is presentational', () => {
		// a translator writing the default in capitals is saying which is the
		// default, not naming a different key
		expect(confirmKeys('J/N', true).yes).to.deep.equal(['j', 'y']);
		expect(confirmKeys('J/N', true).no).to.deep.equal(['n']);
	});

	it('should trim each half', () => {
		const keys = confirmKeys(' ja / nein ', true);

		expect(keys.hint).to.equal('(Ja/nein)');
		expect(keys.yes).to.deep.equal(['j', 'y']);
	});

	it('should fall back to English for an entry it cannot read', () => {
		// refused rather than guessed at, which is the rule a data type already
		// follows: English stands, because a hint nobody can read is worse than an
		// English one. Every shape that is not two halves naming two distinct keys
		for (const pair of ['', 'ja oder nein', 'j/', '/n', 'j/n/m', 'ja/jein', ' / ']) {
			expect(confirmKeys(pair, true), pair).to.deep.equal({
				hint: '(Y/n)',
				no: ['n'],
				yes: ['y'],
			});
		}
	});
});

describe('resolving a locale', () => {
	// the table the design pass measured, `POSIX` and `nonsense` included,
	// because neither of those throws out of `Intl.getCanonicalLocales` and a
	// resolver that trusts the answer reads the C locale as a language
	it.each([
		['en_US.UTF-8', 'en-US'],
		['de_DE.UTF-8', 'de-DE'],
		['pt_BR', 'pt-BR'],
		['zh_Hans_CN', 'zh-Hans-CN'],
		['de_DE@euro', 'de-DE'],
		['de_DE.UTF-8@euro', 'de-DE'],
		['ja', 'ja'],
		['C', undefined],
		['C.UTF-8', undefined],
		['POSIX', undefined],
		['posix', undefined],
		['', undefined],
		['   ', undefined],
		// syntactically a legal primary language subtag, so it canonicalizes --
		// harmless, because a tag no loader is keyed by simply reads as English
		['nonsense', 'nonsense'],
		// a single letter is reserved for an extension subtag, so it is not a
		// language -- which is how two tests in this file first came to assert
		// the English fallback while believing they had loaded a catalog
		['x', undefined],
		// not legal syntax, so `Intl` throws and it is no decision
		['!!', undefined],
		['de-', undefined],
	])('should read %j as %j', (raw, want) => {
		expect(normalizeLocale(raw)).toBe(want);
	});

	it('should take the first entry of a preference list', () => {
		expect(normalizeLocale('de_DE:en_US')).toBe('de-DE');
	});

	it('should read the chain in order', () => {
		expect(resolveLocale({ LANG: 'de_DE' })).toBe('de-DE');
		expect(resolveLocale({ LANG: 'de_DE', LC_MESSAGES: 'fr_FR' })).toBe('fr-FR');
		expect(resolveLocale({ LANG: 'de_DE', LC_ALL: 'it_IT', LC_MESSAGES: 'fr_FR' })).toBe('it-IT');
		expect(
			resolveLocale({ LANG: 'de_DE', LC_ALL: 'it_IT', LC_MESSAGES: 'fr_FR', SIGIL_LOCALE: 'ja' })
		).toBe('ja');
		expect(resolveLocale({ LANG: 'de_DE', SIGIL_LOCALE: 'ja' }, 'pt_BR')).toBe('pt-BR');
	});

	it('should skip a variable that is set and says nothing', () => {
		// `LC_ALL=` is how a variable gets left blank, which is the rule an empty
		// environment variable already follows in the parser: it falls through
		// rather than deciding
		expect(resolveLocale({ LANG: 'de_DE', LC_ALL: '' })).toBe('de-DE');
		expect(resolveLocale({ LANG: 'de_DE', LC_ALL: '  ' })).toBe('de-DE');
	});

	it('should stop at a variable that is set to the C locale', () => {
		// `LC_ALL=C` is a decision, unlike `LC_ALL=`: it says English, so it does
		// not fall through to a `LANG` that says otherwise
		expect(resolveLocale({ LANG: 'de_DE', LC_ALL: 'C' })).toBeUndefined();
	});

	it('should answer nothing for an environment that configured none', () => {
		expect(resolveLocale({})).toBeUndefined();
		expect(resolveLocale()).toBeUndefined();
	});

	it('should fall back to the app`s default when nothing else named one', () => {
		expect(resolveLocale({}, undefined, 'de_DE.UTF-8')).toBe('de-DE');
	});

	it('should let every environment variable beat the app`s default', () => {
		// the whole of what makes `defaultLocale` a *default* rather than a second
		// `AppOptions.locale`: it is the bottom of the chain, so it says what the
		// app ships in without overriding the user
		expect(resolveLocale({ LANG: 'fr_FR' }, undefined, 'de')).toBe('fr-FR');
		expect(resolveLocale({ LC_MESSAGES: 'fr_FR' }, undefined, 'de')).toBe('fr-FR');
		expect(resolveLocale({ LC_ALL: 'fr_FR' }, undefined, 'de')).toBe('fr-FR');
		expect(resolveLocale({ SIGIL_LOCALE: 'fr_FR' }, undefined, 'de')).toBe('fr-FR');
		expect(resolveLocale({}, 'fr_FR', 'de')).toBe('fr-FR');
	});

	it('should let `LC_ALL=C` beat the app`s default, which a blank one does not', () => {
		// `C` is a decision and says English, so it stops the walk before the
		// default is reached; a variable that is merely blank falls through to it
		expect(resolveLocale({ LC_ALL: 'C' }, undefined, 'de')).toBeUndefined();
		expect(resolveLocale({ LC_ALL: '' }, undefined, 'de')).toBe('de');
	});
});

describe('the fallback chain', () => {
	it.each([
		['de-DE', ['de-DE', 'de']],
		['zh-Hans-CN', ['zh-Hans-CN', 'zh-Hans', 'zh']],
		['de', ['de']],
	])('should read %j as %j', (tag, want) => {
		expect(localeChain(tag)).toEqual(want);
	});

	it('should serve a region from the language catalog', async () => {
		// so an app that ships one `de` catalog serves Austria and Switzerland
		await loadCatalog({ de: async () => de }, { LANG: 'de_AT.UTF-8' });

		expect(__`Unknown option "${'--x'}"`).toBe('Unbekannte Option "--x"');
	});

	it('should answer with the tag a catalog was found for, not the one asked for', async () => {
		// which is what `Intl.PluralRules` is constructed with, and that one has to
		// agree with the catalog rather than with the request
		await loadCatalog({ de: async () => de }, { LANG: 'de_AT' });

		expect(locale()).toBe('de');
	});

	it('should prefer the more specific catalog where there is one', async () => {
		await loadCatalog(
			{
				pt: async () => ({ Options: 'Opções (pt)' }),
				'pt-BR': async () => ({ Options: 'Opções (BR)' }),
			},
			{ LANG: 'pt_BR' }
		);

		expect(__`Options`).toBe('Opções (BR)');
	});
});

describe('loading a catalog', () => {
	it('should call no loader at all for English', async () => {
		const loader = vi.fn(async () => de);

		await loadCatalog({ de: loader }, { LANG: 'C.UTF-8' });

		expect(loader).not.toHaveBeenCalled();
		expect(locale()).toBeUndefined();
	});

	it('should call only the loader it needs', async () => {
		const fr = vi.fn(async () => ({}) as Catalog);
		const loader = vi.fn(async () => de);

		await loadCatalog({ de: loader, fr }, { LANG: 'de_DE' });

		expect(loader).toHaveBeenCalledOnce();
		expect(fr).not.toHaveBeenCalled();
	});

	it('should leave English in effect when a loader throws', async () => {
		// what a broken translation must not do is fail a parse: the English it
		// falls back to is a working message, and the user is already being told
		// something went wrong
		await loadCatalog(
			{
				de: async () => {
					throw new Error('no such file');
				},
			},
			{ LANG: 'de_DE' }
		);

		expect(__`Unknown option "${'--x'}"`).toBe('Unknown option "--x"');
	});

	it('should leave English in effect when a loader answers no catalog', async () => {
		await loadCatalog({ de: async () => undefined as unknown as Catalog }, { LANG: 'de_DE' });

		expect(__`Unknown option "${'--x'}"`).toBe('Unknown option "--x"');
	});

	it('should read a JSON module`s default export', async () => {
		// `import('./de.json', { with: { type: 'json' } })` answers `{ default: … }`,
		// which is the recommended loader body
		await loadCatalog({ de: async () => ({ default: de }) }, { LANG: 'de_DE' });

		expect(__`Unknown option "${'--x'}"`).toBe('Unbekannte Option "--x"');
	});

	it('should match a loader keyed in any spelling', async () => {
		// a loader map is written by hand, so `de_DE` and `de-de` both mean `de-DE`
		// -- matching the spelling would leave one unreachable with nothing to say so
		for (const key of ['de_DE', 'de-de', 'DE-de']) {
			const locales = { [key]: async () => de } as Locales;

			await loadCatalog(locales, { LANG: 'de_DE' });

			expect(__`Unknown option "${'--x'}"`, key).toBe('Unbekannte Option "--x"');
		}
	});

	it('should keep the first of two spellings of one tag', async () => {
		// a loader map is written by hand, so `de-DE` and `de_DE` normalize to the
		// same tag -- and which one wins must not depend on key order twice over
		await loadCatalog(
			{
				'de-DE': async () => ({ Options: 'FIRST' }),
				de_DE: async () => ({ Options: 'SECOND' }),
			},
			{ LANG: 'de_DE' }
		);

		expect(__`Options`).toBe('FIRST');
	});

	it('should load the app`s default when the environment named none', async () => {
		await loadCatalog({ de: async () => de }, {}, undefined, 'de');

		expect(locale()).toBe('de');
		expect(__`Unknown option "${'--porx'}"`).toBe('Unbekannte Option "--porx"');
	});

	it('should load nothing for an app that named a default and ships no catalogs', async () => {
		// a `defaultLocale` is not a catalog, so it does not open the gate the
		// loader map opens: an app with nothing to load has nothing to resolve a
		// locale *for*
		const loader = vi.fn();

		await loadCatalog(undefined, {}, undefined, 'de');

		expect(loader).not.toHaveBeenCalled();
		expect(locale()).toBeUndefined();
	});

	it('should resolve no locale at all for an app that declares none', async () => {
		// the declared fast path: with no catalogs there is nothing to resolve a
		// locale *for*, so `Intl` is never asked whether `LANG` names a language
		await loadCatalog(undefined, { LANG: 'de_DE.UTF-8' });

		expect(locale()).toBeUndefined();
	});

	it('should leave English in effect when nothing is keyed for the locale', async () => {
		await loadCatalog({ fr: async () => de }, { LANG: 'de_DE' });

		expect(__`Unknown option "${'--x'}"`).toBe('Unknown option "--x"');
		expect(locale()).toBe('de-DE');
	});
});

describe('changing the locale after the app has started', () => {
	it('should load a catalog the loader map already holds', async () => {
		await loadCatalog({ de: async () => de }, { LANG: 'C' });

		expect(__`Unknown option "${'--x'}"`).toBe('Unknown option "--x"');

		await setLocale('de');

		expect(__`Unknown option "${'--x'}"`).toBe('Unbekannte Option "--x"');
		expect(locale()).toBe('de');
	});

	it('should put English back', async () => {
		await loadCatalog({ de: async () => de }, { LANG: 'de_DE' });
		await setLocale(undefined);

		expect(__`Unknown option "${'--x'}"`).toBe('Unknown option "--x"');
		expect(locale()).toBeUndefined();
	});

	it('should take any spelling, the way the environment is read', async () => {
		await loadCatalog({ de: async () => de }, {});
		await setLocale('de_DE.UTF-8');

		expect(__`Unknown option "${'--x'}"`).toBe('Unbekannte Option "--x"');
	});

	it('should rebuild the plural selector rather than keeping the old locale`s', async () => {
		// `Intl.PluralRules` is cached, and a cache that survived a locale change
		// would select Polish categories for a German catalog
		await loadCatalog(
			{
				de: async () => ({ '{0} file': { one: '{0} Datei', other: '{0} Dateien' } }),
				pl: async () => ({
					'{0} file': { few: '{0} pliki', many: '{0} plików', one: '{0} plik', other: '{0} pliku' },
				}),
			},
			{},
			'pl'
		);

		expect(__n(3, '{0} file', '{0} files')).toBe('3 pliki');

		await setLocale('de');

		// German has no `few`, so 3 is `other` -- which only comes out right if the
		// selector was rebuilt
		expect(__n(3, '{0} file', '{0} files')).toBe('3 Dateien');
	});
});

describe('through main()', () => {
	/** Every message argv or the environment can reach, with its key. */
	const messages: Record<string, string> = {
		'Count is too large to be exact: {0}': 'ZÄHLER-ZU-GROSS {0}',
		'Error: {0}': 'FEHLER: {0}',
		'Extra arguments are not allowed: {0}': 'KEINE-EXTRAS {0}',
		'Integer is too large to be exact: {0}': 'ZU-GROSS {0}',
		'Invalid JSON: {0}': 'JSON-UNGÜLTIG {0}',
		'Invalid boolean: "{0}"': 'BOOL-UNGÜLTIG "{0}"',
		'Invalid count: {0}': 'ZÄHLER-UNGÜLTIG {0}',
		'Invalid date: "{0}"': 'DATUM-UNGÜLTIG "{0}"',
		'Invalid integer: {0}': 'GANZZAHL-UNGÜLTIG {0}',
		'Invalid number: {0}': 'ZAHL-UNGÜLTIG {0}',
		'Invalid value "{0}" for {1}': 'FÜR {1} IST "{0}" UNGÜLTIG',
		'Missing required arguments: {0}': 'FEHLENDE-ARGUMENTE {0}',
		'Missing required options: {0}': 'FEHLENDE-OPTIONEN {0}',
		'Missing value for option {0}': 'FEHLENDER-WERT {0}',
		'Unexpected argument "{0}"': 'UNERWARTET "{0}"',
		'Unknown command "{0}"': 'UNBEKANNTER-BEFEHL "{0}"',
		'Unknown option "{0}"': 'UNBEKANNTE-OPTION "{0}"',
		'Value must be "{0}" or "{1}"': 'JA-ODER-NEIN "{0}"/"{1}"',
		'argument <{0}>': 'ARGUMENT <{0}>',
		'option {0}': 'OPTION {0}',
	};

	const appSchema = (locales?: Locales) => ({
		commands: {
			build: { args: ['<entry>'], run() {} },
			pick: { args: [{ choices: ['a', 'b'], name: '<which>' }], run() {} },
		},
		locales,
		name: 'mycli',
		options: {
			'--count': { type: 'count' as const },
			'--data [j]': { type: 'json' as const },
			'--flag [b]': { type: 'bool' as const },
			'--mode [m]': { choices: ['dev', 'prod'] },
			'--num [n]': { type: 'number' as const },
			'--ok [y]': { type: 'yesno' as const },
			'--port [n]': { type: 'int' as const },
			// the one that really is required, which is what the missing-options
			// case is for. `<value>` would have made every option above required
			// too, because that is what angle brackets mean here
			'--req <r>': { required: true },
			'--when [d]': { type: 'date' as const },
		},
	});

	/** Runs a parse and hands back what `renderError()` would have written. */
	async function rendered(argv: string[], locales?: Locales): Promise<string> {
		const { main } = await import('../src/index.js');
		const { renderError } = await import('../src/error-handler.js');

		const err = await main({
			argv,
			locale: locales ? 'de' : undefined,
			schema: appSchema(locales),
			// an undeclared option produces a *value* by default, so without this
			// `Unknown option` is a site nothing in the suite reaches -- which is
			// how the first probe for it came back reporting a different message
			settings: { allowUnknownOptions: false, assertCwd: false, errorHandler: false },
		}).catch((e: unknown) => e);

		expect(err, `${argv.join(' ')} produced no error`).toBeInstanceOf(Error);

		return renderError(err);
	}

	const german = { de: async () => messages };

	// every message a user can provoke, English and translated, so that the key
	// at each of the sites is pinned to the one the catalog carries -- a site
	// whose key drifted renders English and fails the second half
	const cases: [string, string[], string, string][] = [
		[
			'unknown option',
			['--porx', '--req', 'r'],
			'Unknown option "--porx"',
			'UNBEKANNTE-OPTION "--porx"',
		],
		[
			'unexpected argument',
			['nope', '--req', 'r'],
			'Unexpected argument "nope"',
			'UNERWARTET "nope"',
		],
		[
			'missing option value',
			['--port', '--req', 'r'],
			'Missing value for option --port',
			'FEHLENDER-WERT --port',
		],
		[
			'missing arguments',
			['build', '--req', 'r'],
			'Missing required arguments: <entry>',
			'FEHLENDE-ARGUMENTE <entry>',
		],
		[
			'bad integer',
			['--port', 'eight', '--req', 'r'],
			'Invalid integer: eight',
			'GANZZAHL-UNGÜLTIG eight',
		],
		[
			'integer too large',
			['--port', '9007199254740993', '--req', 'r'],
			'Integer is too large to be exact: 9007199254740993',
			'ZU-GROSS 9007199254740993',
		],
		['bad count', ['--count=lots', '--req', 'r'], 'Invalid count: lots', 'ZÄHLER-UNGÜLTIG lots'],
		[
			'bad date',
			['--when', '2024-02-30', '--req', 'r'],
			'Invalid date: "2024-02-30"',
			'DATUM-UNGÜLTIG "2024-02-30"',
		],
		[
			'bad boolean',
			['--flag', 'maybe', '--req', 'r'],
			'Invalid boolean: "maybe"',
			'BOOL-UNGÜLTIG "maybe"',
		],
		['bad number', ['--num', 'abc', '--req', 'r'], 'Invalid number: abc', 'ZAHL-UNGÜLTIG abc'],
		// the quoted words are *slots*, so a translator cannot translate the
		// vocabulary out from under `yesRE` -- the German below says the sentence
		// and still names `yes`/`no`, which is what argv accepts
		[
			'bad yes/no',
			['--ok', 'maybe', '--req', 'r'],
			'Value must be "yes" or "no"',
			'JA-ODER-NEIN "yes"/"no"',
		],
		// the hard one: the slots reorder *and* the noun is a nested translation
		[
			'bad option choice',
			['--mode', 'staging', '--req', 'r'],
			'Invalid value "staging" for option --mode',
			'FÜR OPTION --mode IST "staging" UNGÜLTIG',
		],
		[
			'bad argument choice',
			['pick', 'c', '--req', 'r'],
			'Invalid value "c" for argument <which>',
			'FÜR ARGUMENT <which> IST "c" UNGÜLTIG',
		],
		[
			'unknown command',
			['help', 'nosuch'],
			'Unknown command "nosuch"',
			'UNBEKANNTER-BEFEHL "nosuch"',
		],
		// what follows `--` goes through whole, and is refused unless the app
		// asked for it -- the one site argv reaches only past a terminator
		[
			'extra arguments',
			['build', 'x', '--req', 'r', '--', 'a', 'b'],
			'Extra arguments are not allowed: a b',
			'KEINE-EXTRAS a b',
		],
		[
			'count too large',
			['--count=9007199254740993', '--req', 'r'],
			'Count is too large to be exact: 9007199254740993',
			'ZÄHLER-ZU-GROSS 9007199254740993',
		],
	];

	it.each(cases)('should render %s', async (_name, argv, english, translated) => {
		expect(await rendered(argv)).toBe(`Error: ${english}`);
		expect(await rendered(argv, german)).toBe(`FEHLER: ${translated}`);
	});

	it('should render a missing-options list, which names every one of them', async () => {
		// the list is identifiers rather than prose, so it takes no plural and no
		// locale-appropriate conjunction -- which is why `Intl.ListFormat` is out
		expect(await rendered(['build', 'x'])).toContain('Error: Missing required options: --req');
		expect(await rendered(['build', 'x'], german)).toContain('FEHLER: FEHLENDE-OPTIONEN --req');
	});

	it('should keep the JSON parser`s own sentence, which reaches no catalog', async () => {
		// `JSON.parse`'s message is V8's English. The outer frame is a key; the
		// inner sentence is not reachable, and inventing a replacement would mean
		// writing a JSON parser to produce a better one
		const de = await rendered(['--data', '{nope', '--req', 'r'], german);

		expect(de).toContain('JSON-UNGÜLTIG');
		expect(de).toContain('Expected property name');
	});

	it('should load no catalog at all for English', async () => {
		// the whole design rests on this: English is the literal at the site, so
		// the path every app without translations takes reads nothing, calls
		// nothing and constructs no `Intl`
		const { main } = await import('../src/index.js');
		const loader = vi.fn(async () => messages);

		vi.stubEnv('LANG', 'C.UTF-8');
		vi.stubEnv('LC_ALL', '');
		vi.stubEnv('LC_MESSAGES', '');
		vi.stubEnv('SIGIL_LOCALE', '');

		const write = vi.spyOn(process.stdout, 'write').mockReturnValue(true);

		try {
			for (const argv of [['--version'], ['--help'], ['--porx', '--req', 'r']]) {
				await main({
					argv,
					schema: { ...appSchema({ de: loader }), version: '1.0.0' },
					settings: { assertCwd: false, errorHandler: () => {} },
				});
			}
		} finally {
			write.mockRestore();
			vi.unstubAllEnvs();
		}

		expect(loader).not.toHaveBeenCalled();
	});

	it('should resolve the locale from the environment', async () => {
		const { main } = await import('../src/index.js');

		vi.stubEnv('LANG', 'de_DE.UTF-8');
		vi.stubEnv('LC_ALL', '');
		vi.stubEnv('LC_MESSAGES', '');
		vi.stubEnv('SIGIL_LOCALE', '');

		try {
			const err = await main({
				argv: ['--porx', '--req', 'r'],
				schema: appSchema(german),
				settings: { allowUnknownOptions: false, assertCwd: false, errorHandler: false },
			}).catch((e: unknown) => e);

			expect((err as Error).message).toBe('UNBEKANNTE-OPTION "--porx"');
		} finally {
			vi.unstubAllEnvs();
		}
	});

	it('should let a loader that throws leave the parse working, in English', async () => {
		const err = await rendered(['--porx', '--req', 'r'], {
			de: async () => {
				throw new Error('ENOENT');
			},
		});

		expect(err).toBe('Error: Unknown option "--porx"');
	});

	it('should translate the help screen`s chrome', async () => {
		const { main } = await import('../src/index.js');
		const lines: string[] = [];
		const write = vi
			.spyOn(process.stdout, 'write')
			.mockImplementation(((s: string) => (lines.push(s), true)) as never);

		try {
			await main({
				argv: ['--help'],
				locale: 'de',
				schema: {
					...appSchema({
						de: async () => ({
							'Commands:': 'Befehle:',
							'Options:': 'Optionen:',
							'Usage:': 'Verwendung:',
							'[options]': '[optionen]',
							'<command>': '<befehl>',
						}),
					}),
					version: '1.0.0',
				},
				settings: { assertCwd: false },
			});
		} finally {
			write.mockRestore();
		}

		const text = lines.join('');

		expect(text).toContain('Verwendung: mycli [optionen] <befehl>');
		expect(text).toContain('Befehle:');
		expect(text).toContain('Optionen:');
		// a string the catalog left out is still the English one, which is the
		// partial-catalog rule on a screen rather than in a unit
		expect(text).toContain('Print the version');
	});
});

describe('a command module`s own strings', () => {
	it('should translate, because the module is imported after the catalog loads', async () => {
		// a command module is reached by `loadCommand()` during `parse()`, which is
		// after `main()` has resolved the locale -- so a `__` written as a *value*
		// in one is translated. The same spelling in the root schema's own literal
		// is not, because that one is evaluated when the module holding it is
		// imported, which is before `main()` is called at all; a thunk is what
		// closes that, and `a description written as a thunk` below is where it is
		// pinned.
		const { main } = await import('../src/index.js');
		const lines: string[] = [];
		const write = vi
			.spyOn(process.stdout, 'write')
			.mockImplementation(((s: string) => (lines.push(s), true)) as never);

		try {
			await main({
				argv: ['help', 'build'],
				locale: 'de',
				schema: {
					commands: {
						build: {
							// a command declared inline on the schema is still built by
							// `initCommand()` inside `parse()`, but its `desc` string was
							// already produced when this literal was evaluated -- so what
							// is pinned here is a command whose module is *loaded*
							load: async () => {
								const { __ } = await import('../src/i18n/index.js');

								return { default: { desc: __`Build the app`, run() {} } };
							},
						},
					},
					locales: { de: async () => ({ 'Build the app': 'Die App bauen' }) },
					name: 'mycli',
				},
				settings: { assertCwd: false },
			});
		} finally {
			write.mockRestore();
		}

		expect(lines.join('')).toContain('Die App bauen');
	});
});

describe('a default locale the app declared', () => {
	/** A schema with a catalog and a declared default. */
	const schema = (defaultLocale?: string) => ({
		defaultLocale,
		locales: { de: async () => ({ 'Unknown option "{0}"': 'UNBEKANNT "{0}"' }) },
		name: 'mycli',
	});

	/**
	 * Runs `main()` over a provoked parse error, with stderr captured.
	 *
	 * The error path rather than help, because that is the surface the chain has
	 * to reach first: a parse can fail before any of the app's own code runs.
	 *
	 * @param defaultLocale - What the schema declares, if anything.
	 * @returns What `errorHandler()` wrote.
	 */
	async function failingRun(defaultLocale?: string): Promise<string> {
		const { main } = await import('../src/index.js');
		const lines: string[] = [];
		const write = vi
			.spyOn(process.stderr, 'write')
			.mockImplementation(((text: string) => (lines.push(text), true)) as never);

		try {
			await main({
				argv: ['--porx'],
				schema: schema(defaultLocale),
				settings: { allowUnknownOptions: false, assertCwd: false },
			});
		} finally {
			write.mockRestore();
		}

		return lines.join('');
	}

	it('should render in it when the environment named none', async () => {
		// `sigil build` writes `defaultLocale` into the schema from `"locale"` in
		// `sigil.json`, because the runtime cannot read that file -- so this one
		// argument is the whole of what makes that feature reach the screen
		vi.stubEnv('LANG', undefined);
		vi.stubEnv('LC_ALL', undefined);
		vi.stubEnv('LC_MESSAGES', undefined);
		vi.stubEnv('SIGIL_LOCALE', undefined);

		expect(await failingRun('de')).toContain('UNBEKANNT "--porx"');
	});

	it('should render in English when the schema declared none', async () => {
		vi.stubEnv('LANG', undefined);
		vi.stubEnv('LC_ALL', undefined);
		vi.stubEnv('LC_MESSAGES', undefined);
		vi.stubEnv('SIGIL_LOCALE', undefined);

		expect(await failingRun()).toContain('Unknown option "--porx"');
	});

	it('should let the environment beat it', async () => {
		vi.stubEnv('LANG', undefined);
		vi.stubEnv('LC_ALL', undefined);
		vi.stubEnv('LC_MESSAGES', undefined);
		vi.stubEnv('SIGIL_LOCALE', 'en');

		expect(await failingRun('de')).toContain('Unknown option "--porx"');
	});
});

describe('a description written as a thunk', () => {
	/**
	 * Drives `main()` with stdout captured, which is what a help screen has to be
	 * read off.
	 *
	 * @param options - The schema and what argv said.
	 * @returns Everything that was written.
	 */
	async function help(options: {
		argv?: string[];
		locale?: string;
		schema: Record<string, unknown>;
	}): Promise<string> {
		const { main } = await import('../src/index.js');
		const lines: string[] = [];
		const write = vi
			.spyOn(process.stdout, 'write')
			.mockImplementation(((text: string) => (lines.push(text), true)) as never);

		try {
			await main({
				argv: options.argv ?? ['--help'],
				locale: options.locale,
				schema: options.schema,
				settings: { assertCwd: false },
			});
		} finally {
			write.mockRestore();
		}

		return lines.join('');
	}

	/** What the thunks below look up. */
	const screen: Catalog = {
		'a tool for testing': 'ein Werkzeug zum Testen',
		'build the app': 'die App bauen',
		'the entry file': 'die Eintragsdatei',
		'where to put it': 'wohin damit',
	};

	/** A schema whose every description is a thunk over the tag. */
	const thunked = () => ({
		commands: { build: { args: [{ desc: () => __`the entry file`, name: '<entry>' }], run() {} } },
		desc: () => __`a tool for testing`,
		locales: { de: async () => screen },
		name: 'mycli',
		options: { '--where [w]': { desc: () => __`where to put it` } },
	});

	it('should translate the schema`s own description, which a string cannot', async () => {
		// the limitation this closes: a `__` written as a *value* in the schema's
		// object literal is evaluated when the module holding it is imported,
		// which is before `main()` has loaded anything -- so it is always English
		// however well the app is translated
		expect(await help({ locale: 'de', schema: thunked() })).toContain('ein Werkzeug zum Testen');
	});

	it('should translate a root option`s description', async () => {
		expect(await help({ locale: 'de', schema: thunked() })).toContain('wohin damit');
	});

	it('should take a thunk as the option shorthand, which a string already was', async () => {
		// `'--where [w]': 'a description'` is a `desc` in a shorthand, so a thunk
		// there is the same statement written the other way -- and before this it
		// was `Expected option to be an object`, which names nothing
		const screenText = await help({
			locale: 'de',
			schema: {
				locales: { de: async () => screen },
				name: 'mycli',
				options: { '--where [w]': () => __`where to put it` },
			},
		});

		expect(screenText).toContain('wohin damit');
	});

	it('should translate an argument`s description', async () => {
		expect(await help({ argv: ['help', 'build'], locale: 'de', schema: thunked() })).toContain(
			'die Eintragsdatei'
		);
	});

	it('should answer the English it was keyed on with no catalog in effect', async () => {
		const screenText = await help({ schema: thunked() });

		expect(screenText).toContain('a tool for testing');
		expect(screenText).toContain('where to put it');
	});

	it('should read a command`s description as the string the thunk answered', async () => {
		const { initCommand } = await import('../src/parser/command/init-command.js');
		const cmd = await initCommand({ desc: () => 'built once', name: 'build' });

		expect(cmd.desc).toBe('built once');
	});

	it('should resolve it once rather than on every read', async () => {
		// resolved at init rather than through a getter, which is the rule
		// `err.message` already follows: a declaration has one description however
		// many times it is asked, and a lazy one would answer differently after a
		// `setLocale()`
		const { initCommand } = await import('../src/parser/command/init-command.js');
		const thunk = vi.fn(() => 'built once');
		const cmd = await initCommand({ desc: thunk, name: 'build' });

		expect(cmd.desc).toBe('built once');
		expect(cmd.desc).toBe('built once');
		expect(thunk).toHaveBeenCalledTimes(1);
	});

	it('should add no desc key to a declaration that wrote none', async () => {
		// normalizing must not *add* a property the caller never wrote: the copies
		// echo the declaration, and `hidden` always reading back a boolean is the
		// one declared exception
		const { initCommand } = await import('../src/parser/command/init-command.js');
		const { initOption } = await import('../src/parser/option/init-option.js');
		const { initArg } = await import('../src/parser/argument/init-arg.js');

		expect(Object.hasOwn(await initCommand({ name: 'build' }), 'desc')).toBe(false);
		expect(Object.hasOwn(await initOption({ format: '--where' }), 'desc')).toBe(false);
		expect(Object.hasOwn(initArg({ name: '<entry>' }), 'desc')).toBe(false);
	});

	it('should refuse a desc that is neither a string nor a function', async () => {
		// cast because the types already refuse it, which is the point: the runtime
		// guard is for the JavaScript app the types never see
		const { initCommand } = await import('../src/parser/command/init-command.js');

		await expect(initCommand({ desc: 42 as any, name: 'build' })).rejects.toThrow(
			/Expected desc for the "build" command to be a string or a function/
		);
	});

	it('should refuse a thunk that answers something that is not a string', async () => {
		// a description is measured and wrapped, so a non-string one reaches
		// `stringWidth()` several layers from the mistake: before this,
		// `desc: () => 42` was `r.split is not a function` out of the wrapper
		const { initOption } = await import('../src/parser/option/init-option.js');

		await expect(initOption({ desc: (() => 42) as any, format: '--where [w]' })).rejects.toThrow(
			/Expected desc for the "where" option to return a string/
		);
	});
});

describe('a translated screen`s width', () => {
	const ja: Catalog = {
		'(choices: {0})': '(選択肢: {0})',
		'(default: {0})': '(既定値: {0})',
		'<command>': '<コマンド>',
		'Commands:': 'コマンド:',
		'Global options:': 'グローバルオプション:',
		'Options:': 'オプション:',
		'Print the version': 'バージョンを表示する',
		'Show help for a command': 'コマンドのヘルプを表示する',
		'Usage:': '使用法:',
		'[command]': '[コマンド]',
		'[options]': '[オプション]',
	};

	/** The Japanese help screen at one terminal width. */
	async function screen(width: number): Promise<string[]> {
		const { main } = await import('../src/index.js');
		const lines: string[] = [];
		const write = vi
			.spyOn(process.stdout, 'write')
			.mockImplementation(((s: string) => (lines.push(s), true)) as never);

		// the width help lays out in is `terminalWidth()`'s, which reads `COLUMNS`
		// -- `settings.help` is not a knob, which a first version of this test
		// assumed and so measured the same screen five times
		vi.stubEnv('COLUMNS', String(width));

		try {
			await main({
				argv: ['--help'],
				locale: 'ja',
				schema: {
					commands: {
						'a-rather-long-command-name': { desc: '短い説明', run() {} },
						build: { desc: 'アプリをビルドする', run() {} },
					},
					locales: { ja: async () => ja },
					name: '私のツール',
					options: {
						'--mode [モード]': {
							choices: ['開発', '本番'],
							default: '開発',
							desc: 'ビルドモード',
						},
						'--output [ディレクトリ]': {
							desc: '出力ディレクトリ。既定では設定ファイルの値が使われます',
						},
						'--verbose': { desc: '詳細な出力を表示する' },
					},
					version: '1.0.0',
				},
				settings: { assertCwd: false },
			});
		} finally {
			write.mockRestore();
			vi.unstubAllEnvs();
		}

		return lines.join('').split('\n');
	}

	it.each([120, 100, 80, 60, 40])('should fit the terminal at %i columns', async (width) => {
		// the one interaction a cell grid makes easy to get wrong: a CJK character
		// is two columns wide and one code unit long, so a screen measured by
		// `String.length` anywhere comes out over the edge. It fits because every
		// measurement in `help/` goes through `stringWidth()`
		const { stringWidth } = await import('../src/width/index.js');

		for (const line of await screen(width)) {
			expect(stringWidth(line), JSON.stringify(line)).toBeLessThanOrEqual(width);
		}
	});

	it.each([120, 100, 80, 60])(
		'should start a section`s descriptions in one column at %i',
		async (width) => {
			// per section, because `Commands:` and `Options:` legitimately have
			// different label widths -- what has to hold is that within a section every
			// row agrees, measured in display cells rather than code units
			const { stringWidth } = await import('../src/width/index.js');
			const lines = await screen(width);
			const sections: string[][] = [[]];

			for (const line of lines) {
				if (line === '') {
					sections.push([]);
				} else {
					sections[sections.length - 1]!.push(line);
				}
			}

			for (const section of sections) {
				const columns = new Set(
					section
						.map((line) => line.match(/^( {2}\S.*?)( {2,})(?=\S)/))
						.filter((m): m is RegExpMatchArray => m !== null)
						.map((m) => stringWidth(m[0]!))
				);

				expect(columns.size, `${width} cols: ${[...columns].join(', ')}`).toBeLessThan(2);
			}
		}
	);

	it('should wrap a Japanese description rather than overflowing it', async () => {
		// the long `--output` description is wider than its column at 80, so this
		// is the case where the wrap has to count display cells: a continuation
		// line hangs under the description column rather than at the margin
		const lines = await screen(80);
		const at = lines.findIndex((line) => line.includes('--output'));

		expect(lines[at]).toMatch(/^ {2}--output \[ディレクトリ\] {2}出力ディレクトリ/);
		expect(lines[at + 1]).toMatch(/^ {25,}\S/);
	});
});
