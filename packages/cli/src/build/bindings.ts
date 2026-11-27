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
  lastPlain,
  literalOf,
  mayCarry,
  objectLiteral,
  outermostWhere,
  PLACEHOLDER_KEYS,
  propertyKey,
  spellingOf,
  unwrapShallow,
  type Lacks,
} from './literals.ts';
import { type ParsedModule } from './parse-module.ts';
import { walk } from './walk.ts';
import type {
  CallExpression,
  Expression,
  ObjectExpression,
  ObjectProperty,
  Node,
  VariableDeclarator,
} from 'oxc-parser';

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
 * `spellingOf()` over what this module can show: a spread of a `const` that is
 * only ever spread is its literal's members, and a spread of one that visibly
 * holds no `key` is not a spread that may carry it.
 *
 * The one place the two resolvers are handed to `spellingOf()`, so the schema's
 * `commands`, `locales` and `baseDir`, a placeholder's seven keys and its nested
 * `commands`, and what a routed module declares cannot come to read a spread
 * differently (SIG-730).
 *
 * @param parsed - The module the object is in.
 * @param object - The object literal.
 * @param key - The key in question.
 * @param computed - Whether a computed key that may be `key` is a carrier.
 * @returns What `spellingOf()` answers.
 */
export function spellingIn(
  parsed: ParsedModule,
  object: ObjectExpression,
  key: string,
  computed = false
): ReturnType<typeof spellingOf> {
  return spellingOf(object, key, sealedResolver(parsed), computed, lacksResolver(parsed));
}

/** What `lacksResolver()` answered per module, name and key. */
const lacking = new WeakMap<ParsedModule, Map<string, boolean>>();

/**
 * Whether a name is a same-module `const` whose object literal visibly holds no
 * `key`, and that nothing in the module can have written one to (SIG-730).
 *
 * `sealedObject()` answers the larger question -- what the const holds, as far as
 * it can be read, which is a reason to bake a value out of it. This is the
 * smaller one, and the one that may be answered for a const `sealedObject()` gives
 * up on: a spread of an object that spells no `commands` cannot replace one, and
 * saying it may is a warning about nothing. It stays a **question about one
 * key**, which is why it can be answered for a const that holds an array under
 * another or is read for another. The binding is
 *
 * - a `const` of the module's own that is not exported, and bound once, so a
 *   use of the name is the declaration's (`declaredObject()`);
 * - initialized with an object literal whose members, read as the object they
 *   make, do not spell `key` -- no property, no `__proto__` (which a spread
 *   does not copy and a member write could use), no accessor of any key, which
 *   runs when it is spread and does what the build cannot read, and no spread or computed
 *   key that may carry it, a spread of a name inside it included, which is not
 *   looked into twice; and
 * - named nowhere except as an object spread's operand or as the object of a
 *   member access with a **different** static key that is not called, tagged or
 *   constructed. `base.options.push(x)` cannot write `commands`; `base.commands =
 *   x`, `base[k] = x`, `Object.assign(base, x)`, `mutate(base)` and
 *   `base.valueOf().commands = x` -- a called member is handed the object as
 *   `this` -- can, or might, and any of them keeps the warning. A member
 *   access of `key` is refused even where it only reads, which is the cheap side
 *   to be wrong on, as it is for `sealedObject()`.
 *
 * An imported or an exported base is not this module's to read, so it is
 * `undefined` here and still warns.
 *
 * @param parsed - The module.
 * @returns The question, per name and key.
 */
export function lacksResolver(parsed: ParsedModule): Lacks {
  return (name, key) => {
    let cache = lacking.get(parsed);
    if (!cache) {
      cache = new Map();
      lacking.set(parsed, cache);
    }

    const id = JSON.stringify([name, key]);
    let answer = cache.get(id);
    if (answer === undefined) {
      answer = lacksKey(parsed, name, key);
      cache.set(id, answer);
    }

    return answer;
  };
}

/**
 * The object literal of a same-module `const` whose keys are all visible, which
 * is what `warnUnbaked()` reads for a spread `sealedObject()` gave up on
 * (SIG-731).
 *
 * The refusal for a spread that may carry a `name`, `path` or `load` was the only
 * thing that reported what else such a const holds, since `flatten()` reads only
 * a const `sealedObject()` resolves; and it is decided per key and skipped for a
 * key the placeholder spells after the spread. So the keys are reported for any
 * const whose members are plain properties -- no accessor, spread or computed key
 * -- whatever it holds, and what a refusal also says is said twice at worst.
 *
 * @param parsed - The module.
 * @param name - The name that is spread.
 * @returns The literal, or `undefined` where the name is not such a const.
 */
export function visibleLiteral(parsed: ParsedModule, name: string): ObjectExpression | undefined {
  const object = declaredObject(parsed, name)?.object;
  return object &&
    flatten(object).every(
      (member) =>
        member.type !== 'SpreadElement' &&
        !member.computed &&
        member.kind === 'init' &&
        propertyKey(member) !== undefined &&
        propertyKey(member) !== '__proto__'
    )
    ? object
    : undefined;
}

/**
 * The keys something writes to a same-module `const` by a member, anywhere in the
 * module (SIG-736).
 *
 * `visibleLiteral()` is what the const was declared as, and `shared.options = x`
 * puts a key on it that the literal never held. This is the occurrence scan
 * `lacksResolver()` asks, taken for every key at once rather than for one. It
 * lists the keys that are **written** -- assigned, updated, deleted into or
 * destructured into -- and not the ones that are read: `lacksResolver()` refuses
 * a read of its own key, which is the cheap side for a question about one key,
 * while a list that named every key somebody read would report a key the const
 * never held. A use the scan cannot follow -- a computed member (`shared[k] = x`), a call with the
 * const as an argument, a closure, a called member -- may write any key at all,
 * so no list of them exists and the answer is `undefined`: a caller asking for
 * the keys has to say what it does about a spread that may carry anything, and
 * `warnUnbaked()` says nothing for it, as for any spread it cannot read.
 *
 * @param parsed - The module.
 * @param name - The binding.
 * @returns The keys, or `undefined` where a use cannot be followed or the name is
 *   not a plain same-module `const` of an object literal.
 */
export function writtenKeys(parsed: ParsedModule, name: string): ReadonlySet<string> | undefined {
  const declared = declaredObject(parsed, name);
  if (!declared) {
    return undefined;
  }

  // `''` is the key whose accesses are refused, which no one writing a key to a
  // const means: every other static key is allowed, and the written ones collected
  const keys = new Set<string>();
  return onlySpread(parsed, name, declared.declarator, '', keys) ? keys : undefined;
}

function lacksKey(parsed: ParsedModule, name: string, key: string): boolean {
  const declared = declaredObject(parsed, name);
  if (!declared) {
    return false;
  }

  const spells = flatten(declared.object).some((member) =>
    member.type === 'SpreadElement' || member.computed
      ? mayCarry(member, key)
      : // a getter runs when the object is spread, and what a function does is not
        // read here: it is given up on whatever key it is called
        member.kind !== 'init' || propertyKey(member) === key || propertyKey(member) === '__proto__'
  );
  return !spells && onlySpread(parsed, name, declared.declarator, key);
}

/**
 * The object literals that are the schema when the build asks for the one that
 * declares `key`, which is `commands` for the command tree and `locales` for the
 * catalogs (SIG-728).
 *
 * The outermost literal that spells the key, read through a spread of a `const`
 * the resolver answers for -- so `{ ...base, run() {} }` with a sealed `base`
 * that carries the key is a schema, as it is to the runtime -- **less the
 * literals that are only a shared base**: the initializer of a `const` that is
 * named nowhere but as an object spread's operand, **where that spread is inside
 * another of the literals found**. That literal is a part of the schema that
 * spreads it and not a second one, and counting it made a module with a shared
 * base report `found 2 schemas` and read nothing. It is the occurrence half of
 * `sealedObject()` only: what the const holds is a separate question, and a base
 * whose `commands` is an object literal is not read through (SIG-725) but is
 * still not a schema. The spread is then reported by the readers a spread the
 * build cannot read already has.
 *
 * What is **not** dropped, and so is read as it was: a `let` or a `var`, an
 * exported `const`, a name bound twice, one that is assigned, passed, captured or
 * read by a member, and a base that is spread nowhere inside another literal
 * found -- including the `{ ...base, run() {} }` whose own literal does not
 * spell the key and cannot be seen to carry it, which leaves `base` the only
 * schema there is.
 *
 * One rule for the two readers that ask, since two answers to "which object is
 * the schema" is the defect this is for.
 *
 * @param parsed - The module.
 * @param key - The property to look for.
 * @returns The schemas, in source order.
 */
export function schemasWith(parsed: ParsedModule, key: string): ObjectExpression[] {
  const resolve = sealedResolver(parsed);
  const found = outermostWhere(
    parsed.program,
    (object) =>
      lastPlain(object, key, resolve) !== undefined || spellsAccessor(object, key, resolve)
  );

  return found.filter((object) => {
    const declarator = parsed.program.body
      .flatMap((node) => (node.type === 'VariableDeclaration' ? node.declarations : []))
      .find((each) => each.init && literalOf(each.init as Expression, false) === object);
    if (declarator?.id.type !== 'Identifier') {
      return true;
    }

    const { name } = declarator.id;
    const declared = declaredObject(parsed, name);
    if (declared?.object !== object || !onlySpread(parsed, name, declared.declarator)) {
      return true;
    }

    // dropped only when **every** spread of it is inside a literal found: one
    // that is spread somewhere else is not known to be a part of a schema
    const inside = found.reduce(
      (count, other) => count + (other === object ? 0 : spreadsOf(other, name)),
      0
    );
    return inside === 0 || inside !== spreadsOf(parsed.program, name);
  });
}

/**
 * Whether an object spells `key` as an accessor or a method, and no plain
 * property of it is the one that runs (SIG-734, SIG-735).
 *
 * The runtime reads a getter, so such a literal **is** the schema, and the build
 * cannot read what it returns. Left unclaimed, a schema whose only `commands` is
 * a getter was `no "commands" found in this module` and one whose only `locales`
 * is one was not looked at at all, so `sigil check` said `no problems found`. A
 * claim is what lets the two readers say what is true of it. `lastPlain()` is the
 * other half of the same question and is asked first by the caller.
 */
function spellsAccessor(
  object: ObjectExpression,
  key: string,
  resolve: (name: string) => ObjectExpression | undefined
): boolean {
  return flatten(object, resolve).some(
    (member) =>
      member.type !== 'SpreadElement' &&
      propertyKey(member) === key &&
      (member.kind !== 'init' || member.method)
  );
}

/** How many object spreads of `name` there are anywhere inside a node. */
function spreadsOf(inside: Node, name: string): number {
  let count = 0;
  walk(inside, (node) => {
    if (node.type === 'ObjectExpression') {
      for (const property of node.properties) {
        const operand =
          property.type === 'SpreadElement' ? unwrapShallow(property.argument) : undefined;
        if (operand?.type === 'Identifier' && operand.name === name) {
          count++;
        }
      }
    }
    return true;
  });
  return count;
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

  // asked as the readers ask it: the nested `commands` read looks through a
  // one-argument call, so `commands: command({ ... })` is read by reference as
  // well; no other key's does, and `desc: t({ ... })` shares nothing it reads
  const value = member.value as Expression;
  return (
    unwrapShallow(value).type === 'ArrayExpression' ||
    (key === 'commands' ? objectLiteral(value) : literalOf(value, false)) !== undefined
  );
}

/**
 * The declaration of a module-scope `const` holding an object literal, when the
 * binding is the only one of its name -- which is what both questions about a
 * spread base start from.
 */
function declaredObject(
  parsed: ParsedModule,
  name: string
): { declarator: VariableDeclarator; object: ObjectExpression } | undefined {
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
  return declarator && object ? { declarator, object } : undefined;
}

function sealedObjectOf(parsed: ParsedModule, name: string): ObjectExpression | undefined {
  const declared = declaredObject(parsed, name);
  if (!declared) {
    return undefined;
  }

  const { declarator, object } = declared;

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

  return onlySpread(parsed, name, declarator) ? object : undefined;
}

/**
 * Whether a binding occurs nowhere but its declaration and as the operand of an
 * object spread, which is the half of `sealedObject()` that is about what can
 * happen to the object and not about what it holds (SIG-728).
 *
 * @param parsed - The module.
 * @param name - The binding.
 * @param declarator - Its declaration.
 * @param except - A key whose accesses are the only ones that matter, where the
 *   question is about one key: a member access of any other static key is then
 *   allowed too, unless it is called, tagged or constructed, which hands the
 *   object over as `this` (SIG-730).
 * @param written - Where to collect the static key of each member access that
 *   `except` allowed **and that is written** -- the target of an assignment, an
 *   update or a `for ... of`, or inside a destructuring one -- for the caller that
 *   wants to know which keys the const was given (SIG-736). One scan, so what
 *   counts as a use cannot differ between the two questions.
 * @returns Whether every use of it is a spread.
 */
function onlySpread(
  parsed: ParsedModule,
  name: string,
  declarator: VariableDeclarator,
  except?: string,
  written?: Set<string>
): boolean {
  // every occurrence of the name but its declaration and an object spread's
  // operand is a use that might write -- or might hand the object to something
  // that does. A JSX name is an occurrence too (`<base.path />` reads a member),
  // and so is a spread above the declaration, which throws from source. A module
  // with `with` or a direct `eval` can bind or write any name without saying so
  const allowed = new Set<unknown>([declarator.id]);
  const called = new Set<unknown>();
  const targets = new Set<unknown>();
  let used = false;
  walk(parsed.program, (node) => {
    if (node.type === 'WithStatement') {
      used = true;
    } else if (written && ASSIGNING.has(node.type)) {
      // everything inside the left side is written to, `[shared.a] = x` included, and
      // the parent is visited before its members
      const target =
        node.type === 'UpdateExpression' ? node.argument : (node as { left: Node }).left;
      walk(target, (inner) => {
        targets.add(inner);
        return true;
      });
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
      node.type === 'CallExpression' ||
      node.type === 'NewExpression' ||
      node.type === 'TaggedTemplateExpression'
    ) {
      // a member that is *called* is handed the object as `this`: `mixin.valueOf()`
      // returns it and `mixin.set('commands', x)` writes it, so it is a use the build
      // cannot follow whatever the key is
      // through a parenthesized optional chain too, which `unwrapShallow()` does not
      // look through and which keeps `this`: `(mixin?.valueOf)()`
      let callee = unwrapShallow(
        (node.type === 'TaggedTemplateExpression' ? node.tag : node.callee) as Expression
      );
      while (callee.type === 'ChainExpression') {
        callee = unwrapShallow(callee.expression as Expression);
      }
      if (callee.type === 'MemberExpression') {
        called.add(callee);
      }
    } else if (
      except !== undefined &&
      node.type === 'MemberExpression' &&
      !called.has(node) &&
      node.object.type === 'Identifier' &&
      node.object.name === name &&
      otherKey(node, except)
    ) {
      allowed.add(node.object);
      if (targets.has(node)) {
        written?.add(staticKey(node)!);
      }
    } else if (
      (node.type === 'Identifier' || node.type === 'JSXIdentifier') &&
      (node.name === 'eval' || (node.name === name && !allowed.has(node)))
    ) {
      used = true;
    }

    return !used;
  });

  return !used;
}

/** The nodes that write to what is on their left, or in their argument. */
const ASSIGNING: ReadonlySet<string> = new Set([
  'AssignmentExpression',
  'ForInStatement',
  'ForOfStatement',
  'UpdateExpression',
]);

/** Whether a member access names a static key that is neither `key` nor `__proto__`. */
function otherKey(node: Node & { computed: boolean; property: Node }, key: string): boolean {
  const name = staticKey(node);
  return name !== undefined && name !== key && name !== '__proto__';
}

/** The key a member access names where it is written out: `.x` and `['x']`, and no other. */
function staticKey(node: { computed: boolean; property: Node }): string | undefined {
  return node.computed
    ? node.property.type === 'Literal' && typeof node.property.value === 'string'
      ? node.property.value
      : undefined
    : node.property.type === 'Identifier'
      ? node.property.name
      : undefined;
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
