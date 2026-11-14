import { xml } from '../src/index.js';
import { tempDir } from './temp.js';
import { createConfig, createConfigSync } from '@ttylabs/sigil/config';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/** Bytes in a file of their own, answered with its path. */
function file(bytes: Uint8Array | string): string {
  const path = join(tempDir('sigil-xml-'), 'config.xml');
  writeFileSync(path, bytes);
  return path;
}

/** The ticket's file: Latin-1 bytes under a declaration that says so. */
const LATIN1 = Buffer.concat([
  Buffer.from('<?xml version="1.0" encoding="ISO-8859-1"?>\n<config><a>caf'),
  Buffer.from([0xe9]),
  Buffer.from('</a></config>'),
]);

describe('a file that is not UTF-8', () => {
  it('should not read a Latin-1 byte as U+FFFD, or write the corruption back', async () => {
    const path = file(LATIN1);
    const refusal =
      /^Failed to read .*config\.xml: it is not UTF-8, the first invalid byte is at offset 58$/;

    expect(() => xml(path).readSync()).toThrow(refusal);
    await expect(xml(path).read()).rejects.toThrow(refusal);
    expect(() => createConfigSync({ layers: [{ name: 'user', store: xml(path) }] })).toThrow(
      refusal
    );
    expect(() => xml(path).writeSync({ b: '2' }, { paths: ['b'] })).toThrow(refusal);
    await expect(xml(path).write({ b: '2' }, { paths: ['b'] })).rejects.toThrow(refusal);

    expect(readFileSync(path)).toStrictEqual(LATIN1);
  });

  it.each([
    ['little-endian', Buffer.from('\uFEFF<config><a>1</a></config>', 'utf16le')],
    ['big-endian', Buffer.from('\uFEFF<config><a>1</a></config>', 'utf16le').swap16()],
  ])('should refuse UTF-16 %s with a BOM as UTF-16, not as a parse error', (_, utf16) => {
    const path = file(utf16);
    expect(() => xml(path).readSync()).toThrow(
      /: it is not UTF-8, it starts with a UTF-16 byte order mark$/
    );
    expect(() => xml(path).writeSync({ b: '2' }, { paths: ['b'] })).toThrow(/is not UTF-8/);
    expect(readFileSync(path)).toStrictEqual(utf16);
  });

  it('should still read a UTF-8 BOM, and keep it on a save', async () => {
    const path = file('\uFEFF<config><a>caf\u00e9</a></config>\n');
    const config = await createConfig({ layers: [{ name: 'user', store: xml(path) }] });
    expect(config.get('a')).toBe('caf\u00e9');

    config.set('b', '2');
    await config.save();

    expect(readFileSync(path, 'utf8')).toBe('\uFEFF<config><a>caf\u00e9</a><b>2</b></config>\n');
  });
});

describe('a declared encoding', () => {
  it('should refuse one that is not UTF-8 even over bytes that are', () => {
    // ASCII means the same thing in both, so the read could have succeeded --
    // and the write after it would then put UTF-8 under a declaration that
    // says ISO-8859-1, which every other XML reader trusts
    const text = '<?xml version="1.0" encoding="ISO-8859-1"?>\n<config><a>1</a></config>\n';
    const path = file(text);
    const refusal =
      /^Failed to read .*config\.xml: it declares the encoding "ISO-8859-1", and only UTF-8 is read$/;

    expect(() => xml(path).readSync()).toThrow(refusal);
    expect(() => xml(path).writeSync({ b: 'caf\u00e9' }, { paths: ['b'] })).toThrow(refusal);
    expect(readFileSync(path, 'utf8')).toBe(text);
  });

  it.each([`encoding="UTF-8"`, `encoding='utf-8'`, `encoding = "Utf-8"`, `standalone="yes"`])(
    'should read a declaration of %s',
    (decl) => {
      const path = file(`<?xml version="1.0" ${decl}?>\n<config><a>caf\u00e9</a></config>\n`);
      expect(xml(path).readSync().value).toStrictEqual({ a: 'caf\u00e9' });
    }
  );
});
