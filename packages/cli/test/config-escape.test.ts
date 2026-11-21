import { run } from '../src/index.js';
import { linkedFixture } from './copy-fixture.ts';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fixtures = resolve(dirname(fileURLToPath(import.meta.url)), 'fixtures');

/**
 * A `sigil.json` that cannot be read names the app's root, and the root is
 * whatever the file system calls it (SIG-551).
 *
 * `readSigilConfig()` reads through `json()` from `@ttylabs/sigil/config`, whose
 * messages quoted the path exactly as it was on disk, so a root holding a
 * retitle sequence reached stderr as one. The rule is that a value an error
 * echoes is escaped where it is thrown, so it is that store that escapes it and
 * `readSigilConfig()` adds nothing -- which is what these check from the other
 * end, through the commands that read the file rather than through the store.
 *
 * A control character in a directory name cannot be created on Windows.
 */

const POSIX = process.platform !== 'win32';

/** A window retitle and a forged second line, which is what an unescaped root can do. */
const HOSTILE = '\u001b]0;T\u0007\nforged: error';

/** What `escapeControls()` makes of it, inside a message. */
const ESCAPED = '\\x1B]0;T\\x07\\x0Aforged: error';

/** Runs the CLI with both streams captured, and hands back what they got. */
async function sigil(...argv: string[]): Promise<{ err: string; out: string }> {
  const chunks: Record<'err' | 'out', string[]> = { err: [], out: [] };
  const spies = (['stdout', 'stderr'] as const).map((stream) =>
    vi.spyOn(process[stream], 'write').mockImplementation(((chunk: string | Uint8Array) => {
      chunks[stream === 'stdout' ? 'out' : 'err'].push(chunk.toString());
      return true;
    }) as typeof process.stdout.write)
  );

  try {
    await run(argv);
  } finally {
    for (const spy of spies) {
      spy.mockRestore();
    }
  }

  return { err: chunks.err.join(''), out: chunks.out.join('') };
}

/** A buildable app under a root with the hostile name in it. */
function app(): string {
  return linkedFixture(join(fixtures, 'buildable'), `sigil-config-escape-${HOSTILE}-`);
}

/** Every control character left in some output, newlines aside. */
function controls(text: string): string[] {
  return [...text.matchAll(/\p{Cc}/gu)].map((m) => m[0]).filter((c) => c !== '\n');
}

describe.skipIf(!POSIX)('an app whose root has a control character in its name', () => {
  let exitCode: typeof process.exitCode;

  beforeEach(() => {
    exitCode = process.exitCode;
  });

  afterEach(() => {
    process.exitCode = exitCode;
    vi.restoreAllMocks();
  });

  /** What each way a `sigil.json` fails to read is made of. */
  const cases: [string, (root: string) => void][] = [
    ['is not valid JSON', (root) => writeFileSync(join(root, 'sigil.json'), '{ "build": }')],
    [
      'is not UTF-8',
      (root) => writeFileSync(join(root, 'sigil.json'), Buffer.from([0x7b, 0xe9, 0x7d])),
    ],
    ['cannot be read', (root) => mkdirSync(join(root, 'sigil.json'))],
    ['does not hold an object', (root) => writeFileSync(join(root, 'sigil.json'), '42')],
  ];

  describe.each(['build', 'reference', 'package'])('sigil %s', (command) => {
    it.each(cases)('should print the root escaped when sigil.json %s', async (_, make) => {
      const root = app();
      make(root);

      const { err, out } = await sigil(command, root, '--out', join(root, 'out'));

      expect(err).toContain(ESCAPED);
      expect(controls(err)).toStrictEqual([]);
      expect(controls(out)).toStrictEqual([]);
      expect(err.split('\n').some((line) => line.startsWith('forged: error'))).toBe(false);
    });
  });
});
