/**
 * A searchable multiselect: type to narrow a long list, and tick several.
 *
 *   node demos/components/21-autocomplete-multiselect.js          <- asks, in a terminal
 *   node demos/components/21-autocomplete-multiselect.js | cat    <- plays the same prompt
 *
 * Space ticks the highlighted row and Enter confirms what is ticked. The ticks
 * belong to the choices rather than to the list on screen, so narrowing the list
 * to something else does not lose them: the line under the list counts the ones
 * the term is hiding, and clearing the term brings them back.
 *
 * Piped there is nobody to type, so the demo plays the keys itself through
 * `createTestTerminal()` and prints the screen after each step -- the way a test
 * of your own prompt would. Run in a terminal it needs one on **both** sides,
 * because the term is read off stdin and drawn to stdout.
 */
import { autocompleteMultiselect, PromptError } from '@ttylabs/sigil/components';
import { createTestTerminal, KEYS } from '@ttylabs/sigil/testing';

const REGIONS = [
  { hint: 'N. Virginia', label: 'us-east-1' },
  { hint: 'Oregon', label: 'us-west-2' },
  { hint: 'Frankfurt', label: 'eu-central-1' },
  { hint: 'Ireland', label: 'eu-west-1' },
  { hint: 'Mumbai', label: 'ap-south-1' },
  { hint: 'Tokyo', label: 'ap-northeast-1' },
];

const interactive = process.stdin.isTTY && process.stdout.isTTY;

/**
 * Prints the screen as it is now.
 *
 * @param {string} title
 * @param {import('@ttylabs/sigil/testing').TestTerminal} ui
 */
function show(title, ui) {
  console.log(`\n-- ${title}`);
  for (const line of ui.lines) {
    console.log(line.trimEnd());
  }
}

try {
  if (interactive) {
    const regions = await autocompleteMultiselect({
      choices: REGIONS,
      message: 'Regions',
      min: 1,
      placeholder: 'try "eu", tick one, then clear it',
    });

    console.log('\n---');
    console.log({ regions });
  } else {
    console.log('No terminal, so the keys are played through createTestTerminal().');

    const ui = createTestTerminal({ columns: 50, rows: 14 });
    const asked = autocompleteMultiselect({
      ansi: ui.ansi,
      choices: REGIONS,
      max: 3,
      message: 'Regions',
      min: 1,
      terminal: ui.terminal,
    });
    show('opened: a tick box on every row', ui);

    await ui.press(KEYS.enter);
    show('Enter with nothing ticked: min is 1, so it is refused and the prompt stays open', ui);

    await ui.press(KEYS.space);
    show('Space on the highlighted row ticks it', ui);

    await ui.press('e', 'u');
    show('"eu" narrows the list: us-east-1 is hidden but still ticked, and counted', ui);

    await ui.press(KEYS.space);
    show('Space ticks the highlighted eu-west-1 too', ui);

    await ui.press(KEYS.backspace, KEYS.backspace);
    show('the term cleared: both ticks are on their rows again', ui);

    await ui.press(KEYS.enter);
    const regions = await asked;

    console.log('\n---');
    console.log({ regions });
  }
} catch (err) {
  if (err instanceof PromptError) {
    // the two ways a prompt does not get answered, which are different in kind
    console.error(err.aborted ? '\nCancelled.' : `\n${err.message}`);
    process.exitCode = 1;
  } else {
    throw err;
  }
}
