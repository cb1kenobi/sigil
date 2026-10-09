import { commandPalette } from '../../src/components/palette.js';
import { confirm, multiline, multiselect, text } from '../../src/components/prompt.js';
import { type Catalog, loadCatalog } from '../../src/i18n/index.js';
import { parse } from '../../src/parser/parse.js';
import type { ParseState, Schema } from '../../src/types.js';
import { screenSetup, tick } from './helpers.js';
import { afterEach, describe, expect, it } from 'vitest';

/**
 * What the prompts say, translated.
 *
 * A separate file from `prompt.test.ts` so that the 76 cases there stay the
 * regression suite for the component rewrite: an extraction or a translation
 * that needed one of those moved would be one that changed behaviour, and the
 * test moving is how that gets agreed to rather than noticed.
 *
 * The affordances are asserted through the *screen*, because what is being
 * claimed is what a reader sees -- `confirmKeys()`'s own arithmetic is asserted
 * directly in `i18n.test.ts`, which is the split this repository already keeps
 * between a function of a string and a component drawn in a terminal.
 */

/** Back to English with no loader map, which is the state every case starts from. */
afterEach(async () => {
	await loadCatalog(undefined, {});
});

/** Activates a catalog under a tag, the way an app's own loader map would. */
async function translated(catalog: Catalog, tag = 'de'): Promise<void> {
	await loadCatalog({ [tag]: async () => catalog }, {}, tag);
}

/**
 * Starts a prompt and reports how it settled.
 *
 * The handler is attached before any key is sent, which matters for the same
 * reason `prompt.test.ts` records: a prompt can reject while `type()` is still
 * awaiting, and a promise that rejects before anything is listening is an
 * unhandled rejection -- which vitest reports as an error even when every test
 * passes.
 *
 * @param promise - The prompt.
 * @returns Its answer, or the error it rejected with.
 */
function settle<T>(promise: Promise<T>): Promise<{ error?: unknown; value?: T }> {
	return promise.then(
		(value) => ({ value }),
		(error: unknown) => ({ error })
	);
}

/** Sends keys one at a time, letting the prompt act on each. */
async function type(stdin: { send(chunk: string): void }, ...chunks: string[]): Promise<void> {
	for (const chunk of chunks) {
		stdin.send(chunk);
		await tick();
	}
}

describe('a translated confirm', () => {
	it('should draw the pair the catalog named and accept its key', async () => {
		await translated({ 'y/n': 'j/n' });
		const ui = screenSetup({ columns: 40 });
		const answer = confirm({ ansi: ui.ansi, message: 'Fortfahren?', terminal: ui.terminal });

		await tick();
		expect(ui.frame).to.include('(J/n)');

		await type(ui.stdin, 'j');
		expect(await answer).to.equal(true);
	});

	it('should still accept y and n, which no hint has to name', async () => {
		// the hint naming a subset is the *safe* direction of incompleteness, and it
		// is the shape `bool` already has: six spellings of true and no hint names
		// them. What the rule refuses is a hint naming something that does not work.
		//
		// A pair naming *neither* English key, or this claims less than its name: a
		// `j/n` entry accepts `n` because the entry said so, which has nothing to do
		// with English being additive
		await translated({ 'y/n': 'j/k' });

		// the entry's own keys as well as English, or the catalog does no work here:
		// reverting `confirm()` to a hardcoded `ch === 'y'` would pass a case that
		// only ever presses `y` and `n`. Found by review
		for (const [key, value] of [
			['j', true],
			['k', false],
			['y', true],
			['n', false],
		] as const) {
			const ui = screenSetup({ columns: 40 });
			const answer = confirm({ ansi: ui.ansi, message: 'Fortfahren?', terminal: ui.terminal });

			await type(ui.stdin, key);
			expect(await answer, key).to.equal(value);
		}
	});

	it('should give one keypress one meaning where the pair took an English key', async () => {
		// the hint says `N` is yes, so that is what `n` does -- accepting English `n`
		// as no would make one key both answers
		await translated({ 'y/n': 'n/a' });
		const ui = screenSetup({ columns: 40 });
		const answer = confirm({ ansi: ui.ansi, message: 'Overwrite?', terminal: ui.terminal });

		await tick();
		expect(ui.frame).to.include('(N/a)');

		await type(ui.stdin, 'n');
		expect(await answer).to.equal(true);
	});

	it('should translate the answer it leaves in the log', async () => {
		await translated({ 'y/n': 'j/n', no: 'nein', yes: 'ja' });

		// both branches, or a mutation of one survives on the strength of the other
		for (const [key, expected] of [
			['j', 'ja'],
			['n', 'nein'],
		] as const) {
			const ui = screenSetup({ columns: 40 });
			const answer = confirm({ ansi: ui.ansi, message: 'Fortfahren?', terminal: ui.terminal });

			await type(ui.stdin, key);
			await answer;
			await tick();

			expect(ui.log.join('\n'), key).to.include(expected);
		}
	});

	it('should not read a modified key as an answer', async () => {
		// a modifier makes it a different key, which is the rule the key sequences
		// already keep: the hint says `Y`, not `ctrl-Y`
		const ui = screenSetup({ columns: 40 });
		let done = false;
		const answer = settle(
			confirm({ ansi: ui.ansi, message: 'Continue?', terminal: ui.terminal })
		).then((r) => {
			done = true;
			return r;
		});

		// Ctrl-Y, which `k.name` reports as `y`
		await type(ui.stdin, '\u0019');
		await tick();
		expect(done, 'ctrl-y answered the prompt').to.equal(false);

		// and the unmodified key still does
		await type(ui.stdin, 'y');
		expect((await answer).value).to.equal(true);
	});
});

describe('a translated multiline field', () => {
	it('should translate the submit hint, modifier and all', async () => {
		await translated({ '({0} to submit)': '({0} zum Absenden)', 'ctrl-{0}': 'Strg+{0}' });
		const ui = screenSetup({ columns: 60, rows: 10 });
		const answer = settle(
			multiline({ ansi: ui.ansi, message: 'Beschreiben', terminal: ui.terminal })
		);

		await tick();
		expect(ui.frame).to.include('(Strg+d zum Absenden)');

		await type(ui.stdin, '\u0003');
		await answer;
	});

	it('should translate every modifier shape, and leave a bare name alone', async () => {
		// each combination is a whole key rather than two translatable fragments, so a
		// translator sees `ctrl-alt-{0}` and writes `Strg+Alt+{0}` -- which also lets
		// them pick the separator. The key's *own* name stays English, because the
		// letter on the cap and `enter` are printed the same on every keyboard sold
		await translated({
			'({0} to submit)': '({0} zum Absenden)',
			'alt-{0}': 'Alt+{0}',
			'ctrl-alt-{0}': 'Strg+Alt+{0}',
			'ctrl-{0}': 'Strg+{0}',
		});

		for (const [submit, expected] of [
			[{ ctrl: true, name: 'd' }, '(Strg+d zum Absenden)'],
			[{ meta: true, name: 'enter' }, '(Alt+enter zum Absenden)'],
			[{ ctrl: true, meta: true, name: 's' }, '(Strg+Alt+s zum Absenden)'],
			// a bare name is its own label and no lookup, which `keyLabel()`'s own
			// comment records as true by construction rather than by this assertion
			[{ name: 'f2' }, '(f2 zum Absenden)'],
		] as const) {
			const ui = screenSetup({ columns: 60, rows: 10 });
			const answer = settle(
				multiline({
					ansi: ui.ansi,
					message: 'Beschreiben',
					submit,
					terminal: ui.terminal,
				})
			);

			await tick();
			expect(ui.frame, JSON.stringify(submit)).to.include(expected);

			await type(ui.stdin, '\u0003');
			await answer;
		}
	});

	it('should translate the line it leaves for an empty answer', async () => {
		await translated({ '(empty)': '(leer)' });
		const ui = screenSetup({ columns: 60, rows: 10 });
		const answer = multiline({ ansi: ui.ansi, message: 'Beschreiben', terminal: ui.terminal });

		await type(ui.stdin, '\u0004');
		expect(await answer).to.equal('');
		await tick();

		expect(ui.log.join('\n')).to.include('(leer)');
	});

	it('should select the plural category for the lines it did not show', async () => {
		// the second plural the framework has, after `Alias:` -- so the catalog
		// entry is an object of categories and `Intl.PluralRules` picks one
		await translated({
			'(+{0} more line)': { one: '(+{0} weitere Zeile)', other: '(+{0} weitere Zeilen)' },
		});

		for (const [typed, expected] of [
			['a\nb', '(+1 weitere Zeile)'],
			['a\nb\nc', '(+2 weitere Zeilen)'],
		] as const) {
			const ui = screenSetup({ columns: 60, rows: 10 });
			const answer = multiline({ ansi: ui.ansi, message: 'Beschreiben', terminal: ui.terminal });

			await type(ui.stdin, typed, '\u0004');
			await answer;
			await tick();

			expect(ui.log.join('\n'), typed).to.include(expected);
		}
	});
});

describe('a translated multiselect', () => {
	it('should translate its hint', async () => {
		await translated({
			'(space to select, enter to confirm)': '(Leertaste waehlt, Enter bestaetigt)',
		});
		const ui = screenSetup({ columns: 80, rows: 10 });
		const answer = settle(
			multiselect({
				ansi: ui.ansi,
				choices: ['eins', 'zwei'],
				message: 'Waehlen',
				terminal: ui.terminal,
			})
		);

		await tick();
		// the head rather than `frame`, which is the last row and for a list is a choice
		expect(ui.log.join('\n')).to.include('(Leertaste waehlt, Enter bestaetigt)');

		await type(ui.stdin, '\u0003');
		await answer;
	});

	it('should translate the complaint for an empty required selection', async () => {
		await translated({ 'Choose at least one': 'Mindestens eine waehlen' });
		const ui = screenSetup({ columns: 80, rows: 10 });
		const answer = settle(
			multiselect({
				ansi: ui.ansi,
				choices: ['eins', 'zwei'],
				message: 'Waehlen',
				required: true,
				terminal: ui.terminal,
			})
		);

		await type(ui.stdin, '\r');
		expect(ui.frame).to.include('Mindestens eine waehlen');

		await type(ui.stdin, '\u0003');
		await answer;
	});

	it('should translate the answer it leaves for nothing ticked', async () => {
		await translated({ none: 'keine' });
		const ui = screenSetup({ columns: 80, rows: 10 });
		const answer = multiselect({
			ansi: ui.ansi,
			choices: ['eins', 'zwei'],
			message: 'Waehlen',
			terminal: ui.terminal,
		});

		await type(ui.stdin, '\r');
		expect(await answer).to.deep.equal([]);
		await tick();

		expect(ui.log.join('\n')).to.include('keine');
	});
});

describe('a translated prompt that cannot be answered', () => {
	// three of the five `PromptError` messages are what a *user* sees, through
	// `errorHandler()`'s own translated `Error: {0}` frame -- so a German app that
	// cancelled a prompt printed `Fehler: Cancelled`, which is half a sentence.
	// The other two are a bug in the app and stay English
	it('should translate the message for an input that is not a terminal', async () => {
		await translated({
			'Cannot prompt for "{0}" because the input is not a terminal':
				'Kann "{0}" nicht fragen: die Eingabe ist kein Terminal',
		});
		const ui = screenSetup({ inputTTY: false });

		await expect(text({ ansi: ui.ansi, message: 'Name?', terminal: ui.terminal })).rejects.toThrow(
			'Kann "Name?" nicht fragen: die Eingabe ist kein Terminal'
		);
	});

	it('should translate the message for a stdin that ended', async () => {
		await translated({
			'Input ended before the prompt was answered': 'Eingabe endete vor der Antwort',
		});
		const ui = screenSetup();
		const answer = settle(text({ ansi: ui.ansi, message: 'Name?', terminal: ui.terminal }));

		await tick();
		ui.stdin.end();

		expect(((await answer).error as Error).message).to.equal('Eingabe endete vor der Antwort');
	});

	it('should translate the message for an abort', async () => {
		await translated({ Cancelled: 'Abgebrochen' });
		const ui = screenSetup();
		const answer = settle(text({ ansi: ui.ansi, message: 'Name?', terminal: ui.terminal }));

		await type(ui.stdin, '\u0003');

		expect(((await answer).error as Error).message).to.equal('Abgebrochen');
	});
});

describe('a translated command palette', () => {
	// the palette is not one of the six prompts, so the ticket's inventory missed
	// it -- and it borrows `runPrompt()` and draws affordances, so leaving it is
	// the English-in-the-middle-of-German the whole feature is about
	async function appState(schema: Schema): Promise<ParseState> {
		return parse({ argv: [], env: {}, schema: { help: false, name: 'mycli', ...schema } });
	}

	it('should translate the default message and the empty-list line', async () => {
		await translated({
			'No commands match': 'Kein Befehl passt',
			'Run a command': 'Befehl ausfuehren',
		});
		const ui = screenSetup({ columns: 60, rows: 10 });
		const answer = settle(
			commandPalette(await appState({ commands: { build: { run(): void {} } } }), {
				ansi: ui.ansi,
				terminal: ui.terminal,
			})
		);

		await tick();
		expect(ui.log.join('\n')).to.include('Befehl ausfuehren');

		// a query nothing ranks to, which is what the empty line is for
		await type(ui.stdin, 'zzzz');
		expect(ui.log.join('\n')).to.include('Kein Befehl passt');

		await type(ui.stdin, '\u0003');
		await answer;
	});

	it('should translate the entry an optional slot offers in place of a value', async () => {
		// built per call rather than at module scope, because a `const` there is
		// evaluated when the module is imported -- before `main()` loaded a catalog
		await translated({ '(skip)': '(ueberspringen)' });
		const ui = screenSetup({ columns: 60, rows: 12 });
		const answer = settle(
			commandPalette(
				await appState({
					commands: {
						build: { args: [{ choices: ['a', 'b'], name: '[mode]' }], run(): void {} },
					},
				}),
				{ ansi: ui.ansi, terminal: ui.terminal }
			)
		);

		await tick();
		await type(ui.stdin, '\r');

		expect(ui.log.join('\n')).to.include('(ueberspringen)');

		await type(ui.stdin, '\u0003');
		await answer;
	});
});
