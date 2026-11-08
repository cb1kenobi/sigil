import { readFileSync, statSync } from 'node:fs';
import { isBuiltin } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * What an import of a shipped entry costs, read off `dist/`.
 *
 * A module of its own rather than a function inside `dist.test.ts`, because the
 * audit SIG-328 made of every entry had to read the same graph the ceilings
 * read, and a test file cannot be imported from outside vitest -- its
 * `describe()` calls throw. So there is one definition, which that test and
 * `scripts/entry-cost.mjs` both import, rather than a second implementation of
 * "which modules does this entry pull in" for the two figures to disagree
 * through. It imports nothing but `node:` builtins, so node runs it as it is.
 */

/** The built package, which everything here reads. */
export const dist: string = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist');

/**
 * Every module a static `import` of `entry` would load, and nothing else.
 *
 * Static rather than every specifier, because the difference is the whole
 * point: `main()` reaches the parser and the help screen through `await
 * import()`, so neither is on the graph that importing the package costs. A
 * dynamic import is spelled `import(` and a static one is `import ... from"x"`
 * or `import"x"`, so the parenthesis is what tells them apart.
 *
 * @param entry - A bundle in `dir`, by its path relative to it.
 * @param dir - Where the bundles are: `dist/` unless an app's own build output
 * is being read, which is how SIG-328 asked what `sigil build` leaves an app.
 * @returns The bundles reachable from it without calling anything, by their
 * paths relative to `dir`.
 */
export function staticGraph(entry: string, dir: string = dist): Set<string> {
  const seen = new Set<string>();
  const queue = [entry];

  while (queue.length > 0) {
    const name = queue.shift() as string;
    if (seen.has(name)) {
      continue;
    }
    seen.add(name);

    const source = readFileSync(join(dir, name), 'utf8');
    for (const re of [/\bfrom\s*["'](\.\/[^"']+)["']/g, /\bimport\s*["'](\.\/[^"']+)["']/g]) {
      for (const [, spec] of source.matchAll(re)) {
        // relative to the importer, which in `dist/` is always the same
        // directory and in an app's output is not: the entry sits above
        // `chunks/`, so its `./chunks/x.mjs` and a chunk's `./y.mjs` name two
        // different directories' files
        queue.push(join(dirname(name), spec as string));
      }
    }
  }

  return seen;
}

/**
 * The bytes of every module in a graph, which is what an unbundled app reads.
 *
 * @param graph - What `staticGraph()` returned.
 * @param dir - The directory it was read from.
 * @returns The sum of the files' sizes.
 */
export function graphBytes(graph: Set<string>, dir: string = dist): number {
  return [...graph].reduce((n, name) => n + statSync(join(dir, name)).size, 0);
}

/**
 * The node builtins a graph imports statically, which is to say at load.
 *
 * The specifier is read in the form the minifier writes -- `from"node:zlib"`,
 * double quoted with no space -- and that is a decision rather than laziness:
 * `updates.mjs` carries the update worker baked in as text, and the worker's
 * own `from 'node:https'` is in a string literal, single quoted, where it loads
 * nothing. A looser pattern reads it as an import of the chunk that holds it.
 * A `process.getBuiltinModule()` or an `import()` is not a static import, so
 * neither is here, which is the point: they are what this exists to tell apart.
 *
 * @param graph - What `staticGraph()` returned.
 * @param dir - The directory it was read from.
 * @returns The builtins, sorted, each spelled with its `node:` prefix.
 */
export function staticBuiltins(graph: Set<string>, dir: string = dist): string[] {
  const found = new Set<string>();

  for (const name of graph) {
    const source = readFileSync(join(dir, name), 'utf8');
    for (const [, spec] of source.matchAll(/\b(?:from|import)"([^".][^"]*)"/g)) {
      if (isBuiltin(spec as string)) {
        found.add((spec as string).startsWith('node:') ? (spec as string) : `node:${spec}`);
      }
    }
  }

  return [...found].sort();
}
