/**
 * Going back a step in `group()`, and starting a prompt from an earlier answer.
 *
 *   node demos/components/42-group-back.js           <- asks, in a terminal
 *   node demos/components/42-group-back.js | cat     <- drives the same flow with keys it sends itself
 *
 * Every prompt takes a `value`: an answer to open on, typed as the answer it
 * gives. A text field opens holding it, a list opens with it highlighted, a
 * multiselect with exactly it ticked. That is what lets `group()` go back: each
 * step is handed a second argument -- `{ back, value }`, both only when they say
 * something -- and spreads it into its prompt. **Escape** then goes back to the
 * step before, which comes back showing what was answered there.
 *
 * Going back never skips a step on the way forward again. The second question's
 * choices depend on the first answer, so when the first changes, the second is
 * asked again -- and its earlier answer, no longer on offer, is dropped rather
 * than refused. A step whose earlier answer still stands costs one Enter.
 *
 * Piped there is nobody to ask, so the second half sends the keys a person would
 * have typed through a test terminal and prints the screen after each one.
 */
import { confirm, ESCAPE_TIMEOUT, group, select, text } from '@ttylabs/sigil/components';
import { createTestTerminal, KEYS, tick } from '@ttylabs/sigil/testing';

/**
 * The flow, over whichever terminal it is handed.
 *
 * @param opts - The terminal and styler every call draws through.
 * @returns The answers.
 */
function ask(opts) {
  return group({
    // the first step is handed `{}`, so there is no `back` and Escape does
    // nothing -- there is nowhere to go back to
    runtime: (_answers, step) =>
      select({ ...opts, message: 'Runtime', choices: ['node', 'bun'], ...step }),

    // offered from the answer before it, which is why going back past this step
    // asks it again rather than keeping what it said
    pm: ({ runtime }, step) =>
      select({
        ...opts,
        message: `Package manager for ${runtime}`,
        choices: runtime === 'bun' ? ['bun'] : ['npm', 'pnpm', 'yarn'],
        ...step,
      }),

    // `value` first and the step after it: the first time through the field
    // opens on the suggestion, and every time after on what was typed
    name: (_answers, step) => text({ ...opts, message: 'Project name', value: 'my-app', ...step }),

    ok: ({ name, pm }, step) =>
      confirm({ ...opts, message: `Create ${name} with ${pm}?`, ...step }),
  });
}

if (process.stdin.isTTY && process.stdout.isTTY) {
  console.log(await ask({}));
} else {
  const ui = createTestTerminal({ columns: 50, rows: 14 });
  const opts = { ansi: ui.ansi, terminal: ui.terminal };
  const done = ask(opts);

  /**
   * Presses keys and prints what the screen shows after them.
   *
   * A lone Escape is held for `ESCAPE_TIMEOUT` before it is a key, since it could
   * be the start of an Alt chord, so the clock is let run past it.
   *
   * @param label - What is being sent, for the reader of the transcript.
   * @param keys - The reads to send.
   */
  async function type(label, ...keys) {
    for (const key of keys) {
      await ui.press(key);
      if (key === KEYS.escape) {
        await new Promise((resolve) => setTimeout(resolve, ESCAPE_TIMEOUT + 10));
      }
      await tick();
    }
    console.log(`\n> ${label}`);
    for (const line of ui.lines.filter((l) => l.trim() !== '')) {
      console.log(`  | ${line}`);
    }
  }

  await tick();
  await type('Enter on node', KEYS.enter);
  await type('Down to pnpm, Enter', KEYS.down, KEYS.enter);
  await type('a name over the suggestion', ...Array(6).fill(KEYS.backspace), ...'demo', KEYS.enter);
  await type('Escape: back to the name, holding what was typed', KEYS.escape);
  await type('Escape: back to the package manager, on pnpm', KEYS.escape);
  await type('Escape: back to the runtime, on node', KEYS.escape);
  await type('Down to bun, Enter: pnpm is not on offer any more', KEYS.down, KEYS.enter);
  await type('Enter on bun: the name is asked again, still holding demo', KEYS.enter);
  await type('Enter on the name', KEYS.enter);
  await type('y', 'y');

  console.log('\nreturned:', JSON.stringify(await done));
}
