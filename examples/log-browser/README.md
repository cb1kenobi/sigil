# Log browser

A full-screen browser in the shape of k9s and lnav. It has a live table of
resources that you filter and drill into, and a live stream of log lines that
you follow, filter and search. The cluster is simulated, so nothing has to be
running. It can read and follow a local log file instead.

```console
$ pnpm build
$ pnpm start                     # the JSX twin, built by sigil build
$ pnpm start:ui                  # the ui-tag twin, run by plain node
$ pnpm start /var/log/app.log    # a log file, read and followed
$ pnpm start --mouse             # the wheel scrolls and a click picks a row
```

Run these from this directory. `q` exits with 0 and Ctrl-C with 130. Without a
terminal on both ends, `runApp()` refuses: one line on stderr, and exit 1. A
file that cannot be read is refused before the screen is taken.

The mouse is off unless you pass `--mouse`. While a terminal reports the mouse
to an app, it stops doing its own text selection, and copying a line out of a
log is half of why you open one.

## Keys

Everywhere:

| Key    | Does                                                                   |
| ------ | ---------------------------------------------------------------------- |
| `:`    | The command bar. `pods`, `svc`, `deploy`, `logs`, `quit`, or near them |
| Tab    | In the command bar, complete to what the hint says                     |
| Escape | Close the bar, clear a filter or a search, then go back a view         |
| `q`    | Quit, with 0                                                           |
| Ctrl-C | Quit, with 130                                                         |

A table (pods, services, deployments):

| Key                    | Does                                                          |
| ---------------------- | ------------------------------------------------------------- |
| ↑ ↓ PgUp PgDn Home End | Move                                                          |
| `1`-`9`                | Sort by that column, then the other way, then back as it came |
| Enter                  | Describe the row, in a pager. `/` searches it, Escape returns |
| `/`                    | Filter by namespace and name, fuzzily, as you type            |
| `l`                    | The current pod's logs                                        |

The log:

| Key         | Does                                                                      |
| ----------- | ------------------------------------------------------------------------- |
| ↑ PgUp Home | Move up, which stops following                                            |
| End, `F`    | Back to the newest line, following again. `F` also stops following        |
| `/`         | Search. Enter goes to the next line that matches. An empty search repeats |
| `n` `N`     | The next and the previous match, wrapping at the ends                     |
| `&`         | Show only the lines that match. An empty filter shows them all            |
| `L`         | Show only this level and worse: debug, info, warn, error, then all again  |

A query is read the way the pager reads one. It is literal, so `.` and `(` are
themselves. It is smart case, so `error` matches either case and `Error`
matches only that. Both the log and the describe pager call `searchPattern()`
from `@ttylabs/sigil/components`, so they agree.

## What it shows

- **A table that changes under you and keeps its place.** The pods get a new
  reading every second, and a pod crashes now and then. Each table is a
  `DataTable` keyed by namespace and name and built with `follow`, so the
  cursor stays on its pod through every reading, as k9s keeps it. Sorted by
  CPU, the pods change places every second and the cursor goes with its pod.
  A pod that goes, as one does in a rollout, hands the cursor to the row that
  took its place.
  A table's own default is htop's, which holds the cursor's place on screen and
  lets the rows move under it. A pod in trouble is drawn in the error or
  warning role across its whole row, as k9s draws one, through the table's
  `rowClass`.
- **A command bar with fuzzy matching.** `:dpl` finds `deployments`. Commands
  are matched with `rankBy()`, the ranking the command palette uses.
- **A drill-in.** Enter on a row opens `kubectl describe` for it in a pager,
  built for that row and disposed when you leave.
- **A log that follows.** The cursor sits on the newest line, and new lines
  bring it with them. Move up and it stops, and the title says `paused`. End
  or `F` starts it again. With `--mouse`, a wheel scroll up stops it too,
  rather than the next line pulling you back down. All of that is the
  `ListView`'s `tail` prop; the app holds the state for the label and `F`.
- **Levels in colour.** A line is drawn in its level's role (`sigil-error`,
  `sigil-warn`, `sigil-muted`), so a theme recolours it. What a search matched
  is drawn reversed.
- **Tens of thousands of lines.** The simulated log opens with 50,000 lines of
  history and holds up to 200,000. Only the lines on screen are built.

## How much a line costs

`scripts/measure.ts` times what a reader does to the log at four sizes of
history: a batch of new lines arriving, a page up, a search and the `n` after
it, and a filter. Each figure is the work and the frame that draws it, by wall
clock, at 120 by 40. Run it with `node scripts/measure.ts` after `pnpm build`.

As of SIG-295, on node 26.10.0 on an Apple M5 Pro, the quietest of several
runs printed this. Other agents were running suites on the machine, so later
runs were up to twice as slow at every size.

| lines   | open ms | append ms | page up ms | search ms | n ms | & ms  | elements |
| ------- | ------- | --------- | ---------- | --------- | ---- | ----- | -------- |
| 500     | 47      | 5.01      | 2.83       | 20.99     | 4.31 | 23.74 | 597      |
| 5,000   | 17      | 4.68      | 3.69       | 17.65     | 4.17 | 21.38 | 598      |
| 50,000  | 98      | 6.59      | 2.77       | 20.65     | 3.86 | 19.98 | 597      |
| 200,000 | 342     | 17.90     | 3.43       | 36.53     | 7.40 | 32.65 | 598      |

At 50,000 lines, a batch cost 1.6 ms more than at 500, and the tree held the
same number of elements. Most of a batch at any size was the frame itself. A
batch did grow with the lines held. At 200,000 lines, about 11 ms of the 18
went on `ListView` re-keying every row. The search and the filter each include
a forced frame for opening the prompt line and another for closing it.

As of SIG-386, a batch costs about the same at every size. `ListView` tells
when its new items are the old ones with some dropped off the front and some
added at the end. Then it keys only the added items and the first one, which
is how it finds where the old ones start, and its selection places only the
added keys. It still compares every kept item and every kept key with the
ones it had, which is two comparisons a line and no hashing. The log also
stopped testing every line it shows to find the ones the cap dropped, since
those are all at the front. The figures are the
best of six runs of each build, taken in turn on node 26.10.0 on an Apple M5
Pro, while other agents were running suites on the machine:

| lines   | append ms before | append ms after |
| ------- | ---------------- | --------------- |
| 500     | 3.01             | 2.96            |
| 5,000   | 2.61             | 2.37            |
| 50,000  | 4.15             | 2.49            |
| 200,000 | 12.29            | 3.52            |

At 200,000 lines the log is at its cap, so every batch drops lines off the
front as well as adding them, which is the case the change had to cover. What
is left at that size is about half a millisecond more than at 500 lines. It is
copying arrays of 200,000 lines: the log's own, the lines shown, and the
list's keys. The other columns did not move.

`fifty thousand lines` in `test/app.test.ts` asserts the part that does not
depend on the machine: the tree holds fewer than 2,000 elements with 50,000
lines in the log.

## Layout

| File                 | What it is                                                         |
| -------------------- | ------------------------------------------------------------------ |
| `src/index.ts`       | The schema `sigil build` compiles, over the JSX root               |
| `src/ui.ts`          | The same schema over the `ui`-tag root, which Node runs unbuilt    |
| `src/root.tsx`       | `App` in JSX: the markup, and nothing else                         |
| `src/root.ui.ts`     | `App` in the `ui` tag, the same elements in the same order         |
| `src/browser.ts`     | `useBrowser()`: the state, the keys and the clock both roots share |
| `src/cluster.ts`     | The simulated cluster: seeded, on its own clock                    |
| `src/logs.ts`        | Log lines: levels, filtering, search, and following a file         |
| `src/common.ts`      | The stylesheet                                                     |
| `scripts/measure.ts` | The figures above                                                  |
| `test/`              | The pure parts, and both roots over a test terminal                |

`App` takes no props. It reaches the world through `EnvironmentContext`: the
clock, the history size, the cap, the seed and the file. A test provides one
with a clock it turns by hand. The simulated cluster has its own time, starting
at 09:00 UTC on the day this was written, and every choice comes from a seeded
generator. Two runs are the same run, line for line, which is what lets the
smoke test compare the two syntaxes' first screens.

## Not yet

- A real cluster. The resource and log shapes are `kubectl`'s, and that is as
  far as it goes.
- The log in a pager. The pager reads its document once, and has no filter and
  no colour per line (SIG-387), so the log is a `ListView` with its own search.
