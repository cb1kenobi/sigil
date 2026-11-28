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
 * ## It follows only a module that does nothing but forward
 *
 * A module that imports the schema and then does something to it -- `Object.assign(
 * schema, { commands })` in the entry -- has written part of the schema itself, and
 * the file it came from is no longer all of it. Such an app builds and runs
 * today, so every module the walk passes through has to be imports, re-exports,
 * `export default name` (through `satisfies`, `as` or `<T>`) and type declarations
 * (and, for the entry, the `main()`
 * call), and one that is anything else is where the walk stops and answers the
 * entry.
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

import {
  calleeName,
  importBindings,
  importCall,
  importedAs,
  type ImportBindings,
} from './bindings.ts';
import { EXTENSIONS, resolveSpecifier, RUNTIME } from './discover.ts';
import { bindingObject, literalOf, plainProperty, propertyKey, unwrapShallow } from './literals.ts';
import { parseModule, type ParsedModule } from './parse-module.ts';
import { walk } from './walk.ts';
import { readFileSync } from 'node:fs';
import { dirname, extname } from 'node:path';
import type { Expression, ObjectExpression, Statement } from 'oxc-parser';

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
 * The name an `export default` hands on, looking through the type syntax a
 * TypeScript file puts around it.
 *
 * `export default schema satisfies Schema`, `schema as Schema` and
 * `<Schema>schema` all erase to `export default schema`, so they forward the
 * same name. A wrapper around anything that is not a bare name says nothing about
 * where the schema is, and answers `undefined`.
 *
 * @param statement - A statement of the module's body.
 * @returns The name, or `undefined` when the statement is not an `export default`
 *   of one.
 */
function defaultName(statement: Statement): string | undefined {
  if (statement.type !== 'ExportDefaultDeclaration') {
    return undefined;
  }

  // a function or class declaration is not an expression, and is not a name
  const declared = unwrapShallow(statement.declaration as Expression);
  return declared.type === 'Identifier' ? declared.name : undefined;
}

/**
 * Whether a module does nothing but hand on what it imports.
 *
 * Imports, re-exports, `export default name` (see `defaultName()`), type declarations and -- where the
 * caller is following a `main()` call -- the call itself. None of those can
 * assign to the schema or write a second one, so the schema the module forwards
 * is the schema the file it came from wrote. Anything else can: `Object.assign(
 * schema, { commands })` in the entry is how an app that builds today adds the
 * very key a reader looks for, and following past it reads the wrong file.
 *
 * **Every module the statements load has to be one being followed**, because an
 * import evaluates its module whatever it binds: `import './patch.js'`,
 * `export { ready } from './setup.js'` and `import { type T } from './patch.ts'`
 * all run a file that may change the schema. A type-only import or re-export is
 * erased and is let through, and so is the runtime, which cannot know the schema.
 *
 * @param parsed - The module.
 * @param followed - The specifiers the walk is following out of this module.
 * @param mains - Where `main` is imported, to let its calls through; `undefined`
 *   lets none.
 * @returns Whether every statement is one of those.
 */
function forwardsOnly(
  parsed: ParsedModule,
  followed: ReadonlySet<string>,
  mains?: ImportBindings
): boolean {
  const loads = (source: { readonly value: string }, kind: string | undefined): boolean =>
    kind === 'type' || source.value === RUNTIME || followed.has(source.value);

  return parsed.program.body.every((statement) => {
    switch (statement.type) {
      case 'EmptyStatement':
      case 'TSInterfaceDeclaration':
      case 'TSTypeAliasDeclaration':
        return true;
      case 'ExportAllDeclaration':
        return loads(statement.source, statement.exportKind);
      case 'ImportDeclaration':
        return loads(statement.source, statement.importKind);
      case 'ExportNamedDeclaration':
        return statement.source
          ? loads(statement.source, statement.exportKind)
          : !statement.declaration ||
              statement.declaration.type === 'TSInterfaceDeclaration' ||
              statement.declaration.type === 'TSTypeAliasDeclaration';
      case 'ExportDefaultDeclaration':
        return defaultName(statement) !== undefined;
      case 'ExpressionStatement': {
        // a directive such as 'use strict'
        if ('directive' in statement && statement.directive) {
          return true;
        }
        if (!mains) {
          return false;
        }
        let call = unwrapShallow(statement.expression as Expression);
        if (call.type === 'AwaitExpression') {
          call = unwrapShallow(call.argument as Expression);
        }
        return importCall(call, [mains]) !== undefined;
      }
      default:
        return false;
    }
  });
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
        return entry.importName.kind === 'Name' &&
          entry.importName.name &&
          forwardsOnly(parsed, new Set([entry.moduleRequest.value]))
          ? follow(file, entry.moduleRequest.value, entry.importName.name, seen)
          : UNREADABLE;
      }

      // `export default schema` and `export { schema as default }`, where the
      // name may be an import. `export default schema satisfies Schema` has no
      // local name of its own: the declaration is an expression, and what it
      // wraps is read off the statement
      const local =
        entry.localName.name ??
        (exported === 'default' ? parsed.program.body.map(defaultName).find(Boolean) : undefined);
      const imported = local ? importedAs(parsed, local) : undefined;
      if (imported) {
        return imported.name === '*' || !forwardsOnly(parsed, new Set([imported.specifier]))
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
    if (node.type !== 'CallExpression' || calleeName(node.callee, mains) === undefined) {
      return true;
    }

    const first = node.arguments[0];
    if (!first) {
      return true;
    }
    // a second argument is evaluated whatever `main()` does with it
    if (first.type === 'SpreadElement' || node.arguments.length > 1) {
      names.push(undefined);
      return true;
    }

    const argument = unwrapShallow(first as Expression);
    let written: Expression | undefined = argument;

    if (argument.type === 'ObjectExpression') {
      // `main()` reads the **last** `schema` key and a spread may bring one, where
      // `plainProperty()` takes the first: two ways to say it are not read
      const keyed = argument.properties.filter(
        (property) => property.type !== 'SpreadElement' && propertyKey(property) === 'schema'
      );
      if (
        keyed.length > 1 ||
        argument.properties.some((property) => property.type === 'SpreadElement')
      ) {
        names.push(undefined);
        return true;
      }

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

/**
 * The object literals a module hands the app as its schema, written in the module.
 *
 * The same places the generated entry and `findSchema()` read: `export default`,
 * `export { x as default }`, the `schema` export, and the argument of a `main()`
 * call -- the object itself or its `schema` key -- each a literal, a one-argument
 * call over one, or a `const` of the module holding one. It says where a schema
 * **is** and not whether it is the only one, which is what lets a reader claim an
 * accessor of `commands` there and nowhere else, since a helper literal with a
 * method of that name is not a schema (SIG-734).
 *
 * @param parsed - The module.
 * @returns The literals, in source order.
 */
export function exportedLiterals(parsed: ParsedModule): ObjectExpression[] {
  const roots: Expression[] = [];
  const literals: ObjectExpression[] = [];
  const add = (node: Expression | undefined): void => {
    if (!node) {
      return;
    }

    const value = unwrapShallow(node);
    const literal =
      value.type === 'Identifier' ? bindingObject(parsed, value.name, true) : literalOf(node, true);
    if (literal && !literals.includes(literal)) {
      literals.push(literal);
    }
  };

  for (const statement of parsed.program.body) {
    if (statement.type === 'ExportDefaultDeclaration') {
      roots.push(statement.declaration as Expression);
    } else if (statement.type === 'ExportNamedDeclaration') {
      for (const declarator of statement.declaration?.type === 'VariableDeclaration'
        ? statement.declaration.declarations
        : []) {
        if (declarator.id.type === 'Identifier' && declarator.id.name === 'schema') {
          roots.push(declarator.init as Expression);
        }
      }

      for (const specifier of statement.source ? [] : statement.specifiers) {
        const exported = specifier.exported as { name?: string; value?: string };
        if (['default', 'schema'].includes(exported.name ?? exported.value ?? '')) {
          roots.push(specifier.local as unknown as Expression);
        }
      }
    }
  }

  // an app that starts itself: what `main()` is given
  const mains = importBindings(parsed, RUNTIME, 'main');
  if (mains.direct.size || mains.namespaces.size) {
    walk(parsed.program, (node) => {
      if (node.type === 'CallExpression' && calleeName(node.callee, mains) !== undefined) {
        const first = node.arguments[0];
        const argument =
          first && first.type !== 'SpreadElement' ? unwrapShallow(first as Expression) : undefined;
        if (argument?.type === 'ObjectExpression') {
          roots.push(argument);
          roots.push(plainProperty(argument, 'schema')?.value as Expression);
        } else if (argument) {
          roots.push(argument);
        }
      }
      return true;
    });
  }

  for (const root of roots) {
    add(root);
  }
  return literals;
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
   * schema`. The readers follow it anyway, since it is what the entry says.
   * `exportsNoSchema()` is what says whether that is an error, for every entry
   * and not only this one.
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
  const mains = importBindings(parsed, RUNTIME, 'main');
  const named = mainSchemas(parsed);
  const sources = new Set<string>();
  for (const name of named) {
    const imported = name === undefined ? undefined : importedAs(parsed, name);
    if (imported) {
      sources.add(imported.specifier);
    }
  }
  if (!forwardsOnly(parsed, sources, mains)) {
    return here;
  }

  const files = new Set<string>();
  for (const name of named) {
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

/**
 * Whether a module reads or writes `module` or `exports`.
 *
 * Any `import` is module syntax, but the bundler still treats a file that sets
 * `module.exports` as CommonJS, so `import { sep } from 'node:path'; module.exports
 * = schema` builds and runs with that object as the namespace's `default`. Any
 * identifier of either name counts, which over-reads on purpose: it can only
 * leave an entry unrefused.
 *
 * @param parsed - The module.
 * @returns Whether the name appears as an identifier anywhere in it.
 */
function assignsCommonJs(parsed: ParsedModule): boolean {
  let found = false;
  walk(parsed.program, (node) => {
    if (node.type === 'Identifier' && (node.name === 'module' || node.name === 'exports')) {
      found = true;
    }
    return !found;
  });
  return found;
}

/**
 * Whether an entry exports neither of the two names the generated entry reads.
 *
 * `generateBin()` takes `default ?? schema` from the entry, so a module that
 * exports neither builds an app that stops at start with `This app's entry
 * exports no schema` -- whatever else the module does, and wherever its `main()`
 * call finds the schema: written in the call, or imported. It asks the question
 * `findSchema()` asks of the same two names, with the same readers, so the two
 * cannot disagree about what counts as an export (SIG-567).
 *
 * `true` only when it is certain. A module with no ES module syntax is CommonJS,
 * and so is one that names `module` or `exports` beside its imports -- either way
 * `module.exports` is the namespace's `default`; `export =` is the same in
 * TypeScript; and a module that cannot be read, or an `export *` that may supply
 * `schema`, is one this cannot see into. Each of those is `false`, the direction
 * the whole build errs in.
 *
 * @param entry - The app's entry module, as discovery found it.
 * @returns Whether the entry certainly exports no schema.
 */
export function exportsNoSchema(entry: string): boolean {
  const parsed = read(entry);
  if (
    !parsed ||
    !parsed.module.hasModuleSyntax ||
    parsed.program.body.some((statement) => statement.type === 'TSExportAssignment') ||
    assignsCommonJs(parsed)
  ) {
    return false;
  }

  return ['default', 'schema'].every(
    (name) => exportedFrom(entry, name, new Set()).kind === 'absent'
  );
}
