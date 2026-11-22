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

/** The script PowerShell was handed on the nth call, decoded. */
function scriptOf(call: number): string {
  return Buffer.from(ran.mock.calls[call]![1].at(-1)!, 'base64').toString('utf16le');
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

  it('should ask again, in a mode that compiles the helper itself, and still recycle the item', async () => {
    ran.mockResolvedValueOnce(REFUSED);
    ran.mockResolvedValueOnce(reply('compiled', { path: 'C:\\bin\\$R1.txt' }));

    const out = await recycle('C:\\a.txt', join('c', 'trash.bin'), 'k');

    expect(out).toEqual({ cache: 'compiled', path: 'C:\\bin\\$R1.txt' });
    expect(ran).toHaveBeenCalledTimes(2);
    const [first, second] = ran.mock.calls.map(([, , env]) => env!);
    // the second is a different script, and neither reads a mode from the environment
    expect(scriptOf(0)).not.toBe(scriptOf(1));
    expect(first.SIGIL_TRASH_MODE).toBeUndefined();
    expect(second.SIGIL_TRASH_MODE).toBeUndefined();
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

    await expect(recycle('C:\\a.txt', undefined, 'k')).rejects.toThrow(
      /The helper could not be loaded: .*contains a virus/
    );

    expect(ran).toHaveBeenCalledTimes(2);
  });

  it('should not ask a second time when the first answered anything else', async () => {
    ran.mockResolvedValue(reply('saved', { path: 'C:\\bin\\$R1.txt' }));

    await recycle('C:\\a.txt', undefined, 'k');

    expect(ran).toHaveBeenCalledTimes(1);
  });

  it('should have a script that answers a refusal, and a mode that loads from a file', async () => {
    ran.mockResolvedValue(reply('hit', { path: 'x' }));
    await recycle('C:\\a.txt', undefined, 'k');

    const script = Buffer.from(lastCall().args.at(-1)!, 'base64').toString('utf16le');
    // run for real on the Windows jobs; here only what a macOS or Linux run can see
    expect(script).toContain('loadRefused');
    // the refusal is caught, and everything that keeps the helper is behind a
    // check that there was none, so a helper whose bytes cannot be loaded is
    // never sealed and kept
    const caught = script.indexOf('$refused = [string]');
    const guard = script.indexOf('if ($null -eq $refused) {');
    expect(caught).toBeGreaterThan(-1);
    expect(guard).toBeGreaterThan(caught);
    expect(script.indexOf('ProtectedData]::Protect(')).toBeGreaterThan(guard);

    // the second script loads from a file: `Add-Type` would load the bytes it
    // compiled, which is the call that was refused
    ran.mockResolvedValue(reply('compiled', { path: 'x' }));
    await recycle('C:\\a.txt', undefined, 'k', 'compile');
    const compile = scriptOf(1);
    expect(compile).toContain('Assembly]::LoadFrom(');
    expect(compile).not.toContain('Load(');
    expect(compile).not.toContain('ReadAllBytes');
    // and what it compiles with does not load what it built: CodeDom does that,
    // with `Assembly.Load(byte[])`, when it is asked to compile in memory
    expect(script).toContain('$params.GenerateInMemory = $false');
    expect(compile).toContain('$params.GenerateInMemory = $false');
    expect(script).not.toContain('GenerateInMemory = $true');
    // a load that is refused is answered, not raised as PowerShell's own error
    expect(compile.indexOf('catch {')).toBeGreaterThan(compile.indexOf('LoadFrom('));
    expect(compile).toContain('$refused = ');
    expect(compile).toContain('loadRefused');
    expect(compile).not.toContain('Add-Type');
    expect(compile).not.toContain('SIGIL_TRASH_CACHE');
    expect(compile).not.toContain('Protect(');
  });
});

describe('a first run that prints nothing', () => {
  /** An item that is really there, since whether it is still there is what is asked. */
  function item(): string {
    const file = join(tempDir('sigil-trash-win-'), 'a.txt');
    writeFileSync(file, '');
    return file;
  }

  const KILLED = new Error('powershell.exe failed: exited with null');

  it('should be asked again with a script that has no Assembly.Load text, and still recycle the item', async () => {
    const file = item();
    ran.mockRejectedValueOnce(KILLED);
    ran.mockResolvedValueOnce(reply('compiled', { path: 'C:\\bin\\$R1.txt' }));

    const out = await recycle(file, join('c', 'trash.bin'), 'k');

    expect(out).toEqual({ cache: 'compiled', path: 'C:\\bin\\$R1.txt' });
    expect(ran).toHaveBeenCalledTimes(2);
    // the first script is the one that loads bytes, and it is why it was stopped
    expect(scriptOf(0)).toContain('Reflection.Assembly]::Load(');
    expect(scriptOf(1)).not.toContain('Assembly]::Load(');
    expect(scriptOf(1)).not.toContain('Assembly.Load');
    expect(ran.mock.calls[1]![2]!.SIGIL_TRASH_PATH).toBe(file);
  });

  it('should be asked again for output that is not JSON as well as for a failed run', async () => {
    const file = item();
    ran.mockResolvedValueOnce('');
    ran.mockResolvedValueOnce(reply('compiled', { path: 'x' }));

    expect(await recycle(file, undefined, 'k')).toEqual({ cache: 'compiled', path: 'x' });
    expect(ran).toHaveBeenCalledTimes(2);
  });

  it('should ask once, and throw what the second run said when it prints nothing too', async () => {
    const file = item();
    ran.mockRejectedValueOnce(KILLED);
    ran.mockRejectedValueOnce(new Error('powershell.exe failed: blocked by policy'));

    await expect(recycle(file, undefined, 'k')).rejects.toThrow('blocked by policy');

    expect(ran).toHaveBeenCalledTimes(2);
  });

  it('should throw what the second run answered when that is an error', async () => {
    const file = item();
    ran.mockRejectedValueOnce(KILLED);
    ran.mockResolvedValueOnce(reply('compiled', { error: 'Access is denied.' }));

    await expect(recycle(file, undefined, 'k')).rejects.toThrow('Access is denied.');

    expect(ran).toHaveBeenCalledTimes(2);
  });

  it('should not ask when the item is gone, because the run was stopped after the move', async () => {
    ran.mockRejectedValueOnce(KILLED);

    await expect(
      recycle(join(tempDir('sigil-trash-win-'), 'gone.txt'), undefined, 'k')
    ).rejects.toBe(KILLED);

    expect(ran).toHaveBeenCalledTimes(1);
  });

  it('should not ask for a failure the script reported, which is every ordinary one', async () => {
    const file = item();
    ran.mockResolvedValue(reply('hit', { error: 'Access is denied.' }));
    await expect(recycle(file, undefined, 'k')).rejects.toThrow('Access is denied.');

    ran.mockResolvedValue(reply('saved', { refused: '' }));
    await expect(recycle(file, undefined, 'k')).rejects.toThrow(/for good/);

    expect(ran).toHaveBeenCalledTimes(2);
  });

  it('should not ask when the compile script is what printed nothing', async () => {
    const file = item();
    ran.mockRejectedValue(KILLED);

    await expect(recycle(file, undefined, 'k', 'compile')).rejects.toBe(KILLED);

    expect(ran).toHaveBeenCalledTimes(1);
  });
});
