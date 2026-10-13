/**
 * `sigil.json`: the one file the toolchain configures itself from.
 *
 * ## Why one file, and why not a `.ts` one
 *
 * There was already a `sigil.json` -- `sigil add` reads where ejected
 * components land, and `sigil new` writes it -- so the question a build option
 * raised was never "config file or flags" but "this file or a second one". Two
 * files answering for one tool is worse than a long script line.
 *
 * A `next.config.ts`-shaped config was the other candidate and was left alone
 * for now. It has to be *executed*, and everything else this build does is
 * reading: the app's entry is parsed rather than imported precisely so that an
 * app which opens a connection at module scope does not do it during a build.
 * Running app-adjacent code would be a new surface, and none of the options
 * here needs computing -- every one of them is a literal. The day one of them
 * does is the day to revisit it, which is the rule `which` waited on.
 *
 * ## A flag beats the file
 *
 * The file says what this app is always built with; a flag says what this one
 * invocation wants. So `--no-sourcemap` on the command line wins over
 * `"sourcemap": true` in the file, and the file wins over the built-in default.
 */

import { createConfigSync, json, type ConfigSchema } from '@ttylabs/sigil/config';
import { isAbsolute, join } from 'node:path';

/** The name of the config file, which is the shadcn answer to the same question. */
export const CONFIG_FILE = 'sigil.json';

/** What `sigil build` reads from the config. */
export interface BuildConfig {
	/**
	 * Packages to import rather than inline.
	 *
	 * A native binding leaves no choice -- nothing inlines a `.node` -- and it
	 * is the app saying its bundle is not self-contained, so it belongs beside
	 * the app rather than in whoever happens to be typing the command.
	 */
	readonly external?: readonly string[];
	/** What the executable is called, when the manifest's `bin` does not say. */
	readonly name?: string;
	/** Where the bundle goes, relative to the app. */
	readonly out?: string;
	/**
	 * Utility classes to keep whatever the app's source says.
	 *
	 * The escape hatch style shaking needs and cannot do without: the scan is
	 * evidence rather than proof, so a class assembled out of values that never
	 * appear as literals in the source -- read from a config file, joined out of
	 * an array that came from somewhere else -- leaves nothing behind and its
	 * rule is dropped. This is how to say it anyway.
	 */
	readonly safelist?: readonly string[];
	/**
	 * Whether to shake the utility sheet. On by default.
	 *
	 * On by default because the sheet is opt-in already -- an app only pays for
	 * it by calling `utilitySheet()` -- and because a build that quietly kept
	 * everything is an optimization nobody notices is gone. Off is the blunt
	 * answer for an app that would otherwise need a long safelist.
	 */
	readonly shake?: boolean;
	/** Whether to write sourcemaps. */
	readonly sourcemap?: boolean;
}

/** `sigil.json`, as it is on disk. */
export interface SigilConfig {
	readonly build?: BuildConfig;
	/** Where ejected components land, relative to the app. */
	readonly components?: string;
	/**
	 * The locale the app falls back on when nothing else named one.
	 *
	 * Top level rather than under `build`, because it is a fact about the app
	 * rather than a bundler knob: `"build": { "locale": ... }` would read as
	 * *baking* a language in, which is a different thing that is deliberately
	 * not done. What `sigil build` does with it is write `defaultLocale` into
	 * the schema it generates, beside the version, because the runtime cannot
	 * read this file -- reading one at startup is what `Schema.locales` being a
	 * map rather than a directory convention exists to avoid.
	 *
	 * It is the bottom of the locale chain: `AppOptions.locale`, `SIGIL_LOCALE`,
	 * `LC_ALL`, `LC_MESSAGES` and `LANG` all beat it, and it beats English. So
	 * it says what the app ships in rather than overriding the user.
	 *
	 * Not validated as a locale tag here, because the runtime normalizes it and
	 * a tag no catalog is keyed by already reads as English -- a second grammar
	 * for BCP 47 in the toolchain would be one that disagrees with `Intl`.
	 */
	readonly locale?: string;
}

/** The fields `build` may hold, as the one list `readSection()` picks by. */
const FIELDS = ['external', 'name', 'out', 'safelist', 'shake', 'sourcemap'] as const;

/**
 * What the file may hold, in the parser's own type vocabulary.
 *
 * The acceptance test for `@ttylabs/sigil/config`, which is why it is a schema
 * rather than the hand-written reader it replaces: the types, the coercion and
 * the choices are the same ones an option declaration gets, so `"shake": "off"`
 * and `--no-shake` and `SHAKE=off` cannot come to mean three different things.
 *
 * What stays here is what the schema's vocabulary cannot say, and it is four
 * things rather than one: that `components` is relative to the app; that a name
 * or a list entry is non-empty, which `type: 'string'` accepts and is right to,
 * because `""` is an empty string somebody chose; that `build` is an object,
 * which a schema declaring settings by dotted path has no nested shape to say;
 * and which keys under `build` are `BuildConfig`'s, because the merged view
 * holds whatever the file holds and passing it through would hand back an object
 * with keys the type does not declare. The honest split: the schema does types,
 * and the semantic checks are this tool's own.
 */
const SCHEMA: ConfigSchema = {
	'build.external': { multiple: true, type: 'string' },
	'build.name': { type: 'string' },
	'build.out': { type: 'string' },
	'build.safelist': { multiple: true, type: 'string' },
	'build.shake': { type: 'bool' },
	'build.sourcemap': { type: 'bool' },
	components: { type: 'string' },
	locale: { type: 'string' },
};

/**
 * Reads an app's `sigil.json`, if it has one.
 *
 * Validated on the way out rather than trusted: a config file is source the app
 * wrote, and an `"external": "rolldown"` where an array was meant should say so
 * here rather than reach rolldown as a string and mean something else.
 *
 * ## What the migration changed, and what it did not
 *
 * A file that is not there, one holding nothing, and one holding valid JSON
 * read exactly as before. Two things moved, and both are the shared vocabulary
 * arriving:
 *
 * A **string where a boolean was declared is now coerced** rather than refused.
 * The old reader's reason was that `"false"` is not `false` and coercing a typo
 * invents a setting nobody chose -- and `transformValue()`'s boolean vocabulary
 * is strict and symmetric, so `"nope"` still throws and there is no silent wrong
 * answer available. What is left is `"off"`, `"0"` and `"yes"` meaning in this
 * file what they already mean to `--shake=off` and to `SHAKE=off`, which is one
 * answer where there were two.
 *
 * And the **messages are the shared ones**, which is what sharing a validator
 * costs: `Invalid value for "build.sourcemap" in sigil.json: Invalid boolean`
 * rather than a sentence written here. They name the file, the setting and what
 * was wrong, which is what a message has to do.
 *
 * @param root - The app root.
 * @returns What the file said, or an empty config when there is none.
 * @throws If the file is not readable as the shape it claims.
 */
export function readSigilConfig(root: string): SigilConfig {
	// one layer, which is this file. The stack is what an *app* reaches for; the
	// toolchain has exactly one place its own settings live, and a second layer
	// would be a second place to look for an answer to one question
	const config = createConfigSync({
		layers: [{ name: CONFIG_FILE, store: json(join(root, CONFIG_FILE)) }],
		schema: SCHEMA,
	});

	const section = config.get('build');
	const build = readSection(section);
	const components = readName(config.get('components'), 'components');
	const locale = readName(config.get('locale'), 'locale');

	// the keys are set only where the file said something, so that a directory
	// with no file in it and a file holding `{}` are the same answer -- which they
	// are, and which the old reader distinguished only by returning early
	return {
		...(build && { build }),
		...(components !== undefined && { components: readRelative(components) }),
		...(locale !== undefined && { locale }),
	};
}

/**
 * The `build` section, which the schema's vocabulary cannot shape.
 *
 * A config schema declares settings by dotted path and deliberately has no
 * nested object shapes, so `build.external` is typed and `build` itself is not
 * -- which leaves `"build": []` as a mistake nothing would report. Declaring
 * `build` as well is not the way out: a setting whose path runs through another
 * setting's is refused where the schema is read, because the two would each
 * validate the other's value.
 *
 * So this is the same split `components` already takes: the schema does types,
 * and a check the vocabulary cannot say stays here.
 *
 * @param value - What the merged view holds at `build`.
 * @returns The section, or `undefined` where the file said nothing.
 * @throws If it is there and is not an object.
 */
function readSection(value: unknown): BuildConfig | undefined {
	if (value === undefined) {
		return undefined;
	}
	if (typeof value !== 'object' || value === null || Array.isArray(value)) {
		throw new Error(`${CONFIG_FILE}: "build" must be an object`);
	}

	// the declared fields and nothing else, which is what the hand-written reader
	// did by naming each one. The merged view holds whatever the *file* holds, so
	// passing it through would hand back an object with keys `BuildConfig` does
	// not declare -- a value that lies about its own type, over a key that is
	// almost always a typo for one of these six
	const held = value as Record<string, unknown>;
	const build: Record<string, unknown> = {};
	for (const field of FIELDS) {
		if (Object.hasOwn(held, field)) {
			build[field] = held[field];
		}
	}

	return Object.keys(build).length > 0 ? readBuild(build as BuildConfig) : undefined;
}

/**
 * A field the schema typed as a string and that may not be empty.
 *
 * `""` passes `type: 'string'` and is right to: the recorded rule is that a key
 * written `""` is an empty string somebody chose, where absent and `null` are
 * both not configured. What the data type cannot know is that none of these
 * fields has a use for one -- an empty `components` is not a directory and an
 * empty `locale` is not a tag.
 *
 * @param value - The value.
 * @param field - The field, for the message.
 * @returns The value, or `undefined` where the file said nothing.
 * @throws If it is there and empty.
 */
function readName(value: unknown, field: string): string | undefined {
	if (value === undefined) {
		return undefined;
	}
	if (!value) {
		throw new Error(`${CONFIG_FILE}: "${field}" must be a non-empty string`);
	}
	return value as string;
}

/**
 * The `components` field, which predates the rest of the file.
 *
 * Relative to the app, which is the other thing a data type cannot say: it is a
 * fact about what the field is *for* rather than about what kind of value it
 * is.
 *
 * @param value - The non-empty name.
 * @returns It, unchanged.
 * @throws If it is absolute.
 */
function readRelative(value: string): string {
	if (isAbsolute(value)) {
		throw new Error(`${CONFIG_FILE}: "components" must be relative to the app`);
	}
	return value;
}

/**
 * The `build` section, with the one field that has a rule of its own.
 *
 * Every type in here is the schema's now, so what is left is the same
 * non-emptiness the `components` field needs: a `""` passes `type: 'string'`
 * and is not a name anything can use.
 *
 * @param build - What the merged view holds at `build`.
 * @returns The section.
 * @throws If a name in it is empty.
 */
function readBuild(build: BuildConfig): BuildConfig {
	readName(build.name, 'build.name');
	readName(build.out, 'build.out');

	for (const [field, names, what] of [
		['build.external', build.external, 'package names'],
		['build.safelist', build.safelist, 'class names'],
	] as const) {
		if (names?.some((name) => !name)) {
			throw new Error(`${CONFIG_FILE}: "${field}" must be an array of ${what}`);
		}
	}

	return build;
}
