import { tmp } from '../src/paths.js';
import { check } from '../src/updates/index.js';
import { cacheFileName, distTagsURL } from '../src/updates/registry.js';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer, type Socket } from 'node:net';
import type { AddressInfo } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';

async function generateTmpDir() {
	return tmp('test-sigil', randomUUID().slice(0, 8)) as string;
}

/**
 * Runs the worker the way `check()` does -- piped into `node
 * --input-type=module` -- so a test can watch it fail on its own rather than
 * through the parent's timer.
 */
function runWorker(env: Record<string, string>): Promise<{ code: number | null; stderr: string }> {
	const workerFile = fileURLToPath(
		new URL('../src/updates/get-version-worker.js', import.meta.url)
	);
	const script = readFileSync(workerFile, 'utf-8');
	const { NODE_OPTIONS: _ignored, ...parentEnv } = process.env;
	const worker = spawn(process.execPath, ['--input-type', 'module'], {
		env: { ...parentEnv, ...env },
		stdio: ['pipe', 'pipe', 'pipe'],
	});
	worker.stdin.write(script);
	worker.stdin.end();

	let stderr = '';
	worker.stderr.on('data', (data) => {
		stderr += data.toString();
	});

	return new Promise((resolve) => {
		worker.on('close', (code) => resolve({ code, stderr }));
	});
}

describe('updates', () => {
	describe('Error Handling', () => {
		it('should error if cache directory is invalid', async () => {
			await expect(check(undefined as any)).rejects.toThrowError(
				'Update check options must be an object'
			);
		});
	});

	// `wait: false` is the default, and it called `worker.disconnect()` on a child
	// spawned with three pipes and no IPC channel -- where `disconnect` is not
	// defined -- so an ordinary fire-and-forget update check threw instead of
	// returning
	describe('Fire and forget', () => {
		it('should return without waiting on the worker', async () => {
			const result = await check({
				cacheDir: await generateTmpDir(),
				packageName: 'snooplogg',
				packageVersion: '1.0.0',
			});

			// the worker is still running, so there is nothing to report but what
			// this call already had -- which is the point of the default path
			expect(result.current).to.equal('1.0.0');
			expect(result.latest).to.equal(undefined);
		});
	});

	describe('Check Latest', () => {
		it('should check latest version', async () => {
			const result = await check({
				cacheDir: await generateTmpDir(),
				packageName: 'snooplogg',
				packageVersion: '1.0.0',
				wait: true,
			});

			// assert the shape, not a specific version: `latest` is whatever
			// the registry currently serves and will change without notice
			expect(result.current).to.equal('1.0.0');
			expect(result.latest).to.match(/^\d+\.\d+\.\d+/);
		});
	});

	// `@ttylabs/sigil` is this framework's own name, and it was the one name the
	// check could not handle: the slash split the registry path and nested the
	// cache file in a directory nothing created. Every test above uses an
	// unscoped name, which is why the suite was green
	describe('Scoped package names', () => {
		it('should encode the package name into one path segment', () => {
			expect(distTagsURL('@ttylabs/sigil')).to.equal(
				'https://registry.npmjs.org/-/package/%40ttylabs%2Fsigil/dist-tags'
			);
		});

		it('should leave an unscoped package name alone', () => {
			expect(distTagsURL('snooplogg')).to.equal(
				'https://registry.npmjs.org/-/package/snooplogg/dist-tags'
			);
		});

		it('should strip a trailing slash from the registry URL', () => {
			expect(distTagsURL('@ttylabs/sigil', 'https://npm.example.com/')).to.equal(
				'https://npm.example.com/-/package/%40ttylabs%2Fsigil/dist-tags'
			);
		});

		it('should not let a package name escape the cache directory', () => {
			for (const name of ['@ttylabs/sigil', '../../etc/passwd', 'a\\b']) {
				const file = cacheFileName(name, 'latest');
				expect(file).to.not.match(/[/\\]/);
				expect(dirname(join('cache', file))).to.equal('cache');
			}
		});

		it('should not share a cache file between two packages', () => {
			// a `/` swapped for a `-` collides both ways, and two packages sharing
			// a cache file share a version
			expect(cacheFileName('@a/b-c', 'latest')).to.not.equal(cacheFileName('@a-b/c', 'latest'));
			expect(cacheFileName('a-b', 'c')).to.not.equal(cacheFileName('a', 'b-c'));
			expect(cacheFileName('@a/b', 'latest')).to.not.equal(cacheFileName('@a/b@latest', ''));
		});

		it('should read the cache file a scoped package name writes', async () => {
			// a cache entry that is not stale is the whole answer, so this pins the
			// path `check()` reads without spawning a worker or leaving the machine
			const cacheDir = await generateTmpDir();
			mkdirSync(cacheDir, { recursive: true });
			writeFileSync(
				join(cacheDir, cacheFileName('@ttylabs/sigil', 'latest')),
				JSON.stringify({ ts: Date.now(), version: '9.9.9' })
			);

			const result = await check({
				cacheDir,
				packageName: '@ttylabs/sigil',
				packageVersion: '1.0.0',
			});

			expect(result.latest).to.equal('9.9.9');
			// nothing was nested: the scope did not become a directory
			expect(readdirSync(cacheDir)).to.deep.equal([cacheFileName('@ttylabs/sigil', 'latest')]);
		});
	});

	// the worker's `https.get()` had no timeout, and on the default path the
	// parent's timer is unreffed -- so a registry that accepted the connection
	// and then said nothing left a node process alive for as long as the socket
	// was, with the CLI that spawned it long gone
	describe('Request timeout', () => {
		it('should give up on a registry that never answers', async () => {
			// a plain TCP listener accepts the connection and never completes the
			// TLS handshake, which is a hang with nothing to read rather than a
			// refusal -- and it is local, so no test here touches the network
			const sockets: Socket[] = [];
			const server = createServer((socket) => sockets.push(socket));
			await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
			const { port } = server.address() as AddressInfo;

			try {
				const { code, stderr } = await runWorker({
					DIST_TAG: 'latest',
					DIST_TAGS_URL: `https://127.0.0.1:${port}/-/package/sigil/dist-tags`,
					REQUEST_TIMEOUT: '500',
				});

				// it ended itself, rather than the test having to wait it out
				expect(code).to.equal(1);
				expect(stderr).to.contain('Fetch dist-tags timed out after 500ms');
			} finally {
				for (const socket of sockets) {
					socket.destroy();
				}
				server.close();
			}
		});
	});
});
