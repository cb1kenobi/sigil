# File manager

A file manager in Miller columns: the directory above, the one you are in, and a
preview of whatever is selected. Text is previewed with syntax highlighting and
line numbers, Markdown rendered, a PNG drawn in half blocks, and a directory as
its listing. Copy, move, rename and delete, each behind a confirm; a filter; and
dot files shown or not.

```console
$ pnpm build
$ pnpm start                 # the JSX twin, built by sigil build
$ pnpm start:ui              # the ui-tag twin, run by plain node
$ pnpm start ~/Pictures      # somewhere else
$ pnpm start ./README.md     # beside a file, with the file selected
```

Run these from this directory, which is where it opens unless it is told
otherwise. `q` exits with 0 and Ctrl-C with 130. Without a terminal on both ends
`runApp()` refuses: one line on stderr, exit 1.

## Keys

The column you are in:

| Key                | Does                                                             |
| ------------------ | ---------------------------------------------------------------- |
| ↑ ↓, `j` `k`       | Move; the preview follows                                        |
| PgUp PgDn, `g` `G` | A page, the first row, the last row                              |
| `l`, →, Enter      | Into a directory; on a file, to its preview                      |
| `h`, ←, Backspace  | Up to the directory above, the cursor on the one you left        |
| `y`                | Copy the selection: `p` pastes it                                |
| `x`                | Cut the selection: `p` moves it                                  |
| `p`                | Paste what `y` or `x` holds into this directory, after a confirm |
| `r`                | Rename, in a dialog                                              |
| `d`, Delete        | Delete, after a confirm that starts on No                        |

Anywhere:

| Key    | Does                                                                      |
| ------ | ------------------------------------------------------------------------- |
| `/`    | Filter this directory by part of a name; Enter keeps it, Escape clears it |
| `.`    | Show or hide dot files                                                    |
| `R`    | Read the directory again                                                  |
| Tab    | Between the column and the preview                                        |
| `q`    | Quit, with 0                                                              |
| Ctrl-C | Quit, with 130                                                            |

In the preview, the arrows and PgUp and PgDn scroll it, and `h`, ← or Escape go
back to the column. The footer lists the keys of whatever has the focus.

## What each operation does

- **Copy** never writes over anything. Pasted where the name is taken -- beside
  the original, for one -- the copy gets the next free name, `a copy.txt` and
  then `a copy 2.txt`. A directory is copied whole, and a link is copied as the
  link, never as what it points at.
- **Move** never writes over anything either: onto a taken name it is refused,
  and you rename one of them first. Across devices it is a copy and then a
  removal, which is what `mv` does.
- **Rename** takes a name, not a path: a `/` in it (or a `\` on Windows) is
  refused, so a rename never moves a file. A name that differs only in case is
  still a rename on a file system that ignores case.
- **Delete** removes a directory and everything in it. It does not go to the
  trash, which is why its confirm starts on No: Enter and Escape both keep it.
- Neither a copy nor a move puts a directory inside itself.

Copy and move confirm starting on Yes, because nothing they do loses anything
another key cannot give back.

## Previews

| Selected          | Preview                                                                          |
| ----------------- | -------------------------------------------------------------------------------- |
| A directory       | Its listing, with the same dot-file rule as the column                           |
| `.md`             | Rendered, its code blocks highlighted                                            |
| Any other text    | Line numbers and highlighting by extension: JS and TS, JSON, shell, YAML, a diff |
| `.png`            | Drawn in half blocks, no larger than the picture or the pane                     |
| A NUL in the text | `A binary file`, and its size                                                    |
| Anything else     | A note: an empty file, a socket or a device, a link to nothing                   |

Only the top of a file is read: 64 KB, and the first 1,000 lines of that. A PNG
over 8 MB is not decoded. A socket, a FIFO or a device is never opened, since
reading a FIFO waits for a writer that may never come. Every control character
in a name or a file is drawn as `�` rather than left out, so a name with an
escape in it does not look like a different name.

A picture needs colour to be drawn: at colour level 0 -- a pipe, or `NO_COLOR` --
it leaves its box empty, as `imageView()` does everywhere.

## Layout

| File                  | What it is                                                                          |
| --------------------- | ----------------------------------------------------------------------------------- |
| `src/index.ts`        | The JSX twin's schema, which `sigil build` compiles into `dist/file-manager.mjs`    |
| `src/ui.ts`           | The `ui`-tag twin's entry, run unbuilt                                              |
| `src/root.tsx`        | `App` in JSX: the three columns, the filter bar and the footer                      |
| `src/root.ui.ts`      | The same `App` in the `ui` tag                                                      |
| `src/model.ts`        | Everything but the tree: state, reads, keys, dialogs, toasts                        |
| `src/files.ts`        | `FilesContext`, the file system replaceable in tests, and the rules for changing it |
| `src/preview.ts`      | What to preview of an entry, read off the disk                                      |
| `src/preview-pane.ts` | The preview drawn in a scroll box at the size the layout gave                       |
| `src/common.ts`       | The stylesheet, and how a name is drawn in a column                                 |
| `test/`               | The rules, the previews, and the app over directories each test makes               |

## Not yet

- Selecting several files at once; a trash; making a file or a directory; opening
  a file in `$EDITOR`; watching a directory for changes (`R` reads it again).
- The Windows hidden attribute: Node does not read it, so a file Explorer hides
  is shown unless its name starts with a dot.
- What the library does not do yet, and this does by hand: `:focus-within` for
  the lit column (SIG-372), a dialog that builds its own body and opens on a field
  (SIG-335, SIG-337), and a bar that takes the focus the moment it is shown
  (SIG-384).
