import { scaffold } from '../src/scaffold/index.ts';
import { docs, readGuide, root } from './guides.ts';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, posix } from 'node:path';
import { pathToFileURL } from 'node:url';
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
 * - and the only placeholders are the two the website fills.
 *
 * What it does not check is that a sentence is still *true* -- that help really
 * lists both spellings of `'hello, hi'`, say. That is behaviour, and
 * `guides.test.ts` and the parser suite pin it far more closely than a check of
 * prose could; what rots silently in a block like this is a name.
 */

const require = createRequire(import.meta.url);
const markdown = readFileSync(join(docs, 'agents.md'), 'utf-8').replace(/\r\n/g, '\n');

/** Every code span, outside the placeholders. */
const spans = [...markdown.matchAll(/`([^`\n]+)`/g)].map((match) => match[1]!);

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

/**
 * Names written with parentheses that are a declaration's own property rather
 * than anything a module exports. Each one is here on purpose.
 */
const PROPERTIES: ReadonlySet<string> = new Set([
  // a command's handler
  'run',
]);

/** The placeholders `website/src/lib/includes.ts` fills, and no others. */
const PLACEHOLDERS = ['site', 'version'];

/** The workspace's package names. */
function workspacePackages(): Set<string> {
  return new Set(
    ['sigil', 'cli', 'config-xml', 'config-yaml'].map(
      (dir) =>
        (
          JSON.parse(readFileSync(join(root, 'packages', dir, 'package.json'), 'utf-8')) as {
            name: string;
          }
        ).name
    )
  );
}

/** Whether a specifier is one this package can import. */
function resolves(specifier: string): boolean {
  try {
    require.resolve(specifier);
    return true;
  } catch {
    return false;
  }
}

async function exportsOf(specifier: string): Promise<Record<string, unknown>> {
  return (await import(pathToFileURL(require.resolve(specifier)).href)) as Record<string, unknown>;
}

describe('the agent instructions', () => {
  const specifiers = [...new Set(spans.filter((span) => span.startsWith('@ttylabs/')))];

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
    const claims = [...markdown.matchAll(/`(\w+)(?:\(\))?` from `(@ttylabs\/[\w/-]+)`/g)];

    expect(claims.length).toBeGreaterThan(3);
    for (const [, name, specifier] of claims) {
      expect(
        Object.hasOwn(await exportsOf(specifier!), name!),
        `${specifier} exports ${name}`
      ).toBe(true);
    }
  });

  it('should name only functions that something exports, or a property it means', async () => {
    // `@ttylabs/cli` is a bin with nothing to import, so it has no exports to ask
    const modules = await Promise.all(specifiers.filter(resolves).map(exportsOf));
    const calls = spans.flatMap((span) => /^(\w+)\(\)$/.exec(span)?.[1] ?? []);

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
    const commands = spans.flatMap((span) => /^sigil (\w+)/.exec(span)?.[1] ?? []);

    expect(commands.length).toBeGreaterThan(1);
    for (const command of commands) {
      expect(existsSync(join(root, 'packages/cli/src/commands', `${command}.ts`)), command).toBe(
        true
      );
    }
  });
});
