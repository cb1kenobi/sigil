/**
 * Prompts run as one flow: `group()`, and the frame around it.
 *
 *   node demos/components/14-group.js           <- asks, in a terminal
 *   node demos/components/14-group.js | cat     <- drives the same flow with keys it sends itself
 *
 * `group()` runs named steps in order and hands each one what the steps before it
 * answered, so the third question below is worded with the first answer and the
 * choices of the second depend on it. `intro()`, `outro()` and `cancel()` write
 * the lines that make it read as one session -- to **stderr**, so
 * `node demos/components/14-group.js > answers.txt` still gets only the answers.
 *
 * A prompt rejects with a `PromptError` when it is cancelled, as it always has;
 * `isCancel()` is the question to ask of what a `catch` caught, and `onCancel`
 * is handed the answers collected before the person left.
 *
 * Piped there is nobody to ask, so the second half does what `04-prompts.js`
 * cannot: it builds a test terminal, sends the keys a person would have typed,
 * and prints the screen after each step. The first run answers everything, the
 * second presses Ctrl-C part of the way through.
 */
import {
  cancel,
  confirm,
  group,
  intro,
  isCancel,
  outro,
  select,
  text,
} from '@ttylabs/sigil/components';
import { createTestTerminal, ctrl, KEYS, tick } from '@ttylabs/sigil/testing';

/**
 * The flow, over whichever terminal it is handed.
 *
 * The same function runs in both halves of this file, which is the point of
 * handing `opts` to every call: nothing about a group knows what it is talking to.
 *
 * @param opts - The terminal and styler every call draws through.
 * @returns The answers.
 */
function ask(opts) {
  return group(
    {
      name: () => text({ ...opts, message: 'Project name', default: 'my-app' }),

      // the choices are a function of an earlier answer, which is a closure over
      // what the group handed this step
      template: ({ name }) =>
        select({
          ...opts,
          message: `Template for ${name}`,
          choices: name?.endsWith('-cli') ? ['cli', 'library'] : ['app', 'library'],
        }),

      ok: ({ name, template }) => confirm({ ...opts, message: `Create ${name} from ${template}?` }),
    },
    {
      onCancel: (partial) => {
        cancel('Nothing was created', opts);
        console.log('answered before leaving:', JSON.stringify(partial));
      },
    }
  );
}

/**
 * Runs the flow and reports how it ended, which is the `try` an app writes once.
 *
 * @param opts - The terminal and styler.
 * @returns The answers, or `undefined` when the person left.
 */
async function session(opts) {
  intro('create-app', opts);

  try {
    const answers = await ask(opts);
    outro(answers.ok ? `Created ${answers.name}` : 'Not created', opts);
    return answers;
  } catch (err) {
    // `onCancel` already said so; what is left is telling a person leaving from
    // a prompt that had nobody to ask, which is the program being wrong
    if (isCancel(err)) {
      return undefined;
    }
    throw err;
  }
}

if (process.stdin.isTTY && process.stdout.isTTY) {
  const answers = await session({});
  if (answers) {
    console.log(answers);
  } else {
    process.exitCode = 1;
  }
} else {
  /**
   * Types into a prompt and prints what the screen shows after it.
   *
   * @param ui - The test terminal.
   * @param label - What is being sent, for the reader of the transcript.
   * @param keys - The reads to send.
   */
  async function type(ui, label, ...keys) {
    await ui.press(...keys);
    await tick();
    console.log(`\n> ${label}`);
    for (const line of ui.lines.filter((l) => l.trim() !== '')) {
      console.log(`  | ${line}`);
    }
  }

  console.log('--- answering everything ---');
  {
    const ui = createTestTerminal({ columns: 50, rows: 12 });
    const opts = { ansi: ui.ansi, terminal: ui.terminal };
    const done = session(opts);

    await tick();
    await type(ui, 'a name', ...'demo-cli', KEYS.enter);
    await type(ui, 'Enter on the first choice', KEYS.enter);
    await type(ui, 'y', 'y');
    console.log('\nreturned:', JSON.stringify(await done));
  }

  console.log('\n--- Ctrl-C at the second question ---');
  {
    const ui = createTestTerminal({ columns: 50, rows: 12 });
    const opts = { ansi: ui.ansi, terminal: ui.terminal };
    const done = session(opts);

    await tick();
    await type(ui, 'a name', ...'demo', KEYS.enter);
    await type(ui, 'Ctrl-C', ctrl('c'));
    console.log('\nreturned:', JSON.stringify(await done));
  }
}
