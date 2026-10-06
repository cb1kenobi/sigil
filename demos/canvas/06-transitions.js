/**
 * Layers and masks: a dissolve, a wipe and an iris over the frame that was
 * already on screen.
 *
 *   node demos/canvas/06-transitions.js
 *   node demos/canvas/06-transitions.js | cat     <- one frame per step, no cursor tricks
 *
 * A canvas paints one grid. A layer is a second one plus where its top-left sits
 * relative to the canvas's, and a mask is one byte per cell saying *when* that
 * cell shows -- so what makes a dissolve differ from a wipe is only which
 * generator filled the field.
 *
 * The thing worth watching is why this needs the framework at all. A dissolve
 * can be faked inside the `paint()` callback by painting conditionally; what
 * cannot be faked is that a transition needs the **previous screen's content**,
 * and by the time anybody wants one the state that produced it is gone.
 * `snapshot()` is that content, and it is the only thing here a caller could not
 * write for themselves.
 *
 * So each transition is the same six lines: snapshot the screen, push it as a
 * layer with a mask, ramp the threshold down to -1 across the frames, drop the
 * layer. The new state is painted underneath on every frame and the snapshot
 * gives way over it.
 */
import {
	blueNoiseMask,
	createInlineCanvas,
	dissolveMask,
	irisMask,
	maskThreshold,
	palette,
	seeded,
	wipeMask,
} from '@ttylabs/sigil/canvas';

const WIDTH = 44;
const HEIGHT = 7;
const FRAMES = 18;

const backend = createInlineCanvas({ height: HEIGHT, width: WIDTH });
const { canvas } = backend;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** A card of text, so each state is something a reader can tell apart. */
const card = (title, body, colour) => (p) => {
	p.fill(0, 0, WIDTH, HEIGHT, { bg: palette(colour) });
	p.text(2, 1, title, { attrs: 1, bg: palette(colour), fg: palette(15) });
	for (const [i, line] of body.entries()) {
		p.text(2, 3 + i, line, { bg: palette(colour), fg: palette(15) });
	}
};

const states = [
	{
		// a seed, so the demo looks the same every time somebody runs it
		mask: () => dissolveMask(WIDTH, HEIGHT, seeded(7)),
		name: 'dissolve  (shuffled permutation)',
		draw: card('ONE', ['every cell at its own moment,', 'in a shuffled order'], 4),
	},
	{
		mask: () => blueNoiseMask(WIDTH, HEIGHT, seeded(7)),
		name: 'dissolve  (blue noise)',
		draw: card('TWO', ['the same even ramp, spread so', 'no step of it clumps'], 5),
	},
	{
		mask: () => wipeMask(WIDTH, HEIGHT, 'right'),
		name: 'wipe      (a hard edge, left to right)',
		draw: card('THREE', ['one value per column, so the', 'edge is a straight line'], 2),
	},
	{
		mask: () => irisMask(WIDTH, HEIGHT),
		name: 'iris      (a circle, opening out)',
		draw: card('FOUR', ['distance from the centre, with', 'a row worth two columns'], 6),
	},
];

// the first state just appears; there is nothing on screen to transition from
backend.render(card('ZERO', ['nothing to dissolve from yet'], 8));
await sleep(600);

for (const state of states) {
	backend.write(`-> ${state.name}`);

	// generated once, before the ramp, and never per frame. A per-frame random
	// gives a cell that is in on frame nine and out on frame ten, which flickers
	// -- and the blue-noise generator is the one that costs enough to notice
	const mask = state.mask();

	// the snapshot is the old screen, and it is the whole reason this is a
	// framework feature rather than six lines in the callback
	const over = { cells: canvas.snapshot(), mask, x: 0, y: 0 };
	canvas.layers.push(over);

	for (let frame = FRAMES; frame >= 0; frame--) {
		// ramped down: the snapshot's highest values give way first, revealing the
		// new state painted underneath it
		mask.threshold = maskThreshold(frame / FRAMES);
		backend.render(state.draw);
		await sleep(45);
	}

	// and the layer goes, so the next frame is the new state and nothing else
	canvas.layers.length = 0;
	backend.render(state.draw);
	await sleep(400);
}

// the frame stays in the log and the cursor comes off the end of it
backend.done();
console.log('four transitions, one mechanism');
