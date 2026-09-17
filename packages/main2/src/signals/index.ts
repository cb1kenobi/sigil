/**
 * Signals: the reactive core the component runtime is built on.
 *
 * Shaped like the TC39 Signals proposal (stage 1), not invented here. See
 * `graph.ts` for why, and for what each piece does.
 *
 * ```js
 * import { Signal, effect } from 'main2/signals';
 *
 * const count = new Signal.State(0);
 * const doubled = new Signal.Computed(() => count.get() * 2);
 *
 * const stop = effect(() => console.log(doubled.get()));  // logs 0
 * count.set(21);                                          // logs 42, next microtask
 * stop();
 * ```
 */

import {
	Computed,
	currentComputed,
	hasSinks,
	hasSources,
	introspectSinks,
	introspectSources,
	sinkCount,
	type SignalOptions,
	State,
	untrack,
	unwatched,
	Watcher,
	watched,
} from './graph.js';

export {
	Computed,
	currentComputed,
	hasSinks,
	hasSources,
	introspectSinks,
	introspectSources,
	sinkCount,
	type SignalOptions,
	State,
	untrack,
	unwatched,
	Watcher,
	watched,
};
export {
	createEffects,
	effect,
	type EffectErrorHandler,
	type Effects,
	type Flush,
	flush,
	type Scheduler,
	setErrorHandler,
	setScheduler,
} from './effect.js';

/**
 * The parts of the API the proposal marks as sharp: introspection, the manual
 * watcher, and the escape hatch out of tracking. Reaching for one is a signal
 * in itself -- ordinary code uses `State`, `Computed`, and `effect()`.
 */
export interface SignalSubtle {
	currentComputed: typeof currentComputed;
	hasSinks: typeof hasSinks;
	hasSources: typeof hasSources;
	introspectSinks: typeof introspectSinks;
	introspectSources: typeof introspectSources;
	untrack: typeof untrack;
	unwatched: typeof unwatched;
	Watcher: typeof Watcher;
	watched: typeof watched;
}

export interface SignalNamespace {
	Computed: typeof Computed;
	State: typeof State;
	subtle: SignalSubtle;
}

/**
 * The namespace object, so that code reads the way the proposal's examples do
 * and so that switching to the native `Signal` is an import change.
 */
export const Signal: SignalNamespace = {
	Computed,
	State,
	subtle: {
		currentComputed,
		hasSinks,
		hasSources,
		introspectSinks,
		introspectSources,
		untrack,
		unwatched,
		Watcher,
		watched,
	},
};
