// SIG-288 spike, temporary: runs the probe in a child process so the pty lives
// on a main thread, the way an app would hold one, and logs what it measured so
// the nine CI jobs each record a row. Reverted before the PR is ready.
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

const probe = fileURLToPath(new URL('fixtures/pty-spike/probe.mjs', import.meta.url));

describe('SIG-288 pty spike', () => {
  it('should give a child a terminal, resize it, write to it, and end it', async () => {
    const { stdout } = await promisify(execFile)(process.execPath, [probe], { timeout: 60000 });
    const line = stdout.trim().split('\n').at(-1) ?? '';
    console.log(`SIG-288 MEASURED ${line}`);
    const result = JSON.parse(line) as Record<string, unknown>;
    expect(result.error).toBeUndefined();
    expect(result.tty).toStrictEqual(['true', 'true', '80x24']);
    expect(result.exit).toMatchObject({ exitCode: 7 });
    expect(result.killed).toBeDefined();
  }, 60000);
});
