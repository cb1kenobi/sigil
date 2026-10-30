import { PromptError, selectRow } from '@ttylabs/sigil/components';
import { createTestTerminal, KEYS } from '@ttylabs/sigil/testing';
/**
 * An interactive table: pick a row, and sort by a column on the way.
 *
 *   node demos/components/47-select-row.js
 *   node demos/components/47-select-row.js | cat    <- a scripted run, no terminal needed
 *
 * Up and Down move a cursor over whole rows and Enter answers with the row that
 * was passed in. A digit sorts by that column: again to reverse, and a third time
 * to put the rows back as they came. The heading stays where it is while the rows
 * scroll, and a line under them says where in the table the cursor is.
 *
 * The columns are the ones `table()` takes, so the same declaration prints a table
 * and asks about one. Piped, there is nobody to type, so the same prompt is driven
 * by a scripted keyboard (`createTestTerminal()` from `@ttylabs/sigil/testing`) and
 * the screen is printed after each step.
 */

const deployments = [
  { age: 12, name: 'web', region: 'eu-west', status: 'running' },
  { age: 3, name: 'api', region: 'us-east', status: 'running' },
  { age: 40, name: 'Worker', region: 'ap-south', status: 'failed' },
  { age: 7, name: 'db', region: 'us-east', status: 'running' },
  { age: 90, name: 'cron', region: 'eu-west', status: 'stopped' },
  { age: 1, name: 'cache', region: 'us-east', status: 'running' },
];

const columns = [
  { header: 'Name', key: 'name' },
  { header: 'Region', key: 'region' },
  { header: 'Status', key: 'status' },
  { align: 'right', header: 'Age (d)', key: 'age' },
];

async function interactive() {
  try {
    const row = await selectRow({
      columns,
      message: 'Which deployment?',
      rows: deployments,
      short: (picked) => picked.name,
    });

    console.log('\n---');
    console.log({ row });
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
  const ui = createTestTerminal({ columns: 60, rows: 7 });
  const answer = selectRow({
    columns,
    message: 'Which deployment?',
    rows: deployments,
    terminal: ui.terminal,
  });
  // a prompt that rejects while keys are still going in is an unhandled rejection
  answer.catch(() => {});

  const show = async (label, ...keys) => {
    await ui.press(...keys);
    console.log(`-- ${label}`);
    console.log(ui.lines.join('\n'));
    console.log();
  };

  await show('opened: the table is longer than the screen, so a line says where');
  await show('Down, Down: the cursor moves over whole rows', KEYS.down, KEYS.down);
  await show('4: sorted by age, and the cursor stays on its row', '4');
  await show('4: reversed', '4');
  await show('1: by name, with the case folded, so Worker is not first', '1');
  await show('End: the heading is still there when the rows have scrolled', KEYS.end);
  await show('1, 1: back to the order they came in', '1', '1');
  await show('Enter: answers with the row', KEYS.enter);

  console.log({ row: await answer });
}

// both sides, because the prompt is read off stdin and drawn to the terminal's output
if (process.stdin.isTTY && process.stdout.isTTY) {
  await interactive();
} else {
  await scripted();
}
