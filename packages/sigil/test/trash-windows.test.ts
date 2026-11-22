import { cache } from '../src/paths.js';
import { trash } from '../src/trash/index.js';
import { run } from '../src/trash/spawn.js';
import { cacheFile, keyOf, recycle } from '../src/trash/windows.js';
import { tempDir } from './temp.js';
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * The Windows half of `trash()` as far as it can be taken on any platform: the
 * key the compiled helper is cached under, where that cache is, and what is
 * handed to PowerShell. PowerShell itself is replaced, so these run everywhere;
 * what it does with the cache -- loading a sealed assembly, refusing one that
 * does not unseal, rebuilding, and carrying on when nothing can be saved -- is
 * in `trash.test.ts`, run for real on Windows.
 */

vi.mock('../src/trash/spawn.js', () => ({ run: vi.fn() }));

const ran = vi.mocked(run);

/** What PowerShell was handed on the last call: its arguments and its added environment. */
function lastCall(): { args: string[]; env: Record<string, string> } {
  const [, args, env] = ran.mock.calls.at(-1)!;
  return { args, env: env! };
}

/** What `run()` resolves with, as the script writes it. */
function reply(cache: string, answer: object): string {
  return JSON.stringify({ answer, cache });
}

afterEach(() => {
  ran.mockReset();
});

describe('the key the helper is cached under', () => {
  it('should be the SHA-256 of the source, so any change to it is a new key', () => {
    expect(keyOf('a')).toBe(createHash('sha256').update('a').digest('hex'));
    expect(keyOf('a')).toMatch(/^[0-9a-f]{64}$/);
    expect(keyOf('a ')).not.toBe(keyOf('a'));
  });

  it('should name the file under the cache base, and nothing without one', () => {
    const hash = keyOf('a');
    expect(cacheFile(join('base'), hash)).toBe(
      join('base', 'sigil', `trash-${hash.slice(0, 16)}.bin`)
    );
    expect(cacheFile(join('base'), keyOf('b'))).not.toBe(cacheFile(join('base'), hash));
    expect(cacheFile(undefined, hash)).toBeUndefined();
    expect(cacheFile('', hash)).toBeUndefined();
  });
});

describe('what PowerShell is handed', () => {
  it('should hand it the cache, the key and the source through the environment, never the command', async () => {
    ran.mockResolvedValue(reply('hit', { path: 'C:\\bin\\$R1.txt' }));

    const out = await recycle('C:\\a "b".txt', join('c', 'trash.bin'), 'k'.repeat(64));

    const { args, env } = lastCall();
    expect(out).toEqual({ cache: 'hit', path: 'C:\\bin\\$R1.txt' });
    expect(env.SIGIL_TRASH_PATH).toBe('C:\\a "b".txt');
    expect(env.SIGIL_TRASH_CACHE).toBe(join('c', 'trash.bin'));
    expect(env.SIGIL_TRASH_KEY).toBe('k'.repeat(64));
    // set, and empty, so that one inherited from the environment cannot ask for the compile
    expect(env.SIGIL_TRASH_MODE).toBe('');
    expect(env.SIGIL_TRASH_SOURCE).toContain('namespace SigilTrash');
    // and one environment variable is held to 32,767 characters too
    expect(env.SIGIL_TRASH_SOURCE.length).toBeLessThan(32_767);
    // the script is all the command carries: the C# goes in the environment,
    // which is what keeps the command under Windows' 32,767 characters
    const script = Buffer.from(args.at(-1)!, 'base64').toString('utf16le');
    // a seal made for the machine is refused before anything is unsealed, which
    // a macOS or Linux run can only see in the text; the Windows jobs run it
    expect(script.indexOf('ToUInt32($sealed, 40)')).toBeGreaterThan(-1);
    expect(script.indexOf('ToUInt32($sealed, 40)')).toBeLessThan(script.indexOf('Unprotect('));
    expect(script).not.toContain('namespace SigilTrash');
    expect(script).not.toContain('C:\\a');
    expect(args.join(' ').length).toBeLessThan(16_384);
  });

  it('should name no cache when it has none, so an inherited variable cannot name one', async () => {
    vi.stubEnv('SIGIL_TRASH_CACHE', join('somebody', 'else.bin'));
    ran.mockResolvedValue(reply('built', { path: 'x' }));

    try {
      const out = await recycle('C:\\a.txt', undefined, 'k');
      expect(lastCall().env.SIGIL_TRASH_CACHE).toBe('');
      expect(out.cache).toBe('built');
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('should key the default cache by the C# it hands over, under paths.cache()', async () => {
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
    Object.defineProperty(process, 'platform', { ...platform, value: 'win32' });
    const file = join(tempDir('sigil-trash-win-'), 'a.txt');
    writeFileSync(file, '');
    ran.mockResolvedValue(reply('saved', { path: 'C:\\bin\\$R1.txt' }));

    try {
      expect(await trash(file)).toBe('C:\\bin\\$R1.txt');
    } finally {
      Object.defineProperty(process, 'platform', platform);
    }

    const { env } = lastCall();
    expect(env.SIGIL_TRASH_KEY).toBe(keyOf(env.SIGIL_TRASH_SOURCE));
    expect(env.SIGIL_TRASH_CACHE).toBe(cacheFile(cache(), env.SIGIL_TRASH_KEY));
    expect(env.SIGIL_TRASH_PATH).toBe(file);
  });
});

describe('what PowerShell answers', () => {
  it('should throw what the helper answered as an error', async () => {
    ran.mockResolvedValue(reply('hit', { error: 'Access is denied.' }));

    await expect(recycle('C:\\a.txt', undefined, 'k')).rejects.toThrow('Access is denied.');
  });

  it('should refuse what Windows would delete for good', async () => {
    ran.mockResolvedValue(reply('saved', { refused: '' }));

    await expect(recycle('C:\\a.txt', undefined, 'k')).rejects.toThrow(/for good/);
  });

  it("should resolve with '' when the shell recycled the item without saying where", async () => {
    ran.mockResolvedValue(reply('hit', { path: null }));

    expect(await recycle('C:\\a.txt', undefined, 'k')).toEqual({ cache: 'hit', path: '' });
  });

  it('should say what it was answered when that is not JSON', async () => {
    ran.mockResolvedValue('nope');

    await expect(recycle('C:\\a.txt', undefined, 'k')).rejects.toThrow(
      'PowerShell answered "nope"'
    );
  });
});

describe('a load that is refused', () => {
  /** What the script answers when `Assembly.Load()` refuses the helper's bytes. */
  const REFUSED = reply('none', {
    loadRefused: 'Operation did not complete successfully because the file contains a virus',
  });

  it('should ask again, compiling the helper in PowerShell, and still recycle the item', async () => {
    ran.mockResolvedValueOnce(REFUSED);
    ran.mockResolvedValueOnce(reply('compiled', { path: 'C:\\bin\\$R1.txt' }));

    const out = await recycle('C:\\a.txt', join('c', 'trash.bin'), 'k');

    expect(out).toEqual({ cache: 'compiled', path: 'C:\\bin\\$R1.txt' });
    expect(ran).toHaveBeenCalledTimes(2);
    const [first, second] = ran.mock.calls.map(([, , env]) => env!);
    expect(first.SIGIL_TRASH_MODE).toBe('');
    expect(second.SIGIL_TRASH_MODE).toBe('compile');
    // the same item, and the same source, the second time
    expect(second.SIGIL_TRASH_PATH).toBe('C:\\a.txt');
    expect(second.SIGIL_TRASH_SOURCE).toBe(first.SIGIL_TRASH_SOURCE);
  });

  it('should hold the compiled script to the same answers: an error, and a refusal to delete', async () => {
    ran.mockResolvedValueOnce(REFUSED);
    ran.mockResolvedValueOnce(reply('compiled', { error: 'Access is denied.' }));
    await expect(recycle('C:\\a.txt', undefined, 'k')).rejects.toThrow('Access is denied.');

    ran.mockResolvedValueOnce(REFUSED);
    ran.mockResolvedValueOnce(reply('compiled', { refused: '' }));
    await expect(recycle('C:\\a.txt', undefined, 'k')).rejects.toThrow(/for good/);
  });

  it('should ask for the compile once, and throw rather than loop when that is refused too', async () => {
    ran.mockResolvedValue(REFUSED);

    await expect(recycle('C:\\a.txt', undefined, 'k')).rejects.toThrow(/contains a virus/);

    expect(ran).toHaveBeenCalledTimes(2);
  });

  it('should not ask a second time when the first answered anything else', async () => {
    ran.mockResolvedValue(reply('saved', { path: 'C:\\bin\\$R1.txt' }));

    await recycle('C:\\a.txt', undefined, 'k');

    expect(ran).toHaveBeenCalledTimes(1);
  });

  it('should have a script that answers a refusal, and a mode that compiles with Add-Type', async () => {
    ran.mockResolvedValue(reply('hit', { path: 'x' }));
    await recycle('C:\\a.txt', undefined, 'k');

    const script = Buffer.from(lastCall().args.at(-1)!, 'base64').toString('utf16le');
    // run for real on the Windows jobs; here only what a macOS or Linux run can see
    expect(script).toContain('loadRefused');
    expect(script).toContain("$env:SIGIL_TRASH_MODE -eq 'compile'");
    expect(script).toContain('Add-Type -TypeDefinition');
    // the refusal is caught before the cache is written, so a helper whose bytes
    // cannot be loaded is never sealed and kept
    expect(script.indexOf('$refused = ')).toBeGreaterThan(-1);
    expect(script.indexOf('$refused = ')).toBeLessThan(script.indexOf('ProtectedData]::Protect('));
  });
});
