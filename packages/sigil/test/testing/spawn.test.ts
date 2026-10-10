import { runOnTerminal } from '../../src/testing/spawn.js';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * `runOnTerminal()`, which is the fixture a test runner cannot do without.
 *
 * A vitest worker's streams are pipes: no `isTTY`, no `columns`. So every render
 * through a command comes out at the fallback width with no colour, which is the
 * one case that cannot fail -- a suite can be entirely green and say nothing at
 * all about what a user's terminal gets. These spawn the child the fixture
 * builds and ask it what it believes about itself, which is the only thing that
 * can say the fake works.
 *
 * The sources import nothing, so none of this needs a build: what is under test
 * is the environment the child is given, not anything the package does with it.
 */

/** What the child reports about itself, printed as JSON for one read. */
const REPORT = `
process.stdout.write(JSON.stringify({
	columns: process.stdout.columns ?? null,
	err: process.stderr.isTTY ?? false,
	envColumns: process.env.COLUMNS ?? null,
	envLines: process.env.LINES ?? null,
	force: process.env.FORCE_COLOR ?? null,
	noColor: process.env.NO_COLOR ?? null,
	out: process.stdout.isTTY ?? false,
	rows: process.stdout.rows ?? null,
	term: process.env.TERM ?? null,
}));
`;

interface Report {
	columns: number | null;
	envColumns: string | null;
	envLines: string | null;
	err: boolean;
	force: string | null;
	noColor: string | null;
	out: boolean;
	rows: number | null;
	term: string | null;
}

/** Runs `REPORT` and reads what came back. */
async function report(opts: Parameters<typeof runOnTerminal>[0] = {}): Promise<Report> {
	const ran = await runOnTerminal({ source: REPORT, ...opts });
	expect(ran.err, 'the child wrote to stderr').toBe('');
	expect(ran.code).toBe(0);
	return JSON.parse(ran.out) as Report;
}

describe('runOnTerminal()', () => {
	it('should make both streams answer the way a terminal does', async () => {
		const seen = await report({ columns: 120, rows: 40 });

		expect(seen.out).toBe(true);
		expect(seen.err).toBe(true);
		expect(seen.columns).toBe(120);
		expect(seen.rows).toBe(40);
	});

	it('should leave the streams as pipes when asked for none', async () => {
		// the control a differential needs: the interesting assertion is usually
		// that the two forms differ in the right way, which needs both halves
		const seen = await report({ tty: false });

		expect(seen.out).toBe(false);
		expect(seen.err).toBe(false);
		expect(seen.columns).toBeNull();
	});

	it('should fake only the streams it was named', async () => {
		const seen = await report({ columns: 55, tty: ['stderr'] });

		expect(seen.err).toBe(true);
		expect(seen.out).toBe(false);
		// and the size on a stream it was **not** named, which is the half the
		// README's table used to overclaim: `COLUMNS` is always set and a stream's
		// own `columns` is faked only where `tty` named it, so a run that fakes
		// stderr alone leaves `stdout.columns` as the pipe's own -- which is
		// nothing. `testing-helpers.test.ts`'s terminal run is exactly this shape
		expect(seen.envColumns).toBe('55');
		expect(seen.columns).toBeNull();
	});

	it('should set COLUMNS as well, which is what outranks a stream', async () => {
		// `terminalWidth()` reads `COLUMNS` over a stream's own `columns`, which is
		// how a test says a width without a pseudo-terminal -- and it is set for a
		// piped run too, so that a differential compares one width
		const piped = await report({ columns: 55, rows: 9, tty: false });

		expect(piped.envColumns).toBe('55');
		// `LINES` with it, which is the pair `bash` and `resize` set. Nothing in
		// this library reads it -- a terminal's height comes off `stdout.rows` --
		// so it is set for the app under test, and a fixture that told the child
		// its size one of the two ways would be lying about the other
		expect(piped.envLines).toBe('9');
	});

	it('should give a terminal a TERM, because without one the colour is 0', async () => {
		// the trap this fixture exists to close: a stream claiming to be a terminal
		// with no `TERM` behind it still detects level 0, so a test asserting colour
		// would be asserting the one thing that cannot happen
		const seen = await report();

		expect(seen.term).toBe('xterm-256color');
	});

	it('should give a pipe no TERM at all', async () => {
		const seen = await report({ tty: false });

		expect(seen.term).toBeNull();
	});

	it('should clear what a CI runner sets, which would decide the colour', async () => {
		// `CI` and `GITHUB_ACTIONS` are set on every one of this repository's nine
		// CI combinations, and either decides the level for a destination claiming
		// to be a TTY -- so a fixture that left them alone would assert a different
		// colour on a laptop than on CI
		// set in the *parent* first, or the assertion is vacuous on a laptop: these
		// are set on every one of this repository's nine CI combinations and on
		// almost no development machine, so a test that only read them back would
		// pin the clearing on CI and nothing at all locally
		process.env.CI = 'true';
		process.env.GITHUB_ACTIONS = 'true';
		process.env.COLORTERM = 'truecolor';
		try {
			const ran = await runOnTerminal({
				env: { SIGIL_FIXTURE_MARKER: 'kept' },
				source: `process.stdout.write(JSON.stringify([
					process.env.CI ?? null,
					process.env.GITHUB_ACTIONS ?? null,
					process.env.COLORTERM ?? null,
					process.env.SIGIL_FIXTURE_MARKER ?? null,
				]));`,
			});

			// the parent's own environment is otherwise kept, which is what `PATH`
			// and `HOME` depend on, and `env` goes on top
			expect(JSON.parse(ran.out)).toEqual([null, null, null, 'kept']);
		} finally {
			delete process.env.CI;
			delete process.env.GITHUB_ACTIONS;
			delete process.env.COLORTERM;
		}
	});

	it('should clear a colour variable however the platform cased it', async () => {
		// `process.env` is case-insensitive on Windows and a spread of it is an
		// ordinary object, so a `Ci` the OS handed over survives `delete env.CI` --
		// and the run would then be deciding from a variable it meant to clear, on
		// one platform of the three
		process.env.Ci = 'true';
		try {
			const ran = await runOnTerminal({
				source: `process.stdout.write(JSON.stringify(
					Object.keys(process.env).filter((k) => k.toUpperCase() === 'CI')
				));`,
			});

			expect(JSON.parse(ran.out)).toEqual([]);
		} finally {
			delete process.env.Ci;
		}
	});

	it('should let env put back a variable it cleared, which is the escape hatch', async () => {
		// the clearing is what makes a run say what it means, and an app under test
		// may need one of those variables to be something in particular -- so `env`
		// goes on *top* of the sanitised copy rather than under it
		const seen = await report({ env: { TERM: 'dumb' } });

		expect(seen.term).toBe('dumb');
	});

	it('should force a colour level when one is asked for', async () => {
		const seen = await report({ color: 3 });

		expect(seen.force).toBe('3');
		expect(seen.noColor).toBeNull();
	});

	it('should turn colour off when asked, which outranks the terminal', async () => {
		const seen = await report({ color: false });

		expect(seen.noColor).toBe('1');
		expect(seen.force).toBeNull();
	});

	it('should pass arguments after the module', async () => {
		const ran = await runOnTerminal({
			argv: ['one', '--two'],
			source: 'process.stdout.write(JSON.stringify(process.argv.slice(1)));',
		});

		expect(JSON.parse(ran.out)).toEqual(['one', '--two']);
	});

	it('should report the exit code and stderr separately', async () => {
		const ran = await runOnTerminal({
			source: `process.stderr.write('to stderr'); process.exitCode = 3;`,
		});

		expect(ran).toEqual({ code: 3, err: 'to stderr', out: '', signal: null });
	});

	it('should run a module from a path', async () => {
		const ran = await runOnTerminal({
			// `fileURLToPath()` rather than `.pathname`, which on Windows is
			// `/C:/...` and is a path nothing can run -- and this is a test that
			// would pass on two of the three platforms CI runs
			run: fileURLToPath(new URL('fixtures/says-tty.mjs', import.meta.url)),
		});

		expect(ran.out.trim()).toBe('tty=true');
	});

	it('should decode output that spans a chunk boundary', async () => {
		// a `data` event is a `Buffer` of whatever arrived, which for a frame full
		// of multi-byte glyphs can end in the middle of one -- so the buffers are
		// concatenated and decoded once. Decoded per chunk, a split lands as
		// `U+FFFD` and an assertion about what was drawn is wrong about one cell
		const ran = await runOnTerminal({
			// well past any pipe buffer, so it certainly arrives in several reads
			source: `process.stdout.write('\\u{1F600}\\u65E5'.repeat(40000));`,
		});

		expect(ran.out).not.toContain('�');
		expect(ran.out.length).toBe(40_000 * 3);
	});

	it.each([
		['a string', 'stdout'],
		['a number', 42],
		['a name it cannot fake', ['stdin']],
		['a name with code in it', ['stdout;console.log(1)//']],
	])('should refuse %s as tty, which reaches the preload as a reference', async (_what, tty) => {
		// each name is interpolated into a generated module as a **property
		// reference**: a string is walked a character at a time into `process.s`,
		// and a name with a semicolon in it is arbitrary code in the child. Neither
		// is reachable from TypeScript and both are one typo away from untyped
		// JavaScript, which a test file is
		await expect(
			runOnTerminal({ source: 'void 0;', tty: tty as unknown as boolean })
		).rejects.toThrow(/runOnTerminal\(\) (?:takes `tty`|can fake)/);
	});

	it('should accept a stream named twice, which is one definition twice', async () => {
		// not a dedupe claim: `Object.defineProperty` with `configurable: true` is
		// idempotent, so the answer is the same either way. What this pins is that
		// a duplicate is not an error
		const seen = await report({ tty: ['stdout', 'stdout'] });

		expect(seen.out).toBe(true);
		expect(seen.err).toBe(false);
	});

	it.each([
		['an empty module path', { run: '' }],
		['an empty source', { source: '' }],
	])('should refuse %s, which is not an answer either', async (_what, over) => {
		// `''` is not `undefined`, so it passed the test and spawned `node ''` --
		// or, for a source, a module that does nothing and exits zero, which is a
		// run that looks like it worked
		await expect(runOnTerminal(over)).rejects.toThrow(/exactly one/);
	});

	it.each([
		['a width of null', { columns: null }],
		['a height of null', { rows: null }],
		['a width past a safe integer', { columns: 1e20 }],
	])('should refuse %s', async (_what, over) => {
		// `opts.columns ?? 80` silently used 80 for a `null`, which is the mistake
		// `cells()` exists to name rather than hide -- and `Number.isInteger(1e20)`
		// is true, where a screen of 1e20 columns is an allocation nothing survives
		await expect(
			runOnTerminal({ source: 'void 0;', ...(over as Record<string, number>) })
		).rejects.toThrow(/whole number of cells/);
	});

	it('should take the default over a timeout of zero, which is not a wait', async () => {
		// `setTimeout(fn, 0)` fires on the next tick and kills the child before it
		// has written anything, so `timeout: 0` read as "no wait" and did the
		// opposite. There is deliberately no way to turn the watchdog off
		const ran = await runOnTerminal({ source: `process.stdout.write('ok');`, timeout: 0 });

		expect(ran.out).toBe('ok');
	});

	it('should clear the colour scheme and the motion preference as well', async () => {
		// the level is what `supportsColor()` reads; the scheme and whether
		// anything animates are two more things the parent's environment decides,
		// and a child that drew a help screen with the parent's scheme left behind
		// would come out light on a laptop and dark on CI
		process.env.SIGIL_COLOR_SCHEME = 'light';
		process.env.COLORFGBG = '0;15';
		process.env.SIGIL_REDUCED_MOTION = 'reduce';
		try {
			const ran = await runOnTerminal({
				source: `process.stdout.write(JSON.stringify([
					process.env.SIGIL_COLOR_SCHEME ?? null,
					process.env.COLORFGBG ?? null,
					process.env.SIGIL_REDUCED_MOTION ?? null,
				]));`,
			});

			expect(JSON.parse(ran.out)).toEqual([null, null, null]);
		} finally {
			delete process.env.SIGIL_COLOR_SCHEME;
			delete process.env.COLORFGBG;
			delete process.env.SIGIL_REDUCED_MOTION;
		}
	});

	it('should not leave two casings of one variable in the block', async () => {
		// `process.env` is case-insensitive on Windows, so an `Object.assign` of a
		// `Term` over a `TERM` leaves two keys for one variable and which one the
		// child sees is unspecified
		const ran = await runOnTerminal({
			env: { Term: 'dumb' },
			source: `process.stdout.write(JSON.stringify(
				Object.keys(process.env).filter((k) => k.toUpperCase() === 'TERM')
			));`,
		});

		expect(JSON.parse(ran.out)).toEqual(['Term']);
	});

	it('should refuse to run neither or both of a module and a source', async () => {
		// two answers to "what is being run" have no right one to pick between, and
		// a silent preference is a run that ignored half of what it was handed
		await expect(runOnTerminal({})).rejects.toThrow(/exactly one/);
		await expect(runOnTerminal({ run: 'x.mjs', source: 'x' })).rejects.toThrow(/exactly one/);
	});

	it.each([
		['a width that is not a number', { columns: Number.NaN }],
		['a fractional width', { columns: 40.5 }],
		['zero columns', { columns: 0 }],
		['a height that is not a number', { rows: Number.NaN }],
	])('should refuse %s rather than telling the child nonsense', async (_what, over) => {
		// a size is the caller's whole statement about the screen the child
		// believes it has, so silently using 80 hides the mistake -- and without
		// this the preload defines `columns` as `NaN` and the child reads it
		await expect(runOnTerminal({ source: 'void 0;', ...over })).rejects.toThrow(
			/whole number of cells/
		);
	});

	it.each([
		['one that is not a number', Number.NaN],
		['an infinite one', Number.POSITIVE_INFINITY],
		['a negative one', -1],
	])('should take the default timeout over %s', async (_what, timeout) => {
		// `Infinity >= 0` is true and node stores a delay as a signed 32-bit
		// integer, so a timeout that is not an instruction used to ask for the
		// longest wait there is and get a millisecond -- which kills the child
		// before it has written anything
		const ran = await runOnTerminal({ source: `process.stdout.write('ok');`, timeout });

		expect(ran.out).toBe('ok');
	});

	it('should clamp a timeout past what a timer can hold', async () => {
		// a *finite* one past 2^31-1 is clamped rather than thrown away, because a
		// caller who wrote it meant "as long as possible" and the ceiling is the
		// nearest answer there is
		const ran = await runOnTerminal({
			source: `process.stdout.write('ok');`,
			timeout: 2_147_483_648,
		});

		expect(ran.out).toBe('ok');
	});

	it('should kill a run that never finishes, rather than hanging the suite', async () => {
		await expect(
			runOnTerminal({
				source: 'setInterval(() => {}, 1000);',
				timeout: 300,
			})
		).rejects.toThrow(/did not finish within 300ms/);
	});
});
