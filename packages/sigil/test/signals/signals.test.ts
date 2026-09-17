import {
	Computed,
	currentComputed,
	hasSinks,
	hasSources,
	introspectSinks,
	introspectSources,
	Signal,
	sinkCount,
	State,
	untrack,
	unwatched,
	Watcher,
	watched,
} from '../../src/signals/index.js';
import { describe, expect, it } from 'vitest';

describe('Signal.State', () => {
	it('should hold and hand back a value', () => {
		const s = new State(1);
		expect(s.get()).toBe(1);
		s.set(2);
		expect(s.get()).toBe(2);
	});

	it('should treat a write of an equal value as no write', () => {
		const s = new State(1);
		let runs = 0;
		const c = new Computed(() => {
			runs++;
			return s.get();
		});

		expect(c.get()).toBe(1);
		expect(runs).toBe(1);

		s.set(1);
		expect(c.get()).toBe(1);
		expect(runs).toBe(1);
	});

	it('should compare with Object.is by default, so NaN is not a change', () => {
		const s = new State(Number.NaN);
		let runs = 0;
		const c = new Computed(() => {
			runs++;
			return s.get();
		});

		c.get();
		s.set(Number.NaN);
		c.get();
		expect(runs).toBe(1);
	});

	it('should distinguish 0 from -0, which Object.is does and === does not', () => {
		const s = new State(0);
		let runs = 0;
		const c = new Computed(() => {
			runs++;
			return s.get();
		});

		c.get();
		s.set(-0);
		c.get();
		expect(runs).toBe(2);
	});

	it('should honor a custom equals', () => {
		const s = new State({ id: 1, label: 'a' }, { equals: (a, b) => a.id === b.id });
		let runs = 0;
		const c = new Computed(() => {
			runs++;
			return s.get().label;
		});

		expect(c.get()).toBe('a');
		s.set({ id: 1, label: 'b' });
		expect(c.get()).toBe('a');
		expect(runs).toBe(1);

		s.set({ id: 2, label: 'c' });
		expect(c.get()).toBe('c');
		expect(runs).toBe(2);
	});
});

describe('Signal.Computed', () => {
	it('should not run until it is read', () => {
		let runs = 0;
		const c = new Computed(() => {
			runs++;
			return 1;
		});

		expect(runs).toBe(0);
		c.get();
		expect(runs).toBe(1);
	});

	it('should not run again while nothing it read has changed', () => {
		const s = new State(1);
		let runs = 0;
		const c = new Computed(() => {
			runs++;
			return s.get() * 2;
		});

		expect(c.get()).toBe(2);
		expect(c.get()).toBe(2);
		expect(runs).toBe(1);
	});

	it('should track dynamically, dropping a branch it stopped reading', () => {
		const useLeft = new State(true);
		const left = new State('L');
		const right = new State('R');

		let runs = 0;
		const c = new Computed(() => {
			runs++;
			return useLeft.get() ? left.get() : right.get();
		});

		expect(c.get()).toBe('L');
		expect(runs).toBe(1);

		// not read on the last run, so it is not a dependency
		right.set('R2');
		expect(c.get()).toBe('L');
		expect(runs).toBe(1);

		useLeft.set(false);
		expect(c.get()).toBe('R2');
		expect(runs).toBe(2);

		// now the other way round
		left.set('L2');
		expect(c.get()).toBe('R2');
		expect(runs).toBe(2);
	});

	it('should stay glitch-free across a diamond and run once', () => {
		const a = new State(0);
		let bRuns = 0;
		let cRuns = 0;
		let dRuns = 0;

		const b = new Computed(() => {
			bRuns++;
			return a.get() + 1;
		});
		const c = new Computed(() => {
			cRuns++;
			return a.get() + 10;
		});
		const d = new Computed(() => {
			dRuns++;
			return `${b.get()}:${c.get()}`;
		});

		expect(d.get()).toBe('1:10');
		expect([bRuns, cRuns, dRuns]).toEqual([1, 1, 1]);

		a.set(1);
		expect(d.get()).toBe('2:11');
		expect([bRuns, cRuns, dRuns]).toEqual([2, 2, 2]);
	});

	it('should not re-run a dependent when its own value did not change', () => {
		const n = new State(0);
		let parityRuns = 0;
		let labelRuns = 0;

		const parity = new Computed(() => {
			parityRuns++;
			return n.get() % 2 === 0;
		});
		const label = new Computed(() => {
			labelRuns++;
			return parity.get() ? 'even' : 'odd';
		});

		expect(label.get()).toBe('even');
		expect([parityRuns, labelRuns]).toEqual([1, 1]);

		// the state changed and parity recomputed, but it landed on the same value
		n.set(2);
		expect(label.get()).toBe('even');
		expect(parityRuns).toBe(2);
		expect(labelRuns).toBe(1);

		n.set(3);
		expect(label.get()).toBe('odd');
		expect([parityRuns, labelRuns]).toEqual([3, 2]);
	});

	it('should cache a thrown error and rethrow it without re-running', () => {
		const s = new State(0);
		let runs = 0;
		const c = new Computed(() => {
			runs++;
			if (s.get() === 0) {
				throw new Error('nope');
			}
			return s.get();
		});

		expect(() => c.get()).toThrow('nope');
		expect(() => c.get()).toThrow('nope');
		expect(runs).toBe(1);

		s.set(1);
		expect(c.get()).toBe(1);
		expect(runs).toBe(2);
	});

	it('should propagate recovery from an error to its dependents', () => {
		const s = new State(0);
		const c = new Computed(() => {
			if (s.get() === 0) {
				throw new Error('nope');
			}
			return s.get();
		});
		const d = new Computed(() => {
			try {
				return `ok:${c.get()}`;
			} catch {
				return 'failed';
			}
		});

		expect(d.get()).toBe('failed');
		s.set(5);
		expect(d.get()).toBe('ok:5');
	});

	it('should refuse to read itself', () => {
		const c: Computed<number> = new Computed(() => c.get() + 1);
		expect(() => c.get()).toThrow(/may not read itself/);
	});

	it('should refuse to write a signal', () => {
		const s = new State(0);
		const c = new Computed(() => {
			s.set(1);
			return 1;
		});
		expect(() => c.get()).toThrow(/may not write/);
	});

	it('should leave a failed write without effect on the state', () => {
		const s = new State(0);
		const c = new Computed(() => {
			s.set(99);
			return 1;
		});
		expect(() => c.get()).toThrow();
		expect(s.get()).toBe(0);
	});

	it('should recover its tracking context after throwing', () => {
		const s = new State(1);
		const bad = new Computed(() => {
			throw new Error('bang');
		});
		const good = new Computed(() => {
			try {
				bad.get();
			} catch {
				/* swallowed on purpose */
			}
			return s.get();
		});

		expect(good.get()).toBe(1);
		// the dependency on `s` survived the inner throw
		s.set(2);
		expect(good.get()).toBe(2);
	});
});

describe('Signal.subtle.untrack', () => {
	it('should not record what it reads', () => {
		const tracked = new State(1);
		const hidden = new State(10);
		let runs = 0;

		const c = new Computed(() => {
			runs++;
			return tracked.get() + untrack(() => hidden.get());
		});

		expect(c.get()).toBe(11);
		hidden.set(20);
		expect(c.get()).toBe(11);
		expect(runs).toBe(1);

		tracked.set(2);
		expect(c.get()).toBe(22);
	});

	it('should restore tracking afterwards', () => {
		const a = new State(1);
		const b = new State(2);
		const c = new Computed(() => {
			untrack(() => a.get());
			return b.get();
		});

		expect(c.get()).toBe(2);
		b.set(3);
		expect(c.get()).toBe(3);
	});
});

describe('Signal.subtle.currentComputed', () => {
	it('should be the computed being evaluated, and undefined outside one', () => {
		expect(currentComputed()).toBeUndefined();

		let seen: unknown;
		const c = new Computed(() => {
			seen = currentComputed();
			return 1;
		});
		c.get();

		expect(seen).toBe(c);
		expect(currentComputed()).toBeUndefined();
	});

	it('should be undefined inside untrack', () => {
		let seen: unknown = 'unset';
		const c = new Computed(() => {
			untrack(() => {
				seen = currentComputed();
			});
			return 1;
		});
		c.get();
		expect(seen).toBeUndefined();
	});
});

describe('Signal.subtle.Watcher', () => {
	it('should notify when a watched computed goes stale', () => {
		const s = new State(0);
		const c = new Computed(() => s.get() * 2);
		let notices = 0;

		const w = new Watcher(() => notices++);
		w.watch(c);
		c.get();

		s.set(1);
		expect(notices).toBe(1);
	});

	it('should notify at most once until it is re-armed', () => {
		const s = new State(0);
		const c = new Computed(() => s.get() * 2);
		let notices = 0;

		const w = new Watcher(() => notices++);
		w.watch(c);
		c.get();

		s.set(1);
		s.set(2);
		s.set(3);
		expect(notices).toBe(1);

		// drain and re-arm, the way a scheduler does
		for (const pending of w.getPending()) {
			pending.get();
		}
		w.watch();

		s.set(4);
		expect(notices).toBe(2);
	});

	it('should report pending computeds and nothing else', () => {
		const s = new State(0);
		const c = new Computed(() => s.get() * 2);
		const w = new Watcher(() => {});

		w.watch(s, c);
		c.get();
		expect(w.getPending()).toEqual([]);

		s.set(1);
		// a state is never pending: it has no computation to be behind on
		expect(w.getPending()).toEqual([c]);
	});

	it('should stop notifying once unwatched', () => {
		const s = new State(0);
		const c = new Computed(() => s.get() * 2);
		let notices = 0;

		const w = new Watcher(() => notices++);
		w.watch(c);
		c.get();
		w.unwatch(c);

		s.set(1);
		expect(notices).toBe(0);
	});

	it('should refuse to read or write signals inside notify', () => {
		const s = new State(0);
		const c = new Computed(() => s.get() * 2);

		let readError: unknown;
		const reader = new Watcher(() => {
			try {
				s.get();
			} catch (err) {
				readError = err;
			}
		});
		reader.watch(c);
		c.get();
		s.set(1);
		expect((readError as Error).message).toMatch(/may not read signals/);

		let writeError: unknown;
		const s2 = new State(0);
		const c2 = new Computed(() => s2.get() * 2);
		const writer = new Watcher(() => {
			try {
				s2.set(9);
			} catch (err) {
				writeError = err;
			}
		});
		writer.watch(c2);
		c2.get();
		s2.set(1);
		expect((writeError as Error).message).toMatch(/may not write signals/);
	});

	it('should be idempotent about watching the same signal twice', () => {
		const s = new State(0);
		const w = new Watcher(() => {});
		w.watch(s);
		w.watch(s);
		expect(introspectSources(w)).toEqual([s]);

		w.unwatch(s);
		expect(introspectSources(w)).toEqual([]);
	});
});

describe('watched and unwatched', () => {
	it('should fire when a state becomes live and when it stops being', () => {
		const events: string[] = [];
		const s = new State(0, {
			[watched]: () => events.push('watched'),
			[unwatched]: () => events.push('unwatched'),
		});

		const w = new Watcher(() => {});
		expect(events).toEqual([]);

		w.watch(s);
		expect(events).toEqual(['watched']);

		w.unwatch(s);
		expect(events).toEqual(['watched', 'unwatched']);
	});

	it('should not count a read by an unwatched computed as being watched', () => {
		const events: string[] = [];
		const s = new State(0, {
			[watched]: () => events.push('watched'),
			[unwatched]: () => events.push('unwatched'),
		});

		// read, but by nothing a watcher can reach -- being read is not being
		// observed, and that distinction is the whole point of these callbacks
		const c = new Computed(() => s.get());
		c.get();
		expect(events).toEqual([]);
	});

	it('should reach through a computed to what it reads', () => {
		const events: string[] = [];
		const s = new State(0, {
			[watched]: () => events.push('watched'),
			[unwatched]: () => events.push('unwatched'),
		});
		const c = new Computed(() => s.get() * 2);
		c.get();

		const w = new Watcher(() => {});
		w.watch(c);
		expect(events).toEqual(['watched']);

		w.unwatch(c);
		expect(events).toEqual(['watched', 'unwatched']);
	});

	it('should fire once for two watchers and only on the last unwatch', () => {
		const events: string[] = [];
		const s = new State(0, {
			[watched]: () => events.push('watched'),
			[unwatched]: () => events.push('unwatched'),
		});

		const a = new Watcher(() => {});
		const b = new Watcher(() => {});
		a.watch(s);
		b.watch(s);
		expect(events).toEqual(['watched']);

		a.unwatch(s);
		expect(events).toEqual(['watched']);

		b.unwatch(s);
		expect(events).toEqual(['watched', 'unwatched']);
	});

	it('should not churn for a dependency kept across a recompute', () => {
		const events: string[] = [];
		const kept = new State(1, {
			[watched]: () => events.push('watched'),
			[unwatched]: () => events.push('unwatched'),
		});
		const trigger = new State(0);

		const c = new Computed(() => kept.get() + trigger.get());
		const w = new Watcher(() => {});
		w.watch(c);
		c.get();
		expect(events).toEqual(['watched']);

		trigger.set(1);
		c.get();
		// `kept` was read before and after, so it never stopped being observed
		expect(events).toEqual(['watched']);
	});

	it('should release a dependency a recompute dropped', () => {
		const events: string[] = [];
		const right = new State('R', {
			[watched]: () => events.push('watched'),
			[unwatched]: () => events.push('unwatched'),
		});
		const useRight = new State(true);

		const c = new Computed(() => (useRight.get() ? right.get() : 'none'));
		const w = new Watcher(() => {});
		w.watch(c);
		c.get();
		expect(events).toEqual(['watched']);

		useRight.set(false);
		c.get();
		expect(events).toEqual(['watched', 'unwatched']);
	});
});

describe('a watcher that throws', () => {
	it('should not stop the rest of the graph being told', () => {
		const s = new State(0);
		const c = new Computed(() => s.get() * 2);

		const bad = new Watcher(() => {
			throw new Error('bang');
		});
		bad.watch(s);
		c.get();

		const good = new Watcher(() => {});
		good.watch(c);

		// the throw reaches the writer, but only after every sink has been marked.
		// Aborting the walk would leave `c` serving a value from before the write,
		// with nothing to un-stale it until something else touched `s`
		expect(() => s.set(5)).toThrow('bang');
		expect(c.get()).toBe(10);
	});

	it('should collect more than one into an AggregateError', () => {
		const s = new State(0);
		const a = new Watcher(() => {
			throw new Error('first');
		});
		const b = new Watcher(() => {
			throw new Error('second');
		});
		a.watch(s);
		b.watch(s);

		let thrown: unknown;
		try {
			s.set(1);
		} catch (err) {
			thrown = err;
		}

		expect(thrown).toBeInstanceOf(AggregateError);
		expect((thrown as AggregateError).errors.map((e: Error) => e.message)).toEqual([
			'first',
			'second',
		]);
	});
});

describe('watched and unwatched callbacks', () => {
	it('should not be allowed to touch the graph', () => {
		const other = new State(1);
		let readError: unknown;

		const s = new State(0, {
			[watched]: () => {
				try {
					other.get();
				} catch (err) {
					readError = err;
				}
			},
		});

		new Watcher(() => {}).watch(s);

		// these fire from inside the liveness walk, which is a graph mutation in
		// flight -- the same hazard the ban on `notify` exists for
		expect((readError as Error).message).toMatch(/may not read signals/);
	});

	it('should not be allowed to write from unwatched', () => {
		const other = new State(1);
		let writeError: unknown;

		const s = new State(0, {
			[unwatched]: () => {
				try {
					other.set(9);
				} catch (err) {
					writeError = err;
				}
			},
		});

		const w = new Watcher(() => {});
		w.watch(s);
		w.unwatch(s);

		expect((writeError as Error).message).toMatch(/may not write signals/);
		expect(other.get()).toBe(1);
	});
});

describe('liveness while a computed is evaluating', () => {
	it('should not strand a source dropped in the run that gained a watcher', () => {
		const events: string[] = [];
		const dropped = new State('d', {
			[watched]: () => events.push('watched'),
			[unwatched]: () => events.push('unwatched'),
		});
		const keep = new State('k');
		const useDropped = new State(true);

		const c = new Computed(() => (useDropped.get() ? dropped.get() : keep.get()));
		const w = new Watcher(() => {});
		w.watch(c);
		c.get();
		expect(events).toEqual(['watched']);

		useDropped.set(false);
		c.get();
		expect(events).toEqual(['watched', 'unwatched']);

		// the count has to be back at zero, not below it: a second watcher must
		// still be able to make it live again
		const w2 = new Watcher(() => {});
		w2.watch(dropped);
		expect(events).toEqual(['watched', 'unwatched', 'watched']);

		w.unwatch(c);
		w2.unwatch(dropped);
		expect(events).toEqual(['watched', 'unwatched', 'watched', 'unwatched']);
	});

	it('should keep the count right when a watched callback throws', () => {
		const source = new State(1);
		const c = new Computed(() => source.get(), {
			[watched]: () => {
				throw new Error('subscribe failed');
			},
		});
		c.get();

		const w = new Watcher(() => {});
		expect(() => w.watch(c)).toThrow('subscribe failed');

		// the walk happens before the callback, so the counts are consistent even
		// though the callback failed -- the alternative strands every source one
		// short and no later watcher can ever make them live
		expect(hasSinks(source)).toBe(true);
		w.unwatch(c);
		expect(hasSinks(source)).toBe(false);
	});
});

describe('re-arming a watcher', () => {
	it('should notice what went stale while it was disarmed', () => {
		const s = new State(0);
		const c = new Computed(() => s.get() * 2);
		let notices = 0;

		const w = new Watcher(() => notices++);
		w.watch(c);
		c.get();

		s.set(1);
		expect(notices).toBe(1);

		// re-armed without draining, so `c` is still dirty. A write only announces
		// a node going from clean to dirty, and propagation stops at one already
		// dirty -- so without a check here the next write walks into `c`, finds it
		// dirty, stops, and this watcher waits forever
		w.watch();
		expect(notices).toBe(2);

		expect(w.getPending()).toEqual([c]);
	});

	it('should not announce a computed that has simply never run', () => {
		let notices = 0;
		const s = new State(0);
		const c = new Computed(() => s.get());

		const w = new Watcher(() => notices++);
		// a computed is dirty from the moment it is constructed, and being watched
		// is not a change
		w.watch(c);
		expect(notices).toBe(0);
	});
});

describe('introspection', () => {
	it('should report sources', () => {
		const s = new State(1);
		const c = new Computed(() => s.get());

		expect(hasSources(c)).toBe(false);
		c.get();
		expect(introspectSources(c)).toEqual([s]);
		expect(hasSources(c)).toBe(true);
	});

	it('should report sinks by liveness rather than by readership', () => {
		const s = new State(1);
		const c = new Computed(() => s.get());
		c.get();

		// `c` read `s`, but nothing watches `c`, so nothing is listening through
		// it. The proposal is specific that this is what "has sinks" means, and it
		// is the same distinction `watched`/`unwatched` draw
		expect(hasSinks(s)).toBe(false);
		expect(introspectSinks(s)).toEqual([]);

		// the edge is still there, which is why disposal has to be explicit
		expect(sinkCount(s)).toBe(1);

		const w = new Watcher(() => {});
		w.watch(c);

		expect(hasSinks(s)).toBe(true);
		expect(introspectSinks(s)).toEqual([c]);

		w.unwatch(c);
		expect(hasSinks(s)).toBe(false);
	});

	it('should report a watcher as a sink', () => {
		const s = new State(1);
		const w = new Watcher(() => {});
		w.watch(s);
		expect(introspectSinks(s)).toEqual([w]);
	});
});

describe('the Signal namespace', () => {
	it('should expose the proposal shape', () => {
		expect(Signal.State).toBe(State);
		expect(Signal.Computed).toBe(Computed);
		expect(Signal.subtle.Watcher).toBe(Watcher);
		expect(Signal.subtle.untrack).toBe(untrack);
		expect(Signal.subtle.watched).toBe(watched);
		expect(Signal.subtle.unwatched).toBe(unwatched);
	});

	it('should work when written the way the proposal writes it', () => {
		const counter = new Signal.State(0);
		const isEven = new Signal.Computed(() => (counter.get() & 1) === 0);
		const parity = new Signal.Computed(() => (isEven.get() ? 'even' : 'odd'));

		expect(parity.get()).toBe('even');
		counter.set(1);
		expect(parity.get()).toBe('odd');
	});
});
