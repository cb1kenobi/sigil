import type { Element } from '@ttylabs/sigil/element';

/**
 * A panel whose JSX nothing compiles, because the app's tsconfig says
 * `"jsx": "preserve"`.
 *
 * It type-checks: `preserve` still checks the JSX against the `JSX` namespace
 * `jsxImportSource` names, which is what makes this an app the build has to
 * refuse on its own rather than one `tsc` has already refused. Measured
 * against rolldown 1.2.11, `preserve` on a `.tsx` is the only tsconfig `jsx`
 * value that leaves raw JSX in the output -- `react-native`, which also
 * preserves under `tsc`, does not.
 */
export function Panel({ who }: { who: string }): Element {
	return <text class="hello">Hello, {who}!</text>;
}
