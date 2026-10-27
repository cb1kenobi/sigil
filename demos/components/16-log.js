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
 * A line printed while a spinner is running lands above it rather than through
 * it. Needs a terminal on both ends to be live; piped, it replays the same calls
 * against a screen model and prints what the screen would have shown.
 */
import { createLog, createSpinner, log } from '@ttylabs/sigil/components';
import { createTestTerminal } from '@ttylabs/sigil/testing';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
}

if (process.stdout.isTTY && process.stderr.isTTY) {
  await scene(log, createSpinner(), sleep);
} else {
  const ui = createTestTerminal({ columns: 44, rows: 14 });
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
}
