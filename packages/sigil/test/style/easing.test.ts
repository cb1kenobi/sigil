import { ease, type Easing, LINEAR, parseEasing, StyleError } from '../../src/style/index.js';
import { describe, expect, it } from 'vitest';

/**
 * Timing functions.
 *
 * The one piece of the animation machinery with no clock in it, so it is
 * asserted as arithmetic: a map from a fraction to a number.
 */

describe('reading a timing function', () => {
	it('should read every name CSS has', () => {
		for (const name of ['linear', 'ease', 'ease-in', 'ease-out', 'ease-in-out']) {
			expect(parseEasing(name).source, name).toBe(name);
		}
		expect(parseEasing('step-start')).toMatchObject({ count: 1, position: 'jump-start' });
		expect(parseEasing('step-end')).toMatchObject({ count: 1, position: 'jump-end' });
	});

	it('should read a name in any case, which is the rule every keyword here follows', () => {
		expect(parseEasing('EASE-OUT')).toBe(parseEasing('ease-out'));
	});

	it('should intern, so that two rules writing one curve compare equal', () => {
		// `difference()` asks whether two resolved styles disagree about a property
		// with `===` plus one branch for a `Length`; a timing function has to
		// compare by identity or that function grows a third branch
		expect(parseEasing('ease-out')).toBe(parseEasing('ease-out'));
		expect(parseEasing('steps(4, end)')).toBe(parseEasing('steps(4,end)'));
		expect(parseEasing('linear')).toBe(LINEAR);
	});

	it('should be frozen, like every other value the table holds', () => {
		const easing = parseEasing('ease') as { source: string };
		expect(() => {
			easing.source = 'linear';
		}).toThrow();
	});

	it('should read both of CSS spellings of a step position', () => {
		expect(parseEasing('steps(3, start)')).toMatchObject({ position: 'jump-start' });
		expect(parseEasing('steps(3, jump-start)')).toMatchObject({ position: 'jump-start' });
		expect(parseEasing('steps(3)')).toMatchObject({ position: 'jump-end' });
	});

	it('should refuse a step function with nothing to step to', () => {
		// `steps(1, jump-none)` divides by zero: one step with no jumps at either
		// end is a timing function with no output at all
		expect(() => parseEasing('steps(1, jump-none)')).toThrow(StyleError);
		expect(() => parseEasing('steps(0)')).toThrow(StyleError);
	});

	it('should refuse an x coordinate outside the unit interval', () => {
		// a curve that doubles back has no single answer for "where are we at t"
		expect(() => parseEasing('cubic-bezier(-0.1, 0, 1, 1)')).toThrow(/x coordinates/);
		expect(() => parseEasing('cubic-bezier(0, 0, 1.5, 1)')).toThrow(/x coordinates/);
	});

	it('should refuse an overshoot, which CSS allows and this does not', () => {
		// every geometry property here is whole cells with a grammar of its own, so
		// an overshoot resolves to a value no declaration could have written -- a
		// negative padding, a negative gap -- and nothing on the property table
		// says where to clamp it back to
		expect(() => parseEasing('cubic-bezier(0.5, -0.5, 0.5, 1.5)')).toThrow(/overshoot/);
	});

	it('should refuse what is not a timing function', () => {
		expect(() => parseEasing('swing')).toThrow(StyleError);
		expect(() => parseEasing('cubic-bezier(0, 0, 1)')).toThrow(/four numbers/);
		expect(() => parseEasing('steps(2, sideways)')).toThrow(/steps\(\) position/);
	});
});

describe('easing a fraction', () => {
	it('should leave linear alone', () => {
		for (const t of [0, 0.25, 0.5, 0.75, 1]) {
			expect(ease(LINEAR, t)).toBe(t);
		}
	});

	it('should clamp its input rather than extrapolating', () => {
		expect(ease(LINEAR, -1)).toBe(0);
		expect(ease(LINEAR, 2)).toBe(1);
	});

	it('should put a ten-step end function on the tenths', () => {
		// the spinner's own shape: ten frames, each held for a tenth of the cycle,
		// and the tenth one is reached at 0.9 rather than at 1
		const steps = parseEasing('steps(10, end)');
		const seen = new Set<number>();
		for (let i = 0; i < 100; i++) {
			seen.add(Math.round(ease(steps, i / 100) * 10));
		}
		expect([...seen].sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
		// and exactly 1 at the very end, which is the clamp CSS specifies
		expect(ease(steps, 1)).toBe(1);
	});

	it('should start a start function on the first step rather than on zero', () => {
		const steps = parseEasing('steps(4, start)');
		expect(ease(steps, 0)).toBe(0.25);
		expect(ease(steps, 0.99)).toBe(1);
		expect(ease(steps, 1)).toBe(1);
	});

	it('should give jump-none both ends and jump-both neither', () => {
		const none = parseEasing('steps(4, jump-none)');
		expect(ease(none, 0)).toBe(0);
		expect(ease(none, 1)).toBe(1);

		const both = parseEasing('steps(4, jump-both)');
		expect(ease(both, 0)).toBeCloseTo(0.2, 10);
		expect(ease(both, 1)).toBeCloseTo(1, 10);
	});

	it('should hold a cubic curve to its endpoints and keep it monotone', () => {
		for (const name of ['ease', 'ease-in', 'ease-out', 'ease-in-out']) {
			const easing = parseEasing(name);
			expect(ease(easing, 0), name).toBe(0);
			expect(ease(easing, 1), name).toBe(1);

			let last = -1;
			for (let i = 0; i <= 100; i++) {
				const value = ease(easing, i / 100);
				expect(value, `${name} at ${i / 100}`).toBeGreaterThanOrEqual(last - 1e-9);
				expect(value, `${name} at ${i / 100}`).toBeLessThanOrEqual(1 + 1e-9);
				last = value;
			}
		}
	});

	it('should solve ease-in past the flat spot its derivative has at the end', () => {
		// `(0.42, 0, 1, 1)` has a near-zero x derivative near t=1, which is where
		// Newton-Raphson wanders off and the bisection fallback earns its keep
		const easing = parseEasing('ease-in');
		expect(ease(easing, 0.999)).toBeGreaterThan(0.99);
		expect(Number.isFinite(ease(easing, 0.999))).toBe(true);
	});

	it('should agree with the named curve a cubic-bezier spells out', () => {
		const named = parseEasing('ease-out');
		const spelled = parseEasing('cubic-bezier(0, 0, 0.58, 1)');
		for (let i = 0; i <= 10; i++) {
			expect(ease(spelled, i / 10)).toBeCloseTo(ease(named, i / 10), 6);
		}
		// and the two are different objects, because the source they report is the
		// thing that was written
		expect((named as Easing).source).toBe('ease-out');
		expect((spelled as Easing).source).toBe('cubic-bezier(0, 0, 0.58, 1)');
	});
});
