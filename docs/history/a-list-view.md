# A list view — how it was arrived at

The questions SIG-280 left open, the alternatives each one had, the measurements
and the sabotage pass behind "A list view" in
[packages/sigil/src/components/AGENTS.md](../../packages/sigil/src/components/AGENTS.md).
The decisions are there; this is the record of how they were reached.

Machine: arm64 macOS, node 26.10.0, with eight other agents building alongside,
so the milliseconds below are worth reading against each other and not as
absolutes.

#### The brief that shaped the API

The table (SIG-281) and the tree (SIG-282) were to be built on this branch by
other hands, and both tickets say the obvious answer is to share the list's
virtualization and keyed selection. So the question for every decision was not
only "is this right for a list" but "can a table re-sorting every second, and a
tree whose visible rows are an expanded subset with lazy children, use it without
a second answer". That is why the selection is a layer of its own with no
elements in it, why its rows are handed over rather than read out of an items
array, and why the selection is never pruned.

#### Where the keyed rows live: three shapes tried on paper, one built

The scroll box kept a built row by its **index**, and a row that stays in the
window is never rebuilt. That is right for a log and wrong for anything re-sorted:
the probe that found it was a reversed list painting the old rows in the old
places until something scrolled. Three ways to give rows identity:

1. **A container per index, refilled by the list.** `row(i)` returns a box the list
   keeps, and when the data changes the list refills every live box. It needs the
   list to know which boxes the scroll box has pruned, which the scroll box does not
   say, so the list would read `parent` pointers to guess. Refused: a guess at
   somebody else's bookkeeping.
2. **A `refresh()` on the scroll box that drops every built row.** Simple, and it
   throws away the property the window is built around -- a row that stayed is the
   same row -- on every update, so a table updating every second would rebuild every
   visible row every second whether its data moved or not.
3. **`ScrollRows.key(index)`.** The built-row map keyed by what a row is, and the
   window's keys added to the unchanged-window guard. A re-sort moves the rows that
   stayed and builds only new keys; nothing else in the scroll box changed. Kept.

The list then needed "rebuild this row because its item changed" without a second
mechanism, and the answer was to make that a key too: a token per row key,
replaced when the item at that key is a different object. So one rule -- a key the
scroll box has not seen is built -- covers a re-sort, a new row and an updated one.

#### Ownership: found while writing the row function's doc

The row function's doc was going to say "may hold effects", and checking it found
that a row built by a wheel notch runs inside `scrollTo()`, with no owner: an
effect created there is never disposed. `ListView` could have built its rows under
branches itself, but disposing them needs to know when the scroll box prunes one,
which is the same problem as shape 1 above. So the scroll box builds each row
under a branch of the owner it was itself built in and disposes it on prune --
`For`'s rule -- and the list hangs its bookkeeping (`live`, the tokens) on
`onCleanup()` in the row's own owner, guarded so a row rebuilt for a new item,
whose old branch is disposed after the new one is built, does not take the new
one's entry with it.

The cost was measured with `staticGraph()` off a build: `components/scroll-box`
went from 136,485 B to 174,349 B over 28 modules, because it imports the renderer
now. `tabs`, `pager` and `pane` already did. `components/list-view` measured
209,306 B over 33 modules when it was added.

#### Following the cursor, and the update that should not scroll

The first version revealed the current row whenever the items changed. A probe
with a list updating every second showed the problem at once: scroll away with the
wheel and the next update snapped the view back to the cursor. The rule became
"follow the cursor when its key or its position changed": a live update leaves the
view alone, a re-sort that carries the current row elsewhere is followed. A clamp
for a list that shrank under a scrolled view was written for the second case, and
the sabotage pass found its first test passing without it -- the cursor had moved
in that test, so the reveal clamped instead. A second test with the cursor
deliberately left on row 0 is the one that pins it.

#### Type-to-find off by default: the `q` argument

Turning it on by default was the first draft. What decided it was the dispatch
order in `src/input`: a focused element's `onKey` runs before the fallbacks, and
`runApp()`'s `quitKey` is a fallback. A list that claims every printable key would
stop `q` quitting the app as soon as it had the focus -- the exact failure SIG-308
added fallbacks to fix. The same goes for `j`/`k`, which is why vim keys are
opt-in too and why the two together are refused.

#### Measured

`ListView` over objects keyed by id, 80x24, `renderToLines()` per step, medians:

| rows    | first frame | move 30 rows | 50 items replaced and re-sorted |
| ------- | ----------: | -----------: | ------------------------------: |
| 1,000   |   (warm-up) |      2.26 ms |                         1.92 ms |
| 10,000  |     2.83 ms |      1.54 ms |                         1.66 ms |
| 100,000 |     7.05 ms |      1.25 ms |                         7.65 ms |

The last column includes the caller's own sort of the whole array and the
selection's key map, both `O(n)`, which is what dominates at 100,000; the rows
built are the same two dozen at every size.

#### The sabotage pass

Each change below was made by hand, the list and scroll-box tests run, and the
change put back. Seventeen, all caught once the second clamp test existed:

| sabotage                                               | failures |
| ------------------------------------------------------ | -------: |
| scroll box: window keys not compared in the guard      |        4 |
| scroll box: a pruned row not disposed                  |        3 |
| scroll box: a row built with no owner                  |        3 |
| scroll box: rows cached by index whatever `key` says   |        4 |
| selection: a vanished key sends the cursor to the top  |        3 |
| selection: duplicate keys accepted                     |        1 |
| selection: no rows clears the key                      |        1 |
| selection: `setRows()` prunes `selected`               |        2 |
| list: the view follows on every update                 |        1 |
| list: a row keyed on its key alone, not its item       |        1 |
| list: a double-click's second click untoggles          |        1 |
| list: Shift with a move read as the plain move         |        1 |
| list: the focus role not painted                       |        1 |
| list: no clamp after the list shrank (before the test) |        0 |
| list: no clamp after the list shrank (after)           |        1 |
| list: a reveal before a layout never retried           |        1 |
| list: one letter pressed again starts at the cursor    |        1 |
| list: moves claimed on a list with no rows             |        1 |
