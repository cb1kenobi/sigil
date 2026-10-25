import { whichSync } from '@ttylabs/sigil/which';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

/**
 * `sigil package` with no runtime named: does it ask on a terminal, and refuse
 * where there is nobody to ask?
 *
 * The no-terminal half is covered in `package-command.test.ts`, and covered
 * there *by accident of the harness* rather than on purpose: a vitest worker's
 * streams are pipes, so every in-process run takes the branch that cannot
 * prompt. Which is exactly why the prompt itself cannot be tested there -- the
 * one case that cannot fail is the only case that file can reach.
 *
 * So this spawns, with the faked-terminal preload `completion-install-tty.test.ts`
 * established and for its reason: `run()` in `prompt.ts` refuses unless **both**
 * the terminal and stdin claim to be one, so faking a single stream would test
 * the fallback while believing it tested the prompt. The keys are written one
 * per tick, because a terminal delivers a keystroke as its own read.
 *
 * It spawns `src/sigil.ts` rather than `dist/`, which is the one place this
 * parts from that file: the prompt is the subject, nothing here needs the
 * published bin, and running from source means an edit is asserted rather than
 * the last build. `bun` has to be installed, since answering the prompt builds
 * a real binary -- the point is that the answer is *used*, not merely collected.
 */

const here = dirname(fileURLToPath(import.meta.url));
const cli = resolve(here, '../src/sigil.ts');
const fixture = resolve(here, 'fixtures/buildable');

/** Whether Bun is installed, which decides whether the answer can be acted on. */
const hasBun = Boolean(whichSync('bun'));

/**
 * Both ends faked, which is what the prompt requires.
 *
 * `columns` and `rows` come with it: a renderer with no width draws nothing
 * assertable, and `prompt.ts` reads the terminal's width for its own layout.
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

interface Ran {
  code: number | null;
  stderr: string;
  stdout: string;
}

/**
 * Runs `sigil package` against the fixture, optionally on a faked terminal.
 *
 * @param args - What follows `package <fixture> --out <dir>`.
 * @param opts - Whether to fake a terminal, and what to type.
 * @returns What the child did.
 */
function run(
  out: string,
  args: readonly string[],
  opts: { keys?: readonly string[]; tty?: boolean } = {}
): Promise<Ran> {
  const tty = opts.tty ?? true;
  const node = tty ? ['--import', TTY_PRELOAD, cli] : [cli];

  return new Promise((settle, fail) => {
    const child = spawn(process.execPath, [...node, 'package', fixture, '--out', out, ...args], {
      env: { ...process.env, COLUMNS: '80', NO_COLOR: '1' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stderr = '';
    let stdout = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      fail(new Error(`package ${args.join(' ')} did not finish within 180s`));
    }, 180_000);

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

describe('sigil package with no runtime named', () => {
  let out: string;

  beforeEach(() => {
    out = mkdtempSync(join(tmpdir(), 'sigil-pkg-tty-'));
  });

  afterEach(() => {
    rmSync(out, { force: true, recursive: true });
  });

  it('should refuse where there is nobody to ask, naming both runtimes', async () => {
    // the same claim `package-command.test.ts` makes, asserted here against a
    // spawned process whose streams really are pipes rather than against a
    // harness that happens to make them so
    const ran = await run(out, [], { tty: false });

    expect(ran.code).not.toBe(0);
    expect(ran.stderr).toContain('--runtime is required');
    expect(ran.stderr).toContain('--runtime bun');
    expect(ran.stderr).toContain('--runtime node');
    expect(ran.stderr).toContain('sigil.json');
  }, 200_000);

  it.skipIf(!hasBun)(
    'should ask on a terminal, and build what was answered',
    async () => {
      // Enter takes the preselected first choice, which is `bun`. Asserting the
      // *binary* rather than only the question is the point: a prompt whose
      // answer is collected and dropped would satisfy any assertion about what
      // appeared on screen.
      const ran = await run(out, [], { keys: ['\r'] });

      expect(ran.stdout + ran.stderr).toContain('Which runtime');
      // both options offered, since the choice is the whole of the question
      expect(ran.stdout + ran.stderr).toMatch(/bun/);
      expect(ran.stdout + ran.stderr).toMatch(/node/);

      expect(ran.code, ran.stderr).toBe(0);
      expect(existsSync(join(out, 'buildable'))).toBe(true);

      // and the output holds the binary alone -- no bundle, no chunks, which is
      // what `release/` being separate from `dist/` is for
      expect(readdirSync(out)).toEqual(['buildable']);
    },
    200_000
  );

  it('should not ask when the flag already said, on a terminal', async () => {
    // the prompt is for the question nobody answered. Asked anyway, it would
    // hang every scripted run that happens to have a terminal attached --
    // which is most of them, interactively
    const ran = await run(out, ['--runtime', 'node', '--target', 'linux-x64']);

    expect(ran.stdout + ran.stderr).not.toContain('Which runtime');
    // and it got as far as the Node cross-compile refusal, which is proof the
    // runtime was taken from the flag rather than waited for
    expect(ran.stderr).toMatch(/cannot cross-compile|or newer is needed/);
  }, 200_000);
});
