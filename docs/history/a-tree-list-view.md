# A tree list view — how it was arrived at

The questions SIG-282 left open, the alternatives each had, the probes and the
sabotage pass behind "A tree list view" in
[packages/sigil/src/components/AGENTS.md](../../packages/sigil/src/components/AGENTS.md).
The decisions are there; this is the record of how they were reached.

Built on SIG-280's branch, before that one merged, while SIG-281's table was being
built on the same base elsewhere -- which is why "change nothing in `list-view.ts`
or `scroll-box.ts`" was a constraint rather than a preference, and why it held.

#### Which of SIG-280's two layers to stand on

SIG-280 published two: `createListSelection()` with `ScrollBox` underneath, for a
component that draws its own rows, and `ListView` with a `row` function. The lower
one would have meant writing the cursor's paint, the pointer, the ticks, the focus
role, the click and double-click, `find`, `vim` and the empty state a second time,
which is the second answer the ticket's first question exists to avoid. What the
tree needed from a list turned out to be exactly what `ListView` already takes:

- rows as items, re-keyed when a `State` of them changes -- the walk's output;
- a row function -- the guide, the twisty and the label;
- `disabled` -- which is all a loading or error line needs to be passed over;
- the selection states passed in, so the tree and the app hold the same ones.

So nothing was added to either file. Three things were checked rather than
assumed: that a row element under the row function can stop a click before the
list's row handler sees it (the hit test returns the deepest element and the event
bubbles, and SIG-280 left a sentence saying so); that `ListView` uses a `State`
handed to it as `current` rather than copying it (`instanceof State`, so
`treeListControl(tree).current` is the app's own); and that a rebuilt row record
with the same contents would still rebuild the element (it would -- the token is
per item object -- which is why rows are reused by the walk rather than compared
by the list).

#### Where the tree's keys go

The brief said an element around the list. Built that way first on paper, it
returns a wrapper: the app's `props` -- a height, a border, a `:focus` rule --
land on a box that never has the focus, `describeListView()` and `listControl()`
need the inner element, and the caller holds two elements for one control. Reading
the list's `onKey` and putting back a function that calls it first is the wrap the
root `AGENTS.md` documents for every hook, and it keeps one element. The tree's
handler looks at `event.stopped`, so anything the list claimed -- including every
letter under `find` -- is the list's.

#### The cursor when a branch closes

The list's rule for a vanished key, the row that took its place, was probed on the
sample tree with the cursor on `src/lib/y.ts` and `src` closed by the app: the row
at that index afterwards was `README.md`, two branches away. That is the case the
brief flagged. Two shapes of fix:

1. **Move the cursor in each place that closes a branch** -- Left, the twisty,
   `collapse()`. Misses the app writing the `expanded` state, which the ticket asks
   to be a first-class way of driving the tree, and misses `reload()` on an open
   branch whose children vanish under a loading line.
2. **Decide it after the walk, from what the walk found.** The parents the last
   walk recorded say where the cursor's node was; the first ancestor the new walk
   still shows says whether it was closed over (it shows no children) or the node
   was deleted from it (it does). Built: one place, every route.

The deleted case is the other half and has its own test, because "always go to the
nearest shown ancestor" passes every closing test and is wrong for a file deleted
from an open directory -- the sabotage below that does exactly that fails only that
test.

#### Lazy branches: what a failure looks like, and what a close does to a read

`selectTree()` closes a branch whose read failed and writes the message under the
question. The element has no question. A status line of the tree's own was
considered and not built: it is a second line of chrome every tree pays for, and
the reader is looking at the branch they opened. A row under the branch was built.
Keeping the branch open is what gives that row a place. Right on it reads again,
since an open branch with no children has nothing else for Right to mean, and the
walk drops a failure on any branch it finds closed, so close-and-open by any route
reads again.

A close during a read was probed with a deferred promise: the read is left to
land, and the branch opens on it at once. Cancelling through an `AbortSignal`
handed to the function was considered and refused for the reason recorded, and
because the function shape is `selectTree()`'s, which takes no argument. What a
superseded read must not do is land over the read that replaced it, which needed a
run number -- the first version of the test resolved the newer read first, so a
missing run check could not be seen; it now resolves the stale one first and asks
for the loading line still to be there.

#### `directoryRoot()`, and a cache that would have made `reload()` a no-op

The demo browses a directory with the walk `directoryTree()` already had, which was
a closure inside it. Exporting it as `directoryRoot()` was the obvious move, and it
carried one cache per root: every directory read once and kept. That was invisible
in the prompt, which calls each branch's function once, and fatal to the element's
`reload()`, which calls it again and would have got the same entries back. Each
call now reads through a cache of its own. `tree.test.ts`'s check that a directory
is read only when it opens passes unchanged.

#### Probes

- The demo run in a pty (`python3 -I` driving `node demos/components/64-tree-list-view.js
  packages/sigil/src` through `pty.fork()`): Down, Right, Right, Down, `c`, Left,
  `q`. It drew, opened `ansi/`, closed everything on `c` with the cursor on the
  root, and exited 0.
- `components/tree-list-view` measured **289,948 B over 45 modules** when it was
  added -- `tree.ts`'s graph and the list view's, which it imports -- and its
  ceiling is 568 KiB. `components/tree` moved from the 262,589 B its ceiling
  records to 268,068 B, the new exports, under the 512 KiB it had.

#### Sabotage: twelve, twelve caught

Each made in `src/` so that it still type-checks, the file run, and reverted from a
saved copy:

| sabotage                                               | failed |
| ------------------------------------------------------ | -----: |
| the cursor not moved to the branch that closed over it |      2 |
| the cursor always moved to the nearest shown ancestor  |      1 |
| a failed read kept on a closed branch                  |      1 |
| a superseded read allowed to land                      |      1 |
| a read allowed to land after the owner was disposed    |      1 |
| rows never reused across walks                         |      1 |
| the twisty's click not stopped                         |      3 |
| a node's own `expanded: true` ignored                  |      4 |
| Right on a failed branch not reading again             |      1 |
| Left on a node not stepping to its parent              |      4 |
| a function returning a list treated as a promise       |      3 |
| `directoryRoot()` with one cache per root again        |      1 |
