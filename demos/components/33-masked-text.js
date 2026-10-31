/**
 * A masked text prompt: a line that follows a template.
 *
 *   node demos/components/33-masked-text.js
 *   node demos/components/33-masked-text.js | cat    <- a scripted run, no terminal needed
 *
 * The template draws the shape of the answer: `(###) ###-####` is a phone number,
 * and only the `#` slots take input. Type `5551234567` and the parentheses, space
 * and dash are drawn and skipped over for you; a character the slot does not
 * accept is ignored; Backspace crosses a fixed character in one press. Enter
 * answers once every slot is full, and the answer is the formatted text. The
 * second prompt is a licence key with a slot of its own that upper-cases what it
 * is given, and the third is a paste, which fills the slots from text that is
 * already formatted, or is not, and drops what does not fit.
 *
 * Piped, there is nobody to type, so the same prompts are driven by a scripted
 * keyboard and the screen is printed after each step. That is the in-process
 * terminal the `testing` subpath gives an app's own tests.
 */
import { applyMask, maskedText, PromptError } from '@ttylabs/sigil/components';
import { createTestTerminal, KEYS } from '@ttylabs/sigil/testing';

const prompts = {
  phone: {
    message: 'Phone',
    template: '(###) ###-####',
  },
  licence: {
    message: 'Licence key',
    // a slot of its own: letters and digits, kept upper case
    slots: { K: { match: /[a-z0-9]/i, transform: (char) => char.toUpperCase() } },
    template: 'KKKK-KKKK-KKKK',
  },
};

if (process.stdin.isTTY && process.stdout.isTTY) {
  try {
    const phone = await maskedText(prompts.phone);
    const licence = await maskedText(prompts.licence);

    console.log('\n---');
    // the raw characters are one call away from the formatted answer
    console.log({ licence, phone, raw: applyMask(prompts.phone.template, phone).raw });
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
   * @param steps - Keystrokes, each a list of characters pressed one at a time.
   * @returns The answer.
   */
  async function play(title, opts, steps) {
    console.log(`\n${title}`);
    const ui = createTestTerminal({ columns: 60 });
    const answer = maskedText({ ...opts, ansi: ui.ansi, terminal: ui.terminal });

    // a prompt that is rejected while the keys are still going in is an
    // unhandled rejection until something awaits it
    answer.catch(() => {});
    console.log(`  (start)              ${ui.lines.join(' | ')}`);

    for (const step of steps) {
      await ui.press(...step.chars);
      console.log(`  ${step.label.padEnd(20)} ${ui.lines.join(' | ')}`);
    }

    return answer;
  }

  /** A step: what is pressed and what the line says it is. */
  const type = (text) => ({ chars: [...text], label: `type ${text}` });
  const key = (name) => ({ chars: [KEYS[name]], label: name });
  const paste = (text) => ({
    chars: [`\u001b[200~${text}\u001b[201~`],
    label: `paste ${text}`,
  });

  const phone = await play(
    'Phone: the fixed characters are drawn, and skipped over',
    prompts.phone,
    [type('5a55 12'), key('backspace'), key('backspace'), type('1234567'), key('enter')]
  );

  const licence = await play(
    'Licence key: a slot of its own keeps what it is given upper case',
    prompts.licence,
    [type('ab12-cd34'), key('enter'), type('ef56'), key('enter')]
  );

  const pasted = await play(
    'Paste: formatted or not, what does not fit is dropped',
    prompts.phone,
    [paste('555.123.4567'), key('enter')]
  );

  console.log('\n---');
  console.log({ licence, pasted, phone });
}
