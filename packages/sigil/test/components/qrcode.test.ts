import { strip } from '../../src/ansi/index.js';
import {
	encodeQr,
	type QrCode,
	type QrEcc,
	qrcode,
	qrcodeView,
	qrLines,
} from '../../src/components/qrcode.js';
import { renderToString } from '../../src/element/index.js';
import { themedCascade } from '../../src/theme/index.js';
import { stringWidth } from '../../src/width/index.js';
import { QR_SEGMENTS, QR_SIZES, QR_VECTORS } from './qrcode-vectors.js';
import { describe, expect, it } from 'vitest';

/** A symbol as the reference vectors spell one, so a failure prints a picture. */
function rowsOf(code: QrCode): string[] {
	return code.modules.map((row) => row.map((dark) => (dark ? '#' : '.')).join(''));
}

/** The four levels, so that nothing below has to be written out four times. */
const LEVELS: readonly QrEcc[] = ['L', 'M', 'Q', 'H'];

describe('the encoder, against an encoder that is not this one', () => {
	// the whole claim of this file. Every one of these matrices came out of the
	// `qrcode` npm package rather than out of this encoder, so an agreement is a
	// statement about the arithmetic rather than about self-consistency -- which
	// is the one thing a decoder written beside the encoder could never say
	for (const vector of QR_VECTORS) {
		it(`should agree about ${JSON.stringify(vector.text).slice(0, 36)} at level ${vector.ecc}, which is ${vector.why}`, () => {
			const code = encodeQr(vector.text, { ecc: vector.ecc });

			expect(code.mode).to.equal(vector.mode);
			expect(code.version).to.equal(vector.version);
			expect(code.mask).to.equal(vector.mask);
			expect(code.size).to.equal(vector.version * 4 + 17);
			expect(rowsOf(code)).to.deep.equal([...vector.rows]);
		});
	}

	// the two largest payloads whose matrices are not kept, for the reason the
	// fixture records. The version is still worth asserting, because it is what
	// the capacity tables and the count-indicator band come to
	for (const vector of QR_SIZES) {
		it(`should pick version ${vector.version} for ${vector.why}`, () => {
			const code = encodeQr(vector.text, { ecc: vector.ecc });
			expect(code.mode).to.equal(vector.mode);
			expect(code.version).to.equal(vector.version);
		});
	}
});

describe('the published capacities', () => {
	// the spec's own character-capacity table, which is the other independent
	// source there is: it is derived here from two tables of eighty numbers plus
	// the symbol's geometry, so agreeing with the published figures at the
	// extremes is what says the derivation is the right one
	const MAX: Readonly<Record<QrEcc, { alnum: number; bytes: number; digits: number }>> = {
		H: { alnum: 1852, bytes: 1273, digits: 3057 },
		L: { alnum: 4296, bytes: 2953, digits: 7089 },
		M: { alnum: 3391, bytes: 2331, digits: 5596 },
		Q: { alnum: 2420, bytes: 1663, digits: 3993 },
	};

	for (const ecc of LEVELS) {
		it(`should hold exactly what the spec says version 40-${ecc} holds`, () => {
			const { alnum, bytes, digits } = MAX[ecc];

			expect(encodeQr('7'.repeat(digits), { ecc }).version).to.equal(40);
			expect(() => encodeQr('7'.repeat(digits + 1), { ecc })).to.throw(/more than a version 40/);

			expect(encodeQr('Z'.repeat(alnum), { ecc }).version).to.equal(40);
			expect(() => encodeQr('Z'.repeat(alnum + 1), { ecc })).to.throw(/more than a version 40/);

			expect(encodeQr('b'.repeat(bytes), { ecc }).version).to.equal(40);
			expect(() => encodeQr('b'.repeat(bytes + 1), { ecc })).to.throw(/more than a version 40/);
		});
	}

	// and the other end of the same table: version 1 is the one a reader can
	// check against the spec by eye, and the three modes part company there by
	// the most
	it('should hold exactly what the spec says version 1 holds', () => {
		const held: Readonly<Record<QrEcc, readonly [number, number, number]>> = {
			H: [17, 10, 7],
			L: [41, 25, 17],
			M: [34, 20, 14],
			Q: [27, 16, 11],
		};

		for (const ecc of LEVELS) {
			const [digits, alnum, bytes] = held[ecc];
			expect(encodeQr('7'.repeat(digits), { ecc }).version, `${ecc} digits`).to.equal(1);
			expect(encodeQr('7'.repeat(digits + 1), { ecc }).version, `${ecc} digits+1`).to.equal(2);
			expect(encodeQr('Z'.repeat(alnum), { ecc }).version, `${ecc} alnum`).to.equal(1);
			expect(encodeQr('Z'.repeat(alnum + 1), { ecc }).version, `${ecc} alnum+1`).to.equal(2);
			expect(encodeQr('b'.repeat(bytes), { ecc }).version, `${ecc} bytes`).to.equal(1);
			expect(encodeQr('b'.repeat(bytes + 1), { ecc }).version, `${ecc} bytes+1`).to.equal(2);
		}
	});
});

describe('every version, at every level', () => {
	// the exhaustive walk, which is where the per-version tables live: a block
	// count or an ECC length that is wrong for one version is a symbol whose
	// codewords do not fill it, and nothing about a handful of hand-picked
	// payloads would say which version
	it('should produce a well-formed symbol for all 160 combinations', () => {
		for (let version = 1; version <= 40; version++) {
			for (const ecc of LEVELS) {
				const code = encodeQr('x', { ecc, version });
				const size = version * 4 + 17;

				expect(code.version, `v${version} ${ecc}`).to.equal(version);
				expect(code.size, `v${version} ${ecc}`).to.equal(size);
				expect(code.modules.length, `v${version} ${ecc}`).to.equal(size);
				for (const row of code.modules) {
					expect(row.length).to.equal(size);
				}

				// the three finders, which are the one thing in a symbol whose
				// position and contents are the same for every version
				for (const [ox, oy] of [
					[0, 0],
					[size - 7, 0],
					[0, size - 7],
				]) {
					for (let dy = 0; dy < 7; dy++) {
						for (let dx = 0; dx < 7; dx++) {
							const ring = Math.max(Math.abs(dx - 3), Math.abs(dy - 3));
							expect(code.modules[oy + dy][ox + dx], `v${version} finder`).to.equal(ring !== 2);
						}
					}
				}

				// the timing patterns, which run between the finders
				for (let i = 8; i < size - 8; i++) {
					expect(code.modules[6][i], `v${version} timing row`).to.equal(i % 2 === 0);
					expect(code.modules[i][6], `v${version} timing column`).to.equal(i % 2 === 0);
				}

				// and the dark module, which is the one module that is always dark
				expect(code.modules[size - 8][8], `v${version} dark module`).to.equal(true);
			}
		}
	});
});

describe('the mode', () => {
	it('should take the narrowest mode that can spell the whole string', () => {
		expect(encodeQr('12345').mode).to.equal('numeric');
		expect(encodeQr('ABC123').mode).to.equal('alphanumeric');
		expect(encodeQr('$%*+-./: ').mode).to.equal('alphanumeric');
		// one lower-case letter is what takes a whole payload into byte mode,
		// which is why a URL is byte and a SHOUTED one is not
		expect(encodeQr('ABC12a').mode).to.equal('byte');
		expect(encodeQr('https://example.com').mode).to.equal('byte');
		expect(encodeQr('HTTP://EXAMPLE.COM').mode).to.equal('alphanumeric');
	});

	it('should count bytes rather than characters in byte mode', () => {
		// three code points and seven UTF-8 bytes, which is what the count
		// indicator counts -- a version chosen off the character count would be
		// one too small for anything but ASCII
		const code = encodeQr('aé\u{1F600}');
		expect(code.mode).to.equal('byte');
		expect(code.version).to.equal(1);

		// and the boundary, at level H, where version 1 holds seven bytes: one
		// astral character is four and two are eight
		expect(encodeQr('\u{1F600}', { ecc: 'H' }).version).to.equal(1);
		expect(encodeQr('\u{1F600}\u{1F600}', { ecc: 'H' }).version).to.equal(2);
	});
});

describe('the options', () => {
	it('should take the version as a floor rather than as an answer', () => {
		expect(encodeQr('x', { version: 10 }).version).to.equal(10);
		// a payload that does not fit the floor moves up rather than being
		// refused, because refusing a code over a size preference is the worse
		// of the two answers
		// 300 bytes at level L is version 11, which holds 321 where version 10
		// holds 271 -- so a floor of 2 is simply ignored
		expect(encodeQr('x'.repeat(300), { ecc: 'L', version: 2 }).version).to.equal(11);
	});

	it('should take a named mask over the penalty score', () => {
		// "01234567" at level M scores lowest on mask 0, which every vector
		// above agrees about, so naming any other one has to move the matrix
		const chosen = encodeQr('01234567', { ecc: 'M' });
		expect(chosen.mask).to.equal(0);

		for (let mask = 0; mask < 8; mask++) {
			const code = encodeQr('01234567', { ecc: 'M', mask });
			expect(code.mask).to.equal(mask);
			if (mask !== 0) {
				expect(rowsOf(code)).to.not.deep.equal(rowsOf(chosen));
			}
		}
	});

	it('should refuse what it cannot do rather than guessing', () => {
		// the degenerate inputs, walked rather than reasoned about. Each is a
		// value somebody reaches by interpolating rather than by meaning it, and
		// each would otherwise be a code that is wrong without saying so
		expect(() => encodeQr('')).to.throw(/needs something to encode/);
		expect(() => encodeQr('x', { ecc: 'X' as QrEcc })).to.throw(/Unknown QR error-correction/);
		// `constructor` reads back truthy on a plain object, which is why the
		// level is checked with `Object.hasOwn` rather than by truthiness
		expect(() => encodeQr('x', { ecc: 'constructor' as QrEcc })).to.throw(/Unknown QR/);
		expect(() => encodeQr('x', { version: 0 })).to.throw(/from 1 to 40/);
		expect(() => encodeQr('x', { version: 41 })).to.throw(/from 1 to 40/);
		expect(() => encodeQr('x', { version: 1.5 })).to.throw(/from 1 to 40/);
		expect(() => encodeQr('x', { version: Number.NaN })).to.throw(/from 1 to 40/);
		expect(() => encodeQr('x', { version: Number.POSITIVE_INFINITY })).to.throw(/from 1 to 40/);
		expect(() => encodeQr('x', { mask: -1 })).to.throw(/from 0 to 7/);
		expect(() => encodeQr('x', { mask: 8 })).to.throw(/from 0 to 7/);
		expect(() => encodeQr('x', { mask: 1.5 })).to.throw(/from 0 to 7/);
		expect(() => encodeQr('x', { mask: Number.NaN })).to.throw(/from 0 to 7/);
	});

	it('should say what a payload that does not fit would need', () => {
		// the message is what somebody acts on, so it names the level and says
		// that a lower one holds more -- which is the one thing they can change
		expect(() => encodeQr('b'.repeat(3000))).to.throw(/level M/);
		expect(() => encodeQr('b'.repeat(3000))).to.throw(/lower error-correction level holds more/);
	});
});

describe('the quiet zone', () => {
	it('should put four light modules on every side', () => {
		const code = encodeQr('x');
		const lines = qrLines(code, { form: 'large' });

		// large is one row per module, so the grid is the symbol plus eight
		expect(lines.length).to.equal(code.size + 8);
		for (const line of lines) {
			expect(line.length).to.equal((code.size + 8) * 2);
		}

		// the four rows and four columns at each edge, which is the thing a
		// scanner locates the symbol against
		const light = ' '.repeat((code.size + 8) * 2);
		for (const row of [0, 1, 2, 3, code.size + 4, code.size + 5, code.size + 6, code.size + 7]) {
			expect(lines[row], `row ${row}`).to.equal(light);
		}
		for (const line of lines) {
			expect(line.slice(0, 8)).to.equal('        ');
			expect(line.slice(-8)).to.equal('        ');
		}
	});

	it('should be a number of modules rather than of cells, so both forms agree', () => {
		// which is the whole reason it is in the matrix: in the compact form one
		// cell is two modules vertically and one horizontally, so a quiet zone
		// counted in cells would be four on one axis and two on the other
		const code = encodeQr('x');
		const compact = qrLines(code, { form: 'compact' });
		const large = qrLines(code, { form: 'large' });

		expect(compact[0].length).to.equal(code.size + 8);
		expect(large[0].length).to.equal((code.size + 8) * 2);
		// and the first two compact rows are the first four module rows, which
		// are all quiet zone
		expect(compact[0]).to.equal(' '.repeat(code.size + 8));
		expect(compact[1]).to.equal(' '.repeat(code.size + 8));
	});

	it('should widen and narrow where it is asked, and refuse what is not a count', () => {
		const code = encodeQr('x');
		expect(qrLines(code, { form: 'large', quietZone: 0 })[0].length).to.equal(code.size * 2);
		expect(qrLines(code, { form: 'large', quietZone: 8 })[0].length).to.equal((code.size + 16) * 2);
		expect(() => qrLines(code, { quietZone: -1 })).to.throw(/whole number of modules/);
		expect(() => qrLines(code, { quietZone: 1.5 })).to.throw(/whole number of modules/);
		expect(() => qrLines(code, { quietZone: Number.NaN })).to.throw(/whole number of modules/);
	});

	it('should pad an odd module-row count with one more light row', () => {
		// version 1 with the spec's quiet zone is 29 module rows, which is odd:
		// without the extra row the last cell holds one module and half of
		// nothing, and the spec's four is a minimum so a fifth row is legal
		const code = encodeQr('x');
		expect(code.size + 8).to.equal(29);

		const lines = qrLines(code);
		expect(lines.length).to.equal(15);
		// the last cell is the 29th module row over a row that is not there, so
		// it is an upper half or nothing and never a lower half or a full block
		for (const cell of lines[14]) {
			expect([' ', '▀']).to.contain(cell);
		}

		// and an even count needs no padding: a quiet zone of 5 is 31 rows, 4 is
		// 29, so 3 is 27 -- also odd -- and 4 with version 2 is 33. The even one
		// to hand is a quiet zone of 3 on version 2, which is 31. So: pick one
		// arithmetically rather than by hand
		for (let quiet = 0; quiet <= 6; quiet++) {
			const span = code.size + quiet * 2;
			expect(qrLines(code, { quietZone: quiet }).length).to.equal((span + (span % 2)) / 2);
		}
	});
});

describe('the two forms', () => {
	it('should draw a module about square in both', () => {
		// a cell is about twice as tall as it is wide, so the claim is that a
		// module is one column by half a cell in one form and two columns by one
		// cell in the other -- which is this arithmetic and nothing else
		const code = encodeQr('x');
		const span = code.size + 8;

		const compact = qrLines(code, { form: 'compact' });
		expect(compact[0].length / span).to.equal(1);
		expect(compact.length / span).to.be.closeTo(0.5, 0.02);

		const large = qrLines(code, { form: 'large' });
		expect(large[0].length / span).to.equal(2);
		expect(large.length / span).to.equal(1);
	});

	it('should hold the same modules in both', () => {
		// the differential: two renderings of one symbol, read back as modules
		// and required to agree. A form that lost a row or doubled a column
		// would otherwise look perfectly plausible
		const code = encodeQr('https://example.com', { ecc: 'Q' });
		const span = code.size + 8;
		const compact = qrLines(code, { form: 'compact' });
		const large = qrLines(code, { form: 'large' });

		for (let y = 0; y < span; y++) {
			for (let x = 0; x < span; x++) {
				const cell = compact[Math.floor(y / 2)][x];
				const fromCompact =
					y % 2 === 0 ? cell === '▀' || cell === '█' : cell === '▄' || cell === '█';
				const fromLarge = large[y][x * 2] === '█';
				expect(fromLarge, `${x},${y}`).to.equal(fromCompact);

				// and the two columns of a large module are the same module
				expect(large[y][x * 2 + 1]).to.equal(large[y][x * 2]);

				// which is what the symbol says, with the quiet zone around it
				const inside = x >= 4 && y >= 4 && x < code.size + 4 && y < code.size + 4;
				expect(fromLarge).to.equal(inside ? code.modules[y - 4][x - 4] : false);
			}
		}
	});

	it('should draw with four glyphs and nothing else', () => {
		// which is what keeps a control character out of the grid: `put()` throws
		// on one rather than dropping it, and a throw from inside paint takes the
		// frame and the renderer with it. The payload never reaches the output --
		// only the matrix does -- so no input can put one there
		const payloads = ['x', '\u0000\u0007\n\t', '\u{1F600}', '\u001b[31m', 'a'.repeat(400)];
		for (const payload of payloads) {
			for (const form of ['compact', 'large'] as const) {
				for (const invert of [false, true]) {
					const lines = qrLines(encodeQr(payload), { form, invert });
					const seen = new Set(lines.join(''));
					for (const glyph of seen) {
						expect([' ', '▀', '▄', '█'], JSON.stringify(payload)).to.contain(glyph);
					}
				}
			}
		}
	});

	it('should draw with glyphs that are one column wide', () => {
		// U+2588 is East Asian Width Ambiguous, so a width table that read it as
		// two would draw a code twice as wide as the view says it measures --
		// which is the one assumption the layout rests on here
		for (const glyph of [' ', '▀', '▄', '█']) {
			expect(stringWidth(glyph)).to.equal(1);
		}

		const { element, width } = qrcodeView('x', { colorLevel: 3 });
		const lines = renderToString(element, {
			cascade: themedCascade({}),
			colorLevel: 3,
			width,
		}).split('\n');
		for (const line of lines) {
			expect(stringWidth(strip(line))).to.equal(width);
		}
	});
});

describe('the polarity', () => {
	it('should draw the dark modules wherever it can paint its own colours', () => {
		for (const level of [1, 2, 3] as const) {
			const lines = qrLines(encodeQr('x'), { invert: false });
			const view = qrcodeView('x', { colorLevel: level });
			expect(qrLines(view.code, { invert: false }), `level ${level}`).to.deep.equal(lines);
			// the top-left cell is two quiet-zone rows, which are light, so an
			// un-inverted code starts with nothing drawn
			expect(lines[0][0]).to.equal(' ');
		}
	});

	it('should draw the light modules at level 0 on a dark terminal', () => {
		// the one expression this whole decision is: at level 0 there is nothing
		// to paint with, so the drawn modules have to be the ones whose colour
		// the terminal's foreground already is
		const dark = qrcode('x', { colorLevel: 0, colorScheme: 'dark' });
		const light = qrcode('x', { colorLevel: 0, colorScheme: 'light' });

		expect(dark).to.not.contain('\u001b');
		expect(light).to.not.contain('\u001b');

		// inverted: the quiet zone is drawn, so every line begins with four
		// blocks and that is what makes it light on screen
		expect(dark.split('\n')[0].startsWith('████')).to.equal(true);
		// and not inverted: the quiet zone is the terminal's own background
		expect(light.split('\n')[0].trim()).to.equal('');
	});

	it('should let an explicit invert beat the level and the scheme', () => {
		const forced = qrcode('x', { colorLevel: 3, invert: true });
		const natural = qrcode('x', { colorLevel: 3, invert: false });
		expect(forced).to.not.equal(natural);
		expect(strip(forced.split('\n')[0]).startsWith('████')).to.equal(true);

		// and in the other direction, which is the half a default could hide
		expect(qrcode('x', { colorLevel: 0, colorScheme: 'dark', invert: false })).to.equal(
			qrcode('x', { colorLevel: 0, colorScheme: 'light' })
		);
	});
});

describe('the drawing', () => {
	it('should paint its own two colours above level 0', () => {
		// a scanner wants dark modules on a light background and a terminal is
		// usually the other way round, so the body carries the two colours
		// rather than borrowing the terminal's
		const out = qrcode('x', { colorLevel: 3 });
		// 30 is black and 47 is a white background, which is the sheet's
		// `color: black; background-color: white` resolved at a palette index
		expect(out).to.contain('\u001b[30;47m');
	});

	it('should keep the right-hand quiet zone, which a background is what buys', () => {
		// a trailing run of blanks that show nothing is dropped by the string
		// renderer, and a blank with a background shows something -- so the
		// background is what keeps the four light columns on the right. At level
		// 0 the terminal's own background provides them instead, which is why the
		// inverted form is the one that needs no spaces
		const painted = qrcode('x', { colorLevel: 3 });
		for (const line of painted.split('\n')) {
			expect(stringWidth(strip(line))).to.equal(29);
		}

		const plain = qrcode('x', { colorLevel: 0, colorScheme: 'dark' });
		for (const line of plain.split('\n')) {
			expect(stringWidth(line)).to.equal(29);
		}
	});

	it('should let a theme restyle it without an important', () => {
		const out = qrcode('x', {
			colorLevel: 3,
			theme: '.sigil-qrcode-body { color: blue; background-color: yellow }',
		});
		expect(out).to.contain('\u001b[34;43m');
		expect(out).to.not.contain('\u001b[30;47m');
	});

	it('should be a text rather than a raw, so a code can be copied', () => {
		// the glyph set is why this is possible: a half block fills one half with
		// the foreground and the other with the background, so two modules are one
		// cell of one foreground and one background and there is no colour per cell
		// for a `raw` to carry. What it buys is that the code is selectable --
		// `selectable` defaults to false on a `raw`, which is right for a sparkline
		// and wrong for something somebody wants to paste
		const { element } = qrcodeView('x', { colorLevel: 3 });
		expect(element.type).to.equal('box');
		expect(element.children.length).to.equal(1);
		expect(element.children[0].type).to.equal('text');
	});

	it('should measure as one text rather than as a tree of cells', () => {
		const { element, width } = qrcodeView('x', { colorLevel: 3 });
		const body = element.children[0];
		expect(body?.props['white-space']).to.equal('nowrap');
		expect(width).to.equal(29);
		expect(body?.classes).to.deep.equal(['sigil-qrcode-body']);
		expect(element.classes).to.deep.equal(['sigil-qrcode']);
	});

	it('should carry no colour in its props, so a theme can reach it', () => {
		// the rule the framework sheet keeps for every built-in: a prop beats a
		// sheet per property, so a colour written into the tree is one a theme
		// cannot reach without an important
		const { element } = qrcodeView('x', { colorLevel: 3 });
		for (const node of [element, element.children[0]]) {
			for (const key of Object.keys(node.props)) {
				expect(key, key).to.not.match(/colou?r/i);
			}
		}
		// and the colours really are reachable, which is what makes the absence
		// above worth asserting rather than a statement about an empty object
		expect(element.children[0].classes).to.deep.equal(['sigil-qrcode-body']);
	});
});

describe('the facade', () => {
	it('should answer the same lines the view draws', () => {
		const out = qrcode('https://example.com', { colorLevel: 0, colorScheme: 'light' });
		const view = qrcodeView('https://example.com', { colorLevel: 0, colorScheme: 'light' });
		const drawn = qrLines(view.code, { invert: false });

		// trailing blanks are dropped by the renderer where nothing is painted,
		// which is the one difference between the two
		expect(out.split('\n')).to.deep.equal(drawn.map((line) => line.replace(/ +$/, '')));
	});

	it('should answer the large form twice the size on both axes', () => {
		const compact = qrcode('x', { colorLevel: 3 }).split('\n');
		const large = qrcode('x', { colorLevel: 3, form: 'large' }).split('\n');

		expect(large.length).to.equal(29);
		expect(compact.length).to.equal(15);
		expect(stringWidth(strip(large[0]))).to.equal(58);
		expect(stringWidth(strip(compact[0]))).to.equal(29);
	});

	it('should throw rather than draw nothing for an empty payload', () => {
		expect(() => qrcode('')).to.throw(/needs something to encode/);
	});
});

describe('what one segment costs', () => {
	// the refusal above, as a measurement rather than a claim. A reference
	// encoder that splits a payload into a cheapest run of segments is compared
	// with the one segment this encoder uses, over the same payloads: a URL, an
	// otpauth URI and a network credential are the same version either way,
	// `tel:+15551234567` is one version larger here, and a label followed by a
	// hundred and twenty digits -- which is the worst case the shape has -- is
	// four versions larger. Which is what says the decision is affordable for the
	// payloads a CLI draws and what it costs for the ones it does not
	for (const entry of QR_SEGMENTS) {
		it(`should reach version ${entry.single} where a split reaches ${entry.mixed}, for ${entry.why}`, () => {
			expect(encodeQr(entry.text, { ecc: entry.ecc }).version).to.equal(entry.single);
			// and the direction, which is the half that would be a bug: one
			// segment is never *smaller* than the cheapest split, so a case that
			// came out below the reference would mean the capacity is wrong
			expect(entry.single).to.be.at.least(entry.mixed);
		});
	}

	it('should be the same version as a split for most of what a CLI draws', () => {
		// counted rather than asserted case by case, so that the claim above is a
		// number somebody can re-derive from the table beside it
		const same = QR_SEGMENTS.filter((entry) => entry.single === entry.mixed);
		expect(same.length).to.equal(29);
		expect(QR_SEGMENTS.length).to.equal(31);
	});
});
