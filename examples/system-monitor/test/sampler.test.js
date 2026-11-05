import { createSampler } from '../src/sampler.js';
import { describe, expect, it } from 'vitest';

/** A machine that does exactly what the test says, one reading at a time. */
function machine(platform, files = {}, commands = {}) {
  let at = 0;
  let busy = 0;
  return {
    advance(ms, work) {
      at += ms;
      busy += work;
    },
    deps: {
      cpus: () => [{ times: { idle: at - busy, user: busy } }],
      exec: async (file) => {
        if (!(file in commands)) {
          throw new Error(`no ${file}`);
        }
        return typeof commands[file] === 'function' ? commands[file]() : commands[file];
      },
      freemem: () => 4,
      now: () => at,
      platform,
      readFile: async (path) => {
        const it = files[path];
        if (it === undefined) {
          throw new Error(`ENOENT ${path}`);
        }
        return typeof it === 'function' ? it() : it;
      },
      readdir: async () =>
        Object.keys(files).flatMap((p) => /^\/proc\/(\d+)\/stat$/.exec(p)?.[1] ?? []),
      totalmem: () => 16,
      uidOf: async () => 1000,
    },
  };
}

describe('createSampler', () => {
  it('should report zero loads and rates on the first sample and differences after', async () => {
    let rx = 1000;
    const m = machine(
      'darwin',
      {},
      {
        netstat: () => `en0 1500 <Link#1> aa 1 0 ${rx} 1 0 ${rx / 2} 0`,
        ps: '  7 chris 1.0 2.0 100 /bin/zsh\n',
      }
    );
    const sampler = createSampler(m.deps);

    const first = await sampler.sample();
    expect(first.net).toEqual({ rx: 0, tx: 0 });
    expect(first.processes.map((p) => p.name)).toEqual(['zsh']);

    m.advance(2000, 500);
    rx += 4000;
    const second = await sampler.sample();
    expect(second.cores).toEqual([0.25]);
    expect(second.net).toEqual({ rx: 2000, tx: 1000 });
  });

  it('should fall back to freemem when vm_stat is not there', async () => {
    const sampler = createSampler(machine('darwin').deps);
    expect((await sampler.sample()).memory).toEqual({ total: 16, used: 12 });
  });

  it('should read processes from /proc on linux, with cpu as the share of the interval', async () => {
    let ticks = 0;
    let total = 0;
    // after the state, utime is the 11th field and rss the 21st: see parseProcPidStat
    const stat = () =>
      `9 (worker) S ${Array.from({ length: 25 }, (_, i) => (i === 10 ? ticks : i === 20 ? 2 : 0)).join(' ')}`;
    const m = machine('linux', {
      '/etc/passwd': 'chris:x:1000:1000::/home/chris:/bin/sh\n',
      '/proc/9/stat': stat,
      '/proc/net/dev': 'eth0: 0 0 0 0 0 0 0 0 0 0\n',
      '/proc/stat': () => `cpu  ${total} 0 0 0\n`,
    });
    const sampler = createSampler(m.deps);

    const first = await sampler.sample();
    expect(first.processes).toEqual([
      { cpu: 0, mem: (2 * 4096 * 100) / 16, name: 'worker', pid: 9, rss: 8192, user: 'chris' },
    ]);

    // one core's worth of machine, a quarter of it spent in the process
    ticks = 25;
    total = 100;
    m.advance(1000, 0);
    expect((await sampler.sample()).processes[0]?.cpu).toBe(25);
  });

  it('should carry on with no processes and no network when the commands fail', async () => {
    const sampler = createSampler(machine('darwin').deps);
    const snap = await sampler.sample();
    expect(snap.processes).toEqual([]);
    expect(snap.net).toEqual({ rx: 0, tx: 0 });
  });
});
