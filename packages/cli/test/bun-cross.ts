import { writeExecutable } from './executable.ts';
import { tempDir } from './temp.js';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, vi } from 'vitest';

/**
 * What a test needs to package for a Bun target that is not this machine's
 * without reaching the network or owning a runtime for another platform
 * (SIG-442).
 *
 * `sigil package` fetches that platform's runtime from npm, verifies it and
 * hands it to `bun` to embed. Two stand-ins cover the two halves: `serveRuntimes()`
 * is npm, serving a small archive per platform whose digest it publishes, and
 * `stubBun()` is the `bun` that embeds it, which writes the runtime it was handed
 * as the binary. What the real `Bun.build()` does with a real runtime is
 * `compile-embed.test.ts`'s, and a measurement.
 *
 * POSIX only: the stub is a shell script.
 */

const box = tempDir('sigil-bun-cross-');

/** The file in a stub's directory that has a line for every `--revision` it was asked. */
export const REVISIONS = 'revisions';

/** The platform a `@oven/bun-<triple>` request is for, when it is one. */
const triple = (url: string): string | undefined =>
  /@oven(?:%2f|\/)(bun-[a-z]+-[a-z0-9]+)/.exec(url)?.[1];

/** What the fake runtime for a platform holds, so a test can tell one from another. */
export const runtimeFor = (name: string): string => `FAKE-RUNTIME-${name}`;

/**
 * A real `.tgz` holding one executable where Bun's npm package puts it.
 *
 * Made once per platform: `tar` stamps the time it ran into the archive, so two
 * calls give two different files, and the one npm vouches for has to be the
 * one it serves.
 */
const archives = new Map<string, Buffer>();

function archive(name: string): Buffer {
  const known = archives.get(name);

  if (known) {
    return known;
  }

  const src = join(box, 'src', name);
  const out = join(box, `${name}.tgz`);

  rmSync(src, { force: true, recursive: true });
  mkdirSync(join(src, 'package', 'bin'), { recursive: true });
  writeFileSync(
    join(src, 'package', 'bin', name.includes('windows') ? 'bun.exe' : 'bun'),
    runtimeFor(name)
  );

  const made = spawnSync('tar', ['-czf', out, '-C', src, '.'], { encoding: 'utf-8' });
  expect(made.status, made.stderr).toBe(0);

  const bytes = readFileSync(out);
  archives.set(name, bytes);

  return bytes;
}

/**
 * Stubs `fetch` as npm, serving a runtime for any platform at any version.
 *
 * @param options - `lying` makes the published integrity belong to some other
 *   file, which is what a mirror serving a modified archive looks like.
 * @returns Every URL requested, in order.
 */
export function serveRuntimes(options: { readonly lying?: boolean } = {}): string[] {
  const calls: string[] = [];

  vi.stubGlobal('fetch', (url: string) => {
    calls.push(url);

    const name = triple(url) ?? 'unknown';
    const bytes = archive(name);

    if (url.startsWith('https://registry.npmjs.org/@oven%2f')) {
      const of = options.lying ? Buffer.from('some other file') : bytes;

      return Promise.resolve(
        Response.json({
          dist: { integrity: `sha512-${createHash('sha512').update(of).digest('base64')}` },
        })
      );
    }

    return Promise.resolve(new Response(new Uint8Array(bytes)));
  });

  return calls;
}

/**
 * A directory holding a `bun` that embeds the runtime it is handed.
 *
 * Asked for its version it says `9.9.9`, and `9.9.9+abcdef123` for its revision
 * -- or defers to `real` when there is one -- and writes a line to `REVISIONS`
 * for each revision either way. Run as `bun build --compile` -- the form for the host's own target -- it
 * defers to `real`, or writes a placeholder binary where `--outfile` said. Run
 * as `sigil package` runs it for another platform, it copies the runtime it was
 * handed to where the binary goes.
 *
 * @param real - The real `bun` to defer to, for a test that needs one.
 * @returns The directory to put first on `PATH`.
 */
export function stubBun(real?: string): string {
  const dir = join(box, `bin-${real ? 'real' : 'fake'}`);
  const file = join(dir, 'bun');
  const fallback = real
    ? `exec '${real}' "$@"`
    : `[ "$1" = "--version" ] && { echo 9.9.9; exit 0; }
[ "$1" = "--revision" ] && { echo 9.9.9+abcdef123; exit 0; }
if [ "$1" = "build" ]; then
  for a in "$@"; do [ "$prev" = "--outfile" ] && out="$a"; prev="$a"; done
  echo PLACEHOLDER > "$out"; exit 0
fi
exit 1`;

  mkdirSync(dir, { recursive: true });
  // every `--revision` is counted: the bundler's version is read once for a run
  writeExecutable(
    file,
    `#!/bin/sh\n[ "$1" = "--revision" ] && echo asked >> '${join(dir, REVISIONS)}'\n[ "$1" = "--no-install" ] && { cp "$7" "$5"; exit 0; }\n${fallback}\n`
  );

  return dir;
}
