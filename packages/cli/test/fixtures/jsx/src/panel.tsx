import type { Element } from '@ttylabs/sigil/element';

/**
 * A panel written as JSX, which is the canonical syntax.
 *
 * There is deliberately **no `tsconfig.json`** in this fixture, and that is the
 * whole of what it pins. rolldown reads an app's `tsconfig.json` on its own, so
 * an app that names `jsxImportSource` always built correctly and the defect was
 * only ever rolldown's *default*, which is `react`: this app built, reported
 * success, and died the first time the command was run with
 * `Cannot find package 'react'`.
 *
 * There is no source-run twin either, for the reason `templated-tsx` records:
 * node cannot load a `.tsx` at all, so an app with one is a built app by
 * construction.
 */
export function Panel({ who }: { who: string }): Element {
	return (
		<box flex-direction="column">
			<text class="hello">Hello, {who}!</text>
			<text>from a compiled JSX element</text>
		</box>
	);
}
