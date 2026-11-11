import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * What every git the client runs is told, read off the call rather than off a
 * repository: none of it changes what a test against a repository can see, so
 * a sabotage of any of it would pass every other test here.
 */

const calls: { args: string[]; options: Record<string, unknown> }[] = [];

vi.mock('node:child_process', () => ({
  execFile: (
    _file: string,
    args: string[],
    options: Record<string, unknown>,
    done: (err: Error | null, stdout: string, stderr: string) => void
  ) => {
    calls.push({ args, options });
    queueMicrotask(() => done(null, 'out', ''));
    return { stdin: { end: () => {}, on: () => {} } };
  },
}));

const { createGit } = await import('../src/git.ts');

afterEach(() => {
  calls.length = 0;
});

describe('createGit', () => {
  it('should run git without taking an optional lock or asking for a password', async () => {
    const git = createGit({ cwd: 'repo', env: { HOME: 'home', GIT_OPTIONAL_LOCKS: '1' } });
    expect(await git.run(['status'])).toBe('out');

    const env = calls[0]?.options.env as Record<string, string>;
    // a status that refreshes the index takes `index.lock` from whatever else is
    // using the repository unless this says not to
    expect(env.GIT_OPTIONAL_LOCKS).toBe('0');
    expect(env.GIT_TERMINAL_PROMPT).toBe('0');
    expect(env.HOME).toBe('home');
    expect(calls[0]?.options.cwd).toBe('repo');
  });

  it("should ask for output the parsers read, whatever the user's config says", async () => {
    await createGit({ cwd: 'repo' }).run(['diff'], { cwd: 'top' });

    const args = calls[0]?.args ?? [];
    for (const setting of [
      'color.ui=false',
      'core.quotepath=false',
      'diff.noprefix=false',
      'diff.mnemonicPrefix=false',
      'diff.relative=false',
    ]) {
      expect(args).toContain(setting);
    }
    expect(args.at(-1)).toBe('diff');
    expect(calls[0]?.options.cwd).toBe('top');
  });
});
