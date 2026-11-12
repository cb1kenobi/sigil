import { check, isFreshStamp } from '../src/updates/index.js';
import { cacheFileName } from '../src/updates/registry.js';
import { CLOCK_TOLERANCE } from '../src/updates/stamp.js';
import { tempDir } from './temp.js';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createServer, type AddressInfo } from 'node:net';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const DAY = 86_400_000;
const NOW = 1_762_000_000_000;

// `isFreshStamp()` is the one definition of a fresh stamp for every cache sigil
// keeps: the update check's and `sigil package`'s runtime listings (SIG-420).
// Both used to ask only "too old", so a stamp in the future was fresh until real
// time caught up with it, and a string of digits was concatenated
describe('a fresh cache stamp', () => {
  it('should be fresh from now back to the oldest acceptable age', () => {
    expect(isFreshStamp(NOW, DAY, NOW)).toBe(true);
    expect(isFreshStamp(NOW - DAY, DAY, NOW)).toBe(true);
    expect(isFreshStamp(NOW - DAY - 1, DAY, NOW)).toBe(false);
  });

  it('should be stale when stamped a year ahead', () => {
    expect(isFreshStamp(NOW + 365 * DAY, DAY, NOW)).toBe(false);
  });

  it('should be stale when stamped just past the minute of tolerance', () => {
    expect(CLOCK_TOLERANCE).toBe(60_000);
    expect(isFreshStamp(NOW + CLOCK_TOLERANCE + 1, DAY, NOW)).toBe(false);
  });

  it('should still be fresh when stamped within the minute of tolerance', () => {
    // a clock NTP nudged back between two runs is jitter rather than a wrong
    // clock, and refetching over it would be a request per run
    expect(isFreshStamp(NOW + 30_000, DAY, NOW)).toBe(true);
    expect(isFreshStamp(NOW + CLOCK_TOLERANCE, DAY, NOW)).toBe(true);
  });

  it('should be stale when the stamp is a string of digits', () => {
    // `"1762…" + 86400000` concatenates, and compares as a number far ahead
    expect(isFreshStamp(String(NOW), DAY, NOW)).toBe(false);
  });

  it('should be stale when the stamp is not a finite number', () => {
    for (const ts of [NaN, Infinity, -Infinity, 'nope', 'NaN', null, undefined, true, {}, [NOW]]) {
      expect(isFreshStamp(ts, DAY, NOW), String(ts)).toBe(false);
    }
  });

  it('should take any finite stamp up to the tolerance when there is no age limit', () => {
    expect(isFreshStamp(0, Infinity, NOW)).toBe(true);
    expect(isFreshStamp(NOW + 365 * DAY, Infinity, NOW)).toBe(false);
  });

  it('should judge against the clock when no time is given', () => {
    expect(isFreshStamp(Date.now(), DAY)).toBe(true);
    expect(isFreshStamp(Date.now() + 365 * DAY, DAY)).toBe(false);
  });
});

describe('the update check over a cache stamped a year ahead', () => {
  it('should ask again rather than answering from it', async () => {
    // a local listener that drops every connection, so a fetch shows up as a
    // connection and nothing leaves the machine
    const cacheDir = tempDir('sigil-stamp-');
    mkdirSync(cacheDir, { recursive: true });
    writeFileSync(
      join(cacheDir, cacheFileName('stamped', 'latest')),
      JSON.stringify({ body: { latest: '9.9.9' }, ts: Date.now() + 365 * DAY })
    );

    let connections = 0;
    const server = createServer((socket) => {
      connections++;
      socket.destroy();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;

    try {
      const result = await check({
        cacheDir,
        checker: { path: ['latest'], type: 'custom', url: `https://127.0.0.1:${port}/none` },
        packageName: 'stamped',
        packageVersion: '1.0.0',
        timeout: 5000,
        wait: true,
      }).catch(() => undefined);

      expect(connections).toBe(1);
      expect(result?.latest).toBe(undefined);
    } finally {
      server.close();
    }
  });
});
