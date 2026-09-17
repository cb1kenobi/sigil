/**
 * The layer the spinner and the bar are built on: repaint the bottom few rows
 * while everything above keeps scrolling.
 *
 *   node demos/components/05-live-region.js
 *   node demos/components/05-live-region.js | cat
 */
import { createLiveRegion } from '@ttylabs/sigil/terminal';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const region = createLiveRegion();

console.log('a log line printed before anything is live');

// a frame may be several rows, and the region walks back up all of them
for (let done = 0; done <= 10; done++) {
	region.render(
		[
			`Building  ${'#'.repeat(done)}${'.'.repeat(10 - done)}`,
			`Step ${done} of 10`,
			done < 10 ? 'working...' : 'finishing',
		].join('\n'),
		// what it means, for when there is no terminal to repaint
		`Building step ${done} of 10`
	);

	if (done === 4) {
		// lands above the region, which is redrawn underneath
		region.write('warning: two files were skipped');
	}

	await sleep(200);
}

region.done('Built in 2.0s');
console.log('and a log line printed after');
