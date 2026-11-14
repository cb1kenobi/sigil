import {
  createConfig,
  createConfigSync,
  json,
  readText,
  readTextSync,
  type WatchSource,
} from '../../src/config/index.js';
import { invalidUtf8At } from '../../src/config/stores/text.js';
import { seeded } from '../../src/util/random.js';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'sigil-utf8-'));
});

afterEach(() => {
  vi.useRealTimers();
  rmSync(root, { force: true, recursive: true });
});

/** Writes bytes under the scratch root and answers with the path. */
function file(name: string, bytes: Uint8Array | string): string {
  const path = join(root, name);
  writeFileSync(path, bytes);
  return path;
}

/** Text and raw bytes, in order, as one buffer. */
function bytes(...parts: (string | number[])[]): Buffer {
  return Buffer.concat(
    parts.map((part) => (typeof part === 'string' ? Buffer.from(part) : Buffer.from(part)))
  );
}

/** The ticket's file: a comment holding a Latin-1 `e` with an acute accent. */
const LATIN1 = bytes('{\n  // caf', [0xe9], ' owner\n  "a": 1\n}\n');

describe('a config file that is not UTF-8', () => {
  it('should not rewrite a Latin-1 byte as U+FFFD when an unrelated key is saved', () => {
    const path = file('config.jsonc', LATIN1);

    expect(() => {
      const config = createConfigSync({ layers: [{ name: 'user', store: json(path) }] });
      config.set('b', 2);
      config.saveSync();
    }).toThrow(/is not UTF-8/);

    expect(readFileSync(path)).toStrictEqual(LATIN1);
  });

  it('should refuse it on every path a store reads through', async () => {
    const path = file('config.jsonc', LATIN1);
    const store = json(path);
    const refusal = /^Failed to read .*config\.jsonc: it is not UTF-8/;

    expect(() => store.readSync()).toThrow(refusal);
    await expect(store.read()).rejects.toThrow(refusal);
    expect(() => readTextSync(path)).toThrow(refusal);
    await expect(readText(path)).rejects.toThrow(refusal);
    await expect(createConfig({ layers: [{ name: 'user', store: json(path) }] })).rejects.toThrow(
      refusal
    );

    // and a write reached directly, which reads the file itself and is the
    // read the splice would have been made against
    expect(() => store.writeSync({ b: 2 }, { paths: ['b'] })).toThrow(refusal);
    await expect(store.write({ b: 2 }, { paths: ['b'] })).rejects.toThrow(refusal);
    expect(() => store.writeSync({ b: 2 })).toThrow(refusal);
    expect(readFileSync(path)).toStrictEqual(LATIN1);
  });

  it('should name the offset of the first byte that is not UTF-8', () => {
    // `{\n  // caf` is ten bytes, so the `e9` is the eleventh
    const path = file('config.jsonc', LATIN1);
    expect(() => json(path).readSync()).toThrow(/the first invalid byte is at offset 10$/);
  });

  it.each([
    // the mark and then the text, as `Out-File` writes them
    ['little-endian', Buffer.from('\uFEFF{"a": 1}', 'utf16le')],
    ['big-endian', Buffer.from('\uFEFF{"a": 1}', 'utf16le').swap16()],
  ])('should refuse UTF-16 %s with a BOM as UTF-16, not as a parse error', (_, utf16) => {
    const path = file('config.json', utf16);
    const before = readFileSync(path);

    expect(() => json(path).readSync()).toThrow(
      /: it is not UTF-8, it starts with a UTF-16 byte order mark$/
    );
    expect(() => json(path).writeSync({ b: 2 }, { paths: ['b'] })).toThrow(/is not UTF-8/);
    expect(readFileSync(path)).toStrictEqual(before);
  });

  it('should still read a UTF-8 BOM, and keep it on a save', () => {
    const path = file('config.json', bytes([0xef, 0xbb, 0xbf], '{\n  "a": "café"\n}\n'));
    const config = createConfigSync({ layers: [{ name: 'user', store: json(path) }] });
    expect(config.get('a')).toBe('café');

    config.set('b', 2);
    config.saveSync();

    const after = readFileSync(path);
    expect([...after.subarray(0, 3)]).toStrictEqual([0xef, 0xbb, 0xbf]);
    expect(after.subarray(3).toString()).toBe('{\n  "a": "café",\n  "b": 2\n}\n');
  });

  it('should keep the last good value when a watched file stops being UTF-8', () => {
    // which is the reload's existing rule for a file that will not parse,
    // reached through the same reader: the refusal is reported and nothing
    // the app reads moves
    vi.useFakeTimers();
    const path = file('config.json', '{"a": 1}');
    let fire = (): void => {};
    const source: WatchSource = (_path, onEvent) => {
      fire = onEvent;
      return () => {};
    };
    const errors: unknown[] = [];
    const config = createConfigSync({
      layers: [{ name: 'user', store: json(path) }],
      watch: { onError: (e) => errors.push(e), source },
    });
    config.watch(() => {});

    writeFileSync(path, bytes('{"a": "caf', [0xe9], '"}'));
    fire();
    vi.advanceTimersByTime(1000);

    expect(config.get('a')).toBe(1);
    expect(errors.map((e) => (e as Error).message)).toStrictEqual([
      expect.stringMatching(/is not UTF-8, the first invalid byte is at offset 10$/),
    ]);
  });
});

describe('invalidUtf8At()', () => {
  /** What the WHATWG decoder says, which this has to agree with. */
  const valid = (input: Uint8Array): boolean => {
    try {
      new TextDecoder('utf-8', { fatal: true }).decode(input);
      return true;
    } catch {
      return false;
    }
  };

  it('should find nothing in valid UTF-8', () => {
    expect(invalidUtf8At(Buffer.from('aé€\u{1f600}﻿'))).toBe(-1);
  });

  it.each([
    ['a lone continuation byte', [0x61, 0x80], 1],
    ['an overlong two-byte form', [0x61, 0xc0, 0xaf], 1],
    ['an overlong three-byte form', [0xe0, 0x80, 0xaf], 0],
    ['a surrogate', [0x61, 0x62, 0xed, 0xa0, 0x80], 2],
    ['a code point past U+10FFFF', [0xf4, 0x90, 0x80, 0x80], 0],
    ['a sequence cut short by the end', [0x61, 0xe2, 0x82], 1],
    ['a byte that never appears', [0x61, 0xff], 1],
  ])('should point at %s', (_, input, at) => {
    expect(invalidUtf8At(Uint8Array.from(input))).toBe(at);
  });

  it('should agree with the decoder about every two-byte input', () => {
    const disagree: string[] = [];
    for (let a = 0; a < 256; a++) {
      for (let b = 0; b < 256; b++) {
        const input = Uint8Array.of(a, b);
        if ((invalidUtf8At(input) === -1) !== valid(input)) {
          disagree.push(Buffer.from(input).toString('hex'));
        }
      }
    }
    expect(disagree).toStrictEqual([]);
  });

  it('should agree with the decoder, and name a valid prefix, over random input', () => {
    // biased towards the bytes where the table has edges, or a uniform byte is
    // almost always invalid at once and the long sequences are never reached
    const edges = [0x00, 0x41, 0x7f, 0x80, 0x8f, 0x90, 0x9f, 0xa0, 0xbf, 0xc0, 0xc1, 0xc2, 0xdf];
    const leads = [0xe0, 0xe1, 0xec, 0xed, 0xee, 0xef, 0xf0, 0xf1, 0xf3, 0xf4, 0xf5, 0xff];
    const pool = [...edges, ...leads];
    const random = seeded(413);

    for (let n = 0; n < 20_000; n++) {
      const input = Uint8Array.from({ length: 1 + Math.floor(random() * 8) }, () =>
        random() < 0.5
          ? (pool[Math.floor(random() * pool.length)] as number)
          : 0x80 + Math.floor(random() * 64)
      );
      const at = invalidUtf8At(input);
      expect(at === -1, Buffer.from(input).toString('hex')).toBe(valid(input));
      if (at !== -1) {
        expect(valid(input.subarray(0, at)), Buffer.from(input).toString('hex')).toBe(true);
      }
    }
  });
});
