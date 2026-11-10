/**
 * A key-help footer that cannot drift from the keys.
 *
 *   node demos/components/20-key-help.js      <- Tab moves, up/down pick a row, ? expands, q quits
 *   node demos/components/20-key-help.js | cat
 *
 * `↑/↓ move · enter open · q quit` is not written anywhere in this file. Each
 * binding carries its own description, and the footer is `router.bindings()`
 * read inside an effect: it follows the focus, follows a binding being added or
 * removed, and drops the lowest-priority keys first when the line is wider than
 * the box it is laid out in -- which it learns from the layout, so a resize refits
 * it with nothing passed in. `?` is the app's own binding -- the component does not
 * claim a key -- and it flips the signal that expands the footer into groups.
 *
 * Two kinds of key are described, and the difference is the honest part. A key
 * bound with `bind()` is described *there*, so the description and the handler
 * are one call. A key an element handles in its `onKey` is a function the router
 * cannot read, so `describe()` declares it, scoped to the element: it is listed
 * while that element or something inside it holds the focus. That half can drift
 * from its handler, which is the price of an element owning its own keys.
 *
 * Piped, there is nobody to type, so it replays a few keys through the testing
 * terminal and prints the footer after each.
 */
import { keyHelp } from '@ttylabs/sigil/components';
import { box, renderToString, text } from '@ttylabs/sigil/element';
import { createInput } from '@ttylabs/sigil/input';
import { render } from '@ttylabs/sigil/renderer';
import { State } from '@ttylabs/sigil/signals';
import { Cascade, parseStylesheet } from '@ttylabs/sigil/style';
import { createTestTerminal, KEYS } from '@ttylabs/sigil/testing';
import { themedCascade } from '@ttylabs/sigil/theme';

const live = process.stdin.isTTY && process.stdout.isTTY;

const sheet = parseStylesheet(`
  .app { flex-direction: column; max-width: 46; border: round; border-color: gray; padding: 1 }
  .pane { padding-left: 1 }
  .pane:focus { background-color: blue; color: white }
  .list { flex-direction: column }
  .row { padding-left: 1 }
  .marker { visibility: hidden; padding-right: 1 }
  .current .marker { visibility: visible }
  .row.current { color: cyan }
  .list:focus .row.current,
  .list:focus .row.current .marker,
  .list:focus .row.current .name { background-color: blue; color: white }
  .status { color: gray }
`);

const names = ['parser', 'canvas', 'layout'];

/** The panes, and the status line the keys write to. */
function scene() {
  const status = text('Tab to move between panes', { class: 'status' });
  const rows = names.map((name, i) =>
    box(
      { class: i === 0 ? 'row current' : 'row' },
      text('›', { class: 'marker' }),
      text(name, { class: 'name' })
    )
  );
  const files = box({ class: 'list', focusable: true }, ...rows);
  const editor = box({ class: 'pane', focusable: true }, text('editor'));
  const container = box({ class: 'app' }, files, editor, status);
  return { container, editor, files, rows, status };
}

/**
 * Binds the keys, describing each one where it is handled.
 *
 * @param {import('@ttylabs/sigil/input').InputRouter} input - The router.
 * @param {ReturnType<typeof scene>} ui - The panes.
 * @param {State<boolean>} expanded - What `?` flips.
 * @param {() => void} quit - What `q` does.
 */
function wire(input, ui, expanded, quit) {
  // app-wide, and the ones to keep when the line runs out of room
  input.bind('?', () => expanded.set(!expanded.get()), { description: 'help', priority: 9 });
  input.bind('q', quit, { description: 'quit', group: 'app', priority: 8 });

  // an element's own keys: handled in `onKey`, declared with `describe()`
  let row = 0;
  ui.files.onKey = (event) => {
    const { name } = event.key;
    if (name === 'up' || name === 'down') {
      row = (row + (name === 'down' ? 1 : names.length - 1)) % names.length;
      ui.rows.forEach((el, i) => el.toggleClass('current', i === row));
      ui.status.setText(`on ${names[row]}`);
      event.stop();
    } else if (name === 'enter') {
      ui.status.setText(`opened ${names[row]}`);
      event.stop();
    }
  };
  input.describe('up', { description: 'move', group: 'files', priority: 6, scope: ui.files });
  input.describe('down', { description: 'move', group: 'files', priority: 6, scope: ui.files });
  input.describe('enter', { description: 'open', group: 'files', priority: 5, scope: ui.files });

  ui.editor.onKey = (event) => {
    if (event.key.ctrl && event.key.name === 's') {
      ui.status.setText('saved');
      event.stop();
    }
  };
  input.describe('ctrl+s', { description: 'save', group: 'editor', priority: 5, scope: ui.editor });
}

if (live) {
  const ui = scene();
  const view = render(() => ui.container, { cascade: new Cascade([sheet]) });
  const input = createInput({ root: view.root });
  const expanded = new State(false);

  wire(input, ui, expanded, () => {
    view.dispose();
    input.stop();
    process.exit(0);
  });
  // no width: it is fitted to the box it is laid out in, inside the border
  ui.container.append(keyHelp(input, { expanded }));
  input.focus.focus(ui.files);
} else {
  const term = createTestTerminal({ columns: 46 });
  const ui = scene();
  const input = createInput({ root: ui.container, terminal: term.terminal });
  const expanded = new State(false);
  let width = 46;

  wire(input, ui, expanded, () => {});
  // no width here either: each render lays the app out at the width it is given,
  // and the footer refits to its box inside the border before it is painted
  ui.container.append(keyHelp(input, { expanded }));
  const cascade = themedCascade({ theme: sheet });
  const show = (label) => {
    const lines = renderToString(ui.container, { cascade, colorLevel: 0, width });
    console.log(`${label}\n${lines.replace(/^/gm, '  ')}\n`);
  };

  // let the footer's effect settle after each change before reading it
  const settle = () => new Promise((resolve) => setImmediate(resolve));

  await settle();
  show('nothing focused: only the app-wide keys');

  await term.press(KEYS.tab);
  await settle();
  show('Tab -> files: its keys join, in dispatch order');

  await term.press(KEYS.down);
  await settle();
  show('down: the files keys act, and the footer is unchanged');

  await term.press(KEYS.tab);
  await settle();
  show('Tab -> editor: files keys leave, editor keys arrive');

  await term.press(KEYS.tab);
  await settle();
  width = 24;
  show('back on files, 24 columns: lowest priority goes first, then an ellipsis');

  width = 46;
  await term.press('?');
  await settle();
  show('? -> expanded: every binding, under its group');

  input.stop();
}
