/**
 * What `sigil package` hands `bundleApp()`, asked without a compiler.
 *
 * SIG-354. The package's bundle goes into a staging directory under
 * `node_modules/.sigil`, so what keeps an earlier build's `dist/` out of the
 * class-evidence walk is the `outputs` the command passes -- and the test that
 * proves it end to end, in `package-command.test.ts`, needs Bun or a Node that
 * can build a single executable, which CI does not have. `bundle.test.ts` proves
 * that `bundleApp()` honours `outputs` everywhere; this proves that the command
 * passes them, which is the other half and the one a deleted line would lose.
 *
 * `bundleApp()` is mocked to record its options and refuse, so nothing is
 * bundled or compiled. What lets the command reach it is a stub `node` first on
 * `PATH`, answering `--version` above the single-executable floor so the
 * pre-flight passes -- the same stub `package-command.test.ts` uses, and skipped
 * on Windows for the same reason: it is a shell script. A file of its own,
 * because `vi.mock` is hoisted and module-wide.
 */

import { linkedFixture } from './copy-fixture.ts';
import { tempDir } from './temp.js';
import { candidates } from '@ttylabs/sigil/which';
import { writeFileSync } from 'node:fs';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/** What each `bundleApp()` call was handed. */
const calls: { out: string; outputs?: readonly string[] }[] = [];

vi.mock('../src/build/bundle.ts', async (original) => ({
  ...(await original<typeof import('../src/build/bundle.ts')>()),
  bundleApp: (options: { out: string; outputs?: readonly string[] }) => {
    calls.push(options);
    return Promise.reject(new Error('BUNDLE-RECORDED'));
  },
}));

const { hostTarget, label } = await import('../src/build/compile.ts');
const { run } = await import('../src/index.js');

const fixtures = resolve(dirname(fileURLToPath(import.meta.url)), 'fixtures');

/** Runs the CLI with stderr captured. */
async function sigil(...argv: string[]): Promise<string> {
  const err: string[] = [];
  const spies = (['stdout', 'stderr'] as const).map((stream) =>
    vi.spyOn(process[stream], 'write').mockImplementation(((chunk: string | Uint8Array) => {
      if (stream === 'stderr') {
        err.push(chunk.toString());
      }
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

  return err.join('');
}

describe.skipIf(process.platform === 'win32')('what sigil package bundles with', () => {
  let exitCode: typeof process.exitCode;
  let path: string | undefined;

  beforeEach(() => {
    exitCode = process.exitCode;
    path = process.env.PATH;
    calls.length = 0;

    const fakebin = tempDir('sigil-wiring-node-');
    const name = [...candidates('node', { path: fakebin })].find((one) => one.startsWith(fakebin));
    expect(name, 'candidates() offered nothing inside the stub directory').toBeDefined();
    writeFileSync(
      name as string,
      '#!/bin/sh\ncase "$1" in\n  --version) echo v99.0.0 ;;\n  *) exit 1 ;;\nesac\n',
      { mode: 0o755 }
    );
    process.env.PATH = `${fakebin}${delimiter}${path ?? ''}`;
  });

  afterEach(() => {
    process.env.PATH = path;
    process.exitCode = exitCode;
    vi.restoreAllMocks();
  });

  it('should leave the configured build output out of the evidence, and only that', async () => {
    const app = linkedFixture(join(fixtures, 'styled'), 'sigil-wiring-app-');
    writeFileSync(join(app, 'sigil.json'), JSON.stringify({ build: { out: 'built' } }));
    const out = join(app, 'binaries');

    const err = await sigil(
      'package',
      app,
      '--out',
      out,
      '--runtime',
      'node',
      '--target',
      label(hostTarget())
    );

    // the command reached the bundle, which is the precondition for the rest
    expect(err).toContain('BUNDLE-RECORDED');
    expect(calls).toHaveLength(1);
    // the build's configured directory -- where an earlier `sigil build` left a
    // bundle -- and not the binaries' directory, which holds nothing a module
    // pattern matches and could only cost an app evidence it keeps there
    expect(calls[0]?.outputs).toStrictEqual([join(app, 'built')]);
  }, 60_000);
});
