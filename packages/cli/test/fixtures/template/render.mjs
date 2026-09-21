/**
 * Renders one Counter twice, with a signal write in between, as JSON.
 *
 *   node render.mjs ./counter-tag.js
 *
 * Spawned by `test/template.test.ts` once per frontend. The frame after the
 * write is what makes this a test of the reactivity rather than of the first
 * paint: a frontend that built the tree correctly and wired no effects would
 * pass on `before` alone.
 */

import { renderToString } from '@ttylabs/sigil/element';
import { createRoot } from '@ttylabs/sigil/renderer';
import { flush, State } from '@ttylabs/sigil/signals';

const { Counter } = await import(process.argv[2]);

const count = new State(1);
const items = new State(['parser', 'canvas']);

const frames = createRoot((dispose) => {
	const element = Counter({ count, items });
	flush();
	const before = renderToString(element, { colorLevel: 0, width: 30 });

	count.set(3);
	items.set(['parser', 'canvas', 'layout']);
	flush();
	const after = renderToString(element, { colorLevel: 0, width: 30 });

	dispose();
	return { after, before };
});

console.log(JSON.stringify(frames));
