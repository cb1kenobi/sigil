import { main } from '../src/index.js';
import { setQuiet } from '../src/style/output.js';
import { beginUpdateCheck, skipReason, updateCheckOptions } from '../src/updates/auto.js';
import { githubChecker, isChecker, isNewer, npmChecker } from '../src/updates/checker.js';
import { cacheFileName } from '../src/updates/registry.js';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `updateCheck: true` on the schema, which is `check()` called for you.
 *
 * Every case here is offline: a **fresh** cache is seeded, so `check()` answers
 * from it and spawns nothing, and the policy around it is what is under test --
 * who is told, when, and in what words.
 */

const tty = { isTTY: true, write: vi.fn() };

/** A cache holding what `check()` would have found yesterday. */
function seed(dir: string, name: string, latest: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, cacheFileName(name, 'latest')),
    JSON.stringify({ body: { latest }, ts: Date.now() })
  );
}

describe('isNewer', () => {
  it.each([
    ['1.2.0', '1.1.9', true],
    ['2.0.0', '1.99.99', true],
    ['1.0.10', '1.0.9', true],
    ['1.0.0', '1.0.0', false],
    ['1.0.0', '1.0.1', false],
    // a build newer than the published one is not out of date
    ['1.0.0', '2.0.0-rc.1', false],
    ['v1.2.0', '1.1.0', true],
    // a release outranks its own pre-release, and not the other way round
    ['1.0.0', '1.0.0-rc.1', true],
    ['1.0.0-rc.1', '1.0.0', false],
    ['1.0.0-rc.2', '1.0.0-rc.1', true],
    ['1.0.0-rc.10', '1.0.0-rc.9', true],
    ['1.0.0-rc.1', '1.0.0-rc', true],
    ['1.0.0-beta', '1.0.0-alpha', true],
    ['1.0.0-1', '1.0.0-alpha', false],
    ['1.2', '1.1.9', true],
  ])('should say %s over %s is %s', (latest, current, expected) => {
    expect(isNewer(latest, current)).toBe(expected);
  });

  it('should never call a version it cannot read newer', () => {
    // `latest !== current` is the bug this exists to not have: it tells the
    // owner of a git-sha or calendar version they are out of date on every run
    for (const [latest, current] of [
      ['2026.10.1', 'abc1234'],
      ['abc1234', '1.0.0'],
      ['', '1.0.0'],
      ['nonsense', 'nonsense'],
    ]) {
      expect(isNewer(latest!, current!), `${latest} over ${current}`).toBe(false);
    }
  });
});

describe('what updateCheck may be', () => {
  const custom = { path: ['version'], type: 'custom', url: 'https://example.com/latest.json' };

  it('should take true as the defaults', () => {
    expect(updateCheckOptions(true)).toEqual({});
  });

  it.each([
    ['a github checker', githubChecker({ repo: 'acme/mycli' })],
    ['an npm checker', npmChecker({ packageName: 'mycli' })],
    ['a checker written out', custom],
  ])('should take %s on its own as the checker', (_what, checker) => {
    expect(isChecker(checker)).toBe(true);
    expect(updateCheckOptions(checker)).toEqual({ checker });
  });

  it('should hand options back untouched', () => {
    const options = { checker: custom, linger: true, message: () => 'update' };
    expect(isChecker(options)).toBe(false);
    expect(updateCheckOptions(options)).toBe(options);
  });

  // the two shapes must never be mistaken for each other, and the options
  // that name a place do it through `checker`, so nothing in them can look
  // like one. A half-written checker is options, with its `type` and `url`
  // ignored, rather than being read as something it is not
  it.each([
    ['options with a type of their own', { type: 'x' }],
    ['a url and no path', { type: 'x', url: 'https://example.com' }],
    ['a path that is not a list', { path: 'version', type: 'x', url: 'https://example.com' }],
    ['a number', 1],
    ['null', null],
    ['a string', 'github'],
  ])('should not read %s as a checker', (_what, value) => {
    expect(isChecker(value)).toBe(false);
  });

  it('should report from a checker given in the options', async () => {
    // the shorthand is `{ checker }` and nothing else, so what has to hold
    // here is that the check really does read its answer through the checker
    // an app named: a body `npm` would never produce, found at the path the
    // checker says
    const dir = join(tmpdir(), `sigil-auto-custom-${randomUUID().slice(0, 8)}`);
    try {
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, cacheFileName('mycli', 'latest')),
        JSON.stringify({ body: { version: '3.0.0' }, ts: Date.now() })
      );
      const stderr = { isTTY: true, write: vi.fn() };
      const finish = await beginUpdateCheck(
        { name: 'mycli', updateCheck: { cacheDir: dir, checker: custom }, version: '1.0.0' },
        { env: {}, stderr }
      );
      await finish?.();
      expect(stderr.write.mock.calls.map(([text]) => String(text)).join('')).toContain('3.0.0');
    } finally {
      rmSync(dir, { force: true, recursive: true });
    }
  });
});

describe('when the check stays out of the way', () => {
  afterEach(() => setQuiet(undefined));

  it('should run for a person at a terminal', () => {
    expect(skipReason({ env: {}, stderr: tty })).toBe(undefined);
  });

  it('should not run where stderr is not a terminal', () => {
    // nothing fetched at all, not merely nothing printed: a script running the
    // CLI two hundred times a day has nobody to tell
    expect(skipReason({ env: {}, stderr: { isTTY: false, write: vi.fn() } })).toMatch(/terminal/);
    expect(skipReason({ env: {}, stderr: { write: vi.fn() } })).toMatch(/terminal/);
  });

  it('should not run under --quiet', () => {
    setQuiet(true);
    expect(skipReason({ env: {}, stderr: tty })).toMatch(/quiet/);
  });

  it.each([
    ['CI', '1'],
    ['CI', 'true'],
    ['NO_UPDATE_NOTIFIER', '1'],
    ['NO_UPDATE_NOTIFIER', 'yes'],
  ])('should not run with %s=%s', (name, value) => {
    expect(skipReason({ env: { [name]: value }, stderr: tty })).toContain(name);
  });

  it.each(['', '0', 'false', 'FALSE'])('should read %j as the variable being off', (value) => {
    // `CI=` and `CI=false` are how a variable is turned off, and honouring
    // them literally would silence the check for somebody who said "no"
    expect(skipReason({ env: { CI: value, NO_UPDATE_NOTIFIER: value }, stderr: tty })).toBe(
      undefined
    );
  });
});

describe('beginUpdateCheck', () => {
  let dir: string;

  beforeEach(() => {
    dir = join(tmpdir(), `sigil-auto-${randomUUID().slice(0, 8)}`);
  });

  afterEach(() => rmSync(dir, { force: true, recursive: true }));

  /** Starts a check for a schema and runs the notice, returning what was written. */
  async function notice(
    schema: Parameters<typeof beginUpdateCheck>[0],
    stderr = { isTTY: true, write: vi.fn() }
  ): Promise<string> {
    const finish = await beginUpdateCheck(schema, { env: {}, stderr });
    await finish?.();
    return stderr.write.mock.calls.map(([text]) => String(text)).join('');
  }

  it('should say nothing at all for a schema that did not ask', async () => {
    seed(dir, 'mycli', '9.0.0');
    for (const updateCheck of [undefined, false] as const) {
      expect(await notice({ name: 'mycli', updateCheck, version: '1.0.0' })).toBe('');
    }
  });

  it('should tell somebody who is behind', async () => {
    seed(dir, 'mycli', '2.0.0');
    const text = await notice({
      name: 'mycli',
      updateCheck: { cacheDir: dir },
      version: '1.0.0',
    });

    expect(text).toContain('mycli');
    expect(text).toContain('1.0.0');
    expect(text).toContain('2.0.0');
  });

  it('should say nothing to somebody who is current or ahead', async () => {
    seed(dir, 'mycli', '1.0.0');
    expect(await notice({ name: 'mycli', updateCheck: { cacheDir: dir }, version: '1.0.0' })).toBe(
      ''
    );
    expect(
      await notice({ name: 'mycli', updateCheck: { cacheDir: dir }, version: '1.5.0-rc.1' })
    ).toBe('');
  });

  it('should say nothing on the first run, when nothing is cached', async () => {
    // the answer to "what is the latest" is not in hand yet; the next run has
    // it. The check this starts would spawn a worker, so it is pointed at a
    // registry that cannot answer -- the assertion is only that it is silent
    expect(
      await notice({
        name: 'mycli',
        updateCheck: { cacheDir: dir, registryURL: 'https://127.0.0.1:1', timeout: 200 },
        version: '1.0.0',
      })
    ).toBe('');
  });

  it('should use the schema version, called if it is a function', async () => {
    seed(dir, 'mycli', '2.0.0');
    const text = await notice({
      name: 'mycli',
      updateCheck: { cacheDir: dir },
      version: () => '1.0.0',
    });
    expect(text).toContain('1.0.0');
  });

  it('should look up the package name rather than the program name when told', async () => {
    seed(dir, '@acme/mycli', '2.0.0');
    const text = await notice({
      name: 'mycli',
      updateCheck: { cacheDir: dir, packageName: '@acme/mycli' },
      version: '1.0.0',
    });

    // said in the program's words, found under the package's name
    expect(text).toContain('mycli');
    expect(text).toContain('2.0.0');
  });

  it('should let the app write the notice', async () => {
    seed(dir, 'mycli', '2.0.0');
    const text = await notice({
      name: 'mycli',
      updateCheck: {
        cacheDir: dir,
        message: ({ current, latest, name }) => `${name}: brew upgrade (${current} -> ${latest})`,
      },
      version: '1.0.0',
    });

    expect(text).toBe('\nmycli: brew upgrade (1.0.0 -> 2.0.0)\n');
  });

  it('should print nothing when the app’s message is empty', async () => {
    seed(dir, 'mycli', '2.0.0');
    for (const message of [() => '', () => undefined]) {
      expect(
        await notice({
          name: 'mycli',
          updateCheck: { cacheDir: dir, message },
          version: '1.0.0',
        })
      ).toBe('');
    }
  });

  it('should not check at all where it has nobody to tell', async () => {
    seed(dir, 'mycli', '2.0.0');
    const stderr = { isTTY: false, write: vi.fn() };
    const finish = await beginUpdateCheck(
      { name: 'mycli', updateCheck: { cacheDir: dir }, version: '1.0.0' },
      { env: {}, stderr }
    );

    // no finisher is the proof nothing was started, which a silent notice
    // would not be
    expect(finish).toBe(undefined);
    expect(stderr.write).not.toHaveBeenCalled();
  });

  it.each([
    ['a version', { name: 'mycli' }],
    ['a name', { version: '1.0.0' }],
  ])('should skip rather than throw without %s', async (_what, schema) => {
    // a misconfigured app must not break its users' commands over a notice
    expect(await notice({ ...schema, updateCheck: { cacheDir: dir } })).toBe('');

    // nothing was started, which a silent notice alone would not show. Asked of
    // the path itself: the first version compared a full path against a listing
    // of basenames, which can never match and so could never fail
    expect(existsSync(dir)).toBe(false);
  });

  it('should not let a throwing message fail anything', async () => {
    seed(dir, 'mycli', '2.0.0');
    const text = await notice({
      name: 'mycli',
      updateCheck: {
        cacheDir: dir,
        message: () => {
          throw new Error('bug in the app’s notice');
        },
      },
      version: '1.0.0',
    });
    expect(text).toBe('');
  });

  it('should not let a throwing version fail anything', async () => {
    const finish = await beginUpdateCheck(
      {
        name: 'mycli',
        updateCheck: { cacheDir: dir },
        version: () => {
          throw new Error('cannot read package.json');
        },
      },
      { env: {}, stderr: tty }
    );
    expect(finish).toBe(undefined);
  });
});

// the wiring, which the unit cases above cannot see: that `main()` begins the
// check, when it speaks, and that it speaks after work that succeeded rather
// than around it
describe('main() with updateCheck', () => {
  let dir: string;
  let writes: string[];
  let exitCode: typeof process.exitCode;
  let original: PropertyDescriptor | undefined;

  beforeEach(() => {
    dir = join(tmpdir(), `sigil-auto-main-${randomUUID().slice(0, 8)}`);
    writes = [];
    exitCode = process.exitCode;
    original = Object.getOwnPropertyDescriptor(process.stderr, 'isTTY');

    // a terminal, and an environment that is not CI: this suite runs in CI
    Object.defineProperty(process.stderr, 'isTTY', { configurable: true, value: true });
    vi.stubEnv('CI', '');
    vi.stubEnv('NO_UPDATE_NOTIFIER', '');
    vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: string | Uint8Array) => {
      writes.push(chunk.toString());
      return true;
    }) as never);
    vi.spyOn(process.stdout, 'write').mockImplementation((() => true) as never);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    if (original) {
      Object.defineProperty(process.stderr, 'isTTY', original);
    } else {
      delete (process.stderr as { isTTY?: boolean }).isTTY;
    }
    process.exitCode = exitCode;
    setQuiet(undefined);
    rmSync(dir, { force: true, recursive: true });
  });

  /** A schema with one command that records when it ran. */
  function app(order: string[], extra: Record<string, unknown> = {}) {
    return {
      commands: {
        hello: {
          run() {
            order.push('run');
            writes.push('<command output>');
          },
        },
        fail: {
          run() {
            throw new Error('boom');
          },
        },
      },
      name: 'mycli',
      updateCheck: { cacheDir: dir },
      version: '1.0.0',
      ...extra,
    };
  }

  it('should tell a person after the command has finished', async () => {
    seed(dir, 'mycli', '2.0.0');
    const order: string[] = [];
    await main({ argv: ['hello'], schema: app(order) as never });

    const joined = writes.join('');
    expect(joined).toContain('2.0.0');
    // after the command's own output rather than around it
    expect(joined.indexOf('<command output>')).toBeLessThan(joined.indexOf('2.0.0'));
  });

  it('should say nothing when the schema did not ask', async () => {
    seed(dir, 'mycli', '2.0.0');
    await main({ argv: ['hello'], schema: app([], { updateCheck: undefined }) as never });
    expect(writes.join('')).not.toContain('2.0.0');
  });

  it('should say nothing after a command that threw', async () => {
    seed(dir, 'mycli', '2.0.0');
    await expect(
      main({ argv: ['fail'], schema: app([]) as never, settings: { errorHandler: false } })
    ).rejects.toThrow('boom');
    expect(writes.join('')).not.toContain('2.0.0');
  });

  it('should say nothing after --help or --version', async () => {
    seed(dir, 'mycli', '2.0.0');
    await main({ argv: ['--help'], schema: app([]) as never });
    await main({ argv: ['--version'], schema: app([]) as never });
    expect(writes.join('')).not.toContain('2.0.0');
  });

  it('should say nothing under --quiet', async () => {
    seed(dir, 'mycli', '2.0.0');
    await main({ argv: ['hello', '--quiet'], schema: app([]) as never });
    expect(writes.join('')).not.toContain('2.0.0');
  });

  it('should say nothing when the command set a failing exit code', async () => {
    seed(dir, 'mycli', '2.0.0');
    const schema = app([], {
      commands: {
        hello: {
          run() {
            process.exitCode = 2;
          },
        },
      },
    });
    await main({ argv: ['hello'], schema: schema as never });
    expect(writes.join('')).not.toContain('2.0.0');
  });

  it('should say nothing in CI, and not fetch', async () => {
    vi.stubEnv('CI', 'true');
    await main({ argv: ['hello'], schema: app([]) as never });

    // the cache directory was never created, which a skipped notice alone
    // would not show: nothing was started
    expect(existsSync(dir)).toBe(false);
  });
});
