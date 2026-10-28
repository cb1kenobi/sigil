import {
  answerOf,
  candidatesOf,
  commonPrefix,
  directoryOf,
  extendSegment,
  path,
  type PathEntry,
  separatorFor,
  splitTyped,
} from '../../src/components/path.js';
import { PromptError } from '../../src/components/prompt.js';
import { home } from '../../src/paths.js';
import { type ScreenHarness, screenSetup, tick } from './helpers.js';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, posix, resolve, sep, win32 } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * A `readdir` that can be watched and held, standing in for the real one.
 *
 * Hoisted because `vi.mock` is: the factory runs before the imports, so what it
 * closes over has to exist by then. Everything else the module exports is the
 * real thing, so the fixture below is made with the real file system.
 */
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
const TAB = '\t';
const UP = '\u001b[A';
const DOWN = '\u001b[B';
const BACKSPACE = '\u007f';

/** Sends keys one at a time, letting the prompt act on each. */
async function type(stdin: { send(chunk: string): void }, ...chunks: string[]) {
  for (const chunk of chunks) {
    stdin.send(chunk);
    await tick();
  }
}

/** Starts the prompt and reports how it settled, for `prompt.test.ts`'s reason. */
function settle<T>(promise: Promise<T>): Promise<{ error?: PromptError; value?: T }> {
  return promise.then(
    (value) => ({ value }),
    (error: PromptError) => ({ error })
  );
}

/** What the screen shows, as one string. */
function screen(ui: ScreenHarness): string {
  return ui.log.join('\n');
}

/** What is in the field: the first row, less the question. */
function field(ui: ScreenHarness): string {
  return (ui.log[0] ?? '').replace(/^\S+ Pick\? ?/, '');
}

/** The names the list shows, one per row under the field. */
function listed(ui: ScreenHarness): string[] {
  return ui.log
    .slice(1)
    .map((row) => row.replace(/^\s*❯?\s*/, '').trim())
    .filter(Boolean);
}

/** Waits for the file system and the queue, which a `tick()` does not. */
async function until(check: () => void): Promise<void> {
  await vi.waitFor(check, { interval: 5, timeout: 2000 });
}

let root: string;

/** What a relative answer comes back as when the prompt was given a `root`. */
const abs = (typed: string): string => resolve(root, typed);

/**
 * A directory to prompt over, under the OS temp directory.
 *
 *   alpha/ (inner.txt, deep/)   alphabet.md   beta.json   beta.yaml
 *   notes.TXT   src/ (index.ts, util.ts)   .hidden/   .env
 */
beforeEach(async () => {
  spy.calls.length = 0;
  spy.gate = undefined;
  root = await mkdtemp(join(tmpdir(), 'sigil-path-'));
  await mkdir(join(root, 'alpha', 'deep'), { recursive: true });
  await mkdir(join(root, 'src'));
  await mkdir(join(root, '.hidden'));
  for (const file of [
    'alphabet.md',
    'beta.json',
    'beta.yaml',
    'notes.TXT',
    '.env',
    join('alpha', 'inner.txt'),
    join('src', 'index.ts'),
    join('src', 'util.ts'),
  ]) {
    await writeFile(join(root, file), '');
  }
});

afterEach(async () => {
  await rm(root, { force: true, recursive: true });
});

/** The prompt over the fixture, on a screen big enough for the list. */
function open(opts: Record<string, unknown> = {}, columns = 60) {
  const ui = screenSetup({ columns, rows: 14 });
  const answer = path({
    ansi: ui.ansi,
    message: 'Pick?',
    root,
    terminal: ui.terminal,
    ...opts,
  });
  return { answer: settle(answer), ui };
}

describe('splitTyped()', () => {
  it('should split at the last separator and keep the separator with the directory', () => {
    expect(splitTyped('a/b/c', posix)).toEqual({ dir: 'a/b/', segment: 'c' });
    expect(splitTyped('c', posix)).toEqual({ dir: '', segment: 'c' });
    expect(splitTyped('a/', posix)).toEqual({ dir: 'a/', segment: '' });
  });

  it('should take either separator on Windows and only the slash elsewhere', () => {
    expect(splitTyped('C:\\Users/me\\do', win32)).toEqual({ dir: 'C:\\Users/me\\', segment: 'do' });
    // a backslash on POSIX is a file name character
    expect(splitTyped('a\\b/c', posix)).toEqual({ dir: 'a\\b/', segment: 'c' });
  });
});

describe('separatorFor()', () => {
  it('should complete in the separator the person is already using', () => {
    expect(separatorFor('C:/Users/', win32)).toBe('/');
    expect(separatorFor('C:\\Users\\', win32)).toBe('\\');
    expect(separatorFor('', win32)).toBe(win32.sep);
    expect(separatorFor('', posix)).toBe(posix.sep);
  });
});

describe('directoryOf()', () => {
  it('should read the base for an empty directory part and resolve a relative one against it', () => {
    expect(directoryOf('', root)).toBe(root);
    expect(directoryOf(`src${sep}`, root)).toBe(join(root, 'src'));
  });

  it('should leave an absolute directory alone', () => {
    expect(directoryOf(root + sep, '/elsewhere')).toBe(root + sep);
    expect(directoryOf('C:\\data\\', 'D:\\base', win32)).toBe('C:\\data\\');
  });

  it('should go through paths.ts for a home directory', () => {
    expect(directoryOf('~/', root)).toBe(join(home() as string, sep));
    expect(directoryOf(`~${sep}x${sep}`, root)).toBe(join(home() as string, 'x', sep));
  });

  it('should name nothing for a user it cannot expand', () => {
    // `expand()` does not implement `~user`, so it stays relative and is refused
    expect(directoryOf('~nobody/', root)).toBeUndefined();
  });
});

describe('candidatesOf()', () => {
  const entries: PathEntry[] = [
    { dir: false, name: 'b.txt' },
    { dir: true, name: 'zed' },
    { dir: false, name: 'a.TXT' },
    { dir: true, name: 'apple' },
    { dir: false, name: '.env' },
    { dir: true, name: '.git' },
    { dir: false, name: 'c.md' },
  ];
  const names = (found: PathEntry[]) => found.map((entry) => entry.name);

  it('should list directories first and then by name, whatever the locale', () => {
    expect(names(candidatesOf(entries, '', {}, posix))).toEqual([
      'apple',
      'zed',
      'a.TXT',
      'b.txt',
      'c.md',
    ]);
  });

  it('should skip dotfiles unless asked, or unless the segment starts with a dot', () => {
    expect(names(candidatesOf(entries, '', {}, posix))).not.toContain('.env');
    expect(names(candidatesOf(entries, '', { hidden: true }, posix))).toContain('.env');
    expect(names(candidatesOf(entries, '.', {}, posix))).toEqual(['.git', '.env']);
  });

  it('should keep only directories in directory mode', () => {
    expect(names(candidatesOf(entries, '', { directory: true }, posix))).toEqual(['apple', 'zed']);
  });

  it('should filter files by extension with or without the dot, and always keep directories', () => {
    expect(names(candidatesOf(entries, '', { extensions: ['md'] }, posix))).toEqual([
      'apple',
      'zed',
      'c.md',
    ]);
    expect(names(candidatesOf(entries, '', { extensions: ['.txt'] }, posix))).toEqual([
      'apple',
      'zed',
      'a.TXT',
      'b.txt',
    ]);
  });

  it('should match a prefix, case-sensitively on POSIX and not on Windows', () => {
    expect(names(candidatesOf(entries, 'A', {}, posix))).toEqual([]);
    expect(names(candidatesOf(entries, 'A', {}, win32))).toEqual(['apple', 'a.TXT']);
  });
});

describe('commonPrefix()', () => {
  it('should find what every name shares', () => {
    expect(commonPrefix(['beta.json', 'beta.yaml'], posix)).toBe('beta.');
    expect(commonPrefix(['only'], posix)).toBe('only');
    expect(commonPrefix([], posix)).toBe('');
    expect(commonPrefix(['a', 'b'], posix)).toBe('');
  });

  it('should keep the first name spelling on a caseless file system', () => {
    expect(commonPrefix(['Readme.md', 'README.txt'], win32)).toBe('Readme.');
  });

  it('should never split a surrogate pair', () => {
    // 😀 and 😁 share their high surrogate and nothing else
    expect(commonPrefix(['x\u{1F600}', 'x\u{1F601}'], posix)).toBe('x');
  });
});

describe('extendSegment()', () => {
  it('should extend to what the candidates share', () => {
    expect(extendSegment('b', ['beta.json', 'beta.yaml'], posix)).toBe('beta.');
  });

  it('should add nothing when the candidates share no more than was typed', () => {
    expect(extendSegment('beta.', ['beta.json', 'beta.yaml'], posix)).toBeUndefined();
  });

  it('should not rewrite the case of what was typed for a prefix of the same length', () => {
    // the candidates agree with `readme.` and spell it `Readme.`
    expect(extendSegment('readme.', ['Readme.md', 'README.txt'], win32)).toBeUndefined();
    expect(extendSegment('read', ['Readme.md', 'README.txt'], win32)).toBe('Readme.');
  });
});

describe('answerOf()', () => {
  it('should return the path as typed when no root was given', () => {
    expect(answerOf('src/index.ts', undefined, root)).toBe('src/index.ts');
  });

  it('should resolve a relative path against the root when one was given', () => {
    expect(answerOf('src/index.ts', root, root)).toBe(resolve(root, 'src/index.ts'));
  });

  it('should leave an absolute path alone even with a root', () => {
    expect(answerOf(root, '/elsewhere', '/elsewhere')).toBe(root);
  });

  it('should expand a home directory whether or not there is a root', () => {
    expect(answerOf('~/x', undefined, root)).toBe(join(home() as string, 'x'));
    expect(answerOf('~', undefined, root)).toBe(home());
  });

  it('should leave an empty answer empty', () => {
    expect(answerOf('', root, root)).toBe('');
  });
});

describe('path()', () => {
  it('should return what was typed, unresolved, when there is no root', async () => {
    const ui = screenSetup({ columns: 60, rows: 14 });
    const answer = settle(path({ ansi: ui.ansi, message: 'Pick?', terminal: ui.terminal }));

    await type(ui.stdin, 'a', '/', 'b', ENTER);

    expect(await answer).toEqual({ value: 'a/b' });
  });

  it('should list what is in the directory being typed', async () => {
    const { ui } = open();
    await type(ui.stdin, 's');

    await until(() => expect(listed(ui)).toEqual([`src${sep}`]));
  });

  it('should list the root before anything is typed', async () => {
    const { ui } = open();

    await until(() =>
      expect(listed(ui)).toEqual([
        `alpha${sep}`,
        `src${sep}`,
        'alphabet.md',
        'beta.json',
        'beta.yaml',
        'notes.TXT',
      ])
    );
  });

  it('should complete to the longest prefix the candidates share', async () => {
    const { ui } = open();
    await type(ui.stdin, 'b', TAB);

    await until(() => expect(field(ui)).toBe('beta.'));
    expect(listed(ui)).toEqual(['beta.json', 'beta.yaml']);
  });

  it('should leave the field alone when the candidates agree on nothing more', async () => {
    const { ui } = open();
    await type(ui.stdin, 'a', TAB);

    // alpha/ and alphabet.md share `alpha` -- one more than typed
    await until(() => expect(field(ui)).toBe('alpha'));
    await type(ui.stdin, TAB);
    await tick(5);
    expect(field(ui)).toBe('alpha');
  });

  it('should complete a lone directory with a separator so typing can continue', async () => {
    const { answer, ui } = open();
    await type(ui.stdin, 's', 'r', TAB);

    await until(() => expect(field(ui)).toBe(`src${sep}`));
    await until(() => expect(listed(ui)).toEqual(['index.ts', 'util.ts']));
    await type(ui.stdin, 'i', TAB, ENTER);

    expect(await answer).toEqual({ value: abs(`src${sep}index.ts`) });
  });

  it('should complete a lone file without a separator', async () => {
    const { answer, ui } = open();
    await type(ui.stdin, 'n', TAB);

    await until(() => expect(field(ui)).toBe('notes.TXT'));
    await type(ui.stdin, ENTER);
    expect(await answer).toEqual({ value: abs('notes.TXT') });
  });

  it('should skip dotfiles until the segment starts with a dot', async () => {
    const { ui } = open();
    await until(() => expect(listed(ui)).not.toEqual([]));
    expect(listed(ui)).not.toContain(`.hidden${sep}`);
    expect(listed(ui)).not.toContain('.env');

    await type(ui.stdin, '.');
    await until(() => expect(listed(ui)).toEqual([`.hidden${sep}`, '.env']));
  });

  it('should show dotfiles from the start with `hidden`', async () => {
    const { ui } = open({ hidden: true });

    await until(() => expect(listed(ui)).toContain('.env'));
  });

  it('should offer only directories with `directory`', async () => {
    const { ui } = open({ directory: true });

    await until(() => expect(listed(ui)).toEqual([`alpha${sep}`, `src${sep}`]));
  });

  it('should filter files by extension and still offer directories', async () => {
    const { ui } = open({ extensions: ['json', '.yaml'] });

    await until(() =>
      expect(listed(ui)).toEqual([`alpha${sep}`, `src${sep}`, 'beta.json', 'beta.yaml'])
    );
  });

  it('should read relative paths from the root', async () => {
    const { answer, ui } = open({ root: join(root, 'src') });
    await type(ui.stdin, 'u', TAB);

    await until(() => expect(field(ui)).toBe('util.ts'));
    await type(ui.stdin, ENTER);
    // a root was given, so the answer is absolute
    expect(await answer).toEqual({ value: join(root, 'src', 'util.ts') });
  });

  it('should show an empty list as no matches rather than failing', async () => {
    const { ui } = open();
    await type(ui.stdin, 'z', 'z');

    await until(() => expect(screen(ui)).toContain('No matches'));
  });

  it('should treat a directory that is not there as having nothing in it', async () => {
    const { answer, ui } = open();
    await type(ui.stdin, 'n', 'o', 'p', 'e', sep, TAB);

    await until(() => expect(screen(ui)).toContain('No matches'));
    expect(field(ui)).toBe(`nope${sep}`);
    await type(ui.stdin, ENTER);
    expect(await answer).toEqual({ value: abs(`nope${sep}`) });
  });

  it('should treat a file typed as a directory as having nothing in it', async () => {
    const { ui } = open();
    await type(ui.stdin, 'b', 'e', 't', 'a', '.', 'j', 's', 'o', 'n', sep);

    await until(() => expect(screen(ui)).toContain('No matches'));
  });

  it('should offer a home directory for a bare `~`', async () => {
    const { ui } = open();
    await type(ui.stdin, '~', TAB);

    await until(() => expect(field(ui)).toBe(`~${sep}`));
  });

  it('should list a home directory through paths.ts', async () => {
    const { ui } = open();
    await type(ui.stdin, '~', sep);

    await until(() => expect(spy.calls).toContain(join(home() as string, sep)));
  });

  it('should answer with the home directory expanded', async () => {
    const { answer, ui } = open();
    await type(ui.stdin, '~', sep, 'x', ENTER);

    expect(await answer).toEqual({ value: join(home() as string, 'x') });
  });

  describe('the list', () => {
    it('should accept a highlighted file on Enter', async () => {
      const { answer, ui } = open();
      await type(ui.stdin, 'b', DOWN, DOWN, ENTER);

      expect(await answer).toEqual({ value: abs('beta.yaml') });
    });

    it('should fill in a highlighted directory on Enter and keep asking', async () => {
      const { answer, ui } = open();
      await type(ui.stdin, 'a', DOWN, ENTER);

      await until(() => expect(field(ui)).toBe(`alpha${sep}`));
      await until(() => expect(listed(ui)).toEqual([`deep${sep}`, 'inner.txt']));
      await type(ui.stdin, ENTER);
      expect(await answer).toEqual({ value: abs(`alpha${sep}`) });
    });

    it('should complete the highlighted candidate on Tab, not the shared prefix', async () => {
      const { ui } = open();
      await type(ui.stdin, 'b', DOWN, DOWN, TAB);

      await until(() => expect(field(ui)).toBe('beta.yaml'));
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

      const { ui } = open();
      await tick(3);
      expect(holding).toBe(true);

      // the list does not exist yet: the letter is applied, and the keys that act
      // on the list wait for it rather than acting on nothing
      ui.stdin.send('b');
      await tick(3);
      expect(field(ui)).toBe('b');
      ui.stdin.send(DOWN);
      ui.stdin.send(DOWN);
      ui.stdin.send(TAB);
      await tick(3);
      release();

      await until(() => expect(field(ui)).toBe('beta.yaml'));
    });

    it('should return to the field through the unhighlighted position', async () => {
      const { answer, ui } = open();
      await type(ui.stdin, 'b', 'e', DOWN, UP, ENTER);

      // down then up is back to nothing highlighted, so Enter means what was typed
      expect(await answer).toEqual({ value: abs('be') });
    });

    it('should wrap upward to the last candidate', async () => {
      const { answer, ui } = open();
      await type(ui.stdin, 'b', UP, ENTER);

      expect(await answer).toEqual({ value: abs('beta.yaml') });
    });

    it('should drop the highlight when the text changes', async () => {
      const { answer, ui } = open();
      await type(ui.stdin, 'b', DOWN, 'e', ENTER);

      expect(await answer).toEqual({ value: abs('be') });
    });

    it('should follow the highlight through a window shorter than the list', async () => {
      const { ui } = open({ rows: 2 });
      await until(() => expect(listed(ui)).toEqual([`alpha${sep}`, `src${sep}`]));

      await type(ui.stdin, DOWN, DOWN, DOWN);
      await until(() => expect(listed(ui)).toEqual([`src${sep}`, 'alphabet.md']));
    });
  });

  describe('the file system', () => {
    it('should read a directory once however many keystrokes land in it', async () => {
      const { ui } = open();
      await type(ui.stdin, 's', 'r', 'c', sep, 'i', 'n', BACKSPACE, BACKSPACE, 'u');

      await until(() => expect(field(ui)).toBe(`src${sep}u`));
      const reads = (dir: string) => spy.calls.filter((call) => call === dir).length;
      expect(reads(root)).toBe(1);
      expect(reads(join(root, 'src'))).toBe(1);
    });

    it('should never draw a read that finished after a newer keystroke', async () => {
      let release: () => void = () => {};
      const held = new Promise<void>((done) => {
        release = done;
      });
      // the directory as `readdir` is given it: `resolve()` strips the trailing
      // separator, so a gate written against `alpha/` would hold nothing
      let holding = false;
      spy.gate = async (dir) => {
        if (dir === join(root, 'alpha')) {
          holding = true;
          await held;
        }
      };

      const { ui } = open();
      await until(() => expect(listed(ui)).toContain('alphabet.md'));

      // a paste cannot wait for the read, so the next key arrives while alpha/
      // is still being read
      ui.stdin.send(`\u001b[200~alpha${sep}\u001b[201~`);
      await tick(3);
      await type(ui.stdin, BACKSPACE);

      // the Backspace is applied while the read is still out, which is the claim
      // that a slow directory cannot hold typing; `holding` is what says the
      // read really was held, so the test cannot pass by holding nothing
      await until(() => expect(field(ui)).toBe('alpha'));
      expect(holding).toBe(true);
      release();
      await tick(5);

      // the answer to the old keystroke is in the cache and not on the screen
      expect(listed(ui)).toEqual([`alpha${sep}`, 'alphabet.md']);
      expect(screen(ui)).not.toContain('inner.txt');
    });

    it.skipIf(process.platform === 'win32')(
      'should list a link to a directory as a directory, and a dangling one as a file',
      async () => {
        await symlink(join(root, 'src'), join(root, 'linked'));
        await symlink(join(root, 'nowhere'), join(root, 'dangling'));

        const { ui } = open({ directory: true });
        await until(() => expect(listed(ui)).toEqual([`alpha${sep}`, `linked${sep}`, `src${sep}`]));
      }
    );

    it('should read the directory a paste lands in', async () => {
      const { ui } = open();
      ui.stdin.send(`\u001b[200~src${sep}\u001b[201~`);

      await until(() => expect(listed(ui)).toEqual(['index.ts', 'util.ts']));
    });
  });

  describe('the answer', () => {
    it('should check it with validate and say why not', async () => {
      const validate = vi.fn((value: string) =>
        value.endsWith('.json') ? undefined : 'JSON only'
      );
      const { answer, ui } = open({ validate });
      await type(ui.stdin, 'x', ENTER);

      await until(() => expect(screen(ui)).toContain('JSON only'));
      await type(ui.stdin, BACKSPACE, 'a.json', ENTER);
      expect(await answer).toEqual({ value: abs('a.json') });
      expect(validate).toHaveBeenCalledTimes(2);
    });

    it('should hand validate the answer in the form it will be returned in', async () => {
      const validate = vi.fn(() => undefined);
      const { answer, ui } = open({ validate });
      await type(ui.stdin, 'x', ENTER);

      await answer;
      expect(validate).toHaveBeenCalledWith(resolve(root, 'x'));
    });

    it('should start from `initial`', async () => {
      const { answer, ui } = open({ initial: 'beta.json' });

      await until(() => expect(field(ui)).toBe('beta.json'));
      await type(ui.stdin, ENTER);
      expect(await answer).toEqual({ value: resolve(root, 'beta.json') });
    });

    it('should show the placeholder until something is typed', async () => {
      const { ui } = open({ placeholder: 'a file' });

      await until(() => expect(screen(ui)).toContain('a file'));
      await type(ui.stdin, 'x');
      await until(() => expect(screen(ui)).not.toContain('a file'));
    });

    it('should leave only the question and the answer once answered', async () => {
      const { answer, ui } = open({}, 200);
      await type(ui.stdin, 'n', TAB, ENTER);
      await answer;

      expect(ui.log).toHaveLength(1);
      expect(ui.log[0]).toContain('notes.TXT');
    });
  });

  it('should refuse to prompt when the input is not a terminal', async () => {
    const ui = screenSetup({ inputTTY: false });

    await expect(path({ message: 'Pick?', terminal: ui.terminal })).rejects.toBeInstanceOf(
      PromptError
    );
  });
});
