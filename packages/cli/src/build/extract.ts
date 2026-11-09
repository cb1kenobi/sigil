/**
 * Lifting what help needs out of a command module without importing it.
 *
 * ## The problem this exists for
 *
 * A lazily loaded command appears in help by name alone until its module is
 * read, because its `desc` lives inside that module and reading it means
 * importing it. That was a rare case when a `path` was something you
 * hand-wrote. Filesystem routing makes it the common one, so a root `--help`
 * over a routes tree prints:
 *
 * ```
 * Commands:
 *   build
 *   config
 *   db
 *   deploy
 * ```
 *
 * Help that lists sixty commands by name alone is not help. **The runtime
 * cannot fix this**, and that is not a gap in it: knowing a description means
 * importing the module, and not importing it is the entire point of the
 * deferral. So the fix has to happen where somebody is already reading every
 * file -- the build -- and the answer has to be baked into what it emits.
 *
 * ## What is lifted, and what deliberately is not
 *
 * `desc` and `hidden`, and nothing else. Both are things *help* reads, and
 * baking them makes a built app answer a question an unbundled one can only
 * answer after a load. That asymmetry is the point rather than a divergence to
 * avoid: unbundled is the one that is wrong, and the `!` name prefix already
 * exists precisely because `hidden` could not be seen in time.
 *
 * `name` and `alias` are the ones it would be tempting to lift next, and doing
 * so would be a bug -- from a *module*. (What a *placeholder* in the schema
 * declares is a different source and is carried; see `placeholderRouting()` in
 * `discover.ts`.) They decide *routing* -- what a user types -- and the
 * runtime rule is that only the placeholder's name can match, because the
 * command has to be matched before the module that renames it can be loaded.
 * Baking a module's own `name` would make a command reachable bundled under a
 * spelling that does not resolve unbundled, which is exactly the "routes
 * differently bundled and unbundled" failure the shared route rules exist to
 * prevent. So they stay where they are -- and a module that declares one, or a
 * `default: true`, is warned about (`unroutable()`), because help used to print
 * the spelling and nothing routed it (SIG-316).
 *
 * ## A computed value is reported, never guessed
 *
 * `desc: greeting()` cannot be read from source, and the two wrong answers are
 * to invent something and to fail the build. It is a *warning* with a file and
 * a line: the command keeps the description it would have had unbundled, which
 * is none until it loads, and the author is told which file and why. A module
 * with no default export at all is an `error`, because that is a module the
 * runtime would refuse too -- the build is just finding out first.
 *
 * A spread is the case worth knowing about, because it looks harmless.
 * `export default { ...base, hidden: true }` may well carry a `desc` inside
 * `base`, and nothing in this file can see it -- so an absent `desc` beside a
 * spread is reported rather than taken as "there is none", which is the
 * difference between a description the build missed and a description that was
 * never written.
 */

import type { Diagnostic } from './diagnostic.ts';
import { translatedKey } from './i18n.ts';
import {
  isUndefined,
  literalBoolean,
  literalString,
  objectLiteral,
  plainProperty,
  propertyKey,
  stringList,
} from './literals.ts';
import { locate, parseModule, type ParsedModule } from './parse-module.ts';
import type { ObjectExpression } from 'oxc-parser';

/** What a command module says about itself, read statically. */
export interface CommandFacts {
  /**
   * Its description, when the module wrote one as a literal.
   *
   * `undefined` covers two different situations on purpose, and the
   * diagnostics are what tell them apart: the module wrote no `desc`, or it
   * wrote one this cannot read.
   */
  readonly desc?: string;
  /**
   * Whether `desc` is a catalog key rather than the description itself.
   *
   * Set for a `` desc: __`Build the app` ``, which a build reads exactly as it
   * reads a template literal with no substitutions -- so the generated tree
   * carries `` () => __`Build the app` `` and the built app renders it through
   * its own catalog. Without it the lift would bake the English, and a
   * translated app's command list would be the one part of help that is not
   * translated.
   */
  readonly descTranslated?: boolean;
  /** Whether it hides itself, when the module wrote a boolean literal. */
  readonly hidden?: boolean;
}

/** One module's facts, and what reading it turned up. */
export interface Extracted {
  readonly diagnostics: readonly Diagnostic[];
  readonly facts: CommandFacts;
  /**
   * What the module declares that cannot route it, when `factsOf()` was told
   * what routes to it.
   *
   * Kept apart from `diagnostics` because the two have different silencers.
   * Those are about what help shows *before* the module loads, so a placeholder
   * that describes itself answers them; these are about a declaration that does
   * nothing wherever the description came from, and nothing the placeholder
   * says makes the module's `alias` start to route.
   */
  readonly routing: readonly Diagnostic[];
}

/** What a caller knows about how a module is reached, for `factsOf()`. */
export interface RoutedBy {
  /**
   * Whether the placeholder already declares `default: true`, in which case the
   * module repeating it says nothing wrong.
   */
  readonly default?: boolean;
  /**
   * Whether the module is a directory's `index`, so that the advice names the
   * directory. Pointing a key at the `index` file makes it one command with no
   * subcommands, which loses everything else in the directory.
   */
  readonly index?: boolean;
  /**
   * What routes to it, as written: the file or directory name of a walked
   * route, or the name string of the placeholder that points at it with its
   * `alias` joined on.
   */
  readonly name: string;
}

/** The keys this lifts, so the set is one list rather than several checks. */
const LIFTED = ['desc', 'hidden'] as const;

/**
 * Reads what a command module says about itself.
 *
 * @param file - Where the source came from; its extension decides TypeScript.
 * @param source - The module's source.
 * @param routedBy - How it is reached, as `factsOf()` takes it.
 * @returns Its facts and every diagnostic reading it produced.
 * @throws If the source does not parse. A file that is not a module is not a
 *   thing to warn about and carry on from.
 */
export function extractCommand(file: string, source: string, routedBy?: RoutedBy): Extracted {
  return factsOf(parseModule(file, source), routedBy);
}

/**
 * Reads what an already-parsed command module says about itself.
 *
 * Separate from `extractCommand()` because the build parses each module once
 * and asks it several questions -- this one and `templatesIn()` -- and parsing
 * per question is the cost nobody notices until a tree has sixty commands in
 * it.
 *
 * @param parsed - The module.
 * @param routedBy - How the module is reached. Given by a caller that knows it
 *   is *routed*, which turns on the warning for what such a module declares
 *   that cannot route -- see `unroutable()`. Omitted by a caller reading a
 *   module for its facts alone, which has nothing to say about how it was
 *   reached, and by one whose module names itself: a package a schema points
 *   at is imported when the schema is built, so its own `name` is what routes.
 * @returns Its facts and every diagnostic reading it produced.
 */
export function factsOf(parsed: ParsedModule, routedBy?: RoutedBy): Extracted {
  const diagnostics: Diagnostic[] = [];
  const at = (offset?: number) => locate(parsed, offset);

  const object = defaultObject(parsed, diagnostics);
  if (!object) {
    return { diagnostics, facts: {}, routing: [] };
  }

  const facts: { desc?: string; descTranslated?: boolean; hidden?: boolean } = {};
  let spread: number | undefined;

  for (const property of object.properties) {
    if (property.type === 'SpreadElement') {
      spread ??= property.start;
      continue;
    }

    const key = propertyKey(property);
    if (!key || !(LIFTED as readonly string[]).includes(key)) {
      continue;
    }

    // a getter or a setter is a function, whatever it would have returned, and
    // a method shorthand is the same thing written differently
    if (property.kind !== 'init' || property.method) {
      diagnostics.push({
        ...at(property.start),
        message: `"${key}" is an accessor rather than a value, so it cannot be read at build time; help will fall back to loading the module`,
        severity: 'warning',
      });
      continue;
    }

    const value = property.value;

    if (key === 'desc') {
      const text = literalString(value);
      if (text !== undefined) {
        facts.desc = text;
        continue;
      }

      // a `__` tag is a description written to be translated, and its key is
      // in the source -- so it is readable for exactly the reason a template
      // literal with no substitutions is. What is lifted is the key; see
      // `translatedKey()` for what the generated tree then carries
      const translated = translatedKey(parsed, value);
      if (translated?.key !== undefined) {
        facts.desc = translated.key;
        facts.descTranslated = true;
        continue;
      }

      // said separately, because "computed rather than a string literal" about
      // a `__` tag whose neighbour lifted perfectly well names nothing the
      // author can act on
      diagnostics.push({
        ...at(value.start),
        message: translated
          ? '"desc" is a translated string with a value interpolated into it, so it cannot be read at build time; help will list this command by name alone until its module loads'
          : '"desc" is computed rather than a string literal, so it cannot be read at build time; help will list this command by name alone',
        severity: 'warning',
      });
      continue;
    }

    const flag = literalBoolean(value);
    if (flag === undefined) {
      diagnostics.push({
        ...at(value.start),
        message:
          '"hidden" is computed rather than a boolean literal, so it cannot be read at build time; this command will be listed in help until its module loads',
        severity: 'warning',
      });
      continue;
    }
    facts.hidden = flag;
  }

  // a spread can carry anything, so an absent key beside one is unknown rather
  // than absent -- which is the whole difference between a description the
  // build missed and one nobody wrote
  if (spread !== undefined && facts.desc === undefined) {
    diagnostics.push({
      ...at(spread),
      message:
        'the default export spreads another object, which may carry a "desc" this cannot see; write "desc" on the exported object to have it appear in help',
      severity: 'warning',
    });
  }

  return {
    diagnostics,
    facts,
    routing: routedBy === undefined ? [] : unroutable(parsed, object, routedBy),
  };
}

/**
 * Where a routed module is told to say what it cannot say itself.
 *
 * One sentence, used by every warning below, so that the day a routed
 * directory can describe its commands without loading them (SIG-324's
 * `commands.json`) it is changed here and nowhere else.
 */
const DECLARE_ON_THE_ROUTE = 'declare it on the schema key that routes this module instead';

/**
 * What a directory command's `default` is told, which is that there is nowhere
 * to say it yet.
 *
 * The advice above does not work for it from source: only a key's string value
 * walks a directory and a string cannot carry `default`, while an object's
 * `path` is imported as a file, and Node refuses a directory. SIG-324's
 * `commands.json` is where a directory will say it, and this changes with
 * `DECLARE_ON_THE_ROUTE` when that lands.
 */
const NO_WAY_TO_DEFAULT_A_DIRECTORY =
  'a directory command cannot be made the default from the schema today, so this line can only be removed';

/**
 * The labels of a name string a route is reached by, less the arguments.
 *
 * The split `parseName()` makes, and a `!` or `@` prefix is stripped because
 * what is being asked is which *spellings* are named, not what each one does.
 * An argument (`<file>`, `[dir]`) is not a spelling at all.
 *
 * @param name - A name string.
 * @returns The spellings it names.
 */
function spellingsOf(name: string): string[] {
  return name
    .split(/[, ]+/)
    .filter((label) => label !== '' && !'<['.includes(label[0]!))
    .map((label) => (label[0] === '!' || label[0] === '@' ? label.slice(1) : label));
}

/**
 * Warns about what a routed module declares that nothing can act on.
 *
 * A module is read only after argv has matched the name its route is known by,
 * so a `name` string, an `alias` or `default: true` written *inside* it comes
 * too late to route anything: `commands/list.ts` saying `name: 'list, ls'`
 * leaves `ls` unmatched, and a `default: true` there is read by nothing at all,
 * because by the time the module is loaded the command was already matched by
 * name. Help used to print the second spelling anyway (SIG-316); it leaves such
 * a spelling out now, and this is the half that tells the author *why*, in the
 * file, rather than leaving them to wonder where the alias went.
 *
 * Only what differs from the route is reported. A module saying `name: 'list'`
 * in `list.ts` repeats what routes it and says nothing wrong, and a warning
 * that fires on correct code teaches people to ignore warnings. A value this
 * cannot read is reported too, since nothing says it matches the route.
 *
 * @param parsed - The module.
 * @param object - Its default-exported command.
 * @param routedBy - How it is reached.
 * @returns A warning per declaration that cannot take effect.
 */
function unroutable(
  parsed: ParsedModule,
  object: ObjectExpression,
  routedBy: RoutedBy
): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const route = routedBy.name;
  const routed = new Set(spellingsOf(route));
  const target = routedBy.index ? './path/to/this-directory' : './path/to/this-file';
  const warn = (start: number, message: string) =>
    diagnostics.push({ ...locate(parsed, start), message, severity: 'warning' });
  /** The property, unless it is absent or `undefined`, which the runtime reads as absent. */
  const declared = (key: string) => {
    const property = plainProperty(object, key);
    return property && !isUndefined(property.value) ? property : undefined;
  };
  /** Spellings written twice are one spelling, and are said once. */
  const quoted = (spellings: readonly string[]) =>
    [...new Set(spellings)].map((spelling) => `"${spelling}"`).join(', ');

  const name = declared('name');
  if (name) {
    const written = literalString(name.value);
    const extra = written === undefined ? [] : spellingsOf(written).filter((s) => !routed.has(s));
    if (written === undefined || extra.length > 0) {
      const example = [...new Set([...routed, ...extra])].join(', ');
      warn(
        name.start,
        written === undefined
          ? `"name" is computed, so nothing says it matches "${route}", the name this module is routed by; a name in a routed module has no effect on routing, ` +
              `so ${DECLARE_ON_THE_ROUTE}`
          : `"name" declares ${quoted(extra)}, which does not route: this module is loaded only after argv has matched "${route}", ` +
              `so a name in it has no effect and help leaves it out; ${DECLARE_ON_THE_ROUTE}, such as \`commands: { '${example}': '${target}' }\``
      );
    }
  }

  const alias = declared('alias');
  if (alias) {
    const written = stringList(alias.value);
    const extra =
      written.kind === 'strings' ? written.values.filter((value) => !routed.has(value)) : [];
    if (written.kind !== 'strings' || extra.length > 0) {
      warn(
        alias.start,
        `"alias" ${written.kind === 'strings' ? `declares ${quoted(extra)}` : 'is not a list of strings written down'}, ` +
          `which does not route: this module is loaded only after argv has matched "${route}", so an alias in it has no effect; ` +
          `${DECLARE_ON_THE_ROUTE}, such as \`commands: { '${[...new Set([...routed, ...extra])].join(', ')}': '${target}' }\``
      );
    }
  }

  // `default: true` on a placeholder that already says so is the module
  // repeating the route, as a name equal to it is
  const fallback = declared('default');
  const advice = routedBy.index
    ? NO_WAY_TO_DEFAULT_A_DIRECTORY
    : `${DECLARE_ON_THE_ROUTE}, such as \`commands: { '${route}': { default: true, path: '${target}' } }\``;
  if (
    fallback &&
    literalBoolean(fallback.value) !== false &&
    !(routedBy.default && literalBoolean(fallback.value) === true)
  ) {
    warn(
      fallback.start,
      `"default" has no effect here: this module is read only after argv has matched "${route}", ` +
        `so it cannot make the command the default; ${advice}`
    );
  }

  return diagnostics;
}

/**
 * The object literal a module default-exports, or `undefined` with a
 * diagnostic saying why there is none.
 *
 * @param parsed - The module.
 * @param diagnostics - Where to report.
 * @returns The object expression.
 */
function defaultObject(
  parsed: ParsedModule,
  diagnostics: Diagnostic[]
): ObjectExpression | undefined {
  const exported = parsed.program.body.find((node) => node.type === 'ExportDefaultDeclaration');

  if (!exported) {
    // `export { cmd as default }` is a default export the runtime is perfectly
    // happy with, so this is about what *this pass* can read rather than about
    // the module being wrong -- which is why it is not the error below
    const indirect = parsed.program.body
      .filter((node) => node.type === 'ExportNamedDeclaration')
      .flatMap((node) => node.specifiers)
      .find((spec) => spec.exported.type === 'Identifier' && spec.exported.name === 'default');

    if (indirect && indirect.local.type === 'Identifier') {
      const resolved = bindingObject(parsed, indirect.local.name);
      if (resolved) {
        return resolved;
      }
    }

    diagnostics.push({
      file: parsed.file,
      message: indirect
        ? 'the default export is a reference rather than an object literal, so it cannot be read at build time; help will list this command by name alone'
        : 'no default export found; a command module must default-export a command object',
      severity: indirect ? 'warning' : 'error',
    });
    return undefined;
  }

  const declaration = objectLiteral(exported.declaration as never);

  if (declaration) {
    return declaration;
  }

  // `export default cmd`, where `cmd` is a `const` in this module. Worth
  // following rather than warning about, because it is not a style somebody
  // chose: `--isolatedDeclarations` refuses to infer a default export, so an
  // app that has it on *cannot* write the literal inline, and this repo is one
  // of those apps -- every command module in the toolchain ends this way. A
  // lift that cannot read the code its own conventions produce is a lift that
  // reports "help will list this command by name alone" about itself.
  if (exported.declaration.type === 'Identifier') {
    const resolved = bindingObject(parsed, exported.declaration.name);
    if (resolved) {
      return resolved;
    }
  }

  diagnostics.push({
    ...locate(parsed, exported.declaration.start),
    message:
      'the default export is not an object literal, so it cannot be read at build time; help will list this command by name alone',
    severity: 'warning',
  });
  return undefined;
}

/**
 * The object literal a module-scope `const` holds, if it holds one.
 *
 * `const` only: a `let` or a `var` can be reassigned between the declaration
 * and the export, so what the binding held when the file was read is not what
 * it holds when the module runs -- and a lift that guessed would bake a
 * description the app does not have. Module scope only, for the same reason a
 * computed key is unreadable: a binding declared somewhere else is a question
 * about scope that this pass does not answer.
 *
 * @param parsed - The module.
 * @param name - The binding to resolve.
 * @returns The object expression, or `undefined` when it is not one.
 */
function bindingObject(parsed: ParsedModule, name: string): ObjectExpression | undefined {
  for (const node of parsed.program.body) {
    const declaration =
      node.type === 'VariableDeclaration'
        ? node
        : node.type === 'ExportNamedDeclaration' && node.declaration?.type === 'VariableDeclaration'
          ? node.declaration
          : undefined;

    if (declaration?.kind !== 'const') {
      continue;
    }

    for (const declarator of declaration.declarations) {
      if (declarator.id.type === 'Identifier' && declarator.id.name === name && declarator.init) {
        return objectLiteral(declarator.init as never);
      }
    }
  }

  return undefined;
}
