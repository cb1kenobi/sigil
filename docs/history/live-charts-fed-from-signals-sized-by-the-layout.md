# Live charts: fed from signals, sized by the layout — how it was arrived at

The probes and sabotage passes behind the entry of that name in
[packages/sigil/src/components/AGENTS.md](../../packages/sigil/src/components/AGENTS.md). The decisions themselves are
there; this is the record of what was tried and what each check proved.

#### The monitor's stand-in, read first

`examples/system-monitor/src/stand-ins.js` had `LiveChart`: a box with an
`onResize` that threw the old chart away and built a new `*View()` at the new size,
on every tick, for every chart on screen. Its sizing came from the app's own sheet,
`.live-chart { flex-grow: 1; flex-basis: 0; min-width: 0; min-height: 0 }` -- a
basis of zero is what kept the drawn rows from deciding the box. That works for a
chart the app always sizes, and is zero wide for one it does not, so the component
could not take it as it was: a chart nothing sizes has to ask for something.

#### Rows in flow, and why the sizer is a `raw`

The first sketch put the drawn rows in the host and let `onResize` redraw them. In a
row with no `flex`, that is the text field's SIG-318: the host's automatic size is
its content's, the content is what it last drew, so a row that squeezed it to six
columns left it asking for six once the room came back. The build that shipped puts
the rows in an absolutely placed body and lets a `raw` beside it answer the measure
with what the chart asks for, both minimums zero.

Sabotage, passing `tsc`: the measure answering `(size ?? asked).width` -- the drawn
size, which is the in-flow build's behaviour with the body left absolute -- fails
`should grow back to what it asks for once a row that squeezed it has room again`
and nothing else in the 37. Taking `position: absolute` off the body fails 21 of
them, which says the body matters and says nothing precise; the measure sabotage is
the one that names the property.

#### `flex: 1` and `'flex-grow': 1`

Probed in a row of `cpu `, a sparkline and ` 7%`, 24 columns. With `'flex-grow': 1`
the sparkline's basis is what it asks for -- a column a sample of a 30-sample
capacity -- so the row is over-full and shrinks every item in proportion to its
basis: the label and the figure wrapped and the row went two tall. That is CSS's
answer too. `flex: 1` is basis zero, and the same row came out on one line with the
sparkline taking the thirteen columns left. The README and the demo say `flex: 1`
for a chart in a row for that reason, and a default `flex-grow` from the framework
sheet was refused as a sixteenth declared exception that would not have fixed this
case anyway.

#### The other sabotages

Each passing `tsc`, each run against `chart-live.test.ts` and `chart.test.ts`
together (104 tests):

- The owner of a shared braille cell taken from the first series rather than the
  last: fails `should draw both lines through a cell they share, in the colour of
  the later one`, alone.
- The gauge's percentage left unpadded: fails `should keep the bar where it is as
  the percentage gains a digit` and the bar-width picture beside it.
- Every row rebuilt on every draw, the signature check bypassed: fails `should leave
  a row that did not change as it was`, alone.
- The ring's start not advancing when it is full: fails the two `Series` tests that
  push past capacity.

#### Pictures that were wrong in the test, not in the code

Ten of the first thirty-seven expectations were written by hand and failed, and
every one was the hand: a sparkline's least sample is one eighth, so `[0, 4, 8, ...]`
on three rows has a second column of five eighths rather than four; `0, 1, 2, 3` on
one braille row at the right edge is `⡠⠊`, which working the dot bits out by hand
confirmed; a legend entry with room for one column was being cut to a bare `…`. That
last one was the code: a label cut to its ellipsis says nothing, which is the
panel's rule for a border label, and the legend now needs a character and the
ellipsis or leaves the entry out.

#### Mid-axis labels

`tickRows()` puts a label every four rows or so, and each is the value at its own
row. The demo's load chart is ten plot rows, so its middle label is `44%` rather
than `50%`. Choosing only heights whose rows divide evenly was tried on paper and
refused: ten, twelve, fourteen and eighteen rows would have had no middle label at
all, and a label half a row from its value is the one wrong answer an axis can give.

#### What the subpath costs now

`@ttylabs/sigil/components/chart` measured **214,025 B over 34 modules** with
`staticGraph()` after this change, against a ceiling of 396 KiB in
`dist.test.ts`; the figure recorded there, 201,844 B, is as of SIG-330. The live
charts brought `createEffect()` and `State` into the module's static graph, which
every other live component on the page -- the tabs, the text field -- already had.
