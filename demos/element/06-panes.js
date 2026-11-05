/**
 * The hit test made visible: two scrolling panes, an overlay, and a full screen.
 *
 *   node demos/element/06-panes.js        <- hover, scroll, click, q
 *   node demos/element/06-panes.js | cat  <- refuses: one line on stderr, exit 1
 *
 * The other two mouse demos are inline canvases, which is where the hard part of
 * translating a report lives: an inline canvas does not know which screen row it is
 * on, because the log above it moves, so it has to ask. **This one is full screen,
 * where that is free** -- the alternate buffer starts at the top-left of the screen,
 * so a report's coordinates are the canvas's coordinates minus one and there is no
 * round trip to pay and nothing to re-learn on a resize.
 *
 * What it spends that on is the three things the hit test claims:
 *
 * - **A box is where it is drawn.** Scrolling moves the boxes rather than the
 *   drawing -- deliberately, so that everything above can match a box back to an
 *   element -- so hovering a row of a scrolled pane needs no correction pass. Wheel
 *   a pane down and keep hovering: the highlight follows the rows, not the screen.
 * - **A clipped box is not hittable where it is clipped.** The rows scrolled out of
 *   a pane are still elements with boxes, and their boxes are outside the rectangle
 *   the pane clips to, so the pointer goes straight through them. That rectangle is
 *   the same one paint drew inside, because `arrange()` writes it onto the tree
 *   rather than each walk working it out.
 * - **Reverse paint order, `z-index` first.** The overlay is written *before* both
 *   panes and lifted over them, so it is painted last and hit first. Hover it where
 *   it covers a pane: the pane underneath does not light up, because the hit test
 *   walks the list paint walks, backwards.
 *
 * The wheel needs no motion tracking to know what it is over, which is worth saying
 * because it is easy to assume otherwise: a report *is* a position, so a turn
 * carries its own coordinates. Motion is on here for `:hover`, and for that alone.
 */
import { runApp, useApp } from '@ttylabs/sigil/app';
import { box, text } from '@ttylabs/sigil/element';
import { createEffect } from '@ttylabs/sigil/renderer';
import { State } from '@ttylabs/sigil/signals';

/** How many rows each pane holds, which is more than it can show. */
const ROWS = 40;
/** How tall a pane is drawn, border included. */
const PANE = 14;

const sheet = `
  .app { flex-direction: column; padding: 1 }
  .panes { height: ${PANE} }
  .pane { border: round; border-color: gray; flex-grow: 1; overflow: hidden; margin-right: 2 }
  .pane:hover { border-color: cyan }
  .row { height: 1; padding-left: 1; padding-right: 1 }
  .row:hover { background-color: blue; color: white }
  .row.picked { color: yellow; font-weight: bold }
  .overlay {
    background-color: magenta; border: double; border-color: white; color: white;
    flex-direction: column; height: 5; left: 24; position: absolute; top: 4;
    width: 26; z-index: 10
  }
  .overlay:hover { border-color: yellow }
  /* the lines fill the interior, so the overlay reads as opaque even where its
     background was degraded away -- which is what a terminal with no colour does
     to it, correctly */
  .overlay text { white-space: nowrap }
  .title { color: gray; font-weight: bold }
  .readout { color: gray; margin-top: 1 }
  .hint { color: gray }
`;

/** What the hit test picked last, which is the whole point of the readout. */
const under = new State('nothing');
const picked = new State('nothing yet');
const scrolled = new State('0 / 0');

const App = () => {
  // `hovered` is the innermost element under the pointer, and it is `undefined`
  // wherever the pointer is over nothing -- including over a row that has been
  // scrolled out of its pane, which is the clip doing its job
  const app = useApp();
  const { input } = app;
  input?.bind((event) => {
    if (event.key.name === 'q') {
      event.stop();
      app.exit();
    }
  });
  input?.onMouse(() => {
    const it = input.hovered;
    under.set(it ? (it.id ?? `a ${it.type} inside ${it.parent?.id ?? 'the tree'}`) : 'nothing');
  });

  /** One pane: a clipping box holding more rows than it can show. */
  const pane = (name) => {
    const rows = Array.from({ length: ROWS }, (_, i) =>
      box(
        { class: 'row', id: `${name}-${i}` },
        text(`${name} row ${String(i + 1).padStart(2, '0')}`)
      )
    );
    const it = box({ class: 'pane', id: name }, box({ 'flex-direction': 'column' }, ...rows));

    /** How far down it may go: the rows it holds, less the rows it shows. */
    let offset = 0;
    const limit = () => Math.max(0, ROWS - Math.max(1, (it.box?.height ?? PANE) - 2));

    // the pane is the scroller, so the wheel is its business
    it.onMouse = (event) => {
      if (event.kind !== 'wheel') {
        return;
      }
      // the wheel carries its own coordinates, so this fires for the pane the
      // pointer is over whether or not anything is tracking motion
      const by = event.wheel === 'up' ? -3 : event.wheel === 'down' ? 3 : 0;
      offset = Math.min(limit(), Math.max(0, offset + by));
      // `scrollTo()` marks layout rather than paint, which is the difference
      // that matters: a scroll that only repainted would leave every row
      // claiming a box it is no longer drawn at, and the hit test reads boxes
      it.scrollTo(0, offset);
      scrolled.set(`${name} at ${offset} / ${limit()}`);
      event.stop();
    };

    // and each row is what a click is about, so the handler goes on the row.
    // Putting it on the pane and reading `event.target` is the mistake worth
    // knowing about: a click lands on the nearest box containing the press and
    // the release, and for a row with a text inside it that is the *text* --
    // so the pane would have been handed something with no `id` and no class to
    // toggle. The event bubbles, so a handler on the row is handed the row
    for (const row of rows) {
      row.onMouse = (event) => {
        if (event.kind !== 'click') {
          return;
        }
        for (const other of rows) {
          other.toggleClass('picked', other === row);
        }
        picked.set(row.id ?? '');
        event.stop();
      };
    }
    return it;
  };

  const readout = text('', { class: 'readout' });
  createEffect(() => readout.setText(`under the pointer: ${under.get()}`));

  const chosen = text('', { class: 'hint' });
  createEffect(() => chosen.setText(`picked: ${picked.get()}`));

  const where = text('', { class: 'hint' });
  createEffect(() => where.setText(`scrolled: ${scrolled.get()}`));

  return box(
    { class: 'app' },
    text('two panes, an overlay lifted over them, and one hit test', { class: 'title' }),
    box(
      { class: 'panes', position: 'relative' },
      // written *first* and lifted by `z-index`, so paint order is not document
      // order here -- which is exactly what the hit test has to agree with
      box(
        { class: 'overlay', id: 'overlay' },
        text('overlay, z-index 10'),
        text('hit before both panes'),
        text('nothing under it lights')
      ),
      pane('left'),
      pane('right')
    ),
    readout,
    chosen,
    where,
    text('hover, scroll a pane, click a row; q quits', { class: 'hint' })
  );
};

// full screen and the mouse with motion, which is the whole of what the old
// hand-wiring asked for: `runApp()` hands the router the renderer's backend as
// the surface a report is translated against, and puts the screen back on the
// way out -- before the summary is printed, which is what leaving the alternate
// buffer is for. `q` is the app choosing to go and exits 0, Ctrl-C is 130, and
// piped it refuses with 1, because there is no mouse and no screen to own
const app = runApp(App, { mouse: { motion: true }, sheets: [sheet] });
process.exitCode = await app.exited;
if (app.interactive) {
  console.log(`  picked: ${picked.get()}`);
  console.log(`  ${scrolled.get()}`);
  console.log('  one hit test for a clip, a scroll offset and a stacking order');
}
