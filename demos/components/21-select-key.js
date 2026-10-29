/**
 * Choosing by pressing a key: `selectKey()`, with its numbered and expanded forms.
 *
 *   node demos/components/21-select-key.js
 *
 * In a terminal there are three questions. The first lists its choices and
 * answers the moment a key is pressed -- `o`, `s` or `d`, and capitals count. The
 * second numbers the choices it gave no key. The third shows only `(y/n/a/d/h)`
 * until `h` is pressed, and Enter takes the capital one.
 *
 * Piped, there is nobody to press anything, so the same prompts are played
 * against an in-process terminal from `@ttylabs/sigil/testing` and the screen is
 * printed after each key. The last run is the one that fails: two choices that
 * share a key are refused when the prompt is asked, not when one is pressed.
 */
import { PromptError, selectKey } from '@ttylabs/sigil/components';
import { createTestTerminal, KEYS } from '@ttylabs/sigil/testing';

const prompts = {
  action: {
    choices: [
      { key: 'o', label: 'Overwrite', value: 'overwrite' },
      { key: 's', label: 'Skip', value: 'skip' },
      { key: 'd', label: 'Show the diff', value: 'diff' },
    ],
    message: 'File exists',
  },
  colour: {
    choices: ['Red', 'Green', { key: 'q', label: 'None of these', value: null }, 'Blue'],
    message: 'Colour',
    numbered: true,
  },
  overwrite: {
    choices: [
      { key: 'y', label: 'Overwrite this file', value: 'yes' },
      { key: 'n', label: 'Keep this file', value: 'no' },
      { key: 'a', label: 'Overwrite this and every other', value: 'all' },
      { key: 'd', label: 'Show the diff', value: 'diff' },
    ],
    expand: true,
    initial: 'n',
    message: 'Overwrite',
  },
};

if (process.stdin.isTTY && process.stdout.isTTY) {
  try {
    const action = await selectKey(prompts.action);
    const colour = await selectKey(prompts.colour);
    const overwrite = await selectKey(prompts.overwrite);

    console.log('\n---');
    console.log({ action, colour, overwrite });
  } catch (err) {
    if (err instanceof PromptError) {
      console.error(err.aborted ? '\nCancelled.' : `\n${err.message}`);
      process.exitCode = 1;
    } else {
      throw err;
    }
  }
} else {
  /**
   * Plays keys against a prompt and prints the screen after each.
   *
   * @param title - What is being shown.
   * @param opts - The prompt's options.
   * @param steps - Keys, each a name or a character.
   * @returns The answer.
   */
  async function play(title, opts, steps) {
    console.log(`\n${title}`);
    const ui = createTestTerminal({ columns: 60 });
    const answer = selectKey({ ...opts, terminal: ui.terminal });
    answer.catch(() => {});

    await ui.press();
    console.log(`  (start)  ${ui.lines.join(' | ')}`);

    for (const step of steps) {
      await ui.press(KEYS[step] ?? step);
      console.log(`  ${step.padEnd(7)}  ${ui.lines.join(' | ')}`);
    }

    return answer;
  }

  const action = await play('One key answers, and a capital is the same key', prompts.action, [
    'x',
    'S',
  ]);

  const colour = await play('Numbered, with a key of its own beside the numbers', prompts.colour, [
    '4',
  ]);

  const overwrite = await play('Expanded: a line of keys, and the list on h', prompts.overwrite, [
    'h',
    'enter',
  ]);

  console.log('\nTwo choices that share a key:');
  try {
    await selectKey({
      choices: [
        { key: 's', label: 'Skip' },
        { key: 'S', label: 'Stop' },
      ],
      message: 'File exists',
      terminal: createTestTerminal({ columns: 60 }).terminal,
    });
  } catch (err) {
    if (!(err instanceof PromptError)) {
      throw err;
    }
    console.log(`  refused: ${err.message}`);
  }

  console.log('\n---');
  console.log({ action, colour, overwrite });
}
