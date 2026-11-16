import { tempDir } from './temp.js';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The runtime embedded for a Bun target that is not this machine's is checked
 * against npm's own digest for it, like the one sigil runs (SIG-442).
 *
 * `bun build --compile --target=bun-<other>` downloads that platform's runtime
 * itself and embeds it unchecked, so a cross target goes through
 * `bunTargetRuntime()`, which fetches `@oven/bun-<triple>` and verifies it by
 * the steps SIG-411 put on a host download. No network: `fetch` is stubbed, the
 * archives are real `tar` archives, and `cache()` is mocked for the reason
 * `runtimes-cache.test.ts` records.
 *
 * The `bun` that reports a version is a shell script, so the cases that ask it
 * are POSIX only: the version is a fact about an executable and a stub is the
 * only way to give one a version no machine has.
 */

const box = tempDir('sigil-target-');

vi.mock('@ttylabs/sigil/paths', () => ({
  cache: (...paths: string[]) => join(box, 'cache', ...paths),
}));

const { bunTargetRuntime, bunVersion, fetchNote, local } = await import('../src/build/runtimes.ts');

const VERSION = '9.9.9';
const POSIX = process.platform !== 'win32';

const sha512 = (bytes: Buffer): string => createHash('sha512').update(bytes).digest('base64');

/** A `bun` that says one thing for `--version`. */
function stub(said: string): string {
  const path = join(box, `bun-says-${createHash('sha1').update(said).digest('hex')}`);

  writeFileSync(path, `#!/bin/sh\necho '${said}'\n`, { mode: 0o755 });

  return path;
}

/** A real `.tgz` holding one executable where Bun's npm package puts it. */
function archive(name: string, content: string): Buffer {
  const src = join(box, 'src');
  const out = join(box, 'bun.tgz');

  rmSync(src, { force: true, recursive: true });
  mkdirSync(join(src, 'package', 'bin'), { recursive: true });
  writeFileSync(join(src, 'package', 'bin', name), content);

  const made = spawnSync('tar', ['-czf', out, '-C', src, '.'], { encoding: 'utf-8' });
  expect(made.status, made.stderr).toBe(0);

  return readFileSync(out);
}

/** Stubs `fetch` as npm and records every request. */
function npm(served: { bytes: Buffer; integrity?: string | undefined }) {
  const calls: string[] = [];

  vi.stubGlobal('fetch', (url: string) => {
    calls.push(url);

    if (url.startsWith('https://registry.npmjs.org/@oven%2f')) {
      const dist =
        served.integrity === undefined ? {} : { integrity: `sha512-${served.integrity}` };

      return Promise.resolve(Response.json({ dist }));
    }

    return Promise.resolve(new Response(new Uint8Array(served.bytes)));
  });

  return calls;
}

const LINUX = { arch: 'x64', platform: 'linux' } as const;
const WINDOWS = { arch: 'x64', platform: 'windows' } as const;
const MAC = { arch: 'arm64', platform: 'darwin' } as const;

/** Where a cross target's runtime is cached. */
const at = (triple: string, name = 'bun'): string =>
  join(box, 'cache', 'sigil/runtimes/bun-targets', triple, VERSION, name);

describe.skipIf(!POSIX)('the runtime embedded for another platform', () => {
  let exec: string;

  beforeEach(() => {
    rmSync(join(box, 'cache'), { force: true, recursive: true });
    exec = stub(VERSION);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("should be the target's own npm package, checked against its integrity and cached beside a record", async () => {
    const bytes = archive('bun', 'LINUX-RUNTIME');
    const calls = npm({ bytes, integrity: sha512(bytes) });

    const path = await bunTargetRuntime(exec, LINUX);

    expect(path).toBe(at('bun-linux-x64'));
    expect(readFileSync(path, 'utf-8')).toBe('LINUX-RUNTIME');
    expect(calls).toEqual([
      'https://registry.npmjs.org/@oven%2fbun-linux-x64/9.9.9',
      'https://registry.npmjs.org/@oven/bun-linux-x64/-/bun-linux-x64-9.9.9.tgz',
    ]);

    const record = JSON.parse(readFileSync(join(path, '..', 'sigil-verified.json'), 'utf-8'));
    expect(record).toMatchObject({ runtime: 'bun', target: 'bun-linux-x64', version: VERSION });
  });

  it("should be a Windows target's bun.exe, from the Windows package", async () => {
    const bytes = archive('bun.exe', 'WINDOWS-RUNTIME');
    const calls = npm({ bytes, integrity: sha512(bytes) });

    const path = await bunTargetRuntime(exec, WINDOWS);

    expect(path).toBe(at('bun-windows-x64', 'bun.exe'));
    expect(readFileSync(path, 'utf-8')).toBe('WINDOWS-RUNTIME');
    expect(calls[1]).toBe(
      'https://registry.npmjs.org/@oven/bun-windows-x64/-/bun-windows-x64-9.9.9.tgz'
    );
  });

  it('should spell arm64 the way npm does', async () => {
    const bytes = archive('bun', 'MAC-RUNTIME');
    const calls = npm({ bytes, integrity: sha512(bytes) });

    await bunTargetRuntime(exec, MAC);

    expect(calls[0]).toBe('https://registry.npmjs.org/@oven%2fbun-darwin-aarch64/9.9.9');
    expect(existsSync(at('bun-darwin-aarch64'))).toBe(true);
  });

  it('should be refused when the package does not match what npm publishes for it', async () => {
    const wanted = sha512(archive('bun', 'REAL'));
    const bytes = Buffer.from('not what npm published');
    npm({ bytes, integrity: wanted });

    const refusal = await bunTargetRuntime(exec, LINUX).catch((error: Error) => error);

    expect(refusal).toBeInstanceOf(Error);
    expect((refusal as Error).message).toContain('Refusing bun 9.9.9');
    expect((refusal as Error).message).toContain('bun-linux-x64-9.9.9.tgz');
    expect((refusal as Error).message).toContain('Nothing was extracted or run');
    expect(existsSync(at('bun-linux-x64'))).toBe(false);
    expect(readdirSync(join(box, 'cache', 'sigil/runtimes/bun-targets/bun-linux-x64'))).toEqual([]);
  });

  it('should be refused when npm publishes no integrity to check it against', async () => {
    const bytes = archive('bun', 'REAL');
    const calls = npm({ bytes });

    await expect(bunTargetRuntime(exec, LINUX)).rejects.toThrow(/publishes no sha512 integrity/);

    // the document only: nothing was downloaded to be left unchecked
    expect(calls).toHaveLength(1);
    expect(existsSync(at('bun-linux-x64'))).toBe(false);
  });

  it('should be used from the cache, without a request, while it still matches its record', async () => {
    const bytes = archive('bun', 'LINUX-RUNTIME');
    npm({ bytes, integrity: sha512(bytes) });
    await bunTargetRuntime(exec, LINUX);

    const calls = npm({ bytes: Buffer.from('never read') });
    const again = await bunTargetRuntime(exec, LINUX);

    expect(again).toBe(at('bun-linux-x64'));
    expect(calls).toEqual([]);
  });

  it('should be discarded and fetched again when the cached copy no longer matches its record', async () => {
    const bytes = archive('bun', 'LINUX-RUNTIME');
    npm({ bytes, integrity: sha512(bytes) });
    await bunTargetRuntime(exec, LINUX);
    writeFileSync(at('bun-linux-x64'), 'SWAPPED');

    const calls = npm({ bytes, integrity: sha512(bytes) });
    const told: (string | undefined)[] = [];
    const path = await bunTargetRuntime(exec, LINUX, (_, discarded) => told.push(discarded));

    expect(readFileSync(path, 'utf-8')).toBe('LINUX-RUNTIME');
    expect(told).toEqual(['no longer matches its verification record']);
    expect(calls).toHaveLength(2);
  });

  it("should not take another platform's verified copy for its own", async () => {
    // a record says what it was verified as, and a directory can be copied: the
    // Linux runtime put where the Mac one belongs is a binary that matches its
    // record and is not a runtime for that target
    const bytes = archive('bun', 'LINUX-RUNTIME');
    npm({ bytes, integrity: sha512(bytes) });
    await bunTargetRuntime(exec, LINUX);

    mkdirSync(join(at('bun-darwin-aarch64'), '..'), { recursive: true });
    for (const file of ['bun', 'sigil-verified.json']) {
      copyFileSync(
        join(at('bun-linux-x64'), '..', file),
        join(at('bun-darwin-aarch64'), '..', file)
      );
    }

    const mac = archive('bun', 'MAC-RUNTIME');
    const calls = npm({ bytes: mac, integrity: sha512(mac) });
    const path = await bunTargetRuntime(exec, MAC);

    expect(readFileSync(path, 'utf-8')).toBe('MAC-RUNTIME');
    expect(calls).toHaveLength(2);
  });

  it('should never be offered as a bundler this machine could run', async () => {
    const bytes = archive('bun', 'LINUX-RUNTIME');
    npm({ bytes, integrity: sha512(bytes) });
    await bunTargetRuntime(exec, LINUX);

    expect(local('bun', LINUX).map((one) => one.version)).not.toContain(VERSION);
  });

  it("should be the bundler's version, asked of the bundler", async () => {
    const bytes = archive('bun', 'LINUX-RUNTIME');
    const calls = npm({ bytes, integrity: sha512(bytes) });

    await bunTargetRuntime(stub('1.2.3'), LINUX).catch(() => undefined);

    expect(calls[0]).toBe('https://registry.npmjs.org/@oven%2fbun-linux-x64/1.2.3');
  });

  it('should be refused for a bundler that is not a release, with nothing fetched', async () => {
    const calls = npm({ bytes: archive('bun', 'X'), integrity: 'x' });

    await expect(bunTargetRuntime(stub('1.5.0-canary.20260101.1'), LINUX)).rejects.toThrow(
      /did not report a release version/
    );

    expect(calls).toEqual([]);
  });
});

describe('what a bundler reports', () => {
  it.skipIf(!POSIX)('should be a release version and nothing else', () => {
    expect(bunVersion(stub('1.4.4'))).toBe('1.4.4');
    expect(() => bunVersion(stub('1.4.4-canary.1'))).toThrow(/release version/);
    expect(() => bunVersion(stub('../../x'))).toThrow(/release version/);
  });

  it('should say which platform a fetch is for', () => {
    expect(fetchNote('bun', '1.4.4', undefined, LINUX)).toBe(
      'Fetching bun 1.4.4 runtime for bun-linux-x64, which is not on this machine...'
    );
    expect(fetchNote('bun', '1.4.4', 'has no verification record', LINUX)).toContain(
      'The cached bun 1.4.4 runtime for bun-linux-x64 has no verification record'
    );
    expect(fetchNote('bun', '1.4.4')).toBe('Fetching bun 1.4.4, which is not on this machine...');
  });
});
