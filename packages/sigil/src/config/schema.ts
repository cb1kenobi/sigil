import { __ } from '../i18n/index.js';
import { envValue } from '../util/env-value.js';
import { assertChoices, checkValue, DATA_TYPES, transformValue } from '../util/transform.js';
import { readPath, segments, writePath } from './dotted.js';
import { copyValue } from './merge.js';
import type { ConfigSchema, ConfigSetting } from './types.js';

/** One setting, with its path and its parsed segments kept together. */
export interface Setting {
	readonly parts: readonly string[];
	readonly path: string;
	readonly setting: ConfigSetting;
}

/**
 * Reads a schema into the list the rest of the module walks, refusing a
 * declaration it cannot mean.
 *
 * Refused at construction rather than on the first `get()`, which is the rule
 * this repository keeps everywhere: what is decidable earlier fails earlier. A
 * data type name is checked against `DATA_TYPES` -- exact membership, which is
 * the anchoring entry's own conclusion -- and `count` is refused along with
 * every other name, because a counter is a thing argv increments and a config
 * file has nothing to increment.
 *
 * These messages are **not** translated, and that is the line the i18n work
 * already drew: a schema is the app author's own declaration, so a bad one is a
 * bug report, and a translated `Setting "x" has unsupported data type` is a bug
 * report in a language the maintainer cannot read. Everything a *user's* file
 * can provoke is translated.
 *
 * @param schema - The declared settings.
 * @returns The settings, in declaration order.
 * @throws If a declaration cannot mean anything.
 */
export function readSchema(schema: ConfigSchema | undefined): Setting[] {
	const out: Setting[] = [];

	for (const path of Object.keys(schema ?? {})) {
		const setting = (schema as ConfigSchema)[path] as ConfigSetting;

		if (!setting || typeof setting !== 'object' || Array.isArray(setting)) {
			throw new Error(`Setting "${path}" must be an object`);
		}

		// the same guard a dotted path gets, asked where the schema is read: a
		// setting called `__proto__` would be a declared route to the one hazard
		// every other door is shut against
		let parts: readonly string[];
		try {
			parts = segments(path);
		} catch {
			throw new Error(`Setting "${path}" is not a usable config path`);
		}

		if (parts.length === 0) {
			throw new Error('A setting must name a path');
		}

		if (setting.type !== undefined && !DATA_TYPES.has(setting.type)) {
			throw new Error(`Setting "${path}" has unsupported data type "${setting.type}"`);
		}

		if (setting.choices !== undefined && !Array.isArray(setting.choices)) {
			throw new Error(`Setting "${path}" choices must be an array`);
		}

		if (setting.merge !== undefined && setting.merge !== 'concat' && setting.merge !== 'replace') {
			throw new Error(`Setting "${path}" merge must be "concat" or "replace"`);
		}

		// `envNames()` spreads it, so a non-iterable reached `envOf()` as a
		// `TypeError: env is not iterable` -- an error about the wrong thing,
		// naming nothing. An empty name is refused with it, because `envValue()`
		// would look one up and a variable has a name
		if (setting.env !== undefined) {
			const names = typeof setting.env === 'string' ? [setting.env] : setting.env;
			if (!Array.isArray(names) || names.some((name) => typeof name !== 'string' || !name)) {
				throw new Error(`Setting "${path}" env must be a variable name or an array of them`);
			}
		}

		out.push({ parts, path, setting });
	}

	// a setting whose path runs through another setting's is a declaration with
	// two answers about one place -- `server` as a `json` object and
	// `server.port` as an `int` would each validate the other's value. Refused
	// here rather than resolved by a precedence nobody would remember
	const paths = out.map((s) => s.path);
	for (const outer of paths) {
		for (const inner of paths) {
			if (inner !== outer && inner.startsWith(`${outer}.`)) {
				throw new Error(`Setting "${inner}" is inside setting "${outer}"`);
			}
		}
	}

	return out;
}

/** The environment variables a setting declares, as a list. */
function envNames(setting: ConfigSetting): string[] {
	const { env } = setting;
	if (env === undefined) {
		return [];
	}
	return typeof env === 'string' ? [env] : [...env];
}

/** A setting's data type, defaulting the way the parser's own declarations do. */
function typeOf(setting: ConfigSetting): string {
	return setting.type ?? 'string';
}

/**
 * Validates and coerces one setting's value in one layer, in place.
 *
 * The coerced value **replaces** the raw one, which is what makes a store whose
 * format has no scalar kind but a string work at all: `"8080"` from an XML
 * attribute is the `8080` every reader after this one sees, exactly as
 * `applyFallback()` writes a coerced value onto `argv` rather than leaving the
 * string for somebody else to interpret.
 *
 * @param value - The layer's value, mutated in place.
 * @param it - The setting.
 * @param where - The layer, for the message.
 * @throws If the value is not one the setting can hold.
 */
function coerceSetting(value: Record<string, unknown>, it: Setting, where: string): void {
	const at = readPath(value, it.parts);

	// a `null` cannot reach here: `copyValue()` drops a key whose value is one,
	// at every door a value enters by, because a document says nothing the same
	// way whether or not a schema named the key. That rule used to live here and
	// was therefore **only** true of a declared setting -- so `{ "x": null }`
	// with no schema answered `null` and `has('x')` was `true`
	if (at === undefined) {
		return;
	}

	const type = typeOf(it.setting);

	try {
		if (it.setting.multiple) {
			// a scalar where a list was declared is refused rather than wrapped. The
			// parser wraps an environment value because argv and the environment can
			// only hand over one value at a time; a file can write a list, so a
			// scalar there is a mistake worth reporting -- and the environment layer
			// below still wraps, for the parser's reason
			if (!Array.isArray(at)) {
				throw new Error(__`Expected a list of values`);
			}
			// through `copyValue()` because a coercion is the **third** door of the
			// prototype guard: `type: 'json'` turns a string into an object, and an
			// own `__proto__` in it entered as a string with no keys to refuse. See
			// `copyValue()` for what that came to
			const items = at.map((item) => checkValue(item, type));
			assertChoices(it.setting.choices, items, __`setting "${it.path}"`);
			writePath(value, it.parts, copyValue(items, where));
			return;
		}

		const one = checkValue(at, type);
		assertChoices(it.setting.choices, one, __`setting "${it.path}"`);
		writePath(value, it.parts, copyValue(one, where));
	} catch (e: unknown) {
		throw new Error(__`Invalid value for "${it.path}" in ${where}: ${(e as Error).message}`);
	}
}

/**
 * Validates and coerces every setting in one layer's value, in place.
 *
 * A path the schema does not declare is left exactly as it arrived, which is
 * the call `allowUnknownOptions` already makes for argv: a config file
 * legitimately holds things this app's schema has nothing to say about -- a
 * plugin's own settings, a key a newer version reads -- and the schema is a
 * partial typing over a free-form document rather than a closed shape. What
 * that gives up is a typo being caught, and saying so is better than refusing a
 * file somebody's plugin wrote half of.
 *
 * @param value - The layer's value, mutated in place.
 * @param settings - The schema.
 * @param where - The layer, for the message.
 */
export function coerceLayer(value: unknown, settings: readonly Setting[], where: string): void {
	if (settings.length === 0 || typeof value !== 'object' || value === null) {
		return;
	}

	for (const it of settings) {
		coerceSetting(value as Record<string, unknown>, it, where);
	}
}

/**
 * The bottom of the merged view: every setting that declared a `default`.
 *
 * Materialized rather than consulted on a miss, so that `get('server')` holds a
 * defaulted `server.port` and there is one merged object to read rather than a
 * merge with a fallback chain bolted beside it.
 *
 * What happens to one here is `applyFallback()`'s behaviour, measured on a real
 * parse rather than read off the code, because the three answers are not what a
 * reading of "non-string defaults pass through untouched" predicts:
 *
 * | a `default` of | on an option declared | lands as |
 * | -- | -- | -- |
 * | `'a'` | `multiple: true` | `['a']` -- **wrapped** |
 * | `['a']` | `multiple: true` | `['a']` |
 * | `'z'` | `choices: ['a', 'b']` | **throws** `Invalid value "z"` |
 * | `8080.5` | `type: 'int'` | `8080.5` -- untouched |
 *
 * So all three are kept. A **string** is coerced and a non-string is not, which
 * is the recorded rule; a non-array is **wrapped** for a `multiple` setting,
 * because a declaration can only write one value and the wrap is what makes the
 * shape not depend on how many were written; and `choices` is checked, because a
 * `default` is a producer and the rule is that a value is validated by whoever
 * produced it.
 *
 * And a non-string default is deliberately **not** type-checked, which is the
 * one place this is looser than it could be: the parser hands `8080.5` to an
 * `int` option untouched, and diverging here would make the two declarations
 * disagree about a value written in code. The reason that is defensible is the
 * recorded one -- the author wrote it in the right type -- and a config schema is
 * as much the app's own source as an option declaration is.
 *
 * @param settings - The schema.
 * @returns The defaults, as a nested object.
 * @throws If a default is outside the setting's `choices`.
 */
export function defaultsOf(settings: readonly Setting[]): Record<string, unknown> {
	const out: Record<string, unknown> = {};

	for (const it of settings) {
		const raw = it.setting.default;
		if (raw === undefined) {
			continue;
		}

		const coerced = typeof raw === 'string' ? transformValue(raw, typeOf(it.setting)) : raw;
		const value = it.setting.multiple && !Array.isArray(coerced) ? [coerced] : coerced;

		assertChoices(it.setting.choices, value, __`setting "${it.path}"`);
		// and again: a `default` is the app's own object, which may have come out of
		// a `JSON.parse` of something it read
		writePath(out, it.parts, copyValue(value, __`setting "${it.path}"`));
	}

	return out;
}

/**
 * The top of the merged view: every setting whose environment variable is set.
 *
 * A layer like any other, so that there is one precedence chain rather than a
 * merge with an override pass beside it -- the environment is above the files
 * because a variable is a per-run statement and a file is a persistent one,
 * which is the same reading argv gets against the environment one layer up.
 *
 * Read **once**, here, rather than on each `get()`: a value that changed under
 * a running process is the parser's answer too, and a `get()` that re-read the
 * environment would be a different answer to the same question at two moments.
 *
 * @param settings - The schema.
 * @param env - The environment.
 * @returns The values, as a nested object.
 */
export function envOf(
	settings: readonly Setting[],
	env: Record<string, string | undefined>
): Record<string, unknown> {
	const out: Record<string, unknown> = {};

	for (const it of settings) {
		const names = envNames(it.setting);
		if (names.length === 0) {
			continue;
		}

		const raw = envValue(env, names);
		if (raw === undefined) {
			continue;
		}

		const type = typeOf(it.setting);
		// wrapped for a `multiple` setting, which is `applyFallback()`'s rule: a
		// variable can only hand over one value at a time, so one value is the list
		const value = transformValue(raw, type);
		const one = it.setting.multiple ? [value] : value;
		assertChoices(it.setting.choices, one, __`setting "${it.path}"`);
		// the same third door: `DATA='{"__proto__":{...}}'` on a `json` setting is
		// a string that becomes an object here
		writePath(out, it.parts, copyValue(one, __`setting "${it.path}"`));
	}

	return out;
}

/**
 * Whether a path's arrays concatenate across layers.
 *
 * Indexed on a null-prototype map for the reason every lookup table here is:
 * on a plain object `constructor` reads back truthy, so a path called that
 * would answer for a setting nobody declared.
 *
 * @param settings - The schema.
 * @returns A predicate over a dotted path.
 */
export function concatPaths(settings: readonly Setting[]): (path: string) => boolean {
	const index: Record<string, true> = Object.create(null) as Record<string, true>;

	for (const it of settings) {
		if (it.setting.merge === 'concat') {
			index[it.path] = true;
		}
	}

	return (path: string) => Object.hasOwn(index, path);
}
