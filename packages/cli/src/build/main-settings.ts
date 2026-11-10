/**
 * Finding the settings an app passes to `main()` in a file the build never bundles.
 *
 * The executable `sigil build` generates calls `main({ schema })` and nothing
 * else, so a `settings` the app passed in its own `main()` call reaches the app
 * from source and not once it is built: `allowUnknownOptions: false` refuses a
 * typo in one and accepts it in the other, and both builds report success
 * (SIG-333). `Schema.settings` is the place that survives. This is the half that
 * says so while an app has not moved.
 *
 * ## Where the call is, which is the whole of what makes this a warning
 *
 * A `main()` call loses its settings only where the **build does not bundle it**.
 * The schema module is bundled -- the generated entry imports it -- so a function
 * in it that calls `main({ settings })` (a command composing another app, which
 * the README documents) keeps those settings when built, and following this
 * warning's advice there would put an `errorHandler: false` on the *outer* app and
 * turn every error it has into an unhandled rejection. So the schema module is not
 * searched for `main()` calls at all (it is read for one other thing: what its
 * `settings` say, for the message below). A call at its top level is a different
 * problem -- it runs in the built app as well as the generated entry's -- and is
 * left to AGENTS.md rather than reported here, because this warning's claim is
 * about settings and that call's settings do apply, to that call.
 *
 * What is read is the one file the build never touches that `sigil new` writes:
 * the `dev` runner at the app's root. Every call in it is reported, nested or not,
 * because none of it is bundled. A deliberate dev-only override is still reported,
 * and there is no opt-out: a `main()` that disagrees with the schema is exactly
 * what makes the source run and the built app differ, which is what the warning
 * exists to say, and the message names the key and what the built app uses.
 *
 * ## Only a certain match fires
 *
 * An app is allowed to call `main()` with settings -- a test does it all the time
 * -- so nothing here may be an error, and a match has to be one that is certain.
 *
 * - **The callee is a binding, not a spelling.** It is the `main` imported from
 *   `@ttylabs/sigil` (named, aliased, default, or a member of a namespace import),
 *   decided by `bindings.ts` like the `ui` tag and `utilitySheet`. A local function
 *   called `main` is not it, and neither is a `main` the module binds again.
 * - **The argument is an object literal with a literal `settings` key.** A spread,
 *   a computed key, or an options object built somewhere else could hold settings
 *   and could equally hold none. `{ settings }` counts -- the key is written down
 *   -- and so does `settings: opts`, whatever it is.
 * - **An empty `settings: {}` says nothing**, and neither does one whose every key
 *   is `undefined`, which the merge reads as not named.
 *
 * The shapes this misses are listed in the paragraph of `packages/cli/AGENTS.md`
 * that begins "Settings are no longer one of the divergences" (under "The build:
 * reading an app off disk"), and every one of them is silent: the app builds as it
 * did before this existed.
 */

import { bindingName, importBindings, reachable, unwrap, type ImportBindings } from './bindings.ts';
import type { Diagnostic } from './diagnostic.ts';
import { EXTENSIONS, isFile, RUNTIME, type DiscoveredApp } from './discover.ts';
import { defaultObject } from './extract.ts';
import { isUndefined, plainProperty, propertyKey, unwrapShallow } from './literals.ts';
import { locate, parseModule, type ParsedModule } from './parse-module.ts';
import { walk } from './walk.ts';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ObjectExpression, ObjectProperty, SpreadElement } from 'oxc-parser';

/** Where a `main()` call passes settings. */
export interface MainSettingsCall {
  /** One-based column of the `settings` key. */
  readonly column: number;
  /**
   * The keys the call names, when every one of them is a literal key; otherwise
   * `undefined`, which is a call that has settings this cannot enumerate.
   */
  readonly keys?: readonly string[];
  /** One-based line of the `settings` key. */
  readonly line: number;
}

/**
 * Every `main()` call in a module whose argument is an object literal with a
 * `settings` key.
 *
 * @param parsed - The module.
 * @returns Where each `settings` key is, in source order.
 */
export function mainSettingsIn(parsed: ParsedModule): readonly MainSettingsCall[] {
  const reach: ImportBindings[] = [
    importBindings(parsed, RUNTIME, 'main'),
    importBindings(parsed, RUNTIME, 'default'),
  ].filter(reachable);

  if (!reach.length) {
    return [];
  }

  const found: MainSettingsCall[] = [];

  walk(parsed.program, (node) => {
    if (node.type !== 'CallExpression') {
      return true;
    }

    if (!reach.some((bindings) => bindingName(node.callee, bindings) !== undefined)) {
      return true;
    }

    const [argument] = node.arguments;
    if (!argument || argument.type === 'SpreadElement') {
      return true;
    }

    const object = unwrapShallow(unwrap(argument));
    if (object.type !== 'ObjectExpression') {
      return true;
    }

    const settings = plainProperty(object, 'settings');
    if (!settings) {
      return true;
    }

    const value = unwrapShallow(settings.value);
    const keys = value.type === 'ObjectExpression' ? namedKeys(value) : undefined;

    // `settings: {}` carries nothing for a build to lose, and a key set to
    // `undefined` is a key the merge reads as not named
    if (keys && !keys.length) {
      return true;
    }

    const { column, line } = locate(parsed, settings.start);
    found.push({ column, keys, line });
    return true;
  });

  return found.sort((one, other) => one.line - other.line || one.column - other.column);
}

/**
 * Whether a property is `__proto__: value` in an object literal, which sets the
 * prototype and is not a key.
 *
 * A shorthand `{ __proto__ }` and a computed `['__proto__']` do create a key, and a
 * computed one is already refused as unreadable; a method named `__proto__` is a
 * key too.
 *
 * @param property - The property.
 * @returns Whether it is the prototype setter.
 */
function isProtoSetter(property: ObjectProperty | SpreadElement): boolean {
  return (
    property.type !== 'SpreadElement' &&
    property.kind === 'init' &&
    !property.computed &&
    !property.shorthand &&
    !property.method &&
    propertyKey(property) === '__proto__'
  );
}

/**
 * The keys an object literal names with a value, or `undefined` when any of them
 * cannot be read.
 *
 * A spread, a computed key or a key written twice makes the whole answer `undefined`: naming
 * three of five keys in a message that says what the built app uses would be a
 * claim about the two it left out.
 *
 * @param object - The literal.
 * @returns The keys, in source order.
 */
function namedKeys(object: ObjectExpression): string[] | undefined {
  const keys: string[] = [];
  const seen = new Set<string>();

  for (const property of object.properties) {
    if (property.type === 'SpreadElement') {
      return undefined;
    }

    // `{ __proto__: base }` sets the prototype rather than a key, and `read()` goes
    // through the prototype, so what `base` holds is part of the answer
    if (isProtoSetter(property)) {
      return undefined;
    }

    const key = propertyKey(property);
    // a key written twice is legal and JavaScript keeps the last, which may be
    // `undefined`: reading the first would name a key the object does not have
    if (key === undefined || seen.has(key)) {
      return undefined;
    }
    seen.add(key);

    if (!isUndefined(property.value)) {
      keys.push(key);
    }
  }

  return keys;
}

/**
 * The keys the app's schema sets in `settings`, when the module says so plainly.
 *
 * Read off the default-exported object literal -- followed to a module-scope
 * `const`, which is what `--isolatedDeclarations` makes an app write. "The built
 * app uses the default" is a claim that needs the schema to be **fully** known, so
 * anything that could change what the literal says leaves it `undefined` and the
 * caller keeps the general message:
 *
 * - a schema built by a function, or a `settings` that is not a literal;
 * - a spread or a computed key at the top level, either of which can supply or
 *   replace `settings`;
 * - two `settings` keys, because JavaScript keeps the last and a reader that takes
 *   the first says something false;
 * - a binding referenced anywhere but its declaration and the `export default`:
 *   `schema.settings = {...}`, `schema.settings.errorHandler = false` and
 *   `Object.assign(schema.settings, ...)` all name it a third time, so one rule
 *   covers assignment, mutation and anything else done to it later. Counted by
 *   identifier name over the whole module, which over-reaches on purpose (a
 *   property or a local that shares the name also counts) in the direction that
 *   only costs the detail.
 *
 * @param app - The app.
 * @returns The keys, or `undefined` when the schema cannot be read that far.
 */
function schemaSettingsKeys(app: DiscoveredApp): ReadonlySet<string> | undefined {
  let parsed: ParsedModule;
  try {
    parsed = parseModule(app.entry, readFileSync(app.entry, 'utf-8'));
  } catch {
    return undefined;
  }

  // `calls: false`: a schema wrapped in `withDefaults({ name: 'a' })` is whatever the
  // wrapper returns, `settings` included, so only parentheses and type assertions
  // are looked through. No identity helper for a schema exists in `@ttylabs/sigil`
  // (`command()` and `options()` are for a command and an option set), so no call
  // is allowed
  const found = defaultObject(parsed, [], { calls: false });
  if (!found) {
    return undefined;
  }
  const { binding, object: schema } = found;

  // a spread may carry `settings`, a computed key may be `settings`, and a
  // `__proto__: base` makes `base` the prototype `settings` is read through; none
  // is readable, and none is an absence
  if (
    schema.properties.some(
      (property) =>
        property.type === 'SpreadElement' || property.computed || isProtoSetter(property)
    )
  ) {
    return undefined;
  }

  if (binding !== undefined && mentions(parsed, binding) > 2) {
    return undefined;
  }

  const declared = schema.properties.filter(
    (property) => property.type !== 'SpreadElement' && propertyKey(property) === 'settings'
  );
  if (declared.length > 1) {
    return undefined;
  }
  if (!declared.length) {
    return new Set();
  }

  const settings = plainProperty(schema, 'settings');
  const value = settings && unwrapShallow(settings.value);
  const keys = value?.type === 'ObjectExpression' ? namedKeys(value) : undefined;

  return keys && new Set(keys);
}

/**
 * How many identifiers in a module have this name.
 *
 * A binding that is only declared and default-exported is mentioned twice, so a
 * third is something else being done with it.
 *
 * @param parsed - The module.
 * @param name - The name.
 * @returns The count.
 */
function mentions(parsed: ParsedModule, name: string): number {
  let count = 0;

  walk(parsed.program, (node) => {
    if (node.type === 'Identifier' && node.name === name) {
      count++;
    }
    return true;
  });

  return count;
}

/**
 * The runners an app calls `main()` from that the build never bundles.
 *
 * @param app - The app.
 * @returns The `dev` module at the app's root, when there is one and it is not
 *   itself the schema module.
 */
function runners(app: DiscoveredApp): string[] {
  for (const extension of EXTENSIONS) {
    const runner = join(app.root, `dev${extension}`);
    if (runner !== app.entry && isFile(runner)) {
      return [runner];
    }
  }

  return [];
}

/**
 * What a built app does about the keys a call sets, as a sentence.
 *
 * @param keys - The keys the call names.
 * @param schemaKeys - The keys the schema sets.
 * @returns The sentence, ending in a full stop.
 */
function builtUses(keys: readonly string[], schemaKeys: ReadonlySet<string>): string {
  const quoted = (names: readonly string[]): string => {
    const each = names.map((n) => `\`${n}\``);
    return each.length > 1 ? `${each.slice(0, -1).join(', ')} and ${each.at(-1)}` : each[0]!;
  };
  const fromSchema = keys.filter((key) => schemaKeys.has(key));
  const fromDefault = keys.filter((key) => !schemaKeys.has(key));
  const parts: string[] = [];

  if (fromSchema.length) {
    parts.push(`the schema's ${quoted(fromSchema)}`);
  }
  if (fromDefault.length) {
    parts.push(`the default ${quoted(fromDefault)}`);
  }

  return `A built app uses ${parts.join(' and ')}.`;
}

/**
 * Warns about each `main()` call in the app's runner that passes settings a build
 * drops.
 *
 * A module that does not parse is left to the passes that own it: a dev runner is
 * not something the build needs to read at all, so a syntax error there is not
 * this warning's to raise.
 *
 * @param app - The app.
 * @returns One warning per call.
 */
export function checkMainSettings(app: DiscoveredApp): readonly Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  let schemaKeys: ReadonlySet<string> | undefined;
  let schemaRead = false;

  for (const file of runners(app)) {
    let parsed: ParsedModule;
    try {
      parsed = parseModule(file, readFileSync(file, 'utf-8'));
    } catch {
      continue;
    }

    for (const call of mainSettingsIn(parsed)) {
      let detail = '';

      if (call.keys) {
        // read at most once, and only when there is a call to say it about
        if (!schemaRead) {
          schemaKeys = schemaSettingsKeys(app);
          schemaRead = true;
        }
        if (schemaKeys) {
          detail = ` ${builtUses(call.keys, schemaKeys)}`;
        }
      }

      diagnostics.push({
        column: call.column,
        file,
        line: call.line,
        message:
          'these settings are passed to main() and do not reach a built app, which calls ' +
          `main({ schema }) itself; move them to \`settings\` on the schema.${detail}`,
        severity: 'warning',
      });
    }
  }

  return diagnostics;
}
