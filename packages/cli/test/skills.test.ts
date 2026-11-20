import {
  anchorsOf,
  callsIn,
  codeSpans,
  commandsIn,
  exportClaims,
  exportsOf,
  installedPathsIn,
  isToolchainCommand,
  linksIn,
  PROPERTIES,
  resolves,
  ships,
  specifiersIn,
  workspacePackages,
} from './agent-text.ts';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, posix, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The agent skills the packages ship, under `skills/<name>/SKILL.md`.
 *
 * An agent reaches one at `node_modules/<package>/skills/<name>/SKILL.md`,
 * pointed there by the app's `AGENTS.md` and, later, by a coded error message.
 * So it is read from the installed tarball and nowhere else -- which decides
 * most of what is asked here:
 *
 * - its front matter is what the Agent Skills format requires, since that is
 *   what an agent matches the skill on;
 * - every link is relative and lands on a file the same tarball holds, with any
 *   fragment one of that file's headings. `src/` and `test/` are not in it, and
 *   a link to the website would describe whichever version the site is on
 *   rather than the one installed;
 * - and every name it gives is checked the way `agents.test.ts` checks the
 *   block: an export, a module, a command, an installed file.
 *
 * Which packages ship one is a rule rather than a list somebody remembers: the
 * runtime and the toolchain, because both are installed in every app and they
 * cover two different moments of working on one. A package gets a skill when it
 * raises a coded diagnostic of its own, and adding one means adding it to
 * `SKILLS` -- `should ship exactly the skills it declares` notices one that
 * was not.
 */

/** The skills each package ships, by package name. */
const SKILLS: Readonly<Record<string, readonly string[]>> = {
  '@ttylabs/cli': ['sigil-cli'],
  '@ttylabs/sigil': ['sigil'],
};

const packages = workspacePackages();

/** Every skill, with where it is. */
const skills = Object.entries(SKILLS).flatMap(([pkg, names]) =>
  names.map((name) => {
    const { dir, files } = packages.get(pkg)!;
    return { dir, files, name, pkg, skill: join(dir, 'skills', name) };
  })
);

/** The markdown files in a skill's directory, relative to it. */
function markdownFiles(skill: string): string[] {
  return readdirSync(skill, { encoding: 'utf8', recursive: true })
    .filter((file) => file.endsWith('.md'))
    .map((file) => file.split(sep).join('/'))
    .sort();
}

function read(path: string): string {
  return readFileSync(path, 'utf-8').replace(/\r\n/g, '\n');
}

/**
 * A `SKILL.md`'s front matter, as its keys and values. Every value the format
 * takes is a string on one line, so a line is a key.
 */
function frontMatter(markdown: string): Map<string, string> {
  const block = /^---\n([\s\S]*?)\n---\n/.exec(markdown)?.[1];
  if (block === undefined) {
    throw new Error('no front matter');
  }
  return new Map(
    block.split('\n').map((line) => {
      const match = /^([\w-]+):[ \t]*(.*)$/.exec(line);
      if (!match) {
        throw new Error(`not a key: ${line}`);
      }
      return [match[1]!, match[2]!.replace(/^(['"])(.*)\1$/, '$2')];
    })
  );
}

describe('the agent skills', () => {
  it('should ship exactly the skills it declares', () => {
    const found = [...packages].flatMap(([pkg, { dir }]) =>
      existsSync(join(dir, 'skills'))
        ? readdirSync(join(dir, 'skills'))
            // a `.DS_Store` is the file system's, not a skill
            .filter((name) => !name.startsWith('.'))
            .map((name) => `${pkg}:${name}`)
        : []
    );

    expect(found.toSorted()).toStrictEqual(
      skills.map(({ name, pkg }) => `${pkg}:${name}`).toSorted()
    );
  });

  describe.each(skills.map((skill) => [`${skill.pkg} ${skill.name}`, skill] as const))(
    '%s',
    (_label, { dir, files, name, skill }) => {
      const main = read(join(skill, 'SKILL.md'));
      const spans = markdownFiles(skill).flatMap((file) => codeSpans(read(join(skill, file))));

      it('should have the front matter the skill format asks for', () => {
        const meta = frontMatter(main);

        expect([...meta.keys()].toSorted()).toStrictEqual(['description', 'name']);
        // the name is the directory's, in lowercase letters, digits and hyphens
        expect(meta.get('name')).toBe(name);
        expect(name).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
        expect(name.length).toBeLessThanOrEqual(64);
        // what an agent matches on to decide whether to read the rest
        const description = meta.get('description')!;
        expect(description.length).toBeGreaterThan(50);
        expect(description.length).toBeLessThanOrEqual(1024);
        expect(description).not.toMatch(/[<>]/);
      });

      it('should be in the tarball, every file of it', () => {
        for (const file of markdownFiles(skill)) {
          const path = posix.join('skills', name, file);
          expect(ships(dir, files, path), path).toBe(true);
        }
      });

      it('should link only to what the tarball holds, at a heading that is there', () => {
        let count = 0;
        for (const file of markdownFiles(skill)) {
          const from = join(skill, file);
          for (const link of linksIn(read(from))) {
            count++;
            expect(link, `${file}: ${link} is relative`).not.toMatch(/^(?:[a-z][\w+.-]*:|\/)/i);

            const [path, fragment] = link.split('#') as [string, string | undefined];
            const target = path === '' ? from : join(dirname(from), path);
            const inside = relative(dir, target).split(sep).join('/');

            expect(inside, `${file}: ${link} stays in the package`).not.toMatch(/^\.\./);
            expect(ships(dir, files, inside), `${file}: ${link} is shipped`).toBe(true);
            if (fragment !== undefined) {
              expect(target, `${file}: ${link} has a fragment only into markdown`).toMatch(/\.md$/);
              expect(
                anchorsOf(read(target)).has(fragment),
                `${file}: ${link} names a heading`
              ).toBe(true);
            }
          }
        }
        expect(count).toBeGreaterThan(0);
      });

      it('should name only modules that resolve', () => {
        for (const specifier of specifiersIn(spans)) {
          expect(packages.has(specifier) || resolves(specifier), specifier).toBe(true);
        }
      });

      it('should name only exports that the module it names has', async () => {
        for (const file of markdownFiles(skill)) {
          for (const [name, specifier] of exportClaims(read(join(skill, file)))) {
            expect(
              Object.hasOwn(await exportsOf(specifier), name),
              `${file}: ${specifier} exports ${name}`
            ).toBe(true);
          }
        }
      });

      it('should name only functions that something it names exports', async () => {
        const modules = await Promise.all(specifiersIn(spans).filter(resolves).map(exportsOf));
        for (const call of callsIn(spans)) {
          expect(
            PROPERTIES.has(call) || modules.some((module) => Object.hasOwn(module, call)),
            `${call}() is exported by a module the skill names`
          ).toBe(true);
        }
      });

      it('should name only commands the toolchain has', () => {
        for (const command of commandsIn(spans)) {
          expect(isToolchainCommand(command), command).toBe(true);
        }
      });

      it('should name only installed files that the package ships', () => {
        for (const { name: pkg, path } of installedPathsIn(spans)) {
          const target = packages.get(pkg);
          expect(target, pkg).toBeDefined();
          expect(ships(target!.dir, target!.files, path), `${pkg} ships ${path}`).toBe(true);
        }
      });
    }
  );
});
