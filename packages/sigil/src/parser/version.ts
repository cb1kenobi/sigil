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

import { __ } from '../i18n/index.js';
import { Internal, type InternalCommand, type InternalOption, type ParseState } from '../types.js';
import { addFreeFlag } from './option/free-flag.js';
import { typedOn } from './typed-on.js';

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

  const handles: VersionHandles = {};

  // nothing over a spelling or a name the app already holds; see `addFreeFlag()`
  const option = await addFreeFlag(root[Internal].options, {
    desc: () => __`Print the version`,
    name: 'version',
    short: 'v',
  });
  if (option) {
    handles.option = option;
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
  return typedOn(state, handles.option);
}
