import {
	confirm,
	ESCAPE_TIMEOUT,
	multiselect,
	password,
	PromptError,
	select,
	text,
} from '../../src/components/prompt.js';
import { createInput } from '../../src/input/index.js';
import { type ScreenHarness, screenSetup, tick } from './helpers.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Starts a prompt and reports how it settled.
 *
 * The handler is attached before any key is sent, which matters: a prompt can
 * reject while `type()` is still awaiting, and a promise that rejects before
 * anything is listening is an unhandled rejection -- which vitest reports as an
 * error even when every test passes. Awaiting the prompt only after the keys are
 * sent is the natural way to write these and the wrong one.
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
 * characters and not styling -- and the caret *is* styling. Every other claim a
 * prompt test makes is about the picture, which is what `ui.frame` answers.
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

const ENTER = '\r';
const CTRL_C = '\u0003';
const UP = '\u001b[A';
const DOWN = '\u001b[B';
const SPACE = ' ';
const LEFT = '\u001b[D';
const RIGHT = '\u001b[C';
const HOME = '\u001b[H';
const DELETE = '\u001b[3~';
const BACKSPACE = '\u007f';
const TAB = '\t';
const ESCAPE = '\u001b';
/** A terminal's bracketed-paste markers, which the input router reads. */
const PASTE_START = '\u001b[200~';
const PASTE_END = '\u001b[201~';
/** A CSI nothing names, for asserting that an unnamed key types nothing. */
const UNNAMED = '\u001b[202~';

describe('text()', () => {
	it('should return what was typed', async () => {
		const ui = screenSetup();
		const answer = text({ ansi: ui.ansi, message: 'Name?', terminal: ui.terminal });

		await type(ui.stdin, 'c', 'h', 'r', 'i', 's', ENTER);

		expect(await answer).to.equal('chris');
	});

	it('should read a chunk carrying several characters, as a paste does', async () => {
		const ui = screenSetup();
		const answer = text({ ansi: ui.ansi, message: 'Name?', terminal: ui.terminal });

		await type(ui.stdin, 'pasted text', ENTER);

		expect(await answer).to.equal('pasted text');
	});

	it('should fall back to the default on an empty answer', async () => {
		const ui = screenSetup();
		const answer = text({
			ansi: ui.ansi,
			default: 'anonymous',
			message: 'Name?',
			terminal: ui.terminal,
		});

		await type(ui.stdin, ENTER);

		expect(await answer).to.equal('anonymous');
	});

	it('should erase with backspace', async () => {
		const ui = screenSetup();
		const answer = text({ ansi: ui.ansi, message: 'Name?', terminal: ui.terminal });

		await type(ui.stdin, 'a', 'b', 'c', '\u007f', ENTER);

		expect(await answer).to.equal('ab');
	});

	it('should insert where the cursor is', async () => {
		const ui = screenSetup();
		const answer = text({ ansi: ui.ansi, message: 'Name?', terminal: ui.terminal });

		await type(ui.stdin, 'a', 'c', '\u001b[D', 'b', ENTER);

		expect(await answer).to.equal('abc');
	});

	it('should clear the line with ctrl-u', async () => {
		const ui = screenSetup();
		const answer = text({ ansi: ui.ansi, message: 'Name?', terminal: ui.terminal });

		await type(ui.stdin, 'throw away', '\u0015', 'kept', ENTER);

		expect(await answer).to.equal('kept');
	});

	it('should type a space', async () => {
		const ui = screenSetup();
		const answer = text({ ansi: ui.ansi, message: 'Name?', terminal: ui.terminal });

		await type(ui.stdin, 'a', SPACE, 'b', ENTER);

		expect(await answer).to.equal('a b');
	});

	// every named key used to type its own name: the test was whether the *name*
	// had a display width, and `up`, `tab`, `escape` and `unknown` all do
	it('should not type the name of a key that is not a character', async () => {
		const ui = screenSetup();
		const answer = text({ ansi: ui.ansi, message: 'Name?', terminal: ui.terminal });

		await type(ui.stdin, UP, DOWN, TAB, ESCAPE, UNNAMED, 'ok', ENTER);

		expect(await answer).to.equal('ok');
	});

	// without the markers a pasted block arrives as though it had been typed, so
	// a newline in the middle of an address is Enter and the prompt submits half
	// of it. A one-line field flattens the breaks rather than obeying them
	it('should take a bracketed paste whole, with its line breaks flattened', async () => {
		const ui = screenSetup();
		const answer = text({ ansi: ui.ansi, message: 'Name?', terminal: ui.terminal });

		await type(ui.stdin, 'a', PASTE_START, 'one\ntwo', PASTE_END, ENTER);

		expect(await answer).to.equal('aone two');
	});

	it('should drop the control characters a paste carries', async () => {
		const ui = screenSetup();
		const answer = text({ ansi: ui.ansi, message: 'Name?', terminal: ui.terminal });

		await type(ui.stdin, PASTE_START, 'a\u0007b', PASTE_END, ENTER);

		expect(await answer).to.equal('ab');
	});

	// the same test dropped what has no width, which is every combining mark
	it('should keep a combining mark, as an NFD paste carries', async () => {
		const ui = screenSetup();
		const answer = text({ ansi: ui.ansi, message: 'Name?', terminal: ui.terminal });

		await type(ui.stdin, 'cafe', '\u0301', ENTER);

		// NFD: the letter and the mark it carries, which is what was typed
		expect(await answer).to.equal('cafe\u0301');
	});

	it('should not type a key held with ctrl or alt', async () => {
		const ui = screenSetup();
		const answer = text({ ansi: ui.ansi, message: 'Name?', terminal: ui.terminal });

		// alt-b, then ctrl-b, neither of which this prompt binds
		await type(ui.stdin, 'a', '\u001bb', '\u0002', ENTER);

		expect(await answer).to.equal('a');
	});

	// the cursor used to move by a UTF-16 code unit, so a backspace over an emoji
	// left its high surrogate in the value and corrupted every edit after it
	it('should erase a whole astral character with backspace', async () => {
		const ui = screenSetup();
		const answer = text({ ansi: ui.ansi, message: 'Name?', terminal: ui.terminal });

		await type(ui.stdin, 'a', '😀', BACKSPACE, 'b', ENTER);

		expect(await answer).to.equal('ab');
	});

	it('should step over an astral character with the arrows', async () => {
		const ui = screenSetup();
		const answer = text({ ansi: ui.ansi, message: 'Name?', terminal: ui.terminal });

		await type(ui.stdin, '😀', 'z', LEFT, LEFT, 'x', RIGHT, 'y', ENTER);

		expect(await answer).to.equal('x😀yz');
	});

	it('should delete a whole astral character forwards', async () => {
		const ui = screenSetup();
		const answer = text({ ansi: ui.ansi, message: 'Name?', terminal: ui.terminal });

		await type(ui.stdin, '😀', 'b', HOME, DELETE, ENTER);

		expect(await answer).to.equal('b');
	});

	// a cluster is what a reader calls a character, so backspace takes the mark
	// and what it sits on together -- here an emoji, which the old cursor cut in
	// half and left a lone surrogate under the mark
	it('should erase a combining mark with the character it modifies', async () => {
		const ui = screenSetup();
		const answer = text({ ansi: ui.ansi, message: 'Name?', terminal: ui.terminal });

		await type(ui.stdin, '😀', '\u0301', BACKSPACE, 'x', ENTER);

		expect(await answer).to.equal('x');
	});

	// an insertion is the one edit that does not move by whole clusters: a mark
	// with nothing before it is its own cluster, and the letter typed in front of
	// it joins that cluster rather than making one of its own
	it('should stay on a boundary when what is typed joins the cluster after it', async () => {
		const ui = screenSetup();
		const answer = text({ ansi: ui.ansi, message: 'Name?', terminal: ui.terminal });

		await type(ui.stdin, '\u0301', LEFT, 'a', BACKSPACE, 'ok', ENTER);

		expect(await answer).to.equal('ok');
	});

	// the arrows moved an index nothing drew: Left, Right, Home and End all
	// changed where the next character would land and nothing on screen said so
	// until that character was typed
	describe('the caret', () => {
		it('should draw a caret where the next character goes', async () => {
			const ui = screenSetup();
			const answer = text({ colorLevel: 1, message: 'Name?', terminal: ui.terminal });

			// past the last character there is nothing to mark, so the caret is a
			// column of its own
			await type(ui.stdin, 'ab');
			// the screen model trims what a row ends in, so the caret's own column
			// is read off the styling rather than off the picture
			expect(ui.frame).to.equal('? Name? ab');
			expect(caret(ui)).to.equal(' ');

			await type(ui.stdin, ENTER);
			expect(await answer).to.equal('ab');
		});

		it('should repaint when only the cursor moved', async () => {
			const ui = screenSetup();
			const answer = text({ colorLevel: 1, message: 'Name?', terminal: ui.terminal });

			await type(ui.stdin, 'ab');

			// nothing was typed and the screen still has to change
			await type(ui.stdin, LEFT);
			expect(caret(ui)).to.equal('b');

			await type(ui.stdin, HOME);
			expect(caret(ui)).to.equal('a');

			await type(ui.stdin, ENTER);
			expect(await answer).to.equal('ab');
		});

		// the caret marks what the terminal draws as one character, so a wide one
		// is reversed over both its columns rather than cut in half
		it('should mark a whole cluster rather than a code unit', async () => {
			const ui = screenSetup();
			const answer = text({ colorLevel: 1, message: 'Name?', terminal: ui.terminal });

			await type(ui.stdin, '\u{1f600}', 'z', HOME);
			expect(caret(ui)).to.equal('\u{1f600}');
			expect(ui.frame).to.equal('? Name? \u{1f600}z');

			await type(ui.stdin, ENTER);
			expect(await answer).to.equal('\u{1f600}z');
		});

		it('should show a caret before anything has been typed', async () => {
			const ui = screenSetup();
			const answer = text({
				colorLevel: 1,
				message: 'Name?',
				placeholder: 'your name',
				terminal: ui.terminal,
			});

			await tick();
			expect(caret(ui)).to.equal('y');

			await type(ui.stdin, ENTER);
			await answer;
		});

		it('should show a caret with nothing to stand in for the answer', async () => {
			const ui = screenSetup();
			const answer = text({ colorLevel: 1, message: 'Name?', terminal: ui.terminal });

			await tick();
			expect(caret(ui)).to.equal(' ');

			await type(ui.stdin, ENTER);
			await answer;
		});

		// a styler asked for plain text draws no caret, deliberately: the same
		// setting takes the bold message and the dimmed placeholder with it, and a
		// prompt asked for plain text gets plain text rather than the one sequence
		// the library decided was too important to turn off
		it('should draw no caret at all where there is no styling', async () => {
			const ui = screenSetup();
			const answer = text({ colorLevel: 0, message: 'Name?', terminal: ui.terminal });

			await type(ui.stdin, 'ab');
			expect(ui.output).to.not.contain('\u001b[7m');

			await type(ui.stdin, ENTER);
			expect(await answer).to.equal('ab');
		});

		// the mask is a column count rather than a substitution, so the caret is
		// placed in the masked text rather than in the value it stands for
		it('should put the caret on the mask, not on what it hides', async () => {
			const ui = screenSetup();
			const answer = password({ colorLevel: 1, message: 'Password?', terminal: ui.terminal });

			await type(ui.stdin, 'abc', LEFT);
			expect(ui.frame).to.equal('? Password? \u2022\u2022\u2022');
			expect(caret(ui)).to.equal('\u2022');

			await type(ui.stdin, ENTER);
			expect(await answer).to.equal('abc');
		});

		it('should cover every column a masked character takes', async () => {
			const ui = screenSetup();
			const answer = password({ colorLevel: 1, message: 'Password?', terminal: ui.terminal });

			// one bullet for the `a`, then two for the emoji's two columns, both
			// under the one caret
			await type(ui.stdin, 'a', '\u{1f600}', LEFT);
			expect(caret(ui)).to.equal('\u2022\u2022');

			await type(ui.stdin, ENTER);
			expect(await answer).to.equal('a\u{1f600}');
		});
	});

	describe('validation', () => {
		it('should refuse an answer and say why', async () => {
			const ui = screenSetup();
			const answer = text({
				ansi: ui.ansi,
				message: 'Port?',
				terminal: ui.terminal,
				validate: (value) => (/^\d+$/.test(value) ? undefined : 'Numbers only'),
			});

			await type(ui.stdin, 'abc', ENTER);
			expect(ui.log.join('\n')).to.contain('Numbers only');

			await type(ui.stdin, '\u0015', '8080', ENTER);
			expect(await answer).to.equal('8080');
		});

		it('should take an async validator', async () => {
			const ui = screenSetup();
			const answer = text({
				ansi: ui.ansi,
				message: 'Name?',
				terminal: ui.terminal,
				validate: async (value) => (value === 'taken' ? 'Already taken' : undefined),
			});

			await type(ui.stdin, 'taken', ENTER);
			await type(ui.stdin, '\u0015', 'free', ENTER);

			expect(await answer).to.equal('free');
		});
	});

	it('should show the placeholder until something is typed', async () => {
		const ui = screenSetup();
		const answer = text({
			ansi: ui.ansi,
			message: 'Name?',
			placeholder: 'your name',
			terminal: ui.terminal,
		});

		await tick();
		expect(ui.frame).to.contain('your name');

		await type(ui.stdin, 'x');
		expect(ui.frame).to.not.contain('your name');
		expect(ui.frame).to.contain('x');

		await type(ui.stdin, ENTER);
		await answer;
	});
});

describe('password()', () => {
	it('should keep an astral character whole behind the mask', async () => {
		const ui = screenSetup();
		const answer = password({ ansi: ui.ansi, message: 'Password?', terminal: ui.terminal });

		await type(ui.stdin, 'a', '😀');
		// the mask is a column count, so a two-column emoji is two bullets
		expect(ui.frame).to.contain('•••');

		await type(ui.stdin, BACKSPACE, ENTER);

		expect(await answer).to.equal('a');
	});

	it('should not show what was typed', async () => {
		const ui = screenSetup();
		const answer = password({ ansi: ui.ansi, message: 'Password?', terminal: ui.terminal });

		await type(ui.stdin, 'hunter2', ENTER);

		expect(await answer).to.equal('hunter2');
		expect(ui.output).to.not.contain('hunter2');
		expect(ui.log.join('\n')).to.contain('•••••••');
	});
});

describe('confirm()', () => {
	it('should answer yes and no', async () => {
		const ui = screenSetup();
		const yes = confirm({ ansi: ui.ansi, message: 'Continue?', terminal: ui.terminal });
		await type(ui.stdin, 'y');
		expect(await yes).to.equal(true);

		const two = screenSetup();
		const no = confirm({ ansi: two.ansi, message: 'Continue?', terminal: two.terminal });
		await type(two.stdin, 'n');
		expect(await no).to.equal(false);
	});

	it('should take the default on enter', async () => {
		const ui = screenSetup();
		const answer = confirm({
			ansi: ui.ansi,
			default: false,
			message: 'Continue?',
			terminal: ui.terminal,
		});

		await type(ui.stdin, ENTER);

		expect(await answer).to.equal(false);
	});

	it('should show which way enter goes', async () => {
		const ui = screenSetup();
		const answer = confirm({
			ansi: ui.ansi,
			default: false,
			message: 'Continue?',
			terminal: ui.terminal,
		});

		await tick();
		expect(ui.log.join('\n')).to.contain('(y/N)');

		await type(ui.stdin, ENTER);
		await answer;
	});

	it('should ignore a key that is neither', async () => {
		const ui = screenSetup();
		const answer = confirm({ ansi: ui.ansi, message: 'Continue?', terminal: ui.terminal });

		await type(ui.stdin, 'q', 'z', 'n');

		expect(await answer).to.equal(false);
	});
});

describe('select()', () => {
	const choices = ['one', 'two', 'three'];

	it('should return the highlighted choice', async () => {
		const ui = screenSetup();
		const answer = select({ ansi: ui.ansi, choices, message: 'Pick', terminal: ui.terminal });

		await type(ui.stdin, DOWN, ENTER);

		expect(await answer).to.equal('two');
	});

	it('should return a choice object value', async () => {
		const ui = screenSetup();
		const answer = select({
			ansi: ui.ansi,
			choices: [
				{ label: 'First', value: 1 },
				{ label: 'Second', value: 2 },
			],
			message: 'Pick',
			terminal: ui.terminal,
		});

		await type(ui.stdin, DOWN, ENTER);

		expect(await answer).to.equal(2);
	});

	// a list you cannot get to the end of by going up is a list you have to know
	// the length of
	it('should wrap at both ends', async () => {
		const ui = screenSetup();
		const answer = select({ ansi: ui.ansi, choices, message: 'Pick', terminal: ui.terminal });

		await type(ui.stdin, UP, ENTER);

		expect(await answer).to.equal('three');
	});

	it('should start where initial says', async () => {
		const ui = screenSetup();
		const answer = select({
			ansi: ui.ansi,
			choices,
			initial: 2,
			message: 'Pick',
			terminal: ui.terminal,
		});

		await type(ui.stdin, ENTER);

		expect(await answer).to.equal('three');
	});

	it('should draw every choice and mark the active one', async () => {
		const ui = screenSetup();
		const answer = select({ ansi: ui.ansi, choices, message: 'Pick', terminal: ui.terminal });

		await tick();
		const frame = ui.log.join('\n');
		for (const choice of choices) {
			expect(frame).to.contain(choice);
		}
		expect(frame).to.contain('❯ one');

		await type(ui.stdin, ENTER);
		await answer;
	});

	// a canvas is a fixed number of rows and what does not fit is clipped, so a
	// list longer than the screen shows a window of itself -- and an arrow key
	// that moved a cursor nobody could see is what that is for
	it('should scroll the list to keep the highlight on screen', async () => {
		const ui = screenSetup({ rows: 6 });
		const many = Array.from({ length: 10 }, (_, i) => `choice ${i}`);
		const answer = select({ ansi: ui.ansi, choices: many, message: 'Pick', terminal: ui.terminal });

		await tick();
		expect(ui.log).to.deep.equal([
			'? Pick',
			'\u276f choice 0',
			' choice 1',
			' choice 2',
			' choice 3',
			' choice 4',
		]);

		await type(ui.stdin, ...Array.from({ length: 7 }, () => DOWN));
		expect(ui.log).to.deep.equal([
			'? Pick',
			' choice 3',
			' choice 4',
			' choice 5',
			' choice 6',
			'\u276f choice 7',
		]);

		await type(ui.stdin, ENTER);
		expect(await answer).to.equal('choice 7');
	});

	// wrapping past the top is the case a window that only ever moved forwards
	// would leave behind
	it('should scroll back when the highlight wraps to the end', async () => {
		const ui = screenSetup({ rows: 6 });
		const many = Array.from({ length: 10 }, (_, i) => `choice ${i}`);
		const answer = select({ ansi: ui.ansi, choices: many, message: 'Pick', terminal: ui.terminal });

		await type(ui.stdin, UP);
		expect(ui.log.at(-1)).to.equal('\u276f choice 9');

		await type(ui.stdin, ENTER);
		expect(await answer).to.equal('choice 9');
	});

	it('should refuse an empty list rather than hang', async () => {
		const ui = screenSetup();
		await expect(
			select({ ansi: ui.ansi, choices: [], message: 'Pick', terminal: ui.terminal })
		).rejects.toThrow('has no choices to offer');
	});
});

describe('multiselect()', () => {
	const choices = ['a', 'b', 'c'];

	it('should return what was ticked, in list order', async () => {
		const ui = screenSetup();
		const answer = multiselect({ ansi: ui.ansi, choices, message: 'Pick', terminal: ui.terminal });

		await type(ui.stdin, DOWN, SPACE, DOWN, SPACE, UP, UP, SPACE, ENTER);

		expect(await answer).to.deep.equal(['a', 'b', 'c']);
	});

	it('should return nothing when nothing is ticked', async () => {
		const ui = screenSetup();
		const answer = multiselect({ ansi: ui.ansi, choices, message: 'Pick', terminal: ui.terminal });

		await type(ui.stdin, ENTER);

		expect(await answer).to.deep.equal([]);
	});

	it('should untick a second press', async () => {
		const ui = screenSetup();
		const answer = multiselect({ ansi: ui.ansi, choices, message: 'Pick', terminal: ui.terminal });

		await type(ui.stdin, SPACE, SPACE, ENTER);

		expect(await answer).to.deep.equal([]);
	});

	it('should start with what selected says ticked', async () => {
		const ui = screenSetup();
		const answer = multiselect({
			ansi: ui.ansi,
			choices: [{ label: 'a' }, { label: 'b', selected: true }],
			message: 'Pick',
			terminal: ui.terminal,
		});

		await type(ui.stdin, ENTER);

		expect(await answer).to.deep.equal(['b']);
	});

	it('should refuse an empty selection when required', async () => {
		const ui = screenSetup();
		const answer = multiselect({
			ansi: ui.ansi,
			choices,
			message: 'Pick',
			terminal: ui.terminal,
			required: true,
		});

		await type(ui.stdin, ENTER);
		expect(ui.log.join('\n')).to.contain('Choose at least one');

		await type(ui.stdin, SPACE, ENTER);
		expect(await answer).to.deep.equal(['a']);
	});

	it('should tick everything with ctrl-a, and untick with it again', async () => {
		const ui = screenSetup();
		const answer = multiselect({ ansi: ui.ansi, choices, message: 'Pick', terminal: ui.terminal });

		await type(ui.stdin, '\u0001', ENTER);

		expect(await answer).to.deep.equal(['a', 'b', 'c']);
	});
});

describe('giving up', () => {
	it.each([
		['ctrl-c', '\u0003'],
		['ctrl-d', '\u0004'],
	])('should reject on %s', async (_name, keys) => {
		const ui = screenSetup();
		const answer = settle(text({ ansi: ui.ansi, message: 'Name?', terminal: ui.terminal }));

		await type(ui.stdin, 'part', keys);

		const { error } = await answer;
		expect(error).toBeInstanceOf(PromptError);
		expect(error?.message).to.equal('Cancelled');
		expect(error?.aborted).to.equal(true);
	});

	it('should erase the prompt when it is cancelled', async () => {
		const ui = screenSetup();
		const answer = settle(text({ ansi: ui.ansi, message: 'Name?', terminal: ui.terminal }));

		await type(ui.stdin, 'x', '\u0003');
		await answer;

		expect(ui.log).to.deep.equal([]);
	});

	it('should leave raw mode however it ends', async () => {
		const ui = screenSetup();

		const answered = text({ ansi: ui.ansi, message: 'Name?', terminal: ui.terminal });
		await type(ui.stdin, 'x', ENTER);
		await answered;
		expect(ui.stdin.rawMode).to.equal(false);

		const cancelled = settle(text({ ansi: ui.ansi, message: 'Name?', terminal: ui.terminal }));
		await type(ui.stdin, '\u0003');
		await cancelled;
		expect(ui.stdin.rawMode).to.equal(false);
	});

	// a prompt that waits on a stdin that will never produce a keystroke is a
	// hung build with no explanation
	it('should refuse to prompt when the input is not a terminal', async () => {
		const ui = screenSetup({ inputTTY: false });

		await expect(text({ ansi: ui.ansi, message: 'Name?', terminal: ui.terminal })).rejects.toThrow(
			'Cannot prompt for "Name?" because the input is not a terminal'
		);
	});

	it('should refuse to prompt when the output is not a terminal', async () => {
		const ui = screenSetup({ isTTY: false });

		await expect(
			confirm({ ansi: ui.ansi, message: 'Sure?', terminal: ui.terminal })
		).rejects.toThrow('is not a terminal');
	});

	it('should not report a missing terminal as an abort', async () => {
		const ui = screenSetup({ inputTTY: false });

		await text({ ansi: ui.ansi, message: 'Name?', terminal: ui.terminal }).catch(
			(err: PromptError) => {
				expect(err).toBeInstanceOf(PromptError);
				expect(err.aborted).to.equal(false);
			}
		);
	});

	it('should reject when stdin ends before an answer', async () => {
		const ui = screenSetup();
		const answer = text({ ansi: ui.ansi, message: 'Name?', terminal: ui.terminal });

		await tick();
		ui.stdin.end();

		await expect(answer).rejects.toThrow('Input ended before the prompt was answered');
	});
});

describe('leaving stdin alone', () => {
	// leaving a `for await (const chunk of stdin)` loop calls the iterator's
	// `return()`, and Node implements that by *destroying* the stream. The first
	// prompt answered correctly and then took `process.stdin` with it: the demo
	// died on `AbortError: The operation was aborted` and no second prompt could
	// ever read a key
	it('should not destroy stdin when a prompt is answered', async () => {
		const ui = screenSetup();
		const answer = text({ ansi: ui.ansi, message: 'Name?', terminal: ui.terminal });

		await type(ui.stdin, 'hi', ENTER);
		await answer;

		expect(ui.stdin.destroyed, 'the prompt destroyed stdin').to.equal(false);
	});

	it('should not destroy stdin when a prompt is cancelled', async () => {
		const ui = screenSetup();
		const answer = settle(text({ ansi: ui.ansi, message: 'Name?', terminal: ui.terminal }));

		await type(ui.stdin, '\u0003');
		await answer;

		expect(ui.stdin.destroyed).to.equal(false);
	});

	// the failure as it was actually met: one prompt after another
	it('should ask a second question on the same stdin', async () => {
		const ui = screenSetup();

		const first = text({ ansi: ui.ansi, message: 'One', terminal: ui.terminal });
		await type(ui.stdin, 'a', ENTER);
		expect(await first).to.equal('a');

		const second = confirm({ ansi: ui.ansi, message: 'Two', terminal: ui.terminal });
		await type(ui.stdin, 'y');
		expect(await second).to.equal(true);

		const third = select({
			ansi: ui.ansi,
			choices: ['x', 'y'],
			message: 'Three',
			terminal: ui.terminal,
		});
		await type(ui.stdin, DOWN, ENTER);
		expect(await third).to.equal('y');
	});

	// nothing of ours may be left listening, or the next reader gets our keys too
	it('should take its listeners back off', async () => {
		const ui = screenSetup();
		const before = ui.stdin.listenerCount('data');

		const answer = text({ ansi: ui.ansi, message: 'Name?', terminal: ui.terminal });
		await type(ui.stdin, 'x');
		expect(ui.stdin.listenerCount('data')).to.be.greaterThan(before);

		await type(ui.stdin, ENTER);
		await answer;

		expect(ui.stdin.listenerCount('data')).to.equal(before);
		expect(ui.stdin.listenerCount('end')).to.equal(0);
		expect(ui.stdin.listenerCount('error')).to.equal(0);
	});

	// a terminal sends Alt-x as ESC then x and Up as ESC [ A, both in one write --
	// but ssh, a pty under load, or a small read buffer delivers the halves
	// separately, and decoded on their own they are an unknown sequence and a
	// literal `A` that lands in the answer
	describe('a sequence split across chunks', () => {
		beforeEach(() => {
			// only `setTimeout`, so `tick()`'s `setImmediate` still lands and the
			// stream still delivers
			vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
		});

		afterEach(() => {
			vi.useRealTimers();
		});

		it('should hold an unfinished sequence until the rest of it arrives', async () => {
			const ui = screenSetup();
			const answer = text({ ansi: ui.ansi, message: 'Name?', terminal: ui.terminal });

			// Left, arriving as `ESC [` and then `D`
			await type(ui.stdin, 'ac', '[', 'D', 'b', ENTER);

			expect(await answer).to.equal('abc');
		});

		it('should join a lone escape to the character after it', async () => {
			const ui = screenSetup();
			const answer = text({ ansi: ui.ansi, message: 'Name?', terminal: ui.terminal });

			// alt-b, which this prompt does not bind -- not Escape and a literal b
			await type(ui.stdin, 'a', ESCAPE, 'b', ENTER);

			expect(await answer).to.equal('a');
		});

		// the tail that is genuinely ambiguous is a lone ESC: somebody pressing
		// Escape sends nothing after it, so there is no byte to wait for
		it('should stop waiting once the silence is long enough', async () => {
			const ui = screenSetup();
			const answer = text({ ansi: ui.ansi, message: 'Name?', terminal: ui.terminal });

			await type(ui.stdin, ESCAPE);
			vi.advanceTimersByTime(ESCAPE_TIMEOUT);
			await tick();

			// the escape was read for what it is, so the `b` is a character of its
			// own rather than the second half of alt-b
			await type(ui.stdin, 'b', ENTER);

			expect(await answer).to.equal('b');
		});

		// a prompt that cannot be escaped is worse than no prompt, and a half
		// arrived sequence is the window where that was easiest to do
		it('should still abort on ctrl-c while a sequence is being held', async () => {
			const ui = screenSetup();
			const answer = settle(text({ ansi: ui.ansi, message: 'Name?', terminal: ui.terminal }));

			await type(ui.stdin, 'x', '[', '');

			const { error } = await answer;
			expect(error?.aborted).to.equal(true);
		});

		// a prompt that ended while it was still waiting for the rest of a sequence
		// owes the loop the timer back
		it('should not leave a timer behind when the prompt ends', async () => {
			const ui = screenSetup();
			const answer = settle(text({ ansi: ui.ansi, message: 'Name?', terminal: ui.terminal }));

			await type(ui.stdin, 'x', ESCAPE);
			expect(vi.getTimerCount()).to.equal(1);

			ui.stdin.end();
			await answer;

			expect(vi.getTimerCount()).to.equal(0);
		});
	});

	// a character split across two chunks is one key, not two broken ones
	it('should read a multi-byte character split across chunks', async () => {
		const ui = screenSetup();
		const answer = text({ ansi: ui.ansi, message: 'Name?', terminal: ui.terminal });

		const bytes = Buffer.from('日', 'utf8');
		ui.stdin.write(bytes.subarray(0, 1));
		await tick();
		ui.stdin.write(bytes.subarray(1));
		await tick();
		await type(ui.stdin, ENTER);

		expect(await answer).to.equal('日');
	});
});

describe('a field narrower than what is in it', () => {
	// the value scrolls sideways rather than wrapping, because a canvas is a fixed
	// number of columns and there is no inline layout to wrap three flex items
	// through
	it('should keep the caret on screen', async () => {
		const ui = screenSetup({ columns: 20 });
		const answer = text({ ansi: ui.ansi, message: 'Name?', terminal: ui.terminal });

		await type(ui.stdin, 'abcdefghijklmnop');

		// `? Name? ` is eight columns, so twelve are left and the caret is in them
		expect(ui.frame).to.equal('? Name? fghijklmnop');

		await type(ui.stdin, ENTER);
		expect(await answer).to.equal('abcdefghijklmnop');
	});

	// a two-column caret in a one-column field is a field that cannot hold it, and
	// a loop that insisted on making it fit never ended
	it('should not hang where the caret is wider than the room', async () => {
		const ui = screenSetup({ columns: 10 });
		const answer = text({
			ansi: ui.ansi,
			message: 'A very long question indeed',
			terminal: ui.terminal,
		});

		await type(ui.stdin, '\u{1f600}', LEFT, ENTER);

		expect(await answer).to.equal('\u{1f600}');
	});
});

describe('giving up while something is in flight', () => {
	// a prompt that cannot be escaped until a slow validator comes back is a
	// prompt that cannot be escaped, and giving up needs nothing from the state
	it('should abort without waiting for an async validator', async () => {
		const ui = screenSetup();
		let release: (() => void) | undefined;
		const answer = settle(
			text({
				ansi: ui.ansi,
				message: 'Name?',
				terminal: ui.terminal,
				validate: () =>
					new Promise<undefined>((resolve) => {
						release = () => resolve(undefined);
					}),
			})
		);

		await type(ui.stdin, 'x', ENTER);
		expect(release, 'the validator should be in flight').to.be.a('function');

		await type(ui.stdin, CTRL_C);

		const { error } = await answer;
		expect(error?.aborted).to.equal(true);

		// and the validator settling afterwards changes nothing
		release?.();
		await tick();
		expect(ui.log).to.deep.equal([]);
	});
});

describe('a question longer than the room for it', () => {
	// a row's intrinsic height is taken with every child offered the whole content
	// box while placement hands each one a share, so a question that wraps to two
	// lines in the share it gets was one line in the room it was offered -- and the
	// canvas reserved one row with the second line clipped off the bottom
	it('should reserve the rows the layout turned out to need', async () => {
		const ui = screenSetup({ columns: 20 });
		const answer = text({
			ansi: ui.ansi,
			message: 'aaaaaaaaaaaaaa bbb',
			terminal: ui.terminal,
		});

		await tick();
		expect(ui.log).to.deep.equal(['? aaaaaaaaaaaaaa', '  bbb']);

		await type(ui.stdin, ENTER);
		await answer;
	});
});

describe('a question that wraps', () => {
	// a row's intrinsic height is a guess for a child that flexes, so a question
	// measured at the full width and placed in a share of it came out one line
	// tall -- and the choice list under it was drawn over the rest of the question
	it('should not let the list cover the rest of the question', async () => {
		const ui = screenSetup({ columns: 20, rows: 6 });
		const answer = select({
			ansi: ui.ansi,
			choices: ['one', 'two', 'three'],
			message: 'aaaaaaaaaaaaaa bbb',
			terminal: ui.terminal,
		});

		await tick();
		expect(ui.log).to.deep.equal(['? aaaaaaaaaaaaaa', '  bbb', '\u276f one', ' two', ' three']);

		await type(ui.stdin, ENTER);
		expect(await answer).to.equal('one');
	});

	// and the rows the list may take are the ones the question left, not all but
	// one of them
	it('should window the list against the rows the question took', async () => {
		const ui = screenSetup({ columns: 20, rows: 6 });
		const answer = select({
			ansi: ui.ansi,
			choices: ['one', 'two', 'three', 'four', 'five'],
			message: 'aaaaaaaaaaaaaa bbb',
			terminal: ui.terminal,
		});

		await type(ui.stdin, ...Array.from({ length: 4 }, () => DOWN));
		expect(ui.log.at(-1)).to.equal('\u276f five');

		await type(ui.stdin, ENTER);
		expect(await answer).to.equal('five');
	});
});

describe('a router the app already owns', () => {
	// a prompt that builds its own router is only correct because nothing else is
	// reading at the time, which is the ordinary case and is not every case
	it('should read keys through it and leave it running', async () => {
		const ui = screenSetup();
		const router = createInput({ terminal: ui.terminal });

		const answer = text({ ansi: ui.ansi, message: 'Name?', router, terminal: ui.terminal });
		await type(ui.stdin, 'a', 'b', ENTER);
		expect(await answer).to.equal('ab');

		// still reading, and still holding raw mode for whoever built it
		const seen: string[] = [];
		router.bind((event) => seen.push(event.key.name));
		await type(ui.stdin, 'z');
		expect(seen).to.deep.equal(['z']);
		expect(ui.stdin.rawMode).to.equal(true);

		router.stop();
		expect(ui.stdin.rawMode).to.equal(false);
	});

	// and the prompt takes its own handlers back off, or the next thing bound to
	// that router competes with a prompt that has been answered
	it('should leave none of its own handlers behind', async () => {
		const ui = screenSetup();
		const router = createInput({ terminal: ui.terminal });
		const seen: string[] = [];

		const first = text({ ansi: ui.ansi, message: 'One', router, terminal: ui.terminal });
		await type(ui.stdin, 'x', ENTER);
		expect(await first).to.equal('x');

		router.bind((event) => seen.push(event.key.name));
		await type(ui.stdin, 'y');

		expect(seen).to.deep.equal(['y']);
		router.stop();
	});
});
