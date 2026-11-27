/**
 * The agent skill `sigil reference --skill` writes for an app (SIG-720).
 *
 * The fixture's skill is committed under `fixtures/annotated-app/skills/`, and
 * `--check` comparing against it is the snapshot: the input is the app's own
 * command modules and the expectation is the committed file, so neither is
 * derived from the other.
 */

import { skillFiles, skillName } from '../src/reference/skill.ts';
import { linkedFixture } from './copy-fixture.ts';
import { expectSkillFrontMatter, frontMatter } from './skill-format.ts';
import { run as spawnNode } from './spawned.ts';
import { tempDir } from './temp.ts';
import type { Schema } from '@ttylabs/sigil';
import { commandSurface } from '@ttylabs/sigil/reference';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const cli = resolve(here, '../src/sigil.ts');
const app = join(here, 'fixtures', 'annotated-app');
const skill = join(app, 'skills', 'annotated-app');

/**
 * A copy of the fixture app with its own manifest and no committed skill, with
 * `@ttylabs/sigil` linked in so that it loads as the fixture does in place.
 */
function copyApp(manifest: Record<string, unknown>): string {
  const dir = linkedFixture(app, 'sigil-skill-');
  rmSync(join(dir, 'skills'), { force: true, recursive: true });
  writeFileSync(join(dir, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  return dir;
}

/** The SKILL.md for an app. */
async function skillOf(schema: Schema, opts?: { schemaCommand?: boolean }): Promise<string> {
  return skillFiles(await commandSurface({ name: 'mycli', ...schema }), opts)[0]!.body;
}

describe('an app skill', () => {
  it("should be what the fixture's commands declare, which is the committed skill", async () => {
    const ran = await spawnNode(cli, app, ['reference', '--skill', '--check']);

    expect(ran.stderr, 'run `sigil reference --skill` in the fixture').not.toContain('error:');
    expect(ran.code).toBe(0);
  });

  it('should fail the check when the skill is missing, and say how to write it', async () => {
    const empty = tempDir('sigil-skill-empty-');

    const ran = await spawnNode(cli, app, ['reference', '--skill', '--out', empty, '--check']);
    expect(ran.code).toBe(1);
    expect(ran.stderr).toContain('Missing from the command reference');
    expect(ran.stderr).toContain('sigil reference --skill --out');
  });

  it('should have the front matter the skill format asks for, held as the shipped skills are', () => {
    expectSkillFrontMatter(readFileSync(join(skill, 'SKILL.md'), 'utf8'), 'annotated-app');
  });

  it('should link only to the files it holds', () => {
    const body = readFileSync(join(skill, 'SKILL.md'), 'utf8');
    const links = [...body.matchAll(/\]\(([^)]+)\)/g)].map((m) => m[1]!);

    expect(links.length).toBeGreaterThan(0);
    for (const link of links) {
      expect(readFileSync(join(skill, link), 'utf8').length, link).toBeGreaterThan(0);
    }
  });

  it('should list what running each command does', () => {
    const body = readFileSync(join(skill, 'SKILL.md'), 'utf8');

    expect(body).toContain('| `annotated-app status` | Show the status | read-only, idempotent |');
    expect(body).toContain('| `annotated-app wipe` | Delete everything | **destructive** |');
    expect(body).toContain('| `annotated-app plain` | Declares nothing about what it does | -- |');
  });

  it('should be the markdown reference, next to it, rather than a second printer', async () => {
    const { referenceDocument } = await import('../src/reference/markdown.ts');
    const surface = await commandSurface({ name: 'mycli', commands: { go: { run() {} } } });
    expect(skillFiles(surface)[1]).toEqual({
      body: referenceDocument(surface),
      file: 'reference.md',
    });
  });

  describe('what it says', () => {
    it("should point at the app's schema command, unless the app turned it off or has its own", async () => {
      const commands = { go: { run() {} } };

      expect(await skillOf({ commands })).toContain('`mycli schema` prints every command');
      expect(await skillOf({ commands }, { schemaCommand: false })).not.toContain('mycli schema');
      // an app's own `schema` takes the word, as an app's own `completion` does
      expect(await skillOf({ commands: { ...commands, schema: { run() {} } } })).not.toContain(
        '`mycli schema` prints every command'
      );
    });

    it('should say how to get JSON only where a command offers it', async () => {
      const plain = await skillOf({ commands: { go: { run() {} } } });
      const json = await skillOf({ commands: { go: { format: true, run() {} } } });

      expect(plain).not.toContain('--json');
      expect(plain).not.toContain('how to get JSON');
      expect(json).toContain('with `--json`');
      expect(json).toContain('how to get JSON out of it');
    });

    it('should describe the program in its own words, on one line and without angle brackets', async () => {
      const body = await skillOf({
        commands: { go: { run() {} } },
        desc: 'Ship <things>\nto places.',
      });
      expect(frontMatter(body).get('description')).toMatch(
        /^mycli: Ship things to places\. Use it to run mycli/u
      );
    });

    it('should write the description as YAML a real parser reads back, whatever the app said', async () => {
      const controls = String.fromCharCode(0x7f, 0x85);
      const body = await skillOf({
        commands: { go: { run() {} } },
        desc: `[draft] Deploy: "fast" # not a comment, from C:\\temp ${controls}& *done`,
      });

      expect(body).toMatch(/^description: "/mu);
      // DEL and C1 are dropped rather than written: YAML refuses them raw even
      // in quotes, and JSON leaves them raw
      expect(frontMatter(body).get('description')).toMatch(
        /^mycli: \[draft\] Deploy: "fast" # not a comment, from C:\\temp & \*done\. Use it/u
      );
    });

    it('should leave out a hidden command and a namespace, which nobody runs', async () => {
      const body = await skillOf({
        commands: {
          db: { commands: { migrate: { run() {} } } },
          secret: { hidden: true, run() {} },
        },
      });
      expect(body).toContain('`mycli db migrate`');
      expect(body).not.toContain('`mycli db` |');
      expect(body).not.toContain('secret');
    });
  });

  it.each([
    ['mycli', 'mycli'],
    ['@acme/Deploy_Tool', 'acme-deploy-tool'],
    ['---', 'cli'],
    ['x'.repeat(80), 'x'.repeat(64)],
  ])('should name the skill for %s as %s', (program, name) => {
    expect(skillName(program)).toBe(name);
  });

  describe('publishing it', () => {
    it("should warn where the app's files leave the skill out", async () => {
      const dir = copyApp({
        dependencies: { '@ttylabs/sigil': '*' },
        files: ['dist'],
        name: 'annotated-app',
        type: 'module',
      });

      const ran = await spawnNode(cli, dir, ['reference', '--skill']);
      expect(ran.code, ran.stderr).toBe(0);
      expect(ran.stderr).toContain('"files" does not include skills/annotated-app');
    });

    it('should say nothing where files covers it, or where there is no files list', async () => {
      const covered = copyApp({
        dependencies: { '@ttylabs/sigil': '*' },
        files: ['dist', 'skills'],
        name: 'annotated-app',
        type: 'module',
      });
      const open = copyApp({
        dependencies: { '@ttylabs/sigil': '*' },
        name: 'annotated-app',
        type: 'module',
      });

      for (const dir of [covered, open]) {
        const ran = await spawnNode(cli, dir, ['reference', '--skill']);
        expect(ran.code, ran.stderr).toBe(0);
        expect(ran.stderr).not.toContain('"files"');
      }
    });
  });

  it('should refuse to be asked for two artifacts at once', async () => {
    const ran = await spawnNode(cli, app, ['reference', '--skill', '--json-schema']);
    expect(ran.code).toBe(1);
    expect(ran.stderr).toContain('Choose one of --json, --json-schema and --skill');
  });
});
