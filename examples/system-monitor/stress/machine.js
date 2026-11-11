/**
 * A machine that does not exist: a thousand processes whose every figure moves
 * on every reading, and nothing read from the operating system.
 *
 * It is what the stress workload is fed, and it is shaped as the sampler's
 * `Snapshot` so that it can feed the monitor's own `App` through
 * `SystemContext` as well. Seeded, so a run is the same run every time: the
 * bytes a frame writes are a function of the readings, and the suite's
 * ceilings are on those bytes, so a reading that differed from one run to the
 * next would make a ceiling a guess.
 */

/** The names a process is given, so the name column has words of several widths in it. */
const NAMES = Object.freeze([
  'node',
  'postgres',
  'nginx: worker process',
  'kernel_task',
  'Google Chrome Helper (Renderer)',
  'rustc',
  'sshd',
  'zsh',
  'cargo build --release',
  'mds_stores',
  'WindowServer',
  'containerd-shim-runc-v2',
  'python3 -m http.server',
  'redis-server *:6379',
  'java -Xmx4g -jar app.jar',
  'vim',
]);

const USERS = Object.freeze(['root', 'chris', 'postgres', '_windowserver', 'www-data', 'nobody']);

/**
 * A small fast generator, so a run is reproducible from its seed.
 *
 * @param {number} seed - Where it starts.
 * @returns {() => number} A number in [0, 1).
 */
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Builds the machine.
 *
 * @param {{ processes?: number, cores?: number, churn?: number, seed?: number }} [opts] -
 *   How many processes it runs, how many cores it has, how many processes exit and
 *   as many start on each reading, and the seed.
 * @returns {{ step(): import('../src/sampler.js').Snapshot, readonly readings: number }}
 *   `step()` takes the next reading: every process, core and rate moved, and every
 *   process a new object, as the real sampler hands back.
 */
export function createMachine(opts = {}) {
  const count = opts.processes ?? 1000;
  const coreCount = opts.cores ?? 16;
  const churn = opts.churn ?? 2;
  const random = mulberry32(opts.seed ?? 290);
  const total = 32 * 1024 ** 3;

  let nextPid = 100;
  let readings = 0;
  /** @returns {import('../src/data.js').Process} */
  const spawn = () => {
    const pid = nextPid++;
    const mem = random() * 2;
    return {
      cpu: random() * 20,
      mem,
      name: NAMES[Math.floor(random() * NAMES.length)],
      pid,
      rss: Math.round((mem / 100) * total),
      started: `reading ${readings}`,
      user: USERS[Math.floor(random() * USERS.length)],
    };
  };

  let processes = Array.from({ length: count }, spawn);
  let cores = Array.from({ length: coreCount }, () => random());
  let used = total * 0.4;

  /** A step of a walk, held between its bounds. */
  const walk = (value, by, min, max) => Math.min(max, Math.max(min, value + (random() - 0.5) * by));

  return {
    get readings() {
      return readings;
    },

    step() {
      readings++;
      // a few go and as many arrive, so the table's keys change as well as its order
      for (let i = 0; i < churn; i++) {
        processes.splice(Math.floor(random() * processes.length), 1);
      }
      processes = processes.map((p) => {
        const cpu = walk(p.cpu, 8, 0, 400);
        const mem = walk(p.mem, 0.2, 0, 50);
        return { ...p, cpu, mem, rss: Math.round((mem / 100) * total) };
      });
      for (let i = 0; i < churn; i++) {
        processes.push(spawn());
      }
      cores = cores.map((load) => walk(load, 0.3, 0, 1));
      used = walk(used, total * 0.05, total * 0.1, total * 0.95);
      return {
        cores,
        memory: { total, used },
        net: { rx: random() * 50 * 1024 ** 2, tx: random() * 10 * 1024 ** 2 },
        processes,
      };
    },
  };
}
