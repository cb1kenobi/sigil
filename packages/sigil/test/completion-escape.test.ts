import { generatedBy } from '../src/completion/install.js';
import {
  applyInstall,
  applyUninstall,
  installTarget,
  installTargets,
  planInstall,
  planLines,
  planUninstall,
  resultLines,
  type InstallTarget,
} from '../src/completion/installer.js';
import { parse } from '../src/parser/parse.js';
import type { ParseState } from '../src/types.js';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Where the completion installer echoes a path or a name, it echoes it inert
 * (SIG-576).
 *
 * The installer writes into the user's own directories, and the target path
 * comes from the environment -- `XDG_DATA_HOME`, `ZDOTDIR`, `HOME` -- so a
 * control character in one of them reached the terminal raw wherever a message
 * quoted the path. Two kinds of message: the **plan and the result**, which
 * `interactive.ts` writes straight to `process.stderr` rather than through a
 * canvas that would have stripped them, and the **errors**, which are Node's own
 * (`EACCES: ..., unlink '<path>'`) or ours (`Refusing to remove <path>`).
 *
 * Every directory here is named `ESC ] 0 ; T BEL`, a window retitle, followed by
 * a newline that would start a line the program never wrote. Written as escapes
 * and never as raw bytes, for the reason `sources.test.ts` exists, and skipped on
 * Windows, which cannot create the name. None of the failures depends on a
 * permission: a directory where the script should be is `EISDIR` for everybody,
 * which a CI job running as root still gets, and the refused `unlink` is Node's
 * error as Node shapes it, thrown by a stand-in.
 */

/** A window retitle, and a newline that would start a line the program never wrote. */
const HOSTILE = '\u001b]0;T\u0007\nforged: error';

/** What `escapeControls()` makes of it, inside a message. */
const ESCAPED = '\\x1B]0;T\\x07\\x0Aforged: error';

const POSIX = process.platform !== 'win32';

const FAKE_HOME = join(tmpdir(), `sigil-completion-escape-home-${process.pid}`);

vi.mock('node:os', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:os')>()),
  homedir: () => FAKE_HOME,
}));

// the one call that is faked is `unlinkSync()`, which has no way to fail for a
// reason that holds on every runner: it follows a read that succeeded, so it
// only fails on a permission -- which root does not have, and which needs a mode
// the suite's executable guard refuses to see -- or on a race
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, unlinkSync: vi.fn(actual.unlinkSync) };
});

let box: string;

beforeEach(() => {
  box = mkdtempSync(join(tmpdir(), 'sigil-completion-escape-'));
  rmSync(FAKE_HOME, { force: true, recursive: true });
  mkdirSync(FAKE_HOME, { recursive: true });
  vi.stubEnv('HOME', FAKE_HOME);
  vi.stubEnv('USERPROFILE', FAKE_HOME);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  rmSync(box, { force: true, recursive: true });
  rmSync(FAKE_HOME, { force: true, recursive: true });
});

/** A directory whose name is hostile, made. */
function hostileDir(name: string): string {
  const dir = join(box, `${name}-${HOSTILE}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** The environment, with the data home and the zsh directory both hostile. */
function hostileEnv(): Record<string, string | undefined> {
  return { XDG_DATA_HOME: hostileDir('data'), ZDOTDIR: hostileDir('zdot') };
}

/** The target for zsh under that environment. */
function target(env = hostileEnv()): InstallTarget {
  return installTarget('zsh', 'mycli', env);
}

/** Asserts a text holds nothing a terminal acts on, and nothing that forges a line. */
function expectInert(text: string): void {
  expect(text).not.toContain('\u001b');
  expect(text).not.toContain('\u0007');
  expect(text).not.toContain(HOSTILE);
  expect(text.split('\n').some((line) => line.trimStart().startsWith('forged: error'))).toBe(false);
}

/** The script the installer would write, which is what marks a file as ours. */
function script(): string {
  return `# ${generatedBy('zsh', 'mycli')}\n#compdef mycli\n`;
}

/** Puts our script at the target, where an uninstall will find it. */
function install(t: InstallTarget): void {
  mkdirSync(t.dir, { recursive: true });
  writeFileSync(t.file, script());
}

/** What a function threw, or fails. */
function thrown(work: () => unknown): Error & Record<string, unknown> {
  try {
    work();
  } catch (error) {
    return error as Error & Record<string, unknown>;
  }
  throw new Error('expected it to throw');
}

/** A schema's parse, for `runInstaller()`. */
async function state(name = 'mycli'): Promise<ParseState> {
  return await parse({
    argv: [],
    env: {},
    schema: { commands: { build: { desc: 'Build it', run(): void {} } }, name },
  });
}

/** Everything written to stderr while `work` ran. */
async function stderrOf(work: () => Promise<unknown>): Promise<string> {
  const written: string[] = [];
  vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: string | Uint8Array) => {
    written.push(String(chunk));
    return true;
  }) as typeof process.stderr.write);
  try {
    await work();
  } finally {
    vi.mocked(process.stderr.write).mockRestore();
  }
  return written.join('');
}

describe.skipIf(!POSIX)(
  'the plan and the result, under a directory with a control character',
  () => {
    it('should escape the script and the startup file in the plan, for an install', () => {
      const t = target();
      const lines = planLines(planInstall(t, script(), 'mycli'), 'install').join('\n');

      expect(lines).toContain(`It will write ${t.file.replaceAll(HOSTILE, ESCAPED)}`);
      expect(lines).toContain(`It will add a block to ${t.rc?.file.replaceAll(HOSTILE, ESCAPED)}`);
      expectInert(lines);
    });

    it('should escape both paths in the plan, for an uninstall', () => {
      const t = target();
      install(t);
      const lines = planLines(planUninstall(t, 'mycli'), 'uninstall').join('\n');

      expect(lines).toContain(`It will remove ${t.file.replaceAll(HOSTILE, ESCAPED)}`);
      expectInert(lines);
    });

    it('should escape the path of a file that is not there, and of one sigil did not write', () => {
      const t = target();
      const absent = planLines(planUninstall(t, 'mycli'), 'uninstall').join('\n');
      expect(absent).toContain(`${t.file.replaceAll(HOSTILE, ESCAPED)} is not there`);
      expectInert(absent);

      mkdirSync(t.dir, { recursive: true });
      writeFileSync(t.file, '# somebody else wrote this\n');
      const foreign = planLines(planInstall(t, script(), 'mycli'), 'install').join('\n');
      expect(foreign).toContain(`${t.file.replaceAll(HOSTILE, ESCAPED)} was not written by sigil`);
      expectInert(foreign);
    });

    it('should escape what a finished install and uninstall say', () => {
      const t = target();
      const plan = planInstall(t, script(), 'mycli');

      const wrote = resultLines(plan, 'install', { file: true, rc: true }).join('\n');
      expect(wrote).toContain(`Wrote ${t.file.replaceAll(HOSTILE, ESCAPED)}`);
      expect(wrote).toContain(`Added a block to ${t.rc?.file.replaceAll(HOSTILE, ESCAPED)}`);
      expectInert(wrote);

      install(t);
      const removed = resultLines(planUninstall(t, 'mycli'), 'uninstall', {
        file: true,
        rc: true,
      }).join('\n');
      expect(removed).toContain(`Removed ${t.file.replaceAll(HOSTILE, ESCAPED)}`);
      expect(removed).toContain(
        `Removed the block from ${t.rc?.file.replaceAll(HOSTILE, ESCAPED)}`
      );
      expectInert(removed);
    });

    it('should escape the line it asks somebody to remove by hand', () => {
      const t = target();
      install(t);
      // a startup file that names the script in a line of its own writing
      mkdirSync(join(t.rc?.file ?? '', '..'), { recursive: true });
      writeFileSync(t.rc?.file ?? '', `source ${t.file}\n`);
      const plan = planUninstall(t, 'mycli');

      expect(plan.rc).toBe('theirs');
      const out = [
        ...planLines(plan, 'uninstall'),
        ...resultLines(plan, 'uninstall', { file: false, rc: false }),
      ].join('\n');
      expect(out).toContain('names it, and sigil did not add that');
      expect(out).toContain('yourself.');
      expectInert(out);
    });
  }
);

describe.skipIf(!POSIX)('the command, under a directory with a control character', () => {
  it('should write nothing raw to stderr where it plans an install and has nobody to ask', async () => {
    const { runInstaller } = await import('../src/completion/interactive.js');
    const env = hostileEnv();
    vi.stubEnv('XDG_DATA_HOME', env['XDG_DATA_HOME']);
    vi.stubEnv('ZDOTDIR', env['ZDOTDIR']);

    const out = await stderrOf(async () => {
      expect(await runInstaller(await state(), { shell: 'zsh', uninstall: false })).toBe(1);
    });

    expect(out).toContain(`It will write ${target(env).file.replaceAll(HOSTILE, ESCAPED)}`);
    expectInert(out);
  });

  it('should write nothing raw where it plans an uninstall, and print an rm that names the file', async () => {
    const { runInstaller } = await import('../src/completion/interactive.js');
    const env = hostileEnv();
    const t = target(env);
    install(t);
    vi.stubEnv('XDG_DATA_HOME', env['XDG_DATA_HOME']);
    vi.stubEnv('ZDOTDIR', env['ZDOTDIR']);

    const out = await stderrOf(async () => {
      expect(await runInstaller(await state(), { shell: 'zsh', uninstall: true })).toBe(1);
    });

    expectInert(out);
    expect(out).toContain(`It will remove ${t.file.replaceAll(HOSTILE, ESCAPED)}`);

    // a line somebody may copy has to name the file it is about, which an
    // escaped path inside single quotes does not: four characters of `\x1B` are
    // not an ESC. So it is the `$'...'` form, and a shell is asked what it means
    const rm = out.split('\n').find((line) => line.trimStart().startsWith('rm '));
    expect(rm).toBeDefined();
    const word = (rm ?? '').trimStart().slice('rm '.length);
    expect(word.startsWith("$'")).toBe(true);
    expect(execFileSync('bash', ['-c', `printf %s ${word}`], { encoding: 'utf8' })).toBe(t.file);
  });

  it('should leave an ordinary path single-quoted in the rm it prints', async () => {
    const { runInstaller } = await import('../src/completion/interactive.js');
    const env = { XDG_DATA_HOME: join(box, 'plain data'), ZDOTDIR: join(box, 'plain zdot') };
    const t = target(env);
    install(t);
    vi.stubEnv('XDG_DATA_HOME', env.XDG_DATA_HOME);
    vi.stubEnv('ZDOTDIR', env.ZDOTDIR);

    const out = await stderrOf(async () => {
      await runInstaller(await state(), { shell: 'zsh', uninstall: true });
    });

    expect(out).toContain(`rm '${t.file}'`);
  });

  it('should escape a program name in the by-hand text, where nobody names a shell', async () => {
    const { runInstaller } = await import('../src/completion/interactive.js');
    // a format character survives `programOf()`, which only strips what is a
    // control character: it is what is left to make a line read differently
    const out = await stderrOf(async () => {
      await runInstaller(await state('my‮cli'), { uninstall: false });
    });

    expect(out).toContain('my\\u{202E}cli');
    expect(out).not.toContain('‮');
  });
});

describe.skipIf(!POSIX)('an error under a directory with a control character', () => {
  it('should escape the path and Node message of a script that cannot be read', () => {
    const t = target();
    // a directory where the script should be: `EISDIR`, which holds for root
    mkdirSync(t.file, { recursive: true });

    for (const e of [
      thrown(() => planInstall(t, script(), 'mycli')),
      thrown(() => planUninstall(t, 'mycli')),
    ]) {
      expect(e.message).toContain('Failed to read');
      expect(e.message).toContain(ESCAPED);
      expect(e.message).toContain('EISDIR');
      expectInert(e.message);
      expectInert(String(e.stack).split('\n    at ')[0] ?? '');
    }
  });

  it('should escape the path of a file it will not remove, which sigil did not write', () => {
    const t = target();
    install(t);
    const plan = planUninstall(t, 'mycli');
    // swapped while the question was on screen
    writeFileSync(t.file, '# somebody else wrote this\n');

    const e = thrown(() => applyUninstall(plan));
    expect(e.message).toContain(`Refusing to remove ${t.file.replaceAll(HOSTILE, ESCAPED)}`);
    expectInert(e.message);
    expect(existsSync(t.file)).toBe(true);
  });

  it('should escape the path of a file it will not replace, which sigil did not write', async () => {
    const t = target();
    mkdirSync(t.dir, { recursive: true });
    writeFileSync(t.file, '# somebody else wrote this\n');
    const plan = planInstall(t, script(), 'mycli');

    const e = await applyInstall(plan, script()).then(
      () => {
        throw new Error('expected it to throw');
      },
      (error: Error) => error
    );
    expect(e.message).toContain(`Refusing to replace ${t.file.replaceAll(HOSTILE, ESCAPED)}`);
    expectInert(e.message);
  });

  it('should escape a program name that is not one path segment or one word', () => {
    const env = hostileEnv();

    const segment = thrown(() => installTargets('zsh', `a/b${HOSTILE}`, env));
    expect(segment.message).toContain('one path segment');
    expect(segment.message).toContain(`a/b${ESCAPED}`);
    expectInert(segment.message);

    // no separator, so it is the second question that refuses: whitespace
    const word = thrown(() => installTargets('zsh', `a${HOSTILE}`, env));
    expect(word.message).toContain('one word');
    expect(word.message).toContain(`a${ESCAPED}`);
    expectInert(word.message);
  });

  /** What Node says where an unlink is refused, whatever the runner may do. */
  function refused(path: string): Error {
    return Object.assign(new Error(`EACCES: permission denied, unlink '${path}'`), {
      code: 'EACCES',
      errno: -13,
      path,
      syscall: 'unlink',
    });
  }

  it("should make Node's own error from an uninstall inert, on the error Node threw", async () => {
    const fs = await import('node:fs');
    const t = target();
    install(t);
    const plan = planUninstall(t, 'mycli');
    const real = refused(t.file);
    vi.mocked(fs.unlinkSync).mockImplementationOnce(() => {
      throw real;
    });

    const e = thrown(() => applyUninstall(plan));

    // the same object, so identity and everything a caller reads off it hold
    expect(e).toBe(real);
    expect(e.message).toContain('EACCES');
    expect(e.message).toContain(ESCAPED);
    expectInert(e.message);
    expectInert(String(e.stack).split('\n    at ')[0] ?? '');
    expect(e.code).toBe('EACCES');
    expect(e.syscall).toBe('unlink');
    expect(e.path).toBe(t.file);
    expect(e.errno).toBe(-13);
  });
});
