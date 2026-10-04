/**
 * A decrypt effect: text that arrives unreadable and resolves into itself.
 *
 *   node demos/components/09-decrypt.js
 *   node demos/components/09-decrypt.js | cat     <- the same run, with no terminal
 *
 * Piped, there is nothing to animate, so each text is written once: six lines for
 * this run, because the fourth text is three of them. On a terminal each one
 * jumbles and then resolves, which at the durations below is about two seconds
 * each, so about a hundred and fifty frames rather than six lines. The same is
 * true under
 * `SIGIL_REDUCED_MOTION=reduce` on a real terminal, and under `NO_COLOR=1` the
 * de-emphasis goes with every other attribute -- what is left is the characters
 * changing, which is the whole effect.
 *
 * It reads no keys, so there is nothing here that needs a terminal on both sides.
 */
import { ASCII, decrypt, seeded } from '@ttylabs/sigil/components';

// a seed rather than `Math.random`, so that two runs of this file are the same
// run: every visible property of the effect comes out of the generator, which is
// why it is an option at all
const pace = { jumble: 700, random: seeded(1989), reveal: 1500 };

// the default alphabet is CP437's graphic characters, which is what nms masks
// with. Whitespace is never masked, so the shape of the line is legible from the
// first frame while not one word of it is
await decrypt('Setec Astronomy: too many secrets', pace);

// and one for a terminal that cannot be trusted with anything but ASCII, which is
// the same choice `DOTS` and `LINE` give a spinner
await decrypt('No more secrets, Marty.', { ...pace, alphabet: ASCII });

// a mask glyph is as wide as what it hides, so a line of two-column characters
// does not reflow while it decrypts and land back where it started. The wide half
// of the default alphabet is the fullwidth Latin forms
await decrypt('機密 — \u{1F1EC}\u{1F1E7} secrets \u{1F468}‍\u{1F469}‍\u{1F467}', pace);

// several lines are one text: the breaks are whitespace, so they stay where they
// are and the block keeps its shape throughout
await decrypt(
	['  ACCESS GRANTED', '  cooper, d.    ****  cleared', '  bishop, m.    ****  cleared'].join('\n'),
	pace
);
