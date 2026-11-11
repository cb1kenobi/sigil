/**
 * Every config mutator used to re-merge and deep-freeze the whole stack (SIG-377).
 *
 * The merged view is lazy now: a mutator marks it stale and the next read
 * rebuilds it. What these pin is the count -- through `mergeLayers()`, wrapped
 * so the real merge still runs and the one thing added is a tally -- and
 * everything that must not have moved with it: where a refusal is thrown, which
 * object `get()` hands back, and what a watcher is told.
 *
 * Only the first two fail over the eager merge; every other test here passes
 * over both, which is what says the laziness moved nothing observable. A
 * reload from disk over writes nobody read is `should overwrite an unsaved
 * set, and say so` in `watch.test.ts`, which also passes over both.
 *
 * A file of its own rather than a `describe` inside `config.test.ts`, because
 * `vi.mock` is hoisted and module-wide -- `atomic-temp.test.ts` has the same
 * reason at more length.
 */

import {
  createConfig,
  createConfigSync,
  json,
  object,
  type ConfigChange,
  type ConfigDocument,
  type WritableConfigStore,
} from '../../src/config/index.js';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let merges = 0;

vi.mock('../../src/config/merge.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/config/merge.js')>();

  return {
    ...real,
    mergeLayers(...args: Parameters<typeof real.mergeLayers>): unknown {
      merges++;
      return real.mergeLayers(...args);
    },
  };
});

beforeEach(() => {
  merges = 0;
});

/** A stack shaped like the measurement: defaults, a base layer, an empty user layer. */
function stack() {
  return createConfigSync({
    schema: { 'server.port': { default: 80, type: 'int' } },
    layers: [
      {
        name: 'base',
        store: object({ k1: { a: 1, b: [1, 2, 3], c: { d: 1 } }, items: [1, 2, 3] }),
      },
      { name: 'user', store: object({}) },
    ],
  });
}

describe('a lazy merged view', () => {
  it('should merge once for a run of set() calls followed by one get()', () => {
    const config = stack();
    expect(merges).toBe(1);

    for (let i = 0; i < 50; i++) {
      // dotted, into a layer that holds nothing there, under a default and a
      // lower layer that do -- the case whose list check used to read the
      // built view, and so would have forced a merge per call on its own
      config.set('server.port', 1000 + i);
      config.set(`k1.c.d`, i);
      config.set(`fresh.n${i}.x`, i);
    }
    expect(merges).toBe(1);

    expect(config.get('server.port')).toBe(1049);
    expect(config.get('k1.c.d')).toBe(49);
    expect(merges).toBe(2);

    // and reading again rebuilds nothing
    expect(config.get('fresh.n7.x')).toBe(7);
    expect(config.has('k1.a')).toBe(true);
    config.get();
    expect(merges).toBe(2);
  });

  it('should merge nothing for any mutator until something reads', () => {
    const config = stack();
    config.push('list', 1);
    config.unshift('list', 0);
    config.pop('list');
    config.shift('list');
    config.delete('k1.a', 'base');
    config.set('gone', null);
    config.saveSync();
    expect(merges).toBe(1);

    expect(config.get('list')).to.deep.equal([]);
    expect(config.get('k1.a')).toBeUndefined();
    expect(merges).toBe(2);
  });

  it('should hand back the same frozen object between writes, and a new one after', () => {
    const config = stack();
    const first = config.get();
    const k1 = config.get('k1');
    expect(config.get()).toBe(first);
    expect(config.get('k1')).toBe(k1);
    expect(Object.isFrozen(first)).toBe(true);

    config.set('k1.c.d', 2);
    // a reference held across the write keeps what it held: it is frozen, and
    // nothing rebuilt it in place
    expect((k1 as { c: { d: number } }).c.d).toBe(1);
    const second = config.get();
    expect(second).not.toBe(first);
    expect(config.get('k1.c.d')).toBe(2);
    expect(Object.isFrozen(second)).toBe(true);
    expect(config.get()).toBe(second);
  });

  it('should leave get() on the same object after a write that changed nothing', () => {
    // a refusal is rolled back and a `null` over nothing is no write at all, so
    // neither has anything for the view to show -- the identity an app memoizing
    // on `get()` relies on, which the eager merge also kept
    const config = stack();
    const before = config.get();

    expect(() => config.set('server.port', 'nope')).toThrow(/Invalid integer/);
    config.set('nothing.here', undefined);
    expect(config.get()).toBe(before);
  });

  it('should still throw every refusal at the mutating call rather than at a later get()', async () => {
    // nothing a mutator refuses is decided by the merge, which is what makes it
    // safe to defer: each of these throws at the call, with writes still
    // pending in a stale view, and the `get()` afterwards answers rather than
    // throwing a refusal somebody else made
    const store: WritableConfigStore = {
      canRepresent: (value: unknown): true | string =>
        typeof value === 'bigint' ? 'no bigints here' : true,
      format: 'picky',
      read: (): Promise<ConfigDocument> => Promise.resolve({ value: {} }),
      readSync: (): ConfigDocument => ({ value: {} }),
      write: (): Promise<void> => Promise.resolve(),
      writeSync: (): void => {},
    };
    const config = await createConfig({
      schema: { 'server.port': { type: 'int' } },
      layers: [
        { name: 'system', readOnly: true, store: object({ locked: 1, items: [1, 2, 3] }) },
        { name: 'base', store: object({ off: 'off' }) },
        { name: 'user', store },
      ],
    });
    config.set('pending', 1);

    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;

    const refusals: [() => unknown, RegExp][] = [
      [() => config.set('server.port', 'nope'), /Invalid integer/],
      [() => config.set('evil', JSON.parse('{"__proto__":{"x":1}}')), /Unsafe config key/],
      [() => config.set('loop', cycle), /refers back to itself/],
      [() => config.set('items.0', 9), /"items" is a list/],
      [() => config.set('off.port', 1, 'base'), /"off" in base is not an object/],
      [() => config.set('x', 1, 'system'), /read-only/],
      [() => config.set('big', 10n), /no bigints here/],
      [() => config.push('list', undefined), /Cannot push nothing/],
      [() => config.push('pending', 1), /"pending" in user is not a list/],
      [() => config.delete('locked'), /Cannot delete "locked"/],
      [() => config.set('', 1), /Cannot set without a path/],
      [() => config.set('a', 1, 'nope'), /Unknown config layer/],
    ];

    for (const [call, refusal] of refusals) {
      expect(call).toThrow(refusal);
    }

    expect(() => config.get()).not.toThrow();
    expect(config.get('pending')).toBe(1);
    expect(config.get('server.port')).toBeUndefined();
    expect(config.get('items')).to.deep.equal([1, 2, 3]);
    expect(config.has('evil')).toBe(false);
  });

  it('should refuse a dotted set into a list another unread set put in the merged view', () => {
    // the list check reads the stack rather than the built view, so a write
    // made a moment ago and never read has to count -- here the list is the
    // base layer's, from a `set()` the view has not been rebuilt since
    const config = stack();
    config.set('later', [1, 2], 'base');
    expect(() => config.set('later.0', 9)).toThrow(/"later" is a list/);

    // and a list a higher layer replaced with a scalar is no list any more, so a
    // nested write shadows the scalar, exactly as it would over the built view
    config.set('items', 'off', 'base');
    config.set('items.x', 1);
    expect(config.get('items')).to.deep.equal({ x: 1 });
    expect(config.get('later')).to.deep.equal([1, 2]);
  });

  it('should diff an apply() against writes nobody read since', () => {
    const config = createConfigSync({ layers: [{ name: 'app', store: object({ a: 1 }) }] });
    const seen: ConfigChange[][] = [];
    config.watch((changes) => seen.push([...changes]));

    config.set('a', 5);
    config.set('b', 6);
    config.apply('app', { a: 1 });

    expect(seen).to.deep.equal([
      [
        { path: 'a', previous: 5, value: 1 },
        { path: 'b', previous: 6, value: undefined },
      ],
    ]);
  });

  it('should hand a handler the objects get() answered before the change and answers after it', () => {
    const config = createConfigSync({
      layers: [{ name: 'app', store: object({ server: { port: 1 } }) }],
    });
    const held = config.get('server');
    const seen: { change: ConfigChange; now: unknown }[] = [];
    config.watch('server', (change) => seen.push({ change, now: config.get('server') }));
    // a second handler that writes, which marks the view stale for everyone
    // after it and must not change what any of them was already handed
    config.watch(() => config.set('server.port', 99));

    config.apply('app', { server: { port: 2 } });

    expect(seen).toHaveLength(1);
    expect(seen[0]?.change.previous).toBe(held);
    expect(seen[0]?.change.value).toBe(seen[0]?.now);
    expect(seen[0]?.change.value).to.deep.equal({ port: 2 });
    expect(config.get('server.port')).toBe(99);
  });
});

describe('a lazy merged view over a file', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'sigil-lazy-merge-'));
  });

  afterEach(() => {
    rmSync(root, { force: true, recursive: true });
  });

  it('should save the three-way merge of unread writes and what another process wrote', async () => {
    const file = join(root, 'config.json');
    writeFileSync(file, JSON.stringify({ a: 1, b: 1 }));
    const config = await createConfig({ layers: [{ name: 'user', store: json(file) }] });

    config.set('a', 2);
    config.set('c.d', 3);
    // another process writes a key this one never touched
    writeFileSync(file, JSON.stringify({ a: 1, b: 7 }));
    expect(await config.save()).to.deep.equal(['user']);

    expect(JSON.parse(readFileSync(file, 'utf8'))).to.deep.equal({ a: 2, b: 7, c: { d: 3 } });
    // and the view is what was held after the save, rebuilt on the read
    expect(config.get()).to.deep.equal({ a: 2, b: 7, c: { d: 3 } });
    expect(config.layers[0]?.dirty).toBe(false);
  });
});
