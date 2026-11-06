#!/usr/bin/env node

/**
 * Whether a pull request needs the package test matrix: nine node-and-OS jobs
 * of the whole vitest suite over `packages/*`.
 *
 * Reads the changed paths from stdin, one per line, and prints
 * `packages=true` or `packages=false`, the form `$GITHUB_OUTPUT` takes.
 *
 * The matrix can be skipped only when every changed file is under `website/`,
 * which no package imports. Even there, three files are read by the package
 * suite, so a change to one of them still needs it. If a package test starts
 * reading another website file, add it to `PACKAGE_READS`.
 *
 * What a website-only PR still needs from the package suite is
 * `packages/sigil/test/sources.test.ts`, which reads every tracked file for raw
 * control characters. The `check` job runs that file on every PR, so it is
 * not this script's concern.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** Website files the package suite reads. A trailing `/` is a directory. */
export const PACKAGE_READS = [
  // `command-surface.test.ts` checks the generated reference pages.
  'website/src/reference/',
  // `cli.test.ts` checks that every manifest pins its dependencies.
  'website/package.json',
  // `cli.test.ts` checks the build hash through turbo's dry run.
  'website/turbo.json',
];

function readByPackages(file) {
  return PACKAGE_READS.some((read) => (read.endsWith('/') ? file.startsWith(read) : file === read));
}

/** Whether any of `files` is something the package suite tests. */
export function needsPackageSuite(files) {
  return files.some((file) => !file.startsWith('website/') || readByPackages(file));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const files = readFileSync(0, 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  process.stdout.write(`packages=${needsPackageSuite(files)}\n`);
}
