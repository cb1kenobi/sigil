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
 * here needs computing -- they are four literals. The day one of them does is
 * the day to revisit it, which is the rule `which` waited on.
 *
 * ## A flag beats the file
 *
 * The file says what this app is always built with; a flag says what this one
 * invocation wants. So `--no-sourcemap` on the command line wins over
 * `"sourcemap": true` in the file, and the file wins over the built-in default.
 */

import { readFileSync, statSync } from 'node:fs';
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
	/** Whether to write sourcemaps. */
	readonly sourcemap?: boolean;
}

/** `sigil.json`, as it is on disk. */
export interface SigilConfig {
	readonly build?: BuildConfig;
	/** Where ejected components land, relative to the app. */
	readonly components?: string;
}

/** Whether a path is a file, answering `false` for anything unreadable. */
function isFile(path: string): boolean {
	try {
		return statSync(path).isFile();
	} catch {
		return false;
	}
}

/**
 * Reads an app's `sigil.json`, if it has one.
 *
 * Validated on the way out rather than trusted: a config file is source the
 * app wrote, and a `"external": "rolldown"` where an array was meant should say
 * so here rather than reach rolldown as a string and mean something else.
 *
 * @param root - The app root.
 * @returns What the file said, or an empty config when there is none.
 * @throws If the file is not readable as the shape it claims.
 */
export function readSigilConfig(root: string): SigilConfig {
	const path = join(root, CONFIG_FILE);

	if (!isFile(path)) {
		return {};
	}

	let json: Record<string, unknown>;
	try {
		json = JSON.parse(readFileSync(path, 'utf-8')) as Record<string, unknown>;
	} catch (e: unknown) {
		throw new Error(`Failed to parse ${CONFIG_FILE}: ${(e as Error).message}`);
	}

	return { build: readBuild(json.build), components: readComponents(json.components) };
}

/** The `components` field, which predates the rest of the file. */
function readComponents(value: unknown): string | undefined {
	if (value === undefined) {
		return undefined;
	}
	if (typeof value !== 'string' || value.length === 0) {
		throw new Error(`${CONFIG_FILE}: "components" must be a non-empty string`);
	}
	if (isAbsolute(value)) {
		throw new Error(`${CONFIG_FILE}: "components" must be relative to the app`);
	}
	return value;
}

/** The `build` section. */
function readBuild(value: unknown): BuildConfig | undefined {
	if (value === undefined) {
		return undefined;
	}
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		throw new Error(`${CONFIG_FILE}: "build" must be an object`);
	}

	const build = value as Record<string, unknown>;

	return {
		external: readExternal(build.external),
		name: readString(build.name, 'build.name'),
		out: readString(build.out, 'build.out'),
		sourcemap: readBoolean(build.sourcemap, 'build.sourcemap'),
	};
}

/** A list of package names, which is the one field that is easy to write as a string. */
function readExternal(value: unknown): readonly string[] | undefined {
	if (value === undefined) {
		return undefined;
	}
	if (!Array.isArray(value) || value.some((name) => typeof name !== 'string' || !name)) {
		throw new Error(`${CONFIG_FILE}: "build.external" must be an array of package names`);
	}
	return value as string[];
}

/** A non-empty string field. */
function readString(value: unknown, field: string): string | undefined {
	if (value === undefined) {
		return undefined;
	}
	if (typeof value !== 'string' || value.length === 0) {
		throw new Error(`${CONFIG_FILE}: "${field}" must be a non-empty string`);
	}
	return value;
}

/** A boolean field, refused rather than coerced: `"false"` is not `false`. */
function readBoolean(value: unknown, field: string): boolean | undefined {
	if (value === undefined) {
		return undefined;
	}
	if (typeof value !== 'boolean') {
		throw new Error(`${CONFIG_FILE}: "${field}" must be true or false`);
	}
	return value;
}
