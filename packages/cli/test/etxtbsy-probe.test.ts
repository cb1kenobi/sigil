// TEMPORARY (SIG-482): measures ETXTBSY on CI's Linux jobs; removed before review
import { writeExecutable } from './executable.ts';
import { tempDir } from './temp.js';
import { spawnSync } from 'node:child_process';
import { closeSync, openSync, renameSync, rmSync, writeFileSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { expect, it } from 'vitest';

const FORKER = `
const { spawnSync } = require('node:child_process');
const { workerData } = require('node:worker_threads');
const flag = new Int32Array(workerData);
while (Atomics.load(flag, 0) === 0) spawnSync('true');
`;

type Writer = (path: string, body: string) => void;

const writers: Record<string, Writer> = {
  child: (path, body) => writeExecutable(path, body),
  direct: (path, body) => writeFileSync(path, body, { mode: 0o755 }),
  rename: (path, body) => {
    writeFileSync(`${path}.tmp`, body, { mode: 0o755 });
    renameSync(`${path}.tmp`, path);
  },
};

async function measure(name: string, pad: number, ms: number): Promise<string> {
  const dir = tempDir(`sigil-etxtbsy-${name}-`);
  const body = `#!/bin/sh\nexit 0\n#${'x'.repeat(pad)}\n`;
  const stop = new SharedArrayBuffer(4);
  const workers = Array.from(
    { length: 3 },
    () => new Worker(FORKER, { eval: true, workerData: stop })
  );
  let runs = 0;
  let busy = 0;
  let other = 0;
  const deadline = Date.now() + ms;
  try {
    while (Date.now() < deadline) {
      const path = join(dir, `s${runs}`);
      writers[name]!(path, body);
      const ran = spawnSync(path);
      if ((ran.error as NodeJS.ErrnoException | undefined)?.code === 'ETXTBSY') busy++;
      else if (ran.status !== 0) other++;
      rmSync(path, { force: true });
      runs++;
    }
  } finally {
    Atomics.store(new Int32Array(stop), 0, 1);
    await Promise.all(workers.map((w) => new Promise((r) => w.once('exit', r))));
  }
  return `${name} pad=${pad}: runs=${runs} ETXTBSY=${busy} other=${other}`;
}

it.runIf(process.platform !== 'win32')(
  'ETXTBSY probe',
  async () => {
    const lines: string[] = [];
    // deterministic: a writer held open across a rename still blocks the exec
    const dir = tempDir('sigil-etxtbsy-inode-');
    const fd = openSync(join(dir, 'tmp'), 'w', 0o755);
    writeSync(fd, '#!/bin/sh\nexit 0\n');
    renameSync(join(dir, 'tmp'), join(dir, 'stub'));
    const held = spawnSync(join(dir, 'stub'));
    closeSync(fd);
    const closed = spawnSync(join(dir, 'stub'));
    lines.push(
      `inode: held=${(held.error as NodeJS.ErrnoException | undefined)?.code ?? held.status} closed=${(closed.error as NodeJS.ErrnoException | undefined)?.code ?? closed.status}`
    );
    for (const pad of [32 << 20]) {
      for (const name of ['direct', 'rename', 'child']) {
        lines.push(await measure(name, pad, 6000));
      }
    }
    console.log(`SIG-482 PROBE ${process.platform} ${process.version}\n${lines.join('\n')}`);
    expect(lines).toHaveLength(4);
  },
  60_000
);
