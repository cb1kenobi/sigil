/**
 * A text field: one editable line as an element, here inside a modal.
 *
 *   node demos/components/50-text-field.js      <- Tab, r renames the row, q quits
 *   node demos/components/50-text-field.js | cat
 *
 * A small file list where `r` opens a rename dialog with a text field in it. The
 * field joins the dialog's focus trap: Tab and Shift-Tab cycle through the field
 * and the two buttons, Enter in the field renames (it was given `onSubmit`), and
 * Escape still dismisses, because Tab and Escape are never the field's.
 *
 * The app also has a paste handler of its own, registered at startup, which says
 * what was pasted on the list. A paste while the field has the focus goes into the
 * field and that handler never hears of it -- a focused element is offered a paste
 * before the router's handlers are.
 *
 * Piped, there is nobody to type, so a scripted keyboard drives the same tree and
 * the demo prints it after each step. The caret is an inverse cell, which a pipe
 * drops, so where it is is said in words.
 */
import { createFullscreenCanvas } from '@ttylabs/sigil/canvas';
import { openModal, TextField } from '@ttylabs/sigil/components';
import { box, renderToString, text } from '@ttylabs/sigil/element';
import { createInput, isAbort } from '@ttylabs/sigil/input';
import { render } from '@ttylabs/sigil/renderer';
import { State } from '@ttylabs/sigil/signals';
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
 * Wires `r` on the rows, and the app's own paste handler.
 *
 * @param {import('@ttylabs/sigil/input').InputRouter} input - The router.
 * @param {{ root: import('@ttylabs/sigil/element').Element; rows: any[] }} ui - The list.
 * @param {import('@ttylabs/sigil/element').Element} status - Where the outcome is said.
 */
function wire(input, ui, status) {
  // an app-wide handler made at startup, before any dialog exists
  input.onPaste((event) => {
    status.setText(`the list was pasted: ${event.text}`);
    event.stop();
  });

  const rename = async (row) => {
    const name = new State(row.text);
    const field = TextField({ onSubmit: () => dialog.close(true), value: name });
    const dialog = openModal(ui.root, {
      actions: [{ label: 'Rename', value: true }, { label: 'Cancel' }],
      body: field,
      input,
      title: `Rename ${row.text}`,
      width: 34,
    });
    // the field rather than the first button, which is where a rename starts
    input.focus.focus(field);
    if ((await dialog.result) === true && name.get() !== '') {
      status.setText(`renamed ${row.text} to ${name.get()}`);
      row.setText(name.get());
    } else {
      status.setText(`kept ${row.text}`);
    }
  };

  for (const row of ui.rows) {
    row.onKey = (event) => {
      if (event.key.name === 'r' && !event.paste) {
        event.stop();
        void rename(row);
      }
    };
  }
}

if (live) {
  const status = text('r renames the row you are on', { class: 'sigil-muted' });
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
  const status = text('r renames the row you are on', { class: 'sigil-muted' });
  const ui = scene(status);
  const input = createInput({ root: ui.root, terminal: term.terminal });
  wire(input, ui, status);
  const cascade = themedCascade();

  const settle = () => new Promise((resolve) => setImmediate(resolve));
  /** Where the focus is, in words. */
  const where = () => {
    const at = input.focus.current.get();
    if (at === undefined) {
      return 'nothing';
    }
    return at.classes.includes('sigil-text-field') ? 'the text field' : JSON.stringify(at.text);
  };
  const show = async (label) => {
    await settle();
    const body = renderToString(ui.root, { cascade, colorLevel: 0, height: 10, width: 44 });
    console.log(`-- ${label}\n${body.replace(/\s+$/gm, '')}\nfocus: ${where()}\n`);
  };

  await term.press(KEYS.tab);
  await term.paste('notes.md');
  await show('Tab, then a paste on the list: the app handler has it');

  await term.press('r');
  await show('r: the rename dialog opens with the name in a field');

  await term.press(KEYS.tab, KEYS.tab, KEYS.tab);
  await show('Tab x3: the field, Rename and Cancel are one ring, and it comes back round');

  await term.press(KEYS.backspace, KEYS.backspace, KEYS.backspace);
  await term.paste('.mts');
  await show('Backspace x3, then a paste: it goes into the field, not to the app');

  await term.press(KEYS.enter);
  await show('Enter in the field: it was given onSubmit, so that is Rename');

  await term.press('r', 'x');
  await term.press(KEYS.escape);
  // a lone Escape is held until nothing follows it
  await new Promise((resolve) => setTimeout(resolve, 100));
  await show('r, x, Escape: the field did not keep Escape, so the dialog was dismissed');

  input.stop();
}
