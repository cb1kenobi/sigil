# A text area: the multiline prompt's editor in a tree — how it was arrived at

The measurements, the settling of the ticket's open questions and the sabotage
pass behind "A text area: the multiline prompt's editor in a tree" in
[packages/sigil/src/components/AGENTS.md](../../packages/sigil/src/components/AGENTS.md).
The decisions are there; this is the record of how they were reached. SIG-283.

Machine: arm64 macOS, node 26.10.0, with eight other agents building alongside,
so the milliseconds are worth reading against each other rather than as absolutes.
Every figure is the built package (`dist/`), driven through a real router over
`createTestTerminal()` and drawn with `renderToString()` at 80 by 24.

#### The questions the ticket left open

- **Element first, or the shared editor?** Element first, as SIG-215 answered for
  the single line, and the prompt not moved. What is shared is every rule --
  `editing.ts`, `layoutField()`, `offsetIn()`, the highlight types and roles --
  and what is not is the shape, which differs here for a reason SIG-215 did not
  have: the prompt wraps and the area must not (below).
- **An array of lines, or a rope?** An array of lines. The first sketch kept the
  value as one string, as the prompt does, and fell over on the first measurement:
  `layoutField()` over the 2.7MB of a 50,000-line file takes 1.66 seconds, and
  that is before a single cell is painted. Lines make a window possible; a rope
  would make an edit inside one huge string cheap, and with lines there is no such
  string.
- **The highlight seam.** `multiline()`'s hook, unchanged, so SIG-289 finds four
  seams that already agree on `HighlightSpan` and the token roles.
- **Keys it claims.** Enter is a newline; Tab is the ring's unless `tab` is given;
  Escape and Shift-Tab are never the area's.
- **Selection and the clipboard.** A selection of its own over the value, drawn by
  the screen selection's `selectedStyle()`, copied and cut through `onCopy` with
  Ctrl-Y and Ctrl-X.

#### Scrolling a long buffer

A page down and the frame after it, averaged over 200, the value a line of 50
characters repeated; "State" is a `State` handed in, which makes every edit join
the lines into a string:

| buffer        | page and frame | key and frame | frame, nothing changed |
| ------------- | -------------- | ------------- | ---------------------- |
| 10 lines      | 0.42ms         | 0.30ms        | 0.14ms                 |
| 100 lines     | 0.61ms         | 0.56ms        | 0.13ms                 |
| 50,000 lines  | 0.65ms         | 0.56ms        | 0.16ms                 |
| 100, State    | 0.71ms         | 0.70ms        | 0.18ms                 |
| 50,000, State | 0.68ms         | 1.27ms        | 0.23ms                 |

Ten lines is the odd row out because ten lines fit and a page moves nothing; a
hundred is the fair comparison, and 50,000 scrolls like it. The one column that
grows is a keystroke with a `State`, by the 0.6ms it takes to join 2.7MB --
which is why a bare area never joins. `text-area-window.test.ts` holds the claim
by counting: a frame of the 50,000-line value calls `layoutField()` at most once
per row on screen and once more for the caret's column, and a frame nothing
changed calls it not at all.

Building the 50,000-line area took 72ms on a cold process and 4ms warm. Before
`pastedBlock()` changed, the normalizing alone was 188ms of that: it segmented
the whole value into grapheme clusters to drop the ones that are a lone control
character. A control character is always a cluster of its own -- UAX #29 breaks
before and after every one, and CR LF, the one pair it keeps, is gone by then --
so dropping those clusters and dropping the control characters are one rule. Two
passes of a pattern do it in 3 to 5ms. A fuzz of the old form against the new over
200,000 strings of up to eight characters drawn from combining marks, ZWJ, ZWNJ,
regional indicators, prepends (U+0600, U+0D4E), soft hyphens, CR, LF, tab, NUL,
ESC, NEL, DEL, the line separator and CJK found no string they disagree on.

#### Highlighting a long buffer

The demo's highlighter is a regex over keywords, strings and numbers, which on
50,000 lines names 150,000 spans:

| step                                                 | time  |
| ---------------------------------------------------- | ----- |
| the hook itself                                      | ~10ms |
| checking every span's name with `tokensOf()`         | ~2ms  |
| `tokensOf()` over the whole value (the prompt's way) | ~53ms |
| a keystroke and its frame, first version             | ~25ms |
| a keystroke and its frame, as shipped                | ~20ms |

The first version filed spans with `Array.from({ length })` and checked every
name; `new Array()` and checking each name once took a fifth off. The prompt's
`tokensOf()` builds an array as long as the value, which is the 53ms the area
does not pay. A page through a highlighted buffer costs what an unhighlighted one
does: 0.17ms for the keys and 0.97ms for the frame at 50,000 lines, against 0.78ms
at 100. What is left is O(value) because the hook is, and an incremental hook is
SIG-289's.

#### What the tests found while they were being written

- **The caret and a selection disagreed by a cell.** Shift-Left three times from
  the end of `world` selects `rld`, and the picture showed `ld`: the caret marks
  the `r`, and the selection's toggle un-reversed it. Painted the other way round,
  a selection running forwards showed one cell more. The caret is not drawn while
  something is selected.
- **The selection layer made the text uncopyable.** It is absolute over the text,
  and a `raw` that does not say `drawsText` covers every cell under it with a
  "not selectable". Found by the gutter test, which asked about a text cell as
  well as a gutter one.
- **A wheel notch before the frame that would have followed a key scrolled from
  the wrong place.** Ctrl-Home and then a notch, with no frame between, left the
  view at the bottom: the follow was still pending, and the frame applied it after
  the wheel had moved the view. The wheel now settles a pending follow first.
- **A paste of 200,000 lines did not overflow vitest's stack** while a plain node
  overflows at that size (`splice()` takes its arguments on the stack). The test
  pastes 500,000, which overflows both, so the sabotage that puts the spread back
  is caught.

#### The sabotage pass

Each was applied to `text-area.ts` alone, type-checked, and the two test files run.

| sabotage                                                  | result          |
| --------------------------------------------------------- | --------------- |
| lay out every line instead of the window                  | caught (1)      |
| no follow in the frame                                    | caught (11)     |
| a selection drawn at colour level 0                       | caught (1)      |
| the selection layer without `drawsText`                   | caught (1)      |
| the caret drawn inside a selection                        | caught (2)      |
| Tab always typed                                          | caught (1)      |
| Ctrl-Y and Ctrl-X claimed without `onCopy`                | caught (1)      |
| a pasted Tab moving the focus                             | caught (1)      |
| a paste's breaks flattened                                | caught (2)      |
| the goal column cleared by a vertical move                | caught (1)      |
| word left, and word right, kept to the line               | caught (1 each) |
| `splice(...next)` for a paste                             | caught (1)      |
| no highlight on an app's write                            | caught (1)      |
| a highlight on every redraw                               | caught (1)      |
| the gutter painting the caret's number too                | **survived**    |
| the active number's layer painting nothing                | caught (4)      |
| the wheel not settling a pending follow                   | caught (1)      |
| the wheel claimed when the lines fit                      | caught (1)      |
| the press stopped                                         | caught (1)      |
| an arrow not collapsing a selection                       | caught (1)      |
| `min-width: 0`, `min-height: 0` on the host               | **survived**    |
| `overflow: hidden` on the host                            | **survived**    |
| `min-width: 0`, `min-height: 0` on the body               | **survived**    |
| `min-width: 0`, `min-height: 0` in the text layer's props | **survived**    |
| the text measure's `minHeight: 0`                         | caught (5)      |
| the text measure's `minWidth: 0`                          | caught (2)      |
| the caret's cell not muted on the placeholder             | caught (1)      |
| no focus role on the caret                                | caught (2)      |
| a wide cluster at the left edge drawn                     | caught (1)      |
| a selected line break not drawn                           | caught (1)      |
| Ctrl-K joining the next line                              | caught (1)      |
| Delete, and Backspace, not joining lines                  | caught (1 each) |
| a token name not checked                                  | caught (1)      |
| a span clipped to the value                               | **survived**    |
| no `onChange`                                             | caught (1)      |
| an app's write keeping the caret at the start             | caught (26)     |
| a disabled area taking keys                               | caught (1)      |
| a page not moving the view                                | caught (1)      |

Forty-two, a row that says "and" being two of them; thirty-four caught. Two sabotages
first written as `if (false)` failed the type-check rather than a test, and were
rewritten to ones that compile -- `Math.random() < 0`, `active === -1` -- before
counting them. The wide-cluster sabotage first survived too, because a cell drawn
one column left of an area at column zero is off the canvas; the test now puts a
gutter mark there for the half to land on.

The survivors: the six size declarations were deleted, because together they were
redundant with the one that is load bearing -- removing all of them at once fails
seven tests, and removing them all except the text measure's minimum fails none.
The span clip was deleted, since a span past either end is filed under the first
or last line and marks only the cells there are. The gutter leaving the caret's
number to the layer that paints over it is the prompt's declared case, kept so
each cell has one writer.

`pastedBlock()`'s pattern, sabotaged three ways -- the tab dropped, the line break
dropped, nothing dropped -- fails 4, 72 and 3 tests across the component suite.
