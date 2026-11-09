import { ansi } from '@ttylabs/sigil/ansi';
import { groupMultiselect, multiselect, select } from '@ttylabs/sigil/components';
import { createTestTerminal, KEYS, tick } from '@ttylabs/sigil/testing';

/**
 * The prompts the home page's hero and accessible-mode sections draw, run for
 * real. The component cards are not here: they are each component's own
 * example, captured by `component-capture.ts` for the components index.
 *
 * Run as a child by `home-capture.ts` with colour forced, and the level the
 * process came to is the one each scene's terminal is built at: the colour level
 * is the terminal's, so a test terminal left at its default of 0 draws no colour
 * whatever the process says, and these screens are captured to show it. It prints one JSON object on stdout:
 * `{ [scene]: { columns, kind, output } }`, where a `screen` is the bytes a
 * prompt wrote, to be replayed into a screen, and a `text` is a string a
 * component returned.
 *
 * A prompt scene is the repository's own way of driving one: the keys go in
 * through `press()`, one read each, and the answer is never given, so the
 * screen is a prompt part of the way through being answered -- which is what a
 * reader is looking at when it is asking them something.
 */

const scenes = {};

/** The terminal a scene draws on. Taller than any scene, because a screen that scrolls is refused. */
function terminal(columns) {
  return createTestTerminal({ colorLevel: ansi.level, columns, rows: 30 });
}

/** Records what a prompt scene left on the screen. */
function screen(id, ui, columns) {
  scenes[id] = { columns, kind: 'screen', output: ui.output };
}

// ---------------------------------------------------------------------------
// the hero: two prompts answered, and a third part of the way through

{
  const columns = 64;
  const ui = terminal(columns);
  const layout = select({
    choices: [
      { label: 'Single', value: 'single' },
      { label: 'Multi', value: 'multi' },
    ],
    message: 'Layout',
    terminal: ui.terminal,
  });
  await tick();
  await ui.press(KEYS.down, KEYS.enter);
  await layout;

  groupMultiselect({
    choices: {
      Frontend: ['React', 'Vue', { label: 'Svelte', selected: true }],
      Backend: ['Express', 'Fastify', { disabled: 'needs a licence', label: 'Spring' }],
      Tooling: [{ label: 'CI' }, { hint: 'oxlint', label: 'Linting' }],
    },
    message: 'Features',
    terminal: ui.terminal,
  }).catch(() => {});
  await tick();
  // the whole of Frontend, then Svelte given back: the group reads as partly ticked
  await ui.press(KEYS.space, KEYS.down, KEYS.down, KEYS.down, KEYS.space);
  await ui.press(KEYS.down, KEYS.down, KEYS.down, KEYS.space);
  screen('hero', ui, columns);
}

// ---------------------------------------------------------------------------
// accessible mode: the same prompt, drawn and then as lines

const FRUIT = ['Prompts', 'Tables', 'Spinners', 'Markdown', 'Charts'];

{
  const columns = 72;
  const ui = terminal(columns);
  multiselect({ choices: FRUIT, message: 'Components', terminal: ui.terminal }).catch(() => {});
  await tick();
  await ui.press(KEYS.space, KEYS.down, KEYS.down, KEYS.space);
  screen('rendered', ui, columns);
}

{
  const columns = 72;
  const ui = terminal(columns);
  const asked = multiselect({
    accessible: true,
    choices: FRUIT,
    message: 'Components',
    terminal: ui.terminal,
  });
  await tick();
  await ui.press('1, 3', KEYS.enter);
  await asked;
  screen('accessible', ui, columns);
}

process.stdout.write(JSON.stringify(scenes));
process.exit(0);
