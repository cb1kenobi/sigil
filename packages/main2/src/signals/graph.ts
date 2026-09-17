/**
 * The reactive graph: state cells, computed cells, and the watchers that sit on
 * top of them.
 *
 * Written to the shape of the TC39 Signals proposal (stage 1) rather than
 * invented, so that this module can be deleted when the native one lands and so
 * that anyone who has used signals anywhere already knows the API. The names
 * are theirs -- `State`, `Computed`, `subtle.Watcher`, `equals`, `watched`,
 * `unwatched` -- and where the proposal is specific about behavior, that
 * behavior is what is implemented here.
 *
 * The one thing the proposal deliberately leaves out is scheduling: a `Watcher`
 * says *that* something changed and never decides *when* to act on it. That is
 * `effect()`'s job, and further up it is the frame loop's.
 */

/** Nothing upstream changed; the cache stands. */
const CLEAN = 0;

/**
 * Something upstream *may* have changed, so this has to ask before trusting its
 * cache. This is the state that makes the graph glitch-free: an invalidation is
 * announced across the whole subgraph before any of it recomputes, so nothing
 * can observe a half-applied update.
 */
const CHECK = 1;

/** Something this reads directly definitely changed. */
const DIRTY = 2;

type NodeState = typeof CLEAN | typeof CHECK | typeof DIRTY;

/** A cell that can be read, and so can be depended on. */
interface Producer {
	/**
	 * Bumped only when the value actually changes, never merely when it is
	 * recomputed. A consumer records the version it saw, so a computed whose
	 * inputs churned but settled on an equal value does not re-run its dependents.
	 */
	version: number;
	sinks: Set<Consumer>;
	/**
	 * How many *live* sinks this has -- sinks a watcher can reach. Being read is
	 * not the same as being observed, and `watched`/`unwatched` are about the
	 * second.
	 */
	liveCount: number;
	/** Brings the value up to date so that `version` can be trusted. */
	refresh(): void;
	/** What this reads, for liveness to propagate through. Empty for a state. */
	producerSources(): Iterable<Producer>;
	notifyWatched(): void;
	notifyUnwatched(): void;
}

/** A node that reads other nodes, and so depends on them. */
interface Consumer {
	/** Each source, and the version of it this consumer last saw. */
	sources: Map<Producer, number>;
	/**
	 * The sources read during the run in progress, or `undefined` when nothing is
	 * running. `sources` stays whole while a computed evaluates -- the old set
	 * plus whatever has been read so far -- and this says which of them are still
	 * wanted when the run ends.
	 *
	 * The obvious implementation swaps in an empty map for the duration. That
	 * breaks liveness: `incLive` and `decLive` walk `producerSources()`, so
	 * anything that changes a computed's liveness *while it is evaluating* -- an
	 * effect disposing itself, a watcher added from inside a body -- walks a
	 * half-built set and leaves the counts wrong. It shows up much later, as an
	 * `unwatched` that never fires or one that fires while something still
	 * watches.
	 */
	seen: Set<Producer> | undefined;
	state: NodeState;
	/** A watcher is notified rather than marked, and is always live. */
	readonly isWatcher: boolean;
	notify(): void;
}

/**
 * The consumer currently evaluating, which is what makes tracking automatic:
 * every read registers against whatever is on top.
 */
let currentConsumer: Consumer | undefined;

/** Set while a watcher's notify callback runs, which may not touch the graph. */
let notifying = false;

/**
 * Set while a computed's callback runs, so a write from inside one can be
 * refused. A computed that writes makes the graph's value depend on the order
 * it happened to be evaluated in, and evaluation order is exactly what laziness
 * makes unpredictable.
 */
let computing = false;

/**
 * Option key marking a `Computed` as an effect body.
 *
 * An effect is a computed nobody reads for its value, and unlike a real
 * derivation it is allowed to write: reacting to a change by setting something
 * else is most of what an effect is for -- focus moving, a resize landing on a
 * width, a dirty bit going up. The write ban exists because a *derivation* that
 * writes makes its answer depend on evaluation order, and an effect has no
 * answer to depend on it.
 *
 * Not part of the proposal, and not exported past this module: `effect()` is
 * the only thing that may set it.
 */
export const effectBody: unique symbol = Symbol('main2.effectBody');

/** Option key for the callback fired when a signal gains its first watcher. */
export const watched: unique symbol = Symbol('Signal.subtle.watched');

/** Option key for the callback fired when a signal loses its last watcher. */
export const unwatched: unique symbol = Symbol('Signal.subtle.unwatched');

export interface SignalOptions<T> {
	/**
	 * Whether two values count as the same, and so whether dependents re-run.
	 * Defaults to `Object.is`, matching the proposal.
	 */
	equals?: (a: T, b: T) => boolean;
	/**
	 * Called when this signal becomes live -- reachable from a watcher -- which
	 * is when a signal backed by something external should subscribe to it.
	 */
	[watched]?: () => void;
	/** Called when this signal stops being reachable from any watcher. */
	[unwatched]?: () => void;
	/** @internal Marks an effect body, which may write. */
	[effectBody]?: boolean;
}

/**
 * Runs a callback with the graph closed to it, the way a notify callback runs.
 *
 * `watched` and `unwatched` fire from inside the `incLive`/`decLive` walk, which
 * is a graph mutation in flight. A callback that wrote a signal from there would
 * re-enter propagation halfway through a liveness update -- the same hazard the
 * ban on `notify` exists for, and the proposal freezes both for the same reason.
 *
 * @param fn - What to run.
 */
function frozen(fn: () => void): void {
	const previous = notifying;
	notifying = true;
	try {
		fn();
	} finally {
		notifying = previous;
	}
}

/**
 * Whether a consumer is observed, and so whether the things it reads are.
 *
 * @param consumer - The consumer to ask about.
 * @returns Whether a watcher can reach it.
 */
function isLive(consumer: Consumer): boolean {
	return consumer.isWatcher || (consumer as unknown as Producer).liveCount > 0;
}

/**
 * Records that a producer gained a live sink, and passes the liveness on to
 * what that producer itself reads.
 *
 * @param producer - The producer that gained one.
 */
function incLive(producer: Producer): void {
	if (++producer.liveCount === 1) {
		// the walk happens before the callback, so a callback that throws leaves the
		// counts consistent and only its own error escapes. The other order skips
		// the walk entirely and strands every source one short
		for (const source of producer.producerSources()) {
			incLive(source);
		}
		frozen(() => producer.notifyWatched());
	}
}

/**
 * Records that a producer lost a live sink, and passes that on.
 *
 * @param producer - The producer that lost one.
 */
function decLive(producer: Producer): void {
	if (--producer.liveCount === 0) {
		for (const source of producer.producerSources()) {
			decLive(source);
		}
		frozen(() => producer.notifyUnwatched());
	}
}

/**
 * Hooks a dependency up, carrying liveness with it.
 *
 * @param producer - What is read.
 * @param consumer - What reads it.
 */
function addEdge(producer: Producer, consumer: Consumer): void {
	if (producer.sinks.has(consumer)) {
		return;
	}
	producer.sinks.add(consumer);
	if (isLive(consumer)) {
		incLive(producer);
	}
}

/**
 * Unhooks a dependency, carrying liveness with it.
 *
 * @param producer - What was read.
 * @param consumer - What read it.
 */
function removeEdge(producer: Producer, consumer: Consumer): void {
	if (!producer.sinks.delete(consumer)) {
		return;
	}
	if (isLive(consumer)) {
		decLive(producer);
	}
}

/**
 * Registers a read of `producer` against whoever is currently evaluating.
 *
 * @param producer - The cell being read.
 */
function track(producer: Producer): void {
	if (notifying) {
		throw new Error('A Watcher notify callback may not read signals');
	}
	if (currentConsumer) {
		currentConsumer.sources.set(producer, producer.version);
		currentConsumer.seen?.add(producer);
		addEdge(producer, currentConsumer);
	}
}

/**
 * Announces that a producer may have changed, across the whole subgraph below
 * it, before anything recomputes.
 *
 * Direct dependents are marked `DIRTY` -- they read the thing that changed.
 * Everything past them is marked `CHECK`, because whether *they* changed
 * depends on what the dirty ones settle on. Propagation stops at a node already
 * at least as invalidated as it is about to be marked, which keeps this linear
 * over a graph with shared subexpressions rather than exponential.
 *
 * @param producer - What changed.
 * @param state - `DIRTY` for the first ring of dependents, `CHECK` beyond it.
 */
function propagate(producer: Producer, state: NodeState, errors: unknown[]): void {
	for (const sink of producer.sinks) {
		if (sink.isWatcher) {
			// a watcher that throws must not take the rest of the walk with it.
			// Sinks after it in the set would never be marked, so they would keep
			// serving a value from before the write -- stale with nothing to
			// un-stale them until something else happens to touch the same source
			try {
				sink.notify();
			} catch (err) {
				errors.push(err);
			}
			continue;
		}

		if (sink.state >= state) {
			// already at least this invalidated, so its subgraph has been told
			continue;
		}

		const wasClean = sink.state === CLEAN;
		sink.state = state;

		// only a node that was clean has a subgraph that has not heard yet
		if (wasClean) {
			propagate(sink as unknown as Producer, CHECK, errors);
		}
	}
}

/**
 * Whether any source of a `CHECK` consumer actually changed.
 *
 * Each source is refreshed first -- a computed source may itself be stale --
 * and then compared by version rather than by value, because the version is
 * what the consumer recorded and what `equals` already decided.
 *
 * @param consumer - The consumer to check.
 * @returns Whether it needs to recompute.
 */
function sourcesChanged(consumer: Consumer): boolean {
	for (const [source, seen] of consumer.sources) {
		source.refresh();
		if (source.version !== seen) {
			return true;
		}
	}
	return false;
}

/** A writable cell. */
export class State<T> implements Producer {
	#value: T;
	#equals: (a: T, b: T) => boolean;
	#watchedCallback: (() => void) | undefined;
	#unwatchedCallback: (() => void) | undefined;

	/** @internal */
	version: number = 0;
	/** @internal */
	sinks: Set<Consumer> = new Set();
	/** @internal */
	liveCount: number = 0;

	constructor(initial: T, options: SignalOptions<T> = {}) {
		this.#value = initial;
		this.#equals = options.equals ?? Object.is;
		this.#watchedCallback = options[watched];
		this.#unwatchedCallback = options[unwatched];
	}

	/** @internal */
	refresh(): void {
		// a state is never stale: its value is whatever was last written to it
	}

	/** @internal */
	producerSources(): Iterable<Producer> {
		return [];
	}

	/** @internal */
	notifyWatched(): void {
		this.#watchedCallback?.call(this);
	}

	/** @internal */
	notifyUnwatched(): void {
		this.#unwatchedCallback?.call(this);
	}

	/**
	 * Reads the value, recording the read against whatever is evaluating.
	 *
	 * @returns The current value.
	 */
	get(): T {
		track(this);
		return this.#value;
	}

	/**
	 * Writes the value. A write that `equals` calls the same is not a write.
	 *
	 * @param next - The value to store.
	 */
	set(next: T): void {
		if (computing) {
			throw new Error('A Computed may not write to a signal');
		}
		if (notifying) {
			throw new Error('A Watcher notify callback may not write signals');
		}
		if (this.#equals(this.#value, next)) {
			return;
		}
		this.#value = next;
		this.version++;

		// the whole subgraph is told before anything is allowed to fail, so one
		// broken watcher cannot leave the rest of the graph describing a value
		// that is no longer there
		const errors: unknown[] = [];
		propagate(this, DIRTY, errors);
		if (errors.length === 1) {
			throw errors[0];
		}
		if (errors.length > 1) {
			throw new AggregateError(errors, 'Watcher notify callbacks threw');
		}
	}
}

/** A thrown value, plus the fact that there was one -- `undefined` is throwable. */
interface Thrown {
	error: unknown;
}

/** A lazy, cached, automatically tracked derivation. */
export class Computed<T> implements Producer, Consumer {
	#fn: () => T;
	#equals: (a: T, b: T) => boolean;
	#value: T | undefined;
	#thrown: Thrown | undefined;
	#evaluating = false;
	#everRun = false;
	#writes: boolean;
	#watchedCallback: (() => void) | undefined;
	#unwatchedCallback: (() => void) | undefined;

	/** @internal */
	version: number = 0;
	/** @internal */
	sinks: Set<Consumer> = new Set();
	/** @internal */
	liveCount: number = 0;
	/** @internal */
	sources: Map<Producer, number> = new Map();
	/** @internal */
	seen: Set<Producer> | undefined = undefined;
	/** @internal */
	state: NodeState = DIRTY;
	/** @internal */
	readonly isWatcher: boolean = false;

	constructor(fn: () => T, options: SignalOptions<T> = {}) {
		this.#fn = fn;
		this.#equals = options.equals ?? Object.is;
		this.#watchedCallback = options[watched];
		this.#unwatchedCallback = options[unwatched];
		this.#writes = options[effectBody] === true;
	}

	/** @internal */
	producerSources(): Iterable<Producer> {
		return this.sources.keys();
	}

	/** @internal */
	notifyWatched(): void {
		this.#watchedCallback?.call(this);
	}

	/** @internal */
	notifyUnwatched(): void {
		this.#unwatchedCallback?.call(this);
	}

	/** @internal */
	notify(): void {
		// a computed is marked by `propagate()` rather than notified
	}

	/**
	 * Brings the cached value up to date without reading it, so a dependent can
	 * trust `version` when deciding whether it is really stale.
	 *
	 * @internal
	 */
	refresh(): void {
		if (this.state === CLEAN) {
			return;
		}

		if (this.state === CHECK) {
			// the announcement said "maybe"; ask the sources whether it was real
			this.state = sourcesChanged(this) ? DIRTY : CLEAN;
			if (this.state === CLEAN) {
				return;
			}
		}

		this.#run();
	}

	/** Recomputes, rehooking dependencies and bumping the version only on change. */
	#run(): void {
		if (this.#evaluating) {
			throw new Error('A Computed may not read itself');
		}

		const previousConsumer = currentConsumer;
		const previousComputing = computing;

		// marked rather than swapped. `sources` stays whole for the whole run -- the
		// old set plus whatever has been read so far -- and is swept at the end.
		// Clearing up front would make a source read both before and after lose its
		// last live sink and immediately regain it, firing `unwatched` then
		// `watched` for a dependency that never went away; swapping in an empty map
		// would leave `producerSources()` half-built, so anything that changes this
		// computed's liveness mid-run walks the wrong set
		const seen = new Set<Producer>();
		this.seen = seen;

		// installing `this` as the tracking context is the mechanism, not an alias
		// of convenience: every read during `#fn()` registers against whatever is
		// here, which is what makes dependency tracking automatic
		// eslint-disable-next-line typescript/no-this-alias
		currentConsumer = this;
		computing = !this.#writes;
		this.#evaluating = true;

		let next: T | undefined;
		let thrown: Thrown | undefined;

		try {
			next = this.#fn();
		} catch (err) {
			thrown = { error: err };
		} finally {
			this.#evaluating = false;
			computing = previousComputing;
			currentConsumer = previousConsumer;
			this.seen = undefined;
			this.state = CLEAN;

			// eslint-disable-next-line unicorn/no-useless-spread
			for (const source of [...this.sources.keys()]) {
				if (!seen.has(source)) {
					this.sources.delete(source);
					removeEdge(source, this);
				}
			}
		}

		// an error is cached the way a value is, and counts as a change unless the
		// very same error comes back -- otherwise a throwing computed would re-run
		// every dependent on every read
		if (thrown) {
			const changed =
				!this.#everRun || !this.#thrown || !Object.is(this.#thrown.error, thrown.error);
			this.#thrown = thrown;
			this.#value = undefined;
			this.#everRun = true;
			if (changed) {
				this.version++;
			}
			return;
		}

		let changed = !this.#everRun || !!this.#thrown;
		if (!changed) {
			try {
				changed = !this.#equals(this.#value as T, next as T);
			} catch {
				// an `equals` that throws has not said the values are the same, and
				// treating silence as "unchanged" leaves the cache holding the old
				// value with every dependent told nothing happened
				changed = true;
			}
		}
		this.#thrown = undefined;
		this.#value = next;
		this.#everRun = true;
		if (changed) {
			this.version++;
		}
	}

	/**
	 * Drops every dependency, so that nothing upstream keeps this alive.
	 *
	 * Not part of the proposal, which leaves this to garbage collection -- and
	 * would be right to, if the edges pointed the other way. They do not: a
	 * source holds its sinks in a `Set`, so a long-lived signal keeps every
	 * computed that ever read it reachable forever. An effect that is disposed,
	 * or one whose first run threw before a disposer could be handed back, has to
	 * say so or it is never collected.
	 *
	 * Reading it again recomputes from scratch, so this is a release rather than
	 * a destruction.
	 */
	dispose(): void {
		// a copy: `removeEdge` can fire an `unwatched` callback, and user code
		// there is free to touch this graph
		// eslint-disable-next-line unicorn/no-useless-spread
		for (const source of [...this.sources.keys()]) {
			removeEdge(source, this);
		}
		this.sources.clear();
		this.state = DIRTY;
	}

	/**
	 * Reads the value, computing it if it is stale and recording the read against
	 * whatever is evaluating.
	 *
	 * @returns The current value.
	 */
	get(): T {
		// refreshed *before* the read is recorded, because what gets recorded is
		// the version, and a computed being read for the first time is about to
		// change it. Recording first means the reader stores a version the
		// producer has already left behind, and so looks stale on every check
		// forever after -- a dependent that can never settle.
		this.refresh();
		track(this);
		if (this.#thrown) {
			throw this.#thrown.error;
		}
		return this.#value as T;
	}
}

/**
 * Watches signals and says when one of them may have changed.
 *
 * The callback is told *that* something happened and nothing else: it may not
 * read or write signals, and it is not where work belongs. It fires at most
 * once until `watch()` is called again, which is what keeps a burst of writes
 * from becoming a burst of notifications -- the holder schedules, drains with
 * `getPending()`, and re-arms.
 */
export class Watcher implements Consumer {
	#notify: () => void;
	#armed = true;
	/** Watched signals, in the order they were first watched. */
	#watching: Set<Producer> = new Set();

	/** @internal */
	sources: Map<Producer, number> = new Map();
	/** @internal */
	seen: Set<Producer> | undefined = undefined;
	/** @internal */
	state: NodeState = CLEAN;
	/** @internal */
	readonly isWatcher: boolean = true;

	constructor(notify: () => void) {
		this.#notify = notify;
	}

	/** @internal */
	notify(): void {
		if (!this.#armed) {
			return;
		}
		this.#armed = false;

		const previousNotifying = notifying;
		const previousConsumer = currentConsumer;
		notifying = true;
		// a notify callback that read a signal would otherwise record the read
		// against whatever happened to be evaluating when the write landed
		currentConsumer = undefined;
		try {
			this.#notify();
		} finally {
			currentConsumer = previousConsumer;
			notifying = previousNotifying;
		}
	}

	/**
	 * Starts watching signals, and re-arms the notification either way.
	 *
	 * Called with no arguments it is the re-arm on its own, which is what a
	 * scheduler does once it has drained `getPending()`.
	 *
	 * @param signals - Signals to watch.
	 */
	watch(...signals: (State<any> | Computed<any>)[]): void {
		for (const signal of signals) {
			const producer = signal as unknown as Producer;
			if (this.#watching.has(producer)) {
				continue;
			}
			this.#watching.add(producer);
			this.sources.set(producer, producer.version);
			addEdge(producer, this);
		}
		this.#armed = true;

		// A watcher is only told about a node going from clean to dirty, and
		// propagation stops at a node that is already dirty. So a computed that
		// went stale while this watcher was disarmed is never announced again: the
		// next write walks into it, finds it already dirty, and stops -- and the
		// watcher waits forever. A bare re-arm has to look for itself.
		//
		// Only a bare re-arm. A computed is DIRTY from the moment it is
		// constructed, because it has never run, so checking when signals are
		// being *added* would announce every newly watched computed as a change.
		if (signals.length === 0 && this.getPending().length > 0) {
			this.notify();
		}
	}

	/**
	 * Stops watching signals. Does not re-arm: something no longer watched is not
	 * a reason to hear about the ones that still are.
	 *
	 * @param signals - Signals to stop watching.
	 */
	unwatch(...signals: (State<any> | Computed<any>)[]): void {
		for (const signal of signals) {
			const producer = signal as unknown as Producer;
			if (!this.#watching.delete(producer)) {
				continue;
			}
			this.sources.delete(producer);
			removeEdge(producer, this);
		}
	}

	/**
	 * The watched computeds that are out of date, for a scheduler to drain by
	 * reading each one.
	 *
	 * A state is never pending: it has no computation to be behind on.
	 *
	 * @returns The stale computeds, in the order they were watched.
	 */
	getPending(): Computed<any>[] {
		const pending: Computed<any>[] = [];
		for (const producer of this.#watching) {
			if (producer instanceof Computed && producer.state !== CLEAN) {
				pending.push(producer);
			}
		}
		return pending;
	}
}

/**
 * Runs a function as work a notify callback *scheduled*, rather than as part of
 * the callback itself.
 *
 * A watcher's callback may not touch the graph, and that rule is worth keeping:
 * reading or writing from inside it is how re-entrant propagation starts. But a
 * scheduler is allowed to run its flush synchronously -- a frame loop driving
 * its own timing does exactly that -- and the flush is not the callback. Without
 * this, a synchronous scheduler threw out of the `set()` that triggered it and
 * left the watcher disarmed for the life of the process.
 *
 * Not part of the proposal, and not exported past this package.
 *
 * @param fn - What to run.
 * @returns Whatever it returned.
 */
export function outsideNotify<T>(fn: () => T): T {
	const previous = notifying;
	notifying = false;
	try {
		return fn();
	} finally {
		notifying = previous;
	}
}

/**
 * Runs a function without recording anything it reads.
 *
 * @param fn - What to run.
 * @returns Whatever it returned.
 */
export function untrack<T>(fn: () => T): T {
	const previous = currentConsumer;
	currentConsumer = undefined;
	try {
		return fn();
	} finally {
		currentConsumer = previous;
	}
}

/**
 * The `Computed` currently evaluating, if any. A `Watcher` is not one.
 *
 * @returns The computed being evaluated.
 */
export function currentComputed(): Computed<any> | undefined {
	return currentConsumer instanceof Computed ? currentConsumer : undefined;
}

/**
 * What currently reads a signal.
 *
 * @param signal - The signal to inspect.
 * @returns Its dependents.
 */
export function introspectSinks(signal: State<any> | Computed<any>): (Computed<any> | Watcher)[] {
	// watchers, plus computeds that are themselves live. The proposal is specific
	// about this: a computed that read this signal but that nothing watches is not
	// a sink worth reporting, because nothing is listening through it
	const sinks: (Computed<any> | Watcher)[] = [];
	for (const sink of (signal as unknown as Producer).sinks) {
		if (sink.isWatcher) {
			sinks.push(sink as unknown as Watcher);
		} else if ((sink as unknown as Producer).liveCount > 0) {
			sinks.push(sink as unknown as Computed<any>);
		}
	}
	return sinks;
}

/**
 * How many edges point at this signal, live or not.
 *
 * Not part of the proposal and not in `Signal.subtle`: `hasSinks()` answers the
 * proposal's question, which is about liveness, and this answers the one a leak
 * test needs -- whether anything still holds a reference at all. A source holds
 * its sinks strongly, so an edge that outlives its owner is a leak even when
 * nothing is listening through it.
 *
 * @param signal - The signal to inspect.
 * @returns The number of edges.
 */
export function sinkCount(signal: State<any> | Computed<any>): number {
	return (signal as unknown as Producer).sinks.size;
}

/**
 * What a computed or watcher currently reads. A `State` reads nothing.
 *
 * @param signal - The signal to inspect.
 * @returns Its dependencies.
 */
export function introspectSources(signal: Computed<any> | Watcher): (State<any> | Computed<any>)[] {
	return [...(signal as unknown as Consumer).sources.keys()] as (State<any> | Computed<any>)[];
}

/**
 * Whether anything is listening to this signal.
 *
 * @param signal - The signal to inspect.
 * @returns Whether it is live.
 */
export function hasSinks(signal: State<any> | Computed<any>): boolean {
	// "live" in the proposal's sense: watched by a `Watcher`, or read by a computed
	// that is itself (recursively) watched. Being merely read does not count, which
	// is the same distinction `watched`/`unwatched` draw
	return (signal as unknown as Producer).liveCount > 0;
}

/**
 * Whether this computed or watcher currently reads anything.
 *
 * @param signal - The signal to inspect.
 * @returns Whether it has dependencies.
 */
export function hasSources(signal: Computed<any> | Watcher): boolean {
	return (signal as unknown as Consumer).sources.size > 0;
}
