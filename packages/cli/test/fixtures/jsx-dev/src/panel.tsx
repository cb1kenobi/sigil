import type { Element } from '@ttylabs/sigil/element';

/**
 * A panel whose JSX is compiled by the *development* transform.
 *
 * `jsxDEV` is handed a file, a line and a column, which `@ttylabs/sigil`'s dev
 * runtime reads into `IRNode.loc` -- so this module's own name ends up in the
 * bundle as a string, which is the marker a minified build still carries.
 */
export function Panel({ who }: { who: string }): Element {
	return <text class="hello">Hello, {who}!</text>;
}
