import { createCanvas } from '../../src/canvas/index.js';
import { box, type Element, text } from '../../src/element/index.js';
import { createEffect, render, Show } from '../../src/renderer/index.js';
import { createEffects } from '../../src/signals/index.js';
import { State } from '../../src/signals/index.js';
import { Cascade, DEFAULT_MEDIA, parseStylesheet } from '../../src/style/index.js';
import type { Terminal } from '../../src/terminal/index.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Animation, end to end through the frame loop.
 *
 * The clock is the test's, which is what `RenderOptions.now` is for -- an
 * animation test that waits for wall time is flaky forever. The frame *pacing* is
 * a real `setTimeout` under vitest's fake timers, because what the frame skip
 * claims is about timers rather than about styles: it does not wake up.
 */

/** A backend over a canvas, with a terminal that claims to be one. */
function harness(width = 24, height = 3) {
	const canvas = createCanvas({ height, width });
	let painted = 0;

	const resizeListeners = new Set<(size: { height: number; width: number }) => void>();
	const terminal = {
		closed: false,
		height: 24,
		isTTY: true,
		onResize(fn: (size: { height: number; width: number }) => void) {
			resizeListeners.add(fn);
			return () => resizeListeners.delete(fn);
		},
		restore() {},
		width,
	} as unknown as Terminal;

	const backend = {
		active: true,
		canvas,
		done() {},
		get height() {
			return canvas.height;
		},
		isLive: true,
		present() {},
		render(draw: (painter: never) => void) {
			painted++;
			canvas.paint(draw as never);
		},
		resize(w: number, h: number) {
			canvas.resize(w, h);
		},
		stop() {},
		terminal,
		get width() {
			return canvas.width;
		},
		write() {},
	};

	return {
		backend: backend as never,
		get painted() {
			return painted;
		},
		/** Fires what a terminal fires when it is resized, which republishes the media. */
		notifyResize() {
			for (const fn of resizeListeners) {
				fn({ height: terminal.height, width: terminal.width });
			}
		},
		/** What is on the canvas, with blanks as dots so a width is countable. */
		picture() {
			return canvas
				.toString()
				.split('\n')
				.map((row) => row.padEnd(canvas.width, ' ').replaceAll(' ', '.'))
				.join('\n');
		},
		terminal,
	};
}

/**
 * Counts the timers the frame loop set, and whether each was unref'd.
 *
 * The frame skip is a claim about *waking up* rather than about painting: a loop
 * that woke every frame and found nothing changed would paint exactly as often as
 * one that slept through those frames, so counting paints says nothing about it.
 */
function watchTimers() {
	const unreffed: boolean[] = [];
	const real = globalThis.setTimeout;
	const spy = vi.spyOn(globalThis, 'setTimeout').mockImplementation(((
		...args: Parameters<typeof real>
	) => {
		const handle = real(...args) as ReturnType<typeof real> & { unref?: () => unknown };
		const index = unreffed.push(false) - 1;
		const own = handle.unref;
		if (own) {
			handle.unref = () => {
				unreffed[index] = true;
				return own.call(handle) as never;
			};
		}
		return handle;
	}) as never);

	return {
		get all() {
			return unreffed;
		},
		restore() {
			spy.mockRestore();
		},
		get wakes() {
			return unreffed.length;
		},
	};
}

let effects = createEffects();
beforeEach(() => {
	effects = createEffects();
	vi.useFakeTimers();
	// from zero, and before anything renders: the first frame happens inside
	// `render()` and is what an animation's clock starts at, so a test that moved
	// the system time afterwards would be moving it *backwards* -- which reads as
	// an animation whose delay has not run out and shows nothing at all
	vi.setSystemTime(0);
});
afterEach(() => {
	vi.useRealTimers();
});

/** A cascade whose sheets animate, with motion allowed. */
function sheets(css: string): Cascade {
	return new Cascade([parseStylesheet(css)], { ...DEFAULT_MEDIA, reducedMotion: 'no-preference' });
}

describe('a transition through the frame loop', () => {
	it('should walk the width a cell at a time rather than snapping', () => {
		const h = harness();
		const wide = new State(false);
		const cascade = sheets(`
			box { width: 4; height: 1; background-color: #ff0000; transition: width 300ms linear }
			box.wide { width: 10 }
		`);

		let node: Element;
		const view = render(
			() => {
				node = box({});
				// the class is what the cascade matches on, so this is an ordinary
				// style change with nothing animation-shaped about it
				void wide;
				return node;
			},
			{
				backend: h.backend,
				cascade,
				effects,
				reducedMotion: 'no-preference',
				terminal: h.terminal,
			}
		);

		expect(node!.style.width).toEqual({ type: 'cells', value: 4 });

		node!.addClass('wide');
		const widths: number[] = [];
		for (let at = 0; at <= 300; at += 30) {
			vi.setSystemTime(at);
			view.frame();
			widths.push((node!.style.width as { value: number }).value);
		}

		// every cell between the two, in order, and nothing outside them
		expect(widths[0]).toBe(4);
		expect(widths.at(-1)).toBe(10);
		expect(widths).toEqual([...widths].sort((a, b) => a - b));
		expect(new Set(widths).size).toBeGreaterThan(4);
		expect(Math.max(...widths)).toBe(10);
		view.dispose();
	});

	it('should lay the frame out again, because a geometry property moved a box', () => {
		// the one refinement the recorded architecture needed. "Writes through to
		// paint rather than marking style dirty" is about the *cascade*, which is
		// not re-run here -- but an animated geometry property is in
		// `LAYOUT_PROPERTIES`, so the boxes really do have to be placed again.
		// Asserted on the picture rather than on the style: paint draws a child at
		// the box the arrange pass gave it, so a frame that repainted without
		// laying out would draw the letter exactly where it already was
		const h = harness(12, 2);
		const cascade = sheets(`
			box { padding-left: 0; height: 1; transition: padding-left 300ms linear }
			box.in { padding-left: 6 }
		`);

		let node: Element;
		const view = render(() => (node = box({}, text('x'))), {
			backend: h.backend,
			cascade,
			effects,
			reducedMotion: 'no-preference',
			terminal: h.terminal,
		});

		expect(h.picture().split('\n')[0]).toBe('x...........');

		node!.addClass('in');
		const columns = new Set<number>();
		for (let at = 0; at <= 300; at += 30) {
			vi.setSystemTime(at);
			view.frame();
			columns.add(h.picture().split('\n')[0].indexOf('x'));
		}

		expect([...columns].sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5, 6]);
		view.dispose();
	});

	it('should say whether anything is in flight', () => {
		const h = harness();
		const cascade = sheets(`
			box { width: 4; transition: width 300ms linear }
			box.wide { width: 10 }
		`);

		let node: Element;
		const view = render(() => (node = box({})), {
			backend: h.backend,
			cascade,
			effects,
			reducedMotion: 'no-preference',
			terminal: h.terminal,
		});

		expect(view.animating).toBe(false);
		node!.addClass('wide');
		vi.setSystemTime(0);
		view.frame();
		expect(view.animating).toBe(true);

		vi.setSystemTime(400);
		view.frame();
		expect(view.animating).toBe(false);
		view.dispose();
	});

	it('should keep the text measurement cache across a frame that changed nothing', () => {
		// the whole reason the presented style is the same object where nothing
		// quantized differently: the cache is keyed on that object
		const h = harness();
		const cascade = sheets(`
			text { width: 4; transition: width 1000ms linear }
			text.wide { width: 6 }
		`);

		let node: Element;
		const view = render(() => (node = text('ab cd ef')), {
			backend: h.backend,
			cascade,
			effects,
			reducedMotion: 'no-preference',
			terminal: h.terminal,
		});

		node!.addClass('wide');
		vi.setSystemTime(0);
		view.frame();
		const first = node!.style;
		vi.setSystemTime(20);
		view.frame();
		expect(node!.style).toBe(first);
		view.dispose();
	});
});

describe('the frame skip', () => {
	it('should not wake for a frame that would draw what is already on screen', () => {
		// the measurement the ticket asked for: a 1000ms transition over ten cells
		// has eleven states, and a loop at thirty frames a second would wake thirty
		// times to draw them
		const h = harness(40, 3);
		const cascade = sheets(`
			box { width: 2; height: 1; background-color: #00ff00; transition: width 1000ms linear }
			box.wide { width: 12 }
		`);

		let node: Element;
		const view = render(() => (node = box({})), {
			backend: h.backend,
			cascade,
			effects,
			frameMs: 1000 / 30,
			reducedMotion: 'no-preference',
			terminal: h.terminal,
		});

		const before = h.painted;
		vi.setSystemTime(0);
		node!.addClass('wide');
		view.frame();

		// and then the loop drives itself, because `settle()` asks for the next
		// frame when something is still animating
		vi.advanceTimersByTime(1200);

		const frames = h.painted - before;
		expect((node!.style.width as { value: number }).value).toBe(12);
		// eleven cells plus the frame that puts the base back, against the thirty a
		// naive loop would have painted
		expect(frames).toBeLessThanOrEqual(14);
		expect(frames).toBeGreaterThanOrEqual(10);
		expect(view.animating).toBe(false);
		view.dispose();
	});

	it('should set no timer at all once nothing is animating', () => {
		// "nothing dirty means no frame, and no frame means no timer" survives this
		const h = harness();
		const cascade = sheets(`
			box { width: 2; transition: width 100ms linear }
			box.wide { width: 4 }
		`);

		let node: Element;
		const view = render(() => (node = box({})), {
			backend: h.backend,
			cascade,
			effects,
			reducedMotion: 'no-preference',
			terminal: h.terminal,
		});

		expect(vi.getTimerCount()).toBe(0);

		vi.setSystemTime(0);
		node!.addClass('wide');
		view.frame();
		expect(vi.getTimerCount()).toBe(1);

		vi.advanceTimersByTime(500);
		expect(vi.getTimerCount()).toBe(0);
		view.dispose();
	});

	it('should unref its timer, so a finished process is not kept alive by a frame', () => {
		const timers = watchTimers();
		try {
			const h = harness();
			const cascade = sheets(`
				box { width: 2; transition: width 100ms linear }
				box.wide { width: 4 }
			`);

			let node: Element;
			const view = render(() => (node = box({})), {
				backend: h.backend,
				cascade,
				effects,
				reducedMotion: 'no-preference',
				terminal: h.terminal,
			});

			node!.addClass('wide');
			view.frame();

			expect(timers.wakes).toBeGreaterThan(0);
			expect(timers.all.every(Boolean)).toBe(true);
			view.dispose();
		} finally {
			timers.restore();
		}
	});

	it('should wake far fewer times than a loop that paced itself would', () => {
		// the frame skip is about *waking*, which is why this counts timers rather
		// than paints: a loop that woke thirty times a second and found nothing
		// quantized differently would paint exactly as often as this one does
		const timers = watchTimers();
		try {
			const h = harness(40, 3);
			const cascade = sheets(`
				box { width: 2; height: 1; background-color: #00ff00; transition: width 1000ms linear }
				box.wide { width: 12 }
			`);

			let node: Element;
			const view = render(() => (node = box({})), {
				backend: h.backend,
				cascade,
				effects,
				frameMs: 1000 / 30,
				reducedMotion: 'no-preference',
				terminal: h.terminal,
			});

			const before = timers.wakes;
			node!.addClass('wide');
			view.frame();
			vi.advanceTimersByTime(1200);

			const wakes = timers.wakes - before;
			// eleven cells to visit, plus the wake that retires the transition --
			// against the thirty a loop pacing itself at `frameMs` would have taken
			expect(wakes).toBeLessThanOrEqual(14);
			expect((node!.style.width as { value: number }).value).toBe(12);
			view.dispose();
		} finally {
			timers.restore();
		}
	});

	it('should let a keystroke in before an animation deadline it is waiting out', () => {
		// a frame asked for sooner than one already pending replaces it, which is
		// what keeps a key from waiting out the quarter of a second a slow
		// animation's next change is away
		const h = harness(40, 3);
		const cascade = sheets(`
			box { width: 1; height: 1; transition: width 4000ms linear }
			box.wide { width: 3 }
		`);

		let label: Element;
		const text_ = new State('a');
		const view = render(
			() => {
				label = text('');
				createEffect(() => {
					label.setText(text_.get());
				});
				return box({}, label);
			},
			{
				backend: h.backend,
				cascade,
				effects,
				frameMs: 1000 / 30,
				reducedMotion: 'no-preference',
				terminal: h.terminal,
			}
		);

		view.root.addClass('wide');
		view.frame();
		expect(view.animating).toBe(true);

		// the next cell is about 1300ms away, so the pending frame is too
		const painted = h.painted;
		text_.set('b');
		vi.advanceTimersByTime(100);
		expect(h.painted).toBeGreaterThan(painted);
		expect(h.picture()).toContain('b');
		view.dispose();
	});

	it('should stop the loop for an element that left the tree mid-transition', () => {
		// what forgetting an unmounted element buys is not only the leak: a
		// transition still running on a box nobody can see keeps asking for frames,
		// so the loop spins for as long as its duration over nothing at all
		const h = harness();
		const cascade = sheets(`
			.panel { width: 2; transition: width 2000ms linear }
			.panel.wide { width: 12 }
		`);
		const on = new State(true);

		let panel: Element | undefined;
		const view = render(
			() =>
				box(
					{},
					Show({
						children: () => {
							panel = box({ class: 'panel' });
							return panel;
						},
						when: () => on.get(),
					})
				),
			{
				backend: h.backend,
				cascade,
				effects,
				reducedMotion: 'no-preference',
				terminal: h.terminal,
			}
		);

		panel!.addClass('wide');
		view.frame();
		expect(view.animating).toBe(true);

		on.set(false);
		view.frame();
		expect(panel?.tree).toBeUndefined();
		expect(view.animating).toBe(false);
		// the mutation itself asked for one more frame, which is ordinary; what
		// matters is that nothing asks for another after it
		vi.advanceTimersByTime(200);
		expect(vi.getTimerCount()).toBe(0);
		view.dispose();
	});
});

describe('an animation through the frame loop', () => {
	it('should cycle a stepped keyframe animation', () => {
		const h = harness();
		const cascade = sheets(`
			@keyframes march { from { left: 0 } to { left: 4 } }
			box { height: 1; position: relative; animation: march 400ms steps(4, end) infinite }
		`);

		let node: Element;
		const view = render(() => (node = box({ height: 1, width: 1 })), {
			backend: h.backend,
			cascade,
			effects,
			frameMs: 1000 / 30,
			reducedMotion: 'no-preference',
			terminal: h.terminal,
		});

		const seen: number[] = [];
		for (let at = 0; at < 400; at += 20) {
			vi.setSystemTime(at);
			view.frame();
			seen.push((node!.style.left as { value: number }).value ?? 0);
		}

		expect([...new Set(seen)].sort((a, b) => a - b)).toEqual([0, 1, 2, 3]);
		// and it is still going, because it is infinite
		expect(view.animating).toBe(true);
		view.dispose();
	});
});

describe('reduced motion through the frame loop', () => {
	it('should snap where the terminal is not one', () => {
		// a pipe, a file and a CI log have no frames at all, and that is the last
		// term in the chain rather than something an app has to ask for
		const h = harness();
		(h.terminal as { isTTY: boolean }).isTTY = false;
		const cascade = sheets(`
			box { width: 2; transition: width 1000ms linear }
			box.wide { width: 12 }
		`);

		let node: Element;
		const view = render(() => (node = box({})), {
			backend: h.backend,
			cascade,
			effects,
			terminal: h.terminal,
		});

		vi.setSystemTime(0);
		node!.addClass('wide');
		view.frame();
		expect((node!.style.width as { value: number }).value).toBe(12);
		expect(view.animating).toBe(false);
		expect(vi.getTimerCount()).toBe(0);
		view.dispose();
	});

	it('should hold no timer for an infinite animation, which has no end state', () => {
		// the defect the review found, at the layer where it costs something: the
		// animation stayed `active`, so `settle()` asked for another frame every
		// time and the loop woke every two seconds for the life of the process.
		// A non-TTY is the plainest route to `reduce`, and a non-TTY is a CI log --
		// which is the case the requirement was written for
		const h = harness();
		(h.terminal as { isTTY: boolean }).isTTY = false;
		const cascade = sheets(`
			@keyframes march { from { left: 0 } to { left: 4 } }
			box { height: 1; position: relative; animation: march 400ms steps(4, end) infinite }
		`);

		const view = render(() => box({ height: 1, width: 1 }), {
			backend: h.backend,
			cascade,
			effects,
			frameMs: 1000 / 30,
			terminal: h.terminal,
		});

		expect(view.animating).toBe(false);
		expect(vi.getTimerCount()).toBe(0);

		// and it stays that way: a loop that woke would wake inside this
		vi.advanceTimersByTime(10_000);
		expect(view.animating).toBe(false);
		expect(vi.getTimerCount()).toBe(0);
		view.dispose();
	});

	it('should hold no timer for a finite animation it collapsed either', () => {
		// the same root one step less obvious: the end state reached the screen on
		// the first frame while the animation stayed `active` until the wall clock
		// passed its declared duration -- ten seconds of waking up, here
		const h = harness();
		(h.terminal as { isTTY: boolean }).isTTY = false;
		const cascade = sheets(`
			@keyframes slide { from { left: 0 } to { left: 6 } }
			box {
				height: 1;
				left: 0;
				position: relative;
				animation: slide 10000ms linear 0s 1 normal forwards;
			}
		`);

		let node: Element;
		const view = render(() => (node = box({ height: 1, width: 1 })), {
			backend: h.backend,
			cascade,
			effects,
			frameMs: 1000 / 30,
			terminal: h.terminal,
		});

		// collapsed to the state it would have ended on, which is what the ticket
		// asked for rather than a frame per tick
		expect((node!.style.left as { value: number }).value).toBe(6);
		expect(view.animating).toBe(false);
		expect(vi.getTimerCount()).toBe(0);
		view.dispose();
	});

	it('should stop an animation the preference starts refusing', () => {
		// whether an animation runs is a media query's answer, so it is published
		// the way a resize is -- `publishMedia()` tells the animator as well as the
		// restyler, or a refused animation goes on asking for frames
		const h = harness();
		const cascade = sheets(`
			@keyframes march { from { left: 0 } to { left: 4 } }
			box { height: 1; position: relative; animation: march 400ms steps(4, end) infinite }
		`);

		const view = render(() => box({ height: 1, width: 1 }), {
			backend: h.backend,
			cascade,
			effects,
			frameMs: 1000 / 30,
			reducedMotion: 'no-preference',
			terminal: h.terminal,
		});

		expect(view.animating).toBe(true);

		// the environment is the live source under an app that named nothing, so a
		// resize re-reads it -- which is the one way this moves under a real app
		const before = process.env.SIGIL_REDUCED_MOTION;
		try {
			process.env.SIGIL_REDUCED_MOTION = '1';
			const motionless = render(() => box({ height: 1, width: 1 }), {
				backend: h.backend,
				cascade,
				effects: createEffects(),
				frameMs: 1000 / 30,
				terminal: h.terminal,
			});
			expect(motionless.animating).toBe(false);
			motionless.dispose();
		} finally {
			if (before === undefined) {
				delete process.env.SIGIL_REDUCED_MOTION;
			} else {
				process.env.SIGIL_REDUCED_MOTION = before;
			}
		}

		view.dispose();
	});

	it('should stop a running animation when the terminal stops being one', () => {
		// the published half of it, and the one route by which this really moves
		// under a running app: the terminal's own stream going away. `publishMedia()`
		// tells the animator as well as the restyler, or the refused animation goes
		// on asking for a frame every two seconds for the life of the process
		const h = harness();
		const cascade = sheets(`
			@keyframes march { from { left: 0 } to { left: 4 } }
			box { height: 1; position: relative; animation: march 400ms steps(4, end) infinite }
		`);

		const view = render(() => box({ height: 1, width: 1 }), {
			backend: h.backend,
			cascade,
			effects,
			frameMs: 1000 / 30,
			terminal: h.terminal,
		});

		expect(view.animating).toBe(true);

		(h.terminal as { isTTY: boolean }).isTTY = false;
		h.notifyResize();
		view.frame();

		expect(view.animating).toBe(false);
		vi.advanceTimersByTime(10_000);
		expect(view.animating).toBe(false);
		expect(vi.getTimerCount()).toBe(0);
		view.dispose();
	});

	it('should let an app say so over a terminal that is one', () => {
		const h = harness();
		const cascade = sheets(`
			box { width: 2; transition: width 1000ms linear }
			box.wide { width: 12 }
		`);

		let node: Element;
		const view = render(() => (node = box({})), {
			backend: h.backend,
			cascade,
			effects,
			reducedMotion: 'reduce',
			terminal: h.terminal,
		});

		vi.setSystemTime(0);
		node!.addClass('wide');
		view.frame();
		expect((node!.style.width as { value: number }).value).toBe(12);
		expect(view.animating).toBe(false);
		view.dispose();
	});
});
