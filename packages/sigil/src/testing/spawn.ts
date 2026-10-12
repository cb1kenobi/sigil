import { cells, delay } from './numbers.js';
import { spawn } from 'node:child_process';

/**
 * Running a whole program on something that claims to be a terminal.
 *
 * ## Why this exists, which is the part nobody derives
 *
 * **A test runner's streams are pipes.** A vitest worker's stdout and stderr
 * have no `isTTY` and no `columns`, so everything that asks about a destination
 * gets the same answer: not a terminal, no colour, the fallback width. That is
 * the one case that cannot fail. A suite can therefore be entirely green and say
 * nothing at all about what a user's terminal gets -- and the author will not
 * notice, because the test they wrote passes.
 *
 * It is not a hypothetical. In this repository the split between a report's
 * laid-out form and its one-line form had every test pass while only the piped
 * half had ever been looked at, and a regression in the other half shipped and
 * was written down as verified.
 *
 * ## Why a child process, and why no pty
 *
 * Node has no pty and this package has no dependency to add one; taking one to
 * read a boolean back is a dependency taken for a boolean. What a program reads
 * about its destination is `isTTY`, `columns` and `rows` on a stream, so the
 * child is the **real** program over **real** pipes, preloaded with a module
 * that defines those three the way a terminal answers them.
 *
 * What that does not prove is that node reports `isTTY` correctly for a real
 * pty, which is node's claim rather than this one's, and it says nothing about
 * terminal *modes* -- raw mode, bracketed paste, mouse reporting. A claim only a
 * real terminal can falsify belongs in a script somebody runs by hand against
 * the terminals they care about.
 *
 * ## The traps
 *
 * **The environment decides the colour, not the stream.** A stream claiming to
 * be a terminal with no `TERM` behind it still detects level 0, so a test
 * asserting colour would be asserting the one thing that cannot happen -- and in
 * the other direction a CI runner sets `CI` and `GITHUB_ACTIONS`, either of
 * which decides the level for a destination that claims to be a TTY. So every
 * variable the detection reads is cleared, `TERM` is set when a stream claims to
 * be one, and `color` is how a run says what it wants.
 *
 * **Chunks split mid-character.** A `data` event is a `Buffer` of whatever
 * arrived, which for a frame full of multi-byte glyphs can end in the middle of
 * one -- so the buffers are concatenated and decoded once rather than decoded
 * per chunk, which is where a `U+FFFD` in an assertion comes from.
 *
 * ## What it deliberately does not do
 *
 * It does not write to the child's stdin, so a **prompt** is not what to spawn.
 * A prompt needs keys delivered over time and the far end held open: write and
 * close, and the router reports the stream ended and the prompt rejects with
 * exactly that. `createTestTerminal()` is the answer for a prompt -- in-process,
 * no child, and `press()` delivers a key at a time.
 */

/**
 * Every variable that decides what a run looks like, cleared so it says what it
 * means.
 *
 * Three groups rather than one, and the second and third were missing: the
 * colour **level** is what `supportsColor()` reads, the colour **scheme** is
 * `SIGIL_COLOR_SCHEME` and `COLORFGBG`, and whether anything animates is
 * `SIGIL_REDUCED_MOTION`. A child that drew a table or a help screen with the
 * parent's scheme left behind would come out light on a developer's machine and
 * dark on CI -- which is the same failure `CI` and `FORCE_COLOR` are cleared
 * for, one property along. Found by review.
 */
const COLOUR_ENV = [
	'CI',
	'COLORFGBG',
	'COLORTERM',
	'FORCE_COLOR',
	'GITEA_ACTIONS',
	'GITHUB_ACTIONS',
	'NO_COLOR',
	'SIGIL_COLOR_SCHEME',
	'SIGIL_REDUCED_MOTION',
	'TEAMCITY_VERSION',
	'TERM',
	'TERM_PROGRAM',
	'WT_SESSION',
] as const;

/** Which of the child's streams a run can fake. */
export type FakeableStream = 'stderr' | 'stdout';

/** What to run, and what the child should believe about its streams. */
export interface TerminalRunOptions {
	/** Arguments, after the module. */
	readonly argv?: readonly string[];
	/**
	 * What colour level to force, or `false` for none at all.
	 *
	 * Omitted, the child detects from `TERM` -- which is `xterm-256color` when
	 * anything claims to be a terminal and unset otherwise, so the default is
	 * level 2 on a terminal and level 0 on a pipe. A number is `FORCE_COLOR` and
	 * `false` is `NO_COLOR`, which outranks everything including a real terminal.
	 */
	readonly color?: 0 | 1 | 2 | 3 | false;
	/** The width to report, through `COLUMNS` and the faked `columns`. Defaults to 80. */
	readonly columns?: number;
	/** The working directory. Defaults to the parent's. */
	readonly cwd?: string;
	/** Environment on top of the sanitised copy of the parent's. */
	readonly env?: Readonly<Record<string, string | undefined>>;
	/** The module to run. Exactly one of this and `source`. */
	readonly run?: string;
	/** The rows to report. Defaults to 24. */
	readonly rows?: number;
	/** An ES module to run inline. Exactly one of this and `run`. */
	readonly source?: string;
	/** How long to wait before killing it. Defaults to 30 seconds. */
	readonly timeout?: number;
	/**
	 * Which streams claim to be a terminal. `true` is both, `false` is neither.
	 *
	 * Defaults to `true`, because a terminal is what this is for -- and `false`
	 * is the control a differential needs, since the interesting assertion is
	 * usually that the two forms differ in the right way rather than that either
	 * one is a particular string.
	 */
	readonly tty?: boolean | readonly FakeableStream[];
}

/** What a run came to. */
export interface RanOnTerminal {
	/** Its exit code, or `null` when a signal ended it. */
	readonly code: number | null;
	/** Everything it wrote to stderr. */
	readonly err: string;
	/** Everything it wrote to stdout. */
	readonly out: string;
	/** The signal that ended it, if one did. */
	readonly signal: NodeJS.Signals | null;
}

/**
 * A copy of the parent's environment with every colour variable taken out.
 *
 * Matched case-insensitively, which is a Windows spelling rather than
 * belt-and-braces: `process.env` is case-insensitive *there* and a spread of it
 * is an ordinary object, so a `Ci` the OS handed over survives
 * `delete env.CI` -- and a run that was supposed to detect from `TERM` alone
 * would be deciding from a variable it meant to clear, on one platform of the
 * three. Over-clearing is the safe direction: nothing reads a lowercase `ci`,
 * and `env` puts back anything a run needs.
 *
 * @returns The environment to give the child, before `env` goes on top.
 */
function sanitised(): Record<string, string | undefined> {
	const names = new Set<string>(COLOUR_ENV);
	const env: Record<string, string | undefined> = {};

	for (const [name, value] of Object.entries(process.env)) {
		if (!names.has(name.toUpperCase())) {
			env[name] = value;
		}
	}

	return env;
}

/**
 * Which streams the run fakes, from whichever spelling was used.
 *
 * @param tty - What the caller asked for.
 * @returns The streams, which may be none.
 */
function streamsOf(tty: TerminalRunOptions['tty']): readonly FakeableStream[] {
	if (tty === undefined || tty === true) {
		return ['stderr', 'stdout'];
	}
	if (tty === false) {
		return [];
	}
	// refused rather than taken as it comes, because each name reaches the
	// generated preload as a **property reference**: `tty: 'stdout'` is a string,
	// which `.map()` walks a character at a time into `process.s`, and
	// `tty: ['stdout;console.log(1)//']` is arbitrary code in the child. Neither
	// is reachable from TypeScript and both are one typo away from untyped
	// JavaScript, which a test file is. Found by review
	// `Array.isArray` first, and it is not subsumed by the name check below: a
	// `tty: 42` is not iterable, so the spread throws `number is not iterable`
	// from inside this function rather than naming the option
	if (!Array.isArray(tty)) {
		throw new Error(`runOnTerminal() takes \`tty\` as a boolean or an array, not ${typeof tty}`);
	}
	// a copy rather than the caller's own array, so that what is returned is ours
	// -- a dedupe was here and is inert, because `Object.defineProperty` with
	// `configurable: true` is idempotent, so a stream named twice is one
	// definition written twice
	const names = [...tty];
	for (const name of names) {
		if (name !== 'stderr' && name !== 'stdout') {
			throw new Error(
				`runOnTerminal() can fake \`stdout\` and \`stderr\`, not ${JSON.stringify(name)}`
			);
		}
	}
	return names;
}

/**
 * A module that makes the child's streams answer the way a terminal does.
 *
 * `Object.defineProperty` rather than an assignment, because a piped
 * `process.stdout` is not a `tty.WriteStream` and what it does with a write to a
 * property it never declared is not a thing to depend on. A `data:` URL rather
 * than a file, so there is no temporary path to clean up and nothing
 * platform-specific about where it lives.
 *
 * @param streams - Which streams to fake.
 * @param columns - The width to report.
 * @param rows - The height to report.
 * @returns A URL for `--import`.
 */
function preload(streams: readonly FakeableStream[], columns: number, rows: number): string {
	const source = streams
		.map((name) =>
			(
				[
					['isTTY', 'true'],
					['columns', String(columns)],
					['rows', String(rows)],
				] as const
			)
				.map(
					([field, value]) =>
						`Object.defineProperty(process.${name},${JSON.stringify(field)},` +
						`{configurable:true,value:${value}});`
				)
				.join('')
		)
		.join('');

	return `data:text/javascript,${encodeURIComponent(source)}`;
}

/**
 * Runs a module in a child whose streams claim to be a terminal.
 *
 * `async` so that every refusal is a rejection: a function that returns a
 * promise and *sometimes* throws synchronously is one a caller has to guard
 * twice, and `.catch()` is the guard they will write.
 *
 * @param opts - What to run and what to fake.
 * @returns What it wrote and how it ended.
 * @throws If neither or both of `run` and `source` were given, or if it had to
 *   be killed.
 */
export async function runOnTerminal(opts: TerminalRunOptions): Promise<RanOnTerminal> {
	// a size is refused where it is wrong and a delay falls back, which is two
	// rules because they are two kinds of value: a width is the caller's whole
	// statement about the screen the child believes it has -- silently using 80
	// hides the mistake -- while every timer option in this library takes the
	// default for a value that is not an instruction. `numbers.ts` has both
	// arguments: without them, `columns: NaN` reaches the child as a `columns` of
	// `NaN`, and `timeout: Infinity` asks for the longest wait there is and gets a
	// millisecond, because node stores a delay as a signed 32-bit integer.
	//
	// And `=== undefined` rather than `??`, because `null` is exactly the value
	// the guard exists for: `opts.columns ?? 80` silently used 80 for it, which is
	// the mistake `cells()` is there to name rather than hide
	const columns = opts.columns === undefined ? 80 : cells(opts.columns, 'columns');
	const rows = opts.rows === undefined ? 24 : cells(opts.rows, 'rows');
	const timeout = delay(opts.timeout, 30_000);

	// refused where it is written rather than resolved by preferring one: two
	// answers to "what is being run" have no right one to pick between, and a
	// silent preference is a run that ignored half of what it was handed.
	//
	// An **empty** one counts as not given, which is the half the first version
	// missed: `''` is not `undefined`, so `run: ''` passed the test and spawned
	// `node ''`, and `source: ''` spawned a module that does nothing and exits
	// zero -- a run that looks like it worked
	const named = [opts.run, opts.source].filter((value) => value !== undefined && value !== '');
	if (named.length !== 1) {
		throw new Error(
			'runOnTerminal() takes exactly one of `run` and `source`, and not an empty one'
		);
	}

	const streams = streamsOf(opts.tty);
	const env = sanitised();
	// both routes a program might ask by, which is the pair `bash` and `resize`
	// set: `COLUMNS` and `LINES` in the environment, and `columns` and `rows` on
	// the stream through the preload. Nothing in this library reads `LINES` -- a
	// terminal's height comes off `stdout.rows` -- so it is here for the app under
	// test, and a fixture that set one of each pair would be lying about one of
	// the two routes
	env.COLUMNS = String(columns);
	env.LINES = String(rows);
	if (streams.length > 0) {
		// a terminal has a `TERM`, and without one a stream claiming to be a TTY
		// still detects level 0 -- so a run asserting colour would be asserting the
		// one thing that cannot happen
		env.TERM = 'xterm-256color';
	}
	if (opts.color === false) {
		env.NO_COLOR = '1';
	} else if (opts.color !== undefined) {
		env.FORCE_COLOR = String(opts.color);
	}
	// applied over whatever casing the environment already had, because
	// `process.env` is case-insensitive on Windows: `Object.assign` with a `Term`
	// over a `TERM` leaves **two** keys for one variable in the block handed to
	// `spawn`, and which one the child sees is unspecified. `env` still goes on
	// top, which is what makes it the escape hatch for a variable the sanitising
	// cleared. Found by review
	for (const [name, value] of Object.entries(opts.env ?? {})) {
		for (const existing of Object.keys(env)) {
			if (existing !== name && existing.toUpperCase() === name.toUpperCase()) {
				delete env[existing];
			}
		}
		env[name] = value;
	}

	const args = streams.length > 0 ? ['--import', preload(streams, columns, rows)] : [];
	args.push(
		...(opts.source === undefined
			? [opts.run as string]
			: ['--input-type=module', '-e', opts.source]),
		...(opts.argv ?? [])
	);

	return new Promise<RanOnTerminal>((settle, fail) => {
		const child = spawn(process.execPath, args, {
			cwd: opts.cwd,
			env,
			// `shell` is deliberately left off: a shell would mean quoting rules that
			// differ per platform, over arguments a test wrote as strings
			stdio: ['ignore', 'pipe', 'pipe'],
		});

		// collected as bytes and decoded once, because a `data` event can end in the
		// middle of a multi-byte character
		const out: globalThis.Buffer[] = [];
		const err: globalThis.Buffer[] = [];
		const timer = setTimeout(() => {
			child.kill('SIGKILL');
			fail(new Error(`runOnTerminal() did not finish within ${timeout}ms`));
		}, timeout);

		child.stdout.on('data', (chunk: globalThis.Buffer) => void out.push(chunk));
		child.stderr.on('data', (chunk: globalThis.Buffer) => void err.push(chunk));
		child.on('error', (error) => {
			clearTimeout(timer);
			fail(error);
		});
		child.on('close', (code, signal) => {
			clearTimeout(timer);
			settle({
				code,
				err: globalThis.Buffer.concat(err).toString('utf8'),
				out: globalThis.Buffer.concat(out).toString('utf8'),
				signal,
			});
		});
	});
}
