# Git client

A git client in the shape of lazygit: the files that changed, the branches and
the log down the left, and a diff of whatever is selected on the right. Stage
and unstage files and single hunks, switch, create and delete branches, and write
a commit message in a text area -- all from the keyboard.

```
pnpm build
pnpm --filter @ttylabs/example-git-client start            # the JSX twin, built
pnpm --filter @ttylabs/example-git-client start:ui         # the ui-tag twin, unbuilt
node examples/git-client/dist/git-client.mjs ~/some/repo   # another repository
node examples/git-client/dist/git-client.mjs --mouse       # clicks and the wheel
```

It runs against the repository it is started in, or the directory it is given,
and drives `git` through `child_process` -- so `pnpm start` from this directory
is the sigil repository itself. `q` exits 0 and Ctrl-C exits 130. Without a
terminal on both ends `runApp()` refuses: one line on stderr, exit 1.

The mouse is off unless you pass `--mouse`. While a terminal reports the mouse
it does not select text, and copying a line out of a diff matters more than a
click. With it, a click focuses a pane, picks a row of a list, and makes a hunk
of the diff current, so Space then stages that hunk; the wheel scrolls.

| Key              | Where     | Does                                                         |
| ---------------- | --------- | ------------------------------------------------------------ |
| `1` - `4`        | anywhere  | Focus files, branches, commits or the diff                   |
| Tab              | anywhere  | The next pane                                                |
| ↑ ↓, `j` `k`     | a list    | Move the selection; the diff follows it                      |
| Enter            | a list    | Files and commits: open the diff. Branches: check it out     |
| Space            | files     | Stage the file, or unstage it when nothing is left unstaged  |
| `a`              | files     | Stage everything, or unstage everything when all is staged   |
| `d`              | files     | Discard the unstaged changes, or delete an untracked file    |
| Space            | branches  | Check the branch out                                         |
| `n`              | branches  | A new branch from `HEAD`, named in a dialog                  |
| `D`              | branches  | Delete the branch (`git branch -d`)                          |
| `]` `[`, `n` `p` | the diff  | The next and the previous hunk                               |
| Space            | the diff  | Stage the hunk, or unstage it under `Staged`                 |
| Enter            | the diff  | Take the cursor inside the hunk, onto its first changed line |
| ↑ ↓, `x`, `a`    | the lines | Step over the changed lines; pick one; pick all or none      |
| `v`              | the lines | Begin a range: ↑ ↓ then pick every changed line it covers    |
| Space            | the lines | Stage the lines picked, or the one under the cursor          |
| Enter, Escape    | the lines | Back to the hunk as a whole                                  |
| `w`              | the diff  | Wrap long lines, or keep each on one row                     |
| Left, Right      | the diff  | Scroll sideways, while lines are kept on one row             |
| Escape           | the diff  | Back to the list it is showing                               |
| `c`              | anywhere  | Commit what is staged, with a message written in a dialog    |
| `r`              | anywhere  | Read the repository again                                    |
| `q`              | anywhere  | Quit, with 0                                                 |

The footer lists the keys of the pane that has the focus, so it changes as the
focus moves. In the commit dialog Enter is a newline, Ctrl-S commits, and Escape
closes it keeping the draft for next time.

Nothing destructive runs without a confirm, and the confirm starts on **No**:
discarding changes (`git checkout -- <path>`), deleting an untracked file
(`git clean -f -- <path>`) and deleting a branch. Staging, committing and
switching are not destructive -- git refuses a switch that would overwrite
changes, and the client shows what git said. Every result is a toast in the
bottom-right corner.

## Layout

| File             | What it is                                                                                           |
| ---------------- | ---------------------------------------------------------------------------------------------------- |
| `src/index.ts`   | The JSX twin's schema, which `sigil build` compiles into `dist/git-client.mjs`                       |
| `src/ui.ts`      | The `ui`-tag twin's entry, run unbuilt                                                               |
| `src/root.tsx`   | `App` in JSX: the panels, the lists and their rows                                                   |
| `src/root.ui.ts` | The same `App` in the `ui` tag                                                                       |
| `src/model.ts`   | Everything but the tree: state, git calls, keys, dialogs, toasts, and the blocks the diff pane draws |
| `src/git.ts`     | `GitContext`: how git is run, and where, replaceable in tests                                        |
| `src/parse.ts`   | Pure readers of git's status, branches and log, and a patch file's path                              |
| `src/common.ts`  | The stylesheet, and the classes a file's status letters are drawn in                                 |
| `test/`          | The parsers against git's output, and the app against repositories it makes                          |

The two roots build the same screen and share everything else, so the examples'
smoke test can assert that they draw the same first screen.

## What it reads

`git status --porcelain=v1 -z`, `git for-each-ref` and `git log -z`, with NUL
between records, so a path with a space in it reads as itself. A file's diff is
two patches: `git diff` for what is unstaged and `git diff --cached` for what is
staged, each a section of the pane. An untracked file has no diff, so it is read
and drawn as all added. A commit shows its message and its patch; a branch, its
last fifty commits.

Every git it runs has `GIT_OPTIONAL_LOCKS=0`, so reading the status never takes
the index lock from whatever else is using the repository.

## Staging a hunk

Space in the diff pane writes the hunk under the cursor back as a patch of its
own -- the file's header and that one hunk, every line as git wrote it -- and
hands it to `git apply --cached`, or `git apply --cached --reverse` for a hunk
under `Staged`. That is what `git add -p` does. The patch is read by
`parsePatch()` and the hunk written back by `hunkPatch()`, both from
`@ttylabs/sigil/components`: the reader keeps every file's header and every
hunk's lines as git wrote them, `\r` and `\ No newline at end of file` included,
so the same read is what the pane draws and what Space stages.

The pane is the library's `DiffView`, over blocks the model builds from what it
shows: each section's heading and prose, and its patches. The cursor stops on
each hunk, and on a line for a whole file with nothing to draw -- binary, a pure
rename -- which Space stages whole. The model finds what is under the cursor with
`diffStops()` over the same blocks the view counts with.

A patch longer than 4,000 lines is cut, and the hunk the cut went through is
left out rather than offered to Space, since its header still counts the lines
it lost.

## Staging some of a hunk

Enter in the diff pane takes the cursor inside the current hunk, and a second
column of marks shows it: `▶` on the line, `●` on a line picked, `◉` on both. Up
and down step over the changed lines, `x` picks one and `a` picks the hunk's all,
`v` begins a range -- up and down then pick every changed line from where it began to
the cursor, and `v` ends it -- and Space stages what is picked -- or the one line under the cursor where nothing
is -- through `hunkLinesPatch()`, which writes the lines kept as a patch whose
counts are its own: a line not picked is left as the index has it, so an unpicked
addition is not in the patch and an unpicked removal is context. Under `Staged`
the same keys unstage, with `--reverse`. Escape leaves the lines, and the diff is
drawn unified while they are in play.

An untracked file is staged whole, and says so. Where git cannot be given the
lines asked for -- an addition after a last line that has no newline, without the
line that ends the file -- the client says that instead of staging something else.

## Not yet

- Stashes, rebases, remotes, and resolving a
  conflict (Space marks a file resolved, which is `git add`).
- Refreshing on its own: `r` reads the repository again, and every action does.
- What the library does not do yet, and this does by hand: a dialog that opens
  on a field in its own body (SIG-337).
