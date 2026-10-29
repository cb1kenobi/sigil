import { groupMultiselect, PromptError } from '@ttylabs/sigil/components';
import { createTestTerminal, KEYS, tick } from '@ttylabs/sigil/testing';
/**
 * A multiselect with its choices under named groups.
 *
 *   node demos/components/40-group-multiselect.js
 *   node demos/components/40-group-multiselect.js | cat    <- a scripted run
 *
 * Space on a group ticks everything under it, or clears it if it is all ticked
 * already; its box is `◯` for none, `◐` for some and `◉` for all, and follows the
 * choices as you tick them by hand. The answer is the flat list of values, in
 * the order they are listed.
 *
 * Piped there is nobody to type, so the same prompts are driven by a scripted
 * keyboard and the screen is printed after each step -- which is
 * `createTestTerminal()`, and how a prompt in an app gets a test.
 */

const features = {
  Frontend: ['React', 'Vue', { label: 'Svelte', selected: true }],
  Backend: ['Express', 'Fastify', { disabled: 'needs a licence', label: 'Spring' }],
  Tooling: [
    { description: 'Runs on every push.', label: 'CI' },
    { label: 'Linting', hint: 'oxlint' },
  ],
};

/**
 * Presses keys one step at a time and shows the screen after each.
 *
 * @param ui - The fake terminal.
 * @param steps - A caption, then the keys to press before looking.
 */
async function drive(ui, steps) {
  await tick();
  for (const [caption, ...keys] of steps) {
    await ui.press(...keys);
    console.log(`-- ${caption}`);
    for (const line of ui.lines.filter((l) => l.trim() !== '')) {
      console.log(`   ${line}`);
    }
    console.log();
  }
}

/**
 * Runs the prompts, against a terminal if there is one to read and against a
 * script if there is not.
 *
 * @param ui - A fake terminal, or nothing to use the real one.
 * @returns What was chosen.
 */
async function ask(ui) {
  const where = ui ? { terminal: ui.terminal } : {};

  const picked = groupMultiselect({
    ...where,
    choices: features,
    message: 'Features',
    required: true,
  });
  if (ui) {
    await drive(ui, [
      ['Opens on the first group; Svelte was `selected`, so Frontend is partial'],
      ['Space on Frontend: the rest are ticked', KEYS.space],
      ['Space again: all of them are cleared', KEYS.space],
      ['Down, Down, Space: React ticked by hand, Frontend partial', KEYS.down, KEYS.space],
      ['Down to Backend, Space: Spring is left alone', KEYS.down, KEYS.down, KEYS.down, KEYS.space],
      ['Enter', KEYS.enter],
    ]);
  }

  const tools = groupMultiselect({
    ...where,
    choices: features,
    message: 'Pick choices only',
    selectableGroups: false,
  });
  if (ui) {
    await drive(ui, [
      ['selectableGroups: false -- the headings are skipped, not ticked'],
      ['Space on the first choice, then Enter', KEYS.space, KEYS.enter],
    ]);
  }

  return { features: await picked, tools: await tools };
}

try {
  const interactive = process.stdin.isTTY && process.stdout.isTTY;
  const chosen = await ask(interactive ? undefined : createTestTerminal({ columns: 60, rows: 16 }));

  console.log(chosen);
} catch (err) {
  if (err instanceof PromptError) {
    console.error(err.aborted ? '\nCancelled.' : `\n${err.message}`);
    process.exitCode = 1;
  } else {
    throw err;
  }
}
