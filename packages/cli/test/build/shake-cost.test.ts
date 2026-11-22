/**
 * What reading a long `+` chain costs, counted rather than timed.
 *
 * `collectLiterals()` reads a `+` chain as a run with `partsOf()` and the walk
 * then descends into it. Every nested `+` below the top one used to be read as
 * a run of its own as well, and each of those read its own nested ones in turn:
 * a chain of n terms was read about n times over, each read O(n) parts, and the
 * copying added a further factor. 2,000 terms took 1.2 s and 4,000 took 8.2 s.
 *
 * The claim is that each spliced node is read **once**, so the count that
 * says it is the number of nodes `partsOf()` unwraps: one `unwrapShallow()` per
 * operand it reads. That is a count and not a clock for the reason
 * `shake-walk.test.ts` and `config/lines.test.ts` give -- a timing ratio flakes
 * under the suite's parallel load, and a count does not. The wrapper only
 * records; the real function runs. A file of its own, because `vi.mock` is
 * hoisted and module-wide.
 */

import { scanClassEvidence } from '../../src/build/index.js';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

/** How many times an operand has been unwrapped since the last `cost()`. */
let calls = 0;

vi.mock('../../src/build/literals.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/build/literals.js')>();

  return {
    ...real,
    unwrapShallow: (...args: Parameters<typeof real.unwrapShallow>) => {
      calls++;
      return real.unwrapShallow(...args);
    },
  };
});

const made: string[] = [];

afterEach(() => {
  for (const dir of made.splice(0)) {
    rmSync(dir, { force: true, recursive: true });
  }
});

/** A chain of `n` terms, every other one unknown. */
function chain(n: number): string {
  return Array.from({ length: n }, (_, i) => (i % 2 ? `v${i}` : `'p-${i % 7}'`)).join(' + ');
}

/** How many operands reading `source` unwrapped. */
function cost(source: string): number {
  const root = mkdtempSync(join(tmpdir(), 'sigil-shake-cost-'));
  made.push(root);
  mkdirSync(join(root, 'src'));
  writeFileSync(join(root, 'src', 'app.ts'), source);

  calls = 0;
  scanClassEvidence(root);
  return calls;
}

describe('the cost of a long chain', () => {
  // twice the terms over the terms: 2 for a read per term, 4 for a read of the
  // chain per term. 3 is the line between them
  const growth = (build: (n: number) => string, n: number): number =>
    cost(build(2 * n)) / cost(build(n));

  it('should read a `+` chain in a number of operands linear in its terms', () => {
    expect(growth((n) => `const c = ${chain(n)};`, 500)).toBeLessThan(3);
  });

  it('should read a `+=` right-hand side in a number of operands linear in its terms', () => {
    expect(growth((n) => `let c = ''; c += ${chain(n)};`, 500)).toBeLessThan(3);
  });

  it('should read a template nested in a chain once per term', () => {
    const nested = (n: number): string =>
      `const c = ${Array.from({ length: n }, (_, i) => `\`p-\${v${i}}\``).join(' + ')};`;
    expect(growth(nested, 500)).toBeLessThan(3);
  });

  it('should read a template inside a template once per level', () => {
    // each level is an interpolation of the one above it, so a read of every
    // level as a run of its own is a read of every level below it as well
    const deep = (n: number): string => {
      let source = 'v';
      for (let i = 0; i < n; i++) {
        source = `\`p-\${${source}}\``;
      }
      return `const c = ${source};`;
    };
    expect(growth(deep, 200)).toBeLessThan(3);
  });

  it('should read a chain of || terms with a literal on the right in linear operands', () => {
    // SIG-595: each `(v || 'p-N')` is a choice with an unknown alternative, and
    // a run of n of them must not be 2^n texts or a read of every prefix
    const choices = (n: number): string =>
      `const c = ${Array.from({ length: n }, (_, i) => `(v${i} || 'p-${i % 7}')`).join(' + ')};`;
    expect(growth(choices, 500)).toBeLessThan(3);
  });

  it('should read a left-nested || chain once, whatever its length', () => {
    const nested = (n: number): string =>
      `const c = (${Array.from({ length: n }, (_, i) => `v${i}`).join(' || ')} || 'p-2') + x;`;
    expect(growth(nested, 500)).toBeLessThan(3);
  });

  it('should read each term about once, whatever the length', () => {
    // a chain of 1,000 terms unwraps each operand a handful of times at most,
    // where reading every prefix of it is half a million
    expect(cost(`const c = ${chain(1000)};`)).toBeLessThan(5000);
  });
});
