import { yaml } from '../src/index.js';
import { tempDir } from './temp.js';
import { createConfig, createConfigSync } from '@ttylabs/sigil/config';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/** Bytes in a file of their own, answered with its path. */
function file(bytes: Uint8Array | string): string {
  const path = join(tempDir('sigil-yaml-'), 'config.yaml');
  writeFileSync(path, bytes);
  return path;
}

/** A comment holding a Latin-1 `e` with an acute accent. */
const LATIN1 = Buffer.concat([
  Buffer.from('# caf'),
  Buffer.from([0xe9]),
  Buffer.from(' owner\na: 1\n'),
]);

describe('a file that is not UTF-8', () => {
  it('should not rewrite a Latin-1 byte as U+FFFD when an unrelated key is saved', async () => {
    const path = file(LATIN1);
    const refusal =
      /^Failed to read .*config\.yaml: it is not UTF-8, the first invalid byte is at offset 5$/;

    expect(() => yaml(path).readSync()).toThrow(refusal);
    await expect(yaml(path).read()).rejects.toThrow(refusal);
    expect(() => createConfigSync({ layers: [{ name: 'user', store: yaml(path) }] })).toThrow(
      refusal
    );
    expect(() => yaml(path).writeSync({ b: 2 }, { paths: ['b'] })).toThrow(refusal);
    await expect(yaml(path).write({ b: 2 }, { paths: ['b'] })).rejects.toThrow(refusal);

    expect(readFileSync(path)).toStrictEqual(LATIN1);
  });

  it.each([
    ['little-endian', Buffer.from('﻿a: 1\n', 'utf16le')],
    ['big-endian', Buffer.from('﻿a: 1\n', 'utf16le').swap16()],
  ])('should refuse UTF-16 %s with a BOM as UTF-16, not as a parse error', (_, utf16) => {
    const path = file(utf16);
    expect(() => yaml(path).readSync()).toThrow(
      /: it is not UTF-8, it starts with a UTF-16 byte order mark$/
    );
    expect(() => yaml(path).writeSync({ b: 2 }, { paths: ['b'] })).toThrow(/is not UTF-8/);
    expect(readFileSync(path)).toStrictEqual(utf16);
  });

  it('should still read a UTF-8 BOM, and keep it on a save', async () => {
    const path = file('﻿# café\na: 1\n');
    const config = await createConfig({ layers: [{ name: 'user', store: yaml(path) }] });
    expect(config.get('a')).toBe(1);

    config.set('b', 2);
    await config.save();

    expect(readFileSync(path, 'utf8')).toBe('﻿# café\na: 1\nb: 2\n');
  });
});
