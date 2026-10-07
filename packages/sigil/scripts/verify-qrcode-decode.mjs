import { strip } from '../dist/ansi.mjs';
import { encodeQr, qrcode } from '../dist/components.mjs';
/**
 * Decodes the QR component's own drawn cells with a decoder that is not ours.
 *
 *   pnpm build
 *   cd "$(mktemp -d)" && npm install jsqr@1.4.0 && cd -
 *   node packages/sigil/scripts/verify-qrcode-decode.mjs <that temp directory>
 *
 * Committed for `benchmark-paint-cull.mjs`'s reason, read one layer along: a
 * number in a pull request is a claim the next reader has to trust, and a script
 * they can run is one they can check. The number is **168 of 168**, and it is the
 * middle of the three layers this component's correctness rests on.
 *
 * `test/components/qrcode.test.ts` checks the *matrix*, against 24 reference
 * symbols from another encoder, and says nothing about the **drawing**. So this
 * turns the component's own output back into the pixels a terminal would paint --
 * a half block becomes one column by two pixel rows, a large module two columns by
 * one -- and hands it to a real locate-and-decode pipeline. It is as close as
 * software gets to the phone check in `terminal-probe.mjs --qrcode`, and it is
 * what makes the polarity decision and the glyph table claims rather than hopes.
 *
 * `jsqr` is **not a dependency** of anything here, which is why it is installed by
 * hand into a directory outside this repository and passed in: zero production
 * dependencies in `@ttylabs/sigil` is a hard constraint, and a devDependency taken
 * for a by-hand script is still a dependency somebody has to explain. The fixture
 * says how to regenerate itself the same way and for the same reason.
 *
 * It also answers the question the quiet zone exists for, which a clean bitmap
 * cannot: a code with no quiet zone against a field of **dark** cells -- which is
 * what a dark terminal is -- is not found at all, while one module of it is enough.
 * The spec asks for four because a camera at an angle through a blur needs more
 * than a decoder reading a perfect image does.
 */
import { createRequire } from 'node:module';
import { resolve } from 'node:path';

const where = process.argv[2];
if (where === undefined) {
	// and `exit` rather than a flag, because what follows resolves `jsqr` out of
	// that directory: setting the exit code and carrying on printed the usage and
	// then a module-not-found stack under it, which is a worse answer than either
	process.stderr.write(
		'Pass the directory jsqr was installed into:\n' +
			'  cd "$(mktemp -d)" && npm install jsqr@1.4.0\n' +
			'  node packages/sigil/scripts/verify-qrcode-decode.mjs <that directory>\n'
	);
	process.exit(1);
}

/** How many pixels a module becomes, which only has to be enough for the decoder. */
const SCALE = 6;

/**
 * The drawn lines as a grid of pixels, true where one is dark.
 *
 * The inverse of what the component drew: a glyph puts the *foreground* on
 * screen, and above colour level 0 the foreground is the dark half of the code
 * while at level 0 on a dark terminal it is the light half -- which is the whole
 * polarity decision, read backwards. Getting it the wrong way round here would
 * decode a code this script had inverted rather than the one the component drew.
 *
 * @param {readonly string[]} lines - The drawn cells, with no sequences in them.
 * @param {'compact' | 'large'} form - How many cells a module got.
 * @param {boolean} invert - Whether the drawn modules are the light ones.
 * @returns {boolean[][]} The pixels.
 */
function pixels(lines, form, invert) {
	const columns = [...lines[0]].length;
	const rows = form === 'large' ? lines.length : lines.length * 2;
	const wide = form === 'large' ? columns / 2 : columns;
	const grid = Array.from({ length: rows }, () => Array.from({ length: wide }, () => false));

	for (const [y, line] of lines.entries()) {
		const cells = [...line];
		for (let x = 0; x < cells.length; x++) {
			const cell = cells[x];
			if (form === 'large') {
				// two columns per module, so only the first of each pair is read
				if (x % 2 !== 0) {
					continue;
				}
				grid[y][x / 2] = (cell === '█') !== invert;
			} else {
				grid[y * 2][x] = (cell === '█' || cell === '▀') !== invert;
				if (y * 2 + 1 < rows) {
					grid[y * 2 + 1][x] = (cell === '█' || cell === '▄') !== invert;
				}
			}
		}
	}

	return grid;
}

/**
 * The pixels as the RGBA a decoder takes, scaled.
 *
 * @param {readonly boolean[][]} grid - The pixels.
 * @param {boolean} [surround] - What to put in a six-module border, if any.
 * @returns {{ data: Uint8ClampedArray, height: number, width: number }} The image.
 */
function rgba(grid, surround) {
	const pad = surround === undefined ? 0 : 6;
	const high = grid.length + pad * 2;
	const wide = grid[0].length + pad * 2;
	const height = high * SCALE;
	const width = wide * SCALE;
	const data = new Uint8ClampedArray(width * height * 4);

	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			const mx = Math.floor(x / SCALE) - pad;
			const my = Math.floor(y / SCALE) - pad;
			const outside = mx < 0 || my < 0 || mx >= grid[0].length || my >= grid.length;
			const dark = outside ? surround === true : grid[my][mx];
			const value = dark ? 0 : 255;
			const at = (y * width + x) * 4;
			data[at] = value;
			data[at + 1] = value;
			data[at + 2] = value;
			data[at + 3] = 255;
		}
	}

	return { data, height, width };
}

const require = createRequire(`${resolve(where ?? '.')}/`);
/** @type {(data: Uint8ClampedArray, width: number, height: number) => { data: string } | null} */
const jsQR = require('jsqr');

/** Reads a drawn code back, and whether it came out as what went in. */
function reads(text, opts, form, invert, surround) {
	const lines = qrcode(text, { form, ...opts })
		.split('\n')
		.map((line) => strip(line));
	// the string renderer drops a trailing run of blanks that paint nothing, so
	// the right-hand quiet zone has to be put back before the image is built --
	// which on a terminal the background provides
	const width = Math.max(...lines.map((line) => [...line].length));
	const padded = lines.map((line) => line + ' '.repeat(width - [...line].length));
	const image = rgba(pixels(padded, form, invert), surround);
	const read = jsQR(image.data, image.width, image.height);
	return read !== null && read.data === text;
}

const PAYLOADS = [
	'https://github.com/cb1kenobi/sigil',
	'01234567',
	'HELLO WORLD',
	'otpauth://totp/Example:alice@example.com?secret=JBSWY3DPEHPK3PXP&issuer=Example',
	'café naïve \u{1F600}',
	'7'.repeat(400),
	'z'.repeat(900),
];

/** The three a destination can be: painted, and level 0 against either scheme. */
const DESTINATIONS = [
	[{ colorLevel: 3 }, false],
	[{ colorLevel: 0, colorScheme: 'dark' }, true],
	[{ colorLevel: 0, colorScheme: 'light' }, false],
];

let pass = 0;
let fail = 0;

for (const text of PAYLOADS) {
	for (const ecc of ['L', 'M', 'Q', 'H']) {
		for (const form of ['compact', 'large']) {
			for (const [opts, invert] of DESTINATIONS) {
				if (reads(text, { ecc, ...opts }, form, invert)) {
					pass++;
				} else {
					fail++;
					process.stdout.write(
						`FAILED ${ecc} ${form} ${JSON.stringify(opts)} ${JSON.stringify(text).slice(0, 30)}\n`
					);
				}
			}
		}
	}
}

process.stdout.write(`\ndecoded ${pass} of ${pass + fail}\n`);

// and the quiet zone, which is the one claim a clean bitmap cannot settle
process.stdout.write('\nwhat the quiet zone buys, against a field of dark cells:\n');
const url = PAYLOADS[0];
for (const quietZone of [0, 1, 2, 3, 4]) {
	const light = reads(url, { colorLevel: 3, quietZone }, 'large', false, false);
	const dark = reads(url, { colorLevel: 3, quietZone }, 'large', false, true);
	process.stdout.write(
		`  ${quietZone}: surrounded by light ${light ? 'decoded' : 'NOT decoded'}, ` +
			`by dark ${dark ? 'decoded' : 'NOT decoded'}\n`
	);
}

// the braille form this component refuses to offer, drawn as a terminal would:
// discrete dots with a gap about as wide as the dot, which is what does not tile
process.stdout.write('\nand the refused braille form, which is expected NOT to decode:\n');
const code = encodeQr(url);
// the spec's four rather than this component's default of one, deliberately: a
// wider quiet zone is the favourable case for the form being refused, so a
// braille code nothing finds at four is nothing found at one either
const quiet = 4;
const span = code.size + quiet * 2;
const DOT = 3;
const STEP = DOT * 2;
const wide = span * STEP;
const braille = new Uint8ClampedArray(wide * wide * 4).fill(255);
for (let my = 0; my < span; my++) {
	for (let mx = 0; mx < span; mx++) {
		const inside = mx >= quiet && my >= quiet && mx < quiet + code.size && my < quiet + code.size;
		if (!(inside && code.modules[my - quiet][mx - quiet])) {
			continue;
		}
		for (let dy = 0; dy < DOT; dy++) {
			for (let dx = 0; dx < DOT; dx++) {
				const at = ((my * STEP + 1 + dy) * wide + mx * STEP + 1 + dx) * 4;
				braille[at] = 0;
				braille[at + 1] = 0;
				braille[at + 2] = 0;
			}
		}
	}
}
const dots = jsQR(braille, wide, wide);
process.stdout.write(
	`  a dot grid with a gap the size of the dot: ${dots ? 'decoded' : 'NOT decoded'} ` +
		`(${wide}x${wide} pixels)\n`
);

if (fail > 0) {
	process.exitCode = 1;
}
