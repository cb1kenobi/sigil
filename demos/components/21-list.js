/**
 * A list prompt: one line, split on a separator, returned as an array.
 *
 *   node demos/components/21-list.js
 *   node demos/components/21-list.js | cat    <- a scripted run, no terminal needed
 *
 * Type `api, web ,, db` and press Enter: the answer is `['api', 'web', 'db']`.
 * Each entry is trimmed and an empty one is dropped, so a trailing comma or a
 * doubled one costs nothing. The line stays as typed until Enter; the second
 * prompt splits on commas and spaces alike, and the third refuses an answer with
 * fewer than two entries.
 *
 * Piped, there is nobody to type, so the same prompts are driven by a scripted
 * keyboard and the screen is printed after each step. That is the in-process
 * terminal the `testing` subpath gives an app's own tests.
 */
import { list, PromptError } from '@ttylabs/sigil/components';
import { createTestTerminal, KEYS } from '@ttylabs/sigil/testing';

const prompts = {
  tags: {
    initial: ['cli', 'node'],
    message: 'Tags',
  },
  hosts: {
    message: 'Hosts',
    // a regular expression takes every spelling of "and"
    separator: /[\s,]+/,
  },
  owners: {
    message: 'Owners',
    validate: (owners) => (owners.length < 2 ? 'Name at least two owners' : undefined),
  },
};

if (process.stdin.isTTY && process.stdout.isTTY) {
  try {
    const tags = await list(prompts.tags);
    const hosts = await list(prompts.hosts);
    const owners = await list(prompts.owners);

    console.log('\n---');
    console.log({ hosts, owners, tags });
  } catch (err) {
    if (err instanceof PromptError) {
      console.error(err.aborted ? '\nCancelled.' : `\n${err.message}`);
      process.exitCode = 1;
    } else {
      throw err;
    }
  }
} else {
  /**
   * Plays one prompt through a list of keystrokes, printing the screen after each.
   *
   * @param title - What the step shows.
   * @param opts - The prompt's options.
   * @param steps - Keystrokes, each a string typed a character at a time.
   * @returns The answer.
   */
  async function play(title, opts, steps) {
    console.log(`\n${title}`);
    const ui = createTestTerminal({ columns: 60 });
    const answer = list({ ...opts, ansi: ui.ansi, terminal: ui.terminal });

    // a prompt that is rejected while the keys are still going in is an
    // unhandled rejection until something awaits it
    answer.catch(() => {});
    console.log(`  (start)           ${ui.lines.join(' | ')}`);

    for (const keys of steps) {
      await ui.press(...keys.chars);
      console.log(`  ${keys.label.padEnd(17)} ${ui.lines.join(' | ')}`);
    }

    return answer;
  }

  /** A step: what is pressed and what the line says it is. */
  const type = (text) => ({ chars: [...text], label: `type ${text}` });
  const key = (name) => ({ chars: [KEYS[name]], label: name });

  const tags = await play('Tags: an initial list, edited, with the empties dropped', prompts.tags, [
    type(', ,ts,'),
    key('enter'),
  ]);

  const hosts = await play('Hosts: commas and spaces both separate', prompts.hosts, [
    type('a.example.com b.example.com,c.example.com'),
    key('enter'),
  ]);

  const owners = await play('Owners: a rule about how many', prompts.owners, [
    type('ada,'),
    key('enter'),
    type(' grace'),
    key('enter'),
  ]);

  console.log('\n---');
  console.log({ hosts, owners, tags });
}
