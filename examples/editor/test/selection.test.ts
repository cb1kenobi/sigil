import { createDoc, selectedCharacters } from '../src/documents.ts';
import { App, stylesheet } from '../src/root.tsx';
import { createWorkspace, WorkspaceContext } from '../src/workspace.ts';
import { runApp } from '@ttylabs/sigil/app';
import { provideContext } from '@ttylabs/sigil/renderer';
import { createTestTerminal, frame, KEYS } from '@ttylabs/sigil/testing';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * What the footer says about a selection, which is the text area's `selection`
 * state read by an app: a count beside `Ln 12, Col 5` that follows the keys, and
 * that an app writing the state moves too.
 */

const made: string[] = [];
afterAll(() => {
  for (const dir of made.splice(0)) {
    rmSync(dir, { force: true, maxRetries: 5, recursive: true });
  }
});

const ESC = '\u001b';
const SHIFT_RIGHT = `${ESC}[1;2C`;
const SHIFT_DOWN = `${ESC}[1;2B`;

describe('selectedCharacters()', () => {
  const at = (line: number, col: number) => ({ col, line });
  const text = 'one\ntwo\nthree';

  it('should count a selection in either direction, a line break as one character', () => {
    expect(selectedCharacters(text, { anchor: at(0, 1), caret: at(0, 3) })).toBe(2);
    expect(selectedCharacters(text, { anchor: at(0, 3), caret: at(0, 1) })).toBe(2);
    expect(selectedCharacters(text, { anchor: at(0, 2), caret: at(2, 2) })).toBe(1 + 1 + 3 + 1 + 2);
  });

  it('should count nothing for a selection with one place, and a cluster once', () => {
    expect(selectedCharacters(text, { anchor: at(1, 1), caret: at(1, 1) })).toBe(0);
    expect(selectedCharacters('a😀b', { anchor: at(0, 0), caret: at(0, 3) })).toBe(2);
  });

  it('should count over the text the area holds, which has no control character, and not throw', () => {
    // a form feed is dropped from the area's lines, so the places are into `ab\nc`
    expect(selectedCharacters('a\u000Cb\nc', { anchor: at(0, 0), caret: at(1, 1) })).toBe(4);
    expect(selectedCharacters('ab', { anchor: at(0, 0), caret: at(9, 9) })).toBe(2);
  });

  it('should start each document collapsed at the top', () => {
    const doc = createDoc('/tmp/x.txt', 'abc');
    expect(selectedCharacters('abc', doc.selection.get())).toBe(0);
  });
});

describe('the editor footer', () => {
  beforeEach(() => {
    // the borders come from `unicodeSupported()`, and a Windows runner says ASCII
    vi.stubEnv('TERM', 'xterm-256color');
    vi.stubEnv('WT_SESSION', '1');
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('should say how much is selected, and stop saying it when nothing is', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sigil-editor-selection-'));
    made.push(dir);
    writeFileSync(join(dir, 'a.txt'), 'one\ntwo\nthree\n');
    const term = createTestTerminal({ columns: 120, rows: 30 });
    const app = runApp(() => provideContext(WorkspaceContext, createWorkspace(dir), App), {
      detect: false,
      sheets: [stylesheet],
      terminal: term.terminal,
    });
    const screen = (): string => term.viewport.join('\n');
    const until = async (what: string): Promise<void> => {
      for (let i = 0; i < 200 && !screen().includes(what); i++) {
        await frame(app);
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      expect(screen()).toContain(what);
    };
    try {
      await until('a.txt');
      // the tree has the focus: Home, the first row under the root, and Enter
      await term.press(KEYS.home, KEYS.down, KEYS.enter);
      await until('Ln 1, Col 1');
      expect(screen()).not.toContain('selected)');
      await term.press(SHIFT_RIGHT, SHIFT_RIGHT);
      await until('Ln 1, Col 3 (2 selected)');
      await term.press(SHIFT_DOWN);
      // `one`, the break, and `tw`
      await until('Ln 2, Col 3 (6 selected)');
      // an arrow over a selection lands on the end it points at, one place
      await term.press(KEYS.right);
      for (let i = 0; i < 200 && screen().includes('selected)'); i++) {
        await frame(app);
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      expect(screen()).toContain('Ln 2, Col 3');
      expect(screen()).not.toContain('selected)');
    } finally {
      app.exit(0);
      await app.exited;
    }
  });
});
