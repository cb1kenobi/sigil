/**
 * Translatable strings, for the framework's own output and for an app's.
 *
 * The English sentence *is* the key. `__`Unknown option "${name}"`` looks up
 * `Unknown option "{0}"` and falls back to the sentence it was handed, so the
 * fallback is in the source rather than in a catalog and is always a correct
 * sentence. There are no dotted key names to invent, no second copy of the
 * English to keep in agreement with the first, and two sites that say the same
 * thing share one entry rather than two -- `Invalid number: {0}` is thrown from
 * two places in `transformValue()` and is one key here.
 *
 * A tag rather than a call because the key falls out of the literal parts and
 * the values arrive separately, which no other spelling gives for free. The
 * slots are numbered rather than named, because `${v}` hands over the value and
 * not the name `v` -- and numbered is still reorderable, which is the whole
 * reason interpolation beats concatenation: a translator writes
 * `Für {1} ist "{0}" ungültig` and the arguments stay where they were.
 * `%s`-style sequential consumption is what cannot be reordered, which is why
 * this is not printf.
 *
 * It renders at the call site, so an error's `.message` is in the user's
 * locale. That is what AGENTS.md already says a parser error is -- "they are
 * what the user sees" -- and it is what makes this one mechanism for errors and
 * for help chrome rather than two.
 *
 * This module imports nothing but the debug logger, which is on the root
 * entry's path already: `renderError()` is reached by every app that answers
 * `--version`, and a resolver that dragged anything behind it would tax all of
 * them.
 */

import debug from '../debug/index.js';

const { log } = debug('sigil:i18n');

/**
 * The plural categories CLDR defines. A locale uses some subset: English has
 * `one` and `other`, Polish `one`/`few`/`many`/`other`, Arabic all six.
 */
export type PluralCategory = 'zero' | 'one' | 'two' | 'few' | 'many' | 'other';

/**
 * A plural entry: one string per category the target locale uses. `other` is
 * the only one every locale has, so it is the one that is required.
 */
export type PluralForms = Partial<Record<PluralCategory, string>> & { other: string };

/**
 * A catalog is flat and keyed by the English sentence, with `{0}`, `{1}` where
 * the values go. Flat rather than nested because a lookup is then a property
 * access rather than a path walk, and the fallback needs no merge rule.
 */
export type Catalog = Record<string, string | PluralForms>;

/**
 * A locale's catalog, fetched when something asks for it.
 *
 * The shape `Command.load` already is, and for the same reason: a literal
 * specifier inside a dynamic import is the one thing a bundler can see, follow
 * and split on, so `sigil build` gives each locale a chunk of its own and an
 * app shipping twelve ships twelve and loads one.
 *
 * `import('./de.json', { with: { type: 'json' } })` is the cheapest body there
 * is -- node's own JSON module loader does not pull userland `node:fs` in -- but
 * a loader is a function and may do anything.
 */
export type LocaleLoader = () => Promise<Catalog | { default: Catalog }>;

/** The loader map an app declares as `Schema.locales`. */
export type Locales = Record<string, LocaleLoader>;

/**
 * The catalog in effect, or nothing at all for English.
 *
 * Nothing at all rather than an empty object, because it is what the fast path
 * in `__()` tests: with no catalog there is no key to build and no lookup to
 * make, so the English path allocates nothing beyond the string it returns.
 */
let active: Catalog | undefined;

/** The tag `active` was loaded for, for `locale()` to answer with. */
let current: string | undefined;

/** The loader map, kept so that `setLocale()` has something to resolve against. */
let registered: Locales | undefined;

/**
 * The plural selector for `current`, built on first use.
 *
 * `Intl.PluralRules` is the only `Intl` constructor cheap enough to be here --
 * measured at +0.06 to +0.39 ms in a cold process, because it does not
 * initialize ICU, where `Intl.NumberFormat` is +6 ms. It is still built lazily
 * and only when a catalog is active, so the English path constructs no `Intl`
 * at all and `--version` stays free of it.
 */
let rules: Intl.PluralRules | undefined;

/**
 * `{{`, `}}` and a numbered slot, in one pass.
 *
 * One regex rather than three passes, so that `{{0}}` cannot be unescaped into
 * `{0}` and then interpolated. Module scope because it carries the `g` flag and
 * therefore `lastIndex`, which `replace()` resets but a fresh object per call
 * would not be worth building.
 */
const slotRE = /\{\{|\}\}|\{(\d+)\}/g;

/**
 * Interpolates `{0}`-style slots, and unescapes `{{` and `}}`.
 *
 * A slot whose index names no value is left exactly as it was, which is what
 * makes a literal `{0}` in a string with no values safe without anybody having
 * to escape it. `{{` is the escape for the cases that remain.
 *
 * @param text - The string to interpolate.
 * @param values - The values, in the order they were interpolated.
 * @returns The interpolated string.
 */
function fill(text: string, values: readonly unknown[]): string {
	if (!values.length && !text.includes('{')) {
		return text;
	}

	return text.replace(slotRE, (match, index: string | undefined) => {
		if (index === undefined) {
			return match === '{{' ? '{' : '}';
		}

		const at = Number(index);

		return at < values.length ? String(values[at]) : match;
	});
}

/**
 * Builds the catalog key from a template's literal parts.
 *
 * The cooked values rather than the raw ones, so the key is the sentence rather
 * than its source spelling: a `\n` written in the source is a newline in the
 * key, which is what a translator editing JSON expects to see. A cooked value
 * is `undefined` only for an escape that is invalid in an untagged template,
 * which a tagged one is allowed to carry -- the raw text is the honest answer
 * there, and it is a shape nothing in this repository writes.
 *
 * Exported, and taking the parts rather than a `TemplateStringsArray`, because
 * there are two readers of this rule and they have to agree exactly: the tag
 * below is handed the parts by the engine, and the toolchain's extractor reads
 * them off an AST so that `sigil check` can say which keys an app's catalogs
 * are missing. A second implementation of "what is the key" would report a
 * missing key for a string that works, which is the drift `readRoutes()` and
 * `cutAt()` are each written to avoid.
 *
 * @param cooked - The literal parts, as the template evaluates them.
 * @param raw - The same parts unprocessed, for a cooked value that is
 * `undefined`.
 * @returns The key.
 */
export function templateKey(
	cooked: readonly (string | undefined)[],
	raw: readonly string[]
): string {
	let key = cooked[0] ?? raw[0] ?? '';

	for (let i = 1; i < cooked.length; i++) {
		key += `{${i - 1}}${cooked[i] ?? raw[i] ?? ''}`;
	}

	return key;
}

/**
 * The key for a tagged template, which is `templateKey()` of its own parts.
 *
 * @param strings - The literal parts, supplied by the tag.
 * @returns The key.
 */
function keyOf(strings: TemplateStringsArray): string {
	return templateKey(strings, strings.raw);
}

/**
 * Zips a tagged template back together, which is what English is.
 *
 * Deliberately not `fill(keyOf(strings), values)`: that would build a key
 * nobody is going to look up and then interpolate slots back out of it, and it
 * would read a literal `{0}` in the source as a slot. This is the path every
 * run with no catalog takes.
 *
 * @param strings - The literal parts.
 * @param values - The interpolated values.
 * @returns The English string.
 */
function zip(strings: TemplateStringsArray, values: readonly unknown[]): string {
	// the raw fallback is `templateKey()`'s, for its reason and so that the two
	// cannot disagree about what a part *is*: a cooked value is `undefined` only
	// for an escape an untagged template would refuse, and losing that part of
	// the English would be the one place this returns less than it was given
	let out = strings[0] ?? strings.raw[0] ?? '';

	for (let i = 1; i < strings.length; i++) {
		out += `${String(values[i - 1])}${strings[i] ?? strings.raw[i] ?? ''}`;
	}

	return out;
}

/**
 * Reads a translation for a key, logging a miss.
 *
 * A miss is logged only when a catalog is *active*, because with no catalog
 * every lookup is a miss and the English path has nothing to report. The log is
 * a diagnostic for whoever is writing a catalog and deliberately not the check:
 * a line nobody turned on is not a guard, and the guard is `sigil check`
 * comparing the key sets both ways.
 *
 * @param key - The catalog key.
 * @returns The entry, or nothing.
 */
function lookup(key: string): string | PluralForms | undefined {
	const entry = active?.[key];

	if (entry === undefined) {
		log(`missing key for ${current}: ${JSON.stringify(key)}`);
	}

	return entry;
}

/**
 * Translates a sentence, keyed on its English.
 *
 * ```ts
 * throw new Error(__`Unknown option "${subject}"`);
 * ```
 *
 * The key is `Unknown option "{0}"`. With no catalog loaded -- which is every
 * English run -- no key is built at all and the template is simply zipped back
 * together.
 *
 * @param strings - The literal parts, supplied by the tag.
 * @param values - The interpolated values, supplied by the tag.
 * @returns The translated string, or the English one.
 */
export function __(strings: TemplateStringsArray, ...values: unknown[]): string {
	// a declared fast path rather than a guard: without it the key is built, the
	// lookup misses, and the branch below answers with this same `zip()` -- so no
	// answer changes and nothing can be written that fails when it goes. What it
	// buys is that every run of every app with no translations builds no key at
	// all, which is the path this whole design is arranged around
	if (active === undefined) {
		return zip(strings, values);
	}

	const entry = lookup(keyOf(strings));

	// a catalog that answers a plural object where the source asked for a string
	// is a catalog that has drifted from the source, which is `sigil check`'s to
	// report -- here it falls back, because what a wrong shape must not do is
	// replace a working sentence with `[object Object]`
	if (typeof entry !== 'string') {
		if (entry !== undefined) {
			log(`expected a string for ${JSON.stringify(keyOf(strings))}`);
		}

		return zip(strings, values);
	}

	return fill(entry, values);
}

/**
 * Translates a sentence that has a plural, keyed on its singular English.
 *
 * ```ts
 * __n(aliases.length, 'Alias:', 'Aliases:')
 * __n(n, '{0} file changed', '{0} files changed')
 * ```
 *
 * The count is `{0}` and anything else passed is `{1}` onwards. A call rather
 * than a tag because a plural needs two English forms and a template carries
 * one -- the same split gettext has between `__()` and `__n()`.
 *
 * The catalog entry is an object of categories rather than a mini-syntax:
 * `{ one: 'Alias:', other: 'Aliases:' }`, selected with `Intl.PluralRules`, so
 * Polish's four categories and Arabic's six come free rather than needing a
 * grammar written for them. English selects with `count === 1`, which is why
 * no `Intl` is constructed unless a catalog is in play.
 *
 * @param count - What is being counted, and `{0}`.
 * @param one - The English singular, and the catalog key.
 * @param other - The English plural.
 * @param values - Any further values, from `{1}`.
 * @returns The translated string, or the English one.
 */
export function __n(count: number, one: string, other: string, ...values: unknown[]): string {
	const args = [count, ...values];
	const english = (): string => fill(count === 1 ? one : other, args);

	if (active === undefined) {
		return english();
	}

	const entry = lookup(one);

	if (entry === undefined) {
		return english();
	}

	// a plain string where a plural was asked for is taken rather than refused:
	// a language with one form for every count -- Japanese, Chinese, Korean --
	// has nothing an object would say that the string does not
	if (typeof entry === 'string') {
		return fill(entry, args);
	}

	rules ??= new Intl.PluralRules(current);

	const form = entry[rules.select(count) as PluralCategory] ?? entry.other;

	return typeof form === 'string' ? fill(form, args) : english();
}

/**
 * The keys a yes-or-no prompt accepts, and the hint they are drawn as.
 *
 * Both halves of one answer, because the whole point is that they cannot come
 * apart: a hint translated on its own gives a prompt that displays `(J/n)` and
 * ignores `j`, which is a hint that parses and lies.
 */
/**
 * The pair English falls back to, which is also the catalog key for it.
 *
 * The same string in two roles rather than one copy too many: at the call site
 * it is the key -- the English *is* the key -- and here it is the floor a
 * malformed entry lands on. A refusal has to name some vocabulary, and this is
 * the one every user of every locale can rely on.
 */
const ENGLISH_PAIR = 'y/n';

export interface ConfirmKeys {
	/** The hint, `(Y/n)` in English, with the default's half capitalized. */
	hint: string;
	/** Every key that means no, lowercased. */
	no: readonly string[];
	/** Every key that means yes, lowercased. */
	yes: readonly string[];
}

/**
 * The first code point of a string, lowercased, or nothing for an empty one.
 *
 * By code point rather than by code unit, so an astral character is one key
 * rather than half a surrogate pair -- the rule `highlightRuns()` already keeps.
 * `toLowerCase()` rather than the locale variant, because the locale one reads
 * the process locale and in Turkish and Azeri `i` cases to `İ`: a key is
 * compared and never used to index, so a result longer than one code point is
 * harmless where a locale-dependent one is a key that stops matching on
 * somebody's machine and nowhere else.
 *
 * @param half - One side of the pair.
 * @returns The key, or an empty string.
 */
function keyOfHalf(half: string): string {
	return ([...half][0] ?? '').toLowerCase();
}

/**
 * Builds the hint and the accepted keys from the two halves of a pair.
 *
 * One builder rather than one per path, so that the English fallback and a
 * translated entry cannot produce differently-shaped hints -- and so that the
 * hint is *rendered from* the keys rather than parsed back out of a string,
 * which is what makes "the hint is the keys" true by construction rather than
 * by agreement.
 *
 * **The hint is authoritative and English is additive.** `y` and `n` are
 * accepted on top of whatever the entry named, and each is dropped where it
 * would contradict the entry: a romanized `n/a` has `n` meaning *yes*, as the
 * user was told, so English `n` is refused rather than giving one keypress two
 * meanings. That precedence is forced by the hint being the thing on screen.
 *
 * @param yesHalf - The half that means yes, as written.
 * @param noHalf - The half that means no, as written.
 * @param fallback - Whether yes is the default, which is the half capitalized.
 * @returns The hint and the keys.
 */
function pairKeys(yesHalf: string, noHalf: string, fallback: boolean): ConfirmKeys {
	const yes = keyOfHalf(yesHalf);
	const no = keyOfHalf(noHalf);
	const yesKeys = [yes];
	const noKeys = [no];

	if (yes !== 'y' && no !== 'y') {
		yesKeys.push('y');
	}
	if (no !== 'n' && yes !== 'n') {
		noKeys.push('n');
	}

	return {
		hint: `(${fallback ? capitalize(yesHalf) : yesHalf}/${fallback ? noHalf : capitalize(noHalf)})`,
		no: noKeys,
		yes: yesKeys,
	};
}

/**
 * The first code point of a string upper-cased, which is how the default shows.
 *
 * By code point for `keyOfHalf()`'s reason, and `toUpperCase()` for its other
 * one. A mapping that answers more than one character -- `ß` is `SS` -- is a
 * display label rather than a key, so it is let through.
 *
 * @param half - One side of the pair.
 * @returns The half with its first character upper-cased.
 */
function capitalize(half: string): string {
	const [first, ...rest] = [...half];

	return first === undefined ? half : first.toUpperCase() + rest.join('');
}

/**
 * The accepted keys and the hint for a yes-or-no prompt, read out of a pair.
 *
 * The catalog entry is `y/n` -- the two keys and nothing else -- and the parens
 * and the capital are this function's. Which settles the thing a hint and a
 * pair of key literals would otherwise get wrong in opposite directions: there
 * is **one** entry rather than three, so a translator has no second place to
 * disagree with themselves, and the hint is built from the keys rather than
 * read back out of a sentence.
 *
 * The *lookup* is the caller's -- `confirmKeys(__`y/n`, fallback)` -- for two
 * reasons that both point the same way. It is where every other `__` in this
 * repository is, which is what "it renders at the call site" means; and the key
 * generator deliberately skips this module, because the `__` here is a local
 * declaration rather than an import binding and `importBindings()` has nothing
 * to match -- so a tag written here is a key `SIGIL_KEYS` would not carry and
 * `sigil check` would report an app's own translation of it as an orphan.
 *
 * The *parsing* is here, because this is the module that already decides whether
 * a catalog entry is usable and falls back when it is not: `__()` does exactly
 * that for an entry of the wrong shape, through the same logger. `prompt.ts`
 * could not, being a `sigil add` entry that may import only what the package
 * publishes -- `src/debug/` has no subpath, so a parse living there could not
 * say when it had refused an entry. Exported from this barrel rather than
 * written into the root entry's path, so an app that answers `--version` shakes
 * it out.
 *
 * What is **not** translatable is the punctuation and the order: a locale that
 * shows no first, or wants fullwidth parens, cannot say so. Making those
 * translatable means parsing a sentence to find the keys again, which is the
 * thing this shape exists to avoid.
 *
 * @param pair - The entry, which is `__`y/n`` at the call site.
 * @param fallback - Whether yes is the default, which is the half capitalized.
 * @returns The hint and the keys.
 */
export function confirmKeys(pair: string, fallback: boolean): ConfirmKeys {
	const halves = pair.split('/').map((half) => half.trim());
	const [yesHalf = '', noHalf = ''] = halves;

	// refused rather than guessed at, which is the rule a data type already
	// follows: two halves or it is not a pair, each has to name a key, and the
	// two keys have to differ or one keypress means both answers. English stands
	// and says so, because a hint nobody can read is worse than an English one
	if (
		halves.length !== 2 ||
		keyOfHalf(yesHalf) === '' ||
		keyOfHalf(noHalf) === '' ||
		keyOfHalf(yesHalf) === keyOfHalf(noHalf)
	) {
		if (active !== undefined) {
			log(
				`expected two distinct keys for ${JSON.stringify(ENGLISH_PAIR)}, got ${JSON.stringify(pair)}`
			);
		}

		return pairKeys(...(ENGLISH_PAIR.split('/') as [string, string]), fallback);
	}

	return pairKeys(yesHalf, noHalf, fallback);
}

/**
 * Turns whatever is in the environment into a BCP 47 tag, or nothing.
 *
 * `Intl` refuses every POSIX form there is -- `en_US.UTF-8`, `pt_BR`,
 * `de_DE@euro` and `C` all throw `RangeError` -- so "lean on
 * `Intl.getCanonicalLocales`" is not an option that exists and this is done by
 * hand. Two traps it has to know: `POSIX` canonicalizes to `posix` rather than
 * throwing, so a resolver that trusts the answer reads the C locale as a
 * language; and `nonsense` canonicalizes to `nonsense`, because
 * canonicalization checks syntax and not existence -- which is harmless, since
 * a tag no loader is keyed by simply reads as English.
 *
 * @param raw - An environment value, or a tag an app named.
 * @returns A canonical tag, or nothing for English.
 */
export function normalizeLocale(raw: string | undefined): string | undefined {
	if (!raw) {
		return;
	}

	// `LANGUAGE` is a `:`-separated preference list and the others are not, so
	// taking the first entry is right for all of them
	const first = raw.split(':')[0].trim();

	// `de_DE.UTF-8@euro` is a tag, a codeset and a modifier; only the tag is a
	// question about language
	const tag = first.replace(/[@.].*$/, '').replace(/_/g, '-');

	// the C locale is this feature's `NO_COLOR`: it is what CI generally holds,
	// and English is the right answer for a CI log. Asked before `Intl`, which
	// would throw for `C` and quietly answer `posix` for `POSIX`
	if (!tag || /^(c|posix)$/i.test(tag)) {
		return;
	}

	try {
		return Intl.getCanonicalLocales(tag)[0];
	} catch {
		// a value nobody meant as a locale is not a decision, which is the rule an
		// empty environment variable already follows in the parser
		return;
	}
}

/**
 * Resolves the locale from an app's own answer and the environment.
 *
 * `AppOptions.locale`, then `SIGIL_LOCALE`, then `LC_ALL`, then `LC_MESSAGES`,
 * then `LANG`, then `Schema.defaultLocale`, then English --
 * `SIGIL_COLOR_SCHEME`'s chain, with its reasons. Each step down is less
 * specific knowledge about the same question. The app is on top because a named
 * locale is a statement about its output rather than a guess at the terminal,
 * and the user is next because what they are correcting is the detection.
 * `LC_ALL` over `LC_MESSAGES` over `LANG` is POSIX's own order, and messages are
 * what this is about.
 *
 * `Schema.defaultLocale` is at the **bottom**, under every environment variable
 * and above English, which is the one place a fallback can go: an app saying
 * "ship in German unless the machine asks otherwise" is a weaker statement than
 * the machine's own `LANG`, and a stronger one than the English in the source.
 * That is also why it is a second property rather than a second writer of
 * `AppOptions.locale` -- two precedences under one name is how a default comes
 * to override the user.
 *
 * `SIGIL_LOCALE` sits above `LC_ALL` because it is the user correcting *this
 * tool* where `LC_ALL` is the system's general answer -- the same place
 * `SIGIL_COLOR_SCHEME` sits relative to `COLORFGBG`. Namespaced because there is
 * no cross-tool convention for forcing a CLI's message locale the way
 * `NO_COLOR` is one for colour, so an unnamespaced name would claim a standard
 * that does not exist.
 *
 * `Intl.DateTimeFormat().resolvedOptions().locale` is deliberately not asked:
 * it reads the *host* rather than the environment, and answers `en-US` on a
 * machine with `LANG=C.UTF-8` set.
 *
 * @param env - The environment to read.
 * @param explicit - What the app named, which outranks all of it.
 * @param fallback - The app's default, which only answers when nothing else did.
 * @returns A canonical tag, or nothing for English.
 */
export function resolveLocale(
	env: Record<string, string | undefined> = {},
	explicit?: string,
	fallback?: string
): string | undefined {
	for (const raw of [explicit, env.SIGIL_LOCALE, env.LC_ALL, env.LC_MESSAGES, env.LANG, fallback]) {
		if (raw?.trim()) {
			return normalizeLocale(raw);
		}
	}

	return undefined;
}

/**
 * The tags to try, most specific first.
 *
 * `de-DE` is `de-DE` then `de`; `zh-Hans-CN` is `zh-Hans-CN`, `zh-Hans`, `zh`.
 * So an app that ships one `zh` catalog serves every Chinese locale there is,
 * and one that ships `pt-BR` and `pt` serves Brazil from the first and Portugal
 * from the second.
 *
 * @param tag - A canonical tag.
 * @returns The chain, most specific first.
 */
export function localeChain(tag: string): string[] {
	const chain: string[] = [];

	for (let at: string = tag; at; at = at.slice(0, at.lastIndexOf('-'))) {
		chain.push(at);

		if (!at.includes('-')) {
			break;
		}
	}

	return chain;
}

/**
 * Finds the loader for a tag, walking the fallback chain.
 *
 * Both sides are normalized before they are compared, because a loader map is
 * written by hand: an app that keys one `de_DE` or `de-de` means `de-DE`, and
 * matching the spelling rather than the tag would leave it unreachable with
 * nothing to say so.
 *
 * @param locales - The loader map.
 * @param tag - The canonical tag to serve.
 * @returns The matching tag and its loader, or nothing.
 */
function findLoader(
	locales: Locales,
	tag: string
): { loader: LocaleLoader; tag: string } | undefined {
	const byTag = new Map<string, LocaleLoader>();

	for (const [key, loader] of Object.entries(locales)) {
		const normal = normalizeLocale(key);

		// first spelling wins, so a map with both `de` and `de_DE` keeps the one
		// that was written first rather than depending on key order twice over
		if (normal && !byTag.has(normal)) {
			byTag.set(normal, loader);
		}
	}

	for (const candidate of localeChain(tag)) {
		const loader = byTag.get(candidate);

		if (loader) {
			return { loader, tag: candidate };
		}
	}

	return undefined;
}

/**
 * Reads a catalog out of whatever a loader answered.
 *
 * A JSON module import answers `{ default: … }` and a hand-written loader
 * answers the catalog, so both are taken -- the second is what
 * `{ default: Catalog }` in the type is for.
 *
 * @param answer - What the loader resolved with.
 * @returns The catalog, or nothing when it is not one.
 */
function readCatalog(answer: unknown): Catalog | undefined {
	const value =
		answer && typeof answer === 'object' && 'default' in answer
			? (answer as { default: unknown }).default
			: answer;

	return value && typeof value === 'object' ? (value as Catalog) : undefined;
}

/**
 * Puts a locale into effect, loading its catalog.
 *
 * A loader that throws, or that answers something that is not a catalog, leaves
 * English in effect and says so through `sigil:i18n`. That is the rule a
 * missing key already follows one step along: what a broken translation must
 * not do is fail a parse, because the English it falls back to is a working
 * message and the user is already being told something went wrong.
 *
 * @param tag - A canonical tag, or nothing for English.
 */
async function use(tag: string | undefined): Promise<void> {
	active = undefined;
	current = tag;
	rules = undefined;

	if (!tag || !registered) {
		return;
	}

	const found = findLoader(registered, tag);

	if (!found) {
		log(`no catalog for ${tag}`);
		return;
	}

	try {
		active = readCatalog(await found.loader());
		current = found.tag;

		if (!active) {
			log(`loader for ${found.tag} answered no catalog`);
		}
	} catch (err) {
		log(`loader for ${found.tag} threw: ${String(err)}`);
	}
}

/**
 * Resolves the locale and loads its catalog, once, before anything is printed.
 *
 * Called by `main()` ahead of `parse()`, because `__()` renders where it is
 * called and a parse error is the first thing that can be printed. A `parse()`
 * reached directly, as a library, has had no such call and renders English --
 * which is the rule `renderToString()` already follows by never going and
 * asking for a colour scheme.
 *
 * @param locales - The loader map, kept for `setLocale()`.
 * @param env - The environment to resolve from.
 * @param explicit - What the app named, which outranks the environment.
 * @param fallback - `Schema.defaultLocale`, which the environment outranks.
 */
export async function loadCatalog(
	locales: Locales | undefined,
	env: Record<string, string | undefined> = {},
	explicit?: string,
	fallback?: string
): Promise<void> {
	registered = locales;

	// an app with no catalogs has nothing to resolve a locale *for*, which is
	// most apps -- so the common path never asks `Intl.getCanonicalLocales()`
	// whether `LANG` names a language. A declared fast path rather than a guard:
	// `use(undefined)` is what it skips to, and the only thing it changes is
	// that `locale()` answers nothing, which is the right answer when English is
	// what is in effect
	//
	// a `defaultLocale` is not a catalog, so it does not open this gate: an app
	// that names one and ships none has nothing to load either
	await use(locales ? resolveLocale(env, explicit, fallback) : undefined);
}

/**
 * Changes the locale after the app has started, which is what a config file is
 * for.
 *
 * Asynchronous because it loads a catalog. What it cannot do is reach back: a
 * string is translated where it is built, so a locale set here does not change
 * one already rendered -- which means a **parse error** always uses the
 * environment's locale, because the parse failed before the app read its
 * config, and so does `--help`, which is printed before `run()`. That is the
 * right answer rather than a gap: an app that never got to read its config
 * never had an answer to offer.
 *
 * `undefined` puts English back, which is also how a test clears one.
 *
 * @param tag - A locale tag, in any spelling, or nothing for English.
 */
export async function setLocale(tag: string | undefined): Promise<void> {
	await use(normalizeLocale(tag));
}

/**
 * The locale that was resolved, or nothing where English was asked for.
 *
 * Where a catalog was found this is the tag it was found *under* rather than
 * the one that was asked for, so `LANG=de_AT` served by a `de` catalog answers
 * `de` -- which is what `Intl.PluralRules` is constructed with, and is the one
 * reader that has to agree with the catalog rather than with the request.
 *
 * A tag here does **not** mean a catalog is in effect: `LANG=de` with no `de`
 * loader resolves `de` and renders English, and an app that declared no
 * `locales` at all resolves nothing, because there was no question to answer.
 *
 * @returns The tag, or nothing.
 */
export function locale(): string | undefined {
	return current;
}
