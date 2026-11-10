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
 * The shortcut beside an item -- `ctrl+n`, `ctrl+o`, `ctrl+y` -- is a label the menu
 * draws and nothing more: the menu binds no key for it, because which key does what
 * is the app's. So this app binds the three itself, to the same actions, and they
 * work with no menu open. Copy is `ctrl+y` rather than `ctrl+c`, which is the abort
 * and quits.
 *
 * Under the bar is a dropdown that sorts the list, and the list shows the name, the
 * size and the date each file was modified, with an arrow on the column it is sorted
 * by: name A to Z, size largest first, modified newest first. Tab to the dropdown
 * and Enter, Space or Down opens it under itself with the current choice
 * highlighted; a letter picks the next choice starting with it without opening
 * anything.
 *
 * Right click a file, or press Shift-F10 or the Menu key with the focus on one, for
 * a context menu about that file -- at the pointer, or under the row. The focus
 * never leaves the row while a menu is open: Escape, a click outside or Tab closes
 * it, and the keys are the menu's until then, so `q` does not quit with one open.
 *
 * At the bottom is the same pair styled: a menubar and a dropdown on a blue
 * background. The bar's and the field's own look is a class in `props`; the menus
 * they open are drawn on the root rather than inside them, so a rule under the bar
 * cannot reach those, and `menuClass` is what puts a class on them. Two menubars
 * would both answer F10 and the Alt-letters, so the styled one is `keys: false` and
 * opens with the pointer.
 *
 * Piped, there is nobody at the keyboard, so a scripted one drives the same tree
 * and the demo prints it after each step, with the focus said in words. Piped
 * output has no colour, so the styled pair looks like the plain one there.
 */
import { createFullscreenCanvas } from '@ttylabs/sigil/canvas';
import { attachContextMenu, Dropdown, Menubar } from '@ttylabs/sigil/components';
import { box, renderToString, text } from '@ttylabs/sigil/element';
import { createInput, isAbort } from '@ttylabs/sigil/input';
import { createEffect, createRoot, render } from '@ttylabs/sigil/renderer';
import { flush, State } from '@ttylabs/sigil/signals';
import { createTestTerminal, ctrl, KEYS } from '@ttylabs/sigil/testing';
import { themedCascade } from '@ttylabs/sigil/theme';

const live = process.stdin.isTTY && process.stdout.isTTY;

const WIDTH = 52;
const HEIGHT = 22;

/** The files, in no order: the dropdown decides the order they are shown in. */
const FILES = [
  { bytes: 2_150, modified: '2026-10-02', name: 'README.md' },
  { bytes: 1_402, modified: '2026-11-08', name: 'package.json' },
  { bytes: 12_810, modified: '2026-11-09', name: 'src/index.ts' },
  { bytes: 31_044, modified: '2026-11-07', name: 'src/menu.ts' },
  { bytes: 1_086, modified: '2026-01-15', name: 'LICENSE' },
  { bytes: 8_390, modified: '2026-09-21', name: 'docs/guide.md' },
];

/** How each sort orders the files, and which way its arrow points. */
const SORTS = {
  modified: { arrow: '▼', compare: (a, b) => b.modified.localeCompare(a.modified) },
  name: { arrow: '▲', compare: (a, b) => a.name.localeCompare(b.name) },
  size: { arrow: '▼', compare: (a, b) => b.bytes - a.bytes },
};

/** A size the way a file manager writes one. */
const size = (bytes) => (bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KB`);

/** One line of the table, in three columns. */
const columns = (name, bytes, modified) => `${name.padEnd(16)}${bytes.padStart(9)}  ${modified}`;

/** The app's stylesheet: the focused row, and the styled menubar, dropdown and menus. */
const STYLES = `
  .row:focus { inverse: true }
  .tinted-bar { background-color: blue; color: white }
  .tinted-field .sigil-dropdown-face { background-color: blue; color: white }
  .tinted { background-color: blue; color: white; border-color: cyan }
  .tinted .sigil-menu-fill { background-color: blue }
`;

/** The browser: a menubar, a sort dropdown, the files, a status line and the styled pair. */
function scene(input, status) {
  const sort = new State('name');
  const say = (words) => status.set(words);

  const actions = {
    copy: () => say('Edit > Copy'),
    new: () => say('File > New'),
    open: () => say('File > Open'),
  };

  const bar = Menubar({
    input,
    menus: [
      {
        items: [
          { hint: 'ctrl+n', label: '&New', value: actions.new },
          { hint: 'ctrl+o', label: '&Open...', value: actions.open },
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
          { hint: 'ctrl+y', label: '&Copy', value: actions.copy },
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

  // the shortcuts the items show, bound by the app: the menu only draws them
  input.bind('ctrl+n', actions.new, { description: 'new' });
  input.bind('ctrl+o', actions.open, { description: 'open' });
  input.bind('ctrl+y', actions.copy, { description: 'copy' });

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

  // the rows stay the same elements and change what they say, so a re-sort never
  // takes the focus off a row; `shown` is which file each one is showing now
  const header = text('', { class: 'sigil-muted' });
  const rows = FILES.map(() => text('', { class: 'row', focusable: true }));
  const shown = new Map();
  createEffect(() => {
    const by = sort.get();
    const order = [...FILES].sort(SORTS[by].compare);
    const mark = (column) => (column === by ? ` ${SORTS[by].arrow}` : '');
    header.setText(
      columns(`Name${mark('name')}`, `Size${mark('size')}`, `Modified${mark('modified')}`)
    );
    for (const [i, row] of rows.entries()) {
      const file = order[i];
      shown.set(row, file);
      row.setText(columns(file.name, size(file.bytes), file.modified));
    }
  });
  const list = box({ 'flex-direction': 'column' }, header, ...rows);

  const line = text('', { class: 'sigil-muted', 'margin-top': 1 });
  createEffect(() => {
    line.setText(status.get());
  });

  const menu = attachContextMenu(list, {
    input,
    items: (target) => {
      const name = shown.get(target)?.name ?? target.text;
      return [
        { label: '&Open', value: `Open ${name}` },
        { label: '&Rename...', value: `Rename ${name}` },
        { separator: '' },
        {
          disabled: name === 'README.md' ? 'Kept' : false,
          label: '&Delete',
          value: `Delete ${name}`,
        },
      ];
    },
    onSelect: (item) => say(item.value),
  });

  // the same two components, styled: `props.class` for the bar and the field
  // themselves, `menuClass` for the menus they open on the root
  const styledBar = Menubar({
    input,
    keys: false,
    menuClass: 'tinted',
    menus: [
      {
        items: [
          { hint: 'ctrl+t', label: '&Terminal', value: 'Tools > Terminal' },
          { label: '&Settings...', value: 'Tools > Settings' },
        ],
        label: '&Tools',
      },
      {
        items: [
          { label: '&Docs', value: 'Help > Docs' },
          { disabled: 'Offline', label: '&Updates', value: 'Help > Updates' },
        ],
        label: '&Help',
      },
    ],
    onSelect: (item) => say(`${item.value} (styled)`),
    props: { class: 'tinted-bar' },
  });
  const styledDropdown = Dropdown({
    input,
    menuClass: 'tinted',
    onChange: (to) => say(`Theme: ${to} (styled)`),
    options: ['system', 'light', 'dark'],
    props: { class: 'tinted-field' },
    value: 'system',
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
    line,
    text('Styled: menuClass and props.class', { class: 'sigil-muted', 'margin-top': 1 }),
    styledBar,
    box(
      { 'column-gap': 1, 'flex-direction': 'row', 'margin-top': 1 },
      text('Theme'),
      styledDropdown
    )
  );
  return { bar, dropdown, line, menu, root, rows, shown, styledBar, styledDropdown };
}

if (live) {
  const status = new State('F10 or Alt-F for the menus; right click a file; ctrl+n works too');
  // the router is made over the renderer's root, and the components need the
  // router to hold the keys with -- so the tree goes into a holder afterwards
  const holder = box({ 'flex-grow': 1 });
  const view = render(() => holder, {
    backend: createFullscreenCanvas(),
    cascade: themedCascade({ sheets: [STYLES] }),
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

  const cascade = themedCascade({ sheets: [STYLES] });
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
    if (at === ui.dropdown) {
      return 'the dropdown';
    }
    if (at === ui.styledDropdown) {
      return 'the styled dropdown';
    }
    const file = ui.shown.get(at);
    return file ? `the row for ${file.name}` : JSON.stringify(at.text);
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
  // the pointer, aimed at where the layout put things rather than at fixed cells,
  // since the rows move when the list is sorted; an SGR report counts from 1
  const at = (element, dx = 1) => ({
    x: (element.box?.x ?? 0) + dx + 1,
    y: (element.box?.y ?? 0) + 1,
  });
  const pressOn = (p, button = 0) => `${ESC}[<${button};${p.x};${p.y}M`;
  const releaseOn = (p, button = 0) => `${ESC}[<${button};${p.x};${p.y}m`;
  const dragTo = (p) => `${ESC}[<32;${p.x};${p.y}M`;
  const rowFor = (name) => ui.rows.find((row) => ui.shown.get(row)?.name === name);

  draw();
  show('as built: sorted by name, the focus on the first file');

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

  await key(ctrl('o'));
  show('Ctrl-O with no menu open: the shortcut Open shows, which the app bound');

  // the pointer: a press on a title dragged onto an item and released there
  const file = ui.bar.children[0];
  await key(pressOn(at(file)));
  show('A press on File: open, with nothing highlighted until it is pointed at');
  const newRow = at(file, 2);
  newRow.y += 2;
  await key(dragTo(newRow), releaseOn(newRow));
  show('Dragged onto New and released: chosen');

  input.focus.focus(ui.dropdown);
  await key(KEYS.enter);
  show('Tab to the dropdown and Enter: the list under it, the value highlighted');

  await key(KEYS.down, KEYS.enter);
  show('Down and Enter: sorted by size, largest first, the arrow on Size');

  await key('m');
  show('m, closed: the next choice starting with m -- sorted by modified, newest first');

  input.focus.focus(rowFor('src/index.ts'));
  await key(`${ESC}[21;2~`);
  show('Shift-F10 on src/index.ts: a context menu under the row');

  await key('r');
  show('r: Rename chosen by its mnemonic');

  const readme = at(rowFor('README.md'), 2);
  await key(pressOn(readme, 2), releaseOn(readme, 2));
  show('A right click on README.md: at the pointer, and Delete is kept');

  const outside = { x: WIDTH - 2, y: at(ui.line).y };
  await key(pressOn(outside), releaseOn(outside));
  show('A click outside: dismissed, and it reached nothing under it');

  const tools = ui.styledBar.children[0];
  await key(pressOn(at(tools)));
  show('A press on the styled Tools: its menu wears menuClass, blue on a terminal');

  await key(KEYS.down, KEYS.down, KEYS.enter);
  show('Down twice and Enter: Settings, from the styled menu');

  input.focus.focus(ui.styledDropdown);
  await key(KEYS.enter);
  show('The styled dropdown opened: its list wears menuClass too');

  await key(KEYS.down, KEYS.down, KEYS.enter);
  show('Down twice and Enter: dark');

  input.stop();
}
