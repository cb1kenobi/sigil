# Disk usage

Where the space went. A tree of everything under a directory down the left, each
with its total, largest first, and a treemap of the same tree on the right: one
rectangle per file, its area its size, nested by directory, coloured by what kind
of file it is. The selection is one: moving in the tree outlines the rectangle,
and clicking a rectangle selects it in the tree. `r` scans again, and `d` deletes
after a confirm.

```console
$ pnpm build
$ pnpm start                 # this directory
$ pnpm start ~/Downloads     # somewhere else
```

It is written in JSX, so it runs as `sigil build` compiled it. `q` exits with 0
and Ctrl-C with 130. Without a terminal on both ends `runApp()` refuses: one line
on stderr, exit 1.

## Keys

| Key               | Does                                                  |
| ----------------- | ----------------------------------------------------- |
| ↑ ↓, `j` `k`      | Move; the map's outline follows                       |
| → ←, `l` `h`      | Open a directory, close it, or go to the one it is in |
| Space             | Open or close a directory                             |
| Enter             | Map the selected directory, or the one a file is in   |
| Backspace         | Map the directory above the one mapped                |
| `d`, Delete       | Delete, after a confirm that starts on No             |
| `r`               | Scan again                                            |
| A click on a tile | Select what it is, opening the tree down to it        |
| `q`               | Quit, with 0                                          |
| Ctrl-C            | Quit, with 130                                        |

Moving the selection out of the directory mapped maps the directory both are in,
so what is selected is always on the map.

## What it shows

- **Sizes are file lengths, in powers of 1000**: `512 B`, `8.2 kB`, `530.1 GB`,
  which is how a disk is sold and how Finder counts. A directory's size is what is
  in it. A file with more than one name (a hard link) is counted once, at the name
  that sorts first; the others say where it was counted. A symbolic link is listed
  and never followed, and counts for nothing.
- **The map is squarified**: each directory is divided into rectangles kept as
  close to square as the sizes allow, in half blocks, so a cell holds two
  rectangles' colours one above the other. Every rectangle keeps its last column
  and row in the terminal's own background, so two side by side never run
  together, and a directory directly under the one mapped keeps one more, so the
  first division -- which directory the space went to -- reads at a glance.
- **Colour says what kind of file**: code, text and documents, images, audio and
  video, archives, binaries, and everything else, in the six hues a 16-colour
  terminal has and a grey. At truecolor each rectangle is shaded as a cushion,
  brightest near its middle. The tree draws the same colour as a square beside
  each file, which is the legend.
- **A rectangle of many files has a texture**: a directory with no room to divide,
  or the items of a directory too small to draw on their own gathered into one
  ("+120", "37 more"), is a checker of two shades rather than solid. So the
  difference reads at every colour level, the last one included: with no colour
  at all the map is blocks and spaces, solid and checkered, and the selection is
  drawn hollow.
- **The scan runs as you watch**: the counts and the directory being read are on
  the map until it ends, and a scan from `r` keeps the last one on screen until
  the new one is ready, with the selection and the open directories where they
  were. It does not follow links, does not enter a directory on another device
  (as `du -x` does), and lists a directory it could not read with the reason.
- **Delete is permanent**: it does not go to the trash. The confirm says what is
  going and how much, and starts on No, so Enter and Escape both keep it. The
  sizes above it are taken down at once, without a rescan; if the delete fails
  part of the way, it scans again rather than guess at what is left. The root is
  not deleted from here, nothing is while a scan is running, and `r` waits for a
  delete to finish.
- **A name is drawn as it is**, except that a control character in it is drawn as
  `�`, so a name that holds an escape is not a different name on screen.

## Not here

Renaming and opening files, a trash, filtering by name or kind, and watching the
disk for changes (`r` scans again).
