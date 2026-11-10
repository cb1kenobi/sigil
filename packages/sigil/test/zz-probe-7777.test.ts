import { tempDir } from './temp.js';
import { chmodSync, mkdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';

// TEMPORARY PROBE for SIG-373, removed before review: what does the kernel make
// of `mkdir(0o7777)`? Fails on Linux on purpose so the answer is in the log
it.skipIf(process.platform !== 'linux')('SIG373PROBE', () => {
  const base = join(tempDir('sigil-probe-'), 'parent');
  mkdirSync(base);
  chmodSync(base, 0o755);
  const dest = join(base, 'a', 'b');
  mkdirSync(dest, { mode: 0o7777, recursive: true });
  const single = join(base, 'single');
  mkdirSync(single, { mode: 0o7777 });
  const report = [base, join(base, 'a'), dest, single]
    .map((d) => `${d}=${(statSync(d).mode & 0o7777).toString(8)}`)
    .join(' ');
  expect(`SIG373PROBE ${process.version} ${report}`).to.equal('');
});
