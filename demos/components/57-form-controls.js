/**
 * Form controls: a button, a checkbox, a radio set and a switch, as a settings form.
 *
 *   node demos/components/57-form-controls.js     <- Tab, Space, arrows, Enter, click, q
 *   node demos/components/57-form-controls.js | cat
 *
 * A settings screen: two checkboxes, a switch, a radio set of log levels with one
 * level disabled, and Save and Revert buttons that stay disabled until something
 * has changed. Tab walks the controls -- the radio set is one stop, and the arrows
 * move inside it -- and skips a disabled button. Space ticks a checkbox, flips the
 * switch and selects a level; Left and Right pick a state of the switch; a click
 * does what Space does. Enter is the form's everywhere but on a button: the form
 * has an Enter handler of its own that saves, so Enter in a checkbox saves, and
 * Enter on Revert reverts.
 *
 * The focus is drawn as content as well as in a role: the `❯` pointer in a column
 * every value control keeps blank, and a button's brackets in its padding -- so it
 * reads in a pipe, where colour and inverse are gone. The footer is `keyHelp()`
 * over the four `describe*()` helpers, so it lists only the focused control's keys.
 *
 * Piped, there is nobody to type, so the same tree is driven by a scripted
 * keyboard and printed after each step.
 */
import { createInlineCanvas } from '@ttylabs/sigil/canvas';
import {
  Button,
  Checkbox,
  describeButton,
  describeCheckbox,
  describeRadioSet,
  describeSwitch,
  keyHelp,
  RadioSet,
  Switch,
} from '@ttylabs/sigil/components';
import { box, renderToString, text } from '@ttylabs/sigil/element';
import { createInput, isAbort } from '@ttylabs/sigil/input';
import { createEffect, render } from '@ttylabs/sigil/renderer';
import { State } from '@ttylabs/sigil/signals';
import { createTestTerminal, KEYS } from '@ttylabs/sigil/testing';
import { themedCascade } from '@ttylabs/sigil/theme';

const live = process.stdin.isTTY && process.stdout.isTTY;
const WIDTH = 48;

/** What is saved, and what the form is editing. */
const SAVED = { digest: true, dark: false, level: 'info', telemetry: false };

/** The form, its values, and the controls in it. */
function scene() {
  const values = {
    dark: new State(SAVED.dark),
    digest: new State(SAVED.digest),
    level: new State(SAVED.level),
    telemetry: new State(SAVED.telemetry),
  };
  /** Whether the form differs from what was saved, which is what enables the buttons. */
  const clean = new State(true);
  const status = text('', { class: 'sigil-muted', height: 1 });

  const save = () => {
    for (const [key, state] of Object.entries(values)) {
      SAVED[key] = state.get();
    }
    const on = (flag) => (flag ? 'on' : 'off');
    status.setText(
      `saved: digest ${on(SAVED.digest)}, usage ${on(SAVED.telemetry)}, ${SAVED.dark ? 'dark' : 'light'}, ${SAVED.level}`
    );
  };
  const revert = () => {
    for (const [key, state] of Object.entries(values)) {
      state.set(SAVED[key]);
    }
    status.setText('reverted');
  };

  const controls = {
    dark: Switch({ active: 'dark', inactive: 'light', label: 'Theme', value: values.dark }),
    digest: Checkbox({ checked: values.digest, label: 'Email me a weekly digest' }),
    level: RadioSet({
      direction: 'row',
      options: ['warn', 'info', 'debug', { disabled: 'debug builds', label: 'trace' }],
      value: values.level,
    }),
    revert: Button({ disabled: clean, label: 'Revert', onPress: revert }),
    save: Button({ disabled: clean, label: 'Save', onPress: save }),
    telemetry: Checkbox({ checked: values.telemetry, label: 'Send anonymous usage data' }),
  };

  createEffect(() => {
    clean.set(Object.entries(values).every(([key, state]) => state.get() === SAVED[key]));
  });

  const root = box(
    { 'flex-direction': 'column', width: WIDTH },
    text('Settings', { class: 'sigil-heading' }),
    controls.digest,
    controls.telemetry,
    controls.dark,
    text('Log level', { 'margin-top': 1 }),
    controls.level,
    box(
      { 'column-gap': 1, 'flex-direction': 'row', 'margin-top': 1 },
      controls.save,
      controls.revert
    ),
    status
  );
  // the form's own Enter: what no control claimed, which is every Enter but a
  // button's. A form decides what Enter means, and here it saves
  root.onKey = (event) => {
    if (event.key.name === 'enter' && !event.paste && !clean.get()) {
      event.stop();
      save();
    }
  };

  return { controls, root, status };
}

/** Describes every control's keys to the router. */
function describeAll(input, { controls }) {
  describeCheckbox(input, controls.digest, controls.telemetry);
  describeSwitch(input, controls.dark);
  describeRadioSet(input, controls.level);
  describeButton(input, controls.save, controls.revert);
}

if (live) {
  const ui = scene();
  const canvas = createInlineCanvas({ height: 14 });
  const footer = box({ 'margin-top': 1 });
  const view = render(() => box({ 'flex-direction': 'column' }, ui.root, footer), {
    backend: canvas,
    cascade: themedCascade(),
    height: 14,
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
  describeAll(input, ui);
  footer.append(keyHelp(input, { width: 64 }));
  input.focus.next();
} else {
  const term = createTestTerminal({ columns: WIDTH });
  const ui = scene();
  const input = createInput({ root: ui.root, terminal: term.terminal });
  describeAll(input, ui);
  const footer = keyHelp(input, { width: 64 });
  const cascade = themedCascade();

  // an effect runs on the microtask after the write that wakes it
  const settle = () => new Promise((resolve) => setImmediate(resolve));

  /** Prints the form and the footer under a heading. */
  const show = async (label) => {
    await settle();
    const body = renderToString(ui.root, { cascade, colorLevel: 0, width: WIDTH }).replace(
      /\s+$/gm,
      ''
    );
    const keys = renderToString(footer, { cascade, colorLevel: 0, width: 64 }).trimEnd();
    console.log(`-- ${label}\n${body}\nkeys: ${keys || '(none listed)'}\n`);
  };

  await show('as built: nothing focused, Save and Revert disabled');

  await term.press(KEYS.tab);
  await show('Tab: the first checkbox, with the pointer in the column it keeps');

  await term.press(KEYS.tab, KEYS.space);
  await show('Tab, Space: telemetry ticked, so Save and Revert are enabled');

  await term.press(KEYS.tab, KEYS.right);
  await show('Tab, Right: the switch goes to "dark"');

  await term.press(KEYS.tab, KEYS.right, KEYS.right);
  await show(
    'Tab, Right twice: the radio set is one stop; "trace" is disabled, so Right stops at "debug"'
  );

  await term.press(KEYS.tab);
  await show('Tab: Save, bracketed while it has the focus');

  await term.press(KEYS.tab, KEYS.enter);
  await show('Tab, Enter: Revert is a button, so Enter presses it -- and both go disabled again');

  await term.press(KEYS.tab);
  await show('Tab: the disabled buttons are skipped, and the focus wraps to the first checkbox');

  await term.press(KEYS.space, KEYS.enter);
  await show('Space, Enter: a checkbox leaves Enter to the form, whose own handler saves');

  input.stop();
}
