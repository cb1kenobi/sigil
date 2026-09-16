import {
	confirm,
	multiselect,
	password,
	PromptError,
	select,
	text,
} from '../../src/components/prompt.js';
import { setup, tick } from './helpers.js';
import { describe, expect, it } from 'vitest';

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

const ENTER = '\r';
const UP = '\u001b[A';
const DOWN = '\u001b[B';
const SPACE = ' ';

describe('text()', () => {
	it('should return what was typed', async () => {
		const { ansi, region, stdin } = setup();
		const answer = text({ ansi, message: 'Name?', region });

		await type(stdin, 'c', 'h', 'r', 'i', 's', ENTER);

		expect(await answer).to.equal('chris');
	});

	it('should read a chunk carrying several characters, as a paste does', async () => {
		const { ansi, region, stdin } = setup();
		const answer = text({ ansi, message: 'Name?', region });

		await type(stdin, 'pasted text', ENTER);

		expect(await answer).to.equal('pasted text');
	});

	it('should fall back to the default on an empty answer', async () => {
		const { ansi, region, stdin } = setup();
		const answer = text({ ansi, default: 'anonymous', message: 'Name?', region });

		await type(stdin, ENTER);

		expect(await answer).to.equal('anonymous');
	});

	it('should erase with backspace', async () => {
		const { ansi, region, stdin } = setup();
		const answer = text({ ansi, message: 'Name?', region });

		await type(stdin, 'a', 'b', 'c', '\u007f', ENTER);

		expect(await answer).to.equal('ab');
	});

	it('should insert where the cursor is', async () => {
		const { ansi, region, stdin } = setup();
		const answer = text({ ansi, message: 'Name?', region });

		await type(stdin, 'a', 'c', '\u001b[D', 'b', ENTER);

		expect(await answer).to.equal('abc');
	});

	it('should clear the line with ctrl-u', async () => {
		const { ansi, region, stdin } = setup();
		const answer = text({ ansi, message: 'Name?', region });

		await type(stdin, 'throw away', '\u0015', 'kept', ENTER);

		expect(await answer).to.equal('kept');
	});

	it('should type a space', async () => {
		const { ansi, region, stdin } = setup();
		const answer = text({ ansi, message: 'Name?', region });

		await type(stdin, 'a', SPACE, 'b', ENTER);

		expect(await answer).to.equal('a b');
	});

	describe('validation', () => {
		it('should refuse an answer and say why', async () => {
			const { ansi, region, stdin, stdout } = setup();
			const answer = text({
				ansi,
				message: 'Port?',
				region,
				validate: (value) => (/^\d+$/.test(value) ? undefined : 'Numbers only'),
			});

			await type(stdin, 'abc', ENTER);
			expect(stdout.text).to.contain('Numbers only');

			await type(stdin, '\u0015', '8080', ENTER);
			expect(await answer).to.equal('8080');
		});

		it('should take an async validator', async () => {
			const { ansi, region, stdin } = setup();
			const answer = text({
				ansi,
				message: 'Name?',
				region,
				validate: async (value) => (value === 'taken' ? 'Already taken' : undefined),
			});

			await type(stdin, 'taken', ENTER);
			await type(stdin, '\u0015', 'free', ENTER);

			expect(await answer).to.equal('free');
		});
	});

	it('should show the placeholder until something is typed', async () => {
		const { ansi, region, stdin, stdout } = setup();
		const answer = text({ ansi, message: 'Name?', placeholder: 'your name', region });

		await tick();
		expect(stdout.frame).to.contain('your name');

		await type(stdin, 'x');
		expect(stdout.frame).to.not.contain('your name');
		expect(stdout.frame).to.contain('x');

		await type(stdin, ENTER);
		await answer;
	});
});

describe('password()', () => {
	it('should not show what was typed', async () => {
		const { ansi, region, stdin, stdout } = setup();
		const answer = password({ ansi, message: 'Password?', region });

		await type(stdin, 'hunter2', ENTER);

		expect(await answer).to.equal('hunter2');
		expect(stdout.output).to.not.contain('hunter2');
		expect(stdout.text).to.contain('•••••••');
	});
});

describe('confirm()', () => {
	it('should answer yes and no', async () => {
		const { ansi, region, stdin } = setup();
		const yes = confirm({ ansi, message: 'Continue?', region });
		await type(stdin, 'y');
		expect(await yes).to.equal(true);

		const two = setup();
		const no = confirm({ ansi: two.ansi, message: 'Continue?', region: two.region });
		await type(two.stdin, 'n');
		expect(await no).to.equal(false);
	});

	it('should take the default on enter', async () => {
		const { ansi, region, stdin } = setup();
		const answer = confirm({ ansi, default: false, message: 'Continue?', region });

		await type(stdin, ENTER);

		expect(await answer).to.equal(false);
	});

	it('should show which way enter goes', async () => {
		const { ansi, region, stdin, stdout } = setup();
		const answer = confirm({ ansi, default: false, message: 'Continue?', region });

		await tick();
		expect(stdout.text).to.contain('(y/N)');

		await type(stdin, ENTER);
		await answer;
	});

	it('should ignore a key that is neither', async () => {
		const { ansi, region, stdin } = setup();
		const answer = confirm({ ansi, message: 'Continue?', region });

		await type(stdin, 'q', 'z', 'n');

		expect(await answer).to.equal(false);
	});
});

describe('select()', () => {
	const choices = ['one', 'two', 'three'];

	it('should return the highlighted choice', async () => {
		const { ansi, region, stdin } = setup();
		const answer = select({ ansi, choices, message: 'Pick', region });

		await type(stdin, DOWN, ENTER);

		expect(await answer).to.equal('two');
	});

	it('should return a choice object value', async () => {
		const { ansi, region, stdin } = setup();
		const answer = select({
			ansi,
			choices: [
				{ label: 'First', value: 1 },
				{ label: 'Second', value: 2 },
			],
			message: 'Pick',
			region,
		});

		await type(stdin, DOWN, ENTER);

		expect(await answer).to.equal(2);
	});

	// a list you cannot get to the end of by going up is a list you have to know
	// the length of
	it('should wrap at both ends', async () => {
		const { ansi, region, stdin } = setup();
		const answer = select({ ansi, choices, message: 'Pick', region });

		await type(stdin, UP, ENTER);

		expect(await answer).to.equal('three');
	});

	it('should start where initial says', async () => {
		const { ansi, region, stdin } = setup();
		const answer = select({ ansi, choices, initial: 2, message: 'Pick', region });

		await type(stdin, ENTER);

		expect(await answer).to.equal('three');
	});

	it('should draw every choice and mark the active one', async () => {
		const { ansi, region, stdin, stdout } = setup();
		const answer = select({ ansi, choices, message: 'Pick', region });

		await tick();
		const frame = stdout.text;
		for (const choice of choices) {
			expect(frame).to.contain(choice);
		}
		expect(frame).to.contain('❯ one');

		await type(stdin, ENTER);
		await answer;
	});

	it('should refuse an empty list rather than hang', async () => {
		const { ansi, region } = setup();
		await expect(select({ ansi, choices: [], message: 'Pick', region })).rejects.toThrow(
			'has no choices to offer'
		);
	});
});

describe('multiselect()', () => {
	const choices = ['a', 'b', 'c'];

	it('should return what was ticked, in list order', async () => {
		const { ansi, region, stdin } = setup();
		const answer = multiselect({ ansi, choices, message: 'Pick', region });

		await type(stdin, DOWN, SPACE, DOWN, SPACE, UP, UP, SPACE, ENTER);

		expect(await answer).to.deep.equal(['a', 'b', 'c']);
	});

	it('should return nothing when nothing is ticked', async () => {
		const { ansi, region, stdin } = setup();
		const answer = multiselect({ ansi, choices, message: 'Pick', region });

		await type(stdin, ENTER);

		expect(await answer).to.deep.equal([]);
	});

	it('should untick a second press', async () => {
		const { ansi, region, stdin } = setup();
		const answer = multiselect({ ansi, choices, message: 'Pick', region });

		await type(stdin, SPACE, SPACE, ENTER);

		expect(await answer).to.deep.equal([]);
	});

	it('should start with what selected says ticked', async () => {
		const { ansi, region, stdin } = setup();
		const answer = multiselect({
			ansi,
			choices: [{ label: 'a' }, { label: 'b', selected: true }],
			message: 'Pick',
			region,
		});

		await type(stdin, ENTER);

		expect(await answer).to.deep.equal(['b']);
	});

	it('should refuse an empty selection when required', async () => {
		const { ansi, region, stdin, stdout } = setup();
		const answer = multiselect({ ansi, choices, message: 'Pick', region, required: true });

		await type(stdin, ENTER);
		expect(stdout.text).to.contain('Choose at least one');

		await type(stdin, SPACE, ENTER);
		expect(await answer).to.deep.equal(['a']);
	});

	it('should tick everything with ctrl-a, and untick with it again', async () => {
		const { ansi, region, stdin } = setup();
		const answer = multiselect({ ansi, choices, message: 'Pick', region });

		await type(stdin, '\u0001', ENTER);

		expect(await answer).to.deep.equal(['a', 'b', 'c']);
	});
});

describe('giving up', () => {
	it.each([
		['ctrl-c', '\u0003'],
		['ctrl-d', '\u0004'],
	])('should reject on %s', async (_name, keys) => {
		const { ansi, region, stdin } = setup();
		const answer = settle(text({ ansi, message: 'Name?', region }));

		await type(stdin, 'part', keys);

		const { error } = await answer;
		expect(error).toBeInstanceOf(PromptError);
		expect(error?.message).to.equal('Cancelled');
		expect(error?.aborted).to.equal(true);
	});

	it('should erase the prompt when it is cancelled', async () => {
		const { ansi, region, stdin } = setup();
		const answer = settle(text({ ansi, message: 'Name?', region }));

		await type(stdin, 'x', '\u0003');
		await answer;

		expect(region.active).to.equal(false);
	});

	it('should leave raw mode however it ends', async () => {
		const { ansi, region, stdin } = setup();

		const answered = text({ ansi, message: 'Name?', region });
		await type(stdin, 'x', ENTER);
		await answered;
		expect(stdin.rawMode).to.equal(false);

		const cancelled = settle(text({ ansi, message: 'Name?', region }));
		await type(stdin, '\u0003');
		await cancelled;
		expect(stdin.rawMode).to.equal(false);
	});

	// a prompt that waits on a stdin that will never produce a keystroke is a
	// hung build with no explanation
	it('should refuse to prompt when the input is not a terminal', async () => {
		const { ansi, region } = setup({ inputTTY: false });

		await expect(text({ ansi, message: 'Name?', region })).rejects.toThrow(
			'Cannot prompt for "Name?" because the input is not a terminal'
		);
	});

	it('should refuse to prompt when the output is not a terminal', async () => {
		const { ansi, region } = setup({ isTTY: false });

		await expect(confirm({ ansi, message: 'Sure?', region })).rejects.toThrow('is not a terminal');
	});

	it('should not report a missing terminal as an abort', async () => {
		const { ansi, region } = setup({ inputTTY: false });

		await text({ ansi, message: 'Name?', region }).catch((err: PromptError) => {
			expect(err).toBeInstanceOf(PromptError);
			expect(err.aborted).to.equal(false);
		});
	});

	it('should reject when stdin ends before an answer', async () => {
		const { ansi, region, stdin } = setup();
		const answer = text({ ansi, message: 'Name?', region });

		await tick();
		stdin.end();

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
		const { ansi, region, stdin } = setup();
		const answer = text({ ansi, message: 'Name?', region });

		await type(stdin, 'hi', ENTER);
		await answer;

		expect(stdin.destroyed, 'the prompt destroyed stdin').to.equal(false);
	});

	it('should not destroy stdin when a prompt is cancelled', async () => {
		const { ansi, region, stdin } = setup();
		const answer = settle(text({ ansi, message: 'Name?', region }));

		await type(stdin, '\u0003');
		await answer;

		expect(stdin.destroyed).to.equal(false);
	});

	// the failure as it was actually met: one prompt after another
	it('should ask a second question on the same stdin', async () => {
		const { ansi, region, stdin } = setup();

		const first = text({ ansi, message: 'One', region });
		await type(stdin, 'a', ENTER);
		expect(await first).to.equal('a');

		const second = confirm({ ansi, message: 'Two', region });
		await type(stdin, 'y');
		expect(await second).to.equal(true);

		const third = select({ ansi, choices: ['x', 'y'], message: 'Three', region });
		await type(stdin, DOWN, ENTER);
		expect(await third).to.equal('y');
	});

	// nothing of ours may be left listening, or the next reader gets our keys too
	it('should take its listeners back off', async () => {
		const { ansi, region, stdin } = setup();
		const before = stdin.listenerCount('data');

		const answer = text({ ansi, message: 'Name?', region });
		await type(stdin, 'x');
		expect(stdin.listenerCount('data')).to.be.greaterThan(before);

		await type(stdin, ENTER);
		await answer;

		expect(stdin.listenerCount('data')).to.equal(before);
		expect(stdin.listenerCount('end')).to.equal(0);
		expect(stdin.listenerCount('error')).to.equal(0);
	});

	// a character split across two chunks is one key, not two broken ones
	it('should read a multi-byte character split across chunks', async () => {
		const { ansi, region, stdin } = setup();
		const answer = text({ ansi, message: 'Name?', region });

		const bytes = Buffer.from('日', 'utf8');
		stdin.write(bytes.subarray(0, 1));
		await tick();
		stdin.write(bytes.subarray(1));
		await tick();
		await type(stdin, ENTER);

		expect(await answer).to.equal('日');
	});
});
