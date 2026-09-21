/**
 * The development JSX runtime: `@ttylabs/sigil/jsx-dev-runtime`.
 *
 * A separate module because the transform imports a
 * separate module: `"jsx": "react-jsxdev"`, which is what vite and esbuild's
 * `--jsx=automatic --jsx-dev` use in development, emits
 * `import { jsxDEV } from "<source>/jsx-dev-runtime"`. Exporting `jsxDEV` from
 * `jsx-runtime` and stopping there -- which is what this did -- left every dev
 * build resolving a subpath the package does not have, so the toolchain
 * `runtime.ts` claims to support failed at import with
 * `ERR_PACKAGE_PATH_NOT_EXPORTED`. Missed because the tests compile with
 * `"jsx": "react-jsx"`, which only ever reaches the production entry.
 *
 * Two of the extra arguments the dev transform passes are read rather than
 * ignored. `isStaticChildren` says whether `children` is a list, which is the
 * distinction `jsxs` exists for. `source` is a file, line and column, and it is
 * the **only** way a JSX frontend can carry a position: the production
 * transform passes none, so a compiled template's errors point at the template
 * in a dev build and not in a release one. That asymmetry is the transform's
 * rather than ours, and it is why `IRNode.loc` is optional. `self` is ignored,
 * since what it carries is for a warning this runtime does not emit.
 */

import type { Element as SigilElement } from '../element/index.js';
import type { ComponentRef } from './ir.js';
import { build } from './runtime.js';

// the namespace as well as the runtime: `"jsx": "react-jsxdev"` looks the `JSX`
// types up in *this* module, not in `jsx-runtime`, so exporting only `jsxDEV`
// left every dev build with `JSX element implicitly has type 'any' because no
// interface 'JSX.IntrinsicElements' exists` -- the typo checking this whole
// file exists for, silently off
export { type Children, Fragment, type HostProps, type Reactive } from './runtime.js';
export type { JSX } from './runtime.js';

/**
 * What the development transform calls for every element.
 *
 * @param type - A host name, or the component itself.
 * @param props - Its props, with `children` among them.
 * @param key - The `key` prop, which the transform lifts out.
 * @param isStaticChildren - Whether `children` is a list rather than one child.
 * @param source - Where it was written, which the production transform omits.
 * @returns The element.
 */
export function jsxDEV(
	type: ComponentRef | string,
	props: Record<string, unknown>,
	key?: number | string,
	isStaticChildren?: boolean,
	source?: { columnNumber?: number; fileName?: string; lineNumber?: number }
): SigilElement {
	const loc =
		source?.lineNumber === undefined
			? undefined
			: {
					column: source.columnNumber ?? 1,
					file: source.fileName,
					line: source.lineNumber,
				};
	return build(type, props, key, isStaticChildren === true, loc);
}
