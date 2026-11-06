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

/**
 * What Linux's rss is counted in when `getconf` cannot say. The real size is a
 * kernel setting -- 4 KiB on x86-64, 16 or 64 KiB on many arm64 and ppc64
 * kernels -- so it is asked for rather than assumed.
 */
const FALLBACK_PAGE_SIZE = 4096;

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
 * @property {(file: string, args: string[], signal: AbortSignal) => Promise<string>} exec - Runs
 *   a command in the C locale and resolves with what it printed. Aborting `signal`
 *   kills it.
 * @property {(path: string) => Promise<string>} readFile
 * @property {(path: string) => Promise<string[]>} readdir
 * @property {(path: string) => Promise<number>} uidOf
 */

/**
 * The real system. Commands run in the C locale because the parsers read their
 * words: `ps`'s start time is `Thu Nov  5` there and `Do.  5 Nov.` in German.
 */
export const systemDeps = /** @type {SamplerDeps} */ ({
  cpus: () => os.cpus(),
  exec: (file, args, signal) =>
    new Promise((resolve, reject) => {
      const env = { ...process.env, LC_ALL: 'C' };
      execFile(file, args, { env, maxBuffer: 16 * 1024 * 1024, signal }, (err, stdout) =>
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
 * Builds a sampler. Building one reads nothing: the first `sample()` is the
 * first reading, and with nothing to take a difference against its core loads,
 * process CPU and network rates are zero. Every one after is the interval since
 * the last.
 *
 * One sample at a time: each one moves the baseline the next is measured from,
 * so the app does not ask for another while one is still being read.
 *
 * `stop()` ends a reading still in flight: on macOS it kills whatever `ps`,
 * `netstat` or `vm_stat` is running, and on Linux the `/proc` walk stops at the
 * next file. Either keeps node alive until it finishes, so without it quitting
 * the app would hand back the screen and then keep the shell waiting.
 *
 * @param {Partial<SamplerDeps>} [overrides] - What to read instead of the system.
 * @returns {{ sample(): Promise<Snapshot>, stop(): void }} The sampler.
 */
export function createSampler(overrides = {}) {
  const deps = { ...systemDeps, ...overrides };
  const running = new AbortController();
  const exec = (file, args) => deps.exec(file, args, running.signal);
  /** @type {readonly { times: Record<string, number> }[]} */
  let prevCpus = [];
  /** @type {{ rx: number, tx: number } | undefined} */
  let prevNet;
  let prevAt = 0;
  /** Linux only: each pid's ticks, and the machine's, at the last reading. */
  let prevTicks = new Map();
  let prevTotal = 0;
  /** @type {Map<number, string> | undefined} */
  let users;
  /** @type {number | undefined} */
  let pageSize;

  async function network() {
    try {
      return deps.platform === 'linux'
        ? parseProcNetDev(await deps.readFile('/proc/net/dev'))
        : parseNetstat(await exec('netstat', ['-ibn']));
    } catch {
      return { rx: 0, tx: 0 };
    }
  }

  /** Uid to name. A file that could not be read is tried again next tick; an empty one is kept. */
  async function userNames() {
    if (!users) {
      try {
        users = parsePasswd(await deps.readFile('/etc/passwd'));
      } catch {
        return new Map();
      }
    }
    return users;
  }

  /** The size of the pages Linux counts rss in. Asked once: it cannot change while we run. */
  async function readPageSize() {
    const size = Number(await exec('getconf', ['PAGESIZE']).catch(() => ''));
    return size > 0 ? size : FALLBACK_PAGE_SIZE;
  }

  async function linuxProcesses(cores, totalmem) {
    const names = await userNames();
    pageSize ??= await readPageSize();
    const total = parseProcStatTotal(await deps.readFile('/proc/stat'));
    const span = total - prevTotal;
    const ticks = new Map();
    const out = [];
    for (const entry of await deps.readdir('/proc')) {
      // a file read takes no signal, so the walk asks between reads whether it
      // was stopped. Throwing abandons the reading; nobody is waiting for it
      running.signal.throwIfAborted();
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
        // fewer ticks than last time is a pid that was reused by a new process
        // since: it is new, with nothing of its own to take a difference against
        const before = prevTicks.get(it.pid);
        const fresh = before === undefined || it.ticks < before;
        const rss = it.rssPages * pageSize;
        out.push({
          // the span is every core's jiffies together, so the share of it times
          // the cores is the percent of one core, which is what `ps` reports too
          cpu: fresh || span <= 0 ? 0 : ((it.ticks - before) / span) * cores * 100,
          mem: totalmem > 0 ? (rss / totalmem) * 100 : 0,
          name: it.name,
          pid: it.pid,
          rss,
          started: it.started,
          user: names.get(uid) ?? String(uid),
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
      const used = await exec('vm_stat', [])
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
        : parsePs(await exec('ps', ['-axo', 'pid=,user=,pcpu=,pmem=,rss=,lstart=,comm=']));
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
    stop() {
      running.abort();
    },
  };
}
