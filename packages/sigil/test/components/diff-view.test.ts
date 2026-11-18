import { strip } from '../../src/ansi/index.js';
import { describeDiffView, DiffView, type DiffViewProps } from '../../src/components/diff-view.js';
import {
  type DiffBlock,
  type DiffViewContent,
  diffHunks,
  diffStops,
  diffView,
  hunkPatch,
  parsePatch,
} from '../../src/components/diff.js';
import type { Key } from '../../src/components/keys.js';
import { box, type Element, renderToLines } from '../../src/element/index.js';
import type { DescribeOptions, KeyEvent } from '../../src/input/index.js';
import { flush, State } from '../../src/signals/index.js';
import { themedCascade } from '../../src/theme/index.js';
import { describe, expect, it } from 'vitest';

/**
 * The diff view: `diffView()` in a scroll box, sized by it, with a cursor on the
 * hunks. Driven through the handlers a router would call, and drawn with
 * `renderToLines()`, which lays out and dispatches the resize the view draws from.
 * `ascii: false` everywhere, so the machine running this cannot choose the mark.
 */

/** The view as it is drawn, as rows: no colour and no trailing blanks. */
function picture(root: Element, width: number, height: number): string[] {
  return renderToLines(root, { cascade: themedCascade(), colorLevel: 0, height, width }).map(
    (line) => strip(line).trimEnd()
  );
}

/** A view in a box of a fixed height, which is what a pane gives it. */
function mount<T>(props: DiffViewProps<T>, height: number): { host: Element; root: Element } {
  const host = DiffView({
    ascii: false,
    lineNumbers: false,
    scrollbar: false,
    ...props,
    props: { 'flex-grow': 1, 'min-height': 0 },
  });
  return { host, root: box({ 'flex-direction': 'column', height }, host) };
}

/** A key event as the router builds one, with a record of whether it was stopped. */
function press(host: Element, name: string): boolean {
  let stopped = false;
  const key: Key = { ctrl: false, meta: false, name, sequence: '', shift: false };
  const event: KeyEvent = {
    current: undefined,
    key,
    paste: false,
    stop(): void {
      stopped = true;
    },
    get stopped() {
      return stopped;
    },
    target: undefined,
  };
  host.onKey?.(event);
  flush();
  return stopped;
}

/** Two hunks in one file, far enough apart to stay two. */
const PATCH = [
  'diff --git a/a.txt b/a.txt',
  'index 1111111..2222222 100644',
  '--- a/a.txt',
  '+++ b/a.txt',
  '@@ -1,3 +1,3 @@',
  ' one',
  '-two',
  '+TWO',
  ' three',
  '@@ -20,3 +20,3 @@',
  ' twenty',
  '-twenty-one',
  '+TWENTY-ONE',
  ' twenty-two',
  '',
].join('\n');

/** The rows whose mark is lit. */
function lit(rows: string[]): string[] {
  return rows.filter((row) => row.startsWith('▌')).map((row) => row.slice(1));
}

describe('DiffView', () => {
  it('should draw the diff behind a mark column, with the current hunk marked', () => {
    const { root } = mount({ content: { patch: PATCH } }, 14);

    expect(picture(root, 30, 14)).toEqual([
      ' --- a/a.txt',
      ' +++ b/a.txt',
      '▌@@ -1,3 +1,3 @@',
      '▌ one',
      '▌-two',
      '▌+TWO',
      '▌ three',
      ' @@ -20,3 +20,3 @@',
      '  twenty',
      ' -twenty-one',
      ' +TWENTY-ONE',
      '  twenty-two',
      '',
      '',
    ]);
  });

  it('should mark the current hunk in ASCII as well, which is what colour level 0 is left with', () => {
    const host = DiffView({ ascii: true, content: { patch: PATCH }, lineNumbers: false });
    const rows = picture(box({ 'flex-direction': 'column', height: 14 }, host), 30, 14);

    expect(rows.filter((row) => row.startsWith('>'))).toHaveLength(5);
  });

  it('should draw again when the layout gives the same view another width', () => {
    const long = { new: `${'x'.repeat(40)}\n`, old: `${'y'.repeat(40)}\n` };
    const { root } = mount({ content: long }, 6);

    expect(picture(root, 20, 6).filter((row) => row.includes('y')).length).toBeGreaterThan(1);
    expect(picture(root, 50, 6).filter((row) => row.includes('y'))).toHaveLength(1);
  });

  it('should draw again at the width the layout gives it', () => {
    const long = { new: `${'x'.repeat(40)}\n`, old: `${'y'.repeat(40)}\n` };
    const narrow = picture(mount({ content: long }, 6).root, 20, 6);
    const wide = picture(mount({ content: long }, 6).root, 50, 6);

    // folded to the width less the mark, and not folded where there is room
    expect(narrow.filter((row) => row.includes('y')).length).toBeGreaterThan(1);
    expect(wide.filter((row) => row.includes('y'))).toHaveLength(1);
    expect(Math.max(...narrow.map((row) => row.length))).toBeLessThanOrEqual(20);
  });

  it('should move the cursor with ] and [, and stop at the ends with the key still claimed', () => {
    const current = new State(0);
    const { host, root } = mount({ content: { patch: PATCH }, current }, 14);
    picture(root, 30, 14);

    expect(press(host, ']')).toBe(true);
    expect(current.get()).toBe(1);
    expect(lit(picture(root, 30, 14))[0]).toBe('@@ -20,3 +20,3 @@');
    expect(press(host, ']')).toBe(true);
    expect(current.get()).toBe(1);
    expect(press(host, '[')).toBe(true);
    expect(current.get()).toBe(0);
    expect(press(host, '[')).toBe(true);
    expect(current.get()).toBe(0);
  });

  it('should leave ] and [ alone where there is nothing to move over', () => {
    const { host, root } = mount({ content: [{ text: 'nothing here' }] }, 4);
    picture(root, 30, 4);

    expect(press(host, ']')).toBe(false);
  });

  it('should move the mark when the app writes the cursor', () => {
    const current = new State(0);
    const { root } = mount({ content: { patch: PATCH }, current }, 14);
    picture(root, 30, 14);

    current.set(1);
    flush();
    expect(lit(picture(root, 30, 14))).toEqual([
      '@@ -20,3 +20,3 @@',
      ' twenty',
      '-twenty-one',
      '+TWENTY-ONE',
      ' twenty-two',
    ]);
  });

  it('should scroll the current hunk into view, with what leads into it where it fits', () => {
    const current = new State(0);
    const { root } = mount({ content: { patch: PATCH }, current }, 7);
    // the first hunk and the file's header above it fit, so nothing scrolls
    expect(picture(root, 30, 7)[0]).toBe(' --- a/a.txt');

    // by as little as shows the second
    current.set(1);
    flush();
    expect(picture(root, 30, 7)).toEqual([
      ' +TWO',
      '  three',
      '▌@@ -20,3 +20,3 @@',
      '▌ twenty',
      '▌-twenty-one',
      '▌+TWENTY-ONE',
      '▌ twenty-two',
    ]);

    // back to the first, and the file's header above it is in view again
    current.set(0);
    flush();
    expect(picture(root, 30, 7)[0]).toBe(' --- a/a.txt');
  });

  it('should show a hunk from its own first row where it does not fit with its lead', () => {
    const { root } = mount({ content: { patch: PATCH } }, 5);

    expect(picture(root, 30, 5)).toEqual([
      '▌@@ -1,3 +1,3 @@',
      '▌ one',
      '▌-two',
      '▌+TWO',
      '▌ three',
    ]);
  });

  it('should scroll with the arrows, which it hands to its scroll box', () => {
    const { host, root } = mount({ content: { patch: PATCH } }, 7);
    picture(root, 30, 7);

    expect(press(host, 'down')).toBe(true);
    expect(picture(root, 30, 7)[0]).toBe(' +++ b/a.txt');
  });

  it('should draw again when the content changes, and bring a cursor past the end back', () => {
    const content = new State<DiffViewContent>({ patch: PATCH });
    const current = new State(1);
    const { root } = mount({ content, current }, 14);
    picture(root, 30, 14);

    content.set({ new: 'b\n', old: 'a\n' });
    flush();
    expect(current.get()).toBe(0);
    expect(lit(picture(root, 30, 14))).toEqual(['@@ -1 +1 @@', '-a', '+b']);
  });

  it('should mark the stop diffStops() finds at the cursor, whichever it is', () => {
    const blocks: DiffBlock<string>[] = [
      { text: 'Unstaged' },
      { data: 'patch', diff: { patch: PATCH } },
      { data: 'binary', stop: true, text: 'logo.png: binary' },
      { data: 'texts', diff: { new: 'b\n', old: 'a\n' } },
    ];
    const current = new State(0);
    const { root } = mount({ content: blocks, current }, 30);
    const stops = diffStops(blocks);

    expect(stops).toHaveLength(4);
    for (const [at, stop] of stops.entries()) {
      current.set(at);
      flush();
      const first = lit(picture(root, 30, 30))[0] ?? '';
      // a hunk's own header row, or the prose that is the stop
      expect(first.startsWith(stop.hunk ? `@@ -${stop.hunk.oldStart}` : 'logo.png')).toBe(true);
    }
  });

  it('should bring a cursor that is not a stop to the nearest one', () => {
    for (const [given, settled] of [
      [-1, 0],
      [1.4, 1],
      [7, 1],
    ] as const) {
      const current = new State<number>(given);
      const { root } = mount({ content: { patch: PATCH }, current }, 14);
      picture(root, 30, 14);
      expect(current.get()).toBe(settled);
    }
  });

  it('should bring a cursor the app writes between stops to the nearest, and mark it', () => {
    const current = new State(0);
    const { host, root } = mount({ content: { patch: PATCH }, current }, 14);
    picture(root, 30, 14);

    current.set(-1);
    flush();
    expect(current.get()).toBe(0);
    expect(lit(picture(root, 30, 14))[0]).toBe('@@ -1,3 +1,3 @@');

    current.set(7);
    flush();
    expect(current.get()).toBe(1);
    expect(lit(picture(root, 30, 14))[0]).toBe('@@ -20,3 +20,3 @@');
    // and a key from there steps from the stop it was brought to
    press(host, '[');
    expect(current.get()).toBe(0);

    // a key that arrives before the write was settled goes to the nearest stop, not past it
    current.set(-1);
    press(host, ']');
    expect(current.get()).toBe(0);
  });

  it('should put is-current on the marks of the current stop, for a theme to reach', () => {
    const { host, root } = mount({ content: { patch: PATCH } }, 14);
    picture(root, 30, 14);
    const marks: Element[] = [];
    const walk = (at: Element): void => {
      if (at.classes.includes('sigil-diff-view-mark') && at.classes.includes('is-current')) {
        marks.push(at);
      }
      at.children.forEach(walk);
    };
    walk(host);

    expect(marks).toHaveLength(5);
  });

  it('should draw prose between diffs, and stop on prose marked as a stop', () => {
    const blocks: DiffBlock<string>[] = [
      { class: 'sigil-heading', data: 'heading', text: 'Unstaged' },
      { data: 'patch', diff: { patch: PATCH } },
      { data: 'binary', stop: true, text: 'logo.png: binary' },
    ];
    const current = new State(2);
    const { root } = mount({ content: blocks, current }, 18);
    const rows = picture(root, 30, 18);

    expect(rows[0]).toBe(' Unstaged');
    expect(lit(rows)).toEqual(['logo.png: binary']);
    expect(diffStops(blocks).map((stop) => stop.block.data)).toEqual(['patch', 'patch', 'binary']);
  });

  it('should cut a line of prose at the width rather than wrap it', () => {
    const { root } = mount({ content: [{ text: 'a line that is longer than the view' }] }, 2);

    expect(picture(root, 12, 2)[0]).toBe(' a line tha…');
  });

  describe('a line too long for the view', () => {
    /** 45 columns of words, against a view whose rows hold 18 of them. */
    const LONG = { new: 'alpha beta gamma delta epsilon zeta eta theta\n', old: 'a\n' };

    it('should wrap at words, and keep each line on one row once w is pressed', () => {
      const { host, root } = mount({ content: LONG }, 6);

      expect(picture(root, 20, 6)).toEqual([
        '▌@@ -1 +1 @@',
        '▌-a',
        '▌+alpha beta gamma',
        '▌ delta epsilon zeta',
        '▌ eta theta',
        '',
      ]);
      expect(press(host, 'w')).toBe(true);
      expect(picture(root, 20, 6).slice(0, 3)).toEqual([
        '▌@@ -1 +1 @@',
        '▌-a',
        '▌+alpha beta gamma …',
      ]);
      press(host, 'w');
      expect(picture(root, 20, 6)[4]).toBe('▌ eta theta');
    });

    it('should scroll every line sideways with the arrows, eight columns a press, to the end', () => {
      const { host, root } = mount({ content: LONG, wrap: false }, 4);
      picture(root, 20, 4);

      expect(press(host, 'right')).toBe(true);
      expect(picture(root, 20, 4)[2]).toBe('▌+ta gamma delta ep…');
      press(host, 'right');
      press(host, 'right');
      press(host, 'right');
      // as far as the end of the line, which is then drawn whole
      expect(picture(root, 20, 4)[2]).toBe('▌+lon zeta eta theta');
      // claimed at the end as well, as Home is at the top
      expect(press(host, 'right')).toBe(true);
      expect(picture(root, 20, 4)[2]).toBe('▌+lon zeta eta theta');
      press(host, 'left');
      press(host, 'left');
      press(host, 'left');
      expect(press(host, 'left')).toBe(true);
      expect(picture(root, 20, 4)[2]).toBe('▌+alpha beta gamma …');
    });

    it('should leave the left and right arrows alone while wrapping, and where every line fits', () => {
      const wrapped = mount({ content: LONG }, 4);
      picture(wrapped.root, 20, 4);
      expect(press(wrapped.host, 'right')).toBe(false);

      const short = mount({ content: { new: 'b\n', old: 'a\n' }, wrap: false }, 4);
      picture(short.root, 20, 4);
      expect(press(short.host, 'right')).toBe(false);
      expect(press(short.host, 'left')).toBe(false);
    });

    it('should keep the rows where they are when it scrolls sideways', () => {
      const many = {
        new: Array.from({ length: 20 }, (_, at) => `${'x'.repeat(30)} ${at}`).join('\n'),
        old: '',
      };
      const { host, root } = mount({ content: many, lineNumbers: true, wrap: false }, 5);
      picture(root, 24, 5);
      for (let at = 0; at < 8; at++) {
        press(host, 'down');
      }
      const top = picture(root, 24, 5)[0]!.slice(0, 7);

      press(host, 'right');
      // the same line at the top, not the current hunk's header brought back
      expect(picture(root, 24, 5)[0]!.slice(0, 7)).toBe(top);
      expect(top).toMatch(/\d/);
    });

    it('should start the lines from their beginning again when wrapping is switched', () => {
      const { host, root } = mount({ content: LONG, wrap: false }, 4);
      picture(root, 20, 4);
      press(host, 'right');
      press(host, 'w');
      press(host, 'w');

      expect(picture(root, 20, 4)[2]).toBe('▌+alpha beta gamma …');
    });

    it('should take wrap as a State, which w writes and the app writes', () => {
      const wrap = new State(false);
      const { host, root } = mount({ content: LONG, wrap }, 6);
      expect(picture(root, 20, 6)[2]).toBe('▌+alpha beta gamma …');

      wrap.set(true);
      flush();
      expect(picture(root, 20, 6)[3]).toBe('▌ delta epsilon zeta');
      press(host, 'w');
      expect(wrap.get()).toBe(false);
    });

    it('should bring the sideways scroll back when the content narrows', () => {
      const content = new State<DiffViewContent>(LONG);
      const { host, root } = mount({ content, wrap: false }, 4);
      picture(root, 20, 4);
      press(host, 'right');
      press(host, 'right');
      press(host, 'right');

      content.set({ new: 'abcdefghijklmnopqrstuvwxyz\n', old: 'a\n' });
      flush();
      expect(picture(root, 20, 4)[2]).toBe('▌+ijklmnopqrstuvwxyz');
    });

    it('should refuse a wrap that is not a boolean or a State', () => {
      expect(() => DiffView({ content: LONG, wrap: 'yes' as never })).toThrow(/boolean or a State/);
    });
  });

  it('should refuse an onKey in its props, which is its own', () => {
    expect(() =>
      DiffView({ content: { patch: PATCH }, props: { onKey: () => {} } as never })
    ).toThrow(/onKey/);
  });

  it('should refuse a cursor that is not a whole number or a State', () => {
    expect(() => DiffView({ content: { patch: PATCH }, current: 1.5 })).toThrow(/whole number/);
  });
});

describe('diffStops()', () => {
  it('should find every hunk the view draws, in its order, as a patch of its own away', () => {
    const stops = diffStops({ patch: PATCH });

    expect(stops.map((stop) => stop.hunk?.oldStart)).toEqual([1, 20]);
    expect(hunkPatch(stops[1]!.file!, stops[1]!.hunk!)).toBe(
      [
        'diff --git a/a.txt b/a.txt',
        'index 1111111..2222222 100644',
        '--- a/a.txt',
        '+++ b/a.txt',
        '@@ -20,3 +20,3 @@',
        ' twenty',
        '-twenty-one',
        '+TWENTY-ONE',
        ' twenty-two',
        '',
      ].join('\n')
    );
  });

  it('should count what diffView() draws, a file with no hunk not at all', () => {
    const patch = `${PATCH}diff --git a/logo.png b/logo.png\nBinary files a/logo.png and b/logo.png differ\n`;

    expect(diffStops({ files: parsePatch(patch) })).toHaveLength(
      diffView({ patch }, { width: 40 }).hunks.length
    );
    expect(diffStops({ patch })).toHaveLength(2);
  });

  it('should count two texts with the default context, as the view draws them', () => {
    const old = Array.from({ length: 20 }, (_, i) => `${i}`).join('\n');
    const next = old.replace('2', 'two').replace('17', 'seventeen');
    const stops = diffStops({ new: next, old });

    // two hunks at the default context, one at ten: the view draws the two
    expect(stops).toHaveLength(2);
    const current = new State(0);
    const { host, root } = mount({ content: { new: next, old }, current }, 30);
    picture(root, 30, 30);
    press(host, ']');
    expect(current.get()).toBe(1);
    const hunk = stops[1]!.hunk!;
    expect(lit(picture(root, 30, 30))[0]).toBe(
      `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`
    );

    // another context is hunks handed over as files, which both count as they are
    const files = [{ hunks: diffHunks(old, next, { context: 10 }) }];
    expect(diffStops({ files })).toHaveLength(1);
  });
});

describe('describeDiffView()', () => {
  it('should describe the hunk keys and the scroll keys, scoped to the view', () => {
    const said: [string, DescribeOptions][] = [];
    const host = DiffView({ content: { patch: PATCH } });
    const off = describeDiffView(
      {
        describe: (keys, opts) => {
          said.push([keys, opts]);
          return () => {};
        },
      },
      host
    );

    expect(said.map(([keys, opts]) => [keys, opts.description])).toEqual([
      [']', 'next hunk'],
      ['[', 'previous hunk'],
      ['w', 'wrap'],
      ['up', 'scroll'],
      ['down', 'scroll'],
      ['left', 'scroll sideways'],
      ['right', 'scroll sideways'],
    ]);
    expect(said.every(([, opts]) => opts.scope === host)).toBe(true);
    off();
  });

  it('should refuse an element DiffView() did not build', () => {
    expect(() => describeDiffView({ describe: () => () => {} }, box())).toThrow(/DiffView/);
  });
});
