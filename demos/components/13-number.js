/**
 * A number prompt: it refuses a letter as it is typed, steps with the arrows, and
 * holds the answer to a range.
 *
 *   node demos/components/13-number.js                 <- asks, in a terminal
 *   node demos/components/13-number.js | cat           <- plays the same prompts, scripted
 *
 * In a terminal: type digits, Up and Down step the value, a letter does nothing
 * at all, and Enter outside the range says which bound it broke instead of
 * quietly clamping. Try `99999` on the port, then Down from an empty field on
 * the ratio.
 *
 * Piped, there is nobody to type, so the same three prompts are driven with
 * `createTestTerminal()` and the screen is printed after each step. That is the
 * only honest way to show a prompt without a terminal: a prompt that is asked
 * with no one to answer it fails, which is `04-prompts.js`'s whole last section.
 *
 * What it shares with the parser is the point of the third prompt: `--port
 * 9007199254740993` is refused for being too large to be exact, and so is typing
 * it here, with the same sentence -- because the prompt asks `transformValue()`
 * what a number is rather than having an opinion of its own.
 */
import { number, PromptError } from '@ttylabs/sigil/components';
import { createTestTerminal, KEYS } from '@ttylabs/sigil/testing';

const prompts = {
  port: {
    default: 8080,
    max: 65535,
    message: 'Port',
    min: 1,
  },
  ratio: {
    // a float steps without leaving 0.30000000000000004 behind
    float: true,
    initial: 0.2,
    max: 1,
    message: 'Ratio',
    min: 0,
    step: 0.1,
  },
  id: {
    message: 'Record id',
  },
};

if (process.stdin.isTTY && process.stdout.isTTY) {
  try {
    const port = await number(prompts.port);
    const ratio = await number(prompts.ratio);
    const id = await number(prompts.id);

    console.log('\n---');
    console.log({ id, port, ratio });
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
    const answer = number({ ...opts, ansi: ui.ansi, terminal: ui.terminal });

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

  const port = await play(
    'A port: letters are ignored, Enter outside the range is refused',
    prompts.port,
    [
      type('9o9'),
      type('999'),
      key('enter'),
      key('backspace'),
      key('backspace'),
      key('backspace'),
      type('80'),
      key('enter'),
    ]
  );

  const ratio = await play('A ratio: floats step without noise', prompts.ratio, [
    key('up'),
    key('up'),
    key('up'),
    key('up'),
    key('up'),
    key('up'),
    key('enter'),
  ]);

  const id = await play("An id: the parser's own limit", prompts.id, [
    type('9007199254740993'),
    key('enter'),
    key('backspace'),
    type('1'),
    key('enter'),
  ]);

  console.log('\n---');
  console.log({ id, port, ratio });
}
