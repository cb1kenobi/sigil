import {
	layoutField,
	lineEnd,
	lineStart,
	multiline,
	offsetIn,
	PromptError,
	text,
} from '../../src/components/prompt.js';
import { type ScreenHarness, screenSetup, tick } from './helpers.js';
import { describe, expect, it } from 'vitest';

/**
 * Starts a prompt and reports how it settled.
 *
 * The handler is attached before any key is sent, for the reason
 * `prompt.test.ts` records: a prompt can reject while `type()` is still
 * awaiting, and a promise that rejects before anything is listening is an
 * unhandled rejection.
 *
 * @param promise - The prompt.
 * @returns Its answer, or the error it rejected with.
 */
function settle<T>(promise: Promise<T>): Promise<{ error?: PromptError; value?: T }> {
	return promise.then(
		(value) => ({ value }),
		(error: PromptError) => ({ error })
	);
}

/** Sends keys one at a time, letting the prompt act on each. */
async function type(stdin: { send(chunk: string): void }, ...chunks: string[]) {
	for (const chunk of chunks) {
		stdin.send(chunk);
		await tick();
	}
}

/**
 * What the last frame drew in reverse video, which is what the caret marks.
 *
 * Read off the bytes rather than off the screen, because the screen model keeps
 * characters and the caret *is* styling.
 *
 * @param ui - The harness.
 * @returns What is under the caret, or nothing when none was drawn.
 */
function caret(ui: ScreenHarness): string {
	const out = ui.output;
	const at = out.lastIndexOf('\u001b[7m');
	if (at === -1) {
		return '';
	}
	const rest = out.slice(at + '\u001b[7m'.length);
	// eslint-disable-next-line no-control-regex
	const end = rest.search(/\u001b[[\]]/);
	return end === -1 ? rest : rest.slice(0, end);
}

/**
 * Which cell the caret was painted in, as a row and a column of the screen.
 *
 * A field's whole claim is a coordinate, so a test that only asked *what* is
 * under the caret could not see the derivation at all -- the cell holds the same
 * character whether or not a caret was drawn there, which is why the screen
 * model had to learn about reverse video.
 *
 * @param ui - The harness.
 * @returns The cell, or nothing when no caret was drawn.
 */
function caretAt(ui: ScreenHarness): { column: number; row: number } | undefined {
	return ui.screen.lastInverse;
}

/**
 * The rows of the field, which start two columns in under the question.
 *
 * Every test that reads this uses a terminal wide enough for the question and
 * its hint to fit on one row, so the field starts on the second. Which is also
 * why the wrapping claims are made against `layoutField()` instead: narrowing
 * the terminal to force a wrap wraps the *question* too, and then a test is
 * counting rows of something it is not about.
 */
function fieldRows(ui: ScreenHarness): string[] {
	return ui.log.slice(1).map((row) => row.slice(2));
}

const ENTER = '\r';
const CTRL_C = '\u0003';
const CTRL_D = '\u0004';
const CTRL_A = '\u0001';
const CTRL_E = '\u0005';
const CTRL_K = '\u000b';
const CTRL_U = '\u0015';
const CTRL_W = '\u0017';
const UP = '\u001b[A';
const DOWN = '\u001b[B';
const LEFT = '\u001b[D';
const RIGHT = '\u001b[C';
const CTRL_LEFT = '\u001b[1;5D';
const CTRL_RIGHT = '\u001b[1;5C';
const CTRL_HOME = '\u001b[1;5H';
const CTRL_END = '\u001b[1;5F';
const HOME = '\u001b[H';
const END = '\u001b[F';
const BACKSPACE = '\u007f';
const DELETE = '\u001b[3~';
const PAGEUP = '\u001b[5~';
const PAGEDOWN = '\u001b[6~';
const ALT_D = '\u001bd';
const ALT_B = '\u001bb';
const ALT_F = '\u001bf';
const ALT_BACKSPACE = '\u001b\u007f';
const PASTE_START = '\u001b[200~';
const PASTE_END = '\u001b[201~';

describe('multiline()', () => {
	describe('submitting', () => {
		it('should return what was typed', async () => {
			const ui = screenSetup();
			const answer = multiline({ ansi: ui.ansi, message: 'Why?', terminal: ui.terminal });

			await type(ui.stdin, 'h', 'i', CTRL_D);

			expect(await answer).to.equal('hi');
		});

		it('should insert a newline on enter rather than submitting', async () => {
			const ui = screenSetup();
			const answer = multiline({ ansi: ui.ansi, message: 'Why?', terminal: ui.terminal });

			await type(ui.stdin, 'a', ENTER, 'b', CTRL_D);

			expect(await answer).to.equal('a\nb');
		});

		it('should take the key the caller named, and say which it is', async () => {
			const ui = screenSetup();
			const answer = multiline({
				ansi: ui.ansi,
				message: 'Why?',
				submit: { meta: true, name: 'enter' },
				terminal: ui.terminal,
			});

			await type(ui.stdin, 'a');
			expect(ui.log[0]).to.contain('(alt-enter to submit)');

			await type(ui.stdin, '\u001b\r');

			expect(await answer).to.equal('a');
		});

		it('should leave ctrl-d an abort when the caller named another key', async () => {
			// the claim is `claims()`'s and not the key's: a field that said yes to
			// Ctrl-D whatever its submit key was would be answering for a key nothing
			// in it reads
			const ui = screenSetup();
			const answer = settle(
				multiline({
					ansi: ui.ansi,
					message: 'Why?',
					submit: { meta: true, name: 'enter' },
					terminal: ui.terminal,
				})
			);

			await type(ui.stdin, 'a', CTRL_D);

			expect((await answer).error?.aborted).to.equal(true);
		});

		it('should claim ctrl-d back from the abort rule, which would take it first', async () => {
			const ui = screenSetup();
			const answer = settle(multiline({ ansi: ui.ansi, message: 'Why?', terminal: ui.terminal }));

			await type(ui.stdin, 'x', CTRL_D);

			expect(await answer).to.deep.equal({ value: 'x' });
		});

		it('should still abort on ctrl-c, which no field may claim', async () => {
			const ui = screenSetup();
			const answer = settle(multiline({ ansi: ui.ansi, message: 'Why?', terminal: ui.terminal }));

			await type(ui.stdin, 'x', CTRL_C);

			expect((await answer).error?.aborted).to.equal(true);
		});

		it('should leave ctrl-d an abort for the single-line field beside it', async () => {
			// the claim is per prompt, so the one prompt that asks for it must not have
			// changed the answer for the four that do not
			const ui = screenSetup();
			const answer = settle(text({ ansi: ui.ansi, message: 'Name?', terminal: ui.terminal }));

			await type(ui.stdin, 'x', CTRL_D);

			expect((await answer).error?.aborted).to.equal(true);
		});

		it('should start from the initial value with the caret past it', async () => {
			const ui = screenSetup();
			const answer = multiline({
				ansi: ui.ansi,
				initial: 'one\ntwo',
				message: 'Why?',
				terminal: ui.terminal,
			});

			await type(ui.stdin, '!', CTRL_D);

			expect(await answer).to.equal('one\ntwo!');
		});

		it('should normalize the line endings of an initial value', async () => {
			const ui = screenSetup();
			const answer = multiline({
				ansi: ui.ansi,
				initial: 'a\r\nb\rc',
				message: 'Why?',
				terminal: ui.terminal,
			});

			await type(ui.stdin, CTRL_D);

			expect(await answer).to.equal('a\nb\nc');
		});

		it('should take a control character out of an initial value', async () => {
			// through the same normalizer a paste goes through, so the answer cannot
			// hold something no key and no paste could have put there
			const ui = screenSetup();
			const answer = multiline({
				ansi: ui.ansi,
				initial: 'a\u0001b',
				message: 'Why?',
				terminal: ui.terminal,
			});

			await type(ui.stdin, CTRL_D);

			expect(await answer).to.equal('ab');
		});

		it('should refuse an answer a validator rejects and keep asking', async () => {
			const ui = screenSetup();
			const answer = multiline({
				ansi: ui.ansi,
				message: 'Why?',
				terminal: ui.terminal,
				validate: (value) => (value.includes('\n') ? false : 'Two lines, please'),
			});

			await type(ui.stdin, 'a', CTRL_D);
			expect(ui.log.join('\n')).to.contain('Two lines, please');

			await type(ui.stdin, ENTER, 'b', CTRL_D);

			expect(await answer).to.equal('a\nb');
		});

		it('should submit an empty answer rather than reading it as end of input', async () => {
			// a submit key that means two things depending on invisible state is the
			// trap the binding order exists to prevent, one key along
			const ui = screenSetup();
			const answer = settle(multiline({ ansi: ui.ansi, message: 'Why?', terminal: ui.terminal }));

			await type(ui.stdin, CTRL_D);

			expect(await answer).to.deep.equal({ value: '' });
		});
	});

	describe('drawing', () => {
		it('should draw the lines it was given on rows of their own', async () => {
			const ui = screenSetup();
			const answer = multiline({
				ansi: ui.ansi,
				initial: 'one\ntwo\nthree',
				message: 'Why?',
				terminal: ui.terminal,
			});

			await type(ui.stdin, 'x');
			expect(fieldRows(ui)).to.deep.equal(['one', 'two', 'threex']);

			await type(ui.stdin, CTRL_D);
			await answer;
		});

		it('should soft wrap a line too wide for the field without touching the value', async () => {
			const ui = screenSetup();
			// forty columns less the two-column indent is thirty-eight, and the caret
			// takes one of those, so the field wraps at thirty-seven
			const typed = 'aaaa bbbb cccc dddd eeee ffff gggg hhhh';
			const answer = multiline({
				ansi: ui.ansi,
				initial: typed,
				message: 'Hm',
				terminal: ui.terminal,
			});

			await type(ui.stdin, CTRL_HOME);
			expect(fieldRows(ui)).to.deep.equal(['aaaa bbbb cccc dddd eeee ffff gggg', 'hhhh']);

			await type(ui.stdin, CTRL_D);

			// the break is the field's and never the value's, which is the whole of
			// "soft wrap only"
			expect(await answer).to.equal(typed);
		});

		it('should draw a tab as a space, which is what every other text draws', async () => {
			const ui = screenSetup();
			const answer = multiline({
				ansi: ui.ansi,
				initial: 'a\tb',
				message: 'Why?',
				terminal: ui.terminal,
			});

			await type(ui.stdin, LEFT);
			expect(fieldRows(ui)[0]).to.equal('a b');

			await type(ui.stdin, CTRL_D);
			// and the value keeps the tab: what is drawn is not what was typed
			expect(await answer).to.equal('a\tb');
		});

		it('should draw nothing for a cluster with no cell', async () => {
			// a lone combining mark is zero columns, and the grid refuses one a cell
			// rather than giving it one -- so the field has to place it without
			// painting it, or the characters after it come out a column to the left
			const ui = screenSetup();
			const answer = multiline({
				ansi: ui.ansi,
				initial: '́ab',
				message: 'Why?',
				terminal: ui.terminal,
			});

			await type(ui.stdin, LEFT);
			expect(fieldRows(ui)[0]).to.equal('ab');

			await type(ui.stdin, CTRL_D);
			expect(await answer).to.equal('́ab');
		});

		it('should show the placeholder until something is typed', async () => {
			const ui = screenSetup();
			const answer = multiline({
				ansi: ui.ansi,
				message: 'Why?',
				placeholder: 'say something',
				terminal: ui.terminal,
			});

			await type(ui.stdin, LEFT);
			expect(fieldRows(ui)[0]).to.equal('say something');

			await type(ui.stdin, 'a');
			expect(fieldRows(ui)[0]).to.equal('a');

			await type(ui.stdin, BACKSPACE);
			expect(fieldRows(ui)[0]).to.equal('say something');

			await type(ui.stdin, 'a', CTRL_D);
			expect(await answer).to.equal('a');
		});

		it('should not let a key worked out against the placeholder reach the value', async () => {
			// the rows describe the placeholder while the value is empty, so an offset
			// read off one of them is an offset into the wrong string
			const ui = screenSetup();
			const answer = multiline({
				ansi: ui.ansi,
				message: 'Why?',
				placeholder: 'a much longer hint than the answer',
				terminal: ui.terminal,
			});

			await type(ui.stdin, END, DOWN, CTRL_E, 'x', CTRL_D);

			expect(await answer).to.equal('x');
		});

		it('should leave one line in the log and say how many it is standing for', async () => {
			const ui = screenSetup();
			const answer = multiline({
				ansi: ui.ansi,
				initial: 'first\nsecond\nthird',
				message: 'Why?',
				terminal: ui.terminal,
			});

			await type(ui.stdin, CTRL_D);
			await answer;

			expect(ui.log).to.have.length(1);
			expect(ui.log[0]).to.contain('first (+2 more lines)');
		});

		it('should say "line" for one more and not "lines"', async () => {
			const ui = screenSetup();
			const answer = multiline({
				ansi: ui.ansi,
				initial: 'a\nb',
				message: 'Why?',
				terminal: ui.terminal,
			});

			await type(ui.stdin, CTRL_D);
			await answer;

			expect(ui.log[0]).to.contain('a (+1 more line)');
		});

		it('should say so rather than nothing for an empty answer', async () => {
			const ui = screenSetup();
			const answer = multiline({ ansi: ui.ansi, message: 'Why?', terminal: ui.terminal });

			await type(ui.stdin, CTRL_D);
			await answer;

			expect(ui.log[0]).to.contain('(empty)');
		});
	});

	describe('the caret', () => {
		it('should be drawn on the cluster at the cursor', async () => {
			const ui = screenSetup();
			const answer = multiline({
				ansi: ui.ansi,
				colorLevel: 1,
				initial: 'ab',
				message: 'Hm',
				terminal: ui.terminal,
			});

			await type(ui.stdin, LEFT);
			expect(caret(ui)).to.equal('b');
			expect(caretAt(ui)).to.deep.equal({ column: 3, row: 1 });

			await type(ui.stdin, LEFT);
			expect(caret(ui)).to.equal('a');
			expect(caretAt(ui)).to.deep.equal({ column: 2, row: 1 });

			await type(ui.stdin, CTRL_D);
			await answer;
		});

		it('should be a column of its own past the last cluster', async () => {
			const ui = screenSetup();
			const answer = multiline({
				ansi: ui.ansi,
				colorLevel: 1,
				initial: 'ab',
				message: 'Hm',
				terminal: ui.terminal,
			});

			await type(ui.stdin, RIGHT);

			expect(caret(ui)).to.equal(' ');
			expect(caretAt(ui)).to.deep.equal({ column: 4, row: 1 });

			await type(ui.stdin, CTRL_D);
			await answer;
		});

		it('should move to the row the cursor is on', async () => {
			const ui = screenSetup();
			const answer = multiline({
				ansi: ui.ansi,
				colorLevel: 1,
				initial: 'ab\ncd',
				message: 'Hm',
				terminal: ui.terminal,
			});

			await type(ui.stdin, UP);
			expect(caretAt(ui)?.row).to.equal(1);

			await type(ui.stdin, DOWN);
			expect(caretAt(ui)?.row).to.equal(2);

			await type(ui.stdin, CTRL_D);
			await answer;
		});

		it('should mark a newline as a blank at the end of its line', async () => {
			const ui = screenSetup();
			const answer = multiline({
				ansi: ui.ansi,
				colorLevel: 1,
				initial: 'ab\ncd',
				message: 'Hm',
				terminal: ui.terminal,
			});

			await type(ui.stdin, CTRL_HOME, END);

			expect(caret(ui)).to.equal(' ');
			expect(caretAt(ui)).to.deep.equal({ column: 4, row: 1 });

			await type(ui.stdin, CTRL_D);
			await answer;
		});

		it('should mark a wide cluster whole', async () => {
			const ui = screenSetup();
			const answer = multiline({
				ansi: ui.ansi,
				colorLevel: 1,
				initial: '日本',
				message: 'Hm',
				terminal: ui.terminal,
			});

			await type(ui.stdin, LEFT);
			expect(caret(ui)).to.equal('本');
			expect(caretAt(ui)).to.deep.equal({ column: 4, row: 1 });

			await type(ui.stdin, CTRL_D);
			await answer;
		});

		it('should draw none at all where there are no attributes to draw it with', async () => {
			// level 0 drops the seven attributes, so a reverse-video caret is the one
			// sequence `NO_COLOR` could not switch off. The field is still editable
			const ui = screenSetup();
			const answer = multiline({
				ansi: ui.ansi,
				colorLevel: 0,
				initial: 'ab',
				message: 'Hm',
				terminal: ui.terminal,
			});

			await type(ui.stdin, LEFT, 'x');

			expect(caret(ui)).to.equal('');
			await type(ui.stdin, CTRL_D);
			expect(await answer).to.equal('axb');
		});

		it('should go once the prompt is answered', async () => {
			const ui = screenSetup();
			const answer = multiline({
				ansi: ui.ansi,
				colorLevel: 1,
				initial: 'ab',
				message: 'Hm',
				terminal: ui.terminal,
			});

			await type(ui.stdin, LEFT);
			expect(caretAt(ui)).to.not.equal(undefined);
			const was = ui.output.length;

			await type(ui.stdin, CTRL_D);
			await answer;

			expect(ui.output.slice(was)).to.not.contain('\u001b[7m');
		});
	});

	describe('moving', () => {
		it('should step over a whole cluster, never half a surrogate pair', async () => {
			const ui = screenSetup();
			const answer = multiline({
				ansi: ui.ansi,
				initial: 'a\u{1f600}b',
				message: 'Hm',
				terminal: ui.terminal,
			});

			// left over the `b`, left over the emoji, then insert: a cursor that had
			// walked code units would be between the surrogates
			await type(ui.stdin, LEFT, LEFT, '!', CTRL_D);

			expect(await answer).to.equal('a!\u{1f600}b');
		});

		it('should delete a whole cluster backwards', async () => {
			const ui = screenSetup();
			const answer = multiline({
				ansi: ui.ansi,
				initial: 'a\u{1f600}',
				message: 'Hm',
				terminal: ui.terminal,
			});

			await type(ui.stdin, BACKSPACE, CTRL_D);

			expect(await answer).to.equal('a');
		});

		it('should delete a whole cluster forwards', async () => {
			const ui = screenSetup();
			const answer = multiline({
				ansi: ui.ansi,
				initial: '\u{1f600}a',
				message: 'Hm',
				terminal: ui.terminal,
			});

			await type(ui.stdin, CTRL_HOME, DELETE, CTRL_D);

			expect(await answer).to.equal('a');
		});

		it('should join two lines with a backspace at the start of one', async () => {
			const ui = screenSetup();
			const answer = multiline({
				ansi: ui.ansi,
				initial: 'ab\ncd',
				message: 'Hm',
				terminal: ui.terminal,
			});

			await type(ui.stdin, HOME, BACKSPACE, CTRL_D);

			expect(await answer).to.equal('abcd');
		});

		it('should split a line with enter in the middle of one', async () => {
			const ui = screenSetup();
			const answer = multiline({
				ansi: ui.ansi,
				initial: 'abcd',
				message: 'Hm',
				terminal: ui.terminal,
			});

			await type(ui.stdin, LEFT, LEFT, ENTER, CTRL_D);

			expect(await answer).to.equal('ab\ncd');
		});

		it('should go to the ends of the whole value with the modifier held', async () => {
			const ui = screenSetup();
			const answer = multiline({
				ansi: ui.ansi,
				initial: 'ab\ncd',
				message: 'Hm',
				terminal: ui.terminal,
			});

			await type(ui.stdin, CTRL_HOME, '<', CTRL_END, '>', CTRL_D);

			expect(await answer).to.equal('<ab\ncd>');
		});

		it('should answer ctrl-a and ctrl-e the way home and end do', async () => {
			const ui = screenSetup();
			const answer = multiline({
				ansi: ui.ansi,
				initial: 'ab\ncd',
				message: 'Hm',
				terminal: ui.terminal,
			});

			await type(ui.stdin, CTRL_A, '<', CTRL_E, '>', CTRL_D);

			expect(await answer).to.equal('ab\n<cd>');
		});

		it('should take home and end to the ends of the line and not of the value', async () => {
			const ui = screenSetup();
			const answer = multiline({
				ansi: ui.ansi,
				initial: 'ab\ncd\nef',
				message: 'Hm',
				terminal: ui.terminal,
			});

			await type(ui.stdin, UP, HOME, '<', END, '>', CTRL_D);

			expect(await answer).to.equal('ab\n<cd>\nef');
		});

		describe('a remembered goal column', () => {
			it('should come back to the column it started in through a short line', async () => {
				// the one thing every editor gets right and every from-scratch textarea
				// gets wrong: with the goal forgotten, Up-Up-Down drifts left
				const ui = screenSetup();
				const answer = multiline({
					ansi: ui.ansi,
					initial: 'abcdef\nxy\nghijkl',
					message: 'Hm',
					terminal: ui.terminal,
				});

				// from the end of the last line -- column 6 -- up over the short line and
				// back down
				await type(ui.stdin, UP, UP, DOWN, DOWN, '!', CTRL_D);

				expect(await answer).to.equal('abcdef\nxy\nghijkl!');
			});

			it('should be a column and not an offset, which a wide cluster tells apart', async () => {
				// `日本語` is three clusters and six columns, so a goal kept as an offset
				// lands three columns short
				const ui = screenSetup();
				const answer = multiline({
					ansi: ui.ansi,
					initial: '日本語\nabcdef',
					message: 'Hm',
					terminal: ui.terminal,
				});

				await type(ui.stdin, UP, '!', CTRL_D);

				expect(await answer).to.equal('日本語!\nabcdef');
			});

			it('should land on a wide cluster rather than between its halves', async () => {
				const ui = screenSetup();
				const answer = multiline({
					ansi: ui.ansi,
					initial: '日本語\nabcde',
					message: 'Hm',
					terminal: ui.terminal,
				});

				// column 3 on the second line is the `d`; on the first it is the far half
				// of `本`, and the caret belongs on `本`
				await type(ui.stdin, CTRL_HOME, DOWN, RIGHT, RIGHT, RIGHT, UP, '!', CTRL_D);

				expect(await answer).to.equal('日!本語\nabcde');
			});

			it('should give the goal up the moment something else moves the caret', async () => {
				const ui = screenSetup();
				const answer = multiline({
					ansi: ui.ansi,
					initial: 'abcdef\nxy\nghijkl',
					message: 'Hm',
					terminal: ui.terminal,
				});

				// Up lands on the short line's newline at column 2, Left gives the goal
				// up, and the Up after it aims at column 1 rather than at the 6 the
				// first Up was still carrying
				await type(ui.stdin, UP, LEFT, UP, '!', CTRL_D);

				expect(await answer).to.equal('a!bcdef\nxy\nghijkl');
			});

			it('should move across the rows of one soft-wrapped line', async () => {
				const ui = screenSetup();
				// one logical line over two rows, so Up and Down move between rows the
				// value knows nothing about -- which is what makes the goal a *display*
				// column rather than anything to do with lines
				const answer = multiline({
					ansi: ui.ansi,
					initial: 'aaaa bbbb cccc dddd eeee ffff gggg hhhh',
					message: 'Hm',
					terminal: ui.terminal,
				});

				// the rows are 34 and 4 columns wide; the caret starts past the last `h`
				// at column 4 on the second row, so Up aims at column 4 of the first
				await type(ui.stdin, UP, '!', CTRL_D);

				expect(await answer).to.equal('aaaa! bbbb cccc dddd eeee ffff gggg hhhh');
			});

			it('should land on the ends of the value past the first and last rows', async () => {
				const ui = screenSetup();
				const answer = multiline({
					ansi: ui.ansi,
					initial: 'abc\ndef',
					message: 'Hm',
					terminal: ui.terminal,
				});

				await type(ui.stdin, UP, UP, '<', CTRL_D);
				expect(await answer).to.equal('<abc\ndef');
			});

			it('should land on the end of the value past the last row', async () => {
				const ui = screenSetup();
				const answer = multiline({
					ansi: ui.ansi,
					initial: 'abc\ndef',
					message: 'Hm',
					terminal: ui.terminal,
				});

				await type(ui.stdin, CTRL_HOME, DOWN, DOWN, '>', CTRL_D);
				expect(await answer).to.equal('abc\ndef>');
			});

			it('should page by the rows on screen', async () => {
				const ui = screenSetup({ rows: 20 });
				const answer = multiline({
					ansi: ui.ansi,
					initial: '1\n2\n3\n4\n5\n6\n7\n8',
					message: 'Hm',
					rows: 4,
					terminal: ui.terminal,
				});

				// four rows on screen, so a page is four lines up from the eighth
				await type(ui.stdin, PAGEUP, '!', CTRL_D);
				expect(await answer).to.equal('1\n2\n3\n4!\n5\n6\n7\n8');
			});

			it('should keep the goal across a page as it does across a step', async () => {
				const ui = screenSetup({ rows: 20 });
				const answer = multiline({
					ansi: ui.ansi,
					initial: 'abcdef\nx\nabcdef\nx\nabcdef',
					message: 'Hm',
					rows: 2,
					terminal: ui.terminal,
				});

				await type(ui.stdin, PAGEUP, PAGEUP, PAGEDOWN, PAGEDOWN, '!', CTRL_D);
				expect(await answer).to.equal('abcdef\nx\nabcdef\nx\nabcdef!');
			});
		});

		describe('word-wise', () => {
			it('should step back over a word', async () => {
				const ui = screenSetup();
				const answer = multiline({
					ansi: ui.ansi,
					initial: 'one two three',
					message: 'Hm',
					terminal: ui.terminal,
				});

				await type(ui.stdin, CTRL_LEFT, CTRL_LEFT, '!', CTRL_D);

				expect(await answer).to.equal('one !two three');
			});

			it('should step forward to the end of a word', async () => {
				const ui = screenSetup();
				const answer = multiline({
					ansi: ui.ansi,
					initial: 'one two three',
					message: 'Hm',
					terminal: ui.terminal,
				});

				await type(ui.stdin, CTRL_HOME, CTRL_RIGHT, CTRL_RIGHT, '!', CTRL_D);

				expect(await answer).to.equal('one two! three');
			});

			it('should cross a line break, because a break is whitespace', async () => {
				const ui = screenSetup();
				const answer = multiline({
					ansi: ui.ansi,
					initial: 'one\ntwo',
					message: 'Hm',
					terminal: ui.terminal,
				});

				// from the end, back over `two` and then back over the break onto `one`
				await type(ui.stdin, CTRL_LEFT, CTRL_LEFT, '!', CTRL_D);

				expect(await answer).to.equal('!one\ntwo');
			});

			it('should cross a line break going forward too', async () => {
				const ui = screenSetup();
				const answer = multiline({
					ansi: ui.ansi,
					initial: 'one\ntwo',
					message: 'Hm',
					terminal: ui.terminal,
				});

				await type(ui.stdin, CTRL_HOME, CTRL_RIGHT, CTRL_RIGHT, '!', CTRL_D);

				expect(await answer).to.equal('one\ntwo!');
			});

			it('should answer alt-b and alt-f the same way', async () => {
				const ui = screenSetup();
				const answer = multiline({
					ansi: ui.ansi,
					initial: 'one two',
					message: 'Hm',
					terminal: ui.terminal,
				});

				await type(ui.stdin, ALT_B, '<', ALT_F, '>', CTRL_D);

				expect(await answer).to.equal('one <two>');
			});

			it('should delete the word before the caret with ctrl-w', async () => {
				const ui = screenSetup();
				const answer = multiline({
					ansi: ui.ansi,
					initial: 'one two three',
					message: 'Hm',
					terminal: ui.terminal,
				});

				await type(ui.stdin, CTRL_W, CTRL_D);

				expect(await answer).to.equal('one two ');
			});

			it('should delete the word after the caret with alt-d', async () => {
				const ui = screenSetup();
				const answer = multiline({
					ansi: ui.ansi,
					initial: 'one two three',
					message: 'Hm',
					terminal: ui.terminal,
				});

				await type(ui.stdin, CTRL_HOME, ALT_D, CTRL_D);

				expect(await answer).to.equal(' two three');
			});

			it('should delete a word across a line break with alt-backspace', async () => {
				const ui = screenSetup();
				const answer = multiline({
					ansi: ui.ansi,
					initial: 'one\ntwo',
					message: 'Hm',
					terminal: ui.terminal,
				});

				await type(ui.stdin, ALT_BACKSPACE, ALT_BACKSPACE, CTRL_D);

				expect(await answer).to.equal('');
			});

			it('should take a whole cluster when a word ends in one', async () => {
				const ui = screenSetup();
				const answer = multiline({
					ansi: ui.ansi,
					initial: 'hi \u{1f600}\u{1f600}',
					message: 'Hm',
					terminal: ui.terminal,
				});

				await type(ui.stdin, CTRL_W, CTRL_D);

				expect(await answer).to.equal('hi ');
			});
		});

		describe('killing to the ends of a line', () => {
			it('should kill back to the start of the line with ctrl-u', async () => {
				const ui = screenSetup();
				const answer = multiline({
					ansi: ui.ansi,
					initial: 'keep\nthrow away',
					message: 'Hm',
					terminal: ui.terminal,
				});

				await type(ui.stdin, CTRL_U, CTRL_D);

				expect(await answer).to.equal('keep\n');
			});

			it('should kill forward to the end of the line with ctrl-k, leaving the break', async () => {
				const ui = screenSetup();
				const answer = multiline({
					ansi: ui.ansi,
					initial: 'throw away\nkeep',
					message: 'Hm',
					terminal: ui.terminal,
				});

				await type(ui.stdin, CTRL_HOME, CTRL_K, CTRL_D);

				expect(await answer).to.equal('\nkeep');
			});
		});
	});

	describe('a paste', () => {
		it('should keep the line breaks, which is the inverse of what text() does', async () => {
			const ui = screenSetup();
			const answer = multiline({ ansi: ui.ansi, message: 'Hm', terminal: ui.terminal });

			await type(ui.stdin, `${PASTE_START}one\ntwo${PASTE_END}`, CTRL_D);

			expect(await answer).to.equal('one\ntwo');
		});

		it('should flatten the same block in the single-line field beside it', async () => {
			// the inversion asserted as an inversion rather than as two claims: the
			// same bytes, the two fields, the two answers
			const ui = screenSetup();
			const answer = text({ ansi: ui.ansi, message: 'Hm', terminal: ui.terminal });

			await type(ui.stdin, `${PASTE_START}one\ntwo${PASTE_END}`, ENTER);

			expect(await answer).to.equal('one two');
		});

		it('should normalize CRLF, so the value holds one spelling of a break', async () => {
			const ui = screenSetup();
			const answer = multiline({ ansi: ui.ansi, message: 'Hm', terminal: ui.terminal });

			await type(ui.stdin, `${PASTE_START}one\r\ntwo\rthree${PASTE_END}`, CTRL_D);

			expect(await answer).to.equal('one\ntwo\nthree');
		});

		it('should keep a trailing newline, which is a break the person pasted', async () => {
			const ui = screenSetup();
			const answer = multiline({ ansi: ui.ansi, message: 'Hm', terminal: ui.terminal });

			await type(ui.stdin, `${PASTE_START}one\n${PASTE_END}`, CTRL_D);

			expect(await answer).to.equal('one\n');
		});

		it('should keep a tab, because dropping it takes the indentation out', async () => {
			const ui = screenSetup();
			const answer = multiline({ ansi: ui.ansi, message: 'Hm', terminal: ui.terminal });

			await type(ui.stdin, `${PASTE_START}if (x) {\n\treturn;\n}${PASTE_END}`, CTRL_D);

			expect(await answer).to.equal('if (x) {\n\treturn;\n}');
		});

		it('should drop a control character the way a typed one is dropped', async () => {
			const ui = screenSetup();
			const answer = multiline({ ansi: ui.ansi, message: 'Hm', terminal: ui.terminal });

			await type(ui.stdin, `${PASTE_START}a\u0085b${PASTE_END}`, CTRL_D);

			expect(await answer).to.equal('ab');
		});

		it('should land at the caret rather than at the end', async () => {
			const ui = screenSetup();
			const answer = multiline({
				ansi: ui.ansi,
				initial: 'ab',
				message: 'Hm',
				terminal: ui.terminal,
			});

			await type(ui.stdin, LEFT, `${PASTE_START}1\n2${PASTE_END}`, CTRL_D);

			expect(await answer).to.equal('a1\n2b');
		});

		it('should give the goal column up, which it moved the caret without reading', async () => {
			const ui = screenSetup();
			const answer = multiline({
				ansi: ui.ansi,
				initial: 'abcdef\nxy\nghijkl',
				message: 'Hm',
				terminal: ui.terminal,
			});

			// Up carries a goal of 6; the paste moves the caret to column 1 of the
			// short line, and the Up after it has to aim there rather than at 6
			await type(ui.stdin, UP, HOME, `${PASTE_START}z${PASTE_END}`, UP, '!', CTRL_D);

			expect(await answer).to.equal('a!bcdef\nzxy\nghijkl');
		});
	});

	describe('scrolling', () => {
		it('should grow with the value rather than reserving its rows', async () => {
			const ui = screenSetup();
			const answer = multiline({ ansi: ui.ansi, message: 'Hm', rows: 5, terminal: ui.terminal });

			await type(ui.stdin, 'a');
			expect(ui.log).to.have.length(2);

			await type(ui.stdin, ENTER, 'b');
			expect(ui.log).to.have.length(3);

			await type(ui.stdin, CTRL_D);
			await answer;
		});

		it('should show a window of a value taller than the field', async () => {
			const ui = screenSetup({ rows: 20 });
			const answer = multiline({
				ansi: ui.ansi,
				initial: '1\n2\n3\n4\n5\n6',
				message: 'Hm',
				rows: 3,
				terminal: ui.terminal,
			});

			await type(ui.stdin, LEFT);
			expect(fieldRows(ui)).to.deep.equal(['4', '5', '6']);

			await type(ui.stdin, CTRL_D);
			await answer;
		});

		it('should follow the caret up and back down', async () => {
			const ui = screenSetup({ rows: 20 });
			const answer = multiline({
				ansi: ui.ansi,
				colorLevel: 1,
				initial: '1\n2\n3\n4\n5\n6',
				message: 'Hm',
				rows: 3,
				terminal: ui.terminal,
			});

			await type(ui.stdin, UP, UP, UP);
			expect(fieldRows(ui)).to.deep.equal(['3', '4', '5']);
			// and the caret is on a row of the window rather than off the top of it
			expect(caretAt(ui)?.row).to.equal(1);

			await type(ui.stdin, CTRL_HOME);
			expect(fieldRows(ui)).to.deep.equal(['1', '2', '3']);
			expect(caretAt(ui)?.row).to.equal(1);

			await type(ui.stdin, CTRL_END);
			expect(fieldRows(ui)).to.deep.equal(['4', '5', '6']);
			expect(caretAt(ui)?.row).to.equal(3);

			await type(ui.stdin, CTRL_D);
			await answer;
		});

		it('should cap the rows by what the terminal has left under the question', async () => {
			// the cap is the smaller of what was asked for and what is there, and the
			// error line is reserved either way
			const ui = screenSetup({ rows: 5 });
			const answer = multiline({
				ansi: ui.ansi,
				initial: '1\n2\n3\n4\n5\n6',
				message: 'Hm',
				rows: 10,
				terminal: ui.terminal,
			});

			await type(ui.stdin, LEFT);
			expect(fieldRows(ui)).to.deep.equal(['4', '5', '6']);

			await type(ui.stdin, CTRL_D);
			await answer;
		});
	});
});

describe('layoutField()', () => {
	/**
	 * The rows as strings, which is what the field paints.
	 *
	 * Written into a grid by column rather than concatenated, because a cell is
	 * not a character: a wide cluster takes two columns, so appending leaves the
	 * next cell a column further along than the string is. Trailing blanks are
	 * kept -- they are the whitespace a break left on the row it ended, which is
	 * the one place this parts company with `wrap()`.
	 */
	function drawn(value: string, cursor: number, room: number): string[] {
		return layoutField(value, cursor, room).rows.map((row) => {
			let out = '';
			let column = 0;
			for (const cell of row.cells) {
				while (column < cell.x) {
					out += ' ';
					column++;
				}
				if (cell.width > 0) {
					out += cell.text;
					column += cell.width;
				}
			}
			return out;
		});
	}

	it('should put one row per line of the value', () => {
		expect(drawn('a\nbb\nccc', 0, 20)).to.deep.equal(['a', 'bb', 'ccc']);
	});

	it('should give a value ending in a newline a row after it', () => {
		// which is what you want after pressing Enter at the end: the caret goes to
		// a row that is there
		const layout = layoutField('a\n', 2, 20);
		expect(layout.rows).to.have.length(2);
		expect(layout.caret).to.deep.equal({ row: 1, text: ' ', x: 0 });
	});

	it('should give an empty value one row', () => {
		const layout = layoutField('', 0, 20);
		expect(layout.rows).to.have.length(1);
		expect(layout.caret).to.deep.equal({ row: 0, text: ' ', x: 0 });
	});

	it('should wrap at one column less than the room, keeping a column for the caret', () => {
		// ten columns of room is nine of text: `aaa bbb ccc` breaks after the second
		// word, and the caret past the last `c` lands at column three of the second
		// row, which is inside a ten-column box
		// the space between the two words stays on the row it ended, which is where
		// this parts company with `wrap()` and why: a space is an offset a caret has
		// to be able to sit on
		expect(drawn('aaa bbb ccc', 0, 10)).to.deep.equal(['aaa bbb ', 'ccc']);
		expect(layoutField('aaa bbb ccc', 11, 10).caret).to.deep.equal({ row: 1, text: ' ', x: 3 });
	});

	it('should break a word too long for a row of its own', () => {
		expect(drawn('abcdefghijkl', 0, 10)).to.deep.equal(['abcdefghi', 'jkl']);
	});

	it('should keep the leading whitespace of a line, which is its indentation', () => {
		expect(drawn('  ab cd', 0, 6)).to.deep.equal(['  ab ', 'cd']);
	});

	it('should wrap by columns rather than by characters', () => {
		// `日本語` is three clusters and six columns, so a six-column limit holds all
		// three and a five-column one holds two
		expect(drawn('日本語', 0, 7)).to.deep.equal(['日本語']);
		expect(drawn('日本語', 0, 6)).to.deep.equal(['日本', '語']);
	});

	it('should keep every offset of the value on exactly one row', () => {
		// the property the caret derivation rests on: a cluster the layout dropped
		// is an offset the caret cannot be put at, and a cluster on two rows is an
		// offset with two answers
		for (const value of [
			'aaa bbb ccc',
			'aaa  bbb',
			'a\n\nb',
			'  indented\ttab',
			'日本語 abc',
			'a\u{1f600}b ćd',
			'word '.repeat(12),
			'',
			'\n',
		]) {
			for (const room of [1, 2, 4, 7, 12, 40]) {
				const seen: number[] = [];
				for (const row of layoutField(value, 0, room).rows) {
					for (const cell of row.cells) {
						seen.push(cell.at);
					}
				}
				const starts: number[] = [];
				let offset = 0;
				for (const cluster of new Intl.Segmenter().segment(value)) {
					starts.push(offset);
					offset += cluster.segment.length;
				}
				expect(seen, `${JSON.stringify(value)} at ${room}`).to.deep.equal(starts);
			}
		}
	});

	it('should keep the caret inside the box it reports, at every offset', () => {
		// the whole of what wrapping a column short buys, asserted as the property
		// rather than at the one offset a report came in on
		for (const value of [
			'aaa bbb ccc',
			'aaa   bbb',
			'trailing   ',
			'a\n\nbb',
			'日本語 abc',
			'abcdefghijkl',
			'',
		]) {
			for (const room of [1, 2, 3, 6, 10, 40]) {
				for (let cursor = 0; cursor <= value.length; cursor++) {
					const layout = layoutField(value, cursor, room);
					const where = `${JSON.stringify(value)} at ${room}, cursor ${cursor}`;
					expect(layout.caret.x, where).to.be.greaterThanOrEqual(0);
					expect(layout.caret.x, where).to.be.lessThan(layout.width);
					expect(layout.caret.row, where).to.be.greaterThanOrEqual(0);
					expect(layout.caret.row, where).to.be.lessThan(layout.rows.length);
				}
			}
		}
	});

	it('should ask for no more than the room it was given', () => {
		for (const room of [1, 2, 5, 9, 40]) {
			expect(
				layoutField('a long value with trailing space   ', 0, room).width
			).to.be.lessThanOrEqual(room);
		}
	});

	it('should ask for its content plus the caret where that fits', () => {
		expect(layoutField('abc', 3, 40).width).to.equal(4);
		expect(layoutField('', 0, 40).width).to.equal(1);
	});

	it('should give a cluster with no cell no columns', () => {
		// a control character draws as nothing and a tab draws as a space, which is
		// what `toDisplayText()` says and is what keeps the field from disagreeing
		// with every other text in the library
		const layout = layoutField('a\u0001\tb', 0, 20);
		expect(layout.rows[0].cells.map((cell) => [cell.text, cell.width, cell.x])).to.deep.equal([
			['a', 1, 0],
			['', 0, 1],
			[' ', 1, 1],
			['b', 1, 2],
		]);
	});

	it('should mark a cluster with no cell as a blank', () => {
		expect(layoutField('a\u0001b', 1, 20).caret).to.deep.equal({ row: 0, text: ' ', x: 1 });
	});

	it('should place a soft break at the start of the next row rather than past the last', () => {
		// `aaa bbb` and `ccc`: offset 8 is the first `c`, and a caret that marks the
		// cluster at the cursor is therefore on the second row
		expect(layoutField('aaa bbb ccc', 8, 10).caret).to.deep.equal({ row: 1, text: 'c', x: 0 });
		// and the space that ended the row above is the offset before it
		expect(layoutField('aaa bbb ccc', 7, 10).caret).to.deep.equal({ row: 0, text: ' ', x: 7 });
	});

	it('should share the wrap column between the spaces of a run that would overflow', () => {
		// declared rather than discovered: a run of whitespace at a break has
		// nowhere to go but the column the row ends at, and they are all blanks
		const layout = layoutField('ab     cd', 0, 6);
		expect(layout.rows.map((row) => row.cells.map((cell) => cell.x))).to.deep.equal([
			[0, 1, 2, 3, 4, 5, 5],
			[0, 1],
		]);
	});
});

describe('offsetIn()', () => {
	it('should take the last cluster at or before the column', () => {
		const layout = layoutField('abcdef\nxy', 0, 40);
		expect(offsetIn(layout, 9, 1, 0)).to.equal(7);
		expect(offsetIn(layout, 9, 1, 1)).to.equal(8);
	});

	it('should take the end of the value past the last row, and nothing else', () => {
		const layout = layoutField('abcdef\nxy', 0, 40);
		// the second row is the last, so aiming past it is the end of the value
		expect(offsetIn(layout, 9, 1, 9)).to.equal(9);
		// the first is not, and its end is the next row's start -- so aiming past it
		// stops on the newline, which is the last position the row has
		expect(offsetIn(layout, 9, 0, 9)).to.equal(6);
	});

	it('should land on a wide cluster rather than between its halves', () => {
		const layout = layoutField('日本語', 0, 40);
		expect(offsetIn(layout, 3, 0, 2)).to.equal(1);
		expect(offsetIn(layout, 3, 0, 3)).to.equal(1);
		expect(offsetIn(layout, 3, 0, 4)).to.equal(2);
	});

	it('should answer the start of an empty row', () => {
		const layout = layoutField('a\n\nb', 0, 40);
		expect(offsetIn(layout, 4, 1, 5)).to.equal(2);
	});

	it('should clamp a row outside the layout', () => {
		const layout = layoutField('ab', 0, 40);
		expect(offsetIn(layout, 2, -3, 0)).to.equal(0);
		expect(offsetIn(layout, 2, 9, 0)).to.equal(0);
	});
});

describe('the ends of a logical line', () => {
	it('should answer the whole value where there is no break in it', () => {
		expect(lineStart('abc', 2)).to.equal(0);
		expect(lineEnd('abc', 1)).to.equal(3);
	});

	it('should answer the line the offset is on', () => {
		const value = 'ab\ncd\nef';
		expect(lineStart(value, 4)).to.equal(3);
		expect(lineEnd(value, 4)).to.equal(5);
	});

	it('should put the end before the newline and not after it', () => {
		// so that End leaves the caret where the next character goes on *this* line
		// and Ctrl-K does not join two lines together
		expect(lineEnd('ab\ncd', 0)).to.equal(2);
	});

	it('should read an offset sitting on a newline as the end of the line before it', () => {
		const value = 'ab\ncd';
		expect(lineStart(value, 2)).to.equal(0);
		expect(lineEnd(value, 2)).to.equal(2);
	});

	it('should answer zero and the length at the ends', () => {
		expect(lineStart('ab\ncd', 0)).to.equal(0);
		expect(lineEnd('ab\ncd', 5)).to.equal(5);
		// and out of range rather than throwing, since a caller may hand one in
		expect(lineStart('ab', -4)).to.equal(0);
		expect(lineEnd('ab', -4)).to.equal(2);
	});

	it('should answer an empty line between two breaks', () => {
		expect(lineStart('a\n\nb', 2)).to.equal(2);
		expect(lineEnd('a\n\nb', 2)).to.equal(2);
	});
});
