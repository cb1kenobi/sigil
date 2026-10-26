/**
 * What the build tells an app's update check to look at.
 *
 * `check()` is a function an app calls wherever it likes, so unlike the
 * version and the default locale there is no schema in its hand to bake this
 * into -- it reaches the runtime as a `define`, which is the one thing that
 * can replace a value inside a dependency the bundle inlined.
 *
 * Two facts go across and the second is the one the ticket is about. **What**
 * to check comes from `sigil.json`. **Whether there is a runtime to spawn**
 * comes from which command is running: `sigil build` produces an app that
 * still needs node or bun installed, and the default check spawns one so that
 * it outlives the CLI; `sigil package` produces an app that *is* its runtime,
 * where `process.execPath` is the app's own binary and spawning it would
 * re-execute the CLI. The build knows which it is making, so nothing has to
 * be sniffed at run time.
 */

import type { SigilConfig, UpdateCheckConfig } from '../config.ts';
import {
  githubChecker,
  npmChecker,
  type BakedUpdateConfig,
  type UpdateChecker,
} from '@ttylabs/sigil/updates';

/** The identifier `check()` reads the baked config out of. */
export const UPDATE_CHECK_DEFINE = '__SIGIL_UPDATE_CHECK__';

/** What `bakedUpdateCheck()` is given. */
export interface BakedUpdateCheckOptions {
  /** Whether what is being produced is a single-file executable. */
  readonly compiled: boolean;
  /** The app's `sigil.json`. */
  readonly config: SigilConfig;
  /** The app's own package name, which an npm check defaults to. */
  readonly packageName?: string;
}

/**
 * Turns `sigil.json`'s `updateCheck` into what the runtime reads.
 *
 * @param options - The config, the app's name, and which command is running.
 * @returns The baked config.
 * @throws If an npm check has no package name to ask about.
 */
export function bakedUpdateCheck(options: BakedUpdateCheckOptions): BakedUpdateConfig {
  const { compiled, config, packageName } = options;
  const declared = config.updateCheck;

  if (!declared) {
    // absent rather than `null`: an app that declared nothing falls through
    // to `check()`'s own default, which is npm where there is a runtime and
    // no check at all in a binary. `null` is the app saying it checks
    // nothing, which is a different answer and must not be invented here
    return { compiled };
  }

  return { checker: checkerFor(declared, packageName), compiled };
}

/**
 * The `define` entry the bundler is given.
 *
 * @param baked - What the build decided.
 * @returns The define map.
 */
export function updateCheckDefine(baked: BakedUpdateConfig): Record<string, string> {
  // `define` replaces an identifier with a snippet of *source*, so the value
  // is a JSON string literal rather than the JSON itself -- stringified twice
  // on purpose. Unbuilt, nothing replaces it and `check()` reads a free
  // identifier through `typeof`, which is the one operator that is legal on
  // a name nothing declared.
  return { [UPDATE_CHECK_DEFINE]: JSON.stringify(JSON.stringify(baked)) };
}

/**
 * One declared check, as the runtime's own builders make it.
 *
 * Built with `npmChecker()` and `githubChecker()` rather than with object
 * literals here, so that a URL this bakes and a URL an app builds in its own
 * source are the same URL -- the rule `readRoutes()` already records for the
 * two route walks, met in a smaller place.
 *
 * @param declared - The declared section, already validated by the reader.
 * @param packageName - The app's own name.
 * @returns The checker, or `null` where the app declared it checks nothing.
 * @throws If an npm check has no package name to ask about.
 */
function checkerFor(
  declared: UpdateCheckConfig,
  packageName: string | undefined
): UpdateChecker | null {
  switch (declared.type) {
    case 'none':
      return null;

    case 'github':
      return githubChecker({
        ...(declared.prefix !== undefined && { prefix: declared.prefix }),
        repo: declared.repo!,
      });

    case 'custom':
      return {
        path: declared.path!,
        type: 'custom',
        url: declared.url!,
      };

    default: {
      const name = declared.package ?? packageName;
      if (!name) {
        throw new Error(
          'An "npm" update check needs a package name: set "updateCheck.package" in sigil.json, ' +
            'or give the app\'s package.json a "name".'
        );
      }
      return npmChecker({
        ...(declared.distTag !== undefined && { distTag: declared.distTag }),
        packageName: name,
        ...(declared.registry !== undefined && { registryURL: declared.registry }),
      });
    }
  }
}

/** The subpath an app imports to check for updates. */
export const UPDATE_CHECK_SPECIFIER = '@ttylabs/sigil/updates';

/**
 * Refuses a binary whose update check could never report anything.
 *
 * A compiled app has no runtime to spawn and no npm default -- npm is the
 * right answer for something somebody installed and a guess for a binary
 * somebody downloaded, which may well not be published anywhere. So an app
 * that imports the check and declares nothing for it to look at ships a
 * feature that silently does nothing, which is the failure this whole area
 * keeps being about: a build reporting success over something that cannot
 * work.
 *
 * ## Why this one is not a pre-flight
 *
 * `assertCleanable()` is refused before a runtime is fetched because it is
 * pure path arithmetic -- it can be asked at any time, so it is asked first.
 * This cannot: whether the check is in the app is a question about the module
 * graph, and the graph does not exist until the bundle is built. So it is
 * asked at the first moment there is an answer, which still comes before
 * `compileAll()` -- the download is a cache fill and the compile is the
 * expensive, signing, binary-writing half.
 *
 * Guessing earlier was the alternative and is refused: a scan of the app's
 * source for the specifier reports a mention in a comment as a use and misses
 * one re-exported through a barrel, and a **false** refusal here stops a build
 * that is correct. This file already records what a warning that fires on
 * correct code teaches people to do, and an error is the louder version of it.
 *
 * @param config - The app's `sigil.json`.
 * @param used - Whether the bundle imported the update check.
 * @throws If it did and the config says nothing.
 */
export function assertUpdateCheckDeclared(config: SigilConfig, used: boolean): void {
  if (!used || config.updateCheck) {
    return;
  }

  throw new Error(
    `This app imports ${UPDATE_CHECK_SPECIFIER}, and a binary has no default to fall back on.\n` +
      'Declare "updateCheck" in sigil.json -- "npm", "github" or "custom" for where to look, ' +
      'or "none" to say it checks nothing here.\n' +
      "A `checker` passed to check() in the app's own source still beats whatever is declared, " +
      'so "none" is also how an app that does that says so.'
  );
}
