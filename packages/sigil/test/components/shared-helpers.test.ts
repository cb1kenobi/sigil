/**
 * The helpers two or more components used to define for themselves (SIG-366),
 * each now defined once and imported by the rest.
 *
 * Every test here is about behaviour a caller depended on before the copies
 * were folded together, so a change to the one definition that would have moved
 * one caller and not the other fails here first. The last block reads the
 * source, because a copy that comes back is not something a behaviour test can
 * see: it would behave identically until somebody edited one of them.
 */

import { MAX_TIMER_DELAY } from '../../src/components/clock.js';
import { clampProgress, progressTotal } from '../../src/components/progress.js';
import { promptCountComplaint, promptSeek } from '../../src/components/prompt.js';
import { noSize } from '../../src/components/scroll-box.js';
import { decimalPlaces } from '../../src/components/slider.js';
import { DIGIT_COLUMNS } from '../../src/components/table.js';
import { TREE_FIXED } from '../../src/components/tree.js';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const src = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'src');

describe('promptSeek()', () => {
  /** A list in both of the shapes that walk it: `multiselect()`'s and `groupMultiselect()`'s. */
  const items = [
    { kind: 'separator' },
    { kind: 'choice', offered: true },
    { kind: 'choice', offered: false },
    { kind: 'group', offered: true },
    { kind: 'separator' },
    { kind: 'choice', offered: true },
  ] as const;

  it('should step over what is not on offer, a separator and a disabled choice alike', () => {
    expect(promptSeek(items, 1, 1, false)).toBe(3);
    expect(promptSeek(items, 3, 1, false)).toBe(5);
    expect(promptSeek(items, 5, -1, false)).toBe(3);
  });

  it('should land on a group heading that is on offer, which is a row of its own', () => {
    // `groupMultiselect()` read `offered` on every row, headings included, and
    // the walk it now borrows does the same
    expect(promptSeek(items, 1, 1, true)).toBe(3);
  });

  it('should wrap only when the ends are joined', () => {
    expect(promptSeek(items, 5, 1, true)).toBe(1);
    expect(promptSeek(items, 1, -1, true)).toBe(5);
    expect(promptSeek(items, 5, 1, false)).toBe(5);
    expect(promptSeek(items, 1, -1, false)).toBe(1);
  });

  it('should end where it began on a list with nothing else on offer, after one lap', () => {
    const lone = [{ kind: 'separator' }, { kind: 'choice', offered: true }] as const;
    const none = [{ kind: 'separator' }, { kind: 'choice', offered: false }] as const;

    expect(promptSeek(lone, 1, 1, true)).toBe(1);
    expect(promptSeek(none, 0, 1, true)).toBe(0);
    expect(promptSeek(none, 1, -1, true)).toBe(1);
  });
});

describe('promptCountComplaint()', () => {
  it('should say nothing about a count inside the bounds', () => {
    expect(promptCountComplaint(0, 0, Infinity)).toBe(undefined);
    expect(promptCountComplaint(2, 1, 3)).toBe(undefined);
    expect(promptCountComplaint(3, 3, 3)).toBe(undefined);
  });

  it('should keep the message translators already carry for a minimum of one', () => {
    expect(promptCountComplaint(0, 1, Infinity)).toBe('Choose at least one');
  });

  it('should name any other minimum, and the maximum', () => {
    expect(promptCountComplaint(1, 2, Infinity)).toBe('Choose at least 2');
    expect(promptCountComplaint(4, 0, 3)).toBe('Choose at most 3');
  });
});

describe('decimalPlaces()', () => {
  // `number()` read this with a regex and the slider by splitting; the two were
  // compared over two million values, random bit patterns among them, and never
  // disagreed. These are the cases each was written for
  it.each([
    [0, 0],
    [7, 0],
    [-1, 0],
    [0.5, 1],
    [-0.25, 2],
    [0.1 + 0.2, 17],
    [1e-7, 7],
    [-1e-7, 7],
    [1.5e-7, 8],
    [5e-324, 324],
    [1e21, 0],
    [-1.25e21, 0],
    [Number.NaN, 0],
    [Number.POSITIVE_INFINITY, 0],
    [Number.NEGATIVE_INFINITY, 0],
  ])('should count %s as %s places', (value, places) => {
    expect(decimalPlaces(value)).toBe(places);
  });
});

describe('clampProgress() and progressTotal()', () => {
  it('should hold a value between nothing and the total', () => {
    expect(clampProgress(5, 10)).toBe(5);
    expect(clampProgress(-3, 10)).toBe(0);
    expect(clampProgress(99, 10)).toBe(10);
  });

  it('should read a value that is not finite as nothing, as renderBar() does', () => {
    expect(clampProgress(Number.NaN, 10)).toBe(0);
    expect(clampProgress(Number.POSITIVE_INFINITY, 10)).toBe(0);
    expect(clampProgress(Number.NEGATIVE_INFINITY, 10)).toBe(0);
  });

  it('should keep only a positive, finite total', () => {
    expect(progressTotal(40, 100)).toBe(40);
    expect(progressTotal(0.5, 100)).toBe(0.5);
    for (const total of [undefined, 0, -5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(progressTotal(total, 100)).toBe(100);
    }
  });
});

describe('the shared constants', () => {
  it('should be what each component had written for itself', () => {
    expect(MAX_TIMER_DELAY).toBe(2147483647);
    expect(DIGIT_COLUMNS).toBe(9);
    expect(noSize()).toEqual({ height: 0, width: 0 });
    expect(TREE_FIXED).toEqual({ 'flex-shrink': 0, 'white-space': 'nowrap' });
  });
});

describe('one definition of each', () => {
  /**
   * Every TypeScript source under `src/components/` and `src/util/`, with its path
   * relative to `src/`. The components are the ticket's scope; the input router
   * and the testing helpers carry a `MAX_DELAY` of their own, which is the same
   * platform fact and is left for a change about those modules.
   */
  const sources = (function walk(dir: string): [string, string][] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        return walk(path);
      }
      return entry.name.endsWith('.ts')
        ? [[path.slice(src.length + 1), readFileSync(path, 'utf-8')] as [string, string]]
        : [];
    });
  })(src).filter(([path]) => /^(?:components|util)[\\/]/.test(path));

  /** How many sources say this, and which. */
  function sites(pattern: RegExp): string[] {
    return sources.flatMap(([path, text]) =>
      Array.from(text.matchAll(new RegExp(pattern.source, 'g')), () => path)
    );
  }

  it.each([
    ['the walk to the next row on offer', /function seek\b/],
    ['the count of decimal places', /function decimal(?:s|Places)\b/],
    ['the longest a timer waits', /\bMAX_(?:TIMER_)?DELAY\b(?::\s*\w+)?\s*=/],
    ['how many columns a digit sorts', /\bDIGIT(?:S|_COLUMNS)\b\s*=/],
    ['a raw element that takes no room', /function noSize\b/],
    ['a run of a tree drawn at its own width', /\b(?:TREE_)?FIXED\s*=/],
    ['the message for too many ticked', /__`Choose at most/],
    ['the message for too few ticked', /__`Choose at least \$/],
  ])('should define %s in one place', (_, pattern) => {
    expect(sites(pattern)).toHaveLength(1);
  });

  it('should leave the progress bars no clamp of their own', () => {
    expect(sites(/function clamp\(next: number\)/)).toEqual([]);
  });
});
