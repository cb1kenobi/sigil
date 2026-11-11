import { age, clockTime, createCluster, EPOCH } from '../src/cluster.ts';
import { describe, expect, it } from 'vitest';

describe('createCluster()', () => {
  it('should be the same cluster for the same seed, line for line', () => {
    const a = createCluster({ seed: 7 });
    const b = createCluster({ seed: 7 });
    expect(a.backlog(200)).toStrictEqual(b.backlog(200));
    expect(a.advance(5000)).toStrictEqual(b.advance(5000));
    expect(a.pods()).toStrictEqual(b.pods());
    expect(createCluster({ seed: 8 }).backlog(50)).not.toStrictEqual(
      createCluster({ seed: 7 }).backlog(50)
    );
  });

  it('should start at the epoch, and move only when it is advanced', () => {
    const cluster = createCluster();
    expect(cluster.now()).toBe(EPOCH);
    cluster.advance(250);
    expect(cluster.now()).toBe(EPOCH + 250);
  });

  it('should write the backlog before now, and new lines after it, in order', () => {
    const cluster = createCluster();
    const history = cluster.backlog(1000);
    const times = (lines: { text: string }[]) => lines.map((l) => l.text.slice(0, 12));
    expect(times(history)).toStrictEqual([...times(history)].sort());
    expect((history.at(-1)?.text ?? '').slice(0, 12) <= clockTime(EPOCH)).toBe(true);
    const fresh = cluster.advance(2000);
    expect(fresh.length).toBeGreaterThan(5);
    expect(fresh.every((l) => l.text.slice(0, 12) >= clockTime(EPOCH))).toBe(true);
    // one counter, so every line's id is its own and they rise
    const ids = [...history, ...fresh].map((l) => l.id);
    expect(ids).toStrictEqual([...ids].sort((x, y) => x - y));
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('should take a new reading of the pods once a second, and not between', () => {
    const cluster = createCluster();
    const before = cluster.pods();
    cluster.advance(500);
    expect(cluster.pods()).toBe(before);
    cluster.advance(500);
    expect(cluster.pods()).not.toBe(before);
  });

  it("should say a pod's lines are its own", () => {
    const cluster = createCluster();
    const names = new Set(cluster.pods().map((p) => p.name));
    for (const l of cluster.backlog(300)) {
      expect(names.has(l.source)).toBe(true);
      expect(l.text).toContain(` ${l.source} `);
      expect(l.text).toContain(l.level.toUpperCase());
    }
  });

  it('should describe a resource, and say so for one that has gone', () => {
    const cluster = createCluster();
    const pod = cluster.pods()[0];
    expect(cluster.describe('pods', pod?.name ?? '')).toMatch(/^Name: +\S+\nNamespace: +default/);
    expect(cluster.describe('services', 'api')).toMatch(/Endpoints: +10\.42\./);
    expect(cluster.describe('deployments', 'worker')).toMatch(/Replicas: +4 desired/);
    expect(cluster.describe('pods', 'nope')).toBe('pod nope is gone');
  });
});

describe('age()', () => {
  it('should read as kubectl prints it', () => {
    expect(age(42_000)).toBe('42s');
    expect(age(17 * 60_000)).toBe('17m');
    expect(age(5 * 3_600_000)).toBe('5h');
    expect(age(3 * 86_400_000)).toBe('3d');
    expect(age(-5)).toBe('0s');
  });
});
