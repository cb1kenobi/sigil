/**
 * A calendar: one month, printed or picked from.
 *
 *   node demos/components/46-calendar.js
 *   NO_COLOR=1 node demos/components/46-calendar.js
 *
 * `calendar()` returns a month as a string, the way `table()` does. A highlighted
 * day carries a `*` and the selected one sits in `[]`, so both survive a terminal
 * with no colour. `pickDate()` asks for a day by moving through the month:
 * arrows move a day or a week, Page Up and Page Down a month, Home and End to the
 * ends of it. And `date()` takes `calendar: true` to show the month under its
 * field.
 *
 * The prompts need a terminal on both sides. Piped, they play the same prompt
 * against an in-process terminal and print the screen after each step, which is
 * also how the tests drive it.
 */
import { calendar, date, pickDate } from '@ttylabs/sigil/components';
import { createTestTerminal, KEYS } from '@ttylabs/sigil/testing';

// a fixed month, language and week, so the demo prints the same anywhere; leave
// `locale` and `weekStart` out and both come from the machine
const june = new Date(2024, 5, 15);
const deadlines = [new Date(2024, 5, 3), new Date(2024, 5, 20), new Date(2024, 5, 28)];

console.log('a month, with the day selected and three deadlines highlighted:\n');
console.log(
  calendar({
    date: june,
    highlight: deadlines,
    locale: 'en-US',
    selected: june,
    weekStart: 0,
  })
);

console.log('\n\nthe week can start on Monday, and the names follow the language:\n');
console.log(calendar({ date: june, highlight: deadlines, locale: 'de', weekStart: 1 }));

console.log('\n\nleap February, indented under a heading:\n');
console.log(calendar({ date: new Date(2024, 1, 1), indent: 4, locale: 'fr', weekStart: 1 }));

if (process.stdin.isTTY && process.stdout.isTTY) {
  console.log('');
  const picked = await pickDate({
    highlight: deadlines,
    initial: june,
    max: new Date(2024, 11, 31),
    message: 'Which day?',
    min: new Date(2024, 0, 1),
  });
  console.log(`picked: ${picked.toString()}`);

  const typed = await date({ calendar: { highlight: deadlines }, initial: june, message: 'Due?' });
  console.log(`due: ${typed.toString()}`);
} else {
  /**
   * Plays keys against a prompt and prints the screen after each.
   *
   * @param title - What is being shown.
   * @param ask - Starts the prompt on a terminal.
   * @param steps - The key presses, each labelled with what it does.
   */
  async function play(title, ask, steps) {
    console.log(`\n\n-- ${title}`);

    const ui = createTestTerminal({ columns: 40, rows: 12 });
    const answer = ask(ui.terminal);
    answer.catch(() => {});

    await ui.press();
    console.log(ui.lines.join('\n'));

    for (const [what, ...keys] of steps) {
      await ui.press(...keys);
      console.log(`\n  ${what}:\n${ui.lines.join('\n')}`);
    }

    console.log(`\n  answer: ${(await answer).toString()}`);
  }

  await play(
    'pickDate(): a week down, then a month on, then the last day of it',
    (terminal) =>
      pickDate({
        highlight: deadlines,
        initial: june,
        locale: 'en-US',
        message: 'Which day?',
        terminal,
        weekStart: 0,
      }),
    [
      ['down: a week', KEYS.down],
      ['page down: July, same day', KEYS.pageDown],
      ['end: the 31st', KEYS.end],
      ['enter', KEYS.enter],
    ]
  );

  await play(
    'pickDate(): a range, and the cursor stops at its edge',
    (terminal) =>
      pickDate({
        initial: june,
        locale: 'en-US',
        max: new Date(2024, 5, 20),
        message: 'Which day?',
        min: new Date(2024, 5, 10),
        terminal,
        weekStart: 0,
      }),
    [
      ['page down: pinned to the max', KEYS.pageDown],
      ['page up: pinned to the min', KEYS.pageUp],
      ['enter', KEYS.enter],
    ]
  );

  await play(
    'date({ calendar }): the month follows the field',
    (terminal) =>
      date({
        calendar: { locale: 'en-US', weekStart: 0 },
        initial: new Date(2024, 0, 31),
        message: 'Due?',
        terminal,
      }),
    [
      ['page down: the 31st becomes the 29th', KEYS.pageDown],
      ['right, up: month segment steps', KEYS.right, KEYS.up],
      ['enter', KEYS.enter],
    ]
  );
}
