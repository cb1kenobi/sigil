import {
	Computed,
	introspectSources,
	State,
	unwatched,
	Watcher,
	watched,
} from '../../src/signals/index.js';
import { describe, expect, it } from 'vitest';

/**
 * A second differential suite, aimed at what the first one's generator never
 * produces:
 *
 * - a computed whose dependency *set* changes between runs (a selector picks
 *   which of its candidates it reads), which is the dynamic-tracking path;
 * - a computed that throws for some inputs, with dependents that catch, which
 *   is the error-caching path and the error<->value version transitions;
 * - watchers that come and go, checked against two invariants that need no
 *   model of the graph's laziness at all: a node's `watched`/`unwatched`
 *   callbacks must say it is live exactly when a watcher reaches it through the
 *   graph's own reported edges, and after a write every watched computed that
 *   reads the written state through those edges must be pending.
 *
 * The naive side mirrors the same selector and throw rules with no caching.
 */

function rng(seed: number): () => number {
	let s = seed >>> 0;
	return () => {
		s ^= s << 13;
		s >>>= 0;
		s ^= s >>> 17;
		s ^= s << 5;
		s >>>= 0;
		return s / 0x1_0000_0000;
	};
}

type Mode = 'static' | 'select' | 'throw';

interface PlanNode {
	deps: number[];
	mode: Mode;
}

interface Plan {
	stateCount: number;
	/** Indexed by node index; states have no entry. */
	nodes: (PlanNode | undefined)[];
}

/** From-scratch value of node `i`; throws where the computed would. */
function evaluate(plan: Plan, states: number[], i: number): number {
	if (i < plan.stateCount) {
		return states[i];
	}
	const node = plan.nodes[i]!;
	const read = (j: number): number => {
		try {
			return evaluate(plan, states, j);
		} catch {
			return 1000 + j;
		}
	};
	let total = i;
	if (node.mode === 'select') {
		const k = read(node.deps[0]);
		total += k;
		for (let j = 1; j < node.deps.length; j++) {
			if ((k >> (j - 1)) & 1) {
				total += read(node.deps[j]);
			}
		}
	} else {
		for (const d of node.deps) {
			total += read(d);
		}
	}
	if (node.mode === 'throw' && total % 7 === 0) {
		throw new Error(`node ${i} refuses ${total}`);
	}
	return total % 97;
}

function settled<T>(fn: () => T): T | 'THREW' {
	try {
		return fn();
	} catch {
		return 'THREW';
	}
}

describe('the reactive graph with dynamic dependencies, errors and watchers', () => {
	const seeds = Array.from({ length: 40 }, (_, i) => i * 7919 + 1);

	for (const seed of seeds) {
		it(`should agree with a from-scratch evaluation and keep liveness balanced (seed ${seed})`, () => {
			const random = rng(seed);
			const stateCount = 5;
			const computedCount = 20;
			const watcherCount = 3;
			const plan: Plan = { stateCount, nodes: [] };

			const violations: string[] = [];
			const live: boolean[] = [];
			const states = Array.from({ length: stateCount }, (_, i) => i);
			const nodes: (State<number> | Computed<number>)[] = [];

			const callbacks = (i: number) => ({
				[watched]: () => {
					if (live[i]) violations.push(`watched fired twice for node ${i}`);
					live[i] = true;
				},
				[unwatched]: () => {
					if (!live[i]) violations.push(`unwatched fired for non-live node ${i}`);
					live[i] = false;
				},
			});

			for (let i = 0; i < stateCount; i++) {
				plan.nodes.push(undefined);
				live.push(false);
				nodes.push(new State(states[i], callbacks(i)));
			}

			for (let c = 0; c < computedCount; c++) {
				const i = stateCount + c;
				const available = nodes.length;
				const count = 1 + Math.floor(random() * Math.min(4, available));
				const deps: number[] = [];
				for (let d = 0; d < count; d++) {
					const pick = Math.floor(random() * available);
					if (!deps.includes(pick)) deps.push(pick);
				}
				const r = random();
				const mode: Mode = r < 0.4 ? 'static' : r < 0.8 ? 'select' : 'throw';
				const node: PlanNode = { deps, mode };
				plan.nodes.push(node);
				live.push(false);

				const read = (j: number): number => {
					try {
						return nodes[j].get();
					} catch {
						return 1000 + j;
					}
				};
				nodes.push(
					new Computed<number>(() => {
						let total = i;
						if (mode === 'select') {
							const k = read(deps[0]);
							total += k;
							for (let j = 1; j < deps.length; j++) {
								if ((k >> (j - 1)) & 1) {
									total += read(deps[j]);
								}
							}
						} else {
							for (const d of deps) {
								total += read(d);
							}
						}
						if (mode === 'throw' && total % 7 === 0) {
							throw new Error(`node ${i} refuses ${total}`);
						}
						return total % 97;
					}, callbacks(i))
				);
			}

			const watchers = Array.from({ length: watcherCount }, () => {
				const w = {
					armed: true,
					notices: 0,
					watching: new Set<number>(),
					watcher: undefined as unknown as Watcher,
				};
				w.watcher = new Watcher(() => {
					w.notices++;
					if (!w.armed) violations.push('notify fired on a disarmed watcher');
					w.armed = false;
				});
				return w;
			});

			const index = new Map(nodes.map((n, i) => [n as object, i]));

			/** Everything a watcher reaches through the edges the graph itself reports. */
			const reachableFromWatchers = (): Set<number> => {
				const seen = new Set<number>();
				const stack: number[] = [];
				for (const w of watchers) for (const i of w.watching) stack.push(i);
				while (stack.length) {
					const i = stack.pop()!;
					if (seen.has(i)) continue;
					seen.add(i);
					if (i >= stateCount) {
						for (const src of introspectSources(nodes[i] as Computed<number>)) {
							stack.push(index.get(src)!);
						}
					}
				}
				return seen;
			};

			/** Nodes that read `stateIndex`, directly or through current edges. */
			const dependentsOf = (stateIndex: number): Set<number> => {
				const out = new Set<number>([stateIndex]);
				let grew = true;
				while (grew) {
					grew = false;
					for (let i = stateCount; i < nodes.length; i++) {
						if (out.has(i)) continue;
						for (const src of introspectSources(nodes[i] as Computed<number>)) {
							if (out.has(index.get(src)!)) {
								out.add(i);
								grew = true;
								break;
							}
						}
					}
				}
				return out;
			};

			const pendingOf = (w: (typeof watchers)[number]) =>
				new Set(w.watcher.getPending().map((c) => index.get(c)!));

			const checkLiveness = (step: number, what: string) => {
				const reach = reachableFromWatchers();
				for (let i = 0; i < nodes.length; i++) {
					if (live[i] !== reach.has(i)) {
						violations.push(
							`step ${step} (${what}): node ${i} callbacks say live=${live[i]} but reachable=${reach.has(i)}`
						);
					}
				}
			};

			for (let step = 0; step < 400 && violations.length === 0; step++) {
				const r = random();
				let what: string;

				if (r < 0.35) {
					const which = Math.floor(random() * stateCount);
					const value = Math.floor(random() * 50);
					what = `set ${which}=${value}`;
					const changes = value !== states[which];
					const before = watchers.map(pendingOf);
					const deps = dependentsOf(which);
					const wasArmed = watchers.map((w) => w.armed);
					const noticesBefore = watchers.map((w) => w.notices);

					states[which] = value;
					(nodes[which] as State<number>).set(value);

					watchers.forEach((w, k) => {
						const after = pendingOf(w);
						const watchedDeps = [...w.watching].filter((i) => i >= stateCount && deps.has(i));
						for (const i of watchedDeps) {
							if (changes && !after.has(i)) {
								violations.push(
									`step ${step} (${what}): watched node ${i} reads state ${which} but is not pending`
								);
							}
						}
						for (const i of after) {
							if (!before[k].has(i) && !deps.has(i)) {
								violations.push(
									`step ${step} (${what}): node ${i} became pending without reading state ${which}`
								);
							}
						}
						const newlyPending = [...after].some((i) => !before[k].has(i));
						const watchesState = w.watching.has(which);
						const shouldNotify = changes && wasArmed[k] && (newlyPending || watchesState);
						const notified = w.notices - noticesBefore[k];
						if (shouldNotify && notified !== 1) {
							violations.push(
								`step ${step} (${what}): watcher ${k} should have been notified once, was ${notified}`
							);
						}
						if (!shouldNotify && notified !== 0) {
							violations.push(
								`step ${step} (${what}): watcher ${k} notified ${notified} times unexpectedly`
							);
						}
					});
				} else if (r < 0.65) {
					const which = Math.floor(random() * nodes.length);
					what = `get ${which}`;
					const actual = settled(() => nodes[which].get());
					const expected = settled(() => evaluate(plan, states, which));
					if (actual !== expected) {
						violations.push(`step ${step} (${what}): got ${actual}, expected ${expected}`);
					}
				} else if (r < 0.75) {
					const w = watchers[Math.floor(random() * watcherCount)];
					const which = Math.floor(random() * nodes.length);
					what = `watch ${which}`;
					w.watcher.watch(nodes[which]);
					w.watching.add(which);
					w.armed = true;
				} else if (r < 0.85) {
					const w = watchers[Math.floor(random() * watcherCount)];
					const list = [...w.watching];
					if (list.length === 0) continue;
					const which = list[Math.floor(random() * list.length)];
					what = `unwatch ${which}`;
					w.watcher.unwatch(nodes[which]);
					w.watching.delete(which);
				} else {
					what = 'drain';
					for (const w of watchers) {
						for (const c of w.watcher.getPending()) {
							const i = index.get(c)!;
							const actual = settled(() => c.get());
							const expected = settled(() => evaluate(plan, states, i));
							if (actual !== expected) {
								violations.push(`step ${step} (drain ${i}): got ${actual}, expected ${expected}`);
							}
						}
						w.watcher.watch();
						w.armed = true;
						if (w.watcher.getPending().length > 0) {
							violations.push(`step ${step} (drain): still pending after drain`);
						}
					}
				}

				checkLiveness(step, what);
			}

			expect(violations, `seed ${seed}`).toEqual([]);

			for (let i = 0; i < nodes.length; i++) {
				expect(
					settled(() => nodes[i].get()),
					`node ${i} at rest`
				).toBe(settled(() => evaluate(plan, states, i)));
			}
		});
	}
});
