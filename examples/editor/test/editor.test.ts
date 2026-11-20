import { createDoc, diskText, shownPath, tabLabels } from '../src/documents.ts';
import { LIVE_LIMIT, MAX_PREVIEW } from '../src/preview.ts';
import { App, stylesheet } from '../src/root.tsx';
import { createWorkspace, type Workspace, WorkspaceContext } from '../src/workspace.ts';
import { type App as RunningApp, runApp } from '@ttylabs/sigil/app';
import type { Element } from '@ttylabs/sigil/element';
import { ESCAPE_TIMEOUT } from '@ttylabs/sigil/input';
import { provideContext } from '@ttylabs/sigil/renderer';
import { createTestTerminal, ctrl, frame, KEYS, type TestTerminal } from '@ttylabs/sigil/testing';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, sep } from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The editor run by `runApp()` over a test terminal, against a directory each
 * test makes for itself under the temp directory -- the real file system, through
 * `WorkspaceContext`, wrapped to count the writes. Every assertion about a save
 * reads the file back off the disk rather than trusting the screen.
 *
 * The directories are removed by this file rather than by a `tempDir()` of the
 * example's own, which is the git client's arrangement: one test file that makes
 * directories, and an `afterAll` that says what the helper would.
 */

/** Every directory this file made, removed when it is done. */
const made: string[] = [];
afterAll(() => {
  // `maxRetries` for Windows, where a file only just closed can answer EBUSY for
  // a moment; a directory that still cannot go fails the file
  for (const dir of made.splice(0)) {
    rmSync(dir, { force: true, maxRetries: 5, recursive: true });
  }
});

/** A directory the test owns, holding `files`, written byte for byte. */
function workspace(files: Record<string, string | Uint8Array>): string {
  const dir = mkdtempSync(join(tmpdir(), 'sigil-editor-'));
  made.push(dir);
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  return dir;
}

/** What a mounted editor is driven with. */
interface Mounted {
  readonly app: RunningApp;
  /**
   * Presses keys, one read each, and paints the frame after the last. A lone
   * Escape is held by the router for `ESCAPE_TIMEOUT`, in case it is the start of
   * an Alt chord, so it is waited out rather than run into the next key.
   */
  press(...keys: string[]): Promise<void>;
  /** Reads a file of the directory back off the disk. */
  read(path: string): string;
  /** The screen, a row a line. */
  screen(): string;
  readonly term: TestTerminal;
  /** Paints frames until the screen shows `what`: a directory read is asynchronous. */
  until(what: RegExp | string): Promise<void>;
  /** The paths written, in order. */
  readonly writes: string[];
}

const COLUMNS = 120;
const ROWS = 30;

const ESC = '\u001b';
/** Ctrl-PageDown and Ctrl-PageUp, which `KEYS` does not spell. */
const CTRL_PAGE_DOWN = `${ESC}[6;5~`;
const CTRL_PAGE_UP = `${ESC}[5;5~`;
/** Shift-Right, and Ctrl-End: the end of the value. */
const SHIFT_RIGHT = `${ESC}[1;2C`;
const CTRL_END = `${ESC}[1;5F`;

/** The one mounted now, which `afterEach` quits if the test did not. */
let running: Mounted | undefined;

/**
 * Mounts the editor over a directory, and waits for the tree to have read it.
 *
 * @param dir - The directory.
 * @param opts - The colour level, which is 0 unless a test reads colours.
 * @returns The handle.
 */
async function mount(dir: string, opts: { colorLevel?: 0 | 1 } = {}): Promise<Mounted> {
  const real = createWorkspace(dir);
  const writes: string[] = [];
  const ws: Workspace = {
    read: (path) => real.read(path),
    root: real.root,
    write: (path, text) => {
      writes.push(path);
      real.write(path, text);
    },
  };
  const term = createTestTerminal({ colorLevel: opts.colorLevel, columns: COLUMNS, rows: ROWS });
  const app = runApp(() => provideContext(WorkspaceContext, ws, App), {
    detect: false,
    sheets: [stylesheet],
    terminal: term.terminal,
  });
  await frame(app);
  const screen = (): string => term.viewport.join('\n');
  const mounted: Mounted = {
    app,
    async press(...keys) {
      for (const key of keys) {
        await term.press(key);
        if (key === KEYS.escape) {
          await new Promise((resolve) => setTimeout(resolve, ESCAPE_TIMEOUT + 30));
        }
      }
      await frame(app);
    },
    read: (path) => readFileSync(join(dir, path), 'utf8'),
    screen,
    term,
    async until(what) {
      const deadline = Date.now() + 5000;
      for (;;) {
        await frame(app);
        const now = screen();
        if (typeof what === 'string' ? now.includes(what) : what.test(now)) {
          return;
        }
        if (Date.now() > deadline) {
          throw new Error(`The screen never showed ${String(what)}:\n${now}`);
        }
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
    },
    writes,
  };
  running = mounted;
  // the tree reads the directory once it is drawn, which is a promise away
  await mounted.until(/[├└]/u);
  return mounted;
}

/** The row of the tree the cursor is on. */
function cursorRow(it: Mounted): string {
  return it.term.viewport.find((line) => line.includes('❯')) ?? '';
}

/**
 * Opens a file at the top level of the directory: Home to the root, Down to its
 * row, and Enter.
 */
async function open(it: Mounted, name: string): Promise<void> {
  await it.press(KEYS.escape, KEYS.home);
  for (let i = 0; i < 20; i++) {
    await it.press(KEYS.down);
    if (cursorRow(it).includes(` ${name} `)) {
      await it.press(KEYS.enter);
      await it.until(`─ ${name}`);
      return;
    }
  }
  throw new Error(`${name} is not in the tree:\n${it.screen()}`);
}

/** The source panel, as the screen shows it: the rows between the tree and the preview. */
function sourceText(it: Mounted): string {
  return it.term.viewport.map((line) => line.split(/││|╮╭|╯╰/u)[1] ?? '').join('\n');
}

/**
 * The preview, as the screen shows it: the rows of the right-hand panel, which is
 * what is past the second pair of borders that meet on a row.
 */
function previewText(it: Mounted): string {
  return it.term.viewport.map((line) => line.split(/││|╮╭|╯╰/u)[2] ?? '').join('\n');
}

beforeEach(() => {
  // the borders, the dirty mark and the tree's guides come from
  // `unicodeSupported()`, and a Windows runner says ASCII
  vi.stubEnv('TERM', 'xterm-256color');
  vi.stubEnv('WT_SESSION', '1');
});

afterEach(async () => {
  if (running) {
    running.app.exit(0);
    await running.app.exited;
    running = undefined;
  }
  vi.unstubAllEnvs();
});

describe('the editor', () => {
  it('should list the directory, and say how to open a file while none is open', async () => {
    const it = await mount(workspace({ 'README.md': '# Hi\n', 'src/a.ts': 'a\n' }));
    // a directory is listed with the platform's separator after it
    expect(it.screen()).toContain(`▸ src${sep}`);
    expect(it.screen()).toContain('README.md');
    expect(it.screen()).toContain('Pick a file in the tree and press Enter to open it.');
    expect(it.screen()).not.toContain('─ Preview');
  });

  it('should hide the preview for a file that is not Markdown, and bring it back', async () => {
    const it = await mount(workspace({ 'README.md': '# Title\n', 'a.txt': 'a\n' }));
    await open(it, 'README.md');
    await open(it, 'a.txt');
    expect(it.screen()).not.toContain('─ Preview');
    await it.press(CTRL_PAGE_UP);
    expect(it.screen()).toContain('─ Preview');
    expect(previewText(it)).toContain('Title');
  });

  it('should open a file in a tab with line numbers, the caret at the top', async () => {
    const lines = Array.from({ length: 80 }, (_, i) => `line ${i + 1}`);
    const it = await mount(workspace({ 'notes.txt': lines.join('\n') }));
    await open(it, 'notes.txt');
    // the first line is on screen and not the last: a text area starts at the end
    // of what it is given, and the editor moves it to the top
    expect(it.screen()).toMatch(/ 1 line 1 /u);
    expect(it.screen()).not.toContain('line 80');
    await it.press('>');
    expect(it.screen()).toMatch(/ 1 >line 1 /u);
    // a file that is not Markdown has no preview
    expect(it.screen()).not.toContain('─ Preview');
  });

  it("should show the caret's line and column, for the tab showing", async () => {
    const it = await mount(workspace({ 'a.txt': 'one\ntwo\nthree\n', 'b.txt': 'b\n' }));
    expect(it.screen()).not.toMatch(/Ln \d/u);
    await open(it, 'a.txt');
    expect(it.screen()).toContain('Ln 1, Col 1');
    await it.press(KEYS.down, KEYS.down, KEYS.right, KEYS.right);
    expect(it.screen()).toContain('Ln 3, Col 3');
    await it.press(KEYS.enter);
    expect(it.screen()).toContain('Ln 4, Col 1');
    // each tab keeps its own
    await open(it, 'b.txt');
    expect(it.screen()).toContain('Ln 1, Col 1');
    await it.press(CTRL_PAGE_UP);
    expect(it.screen()).toContain('Ln 4, Col 1');
  });

  it('should preview Markdown beside the source, and follow the typing', async () => {
    const it = await mount(workspace({ 'README.md': '# Title\n\nSome *words*.\n' }));
    await open(it, 'README.md');
    expect(it.screen()).toContain('─ Preview');
    expect(previewText(it)).toContain('Title');
    // the emphasis is drawn, not its asterisks
    expect(previewText(it)).toContain('Some words.');

    await it.press(ctrl('e'), KEYS.enter, KEYS.enter, '#', '#', ' ', 'M', 'o', 'r', 'e');
    expect(previewText(it)).toContain('More');
    expect(previewText(it)).not.toContain('##');
  });

  it('should mark a changed file on its tab, and save it with Ctrl-S', async () => {
    const it = await mount(workspace({ 'a.txt': 'alpha\n' }));
    await open(it, 'a.txt');
    expect(it.screen()).not.toContain('a.txt ●');

    await it.press('x');
    expect(it.screen()).toContain('a.txt ●');
    expect(it.read('a.txt')).toBe('alpha\n');

    await it.press(ctrl('s'));
    expect(it.read('a.txt')).toBe('xalpha\n');
    expect(it.screen()).not.toContain('a.txt ●');
    expect(it.screen()).toContain('Saved a.txt');

    // typing it back the way it was is not a change
    await it.press('y', KEYS.backspace);
    expect(it.screen()).not.toContain('a.txt ●');
    expect(it.writes).toHaveLength(1);
  });

  it('should write a file back with the line endings it was read with', async () => {
    const it = await mount(
      workspace({ 'dos.txt': 'one\r\ntwo\r\n', 'mac.txt': 'one\rtwo\nthree' })
    );
    await open(it, 'dos.txt');
    await it.press(KEYS.end, '!', ctrl('s'));
    expect(it.read('dos.txt')).toBe('one!\r\ntwo\r\n');
    await open(it, 'mac.txt');
    await it.press(KEYS.end, '!', ctrl('s'));
    // the first break decides, and a later one of another kind follows it
    expect(it.read('mac.txt')).toBe('one!\rtwo\rthree');
  });

  it('should not write a file that has not changed, so its mixed line endings stay', async () => {
    const it = await mount(workspace({ 'mixed.txt': 'one\ntwo\r\nthree\n' }));
    await open(it, 'mixed.txt');
    await it.press(ctrl('s'));
    expect(it.writes).toStrictEqual([]);
    expect(it.read('mixed.txt')).toBe('one\ntwo\r\nthree\n');
    expect(it.screen()).toContain('No changes to save in mixed.txt');
    // edited, it is written with the first ending it had
    await it.press('!', ctrl('s'));
    expect(it.read('mixed.txt')).toBe('!one\ntwo\nthree\n');
  });

  it('should close a clean tab without asking', async () => {
    const it = await mount(workspace({ 'a.txt': 'a\n', 'b.txt': 'b\n' }));
    await open(it, 'a.txt');
    await open(it, 'b.txt');
    expect(sourceText(it)).toMatch(/ a\.txt +b\.txt /u);
    await it.press(ctrl('w'));
    expect(sourceText(it)).not.toContain('b.txt');
    // the one left takes its place and has the focus: what is typed goes there
    await it.press('!');
    expect(it.screen()).toContain('a.txt ●');
    expect(it.writes).toStrictEqual([]);
  });

  it('should show the tab to the right of one closed, or the one to its left for the last', async () => {
    const files = { 'a.txt': 'a\n', 'b.txt': 'b\n', 'c.txt': 'c\n', 'd.txt': 'd\n' };
    const it = await mount(workspace(files));
    for (const name of Object.keys(files)) {
      await open(it, name);
    }
    // closing b shows c, the one that was to its right -- not the first, nor the last
    await it.press(CTRL_PAGE_UP, CTRL_PAGE_UP, ctrl('w'), '1');
    expect(sourceText(it)).toMatch(/ a\.txt +c\.txt ● +d\.txt /u);
    // closing d, the last, shows c, the one to its left
    await it.press(ctrl('s'), CTRL_PAGE_DOWN, ctrl('w'), '2');
    expect(sourceText(it)).toMatch(/ a\.txt +c\.txt ● /u);
  });

  describe('closing an unsaved file', () => {
    it('should keep it open on Cancel, and on Escape', async () => {
      const it = await mount(workspace({ 'a.txt': 'a\n' }));
      await open(it, 'a.txt');
      await it.press('!', ctrl('w'));
      expect(it.screen()).toContain('Save the changes to a.txt?');
      await it.press(KEYS.escape);
      expect(it.screen()).not.toContain('Save the changes');
      expect(it.screen()).toContain('a.txt ●');

      await it.press(ctrl('w'), KEYS.tab, KEYS.tab, KEYS.enter);
      expect(it.screen()).not.toContain('Save the changes');
      expect(it.screen()).toContain('a.txt ●');
      // the focus went back to the area
      await it.press('?');
      expect(it.screen()).toMatch(/ 1 !\?a /u);
      expect(it.read('a.txt')).toBe('a\n');
    });

    it("should close it unsaved on Don't save", async () => {
      const it = await mount(workspace({ 'a.txt': 'a\n' }));
      await open(it, 'a.txt');
      await it.press('!', ctrl('w'), KEYS.tab, KEYS.enter);
      expect(it.screen()).toContain('Pick a file in the tree');
      expect(it.screen()).toContain('Closed a.txt without saving');
      expect(it.read('a.txt')).toBe('a\n');
      expect(it.writes).toStrictEqual([]);
    });

    it('should save it and then close it on Save, which is where the dialog starts', async () => {
      const it = await mount(workspace({ 'a.txt': 'a\n' }));
      await open(it, 'a.txt');
      await it.press('!', ctrl('w'), KEYS.enter);
      expect(it.screen()).toContain('Pick a file in the tree');
      expect(it.read('a.txt')).toBe('!a\n');
    });
  });

  describe('quitting', () => {
    it('should quit on q with nothing unsaved, and type it in the text area', async () => {
      const it = await mount(workspace({ 'a.txt': 'a\n' }));
      await open(it, 'a.txt');
      await it.press('q', ctrl('s'));
      expect(it.read('a.txt')).toBe('qa\n');
      await it.press(KEYS.escape, 'q');
      expect(await it.app.exited).toBe(0);
      running = undefined;
    });

    it('should ask before quitting over unsaved changes, starting on Cancel', async () => {
      const it = await mount(workspace({ 'a.txt': 'a\n' }));
      await open(it, 'a.txt');
      await it.press('!', KEYS.escape, 'q');
      expect(it.screen()).toContain('Quit without saving?');
      expect(it.screen()).toContain('a.txt has unsaved changes');
      // Enter on where it starts is Cancel: losing work takes a deliberate key
      await it.press(KEYS.enter);
      expect(it.screen()).not.toContain('Quit without saving?');
      expect(it.app.running).toBe(true);

      await it.press('q', KEYS.tab, KEYS.enter);
      expect(await it.app.exited).toBe(0);
      expect(it.read('a.txt')).toBe('a\n');
      running = undefined;
    });
  });

  describe('the command palette', () => {
    /** The palette row the cursor is on: the last pointer on screen, below the tree's. */
    const paletteRow = (it: Mounted): string =>
      it.term.viewport.filter((line) => line.includes('❯')).at(-1) ?? '';

    it('should rank the commands as it is typed and run the one picked', async () => {
      const it = await mount(workspace({ 'a.txt': 'a\n', 'b.txt': 'b\n' }));
      await open(it, 'a.txt');
      await open(it, 'b.txt');
      await it.press('1', ctrl('p'));
      expect(it.screen()).toContain('Command palette');
      expect(it.screen()).toContain('Save all');

      await it.press('s', 'v', 'a', 'l');
      // `Save all` is the best match for `sval`, and the cursor goes to the best
      expect(paletteRow(it)).toContain('Save all');
      await it.press(KEYS.enter);
      expect(it.screen()).not.toContain('Command palette');
      expect(it.read('b.txt')).toBe('1b\n');
      expect(it.screen()).toContain('Saved 1 file');
    });

    it('should move the cursor with the arrows while the field keeps the typing', async () => {
      const it = await mount(workspace({ 'a.txt': 'a\n' }));
      await open(it, 'a.txt');
      await it.press(ctrl('p'), 't', 'a', 'b');
      const first = paletteRow(it);
      await it.press(KEYS.down);
      expect(paletteRow(it)).not.toBe(first);
      await it.press(KEYS.up);
      expect(paletteRow(it)).toBe(first);
      // and the typing still goes to the field
      await it.press('x');
      expect(it.screen()).toContain('No command matches');
    });

    it('should run nothing on Escape', async () => {
      const it = await mount(workspace({ 'a.txt': 'a\n' }));
      await open(it, 'a.txt');
      await it.press('!', ctrl('p'), 's', 'a', 'v', 'e', KEYS.escape);
      expect(it.screen()).not.toContain('Command palette');
      expect(it.writes).toStrictEqual([]);
      // and the focus is back in the area, which the palette's typing never reached
      await it.press('?');
      expect(it.screen()).toMatch(/ 1 !\?a /u);
    });

    it('should run the best match when Enter comes before the next frame', async () => {
      // the typing and the Enter in one burst, with no frame between them: the
      // cursor has to be on the best match by the time the Enter is read, not by
      // the time the next frame has run the effects
      const it = await mount(workspace({ 'a.txt': 'a\n' }));
      await it.press(ctrl('p'), ...'reload', KEYS.enter);
      expect(it.screen()).toContain('Read every folder in the file tree again');
    });

    it('should reload the whole tree, so a file added in an open subfolder appears', async () => {
      // short names, which the narrow tree draws whole three levels down
      const dir = workspace({ 'src/lib/x.ts': 'd\n', 'src/main.ts': 'm\n', 'top.txt': 't\n' });
      const it = await mount(dir);
      // open src, and src/lib under it, in the tree, each read before the next
      for (const [name, then] of [
        ['src', `lib${sep}`],
        ['lib', 'x.ts'],
      ]) {
        for (let i = 0; i < 20 && !cursorRow(it).includes(` ${name}${sep}`); i++) {
          await it.press(KEYS.down);
        }
        await it.press(KEYS.enter);
        await it.until(then);
      }
      writeFileSync(join(dir, 'src', 'z.ts'), 'a\n');
      writeFileSync(join(dir, 'src', 'lib', 'y.ts'), 'n\n');
      await it.press(KEYS.up);
      expect(it.screen()).not.toContain('z.ts');

      await it.press(ctrl('p'), ...'reload');
      expect(it.screen()).toContain('Reload the whole file tree');
      await it.press(KEYS.enter);
      await it.until('y.ts');
      expect(it.screen()).toContain('z.ts');
      // still open, both of them: nothing was closed and opened again to show it
      expect(it.screen()).toContain(`▾ src${sep}`);
      expect(it.screen()).toContain(`▾ lib${sep}`);
    });

    it('should run the best match when the typing and the Enter are one read', async () => {
      // a paste, or keys faster than the terminal hands them over: the router
      // decodes the whole read and routes every key in it before any frame
      const it = await mount(workspace({ 'a.txt': 'a\n' }));
      await it.press(ctrl('p'), `reload${KEYS.enter}`);
      expect(it.screen()).toContain('Read every folder in the file tree again');
    });

    it('should put the cursor on the best match where the row it was on still matches', async () => {
      // `Save` is where the cursor starts and `e` still matches it, as the second
      // row: a list that kept its cursor on its row would leave it there, and Enter
      // would save rather than run `Focus editor`, the best match
      const it = await mount(workspace({ 'a.txt': 'a\n' }));
      await open(it, 'a.txt');
      await it.press(ctrl('p'), 'e');
      expect(paletteRow(it)).toContain('Focus editor');
      await it.press(KEYS.enter);
      expect(it.screen()).not.toContain('Command palette');
      expect(it.screen()).not.toContain('No changes to save');
    });

    it('should move over the ranking the typing made when an arrow is in the same read', async () => {
      // `go` ranks `Go to first.txt` first and `Go to second.txt` next, so Down and
      // Enter switch to `second.txt` -- where a Down over the rows the palette
      // opened with goes from `Save` to `Save all`, which leaves `first.txt` active
      const it = await mount(workspace({ 'first.txt': 'f\n', 'second.txt': 's\n' }));
      await open(it, 'second.txt');
      await open(it, 'first.txt');
      await it.press(ctrl('p'), `go${KEYS.down}${KEYS.enter}`, '!');
      expect(it.screen()).toContain('second.txt ●');
      expect(it.screen()).not.toContain('first.txt ●');
    });

    it('should switch to an open tab by name', async () => {
      const it = await mount(workspace({ 'first.txt': 'f\n', 'second.txt': 's\n' }));
      await open(it, 'first.txt');
      await open(it, 'second.txt');
      await it.press(ctrl('p'), ...'go first', KEYS.enter, '!');
      expect(it.screen()).toContain('first.txt ●');
      expect(it.screen()).not.toContain('second.txt ●');
    });

    it('should close a tab and quit, which ask with dialogs of their own', async () => {
      const it = await mount(workspace({ 'a.txt': 'a\n', 'b.txt': 'b\n' }));
      await open(it, 'a.txt');
      await open(it, 'b.txt');
      await it.press(ctrl('p'), ...'close tab', KEYS.enter);
      expect(sourceText(it)).not.toContain('b.txt');
      await it.press('!', ctrl('p'), ...'quit', KEYS.enter);
      expect(it.screen()).toContain('Quit without saving?');
      await it.press(KEYS.tab, KEYS.enter);
      expect(await it.app.exited).toBe(0);
      running = undefined;
    });

    it('should hide the preview and show it again', async () => {
      const it = await mount(workspace({ 'README.md': '# Title\n' }));
      await open(it, 'README.md');
      expect(it.screen()).toContain('─ Preview');
      await it.press(ctrl('p'), ...'preview', KEYS.enter);
      expect(it.screen()).not.toContain('─ Preview');
      await it.press(ctrl('p'), ...'preview', KEYS.enter);
      expect(it.screen()).toContain('─ Preview');
    });
  });

  it('should keep one row of tabs, through opening, a mark and closing', async () => {
    const it = await mount(workspace({ 'a.txt': 'a\n', 'b.txt': 'b\n' }));
    /** Every tab row in the tree, which is one element for the life of the editor. */
    const rows = (): Element[] => {
      const found: Element[] = [];
      const walk = (element: Element): void => {
        if (element.classes.includes('sigil-tabs-row')) {
          found.push(element);
        }
        element.children.forEach(walk);
      };
      walk(it.app.view.root);
      return found;
    };
    const [row] = rows();
    expect(rows()).toHaveLength(1);
    // with nothing open it is there and draws nothing, and Tab passes it by
    expect(row?.focusable).toBe(false);
    await open(it, 'a.txt');
    await open(it, 'b.txt');
    await it.press('!');
    expect(sourceText(it)).toMatch(/ a\.txt +b\.txt ● /u);
    await it.press(ctrl('s'), ctrl('w'));
    expect(sourceText(it)).not.toContain('b.txt');
    expect(rows()).toStrictEqual([row]);
    expect(row?.focusable).toBe(true);
    // focused while a mark goes, it keeps the focus: there is no new row to lose it to
    await it.press('?', KEYS.escape, KEYS.tab);
    expect(sourceText(it)).toMatch(/ a\.txt ● /u);
    expect(it.app.input?.focus.current.get()).toBe(row);
    await it.press(ctrl('s'));
    expect(sourceText(it)).not.toContain('●');
    expect(it.app.input?.focus.current.get()).toBe(row);
    expect(rows()).toStrictEqual([row]);
  });

  it('should step through the tabs with Ctrl-PageDown and Ctrl-PageUp, wrapping', async () => {
    const it = await mount(workspace({ 'a.txt': 'a\n', 'b.txt': 'b\n', 'c.txt': 'c\n' }));
    await open(it, 'a.txt');
    await open(it, 'b.txt');
    await open(it, 'c.txt');
    await it.press(CTRL_PAGE_DOWN, '1');
    expect(it.screen()).toContain('a.txt ●');
    await it.press(CTRL_PAGE_UP, '2');
    expect(it.screen()).toContain('c.txt ●');
  });

  it('should show a file already open rather than opening it twice', async () => {
    const it = await mount(workspace({ 'a.txt': 'a\n', 'b.txt': 'b\n' }));
    await open(it, 'a.txt');
    await it.press('!');
    await open(it, 'b.txt');
    await open(it, 'a.txt');
    expect(it.screen()).toMatch(/ a\.txt ● +b\.txt /u);
    expect(it.screen()).not.toMatch(/b\.txt +a\.txt/u);
    expect(it.screen()).toMatch(/ 1 !a /u);
  });

  it('should refuse a binary file, and say so', async () => {
    const it = await mount(workspace({ 'blob.bin': 'a\u0000b' }));
    await it.press(KEYS.down, KEYS.enter);
    await it.until('Cannot open');
    expect(it.screen()).toContain('Pick a file in the tree');
  });

  it('should refuse a file that is not UTF-8, rather than save U+FFFD over it', async () => {
    // `café` in Latin-1: a lenient read is `caf\uFFFD`, and a save of that writes
    // EF BF BD where the E9 was
    const latin1 = new Uint8Array([0x63, 0x61, 0x66, 0xe9, 0x0a]);
    const dir = workspace({ 'latin1.txt': latin1 });
    const it = await mount(dir);
    await it.press(KEYS.down, KEYS.enter);
    await it.until('Cannot open');
    expect(it.screen()).toContain('Pick a file in the tree');
    expect(it.writes).toStrictEqual([]);
    expect(readFileSync(join(dir, 'latin1.txt'))).toEqual(Buffer.from(latin1));
    expect(() => createWorkspace(dir).read(join(dir, 'latin1.txt'))).toThrow(/is not UTF-8$/);
  });

  it('should write a byte order mark back with the file it was read with', async () => {
    const dir = workspace({ 'bom.txt': '\uFEFFone\n' });
    const it = await mount(dir);
    await open(it, 'bom.txt');
    await it.press(KEYS.end, '!', ctrl('s'));
    expect([...readFileSync(join(dir, 'bom.txt'))]).toEqual([
      0xef,
      0xbb,
      0xbf,
      ...Buffer.from('one!\n'),
    ]);
  });

  describe('the text area', () => {
    it('should copy a selection to the clipboard, and cut one', async () => {
      const it = await mount(workspace({ 'a.txt': 'hello world\n' }));
      await open(it, 'a.txt');
      await it.press(SHIFT_RIGHT, SHIFT_RIGHT, SHIFT_RIGHT, SHIFT_RIGHT, SHIFT_RIGHT);
      await it.press(ctrl('y'));
      // OSC 52 with the text in base64: what a terminal puts on its clipboard
      expect(it.term.output).toContain(`]52;c;${Buffer.from('hello').toString('base64')}`);
      expect(it.screen()).toContain('Copied 5 characters');
      expect(it.screen()).not.toContain('a.txt ●');

      await it.press(ctrl('x'));
      expect(it.screen()).toMatch(/ 1 {2}world /u);
      expect(it.screen()).toContain('a.txt ●');
    });

    it('should take a paste of several lines whole', async () => {
      const it = await mount(workspace({ 'a.txt': 'end\n' }));
      await open(it, 'a.txt');
      // a tab in a paste is content, where a typed Tab indents with two spaces --
      // which is what tells a paste taken whole from one typed in as keys
      await it.term.paste('one\ttab\ntwo\nthree\n');
      await it.press(ctrl('s'));
      expect(it.read('a.txt')).toBe('one\ttab\ntwo\nthree\nend\n');
    });

    it('should indent with Tab, and leave for the tree with Escape', async () => {
      const it = await mount(workspace({ 'a.txt': 'a\n' }));
      await open(it, 'a.txt');
      await it.press(KEYS.tab);
      expect(it.screen()).toMatch(/ 1 {3}a /u);
      // Escape is the tree's: Home there moves the tree's cursor to its root
      await it.press(KEYS.escape, KEYS.home);
      expect(cursorRow(it)).toContain('sigil-editor-');
      expect(it.screen()).toMatch(/ 1 {3}a /u);
    });

    it('should highlight a language the lexer reads, and leave plain text plain', async () => {
      // the keyword on the second line, because a file opens with the caret on the
      // first cell, which draws that cell apart from the rest of its token
      const source = '\nconst answer = 42;\n';
      const it = await mount(workspace({ 'a.ts': source, 'b.txt': source }), { colorLevel: 1 });
      // a keyword draws in the accent, which is cyan at level 1, and nothing else
      // on these screens is the word `const`
      const keyword = new RegExp(`${ESC}\\[(?:\\d+;)*36m(?:${ESC}\\[[\\d;]*m)*const`, 'u');
      await open(it, 'b.txt');
      expect(it.term.output).not.toMatch(keyword);
      await open(it, 'a.ts');
      expect(it.term.output).toMatch(keyword);
    });

    it('should edit the end of a 50,000-line file and save all of it', async () => {
      const lines = Array.from({ length: 50_000 }, (_, i) => `export const n${i} = ${i};`);
      const it = await mount(workspace({ 'big.ts': `${lines.join('\n')}\n` }));
      await open(it, 'big.ts');
      expect(it.screen()).toContain('export const n0 = 0;');

      await it.press(CTRL_END);
      expect(it.screen()).toMatch(/50001 /u);
      await it.press(KEYS.up, KEYS.home, '/', '/', ' ');
      expect(it.screen()).toContain('// export const n49999 = 49999;');
      await it.press(ctrl('s'));
      const saved = it.read('big.ts').split('\n');
      expect(saved).toHaveLength(50_001);
      expect(saved[49_999]).toBe('// export const n49999 = 49999;');
      expect(saved[0]).toBe('export const n0 = 0;');
    });

    it('should wait for a pause before drawing the preview of a long document again', async () => {
      const sentence = 'A sentence that fills the document. ';
      const long = `# Long\n\n${sentence.repeat(Math.ceil(LIVE_LIMIT / sentence.length))}\n`;
      const it = await mount(workspace({ 'long.md': long }));
      await open(it, 'long.md');
      expect(previewText(it)).toContain('Long');

      // a key does not draw it again at once, and a pause does
      await it.press(KEYS.right, KEYS.right, KEYS.right, 'X');
      expect(previewText(it)).not.toContain('LXong');
      await vi.waitFor(() => expect(previewText(it)).toContain('LXong'), { timeout: 3000 });

      // a preview put away and shown again is a new drawing, and does not wait
      await it.press(ctrl('p'), ...'preview', KEYS.enter);
      expect(it.screen()).not.toContain('─ Preview');
      await it.press(ctrl('p'), ...'preview', KEYS.enter);
      expect(previewText(it)).toContain('LXong');
    });
  });
});

describe('a document past the preview limit', () => {
  it('should say it is too long to preview, and still open', async () => {
    const line = 'A line of a very long document.\n';
    const huge = `# Huge\n\n${line.repeat(Math.ceil(MAX_PREVIEW / line.length) + 1)}`;
    const it = await mount(workspace({ 'huge.md': huge }));
    await open(it, 'huge.md');
    expect(previewText(it)).toContain('Too long to preview');
    expect(sourceText(it)).toContain('# Huge');
  });
});

describe('a document', () => {
  it('should tell two files of one name apart by where they are', () => {
    const root = join(tmpdir(), 'ws');
    const docs = [
      createDoc(join(root, 'README.md'), ''),
      createDoc(join(root, 'docs', 'README.md'), ''),
      createDoc(join(root, 'a.ts'), ''),
    ];
    expect(tabLabels(docs, root, '*')).toStrictEqual(['README.md', 'docs/README.md', 'a.ts']);
    docs[2]?.value.set('changed');
    expect(tabLabels(docs, root, '*')).toStrictEqual(['README.md', 'docs/README.md', 'a.ts *']);
  });

  it('should show a path outside the directory whole', () => {
    const root = join(tmpdir(), 'ws');
    const outside = join(tmpdir(), 'elsewhere', 'a.md');
    expect(shownPath(outside, root)).toBe(outside);
    // a name that starts with two dots is still under the directory
    expect(shownPath(join(root, '..notes'), root)).toBe('..notes');
  });

  it('should keep its line endings, and read Markdown by extension', () => {
    const doc = createDoc(join(tmpdir(), 'a.MD'), 'a\r\nb');
    expect(doc.value.get()).toBe('a\nb');
    expect(doc.markdown).toBe(true);
    doc.value.set('a\nb\nc');
    expect(diskText(doc)).toBe('a\r\nb\r\nc');
    expect(createDoc(join(tmpdir(), 'Makefile'), '').lang).toBeUndefined();
  });
});
