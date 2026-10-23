# `packages/sigil/src/signals` — deliberate decisions

These are the entries from [../../../../AGENTS.md](../../../../AGENTS.md) that are about this directory. Claude Code loads this file when it
works with files here; other agents should read it before changing
anything in this area. The root `AGENTS.md` holds the rules that apply
everywhere and still applies in full.

How each of these was arrived at — the review rounds and sabotage
passes — is under [docs/history/](../../../../docs/history), linked from
the entry it belongs to.

## Deliberate decisions — do not "fix" these

### Signals

- **The read is recorded after the refresh, not before.** `Computed.get()`
  refreshes and then calls `track()`, because what a consumer records is the
  producer's _version_ and a computed being read for the first time is about to
  change it. Recording first stored a version the producer had already left
  behind, so the dependent re-ran once spuriously after every first read -- the
  cache off by one rather than exact. It looks like an ordering
  nicety and it is the difference between caching and not. Pinned by "should not
  re-run a dependent when its own value did not change" in
  `test/signals/signals.test.ts`.
- **`watched` and `unwatched` are about being observed, not about being read.**
  A signal read only by a computed that nothing watches is not live and its
  `watched` never fires. Liveness is counted and propagates transitively through
  computeds, which is more work than firing on the first reader -- and it is the
  only version that makes the callbacks usable for what they are for:
  subscribing to something external for exactly as long as something is
  rendering. Firing on any reader would subscribe on behalf of a computed that
  nobody will ever read again.
- **A recompute sweeps its old dependencies afterwards rather than clearing them
  first.** Clearing up front is simpler and makes a source that is read both
  before and after lose its last live sink and immediately regain it, firing
  `unwatched` then `watched` for a dependency that never went away. Anything
  that subscribes in those callbacks would tear down and rebuild a subscription
  on every recompute.
- **A `Computed` that writes, that reads itself, or a `Watcher` callback that
  touches the graph all throw.** Each makes the result depend on evaluation
  order, and laziness is precisely what makes evaluation order unpredictable --
  the same program gives different answers depending on who read what first.
  Merely discouraging them means the bug surfaces later, somewhere else.
- **An effect may write a signal; a `Computed` still may not.** Reacting to a
  change by setting something else is most of what an effect is _for_ -- focus
  moving, a resize landing on a width, a dirty bit going up -- and banning it
  would have made the whole layer useless to the renderer. The ban on a
  _derivation_ writing stands, because a derivation has an answer and a write
  makes that answer depend on evaluation order. An effect has no answer. An
  effect body is a `Computed` carrying an internal `effectBody` marker, which is
  the only thing that lifts the ban.
- **A flush drains until nothing is dirty, not once.** It follows from the
  above: an effect that writes can dirty an effect that already ran this pass,
  and stopping after one pass would leave that one a frame behind. The watcher is
  re-armed _before_ each pass, so a write made during one schedules the next.
  There is a bound, because two effects each writing what the other reads would
  otherwise spin forever with nothing said about which two. The bound stops the
  drain and only the drain; the entry below is what stops the scheduler.
- **A flush that gave up re-arms silently, and the flush it had already asked
  for does nothing.** The bound leaves the cycling effects dirty, which is
  correct, and a bare `watch()` re-arm announces whatever is dirty, which is
  also correct -- and together they are a livelock. The give-up announced the
  cycle, the announcement scheduled a flush, that flush gave up and announced it
  again: `Effects did not settle` once per microtask with the event loop never
  idling, and under a synchronous scheduler an unbounded recursion out of the
  `set()` that started it, because `flushing` is back to `false` by the time the
  `finally` re-arms. So `Watcher.rearm()` arms without looking, and a `stalled`
  latch -- set by a drain that gave up, cleared by the next notification --
  makes the flush that the failed drain's own writes already asked for a no-op.
  Armed is not deaf: a later clean-to-dirty transition anywhere in the scope is
  still heard, and the first thing the next drain does is `getPending()`, so the
  effects left dirty are retried by it. The one thing that changes what a drain
  would do and announces nothing is a _disposal_ -- which is how a caller breaks
  a cycle -- so disposing while stalled takes the latch off and announces what is
  still pending. Without that, an effect the give-up left dirty swallows every
  later write to it, since propagation stops at a node already dirty, and the
  flush that would have caught it is the one the latch refuses. A disposal made
  from _inside_ the drain that gave up -- by an effect body, or by an error
  handler that shuts the cycle down -- counts too, and telling it from the
  scope's own churn is what took two attempts. A cycling drain disposes effects
  all by itself, because an effect re-running tears its children down first, so
  "something was disposed while draining" fires on every pass of a drain going
  nowhere and cannot, by counting, tell breaking the cycle from the cycle
  running -- three ways of counting were tried and each was the storm again one
  level slower. The question is not how many but _who_: the machinery knows
  exactly which disposals are its own, because it is the one making them, so
  `teardown` brackets `runCleanups()` and a disposal raised inside it is not
  evidence of anything. What is left is a disposal the caller made, which is the
  one thing that changes what the next drain would do and announces nothing of
  its own. It clears the latch for exactly one retry: if the cycle really was
  broken the retry settles, and if it was not, the next give-up latches again
  with no new disposal to clear it. An
  effect dirty for an
  innocent reason during a failed settle is not stranded by it -- every pass
  runs everything pending, so it ran a hundred times -- and a `flush()` the
  _caller_ asked for is never refused, since breaking the cycle by disposing an
  effect announces nothing and that call is how they find out it worked. The
  error rate settles at once per failed settle rather than once per `set()`: a
  burst of writes is already coalesced into one flush, and the report belongs to
  the flush that could not settle. A drain whose error handler _threw_ takes the
  same exit, which is the same failure one level up -- announcing work whose
  report throws asks for that throw forever. See `test/signals/effect.test.ts`.
- **The bound counts work passes, not loop iterations.** The check for "anything
  left?" happens at the _start_ of a pass, so the last pass's own work was never
  looked at: a chain needing exactly `MAX_PASSES` passes did all of it, settled,
  and was reported as a cycle anyway -- with the right values sitting there
  already computed. Ninety-nine was clean, a hundred was a lie, a hundred and one
  was the truth. A false "did not settle" is a lie of exactly the kind that
  erodes trust in the true one, so the loop asks once more before it reports.
- **A flush refuses to drain into a run that has not finished.** An effect body
  may write, and a synchronous scheduler flushes that write where it happens --
  which during an effect's _first_ run is from inside the `get()` that is running
  it. The drain then reached that very computed and asked it for the value it was
  in the middle of producing: `A Computed may not read itself`, once per pass, a
  hundred times, on top of the one report a cycle actually deserves. The
  `flushing` guard never covered it, because an initial run is not part of any
  drain. `bodies` is counted across the whole run rather than around the body
  alone -- the body returning is not the run finishing, and the commit and the
  dependency sweep come after it -- and the refused flush is asked for again on
  the way out, since clearing `queued` had left nothing else to ask. Nested
  creation unwinds to the outermost run first, which is why it is a count rather
  than a flag.
- **A cycle between two scopes is bounded by the chain, since `MAX_PASSES`
  cannot see it.** The pass bound is per scope by construction: two scopes
  writing what the other reads settle in a pass or two each, announce the other's
  work on the way out, and neither ever reaches its own bound -- so it spun
  forever reporting nothing at all, which is the failure the bound exists to
  prevent one level up. A flush asked for while any scope was already flushing is
  _chained_, counted across scopes, and a hundred and one of them in a row is
  reported and stalled the same way an in-scope cycle is. Recorded when the flush
  is queued rather than when it runs, because a microtask flush runs after the one
  that scheduled it has finished and by then there is nothing left to ask. A flush
  nobody was mid-flush for starts the count again, so ordinary reactivity never
  approaches it. Worth knowing that the synchronous spelling of this cycle damps
  itself out instead: each write lands on a run further up the stack that has not
  committed, and a notification to a computed that is mid-run is swallowed by its
  own commit.
- **An error in an effect is reported, never rethrown.** Under the default
  microtask scheduler a rethrow lands in a microtask nobody catches: Node prints
  a raw stack and kills the process, skipping `main()`'s error handling, the
  `beforeError` hooks, and any chance of putting the terminal back -- the exact
  opposite of the rule that a CLI shows a message and not a stack. Errors go to
  `setErrorHandler()`, whose default writes the message and sets the exit code,
  and which the renderer replaces with the real handler. The watcher is re-armed
  either way: one bad effect silently ending all future reactivity is worse than
  a loud failure.
- **A `flush()` run from inside a notify callback is allowed; a read from the
  callback itself is not.** A scheduler may run its flush synchronously, which is
  what a frame loop driving its own timing does. That is only compatible with the
  callback's ban on touching the graph because the flush is the work the callback
  _scheduled_ rather than the callback -- which is what `outsideNotify()` marks.
  Without it a synchronous scheduler threw out of the `set()` that triggered it
  and left the watcher disarmed for the life of the process.
- **An effect created inside another effect's body dies with it.** Otherwise a
  component that creates an effect while rendering leaks one per render, and
  nothing above can see them to clean up. The initial run is `untrack`ed for the
  same reason: without it the child registers as a dependency of the parent.
- **`Computed.dispose()` exists and the proposal has no such thing.** Garbage
  collection would be enough if the edges pointed the other way, but a source
  holds its sinks in a `Set`, so a long-lived signal keeps every computed that
  ever read it reachable. An effect that is disposed has to say so.
- **An effect that returns a promise throws; any other non-cleanup return is
  ignored.** A promise stored as the cleanup is called on the _next_ run and
  fails with "previous is not a function", one run later and nowhere near the
  mistake -- and tracking stopped at the first `await` anyway. Everything else is
  let through, because `effect(() => a.set(b.get()))` is the spelling worth
  encouraging and a concise arrow body returns whatever its last call did.
- **A recompute marks its sources rather than swapping the map.** `sources`
  stays whole for the whole run -- the old set plus whatever has been read so
  far -- and is swept at the end against a per-run `seen` set. Swapping in an
  empty map is the obvious implementation and it breaks liveness: `incLive` and
  `decLive` walk `producerSources()`, so anything that changes a computed's
  liveness _while it is evaluating_ -- an effect disposing itself, a watcher
  added from inside a body -- walks a half-built set and leaves the counts
  wrong. It surfaces much later, as an `unwatched` that never fires or one that
  fires while something is still watching.
- **A recompute commits its value before it sweeps, and a sweep that throws
  leaves the computed dirty.** The sweep is the half of `#run()` that runs user
  code again -- dropping a source fires its `unwatched` -- and it used to run
  from inside the `finally`, which had already set the state to `CLEAN` and had
  not yet written `#value`. So a callback that threw escaped the caller once and
  then every read after it handed back the value from _before_ the recompute,
  clean, with nothing left to say the run had happened: a `get()` that throws is
  a bad frame, a `get()` that quietly answers last frame's value forever is a
  bug nobody can see. Each edge is now removed on its own, so one throwing
  callback does not leave the sources after it in the walk still holding an edge,
  and the errors are raised together the way `State.set()` raises a watcher's.
  `dispose()` had the identical shape and the identical fix: a throw there took
  the rest of the release with it and skipped `sources.clear()`, so the computed
  stayed reachable from every source after the first -- the leak `dispose()`
  exists to close. See `test/signals/signals.test.ts`.
- **The dirty-after-a-failed-sweep rule is a derivation's, and an effect body is
  exempt.** A derivation is a pure function of what it read, so the retry costs a
  recomputation and buys a cache nobody has to trust. An effect body has already
  run and already written whatever it writes, and a flush reads anything not
  `CLEAN` as still pending -- so marking one dirty ran it a second time in the
  same flush and turned one write to a counter into two. The re-run is the
  observable thing there rather than the price of being careful. See
  `test/signals/effect.test.ts`.
- **A liveness walk happens before its callback, not after.** A `watched` or
  `unwatched` that throws then leaves the counts consistent and only its own
  error escapes. The other order skips the walk entirely and strands every
  source one short, after which no later watcher can make them live again.
- **A bare `watch()` re-arm looks for what went stale while it was disarmed.** A
  watcher is only told about a node going from clean to dirty, and propagation
  stops at a node already dirty -- so a computed left dirty across a re-arm is
  never announced again: the next write walks into it, finds it dirty, stops,
  and the watcher waits forever. Only a _bare_ re-arm checks; a computed is
  dirty from construction, so checking while signals are being added would
  announce every newly watched computed as a change. A holder that _gave up_
  wants the opposite and calls `rearm()`, which is the entry above.
- **A cleanup that throws on a re-run is reported, not rethrown.** Letting it
  escape the effect body before `fn()` has read anything makes the sweep drop
  every dependency, leaving the effect alive, watched, and deaf to the signals
  it was watching -- a cleanup failing should not silently unsubscribe the effect
  from the world. At `dispose()` it does throw, because there the caller asked.
- **Replacing a scheduler hands it any flush the old one was given.** A
  scheduler that was asked and is then thrown away without running takes the
  pending work with it, which reads as reactivity having stopped.
- **A source dropped in the same run that the computed gains a watcher fires
  `watched` and then `unwatched`.** Known and left alone: the counts end
  correct, and avoiding the transient means deferring every liveness change to
  the end of a run, which is a larger redesign than the flicker is worth.
- **An unwatched `Computed` that is dropped is not collected.** Edges are strong
  and bidirectional, so a long-lived `State` keeps every computed that ever read
  it reachable through its sink set. The proposal solves this with generation
  numbers; we have `Computed.dispose()` instead, and `effect()` calls it. A bare
  `new Signal.Computed()` that is read once and dropped leaks its edge until the
  source dies. Known, and it matters most in exactly this project's target -- a
  long-running TUI -- so it gets revisited if a real graph ever grows large
  enough to notice.
- **Effects come in scopes, and the module-level ones are a default scope.**
  `createEffects()` gives an independent watcher, scheduler, queue, and error
  handler. One global scheduler is a trap the moment there is more than one thing
  driving frames -- two canvases with different loops, a library using sigil
  inside a host that also does, or two tests in one file where the first leaves a
  scheduler that never ran and the second is dead before it starts.
- **Coalescing is about how many times an effect runs, not whether it runs.** A
  signal written to `1` and back to `0` before the flush still re-runs its
  effects, once, with the value it settled on. Nothing records what a signal held
  before a burst, and both writes were real changes when they happened.
