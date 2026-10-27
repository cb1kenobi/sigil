/**
 * A date prompt: segments you step or type into.
 *
 *   node demos/components/19-date.js
 *
 * Left, Right and Tab move between year, month and day; Up and Down step the
 * one you are on; digits fill it in. Stepping never carries, so December up is
 * January of the same year, and the day is pulled back to the last day of a
 * shorter month -- January 31st stepped to February is the 28th, or the 29th in
 * a leap year. The answer is a `Date` built the way the parser's own `date` type
 * builds one, in local time.
 *
 * Needs a terminal on both sides. Piped, it plays the same prompt against an
 * in-process terminal and prints the screen after each step, which is also how
 * the tests drive it.
 */
import { date } from '@ttylabs/sigil/components';
import { createTestTerminal, KEYS } from '@ttylabs/sigil/testing';

/**
 * Asks, then prints what came back.
 *
 * @param label - What the answer is for.
 * @param promise - The prompt.
 */
async function show(label, promise) {
  const answer = await promise;
  console.log(`${label}: ${answer.toString()}`);
}

if (process.stdin.isTTY && process.stdout.isTTY) {
  await show(
    'Booked for',
    date({
      message: 'Which day?',
      // the afternoon of the last day is that day: bounds are inclusive at the
      // precision shown, so only the date is compared here
      min: new Date(2024, 0, 1),
      max: new Date(2030, 11, 31),
    })
  );

  await show(
    'Starts at',
    date({
      message: 'When does it start?',
      time: true,
    })
  );
} else {
  /**
   * Plays keys against a prompt and prints the screen after each.
   *
   * @param title - What is being shown.
   * @param opts - The prompt's options.
   * @param steps - The key presses, each labelled with what it does.
   */
  async function play(title, opts, steps) {
    console.log(`-- ${title}`);

    const ui = createTestTerminal({ columns: 60 });
    const answer = date({ ...opts, terminal: ui.terminal });
    answer.catch(() => {});

    await ui.press();
    console.log(`  start          ${ui.lines.join(' | ')}`);

    for (const [what, ...keys] of steps) {
      await ui.press(...keys);
      console.log(`  ${what.padEnd(14)} ${ui.lines.join(' | ')}`);
    }

    await show('  answer', answer);
    console.log('');
  }

  await play(
    'stepping, and the month it lands in',
    { initial: new Date(2023, 0, 31), message: 'Which day?' },
    [
      ['month up', KEYS.right, KEYS.up],
      ['month up', KEYS.up],
      ['year down', KEYS.left, KEYS.down],
      ['enter', KEYS.enter],
    ]
  );

  await play(
    'typing, and a day the month does not have',
    { initial: new Date(2024, 0, 1), message: 'Which day?' },
    [
      ['type 2023', '2', '0', '2', '3'],
      ['type 02', '0', '2'],
      ['type 31', '3', '1'],
      ['enter', KEYS.enter],
    ]
  );

  await play(
    'a range, and what Enter says outside it',
    {
      initial: new Date(2020, 0, 1),
      max: new Date(2030, 0, 1),
      message: 'Which day?',
      min: new Date(2024, 0, 1),
    },
    [
      ['enter', KEYS.enter],
      ['year up', KEYS.up],
      ['enter', KEYS.enter],
    ]
  );

  await play(
    'a clock steps without carrying into the day',
    { initial: new Date(2024, 5, 15, 23, 59), message: 'When?', time: true },
    [
      ['minute wraps', KEYS.tab, KEYS.tab, KEYS.tab, KEYS.tab, KEYS.up],
      ['hour wraps', KEYS.left, KEYS.up],
      ['enter', KEYS.enter],
    ]
  );
}
