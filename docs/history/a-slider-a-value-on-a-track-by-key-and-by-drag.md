# A slider: a value on a track, by key and by drag — how it was arrived at

The tests, the probes and the sabotage pass behind "A slider: a value on a track,
by key and by drag" in
[packages/sigil/src/components/AGENTS.md](../../packages/sigil/src/components/AGENTS.md).
The decisions are there; this is the record of how they were reached. SIG-286.

#### Where it started

`demos/element/05-drag.js` already drew a slider by hand to show the router's
pointer capture, and the layout's `AGENTS.md` already recorded the one bug that
demo had found in itself: a row of `9 + 30 + 6` declared widths in a 40-column
box, squeezed, so the readout's automatic minimum growing from `99%` to `100%`
took a column out of the label and moved the bar. Two things followed from it
before a line was written: the readout had to be the slider's, so that something
could reserve its widest width, and the track's size could not come from what it
drew.

#### What the first draft got wrong, found by drawing it

- **The tracks of four sliders did not line up.** The demo's first draft gave
  each row the same label column and let the slider take the rest, and the four
  readouts -- `100%`, `centre`, `2.00x`, `100%` -- are different widths, so the four
  tracks were too. Nothing in the component was wrong: a readout reserves what its
  own range needs and no more. What it settled was what `width` means: the
  **track**'s columns, so an app can line tracks up, with the host's `props` for
  the whole.
- **`decrease by a page` did not fit.** The first descriptions were `decrease`,
  `increase`, `decrease more`, `increase more`, `minimum`, `maximum`, and the
  key-help test at 80 columns came back cut with an ellipsis after `pgup increase
  more`. They are `less`, `more`, `much less`, `much more` now, and the arrows carry
  priority 1 so that a narrower footer drops the rest first.

#### The sabotage pass: thirty-four, five survivors, and what each one meant

Each sabotage edits `slider.ts` so that it still type-checks, runs
`test/components/slider.test.ts` and `test/components/owned-hooks.test.ts`, and
puts the file back. Twenty-nine were caught on the first pass, among them: the
readout measured at the current value only, or at the ends only; a readout that
never widens; no `stop()` on a claimed key; keys taken while disabled; a page of
zero steps; no rounding back to the step's decimal places; the top of the range
rounded up past `max`; steps counted from zero rather than `min`; a move followed
without a press; a release that does not end the drag; the column read against
the canvas rather than the track; the press stopped, which took click-to-focus
away; a right press dragging; a press taken while disabled; the click left to
bubble; a drag left live by disabling; the focus role, the glyph swap, the mute
and `focusable` each left off; `onChange` called for a key that moved nothing;
`min-width: 0` taken off the track; the thumb placed over every cell rather than
every cell less one; `onResize` ignoring the room; `describeSlider()` with no scope
and with no validation; and the modifiers taken.

The five survivors:

1. **"Claimed only where it moves"**, the tab row's rule. The sabotage itself was
   wrong -- it added a variable and changed nothing. Rewritten to stop the event
   only when the value moved, it fails `should claim a key at the end it cannot go
   past`.
2. **"A release ends only a left drag."** A real hole in the test, not the
   component: `should end a drag on a release whose button was lost` passed
   `undefined` to a helper whose `button` parameter defaulted to `'left'`, so the
   release it sent had a button after all. The helper takes `null` for "no button"
   now, and the sabotage fails it.
3. **"No track basis."** `should be twenty columns in a row that gives it no width`
   passed without `flex-basis`, because the first draw is at twenty columns before
   anything has laid the track out, so a track sized by its own drawing is twenty
   too -- once. What the basis is for is the second layout: narrowed, a track sized
   by what it drew stays narrow. `should grow back to twenty columns when a row that
   was short is wide again` is the test it was missing, and it fails without the
   basis.
4. **"No `overflow: hidden` on the track."** Written in for a frame drawn wider than
   the room, and there is no such frame: the track draws exactly the room it was
   last given, and a frame dispatches `onResize` and lays out again before it
   paints. Deleted, which is the text field's own history with the same declaration
   in the other direction -- there it turned out load bearing, here it is not.
5. **"An app's write is not redrawn"**, with the effect that read the value deleted.
   Nothing failed, because the disabled effect also called `draw()`, and `draw()`
   reads the value, so that effect had been subscribed to the value all along. The
   value effect was dead. There is one drawing effect now, whose only line is
   `draw()`, and the disabled effect sets classes and nothing else; deleting the
   drawing effect fails three tests.

After those, the thirty-three that still have something to break -- the
`overflow` one has nothing left -- are all caught.

#### Through a real router

The handler tests call `onKey` and `onMouse` by hand, for the reason
`scroll-box.test.ts` gives. Four go through `createInput()` with a mouse surface,
because they are questions a hand-called handler cannot ask: that a Tab reaches
the slider; that a press focuses it, which is the router's default action and only
happens if the press is not stopped; that a drag reported at column 200 is still
delivered to the slider and the release out there ends it; and that a disabled
slider is out of the ring and not focused by a press. The key-help one renders the
real footer.

The live demo was driven once through a pty -- Tab, the arrows, Page Up and `q` --
to see that it draws, moves, and restores the terminal's modes on the way out. The
pointer was not checked that way; the router tests are what cover it.
