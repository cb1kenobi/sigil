// TEMPORARY (SIG-490): measures trash() on the Windows runner. Removed before the PR is ready.
import { trash } from '../src/trash/index.js';
import { keyOf, recycle } from '../src/trash/windows.js';
import { tempDir } from './temp.js';
import { execFileSync } from 'node:child_process';
import { rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';

describe.runIf(process.platform === 'win32')('SIG-490 timing', () => {
  it('should time trash() calls', async () => {
    const ps = `${process.env.SystemRoot ?? 'C:\\Windows'}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`;
    const bare: number[] = [];
    for (let i = 0; i < 3; i++) {
      const t = performance.now();
      execFileSync(ps, ['-NoProfile', '-NonInteractive', '-STA', '-Command', 'exit 0']);
      bare.push(Math.round(performance.now() - t));
    }
    const root = tempDir('sigil-trash-timing-');
    const calls: number[] = [];
    for (let i = 0; i < 6; i++) {
      const file = join(root, `f${i}.txt`);
      await writeFile(file, 'x');
      const t = performance.now();
      const where = await trash(file);
      calls.push(Math.round(performance.now() - t));
      expect(where).not.toBe('');
      await rm(where, { force: true });
      await rm(join(dirname(where), `$I${basename(where).slice(2)}`), { force: true });
    }
    const cacheDir = tempDir('sigil-trash-timing-cache-');
    const timed = async (file: string | undefined): Promise<string> => {
      const item = join(root, `g${Math.random().toString(36).slice(2)}.txt`);
      await writeFile(item, 'x');
      const t = performance.now();
      const out = await recycle(item, file, keyOf('timing'));
      const ms = Math.round(performance.now() - t);
      await rm(out.path, { force: true });
      await rm(join(dirname(out.path), `$I${basename(out.path).slice(2)}`), { force: true });
      return `${out.cache}:${ms}`;
    };
    const cached: string[] = [];
    for (let i = 0; i < 6; i++) {
      cached.push(await timed(join(cacheDir, 'trash.bin')));
    }
    const uncached: string[] = [];
    for (let i = 0; i < 3; i++) {
      uncached.push(await timed(undefined));
    }
    console.log(
      `SIG490-AFTER node=${process.version} cache=${cached.join(',')} nocache=${uncached.join(',')}`
    );
    console.log(
      `SIG490-TIMING node=${process.version} powershell-bare=${bare.join(',')} trash=${calls.join(',')}`
    );
  }, 120_000);
});
