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

|                                                                    |                                                |
| ------------------------------------------------------------------ | ---------------------------------------------- |
| [`components/01-spinner.js`](components/01-spinner.js)             | Work whose length is not known                 |
| [`components/02-progress.js`](components/02-progress.js)           | Work whose length is                           |
| [`components/03-table.js`](components/03-table.js)                 | Columns that line up, whatever is in them      |
| [`components/04-prompts.js`](components/04-prompts.js)             | Text, password, select, multiselect, confirm   |
| [`components/05-live-region.js`](components/05-live-region.js)     | The layer the spinner and the bar are drawn on |
| [`components/06-ansi-and-wrap.js`](components/06-ansi-and-wrap.js) | Styling, wrapping, and display width           |

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

|                                              |                                            |
| -------------------------------------------- | ------------------------------------------ |
| [`style/01-cascade.js`](style/01-cascade.js) | Which declaration wins a property, and why |

There is no renderer yet, so this one prints its answers rather than drawing
them. Each section is one contest between two declarations that both reach the
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

## The element tree

|                                                  |                                                    |
| ------------------------------------------------ | -------------------------------------------------- |
| [`element/01-tree.js`](element/01-tree.js)       | A tree, a stylesheet, a layout, and cells          |
| [`element/02-overlay.js`](element/02-overlay.js) | An overlay, a stacking order, and a scrolling pane |

The whole stack in one file, and the point of it is what it prints at the end: a
mutation says exactly what it implies and nothing else.

```sh
node demos/element/01-tree.js
```

The third is worth running in a terminal that implements OSC 8 — Ctrl-click or
Cmd-click the underlined text. In one that does not, you get the same words with
no link and nothing broken, which is why setting the underline and the colour
matters: they are what says "this is a link" when the link itself is invisible.
