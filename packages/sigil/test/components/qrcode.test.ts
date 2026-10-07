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

/**
 * Asserts the function patterns and the information areas of a symbol.
 *
 * Written from the spec's rules rather than read off the encoder, and applied to
 * **two** subjects: every reference matrix in the fixture, and the encoder's own
 * output for all 160 version-and-level combinations. The duplication is the
 * point, which is the reference fixture's own argument one layer along -- a check
 * that asked the encoder where its finders go would answer yes whatever they were.
 *
 * It is what cross-checks the **fixture**, which is otherwise 160 kB of data that
 * nothing in this repository reads: a mangled row, or metadata transcribed onto
 * the wrong matrix, would make every agreement with it worthless. The format and
 * version information are the sharp part, because they tie the stated `ecc`,
 * `mask` and `version` to the modules.
 *
 * @param rows - The symbol, `#` for dark.
 * @param version - 1 to 40.
 * @param ecc - The level.
 * @param mask - 0 to 7.
 * @param tag - What to name in a failure.
 */
function checkStructure(
	rows: readonly string[],
	version: number,
	ecc: QrEcc,
	mask: number,
	tag: string
): void {
	const size = version * 4 + 17;
	const dark = (y: number, x: number) => rows[y][x] === '#';

	expect(rows.length, `${tag} rows`).to.equal(size);
	for (const [i, row] of rows.entries()) {
		expect(row.length, `${tag} row ${i}`).to.equal(size);
	}

	// the three finders with their one-module light separators, read as the ring
	// distance from each centre so that the corners fall out rather than being
	// enumerated
	for (const [ox, oy] of [
		[0, 0],
		[size - 7, 0],
		[0, size - 7],
	]) {
		for (let dy = -1; dy <= 7; dy++) {
			for (let dx = -1; dx <= 7; dx++) {
				const x = ox + dx;
				const y = oy + dy;
				if (x < 0 || y < 0 || x >= size || y >= size) {
					continue;
				}
				const inside = dx >= 0 && dy >= 0 && dx < 7 && dy < 7;
				const want = inside && Math.max(Math.abs(dx - 3), Math.abs(dy - 3)) !== 2;
				expect(dark(y, x), `${tag} finder ${ox},${oy} at ${x},${y}`).to.equal(want);
			}
		}
	}

	// the timing patterns, between the finders
	for (let i = 8; i < size - 8; i++) {
		expect(dark(6, i), `${tag} timing row ${i}`).to.equal(i % 2 === 0);
		expect(dark(i, 6), `${tag} timing column ${i}`).to.equal(i % 2 === 0);
	}

	// the dark module, which is the one module that is always dark
	expect(dark(size - 8, 8), `${tag} dark module`).to.equal(true);

	// the alignment patterns, from the spec's own rule. Version 1 has none at all,
	// which the fill below does not know -- the first version of this check built
	// centres for it and reported 107 problems in a matrix with nothing wrong
	const centres: number[] = [];
	if (version > 1) {
		const count = Math.floor(version / 7) + 2;
		const step = version === 32 ? 26 : Math.ceil((version * 4 + 4) / (count * 2 - 2)) * 2;
		centres.push(6);
		for (let pos = version * 4 + 10; centres.length < count; pos -= step) {
			centres.splice(1, 0, pos);
		}
	}
	for (const [i, cy] of centres.entries()) {
		for (const [j, cx] of centres.entries()) {
			const corner =
				(i === 0 && j === 0) ||
				(i === 0 && j === centres.length - 1) ||
				(i === centres.length - 1 && j === 0);
			if (corner) {
				continue;
			}
			for (let dy = -2; dy <= 2; dy++) {
				for (let dx = -2; dx <= 2; dx++) {
					const want = Math.max(Math.abs(dx), Math.abs(dy)) !== 1;
					expect(dark(cy + dy, cx + dx), `${tag} alignment ${cx},${cy}`).to.equal(want);
				}
			}
		}
	}

	// the format information, both copies, BCH(15,5) over 0x537 and XOR 0x5412
	const ECC_BITS: Readonly<Record<QrEcc, number>> = { H: 2, L: 1, M: 0, Q: 3 };
	const data = (ECC_BITS[ecc] << 3) | mask;
	let rem = data;
	for (let i = 0; i < 10; i++) {
		rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
	}
	const format = ((data << 10) | rem) ^ 0x5412;
	const bit = (i: number) => ((format >>> i) & 1) === 1;

	for (let i = 0; i <= 5; i++) {
		expect(dark(i, 8), `${tag} format A ${i}`).to.equal(bit(i));
	}
	expect(dark(7, 8), `${tag} format A 6`).to.equal(bit(6));
	expect(dark(8, 8), `${tag} format A 7`).to.equal(bit(7));
	expect(dark(8, 7), `${tag} format A 8`).to.equal(bit(8));
	for (let i = 9; i < 15; i++) {
		expect(dark(8, 14 - i), `${tag} format A ${i}`).to.equal(bit(i));
	}
	for (let i = 0; i < 8; i++) {
		expect(dark(8, size - 1 - i), `${tag} format B ${i}`).to.equal(bit(i));
	}
	for (let i = 8; i < 15; i++) {
		expect(dark(size - 15 + i, 8), `${tag} format B ${i}`).to.equal(bit(i));
	}

	// and the version information, both copies, BCH(18,6) over 0x1f25 with no XOR
	if (version >= 7) {
		let vrem = version;
		for (let i = 0; i < 12; i++) {
			vrem = (vrem << 1) ^ ((vrem >>> 11) * 0x1f25);
		}
		const vbits = (version << 12) | vrem;
		for (let i = 0; i < 18; i++) {
			const want = ((vbits >>> i) & 1) === 1;
			const a = Math.floor(i / 3);
			const b = (i % 3) + size - 11;
			expect(dark(a, b), `${tag} version A ${i}`).to.equal(want);
			expect(dark(b, a), `${tag} version B ${i}`).to.equal(want);
		}
	}
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

	// and the other direction: the fixture itself, checked against the spec's own
	// function patterns and information areas. It is 160 kB of data nothing else
	// in this repository reads, so a mangled row or metadata transcribed onto the
	// wrong matrix would make every agreement above worthless. Round 2 of the
	// review was pointed at these matrix bodies; this is that question asked by a
	// test rather than once by hand
	it('should be a fixture whose own matrices are well-formed symbols', () => {
		for (const vector of QR_VECTORS) {
			checkStructure(
				vector.rows,
				vector.version,
				vector.ecc,
				vector.mask,
				`${JSON.stringify(vector.text).slice(0, 20)} v${vector.version}-${vector.ecc}`
			);
		}
	});

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

	// the capacity the *error message* names, against the same published table.
	// Two paths to one number: one encodes a payload of that length and asserts
	// the version, and this reads the figure the message computes -- so a
	// capacity derivation that drifted would have to drift in both to stay quiet.
	// All twelve are the spec's own version 40 figures
	it('should name the published capacity in the message, for every mode and level', () => {
		const PUBLISHED: Readonly<Record<QrEcc, readonly [number, number, number]>> = {
			H: [3057, 1852, 1273],
			L: [7089, 4296, 2953],
			M: [5596, 3391, 2331],
			Q: [3993, 2420, 1663],
		};

		for (const ecc of LEVELS) {
			const [digits, alnum, bytes] = PUBLISHED[ecc];
			expect(() => encodeQr('7'.repeat(digits + 1), { ecc }), `${ecc} numeric`).to.throw(
				new RegExp(`in numeric mode against ${digits}\\.`)
			);
			expect(() => encodeQr('Z'.repeat(alnum + 1), { ecc }), `${ecc} alnum`).to.throw(
				new RegExp(`in alphanumeric mode against ${alnum}\\.`)
			);
			expect(() => encodeQr('b'.repeat(bytes + 1), { ecc }), `${ecc} byte`).to.throw(
				new RegExp(`in byte mode against ${bytes}\\.`)
			);
		}
	});

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

				// through the same helper the fixture is checked with, which is what
				// makes the alignment patterns and both information areas covered for
				// every version rather than only the eight the vectors reach -- the
				// first version of this checked the finders, the timing patterns and
				// the dark module and nothing else
				checkStructure(rowsOf(code), version, ecc, code.mask, `v${version}-${ecc}`);
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

	it('should say what a payload that does not fit would need, in its own mode', () => {
		// the message is what somebody acts on, so it names the level and says
		// that a lower one holds more -- which is the one thing they can change.
		// And the capacity it names is the **mode's** own: it used to be computed
		// from a 14-bit count indicator whatever the mode and labelled "bytes" for
		// all three, so a numeric payload was told a number it was nowhere near.
		// Found by review
		expect(() => encodeQr('b'.repeat(3000))).to.throw(/level M/);
		expect(() => encodeQr('b'.repeat(3000))).to.throw(/lower error-correction level holds more/);
		expect(() => encodeQr('b'.repeat(3000))).to.throw(/3000 bytes in byte mode against 2331/);
		expect(() => encodeQr('7'.repeat(6000))).to.throw(
			/6000 characters in numeric mode against 5596/
		);
		expect(() => encodeQr('Z'.repeat(4000))).to.throw(
			/4000 characters in alphanumeric mode against 3391/
		);
	});
});

describe('the quiet zone', () => {
	it("should put one light module on every side, and the spec's four where asked", () => {
		// one rather than four, which `QUIET` is where the divergence is argued
		// and measured: a terminal symbol is crisp, axis-aligned and on a screen,
		// and one module is where an independent decoder starts finding it
		// against a field of dark cells. **Both** halves are asserted, so that
		// neither the default nor the knob can move without the other being read
		const code = encodeQr('x');
		const lines = qrLines(code, { form: 'large' });

		// large is one row per module, so the grid is the symbol plus two
		expect(lines.length).to.equal(code.size + 2);
		for (const line of lines) {
			expect(line.length).to.equal((code.size + 2) * 2);
		}

		// the row and column at each edge, which is the thing a scanner locates
		// the symbol against
		const light = ' '.repeat((code.size + 2) * 2);
		for (const row of [0, code.size + 1]) {
			expect(lines[row], `row ${row}`).to.equal(light);
		}
		for (const line of lines) {
			expect(line.slice(0, 2)).to.equal('  ');
			expect(line.slice(-2)).to.equal('  ');
		}

		// and the spec's four where a caller asks for it, which is the first
		// thing to reach for when a scanner struggles
		const wide = qrLines(code, { form: 'large', quietZone: 4 });
		expect(wide.length).to.equal(code.size + 8);
		const wideLight = ' '.repeat((code.size + 8) * 2);
		for (const row of [0, 1, 2, 3, code.size + 4, code.size + 5, code.size + 6, code.size + 7]) {
			expect(wide[row], `row ${row}`).to.equal(wideLight);
		}
		for (const line of wide) {
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

		expect(compact[0].length).to.equal(code.size + 2);
		expect(large[0].length).to.equal((code.size + 2) * 2);
		// un-inverted the pad is below the grid, so the first compact row is the
		// one quiet module row over the symbol's first -- and at the spec's four
		// the first two rows are quiet zone, which is the same four modules
		// counted the same way
		const wide = qrLines(code, { form: 'compact', quietZone: 4 });
		expect(wide[0]).to.equal(' '.repeat(code.size + 8));
		expect(wide[1]).to.equal(' '.repeat(code.size + 8));
	});

	it('should widen and narrow where it is asked, and refuse what is not a count', () => {
		const code = encodeQr('x');
		expect(qrLines(code, { form: 'large', quietZone: 0 })[0].length).to.equal(code.size * 2);
		expect(qrLines(code, { form: 'large', quietZone: 8 })[0].length).to.equal((code.size + 16) * 2);
		expect(() => qrLines(code, { quietZone: -1 })).to.throw(/whole number of modules/);
		// and a form that is not one of the two, refused rather than drawn as
		// compact: `form: 'Large'` from a JavaScript caller would otherwise draw
		// the wrong code and say nothing
		expect(() => qrLines(code, { form: 'Large' as 'large' })).to.throw(/Unknown QR form/);
		expect(() => qrLines(code, { quietZone: 1.5 })).to.throw(/whole number of modules/);
		expect(() => qrLines(code, { quietZone: Number.NaN })).to.throw(/whole number of modules/);
	});

	it('should pad an odd module-row count at the edge the pad cannot be seen on', () => {
		// version 1 with the default quiet zone is 23 module rows, which is odd:
		// without the pad the last cell holds one module and half of nothing
		const code = encodeQr('x');
		expect(code.size + 2).to.equal(23);

		const lines = qrLines(code);
		expect(lines.length).to.equal(12);

		// inverted, the pad is above the grid and is the page: the first line is
		// the one quiet row sitting in a cell's lower half, so a uniform strip,
		// and the last line is the symbol's last row over the bottom quiet row
		// rather than the solid row of full blocks that a pad drawn as light
		// produced
		const inverted = qrLines(code, { invert: true });
		expect(inverted[0]).to.equal('▄'.repeat(code.size + 2));
		expect(inverted.at(-1)).to.not.equal('█'.repeat(code.size + 2));
		expect(new Set(inverted.at(-1)!).size).to.be.greaterThan(1);

		// painted, the pad is below the grid, because there it is the body's own
		// white rather than the page -- so the first line is the quiet row over
		// the symbol's first row and the *last* is the one that is all pad
		expect(lines[0]).to.not.equal(' '.repeat(code.size + 2));
		expect(lines.at(-1)).to.equal(' '.repeat(code.size + 2));

		// the row count, over several quiet zones, as the formula rather than by
		// hand
		for (let quiet = 0; quiet <= 6; quiet++) {
			const span = code.size + quiet * 2;
			expect(qrLines(code, { quietZone: quiet }).length).to.equal((span + (span % 2)) / 2);
		}
	});

	it('should keep the border one module at the top in both polarities', () => {
		// the complaint this is for, as a measurement: with the pad above the grid
		// in *both* polarities the painted form came out with **two** modules of
		// border at the top and one at the bottom, because an undrawn pad is the
		// body's own `background-color: white` there rather than the page -- a
		// first row twice as thick as the last, reported from a terminal and
		// invisible to every other assertion in this file, which reads glyphs.
		//
		// Read back off the rendered glyphs rather than off the implementation,
		// because the implementation is what is in question: each grid row is
		// reconstructed from the half of the cell it landed in, and a row is
		// border when every module in it is light
		const border = (code: QrCode, invert: boolean) => {
			const span = code.size + 2;
			const pad = span % 2;
			const above = invert ? pad : 0;
			const lines = qrLines(code, { invert });

			const light: boolean[] = [];
			for (let y = 0; y < span; y++) {
				const glyphs = [...lines[Math.floor((y + above) / 2)]];
				const upper = (y + above) % 2 === 0;
				light.push(
					glyphs.every((glyph) => {
						const drawn = glyph === '█' || glyph === (upper ? '▀' : '▄');
						// inverted, a drawn half is the light one
						return invert ? drawn : !drawn;
					})
				);
			}

			// the pad is a module of border painted, where it is white, and none
			// inverted, where it is the page
			const padBorder = invert ? 0 : pad;
			let top = 0;
			for (const row of light) {
				if (!row) break;
				top++;
			}
			let bottom = padBorder;
			for (const row of [...light].reverse()) {
				if (!row) break;
				bottom++;
			}
			return { top, bottom };
		};

		for (const payload of ['x', 'https://github.com/cb1kenobi/sigil', 'a'.repeat(300)]) {
			const code = encodeQr(payload);
			const where = `v${code.version}`;

			// painted: one at the top, and the odd span's extra on the bottom edge
			// where it reads as the gap before whatever is printed next
			expect(border(code, false), `${where} painted`).to.deep.equal({ top: 1, bottom: 2 });

			// inverted: the pad is the page, so both edges are the one module asked
			// for -- which is the frame the ticket's own sample has
			expect(border(code, true), `${where} inverted`).to.deep.equal({ top: 1, bottom: 1 });
		}
	});

	// and the fact under it, which the first version of the test above got
	// backwards -- it named a quiet zone of 3 on version 2 as the *even* case and
	// 31 is odd. There is no even case: a symbol is `4 * version + 17` modules on
	// a side, which is odd for every version, and a quiet zone is added twice,
	// which is even. So the padding fires for every code there has ever been, and
	// the even branch of `span + (span % 2)` is unreachable. Asserted rather than
	// left in a comment, because the expression is written as a parity on the
	// strength of it. Found by review
	it('should be an odd number of module rows for every version', () => {
		for (let version = 1; version <= 40; version++) {
			expect((version * 4 + 17) % 2, `v${version}`).to.equal(1);
			for (let quiet = 0; quiet <= 8; quiet++) {
				expect((version * 4 + 17 + quiet * 2) % 2, `v${version} q${quiet}`).to.equal(1);
			}
		}
	});
});

describe('the two forms', () => {
	it('should draw a module about square in both', () => {
		// a cell is about twice as tall as it is wide, so the claim is that a
		// module is one column by half a cell in one form and two columns by one
		// cell in the other -- which is this arithmetic and nothing else
		const code = encodeQr('x');
		const span = code.size + 2;

		const compact = qrLines(code, { form: 'compact' });
		expect(compact[0].length / span).to.equal(1);
		// two module rows per cell, plus the one pad half-row an odd span always
		// has. Exact rather than a tolerance, because the pad is a known one
		// rather than noise -- a tolerance wide enough for it at version 1 is
		// wide enough to hide a lost row
		expect(compact.length * 2 - span).to.equal(1);

		const large = qrLines(code, { form: 'large' });
		expect(large[0].length / span).to.equal(2);
		expect(large.length / span).to.equal(1);
	});

	it('should hold the same modules in both', () => {
		// the differential: two renderings of one symbol, read back as modules
		// and required to agree. A form that lost a row or doubled a column
		// would otherwise look perfectly plausible
		const code = encodeQr('https://example.com', { ecc: 'Q' });
		// the default quiet zone, stated once here and derived from below -- the
		// test named for the default is what pins the number itself
		const quiet = 1;
		const span = code.size + quiet * 2;
		const compact = qrLines(code, { form: 'compact' });
		const large = qrLines(code, { form: 'large' });

		// un-inverted the pad is below the grid, so grid row `y` is half `y` of a
		// cell. `the border` below is what pins the other half of that
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
				const inside = x >= quiet && y >= quiet && x < code.size + quiet && y < code.size + quiet;
				expect(fromLarge).to.equal(inside ? code.modules[y - quiet][x - quiet] : false);
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
		// through the component rather than through `qrLines()` with the answer
		// handed to it, which is what the first version of this did: it looped the
		// levels and then drew with `invert: false` itself, so the level never
		// reached `polarity()` at all and deleting the `level > 0` branch left it
		// green. Found by review. What makes it say something is comparing the
		// *drawn output* at each level against the un-inverted drawing, and
		// against a level-0 dark terminal, which must differ
		const plain = qrLines(encodeQr('x'), { invert: false }).map((line) => line.replace(/ +$/, ''));
		const inverted = qrcode('x', { colorLevel: 0, colorScheme: 'dark' });

		for (const level of [1, 2, 3] as const) {
			const drawn = strip(qrcode('x', { colorLevel: level })).split('\n');
			expect(
				drawn.map((line) => line.replace(/ +$/, '')),
				`level ${level}`
			).to.deep.equal(plain);
			expect(drawn.join('\n'), `level ${level}`).to.not.equal(inverted);
		}

		// the pad is below the grid when painted, so the *last* cell row is two
		// light rows and an un-inverted code ends with nothing drawn
		expect(plain.at(-1)).to.equal('');
	});

	it('should draw the light modules at level 0 on a dark terminal', () => {
		// the one expression this whole decision is: at level 0 there is nothing
		// to paint with, so the drawn modules have to be the ones whose colour
		// the terminal's foreground already is
		const dark = qrcode('x', { colorLevel: 0, colorScheme: 'dark' });
		const light = qrcode('x', { colorLevel: 0, colorScheme: 'light' });

		expect(dark).to.not.contain('\u001b');
		expect(light).to.not.contain('\u001b');

		// inverted: the quiet zone is drawn, which is what makes it light on
		// screen. With the one-module default that is the whole first line --
		// the pad above takes no glyph, so the quiet row is a cell's lower half
		// and the strip is uniform
		const first = dark.split('\n')[0];
		expect(new Set(first).size).to.equal(1);
		expect(first.startsWith('▄▄▄▄')).to.equal(true);
		// and not inverted: the quiet zone is the terminal's own background, and
		// the pad is below the grid, so the *last* line is the blank one
		expect(light.split('\n').at(-1)?.trim()).to.equal('');
	});

	it('should let an explicit invert beat the level and the scheme', () => {
		const forced = qrcode('x', { colorLevel: 3, invert: true });
		const natural = qrcode('x', { colorLevel: 3, invert: false });
		expect(forced).to.not.equal(natural);
		expect(strip(forced.split('\n')[0]).startsWith('▄▄▄▄')).to.equal(true);

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
		// background is what keeps the light column on the right. At level 0 the
		// terminal's own background provides it instead, which is why the
		// inverted form is the one that needs no spaces
		const painted = qrcode('x', { colorLevel: 3 });
		for (const line of painted.split('\n')) {
			expect(stringWidth(strip(line))).to.equal(23);
		}

		const plain = qrcode('x', { colorLevel: 0, colorScheme: 'dark' });
		for (const line of plain.split('\n')) {
			expect(stringWidth(line)).to.equal(23);
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
		expect(width).to.equal(23);
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

		expect(large.length).to.equal(23);
		expect(compact.length).to.equal(12);
		expect(stringWidth(strip(large[0]))).to.equal(46);
		expect(stringWidth(strip(compact[0]))).to.equal(23);
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
