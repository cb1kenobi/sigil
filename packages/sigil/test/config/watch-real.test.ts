/**
 * The claims only a real filesystem can settle.
 *
 * Everything else about the watcher is tested against a source that fires on
 * demand, with no sleeps -- which is what `WatchOptions.source` is for. What a
 * fake cannot prove is the thing this whole module is named for: that a real
 * `save()` through the real temp-plus-rename does not kill the watch. So this
 * file is deliberately short, and every test in it is sequenced rather than
 * slept: a negative is asserted by waiting for a **later** event and then
 * counting, never by waiting a fixed time and hoping.
 *
 * This repository has an entry about a fourteen-second test being a flaky test
 * one busy machine later, and a filesystem watcher is the easiest thing in the
 * world to write that way.
 *
 * ## The premise is measured by hand rather than here
 *
 * That a watch on the **file** dies after the first atomic replace is the
 * measurement the whole design rests on -- and it is a claim about the platform
 * rather than about this code, so it is not in the suite. Measured on macOS
 * before any of this was written: a file watch saw the first rename and
 * **nothing** for the second, where a directory watch saw both. It is also not
 * portable -- inotify watches the inode too, so Linux dies for the same reason
 * by a different route and may emit a different event on the way -- and a
 * platform claim in a suite that runs on nine node-and-os combinations is the
 * flakiest thing there is. The first test below is what pins the *design*: if
 * `fs.watch` on a file ever survived a replace, it would go on passing and this
 * module would merely be doing unnecessary work.
 *
 * The first attempt at asserting it here is also worth recording, because it
 * failed for a third reason: a watcher written to immediately after it is
 * created misses the event on macOS, so the measurement needs a warm-up sleep
 * -- which is precisely the shape this file is written to avoid.
 */

import { createConfig, json, object, type ConfigChange } from '../../src/config/index.js';
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'sigil-watch-real-'));
});

afterEach(() => {
  rmSync(root, { force: true, recursive: true });
});

/**
 * Waits for something to become true, and gives up loudly.
 *
 * As short as the event takes rather than a fixed delay, which is what keeps
 * the margin wide: a real event arrives in tens of milliseconds and this allows
 * four seconds, inside a ten-second `testTimeout`.
 */
async function until(what: string, ok: () => boolean): Promise<void> {
  for (let waited = 0; waited < 4000; waited += 10) {
    if (ok()) {
      return;
    }
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`Timed out waiting for ${what}`);
}

/** Replaces a file the way `writeAtomic()` does: a temp file and a rename. */
function atomically(path: string, text: string): void {
  const temp = `${path}.${Math.random().toString(36).slice(2)}.tmp`;
  writeFileSync(temp, text);
  renameSync(temp, path);
}

/**
 * Makes a change and keeps making it until the watcher reports it.
 *
 * Which is not a sleep dressed up: a **cold** watcher -- one created and then
 * written near immediately -- loses its event about 3% of the time under heavy
 * parallel load, measured, where a warm one does not. Every test here writes
 * microseconds after `watch()`, so every one of them is in that window by
 * construction, and a fixed warm-up delay before the first write is exactly the
 * shape this file is written against.
 *
 * Re-applying is safe because the content is **identical** each time: the
 * content compare means at most one publish however many writes it took, so an
 * assertion on the exact change set stays exact. What it says about the platform
 * rather than about this code is written down under `fsSource()`'s own header.
 */
async function changed(path: string, text: string, ok: () => boolean): Promise<void> {
  for (let tries = 0; tries < 20; tries++) {
    atomically(path, text);
    for (let waited = 0; waited < 200; waited += 10) {
      if (ok()) {
        return;
      }
      await new Promise((r) => setTimeout(r, 10));
    }
  }
  throw new Error(`Timed out applying ${text} to ${path}`);
}

describe('a real watch over a real atomic write', () => {
  it('should still be alive after a second atomic replace', async () => {
    // **the headline.** A rename swaps the inode, so a watch registered on the
    // path is watching a file nothing will ever write to again -- which is why
    // an editor that saves atomically is the known case that breaks `fs.watch`,
    // and ours is one. The *second* replace is what says the watch survived the
    // first: see the platform measurement below for what a file watch does here
    const path = join(root, 'config.json');
    writeFileSync(path, '{"a":1}');
    const config = await createConfig({ layers: [{ name: 'user', store: json(path) }] });

    const seen: ConfigChange[] = [];
    const stop = config.watch('a', (change) => seen.push(change));

    try {
      // the first change is the cold one; the two after it are the claim, and
      // a warm watcher does not lose an event
      await changed(path, '{"a":2}', () => seen.length === 1);

      atomically(path, '{"a":3}');
      await until('the second replace', () => seen.length === 2);

      atomically(path, '{"a":4}');
      await until('the third replace', () => seen.length === 3);

      expect(seen.map((it) => it.value)).to.deep.equal([2, 3, 4]);
      expect(config.get('a')).toBe(4);
    } finally {
      stop();
    }
  });

  it('should publish nothing for our own save, and keep watching after it', async () => {
    // point 6, over the real write path: the value a reload reads back is the
    // one `save()` just wrote, so the diff is empty. The negative is **sequenced
    // rather than slept** -- the external write below happens after the save, so
    // by the time its own publish arrives the save's event has certainly been
    // handled, and the count is what says the save published nothing
    const path = join(root, 'config.json');
    writeFileSync(path, '{"a":1}');
    const config = await createConfig({ layers: [{ name: 'user', store: json(path) }] });

    const seen: ConfigChange[] = [];
    const stop = config.watch((changes) => seen.push(...changes));

    try {
      config.set('a', 2);
      await config.save();
      // the layer already holds what the file now says, so there is nothing
      // for a reload to publish
      expect(config.layers[0]?.dirty).toBe(false);

      await changed(path, '{"a":3}', () => seen.length > 0);

      expect(seen).to.deep.equal([{ path: 'a', previous: 2, value: 3 }]);
    } finally {
      stop();
    }
  });

  it('should see a file that did not exist when the watch started', async () => {
    // the climb and the re-target, over a real tree: neither the file nor its
    // directory is there, which is the ordinary case on a fresh install
    const dir = join(root, 'a', 'b');
    const path = join(dir, 'config.json');
    const config = await createConfig({
      layers: [{ name: 'user', store: json(path) }],
      // a short climb probe, because this is the one test that depends on it:
      // the event that creates `a/b` is the only one that would ever move the
      // watch down, and a watcher created microseconds earlier is exactly the
      // cold one that can lose it -- measured at ~3% under parallel load, where
      // losing it strands the watch for the life of the process
      watch: { interval: 40 },
    });

    const seen: ConfigChange[] = [];
    const stop = config.watch('a', (change) => seen.push(change));

    try {
      expect(config.get('a')).toBeUndefined();
      mkdirSync(dir, { recursive: true });
      writeFileSync(path, '{"a":7}');
      await until('the file to appear', () => seen.length === 1);
      expect(seen).to.deep.equal([{ path: 'a', previous: undefined, value: 7 }]);
    } finally {
      stop();
    }
  });

  it('should see a change under poll, where no event arrives at all', async () => {
    // the answer for a network filesystem or a container bind mount, where
    // inotify does not propagate and `fs.watch` silently never fires. Nothing
    // here can stage such a filesystem, so what this proves is that the poll
    // path works at all -- which is the half that would otherwise ship untried
    const path = join(root, 'config.json');
    writeFileSync(path, '{"a":1}');
    const config = await createConfig({
      layers: [{ name: 'user', store: json(path) }],
      watch: { interval: 20, poll: true },
    });

    const seen: ConfigChange[] = [];
    const stop = config.watch('a', (change) => seen.push(change));

    try {
      await changed(path, '{"a":2}', () => seen.length === 1);
      // and again, because polling is immune to the inode problem for a
      // different reason: each poll is a fresh stat of the path
      atomically(path, '{"a":3}');
      await until('the second replace', () => seen.length === 2);
      expect(seen.map((it) => it.value)).to.deep.equal([2, 3]);
    } finally {
      stop();
    }
  });

  it('should publish nothing for a real change a higher layer shadows', async () => {
    // the one thing a per-file watcher can never tell you, over a real file
    const path = join(root, 'config.json');
    writeFileSync(path, '{"a":1,"b":1}');
    const config = await createConfig({
      layers: [
        { name: 'system', store: json(path) },
        { name: 'user', store: object({ a: 99 }) },
      ],
    });

    const seen: ConfigChange[] = [];
    const stop = config.watch((changes) => seen.push(...changes));

    try {
      // `a` is shadowed and `b` is not, so only `b` is published -- and writing
      // both at once is what makes the negative sequenced rather than slept
      await changed(path, '{"a":2,"b":2}', () => seen.length > 0);
      expect(seen).to.deep.equal([{ path: 'b', previous: 1, value: 2 }]);
      expect(config.get('a')).toBe(99);
    } finally {
      stop();
    }
  });

  it('should stop seeing anything once the last handler goes', async () => {
    const path = join(root, 'config.json');
    writeFileSync(path, '{"a":1}');
    const config = await createConfig({ layers: [{ name: 'user', store: json(path) }] });

    const seen: ConfigChange[] = [];
    const stop = config.watch((changes) => seen.push(...changes));
    await changed(path, '{"a":2}', () => seen.length === 1);

    stop();
    atomically(path, '{"a":3}');
    // sequenced: a fresh watch sees the *next* write, so by the time that
    // arrives the stopped one has certainly had its chance at this one
    const after: ConfigChange[] = [];
    const again = config.watch((changes) => after.push(...changes));
    try {
      await changed(path, '{"a":4}', () => after.length > 0);
      expect(seen).toHaveLength(1);
    } finally {
      again();
    }
  });
});
