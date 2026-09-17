import { Computed, effectBody, outsideNotify, untrack, Watcher } from './graph.js';

/**
 * Runs the queued work. A scheduler decides *when* to call this.
 */
export type Flush = () => void;

/**
 * Asks for `flush` to be called later. Called only on the transition from
 * nothing-queued to something-queued, so a burst of writes asks once.
 *
 * A scheduler may run `flush` synchronously. That is what a frame loop driving
 * its own timing does, and what a test does to assert on exact ordering.
 */
export type Scheduler = (flush: Flush) => void;

/** Reports an error an effect threw. See `setErrorHandler()`. */
export type EffectErrorHandler = (error: unknown) => void;

/**
 * The set an effect created during another effect's body is added to, so that
 * the outer one can dispose them.
 */
type Owner = Set<() => void>;

let currentOwner: Owner | undefined;

/**
 * Whatever a callback returned, if it is a cleanup.
 *
 * An `async` body returns a promise, and storing that as the cleanup means the
 * *next* run calls it and fails with "previous is not a function" -- one run
 * later than the mistake and nowhere near it. An effect cannot be async anyway:
 * tracking stops at the first `await`, because by then the body has returned
 * and something else is evaluating.
 *
 * @param result - What the effect body returned.
 * @returns The cleanup, if there is one.
 */
function asCleanup(result: unknown): (() => void) | undefined {
	if (typeof result === 'function') {
		return result as () => void;
	}

	if (
		result !== null &&
		typeof result === 'object' &&
		typeof (result as { then?: unknown }).then === 'function'
	) {
		throw new TypeError(
			'An effect may not be async: tracking stops at the first await, so nothing read after it is a dependency'
		);
	}

	// anything else is ignored rather than refused. `effect(() => count.set(n.get()))`
	// is how this reads at its best, and a concise arrow body returns whatever the
	// last call did -- refusing that would tax the good spelling to catch nothing.
	// A promise is different: it is the one return value that causes a failure
	// somewhere else, one run later
	return undefined;
}

/**
 * An independent set of effects: its own watcher, its own scheduler, its own
 * queue.
 *
 * Independent because the alternative is one global, and a global scheduler is
 * a trap the moment there is more than one thing driving frames -- two canvases
 * with different loops, a library using main2 inside a host that also does, or
 * simply two tests in one file where the first leaves a scheduler that never
 * ran and the second is dead before it starts.
 */
export interface Effects {
	/**
	 * Runs `fn` now, and again whenever a signal it read has changed.
	 *
	 * @param fn - What to run. May return a cleanup.
	 * @returns Disposes the effect, running any pending cleanup.
	 */
	effect(fn: () => void | (() => void)): () => void;
	/** Runs every effect that has gone stale, now. */
	flush(): void;
	/**
	 * Replaces where an error thrown by an effect goes.
	 *
	 * @param next - The handler, or `undefined` for the default.
	 * @returns The handler that was in place.
	 */
	setErrorHandler(next: EffectErrorHandler | undefined): EffectErrorHandler;
	/**
	 * Replaces the scheduler that decides when pending effects run.
	 *
	 * @param next - The scheduler, or `undefined` for the microtask default.
	 * @returns The scheduler that was in place.
	 */
	setScheduler(next: Scheduler | undefined): Scheduler;
}

/**
 * The default: a microtask, so a synchronous run of writes settles into one
 * pass before anything else observes the result.
 *
 * The renderer replaces this with the frame loop, which is the point of the
 * seam -- a terminal cannot absorb a repaint per microtask.
 */
const microtask: Scheduler = (fn) => queueMicrotask(fn);

/**
 * The default error report: the message, never a stack, and a non-zero exit
 * code.
 *
 * The alternative is rethrowing, and under the microtask scheduler a rethrow
 * lands in a microtask nobody is catching -- Node prints a raw stack and kills
 * the process, bypassing `main2()`'s error handling, the `beforeError` hooks,
 * and any chance of putting the terminal back. This module cannot import the
 * error handler without inverting the layering, so it does the same thing by
 * hand and lets the renderer replace it with the real one.
 *
 * @param error - What the effect threw.
 */
const report: EffectErrorHandler = (error) => {
	const message = error instanceof Error ? error.message : String(error);
	process.stderr.write(`Error in effect: ${message}\n`);
	process.exitCode ||= 1;
};

/**
 * How many times a flush will drain before giving up.
 *
 * An effect may write, so a flush can dirty effects that have already run and
 * has to go round again. A cycle -- two effects each writing what the other
 * reads -- would otherwise spin forever with no clue as to which two.
 */
const MAX_PASSES = 100;

/**
 * Builds an independent set of effects.
 *
 * @returns The effect scope.
 */
export function createEffects(): Effects {
	let scheduler: Scheduler = microtask;
	let errorHandler: EffectErrorHandler = report;
	let queued = false;
	let flushing = false;

	const watcher = new Watcher(() => {
		if (!queued) {
			queued = true;
			scheduler(flush);
		}
	});

	function flush(): void {
		queued = false;

		if (flushing) {
			// re-entered from inside an effect. The pass already running will see
			// whatever this one would have, because it drains until quiet
			return;
		}

		flushing = true;
		try {
			// a scheduler may run this synchronously from inside the watcher's notify
			// callback. The callback may not touch the graph; the work it scheduled
			// may, and this is the line between them
			outsideNotify(() => drain());
		} finally {
			flushing = false;
			watcher.watch();
		}
	}

	/** Runs pending effects until nothing is left dirty. */
	function drain(): void {
		for (let pass = 0; pass < MAX_PASSES; pass++) {
			// re-armed *before* draining, so a write made by an effect during
			// this pass still schedules the next one
			watcher.watch();
			const pending = watcher.getPending();
			if (pending.length === 0) {
				return;
			}
			for (const computed of pending) {
				try {
					computed.get();
				} catch (err) {
					errorHandler(err);
				}
			}
		}
		errorHandler(
			new Error(
				`Effects did not settle after ${MAX_PASSES} passes, which usually means two of them write what the other reads`
			)
		);
	}

	function effect(fn: () => void | (() => void)): () => void {
		let cleanup: (() => void) | undefined;
		let disposed = false;

		// effects created while this one's body runs belong to it, and die when it
		// re-runs or is disposed. Without this a component that creates an effect
		// inside an effect leaks one per run, and nothing above can see them to
		// clean them up
		const children: Owner = new Set();
		const parent = currentOwner;

		/**
		 * Disposes the children and runs the pending cleanup.
		 *
		 * `report` says where a throw goes. On a re-run it is the error handler,
		 * because the alternative is letting the throw escape the effect body
		 * before `fn()` has read anything -- which makes the sweep drop every
		 * dependency the effect had, leaving it alive, watched, and deaf to the
		 * signals it was watching. A cleanup failing should not silently unsubscribe
		 * the effect from the world.
		 *
		 * @param report - Where to send a throw, or omitted to let it out.
		 */
		const runCleanups = (report?: (error: unknown) => void): void => {
			// a copy, because disposing a child removes it from `children`
			// eslint-disable-next-line unicorn/no-useless-spread
			for (const dispose of [...children]) {
				try {
					dispose();
				} catch (err) {
					if (!report) {
						throw err;
					}
					report(err);
				}
			}
			children.clear();

			// cleared before it is called, so a cleanup that throws is not left
			// behind to be called a second time on the next run
			const previous = cleanup;
			cleanup = undefined;
			if (!previous) {
				return;
			}
			try {
				previous();
			} catch (err) {
				if (!report) {
					throw err;
				}
				report(err);
			}
		};

		const computed = new Computed<void>(
			() => {
				// `flush()` snapshots what is pending before it starts, so an effect
				// disposed by an earlier effect in the same pass is still in that
				// snapshot and would run once more -- and the read it makes on the way
				// would re-link it to its sources, quietly undoing `dispose()`
				if (disposed) {
					return;
				}
				runCleanups(errorHandler);
				const outer = currentOwner;
				currentOwner = children;
				try {
					cleanup = asCleanup(fn());
				} finally {
					currentOwner = outer;
				}

				// the body may have disposed this very effect, in which case the
				// cleanup it just returned belongs to a run nobody will ever tear
				// down -- `dispose()` has already been and gone
				if (disposed && cleanup) {
					const stranded = cleanup;
					cleanup = undefined;
					stranded();
				}
			},
			{ [effectBody]: true }
		);

		const dispose = (): void => {
			if (disposed) {
				return;
			}
			disposed = true;
			parent?.delete(dispose);
			watcher.unwatch(computed);
			// unwatching stops it being *notified*; its sources still hold it as a
			// sink, and a long-lived signal would keep it reachable forever
			computed.dispose();
			runCleanups();
		};

		watcher.watch(computed);

		try {
			// untracked: the first run happens wherever `effect()` was called, and
			// inside another effect's body that would register this effect as a
			// dependency of the outer one
			untrack(() => computed.get());
		} catch (err) {
			// a throw leaves no disposer with the caller, so nothing could ever
			// unwatch it -- it would re-run on every later change, forever
			watcher.unwatch(computed);
			computed.dispose();
			runCleanups();
			disposed = true;
			throw err;
		}

		parent?.add(dispose);
		return dispose;
	}

	return {
		effect,
		flush,

		setErrorHandler(next) {
			const previous = errorHandler;
			errorHandler = next ?? report;
			return previous;
		},

		setScheduler(next) {
			const previous = scheduler;
			const pending = queued;
			scheduler = next ?? microtask;

			// a scheduler that was asked and never ran leaves the queue claimed and
			// the watcher disarmed. Re-arming here is what makes swapping one out --
			// between tests, or between canvases -- recoverable rather than fatal
			queued = false;
			watcher.watch();

			// and the flush the old one was handed may never arrive, so the new one
			// is asked for it. Without this a swap silently drops whatever was
			// already dirty, which reads as reactivity having stopped
			if (pending) {
				queued = true;
				scheduler(flush);
			}

			return previous;
		},
	};
}

/** The set of effects used unless something builds its own. */
const defaultEffects: Effects = createEffects();

/**
 * Runs `fn` now, and again whenever a signal it read has changed.
 *
 * An effect is a `Computed` nobody reads for its value, held live by a
 * `Watcher`. Unlike a derivation it **may write** -- reacting to a change by
 * setting something else is most of what an effect is for -- and a flush keeps
 * draining until nothing is left dirty.
 *
 * `fn` may return a cleanup function, which runs before each re-run and once
 * more when the effect is disposed. An effect created inside another effect's
 * body is disposed with it.
 *
 * @param fn - What to run. May return a cleanup.
 * @returns Disposes the effect, running any pending cleanup.
 */
export function effect(fn: () => void | (() => void)): () => void {
	return defaultEffects.effect(fn);
}

/** Runs every effect that has gone stale, now. */
export function flush(): void {
	defaultEffects.flush();
}

/**
 * Replaces the scheduler that decides when pending effects run.
 *
 * @param next - The scheduler, or `undefined` to restore the microtask one.
 * @returns The scheduler that was in place, so a caller can put it back.
 */
export function setScheduler(next: Scheduler | undefined): Scheduler {
	return defaultEffects.setScheduler(next);
}

/**
 * Replaces where an error thrown by an effect goes.
 *
 * @param next - The handler, or `undefined` to restore the default.
 * @returns The handler that was in place.
 */
export function setErrorHandler(next: EffectErrorHandler | undefined): EffectErrorHandler {
	return defaultEffects.setErrorHandler(next);
}
