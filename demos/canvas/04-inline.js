/**
 * A canvas parked at the bottom of a log that keeps scrolling.
 *
 *   node demos/canvas/04-inline.js
 *   node demos/canvas/04-inline.js | cat     <- one line per change, no cursor tricks
 *
 * This is the anchor almost everything wants. The canvas is the last few rows
 * and the log above it scrolls the way it always did, so a build can keep
 * printing while a progress bar repaints underneath it. Taking the whole screen
 * to show two rows would cost that log its scrollback.
 *
 * `write()` is the part worth watching: a line written while the canvas is up
 * has to land *above* it, and the only way there is through it -- so the region
 * is erased, the line is written, and the frame is painted again underneath.
 */
import { createInlineCanvas, palette } from '@ttylabs/sigil/canvas';

const STEPS = 24;
const WIDTH = 40;

const backend = createInlineCanvas({ height: 2, width: WIDTH });
const dim = { fg: palette(8) };
const done = { fg: palette(2) };

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

for (let step = 1; step <= STEPS; step++) {
	const filled = Math.round((step / STEPS) * (WIDTH - 2));

	backend.render((p) => {
		p.text(0, 0, `building  ${step}/${STEPS}`, step === STEPS ? done : undefined);
		p.text(0, 1, '█'.repeat(filled), done);
		p.text(filled, 1, '░'.repeat(WIDTH - 2 - filled), dim);
	});

	// the log carries on above, which is the whole point of this anchor
	if (step % 6 === 0) {
		backend.write(`compiled module ${step / 6}`);
	}

	await sleep(90);
}

// the frame stays and the cursor comes off the end of it, so whatever the shell
// prints next does not land on the last row
backend.done();
console.log('build finished');
