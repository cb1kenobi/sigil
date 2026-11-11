import { strip } from '../../src/ansi/index.js';
import type { Key } from '../../src/components/keys.js';
import {
  createPager,
  MAX_MATCHES,
  page,
  type PagerOptions,
  pagerLines,
  searchLines,
  softWrap,
} from '../../src/components/pager.js';
import { scrollControl } from '../../src/components/scroll-box.js';
import { Element, renderToLines, scrollRange } from '../../src/element/index.js';
import { __, loadCatalog } from '../../src/i18n/index.js';
import { createInput, type KeyEvent } from '../../src/input/index.js';
import { createTestTerminal, ctrl, KEYS } from '../../src/testing/index.js';
import { themedCascade } from '../../src/theme/index.js';
import { stringWidth } from '../../src/width/index.js';
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * The pager: a document in a scroll box, with a keymap, a gutter and a search.
 *
 * The element is driven the way the scroll box's own tests drive theirs --
 * through the handler the router would call, over a tree `renderToLines()` laid
 * out -- and `page()` through a test terminal, because what it adds is the screen
 * and the keyboard.
 */

afterEach(async () => {
  await loadCatalog(undefined, {});
});

const ESC = String.fromCharCode(0x1b);

/** Thirty lines, every third one long enough to fold at twenty columns. */
const DOC = Array.from({ length: 30 }, (_, i) =>
  i % 3 === 0 ? `line ${i + 1} alpha beta gamma delta` : `line ${i + 1}`
).join('\n');

/** A pager laid out at a size, and a way to lay it out again and read it. */
function laid(
  opts: Partial<PagerOptions> = {},
  size: { height?: number; width?: number } = {}
): {
  draw: (width?: number, colorLevel?: 0 | 1) => string[];
  key: (name: string, mods?: Partial<Key>) => boolean;
  pager: ReturnType<typeof createPager>;
  top: () => number;
  viewport: Element;
} {
  const height = size.height ?? 6;
  const pager = createPager({ content: DOC, ...opts, props: { height, ...opts.props } });
  let last = size.width ?? 24;
  const draw = (width = last, colorLevel: 0 | 1 = 0): string[] => {
    last = width;
    return renderToLines(pager.element, {
      cascade: themedCascade(),
      colorLevel,
      height,
      width,
    });
  };
  draw();
  const key = (name: string, mods: Partial<Key> = {}): boolean => {
    const event = keyEvent(name, mods);
    pager.element.onKey?.(event);
    draw();
    return event.claimed();
  };
  const { viewport } = scrollControl(pager.element.children[0]!)!;
  return { draw, key, pager, top: () => viewport.scroll?.y ?? 0, viewport };
}

/** A key event as the router builds one, with a record of whether it was stopped. */
function keyEvent(name: string, mods: Partial<Key> = {}): KeyEvent & { claimed: () => boolean } {
  let stopped = false;
  const key: Key = { ctrl: false, meta: false, name, sequence: '', shift: false, ...mods };
  return {
    claimed: () => stopped,
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
}

/** `Element.parent` as the prototype defines it, for reading past a shadowed one. */
const PARENT = Object.getOwnPropertyDescriptor(Element.prototype, 'parent')!.get! as (
  this: Element
) => Element | undefined;

/** The pager's row elements currently in the tree, in document order. */
function pagerRows(root: Element): Element[] {
  const out: Element[] = [];
  const walk = (element: Element): void => {
    if (element.classes.includes('sigil-pager-line')) {
      out.push(element);
      return;
    }
    for (const child of element.children) {
      walk(child);
    }
  };
  walk(root);
  return out;
}

/** Types a search the way a reader does: `/`, the query, Enter. */
function type(key: (name: string) => boolean, query: string): void {
  key('/');
  for (const char of query) {
    key(char === ' ' ? 'space' : char);
  }
  key('enter');
}

/** The status line's message: the last row, without the position at its end. */
function status(lines: string[]): string {
  return (lines.at(-1) ?? '').replace(/\s*\d+%$/, '').trim();
}

describe('pagerLines()', () => {
  it('should read one trailing newline as a terminator rather than an empty line', () => {
    expect(pagerLines('a\nb\n')).to.deep.equal(['a', 'b']);
    expect(pagerLines('a\nb\n\n')).to.deep.equal(['a', 'b', '']);
    expect(pagerLines('a\r\nb')).to.deep.equal(['a', 'b']);
    expect(pagerLines('')).to.deep.equal(['']);
  });

  it('should strip escape sequences rather than show them', () => {
    expect(pagerLines(`${ESC}[31mred${ESC}[0m plain`)).to.deep.equal(['red plain']);
  });

  it('should expand a tab to the next stop of eight columns', () => {
    expect(pagerLines('a\tb')).to.deep.equal([`a${' '.repeat(7)}b`]);
    expect(pagerLines('abcdefgh\tx')).to.deep.equal([`abcdefgh${' '.repeat(8)}x`]);
    // a wide character is two columns, so the stop is six spaces away, not seven
    expect(pagerLines('日\tx')).to.deep.equal([`日${' '.repeat(6)}x`]);
  });

  it('should take the lines as given when handed an array', () => {
    expect(pagerLines(['one', 'two', ''])).to.deep.equal(['one', 'two', '']);
  });
});

describe('softWrap()', () => {
  it('should fold at the column and keep every character in order', () => {
    const line = 'the quick brown fox jumps';
    const rows = softWrap(line, 10);
    expect(rows).to.deep.equal([
      [0, 10],
      [10, 20],
      [20, 25],
    ]);
    // the fold drops nothing and moves nothing, which is what lets a match find
    // its row by offset
    expect(rows.map(([a, b]) => line.slice(a, b)).join('')).to.equal(line);
  });

  it('should move a wide character that would straddle the edge to the next row', () => {
    const line = 'ab日本';
    const rows = softWrap(line, 3);
    expect(rows.map(([a, b]) => line.slice(a, b))).to.deep.equal(['ab', '日', '本']);
    for (const [a, b] of rows) {
      expect(stringWidth(line.slice(a, b))).toBeLessThanOrEqual(3);
    }
  });

  it('should never split a grapheme cluster', () => {
    const line = 'e\u0301e\u0301e\u0301';
    expect(softWrap(line, 2).map(([a, b]) => line.slice(a, b))).to.deep.equal([
      'e\u0301e\u0301',
      'e\u0301',
    ]);
  });

  it('should give an empty line one empty row, and not fold below one column', () => {
    expect(softWrap('', 10)).to.deep.equal([[0, 0]]);
    expect(softWrap('abc', 0)).to.deep.equal([[0, 3]]);
    expect(softWrap('abc', Number.NaN)).to.deep.equal([[0, 3]]);
  });
});

describe('searchLines()', () => {
  it('should read a query literally by default', () => {
    expect(searchLines(['abc', 'a.c'], 'a.c').matches).to.deep.equal([
      { end: 3, line: 1, start: 0 },
    ]);
    // every character a pattern would read as syntax, taken as itself
    expect(
      searchLines(['f(x) [1] {2} a|b ^$ \\ /'], '(x) [1] {2} a|b ^$ \\ /').matches
    ).to.have.length(1);
  });

  // one at a time, beside a line it must not match, so that a character the
  // escape leaves out is caught by name -- a `/` included, which the pager's
  // own class once escaped and `escapeRegExp()` does not need to under `u`
  it.each([...'\\^$.*+?()[]{}|/-'])('should take %j as itself', (char) => {
    const lines = ['xyz', `x${char}y`, `${char}${char}`];
    const { error, matches } = searchLines(lines, `x${char}y`);
    expect(error).to.equal(undefined);
    expect(matches).to.deep.equal([{ end: 3, line: 1, start: 0 }]);
    expect(searchLines(lines, char).matches.map((it) => it.line)).to.deep.equal([1, 2, 2]);
  });

  it('should match either case unless the query has a capital in it', () => {
    expect(searchLines(['Alpha', 'alpha'], 'alpha').matches).to.have.length(2);
    expect(searchLines(['Alpha', 'alpha'], 'Alpha').matches).to.deep.equal([
      { end: 5, line: 0, start: 0 },
    ]);
  });

  it('should not read an escape in a pattern as a capital somebody typed', () => {
    // `\S` is not an upper-case query, so the case still folds
    expect(searchLines(['ALPHA'], '\\Sl', 'regex').matches).to.have.length(1);
    expect(searchLines(['ALPHA'], 'Al', 'regex').matches).to.have.length(0);
  });

  it('should read a regular expression in regex mode', () => {
    expect(searchLines(['v1.2', 'v10'], 'v\\d+$', 'regex').matches).to.deep.equal([
      { end: 3, line: 1, start: 0 },
    ]);
  });

  it('should report a pattern that does not compile rather than throw', () => {
    const result = searchLines(['a(b'], 'a(', 'regex');
    expect(result.matches).to.deep.equal([]);
    expect(result.error).to.be.a('string').and.not.equal('');
  });

  it('should report an engine error mid-match rather than throw', () => {
    // a line whose search throws, standing in for a pattern that recurses past
    // the stack: what is pinned is that the throw is caught, whatever caused it
    const hostile = {
      matchAll(): never {
        throw new RangeError('Maximum call stack size exceeded');
      },
    } as unknown as string;
    const result = searchLines(['fine', hostile], 'x', 'regex');
    expect(result.error).to.equal('Maximum call stack size exceeded');
    expect(result.matches).to.deep.equal([]);
  });

  it('should count a zero-length match once per line, and only where nothing else matched', () => {
    // `^$` finds the blank lines and nothing else, once each
    expect(searchLines(['a', '', 'b', ''], '^$', 'regex').matches).to.deep.equal([
      { end: 0, line: 1, start: 0 },
      { end: 0, line: 3, start: 0 },
    ]);
    // `a*` matches empty at every column; on a line with a real match only the
    // real one counts, and a line with none counts once rather than per column
    expect(searchLines(['baaa', 'xyz'], 'a*', 'regex').matches).to.deep.equal([
      { end: 4, line: 0, start: 1 },
      { end: 0, line: 1, start: 0 },
    ]);
  });

  it('should stop at MAX_MATCHES and say it stopped', () => {
    const lines = Array.from({ length: Math.ceil(MAX_MATCHES / 1000) + 1 }, () => 'a'.repeat(1000));
    const result = searchLines(lines, 'a');
    expect(result.matches).to.have.length(MAX_MATCHES);
    expect(result.truncated).to.equal(true);
  });

  it('should find nothing for an empty query', () => {
    expect(searchLines(['a'], '')).to.deep.equal({ matches: [], truncated: false });
  });
});

describe('createPager()', () => {
  describe('drawing', () => {
    it('should number a folded line once, on its first row', () => {
      const { draw } = laid({ lineNumbers: true });
      const lines = draw().map((line) => line.replace(/[│█]$/, '').trimEnd());
      expect(lines.slice(0, 4)).to.deep.equal([
        ' 1 line 1 alpha beta ga',
        '   mma delta',
        ' 2 line 2',
        ' 3 line 3',
      ]);
    });

    it('should leave the gutter out where line numbers were not asked for', () => {
      const { draw } = laid();
      expect(draw()[0]).to.match(/^line 1 alpha/);
    });

    it('should fold at the room left by the gutter and the scrollbar', () => {
      const { draw } = laid({ lineNumbers: true }, { width: 16 });
      // 16 columns, less one for the bar and three for the gutter, is twelve
      expect(draw()[0]).to.equal(' 1 line 1 alpha█');
      expect(draw()[1]).to.equal('    beta gamma │');
    });

    it('should cut each line at the edge instead of folding it where wrap is off', () => {
      const { draw } = laid({ wrap: false }, { width: 12 });
      const lines = draw();
      expect(lines[0]).to.equal('line 1 alph█');
      expect(lines[1]).to.equal('line 2     │');
    });

    it('should show where the window is, as a percentage of the rows', () => {
      const { draw, key } = laid();
      expect(draw().at(-1)).to.match(/ 13%$/);
      key('G');
      expect(draw().at(-1)).to.match(/ 100%$/);
    });
  });

  describe('search', () => {
    it('should highlight every match inverse, and the current one in the accent too', () => {
      const { draw, pager } = laid();
      pager.search('line');
      const lines = draw(24, 1);
      // the first `line` is current: inverse and cyan
      expect(lines[0]).to.contain(`${ESC}[7;36mline${ESC}[27;39m`);
    });

    it('should mark a match that is not current inverse alone', () => {
      const { draw, pager } = laid();
      pager.search('line');
      const lines = draw(24, 1);
      expect(lines[2]).to.contain(`${ESC}[7mline${ESC}[27m`);
    });

    it('should widen a highlight to whole grapheme clusters rather than split an accent off', () => {
      const { draw, pager } = laid({ content: 'cafe\u0301 x' });
      pager.search('e');
      // the match is the base letter; the accent after it is drawn inside the
      // highlight rather than left as a lone combining mark nothing can draw
      expect(draw(24, 1)[0]).to.contain(`${ESC}[7;36me\u0301${ESC}[27;39m`);
    });

    it('should say which match is current and how many there are', () => {
      const { draw, pager } = laid({}, { width: 40 });
      expect(pager.search('gamma')).to.equal(10);
      expect(status(draw())).to.match(/^\/gamma {2}match 1 of 10/);
      pager.next();
      expect(status(draw())).to.match(/match 2 of 10/);
    });

    it('should say so when nothing matched, and not throw over a bad pattern', () => {
      const { draw, pager } = laid({ search: 'regex' }, { width: 40 });
      expect(pager.search('zebra')).to.equal(0);
      expect(status(draw())).to.match(/^No matches for zebra/);
      expect(() => pager.search('a(')).not.to.throw();
      expect(pager.error).to.be.a('string');
      expect(status(draw())).to.match(/^Invalid pattern: a\(/);
    });

    it('should translate what the status line says', async () => {
      await loadCatalog(
        {
          de: async () => ({
            'No matches for {0}': 'Keine Treffer für {0}',
            'match {0} of {1}': 'Treffer {0} von {1}',
          }),
        },
        {},
        'de'
      );
      const { draw, pager } = laid({}, { width: 40 });
      pager.search('zebra');
      expect(status(draw())).to.match(/^Keine Treffer für zebra/);
      pager.search('gamma');
      expect(status(draw())).to.match(/Treffer 1 von 10/);
      expect(__`match ${1} of ${2}`).to.equal('Treffer 1 von 2');
    });

    it('should start at the first match at or below the top of the window', () => {
      const { key, pager, top } = laid();
      key('G');
      const at = top();
      pager.search('gamma');
      // the current match is on screen, and is not the first one in the document
      expect(pager.current).to.be.greaterThan(0);
      expect(top()).to.equal(at);
    });

    it('should step with n and N, wrapping at both ends', () => {
      const { key, pager } = laid();
      pager.search('gamma');
      expect(pager.current).to.equal(0);
      key('N');
      expect(pager.current).to.equal(9);
      key('n');
      expect(pager.current).to.equal(0);
      key('n');
      expect(pager.current).to.equal(1);
    });

    it('should step from where the reader is after paging away, not from the last match', () => {
      const { key, pager, top } = laid();
      pager.search('gamma');
      expect(pager.current).to.equal(0);
      // well past the first few matches, without stepping through them
      key('space');
      key('space');
      key('space');
      const at = top();
      key('n');
      // the match `n` lands on is the first one at or below where the window was,
      // which is not the second match in the document
      expect(pager.current).to.be.greaterThan(1);
      expect(top()).to.be.greaterThanOrEqual(at);
    });

    it('should move the window only when the match is off screen', () => {
      const { key, pager, top } = laid({}, { height: 12 });
      pager.search('line');
      expect(top()).to.equal(0);
      key('n');
      key('n');
      // the third match is still on the first screen
      expect(top()).to.equal(0);
    });

    it('should show a folded line from its first row when that keeps the match on screen', () => {
      const { draw, pager } = laid();
      pager.search('delta');
      pager.next();
      // the second `delta` is on line 4's second row; the line arrives whole
      expect(draw()[0]).to.match(/^line 4 alpha beta/);
    });

    it('should shift the view sideways to a match past the edge where wrap is off', () => {
      const long = `${'x'.repeat(60)} needle`;
      const { draw, pager } = laid({ content: long, wrap: false }, { width: 20 });
      pager.search('needle');
      expect(draw()[0]).to.contain('needle');
    });

    it('should clear the search and its highlights on Escape', () => {
      const { draw, key, pager } = laid();
      pager.search('gamma');
      expect(key('escape')).to.equal(true);
      expect(pager.query).to.equal(undefined);
      expect(pager.matchCount).to.equal(0);
      expect(draw(24, 1).join('\n')).not.to.contain(`${ESC}[7`);
      // and with nothing to clear, Escape is not the pager's
      expect(key('escape')).to.equal(false);
    });
  });

  describe('typing a search', () => {
    it('should search for what was typed after a slash, on Enter', () => {
      const { draw, key, pager } = laid();
      key('/');
      key('g');
      key('a');
      expect(status(draw())).to.match(/^\/ga/);
      key('enter');
      expect(pager.query).to.equal('ga');
      expect(pager.matchCount).to.equal(10);
    });

    it('should take a space and claim the letters that would otherwise move the window', () => {
      const { key, pager, top } = laid();
      key('/');
      // `d`, `G` and space are all pager keys outside the field
      expect(key('d')).to.equal(true);
      expect(key('space')).to.equal(true);
      expect(key('G')).to.equal(true);
      key('enter');
      expect(top()).to.equal(0);
      expect(pager.query).to.equal('d G');
    });

    it('should drop the last character on Backspace, and leave the field when it is empty', () => {
      const { draw, key, pager } = laid();
      key('/');
      key('a');
      key('backspace');
      expect(status(draw())).to.match(/^\/$/);
      key('backspace');
      expect(status(draw())).not.to.match(/^\//);
      // out of the field, so `G` is a key again
      key('G');
      expect(pager.query).to.equal(undefined);
    });

    it('should drop a whole grapheme cluster on Backspace', () => {
      const { draw, key } = laid();
      key('/');
      key('x');
      // a decomposed e-acute arrives as two keys, the base and then its accent
      key('e');
      key(String.fromCodePoint(0x301));
      key('backspace');
      expect(status(draw())).to.match(/^\/x$/);
    });

    it('should leave the field on Escape and keep the search that was there', () => {
      const { key, pager } = laid();
      pager.search('gamma');
      key('/');
      key('z');
      key('escape');
      expect(pager.query).to.equal('gamma');
    });

    it('should repeat the last search on an empty Enter', () => {
      const { key, pager } = laid();
      type(key, 'beta');
      key('/');
      key('enter');
      expect(pager.query).to.equal('beta');
      expect(pager.matchCount).to.equal(10);
    });

    it('should leave a key it has no use for to whatever is around it', () => {
      const { key } = laid();
      key('/');
      expect(key('tab')).to.equal(false);
      expect(key('c', { ctrl: true })).to.equal(false);
    });
  });

  describe('keys', () => {
    it('should page down a window less a row on space, f and PageDown, and back on b', () => {
      const { key, top } = laid();
      // six rows, less the status line, is a viewport of five and a page of four
      key('space');
      expect(top()).to.equal(4);
      key('f');
      expect(top()).to.equal(8);
      key('pagedown');
      expect(top()).to.equal(12);
      key('b');
      expect(top()).to.equal(8);
      key('pageup');
      expect(top()).to.equal(4);
    });

    it('should move half a window on d and u', () => {
      const { key, top } = laid();
      key('d');
      expect(top()).to.equal(2);
      key('d');
      expect(top()).to.equal(4);
      key('u');
      expect(top()).to.equal(2);
    });

    it('should move a row on j, k, Enter and the arrows', () => {
      const { key, top } = laid();
      key('j');
      key('down');
      key('enter');
      expect(top()).to.equal(3);
      key('k');
      key('up');
      expect(top()).to.equal(1);
    });

    it('should go to the end on G and back to the top on g', () => {
      const { draw, key, top } = laid();
      key('G');
      expect(top()).to.be.greaterThan(20);
      expect(strip(draw().at(-2) ?? '')).to.match(/^line 30/);
      key('g');
      expect(top()).to.equal(0);
      key('end');
      expect(top()).to.be.greaterThan(20);
      key('home');
      expect(top()).to.equal(0);
    });

    it('should claim a key at the end of the range, where the move is zero', () => {
      const { key } = laid();
      expect(key('g')).to.equal(true);
      expect(key('k')).to.equal(true);
    });

    it('should hand every scrolling key on when the document fits', () => {
      const { key } = laid({ content: 'short' });
      for (const name of ['space', 'b', 'd', 'u', 'g', 'G', 'j', 'k']) {
        expect(key(name), name).to.equal(false);
      }
    });

    it('should leave a key with Ctrl or Alt held alone', () => {
      const { key, top } = laid();
      expect(key('d', { ctrl: true })).to.equal(false);
      expect(key('b', { meta: true })).to.equal(false);
      expect(top()).to.equal(0);
    });

    it('should call onQuit on q, and leave q alone without one', () => {
      const onQuit = vi.fn();
      expect(laid({ onQuit }).key('q')).to.equal(true);
      expect(onQuit).toHaveBeenCalledTimes(1);
      expect(laid().key('q')).to.equal(false);
    });

    it('should leave n and N alone before anything was searched for', () => {
      const { key } = laid();
      expect(key('n')).to.equal(false);
      expect(key('N')).to.equal(false);
    });

    it('should shift sideways by half the window on Left and Right where wrap is off', () => {
      const long = `0123456789${'abcdefghij'.repeat(4)}`;
      const { draw, key } = laid({ content: long, wrap: false }, { width: 11 });
      expect(draw()[0]).to.equal('0123456789█');
      expect(key('right')).to.equal(true);
      expect(draw()[0]).to.equal('56789abcde█');
      key('left');
      key('left');
      expect(draw()[0]).to.equal('0123456789█');
    });

    it('should leave Left and Right alone where lines fold', () => {
      const { key } = laid();
      expect(key('right')).to.equal(false);
    });

    it('should forget the rows a page down scrolled out of the window', () => {
      const { key, pager } = laid();
      // every row built on the way down, with its `parent` getter shadowed so
      // that the pager's own reads of it are counted; the tree reads the private
      // field and is not affected
      const reads = new Map<Element, number>();
      const watch = (): void => {
        for (const row of pagerRows(pager.element)) {
          if (reads.has(row)) {
            continue;
          }
          reads.set(row, 0);
          Object.defineProperty(row, 'parent', {
            configurable: true,
            get(this: Element) {
              reads.set(this, (reads.get(this) ?? 0) + 1);
              return PARENT.call(this);
            },
          });
        }
      };
      watch();
      for (let i = 0; i < 6; i++) {
        key('space');
        watch();
      }

      // a row stays in its slot; it is the slot the scroll box takes out
      const gone = [...reads.keys()].filter((row) => !PARENT.call(PARENT.call(row)!));
      expect(gone.length).to.be.greaterThan(10);
      for (const row of reads.keys()) {
        reads.set(row, 0);
      }

      // a search redraws every row the pager still holds; one it let go of on
      // the scroll that took it out is never looked at again
      pager.search('line');
      expect(gone.filter((row) => reads.get(row)! > 0)).to.deep.equal([]);
    });
  });

  describe('a new width', () => {
    it('should fold again and keep the line the window started on', () => {
      const { draw, key } = laid({ lineNumbers: true });
      key('space');
      key('space');
      const before = strip(draw()[0] ?? '');
      const line = /^\s*(\d+)/.exec(before)?.[1];
      expect(line).to.be.a('string');
      // wider: nothing folds now, and the top line is the one it was
      const after = strip(draw(60)[0] ?? '');
      expect(after.trim().startsWith(`${line} `)).to.equal(true);
    });

    it('should re-window for the count a new fold came to, where the top row stayed', () => {
      // the order the pager owes the scroll box, which re-windowed for the old
      // count before telling it about the width: refold, then `resync()`. At the
      // top the re-anchor lands where the window already is and writes no
      // offset, so nothing else would make the window read the new count -- and
      // the spacer below went on measuring forty rows of a thirty-row document
      const { draw, top, viewport } = laid();
      // ten of the thirty lines fold at 23 columns, in a window of five rows
      expect(scrollRange(viewport).y).toBe(40 - 5);
      draw(60);
      expect(top()).toBe(0);
      expect(scrollRange(viewport).y).toBe(30 - 5);
    });

    it('should hear the scroll box re-window on a scroll, and say where it is', () => {
      // the status line is redrawn from `onScroll`, so a writer the pager does not
      // own -- here an app's own `scrollTo()` -- still moves the percentage
      const { draw, viewport } = laid();
      expect(draw().at(-1)).toMatch(/13%$/);
      viewport.scrollTo(0, 35);
      expect(draw().at(-1)).toMatch(/100%$/);
    });

    it('should keep a wide line inside the room it was given', () => {
      const { draw } = laid({ content: '日本語のテキスト'.repeat(4) }, { width: 9 });
      for (const line of draw().slice(0, -1)) {
        expect(stringWidth(strip(line))).toBeLessThanOrEqual(9);
      }
    });
  });

  describe('describe()', () => {
    it("should list the pager's keys while it holds the focus, and q only with onQuit", () => {
      const ui = createTestTerminal();
      const without = createPager({ content: DOC });
      const input = createInput({ root: without.element, terminal: ui.terminal });
      const off = without.describe(input);
      input.focus.focus(without.element);
      const keys = input.bindings().map((b) => b.keys);
      expect(keys).to.include.members(['space', 'b', 'd', 'u', 'g', 'G', '/', 'n', 'N']);
      expect(keys).not.to.include('q');
      off();
      expect(input.bindings()).to.deep.equal([]);

      const withQuit = createPager({ content: DOC, onQuit: () => {} });
      const second = createInput({ root: withQuit.element, terminal: ui.terminal });
      withQuit.describe(second);
      second.focus.focus(withQuit.element);
      expect(second.bindings().map((b) => b.keys)).to.include('q');
      input.stop();
      second.stop();
    });

    it('should list nothing while the focus is somewhere else', () => {
      const ui = createTestTerminal();
      const pager = createPager({ content: DOC });
      const input = createInput({ root: pager.element, terminal: ui.terminal });
      pager.describe(input);
      expect(input.bindings()).to.deep.equal([]);
      input.stop();
    });
  });
});

describe('page()', () => {
  /** Long enough for the frame timer to have fired, at `frameMs: 0`. */
  const frame = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 15));

  it('should write the document as given and resolve where there is no terminal', async () => {
    const ui = createTestTerminal({ isTTY: false });
    await page(`${ESC}[31mred${ESC}[0m\nplain`, { terminal: ui.terminal });
    // as given: `less` writes its input through unchanged when it is piped
    expect(ui.output).to.equal(`${ESC}[31mred${ESC}[0m\nplain\n`);
  });

  it('should write it out where stdin is not a terminal, even on a terminal', async () => {
    const ui = createTestTerminal({ inputTTY: false });
    await page(['a', 'b'], { terminal: ui.terminal });
    expect(ui.output).to.equal('a\nb\n');
    expect(ui.screen.alternate).to.equal(false);
  });

  it('should take the alternate screen, page on keys, and give it back on q', async () => {
    const ui = createTestTerminal({ columns: 30, rows: 8 });
    const done = page(DOC, {
      frameMs: 0,
      lineNumbers: true,
      terminal: ui.terminal,
    });
    await frame();
    expect(ui.screen.alternate).to.equal(true);
    expect(ui.viewport[0]).to.match(/^ 1 line 1 alpha/);

    await ui.press(' ');
    await frame();
    expect(ui.viewport[0]).not.to.match(/^ 1 line 1/);

    await ui.press('/', 'gamma', KEYS.enter);
    await frame();
    expect(ui.viewport.at(-1)).to.match(/match \d+ of 10/);

    await ui.press('q');
    await done;
    expect(ui.screen.alternate).to.equal(false);
    expect(ui.lines).to.deep.equal([]);
  });

  it('should give the screen back on Ctrl-C too', async () => {
    const ui = createTestTerminal({ columns: 30, rows: 8 });
    const done = page(DOC, { frameMs: 0, terminal: ui.terminal });
    await frame();
    await ui.press(ctrl('c'));
    await done;
    expect(ui.screen.alternate).to.equal(false);
  });

  it('should fold again when the window is resized', async () => {
    const ui = createTestTerminal({ columns: 24, rows: 8 });
    const done = page(DOC, { frameMs: 0, terminal: ui.terminal });
    await frame();
    // 24 columns less the bar is 23, which `line 1 alpha beta gamma` fills
    expect(ui.viewport[1]).to.match(/^ delta/);
    ui.resize(60, 8);
    await frame();
    expect(ui.viewport[0]).to.match(/^line 1 alpha beta gamma delta/);
    expect(ui.viewport[1]).to.match(/^line 2/);
    await ui.press('q');
    await done;
  });
});
