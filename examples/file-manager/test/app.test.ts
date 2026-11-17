import { App as JsxApp } from '../src/root.tsx';
import { App as UiApp } from '../src/root.ui.ts';
import { exitMounted, mount, PICTURE, removeTempDirs, tempDir, write } from './fixture.ts';
import { KEYS } from '@ttylabs/sigil/testing';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The manager run by `runApp()` over a test terminal, opened in a directory each
 * test makes for itself -- the real file system, through `FilesContext`, which is
 * what `src/ui.ts` provides with the working directory. Every copy, move, rename
 * and delete here happens inside that directory, and the assertions are on the
 * disk as well as on the screen.
 */

afterAll(removeTempDirs);

// the borders and the list's pointer are drawn from the environment, and a
// Windows runner says ASCII: these say what a terminal that draws box characters
// is, so the screens below are the same on every runner -- the settings
// example's answer to the same thing
beforeEach(() => {
  vi.stubEnv('TERM', 'xterm-256color');
  vi.stubEnv('WT_SESSION', '1');
});
afterEach(() => {
  exitMounted();
  vi.unstubAllEnvs();
});

/**
 * `work/`, the directory the manager opens in: two directories, a dot file, a
 * text file, a picture and some bytes.
 */
function workspace(): { root: string; work: string } {
  const root = tempDir();
  write(root, {
    work: {
      '.cache': { 'state.json': '{}' },
      '.env': 'SECRET=1',
      'a.txt': 'alpha\nbeta\n',
      'data.bin': new Uint8Array([0, 1, 2, 3]),
      docs: { 'guide.md': '# Guide\n\nSome *words* here.\n', 'notes.txt': 'hello' },
      'logo.png': PICTURE,
      src: { 'main.ts': 'export const answer = 42;\n' },
    },
  });
  return { root, work: join(root, 'work') };
}

const LONG = 30_000;

/** Whether the temp directory's file system ignores case, as macOS's and Windows' do by default. */
function ignoresCase(): boolean {
  const dir = tempDir();
  write(dir, { probe: '' });
  return existsSync(join(dir, 'PROBE'));
}

for (const [syntax, App] of [
  ['jsx', JsxApp],
  ['ui', UiApp],
] as const) {
  describe(`the file manager (${syntax})`, () => {
    it(
      'should show the directory above, the one it is in, and a preview of the selection',
      async () => {
        const { root, work } = workspace();
        const m = await mount(App, work);
        const screen = m.screen();

        // the parent column holds `work`, the column beside it the listing --
        // directories first, the dot file left out -- and the preview the first
        // row's own listing
        expect(screen).toContain(basename(root).slice(0, 8));
        expect(screen).toMatch(/❯ docs\/ /);
        expect(screen).toMatch(/src\//);
        expect(screen).toMatch(/a\.txt +11 B/);
        expect(screen).not.toContain('.env');
        expect(screen).toMatch(/docs · 2 items/);
        expect(screen).toMatch(/guide\.md/);
        expect(screen).toContain('1/5');
        m.app.exit(0);
      },
      LONG
    );

    it(
      'should go into a directory with l and back out with h, the cursor where it was',
      async () => {
        const { work } = workspace();
        const m = await mount(App, work);
        await m.press('j', 'l');
        expect(m.screen()).toMatch(/❯ main\.ts/);
        expect(m.screen()).toMatch(/─ src ─/u);
        expect(m.screen()).toMatch(/export const answer = 42;/);

        await m.press('h');
        // back on the directory it came out of, not on the first row
        expect(m.screen()).toMatch(/❯ src\//);
        expect(m.screen()).toContain('2/5');

        // and the arrows and Enter do what h, j and l do
        await m.press(KEYS.up, KEYS.enter);
        expect(m.screen()).toMatch(/❯ guide\.md/);
        await m.press(KEYS.down, KEYS.left, KEYS.right);
        // coming back into a directory puts the cursor where it was left
        expect(m.screen()).toMatch(/❯ notes\.txt/);
        m.app.exit(0);
      },
      LONG
    );

    it(
      'should preview text with line numbers, Markdown rendered, and a binary file as a note',
      async () => {
        const { work } = workspace();
        const m = await mount(App, work);
        await m.press('j', 'j');
        expect(m.screen()).toMatch(/1 alpha/);
        expect(m.screen()).toMatch(/2 beta/);

        await m.press('j');
        expect(m.screen()).toMatch(/A binary file, 4 B/);

        await m.press('k', 'k', 'k', 'l');
        // the heading without its #, the emphasis without its stars
        expect(m.screen()).toMatch(/│ Guide /u);
        expect(m.screen()).toMatch(/Some words here\./);
        expect(m.screen()).not.toMatch(/\*words\*/);
        m.app.exit(0);
      },
      LONG
    );

    it(
      'should draw a picture in half blocks where there is colour to draw it with',
      async () => {
        const { work } = workspace();
        const m = await mount(App, work, { colorLevel: 3 });
        await m.press('G');
        expect(m.screen()).toMatch(/logo\.png · 4x2 PNG/);
        // two pixels a cell down, so a 4x2 picture is a row of four cells
        expect(m.screen()).toMatch(/[▀▄█]{4}/u);
        m.app.exit(0);
      },
      LONG
    );

    it(
      'should show dot files on . and narrow the column to a filter on /',
      async () => {
        const { work } = workspace();
        const m = await mount(App, work);
        await m.press('.');
        expect(m.screen()).toMatch(/\.env/);
        expect(m.screen()).toContain('Hidden files: shown');
        await m.press('.');
        expect(m.screen()).not.toMatch(/\.env/);

        // into a dot directory and then hiding them: the column above still shows
        // the directory the manager is in, since that is where it is
        await m.press('.', 'g', 'l', '.');
        expect(m.screen()).toMatch(/─ \.cache ─/u);
        expect(m.screen()).toMatch(/❯ \.cache\//);
        expect(m.screen()).not.toMatch(/\.env/);
        await m.press('h');

        await m.press('/');
        await m.type('TXT');
        // a capital makes the filter match case, and nothing here is upper case
        expect(m.screen()).toMatch(/Nothing here matches "TXT"/);
        await m.press(KEYS.backspace, KEYS.backspace, KEYS.backspace);
        await m.type('txt');
        expect(m.screen()).toMatch(/❯ a\.txt/);
        expect(m.screen()).not.toMatch(/docs\//);
        expect(m.screen()).toContain('filter "txt"');

        // Enter keeps the filter and gives the list its keys back
        await m.press(KEYS.enter, 'l');
        expect(m.screen()).toContain('1/1');
        // Escape takes it away, and the cursor stays on the row it was on
        await m.press('/');
        await m.escape();
        expect(m.screen()).toMatch(/docs\//);
        expect(m.screen()).toContain('3/5');
        m.app.exit(0);
      },
      LONG
    );

    it(
      'should take a filter typed in the same read as the / that opened it',
      async () => {
        // pasted, or typed fast: the bar is shown and its field focused before
        // the rest of the read is routed, or the letters go to the list
        const { work } = workspace();
        const m = await mount(App, work);
        await m.press('/txt');
        expect(m.screen()).toContain('filter "txt"');
        expect(m.screen()).toMatch(/❯ a\.txt/);
        m.app.exit(0);
      },
      LONG
    );

    it(
      'should forget a filter on leaving the directory it was typed in',
      async () => {
        const { work } = workspace();
        const m = await mount(App, work);
        await m.press('/');
        await m.type('src');
        await m.press(KEYS.enter, 'l', 'h');
        expect(m.screen()).toContain('2/5');
        expect(m.screen()).not.toContain('filter "');
        m.app.exit(0);
      },
      LONG
    );

    it(
      'should copy a file into another directory once the confirm says so',
      async () => {
        const { work } = workspace();
        const m = await mount(App, work);
        await m.press('j', 'j', 'y');
        expect(m.screen()).toContain('Copying a.txt: p pastes it');

        await m.press('k', 'k', 'l', 'p');
        expect(m.screen()).toMatch(/Copy a\.txt into/);
        // Escape answers no: nothing copied
        await m.escape();
        expect(existsSync(join(work, 'docs', 'a.txt'))).toBe(false);

        // the confirm starts on Copy, so Enter copies
        await m.press('p', KEYS.enter);
        expect(readFileSync(join(work, 'docs', 'a.txt'), 'utf8')).toBe('alpha\nbeta\n');
        expect(readFileSync(join(work, 'a.txt'), 'utf8')).toBe('alpha\nbeta\n');
        expect(m.screen()).toMatch(/❯ a\.txt/);
        expect(m.screen()).toMatch(/Copied a\.txt/);

        // pasted again, the name is taken, so the copy is a copy of its own
        await m.press('p', KEYS.enter);
        expect(readdirSync(join(work, 'docs')).sort()).toStrictEqual([
          'a copy.txt',
          'a.txt',
          'guide.md',
          'notes.txt',
        ]);
        m.app.exit(0);
      },
      LONG
    );

    it(
      'should move a directory, and refuse to move it into itself',
      async () => {
        const { work } = workspace();
        const m = await mount(App, work);
        await m.press('x', 'l', 'p');
        // `docs` cut, pasted inside `docs`
        expect(m.screen()).toMatch(/Cannot move docs into itself/);
        expect(existsSync(join(work, 'docs', 'guide.md'))).toBe(true);

        await m.press('h', 'j', 'l', 'p', KEYS.enter);
        expect(existsSync(join(work, 'docs'))).toBe(false);
        expect(readFileSync(join(work, 'src', 'docs', 'guide.md'), 'utf8')).toMatch(/# Guide/);
        expect(m.screen()).toMatch(/❯ docs\//);

        // a move empties what was held, so a second paste has nothing
        await m.press('p');
        expect(m.screen()).toMatch(/Nothing to paste/);
        m.app.exit(0);
      },
      LONG
    );

    it(
      'should not write over a file that appeared while the confirm was open',
      async () => {
        // `rename()` replaces a file on POSIX without a word, so a move asks
        // again whether its name is free once the confirm is answered
        const { work } = workspace();
        const m = await mount(App, work);
        await m.press('j', 'j', 'x', 'g', 'l', 'p');
        expect(m.screen()).toMatch(/Move a\.txt into/);
        write(join(work, 'docs'), { 'a.txt': 'theirs' });
        await m.press(KEYS.enter);
        expect(m.screen()).toMatch(/a\.txt is already taken here/);
        expect(readFileSync(join(work, 'docs', 'a.txt'), 'utf8')).toBe('theirs');
        expect(readFileSync(join(work, 'a.txt'), 'utf8')).toBe('alpha\nbeta\n');
        m.app.exit(0);
      },
      LONG
    );

    it(
      'should rename in a dialog, refuse a name that is taken, and keep everything on Escape',
      async () => {
        const { work } = workspace();
        const m = await mount(App, work);
        await m.press('j', 'j', 'r');
        expect(m.screen()).toMatch(/Rename a\.txt/);
        await m.escape();
        expect(existsSync(join(work, 'a.txt'))).toBe(true);

        await m.press('r');
        // the field starts on the name, so its letters go before anything typed
        for (let i = 0; i < 'a.txt'.length; i++) {
          await m.press(KEYS.backspace);
        }
        await m.type('data.bin');
        await m.press(KEYS.enter);
        expect(m.screen()).toMatch(/data\.bin is already taken/);
        expect(readFileSync(join(work, 'data.bin'))).toHaveLength(4);

        await m.press('r');
        await m.type('-renamed');
        await m.press(KEYS.enter);
        expect(existsSync(join(work, 'a.txt'))).toBe(false);
        expect(readFileSync(join(work, 'a.txt-renamed'), 'utf8')).toBe('alpha\nbeta\n');
        expect(m.screen()).toMatch(/❯ a\.txt-renamed/);
        m.app.exit(0);
      },
      LONG
    );

    it(
      'should delete only once the confirm is answered yes, which it does not start on',
      async () => {
        const { work } = workspace();
        const m = await mount(App, work);
        // the confirm starts on No, so Enter keeps it, and so does Escape
        await m.press('d');
        expect(m.screen()).toMatch(/Delete the directory docs and everything in/);
        await m.press(KEYS.enter);
        expect(existsSync(join(work, 'docs'))).toBe(true);
        await m.press('d');
        await m.escape();
        expect(existsSync(join(work, 'docs'))).toBe(true);

        await m.press('d', KEYS.tab, KEYS.enter);
        expect(existsSync(join(work, 'docs'))).toBe(false);
        // the cursor goes to the row that came after
        expect(m.screen()).toMatch(/❯ src\//);
        expect(m.screen()).toMatch(/Deleted docs/);
        m.app.exit(0);
      },
      LONG
    );

    it.skipIf(process.platform === 'win32')(
      'should draw a control character in a name as a replacement, not drop it',
      async () => {
        // a name somebody else chose can hold an escape. A text element drops it
        // silently, which draws a name that is not the one on disk; Windows does
        // not allow one in a name at all
        const { work } = workspace();
        write(work, { 'bad\u001b[31mname.txt': 'x' });
        const m = await mount(App, work);
        await m.press('j', 'j', 'j');
        expect(m.screen()).toMatch(/❯ bad\uFFFD\[31mname\.txt/u);
        expect(m.screen()).toMatch(/─ bad\uFFFD\[31mname\.txt · 1 B/u);
        m.app.exit(0);
      },
      LONG
    );

    it(
      'should say nothing of a directory read that failed after the manager had moved on',
      async () => {
        // `docs` fails, slowly; `h` is pressed before it does, and the error
        // is about a directory nobody is going to any more
        const { work } = workspace();
        const docs = join(work, 'docs');
        const m = await mount(App, work, {
          wrap: (files) => ({
            ...files,
            list: async (dir) => {
              if (dir === docs) {
                await new Promise((resolve) => setTimeout(resolve, 100));
                throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
              }
              return files.list(dir);
            },
          }),
        });
        await m.term.press('l', 'h');
        await m.settle();
        await new Promise((resolve) => setTimeout(resolve, 150));
        await m.settle();
        expect(m.screen()).not.toMatch(/permission denied/);
        m.app.exit(0);
      },
      LONG
    );

    it.skipIf(!ignoresCase())(
      'should take a start spelled in another case as the directory spells it',
      async () => {
        const { work } = workspace();
        const m = await mount(App, join(work, 'A.TXT'));
        expect(m.screen()).toMatch(/❯ a\.txt/);
        m.app.exit(0);
        const n = await mount(App, join(work, 'DOCS'));
        expect(n.screen()).toMatch(/❯ docs\//);
        expect(n.screen()).toMatch(/─ docs ─/u);
        n.app.exit(0);
      },
      LONG
    );

    it(
      'should open beside a file named as where to start, with the file selected',
      async () => {
        const { work } = workspace();
        const m = await mount(App, join(work, 'logo.png'));
        expect(m.screen()).toMatch(/❯ logo\.png/);
        expect(m.screen()).toContain('5/5');
        m.app.exit(0);
      },
      LONG
    );

    it(
      "should hand a file's l to its preview, and say a directory it cannot open is not there",
      async () => {
        const { work } = workspace();
        const m = await mount(App, work);
        await m.press('j', 'j', 'l');
        // a file has no inside, so l hands the focus to its preview, and h there
        // hands it back rather than going up a directory
        expect(m.screen()).toMatch(/h back/);
        await m.press('h');
        expect(m.screen()).toMatch(/❯ a\.txt/);
        expect(m.screen()).toContain('3/5');
        m.app.exit(0);

        const lost = await mount(App, join(work, 'missing'));
        expect(lost.screen()).toMatch(/It is not there any/);
        expect(lost.screen()).toMatch(/│ It is not there any more +│/u);
        lost.app.exit(0);
      },
      LONG
    );
  });
}
