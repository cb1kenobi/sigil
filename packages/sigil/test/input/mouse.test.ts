import { decodeKeys, pendingLength } from '../../src/components/keys.js';
import { parseMouseReport } from '../../src/input/mouse.js';
import { describe, expect, it } from 'vitest';

/**
 * Reading an SGR mouse report.
 *
 * The bits are a bitmask over a bitmask -- a button in the low two, three
 * modifiers above it, and then three flags that each change what the low two
 * *mean* -- so almost every assertion here is about a combination rather than
 * about a field.
 */

const ESC = String.fromCharCode(0x1b);

/** `CSI < Cb ; Cx ; Cy M`, or `m` for a release. */
const sgr = (cb: number, column: number, row: number, final = 'M') =>
	`${ESC}[<${cb};${column};${row}${final}`;

describe('an SGR mouse report', () => {
	it('should read a press, a release, and a motion', () => {
		expect(parseMouseReport(sgr(0, 10, 5))?.kind).toBe('mousedown');
		expect(parseMouseReport(sgr(0, 10, 5, 'm'))?.kind).toBe('mouseup');
		// bit 32 is the motion flag, and the button bits still say what is held
		expect(parseMouseReport(sgr(32, 10, 5))?.kind).toBe('mousemove');
		expect(parseMouseReport(sgr(32, 10, 5))?.button).toBe('left');
	});

	it('should read the coordinates as the terminal wrote them', () => {
		// one-based and in *screen* coordinates, untouched: translating them is the
		// backend's, because a canvas does not know where it sits
		const found = parseMouseReport(sgr(0, 1, 1));
		expect(found).toMatchObject({ column: 1, row: 1 });

		// and past 223, which is the whole reason only SGR is read: the legacy
		// encoding puts a coordinate in one byte of `32 + n` and cannot say this
		expect(parseMouseReport(sgr(0, 400, 120))).toMatchObject({ column: 400, row: 120 });
	});

	it('should read the three buttons everything has', () => {
		expect(parseMouseReport(sgr(0, 1, 1))?.button).toBe('left');
		expect(parseMouseReport(sgr(1, 1, 1))?.button).toBe('middle');
		expect(parseMouseReport(sgr(2, 1, 1))?.button).toBe('right');
	});

	it('should read motion with nothing held as no button', () => {
		// xterm spells that as low bits of `3`, which is the same value a release
		// carried in the encoding this does not read -- so the final byte is what says
		// which of the two a report is, and the bits are only about which button
		const found = parseMouseReport(sgr(35, 10, 5));
		expect(found?.kind).toBe('mousemove');
		expect(found?.button).toBeUndefined();
	});

	it('should read the wheel off bit 64 rather than as a button', () => {
		expect(parseMouseReport(sgr(64, 1, 1))).toMatchObject({
			button: undefined,
			kind: 'wheel',
			wheel: 'up',
		});
		expect(parseMouseReport(sgr(65, 1, 1))?.wheel).toBe('down');
		// a tilt wheel, or a trackpad's horizontal scroll
		expect(parseMouseReport(sgr(66, 1, 1))?.wheel).toBe('left');
		expect(parseMouseReport(sgr(67, 1, 1))?.wheel).toBe('right');
	});

	it('should read a wheel turn as one whatever the final byte says', () => {
		// a terminal sends a turn as a press and never as a release, so `m` here is a
		// shape nothing produces -- and a turn is still a turn if one ever does, which
		// is a better answer than the release of a button that was never held
		expect(parseMouseReport(sgr(64, 1, 1, 'm'))).toMatchObject({ kind: 'wheel', wheel: 'up' });
	});

	it('should read buttons 8 to 11 off bit 128', () => {
		expect(parseMouseReport(sgr(128, 1, 1))?.button).toBe('extra1');
		expect(parseMouseReport(sgr(131, 1, 1))?.button).toBe('extra4');
		// and *not* as the "no button" the same low bits mean without that flag
		expect(parseMouseReport(sgr(3, 1, 1, 'm'))?.button).toBeUndefined();
	});

	it('should read the modifiers, which every kind carries', () => {
		expect(parseMouseReport(sgr(4, 1, 1))).toMatchObject({ ctrl: false, meta: false, shift: true });
		expect(parseMouseReport(sgr(8, 1, 1))).toMatchObject({ ctrl: false, meta: true, shift: false });
		expect(parseMouseReport(sgr(16, 1, 1))).toMatchObject({
			ctrl: true,
			meta: false,
			shift: false,
		});
		// a ctrl-shift-drag of the right button, which is all of it at once
		expect(parseMouseReport(sgr(2 + 4 + 16 + 32, 1, 1))).toMatchObject({
			button: 'right',
			ctrl: true,
			kind: 'mousemove',
			shift: true,
		});
	});

	it('should refuse anything that is not one', () => {
		// being wrong in this direction costs a key the user pressed, so the shape is
		// exact: the private `<`, three parameters, and `M` or `m`
		for (const sequence of [
			'',
			'x',
			`${ESC}[<0;1;1R`, // a CPR's final byte
			`${ESC}[0;1;1M`, // no private prefix
			`${ESC}[<0;1M`, // two parameters
			`${ESC}[<0;1;1;1M`, // four
			`${ESC}[<0;1;1`, // still arriving
			`${ESC}[<a;1;1M`, // not a number
			`${ESC}[<0;1;1M${ESC}`, // not anchored at the end
			`${ESC}[M`, // the X10 encoding's introducer, which this does not read
		]) {
			expect(parseMouseReport(sequence), sequence).toBeUndefined();
		}
	});

	it('should arrive from the decoder as one read', () => {
		// which is why the decoder's parameter range was widened to the private-use
		// bytes: read as keys, `ESC [ < 0 ; 1 ; 1 M` ended at the `<` and left
		// `0;1;1M` to be typed into somebody's answer a character at a time
		const keys = decodeKeys(sgr(0, 10, 5));
		expect(keys).toHaveLength(1);
		expect(parseMouseReport(keys[0].sequence)).toMatchObject({ column: 10, row: 5 });
	});

	it('should be held until it has finished arriving', () => {
		// a report split by ssh or a small read buffer is a report, not a key and a
		// run of characters -- and `pendingLength()` is the same walk the decoder uses
		const whole = sgr(0, 10, 5);
		for (let i = 1; i < whole.length; i++) {
			const part = whole.slice(0, i);
			expect(pendingLength(part), part).toBe(part.length);
		}
		expect(pendingLength(whole)).toBe(0);
	});
});
