import { writeFully, writeOut } from '../src/output.ts';
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
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

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
 * Two halves. The spawned one is the honest reproduction and POSIX only, since
 * Windows has no `ulimit`; the in-process one is the short-write handling itself
 * and runs everywhere.
 */

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const app = join(here, 'fixtures', 'app');

const bins = {
  'dist/sigil.mjs': join(root, 'dist', 'sigil.mjs'),
  'src/sigil.ts': join(root, 'src', 'sigil.ts'),
};

describe('writeFully()', () => {
  /** A sink that takes at most `room` bytes in all, the way a file at its limit does. */
  function limited(room: number, seen: Buffer[] = []) {
    let left = room;
    return {
      seen,
      write(bytes: Uint8Array, offset: number): number {
        if (left <= 0) {
          throw Object.assign(new Error('EFBIG: file too large, write'), { code: 'EFBIG' });
        }
        const taken = Math.min(left, bytes.length - offset, 4);
        seen.push(Buffer.from(bytes.subarray(offset, offset + taken)));
        left -= taken;
        return taken;
      },
    };
  }

  it('should write the whole of a document the sink takes in pieces', () => {
    const sink = limited(100);

    writeFully('a document of several pieces', sink.write);

    expect(Buffer.concat(sink.seen).toString()).toBe('a document of several pieces');
  });

  it('should throw, saying how much landed, when the sink stops taking bytes', () => {
    const sink = limited(10);

    expect(() => writeFully('a document of several pieces', sink.write)).toThrow(
      'The output was cut off: 10 of 28 bytes were written (EFBIG).'
    );
  });

  it('should count bytes rather than characters', () => {
    // 3 + 4 bytes, which a character count would call 2
    const sink = limited(100);

    writeFully('€\u{1f600}', sink.write);

    expect(Buffer.concat(sink.seen).toString()).toBe('€\u{1f600}');
  });

  it('should refuse a sink that takes nothing rather than loop on it', () => {
    expect(() => writeFully('abc', () => 0)).toThrow(
      'The output was cut off: 0 of 3 bytes were written, and the destination took no more.'
    );
  });

  it('should write nothing for an empty document', () => {
    const write = vi.fn(() => 0);

    writeFully('', write);

    expect(write).not.toHaveBeenCalled();
  });
});

describe('writeOut()', () => {
  it('should go through process.stdout.write when something has replaced it', () => {
    // a capture -- a test, or an app embedding a command -- is the stream's to
    // see, and writing to the descriptor underneath it would bypass the capture
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      writeOut('captured\n');
      expect(spy).toHaveBeenCalledWith('captured\n');
    } finally {
      spy.mockRestore();
    }
  });
});

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
function runToFile(bin: string, args: string[], dest: string, limit?: number): Promise<Ran> {
  return new Promise((settle, fail) => {
    const fd = openSync(dest, 'w');
    const [command, argv] =
      limit === undefined
        ? [process.execPath, [bin, ...args]]
        : ['/bin/sh', ['-c', `ulimit -f ${limit}; exec "$0" "$@"`, process.execPath, bin, ...args]];
    const child = spawn(command, argv, {
      cwd: root,
      env: { ...process.env, COLUMNS: '80', NODE_NO_WARNINGS: '1' },
      stdio: ['ignore', fd, 'pipe'],
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

  // not skipped on Windows, which has no `ulimit` but does have the descriptor
  // path: this is the one test there that runs `fstat` and `writeSync` for real
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

    // the built executable never reaches `run()`: its `--version` is `main()`'s,
    // which is the runtime's and writes it the way `--help` is written
    it.skipIf(binName !== 'src/sigil.ts')(
      'should report a cut-off --version as an error rather than a stack',
      async () => {
        // answered before `main()` exists, so nothing else would render it. A limit
        // of zero is the only one that can cut one line
        const dest = join(dir, `${slug}-cut-version.txt`);
        const ran = await runToFile(bin, ['--version'], dest, 0);

        expect(ran.code).toBe(1);
        expect(ran.stderr).toContain('cut off');
        expect(ran.stderr).not.toMatch(STACK);
      }
    );

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
