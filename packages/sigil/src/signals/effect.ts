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
 * with different loops, a library using sigil inside a host that also does, or
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
 * the process, bypassing `main()`'s error handling, the `beforeError` hooks,
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
 * How many flushes may follow one another before the chain is called a cycle.
 *
 * `MAX_PASSES` is per scope by construction, so it never sees two scopes writing
 * what the other reads: each drain settles in a pass or two, announces the other
 * scope's work on the way out, and neither ever reaches its own bound. That is
 * the same failure the bound exists to prevent, one level up, and it spun
 * forever reporting nothing at all.
 *
 * A chained flush is one that was asked for while some scope was already
 * flushing, which is both shapes of it: a synchronous scheduler re-enters and a
 * microtask one runs next. A flush nobody was mid-flush for starts the count
 * again, so ordinary reactivity -- an effect writing something another scope
 * watches, once -- never approaches this.
 */
const MAX_CHAIN = 100;

/** Flushes running right now, across every scope. */
let flushesRunning = 0;

/** How many flushes have followed one another without the chain being broken. */
let flushChain = 0;

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
	/**
	 * Set by a drain that gave up, and cleared by the next notification.
	 *
	 * A notification is the only evidence that something went clean to dirty
	 * since, which is the only thing that makes the work worth retrying. The
	 * writes the failed drain made itself all happened before this was set.
	 */
	let stalled = false;
	/**
	 * Effect bodies running right now in this scope, and whether a flush was
	 * refused because of one.
	 *
	 * An effect body may write, and under a synchronous scheduler that write is
	 * flushed where it happens -- which for an effect's *first* run is from inside
	 * the very `get()` that is running it. The drain then reaches that computed,
	 * asks it for a value it is in the middle of producing, and gets
	 * "A Computed may not read itself" once per pass, a hundred times. The
	 * `flushing` guard below does not cover it, because an initial run is not part
	 * of any drain.
	 */
	let bodies = 0;
	let deferred = false;
	/**
	 * Whether a disposal this scope's caller made reached a drain that gave up.
	 *
	 * Disposing one side of a cycle is how a caller breaks it, and it announces
	 * nothing -- so without this the give-up latches `stalled` anyway and the work
	 * waits for a notification that the disposal was supposed to make unnecessary.
	 * What made this hard is that a cycling drain disposes effects all by itself:
	 * an effect re-running tears its children down first, so "something was
	 * disposed while draining" fires on every pass and cannot tell breaking the
	 * cycle from the cycle running. `teardown` is what separates them -- not by
	 * counting disposals but by asking who made them, which the machinery knows
	 * exactly because it is the one doing it.
	 */
	let broken = false;
	/** Disposals the effect machinery is making itself, tearing children down. */
	let teardown = 0;

	/** Asks the scheduler for a flush, if one is not already asked for. */
	function requestFlush(): void {
		if (!queued) {
			queued = true;
			// recorded now rather than when it runs: a microtask flush runs after the
			// one that scheduled it has finished, so by then there is nothing left to
			// ask. This is the only moment that knows
			chained = flushesRunning > 0;
			scheduler(scheduledFlush);
		}
	}

	/** Whether the flush now queued was asked for from inside another one. */
	let chained = false;

	const watcher = new Watcher(() => {
		stalled = false;
		requestFlush();
	});

	/**
	 * What the scheduler is handed, and the only flush `stalled` refuses.
	 *
	 * A drain gives up with the cycling effects still dirty, and the writes it
	 * made on the way have already asked the scheduler for another flush -- one
	 * that would drain the same effects, fail the same way, and ask again. A
	 * flush nobody has announced anything for since the last one gave up is that
	 * flush, and it does nothing. A flush the *caller* asked for is not: they may
	 * have disposed the effect that was cycling, and disposal announces nothing.
	 */
	function scheduledFlush(): void {
		queued = false;
		if (stalled) {
			return;
		}
		flush();
	}

	function flush(): void {
		queued = false;

		if (flushing) {
			// re-entered from inside an effect. The pass already running will see
			// whatever this one would have, because it drains until quiet
			return;
		}

		if (bodies > 0) {
			// re-entered from inside an effect body that is not part of a drain,
			// which is an initial run under a synchronous scheduler. Draining now
			// would ask a computed that is mid-run for its value. Noted rather than
			// dropped: the body will ask again on its way out, since clearing
			// `queued` above has left nothing else to
			deferred = true;
			return;
		}

		flushing = true;
		flushesRunning++;
		flushChain = chained ? flushChain + 1 : 0;
		chained = false;
		let settled = false;
		try {
			if (flushChain > MAX_CHAIN) {
				// the cross-scope cycle. Reported once and then stalled the same way
				// an in-scope one is, so the chain stops here rather than at whichever
				// scope happens to run out of patience first
				errorHandler(
					new Error(
						`Effects did not settle after ${MAX_CHAIN} chained flushes, which usually means two scopes write what the other reads`
					)
				);
				return;
			}
			// a scheduler may run this synchronously from inside the watcher's notify
			// callback. The callback may not touch the graph; the work it scheduled
			// may, and this is the line between them
			settled = outsideNotify(() => drain());
		} finally {
			flushing = false;
			flushesRunning--;
			// a disposal the caller made during the drain is the one piece of
			// evidence that the next attempt may go differently, and it announces
			// nothing of its own
			stalled = !settled && !broken;
			broken = false;
			if (!stalled) {
				watcher.watch();
			} else {
				// what is dirty is what the drain just gave up on, and a bare re-arm
				// announces exactly that -- which asks for the flush that failed, on
				// every microtask, forever. Armed and silent instead: a later
				// clean-to-dirty transition is still heard, and the next drain
				// anybody asks for still finds these in `getPending()`.
				//
				// A drain that threw rather than returning lands here too, which is
				// the same failure one level up: the only thing that can throw out of
				// it is the error handler, and announcing work whose report throws
				// asks for that throw again forever
				watcher.rearm();
			}
		}
	}

	/**
	 * Runs pending effects until nothing is left dirty.
	 *
	 * @returns Whether it settled, as opposed to giving up at `MAX_PASSES`.
	 */
	function drain(): boolean {
		// the check is at the *start* of a pass, so the last pass's own work was
		// never looked at: a chain needing exactly `MAX_PASSES` passes did all of
		// it, settled, and was reported as a cycle anyway -- with the right values
		// already computed. Counting the work rather than the loop is what makes
		// the bound mean what it says, and it is worth the shape: a false "did not
		// settle" is a lie of exactly the kind that erodes trust in the true one
		let passes = 0;
		for (;;) {
			// re-armed *before* draining, so a write made by an effect during
			// this pass still schedules the next one
			watcher.watch();
			const pending = watcher.getPending();
			if (pending.length === 0) {
				return true;
			}
			if (passes === MAX_PASSES) {
				break;
			}
			passes++;
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
		return false;
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
			// iterated directly, and the copy that used to be here was not needed:
			// disposing a child deletes it from this set, and a `Set` iterator is
			// specified to cope with that -- an entry removed after it has been
			// visited changes nothing, and one removed before it is skipped, which
			// is what should happen to a child a sibling's cleanup disposed. The
			// linter said as much and was silenced rather than believed
			teardown++;
			try {
				for (const dispose of children) {
					try {
						dispose();
					} catch (err) {
						if (!report) {
							throw err;
						}
						report(err);
					}
				}
			} finally {
				// these are the scope's own disposals, not a caller's, and telling
				// them apart is the whole of what makes a disposal usable as evidence
				// that a cycle was broken -- an effect re-running tears its children
				// down on every pass of a drain that is going nowhere
				teardown--;
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
				bodies++;
				try {
					cleanup = asCleanup(fn());
				} finally {
					currentOwner = outer;
					bodies--;
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

			// disposing changes what a drain would do and announces nothing, and a
			// stalled scope is waiting for exactly that: breaking a cycle by
			// disposing one side of it is how a caller fixes one. Nothing else says
			// so -- an effect the give-up left dirty swallows a later write, since
			// propagation stops at a node already dirty. So the latch comes off and
			// what is still pending is announced, which settles now that the cycle
			// is gone, or gives up once more and stalls again
			if (stalled) {
				stalled = false;
				watcher.watch();
			}

			// and a disposal made *during* a drain is the same evidence arriving a
			// moment earlier -- an error handler shutting the cycle down, or a body
			// disposing something. It cannot latch `stalled` itself, because the
			// drain has not given up yet, so it leaves this for the `finally` to read
			if (flushing && teardown === 0) {
				broken = true;
			}

			runCleanups();
		};

		watcher.watch(computed);

		try {
			// counted across the whole run rather than around the body alone,
			// because the body returning is not the run finishing: the commit and
			// the dependency sweep come after it, and until those are done this
			// computed still refuses to be read. A flush let in through that window
			// asks it for the value it is in the middle of producing, which is
			// "A Computed may not read itself", once per pass, a hundred times --
			// and that is the whole of the synchronous-creation storm.
			//
			// untracked: the first run happens wherever `effect()` was called, and
			// inside another effect's body that would register this effect as a
			// dependency of the outer one
			bodies++;
			try {
				untrack(() => computed.get());
			} finally {
				bodies--;
				// a synchronous scheduler flushed a write this run made, and that
				// flush was refused because this run was the thing it would have
				// drained. Nothing else will ask for it -- the refusal happened after
				// `queued` had been cleared -- so it is asked for here, where the run
				// is over and a drain is safe again. Nested creation unwinds to the
				// outermost run before anything is asked for, which is what `bodies`
				// counts rather than flags
				if (bodies === 0 && deferred) {
					deferred = false;
					requestFlush();
				}
			}
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
				scheduler(scheduledFlush);
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
