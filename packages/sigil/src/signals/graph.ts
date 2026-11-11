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
  producerSources(): Iterator<Producer>;
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
  /**
   * Whether a source was invalidated while this was running, which is the one
   * announcement its state cannot hold: a running node is already marked, so
   * propagation would stop at it, and the end of the run would then mark it
   * clean over a value it computed from what a source held before the write.
   */
  stale: boolean;
  /**
   * The outermost read (see `read`) in which this one's last run started and
   * never finished -- abandoned for a chain too deep, or cut short by the stack
   * running out in the graph's own code -- and `0` once a run has finished. Such
   * a node is `DIRTY`, which ordinarily says its subgraph has already been told,
   * and here nothing has: what read it was handed an error, not a write. So the
   * next write to reach it passes through it once (see `invalidate()`), and
   * within the read it failed in it is not run again (see `#run()`).
   */
  incomplete: number;
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
export const effectBody: unique symbol = Symbol('sigil.effectBody');

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
 * @param producer - Whose callback to run.
 * @param gained - `watched` if it became live, `unwatched` if it stopped.
 */
function frozen(producer: Producer, gained: boolean): void {
  const previous = notifying;
  notifying = true;
  try {
    if (gained) {
      producer.notifyWatched();
    } else {
      producer.notifyUnwatched();
    }
  } finally {
    notifying = previous;
  }
}

/**
 * What a state reads, which is nothing: an iterator that is done from the start
 * and stays done, so one serves every state.
 */
const noSources: Iterator<Producer> = ([] as Producer[]).values();

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
 * Moves a producer's live count by one, and passes the change on to what that
 * producer itself reads when the count crosses zero.
 *
 * A loop over an explicit stack rather than a recursion, because the walk is as
 * deep as the graph: a chain of a few thousand computeds -- a running offset per
 * row of a long list -- ran out of native stack part-way through, with the upper
 * counts moved and the lower ones not. The order is the recursion's exactly: a
 * node's sources are walked before its own callback fires, depth first, in the
 * order `producerSources()` hands them over.
 *
 * @param producer - The producer that gained or lost a live sink.
 * @param gained - Whether it gained one.
 */
function moveLive(producer: Producer, gained: boolean): void {
  if ((gained ? ++producer.liveCount : --producer.liveCount) !== (gained ? 1 : 0)) {
    return;
  }

  // the walk happens before the callback, so a callback that throws leaves the
  // counts below it consistent and only its own error escapes. The other order
  // skips the walk entirely and strands every source one short.
  //
  // The frames above the node being walked are pairs of a node and its sources'
  // iterator, flat in one array, which is only built once a source crosses zero
  // too -- most changes stop at the first node
  let stack: (Producer | Iterator<Producer>)[] | undefined;
  let node = producer;
  let walk = producer.producerSources();
  for (;;) {
    const step = walk.next();
    if (step.done !== true) {
      const source = step.value;
      if ((gained ? ++source.liveCount : --source.liveCount) === (gained ? 1 : 0)) {
        (stack ??= []).push(node, walk);
        node = source;
        walk = source.producerSources();
      }
      continue;
    }
    frozen(node, gained);
    if (stack === undefined || stack.length === 0) {
      return;
    }
    walk = stack.pop() as Iterator<Producer>;
    node = stack.pop() as Producer;
  }
}

/**
 * Records that a producer gained a live sink, and passes the liveness on to
 * what that producer itself reads.
 *
 * @param producer - The producer that gained one.
 */
function incLive(producer: Producer): void {
  moveLive(producer, true);
}

/**
 * Records that a producer lost a live sink, and passes that on.
 *
 * @param producer - The producer that lost one.
 */
function decLive(producer: Producer): void {
  moveLive(producer, false);
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
 * How many levels a graph walk -- a write's `propagate()`, a read's settling of
 * a `CHECK` node -- recurses before it carries the rest over an explicit stack.
 *
 * Recursing is what makes a shallow walk cheap: a `for...of` that stays inside
 * its own frame is one the engine compiles down to almost nothing, and an
 * iterator kept on a stack is one it has to allocate. Fully iterative, a small
 * write cost a tenth more and settling a long chain a quarter more. Sixty-four
 * levels is far past any graph built by hand and costs a few kilobytes of
 * native stack, so the bound is what matters and not where it is.
 */
const SHALLOW = 64;

/** `propagateDeep()`'s stack of sink iterators, shared by every write. */
const sinkWalks: Iterator<Consumer>[] = [];

/**
 * Tells one sink that a write has reached it, and says whether the write goes
 * on to what reads it.
 *
 * The one rule both halves of `propagate()` walk by, so that how deep a sink
 * sits can never change what it is told.
 *
 * @param sink - The sink the walk has reached.
 * @param state - `DIRTY` for the first ring of dependents, `CHECK` beyond it.
 * @param errors - Where a watcher's throw is collected, to be raised after.
 * @returns Whether the walk goes on below it.
 */
function invalidate(sink: Consumer, state: NodeState, errors: unknown[]): boolean {
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
    return false;
  }

  if (sink.seen !== undefined) {
    // running: an effect body wrote one of its own sources, or one a source
    // of it reads. Its state is already DIRTY for the run in progress, so the
    // check below would stop here and the run's end would mark it CLEAN over
    // a value computed from before this write -- a `Show` keeping a branch
    // whose condition is already false. So the run is told it is stale, and
    // what reads it hears now, once, the way it would have from a clean node:
    // that is what schedules the re-run, and what keeps a reader from
    // trusting a version this run is about to commit
    if (sink.stale) {
      return false;
    }
    sink.stale = true;
    return true;
  }

  if (sink.state >= state) {
    // already at least this invalidated, so its subgraph has been told -- unless
    // its last run never finished, when what read it was handed an error rather
    // than a write, and an effect that let it through would otherwise never hear
    // of the chain again. Passed through once, which is what keeps this linear
    if (sink.incomplete === 0) {
      return false;
    }
    sink.incomplete = 0;
    return true;
  }

  // only a node that was clean has a subgraph that has not heard yet
  const wasClean = sink.state === CLEAN;
  sink.state = state;
  return wasClean;
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
 * Recursive for the first `SHALLOW` levels and a loop over an
 * explicit stack past them, so the native stack it uses is bounded however deep
 * the graph is. It used to recurse all the way down, and a write into a chain a
 * few thousand computeds long -- a running offset per row of a long list -- ran
 * out of stack part-way through: the version was bumped, the upper part of the
 * subgraph marked and the lower part not, and every later write stopped at the
 * first node already marked, so the unmarked tail served its old value forever
 * with nothing said. The order is the recursion's exactly, on both sides of the
 * bound: depth first, each node's sinks in insertion order, a subgraph finished
 * before its next sibling is looked at.
 *
 * @param producer - What changed.
 * @param state - `DIRTY` for the first ring of dependents, `CHECK` beyond it.
 * @param errors - Where a watcher's throw is collected, to be raised after.
 * @param depth - How many levels down the recursion already is.
 */
function propagate(producer: Producer, state: NodeState, errors: unknown[], depth = 0): void {
  for (const sink of producer.sinks) {
    if (invalidate(sink, state, errors)) {
      if (depth < SHALLOW) {
        propagate(sink as unknown as Producer, CHECK, errors, depth + 1);
      } else {
        propagateDeep(sink as unknown as Producer, errors);
      }
    }
  }
}

/**
 * The rest of a write's walk past `SHALLOW` levels: everything below
 * `producer`, over an explicit stack of sink iterators.
 *
 * The stack is shared by every write, used from wherever this walk found its
 * top. A watcher's throw is caught by `invalidate()`, and a write made from
 * inside a watcher, by a scheduler flushing synchronously, runs its own walk to
 * the end above this one's frames, so what this walk pushes is what it pops.
 * What can still escape is the engine running out of stack, which a write made
 * with fewer than about `SHALLOW` frames to spare can do anywhere in the walk --
 * that is the caller's stack rather than the graph's depth, and nothing can
 * finish a walk the stack will not hold. The `finally` puts the shared stack
 * back however the walk ends, so what one write left behind is never another's.
 *
 * @param producer - The node whose subgraph is still to be told.
 * @param errors - Where a watcher's throw is collected, to be raised after.
 */
function propagateDeep(producer: Producer, errors: unknown[]): void {
  const base = sinkWalks.length;
  let walk: Iterator<Consumer> = producer.sinks.values();
  try {
    for (;;) {
      const step = walk.next();
      if (step.done === true) {
        if (sinkWalks.length === base) {
          return;
        }
        walk = sinkWalks.pop() as Iterator<Consumer>;
        continue;
      }
      const sink = step.value;
      if (invalidate(sink, CHECK, errors)) {
        sinkWalks.push(walk);
        walk = (sink as unknown as Producer).sinks.values();
      }
    }
  } finally {
    sinkWalks.length = base;
  }
}

/**
 * Rethrows what a walk collected, having finished the walk first.
 *
 * One callback must not take the rest of a graph mutation with it -- a sink left
 * unmarked keeps serving a value from before the write, and a source left
 * unswept keeps an edge nothing reads -- so the errors are gathered and raised
 * once the structure is consistent again.
 *
 * @param errors - What was caught along the way.
 * @param message - What to call the aggregate, when there is more than one.
 */
function raise(errors: unknown[], message: string): void {
  if (errors.length === 1) {
    throw errors[0];
  }
  if (errors.length > 1) {
    throw new AggregateError(errors, message);
  }
}

/**
 * The errors that say a read ran out of native stack, once they have been
 * given a message that says so.
 */
const tooDeep = new WeakSet<object>();

/** How many computeds are evaluating, one inside the next. */
let running = 0;

/**
 * Which outermost read is under way: bumped by every run that starts with
 * nothing evaluating around it. A run cut short by the stack is not run again
 * inside the same read, and this is how a run knows it is the same read.
 */
let read = 0;

/** The error the current read rethrows for a run it already saw cut short. */
let readError: RangeError | undefined;

/**
 * How many computeds have to be evaluating one inside the next before the engine
 * running out of stack under them is taken for a chain's. A chain runs out
 * hundreds or thousands deep; with fewer, the overflow is cached under the
 * engine's own message, as it always was. That is right for a body's own
 * runaway recursion, which is an answer about that body. It is a known limit for
 * a short chain read by a caller whose own stack is all but spent: the overflow
 * is cached on whichever link it reached, and a fresh chain has no edges yet for
 * a write to come back along, so that link keeps the error until disposed.
 * Measured on chains of 10 and 40 read at every frame of an unwinding overflow:
 * errors kept, but no wrong value, where `main` kept the same errors and handed
 * back a few wrong values besides.
 */
const CHAIN_DEPTH = 64;

/**
 * Whether a thrown value is a chain running out of stack: the error a run
 * already made of one, or the engine's own overflow raised under more than
 * `CHAIN_DEPTH` computeds evaluating one inside the next.
 *
 * @param error - What was thrown.
 * @returns Whether it is a chain too deep to evaluate.
 */
function isTooDeep(error: unknown): error is RangeError {
  return (
    error instanceof RangeError &&
    (tooDeep.has(error) ||
      (running > CHAIN_DEPTH && error.message.startsWith('Maximum call stack size exceeded')))
  );
}

/**
 * The error a read throws when evaluating a chain ran out of native stack, made
 * once at the run that caught the engine's and passed through unchanged by every
 * run it unwinds through after that.
 *
 * A thrown value is otherwise cached the way a value is, and running out of
 * stack is the one throw that is not an answer: it says how deep the stack
 * already was when the read happened, not anything about what the computed
 * reads, so the same read made from a shallower stack -- or after the chain
 * below it has been read from the bottom up, outside any computed or effect --
 * succeeds. Cached, it was
 * permanent: the computed whose body hit the limit kept the error, clean, and
 * held no edge to the source whose read never finished, so no write could ever
 * reach it again.
 *
 * So a derivation it passes through is left `DIRTY`, with nothing committed and
 * nothing swept -- `sources` is the old set plus whatever the run read before it
 * stopped, which is more than it needs and never less, and the next run sweeps
 * it -- and marked `incomplete`, and the error goes on up. The whole partial
 * evaluation unwinds and a later read is a fresh attempt. Whoever read one of
 * those nodes keeps an edge to it (see `get()`), and a write that reaches it
 * passes through it once rather than stopping at a node already dirty, since
 * nothing below it was told by a write the first time (see `invalidate()`).
 *
 * A body that catches the error and returns something else is not second-
 * guessed: what it returns is an answer like any other and is cached, with the
 * edge `get()` records, so a write that reaches what it failed to read reaches
 * it. Where the engine runs out at the call into `get()` itself, nothing of the
 * graph's runs to record that edge, and the fallback is cached with none -- a
 * chain whose every link catches is not safe at the edge of the stack.
 *
 * An effect body is exempt, for the reason a failed sweep exempts it: it has
 * already run and written whatever it writes, and a flush reads anything not
 * `CLEAN` as still pending, so leaving it dirty would run it again on every
 * pass. It caches this error like any other throw and the flush reports it
 * once -- whether its own body ran out, or the asking of its sources did before
 * the body could run.
 *
 * @param error - The engine's overflow, or the error an inner run made of it.
 * @returns The error to throw.
 */
function chainTooDeep(error: RangeError): RangeError {
  if (tooDeep.has(error)) {
    return error;
  }
  const clear = new RangeError(
    'Computed chain too deep: the stack ran out evaluating it in one read, and nothing was cached. Read it in steps, from the bottom up, outside any computed or effect',
    { cause: error }
  );
  tooDeep.add(clear);
  readError = clear;
  return clear;
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
  producerSources(): Iterator<Producer> {
    return noSources;
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
    raise(errors, 'Watcher notify callbacks threw');
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
  /** Whether `#settleDeep()` is part-way through asking this one's sources. */
  #settling = false;
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
  stale: boolean = false;
  /** @internal */
  incomplete: number = 0;
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
  producerSources(): Iterator<Producer> {
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
      this.#settle(0);
      return;
    }

    this.#run();
  }

  /**
   * Settles a `CHECK` computed: asks each source whether it actually changed,
   * and recomputes only if one did.
   *
   * Each source is refreshed first -- a computed source may itself be stale --
   * and then compared by version rather than by value, because the version is
   * what the consumer recorded and what `equals` already decided. The first
   * source that changed ends the asking, so a source after it is not refreshed
   * for a value the recompute may never read.
   *
   * Recursive for the first `SHALLOW` levels of `CHECK` sources and a loop over
   * an explicit stack past them, so the native stack the asking uses is bounded.
   * A write marks everything past its first ring `CHECK`, so reading the end of a
   * long chain after a write descends through every level of it before anything
   * recomputes -- and no user code is on the stack for any of that descent, so
   * there is nothing to stop it being flat. A chain of a few thousand ran out of
   * native stack here. What recomputes still does it from the bottom up, one
   * level at a time, on both sides of the bound: a source that changed is rerun
   * before the consumer that reads it is asked.
   *
   * @param depth - How many `CHECK` levels down the asking already is.
   * @internal
   */
  #settle(depth: number): void {
    let changed = false;
    for (const [source, seen] of this.sources) {
      if ((source as Partial<Consumer>).state === CHECK) {
        // a computed that has to ask its own sources first, which is what its
        // `refresh()` would do -- called directly so the depth goes with it
        if (depth < SHALLOW) {
          (source as Computed<any>).#settle(depth + 1);
        } else {
          (source as Computed<any>).#settleDeep();
        }
      } else {
        source.refresh();
      }
      if (source.version !== seen) {
        changed = true;
        break;
      }
    }

    if (changed) {
      this.state = DIRTY;
      this.#run();
    } else {
      this.state = CLEAN;
    }
  }

  /**
   * The rest of `#settle()` past `SHALLOW` levels: the same asking, over an
   * explicit stack, for this node and everything `CHECK` below it.
   *
   * Each node on the stack is marked `#settling`, and reaching one again is a
   * cycle among `CHECK` nodes -- which takes a disposed computed read again by
   * what it used to read -- and throws the error a computed reading itself
   * throws. The recursion this replaced found the same cycle by running out of
   * stack, at once; a loop with nothing to stop it pushed until the heap ran out
   * instead, which is a crash rather than an error. Whatever is still on the
   * stack when anything throws stays `CHECK`, which means "ask", so the next
   * read asks again.
   *
   * @internal
   */
  #settleDeep(): void {
    // the frames below the one being asked about: each node, its sources'
    // iterator where the asking stopped, and the version of the node above it
    // that it recorded. Flat in one array, and only built if a source is itself
    // a computed that has to ask, which is not the common case
    let stack: unknown[] | undefined;
    // the walk moves down onto other computeds, which is what makes this a
    // cursor rather than an alias: `#run()` is reachable on any of them from in
    // here, and a source that is CHECK is always a computed, since a state has
    // no state of its own to be in
    // eslint-disable-next-line typescript/no-this-alias
    let node: Computed<any> = this;
    let walk: Iterator<[Producer, number]> = node.sources.entries();
    let changed = false;
    node.#settling = true;

    try {
      walking: for (;;) {
        if (!changed) {
          for (let step = walk.next(); step.done !== true; step = walk.next()) {
            // indexed rather than destructured, which would run the array
            // iterator protocol on every entry of a hot loop
            const source = step.value[0];
            const seen = step.value[1];
            if ((source as Partial<Consumer>).state === CHECK) {
              // a computed that has to ask its own sources first: descend,
              // and come back to compare it against `seen` once it has settled
              if ((source as Computed<any>).#settling) {
                throw new Error('A Computed may not read itself');
              }
              (stack ??= []).push(node, walk, seen);
              node = source as Computed<any>;
              node.#settling = true;
              walk = node.sources.entries();
              continue walking;
            }
            source.refresh();
            if (source.version !== seen) {
              changed = true;
              break;
            }
          }
        }

        node.#settling = false;
        if (changed) {
          node.state = DIRTY;
          node.#run();
        } else {
          node.state = CLEAN;
        }

        if (stack === undefined || stack.length === 0) {
          return;
        }
        const seen = stack.pop() as number;
        walk = stack.pop() as Iterator<[Producer, number]>;
        const settled = node;
        node = stack.pop() as Computed<any>;
        changed = settled.version !== seen;
      }
    } catch (err) {
      node.#settling = false;
      for (let i = 0; stack !== undefined && i < stack.length; i += 3) {
        (stack[i] as Computed<any>).#settling = false;
      }
      throw err;
    }
  }

  /** Recomputes, rehooking dependencies and bumping the version only on change. */
  #run(): void {
    if (this.#evaluating) {
      throw new Error('A Computed may not read itself');
    }

    if (running === 0) {
      read++;
      readError = undefined;
    } else if (this.incomplete === read) {
      // cut short by the stack already in this read, and not run again until
      // the next one. Inside one read a retry starts no shallower than the run
      // that failed, so it fails again -- and a body that reads the same source
      // twice, catching each time, retried a whole subchain per level: work that
      // doubled with every level the stack's edge cut through, millions of runs
      // for a chain `main` read in a few thousand. It is also why reading the
      // chain in steps from inside the body that caught the error is refused:
      // every link on the path that failed was cut short in this read, so the
      // steps have to be taken outside any computed or effect
      throw (readError ??= chainTooDeep(new RangeError('Maximum call stack size exceeded')));
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
    this.stale = false;
    // until the end of the run says otherwise: a run that never gets there --
    // a chain too deep that it was abandoned for, or the stack running out in
    // this very code -- leaves it set, and `invalidate()` and the check above
    // read it
    this.incomplete = read;

    // installing `this` as the tracking context is the mechanism, not an alias
    // of convenience: every read during `#fn()` registers against whatever is
    // here, which is what makes dependency tracking automatic
    // eslint-disable-next-line typescript/no-this-alias
    currentConsumer = this;
    computing = !this.#writes;
    this.#evaluating = true;
    running++;

    let next: T | undefined;
    let thrown: Thrown | undefined;

    try {
      next = this.#fn();
    } catch (err) {
      thrown = { error: err };
    } finally {
      running--;
      this.#evaluating = false;
      computing = previousComputing;
      currentConsumer = previousConsumer;
      this.seen = undefined;
    }

    if (thrown !== undefined) {
      // throws, leaving the run abandoned, for a derivation a chain too deep
      // went through
      thrown = this.#caught(thrown);
    }

    // committed before the sweep, and the sweep is where user code runs again: a
    // dropped source's `unwatched` callback that threw used to escape from inside
    // the `finally`, which skipped the commit entirely -- the state was already
    // CLEAN, so the throw reached the caller once and every read after it handed
    // back the value from before the recompute, with nothing left to say so
    this.#commit(next, thrown);

    // and marked only once there is something committed to be clean over. The
    // state is DIRTY for the whole of a run, so anything that escapes before
    // here -- the catch above, which first runs cold with the stack just
    // exhausted and can overflow itself, or the commit, which a body that caught
    // an overflow and returned reaches at the very same depth -- leaves the run
    // abandoned rather than CLEAN over a value it never stored. Both happened,
    // and each read back `undefined` from then on. CHECK rather than CLEAN when
    // a source moved during the run, because the write may have landed before
    // the read that saw it: `sources` holds the version each read recorded, so
    // asking them settles it -- a write to a signal the body went on to read is
    // no reason to run again, and one to a signal it had already read, or to
    // what a computed it read reads, is
    this.state = this.stale ? CHECK : CLEAN;
    this.stale = false;
    this.incomplete = 0;
    this.#sweep(seen);
  }

  /**
   * Decides what a run that threw leaves behind: an ordinary throw is cached
   * like a value, and a chain running out of native stack is not cached at all
   * -- see `chainTooDeep()`.
   *
   * A method of its own rather than a branch in `#run()`, which is a frame per
   * level of every chain being evaluated and so is kept as small as it was. The
   * run is still DIRTY here, so if the stack is still all but gone and this call
   * is what overflows, the run is left abandoned -- which is the right answer.
   *
   * The engine's overflow counts as the chain's only under more than
   * `CHAIN_DEPTH` computeds evaluating around this one. With fewer, the stack ran
   * out in this body's own code -- runaway recursion of its own -- which is an
   * answer about the body and is cached under the engine's own message, as it
   * always was, rather than re-run on every read.
   *
   * @param thrown - What the body threw.
   * @returns What to commit.
   */
  #caught(thrown: Thrown): Thrown {
    if (!isTooDeep(thrown.error)) {
      return thrown;
    }
    const error = chainTooDeep(thrown.error);
    if (this.#writes) {
      return { error };
    }
    throw error;
  }

  /**
   * Stores what the run produced, and bumps the version only on a change.
   *
   * @param next - What the callback returned.
   * @param thrown - What it threw instead, if it did.
   */
  #commit(next: T | undefined, thrown: Thrown | undefined): void {
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
   * Drops the sources this run did not read.
   *
   * Each edge is removed on its own, because removing one fires an `unwatched`
   * callback and a callback that throws must not leave the sources after it in
   * the walk holding an edge to a computed that no longer reads them.
   *
   * A failed sweep leaves a derivation DIRTY, so that the next read recomputes
   * rather than trusting a cache whose dependency list user code interrupted --
   * a recomputation is the whole cost, because a derivation is a pure function
   * of what it read. It leaves an *effect body* alone. There the re-run is the
   * observable thing rather than the price of being careful: `fn()` has already
   * run and already written whatever it writes, the flush reads anything not
   * CLEAN as still pending, and marking it dirty ran the body a second time in
   * the same flush -- one write to a counter became two.
   *
   * @param seen - What the run actually read.
   */
  #sweep(seen: Set<Producer>): void {
    const errors: unknown[] = [];

    // eslint-disable-next-line unicorn/no-useless-spread
    for (const source of [...this.sources.keys()]) {
      if (seen.has(source)) {
        continue;
      }
      this.sources.delete(source);
      try {
        removeEdge(source, this);
      } catch (err) {
        errors.push(err);
      }
    }

    if (errors.length > 0 && !this.#writes) {
      this.state = DIRTY;
    }
    raise(errors, 'unwatched callbacks threw');
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
    const errors: unknown[] = [];

    // a copy: `removeEdge` can fire an `unwatched` callback, and user code
    // there is free to touch this graph. Each edge on its own for the same
    // reason the sweep does it: one callback that threw used to take the rest of
    // the release with it -- the sources after it kept their edges, `sources` was
    // never cleared, and the computed stayed reachable from every one of them,
    // which is the leak `dispose()` exists to close
    // eslint-disable-next-line unicorn/no-useless-spread
    for (const source of [...this.sources.keys()]) {
      try {
        removeEdge(source, this);
      } catch (err) {
        errors.push(err);
      }
    }
    this.sources.clear();
    this.state = DIRTY;
    raise(errors, 'unwatched callbacks threw');
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
    try {
      this.refresh();
    } catch (err) {
      this.#unreadable(err);
    }
    track(this);
    if (this.#thrown) {
      throw this.#thrown.error;
    }
    return this.#value as T;
  }

  /**
   * Rethrows what a refresh threw, having first made a chain too deep to read
   * leave the graph able to recover.
   *
   * The reader keeps an edge to what it could not read, recorded at the version
   * it is still at. Without one, a body that caught the error and returned
   * something else held no edge to the source it had failed to read, so no write
   * could ever reach it again -- a fallback cached for good -- and an effect that
   * let it through was deaf to the chain from then on. With one, a write that
   * reaches this once it can be read reaches the reader too.
   *
   * An effect whose sources ran out of stack while they were being asked -- a
   * `CHECK` effect over a chain of dirty links, before its body could run --
   * commits the error the way a body that ran out does and is marked `CLEAN`, so
   * a flush reports it once rather than on every pass. It keeps its edges, so a
   * write that reaches it once the chain is readable runs it again.
   *
   * @param error - What the refresh threw.
   */
  #unreadable(error: unknown): never {
    if (isTooDeep(error)) {
      const clear = chainTooDeep(error);
      if (this.#writes) {
        this.#commit(undefined, { error: clear });
        this.state = CLEAN;
      } else {
        // what read this was handed an error, not a write, which is what
        // `incomplete` says -- and a derivation that was only asking its sources
        // never ran to set it, stayed CHECK, and stopped the next write there
        this.incomplete = read;
      }
      track(this);
      // at a version this can never be at: the reader's answer came from a read
      // that never finished, so whatever this settles on is news to it -- even
      // the value it held before, which recorded as its current version read as
      // nothing having changed, and a catching reader kept its fallback for good
      if (currentConsumer) {
        currentConsumer.sources.set(this, -1);
      }
      throw clear;
    }
    throw error;
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
  stale: boolean = false;
  /** @internal */
  incomplete: number = 0;
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
    this.rearm();

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
   * Re-arms the notification and does not look for what went stale.
   *
   * The opposite of a bare `watch()`, and it exists for the holder that has
   * given up. What is dirty then is exactly what it just failed to settle, so
   * announcing it asks for the work that failed all over again -- and the
   * announcement is what schedules that work, which is a loop with nothing to
   * end it. Armed either way, so a later clean-to-dirty transition is still
   * heard.
   *
   * Not part of the proposal, for the same kind of reason `Computed.dispose()`
   * is not: the proposal has no scheduler of its own to livelock.
   */
  rearm(): void {
    this.#armed = true;
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
