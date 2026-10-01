# Demos

Small runnable examples, one idea each. Every file is plain JavaScript and
imports `@ttylabs/sigil` by name, so what you read is what you would write in an app.

```sh
pnpm build            # the demos import the built output
node demos/parser/01-hello.js
```

Each file opens with the commands worth trying. The parser demos run a sample
argv when you give them none, so they do something on their own — pass your own
arguments and yours are used instead.

## The parser

|                                                                |                                                                   |
| -------------------------------------------------------------- | ----------------------------------------------------------------- |
| [`parser/01-hello.js`](parser/01-hello.js)                     | The smallest thing that works                                     |
| [`parser/02-options.js`](parser/02-options.js)                 | Flags, values, types, defaults, `env`, choices, repeats, negation |
| [`parser/03-arguments.js`](parser/03-arguments.js)             | Required, optional, and variadic positionals                      |
| [`parser/04-subcommands.js`](parser/04-subcommands.js)         | Nesting, aliases, hidden commands, and how options resolve        |
| [`parser/05-default-command.js`](parser/05-default-command.js) | A single-command CLI                                              |
| [`parser/06-lazy-commands.js`](parser/06-lazy-commands.js)     | Commands read from a directory, loaded when matched               |
| [`parser/07-help.js`](parser/07-help.js)                       | Groups, contributed sections, and writing your own                |
| [`parser/08-hooks.js`](parser/08-hooks.js)                     | Watching a parse, adding an option mid-parse, rewriting an error  |
| [`parser/09-errors.js`](parser/09-errors.js)                   | The default handler, your own, and catching it yourself           |

Two worth running with `--help` to see what the screen does:

```sh
node demos/parser/07-help.js build --help     # groups and a contributed section
node demos/parser/06-lazy-commands.js --help  # commands listed by name alone
```

## Components

|                                                                    |                                               |
| ------------------------------------------------------------------ | --------------------------------------------- |
| [`components/01-spinner.js`](components/01-spinner.js)             | Work whose length is not known                |
| [`components/02-progress.js`](components/02-progress.js)           | Work whose length is                          |
| [`components/03-table.js`](components/03-table.js)                 | Columns that line up, whatever is in them     |
| [`components/04-prompts.js`](components/04-prompts.js)             | Text, password, select, multiselect, confirm  |
| [`components/05-live-region.js`](components/05-live-region.js)     | A string frame repainted in place, on its own |
| [`components/06-ansi-and-wrap.js`](components/06-ansi-and-wrap.js) | Styling, wrapping, and display width          |

### Try them without a terminal

The interesting half. Pipe any of them and there is no cursor to move, so
nothing is repainted — a spinner writes one line per change instead of one per
frame, and a bar one line every ten percent:

```sh
node demos/components/01-spinner.js | cat
node demos/components/02-progress.js | cat
```

That is what a CI log gets, and no component had to know about it.

A prompt has nobody to ask, so it fails rather than waiting forever on a stdin
that will never produce a keystroke:

```sh
node demos/components/04-prompts.js < /dev/null
# Cannot prompt for "Project name" because the input is not a terminal
```

And `NO_COLOR=1` turns the styling off everywhere:

```sh
NO_COLOR=1 node demos/components/06-ansi-and-wrap.js
```

## Style

|                                              |                                                   |
| -------------------------------------------- | ------------------------------------------------- |
| [`style/01-cascade.js`](style/01-cascade.js) | Which declaration wins a property, and why        |
| [`style/02-themes.js`](style/02-themes.js)   | Restyling the built-ins, which is what a theme is |

`01-cascade.js` prints its answers rather than drawing them, because the contest
is the point. Each section is one contest between two declarations that both reach the
same property; the last section is what the parser refuses and what it says
about it. Edit a sheet in the file and re-run it — that is what it is for.

## The canvas

|                                                      |                                            |
| ---------------------------------------------------- | ------------------------------------------ |
| [`canvas/01-sparkline.js`](canvas/01-sparkline.js)   | A chart at 2x4 the resolution the grid has |
| [`canvas/02-image.js`](canvas/02-image.js)           | A picture at two pixels per cell           |
| [`canvas/03-links.js`](canvas/03-links.js)           | Text that is also a URL                    |
| [`canvas/04-inline.js`](canvas/04-inline.js)         | A canvas at the bottom of a scrolling log  |
| [`canvas/05-fullscreen.js`](canvas/05-fullscreen.js) | The alternate screen, given back           |

The first two draw with ordinary characters — braille patterns and half blocks —
so they need nothing from the terminal but the font. Each prints what the frame
cost in bytes, and the two answers are very different:

```sh
node demos/canvas/01-sparkline.js   # a plot: cheap to change
node demos/canvas/02-image.js       # a picture: every cell its own two colours
node demos/canvas/04-inline.js      # the log keeps scrolling above the frame
node demos/canvas/05-fullscreen.js  # Ctrl-C it: the terminal comes back anyway
```

`03-links.js` is worth running in a terminal that implements OSC 8 — Ctrl-click or
Cmd-click the underlined text. In one that does not, you get the same words with
no link and nothing broken, which is why setting the underline and the colour
matters: they are what says "this is a link" when the link itself is invisible.

## The terminal

|                                                              |                                                          |
| ------------------------------------------------------------ | -------------------------------------------------------- |
| [`terminal/01-capabilities.js`](terminal/01-capabilities.js) | What was guessed, what was answered, and where they part |

Two halves and five stacked sections, and the point is the fourth. Everything
sigil knew about its terminal, it used to infer from `TERM`, `COLORTERM` and
`NO_COLOR`; this asks the terminal as well and prints both, with a paragraph per
place they part:

```sh
node demos/terminal/01-capabilities.js
```

A terminal that exports `COLORTERM=truecolor` and then resolves as something else
is exactly what asking is for, and a dump that prints only one half is how nobody
notices. `NO_COLOR=1 COLORTERM=truecolor` is the case to try: it says which
variable outranked which, by name, rather than leaving the reader three to check.

The sections, in order: **what the environment says**, as a table; **what the
terminal answered** -- DA1, XTVersion's name and version, the cell and text-area
geometry, the background from OSC 11, the cursor position, and DECRPM for three
modes; **asked and never answered**, with what the whole sequence cost against
what five deadlines would have; **where the two columns disagree**; and **where
they confirm each other**. The last two are separate because most runs have
something in each, and a heading promising disagreement over a paragraph saying
the two agree is a heading that lies.

The three modes are 2004, 1006 and 9999, and each is there for its own reason.
The router turns bracketed paste (2004) on when it starts, so DECRPM should read
it back as `set` -- `permanently-set` also means on, and anything else means a
mode we believe is set is not. 1006 is mouse tracking, which nothing here turns
on, so it is the honest "off". 9999 is a mode no terminal has: it should come back
`unrecognised` rather than silent, and that distinction -- off versus never heard
of it -- is the whole reason to ask DECRPM anything.

A terminal that understands none of the queries answers nothing, and then all
five wait out their own 250ms deadline. The run prints what it measured rather
than working it out from which queries were silent, because an empty `CSI ? c`, a
cursor report or a single mode reply each end a probe early -- so counting the
silences and multiplying gives the wrong number. 250ms is what the default is a
judgement about: too short and a slow link reports no capabilities with nothing to
point at, too long and a timer is held open.

### Without a terminal

A probe needs one on **both** sides: the reply arrives on stdin, so there has to
be somebody to send it, and the query is written to stdout, so there has to be
somewhere to write it. Pipe either and no router is built and no query is written.
It prints the inference, says which side is missing, and exits zero:

```sh
node demos/terminal/01-capabilities.js | cat        # stdout is a pipe
node demos/terminal/01-capabilities.js < /dev/null  # stdin is not a terminal
# ...
# Nothing was probed: stdout is not a terminal, so there is nobody to answer.
```

`| cat` is the one worth trying, and it is where this was wrong once: run from a
terminal it leaves stdin a TTY while piping stdout, so a guard that asked about
stdin alone let it through and `createInput()` threw a stack over the dump. The
demos test could not have caught it -- it spawns with stdin ignored, which takes
the other branch.

That branch is not the exception `04-prompts.js` is. A prompt with nobody to
answer it has no answer, so it fails loudly; a capability dump has a perfectly
good one, which is the guess, labelled as a guess. It is also the rule the whole
feature is built on -- a CLI must not pay a round trip to print one line, so
nothing probes unless something asked.

`packages/sigil/scripts/terminal-probe.mjs --detect` is the other half and is not
replaced by this. That one is run by hand to falsify claims only a real terminal
can, and it reads `dist/` directly; this reads the same capabilities back through
the public API, which is also what makes it prove the API is usable from outside
the package.

## The element tree

|                                                      |                                                    |
| ---------------------------------------------------- | -------------------------------------------------- |
| [`element/01-tree.js`](element/01-tree.js)           | A tree, a stylesheet, a layout, and cells          |
| [`element/02-overlay.js`](element/02-overlay.js)     | An overlay, a stacking order, and a scrolling pane |
| [`element/03-focus.js`](element/03-focus.js)         | One router owns stdin, and Tab moves the focus     |
| [`element/04-mouse.js`](element/04-mouse.js)         | `:hover` from a hit test, a click, and the wheel   |
| [`element/05-drag.js`](element/05-drag.js)           | A drag, and the capture that makes one work        |
| [`element/06-panes.js`](element/06-panes.js)         | Full screen: a clip, a scroll and a stacking order |
| [`element/07-selection.js`](element/07-selection.js) | Selecting cells, and OSC 52 to the clipboard       |
| [`element/08-scroll.js`](element/08-scroll.js)       | Ten thousand rows, a scrollbar, and paint culling   |

The whole stack in one file, and the point of it is what it prints at the end: a
mutation says exactly what it implies and nothing else.

```sh
node demos/element/01-tree.js
```

The last five need a terminal on both sides, because they read what you press. In
`04-mouse.js` the highlight is zero lines of component code for the same reason
the focus ring's is: the hit test sets a state and the stylesheet matches it with
`:hover`.

```sh
node demos/element/03-focus.js   # Tab, Shift-Tab, type, q
node demos/element/04-mouse.js   # move, click, scroll a tile, q
node demos/element/05-drag.js    # press the bar and drag past the edge, q
node demos/element/06-panes.js   # hover, scroll a pane, click a row, q
node demos/element/07-selection.js  # drag, alt-drag, ctrl-y to copy, q
node demos/element/08-scroll.js  # arrows, wheel, drag the thumb, tab, q
```

**`08-scroll.js`** is ten thousand rows in a twenty-row window, and the number is
the point: a frame paints the twenty rows on screen rather than the ten thousand
that exist, because paint culls a subtree whose extent misses its clip. Measured on
that tree, the paint goes from 38.05ms to 0.315ms — without it the demo is a
slideshow, and with it what is left is the layout, which is what a windowed list
would be for and is deliberately not here.

Four things to try, each of which is a claim. The arrows, PageUp/PageDown and
Home/End are claimed only where the axis has somewhere to go, so a list at its end
hands the key on rather than swallowing it. The wheel is three lines a notch and up
to four times that in a flick, which is the difference between crossing ten
thousand rows and 3,333 notches. The thumb drags, and the press capture is what
lets a drag wander off the bar and still end. And Tab walks the rows, with
`scrollIntoView()` wired to the focus ring, so tabbing past the last visible row
scrolls rather than leaving the highlight somewhere you cannot see.

Each of the three mouse demos is for a claim the others cannot make.

**`04-mouse.js`** is the ordinary case: hover, click-to-focus and the wheel over an
inline canvas.

**`05-drag.js`** is the **capture**, which is invisible until you drag past the edge
of the region. A report arriving outside the canvas is dropped — a click on the log
above it is not the app's — and on its own that strands anything tracking a press:
the release lands outside, is dropped, and the thumb sticks to the pointer forever.
So while a button is held, the motion and the release go to whatever the press
landed on, wherever the pointer got to. Drag the bar off the left or right edge and
watch the readout keep counting past the canvas: that is the same thing `clientX`
does during a drag on a web page. There is deliberately no `drag` event — press,
move and release are three events a component already has, and what a drag _means_
differs per component.

**`06-panes.js`** is the other backend. It takes the whole screen, where translating
a report is free — the alternate buffer starts at the top-left, so there is no
cursor query to pay and nothing to re-learn on a resize — and spends that on the
three things the hit test claims. Scrolling moves the _boxes_ rather than the
drawing, so hovering a row of a scrolled pane needs no correction. The rows scrolled
out of a pane still have boxes, and those boxes are outside what the pane clips to,
so the pointer goes straight through them. And the overlay is written before both
panes and lifted with `z-index`, so it is painted last and hit first: hover it where
it covers a pane and the pane underneath does not light up.

**`07-selection.js`** is selection and the clipboard. Drag to select, alt-drag for
a rectangle -- which is what copies one pane of a two-column layout without the
other -- and Ctrl-Y to send it with OSC 52, which is what makes this work over ssh.
Three things to watch. The paragraph copies with its wrap points in it, because
the selection is over the _laid-out_ grid rather than over the tree. The braille
sparkline does not copy at all: `raw` elements are `selectable={false}` by
default, so a plot's block characters stay out of your clipboard. And there is no
success to report -- a terminal does not answer an OSC 52, several refuse it by
default, and tmux needs `set -g set-clipboard on` -- so the status line says the
bytes were written and nothing more. Paste somewhere to find out, which is the
only way there is. It needs no `motion: true`: a drag's motion is what `1002`
already reports.

Three things about the mouse are worth knowing before you run any of them.

**It takes away text selection.** A terminal reporting the mouse stops doing its
own, so while this demo is running, selecting and copying with the pointer does
not work. Shift-drag overrides it in most terminals and not all -- iTerm2 uses
alt/option and shift does nothing there at all, which is the terminal's own
choice and nothing an app can detect. That is the price of the feature rather
than a bug in the demo, and it is why an app has to ask for tracking rather than
getting it by default. **`07-selection.js` is the answer to it**: the app gives
selection back, over the painted grid, with Ctrl-Y to copy.

**`:hover` costs a report per cell of pointer travel.** It needs xterm's `1003`,
which reports every cell the pointer crosses for as long as the app runs, so the
demo opts in with `motion: true`. Without it `:hover` matches nothing — which is
what it did before there was a mouse at all, so no stylesheet changes meaning by
turning tracking on.

**Do not print a report's own bytes.** iTerm2 watches for a mouse report being
printed to the screen, because that is what a stuck mouse looks like — the TUI
died, tracking stayed on, and the shell is echoing the reports. Its check reduces
a report to its printable digits (`0;41;13M` for a press at column 41, row 13) and
looks for them in the next 100ms of screen text, so an app with a debug line that
dumps the raw sequence gets offered "Looks like mouse reporting was left on when
an ssh session ended unexpectedly or an app misbehaved. Turn it off?" — correctly,
from the terminal's point of view. These three demos print `(39, 11)` instead,
which is why they are quiet. If the bytes really are the point, space them out:
`ESC [ < 0 ; 41 ; 13 M` says the same thing and is not the thing. It is nothing to
do with the alternate screen, which was the guess for a while — the check runs on
either buffer.

Worth watching in the three inline demos: resize the window while one is running.
That throws the canvas's anchor away, so the backend no longer knows which screen
row it is on, and the first report afterwards is the one that pays for asking — the
status line does not move for that one click. `06-panes.js` has nothing to re-learn,
because a full-screen canvas is always at the origin.
