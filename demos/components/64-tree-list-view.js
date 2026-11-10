/**
 * A tree list view: a directory read a level at a time, beside a branch that is
 * slow and one that fails.
 *
 *   node demos/components/64-tree-list-view.js [dir]   <- Tab, arrows, Right/Left, Space, Enter, r, q
 *   node demos/components/64-tree-list-view.js | cat
 *
 * One `TreeListView` over two kinds of branch. The first is a directory, from
 * `directoryRoot()` -- the same root node `directoryTree()` asks over, so the
 * element and the prompt offer the same entries -- and every directory under it
 * is read the first time it opens. The second is a pretend registry whose
 * branches are read over a network that is slow, and the first time, down.
 *
 * Four things to watch:
 *
 * - **Right opens and Left closes.** Right on a closed branch opens it and on an
 *   open one steps onto its first child; Left closes an open branch and on
 *   anything else steps to the parent. Space opens and closes, Enter opens a file,
 *   and a click on a twisty opens or closes without moving the cursor.
 * - **A branch reads when it first opens**, with a `Loading…` line under it while
 *   the read runs. What the read found is kept: closing and opening again is
 *   instant. `r` forgets it and reads again.
 * - **A read that fails says why under the branch**, and the branch stays open
 *   so the message has somewhere to be. Right reads it again, and so does closing
 *   and opening it.
 * - **The cursor goes to the branch that closed over it**, not to whatever row
 *   took its place -- whether the branch was closed by Left, by a click, or by the
 *   app writing the open set, which `c` does here: it closes everything.
 *
 * The footer is `keyHelp()` over `describeTreeListView()`.
 *
 * Piped, there is nobody to type, so a scripted keyboard drives the same tree over
 * a small directory the demo makes and removes, and the demo prints it after each
 * step.
 */
import { createInlineCanvas } from '@ttylabs/sigil/canvas';
import {
  describeTreeListView,
  directoryRoot,
  keyHelp,
  treeListControl,
  TreeListView,
} from '@ttylabs/sigil/components';
import { box, renderToString, text } from '@ttylabs/sigil/element';
import { createInput, isAbort } from '@ttylabs/sigil/input';
import { render } from '@ttylabs/sigil/renderer';
import { State } from '@ttylabs/sigil/signals';
import { createTestTerminal, KEYS } from '@ttylabs/sigil/testing';
import { themedCascade } from '@ttylabs/sigil/theme';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';

const live = process.stdin.isTTY && process.stdout.isTTY;
const WIDTH = 52;
const ROWS = 14;

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * A registry over a network: each package's versions are a read that takes a
 * while, and the first read of all is refused, so the failure and the retry can
 * both be seen.
 */
function registry(delay) {
  let down = true;
  const versions = (name, list) => async () => {
    await wait(delay);
    if (down) {
      down = false;
      throw new Error('connection refused');
    }
    return list.map((v) => ({ text: v, value: `${name}@${v}` }));
  };
  return {
    items: [
      {
        items: versions('left-pad', ['1.3.0', '1.2.0', '1.1.3']),
        text: 'left-pad',
        value: 'left-pad',
      },
      { items: versions('is-even', ['1.0.0', '0.1.2']), text: 'is-even', value: 'is-even' },
    ],
    text: 'registry',
    value: 'registry',
  };
}

/** The tree, and the line under it that says what happened. */
function scene(root, delay) {
  const status = text('', { class: 'sigil-muted', height: 1 });
  const expanded = new State(new Set());

  const tree = TreeListView({
    expanded,
    items: [{ ...directoryRoot({ root }), text: live ? root : 'project/' }, registry(delay)],
    onActivate: (value, node) =>
      status.setText(
        node.items === undefined
          ? `opened ${value.startsWith(root) ? relative(root, value) : value}`
          : `${node.text} is a branch: Right opens it`
      ),
    props: { height: ROWS },
  });
  const control = treeListControl(tree);
  return {
    control,
    expanded,
    root: box({ 'flex-direction': 'column', width: WIDTH }, tree, status),
    status,
    tree,
  };
}

if (live) {
  const ui = scene(process.argv[2] ?? process.cwd(), 600);
  const canvas = createInlineCanvas({ height: ROWS + 4 });
  const footer = box({ 'margin-top': 1 });
  const view = render(() => box({ 'flex-direction': 'column' }, ui.root, footer), {
    backend: canvas,
    cascade: themedCascade(),
    height: ROWS + 4,
    width: 'auto',
  });
  const input = createInput({ mouse: { surface: canvas }, root: view.root });

  const quit = () => {
    view.dispose();
    input.stop();
  };
  input.fallback('q', quit, { description: 'quit', priority: 9 });
  input.fallback(
    'r',
    () => {
      const at = ui.control.current.get();
      if (at !== undefined && ui.control.reload(at)) {
        ui.status.setText(`reading ${at} again`);
      }
    },
    { description: 'reload', priority: 4 }
  );
  // the app writing the open set: the cursor goes to the top-level branch it
  // was under, which is the one that closed over it
  input.fallback('c', () => ui.expanded.set(new Set()), { description: 'close all', priority: 4 });
  input.bind((event) => {
    if (isAbort(event.key)) {
      event.stop();
      quit();
    }
  });
  describeTreeListView(input, ui.tree);
  footer.append(keyHelp(input, { width: 80 }));
  input.focus.focus(ui.tree);
} else {
  const dir = mkdtempSync(join(tmpdir(), 'sigil-demo-tree-'));
  try {
    mkdirSync(join(dir, 'src', 'lib'), { recursive: true });
    for (const file of [
      'README.md',
      'package.json',
      'src/index.js',
      'src/lib/a.js',
      'src/lib/b.js',
    ]) {
      writeFileSync(join(dir, file), '');
    }

    const term = createTestTerminal({ columns: WIDTH });
    const ui = scene(dir, 20);
    const input = createInput({ root: ui.root, terminal: term.terminal });
    describeTreeListView(input, ui.tree);
    const footer = keyHelp(input, { width: 80 });
    const cascade = themedCascade();

    /** Lets the effects run, and a read that is due land. */
    const settle = async (ms = 0) => {
      await wait(ms);
      await new Promise((resolve) => setImmediate(resolve));
    };
    /** The cursor, as a reader would name it. */
    const where = () => {
      const at = ui.control.current.get();
      return typeof at === 'string' && at.startsWith(dir) ? relative(dir, at) || 'project/' : at;
    };
    /** Prints the tree and the footer under a heading. */
    const show = async (label, ms = 0) => {
      await settle(ms);
      const body = renderToString(ui.root, { cascade, colorLevel: 0, width: WIDTH }).trimEnd();
      const keys = renderToString(footer, { cascade, colorLevel: 0, width: 80 }).trimEnd();
      console.log(`-- ${label}\n${body}\ncursor on ${where()}\nkeys:  ${keys}\n`);
    };

    input.focus.focus(ui.tree);
    // a directory is read on the disk's time rather than a timer's
    await show('as built: the directory is open, and read as it opens', 50);

    await term.press(KEYS.down, KEYS.right);
    await show('Down, Right: src/ opens, read the first time', 50);

    await term.press(KEYS.right, KEYS.right);
    await show('Right, Right: onto lib/, the first child, and open it', 50);

    await term.press(KEYS.down, KEYS.down, KEYS.enter);
    await show('Down, Down, Enter: a file opened');

    ui.control.collapse(join(dir, 'src'));
    await show('the app closes src/: the cursor goes to src/, not to the row after it');

    await term.press(KEYS.end, KEYS.left, KEYS.left, KEYS.down, KEYS.right);
    await show('End, Left, Left, Down, Right: the registry opens, and a package is read');

    await term.press(KEYS.down, KEYS.right);
    await show('Down, Right: left-pad is read, slowly');
    await show('...and the network was down: it says why, and stays open', 60);

    await term.press(KEYS.right);
    await show('Right: read again', 60);

    await term.press(KEYS.down, KEYS.down, KEYS.down, KEYS.down, KEYS.right, KEYS.left);
    await show('down to is-even, Right and straight back Left: closed while it reads');
    await settle(60);
    await term.press(KEYS.right);
    await show('Right, once the read has landed: what it found was kept, so it opens at once');

    input.stop();
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
}
