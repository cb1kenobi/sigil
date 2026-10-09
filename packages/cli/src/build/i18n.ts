/**
 * Which translatable strings a module declares, and what the catalogs say
 * about them.
 *
 * The English sentence is the catalog key, so there is nothing to invent and
 * nothing to look up: `__`Unknown option "${name}"`` keys
 * `Unknown option "{0}"`, and this walk reads that off the AST. The *key rule*
 * is deliberately not reimplemented here -- `templateKey()` comes from
 * `@ttylabs/sigil/i18n`, so the key this reports and the key the running tag
 * looks up are one function rather than two that have to agree. Two readings of
 * it would report a missing key for a string that works, which is the drift
 * `readRoutes()` is written to avoid for the two route walks.
 *
 * ## Which direction a miss falls
 *
 * Every shape this walk misses is silent: the string still translates at run
 * time, and all that is lost is `sigil check` knowing it exists. So the
 * uncertainty falls the same way `bindings.ts`'s does -- a shape that cannot be
 * read is left alone rather than guessed at, because the cost of declining is a
 * key nobody was told about and the cost of claiming wrongly is a warning about
 * a string that is not there.
 */

import { bindingName, importBindings, reachable, unwrap } from './bindings.ts';
import type { Diagnostic } from './diagnostic.ts';
import { displayPath } from './diagnostic.ts';
import type { DiscoveredApp } from './discover.ts';
import {
	loaderSpecifier,
	objectLiteral,
	outermostWith,
	plainProperty,
	propertyKey,
} from './literals.ts';
import { MODULE_RE, type ParsedModule, parseModule, position } from './parse-module.ts';
import { walk } from './walk.ts';
import { type Catalog, templateKey } from '@ttylabs/sigil/i18n';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type { Expression, TaggedTemplateExpression } from 'oxc-parser';

/** The module the tag and the plural are imported from. */
export const KEY_MODULE = '@ttylabs/sigil/i18n';

/** The tag's export name. */
export const TAG_EXPORT = '__';

/** The plural's export name. */
const PLURAL_EXPORT = '__n';

/** One translatable string a module declares. */
export interface FoundKey {
	/** One-based column of the call. */
	readonly column: number;
	/** The catalog key, which is the English with its slots numbered. */
	readonly key: string;
	/** Whether the catalog entry is a string or an object of plural forms. */
	readonly kind: 'plural' | 'string';
	/** One-based line of the call. */
	readonly line: number;
	/** The English plural form, for a plural. */
	readonly plural?: string;
}

/** Where to look, for a caller that is not looking for sigil's own tag. */
export interface KeysOptions {
	/** The module the tag is imported from. */
	readonly from?: string;
	/** The tag's export name. */
	readonly name?: string;
	/** The plural's export name. */
	readonly plural?: string;
}

/**
 * Reads a string out of an expression, where it is one statically.
 *
 * A plain literal and a template with no substitutions are the same string, so
 * both are read -- which is the rule the static `desc` lift already follows.
 * Anything else is a string this pass cannot know, and is declined.
 *
 * @param node - The expression.
 * @returns The string, or nothing.
 */
function staticString(node: Expression | undefined): string | undefined {
	if (!node) {
		return undefined;
	}

	if (node.type === 'Literal' && typeof node.value === 'string') {
		return node.value;
	}

	if (node.type === 'TemplateLiteral' && node.expressions.length === 0) {
		return node.quasis[0]?.value.cooked ?? node.quasis[0]?.value.raw;
	}

	return undefined;
}

/**
 * The key a tagged template declares.
 *
 * @param parsed - The module.
 * @param node - The tagged template.
 * @returns The key.
 */
function fromTag(parsed: ParsedModule, node: TaggedTemplateExpression): FoundKey {
	const { column, line } = position(parsed.source, node.start);
	const quasis = node.quasi.quasis;

	return {
		column,
		key: templateKey(
			quasis.map((element) => element.value.cooked ?? undefined),
			quasis.map((element) => element.value.raw)
		),
		kind: 'string',
		line,
	};
}

/** What a value written as a `__` tag came to, for the static lift. */
export interface TranslatedKey {
	/**
	 * The catalog key the tag declares.
	 *
	 * Absent when the tag carried an interpolation, which a build cannot read
	 * for the reason it cannot read `desc: greeting()`: the value is the running
	 * app's. The caller reports that rather than guessing, and a reader told
	 * only "computed rather than a string literal" about a `__` tag whose
	 * neighbour lifted fine would have no idea which half was the problem.
	 */
	readonly key?: string;
}

/**
 * The key a value written as a `__` tag declares, when it is one.
 *
 * This is what makes the static lift and a translated description stop being a
 * choice between two. A tagged template is not a string literal, so
 * `` desc: __`Build the app` `` was reported as computed and the command was
 * listed by name alone -- and the key is right there in the source, so there
 * was never anything to compute. What the lift carries is the key; what
 * `generateBin()` emits is `` () => __`key` ``, so the built app renders it
 * through its own catalog rather than baking one language in.
 *
 * The bindings are read per call rather than once per module because
 * `importBindings()` walks the tree for the names the module rebinds, and the
 * overwhelmingly common `desc` is a plain string literal that never reaches
 * here. Which shapes of the tag count, and which are silently missed, is
 * `bindings.ts`'s -- the same answer `findTemplates()` gets.
 *
 * @param parsed - The module.
 * @param node - The value a property held.
 * @returns What it came to, or `undefined` when it is not the tag at all.
 */
export function translatedKey(parsed: ParsedModule, node: Expression): TranslatedKey | undefined {
	const expression = unwrap(node);

	if (expression.type !== 'TaggedTemplateExpression') {
		return undefined;
	}

	const tags = importBindings(parsed, KEY_MODULE, TAG_EXPORT);

	if (!reachable(tags) || bindingName(expression.tag, tags) === undefined) {
		return undefined;
	}

	if (expression.quasi.expressions.length) {
		return {};
	}

	// `templateKey()` rather than the one quasi read off directly, which for a
	// template with no interpolations is the same string: one reader of the key
	// rule, because two that agree today is how the lift comes to bake a key the
	// tag does not look up
	const quasis = expression.quasi.quasis;

	return {
		key: templateKey(
			quasis.map((element) => element.value.cooked ?? undefined),
			quasis.map((element) => element.value.raw)
		),
	};
}

/**
 * Finds every translatable string in an already-parsed module.
 *
 * Separate from `findKeys()` for the reason `templatesIn()` is separate from
 * `findTemplates()`: the build parses a module once and asks it several
 * questions.
 *
 * @param parsed - The module.
 * @param options - Where to look.
 * @returns One entry per call, in source order.
 */
export function keysIn(parsed: ParsedModule, options: KeysOptions = {}): readonly FoundKey[] {
	const from = options.from ?? KEY_MODULE;
	const tags = importBindings(parsed, from, options.name ?? TAG_EXPORT);
	const plurals = importBindings(parsed, from, options.plural ?? PLURAL_EXPORT);

	if (!reachable(tags) && !reachable(plurals)) {
		return [];
	}

	const found: FoundKey[] = [];

	walk(parsed.program, (node) => {
		if (node.type === 'TaggedTemplateExpression') {
			if (bindingName(node.tag, tags) !== undefined) {
				found.push(fromTag(parsed, node));

				// the tag's own interpolations are expressions, and one of those may
				// hold another call -- so the walk carries on rather than claiming
				// the subtree, which is where a nested `__` is found
			}

			return true;
		}

		if (node.type === 'CallExpression' && bindingName(node.callee as Expression, plurals)) {
			const one = staticString(node.arguments[1] as Expression | undefined);
			const other = staticString(node.arguments[2] as Expression | undefined);
			const { column, line } = position(parsed.source, node.start);

			// a singular that is not a literal is a key this pass cannot know, which
			// is declined rather than guessed at -- the string still translates, and
			// what is lost is only `sigil check` knowing it is there
			if (one !== undefined) {
				found.push({ column, key: one, kind: 'plural', line, plural: other });
			}
		}

		return true;
	});

	return found;
}

/**
 * Finds every translatable string in a module's source.
 *
 * @param file - The module's path, which decides how it is parsed.
 * @param source - The source.
 * @param options - Where to look.
 * @returns One entry per call, in source order.
 */
export function findKeys(
	file: string,
	source: string,
	options: KeysOptions = {}
): readonly FoundKey[] {
	return keysIn(parseModule(file, source), options);
}

/** A catalog as the build found it, with where it came from. */
export interface FoundCatalog {
	/** What the loader answered. */
	readonly catalog: Catalog;
	/** The locale it is keyed under in the loader map. */
	readonly locale: string;
}

/** What `checkCatalogs()` compares. */
export interface CatalogCheck {
	/** The catalogs an app declares. */
	readonly catalogs: readonly FoundCatalog[];
	/** The file to report against, which is the app's entry. */
	readonly file: string;
	/** Every key the framework itself declares. */
	readonly framework: readonly string[];
	/** Every key the app's own modules declare. */
	readonly keys: readonly string[];
}

/**
 * Compares the keys that are declared against the keys each catalog carries,
 * both ways.
 *
 * Both ways because each direction is a different mistake and both are silent
 * at run time. A **missing** key is a sentence that will render in English
 * inside an otherwise translated CLI -- which is the right thing to do at run
 * time, and is why the check has to be here: a key that falls back silently
 * *forever* is the failure, not a key that falls back once. An **orphan** key
 * is a catalog that has drifted from the source, usually because the English
 * was reworded -- and a reword shows up as one of each, which is exactly the
 * signal "this string changed" that keying on the English is otherwise accused
 * of losing.
 *
 * ## The framework's keys are counted and the app's are named
 *
 * Which is not a stylistic choice about noise -- the two have different
 * audiences and different jobs. An app's own missing key is a bug in that app's
 * catalog: there are few of them, each is a specific string somebody wrote, and
 * naming it is what makes it fixable. The framework's are a bulk translation
 * job -- "translate sigil's own output", one task, the same strings for every
 * app there is -- so a line per key turns the normal state of
 * a half-finished translation into a wall of warnings, measured at 35 for one
 * catalog that had done its own strings and none of sigil's. A wall is what
 * teaches people to stop reading warnings, and the runtime's own argument
 * applies here too: a partial catalog is the normal state of a translation, so
 * the build must not make it look like a disaster.
 *
 * Both are warnings rather than errors: the app works either way, in English,
 * and refusing to build over an incomplete translation would make a partial
 * catalog worse than no catalog at all.
 *
 * @param input - The keys, the catalogs and the file to report against.
 * @returns One diagnostic per missing app key, one per locale for the
 * framework's, and one per orphan.
 */
export function checkCatalogs(input: CatalogCheck): readonly Diagnostic[] {
	const framework = new Set(input.framework);
	const own = new Set(input.keys);
	const diagnostics: Diagnostic[] = [];
	const file = displayPath(input.file);

	for (const { catalog, locale } of input.catalogs) {
		const carried = new Set(Object.keys(catalog));

		for (const key of own) {
			if (!carried.has(key) && !framework.has(key)) {
				diagnostics.push({
					file,
					message: `"${locale}" has no translation for ${JSON.stringify(key)}; it will render in English`,
					severity: 'warning',
				});
			}
		}

		const missing = [...framework].filter((key) => !carried.has(key));

		if (missing.length) {
			diagnostics.push({
				file,
				message:
					`"${locale}" translates ${framework.size - missing.length} of sigil's own ${framework.size} ` +
					`messages; the other ${missing.length} render in English. ` +
					`SIGIL_KEYS from "@ttylabs/sigil/i18n-keys" is the list.`,
				severity: 'warning',
			});
		}

		for (const key of carried) {
			if (!own.has(key) && !framework.has(key)) {
				diagnostics.push({
					file,
					message: `"${locale}" translates ${JSON.stringify(key)}, which nothing asks for; the English may have been reworded`,
					severity: 'warning',
				});
			}
		}
	}

	return diagnostics;
}

/** What `readAppCatalogs()` found in an app's entry. */
export interface AppCatalogs {
	/** Every catalog it could read. */
	readonly catalogs: readonly FoundCatalog[];
	/** Whether the entry declared `locales` at all. */
	readonly declared: boolean;
	/** Everything worth saying about what it could not read. */
	readonly diagnostics: readonly Diagnostic[];
}

/**
 * Reads an app's catalogs off its entry, without running any of it.
 *
 * Statically, which is the rule the whole build keeps: importing the entry
 * would run the app, so a loader's *literal specifier* is followed to the file
 * instead -- the same thing `moduleSpecifier()` does for a command's `load`,
 * through the same reader. Which is also why the recommended loader body is
 * what it is: `() => import('./de.json', { with: { type: 'json' } })` is the
 * one shape a bundler can split on and this can read.
 *
 * A loader doing anything else is not refused -- it is a function and may do
 * what it likes at run time -- it is simply one this cannot check, and it says
 * so rather than reporting a clean catalog it never opened.
 *
 * @param app - The app.
 * @returns The catalogs, and what could not be read.
 */
export function readAppCatalogs(app: DiscoveredApp): AppCatalogs {
	const parsed = parseModule(app.entry, readFileSync(app.entry, 'utf-8'));
	const diagnostics: Diagnostic[] = [];
	const catalogs: FoundCatalog[] = [];
	const file = displayPath(app.entry);

	const schemas = outermostWith(parsed.program as never, 'locales');

	if (!schemas.length) {
		return { catalogs, declared: false, diagnostics };
	}

	const declared = objectLiteral(plainProperty(schemas[0]!, 'locales')!.value);

	if (!declared) {
		const { column, line } = position(parsed.source, schemas[0]!.start);
		diagnostics.push({
			column,
			file,
			line,
			message:
				'"locales" is computed rather than an object literal, so the catalogs cannot be read at build time and are not checked',
			severity: 'warning',
		});

		return { catalogs, declared: true, diagnostics };
	}

	const entryDir = dirname(app.entry);

	for (const property of declared.properties) {
		if (property.type !== 'Property') {
			continue;
		}

		const locale = propertyKey(property);
		const specifier = loaderSpecifier(property.value as Expression);
		const { column, line } = position(parsed.source, property.start);

		if (locale === undefined) {
			continue;
		}

		if (specifier === undefined) {
			diagnostics.push({
				column,
				file,
				line,
				message: `the loader for "${locale}" is not \`() => import('...')\` of a literal, so its catalog cannot be read at build time and is not checked`,
				severity: 'warning',
			});
			continue;
		}

		const path = resolve(entryDir, specifier);

		try {
			const value: unknown = JSON.parse(readFileSync(path, 'utf-8'));

			if (!value || typeof value !== 'object') {
				throw new Error('not an object');
			}

			catalogs.push({ catalog: value as Catalog, locale });
		} catch (e) {
			diagnostics.push({
				column,
				file,
				line,
				message: `the catalog for "${locale}" could not be read from ${displayPath(path)}: ${(e as Error).message}`,
				severity: 'warning',
			});
		}
	}

	return { catalogs, declared: true, diagnostics };
}

/**
 * Every key an app's own modules declare.
 *
 * The walk the style shaker takes, with its loop guard and its `node_modules`
 * exclusion -- somebody else's source holds keys that are not this app's to
 * translate, and a symlink pointing back up the tree is read once rather than
 * once per level.
 *
 * A previous build's **output** is not excluded, and that is a decision rather
 * than an oversight: `--out` is resolved after `inspect()` has run, so there is
 * no directory to pass, and what reading one costs is bounded. A bundle that
 * inlined the runtime holds no import of `@ttylabs/sigil/i18n` for
 * `importBindings()` to match, so it contributes nothing at all; one built
 * `--external @ttylabs/sigil` keeps the import and contributes the app's *own*
 * keys, which are the keys being collected anyway. The one thing it can change
 * is to suppress an orphan warning for a string that has since been deleted,
 * which is the safe direction for a check to be wrong in.
 *
 * @param root - The app's root.
 * @returns The keys, sorted.
 */
export function appKeys(root: string): readonly string[] {
	const keys = new Set<string>();
	const entered = new Set<string>();

	const visit = (dir: string): void => {
		if (entered.has(resolve(dir))) {
			return;
		}
		entered.add(resolve(dir));

		let entries;
		try {
			entries = readdirSync(dir, { withFileTypes: true });
		} catch {
			return;
		}

		for (const entry of entries) {
			const path = join(dir, entry.name);

			if (entry.isDirectory()) {
				// `node_modules` is somebody else's source, and its keys are not this
				// app's to translate
				if (entry.name !== 'node_modules' && !entry.name.startsWith('.')) {
					visit(path);
				}
			} else if (MODULE_RE.test(entry.name)) {
				let source;
				try {
					source = readFileSync(path, 'utf-8');
				} catch {
					continue;
				}

				// the substring filter the template pass takes, for its reason: most
				// modules hold no translatable string and are not worth parsing
				if (!source.includes('__`') && !source.includes('__n(')) {
					continue;
				}

				try {
					for (const found of keysIn(parseModule(path, source))) {
						keys.add(found.key);
					}
				} catch {
					// a module that does not parse is rolldown's to report, and a key
					// this did not find is a key nobody is told about rather than a
					// wrong answer
				}
			}
		}
	};

	visit(root);

	return [...keys].sort();
}
