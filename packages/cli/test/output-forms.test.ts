import { ESC, hasAnsi, strip } from '@ttylabs/sigil/ansi';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * The toolchain's two output forms, locked by spawning the real binary.
 *
 * `report.ts` prints a diagnostic two ways and the destination decides which: a
 * terminal gets the laid-out form -- coloured severity, a hanging indent, words
 * that never break mid-path -- and anything else gets `formatDiagnostic()`, one
 * line per diagnostic, so that `grep` and `awk -F:` still work. That split is
 * `tsc --pretty`'s and it exists because the first version of it wrapped
 * everything and **broke** `grep`: a message that wrapped between "string" and
 * "literal" is one `grep "a string literal"` no longer matches, measured 1 to 0
 * on the `app` fixture.
 *
 * Nothing in the suite asserted either half of that. `report.test.ts` reaches
 * `report.ts` directly, and has to -- a vitest worker's stderr has no `columns`
 * and no `isTTY`, so every render through `run()` comes out at the fallback
 * width with no colour, which is the one case that cannot fail. `check.test.ts`
 * and `build-command.test.ts` spy on `process.stderr.write` and assert on
 * substrings, which survives any amount of wrapping. And the byte-for-byte
 * promise was verified by diffing against a `main` worktree by hand, which is
 * not a check anybody runs twice. So the whole design could regress in silence,
 * and nearly did: `build`'s piped summary went from `, 2 warnings` to
 * ` (2 warnings)` and survived being written down as verified, because the
 * comparison had only ever been run against `check`.
 *
 * ## Properties, not bytes, and the reasoning is worth keeping
 *
 * The obvious way to lock a byte-for-byte promise is to snapshot the bytes, and
 * it is the wrong one. A snapshot's baseline is not "what this was before any of
 * it was rendered"; it is whatever was current the last time somebody
 * regenerated it -- and regenerating is exactly what a failing snapshot teaches
 * you to do. The one regression this file exists for is the proof: a snapshot
 * would have flagged ` (2 warnings)` and a regenerate would have blessed it,
 * because nothing in a snapshot says which of the two answers is right.
 *
 * So each claim is asserted as itself, which is the rule the canvas diff's own
 * tests already follow -- replay the output against a model rather than pin the
 * bytes, because asserting on bytes pins one implementation while replaying pins
 * what the implementation is for. Here that comes to five kinds of assertion:
 *
 * 1. **One line per record.** The piped form's non-empty stderr lines are
 *    counted, and every diagnostic among them has to match
 *    `file:line:column: severity: message`. A wrap anywhere in the piped form
 *    adds a line that is not a record, so the count is what catches it.
 * 2. **The grep case, derived rather than written down.** Every place the
 *    laid-out form broke a line is found by reading it, the phrase spanning that
 *    break is assembled, and the piped form has to contain it while the laid-out
 *    form must not. That is the 1-to-0 measurement above, automated, and it
 *    cannot go vacuous because the phrases come from where the wrapping actually
 *    happened rather than from a constant.
 * 3. **The two forms say the same words.** Take the colour off the laid-out
 *    form, collapse its whitespace, and it equals the piped form collapsed the
 *    same way. This is `report.ts`'s own claim -- "what differs is the wrapping
 *    and the colour" -- and it is what catches one form rewording while the
 *    other does not, or the location being rebuilt differently in one of them.
 * 4. **The grammar of the lines that a rewording would move.** The summary's
 *    comma is the site of the only regression this has actually had, so `, N
 *    warnings` is pinned as a shape. A snapshot could not have told the two
 *    apart; a regex saying which one is meant can.
 * 5. **Exit codes**, which are part of what a pipe consumer reads.
 *
 * What that deliberately does not catch is both forms being reworded together --
 * no property can, short of a baseline, and a baseline is the thing rejected
 * above. What it does catch is every failure mode the split exists to prevent.
 *
 * ## The terminal, without a pty
 *
 * Node has no pty and this repo has no pty dependency; adding one to read
 * `isTTY` back would be a dependency taken for a boolean. What `report.ts`
 * actually reads about a destination is `stream.isTTY` and `stream.columns`, and
 * nothing else -- `ReportStream` is those two fields. So the child is the real
 * binary, spawned with real pipes, preloaded with a module that defines `isTTY`
 * on its own streams the way a terminal answers it, and `COLUMNS` says the
 * width, which is what `terminalWidth()` documents it for. The preload is a
 * `data:` URL rather than a file, so the source of the fake sits beside the test
 * that explains it.
 *
 * What that does not prove is that node reports `isTTY` correctly for a real
 * pty, which is node's claim rather than this repo's, and it says nothing about
 * terminal modes -- `report.ts` writes plain lines and sets none.
 * `scripts/terminal-probe.mjs` is where this repo puts a claim only a real
 * terminal can falsify, and none of these is one.
 */

const pkg = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const bin = join(pkg, 'dist', 'sigil.mjs');
const fixtures = join(pkg, 'test', 'fixtures');

/**
 * The width both forms are measured at. `COLUMNS` outranks a stream's own
 * `columns` in `terminalWidth()`, which is how a test says a width without a
 * pseudo-terminal, and it is set for the piped runs too so that the `--tree`
 * table is the same table either way.
 */
const WIDTH = 80;

/** Narrow enough that a diagnostic gives up on two columns, which is `MIN_MESSAGE`. */
const NARROW = 40;

/**
 * What a build's output directory is called.
 *
 * Long on purpose, so that the path the summary reports is a word worth asking
 * about -- and named here rather than inline because the differential has to take
 * it back out: two builds write to two directories, so their summaries differ by
 * exactly that and by nothing else.
 */
const OUT_PREFIX = 'sigil-output-forms-a-deliberately-long-directory-';

/**
 * Everything `supportsColor()` reads, cleared so that a run says what it means.
 *
 * A CI runner sets `CI` and `GITHUB_ACTIONS`, a terminal sets `TERM` and often
 * `COLORTERM`, and any of them decides the level for a destination that claims
 * to be a TTY -- so a test that left them alone would assert a different colour
 * level on a laptop than on each of CI's nine combinations. `FORCE_COLOR` and
 * `NO_COLOR` outrank the stream entirely, which is the half that would change
 * the answer for the piped runs as well.
 */
const COLOUR_ENV = [
	'CI',
	'COLORTERM',
	'FORCE_COLOR',
	'GITEA_ACTIONS',
	'GITHUB_ACTIONS',
	'NO_COLOR',
	'TEAMCITY_VERSION',
	'TERM',
	'TERM_PROGRAM',
	'WT_SESSION',
] as const;

/**
 * A preload that makes a child's streams answer `isTTY` the way a terminal does.
 *
 * `Object.defineProperty` rather than an assignment, because a piped
 * `process.stdout` is not a `tty.WriteStream` and what it does with a write to a
 * property it never declared is not a thing to depend on.
 *
 * @param streams - Which of the child's streams claim to be a terminal.
 * @returns A `data:` URL for `--import`.
 */
function ttyPreload(streams: readonly ('stderr' | 'stdout')[]): string {
	const source = streams
		.map((s) => `Object.defineProperty(process.${s},"isTTY",{configurable:true,value:true});`)
		.join('');

	return `data:text/javascript,${encodeURIComponent(source)}`;
}

/** What a run of the binary came to. */
interface Ran {
	/** Its exit code. */
	code: number | null;
	/** What reached stderr: the diagnostics, the note and the summary. */
	err: string;
	/** What reached stdout: `--tree` and the chunk sizes. */
	out: string;
}

/** How to run it. */
interface RunOptions {
	/** The width to report, through `COLUMNS`. Defaults to 80. */
	columns?: number;
	/** Environment on top of the sanitised copy. */
	env?: Record<string, string>;
	/** Which streams claim to be a terminal. Defaults to none, which is a pipe. */
	tty?: readonly ('stderr' | 'stdout')[];
}

/**
 * Runs the built binary with both streams piped, whatever they claim to be.
 *
 * @param argv - The arguments.
 * @param opts - How to run it.
 * @returns What it wrote and how it exited.
 */
function sigil(argv: readonly string[], opts: RunOptions = {}): Promise<Ran> {
	const { columns = WIDTH, env: extra = {}, tty = [] } = opts;
	const env: Record<string, string | undefined> = { ...process.env };
	for (const name of COLOUR_ENV) {
		delete env[name];
	}
	env.COLUMNS = String(columns);
	if (tty.length) {
		// a terminal has a `TERM`, and without one a stream claiming to be a TTY
		// still detects level 0 -- so a test asserting colour would be asserting the
		// one thing that cannot happen
		env.TERM = 'xterm-256color';
	}
	Object.assign(env, extra);

	const args = tty.length ? ['--import', ttyPreload(tty), bin, ...argv] : [bin, ...argv];

	return new Promise<Ran>((settle, fail) => {
		const child = spawn(process.execPath, args, {
			cwd: pkg,
			env,
			stdio: ['ignore', 'pipe', 'pipe'],
		});
		let err = '';
		let out = '';
		const timer = setTimeout(() => {
			child.kill('SIGKILL');
			fail(new Error(`sigil ${argv.join(' ')} did not finish within 60s`));
		}, 60_000);

		child.stderr.on('data', (chunk: Buffer) => void (err += chunk.toString()));
		child.stdout.on('data', (chunk: Buffer) => void (out += chunk.toString()));
		child.on('error', (error) => {
			clearTimeout(timer);
			fail(error);
		});
		child.on('close', (code) => {
			clearTimeout(timer);
			settle({ code, err, out });
		});
	});
}

/** A diagnostic as the piped form writes one, which is what `awk -F:` reads. */
const DIAGNOSTIC = /^(\S+?):(\d+):(\d+): (error|warning): (.+)$/;

/**
 * The start of a diagnostic in either form.
 *
 * Looser than `DIAGNOSTIC` because the laid-out form's stacked case -- a
 * terminal too narrow for two columns -- puts the location and the severity on a
 * line with no message after them at all.
 */
const STARTS = /^\S.*?: (?:error|warning):/;

/** The lines with something on them. */
function nonEmpty(text: string): string[] {
	return text.split('\n').filter((line) => line !== '');
}

/** A rendered report with the sequences taken off, since a sequence takes no column. */
function plain(text: string): string[] {
	// `strip()` rather than a pattern of this file's own: what a sequence is has
	// one implementation and it is the library's
	return strip(text).split('\n');
}

/** Every word a run wrote, with the wrapping and the colour taken out. */
function words(text: string): string {
	return strip(text).replaceAll(/\s+/g, ' ').trim();
}

/**
 * The SGR parameters a render opened, whichever sequences they arrived in.
 *
 * The rule `report.test.ts` and the canvas diff's tests already follow: a
 * transition combines what it closes with what it opens, so yellow after dim is
 * `ESC[22;33m` rather than `ESC[33m`, and a test pinning the latter pins one
 * implementation of the transition rather than the claim that something was
 * drawn yellow.
 *
 * @param text - A rendered report.
 * @returns Every parameter it set.
 */
function sgr(text: string): Set<number> {
	// built from the exported `ESC` rather than written as an escape in a
	// character class, which is this repo's rule twice over: no raw control
	// character in source, and no `no-control-regex` suppression for a formatter
	// to detach from the line it was written over
	const sgrRE = new RegExp(`${ESC}\\[([\\d;]*)m`, 'g');
	const found = new Set<number>();
	for (const [, params] of text.matchAll(sgrRE)) {
		for (const part of (params ?? '').split(';')) {
			found.add(Number(part === '' ? '0' : part));
		}
	}

	return found;
}

/**
 * Every phrase the laid-out form broke, as a pipe would have written it.
 *
 * A continuation line in the laid-out form is an indented one: the hanging
 * indent in the two-column case, and the two-space indent in the stacked one.
 * The phrase spanning such a break is the last word above it joined to the first
 * word below -- which is precisely the phrase `grep` stops matching, and is the
 * only thing this has to know to check it.
 *
 * Derived rather than written down, so that it names wherever the wrapping
 * actually is. A constant would go stale against a reworded message and pass
 * while saying nothing.
 *
 * @param laidOut - The laid-out form, with or without colour.
 * @returns The phrases, in order.
 */
function wrapped(laidOut: string): string[] {
	const lines = plain(laidOut);
	const phrases: string[] = [];

	for (let i = 1; i < lines.length; i++) {
		const above = lines[i - 1]!;
		const below = lines[i]!;
		if (!/^\s+\S/.test(below) || above.trim() === '') {
			continue;
		}
		const last = above.trimEnd().split(/\s+/).at(-1);
		const first = below.trim().split(/\s+/)[0];
		if (last !== undefined && first !== undefined) {
			phrases.push(`${last} ${first}`);
		}
	}

	return phrases;
}

/**
 * Where the builds write. One each, and long on purpose.
 *
 * Long because the path a build reports is relative to the app, so a short
 * `tmpdir()` would leave the summary fitting on one line and the
 * does-not-break-a-path assertion with nothing to prove. One each because the
 * three builds are a single `Promise.all` and `sigil build` empties its output
 * directory: nesting the refused build's under another's is safe only because
 * `build` throws on a fatal diagnostic before it cleans, and a test that rests on
 * the order of two statements in another module is one that breaks when somebody
 * reorders them for a good reason.
 */
let out: string;
let out2: string;
let out3: string;

/** One output directory, named long for the reason above. */
function outDir(): string {
	return mkdtempSync(join(tmpdir(), OUT_PREFIX));
}

beforeAll(() => {
	out = outDir();
	out2 = outDir();
	out3 = outDir();
});

afterAll(() => {
	for (const dir of [out, out2, out3]) {
		rmSync(dir, { force: true, recursive: true });
	}
});

describe('the built binary', () => {
	it('should be there, because everything below spawns it', () => {
		// loud rather than skipped: `it.runIf` on a missing `dist/` turns every
		// assertion in this file into a pass, which is the failure a whole entry in
		// AGENTS.md is written about -- a glob that matches nothing exits zero.
		//
		// A *stale* `dist/` is the other half and is deliberately not checked here,
		// which is a decision rather than an oversight: two proxies for it were
		// written, measured, and both fired on correct code.
		//
		// mtimes -- every output against every input -- fail in a way `pnpm build`
		// cannot clear. A source file's timestamp moves without its content changing
		// on a branch switch, a `git stash pop`, a revert or a `cp` restore; turbo's
		// hash is then unchanged, so the rebuild the message asks for is a cache hit
		// that does not touch `dist/` at all, the mtimes never move, and the failure
		// is unsatisfiable. Measured on a pristine tree.
		//
		// Turbo's own hash is content-based and authoritative, and asking it
		// (`turbo run build --dry-run=json`) is still worse here, though for one
		// reason now rather than two. The reason that is gone: the hash used to be
		// sensitive to *any* modified file in the workspace and not only to the
		// task's declared `inputs`, so appending a comment to this very file flipped
		// both builds from HIT to MISS with `src/` untouched -- the guard would have
		// failed for whoever was editing the test, which is the one situation it runs
		// in most. That was the root manifest's `workspace:` dependencies putting
		// every file of both packages in turbo's global hash, it is fixed, and
		// AGENTS.md records it; a test edit is a cache hit now.
		//
		// The reason that remains is enough on its own: turbo says MISS after
		// `node src/sigil.ts build`, the package's own build command and the one to
		// reach for while working on the toolchain, because turbo only records what
		// turbo ran -- so the guard would fire on a `dist/` that is freshly and
		// correctly built. Combining it with the mtime screen does not help, since
		// that is the same build both of them misread.
		//
		// So there is no proxy available that is both satisfiable and quiet on correct
		// code, and a check that fires on correct code teaches people to ignore
		// checks -- which this file would be teaching about itself. What actually
		// guarantees a fresh `dist/` is the `test` script building first, and the rule
		// AGENTS.md already records: `@ttylabs/cli` needs a build before its tests
		// mean anything. The residual hazard is a bare `pnpm vitest run` on this file
		// after editing `src/` without rebuilding, which reads the previous binary and
		// passes; every sabotage recorded for this file was run with a rebuild in
		// between for exactly that reason.
		expect(existsSync(bin), `${bin} is missing; run \`pnpm build\``).toBe(true);
	});
});

describe('a pipe', () => {
	/**
	 * Each fixture and what its stderr is made of, line by line.
	 *
	 * Two counts rather than one because they say different things. `diagnostics`
	 * is how many lines carry a `file:line:column: severity: message`; `lines` is
	 * every non-empty line there is, so a wrap anywhere -- in a diagnostic, in the
	 * note, in the summary -- adds one and fails here. Written out rather than
	 * derived, because the numbers are the claim: one line per record.
	 *
	 * Neither survives a fixture growing a diagnostic, which is the right
	 * trade-off: that is a change somebody makes on purpose, and the alternative
	 * is a count derived from the output it is checking.
	 */
	const PIPED = [
		{
			// a `desc` nobody could read, then the no-tsconfig note, then the summary
			code: 0,
			diagnostics: 1,
			dir: join(fixtures, 'app'),
			lines: 3,
		},
		{
			// a real `tsc` error and the `baseDir` warning, then what `errorHandler()`
			// rendered. No note: this fixture is the one that is type-checked
			code: 1,
			diagnostics: 2,
			dir: join(fixtures, 'typecheck', 'broken'),
			lines: 3,
		},
		{
			// a computed `commands`, the note, then the error
			code: 1,
			diagnostics: 1,
			dir: join(fixtures, 'ts-app'),
			lines: 3,
		},
	] as const;

	const ran = new Map<string, Ran>();

	beforeAll(async () => {
		const results = await Promise.all(PIPED.map((f) => sigil(['check', f.dir])));
		for (const [i, result] of results.entries()) {
			ran.set(PIPED[i]!.dir, result);
		}
	}, 60_000);

	for (const fixture of PIPED) {
		const name = fixture.dir.slice(fixtures.length + 1).replaceAll('\\', '/');

		it(`should write one line per diagnostic for ${name}`, () => {
			const { err } = ran.get(fixture.dir)!;
			const lines = nonEmpty(err);

			// every record starts at column zero and is whole, which is what `grep`
			// and `awk -F:` rest on. A wrapped line would be an extra line here and
			// would match none of the shapes below
			expect(
				lines.filter((line) => DIAGNOSTIC.test(line)),
				err
			).toHaveLength(fixture.diagnostics);
			expect(lines, err).toHaveLength(fixture.lines);
		});

		it(`should keep every diagnostic parseable by awk -F: for ${name}`, () => {
			const { err } = ran.get(fixture.dir)!;
			const located = nonEmpty(err).filter((line) => DIAGNOSTIC.test(line));

			// the count first, because a filter that matches nothing passes every
			// assertion below it -- which is how a form that stopped being
			// `file:line:column:` at all would pass a test named for reading it
			expect(located, err).toHaveLength(fixture.diagnostics);

			for (const line of located) {
				const fields = line.split(':');
				expect(Number.isInteger(Number(fields[1])), line).toBe(true);
				expect(Number.isInteger(Number(fields[2])), line).toBe(true);
				expect(fields[3]?.trim(), line).toMatch(/^(error|warning)$/);
			}
		});

		it(`should carry no escape sequence for ${name}`, () => {
			const { err, out: stdout } = ran.get(fixture.dir)!;

			expect(hasAnsi(err), err).toBe(false);
			expect(hasAnsi(stdout), stdout).toBe(false);
		});

		it(`should end its lines with a bare newline for ${name}`, () => {
			// asserted rather than tolerated. The first version of this file stripped a
			// trailing `\r` on the way in, on the theory that a line ending is not what
			// these tests are about -- which would have let a switch to CRLF pass in
			// silence, and a `\r` on the last field is exactly what `awk -F:` hands back
			// to whoever is reading it. A pipe gets `\n`, which is the rule the
			// plain-text path already keeps: a carriage return in a log file is not a
			// line ending anybody asked for
			const { err, out: stdout } = ran.get(fixture.dir)!;

			expect(err, 'a carriage return reached stderr').not.toContain('\r');
			expect(stdout, 'a carriage return reached stdout').not.toContain('\r');
		});

		it(`should exit ${fixture.code} for ${name}`, () => {
			expect(ran.get(fixture.dir)!.code).toBe(fixture.code);
		});
	}

	it('should say what the app is and how it went, on one line', () => {
		// the comma rather than a parenthetical, which is the one regression this
		// has actually had: `build`'s summary went from `, 2 warnings` to
		// ` (2 warnings)` and was written down as verified, because the byte
		// comparison had only ever been run against `check`. The runs are joined by
		// a space off a terminal, so the comma rides on the run before it
		const { err } = ran.get(join(fixtures, 'app'))!;

		expect(nonEmpty(err).at(-1)).toMatch(/^fixture-app \(index\.ts\): \d+ commands, 1 warning$/);
	});
});

describe('a terminal', () => {
	const app = join(fixtures, 'app');
	const broken = join(fixtures, 'typecheck', 'broken');
	let laidOut: Ran;
	let piped: Ran;
	let stacked: Ran;
	let brokenLaidOut: Ran;
	let brokenPiped: Ran;
	let colourless: Ran;

	beforeAll(async () => {
		[laidOut, piped, stacked, brokenLaidOut, brokenPiped, colourless] = await Promise.all([
			sigil(['check', app], { tty: ['stderr', 'stdout'] }),
			sigil(['check', app]),
			sigil(['check', app], { columns: NARROW, tty: ['stderr', 'stdout'] }),
			sigil(['check', broken], { tty: ['stderr', 'stdout'] }),
			sigil(['check', broken]),
			sigil(['check', app], { env: { NO_COLOR: '1' }, tty: ['stderr', 'stdout'] }),
		]);
	}, 60_000);

	it('should wrap a message in the column it started in', () => {
		const lines = plain(laidOut.err);
		const first = lines.findIndex((line) => DIAGNOSTIC.test(line));

		expect(first, laidOut.err).toBeGreaterThanOrEqual(0);

		// the hanging indent: the message column starts where the location and the
		// severity end, and every line after the first starts there too
		const prefix = /^(\S+?:\d+:\d+: (?:error|warning): )/.exec(lines[first]!)![1]!;
		const continuations = lines.slice(first + 1).filter((line) => /^\s+\S/.test(line));

		expect(continuations.length, laidOut.err).toBeGreaterThan(0);
		for (const line of continuations) {
			expect(line.slice(0, prefix.length), line).toBe(' '.repeat(prefix.length));
			expect(line[prefix.length], line).not.toBe(' ');
		}
	});

	it('should keep a phrase the wrapping broke on one line in the pipe', () => {
		// the 1-to-0 measurement, automated. `grep "a string literal"` stopped
		// matching the moment the wrap fell between "string" and "literal", and
		// these are every such phrase this render produced
		const phrases = wrapped(laidOut.err);

		expect(phrases.length, laidOut.err).toBeGreaterThan(0);
		for (const phrase of phrases) {
			expect(strip(laidOut.err), `the terminal broke ${phrase}`).not.toContain(phrase);
			expect(piped.err, `the pipe kept ${phrase}`).toContain(phrase);
		}
	});

	it('should colour the severity', () => {
		const opened = sgr(laidOut.err);

		// 33 is yellow, which `.cli-warning` sets, and 2 is the dim the location
		// carries. Parameters rather than bytes, for the reason `sgr()` records
		expect(opened, laidOut.err).toContain(33);
		expect(opened, laidOut.err).toContain(2);
	});

	it('should colour an error differently from a warning', () => {
		const opened = sgr(brokenLaidOut.err);

		// 31 is red, which `.cli-error` sets. This fixture has one of each, so both
		// are on screen at once and the two classes cannot have collapsed into one
		expect(opened, brokenLaidOut.err).toContain(31);
		expect(opened, brokenLaidOut.err).toContain(33);
	});

	it('should never break a path across lines', () => {
		// the case that has broken twice. The `baseDir` warning names the directory
		// each side would resolve against, and a path broken mid-token is the one
		// sentence whose whole job is to say which directory. It overflows the line
		// instead, which is the rule the location prefix and help's own labels
		// already follow -- and it is the overflow that makes "whole, on one line"
		// the entire claim: a path that was broken appears on no line at all, and one
		// that `text-overflow` cut appears on none either.
		//
		// The first version of this also asserted that the line was wider than the
		// terminal, which is true here and is a claim about the *checkout's* own path
		// length rather than about the report: the line is the 24-column hanging
		// indent plus the path, so a repository at `/code/sigil` fails it on a build
		// with nothing wrong. Measured, not guessed -- 56 characters of fixture path
		// is where it turns over
		const path = join(fixtures, 'typecheck', 'broken').replaceAll('\\', '/');
		const holding = plain(brokenLaidOut.err).filter((line) => line.includes(path));

		// this render really did wrap, or the whole assertion is about the piped form
		// wearing the laid-out form's name
		expect(wrapped(brokenLaidOut.err).length, brokenLaidOut.err).toBeGreaterThan(0);
		expect(holding, brokenLaidOut.err).toHaveLength(1);
	});

	it('should stack the message under the location when two columns will not fit', () => {
		// below `MIN_MESSAGE` the location takes the line on its own and the message
		// is indented under it, which is what help's list does at the same threshold
		const lines = plain(stacked.err);
		const first = lines.findIndex((line) => STARTS.test(line));

		expect(first, stacked.err).toBeGreaterThanOrEqual(0);
		expect(lines[first], stacked.err).toMatch(/: warning:$/);
		expect(lines[first + 1], stacked.err).toMatch(/^ {2}\S/);
	});

	it('should say the same words as the pipe', () => {
		// `report.ts`'s own claim: what differs is the wrapping and the colour. Take
		// both out and the two forms are one report -- which is what catches either
		// of them rewording on its own, and the location being rebuilt rather than
		// coming from `diagnosticLocation()`
		expect(words(laidOut.err)).toBe(words(piped.err));
		expect(words(brokenLaidOut.err)).toBe(words(brokenPiped.err));
		expect(words(stacked.err)).toBe(words(piped.err));
	});

	it('should still lay a report out under NO_COLOR', () => {
		// the other half of the `FORCE_COLOR` case, and the direction AGENTS.md is
		// most emphatic about: `NO_COLOR` on a real terminal means "no colour", not
		// "no layout", and a report that unwrapped itself over it would be reading one
		// setting as though it were another. So the wrapping is the terminal's and the
		// colour is gone -- which is exactly what keying the layout on the colour
		// level instead would break, and that tidy-up is the one the sheet says must
		// not be taken
		// laid out, asserted rather than assumed: with no terminal at all both sides
		// are the piped form and the comparison below holds while saying nothing
		expect(wrapped(colourless.err).length, colourless.err).toBeGreaterThan(0);
		expect(hasAnsi(colourless.err), colourless.err).toBe(false);
		expect(strip(laidOut.err)).toBe(colourless.err);
	});

	it('should exit the way the pipe does', () => {
		expect(laidOut.code).toBe(piped.code);
		expect(brokenLaidOut.code).toBe(brokenPiped.code);
	});
});

describe('--tree', () => {
	const app = join(fixtures, 'app');
	let piped: Ran;
	let bare: Ran;
	let forced: Ran;
	let split: Ran;

	beforeAll(async () => {
		[piped, bare, forced, split] = await Promise.all([
			sigil(['check', app, '--tree']),
			sigil(['check', app]),
			sigil(['check', app, '--tree'], { env: { FORCE_COLOR: '3' } }),
			// a terminal on stdout and a pipe on stderr, which is `sigil check
			// --tree 2>log.txt` run from a terminal
			sigil(['check', app, '--tree'], { tty: ['stdout'] }),
		]);
	}, 60_000);

	it('should put the tree on stdout and change nothing about stderr', () => {
		// the tree is data somebody asked for and the diagnostics are not, so a tree
		// can be piped without losing the problems -- and asking for one must not
		// change the form the problems arrive in
		expect(piped.out).toContain('Command');
		expect(piped.err).toBe(bare.err);
		expect(hasAnsi(piped.out), piped.out).toBe(false);
	});

	it('should colour the tree and not the diagnostics under FORCE_COLOR', () => {
		// the two knobs are independent on purpose: layout follows `isTTY` and
		// colour follows the level, so `FORCE_COLOR=3 sigil check --tree | cat` is a
		// coloured table on stdout and plain one-line diagnostics on stderr. It
		// looks like an inconsistency and is the opposite -- keying the laid-out
		// form on the colour level would make `NO_COLOR` on a real terminal unwrap
		// every diagnostic, which is reading one setting as though it were another
		expect(sgr(forced.out), forced.out).toContain(1);
		expect(hasAnsi(forced.err), forced.err).toBe(false);
		expect(nonEmpty(forced.err).filter((line) => DIAGNOSTIC.test(line))).toHaveLength(1);
		expect(nonEmpty(forced.err)).toHaveLength(3);
	});

	it('should ask the stream it is going to rather than the process', () => {
		// stdout is a terminal here and stderr is not, so the table takes colour and
		// the diagnostics stay one line each. `supportsColor()` defaults to
		// `process.stdout` whoever is asking, so a report reaching for the process's
		// own styler would fill that redirect with sequences while being perfectly
		// right about the wrong stream
		expect(hasAnsi(split.out), split.out).toBe(true);
		expect(hasAnsi(split.err), split.err).toBe(false);
		expect(nonEmpty(split.err)).toHaveLength(3);
		expect(split.err).toBe(bare.err);
	});
});

describe('sigil build', () => {
	const app = join(fixtures, 'app');
	const broken = join(fixtures, 'typecheck', 'broken');
	let piped: Ran;
	let laidOut: Ran;
	let refused: Ran;

	beforeAll(async () => {
		[piped, laidOut, refused] = await Promise.all([
			sigil(['build', app, '--out', out]),
			sigil(['build', app, '--out', out2], { tty: ['stderr', 'stdout'] }),
			sigil(['build', broken, '--out', out3]),
		]);
	}, 60_000);

	it('should write one line per diagnostic and one summary', () => {
		// the fixture's unreadable `desc`, the no-tsconfig note, then the summary
		expect(
			nonEmpty(piped.err).filter((line) => DIAGNOSTIC.test(line)),
			piped.err
		).toHaveLength(1);
		expect(nonEmpty(piped.err), piped.err).toHaveLength(3);
		expect(hasAnsi(piped.err), piped.err).toBe(false);
		expect(piped.code).toBe(0);
	});

	it('should end its summary with the comma form, not a parenthetical', () => {
		// this is the line that regressed. `, N warnings` is what `main` printed and
		// the runs are joined by a space off a terminal, so the comma rides on the
		// run before it; ` (N warnings)` was the first version of the rendered form
		// and it reached the pipe
		expect(nonEmpty(piped.err).at(-1)).toMatch(/ into \S+, 1 warning$/);
	});

	it('should say the same words as the terminal', () => {
		// the two builds wrote to two directories, so the paths differ by exactly
		// that and by nothing else -- taken out by the directory's *name*, because
		// the summary reports it relative to the app and the absolute string is
		// therefore not in the text at all when `TMPDIR` happens to sit under the
		// fixture
		const shorn = (text: string): string =>
			words(text).replaceAll(new RegExp(`${OUT_PREFIX}[^/\\s]*`, 'g'), '<out>');

		expect(shorn(piped.err)).toBe(shorn(laidOut.err));
	});

	it('should never break the path it wrote to', () => {
		// a summary ends in a path, and `paragraph()` would have broken it: it gives
		// each word `min-width: 0` on purpose, so a word too long for the line is
		// broken rather than left to run off the edge. That is right for prose and
		// wrong for every line here
		// the trailing comma is part of the word rather than one of its own, which is
		// the same decision the summary's comma is: a run is a word, and a lone comma
		// would be drawn with a space in front of it
		const path = plain(laidOut.err)
			.flatMap((line) => line.trim().split(/\s+/))
			.find((word) => /fixture-app\.mjs,?$/.test(word));

		// the same guard the diagnostic's path test carries, and for the same reason:
		// an unwrapped summary does not break a path either, so without this the
		// assertion would hold of the piped form wearing the laid-out form's name
		expect(wrapped(laidOut.err).length, laidOut.err).toBeGreaterThan(0);
		// and the same claim, for the same reason: a path that was broken is a word
		// ending in something else, so there is nothing to find. Asserting that the
		// word is wider than the terminal looked safe here -- the directory is named
		// long on purpose -- and is the same environment dependence one line along,
		// because the summary reports the path *relative to the app*: with `TMPDIR`
		// inside the fixture it comes to 72 columns and a correct build fails
		expect(path, laidOut.err).toBeDefined();
	});

	it('should refuse an app that does not check out, in the piped form', () => {
		// `build` runs `check`'s pass, so its diagnostics are the same diagnostics
		// and arrive in the same form -- which is what stops the two coming to
		// disagree about what a valid app is
		// two diagnostics and what `errorHandler()` rendered, which is three lines
		expect(
			nonEmpty(refused.err).filter((line) => DIAGNOSTIC.test(line)),
			refused.err
		).toHaveLength(2);
		expect(nonEmpty(refused.err), refused.err).toHaveLength(3);
		expect(refused.err).toContain('TS2322');
		expect(hasAnsi(refused.err), refused.err).toBe(false);
		expect(refused.code).toBe(1);
	});
});
