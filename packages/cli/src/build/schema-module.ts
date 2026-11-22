/**
 * Which module holds an app's schema, read off source and never run.
 *
 * Every pass that reads the schema -- the command tree, the catalogs, the
 * `settings` a warning describes, the update-check checks -- used to read the
 * **entry** module, so an app that kept its schema in a file of its own and
 * imported it into the entry was read as an app with no schema: the update
 * checks stayed silent, and the command tree said `no "commands" found`. This is
 * the one function that says where the schema is, so that none of them follows
 * an import its own way (SIG-566).
 *
 * ## What it follows
 *
 * What the **generated entry** reads, first, because that is the schema the
 * built app has: `import * as app from <entry>` is spread and `default ?? schema`
 * is taken, so the entry's default export, then its `schema` export. Where either
 * is an import -- `export { default } from './schema.js'`, or `import schema
 * from './schema.js'; export default schema` -- the schema is in that file, and
 * a re-export in _that_ file is followed in turn.
 *
 * An entry that exports neither is an app run from source by its own `main()`
 * call, and there the object passed to `main()` is the schema: `main({ schema })`
 * and `main({ schema: x })` when the name is an import. (A bare `main(x)` is read
 * the same way: the entry says the same thing about where the schema is.)
 *
 * ## What it gives up on
 *
 * Anything it cannot read for certain answers the **entry**, which is what every
 * reader did before: a package import, a specifier nothing answers to, a
 * namespace import, a module that does not parse, a cycle, an `export *`
 * that may supply the name, a `main()` call whose schemas are in two files. That
 * is the direction the whole build errs in -- a missed schema is a check that
 * does not run, and a wrong one is a check run over the wrong file -- and it is
 * why a local const, a call and an object literal are all the entry itself:
 * they are the schema where it is written.
 *
 * The bundle and the generated entry do not change. `schemaModule` in
 * `generateBin()` is still the entry, which is what the built app imports, and
 * this only decides which file a reader opens.
 */

import { importBindings, importedAs, bindingName } from './bindings.ts';
import { EXTENSIONS, resolveSpecifier, RUNTIME } from './discover.ts';
import { plainProperty, unwrapShallow } from './literals.ts';
import { parseModule, type ParsedModule } from './parse-module.ts';
import { walk } from './walk.ts';
import { readFileSync } from 'node:fs';
import { dirname, extname } from 'node:path';
import type { Expression } from 'oxc-parser';

/** Where a name one module exports turned out to be written. */
type Hop =
  /** The module does not export it. */
  | { readonly kind: 'absent' }
  /** It is written in this file. */
  | { readonly file: string; readonly kind: 'in' }
  /** It is exported, and not by a route this reads. */
  | { readonly kind: 'unreadable' };

const ABSENT: Hop = { kind: 'absent' };
const UNREADABLE: Hop = { kind: 'unreadable' };

/**
 * Reads a module, or says it cannot be.
 *
 * @param file - The file.
 * @returns The module, or `undefined` for one that is not a script this reads
 *   or does not parse.
 */
function read(file: string): ParsedModule | undefined {
  if (!EXTENSIONS.includes(extname(file))) {
    return undefined;
  }

  try {
    return parseModule(file, readFileSync(file, 'utf-8'));
  } catch {
    return undefined;
  }
}

/**
 * Follows an import from the module that wrote it.
 *
 * @param from - The module holding the specifier.
 * @param specifier - What it wrote.
 * @param name - The export it asked for.
 * @param seen - Every `file:name` pair this walk has asked, which is what ends a cycle.
 * @returns Where the export is written.
 */
function follow(from: string, specifier: string, name: string, seen: Set<string>): Hop {
  const file = resolveSpecifier(dirname(from), specifier);
  if (file === undefined) {
    return UNREADABLE;
  }

  const hop = exportedFrom(file, name, seen);
  // an import of a name the module does not export is an error somebody else reports
  return hop.kind === 'absent' ? UNREADABLE : hop;
}

/**
 * Where a module's export is written, following re-exports.
 *
 * @param file - The module.
 * @param name - The export, `default` for the default one.
 * @param seen - Every `file:name` pair this walk has asked.
 * @returns The file that writes it.
 */
function exportedFrom(file: string, name: string, seen: Set<string>): Hop {
  const key = `${file}\0${name}`;
  if (seen.has(key)) {
    return UNREADABLE;
  }
  seen.add(key);

  const parsed = read(file);
  if (!parsed) {
    return UNREADABLE;
  }

  let star = false;

  for (const declaration of parsed.module.staticExports) {
    for (const entry of declaration.entries) {
      if (entry.isType) {
        continue;
      }

      if (entry.exportName.kind === 'None' && entry.importName.kind === 'AllButDefault') {
        star = true;
        continue;
      }

      const exported = entry.exportName.kind === 'Default' ? 'default' : entry.exportName.name;
      if (exported !== name) {
        continue;
      }

      // `export { default } from './x.js'`, and an import that oxc has already
      // folded into a re-export (`import x from './x.js'; export { x }`)
      if (entry.moduleRequest) {
        return entry.importName.kind === 'Name' && entry.importName.name
          ? follow(file, entry.moduleRequest.value, entry.importName.name, seen)
          : UNREADABLE;
      }

      // `export default schema` and `export { schema as default }`, where the
      // name may be an import
      const local = entry.localName.name;
      const imported = local ? importedAs(parsed, local) : undefined;
      if (imported) {
        return imported.name === '*'
          ? UNREADABLE
          : follow(file, imported.specifier, imported.name, seen);
      }

      return { file, kind: 'in' };
    }
  }

  // `export * from` supplies every name but `default`, so it may be the one asked for
  return star && name !== 'default' ? UNREADABLE : ABSENT;
}

/**
 * What each of an entry's `main()` calls hands over as the schema.
 *
 * `main({ schema })` and `main({ schema: x })` are the call, and a bare
 * `main(x)` is read as naming the schema the same way. A call that passes no
 * schema (`main({ argv })`) says nothing and is left out.
 *
 * @param parsed - The entry.
 * @returns A local name for each call that names one, and `undefined` for each
 *   whose schema is not a name -- written in the call, computed, or hidden by a
 *   spread -- which is a schema this cannot follow to another file.
 */
function mainSchemas(parsed: ParsedModule): (string | undefined)[] {
  const mains = importBindings(parsed, RUNTIME, 'main');
  if (!mains.direct.size && !mains.namespaces.size) {
    return [];
  }

  const names: (string | undefined)[] = [];
  walk(parsed.program, (node) => {
    if (node.type !== 'CallExpression' || bindingName(node.callee, mains) === undefined) {
      return true;
    }

    const first = node.arguments[0];
    if (!first) {
      return true;
    }
    if (first.type === 'SpreadElement') {
      names.push(undefined);
      return true;
    }

    const argument = unwrapShallow(first as Expression);
    let written: Expression | undefined = argument;

    if (argument.type === 'ObjectExpression') {
      written = plainProperty(argument, 'schema')?.value as Expression | undefined;

      // `main({ argv })` hands over no schema, and a spread or a computed key may
      if (!written) {
        const hidden = argument.properties.some(
          (property) => property.type === 'SpreadElement' || property.computed
        );
        if (hidden) {
          names.push(undefined);
        }
        return true;
      }
    }

    const value = unwrapShallow(written);
    names.push(value.type === 'Identifier' ? value.name : undefined);
    return true;
  });

  return names;
}

/** Where an app's schema is written, and how that was learned. */
export interface FoundSchema {
  /** The file the schema is written in. */
  readonly file: string;
  /**
   * Whether the entry reached it only through a `main()` call, and exports no
   * schema of its own.
   *
   * A built app imports the entry for a `default` or `schema` export, so such an
   * entry builds an app that stops at start with `This app's entry exports no
   * schema`. The readers follow it anyway, since it is what the entry says, and
   * the caller says the rest.
   */
  readonly viaMain: boolean;
}

/**
 * Where an app's schema is written.
 *
 * @param entry - The app's entry module, as discovery found it.
 * @returns The file, which is `entry` itself wherever the schema is written
 *   there or cannot be followed for certain.
 */
export function findSchema(entry: string): FoundSchema {
  const here: FoundSchema = { file: entry, viaMain: false };
  const parsed = read(entry);
  if (!parsed) {
    return here;
  }

  // what the generated entry takes: `default ?? schema`, in that order
  for (const name of ['default', 'schema']) {
    const hop = exportedFrom(entry, name, new Set());
    if (hop.kind !== 'absent') {
      return hop.kind === 'in' ? { file: hop.file, viaMain: false } : here;
    }
  }

  // no export, so the app starts itself and the object `main()` is given is it
  const files = new Set<string>();
  for (const name of mainSchemas(parsed)) {
    const imported = name === undefined ? undefined : importedAs(parsed, name);
    if (!imported) {
      files.add(entry);
      continue;
    }

    const hop =
      imported.name === '*'
        ? UNREADABLE
        : follow(entry, imported.specifier, imported.name, new Set());
    if (hop.kind !== 'in') {
      return here;
    }
    files.add(hop.file);
  }

  // two schemas in two files is a choice this cannot make for the app
  const [file] = files;
  return files.size === 1 && file !== entry ? { file: file!, viaMain: true } : here;
}

/**
 * The module that holds an app's schema.
 *
 * @param entry - The app's entry module, as discovery found it.
 * @returns The file the schema is written in, or `entry`; see `findSchema()`.
 */
export function schemaModule(entry: string): string {
  return findSchema(entry).file;
}
