/**
 * `--version`, wired the way `--help` is.
 *
 * ## Why the framework owns it
 *
 * Every CLI has one, and before this each had to write it: declare the option,
 * parse, then read `argv.version` back off the state and print. That works
 * right up until the app is built -- `sigil build` generates the executable and
 * calls `main()`, so whatever the app's own bin did around `main()` is not in
 * the bundle. The toolchain's own `--version` printed nothing at all once it
 * was built with itself, and exited zero doing it, which is the worst shape a
 * divergence can take: `node src/sigil.ts --version` and
 * `node dist/sigil.mjs --version` have to be the same program.
 *
 * Putting it in the schema is what fixes that, because the schema is the one
 * thing the build carries across whole. It is the same argument `--help`
 * already settled -- an app does not write its own help flag either.
 *
 * ## Help outranks it
 *
 * `mycli --help --version` prints help. Being asked what a program does and
 * answering with a version string is not an answer, and it is the rule
 * `detectHelp()` is already called first to keep.
 */

import { Internal, type InternalCommand, type InternalOption, type ParseState } from '../types.js';

/**
 * The `--version` flag a schema gets for free, so a parse can tell whether it
 * was the thing that was asked for. An app that declares its own keeps it, and
 * then this is empty.
 */
export interface VersionHandles {
	option?: InternalOption;
}

/**
 * Adds `-v, --version` to the root context, when the schema named a version.
 *
 * On the root rather than on every command, because options resolve across the
 * whole context chain: one there answers everywhere, and a command that
 * declares its own shadows it for itself alone.
 *
 * Nothing is added over the top of what the app declared. A CLI whose `-v`
 * means `--verbose` keeps it and gets `--version` without the short form; one
 * that declares `--version` itself gets no flag from here and owns what it
 * means -- which is the only reading of a declaration that means anything, and
 * is exactly what `registerHelp()` does with `-h`.
 *
 * @param root - The root context, built from the schema.
 * @param version - What the schema said the version is.
 * @returns What was added, so a parse can recognize it later.
 */
export async function registerVersion(
	root: InternalCommand,
	version: string | (() => string) | undefined
): Promise<VersionHandles> {
	if (version === undefined) {
		return {};
	}

	const internal = root[Internal];
	const handles: VersionHandles = {};

	// `find()` answers about spellings and `has()` about the key the registry
	// stores an option under, which is its name -- both have to be free, for the
	// reason the help wiring records: an option spelled `-x` and named `version`
	// takes the key without answering to `--version`
	if (internal.options.find('--version') || internal.options.has('version')) {
		return handles;
	}

	const format = internal.options.find('-v') ? '--version' : '-v, --version';
	await internal.options.add({ desc: 'Print the version', format });
	handles.option = internal.options.find('--version');

	if (handles.option) {
		// a flag always has a value, and this one is not the app's: an app that
		// never declared `--version` should not find `version: false` in its argv
		handles.option[Internal].parserOwned = true;
	}

	return handles;
}

/**
 * Whether this parse was a request for the version.
 *
 * Asked once argv has been walked and before anything is validated, for the
 * reason help is: `mycli build --version` should answer rather than complain
 * that `build` is missing a required option.
 *
 * @param state - The parse state.
 * @param handles - What `registerVersion()` added.
 * @returns Whether the version was asked for.
 */
export function detectVersion(state: ParseState, handles: VersionHandles): boolean {
	const { option } = handles;

	if (!option) {
		return false;
	}

	return state.$.some(
		(parsed) => parsed.type === 'Option' && parsed.option === option && parsed.value === true
	);
}
