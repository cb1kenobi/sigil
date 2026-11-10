/**
 * A text area: several editable lines as an element, in a panel.
 *
 *   node demos/components/59-text-area.js      <- type; Shift-arrows select, Ctrl-Y copies, Ctrl-G, Esc
 *   node demos/components/59-text-area.js | cat
 *
 * A scratch editor: a `Panel` holding a `TextArea` with line numbers, a small
 * JavaScript highlighter of the demo's own, and Tab typing two spaces. Enter is a
 * newline and a paste keeps its line breaks. Shift with an arrow selects, and so
 * does a drag; Ctrl-Y copies the selection to the clipboard with OSC 52 and Ctrl-X
 * cuts it -- the area hands the text to `onCopy` and the app writes it, since an
 * element has no terminal of its own. The wheel scrolls without moving the caret.
 *
 * Ctrl-G swaps in fifty thousand lines. Only the lines on screen are laid out and
 * painted, so PageDown and Ctrl-End through it are as quick as through ten. Esc
 * quits: Escape is never the area's, so the app's binding has it.
 *
 * Piped, there is nobody to type, so a scripted keyboard drives the same tree and
 * the demo prints it after each step. A selection and the caret are reversed cells,
 * which a pipe drops, so what was selected is said in words -- by copying it -- and
 * the frames of the long buffer are timed against the short one's.
 */
import { runApp } from '@ttylabs/sigil/app';
import { Panel } from '@ttylabs/sigil/components/panel';
import { TextArea } from '@ttylabs/sigil/components/text-area';
import { box, renderToString, text } from '@ttylabs/sigil/element';
import { createInput } from '@ttylabs/sigil/input';
import { State } from '@ttylabs/sigil/signals';
import { copyToClipboard } from '@ttylabs/sigil/terminal';
import { createTestTerminal, ctrl, KEYS } from '@ttylabs/sigil/testing';
import { themedCascade } from '@ttylabs/sigil/theme';

const live = process.stdin.isTTY && process.stdout.isTTY;

const ESC = String.fromCharCode(0x1b);
const SHIFT_DOWN = `${ESC}[1;2B`;
const SHIFT_END = `${ESC}[1;2F`;
const CTRL_HOME = `${ESC}[1;5H`;
const CTRL_END = `${ESC}[1;5F`;

const SNIPPET = [
  '// a scratch buffer',
  'const greeting = "hello";',
  '',
  'function shout(word) {',
  '  return word.toUpperCase() + "!";',
  '}',
  '',
  'console.log(shout(greeting), 42);',
].join('\n');

/** Fifty thousand lines, which is what Ctrl-G puts in the area. */
const LONG = Array.from(
  { length: 50_000 },
  (_, i) => `const line${i + 1} = ${i + 1}; // and some more text to scroll past`
).join('\n');

const PATTERN = /(\/\/[^\n]*)|("[^"\n]*")|\b(const|function|return)\b|\b(\d+)\b/gu;

/**
 * The demo's own highlighter: comments, strings, three keywords and numbers.
 *
 * The framework carries no grammar, so the seam is the app's to fill -- this is a
 * pattern, and a real app hands over whatever highlighter it already has. Each span
 * names a token, which is a class, so the theme decides its colour.
 *
 * @param {string} value - The whole value.
 * @returns {{ start: number; end: number; token: string }[]} The spans.
 */
function highlight(value) {
  const spans = [];
  for (const m of value.matchAll(PATTERN)) {
    const token = m[1] ? 'comment' : m[2] ? 'string' : m[3] ? 'keyword' : 'number';
    spans.push({ end: m.index + m[0].length, start: m.index, token });
  }
  return spans;
}

/**
 * The editor, a status line, and the keys.
 *
 * @param {(text: string) => void} copy - Where a copy goes.
 */
function scene(copy) {
  const value = new State(SNIPPET);
  const status = text('', { class: 'sigil-muted', height: 1 });
  const area = TextArea({
    highlight,
    lineNumbers: true,
    onCopy: (selected) => {
      copy(selected);
      const lines = selected.split('\n').length;
      status.setText(
        `copied ${selected.length} characters over ${lines} line${lines === 1 ? '' : 's'}`
      );
    },
    props: { 'flex-grow': 1 },
    tab: '  ',
    value,
  });
  const root = box(
    { 'flex-direction': 'column', 'flex-grow': 1 },
    Panel({ annotation: 'TextArea', props: { 'min-height': 0 }, title: 'scratch.js' }, area),
    status,
    text('Shift-arrows select · Ctrl-Y copy · Ctrl-X cut · Ctrl-G long · Esc', {
      class: 'sigil-muted',
    })
  );
  return { area, root, status, value };
}

/**
 * Ctrl-G, the app's own binding: swaps the short buffer for the long one and back.
 *
 * @param {import('@ttylabs/sigil/input').InputRouter} input - The router.
 * @param {ReturnType<typeof scene>} ui - The editor.
 */
function wire(input, ui) {
  input.bind((event) => {
    if (event.key.ctrl && event.key.name === 'g') {
      event.stop();
      const long = ui.value.get() !== LONG;
      ui.value.set(long ? LONG : SNIPPET);
      ui.status.setText(long ? 'fifty thousand lines: PageDown, Ctrl-End' : 'the scratch buffer');
    }
  });
}

if (live) {
  // the app is what has a terminal, so the copy is written here: the area hands
  // over the text, and OSC 52 is one line
  let app;
  const ui = scene((selected) => copyToClipboard(app.terminal, selected));
  app = runApp(() => ui.root, { mouse: true });
  if (app.input) {
    wire(app.input, ui);
    app.input.bind((event) => {
      if (event.key.name === 'escape') {
        event.stop();
        app.exit(0);
      }
    });
    app.input.focus.focus(ui.area);
  }
  process.exitCode = await app.exited;
} else {
  const WIDTH = 72;
  const HEIGHT = 14;
  const copied = [];
  const term = createTestTerminal({ columns: WIDTH, rows: HEIGHT });
  const ui = scene((selected) => copied.push(selected));
  const root = box({ height: HEIGHT, width: WIDTH }, ui.root);
  const input = createInput({ root, terminal: term.terminal });
  wire(input, ui);
  input.focus.focus(ui.area);
  const cascade = themedCascade();

  const settle = () => new Promise((resolve) => setImmediate(resolve));
  const draw = () => renderToString(root, { cascade, colorLevel: 0, height: HEIGHT, width: WIDTH });
  const show = async (label) => {
    await settle();
    console.log(`-- ${label}\n${draw().replace(/\s+$/gm, '')}\n`);
  };

  await show('the scratch buffer, the caret at its end');

  await term.press(KEYS.enter, KEYS.tab, 'return shout("again");');
  await show('Enter, Tab and a line: Tab typed two spaces, since the area was given `tab`');

  await term.press(CTRL_HOME, KEYS.down, KEYS.down, KEYS.down, SHIFT_DOWN, SHIFT_DOWN, SHIFT_END);
  await term.press(ctrl('y'));
  await show('Ctrl-Home, Down x3, Shift-Down x2, Shift-End, Ctrl-Y: a function, copied');
  console.log(`what onCopy was handed:\n${copied.at(-1)}\n`);

  await term.press(ctrl('x'));
  await term.paste('function whisper(word) {\r\n  return word.toLowerCase();\r\n}');
  await show('Ctrl-X, then a paste in its place: the paste kept its line breaks');

  // the frames of a short buffer and a long one, a page at a time
  const time = async (keys) => {
    const started = performance.now();
    for (const key of keys) {
      await term.press(key);
      draw();
    }
    return (performance.now() - started) / keys.length;
  };
  const pages = Array.from({ length: 40 }, (_, i) => (i % 2 ? KEYS.pageUp : KEYS.pageDown));
  await term.press(CTRL_HOME);
  const short = await time(pages);

  await term.press(ctrl('g'), CTRL_HOME);
  await show('Ctrl-G: fifty thousand lines, and Ctrl-Home');
  const long = await time(pages);

  await term.press(CTRL_END);
  await show('Ctrl-End: the last of them, scrolled sideways to the caret, five digits of gutter');
  console.log(
    `a page and a frame: ${short.toFixed(2)}ms over the scratch buffer, ` +
      `${long.toFixed(2)}ms over fifty thousand lines\n`
  );

  input.stop();
}
