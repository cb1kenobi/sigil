import { createSampler, systemDeps } from '../src/sampler.js';
import { describe, expect, it } from 'vitest';

/** A machine that does exactly what the test says, one reading at a time. */
function machine(platform, files = {}, commands = {}, cores = 1) {
  let at = 0;
  let busy = 0;
  /** Every signal a command was handed, so a test can ask whether it was aborted. */
  const signals = [];
  return {
    advance(ms, work) {
      at += ms;
      busy += work;
    },
    deps: {
      cpus: () => Array.from({ length: cores }, () => ({ times: { idle: at - busy, user: busy } })),
      exec: async (file, _args, signal) => {
        signals.push(signal);
        if (!(file in commands)) {
          throw new Error(`no ${file}`);
        }
        return typeof commands[file] === 'function' ? commands[file](signal) : commands[file];
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
    signals,
  };
}

/**
 * A Linux machine with one process, pid 9, whose cpu ticks and the machine's
 * total jiffies the test sets between samples.
 */
function linux({
  cores = 1,
  commands = {},
  passwd = 'chris:x:1000:1000::/home/chris:/bin/sh\n',
} = {}) {
  const state = { passwd, ticks: 0, total: 0 };
  // the fields after the state: utime is the 11th, starttime the 19th and rss
  // the 21st, which parseProcPidStat counts from the state itself, one earlier
  const field = (i) => ({ 10: state.ticks, 18: 4321, 20: 2 })[i] ?? 0;
  const stat = () => `9 (worker) S ${Array.from({ length: 25 }, (_, i) => field(i)).join(' ')}`;
  const m = machine(
    'linux',
    {
      '/etc/passwd': () => (typeof state.passwd === 'function' ? state.passwd() : state.passwd),
      '/proc/9/stat': stat,
      '/proc/net/dev': 'eth0: 0 0 0 0 0 0 0 0 0 0\n',
      '/proc/stat': () => `cpu  ${state.total} 0 0 0\n`,
    },
    commands,
    cores
  );
  return { ...m, state };
}

describe('createSampler', () => {
  it('should report zero loads and rates on the first sample, however long after it was built', async () => {
    let rx = 1000;
    const m = machine(
      'darwin',
      {},
      {
        netstat: () => `en0 1500 <Link#1> aa 1 0 ${rx} 1 0 ${rx / 2} 0`,
        ps: '  7 chris 1.0 2.0 100 Thu Nov  5 21:14:03 2026 /bin/zsh\n',
      }
    );
    const sampler = createSampler(m.deps);

    // busy between building the sampler and the first reading: building one
    // reads nothing, so none of this is a difference the first sample can take
    m.advance(1000, 500);
    const first = await sampler.sample();
    expect(first.cores).toEqual([0]);
    expect(first.net).toEqual({ rx: 0, tx: 0 });
    expect(first.processes.map((p) => p.name)).toEqual(['zsh']);

    m.advance(2000, 500);
    rx += 4000;
    const second = await sampler.sample();
    expect(second.cores).toEqual([0.25]);
    expect(second.net).toEqual({ rx: 2000, tx: 1000 });
  });

  it('should fall back to freemem when vm_stat is not there', async () => {
    const sampler = createSampler(machine('darwin', {}, { ps: '' }).deps);
    expect((await sampler.sample()).memory).toEqual({ total: 16, used: 12 });
  });

  it('should read processes from /proc on linux, with cpu as the percent of one core', async () => {
    const m = linux({ commands: { getconf: '16384\n' }, cores: 2 });
    const sampler = createSampler(m.deps);

    const first = await sampler.sample();
    // two pages of the size getconf reported, not of an assumed 4 KiB
    expect(first.processes).toEqual([
      {
        cpu: 0,
        mem: (2 * 16384 * 100) / 16,
        name: 'worker',
        pid: 9,
        rss: 32768,
        started: '4321',
        user: 'chris',
      },
    ]);

    // two cores' worth of machine, 200 jiffies, with 50 of them spent in the
    // process: a quarter of the machine, which is half of one core
    m.state.ticks = 50;
    m.state.total = 200;
    m.advance(1000, 0);
    expect((await sampler.sample()).processes[0]?.cpu).toBe(50);
  });

  it('should count rss in 4 KiB pages when getconf cannot say', async () => {
    const sampler = createSampler(linux().deps);
    expect((await sampler.sample()).processes[0]?.rss).toBe(2 * 4096);
  });

  it('should ask getconf for the page size once, not every sample', async () => {
    let asked = 0;
    const m = linux({
      commands: {
        getconf: () => {
          asked++;
          return '16384\n';
        },
      },
    });
    const sampler = createSampler(m.deps);
    await sampler.sample();
    await sampler.sample();
    expect(asked).toBe(1);
  });

  it('should stop a /proc walk at the next file when it is stopped', async () => {
    let reads = 0;
    /** @type {ReturnType<typeof createSampler>} */
    let sampler;
    const stat = (pid) => () => {
      reads++;
      // quit arrives while the walk is on its second process
      if (reads === 2) {
        sampler.stop();
      }
      return `${pid} (p) S ${Array.from({ length: 25 }, () => 0).join(' ')}`;
    };
    const files = Object.fromEntries(
      [1, 2, 3, 4, 5].map((pid) => [`/proc/${pid}/stat`, stat(pid)])
    );
    sampler = createSampler(
      machine('linux', { ...files, '/etc/passwd': '', '/proc/stat': 'cpu  0 0 0 0\n' }).deps
    );
    await expect(sampler.sample()).rejects.toMatchObject({ name: 'AbortError' });
    expect(reads).toBe(2);
  });

  it('should read a pid reused since the last sample as a new process, not a negative cpu', async () => {
    const m = linux();
    const sampler = createSampler(m.deps);
    m.state.ticks = 80;
    m.state.total = 100;
    await sampler.sample();

    // pid 9 exited and a new process was given its number: far fewer ticks
    m.state.ticks = 5;
    m.state.total = 200;
    m.advance(1000, 0);
    expect((await sampler.sample()).processes[0]?.cpu).toBe(0);
  });

  it('should try /etc/passwd again on a later sample when it could not be read', async () => {
    let reads = 0;
    const m = linux({
      passwd: () => {
        reads++;
        if (reads === 1) {
          throw new Error('EIO');
        }
        return 'chris:x:1000:1000::/home/chris:/bin/sh\n';
      },
    });
    const sampler = createSampler(m.deps);
    expect((await sampler.sample()).processes[0]?.user).toBe('1000');
    expect((await sampler.sample()).processes[0]?.user).toBe('chris');
  });

  it('should keep an empty /etc/passwd rather than reading it every sample', async () => {
    let reads = 0;
    const m = linux({
      passwd: () => {
        reads++;
        return '';
      },
    });
    const sampler = createSampler(m.deps);
    await sampler.sample();
    await sampler.sample();
    expect(reads).toBe(1);
  });

  it('should carry on with no network when netstat fails', async () => {
    const sampler = createSampler(machine('darwin', {}, { ps: '' }).deps);
    expect((await sampler.sample()).net).toEqual({ rx: 0, tx: 0 });
  });

  it('should fail the sample when ps fails, rather than report no processes', async () => {
    const sampler = createSampler(machine('darwin').deps);
    await expect(sampler.sample()).rejects.toThrow('no ps');
  });

  it('should fail the sample when /proc cannot be walked, rather than report no processes', async () => {
    const m = linux();
    const sampler = createSampler({
      ...m.deps,
      readdir: async () => {
        throw new Error('EACCES /proc');
      },
    });
    await expect(sampler.sample()).rejects.toThrow('EACCES /proc');
  });

  it('should read nothing once it is stopped', async () => {
    const m = linux();
    let reads = 0;
    const sampler = createSampler({
      ...m.deps,
      readFile: (path) => {
        reads++;
        return m.deps.readFile(path);
      },
    });
    sampler.stop();
    await expect(sampler.sample()).rejects.toMatchObject({ name: 'AbortError' });
    expect(reads).toBe(0);
  });

  it('should kill the commands still running when it is stopped', async () => {
    // a `ps` that never finishes on its own, the way a stuck one does
    const hang = (signal) =>
      new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason));
      });
    const m = machine('darwin', {}, { netstat: hang, ps: hang, vm_stat: hang });
    const sampler = createSampler(m.deps);

    const pending = sampler.sample();
    sampler.stop();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(m.signals).toHaveLength(3);
    expect(m.signals.every((s) => s.aborted)).toBe(true);
  });
});

describe('systemDeps.exec', () => {
  it('should kill the child when its signal is aborted, rather than waiting for it', async () => {
    const running = new AbortController();
    const child = systemDeps.exec(
      process.execPath,
      ['-e', 'setTimeout(() => {}, 3000)'],
      running.signal
    );
    running.abort();
    await expect(child).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('should run commands in the C locale, whose words the parsers read', async () => {
    const out = await systemDeps.exec(
      process.execPath,
      ['-e', 'process.stdout.write(JSON.stringify([process.env.LC_ALL, process.env.PATH]))'],
      new AbortController().signal
    );
    // and in the rest of this process's environment: without its PATH a child
    // finds `ps` in the default /usr/bin and not `netstat`, which is in /usr/sbin
    expect(JSON.parse(out)).toEqual(['C', process.env.PATH]);
  });
});
