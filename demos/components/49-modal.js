/**
 * A modal: a dialog over the current screen, with a focus trap.
 *
 *   node demos/components/49-modal.js      <- Tab, d opens a confirm, Esc dismisses, q quits
 *   node demos/components/49-modal.js | cat
 *
 * A small file list with a confirm dialog laid over it. While the dialog is open
 * the list cannot be reached: Tab and Shift-Tab cycle through the dialog's own
 * buttons and nothing else, a key typed at it goes to the dialog's focused button
 * and no further, and a click anywhere outside the panel lands on a transparent
 * box the size of the screen rather than on the row under it. Escape dismisses
 * the dialog, and the focus goes back to the row it was opened from.
 *
 * Piped, there is nobody to type, so a scripted keyboard drives the same tree and
 * the demo prints it after each step, with the focus said in words. It also opens
 * a second dialog over the first, which a terminal session has no key for: the
 * topmost owns the input, and closing it hands the keys back to the one below.
 */
import { createFullscreenCanvas } from '@ttylabs/sigil/canvas';
import { confirmModal, openModal } from '@ttylabs/sigil/components';
import { box, renderToString, text } from '@ttylabs/sigil/element';
import { createInput, isAbort } from '@ttylabs/sigil/input';
import { render } from '@ttylabs/sigil/renderer';
import { createTestTerminal, KEYS } from '@ttylabs/sigil/testing';
import { themedCascade } from '@ttylabs/sigil/theme';

const live = process.stdin.isTTY && process.stdout.isTTY;

const FILES = ['parser.ts', 'canvas.ts', 'layout.ts'];

/** The list the dialog is laid over. */
function scene(status) {
  const rows = FILES.map((name) => text(name, { class: 'file', focusable: true }));
  const root = box(
    { 'flex-direction': 'column', height: 10, width: 44 },
    text('Files', { class: 'sigil-heading' }),
    ...rows,
    status
  );
  return { root, rows };
}

/**
 * Wires `d` on the list, which asks before it deletes.
 *
 * @param {import('@ttylabs/sigil/input').InputRouter} input - The router.
 * @param {{ root: import('@ttylabs/sigil/element').Element; rows: any[] }} ui - The list.
 * @param {import('@ttylabs/sigil/element').Element} status - Where the outcome is said.
 */
function wire(input, ui, status) {
  const ask = async () => {
    const at = input.focus.current.get();
    const name = ui.rows.find((row) => row === at)?.text;
    if (name === undefined) {
      return;
    }
    const sure = await confirmModal(ui.root, {
      initial: 'no',
      input,
      message: `${name} will be gone for good.`,
      title: 'Delete it?',
      width: 34,
    });
    status.setText(sure ? `deleted ${name}` : `kept ${name}`);
  };

  // on the rows, so the key is the row's and a dialog's own `d` is not
  for (const row of ui.rows) {
    row.onKey = (event) => {
      if (event.key.name === 'd') {
        event.stop();
        void ask();
      }
    };
  }
}

if (live) {
  const status = text('d deletes the row you are on', { class: 'sigil-muted' });
  const ui = scene(status);
  const view = render(() => ui.root, {
    backend: createFullscreenCanvas(),
    cascade: themedCascade(),
  });
  const input = createInput({ root: view.root });
  wire(input, ui, status);

  input.bind((event) => {
    if (
      isAbort(event.key) ||
      (event.key.name === 'q' && event.target !== undefined && ui.rows.includes(event.target))
    ) {
      event.stop();
      view.dispose();
      input.stop();
      process.stdin.unref();
    }
  });
  input.focus.next();
} else {
  const term = createTestTerminal({ columns: 44 });
  const status = text('d deletes the row you are on', { class: 'sigil-muted' });
  const ui = scene(status);
  const input = createInput({ root: ui.root, terminal: term.terminal });
  wire(input, ui, status);
  const cascade = themedCascade();

  const settle = () => new Promise((resolve) => setImmediate(resolve));
  /** Where the focus is, in words: an inverse mark is an attribute a pipe drops. */
  const where = () => {
    const at = input.focus.current.get();
    return at === undefined ? 'nothing' : JSON.stringify(at.text);
  };
  const show = async (label) => {
    await settle();
    const body = renderToString(ui.root, { cascade, colorLevel: 0, height: 10, width: 44 });
    console.log(`-- ${label}\n${body.replace(/\s+$/gm, '')}\nfocus: ${where()}\n`);
  };

  await show('as built: nothing is focused');

  await term.press(KEYS.tab, KEYS.tab);
  await show('Tab Tab: the second row has the focus');

  await term.press('d');
  await show('d: the confirm opens over the list, on No, and the focus moves into it');

  await term.press(KEYS.tab, KEYS.tab, KEYS.tab);
  await show('Tab x3: the focus cycles through Yes and No, and never reaches a row');

  await term.press('x', KEYS.down);
  await show('keys typed at the dialog go to its button and no further');

  await term.press(KEYS.enter);
  await show('Enter on Yes: it answers, and the focus returns to the row');

  await term.press('d');
  await term.press(KEYS.escape);
  // a lone Escape is held until nothing follows it
  await new Promise((resolve) => setTimeout(resolve, 100));
  await show('d, Escape: dismissed, which is a No, and the focus is back on the row');

  await term.press('d');
  openModal(ui.root, { body: 'A dialog over a dialog.', input, title: 'Stacked', width: 30 });
  await show('d, then a second dialog opened over the first: the topmost has the focus');

  await term.press(KEYS.tab, KEYS.tab);
  await show('Tab Tab: it cycles in the top dialog alone');

  await term.press(KEYS.escape);
  await new Promise((resolve) => setTimeout(resolve, 100));
  await show('Escape: only the top dialog closes, and the confirm below has the keys again');

  await term.press(KEYS.escape);
  await new Promise((resolve) => setTimeout(resolve, 100));
  await show('Escape: the confirm closes, and the row has the focus back');

  input.stop();
}
