import { confirm, multiselect, PromptError, select, text } from '@ttylabs/sigil/components';
import { createTestTerminal, KEYS } from '@ttylabs/sigil/testing';

/**
 * Accessible mode: the prompts as plain lines in and lines out, for a screen reader.
 *
 *   node demos/components/46-accessible.js
 *   SIGIL_ACCESSIBLE=1 node demos/components/46-accessible.js   <- the same, from the variable
 *   node demos/components/46-accessible.js | cat                <- a scripted run, no terminal needed
 *
 * Nothing is redrawn. Each question is written once, what you type is echoed
 * where you type it, and the answer moves the transcript on a line -- which is
 * what a screen reader can follow and a region that repaints is not. `select()`
 * is a numbered list and a number, and `multiselect()` is the same list and
 * numbers separated by commas, with ranges.
 *
 * This demo passes `accessible: true` so that it shows the line forms either
 * way; an app leaves the option out and lets `SIGIL_ACCESSIBLE` decide.
 *
 * Piped, there is nobody to type, so the questions are answered by a scripted
 * keyboard (`createTestTerminal()`) and the transcript is printed at the end.
 */

/** The questions, asked against whatever terminal is handed in. */
async function ask(terminal) {
  const name = await text({
    accessible: true,
    default: 'my-app',
    message: 'Project name',
    terminal,
    validate: (value) => (/^[a-z][a-z0-9-]*$/.test(value) ? undefined : 'Lower case and dashes'),
  });
  const kind = await select({
    accessible: true,
    choices: [
      { hint: 'one command', label: 'Single', value: 'single' },
      { hint: 'a commands directory', label: 'Multi', value: 'multi' },
      { disabled: 'not yet', label: 'Plugin host', value: 'plugins' },
    ],
    message: 'Layout',
    terminal,
  });
  const extras = await multiselect({
    accessible: true,
    choices: ['TypeScript', 'Tests', 'Lint', 'CI', 'Docs'],
    message: 'Extras',
    terminal,
  });
  const ok = await confirm({ accessible: true, message: 'Create it?', terminal });
  return { extras, kind, name, ok };
}

async function interactive() {
  try {
    console.log(await ask(undefined));
  } catch (err) {
    if (err instanceof PromptError) {
      console.error(err.aborted ? 'Cancelled.' : err.message);
      process.exitCode = 1;
    } else {
      throw err;
    }
  }
}

async function scripted() {
  const ui = createTestTerminal({ columns: 80, rows: 24 });
  const answers = ask(ui.terminal);
  // a prompt that rejects while keys are still going in is an unhandled rejection
  answers.catch(() => {});

  await ui.press();
  // a name the validator refuses, then one it takes
  await ui.press('My App', KEYS.enter);
  await ui.press(KEYS.backspace, KEYS.backspace, KEYS.backspace, KEYS.backspace);
  await ui.press(KEYS.backspace, KEYS.backspace, 'demo', KEYS.enter);
  await ui.press('2', KEYS.enter);
  await ui.press('1-2, 5', KEYS.enter);
  await ui.press(KEYS.enter);

  const result = await answers;
  console.log(ui.lines.join('\n'));
  console.log();
  console.log(JSON.stringify(result));
}

if (process.stdin.isTTY && process.stdout.isTTY) {
  await interactive();
} else {
  await scripted();
}
