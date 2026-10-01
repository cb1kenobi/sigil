import { strip } from '@ttylabs/sigil/ansi';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * A mouse report printed to the screen is what a *stuck* mouse looks like, and
 * iTerm2 watches for exactly that.
 *
 * SIG-128. Clicking inside `terminal-probe.mjs --mouse` made iTerm2 offer
 * "Looks like mouse reporting was left on when an ssh session ended
 * unexpectedly or an app misbehaved. Turn it off?" -- during a run that was
 * reading the reports and behaving correctly. The leading guess was the main
 * screen, on the theory that an app which wants the mouse is almost always on
 * the alternate buffer. The guess was wrong, and reading the source settled it:
 *
 * - `-[PTYSession writeMouseReport:]` (sources/PTYSession/PTYSession.m:14245)
 *   calls `detectTurdsForReportData:type:` for every report iTerm2 sends,
 *   gated on the `AutodetectMouseReportingStuck` advanced setting, which is
 *   **default YES** and whose own description says it "watches for parts of
 *   mouse reporting control sequences being printed to the screen".
 * - `detectTurdsForReportData:type:` (PTYSession.m:14258) reduces the report to
 *   its printable residue -- drop the `ESC` and the two bytes after it
 *   ("Shells generally swallow esc and two characters after it, then echo the
 *   rest"), drop every byte under 32, keep the last 32 of what is left -- and,
 *   if that is **more than 6 characters**, arms a regular expression over the
 *   program's screen text with a **100ms** deadline.
 * - A match reaches `didDetectTurdOfType:` (PTYSession.m:14320) and then the
 *   announcement.
 *
 * Nothing in that chain reads the alternate screen. The one place it could have
 * -- `triggerEvaluatorShouldUseTriggers` (VT100ScreenMutableState.m:7567), which
 * turns triggers off in interactive apps -- falls through to the profile's
 * `Enable Triggers in Interactive Apps`, which defaults to `@YES`
 * (iTermProfilePreferences.m:1281). So the detector runs on the alternate buffer
 * too, and where the app draws has nothing to do with it.
 *
 * What the probe was doing was printing `"ESC [<0;41;13M"`, which holds
 * `0;41;13M` -- the residue, verbatim -- within 50ms of the report, because the
 * raw step's whole job is to show the bytes. iTerm2 was reading the stream
 * correctly; the probe was the one app that has to print a report and so the one
 * app that looked stuck. It prints `"ESC [ < 0 ; 41 ; 13 M"` now, which is how
 * this repository spells a sequence in prose anyway.
 *
 * Measured rather than reasoned: the three mouse demos never put a residue on
 * screen (they print `(39, 11)`), and the probe's raw step put one there for
 * every report that arrived.
 *
 * ## Why this spawns
 *
 * `show()` is a local function inside a hand-run script, and the claim is about
 * what reaches a *screen* rather than about what a function returns -- so the
 * test is the real thing: the probe, spawned, fed a report, with the screen text
 * read back. The probe refuses to run unless both streams are a terminal, which
 * is a boolean rather than a pty, so a preload defines `isTTY` and stubs raw
 * mode -- the technique `output-forms.test.ts` already uses, and a `data:` URL
 * for the same reason, so the source of the fake sits beside the test.
 *
 * It lives in this package because the probe imports `packages/sigil/dist/`, and
 * a test that needs `dist/` lives where the build has already run.
 */

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const probe = join(root, 'packages', 'sigil', 'scripts', 'terminal-probe.mjs');

/**
 * The probe loads `packages/sigil/dist/input.mjs`, so a missing build is a 20s
 * poll that ends in an assertion about a step that never ran. Said here instead,
 * which is the rule `cli.test.ts` already follows about this package's tests
 * needing a build first.
 */
const built = join(root, 'packages', 'sigil', 'dist', 'input.mjs');

const ESC = String.fromCharCode(0x1b);

/** A press at column 41, row 13, which is an SGR report with no modifiers. */
const PRESS = `${ESC}[<0;41;13M`;

/** Its release, which iTerm2 reduces to the same residue bar the final byte. */
const RELEASE = `${ESC}[<0;41;13m`;

/**
 * iTerm2's residue, transcribed from
 * `-[PTYSession detectTurdsForReportData:type:]` (PTYSession.m:14273-14297).
 *
 * Transcribed rather than hard-coded, so that the rule the ticket settled is in
 * the repository as something that runs. It is also what says `0;1;1M` -- a
 * press in the top-left corner -- is six characters and therefore never arms the
 * detector at all, which is the kind of edge a constant would hide.
 *
 * A transcription has to be pinned on **both** sides of every boundary it
 * carries, which the first version of this was not: it asserted length 6 false
 * and length 8 true and nothing at 7, so `> 6` could have become `>= 8` with the
 * suite green. The same was true of the 32-byte cap, whose branch no fixture
 * reached. Each is a two-sided assertion below, and a threshold asserted on one
 * side is the same defect as a test that passes with the thing it is named for
 * deleted -- it just takes a boundary value rather than a deletion to see it.
 *
 * The cap is iTerm2's on the **accumulated** buffer rather than on one report:
 * `modified` starts from the previous detector's residue while that is under
 * 100ms old, and only an already-armed detector extends, so two corner presses
 * never concatenate into one that arms. A single SGR report cannot reach 32
 * bytes; a run of them coalesced into one read can, which is what the fixture
 * below is.
 *
 * @param report - Report bytes, one report or a run of them.
 * @returns What iTerm2 then looks for in the program's screen text.
 */
function residue(report: string): string {
	let ignore = 0;
	let out = '';
	for (const ch of report) {
		const code = ch.charCodeAt(0);
		if (code === 27) {
			ignore = 3;
		}
		if (ignore > 0) {
			ignore -= 1;
			continue;
		}
		if (code < 32) {
			continue;
		}
		out += ch;
	}
	return out.length > 32 ? out.slice(out.length - 32) : out;
}

/** Whether iTerm2 would arm an expectation for a report at all. */
const arms = (report: string): boolean => residue(report).length > 6;

/**
 * A preload that makes a child's streams answer `isTTY` and swallow raw mode.
 *
 * `Object.defineProperty` rather than an assignment, because a piped
 * `process.stdin` is not a `tty.ReadStream` and what it does with a write to a
 * property it never declared is not a thing to depend on. `setRawMode` has to be
 * *added* rather than faked out, since a pipe has none and `createTerminal()`
 * calls it through `?.`.
 */
const PRELOAD = `data:text/javascript,${encodeURIComponent(
	[
		'const d=(o,k,v)=>Object.defineProperty(o,k,{configurable:true,writable:true,value:v});',
		'd(process.stdout,"isTTY",true);d(process.stdout,"columns",100);d(process.stdout,"rows",30);',
		'd(process.stdin,"isTTY",true);d(process.stdin,"setRawMode",function(){return this;});',
	].join('')
)}`;

/** What one run of the probe's raw step came to. */
interface Run {
	/** Everything it wrote, with the escape sequences taken out. */
	screen: string;
	/** The `raw` lines, which are what the step is for. */
	rawLines: string[];
}

/**
 * Runs `--mouse`, feeds it presses until its raw step has printed one, and hands
 * back the screen text.
 *
 * The reports are fed on a repeat rather than once after a fixed delay: the raw
 * step is the third thing the probe does and the two before it wait out query
 * deadlines, so how long until the tap is listening is a fact about this machine.
 * Polling for the first `raw` line is the discriminating version -- a run that
 * never prints one fails for saying so rather than by asserting an absence.
 */
async function runRawStep(): Promise<Run> {
	if (!existsSync(built)) {
		throw new Error(`${built} is missing -- run \`pnpm build\` before this test`);
	}

	const child = spawn(process.execPath, ['--import', PRELOAD, probe, '--mouse'], {
		cwd: root,
		env: { ...process.env, COLUMNS: '100', LINES: '30', TERM: 'xterm-256color' },
		stdio: ['pipe', 'pipe', 'pipe'],
	});

	let out = '';
	child.stdout.on('data', (d: Buffer) => {
		out += String(d);
		// answer the cursor-position request an inline canvas asks, the way a
		// terminal would. Not needed for the raw step, which paints nothing, and
		// cheap insurance against a step order that changes
		for (let i = 0; i < String(d).split(`${ESC}[6n`).length - 1; i++) {
			child.stdin.write(`${ESC}[20;1R`);
		}
	});
	child.stderr.on('data', () => {});

	const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
	const rawOf = (text: string) =>
		strip(text)
			.split(/\r?\n/)
			.map((l) => l.trim())
			.filter((l) => l.startsWith('raw '));

	try {
		const deadline = Date.now() + 20_000;
		while (Date.now() < deadline && rawOf(out).length < 2) {
			child.stdin.write(PRESS);
			await sleep(60);
			child.stdin.write(RELEASE);
			await sleep(140);
		}
		// and then end the step the way a reader does, because the chunk holding
		// `q` is a chunk the tap sees: recording it printed `raw "q"` under a
		// heading about what a raw line holds, on every run of every raw step. A
		// test that never pressed `q` could not see it.
		child.stdin.write('q');
		// two drain intervals, which is the probe's own 50ms timer plus slack
		await sleep(200);
		return { rawLines: rawOf(out), screen: strip(out) };
	} finally {
		child.kill('SIGKILL');
	}
}

describe('the mouse report iTerm2 reads as an echo', () => {
	it('should strip the introducer and the control bytes, leaving the parameters', () => {
		expect(residue(PRESS)).to.equal('0;41;13M');
		expect(residue(RELEASE)).to.equal('0;41;13m');
		expect(residue(`${ESC}[<35;42;14M`)).to.equal('35;42;14M');
		expect(residue(`${ESC}[<64;41;13M`)).to.equal('64;41;13M');
	});

	it("should arm on seven characters and not on six, which is the corner press's edge", () => {
		// both sides of `if (string.length > 6)`. Six is a real report -- a press in
		// the very top-left corner -- so the threshold is reachable from below as
		// well as from above, and asserting only one side leaves the other free
		expect(residue(`${ESC}[<0;1;1M`)).to.equal('0;1;1M');
		expect(residue(`${ESC}[<0;1;1M`)).to.have.lengthOf(6);
		expect(arms(`${ESC}[<0;1;1M`)).to.equal(false);

		expect(residue(`${ESC}[<0;10;1M`)).to.equal('0;10;1M');
		expect(residue(`${ESC}[<0;10;1M`)).to.have.lengthOf(7);
		expect(arms(`${ESC}[<0;10;1M`)).to.equal(true);

		expect(arms(PRESS)).to.equal(true);
	});

	it('should keep the last 32 bytes of a run long enough to need capping', () => {
		// the other branch no fixture reached. Four motion reports coalesced into one
		// read come to forty characters of residue, and what iTerm2 keeps is the tail
		const drag = `${ESC}[<32;100;40M`.repeat(4);

		// under the cap, so the whole thing survives: three of the same reports
		expect(residue(`${ESC}[<32;100;40M`.repeat(3))).to.equal('32;100;40M'.repeat(3));
		expect(residue(`${ESC}[<32;100;40M`.repeat(3))).to.have.lengthOf(30);

		// over it, so the first eight go
		expect(residue(drag)).to.equal('0M32;100;40M32;100;40M32;100;40M');
		expect(residue(drag)).to.have.lengthOf(32);
	});

	it(
		'should not be printed verbatim by the probe, which iTerm2 reads as a stuck mouse',
		{ timeout: 60_000 },
		async () => {
			const { rawLines, screen } = await runRawStep();

			// the step has to have run at all, or everything below passes by absence
			expect(rawLines.length, `raw lines printed:\n${rawLines.join('\n')}`).toBeGreaterThan(1);

			// what the probe is for: the introducer is legible, which is what the
			// step's claim line promises of a raw line of a report. This asserts one
			// such line is present and spaced -- not that every raw line matches,
			// which is the heading's claim and a wider thing than a test that feeds
			// one report can see
			expect(screen).toContain('ESC [ < 0 ; 41 ; 13 M');

			// and the quit key is not recorded as a report. `q` holds neither
			// introducer, so a `raw "q"` line is one the heading above cannot be true
			// of -- and it is the one chunk every raw step receives on every run
			for (const line of rawLines) {
				expect(line, 'a raw line that is not a report').to.satisfy(
					(l: string) => l.includes('ESC [ <') || l.includes('ESC [ M')
				);
			}

			// and what SIG-128 is for: no line holds the contiguous run
			for (const report of [PRESS, RELEASE]) {
				expect(arms(report)).to.equal(true);
				expect(
					screen,
					`${JSON.stringify(residue(report))} reached the screen, which is what iTerm2's ` +
						'AutodetectMouseReportingStuck watches for'
				).not.toContain(residue(report));
			}
		}
	);
});
