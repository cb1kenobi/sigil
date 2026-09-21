/**
 * The Counter, as a tagged template. Runs under plain node, no build step.
 *
 * Two things to look at. A component is interpolated -- `<${Show}>` -- because
 * a tag function has no scope to look `Show` up in, and a registry would cost
 * tree-shaking. And every reactive thing is a thunk: `${() => count.get()}`.
 * The `${}` is not a preference, it is the only interpolation a template
 * literal has.
 */

import { For, Show } from '@ttylabs/sigil/renderer';
import { ui } from '@ttylabs/sigil/template';

export function Counter({ count, items }) {
	return ui`
		<box border="round" flex-direction="column" padding="0 1" width="28">
			<text font-weight="bold">Counter</text>
			<text>count: ${() => count.get()}</text>
			<text color="cyan">${() => (count.get() > 2 ? 'high' : 'low')}</text>
			<${Show}
				when=${() => items.get().length > 0}
				fallback=${() => ui`<text font-style="italic">(nothing)</text>`}
				props=${{ 'flex-direction': 'column' }}
			>
				${() =>
					ui`<${For} each=${() => items.get()} props=${{ 'flex-direction': 'column' }}>
						${(item) => ui`<text>- ${item}</text>`}
					</>`}
			</>
		</box>
	`;
}
