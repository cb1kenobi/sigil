# Dashboard

A dashboard in a terminal, with the parts a web developer expects from one: a
collapsible sidebar of pages, a header with a search field and an account menu,
four cards with trend badges, a chart of the last 7, 30 or 90 days, and a table
of projects with sorting, ticked rows, pages and a menu on each row. It comes in
the terminal's own colours, in light, and in dark.

```
pnpm build
node examples/dashboard/dist/dashboard.mjs
```

Or `pnpm start` from this directory. It is written in JSX, so it runs as
`sigil build` compiled it; `pnpm build` from the repository root builds
`@ttylabs/sigil` and this together. `q` exits 0 and Ctrl-C exits 130. Without a
terminal on both ends, `runApp()` refuses: one line on stderr, exit 1.

There is no server behind it. The numbers are half a year of made-up traffic for
a small hosting platform, Larkspur, and the forty-six projects running on it,
generated from a seed and ending on a fixed day, 16 November 2026. So the screen
is the same on every run, and changes made from the row menu last as long as the
screen is open.

| Key             | Does                                                                     |
| --------------- | ------------------------------------------------------------------------ |
| Tab, Shift-Tab  | Move between the sidebar, the search, the menu, the range and the table  |
| ↑ ↓             | In the sidebar, show another page; in the table, move the cursor         |
| `/`             | Go to the search                                                         |
| Enter           | In the search, go to the table; on a row, open its menu                  |
| Escape          | In the search, clear it, or go to the table when it is empty             |
| Space, Ctrl-A   | Tick the current row; tick every row on the page                         |
| `1` to `6`      | In the table, sort by that column: from the top, the other way, unsorted |
| `[` `]`         | The page before and after                                                |
| `r`             | The next range: 7, 30 and 90 days                                        |
| ← →, `1` to `3` | With the range focused, pick one                                         |
| `t`             | The next theme: the terminal's own, light, dark                          |
| Ctrl-B          | Collapse the sidebar to its glyphs, or bring it back                     |
| `q`             | Quit, with 0, unless the search has the focus and takes the `q`          |
| Ctrl-C          | Quit, with 130                                                           |

The mouse works throughout: a click picks a page, a range, a heading to sort by,
a row to tick or a button, and a double click on a row opens its menu.

## What it shows

- **The cards and the chart move together.** The range is one signal, which the
  tab row over the chart writes and `r` cycles. Each card is that range's figure,
  a badge with the change against the range before -- green when it is good news,
  red when it is not, so a falling error rate is green -- the figure it changed
  from, and a sparkline of the days. The last card is about now rather than a
  range: the projects that are not paused, the degraded ones in its badge.
- **The table pages the whole list, not one page at a time.** A sort by a
  heading orders every project and the page is cut from that, so page two carries
  on from page one. The search narrows the same list, and goes back to page one.
  Ticks are kept by project, so rows ticked on two pages are still ticked on a
  third, the bar under the table counts them, and the row menu's Ticked submenu
  pauses, resumes or deletes all of them.
- **The row menu changes the data.** Pause and Resume, Redeploy and Star write to
  the project, and every region that reads it follows: the row's status, the
  last card's count, and a resumed project comes back degraded if its error rate
  says so. Delete asks first, and the question opens on No.
- **Light and dark are the app's, not the terminal's.** The terminal's own
  colours are the first theme. Light and Dark paint their own background, set
  the colour of each role the framework draws with, and fill the menus, the
  dialog and the toasts, so a light dashboard on a dark terminal is light all
  over. Each also tells the renderer which scheme it is with
  `view.setColorScheme()`, so the framework's own `prefers-color-scheme` rules
  and every component that reads the scheme follow the theme rather than the
  terminal; System hands the choice back.
- **It fits the terminal it is given.** The sidebar starts collapsed under 100
  columns. On a short terminal the sparklines go first, then the chart, then the
  line under each figure, and the table keeps its rows; on a narrow one a column
  of the table goes, the owner first.

## Layout

| File               | What it is                                                                      |
| ------------------ | ------------------------------------------------------------------------------- |
| `src/index.ts`     | The schema `sigil build` compiles: `runApp()` as its `run`, mouse on            |
| `src/root.tsx`     | `App`, the whole screen: the keys, the pages, and `stylesheet`                  |
| `src/sidebar.tsx`  | The pages, the plan's usage, and collapsing                                     |
| `src/header.tsx`   | The page's name, the search, and the account menu                               |
| `src/cards.tsx`    | The four cards and their badges                                                 |
| `src/traffic.tsx`  | The chart and its range                                                         |
| `src/projects.tsx` | The table, the bar under it, and the row menu                                   |
| `src/model.ts`     | `createDashboard()`: every signal the screen reads, and the sort, search, pages |
| `src/metrics.ts`   | The cards' arithmetic and how a figure is written, as plain functions           |
| `src/data.ts`      | The made-up traffic and projects                                                |
| `src/themes.ts`    | Light and dark                                                                  |
| `test/`            | The data and the state on their own, and the app over a fake terminal           |

## What it works around

Each is marked in the source.

- **The table is sorted and paged before `DataTable` sees it.** The table sorts
  the rows it is handed and has no pages, so `src/model.ts` sorts the whole list
  with the table's own comparator, `cellOrder()`, over the sort the table writes,
  and hands it one page.
- **The row menu finds its row by class.** Nothing hands out the element a
  table's row was built as, so the menu walks the table for the `sigil-list-row`
  that is `is-current` to open under its right end.
- **A card's badge follows its figure.** Each card hands `Badge` the label and the
  variant as functions over one `Computed`, and the badge rewrites its own text and
  classes when the figure moves.
