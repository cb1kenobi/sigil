/**
 * Menus: a menubar across the top, a dropdown select, and a context menu.
 *
 *   node demos/components/61-menus.js      <- F10 or Alt-F for the menus; right click a file; q quits
 *   node demos/components/61-menus.js | cat
 *
 * A small file browser. The bar across the top has File, Edit and View: F10 opens
 * the first, Alt with a title's underlined letter opens that one, Left and Right
 * move between them, and Open Recent has a submenu. A press on a title opens it, a
 * press on it again closes it, and a press dragged onto an item and released
 * chooses it. Undo is disabled, and says why.
 *
 * Under the bar is a dropdown that sorts the list. Tab to it and Enter, Space or
 * Down opens it under itself with the current choice highlighted; a letter picks
 * the next choice starting with it without opening anything.
 *
 * Right click a file, or press Shift-F10 or the Menu key with the focus on one, for
 * a context menu about that file -- at the pointer, or under the row. The focus
 * never leaves the row while a menu is open: Escape, a click outside or Tab closes
 * it, and the keys are the menu's until then, so `q` does not quit with one open.
 *
 * Piped, there is nobody at the keyboard, so a scripted one drives the same tree
 * and the demo prints it after each step, with the focus said in words.
 */
import { createFullscreenCanvas } from '@ttylabs/sigil/canvas';
import { attachContextMenu, Dropdown, Menubar } from '@ttylabs/sigil/components';
import { box, renderToString, text } from '@ttylabs/sigil/element';
import { createInput, isAbort } from '@ttylabs/sigil/input';
import { createEffect, createRoot, render } from '@ttylabs/sigil/renderer';
import { flush, State } from '@ttylabs/sigil/signals';
import { createTestTerminal, KEYS } from '@ttylabs/sigil/testing';
import { themedCascade } from '@ttylabs/sigil/theme';

const live = process.stdin.isTTY && process.stdout.isTTY;

const WIDTH = 48;
const HEIGHT = 14;

const FILES = ['README.md', 'package.json', 'src/index.ts', 'src/menu.ts'];

/** The browser: a menubar, a sort dropdown, the files, and a status line. */
function scene(input, status) {
  const sort = new State('name');
  const say = (words) => status.set(words);

  const bar = Menubar({
    input,
    menus: [
      {
        items: [
          { hint: 'ctrl+n', label: '&New', value: () => say('File > New') },
          { hint: 'ctrl+o', label: '&Open...', value: () => say('File > Open') },
          {
            items: [
              { label: 'notes.md', value: () => say('Opened notes.md') },
              { label: 'todo.md', value: () => say('Opened todo.md') },
            ],
            label: 'Open &Recent',
          },
          { separator: '' },
          { label: '&Quit', value: () => say('File > Quit (q quits)') },
        ],
        label: '&File',
      },
      {
        items: [
          { disabled: 'Nothing to undo', label: '&Undo', value: () => {} },
          { hint: 'ctrl+c', label: '&Copy', value: () => say('Edit > Copy') },
        ],
        label: '&Edit',
      },
      {
        items: [
          { label: '&Hidden files', value: () => say('View > Hidden files') },
          { label: '&Refresh', value: () => say('View > Refresh') },
        ],
        label: '&View',
      },
    ],
    // a value is any value, and a function is a fine one: the bar hands back the
    // item, and what to do with it is the app's
    onSelect: (item) => item.value(),
  });

  const dropdown = Dropdown({
    input,
    onChange: (to) => say(`Sorted by ${to}`),
    options: [
      { label: 'name', value: 'name' },
      { label: 'size', value: 'size' },
      { label: 'modified', value: 'modified' },
      { disabled: 'Not tracked', label: 'owner', value: 'owner' },
    ],
    value: sort,
  });

  const rows = FILES.map((name) => text(name, { class: 'row', focusable: true }));
  const list = box({ 'flex-direction': 'column', 'flex-grow': 1 }, ...rows);
  const line = text('', { class: 'sigil-muted' });
  createEffect(() => {
    line.setText(status.get());
  });

  const menu = attachContextMenu(list, {
    input,
    items: (target) => [
      { label: '&Open', value: `Open ${target.text}` },
      { label: '&Rename...', value: `Rename ${target.text}` },
      { separator: '' },
      {
        disabled: target.text === 'README.md' ? 'Kept' : false,
        label: '&Delete',
        value: `Delete ${target.text}`,
      },
    ],
    onSelect: (item) => say(item.value),
  });

  const root = box(
    { 'flex-direction': 'column', height: HEIGHT, width: WIDTH },
    bar,
    box(
      { 'column-gap': 1, 'flex-direction': 'row', 'margin-bottom': 1, 'margin-top': 1 },
      text('Sort'),
      dropdown
    ),
    list,
    line
  );
  return { bar, dropdown, line, menu, root, rows };
}

if (live) {
  const status = new State('F10 or Alt-F for the menus; right click a file');
  // the router is made over the renderer's root, and the components need the
  // router to hold the keys with -- so the tree goes into a holder afterwards
  const holder = box({ 'flex-grow': 1 });
  const view = render(() => holder, {
    backend: createFullscreenCanvas(),
    cascade: themedCascade({ sheets: ['.row:focus { inverse: true }'] }),
  });
  const input = createInput({ mouse: { motion: true, surface: view.backend }, root: view.root });
  const ui = createRoot(() => scene(input, status));
  holder.append(ui.root);
  input.focus.focus(ui.rows[0]);

  const quit = () => {
    input.stop();
    view.dispose();
    process.stdin.unref();
  };
  // a fallback, so a menu that is open has the q rather than the app
  input.fallback('q', quit);
  input.bind((event) => {
    if (isAbort(event.key)) {
      event.stop();
      quit();
    }
  });
} else {
  const ESC = String.fromCharCode(0x1b);
  const term = createTestTerminal({ columns: WIDTH, rows: HEIGHT });
  const holder = box({ height: HEIGHT, width: WIDTH });
  const input = createInput({
    mouse: {
      motion: true,
      surface: {
        height: HEIGHT,
        locate: async () => true,
        origin: { x: 0, y: 0 },
        toCanvas: (column, row) => ({ x: column - 1, y: row - 1 }),
        width: WIDTH,
      },
    },
    root: holder,
    terminal: term.terminal,
  });
  const status = new State('');
  const ui = createRoot(() => scene(input, status));
  holder.append(ui.root);
  input.focus.focus(ui.rows[0]);

  const cascade = themedCascade();
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const draw = () => {
    flush();
    return renderToString(holder, { cascade, colorLevel: 0, height: HEIGHT, width: WIDTH });
  };
  const where = () => {
    const at = input.focus.current.get();
    if (at === undefined) {
      return 'nothing';
    }
    return at === ui.dropdown ? 'the dropdown' : JSON.stringify(at.text);
  };
  const show = (label) => {
    flush();
    const body = draw()
      .split('\n')
      .map((line) => line.trimEnd())
      .join('\n');
    console.log(`-- ${label}\n${body}\nfocus: ${where()}\n`);
  };
  /** A key, and a frame so that what it opened is laid out before the next one. */
  const key = async (...keys) => {
    for (const k of keys) {
      await term.press(k);
      draw();
    }
  };
  const escape = async () => {
    await term.press(KEYS.escape);
    // a lone Escape is held until nothing follows it
    await sleep(100);
    draw();
  };

  draw();
  show('as built: the focus on the first file');

  await key(`${ESC}[21~`);
  show('F10: the File menu, its title bracketed, the focus still on the file');

  await key(KEYS.up, KEYS.up, KEYS.right);
  show('Up twice and Right: Open Recent opens its submenu beside its row');

  await key(KEYS.left, KEYS.left);
  show('Left closes the submenu, and Left again moves to the last title');

  await key(KEYS.left, KEYS.down);
  show('Left to Edit, Down: past the disabled Undo, which says why');

  await key('q');
  show('q, with a menu open: the menu has the keys, so nothing quits');

  await escape();
  show('Escape: closed, and the focus is where it was');

  await key(`${ESC}v`, 'r');
  show('Alt-V, then r: View > Refresh chosen by its mnemonic');

  // the pointer: a press on a title dragged onto an item and released there
  await key(`${ESC}[<0;2;1M`);
  show('A press on File: open, with nothing highlighted until it is pointed at');
  await key(`${ESC}[<32;4;3M`, `${ESC}[<0;4;3m`);
  show('Dragged onto New and released: chosen');

  input.focus.focus(ui.dropdown);
  await key(KEYS.enter);
  show('Tab to the dropdown and Enter: the list under it, the value highlighted');

  await key(KEYS.down, KEYS.enter);
  show('Down and Enter: sorted by size');

  await key('m');
  show('m, closed: the next choice starting with m, without opening anything');

  input.focus.focus(ui.rows[2]);
  await key(`${ESC}[21;2~`);
  show('Shift-F10 on src/index.ts: a context menu under the row');

  await key('r');
  show('r: Rename chosen by its mnemonic');

  await key(`${ESC}[<2;5;5M`, `${ESC}[<2;5;5m`);
  show('A right click on README.md: at the pointer, and Delete is kept');

  await key(`${ESC}[<0;40;13M`, `${ESC}[<0;40;13m`);
  show('A click outside: dismissed, and it reached nothing under it');

  input.stop();
}
