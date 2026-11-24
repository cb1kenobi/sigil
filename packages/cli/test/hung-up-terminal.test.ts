import { spawn, spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * A terminal that hangs up under a running app does not crash it (SIG-538).
 *
 * An ssh connection drops or a window is closed, and the next write to the pty
 * fails `EIO` -- which `isStreamGone()` did not list, so `main()`'s guard threw it
 * from the stream's `error` listener and a command that was only printing died
 * with `Error: write EIO` and exit 1. Measured on a real pty rather than read off
 * the code: `main()` before the change exited 1 with that stack, and with no guard
 * at all (what `main` had before SIG-538) it was the same unhandled `error` event.
 *
 * `EIO` counts as the reader leaving **only for a TTY**. For a file it is the disk
 * failing, and swallowing it would exit 0 over a cut-off file, so that stays a
 * fault; `packages/sigil/test/output.test.ts` holds that half, because a file
 * cannot be made to fail `EIO` on request.
 *
 * A real pty needs `openpty(3)`, which node has no way to ask for and this
 * repository takes no dependency to get (see "`runOnTerminal()` spawns the real
 * program" in `packages/sigil/src/testing/AGENTS.md`). Python's `os.openpty()` is
 * what ships on every machine this suite runs on except Windows, so the harness is
 * a few lines of it, run with `-I` so nothing in the working directory is loaded.
 * The test is skipped where there is no `python3` that can open one, and on
 * Windows, which has no pty of this kind.
 */

const here = dirname(fileURLToPath(import.meta.url));
const app = join(here, 'fixtures', 'main-output', 'app.mjs');

/**
 * Starts `node app ticks` with stdout the slave end of a pty and stderr a pipe,
 * waits for its first line, closes the master end, and reports how it ended.
 */
const HARNESS = `
import os, sys
master, slave = os.openpty()
err_r, err_w = os.pipe()
pid = os.fork()
if pid == 0:
    os.close(master)
    os.close(err_r)
    os.dup2(slave, 1)
    os.dup2(err_w, 2)
    os.execv(sys.argv[1], sys.argv[1:])
os.close(slave)
os.close(err_w)
seen = b''
while b'ready' not in seen:
    chunk = os.read(master, 4096)
    if not chunk:
        break
    seen += chunk
os.close(master)
err = b''
while True:
    chunk = os.read(err_r, 4096)
    if not chunk:
        break
    err += chunk
_, status = os.waitpid(pid, 0)
sys.stdout.write(str(os.waitstatus_to_exitcode(status)) + '\\n' + err.decode())
`;

/** Whether this machine can open a pty from Python, which is the whole of what the harness needs. */
function canOpenPty(): boolean {
  if (process.platform === 'win32') {
    return false;
  }
  const probe = spawnSync('python3', ['-I', '-c', 'import os; os.close(os.openpty()[0])'], {
    stdio: 'ignore',
  });
  return probe.status === 0;
}

/** Runs the harness and resolves with the app's exit code and what it wrote to stderr. */
function hangUp(args: string[]): Promise<{ code: number; stderr: string }> {
  return new Promise((settle, fail) => {
    const child = spawn('python3', ['-I', '-c', HARNESS, process.execPath, app, ...args], {
      env: { ...process.env, NODE_NO_WARNINGS: '1' },
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    let out = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      fail(new Error('the app did not finish within 30s'));
    }, 30_000);

    child.stdout.on('data', (chunk: Buffer) => void (out += chunk.toString()));
    child.on('error', (error) => {
      clearTimeout(timer);
      fail(error);
    });
    child.on('close', () => {
      clearTimeout(timer);
      const [code, ...rest] = out.split('\n');
      settle({ code: Number(code), stderr: rest.join('\n') });
    });
  });
}

describe.skipIf(!canOpenPty())('an app whose terminal hung up under it', () => {
  it('should finish and exit 0 rather than die with write EIO', async () => {
    const ran = await hangUp(['ticks']);

    // proof it was a terminal and that the app was still there to say so: a
    // stdout that was not a TTY would not be the case under test
    expect(ran.stderr).toContain('finished isTTY=true');
    expect(ran.stderr).not.toMatch(/EIO|Unhandled 'error' event/);
    expect(ran.stderr).not.toMatch(/\n\s+at /);
    expect(ran.code).toBe(0);
  }, 40_000);
});
