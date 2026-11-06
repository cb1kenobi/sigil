/**
 * The monitor's data, as pure functions over what the operating system printed.
 *
 * Nothing in here reads the system. `sampler.js` does the reading -- `os`, `ps`,
 * `netstat`, `/proc` -- and hands the text to these, so every parser is tested
 * against a fixture rather than against whatever happens to be running on the
 * machine the suite runs on.
 */

/**
 * How busy each core was between two readings of `os.cpus()`.
 *
 * A core's times only ever grow, so the share of the interval it spent idle is
 * the difference in idle over the difference in everything. A core whose counters
 * did not move at all -- two readings in the same tick -- reads as idle rather
 * than as a division by zero.
 *
 * @param {readonly { times: Record<string, number> }[]} prev - The earlier reading.
 * @param {readonly { times: Record<string, number> }[]} next - The later one.
 * @returns {number[]} Each core's load, 0 to 1.
 */
export function cpuLoad(prev, next) {
  return next.map((cpu, i) => {
    const before = prev[i];
    if (!before) {
      return 0;
    }
    const total = sum(cpu.times) - sum(before.times);
    const idle = cpu.times.idle - before.times.idle;
    return total > 0 ? clamp(1 - idle / total, 0, 1) : 0;
  });
}

/**
 * Parses `ps -axo pid=,user=,pcpu=,pmem=,rss=,lstart=,comm=`, run in the C locale.
 *
 * The command is the last column and the only one that may hold a space, so it
 * takes the rest of the line. macOS prints a full path there; the name is its last
 * segment, which is what htop shows by default. `lstart` is when the process
 * started, five words such as `Thu Nov  5 21:14:03 2026` -- in the C locale only,
 * since another one spells the day and month its own way.
 *
 * @param {string} text - What `ps` printed.
 * @returns {Process[]} One entry per process.
 */
export function parsePs(text) {
  const out = [];
  for (const line of text.split('\n')) {
    const m =
      /^\s*(\d+)\s+(\S+)\s+([\d.]+)\s+([\d.]+)\s+(\d+)\s+(\w+\s+\w+\s+\d+\s+[\d:]+\s+\d+)\s+(.+?)\s*$/.exec(
        line
      );
    if (!m) {
      continue;
    }
    out.push({
      cpu: Number(m[3]),
      mem: Number(m[4]),
      name: basename(m[7]),
      pid: Number(m[1]),
      rss: Number(m[5]) * 1024,
      started: m[6].replace(/\s+/g, ' '),
      user: m[2],
    });
  }
  return out;
}

/**
 * The total jiffies on the first line of `/proc/stat`, across every core.
 *
 * Only the first eight fields -- user, nice, system, idle, iowait, irq, softirq
 * and steal. The two after them, guest and guest_nice, are already counted
 * inside user and nice (`proc(5)`), so adding them again would inflate the
 * machine's time and make every process look less busy than it is.
 *
 * @param {string} text - `/proc/stat`.
 * @returns {number} The sum of the `cpu` line's first eight fields.
 */
export function parseProcStatTotal(text) {
  const line = text.split('\n').find((it) => it.startsWith('cpu '));
  if (!line) {
    return 0;
  }
  return line
    .trim()
    .split(/\s+/)
    .slice(1, 9)
    .reduce((acc, it) => acc + Number(it), 0);
}

/**
 * Reads one `/proc/<pid>/stat`.
 *
 * The command sits in parentheses and may itself hold spaces and parentheses, so
 * the fields are counted from the **last** closing one. After it, field 3 of
 * `proc(5)` -- the state -- is index 0, which puts `utime` (14) at 11, `stime`
 * (15) at 12, `starttime` (22, in ticks since boot) at 19 and `rss` (24, in
 * pages) at 21.
 *
 * @param {string} text - The file's contents.
 * @returns {{ name: string, pid: number, rssPages: number, started: string, ticks: number }
 *   | undefined}
 *   The parts the monitor uses, or nothing for a line that is not one.
 */
export function parseProcPidStat(text) {
  const open = text.indexOf('(');
  const close = text.lastIndexOf(')');
  if (open < 0 || close < open) {
    return undefined;
  }
  const rest = text
    .slice(close + 1)
    .trim()
    .split(/\s+/);
  if (rest.length < 22) {
    return undefined;
  }
  return {
    name: text.slice(open + 1, close),
    pid: Number(text.slice(0, open).trim()),
    rssPages: Number(rest[21]),
    started: rest[19],
    ticks: Number(rest[11]) + Number(rest[12]),
  };
}

/**
 * Memory in use on macOS, from `vm_stat`, the way Activity Monitor counts it:
 * app memory (anonymous pages less purgeable ones), wired, and what the
 * compressor occupies.
 *
 * `os.freemem()` is no use here. macOS keeps file cache in pages it reports as
 * not free, so on a machine that has been up a while it reads as nearly full --
 * 46 of 48 GiB on the machine this was written on, against about 34 by this count.
 *
 * @param {string} text - What `vm_stat` printed.
 * @returns {number | undefined} Bytes in use, or nothing if the output was not
 *   recognised.
 */
export function parseVmStat(text) {
  const size = /page size of (\d+) bytes/.exec(text);
  if (!size) {
    return undefined;
  }
  const pages = (label) => {
    const m = new RegExp(`^${label}:\\s+(\\d+)`, 'm').exec(text);
    return m ? Number(m[1]) : 0;
  };
  const app = pages('Anonymous pages') - pages('Pages purgeable');
  const used = Math.max(0, app) + pages('Pages wired down') + pages('Pages occupied by compressor');
  return used * Number(size[1]);
}

/**
 * Maps uids to names from `/etc/passwd`.
 *
 * @param {string} text - The file.
 * @returns {Map<number, string>} Uid to login name.
 */
export function parsePasswd(text) {
  const names = new Map();
  for (const line of text.split('\n')) {
    const [name, , uid] = line.split(':');
    if (name && uid !== undefined && /^\d+$/.test(uid)) {
      names.set(Number(uid), name);
    }
  }
  return names;
}

/**
 * Bytes received and sent, summed over every interface but loopback, from
 * `netstat -ibn` on macOS.
 *
 * Each interface has one `<Link#N>` row carrying its byte counters; the other rows
 * are its addresses repeating them. The address column is empty for some links, so
 * the counters are read from the **right**, where the columns are always present.
 *
 * @param {string} text - What `netstat -ibn` printed.
 * @returns {{ rx: number, tx: number }} Cumulative bytes.
 */
export function parseNetstat(text) {
  let rx = 0;
  let tx = 0;
  for (const line of text.split('\n')) {
    const cols = line.trim().split(/\s+/);
    if (cols.length < 10 || !cols[2]?.startsWith('<Link#') || cols[0]?.startsWith('lo')) {
      continue;
    }
    rx += Number(cols.at(-5)) || 0;
    tx += Number(cols.at(-2)) || 0;
  }
  return { rx, tx };
}

/**
 * Bytes received and sent, summed over every interface but loopback, from
 * `/proc/net/dev` on Linux.
 *
 * @param {string} text - The file.
 * @returns {{ rx: number, tx: number }} Cumulative bytes.
 */
export function parseProcNetDev(text) {
  let rx = 0;
  let tx = 0;
  for (const line of text.split('\n')) {
    const colon = line.indexOf(':');
    if (colon < 0) {
      continue;
    }
    const name = line.slice(0, colon).trim();
    if (name === 'lo') {
      continue;
    }
    const cols = line
      .slice(colon + 1)
      .trim()
      .split(/\s+/);
    rx += Number(cols[0]) || 0;
    tx += Number(cols[8]) || 0;
  }
  return { rx, tx };
}

/**
 * A rate from two cumulative counters, clamped at zero so that a counter that
 * wrapped or an interface that went away reads as a quiet second rather than as
 * a negative one.
 *
 * @param {number} before - The earlier count.
 * @param {number} after - The later count.
 * @param {number} seconds - The time between them.
 * @returns {number} Per second.
 */
export function rate(before, after, seconds) {
  return seconds > 0 ? Math.max(0, (after - before) / seconds) : 0;
}

/** The columns a process table sorts by, and which way each one runs by default. */
export const SORTS = Object.freeze({
  cpu: { desc: true, label: 'CPU%' },
  mem: { desc: true, label: 'MEM%' },
  name: { desc: false, label: 'NAME' },
  pid: { desc: false, label: 'PID' },
});

/** The order `s` steps through. */
export const SORT_ORDER = Object.freeze(['cpu', 'mem', 'pid', 'name']);

/**
 * Sorts processes by one column, with the pid as the tie-break so that two
 * processes at 0.0% do not trade places every second.
 *
 * @param {readonly Process[]} list - The processes.
 * @param {keyof typeof SORTS} key - The column.
 * @returns {Process[]} A sorted copy.
 */
export function sortProcesses(list, key) {
  const desc = SORTS[key].desc;
  return [...list].sort((a, b) => {
    const order =
      key === 'name' ? a.name.localeCompare(b.name) : /** @type {number} */ (a[key] - b[key]);
    return (desc ? -order : order) || a.pid - b.pid;
  });
}

/**
 * Keeps the processes whose name or user contains the query, ignoring case, or
 * whose pid is exactly the query. Exact for the pid because a number is not a
 * name: `/3` should find pid 3, not 13, 23 and 30 beside it.
 *
 * @param {readonly Process[]} list - The processes.
 * @param {string} query - What was typed.
 * @returns {readonly Process[]} The matches; the same list for an empty query.
 */
export function filterProcesses(list, query) {
  const q = query.trim().toLowerCase();
  if (!q) {
    return list;
  }
  return list.filter(
    (p) =>
      p.name.toLowerCase().includes(q) || p.user.toLowerCase().includes(q) || String(p.pid) === q
  );
}

/**
 * Why the monitor will not signal a pid, or nothing if it will.
 *
 * Pid 1 is init -- `launchd`, `systemd` -- and the monitor's own pid is the
 * monitor: SIGTERM to it tears the app down from under the dialog that sent it.
 * Neither is a process anybody means to kill from here.
 *
 * @param {number} pid - The pid to signal.
 * @param {number} self - The monitor's own pid.
 * @returns {string | undefined} What to tell the user, or nothing.
 */
export function refuseKill(pid, self) {
  if (pid === 1) {
    return 'pid 1 is init: not sending it SIGTERM';
  }
  if (pid === self) {
    return 'that is this monitor: quit with q';
  }
  return undefined;
}

/**
 * Which process is selected after the list changed under the selection.
 *
 * Whatever is now on the row the selection was on, clamped to the new length:
 * the highlight stays where the eye left it while a refresh re-sorts the
 * processes under it, rather than chasing one process up and down the table.
 * What was on that row is a pid, and it is the selection's row in `prev` that is
 * kept -- `next` is what fills it.
 *
 * A kill never trusts this to still name the process the dialog asked about: it
 * checks the pid and the start time against a fresh reading first.
 *
 * @param {readonly Process[]} prev - What was shown.
 * @param {readonly Process[]} next - What is shown now.
 * @param {number | undefined} pid - What was selected.
 * @returns {number | undefined} The pid to select.
 */
export function reselect(prev, next, pid) {
  if (next.length === 0) {
    return undefined;
  }
  const at = prev.findIndex((p) => p.pid === pid);
  return next[clamp(at < 0 ? 0 : at, 0, next.length - 1)]?.pid;
}

/**
 * The first visible row, so that the selected one stays on screen.
 *
 * @param {number} top - The current first visible row.
 * @param {number} selected - The selected row.
 * @param {number} rows - How many rows are visible.
 * @param {number} count - How many there are.
 * @returns {number} The new first visible row.
 */
export function scrollTop(top, selected, rows, count) {
  if (rows <= 0) {
    return 0;
  }
  let next = top;
  if (selected < next) {
    next = selected;
  } else if (selected >= next + rows) {
    next = selected - rows + 1;
  }
  return clamp(next, 0, Math.max(0, count - rows));
}

/**
 * A fixed-length history: the newest value goes on the end and the oldest falls
 * off the front.
 *
 * @param {readonly number[]} list - The history so far.
 * @param {number} value - The new sample.
 * @param {number} cap - How many to keep.
 * @returns {number[]} A new array.
 */
export function pushHistory(list, value, cap) {
  const next = [...list, value];
  return next.length > cap ? next.slice(next.length - cap) : next;
}

/**
 * A byte count the way a person reads one: binary units, one decimal under 10.
 *
 * @param {number} n - Bytes.
 * @returns {string} Such as `512 B`, `1.5 KiB` or `12 GiB`.
 */
export function formatBytes(n) {
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  let value = Math.max(0, n);
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  const digits = unit === 0 || value >= 10 ? 0 : 1;
  return `${value.toFixed(digits)} ${units[unit]}`;
}

/**
 * @typedef {object} Process
 * @property {number} pid
 * @property {string} user
 * @property {number} cpu - Percent of one core.
 * @property {number} mem - Percent of physical memory.
 * @property {number} rss - Resident bytes.
 * @property {string} name
 * @property {string} started - When it started, as the system printed it. With the
 *   pid, this is what tells a process from the next one to be given its pid, so
 *   it is compared and never shown.
 */

function sum(times) {
  let total = 0;
  for (const value of Object.values(times)) {
    total += value;
  }
  return total;
}

function clamp(value, lo, hi) {
  return Math.min(hi, Math.max(lo, value));
}

function basename(path) {
  return path.slice(path.lastIndexOf('/') + 1) || path;
}
