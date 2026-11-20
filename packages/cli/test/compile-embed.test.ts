import {
  compileWithBun,
  hostTarget,
  isHostTarget,
  label,
  parseTarget,
  type Target,
} from '../src/build/compile.ts';
import { writeExecutable } from './executable.ts';
import { tempDir } from './temp.ts';
import { whichSync } from '@ttylabs/sigil/which';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, isAbsolute, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

/**
 * A Bun binary embeds a runtime sigil verified, or is not written (SIG-442).
 *
 * `bun build --compile --target=bun-<other>` fetches that platform's runtime
 * itself and embeds it unchecked, so `compileWithBun()` refuses a target that is
 * not the host's unless it is handed a runtime, and given one it compiles
 * through `Bun.build()`'s `compile.executablePath`, which embeds the file it is
 * named and fetches nothing.
 *
 * What the real thing does with the network refused is a measurement, not a test:
 * it needs a runtime for a platform this machine is not, which only a download
 * provides. What is asserted here is what can be without one -- the refusal, the
 * shape of the invocation through a stub `bun`, and a real `bun` embedding a
 * runtime it was handed.
 */

const box = tempDir('sigil-embed-');
const POSIX = process.platform !== 'win32';
const hasBun = Boolean(whichSync('bun'));

/**
 * A target that is not this machine's, that Bun can build, and that needs no
 * signing: `codesign` is macOS's, so a `darwin-*` target fails on every other
 * host for a reason these tests are not about.
 */
const other: Target = ['linux-x64', 'linux-arm64', 'windows-x64']
  .map(parseTarget)
  .find((one) => !isHostTarget(one)) as Target;

/**
 * A `bun` that records how it was run and with what environment, then writes
 * `size` bytes where the binary goes -- `$5` in the form that embeds a runtime.
 */
function recorder(name: string, size: number): { exec: string; ran: string } {
  const exec = join(box, name);
  const ran = join(box, `${name}.ran`);

  writeExecutable(
    exec,
    // $4 is the entry and $5 the outfile: `--no-install -e <script> <entry> <outfile> <target> <runtime>`
    `#!/bin/sh\n{ pwd; for a in "$@"; do echo "$a"; done; } > '${ran}'\nenv > '${ran}.env'\n{ [ -d "$BUN_INSTALL_CACHE_DIR" ] && echo exists; [ -z "$(ls -A "$BUN_INSTALL_CACHE_DIR")" ] && echo empty; } > '${ran}.cache'\n[ "$1" = "--no-install" ] && [ ${size} -gt 0 ] && head -c ${size} /dev/zero > "$5"\nexit 0\n`
  );

  return { exec, ran };
}

describe('compiling for a platform that is not this one', () => {
  it('should refuse without a runtime to embed, and leave what is at the output alone', () => {
    const out = join(box, 'previous-release');
    writeFileSync(out, 'PREVIOUS GOOD RELEASE');

    expect(() =>
      compileWithBun({ entry: 'unused', exec: 'unused-bun', out, target: other })
    ).toThrow(/without a verified runtime to embed/);

    expect(readFileSync(out, 'utf-8')).toBe('PREVIOUS GOOD RELEASE');
  });

  it('should not need one for the host, which embeds the bun that compiles', () => {
    expect(isHostTarget(hostTarget())).toBe(true);
    expect(isHostTarget(other)).toBe(false);
  });

  it.skipIf(!POSIX)(
    'should compile through Bun.build() with the runtime it was handed, from a directory of its own',
    () => {
      const { exec, ran } = recorder('bun-records', 1000);
      const embed = join(box, 'runtime');
      const out = join(box, 'binary');
      writeFileSync(embed, 'x'.repeat(500));

      compileWithBun({ embed, entry: 'entry.js', exec, out, target: other });

      const [cwd, ...args] = readFileSync(ran, 'utf-8').trimEnd().split('\n') as [
        string,
        ...string[],
      ];

      // not `bun build --compile`, which is the form that fetches
      expect(args.slice(0, 2)).toEqual(['--no-install', '-e']);
      expect(args).not.toContain('build');
      expect(args).not.toContain('--compile');
      expect(args.some((one) => one.startsWith('--target'))).toBe(false);
      expect(args[0]).toBe('--no-install');
      // the script names the option that embeds a file instead of fetching one,
      // **in the object `Bun.build()` is given** -- the word is also the name of
      // a variable the script destructures, so finding it anywhere proves nothing
      expect(readFileSync(ran, 'utf-8')).toMatch(/compile:\s*\{[^}]*\bexecutablePath\b/);
      // absolute, because the script does not run where the caller did
      expect(args.slice(-4)).toEqual([
        join(process.cwd(), 'entry.js'),
        out,
        `bun-${label(other)}`,
        embed,
      ]);
      expect(args.slice(-4).filter((one) => !isAbsolute(one) && !one.startsWith('bun-'))).toEqual(
        []
      );
      // and not from the app's own directory, whose `bunfig.toml` a script
      // would load -- `preload` included, which `bun build` never does
      expect(cwd).not.toBe(process.cwd());
      expect(existsSync(cwd)).toBe(false);
    }
  );

  it.skipIf(!POSIX)('should refuse a bun that exits cleanly without writing a binary', () => {
    // a Bun that predates `compile` in `Bun.build()` takes it, ignores it and
    // answers `success: true`
    const { exec } = recorder('bun-writes-nothing', 0);
    const embed = join(box, 'runtime-2');
    const out = join(box, 'never-written');
    writeFileSync(embed, 'x'.repeat(500));

    expect(() => compileWithBun({ embed, entry: 'entry.js', exec, out, target: other })).toThrow(
      /did not write a binary/
    );
    expect(existsSync(out)).toBe(false);
  });

  it.skipIf(!POSIX)(
    'should not take the previous release for this one when bun writes nothing',
    () => {
      // a Bun older than 1.2.21 ignores `compile` and answers success, and
      // `--no-clean` leaves the last binary at the path: it is bigger than half
      // the runtime, so the size check alone shipped it as this run's
      const { exec } = recorder('bun-writes-nothing-over', 0);
      const embed = join(box, 'runtime-4');
      const out = join(box, 'previous-release-over');
      writeFileSync(embed, 'x'.repeat(500));
      writeFileSync(out, 'y'.repeat(1000));

      expect(() => compileWithBun({ embed, entry: 'entry.js', exec, out, target: other })).toThrow(
        /did not write a binary/
      );
      expect(existsSync(out)).toBe(false);
    }
  );

  describe.skipIf(!POSIX)('the environment bun is run in', () => {
    // which targets are the host's is node's answer, and a bun can disagree
    // (an x64 node under Rosetta beside an arm64 bun). Such a bun looks for a
    // runtime in its working directory, then in its install cache, and uses
    // what it finds with no check, then downloads. So neither spawn is given a
    // network, a cache, or a directory with anything in it
    const saved = { ...process.env };
    const names = [
      'HTTPS_PROXY',
      'HTTP_PROXY',
      'https_proxy',
      'http_proxy',
      'NO_PROXY',
      'no_proxy',
    ];

    afterEach(() => {
      delete process.env.No_Proxy;
      delete process.env.BUN_INSTALL_CACHE_DIR;

      for (const name of names) {
        if (saved[name] === undefined) {
          delete process.env[name];
        } else {
          process.env[name] = saved[name];
        }
      }
    });

    const run = (name: string, target: Target, embed?: string) => {
      process.env.NO_PROXY = '*';
      process.env.no_proxy = '*';
      process.env.No_Proxy = '*';
      process.env.HTTPS_PROXY = 'http://proxy.example:3128';
      process.env.BUN_INSTALL_CACHE_DIR = join(box, 'users-own-cache');

      const { exec, ran } = recorder(name, 1000);
      const out = join(box, `${name}.out`);

      if (embed) {
        writeFileSync(embed, 'x'.repeat(500));
      }

      try {
        compileWithBun({ ...(embed ? { embed } : {}), entry: 'entry.js', exec, out, target });
      } catch {
        // signing what the stand-in wrote fails on macOS; it ran first, and the
        // environment it ran in is the thing being read
      }

      const [cwd, ...args] = readFileSync(ran, 'utf-8').trimEnd().split('\n') as [
        string,
        ...string[],
      ];

      return {
        args,
        cache: readFileSync(`${ran}.cache`, 'utf-8').trim().split('\n'),
        cwd,
        env: readFileSync(`${ran}.env`, 'utf-8').split('\n'),
      };
    };

    const checks = (seen: ReturnType<typeof run>) => {
      // the network: a port that refuses at once, and nothing that goes round it
      for (const name of ['HTTPS_PROXY', 'HTTP_PROXY', 'https_proxy', 'http_proxy']) {
        expect(seen.env).toContain(`${name}=http://127.0.0.1:0`);
      }

      // `NO_PROXY=*` sends a request straight past a dead proxy, in any spelling
      expect(seen.env.filter((line) => /^no_proxy=/i.test(line))).toEqual([]);

      // the install cache is an empty directory that exists, and it is where the
      // spawn runs -- not the user's own cache, and not where sigil was started
      const cache = seen.env.find((line) => line.startsWith('BUN_INSTALL_CACHE_DIR='))?.slice(22);

      expect(cache).toBeDefined();
      expect(cache).not.toBe(join(box, 'users-own-cache'));
      expect(seen.cache).toEqual(['exists', 'empty']);
      // the same directory, which is gone by now, so named rather than resolved
      expect(basename(seen.cwd)).toBe(basename(cache as string));
      expect(seen.cwd).not.toBe(process.cwd());
    };

    it('should be one Bun cannot download in, when it embeds a runtime', () => {
      checks(run('bun-env-embed', other, join(box, 'runtime-env')));
    });

    it('should be one Bun cannot download in, when it compiles for the host', () => {
      const seen = run('bun-env-host', hostTarget());

      checks(seen);
      // absolute, because it does not run where the caller did
      expect(seen.args).toContain(join(process.cwd(), 'entry.js'));
    });

    it('should say what went wrong when bun tried to download anyway', () => {
      const exec = join(box, 'bun-tries-to-download');
      writeExecutable(
        exec,
        '#!/bin/sh\necho "Failed to download \'bun-darwin-x64-v1.4.4\': ConnectionRefused" >&2\nexit 1\n'
      );

      expect(() =>
        compileWithBun({ entry: 'entry.js', exec, out: join(box, 'nope'), target: hostTarget() })
      ).toThrow(/not a native .* build although node reports .*\(Rosetta\?\)/);
    });
  });

  it.skipIf(!POSIX)('should not pass what bun printed to the terminal as it printed it', () => {
    // a spawned program's stderr is text from outside, and an escape sequence
    // in it would rename the window or worse once it reached the error handler
    const exec = join(box, 'bun-prints-escapes');
    writeExecutable(exec, "#!/bin/sh\nprintf '\\033]0;PWNED\\007\\n' >&2\nexit 1\n");
    const embed = join(box, 'runtime-5');
    writeFileSync(embed, 'x'.repeat(500));

    const refusal = (() => {
      try {
        compileWithBun({ embed, entry: 'entry.js', exec, out: join(box, 'never'), target: other });
      } catch (error) {
        return (error as Error).message;
      }
    })();

    expect(refusal).toContain('\\x1B]0;PWNED\\x07');
    expect(refusal).not.toContain(String.fromCharCode(0x1b));
  });

  it.skipIf(!POSIX)('should refuse a binary that is smaller than the runtime inside it', () => {
    const { exec } = recorder('bun-writes-little', 100);
    const embed = join(box, 'runtime-3');
    const out = join(box, 'too-small');
    writeFileSync(embed, 'x'.repeat(500));

    expect(() => compileWithBun({ embed, entry: 'entry.js', exec, out, target: other })).toThrow(
      /did not write a binary/
    );
    expect(existsSync(out)).toBe(false);
  });

  it.skipIf(!hasBun)(
    'should embed the file it was handed, and the binary runs',
    () => {
      const bun = whichSync('bun') as string;
      const embed = join(box, 'marked-runtime');
      const entry = join(box, 'hello.js');
      const out = join(box, `hello${process.platform === 'win32' ? '.exe' : ''}`);
      const marker = Buffer.from('SIGIL-EMBED-MARKER-442-SIGIL-EMBED-MARKER-442');

      // the host's own bun with a marker written into it, so that what ends up
      // in the binary is known to be this file and not another copy of Bun: a
      // valid executable of the right format is the one runtime this machine
      // can supply for the host target. Written in this process, which is safe
      // only because `bun` reads it and nothing executes it: the binary that
      // runs is `out`, which `bun` writes (see `test/executable.ts`)
      copyFileSync(bun, embed);
      const bytes = readFileSync(embed);
      marker.copy(bytes, Math.min(40_000_000, bytes.length - marker.length - 1));
      writeFileSync(embed, bytes);
      writeFileSync(entry, 'console.log("hello from the embedded runtime");\n');

      compileWithBun({ embed, entry, exec: bun, out, target: hostTarget() });

      expect(statSync(out).size).toBeGreaterThan(statSync(embed).size / 2);
      expect(readFileSync(out).includes(marker)).toBe(true);
      expect(spawnSync(out, { encoding: 'utf-8' }).stdout).toContain(
        'hello from the embedded runtime'
      );
    },
    120_000
  );
});
