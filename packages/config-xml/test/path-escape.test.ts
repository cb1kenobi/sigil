import { xml } from '../src/index.js';
import { tempDir } from './temp.js';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * An xml file's path is quoted by every message that names it, and it is the app's
 * root as it is on disk (SIG-551). The path is escaped where the store builds its
 * messages -- through the same `escapeControls()` core's JSON store uses, from
 * `@ttylabs/sigil/error-handler` -- so a root holding a retitle sequence reaches
 * no terminal raw. A control character in a directory name cannot be created on
 * Windows, so these are POSIX-only.
 */

/** A window retitle, and a newline that would start a line the program never wrote. */
const HOSTILE = '\u001b]0;T\u0007\nforged: error';

/** What `escapeControls()` makes of it, inside a message. */
const ESCAPED = '\\x1B]0;T\\x07\\x0Aforged: error';

/** A file with these bytes under a directory with the hostile name in it. */
function dirty(bytes: Uint8Array | string): string {
  const dir = join(tempDir('sigil-xml-'), `root-${HOSTILE}`);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, 'config.xml');
  writeFileSync(path, bytes);
  return path;
}

/** Asserts a message names the path escaped and holds nothing a terminal acts on. */
function expectInert(message: string): void {
  expect(message).toContain(ESCAPED);
  expect(message).not.toMatch(/\p{Cc}/u);
}

/** The message of whatever `work` throws, or rejects with. */
async function said(work: () => unknown): Promise<string> {
  try {
    await work();
  } catch (error) {
    return (error as Error).message;
  }

  throw new Error('expected it to refuse');
}

describe.skipIf(process.platform === 'win32')(
  'an xml file under a directory with a control character in its name',
  () => {
    it('should be escaped when it does not parse', async () => {
      const store = xml(dirty('<config><a></config>'));

      expectInert(await said(() => store.read()));
      expectInert(await said(() => store.readSync()));
    });

    it('should be escaped when it is not UTF-8', async () => {
      const store = xml(dirty(Buffer.from([0x3c, 0x61, 0x3e, 0xe9, 0x3c, 0x2f, 0x61, 0x3e])));

      expectInert(await said(() => store.read()));
      expectInert(await said(() => store.readSync()));
    });

    it('should be escaped when it declares an encoding that is not UTF-8', async () => {
      const store = xml(dirty('<?xml version="1.0" encoding="ISO-8859-1"?><config/>'));

      expectInert(await said(() => store.readSync()));
    });

    it('should be escaped when it cannot be read', async () => {
      const path = dirty('');
      const store = xml(join(path, '..', 'nested'));
      mkdirSync(join(path, '..', 'nested'));

      expectInert(await said(() => store.read()));
      expectInert(await said(() => store.readSync()));
    });

    it('should be escaped when an element in it is refused, which names the line', async () => {
      const store = xml(dirty('<config>text<b/></config>'));

      expectInert(await said(() => store.readSync()));
    });

    it('should be escaped when a value cannot be written', async () => {
      const message = await said(() =>
        xml(dirty('<config><a>1</a></config>')).write({ a: () => 1 })
      );

      expect(message).toMatch(/^Cannot write /);
      expectInert(message);
    });

    it('should be escaped when the document is not an object', async () => {
      const message = await said(() => xml(dirty('<config/>')).write('x'));

      expectInert(message);
    });
  }
);
