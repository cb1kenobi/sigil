import { tmp } from '../src/paths.js';
import { check } from '../src/updates/index.js';
import { randomUUID } from 'node:crypto';
import { describe, it, expect } from 'vitest';

async function generateTmpDir() {
	return tmp('test-main2', randomUUID().slice(0, 8));
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
});
