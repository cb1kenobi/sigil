import { DEFAULT_COLOR, palette, rgb } from '../../src/canvas/style.js';
import {
	AUTO,
	cells,
	COLOR_PROPERTIES,
	degradeColor,
	interpolate,
	INTERPOLATION,
	mixColors,
	NONE,
	oklab,
	percent,
	PROPERTIES,
	PROPERTY_NAMES,
	rgbFromOklab,
} from '../../src/style/index.js';
import { describe, expect, it } from 'vitest';

/**
 * What a property's value is part way between two of itself.
 *
 * Pure, so it is asserted as arithmetic. The constraint worth pinning is that
 * geometry comes out in whole cells: that is what makes a frame the animator can
 * skip identifiable at all.
 */

describe('how each property interpolates', () => {
	it('should classify every property, so a new one is never silently discrete', () => {
		for (const property of PROPERTY_NAMES) {
			expect(INTERPOLATION.get(property), property).toBeDefined();
		}
	});

	it('should call every colour property a colour', () => {
		for (const property of COLOR_PROPERTIES) {
			expect(INTERPOLATION.get(property), property).toBe('color');
		}
	});

	it('should call a length a length and a flag discrete', () => {
		for (const property of ['width', 'marginTop', 'flexBasis', 'top', 'maxHeight'] as const) {
			expect(INTERPOLATION.get(property), property).toBe('length');
		}
		for (const property of ['bold', 'dim', 'display', 'borderStyle'] as const) {
			expect(INTERPOLATION.get(property), property).toBe('discrete');
		}
	});

	it('should round a number exactly where the property itself refuses a fraction', () => {
		// the cross-check that makes the derivation trustworthy: whether a property
		// takes a fraction is a fact about its *parser*, so a fractional property
		// added without being named in the exceptions table fails here rather than
		// being quietly rounded on every frame of every animation
		let integers = 0;
		let fractions = 0;
		for (const property of PROPERTY_NAMES) {
			const kind = INTERPOLATION.get(property);
			if (kind !== 'integer' && kind !== 'number') {
				continue;
			}
			let takesAFraction = true;
			try {
				PROPERTIES[property].parse('0.5');
			} catch {
				takesAFraction = false;
			}
			expect(takesAFraction, `${property} is classified ${String(kind)}`).toBe(kind === 'number');
			if (kind === 'number') {
				fractions++;
			} else {
				integers++;
			}
		}
		// and both halves are reached, or the assertion above says nothing
		expect(integers).toBeGreaterThan(5);
		expect(fractions).toBe(2);
	});

	it('should refuse to animate the animation declarations themselves', () => {
		// an animation that animated its own duration would be asking what the
		// duration is in order to find out what it is
		for (const property of [
			'transitionDuration',
			'transitionDelay',
			'transitionProperty',
			'transitionTimingFunction',
			'animationName',
			'animationDuration',
			'animationDelay',
			'animationIterationCount',
			'animationDirection',
			'animationFillMode',
			'animationTimingFunction',
		] as const) {
			expect(INTERPOLATION.get(property), property).toBe('none');
		}
	});
});

describe('geometry, in whole cells', () => {
	it('should interpolate cells to cells', () => {
		expect(interpolate('width', cells(10), cells(20), 0, 3)).toEqual(cells(10));
		expect(interpolate('width', cells(10), cells(20), 0.5, 3)).toEqual(cells(15));
		expect(interpolate('width', cells(10), cells(20), 1, 3)).toEqual(cells(20));
	});

	it('should round rather than truncate, so the last frame is not a cell short', () => {
		// truncating biases every frame downwards: 10 to 20 at 0.99 would be 19
		expect(interpolate('width', cells(10), cells(20), 0.99, 3)).toEqual(cells(20));
		expect(interpolate('width', cells(0), cells(1), 0.5, 3)).toEqual(cells(1));
		expect(interpolate('width', cells(0), cells(1), 0.49, 3)).toEqual(cells(0));
	});

	it('should visit every integer between the two, and no others', () => {
		const seen = new Set<number>();
		for (let i = 0; i <= 1000; i++) {
			const value = interpolate('width', cells(10), cells(20), i / 1000, 3) as {
				value: number;
			};
			seen.add(value.value);
		}
		expect([...seen].sort((a, b) => a - b)).toEqual([10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20]);
	});

	it('should snap where the two are different kinds of length', () => {
		// `auto` is a question rather than a number, and what it resolves to is the
		// layout engine's and is not known here
		expect(interpolate('width', AUTO, cells(10), 0.4, 3)).toBe(AUTO);
		expect(interpolate('width', AUTO, cells(10), 0.6, 3)).toEqual(cells(10));
		expect(interpolate('maxWidth', NONE, cells(10), 0.4, 3)).toBe(NONE);
	});

	it('should interpolate a percentage as a percentage', () => {
		expect(interpolate('width', percent(0), percent(100), 0.25, 3)).toEqual(percent(25));
	});

	it('should hand back the same frozen object where both ends are the same', () => {
		// a new object per frame would report a change to `difference()` and keep an
		// animation alive forever
		expect(interpolate('width', AUTO, AUTO, 0.5, 3)).toBe(AUTO);
	});

	it('should round a padding and leave a flex factor fractional', () => {
		expect(interpolate('paddingTop', 0, 3, 0.5, 3)).toBe(2);
		expect(interpolate('flexGrow', 0, 1, 0.5, 3)).toBe(0.5);
	});
});

describe('colour, in Oklab', () => {
	it('should round-trip through Oklab', () => {
		for (const [r, g, b] of [
			[0, 0, 0],
			[255, 255, 255],
			[128, 128, 128],
			[255, 136, 0],
			[12, 34, 56],
		] as const) {
			expect(rgbFromOklab(oklab([r, g, b]))).toEqual([r, g, b]);
		}
	});

	it('should keep a grey grey, which is what the b row is tuned for', () => {
		for (let v = 0; v <= 255; v += 17) {
			const [r, g, b] = rgbFromOklab(oklab([v, v, v]));
			expect(r, String(v)).toBe(v);
			expect(g, String(v)).toBe(v);
			expect(b, String(v)).toBe(v);
		}
	});

	it('should hold the endpoints exactly', () => {
		expect(mixColors(rgb(255, 0, 0), rgb(0, 0, 255), 0)).toBe(rgb(255, 0, 0));
		expect(mixColors(rgb(255, 0, 0), rgb(0, 0, 255), 1)).toBe(rgb(0, 0, 255));
	});

	it('should keep the perceived lightness the two endpoints average to', () => {
		// the whole argument for Oklab said as a property rather than as taste: a
		// ramp through gamma-encoded sRGB dips in perceived lightness in the middle,
		// so a red easing to a blue goes visibly dark half way. Measured, red is
		// L=0.628 and blue L=0.452, so their average is 0.540 -- the Oklab midpoint
		// comes to 0.539 and the sRGB midpoint (128, 0, 128) to 0.421
		const lightness = (color: number) => oklab(channelsOf(color))[0];
		const average = (lightness(rgb(255, 0, 0)) + lightness(rgb(0, 0, 255))) / 2;

		const mixed = mixColors(rgb(255, 0, 0), rgb(0, 0, 255), 0.5) as number;
		expect(Math.abs(lightness(mixed) - average)).toBeLessThan(0.01);
		expect(average - lightness(rgb(128, 0, 128))).toBeGreaterThan(0.1);
	});

	it('should refuse a palette colour rather than inventing a path through xterm', () => {
		// the basic sixteen are whatever the user's theme says they are, so a mix
		// through the xterm defaults would draw a first frame in a red the user
		// never chose
		expect(mixColors(palette(1), palette(4), 0.5)).toBeUndefined();
		expect(mixColors(rgb(255, 0, 0), palette(4), 0.5)).toBeUndefined();
		expect(mixColors(DEFAULT_COLOR, rgb(0, 0, 0), 0.5)).toBeUndefined();
	});

	it('should snap a palette colour at the midpoint, which is CSS for anything it cannot mix', () => {
		expect(interpolate('color', palette(1), palette(4), 0.4, 3)).toBe(palette(1));
		expect(interpolate('color', palette(1), palette(4), 0.6, 3)).toBe(palette(4));
	});

	it('should degrade what it mixed, or an animation is the one path that emits truecolor', () => {
		// degradation happens at resolve time, so a mix of two already-degraded
		// colours is an off-cube colour nothing would degrade again
		const mixed = interpolate('color', rgb(255, 0, 0), rgb(0, 0, 255), 0.5, 2) as number;
		expect(mixed).toBe(degradeColor(mixed, 2));
		expect(mixed).toBeLessThan(0x100);
		expect(mixed).toBeGreaterThanOrEqual(16);
	});

	it('should hold every frame to the palette at level 1', () => {
		for (let i = 0; i <= 20; i++) {
			const value = interpolate('color', rgb(255, 0, 0), rgb(0, 0, 255), i / 20, 1) as number;
			expect(value, String(i)).toBeLessThan(16);
		}
	});
});

describe('discrete properties', () => {
	it('should flip at the midpoint', () => {
		expect(interpolate('bold', false, true, 0.49, 3)).toBe(false);
		expect(interpolate('bold', false, true, 0.5, 3)).toBe(true);
		expect(interpolate('borderStyle', 'single', 'double', 0.4, 3)).toBe('single');
		expect(interpolate('display', 'flex', 'none', 0.6, 3)).toBe('none');
	});
});

/** The channels of a 24-bit colour, which `canvas/style.ts` keeps to itself. */
function channelsOf(color: number): readonly [number, number, number] {
	const packed = color - 0x100;
	return [(packed >> 16) & 0xff, (packed >> 8) & 0xff, packed & 0xff];
}
