import { tempDir } from './temp.js';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * A runtime is verified against its own origin's digest before it is extracted,
 * and again every time it is used from the cache (SIG-411).
 *
 * No network: `fetch` is stubbed with what each origin would answer, and the
 * archives are real `tar` archives built here, so a download that passes goes
 * through the real extraction. `cache()` is mocked for the reason
 * `runtimes-cache.test.ts` records -- `XDG_CACHE_HOME` is ignored on macOS --
 * and the file is its own because `vi.mock` is module-wide.
 *
 * The version is one no machine has, so `local()` never answers from `PATH` or
 * Bun's own cache and every case reaches the download or the cache record.
 */

const box = tempDir('sigil-integrity-');

vi.mock('@ttylabs/sigil/paths', () => ({
  cache: (...paths: string[]) => join(box, 'cache', ...paths),
}));

const { resolve } = await import('../src/build/runtimes.ts');

const VERSION = '9.9.9';
const TARGET = { arch: 'x64', platform: 'linux' } as const;
const EXE = process.platform === 'win32' ? 'exe' : '';
const NAME = (runtime: string): string => (EXE ? `${runtime}.${EXE}` : runtime);

type Runtime = 'bun' | 'node';

/** A real `.tar.gz` holding one executable where the runtime's archive puts it. */
function archive(runtime: Runtime, content: string): Buffer {
  const src = join(box, `src-${runtime}`);
  const out = join(box, `${runtime}.tgz`);
  const inside = runtime === 'node' ? join('node-v9.9.9-x', 'bin') : join('package', 'bin');

  rmSync(src, { force: true, recursive: true });
  mkdirSync(join(src, inside), { recursive: true });
  writeFileSync(join(src, inside, NAME(runtime)), content);

  const made = spawnSync('tar', ['-czf', out, '-C', src, '.'], { encoding: 'utf-8' });
  expect(made.status, made.stderr).toBe(0);

  return readFileSync(out);
}

const sha256 = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');
const sha512 = (bytes: Buffer): string => createHash('sha512').update(bytes).digest('base64');

/** Every file name Node could publish this version's archive under, with one digest. */
function shasums(digest: string, version = VERSION): string {
  const names = ['darwin', 'linux', 'win'].flatMap((os) =>
    ['x64', 'arm64'].flatMap((arch) =>
      ['tar.gz', 'zip'].map((ext) => `node-v${version}-${os}-${arch}.${ext}`)
    )
  );

  return `${names.map((name) => `${digest}  ${name}`).join('\n')}\n`;
}

interface Origin {
  /** What the archive URL serves. */
  readonly bytes: Buffer;
  /** What the digest document says; `undefined` serves a document with none. */
  readonly digest?: string | undefined;
  /** Replaces the whole Node digest document. */
  readonly sums?: string;
}

/** Stubs `fetch` as the origin of `runtime` and records every request. */
function origin(runtime: Runtime, served: Origin) {
  const calls: { init: RequestInit | undefined; url: string }[] = [];

  vi.stubGlobal('fetch', (url: string, init?: RequestInit) => {
    calls.push({ init, url });

    if (url.endsWith('/SHASUMS256.txt')) {
      return Promise.resolve(new Response(served.sums ?? shasums(served.digest ?? '')));
    }

    if (url.startsWith('https://registry.npmjs.org/@oven%2f')) {
      const integrity = served.digest === undefined ? {} : { integrity: `sha512-${served.digest}` };

      return Promise.resolve(Response.json({ dist: integrity }));
    }

    return Promise.resolve(new Response(new Uint8Array(served.bytes)));
  });

  void runtime;

  return calls;
}

/** Where a cached runtime of this version is. */
const cached = (runtime: Runtime): string => join(box, 'cache', 'sigil/runtimes', runtime, VERSION);

describe('verifying a runtime against its own origin', () => {
  beforeEach(() => {
    rmSync(join(box, 'cache'), { force: true, recursive: true });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe('node', () => {
    it('should extract and cache an archive that matches SHASUMS256.txt', async () => {
      const bytes = archive('node', 'REAL');
      const calls = origin('node', { bytes, digest: sha256(bytes) });

      const path = await resolve('node', VERSION, TARGET);

      expect(path).toBe(join(cached('node'), NAME('node')));
      expect(readFileSync(path, 'utf-8')).toBe('REAL');
      expect(existsSync(join(cached('node'), 'sigil-verified.json'))).toBe(true);
      // the digest document and the archive, both from nodejs.org
      expect(calls.map((one) => one.url.split('/').slice(0, 5).join('/'))).toEqual([
        'https://nodejs.org/dist/v9.9.9',
        'https://nodejs.org/dist/v9.9.9',
      ]);
    });

    it('should follow no redirect on any request it makes', async () => {
      const bytes = archive('node', 'REAL');
      const calls = origin('node', { bytes, digest: sha256(bytes) });

      await resolve('node', VERSION, TARGET);

      expect(calls.length).toBeGreaterThan(0);
      expect(calls.map((one) => one.init?.redirect)).toEqual(calls.map(() => 'error'));
    });

    it('should refuse an archive that does not match its published digest, before extracting it', async () => {
      // the served bytes are not an archive at all, so a refusal that came from
      // `tar` would say `Could not extract`: asserting the digest message is
      // asserting it was the digest that stopped it, and that nothing parsed it
      const bytes = Buffer.from('not an archive');
      const expected = sha256(archive('node', 'REAL'));
      origin('node', { bytes, digest: expected });

      const refusal = await resolve('node', VERSION, TARGET).catch((error: Error) => error);

      expect(refusal).toBeInstanceOf(Error);
      expect((refusal as Error).message).toContain('Refusing node 9.9.9');
      expect((refusal as Error).message).toContain(`expected sha256:${expected}`);
      expect((refusal as Error).message).toContain(`got      sha256:${sha256(bytes)}`);
      expect((refusal as Error).message).toContain('Nothing was extracted or run');
      expect(existsSync(cached('node'))).toBe(false);
      expect(readdirSync(join(box, 'cache', 'sigil/runtimes', 'node'))).toEqual([]);
    });

    it('should refuse when SHASUMS256.txt has no line for the archive, and not fetch it', async () => {
      const bytes = archive('node', 'REAL');
      const calls = origin('node', { bytes, sums: shasums(sha256(bytes), '1.2.3') });

      await expect(resolve('node', VERSION, TARGET)).rejects.toThrow(
        /has no line for node-v9\.9\.9/
      );

      expect(calls.map((one) => one.url)).toEqual([
        'https://nodejs.org/dist/v9.9.9/SHASUMS256.txt',
      ]);
      expect(existsSync(cached('node'))).toBe(false);
    });
  });

  describe('bun', () => {
    it('should extract and cache a tarball that matches its npm integrity', async () => {
      const bytes = archive('bun', 'REAL');
      const calls = origin('bun', { bytes, digest: sha512(bytes) });

      const path = await resolve('bun', VERSION, TARGET);

      expect(readFileSync(path, 'utf-8')).toBe('REAL');
      // the version document of the platform package, then its tarball
      expect(calls[0]?.url).toMatch(
        /^https:\/\/registry\.npmjs\.org\/@oven%2fbun-[a-z]+-[a-z0-9]+\/9\.9\.9$/
      );
      expect(calls[1]?.url).toMatch(/\/-\/bun-[a-z]+-[a-z0-9]+-9\.9\.9\.tgz$/);
      expect(calls.map((one) => one.init?.redirect)).toEqual(['error', 'error']);
    });

    it('should refuse a tarball that does not match its integrity, before extracting it', async () => {
      const bytes = Buffer.from('not an archive');
      const expected = sha512(archive('bun', 'REAL'));
      origin('bun', { bytes, digest: expected });

      const refusal = await resolve('bun', VERSION, TARGET).catch((error: Error) => error);

      expect((refusal as Error).message).toContain('Refusing bun 9.9.9');
      expect((refusal as Error).message).toContain('sha512:');
      expect((refusal as Error).message).toContain('Nothing was extracted or run');
      expect(existsSync(cached('bun'))).toBe(false);
    });

    it('should refuse when the registry publishes no sha512 integrity, and not fetch the tarball', async () => {
      const bytes = archive('bun', 'REAL');
      const calls = origin('bun', { bytes, digest: undefined });

      await expect(resolve('bun', VERSION, TARGET)).rejects.toThrow(
        /publishes no sha512 integrity/
      );

      expect(calls).toHaveLength(1);
      expect(existsSync(cached('bun'))).toBe(false);
    });
  });

  describe('a runtime already in the cache', () => {
    async function seed(): Promise<string> {
      const bytes = archive('node', 'REAL');
      origin('node', { bytes, digest: sha256(bytes) });

      const path = await resolve('node', VERSION, TARGET);
      vi.unstubAllGlobals();

      return path;
    }

    it('should be used without a request while it matches its record', async () => {
      const path = await seed();
      const calls = origin('node', { bytes: Buffer.alloc(0), digest: '' });

      expect(await resolve('node', VERSION, TARGET)).toBe(path);
      expect(calls).toHaveLength(0);
    });

    it('should be discarded and fetched again when the executable no longer matches its record', async () => {
      const path = await seed();
      writeFileSync(path, 'TAMPERED');

      const bytes = archive('node', 'REAL');
      const calls = origin('node', { bytes, digest: sha256(bytes) });

      expect(readFileSync(await resolve('node', VERSION, TARGET), 'utf-8')).toBe('REAL');
      expect(calls.length).toBeGreaterThan(0);
    });

    it('should be discarded and fetched again when it has no record', async () => {
      // what every entry written before this existed looks like
      const path = await seed();
      rmSync(join(cached('node'), 'sigil-verified.json'));
      void path;

      const bytes = archive('node', 'REAL');
      const calls = origin('node', { bytes, digest: sha256(bytes) });

      await resolve('node', VERSION, TARGET);

      expect(calls.length).toBeGreaterThan(0);
      expect(existsSync(join(cached('node'), 'sigil-verified.json'))).toBe(true);
    });

    it('should not be replaced by a tampered one that the origin then refuses', async () => {
      // a mismatched cache entry is removed even when the re-download fails, so a
      // refusal never leaves the unverified binary behind to be used next time
      const path = await seed();
      writeFileSync(path, 'TAMPERED');
      origin('node', { bytes: Buffer.from('not an archive'), digest: sha256(Buffer.from('x')) });

      await expect(resolve('node', VERSION, TARGET)).rejects.toThrow(/Refusing node 9\.9\.9/);

      expect(existsSync(path)).toBe(false);
    });
  });
});
