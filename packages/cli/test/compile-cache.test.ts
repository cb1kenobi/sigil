import config from '../vitest.config.ts';
import { tempDir } from './temp.js';
import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { constants } from 'node:module';
import { describe, expect, it } from 'vitest';

/**
 * SIG-422. pnpm and npm call `module.enableCompileCache()` on startup, and with
 * no directory that writes `node-compile-cache` into the tmpdir, where nothing
 * the suite owns removes it. `vitest.config.ts` sets `NODE_DISABLE_COMPILE_CACHE`
 * for every process a test spawns. See "A spawned tool's compile cache" in
 * `packages/sigil/src/testing/AGENTS.md`.
 */
describe('a spawned compile cache', () => {
  // the config is asked directly because a child cannot tell where the variable
  // came from: with v8 coverage on, which is how CI runs the suite, vitest sets
  // it for every worker itself, so a child reports the cache disabled whether
  // or not this package's config says so. `pnpm test` and `pnpm test:leaks`
  // run without coverage, and those are the runs that leaked
  it('should disable the compile cache in its own vitest config', () => {
    expect(config.test?.env?.NODE_DISABLE_COMPILE_CACHE).toBe('1');
  });

  // and this is what the variable is for: the call pnpm makes, with the tmpdir
  // pointed at a directory this file owns
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
