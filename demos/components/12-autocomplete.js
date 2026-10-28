/**
 * An autocomplete prompt: type to narrow a list, or search a source.
 *
 *   node demos/components/12-autocomplete.js          <- asks, in a terminal
 *   node demos/components/12-autocomplete.js | cat    <- drives the same two prompts
 *
 * Two prompts, one entry point. The first is a static `choices` list ranked by
 * what is typed -- try `ew` for `us-west-2`, and Tab to copy the highlighted name
 * into the field. The second is an async `source(term, signal)` that is asked
 * again on every change, with the previous call's signal aborted first: type fast
 * and only the last lookup is allowed to draw anything.
 *
 * There is no debounce in the prompt, because whether a lookup is worth waiting
 * for is the caller's trade. `debounced()` below is the recipe for one: the
 * signal is what lets a wait that has been superseded stop waiting.
 *
 * Piped there is nobody to type, so the demo plays the keys itself through
 * `createTestTerminal()` and prints the screen after each step -- which is also
 * what a test of your own prompt would do. Run in a terminal it needs one on
 * **both** sides, because the term is read off stdin and drawn to stdout.
 */
import { autocomplete, PromptError } from '@ttylabs/sigil/components';
import { createTestTerminal, KEYS } from '@ttylabs/sigil/testing';

const REGIONS = [
  { hint: 'N. Virginia', label: 'us-east-1' },
  { hint: 'Oregon', label: 'us-west-2' },
  { hint: 'Frankfurt', label: 'eu-central-1' },
  { hint: 'Ireland', label: 'eu-west-1' },
  { hint: 'Mumbai', label: 'ap-south-1' },
  { hint: 'Tokyo', label: 'ap-northeast-1' },
];

const PACKAGES = [
  { description: 'A library for building user interfaces', name: 'react' },
  { description: 'Predictable state container', name: 'redux' },
  { description: 'Fast, unopinionated web framework', name: 'express' },
  { description: 'Promise based HTTP client', name: 'axios' },
  { description: 'Utility library', name: 'lodash' },
  { description: 'Command line interfaces', name: 'commander' },
  { description: 'Terminal string styling', name: 'chalk' },
  { description: 'React renderer for the terminal', name: 'ink' },
];

/**
 * Waits `ms` before calling `lookup`, giving up if the term has moved on first.
 *
 * The whole of the recipe: `signal` is aborted when the next keystroke arrives,
 * so a pending wait is cancelled instead of firing a request nobody wants.
 *
 * @param {(term: string, signal: AbortSignal) => Promise<any[]>} lookup
 * @param {number} ms
 */
function debounced(lookup, ms) {
  return (term, signal) =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => lookup(term, signal).then(resolve, reject), ms);
      signal.addEventListener(
        'abort',
        () => {
          clearTimeout(timer);
          reject(signal.reason);
        },
        { once: true }
      );
    });
}

/**
 * A pretend registry. Slow enough to be cancelled, and honest about it.
 *
 * @param {string} term
 * @param {AbortSignal} signal
 */
function search(term, signal) {
  return new Promise((resolve, reject) => {
    note(`  [lookup "${term}" started]`);
    const onAbort = () => {
      clearTimeout(timer);
      note(`  [lookup "${term}" aborted]`);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      // finished, so a later abort -- the prompt ending, say -- is not news
      signal.removeEventListener('abort', onAbort);
      note(`  [lookup "${term}" finished]`);
      resolve(
        PACKAGES.filter((pkg) => pkg.name.includes(term.toLowerCase())).map((pkg) => ({
          hint: pkg.description,
          label: pkg.name,
        }))
      );
    }, 60);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/** Lookup chatter, only where it is the point: in the piped run. */
let note = () => {};

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

/**
 * Waits until a lookup is no longer out, or says so.
 *
 * A polling wait rather than a fixed sleep, so a machine under load is slower
 * rather than wrong.
 *
 * @param {import('@ttylabs/sigil/testing').TestTerminal} ui
 */
async function idle(ui) {
  const deadline = Date.now() + 5000;
  do {
    await new Promise((resolve) => setTimeout(resolve, 30));
    if (!ui.lines.some((line) => line.includes('Searching...'))) {
      return;
    }
  } while (Date.now() < deadline);
  throw new Error('a lookup never finished');
}

try {
  if (interactive) {
    const region = await autocomplete({
      choices: REGIONS,
      message: 'Region',
      placeholder: 'try "ew", then Tab',
    });

    const pkg = await autocomplete({
      message: 'Package',
      source: debounced(search, 150),
      validate: (value) => (value === 'lodash' ? 'Pick something newer' : undefined),
    });

    console.log('\n---');
    console.log({ pkg, region });
  } else {
    note = console.log;
    console.log('No terminal, so the keys are played through createTestTerminal().');

    // the static list
    const first = createTestTerminal({ columns: 50, rows: 12 });
    const asked = autocomplete({
      ansi: first.ansi,
      choices: REGIONS,
      message: 'Region',
      placeholder: 'try "ew", then Tab',
      terminal: first.terminal,
    });
    show('opened, with the placeholder', first);
    await first.press('e', 'w');
    show('after "ew": ranked, with the matched letters marked on a colour terminal', first);
    await first.press(KEYS.down, KEYS.tab);
    show('Down, then Tab: the highlighted label is now in the field', first);
    await first.press(KEYS.enter);
    const region = await asked;

    // the source: type three characters before the first lookup can finish
    const second = createTestTerminal({ columns: 60, rows: 12 });
    const searched = autocomplete({
      ansi: second.ansi,
      message: 'Package',
      source: debounced(search, 40),
      terminal: second.terminal,
    });
    await idle(second);
    show('opened: the source was asked for the empty term', second);

    // typed faster than the debounce, so the waits for "r" and "re" are cancelled
    // and only "red" ever reaches the registry
    await second.press('r', 'e', 'd');
    show('typed "red": a lookup is out, and the list is the last term\'s', second);
    await idle(second);
    show('answered', second);

    await second.press(KEYS.enter);
    const pkg = await searched;

    console.log('\n---');
    console.log({ pkg, region });
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
