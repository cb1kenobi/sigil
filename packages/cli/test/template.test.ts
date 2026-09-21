import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';

/**
 * A template compiles with `tsc` and runs under node, and this is the only test
 * that proves it.
 *
 * Everything in `@ttylabs/sigil/test/template/` reaches the JSX frontend by
 * calling `jsx()` and `jsxs()` directly, which is what the transform emits --
 * so it proves the runtime and cannot prove the *toolchain*. What is untested
 * from in there is the whole path an app actually takes: `jsxImportSource`
 * resolving `@ttylabs/sigil/jsx-runtime`, the package's `exports` map answering
 * for that subpath, and node importing what `tsc` wrote.
 *
 * That is not a theoretical gap. `@ttylabs/sigil/jsx-dev-runtime` did not exist
 * for a while, and every test passed throughout: the production transform never
 * asks for it, and nothing compiled a `.tsx` for real. It surfaced the first
 * time one was compiled with `"jsx": "react-jsxdev"`.
 *
 * So this lives here for the reason `typescript.test.ts` does, and the reason
 * the demos are spawned: vite transforms whatever a test file imports, and a
 * spawned node is the whole difference. This package is where a test that needs
 * `dist/` goes.
 *
 * The three fixtures are the same component written three ways -- built by hand,
 * through the `ui` tag, and as JSX. Asserting they agree is the differential
 * invariant SIG-69 rests on, taken across the real package boundary.
 */

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../../..');
const fixtures = resolve(here, 'fixtures/template');
const renderer = resolve(fixtures, 'render.mjs');

/**
 * The compiler's own entry, spawned under this node rather than through
 * `node_modules/.bin/tsc`.
 *
 * That shim is extensionless on unix and a `.CMD` on Windows, so spawning it by
 * name is `ENOENT` there -- and `shell: true` is not the way out, because this
 * workspace already carries an entry about what `cmd.exe` does to a quoted
 * argument. `tsc.js` is a plain file every platform runs the same way. Resolved
 * through `createRequire` rather than joined onto `node_modules`, since pnpm
 * puts the real package under `.pnpm/` and only links the name.
 */
const tsc = resolve(dirname(createRequire(import.meta.url).resolve('typescript')), 'tsc.js');

interface Ran {
	code: number | null;
	stderr: string;
	stdout: string;
}

/**
 * Runs a command and collects what it said.
 *
 * @param command - The executable, which is always this node.
 * @param args - Its arguments.
 * @returns The exit code and both streams.
 */
function run(command: string, args: string[]): Promise<Ran> {
	return new Promise((settle, fail) => {
		const child = spawn(command, args, {
			cwd: root,
			env: { ...process.env, COLUMNS: '80' },
			stdio: ['ignore', 'pipe', 'pipe'],
		});
		let stderr = '';
		let stdout = '';
		const timer = setTimeout(() => {
			child.kill('SIGKILL');
			fail(new Error(`${args.join(' ')} did not finish within 60s`));
		}, 60_000);

		child.stderr.on('data', (chunk: Buffer) => void (stderr += chunk.toString()));
		child.stdout.on('data', (chunk: Buffer) => void (stdout += chunk.toString()));
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

/**
 * Renders one frontend's Counter in a spawned node.
 *
 * @param module - The fixture to import, relative to the fixtures directory.
 * @returns The frame before the signal write and the frame after it.
 */
async function frames(module: string): Promise<{ after: string; before: string }> {
	const ran = await run(process.execPath, [renderer, resolve(fixtures, module)]);
	expect(ran.stderr, `${module} wrote to stderr`).toBe('');
	expect(ran.code, `${module} exited ${ran.code}`).toBe(0);
	return JSON.parse(ran.stdout) as { after: string; before: string };
}

describe('a template across the package boundary', () => {
	let compiled: Ran;

	// in a hook rather than in the first test, because the tests below import
	// what it writes: ordering inside a `describe` is not a dependency anything
	// states, and running one of them on its own would otherwise fail on a
	// missing file rather than on what it was asking about
	beforeAll(async () => {
		compiled = await run(process.execPath, [tsc, '-p', resolve(fixtures, 'tsconfig.json')]);
	}, 60_000);

	it('should compile a .tsx with tsc and nothing else', () => {
		// no sigil-specific compiler in this path, which is the point: `sigil
		// build` is an optimizer an app may skip rather than a transform it
		// depends on to run
		expect(compiled.stdout + compiled.stderr).toBe('');
		expect(compiled.code).toBe(0);
	});

	it('should render the same frames through all three frontends', async () => {
		// the differential invariant, across the real `exports` map: the tag and
		// what the transform emits must agree, and the frame after the write is
		// what makes it a test of the reactivity rather than of the first paint
		const byHand = await frames('counter-elements.js');
		const tagged = await frames('counter-tag.js');
		const compiled = await frames('out/counter-jsx.js');

		expect(tagged).toEqual(byHand);
		expect(compiled).toEqual(byHand);
	}, 60_000);

	it('should have rendered something worth comparing', async () => {
		// a frontend that threw would have failed above; one that rendered nothing
		// would have made the comparison vacuous
		const { after, before } = await frames('counter-tag.js');
		expect(before).toContain('count: 1');
		expect(after).toContain('count: 3');
		expect(after).toContain('layout');
	}, 60_000);
});
