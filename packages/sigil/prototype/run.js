/**
 * The three frontends, side by side, and a differential test in miniature.
 *
 *   node packages/sigil/prototype/run.js
 *
 * Each variant is built, rendered to a string, mutated, flushed and rendered
 * again -- so what is being compared is not just the first frame but what the
 * reactivity did. SIG-72 asks for exactly this test across the two backends;
 * this is the same shape, one layer up, across the two frontends.
 */

import { Counter as elements } from './counter-elements.js';
import { Counter as tag } from './counter-tag.js';
import { Counter as jsx } from './out/counter-jsx.js';
import { renderToString } from '@ttylabs/sigil/element';
import { createRoot } from '@ttylabs/sigil/renderer';
import { flush, State } from '@ttylabs/sigil/signals';

const WIDTH = 30;

function snapshot(Counter) {
	const count = new State(1);
	const items = new State(['parser', 'canvas']);

	return createRoot((dispose) => {
		const element = Counter({ count, items });
		flush();
		const before = renderToString(element, { colorLevel: 0, width: WIDTH });

		count.set(3);
		items.set(['parser', 'canvas', 'layout']);
		flush();
		const after = renderToString(element, { colorLevel: 0, width: WIDTH });

		dispose();
		return { after, before };
	});
}

const variants = [
	['hand-built elements', elements],
	['ui`` tagged template', tag],
	['JSX, compiled by tsc', jsx],
];

const results = variants.map(([name, Counter]) => [name, snapshot(Counter)]);

for (const [name, { after, before }] of results) {
	console.log(`\n=== ${name} ===`);
	console.log('\n-- first frame --');
	console.log(before);
	console.log('\n-- after count.set(3) and a third item --');
	console.log(after);
}

const [, baseline] = results[0];
let identical = true;
for (const [name, result] of results.slice(1)) {
	for (const frame of ['before', 'after']) {
		if (result[frame] !== baseline[frame]) {
			identical = false;
			console.log(`\nDIVERGED: ${name}, ${frame} frame`);
			console.log(JSON.stringify({ baseline: baseline[frame], got: result[frame] }, null, 2));
		}
	}
}

console.log(
	identical
		? '\nAll three frontends produced byte-identical output, before and after.'
		: '\nThe frontends disagree; see above.'
);
process.exitCode = identical ? 0 : 1;
