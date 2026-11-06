import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * `scripts/ci-scope.mjs` decides whether a pull request runs the nine-job
 * package matrix. Run as CI runs it: changed paths on stdin, `packages=...`
 * on stdout.
 */
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const script = resolve(root, 'scripts/ci-scope.mjs');

function scope(files: string[]): string {
  const result = spawnSync(process.execPath, [script], {
    input: files.join('\n') + '\n',
    encoding: 'utf8',
  });
  expect(result.stderr).toBe('');
  expect(result.status).toBe(0);
  return result.stdout;
}

describe('the CI scope', () => {
  it('should skip the package matrix for a PR that changes only the website', () => {
    expect(
      scope([
        'website/src/app/page.tsx',
        'website/src/components/site-header.tsx',
        'website/README.md',
      ])
    ).toBe('packages=false\n');
  });

  it('should run the package matrix when a package changes', () => {
    expect(scope(['website/src/app/page.tsx', 'packages/sigil/src/index.ts'])).toBe(
      'packages=true\n'
    );
  });

  it('should run the package matrix for a change outside both', () => {
    for (const file of ['pnpm-lock.yaml', '.github/workflows/test.yml', 'demos/README.md']) {
      expect(scope([file])).toBe('packages=true\n');
    }
  });

  it('should run the package matrix for the website files the package suite reads', () => {
    for (const file of [
      'website/src/reference/build.md',
      'website/package.json',
      'website/turbo.json',
    ]) {
      expect(scope([file])).toBe('packages=true\n');
    }
  });

  it('should not mistake a sibling of a website file the suite reads for it', () => {
    expect(scope(['website/src/reference-page.tsx', 'website/package.json.bak'])).toBe(
      'packages=false\n'
    );
  });

  it('should skip the package matrix when nothing changed', () => {
    expect(scope([])).toBe('packages=false\n');
  });

  it('should be what the workflow gates the package matrix on', () => {
    const workflow = readFileSync(resolve(root, '.github/workflows/test.yml'), 'utf8');
    expect(workflow).toContain('node scripts/ci-scope.mjs >> "$GITHUB_OUTPUT"');
    expect(workflow).toContain("if: needs.changes.outputs.packages == 'true'");
    // The one package test a website-only PR can fail runs outside the matrix.
    expect(workflow).toContain('vitest run packages/sigil/test/sources.test.ts');
  });
});
