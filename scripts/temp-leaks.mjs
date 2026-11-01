#!/usr/bin/env node

/**
 * Runs each vitest project against a temp directory of its own and reports
 * anything a run left behind in it.
 *
 *   pnpm test:leaks                        every package
 *   pnpm test:leaks @ttylabs/config-xml    just the ones named
 *
 * It builds first, with the build half of the root `test` script, so the
 * package list lives in one place and `@ttylabs/cli`'s tests find `dist/`.
 * Exits 1 when a project leaks or fails.
 *
 * A script rather than a test, because a test cannot count the real tmpdir:
 * other runs, other worktrees and every other program on the machine write
 * there too, so a before-and-after count of it flakes as soon as anything runs
 * alongside. Pointing `TMPDIR` (and `TEMP` and `TMP`, which is what Windows
 * reads) at an empty directory makes the count exact, and that only works from
 * outside the run, because os.tmpdir() is read by the vitest workers and the
 * children they spawn. Projects run one at a time so that a leak is charged to
 * the package that made it. See "The suite removes every directory it makes"
 * in packages/sigil/src/testing/AGENTS.md.
 */

import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(join(repo, 'package.json'));
const vitest = join(dirname(require.resolve('vitest/package.json')), 'vitest.mjs');

const packages = join(repo, 'packages');
const all = readdirSync(packages, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => JSON.parse(readFileSync(join(packages, entry.name, 'package.json'), 'utf8')).name)
  .sort();
const asked = process.argv.slice(2);
const unknown = asked.filter((name) => !all.includes(name));
if (unknown.length) {
  console.error(`Not a project: ${unknown.join(', ')}. The projects are ${all.join(', ')}.`);
  process.exit(1);
}
const projects = asked.length ? asked : all;

// the half of `pnpm test` before vitest, which is the turbo build with one
// `--filter` per package; reused rather than repeated, since a second copy of
// that list is a second place for a new package to be missing from. Through
// `pnpm exec` so that `turbo` resolves when this is run with `node` directly
const rootScripts = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8')).scripts;
const build = rootScripts.test.split(' && ')[0];
const built = spawnSync(`pnpm exec ${build} --output-logs=errors-only`, {
  cwd: repo,
  shell: true,
  stdio: 'inherit',
});
if (built.status !== 0) {
  console.error(`The build failed: ${build}`);
  process.exit(1);
}

/**
 * Groups the names a run left behind by their prefix, which is what a test
 * passes to `mkdtemp`, so that a leak names the test that made it.
 */
function byPrefix(names) {
  const counts = new Map();
  for (const name of names) {
    const prefix = name.replace(/[-_.]?[A-Za-z0-9]{6,}$/, '') || name;
    counts.set(prefix, (counts.get(prefix) ?? 0) + 1);
  }
  return [...counts].sort((a, b) => b[1] - a[1]);
}

const box = mkdtempSync(join(tmpdir(), 'sigil-temp-leaks-'));
let failed = false;

try {
  for (const project of projects) {
    const dir = mkdtempSync(join(box, 'run-'));
    const run = spawnSync(process.execPath, [vitest, 'run', '--project', project], {
      cwd: repo,
      encoding: 'utf8',
      env: { ...process.env, TEMP: dir, TMP: dir, TMPDIR: dir },
      maxBuffer: 256 * 1024 * 1024,
    });
    const left = readdirSync(dir);
    const tests = /^\s*Tests\s+(.*)$/m.exec(run.stdout ?? '')?.[1]?.trim() ?? 'no summary';

    if (run.status !== 0) {
      failed = true;
      console.log(`${project}: the run failed (${tests})`);
      process.stdout.write((run.stdout ?? '').split('\n').slice(-40).join('\n'));
      process.stderr.write(run.stderr ?? '');
    }
    if (left.length) {
      failed = true;
      console.log(`${project}: ${left.length} left behind (${tests})`);
      for (const [prefix, count] of byPrefix(left)) {
        console.log(`  ${String(count).padStart(6)}  ${prefix}`);
      }
    } else if (run.status === 0) {
      console.log(`${project}: nothing left behind (${tests})`);
    }
  }
} finally {
  rmSync(box, { force: true, maxRetries: 5, recursive: true });
}

process.exit(failed ? 1 : 0);
