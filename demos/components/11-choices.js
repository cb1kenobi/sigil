/**
 * What a choice list can say: that a choice is not on offer and why, that a row
 * is a heading and not a choice, that a choice has more to say than its label,
 * and what it reads as once answered.
 *
 *   node demos/components/11-choices.js
 *   node demos/components/11-choices.js | cat      <- the same session, scripted
 *
 * On a terminal it is two prompts to answer. Piped there is nobody to answer
 * them, which `04-prompts.js` shows is a refusal -- so this one drives the same
 * two prompts with a fake keyboard instead and prints what the screen looked
 * like after each key. That is `createTestTerminal()`, and it is also how a
 * prompt in an app gets a test.
 *
 * Things to try by hand: the arrows skip the headings and the disabled rows
 * rather than landing on them; Home and End go to the first and last row that is
 * on offer; `a` ticks everything that can be ticked and `i` flips it; and Enter
 * with too few or too many ticked says how many it wanted.
 */
import { multiselect, PromptError, select, separator } from '@ttylabs/sigil/components';
import { createTestTerminal, KEYS, tick } from '@ttylabs/sigil/testing';

const targets = [
  separator('Cloud'),
  {
    description: 'The real one. Deploys are announced in #releases.',
    label: 'Production (us-east-1)',
    short: 'prod',
    value: 'prod',
  },
  { description: 'A copy of production with fake data.', label: 'Staging', value: 'staging' },
  separator('Local'),
  { disabled: 'Docker is not running', label: 'Docker', value: 'docker' },
  { label: 'This machine', value: 'local' },
  { disabled: true, label: 'Vagrant', value: 'vagrant' },
];

const checks = [
  { hint: 'tsc', label: 'Type check', selected: true },
  { description: 'Takes about a minute.', label: 'Unit tests' },
  { label: 'Lint' },
  { disabled: 'needs SCAN_TOKEN', label: 'Security scan' },
  { label: 'Benchmarks' },
];

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
    for (const line of ui.lines.slice(-9)) {
      console.log(`   ${line}`);
    }
    console.log();
  }
}

/**
 * Runs both prompts, against a terminal if there is one to read and against a
 * script if there is not.
 *
 * @param ui - A fake terminal, or nothing to use the real one.
 * @returns What was chosen.
 */
async function ask(ui) {
  const where = ui ? { terminal: ui.terminal } : {};

  const target = select({ ...where, choices: targets, message: 'Deploy to' });
  if (ui) {
    await drive(ui, [
      ['Opens past the heading, on the first choice on offer'],
      ['Down', KEYS.down],
      ['Down again: the heading and Docker are passed over', KEYS.down],
      ['Down once more: Vagrant is passed over, and the list wraps', KEYS.down],
      ['End: the last choice on offer, not the last row', KEYS.end],
      ['Home, then Enter: the answer leaves its short form', KEYS.home, KEYS.enter],
    ]);
  }

  const picked = multiselect({
    ...where,
    choices: checks,
    max: 3,
    message: 'Checks to run',
    min: 1,
  });
  if (ui) {
    await drive(ui, [
      ['Opens with what `selected` asked for'],
      ['a: everything that can be ticked. Security scan stays out', 'a'],
      ['Enter: four is one too many', KEYS.enter],
      ['i: flips each choice on offer', 'i'],
      ['Enter: none is one too few', KEYS.enter],
      [
        'Space, Down, Space: two ticked, and Unit tests says more',
        KEYS.space,
        KEYS.down,
        KEYS.space,
      ],
      ['Enter', KEYS.enter],
    ]);
  }

  return { checks: await picked, target: await target };
}

try {
  const interactive = process.stdin.isTTY && process.stdout.isTTY;
  const chosen = await ask(interactive ? undefined : createTestTerminal({ columns: 56, rows: 12 }));

  console.log(chosen);
} catch (err) {
  if (err instanceof PromptError) {
    console.error(err.aborted ? '\nCancelled.' : `\n${err.message}`);
    process.exitCode = 1;
  } else {
    throw err;
  }
}
