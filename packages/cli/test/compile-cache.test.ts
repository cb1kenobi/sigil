import { tempDir } from './temp.js';
import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { constants } from 'node:module';
import { describe, expect, it } from 'vitest';

/**
 * SIG-422. pnpm and npm call `module.enableCompileCache()` on startup, and with
 * no directory that writes `node-compile-cache` into the tmpdir, where nothing
 * the suite owns removes it. `vitest.config.ts` sets `NODE_DISABLE_COMPILE_CACHE`
 * for every process a test spawns. The child below makes the call pnpm makes,
 * with its tmpdir pointed at a directory this file owns, so the config line
 * going missing fails here and not only under `pnpm test:leaks`, which CI does
 * not run. See "A spawned tool's compile cache" in
 * `packages/sigil/src/testing/AGENTS.md`.
 */
describe('a spawned compile cache', () => {
  it('should leave no node-compile-cache behind a spawned package manager', () => {
    const dir = tempDir('sigil-compile-cache-');
    const ran = spawnSync(
      process.execPath,
      ['-e', "console.log(JSON.stringify(require('node:module').enableCompileCache()?.status))"],
      {
        encoding: 'utf-8',
        // TMPDIR is what POSIX reads, TEMP and TMP what Windows reads
        env: { ...process.env, TEMP: dir, TMP: dir, TMPDIR: dir },
      }
    );

    expect(ran.status, ran.stderr).toBe(0);
    expect(Number(ran.stdout)).toBe(constants.compileCacheStatus.DISABLED);
    expect(readdirSync(dir)).toEqual([]);
  });
});
