/**
 * The Counter, as JSX. Needs a build step; gets type checking and completion.
 *
 * Compiled by plain `tsc` with `jsxImportSource: "@ttylabs/sigil"` -- there is
 * no sigil-specific compiler in this path, which is the point: `sigil build`
 * would be an optimizer rather than something the app depends on to run.
 *
 * The reactivity rule is the same one the tag follows: `{() => count.get()}`.
 * Solid would let you write `{count() * 2}` and pays for it by having JSX mean
 * different things compiled and uncompiled.
 */

import { For, Show } from '@ttylabs/sigil/renderer';
import type { State } from '@ttylabs/sigil/signals';

interface CounterProps {
	count: State<number>;
	items: State<string[]>;
}

export function Counter({ count, items }: CounterProps) {
	return (
		<box border="round" flex-direction="column" padding="0 1" width="28">
			<text font-weight="bold">Counter</text>
			<text>count: {() => count.get()}</text>
			<text color="cyan">{() => (count.get() > 2 ? 'high' : 'low')}</text>
			<Show
				when={() => items.get().length > 0}
				fallback={() => <text font-style="italic">(nothing)</text>}
				props={{ 'flex-direction': 'column' }}
			>
				{() => (
					<For each={() => items.get()} props={{ 'flex-direction': 'column' }}>
						{(item: string) => <text>- {item}</text>}
					</For>
				)}
			</Show>
		</box>
	);
}
