/**
 * Finding the settings an app passes to `main()`, which a build cannot carry.
 *
 * The executable `sigil build` generates calls `main({ schema })` and nothing
 * else, so a `settings` the app passed in its own `main()` call reaches the app
 * from source and not once it is built: `allowUnknownOptions: false` refuses a
 * typo in one and accepts it in the other, and both builds report success
 * (SIG-333). `Schema.settings` is the place that survives. This is the half that
 * says so while an app has not moved.
 *
 * ## A warning, and it must never fire on correct code
 *
 * An app is allowed to call `main()` with settings -- a test does it all the time,
 * and a dev runner has no other place -- so nothing here may be an error, and the
 * match has to be one that is certain. That decides each rule below.
 *
 * - **The callee is a binding, not a spelling.** It is the `main` imported from
 *   `@ttylabs/sigil` (named, aliased, default, or a member of a namespace import),
 *   decided by `bindings.ts` like the `ui` tag and `utilitySheet`. A local function
 *   called `main` is not it, and neither is a `main` the module binds again.
 * - **The argument is an object literal with a literal `settings` key.** A spread,
 *   a computed key, or an options object built somewhere else could hold settings
 *   and could equally hold none, and a warning that is sometimes wrong is a warning
 *   nobody reads. `{ settings }` counts -- the key is written down -- and so does
 *   `settings: opts`, whatever it is.
 * - **An empty `settings: {}` says nothing**, so it is not reported.
 *
 * ## What is looked at
 *
 * Two files: the schema module, which the build already reads, and the `dev`
 * runner at the app's root, which is where `sigil new` puts the call. The rest of
 * the shapes this misses are listed under "A built app loses the settings it
 * passes to `main()`" in AGENTS.md, and every one of them is silent: the app
 * builds as it did before this existed.
 */

import { bindingName, importBindings, reachable, unwrap, type ImportBindings } from './bindings.ts';
import type { Diagnostic } from './diagnostic.ts';
import { EXTENSIONS, isFile, RUNTIME, type DiscoveredApp } from './discover.ts';
import { plainProperty, unwrapShallow } from './literals.ts';
import { locate, parseModule, type ParsedModule } from './parse-module.ts';
import { walk } from './walk.ts';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/** Where a `main()` call passes settings. */
export interface MainSettingsCall {
  /** One-based column of the `settings` key. */
  readonly column: number;
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

    // `settings: {}` carries nothing for a build to lose
    const value = unwrapShallow(settings.value);
    if (value.type === 'ObjectExpression' && !value.properties.length) {
      return true;
    }

    const { column, line } = locate(parsed, settings.start);
    found.push({ column, line });
    return true;
  });

  return found.sort((one, other) => one.line - other.line || one.column - other.column);
}

/**
 * The files an app calls `main()` from that a build can reasonably find.
 *
 * @param app - The app.
 * @returns The schema module, and the dev runner when there is one.
 */
function candidates(app: DiscoveredApp): string[] {
  const files = [app.entry];

  for (const extension of EXTENSIONS) {
    const runner = join(app.root, `dev${extension}`);
    if (runner !== app.entry && isFile(runner)) {
      files.push(runner);
      break;
    }
  }

  return files;
}

/**
 * Warns about each `main()` call in the app that passes settings a build drops.
 *
 * A module that does not parse is left to the passes that own it: the entry's
 * failure is reported by the command reader, and a dev runner is not something
 * the build needs to read at all, so neither is an error here.
 *
 * @param app - The app.
 * @returns One warning per call.
 */
export function checkMainSettings(app: DiscoveredApp): readonly Diagnostic[] {
  const diagnostics: Diagnostic[] = [];

  for (const file of candidates(app)) {
    let parsed: ParsedModule;
    try {
      parsed = parseModule(file, readFileSync(file, 'utf-8'));
    } catch {
      continue;
    }

    for (const call of mainSettingsIn(parsed)) {
      diagnostics.push({
        column: call.column,
        file,
        line: call.line,
        message:
          'these settings are passed to main() and do not reach a built app, which calls ' +
          'main({ schema }) itself; move them to `settings` on the schema',
        severity: 'warning',
      });
    }
  }

  return diagnostics;
}
