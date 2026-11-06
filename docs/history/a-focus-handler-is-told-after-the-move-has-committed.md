# A focus handler is told after the move has committed — how it was arrived at

The review rounds and sabotage passes behind the entry of that name in
[packages/sigil/src/element/AGENTS.md](../../packages/sigil/src/element/AGENTS.md). The decisions themselves are
there; this is the record of what each round found.

#### Review round 1: the hook ran inside the move

`onFocusChange` was first called straight from `setState()`, between the router's
two state writes and before `current.set()`. A probe against the built bundle
showed a blur handler that sent the focus to a third element leaving two
elements with `:focus` and `.sigil-focus`, a trap (a blur handler calling
`focus()` on itself) that could not hold, and a throwing handler that left
`:focus` and `current` apart with the gaining element never told. The fix was the
queue in `src/element/focus.ts` and a router that commits the whole move before
draining it.

Sabotages, each passing `tsc`: the original inline call and unheld commit
restored (four failures); the hold alone removed (three); the queue alone removed
(four); a handler's throw left uncaught (four); the turn-time check removed (one,
the trap); the commit's throw left uncaught (one); the bound removed (the bounded
test hung). A de-duplication of the queue and a `try/finally` around the loop
changed no answer under sabotage and were taken out -- the second came back in
round 2 for a reason round 1 had not found.

#### Review round 2: what wrote the focus without going through `focus()`

Four findings, all probed and all confirmed.

- **A direct `setState('focus')` during a move.** The queue deferred the
  announcement, so the write landed after `current` named the real target: an
  `onScroll` the scroll into view woke, or a blur handler restoring itself with
  `setState`, left two focused elements wearing the role. Refused now; the router
  is the one writer while a move is committing or being announced.
- **The bound.** A hundred calls per drain, in total: a sixty-control one-way
  chain gave up at the fiftieth with no element wearing the role, and giving up
  left the stopped element's last-told value in place, so the element left
  focused never got the role and its next blur was skipped. Now per element, and
  giving up forgets what the stopped element and everything queued were told.
- **One queue for every router.** Accepted rather than fixed, and pinned by a
  test: an element does not know its router, so the queue cannot be partitioned,
  and draining a nested move before it returns re-enters the handler a trap is
  running. The prose that said an error reaches "whatever moved the focus" was
  wrong and is corrected.
- **The latch.** `draining` was cleared after the loop rather than in a
  `finally`, and the state was read outside the handler's `try`, so a `states`
  that threw left every later focus change in the process untold. The read is
  caught, and the element whose state could not be read is forgotten.

Sabotages, each passing `tsc`: the write check removed from `setState()` (three
failures: the element refusal, the blur restore and the scroll write); the bound
counted in total (one, the sixty-control chain); the bound set to two (one, the
bounce test -- a cap of two and a cap of a hundred are now different tests); giving
up without forgetting (one, the cycle test, which reads the elements left behind);
the read's `try` removed (one, the latch test); the read's `try` and the `finally`
both removed (one, the same); a nested move draining its own announcements (two,
the cross-router test and the cycle test). The `finally` alone removed is caught by
nothing, because with the read caught nothing else in the loop can throw; it is
kept as insurance and the entry says so.

#### Review round 3: the code `setState()` runs inside the router's own writes

The permission was a flag held across both of `moveFocus()`'s writes, and
`setState()` calls the tree's mark callback between its check and its return. So
a mark callback writing another element's focus was let through -- two focused
elements again -- and one calling `focus()` cleared the flag in its own `finally`,
so the open move's second write threw. Both probed and confirmed. The permission
is now the one element being written, spent by that write; the router counts its
moves so a `focus()` from inside its own writes wins and the open move stops; each
step of a move runs whatever the one before threw; and `setState()` announces in
a `finally` around the mark. The round also found prose that over-claimed: the
README's unqualified "last call", "tells each element twice" (the one that keeps
the focus is told once), a bounce test whose comment said ten tells where the run
made twenty-one, and a deleted test still named in `src/components`.

Sabotages, each passing `tsc`: the permission as a flag again (two failures, both
mark-callback refusals); the permission not spent (one, the write to the element
being written); the supersede check removed (two, the mark callback moving the
focus during either write); the inner move taking `current` rather than the open
move's target (one, during the gaining write); the announcement after the mark
rather than in a `finally` (two); a move that stops at its first throw (one). The
bounce test now runs forty-nine round trips, which settle at 99 and 98 tells, and
fifty, which give up: a bound of 2, 21, 98 or 101 fails it and 99 passes, so it
pins the bound at a hundred to within one. The sixty-control chain pins that the
bound is counted per element -- a total bound fails it -- and cannot pin the size,
since a one-way chain never tells anything a third time.
