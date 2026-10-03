/**
 * A typewriter, for text that should arrive rather than appear.
 *
 *   node demos/components/07-typewriter.js
 *   node demos/components/07-typewriter.js | cat     <- the same run, with no terminal
 *
 * Piped, there is nothing to animate, so the whole text arrives at once and each
 * change is one line: seven lines for this run, because the third typewriter has
 * four things appended to it. One line per step would be about a hundred.
 * The same is true under `SIGIL_REDUCED_MOTION=reduce` on a real terminal.
 *
 * It reads no keys, so there is nothing here that needs a terminal on both sides.
 */
import { byWord, createTypewriter } from '@ttylabs/sigil/components';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// a grapheme at a time, which is the default: a wide cluster, a flag and a family
// emoji are one step each, so none of them is ever drawn half-revealed
const splash = createTypewriter({
	cursor: '█',
	interval: 28,
	text: 'sigil — the Next.js for CLIs \u{1F6E0}\u{1F1EC}\u{1F1E7}',
}).start();

await sleep(1100);
splash.done();

// a word at a time, with a pause the caller decides. The pace is handed the chunk
// that was just revealed, so a comma or a full stop is one line of arithmetic --
// and the component stays out of the business of guessing what punctuation means
// in somebody else's prose
const line = createTypewriter({
	chunk: byWord,
	cursor: '█',
	pace: (chunk) => (/[.,:]$/.test(chunk) ? 320 : 70),
	text: 'Resolving dependencies, compiling, and writing the bundle.',
}).start();

await sleep(1400);
line.done();

// and text that arrives while it is still being typed, which is the case the
// common-prefix rule exists for: nothing already on screen is retyped
const streamed = createTypewriter({ cursor: '█', interval: 18 }).start('An answer');

for (const more of [' that arrives', ' a few words', ' at a time,', ' the way one does.']) {
	await sleep(180);
	streamed.append(more);
}

await sleep(500);
streamed.done();
