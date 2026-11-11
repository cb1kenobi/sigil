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
```

It runs against the repository it is started in, or the directory it is given,
and drives `git` through `child_process` -- so `pnpm start` from this directory
is the sigil repository itself. `q` exits 0 and Ctrl-C exits 130. Without a
terminal on both ends `runApp()` refuses: one line on stderr, exit 1.

| Key          | Where    | Does                                                        |
| ------------ | -------- | ----------------------------------------------------------- |
| `1` - `4`    | anywhere | Focus files, branches, commits or the diff                  |
| Tab          | anywhere | The next pane                                               |
| ↑ ↓, `j` `k` | a list   | Move the selection; the diff follows it                     |
| Enter        | a list   | Files and commits: open the diff. Branches: check it out    |
| Space        | files    | Stage the file, or unstage it when nothing is left unstaged |
| `a`          | files    | Stage everything, or unstage everything when all is staged  |
| `d`          | files    | Discard the unstaged changes, or delete an untracked file   |
| Space        | branches | Check the branch out                                        |
| `n`          | branches | A new branch from `HEAD`, named in a dialog                 |
| `D`          | branches | Delete the branch (`git branch -d`)                         |
| `]` `[`      | the diff | The next and the previous hunk                              |
| Space        | the diff | Stage the hunk, or unstage it under `Staged`                |
| Escape       | the diff | Back to the list it is showing                              |
| `c`          | anywhere | Commit what is staged, with a message written in a dialog   |
| `r`          | anywhere | Read the repository again                                   |
| `q`          | anywhere | Quit, with 0                                                |

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

| File               | What it is                                                                     |
| ------------------ | ------------------------------------------------------------------------------ |
| `src/index.ts`     | The JSX twin's schema, which `sigil build` compiles into `dist/git-client.mjs` |
| `src/ui.ts`        | The `ui`-tag twin's entry, run unbuilt                                         |
| `src/root.tsx`     | `App` in JSX: the panels, the lists and their rows                             |
| `src/root.ui.ts`   | The same `App` in the `ui` tag                                                 |
| `src/model.ts`     | Everything but the tree: state, git calls, keys, dialogs, toasts               |
| `src/diff-pane.ts` | The diff pane: `diffView()` in a scroll box, with a hunk cursor                |
| `src/git.ts`       | `GitContext`: how git is run, and where, replaceable in tests                  |
| `src/parse.ts`     | Pure readers of git's output, and a hunk written back as a patch               |
| `src/common.ts`    | The stylesheet, and the classes a file's status letters are drawn in           |
| `test/`            | The parsers against git's output, and the app against repositories it makes    |

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
under `Staged`. That is what `git add -p` does. The patch is read by the
example's own `splitPatch()` rather than by `parsePatch()`, which drops
`\ No newline at end of file` and would stage a different hunk (SIG-370).

A patch longer than 4,000 lines is cut, and the hunk the cut went through is
left out rather than offered to Space, since its header still counts the lines
it lost.

## Not yet

- Line-by-line staging inside a hunk, stashes, rebases, remotes, and resolving a
  conflict (Space marks a file resolved, which is `git add`).
- Refreshing on its own: `r` reads the repository again, and every action does.
- What the library does not do yet, and this does by hand: a diff view that
  scrolls and has a hunk cursor (SIG-367), a patch that survives a round trip
  (SIG-370), `:focus-within` for the lit pane (SIG-372), and a dialog that builds
  its own body and opens on a field (SIG-335, SIG-337).
