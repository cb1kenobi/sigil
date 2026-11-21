import {
  compileWithBun,
  compileWithNode,
  hostTarget,
  isHostTarget,
  parseTarget,
  type Target,
} from '../src/build/compile.ts';
import { bunVersion, cacheDir, parseSpec } from '../src/build/runtimes.ts';
import { writeExecutable } from './executable.ts';
import { tempDir } from './temp.ts';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

/**
 * What `sigil package` refuses, and what the refusal quotes (SIG-510).
 *
 * A refusal quotes a value that came from outside the toolchain -- a flag, a
 * `sigil.json`, an output path, an executable a stub or a `PATH` supplied -- and
 * the error handler writes what it is handed, so an escape sequence in the value
 * reached the terminal as an escape sequence, and a newline in it as a second
 * line the toolchain never wrote. Each refusal here is given a value holding
 * both and asked what it says, and every one goes through `escapeControls()`
 * from `@ttylabs/sigil/error-handler`, which is what `sigil build` already uses.
 *
 * The values that are paths are written with a control character in a file
 * name, which Windows refuses to create at all, so those are POSIX-only. The
 * compilers are stubs: what is under test is the message, and the real `bun`,
 * `node --build-sea` and `codesign` are neither needed to reach it nor able to
 * be made to fail on demand.
 */

const box = tempDir('sigil-pkg-escape-');
const POSIX = process.platform !== 'win32';

/** A window rename and a second line, which is what an unescaped value can do. */
const HOSTILE = '\u001b]0;PWNED\u0007\nforged: error: forged';

/** What `escapeControls()` makes of `HOSTILE`, as it appears inside a message. */
const ESCAPED = '\\x1B]0;PWNED\\x07\\x0Aforged: error';

/** A name with the hostile value in it, which no file system but a POSIX one holds. */
const dirty = (name: string): string => join(box, `${name}-${HOSTILE}`);

/**
 * Asserts a message carries `HOSTILE` escaped and carries nothing a terminal
 * would act on, which is two claims: the escape is there, and the raw form is not.
 */
function expectInert(message: string): void {
  expect(message).toContain(ESCAPED);
  // every control character but the newline the message is itself made of
  expect(message.replaceAll('\n', '')).not.toMatch(/\p{Cc}/u);
  expect(message.split('\n').some((line) => line.startsWith('forged: error'))).toBe(false);
}

/** The message of whatever `work` throws. */
function refusal(work: () => unknown): string {
  try {
    work();
  } catch (error) {
    return (error as Error).message;
  }

  throw new Error('expected it to refuse');
}

/** A target that is not this machine's, that Bun can build, and needs no signing. */
const other: Target = ['linux-x64', 'linux-arm64', 'windows-x64']
  .map(parseTarget)
  .find((one) => !isHostTarget(one)) as Target;

describe('a value a refusal quotes', () => {
  let path: string | undefined;

  beforeEach(() => {
    path = process.env.PATH;
  });

  afterEach(() => {
    process.env.PATH = path;
  });

  describe('from a flag', () => {
    it('should be escaped when it is not a target', () => {
      expectInert(refusal(() => parseTarget(HOSTILE)));
    });

    it('should be escaped when it is not a runtime', () => {
      expectInert(refusal(() => parseSpec(HOSTILE)));
    });

    it('should be escaped when it is not a version', () => {
      expectInert(refusal(() => parseSpec(`bun@${HOSTILE}`)));
    });

    it('should be escaped when a cache directory is asked for one', () => {
      expectInert(refusal(() => cacheDir(box, 'bun', HOSTILE)));
    });
  });

  describe.skipIf(!POSIX)('from a path', () => {
    it('should be escaped when bun cannot be run', () => {
      const exec = dirty('no-such-bun');

      expectInert(
        refusal(() =>
          compileWithBun({ entry: 'e.js', exec, out: join(box, 'a'), target: hostTarget() })
        )
      );
    });

    it('should be escaped when bun exited cleanly and wrote no binary, naming both paths', () => {
      const exec = dirty('bun-writes-nothing');
      const embed = join(box, 'runtime');
      writeExecutable(exec, '#!/bin/sh\nexit 0\n');
      writeFileSync(embed, 'x'.repeat(500));

      const message = refusal(() =>
        compileWithBun({ embed, entry: 'e.js', exec, out: dirty('never'), target: other })
      );

      expect(message).toContain('did not write a binary');
      // the executable and the output, which is two values in one sentence
      expect(message.split(ESCAPED)).toHaveLength(3);
      expectInert(message);
    });

    it('should be escaped when the compiler reported success and wrote no binary', () => {
      // the host target and no embed, so nothing checks the size beforehand. A
      // codesign that succeeds, because on macOS the host is signed and a real
      // one would refuse the missing file first
      const exec = join(box, 'bun-success-writes-nothing');
      const bin = join(box, 'codesign-ok');
      writeExecutable(exec, '#!/bin/sh\nexit 0\n');
      mkdirSync(bin, { recursive: true });
      writeExecutable(join(bin, 'codesign'), '#!/bin/sh\nexit 0\n');
      process.env.PATH = bin;

      const message = refusal(() =>
        compileWithBun({ entry: 'e.js', exec, out: dirty('missing'), target: hostTarget() })
      );

      expect(message).toContain('wrote no binary at');
      expectInert(message);
    });

    it('should be escaped when codesign refuses the binary', () => {
      const bin = join(box, 'codesign-bin');
      const exec = join(box, 'bun-writes');
      const embed = join(box, 'runtime-signed');
      const target = ['darwin-arm64', 'darwin-x64']
        .map(parseTarget)
        .find((one) => !isHostTarget(one)) as Target;

      mkdirSync(bin, { recursive: true });
      writeExecutable(join(bin, 'codesign'), '#!/bin/sh\necho "no identity found" >&2\nexit 1\n');
      // `$5` is the outfile in the form that embeds a runtime
      writeExecutable(
        exec,
        '#!/bin/sh\nPATH=/usr/bin:/bin\nhead -c 1000 /dev/zero > "$5"\nexit 0\n'
      );
      writeFileSync(embed, 'x'.repeat(500));

      // only the stub on `PATH`, so it is what runs and never the machine's own
      process.env.PATH = bin;

      const out = dirty('signed');
      const message = refusal(() =>
        compileWithBun({ embed, entry: 'e.js', exec, out, sign: 'x', target })
      );

      expect(message).toContain('codesign failed for');
      expectInert(message);
      expect(existsSync(out)).toBe(false);
    });

    it('should be escaped when node cannot be run to say what it is', () => {
      const exec = dirty('no-such-node');

      expectInert(
        refusal(() =>
          compileWithNode({ entry: 'e.js', exec, out: join(box, 'b'), target: hostTarget() })
        )
      );
    });

    it('should be escaped, with the version it printed, when node is too old to build one', () => {
      const exec = join(box, 'node-too-old');
      writeExecutable(
        exec,
        `#!/bin/sh\nprintf 'v1.0.0 %s\\n' '${HOSTILE.replaceAll('\n', ' ')}'\n`
      );

      const message = refusal(() =>
        compileWithNode({ entry: 'e.js', exec, out: join(box, 'c'), target: hostTarget() })
      );

      expect(message).toContain('is needed to package with Node');
      expect(message).toContain('\\x1B]0;PWNED\\x07');
      expect(message).not.toContain('\u001b');
      expect(message).not.toContain('\u0007');
    });

    it('should be escaped when node, having answered --version, cannot be run to build', () => {
      // it makes itself unrunnable on the way out of the version probe, so the
      // second spawn -- the build -- is the one that fails to start
      const exec = dirty('node-gone-after-version');
      writeExecutable(exec, `#!/bin/sh\necho v99.0.0\nchmod 644 "$0"\n`);

      const message = refusal(() =>
        compileWithNode({ entry: 'e.js', exec, out: join(box, 'd'), target: hostTarget() })
      );

      expect(message).toContain('Failed to run node at');
      expectInert(message);
    });

    it('should be escaped when bunVersion cannot run it, or it reports nothing a release has', () => {
      expectInert(refusal(() => bunVersion(dirty('no-such-bun-version'))));

      const exec = dirty('bun-says-nothing');
      writeExecutable(exec, '#!/bin/sh\nexit 0\n');

      const message = refusal(() => bunVersion(exec));

      expect(message).toContain('did not report a release version');
      expectInert(message);
    });

    it('should be escaped when bun is too old to embed a runtime it was handed', () => {
      const exec = dirty('bun-too-old');
      writeExecutable(exec, '#!/bin/sh\necho 1.0.0\n');

      const message = refusal(() => bunVersion(exec));

      expect(message).toContain('cannot embed the runtime');
      expectInert(message);
    });
  });
});
