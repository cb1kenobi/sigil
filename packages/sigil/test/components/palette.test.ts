import { type PaletteSlot, slotsFor } from '../../src/components/catalog.js';
import { checkSlotValue, commandPalette } from '../../src/components/palette.js';
import { ESCAPE_TIMEOUT, PromptError } from '../../src/components/prompt.js';
import { stateFromError } from '../../src/error-hooks.js';
import { parse } from '../../src/parser/parse.js';
import {
	type AnyCommand,
	Internal,
	type InternalCommand,
	type ParseState,
	type Schema,
} from '../../src/types.js';
import { type ScreenHarness, screenSetup, tick } from './helpers.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const ENTER = '\r';
const ESCAPE = '\u001b';
const CTRL_C = '\u0003';
const CTRL_U = '\u0015';
const BACKSPACE = '\u007f';
const UP = '\u001b[A';
const DOWN = '\u001b[B';
const LEFT = '\u001b[D';
const HOME = '\u001b[H';
const END = '\u001b[F';
const PAGEUP = '\u001b[5~';
const PAGEDOWN = '\u001b[6~';
/** A CSI nothing names, for asserting that an unnamed key does nothing. */
const UNNAMED = '\u001b[202~';

/** Sends keys one at a time, letting the palette act on each. */
async function type(stdin: { send(chunk: string): void }, ...chunks: string[]) {
	for (const chunk of chunks) {
		stdin.send(chunk);
		await tick();
	}
}

/**
 * Starts the palette and reports how it settled.
 *
 * The handler is attached before any key is sent, for `prompt.test.ts`'s own
 * reason: a prompt can reject while `type()` is still awaiting, and a promise
 * that rejects before anything is listening is an unhandled rejection.
 *
 * @param promise - The palette.
 * @returns Its answer, or the error it rejected with.
 */
function settle<T>(promise: Promise<T>): Promise<{ error?: PromptError; value?: T }> {
	return promise.then(
		(value) => ({ value }),
		(error: PromptError) => ({ error })
	);
}

/** The state a parse ends in, which is what the palette reads. */
async function appState(schema: Schema, argv: string[] = []): Promise<ParseState> {
	try {
		return await parse({ argv, env: {}, schema: { help: false, name: 'mycli', ...schema } });
	} catch (err) {
		// a schema declaring a required option with no value is refused by its own
		// parse, which is the fixture the ancestor-option test below is about. The
		// state the error carries holds the chain, which is all the catalog reads
		return stateFromError(err) as ParseState;
	}
}

/** A palette over a screen, with no theme and no colour. */
function open(ui: ScreenHarness, target: ParseState, opts: Record<string, unknown> = {}) {
	return commandPalette(target, { ansi: ui.ansi, terminal: ui.terminal, ...opts });
}

/** The slots one command declares, for the pure checks below. */
async function slotOf(cmd: Record<string, unknown>, which = 0): Promise<PaletteSlot> {
	const parsed = await appState({ commands: { build: { run(): void {}, ...cmd } } });
	const root = parsed.contexts[0] as InternalCommand;
	const build = root[Internal].commands.get('build') as InternalCommand;
	return slotsFor([build, root])[which] as PaletteSlot;
}

describe('checkSlotValue()', () => {
	const slot: PaletteSlot = {
		label: '<port>',
		multiple: false,
		required: true,
		type: 'int',
	};
	const optional: PaletteSlot = { ...slot, label: '[port]', required: false };

	it('should refuse an empty answer for a required slot', () => {
		expect(checkSlotValue(slot, '')).toMatch(/needs a value/);
	});

	it('should accept an empty answer for an optional slot', () => {
		expect(checkSlotValue(optional, '')).toBeUndefined();
	});

	it('should accept what the declared type takes', () => {
		expect(checkSlotValue(slot, '8080')).toBeUndefined();
	});

	it("should refuse what the declared type refuses, in the parser's own words", () => {
		// the same message `transformValue()` throws, because it *is*
		// `transformValue()`: one answer to "is this a valid value" rather than a
		// second validator that drifts from the first
		expect(checkSlotValue(slot, 'eight')).toBe('Invalid integer: eight');
		expect(checkSlotValue({ ...slot, type: 'json' }, '{')).toMatch(/^Invalid JSON/);
		expect(checkSlotValue({ ...slot, type: 'date' }, '2024-02-30')).toBe(
			'Invalid date: "2024-02-30"'
		);
		expect(checkSlotValue({ ...slot, type: 'bool' }, 'maybe')).toBe('Invalid boolean: "maybe"');
	});

	it('should check `choices` against the coerced value, as the parser does', () => {
		const choosy: PaletteSlot = { ...slot, choices: [1, 2] };
		expect(checkSlotValue(choosy, '1')).toBeUndefined();
		expect(checkSlotValue(choosy, '3')).toMatch(/^Invalid value "3"/);
		// a `string` declaration with numeric choices refuses them, which is what
		// a command line does too -- the parser compares the coerced value
		expect(checkSlotValue({ ...choosy, type: 'string' }, '1')).toMatch(/^Invalid value/);
	});

	it('should accept an empty `choices` list for an optional slot and refuse every value', () => {
		const none: PaletteSlot = { ...optional, choices: [], type: 'string' };
		expect(checkSlotValue(none, '')).toBeUndefined();
		expect(checkSlotValue(none, 'x')).toMatch(/^Invalid value/);
	});

	it('should refuse a positional value the parser would read as an option', () => {
		const positional: PaletteSlot = { ...slot, label: '<n>', type: 'string' };
		expect(checkSlotValue(positional, '-5')).toMatch(/reads it as an option/);
		expect(checkSlotValue(positional, '--force')).toMatch(/reads it as an option/);
		// `optionLikeRE` is `/^--?\w/`, so these are values rather than options
		expect(checkSlotValue(positional, '-')).toBeUndefined();
		expect(checkSlotValue(positional, '-.5')).toBeUndefined();
		expect(checkSlotValue(positional, 'a-b')).toBeUndefined();
	});

	it('should take a dash-leading value for an option, which is attached', () => {
		// `--port=--weird` is one token and the parser splits it on the first `=`,
		// so the value is taken exactly as typed
		const opt: PaletteSlot = { ...slot, spelling: '--port', type: 'string' };
		expect(checkSlotValue(opt, '--weird')).toBeUndefined();
	});

	it('should read the slot it was handed rather than a declaration', async () => {
		// the pair end to end: what `slotsFor()` projects is what this validates
		const slot_ = await slotOf({ args: [{ choices: [1, 2], name: '<level>', type: 'int' }] });
		expect(checkSlotValue(slot_, '2')).toBeUndefined();
		expect(checkSlotValue(slot_, '9')).toMatch(/^Invalid value "9"/);
	});
});

describe('commandPalette()', () => {
	it('should answer with the argv that runs what was chosen', async () => {
		const ui = screenSetup({ rows: 12 });
		const answer = settle(
			open(
				ui,
				await appState({ commands: { build: { run(): void {} }, deploy: { run(): void {} } } })
			)
		);

		await type(ui.stdin, DOWN, ENTER);

		expect((await answer).value?.argv).toEqual(['deploy']);
	});

	it('should filter as a query is typed', async () => {
		const ui = screenSetup({ rows: 12 });
		const answer = settle(
			open(
				ui,
				await appState({
					commands: {
						build: { run(): void {} },
						deploy: { run(): void {} },
						db: { commands: { migrate: { run(): void {} } }, run(): void {} },
					},
				})
			)
		);

		await type(ui.stdin, 'm', 'i', 'g', ENTER);

		expect((await answer).value?.argv).toEqual(['db', 'migrate']);
	});

	it('should answer with nothing when it is dismissed', async () => {
		vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
		try {
			const ui = screenSetup({ rows: 12 });
			const answer = settle(open(ui, await appState({ commands: { build: { run(): void {} } } })));

			ui.stdin.send(ESCAPE);
			await vi.advanceTimersByTimeAsync(ESCAPE_TIMEOUT);
			await vi.advanceTimersByTimeAsync(0);

			const settled = await answer;
			expect(settled.error).toBeUndefined();
			expect(settled.value).toBeUndefined();
		} finally {
			vi.useRealTimers();
		}
	});

	it('should leave ctrl-c the abort every prompt takes', async () => {
		const ui = screenSetup({ rows: 12 });
		const answer = settle(open(ui, await appState({ commands: { build: { run(): void {} } } })));

		await type(ui.stdin, CTRL_C);

		expect((await answer).error?.aborted).toBe(true);
	});

	it('should refuse to exist where the input is not a terminal', async () => {
		const ui = screenSetup({ inputTTY: false });
		const settled = await settle(open(ui, await appState({ commands: { b: { run(): void {} } } })));
		expect(settled.error?.message).toMatch(/not a terminal/);
	});

	it('should do nothing on enter when nothing matches', async () => {
		const ui = screenSetup({ rows: 12 });
		const answer = settle(open(ui, await appState({ commands: { build: { run(): void {} } } })));

		// `zz` matches nothing, so Enter has no row to answer with
		await type(ui.stdin, 'z', 'z', ENTER);
		expect(ui.frame).toMatch(/No commands match/);

		await type(ui.stdin, BACKSPACE, BACKSPACE, ENTER);
		expect((await answer).value?.argv).toEqual(['build']);
	});

	it('should put the highlight back to the top when the query moves', async () => {
		const ui = screenSetup({ rows: 12 });
		const answer = settle(
			open(
				ui,
				await appState({
					commands: {
						alpha: { run(): void {} },
						beta: { run(): void {} },
						gamma: { run(): void {} },
					},
				})
			)
		);

		// down to `gamma`, then a query that keeps all three: the highlight goes
		// back to the top rather than staying on an index the new ranking moved.
		// `a` ranks `alpha` first -- a prefix hit -- where the index that was held
		// would have answered `gamma`
		await type(ui.stdin, DOWN, DOWN, 'a', ENTER);

		expect((await answer).value?.argv).toEqual(['alpha']);
	});

	it('should leave the highlight alone for a key it has no use for', async () => {
		const ui = screenSetup({ rows: 12 });
		const answer = settle(
			open(
				ui,
				await appState({ commands: { alpha: { run(): void {} }, beta: { run(): void {} } } })
			)
		);

		// an unnamed sequence types nothing, so it must not reset the highlight
		// either -- which it would if the insert ran with an empty string
		await type(ui.stdin, DOWN, UNNAMED, ENTER);

		expect((await answer).value?.argv).toEqual(['beta']);
	});

	it('should wrap the highlight at both ends', async () => {
		const ui = screenSetup({ rows: 12 });
		const answer = settle(
			open(
				ui,
				await appState({ commands: { alpha: { run(): void {} }, beta: { run(): void {} } } })
			)
		);

		await type(ui.stdin, UP, ENTER);

		expect((await answer).value?.argv).toEqual(['beta']);
	});

	it('should wrap the highlight going down as well as up', async () => {
		// the other half of the wrap, and it had none: the test above presses Up
		// from the top and nothing pressed Down from the bottom, so replacing the
		// wrap with a clamp left the whole file green
		const ui = screenSetup({ rows: 12 });
		const answer = settle(
			open(
				ui,
				await appState({ commands: { alpha: { run(): void {} }, beta: { run(): void {} } } })
			)
		);

		// two commands, so Down twice wraps back to the first while a clamp stops on
		// the second -- and it has to be an EVEN count, which the first version of
		// this got wrong: at three, both readings land on the second and the test
		// passed with the wrap replaced by a clamp
		await type(ui.stdin, DOWN, DOWN, ENTER);

		expect((await answer).value?.argv).toEqual(['alpha']);
	});

	it('should move the highlight by a page, and clamp at both ends', async () => {
		// `pageup` and `pagedown` were each a no-op away from passing every test in
		// this file. A list longer than the window is what makes a page differ from
		// a step, and pressing more pages than there are rows is what pins the clamp
		// rather than the arithmetic
		const commands: Record<string, { run(): void }> = {};
		for (const n of ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']) {
			commands[n] = { run(): void {} };
		}

		const down = screenSetup({ rows: 8 });
		const first = settle(open(down, await appState({ commands })));

		// past the end, so the clamp decides: the last command whatever the window
		await type(down.stdin, PAGEDOWN, PAGEDOWN, PAGEDOWN, PAGEDOWN, ENTER);
		expect((await first).value?.argv).toEqual(['h']);

		const up = screenSetup({ rows: 8 });
		const back = settle(open(up, await appState({ commands })));

		// and down past the end then up past the start is the first
		await type(up.stdin, PAGEDOWN, PAGEDOWN, PAGEDOWN, PAGEUP, PAGEUP, PAGEUP, ENTER);
		expect((await back).value?.argv).toEqual(['a']);
	});

	it('should move the cursor to the end with end and ctrl-e', async () => {
		// `home`/`ctrl+a` is reached by the field-keys test below; its twin was not,
		// so that branch was a no-op away from green. Both spellings, because the
		// branch answers for either and a test of one pins half of it
		for (const toEnd of [END, '\u0005']) {
			const ui = screenSetup({ rows: 12 });
			const answer = settle(
				open(
					ui,
					await appState({ commands: { build: { run(): void {} }, deploy: { run(): void {} } } })
				)
			);

			// type `epx`, go home, then to the end and backspace the `x` off --
			// which leaves `ep` and matches `deploy` only if the cursor really moved
			await type(ui.stdin, 'e', 'p', 'x', HOME, toEnd, BACKSPACE, ENTER);

			expect((await answer).value?.argv, JSON.stringify(toEnd)).toEqual(['deploy']);
		}
	});

	it('should edit the query with the field keys', async () => {
		const ui = screenSetup({ rows: 12 });
		const answer = settle(
			open(
				ui,
				await appState({ commands: { build: { run(): void {} }, deploy: { run(): void {} } } })
			)
		);

		// type `xdep`, go home, delete forward over the `x`, and `dep` is left
		await type(ui.stdin, 'x', 'd', 'e', 'p', HOME, '\u001b[3~', ENTER);

		expect((await answer).value?.argv).toEqual(['deploy']);
	});

	it('should clear to the start with ctrl-u', async () => {
		const ui = screenSetup({ rows: 12 });
		const answer = settle(
			open(
				ui,
				await appState({ commands: { build: { run(): void {} }, deploy: { run(): void {} } } })
			)
		);

		await type(ui.stdin, 'z', 'z', CTRL_U, 'd', 'e', ENTER);

		expect((await answer).value?.argv).toEqual(['deploy']);
	});

	it('should move the caret without changing the query', async () => {
		const ui = screenSetup({ rows: 12 });
		const answer = settle(
			open(
				ui,
				await appState({ commands: { build: { run(): void {} }, deploy: { run(): void {} } } })
			)
		);

		await type(ui.stdin, 'd', 'e', LEFT, ENTER);

		expect((await answer).value?.argv).toEqual(['deploy']);
	});

	it('should take a pasted block as one line', async () => {
		const ui = screenSetup({ rows: 12 });
		const answer = settle(
			open(
				ui,
				await appState({
					commands: {
						build: { run(): void {} },
						db: { commands: { migrate: { run(): void {} } }, run(): void {} },
					},
				})
			)
		);

		// the newline becomes one space, which is `pastedLine()`'s rule -- so a
		// label with a space in it is what a pasted block can reach
		await type(ui.stdin, '\u001b[200~db\nmigrate\u001b[201~', ENTER);

		expect((await answer).value?.argv).toEqual(['db', 'migrate']);
	});

	it('should flatten a pasted newline rather than obeying it', async () => {
		const ui = screenSetup({ rows: 12 });
		const answer = settle(open(ui, await appState({ commands: { deploy: { run(): void {} } } })));

		// `de` and `ploy` joined by a space is not a subsequence of `deploy`, so
		// nothing matches -- which is the flattening being visible rather than a
		// paste quietly submitting half of itself
		await type(ui.stdin, '\u001b[200~de\nploy\u001b[201~');
		expect(ui.frame).toMatch(/No commands match/);

		await type(ui.stdin, CTRL_U, ENTER);
		expect((await answer).value?.argv).toEqual(['deploy']);
	});

	it('should show the description beside the label', async () => {
		const ui = screenSetup({ columns: 60, rows: 12 });
		const answer = settle(
			open(ui, await appState({ commands: { build: { desc: 'build the app', run(): void {} } } }))
		);

		await tick();
		expect(ui.log.join('\n')).toMatch(/build\s+build the app/);

		await type(ui.stdin, ENTER);
		await answer;
	});

	it('should leave the question and its answer in the log', async () => {
		const ui = screenSetup({ columns: 60, rows: 12 });
		const answer = settle(
			open(
				ui,
				await appState({ commands: { build: { run(): void {} }, deploy: { run(): void {} } } })
			)
		);

		await type(ui.stdin, 'de', ENTER);
		await answer;

		const log = ui.log.join('\n');
		expect(log).toMatch(/Run a command/);
		expect(log).toMatch(/deploy/);
		// the list goes, so `build` is not in what is left
		expect(log).not.toMatch(/build/);
	});

	it('should say so in the log when it was dismissed', async () => {
		vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
		try {
			const ui = screenSetup({ columns: 60, rows: 12 });
			const answer = settle(open(ui, await appState({ commands: { build: { run(): void {} } } })));

			ui.stdin.send(ESCAPE);
			await vi.advanceTimersByTimeAsync(ESCAPE_TIMEOUT);
			await vi.advanceTimersByTimeAsync(0);
			await answer;

			expect(ui.log.join('\n')).toMatch(/\(dismissed\)/);
		} finally {
			vi.useRealTimers();
		}
	});

	it('should window a list longer than the rows it has', async () => {
		const ui = screenSetup({ columns: 60, rows: 12 });
		const commands: Record<string, AnyCommand> = {};
		for (let i = 0; i < 20; i++) {
			commands[`cmd${String(i).padStart(2, '0')}`] = { run(): void {} };
		}
		const answer = settle(open(ui, await appState({ commands }), { rows: 4 }));

		await tick();
		const rows = ui.log.filter((line) => line.includes('cmd'));
		expect(rows).toHaveLength(4);
		expect(rows[0]).toMatch(/cmd00/);

		// walking past the bottom scrolls the window rather than running off it
		await type(ui.stdin, DOWN, DOWN, DOWN, DOWN);
		const after = ui.log.filter((line) => line.includes('cmd'));
		expect(after).toHaveLength(4);
		expect(after.at(-1)).toMatch(/cmd04/);

		await type(ui.stdin, ENTER);
		expect((await answer).value?.argv).toEqual(['cmd04']);
	});

	it('should ask for the values the chosen command needs', async () => {
		const ui = screenSetup({ columns: 60, rows: 12 });
		const answer = settle(
			open(
				ui,
				await appState({
					commands: { build: { args: ['<entry>'], run(): void {} } },
				})
			)
		);

		await type(ui.stdin, ENTER);
		await type(ui.stdin, 's', 'r', 'c', ENTER);

		expect((await answer).value?.argv).toEqual(['build', 'src']);
	});

	it('should refuse an empty answer for a required argument', async () => {
		const ui = screenSetup({ columns: 60, rows: 12 });
		const answer = settle(
			open(ui, await appState({ commands: { build: { args: ['<entry>'], run(): void {} } } }))
		);

		await type(ui.stdin, ENTER);
		// Enter on nothing is refused, with the complaint on screen
		await type(ui.stdin, ENTER);
		expect(ui.frame + ui.log.join('\n')).toMatch(/needs a value/);

		await type(ui.stdin, 'x', ENTER);
		expect((await answer).value?.argv).toEqual(['build', 'x']);
	});

	it('should stop at the first optional argument left empty', async () => {
		const ui = screenSetup({ columns: 60, rows: 12 });
		const answer = settle(
			open(ui, await appState({ commands: { build: { args: ['[a]', '[b]'], run(): void {} } } }))
		);

		await type(ui.stdin, ENTER);
		// `[a]` skipped, so `[b]` is never asked: a positional slot cannot be
		// skipped over
		await type(ui.stdin, ENTER);

		expect((await answer).value?.argv).toEqual(['build']);
		expect((await answer).value?.values).toEqual([[], []]);
	});

	it('should offer a `choices` argument as a list', async () => {
		const ui = screenSetup({ columns: 60, rows: 12 });
		const answer = settle(
			open(
				ui,
				await appState({
					commands: {
						build: { args: [{ choices: ['dev', 'prod'], name: '<mode>' }], run(): void {} },
					},
				})
			)
		);

		await type(ui.stdin, ENTER);
		await type(ui.stdin, DOWN, ENTER);

		expect((await answer).value?.argv).toEqual(['build', 'prod']);
	});

	it('should offer a skip in front of an optional `choices` argument', async () => {
		const ui = screenSetup({ columns: 60, rows: 12 });
		const answer = settle(
			open(
				ui,
				await appState({
					commands: {
						build: { args: [{ choices: ['dev', 'prod'], name: '[mode]' }], run(): void {} },
					},
				})
			)
		);

		await type(ui.stdin, ENTER);
		// the first entry is `(skip)`, because a list of allowed values has no
		// other way to say "none of them"
		expect(ui.frame + ui.log.join('\n')).toMatch(/\(skip\)/);
		await type(ui.stdin, ENTER);

		expect((await answer).value?.argv).toEqual(['build']);
	});

	it('should confirm a required bool argument', async () => {
		const ui = screenSetup({ columns: 60, rows: 12 });
		const answer = settle(
			open(
				ui,
				await appState({
					commands: { build: { args: [{ name: '<force>', type: 'bool' }], run(): void {} } },
				})
			)
		);

		await type(ui.stdin, ENTER);
		await type(ui.stdin, 'n', ENTER);

		expect((await answer).value?.argv).toEqual(['build', 'false']);
	});

	it('should spell a yesno confirm in the words that type takes', async () => {
		// `transformValue('true', 'yesno')` throws, which is the sharp edge of the
		// palette and the parser sharing one function
		const ui = screenSetup({ columns: 60, rows: 12 });
		const answer = settle(
			open(
				ui,
				await appState({
					commands: { build: { args: [{ name: '<ok>', type: 'yesno' }], run(): void {} } },
				})
			)
		);

		await type(ui.stdin, ENTER);
		await type(ui.stdin, ENTER);

		const argv = (await answer).value?.argv as string[];
		expect(argv).toEqual(['build', 'yes']);
	});

	it('should ask for a variadic argument one value per line', async () => {
		const ui = screenSetup({ columns: 60, rows: 12 });
		const answer = settle(
			open(ui, await appState({ commands: { build: { args: ['<files...>'], run(): void {} } } }))
		);

		await type(ui.stdin, ENTER);
		// the multiline field submits on Ctrl-D
		await type(ui.stdin, 'a.ts', ENTER, 'b.ts', '\u0004');

		expect((await answer).value?.argv).toEqual(['build', 'a.ts', 'b.ts']);
	});

	it('should ask for a required option, attached', async () => {
		const ui = screenSetup({ columns: 60, rows: 12 });
		const answer = settle(
			open(
				ui,
				await appState({
					commands: { build: { options: { '--port <n>': { type: 'int' } }, run(): void {} } },
				})
			)
		);

		await type(ui.stdin, ENTER);
		await type(ui.stdin, '8', '0', ENTER);

		expect((await answer).value?.argv).toEqual(['build', '--port=80']);
	});

	it('should produce an argv the parser takes', async () => {
		// the end-to-end claim: the palette types what you would have typed, so
		// what it answers with parses
		const ui = screenSetup({ columns: 60, rows: 12 });
		const schema: Schema = {
			commands: {
				build: {
					args: ['<entry>'],
					options: { '--port <n>': { type: 'int' } },
					run(): void {},
				},
			},
			help: false,
			name: 'mycli',
		};
		const answer = settle(open(ui, await appState(schema)));

		await type(ui.stdin, ENTER);
		await type(ui.stdin, 's', 'r', 'c', ENTER);
		await type(ui.stdin, '8', '0', ENTER);

		const { argv } = (await answer).value as { argv: string[] };
		const parsed = await parse({ argv, env: {}, schema });

		expect(parsed.cmd?.name).toBe('build');
		expect(parsed.argv).toMatchObject({ entry: 'src', port: 80 });
	});

	it("should produce an argv the parser takes with an ancestor's required option", async () => {
		// the end-to-end form of the review's own finding: `validateOptions()`
		// enforces a root-level required option when a subcommand runs, so a
		// palette that asked only about the command's own options handed over an
		// argv the parse refused with `Missing required options`
		const ui = screenSetup({ columns: 60, rows: 12 });
		const schema: Schema = {
			commands: { build: { run(): void {} } },
			help: false,
			name: 'mycli',
			options: { '--config <file>': {} },
		};
		const answer = settle(open(ui, await appState(schema)));

		await type(ui.stdin, ENTER);
		await type(ui.stdin, 'a', '.', 'j', 's', 'o', 'n', ENTER);

		const { argv } = (await answer).value as { argv: string[] };
		expect(argv).toEqual(['build', '--config=a.json']);

		const parsed = await parse({ argv, env: {}, schema });
		expect(parsed.cmd?.name).toBe('build');
		expect(parsed.argv).toMatchObject({ config: 'a.json' });
	});

	it('should ask for nothing with `prompt: false`', async () => {
		const ui = screenSetup({ columns: 60, rows: 12 });
		const answer = settle(
			open(ui, await appState({ commands: { build: { args: ['<entry>'], run(): void {} } } }), {
				prompt: false,
			})
		);

		await type(ui.stdin, ENTER);

		expect((await answer).value?.argv).toEqual(['build']);
		expect((await answer).value?.values).toEqual([[]]);
	});

	it('should find a command by its alias and show the label', async () => {
		const ui = screenSetup({ columns: 60, rows: 12 });
		const answer = settle(
			open(
				ui,
				await appState({
					commands: { 'migrate, up': { run(): void {} }, build: { run(): void {} } },
				})
			)
		);

		await type(ui.stdin, 'u', 'p');
		// the alias ranked it and is not shown: the highlight is over the label,
		// and an index past the end of what is being highlighted highlights
		// nothing. Read off the rows rather than the whole screen, because the
		// query itself is drawn in the head
		const rows = ui.log.filter((line) => line.includes('\u276f'));
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatch(/migrate/);
		expect(rows[0]).not.toMatch(/up/);
		await type(ui.stdin, ENTER);

		expect((await answer).value?.argv).toEqual(['migrate']);
	});

	it('should place the rows in rank order rather than in document order', async () => {
		// the `order` property, which the layout engine reads: `order` changes
		// where a child is placed and not where it lives. `z` ranks `zz` over
		// `az` -- a prefix hit -- while the registry is sorted the other way, so
		// this is the one shape where the two orders differ
		const ui = screenSetup({ columns: 40, rows: 12 });
		const answer = settle(
			open(ui, await appState({ commands: { az: { run(): void {} }, zz: { run(): void {} } } }))
		);

		await type(ui.stdin, 'z');
		const rows = ui.log.filter((line) => /\b(az|zz)\b/.test(line));
		expect(rows).toHaveLength(2);
		expect(rows[0]).toMatch(/zz/);
		expect(rows[1]).toMatch(/az/);

		await type(ui.stdin, ENTER);
		await answer;
	});

	it('should take a row off the screen when it stops matching', async () => {
		const ui = screenSetup({ columns: 40, rows: 12 });
		const answer = settle(
			open(ui, await appState({ commands: { az: { run(): void {} }, zz: { run(): void {} } } }))
		);

		await type(ui.stdin, 'z');
		expect(ui.log.join('\n')).toMatch(/az/);
		// `zz` keeps the place `az` had unless every row goes off first
		await type(ui.stdin, 'z');
		expect(ui.log.join('\n')).not.toMatch(/az/);

		await type(ui.stdin, ENTER);
		expect((await answer).value?.argv).toEqual(['zz']);
	});

	it('should rewrite a label rather than appending to it', async () => {
		const ui = screenSetup({ columns: 40, rows: 12 });
		const answer = settle(open(ui, await appState({ commands: { build: { run(): void {} } } })));

		// two draws over one row: the runs are rebuilt per query, so the box has
		// to be emptied first or the row reads `buildbuild`
		await type(ui.stdin, 'b', 'u');
		const rows = ui.log.filter((line) => line.includes('build'));
		expect(rows).toHaveLength(1);
		expect(rows[0]?.match(/build/g)).toHaveLength(1);

		await type(ui.stdin, ENTER);
		await answer;
	});

	it('should ask for an optional bool with something that can be left empty', async () => {
		// a confirm always answers, so using one for an optional slot would make
		// the declaration's own default unreachable
		const ui = screenSetup({ columns: 60, rows: 12 });
		const answer = settle(
			open(
				ui,
				await appState({
					commands: { build: { args: [{ name: '[force]', type: 'bool' }], run(): void {} } },
				})
			)
		);

		await type(ui.stdin, ENTER);
		await type(ui.stdin, ENTER);

		expect((await answer).value?.argv).toEqual(['build']);
	});

	it('should ask again for a required variadic slot answered with nothing', async () => {
		const ui = screenSetup({ columns: 60, rows: 12 });
		const answer = settle(
			open(ui, await appState({ commands: { build: { args: ['<files...>'], run(): void {} } } }))
		);

		await type(ui.stdin, ENTER);
		// Ctrl-D on an empty field submits nothing, which is not an answer
		await type(ui.stdin, '\u0004');
		await type(ui.stdin, 'a.ts', '\u0004');

		expect((await answer).value?.argv).toEqual(['build', 'a.ts']);
	});

	it('should stringify a choice that is not a string', async () => {
		const ui = screenSetup({ columns: 60, rows: 12 });
		const answer = settle(
			open(
				ui,
				await appState({
					commands: {
						build: {
							args: [{ choices: [1, 2], name: '<level>', type: 'int' }],
							run(): void {},
						},
					},
				})
			)
		);

		await type(ui.stdin, ENTER);
		await type(ui.stdin, DOWN, ENTER);

		expect((await answer).value?.argv).toEqual(['build', '2']);
	});

	it('should ask under a one-line message, whatever the description holds', async () => {
		const ui = screenSetup({ columns: 60, rows: 12 });
		const answer = settle(
			open(
				ui,
				await appState({
					commands: {
						build: { args: [{ desc: 'a\nb', name: '<entry>' }], run(): void {} },
					},
				})
			)
		);

		await type(ui.stdin, ENTER);
		// the newline is flattened, so the two halves are on one line
		expect(ui.log.join('\n')).toMatch(/-- a b/);

		await type(ui.stdin, 'x', ENTER);
		await answer;
	});

	it("should spell a yesno choice in that type's own vocabulary", async () => {
		// `transformValue('true', 'yesno')` throws, so offering a `yesno` choice of
		// `true` as `true` is the palette agreeing to a value the parse then
		// refuses. Found by review
		const ui = screenSetup({ columns: 60, rows: 12 });
		const schema: Schema = {
			commands: {
				build: {
					args: [{ choices: [true, false], name: '<ok>', type: 'yesno' }],
					run(): void {},
				},
			},
			help: false,
			name: 'mycli',
		};
		const answer = settle(open(ui, await appState(schema)));

		await type(ui.stdin, ENTER);
		expect(ui.log.join('\n')).toMatch(/\byes\b/);
		await type(ui.stdin, ENTER);

		const { argv } = (await answer).value as { argv: string[] };
		expect(argv).toEqual(['build', 'yes']);

		// and the whole point of it: the parse takes what the palette agreed to
		const parsed = await parse({ argv, env: {}, schema });
		expect(parsed.argv).toMatchObject({ ok: true });
	});

	it('should offer no choice the parser would refuse', async () => {
		// a `date` declaration with `choices` has no argv spelling the parser will
		// match, because `assertChoices()` compares a `Date` by identity -- so
		// every choice is left out and `select()` rejects by name rather than the
		// palette agreeing to a token that fails
		const ui = screenSetup({ columns: 60, rows: 12 });
		const answer = settle(
			open(
				ui,
				await appState({
					commands: {
						build: {
							args: [{ choices: [new Date('2024-01-01')], name: '<when>', type: 'date' }],
							run(): void {},
						},
					},
				})
			)
		);

		await type(ui.stdin, ENTER);

		expect((await answer).error?.message).toMatch(/no choices to offer/);
	});

	it('should not trim a variadic value, which the parser does not', async () => {
		// the palette types what you would have typed, and `processArgs()` does not
		// trim a positional value -- so a line of spaces is a value and leading
		// space is kept. Found by review
		const ui = screenSetup({ columns: 60, rows: 12 });
		const answer = settle(
			open(ui, await appState({ commands: { build: { args: ['<files...>'], run(): void {} } } }))
		);

		await type(ui.stdin, ENTER);
		await type(ui.stdin, ' a.ts', ENTER, ' ', '\u0004');

		expect((await answer).value?.argv).toEqual(['build', ' a.ts', ' ']);
	});

	it('should say why a variadic line was refused, and keep what was typed', async () => {
		// the loop discarded the parser's own message and reopened an empty field,
		// which is a field that refuses an answer without saying why. Found by
		// review
		const ui = screenSetup({ columns: 60, rows: 12 });
		const answer = settle(
			open(
				ui,
				await appState({
					commands: { build: { args: [{ name: '<n...>', type: 'int' }], run(): void {} } },
				})
			)
		);

		await type(ui.stdin, ENTER);
		await type(ui.stdin, 'eight', '\u0004');
		// the complaint is the parser's own, and `eight` is still in the field
		expect(ui.frame + ui.log.join('\n')).toMatch(/Invalid integer: eight/);
		expect(ui.frame).toMatch(/eight/);

		// fixing it in place, which is what `initial` is for
		await type(ui.stdin, BACKSPACE, BACKSPACE, BACKSPACE, BACKSPACE, BACKSPACE, '8', '\u0004');
		expect((await answer).value?.argv).toEqual(['build', '8']);
	});

	it('should not blank the list for a `rows` that is not a row count', async () => {
		// `Math.max(1, NaN)` is `NaN` and `rank >= NaN` is false for every row, so
		// the list went blank while the empty message stayed hidden.
		// `promptRowCap()` is the multiline field's own rule. Found by review
		for (const rows of [Number.NaN, 0, -1, 2.5, Number.POSITIVE_INFINITY]) {
			const ui = screenSetup({ columns: 40, rows: 12 });
			const answer = settle(
				open(ui, await appState({ commands: { build: { run(): void {} } } }), { rows })
			);

			await tick();
			expect(ui.log.join('\n'), `rows: ${rows}`).toMatch(/build/);

			await type(ui.stdin, ENTER);
			expect((await answer).value?.argv, `rows: ${rows}`).toEqual(['build']);
		}
	});

	it('should show whole rows for a fractional `rows`', async () => {
		const ui = screenSetup({ columns: 40, rows: 12 });
		const commands: Record<string, AnyCommand> = {};
		for (let i = 0; i < 8; i++) {
			commands[`cmd${i}`] = { run(): void {} };
		}
		const answer = settle(open(ui, await appState({ commands }), { rows: 2.5 }));

		await tick();
		expect(ui.log.filter((line) => line.includes('cmd'))).toHaveLength(2);

		await type(ui.stdin, ENTER);
		await answer;
	});

	it('should take the message the caller gave', async () => {
		const ui = screenSetup({ columns: 60, rows: 12 });
		const answer = settle(
			open(ui, await appState({ commands: { build: { run(): void {} } } }), {
				message: 'What now',
			})
		);

		await tick();
		expect(ui.log.join('\n')).toMatch(/What now/);
		await type(ui.stdin, ENTER);
		await answer;
	});

	it('should refuse a target with no context chain before it draws anything', async () => {
		const ui = screenSetup();
		await expect(open(ui, { contexts: [] } as unknown as ParseState)).rejects.toThrow(
			/context chain/
		);
		expect(ui.output).toBe('');
	});
});

describe('the palette with no terminal', () => {
	let warn: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
	});

	afterEach(() => {
		warn.mockRestore();
	});

	it('should fail loudly rather than waiting for a keystroke that cannot come', async () => {
		const ui = screenSetup({ isTTY: false });
		const settled = await settle(open(ui, await appState({ commands: { b: { run(): void {} } } })));
		expect(settled.error).toBeInstanceOf(PromptError);
		expect(settled.error?.aborted).toBe(false);
	});
});
