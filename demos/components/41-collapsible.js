/**
 * A collapsible: a section with a title that opens and closes what is under it.
 *
 *   node demos/components/41-collapsible.js      <- Tab, enter/space, arrows, click, q
 *   node demos/components/41-collapsible.js | cat
 *
 * A failed deploy with its stack folded away under "Show stack", and an
 * accordion of three questions under it, where opening one closes the one that
 * was open. The title is what Tab stops on, and the body of a closed section is
 * not in the ring at all -- so Tab walks the titles, and the field inside "Where
 * do logs go?" joins the walk only while that section is open.
 *
 * Enter and Space flip the focused title, Right opens it and Left closes it, and
 * a left click on a title flips it. Opening and closing is instant: there is no
 * height animation, and the components entry in AGENTS.md says why.
 *
 * The footer is `keyHelp()` over `describeCollapsible()`, so it lists the
 * section's keys only while a title holds the focus.
 *
 * Piped, there is nobody to type, so the same tree is driven by a scripted
 * keyboard and printed after each step.
 */
import { createInlineCanvas } from '@ttylabs/sigil/canvas';
import {
  Collapsible,
  collapsibleGroup,
  describeCollapsible,
  keyHelp,
} from '@ttylabs/sigil/components';
import { box, renderToString, text } from '@ttylabs/sigil/element';
import { createInput, isAbort } from '@ttylabs/sigil/input';
import { render } from '@ttylabs/sigil/renderer';
import { createTestTerminal, KEYS } from '@ttylabs/sigil/testing';
import { themedCascade } from '@ttylabs/sigil/theme';

const live = process.stdin.isTTY && process.stdout.isTTY;

/** The sections, and the tree they sit in. */
function scene() {
  const stack = Collapsible({
    children: () =>
      box(
        { 'flex-direction': 'column' },
        text('Error: connect ECONNREFUSED 10.0.0.4:5432'),
        // numbered frames rather than node's `at` lines, which the demo runner
        // reads as a stack that escaped -- correctly, in every other demo
        text('#0 connect (db.js:41:11)'),
        text('#1 migrate (deploy.js:88:5)'),
        text('#2 main (cli.js:12:3)')
      ),
    title: 'Show stack',
  });

  const faq = collapsibleGroup();
  const questions = [
    Collapsible({
      children: () => text('Run it again with --verbose to see each step.'),
      group: faq,
      open: true,
      title: 'Why did it fail?',
    }),
    Collapsible({
      children: () =>
        box(
          { 'flex-direction': 'column' },
          text('To the directory below, which is focusable:'),
          text('~/.cache/deploy/logs', { class: 'field', focusable: true })
        ),
      group: faq,
      title: 'Where do logs go?',
    }),
    Collapsible({
      children: () => text('deploy rollback, which restores the previous release.'),
      group: faq,
      title: 'How do I roll back?',
    }),
  ];

  const root = box(
    { 'flex-direction': 'column', width: 56 },
    text('✖ Deploy failed', { class: 'sigil-error' }),
    stack,
    text(''),
    text('Questions', { class: 'sigil-heading' }),
    ...questions
  );

  return { root, sections: [stack, ...questions] };
}

const sheet = '.field:focus { inverse: true }';

if (live) {
  const ui = scene();
  const canvas = createInlineCanvas({ height: 18 });
  /** The footer, appended once the router it reads exists. */
  const footer = box({ 'margin-top': 1 });
  const view = render(() => box({ 'flex-direction': 'column' }, ui.root, footer), {
    backend: canvas,
    cascade: themedCascade({ sheets: [sheet] }),
    height: 18,
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
  describeCollapsible(input, ...ui.sections);
  footer.append(keyHelp(input, { width: 56 }));
  input.focus.next();
} else {
  const term = createTestTerminal({ columns: 56 });
  const ui = scene();
  const input = createInput({ root: ui.root, terminal: term.terminal });
  describeCollapsible(input, ...ui.sections);
  const footer = keyHelp(input, { width: 56 });
  const cascade = themedCascade({ sheets: [sheet] });

  /** What a focused element says: a title's label, or the element's own text. */
  const nameOf = (element) =>
    element.classes.includes('sigil-collapsible-title') ? element.children[1].text : element.text;

  // an effect runs on the microtask after the write that wakes it
  const settle = () => new Promise((resolve) => setImmediate(resolve));

  /** Prints the tree and the footer under a heading. */
  const show = async (label) => {
    await settle();
    const body = renderToString(ui.root, { cascade, colorLevel: 0, width: 56 });
    const keys = renderToString(footer, { cascade, colorLevel: 0, width: 56 }).trimEnd();
    // the focus is an inverted title on a terminal, and inverse is an attribute
    // a pipe drops -- so it is said in words here
    const at = input.focus.current.get();
    const focused = at === undefined ? 'nothing' : JSON.stringify(nameOf(at));
    console.log(`-- ${label}\n${body}\nfocus: ${focused}\nkeys:  ${keys || '(none listed)'}\n`);
  };

  await show('as built: the stack closed, the first question open');

  await term.press(KEYS.tab);
  await show('Tab: the focus is on "Show stack", and the footer lists its keys');

  await term.press(KEYS.enter);
  await show('Enter: the stack opens');

  await term.press(KEYS.left);
  await term.press(KEYS.tab, KEYS.tab);
  await show('Left closes it; two Tabs reach "Where do logs go?", past the open answer');

  await term.press(KEYS.right);
  await show('Right: it opens, and "Why did it fail?" closes, because they share a group');

  await term.press(KEYS.tab);
  await show('Tab: the field inside the open answer is in the ring now');

  input.stop();
}
