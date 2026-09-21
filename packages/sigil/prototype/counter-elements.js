/**
 * The Counter, hand-built. The baseline both frontends have to match.
 *
 * This is what a component looks like today: build the nodes, then wire one
 * effect per thing that changes. Nothing below is wrong -- it is just the part a
 * template is supposed to write for you.
 */

import { box, text } from '@ttylabs/sigil/element';
import { createEffect, For, Show } from '@ttylabs/sigil/renderer';

export function Counter({ count, items }) {
	const root = box({
		border: 'round',
		'flex-direction': 'column',
		padding: '0 1',
		width: 28,
	});

	const line = text('');
	createEffect(() => {
		line.setText(`count: ${count.get()}`);
	});

	const badge = text('', { color: 'cyan' });
	createEffect(() => {
		badge.setText(count.get() > 2 ? 'high' : 'low');
	});

	root.append(text('Counter', { 'font-weight': 'bold' }), line, badge);

	root.append(
		Show({
			children: () =>
				For({
					children: (item) => text(`- ${item}`),
					each: () => items.get(),
					props: { 'flex-direction': 'column' },
				}),
			fallback: () => text('(nothing)', { 'font-style': 'italic' }),
			props: { 'flex-direction': 'column' },
			when: () => items.get().length > 0,
		})
	);

	return root;
}
