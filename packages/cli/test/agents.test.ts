import { SITE_URL } from '../src/scaffold/agents.ts';
import { scaffold } from '../src/scaffold/index.ts';
import {
  callsIn,
  codeSpans,
  commandsIn,
  exportClaims,
  exportsOf,
  installedPathsIn,
  isToolchainCommand,
  PROPERTIES,
  resolves,
  ships,
  specifiersIn,
  workspacePackages,
} from './agent-text.ts';
import { docs, readGuide, root } from './guides.ts';
import { readFileSync } from 'node:fs';
import { join, posix } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * `packages/sigil/docs/agents.md`: the block a reader pastes into their own
 * `AGENTS.md` so that a coding agent uses sigil the way it is meant to be used.
 *
 * It is the one page whose reader cannot check it. A person who meets a wrong
 * export in a guide finds out when the import fails; an agent told to import a
 * name that is gone writes the import anyway, in somebody else's project, and
 * the error lands on them. So what it names has to exist, and this asks:
 *
 * - every `@ttylabs/...` specifier is one the package's `exports` answers, or a
 *   workspace package;
 * - every "`name` from `module`" is an export of that module, asked of the built
 *   package the way `the imports in the guides` asks;
 * - every other `name()` is an export of one of the modules the file names, or
 *   a property the file means rather than an export -- a short list, so that a
 *   function nobody exports cannot hide behind a call's parentheses;
 * - every path is one `sigil new` writes, and every `'./...'` in a code span is
 *   one the scaffold's `src/` holds, which is what the schema's `baseDir` makes
 *   it relative to;
 * - every `sigil <command>` is a command the toolchain has;
 * - every `node_modules/<package>/...` is a file that package ships, which is
 *   how the block points at the skills;
 * - and the only placeholders are the two the website fills, one of which
 *   `sigil new` fills too, with the same site.
 *
 * `sigil new` writes this block as a new app's `AGENTS.md`, so it is read in
 * an app that was never pasted into as well. The helpers are `agent-text.ts`,
 * which `skills.test.ts` asks the same questions of the skills with.
 *
 * What it does not check is that a sentence is still *true* -- that help really
 * lists both spellings of `'hello, hi'`, say. That is behaviour, and
 * `guides.test.ts` and the parser suite pin it far more closely than a check of
 * prose could; what rots silently in a block like this is a name.
 */

const markdown = readFileSync(join(docs, 'agents.md'), 'utf-8').replace(/\r\n/g, '\n');

/** Every code span, outside the placeholders. */
const spans = codeSpans(markdown);

/** What `sigil new` itself writes, which is the toolchain's own. */
const versions = (
  JSON.parse(readFileSync(join(root, 'packages/cli/package.json'), 'utf-8')) as {
    devDependencies: Record<string, string>;
  }
).devDependencies;

/**
 * Every path `sigil new` writes for an app with commands, in TypeScript, which is
 * the default, and in JavaScript, which the instructions name too.
 */
const scaffolded = (['ts', 'js'] as const).flatMap((language) =>
  scaffold({
    language,
    layout: 'multi',
    linter: 'oxlint',
    manager: 'npm',
    name: 'my-cli',
    version: '0.0.0',
    versions,
  }).map((file) => file.path)
);

/** A file the scaffold writes, or a directory one of them is in. */
function scaffolds(path: string): boolean {
  const bare = path.replace(/\/$/, '');
  return scaffolded.some((file) => file === bare || file.startsWith(`${bare}/`));
}

/** The placeholders `website/src/lib/includes.ts` fills, and no others. */
const PLACEHOLDERS = ['site', 'version'];

describe('the agent instructions', () => {
  const specifiers = specifiersIn(spans);

  it('should be included by the getting-started guide', () => {
    expect(readGuide('getting-started.md')).toMatch(/^<!-- include agents\.md\b/m);
  });

  it('should fill only the placeholders the website knows', () => {
    const used = [...new Set([...markdown.matchAll(/\{\{(\w+)\}\}/g)].map((match) => match[1]))];

    expect(used.toSorted()).toEqual(PLACEHOLDERS);
    // and nothing that looks half like one, which the website would print as is
    expect(markdown.replace(/\{\{\w+\}\}/g, '')).not.toMatch(/[{}]{2}/);
  });

  it('should name only modules that resolve', () => {
    const packages = workspacePackages();

    expect(specifiers.length).toBeGreaterThan(3);
    for (const specifier of specifiers) {
      if (packages.has(specifier)) {
        continue;
      }
      expect(resolves(specifier), specifier).toBe(true);
    }
  });

  it('should name only exports that the module it names has', async () => {
    const claims = exportClaims(markdown);

    expect(claims.length).toBeGreaterThan(3);
    for (const [name, specifier] of claims) {
      expect(Object.hasOwn(await exportsOf(specifier), name), `${specifier} exports ${name}`).toBe(
        true
      );
    }
  });

  it('should name only functions that something exports, or a property it means', async () => {
    // `@ttylabs/cli` is a bin with nothing to import, so it has no exports to ask
    const modules = await Promise.all(specifiers.filter(resolves).map(exportsOf));
    const calls = callsIn(spans);

    expect(calls.length).toBeGreaterThan(3);
    for (const name of calls) {
      expect(
        PROPERTIES.has(name) || modules.some((module) => Object.hasOwn(module, name)),
        `${name}() is exported by a module the instructions name`
      ).toBe(true);
    }
  });

  it('should name only paths that sigil new writes', () => {
    const paths = spans.filter((span) => /^[\w.-]+\/[\w./-]*$/.test(span));
    const relative = spans.flatMap((span) =>
      [...span.matchAll(/'(\.\/[\w./-]+)'/g)].map((match) => match[1]!)
    );

    expect(paths.length).toBeGreaterThan(2);
    expect(relative.length).toBeGreaterThan(1);
    for (const path of paths) {
      expect(scaffolds(path), path).toBe(true);
    }
    for (const path of relative) {
      expect(scaffolds(posix.join('src', path)), path).toBe(true);
    }
  });

  it('should name only commands the toolchain has', () => {
    const commands = commandsIn(spans);

    expect(commands.length).toBeGreaterThan(1);
    for (const command of commands) {
      expect(isToolchainCommand(command), command).toBe(true);
    }
  });

  it('should name only installed files that the package ships', () => {
    // the skills are reached through this block and nothing else, so a path
    // that moved, or a file the tarball left out, is a skill no agent finds
    const packages = workspacePackages();
    const installed = installedPathsIn(spans);

    expect(installed.length).toBeGreaterThan(1);
    for (const { name, path } of installed) {
      const pkg = packages.get(name);
      expect(pkg, name).toBeDefined();
      expect(ships(pkg!.dir, pkg!.files, path), `${name} ships ${path}`).toBe(true);
    }
  });

  it('should name the site the website is published on', () => {
    // `sigil new` fills `{{site}}` itself, and the website is a private app it
    // cannot import -- so the toolchain spells the domain too, and this is what
    // keeps the two spellings one
    const site = readFileSync(join(root, 'website/src/lib/site.ts'), 'utf-8');
    expect(/export const SITE_URL = '([^']+)'/.exec(site)?.[1]).toBe(SITE_URL);
  });
});
