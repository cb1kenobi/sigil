/**
 * Tabs: a row of labels with one active, and the panel that follows it.
 *
 *   node demos/components/48-tabs.js     <- Tab, arrows, 1-6, Home/End, click, q
 *   node demos/components/48-tabs.js | cat
 *
 * Six tabs in 40 columns, which is two more than fit: the row scrolls to keep the
 * active tab in view and shows `‹` or `›` on the side that is clipped. Tab puts the
 * focus on the row; Left and Right move to the previous and next tab, Home and End
 * to the first and last, `1` to `6` to that tab, and a left click on a label picks
 * it. Only the active panel is laid out, so Tab walks the row and then the field
 * in the "Settings" panel -- and only while that panel is the one showing.
 *
 * The footer is `keyHelp()` over `describeTabs()`, so it lists the row's keys only
 * while the row holds the focus.
 *
 * Piped, there is nobody to type, so the same tree is driven by a scripted
 * keyboard and printed after each step.
 */
import { createInlineCanvas } from '@ttylabs/sigil/canvas';
import { describeTabs, keyHelp, Tabs } from '@ttylabs/sigil/components';
import { box, renderToString, text } from '@ttylabs/sigil/element';
import { createInput, isAbort } from '@ttylabs/sigil/input';
import { render } from '@ttylabs/sigil/renderer';
import { createTestTerminal, KEYS } from '@ttylabs/sigil/testing';
import { themedCascade } from '@ttylabs/sigil/theme';

const live = process.stdin.isTTY && process.stdout.isTTY;
const WIDTH = 40;

/** The tabs, and the tree they sit in. */
function scene() {
  const panel =
    (...lines) =>
    () =>
      box({ 'flex-direction': 'column' }, ...lines.map((line) => text(line)));

  const tabs = Tabs({
    props: { width: WIDTH },
    tabs: [
      {
        children: panel('3 services up, 1 degraded.', 'Last deploy 4 minutes ago.'),
        label: 'Overview',
      },
      {
        children: panel('12:01 deploy started', '12:04 migrations ran', '12:05 deploy finished'),
        label: 'Logs',
      },
      {
        children: () =>
          box(
            { 'flex-direction': 'column' },
            text('Verbose output:'),
            text('[x] on', { class: 'field', focusable: true })
          ),
        label: 'Settings',
      },
      { children: panel('eu-west  41 ms', 'us-east  12 ms'), label: 'Network' },
      { children: panel('p50  38 ms', 'p99  210 ms'), label: 'Metrics' },
      { children: panel('Everything is shipped.'), label: 'Summary' },
    ],
  });

  return { root: box({ 'flex-direction': 'column', width: WIDTH }, tabs), tabs };
}

const sheet = '.field:focus { inverse: true }';

if (live) {
  const ui = scene();
  const canvas = createInlineCanvas({ height: 10 });
  /** The footer, appended once the router it reads exists. */
  const footer = box({ 'margin-top': 1 });
  const view = render(() => box({ 'flex-direction': 'column' }, ui.root, footer), {
    backend: canvas,
    cascade: themedCascade({ sheets: [sheet] }),
    height: 10,
    width: 'auto',
  });
  const input = createInput({ mouse: { surface: canvas }, root: view.root });

  const quit = () => {
    view.dispose();
    input.stop();
  };
  input.bind('q', quit, { description: 'quit', priority: 9 });
  input.bind((event) => {
    if (isAbort(event.key)) {
      event.stop();
      quit();
    }
  });
  // Tab is the router's own default, so it is described rather than bound
  input.describe('tab', { description: 'next', priority: 8 });
  describeTabs(input, ui.tabs);
  footer.append(keyHelp(input, { width: 64 }));
  input.focus.next();
} else {
  const term = createTestTerminal({ columns: WIDTH });
  const ui = scene();
  const input = createInput({ root: ui.root, terminal: term.terminal });
  describeTabs(input, ui.tabs);
  const footer = keyHelp(input, { width: 64 });
  const cascade = themedCascade({ sheets: [sheet] });

  // an effect runs on the microtask after the write that wakes it
  const settle = () => new Promise((resolve) => setImmediate(resolve));

  /** Prints the tree and the footer under a heading. */
  const show = async (label) => {
    await settle();
    const body = renderToString(ui.root, { cascade, colorLevel: 0, width: WIDTH });
    const keys = renderToString(footer, { cascade, colorLevel: 0, width: 64 }).trimEnd();
    // the focus is an inverted label on a terminal, and inverse is an attribute a
    // pipe drops -- so it is said in words here
    const at = input.focus.current.get();
    const focused =
      at === undefined
        ? 'nothing'
        : at.classes.includes('sigil-tabs-row')
          ? 'the tab row'
          : JSON.stringify(at.text);
    console.log(`-- ${label}\n${body}\nfocus: ${focused}\nkeys:  ${keys || '(none listed)'}\n`);
  };

  await show('as built: six tabs in 40 columns, the first showing');

  await term.press(KEYS.tab);
  await show('Tab: the focus is on the row, and the footer lists its keys');

  await term.press(KEYS.right, KEYS.right, KEYS.right);
  await show('Right three times: the row scrolls to keep "Network" in view');

  await term.press(KEYS.end);
  await show('End: the last tab, with the clipped side on the left');

  await term.press('3');
  await show('3: "Settings", and its field is in the focus ring now');

  await term.press(KEYS.tab);
  await show('Tab: the field inside the showing panel');

  await term.press(KEYS.tab);
  await term.press(KEYS.home);
  await show('Tab wraps to the row; Home goes to the first tab');

  input.stop();
}
