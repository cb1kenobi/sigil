import { palette, rgb } from '../../src/canvas/style.js';
import {
	Animator,
	Cascade,
	cells,
	declare,
	type Declarations,
	DEFAULT_MEDIA,
	type MediaContext,
	parseStylesheet,
	type PropertyName,
	type Style,
} from '../../src/style/index.js';
import { describe, expect, it } from 'vitest';

/**
 * The animator.
 *
 * Driven by a clock the test owns, which is the whole reason `now` is injectable:
 * an animation test that waits for wall time is flaky forever.
 */

/** A target: identity is all the animator wants of one. */
function target(name = 't'): { name: string } {
	return { name };
}

function cascade(css = '', media: Partial<MediaContext> = {}): Cascade {
	return new Cascade(css ? [parseStylesheet(css)] : [], {
		...DEFAULT_MEDIA,
		...media,
	});
}

/** The animator, with motion allowed unless a test says otherwise. */
function animator(css = '', media: Partial<MediaContext> = {}) {
	return new Animator<{ name: string }>(cascade(css, media));
}

/**
 * What the animator is *overriding* for one property, after a tick.
 *
 * `undefined` means it is overriding nothing, which is not the same as showing
 * nothing: an override equal to the base is dropped, because the base is what
 * the renderer has already written onto the element. `screen()` is the other
 * question.
 */
function present<K extends PropertyName>(
	it: Animator<{ name: string }>,
	node: { name: string },
	property: K,
	now: number
): Style[K] | undefined {
	it.tick(now);
	return it.styleOf(node)?.[property];
}

/** What would be on screen: the override where there is one, else the base. */
function screen<K extends PropertyName>(
	it: Animator<{ name: string }>,
	node: { name: string },
	base: Style,
	property: K,
	now: number
): Style[K] {
	it.tick(now);
	return (it.styleOf(node) ?? base)[property];
}

describe('a transition', () => {
	const from = declare({ transition: 'width 100ms linear', width: '10' });
	const to = declare({ transition: 'width 100ms linear', width: '20' });

	it('should not start on an element first style, which has nothing to come from', () => {
		// without the rule every element in a tree animates from its initial style
		// on the first frame
		const it = animator();
		const node = target();
		it.observe(node, to, 0);
		expect(it.active).toBe(false);
		expect(it.tick(0).styles.size).toBe(0);
	});

	it('should run from the old value to the new one, in whole cells', () => {
		const it = animator();
		const node = target();
		it.observe(node, from, 0);
		it.observe(node, to, 0);

		expect(present(it, node, 'width', 0)).toEqual(cells(10));
		expect(present(it, node, 'width', 50)).toEqual(cells(15));
		expect(present(it, node, 'width', 80)).toEqual(cells(18));
		// and the end is the base again, so there is nothing left to present
		expect(present(it, node, 'width', 100)).toBeUndefined();
		expect(it.active).toBe(false);
	});

	it('should report layout for a geometry property and paint for a colour', () => {
		// the one refinement the recorded architecture needed: an animated geometry
		// property is in `LAYOUT_PROPERTIES` and genuinely has to re-lay-out
		const it = animator();
		const node = target();
		it.observe(node, from, 0);
		it.observe(node, to, 0);
		const frame = it.tick(50);
		expect(frame.layout.has(node)).toBe(true);
		expect(frame.paint.has(node)).toBe(true);

		const colours = animator();
		const dark = declare({ color: '#000000', transition: 'color 100ms linear' });
		const light = declare({ color: '#ffffff', transition: 'color 100ms linear' });
		colours.observe(node, dark, 0);
		colours.observe(node, light, 0);
		const second = colours.tick(50);
		expect(second.paint.has(node)).toBe(true);
		expect(second.layout.has(node)).toBe(false);
	});

	it('should hand back the same style object where nothing quantized differently', () => {
		// a text's measurement cache is keyed on the resolved style *object*, so a
		// new one per frame would re-wrap every string in an animating subtree
		const slow = declare({ transition: 'width 1000ms linear', width: '10' });
		const slower = declare({ transition: 'width 1000ms linear', width: '11' });
		const it = animator();
		const node = target();
		it.observe(node, slow, 0);
		it.observe(node, slower, 0);

		it.tick(0);
		const first = it.styleOf(node);
		it.tick(10);
		expect(it.styleOf(node)).toBe(first);
		it.tick(20);
		expect(it.styleOf(node)).toBe(first);
		// and a different object once the cell really did move
		it.tick(600);
		expect(it.styleOf(node)).not.toBe(first);
	});

	it('should animate from the value on screen when it is interrupted', () => {
		// CSS, and the only answer that does not look broken: a focus ring half way
		// through easing in and then unfocused eases back from where it is
		const it = animator();
		const node = target();
		it.observe(node, from, 0);
		it.observe(node, to, 0);
		it.tick(50);
		expect(it.styleOf(node)?.width).toEqual(cells(15));

		// back to ten, half way through
		it.observe(node, from, 50);
		expect(present(it, node, 'width', 50)).toEqual(cells(15));
		// fifteen towards ten over a hundred milliseconds, a quarter of the way in
		expect(present(it, node, 'width', 75)).toEqual(cells(14));
		expect(present(it, node, 'width', 150)).toBeUndefined();
	});

	it('should hold the old value through a delay', () => {
		const delayed = declare({ transition: 'width 100ms linear 50ms', width: '20' });
		const it = animator();
		const node = target();
		it.observe(node, declare({ transition: 'width 100ms linear 50ms', width: '10' }), 0);
		it.observe(node, delayed, 0);

		expect(present(it, node, 'width', 0)).toEqual(cells(10));
		expect(present(it, node, 'width', 49)).toEqual(cells(10));
		expect(present(it, node, 'width', 100)).toEqual(cells(15));
		expect(present(it, node, 'width', 150)).toBeUndefined();
	});

	it('should animate only the properties transition-property names', () => {
		const a = declare({ color: '#000000', transition: 'width 100ms linear', width: '10' });
		const b = declare({ color: '#ffffff', transition: 'width 100ms linear', width: '20' });
		const it = animator();
		const node = target();
		it.observe(node, a, 0);
		it.observe(node, b, 0);
		it.tick(50);
		expect(it.styleOf(node)?.width).toEqual(cells(15));
		// the colour snapped, which is what a base style the animator does not
		// override comes to
		expect(it.styleOf(node)?.color).toBe(rgb(255, 255, 255));
	});

	it('should animate a shorthand transition-property as every edge it covers', () => {
		const a = declare({
			padding: '0',
			'transition-property': 'padding',
			'transition-duration': '100ms',
		});
		const b = declare({
			padding: '4',
			'transition-property': 'padding',
			'transition-duration': '100ms',
		});
		const it = animator();
		const node = target();
		it.observe(node, a, 0);
		it.observe(node, b, 0);
		it.tick(50);
		expect(it.styleOf(node)?.paddingTop).toBe(2);
		expect(it.styleOf(node)?.paddingLeft).toBe(2);
	});

	it('should animate everything for all and nothing for none', () => {
		const all = animator();
		const node = target();
		all.observe(node, declare({ color: '#000000', transition: 'all 100ms linear' }), 0);
		all.observe(node, declare({ color: '#ffffff', transition: 'all 100ms linear' }), 0);
		expect(all.active).toBe(true);

		const none = animator();
		const other = target('o');
		none.observe(other, declare({ color: '#000000', transition: 'none 100ms linear' }), 0);
		none.observe(other, declare({ color: '#ffffff', transition: 'none 100ms linear' }), 0);
		expect(none.active).toBe(false);
	});

	it('should cancel a running transition when the duration goes away', () => {
		const it = animator();
		const node = target();
		it.observe(node, from, 0);
		it.observe(node, to, 0);
		it.tick(50);
		expect(it.active).toBe(true);

		it.observe(node, declare({ width: '20' }), 50);
		expect(it.active).toBe(false);
		expect(present(it, node, 'width', 50)).toBeUndefined();
	});

	it('should flip a discrete property at the midpoint', () => {
		const it = animator();
		const node = target();
		const bold = declare({ bold: 'true', transition: 'bold 100ms linear' });
		it.observe(node, declare({ bold: 'false', transition: 'bold 100ms linear' }), 0);
		it.observe(node, bold, 0);
		expect(screen(it, node, bold, 'bold', 49)).toBe(false);
		expect(screen(it, node, bold, 'bold', 50)).toBe(true);
		// and past the midpoint it overrides nothing, because the value it would
		// write is the base the renderer has already put on the element
		expect(present(it, node, 'bold', 50)).toBeUndefined();
	});

	it('should snap a palette colour rather than mixing through xterm defaults', () => {
		const it = animator();
		const node = target();
		const blue = declare({ color: 'blue', transition: 'color 100ms linear' });
		it.observe(node, declare({ color: 'red', transition: 'color 100ms linear' }), 0);
		it.observe(node, blue, 0);
		expect(screen(it, node, blue, 'color', 40)).toBe(palette(1));
		expect(screen(it, node, blue, 'color', 60)).toBe(palette(4));
	});

	it('should carry a base change the transition does not cover onto the screen', () => {
		const a = declare({ color: '#000000', transition: 'width 100ms linear', width: '10' });
		const b = declare({ color: '#000000', transition: 'width 100ms linear', width: '20' });
		const c = declare({ color: '#ff0000', transition: 'width 100ms linear', width: '20' });
		const it = animator();
		const node = target();
		it.observe(node, a, 0);
		it.observe(node, b, 0);
		it.tick(50);
		it.observe(node, c, 50);
		it.tick(50);
		expect(it.styleOf(node)?.color).toBe(rgb(255, 0, 0));
		expect(it.styleOf(node)?.width).toEqual(cells(15));
	});

	it('should hold state only for an element with something in flight', () => {
		// the base style is kept per element, because the *next* change animates
		// from it; what is kept per *frame* is only what is running, so the tick
		// loop is proportional to the animation rather than to the tree
		const it = animator();
		const node = target();
		it.observe(node, from, 0);
		expect(it.size).toBe(0);
		it.observe(node, to, 0);
		expect(it.size).toBe(1);
		it.tick(200);
		expect(it.size).toBe(0);

		// and the base survives, so a change after it still animates
		it.observe(node, from, 200);
		expect(it.active).toBe(true);
	});

	it('should forget an element that was unmounted', () => {
		const it = animator();
		const node = target();
		it.observe(node, from, 0);
		it.observe(node, to, 0);
		expect(it.active).toBe(true);
		it.forget(node);
		expect(it.active).toBe(false);
		expect(it.size).toBe(0);
	});
});

describe('the frame skip', () => {
	it('should say how long until something quantizes differently', () => {
		// 1000ms over ten cells is a change every hundred milliseconds, so a frame
		// loop at thirty a second has twenty-nine frames out of thirty to skip
		const it = animator();
		const node = target();
		it.observe(node, declare({ transition: 'width 1000ms linear', width: '10' }), 0);
		it.observe(node, declare({ transition: 'width 1000ms linear', width: '20' }), 0);
		it.tick(0);

		const next = it.nextChange(0, 1000 / 30) as number;
		expect(next).toBeGreaterThan(30);
		expect(next).toBeLessThanOrEqual(100);
	});

	it('should answer nothing where nothing is animating', () => {
		const it = animator();
		expect(it.nextChange(0, 1000 / 30)).toBeUndefined();
	});

	it('should land exactly on a step boundary', () => {
		const it = animator('@keyframes four { from { left: 0 } to { left: 4 } }');
		const node = target();
		it.observe(
			node,
			declare({ animation: 'four 400ms steps(4, end) infinite', position: 'relative' }),
			0
		);
		it.tick(0);
		// each step lasts a hundred milliseconds, so the next change is a hundred
		// away whatever the frame length is
		expect(it.nextChange(0, 10)).toBe(100);
		expect(it.nextChange(30, 10)).toBe(70);
	});

	it('should skip the overwhelming majority of frames on a slow animation', () => {
		// the measurement the ticket asked for, as an assertion: a thirty-frame
		// second over a two-cell change is two frames that draw anything
		const it = animator();
		const node = target();
		it.observe(node, declare({ transition: 'width 1000ms linear', width: '0' }), 0);
		it.observe(node, declare({ transition: 'width 1000ms linear', width: '2' }), 0);

		let naive = 0;
		const step = 1000 / 30;
		for (let frame = 0; frame <= 30; frame++) {
			const result = it.tick(frame * step);
			if (result.paint.has(node)) {
				naive++;
			}
		}
		// 0 -> 1 -> 2, and the final retire that puts the base back
		expect(naive).toBeLessThanOrEqual(4);
	});

	it('should wake for the end even where the last frames are identical', () => {
		// the entry has to be retired for `active` to go false, and `active` going
		// false is what stops the timer
		const it = animator();
		const node = target();
		it.observe(node, declare({ transition: 'width 50ms linear', width: '0' }), 0);
		it.observe(node, declare({ transition: 'width 50ms linear', width: '1' }), 0);
		it.tick(40);
		expect(it.nextChange(40, 1000)).toBe(10);
	});
});

describe('an animation', () => {
	const sheet = '@keyframes slide { from { left: 0 } to { left: 10 } }';
	const running = declare({ animation: 'slide 100ms linear', position: 'relative' });

	it('should start as soon as it is applied, unlike a transition', () => {
		const it = animator(sheet);
		const node = target();
		it.observe(node, running, 0);
		expect(it.active).toBe(true);
		expect(present(it, node, 'left', 50)).toEqual(cells(5));
	});

	it('should run nothing for a name nothing declares', () => {
		const it = animator();
		const node = target();
		it.observe(node, running, 0);
		expect(it.active).toBe(false);
	});

	it('should run its iterations and then stop', () => {
		const it = animator(sheet);
		const node = target();
		it.observe(node, declare({ animation: 'slide 100ms linear 0s 2', position: 'relative' }), 0);
		expect(present(it, node, 'left', 50)).toEqual(cells(5));
		expect(present(it, node, 'left', 150)).toEqual(cells(5));
		expect(present(it, node, 'left', 200)).toBeUndefined();
		expect(it.active).toBe(false);
	});

	it('should hold its last value under a forwards fill, without staying active', () => {
		const it = animator(sheet);
		const node = target();
		it.observe(
			node,
			declare({ animation: 'slide 100ms linear 0s 1 normal forwards', position: 'relative' }),
			0
		);
		expect(present(it, node, 'left', 200)).toEqual(cells(10));
		// nothing more will change, so the frame loop may stop
		expect(it.active).toBe(false);
		expect(it.size).toBe(1);
	});

	it('should show nothing before a delay unless the fill reaches backwards', () => {
		const it = animator(sheet);
		const node = target();
		it.observe(node, declare({ animation: 'slide 100ms linear 50ms', position: 'relative' }), 0);
		expect(present(it, node, 'left', 10)).toBeUndefined();

		const filled = animator(sheet);
		const other = target('o');
		filled.observe(
			other,
			declare({ animation: 'slide 100ms linear 50ms 1 normal backwards', position: 'relative' }),
			0
		);
		// `left: 0` is the base too, so the fill shows as nothing overriding -- what
		// it proves is the frame after, which the delayed one has not reached
		expect(present(filled, other, 'left', 75)).toEqual(cells(3));
		expect(present(it, other, 'left', 75)).toBeUndefined();
	});

	it('should reverse and alternate', () => {
		const reverse = animator(sheet);
		const node = target();
		reverse.observe(
			node,
			declare({ animation: 'slide 100ms linear 0s 1 reverse', position: 'relative' }),
			0
		);
		expect(present(reverse, node, 'left', 25)).toEqual(cells(8));

		const alternate = animator(sheet);
		const other = target('o');
		alternate.observe(
			other,
			declare({ animation: 'slide 100ms linear 0s 2 alternate', position: 'relative' }),
			0
		);
		expect(present(alternate, other, 'left', 25)).toEqual(cells(3));
		// the second iteration runs backwards
		expect(present(alternate, other, 'left', 125)).toEqual(cells(8));
	});

	it('should take the base value for an endpoint no stop declares', () => {
		// CSS's implicit 0% and 100% keyframes, which is what makes
		// `@keyframes { from { left: 0 } }` ease into whatever the element says
		const it = animator('@keyframes half { from { left: 0 } }');
		const node = target();
		it.observe(
			node,
			declare({ animation: 'half 100ms linear', left: '8', position: 'relative' }),
			0
		);
		expect(present(it, node, 'left', 50)).toEqual(cells(4));
	});

	it('should skip a keyframe declaration for a property that does not animate', () => {
		// an animation that animated its own duration would be asking what the
		// duration is in order to find out what it is
		const it = animator(
			'@keyframes meta { from { left: 0 } to { transition-duration: 5s; left: 4 } }'
		);
		const node = target();
		it.observe(node, declare({ animation: 'meta 100ms linear', position: 'relative' }), 0);
		it.tick(50);
		expect(it.styleOf(node)?.left).toEqual(cells(2));
		expect(it.styleOf(node)?.transitionDuration).toBe(0);
	});

	it('should take the last writer where two stops share an offset', () => {
		const it = animator('@keyframes x { to { left: 1 } to { left: 9 } }');
		const node = target();
		it.observe(node, declare({ animation: 'x 100ms linear', position: 'relative' }), 0);
		expect(present(it, node, 'left', 100 - 1e-9)).toEqual(cells(9));
	});

	it('should take the timing up in place and restart only on a new name', () => {
		const it = animator(`${sheet} @keyframes other { from { left: 10 } to { left: 0 } }`);
		const node = target();
		it.observe(node, running, 0);
		it.tick(50);
		expect(it.styleOf(node)?.left).toEqual(cells(5));

		// a longer duration, same name: the clock is not reset, so half way through
		// the old one is a quarter of the way through the new
		it.observe(node, declare({ animation: 'slide 200ms linear', position: 'relative' }), 50);
		expect(present(it, node, 'left', 50)).toEqual(cells(3));

		// a new name starts from the beginning
		it.observe(node, declare({ animation: 'other 100ms linear', position: 'relative' }), 50);
		expect(present(it, node, 'left', 50)).toEqual(cells(10));
	});

	it('should stop when the name goes away', () => {
		const it = animator(sheet);
		const node = target();
		it.observe(node, running, 0);
		it.tick(50);
		it.observe(node, declare({ position: 'relative' }), 50);
		expect(it.active).toBe(false);
	});

	it('should run nothing for a zero duration or zero iterations', () => {
		for (const value of ['slide 0s linear', 'slide 100ms linear 0s 0']) {
			const it = animator(sheet);
			const node = target();
			it.observe(node, declare({ animation: value, left: '2', position: 'relative' }), 0);
			expect(it.active, value).toBe(false);
			// and with the default fill of `none` it presents nothing, which is the
			// half the first version of this test asserted and all it asserted
			expect(present(it, node, 'left', 0), value).toBeUndefined();
		}
	});

	it('should still apply the fill of one with no play time, which CSS does', () => {
		// a zero duration is an animation whose active duration is zero, so it is
		// immediately in its after phase -- and `forwards` holds the 100% keyframe
		// there. Dropping it outright is right for `none` and loses the frame for
		// `forwards`, and `animation: slide forwards` is the same input, because an
		// omitted duration defaults to `0s`
		for (const value of [
			'slide 0s linear 0s 1 normal forwards',
			'slide forwards',
			'slide 0s linear 0s 1 normal both',
		]) {
			const it = animator(sheet);
			const node = target();
			it.observe(node, declare({ animation: value, left: '2', position: 'relative' }), 0);
			expect(present(it, node, 'left', 0), value).toEqual(cells(10));
			expect(it.active, value).toBe(false);
		}
	});

	it('should apply the 0% keyframe where there are no iterations at all', () => {
		// CSS: a count of zero ran no iterations, so what `forwards` holds is the
		// start rather than the end -- which is reachable only because a zero count
		// now settles with its fill instead of being dropped
		const it = animator('@keyframes slide { from { left: 3 } to { left: 9 } }');
		const node = target();
		it.observe(
			node,
			declare({ animation: 'slide 100ms linear 0s 0 normal forwards', position: 'relative' }),
			0
		);
		expect(present(it, node, 'left', 0)).toEqual(cells(3));
	});

	it('should take a fill away with the animation that left it', () => {
		// a fill belongs to its animation, so `animation-name: none` removes it --
		// it used to survive for the life of the element
		const it = animator(sheet);
		const node = target();
		const running = declare({
			animation: 'slide 100ms linear 0s 1 normal forwards',
			left: '0',
			position: 'relative',
		});
		it.observe(node, running, 0);
		expect(present(it, node, 'left', 200)).toEqual(cells(10));

		it.observe(node, declare({ left: '0', position: 'relative' }), 200);
		expect(present(it, node, 'left', 200)).toBeUndefined();
		expect(it.size).toBe(0);
	});

	it('should not restart a finished animation because something else changed', () => {
		// the same field read from the other side: a finished animation whose name
		// is still declared ran again on the next style change of any kind, so a
		// colour write half a second later replayed the whole thing
		const it = animator(sheet);
		const node = target();
		const base = {
			animation: 'slide 100ms linear 0s 1 normal forwards',
			left: '0',
			position: 'relative',
		};
		it.observe(node, declare(base), 0);
		expect(present(it, node, 'left', 200)).toEqual(cells(10));
		expect(it.active).toBe(false);

		it.observe(node, declare({ ...base, color: 'red' }), 200);
		expect(it.active).toBe(false);
		expect(present(it, node, 'left', 250)).toEqual(cells(10));
	});

	it('should take the old fill away when a new animation replaces it', () => {
		// the two animations touch *different* properties on purpose: with one
		// property the incoming animation's own value covers the stale fill every
		// frame, so a fill that was never cleared is invisible -- which is exactly
		// how this guard came to survive its first sabotage
		const it = animator(
			`${sheet} @keyframes hot { from { color: #000000 } to { color: #ffffff } }`
		);
		const node = target();
		const base = {
			animation: 'slide 100ms linear 0s 1 normal forwards',
			left: '0',
			position: 'relative',
		};
		it.observe(node, declare(base), 0);
		expect(present(it, node, 'left', 200)).toEqual(cells(10));

		it.observe(node, declare({ ...base, animation: 'hot 100ms linear' }), 200);
		it.tick(250);
		// the colour is the new animation's, and `left` is the element's own again
		// rather than the ten the old animation's fill was holding
		expect(it.styleOf(node)?.left).toEqual(cells(0));
		expect(it.styleOf(node)?.color).not.toBe(declare({ color: '#000000' }).color);
	});

	it('should not restart a finished animation whose fill matches the base', () => {
		// the input the first restart test missed: `#overridesAt()` drops an override
		// equal to the base, so the entry held nothing and `tick()` dropped it --
		// taking the record of what had finished with it, after which a `color`
		// write replayed the whole animation
		const it = animator('@keyframes nudge { to { left: 10 } }');
		const node = target();
		const base = {
			animation: 'nudge 100ms linear 0s 1 normal forwards',
			left: '10',
			position: 'relative',
		};
		it.observe(node, declare(base), 0);
		it.tick(200);
		expect(it.active).toBe(false);
		expect(it.size).toBe(1);

		it.observe(node, declare({ ...base, color: 'red' }), 200);
		expect(it.active).toBe(false);
	});

	it('should not restart one whose fill mode is none either', () => {
		// the same thing with nothing to hold at all, which is the default fill
		const it = animator('@keyframes nudge { to { left: 10 } }');
		const node = target();
		const base = { animation: 'nudge 100ms linear', left: '0', position: 'relative' };
		it.observe(node, declare(base), 0);
		it.tick(200);
		expect(it.active).toBe(false);

		it.observe(node, declare({ ...base, color: 'red' }), 200);
		expect(it.active).toBe(false);
		expect(present(it, node, 'left', 250)).toBeUndefined();
	});

	it('should re-read the stops when a sheet rewrites them under the same name', () => {
		// `timing()` deliberately does not carry the stops, which is right for the
		// path it was written for -- a timing change -- and wrong for the one that
		// grew beside it: a `touchSheets()` rewriting `@keyframes slide` while
		// `animation-name` stays `slide` left the animation running on the stops it
		// indexed at start, for the rest of its duration, with nothing to see
		const sheets = cascade(sheet, { reducedMotion: 'no-preference' });
		const it = new Animator<{ name: string }>(sheets);
		const node = target();
		const base = { animation: 'slide 100ms linear', color: 'red', position: 'relative' };
		it.observe(node, declare(base), 0);
		expect(present(it, node, 'left', 50)).toEqual(cells(5));

		sheets.add(parseStylesheet('@keyframes slide { from { left: 0 } to { left: 100 } }'));
		it.observe(node, declare({ ...base, color: 'blue' }), 50);
		expect(present(it, node, 'left', 50)).toEqual(cells(50));
	});

	it('should recompute a fill a sheet made stale', () => {
		// the same question asked of an animation that has already finished: the
		// value it is holding came from stops that are no longer the animation's
		const sheets = cascade('@keyframes k { to { left: 10 } }', {
			reducedMotion: 'no-preference',
		});
		const it = new Animator<{ name: string }>(sheets);
		const node = target();
		const base = {
			animation: 'k 100ms linear 0s 1 normal forwards',
			left: '0',
			position: 'relative',
		};
		it.observe(node, declare(base), 0);
		expect(present(it, node, 'left', 200)).toEqual(cells(10));

		sheets.add(parseStylesheet('@keyframes k { to { left: 3 } }'));
		it.observe(node, declare({ ...base, color: 'red' }), 200);
		expect(present(it, node, 'left', 200)).toEqual(cells(3));
		// and it still has not restarted
		expect(it.active).toBe(false);
	});

	it('should restart when the name changes, which is the one thing that does', () => {
		const it = animator(`${sheet} @keyframes other { from { left: 9 } to { left: 1 } }`);
		const node = target();
		const base = {
			animation: 'slide 100ms linear 0s 1 normal forwards',
			left: '0',
			position: 'relative',
		};
		it.observe(node, declare(base), 0);
		it.tick(200);
		expect(it.styleOf(node)?.left).toEqual(cells(10));

		it.observe(
			node,
			declare({ ...base, animation: 'other 100ms linear 0s 1 normal forwards' }),
			200
		);
		expect(it.active).toBe(true);
		expect(present(it, node, 'left', 250)).toEqual(cells(5));
	});

	it('should present a finite value for every defaulted and degenerate input', () => {
		// **the enumeration, rather than a claim that no path can produce a `NaN`.**
		// That claim was made once and was false, and the input that falsified it is
		// the one nobody writes on purpose: `animation-duration` *starts at `0`*, so
		// `animation: slide infinite` and the bare longhands are an endless
		// animation with no play time -- and `endOf()` for that is `0 * Infinity`,
		// which is `NaN`. It presented `flexGrow: NaN` and `cells(NaN)` with
		// `active` false, so nothing on screen said so and no timer ran.
		//
		// A negative claim about all inputs cannot be established by tracing the
		// route you had in mind, so this walks the defaults instead: every
		// combination of the two values that can be left out, the five iteration
		// counts worth having, every fill mode and direction, both motion settings
		// and an empty keyframes body.
		const bodies = [
			'@keyframes k { from { left: 0; flex-grow: 0 } to { left: 10; flex-grow: 2 } }',
			'@keyframes k { to { left: 10 } }',
			'@keyframes k { }',
		];
		const durations = ['', '0s ', '100ms '];
		const counts = ['', '0 ', '1 ', '2.5 ', 'infinite '];
		const fills = ['', 'none', 'forwards', 'backwards', 'both'];
		const directions = ['', 'reverse', 'alternate', 'alternate-reverse'];

		let checked = 0;
		for (const body of bodies) {
			for (const reduce of [false, true]) {
				for (const duration of durations) {
					for (const count of counts) {
						for (const fill of fills) {
							for (const direction of directions) {
								const value = `k ${duration}linear 0s ${count}${direction} ${fill}`.replace(
									/\s+/g,
									' '
								);
								const it = animator(body, {
									reducedMotion: reduce ? 'reduce' : 'no-preference',
								});
								const node = target();
								it.observe(
									node,
									declare({ animation: value, 'flex-grow': '0', left: '0', position: 'relative' }),
									0
								);
								for (const at of [0, 1, 37, 100, 101, 400]) {
									it.tick(at);
									const style = it.styleOf(node);
									if (!style) {
										continue;
									}
									const left = style.left as { value?: number };
									const where = `"${value}" reduce=${String(reduce)} at ${String(at)}`;
									expect(Number.isFinite(style.flexGrow), where).toBe(true);
									if (left.value !== undefined) {
										expect(Number.isFinite(left.value), where).toBe(true);
									}
									checked++;
								}
							}
						}
					}
				}
			}
		}
		// and the walk really did reach presented styles rather than skipping
		expect(checked).toBeGreaterThan(200);
	});

	it('should run nothing for a keyframes body with no stops in it', () => {
		// it touches no property, so running it would hold the frame loop open to
		// present nothing -- which is the rule `#commit()` already states, met by an
		// input nothing covered
		const it = animator('@keyframes spin { }');
		const node = target();
		it.observe(node, declare({ animation: 'spin 100ms linear 0s infinite' }), 0);
		it.tick(0);
		expect(it.active).toBe(false);
		expect(it.nextChange(0, 1000 / 30)).toBeUndefined();
		expect(it.size).toBe(0);
	});

	it('should refuse an endless animation with no play time, whichever way it is written', () => {
		// the two spellings are one input, because `animation-duration` starts at 0
		const spellings: Declarations[] = [
			{ animation: 'k infinite' },
			{ 'animation-iteration-count': 'infinite', 'animation-name': 'k' },
			{ animation: 'k 0s linear 0s infinite normal forwards' },
		];
		for (const style of spellings) {
			const it = animator('@keyframes k { to { left: 10 } }');
			const node = target();
			it.observe(node, declare({ ...style, left: '4', position: 'relative' }), 0);
			it.tick(0);
			expect(present(it, node, 'left', 0), JSON.stringify(style)).toBeUndefined();
			expect(it.active, JSON.stringify(style)).toBe(false);
		}
	});

	it('should let a transition beat an animation over one property', () => {
		// CSS puts transitions above animations: a loop losing is the only order
		// that lets a component stop one
		const it = animator(sheet);
		const node = target();
		it.observe(
			node,
			declare({
				animation: 'slide 100ms linear',
				left: '0',
				position: 'relative',
				transition: 'left 100ms linear',
			}),
			0
		);
		it.observe(
			node,
			declare({
				animation: 'slide 100ms linear',
				left: '4',
				position: 'relative',
				transition: 'left 100ms linear',
			}),
			0
		);
		// the transition runs from what the animation was showing towards 4
		expect(present(it, node, 'left', 50)).toEqual(cells(2));
	});
});

describe('reduced motion', () => {
	const sheet = '@keyframes slide { from { left: 0 } to { left: 10 } }';

	it('should snap a transition rather than running it', () => {
		const it = animator('', { reducedMotion: 'reduce' });
		const node = target();
		it.observe(node, declare({ transition: 'width 100ms linear', width: '10' }), 0);
		it.observe(node, declare({ transition: 'width 100ms linear', width: '20' }), 0);
		expect(it.active).toBe(false);
		expect(it.tick(0).styles.size).toBe(0);
	});

	it('should collapse a finite animation to its end state', () => {
		const it = animator(sheet, { reducedMotion: 'reduce' });
		const node = target();
		it.observe(
			node,
			declare({ animation: 'slide 100ms linear 0s 1 normal forwards', position: 'relative' }),
			0
		);
		expect(present(it, node, 'left', 0)).toEqual(cells(10));
	});

	it('should refuse an infinite animation, which has no end state to collapse to', () => {
		const it = animator(sheet, { reducedMotion: 'reduce' });
		const node = target();
		it.observe(
			node,
			declare({ animation: 'slide 100ms linear 0s infinite', position: 'relative' }),
			0
		);
		expect(present(it, node, 'left', 0)).toBeUndefined();
		expect(present(it, node, 'left', 500)).toBeUndefined();
	});

	it('should refuse an infinite animation even where its fill would have held one', () => {
		// an infinite animation has no final iteration for `forwards` to hold, and
		// `left: 0` on the element is load bearing in a way the first version of
		// this test missed: with a base of `auto`, `mixLength()` hands the `auto`
		// back untouched, so the `Infinity % 1` this once computed never reached
		// any arithmetic and a sabotage of the guard in front of it passed. On a
		// concrete length the same path produced an override of `cells(NaN)` --
		// kept, because `NaN === 0` is false -- and handed the layout engine a
		// width of `NaN`
		const it = animator(sheet, { reducedMotion: 'reduce' });
		const node = target();
		it.observe(
			node,
			declare({
				animation: 'slide 100ms linear 0s infinite normal forwards',
				left: '0',
				position: 'relative',
			}),
			0
		);
		expect(present(it, node, 'left', 0)).toBeUndefined();
		expect(present(it, node, 'left', 500)).toBeUndefined();
		expect(it.active).toBe(false);
	});

	it('should present a number for every frame of every property it animates', () => {
		// the general form of the same thing, and the reason it is worth asserting
		// over the corpus rather than per property: what reached the layout engine
		// was a `Length` whose value was `NaN`, which nothing downstream refuses
		for (const reduce of [false, true]) {
			for (const value of ['slide 100ms linear 0s infinite', 'slide 100ms linear 0s 2 alternate']) {
				const it = animator(sheet, { reducedMotion: reduce ? 'reduce' : 'no-preference' });
				const node = target();
				it.observe(node, declare({ animation: value, left: '0', position: 'relative' }), 0);
				for (let at = 0; at <= 400; at += 7) {
					it.tick(at);
					const left = it.styleOf(node)?.left as { value?: number } | undefined;
					if (left?.value !== undefined) {
						expect(Number.isFinite(left.value), `${value} at ${String(at)}`).toBe(true);
					}
				}
			}
		}
	});

	it('should present a colour for every frame, which is the sharper case', () => {
		// a `Length` of `NaN` is a wrong layout; a *colour* of `NaN` is a throw out
		// of `rgb()`, which refuses a channel rather than clamping it -- so this is
		// the one where the failure arrives from inside the painter
		const hot = '@keyframes hot { from { color: #000000 } to { color: #ffffff } }';
		for (const reduce of [false, true]) {
			const it = animator(hot, { reducedMotion: reduce ? 'reduce' : 'no-preference' });
			const node = target();
			expect(() => {
				it.observe(
					node,
					declare({ animation: 'hot 100ms linear 0s infinite', color: '#808080' }),
					0
				);
				for (let at = 0; at <= 400; at += 7) {
					it.tick(at);
				}
			}).not.toThrow();
		}
	});

	it('should stop a running animation when the preference is published', () => {
		// `prefers-reduced-motion` is a media query, so whether an animation runs is
		// a live answer -- and it is *published* rather than read from inside the
		// per-frame arithmetic, which is the shape `Restyler.touchMedia()` already
		// has and is what stops a refused animation holding the frame loop open
		const sheets = cascade(sheet, { reducedMotion: 'no-preference' });
		const it = new Animator<{ name: string }>(sheets);
		const node = target();
		it.observe(node, declare({ animation: 'slide 100ms linear', position: 'relative' }), 0);
		expect(it.tick(50).styles.size).toBe(1);
		expect(it.active).toBe(true);

		sheets.media = { ...sheets.media, reducedMotion: 'reduce' };
		it.touchMedia(50);
		expect(it.tick(50).styles.size).toBe(0);
		expect(it.active).toBe(false);
	});

	it('should start one the preference had refused, once it is allowed again', () => {
		// a refused animation leaves no entry at all -- `tick()` drops an entry with
		// nothing in it -- so the walk has to be over every element the animator has
		// a *base* for rather than over what is in flight. The `tick()` here is what
		// makes that true rather than incidental: without it the empty entry is
		// still there and a walk over `#entries` would find it anyway
		const sheets = cascade(sheet, { reducedMotion: 'reduce' });
		const it = new Animator<{ name: string }>(sheets);
		const node = target();
		it.observe(
			node,
			declare({ animation: 'slide 100ms linear 0s infinite', position: 'relative' }),
			0
		);
		it.tick(0);
		expect(it.active).toBe(false);
		expect(it.size).toBe(0);

		sheets.media = { ...sheets.media, reducedMotion: 'no-preference' };
		it.touchMedia(0);
		expect(it.active).toBe(true);
		expect(present(it, node, 'left', 50)).toEqual(cells(5));
	});

	it('should start a collapsed animation across two publishes with no frame between', () => {
		// `touchMedia()` is a reader that does **not** tick, and a resize and a
		// capability reply each publish one -- so two of them can land back to back.
		// The first version recorded a fill only when it was non-empty and argued
		// that `tick()` dropped an empty entry before anything could read it, which
		// is exactly the caller that argument did not enumerate: the second
		// `#syncAnimation()` saw the empty record, took it for a finished animation
		// and returned, and turning the preference off in that window never started
		// anything. What tells the two apart is `ran`, not emptiness
		const sheets = cascade(sheet, { reducedMotion: 'reduce' });
		const it = new Animator<{ name: string }>(sheets);
		const node = target();
		it.observe(node, declare({ animation: 'slide 100ms linear', position: 'relative' }), 0);
		it.touchMedia(0);
		it.touchMedia(0);

		sheets.media = { ...sheets.media, reducedMotion: 'no-preference' };
		it.touchMedia(0);
		expect(it.active).toBe(true);
		expect(present(it, node, 'left', 50)).toEqual(cells(5));
	});

	it('should start a finite animation that held nothing, once it is allowed again', () => {
		// a finite animation with the default fill of `none` is settled under reduced
		// motion and leaves *nothing* behind -- and `settled` is what says an
		// animation has finished and must not restart, so recording an empty one
		// would stop this ever running. The fill mode is read in one place and an
		// empty fill is no fill
		const sheets = cascade(sheet, { reducedMotion: 'reduce' });
		const it = new Animator<{ name: string }>(sheets);
		const node = target();
		it.observe(node, declare({ animation: 'slide 100ms linear', position: 'relative' }), 0);
		it.tick(0);
		expect(it.active).toBe(false);
		expect(it.size).toBe(0);

		sheets.media = { ...sheets.media, reducedMotion: 'no-preference' };
		it.touchMedia(0);
		expect(it.active).toBe(true);
		expect(present(it, node, 'left', 50)).toEqual(cells(5));
	});

	it('should hold neither the entry nor a timer for an infinite animation', () => {
		// the defect this is named for: `active` stayed true for the life of the
		// process and the frame loop woke every two seconds to present nothing --
		// reachable by the plainest route there is, since a non-TTY resolves to
		// `reduce`
		const it = animator(sheet, { reducedMotion: 'reduce' });
		const node = target();
		it.observe(
			node,
			declare({ animation: 'slide 100ms linear 0s infinite', position: 'relative' }),
			0
		);
		it.tick(0);
		expect(it.active).toBe(false);
		expect(it.nextChange(0, 1000 / 30)).toBeUndefined();

		it.tick(1_000_000);
		expect(it.active).toBe(false);
	});

	it('should hold no timer for a finite one either, however long its duration', () => {
		// the same root, one step less obvious: the end state was presented on the
		// first frame while the animation stayed `active` until the wall clock
		// passed its declared duration
		const it = animator(sheet, { reducedMotion: 'reduce' });
		const node = target();
		it.observe(
			node,
			declare({
				animation: 'slide 10000ms linear 0s 1 normal forwards',
				position: 'relative',
			}),
			0
		);
		expect(present(it, node, 'left', 0)).toEqual(cells(10));
		expect(it.active).toBe(false);
		expect(it.nextChange(0, 1000 / 30)).toBeUndefined();
	});
});
