import debug from '../debug/index.js';
import { mkdirOwnerSync } from '../util/mkdir-owner-sync.js';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const { log } = debug('main2:updates');
const oneDay = 86400000;

export interface CheckOptions {
	cacheDir?: string;
	checkInterval?: number;
	distTag?: string;
	force?: boolean;
	notifyInterval?: number;
	packageName: string;
	packageVersion: string;
	registryURL?: string;
	timeout?: number;
	wait?: boolean;
}

export async function check(
	opts: CheckOptions
): Promise<{ current: string; latest: string | undefined }> {
	if (!opts || typeof opts !== 'object') {
		throw new TypeError('Update check options must be an object');
	}

	const {
		cacheDir,
		checkInterval = oneDay,
		distTag = 'latest',
		force = false,
		packageName,
		packageVersion,
		registryURL,
		timeout = 5000,
		wait = false,
	} = opts;

	if (!packageName || typeof packageName !== 'string') {
		throw new TypeError('Update check package name must be a non-empty string');
	}

	if (!packageVersion || typeof packageVersion !== 'string') {
		throw new TypeError('Update check package version must be a non-empty string');
	}

	if (!distTag || typeof distTag !== 'string') {
		throw new TypeError('Update check dist tag must be a non-empty string');
	}

	const cacheFile = cacheDir ? join(cacheDir, `${packageName}-${distTag}.json`) : undefined;

	let cache;
	if (cacheFile) {
		log(`Cache file: ${cacheFile}`);
		try {
			cache = JSON.parse(readFileSync(cacheFile, 'utf-8'));
		} catch {}
	}

	if (force || !cache || !cache.ts || cache.ts + checkInterval < Date.now()) {
		const cwd = dirname(fileURLToPath(import.meta.url));
		const workerFile = join(cwd, 'get-version-worker.js');
		const workerScript = readFileSync(workerFile, 'utf-8');
		// The worker is a self-contained ESM script, so drop NODE_OPTIONS rather
		// than inheriting loader flags (`--import tsx`, coverage hooks, and so
		// on) that are not installed for the spawned process.
		const { NODE_OPTIONS: _ignored, ...parentEnv } = process.env;
		const env = {
			...parentEnv,
			CACHE_FILE: cacheFile,
			DIST_TAG: distTag,
			PACKAGE_NAME: packageName,
			REGISTRY_URL: registryURL,
		};

		// the worker cannot resolve relative imports, so create the cache
		// directory here rather than there
		if (cacheFile) {
			mkdirOwnerSync(dirname(cacheFile));
		}

		log('Spawning update worker...');
		const worker = spawn(process.execPath, ['--input-type', 'module'], {
			cwd,
			env,
			stdio: ['pipe', 'pipe', 'pipe'],
		});
		worker.stdin.write(workerScript);
		worker.stdin.end();

		let stdout = '';
		worker.stdout.on('data', (data) => {
			stdout += data.toString();
		});

		let stderr = '';
		worker.stderr.on('data', (data) => {
			stderr += data.toString();
		});

		const prom = new Promise<void>((resolve, reject) => {
			let timer: NodeJS.Timeout;
			if (timeout) {
				timer = setTimeout(() => {
					worker.kill();
					reject(new Error('Update worker timed out'));
				}, timeout);

				// nothing waits on the worker unless `wait` is set, and a referenced
				// timer would hold the process open for the whole timeout after the
				// CLI has finished -- the point of the default path is that it costs
				// the run nothing
				if (!wait) {
					timer.unref();
				}
			}

			worker.on('close', (code) => {
				clearTimeout(timer);
				if (code) {
					reject(new Error(`Update worker error (code ${code})\n${stderr.trim()}`));
				} else {
					resolve();
				}
			});
		});

		if (wait) {
			await prom;
			log('Update worker finished successfully');
			if (cacheFile) {
				try {
					cache = JSON.parse(readFileSync(cacheFile, 'utf-8'));
				} catch {}
			} else {
				if (!cache) {
					cache = {};
				}
				cache.ts = Date.now();
				cache.version = stdout.trim();
			}
		} else {
			// fire and forget. The worker writes the cache file itself, so the next
			// run reads what this one found and this one returns what it already had.
			//
			// `disconnect()` was never right: it closes an IPC channel, the worker is
			// spawned with three pipes and no `ipc`, and `ChildProcess.disconnect` is
			// not defined without one -- so every call on the default path threw
			// `worker.disconnect is not a function` and an ordinary update check
			// could not complete at all. What the path actually needs is to stop
			// holding the process open and to stop the unawaited promise from
			// surfacing as an unhandled rejection when the worker fails
			prom.catch((err: Error) => log(`Update worker failed: ${err.message}`));
			worker.unref();

			// the child's pipes are their own handles and hold the loop open on their
			// own, so unreffing the child is not enough. They are sockets and do have
			// `unref`, which the `Readable` they are typed as does not declare; the
			// optional call is what keeps this honest if that ever stops being true
			for (const stream of [worker.stdout, worker.stderr]) {
				(stream as unknown as { unref?: () => void }).unref?.();
			}
		}
	}

	// TODO: notifyInterval

	log(`Current=${packageVersion} Latest=${cache?.version}`);

	return {
		current: packageVersion,
		latest: cache?.version,
	};
}
