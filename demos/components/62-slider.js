/**
 * Sliders: a value on a track, moved by the keys and dragged by the pointer.
 *
 *   node demos/components/62-slider.js      <- Tab, arrows, PgUp/PgDn, Home/End, drag, q
 *   node demos/components/62-slider.js | cat
 *
 * A settings screen: four rows, each a label the app lays out and a `Slider` with a
 * readout of its value. Tab moves between them. Left and Right move a step, Page Up
 * and Page Down a tenth of the range, Home and End to the ends. A press on a track
 * puts the thumb under the pointer, and holding the button drags it -- past either
 * end of the track and off the region altogether, which is the pointer capture
 * `demos/element/05-drag.js` is about, and the release still ends the drag.
 *
 * Each slider's readout is as wide as the widest value its range formats to, so
 * the tracks stay where they are whatever the values come to: watch the volume go
 * from 9% to 100% and nothing beside it move. "Brightness" is disabled, so it is
 * muted, out of the Tab ring, and deaf to the pointer.
 *
 * The focused slider's thumb fills in, `○` to `●`, and carries the focus role. The
 * glyph is what says it at colour level 0, where the role's `inverse` is dropped --
 * which is also what a pipe shows.
 *
 * Piped, there is nobody to type or drag, so the same tree is driven by a scripted
 * keyboard and a scripted pointer, and printed after each step.
 */
import { createInlineCanvas } from '@ttylabs/sigil/canvas';
import { keyHelp } from '@ttylabs/sigil/components/key-help';
import { describeSlider, Slider } from '@ttylabs/sigil/components/slider';
import { box, renderToString, text } from '@ttylabs/sigil/element';
import { createInput, isAbort } from '@ttylabs/sigil/input';
import { createEffect, render } from '@ttylabs/sigil/renderer';
import { State } from '@ttylabs/sigil/signals';
import { createTestTerminal, KEYS } from '@ttylabs/sigil/testing';
import { themedCascade } from '@ttylabs/sigil/theme';

const live = process.stdin.isTTY && process.stdout.isTTY;
const WIDTH = 44;

/** The rows, and the tree they sit in. */
function scene() {
  const said = new State('nothing changed yet');

  /** One row: the app's label, and a slider that says what it was moved to. */
  const row = (label, props) => {
    const slider = Slider({
      ...props,
      onChange: (value) => said.set(`${label.toLowerCase()} is now ${props.format(value)}`),
      // the track's columns, so the four tracks line up whatever their readouts
      // come to: a readout is as wide as its own range needs and no wider
      width: 24,
    });
    return {
      element: box({ 'flex-direction': 'row' }, text(label, { class: 'label', width: 11 }), slider),
      slider,
    };
  };

  const rows = [
    row('Volume', { format: (v) => `${v}%`, value: 9 }),
    row('Balance', {
      format: (v) => (v < 0 ? `L ${-v}` : v > 0 ? `R ${v}` : 'centre'),
      max: 10,
      min: -10,
      value: 0,
    }),
    row('Speed', { format: (v) => `${v.toFixed(2)}x`, max: 2, min: 0.5, step: 0.25, value: 1 }),
    row('Brightness', { disabled: true, format: (v) => `${v}%`, value: 70 }),
  ];

  const status = text('', { class: 'status' });
  createEffect(() => status.setText(said.get()));
  const root = box(
    { 'flex-direction': 'column', width: WIDTH },
    ...rows.map((it) => it.element),
    status
  );
  return { root, sliders: rows.map((it) => it.slider) };
}

const sheet = `
  .label { color: gray }
  .status { margin-top: 1; color: gray }
`;

if (live) {
  const ui = scene();
  const canvas = createInlineCanvas({ height: 8 });
  /** The footer, appended once the router it reads exists. */
  const footer = box({ 'margin-top': 1 });
  const view = render(() => box({ 'flex-direction': 'column' }, ui.root, footer), {
    backend: canvas,
    cascade: themedCascade({ sheets: [sheet] }),
    height: 8,
    width: 'auto',
  });
  // motion, because a drag is the pointer moving with a button held
  const input = createInput({ mouse: { motion: true, surface: canvas }, root: view.root });

  const quit = () => {
    view.dispose();
    input.stop();
  };
  input.bind('q', quit, { description: 'quit', priority: 9 });
  input.bind((event) => {
    if (isAbort(event.key)) {
      event.stop();
      quit();
    }
  });
  // Tab is the router's own default, so it is described rather than bound
  input.describe('tab', { description: 'next', priority: 8 });
  describeSlider(input, ...ui.sliders);
  footer.append(keyHelp(input, { width: 80 }));
  input.focus.next();
} else {
  const term = createTestTerminal({ columns: WIDTH });
  const ui = scene();
  const input = createInput({
    // a canvas at the top-left of the screen, which is all the router asks of one
    mouse: {
      motion: true,
      surface: {
        height: 5,
        locate: async () => true,
        origin: { x: 0, y: 0 },
        toCanvas: (column, row) => ({ x: column - 1, y: row - 1 }),
        width: WIDTH,
      },
    },
    root: ui.root,
    terminal: term.terminal,
  });
  describeSlider(input, ...ui.sliders);
  const footer = keyHelp(input, { width: 80 });
  const cascade = themedCascade({ sheets: [sheet] });

  // an effect runs on the microtask after the write that wakes it
  const settle = () => new Promise((resolve) => setImmediate(resolve));

  /** Prints the tree and the footer under a heading. */
  const show = async (label) => {
    await settle();
    const body = renderToString(ui.root, { cascade, colorLevel: 0, width: WIDTH });
    const keys = renderToString(footer, { cascade, colorLevel: 0, width: 80 }).trimEnd();
    console.log(`-- ${label}\n${body}\nkeys:  ${keys || '(none listed)'}\n`);
  };

  /** An SGR mouse report, one-based like the terminal's: a press, a move with it held, a release. */
  const ESC = String.fromCharCode(0x1b);
  const report = (code, column, row, final = 'M') => `${ESC}[<${code};${column};${row}${final}`;

  await show('as built: nothing focused, every thumb hollow');

  await term.press(KEYS.tab);
  await show('Tab: the volume has the focus, and its thumb fills in');

  await term.press(KEYS.right);
  await show('Right: 10%, and the readout was already wide enough for it');

  await term.press(KEYS.end);
  await show('End: 100%, and the track has not moved a column');

  await term.press(KEYS.pageDown, KEYS.pageDown);
  await show('Page Down twice: a tenth of the range each time');

  await term.press(KEYS.tab, KEYS.left, KEYS.left, KEYS.left);
  await show('Tab to the balance, and Left three times');

  await term.press(KEYS.tab, KEYS.tab);
  await show('Tab twice: past the disabled brightness, round to the volume');

  // the speed's track starts after its 11-column label, on the third row
  await term.press(report(0, 12 + 1, 3));
  await show('A press at the left of the speed track: the thumb jumps there, and it has the focus');

  await term.press(report(32, 12 + 20, 3), report(32, 200, 3));
  await show('Dragged right, then off the edge of the region: the thumb clamps at the top');

  await term.press(report(0, 200, 3, 'm'), report(35, 14, 3));
  await show('Released out there, then moved: the drag ended, so nothing follows');

  input.stop();
}
