import { createFiles, type Entry, type Files } from '../src/files.ts';
import { codeRows } from '../src/preview-pane.ts';
import { MAX_TEXT_BYTES, MAX_TEXT_LINES, type Preview, readPreview } from '../src/preview.ts';
import { PICTURE, removeTempDirs, tempDir, write } from './fixture.ts';
import type { Element } from '@ttylabs/sigil/element';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

/** What the preview column is handed for each kind of thing, read off a directory of the test's own. */

afterAll(removeTempDirs);

const files = createFiles();

/** The entry the manager would hand over for a name in `dir`. */
async function entryOf(dir: string, name: string): Promise<Entry> {
  const found = (await files.list(dir)).find((it) => it.name === name);
  if (!found) {
    throw new Error(`${name} is not in ${dir}`);
  }
  return found;
}

async function previewOf(dir: string, name: string, hidden = false): Promise<Preview> {
  return (await readPreview(files, await entryOf(dir, name), { hidden })).preview;
}

describe('a preview', () => {
  it("should list a directory with the column's hidden rule, and count what it left out", async () => {
    const root = tempDir();
    write(root, { dir: { '.env': 'x', b: {}, 'a.txt': 'a' } });
    const read = await readPreview(files, await entryOf(root, 'dir'), { hidden: false });
    expect(read.about).toBe('2 items, 1 hidden');
    expect(read.preview).toMatchObject({ kind: 'directory', total: 2 });
    const names = (read.preview as { entries: readonly Entry[] }).entries.map((it) => it.name);
    expect(names).toStrictEqual(['b', 'a.txt']);
    expect(await previewOf(root, 'dir', true)).toMatchObject({ total: 3 });
  });

  it('should read text with its extension as the language, and Markdown as Markdown', async () => {
    const root = tempDir();
    write(root, { 'main.ts': 'const a = 1;\n', 'README.md': '# Title\n' });
    expect(await previewOf(root, 'main.ts')).toStrictEqual({
      cut: false,
      kind: 'text',
      lang: 'ts',
      text: 'const a = 1;',
    });
    expect(await previewOf(root, 'README.md')).toMatchObject({ kind: 'markdown', text: '# Title' });
  });

  it('should take a NUL as binary and an empty file as empty, and draw neither', async () => {
    const root = tempDir();
    write(root, { 'data.bin': new Uint8Array([104, 105, 0, 1]), empty: '' });
    expect(await previewOf(root, 'data.bin')).toMatchObject({
      kind: 'note',
      note: expect.stringMatching(/binary/),
    });
    expect(await previewOf(root, 'empty')).toMatchObject({ kind: 'note', note: 'An empty file' });
  });

  it('should decode a PNG, and say so when it cannot', async () => {
    const root = tempDir();
    write(root, { 'logo.png': PICTURE, 'broken.png': 'not a picture' });
    const read = await readPreview(files, await entryOf(root, 'logo.png'), { hidden: false });
    expect(read.about).toMatch(/^4x2 PNG/);
    expect(read.preview).toMatchObject({ image: { height: 2, width: 4 }, kind: 'image' });
    expect(await previewOf(root, 'broken.png')).toMatchObject({
      kind: 'note',
      note: expect.stringMatching(/Not a PNG this can read/),
      role: 'error',
    });
  });

  it("should make every control character safe to draw and drop a CRLF's carriage return", async () => {
    const root = tempDir();
    write(root, { 'a.txt': 'one\r\ntwo \u001b[31mred\u0007\r\n\tthree\n' });
    expect(await previewOf(root, 'a.txt')).toMatchObject({
      text: 'one\ntwo �[31mred�\n\tthree',
    });
  });

  it('should read only the top of a long file, and say it was cut', async () => {
    const root = tempDir();
    const lines = Array.from({ length: MAX_TEXT_LINES + 50 }, (_, i) => `line ${i + 1}`);
    write(root, { 'long.txt': `${lines.join('\n')}\n` });
    const read = (await previewOf(root, 'long.txt')) as { cut: boolean; text: string };
    expect(read.cut).toBe(true);
    expect(read.text.split('\n')).toHaveLength(MAX_TEXT_LINES);

    // and a file larger than what is read is cut back to its last whole line, so
    // a character the read stopped inside is never drawn as half of one
    const wide = 'é'.repeat(MAX_TEXT_BYTES);
    write(root, { 'wide.txt': `${wide}\n${wide}\n` });
    const cut = (await previewOf(root, 'wide.txt')) as { cut: boolean; text: string };
    expect(cut.cut).toBe(true);
    expect(cut.text).not.toContain('�');
  });

  it("should not leave a CRLF's carriage return behind where the preview is cut", async () => {
    const root = tempDir();
    write(root, { 'crlf.txt': 'hello\r\n'.repeat(MAX_TEXT_LINES + 1) });
    const read = (await previewOf(root, 'crlf.txt')) as { cut: boolean; text: string };
    expect(read.cut).toBe(true);
    expect(read.text).not.toContain('\uFFFD');
    expect(read.text.split('\n').at(-1)).toBe('hello');
  });

  it('should not draw half a character where the read stopped inside one', async () => {
    // three bytes a character, so 64 KB ends a byte into one, and no newline
    // for the cut to fall back to
    const root = tempDir();
    write(root, { 'wide.txt': '\u4f60'.repeat(30_000) });
    const read = (await previewOf(root, 'wide.txt')) as { cut: boolean; text: string };
    expect(read.cut).toBe(true);
    expect(read.text).not.toContain('\uFFFD');
    expect(read.text).toHaveLength(Math.floor(MAX_TEXT_BYTES / 3));
  });

  it.skipIf(process.platform === 'win32')(
    'should list a FIFO as neither a file nor a directory, and preview it without opening it',
    async () => {
      // a read of a FIFO nobody writes to never returns, so this test would
      // hang rather than fail if the preview opened it. No FIFO on Windows
      const root = tempDir();
      execFileSync('mkfifo', [join(root, 'pipe')]);
      const fifo = await entryOf(root, 'pipe');
      expect(fifo.kind).toBe('other');
      expect((await readPreview(files, fifo, { hidden: false })).preview).toMatchObject({
        kind: 'note',
        note: expect.stringMatching(/Not a regular file/),
      });
    }
  );

  it('should never open what is not a regular file, which might be a FIFO nobody writes to', async () => {
    const opened: string[] = [];
    const watching: Files = {
      ...files,
      read: (path, limit) => {
        opened.push(path);
        return files.read(path, limit);
      },
    };
    const root = tempDir();
    const fifo: Entry = {
      kind: 'other',
      link: false,
      name: 'pipe',
      path: join(root, 'pipe'),
      size: 0,
    };
    const read = await readPreview(watching, fifo, { hidden: false });
    expect(read.preview).toMatchObject({
      kind: 'note',
      note: expect.stringMatching(/Not a regular file/),
    });
    expect(opened).toStrictEqual([]);
  });

  it('should say why a directory cannot be read rather than throw', async () => {
    const root = tempDir();
    const gone: Entry = {
      kind: 'directory',
      link: false,
      name: 'gone',
      path: join(root, 'gone'),
      size: 0,
    };
    expect((await readPreview(files, gone, { hidden: false })).preview).toStrictEqual({
      kind: 'note',
      note: 'It is not there any more',
      role: 'error',
    });
  });
});

describe('the text of a preview', () => {
  /** Every run of a row, as its classes and its text. */
  const runs = (row: Element): { classes: string; text: string }[] =>
    row.children.slice(1).map((run) => ({ classes: run.classes.join(' '), text: run.text ?? '' }));

  it('should draw each token in its role, behind a gutter of line numbers', () => {
    const [row] = codeRows('const a = 1;', 'ts', 40);
    expect(row?.children[0]?.text).toBe('1');
    const keyword = runs(row as Element).find((run) => run.text === 'const');
    expect(keyword?.classes).toContain('sigil-token-keyword');
    expect(keyword?.classes).toContain('sigil-accent');
    expect(runs(row as Element).find((run) => run.text.includes('1'))?.classes).toContain(
      'sigil-token-number'
    );
  });

  it('should leave out the gutter in a pane too narrow for it and some text', () => {
    const rows = codeRows(Array.from({ length: 1000 }, () => 'x').join('\n'), undefined, 4);
    const row = rows[0] as Element;
    expect(row.children.map((child) => child.text)).toStrictEqual(['x']);
  });

  it('should leave a language it does not know plain', () => {
    const [row] = codeRows('const a = 1;', 'cobol', 40);
    expect(runs(row as Element)).toStrictEqual([{ classes: 'code', text: 'const a = 1;' }]);
  });

  it('should expand a tab to the next stop and cut a line at the width', () => {
    const [row] = codeRows('\tab\tcdefghij', undefined, 12);
    // a gutter of one and a space leave ten cells
    expect(
      runs(row as Element)
        .map((run) => run.text)
        .join('')
    ).toBe('    ab  cd');
  });
});
