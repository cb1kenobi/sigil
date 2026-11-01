import { outline } from '../../src/components/outline.js';
import { PROMPT_SYMBOLS, PromptError } from '../../src/components/prompt.js';
import {
  directoryTree,
  selectTree,
  type SelectTreeOptions,
  tree,
  type TreeChoiceItem,
  treeGlyphs,
} from '../../src/components/tree.js';
import { type ScreenHarness, screenSetup, tick } from './helpers.js';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, sep } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/** A `readdir` that can be watched, for `file-picker.test.ts`'s reason. */
const spy = vi.hoisted(() => ({ calls: [] as string[] }));

vi.mock('node:fs/promises', async (original) => {
  const actual = await original<typeof import('node:fs/promises')>();
  return {
    ...actual,
    readdir: (async (dir: string, ...rest: unknown[]) => {
      spy.calls.push(String(dir));
      return (actual.readdir as (...args: unknown[]) => unknown)(dir, ...rest);
    }) as unknown as typeof actual.readdir,
  };
});

const ENTER = '\r';
const UP = '\u001b[A';
const DOWN = '\u001b[B';
const RIGHT = '\u001b[C';
const LEFT = '\u001b[D';
const END = '\u001b[F';
const SPACE = ' ';
const CTRL_C = '\u0003';

/** A terminal that draws box drawing, and a width that does not depend on the machine. */
const HERE = { env: {}, platform: 'linux', width: 40 };

const SRC = {
  items: [
    'index.ts',
    { items: ['argv.ts', 'tokens.ts'], text: 'parser' },
    { items: ['screen.ts'], text: 'help' },
  ],
  text: 'src',
};

describe('tree()', () => {
  it('should hang a root’s children from the margin with plain guides', () => {
    expect(tree(SRC, HERE)).toBe(
      [
        'src',
        '├── index.ts',
        '├── parser',
        '│   ├── argv.ts',
        '│   └── tokens.ts',
        '└── help',
        '    └── screen.ts',
      ].join('\n')
    );
  });

  it('should start a list at the margin, with no root line', () => {
    expect(tree(SRC.items, HERE).split('\n')[0]).toBe('├── index.ts');
  });

  it('should end each list with ╰── when the guide is rounded', () => {
    expect(tree(SRC, { ...HERE, guide: 'rounded' })).toBe(
      [
        'src',
        '├── index.ts',
        '├── parser',
        '│   ├── argv.ts',
        '│   ╰── tokens.ts',
        '╰── help',
        '    ╰── screen.ts',
      ].join('\n')
    );
  });

  it('should draw ASCII where the terminal cannot be trusted with box drawing', () => {
    const expected = [
      'src',
      '|-- index.ts',
      '|-- parser',
      '|   |-- argv.ts',
      '|   `-- tokens.ts',
      '`-- help',
      '    `-- screen.ts',
    ].join('\n');

    expect(tree(SRC, { ...HERE, ascii: true })).toBe(expected);
    expect(tree(SRC, { ...HERE, env: { TERM: 'dumb' } })).toBe(expected);
    // both guides are the same lines in ASCII: there is no rounded corner to draw
    expect(tree(SRC, { ...HERE, ascii: true, guide: 'rounded' })).toBe(expected);
  });

  it('should refuse a guide it does not know', () => {
    expect(() => tree(SRC, { ...HERE, guide: 'heavy' as 'plain' })).toThrow(
      'Unknown tree guide heavy'
    );
    expect(() => treeGlyphs('heavy' as 'plain')).toThrow('Unknown tree guide heavy');
  });

  it('should carry the guide down beside an item that wraps', () => {
    const items = [{ items: ['a name that is far too long for one line'], text: 'first' }, 'last'];

    expect(tree(items, { ...HERE, width: 24 })).toBe(
      [
        '├── first',
        '│   └── a name that is',
        '│       far too long for',
        '│       one line',
        '└── last',
      ].join('\n')
    );
  });

  it('should take outline()’s enumerator after the guide, cycling by depth', () => {
    expect(tree(SRC.items, { ...HERE, enumerator: ['arabic', 'alpha'] })).toBe(
      [
        '├── 1. index.ts',
        '├── 2. parser',
        '│   ├── a. argv.ts',
        '│   └── b. tokens.ts',
        '└── 3. help',
        '    └── a. screen.ts',
      ].join('\n')
    );
  });

  it('should right-align counting markers within a list, as outline() does', () => {
    const items = Array.from({ length: 10 }, (_, i) => `step ${i + 1}`);
    const lines = tree(items, { ...HERE, enumerator: 'arabic' }).split('\n');

    expect(lines[8]).toBe('├──  9. step 9');
    expect(lines[9]).toBe('└── 10. step 10');
  });

  it('should hand a function enumerator what outline() hands it', () => {
    const seen: unknown[] = [];
    tree(SRC.items, {
      ...HERE,
      enumerator: (info) => {
        seen.push(info);
        return '*';
      },
    });

    expect(seen[0]).toEqual({ count: 3, depth: 0, index: 0, item: 'index.ts' });
    expect(seen).toContainEqual({ count: 2, depth: 1, index: 1, item: 'tokens.ts' });
  });

  it('should refuse a malformed item with outline()’s words', () => {
    const bad = [{ items: [42] }] as never;
    let words = '';
    try {
      outline(bad);
    } catch (err) {
      words = (err as Error).message;
    }

    expect(words).not.toBe('');
    expect(() => tree(bad, HERE)).toThrow(words);
  });

  it('should drop escape sequences from the text', () => {
    expect(tree(['\u001b[31mred\u001b[39m'], HERE)).toBe('└── red');
  });

  it('should be empty for an empty list, and a lone line for a root with nothing under it', () => {
    expect(tree([], HERE)).toBe('');
    expect(tree({ text: 'alone' }, HERE)).toBe('alone');
  });

  it('should indent the whole block', () => {
    expect(tree(['a'], { ...HERE, indent: 2 })).toBe('  └── a');
  });
});

/** Sends keys one at a time, letting the prompt act on each. */
async function type(ui: ScreenHarness, ...chunks: string[]): Promise<void> {
  for (const chunk of chunks) {
    ui.stdin.send(chunk);
    await tick();
  }
}

/** Waits for a promise the prompt is holding, which a `tick()` does not. */
async function until(check: () => void): Promise<void> {
  await vi.waitFor(check, { interval: 5, timeout: 2000 });
}

/** The rows under the question, with the pointer column taken off. */
function rows(ui: ScreenHarness): string[] {
  return ui.log.slice(1).map((line) => line.slice(2));
}

/** The highlighted row, pointer column taken off. */
function highlighted(ui: ScreenHarness): string | undefined {
  return ui.log
    .find((line) => line.startsWith(PROMPT_SYMBOLS.cursor))
    ?.slice(2)
    .trim();
}

function settle<T>(promise: Promise<T>): Promise<{ error?: unknown; value?: T }> {
  return promise.then(
    (value) => ({ value }),
    (error: unknown) => ({ error })
  );
}

function ask<T = string>(
  items: SelectTreeOptions<T>['items'],
  opts: Partial<SelectTreeOptions<T>> = {},
  size: { columns?: number; rows?: number } = {}
) {
  const ui = screenSetup({ columns: size.columns ?? 60, rows: size.rows ?? 12 });
  const answer = settle(
    selectTree<T>({
      ansi: ui.ansi,
      env: {},
      items,
      message: 'Pick?',
      platform: 'linux',
      terminal: ui.terminal,
      ...opts,
    })
  );
  return { answer, ui };
}

describe('selectTree()', () => {
  it('should open with every branch closed', async () => {
    const { ui } = ask(SRC.items);
    await tick(3);

    expect(rows(ui)).toEqual(['├──   index.ts', '├── ▸ parser', '└── ▸ help']);
    expect(highlighted(ui)).toBe('├──   index.ts');
    ui.stdin.send(CTRL_C);
  });

  it('should draw a root bare, with its children hung from the margin', async () => {
    const { ui } = ask({ ...SRC, expanded: true });
    await tick(3);

    expect(rows(ui)).toEqual(['▾ src', '├──   index.ts', '├── ▸ parser', '└── ▸ help']);
    ui.stdin.send(CTRL_C);
  });

  it('should open on Right, step in on a second Right, and come back out on Left', async () => {
    const { ui } = ask(SRC.items);
    await tick(3);

    await type(ui, DOWN, RIGHT);
    expect(rows(ui)).toEqual([
      '├──   index.ts',
      '├── ▾ parser',
      '│   ├──   argv.ts',
      '│   └──   tokens.ts',
      '└── ▸ help',
    ]);
    expect(highlighted(ui)).toBe('├── ▾ parser');

    await type(ui, RIGHT);
    expect(highlighted(ui)).toBe('│   ├──   argv.ts');

    // Left on a leaf goes to the parent, and Left on an open branch closes it
    await type(ui, LEFT);
    expect(highlighted(ui)).toBe('├── ▾ parser');
    await type(ui, LEFT);
    expect(rows(ui)).toEqual(['├──   index.ts', '├── ▸ parser', '└── ▸ help']);
    ui.stdin.send(CTRL_C);
  });

  it('should toggle a branch on Space', async () => {
    const { ui } = ask(SRC.items);
    await tick(3);

    await type(ui, END, SPACE);
    expect(rows(ui)).toContain('    └──   screen.ts');
    await type(ui, SPACE);
    expect(rows(ui)).not.toContain('    └──   screen.ts');
    ui.stdin.send(CTRL_C);
  });

  it('should answer with the text of a string node, and the value of an object one', async () => {
    const first = ask(SRC.items);
    await tick(3);
    await type(first.ui, DOWN, ENTER);
    expect(await first.answer).toEqual({ value: 'parser' });
    expect(first.ui.log).toEqual(['? Pick? parser']);

    const second = ask<number>([
      { text: 'one', value: 1 },
      { text: 'two', value: 2 },
    ]);
    await tick(3);
    await type(second.ui, UP, ENTER);
    expect(await second.answer).toEqual({ value: 2 });
  });

  it('should open a branch on Enter rather than answer it, with leaves', async () => {
    const { answer, ui } = ask(SRC.items, { leaves: true });
    await tick(3);

    await type(ui, DOWN, ENTER);
    expect(rows(ui)).toContain('│   ├──   argv.ts');
    await type(ui, DOWN, ENTER);
    expect(await answer).toEqual({ value: 'argv.ts' });
  });

  it('should not call a function for children until its branch first opens, and then only once', async () => {
    const load = vi.fn(async () => ['late.ts']);
    const { ui } = ask([{ items: load, text: 'lazy' }]);
    await tick(3);
    expect(load).not.toHaveBeenCalled();

    await type(ui, RIGHT);
    await until(() => expect(rows(ui)).toEqual(['└── ▾ lazy', '    └──   late.ts']));

    await type(ui, LEFT, RIGHT);
    expect(rows(ui)).toEqual(['└── ▾ lazy', '    └──   late.ts']);
    expect(load).toHaveBeenCalledTimes(1);
    ui.stdin.send(CTRL_C);
  });

  it('should land a Down typed behind a Right on the first child of what it opened', async () => {
    let release: () => void = () => {};
    const held = new Promise<void>((done) => {
      release = done;
    });
    const { answer, ui } = ask([
      {
        items: async () => {
          await held;
          return ['child'];
        },
        text: 'slow',
      },
      'after',
    ]);
    await tick(3);

    await type(ui, RIGHT, DOWN, ENTER);
    expect(rows(ui)[0]).toContain('slow');
    release();

    expect(await answer).toEqual({ value: 'child' });
  });

  it('should not hold Left behind a branch that is slow to read', async () => {
    let release: () => void = () => {};
    const held = new Promise<void>((done) => {
      release = done;
    });
    const { ui } = ask([
      {
        items: async () => {
          await held;
          return ['child'];
        },
        text: 'slow',
      },
    ]);
    await tick(3);

    await type(ui, RIGHT);
    await until(() => expect(rows(ui)).toEqual(['└── ▾ slow …']));
    await type(ui, LEFT);
    await until(() => expect(rows(ui)).toEqual(['└── ▸ slow']));

    release();
    ui.stdin.send(CTRL_C);
  });

  it('should close a branch whose function throws, say why, and ask again on the next Right', async () => {
    let calls = 0;
    const { ui } = ask([
      {
        items: () => {
          calls += 1;
          if (calls === 1) {
            throw new Error('permission denied');
          }
          return ['now.ts'];
        },
        text: 'flaky',
      },
    ]);
    await tick(3);

    await type(ui, RIGHT);
    await until(() => expect(ui.log.join('\n')).toContain('permission denied'));
    expect(ui.log.join('\n')).toContain('▸ flaky');

    await type(ui, RIGHT);
    await until(() => expect(rows(ui)).toEqual(['└── ▾ flaky', '    └──   now.ts']));
    expect(ui.log.join('\n')).not.toContain('permission denied');
    expect(calls).toBe(2);
    ui.stdin.send(CTRL_C);
  });

  it('should show a window over what is open, and follow the highlight', async () => {
    const many: TreeChoiceItem[] = Array.from({ length: 30 }, (_, i) => `n${i}`);
    const { ui } = ask([{ expanded: true, items: many, text: 'big' }], {}, { rows: 6 });
    await tick(3);

    expect(rows(ui)).toHaveLength(5);
    expect(rows(ui)[0]).toBe('└── ▾ big');

    await type(ui, END);
    expect(rows(ui)).toHaveLength(5);
    expect(highlighted(ui)).toBe('└──   n29');
    expect(rows(ui)).not.toContain('└── ▾ big');
    ui.stdin.send(CTRL_C);
  });

  it('should wrap the highlight unless loop is off', async () => {
    const looped = ask(['a', 'b']);
    await tick(3);
    await type(looped.ui, UP);
    expect(highlighted(looped.ui)).toBe('└──   b');
    looped.ui.stdin.send(CTRL_C);

    const held = ask(['a', 'b'], { loop: false });
    await tick(3);
    await type(held.ui, UP);
    expect(highlighted(held.ui)).toBe('├──   a');
    held.ui.stdin.send(CTRL_C);
  });

  it('should keep the answer back when validate says no', async () => {
    const { answer, ui } = ask(['nope', 'yes'], {
      validate: (value) => (value === 'nope' ? 'Not that one' : undefined),
    });
    await tick(3);

    await type(ui, ENTER);
    expect(ui.log.join('\n')).toContain('Not that one');
    await type(ui, DOWN, ENTER);
    expect(await answer).toEqual({ value: 'yes' });
  });

  it('should reject when there is nothing to offer, or nobody to answer', async () => {
    await expect(selectTree({ items: [], message: 'Pick?' })).rejects.toBeInstanceOf(PromptError);

    const ui = screenSetup({ inputTTY: false });
    await expect(
      selectTree({ items: ['a'], message: 'Pick?', terminal: ui.terminal })
    ).rejects.toThrow('not a terminal');
  });

  it('should draw ASCII guides and toggles where box drawing is not safe', async () => {
    const { ui } = ask(SRC.items, { ascii: true });
    await tick(3);

    await type(ui, DOWN, RIGHT);
    expect(rows(ui)).toEqual([
      '|--   index.ts',
      '|-- - parser',
      '|   |--   argv.ts',
      '|   `--   tokens.ts',
      '`-- + help',
    ]);
    ui.stdin.send(CTRL_C);
  });
});

describe('directoryTree()', () => {
  let root: string;

  /**
   *   alpha/ (inner.txt, deep/ (leaf.txt))   src/ (index.ts)
   *   beta.json   notes.md   .hidden/   .env
   */
  beforeEach(async () => {
    spy.calls.length = 0;
    root = await mkdtemp(join(tmpdir(), 'sigil-tree-'));
    await mkdir(join(root, 'alpha', 'deep'), { recursive: true });
    await mkdir(join(root, 'src'));
    await mkdir(join(root, '.hidden'));
    for (const file of [
      'beta.json',
      'notes.md',
      '.env',
      join('alpha', 'inner.txt'),
      join('alpha', 'deep', 'leaf.txt'),
      join('src', 'index.ts'),
    ]) {
      await writeFile(join(root, file), '');
    }
  });

  afterEach(async () => {
    await rm(root, { force: true, recursive: true });
  });

  function browse(opts: Record<string, unknown> = {}) {
    const ui = screenSetup({ columns: 80, rows: 14 });
    const answer = settle(
      directoryTree({
        ansi: ui.ansi,
        env: {},
        message: 'Pick?',
        platform: 'linux',
        root,
        terminal: ui.terminal,
        ...opts,
      })
    );
    return { answer, ui };
  }

  it('should open on the root, directories first and dotfiles left out', async () => {
    const { ui } = browse();
    await until(() =>
      expect(rows(ui)).toEqual([
        `▾ ${basename(root)}${sep}`,
        `├── ▸ alpha${sep}`,
        `├── ▸ src${sep}`,
        '├──   beta.json',
        '└──   notes.md',
      ])
    );
    ui.stdin.send(CTRL_C);
  });

  it('should read a directory only when it is opened', async () => {
    const { ui } = browse();
    await until(() => expect(rows(ui)).toHaveLength(5));
    expect(spy.calls).toEqual([root]);

    await type(ui, DOWN, ENTER);
    await until(() => expect(rows(ui)).toContain(`│   ├── ▸ deep${sep}`));
    expect(spy.calls).toEqual([root, join(root, 'alpha')]);
    ui.stdin.send(CTRL_C);
  });

  it('should open a directory on Enter and answer a file with its absolute path', async () => {
    const { answer, ui } = browse({ extensions: ['txt'] });
    await until(() => expect(rows(ui)).toHaveLength(3));

    await type(ui, DOWN, ENTER);
    await until(() => expect(rows(ui)).toContain('│   └──   inner.txt'));
    await type(ui, DOWN, DOWN, ENTER);

    expect(await answer).toEqual({ value: join(root, 'alpha', 'inner.txt') });
  });

  it('should list only directories and answer one, the root included, with directory', async () => {
    const first = browse({ directory: true });
    await until(() =>
      expect(rows(first.ui)).toEqual([
        `▾ ${basename(root)}${sep}`,
        `├── ▸ alpha${sep}`,
        `└── ▸ src${sep}`,
      ])
    );
    await type(first.ui, DOWN, ENTER);
    expect(await first.answer).toEqual({ value: join(root, 'alpha') });

    const second = browse({ directory: true });
    await until(() => expect(rows(second.ui)).toHaveLength(3));
    await type(second.ui, ENTER);
    expect(await second.answer).toEqual({ value: root });
  });

  it('should list dotfiles when asked', async () => {
    const { ui } = browse({ hidden: true });
    await until(() => expect(rows(ui).join('\n')).toContain('.env'));
    expect(rows(ui).join('\n')).toContain(`.hidden${sep}`);
    ui.stdin.send(CTRL_C);
  });
});
