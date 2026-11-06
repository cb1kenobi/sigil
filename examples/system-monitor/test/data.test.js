import {
  cpuLoad,
  filterProcesses,
  formatBytes,
  parseNetstat,
  parsePasswd,
  parseProcNetDev,
  parseProcPidStat,
  parseProcStatTotal,
  parsePs,
  parseVmStat,
  pushHistory,
  rate,
  refuseKill,
  reselect,
  scrollTop,
  sortProcesses,
} from '../src/data.js';
import { describe, expect, it } from 'vitest';

const proc = (pid, cpu, mem, name = `p${pid}`, user = 'chris') => ({
  cpu,
  mem,
  name,
  pid,
  rss: 0,
  user,
});

describe('cpuLoad', () => {
  it('should be the busy share of the interval per core', () => {
    const prev = [
      { times: { idle: 100, sys: 0, user: 0 } },
      { times: { idle: 0, sys: 0, user: 0 } },
    ];
    const next = [
      { times: { idle: 150, sys: 25, user: 25 } },
      { times: { idle: 100, sys: 0, user: 0 } },
    ];
    expect(cpuLoad(prev, next)).toEqual([0.5, 0]);
  });

  it('should read a core whose counters did not move as idle rather than dividing by zero', () => {
    const same = [{ times: { idle: 5, user: 5 } }];
    expect(cpuLoad(same, same)).toEqual([0]);
  });

  it('should read a core with no earlier reading as idle', () => {
    expect(cpuLoad([], [{ times: { idle: 5, user: 5 } }])).toEqual([0]);
  });
});

describe('parsePs', () => {
  it('should read every column and take the name off the end of the path', () => {
    const out = parsePs(
      [
        '    1 root               0.3  0.1  26576 Wed Nov  4 03:04:40 2026     /sbin/launchd',
        '16847 chris              3.3  1.6 802000 Thu Nov  5 15:05:50 2026     /Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        'garbage',
        '',
      ].join('\n')
    );
    expect(out).toEqual([
      {
        cpu: 0.3,
        mem: 0.1,
        name: 'launchd',
        pid: 1,
        rss: 26576 * 1024,
        started: 'Wed Nov 4 03:04:40 2026',
        user: 'root',
      },
      {
        cpu: 3.3,
        mem: 1.6,
        name: 'Google Chrome',
        pid: 16847,
        rss: 802000 * 1024,
        started: 'Thu Nov 5 15:05:50 2026',
        user: 'chris',
      },
    ]);
  });
});

describe('the /proc readers', () => {
  it('should sum the fields of the cpu line', () => {
    expect(parseProcStatTotal('cpu  10 20 30 40\ncpu0 1 2 3 4\n')).toBe(100);
  });

  it('should leave guest and guest_nice out of the total, since user and nice already count them', () => {
    expect(parseProcStatTotal('cpu  10 20 30 40 0 0 0 0 7 3\n')).toBe(100);
  });

  it('should count stat fields from the last parenthesis, since a command may hold one', () => {
    const fields = Array.from({ length: 30 }, (_, i) => i + 3);
    // field 14 is utime, 15 stime, 22 starttime and 24 rss, by proc(5)'s numbering
    const stat = `42 (a (weird) name) ${fields.join(' ')}`;
    expect(parseProcPidStat(stat)).toEqual({
      name: 'a (weird) name',
      pid: 42,
      rssPages: 24,
      started: '22',
      ticks: 14 + 15,
    });
  });

  it('should refuse a stat line that is not one', () => {
    expect(parseProcPidStat('nonsense')).toBeUndefined();
    expect(parseProcPidStat('1 (x) S 1 2')).toBeUndefined();
  });

  it('should map uids to names', () => {
    const names = parsePasswd(
      'root:x:0:0::/root:/bin/sh\n# comment\nchris:x:1000:1000::/home/chris:/bin/zsh\n'
    );
    expect([...names]).toEqual([
      [0, 'root'],
      [1000, 'chris'],
    ]);
  });
});

describe('the network readers', () => {
  it('should sum the link rows of netstat, skipping loopback, read from the right', () => {
    const text = [
      'Name       Mtu   Network       Address            Ipkts Ierrs     Ibytes    Opkts Oerrs     Obytes  Coll',
      'lo0        16384 <Link#1>                        207277     0  241174022   207277     0  241174022     0',
      'lo0        16384 127           127.0.0.1         207277     -  241174022   207277     -  241174022     -',
      'en0        1500  <Link#11>   aa:bb:cc:dd:ee:ff  100     0       1000      50     0        500     0',
      'en0        1500  192.168.1     192.168.1.2      100     -       1000      50     -        500     -',
      'utun0      1380  <Link#20>                       10     0        200       5     0         50     0',
    ].join('\n');
    expect(parseNetstat(text)).toEqual({ rx: 1200, tx: 550 });
  });

  it('should sum /proc/net/dev, skipping lo', () => {
    const text = [
      'Inter-|   Receive                                                |  Transmit',
      ' face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets',
      '    lo: 999 1 0 0 0 0 0 0 999 1 0 0 0 0 0 0',
      '  eth0: 1000 1 0 0 0 0 0 0 400 1 0 0 0 0 0 0',
      ' wlan0: 24 1 0 0 0 0 0 0 6 1 0 0 0 0 0 0',
    ].join('\n');
    expect(parseProcNetDev(text)).toEqual({ rx: 1024, tx: 406 });
  });

  it('should never report a negative rate', () => {
    expect(rate(100, 300, 2)).toBe(100);
    expect(rate(300, 100, 2)).toBe(0);
    expect(rate(0, 100, 0)).toBe(0);
  });
});

describe('parseVmStat', () => {
  it('should count app memory, wired and compressed, at the reported page size', () => {
    const text = [
      'Mach Virtual Memory Statistics: (page size of 16384 bytes)',
      'Pages free:                                   155627.',
      'Pages wired down:                             10.',
      'Pages purgeable:                              5.',
      'Anonymous pages:                              100.',
      'Pages occupied by compressor:                 20.',
    ].join('\n');
    expect(parseVmStat(text)).toBe((100 - 5 + 10 + 20) * 16384);
  });

  it('should give nothing for output it does not recognise', () => {
    expect(parseVmStat('hello')).toBeUndefined();
  });
});

describe('sorting, filtering and the selection', () => {
  const list = [proc(3, 10, 1, 'zsh'), proc(1, 50, 2, 'node'), proc(2, 10, 9, 'bash', 'root')];

  it('should sort by each column, with the pid breaking a tie', () => {
    expect(sortProcesses(list, 'cpu').map((p) => p.pid)).toEqual([1, 2, 3]);
    expect(sortProcesses(list, 'mem').map((p) => p.pid)).toEqual([2, 1, 3]);
    expect(sortProcesses(list, 'pid').map((p) => p.pid)).toEqual([1, 2, 3]);
    expect(sortProcesses(list, 'name').map((p) => p.name)).toEqual(['bash', 'node', 'zsh']);
  });

  it('should filter by name, user and exact pid, ignoring case', () => {
    expect(filterProcesses(list, 'NO').map((p) => p.pid)).toEqual([1]);
    expect(filterProcesses(list, 'root').map((p) => p.pid)).toEqual([2]);
    expect(filterProcesses(list, '  ')).toBe(list);
  });

  it('should match a pid exactly rather than as a substring', () => {
    // named without digits, so that only the pid can match
    const pids = [proc(3, 0, 0, 'zsh'), proc(13, 0, 0, 'node'), proc(30, 0, 0, 'bash')];
    expect(filterProcesses(pids, '3').map((p) => p.pid)).toEqual([3]);
  });

  it('should keep the selected pid when it moved', () => {
    expect(reselect(list, [...list].reverse(), 1)).toBe(1);
  });

  it('should keep the row when the selected pid went away', () => {
    const prev = [proc(1, 0, 0), proc(2, 0, 0), proc(3, 0, 0)];
    expect(reselect(prev, [proc(1, 0, 0), proc(3, 0, 0)], 2)).toBe(3);
    expect(reselect(prev, [proc(1, 0, 0)], 3)).toBe(1);
    expect(reselect(prev, [], 1)).toBeUndefined();
  });

  it('should scroll just far enough to show the selection', () => {
    expect(scrollTop(0, 4, 5, 20)).toBe(0);
    expect(scrollTop(0, 5, 5, 20)).toBe(1);
    expect(scrollTop(10, 3, 5, 20)).toBe(3);
    expect(scrollTop(18, 19, 5, 20)).toBe(15);
    expect(scrollTop(3, 0, 0, 20)).toBe(0);
  });
});

describe('refuseKill', () => {
  it('should refuse pid 1 and the monitor itself, and nothing else', () => {
    expect(refuseKill(1, 500)).toMatch(/init/);
    expect(refuseKill(500, 500)).toMatch(/this monitor/);
    expect(refuseKill(42, 500)).toBeUndefined();
  });
});

describe('the small helpers', () => {
  it('should keep a history to its cap, dropping the oldest', () => {
    expect(pushHistory([1, 2, 3], 4, 3)).toEqual([2, 3, 4]);
    expect(pushHistory([], 1, 3)).toEqual([1]);
  });

  it('should print bytes in binary units', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(1536)).toBe('1.5 KiB');
    expect(formatBytes(12 * 1024 ** 3)).toBe('12 GiB');
    expect(formatBytes(-5)).toBe('0 B');
  });
});
