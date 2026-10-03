/**
 * What windowing a long list is worth, and where the frame goes without it.
 *
 *   pnpm build && node packages/sigil/scripts/benchmark-virtual-list.mjs
 *   pnpm build && node packages/sigil/scripts/benchmark-virtual-list.mjs 1000
 *
 * Run by hand and committed for the reason `benchmark-paint-cull.mjs` is: a
 * number in a pull request is a claim the next reader has to trust, and a script
 * they can run is one they can check. Deliberately not in the suite -- ten
 * thousand rows is a tenth of a second of cascade per pass against this
 * package's ten-second `testTimeout`, with a fuzzer already running beside it,
 * which is the cost that made `should cap the acceleration` drop from ten
 * thousand rows to six hundred.
 *
 * Imports `dist/` rather than `src/`: what ships is what should be measured.
 *
 * ## The sides are one binary
 *
 * `rowWindow()` reads the viewport's height, and the host's declared height is a
 * **floor** under it. So the "whole" side is `ScrollBox({ rows })` declaring the
 * *whole list's* height -- the optimization turned off by giving its one input a
 * value that cannot narrow anything, over the same component, the same window code
 * and the same row builder, which is the only differential that cannot drift
 * between its sides.
 *
 * The third side is the status quo: `children` holding every row, which is what
 * an app writes today and is what the steady-state number is against. Its rows
 * are assembled by hand, and what keeps that honest is that all three are
 * required to paint the **same frame** at several offsets before anything is
 * timed. A window that drew something else would be faster and wrong.
 *
 * The last section's two sides are a **frame** rather than a layout, because the
 * thing it measures cannot be reached without one: a list bounded by its parent
 * has no height to window by until something has arranged it. That is SIG-132.
 *
 * Interleaved rather than batched, for the reason AGENTS.md records twice: two
 * batches minutes apart disagree with each other, and run in the other order
 * with themselves, on a machine that is doing anything else. Check the absolute
 * numbers against the ones AGENTS.md writes down before believing a delta.
 */
import { CellBuffer, Painter, StyleTable } from '../dist/canvas.mjs';
import { ScrollBox } from '../dist/components.mjs';
import {
	arrange,
	box,
	paint,
	renderToLines,
	resolveStyles,
	scrollRange,
	text,
} from '../dist/element.mjs';

const ROWS = Number(process.argv[2] ?? 10_000);
const WIDTH = 80;
const HEIGHT = 24;
const ROW_HEIGHT = 1;

/** Somewhere in the middle, so neither end of the list is the easy case. */
const MID = Math.max(0, Math.floor(ROWS / 2) - HEIGHT);
const ROUNDS = 6;
const ITERATIONS = 5;

/** One row, shared by every side: two texts, which is three elements. */
function row(i) {
	return box(
		{ 'column-gap': 1, 'flex-direction': 'row' },
		text(String(i).padStart(6, '0'), { 'white-space': 'nowrap' }),
		text(`event ${i} on the queue`, { 'white-space': 'nowrap' })
	);
}

/**
 * What `rows` wraps each row in, written out for the side that does it by hand.
 *
 * `flex-direction: column` matters: it is what stretches the row to the slot's
 * width, so a hand-built list places its rows where the window places them. The
 * glyphs are the same either way, which is why the test beside this one compares
 * the **coloured** output -- a width that differs is invisible until something
 * paints a background.
 */
function slot(i) {
	return box({ 'flex-direction': 'column', 'flex-shrink': 0, height: ROW_HEIGHT }, row(i));
}

const rows = { count: ROWS, height: ROW_HEIGHT, row };

/** The window, as an app writes it. */
function windowed() {
	return ScrollBox({ props: { height: HEIGHT, width: WIDTH }, rows });
}

/**
 * The same thing with the window's one input given a value that cannot narrow it.
 *
 * The declared height is a **floor** under the window and never a ceiling, so
 * declaring the whole list's height is the optimization turned off: every window
 * this side computes holds every row, before a layout and after one. The host is
 * wrapped in a flex parent of the canvas's height and shrinks to it, so the
 * viewport is exactly as tall as the windowed side's and the painted frame is the
 * same one -- which is what makes it a differential rather than two programs.
 *
 * It used to turn the optimization off by **removing** the declaration, which was
 * the better shape and is no longer available: SIG-132 made a window computed
 * before any layout hold no rows rather than all of them, because a frame rebuilds
 * it after the layout and before the paint. So "no declared height" is now a thing
 * only a *frame* can measure, which is the section at the bottom of this file.
 */
function whole() {
	const host = ScrollBox({
		props: {
			'flex-basis': 0,
			'flex-grow': 1,
			height: ROWS * ROW_HEIGHT,
			'min-height': 0,
			width: WIDTH,
		},
		rows,
	});
	return { host, root: box({ 'flex-direction': 'column', height: HEIGHT }, host) };
}

/**
 * A list bounded by its parent and nothing else, which is SIG-132's subject.
 *
 * Nothing declared a height, so no window can be computed until a layout has given
 * the viewport a box -- which means this side is only correct through a *frame*,
 * and is why it is measured with `renderToLines()` rather than with an `arrange()`
 * of its own. A bare layout and paint of one of these draws an empty viewport, and
 * that is written down under "Windowing a long list" rather than worked around.
 */
function flexSized() {
	const host = ScrollBox({
		props: { 'flex-basis': 0, 'flex-grow': 1, 'min-height': 0, width: WIDTH },
		rows,
	});
	return { host, root: box({ 'flex-direction': 'column', height: HEIGHT }, host) };
}

/** The status quo: every row as `children`, which is what an app writes today. */
function children() {
	return ScrollBox({
		children: () =>
			box(
				{ 'flex-direction': 'column', 'flex-grow': 1 },
				...Array.from({ length: ROWS }, (_, i) => slot(i))
			),
		props: { height: HEIGHT, width: WIDTH },
	});
}

function find(at, want) {
	if (want(at)) {
		return at;
	}
	for (const child of at.children) {
		const found = find(child, want);
		if (found) {
			return found;
		}
	}
	return undefined;
}

const viewportIn = (host) => find(host, (e) => e.classes.includes('sigil-scroll-viewport'));

function countElements(element) {
	let n = 1;
	for (const child of element.children) {
		n += countElements(child);
	}
	return n;
}

/** Lays a tree out at the canvas size and paints it, which is one frame. */
function frame(root, offset, host = root) {
	viewportIn(host).scrollTo(0, offset);
	resolveStyles(root);
	arrange(root, { height: HEIGHT, width: WIDTH });
	const buffer = new CellBuffer(WIDTH, HEIGHT);
	paint(root, new Painter(buffer, new StyleTable()));
	return { grid: buffer.toString(), range: scrollRange(viewportIn(host)) };
}

const median = (list) => [...list].sort((a, b) => a - b)[Math.floor(list.length / 2)];
const ms = (from) => Number(process.hrtime.bigint() - from) / 1e6;

// Correctness before cost, because a window that changed a cell would be faster
// and wrong -- and a benchmark that did not check would report the number.
{
	let ok = true;
	for (const offset of [0, 1, 7, MID, ROWS - HEIGHT, ROWS * ROW_HEIGHT]) {
		const w = whole();
		const a = frame(w.root, offset, w.host);
		const b = frame(windowed(), offset);
		const c = frame(children(), offset);
		const same = a.grid === b.grid && a.grid === c.grid;
		const ranges =
			JSON.stringify(a.range) === JSON.stringify(b.range) &&
			JSON.stringify(a.range) === JSON.stringify(c.range);
		if (!same || !ranges) {
			ok = false;
			console.error(
				`offset ${offset}: grid ${same ? 'same' : 'DIFFERENT'}, range ${
					ranges ? 'same' : 'DIFFERENT'
				}`
			);
			console.error(`  whole    ${JSON.stringify(a.range)}\n${a.grid}`);
			console.error(`  windowed ${JSON.stringify(b.range)}\n${b.grid}`);
			console.error(`  children ${JSON.stringify(c.range)}\n${c.grid}`);
		}
	}
	if (!ok) {
		console.error('the window painted something else; not timing a wrong answer');
		process.exit(1);
	}
}

{
	const w = whole();
	resolveStyles(w.root);
	arrange(w.root, { height: HEIGHT, width: WIDTH });
	const v = windowed();
	resolveStyles(v);
	arrange(v, { height: HEIGHT, width: WIDTH });
	console.log(`${ROWS} rows, ${WIDTH}x${HEIGHT}, row height ${ROW_HEIGHT}`);
	console.log(`elements: whole ${countElements(w.root)}, windowed ${countElements(v)}`);
	console.log('identical output: true\n');
}

// -- the first frame, where the declared height is the input ------------------

const first = { arrange: {}, build: {}, cascade: {}, paint: {} };
for (const key of Object.keys(first)) {
	first[key] = { whole: [], windowed: [] };
}

for (let round = 0; round < ROUNDS; round++) {
	for (const side of ['whole', 'windowed']) {
		const offset = MID + round;

		let t = process.hrtime.bigint();
		const made = side === 'whole' ? whole() : { host: windowed() };
		made.root ??= made.host;
		first.build[side].push(ms(t));

		viewportIn(made.host).scrollTo(0, offset);

		t = process.hrtime.bigint();
		resolveStyles(made.root);
		first.cascade[side].push(ms(t));

		t = process.hrtime.bigint();
		arrange(made.root, { height: HEIGHT, width: WIDTH });
		first.arrange[side].push(ms(t));

		t = process.hrtime.bigint();
		paint(made.root, new Painter(new CellBuffer(WIDTH, HEIGHT), new StyleTable()));
		first.paint[side].push(ms(t));
	}
}

console.log('the first frame, with the declared height as the input removed:');
let wholeTotal = 0;
let windowTotal = 0;
for (const [name, data] of Object.entries(first)) {
	const a = median(data.whole);
	const b = median(data.windowed);
	wholeTotal += a;
	windowTotal += b;
	console.log(
		`  ${name.padEnd(8)} whole ${a.toFixed(3).padStart(8)}ms   windowed ${b
			.toFixed(3)
			.padStart(7)}ms   ${(a / b).toFixed(0)}x`
	);
}
console.log(
	`  ${'total'.padEnd(8)} whole ${wholeTotal.toFixed(3).padStart(8)}ms   windowed ${windowTotal
		.toFixed(3)
		.padStart(7)}ms   ${(wholeTotal / windowTotal).toFixed(0)}x\n`
);

// -- and a notch, against the list an app writes today -----------------------
//
// Read conservatively, which matters because the two sides do not pay the same
// things. A scroll marks **layout** and not style, so a renderer re-resolves
// nothing for a `children` list and its frame is the arrange and the paint. A
// window is a tree that changed, so it really does re-resolve -- and this gives
// it the whole `resolveStyles()` of its eighty elements rather than the marked
// subtrees a `Restyler` would narrow it to. So the window is charged more than
// it costs and the list it is measured against less, and the ratio is a floor.

const notch = { children: [], windowed: [] };
{
	const sides = { children: children(), windowed: windowed() };
	for (const host of Object.values(sides)) {
		viewportIn(host).scrollTo(0, MID);
		resolveStyles(host);
		arrange(host, { height: HEIGHT, width: WIDTH });
	}

	for (let round = 0; round < ROUNDS; round++) {
		for (const side of ['children', 'windowed']) {
			const host = sides[side];
			const t = process.hrtime.bigint();
			for (let i = 0; i < ITERATIONS; i++) {
				// one wheel notch is three lines
				viewportIn(host).scrollTo(0, MID + round * 32 + i * 3);
				if (side === 'windowed') {
					resolveStyles(host);
				}
				arrange(host, { height: HEIGHT, width: WIDTH });
				paint(host, new Painter(new CellBuffer(WIDTH, HEIGHT), new StyleTable()));
			}
			notch[side].push(ms(t) / ITERATIONS);
		}
	}
}

console.log('a wheel notch, as a renderer pays for one:');
console.log('  children: the arrange and the paint, because a scroll marks no style');
console.log('  windowed: the cascade as well, because a new window is a tree that changed');
for (const side of ['children', 'windowed']) {
	const s = [...notch[side]].sort((a, b) => a - b);
	console.log(
		`  ${side.padEnd(8)}: min ${s[0].toFixed(3)}ms  median ${median(notch[side]).toFixed(
			3
		)}ms  max ${s.at(-1).toFixed(3)}ms`
	);
}
console.log(`  speedup: ${(median(notch.children) / median(notch.windowed)).toFixed(0)}x median\n`);
// -- and the first frame of a flex-sized list, as a frame pays for it ---------
//
// The section above is a *layout*: `resolveStyles()` and `arrange()` by hand, which
// is what every other script here measures and is the shape the window's own tests
// are written in. It cannot answer for the flex-sized case, and that is the whole
// of SIG-132: a list bounded by its parent has no height for `rowWindow()` to read
// before something has arranged it, so the window its first frame gets is one a
// **frame** rebuilds -- after the layout that gave the viewport a box and before
// the paint. `renderToLines()` is that frame here, because a string is what a
// script can compare byte for byte; the renderer's `settle()` takes the same pass
// through the same `settleResized()`.
//
// So the two sides are the same component with the same one input removed, exactly
// as above, and the question is whether a list that declared nothing now costs
// what a list that declared its height costs. Each round builds both afresh,
// because the first frame is the subject.

/** A frame rather than a layout: this is what dispatches `onResize`. */
const framed = (root) => renderToLines(root, { colorLevel: 3, height: HEIGHT, width: WIDTH });

{
	let ok = true;
	for (const offset of [0, 1, 7, MID, ROWS - HEIGHT, ROWS * ROW_HEIGHT]) {
		const flex = flexSized();
		const declared = windowed();
		viewportIn(flex.host).scrollTo(0, offset);
		viewportIn(declared).scrollTo(0, offset);
		const a = framed(flex.root);
		const b = framed(declared);
		if (a.join('\n') !== b.join('\n')) {
			ok = false;
			console.error(`offset ${offset}: the flex-sized frame drew something else`);
			console.error(`  flex\n${a.join('\n')}`);
			console.error(`  declared\n${b.join('\n')}`);
		}
	}
	if (!ok) {
		console.error('not timing a wrong answer');
		process.exit(1);
	}
	const flex = flexSized();
	const before = countElements(flex.root);
	framed(flex.root);
	console.log('the first frame of a flex-sized list, as a frame pays for one:');
	console.log(
		`  identical lines: true, elements: ${before} built, ${countElements(flex.root)} after the frame`
	);
}

const frames = { declared: [], flex: [] };
for (let round = 0; round < ROUNDS; round++) {
	for (const side of ['flex', 'declared']) {
		const made = side === 'flex' ? flexSized() : { host: windowed() };
		made.root ??= made.host;
		viewportIn(made.host).scrollTo(0, MID + round);

		const t = process.hrtime.bigint();
		framed(made.root);
		frames[side].push(ms(t));
	}
}

for (const side of ['flex', 'declared']) {
	const sorted = [...frames[side]].sort((x, y) => x - y);
	console.log(
		`  ${side.padEnd(8)}: min ${sorted[0].toFixed(3)}ms  median ${median(frames[side]).toFixed(
			3
		)}ms  max ${sorted.at(-1).toFixed(3)}ms`
	);
}
console.log(
	`  flex / declared: ${(median(frames.flex) / median(frames.declared)).toFixed(2)}x median\n`
);

console.log(
	'the arrange is no longer the frame; what is left is under "A scroll box" in AGENTS.md.'
);
