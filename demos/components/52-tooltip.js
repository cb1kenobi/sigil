/**
 * A tooltip: text anchored to an element, shown on hover or on focus.
 *
 *   node demos/components/52-tooltip.js      <- point at a button, or Tab to one; Esc hides, q quits
 *   node demos/components/52-tooltip.js | cat
 *
 * A toolbar with three buttons and a status line, each carrying a tooltip. Rest
 * the pointer on one and its bubble appears after half a second, below it where
 * there is room: the one at the right-hand edge ends where its button ends rather
 * than running off the screen, and the status line on the bottom row has its
 * bubble flipped above it. The pointer can move onto a bubble without losing it.
 * With no mouse, Tab to a button and its bubble appears the same way, because the
 * focus is the keyboard's hover -- and the bubble never takes the focus for
 * itself. Escape hides it without being taken from the app.
 *
 * Below the toolbar is a list in a scroll box, and `notes.md` has a tooltip too.
 * Tab to it and scroll the list with the arrows or the wheel: the bubble follows
 * its row in the same frame, is hidden while the row is scrolled out of the box,
 * and comes back with it.
 *
 * Piped, there is nobody to point, so a scripted pointer and keyboard drive the
 * same tree and the demo prints it after each step. It also shows `--quiet`, which
 * a tooltip respects: a hint beside the content is chrome, and quiet is for
 * suppressing chrome.
 */
import { createFullscreenCanvas } from '@ttylabs/sigil/canvas';
import { attachTooltip, ScrollBox } from '@ttylabs/sigil/components';
import { box, renderToString, text } from '@ttylabs/sigil/element';
import { createInput, isAbort } from '@ttylabs/sigil/input';
import { render } from '@ttylabs/sigil/renderer';
import { setQuiet } from '@ttylabs/sigil/style';
import { createTestTerminal, KEYS } from '@ttylabs/sigil/testing';
import { themedCascade } from '@ttylabs/sigil/theme';

const live = process.stdin.isTTY && process.stdout.isTTY;

const WIDTH = 44;
const HEIGHT = 10;

/** The toolbar, a list in a scroll box, and a status line on the bottom row. */
function scene() {
  const button = (label) => text(`[ ${label} ]`, { class: 'button', focusable: true });
  const save = button('Save');
  const open = button('Open');
  const help = button('Help');
  const status = text('main, 2 changes', { class: 'sigil-muted', focusable: true });
  // one row of twelve carries a tooltip, and is focusable so the keyboard can reach it
  const notes = text('notes.md', { class: 'button', focusable: true });
  const files = Array.from({ length: 12 }, (_, i) => (i === 2 ? notes : text(`file-${i}.txt`)));
  const list = ScrollBox({
    children: () => box({ 'flex-direction': 'column' }, ...files),
    props: { 'flex-grow': 1, 'min-height': 0 },
  });
  const root = box(
    { 'flex-direction': 'column', height: HEIGHT, width: WIDTH },
    box(
      { 'flex-direction': 'row', 'justify-content': 'space-between' },
      box({ 'column-gap': 1, 'flex-direction': 'row' }, save, open),
      help
    ),
    text('Point at a button, or Tab to one.', { 'margin-top': 1 }),
    list,
    status
  );
  return { help, list, notes, open, root, save, status };
}

/**
 * Hangs a tooltip on three of the four.
 *
 * `Open` has none, so Tab passing through it shows that a tooltip is a property of
 * the element that has one rather than of the focus.
 */
function attach(ui, input, delay) {
  return [
    attachTooltip(ui.save, { delay, input, text: 'Writes the file to disk' }),
    attachTooltip(ui.help, { delay, input, text: 'Opens the manual in a pager' }),
    attachTooltip(ui.status, { delay, input, text: 'The branch, and what is not committed' }),
    attachTooltip(ui.notes, { delay, input, text: 'Edited a minute ago' }),
  ];
}

if (live) {
  const ui = scene();
  const view = render(() => ui.root, {
    backend: createFullscreenCanvas(),
    cascade: themedCascade({ sheets: ['.button:hover, .button:focus { inverse: true }'] }),
  });
  const input = createInput({ mouse: { motion: true, surface: view.backend }, root: view.root });
  const tips = attach(ui, input, 500);

  input.bind((event) => {
    if (isAbort(event.key) || event.key.name === 'q') {
      event.stop();
      for (const tip of tips) {
        tip.dispose();
      }
      input.stop();
      view.dispose();
      process.stdin.unref();
    }
  });
} else {
  const ESC = String.fromCharCode(0x1b);
  const term = createTestTerminal({ columns: WIDTH, rows: HEIGHT });
  const ui = scene();
  const cascade = themedCascade();

  // a canvas at the screen's origin, which is all the router asks of one
  const surface = {
    height: HEIGHT,
    locate: async () => true,
    origin: { x: 0, y: 0 },
    toCanvas: (column, row) => ({ x: column - 1, y: row - 1 }),
    width: WIDTH,
  };
  const input = createInput({
    mouse: { motion: true, surface },
    root: ui.root,
    terminal: term.terminal,
  });
  const DELAY = 40;
  attach(ui, input, DELAY);

  // the app's own Escape, bound after the tooltips: a tooltip that took the key
  // would leave this at nothing
  let heard = 'nothing';
  input.bind((event) => {
    if (event.key.name === 'escape') {
      heard = 'Escape';
    }
  });

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  /** Pointer motion with nothing held, onto an element's first cell or a cell of its own. */
  const point = async (element, dx = 0, dy = 0) => {
    const at = element.box;
    await term.press(`${ESC}[<35;${at.x + 1 + dx};${at.y + 1 + dy}M`);
  };
  const away = () => term.press(`${ESC}[<35;41;2M`);
  const draw = () =>
    renderToString(ui.root, { cascade, colorLevel: 0, height: HEIGHT, width: WIDTH });
  const where = () => {
    const at = input.focus.current.get();
    return at === undefined ? 'nothing' : JSON.stringify(at.text);
  };
  const show = (label) => {
    const body = draw()
      .split('\n')
      .map((line) => line.trimEnd())
      .join('\n');
    console.log(`-- ${label}\n${body}\nfocus: ${where()}\n`);
  };

  // laid out once, so the pointer has boxes to land on
  draw();
  show('as built: no bubble anywhere');

  await point(ui.save);
  show('the pointer on Save, before the delay: nothing yet');

  await sleep(DELAY * 2);
  show('after the delay: below Save, starting where it starts');

  await point(ui.save, 4, 2);
  show('the pointer onto the bubble: it stays, so it can be read');

  await away();
  show('the pointer away: gone at once');

  await point(ui.help);
  await sleep(DELAY * 2);
  show('on Help, against the right edge: it ends where the button ends');

  await point(ui.status);
  await sleep(DELAY * 2);
  show('on the status line, on the bottom row: flipped above it');

  await away();
  await term.press(KEYS.tab);
  await sleep(DELAY * 2);
  show('no pointer, Tab to Save: the focus shows it, and keeps the focus');

  await term.press(KEYS.escape);
  // a lone Escape is held until nothing follows it
  await sleep(100);
  show(`Escape: hidden, and the app's own binding still heard ${heard}`);

  await term.press(KEYS.tab);
  await sleep(DELAY * 2);
  show('Tab to Open, which has no tooltip');

  setQuiet(true);
  await point(ui.save);
  await sleep(DELAY * 2);
  show('--quiet, and the pointer on Save: a hint is chrome, so nothing');
  setQuiet(undefined);

  await away();
  // the list: the focus on its row, and the arrows scrolling the box around it --
  // the keys go from the row up to the box, which is what claims them
  input.focus.focus(ui.notes);
  await sleep(DELAY * 2);
  show('the focus on notes.md, in the list: below its row');

  await term.press(KEYS.down, KEYS.down);
  show('Down twice: the list scrolled, and the bubble followed its row');

  await term.press(KEYS.down);
  show('Down once more: the row is scrolled out of the box, so the bubble is hidden');

  await term.press(KEYS.up);
  show('Up: the row is back, and so is its bubble');

  input.stop();
}
