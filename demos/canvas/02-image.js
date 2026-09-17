/**
 * A picture, at two pixels per cell.
 *
 *   node demos/canvas/02-image.js
 *   node demos/canvas/02-image.js | cat        <- the same bytes, uninterpreted
 *   FORCE_COLOR=1 node demos/canvas/02-image.js
 *
 * A cell can hold one character in one foreground over one background. An upper
 * half block spends that on two pixels instead: the foreground paints the top
 * half and the background paints the bottom, so a row of cells is two rows of
 * picture. Half the vertical resolution braille gives, and all of the colour,
 * which is the trade a picture wants and a plot does not.
 *
 * Generated rather than loaded, because decoding a PNG would need a dependency
 * and the runtime does not get to have any.
 */
import { createCanvas, Pixels, rgb } from '@ttylabs/sigil/canvas';

const WIDTH = 70;
const HEIGHT = 18;

/** Escape time for a point, smoothed so the bands do not step. */
function escape(cx, cy, limit = 60) {
	let x = 0;
	let y = 0;
	for (let i = 0; i < limit; i++) {
		const x2 = x * x;
		const y2 = y * y;
		if (x2 + y2 > 4) {
			// the fractional part removes the banding a plain iteration count has
			return (i + 1 - Math.log2(Math.log2(x2 + y2) / 2)) / limit;
		}
		y = 2 * x * y + cy;
		x = x2 - y2 + cx;
	}
	return undefined;
}

/** A colour ramp: deep blue through teal to a pale edge. */
function ramp(t) {
	const eased = Math.sqrt(Math.max(0, Math.min(1, t)));
	return rgb(
		Math.round(20 + 235 * eased ** 3),
		Math.round(30 + 200 * eased ** 1.4),
		Math.round(70 + 150 * eased ** 0.7)
	);
}

const pixels = new Pixels(WIDTH, HEIGHT);

for (let py = 0; py < pixels.pixelHeight; py++) {
	for (let px = 0; px < pixels.width; px++) {
		// the plane, framed so the interesting part fills the box
		const cx = -2.2 + (px / (pixels.width - 1)) * 2.9;
		const cy = -1.2 + (py / (pixels.pixelHeight - 1)) * 2.4;
		const t = escape(cx, cy);
		// inside the set is left uncoloured, which `blit` skips rather than
		// painting -- so the terminal's own background shows through
		if (t !== undefined) {
			pixels.set(px, py, ramp(t));
		}
	}
}

const canvas = createCanvas({ width: WIDTH, height: HEIGHT });
canvas.paint((p) => pixels.blit(p, 0, 0));

// give the canvas its rows before painting: movement is relative and cannot
// scroll, so a canvas drawn at the bottom of the screen paints onto one line
process.stdout.write('\n'.repeat(HEIGHT));
process.stdout.write(`[${HEIGHT}A`);
const frame = canvas.present({ full: true });
process.stdout.write(frame.output);
process.stdout.write(`[${HEIGHT}B\r\n`);

console.log(`${WIDTH} x ${HEIGHT} cells, ${pixels.width} x ${pixels.pixelHeight} pixels`);
console.log(`${frame.output.length} bytes`);

// Worth comparing against the chart in 01-sparkline.js, which is a similar
// number of cells for a fraction of the bytes. Nearly every cell here carries a
// different 24-bit foreground *and* background, and a style that changes every
// cell is the case the diff cannot help with -- there is no run to extend and
// no gap to skip. A picture is expensive and a plot is not, which is the other
// half of why these are two different tools rather than one.
