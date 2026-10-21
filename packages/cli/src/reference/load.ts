/**
 * An app's schema, read by importing its entry.
 *
 * ## Why this imports where the rest of the build parses
 *
 * `sigil build` and `sigil check` parse an app's entry rather than importing
 * it, and that is a firm rule for a firm reason: a build must not run the app,
 * because a module is allowed to read a config file, open a connection or exit
 * at the top level and none of that is a build's business.
 *
 * A reference cannot be made that way. An option and an argument live **only**
 * inside the module that declares them -- `sigil build` lifts `desc` and
 * `hidden` and nothing lifts the rest, which is written down as the reason
 * `ResolvedCommand` has no options on it and as the reason a completion script
 * is generated from the live registries. So the choice is between importing the
 * app and having no reference, and the person who typed `sigil reference` has
 * asked for the first.
 *
 * Which is why it is **not** part of `sigil build`. The import is the whole of
 * the difference and it is the thing the build's own rule is about, so bolting
 * a reference onto the build -- even behind an opt-in key -- would make the
 * build a different kind of thing, inside a ticket about documentation. A
 * separate command is the honest shape: `sigil reference` runs the app once, on
 * purpose, and the build goes on parsing.
 *
 * ## The toolchain's runtime initializes the app's schema
 *
 * What crosses the boundary from the app is **plain data**: an entry exports an
 * object (or a function returning one), and `command()` is the identity
 * function, so a command module's declaration is plain data too. Nothing with
 * an `Internal` symbol on it is ever handed over, which is what makes this safe
 * -- `Internal` is a module-private `Symbol()`, so two copies of the runtime
 * cannot read each other's internals, and a design that passed an initialized
 * command across would be broken the moment an app pinned a different version.
 *
 * What a version skew does cost is that the toolchain's runtime is the one that
 * *interprets* the app's declaration. An app whose runtime is newer and declares
 * something this one refuses fails here and works there -- loudly, naming the
 * declaration, which is the same exposure `readAppCommands()` already has when
 * it reads a schema's shape. The shape if it ever matters is `typecheck.ts`'s:
 * resolve the capability from the app. There is no caller for that yet.
 */

import { displayPath } from '../build/diagnostic.ts';
import { discoverApp, type DiscoveredApp } from '../build/discover.ts';
import type { Schema } from '@ttylabs/sigil';
import { pathToFileURL } from 'node:url';

/** Where to find an app, and which entry to read. */
export interface LoadOptions {
  /** The app's root, defaulting to the working directory. */
  readonly cwd?: string;
  /** The entry to read, when the conventions find the wrong one. */
  readonly entry?: string;
}

/** An app, found and read. */
export interface LoadedApp {
  /** What was found on disk. */
  readonly app: DiscoveredApp;
  /** The schema its entry exported. */
  readonly schema: Schema;
}

/**
 * Reads the schema an entry module exports.
 *
 * The namespace is **spread** before anything is read off it, which is the rule
 * `generateBin()`'s own template records: `app.default ?? app.schema` is a
 * static reference to a named export the module need not have, and a bundler
 * resolves that at build time and warns that it will always be undefined.
 * Copying the namespace asks at run time, which is when the answer is known.
 *
 * A function is called, because a schema that reads the environment has to be
 * built rather than declared -- which is what the generated entry does with the
 * same two lines, so an app that works built works here.
 *
 * @param entry - The module.
 * @returns The schema.
 * @throws If the module exports nothing that can be a schema, which is an app
 *   `main()` could not have started either.
 */
async function schemaFrom(entry: string): Promise<Schema> {
  const namespace = { ...(await import(pathToFileURL(entry).href)) };
  const declared = namespace.default ?? namespace.schema;
  const schema = typeof declared === 'function' ? await declared() : declared;

  if (typeof schema !== 'object' || schema === null || Array.isArray(schema)) {
    throw new Error(
      `${displayPath(entry)} exports no schema: a sigil app's entry has a default export (or a "schema" export) that is the schema object, or a function returning one.`
    );
  }

  return schema as Schema;
}

/**
 * Finds an app and reads its schema.
 *
 * `discoverApp()` is the same finder `sigil check` and `sigil build` use, so
 * `--entry` means here exactly what it means there and an app this cannot find
 * is one none of them can.
 *
 * @param options - Where to look.
 * @returns The app and its schema.
 * @throws Whatever the discovery or the import threw.
 */
export async function loadAppSchema(options: LoadOptions = {}): Promise<LoadedApp> {
  const app = discoverApp(options.cwd ?? '.', { entry: options.entry });
  return { app, schema: await schemaFrom(app.entry) };
}
