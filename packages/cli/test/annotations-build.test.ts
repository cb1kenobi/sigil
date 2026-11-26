/**
 * A command's annotations survive `sigil build` (SIG-718).
 *
 * They are declared in each command's module, and a built app's `schema`
 * command loads every module the way the source does, so nothing is baked --
 * which is the claim this test exists to hold: the built app and the source
 * print the same document, annotations and all.
 */

import { run as spawnNode } from './spawned.ts';
import { tempDir } from './temp.ts';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const cli = resolve(here, '../src/sigil.ts');
const app = join(here, 'fixtures', 'annotated-app');

describe('annotations through a build', () => {
  const out = tempDir('sigil-annotations-build-');
  const builds = {
    built: { cwd: out, file: join(out, 'annotated-app.mjs') },
    source: { cwd: app, file: join(app, 'dev.mjs') },
  };

  beforeAll(async () => {
    const built = await spawnNode(cli, app, ['build', '--out', out]);

    expect(built.code, built.stderr).toBe(0);
    expect(existsSync(builds.built.file)).toBe(true);
    // declared in the modules, so the build has nothing to warn about
    expect(built.stderr).not.toContain('does not carry');
  }, 60_000);

  /** What `annotated-app schema` prints, for one of the two. */
  async function schema(kind: keyof typeof builds): Promise<string> {
    const ran = await spawnNode(builds[kind].file, builds[kind].cwd, ['schema']);
    expect(ran.code, ran.stderr).toBe(0);
    return ran.stdout;
  }

  it('should print what each module declares, in MCP terms', async () => {
    const doc = JSON.parse(await schema('source'));
    const byName = Object.fromEntries(
      doc.commands.map((cmd: { annotations?: unknown; path: string[] }) => [
        cmd.path.join(' '),
        cmd.annotations,
      ])
    );

    expect(byName).toEqual({
      plain: undefined,
      status: { idempotentHint: true, readOnlyHint: true },
      wipe: { destructiveHint: true },
    });
  });

  it('should print the same document built as from source', async () => {
    expect(await schema('built')).toBe(await schema('source'));
  });
});
