import { PromptError, sort } from '@ttylabs/sigil/components';
import { createTestTerminal, KEYS } from '@ttylabs/sigil/testing';
/**
 * A sort prompt: put a list in order.
 *
 *   node demos/components/21-sort.js
 *   node demos/components/21-sort.js | cat    <- a scripted run, no terminal needed
 *
 * Space picks the highlighted row up, Up and Down carry it, Space puts it down,
 * and Enter answers. Home and End send a carried row to the top or the bottom.
 * Alt or Shift with an arrow moves a row one place without picking it up. A
 * choice marked `disabled` is pinned: the rows around it move past it, and it
 * keeps its place.
 *
 * Piped, there is nobody to type, so the same prompt is driven by a scripted
 * keyboard (`createTestTerminal()` from `@ttylabs/sigil/testing`) and the screen
 * is printed after each step.
 */

const steps = ['lint', 'build', { disabled: 'pinned', label: 'checkout' }, 'test', 'deploy'];

async function interactive() {
  try {
    const order = await sort({ choices: steps, message: 'Run the steps in this order' });

    console.log('\n---');
    console.log({ order });
  } catch (err) {
    if (err instanceof PromptError) {
      // a prompt with nobody to answer it rejects, and Ctrl-C is the abort
      console.error(err.aborted ? '\nCancelled.' : `\n${err.message}`);
      process.exitCode = 1;
    } else {
      throw err;
    }
  }
}

async function scripted() {
  const ui = createTestTerminal({ columns: 60, rows: 10 });
  const answer = sort({ choices: steps, message: 'Order', terminal: ui.terminal });
  // a prompt that rejects while keys are still going in is an unhandled rejection
  answer.catch(() => {});

  const show = async (label, ...keys) => {
    await ui.press(...keys);
    console.log(`-- ${label}`);
    console.log(ui.lines.join('\n'));
    console.log();
  };

  await show('opened: the checkout row is pinned, the highlight starts on lint');
  await show('Space, Down: lint is carried one place', KEYS.space, KEYS.down);
  await show('Down: and past the pinned row, which stays where it is', KEYS.down);
  await show('Space: put down; Down moves the highlight only', KEYS.space, KEYS.down);
  await show('Space, Home: deploy is carried to the top', KEYS.space, KEYS.home);
  await show('Enter: answers, with a row still in hand', KEYS.enter);

  console.log({ order: await answer });
}

// both sides, because the prompt is read off stdin and drawn to the terminal's output
if (process.stdin.isTTY && process.stdout.isTTY) {
  await interactive();
} else {
  await scripted();
}
