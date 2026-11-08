import config from '../tsdown.config.js';
import { dist, shippedModules, staticGraph } from './static-graph.js';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * `@ttylabs/sigil/components/<name>`, one per module, held to the directory.
 *
 * SIG-330 published a subpath per component beside the barrel, and every one of
 * them is a name an app can import and so can never quietly change. The rule is
 * mechanical, which is what lets this be a test rather than a review comment:
 * every module in `src/components/` has a subpath named after its file, except
 * the ones in `INTERNAL`; each subpath is a facade in `subpaths/` exporting what
 * the barrel publishes from that module; and the barrel is `export *` over the
 * facades -- so `@ttylabs/sigil/components` is the union of its subpaths and
 * nothing else. A module added without a subpath, or a subpath left behind by a module
 * that went, fails here naming itself. The reasoning is under "A subpath per
 * component" in `src/components/AGENTS.md`.
 *
 * The first half reads the source and the manifest; the second reads `dist/`, so
 * it needs a build first, like `dist.test.ts`.
 */

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const components = join(root, 'src', 'components');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf-8')) as {
  exports: Record<string, { default: string; types: string } | string>;
};

/**
 * Modules in `src/components/` with no subpath, each with the reason.
 *
 * A list rather than a rule, so that the next one is a decision somebody makes.
 * `spinner-frames` is the long tail of spinner sets, which ships in the registry
 * for `sigil add` to copy and is imported by nothing in `src/`, so that no app
 * pays for a set it did not ask for (SIG-183): a subpath would publish it.
 */
const INTERNAL = new Set(['spinner-frames']);

/** Every module in the directory, by file name without `.ts`, the barrel aside. */
const modules = readdirSync(components)
  .filter((file) => file.endsWith('.ts') && file !== 'index.ts')
  .map((file) => file.slice(0, -'.ts'.length))
  .sort();

/** Every `./components/<name>` subpath the manifest publishes, by `<name>`. */
const subpaths = Object.keys(pkg.exports)
  .filter((key) => key.startsWith('./components/'))
  .map((key) => key.slice('./components/'.length))
  .sort();

/** Every facade in `src/components/subpaths/`, which is what each subpath exports. */
const facades = readdirSync(join(components, 'subpaths'))
  .filter((file) => file.endsWith('.ts'))
  .map((file) => file.slice(0, -'.ts'.length))
  .sort();

/** Every specifier the barrel re-exports from inside the directory. */
const barrelled = [
  ...readFileSync(join(components, 'index.ts'), 'utf-8').matchAll(/\bfrom '(\.\/[^']+)'/g),
]
  .map(([, spec]) => spec as string)
  .sort();

describe('a subpath per component', () => {
  it('should publish a subpath for every module in src/components', () => {
    const missing = modules.filter((name) => !INTERNAL.has(name) && !subpaths.includes(name));

    expect(
      missing,
      'a module with no subpath: add "./components/<name>" to the exports map, or put it in INTERNAL with the reason'
    ).toEqual([]);
  });

  it('should publish no subpath without a module behind it', () => {
    expect(subpaths.filter((name) => !modules.includes(name))).toEqual([]);
  });

  it('should publish nothing it lists as internal', () => {
    // the escape hatch above is not a way to hide a public module: what is in
    // it has no subpath and the barrel does not export it
    for (const name of INTERNAL) {
      expect(modules, name).toContain(name);
      expect(subpaths, name).not.toContain(name);
      expect(facades, name).not.toContain(name);
    }
  });

  it('should write each subpath as a facade over the one module it is named after', () => {
    // a facade, rather than the module itself as the entry, because an entry's
    // every export is published and a module exports what its siblings share:
    // `addDays()` for the date prompt, the path prompt's segment helpers,
    // nineteen values in all that the barrel never published. So a subpath
    // exports what the barrel exports from that module and nothing more
    expect(facades).toEqual(subpaths);
    for (const name of facades) {
      const source = readFileSync(join(components, 'subpaths', `${name}.ts`), 'utf-8');
      const specs = [...source.matchAll(/\bfrom '([^']+)'/g)].map(([, spec]) => spec);

      expect(specs.length, name).toBeGreaterThan(0);
      expect(new Set(specs), name).toEqual(new Set([`../${name}.js`]));
      // re-exports only, so the facade adds no code of its own to a bundle
      expect(source.replaceAll(/export \{[^}]*\} from '[^']+';/g, '').trim(), name).toBe('');
    }
  });

  it('should be the union of the subpaths, so the barrel exports nothing a subpath does not', () => {
    // so that every name `@ttylabs/sigil/components` exports can be reached from
    // a subpath, and an app moving to subpaths never keeps the barrel for one
    // leftover helper. The theme is the one re-export from outside the
    // directory, and is `@ttylabs/sigil/theme`
    expect(barrelled).toEqual(subpaths.map((name) => `./subpaths/${name}.js`).sort());
  });

  it('should name each subpath after its file, and point it at its own build output', () => {
    for (const name of subpaths) {
      expect(name).toMatch(/^[a-z][a-z0-9-]*$/);
      expect(pkg.exports[`./components/${name}`]).toEqual({
        types: `./dist/components/${name}.d.mts`,
        default: `./dist/components/${name}.mjs`,
      });
    }
  });

  it('should build each subpath from its own module', () => {
    // `tsdown.config.ts` reads these off the manifest, so the two cannot drift
    // apart -- asked anyway, since a config that stopped reading them would
    // build none and `exports.test.ts` would report it as a missing entry
    // rather than as this
    const entry = config.entry as Record<string, string>;
    const built = Object.keys(entry)
      .filter((key) => key.startsWith('components/'))
      .sort();

    expect(built).toEqual(subpaths.map((name) => `components/${name}`));
    for (const name of subpaths) {
      expect(entry[`components/${name}`]).toBe(`./src/components/subpaths/${name}.ts`);
    }
  });
});

describe('a subpath per component, as built', () => {
  it.each(subpaths)('should ship a bundle and its declarations for %s', (name) => {
    expect(existsSync(join(dist, 'components', `${name}.mjs`)), `${name}.mjs`).toBe(true);
    expect(existsSync(join(dist, 'components', `${name}.d.mts`)), `${name}.d.mts`).toBe(true);
  });

  it('should export from the barrel the very bindings the subpaths export', async () => {
    // the property "shared, not copied" comes down to for an app: one module
    // instance behind both spellings, so a `PromptError` thrown by a prompt
    // imported one way is `instanceof` the class imported the other, and a
    // live region mounted through a subpath is the one the barrel's components
    // evict. A copy of a component in each would pass every name check and
    // fail this
    const barrel = (await import(pathToFileURL(join(dist, 'components.mjs')).href)) as Record<
      string,
      unknown
    >;
    const theme = (await import(pathToFileURL(join(dist, 'theme.mjs')).href)) as Record<
      string,
      unknown
    >;
    const reached = new Set<string>();

    for (const name of subpaths) {
      const sub = (await import(
        pathToFileURL(join(dist, 'components', `${name}.mjs`)).href
      )) as Record<string, unknown>;
      for (const [key, value] of Object.entries(sub)) {
        expect(barrel[key], `${key} from components/${name}`).toBe(value);
        reached.add(key);
      }
    }

    // and the barrel has nothing else but what it re-exports from the theme,
    // which has a subpath of its own
    const rest = Object.keys(barrel).filter((key) => !reached.has(key));
    expect(rest.length).toBeGreaterThan(0);
    for (const key of rest) {
      expect(barrel[key], `${key} is on the barrel and on no subpath`).toBe(theme[key]);
    }
  });

  // One definition of each piece of the stack every component is drawn with --
  // the element tree, the signal graph -- in one shipped file that every subpath
  // reaches, rather than a copy inside each subpath's own bundle. A message
  // thrown from each is the marker, since a string literal survives the
  // minifier and a name does not
  it.each(['An element cannot contain itself', 'A Computed may not read itself'])(
    'should ship %s once, in a chunk the subpaths share',
    (marker) => {
      const carriers = shippedModules().filter((name) =>
        readFileSync(join(dist, name), 'utf8').includes(marker)
      );

      expect(carriers).toHaveLength(1);
      for (const name of ['spinner', 'prompt', 'progress']) {
        expect([...staticGraph(`components/${name}.mjs`)], name).toContain(carriers[0]);
      }
    }
  );

  it.each(['MountOptions', 'StyledOptions', 'Key', 'PromptOptions'])(
    'should declare %s in one .d.mts, rather than in each subpath that uses it',
    (type) => {
      // what the declaration build does with a type several subpaths use: it
      // goes in a shared declaration chunk the way shared code goes in a shared
      // chunk, so the declarations an editor loads for two subpaths are not two
      // copies of the stack's types
      const declares = new RegExp(`\\binterface ${type}\\b`);
      const files = readdirSync(dist, { recursive: true, encoding: 'utf8' }).filter(
        (name) => name.endsWith('.d.mts') && declares.test(readFileSync(join(dist, name), 'utf8'))
      );

      expect(files, type).toHaveLength(1);
    }
  );
});
