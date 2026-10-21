/**
 * What `--quiet` comes to for the real binary, over real pipes.
 *
 * `report-quiet.test.ts` asserts what the two writers do; this asserts what a
 * user gets, which is the only place the flag, the parse, `main()`'s recording
 * and the one fold are all in play at once. It spawns `dist/`, so it needs a
 * build -- which is the rule every test in this package follows.
 *
 * The non-regression for the piped form when quiet is **off** is
 * `output-forms.test.ts`, unchanged: every claim it makes about the two forms
 * holds, which is what says this added a flag rather than moved a byte.
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const pkg = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const bin = join(pkg, 'dist', 'sigil.mjs');

/** The environment `supportsColor()` reads, cleared so a run is reproducible. */
const COLOUR_ENV = [
  'CI',
  'COLORTERM',
  'FORCE_COLOR',
  'GITHUB_ACTIONS',
  'NO_COLOR',
  'SIGIL_COLOR_SCHEME',
  'SIGIL_REDUCED_MOTION',
  'TERM',
  'TERM_PROGRAM',
];

interface Ran {
  code: number | null;
  err: string;
  out: string;
}

interface Answered extends Ran {
  /** What was on screen when the answer was written. */
  asked: string;
  /** How many times the answer was written. */
  writes: number;
}

/**
 * Runs the built binary with both streams piped.
 *
 * @param argv - The arguments.
 * @returns What it wrote and how it exited.
 */
function sigil(argv: readonly string[]): Promise<Ran> {
  const env: Record<string, string | undefined> = { ...process.env };
  for (const name of COLOUR_ENV) {
    for (const key of Object.keys(env)) {
      if (key.toLowerCase() === name.toLowerCase()) {
        delete env[key];
      }
    }
  }
  env.COLUMNS = '100';

  return new Promise<Ran>((settle, fail) => {
    const child = spawn(process.execPath, [bin, ...argv], {
      cwd: pkg,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let err = '';
    let out = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      fail(new Error(`timed out: sigil ${argv.join(' ')}`));
    }, 120_000);
    timer.unref?.();

    child.stderr.setEncoding('utf8');
    child.stdout.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      err += chunk;
    });
    child.stdout.on('data', (chunk: string) => {
      out += chunk;
    });
    child.on('error', fail);
    child.on('close', (code) => {
      clearTimeout(timer);
      settle({ code, err, out });
    });
  });
}

/**
 * The same binary with both streams claiming to be terminals, and a key written
 * to its stdin once it has had time to ask.
 *
 * `runOnTerminal()` is the shipped way to fake a terminal and deliberately
 * writes nothing to the child's stdin -- "a prompt is not what to spawn" -- so a
 * test of a path behind a confirm has to do both halves itself. `isTTY` is what
 * makes the router agree to exist and `setRawMode` is absent on a pipe, which
 * the router calls optionally, so the keys arrive as themselves.
 *
 * `ready` is the question's own text rather than a shape, and it is latched.
 * Found by review: a `?` is in `ESC [ ? 25 l`, which `mountLive()` writes inside
 * the **first paint** -- before `createInput()` has attached its stdin listener
 * -- so a condition that looked for one wrote the key at a moment nothing was
 * reading, and then again on every later chunk. It worked, because a pipe holds
 * what nobody has read yet; what it did not do is mean what it said. A stdin
 * already flowing would have dropped that key and the test would have waited out
 * the kill.
 *
 * @param argv - The arguments.
 * @param answer - What to type once the question is up.
 * @param cwd - Where to run it.
 * It reports **when** and **how often** it answered, because nothing outside the
 * child can see either: a pipe holds what nobody has read yet, so an early key
 * and a repeated one both work and neither can be told from a correct one by
 * reading the output. So the helper's own claim is the thing asserted.
 *
 * @param argv - The arguments.
 * @param answer - What to type once the question is up.
 * @param cwd - Where to run it.
 * @param ready - The question's own text, which is what says it is up.
 * @returns What it wrote, how it exited, and when it answered.
 */
function prompted(
  argv: readonly string[],
  answer: string,
  cwd: string,
  ready: string
): Promise<Answered> {
  const env: Record<string, string | undefined> = { ...process.env };
  for (const name of COLOUR_ENV) {
    for (const key of Object.keys(env)) {
      if (key.toLowerCase() === name.toLowerCase()) {
        delete env[key];
      }
    }
  }
  env.COLUMNS = '100';
  env.TERM = 'xterm-256color';

  const fake = [
    "for (const n of ['stdin', 'stdout']) {",
    "  Object.defineProperty(process[n], 'isTTY', { configurable: true, value: true });",
    '}',
    "Object.defineProperty(process.stdout, 'columns', { configurable: true, value: 100 });",
  ].join('\n');

  return new Promise<Answered>((settle, fail) => {
    const child = spawn(
      process.execPath,
      ['--import', `data:text/javascript,${encodeURIComponent(fake)}`, bin, ...argv],
      { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] }
    );
    let asked = '';
    let err = '';
    let out = '';
    let writes = 0;
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      fail(new Error(`timed out: sigil ${argv.join(' ')}`));
    }, 120_000);
    timer.unref?.();

    child.stderr.setEncoding('utf8');
    child.stdout.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      err += chunk;
    });
    child.stdout.on('data', (chunk: string) => {
      out += chunk;
      // the question itself is on screen, so a key is one it is waiting for --
      // and once, because the confirm reads one and settles
      if (writes === 0 && out.includes(ready) && child.stdin.writable) {
        asked = out;
        writes += 1;
        child.stdin.write(answer);
      }
    });
    child.on('error', fail);
    child.on('close', (code) => {
      clearTimeout(timer);
      settle({ asked, code, err, out, writes });
    });
  });
}

/**
 * An app `sigil add` can read a registry out of, which is a manifest and a link.
 *
 * @returns Its directory.
 */
function appFor(): string {
  const at = mkdtempSync(join(tmpdir(), 'sig141-add-'));
  mkdirSync(join(at, 'src'));
  mkdirSync(join(at, 'node_modules', '@ttylabs'), { recursive: true });
  writeFileSync(
    join(at, 'package.json'),
    `${JSON.stringify(
      { dependencies: { '@ttylabs/sigil': '0.0.1' }, name: 'declined', type: 'module' },
      undefined,
      2
    )}\n`
  );
  writeFileSync(join(at, 'src', 'index.ts'), "export default { name: 'declined' };\n");
  symlinkSync(join(pkg, '..', 'sigil'), join(at, 'node_modules', '@ttylabs', 'sigil'), 'dir');
  return at;
}

/** `file:line:column: severity: message`, which is what something greps. */
const DIAGNOSTIC = /^\S.*?:\d+:\d+: (?:error|warning): /;

const lines = (text: string): string[] => text.split('\n').filter((line) => line !== '');

// a build is what these read, and a missing one is the loud failure
if (!existsSync(bin)) {
  throw new Error(`${bin} is missing -- run \`pnpm build\` first`);
}

describe('a quiet check', () => {
  /**
   * The strongest form of the claim, and the one a script asked for: an app with
   * nothing to say says nothing at all.
   */
  it('should write nothing at all for an app with no diagnostics', async () => {
    const ran = await sigil(['check', '--quiet', 'test/fixtures/buildable']);
    expect(ran.err).toBe('');
    expect(ran.out).toBe('');
    expect(ran.code).toBe(0);
  });

  /**
   * The line the axis is drawn along, derived rather than written down: every
   * line the quiet run dropped is a line that is **not** a diagnostic, and every
   * diagnostic the loud run wrote is in the quiet one too, byte for byte.
   */
  it('should drop exactly the lines that are not the answer', async () => {
    // an app that **passes** with a diagnostic, which is the one input that has
    // all three kinds of line in it at once: a check that fails throws before
    // the summary is written, so the broken fixture drops nothing and would
    // have made this pass for the wrong reason
    const [loud, quiet] = await Promise.all([
      sigil(['check', 'test/fixtures/app']),
      sigil(['check', '--quiet', 'test/fixtures/app']),
    ]);
    expect(loud.code).toBe(0);

    const was = lines(loud.err);
    const now = lines(quiet.err);
    expect(was.length).toBeGreaterThan(now.length);

    // nothing new, and nothing reworded
    for (const line of now) {
      expect(was).toContain(line);
    }

    const dropped = was.filter((line) => !now.includes(line));
    expect(dropped.length).toBeGreaterThan(0);
    for (const line of dropped) {
      expect(line).not.toMatch(DIAGNOSTIC);
    }

    // and every diagnostic survived, which is the other half: a quiet run that
    // dropped one would satisfy the subset claim above and be useless
    const answers = was.filter((line) => DIAGNOSTIC.test(line));
    expect(answers.length).toBeGreaterThan(0);
    for (const line of answers) {
      expect(now).toContain(line);
    }
  });

  it('should still say the check failed, because an error is the answer', async () => {
    const ran = await sigil(['check', '--quiet', 'test/fixtures/typecheck/broken']);
    expect(ran.err).toContain('Error:');
    expect(ran.code).toBe(1);
    expect(ran.err).toMatch(DIAGNOSTIC);
  });

  it('should leave the exit code and stdout exactly where they were', async () => {
    const [loud, quiet] = await Promise.all([
      sigil(['check', 'test/fixtures/app', '--tree']),
      sigil(['check', '--quiet', 'test/fixtures/app', '--tree']),
    ]);
    expect(quiet.code).toBe(loud.code);
    // `--tree` is data somebody asked for, on stdout, and quiet is about
    // progress -- so it is not touched
    expect(quiet.out).toBe(loud.out);
    expect(quiet.out).not.toBe('');
  });

  /**
   * A fixture with something to say, because two empty streams are equal for
   * every reason there is: if `-q` stopped being registered and was swallowed as
   * an undeclared option, a clean app would still print nothing either way.
   */
  it('should take the short spelling too', async () => {
    const [loud, long, short] = await Promise.all([
      sigil(['check', 'test/fixtures/app']),
      sigil(['check', '--quiet', 'test/fixtures/app']),
      sigil(['check', '-q', 'test/fixtures/app']),
    ]);
    expect(short.err).toBe(long.err);
    expect(short.out).toBe(long.out);
    // and both really did suppress something, which is what makes the equality
    // above a claim about `-q` rather than about an app with nothing to say
    expect(lines(loud.err).length).toBeGreaterThan(lines(short.err).length);
  });
});

describe('a quiet build', () => {
  /**
   * The README's own example is `mycli build --quiet > out.json`, so the
   * toolchain's own `build` is the one place that promise is checkable. Found by
   * review: the two tables of what was produced went to **stdout**
   * unconditionally, so a quiet build lost its one-line summary and kept the
   * same thing at greater length.
   */
  it('should print neither the chunk table nor the inlined one', async () => {
    const out = join(mkdtempSync(join(tmpdir(), 'sig141-')), 'dist');
    const quiet = join(mkdtempSync(join(tmpdir(), 'sig141-')), 'dist');
    const [loud, hushed] = await Promise.all([
      sigil(['build', 'test/fixtures/buildable', '--out', out]),
      sigil(['build', '--quiet', 'test/fixtures/buildable', '--out', quiet]),
    ]);

    expect(loud.code).toBe(0);
    expect(hushed.code).toBe(0);
    // the loud run really did print one, or the absence below says nothing
    expect(loud.out).toContain('kB');
    expect(hushed.out).toBe('');
    expect(hushed.err).toBe('');
  });
});

describe('a declined add', () => {
  /**
   * The other outcome of one dialogue, which is the one no in-process test can
   * reach: the declined note sits behind a confirm, so it needs a terminal on
   * both streams and a key. Found by a sabotage pass -- routing it through
   * `writeNote()` was a fix for a survivor and was itself unpinned, because
   * every other `add` test passes `--yes` and never asks the question.
   */
  it('should drop the note it writes when the answer is no', async () => {
    const ask = 'Write these files?';
    const [loud, quiet] = await Promise.all([
      prompted(['add', 'spinner'], 'n', appFor(), ask),
      prompted(['add', 'spinner', '--quiet'], 'n', appFor(), ask),
    ]);

    expect(loud.code).toBe(0);
    expect(quiet.code).toBe(0);
    // the loud run really wrote it, or the absence below says nothing
    expect(loud.out).toContain('Nothing written.');
    expect(quiet.out).not.toContain('Nothing written.');

    // and the question itself survived, which is what makes quiet about
    // progress rather than about a dialogue nobody could answer
    expect(quiet.out).toContain(ask);
    // as does the plan, which is the answer to what `add` was asked
    expect(quiet.out).toContain('src/components/spinner.ts');
  });

  /**
   * The helper's own claim, asserted rather than commented. Found by a sabotage
   * pass: taking the latch off and looking for any `?` both left every other
   * assertion green, because a pipe holds what nobody has read yet -- so an early
   * key and a repeated one are invisible from outside the child, and the test
   * above passed for a reason other than its name.
   *
   * `ESC [ ? 25 l` is the input that makes it matter: `mountLive()` writes it
   * inside the **first paint**, before `createInput()` has attached its stdin
   * listener, so a condition looking for a `?` fires at a moment nothing is
   * reading.
   */
  it('should answer once, and only once the question is on screen', async () => {
    const ask = 'Write these files?';
    const ran = await prompted(['add', 'spinner'], 'n', appFor(), ask);
    expect(ran.code).toBe(0);
    expect(ran.writes).toBe(1);
    expect(ran.asked).toContain(ask);
    // the cursor sequence really is there and really does hold a `?`, which is
    // what a laxer condition would have fired on
    expect(ran.out).toContain('\u001b[?25l');
  });
});

describe('the flag itself', () => {
  it('should be on the help screen, in both spellings', async () => {
    const ran = await sigil(['--help']);
    expect(ran.out).toContain('-q, --quiet');
    expect(ran.out).toContain('Suppress progress, not results');
  });

  /**
   * It is on the root, so options resolve across the whole chain and it reaches
   * a subcommand whichever side of the command name it was typed.
   */
  it('should work before the command as well as after it', async () => {
    const [before, after] = await Promise.all([
      sigil(['--quiet', 'check', 'test/fixtures/buildable']),
      sigil(['check', 'test/fixtures/buildable', '--quiet']),
    ]);
    expect(before.err).toBe('');
    expect(after.err).toBe('');
  });
});
