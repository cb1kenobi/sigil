import { readdirSync, readFileSync, statSync } from 'node:fs';
import { isBuiltin } from 'node:module';
import { dirname, join, posix, sep } from 'node:path';
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
 * Every bundle in `dir`, by its path relative to it, subdirectories included.
 *
 * Recursive because the component subpaths are built into `dist/components/`
 * (SIG-330): a scan of the top level alone would pass a check over every
 * shipped file -- raw control characters, a marker that must be nowhere --
 * while skipping fifty-odd of them.
 *
 * @param dir - Where the bundles are.
 * @returns Their paths, `/`-separated whatever the platform, so that they read
 * the way `staticGraph()` names the same files.
 */
export function shippedModules(dir: string = dist): string[] {
  return readdirSync(dir, { recursive: true, encoding: 'utf8' })
    .filter((name) => name.endsWith('.mjs'))
    .map((name) => name.split(sep).join('/'))
    .sort();
}

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
    for (const re of [/\bfrom\s*["'](\.\.?\/[^"']+)["']/g, /\bimport\s*["'](\.\.?\/[^"']+)["']/g]) {
      for (const [, spec] of source.matchAll(re)) {
        // relative to the importer, which is not always the same directory: a
        // component subpath sits in `dist/components/` and reaches the chunks
        // above it as `../x.mjs`, and in an app's output the entry sits above
        // `chunks/`, so its `./chunks/x.mjs` and a chunk's `./y.mjs` name two
        // different directories' files. Joined as a URL path is, `/` on every
        // platform, so that one bundle is one name however it was reached
        queue.push(posix.join(posix.dirname(name), spec as string));
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
 * `updates.mjs` carries the update worker baked in as text, so the worker's own
 * `import { readFileSync, writeFileSync } from 'node:fs'` sits in that chunk
 * inside a string literal, single quoted, where it loads nothing. It happens to
 * name a builtin the chunk also imports for real, so today a looser pattern
 * would give the same answer -- which is why `dist.test.ts` asks the question
 * of a module written for it rather than of the shipped one. A
 * `process.getBuiltinModule()` or an `import()` is not a static import, so
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
