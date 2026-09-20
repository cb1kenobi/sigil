import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * A command module may be TypeScript, and this is the only test that proves it.
 *
 * Every supported runtime strips types on its own -- the workspace requires
 * node >=22.19.0 and CI runs 22, 24 and 26 -- so there is no compile step
 * between a `commands/deploy.ts` and the parser importing it. What there *is*
 * is a transform in the way of any test that asserts it from inside the suite:
 * vite reads whatever a test file imports, so `test/parser/routing.test.ts`
 * proves the routing and cannot prove the loading, and it cannot read a `.cts`
 * at all. A spawned node is the whole difference, which is why this lives here
 * rather than beside the other routing tests -- the same reason the demos are
 * spawned, and the same reason this package is where a test that needs `dist/`
 * goes.
 */

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../../..');
const cli = resolve(here, 'fixtures/ts-app/cli.mjs');

interface Ran {
	code: number | null;
	stderr: string;
	stdout: string;
}

function run(args: string[]): Promise<Ran> {
	return new Promise((settle, fail) => {
		// no flags: type stripping is on by default in every node this supports,
		// and passing one here would prove something about the flag instead
		const child = spawn(process.execPath, [cli, ...args], {
			cwd: root,
			env: { ...process.env, COLUMNS: '80' },
			stdio: ['ignore', 'pipe', 'pipe'],
		});
		let stderr = '';
		let stdout = '';
		const timer = setTimeout(() => {
			child.kill('SIGKILL');
			fail(new Error(`ts-app ${args.join(' ')} did not finish within 30s`));
		}, 30_000);

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

describe('TypeScript command modules', () => {
	it.concurrent('should run a .ts command', async () => {
		const { code, stderr, stdout } = await run(['deploy']);
		expect(stderr).to.equal('');
		expect(code).to.equal(0);
		expect(stdout).to.equal('deployed to prod\n');
	});

	it.concurrent('should run a .mts index module', async () => {
		const { code, stderr, stdout } = await run(['settings']);
		expect(stderr).to.equal('');
		expect(code).to.equal(0);
		expect(stdout).to.equal('settings are on\n');
	});

	it.concurrent('should run a .cts command as the CommonJS it says it is', async () => {
		const { code, stderr, stdout } = await run(['settings', 'edit']);
		expect(stderr).to.equal('');
		expect(code).to.equal(0);
		expect(stdout).to.equal('edited\n');
	});

	it.concurrent('should describe the tree without importing any of it', async () => {
		// help lists what the walk found; the descriptions are still behind the
		// imports, which is the rule a lazily loaded module already follows
		const { code, stderr, stdout } = await run(['--help']);
		expect(stderr).to.equal('');
		expect(code).to.equal(0);
		expect(stdout).to.contain('deploy');
		expect(stdout).to.contain('settings');
	});
});
