/**
 * Reading values out of source, for the passes that read a declaration nobody
 * is going to run.
 *
 * Two of them need this and want the same answers: the `desc`/`hidden` lift out
 * of a command module, and the schema read out of an app's entry. A second copy
 * of "is this a string somebody wrote" is how two halves of one build come to
 * disagree about whether `` `build` `` counts.
 *
 * Everything here answers `undefined` for what it cannot read statically, and
 * the caller decides whether that is worth reporting. Nothing here guesses.
 */

import type { ParsedModule } from './parse-module.ts';
import { walk } from './walk.ts';
import type { Expression, Node, ObjectExpression, ObjectProperty, SpreadElement } from 'oxc-parser';

/**
 * Looks through the wrappers that do not change what a value is.
 *
 * `as`, `satisfies`, the angle-bracket assertion `<T>x` and an instantiation
 * expression `fn<T>` are type syntax and erase to nothing; parentheses are
 * nothing at all; `!` is an assertion about a value rather than a change to it.
 *
 * `?.` is deliberately not here: it can change a value, to `undefined`, so it is
 * not a wrapper that changes nothing. `importCall()` in `bindings.ts` looks
 * through it where that is true, a call whose callee is an import, and
 * `objectLiteral()` does for a caller that asks and can afford it.
 *
 * @param node - The expression.
 * @returns The expression under the type syntax.
 */
export function unwrapShallow(node: Expression): Expression {
  let current = node;
  while (
    current.type === 'TSAsExpression' ||
    current.type === 'TSSatisfiesExpression' ||
    current.type === 'TSTypeAssertion' ||
    current.type === 'TSInstantiationExpression' ||
    current.type === 'ParenthesizedExpression' ||
    current.type === 'TSNonNullExpression'
  ) {
    current = current.expression;
  }
  return current;
}

/**
 * The object literal an expression is, looking through the wrappers that change
 * nothing -- including a call that passes one through.
 *
 * `command()` is the call that matters: it is documented as the identity
 * function and exists only so inference reaches a nested literal, so what it
 * wraps says exactly what the bare literal says. It is unwrapped whatever it is
 * *called*, because the name is the app's to choose -- it may be imported under
 * an alias, or be a wrapper of the app's own. What that costs is a
 * `withDefaults({ desc: 'a' }, ...)` whose own body overrides `desc`, which is
 * why the unwrap stops at a call with exactly one argument that is an object
 * literal: a wrapper doing anything more interesting than passing its argument
 * through almost always takes something else too.
 *
 * `?.` is not looked through unless the caller says so (SIG-591), for the reason
 * `unwrapShallow()` gives: `wrap?.({ desc })` is `undefined` when `wrap` is
 * nullish, so it is not the object it wraps. Each caller decides whether that
 * matters to it, and only a reader that is safe either way may opt in.
 *
 * @param node - The expression.
 * @param options - `optional`: read an optional call, `wrap?.({ ... })`, as the plain one.
 * @returns The object literal, or `undefined` when it is not one.
 */
export function objectLiteral(
  node: Expression,
  options: { readonly optional?: boolean } = {}
): ObjectExpression | undefined {
  let current = unwrapShallow(node);

  for (;;) {
    if (options.optional && current.type === 'ChainExpression') {
      // oxc's node for a chain; what is inside is the call itself, or a member
      // read, which the checks below decline
      current = unwrapShallow(current.expression as Expression);
      continue;
    }

    if (current.type === 'ObjectExpression') {
      return current;
    }

    if (current.type === 'CallExpression' && current.arguments.length === 1) {
      const [argument] = current.arguments;
      // a spread argument is not an object literal however it was written
      if (argument && argument.type !== 'SpreadElement') {
        current = unwrapShallow(argument);
        continue;
      }
    }

    return undefined;
  }
}

/**
 * The name a property declares, or `undefined` when it does not declare one
 * statically.
 *
 * A computed key is `undefined` even when it happens to hold a string, because
 * `['desc']` and `[key]` are the same syntax and only one of them is readable
 * -- and a pass that reads the easy half of a construct it does not support is
 * worse than one that skips it, since the half it skipped is silent.
 *
 * @param property - The property.
 * @returns The key.
 */
export function propertyKey(property: ObjectProperty): string | undefined {
  if (property.computed) {
    return undefined;
  }

  const { key } = property;

  if (key.type === 'Identifier') {
    return key.name;
  }

  // `{ 'desc': 'x' }` is the same declaration written with quotes
  if (key.type === 'Literal' && typeof key.value === 'string') {
    return key.value;
  }

  return undefined;
}

/**
 * The value a named property holds, when the object declares it plainly.
 *
 * `undefined` for an accessor, a method, a computed key, or a property that is
 * not there -- which the caller tells apart by asking whether it was declared
 * at all.
 *
 * @param object - The object literal.
 * @param name - The property to look for.
 * @returns The property, when it is a plain one.
 */
export function plainProperty(object: ObjectExpression, name: string): ObjectProperty | undefined {
  for (const property of object.properties) {
    if (property.type === 'SpreadElement') {
      continue;
    }

    if (propertyKey(property) === name && property.kind === 'init' && !property.method) {
      return property;
    }
  }

  return undefined;
}

/**
 * Whether a spread or a computed key may set `key` on the object it sits in,
 * which is what decides whether a spelling of `key` written before it is the
 * one that runs.
 *
 * Read rather than assumed, because the cheap answer -- any spread, any
 * computed key -- is wrong in both directions at once: `['path']` after a
 * `desc` cannot replace it, so treating it as though it might either drops a
 * description the build can read or waves through one the runtime refuses
 * (SIG-421). So a computed key that is a literal may replace only the key it
 * converts to -- `[1]` and `[1n]` are `"1"`, `[true]` is `"true"`, `[null]` is
 * `"null"`, `[/a/g]` is `"/a/g"` -- and a symbol (`[Symbol.for('x')]`,
 * `[Symbol.iterator]`) is never a string key at all (SIG-433). A spread may
 * replace only what its operand can carry: an object literal what it carries,
 * read through its own spreads; an array, a string or a template literal its
 * indices and nothing else -- an array only when no element is itself a spread;
 * any other literal, or `undefined`, nothing at all; and a conditional or a
 * logical expression what its arms can carry, so `...(on && { hidden: true })`
 * and `...(on ? { hidden: false } : {})` carry `hidden` and nothing else.
 *
 * **Literals are read and expressions are not evaluated.** A spread of a name,
 * a call, a member or a sequence expression, and a key computed by an
 * expression, `['de' + 'sc']`, may carry anything -- and a conditional whose
 * arm is one of those carries anything too, since what is read is the arms and
 * the test is not. That costs a warning where a bake was possible, and an error
 * where the key is one a built app cannot be wrong about (`name`, `path`,
 * `load`), and never bakes a wrong value. A call is not looked through here,
 * even the single-argument one `objectLiteral()` unwraps: a wrapper adding a
 * `desc` is exactly the case this question exists for. Resolving a name to the
 * literal it was declared as is `flatten()`'s, behind the guard `sealedObject()` in
 * `bindings.ts` is: a name it did not resolve is a spread of a name, and is
 * refused here (SIG-440).
 *
 * A plain property is not asked about: its key is its own, and the caller
 * reads it by name.
 *
 * @param property - A property of an object literal.
 * @param key - The key in question.
 * @returns Whether it may set `key`.
 */
export function mayCarry(property: ObjectExpression['properties'][number], key: string): boolean {
  if (property.type === 'SpreadElement') {
    return carries(property.argument, key);
  }

  if (!property.computed) {
    return false;
  }

  if (isSymbol(property.key as Expression)) {
    return false;
  }

  const name = literalKey(property.key as Expression);
  return name === undefined || name === key;
}

/**
 * Whether spreading an expression may set `key`: what `mayCarry()` asks of a
 * spread, and of each arm of one that chooses between operands.
 *
 * @param node - The operand of the spread.
 * @param key - The key in question.
 * @returns Whether it may.
 */
function carries(node: Expression, key: string): boolean {
  const spread = unwrapShallow(node);

  switch (spread.type) {
    case 'ObjectExpression':
      return spread.properties.some((inner) =>
        inner.type === 'SpreadElement' || inner.computed
          ? mayCarry(inner, key)
          : propertyKey(inner) === key
      );
    case 'ArrayExpression':
      // an array copies its indices and nothing else -- unless an element
      // is itself a spread, which is an expression rather than a literal and
      // so is not read: `[...null]` throws when the object is evaluated
      return (
        spread.elements.some((element) => element?.type === 'SpreadElement') || INDEX.test(key)
      );
    case 'TemplateLiteral':
      // ...and so does a string
      return INDEX.test(key);
    case 'Literal':
      // ...and so does a string literal, while a primitive copies nothing:
      // `null`, a boolean, a number, a bigint, and a regular expression,
      // whose one own property is `lastIndex`, which does not enumerate
      return typeof spread.value === 'string' && !('regex' in spread) && INDEX.test(key);
    case 'ConditionalExpression':
      // the test is never spread, only whichever arm it picks
      return carries(spread.consequent, key) || carries(spread.alternate, key);
    case 'LogicalExpression':
      // `a && b` is `b` or a falsy `a`, and a falsy value copies nothing --
      // `false`, `0`, `''`, `null` and `undefined` have no own string keys --
      // while `a || b` and `a ?? b` may be either operand
      return spread.operator === '&&'
        ? carries(spread.right, key)
        : carries(spread.left, key) || carries(spread.right, key);
    default:
      return !isUndefined(spread);
  }
}

/**
 * Whether a computed key is a symbol -- `Symbol.iterator`, `Symbol('x')`,
 * `Symbol.for('x')` -- which is never `name`, `path` or any other string.
 *
 * Read by shape, as the rest here is: `Symbol` is taken to be the global one.
 *
 * @param node - The expression inside the brackets.
 * @returns Whether it is one.
 */
function isSymbol(node: Expression): boolean {
  const value = unwrapShallow(node);
  const isGlobal = (candidate: Expression) =>
    candidate.type === 'Identifier' && candidate.name === 'Symbol';

  if (value.type === 'MemberExpression') {
    return isGlobal(value.object) && !value.computed;
  }

  if (value.type === 'CallExpression') {
    const callee = unwrapShallow(value.callee);
    return (
      isGlobal(callee) ||
      (callee.type === 'MemberExpression' &&
        isGlobal(callee.object) &&
        !callee.computed &&
        callee.property.type === 'Identifier' &&
        callee.property.name === 'for')
    );
  }

  return false;
}

/** The order `RegExp.prototype.flags` lists flags in, which is what `String()` prints. */
const FLAGS = 'dgimsuvy';

/** A canonical array index, the only kind of key an array or a string spreads. */
const INDEX = /^(?:0|[1-9]\d*)$/;

/**
 * The property key a computed key written as a literal converts to.
 *
 * @param node - The expression inside the brackets.
 * @returns The key, or `undefined` where it is not a literal this reads.
 */
function literalKey(node: Expression): string | undefined {
  const value = unwrapShallow(node);
  if (value.type !== 'Literal') {
    return literalString(value);
  }

  // a regular expression's is its source between slashes and its flags, read
  // off the node rather than off a `RegExp` the host may not be able to build
  if ('regex' in value) {
    const { flags, pattern } = value.regex;
    return `/${pattern}/${[...flags].sort((a, b) => FLAGS.indexOf(a) - FLAGS.indexOf(b)).join('')}`;
  }

  // what `String()` makes of it is what the property key is: `[1.0]` is `"1"`
  return value.value === null || typeof value.value !== 'object' ? String(value.value) : undefined;
}

/** A property of an object literal, or a spread. */
export type Member = ObjectExpression['properties'][number];

/**
 * An object literal's members as the object it evaluates to would list them:
 * a spread of an object literal is replaced by what the literal holds, as far
 * down as it goes, and a computed key written as a string is the plain key.
 *
 * Reading a literal is not evaluating one. `{ ...{ path: './a.js' }, ['name']:
 * 'a' }` is `{ path: './a.js', name: 'a' }` whatever runs it, so a reader that
 * asks what an object spells should be asked of this list and not of the source
 * (SIG-433, SIG-434). What stays a spread is what is not a literal -- a name, a
 * call, a member, an import, a conditional whose arms are not all literals --
 * and what stays computed is a key that is not a string: `[key]`, `['de' +
 * 'sc']`, `[1]`, a symbol. Those are the members `mayCarry()` is asked about.
 *
 * A spread of a **name** is a literal too when the caller can say which one it
 * is, and only then (SIG-440): `resolve` answers for a name, and answers only
 * where the module cannot have changed what the name holds between its
 * declaration and the spread -- `sealedResolver()` in `bindings.ts`, which is the
 * one place that is decided. Without one, a name stays a spread, which is what
 * every caller did before and what a caller that has no module to ask still does.
 * What a resolved literal holds is read as a literal and no further, so a spread
 * inside it is never resolved in turn.
 *
 * The members are the source's own nodes, except a computed key that was
 * rewritten to the plain one and what a resolved name held, so a position taken
 * from one is the source's. A resolved name's members are **copies placed at the
 * spread**: they are the const's own text, but the author reads a diagnostic
 * about them as being about the spread that brought them in, and the earliest
 * position among several is not the declaration at the top of the file
 * (SIG-725). A copy rather than the node, since one const may be spread by many
 * commands and a node can only be in one place.
 *
 * @param object - The object literal.
 * @param resolve - The object literal a name holds, where that is known.
 * @returns Its members, in the order the object has them.
 */
export function flatten(
  object: ObjectExpression,
  resolve?: (name: string) => ObjectExpression | undefined
): Member[] {
  const members: Member[] = [];

  for (const member of object.properties) {
    if (member.type === 'SpreadElement') {
      const inner = unwrapShallow(member.argument);
      if (inner.type === 'ObjectExpression') {
        members.push(...flatten(inner, resolve));
        continue;
      }

      const held = inner.type === 'Identifier' ? resolve?.(inner.name) : undefined;
      if (held) {
        // the const's own members, said to be where the spread is: that is the
        // line the author wrote and can change (SIG-725)
        members.push(...flatten(held).map((each) => relocated(each, member)));
      } else {
        members.push(member);
      }
      continue;
    }

    // `['path']` is `path`: a key somebody wrote as a string is a key, and
    // `propertyKey()` leaves a computed one `undefined` only because it cannot
    // tell this from `[key]`, which this can
    const text = member.computed ? literalString(member.key as Expression) : undefined;
    members.push(
      text === undefined
        ? member
        : ({
            ...member,
            computed: false,
            key: { ...member.key, raw: JSON.stringify(text), type: 'Literal', value: text },
          } as ObjectProperty)
    );
  }

  return members;
}

/**
 * A member read off a const, said to sit where the spread that brought it in
 * does.
 *
 * Every node under it is a copy with that span, which is what `locate()` is
 * handed whichever of them a diagnostic names -- the property, its value, or the
 * body of an arrow in it. A tree is never written to, so the copy is made rather
 * than the original moved; and nothing that reads a placeholder's member slices
 * the source by a node's span, so the span is a position and nothing else.
 *
 * @param node - The member, or any part of one.
 * @param at - The spread it came in by.
 * @returns A copy of it.
 */
function relocated<T>(node: T, at: { end: number; start: number }): T {
  if (Array.isArray(node)) {
    return node.map((each) => relocated(each, at)) as T;
  }

  const proto: unknown = node && typeof node === 'object' ? Object.getPrototypeOf(node) : 0;
  if (proto !== Object.prototype && proto !== null) {
    return node;
  }

  const copy: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node as object)) {
    copy[key] = relocated(value, at);
  }

  if (typeof copy.start === 'number' && typeof copy.end === 'number') {
    copy.start = at.start;
    copy.end = at.end;
  }

  return copy as T;
}

/**
 * The seven keys a placeholder is read for, which a built app carries: what help
 * lists, what routes and which module it holds.
 */
export const PLACEHOLDER_KEYS: ReadonlySet<string> = new Set([
  'alias',
  'default',
  'desc',
  'hidden',
  'load',
  'name',
  'path',
]);

/**
 * Which spelling of a key an object registers, as far as the source says.
 *
 * The last spelling of a key is the one an object literal keeps -- unless a
 * spread or a computed key after it may carry the key too, since order is what
 * the runtime registers: then it is not known to be what runs. A key spelled
 * nowhere that a spread may carry is unknown too. Read off `flatten()`'s list,
 * so a spread of a literal, or of a const the resolver answers for, is what it
 * holds. One function for a placeholder's seven keys and its nested `commands`,
 * and for what a routed module declares that cannot route, so the three cannot
 * come to disagree about which spelling runs (SIG-430, SIG-433, SIG-434,
 * SIG-726).
 *
 * @param object - The object literal.
 * @param key - The key in question.
 * @param resolve - The object literal a name holds, where that is known.
 * @param computed - Whether a computed key that may be `key` is a carrier as
 *   well as a spread.
 * @returns The spelling that runs, `undefined` where the key is not declared;
 *   whether a later property may replace it; and a spread that may carry a key
 *   spelled nowhere.
 */
export function spellingOf(
  object: ObjectExpression,
  key: string,
  resolve: ((name: string) => ObjectExpression | undefined) | undefined,
  computed = false
): {
  carrier: SpreadElement | ObjectProperty | undefined;
  declared: ObjectProperty | undefined;
  replaced: boolean;
} {
  // the members the object evaluates to, which is what the runtime registers:
  // a spread of a literal is what it holds and `['path']` is `path`
  const members = flatten(object, resolve);
  let found: ObjectProperty | undefined;
  for (const property of members) {
    if (property.type !== 'SpreadElement' && propertyKey(property) === key) {
      found = property;
    }
  }

  const replaced = found !== undefined && members.lastIndexOf(found) < lastReplacing(members, key);

  // `undefined` is what the runtime reads as not declared
  const declared =
    found?.kind === 'init' && !found.method && isUndefined(found.value) && !replaced
      ? undefined
      : found;
  return { carrier: unspelledCarrier(members, key, computed), declared, replaced };
}

/**
 * The object expression an expression is, looking through calls or not.
 *
 * @param node - The expression.
 * @param calls - Whether a one-argument call is the object it wraps.
 * @returns The literal, or `undefined`.
 */
export function literalOf(node: Expression, calls: boolean): ObjectExpression | undefined {
  if (calls) {
    return objectLiteral(node);
  }

  const inner = unwrapShallow(node);
  return inner.type === 'ObjectExpression' ? inner : undefined;
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
 * This is the declaration and nothing about what happened to it afterwards; a
 * reader whose wrong answer is a build that diverges from the app asks
 * `sealedObject()` in `bindings.ts`, which asks this and then the rest.
 *
 * @param parsed - The module.
 * @param name - The binding to resolve.
 * @param calls - Whether a one-argument call is the object it wraps.
 * @returns The object expression, or `undefined` when it is not one.
 */
export function bindingObject(
  parsed: ParsedModule,
  name: string,
  calls: boolean
): ObjectExpression | undefined {
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
        return literalOf(declarator.init as never, calls);
      }
    }
  }

  return undefined;
}

/** What a reader of an object's members may be handed: the literal or its list. */
type Members = ObjectExpression | readonly Member[];

const membersOf = (members: Members): readonly Member[] =>
  'properties' in members ? members.properties : members;

/**
 * Where the last property that may set `key` without spelling it sits -- a
 * spread or a computed key that `mayCarry()` says may carry it.
 *
 * A spelling of `key` written before it is not known to be what runs, since
 * object-literal order is what the module runs with and that property may
 * replace it. One function for the module lift and the placeholder read, so
 * the two cannot come to disagree about which spelling is the one that runs.
 * Both hand it `flatten()`'s list, so a spread of an object literal is what it
 * holds wherever it is asked.
 *
 * @param object - The object literal, or its flattened members.
 * @param key - The key in question.
 * @returns Its index, or `-1` where nothing may replace the key.
 */
export function lastReplacing(object: Members, key: string): number {
  return membersOf(object).findLastIndex((property) => mayCarry(property, key));
}

/**
 * The spread that may set `key` on an object that never spells it, which makes
 * the key unknown rather than absent -- the difference between a description
 * the build missed and one nobody wrote.
 *
 * One function for the module lift and the placeholder read, as
 * `lastReplacing()` is for a key that *is* spelled: in a module an absent
 * `desc` beside one is reported, and on a placeholder a key a spread may carry
 * is the placeholder's rather than the module's, since the runtime merges the
 * module in only where the placeholder's key is `undefined` (SIG-421). Spreads
 * only, unless asked: a computed key beside an absent key is not reported, as it
 * never was.
 *
 * `computed` is for a caller that cannot let a key go unseen: a computed key
 * beside an absent key counts too (SIG-433, SIG-434). The three keys that route
 * a placeholder and hold its module are asked that way, because a built app
 * that missed one is not listed wrongly but answers to a different name or runs
 * nothing at all.
 *
 * @param object - The object literal, or its flattened members.
 * @param key - The key in question.
 * @param computed - Whether a computed key that may be `key` counts as well.
 * @returns The first such spread, or computed key when asked for them, or
 *   `undefined` where the key is spelled or nothing may carry it.
 */
export function unspelledCarrier(
  object: Members,
  key: string,
  computed = false
): SpreadElement | ObjectProperty | undefined {
  const members = membersOf(object);
  if (
    members.some((property) => property.type !== 'SpreadElement' && propertyKey(property) === key)
  ) {
    return undefined;
  }

  return members.find(
    (property): property is SpreadElement | ObjectProperty =>
      (property.type === 'SpreadElement' || (computed && property.computed)) &&
      mayCarry(property, key)
  );
}

/**
 * The string a node is, when it is one written down.
 *
 * A template literal with no substitutions counts: `` `build the app` `` is a
 * string somebody wrote, and refusing it would make the two spellings of one
 * thing disagree. One *with* substitutions does not, because its value is not
 * in the source.
 *
 * @param node - The expression.
 * @returns The string, or `undefined`.
 */
export function literalString(node: Expression): string | undefined {
  const value = unwrapShallow(node);

  if (value.type === 'Literal' && typeof value.value === 'string') {
    return value.value;
  }

  if (value.type === 'TemplateLiteral' && value.expressions.length === 0) {
    return value.quasis[0]?.value.cooked ?? undefined;
  }

  return undefined;
}

/**
 * The type of a node, where the source settles it whether or not it settles
 * the value.
 *
 * What separates "the wrong type" from "cannot be read": `alias: 42` is a
 * declaration the runtime refuses on every run, while `alias: names` is one
 * whose value is not in the source. The first is the author's mistake and the
 * second is this pass's limit, and they are answered differently. It is a type
 * rather than a yes or no because "the type is known" is not the question --
 * `default: !flag` has a known type and an unknown value, and it is a boolean,
 * so it is unreadable rather than wrong. A function counts, because it is
 * written down; an identifier does not, `undefined` included -- that one is
 * the caller's to handle, since the runtime reads it as absent.
 *
 * @param node - The expression.
 * @returns Its type, or `undefined` where the source does not say.
 */
export function literalType(node: Expression): LiteralType | undefined {
  const value = unwrapShallow(node);

  switch (value.type) {
    case 'Literal':
      // a regular expression's value is the `RegExp`, which is an object
      return value.value === null ? 'null' : (typeof value.value as LiteralType);
    case 'TemplateLiteral':
      // `${x}` is a string whatever x is, even where its value is not in the source
      return 'string';
    case 'ObjectExpression':
    case 'ArrayExpression':
      return 'object';
    case 'ArrowFunctionExpression':
    case 'FunctionExpression':
    case 'ClassExpression':
      return 'function';
    case 'UnaryExpression':
      // an operator decides its result's type whatever it is applied to, which
      // is the whole of why it is asked here: `!0` is a boolean and `void 0` is
      // `undefined`, and taking either for "a literal's type" without asking
      // which refused a `default: !0` the runtime registers as the default
      switch (value.operator) {
        case '!':
        case 'delete':
          return 'boolean';
        case 'void':
          return 'undefined';
        case 'typeof':
          return 'string';
        default:
          // `-`, `+` and `~`: a number, or a bigint, and never anything else
          return literalType(value.argument) === 'bigint' ? 'bigint' : 'number';
      }
    default:
      return undefined;
  }
}

/** The type `typeof` would give a value, with `null` told apart from an object. */
export type LiteralType =
  | 'bigint'
  | 'boolean'
  | 'function'
  | 'null'
  | 'number'
  | 'object'
  | 'string'
  | 'symbol'
  | 'undefined';

/**
 * Whether a value the source settles the type of is not of the type a property
 * needs, which is a declaration the runtime refuses on every run.
 *
 * `undefined` is the caller's to have handled first, since the runtime reads it
 * as not declared rather than as the wrong type -- except inside a list, where
 * it is an element and is wrong.
 *
 * @param node - The expression.
 * @param wanted - The type the property takes.
 * @returns Whether it is known, from the source alone, to be something else.
 */
export function isWrongType(node: Expression, wanted: LiteralType): boolean {
  const type = literalType(node);
  return type !== undefined && type !== wanted;
}

/** What a string or a list of strings written in source came to. */
export type StringList =
  /** Every string is written down. */
  | { readonly kind: 'strings'; readonly values: string[] }
  /** Something written down is not a string, so the runtime refuses it. */
  | { readonly kind: 'wrong' }
  /** Nothing written down is the wrong type, but a value is not in the source. */
  | { readonly kind: 'computed' };

/**
 * Reads a string or a list of strings, the two shapes a command's `alias`
 * takes.
 *
 * The runtime reads a string as a list of one, so both come back as a list.
 * All or nothing: a list with one element this cannot read is not a list this
 * can say anything about, and a subset would make the answer depend on which
 * elements happened to be readable. A wrong type outranks an unreadable value
 * in the same list, because the runtime refuses the list either way and the
 * build should say the thing that is certain.
 *
 * @param node - The expression.
 * @returns The strings, or why there are none.
 */
export function stringList(node: Expression): StringList {
  const single = literalString(node);
  if (single !== undefined) {
    return { kind: 'strings', values: [single] };
  }

  const value = unwrapShallow(node);
  if (value.type !== 'ArrayExpression') {
    return { kind: isWrongType(node, 'string') ? 'wrong' : 'computed' };
  }

  const values: string[] = [];
  let computed = false;
  for (const element of value.elements) {
    // a hole is `undefined`, which is not a string
    if (element === null) {
      return { kind: 'wrong' };
    }
    if (element.type === 'SpreadElement') {
      computed = true;
      continue;
    }

    const text = literalString(element);
    if (text !== undefined) {
      values.push(text);
    } else if (isWrongType(element, 'string')) {
      return { kind: 'wrong' };
    } else {
      computed = true;
    }
  }

  return computed ? { kind: 'computed' } : { kind: 'strings', values };
}

/**
 * The boolean a node is, when it is one written down.
 *
 * `true` and `false`, and `!` over a value whose truthiness is written down --
 * `!0` and `!1` are how a minifier spells the two, and both are booleans the
 * runtime reads as such. A `hidden: 1` is not a boolean, and the runtime
 * throws on a non-boolean `hidden` rather than coercing it -- so reading it as
 * truthy here would bake a value the app it came from refuses to start with.
 *
 * @param node - The expression.
 * @returns The boolean, or `undefined`.
 */
export function literalBoolean(node: Expression): boolean | undefined {
  const value = unwrapShallow(node);

  if (value.type === 'UnaryExpression' && value.operator === '!') {
    const truthy = literalTruthiness(value.argument);
    return truthy === undefined ? undefined : !truthy;
  }

  return value.type === 'Literal' && typeof value.value === 'boolean' ? value.value : undefined;
}

/**
 * Whether a value written down is truthy, for `!` to negate.
 *
 * Only where the source settles it: a literal (a regular expression is an
 * object, so truthy, and a bigint is truthy unless it is zero), a template
 * with nothing interpolated, an object, an array or a function, and `!` over
 * any of those.
 *
 * @param node - The expression.
 * @returns Its truthiness, or `undefined`.
 */
function literalTruthiness(node: Expression): boolean | undefined {
  const value = unwrapShallow(node);

  switch (value.type) {
    case 'Literal':
      // the parser hands a bigint over as a bigint and a pattern as a `RegExp`
      return Boolean(value.value);
    case 'TemplateLiteral':
      return value.expressions.length === 0 ? Boolean(literalString(value)) : undefined;
    case 'ObjectExpression':
    case 'ArrayExpression':
    case 'ArrowFunctionExpression':
    case 'FunctionExpression':
    case 'ClassExpression':
      return true;
    case 'UnaryExpression': {
      if (value.operator !== '!') {
        return undefined;
      }
      const inner = literalTruthiness(value.argument);
      return inner === undefined ? undefined : !inner;
    }
    default:
      return undefined;
  }
}

/**
 * The property of an object literal a reader of `name` should be handed: the
 * last plain one among the members the object evaluates to (SIG-728).
 *
 * Read off `flatten()`'s list, so a spread of a literal -- or of a `const` the
 * resolver answers for -- is what it holds, and the last spelling is the one an
 * object literal keeps. The first one was what `plainProperty()` returned, which
 * for a key spelled twice is the one the runtime does not read.
 *
 * @param object - The object literal.
 * @param name - The property to look for.
 * @param resolve - The object literal a name holds, where that is known.
 * @returns The property, when it is a plain one.
 */
export function lastPlain(
  object: ObjectExpression,
  name: string,
  resolve?: (name: string) => ObjectExpression | undefined
): ObjectProperty | undefined {
  return flatten(object, resolve).findLast(
    (member): member is ObjectProperty =>
      member.type !== 'SpreadElement' &&
      propertyKey(member) === name &&
      member.kind === 'init' &&
      !member.method
  );
}

/**
 * The same walk, asking only whether the property is *there*.
 *
 * `plainProperty()` answers with a value, so it leaves out a method, an
 * accessor and a computed key -- right for reading a `desc` or a `commands`,
 * and wrong for `run`, whose commonest spelling by a long way is the method
 * `run({ argv }) { ... }`. Nothing is read out of it: what the caller decides
 * is whether a schema with no `commands` is a single-command app or an app
 * that forgot them, which is a question about presence.
 *
 * A **spread** still does not count, which is the recorded rule for a `desc`
 * read from the other side: `{ ...base }` may well carry a `run` and nothing
 * here can see it, so such an entry is reported as declaring no commands
 * rather than taken for a single-command app.
 *
 * @param program - The module's tree.
 * @param name - The property to look for.
 * @returns The outermost objects declaring it, in source order.
 */
export function outermostDeclaring(program: Node, name: string): ObjectExpression[] {
  return outermostWhere(program, (object) =>
    object.properties.some(
      (property) => property.type !== 'SpreadElement' && propertyKey(property) === name
    )
  );
}

/**
 * The walk `outermostDeclaring()` is, and the one `schemasWith()` in `bindings.ts`
 * asks with its own question (SIG-728).
 *
 * @param program - The module's tree.
 * @param claims - Whether an object is one the caller is looking for.
 * @returns The outermost claimed objects, in source order.
 */
export function outermostWhere(
  program: Node,
  claims: (object: ObjectExpression) => boolean
): ObjectExpression[] {
  const found: ObjectExpression[] = [];

  walk(program, (node) => {
    if (node.type !== 'ObjectExpression') {
      return true;
    }

    const object = node as unknown as ObjectExpression;
    if (!claims(object)) {
      return true;
    }

    found.push(object);

    // claimed: everything below is this object's own
    return false;
  });

  return found;
}

/**
 * The literal specifier of a loader: `() => import('./x.js')`.
 *
 * The one shape a bundler can see, follow and split on, which is why both
 * `Command.load` and `Schema.locales` are written this way -- and two readers
 * of it, the command tree and the catalog check, so there is one answer about
 * which arrow bodies count.
 *
 * @param node - The loader expression.
 * @returns The specifier, or `undefined` for anything this cannot read.
 */
export function loaderSpecifier(node: Expression): string | undefined {
  let body = unwrapShallow(node);

  if (body.type === 'ArrowFunctionExpression') {
    const inner = body.body;
    body = unwrapShallow((inner.type === 'BlockStatement' ? undefined : inner) ?? body);
  }

  return body.type === 'ImportExpression' ? literalString(body.source) : undefined;
}

/**
 * Whether a node is `undefined`, which the runtime reads as not declared:
 * the identifier, or `void` over anything, which is how a minifier spells it.
 */
export function isUndefined(node: Expression): boolean {
  const value = unwrapShallow(node);
  return (
    (value.type === 'Identifier' && value.name === 'undefined') ||
    (value.type === 'UnaryExpression' && value.operator === 'void')
  );
}
