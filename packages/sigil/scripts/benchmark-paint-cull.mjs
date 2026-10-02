/**
 * What paint culling is worth at ten thousand rows.
 *
 *   pnpm build && node packages/sigil/scripts/benchmark-paint-cull.mjs
 *   pnpm build && node packages/sigil/scripts/benchmark-paint-cull.mjs 1000
 *
 * Run by hand, like `terminal-probe.mjs`, and committed for the reason that one
 * is: a number in a pull request is a claim the next reader has to trust, and a
 * script they can run is one they can check. It is deliberately not in the
 * suite -- ten thousand rows is a second of arrange per pass, and this package's
 * own `testTimeout` is ten seconds with a fuzzer already running beside it.
 *
 * Imports `dist/` rather than `src/`, for the reason the probe does: what ships
 * is what should be measured.
 *
 * The two sides are **one binary**. `paint()` culls on `element.extent`, so the
 * "before" pass is the same call over a tree whose extents have been cleared --
 * the guard turned off by taking its input away rather than by a second copy of
 * the walk, which is the only differential that cannot drift between its sides.
 * `clearExtents()` is the same trick `test/element/scroll.test.ts` uses, and the
 * reason both are written the same way.
 *
 * Interleaved rather than batched, for the reason AGENTS.md records twice: two
 * batches minutes apart disagree with each other, and run in the other order
 * with themselves, on a machine that is doing anything else. Check the absolute
 * numbers against the ones AGENTS.md writes down before believing a delta.
 */
import { CellBuffer, Painter, StyleTable } from '../dist/canvas.mjs';
import { arrange, box, hitTest, paint, resolveStyles, text } from '../dist/element.mjs';

const ROWS = Number(process.argv[2] ?? 10_000);
const WIDTH = 80;
const HEIGHT = 24;

/** Somewhere in the middle, so neither end of the list is the easy case. */
const MID = Math.max(0, Math.floor(ROWS / 2) - HEIGHT);
const ROUNDS = 6;
const ITERATIONS = 20;

/** A log of two-text rows inside a viewport that clips: three elements a row. */
function build() {
	const rows = [];
	for (let i = 0; i < ROWS; i++) {
		rows.push(
			box(
				{ 'column-gap': 1, 'flex-direction': 'row' },
				text(String(i).padStart(6, '0'), { 'white-space': 'nowrap' }),
				text(`event ${i} on the queue`, { 'white-space': 'nowrap' })
			)
		);
	}
	const content = box({ 'flex-direction': 'column' }, ...rows);
	const view = box(
		{ 'flex-direction': 'column', height: HEIGHT, overflow: 'hidden', width: WIDTH },
		content
	);
	return { root: box({}, view), view };
}

/**
 * Turns the cull off by removing what it reads, which is what makes this one
 * binary rather than two.
 *
 * @param {import('../dist/element.mjs').Element} element
 */
function clearExtents(element) {
	element.extent = undefined;
	for (const child of element.children) {
		clearExtents(child);
	}
}

/** @param {import('../dist/element.mjs').Element} element */
function countElements(element) {
	let n = 1;
	for (const child of element.children) {
		n += countElements(child);
	}
	return n;
}

const { root, view } = build();
console.log(`${ROWS} rows, ${countElements(root)} elements, ${WIDTH}x${HEIGHT}`);

resolveStyles(root);

// One arrange, timed, for context rather than as the subject: culling is a
// paint optimization and says nothing about the measure, which is what the
// virtualization argument rests on.
{
	const t = process.hrtime.bigint();
	arrange(root, { height: HEIGHT, width: WIDTH });
	console.log(`arrange: ${(Number(process.hrtime.bigint() - t) / 1e6).toFixed(2)}ms`);
}

function paintOnce() {
	const buffer = new CellBuffer(WIDTH, HEIGHT);
	paint(root, new Painter(buffer, new StyleTable()));
	return buffer;
}

/** Puts the extents back and scrolls, since an arrange is what writes them. */
function settle(offset) {
	view.scrollTo(0, offset);
	arrange(root, { height: HEIGHT, width: WIDTH });
}

// Correctness before cost, because a cull that changed a cell would be faster
// and wrong -- and a benchmark that did not check would report the number.
settle(MID);
const culled = paintOnce().toString();
clearExtents(root);
const whole = paintOnce().toString();
if (culled !== whole) {
	console.error('the culled walk painted something else; not timing a wrong answer');
	console.error(`culled:\n${culled}\n\nwhole:\n${whole}`);
	process.exitCode = 1;
} else {
	console.log('identical output: true');

	/** @type {{ after: number[], before: number[] }} */
	const paints = { after: [], before: [] };
	/** @type {{ after: number[], before: number[] }} */
	const hits = { after: [], before: [] };

	for (let round = 0; round < ROUNDS; round++) {
		for (const side of /** @type {const} */ (['before', 'after'])) {
			// a different offset per round, so nothing is measured at one position
			settle(MID + round);
			if (side === 'before') {
				clearExtents(root);
			}

			const t = process.hrtime.bigint();
			for (let i = 0; i < ITERATIONS; i++) {
				paintOnce();
			}
			paints[side].push(Number(process.hrtime.bigint() - t) / 1e6 / ITERATIONS);

			// and the hit test, which culls on the same rectangle
			settle(MID + round);
			if (side === 'before') {
				clearExtents(root);
			}

			const h = process.hrtime.bigint();
			for (let i = 0; i < ITERATIONS; i++) {
				hitTest(root, 40, 12);
			}
			hits[side].push(Number(process.hrtime.bigint() - h) / 1e6 / ITERATIONS);
		}
	}

	/**
	 * @param {string} name
	 * @param {{ after: number[], before: number[] }} data
	 */
	function report(name, data) {
		/** @param {'after' | 'before'} side */
		const sorted = (side) => [...data[side]].sort((a, b) => a - b);
		/** @param {'after' | 'before'} side */
		const median = (side) => sorted(side)[Math.floor(data[side].length / 2)];

		for (const side of /** @type {const} */ (['before', 'after'])) {
			const s = sorted(side);
			console.log(
				`${name} ${side.padEnd(6)}: min ${s[0].toFixed(3)}ms  median ` +
					`${median(side).toFixed(3)}ms  max ${s.at(-1).toFixed(3)}ms`
			);
		}
		console.log(`${name} speedup: ${(median('before') / median('after')).toFixed(1)}x median`);
	}

	report('paint   ', paints);
	report('hit test', hits);
}
