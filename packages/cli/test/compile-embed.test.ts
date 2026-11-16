import {
  compileWithBun,
  hostTarget,
  isHostTarget,
  label,
  parseTarget,
  targets,
  type Target,
} from '../src/build/compile.ts';
import { tempDir } from './temp.ts';
import { whichSync } from '@ttylabs/sigil/which';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { describe, expect, it } from 'vitest';

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

/** A target that is not this machine's and that Bun can build. */
const other: Target = targets()
  .map(parseTarget)
  .find((one) => !isHostTarget(one) && label(one) !== 'windows-arm64') as Target;

/** A `bun` that records how it was run, then writes `size` bytes where `--outfile` said. */
function recorder(name: string, size: number): { exec: string; ran: string } {
  const exec = join(box, name);
  const ran = join(box, `${name}.ran`);

  writeFileSync(
    exec,
    // $4 is the entry and $5 the outfile: `--no-install -e <script> <entry> <outfile> <target> <runtime>`
    `#!/bin/sh\n{ pwd; for a in "$@"; do echo "$a"; done; } > '${ran}'\n[ ${size} -gt 0 ] && head -c ${size} /dev/zero > "$5"\nexit 0\n`,
    { mode: 0o755 }
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
      // the script names the option that embeds a file instead of fetching one
      expect(readFileSync(ran, 'utf-8')).toContain('executablePath');
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
      // can supply for the host target
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
