/**
 * Where a prompt puts its answer once it is answered: beside the question where
 * the whole answer fits on that line, and on a line of its own under the question
 * where it does not.
 *
 *   node demos/components/53-settled-answers.js
 *   node demos/components/53-settled-answers.js | cat      <- every prompt at two widths
 *
 * A settled prompt leaves one line behind: the question, and what was chosen. The
 * answer used to be drawn in whatever room the question left, which is all of it
 * for a short question and one column for a question as wide as the line -- so
 * `Show the diff` came out a letter per row down the right-hand edge, and a text
 * field was cut to its first letter. Now the answer goes beside the question only
 * when it fits there whole, and otherwise under it, indented to where the
 * question starts.
 *
 * Piped, each prompt is asked the same question at 60 columns and at 40, through
 * `createTestTerminal()`, and the screen it settles to is printed. `toggle()` is
 * the one that differs, and on purpose: it reserves room for its longer state
 * while it is being asked, so the question wraps instead and the answer stays
 * beside it.
 *
 * On a terminal it is the same four prompts at the terminal's own width. Make the
 * window narrow -- 40 columns or so -- and answer them to see the answers move
 * under the question. Either way it ends by printing the values the prompts
 * resolved with, since where an answer is drawn changes nothing about what it is.
 */
import { PromptError, select, sort, text, toggle } from '@ttylabs/sigil/components';
import { createTestTerminal, KEYS, tick } from '@ttylabs/sigil/testing';

const QUESTION = 'Which change should we apply first?';
const CHOICES = ['Show the diff', 'Apply', 'Skip'];

/** Each prompt, how to ask it, and the keys that answer it when nobody is typing. */
const prompts = [
  {
    ask: (where) => select({ ...where, choices: CHOICES, message: QUESTION }),
    key: 'select',
    keys: [KEYS.enter],
    name: 'select()',
  },
  {
    ask: (where) => sort({ ...where, choices: CHOICES, message: 'In what order?' }),
    key: 'sort',
    keys: [KEYS.enter],
    name: 'sort(), whose answer is the whole order',
  },
  {
    ask: (where) => text({ ...where, message: QUESTION }),
    key: 'text',
    keys: ['Show the diff', KEYS.enter],
    name: 'text(), which used to cut the answer rather than stack it',
  },
  {
    ask: (where) => toggle({ ...where, message: 'Send a notification for every change?' }),
    key: 'toggle',
    keys: [KEYS.enter],
    name: 'toggle(), which reserves its answer, so the question wraps instead',
  },
];

/**
 * Asks one prompt on a fake terminal of `columns` and prints what it settled to.
 *
 * @param prompt - The prompt and its keys.
 * @param columns - How wide the terminal is.
 * @returns What the prompt answered.
 */
async function settle(prompt, columns) {
  const ui = createTestTerminal({ columns, rows: 10 });
  const pending = prompt.ask({ terminal: ui.terminal });
  await tick();
  await ui.press(...prompt.keys);
  const answer = await pending;

  const rule = '-'.repeat(columns);
  console.log(`   ${rule} ${columns} columns`);
  for (const line of ui.lines) {
    if (line.trim() !== '') {
      console.log(`   ${line.trimEnd()}`);
    }
  }
  return answer;
}

try {
  // the values each prompt resolved with, which the width never changes
  const answers = {};
  if (process.stdin.isTTY && process.stdout.isTTY) {
    for (const prompt of prompts) {
      answers[prompt.key] = await prompt.ask({});
    }
  } else {
    for (const prompt of prompts) {
      console.log(`-- ${prompt.name}`);
      await settle(prompt, 60);
      answers[prompt.key] = await settle(prompt, 40);
      console.log();
    }
  }

  console.log(answers);
} catch (err) {
  if (err instanceof PromptError) {
    console.error(err.aborted ? '\nCancelled.' : `\n${err.message}`);
    process.exitCode = 1;
  } else {
    throw err;
  }
}
