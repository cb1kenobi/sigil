import { run as spawnNode, STACK } from './spawned.ts';
import { tempDir } from './temp.ts';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const fixtures = resolve(here, 'fixtures');
const cli = resolve(here, '../src/sigil.ts');

/**
 * Settings on the schema, in an app run from source and in the same app built.
 *
 * `sigil build` generates an executable that calls `main({ schema })` and nothing
 * else, so a setting the app passed in its own `main()` call was lost once built
 * (SIG-333): `allowUnknownOptions: false` refused a typo from source and accepted
 * it built, and an `errorHandler` rendered differently. `Schema.settings` is what
 * survives, and the claim is the one a user meets -- **the source run and the built
 * executable do the same thing** -- so every assertion below is made of both, by
 * the same `describe.each`, and neither side is allowed to be the reference.
 *
 * Spawned rather than called, because the built half is a file on disk and the
 * source half should be asked the same way: a `main()` called in this process
 * would be asking vitest's loader and not node's.
 */

const app = join(fixtures, 'settings-app');

describe('settings on the schema', () => {
  const out = tempDir('sigil-settings-build-');
  const builds: Record<string, { cwd: string; file: string }> = {
    built: { cwd: out, file: join(out, 'settings-app.mjs') },
    source: { cwd: app, file: join(app, 'dev.mjs') },
  };

  beforeAll(async () => {
    const built = await spawnNode(cli, app, ['build', '--out', out]);

    expect(built.code, built.stderr).toBe(0);
    expect(existsSync(builds.built!.file)).toBe(true);
    // the app passes no settings anywhere, so a warning about it would be a lie
    expect(built.stderr).not.toContain('do not reach a built app');
  }, 60_000);

  describe.each(['source', 'built'])('%s', (kind) => {
    const target = (): { cwd: string; file: string } => builds[kind]!;

    it('should run a command, which is the baseline', async () => {
      const ran = await spawnNode(target().file, target().cwd, ['hello']);

      expect(ran.stdout).toBe('hello\n');
      expect(ran.stderr).toBe('');
      expect(ran.code).toBe(0);
    });

    it('should refuse a typo, which is allowUnknownOptions: false', async () => {
      const ran = await spawnNode(target().file, target().cwd, ['hello', '--typo']);

      expect(ran.stdout).toBe('');
      expect(ran.stderr).toContain('Unknown option "--typo"');
    });

    it("should render the error with the schema's errorHandler", async () => {
      const ran = await spawnNode(target().file, target().cwd, ['hello', '--typo']);

      // the handler's own prefix and its own exit code, so the built-in handler
      // cannot have produced either
      expect(ran.stderr.startsWith('custom handler: ')).toBe(true);
      expect(ran.code).toBe(7);
      expect(ran.stderr).not.toMatch(STACK);
    });

    it('should exit with the help exit code after --help', async () => {
      const ran = await spawnNode(target().file, target().cwd, ['--help']);

      expect(ran.stdout).toContain('hello');
      expect(ran.code).toBe(3);
    });
  });
});

describe('settings passed to main() in the app', () => {
  const warn = join(fixtures, 'settings-warn');
  const location = /dev\.mjs:7:3: warning: .*settings.*schema/;

  it('should be reported by sigil check, at the key', async () => {
    const ran = await spawnNode(cli, warn, ['check']);

    expect(ran.stderr).toMatch(location);
    // a warning does not fail a check
    expect(ran.code).toBe(0);
  });

  it('should be reported by sigil build, and not stop it', async () => {
    const out = tempDir('sigil-settings-warn-');
    const ran = await spawnNode(cli, warn, ['build', '--out', out]);

    expect(ran.stderr).toMatch(location);
    expect(ran.code, ran.stderr).toBe(0);
    expect(existsSync(join(out, 'settings-warn.mjs'))).toBe(true);
  }, 60_000);

  it('should not be reported for an app that passes none', async () => {
    const ran = await spawnNode(cli, app, ['check']);

    expect(ran.stderr).not.toContain('do not reach a built app');
    expect(ran.code).toBe(0);
  });
});
