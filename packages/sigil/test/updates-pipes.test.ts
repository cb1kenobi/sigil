import { check } from '../src/updates/index.js';
import { whichSync } from '../src/which.js';
import { tempDir } from './temp.js';
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * A worker script far larger than any pipe buffer, so that a runtime which
 * exits without reading it leaves the parent's write with nowhere to go.
 *
 * The real one is about nine kilobytes and fits in the buffer on every
 * platform this was measured on, so the write lands before the child has even
 * started and the `EPIPE` cannot be provoked with it. What can is any script
 * that does not fit -- which the real one will be, one day, if it grows.
 */
vi.mock('../src/updates/worker-source.js', () => ({
  workerSource: () => '//'.padEnd(4 * 1024 * 1024, 'x'),
}));

/** A program that exits at once and never reads stdin. */
const exitsUnread = process.platform === 'win32' ? undefined : whichSync('true');

const execPath = process.execPath;

afterEach(() => {
  Object.defineProperty(process, 'execPath', { configurable: true, value: execPath });
});

// The worker's stdin had no `error` listener, and a write to a pipe whose
// reader has gone is an `EPIPE` emitted on that stream -- an uncaught
// exception, on the fire-and-forget path after the command has finished. The
// spawn failing outright is the other half of the same hole and is tested
// end to end in `packages/cli/test/update-check.test.ts`, because what it
// costs is a real process's exit code.
describe('an update worker that exits without reading its script', () => {
  it.skipIf(!exitsUnread)('should not take the process down with an EPIPE', async () => {
    Object.defineProperty(process, 'execPath', { configurable: true, value: exitsUnread });

    const errors: unknown[] = [];
    const onError = (err: unknown): void => {
      errors.push(err);
    };
    process.on('uncaughtException', onError);
    try {
      // `wait`, so that the worker has closed -- and the write has failed --
      // before this asserts anything. It exited 0 having written no cache, so
      // the answer is simply that there is none
      const result = await check({
        cacheDir: tempDir('sigil-upd-pipes-'),
        force: true,
        packageName: 'pipes',
        packageVersion: '1.0.0',
        registryURL: 'https://127.0.0.1:1',
        wait: true,
      });
      expect(result).toEqual({ current: '1.0.0', latest: undefined });
    } finally {
      process.off('uncaughtException', onError);
    }
    expect(errors).toEqual([]);
  });
});
