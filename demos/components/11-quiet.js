/**
 * The three states of one axis: `live`, `reduce`, `quiet`.
 *
 *   node demos/components/11-quiet.js
 *   node demos/components/11-quiet.js | cat     <- the same run, with no terminal
 *
 * On a terminal the first block animates and the second does not; piped, both
 * write one line per change, which is `reduce` -- and in the third the spinner,
 * the bar and the typewriter draw nothing at all either way, which is `quiet`.
 * The `console.log` lines around them stay, which is the next paragraph.
 *
 * What makes the third one worth having is that **nothing here is wired by
 * hand**. `requestQuiet(true)` is what `main()` calls when argv said `--quiet`,
 * and the spinner, the bar and the typewriter below are told nothing: they read
 * the one fold, which is `resolveOutput()`.
 *
 * And what survives is the point: the answer does, the progress does not. The
 * `console.log` lines below are the answer, so they are still here -- a quiet
 * run is a run whose stdout is only what was asked for.
 */
import { createProgress, createSpinner, createTypewriter } from '@ttylabs/sigil/components';
import { requestQuiet, resolveOutput } from '@ttylabs/sigil/style';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const live = process.stdout.isTTY === true;

/**
 * The fold's own answer for a block, asked with the block's own options.
 *
 * Handed the block's `reducedMotion` rather than folding `live` alone, because
 * on a terminal the two disagree: the second block's `reduce` is a per-component
 * option, so a label that read `reducedMotion: reduce` sat beside an answer of
 * `live`. Piped it happened to agree, which is the run the README describes --
 * so the contradiction was invisible in the documented form and present in the
 * one a reader at a terminal does first.
 */
const say = (label, opts = {}) =>
  console.log(`\n-- ${label}: resolveOutput() is ${resolveOutput({ live, ...opts })}`);

say('nobody said anything');
const one = createSpinner({ text: 'Resolving' }).start();
await sleep(live ? 600 : 0);
one.succeed('Resolved 12 packages');

// the user's own override of the *detection*, which is a different question
// from quiet: it says do not move, not say nothing
say('reducedMotion: reduce', { reducedMotion: 'reduce' });
const two = createSpinner({ reducedMotion: 'reduce', text: 'Compiling' }).start();
await sleep(live ? 600 : 0);
two.succeed('Compiled 2 files');

const bar = createProgress({ reducedMotion: 'reduce', text: 'Uploading', total: 4 });
for (let at = 1; at <= 4; at++) {
  bar.current = at;
  await sleep(live ? 150 : 0);
}
bar.done();

// what `main()` does when argv said `--quiet`. Everything below is told
// nothing about it and draws nothing anyway
requestQuiet(true);
say('--quiet');
createSpinner({ text: 'Resolving' }).start().succeed('Resolved 12 packages');

const quietBar = createProgress({ text: 'Uploading', total: 4 });
for (let at = 1; at <= 4; at++) {
  quietBar.current = at;
}
quietBar.done();

const writer = createTypewriter({ text: 'and this is not drawn either' });
writer.start();
writer.done();

console.log('...and nothing in that block was drawn -- these lines are the answer, which survives');

// put back, because it is process-wide: a demo that left it on would decide the
// answer for anything this process did next
requestQuiet(undefined);
say('taken back');
createSpinner({ text: 'Cache' }).start().info('Nothing to do');
