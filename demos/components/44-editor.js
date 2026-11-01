import { editor, PromptError } from '@ttylabs/sigil/components';
import { createTestTerminal, KEYS } from '@ttylabs/sigil/testing';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
/**
 * An editor prompt: the answer is written in $VISUAL or $EDITOR.
 *
 *   node demos/components/44-editor.js
 *   EDITOR='code --wait' node demos/components/44-editor.js
 *   node demos/components/44-editor.js | cat    <- a scripted run, no terminal needed
 *
 * The question is drawn and Enter opens the editor on a temporary file that
 * starts with `default`. While it is open the prompt holds nothing -- no raw
 * mode, nothing reading stdin, the cursor back -- and a line says what it is
 * waiting for, which is what a window-opening editor leaves on show. Saving and
 * quitting answers with what was saved; a `validate` that rejects it asks again
 * under the reason, and Enter reopens the editor on exactly what was saved. The
 * file is in a directory of its own and is gone however the prompt ends.
 *
 * Piped, there is nobody to type and no editor to look at, so the prompt is
 * driven by a scripted keyboard (`createTestTerminal()`), and the editor is this
 * file run again with `--as-editor`: a stand-in that rewrites what it is handed.
 * It is a real child process, opened through the shell the way `$EDITOR` is.
 */

const here = fileURLToPath(import.meta.url);

/**
 * The stand-in editor. The first time it sees the draft it saves a message the
 * `validate` below rejects; the second time, one it accepts. It waits a moment
 * first, so the scripted run can show the screen while an editor is open.
 */
function standIn(file) {
  const draft = readFileSync(file, 'utf8');
  setTimeout(() => {
    writeFileSync(
      file,
      draft.startsWith('wip')
        ? 'Read the editor from $VISUAL, then $EDITOR\n\nSplit by the shell, as git does.\n'
        : 'wip\n'
    );
  }, 300);
}

/** What `validate` says about a message that is not finished. */
function check(value) {
  return value.startsWith('wip') ? 'Write a real summary line' : undefined;
}

async function interactive() {
  try {
    const message = await editor({
      default: 'Summary line\n\nWhat changed, and why.\n',
      message: 'Commit message',
      postfix: '.md',
      validate: check,
    });

    console.log('\n---');
    console.log(message);
  } catch (err) {
    if (err instanceof PromptError) {
      // Ctrl-C is a cancel; an editor that exited non-zero, or no editor at all,
      // is the message
      console.error(err.aborted ? '\nCancelled.' : `\n${err.message}`);
      process.exitCode = 1;
    } else {
      throw err;
    }
  }
}

async function scripted() {
  const ui = createTestTerminal({ columns: 60, rows: 6 });
  const print = (label) => {
    console.log(`-- ${label}`);
    console.log(ui.lines.join('\n'));
    console.log();
  };
  const until = async (text) => {
    while (!ui.lines.some((line) => line.includes(text))) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  };

  const answer = editor({
    default: 'Summary line\n',
    editor: `"${process.execPath}" "${here}" --as-editor`,
    message: 'Commit message',
    postfix: '.md',
    terminal: ui.terminal,
    validate: check,
  });
  // a prompt that rejects while keys are still going in is an unhandled rejection
  answer.catch(() => {});

  await ui.press();
  print('opened: Enter opens the editor');

  await ui.press(KEYS.enter);
  await until('Waiting');
  print('Enter: the editor is open, and the prompt has let go of the terminal');

  await until('Write a real summary line');
  print('saved "wip": validate rejects it, and the question comes back under the reason');

  await ui.press(KEYS.enter);
  const message = await answer;
  print('Enter again: the editor reopens on what was saved, and this time it is accepted');
  console.log(JSON.stringify(message));
}

if (process.argv[2] === '--as-editor') {
  standIn(process.argv[3]);
} else if (process.stdin.isTTY && process.stdout.isTTY) {
  // both sides, because the prompt is read off stdin and drawn to the terminal's output
  await interactive();
} else {
  await scripted();
}
