// What the build knew about the app that the app cannot work out for itself:
// whether it is a single-file executable, and what it was told to check.
//
// Both answers are baked rather than sniffed, because the build is the thing
// that knows them: `sigil build` produces an app that still needs a runtime
// installed, and `sigil package` produces one that is its own runtime. A
// runtime probe is kept underneath as a backstop for a binary something else
// compiled, and the reason it is worth having is in `compiledHost()`.

import type { UpdateChecker } from './checker.js';

/**
 * What `sigil build` and `sigil package` bake in, as the build saw it.
 *
 * Reached through a `define` rather than through the schema, because `check()`
 * is a function an app calls wherever it likes and has no schema to read --
 * where the version and the default locale are baked into the schema literal
 * precisely because that is what `main()` is handed.
 */
export interface BakedUpdateConfig {
  /**
   * What the app declared, `null` when it declared that it checks nothing,
   * and absent when it declared nothing at all.
   *
   * Those are three different answers and the third is not the second: an app
   * that said nothing gets the npm default where it can have one, and an app
   * that said `"type": "none"` gets no check anywhere.
   */
  readonly checker?: UpdateChecker | null;
  /** Whether the app is a single-file executable. */
  readonly compiled: boolean;
  /**
   * What the app's manifest calls the package.
   *
   * Baked because the program's name and its package's name are different
   * facts -- `@ttylabs/cli` publishes `sigil` -- and an automatic check has
   * only the first in its hand. The runtime cannot read a `package.json` of
   * its own: a bundle has no manifest beside it.
   */
  readonly packageName?: string;
}

/**
 * The identifier `sigil build` replaces, declared so this module can read it.
 *
 * It is never declared at run time: a build substitutes the whole expression
 * for a string literal, and an app that was never built leaves it a free
 * identifier -- which is why every read of it goes through `typeof`, the one
 * operator an undeclared name is legal under.
 */
declare const __SIGIL_UPDATE_CHECK__: string | undefined;

/**
 * What the build baked in, or `undefined` when nothing did.
 *
 * @returns The baked config, or `undefined` when the app was not built.
 */
export function bakedConfig(): BakedUpdateConfig | undefined {
  if (typeof __SIGIL_UPDATE_CHECK__ !== 'string') {
    return undefined;
  }

  try {
    const parsed: unknown = JSON.parse(__SIGIL_UPDATE_CHECK__);
    if (parsed && typeof parsed === 'object') {
      return parsed as BakedUpdateConfig;
    }
  } catch {}

  // a baked value that will not parse is this build's own bug rather than the
  // app's, and the honest answer is the one an unbuilt app gets rather than a
  // throw out of an update check nobody asked to be fatal
  return undefined;
}

/**
 * Whether this process is a single-file executable.
 *
 * Asked of the build first, because the build is what knows. The probes
 * underneath are for a binary produced by something other than
 * `sigil package`, and they are worth their fifteen lines for one reason:
 * inside an executable `process.execPath` is **the app's own binary**, so the
 * ordinary path would spawn the CLI again rather than a runtime. Answering
 * "not compiled" wrongly is not a check that fails, it is an app that
 * re-executes itself.
 *
 * @returns Whether there is no separate runtime to spawn.
 */
export async function compiledHost(): Promise<boolean> {
  if (bakedConfig()?.compiled) {
    return true;
  }

  // Bun's compiled binaries serve the app out of a virtual filesystem, so the
  // entry's own path is the tell -- measured against Bun 1.4.4, where
  // `Bun.main` is `/$bunfs/root/<name>` compiled and the real path otherwise
  const bun = (globalThis as { Bun?: { main?: string } }).Bun;
  if (bun) {
    const main = bun.main;
    return (
      typeof main === 'string' && (main.startsWith('/$bunfs/') || main.startsWith('B:\\~BUN\\'))
    );
  }

  // `node:sea` is Node's own answer and does not exist on Bun at all, which is
  // why it is asked second and inside a `try`: importing it there throws
  // `ERR_UNKNOWN_BUILTIN_MODULE`
  try {
    const sea = (await import('node:sea')) as { isSea?: () => boolean };
    return sea.isSea?.() === true;
  } catch {
    return false;
  }
}
