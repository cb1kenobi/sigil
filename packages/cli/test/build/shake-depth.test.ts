/**
 * What the shake does with source nested deeper than a stack holds (SIG-625).
 *
 * A right-nested `||` chain 8,000 deep ended a review probe with nothing printed.
 * It was three separate things, and each has a test here:
 *
 * - `walk()` and the readers under `collectLiterals()` recursed, and overflowed
 *   the call stack at about 3,500 terms. That is a `RangeError`, which `readFile()`
 *   caught along with every parse error and answered with a raw scan of the file
 *   with every token closed -- so the rules the unread half of the file opened
 *   were dropped and nothing said so. They are loops now, and a failure that is
 *   not a parse failure is an error naming the file.
 * - `oxc-parser` overflows its **native** stack on a deep enough tree and takes
 *   the process with it: exit 139, no message, no exception. A shake reads every
 *   file under the root whether or not anything imports it, so such a file ended
 *   a build that was fine with `--no-shake`. A file nested past `MAX_NESTING`
 *   brackets is not handed to the parser at all.
 * - The parser's own limit is the one that is left, and it is a property of the
 *   stack: see `MAX_NESTING` in `shake.ts`.
 *
 * Depths here are chosen so that the parser is never near its own limit, which is
 * a property of the stack and differs by platform and by thread -- a vitest
 * worker has a bigger JavaScript stack than a process's main thread, so an
 * in-process chain long enough to overflow the old reader there is close to what
 * crashes the parser. The reader's limit is the one the tests move instead: a
 * child process is started with `--stack-size` a fifth of the default, which
 * makes the recursive reader overflow at a few hundred terms. Anything the parser
 * could not be trusted with is given to `walk()` as a hand-made tree or goes
 * through the bracket guard, which never reaches the parser.
 */

import { scanClassEvidence } from '../../src/build/index.js';
import { walk } from '../../src/build/walk.js';
import { run } from '../spawned.js';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { Node } from 'oxc-parser';
import { afterEach, describe, expect, it, vi } from 'vitest';

/** Set by a test that wants the walk to fail the way a bug in it would. */
let failWalk: Error | undefined;

vi.mock('../../src/build/walk.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/build/walk.js')>();

  return {
    ...real,
    walk: (...args: Parameters<typeof real.walk>) => {
      if (failWalk) {
        throw failWalk;
      }
      return real.walk(...args);
    },
  };
});

const made: string[] = [];

afterEach(() => {
  failWalk = undefined;
  for (const dir of made.splice(0)) {
    rmSync(dir, { force: true, recursive: true });
  }
});

/** An app tree holding one source file, and its root. */
function tree(source: string, name = 'src/app.ts'): string {
  const root = mkdtempSync(join(tmpdir(), 'sigil-shake-depth-'));
  made.push(root);
  const file = join(root, name);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, source);
  return root;
}

/** A chain of `n` terms with a literal at the front, left-nested by its operator. */
function flat(operator: string, n: number): string {
  return `'text-' ${Array.from({ length: n }, (_, i) => `${operator} v${i}`).join(' ')}`;
}

/**
 * Where a probe script goes: beside the tree it scans and not in it, because the
 * scan reads every source file under its root and a script naming the classes it
 * asks about would be evidence for them.
 */
function probeFile(): string {
  const dir = mkdtempSync(join(tmpdir(), 'sigil-shake-probe-'));
  made.push(dir);
  return join(dir, 'probe.mjs');
}

/**
 * What a scan of one file answers, in a process whose call stack is an eighth of
 * the usual size, so that the old recursive reader overflows at a few hundred
 * terms and the parser, which has its own native stack, is nowhere near its limit.
 *
 * @param source - The file.
 * @param names - The class names to ask about.
 * @returns What `mayName()` said for each.
 */
async function shallowStack(source: string, names: string[]): Promise<boolean[]> {
  const root = tree(source);
  const shake = join(dirname(fileURLToPath(import.meta.url)), '../../src/build/shake.ts');
  const script = probeFile();
  writeFileSync(
    script,
    [
      `import { scanClassEvidence } from ${JSON.stringify(pathToFileURL(shake).href)};`,
      `const evidence = scanClassEvidence(${JSON.stringify(root)});`,
      `console.log(JSON.stringify(${JSON.stringify(names)}.map((name) => evidence.mayName(name))));`,
      '',
    ].join('\n')
  );

  const ran = await run(script, dirname(script), [], {}, ['--stack-size=120']);

  expect(ran.stderr).toBe('');
  expect(ran.code).toBe(0);
  return JSON.parse(ran.stdout) as boolean[];
}

describe('a chain nested deeper than the call stack', () => {
  it('should walk a tree 200,000 levels deep', () => {
    // hand-made, so that the parser is not part of the question: `walk()` is what
    // overflowed, and a tree this deep is what a recursive one cannot be given
    let node = { type: 'Identifier' } as unknown as Node;
    for (let i = 0; i < 200_000; i++) {
      node = { left: node, right: null, type: 'BinaryExpression' } as unknown as Node;
    }

    let seen = 0;
    walk(node, () => {
      seen++;
      return true;
    });

    expect(seen).toBe(200_001);
  });

  it('should visit children in order, and skip those of a node it is told to', () => {
    const leaf = (name: string): Node => ({ name, type: 'Identifier' }) as unknown as Node;
    const tree = {
      left: { left: leaf('a'), right: leaf('b'), type: 'BinaryExpression' },
      right: leaf('c'),
      type: 'BinaryExpression',
    } as unknown as Node;

    const order: string[] = [];
    walk(tree, (node) => {
      order.push(node.type === 'Identifier' ? (node as unknown as { name: string }).name : '+');
      return true;
    });
    expect(order).toEqual(['+', '+', 'a', 'b', 'c']);

    const skipped: string[] = [];
    walk(tree, (node) => {
      skipped.push(node.type === 'Identifier' ? (node as unknown as { name: string }).name : '+');
      return node !== (tree as unknown as { left: Node }).left;
    });
    expect(skipped).toEqual(['+', '+', 'c']);
  });

  it('should keep the rules a file asks for after a `+` chain too deep to recurse', async () => {
    // the regression named after the defect: the chain overflowed the reader, the
    // catch around it read the whole file closed, and `later`'s open `bg-` was
    // dropped with no word about it
    const source = `const deep = ${flat('+', 500)};\nconst later = 'bg-' + colour;\n`;

    expect(await shallowStack(source, ['bg-red', 'text-red', 'border-red'])).toEqual([
      true,
      true,
      false,
    ]);
  });

  it('should keep the rules after a left-nested `||` chain too deep to recurse', async () => {
    const source = `const deep = (${flat('||', 500)}) + colour;\nconst later = 'bg-' + colour;\n`;

    expect(await shallowStack(source, ['bg-red', 'text-red', 'border-red'])).toEqual([
      true,
      true,
      false,
    ]);
  });

  it('should read a right-nested `?:` chain too deep to recurse', async () => {
    const chain = Array.from({ length: 500 }, (_, i) => `v${i} ? 'a${i}-' : `).join('');
    const source = `const deep = (${chain}'text-') + colour;\nconst later = 'bg-' + colour;\n`;

    expect(await shallowStack(source, ['a499-red', 'text-red', 'bg-red', 'border-red'])).toEqual([
      true,
      true,
      true,
      false,
    ]);
  });

  it('should name the file when reading a tree that parsed fails', () => {
    // not a parse failure, so not the raw-scan fallback: that one is for source
    // that is not a module, and answering a bug in the reader with it is how
    // rules went missing without a word
    failWalk = new RangeError('Maximum call stack size exceeded');
    const root = tree(`const c = 'text-' + colour;\n`);

    expect(() => scanClassEvidence(root)).toThrow(
      /Could not read .*app\.ts for the utility shake: Maximum call stack size exceeded/
    );
  });

  it('should still fall back to the raw scan for a file that does not parse', () => {
    const evidence = scanClassEvidence(tree(`const c = 'text-red' +;\n`));

    expect(evidence.mayName('text-red')).toBe(true);
  });
});

describe('a file nested deeper than the parser can be trusted with', () => {
  it('should read it open on both ends rather than parse it', () => {
    // 600 is past `MAX_NESTING` and nowhere near what crashes the parser, so
    // this runs in-process: what it pins is which reading the file gets. `text-`
    // beside nothing is the closed token a parse would have read it as, which is
    // no class; a file that was not parsed keeps every `text-*` rule
    const source = `const c = ${'('.repeat(600)}'text-'${')'.repeat(600)};\nconst p = 'p-2';\n`;
    const evidence = scanClassEvidence(tree(source));

    expect(evidence.mayName('text-red')).toBe(true);
    expect(evidence.mayName('p-2')).toBe(true);
    expect(evidence.mayName('border-red')).toBe(false);
  });

  it('should not end the process on a right-nested `||` chain 20,000 deep', async () => {
    // exit 139 and nothing on either stream is what this was. A child process,
    // because the failure it pins is a signal and no assertion survives one
    let source = `'text-'`;
    for (let i = 0; i < 20_000; i++) {
      source = `(v${i} || ${source})`;
    }
    const root = tree(`export const deep = ${source};\n`, 'src/deep.ts');
    const shake = join(dirname(fileURLToPath(import.meta.url)), '../../src/build/shake.ts');
    const script = probeFile();
    writeFileSync(
      script,
      [
        `import { scanClassEvidence } from ${JSON.stringify(pathToFileURL(shake).href)};`,
        `const evidence = scanClassEvidence(${JSON.stringify(root)});`,
        `console.log(evidence.mayName('text-red'));`,
        '',
      ].join('\n')
    );

    const ran = await run(script, dirname(script));

    expect(ran.stderr).toBe('');
    expect(ran.code).toBe(0);
    expect(ran.stdout.trim()).toBe('true');
  });
});
