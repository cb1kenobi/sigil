import type { ComponentApi, OptionDoc } from '../../src/lib/component-data.ts';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseSync } from 'oxc-parser';

/**
 * A component's options, read off the declarations an app compiles against.
 *
 * The Options table on a component page is not written by hand: it is the
 * interface the component's function takes, from `dist/components.d.mts` --
 * the file `@ttylabs/sigil/components` resolves to for a type checker, so what
 * the page lists is exactly what an editor completes. Each option's type is the
 * declaration's own text, whether it is optional is the `?`, and what it does is
 * the first paragraph of its JSDoc. The default is the JSDoc's own "Defaults to
 * ..." sentence, because a declaration has no other place a default is written;
 * an option whose comment does not say has none listed.
 *
 * Which interface is a component's is not written down either: it is the type
 * of the parameter called `opts` or `props` on the component's function. The
 * interfaces it extends are followed, `Omit<>` and `Pick<>` included, so that
 * `multiselect()` lists what it has from `SelectOptions` -- **except** the ones
 * every component shares for being mounted at all (`MountOptions` and what it
 * extends: the terminal, the backend, the theme), which would be the same dozen
 * rows on every page. Those are named once, as a list, under the table.
 *
 * Read with `oxc-parser`, which `@ttylabs/cli` already uses to read an app's
 * source, at the version it pins.
 */

/** The declarations, as built. */
const DTS = join(import.meta.dirname, '../../../packages/sigil/dist/components.d.mts');

/** The interfaces whose members every mounted component has, listed by name instead. */
const SHARED = new Set(['MountOptions', 'StyledOptions']);

interface Node {
  readonly type: string;
  readonly start: number;
  readonly end: number;
  readonly [key: string]: unknown;
}

interface Comment {
  readonly type: string;
  readonly value: string;
  readonly start: number;
  readonly end: number;
}

/** The file, parsed once. */
function load(): { comments: readonly Comment[]; decls: Map<string, Node>; source: string } {
  const source = readFileSync(DTS, 'utf-8');
  const parsed = parseSync('components.d.mts', source, { lang: 'dts' });
  const decls = new Map<string, Node>();

  for (const statement of parsed.program.body as unknown as Node[]) {
    const node = (
      statement.type === 'ExportNamedDeclaration' ? statement.declaration : statement
    ) as Node | undefined;
    const id =
      (node?.id as { name?: string } | undefined)?.name ??
      (node?.declarations as { id?: { name?: string } }[] | undefined)?.[0]?.id?.name;
    // the first declaration of a name wins: an overloaded function's first
    // signature is the one an editor shows first
    if (node && id && !decls.has(id)) {
      decls.set(id, node);
    }
  }

  return { comments: parsed.comments as unknown as Comment[], decls, source };
}

let cache: ReturnType<typeof load> | undefined;
const file = () => (cache ??= load());

/** The text of a node. */
const text = (node: Node) => file().source.slice(node.start, node.end);

/** The JSDoc directly above `at`, with nothing but whitespace between. */
function docBefore(at: number): string {
  const { comments, source } = file();
  let found: Comment | undefined;
  for (const comment of comments) {
    if (comment.end > at) {
      break;
    }
    found = comment;
  }
  if (!found || !found.value.startsWith('*') || source.slice(found.end, at).trim() !== '') {
    return '';
  }
  return found.value
    .split('\n')
    .map((line) => line.replace(/^\s*\*\s?/, ''))
    .join('\n')
    .trim();
}

/** A comment's first paragraph, before any tag, on one line. */
function firstParagraph(doc: string): string {
  const body = doc.split(/\n\s*@/)[0] ?? '';
  return (body.split(/\n\s*\n/)[0] ?? '')
    .replace(/\{@link\s+([^}\s|]+)(?:[\s|][^}]*)?\}/g, '`$1`')
    .replace(/\s+/g, ' ')
    .trim();
}

/** What "Defaults to ..." says, up to the end of its clause. */
function defaultOf(doc: string): string | undefined {
  const match = /\bDefaults? to ([^;.]*?(?:`[^`]*`[^;.]*?)*)(?:[;.](?:\s|$)|,\s|$)/.exec(
    doc.replace(/\s+/g, ' ')
  );
  return match?.[1]?.trim() || undefined;
}

/** The names a `'a' | 'b'` type argument lists. */
function keysOf(node: Node | undefined): Set<string> {
  return new Set(
    [...(node ? text(node) : '').matchAll(/['"]([^'"]+)['"]/g)].map(([, key]) => key!)
  );
}

/**
 * The members of a type, its bases' first.
 *
 * @param name - An interface or a type alias in the file.
 * @param shared - Collects the shared mount options it reaches.
 * @returns The members, by name; a nearer declaration replaces a base's.
 */
function membersOf(name: string, shared: Set<string>): Map<string, OptionDoc> {
  const decl = file().decls.get(name);
  const out = new Map<string, OptionDoc>();

  if (decl?.type === 'TSInterfaceDeclaration') {
    for (const heritage of (decl.extends as Node[] | undefined) ?? []) {
      addReference(heritage, out, shared);
    }
    addAll(out, membersOfBody((decl.body as { body: Node[] }).body));
  } else if (decl?.type === 'TSTypeAliasDeclaration') {
    addType(decl.typeAnnotation as Node, out, shared);
  }

  return out;
}

/** Copies `from` into `into`, the later winning. */
function addAll(into: Map<string, OptionDoc>, from: Map<string, OptionDoc>): void {
  for (const [key, member] of from) {
    into.set(key, member);
  }
}

/** Adds what a type contributes: a reference, an intersection, or a literal. */
function addType(type: Node, into: Map<string, OptionDoc>, shared: Set<string>): void {
  if (type.type === 'TSTypeReference') {
    addReference(type, into, shared);
  } else if (type.type === 'TSIntersectionType') {
    for (const part of type.types as Node[]) {
      addType(part, into, shared);
    }
  } else if (type.type === 'TSTypeLiteral') {
    addAll(into, membersOfBody(type.members as Node[]));
  }
}

/** Adds what a named base contributes, through `Omit<>` and `Pick<>`. */
function addReference(ref: Node, into: Map<string, OptionDoc>, shared: Set<string>): void {
  const typeName = (ref.typeName ?? ref.expression) as Node | undefined;
  const base = typeName ? text(typeName) : '';
  const args = ((ref.typeArguments ?? ref.typeParameters) as { params?: Node[] } | undefined)
    ?.params;

  if ((base === 'Omit' || base === 'Pick') && args?.[0]) {
    const inner = new Map<string, OptionDoc>();
    addType(args[0], inner, shared);
    const keys = keysOf(args[1]);
    for (const [key, member] of inner) {
      if ((base === 'Omit') !== keys.has(key)) {
        into.set(key, member);
      }
    }
    return;
  }
  if (SHARED.has(base)) {
    for (const key of [...membersOf(base, new Set()).keys(), ...sharedBases(base)]) {
      shared.add(key);
    }
    return;
  }
  addAll(into, membersOf(base, shared));
}

/** Every member a shared interface brings, through its own bases. */
function sharedBases(name: string): string[] {
  const decl = file().decls.get(name);
  const names: string[] = [];
  for (const heritage of (decl?.extends as Node[] | undefined) ?? []) {
    const base = text((heritage.expression ?? heritage.typeName) as Node);
    names.push(...membersOf(base, new Set()).keys(), ...sharedBases(base));
  }
  return names;
}

/** The property signatures of an interface body or a type literal. */
function membersOfBody(members: readonly Node[]): Map<string, OptionDoc> {
  const out = new Map<string, OptionDoc>();
  for (const member of members) {
    if (member.type !== 'TSPropertySignature' && member.type !== 'TSMethodSignature') {
      continue;
    }
    const key = member.key as Node & { name?: string; value?: string };
    const name = key.name ?? key.value ?? text(key);
    const doc = docBefore(member.start);
    const annotation = (member.typeAnnotation as { typeAnnotation?: Node } | undefined)
      ?.typeAnnotation;
    const type =
      member.type === 'TSMethodSignature'
        ? text(member).slice(text(key).length).replace(/;$/, '').trim()
        : annotation
          ? text(annotation)
          : 'unknown';
    const fallback = defaultOf(doc);

    out.set(name, {
      description: firstParagraph(doc),
      ...(fallback ? { default: fallback } : {}),
      name,
      optional: member.optional === true,
      type: type.replace(/\s+/g, ' '),
    });
  }
  return out;
}

/**
 * The API of one exported component.
 *
 * @param exported - The function or the element, as `@ttylabs/sigil/components` exports it.
 * @returns Its declaration and its options.
 */
export function componentApi(exported: string): ComponentApi {
  const decl = file().decls.get(exported);
  if (!decl) {
    throw new Error(`${exported} is not declared in dist/components.d.mts: is it built?`);
  }

  if (decl.type !== 'TSDeclareFunction' && decl.type !== 'FunctionDeclaration') {
    // a value, like `log`: its type is the API, and it has no options parameter
    return { options: [], shared: [], signature: text(decl).replace(/^declare\s+/, '') };
  }

  const params = (decl.params as { items?: Node[] } | Node[]) ?? [];
  const list = Array.isArray(params) ? params : (params.items ?? []);
  const param = list.find((it) => ['opts', 'props'].includes(text(it).split(/[?:]/)[0]!.trim()));
  const annotation = (param?.typeAnnotation as { typeAnnotation?: Node } | undefined)
    ?.typeAnnotation;
  const interfaceName =
    annotation?.type === 'TSTypeReference' ? text(annotation.typeName as Node) : undefined;

  const shared = new Set<string>();
  const options = interfaceName ? [...membersOf(interfaceName, shared).values()] : [];
  const signature = text(decl)
    .replace(/^(export\s+)?declare\s+/, '')
    .replace(/;$/, '')
    .replace(/\s+/g, ' ');

  return {
    ...(interfaceName ? { interface: interfaceName } : {}),
    options: options.toSorted(
      // what has to be given first, then the rest by name
      (a, b) => Number(a.optional) - Number(b.optional) || a.name.localeCompare(b.name)
    ),
    shared: [...shared].filter((name) => !options.some((it) => it.name === name)).sort(),
    signature,
  };
}
