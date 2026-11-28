/**
 * A REPL: a prompt line that comes back, over a fixed word list.
 *
 *   node demos/components/68-repl.js          <- a prompt, in a terminal
 *   node demos/components/68-repl.js | cat    <- plays the keys itself, and prints the screen
 *
 * One `repl()` over `wordCompleter()`: type `de` and the popup lists `deploy` and
 * `destroy` under the start of the word with `deploy` dim after the caret, which
 * Right (or End) takes; Tab takes the highlighted item, Down moves in the popup,
 * Escape puts it away. Up and Down walk the lines already run, Ctrl-R searches
 * them, and the history is a file under the XDG state directory -- here a
 * temporary one -- that a second REPL reads and appends to without losing a line.
 * The footer is a function of the line: it says what a `deploy` line wants.
 *
 * Ctrl-C clears the line and a second one on an empty line leaves, as does Ctrl-D,
 * which is what `node` does. What `console.log()` prints while the line is up goes
 * above it, and `status` below logs from a timer to show it.
 *
 * Piped there is nobody to type, so the demo plays the keys through
 * `createTestTerminal()` and prints the screen after each step, which is also what
 * a test of your own REPL would do. Piped *input* is the other no-terminal case, and
 * is not this one: `echo 'status' | node my-repl.js` reads lines with no editing
 * and no prompt, and `repl.test.ts` pins it.
 */
import { repl, wordCompleter } from '@ttylabs/sigil/components/repl';
import { createTestTerminal, ctrl, KEYS, tick } from '@ttylabs/sigil/testing';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const WORDS = [
  { hint: 'ship a build', label: 'deploy' },
  { hint: 'tear it down', label: 'destroy' },
  { hint: 'what is running', label: 'status' },
  { hint: 'go back one', label: 'rollback' },
  { hint: 'leave', label: 'quit' },
];

/** What each command wants after it, for the footer. */
const USAGE = {
  deploy: 'deploy <env> [--dry-run]',
  destroy: 'destroy <env> --force',
  rollback: 'rollback [steps]',
};

/** The footer: the usage of the command the line starts with. */
const footer = (line) => USAGE[line.trim().split(/\s+/)[0]];

/**
 * Where a command writes: the console, which is the terminal's own in a terminal.
 * The piped run points it at the faked terminal instead, so that what a command
 * prints is on the screen that is shown rather than in between the screens.
 */
let print = (text) => console.log(text);

/**
 * Runs a line. `quit` ends the session; `status` logs from a timer, which lands
 * above the prompt that is up by then -- `console.log()` while a line is up is
 * written above it, which is what this shows, and why the piped run's own
 * output goes through `process.stdout` and not the console it would be caught by.
 */
function onSubmit(line, { exit }) {
  const [command] = line.trim().split(/\s+/);
  if (command === 'quit') {
    exit();
  } else if (command === 'status') {
    setTimeout(() => console.log('  (a task finished)'), 20);
    print('2 services running');
  } else if (command in USAGE) {
    print(`ran: ${line}`);
  } else {
    print(`unknown command: ${command}`);
  }
}

/**
 * Prints the screen as it is now.
 *
 * @param {string} title
 * @param {import('@ttylabs/sigil/testing').TestTerminal} ui
 */
function show(title, ui) {
  // not `console.log()`: the REPL has the console while its line is up, and would
  // draw what is printed onto the very screen being printed
  process.stdout.write(`\n-- ${title}\n`);
  for (const line of ui.lines) {
    process.stdout.write(`${line.trimEnd()}\n`);
  }
}

const dir = mkdtempSync(join(tmpdir(), 'sigil-repl-demo-'));
const historyFile = join(dir, 'history');

try {
  const options = {
    completer: wordCompleter(WORDS),
    footer,
    historyFile,
    onSubmit,
    prompt: 'ops> ',
  };

  if (process.stdin.isTTY && process.stdout.isTTY) {
    await repl({ ...options, help: true });
  } else {
    process.stdout.write('No terminal, so the keys are played through createTestTerminal().\n');

    const ui = createTestTerminal({ columns: 56, rows: 16 });
    print = (text) => void ui.terminal.write(`${text}\n`);
    const session = repl({ ...options, frameMs: 0, terminal: ui.terminal });
    await tick();
    show('opened', ui);

    await ui.press('d', 'e');
    show('after "de": the popup under the word, the rest of the best match dim', ui);

    await ui.press(KEYS.right, ' ', 'p', 'r', 'o', 'd');
    show('Right took "deploy", and the footer reads the line', ui);

    await ui.press(KEYS.enter);
    show('run: the line stays in the scrollback and the prompt comes back', ui);

    await ui.press('s', 't', KEYS.tab, KEYS.enter);
    await new Promise((resolve) => setTimeout(resolve, 60));
    show('"status": Tab completed it, and a timer logged above the prompt', ui);

    await ui.press(ctrl('r'), 'd', 'e', 'p');
    show('Ctrl-R, "dep": the newest line holding it', ui);

    await ui.press(KEYS.enter);
    show('Enter puts it in the line without running it', ui);

    await ui.press(ctrl('c'));
    await ui.press(ctrl('c'));
    show('Ctrl-C cleared the line; a second, on an empty one, says how to leave', ui);

    await ui.press(ctrl('d'));
    await session;
    show('Ctrl-D: the session is over', ui);
  }
} finally {
  rmSync(dir, { force: true, recursive: true });
}
