import {
  badgeView,
  createLog,
  diff,
  groupMultiselect,
  markdown,
  multiselect,
  select,
  table,
  tasks,
} from '@ttylabs/sigil/components';
import { createTestTerminal, KEYS, tick } from '@ttylabs/sigil/testing';

/**
 * The prompts and components the home page draws, run for real.
 *
 * Run as a child by `home-capture.ts` with colour forced, because the prompts
 * decide their colour from the process they are in -- a terminal handed to
 * `createTestTerminal()` is not asked. It prints one JSON object on stdout:
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
  return createTestTerminal({ columns, rows: 30 });
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

// ---------------------------------------------------------------------------
// the component cards

{
  const columns = 56;
  const ui = terminal(columns);
  select({
    choices: ['cli', 'full-screen', 'prompts only'],
    message: 'Template',
    terminal: ui.terminal,
  }).catch(() => {});
  await tick();
  await ui.press(KEYS.down);
  screen('select', ui, columns);
}

scenes.table = {
  columns: 56,
  kind: 'text',
  output: table(
    [
      ['parser', badgeView('PASS', { variant: 'success' }), '412ms'],
      ['prompts', badgeView('PASS', { variant: 'success' }), '388ms'],
      ['renderer', badgeView('FAIL', { variant: 'error' }), '1.20s'],
    ],
    {
      columns: [{ header: 'suite' }, { header: 'status' }, { align: 'right', header: 'time' }],
    }
  ),
};

{
  const columns = 56;
  const ui = terminal(columns);
  const log = createLog({ terminal: ui.terminal });
  log.info('deployed', { host: 'a', ms: 412 });
  log.success('migrations applied');
  log.warn('cache is 3 days old');
  log.error('eu-west-1 timed out');
  screen('log', ui, columns);
}

{
  const columns = 56;
  const ui = terminal(columns);
  let release;
  const held = new Promise((resolve) => (release = resolve));
  const done = tasks(
    [
      { task: () => 'Resolved 12 packages', title: 'Install' },
      { task: () => 'Built 10 modules', title: 'Build' },
      { task: () => held, title: 'Upload assets' },
    ],
    // an hour a frame: the spinner is on its first and cannot move on while the
    // scene is being looked at, however loaded the machine running it is
    { interval: 3_600_000, terminal: ui.terminal }
  );
  await tick(10);
  screen('tasks', ui, columns);
  release();
  await done;
}

scenes.markdown = {
  columns: 56,
  kind: 'text',
  output: markdown(
    [
      '## Unreleased',
      '',
      '- Tooltips follow a scrolled anchor',
      '- `select()` takes an AbortSignal',
    ].join('\n'),
    { width: 56 }
  ),
};

scenes.diff = {
  columns: 56,
  kind: 'text',
  output: diff(
    { new: 'const retries = 5;\nrun(env);\n', old: 'const retries = 3;\nrun(env);\n' },
    { width: 56 }
  ),
};

process.stdout.write(JSON.stringify(scenes));
process.exit(0);
