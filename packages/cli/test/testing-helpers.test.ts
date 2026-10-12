import { ESC, strip } from '@ttylabs/sigil/ansi';
import { text } from '@ttylabs/sigil/components';
import {
	createTestTerminal,
	KEYS,
	runCommand,
	runOnTerminal,
	Screen,
} from '@ttylabs/sigil/testing';
import * as testing from '@ttylabs/sigil/testing';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';

/**
 * The shipped fixture against a real binary, which is the claim it exists for.
 *
 * `test/testing/spawn.test.ts` in the runtime asks the child what it believes
 * about itself -- that the fake took. This asks the question a user has: given
 * the fake, can a test see the thing a pipe cannot? The answer has to be a
 * *differential*, because neither form is a particular string worth pinning:
 * `sigil check` lays a report out for a terminal -- coloured severity, a hanging
 * indent, words that never break mid-path -- and writes one line per diagnostic
 * to anything else, so `grep` and `awk -F:` still work.
 *
 * Nothing in this repository's suite could assert either half of that until the
 * fixture existed, and the half that was never looked at is where a regression
 * shipped: `build`'s piped summary went from `, 2 warnings` to ` (2 warnings)`
 * and survived being written down as verified. `output-forms.test.ts` is the
 * regression suite for the two forms and keeps its own spawner; this is the
 * narrower claim that the *helper* is enough to have caught it.
 *
 * Needs a built `dist/`, like everything else in this package.
 */

const pkg = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const bin = join(pkg, 'dist', 'sigil.mjs');
const broken = join(pkg, 'test', 'fixtures', 'typecheck', 'broken');

beforeAll(() => {
	expect(existsSync(bin), `no ${bin}; run \`pnpm build\``).toBe(true);
});

/** `sigil check` over a fixture that has something to say, on a destination. */
function check(tty: boolean, columns = 80): Promise<{ code: number | null; err: string }> {
	return runOnTerminal({
		argv: ['check', broken],
		columns,
		cwd: pkg,
		run: bin,
		tty: tty ? ['stderr'] : false,
	});
}

describe('the helpers through the published subpath', () => {
	/*
	 * Imported by name rather than from `src/`, which is the half the runtime's
	 * own suite cannot check: everything in `packages/sigil/test/testing/` reaches
	 * these through vite, so it proves the source and says nothing about the
	 * `exports` map, the bundle, or whether `runCommand()` still reaches the
	 * `main()` that was bundled with it. This package is where a test that needs
	 * `dist/` belongs.
	 */

	it('should run a command through the bundled main()', async () => {
		const ran = await runCommand({
			argv: ['hello', 'world'],
			schema: {
				commands: {
					hello: {
						args: [{ name: '[who]' }],
						desc: 'Greet',
						run: ({ argv }) => void process.stdout.write(`hi ${argv.who as string}\n`),
					},
				},
				name: 'demo',
			},
		});

		expect(ran.out).toBe('hi world\n');
		expect(ran.argv.who).toBe('world');
		expect(ran.code).toBe(0);
	});

	it('should drive a prompt over the bundled terminal', async () => {
		const ui = createTestTerminal({ columns: 30 });
		const answer = text({ message: 'Name?', terminal: ui.terminal });

		await ui.press('chris', KEYS.enter);

		expect(await answer).toBe('chris');
		expect(ui.lines).toEqual(['? Name? chris']);
	});

	it('should name every export in the README', () => {
		// the whole ticket is that this knowledge was undiscoverable from outside
		// the repository, so an export nobody can find is that complaint one level
		// in -- `screenStream` was exactly that until this was written. Read off the
		// **bundle** rather than the barrel source, so a re-export added without a
		// sentence is caught too
		// the **`## Testing` section** rather than the whole file, which is what
		// made the first version of this nearly vacuous: a bare `includes()` over
		// the README matched `tick` in `bar.tick()`, `alt` in `alt-{0}` and `ctrl`
		// in `ctrl-{0}` -- all of them somebody else's prose hundreds of lines
		// away -- so deleting every mention of the helper left it green. Found by
		// review, and it is this ticket's own complaint applied to its own guard
		// line endings normalized first, because the checkout's are the
		// platform's: git converts to CRLF on Windows, so a search embedding a
		// bare `\n` finds the `\r` and answers -1 -- which is this repo's own
		// rule that a test never writes a separator, met on the line axis rather
		// than the path one. Caught by CI on all three Windows jobs and nowhere
		// else
		const readme = readFileSync(join(pkg, '..', 'sigil', 'README.md'), 'utf8').replaceAll(
			'\r\n',
			'\n'
		);
		const start = readme.indexOf('\n## Testing\n');
		const end = readme.indexOf('\n## ', start + 1);

		expect(start, 'the README has no `## Testing` section').toBeGreaterThan(0);
		expect(end, 'the `## Testing` section runs to the end of the file').toBeGreaterThan(start);

		const section = readme.slice(start, end);
		const missing = Object.keys(testing).filter((name) => !section.includes(name));

		expect(missing).toEqual([]);

		// and every field of every option and result shape, read off the
		// **declarations** -- an option nobody can find is the same complaint as an
		// export nobody can find, and four of them were missing until this looked
		const declared = new Set(
			[
				...readFileSync(join(pkg, '..', 'sigil', 'dist', 'testing.d.mts'), 'utf8').matchAll(
					/readonly (\w+)\??:/g
				),
			].map(([, name]) => name as string)
		);

		expect([...declared].filter((name) => !section.includes(name))).toEqual([]);
		expect(declared.size).toBeGreaterThan(20);
		// and the other half, because an empty list passes trivially if the import
		// ever stops resolving
		expect(Object.keys(testing).length).toBeGreaterThan(5);
	});

	it('should read a wide cluster through the bundled screen', () => {
		const screen = new Screen(6, 1);

		screen.write('日本語');

		expect(screen.viewport[0]).toBe('日本語');
		expect(screen.cellAt(1, 0)).toBe('');
	});
});

describe('the fixture over the real toolchain', () => {
	it('should see colour a pipe cannot', async () => {
		const [terminal, piped] = await Promise.all([check(true), check(false)]);

		// this is the whole of what a test runner's streams make invisible: the
		// piped run is the only answer a worker's own stderr can ever give
		// built from the exported `ESC` rather than written as an escape, which is
		// this repository's rule twice over: no raw control character in source --
		// the formatter normalizes `\u001B` into one -- and no suppression for a
		// formatter to detach from the line it was written over
		const sequence = new RegExp(`${ESC}\\[`);

		expect(terminal.err).toMatch(sequence);
		expect(piped.err).not.toMatch(sequence);
	}, 60_000);

	it('should say the same words either way', async () => {
		const [terminal, piped] = await Promise.all([check(true), check(false)]);

		// `report.ts`'s own claim -- what differs is the wrapping and the colour --
		// and what catches one form rewording while the other does not
		const words = (text: string): string => strip(text).replaceAll(/\s+/g, ' ').trim();

		expect(words(terminal.err)).toBe(words(piped.err));
		expect(terminal.code).toBe(piped.code);
	}, 60_000);

	it('should keep one line per diagnostic for a pipe, and wrap for a terminal', async () => {
		// narrow enough that the laid-out form has to wrap, which is what breaks a
		// `grep` for a phrase and is why the split exists at all
		const [terminal, piped] = await Promise.all([check(true, 44), check(false, 44)]);

		const lines = (text: string): string[] =>
			strip(text)
				.split('\n')
				.filter((line) => line !== '');

		expect(lines(terminal.err).length).toBeGreaterThan(lines(piped.err).length);

		// every piped line that *is* a diagnostic is a whole one: the location, the
		// severity and the message on one line, which is what `awk -F:` reads. A
		// looser pattern was the first spelling of this and was nearly vacuous --
		// `|\S` matches almost any line, so it would have passed over a wrapped
		// form entirely. The note and the summary are not diagnostics and are
		// skipped by asking only about the lines that carry a severity
		const records = lines(piped.err).filter((line) => / (?:error|warning): /.test(line));

		expect(records.length).toBeGreaterThan(0);
		for (const line of records) {
			expect(line).toMatch(/^\S+:\d+:\d+: (?:error|warning): \S.*$/);
		}
	}, 60_000);
});
