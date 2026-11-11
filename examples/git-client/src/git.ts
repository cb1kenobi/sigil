/**
 * Running git, as a context.
 *
 * `App()` takes no props -- it is what `runApp()` and the examples' smoke test
 * mount as it is -- so what a test has to replace comes in through a context, the
 * way the system monitor's machine does: here the directory git is started in and
 * the environment it gets. Outside a provider it is the working directory and
 * this process's environment.
 */

import { createContext, type Context } from '@ttylabs/sigil/renderer';
import { execFile } from 'node:child_process';
import { readFile, stat } from 'node:fs/promises';

/** What one call to git is given beyond its arguments. */
export interface RunOptions {
  /** The directory to run in. Defaults to {@link Git.cwd}. */
  readonly cwd?: string;
  /** Written to git's stdin: a patch for `git apply`, a message for `git commit -F -`. */
  readonly input?: string;
  /** Ends the call, killing git, when the app goes. */
  readonly signal?: AbortSignal;
}

/** The repository the client is about, and how it reaches it. */
export interface Git {
  /** Where git is started, which is anywhere inside the repository. */
  readonly cwd: string;
  /**
   * Reads a file of the working tree, for an untracked path git has no diff of.
   *
   * @param path - Absolute.
   * @param limit - The most bytes worth reading; a larger file is not read.
   * @returns Its bytes, or `undefined` for a file over `limit`.
   */
  readFile(path: string, limit: number): Promise<Buffer | undefined>;
  /**
   * Runs git and hands back what it printed.
   *
   * @param args - The arguments after `git`.
   * @param opts - Where, what to write to it, and how to stop it.
   * @returns Its stdout.
   * @throws With git's own message when it exits with anything but `0`.
   */
  run(args: readonly string[], opts?: RunOptions): Promise<string>;
}

/** What {@link createGit} is told. */
export interface GitOptions {
  /** Where git is started. Defaults to the working directory. */
  readonly cwd?: string;
  /** The environment it runs with. Defaults to this process's. */
  readonly env?: Readonly<Record<string, string | undefined>>;
}

/**
 * Settings every call carries, so that what git prints is what the parsers read
 * whatever the user's config says: no colour, paths unquoted, and a patch with the
 * `a/` and `b/` prefixes `git apply` expects back.
 */
const SETTINGS = [
  '-c',
  'color.ui=false',
  '-c',
  'core.quotepath=false',
  '-c',
  'diff.noprefix=false',
  '-c',
  'diff.mnemonicPrefix=false',
  '-c',
  'diff.relative=false',
];

/** A patch or a log larger than this is a repository this example is not for. */
const MAX_BUFFER = 64 * 1024 * 1024;

/**
 * Builds the git the client runs.
 *
 * Every call gets `GIT_OPTIONAL_LOCKS=0`. A `git status` refreshes the index's
 * stat cache and writes it back if it can take the lock, and a client that reads
 * the status on every action would otherwise be racing whatever else the user is
 * running in the repository -- an editor's own git, a `git commit` in another
 * shell -- for `index.lock`. With it unset git skips that write, which costs a
 * slower status next time and nothing else; it is what editors that poll git set
 * for the same reason. A write the user asked for still takes the lock, because
 * that lock is not optional. `GIT_TERMINAL_PROMPT=0` because nothing can be typed
 * at a git that is not on the terminal the app owns.
 *
 * @param opts - Where to run, and with what environment.
 * @returns The git.
 */
export function createGit(opts: GitOptions = {}): Git {
  const cwd = opts.cwd ?? process.cwd();
  const env = { ...(opts.env ?? process.env), GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' };

  return {
    cwd,
    async readFile(path, limit) {
      const info = await stat(path);
      return info.size > limit ? undefined : readFile(path);
    },
    run(args, runOpts = {}) {
      return new Promise((resolve, reject) => {
        const child = execFile(
          'git',
          [...SETTINGS, ...args],
          {
            cwd: runOpts.cwd ?? cwd,
            encoding: 'utf8',
            env,
            maxBuffer: MAX_BUFFER,
            signal: runOpts.signal,
            windowsHide: true,
          },
          (err, stdout, stderr) => {
            if (!err) {
              resolve(stdout);
              return;
            }
            const code = (err as NodeJS.ErrnoException).code;
            if (code === 'ENOENT') {
              reject(new Error('git was not found on the PATH'));
              return;
            }
            // git's own words, which say what is wrong better than an exit code does
            const said = `${stderr}`.trim() || `${stdout}`.trim();
            reject(new Error(said || err.message));
          }
        );
        // the stream is there even with no input, and git waits on it for a patch
        // or a message, so it is ended either way
        child.stdin?.on('error', () => {});
        child.stdin?.end(runOpts.input ?? '');
      });
    },
  };
}

/** The repository the client is about. `provideContext()` it with another in a test. */
export const GitContext: Context<Git> = createContext(createGit(), 'git');
