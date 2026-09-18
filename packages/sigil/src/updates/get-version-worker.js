// This script is piped to `node --input-type=module` via stdin, so it cannot
// resolve relative imports. Keep it dependency-free: only `node:` builtins.
import { readFileSync, writeFileSync } from 'node:fs';
import https from 'node:https';

try {
	const {
		CACHE_FILE: cacheFile,
		DIST_TAG: distTag = 'latest',
		DIST_TAGS_URL: url,
		REQUEST_TIMEOUT: requestTimeout,
	} = process.env;

	if (!distTag) {
		throw new Error('DIST_TAG is not set');
	}

	if (!url) {
		throw new Error('DIST_TAGS_URL is not set');
	}

	if (!url.startsWith('https')) {
		throw new Error('DIST_TAGS_URL must use https');
	}

	// an empty variable is read as unset, the way the parser reads one -- but
	// whitespace is not empty, and `Number(' ')` is `0`, which is the one value
	// that means "no timeout at all". A variable nobody meant to set must not be
	// the way the timeout gets switched off
	let timeout = 5000;
	if (requestTimeout) {
		timeout = requestTimeout.trim() ? Number(requestTimeout) : NaN;
	}
	if (!Number.isFinite(timeout) || timeout < 0) {
		throw new Error(`Invalid REQUEST_TIMEOUT: "${requestTimeout}"`);
	}

	const distTags = await new Promise((resolve, reject) => {
		const req = https.get(
			url,
			{
				headers: {
					accept: 'application/vnd.npm.install-v1+json; q=1.0, application/json; q=0.8, */*',
				},
			},
			(res) => {
				let buf = '';
				// a connection that drops part way through a body is the other way a
				// fetch never ends, and the timeout above does not cover it: the
				// socket is gone, so the inactivity timer went with it, while `end`
				// never comes because the response did not finish. Without this
				// listener nothing settles the promise and the worker waits forever --
				// measured, and it is not an uncaught exception, which is why it reads
				// as the process simply never exiting
				res.on('error', reject);
				res.on('data', (chunk) => {
					buf += chunk;
				});
				res.on('end', () => {
					try {
						if (res.statusCode && res.statusCode >= 400) {
							throw new Error(`Fetch dist-tags failed ${res.statusCode} ${res.statusMessage}`);
						}
						resolve(JSON.parse(buf));
					} catch (err) {
						reject(err);
					}
				});
			}
		);

		// `https.get()` has no timeout of its own, so a registry that accepts the
		// connection and then says nothing leaves this process running forever --
		// and on the default fire-and-forget path the parent has unreffed its own
		// timer, so nothing else is coming to end it. An inactivity timeout is the
		// one that covers a stall partway through a response as well as a first
		// byte that never arrives; destroying the request surfaces as the `error`
		// below, which is the path that already exits non-zero. A timeout of `0`
		// is the caller opting out, the same way the parent skips its own timer
		if (timeout) {
			req.setTimeout(timeout, () => {
				req.destroy(new Error(`Fetch dist-tags timed out after ${timeout}ms`));
			});
		}

		req.on('error', reject);
		req.end();
	});

	const version = distTags[distTag];
	if (!version) {
		throw new Error(`Dist tag "${distTag}" not found`);
	}

	if (cacheFile) {
		// the parent process created the cache directory before spawning us
		let cache = {};
		try {
			const obj = JSON.parse(readFileSync(cacheFile, 'utf-8'));
			if (obj && typeof obj === 'object') {
				cache = obj;
			}
		} catch {}
		cache.ts = Date.now();
		cache.version = version;
		writeFileSync(cacheFile, JSON.stringify(cache));
	}

	process.stdout.write(version);
} catch (err) {
	console.error(err);
	process.exit(1);
}
