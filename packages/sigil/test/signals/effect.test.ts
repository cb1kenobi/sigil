import {
	Computed,
	createEffects,
	effect,
	flush,
	hasSinks,
	sinkCount,
	setErrorHandler,
	setScheduler,
	State,
} from '../../src/signals/index.js';
import { afterEach, describe, expect, it } from 'vitest';

/** Lets the default microtask scheduler run. */
function tick(): Promise<void> {
	return Promise.resolve();
}

/**
 * Replaces the scheduler with one that queues nothing, so a test drives the
 * flush by hand and asserts on exact timing rather than on a microtask landing.
 */
function manualScheduler() {
	const pending: (() => void)[] = [];
	const previous = setScheduler((fn) => pending.push(fn));
	return {
		get queued() {
			return pending.length;
		},
		restore: () => setScheduler(previous),
		run() {
			const queued = pending.splice(0, pending.length);
			for (const fn of queued) {
				fn();
			}
		},
	};
}

describe('effect', () => {
	afterEach(() => {
		setScheduler(undefined);
	});

	it('should run immediately', () => {
		let runs = 0;
		const stop = effect(() => {
			runs++;
		});
		expect(runs).toBe(1);
		stop();
	});

	it('should re-run when a signal it read changes', async () => {
		const s = new State(0);
		const seen: number[] = [];
		const stop = effect(() => {
			seen.push(s.get());
		});

		expect(seen).toEqual([0]);

		s.set(1);
		await tick();
		expect(seen).toEqual([0, 1]);

		stop();
	});

	it('should settle a burst of writes into one run', async () => {
		const s = new State(0);
		const seen: number[] = [];
		const stop = effect(() => {
			seen.push(s.get());
		});

		s.set(1);
		s.set(2);
		s.set(3);
		expect(seen).toEqual([0]);

		await tick();
		expect(seen).toEqual([0, 3]);

		stop();
	});

	it('should run once for a value that changed and came back', async () => {
		const s = new State(0);
		const seen: number[] = [];
		const stop = effect(() => {
			seen.push(s.get());
		});

		s.set(1);
		s.set(0);
		await tick();

		// coalescing is about how many times an effect runs, not about whether it
		// runs at all. Both writes were real changes when they happened, and
		// nothing records the value a signal held before a burst -- so the effect
		// runs once, with what the signal settled on
		expect(seen).toEqual([0, 0]);

		stop();
	});

	it('should run a cleanup before each re-run and once on dispose', async () => {
		const s = new State(0);
		const events: string[] = [];

		const stop = effect(() => {
			const value = s.get();
			events.push(`run:${value}`);
			return () => events.push(`cleanup:${value}`);
		});

		expect(events).toEqual(['run:0']);

		s.set(1);
		await tick();
		expect(events).toEqual(['run:0', 'cleanup:0', 'run:1']);

		stop();
		expect(events).toEqual(['run:0', 'cleanup:0', 'run:1', 'cleanup:1']);
	});

	it('should stop running once disposed', async () => {
		const s = new State(0);
		let runs = 0;
		const stop = effect(() => {
			s.get();
			runs++;
		});

		stop();
		s.set(1);
		await tick();
		expect(runs).toBe(1);
	});

	it('should be safe to dispose twice', () => {
		let cleanups = 0;
		const stop = effect(() => () => cleanups++);
		stop();
		stop();
		expect(cleanups).toBe(1);
	});

	it('should release its dependencies on dispose', async () => {
		const events: string[] = [];
		const { unwatched, watched } = await import('../../src/signals/index.js');
		const s = new State(0, {
			[watched]: () => events.push('watched'),
			[unwatched]: () => events.push('unwatched'),
		});

		const stop = effect(() => {
			s.get();
		});
		expect(events).toEqual(['watched']);

		stop();
		expect(events).toEqual(['watched', 'unwatched']);
	});

	it('should track dynamically across re-runs', async () => {
		const useLeft = new State(true);
		const left = new State('L');
		const right = new State('R');
		const seen: string[] = [];

		const stop = effect(() => {
			seen.push(useLeft.get() ? left.get() : right.get());
		});

		expect(seen).toEqual(['L']);

		right.set('R2');
		await tick();
		expect(seen).toEqual(['L']);

		useLeft.set(false);
		await tick();
		expect(seen).toEqual(['L', 'R2']);

		left.set('L2');
		await tick();
		expect(seen).toEqual(['L', 'R2']);

		stop();
	});

	it('should see a computed through to its state', async () => {
		const s = new State(1);
		const doubled = new Computed(() => s.get() * 2);
		const seen: number[] = [];

		const stop = effect(() => {
			seen.push(doubled.get());
		});

		expect(seen).toEqual([2]);
		s.set(5);
		await tick();
		expect(seen).toEqual([2, 10]);

		stop();
	});

	it('should let a throw out of the first run', () => {
		expect(() =>
			effect(() => {
				throw new Error('bang');
			})
		).toThrow('bang');
	});

	it('should send a throw to the error handler rather than out of flush', () => {
		const scheduler = manualScheduler();
		const seen: unknown[] = [];
		const previous = setErrorHandler((err) => seen.push(err));
		try {
			const s = new State(0);
			const stop = effect(() => {
				if (s.get() > 0) {
					throw new Error('bang');
				}
			});

			s.set(1);
			// never out of flush: under the microtask scheduler a rethrow lands in a
			// microtask nobody catches, which kills the process with a raw stack and
			// skips every bit of error handling the framework has
			expect(() => scheduler.run()).not.toThrow();
			expect((seen[0] as Error).message).toBe('bang');

			stop();
		} finally {
			setErrorHandler(previous);
			scheduler.restore();
		}
	});

	it('should run every pending effect even when one throws', () => {
		const scheduler = manualScheduler();
		const previous = setErrorHandler(() => {});
		try {
			const s = new State(0);
			const ran: string[] = [];

			const stopBad = effect(() => {
				if (s.get() > 0) {
					throw new Error('bang');
				}
				ran.push('bad');
			});
			const stopGood = effect(() => {
				s.get();
				ran.push('good');
			});

			expect(ran).toEqual(['bad', 'good']);

			s.set(1);
			scheduler.run();
			expect(ran).toEqual(['bad', 'good', 'good']);

			stopBad();
			stopGood();
		} finally {
			setErrorHandler(previous);
			scheduler.restore();
		}
	});

	it('should keep working after an effect throws', () => {
		const scheduler = manualScheduler();
		const previous = setErrorHandler(() => {});
		try {
			const s = new State(0);
			const seen: number[] = [];

			const stopBad = effect(() => {
				if (s.get() === 1) {
					throw new Error('bang');
				}
			});
			const stopGood = effect(() => {
				seen.push(s.get());
			});

			s.set(1);
			scheduler.run();
			expect(seen).toEqual([0, 1]);

			// a disarmed watcher would end all future reactivity here
			s.set(2);
			scheduler.run();
			expect(seen).toEqual([0, 1, 2]);

			stopBad();
			stopGood();
		} finally {
			setErrorHandler(previous);
			scheduler.restore();
		}
	});

	it('should not leave a leaked effect behind when the first run throws', () => {
		const s = new State(0);
		let runs = 0;

		expect(() =>
			effect(() => {
				runs++;
				s.get();
				throw new Error('bang');
			})
		).toThrow('bang');

		expect(runs).toBe(1);
		// nothing was handed back that could unwatch it, so if it were still
		// watched it would re-run on every change for the life of the process --
		// and the edge itself has to go too, because a source holds its sinks
		expect(hasSinks(s)).toBe(false);
		expect(sinkCount(s)).toBe(0);

		s.set(1);
		flush();
		expect(runs).toBe(1);
	});

	it('should refuse an async body', () => {
		// the cast is the point: TypeScript already refuses this, and the throw is
		// for the JavaScript callers and the inferred-async arrows it cannot catch
		const body = (async () => {}) as unknown as () => void;
		expect(() => effect(body)).toThrow(/may not be async/);
	});

	it('should ignore a return value that is not a cleanup', () => {
		// a concise arrow body returns whatever its last call did, and
		// `effect(() => a.set(b.get()))` is the spelling worth encouraging
		const s = new State(1);
		expect(() => effect((() => s.get()) as () => void)).not.toThrow();
	});

	describe('writing from an effect', () => {
		it('should be allowed', () => {
			const source = new State(1);
			const mirror = new State(0);

			const stop = effect(() => {
				// reacting to a change by setting something else is most of what an
				// effect is for -- focus moving, a resize landing on a width
				mirror.set(source.get() * 2);
			});

			expect(mirror.get()).toBe(2);
			source.set(5);
			flush();
			expect(mirror.get()).toBe(10);

			stop();
		});

		it('should settle an effect that a write in the same flush dirtied', () => {
			const a = new State(0);
			const b = new State(0);
			const seen: number[] = [];

			const stopWriter = effect(() => {
				b.set(a.get() + 1);
			});
			const stopReader = effect(() => {
				seen.push(b.get());
			});

			expect(seen).toEqual([1]);

			a.set(10);
			flush();
			// the reader was already clean when the writer dirtied it, so a flush
			// that drained once and stopped would leave it a frame behind
			expect(seen).toEqual([1, 11]);

			stopWriter();
			stopReader();
		});

		it('should give up on a cycle rather than spinning', () => {
			const seen: unknown[] = [];
			const previous = setErrorHandler((err) => seen.push(err));
			try {
				const a = new State(0);
				const b = new State(0);

				const stopA = effect(() => a.set(b.get() + 1));
				const stopB = effect(() => b.set(a.get() + 1));

				a.set(100);
				flush();

				expect((seen[0] as Error).message).toMatch(/did not settle/);

				stopA();
				stopB();
			} finally {
				setErrorHandler(previous);
			}
		});

		it('should stop asking for a flush once it has given up', async () => {
			// its own scope, because the cycle is deliberately left alive past the
			// assertions -- the old cycle test disposed both effects before the
			// queued microtask landed, which is exactly what hid this
			const own = createEffects();
			const errors: unknown[] = [];
			own.setErrorHandler((err) => errors.push(err));

			const a = new State(0);
			const b = new State(0);
			own.effect(() => a.set(b.get() + 1));
			own.effect(() => b.set(a.get() + 1));

			a.set(1);
			own.flush();
			expect(errors).toHaveLength(1);

			for (let pass = 0; pass < 5; pass++) {
				await tick();
			}
			// a macrotask only runs once the microtask queue has drained, so this is
			// what says the loop went idle rather than merely that the count is
			// small. Giving up used to leave the effects dirty and then re-arm the
			// watcher bare, which announced them again and queued the same flush --
			// one report per microtask, forever
			await new Promise((resolve) => setTimeout(resolve, 0));
			expect(errors).toHaveLength(1);
		});

		it('should not recurse when a synchronous scheduler flushes a cycle', () => {
			const own = createEffects();
			const errors: unknown[] = [];
			own.setErrorHandler((err) => errors.push(err));
			own.setScheduler((run) => run());

			const armed = new State(false);
			const a = new State(0);
			const b = new State(0);
			// nothing writes until `armed` is set, so both effects start clean and
			// the cycle begins at a write the test can point at
			own.effect(() => {
				if (armed.get()) {
					a.set(b.get() + 1);
				}
			});
			own.effect(() => {
				if (armed.get()) {
					b.set(a.get() + 1);
				}
			});

			// the re-arm on the way out of a flush that gave up notified, the notify
			// scheduled a flush, and a synchronous scheduler ran it there and then --
			// with `flushing` already back to `false`, so nothing stopped it. The
			// stack overflow came out of this `set()`
			expect(() => armed.set(true)).not.toThrow();
			expect(errors).toHaveLength(1);
			expect((errors[0] as Error).message).toMatch(/did not settle/);
		});

		it('should still hear a later change after giving up', async () => {
			const own = createEffects();
			const errors: unknown[] = [];
			own.setErrorHandler((err) => errors.push(err));

			const a = new State(0);
			const b = new State(0);
			const c = new State(0);
			const seen: number[] = [];
			own.effect(() => a.set(b.get() + 1));
			own.effect(() => b.set(a.get() + 1));
			own.effect(() => {
				seen.push(c.get());
			});

			c.set(1);
			own.flush();
			// an effect that was dirty for an innocent reason during the failed
			// settle is not stranded by it: every pass runs everything pending
			expect(seen).toEqual([0, 1]);
			expect(errors).toHaveLength(1);

			c.set(2);
			await tick();
			// the re-arm is silent, not deaf -- a later clean-to-dirty transition
			// still schedules a flush
			expect(seen).toEqual([0, 1, 2]);
			// and that flush retries the cycle and gives up again, which is the
			// error rate this settles on: once per failed settle, and a settle is
			// only attempted when something outside the cycle changed
			expect(errors).toHaveLength(2);
		});

		it('should still drain when the caller asks after giving up', () => {
			const own = createEffects();
			const errors: unknown[] = [];
			own.setErrorHandler((err) => errors.push(err));

			const a = new State(0);
			const b = new State(0);
			const stopA = own.effect(() => a.set(b.get() + 1));
			own.effect(() => b.set(a.get() + 1));

			own.flush();
			expect(errors).toHaveLength(1);

			// the caller has broken the cycle, and disposing announces nothing -- so
			// a flush they asked for themselves is not the one the give-up asked for
			// and must run whatever is pending
			stopA();
			a.set(50);
			own.flush();
			expect(b.get()).toBe(51);
			expect(errors).toHaveLength(1);
		});

		it('should look again when a disposal breaks a cycle', async () => {
			const own = createEffects();
			const errors: unknown[] = [];
			own.setErrorHandler((err) => errors.push(err));

			const a = new State(0);
			const b = new State(0);
			const input = new State(0);
			const seen: number[] = [];
			// first in the watch order and reading both sides of the cycle, so
			// whichever of them runs after it dirties it again -- the drain gives up
			// with this one pending, however the passes fall
			own.effect(() => {
				a.get();
				b.get();
				seen.push(input.get());
			});
			const stopA = own.effect(() => a.set(b.get() + 1));
			const stopB = own.effect(() => b.set(a.get() + 1));

			own.flush();
			expect(errors).toHaveLength(1);
			const stranded = seen.length;

			stopA();
			stopB();
			// the write lands on an effect that is already dirty, so propagation
			// stops there and the watcher hears nothing -- and the flush the failed
			// drain had already asked for is the one `stalled` refuses. Disposing is
			// what says the next drain would do something different, and it is how a
			// caller breaks a cycle, so it has to take the latch off
			input.set(1000);
			await tick();
			expect(seen.length).toBeGreaterThan(stranded);
			expect(seen.at(-1)).toBe(1000);
		});

		it('should not report a cycle for a chain that settled on its last pass', () => {
			// the bound counted loop iterations while the check for "anything left?"
			// happened at the *start* of one, so the last pass's own work was never
			// looked at: a chain needing exactly `MAX_PASSES` passes did all of it,
			// settled, and was reported as a cycle anyway -- with the right values
			// sitting there already computed. A false "did not settle" is a lie of
			// exactly the kind that erodes trust in the true one
			const settles = (links: number) => {
				const own = createEffects();
				const errors: unknown[] = [];
				own.setErrorHandler((err) => errors.push(err));
				own.setScheduler(() => {});

				const states = Array.from({ length: links + 1 }, () => new State(0));
				// created last link first, so each pass moves the value one step
				for (let i = links - 1; i >= 0; i--) {
					own.effect(() => states[i + 1].set(states[i].get()));
				}

				states[0].set(7);
				own.flush();
				return { errors: errors.length, last: states[links].get() };
			};

			// a hundred passes is what the bound allows, so a hundred passes settles
			expect(settles(99)).toEqual({ errors: 0, last: 7 });
			expect(settles(100)).toEqual({ errors: 0, last: 7 });
			// and a hundred and one is a chain this really cannot drain
			expect(settles(101)).toEqual({ errors: 1, last: 0 });
		});

		it('should not drain into a run that has not finished', () => {
			// an effect body may write, and a synchronous scheduler flushes that
			// write where it happens -- which during an effect's *first* run is from
			// inside the `get()` that is running it. The drain then reached that very
			// computed and asked it for the value it was in the middle of producing:
			// "A Computed may not read itself", once per pass, a hundred times, on
			// top of the one report the cycle actually deserves
			const own = createEffects();
			const errors: unknown[] = [];
			own.setErrorHandler((err) => errors.push(err));
			own.setScheduler((fn) => fn());

			const a = new State(0);
			const b = new State(0);
			own.effect(() => a.set(b.get() + 1));
			own.effect(() => b.set(a.get() + 1));

			// one report, and it is the true one. It used to be a hundred and one
			expect(errors).toHaveLength(1);
			expect(String(errors[0])).toMatch(/did not settle/);
			expect(String(errors[0])).not.toMatch(/read itself/);
		});

		it('should report a cycle that runs between two scopes', async () => {
			// `MAX_PASSES` is per scope by construction, so it never saw this: each
			// drain settles in a pass or two, announces the other scope's work on the
			// way out, and neither ever reaches its own bound. Two scopes writing
			// what the other reads spun forever reporting nothing at all -- the same
			// failure the bound exists to prevent, one level up
			const one = createEffects();
			const two = createEffects();
			const errors: unknown[] = [];
			one.setErrorHandler((err) => errors.push(err));
			two.setErrorHandler((err) => errors.push(err));
			// nothing runs while the two are being created
			one.setScheduler(() => {});
			two.setScheduler(() => {});

			const a = new State(0);
			const b = new State(0);
			one.effect(() => a.set(b.get() + 1));
			two.effect(() => b.set(a.get() + 1));

			// the default microtask scheduler, where each flush finishes before the
			// next one starts -- which is what makes this a chain rather than a nest,
			// and a nest damps itself out because a write lands on a run that has not
			// committed yet
			one.setScheduler(undefined);
			two.setScheduler(undefined);
			b.set(100);

			for (let i = 0; i < 400; i++) {
				await tick();
			}

			expect(errors).toHaveLength(1);
			expect(String(errors[0])).toMatch(/chained flushes/);
		}, 20000);

		it('should not read its own teardown as a cycle being broken', async () => {
			// the other half of the rule above, and the half that made it hard: a
			// cycling drain disposes effects all by itself, because an effect
			// re-running tears its children down first. So "something was disposed
			// while draining" fires on every pass of a drain going nowhere, and
			// counting those would clear the latch every time and ask for the same
			// failing flush forever -- which is the storm `stalled` exists to stop.
			// Asking *who* disposed separates them; counting cannot
			const own = createEffects();
			const errors: unknown[] = [];
			own.setErrorHandler((err) => errors.push(err));

			const a = new State(0);
			const b = new State(0);
			own.effect(() => {
				// a child effect per run, disposed by the next one
				own.effect(() => {});
				a.set(b.get() + 1);
			});
			own.effect(() => b.set(a.get() + 1));

			own.flush();
			expect(errors).toHaveLength(1);

			// the latch held: nothing announced anything, so the flush the failed
			// drain's own writes asked for does nothing rather than failing again
			await tick();
			expect(errors).toHaveLength(1);
		});

		it('should retry when the caller disposes the cycle mid-drain', async () => {
			const own = createEffects();
			const errors: unknown[] = [];
			const a = new State(0);
			const b = new State(0);
			const input = new State(0);
			const seen: number[] = [];
			let stopA = (): void => {};
			let stopB = (): void => {};

			// the handler shuts the cycle down, which is a graph change made from
			// inside the drain that gave up rather than after it
			own.setErrorHandler((err) => {
				errors.push(err);
				stopA();
				stopB();
			});

			own.effect(() => {
				a.get();
				b.get();
				seen.push(input.get());
			});
			stopA = own.effect(() => a.set(b.get() + 1));
			stopB = own.effect(() => b.set(a.get() + 1));

			own.flush();
			expect(errors).toHaveLength(1);

			// the disposal is the caller's, so it counts: the give-up does not latch,
			// and the effect the cycle was starving hears this write. A disposal the
			// *scope* made -- an effect re-running tears its children down, on every
			// pass of a drain going nowhere -- is not evidence of anything and is not
			// counted, which is what `teardown` separates
			input.set(1000);
			await tick();
			expect(seen.at(-1)).toBe(1000);
			expect(errors).toHaveLength(1);
		});
	});

	it('should not run an effect disposed by another effect in the same flush', () => {
		const scheduler = manualScheduler();
		try {
			const s = new State(0);
			let bRuns = 0;
			let stopB = () => {};

			const stopA = effect(() => {
				if (s.get() > 0) {
					stopB();
				}
			});
			stopB = effect(() => {
				s.get();
				bRuns++;
			});

			expect(bRuns).toBe(1);

			s.set(1);
			scheduler.run();

			// the flush snapshots what is pending before it starts, so B was already
			// in the list when A disposed it. Running it anyway would re-link it to
			// `s` on the way, quietly undoing the disposal
			expect(bRuns).toBe(1);
			expect(sinkCount(s)).toBe(1);

			stopA();
		} finally {
			scheduler.restore();
		}
	});

	describe('nested effects', () => {
		it('should dispose every child, not every other one', () => {
			// `runCleanups()` iterates the child set while each disposal deletes
			// itself from it. That used to be done over a copy; it does not need to
			// be, because a `Set` iterator is specified to cope -- and a copy is the
			// kind of thing that is either load-bearing or noise, with no way to tell
			// which from reading it. This is the test that says which
			const own = createEffects();
			const s = new State(0);
			const disposed: number[] = [];

			own.effect(() => {
				s.get();
				for (const n of [1, 2, 3, 4, 5]) {
					own.effect(() => () => disposed.push(n));
				}
			});

			s.set(1);
			own.flush();
			expect(disposed).toEqual([1, 2, 3, 4, 5]);
		});

		it('should survive a cleanup that disposes a sibling', () => {
			// the other half of the same question: a disposal removes an entry the
			// walk has not reached yet. Skipping it is correct -- it has just been
			// disposed -- and it is what the iterator does
			const own = createEffects();
			const s = new State(0);
			const disposed: string[] = [];
			let stopB = (): void => {};

			own.effect(() => {
				s.get();
				own.effect(() => () => {
					disposed.push('a');
					stopB();
				});
				stopB = own.effect(() => () => disposed.push('b'));
				own.effect(() => () => disposed.push('c'));
			});

			s.set(1);
			own.flush();
			expect(disposed).toEqual(['a', 'b', 'c']);
		});

		it('should dispose a child when the parent re-runs', () => {
			const outer = new State(0);
			const inner = new State(0);
			let innerRuns = 0;

			const stop = effect(() => {
				outer.get();
				effect(() => {
					inner.get();
					innerRuns++;
				});
			});

			expect(innerRuns).toBe(1);

			// the parent re-runs and makes a new child; the old one must go, or a
			// component that renders twice leaks an effect per render
			outer.set(1);
			flush();
			expect(innerRuns).toBe(2);

			inner.set(1);
			flush();
			expect(innerRuns).toBe(3);

			stop();
		});

		it('should dispose a child when the parent is disposed', () => {
			const inner = new State(0);
			let innerRuns = 0;

			const stop = effect(() => {
				effect(() => {
					inner.get();
					innerRuns++;
				});
			});

			expect(innerRuns).toBe(1);
			stop();

			inner.set(1);
			flush();
			expect(innerRuns).toBe(1);
			expect(sinkCount(inner)).toBe(0);
		});

		it('should not make a child a dependency of its parent', () => {
			const s = new State(0);
			let outerRuns = 0;

			const stop = effect(() => {
				outerRuns++;
				effect(() => {
					s.get();
				});
			});

			expect(outerRuns).toBe(1);
			s.set(1);
			flush();
			// only the child read `s`; the parent read nothing
			expect(outerRuns).toBe(1);

			stop();
		});

		it('should run a child cleanup when the parent re-runs', () => {
			const outer = new State(0);
			const events: string[] = [];

			const stop = effect(() => {
				outer.get();
				effect(() => () => events.push('child cleanup'));
			});

			outer.set(1);
			flush();
			expect(events).toEqual(['child cleanup']);

			stop();
			expect(events).toEqual(['child cleanup', 'child cleanup']);
		});
	});
});

describe('setScheduler', () => {
	afterEach(() => {
		setScheduler(undefined);
	});

	it('should ask the scheduler once for a burst of writes', () => {
		const scheduler = manualScheduler();
		try {
			const s = new State(0);
			const stop = effect(() => {
				s.get();
			});

			s.set(1);
			s.set(2);
			s.set(3);
			expect(scheduler.queued).toBe(1);

			scheduler.run();
			stop();
		} finally {
			scheduler.restore();
		}
	});

	it('should ask again after the queue has been drained', () => {
		const scheduler = manualScheduler();
		try {
			const s = new State(0);
			const stop = effect(() => {
				s.get();
			});

			s.set(1);
			expect(scheduler.queued).toBe(1);
			scheduler.run();

			s.set(2);
			expect(scheduler.queued).toBe(1);
			scheduler.run();

			stop();
		} finally {
			scheduler.restore();
		}
	});

	it('should not schedule anything when nothing is watching', () => {
		const scheduler = manualScheduler();
		try {
			const s = new State(0);
			s.set(1);
			s.set(2);
			expect(scheduler.queued).toBe(0);
		} finally {
			scheduler.restore();
		}
	});

	it('should hand back the scheduler it replaced', () => {
		const mine = (fn: () => void) => fn();
		const previous = setScheduler(mine);
		expect(setScheduler(previous)).toBe(mine);
	});

	it('should survive a scheduler that runs flush synchronously', () => {
		// a frame loop driving its own timing does exactly this. The notify
		// callback is the one place that may not touch the graph, and a flush
		// started from inside it used to throw out of the `set()` that triggered it
		// and leave the watcher disarmed for the life of the process
		const previous = setScheduler((run) => run());
		// the first version of this fix ran the effect body and *then* threw on the
		// way out, so the visible assertions all passed while an error went quietly
		// to stderr. Watching the error handler is the only way to see that
		const errors: unknown[] = [];
		const previousHandler = setErrorHandler((err) => errors.push(err));
		try {
			const s = new State(0);
			const seen: number[] = [];
			const stop = effect(() => {
				seen.push(s.get());
			});

			expect(() => s.set(1)).not.toThrow();
			expect(seen).toEqual([0, 1]);

			s.set(2);
			expect(seen).toEqual([0, 1, 2]);
			expect(errors).toEqual([]);

			stop();
		} finally {
			setErrorHandler(previousHandler);
			setScheduler(previous);
		}
	});

	it('should recover when a scheduler is swapped out without having run', () => {
		const s = new State(0);
		const seen: number[] = [];
		const stop = effect(() => {
			seen.push(s.get());
		});

		const previous = setScheduler(() => {
			// asked, and never runs it
		});
		try {
			s.set(1);
			expect(seen).toEqual([0]);
		} finally {
			setScheduler(previous);
		}

		// the abandoned scheduler left the queue claimed and the watcher disarmed;
		// putting one back has to clear that or reactivity is dead from here on
		s.set(2);
		flush();
		expect(seen).toEqual([0, 2]);

		stop();
	});

	it('should hand a queued flush to a scheduler that replaces one', () => {
		const s = new State(0);
		const seen: number[] = [];
		const stop = effect(() => {
			seen.push(s.get());
		});

		const abandoned = manualScheduler();
		s.set(2);
		expect(seen).toEqual([0]);

		// the old scheduler was asked and is about to be thrown away without ever
		// running it. Dropping the flush with it reads as reactivity having stopped
		const replacement = manualScheduler();
		abandoned.restore();
		replacement.run();
		expect(seen).toEqual([0, 2]);

		replacement.restore();
		stop();
	});

	it('should keep its dependencies when a cleanup throws', () => {
		const errors: unknown[] = [];
		const previousHandler = setErrorHandler((err) => errors.push(err));
		const scheduler = manualScheduler();
		try {
			const s = new State(0);
			const seen: number[] = [];

			const stop = effect(() => {
				seen.push(s.get());
				return () => {
					throw new Error('cleanup bang');
				};
			});

			s.set(1);
			scheduler.run();
			expect(seen).toEqual([0, 1]);
			expect((errors[0] as Error).message).toBe('cleanup bang');

			// the throw must not escape before `fn()` has read anything -- the sweep
			// would drop every dependency and leave the effect alive, watched, and
			// deaf to the signal it was watching
			s.set(2);
			scheduler.run();
			expect(seen).toEqual([0, 1, 2]);

			// at dispose the caller asked, so the throw is theirs to see -- it is
			// only on a re-run, where nothing asked, that it has to be reported
			// instead of escaping
			expect(() => stop()).toThrow('cleanup bang');
		} finally {
			setErrorHandler(previousHandler);
			scheduler.restore();
		}
	});

	it('should run the cleanup of a body that disposed itself', () => {
		const events: string[] = [];
		const s = new State(0);

		let stop = () => {};
		stop = effect(() => {
			if (s.get() > 0) {
				stop();
			}
			return () => events.push('cleanup');
		});

		s.set(1);
		flush();

		// `dispose()` has already been and gone by the time the body returns, so
		// the cleanup it hands back belongs to a run nobody would ever tear down
		expect(events).toEqual(['cleanup', 'cleanup']);
	});

	it('should let flush be driven by hand', () => {
		const scheduler = manualScheduler();
		try {
			const s = new State(0);
			const seen: number[] = [];
			const stop = effect(() => {
				seen.push(s.get());
			});

			s.set(1);
			expect(seen).toEqual([0]);
			flush();
			expect(seen).toEqual([0, 1]);

			stop();
		} finally {
			scheduler.restore();
		}
	});
});

describe('createEffects', () => {
	it('should keep its scheduler and queue to itself', () => {
		const own = createEffects();
		const pending: (() => void)[] = [];
		own.setScheduler((fn) => pending.push(fn));

		const mine = new State(0);
		const theirs = new State(0);
		const mineSeen: number[] = [];
		const theirsSeen: number[] = [];

		const stopMine = own.effect(() => {
			mineSeen.push(mine.get());
		});
		const stopTheirs = effect(() => {
			theirsSeen.push(theirs.get());
		});

		mine.set(1);
		theirs.set(1);

		// the default scope is untouched by the other's scheduler
		flush();
		expect(theirsSeen).toEqual([0, 1]);
		expect(mineSeen).toEqual([0]);

		for (const fn of pending.splice(0)) {
			fn();
		}
		expect(mineSeen).toEqual([0, 1]);

		stopMine();
		stopTheirs();
	});

	it('should run a body once when a dropped source unwatches by throwing', async () => {
		const { unwatched } = await import('../../src/signals/index.js');
		const own = createEffects();
		const seen: unknown[] = [];
		own.setErrorHandler((err) => seen.push(err));
		own.setScheduler((fn) => fn());

		const dropped = new State(0, {
			[unwatched]: () => {
				throw new Error('bye');
			},
		});
		const flag = new State(true);
		const writes = new State(0);
		let runs = 0;

		const stop = own.effect(() => {
			runs++;
			if (flag.get()) {
				dropped.get();
			} else {
				writes.set(writes.get() + 1);
			}
		});
		expect(runs).toBe(1);

		// a failed sweep leaves a derivation dirty so the next read recomputes,
		// and a flush reads anything not clean as still pending -- so an effect
		// body marked the same way ran a second time in the same flush, and the
		// write it had already made was made again
		flag.set(false);
		expect((seen[0] as Error).message).toBe('bye');
		expect(runs).toBe(2);
		expect(writes.get()).toBe(1);

		stop();
	});

	it('should keep its error handler to itself', () => {
		const own = createEffects();
		own.setScheduler((fn) => fn());
		const seen: unknown[] = [];
		own.setErrorHandler((err) => seen.push(err));

		const s = new State(0);
		const stop = own.effect(() => {
			if (s.get() > 0) {
				throw new Error('mine');
			}
		});

		s.set(1);
		expect((seen[0] as Error).message).toBe('mine');

		stop();
	});
});
