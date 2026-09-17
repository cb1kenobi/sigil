/**
 * A chart, drawn at four times the resolution the grid has.
 *
 *   node demos/canvas/01-sparkline.js
 *   node demos/canvas/01-sparkline.js | cat     <- the same bytes, uninterpreted
 *
 * A cell is the smallest thing the grid can address, so a line drawn in cells is
 * a staircase. Braille gives each cell a 2x4 grid of its own, which is enough
 * for the line to look like a line -- and it is still one ordinary character per
 * cell, so it works anywhere a terminal has the font, including over ssh and
 * inside tmux.
 *
 * The numbers at the bottom are the point of the canvas rather than of braille:
 * what it costs to change what is on screen.
 */
import { createCanvas, Dots, palette } from '@ttylabs/sigil/canvas';

const WIDTH = 60;
const HEIGHT = 8;

/** A series that looks like something being measured rather than a sine wave. */
function series(length, offset = 0) {
	const out = [];
	for (let i = 0; i < length; i++) {
		const t = i + offset;
		out.push(0.5 + Math.sin(t / 9) * 0.28 + Math.sin(t / 3.3) * 0.12 + Math.sin(t / 1.7) * 0.05);
	}
	return out;
}

/** Plots a series across a dot grid, joining the samples. */
function plot(dots, values) {
	dots.clear();
	const top = dots.dotHeight - 1;
	let previous;
	for (let x = 0; x < values.length && x < dots.dotWidth; x++) {
		const y = Math.round((1 - values[x]) * top);
		if (previous !== undefined) {
			// joined rather than scattered: the gap between two samples is where a
			// plot at this resolution actually earns the resolution
			dots.line(x - 1, previous, x, y);
		}
		previous = y;
	}
}

const canvas = createCanvas({ width: WIDTH, height: HEIGHT });
// one row shorter than the canvas, so the label has a row of its own
const dots = new Dots(WIDTH, HEIGHT - 1);

/** Paints the label and the chart. `mark` puts a dot on the bottom axis. */
function frame(mark) {
	canvas.paint((p) => {
		p.text(0, 0, 'memory', { fg: palette(8) });
		dots.blit(p, 0, 1, { fg: palette(6) });
		if (mark !== undefined) {
			p.text(mark, HEIGHT - 1, '▲', { fg: palette(1) });
		}
	});
}

plot(dots, series(dots.dotWidth));
frame();

// the canvas paints relative to wherever the cursor is, and cannot scroll to
// make room -- so give it its rows first, then walk back up to its top left.
// This is the whole of what an inline backend does
process.stdout.write('\n'.repeat(HEIGHT));
process.stdout.write(`[${HEIGHT}A`);
process.stdout.write(canvas.present({ full: true }).output);
process.stdout.write(`[${HEIGHT}B\r\n`);

// Three costs, because the honest answer is that it depends on what moved.
const first = canvas.present({ full: true }).output.length;

plot(dots, series(dots.dotWidth, 1));
frame();
const scrolled = canvas.present().output.length;

frame(10);
const marked = canvas.present().output.length;

console.log(`first frame          ${String(first).padStart(4)} bytes   everything`);
console.log(
	`scrolled one sample  ${String(scrolled).padStart(4)} bytes   a scroll moves most cells`
);
console.log(
	`moved one marker     ${String(marked).padStart(4)} bytes   only the cells that differ`
);
