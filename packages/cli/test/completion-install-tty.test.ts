import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
  opts: { keys?: readonly string[]; shell?: string; tty?: boolean } = {}
): Promise<Ran> {
  const tty = opts.tty ?? true;
  const node = tty
    ? ['--import', TTY_PRELOAD, '--input-type=module', '-e', APP]
    : ['--input-type=module', '-e', APP];

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
  it('should detect the shell, write the script and print the line to add', async () => {
    const ran = await run([], { keys: [CR, CR] });

    // the plan named the path before it asked
    expect(ran.stderr).toContain(join(box, 'data', 'completions', '_probecli'));
    // it asked which shell, with the detected one offered
    expect(ran.stderr).toMatch(/zsh/);
    // and it wrote
    expect(existsSync(zshScript())).toBe(true);
    expect(readFileSync(zshScript(), 'utf8')).toContain(
      'zsh completion for `probecli`, generated by sigil.'
    );
    // and it printed the line rather than adding it
    expect(ran.stderr).toContain('fpath=(');
    expect(existsSync(join(box, 'home', '.zshrc'))).toBe(false);
    // zero, because it did something -- which is the whole of what SIG-139
    // could not say
    expect(ran.code).toBe(0);
  }, 30_000);

  it('should say nothing to do on a second run that has nothing to do', async () => {
    const first = await run([], { keys: [CR, CR] });
    expect(first.code).toBe(0);

    const before = readFileSync(zshScript(), 'utf8');
    // the line put in by hand, because the installer never writes one -- so
    // this is the state a user is in after following what it printed
    writeFileSync(
      join(box, 'home', '.zshrc'),
      `fpath=('${join(box, 'data', 'completions')}' $fpath)\n`
    );

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

  it('should take it back out again', async () => {
    expect((await run([], { keys: [CR, CR] })).code).toBe(0);
    expect(existsSync(zshScript())).toBe(true);

    // the shell named, so there is no shell prompt and one Enter answers the
    // question
    const ran = await run(['zsh', '--uninstall'], { keys: [CR] });

    expect(existsSync(zshScript())).toBe(false);
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
