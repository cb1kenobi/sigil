import { palette, rgb } from '../../src/canvas/style.js';
import {
	Animator,
	Cascade,
	cells,
	declare,
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
			it.observe(node, declare({ animation: value, position: 'relative' }), 0);
			expect(it.active, value).toBe(false);
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
		// the two halves of the collapse are separate guards and the fill half
		// covers most of it, so this is the one input that reaches the other: an
		// infinite animation has no final iteration for `forwards` to hold
		const it = animator(sheet, { reducedMotion: 'reduce' });
		const node = target();
		it.observe(
			node,
			declare({
				animation: 'slide 100ms linear 0s infinite normal forwards',
				position: 'relative',
			}),
			0
		);
		expect(present(it, node, 'left', 0)).toBeUndefined();
		expect(present(it, node, 'left', 500)).toBeUndefined();
	});

	it('should read the preference off the live cascade, not off a copy', () => {
		// one source, so a resize or a theme change that moves the media context
		// moves this with it
		const sheets = cascade(sheet, { reducedMotion: 'no-preference' });
		const it = new Animator<{ name: string }>(sheets);
		const node = target();
		it.observe(node, declare({ animation: 'slide 100ms linear', position: 'relative' }), 0);
		expect(it.tick(50).styles.size).toBe(1);

		sheets.media = { ...sheets.media, reducedMotion: 'reduce' };
		expect(it.tick(50).styles.size).toBe(0);
	});
});
