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
| [`components/07-typewriter.js`](components/07-typewriter.js)       | Text that arrives rather than appears         |
| [`components/08-large-text.js`](components/08-large-text.js)       | Banner text, and the `.flf` format behind it  |
| [`components/09-decrypt.js`](components/09-decrypt.js)             | Text that jumbles, then resolves into itself  |

### Try them without a terminal

The interesting half. Pipe any of them and there is no cursor to move, so
nothing is repainted — a spinner writes one line per change instead of one per
frame, a bar one line every ten percent, and a typewriter the whole text at once
rather than one line per step -- seven lines for that run rather than about a
hundred:

```sh
node demos/components/01-spinner.js | cat
node demos/components/02-progress.js | cat
node demos/components/07-typewriter.js | cat
node demos/components/09-decrypt.js | cat
```

That is what a CI log gets, and no component had to know about it. The decrypt is
the sharpest case: six texts, written once each, which is eight lines because one
of them is three — against a couple of hundred frames of noise on a terminal. Its
fifth text is also the one that shows colour doing the work: an app sheet puts the
cipher in one colour and what it resolves to in another, which is two class rules
rather than an option, because a built-in carries no colour in its props. Per
character, not per block — each one turns the resolved colour the moment it lands,
because the cipher cells and the resolved ones are two elements over one
rectangle and each resolves its own style. The sixth is `text-overflow` on a path
too long for its box: a decrypt is cut and marked the way any other text is, in
`ellipsis-middle`, which keeps the project at one end and the file at the other.

`08-large-text.js` is the one where the answer is that nothing changes: a banner
is static text, so there is no cursor to move and a pipe gets byte for byte what
a terminal gets. What the destination does change is how much colour it takes,
which is the last section of that run and is what `NO_COLOR=1` turns off. It
reads its font from `components/fonts/blocks.flf`, written for these demos --
no third-party `.flf` is committed here and none is bundled in the runtime,
because the look of a banner is the app's choice and there are hundreds of fonts
already written.

The typewriter and the decrypt answer the same way to a preference rather than to
a pipe, so a terminal whose user has asked for less motion gets the text in one go
too:

```sh
SIGIL_REDUCED_MOTION=reduce node demos/components/07-typewriter.js
SIGIL_REDUCED_MOTION=reduce node demos/components/09-decrypt.js
```

A prompt has nobody to ask, so it fails rather than waiting forever on a stdin
that will never produce a keystroke:

```sh
node demos/components/04-prompts.js < /dev/null
# Cannot prompt for "Project name" because the input is not a terminal
```

And `NO_COLOR=1` turns the styling off everywhere:

```sh
NO_COLOR=1 node demos/components/06-ansi-and-wrap.js
NO_COLOR=1 node demos/components/09-decrypt.js
```

The decrypt is where that reads as a decision rather than as an absence: the only
thing its stylesheet says is that a block with anything still hidden is
de-emphasised, and at colour level 0 the attributes go along with the colour — so
what is left is the characters changing, which is the whole effect.

## Style

|                                                            |                                                   |
| ---------------------------------------------------------- | ------------------------------------------------- |
| [`style/01-cascade.js`](style/01-cascade.js)               | Which declaration wins a property, and why        |
| [`style/02-themes.js`](style/02-themes.js)                 | Restyling the built-ins, which is what a theme is |
| [`style/03-animation.js`](style/03-animation.js)           | Transitions and keyframes, over whole cells       |
| [`style/04-theme-switcher.js`](style/04-theme-switcher.js) | The themes sigil ships, swapped live              |

`01-cascade.js` prints its answers rather than drawing them, because the contest
is the point. Each section is one contest between two declarations that both reach the
same property; the last section is what the parser refuses and what it says
about it. Edit a sheet in the file and re-run it — that is what it is for.

`04-theme-switcher.js` is the vocabulary rather than the mechanism, and what ships
with it: the five named themes come from `@ttylabs/sigil/themes`, which an app
imports by name so a bundler drops the ones it did not take. Every
declaration the framework shares between two built-ins is on a **role** —
`.sigil-accent`, `.sigil-muted`, `.sigil-heading`, `.sigil-success`,
`.sigil-error`, `.sigil-warn`, `.sigil-info` — and an element carries its
component class and its role together. So the panel wears a dozen component
classes and each theme sets exactly seven things.

On a terminal, `1`-`6` swap the theme under a live frame and `q` quits — the
panel prints its own key map, derived from the theme list so it cannot name five
of six. A switch is a sheet added to the cascade and a `touchSheets()` to say
every rule it matched is stale. Piped, it
renders each theme one after another instead, including a real `table()`, which
is what shows the roles reaching a built-in rather than only the hand-built panel.

```sh
node demos/style/04-theme-switcher.js        # 1-6 switch, q quits
node demos/style/04-theme-switcher.js | cat  # every theme, one after another
SIGIL_COLOR_SCHEME=light node demos/style/04-theme-switcher.js
NO_COLOR=1 node demos/style/04-theme-switcher.js
```

Three things in it are worth more than the colours. Switching **adds** a sheet
rather than replacing one, because a cascade has no way to take one away — so
every theme gives every role a colour, and a role one of them left out would keep
the previous theme's. A theme overrides per _property_, so a theme that sets only
a colour on `.sigil-muted` inherits the framework's `dim: true` and comes out dim
**and** coloured; `dim: false` is the fix and `color: initial` is how a theme says
"nothing here". And every theme here carries a light half, which is what
`SIGIL_COLOR_SCHEME=light` is there to show — but they are two different halves,
and that is the part worth seeing. `sigil` and `MONO` de-emphasise with `dim`, so
their light half moves that one declaration onto `gray`; the four colour themes
have no `dim` to fix and instead carry a second _palette_ for white, inside
`@media (min-color-level: 2) and (prefers-color-scheme: light)`. So the light run
changes one role under `mono` and all seven under `violet`. `sigil` is named for
what ships rather than `framework`, because that name is taken: `framework` is the
_origin_ the real defaults sit at, while this is an ordinary theme at origin
`theme` like the other five.

The last row of the panel is a real hyperlink, and it is the one row a `text`
could not be: `link` is a **canvas** style property rather than a cascade one, so
no stylesheet can say it and no theme can reach it. A `raw` paints its own cells,
which is the trapdoor that node type exists to be — and it still takes its colour
from the `.sigil-accent` it wears, so the link moves with every switch while only
the OSC 8 is the raw's own. Nothing degrades it: `NO_COLOR=1` drops the colour and
the underline and leaves the row clickable, because a hyperlink is neither a colour
nor an attribute, and a terminal that has never heard of OSC 8 shows the label and
ignores the sequence.

`03-animation.js` needs a terminal, because it moves. Space widens a bar, `c`
changes two colours at once, and Tab moves a focus ring that fades rather than
jumping — all of it declared in the sheet at the top of the file, with no
component code driving any of it.

```sh
node demos/style/03-animation.js            # space, c, Tab, q
SIGIL_REDUCED_MOTION=1 node demos/style/03-animation.js
```

The counter at the bottom is the part worth watching. Geometry interpolates in
**whole cells**, so a bar going from 4 to 30 columns has twenty-seven visible
states however long it takes — and the frame loop does not wake for a frame that
would paint what is already on screen. What it prints is frames painted against
the thirty a second a loop without that would have drawn.

Piped, nothing moves: a pipe, a file and a CI log have no frames, so every
animation collapses to the state it would have ended on.
`SIGIL_REDUCED_MOTION=1` says the same thing on a terminal.

## The canvas

|                                                        |                                            |
| ------------------------------------------------------ | ------------------------------------------ |
| [`canvas/01-sparkline.js`](canvas/01-sparkline.js)     | A chart at 2x4 the resolution the grid has |
| [`canvas/02-image.js`](canvas/02-image.js)             | A picture at two pixels per cell           |
| [`canvas/03-links.js`](canvas/03-links.js)             | Text that is also a URL                    |
| [`canvas/04-inline.js`](canvas/04-inline.js)           | A canvas at the bottom of a scrolling log  |
| [`canvas/05-fullscreen.js`](canvas/05-fullscreen.js)   | The alternate screen, given back           |
| [`canvas/06-transitions.js`](canvas/06-transitions.js) | Four transitions over one mechanism        |

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

`06-transitions.js` is a dissolve, a blue-noise dissolve, a wipe and an iris, and
the point is that all four are the same six lines with a different generator:

```sh
node demos/canvas/06-transitions.js
node demos/canvas/06-transitions.js | cat   # the end state of each, once
```

What cannot be faked in the `paint()` callback is that a transition needs the
**previous screen's content**, and by the time anybody wants one the state that
produced it is gone — `canvas.snapshot()` is that content and is the only thing
here a caller could not write for themselves. Piped it prints one frame per
state and no half-dissolved ones, which is not a special case: a backend with no
terminal writes its text and returns before `canvas.present()` -- `render()` does
call `backend.present()`, which is the method that skips the diff -- so there is
nothing on screen to snapshot, the
layer composites nothing, and every frame of the ramp is the end state. An
animation with no screen to play on is one that has already finished, which is
the same answer `SIGIL_REDUCED_MOTION=1` gives one layer up.

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
| [`element/08-scroll.js`](element/08-scroll.js)       | Ten thousand rows, a scrollbar, and paint culling  |
| [`element/09-virtual.js`](element/09-virtual.js)     | The same list windowed: 49 elements, not 10,008    |
| [`element/10-sequences.js`](element/10-sequences.js) | `g g`, a leader key, and the pending state         |

The whole stack in one file, and the point of it is what it prints at the end: a
mutation says exactly what it implies and nothing else.

```sh
node demos/element/01-tree.js
```

The last eight need a terminal on both sides, because they read what you press. In
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
node demos/element/09-virtual.js # the same list, windowed
node demos/element/10-sequences.js  # g g, g, Space f, Ctrl-X Ctrl-S, q
```

**`10-sequences.js`** is the one place the three shapes of a pending sequence are
side by side, and the thing to watch is which of them waits. `g` and `g g` are
both bound, so a lone `g` has to find out which: the status line shows `g` and
half a second later `g` fires on its own, while a second `g` inside that window
fires the pair instead -- and an ordinary key inside the window, `x` say, fires
`g` at once, because a key that does not continue the sequence has answered the
question the deadline was waiting on. Escape and Backspace do not, and nor does
Ctrl-C: the first two are the user saying "forget it" rather than answering, and
Ctrl-C never reaches the trie. `Space` is the leader and nothing else, so it waits with
**no deadline at all** -- press it and leave it, and the `space` sits there,
because there is nothing to disambiguate and any key that does not continue it
already cancels it. And Ctrl-C quits from inside a half-entered sequence, because
a function binding sees every key before the trie is consulted at all. The
pending keys are a signal rather than a getter for the reason the status line
shows: a sequence committing on a deadline is not a key, so a redraw-on-keypress
could not follow it.

**`08-scroll.js`** is ten thousand rows in a twenty-row window, and the number is
the point: a frame paints the twenty rows on screen rather than the ten thousand
that exist, because paint culls a subtree whose extent misses its clip. The paint
goes from 34.8ms to 0.29ms on that tree — without it the demo is a slideshow, and
with it what is left is the layout, which is what windowing is for and is
deliberately not here: `09-virtual.js` is this list windowed. Those two numbers
are not this demo's to prove:
`node packages/sigil/scripts/benchmark-paint-cull.mjs` is what measures them, and
it checks the two grids are identical before it times anything.

Four things to try, each of which is a claim. The arrows, PageUp/PageDown and
Home/End are claimed only where the axis has somewhere to go, so a box whose
content _fits_ hands the key on rather than swallowing it — while one at its end
keeps it, since Home in a list already at its top is still that list's key rather
than the outer pane's. The wheel is three lines a notch and up
to four times that in a flick, which is the difference between crossing ten
thousand rows and 3,333 notches. The thumb drags, and the press capture is what
lets a drag wander off the bar and still end. And Tab walks the rows, with
`scrollIntoView()` wired to the focus ring, so tabbing past the last visible row
scrolls rather than leaving the highlight somewhere you cannot see.

**`09-virtual.js`** is that list with only the visible rows **built**, and it is
meant to be run straight after `08-scroll.js`: the two look the same, scroll the
same, report the same range and draw the thumb in the same place. The only visible
difference is the line at the bottom, which counts the elements that exist — 49
against the 10,008 that list comes to with every row built, measured both ways
(08 prints no count of its own). It reads 45 at the very bottom, which is the
arithmetic rather than a leak: at the end of the list there are only eighteen
rows left to see. Paint culling took the paint from 34.8ms to
0.29ms and left the **arrange** as the whole frame at 72ms; an element that does
not exist is not measured, not re-resolved and not painted, so a wheel notch goes
from 81ms to 0.61ms. What makes it cheap is that it is only a component: a spacer
above and below is an ordinary box with a declared height, so nothing in the
layout engine, the cascade, the paint walk or `scrollRange()` knows a window is in
play. `node packages/sigil/scripts/benchmark-virtual-list.mjs` is what measures
it, and it asserts three sides paint the same frame before it times any of them.

Three things to try, and the last is the tier's honest edge. Scroll it every way —
Home and End are the sharpest, because the thumb reaches the very top and the very
bottom, which it could not do if the range came from what was built. **Resize the
terminal**, which writes no scroll offset at all: the window is rebuilt for the
rows the viewport gained, because the frame tells the viewport its new height after
the layout and lays out again before it paints. That used to leave the rows it
gained blank until something scrolled — ten held where forty-one were needed — and
is SIG-132. Then press Tab: the rows are focusable and Tab walks the ones that
**exist**, so the focus can never end up somewhere you cannot see — which is the
failure `scrollIntoView()` is wired to the focus ring to prevent, and a window
makes it unreachable rather than fixed. What it costs is the other direction:
tabbing past the last visible row wraps instead of scrolling on, because a row
nobody built is not in the ring.

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

## The renderer

|                                                |                                                      |
| ---------------------------------------------- | ---------------------------------------------------- |
| [`renderer/01-app.js`](renderer/01-app.js)     | Bodies that run once, effects that update in place   |
| [`renderer/02-tasks.js`](renderer/02-tasks.js) | A list that keeps what each row holds, through moves |

Both need a terminal on both sides, because they read what you press.

```sh
node demos/renderer/01-app.js    # Tab, space, a, d, q
node demos/renderer/02-tasks.js  # j/k, space, e, x, J/K, f, n, q
```

**`01-app.js`** is what a component runtime _is_. A component is a function of
props that builds elements, its body runs **once**, and the reactive parts are
`createEffect()`s that write to the node they built — so the interesting thing to
watch is what does _not_ happen: the counter prints how many component bodies have
run, and that number does not move however much the screen changes.

**`02-tasks.js`** is the question that justifies the tax. `Show` and `For` exist
because an `if` in a body runs once and a `.map()` builds the list it saw, so a
conditional and a list have to be components — the only thing that can own a
branch and dispose it. What you buy for writing them out is in the reorder: each
row owns state nothing above it can see, and `J`/`K` move the row without the
expansion, the move count or the focus going anywhere, because a row keyed by
identity is the _same_ row rather than a new one at a new position.

The honest half is the filter. `f` cycles all/open/done, and a row filtered out is
**disposed** rather than hidden — so its expansion is gone when it comes back.
That is `For` keying on the items it was given, and `n` is the same rule one level
up: collapsing the list with `Show` loses every expansion at once. Hiding is
`visibility` and a different question.

`n` is also where the deferred frame shows through. Collapsing takes the focus with
the rows, and the ring does not repair that — nothing focused is a legitimate state,
and the element it would repair _to_ is exactly what has gone — so the app puts the
focus back itself on the way out. The obvious spelling does not work:
`listOpen.set(true)` only _marks_ the branch stale, so focusing immediately walks a
tree that still has no rows in it. There is a `view.frame()` in between, and that is
the one line of this demo you would not have guessed.

The panel at the bottom is why this demo was written rather than merely run. `e`
inspects a task, and the panel is a `Show` whose `when` produces a **value** — the
shape anybody writes for a detail pane, an error banner or a selected row. Press
`e` on one task and then on another and it follows, because `children` is handed
an _accessor_ onto what `when` produced. It was handed the value itself until this
demo existed, and then it did not follow: both tasks are present, so presence never
moved, so the branch was never rebuilt, and the panel described the first task for
the rest of the run.

Without a terminal on **both** sides both print one line and exit `0`, which is
what the component demos do and for the same reason — the keys arrive on stdin and
the frame is drawn to the output, so either one being a pipe means there is nothing
to run:

```sh
node demos/renderer/01-app.js | cat
# This demo reads keys and draws frames, so it needs a terminal on both sides.
```

Both sides is the point rather than pedantry, and `| cat` is exactly the case that
needs it: run from a terminal, stdin is still a TTY while stdout is a pipe. A guard
that asked only about stdin let that through, drew half a frame, and then threw an
`InputError` stack over a minified module — which is the failure
`demos/terminal/01-capabilities.js` already carries an entry for, and which four
demos still had. `demos.test.ts` cannot catch it: it spawns with stdin ignored, so
every demo it runs takes the no-terminal branch.
