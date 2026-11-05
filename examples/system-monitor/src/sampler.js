/**
 * Reads the system once a tick, and turns two readings into rates.
 *
 * Everything that touches the machine comes in through `deps`, so a test hands
 * in fixtures and a clock and gets the same snapshot every time. With no `deps`
 * it reads the real system: `os` for the cores and memory, `ps` and `netstat`
 * on macOS, `/proc` on Linux. Nothing here is a dependency.
 */

import {
  cpuLoad,
  parseNetstat,
  parsePasswd,
  parseProcNetDev,
  parseProcPidStat,
  parseProcStatTotal,
  parsePs,
  parseVmStat,
  rate,
} from './data.js';
import { execFile } from 'node:child_process';
import { readdir, readFile, stat } from 'node:fs/promises';
import os from 'node:os';

/** Linux reports rss in pages, and 4 KiB is what every architecture node supports uses. */
const PAGE_SIZE = 4096;

/**
 * @typedef {object} Snapshot
 * @property {number[]} cores - Each core's load, 0 to 1.
 * @property {{ total: number, used: number }} memory - Bytes.
 * @property {{ rx: number, tx: number }} net - Bytes per second, received and sent.
 * @property {import('./data.js').Process[]} processes
 */

/**
 * @typedef {object} SamplerDeps
 * @property {() => readonly { times: Record<string, number> }[]} cpus
 * @property {() => number} freemem
 * @property {() => number} totalmem
 * @property {() => number} now - Milliseconds.
 * @property {string} platform
 * @property {(file: string, args: string[]) => Promise<string>} exec
 * @property {(path: string) => Promise<string>} readFile
 * @property {(path: string) => Promise<string[]>} readdir
 * @property {(path: string) => Promise<number>} uidOf
 */

/** The real system. */
export const systemDeps = /** @type {SamplerDeps} */ ({
  cpus: () => os.cpus(),
  exec: (file, args) =>
    new Promise((resolve, reject) => {
      execFile(file, args, { maxBuffer: 16 * 1024 * 1024 }, (err, stdout) =>
        err ? reject(err) : resolve(stdout)
      );
    }),
  freemem: () => os.freemem(),
  now: () => Date.now(),
  platform: process.platform,
  readFile: (path) => readFile(path, 'utf8'),
  readdir: (path) => readdir(path),
  totalmem: () => os.totalmem(),
  uidOf: async (path) => (await stat(path)).uid,
});

/**
 * Builds a sampler. The first `sample()` has nothing to take a difference
 * against, so its loads and rates are zero; every one after is the interval
 * since the last.
 *
 * @param {Partial<SamplerDeps>} [overrides] - What to read instead of the system.
 * @returns {{ sample(): Promise<Snapshot> }} The sampler.
 */
export function createSampler(overrides = {}) {
  const deps = { ...systemDeps, ...overrides };
  let prevCpus = deps.cpus();
  let prevNet;
  let prevAt = deps.now();
  /** Linux only: each pid's ticks, and the machine's, at the last reading. */
  let prevTicks = new Map();
  let prevTotal = 0;
  /** @type {Map<number, string> | undefined} */
  let users;

  async function network() {
    try {
      return deps.platform === 'linux'
        ? parseProcNetDev(await deps.readFile('/proc/net/dev'))
        : parseNetstat(await deps.exec('netstat', ['-ibn']));
    } catch {
      return { rx: 0, tx: 0 };
    }
  }

  async function linuxProcesses(cores, totalmem) {
    users ??= parsePasswd(await deps.readFile('/etc/passwd').catch(() => ''));
    const total = parseProcStatTotal(await deps.readFile('/proc/stat'));
    const span = total - prevTotal;
    const ticks = new Map();
    const out = [];
    for (const entry of await deps.readdir('/proc')) {
      if (!/^\d+$/.test(entry)) {
        continue;
      }
      // a process can exit between the readdir and the read, which is not an error
      try {
        const it = parseProcPidStat(await deps.readFile(`/proc/${entry}/stat`));
        if (!it) {
          continue;
        }
        const uid = await deps.uidOf(`/proc/${entry}`);
        ticks.set(it.pid, it.ticks);
        const before = prevTicks.get(it.pid);
        const rss = it.rssPages * PAGE_SIZE;
        out.push({
          cpu: before === undefined || span <= 0 ? 0 : ((it.ticks - before) / span) * cores * 100,
          mem: totalmem > 0 ? (rss / totalmem) * 100 : 0,
          name: it.name,
          pid: it.pid,
          rss,
          user: users.get(uid) ?? String(uid),
        });
      } catch {
        continue;
      }
    }
    prevTicks = ticks;
    prevTotal = total;
    return out;
  }

  /** Bytes in use: `vm_stat` on macOS, where `os.freemem()` counts cache as used. */
  async function memoryUsed(total) {
    if (deps.platform === 'darwin') {
      const used = await deps
        .exec('vm_stat', [])
        .then(parseVmStat)
        .catch(() => undefined);
      if (used !== undefined) {
        return Math.min(total, used);
      }
    }
    return total - deps.freemem();
  }

  async function processes(cores, totalmem) {
    try {
      return deps.platform === 'linux'
        ? await linuxProcesses(cores, totalmem)
        : parsePs(await deps.exec('ps', ['-axo', 'pid=,user=,pcpu=,pmem=,rss=,comm=']));
    } catch {
      return [];
    }
  }

  return {
    async sample() {
      const at = deps.now();
      const seconds = (at - prevAt) / 1000;
      const cpus = deps.cpus();
      const cores = cpuLoad(prevCpus, cpus);
      const total = deps.totalmem();
      const [net, procs, used] = await Promise.all([
        network(),
        processes(cpus.length, total),
        memoryUsed(total),
      ]);
      const snapshot = {
        cores,
        memory: { total, used },
        net: prevNet
          ? { rx: rate(prevNet.rx, net.rx, seconds), tx: rate(prevNet.tx, net.tx, seconds) }
          : { rx: 0, tx: 0 },
        processes: procs,
      };
      prevCpus = cpus;
      prevNet = net;
      prevAt = at;
      return snapshot;
    },
  };
}
