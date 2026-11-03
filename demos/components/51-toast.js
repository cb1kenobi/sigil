/**
 * A toast: a timed message in a corner that never takes the focus.
 *
 *   node demos/components/51-toast.js      <- Up/Down or Tab, s saves, e fails, c moves the corner, q quits
 *   node demos/components/51-toast.js | cat
 *
 * A small file list where `s` "saves" the row you are on and `e` pretends the
 * save failed. Each says so in a toast, in the bottom-right corner by default,
 * and `c` moves the corner round. Toasts in one corner stack with the newest
 * nearest the corner, three at most -- a fourth pushes the oldest out -- and
 * each goes by itself after a few seconds, or at once when it is clicked. None
 * of that moves the focus: the row you were on keeps it, Tab still walks the
 * rows and only the rows, and the keys you type still go to the row.
 *
 * Piped, there is nobody to type, so a scripted keyboard drives the same tree and
 * the demo prints it after each step, with the focus said in words. It also asks
 * for `--quiet` part way through, which is what a script running the app would
 * do, and a toast raised then is never drawn. And it exits with a toast still
 * showing, because a toast's timer is not a reason to stay alive.
 */
import { createFullscreenCanvas } from '@ttylabs/sigil/canvas';
import { showToast } from '@ttylabs/sigil/components';
import { box, renderToString, text } from '@ttylabs/sigil/element';
import { createInput, isAbort } from '@ttylabs/sigil/input';
import { render } from '@ttylabs/sigil/renderer';
import { setQuiet } from '@ttylabs/sigil/style';
import { createTestTerminal, KEYS } from '@ttylabs/sigil/testing';
import { themedCascade } from '@ttylabs/sigil/theme';

const live = process.stdin.isTTY && process.stdout.isTTY;

const FILES = ['parser.ts', 'canvas.ts', 'layout.ts'];
const CORNERS = ['bottom-right', 'bottom-left', 'top-left', 'top-right'];

// the row the keys go to, which a toast must never take
const sheet = '.file:focus { inverse: true }';

/** The list the toasts are laid over. */
function scene(width, height) {
  const rows = FILES.map((name) => text(name, { class: 'file', focusable: true }));
  const root = box(
    { 'flex-direction': 'column', height, width },
    text('Files', { class: 'sigil-heading' }),
    ...rows,
    text('s saves · e fails · c moves the corner · q quits', { class: 'sigil-muted' })
  );
  return { root, rows };
}

/**
 * Wires `s`, `e` and `c` on the rows, and Up and Down between them.
 *
 * @param {{ root: import('@ttylabs/sigil/element').Element; rows: any[] }} ui - The list.
 * @param {import('@ttylabs/sigil/input').InputRouter} input - The router.
 * @param {number} timeout - How long each toast stays.
 */
function wire(ui, input, timeout) {
  let corner = 0;
  for (const [index, row] of ui.rows.entries()) {
    row.onKey = (event) => {
      const name = event.key.name;
      if (name === 's' || name === 'e') {
        event.stop();
        showToast(ui.root, {
          message: name === 's' ? `Saved ${row.text}` : `Could not save ${row.text}`,
          position: CORNERS[corner],
          timeout,
          title: name === 's' ? 'Saved' : 'Failed',
          variant: name === 's' ? 'success' : 'error',
        });
      } else if (name === 'c') {
        event.stop();
        corner = (corner + 1) % CORNERS.length;
        showToast(ui.root, {
          message: `Toasts go ${CORNERS[corner]} now`,
          position: CORNERS[corner],
          timeout,
        });
      } else if (name === 'up' || name === 'down') {
        event.stop();
        const next = ui.rows[(index + (name === 'up' ? -1 : 1) + ui.rows.length) % ui.rows.length];
        input.focus.focus(next);
      }
    };
  }
}

if (live) {
  const ui = scene(process.stdout.columns, process.stdout.rows);
  const canvas = createFullscreenCanvas();
  const view = render(() => ui.root, {
    backend: canvas,
    cascade: themedCascade({ sheets: [sheet] }),
  });
  // the mouse, so that a click on a toast can be seen to dismiss it and to reach
  // nothing under it
  const input = createInput({ mouse: { surface: canvas }, root: view.root });
  wire(ui, input, 4000);

  input.bind((event) => {
    if (isAbort(event.key) || event.key.name === 'q') {
      event.stop();
      // any toast still showing goes with the process: its timer holds nothing
      view.dispose();
      input.stop();
      process.stdin.unref();
    }
  });
  input.focus.focus(ui.rows[0]);
} else {
  const WIDTH = 50;
  const HEIGHT = 14;
  const term = createTestTerminal({ columns: WIDTH, rows: HEIGHT });
  const ui = scene(WIDTH, HEIGHT);
  const input = createInput({ root: ui.root, terminal: term.terminal });
  // short, so that the demo can wait one out
  wire(ui, input, 300);
  const cascade = themedCascade({ sheets: [sheet] });

  const settle = () => new Promise((resolve) => setImmediate(resolve));
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  /** Where the focus is, in words: the inverse row is an attribute a pipe drops. */
  const where = () => {
    const at = input.focus.current.get();
    return at === undefined ? 'nothing' : JSON.stringify(at.text);
  };
  const show = async (label) => {
    await settle();
    const body = renderToString(ui.root, { cascade, colorLevel: 0, height: HEIGHT, width: WIDTH });
    console.log(`-- ${label}\n${body.replace(/\s+$/gm, '')}\nfocus: ${where()}\n`);
  };

  await term.press(KEYS.tab, KEYS.tab);
  await show('Tab Tab: the second row has the focus');

  await term.press('s');
  await show('s: a toast in the bottom-right corner, and the focus is still on the row');

  await term.press('e', KEYS.down, 's');
  await show('e, Down, s: three stacked, the newest at the foot, the focus moved by Down alone');

  await term.press(KEYS.up, 's');
  await show('Up, s: a fourth pushes the oldest out');

  await term.press(KEYS.tab);
  await show('Tab: the focus walks the rows and never reaches a toast');

  await wait(400);
  await show('a moment later: they ran out, and nothing about the focus changed');

  await term.press('c', 'c');
  await show('c c: toasts go to the top-left now');
  await wait(400);

  setQuiet(true);
  showToast(ui.root, {
    message: 'Nobody sees this',
    onClose: (why) => console.log(`(a toast raised under --quiet closed at once: ${why})\n`),
  });
  await show('under --quiet: a toast raised now is never drawn');
  setQuiet(undefined);

  showToast(ui.root, { message: 'Still showing when the demo ends', timeout: 60_000 });
  await show('the last toast stays for a minute, and the demo exits under it anyway');

  input.stop();
}
