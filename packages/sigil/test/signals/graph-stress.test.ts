import { Computed, State } from '../../src/signals/index.js';
import { describe, expect, it } from 'vitest';

/**
 * A graph written by hand is checked against the cases somebody thought of. A
 * graph checked against a naive evaluator is checked against every case the
 * generator produces, which is the only way to have any confidence in caching
 * and invalidation written from scratch.
 *
 * The naive side recomputes everything from the states on every read. The real
 * side caches aggressively. Any disagreement is a bug in the caching, which is
 * the entire risk this module carries.
 */

/** A seeded generator, so a failure names a seed that reproduces it. */
function rng(seed: number): () => number {
	let s = seed >>> 0;
	return () => {
		// xorshift32
		s ^= s << 13;
		s >>>= 0;
		s ^= s >>> 17;
		s ^= s << 5;
		s >>>= 0;
		return s / 0x1_0000_0000;
	};
}

interface Plan {
	/** For each computed, the node indices it reads. */
	deps: number[][];
	stateCount: number;
}

/** The value of node `i` computed from scratch, with no caching anywhere. */
function evaluate(plan: Plan, states: number[], index: number): number {
	if (index < plan.stateCount) {
		return states[index];
	}
	const deps = plan.deps[index - plan.stateCount];
	let total = index;
	for (const dep of deps) {
		total += evaluate(plan, states, dep);
	}
	// a small modulus on purpose. The interesting path is a CHECK node whose
	// sources all recompute to the values it already saw, so it resolves back to
	// CLEAN without running -- and that needs collisions to be common. At mod 97
	// it never happened once across every seed; the arithmetic has to be lossy
	// enough to collide for the fuzzer to reach the code it exists to test
	return total % 5;
}

describe('the reactive graph, against a naive evaluator', () => {
	for (const seed of [1, 2, 3, 12345, 987654321]) {
		it(`should agree with a from-scratch evaluation (seed ${seed})`, () => {
			const random = rng(seed);
			const stateCount = 4;
			const computedCount = 12;
			const plan: Plan = { deps: [], stateCount };

			const states = Array.from({ length: stateCount }, (_, i) => i);
			const stateSignals = states.map((v) => new State(v));
			const nodes: (State<number> | Computed<number>)[] = [...stateSignals];

			// how often a node that was told "maybe" asked its sources and was told
			// "no" -- the short-circuit that makes the graph glitch-free, and the
			// single most load-bearing branch in it. A fuzzer that never reaches it
			// is not testing what its name says
			let shortCircuits = 0;
			let bodyRuns = 0;

			// Each computed reads only earlier nodes, which keeps it a DAG, and picks
			// them from a sliding window rather than uniformly. Uniform picks build
			// a wide, shallow graph where most computeds read a state directly --
			// and a node that reads a state directly is marked DIRTY by a write, not
			// CHECK, so it never takes the short-circuit. Depth is what creates a
			// CHECK node with an intermediate above it that can absorb the change.
			const WINDOW = 4;
			for (let c = 0; c < computedCount; c++) {
				const available = nodes.length;
				const lowest = Math.max(0, available - WINDOW);
				const span = available - lowest;
				const count = 1 + Math.floor(random() * Math.min(3, span));
				const deps: number[] = [];
				for (let d = 0; d < count; d++) {
					const pick = lowest + Math.floor(random() * span);
					if (!deps.includes(pick)) {
						deps.push(pick);
					}
				}
				plan.deps.push(deps);

				const index = stateCount + c;
				nodes.push(
					new Computed(() => {
						bodyRuns++;
						let total = index;
						for (const dep of deps) {
							total += nodes[dep].get();
						}
						return total % 5;
					})
				);
			}

			for (let step = 0; step < 300; step++) {
				if (random() < 0.4) {
					const which = Math.floor(random() * stateCount);
					const value = Math.floor(random() * 50);
					states[which] = value;
					stateSignals[which].set(value);
				} else {
					const which = Math.floor(random() * nodes.length);
					const node = nodes[which];
					const before = node instanceof Computed ? (node as any).state : undefined;
					const runsBefore = bodyRuns;

					expect(node.get(), `node ${which} at step ${step}`).toBe(evaluate(plan, states, which));

					// told "maybe", asked, and settled without running
					if (before === 1 && bodyRuns === runsBefore) {
						shortCircuits++;
					}
				}
			}

			// and everything agrees once the dust settles
			for (let i = 0; i < nodes.length; i++) {
				expect(nodes[i].get(), `node ${i} at rest`).toBe(evaluate(plan, states, i));
			}

			// the assertion that keeps this suite honest. Measured at mod 97 this
			// was zero on every seed: the graph agreed with the evaluator without
			// the interesting branch ever being taken
			expect(shortCircuits, 'never reached the CHECK -> CLEAN path').toBeGreaterThan(0);
		});
	}

	it('should never run a computed twice for one settled read', () => {
		const a = new State(1);
		const b = new State(2);
		const runs = new Map<string, number>();

		const count = (name: string) => runs.set(name, (runs.get(name) ?? 0) + 1);

		// a wide diamond: many paths from the states to the top
		const l1 = new Computed(() => {
			count('l1');
			return a.get() + b.get();
		});
		const l2 = new Computed(() => {
			count('l2');
			return a.get() - b.get();
		});
		const l3 = new Computed(() => {
			count('l3');
			return l1.get() * 2;
		});
		const l4 = new Computed(() => {
			count('l4');
			return l1.get() + l2.get();
		});
		const top = new Computed(() => {
			count('top');
			return l3.get() + l4.get();
		});

		top.get();
		expect([...runs.values()].every((n) => n === 1)).toBe(true);

		runs.clear();
		a.set(10);
		top.get();
		// one write, one run each -- a node reachable by two paths must not run twice
		expect(Object.fromEntries(runs)).toEqual({ l1: 1, l2: 1, l3: 1, l4: 1, top: 1 });
	});

	it('should not recompute an unread branch when a shared source changes', () => {
		const shared = new State(0);
		let coldRuns = 0;

		const hot = new Computed(() => shared.get() + 1);
		const cold = new Computed(() => {
			coldRuns++;
			return shared.get() + 2;
		});

		expect(hot.get()).toBe(1);
		expect(coldRuns).toBe(0);

		shared.set(5);
		expect(hot.get()).toBe(6);

		// laziness is the whole reason a CLI can afford this: a computed nobody
		// reads never runs, however often its inputs change
		expect(coldRuns).toBe(0);
		expect(cold.get()).toBe(7);
		expect(coldRuns).toBe(1);
	});
});
