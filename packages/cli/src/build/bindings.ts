/**
 * Which local names in a module are a particular import, and nothing else.
 *
 * Two passes ask this and have to get the same answer: `templates.ts` asks
 * whether a tagged template's tag is the `ui` imported from
 * `@ttylabs/sigil/template`, and `shake.ts` asks whether a call is the
 * `utilitySheet` imported from `@ttylabs/sigil/style`. Both are the same
 * question -- **an import is a binding, not a spelling** -- and a second
 * implementation of it is a second set of answers about aliases, namespaces and
 * shadowing. That is the rule `readRoutes()` already records for the two route
 * walks, met a second time.
 *
 * ## The direction the uncertainty falls
 *
 * Every shape this *misses* is silent and safe: a template stays interpreted, a
 * sheet stays unshaken, and the build says nothing. Every shape it claims
 * *wrongly* rewrites somebody else's code. So the answer is given up wherever it
 * cannot be had -- a name the module binds again is dropped whole, because there
 * is no scope tree here to ask which use site is the import's -- and the list of
 * shapes that stay unreachable is in AGENTS.md rather than repeated here.
 */

import {
  bindingObject,
  flatten,
  objectLiteral,
  PLACEHOLDER_KEYS,
  propertyKey,
  unwrapShallow,
} from './literals.ts';
import { type ParsedModule } from './parse-module.ts';
import { walk } from './walk.ts';
import type { CallExpression, Expression, ObjectExpression, ObjectProperty } from 'oxc-parser';

/**
 * Every way one module can reach one export.
 *
 * Sets rather than single names, because a module may import the same thing
 * more than once -- under its own name, under an alias, and as a namespace --
 * and each of them is that import.
 */
export interface ImportBindings {
  /** Locals a named import bound it to, alias included. */
  readonly direct: ReadonlySet<string>;
  /** The export name being looked for, which a namespace member has to match. */
  readonly name: string;
  /** Locals a namespace import bound the whole module to. */
  readonly namespaces: ReadonlySet<string>;
}

/** Whether a set of bindings can reach the export at all. */
export function reachable(bindings: ImportBindings): boolean {
  return bindings.direct.size > 0 || bindings.namespaces.size > 0;
}

/**
 * Every local name in a module that is one export of one module.
 *
 * Read off oxc's own module record rather than by walking for imports, and then
 * narrowed by taking out every name the module binds again -- see
 * `reboundNames()` for why that is module-wide rather than per use site.
 *
 * @param parsed - The module.
 * @param from - The module specifier to look for.
 * @param name - The export name to look for.
 * @returns The direct locals and the namespace locals, shadowed names removed.
 */
export function importBindings(parsed: ParsedModule, from: string, name: string): ImportBindings {
  const direct = new Set<string>();
  const namespaces = new Set<string>();

  for (const imported of parsed.module.staticImports) {
    if (imported.moduleRequest.value !== from) {
      continue;
    }

    for (const entry of imported.entries) {
      // a type-only import erases, so nothing it named exists at run time
      if (entry.isType) {
        continue;
      }

      if (entry.importName.kind === 'NamespaceObject') {
        namespaces.add(entry.localName.value);
      } else if (entry.importName.kind === 'Name' && entry.importName.name === name) {
        direct.add(entry.localName.value);
      } else if (entry.importName.kind === 'Default' && name === 'default') {
        // `import main from '@ttylabs/sigil'` is the export named `default`, the same
        // binding `import { default as main }` is, which the branch above reads
        direct.add(entry.localName.value);
      }
    }
  }

  // nothing imported it, so there is nothing for a shadow to shadow and the
  // walk `reboundNames()` would do is worth skipping rather than running to
  // find that out
  if (!direct.size && !namespaces.size) {
    return { direct, name, namespaces };
  }

  const rebound = reboundNames(parsed);
  const keep = (names: ReadonlySet<string>): Set<string> =>
    new Set([...names].filter((local) => !rebound.has(local)));

  return { direct: keep(direct), name, namespaces: keep(namespaces) };
}

/** Where an imported local name came from. */
export interface ImportedFrom {
  /**
   * The export it is, or `*` for the whole module, which is a namespace and is
   * not any one export.
   */
  readonly name: string;
  /** The module specifier it was imported from, as written. */
  readonly specifier: string;
}

/**
 * What a local name was imported as: the inverse of `importBindings()`.
 *
 * `importBindings()` asks which locals are a **known** export of a **known**
 * module. A pass following a binding to the file that holds it asks the other
 * way round -- it has a local and wants to know where it came from -- and the
 * two have to agree about shadowing, so it is the same record read the same way
 * and the same names are given up: a local the module binds again somewhere is
 * not answered, because there is no scope tree here to say which use site is
 * the import's.
 *
 * @param parsed - The module.
 * @param local - The local name.
 * @returns Where it came from, or `undefined` when it is not an import (or is
 *   not one that can be told from a name the module binds again).
 */
export function importedAs(parsed: ParsedModule, local: string): ImportedFrom | undefined {
  for (const imported of parsed.module.staticImports) {
    for (const entry of imported.entries) {
      if (entry.isType || entry.localName.value !== local) {
        continue;
      }

      const specifier = imported.moduleRequest.value;
      if (reboundNames(parsed).has(local)) {
        return undefined;
      }

      switch (entry.importName.kind) {
        case 'NamespaceObject':
          return { name: '*', specifier };
        case 'Default':
          return { name: 'default', specifier };
        case 'Name':
          return { name: entry.importName.name!, specifier };
        default:
          return undefined;
      }
    }
  }

  return undefined;
}

/**
 * Every name the module binds somewhere other than by importing it.
 *
 * A binding is only the import's for as long as nothing else in the module
 * binds that name, and this walk has no scope tree to ask -- so a name the
 * module binds again is given up on entirely rather than guessed at. The
 * direction of that giving-up is the whole point: claiming something that was
 * never the import rewrites a stranger's code, while declining one leaves it
 * alone, which is correct output at the cost of an optimization.
 *
 * Keyed on the *keys* a binding hangs off -- `id`, `param`, `params` -- rather
 * than on a list of node types, for the reason `walk()` is driven by
 * `visitorKeys`: a list of node types is a second copy of the grammar, and the
 * day the parser grows one this file has not heard of is the day a binding stops
 * being seen. Those key names are far more stable than the set of nodes that use
 * them, and reading one key too many is harmless here because every name this
 * collects is a name the matcher then declines.
 *
 * @param parsed - The module.
 * @returns The names it re-binds.
 */
function reboundNames(parsed: ParsedModule): Set<string> {
  return new Set(bindingSites(parsed).keys());
}

/**
 * Every binding site in a module, counted per name: the declaration of a name
 * and each place something else binds it again.
 *
 * `reboundNames()` is the names, and this is the names with how many times, which
 * is the question a binding the module declares has to ask about itself: one
 * site is the declaration, and a second is a parameter, a `let` in a block or a
 * function that may be what a use of the name means instead (SIG-440). One walk,
 * for both questions, so they cannot read a binding differently.
 *
 * @param parsed - The module.
 * @returns How many times each name is bound by something other than an import.
 */
function bindingSites(parsed: ParsedModule): Map<string, number> {
  const known = sites.get(parsed);
  if (known) {
    return known;
  }

  const counted = new Map<string, number>();
  const names: string[] = [];

  walk(parsed.program, (node) => {
    // an import's own binding is not a shadow of itself
    if (node.type === 'ImportDeclaration') {
      return false;
    }

    const record = node as unknown as Record<string, unknown>;
    for (const key of ['id', 'param', 'params']) {
      const value = record[key];

      if (Array.isArray(value)) {
        for (const each of value) {
          patternNames(each, names);
        }
      } else {
        patternNames(value, names);
      }
    }

    return true;
  });

  for (const name of names) {
    counted.set(name, (counted.get(name) ?? 0) + 1);
  }

  sites.set(parsed, counted);
  return counted;
}

/** The binding sites of a module, read once: a module is asked about per spread. */
const sites = new WeakMap<ParsedModule, Map<string, number>>();

/**
 * The object literal a module-scope `const` holds, **when nothing can have
 * changed it** between its declaration and any use -- or `undefined`, which is
 * the answer for everything that cannot be shown (SIG-440).
 *
 * This is what lets a placeholder spread `...base` of a same-module `const`
 * without the build refusing it, and what keeps that safe: a wrong answer here
 * is a built app that routes by a name, or bundles a module, the app does not,
 * which is what SIG-433 and SIG-434 refuse for. So the answer is given only for
 * a binding that is
 *
 * - a `const` of the module's own, **not exported** -- an export is a name any
 *   importer can write through;
 * - bound exactly once in the whole module, so no parameter, `let`, function or
 *   block shadows it where a use sits (the walk has no scope tree to say which
 *   it is, the reason `importBindings()` gives the same names up);
 * - initialized with an object literal itself, not a call or a wrapper around
 *   one, whose members are all properties a spread copies as they read -- no
 *   accessor, no `__proto__`, no computed key that is not a string and no spread
 *   of anything but another literal (a spread of a spread is not resolved
 *   twice); and
 * - **named nowhere except as the operand of an object spread** -- never
 *   assigned, never member-assigned (`base.path = ...`), never passed to a call
 *   (`Object.assign(base, ...)`, `mutate(base)`), never captured by a closure,
 *   never exported, never read by a member. Any other occurrence of the name is
 *   a use this cannot follow, so it is a use that might write, and it is refused
 *   whole rather than argued about: an unrelated property called `base` costs a
 *   refusal the app answers by spelling the key, and that is the cheap side.
 *
 * Read off the whole tree rather than from the declaration forward, since a
 * function declared above it can still be called after it.
 *
 * @param parsed - The module.
 * @param name - The binding.
 * @returns The literal it holds, or `undefined` where that cannot be shown.
 */
export function sealedObject(parsed: ParsedModule, name: string): ObjectExpression | undefined {
  let cache = sealed.get(parsed);
  if (!cache) {
    cache = new Map();
    sealed.set(parsed, cache);
  }

  if (!cache.has(name)) {
    cache.set(name, sealedObjectOf(parsed, name));
  }

  return cache.get(name);
}

/** What `sealedObject()` answered per module and name, since the answer is a walk. */
const sealed = new WeakMap<ParsedModule, Map<string, ObjectExpression | undefined>>();

/**
 * `sealedObject()` as a function of a name alone, which is what `flatten()` takes.
 *
 * @param parsed - The module the names are in.
 * @returns The resolver.
 */
export function sealedResolver(
  parsed: ParsedModule
): (name: string) => ObjectExpression | undefined {
  return (name) => sealedObject(parsed, name);
}

/**
 * The keys whose **value** the build reads, which is what a shared array or
 * object can change under it: the seven a placeholder is read for, and the
 * `commands` it walks into. Nothing else's value is read -- `options`, `args`,
 * `examples`, `hooks`, `run` and custom data are named by `warnUnbaked()` and
 * their contents never looked at (SIG-725).
 */
const READ_AS_VALUE: ReadonlySet<string> = new Set([...PLACEHOLDER_KEYS, 'commands']);

/**
 * Whether a property's value is an array or an object literal **the build
 * reads**, which a spread shares with whatever mutates it.
 *
 * A spread is a shallow copy, so `{ ...base }.alias.push('x')` writes the
 * const's own array without the name ever being assigned (SIG-440, review) --
 * which only matters where the build read what the array held. A `base`
 * carrying `options: { ... }` is the most common shared base there is, and its
 * options are never read: a mutation of that object changes nothing the build
 * took off the placeholder, so refusing it protected nothing (SIG-725). The
 * keys are the set above and are asked **by what the build reads**, not by what
 * is plausible for a key to hold -- `desc: []` is refused too, though a runtime
 * refuses it as well. A computed key that is not a string never reaches here,
 * since the member was already refused.
 */
function holdsReadObject(member: ObjectProperty): boolean {
  const key = propertyKey(member);
  if (key === undefined || !READ_AS_VALUE.has(key)) {
    return false;
  }

  // asked as the readers ask it: `objectLiteral()` looks through a one-argument
  // call, so `commands: command({ ... })` is read by reference as well
  const value = member.value as Expression;
  return unwrapShallow(value).type === 'ArrayExpression' || objectLiteral(value) !== undefined;
}

function sealedObjectOf(parsed: ParsedModule, name: string): ObjectExpression | undefined {
  if (bindingSites(parsed).get(name) !== 1) {
    return undefined;
  }

  // the declaration itself, and only a plain one: `bindingObject()` also reads an
  // exported `const`, which is exactly what is refused here
  const declarator = parsed.program.body
    .flatMap((node) =>
      node.type === 'VariableDeclaration' && node.kind === 'const' ? node.declarations : []
    )
    .find((each) => each.id.type === 'Identifier' && each.id.name === name);
  const object = declarator ? bindingObject(parsed, name, false) : undefined;
  if (!declarator || !object) {
    return undefined;
  }

  // what a spread copies as it reads: an accessor is read at the spread and not
  // by the build, `__proto__` sets a prototype and copies nothing, a computed key
  // that is not a string names nothing here, and a spread is another question
  const readable = flatten(object).every(
    (member) =>
      member.type !== 'SpreadElement' &&
      !member.computed &&
      member.kind === 'init' &&
      propertyKey(member) !== undefined &&
      propertyKey(member) !== '__proto__' &&
      // a spread is a shallow copy, so a nested array or object is the very one
      // the const holds, handed to whoever the spread went to: `{ ...base }.alias`
      // can be pushed to without the name ever being written (SIG-440, review).
      // Only where the build reads what it holds (SIG-725)
      !holdsReadObject(member)
  );
  if (!readable) {
    return undefined;
  }

  // every occurrence of the name but its declaration and an object spread's
  // operand is a use that might write -- or might hand the object to something
  // that does. A JSX name is an occurrence too (`<base.path />` reads a member),
  // and so is a spread above the declaration, which throws from source. A module
  // with `with` or a direct `eval` can bind or write any name without saying so
  const allowed = new Set<unknown>([declarator.id]);
  let used = false;
  walk(parsed.program, (node) => {
    if (node.type === 'WithStatement') {
      used = true;
    } else if (node.type === 'ObjectExpression') {
      for (const property of node.properties) {
        if (property.type === 'SpreadElement') {
          const operand = unwrapShallow(property.argument);
          if (operand.type === 'Identifier' && operand.name === name) {
            if (operand.start < declarator.end) {
              used = true;
            }
            allowed.add(operand);
          }
        }
      }
    } else if (
      (node.type === 'Identifier' || node.type === 'JSXIdentifier') &&
      (node.name === 'eval' || (node.name === name && !allowed.has(node)))
    ) {
      used = true;
    }

    return !used;
  });

  return used ? undefined : object;
}

/**
 * The names a binding pattern binds, added to a set.
 *
 * Destructuring, defaults and rest elements all bind, so all of them are read
 * -- and anything unrecognised is simply not a name, which is safe because an
 * unread pattern can only cost an optimization.
 *
 * @param value - A pattern, or whatever was on the key.
 * @param into - Where to collect the names, one entry per binding site.
 */
function patternNames(value: unknown, into: string[]): void {
  if (!value || typeof value !== 'object') {
    return;
  }

  const node = value as Record<string, unknown> & { type?: string };

  switch (node.type) {
    case 'ArrayPattern':
      for (const element of (node.elements as unknown[]) ?? []) {
        patternNames(element, into);
      }
      patternNames(node.rest, into);
      return;
    case 'AssignmentPattern':
      patternNames(node.left, into);
      return;
    case 'Identifier':
      into.push(String(node.name));
      return;
    case 'ObjectPattern':
      for (const property of (node.properties as Record<string, unknown>[]) ?? []) {
        patternNames(property.value, into);
      }
      patternNames(node.rest, into);
      return;
    case 'RestElement':
      patternNames(node.argument, into);
      return;
    case 'TSParameterProperty':
      patternNames(node.parameter, into);
      return;
    default:
      return;
  }
}

/**
 * The name an expression reached an import by, if it is that import at all.
 *
 * Two shapes, because a module has two static ways to name one import and the
 * answer has to be the same for both: a bare local from a named import, and a
 * property of a namespace object. `import * as t` followed by `t.ui` is the same
 * function as `ui` -- there is no scope walk in either answer, which is what
 * keeps this a question about the module record.
 *
 * A *computed* property is deliberately not read, even holding a literal:
 * `t['ui']` and `t[key]` are the same syntax and only one of them is readable,
 * and reading the easy half of a construct this does not support is worse than
 * skipping both, because the half it skipped is silent. That is the rule the
 * static `desc` lift already follows for a computed key.
 *
 * @param node - The expression, parentheses and all.
 * @param bindings - What this module imported.
 * @returns The name it was reached by, or `undefined` if it is not the import.
 */
export function bindingName(node: Expression, bindings: ImportBindings): string | undefined {
  const expression = unwrap(node);

  if (expression.type === 'Identifier') {
    return bindings.direct.has(expression.name) ? expression.name : undefined;
  }

  if (
    expression.type === 'MemberExpression' &&
    !expression.computed &&
    expression.object.type === 'Identifier' &&
    bindings.namespaces.has(expression.object.name) &&
    expression.property.type === 'Identifier' &&
    expression.property.name === bindings.name
  ) {
    return `${expression.object.name}.${expression.property.name}`;
  }

  return undefined;
}

/**
 * The name a call's callee reached an import by, reading through every wrapper
 * that erases.
 *
 * A callee is the other way round from a template tag, and AGENTS.md records
 * why: a missed call is silent, while a claimed tag rewrites somebody's template.
 * So a callee is read through `unwrapShallow()` -- `(<T>main)(...)`,
 * `(main as Main)(...)`, `(main<T>)(...)`, `main!(...)` -- and so is the object
 * of a namespace member, because `(t as any).main(...)`, `t!.main(...)` and
 * `(<any>t).main(...)` are the same call as `t.main(...)`. `bindingName()` is
 * left taking parentheses off and nothing else, since the tag readers ask it
 * directly and a wrapped tag is deliberately not recognised.
 *
 * @param node - The callee, wrappers and all.
 * @param bindings - What this module imported.
 * @returns The name it was reached by, or `undefined` if it is not the import.
 */
export function calleeName(node: Expression, bindings: ImportBindings): string | undefined {
  const callee = unwrapShallow(node);

  if (callee.type === 'MemberExpression' && !callee.computed) {
    const object = unwrapShallow(callee.object as Expression);
    if (object !== callee.object) {
      return bindingName({ ...callee, object } as Expression, bindings);
    }
  }

  return bindingName(callee, bindings);
}

/**
 * The call an expression is, if it is a call to one of the imports.
 *
 * Read through the wrappers that erase, and through `?.` as well, which
 * `unwrapShallow()` refuses because it can change a value. It cannot here. oxc
 * puts a `ChainExpression` around a call with `?.` anywhere in its callee, and
 * the call is only returned when that callee is the import, so every optional
 * link the chain could short-circuit at is on the import itself -- `main?.(...)`
 * or `t?.main(...)` -- and an import binding is never `null` or `undefined`.
 * That holds for what the callers pass, a named export of sigil's own modules or
 * a namespace of one; a caller passing the default import of some other module
 * would have to argue it again, since a default export may be anything. A
 * chain whose outermost node is not the call, `checker()?.x`, is not the call
 * and is not returned.
 *
 * The readers that *walk* to a call do not need this: the walk reaches the
 * `CallExpression` inside the chain on its own. It is for a reader that looks at
 * one expression and asks whether it is the call -- the value of a schema's
 * `updateCheck`, or a statement of an entry that forwards its schema.
 *
 * @param node - The expression.
 * @param bindings - Every import that counts.
 * @returns The call, or `undefined` when the expression is not a call to one.
 */
export function importCall(
  node: Expression,
  bindings: readonly ImportBindings[]
): CallExpression | undefined {
  let expression = unwrapShallow(node);
  if (expression.type === 'ChainExpression') {
    expression = unwrapShallow(expression.expression as Expression);
  }

  if (expression.type !== 'CallExpression') {
    return undefined;
  }

  const callee = expression.callee;
  return bindings.some((each) => calleeName(callee, each) !== undefined) ? expression : undefined;
}

/**
 * An expression with its parentheses taken off.
 *
 * `(ui)\`...\`` is the same call as `ui\`...\``, and oxc preserves the
 * parentheses as a node -- so a matcher that reads straight off the node sees a
 * `ParenthesizedExpression` and silently declines something with nothing wrong
 * with it. Recursive, because `((ui))` is also that call.
 *
 * @param node - The expression.
 * @returns The innermost expression the parentheses wrap.
 */
export function unwrap(node: Expression): Expression {
  let inner = node;
  while (inner.type === 'ParenthesizedExpression') {
    inner = inner.expression;
  }
  return inner;
}
