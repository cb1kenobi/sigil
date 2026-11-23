/**
 * TEMPORARY (SIG-638): measures where `oxc-parser` crashes on the default main
 * thread stack of the platform it runs on, in a child process per depth, since
 * a native stack overflow is a signal or an `0xC00000FD` and no assertion
 * survives it. Windows only on CI. Fails on purpose with the table, so that it
 * reaches the job's annotations. Removed in the next commit.
 */

import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { expect, it } from 'vitest';

const DEPTHS: Record<string, number[]> = {
  function: [256, 384, 420, 512, 768, 1024, 1536, 2048, 3000, 4000],
  or: [256, 512, 768, 1024, 1536, 2048, 3000, 4500],
};

it.runIf(process.platform === 'win32' || process.env.SIGIL_STACK_PROBE === '1')(
  'should measure where the parser crashes',
  () => {
    const dir = mkdtempSync(join(tmpdir(), 'sigil-stack-probe-'));
    try {
      const oxc = pathToFileURL(createRequire(import.meta.url).resolve('oxc-parser')).href;
      const script = join(dir, 'probe.mjs');
      writeFileSync(
        script,
        [
          `import { parseSync } from ${JSON.stringify(oxc)};`,
          `const [kind, n] = [process.argv[2], Number(process.argv[3])];`,
          `const source = kind === 'function'`,
          `  ? 'function f(){'.repeat(n) + '}'.repeat(n)`,
          `  : '('.repeat(n) + 'a' + ' || a)'.repeat(n);`,
          `const r = parseSync('probe.ts', source);`,
          `console.log(r.errors.length);`,
          '',
        ].join('\n')
      );

      const rows: string[] = [];
      for (const [kind, depths] of Object.entries(DEPTHS)) {
        for (const depth of depths) {
          const ran = spawnSync(process.execPath, [script, kind, String(depth)], {
            encoding: 'utf-8',
            timeout: 60_000,
          });
          rows.push(
            `${kind} ${depth}: status=${ran.status} signal=${ran.signal} out=${ran.stdout.trim()}`
          );
        }
      }

      expect(
        `${process.platform} ${process.arch} node ${process.version}\n${rows.join('\n')}`
      ).toBe('PROBE');
    } finally {
      rmSync(dir, { force: true, recursive: true });
    }
  },
  600_000
);
