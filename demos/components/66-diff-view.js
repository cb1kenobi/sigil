/**
 * A diff view: a patch in a pane that scrolls, with a cursor on its hunks, and
 * the hunk under the cursor written back as a patch of its own.
 *
 *   node demos/components/66-diff-view.js       <- ] and [, arrows, Space, q
 *   node demos/components/66-diff-view.js | cat
 *
 * One `DiffView` over blocks: a heading, a patch of two files, and a line about a
 * binary file that the cursor stops on as it does on a hunk. Three things to
 * watch:
 *
 * - **`]` and `[` move the cursor**, whose hunk is marked down the left with `▌`
 *   (`>` in ASCII) -- which is still there at colour level 0 -- and scrolled into
 *   view with the file header above it where that fits.
 * - **The cursor is a `State` the app holds**, and `diffStops()` over the same
 *   blocks says what is at it, so the app and the view count one way.
 * - **Space writes the hunk with `hunkPatch()`**: its file's header and the one
 *   hunk, which is what `git apply --cached` stages. The demo prints how long the
 *   patch is rather than applying it.
 *
 * The footer is `keyHelp()` over `describeDiffView()`.
 *
 * Piped, there is nobody to type, so a scripted keyboard drives the same view and
 * the demo prints it after each step.
 */
import { createInlineCanvas } from '@ttylabs/sigil/canvas';
import {
  describeDiffView,
  DiffView,
  diffStops,
  hunkPatch,
  keyHelp,
} from '@ttylabs/sigil/components';
import { box, renderToString, text } from '@ttylabs/sigil/element';
import { createInput, isAbort } from '@ttylabs/sigil/input';
import { render } from '@ttylabs/sigil/renderer';
import { State } from '@ttylabs/sigil/signals';
import { createTestTerminal, KEYS } from '@ttylabs/sigil/testing';
import { themedCascade } from '@ttylabs/sigil/theme';

const live = process.stdin.isTTY && process.stdout.isTTY;
const WIDTH = 60;
const ROWS = 12;

const PATCH = `diff --git a/src/retry.ts b/src/retry.ts
index 1111111..2222222 100644
--- a/src/retry.ts
+++ b/src/retry.ts
@@ -1,4 +1,4 @@
 export function retry(run) {
-  const attempts = 3;
+  const attempts = 5;
   for (let i = 0; i < attempts; i++) {
     try {
@@ -12,3 +12,3 @@
   }
-  throw new Error('gave up');
+  throw new Error(\`gave up after \${attempts} tries\`);
 }
diff --git a/README.md b/README.md
index 3333333..4444444 100644
--- a/README.md
+++ b/README.md
@@ -3,2 +3,3 @@
 Retries a call.
+It gives up after five tries.

`;

/** The view, and the line under it that says what Space wrote. */
function scene() {
  const blocks = [
    { class: 'sigil-heading', text: 'Unstaged' },
    { diff: { patch: PATCH } },
    { class: 'sigil-muted', data: 'logo.png', stop: true, text: 'logo.png: binary, not shown' },
  ];
  const current = new State(0);
  const status = text('', { class: 'sigil-muted', height: 1 });
  const view = DiffView({ content: blocks, current, props: { height: ROWS } });

  /** What Space does: writes the hunk under the cursor, as `git add -p` would apply it. */
  const stage = () => {
    const stop = diffStops(blocks)[current.get()];
    if (stop?.hunk && stop.file) {
      const patch = hunkPatch(stop.file, stop.hunk);
      status.setText(`hunkPatch(): ${patch.split('\n').length - 1} lines for git apply --cached`);
    } else if (stop) {
      status.setText(`${stop.block.data} has no hunk: an app stages it whole`);
    }
  };
  // Space is the app's, on a box around the view, which a key the view leaves alone reaches
  const root = box({ 'flex-direction': 'column', width: WIDTH }, view, status);
  root.onKey = (event) => {
    if (event.key.name === 'space') {
      stage();
      event.stop();
    }
  };
  return { current, root, view };
}

if (live) {
  const ui = scene();
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
  input.bind((event) => {
    if (isAbort(event.key)) {
      event.stop();
      quit();
    }
  });
  input.describe('space', { description: 'write hunk', priority: 3, scope: ui.root });
  describeDiffView(input, ui.view);
  footer.append(keyHelp(input, { width: 80 }));
  input.focus.focus(ui.view);
} else {
  const term = createTestTerminal({ columns: WIDTH });
  const ui = scene();
  const input = createInput({ root: ui.root, terminal: term.terminal });
  describeDiffView(input, ui.view);
  const footer = keyHelp(input, { width: 80 });
  const cascade = themedCascade();

  /** Prints the view and the footer under a heading. */
  const show = async (label) => {
    await new Promise((resolve) => setImmediate(resolve));
    const body = renderToString(ui.root, { cascade, colorLevel: 0, width: WIDTH }).trimEnd();
    const keys = renderToString(footer, { cascade, colorLevel: 0, width: 80 }).trimEnd();
    console.log(`-- ${label}\n${body}\ncursor on stop ${ui.current.get()}\nkeys:  ${keys}\n`);
  };

  input.focus.focus(ui.view);
  await show('as built: the cursor on the first hunk');

  await term.press(']');
  await show(']: the second hunk, scrolled into view');

  await term.press(KEYS.space);
  await show('Space: the hunk written back as a patch of its own');

  await term.press(']', ']');
  await show(']: the README hunk, then the binary file, which is a stop of its own');

  await term.press(KEYS.space);
  await show('Space on a stop with no hunk');

  ui.current.set(0);
  await show('the app writes the cursor: back to the first hunk, and the file header with it');

  input.stop();
}
