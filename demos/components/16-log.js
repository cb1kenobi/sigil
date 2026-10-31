/**
 * Leveled status lines: a glyph, a colour and a message, written to stderr.
 *
 *   node demos/components/16-log.js
 *   node demos/components/16-log.js 2>/dev/null     <- nothing: it is all stderr
 *   node demos/components/16-log.js | cat           <- the same lines, replayed
 *
 * This is not the `DEBUG` logger. That one says nothing unless asked; this is
 * what a command tells the person running it, so it speaks by default -- and it
 * speaks on **stderr**, because a command's `run()` returns data for a serializer
 * to print on stdout and a status line there would land in the middle of
 * `mycli --format json | jq`.
 *
 * A line takes fields after its message -- `log.info('Deployed', { host, ms })`
 * is `Deployed host=a.example.com ms=412` -- so it can be grepped and read by a
 * tool. A value with a blank in it is quoted, and one with a line break or a
 * control character has it escaped, so a field cannot start a second line.
 * `createLog({ timestamp: true })` puts the time in front of every line.
 *
 * `log.stream.info()` and its siblings take text that has not all arrived -- a
 * model's tokens, a subprocess's pipe -- and wrap it as it comes: each line is
 * written once it is final, and the last one waits for the word still growing.
 *
 * A line printed while a spinner is running lands above it rather than through
 * it. Needs a terminal on both ends to be live; piped, it replays the same calls
 * against a screen model and prints what the screen would have shown.
 */
import { createLog, createSpinner, log } from '@ttylabs/sigil/components';
import { createTestTerminal } from '@ttylabs/sigil/testing';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const ESC = String.fromCharCode(0x1b);

// cut every four characters, so words, a colour and a multi-byte character are
// all split across chunks -- which is how an answer actually arrives
const ANSWER =
  `Streams wrap as they ${ESC}[1mgo${ESC}[22m: a line leaves once the next word ` +
  `proves it is full, and a colour like ${ESC}[36mthis one${ESC}[39m is closed and ` +
  'reopened on each line it spans. Naïve 日本語 text is measured by columns.';

/**
 * The answer, arriving in pieces.
 *
 * @param pause - How long to wait between pieces.
 */
async function* arriving(pause) {
  const bytes = new TextEncoder().encode(ANSWER);
  for (let at = 0; at < bytes.length; at += 4) {
    await pause(40);
    yield bytes.subarray(at, at + 4);
  }
}

/**
 * The calls, against whichever logger and spinner it is handed.
 *
 * @param logger - The logger.
 * @param spinner - A spinner on the same terminal.
 * @param pause - How long to stay on each step.
 */
async function scene(logger, spinner, pause) {
  logger.step('Installing dependencies');
  spinner.start('Resolving');
  await pause(500);

  // above the spinner, which keeps spinning underneath
  logger.info('Using the lockfile from the last run');
  await pause(300);
  logger.warn('left-pad is deprecated');
  await pause(300);
  spinner.succeed('Resolved 42 packages');

  logger.success('Installed');
  logger.error('Could not write the cache:\npermission denied\n\ntry running with --no-cache');
  logger.message('A line with no level, and one with a symbol of its own:');
  logger.message('see https://example.com/docs', { symbol: '→' });

  // fields follow the message, dimmed; a value cannot forge a line of its own
  logger.success('Deployed', { host: 'a.example.com', ms: 412 });
  logger.warn('Rejected', { reason: 'bad input\n✖ forged line' });

  // bytes, cut mid-character: the stream puts them back together
  await logger.stream.info(arriving(pause));
}

if (process.stdout.isTTY && process.stderr.isTTY) {
  await scene(log, createSpinner(), sleep);
  createLog({ timestamp: true }).info('Done', { stamped: 'with the local time' });
} else {
  const ui = createTestTerminal({ columns: 44, rows: 20 });
  const logger = createLog({ terminal: ui.terminal });
  const spinner = createSpinner({ terminal: ui.terminal });

  await scene(logger, spinner, async () => {});

  console.log('No terminal, so here is the screen those calls produced:\n');
  for (const line of ui.lines) {
    console.log(`  | ${line}`);
  }

  // the ASCII set is for terminals that cannot be trusted with the rest
  const plain = createTestTerminal({ columns: 44, rows: 4 });
  const ascii = createLog({ ascii: true, terminal: plain.terminal });
  ascii.info('info');
  ascii.success('success');
  ascii.warn('warn');
  ascii.error('error');

  console.log('\nThe same four with ascii: true:\n');
  for (const line of plain.lines) {
    console.log(`  | ${line}`);
  }

  // a fixed clock, so the output is the same on every run
  const clock = createTestTerminal({ columns: 60, rows: 4 });
  const stamped = createLog({
    now: () => new Date(Date.UTC(2026, 9, 30, 18, 50, 17, 547)),
    terminal: clock.terminal,
    timestamp: 'iso',
  });
  stamped.info('Deployed', { host: 'a', ms: 412 });
  stamped.error('Failed:\nconnection refused', { host: 'b' });

  console.log("\nWith timestamp: 'iso', which is UTC:\n");
  for (const line of clock.lines) {
    console.log(`  | ${line}`);
  }
}
