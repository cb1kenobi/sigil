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
import { bindingName, importBindings, type ImportBindings } from './bindings.ts';
import {
  literalBoolean,
  objectLiteral,
  outermostDeclaring,
  plainProperty,
  unwrapShallow,
} from './literals.ts';
import { parseModule } from './parse-module.ts';
import {
  githubChecker,
  npmChecker,
  type BakedUpdateConfig,
  type UpdateChecker,
} from '@ttylabs/sigil/updates';
import { readFileSync } from 'node:fs';
import type { Expression } from 'oxc-parser';

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

  // the manifest's name goes across whether or not anything was declared: an
  // automatic check has the program's name in hand and not the package's, and
  // `@ttylabs/cli` publishes `sigil`. The runtime cannot read a `package.json`
  // of its own -- a bundle has no manifest beside it
  const named = packageName === undefined ? {} : { packageName };

  if (!declared) {
    // absent rather than `null`: an app that declared nothing falls through
    // to `check()`'s own default, which is npm where there is a runtime and
    // no check at all in a binary. `null` is the app saying it checks
    // nothing, which is a different answer and must not be invented here
    return { compiled, ...named };
  }

  return { checker: checkerFor(declared, packageName), compiled, ...named };
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

/** What a schema's `updateCheck` says, read off its source. */
export type SchemaUpdateCheck =
  /** It switches the check on and says nothing about where to look. */
  | 'asks'
  /** It switches the check on and names the checker itself. */
  | 'names';

/** The checker builders an app may call in its schema. */
const CHECKER_BUILDERS = ['githubChecker', 'npmChecker'] as const;

/**
 * Whether a schema's `updateCheck` names its own checker.
 *
 * Three spellings do, and each is the app having said where to look: a
 * `checker` inside the options, a checker written bare -- the shorthand, as a
 * call to one of the builders or as a literal with a `type` and a `url` -- and
 * nothing else. The builder is asked as a **binding** rather than a spelling,
 * for the reason `findTemplates()` is: an alias is the same function and a
 * local called `githubChecker` is not.
 *
 * The call is asked first, and the order is load-bearing:
 * `objectLiteral()` looks through a call with one object-literal argument, so
 * `githubChecker({ repo })` would otherwise be read as the options `{ repo }`.
 */
function namesChecker(value: Expression, builders: readonly ImportBindings[]): boolean {
  const expression = unwrapShallow(value);

  if (
    expression.type === 'CallExpression' &&
    builders.some((bindings) => bindingName(expression.callee, bindings) !== undefined)
  ) {
    return true;
  }

  const options = objectLiteral(expression);
  if (!options) {
    return false;
  }

  return (
    plainProperty(options, 'checker') !== undefined ||
    (plainProperty(options, 'type') !== undefined && plainProperty(options, 'url') !== undefined)
  );
}

/**
 * What a schema says about the automatic update check, read off its source.
 *
 * `updateCheck` on the schema is the app asking for a check without importing
 * `@ttylabs/sigil/updates`, so the bundler's watch on that specifier never sees
 * it -- and a binary that asks for one and declares nothing for it to look at
 * is the failure this refuses. The schema is read rather than run, for the
 * reason every pass here reads: running the entry runs the app.
 *
 * It errs towards **not** refusing, because a false refusal stops a correct
 * build and a missed one costs a notice that never appears. Three things are
 * therefore read as "nothing to say": a key spelled in a way this cannot read
 * (computed, an accessor), a value that is literally `false`, and a value that
 * names its own checker -- which beats whatever `sigil.json` declares, so the
 * app has already said where to look.
 *
 * @param entry - The app's entry module.
 * @returns `'asks'` when some schema asks for a check that nothing says where
 *   to run, `'names'` when every schema that asks says where itself, and
 *   `undefined` when none asks.
 */
export function readSchemaUpdateCheck(entry: string): SchemaUpdateCheck | undefined {
  const parsed = parseModule(entry, readFileSync(entry, 'utf-8'));
  const builders = CHECKER_BUILDERS.map((name) =>
    importBindings(parsed, UPDATE_CHECK_SPECIFIER, name)
  );
  let result: SchemaUpdateCheck | undefined;

  for (const schema of outermostDeclaring(parsed.program as never, 'updateCheck')) {
    const property = plainProperty(schema, 'updateCheck');
    if (!property) {
      continue;
    }

    const value = property.value as Expression;
    if (literalBoolean(value as never) === false) {
      continue;
    }

    if (namesChecker(value, builders)) {
      result = 'names';
      continue;
    }

    return 'asks';
  }

  return result;
}

/**
 * Whether the schema asks for a check that nothing says where to run.
 *
 * @param entry - The app's entry module.
 * @returns Whether `readSchemaUpdateCheck()` answers `'asks'`.
 */
export function schemaWantsUpdateCheck(entry: string): boolean {
  return readSchemaUpdateCheck(entry) === 'asks';
}

/** Why a binary is being asked to declare what its update check looks at. */
export type UpdateCheckUse = 'import' | 'schema';

/**
 * Refuses a binary whose update check could never report anything.
 *
 * A compiled app has no runtime to spawn and no npm default -- npm is the
 * right answer for something somebody installed and a guess for a binary
 * somebody downloaded, which may well not be published anywhere. So an app
 * that asks for the check and declares nothing for it to look at ships a
 * feature that silently does nothing, which is the failure this whole area
 * keeps being about: a build reporting success over something that cannot
 * work.
 *
 * ## Why this one is not a pre-flight
 *
 * `assertCleanable()` is refused before a runtime is fetched because it is
 * pure path arithmetic -- it can be asked at any time, so it is asked first.
 * The import half of this cannot: whether the check is in the app is a
 * question about the module graph, and the graph does not exist until the
 * bundle is built. So it is asked at the first moment there is an answer,
 * which still comes before `compileAll()` -- the download is a cache fill and
 * the compile is the expensive, signing, binary-writing half.
 *
 * Guessing earlier was the alternative and is refused: a scan of the app's
 * source for the specifier reports a mention in a comment as a use and misses
 * one re-exported through a barrel, and a **false** refusal here stops a build
 * that is correct. This file already records what a warning that fires on
 * correct code teaches people to do, and an error is the louder version of it.
 *
 * @param config - The app's `sigil.json`.
 * @param use - How the app asked: by importing the check, or by switching it on
 *   in its schema. `false` when it did not ask.
 * @throws If it asked and the config says nothing.
 */
export function assertUpdateCheckDeclared(
  config: SigilConfig,
  use: boolean | UpdateCheckUse
): void {
  if (!use || config.updateCheck) {
    return;
  }

  const how =
    use === 'schema'
      ? 'This app sets updateCheck in its schema'
      : `This app imports ${UPDATE_CHECK_SPECIFIER}`;

  throw new Error(
    `${how}, and a binary has no default to fall back on.\n` +
      'Declare "updateCheck" in sigil.json -- "npm", "github" or "custom" for where to look, ' +
      'or "none" to say it checks nothing here.\n' +
      "A `checker` passed to check() in the app's own source still beats whatever is declared, " +
      'so "none" is also how an app that does that says so.'
  );
}
