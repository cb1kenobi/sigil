import { entryPath, filePicker, parentOf } from '../../src/components/file-picker.js';
import { candidatesOf, entryCache } from '../../src/components/path.js';
import { PROMPT_SYMBOLS, PromptError } from '../../src/components/prompt.js';
import { type ScreenHarness, screenSetup, tick } from './helpers.js';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, posix, sep, win32 } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/** A `readdir` that can be watched and held, for `path.test.ts`'s reason. */
const spy = vi.hoisted(() => ({
  calls: [] as string[],
  gate: undefined as ((dir: string) => Promise<void>) | undefined,
}));

vi.mock('node:fs/promises', async (original) => {
  const actual = await original<typeof import('node:fs/promises')>();
  return {
    ...actual,
    readdir: (async (dir: string, ...rest: unknown[]) => {
      spy.calls.push(String(dir));
      await spy.gate?.(String(dir));
      return (actual.readdir as (...args: unknown[]) => unknown)(dir, ...rest);
    }) as unknown as typeof actual.readdir,
  };
});

const ENTER = '\r';
const UP = '\u001b[A';
const DOWN = '\u001b[B';
const RIGHT = '\u001b[C';
const LEFT = '\u001b[D';
const HOME = '\u001b[H';
const END = '\u001b[F';
const BACKSPACE = '\u007f';

/** Sends keys one at a time, letting the prompt act on each. */
async function type(stdin: { send(chunk: string): void }, ...chunks: string[]) {
  for (const chunk of chunks) {
    stdin.send(chunk);
    await tick();
  }
}

/** Starts the prompt and reports how it settled. */
function settle<T>(promise: Promise<T>): Promise<{ error?: PromptError; value?: T }> {
  return promise.then(
    (value) => ({ value }),
    (error: PromptError) => ({ error })
  );
}

/** The names the list shows, one per row under the question. */
function listed(ui: ScreenHarness): string[] {
  return ui.log
    .slice(1)
    .map((row) => row.replace(new RegExp(`^\\s*${PROMPT_SYMBOLS.cursor}?\\s*`), '').trim())
    .filter(Boolean);
}

/** The highlighted row's name. */
function highlighted(ui: ScreenHarness): string | undefined {
  const row = ui.log.find((line) => line.trimStart().startsWith(PROMPT_SYMBOLS.cursor));
  return row?.trimStart().slice(PROMPT_SYMBOLS.cursor.length).trim();
}

/** Waits for the file system and the queue, which a `tick()` does not. */
async function until(check: () => void): Promise<void> {
  await vi.waitFor(check, { interval: 5, timeout: 2000 });
}

let root: string;

/**
 * A directory to browse, under the OS temp directory.
 *
 *   alpha/ (inner.txt, deep/ (leaf.txt))   empty/   src/ (index.ts, util.ts)
 *   alphabet.md   beta.json   beta.yaml   notes.TXT   .hidden/   .env
 */
beforeEach(async () => {
  spy.calls.length = 0;
  spy.gate = undefined;
  root = await mkdtemp(join(tmpdir(), 'sigil-filepicker-'));
  await mkdir(join(root, 'alpha', 'deep'), { recursive: true });
  await mkdir(join(root, 'empty'));
  await mkdir(join(root, 'src'));
  await mkdir(join(root, '.hidden'));
  for (const file of [
    'alphabet.md',
    'beta.json',
    'beta.yaml',
    'notes.TXT',
    '.env',
    join('alpha', 'inner.txt'),
    join('alpha', 'deep', 'leaf.txt'),
    join('src', 'index.ts'),
    join('src', 'util.ts'),
  ]) {
    await writeFile(join(root, file), '');
  }
});

afterEach(async () => {
  await rm(root, { force: true, recursive: true });
});

/** The picker over the fixture, on a screen big enough for the list. */
function open(opts: Record<string, unknown> = {}, rows = 14) {
  const ui = screenSetup({ columns: 120, rows });
  const answer = filePicker({
    ansi: ui.ansi,
    message: 'Pick?',
    root,
    terminal: ui.terminal,
    ...opts,
  });
  return { answer: settle(answer), ui };
}

/** What the root lists, before anything is chosen. */
const ROOT_ROWS = [
  `alpha${sep}`,
  `empty${sep}`,
  `src${sep}`,
  'alphabet.md',
  'beta.json',
  'beta.yaml',
  'notes.TXT',
];

describe('parentOf()', () => {
  it('should be the directory above', () => {
    expect(parentOf('/a/b/c', undefined, posix)).toBe('/a/b');
    expect(parentOf('C:\\Users\\me', undefined, win32)).toBe('C:\\Users');
  });

  it('should be nothing at a root, which is where dirname() stops', () => {
    expect(parentOf('/', undefined, posix)).toBeUndefined();
    expect(parentOf('/a', undefined, posix)).toBe('/');
    // a drive letter is somewhere to start and not somewhere to go up to
    expect(parentOf('C:\\', undefined, win32)).toBeUndefined();
    expect(parentOf('C:\\Users', undefined, win32)).toBe('C:\\');
  });

  it('should be nothing at the limit, and compare it the way the platform compares names', () => {
    expect(parentOf('/a/b', '/a/b', posix)).toBeUndefined();
    expect(parentOf('/a/b/c', '/a/b', posix)).toBe('/a/b');
    expect(parentOf('/a/B', '/a/b', posix)).toBe('/a');
    expect(parentOf('C:\\Work\\Proj', 'c:\\work\\proj', win32)).toBeUndefined();
  });
});

describe('entryPath()', () => {
  it('should join with the flavour separator', () => {
    expect(entryPath('/a/b', { dir: false, name: 'c.txt' }, posix)).toBe('/a/b/c.txt');
    expect(entryPath('C:\\a', { dir: true, name: 'b' }, win32)).toBe('C:\\a\\b');
    expect(entryPath('C:\\', { dir: true, name: 'b' }, win32)).toBe('C:\\b');
  });
});

describe('filePicker()', () => {
  it('should list directories first and then files, without dotfiles', async () => {
    const { ui } = open();

    await until(() => expect(listed(ui)).toEqual(ROOT_ROWS));
    expect(highlighted(ui)).toBe(`alpha${sep}`);
    expect(ui.log[0]).toContain(root);
  });

  it('should offer what path() offers for the same options', async () => {
    // the point of sharing `candidatesOf()`: one rule for what a file is
    const cache = entryCache();
    await cache.load(root);
    const offered = candidatesOf(cache.get(root) ?? [], '', { extensions: ['txt'] }).map(
      (entry) => entry.name + (entry.dir ? sep : '')
    );
    const { ui } = open({ extensions: ['txt'] });

    await until(() => expect(listed(ui)).toEqual(offered));
    expect(offered).toContain('notes.TXT');
  });

  it('should answer a highlighted file with its absolute path', async () => {
    const { answer, ui } = open();
    await until(() => expect(listed(ui)).toEqual(ROOT_ROWS));

    await type(ui.stdin, DOWN, DOWN, DOWN, DOWN, ENTER);

    expect(await answer).toEqual({ value: join(root, 'beta.json') });
  });

  it('should answer relative to the working directory when there is no root', async () => {
    const ui = screenSetup({ columns: 120, rows: 14 });
    const answer = settle(
      filePicker({
        ansi: ui.ansi,
        extensions: ['nothing'],
        message: 'Pick?',
        terminal: ui.terminal,
      })
    );
    await tick(3);

    expect(ui.log[0]).toContain(process.cwd());
    ui.stdin.send('\u0003');
    expect((await answer).error).toBeInstanceOf(PromptError);
  });

  describe('going in and out', () => {
    it('should go into a directory on Right and on Enter', async () => {
      const { ui } = open();
      await until(() => expect(listed(ui)).toEqual(ROOT_ROWS));

      await type(ui.stdin, RIGHT);
      await until(() => expect(listed(ui)).toEqual([`deep${sep}`, 'inner.txt']));
      expect(ui.log[0]).toContain(join(root, 'alpha'));

      await type(ui.stdin, ENTER);
      await until(() => expect(listed(ui)).toEqual(['leaf.txt']));
      expect(ui.log[0]).toContain(join(root, 'alpha', 'deep'));
    });

    it('should do nothing on Right over a file', async () => {
      const { ui } = open();
      await until(() => expect(listed(ui)).toEqual(ROOT_ROWS));

      await type(ui.stdin, END, RIGHT);

      expect(highlighted(ui)).toBe('notes.TXT');
      expect(listed(ui)).toEqual(ROOT_ROWS);
    });

    it('should come back out on Left and on Backspace, onto the directory it left', async () => {
      const { ui } = open();
      await until(() => expect(listed(ui)).toEqual(ROOT_ROWS));
      await type(ui.stdin, DOWN, DOWN, RIGHT);
      await until(() => expect(listed(ui)).toEqual(['index.ts', 'util.ts']));

      await type(ui.stdin, LEFT);
      await until(() => expect(listed(ui)).toEqual(ROOT_ROWS));
      expect(highlighted(ui)).toBe(`src${sep}`);

      await type(ui.stdin, RIGHT, BACKSPACE);
      await until(() => expect(highlighted(ui)).toBe(`src${sep}`));
    });

    it('should leave the root for its parent unless confined', async () => {
      const { ui } = open();
      await until(() => expect(listed(ui)).toEqual(ROOT_ROWS));

      await type(ui.stdin, LEFT);

      await until(() => expect(listed(ui)).toContain(`${basename(root)}${sep}`));
      expect(highlighted(ui)).toBe(`${basename(root)}${sep}`);
      expect(ui.log[0]).toContain(dirname(root));
    });

    it('should stay in the root when confined', async () => {
      const { ui } = open({ confine: true });
      await until(() => expect(listed(ui)).toEqual(ROOT_ROWS));

      await type(ui.stdin, LEFT, BACKSPACE);

      expect(listed(ui)).toEqual(ROOT_ROWS);
      expect(ui.log[0]).toContain(root);
    });

    it('should still come out of a directory it went into when confined', async () => {
      const { ui } = open({ confine: true });
      await until(() => expect(listed(ui)).toEqual(ROOT_ROWS));

      await type(ui.stdin, RIGHT, LEFT);

      await until(() => expect(listed(ui)).toEqual(ROOT_ROWS));
    });

    it('should say so when a directory has nothing in it, and only once it has been read', async () => {
      let release: () => void = () => {};
      const held = new Promise<void>((done) => {
        release = done;
      });
      spy.gate = async (dir) => {
        if (dir === join(root, 'empty')) {
          await held;
        }
      };
      const { ui } = open();
      await until(() => expect(listed(ui)).toEqual(ROOT_ROWS));

      await type(ui.stdin, DOWN, RIGHT);
      expect(ui.log.join('\n')).not.toContain('No matches');

      release();
      await until(() => expect(listed(ui)).toEqual(['No matches']));
    });

    it('should not hold Left behind a directory that is slow to read', async () => {
      let release: () => void = () => {};
      const held = new Promise<void>((done) => {
        release = done;
      });
      let holding = false;
      spy.gate = async (dir) => {
        if (dir === join(root, 'alpha')) {
          holding = true;
          await held;
        }
      };
      const { ui } = open();
      await until(() => expect(listed(ui)).toEqual(ROOT_ROWS));

      await type(ui.stdin, RIGHT);
      await until(() => expect(holding).toBe(true));
      expect(ui.log[0]).toContain(join(root, 'alpha'));

      // the read is still held, and getting away from it does not wait for it
      await type(ui.stdin, LEFT);
      await until(() => expect(listed(ui)).toEqual(ROOT_ROWS));
      expect(ui.log[0]).not.toContain(join(root, 'alpha'));

      release();
    });

    it('should land keys typed ahead of the first read on the list they imply', async () => {
      let release: () => void = () => {};
      const held = new Promise<void>((done) => {
        release = done;
      });
      let holding = false;
      spy.gate = async (dir) => {
        if (dir === root) {
          holding = true;
          await held;
        }
      };
      const { answer, ui } = open();
      await until(() => expect(holding).toBe(true));

      ui.stdin.send(DOWN);
      ui.stdin.send(DOWN);
      ui.stdin.send(DOWN);
      ui.stdin.send(DOWN);
      ui.stdin.send(ENTER);
      await tick(3);
      release();

      expect(await answer).toEqual({ value: join(root, 'beta.json') });
    });

    it('should read a directory once however often it is visited', async () => {
      const { ui } = open();
      await until(() => expect(listed(ui)).toEqual(ROOT_ROWS));

      await type(ui.stdin, RIGHT, LEFT, RIGHT, LEFT);
      await until(() => expect(listed(ui)).toEqual(ROOT_ROWS));

      expect(spy.calls.filter((dir) => dir === join(root, 'alpha'))).toHaveLength(1);
      expect(spy.calls.filter((dir) => dir === root)).toHaveLength(1);
    });
  });

  describe('moving the highlight', () => {
    it('should wrap from the last row to the first and back', async () => {
      const { ui } = open();
      await until(() => expect(listed(ui)).toEqual(ROOT_ROWS));

      await type(ui.stdin, UP);
      expect(highlighted(ui)).toBe('notes.TXT');

      await type(ui.stdin, DOWN);
      expect(highlighted(ui)).toBe(`alpha${sep}`);
    });

    it('should stop at the ends with loop: false', async () => {
      const { ui } = open({ loop: false });
      await until(() => expect(listed(ui)).toEqual(ROOT_ROWS));

      await type(ui.stdin, UP);
      expect(highlighted(ui)).toBe(`alpha${sep}`);

      await type(ui.stdin, END, DOWN);
      expect(highlighted(ui)).toBe('notes.TXT');
    });

    it('should go to the first and last with Home and End', async () => {
      const { ui } = open();
      await until(() => expect(listed(ui)).toEqual(ROOT_ROWS));

      await type(ui.stdin, END);
      expect(highlighted(ui)).toBe('notes.TXT');

      await type(ui.stdin, HOME);
      expect(highlighted(ui)).toBe(`alpha${sep}`);
    });

    it('should window a list longer than the room and keep the highlight on screen', async () => {
      // two rows of head and error, so three rows of list
      const { ui } = open({ rows: 3 });
      await until(() => expect(listed(ui)).toEqual(ROOT_ROWS.slice(0, 3)));

      await type(ui.stdin, END);

      expect(listed(ui)).toEqual(ROOT_ROWS.slice(-3));
      expect(highlighted(ui)).toBe('notes.TXT');
    });
  });

  describe('what is offered', () => {
    it('should filter files by extension and always keep the directories', async () => {
      const { ui } = open({ extensions: ['json', '.yaml'] });

      await until(() =>
        expect(listed(ui)).toEqual([
          `alpha${sep}`,
          `empty${sep}`,
          `src${sep}`,
          'beta.json',
          'beta.yaml',
        ])
      );
    });

    it('should match an extension without regard to case', async () => {
      const { ui } = open({ extensions: ['txt'] });

      await until(() => expect(listed(ui)).toContain('notes.TXT'));
      expect(listed(ui)).not.toContain('beta.json');
    });

    it('should show dotfiles from the start with hidden: true', async () => {
      const { ui } = open({ hidden: true });

      await until(() => expect(listed(ui)).toContain('.env'));
      expect(listed(ui)).toContain(`.hidden${sep}`);
    });

    it('should show and hide dotfiles on ., keeping the highlight where it was', async () => {
      const { ui } = open();
      await until(() => expect(listed(ui)).toEqual(ROOT_ROWS));
      await type(ui.stdin, END);

      await type(ui.stdin, '.');
      expect(listed(ui)).toContain('.env');
      expect(highlighted(ui)).toBe('notes.TXT');

      await type(ui.stdin, '.');
      expect(listed(ui)).toEqual(ROOT_ROWS);
      expect(highlighted(ui)).toBe('notes.TXT');
    });

    it('should fall back to the top when hiding the row it was on', async () => {
      const { ui } = open({ hidden: true });
      await until(() => expect(listed(ui)).toContain('.env'));
      // `.hidden/` is the first of the directories, being sorted by code unit
      expect(highlighted(ui)).toBe(`.hidden${sep}`);

      await type(ui.stdin, '.');

      expect(highlighted(ui)).toBe(`alpha${sep}`);
    });

    it.skipIf(process.platform === 'win32')('should go into a link to a directory', async () => {
      await symlink(join(root, 'src'), join(root, 'aaa-linked'));
      const { ui } = open();
      await until(() => expect(listed(ui)[0]).toBe(`aaa-linked${sep}`));

      await type(ui.stdin, RIGHT);

      await until(() => expect(listed(ui)).toEqual(['index.ts', 'util.ts']));
    });
  });

  describe('directory: true', () => {
    it('should list directories only, with the directory itself first', async () => {
      const { ui } = open({ directory: true });

      await until(() =>
        expect(listed(ui)).toEqual([`.${sep}`, `alpha${sep}`, `empty${sep}`, `src${sep}`])
      );
      expect(highlighted(ui)).toBe(`.${sep}`);
    });

    it('should answer the directory it is in on Enter over .', async () => {
      const { answer, ui } = open({ directory: true });
      await until(() => expect(listed(ui)[0]).toBe(`.${sep}`));

      await type(ui.stdin, ENTER);

      expect(await answer).toEqual({ value: root });
    });

    it('should answer a highlighted directory on Enter, and go into it on Right', async () => {
      const { answer, ui } = open({ directory: true });
      await until(() => expect(listed(ui)[0]).toBe(`.${sep}`));

      await type(ui.stdin, DOWN, RIGHT);
      await until(() => expect(listed(ui)).toEqual([`.${sep}`, `deep${sep}`]));
      await type(ui.stdin, DOWN, ENTER);

      expect(await answer).toEqual({ value: join(root, 'alpha', 'deep') });
    });

    it('should let a directory with nothing in it be the answer', async () => {
      const { answer, ui } = open({ directory: true });
      await until(() => expect(listed(ui)[0]).toBe(`.${sep}`));

      await type(ui.stdin, DOWN, DOWN, RIGHT);
      await until(() => expect(listed(ui)).toEqual([`.${sep}`, 'No matches']));
      await type(ui.stdin, ENTER);

      expect(await answer).toEqual({ value: join(root, 'empty') });
    });
  });

  describe('the answer', () => {
    it('should check it with validate and say why not, and stay where it was', async () => {
      const validate = vi.fn((value: string) =>
        value.endsWith('.json') ? undefined : 'JSON only'
      );
      const { answer, ui } = open({ validate });
      await until(() => expect(listed(ui)).toEqual(ROOT_ROWS));

      await type(ui.stdin, END, ENTER);
      await until(() => expect(ui.log.join('\n')).toContain('JSON only'));
      expect(validate).toHaveBeenCalledWith(join(root, 'notes.TXT'));
      expect(listed(ui)).toContain('notes.TXT');

      await type(ui.stdin, UP, UP, ENTER);

      expect(await answer).toEqual({ value: join(root, 'beta.json') });
    });

    it('should settle to the question and the answer', async () => {
      const { answer, ui } = open();
      await until(() => expect(listed(ui)).toEqual(ROOT_ROWS));

      await type(ui.stdin, DOWN, DOWN, DOWN, ENTER);
      await answer;

      expect(ui.log.join('\n')).toContain(join(root, 'alphabet.md'));
      expect(ui.log.join('\n')).not.toContain('beta.json');
    });
  });

  it('should reject without a terminal to ask on', async () => {
    const ui = screenSetup({ isTTY: false });

    await expect(
      filePicker({ ansi: ui.ansi, message: 'Pick?', terminal: ui.terminal })
    ).rejects.toBeInstanceOf(PromptError);
  });
});

describe('entryCache()', () => {
  it('should read a directory once and answer from what has landed', async () => {
    const cache = entryCache();

    expect(cache.has(root)).toBe(false);
    expect(cache.get(root)).toBeUndefined();

    await Promise.all([cache.load(root), cache.load(root)]);
    await cache.load(root);

    expect(cache.has(root)).toBe(true);
    expect(cache.get(root)?.map((entry) => entry.name)).toContain('beta.json');
    expect(spy.calls.filter((dir) => dir === root)).toHaveLength(1);
  });

  it('should cache a directory that cannot be read as empty', async () => {
    const cache = entryCache();

    await cache.load(join(root, 'not-there'));

    expect(cache.get(join(root, 'not-there'))).toEqual([]);
  });
});
