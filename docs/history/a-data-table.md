# A data table — how it was arrived at

The questions SIG-281 left open, the alternatives each one had, the probes and the
sabotage pass behind "A data table" in
[packages/sigil/src/components/AGENTS.md](../../packages/sigil/src/components/AGENTS.md).
The decisions are there; this is the record of how they were reached.

Built on SIG-280's branch, before that one merged, with the tree (SIG-282) being
built on the same base at the same time. So every change to `list-view.ts` and
`scroll-box.ts` had to be additive, and the brief was to compose rather than
modify.

#### The six questions, as the ticket put them

1. **Row identity.** Each row has a key: `key`, defaulting to the row. Requiring
   it was the alternative, since a live table without one loses its row on every
   tick. Refused because it would make the table's rule differ from the list's it
   stands on, for a mistake the prop's documentation names; a table of fixed rows is
   right without one.
2. **Built on the list, or beside it?** On it, which the brief had settled and the
   build bore out: the table has no line of its own about the cursor, the ticks or
   the scroll offset, and the live-rows tests pass through the list's `setRows()`
   and `follow()` alone. The sabotage that stops passing `key` to the list fails
   seven of them, which is the evidence that it is the list doing the work.
3. **Column widths.** `tableWidths()` is reused for the measuring and not for the
   policy. Over every row on every update it costs what windowing saves and makes
   a live column breathe; so it is called over the row objects not yet measured
   (a `WeakSet`) and the table keeps the widest each column has held. Fixed widths
   are `width`, flexible ones `grow`, minimum ones `minWidth`. A user resizing a
   column is the app writing a new `columns` array, which is a `State` when the
   app wants that; dragging is not done.
4. **Sorting.** A click on a heading and a digit, `selectRow()`'s three states,
   the arrow in two reserved columns, and `compare` per column. Other keys were
   weighed: htop's `<` and `>` to move the sort column and `I` to invert, k9s's
   Shift-letter per column, and a `s` that cycles as the system monitor's does. The
   digit won because `selectRow()` already taught it, it costs no mode, and it
   names a column directly; and because the table is only ever reached from the
   list, which claims no digit unless type-to-find is on -- so the table does not
   offer `find`.
5. **Wide tables.** Hide by priority rather than scroll. Sideways scrolling takes
   the identifying columns off screen first, and it needs a second offset kept in
   step between the heading and the rows: a change to the list and the scroll box,
   for an answer neither htop nor k9s gives.
6. **Cells.** `TableCellView` through `format`, the one `table()` and
   `selectRow()` already draw through `tableRowView()`.

#### Probes

- **The heading's indent.** Three ways to know how far a list row's content starts
  from its left edge: hard-code it in the table (two for the pointer, plus two or
  four for a mark), which copies `list-view.ts`'s glyphs into a second file; ask
  the layout for a built row's content offset, which fails where there is no row
  -- the empty state still shows the heading -- and reads a box the list owns; or
  ask the list. `listRowInset()` is the third, an additive export. It first used
  `stringWidth()`; it counts code points now, every glyph in `MARKS` being one
  cell, so that the list's own module does not import the width tables for four
  fixed strings. Measured with `staticGraph()`: `components/list-view` is
  226,274 B on this branch against the 209,306 B its ceiling records from SIG-280,
  and building without the data-table entry at all leaves it at 226,374 B -- so
  that difference is not this change's, and is under the 408 KiB ceiling either
  way. `components/table` went from 162,282 B to 165,515 B with `compareCells()`
  and `byCodeUnit()` moving into it; `components/data-table` is 235,819 B and has
  a ceiling of 464 KiB.
- **Live rows, and what "the scroll position survives" can mean.** The first htop
  test asserted the offset never moved while processes exited at random, and it
  failed partway through, one row off: processes exiting **above** the cursor carry its row
  up the screen, and once it would leave the top the view has to follow it or lose
  the selection off screen. The property that holds, and that the test now asserts
  on every one of thirty ticks, is that the offset is exactly `min(previous, the
  cursor's index)` -- it moves only when it must, and only by as much as it must --
  and that both kinds of tick happened. A second test holds a wheel scroll still
  through ten ticks of values changing with nobody exiting.
- **Widths measured each tick.** The `WeakSet` means an update measures the row
  objects it has not seen, so data that replaces a few rows a second measures a
  few. A process list that replaces every row every second, as the demo's does,
  still measures all of them; the documentation says so and points at `width`,
  which skips measuring, and the test that a declared width is never formatted to
  be measured holds that (six rows formatted for a thousand-row table, all of them
  the rows on screen).

#### Sabotage: ten, ten caught

Each edit type-checks, and each was reverted by hand from a copy.

| sabotage                                     | fails |
| -------------------------------------------- | ----- |
| `key` not passed to the list                 | 7     |
| a column's width not kept from tick to tick  | 1     |
| leftmost hidden first among equal priorities | 2     |
| a hidden column's digit still sorts          | 1     |
| `cellOrder()` without the empty-last rule    | 3     |
| no two columns kept back for the arrow       | 8     |
| `listRowInset()` forgets the mark's space    | 2     |
| the digits described once and never again    | 1     |
| the leftmost column narrowed first on a tie  | 1     |
| columns hidden before any is narrowed        | 2     |

The empty-last sabotage fails `select-row.test.ts` as well as the table's, which
is the evidence that the two sorts share one comparator rather than two copies.
