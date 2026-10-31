import { PromptError, toggle } from '@ttylabs/sigil/components';
import { createTestTerminal, KEYS } from '@ttylabs/sigil/testing';
/**
 * A toggle prompt: a setting with two named states.
 *
 *   node demos/components/29-toggle.js
 *   node demos/components/29-toggle.js | cat    <- a scripted run, no terminal needed
 *
 * The inactive state is on the left and the active one on the right, like a
 * switch. Left and Right choose one, Tab and Space flip to the other, and Enter
 * answers. `active` and `inactive` name the states; without them they are `on`
 * and `off`.
 *
 * Piped, there is nobody to type, so the same prompt is driven by a scripted
 * keyboard (`createTestTerminal()` from `@ttylabs/sigil/testing`) and the screen
 * is printed after each step.
 */

async function interactive() {
  try {
    const notifications = await toggle({ message: 'Notifications' });
    const telemetry = await toggle({
      active: 'enabled',
      inactive: 'disabled',
      initial: true,
      message: 'Telemetry',
    });

    console.log('\n---');
    console.log({ notifications, telemetry });
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
  const ui = createTestTerminal({ columns: 60, rows: 6 });
  const show = async (label, ...keys) => {
    await ui.press(...keys);
    console.log(`-- ${label}`);
    console.log(ui.lines.join('\n'));
    console.log();
  };

  const first = toggle({ message: 'Notifications', terminal: ui.terminal });
  // a prompt that rejects while keys are still going in is an unhandled rejection
  first.catch(() => {});

  await show('opened: the inactive state is current');
  await show('Tab: flips to the active state', KEYS.tab);
  await show('Space: and back', KEYS.space);
  await show('Right: chooses the active state outright', KEYS.right);
  await show('Right again: stays there, an arrow says where to go', KEYS.right);
  await show('Enter: answers with the name of the state', KEYS.enter);
  console.log({ notifications: await first });

  const second = toggle({
    active: 'enabled',
    inactive: 'disabled',
    initial: true,
    message: 'Telemetry',
    terminal: ui.terminal,
  });
  second.catch(() => {});

  await show('a second prompt, with its own names, starting active');
  await show('Left: chooses the inactive state', KEYS.left);
  await show('Enter', KEYS.enter);
  console.log({ telemetry: await second });
}

// both sides, because the prompt is read off stdin and drawn to the terminal's output
if (process.stdin.isTTY && process.stdout.isTTY) {
  await interactive();
} else {
  await scripted();
}
