# Transitions and keyframe animations — how it was arrived at

The review rounds, sabotage passes and by-hand audit passes behind
[packages/sigil/src/style/AGENTS.md](../../packages/sigil/src/style/AGENTS.md). The decisions themselves are
there; this is the record of what each round found, which is kept
because a finding nobody wrote down is one somebody re-discovers.

#### What the sabotage pass caught, and what it got wrong

Fifty-eight mutations, one at a time with the suite run after each, over three
rounds: thirty-three before any review, fifteen over the guards round 1's fixes
added, and ten over round 2's. **All fifty-eight are caught now** bar one, written
down below. The interesting half is not the count -- it is that each round's
survivors had the same cause, and that twice a survivor was written up as a
reasoned decision and was not one.

Seven of the first thirty-three survived and each got the test it was missing:
an infinite animation under reduced motion; a keyframe declaring a property that
does not animate; `!important` inside a keyframe (the old assertion was
`/important/` and passed with the guard gone, because the _colour_ parser then
refuses `red !important` and its message contains the word); laying out again for
an animated geometry property (every assertion was on the resolved style, which
moves whether or not the boxes do -- it reads the **picture** now, since paint
draws a child at the box arrange gave it); the frame skip itself (counting paints
cannot see it, so it counts the **timers** the loop set); a sooner frame request
replacing a later one; and forgetting an unmounted element, re-framed from a leak
into behaviour -- a transition on a box nobody can see goes on asking for frames.

Four more survived in round 2's own set and are the same lesson a fourth time:
publishing a media change to the animator needed a renderer whose terminal
_stops_ being one mid-animation; `touchMedia()` walking every base rather than
every live entry needed a `tick()` first, because an entry holding nothing is
dropped and a walk over the entries would otherwise find it anyway; and clearing
the old fill when a new animation replaces it needed two animations touching
**different properties**, because with one property the incoming animation's own
value covers the stale fill on every frame.

Round 3's ten were written after the fixes rather than before, and all but the
memo were caught first time -- which is what the enumeration bought: a walk over
the defaulted inputs fails on nine of those ten by construction, where a fixture
picked by hand had reached none of them.

Two review rounds also never opened `easing.test.ts`, `interpolate.test.ts` or
`keyframes.test.ts`, which is where this feature's arithmetic lives. Checked for
the same weakness and it was there -- none of the three reached a defaulted or
degenerate input: no zero or omitted duration, no non-finite count, no empty
keyframes body, no fraction outside the interval. The code held for everything the
new walks over those three grammars ask, with one exception that was a live defect:
an empty `@keyframes` body, which is the entry above.

**Which is the finding worth keeping, because one of those survivals was written
into this file as a reasoned decision and it was wrong.** The entry above records
what the `isFinite` guard really did; what it says about the _method_ is this. The
harness was sound -- it patched the source, ran the whole suite, and read every
failed assertion -- so "no test failed" was a true statement about the suite that
existed. What was weak was the **fixture**: in eleven of the forty-six, the only
test reaching the branch did not reach the state that makes the guard matter. A
sabotage result is therefore a statement about the tests and not about the code,
and the two diverge exactly where a fixture is too easy. The error that compounded
it was reasoning _forward_ from the survival to a five-step justification for why
the guard was redundant, rather than asking what input would make it matter and
writing that input down. Every survivor since has been resolved the second way.

Five of round 2's fifteen survived: the four above, and one more -- an empty fill
not being recorded -- which was kept on an unreachability argument that round 2
then falsified, since `touchMedia()` is a reader that does not tick. It is gone,
replaced by the `ran` flag that was the real distinction, and that one has a test.

Nine of round 3's ten were caught by the tests written with them. The tenth
survives and is **a fast path rather than a claim**: `index()`'s memo on the
`Keyframes` object. Delete it and every observe rebuilds the index, the stale-fill
comparison always differs, and every answer is the same with some of them computed
twice -- so what it costs to delete is work rather than correctness, and it says so
where it lives.

Which leaves the tally at **one** deliberate survivor across three rounds, and it
is the only one of the three that was ever a fast path rather than a claim -- the
other two were a false unreachability argument and a false structural one.
