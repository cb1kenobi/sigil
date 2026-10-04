import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Whether `await decrypt(text)` resolves on a terminal, which only a spawned
 * process can answer.
 *
 * The suite that ships with the component drives it through an injected clock, so
 * it proves what each frame holds and cannot prove the one thing that broke: that
 * node is still **alive** when the last frame lands. A decrypt schedules its own
 * timer and the renderer's frame timer is unref'd by design, so with the driving
 * timer unref'd as well there is nothing ref'd left for the loop to do -- and node
 * exits rather than settling the promise. Measured before the fix:
 * `node demos/components/09-decrypt.js` on a terminal exited **13** with
 * `Detected unsettled top-level await`, having drawn nothing, while the identical
 * run piped was fine. The piped path never schedules a timer at all, which is
 * exactly why every test and every CI run missed it.
 *
 * So this spawns, fakes a terminal, awaits a run and looks for a line printed
 * *after* the await. `demos.test.ts` cannot cover it for the reason recorded
 * there: it spawns with stdio `ignore` and pipes, so every demo takes the
 * no-terminal branch.
 */

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/**
 * A preload making a child's stdout answer `isTTY`, as `output-forms.test.ts` does.
 *
 * `Object.defineProperty` rather than an assignment, because a piped
 * `process.stdout` is not a `tty.WriteStream` and what it does with a write to a
 * property it never declared is not a thing to depend on. `columns` and `rows` come
 * with it, since a canvas asks for both.
 */
const TTY_PRELOAD = `data:text/javascript,${encodeURIComponent(
	['stdout', 'stderr']
		.map(
			(s) =>
				`Object.defineProperty(process.${s},"isTTY",{configurable:true,value:true});` +
				`Object.defineProperty(process.${s},"columns",{configurable:true,value:80});` +
				`Object.defineProperty(process.${s},"rows",{configurable:true,value:24});`
		)
		.join('')
)}`;

/** The sentinel is printed after the await, so it is absent if nothing resolved. */
const SOURCE = `
import { decrypt, seeded } from '@ttylabs/sigil/components';
await decrypt('Setec Astronomy', { jumble: 60, random: seeded(1989), reveal: 120 });
console.log('AWAIT-RETURNED');
`;

interface Ran {
	code: number | null;
	stderr: string;
	stdout: string;
}

/**
 * Runs the snippet, with or without a terminal.
 *
 * `cwd` is `demos/`, because that is a workspace member declaring
 * `@ttylabs/sigil` and the repository root deliberately declares no internal
 * dependency -- so a bare specifier in spawned code resolves there and nowhere
 * above it. Which also means this test needs a built `dist/`, like everything else
 * in this package.
 */
function run(tty: boolean): Promise<Ran> {
	const args = tty
		? ['--import', TTY_PRELOAD, '--input-type=module', '-e', SOURCE]
		: ['--input-type=module', '-e', SOURCE];

	return new Promise((settle, fail) => {
		const child = spawn(process.execPath, args, {
			cwd: join(root, 'demos'),
			env: { ...process.env, COLUMNS: '80', NO_COLOR: '1' },
			stdio: ['ignore', 'pipe', 'pipe'],
		});
		let stderr = '';
		let stdout = '';
		const timer = setTimeout(() => {
			child.kill('SIGKILL');
			fail(new Error('the decrypt snippet did not finish within 20s'));
		}, 20_000);

		child.stderr.on('data', (c: Buffer) => void (stderr += c.toString()));
		child.stdout.on('data', (c: Buffer) => void (stdout += c.toString()));
		child.on('error', (error) => {
			clearTimeout(timer);
			fail(error);
		});
		child.on('close', (code) => {
			clearTimeout(timer);
			settle({ code, stderr, stdout });
		});
	});
}

describe('awaiting a decrypt on a terminal', () => {
	it('should resolve rather than letting node exit first', async () => {
		const ran = await run(true);

		// the sentinel is the claim: the await returned. The exit code alone would
		// not do -- an unsettled top-level await exits 13, but a future node could
		// pick another number, and what is being asserted is that the line ran
		expect(ran.stdout).toContain('AWAIT-RETURNED');
		expect(ran.code).toBe(0);
		expect(ran.stderr).not.toMatch(/unsettled top-level await/);
	}, 30_000);

	it('should have masked the text rather than resolving by taking the piped path', async () => {
		const ran = await run(true);

		// without this the test above passes on a terminal that never animated, which
		// is the piped behaviour wearing a TTY's clothes: a decrypt that writes its
		// text once settles immediately and would satisfy the sentinel.
		//
		// A masked glyph is the discriminator rather than a count of escapes, which
		// was the first spelling and is a measurement of the wrong thing: at colour
		// level 0 over a one-line canvas a repaint is mostly a carriage return, so an
		// animated run emitted **three** escapes. The plaintext, the sentinel and
		// every sequence around them are ASCII, while the default alphabet is CP437's
		// graphics -- so one character above U+007F is one frame that hid something.
		// Measured: 46 of them animated, none piped.
		const masked = [...ran.stdout].filter((ch) => ch.codePointAt(0)! > 0x7f);
		expect(masked.length).toBeGreaterThan(0);
	}, 30_000);

	it('should still resolve with no terminal, where no timer is ever scheduled', async () => {
		const ran = await run(false);

		expect(ran.stdout).toContain('AWAIT-RETURNED');
		expect(ran.code).toBe(0);
		// the non-TTY path writes the text once and draws no frame
		expect(ran.stdout).not.toContain(String.fromCharCode(0x1b));
	}, 30_000);
});
