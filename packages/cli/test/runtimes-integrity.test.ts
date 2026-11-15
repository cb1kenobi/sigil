import { tempDir } from './temp.js';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:http';
import { dirname, join } from 'node:path';
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

/** The real `fetch`, before any test stubs it. */
const nativeFetch = globalThis.fetch;

/** Every `renameSync` the module makes, and whether the record already sat beside its target. */
const renames: { record: boolean; to: string }[] = [];

/** Runs before each rename, so a test can make one fail the way Windows does. */
let beforeRename: ((to: string) => void) | undefined;

vi.mock('node:fs', async (original) => {
  const actual = await original<typeof import('node:fs')>();

  return {
    ...actual,
    renameSync: (from: string, to: string) => {
      renames.push({
        record: actual.existsSync(join(dirname(String(to)), 'sigil-verified.json')),
        to: String(to),
      });

      beforeRename?.(String(to));

      return actual.renameSync(from, to);
    },
  };
});

vi.mock('@ttylabs/sigil/paths', () => ({
  cache: (...paths: string[]) => join(box, 'cache', ...paths),
}));

const { fetchNote, resolve } = await import('../src/build/runtimes.ts');

const VERSION = '9.9.9';
const TARGET = { arch: 'x64', platform: 'linux' } as const;
const EXE = process.platform === 'win32' ? 'exe' : '';
const NAME = (runtime: string): string => (EXE ? `${runtime}.${EXE}` : runtime);

type Runtime = 'bun' | 'node';

/** A real `.tar.gz` holding one executable where the runtime's archive puts it. */
function archive(runtime: Runtime, content: string, extra: string[] = []): Buffer {
  const src = join(box, `src-${runtime}`);
  const out = join(box, `${runtime}.tgz`);
  const inside = runtime === 'node' ? join('node-v9.9.9-x', 'bin') : join('package', 'bin');

  rmSync(src, { force: true, recursive: true });
  mkdirSync(join(src, inside), { recursive: true });
  writeFileSync(join(src, inside, NAME(runtime)), content);

  for (const [at, name] of extra.entries()) {
    mkdirSync(join(src, `extra-${at}`), { recursive: true });
    writeFileSync(join(src, `extra-${at}`, NAME(name)), `EXTRA-${at}`);
  }

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

/** The name Node publishes this host's archive under, as `downloadUrl()` spells it. */
function hostFile(): string {
  const os =
    process.platform === 'win32' ? 'win' : process.platform === 'darwin' ? 'darwin' : 'linux';
  const arch = process.arch === 'x64' ? 'x64' : 'arm64';

  return `node-v${VERSION}-${os}-${arch}.${process.platform === 'win32' ? 'zip' : 'tar.gz'}`;
}

interface Origin {
  /** What the archive URL serves. */
  readonly bytes: Buffer;
  /** What the digest document says; `undefined` serves a document with none. */
  readonly digest?: string | undefined;
  /** Replaces the whole Node digest document. */
  readonly sums?: string;
}

/** Stubs `fetch` as an origin and records every request. */
function origin(served: Origin) {
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

  return calls;
}

/** Where a cached runtime of this version is. */
const cached = (runtime: Runtime): string => join(box, 'cache', 'sigil/runtimes', runtime, VERSION);

describe('verifying a runtime against its own origin', () => {
  beforeEach(() => {
    rmSync(join(box, 'cache'), { force: true, recursive: true });
    renames.length = 0;
    beforeRename = undefined;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe('node', () => {
    it('should extract and cache an archive that matches SHASUMS256.txt', async () => {
      const bytes = archive('node', 'REAL');
      const calls = origin({ bytes, digest: sha256(bytes) });

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
      const calls = origin({ bytes, digest: sha256(bytes) });

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
      origin({ bytes, digest: expected });

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
      const calls = origin({ bytes, sums: shasums(sha256(bytes), '1.2.3') });

      await expect(resolve('node', VERSION, TARGET)).rejects.toThrow(
        /has no line for node-v9\.9\.9/
      );

      expect(calls.map((one) => one.url)).toEqual([
        'https://nodejs.org/dist/v9.9.9/SHASUMS256.txt',
      ]);
      expect(existsSync(cached('node'))).toBe(false);
    });

    it('should use the line for exactly this archive, whatever the other lines say', async () => {
      // every filename used to carry one digest, so a prefix or suffix match
      // passed all of the above; here every other line is a different digest
      const good = archive('node', 'REAL');
      const evil = archive('node', 'EVIL');
      const file = hostFile();
      const lines = [
        `${sha256(evil)}  x${file}`,
        `${sha256(evil)}  ${file}.asc`,
        `${sha256(evil)}  node-v${VERSION}-linux-ppc64le.tar.gz`,
        `${sha256(good)}  ${file}`,
      ].join('\n');

      origin({ bytes: good, sums: lines });
      expect(readFileSync(await resolve('node', VERSION, TARGET), 'utf-8')).toBe('REAL');

      // and the same document refuses the file a lookalike line vouches for
      rmSync(join(box, 'cache'), { force: true, recursive: true });
      origin({ bytes: evil, sums: lines });
      await expect(resolve('node', VERSION, TARGET)).rejects.toThrow(/does not match the sha256/);
    });

    it('should refuse a SHASUMS256.txt that lists the archive with two different digests', async () => {
      const bytes = archive('node', 'REAL');
      const calls = origin({
        bytes,
        sums: `${sha256(bytes)}  ${hostFile()}\n${sha256(Buffer.from('other'))}  ${hostFile()}\n`,
      });

      await expect(resolve('node', VERSION, TARGET)).rejects.toThrow(/2 different digests/);

      expect(calls).toHaveLength(1);
      expect(existsSync(cached('node'))).toBe(false);
    });

    it('should not take an executable a dead process left behind over the verified archive', async () => {
      // `.partial-<pid>` was reused by a later process with the same pid and
      // never emptied, so `findBinary()` returned the first `node` it met in it
      // -- and that was hashed into the record as verified
      const root = join(box, 'cache', 'sigil/runtimes', 'node');
      for (const name of ['0', 'a', 'z']) {
        mkdirSync(join(root, `${VERSION}.partial-${process.pid}`, name), { recursive: true });
        writeFileSync(
          join(root, `${VERSION}.partial-${process.pid}`, name, NAME('node')),
          `STALE-${name}`
        );
      }

      const bytes = archive('node', 'REAL');
      origin({ bytes, digest: sha256(bytes) });

      expect(readFileSync(await resolve('node', VERSION, TARGET), 'utf-8')).toBe('REAL');
    });

    it('should refuse an archive that holds more than one executable', async () => {
      const bytes = archive('node', 'REAL', ['node']);
      origin({ bytes, digest: sha256(bytes) });

      await expect(resolve('node', VERSION, TARGET)).rejects.toThrow(/holds 2 files named/);

      expect(existsSync(cached('node'))).toBe(false);
    });

    it('should write the record, atomically, before the executable is in place', async () => {
      const bytes = archive('node', 'REAL');
      origin({ bytes, digest: sha256(bytes) });

      await resolve('node', VERSION, TARGET);

      const binary = renames.find((one) => one.to === join(cached('node'), NAME('node')));
      const record = renames.find((one) => one.to === join(cached('node'), 'sigil-verified.json'));

      // the record arrived by rename, so it was never visible half written, and
      // it was already there when the executable arrived beside it
      expect(record).toBeDefined();
      expect(binary?.record).toBe(true);
    });
  });

  describe('a request that fails', () => {
    it('should say a redirect was refused, naming the URL, rather than "fetch failed"', async () => {
      // a real `fetch` against a local server that redirects: the reason lives
      // in undici's `cause`, which nothing downstream renders
      const server = createServer((_, response) => {
        response.writeHead(302, { Location: 'http://127.0.0.1:1/elsewhere' });
        response.end();
      });
      await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
      const address = server.address() as { port: number };
      vi.stubGlobal('fetch', (_: string, init?: RequestInit) =>
        nativeFetch(`http://127.0.0.1:${address.port}/x`, init)
      );

      try {
        const refusal = await resolve('node', VERSION, TARGET).catch((error: Error) => error);

        expect((refusal as Error).message).toContain('Refusing node 9.9.9');
        expect((refusal as Error).message).toContain(
          'https://nodejs.org/dist/v9.9.9/SHASUMS256.txt answered with a redirect'
        );
        expect((refusal as Error).message).not.toBe('fetch failed');
      } finally {
        server.close();
      }
    });

    it('should say why a request could not be made, and that this needs the network', async () => {
      vi.stubGlobal('fetch', () =>
        Promise.reject(
          new TypeError('fetch failed', { cause: new Error('getaddrinfo ENOTFOUND nodejs.org') })
        )
      );

      const refusal = await resolve('node', VERSION, TARGET).catch((error: Error) => error);

      expect((refusal as Error).message).toContain('Could not download node 9.9.9');
      expect((refusal as Error).message).toContain('getaddrinfo ENOTFOUND nodejs.org');
      expect((refusal as Error).message).toContain('SHASUMS256.txt');
      expect((refusal as Error).message).toContain('needs the network');
    });

    it('should name a refused connection on a dual-stack host, whose message is empty', async () => {
      // undici's cause for a failed happy-eyeballs connect: an AggregateError
      // with message '' and the answer in `code` and `errors`
      const cause = Object.assign(
        new AggregateError([new Error('connect ECONNREFUSED ::1:443')], ''),
        { code: 'ECONNREFUSED' }
      );
      vi.stubGlobal('fetch', () => Promise.reject(new TypeError('fetch failed', { cause })));

      const refusal = await resolve('node', VERSION, TARGET).catch((error: Error) => error);

      expect((refusal as Error).message).toContain('could not be fetched (ECONNREFUSED)');
    });

    it('should fall back to the nested errors when there is neither a message nor a code', async () => {
      const cause = new AggregateError([new Error('connect ECONNREFUSED ::1:443')], '');
      vi.stubGlobal('fetch', () => Promise.reject(new TypeError('fetch failed', { cause })));

      const refusal = await resolve('node', VERSION, TARGET).catch((error: Error) => error);

      expect((refusal as Error).message).toContain('(connect ECONNREFUSED ::1:443)');
    });

    it('should not echo a control character the network put in the reason', async () => {
      vi.stubGlobal('fetch', () =>
        Promise.reject(
          new TypeError('fetch failed', { cause: new Error('bad \u001b[31mred\u001b[0m reply') })
        )
      );

      const refusal = await resolve('node', VERSION, TARGET).catch((error: Error) => error);

      expect((refusal as Error).message).not.toContain('\u001b');
      expect((refusal as Error).message).toContain('red');
    });

    it('should say so when the archive is cut off while it is being read', async () => {
      // the archive is tens of megabytes, so it is the read most likely to fail,
      // and a reset mid-body is a bare `terminated` that skipped the wrapping
      const bytes = archive('node', 'REAL');
      vi.stubGlobal('fetch', (url: string) =>
        Promise.resolve(
          url.endsWith('/SHASUMS256.txt')
            ? new Response(shasums(sha256(bytes)))
            : new Response(
                new ReadableStream({
                  pull(controller) {
                    controller.error(
                      new TypeError('terminated', { cause: new Error('other side closed') })
                    );
                  },
                })
              )
        )
      );

      const refusal = await resolve('node', VERSION, TARGET).catch((error: Error) => error);

      expect((refusal as Error).message).toContain('Could not download node 9.9.9');
      expect((refusal as Error).message).toContain(
        'was cut off while it was being read (other side closed)'
      );
      expect(existsSync(cached('node'))).toBe(false);
    });

    it("should say so when Bun's version document is a page rather than JSON", async () => {
      // a captive portal answers 200 with HTML
      vi.stubGlobal('fetch', () =>
        Promise.resolve(
          new Response('<html>sign in</html>', { headers: { 'content-type': 'text/html' } })
        )
      );

      const refusal = await resolve('bun', VERSION, TARGET).catch((error: Error) => error);

      expect(refusal).not.toBeInstanceOf(SyntaxError);
      expect((refusal as Error).message).toContain('did not answer with JSON');
      expect((refusal as Error).message).toContain('Nothing was downloaded, extracted or run');
    });
  });

  describe('bun', () => {
    it('should extract and cache a tarball that matches its npm integrity', async () => {
      const bytes = archive('bun', 'REAL');
      const calls = origin({ bytes, digest: sha512(bytes) });

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
      origin({ bytes, digest: expected });

      const refusal = await resolve('bun', VERSION, TARGET).catch((error: Error) => error);

      expect((refusal as Error).message).toContain('Refusing bun 9.9.9');
      expect((refusal as Error).message).toContain('sha512:');
      expect((refusal as Error).message).toContain('Nothing was extracted or run');
      expect(existsSync(cached('bun'))).toBe(false);
    });

    it('should refuse when the registry publishes no sha512 integrity, and not fetch the tarball', async () => {
      const bytes = archive('bun', 'REAL');
      const calls = origin({ bytes, digest: undefined });

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
      origin({ bytes, digest: sha256(bytes) });

      const path = await resolve('node', VERSION, TARGET);
      vi.unstubAllGlobals();

      return path;
    }

    it('should be used without a request while it matches its record', async () => {
      const path = await seed();
      const calls = origin({ bytes: Buffer.alloc(0), digest: '' });

      expect(await resolve('node', VERSION, TARGET)).toBe(path);
      expect(calls).toHaveLength(0);
    });

    it('should be discarded and fetched again when the executable no longer matches its record', async () => {
      const path = await seed();
      writeFileSync(path, 'TAMPERED');

      const bytes = archive('node', 'REAL');
      const calls = origin({ bytes, digest: sha256(bytes) });

      expect(readFileSync(await resolve('node', VERSION, TARGET), 'utf-8')).toBe('REAL');
      expect(calls.length).toBeGreaterThan(0);
    });

    it('should say why a copy was removed, and say nothing of the kind for one never fetched', async () => {
      const path = await seed();
      const said: (string | undefined)[] = [];
      const bytes = archive('node', 'REAL');
      origin({ bytes, digest: sha256(bytes) });

      writeFileSync(path, 'TAMPERED');
      await resolve('node', VERSION, TARGET, (_, why) => said.push(why));
      rmSync(join(cached('node'), 'sigil-verified.json'));
      await resolve('node', VERSION, TARGET, (_, why) => said.push(why));
      rmSync(cached('node'), { force: true, recursive: true });
      await resolve('node', VERSION, TARGET, (_, why) => said.push(why));

      // present but not parseable is not the same thing to be told as absent
      await resolve('node', VERSION, TARGET);
      writeFileSync(join(cached('node'), 'sigil-verified.json'), '{ not json');
      await resolve('node', VERSION, TARGET, (_, why) => said.push(why));

      expect(said).toEqual([
        'no longer matches its verification record',
        'has no verification record',
        undefined,
        'has no readable verification record',
      ]);
    });

    it('should say what happened in the note `sigil package` prints', () => {
      expect(fetchNote('node', '9.9.9')).toBe(
        'Fetching node 9.9.9, which is not on this machine...'
      );
      expect(fetchNote('node', '9.9.9', 'has no verification record')).toBe(
        'The cached node 9.9.9 has no verification record, so it was removed. Fetching it again...'
      );
      expect(fetchNote('bun', '9.9.9', 'no longer matches its verification record')).toBe(
        'The cached bun 9.9.9 no longer matches its verification record, so it was removed. Fetching it again...'
      );
    });

    it('should be discarded and fetched again when it has no record', async () => {
      // what every entry written before this existed looks like
      const path = await seed();
      rmSync(join(cached('node'), 'sigil-verified.json'));
      void path;

      const bytes = archive('node', 'REAL');
      const calls = origin({ bytes, digest: sha256(bytes) });

      await resolve('node', VERSION, TARGET);

      expect(calls.length).toBeGreaterThan(0);
      expect(existsSync(join(cached('node'), 'sigil-verified.json'))).toBe(true);
    });

    it('should not be replaced by a tampered one that the origin then refuses', async () => {
      // a mismatched cache entry is removed even when the re-download fails, so a
      // refusal never leaves the unverified binary behind to be used next time
      const path = await seed();
      writeFileSync(path, 'TAMPERED');
      origin({ bytes: Buffer.from('not an archive'), digest: sha256(Buffer.from('x')) });

      await expect(resolve('node', VERSION, TARGET)).rejects.toThrow(/Refusing node 9\.9\.9/);

      expect(existsSync(path)).toBe(false);
    });
  });

  describe('a download interrupted before it could clean up', () => {
    const root = (): string => join(box, 'cache', 'sigil/runtimes', 'node');

    /** A scratch directory as an interrupted run leaves it, last touched `age` ms ago. */
    function leave(name: string, age: number): string {
      const at = join(root(), name);
      mkdirSync(at, { recursive: true });
      writeFileSync(join(at, 'half-extracted'), 'x');
      const when = new Date(Date.now() - age);
      utimesSync(at, when, when);

      return at;
    }

    it('should remove a scratch directory an hour old and leave a fresh one alone', async () => {
      // Ctrl-C skips the `finally`, so each interrupted run left one for good --
      // and a fresh one may be a concurrent build's live download
      const old = leave('9.9.1.partial-OLDOLD', 2 * 60 * 60 * 1000);
      const fresh = leave('9.9.1.partial-FRESH1', 1000);
      const other = leave('not-a-scratch-dir', 2 * 60 * 60 * 1000);

      const bytes = archive('node', 'REAL');
      origin({ bytes, digest: sha256(bytes) });
      await resolve('node', VERSION, TARGET);

      expect(existsSync(old)).toBe(false);
      expect(existsSync(fresh)).toBe(true);
      expect(existsSync(other)).toBe(true);
    });
  });

  describe('a rename over an executable that is in use', () => {
    // Windows refuses to replace a `node.exe` another build is running. The
    // other build put the same verified bytes there
    function refuse(content: string): void {
      beforeRename = (to) => {
        if (to === join(cached('node'), NAME('node'))) {
          writeFileSync(to, content);
          throw Object.assign(new Error('EPERM: operation not permitted, rename'), {
            code: 'EPERM',
          });
        }
      };
    }

    it('should use what is there when it answers to the record', async () => {
      const bytes = archive('node', 'REAL');
      origin({ bytes, digest: sha256(bytes) });
      refuse('REAL');

      const path = await resolve('node', VERSION, TARGET);

      expect(readFileSync(path, 'utf-8')).toBe('REAL');
    });

    it('should fail, and remove the entry, when what is there does not', async () => {
      const bytes = archive('node', 'REAL');
      origin({ bytes, digest: sha256(bytes) });
      refuse('SOMETHING ELSE');

      await expect(resolve('node', VERSION, TARGET)).rejects.toThrow(/EPERM/);

      expect(existsSync(cached('node'))).toBe(false);
    });
  });
});
