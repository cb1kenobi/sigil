import { editor, type EditorOptions, resolveEditor } from '../../src/components/editor.js';
import { PromptError } from '../../src/components/prompt.js';
import { loadCatalog } from '../../src/i18n/index.js';
import { createInput as createRouter } from '../../src/input/index.js';
import { HIDE_CURSOR, SHOW_CURSOR } from '../../src/terminal/index.js';
import { type ScreenHarness, screenSetup, tick } from './helpers.js';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const ENTER = '\r';
const CTRL_C = '\u0003';
const WINDOWS = process.platform === 'win32';

/** One run of the fake editor: what it saves, and how it exits. */
interface Step {
  /** Kills itself with this signal instead of exiting. */
  signal?: string;
  /** Exits with this code. `0` if omitted. */
  exit?: number;
  /** Waits for `go()` before doing anything else, so a test can look at the screen. */
  hold?: boolean;
  /** Replaces the file's contents. Left as it was if omitted. */
  write?: string;
}

/** What the fake editor saw when it was opened. */
interface Run {
  argc: number;
  content: string;
  file: string;
}

/**
 * A stand-in editor: a node script that does what a list of steps says, one per
 * time it is opened, and records what it was handed.
 *
 * Spawned for real and through the shell, exactly as `$EDITOR` is, so what is
 * tested is the command line a real editor would get -- not a function standing
 * in for the spawn.
 */
const FAKE = `
const { existsSync, readFileSync, rmSync, writeFileSync, appendFileSync } = require('node:fs');
const [steps, file] = process.argv.slice(2);
const count = existsSync(steps + '.n') ? Number(readFileSync(steps + '.n', 'utf8')) : 0;
writeFileSync(steps + '.n', String(count + 1));
const step = JSON.parse(readFileSync(steps, 'utf8'))[count] ?? {};
appendFileSync(steps + '.log', JSON.stringify({
  argc: process.argv.length - 2,
  content: readFileSync(file, 'utf8'),
  file,
}) + '\\n');
function finish() {
  if (step.write !== undefined) writeFileSync(file, step.write);
  if (step.signal) process.kill(process.pid, step.signal);
  else process.exit(step.exit ?? 0);
}
if (step.hold) {
  // a test that failed before letting it go has removed its directory, and an
  // editor still polling for a file in it would outlive the run
  const deadline = Date.now() + 15000;
  const timer = setInterval(() => {
    if (!existsSync(steps) || Date.now() > deadline) process.exit(1);
    if (existsSync(steps + '.go')) { clearInterval(timer); rmSync(steps + '.go'); finish(); }
  }, 10);
} else {
  finish();
}
`;

let root: string;
let script: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'sigil-editor-test-'));
  script = join(root, 'fake-editor.cjs');
  writeFileSync(script, FAKE);
});

afterEach(async () => {
  rmSync(root, { force: true, recursive: true });
  await loadCatalog(undefined, {});
});

interface Fake {
  /** The `editor` option that opens it. */
  command: string;
  /** Lets a held step carry on. */
  go(): void;
  /** Every time it was opened, in order. */
  runs(): Run[];
  /** Resolves once it has been opened `n` times. */
  started(n?: number): Promise<void>;
}

function fake(...steps: Step[]): Fake {
  const path = join(root, `steps-${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(path, JSON.stringify(steps));

  const runs = (): Run[] =>
    existsSync(`${path}.log`)
      ? readFileSync(`${path}.log`, 'utf8')
          .split('\n')
          .filter(Boolean)
          .map((line) => JSON.parse(line) as Run)
      : [];

  return {
    // quoted the way a user quotes a path with a space in it, which both shells read
    command: `"${process.execPath}" "${script}" "${path}"`,
    go: () => writeFileSync(`${path}.go`, ''),
    runs,
    async started(n = 1) {
      const deadline = Date.now() + 10_000;
      while (runs().length < n) {
        if (Date.now() > deadline) {
          throw new Error(`the fake editor was opened ${runs().length} times, not ${n}`);
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    },
  };
}

/** Starts the prompt and reports how it settled, for `prompt.test.ts`'s reason. */
function settle<T>(promise: Promise<T>): Promise<{ error?: unknown; value?: T }> {
  return promise.then(
    (value) => ({ value }),
    (error: unknown) => ({ error })
  );
}

function open(ui: ScreenHarness, editorOf: Fake, opts: Partial<EditorOptions> = {}) {
  return editor({
    ansi: ui.ansi,
    editor: editorOf.command,
    message: 'Commit message',
    terminal: ui.terminal,
    ...opts,
  });
}

/** What the screen shows now, blank rows dropped. */
function rows(ui: ScreenHarness): string[] {
  return ui.log.map((line) => line.trimEnd()).filter((line) => line !== '');
}

/** Whether the last word the output said about the cursor was to show it. */
function cursorShown(ui: ScreenHarness): boolean {
  return ui.output.lastIndexOf(SHOW_CURSOR) >= ui.output.lastIndexOf(HIDE_CURSOR);
}

/** The directory the editor's file was made in, which must be gone afterwards. */
function dirOf(run: Run | undefined): string {
  expect(run, 'the editor was opened').toBeDefined();
  return dirname((run as Run).file);
}

describe('editor()', () => {
  it('should answer with what was saved, and leave the question and its first line', async () => {
    const ui = screenSetup({ columns: 300, rows: 6 });
    const ed = fake({ write: 'Fix the thing\n\nIt was broken.\n' });
    const answer = settle(open(ui, ed));

    await tick();
    expect(rows(ui)).toEqual(['? Commit message Press Enter to open your editor']);

    ui.stdin.send(ENTER);
    expect(await answer).toEqual({ value: 'Fix the thing\n\nIt was broken.' });
    expect(rows(ui)).toEqual(['? Commit message Fix the thing (+2 more lines)']);
  });

  it('should put the answer under a question that fills the line', async () => {
    // drawn in what the question left, which here was one column: `S`, `t`, `d`
    const ui = screenSetup({ columns: 40, rows: 6 });
    const ed = fake({ write: 'Show the diff\n' });
    const answer = settle(
      open(ui, ed, { message: 'Which of these changes should we apply first?' })
    );

    await tick();
    ui.stdin.send(ENTER);
    expect(await answer).toEqual({ value: 'Show the diff' });
    expect(rows(ui)).toEqual([
      '? Which of these changes should we',
      '  apply first?',
      '  Show the diff',
    ]);
  });

  it('should start the file from default, and hand the editor one argument', async () => {
    const ui = screenSetup({ columns: 300, rows: 6 });
    const ed = fake({});
    const answer = settle(open(ui, ed, { default: 'draft\n' }));

    await tick();
    ui.stdin.send(ENTER);

    // untouched, so the answer is the default with the file's own line break off it
    expect(await answer).toEqual({ value: 'draft' });
    const [run] = ed.runs();
    expect(run?.content).toBe('draft\n');
    // the steps file and the editor's file, and nothing split off either
    expect(run?.argc).toBe(2);
  });

  it('should name the file with the postfix, so the editor picks a syntax mode', async () => {
    const ui = screenSetup({ columns: 300, rows: 6 });
    const ed = fake({ write: '# hi' });
    const answer = settle(open(ui, ed, { postfix: '.md' }));

    await tick();
    ui.stdin.send(ENTER);
    await answer;

    expect(basename(ed.runs()[0]?.file ?? '')).toBe('edit.md');
  });

  it('should default the postfix to .txt', async () => {
    const ui = screenSetup({ columns: 300, rows: 6 });
    const ed = fake({});
    const answer = settle(open(ui, ed));

    await tick();
    ui.stdin.send(ENTER);
    await answer;

    expect(basename(ed.runs()[0]?.file ?? '')).toBe('edit.txt');
  });

  it("should take a platform's encoding off the answer and keep what was typed", async () => {
    const ui = screenSetup({ columns: 300, rows: 6 });
    // a byte order mark and CRLF, which is what Notepad has written, and two
    // trailing breaks -- one is the file's, the other was typed
    const ed = fake({ write: '\uFEFFone\r\ntwo\r\n\r\n' });
    const answer = settle(open(ui, ed));

    await tick();
    ui.stdin.send(ENTER);

    expect(await answer).toEqual({ value: 'one\ntwo\n' });
  });

  it('should answer an empty file as an empty string, whatever the default was', async () => {
    const ui = screenSetup({ columns: 300, rows: 6 });
    const ed = fake({ write: '' });
    const answer = settle(open(ui, ed, { default: 'something' }));

    await tick();
    ui.stdin.send(ENTER);

    expect(await answer).toEqual({ value: '' });
    expect(rows(ui)).toEqual(['? Commit message (empty)']);
  });

  it('should give the terminal up while the editor is open, and take it back after', async () => {
    const ui = screenSetup({ columns: 300, rows: 6 });
    const ed = fake({ hold: true, write: 'done' });
    const sigint = process.listenerCount('SIGINT');
    const answer = settle(open(ui, ed));

    await tick();
    expect(ui.stdin.rawMode, 'raw while asking').toBe(true);
    ui.stdin.send(ENTER);
    await ed.started();

    // the prompt holds nothing: no raw mode, nothing reading stdin, the cursor
    // back, and the live claim released so nothing can repaint over the editor
    expect(ui.stdin.rawMode).toBe(false);
    expect(ui.stdin.listenerCount('data')).toBe(0);
    expect(ui.stdin.isPaused()).toBe(true);
    expect(cursorShown(ui)).toBe(true);
    expect(rows(ui)).toEqual(['? Commit message Waiting for your editor to close the file…']);
    // and Ctrl-C belongs to the editor
    expect(process.listenerCount('SIGINT')).toBe(sigint + 1);

    ed.go();
    expect(await answer).toEqual({ value: 'done' });
    expect(process.listenerCount('SIGINT')).toBe(sigint);
    expect(ui.stdin.rawMode).toBe(false);
    expect(cursorShown(ui)).toBe(true);
    expect(rows(ui)).toEqual(['? Commit message done']);
  });

  it('should erase exactly the waiting line, at a width that wraps it', async () => {
    const ui = screenSetup({ columns: 30, rows: 10 });
    ui.terminal.write('above\n');
    const ed = fake({ write: 'ok' });
    const answer = settle(open(ui, ed));

    await tick();
    ui.stdin.send(ENTER);
    expect(await answer).toEqual({ value: 'ok' });

    // the line above is still there and nothing of the waiting line is
    expect(rows(ui)).toEqual(['above', '? Commit message ok']);
  });

  it('should ask again under the reason when validate rejects, from what was saved', async () => {
    const ui = screenSetup({ columns: 300, rows: 6 });
    const ed = fake({ write: 'wip' }, { write: 'Real message' });
    const answer = settle(
      open(ui, ed, {
        validate: (value) => (value.startsWith('wip') ? 'Write a real message' : undefined),
      })
    );

    await tick();
    ui.stdin.send(ENTER);
    await ed.started(1);
    // the editor exits, the answer is checked, and the question comes back
    for (let i = 0; i < 100 && !rows(ui).includes('  Write a real message'); i++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(rows(ui)).toEqual([
      '? Commit message Press Enter to open your editor',
      '  Write a real message',
    ]);
    expect(ui.stdin.rawMode).toBe(true);

    ui.stdin.send(ENTER);
    expect(await answer).toEqual({ value: 'Real message' });
    expect(ed.runs().map((run) => run.content)).toEqual(['', 'wip']);
    expect(rows(ui)).toEqual(['? Commit message Real message']);

    // every run had its own directory, and neither outlived it
    for (const run of ed.runs()) {
      expect(existsSync(dirOf(run))).toBe(false);
    }
  });

  describe('the temporary file', () => {
    it('should be removed after an answer', async () => {
      const ui = screenSetup({ columns: 300, rows: 6 });
      const ed = fake({ hold: true, write: 'x' });
      const answer = settle(open(ui, ed));

      await tick();
      ui.stdin.send(ENTER);
      await ed.started();
      const dir = dirOf(ed.runs()[0]);
      expect(existsSync(dir), 'there while the editor is open').toBe(true);

      ed.go();
      await answer;
      expect(existsSync(dir)).toBe(false);
    });

    it('should be removed when the editor fails, and the failure named', async () => {
      const ui = screenSetup({ columns: 300, rows: 6 });
      const ed = fake({ exit: 3, write: 'lost' });
      const answer = settle(open(ui, ed));

      await tick();
      ui.stdin.send(ENTER);
      const { error } = await answer;

      expect(error).toBeInstanceOf(PromptError);
      expect((error as PromptError).aborted).toBe(false);
      expect((error as PromptError).message).toBe(`${ed.command} exited with code 3`);
      expect(existsSync(dirOf(ed.runs()[0]))).toBe(false);
      // and the line is left, since what a failed editor said is under it
      expect(rows(ui)).toEqual(['? Commit message Waiting for your editor to close the file…']);
    });

    it('should be removed when the editor is interrupted, which is a cancel', async () => {
      const ui = screenSetup({ columns: 300, rows: 6 });
      // 130 is how a shell reports a child that died of SIGINT
      const ed = fake({ exit: 130 });
      const answer = settle(open(ui, ed));

      await tick();
      ui.stdin.send(ENTER);
      const { error } = await answer;

      expect(error).toBeInstanceOf(PromptError);
      expect((error as PromptError).aborted).toBe(true);
      expect(existsSync(dirOf(ed.runs()[0]))).toBe(false);
      expect(rows(ui)).toEqual([]);
    });

    it.skipIf(WINDOWS)('should read an editor killed by SIGINT as a cancel', async () => {
      const ui = screenSetup({ columns: 300, rows: 6 });
      const ed = fake({ signal: 'SIGINT' });
      const answer = settle(open(ui, ed));

      await tick();
      ui.stdin.send(ENTER);
      const { error } = await answer;

      expect((error as PromptError).aborted).toBe(true);
      expect(existsSync(dirOf(ed.runs()[0]))).toBe(false);
    });

    it.skipIf(WINDOWS)('should name the signal that stopped the editor', async () => {
      const ui = screenSetup({ columns: 300, rows: 6 });
      const ed = fake({ signal: 'SIGTERM' });
      const answer = settle(open(ui, ed));

      await tick();
      ui.stdin.send(ENTER);
      const { error } = await answer;

      expect((error as PromptError).message).toBe(`${ed.command} was stopped by SIGTERM`);
      expect(existsSync(dirOf(ed.runs()[0]))).toBe(false);
    });

    // dash, which is /bin/sh on Ubuntu, waits for the editor rather than exec'ing
    // it, so a SIGTERM came back as `exited with code 143` there and not on macOS.
    // An editor that exits 143 is that report on every platform
    it.skipIf(WINDOWS)('should read 128 plus a signal from the shell as that signal', async () => {
      const ui = screenSetup({ columns: 300, rows: 6 });
      const ed = fake({ exit: 143 });
      const answer = settle(open(ui, ed));

      await tick();
      ui.stdin.send(ENTER);
      const { error } = await answer;

      expect((error as PromptError).message).toBe(`${ed.command} was stopped by SIGTERM`);
    });

    it('should never be made when the prompt is cancelled before the editor opens', async () => {
      const ui = screenSetup({ columns: 300, rows: 6 });
      const ed = fake({});
      const answer = settle(open(ui, ed));

      await tick();
      ui.stdin.send(CTRL_C);
      const { error } = await answer;

      expect((error as PromptError).aborted).toBe(true);
      expect(ed.runs()).toEqual([]);
      expect(rows(ui)).toEqual([]);
      expect(ui.stdin.rawMode).toBe(false);
    });

    it('should be removed by the exit listener when the process exits under the editor', async () => {
      const ui = screenSetup({ columns: 300, rows: 6 });
      const ed = fake({ hold: true });
      const before = new Set(process.listeners('exit'));
      const answer = settle(open(ui, ed));

      await tick();
      ui.stdin.send(ENTER);
      await ed.started();

      // `process.emit('exit')` would run the test runner's own listeners too, so
      // the one this prompt added is called on its own
      const added = process.listeners('exit').filter((fn) => !before.has(fn));
      expect(added).toHaveLength(1);
      (added[0] as () => void)();
      expect(existsSync(dirOf(ed.runs()[0]))).toBe(false);

      ed.go();
      await answer;
      expect(process.listeners('exit')).toHaveLength(before.size);
    });

    it('should be removed on SIGTERM, standing down for a listener that is still there', async () => {
      const ui = screenSetup({ columns: 300, rows: 6 });
      const ed = fake({ hold: true });
      // a listener of the app's, which is what keeps the handler from raising the
      // signal again -- and the process running the test from dying of it
      const app = (): void => {};
      process.on('SIGTERM', app);
      try {
        const before = new Set(process.listeners('SIGTERM'));
        const answer = settle(open(ui, ed));

        await tick();
        ui.stdin.send(ENTER);
        await ed.started();

        const added = process.listeners('SIGTERM').filter((fn) => !before.has(fn));
        expect(added).toHaveLength(1);
        (added[0] as () => void)();
        expect(existsSync(dirOf(ed.runs()[0]))).toBe(false);
        // stood down: its listeners are off, the app's is not
        expect(process.listeners('SIGTERM')).toEqual([...before]);

        ed.go();
        await answer;
      } finally {
        process.removeListener('SIGTERM', app);
      }
    });

    it('should be made under the temp directory even when its path holds a space', async () => {
      const spaced = join(root, 'with space');
      mkdirSync(spaced);
      const saved = { TEMP: process.env.TEMP, TMP: process.env.TMP, TMPDIR: process.env.TMPDIR };
      process.env.TMPDIR = spaced;
      process.env.TEMP = spaced;
      process.env.TMP = spaced;
      try {
        const ui = screenSetup({ columns: 300, rows: 6 });
        const ed = fake({ write: 'spaced' });
        const answer = settle(open(ui, ed));

        await tick();
        ui.stdin.send(ENTER);

        expect(await answer).toEqual({ value: 'spaced' });
        const [run] = ed.runs();
        expect(dirname(dirOf(run))).toBe(spaced);
        expect(run?.argc).toBe(2);
        expect(existsSync(dirOf(run))).toBe(false);
      } finally {
        for (const [key, value] of Object.entries(saved)) {
          if (value === undefined) {
            delete process.env[key];
          } else {
            process.env[key] = value;
          }
        }
      }
    });
  });

  describe('a signal', () => {
    it('should reject with its reason once the editor closes, dropping the edit', async () => {
      const ui = screenSetup({ columns: 300, rows: 6 });
      const ed = fake({ hold: true, write: 'kept?' });
      const controller = new AbortController();
      const answer = settle(open(ui, ed, { signal: controller.signal }));

      await tick();
      ui.stdin.send(ENTER);
      await ed.started();
      controller.abort(new Error('gave up'));
      ed.go();

      const { error } = await answer;
      expect((error as Error).message).toBe('gave up');
      expect(existsSync(dirOf(ed.runs()[0]))).toBe(false);
    });
  });

  describe('refusals', () => {
    it('should reject with no terminal before an editor is looked for', async () => {
      const ui = screenSetup({ columns: 300, isTTY: false, rows: 6 });
      const ed = fake({});
      const { error } = await settle(open(ui, ed));

      expect((error as PromptError).message).toBe(
        'Cannot prompt for "Commit message" because the input is not a terminal'
      );
      expect(ed.runs()).toEqual([]);
    });

    it('should refuse a router, which would read the keys meant for the editor', async () => {
      const ui = screenSetup({ columns: 300, rows: 6 });
      const router = createRouter({ terminal: ui.terminal });
      try {
        const { error } = await settle(open(ui, fake({}), { router } as Partial<EditorOptions>));
        expect((error as PromptError).message).toMatch(/cannot share stdin with a router/);
        expect(rows(ui)).toEqual([]);
      } finally {
        router.stop();
      }
    });

    it.each(['/x.md', '\\x.md', '.md\n'])('should refuse the postfix %j', async (postfix) => {
      const ui = screenSetup({ columns: 300, rows: 6 });
      const { error } = await settle(open(ui, fake({}), { postfix }));
      expect((error as PromptError).message).toMatch(/outside its own directory/);
    });

    // on Windows the file is double-quoted into a `cmd.exe` line, where a `"`
    // closes the quote and a `%` or `!` expands -- so `" & calc & "` ran a
    // program and `%TEMP%.md` named a file nobody wrote. Refused everywhere, so
    // the platform the author is on cannot hide it
    it.each(['" & calc & ".md', '%TEMP%.md', '!x!.md'])(
      'should refuse a postfix cmd.exe would read inside the quotes, %j',
      async (postfix) => {
        const ui = screenSetup({ columns: 300, rows: 6 });
        const { error } = await settle(open(ui, fake({}), { postfix }));
        expect((error as PromptError).message).toMatch(
          /holds a character cmd\.exe reads inside a quoted path/
        );
      }
    );

    it('should refuse a default that is not a string', async () => {
      const ui = screenSetup({ columns: 300, rows: 6 });
      const { error } = await settle(open(ui, fake({}), { default: 42 as unknown as string }));
      expect((error as PromptError).message).toMatch(/`default` is 42/);
    });

    it('should refuse a blank editor', async () => {
      const ui = screenSetup({ columns: 300, rows: 6 });
      const { error } = await settle(open(ui, fake({}), { editor: '  ' }));
      expect((error as PromptError).message).toMatch(/`editor` is empty/);
    });

    it('should name the variables when there is no editor at all', async () => {
      const ui = screenSetup({ columns: 300, rows: 6 });
      const saved = {
        EDITOR: process.env.EDITOR,
        PATH: process.env.PATH,
        VISUAL: process.env.VISUAL,
      };
      delete process.env.EDITOR;
      delete process.env.VISUAL;
      process.env.PATH = join(root, 'nothing-here');
      try {
        const { error } = await settle(
          editor({ ansi: ui.ansi, message: 'Commit message', terminal: ui.terminal })
        );
        expect((error as PromptError).message).toBe(
          'Cannot open an editor for "Commit message": set $VISUAL or $EDITOR'
        );
        expect(rows(ui)).toEqual([]);
      } finally {
        for (const [key, value] of Object.entries(saved)) {
          if (value === undefined) {
            delete process.env[key];
          } else {
            process.env[key] = value;
          }
        }
      }
    });
  });
});

describe('resolveEditor()', () => {
  let platform: PropertyDescriptor;

  beforeEach(() => {
    platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
  });

  afterEach(() => {
    Object.defineProperty(process, 'platform', platform);
  });

  /** A directory holding one executable, as `PATH` would name it. */
  function bin(name: string): string {
    const dir = join(root, 'bin');
    mkdirSync(dir, { recursive: true });
    const file = join(dir, name);
    writeFileSync(file, '');
    // the mode bit is the test on POSIX; on Windows the name is, which is why
    // the Windows cases below write `notepad.EXE`
    chmodSync(file, 0o755);
    return dir;
  }

  it('should prefer $VISUAL to $EDITOR', async () => {
    expect(await resolveEditor({ EDITOR: 'nano', VISUAL: 'code --wait' })).toBe('code --wait');
  });

  it('should read a blank $VISUAL as unset', async () => {
    expect(await resolveEditor({ EDITOR: 'nano', VISUAL: '  ' })).toBe('nano');
  });

  it('should hand a variable back as written, arguments and quotes and all', async () => {
    const value = '"/Applications/My Editor.app/bin/edit" -w';
    expect(await resolveEditor({ EDITOR: ` ${value} ` })).toBe(value);
  });

  it.skipIf(WINDOWS)('should fall back to vi where PATH has one', async () => {
    const dir = bin('vi');
    expect(await resolveEditor({ PATH: dir })).toBe('vi');
  });

  it('should have no editor where neither variable is set and PATH has no default', async () => {
    expect(await resolveEditor({ PATH: join(root, 'empty') })).toBeUndefined();
  });

  it('should fall back to notepad on Windows, found by its extension', async () => {
    const dir = bin('notepad.EXE');
    Object.defineProperty(process, 'platform', { ...platform, value: 'win32' });
    expect(await resolveEditor({ PATH: dir, PATHEXT: '.COM;.EXE' })).toBe('notepad');
  });

  it('should not fall back to vi on Windows, even where PATH has one', async () => {
    const dir = bin('vi.EXE');
    Object.defineProperty(process, 'platform', { ...platform, value: 'win32' });
    expect(await resolveEditor({ PATH: dir, PATHEXT: '.EXE' })).toBeUndefined();
  });

  it('should read Path, which is how Windows spells it in a plain object', async () => {
    const dir = bin('notepad.EXE');
    Object.defineProperty(process, 'platform', { ...platform, value: 'win32' });
    expect(await resolveEditor({ Path: dir, PATHEXT: '.EXE' })).toBe('notepad');
  });
});
