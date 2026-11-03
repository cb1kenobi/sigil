/**
 * A text field: one editable line as an element, here inside a modal.
 *
 *   node demos/components/50-text-field.js      <- Up/Down or Tab, r renames, q quits
 *   node demos/components/50-text-field.js | cat
 *
 * A small file list where `r` opens a rename dialog with a text field in it. The
 * arrows move along the list because the rows claim them; Tab works too, as the
 * router's default, and is the one key that moves the focus inside the dialog. The
 * field joins the dialog's focus trap: Tab and Shift-Tab cycle through the field
 * and the two buttons, Enter in the field renames (it was given `onSubmit`), and
 * Escape still dismisses, because Tab and Escape are never the field's.
 *
 * The app also has a paste handler of its own, registered at startup, which says
 * what was pasted on the list. A paste while the field has the focus goes into the
 * field and that handler never hears of it -- a focused element is offered a paste
 * before the router's handlers are. Nor does it hear a paste on one of the
 * dialog's buttons, which claim nothing: the dialog stops what reaches it.
 *
 * The field is drawn on a background of its own -- bright black on a dark
 * terminal, white on a light one -- so `parser.ts` in the dialog reads as a name
 * to edit before the caret appears, rather than as a label.
 *
 * Piped, there is nobody to type, so a scripted keyboard drives the same tree and
 * the demo prints it after each step. The caret is an inverse cell and the field's
 * background is a colour, both of which a pipe drops, so they are said in words:
 * where the caret is, and which palette index the field resolved to in each scheme.
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

// the row the keys go to, and the row a dialog is renaming -- which has lost the
// focus to the dialog, so it needs a mark of its own to stay found
const sheet = '.file:focus { inverse: true } .file.renaming { inverse: true }';

/** The list the dialog is laid over, the outcome line, and the keys. */
function scene() {
  const rows = FILES.map((name) => text(name, { class: 'file', focusable: true }));
  // a row of its own even while it is empty, so the keys under it never move
  const status = text('', { height: 1 });
  const root = box(
    { 'flex-direction': 'column', height: 10, width: 44 },
    text('Files', { class: 'sigil-heading' }),
    ...rows,
    status,
    text('↑/↓ or Tab move · r renames · q quits', { class: 'sigil-muted' })
  );
  return { root, rows, status };
}

/**
 * Wires `r` on the rows, and the app's own paste handler.
 *
 * @param {import('@ttylabs/sigil/input').InputRouter} input - The router.
 * @param {{ root: import('@ttylabs/sigil/element').Element; rows: any[]; field?: any }} ui - The list, and the field once a dialog has opened.
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
    ui.field = field;
    const dialog = openModal(ui.root, {
      actions: [{ label: 'Rename', value: true }, { label: 'Cancel' }],
      body: field,
      input,
      title: `Rename ${row.text}`,
      width: 34,
    });
    // the field rather than the first button, which is where a rename starts
    input.focus.focus(field);
    row.addClass('renaming');
    const answer = await dialog.result;
    row.removeClass('renaming');
    if (answer === true && name.get() !== '') {
      status.setText(`renamed ${row.text} to ${name.get()}`);
      row.setText(name.get());
    } else {
      status.setText(`kept ${row.text}`);
    }
  };

  for (const row of ui.rows) {
    row.onKey = (event) => {
      if (event.paste) {
        return;
      }
      // Tab is the router's default and works anywhere; the arrows are this list's,
      // so they are claimed here rather than bound app-wide, where they would also
      // be taken from the dialog's buttons
      if (event.key.name === 'down') {
        event.stop();
        input.focus.next();
      } else if (event.key.name === 'up') {
        event.stop();
        input.focus.previous();
      } else if (event.key.name === 'r') {
        event.stop();
        void rename(row);
      }
    };
  }
}

if (live) {
  const ui = scene();
  const { status } = ui;
  const view = render(() => ui.root, {
    backend: createFullscreenCanvas(),
    cascade: themedCascade({ sheets: [sheet] }),
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
  const ui = scene();
  const { status } = ui;
  const input = createInput({ root: ui.root, terminal: term.terminal });
  wire(input, ui, status);
  const cascade = themedCascade({ sheets: [sheet] });

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

  await term.press(KEYS.tab, KEYS.down, KEYS.down, KEYS.up);
  await term.paste('notes.md');
  await show('Tab, Down x2, Up, then a paste on the list: the app handler has it');

  await term.press('r');
  await show('r: the rename dialog opens with the name in a field');

  // the background a pipe drops, read back off the field rather than off the bytes:
  // resolved once per scheme at colour level 1, which is the lowest that keeps it
  for (const colorScheme of ['dark', 'light']) {
    const scheme = themedCascade({ colorScheme, sheets: [sheet] });
    renderToString(ui.root, { cascade: scheme, colorLevel: 1, colorScheme, height: 10, width: 44 });
    const { backgroundColor } = ui.field.style;
    console.log(
      `the field on a ${colorScheme} terminal: palette index ${backgroundColor} behind all ${ui.field.box.width} of its columns`
    );
  }
  console.log('');

  await term.press(KEYS.tab, KEYS.tab, KEYS.tab);
  await show('Tab x3: the field, Rename and Cancel are one ring, and it comes back round');

  await term.press(KEYS.tab);
  await term.paste('todo.md');
  await show('Tab, then a paste on Rename: the dialog keeps it, and the list hears nothing');
  // the list's status line is under the dialog, so what it says is said in words:
  // still the first paste, because this one never reached the app's handler
  console.log(`the list's status line, under the dialog: ${status.text}\n`);

  await term.press(KEYS.shiftTab, KEYS.backspace, KEYS.backspace, KEYS.backspace);
  await term.paste('.mts');
  await show('Shift-Tab, Backspace x3, then a paste: it goes into the field, not to the app');

  await term.press(KEYS.enter);
  await show('Enter in the field: it was given onSubmit, so that is Rename');

  await term.press('r', 'x');
  await term.press(KEYS.escape);
  // a lone Escape is held until nothing follows it
  await new Promise((resolve) => setTimeout(resolve, 100));
  await show('r, x, Escape: the field did not keep Escape, so the dialog was dismissed');

  input.stop();
}
