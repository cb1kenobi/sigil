# Editor

A text editor with a Markdown preview: a file tree down the left, the open
files in tabs over a text area with line numbers and syntax highlighting, and,
for a `.md` file, the document drawn beside its source as it is typed. Save,
a mark on the tab of a file with unsaved changes, a dialog before closing one or
quitting over one, and a command palette.

```
pnpm build
node examples/editor/dist/editor.mjs              # the working directory
node examples/editor/dist/editor.mjs ~/notes      # another directory
node examples/editor/dist/editor.mjs --mouse      # wheel, clicks and drag selection
```

Or `pnpm start` from this directory, which opens this example's own source. It
is written in JSX, so it runs as `sigil build` compiled it. `q` exits 0 from the
tree, and asks first while anything is unsaved; Ctrl-C exits 130 without asking.
Without a terminal on both ends `runApp()` refuses: one line on stderr, exit 1.

| Key                  | Where         | Does                                                            |
| -------------------- | ------------- | --------------------------------------------------------------- |
| ↑ ↓, → ←             | the tree      | Move; open and close a directory                                |
| Enter                | the tree      | Open a file in a tab, or show the tab it is already open in     |
| Tab, Shift-Tab       | anywhere      | The next and previous pane; in the text area Tab indents        |
| Escape               | the text area | Back to the tree                                                |
| Shift with a move    | the text area | Select                                                          |
| Ctrl-Y, Ctrl-X       | the text area | Copy and cut the selection to the terminal's clipboard (OSC 52) |
| Ctrl-S               | anywhere      | Save the file showing, if it has changed                        |
| Ctrl-W               | anywhere      | Close the tab showing; asks first if it has unsaved changes     |
| Ctrl-PgDn, Ctrl-PgUp | anywhere      | The next and previous tab, wrapping                             |
| ← →, `1`-`9`         | the tab row   | Another tab                                                     |
| Ctrl-P               | anywhere      | The command palette                                             |
| `q`                  | not typing    | Quit                                                            |

The chords are quiet while a dialog is open: the dialog has the keys. A paste
goes in whole, line breaks and all. Ctrl-W closes a tab rather than
deleting the word before the caret, which the text area would otherwise do with
it; Alt-Backspace still deletes a word.

## What it shows

- **The text area as an editor's.** One `TextArea` per open file, each over the
  document's text as a `State`, with `lineNumbers`, `tab: '  '` and
  `highlightCode()` for the languages the lexer reads (TypeScript, JavaScript,
  JSON, shell, YAML, Markdown, a diff), which marks nothing in a file whose
  extension it does not read. The areas of the tabs not showing are hidden
  rather than built again, so each keeps its caret, selection and scroll. Each
  is handed the document's `caret` state, which opens the file at its first line
  and is what the footer reads as `Ln 12, Col 5`.
- **Dirty, as a comparison.** A document is dirty while its text differs from
  what was last read or saved, so typing a change back out makes it clean again.
  The mark is `●` on the tab and in the panel title (`*` in ASCII). A file is
  written back with the line ending it was read with -- the first one in it,
  for a file with more than one kind -- and a file with no changes is not
  written at all, so a habitual Ctrl-S converts nothing.
- **Closing and quitting ask.** Closing a dirty tab asks Save, Don't save or
  Cancel, starting on Save; Escape is Cancel. Quitting over unsaved changes asks
  Quit or Cancel, starting on Cancel, because that is the answer that loses
  nothing.
- **A command palette.** Ctrl-P opens a field over the commands -- save, save
  all, close, the next and previous tab, the preview, focus, reload every folder
  of the tree that has been read,
  quit, and a "Go to" for each open tab -- ranked by `rankBy()` as it is typed,
  with what matched drawn in the accent by `highlightRuns()`. The cursor follows
  the best match; Up and Down move it without leaving the field.
- **The preview.** `markdownView()` at the width its pane is given, with code
  blocks highlighted by the same lexer, rebuilt when the source changes. Its edge
  drags, and the palette hides it.

## What it costs

Typing, measured on arm64 macOS as of this change: a key into the text area and
the frame that draws it, the median of forty, at 160 by 45. Opening is reading
the file and drawing its first frame.

| File                                      | Open   | A key   |
| ----------------------------------------- | ------ | ------- |
| TypeScript, 100 lines                     | 12 ms  | 1.7 ms  |
| TypeScript, 5,000 lines                   | 11 ms  | 4.5 ms  |
| TypeScript, 50,000 lines (3.3 MB)         | 40 ms  | 29.5 ms |
| The same 50,000 lines as `.txt`           | 11 ms  | 2.3 ms  |
| Markdown, 2 kB (this repository's README) | 16 ms  | 6.4 ms  |
| Markdown, 12 kB, preview drawn live       | 34 ms  | 29.9 ms |
| Markdown, 51 kB, preview after a pause    | 136 ms | 44.5 ms |
| Markdown, 919 kB, too long to preview     | 20 ms  | 7.4 ms  |

The two costs that dominate are named rather than worked around. A highlighted
50,000-line file spends nearly all of its 29.5 ms highlighting the whole value
again, which the plain-text line beside it shows; an incremental highlighter is
SIG-382. A preview costs what its element count costs, on every key and not
only when it is rebuilt, because a frame lays the whole tree out again once a
text in it changes. So the preview is drawn as it is typed up to 16 kB, after
200 ms without a key past that, and not at all past 256 kB.

## Layout

| File               | What it is                                                                  |
| ------------------ | --------------------------------------------------------------------------- |
| `src/index.ts`     | The schema `sigil build` compiles: `[dir]`, `--mouse`, and `runApp()`       |
| `src/root.tsx`     | `App`: the tree, the tabs and the areas, the preview, the footer, the sheet |
| `src/editor.ts`    | Everything but the tree: documents, areas, saving, dialogs and keys         |
| `src/documents.ts` | A document: its text, what was saved, dirty, its tab label                  |
| `src/palette.ts`   | The command palette, in a dialog                                            |
| `src/preview.ts`   | The Markdown preview, in a scroll box                                       |
| `src/workspace.ts` | `WorkspaceContext`: the directory, and reading and writing a file           |
| `test/`            | The editor over a test terminal, against a directory each test makes        |

`App` takes no props. It reaches the router and `exit()` through `useApp()`, and
the directory through `WorkspaceContext`, so `test/editor.test.ts` runs it with
`runApp()` over `createTestTerminal()` against a temporary directory, and reads
every save back off the disk.

## What it works around

Each is a small local answer where sigil has no answer yet.

- **A dialog borrows an owner.** The palette and the text areas are built from a
  key, which has no owner, so each is built under a branch of the component's and
  disposed with it (SIG-335).
- **A shown box is not shown to the router until a frame.** Opening a file paints
  a frame before the next key, as the log browser does (SIG-384).
