import { spawn } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

/**
 * `app completion` end to end: does it detect, ask, write and say what is left?
 *
 * The unit suite in `packages/sigil/test/completion-install.test.ts` drives the
 * plan and the writing with no prompts at all, which is what makes the
 * idempotency and the paths assertable -- and it is exactly what cannot answer
 * the thing the command promises: that on a terminal it asks and, with nobody
 * to ask, prints the instructions instead. A vitest worker's stdout and stdin
 * are pipes, so every run through `main()` in-process takes the no-terminal
 * branch -- the one case that cannot fail.
 *
 * So this spawns. `runOnTerminal()` from `@ttylabs/sigil/testing` fakes the
 * three fields and deliberately writes **nothing** to the child's stdin, which
 * is right for every claim but this one: a prompt needs keys delivered over
 * time. So the preload is that helper's and the stdin writing is this file's,
 * which is the one thing it says it does not do.
 *
 * It needs a built `dist/`, like everything else in this package -- and the
 * sharper form of that: it spawns the **built binary**, so an edit to `src/`
 * that has not been rebuilt is asserted against the previous one. A missing
 * `dist/` is loud and a stale one is silent, which is the hazard
 * `output-forms.test.ts` already records. `pnpm test` builds first; a bare
 * `pnpm vitest run` on this file alone does not.
 */

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/** Written as codes rather than bytes, because source carries no raw control. */
const CR = String.fromCharCode(0x0d);
const CTRL_C = String.fromCharCode(0x03);

/**
 * A preload making the child's three streams answer `isTTY`.
 *
 * `Object.defineProperty` rather than an assignment, for the reason
 * `output-forms.test.ts` and `runOnTerminal()` both give: a piped
 * `process.stdout` is not a `tty.WriteStream` and what it does with a write to
 * a property it never declared is not a thing to depend on. **stdin** is in the
 * list here where those two have only the output streams, because the prompts
 * refuse to run unless *both* ends claim to be a terminal -- which is the
 * mechanism the no-TTY fallback is, so a preload that faked one of them would
 * be testing the fallback while believing it tested the prompt.
 */
const TTY_PRELOAD = `data:text/javascript,${encodeURIComponent(
  ['stdout', 'stderr', 'stdin']
    .map(
      (s) =>
        `Object.defineProperty(process.${s},"isTTY",{configurable:true,value:true});` +
        `Object.defineProperty(process.${s},"columns",{configurable:true,value:80});` +
        `Object.defineProperty(process.${s},"rows",{configurable:true,value:24});`
    )
    .join('')
)}`;

/**
 * The app, which declares no `completion` of its own: the one under test is the
 * command the framework adds for free.
 *
 * `argv` is passed explicitly and sliced at **one**, which `node -e` forces: with
 * no script path there is no `argv[1]` for the usual `slice(2)` to skip, so the
 * first real argument is eaten and `completion zsh` arrives as
 * `Unexpected argument "zsh"`. Measured, which is how it was found.
 */
const APP = `
import { main } from '@ttylabs/sigil';
await main({
  argv: process.argv.slice(1),
  schema: {
    name: 'probecli',
    commands: {
      build: { desc: 'Build it', options: { '--out <dir>': { desc: 'Where' } }, run() {} },
      deploy: { desc: 'Ship it', run() {} },
    },
  },
});
`;

interface Ran {
  code: number | null;
  stderr: string;
  stdout: string;
}

/** Where a case's home and data directory go. */
let box: string;

beforeEach(() => {
  box = mkdtempSync(join(tmpdir(), 'sigil-completion-tty-'));
  mkdirSync(join(box, 'home'), { recursive: true });
});

afterEach(() => {
  rmSync(box, { force: true, recursive: true });
});

/**
 * Runs `probecli completion ...` in a child.
 *
 * `HOME` **and** `USERPROFILE`, because `os.homedir()` reads the second one on
 * Windows -- and this writes files into a home directory, so a run that reached
 * the real one would be a test damaging the machine it runs on. `XDG_DATA_HOME`
 * is pointed at the box as well, which is belt and braces: it is what the
 * installer reads first, so even a `homedir()` that somehow answered the real
 * home would put the script under the box.
 *
 * `cwd` is `demos/`, because that is a workspace member declaring
 * `@ttylabs/sigil` and the repository root deliberately declares no internal
 * dependency -- so a bare specifier in spawned code resolves there and nowhere
 * above it.
 *
 * @param args - What follows `completion`.
 * @param opts - Whether to fake a terminal, and what to type.
 * @returns What the child did.
 */
function run(
  args: readonly string[],
  opts: { keys?: readonly string[]; program?: string; shell?: string; tty?: boolean } = {}
): Promise<Ran> {
  const tty = opts.tty ?? true;
  // a second program name, for the one test that needs **two** sigil apps
  // installing into one startup file. A replacement in the source rather than a
  // second `APP`, so the two apps differ in their name and in nothing else --
  // which is what makes the directory they share the subject
  const app = opts.program === undefined ? APP : APP.replace("'probecli'", `'${opts.program}'`);
  const node = tty
    ? ['--import', TTY_PRELOAD, '--input-type=module', '-e', app]
    : ['--input-type=module', '-e', app];

  return new Promise((settle, fail) => {
    const child = spawn(process.execPath, [...node, 'completion', ...args], {
      cwd: join(root, 'demos'),
      env: {
        ...process.env,
        COLUMNS: '80',
        HOME: join(box, 'home'),
        NO_COLOR: '1',
        SHELL: opts.shell ?? '/bin/zsh',
        USERPROFILE: join(box, 'home'),
        XDG_DATA_HOME: join(box, 'data'),
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stderr = '';
    let stdout = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      fail(new Error(`completion ${args.join(' ')} did not finish within 20s`));
    }, 20_000);

    child.stderr.on('data', (c: Buffer) => void (stderr += c.toString()));
    child.stdout.on('data', (c: Buffer) => void (stdout += c.toString()));
    child.on('error', (error) => {
      clearTimeout(timer);
      fail(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      settle({ code, stderr, stdout });
    });

    // one key per tick rather than one write, which is the distinction
    // `press()` is built around: a terminal delivers a keystroke as its own
    // read, and two prompts in a row each need their own. The gap is generous
    // because what is being waited for is a renderer's first frame
    const keys = opts.keys ?? [];
    let at = 0;
    const next = (): void => {
      if (at < keys.length) {
        child.stdin.write(keys[at++]);
        setTimeout(next, 250);
      } else {
        child.stdin.end();
      }
    };
    setTimeout(next, 500);
  });
}

/** The script the install should have written, for zsh. */
function zshScript(): string {
  return join(box, 'data', 'completions', '_probecli');
}

describe('app completion on a terminal', () => {
  it('should detect the shell, write the script and add the block, on one yes', async () => {
    const rc = join(box, 'home', '.zshrc');

    // no startup file at all, which is the fresh-machine case: the block
    // creates one, because zsh reads a `.zshrc` the moment it is there
    expect(existsSync(rc)).toBe(false);

    const ran = await run([], { keys: [CR, CR] });

    // the plan named **both** paths before it asked, which is what makes one
    // question an honest answer about two files
    expect(ran.stderr).toContain(join(box, 'data', 'completions', '_probecli'));
    expect(ran.stderr).toContain(rc);
    // it asked which shell, with the detected one offered
    expect(ran.stderr).toMatch(/zsh/);
    // one confirm and no second one, which is the decision SIG-155 took: the
    // two files have two owners and it is still one install
    expect(ran.stderr.match(/\(Y\/n\)/gu)?.length).toBe(1);
    // and it wrote the script
    expect(readFileSync(zshScript(), 'utf8')).toContain(
      'zsh completion for `probecli`, generated by sigil.'
    );
    // and the block, markers and runtime guard and all -- which is the half
    // SIG-151 printed and left to the reader
    const held = readFileSync(rc, 'utf8');
    expect(held).toContain('# zsh completion for `probecli`, added by sigil.');
    expect(held).toContain('(( $+functions[compdef] ))');
    expect(held).toContain(`source '${zshScript()}'`);
    expect(held).toContain('# end of zsh completion for `probecli`.');
    // zero, because it did something -- which is the whole of what SIG-139
    // could not say
    expect(ran.code).toBe(0);
  }, 30_000);

  it('should say nothing to do on a second run that has nothing to do', async () => {
    const first = await run([], { keys: [CR, CR] });
    expect(first.code).toBe(0);

    const before = readFileSync(zshScript(), 'utf8');
    // nothing put in by hand: the first run added the block itself, so the
    // second one really has nothing left to do. Which is the state SIG-151
    // could only reach by asking the reader to follow a printed line
    expect(readFileSync(join(box, 'home', '.zshrc'), 'utf8')).toContain('added by sigil');

    const again = await run([], { keys: [CR] });

    // and the discriminator: it did not ask. A second run that reported
    // "nothing to do" having also *asked* would be a plan that cannot tell a
    // current install from a fresh one -- so what is asserted is that the one
    // key fed was never consumed by a confirm, and the file is untouched
    expect(again.stderr).toContain('up to date');
    expect(again.stderr).not.toMatch(/Install zsh completion/);
    expect(readFileSync(zshScript(), 'utf8')).toBe(before);
    expect(again.code).toBe(0);
  }, 40_000);

  it('should let the arrow key override what $SHELL said', async () => {
    // `$SHELL` says zsh and the down arrow moves to bash, which is the whole
    // reason this is a `select()` rather than a `confirm()`
    const ran = await run([], { keys: [`${String.fromCharCode(0x1b)}[B`, CR, CR] });

    expect(existsSync(join(box, 'data', 'completions', 'probecli.bash'))).toBe(true);
    expect(existsSync(zshScript())).toBe(false);
    expect(ran.code).toBe(0);
  }, 30_000);

  it('should write nothing when the answer is no', async () => {
    const ran = await run([], { keys: [CR, 'n'] });

    expect(existsSync(zshScript())).toBe(false);
    expect(ran.code).toBe(1);
  }, 30_000);

  it('should refuse a file it did not write, and leave it', async () => {
    mkdirSync(join(box, 'data', 'completions'), { recursive: true });
    writeFileSync(zshScript(), '# mine, hands off\n');

    // Enter on the shell, then Enter on the question -- which for a foreign
    // file defaults to **no**, so Enter alone leaves it
    const ran = await run([], { keys: [CR, CR] });

    expect(ran.stderr).toContain('not written by sigil');
    expect(readFileSync(zshScript(), 'utf8')).toBe('# mine, hands off\n');
    expect(ran.code).toBe(1);
  }, 30_000);

  it('should take both halves back out again, down to the byte', async () => {
    const rc = join(box, 'home', '.zshrc');

    // a file of the user's own first, so that what is asserted afterwards is
    // that the block went and nothing else did -- which is the whole claim an
    // installer that edits a dotfile has to be able to make
    writeFileSync(rc, '# mine\nexport EDITOR=vim\n');
    const before = readFileSync(rc, 'utf8');

    expect((await run([], { keys: [CR, CR] })).code).toBe(0);
    expect(existsSync(zshScript())).toBe(true);
    expect(readFileSync(rc, 'utf8')).not.toBe(before);

    // the shell named, so there is no shell prompt and one Enter answers the
    // question
    const ran = await run(['zsh', '--uninstall'], { keys: [CR] });

    expect(existsSync(zshScript())).toBe(false);
    expect(ran.stderr).toContain('Removed the block from');
    // byte for byte what the user had before any of this, the blank line the
    // append added included. This is the asymmetry SIG-151 could not close and
    // the reason it declined to append at all: a marked block has an extent,
    // so there is something to remove rather than a line indistinguishable
    // from one the user wrote
    expect(readFileSync(rc, 'utf8')).toBe(before);
    expect(ran.code).toBe(0);
  }, 40_000);
});

describe('what the round-1 review found', () => {
  it('should say Cancelled on Ctrl-C rather than reciting the whole recipe', async () => {
    const ran = await run([], { keys: [CTRL_C] });

    // `PromptError` carries `aborted` precisely to tell an interrupt from "no
    // terminal", and read as one an interrupt printed the longest output this
    // command has -- the entire set-up recipe, in answer to somebody asking it
    // to stop
    expect(ran.stderr).toContain('Cancelled');
    expect(ran.stderr).not.toContain('completion zsh >');
    expect(existsSync(zshScript())).toBe(false);
    expect(ran.code).toBe(1);
  }, 30_000);

  it('should say Cancelled on Ctrl-C at the second question too', async () => {
    // the shell answered, so the abort is the confirm's -- a different prompt
    // through the same catch
    const ran = await run([], { keys: [CR, CTRL_C] });

    expect(ran.stderr).toContain('Cancelled');
    expect(ran.stderr).not.toContain('completion zsh >');
    expect(existsSync(zshScript())).toBe(false);
    expect(ran.code).toBe(1);
  }, 30_000);

  it('should print the rm rather than the install recipe for a no-TTY uninstall', async () => {
    expect((await run([], { keys: [CR, CR] })).code).toBe(0);

    const ran = await run(['zsh', '--uninstall'], { tty: false });

    // measured before the fix: it printed the plan and then the whole *install*
    // recipe, which is the opposite of what was asked for
    expect(ran.stderr).toContain('rm ');
    expect(ran.stderr).toContain(zshScript());
    expect(ran.stderr).not.toContain('completion zsh >');
    expect(ran.stderr).not.toMatch(/fpath=\(~/);
    // and it removed nothing, because there was nobody to ask
    expect(existsSync(zshScript())).toBe(true);
    expect(ran.code).toBe(1);
  }, 40_000);
});

describe('app completion with nobody to ask', () => {
  it('should print the instructions and exit non-zero, as it did before an installer existed', async () => {
    const ran = await run([], { tty: false });

    expect(ran.stderr).toContain('detected zsh');
    expect(ran.stderr).toContain('completion zsh');
    expect(ran.stdout).toBe('');
    expect(ran.code).toBe(1);
    // and nothing was written, which is the half that matters: a non-interactive
    // run must not install
    expect(existsSync(join(box, 'data', 'completions'))).toBe(false);
  }, 30_000);

  it('should name the shells where $SHELL says nothing it knows', async () => {
    const ran = await run([], { shell: '/bin/fish', tty: false });

    expect(ran.stderr).toContain('completion bash');
    expect(ran.stderr).toContain('completion zsh');
    expect(ran.code).toBe(1);
  }, 30_000);

  it('should still print a script when a shell is named, which is the scriptable form', async () => {
    const ran = await run(['zsh'], { tty: false });

    expect(ran.stdout).toContain('#compdef probecli');
    expect(ran.stderr).toBe('');
    expect(ran.code).toBe(0);
  }, 30_000);
});

describe('what the sabotage pass found', () => {
  it('should ask, and write only the block, where only the block is outstanding', async () => {
    expect((await run([], { keys: [CR, CR] })).code).toBe(0);
    const before = statSync(zshScript());
    const rc = join(box, 'home', '.zshrc');

    // the state SIG-155 moved, reached by taking the block back out by hand: the
    // script is current and the startup file has no block, which under SIG-151
    // was `changes` and not `writes` because the line was only printed. There is
    // a file to edit now, so it asks -- and the key fed is that yes
    writeFileSync(rc, '# mine\n');
    const again = await run([], { keys: [CR, CR] });

    expect(again.stderr).toMatch(/Install zsh completion/);
    // the script is not rewritten, which the inode says and the bytes cannot:
    // it is identical either way, so a rewrite is invisible to a comparison
    expect(statSync(zshScript()).ino).toBe(before.ino);
    // and what it reports is the block alone, which is what two `Done` flags
    // are for -- "Wrote" here would name a file nothing touched
    expect(again.stderr).toContain('up to date');
    expect(again.stderr).toContain('Added a block to');
    expect(again.stderr).not.toContain('Wrote ');
    expect(again.stderr).not.toContain('Nothing to do');
    // over the file the user owns, with their own line still the first of it
    const held = readFileSync(rc, 'utf8');
    expect(held.split('\n')[0]).toBe('# mine');
    expect(held).toContain('added by sigil');
    expect(held).toContain('# end of zsh completion for `probecli`.');
    expect(again.code).toBe(0);
  }, 40_000);

  it('should say whose a foreign file is on the way out rather than crashing, with the line still there', async () => {
    mkdirSync(join(box, 'data', 'completions'), { recursive: true });
    writeFileSync(zshScript(), '# mine, hands off\n');
    // the line present too, which is what makes `changes` true where `writes`
    // is false -- and is the composition round 2 found: a gate keyed on
    // `changes` let a foreign uninstall through to the writer, whose own
    // refusal then came out of the generic error handler rather than as the
    // sentence the plan had already printed. No question is asked here either
    // way, which is the fix: the fed key is consumed by nothing, and an earlier
    // version of this comment said "the answer was yes" -- which is what the
    // *install* direction does and is not this flow. Found by review round 3,
    // in the file whose comments are the record of why each fixture exists.
    //
    // This is also the only input the `writes` gate decides, measured rather
    // than assumed: `applyInstall()` answers `false` for a `current` plan
    // itself, so for the install direction the gate is redundant and the
    // mutation that reads `changes` there is equivalent. Found by the sabotage
    // pass
    writeFileSync(
      join(box, 'home', '.zshrc'),
      `fpath=('${join(box, 'data', 'completions')}' $fpath)\n`
    );

    const ran = await run(['zsh', '--uninstall'], { keys: [CR] });

    expect(ran.stderr).toContain('not written by sigil');
    expect(ran.stderr).not.toMatch(/Refusing to remove/);
    expect(readFileSync(zshScript(), 'utf8')).toBe('# mine, hands off\n');
    expect(ran.code).toBe(0);
  }, 30_000);

  it('should take its own block out beside a script it did not write, without crashing', async () => {
    // the round-2 crash shape reintroduced by SIG-155, and reported on PR #191.
    // `writes` counts the block now, so a **foreign script with our block in
    // the startup file** is `writes: true` -- and the apply built an object
    // literal whose `file` property called `applyUninstall()` first, which
    // throws for a foreign plan. So the refusal reached the generic error
    // handler as a crash and `removeRc()` never ran: the block stayed.
    //
    // The unit test for the pair calls `removeRc()` first, the opposite of the
    // production order, so it could not see this. A real run is what does
    const rc = join(box, 'home', '.zshrc');

    // install properly first, so the block in the startup file is genuinely
    // ours rather than a fixture pretending to be
    expect((await run([], { keys: [CR, CR] })).code).toBe(0);
    expect(readFileSync(rc, 'utf8')).toContain('added by sigil');

    // and then somebody overwrites the script
    writeFileSync(zshScript(), '# mine, hands off\n');

    const ran = await run(['zsh', '--uninstall'], { keys: [CR] });

    // the plan says whose the script is and that the block will go
    expect(ran.stderr).toContain('not written by sigil');
    expect(ran.stderr).toContain('Removed the block from');
    // and no stack and no raw refusal reached the reader
    expect(ran.stderr).not.toMatch(/Refusing to remove/);
    expect(ran.stderr).not.toMatch(/\bat .*:\d+:\d+/u);
    // the script is theirs and stays; the block was ours and went
    expect(readFileSync(zshScript(), 'utf8')).toBe('# mine, hands off\n');
    expect(readFileSync(rc, 'utf8')).not.toContain('added by sigil');
    expect(ran.code).toBe(0);
  }, 40_000);

  it('should ask to remove rather than to replace, on an uninstall it can act on', async () => {
    // the third defect in the same spot: `question()`'s `foreign` branch is
    // about an **install** -- "Replace it?", defaulting to no -- and an
    // uninstall could not reach it while `writes` was false for a foreign file.
    // With the block counting, it did: a reader uninstalling was asked
    // "Replace it?" about a removal, defaulting to no, so the block stayed
    // unless they typed y
    expect((await run([], { keys: [CR, CR] })).code).toBe(0);
    writeFileSync(zshScript(), '# mine, hands off\n');

    const ran = await run(['zsh', '--uninstall'], { keys: [CR] });

    expect(ran.stderr).toMatch(/Remove zsh completion for probecli\?/);
    expect(ran.stderr).not.toContain('Replace it?');
    expect(ran.code).toBe(0);
  }, 40_000);

  it('should give a second app its own block in one startup file', async () => {
    // the directory-needle defect from the other end, driven: app one's block
    // names `<dir>/_one`, which contains `<dir>`, so app two read the startup
    // file as already handling it and never got a block. Both scripts on disk
    // and only one of them loadable, with nothing said
    const rc = join(box, 'home', '.zshrc');

    expect((await run([], { keys: [CR, CR] })).code).toBe(0);
    const first = readFileSync(rc, 'utf8');
    expect(first).toContain('# zsh completion for `probecli`, added by sigil.');

    const again = await run([], { keys: [CR, CR], program: 'othercli' });
    expect(again.code).toBe(0);

    const held = readFileSync(rc, 'utf8');
    expect(held).toContain('# zsh completion for `probecli`, added by sigil.');
    expect(held).toContain('# zsh completion for `othercli`, added by sigil.');
    expect(again.stderr).not.toContain('already names it');
  }, 60_000);

  it('should replace a foreign file when the answer is yes', async () => {
    mkdirSync(join(box, 'data', 'completions'), { recursive: true });
    writeFileSync(zshScript(), '# mine, hands off\n');

    // the question defaults to no for a foreign file, so a yes has to be typed
    // -- and the answer is what the writer is handed, which refuses a foreign
    // plan without it. An install that asked, was told yes and then threw is
    // what this is for
    const ran = await run([], { keys: [CR, 'y'] });

    expect(ran.stderr).toContain('not written by sigil');
    expect(readFileSync(zshScript(), 'utf8')).toContain(
      'zsh completion for `probecli`, generated by sigil.'
    );
    expect(ran.stderr).not.toMatch(/Refusing to replace/);
    expect(ran.code).toBe(0);
  }, 30_000);

  it('should name the one shell it detected for a bare no-TTY uninstall', async () => {
    // `--uninstall` with no shell on argv and nobody to ask, which is the
    // branch `byHand()` grew for the direction and which no test reached:
    // every other no-TTY uninstall names a shell, so `target` was always set
    // and the install recipe was never the thing printed. Found by review
    // round 3
    const ran = await run(['--uninstall'], { shell: '/bin/zsh', tty: false });

    expect(ran.stderr).toContain('probecli completion zsh --uninstall');
    expect(ran.stderr).not.toContain('fpath=(');
    expect(ran.code).toBe(1);
  }, 30_000);

  it('should list the shells for a bare no-TTY uninstall where $SHELL says nothing it knows', async () => {
    const ran = await run(['--uninstall'], { shell: '/usr/bin/fish', tty: false });

    for (const name of ['bash', 'zsh']) {
      expect(ran.stderr).toContain(`probecli completion ${name} --uninstall`);
    }
    expect(ran.code).toBe(1);
  }, 30_000);

  it('should put every word of the interaction on stderr, so a redirect still gets a script', async () => {
    const ran = await run([], { keys: [CR, CR] });

    // the whole of it -- the plan, the question the renderer drew, and the
    // result. A prompt drawn on stdout is what `mycli completion > file` would
    // put in the file, which is the one thing the scriptable form promises not
    // to do: `createTerminal()` defaults to stdout, so this is the argument for
    // handing it stderr
    expect(ran.stdout).toBe('');
    expect(ran.stderr).toContain('Added a block to');
    expect(ran.code).toBe(0);
  }, 30_000);
});

describe('what the second PR review round found', () => {
  /** Where the `user` route's bash script goes. */
  function userScript(): string {
    return join(box, 'data', 'completions', 'probecli.bash');
  }

  /** Where `bash-completion`'s route would put one. */
  function bcScript(): string {
    return join(box, 'data', 'bash-completion', 'completions', 'probecli');
  }

  it('should update the install that is there once bash-completion appears', async () => {
    // the sequence as reported, end to end, because what was wrong is what the
    // command *printed*: a unit test of the plan can say which target it picked
    // and cannot say that the result named neither the old file nor the line.
    //
    // step one, on a machine with no bash-completion directory: the only route
    // that resolves is `user`, so the script and the block in `.bashrc` are
    // both this command's to write
    const first = await run([], { keys: [CR, CR], shell: '/bin/bash' });

    expect(first.code).toBe(0);
    expect(existsSync(userScript())).toBe(true);
    expect(first.stderr).toContain('Added a block to');
    expect(readFileSync(join(box, 'home', '.bashrc'), 'utf8')).toContain('added by sigil');

    // and then bash-completion arrives, which makes its route resolve and puts
    // it at the head of the table
    mkdirSync(join(box, 'data', 'bash-completion', 'completions'), { recursive: true });

    const again = await run([], { keys: [CR], shell: '/bin/bash' });

    // reading an index wrote a *second* copy here, printed nothing but
    // "Then restart your shell." and left a `.bashrc` sourcing the first
    expect(existsSync(bcScript())).toBe(false);
    expect(again.stderr).toContain(userScript());
    expect(again.stderr).toContain('up to date');
    // `already has the block` rather than `already names it`, which is the
    // distinction `RcState` gained: the block is ours, found by both markers,
    // where SIG-151 could only say the path was named by somebody
    expect(again.stderr).toContain('already has the block');
    // and it did not ask, because there is nothing to write in either file
    expect(again.stderr).not.toMatch(/Install bash completion/);
    expect(again.code).toBe(0);
  }, 60_000);

  it('should take the install that is there back out once bash-completion appears', async () => {
    const first = await run([], { keys: [CR, CR], shell: '/bin/bash' });
    expect(first.code).toBe(0);
    mkdirSync(join(box, 'data', 'bash-completion', 'completions'), { recursive: true });

    const out = await run(['--uninstall'], { keys: [CR, CR], shell: '/bin/bash' });

    // the other direction, which the index got wrong the same way: it planned
    // a removal of a file that was never written, reported success, and left
    // the real one with its `source` line in place
    expect(existsSync(userScript())).toBe(false);
    expect(out.stderr).toContain(userScript());
    // and the line is named, which the route it used to pick has none of
    expect(out.stderr).toContain(join(box, 'home', '.bashrc'));
    expect(out.code).toBe(0);
  }, 60_000);

  it('should still take bash-completion-s directory for a first install', async () => {
    // tier three unchanged, which is every install that is the first: nothing
    // of ours is there, so the table's order stands. The **control** of the
    // three, and it says so: it passes against the index this replaced as well,
    // which is what makes the two above the ones that pin the fix
    mkdirSync(join(box, 'data', 'bash-completion', 'completions'), { recursive: true });

    const ran = await run([], { keys: [CR, CR], shell: '/bin/bash' });

    expect(existsSync(bcScript())).toBe(true);
    expect(existsSync(userScript())).toBe(false);
    // and nothing to add, which is the whole reason that route is preferred
    expect(ran.stderr).not.toContain('source ');
    expect(ran.code).toBe(0);
  }, 60_000);
});
