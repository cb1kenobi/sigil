import { createCanvas } from '../../src/canvas/index.js';
import {
	captureConsole,
	createLogRing,
	type DebugOverlayOptions,
	enableDebugOverlay,
	type LogLevel,
} from '../../src/components/debug-overlay.js';
import { box, type Element, text } from '../../src/element/index.js';
import { createEffect, render, type Renderer } from '../../src/renderer/index.js';
import { createEffects, type Effects, State } from '../../src/signals/index.js';
import { Cascade, parseStylesheet } from '../../src/style/index.js';
import type { Terminal } from '../../src/terminal/index.js';
import { frameworkSheet } from '../../src/theme/index.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The debug overlay: the ring, the console capture, the frame stats and the pane.
 *
 * The three things worth testing here are the three loops the feature is written
 * around, and each is a count rather than a picture: whether a console write set
 * a timer, whether the pane picked a line up on a frame nothing else asked for,
 * and whether the number the pane reports includes the pane. A picture cannot see
 * any of them.
 */

/** A backend over a canvas, with no terminal. */
function harness(width = 40, height = 10) {
	const canvas = createCanvas({ height, width });
	let painted = 0;

	const terminal = {
		height,
		onResize() {
			return () => {};
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
		present() {
			canvas.present();
		},
		// a real backend paints *and presents*, and the difference is the whole of
		// what `cells` and `bytes` are: `present()` is what runs the diff, so a
		// harness that only painted would report every frame as costing nothing
		render(draw: (painter: never) => void) {
			painted++;
			canvas.paint(draw as never);
			canvas.present();
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
		canvas,
		get painted() {
			return painted;
		},
		lines() {
			return canvas.toString().split('\n');
		},
		terminal,
	};
}

/**
 * Counts the timers the frame loop set.
 *
 * The first loop hazard is a claim about *waking up*: a `console.log` that asked
 * for a frame paints nothing different, so counting paints or comparing pictures
 * cannot see it. The same spy that `animation.test.ts` uses, for the same reason.
 */
function watchTimers() {
	const real = globalThis.setTimeout;
	let wakes = 0;
	const spy = vi.spyOn(globalThis, 'setTimeout').mockImplementation(((
		...args: Parameters<typeof real>
	) => {
		wakes++;
		return real(...args);
	}) as never);

	return {
		restore() {
			spy.mockRestore();
		},
		get wakes() {
			return wakes;
		},
		zero() {
			wakes = 0;
		},
	};
}

/** Every element under one, including it. */
function countElements(at: Element): number {
	let found = 1;
	for (const child of at.children) {
		found += countElements(child);
	}
	return found;
}

let effects: Effects;
beforeEach(() => {
	effects = createEffects();
	vi.useFakeTimers();
	vi.setSystemTime(0);
});
afterEach(() => {
	vi.useRealTimers();
});

describe('createLogRing()', () => {
	it('should hold what was pushed, oldest first', () => {
		const ring = createLogRing({ capacity: 4, now: () => 7 });
		ring.push('log', 'a');
		ring.push('warn', 'b');

		expect(ring.size).to.equal(2);
		expect(ring.capacity).to.equal(4);
		expect(ring.dropped).to.equal(0);
		expect(ring.entries().map((e) => e.text)).to.deep.equal(['a', 'b']);
		expect(ring.entries().map((e) => e.level)).to.deep.equal(['log', 'warn']);
		expect(ring.entries().map((e) => e.at)).to.deep.equal([7, 7]);
		expect(ring.entries().map((e) => e.seq)).to.deep.equal([0, 1]);
	});

	/**
	 * The wraparound, read through both of the ways anything asks about it.
	 *
	 * `entries()` and `at()` walk the same modular arithmetic, so a ring whose head
	 * moved and whose `at()` did not would look perfectly correct through one of
	 * them -- which is the pane's reader, since `sync()` only ever calls `at()`.
	 */
	it('should drop the oldest line once it is full, through both readers', () => {
		const ring = createLogRing({ capacity: 3 });
		for (const line of ['a', 'b', 'c', 'd', 'e']) {
			ring.push('log', line);
		}

		expect(ring.size).to.equal(3);
		expect(ring.dropped).to.equal(2);
		expect(ring.entries().map((e) => e.text)).to.deep.equal(['c', 'd', 'e']);
		expect([0, 1, 2].map((i) => ring.at(i)?.text)).to.deep.equal(['c', 'd', 'e']);
		// the sequence numbers survive the wrap, which is what the pane compares
		expect([0, 1, 2].map((i) => ring.at(i)?.seq)).to.deep.equal([2, 3, 4]);
	});

	it('should hold exactly its capacity over many wraps', () => {
		const ring = createLogRing({ capacity: 5 });
		for (let i = 0; i < 53; i++) {
			ring.push('log', `${i}`);
		}

		expect(ring.size).to.equal(5);
		expect(ring.dropped).to.equal(48);
		expect(ring.entries().map((e) => e.text)).to.deep.equal(['48', '49', '50', '51', '52']);
	});

	it('should answer nothing for a position it does not hold', () => {
		const ring = createLogRing({ capacity: 2 });
		ring.push('log', 'a');

		expect(ring.at(-1)).to.equal(undefined);
		expect(ring.at(1)).to.equal(undefined);
		expect(ring.at(0.5)).to.equal(undefined);
		expect(ring.at(Number.NaN)).to.equal(undefined);
	});

	/**
	 * A write becomes a line per newline, because the pane draws one row per entry
	 * at a fixed height -- so a write holding a newline would be one row with two
	 * lines in it, overflowing its slot.
	 */
	it('should split a write into a line per newline', () => {
		const ring = createLogRing();
		ring.push('log', 'one\ntwo\r\nthree');

		expect(ring.entries().map((e) => e.text)).to.deep.equal(['one', 'two', 'three']);
		expect(ring.version).to.equal(3);
	});

	it('should drop one trailing newline and keep a blank line somebody wrote', () => {
		const ring = createLogRing();
		ring.push('log', 'one\n');
		ring.push('log', 'two\n\n');

		expect(ring.entries().map((e) => e.text)).to.deep.equal(['one', 'two', '']);
	});

	it('should keep an empty write as a line', () => {
		const ring = createLogRing();
		ring.push('log', '');

		expect(ring.size).to.equal(1);
		expect(ring.at(0)?.text).to.equal('');
	});

	/**
	 * `version` counts changes rather than pushes, which is what the pane compares.
	 *
	 * A counter that meant "lines ever pushed" would not move for a `clear()`, and
	 * the pane's own fast path is `log.version === seen` -- so the rows would keep
	 * showing a cleared ring for ever.
	 */
	it('should count a clear as a change', () => {
		const ring = createLogRing();
		ring.push('log', 'a');
		const before = ring.version;
		ring.clear();

		expect(ring.size).to.equal(0);
		expect(ring.entries()).to.deep.equal([]);
		expect(ring.version).to.be.greaterThan(before);
	});

	it('should keep the sequence running across a clear', () => {
		const ring = createLogRing();
		ring.push('log', 'a');
		ring.clear();
		ring.push('log', 'b');

		expect(ring.at(0)?.seq).to.equal(1);
	});

	/**
	 * A capacity that is not a count falls back, and `NaN` is the one that matters.
	 *
	 * `Math.max(1, NaN)` is `NaN`: a ring of `NaN` slots holds `size < NaN`, which
	 * is false, so the first push wraps into slot `NaN % NaN` and every line after
	 * it is dropped while `size` stays at zero -- a log that silently captures
	 * nothing, which is the one failure mode nobody would look for here.
	 */
	it('should hold at least one line whatever it was asked for', () => {
		for (const capacity of [0, -4, 0.5]) {
			const ring = createLogRing({ capacity });
			ring.push('log', 'a');
			ring.push('log', 'b');
			expect(ring.capacity, `${capacity}`).to.equal(1);
			expect(ring.entries().map((e) => e.text)).to.deep.equal(['b']);
		}

		for (const capacity of [Number.NaN, Number.POSITIVE_INFINITY]) {
			const ring = createLogRing({ capacity });
			ring.push('log', 'a');
			ring.push('log', 'b');
			expect(Number.isFinite(ring.capacity), `${capacity}`).to.equal(true);
			expect(ring.size).to.equal(2);
			expect(ring.entries().map((e) => e.text)).to.deep.equal(['a', 'b']);
		}
	});
});

describe('captureConsole()', () => {
	/** A console of its own, so the suite's own reporter keeps its. */
	function fakeConsole() {
		const seen: string[] = [];
		const target: Partial<Record<LogLevel, (...args: unknown[]) => void>> = {};
		for (const level of ['debug', 'error', 'info', 'log', 'warn'] as LogLevel[]) {
			target[level] = (...args: unknown[]) => {
				seen.push(`${level}:${String(args[0])}`);
			};
		}
		return { seen, target };
	}

	it('should push what the console was asked to print', () => {
		const { target } = fakeConsole();
		const ring = createLogRing();
		const capture = captureConsole(ring, { console: target });

		try {
			target.log?.('hello');
			target.warn?.('careful');
			target.error?.('broken');
			target.info?.('note');
			target.debug?.('quiet');
		} finally {
			capture.restore();
		}

		expect(ring.entries().map((e) => `${e.level}:${e.text}`)).to.deep.equal([
			'log:hello',
			'warn:careful',
			'error:broken',
			'info:note',
			'debug:quiet',
		]);
	});

	/**
	 * Node's own formatter, which is the one thing the capture must not change
	 * about what a message *says*. A hand-rolled one would read `%s items` as
	 * literal text and put the argument after it.
	 */
	it('should format the way the console would have', () => {
		const { target } = fakeConsole();
		const ring = createLogRing();
		const capture = captureConsole(ring, { console: target });

		try {
			target.log?.('%s items at %d', 'three', 7);
			target.log?.('a', 1, true);
		} finally {
			capture.restore();
		}

		expect(ring.at(0)?.text).to.equal('three items at 7');
		expect(ring.at(1)?.text).to.equal('a 1 true');
	});

	it('should not forward to the console it replaced', () => {
		const { seen, target } = fakeConsole();
		const ring = createLogRing();
		const capture = captureConsole(ring, { console: target });

		try {
			target.log?.('hello');
		} finally {
			capture.restore();
		}

		expect(seen).to.deep.equal([]);
		expect(ring.size).to.equal(1);
	});

	it('should put back exactly what it replaced', () => {
		const { seen, target } = fakeConsole();
		const before = { ...target };
		const capture = captureConsole(createLogRing(), { console: target });

		expect(capture.installed).to.equal(true);
		expect(target.log).to.not.equal(before.log);
		expect(capture.restore()).to.equal(true);

		for (const level of ['debug', 'error', 'info', 'log', 'warn'] as LogLevel[]) {
			expect(target[level]).to.equal(before[level]);
		}
		target.log?.('through');
		expect(seen).to.deep.equal(['log:through']);
	});

	/**
	 * The rule `hideCursor()`, `setRawMode()` and `enableBracketedPaste()` keep:
	 * say whether **this** call was the one that changed anything.
	 *
	 * A second capture that reported `true` and then restored would put the first
	 * one's patch back as though it were the original, and every line after that
	 * would go to the first ring and to nothing else -- with the second's
	 * `restore()` having reported success.
	 */
	it('should report that a second capture installed nothing, and restore nothing', () => {
		const { target } = fakeConsole();
		const first = createLogRing();
		const second = createLogRing();
		const outer = captureConsole(first, { console: target });

		try {
			const inner = captureConsole(second, { console: target });
			expect(outer.installed).to.equal(true);
			expect(inner.installed).to.equal(false);
			expect(inner.restore()).to.equal(false);

			// the outer capture is still the one in effect, which is the half a
			// `restore()` that merely returned `false` would not have proved
			target.log?.('after');
			expect(first.size).to.equal(1);
			expect(second.size).to.equal(0);
		} finally {
			outer.restore();
		}
	});

	it('should restore once, and say so once', () => {
		const { target } = fakeConsole();
		const capture = captureConsole(createLogRing(), { console: target });

		expect(capture.restore()).to.equal(true);
		expect(capture.restore()).to.equal(false);
	});

	it('should let a capture install again after the last one was put back', () => {
		const { target } = fakeConsole();
		const ring = createLogRing();
		captureConsole(createLogRing(), { console: target }).restore();
		const again = captureConsole(ring, { console: target });

		try {
			expect(again.installed).to.equal(true);
			target.log?.('x');
			expect(ring.size).to.equal(1);
		} finally {
			again.restore();
		}
	});

	/**
	 * Put back what *you* attached, taken literally.
	 *
	 * Somebody else's patch over ours is holding ours as its original, so removing
	 * theirs would break their restore -- and assigning our original over it would
	 * take their patch off without their asking.
	 */
	it('should leave a patch somebody else installed over it alone', () => {
		const { target } = fakeConsole();
		const capture = captureConsole(createLogRing(), { console: target });
		const theirs = () => {};
		target.log = theirs;

		// `false`, because it did not put the console back: two parties patching one
		// global without coordinating cannot both be put back, and saying so is what
		// this can do about it
		expect(capture.restore()).to.equal(false);
		expect(target.log).to.equal(theirs);
		// and the methods it is still holding were put back
		expect(typeof target.warn).to.equal('function');
		target.warn?.('x');

		// and the latch is freed anyway, because holding it would let one foreign
		// patch refuse every later capture for the life of the process
		const again = captureConsole(createLogRing(), { console: target });
		try {
			expect(again.installed).to.equal(true);
		} finally {
			again.restore();
		}
	});

	/**
	 * A method it could not put back stays retryable, which the sabotage pass is
	 * what found: a single `restored` latch made this sequence unreachable, and
	 * removing the latch was *better* for it -- which is not something a fast path
	 * can be.
	 */
	it('should put a method back once the patch over it has gone', () => {
		const { seen, target } = fakeConsole();
		const real = target.log;
		const capture = captureConsole(createLogRing(), { console: target });
		const ours = target.log;
		// somebody patches over ours, holding ours as their original
		const theirs = (...args: unknown[]) => ours?.(...args);
		target.log = theirs;

		// four back, `log` left alone, and said so
		expect(capture.restore()).to.equal(false);
		expect(target.log).to.equal(theirs);

		// they restore, which puts *our* patch back -- the orphan
		target.log = ours;
		// and a retry is what closes it
		expect(capture.restore()).to.equal(true);
		expect(target.log).to.equal(real);
		expect(capture.restore()).to.equal(false);

		target.log?.('through');
		expect(seen).to.deep.equal(['log:through']);
	});

	/**
	 * ...and a retry leaves a capture installed in between alone, which is the
	 * same rule it already keeps for a foreign patch.
	 */
	it('should leave a later capture alone when it retries', () => {
		const { target } = fakeConsole();
		const first = captureConsole(createLogRing(), { console: target });
		const ours = target.log;
		target.log = () => {};
		expect(first.restore()).to.equal(false);

		const ring = createLogRing();
		const second = captureConsole(ring, { console: target });
		try {
			expect(second.installed).to.equal(true);
			// the first one's own patch is gone from `log`, so its retry finds nothing
			// of its own there and writes nothing
			expect(first.restore()).to.equal(false);
			target.log?.('x');
			expect(ring.size).to.equal(1);
			expect(ours).to.not.equal(target.log);
		} finally {
			second.restore();
		}
	});

	/**
	 * A throw mid-install unwinds, because half a patched console with nothing
	 * holding the originals is worse than none of one.
	 */
	it('should unwind a half-finished install', () => {
		const { seen, target } = fakeConsole();
		const before = { ...target };
		// the methods are replaced in a fixed order, so refusing the last of them
		// leaves the four before it patched
		Object.defineProperty(target, 'warn', {
			configurable: true,
			get: () => before.warn,
			set: () => {
				throw new Error('refused');
			},
		});

		expect(() => captureConsole(createLogRing(), { console: target })).to.throw('refused');

		for (const level of ['debug', 'error', 'info', 'log'] as LogLevel[]) {
			expect(target[level]).to.equal(before[level]);
		}
		// and the latch is free, so a later capture installs -- over a console that
		// will take one, since the point is the latch rather than the setter
		Object.defineProperty(target, 'warn', {
			configurable: true,
			value: before.warn,
			writable: true,
		});
		const capture = captureConsole(createLogRing(), { console: target });
		try {
			expect(capture.installed).to.equal(true);
		} finally {
			capture.restore();
		}
		target.log?.('through');
		expect(seen).to.deep.equal(['log:through']);
	});
});

describe('Renderer frame stats', () => {
	function tree(): Element {
		return box({}, text('one'), text('two'));
	}

	it('should record nothing without being asked', () => {
		const h = harness();
		const view = render(tree, { backend: h.backend, effects, terminal: h.terminal });

		try {
			expect(view.stats).to.equal(undefined);
			view.frame();
			expect(view.stats).to.equal(undefined);
		} finally {
			view.dispose();
		}
	});

	it('should record what a frame did', () => {
		const h = harness();
		const view = render(tree, {
			backend: h.backend,
			effects,
			gatherStats: true,
			terminal: h.terminal,
		});

		try {
			const first = view.stats;
			expect(first?.frame).to.equal(1);
			expect(first?.laidOut).to.equal(true);
			expect(first?.painted).to.equal(true);
			expect(first?.elements).to.equal(3);
			expect(first?.cells).to.be.greaterThan(0);
			expect(first?.bytes).to.be.greaterThan(0);
			expect(first?.styles).to.be.greaterThan(0);
			expect(first?.resolved).to.be.greaterThan(0);

			view.frame();
			// a frame with nothing to do is still a frame, and it painted nothing
			expect(view.stats?.frame).to.equal(2);
			expect(view.stats?.painted).to.equal(false);
			expect(view.stats?.cells).to.equal(0);
		} finally {
			view.dispose();
		}
	});

	/**
	 * The duration leaves the frame handlers out, because the overlay is one.
	 *
	 * A handler that spends two milliseconds rebuilding its rows would otherwise
	 * make every frame read two milliseconds slower -- the instrument measuring
	 * itself, in the one direction somebody turns the pane on to look at. Driven by
	 * the injected clock, which is the only way to say how long anything took
	 * without timing it.
	 */
	it('should leave the frame handlers out of what a frame took', () => {
		const h = harness();
		let now = 0;
		const view = render(tree, {
			backend: h.backend,
			effects,
			gatherStats: true,
			now: () => now,
			terminal: h.terminal,
		});

		try {
			view.onFrame(() => {
				// an observer that costs ten milliseconds
				now += 10;
			});
			view.frame();
			expect(view.stats?.duration).to.be.lessThan(10);
		} finally {
			view.dispose();
		}
	});

	/**
	 * The exclusion, over a subtree big enough that including it would be obvious.
	 *
	 * A fixture whose excluded subtree is one element, or is empty, cannot tell an
	 * exclusion that works from one that was deleted -- so the pane here is two
	 * hundred rows against an app of three elements, and both numbers are asserted:
	 * what the app is, and what the whole tree would have been.
	 */
	it('should leave an excluded subtree out of what it reports', () => {
		const h = harness();
		const pane = box({}, ...Array.from({ length: 200 }, (_, i) => text(`row ${i}`)));
		const view = render(() => box({}, text('one'), text('two'), pane), {
			backend: h.backend,
			effects,
			gatherStats: true,
			terminal: h.terminal,
		});

		try {
			const whole = countElements(view.root);
			expect(whole).to.equal(204);

			const unexclude = view.excludeFromStats(pane);
			view.frame();
			expect(view.stats?.elements).to.equal(3);

			// and it goes back in, which is what makes the number above a measurement
			// rather than a constant
			unexclude();
			view.frame();
			expect(view.stats?.elements).to.equal(whole);
		} finally {
			view.dispose();
		}
	});

	it('should leave an excluded subtree out of what it says moved', () => {
		const h = harness();
		const flag = new State(false);
		const rows = Array.from({ length: 50 }, (_, i) => text(`row ${i}`, { class: 'pane-row' }));
		const pane = box({ class: 'pane' }, ...rows);
		const sheet = parseStylesheet('.pane-row { color: red } .on .pane-row { color: blue }');
		const view = render(
			() => {
				const host = box({}, text('one'), pane);
				// a class on the root, which is what makes every `.pane-row` re-match
				createEffect(() => {
					if (flag.get()) {
						host.addClass('on');
					} else {
						host.removeClass('on');
					}
				});
				return host;
			},
			{
				backend: h.backend,
				cascade: new Cascade([sheet]),
				// a colour at level 0 degrades to nothing, so both halves of the rule
				// resolve to the same style and the restyler reports nothing moved --
				// which made the first version of this test pass for the wrong reason
				colorLevel: 1,
				effects,
				gatherStats: true,
				terminal: h.terminal,
			}
		);

		try {
			const unexclude = view.excludeFromStats(pane);
			flag.set(true);
			view.frame();
			// every row's colour moved, and not one of them is counted
			expect(view.stats?.changed).to.equal(0);

			unexclude();
			flag.set(false);
			view.frame();
			expect(view.stats?.changed).to.be.greaterThan(40);
		} finally {
			view.dispose();
		}
	});
});

describe('Renderer.onFrame()', () => {
	it('should be handed the frame before it, because this one has done nothing', () => {
		const h = harness();
		const seen: (number | undefined)[] = [];
		let view: Renderer | undefined;

		try {
			view = render(() => text('x'), {
				backend: h.backend,
				effects,
				gatherStats: true,
				terminal: h.terminal,
			});
			view.onFrame((stats) => seen.push(stats?.frame));
			view.frame();
			view.frame();

			// the first callback saw frame 1, which is the one `render()` ran
			expect(seen).to.deep.equal([1, 2]);
		} finally {
			view?.dispose();
		}
	});

	it('should run before the effects, so what a handler writes is this frame', () => {
		const h = harness(10, 2);
		const value = new State('a');
		let label: Element | undefined;
		const view = render(
			() => {
				label = text('');
				createEffect(() => {
					label?.setText(value.get());
				});
				return label;
			},
			{ backend: h.backend, effects, terminal: h.terminal }
		);

		try {
			expect(h.lines()[0]?.trim()).to.equal('a');
			view.onFrame(() => value.set('b'));
			view.frame();
			// settled, laid out and painted by the frame that called the handler: a
			// handler that ran after the paint would be a frame late
			expect(h.lines()[0]?.trim()).to.equal('b');
		} finally {
			view.dispose();
		}
	});

	/**
	 * The copy **and** the membership check, which are two rules and not one.
	 *
	 * Without the copy a handler registered by another handler receives the very
	 * frame that registered it; without the check the copy calls one that has just
	 * unsubscribed. This repo's own router, paste and resize handlers all say it
	 * the same way, and both halves are asserted here because each alone passes
	 * one of the two.
	 */
	it('should not call a handler that joined or left during a dispatch', () => {
		const h = harness();
		const seen: string[] = [];
		const view = render(() => text('x'), { backend: h.backend, effects, terminal: h.terminal });

		try {
			const late = () => seen.push('late');
			let offEarly = () => {};
			const first = () => {
				seen.push('first');
				view.onFrame(late);
				offEarly();
			};
			view.onFrame(first);
			offEarly = view.onFrame(() => seen.push('early'));

			view.frame();
			// `late` joined during the dispatch and `early` left during it
			expect(seen).to.deep.equal(['first']);

			seen.length = 0;
			view.frame();
			expect(seen).to.deep.equal(['first', 'late']);
		} finally {
			view.dispose();
		}
	});

	it('should report a handler that threw and finish the frame', () => {
		const h = harness(10, 2);
		const errors: unknown[] = [];
		const view = render(() => text('drawn'), {
			backend: h.backend,
			effects,
			onError: (error) => errors.push(error),
			terminal: h.terminal,
		});

		try {
			view.onFrame(() => {
				throw new Error('watcher');
			});
			view.frame();

			expect(errors.map((e) => (e as Error).message)).to.deep.equal(['watcher']);
			expect(view.mounted).to.equal(true);
			expect(h.lines()[0]?.trim()).to.equal('drawn');
		} finally {
			view.dispose();
		}
	});

	/**
	 * What a disposed renderer does with the handlers it was given is not
	 * observable, so what is asserted is the half that is: an unsubscribe a caller
	 * still holds stays callable, which is why `teardown()` clears the sets rather
	 * than replacing them.
	 *
	 * The clear itself is declared where it lives. The first test for it asserted
	 * that a second renderer over the same tree saw it whole -- which it does
	 * whether or not the first cleared anything, since it has sets of its own, and
	 * the sabotage pass is what said so.
	 */
	it('should leave an unsubscribe callable after dispose', () => {
		const h = harness();
		let calls = 0;
		const pane = box({}, text('row'));
		const view = render(() => box({}, text('one'), pane), {
			backend: h.backend,
			effects,
			gatherStats: true,
			terminal: h.terminal,
		});

		const off = view.onFrame(() => {
			calls++;
		});
		const unexclude = view.excludeFromStats(pane);
		view.frame();
		expect(calls).to.equal(1);
		// the root and `text('one')`, with the pane left out
		expect(view.stats?.elements).to.equal(2);

		view.dispose();
		expect(() => {
			off();
			unexclude();
		}).to.not.throw();
	});

	it('should stop calling a handler that unsubscribed', () => {
		const h = harness();
		let calls = 0;
		const view = render(() => text('x'), { backend: h.backend, effects, terminal: h.terminal });

		try {
			const off = view.onFrame(() => {
				calls++;
			});
			view.frame();
			off();
			view.frame();
			expect(calls).to.equal(1);
		} finally {
			view.dispose();
		}
	});
});

describe('enableDebugOverlay()', () => {
	/** A renderer with an overlay over it, and the pieces to drive both. */
	function mount(opts: DebugOverlayOptions & { height?: number } = {}) {
		const h = harness(40, 12);
		const log = opts.log ?? createLogRing({ capacity: 500 });
		const view = render(() => box({ class: 'app' }, text('app')), {
			backend: h.backend,
			cascade: new Cascade([frameworkSheet()]),
			colorLevel: 1,
			effects,
			gatherStats: true,
			terminal: h.terminal,
		});
		const overlay = enableDebugOverlay(view, { height: 8, log, ...opts });
		return { h, log, overlay, view };
	}

	it('should take no space and not size the app it was added to', () => {
		const { h, overlay, view } = mount({ visible: true });

		try {
			// out of flow: the app's own line is still at the top of the canvas, which
			// is what `position: fixed` buys and is the whole reason the pane may be
			// appended to a root it knows nothing about
			expect(h.lines()[0]?.trim()).to.equal('app');
			expect(overlay.element.parent).to.equal(view.root);
		} finally {
			overlay.dispose();
			view.dispose();
		}
	});

	/**
	 * The first loop hazard, counted rather than pictured.
	 *
	 * A `console.log` that asked for a frame would paint nothing different, so a
	 * picture comparison cannot see it -- and the failure is not a wrong cell, it
	 * is a log line inside an effect asking for the frame that runs the effect.
	 */
	it('should set no timer for a console write', () => {
		const { log, overlay, view } = mount({ visible: true });
		const capture = captureConsole(log);
		const timers = watchTimers();

		try {
			// settled: whatever the mount asked for has run, so the loop is quiet
			vi.runAllTimers();
			view.frame();
			vi.runAllTimers();
			timers.zero();

			console.log('one');
			console.warn('two');
			expect(log.size).to.equal(2);
			expect(timers.wakes).to.equal(0);
		} finally {
			timers.restore();
			capture.restore();
			overlay.dispose();
			view.dispose();
		}
	});

	/**
	 * ...and the other half of it: the line does arrive, on a frame that was
	 * already happening.
	 *
	 * A test that only asserted the absence above would pass over a capture that
	 * pushed nothing at all.
	 */
	it('should show a line on a frame that was already happening', () => {
		const { h, log, overlay, view } = mount({ visible: true });
		const capture = captureConsole(log);

		try {
			console.log('from an effect');
			expect(h.lines().join('\n')).to.not.include('from an effect');

			// a frame nothing about the log asked for
			view.frame();
			expect(h.lines().join('\n')).to.include('from an effect');
		} finally {
			capture.restore();
			overlay.dispose();
			view.dispose();
		}
	});

	/**
	 * The third loop hazard: the pane's own writes must not be what asks for the
	 * next frame.
	 *
	 * The stats line holds the frame number and the frame's duration, so it differs
	 * on every frame -- and `setText()` marks layout and asks for a frame. Without
	 * the latch this is a thirty-a-second spin for the life of the process, in which
	 * every number shown is a measurement of the instrument.
	 */
	it('should not spin a frame loop of its own', () => {
		const { overlay, view } = mount({ visible: true });
		const timers = watchTimers();

		try {
			// drain whatever the mount left pending, then ask for one frame and let
			// the loop run itself out. A spin never runs out
			for (let i = 0; i < 20 && vi.getTimerCount() > 0; i++) {
				vi.runOnlyPendingTimers();
			}
			expect(vi.getTimerCount()).to.equal(0);

			timers.zero();
			view.invalidate();
			for (let i = 0; i < 20 && vi.getTimerCount() > 0; i++) {
				vi.runOnlyPendingTimers();
			}

			expect(vi.getTimerCount()).to.equal(0);
			// one frame asked for, one frame's write, and the frame that write asked
			// for -- which writes nothing and sets no other timer
			expect(timers.wakes).to.be.lessThan(4);
		} finally {
			timers.restore();
			overlay.dispose();
			view.dispose();
		}
	});

	/**
	 * The second thing the ticket names: the numbers the pane shows must not count
	 * the pane.
	 *
	 * The pane here holds hundreds of rows, so an exclusion that was deleted would
	 * move `elements` from the app's three to something in the hundreds -- which is
	 * the differential a fixture with a trivially small overlay could not produce.
	 */
	it('should keep its own subtree out of the stats it reports', () => {
		const log = createLogRing({ capacity: 400 });
		for (let i = 0; i < 400; i++) {
			log.push('log', `line ${i}`);
		}
		const { overlay, view } = mount({ height: 10, log, visible: true });

		try {
			// two frames: one to build the rows from the ring, one to report on a tree
			// that holds them
			view.frame();
			view.frame();

			expect(countElements(overlay.element)).to.be.greaterThan(300);
			expect(countElements(view.root)).to.be.greaterThan(300);
			expect(view.stats?.elements).to.equal(2);
		} finally {
			overlay.dispose();
			view.dispose();
		}
	});

	it('should drop the rows the ring dropped', () => {
		const log = createLogRing({ capacity: 3 });
		const { h, overlay, view } = mount({ height: 8, log, visible: true });

		try {
			for (const line of ['one', 'two', 'three', 'four', 'five']) {
				log.push('log', line);
			}
			view.frame();
			view.frame();

			const drawn = h.lines().join('\n');
			expect(drawn).to.include('three');
			expect(drawn).to.include('five');
			expect(drawn).to.not.include('one');
			expect(drawn).to.not.include('two');
		} finally {
			overlay.dispose();
			view.dispose();
		}
	});

	/**
	 * Kept rather than rebuilt, which is `For`'s reason: a row still in the ring is
	 * the same row, so its element keeps its resolved style and its measurement.
	 */
	it('should keep the rows that stayed in the ring', () => {
		const log = createLogRing({ capacity: 10 });
		const { overlay, view } = mount({ height: 8, log, visible: true });

		try {
			log.push('log', 'a');
			view.frame();
			const list = findClass(overlay.element, 'sigil-debug-list');
			const first = list?.children[0];
			expect(first).to.not.equal(undefined);

			log.push('log', 'b');
			view.frame();
			expect(list?.children[0]).to.equal(first);
			expect(list?.children.length).to.equal(2);
		} finally {
			overlay.dispose();
			view.dispose();
		}
	});

	/**
	 * The pane stays inside the box it declared, which took a declaration to make
	 * true and was wrong until a sabotage pointed at it sideways.
	 *
	 * A box's automatic minimum is content-based, so the log's is its content's --
	 * five hundred rows. Without `min-height: 0` the host cannot shrink below that:
	 * the pane came out forty rows tall inside a box drawn for six, with the rows
	 * painted straight through its own bottom border and over whatever the app had
	 * drawn under it. Asserted as the box **and** as the picture, because the box
	 * is the mechanism and the border is what somebody would have reported.
	 */
	it('should stay inside the box it declared', () => {
		const log = createLogRing({ capacity: 100 });
		for (let i = 0; i < 40; i++) {
			log.push('log', `line ${i}`);
		}
		const { h, overlay, view } = mount({ height: 6, log, visible: true });

		try {
			for (let i = 0; i < 4; i++) {
				view.frame();
			}

			expect(overlay.element.box?.height).to.equal(6);
			const host = findClass(overlay.element, 'sigil-debug-log');
			// six, less the two border rows and the head
			expect(host?.box?.height).to.equal(3);

			const lines = h.lines();
			// the pane's own bottom border, with nothing drawn through it
			expect(lines[11]?.startsWith('\u2514')).to.equal(true);
			expect(lines[11]).to.not.include('line');
		} finally {
			overlay.dispose();
			view.dispose();
		}
	});

	/**
	 * The follow, which no assertion reached until a sabotage said so.
	 *
	 * Removing the one-frame wait in front of it survived every test in this file,
	 * because not one of them asserted that the *newest* line is the one on screen
	 * -- and what the wait is for is precisely that a row the layout has not placed
	 * yet has no box to scroll to, so following it scrolls to the origin instead,
	 * which is the oldest line rather than the newest.
	 */
	it('should follow the newest line', () => {
		const log = createLogRing({ capacity: 100 });
		const { h, overlay, view } = mount({ height: 6, log, visible: true });

		try {
			for (let i = 0; i < 40; i++) {
				log.push('log', `line ${i}`);
			}
			// one frame to build the rows, one to lay them out, one to follow and one
			// to draw where the follow went
			for (let i = 0; i < 4; i++) {
				view.frame();
			}

			const drawn = h.lines().join('\n');
			expect(drawn).to.include('line 39');
			expect(drawn).to.not.include('line 0');
		} finally {
			overlay.dispose();
			view.dispose();
		}
	});

	it('should not follow where it was told not to', () => {
		const log = createLogRing({ capacity: 100 });
		const { h, overlay, view } = mount({ follow: false, height: 6, log, visible: true });

		try {
			for (let i = 0; i < 40; i++) {
				log.push('log', `line ${i}`);
			}
			for (let i = 0; i < 4; i++) {
				view.frame();
			}

			const drawn = h.lines().join('\n');
			expect(drawn).to.include('line 0');
			expect(drawn).to.not.include('line 39');
		} finally {
			overlay.dispose();
			view.dispose();
		}
	});

	/**
	 * Opening a pane that filled up while it was closed follows, which it did not.
	 *
	 * A hidden subtree is not laid out at all, so a row appended while the pane was
	 * closed has **no box** -- and `scrollIntoView()` returns without doing
	 * anything for a target with no box, which is indistinguishable from one that
	 * was already visible. A version that waited a *frame* rather than waiting for
	 * the box consumed the flag on exactly the frame it could not act, so the pane
	 * opened on the oldest lines. Reported by review.
	 */
	it('should follow after it was opened on a ring that filled while it was closed', () => {
		const log = createLogRing({ capacity: 100 });
		const { h, overlay, view } = mount({ height: 6, log });

		try {
			// frames while it is closed, which is what a full-screen app is doing
			for (let i = 0; i < 40; i++) {
				log.push('log', `line ${i}`);
			}
			for (let i = 0; i < 4; i++) {
				view.frame();
			}
			expect(h.lines().join('\n')).to.not.include('line 39');

			overlay.show();
			for (let i = 0; i < 4; i++) {
				view.frame();
			}

			const drawn = h.lines().join('\n');
			expect(drawn).to.include('line 39');
			expect(drawn).to.not.include('line 0');
		} finally {
			overlay.dispose();
			view.dispose();
		}
	});

	/**
	 * ...and with no stats line, which is the half that needs the retry's own
	 * frame: the stats write is what asks for the frame after the layout, so a pane
	 * built with `stats: false` has nothing else to ask on its behalf.
	 */
	/**
	 * ...and with no stats line, which is the half that needs the retry's own frame.
	 *
	 * The ring has to fill **while the pane is closed**, which is the one shape
	 * where the rows already exist with no boxes: fill it while open and the sync's
	 * own append is what marks the tree, so the frame after it comes for free and
	 * the retry is never reached. The first version of this test did that and
	 * survived deleting the retry, which is the fixture-too-easy shape this repo
	 * keeps rediscovering.
	 */
	it('should follow with no stats line to ask for the frame', () => {
		const log = createLogRing({ capacity: 100 });
		const { h, overlay, view } = mount({ height: 6, log, stats: false });

		try {
			for (let i = 0; i < 40; i++) {
				log.push('log', `line ${i}`);
			}
			// frames while it is closed, which is what builds the rows and gives them
			// no boxes
			for (let i = 0; i < 4; i++) {
				view.frame();
			}

			overlay.show();
			// one frame, and then only what the overlay itself asked for
			view.frame();
			for (let i = 0; i < 20 && vi.getTimerCount() > 0; i++) {
				vi.runOnlyPendingTimers();
			}

			expect(h.lines().join('\n')).to.include('line 39');
			// and it settles: the retry is one frame, not one per frame
			expect(vi.getTimerCount()).to.equal(0);
		} finally {
			overlay.dispose();
			view.dispose();
		}
	});

	it('should empty itself when the ring is cleared', () => {
		const log = createLogRing({ capacity: 10 });
		const { h, overlay, view } = mount({ height: 8, log, visible: true });

		try {
			log.push('log', 'gone');
			view.frame();
			expect(h.lines().join('\n')).to.include('gone');

			log.clear();
			view.frame();
			view.frame();
			expect(h.lines().join('\n')).to.not.include('gone');
		} finally {
			overlay.dispose();
			view.dispose();
		}
	});

	it('should draw nothing while it is hidden', () => {
		const log = createLogRing();
		log.push('log', 'secret');
		const { h, overlay, view } = mount({ log });

		try {
			view.frame();
			view.frame();
			expect(overlay.visible).to.equal(false);
			expect(h.lines().join('\n')).to.not.include('secret');

			overlay.show();
			view.frame();
			view.frame();
			expect(h.lines().join('\n')).to.include('secret');

			overlay.hide();
			view.frame();
			expect(h.lines().join('\n')).to.not.include('secret');
		} finally {
			overlay.dispose();
			view.dispose();
		}
	});

	it('should toggle', () => {
		const { overlay, view } = mount();

		try {
			expect(overlay.visible).to.equal(false);
			overlay.toggle();
			expect(overlay.visible).to.equal(true);
			overlay.toggle();
			expect(overlay.visible).to.equal(false);
		} finally {
			overlay.dispose();
			view.dispose();
		}
	});

	it('should say the stats are off where nobody asked for them', () => {
		const h = harness(40, 12);
		const view = render(() => box({}, text('app')), {
			backend: h.backend,
			effects,
			terminal: h.terminal,
		});
		const overlay = enableDebugOverlay(view, { height: 6, visible: true });

		try {
			view.frame();
			expect(h.lines().join('\n')).to.include('stats off');
		} finally {
			overlay.dispose();
			view.dispose();
		}
	});

	it('should show the frame the stats describe, and follow it', () => {
		const { h, overlay, view } = mount({ visible: true });

		/** The frame number the stats line is showing. */
		const shownFrame = () => /\bf(\d+)\b/.exec(h.lines().join('\n'))?.[1];

		try {
			view.frame();
			view.frame();
			const first = shownFrame();
			expect(first).to.not.equal(undefined);

			// a frame nothing about the pane asked for, which is the one the line has
			// to follow -- a constant would satisfy a test that only matched the shape
			view.invalidate();
			for (let i = 0; i < 20 && vi.getTimerCount() > 0; i++) {
				vi.runOnlyPendingTimers();
			}
			expect(shownFrame()).to.not.equal(first);
			expect(Number(shownFrame())).to.be.greaterThan(Number(first));
		} finally {
			overlay.dispose();
			view.dispose();
		}
	});

	/**
	 * Put back what you attached: the element, the exclusion, the frame handler and
	 * the key.
	 *
	 * The exclusion is the one a test can see without reaching inside, because the
	 * element it named is gone from the tree -- so what is asserted is that the
	 * stats describe the app again and that nothing is still reading frames.
	 */
	it('should put everything back on dispose', () => {
		const { h, log, overlay, view } = mount({ height: 8, visible: true });

		try {
			log.push('log', 'before');
			view.frame();
			view.frame();
			expect(h.lines().join('\n')).to.include('before');

			overlay.dispose();
			view.frame();

			expect(overlay.element.parent).to.equal(undefined);
			expect(h.lines().join('\n')).to.not.include('before');
			// the app's own two, which says nothing about the exclusion: the pane is
			// detached, so `countTree()` never visits it either way. What the
			// exclusion going back is observable through is the test below
			expect(view.stats?.elements).to.equal(2);

			// and a line pushed afterwards reaches nothing, which is a **count** rather
			// than a picture: the pane is detached, so whatever it builds is invisible
			// either way -- what a disposed overlay still reading frames would do is
			// go on appending rows to a subtree nobody can see, for the life of the
			// process. Deleting the unsubscribe survived every other test here
			const size = countElements(overlay.element);
			for (let i = 0; i < 20; i++) {
				log.push('log', `after ${i}`);
			}
			view.frame();
			view.frame();
			expect(countElements(overlay.element)).to.equal(size);
			expect(h.lines().join('\n')).to.not.include('after');

			overlay.dispose();
		} finally {
			view.dispose();
		}
	});

	/** A router that is nothing but its bindings, which is all the key needs. */
	function router() {
		const binds = new Set<(event: unknown) => void>();
		const stopped: string[] = [];
		return {
			input: {
				bind(handler: (event: never) => void) {
					binds.add(handler as (event: unknown) => void);
					return () => binds.delete(handler as (event: unknown) => void);
				},
			} as never,
			press(key: { ctrl?: boolean; meta?: boolean; name: string }) {
				// a copy, for the reason the router's own dispatch takes one
				// eslint-disable-next-line unicorn/no-useless-spread
				for (const handler of [...binds]) {
					handler({
						key: { ctrl: false, meta: false, shift: false, sequence: key.name, ...key },
						stop: () => stopped.push(key.name),
					});
				}
			},
			stopped,
		};
	}

	/**
	 * Dispose gives the exclusion back, which is only observable if the pane is put
	 * back in the tree.
	 *
	 * Reported by the second review round as a vacuity: the dispose test asserts
	 * `stats.elements === 2` afterwards and the comment called that the exclusion,
	 * where it is only the detachment -- `countTree()` walks from the root, so a
	 * detached pane is uncounted whether or not it is still in the set. Re-attaching
	 * it is what tells the two apart, and it is a real statement besides: a disposed
	 * pane is an ordinary element again, and an ordinary element is counted.
	 */
	it('should give its exclusion back on dispose', () => {
		const { overlay, view } = mount({ height: 6, visible: true });

		try {
			view.frame();
			const pane = countElements(overlay.element);
			expect(pane).to.be.greaterThan(4);
			expect(view.stats?.elements).to.equal(2);

			overlay.dispose();
			// put back as an ordinary child, which it now is
			view.root.append(overlay.element);
			view.frame();

			expect(view.stats?.elements).to.equal(2 + pane);
		} finally {
			overlay.dispose();
			view.dispose();
		}
	});

	it('should bind a key where it was given a router', () => {
		const r = router();
		const { overlay, view } = mount({
			input: r.input,
			key: (key) => key.ctrl && key.name === 'g',
		});

		try {
			r.press({ name: 'g' });
			expect(overlay.visible).to.equal(false);

			r.press({ ctrl: true, name: 'g' });
			expect(overlay.visible).to.equal(true);
			// stopped, because a binding sees every key first and this one is not
			// also a key for whatever has the focus
			expect(r.stopped).to.deep.equal(['g']);

			r.press({ ctrl: true, name: 'g' });
			expect(overlay.visible).to.equal(false);

			overlay.dispose();
			r.press({ ctrl: true, name: 'g' });
			// unbound, so the pane did not move again
			expect(overlay.visible).to.equal(false);
		} finally {
			overlay.dispose();
			view.dispose();
		}
	});

	/**
	 * A predicate rather than a name, which is the shape the demo forced.
	 *
	 * The first version matched `Key.name` and recommended `f12` -- a name this
	 * decoder never produces, since the named sequences are the arrows, the paging
	 * keys and the editing keys and everything else arrives as a key whose name is
	 * its own escape sequence. So the one documented value of the option matched
	 * nothing, which no unit test could see because every one of them wrote the
	 * name it was asserting.
	 */
	it('should leave which key it is entirely to the app', () => {
		const r = router();
		const { overlay, view } = mount({
			input: r.input,
			// exactly what a terminal sends for F12, which the decoder names after
			// itself because it names no function key
			key: (key) => key.sequence === '\u001b[24~',
		});

		try {
			r.press({ name: 'f12' });
			expect(overlay.visible).to.equal(false);
			r.press({ name: '\u001b[24~' });
			expect(overlay.visible).to.equal(true);
		} finally {
			overlay.dispose();
			view.dispose();
		}
	});

	/**
	 * A key on a renderer that has gone is not claimed.
	 *
	 * `view.dispose()` without `overlay.dispose()` is a thing an app does, and the
	 * binding would otherwise go on calling `event.stop()` on a router the app
	 * still owns -- a binding sees every key first, so the one the overlay took is
	 * a key nothing else can have. Reported by review.
	 */
	it('should stop claiming its key once the renderer has gone', () => {
		const r = router();
		const { overlay, view } = mount({
			input: r.input,
			key: (key) => key.ctrl && key.name === 'g',
		});

		try {
			r.press({ ctrl: true, name: 'g' });
			expect(r.stopped.length).to.equal(1);

			view.dispose();
			r.press({ ctrl: true, name: 'g' });
			expect(r.stopped.length).to.equal(1);
		} finally {
			overlay.dispose();
			view.dispose();
		}
	});

	it('should bind nothing without both a router and a key', () => {
		const r = router();
		const only = mount({ input: r.input });
		try {
			r.press({ ctrl: true, name: 'g' });
			expect(only.overlay.visible).to.equal(false);
			expect(r.stopped).to.deep.equal([]);
		} finally {
			only.overlay.dispose();
			only.view.dispose();
		}

		const neither = mount({ key: (key) => key.name === 'g' });
		try {
			expect(neither.overlay.visible).to.equal(false);
		} finally {
			neither.overlay.dispose();
			neither.view.dispose();
		}
	});
});

describe('the debug overlay in the framework sheet', () => {
	/**
	 * Every line draws in a role, asserted on the **rendered** line rather than on
	 * the sheet.
	 *
	 * The first version of this asked whether the four roles carried a declaration,
	 * which is a claim about `FRAMEWORK_CSS` and would have passed with the pane
	 * drawing every level in no role at all -- the vacuity this round was pointed
	 * at. What is asserted now is the colour an entry came out with, which is the
	 * only thing a theme can actually reach.
	 */
	it('should draw every line in the role a theme reaches it by', () => {
		const drawn = (theme?: string) => {
			const h = harness(40, 12);
			const log = createLogRing();
			for (const level of ['debug', 'error', 'info', 'log', 'warn'] as LogLevel[]) {
				log.push(level, level);
			}
			const sheets = [frameworkSheet()];
			if (theme !== undefined) {
				sheets.push(parseStylesheet(theme, { origin: 'app' }));
			}
			const view = render(() => box({}, text('app')), {
				backend: h.backend,
				cascade: new Cascade(sheets),
				colorLevel: 1,
				effects,
				terminal: h.terminal,
			});
			const overlay = enableDebugOverlay(view, { height: 9, log, visible: true });
			view.frame();
			view.frame();

			const found: Record<string, { color: number; dim: boolean }> = {};
			const walk = (at: Element): void => {
				if (at.classes.includes('sigil-debug-entry')) {
					found[at.displayText] = { color: at.style.color, dim: at.style.dim };
				}
				for (const child of at.children) {
					walk(child);
				}
			};
			walk(overlay.element);
			overlay.dispose();
			view.dispose();
			return found;
		};

		// the framework's own answers, which is what the roles resolve to
		const base = drawn();
		expect(base.error?.color).to.equal(1);
		expect(base.warn?.color).to.equal(3);
		expect(base.info?.color).to.equal(4);
		expect(base.debug?.dim).to.equal(true);
		// `log` draws in no role, because the ordinary case is the default foreground
		expect(base.log?.color).to.equal(-1);
		expect(base.log?.dim).to.equal(false);

		// and a theme reaches each of them with one rule and no `!important`
		const themed = drawn(
			'.sigil-error { color: magenta } .sigil-warn { color: cyan } ' +
				'.sigil-info { color: green } .sigil-muted { dim: false; color: blue }'
		);
		expect(themed.error?.color).to.equal(5);
		expect(themed.warn?.color).to.equal(6);
		expect(themed.info?.color).to.equal(2);
		expect(themed.debug?.color).to.equal(4);
		expect(themed.debug?.dim).to.equal(false);
	});

	/**
	 * The one declaration the pane carries, and the reason it is a background: no
	 * role is one, and a box with no background paints nothing in its empty cells
	 * -- so the app would show through between the pane's words.
	 */
	it('should give the pane a background in both schemes', () => {
		const sheet = frameworkSheet();
		const base = sheet.rules.filter(
			(rule) =>
				rule.selectors.some((selector) => selector.source === '.sigil-debug') &&
				rule.declarations.length > 0
		);

		expect(base.length).to.equal(2);
		for (const rule of base) {
			expect(rule.declarations.map((d) => d.property)).to.deep.equal(['backgroundColor']);
		}
	});

	/**
	 * The background is the sheet's, so a theme can reach it -- and the light half
	 * is what proves it, because a prop written into the host beat both and looked
	 * perfectly right on a dark terminal where the two agreed. Reported by review
	 * and found by self-review in the same hour.
	 */
	it('should let a theme and the light half reach the background', () => {
		const render3 = (scheme: 'dark' | 'light', theme?: string) => {
			const h = harness(40, 8);
			const sheets = [frameworkSheet()];
			if (theme !== undefined) {
				sheets.push(parseStylesheet(theme, { origin: 'app' }));
			}
			const view = render(() => box({}, text('app')), {
				backend: h.backend,
				cascade: new Cascade(sheets),
				colorLevel: 1,
				colorScheme: scheme,
				effects,
				terminal: h.terminal,
			});
			const overlay = enableDebugOverlay(view, { height: 5, visible: true });
			view.frame();
			const found = overlay.element.style.backgroundColor;
			overlay.dispose();
			view.dispose();
			return found;
		};

		// index 0 on a dark terminal and index 7 on a light one, which is the pair
		// the pane's own default foreground needs behind it
		expect(render3('dark')).to.equal(0);
		expect(render3('light')).to.equal(7);
		// and a theme beats both, with an ordinary rule and no `!important`
		expect(render3('dark', '.sigil-debug { background-color: blue }')).to.equal(4);
		expect(render3('light', '.sigil-debug { background-color: blue }')).to.equal(4);
	});

	/**
	 * Every class the pane draws with is one a theme can write a rule against,
	 * which is what "styled entirely by framework classes" comes to.
	 *
	 * Read off a rendered pane rather than off the source, because a class in a
	 * constructor somebody deleted is a class the sheet still lists.
	 */
	it('should let a theme restyle the pane', () => {
		const h = harness(40, 8);
		const theme = parseStylesheet(
			'.sigil-debug-title { color: magenta } .sigil-debug-entry { color: green }',
			{ origin: 'app' }
		);
		const log = createLogRing();
		log.push('log', 'themed');
		const view = render(() => box({}, text('app')), {
			backend: h.backend,
			cascade: new Cascade([frameworkSheet(), theme]),
			colorLevel: 1,
			effects,
			terminal: h.terminal,
		});
		const overlay = enableDebugOverlay(view, { height: 6, log, visible: true });

		try {
			view.frame();
			view.frame();

			const title = findClass(overlay.element, 'sigil-debug-title');
			const entry = findClass(overlay.element, 'sigil-debug-entry');
			expect(title?.style.color).to.equal(5);
			expect(entry?.style.color).to.equal(2);
		} finally {
			overlay.dispose();
			view.dispose();
		}
	});
});

/** The first element carrying a class, which is how a pane's parts are found. */
function findClass(at: Element, name: string): Element | undefined {
	if (at.classes.includes(name)) {
		return at;
	}
	for (const child of at.children) {
		const found = findClass(child, name);
		if (found) {
			return found;
		}
	}
	return undefined;
}
