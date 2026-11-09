/**
 * Panels and panes: words in a border, and an edge that resizes.
 *
 *   node demos/components/56-panels.js      <- drag an edge, click one and use the arrows, q
 *   node demos/components/56-panels.js | cat
 *
 * The layout of a file manager or an editor: a sidebar, the main region, and a log.
 * Each of the three is a `Panel`, with a title in its top border, an annotation at
 * its right end and a footer along the bottom -- and the two at the sides are in a
 * `Pane` each, which gives the panel a size in cells and an edge to move it by.
 *
 * Drag the sidebar's right edge, or the log's left one. The edge is one cell laid
 * over the pane's own border and takes no room, and it lights up under the pointer.
 * Click it to focus it and the arrows move it a cell, Shift with an arrow five; it
 * is not a Tab stop. Double-click the sidebar's edge to collapse it to nothing, and
 * double-click where the edge went to bring it back. `b` does the same from the
 * keyboard, through `paneControl()`.
 *
 * Narrow the terminal, or drag a pane small, and watch a border give way: its
 * annotation goes first, then its title is cut with an ellipsis, and at the extreme
 * the border is plain. The top and the bottom are each on their own.
 *
 * Piped, there is nobody to drag, so the same tree is drawn at two widths and then
 * moved with the keys, which are real, and with `resize()`, which is what a drag
 * calls.
 */
import { createInlineCanvas } from '@ttylabs/sigil/canvas';
import { keyHelp, Pane, paneControl, Panel } from '@ttylabs/sigil/components';
import { box, renderToString, text } from '@ttylabs/sigil/element';
import { createInput, isAbort } from '@ttylabs/sigil/input';
import { render } from '@ttylabs/sigil/renderer';
import { State } from '@ttylabs/sigil/signals';
import { createTestTerminal, KEYS } from '@ttylabs/sigil/testing';
import { themedCascade } from '@ttylabs/sigil/theme';

const live = process.stdin.isTTY && process.stdout.isTTY;

const WIDTH = 72;
const HEIGHT = 12;

/** Shift with an arrow, which the testing keys do not name. */
const SHIFT_RIGHT = `${String.fromCharCode(0x1b)}[1;2C`;

/**
 * The sheet: the main region takes what the panes leave, and a panel under the pointer
 * takes a coloured border -- the border is the box's own, so that is one rule.
 */
const sheet = `
  .main { flex-grow: 1; min-width: 0 }
  .sigil-panel:hover { border-color: cyan }
`;

/** The three panes, and the tree they sit in. */
function scene() {
  const sidebarWidth = new State(20);
  const logWidth = new State(24);
  const line = new State(12);

  const sidebar = Pane(
    { collapsible: true, max: 36, min: 14, size: sidebarWidth },
    Panel(
      {
        footer: '3 files',
        title: () => `files · ${sidebarWidth.get()} cols`,
      },
      text('src/'),
      text('  main.js'),
      text('  panel.js'),
      text('README.md')
    )
  );

  const editor = Panel(
    {
      annotation: () => `ln ${line.get()}`,
      footer: 'utf-8 · lf',
      footerAnnotation: 'javascript',
      props: { class: 'main' },
      title: 'main.js',
    },
    text('import { Pane, Panel } from "@ttylabs/sigil/components";'),
    text(''),
    text('Pane({ size: 20, min: 14, collapsible: true }, ...);')
  );

  const log = Pane(
    { edge: 'start', max: 40, min: 12, size: logWidth },
    Panel(
      { annotation: 'tail', footer: () => `${logWidth.get()} cols`, title: 'log' },
      text('12:01 build ok'),
      text('12:02 watching'),
      text('12:04 changed')
    )
  );

  const root = box(
    { 'flex-direction': 'column', width: WIDTH },
    box({ 'flex-direction': 'row', height: HEIGHT }, sidebar, box({ class: 'main' }, editor), log)
  );

  return { log, root, sidebar };
}

if (live) {
  const ui = scene();
  const canvas = createInlineCanvas({ height: HEIGHT + 2 });
  /** The footer, appended once the router it reads exists. */
  const footer = box({ 'margin-top': 1 });
  const view = render(() => box({ 'flex-direction': 'column' }, ui.root, footer), {
    backend: canvas,
    cascade: themedCascade({ sheets: [sheet] }),
    height: HEIGHT + 2,
    width: 'auto',
  });
  // motion, which is what `:hover` and the edge lighting up under the pointer cost
  const input = createInput({ mouse: { motion: true, surface: canvas }, root: view.root });

  const quit = () => {
    view.dispose();
    input.stop();
  };
  input.bind('q', quit, { description: 'quit', priority: 9 });
  input.bind('b', () => paneControl(ui.sidebar)?.toggle(), { description: 'sidebar' });
  input.bind((event) => {
    if (isAbort(event.key)) {
      event.stop();
      quit();
    }
  });
  footer.append(keyHelp(input, { width: WIDTH }));
} else {
  const term = createTestTerminal({ columns: WIDTH });
  const ui = scene();
  const input = createInput({ root: ui.root, terminal: term.terminal });
  const cascade = themedCascade({ sheets: [sheet] });
  const sidebar = paneControl(ui.sidebar);
  const log = paneControl(ui.log);

  // an effect runs on the microtask after the write that wakes it
  const settle = () => new Promise((resolve) => setImmediate(resolve));

  /** Prints the tree at a width under a heading. */
  const show = async (label, width = WIDTH) => {
    await settle();
    ui.root.setProp('width', width);
    const body = renderToString(ui.root, { cascade, colorLevel: 0, width });
    console.log(`-- ${label}\n${body}\n`);
  };

  await show('as built: three panes in 72 columns');

  await show(
    'the same at 60 columns: the main region has 16 left, and its annotation goes first',
    60
  );

  // a click focuses the edge, which a pipe cannot send; the app can do it directly
  input.focus.focus(sidebar.edge);
  await term.press(KEYS.right, KEYS.right);
  await show('the sidebar edge focused, Right twice: two cells wider, and the edge lit');

  await term.press(SHIFT_RIGHT);
  await show('Shift+Right: five more, and the main region gives them up');

  sidebar.resize(60);
  await show('resize(60), which is what a drag asks for: stopped at the pane’s max of 36');

  await term.press(KEYS.enter);
  await show('Enter on the edge: the sidebar collapses, and its edge stays so it can be found');

  log.resize(12);
  await show('the log pane dragged down to its minimum of 12');

  await term.press(KEYS.right);
  await show('Right on the collapsed edge: the sidebar opens, to the size it had');

  input.stop();
}
