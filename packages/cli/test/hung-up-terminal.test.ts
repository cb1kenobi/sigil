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
    try:
        chunk = os.read(master, 4096)
    except OSError:
        # Linux says EIO, not end of file, once the slave side is closed
        break
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
# os.waitstatus_to_exitcode() is 3.9 and later, and this is not worth a version floor
code = os.WEXITSTATUS(status) if os.WIFEXITED(status) else 128 + os.WTERMSIG(status)
sys.stdout.write(str(code) + '\\n' + err.decode())
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

/**
 * Whether the test runs. Windows has no pty of this kind and is skipped. Anywhere
 * else a machine with no usable `python3` is skipped too -- except on CI, where
 * the only end-to-end proof of this going quiet is a test that fails rather than
 * one that is not there.
 */
const available = canOpenPty();
const mustRun = process.platform !== 'win32' && process.env.CI !== undefined;

describe.skipIf(!available && !mustRun)('an app whose terminal hung up under it', () => {
  it('should have a python3 that can open a pty', () => {
    expect(available, 'no python3 here can open a pty, so the hang-up cannot be tested').toBe(true);
  });

  it('should finish and exit 0 rather than die with write EIO', async () => {
    if (!available) {
      return;
    }
    const ran = await hangUp(['ticks']);

    // proof it was a terminal, that the app was still there to say so, and that
    // a write really did fail under it -- a harness that stalled past the last
    // tick would otherwise pass having tested nothing
    expect(ran.stderr).toMatch(/finished isTTY=true failedWrites=[1-9]/);
    expect(ran.stderr).not.toMatch(/EIO|Unhandled 'error' event/);
    expect(ran.stderr).not.toMatch(/\n\s+at /);
    expect(ran.code).toBe(0);
  }, 40_000);
});
