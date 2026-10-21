import { completionScript, programOf } from '../src/completion/index.js';
import { generatedBy, installHint, shQuote } from '../src/completion/install.js';
import {
  applyInstall,
  applyUninstall,
  installTargets,
  planInstall,
  planLines,
  planUninstall,
  resultLines,
  type InstallTarget,
  type RcState,
} from '../src/completion/installer.js';
import { SHELL_NAMES, type ShellName } from '../src/completion/shells.js';
import { parse } from '../src/parser/parse.js';
import type { ParseState, Schema } from '../src/types.js';
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * A home directory nothing in this file can escape.
 *
 * `node:os` is mocked rather than only `HOME` being stubbed, and both halves
 * are load bearing. `paths.home()` memoizes `homedir()` on first read, so a
 * variable set after any other test in the worker has already asked would be
 * too late -- and `vi.mock` is hoisted above every import, so the first ask in
 * this file gets the fake. The *variables* are stubbed as well because
 * `expand()` reads `%VAR%` on Windows and because a second reader added later
 * should find a fake there too: this is a feature that writes files into a home
 * directory, and this repository has already been bitten by a test that
 * scaffolded into the runner's real profile because it set only `HOME`.
 *
 * Under `tmpdir()` rather than anywhere clever, which is what every other test
 * here that needs a directory does.
 */
const FAKE_HOME = join(tmpdir(), `sigil-completion-home-${process.pid}`);

vi.mock('node:os', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:os')>()),
  homedir: () => FAKE_HOME,
}));

/**
 * Whether a mode bit means anything to the process running this.
 *
 * Root passes `accessSync(dir, W_OK | X_OK)` on a directory with neither bit
 * set, so the two cases that reach the writability gate by `chmod` are asserting
 * a premise -- "this cannot be written" -- that is false for the runner rather
 * than for the code. A rootful CI container is where that happens. The gate
 * itself is still pinned there by the executable-file case, which asks
 * `isDirectory()` and answers the same for everybody. Found by review round 3,
 * which caught the second of the two inheriting the first's unremarked.
 */
const MODES_BITE = process.getuid === undefined || process.getuid() !== 0;

/** Where each case's own files go, so one case cannot see another's. */
let box: string;

/** The environment handed to `installTargets()`, pointed at `box`. */
function envFor(
  extra: Record<string, string | undefined> = {}
): Record<string, string | undefined> {
  return { XDG_DATA_HOME: join(box, 'data'), ...extra };
}

beforeEach(() => {
  box = mkdtempSync(join(tmpdir(), 'sigil-completion-install-'));
  // emptied rather than only created, because it is one directory for the
  // whole file: a `.bashrc` one case wrote is a `.bashrc` the next case's
  // `firstExisting()` finds, which is a test passing on a fixture it did not
  // set up
  rmSync(FAKE_HOME, { force: true, recursive: true });
  mkdirSync(FAKE_HOME, { recursive: true });
  vi.stubEnv('HOME', FAKE_HOME);
  vi.stubEnv('USERPROFILE', FAKE_HOME);
});

afterEach(() => {
  rmSync(box, { force: true, recursive: true });
  vi.unstubAllEnvs();
});

afterAll(() => {
  rmSync(FAKE_HOME, { force: true, recursive: true });
});

/** The parse a script is printed from. */
async function state(schema: Schema = {}): Promise<ParseState> {
  return await parse({
    argv: [],
    env: {},
    schema: { commands: { build: { desc: 'Build it', run(): void {} } }, name: 'mycli', ...schema },
  });
}

/** The target the installer would pick, for one shell. */
function pick(shell: ShellName, extra: Record<string, string | undefined> = {}): InstallTarget {
  const [first] = installTargets(shell, 'mycli', envFor(extra));
  expect(first, `no target for ${shell}`).toBeDefined();
  return first as InstallTarget;
}

/** Installs for real, through the plan, and answers what was written. */
async function install(target: InstallTarget, script: string): Promise<boolean> {
  return await applyInstall(planInstall(target, script, 'mycli'), script);
}

describe('the home this file writes into', () => {
  it('should be the fake one, so the real one is unreachable', () => {
    // the guard the whole file rests on, asserted rather than assumed: a
    // mock that silently stopped applying would leave every case below
    // writing into somebody's actual home directory, and every one of them
    // would still pass
    expect(homedir()).toBe(FAKE_HOME);
    expect(homedir()).not.toBe(process.env.npm_config_userconfig);
    expect(FAKE_HOME.startsWith(tmpdir())).toBe(true);
  });
});

describe('installTargets()', () => {
  it('should put a zsh completion in a directory of our own, with an fpath line', () => {
    const target = pick('zsh');

    expect(target.id).toBe('user');
    expect(target.dir).toBe(join(box, 'data', 'completions'));
    expect(basename(target.file)).toBe('_mycli');
    expect(target.rc?.file).toBe(join(FAKE_HOME, '.zshrc'));
    expect(target.rc?.line).toBe(`fpath=(${shQuote(target.dir)} $fpath)`);
    expect(target.rc?.needle).toBe(target.dir);
  });

  it('should name the directory rather than the file in the zsh line, so a second app needs none', () => {
    // the payoff of one shared directory: the `fpath` line every sigil app
    // would print is the same line, so the second one you install finds it
    // already there. Asserted as the property rather than through two installs,
    // because what makes it true is the needle being the directory
    const [one] = installTargets('zsh', 'one', envFor());
    const [two] = installTargets('zsh', 'two', envFor());

    expect(one?.rc?.needle).toBe(two?.rc?.needle);
    expect(one?.file).not.toBe(two?.file);
  });

  it('should put a bash completion in a directory of our own, with a source line', () => {
    const target = pick('bash');

    expect(target.id).toBe('user');
    expect(basename(target.file)).toBe('mycli.bash');
    expect(target.rc?.line).toBe(`source ${shQuote(target.file)}`);
    expect(target.rc?.needle).toBe(target.file);
  });

  it("should prefer bash-completion's own user directory where it is there", () => {
    const bc = join(box, 'data', 'bash-completion', 'completions');
    mkdirSync(bc, { recursive: true });

    const [first, second] = installTargets('bash', 'mycli', envFor());

    expect(first?.id).toBe('bash-completion');
    expect(first?.file).toBe(join(bc, 'mycli'));
    // nothing to add, which is the whole reason it is preferred
    expect(first?.rc).toBeUndefined();
    // and the route that works anywhere is still behind it
    expect(second?.id).toBe('user');
  });

  it('should offer it only where the directory is there, which is the version signal', () => {
    // the input that makes the gate load bearing: with the directory absent
    // this must fall back, because a file written to a path nothing reads is
    // worse than one that needs a line added
    expect(installTargets('bash', 'mycli', envFor()).map((it) => it.id)).toEqual(['user']);
  });

  it('should refuse a bash-completion path that is a file rather than a directory', () => {
    // `statSync` answers for a file too, so a plain file at that path would
    // have been taken as the directory and the write would then fail with an
    // `ENOTDIR` naming nothing
    mkdirSync(join(box, 'data', 'bash-completion'), { recursive: true });
    writeFileSync(join(box, 'data', 'bash-completion', 'completions'), 'not a directory');

    expect(installTargets('bash', 'mycli', envFor()).map((it) => it.id)).toEqual(['user']);
  });

  it('should read ZDOTDIR for the zsh startup file, and only an absolute one', () => {
    const zdot = join(box, 'zdot');

    expect(pick('zsh', { ZDOTDIR: zdot }).rc?.file).toBe(join(zdot, '.zshrc'));
    // relative, so not a directory zsh would read either -- which is
    // `baseDir()`'s rule rather than a second one
    expect(pick('zsh', { ZDOTDIR: 'relative/zdot' }).rc?.file).toBe(join(FAKE_HOME, '.zshrc'));
  });

  it('should fall back to ~/.local/share where XDG_DATA_HOME says nothing usable', () => {
    const under = join(FAKE_HOME, '.local', 'share', 'completions');

    expect(installTargets('zsh', 'mycli', {})[0]?.dir).toBe(under);
    // set and relative is set and unusable, which is the spec's own rule and
    // the one `baseDir()` keeps
    expect(installTargets('zsh', 'mycli', { XDG_DATA_HOME: './data' })[0]?.dir).toBe(under);
    expect(installTargets('zsh', 'mycli', { XDG_DATA_HOME: '' })[0]?.dir).toBe(under);
  });

  it('should expand a ~ in XDG_DATA_HOME rather than making a directory called ~', () => {
    // the defect `paths.ts` records for its own table, met through a variable:
    // `expand()` runs before the absoluteness is asked, which is the order
    // `baseDir()` is written in
    expect(installTargets('zsh', 'mycli', { XDG_DATA_HOME: '~/xdg' })[0]?.dir).toBe(
      join(FAKE_HOME, 'xdg', 'completions')
    );
  });

  it('should name the bash startup file that is there rather than always .bashrc', () => {
    // macOS starts bash as a login shell, which reads `.bash_profile` and not
    // `.bashrc` -- so a line in the file that is not there is a line the shell
    // never reads
    expect(pick('bash').rc?.file).toBe(join(FAKE_HOME, '.bashrc'));

    writeFileSync(join(FAKE_HOME, '.bash_profile'), '# mine\n');
    expect(pick('bash').rc?.file).toBe(join(FAKE_HOME, '.bash_profile'));

    writeFileSync(join(FAKE_HOME, '.bashrc'), '# mine\n');
    expect(pick('bash').rc?.file).toBe(join(FAKE_HOME, '.bashrc'));
  });

  it('should skip a startup-file candidate that is a directory', () => {
    // `EISDIR` is not absence, and a directory called `.bashrc` is not a file
    // a shell reads -- a **directory** rather than a path under a file, because
    // that one is `ENOTDIR` on POSIX and reads as absence on Windows
    mkdirSync(join(FAKE_HOME, '.bashrc'));
    writeFileSync(join(FAKE_HOME, '.bash_profile'), '# mine\n');

    expect(pick('bash').rc?.file).toBe(join(FAKE_HOME, '.bash_profile'));
  });

  it('should name the path it writes in the route it came from', () => {
    // the differential the whole "one mechanism" claim rests on, and the only
    // thing that can check it: no type can say that a printed command holds a
    // path. The shown form is `~`-relative and machine-independent because it
    // goes into a script's own header, so what is compared is the resolved path
    // with the home put back as a `~`
    // the bash-completion directory under the base the call below reads, which
    // is what makes the route resolve at all. The first version of this created
    // it under `box/data` and then called `installTargets()` with no
    // `XDG_DATA_HOME`, so the gate looked under `FAKE_HOME/.local/share` and
    // never found it: the loop only ever saw the `user` target, and the route
    // whose shown and resolved forms differ most -- a different directory and a
    // filename with no `.bash` on it -- was the one not covered. Found by
    // review, and its own comment claimed the fixture it did not have
    mkdirSync(join(FAKE_HOME, '.local', 'share', 'bash-completion', 'completions'), {
      recursive: true,
    });

    for (const shell of SHELL_NAMES) {
      const { routes } = installHint(shell, 'mycli');
      const seen = new Set<string>();

      for (const target of installTargets(shell, 'mycli', { HOME: FAKE_HOME })) {
        seen.add(target.id);
        const route = routes.find((it) => it.id === target.id);
        const shown = target.file.replace(FAKE_HOME, '~');

        expect(route, `no route for ${target.id}`).toBeDefined();
        expect(
          route?.commands.some((command) => command.includes(shown)),
          `${shell}/${target.id}: no command names ${shown} in ${JSON.stringify(route?.commands)}`
        ).toBe(true);
      }

      // and the loop really reached both bash routes, or the paragraph above is
      // a fixture nobody checked for a second time
      expect([...seen].sort()).toEqual(shell === 'bash' ? ['bash-completion', 'user'] : ['user']);
    }
  });

  it('should resolve every route the table offers and no route it does not', () => {
    // the other half of the differential: a target whose id is in no route is
    // a resolver that outlived its table, which the `installTargets()` walk
    // makes structurally impossible -- so this is what fails if somebody
    // reintroduces a lookup
    mkdirSync(join(box, 'data', 'bash-completion', 'completions'), { recursive: true });

    for (const shell of SHELL_NAMES) {
      const ids = new Set(installHint(shell, 'mycli').routes.map((it) => it.id));
      for (const target of installTargets(shell, 'mycli', envFor())) {
        expect(ids.has(target.id), `${shell}: ${target.id} is in no route`).toBe(true);
      }
    }
  });
});

describe('the marker', () => {
  it('should be in every script both emitters print', async () => {
    const st = await state();

    for (const shell of SHELL_NAMES) {
      expect(await completionScript(st, shell)).toContain(generatedBy(shell, 'mycli'));
    }
  });

  it('should name the shell, so a script at the other shell path is foreign', async () => {
    const st = await state();
    const zsh = await completionScript(st, 'zsh');
    const target = pick('bash');

    mkdirSync(target.dir, { recursive: true });
    writeFileSync(target.file, zsh);

    expect(planInstall(target, await completionScript(st, 'bash'), 'mycli').file).toBe('foreign');
  });
});

describe('what the round-1 review found', () => {
  it('should read the marker in the header rather than anywhere in the file', async () => {
    const st = await state();
    const script = await completionScript(st, 'zsh');
    const target = pick('zsh');
    mkdirSync(target.dir, { recursive: true });

    // the marker as a whole comment line of its own, fifty lines down. The
    // marker is a sentence and a sentence is something any file can contain, so
    // a search over the whole file read somebody's note as generated output --
    // and `planUninstall()` then unlinked it after one default-yes confirm.
    //
    // A **whole** line rather than a quoted one, which is what makes the window
    // the thing under test: round 1's fixture wrote `# not the <marker>`, and
    // once round 2 tightened the comparison to equality that line was foreign
    // whatever the window was -- so widening the window to the whole file
    // changed no answer and the test that is named for the window stayed green.
    // Found by the sabotage pass
    writeFileSync(
      target.file,
      `# my own thing\n${'# padding\n'.repeat(40)}# ${generatedBy('zsh', 'mycli')}\n`
    );

    expect(planInstall(target, script, 'mycli').file).toBe('foreign');
    expect(planUninstall(target, 'mycli').file).toBe('foreign');

    // and the header really is where ours puts it, or the check above is
    // tighter than the emitters -- which is what the real script says and not
    // what a `toBeDefined()` says, as the first version of this had it: that
    // assertion holds for every object there is, so the pair below is the whole
    // of the claim. Found by review round 2
    writeFileSync(target.file, script);
    expect(planInstall(target, script, 'mycli').file).toBe('current');
  });

  it('should refuse to write over a foreign file unless the caller says it asked', async () => {
    const st = await state();
    const script = await completionScript(st, 'zsh');
    const target = pick('zsh');
    mkdirSync(target.dir, { recursive: true });
    writeFileSync(target.file, '# mine\n');

    const plan = planInstall(target, script, 'mycli');

    // the writer enforcing its own rule rather than one caller's discipline:
    // handed a `foreign` plan with no answer this used to write
    await expect(applyInstall(plan, script)).rejects.toThrow(/did not write/);
    expect(readFileSync(target.file, 'utf8')).toBe('# mine\n');

    // and with the answer it writes, which is what the question is for
    expect(await applyInstall(plan, script, { replace: true })).toBe(true);
    expect(readFileSync(target.file, 'utf8')).toBe(script);
  });

  it('should refuse to remove a foreign file however it is asked', async () => {
    const target = pick('zsh');
    mkdirSync(target.dir, { recursive: true });
    writeFileSync(target.file, '# mine\n');

    // no opt-in at all on this side, which is the asymmetry: replacing a
    // generated path is an upgrade and deleting a stranger's file gains
    // nothing a `rm` would not
    expect(() => applyUninstall(planUninstall(target, 'mycli'))).toThrow(/did not write/);
    expect(readFileSync(target.file, 'utf8')).toBe('# mine\n');
  });

  it('should see the rc line in the spelling its own instructions print', () => {
    // the target under the **home** base rather than the box's, because the
    // spelling under test is `~` and only a path under the home has one
    const [target] = installTargets('zsh', 'mycli', {});
    const rcFile = join(FAKE_HOME, '.zshrc');
    const held = (): RcState => planInstall(target as InstallTarget, '', 'mycli').rc;

    expect(target?.rc?.needle).toBe(join(FAKE_HOME, '.local', 'share', 'completions'));

    // `~`, which is what `installComment()` writes into every script's header
    // and what `instructions()` prints -- so this is our own output not being
    // recognised by our own check, which reprinted the line for ever
    writeFileSync(rcFile, 'fpath=(~/.local/share/completions $fpath)\n');
    expect(held()).toBe('present');

    // and `$HOME`, for a writer who did not want the tilde
    writeFileSync(rcFile, 'fpath=($HOME/.local/share/completions $fpath)\n');
    expect(held()).toBe('present');

    // and the absolute one, which is the spelling this prints
    writeFileSync(rcFile, `fpath=('${join(FAKE_HOME, '.local', 'share', 'completions')}')\n`);
    expect(held()).toBe('present');

    // while a path that is not the one is still absent, or the match is a
    // search for anything at all
    writeFileSync(rcFile, 'fpath=(~/.local/share/other $fpath)\n');
    expect(held()).toBe('absent');
  });

  it('should refuse a program name that is not one path segment', () => {
    // measured: `../../../evil` wrote one directory up and out of the
    // completions directory, with `writeAtomic()` creating whatever chain it
    // landed in. `completionSpec()` refuses whitespace and a leading dash,
    // because those are what a shell cannot register, and lets a separator
    // through because a shell does not care
    for (const bad of ['../../../evil', 'a/b', '.', '..', '']) {
      expect(() => installTargets('zsh', bad, envFor()), bad).toThrow(/one path segment/);
      expect(() => installTargets('bash', bad, envFor()), bad).toThrow(/one path segment/);
    }

    // and a name with a dot or a dash in it is still one segment, or the guard
    // refuses the ordinary case
    for (const good of ['my-cli', 'my.cli', '_x']) {
      expect(installTargets('zsh', good, envFor())[0]?.file, good).toContain(good);
    }
  });

  it.skipIf(!MODES_BITE)(
    "should not offer bash-completion's directory where it cannot be written",
    () => {
      const bc = join(box, 'data', 'bash-completion', 'completions');
      mkdirSync(bc, { recursive: true });
      expect(installTargets('bash', 'mycli', envFor())[0]?.id).toBe('bash-completion');

      // root-owned from a system install, a read-only mount, somebody else's on a
      // shared machine: existence alone preferred it and `writeAtomic()` then
      // threw a raw EACCES while the route that works on any bash sat unused
      chmodSync(bc, 0o500);
      try {
        expect(installTargets('bash', 'mycli', envFor()).map((it) => it.id)).toEqual(['user']);
      } finally {
        chmodSync(bc, 0o700);
      }
    }
  );

  it('should count the rc line as outstanding for an uninstall too', async () => {
    const st = await state();
    const target = pick('zsh');
    await install(target, await completionScript(st, 'zsh'));
    writeFileSync(join(FAKE_HOME, '.zshrc'), `${target.rc?.line ?? ''}\n`);

    // the script removed by hand, the line still there. `changes: false` said
    // "Nothing to do." while `resultLines()` printed "Remove this line from
    // ..." in the same breath -- the interface's own contract disagreeing with
    // one of its two constructors
    rmSync(target.file);

    const plan = planUninstall(target, 'mycli');
    expect(plan.file).toBe('create');
    expect(plan.rc).toBe('present');
    expect(plan.writes).toBe(false);
    expect(plan.changes).toBe(true);
    expect(resultLines(plan, 'uninstall', false).join('\n')).not.toContain('Nothing to do');
  });

  it('should raise an unreadable startup file as a sentence rather than as a node error', () => {
    const target = pick('zsh');
    // a **directory** where the startup file goes, which is `EISDIR` on every
    // platform -- a path under a file is `ENOTDIR` on POSIX and reads as
    // absence on Windows
    mkdirSync(target.rc?.file ?? '', { recursive: true });

    expect(() => planInstall(target, '', 'mycli')).toThrow(/Failed to read/);
  });
});

describe('planInstall()', () => {
  it('should say create where there is nothing there', async () => {
    const script = await completionScript(await state(), 'zsh');
    const plan = planInstall(pick('zsh'), script, 'mycli');

    expect(plan.file).toBe('create');
    expect(plan.rc).toBe('absent');
    expect(plan.changes).toBe(true);
  });

  it('should say foreign for a file nobody generated, and refuse to call it a change we can make quietly', async () => {
    const target = pick('zsh');
    mkdirSync(target.dir, { recursive: true });
    writeFileSync(target.file, '# my own completion, hands off\n');

    const plan = planInstall(target, await completionScript(await state(), 'zsh'), 'mycli');

    expect(plan.file).toBe('foreign');
    expect(plan.changes).toBe(true);
  });

  it('should say present where the startup file already names the path', async () => {
    const target = pick('zsh');
    writeFileSync(join(FAKE_HOME, '.zshrc'), `# mine\n${target.rc?.line ?? ''}\n`);

    expect(planInstall(target, await completionScript(await state(), 'zsh'), 'mycli').rc).toBe(
      'present'
    );
  });

  it('should read the path rather than the line, so a hand-written spelling counts', async () => {
    const target = pick('zsh');
    // double quotes and a different order, which is what somebody who added it
    // themselves is likely to have written -- the path is the granularity a
    // human checks at
    writeFileSync(join(FAKE_HOME, '.zshrc'), `fpath+=("${target.dir}")\n`);

    expect(planInstall(target, await completionScript(await state(), 'zsh'), 'mycli').rc).toBe(
      'present'
    );
  });

  it('should say none where the route needs no line at all', async () => {
    mkdirSync(join(box, 'data', 'bash-completion', 'completions'), { recursive: true });
    const target = pick('bash');

    expect(target.id).toBe('bash-completion');
    expect(planInstall(target, await completionScript(await state(), 'bash'), 'mycli').rc).toBe(
      'none'
    );
  });

  it('should raise a read failure that is not the file being absent', async () => {
    const target = pick('zsh');
    // a **directory** at the script's path, which is `EISDIR` on every
    // platform -- a path under a file would be `ENOTDIR` on POSIX and read as
    // absence on Windows, so it would pin nothing there.
    //
    // Both halves of the message, because the first version matched `/EISDIR/`
    // alone -- which the raw node error satisfies, so it could not tell the
    // wrapped sentence from the one `readFileSync` throws and the wrapping is
    // the thing this test is named for. Found by review round 2
    mkdirSync(target.file, { recursive: true });

    expect(() => planInstall(target, 'x', 'mycli')).toThrow(/^Failed to read .*: EISDIR/);
  });
});

describe('installing, and re-running', () => {
  it('should write the script and then leave it alone', async () => {
    const st = await state();
    const script = await completionScript(st, 'zsh');
    const target = pick('zsh');

    // first run: it has to have actually written, or the second run's "nothing
    // to do" is a test that passes over an installer that does nothing
    expect(await install(target, script)).toBe(true);
    expect(readFileSync(target.file, 'utf8')).toBe(script);

    const again = planInstall(target, script, 'mycli');
    expect(again.file).toBe('current');
    expect(await applyInstall(again, script)).toBe(false);
    expect(readFileSync(target.file, 'utf8')).toBe(script);
  });

  it('should not touch the file it left alone, which is what current means', async () => {
    const st = await state();
    const script = await completionScript(st, 'zsh');
    const target = pick('zsh');

    await install(target, script);
    const before = lstatSync(target.file);

    // the **inode** rather than only the mtime, and that is what makes this
    // test say what its name does: `writeAtomic()` renames a temp file over the
    // target, so a write replaces the directory entry and the inode changes
    // whatever the clock did. An mtime can tie on a coarse filesystem, so a
    // regression that rewrote the file within one tick passed -- and the first
    // version of this comment claimed a sentinel, an unwritable file, that the
    // body never set up. Found by review
    const plan = planInstall(target, script, 'mycli');
    expect(await applyInstall(plan, script)).toBe(false);

    const after = lstatSync(target.file);
    expect(after.ino).toBe(before.ino);
    expect(after.mtimeMs).toBe(before.mtimeMs);
  });

  it('should say update rather than current when the app changed, which is the input that makes the comparison matter', async () => {
    const target = pick('zsh');
    const before = await completionScript(await state(), 'zsh');
    await install(target, before);

    // the same app with one more command, which is exactly why a completion
    // script is regenerated -- and a `current` here would be a stale script
    // left on disk for ever
    const after = await completionScript(
      await state({
        commands: {
          build: { desc: 'Build it', run(): void {} },
          deploy: { desc: 'Ship it', run(): void {} },
        },
      }),
      'zsh'
    );

    const plan = planInstall(target, after, 'mycli');
    expect(plan.file).toBe('update');
    expect(plan.changes).toBe(true);
    expect(await applyInstall(plan, after)).toBe(true);
    expect(readFileSync(target.file, 'utf8')).toBe(after);
  });

  it('should have nothing to write where only the line is outstanding, which is what decides whether to ask', async () => {
    const st = await state();
    const script = await completionScript(st, 'zsh');
    const target = pick('zsh');

    await install(target, script);

    // the two booleans part here, and this is the input that separates them: a
    // confirm gated on `changes` would ask permission to write a file that is
    // already right, and then be told "nothing to do" by the answer
    const plan = planInstall(target, script, 'mycli');
    expect(plan.changes).toBe(true);
    expect(plan.writes).toBe(false);

    // and what it says is the line, without claiming it wrote or that there is
    // nothing to do -- both of which shipped for a commit each
    const said = resultLines(plan, 'install', false).join('\n');
    expect(said).not.toContain('Nothing to do');
    expect(said).not.toContain('Wrote');
    expect(said).toContain(target.rc?.line ?? '!');
  });

  it('should say nothing to do only where nothing at all is outstanding', async () => {
    const st = await state();
    const script = await completionScript(st, 'zsh');
    const target = pick('zsh');

    await install(target, script);
    writeFileSync(join(FAKE_HOME, '.zshrc'), `${target.rc?.line ?? ''}\n`);

    const plan = planInstall(target, script, 'mycli');
    expect(plan.changes).toBe(false);
    expect(resultLines(plan, 'install', false).join('\n')).toContain('Nothing to do');
  });

  it('should still have something to do where the file is current and the line is not there', async () => {
    const st = await state();
    const script = await completionScript(st, 'zsh');
    const target = pick('zsh');

    await install(target, script);

    // the case a bare `changes = file === 'current'` would get wrong: the
    // script is right and the startup file never got its line, which is not
    // "nothing to do"
    const plan = planInstall(target, script, 'mycli');
    expect(plan.file).toBe('current');
    expect(plan.rc).toBe('absent');
    expect(plan.changes).toBe(true);
  });

  it('should be nothing to do only when both halves are done', async () => {
    const st = await state();
    const script = await completionScript(st, 'zsh');
    const target = pick('zsh');

    await install(target, script);
    writeFileSync(join(FAKE_HOME, '.zshrc'), `${target.rc?.line ?? ''}\n`);

    expect(planInstall(target, script, 'mycli').changes).toBe(false);
  });

  it('should create the directory it writes into', async () => {
    const target = pick('zsh');
    expect(() => lstatSync(target.dir)).toThrow();

    await install(target, await completionScript(await state(), 'zsh'));

    expect(lstatSync(target.dir).isDirectory()).toBe(true);
  });

  it('should write through a symlink rather than replacing it', async () => {
    // the defect `config/atomic.ts` was fixed for twice, which reaches here
    // because people check completions into a dotfiles repository. A second
    // resolver would have had to get it right again; this is a second *caller*
    const real = join(box, 'dotfiles', '_mycli');
    const target = pick('zsh');

    mkdirSync(dirname(real), { recursive: true });
    writeFileSync(real, '# old\n');
    mkdirSync(target.dir, { recursive: true });
    symlinkSync(real, target.file);

    const script = await completionScript(await state(), 'zsh');

    // the link's **target** is what is read, so a target with no marker in it
    // is foreign -- the refusal reaching through the link rather than stopping
    // at it
    expect(planInstall(target, script, 'mycli').file).toBe('foreign');

    // and once the target is ours, the write goes through the link: the link
    // survives and the real file is what changed, which is the defect
    // `realPathOf()` exists for
    writeFileSync(real, `${script}# stale\n`);
    expect(planInstall(target, script, 'mycli').file).toBe('update');
    expect(await install(target, script)).toBe(true);
    expect(lstatSync(target.file).isSymbolicLink()).toBe(true);
    expect(readFileSync(real, 'utf8')).toBe(script);
  });

  it('should keep the mode of a file somebody chmod-ed', async () => {
    const st = await state();
    const script = await completionScript(st, 'zsh');
    const target = pick('zsh');

    await install(target, script);
    const { chmodSync } = await import('node:fs');
    chmodSync(target.file, 0o600);

    await applyInstall(planInstall(target, `${script}\n# more\n`, 'mycli'), `${script}\n# more\n`);

    // `writeAtomic()`'s own rule, reached through this caller: a completion
    // somebody made private stays private
    expect(lstatSync(target.file).mode & 0o777).toBe(0o600);
  });
});

describe('uninstalling', () => {
  it('should remove a script it wrote and say there is nothing left', async () => {
    const st = await state();
    const target = pick('zsh');
    await install(target, await completionScript(st, 'zsh'));

    const plan = planUninstall(target, 'mycli');
    expect(plan.file).toBe('update');
    expect(plan.changes).toBe(true);
    // the same for an uninstall, because a `foreign` file is refused outright:
    // there is nothing to ask about that is not also something to do
    expect(plan.writes).toBe(true);
    expect(applyUninstall(plan)).toBe(true);
    expect(() => lstatSync(target.file)).toThrow();

    const again = planUninstall(target, 'mycli');
    expect(again.file).toBe('create');
    expect(again.changes).toBe(false);
    expect(applyUninstall(again)).toBe(false);
  });

  it('should refuse a file it did not write, outright rather than by asking', async () => {
    const target = pick('zsh');
    mkdirSync(target.dir, { recursive: true });
    writeFileSync(target.file, '# somebody else\n');

    const plan = planUninstall(target, 'mycli');
    expect(plan.file).toBe('foreign');
    // `false`, which is what makes the question unreachable: the install side
    // asks before replacing a generated path, and deleting a stranger's file
    // gains nothing a `rm` would not. The plan says whose it is instead
    expect(plan.changes).toBe(false);
    expect(plan.writes).toBe(false);
    expect(planLines(plan, 'uninstall').join('\n')).toContain('not written by sigil');
    expect(readFileSync(target.file, 'utf8')).toBe('# somebody else\n');
  });

  it('should still say the startup file names it, because that line is the reader to remove', async () => {
    const st = await state();
    const target = pick('zsh');
    await install(target, await completionScript(st, 'zsh'));
    writeFileSync(join(FAKE_HOME, '.zshrc'), `${target.rc?.line ?? ''}\n`);

    expect(planUninstall(target, 'mycli').rc).toBe('present');
  });
});

describe('what it says', () => {
  it('should say whose a foreign file is rather than that it will replace it', async () => {
    // the defect the end-to-end test found: the plan had no `foreign` branch,
    // so a file somebody wrote was previewed as "It will replace", which reads
    // as a decision already taken. A unit test of the plan's *state* could not
    // see it -- it was `foreign` all along -- so what is asserted is the
    // sentence
    const target = pick('zsh');
    mkdirSync(target.dir, { recursive: true });
    writeFileSync(target.file, '# mine\n');

    const said = planLines(
      planInstall(target, await completionScript(await state(), 'zsh'), 'mycli'),
      'install'
    ).join('\n');

    expect(said).toContain('not written by sigil');
    expect(said).not.toContain('will replace');
  });

  it('should name the path in the plan, for every state', async () => {
    const st = await state();
    const script = await completionScript(st, 'zsh');
    const target = pick('zsh');

    expect(planLines(planInstall(target, script, 'mycli'), 'install').join('\n')).toContain(
      target.file
    );

    await install(target, script);
    expect(planLines(planInstall(target, script, 'mycli'), 'install').join('\n')).toContain(
      target.file
    );
    expect(planLines(planUninstall(target, 'mycli'), 'uninstall').join('\n')).toContain(
      target.file
    );
  });

  it('should print the line to add and never add it', async () => {
    const st = await state();
    const script = await completionScript(st, 'zsh');
    const target = pick('zsh');
    const rcFile = join(FAKE_HOME, '.zshrc');

    writeFileSync(rcFile, '# mine\n');
    const plan = planInstall(target, script, 'mycli');
    await applyInstall(plan, script);

    const said = resultLines(plan, 'install', true).join('\n');

    expect(said).toContain(target.rc?.line ?? '!');
    expect(said).toContain('compinit');
    // the half that is the whole decision: the startup file is read and not
    // written
    expect(readFileSync(rcFile, 'utf8')).toBe('# mine\n');
  });

  it('should quote the line it prints, so a home with a space in it is one word', () => {
    // `homedir()` can answer anything, and `~/Library/Application Support` is
    // the obvious one: an unquoted line is a shell injection into a file that
    // runs on every login
    const dir = join(box, 'a dir', "it's");
    expect(shQuote(dir)).toBe(`'${join(box, 'a dir', "it'\\''s")}'`);
    expect(installTargets('zsh', 'mycli', { XDG_DATA_HOME: dir })[0]?.rc?.line).toContain(
      shQuote(join(dir, 'completions'))
    );
  });

  it('should say nothing to add where the route needs no line', async () => {
    mkdirSync(join(box, 'data', 'bash-completion', 'completions'), { recursive: true });
    const st = await state();
    const script = await completionScript(st, 'bash');
    const target = pick('bash');
    const plan = planInstall(target, script, 'mycli');

    await applyInstall(plan, script);
    const said = resultLines(plan, 'install', true).join('\n');

    expect(said).toContain(target.file);
    expect(said).not.toContain('source');
    expect(said).toContain('restart');
  });

  it('should print the line to remove on the way out, and never remove it', async () => {
    const st = await state();
    const target = pick('zsh');
    const rcFile = join(FAKE_HOME, '.zshrc');
    await install(target, await completionScript(st, 'zsh'));
    writeFileSync(rcFile, `${target.rc?.line ?? ''}\n`);

    const plan = planUninstall(target, 'mycli');
    applyUninstall(plan);
    const said = resultLines(plan, 'uninstall', true).join('\n');

    expect(said).toContain(target.rc?.line ?? '!');
    expect(readFileSync(rcFile, 'utf8')).toBe(`${target.rc?.line ?? ''}\n`);
  });
});

describe('what the round-2 review found', () => {
  it('should say whose a foreign file is on the way out rather than throwing, with the line still there', async () => {
    const target = pick('zsh');
    mkdirSync(target.dir, { recursive: true });
    writeFileSync(target.file, '# somebody else wrote this\n');
    // the rc line present as well, which is the composition the two round-1
    // fixes had between them: `changes` was true because of the line, the
    // confirm was asked, and `applyUninstall()` then refused outright -- so a
    // refusal the plan had already printed came back out of the generic error
    // handler as a stack-free crash. Neither fix is wrong alone
    writeFileSync(join(FAKE_HOME, '.zshrc'), `${target.rc?.line ?? ''}\n`);

    const plan = planUninstall(target, 'mycli');

    expect(plan.file).toBe('foreign');
    expect(plan.writes).toBe(false);
    expect(plan.changes).toBe(true);
    expect(planLines(plan, 'uninstall').join('\n')).toContain('was not written by sigil');
    // and the apply layer still refuses outright if it is reached, which is
    // why the gate above it has to be `writes` rather than `changes`
    expect(() => applyUninstall(plan)).toThrow(/did not write/);
  });

  it('should refuse a foreign file against the file it is about to write, not against the plan it was handed', async () => {
    const st = await state();
    const script = await completionScript(st, 'zsh');
    const target = pick('zsh');
    mkdirSync(target.dir, { recursive: true });

    // planned when there was nothing there, so the plan says `create` and
    // carries no refusal -- and something else put a file at the path before
    // the write. A check against the plan is a check against what was true a
    // moment ago, which for a path in a shared home is not the question
    const plan = planInstall(target, script, 'mycli');
    expect(plan.file).toBe('create');
    writeFileSync(target.file, '# mine now\n');

    await expect(applyInstall(plan, script, { replace: false })).rejects.toThrow(
      /Refusing to replace/
    );
    expect(readFileSync(target.file, 'utf8')).toBe('# mine now\n');
  });

  it('should let a yes about the path cover whatever stranger is there when it writes', async () => {
    const st = await state();
    const script = await completionScript(st, 'zsh');
    const target = pick('zsh');
    mkdirSync(target.dir, { recursive: true });
    writeFileSync(target.file, '# file A, somebody else\n');

    const plan = planInstall(target, script, 'mycli');
    expect(plan.file).toBe('foreign');
    // a *different* stranger's file in the window the question was on screen,
    // which the answer still covers. A decision rather than a hole, and the
    // reasons are on `replaceable()`: the question names the path and nothing
    // else, and the destructive direction refuses a stranger at any age. Pinned
    // so that it is checked rather than declared -- the comment claimed the
    // opposite until review round 3
    writeFileSync(target.file, '# file B, somebody else again\n');

    expect(await applyInstall(plan, script, { replace: true })).toBe(true);
    expect(readFileSync(target.file, 'utf8')).toBe(script);
  });

  it('should refuse to unlink a foreign file that appeared after the plan was taken', async () => {
    const target = pick('zsh');
    mkdirSync(target.dir, { recursive: true });
    writeFileSync(target.file, await completionScript(await state(), 'zsh'));

    const plan = planUninstall(target, 'mycli');
    expect(plan.writes).toBe(true);
    writeFileSync(target.file, '# mine now\n');

    expect(() => applyUninstall(plan)).toThrow(/did not write/);
    expect(readFileSync(target.file, 'utf8')).toBe('# mine now\n');
  });

  it('should recognise every home spelling a startup file can hold', async () => {
    const script = await completionScript(await state(), 'zsh');
    // the default route rather than `box`, because the whole function only
    // fires for a path under the home and `XDG_DATA_HOME` points `box`
    // elsewhere -- which is what every other case in this file wants and this
    // one cannot have
    const [first] = installTargets('zsh', 'mycli', { XDG_DATA_HOME: undefined });
    const target = first as InstallTarget;
    const rcFile = target.rc?.file ?? '';
    const tail = target.dir.slice(FAKE_HOME.length).replaceAll('\\', '/');

    expect(target.dir.startsWith(FAKE_HOME)).toBe(true);

    // `~` is this package's own output -- every generated header and every
    // printed recipe writes one -- and `$HOME` and `${HOME}` are what a shell
    // writer who did not want a tilde wrote. The braced form is the one the
    // first version missed, and it is the common one in a hand-maintained
    // dotfile because it survives concatenation
    for (const home of ['~', '$HOME', '${HOME}']) {
      writeFileSync(rcFile, `fpath+=("${home}${tail}")\n`);
      expect(planInstall(target, script, 'mycli').rc, home).toBe('present');
    }
  });

  it('should not read a home that merely shares a prefix as the home', async () => {
    const script = await completionScript(await state(), 'zsh');
    // a sibling of the fake home whose name extends it, which is what
    // `XDG_DATA_HOME` pointed one directory sideways produces -- home
    // `/tmp/home` against `/tmp/homely/...` derives `$HOMEly/...`, naming a
    // variable nobody set
    const near = `${FAKE_HOME}ly`;
    mkdirSync(near, { recursive: true });
    const [target] = installTargets('zsh', 'mycli', envFor({ XDG_DATA_HOME: near }));
    const rcFile = target?.rc?.file ?? '';
    const tail = (target?.dir ?? '').slice(FAKE_HOME.length).replaceAll('\\', '/');

    writeFileSync(rcFile, `fpath+=("$HOME${tail}")\n`);

    expect(target?.dir.startsWith(near)).toBe(true);
    expect(planInstall(target as InstallTarget, script, 'mycli').rc).toBe('absent');
    rmSync(near, { force: true, recursive: true });
  });

  it.skipIf(!MODES_BITE)(
    'should refuse a bash-completion directory it cannot enter as well as one it cannot write',
    () => {
      const dir = join(box, 'data', 'bash-completion', 'completions');
      mkdirSync(dir, { recursive: true });
      // write-only, which `W_OK` alone passes: a gate that asked only about
      // writing offered the route and then failed inside `writeAtomic()` on the
      // `mkdir` -- which is the one failure mode a gate exists to turn into an
      // offer that is not made
      chmodSync(dir, 0o200);

      try {
        expect(installTargets('bash', 'mycli', envFor())[0]?.id).not.toBe('bash-completion');
      } finally {
        chmodSync(dir, 0o700);
      }
    }
  );

  it('should refuse an executable file where the bash-completion directory goes', () => {
    const dir = join(box, 'data', 'bash-completion', 'completions');
    mkdirSync(dirname(dir), { recursive: true });
    // the one input the directory test answers for and the access test does
    // not, measured rather than reasoned: a **missing** path is `ENOENT` out of
    // `accessSync` and a non-executable file is `EACCES`, so for both of those
    // the route is skipped whether or not anything asked what kind of thing is
    // there. An executable file passes `W_OK | X_OK` outright, and the route is
    // then offered over a path `writeAtomic()` fails on with `ENOTDIR` -- which
    // is a gate failing to not offer a route that cannot work, and is the whole
    // of what the gate is for. Found by the sabotage pass
    writeFileSync(dir, '#!/bin/sh\n');
    chmodSync(dir, 0o700);

    expect(installTargets('bash', 'mycli', envFor())[0]?.id).not.toBe('bash-completion');
  });

  it('should take a route it can both write and enter', () => {
    const dir = join(box, 'data', 'bash-completion', 'completions');
    mkdirSync(dir, { recursive: true });

    expect(installTargets('bash', 'mycli', envFor())[0]?.id).toBe('bash-completion');
  });

  it('should not read a file that quotes the marker in its own header as one of ours', async () => {
    const script = await completionScript(await state(), 'zsh');
    const target = pick('zsh');
    mkdirSync(target.dir, { recursive: true });
    // the marker as an exact comment with more after it, on line 2, which a
    // substring check reads as the header and a whole-line check does not. The
    // round-1 test quoted it at line 50, which the three-line window already
    // excluded -- so the window was doing the work and the comparison was
    // unpinned.
    //
    // The leading `# ` is part of the marker, which is why the first version of
    // this fixture could not reach the branch either: `# unlike the "<marker>"`
    // holds the sentence and not the comment, so a substring check answered no
    // and the mutation survived the test written for it. Found by the sabotage
    // pass
    writeFileSync(
      target.file,
      `#!/bin/zsh\n# ${generatedBy('zsh', 'mycli')} -- no, this one is mine\nfoo\n`
    );

    expect(planInstall(target, script, 'mycli').file).toBe('foreign');
  });

  it('should reduce one name to one program, at both readers', async () => {
    const esc = String.fromCharCode(0x1b);
    // the input that made the two readers disagree about the *subject* rather
    // than the predicate: `completionSpec()` strips the control character and
    // the installer did not, so the script's header named `mycli` and the file
    // it was written to was `_my<ESC>cli` with a marker naming the raw string.
    // Measured before the fix: the first install wrote, every re-run read its
    // own file as `foreign`, and `--uninstall` refused to remove it. Found by
    // review round 3
    const st = await parse({
      argv: [],
      env: {},
      schema: { commands: { b: { run(): void {} } }, name: `my${esc}cli` },
    });
    const script = await completionScript(st, 'zsh');
    const program = programOf(st.schema.name) ?? '';
    const [target] = installTargets('zsh', program, envFor());

    expect(program).toBe('mycli');
    expect(basename(target?.file ?? '')).toBe('_mycli');
    expect(script).toContain(generatedBy('zsh', program));

    // and the marker the installer builds is the one the emitter wrote, which
    // is what makes a re-run a re-run rather than a stranger's file
    mkdirSync(target?.dir ?? '', { recursive: true });
    writeFileSync(target?.file ?? '', script);
    expect(planInstall(target as InstallTarget, script, program).file).toBe('current');
    expect(planUninstall(target as InstallTarget, program).file).toBe('update');
  });

  it('should take a padded name on the install path, which the printer already trimmed', async () => {
    // the second half of the same divergence, from the other side:
    // `installTargets()` runs before `completionScript()` does, so a name the
    // printer serves happily threw on the install path
    const program = programOf(' mycli ') ?? '';

    expect(program).toBe('mycli');
    expect(() => installTargets('zsh', program, envFor())).not.toThrow();
  });

  it('should refuse a nameless app rather than reaching for a file called _app', async () => {
    const { runInstaller } = await import('../src/completion/interactive.js');
    const st = await parse({ argv: [], env: {}, schema: { commands: { b: { run(): void {} } } } });

    // the `?? 'app'` fallback this replaced is the one a nameless app met on
    // the **uninstall** direction, which builds no script and so reached no
    // other guard: `installTargets()` resolved `_app` and the marker named
    // `app`, so a stray file of that name would have been removed. The install
    // direction was covered by accident, because `completionScript()` runs
    // first and refuses. Found by review round 3
    // the shell named, because the shell prompt comes first and in a worker
    // there is nobody to ask -- so a bare call takes the no-TTY branch and
    // never reaches the guard, which is what the first version of this test
    // asserted its way past
    await expect(runInstaller(st, { shell: 'zsh', uninstall: true })).rejects.toThrow(
      /one path segment/
    );
  });

  it('should refuse the same program name at both readers', () => {
    // `spec.ts` refuses a name that is not one word and `installTargets()` has
    // to refuse the same, or an app whose script can never be registered is one
    // the installer offers to write anyway
    for (const name of ['', ' ', 'two words', '-lead']) {
      expect(() => installTargets('zsh', name, envFor()), name).toThrow();
    }
  });
});
