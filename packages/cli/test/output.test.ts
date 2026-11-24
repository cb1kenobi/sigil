import { STACK } from './spawned.ts';
import { spawn } from 'node:child_process';
import {
  closeSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * A document written to a file is all there or the command fails (SIG-539).
 *
 * `sigil reference app > docs/cli.md` wrote its whole document in one
 * `process.stdout.write()`. For a file Node does that with one `fs.writeSync()`
 * and throws the byte count away, so when the kernel took only part of it -- a
 * full disk, or `ulimit -f` -- there was no `error` event, nothing to report, and
 * the command exited 0 over a cut-off file. `sigil add` writes in pieces, so its
 * second write failed and SIG-537's guard rethrew it; a command that writes once
 * has no second write to fail.
 *
 * The spawned half is the honest reproduction and POSIX only, since Windows has
 * no `ulimit`. The short-write handling itself -- `writeFully()`, `writeTo()`,
 * `writeOut()` -- is `@ttylabs/sigil/output`'s since SIG-542 and is tested in
 * `packages/sigil/test/output.test.ts`, on every platform.
 *
 * SIG-542 moved it there because `main()` writes `--help`, `--version` and a
 * command's serialized output the same way: one `process.stdout.write()`, and a
 * redirect that exited 0 over a cut-off file for every app built with sigil. The
 * last describe in this file is that, from the outside.
 */

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const app = join(here, 'fixtures', 'app');

const bins = {
  'dist/sigil.mjs': join(root, 'dist', 'sigil.mjs'),
  'src/sigil.ts': join(root, 'src', 'sigil.ts'),
};

interface Ran {
  code: number | null;
  signal: NodeJS.Signals | null;
  stderr: string;
}

/**
 * Runs the toolchain with its stdout a file, and under a size limit if one is named.
 *
 * Through `sh -c 'ulimit -f N; exec ...'` so the limit is the child's and not
 * the test runner's, whose own output would hit it. `-f 1` is one block: 512
 * bytes in dash and 1024 in bash, and the document is 2,276 either way. With no
 * limit there is no shell at all, which is what lets the control run on Windows.
 */
function runToFile(
  bin: string,
  args: string[],
  dest: string,
  limit?: number,
  /** Which descriptor is the file: `2> log` is a file as much as `> out`. */
  to: 'stdout' | 'stderr' = 'stdout'
): Promise<Ran> {
  return new Promise((settle, fail) => {
    const fd = openSync(dest, 'w');
    const [command, argv] =
      limit === undefined
        ? [process.execPath, [bin, ...args]]
        : ['/bin/sh', ['-c', `ulimit -f ${limit}; exec "$0" "$@"`, process.execPath, bin, ...args]];
    const child = spawn(command, argv, {
      cwd: root,
      env: { ...process.env, COLUMNS: '80', NODE_NO_WARNINGS: '1' },
      stdio: to === 'stderr' ? ['ignore', 'pipe', fd] : ['ignore', fd, 'pipe'],
    });
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      fail(new Error(`${args.join(' ')} did not finish within 30s`));
    }, 30_000);

    child.stderr?.on('data', (chunk: Buffer) => void (stderr += chunk.toString()));
    child.on('error', (error) => {
      clearTimeout(timer);
      closeSync(fd);
      fail(error);
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      closeSync(fd);
      settle({ code, signal, stderr });
    });
  });
}

let dir: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'sigil-output-'));
});
afterAll(() => {
  rmSync(dir, { force: true, recursive: true });
});

/** What a document is when nothing limits the file: the control every cut-off test measures against. */
async function whole(bin: string, args: string[], name: string): Promise<number> {
  const dest = join(dir, `whole-${name}`);
  const ran = await runToFile(bin, args, dest);

  expect(ran.code).toBe(0);
  return statSync(dest).size;
}

describe.each(Object.entries(bins))('a document redirected to a file, %s', (binName, bin) => {
  const slug = binName.replace(/\W/g, '-');

  // not skipped on Windows, which has no `ulimit`: it proves the redirected
  // command works end to end there, and `writeTo()` above is what pins the
  // descriptor path itself, since this passes with that path removed
  it('should write the whole of it when nothing limits the file', async () => {
    // larger than a one-block limit is in either shell, so the limited runs
    // below really are cut
    expect(await whole(bin, ['reference', app], `${slug}.md`)).toBeGreaterThan(1024);
  });

  describe.skipIf(process.platform === 'win32')('under a size limit', () => {
    it('should exit non-zero over a file cut short, and say so', async () => {
      const full = await whole(bin, ['reference', app], `${slug}-m.md`);
      const dest = join(dir, `${slug}-cut.md`);
      const ran = await runToFile(bin, ['reference', app], dest, 1);

      // the file is short, which is the defect's precondition: it proves the
      // limit bit, so a zero below is the bug and not a limit that never applied
      expect(statSync(dest).size).toBeLessThan(full);
      expect(ran.code).not.toBe(0);
      // a runtime that does not ignore SIGXFSZ ends the process by signal at the
      // next write instead, which is also not a zero
      expect(ran.code === 1 ? ran.stderr : ran.signal).toMatch(/cut off|SIGXFSZ/);
    });

    it('should do the same for the snapshot, which is the same one write', async () => {
      const full = await whole(bin, ['reference', app, '--json'], `${slug}-s.json`);
      const dest = join(dir, `${slug}-cut.json`);
      const ran = await runToFile(bin, ['reference', app, '--json'], dest, 1);

      expect(statSync(dest).size).toBeLessThan(full);
      expect(ran.code).not.toBe(0);
    });

    it("should fail `add --quiet`'s listing, which is one write and prints no note after it", async () => {
      // the case round 1 found: `add` writes a table and then a note, and a quiet
      // run prints no note, so there was no second write to fail
      const full = await whole(bin, ['add', '--quiet'], `${slug}-a.txt`);
      const dest = join(dir, `${slug}-cut-add.txt`);
      const ran = await runToFile(bin, ['add', '--quiet'], dest, 1);

      expect(statSync(dest).size).toBeLessThan(full);
      expect(ran.code).not.toBe(0);
      expect(ran.stderr).not.toMatch(STACK);
    });

    // answered by `run()` in the source and by `main()` in the built executable,
    // which is the runtime's and writes it the way `--help` is written -- so this
    // is the same assertion about two different writers, and both must say it
    it('should report a cut-off --version as an error rather than a stack', async () => {
      // a limit of zero is the only one that can cut one line
      const dest = join(dir, `${slug}-cut-version.txt`);
      const ran = await runToFile(bin, ['--version'], dest, 0);

      expect(ran.code).toBe(1);
      expect(ran.stderr).toContain('cut off');
      expect(ran.stderr).not.toMatch(STACK);
    });

    it('should fail an --out that cannot be written in full as well', async () => {
      // not this ticket's defect -- `writeFileSync()` loops until every byte is
      // out -- but the other way to put the same document in a file, so it is
      // pinned beside the one that was wrong, with its control
      const target = join(dir, `${slug}-snapshot.json`);
      const control = await runToFile(
        bin,
        ['reference', app, '--json', '--out', join(dir, `${slug}-control.json`)],
        join(dir, `${slug}-out-control.txt`)
      );
      expect(control.code).toBe(0);

      // a different file: an up-to-date one is not written again, and then there
      // is nothing for the limit to cut
      const ran = await runToFile(
        bin,
        ['reference', app, '--json', '--out', target],
        '/dev/null',
        1
      );

      expect(ran.code).not.toBe(0);
    });
  });
});

describe('the commands that write to a stream', () => {
  // the helper is one definition and a site that goes round it is the defect
  // back, with nothing failing: a short write raises no error to notice. Read as
  // a directory rather than a list, so a command file added next year is checked
  // without anybody remembering to add it here. Whitespace is allowed between
  // the stream and `.write`, which is where the formatter breaks a long chain
  const files = [
    'index.ts',
    'report.ts',
    ...readdirSync(join(root, 'src', 'commands'))
      .filter((file) => file.endsWith('.ts'))
      .map((file) => join('commands', file)),
  ];

  it.each(files)('should write %s through output.ts and never the stream directly', (file) => {
    // comments out first: report.ts's own docblock names the call it replaced
    const source = readFileSync(join(root, 'src', file), 'utf-8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');

    expect(source).not.toMatch(/process\.std(?:out|err)\s*\.write\(/);
    if (file === 'report.ts') {
      // handed a stream rather than naming one
      expect(source).not.toMatch(/\bstream\.write\(/);
    }
  });
});

describe.each(Object.entries(bins))(
  'what main() writes, redirected to a file, %s',
  (binName, bin) => {
    const slug = binName.replace(/\W/g, '-');

    describe.skipIf(process.platform === 'win32')('under a size limit', () => {
      it('should exit non-zero over a --help cut short, and say so', async () => {
        // `reference --help` is 1,032 bytes, so one block of either size cuts it:
        // the screen is `main()`'s and is written whole, once
        const args = ['reference', '--help'];
        const full = await whole(bin, args, `${slug}-help.txt`);
        const dest = join(dir, `${slug}-cut-help.txt`);
        const ran = await runToFile(bin, args, dest, 1);

        expect(statSync(dest).size).toBeLessThan(full);
        expect(ran.code).toBe(1);
        expect(ran.stderr).toContain('cut off');
        expect(ran.stderr).not.toMatch(STACK);
      });
    });
  }
);

/**
 * An app of its own, run from source with `node`: `main()` is the runtime's and
 * what an app calls, so the toolchain's commands are not the only witness to what
 * it does to every other one.
 */
describe('an app built on main(), redirected to a file', () => {
  const fixture = join(here, 'fixtures', 'main-output', 'app.mjs');

  /** Runs it with stdout a file, optionally under a size limit. */
  const run = (args: string[], dest: string, limit?: number) =>
    runToFile(fixture, args, dest, limit);

  it('should write the whole of --help, --version and its JSON when nothing limits the file', async () => {
    for (const args of [['--help'], ['--version'], ['list', '--json']]) {
      const dest = join(dir, `app-whole-${args.join('')}.txt`);
      const ran = await run(args, dest);

      expect(ran.code, args.join(' ')).toBe(0);
      expect(ran.stderr).toBe('');
      expect(statSync(dest).size).toBeGreaterThan(0);
    }
    expect(
      JSON.parse(readFileSync(join(dir, 'app-whole-list--json.txt'), 'utf-8')).items
    ).toHaveLength(200);
  });

  describe.skipIf(process.platform === 'win32')('under a size limit', () => {
    it.each([['--help'], ['--version'], ['list', '--json']])(
      'should exit non-zero when %s was cut off',
      async (...args) => {
        const dest = join(dir, `app-cut-${args.join('')}.txt`);
        const ran = await run(args, dest, args[0] === '--version' ? 0 : 1);

        expect(ran.code, args.join(' ')).toBe(1);
        expect(ran.stderr).toContain('The output was cut off');
        expect(ran.stderr).not.toMatch(STACK);
      }
    );
  });
});

/**
 * The two writers that still wrote once through the stream (SIG-663): a
 * completion script, and the message `errorHandler()` prints.
 */
describe('an app built on main(), the writers SIG-542 left', () => {
  const fixture = join(here, 'fixtures', 'main-output', 'app.mjs');

  describe.skipIf(process.platform === 'win32')('under a size limit', () => {
    it('should exit non-zero when `completion bash` was cut off', async () => {
      const control = join(dir, 'completion-whole.sh');
      expect((await runToFile(fixture, ['completion', 'bash'], control)).code).toBe(0);

      const dest = join(dir, 'completion-cut.sh');
      const ran = await runToFile(fixture, ['completion', 'bash'], dest, 1);

      // the limit bit, so a zero below is the defect and not a limit that never applied
      expect(statSync(dest).size).toBeLessThan(statSync(control).size);
      expect(ran.code).toBe(1);
      expect(ran.stderr).toContain('The output was cut off');
      expect(ran.stderr).not.toMatch(STACK);
    });

    it('should not exit zero over an error message that was cut off, even for an error that asked for zero', async () => {
      // `exitCode: 0` is how an error says it is a clean exit -- a help
      // short-circuit -- and the message is the only thing it says. Cut off, that
      // is success reported over a file that holds half of it
      const dest = join(dir, 'fail-cut.txt');
      const ran = await runToFile(fixture, ['fail', '0'], dest, 1, 'stderr');

      expect(statSync(dest).size).toBeGreaterThan(0);
      expect(statSync(dest).size).toBeLessThan(2900);
      expect(ran.signal).toBeNull();
      expect(ran.code).toBe(1);
    });

    it('should leave the exit code of an error whose message was cut off as the error’s own', async () => {
      const dest = join(dir, 'fail-cut-2.txt');
      const ran = await runToFile(fixture, ['fail', '2'], dest, 1, 'stderr');

      expect(ran.signal).toBeNull();
      expect(ran.code).toBe(2);
    });

    it('should write the whole message, and keep the code, when nothing limits the file', async () => {
      const dest = join(dir, 'fail-whole.txt');
      const ran = await runToFile(fixture, ['fail', '0'], dest, undefined, 'stderr');

      expect(ran.code).toBe(0);
      expect(statSync(dest).size).toBeGreaterThanOrEqual(2900);
    });
  });
});
