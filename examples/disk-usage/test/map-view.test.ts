import { CATEGORIES } from '../src/disk.ts';
import { categoryColor, gatheredCategory, MapView } from '../src/map-view.ts';
import type { DiskNode } from '../src/scan.ts';
import { runApp } from '@ttylabs/sigil/app';
import { DEFAULT_COLOR, palette } from '@ttylabs/sigil/canvas';
import { State } from '@ttylabs/sigil/signals';
import { createTestTerminal, frame } from '@ttylabs/sigil/testing';
import { join, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The map on its own, with nothing beside it. In the app every change the map
 * shows also changes a line of text, and a frame paints the whole tree once
 * anything changed -- so the app's own tests cannot tell whether the map repaints
 * for what it reads or only for what its neighbours do (SIG-477). Here nothing
 * else is on screen, so the signal the map's paint read is the only thing that
 * moved.
 */

const ROOT = join(sep, 'root');

/** A file of `bytes` in the root. */
function file(name: string, bytes: number): DiskNode {
  return {
    bytes,
    category: 'code',
    files: 1,
    kind: 'file',
    name,
    path: join(ROOT, name),
    size: bytes,
  };
}

/** Two files of one size, side by side. */
const TREE: DiskNode = {
  bytes: 1000,
  category: 'code',
  children: [file('a.ts', 500), file('b.ts', 500)],
  files: 2,
  kind: 'directory',
  mix: CATEGORIES.map((category) => (category === 'code' ? 1000 : 0)),
  name: 'root',
  path: ROOT,
  size: 0,
};

/** Mounts a map over the signals it is handed, on a terminal of its own. */
function mountMap(props: {
  message: State<string>;
  root: State<DiskNode | undefined>;
  selected: State<string | undefined>;
}) {
  const term = createTestTerminal({ colorLevel: 0, columns: 20, rows: 6 });
  const app = runApp(
    () =>
      MapView({ message: () => props.message.get(), root: props.root, selected: props.selected }),
    { detect: false, mouse: false, terminal: term.terminal }
  );
  return { app, term };
}

describe('MapView', () => {
  it('should repaint when only the message it shows has changed', async () => {
    const message = new State('Scanning...');
    const { app, term } = mountMap({
      message,
      root: new State<DiskNode | undefined>(undefined),
      selected: new State<string | undefined>(undefined),
    });
    await frame(app);
    expect(term.viewport.join('\n')).toContain('Scanning...');

    message.set('Nothing here');
    await frame(app);

    expect(term.viewport.join('\n')).toContain('Nothing here');
    expect(term.viewport.join('\n')).not.toContain('Scanning');
    app.exit(0);
    await app.exited;
  });

  it('should repaint when only the selection has moved', async () => {
    const selected = new State<string | undefined>(join(ROOT, 'a.ts'));
    const { app, term } = mountMap({
      message: new State(''),
      root: new State<DiskNode | undefined>(TREE),
      selected,
    });
    await frame(app);
    const before = term.viewport.join('\n');

    selected.set(join(ROOT, 'b.ts'));
    await frame(app);

    expect(term.viewport.join('\n')).not.toBe(before);
    // and back: the outline is where the selection is, not where it has been
    selected.set(join(ROOT, 'a.ts'));
    await frame(app);
    expect(term.viewport.join('\n')).toBe(before);
    app.exit(0);
    await app.exited;
  });
});

describe('categoryColor()', () => {
  it('should give each category a colour of its own at every level with colour', () => {
    for (const level of [1, 2, 3] as const) {
      const colours = CATEGORIES.map((category) => categoryColor(category, level));
      expect(new Set(colours).size, `level ${level}`).toBe(CATEGORIES.length);
      // the selection is bright white, which no category is at 16 colours
      if (level === 1) {
        expect(colours).not.toContain(palette(15));
      }
    }
  });

  it("should be the terminal's own at level 0", () => {
    expect(categoryColor('code', 0)).toBe(DEFAULT_COLOR);
  });
});

describe('gatheredCategory()', () => {
  it('should count each kind a gathered directory holds, not only the kind it mostly is', () => {
    // the directory is mostly code, and so is the pair counted whole -- but by
    // what is in them, there is more image than code
    const mixed: DiskNode = {
      bytes: 11,
      category: 'code',
      children: [],
      files: 2,
      kind: 'directory',
      mix: CATEGORIES.map((c) => (c === 'code' ? 6 : c === 'image' ? 5 : 0)),
      name: 'mixed',
      path: join(ROOT, 'mixed'),
      size: 0,
    };
    const picture: DiskNode = { ...file('photo.png', 7), category: 'image' };
    expect(gatheredCategory([mixed, picture])).toBe('image');
  });
});
