/**
 * A progress bar, for work whose length is known.
 *
 *   node demos/components/02-progress.js
 *   node demos/components/02-progress.js | cat     <- one line every 10%
 */
import { createProgress } from '@ttylabs/sigil/components';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const files = Array.from({ length: 40 }, (_, i) => `src/file-${i + 1}.js`);

const bar = createProgress({ text: 'Copying', total: files.length });

for (const file of files) {
	await sleep(40);
	bar.tick();

	// a line that stays, above the bar
	if (file.endsWith('-20.js')) {
		bar.write(`skipped ${file}`);
	}
}

bar.done('Copied 40 files');

// the bar sizes itself to a third of the terminal unless told otherwise
const narrow = createProgress({ barWidth: 12, text: 'Verifying', total: 5 });
for (let i = 0; i < 5; i++) {
	await sleep(120);
	narrow.tick();
}
narrow.done('Verified');
