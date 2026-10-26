/**
 * `sigil.json`: the one file the toolchain configures itself from.
 *
 * ## Why one file, and why not a `.ts` one
 *
 * There was already a `sigil.json` -- `sigil add` reads where ejected
 * components land, and `sigil new` writes it -- so the question a build option
 * raised was never "config file or flags" but "this file or a second one". Two
 * files answering for one tool is worse than a long script line.
 *
 * It stays `sigil.json`, and comments in it are read: `json()` reads a `.json`
 * as JSONC, so the extension costs nothing and nothing has to be renamed to
 * carry a comment. This repository's own is a commented `sigil.json`, which is
 * what makes the span writer dogfood rather than a feature with a test.
 * `sigil.jsonc` is read too, for an app that prefers the explicit name.
 *
 * A `next.config.ts`-shaped config was the other candidate and was left alone
 * for now. It has to be *executed*, and everything else this build does is
 * reading: the app's entry is parsed rather than imported precisely so that an
 * app which opens a connection at module scope does not do it during a build.
 * Running app-adjacent code would be a new surface, and none of the options
 * here needs computing -- every one of them is a literal. The day one of them
 * does is the day to revisit it, which is the rule `which` waited on.
 *
 * ## A flag beats the file
 *
 * The file says what this app is always built with; a flag says what this one
 * invocation wants. So `--no-sourcemap` on the command line wins over
 * `"sourcemap": true` in the file, and the file wins over the built-in default.
 */

import { createConfigSync, json, type ConfigLayer, type ConfigSchema } from '@ttylabs/sigil/config';
import { existsSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';

/**
 * The config file, which is `sigil.json` and may be `sigil.jsonc`.
 *
 * `.json` first and `sigil new` writes that one, because it is the name an app
 * already had and there is nothing left for the other extension to buy: one
 * reader serves both, so a comment in a `sigil.json` is read rather than
 * reported. `.jsonc` is still accepted for an app that prefers to say so in the
 * file name -- which is a preference rather than a declaration about the bytes,
 * since `tsconfig.json` is JSONC under a `.json` name too.
 *
 * Both at once is refused, naming them: with both there, picking one picks it by
 * the order this array happens to be written in and the other silently does
 * nothing.
 */
export const CONFIG_FILES = ['sigil.json', 'sigil.jsonc'] as const;

/** What `sigil new` writes and what every message names where there is no file. */
export const CONFIG_FILE: string = CONFIG_FILES[0];

/** What `sigil build` reads from the config. */
export interface BuildConfig {
  /**
   * Packages to import rather than inline.
   *
   * A native binding leaves no choice -- nothing inlines a `.node` -- and it
   * is the app saying its bundle is not self-contained, so it belongs beside
   * the app rather than in whoever happens to be typing the command.
   */
  readonly external?: readonly string[];
  /** What the executable is called, when the manifest's `bin` does not say. */
  readonly name?: string;
  /** Where the bundle goes, relative to the app. */
  readonly out?: string;
  /**
   * Utility classes to keep whatever the app's source says.
   *
   * The escape hatch style shaking needs and cannot do without: the scan is
   * evidence rather than proof, so a class assembled out of values that never
   * appear as literals in the source -- read from a config file, joined out of
   * an array that came from somewhere else -- leaves nothing behind and its
   * rule is dropped. This is how to say it anyway.
   */
  readonly safelist?: readonly string[];
  /**
   * Whether to shake the utility sheet. On by default.
   *
   * On by default because the sheet is opt-in already -- an app only pays for
   * it by calling `utilitySheet()` -- and because a build that quietly kept
   * everything is an optimization nobody notices is gone. Off is the blunt
   * answer for an app that would otherwise need a long safelist.
   */
  readonly shake?: boolean;
  /** Whether to write sourcemaps. */
  readonly sourcemap?: boolean;
}

/** What `sigil package` reads from the config. */
export interface PackageConfig {
  /**
   * Where the binaries go, relative to the app.
   *
   * Defaults to `release`, and deliberately does **not** fall back to
   * `build.out`. It did, on the reading that a package is the build plus a
   * step -- and that put the binaries in `dist` beside the bundle, where the
   * two commands destroyed each other's output, because `clean()` empties the
   * directory each one is given. A binary and a bundle are different artifacts
   * with different lifetimes, and `dist` is also what `files` usually ships.
   */
  readonly out?: string;
  /**
   * Which runtime the binary embeds.
   *
   * There is no default and this is the place to declare it: which runtime an
   * app ships on is a fact about the app rather than about the invocation, so
   * saying it here means every `sigil package` and every CI step agrees without
   * repeating a flag. `--runtime` still beats it.
   */
  readonly runtime?: string;
  /**
   * The `<platform>-<arch>` targets to build for.
   *
   * Defaults to the machine the build runs on. Only Bun can honour more than
   * one, because a Node single executable is built by injecting a blob into the
   * host's own `node`.
   */
  readonly target?: readonly string[];
}

/** What the update check looks at, as `sigil.json` declares it. */
export interface UpdateCheckConfig {
  /** `npm`: the dist tag to read. Defaults to `latest`. */
  readonly distTag?: string;
  /** `npm`: the package to ask about. Defaults to the app's manifest name. */
  readonly package?: string;
  /** `custom`: where the version sits in the JSON response, as a list of keys. */
  readonly path?: readonly string[];
  /** `github`: the release tag prefix to strip. Defaults to `v`. */
  readonly prefix?: string;
  /** `npm`: the registry to ask. Defaults to npm's. */
  readonly registry?: string;
  /** `github`: the repository, as `owner/name`. */
  readonly repo?: string;
  /**
   * Which kind of check this is.
   *
   * `none` is a declaration rather than an absence, and that distinction is
   * the whole of why this key is required: `sigil package` refuses a binary
   * that imports the update check and declares nothing, because an app
   * distributed as a download is one npm cannot answer for and guessing npm
   * would be a check that silently never reports anything. `none` is how an
   * app says it has thought about it -- because it checks nothing, or
   * because it passes a `checker` to `check()` in its own source, which
   * beats whatever is baked in.
   */
  readonly type?: string;
  /** `custom`: the `https` URL to GET. */
  readonly url?: string;
}

/** What `sigil reference` reads from the config. */
export interface ReferenceConfig {
  /**
   * Where the markdown pages go, relative to the app.
   *
   * Opt-in, which is the whole of what this key is for: `sigil reference` with
   * nowhere to put anything prints one document to stdout, so a destination
   * named here is how an app says "and this is where it lives" once instead of
   * in every invocation and every CI step.
   */
  readonly out?: string;
  /** Where the JSON snapshot of the command surface goes, relative to the app. */
  readonly snapshot?: string;
}

/** `sigil.json`, as it is on disk. */
export interface SigilConfig {
  readonly build?: BuildConfig;
  /** Where ejected components land, relative to the app. */
  readonly components?: string;
  /**
   * The locale the app falls back on when nothing else named one.
   *
   * Top level rather than under `build`, because it is a fact about the app
   * rather than a bundler knob: `"build": { "locale": ... }` would read as
   * *baking* a language in, which is a different thing that is deliberately
   * not done. What `sigil build` does with it is write `defaultLocale` into
   * the schema it generates, beside the version, because the runtime cannot
   * read this file -- reading one at startup is what `Schema.locales` being a
   * map rather than a directory convention exists to avoid.
   *
   * It is the bottom of the locale chain: `AppOptions.locale`, `SIGIL_LOCALE`,
   * `LC_ALL`, `LC_MESSAGES` and `LANG` all beat it, and it beats English. So
   * it says what the app ships in rather than overriding the user.
   *
   * Not validated as a locale tag here, because the runtime normalizes it and
   * a tag no catalog is keyed by already reads as English -- a second grammar
   * for BCP 47 in the toolchain would be one that disagrees with `Intl`.
   */
  readonly locale?: string;
  /**
   * What `sigil package` embeds, and what it builds for.
   *
   * A section of its own rather than keys under `build`, because the one thing
   * in it that has no default -- the runtime -- is a statement about what the
   * app ships on rather than about how it is bundled. `out` is the exception
   * and falls back to `build.out`, since the package is the build plus a step.
   */
  readonly package?: PackageConfig;
  /**
   * Where `sigil reference` writes, when the invocation does not say.
   *
   * Top level rather than under `build`, for the reason `locale` is: `build` is
   * where the bundler knobs live, and `sigil build` does not write a reference.
   * It cannot -- an option lives only inside the module that declares it, so a
   * reference means importing the app, which is the one thing the build refuses
   * by design. So this is read by one command, which is the shape `components`
   * already has.
   */
  readonly reference?: ReferenceConfig;
  /**
   * Where this app's update check looks, baked into what the build emits.
   *
   * Top level rather than under `build`, for the reason `locale` is: `build`
   * holds the bundler knobs, and this is a fact about the app that both
   * `sigil build` and `sigil package` carry into what they produce. It is
   * baked for the reason the version and the default locale are -- the
   * runtime cannot read this file -- and it reaches `check()` through a
   * `define` rather than through the schema, because `check()` is a function
   * an app calls wherever it likes and has no schema in its hand.
   *
   * Left out, an app that still needs a runtime installed asks npm about its
   * own package and a single-file executable checks nothing. That asymmetry
   * is the point: npm is the right answer for something somebody installed
   * and a guess for a binary somebody downloaded.
   */
  readonly updateCheck?: UpdateCheckConfig;
}

/** The fields each section may hold, as the one list `readSection()` picks by. */
const FIELDS = {
  build: ['external', 'name', 'out', 'safelist', 'shake', 'sourcemap'],
  package: ['out', 'runtime', 'target'],
  reference: ['out', 'snapshot'],
  updateCheck: ['distTag', 'package', 'path', 'prefix', 'registry', 'repo', 'type', 'url'],
} as const satisfies Record<string, readonly string[]>;

/**
 * What the file may hold, in the parser's own type vocabulary.
 *
 * Exported so that the write half can be tested against **this** declaration
 * rather than a copy of it: a round-trip test that re-declared the settings
 * would be asserting that the writer preserves a file nothing here reads.
 *
 * The acceptance test for `@ttylabs/sigil/config`, which is why it is a schema
 * rather than the hand-written reader it replaces: the types, the coercion and
 * the choices are the same ones an option declaration gets, so `"shake": "off"`
 * and `--no-shake` and `SHAKE=off` cannot come to mean three different things.
 *
 * What stays here is what the schema's vocabulary cannot say, and it is four
 * things rather than one: that `components` is relative to the app; that a name
 * or a list entry is non-empty, which `type: 'string'` accepts and is right to,
 * because `""` is an empty string somebody chose; that `build` is an object,
 * which a schema declaring settings by dotted path has no nested shape to say;
 * and which keys under `build` are `BuildConfig`'s, because the merged view
 * holds whatever the file holds and passing it through would hand back an object
 * with keys the type does not declare. The honest split: the schema does types,
 * and the semantic checks are this tool's own.
 */
export const CONFIG_SCHEMA: ConfigSchema = {
  'build.external': { multiple: true, type: 'string' },
  'build.name': { type: 'string' },
  'build.out': { type: 'string' },
  'build.safelist': { multiple: true, type: 'string' },
  'build.shake': { type: 'bool' },
  'build.sourcemap': { type: 'bool' },
  components: { type: 'string' },
  locale: { type: 'string' },
  'package.out': { type: 'string' },
  // a free string rather than `choices`, because the value is a *spec* --
  // `bun`, `node`, or either with an `@version` -- and a choice list cannot
  // express that. `parseSpec()` is the one reader, so the flag and the file are
  // still validated by the same code rather than by two lists
  'package.runtime': { type: 'string' },
  'package.target': { multiple: true, type: 'string' },
  'reference.out': { type: 'string' },
  'reference.snapshot': { type: 'string' },
  'updateCheck.distTag': { type: 'string' },
  'updateCheck.package': { type: 'string' },
  'updateCheck.path': { multiple: true, type: 'string' },
  // `""` is a real answer here and the one `githubChecker()` documents for
  // "the tag is the version", so this is the one name in the file that is not
  // run through `readName()`
  'updateCheck.prefix': { type: 'string' },
  'updateCheck.registry': { type: 'string' },
  'updateCheck.repo': { type: 'string' },
  'updateCheck.type': { choices: ['custom', 'github', 'none', 'npm'], type: 'string' },
  'updateCheck.url': { type: 'string' },
};

/**
 * The one layer this file is, named after whichever of the two it found.
 *
 * Two names and only one of them may exist, which is the two-routes-one-name
 * rule said about a config file: with both there, picking one picks it by the
 * order this array happens to be written in and the other silently does
 * nothing. So it is refused, naming both.
 *
 * @param root - The app root.
 * @returns The layer.
 * @throws If both files are there.
 */
function configLayer(root: string): ConfigLayer {
  const found = CONFIG_FILES.filter((name) => existsSync(join(root, name)));

  if (found.length > 1) {
    throw new Error(`${root} has both ${found.join(' and ')}; keep one.`);
  }

  // the `.json` one when there is neither, because that is the one `sigil new`
  // writes and the one a message should name
  const name = found[0] ?? CONFIG_FILE;

  // one reader for either extension, so there is nothing here that has to ask
  // which name it got -- the branch this replaces picked a strict reader for a
  // `.json`, which is the asymmetry the two stores collapsing removed
  return { name, store: json(join(root, name)) };
}

/**
 * Reads an app's `sigil.json`, if it has one.
 *
 * Validated on the way out rather than trusted: a config file is source the app
 * wrote, and an `"external": "rolldown"` where an array was meant should say so
 * here rather than reach rolldown as a string and mean something else.
 *
 * ## What the migration changed, and what it did not
 *
 * A file that is not there, one holding nothing, and one holding valid JSON
 * read exactly as before. Two things moved, and both are the shared vocabulary
 * arriving:
 *
 * A **string where a boolean was declared is now coerced** rather than refused.
 * The old reader's reason was that `"false"` is not `false` and coercing a typo
 * invents a setting nobody chose -- and `transformValue()`'s boolean vocabulary
 * is strict and symmetric, so `"nope"` still throws and there is no silent wrong
 * answer available. What is left is `"off"`, `"0"` and `"yes"` meaning in this
 * file what they already mean to `--shake=off` and to `SHAKE=off`, which is one
 * answer where there were two.
 *
 * And the **messages are the shared ones**, which is what sharing a validator
 * costs: `Invalid value for "build.sourcemap" in sigil.json: Invalid boolean`
 * rather than a sentence written here. They name the file, the setting and what
 * was wrong, which is what a message has to do.
 *
 * @param root - The app root.
 * @returns What the file said, or an empty config when there is none.
 * @throws If the file is not readable as the shape it claims.
 */
export function readSigilConfig(root: string): SigilConfig {
  // one layer, which is this file. The stack is what an *app* reaches for; the
  // toolchain has exactly one place its own settings live, and a second layer
  // would be a second place to look for an answer to one question
  const config = createConfigSync({ layers: [configLayer(root)], schema: CONFIG_SCHEMA });

  const build = readSection(config.get('build'), 'build');
  const components = readName(config.get('components'), 'components');
  const locale = readName(config.get('locale'), 'locale');
  const packaging = readSection(config.get('package'), 'package');
  const reference = readSection(config.get('reference'), 'reference');
  const updateCheck = readSection(config.get('updateCheck'), 'updateCheck');

  // the keys are set only where the file said something, so that a directory
  // with no file in it and a file holding `{}` are the same answer -- which they
  // are, and which the old reader distinguished only by returning early
  return {
    ...(build && { build: readBuild(build as BuildConfig) }),
    ...(components !== undefined && { components: readRelative(components, 'components') }),
    ...(locale !== undefined && { locale }),
    ...(packaging && { package: readPackage(packaging as PackageConfig) }),
    ...(reference && { reference: readReference(reference as ReferenceConfig) }),
    ...(updateCheck && { updateCheck: readUpdateCheck(updateCheck as UpdateCheckConfig) }),
  };
}

/**
 * One section of the file, which the schema's vocabulary cannot shape.
 *
 * A config schema declares settings by dotted path and deliberately has no
 * nested object shapes, so `build.external` is typed and `build` itself is not
 * -- which leaves `"build": []` as a mistake nothing would report. Declaring
 * `build` as well is not the way out: a setting whose path runs through another
 * setting's is refused where the schema is read, because the two would each
 * validate the other's value.
 *
 * So this is the same split `components` already takes: the schema does types,
 * and a check the vocabulary cannot say stays here.
 *
 * One function for both sections rather than one each, because the question is
 * the same one twice: is it an object, and which of its keys does this tool
 * declare. What differs between them is the semantic checks, which stay with
 * the section they are about.
 *
 * @param value - What the merged view holds at the section.
 * @param name - The section, which is both the message and the field list.
 * @returns The section's declared keys, or `undefined` where the file said
 *   nothing.
 * @throws If it is there and is not an object.
 */
function readSection(
  value: unknown,
  name: keyof typeof FIELDS
): Record<string, unknown> | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${CONFIG_FILE}: "${name}" must be an object`);
  }

  // the declared fields and nothing else, which is what the hand-written reader
  // did by naming each one. The merged view holds whatever the *file* holds, so
  // passing it through would hand back an object with keys `BuildConfig` does
  // not declare -- a value that lies about its own type, over a key that is
  // almost always a typo for one of the fields the section declares
  const held = value as Record<string, unknown>;
  const section: Record<string, unknown> = {};
  for (const field of FIELDS[name]) {
    if (Object.hasOwn(held, field)) {
      section[field] = held[field];
    }
  }

  return Object.keys(section).length > 0 ? section : undefined;
}

/**
 * A field the schema typed as a string and that may not be empty.
 *
 * `""` passes `type: 'string'` and is right to: the recorded rule is that a key
 * written `""` is an empty string somebody chose, where absent and `null` are
 * both not configured. What the data type cannot know is that none of these
 * fields has a use for one -- an empty `components` is not a directory and an
 * empty `locale` is not a tag.
 *
 * @param value - The value.
 * @param field - The field, for the message.
 * @returns The value, or `undefined` where the file said nothing.
 * @throws If it is there and empty.
 */
function readName(value: unknown, field: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!value) {
    throw new Error(`${CONFIG_FILE}: "${field}" must be a non-empty string`);
  }
  return value as string;
}

/**
 * The `components` field, which predates the rest of the file.
 *
 * Relative to the app, which is the other thing a data type cannot say: it is a
 * fact about what the field is *for* rather than about what kind of value it
 * is.
 *
 * @param value - The non-empty name.
 * @param field - The field, for the message.
 * @returns It, unchanged.
 * @throws If it is absolute.
 */
function readRelative(value: string, field: string): string {
  if (isAbsolute(value)) {
    throw new Error(`${CONFIG_FILE}: "${field}" must be relative to the app`);
  }
  return value;
}

/**
 * The `reference` section, whose two fields are both destinations.
 *
 * Relative to the app for `components`' own reason -- it is a fact about what
 * the field is *for* rather than about what kind of value it is -- and the
 * reason is sharper here: a reference is a committed artifact, so an absolute
 * path in the config would be one machine's answer written into a file every
 * machine reads.
 *
 * @param reference - What the merged view holds at `reference`.
 * @returns The section.
 * @throws If a destination is empty or absolute.
 */
function readReference(reference: ReferenceConfig): ReferenceConfig {
  for (const field of ['out', 'snapshot'] as const) {
    const value = readName(reference[field], `reference.${field}`);

    if (value !== undefined) {
      readRelative(value, `reference.${field}`);
    }
  }

  return reference;
}

/**
 * The `package` section, with the two checks the schema's vocabulary cannot
 * make.
 *
 * `runtime` is already narrowed by `choices` in the schema, so what is left is
 * the same non-emptiness every name here needs, plus the targets being names
 * rather than blanks. They are deliberately **not** parsed into targets here:
 * `parseTarget()` is where that vocabulary lives and where the error naming
 * every target is written, and a second reader of it in this file is a second
 * answer to what a target is.
 *
 * @param packaging - What the merged view holds at `package`.
 * @returns The section.
 * @throws If a name in it is empty.
 */
function readPackage(packaging: PackageConfig): PackageConfig {
  readName(packaging.out, 'package.out');
  readName(packaging.runtime, 'package.runtime');

  if (packaging.target?.some((target) => !target)) {
    throw new Error(`${CONFIG_FILE}: "package.target" must be an array of targets`);
  }

  return packaging;
}

/**
 * The `build` section, with the one field that has a rule of its own.
 *
 * Every type in here is the schema's now, so what is left is the same
 * non-emptiness the `components` field needs: a `""` passes `type: 'string'`
 * and is not a name anything can use.
 *
 * @param build - What the merged view holds at `build`.
 * @returns The section.
 * @throws If a name in it is empty.
 */
function readBuild(build: BuildConfig): BuildConfig {
  readName(build.name, 'build.name');
  readName(build.out, 'build.out');

  for (const [field, names, what] of [
    ['build.external', build.external, 'package names'],
    ['build.safelist', build.safelist, 'class names'],
  ] as const) {
    if (names?.some((name) => !name)) {
      throw new Error(`${CONFIG_FILE}: "${field}" must be an array of ${what}`);
    }
  }

  return build;
}

/**
 * The `updateCheck` section, whose fields each belong to one kind of check.
 *
 * The schema types the values and `choices` narrows the kind; what is left for
 * here is the thing a flat vocabulary cannot say -- which fields go with which
 * kind. A `repo` under `"type": "npm"` is almost always somebody who changed
 * the kind and left the old field behind, and taking it silently would bake a
 * check that looks at something the author stopped meaning. So a field that
 * does not belong to the declared kind is refused by name rather than ignored.
 *
 * `type` is required because the four kinds have no sensible default between
 * them: a section with fields and no kind is a half-written declaration, and
 * the one thing it must not quietly become is the npm check, which is what an
 * app gets for declaring nothing at all.
 *
 * @param updateCheck - What the merged view holds at `updateCheck`.
 * @returns The section.
 * @throws If the kind is missing, or a field does not belong to it.
 */
function readUpdateCheck(updateCheck: UpdateCheckConfig): UpdateCheckConfig {
  const { type } = updateCheck;

  if (!type) {
    throw new Error(
      `${CONFIG_FILE}: "updateCheck.type" is required; it is one of ${UPDATE_CHECK_FIELDS.map(
        ([name]) => `"${name}"`
      ).join(', ')}`
    );
  }

  const allowed = UPDATE_CHECK_FIELDS.find(([name]) => name === type)?.[1];
  // unreachable through the schema, whose `choices` has already refused
  // anything else -- kept because this list and that one are two places and
  // the failure of them disagreeing is a field silently going unchecked
  if (!allowed) {
    throw new Error(`${CONFIG_FILE}: "updateCheck.type" must be a known kind, got "${type}"`);
  }

  for (const field of FIELDS.updateCheck) {
    if (field === 'type' || updateCheck[field as keyof UpdateCheckConfig] === undefined) {
      continue;
    }
    if (!allowed.includes(field)) {
      throw new Error(
        `${CONFIG_FILE}: "updateCheck.${field}" does not belong to a "${type}" check`
      );
    }
    // `prefix` is left out on purpose: an empty one is how a GitHub check
    // says the tag is already the version
    if (field !== 'prefix' && field !== 'path') {
      readName(updateCheck[field as keyof UpdateCheckConfig], `updateCheck.${field}`);
    }
  }

  if (type === 'github' && !updateCheck.repo) {
    throw new Error(`${CONFIG_FILE}: a "github" check needs "updateCheck.repo"`);
  }

  if (type === 'custom' && (!updateCheck.url || !updateCheck.path?.length)) {
    throw new Error(
      `${CONFIG_FILE}: a "custom" check needs "updateCheck.url" and "updateCheck.path"`
    );
  }

  if (updateCheck.path?.some((key) => !key)) {
    throw new Error(`${CONFIG_FILE}: "updateCheck.path" must be an array of keys`);
  }

  return updateCheck;
}

/**
 * Which fields each kind of check declares.
 *
 * One list rather than a branch per kind, so that adding a field to a kind is
 * an edit in one place and a field belonging to no kind cannot exist.
 */
const UPDATE_CHECK_FIELDS: readonly (readonly [string, readonly string[]])[] = [
  ['custom', ['path', 'url']],
  ['github', ['prefix', 'repo']],
  ['none', []],
  ['npm', ['distTag', 'package', 'registry']],
];
