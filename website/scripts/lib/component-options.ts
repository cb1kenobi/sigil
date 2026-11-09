import type { ComponentApi, OptionDoc } from '../../src/lib/component-data.ts';
import { readFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
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

/** The declarations, as built: the barrel, which re-exports every component's. */
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

/**
 * One declaration file, parsed once.
 *
 * One of several since SIG-330: a subpath per component puts each component's
 * declarations in a chunk of its own and the stack's in chunks they share, the
 * way the code is split, so `components.d.mts` is imports and one export list.
 * A name is followed from where it is used to where it is declared -- through
 * an import's alias, since a chunk exports `SpinnerOptions` as `d` -- and a
 * declaration is read in the file it is in, which is whose text and comments
 * its offsets are into.
 */
interface Module {
  readonly comments: readonly Comment[];
  /** What it declares, by the name it declares it under; the first wins. */
  readonly decls: Map<string, Node>;
  /** What it exports, by the exported name: the name it has here. */
  readonly exports: Map<string, string>;
  /** What it imports, by the name it has here: the file, and its name there. */
  readonly imports: Map<string, { readonly file: string; readonly name: string }>;
  readonly source: string;
}

/** A declaration, and the file it is written in. */
interface Decl {
  readonly mod: Module;
  readonly node: Node;
}

/** The name an identifier or a string literal in an import or export list spells. */
const nameOf = (node: unknown): string => {
  const it = node as { name?: string; value?: string };
  return it.name ?? it.value ?? '';
};

/** The declaration file a specifier in one names: `./x.mjs` is `./x.d.mts` to a type checker. */
const declarationFile = (from: string, spec: string): string =>
  join(dirname(from), spec.replace(/\.mjs$/, '.d.mts'));

/** Reads and parses one file. */
function load(file: string): Module {
  const source = readFileSync(file, 'utf-8');
  const parsed = parseSync(basename(file), source, { lang: 'dts' });
  const mod: Module = {
    comments: parsed.comments as unknown as Comment[],
    decls: new Map(),
    exports: new Map(),
    imports: new Map(),
    source,
  };

  for (const statement of parsed.program.body as unknown as Node[]) {
    const from = (statement.source as { value?: string } | null | undefined)?.value;
    const specifiers = (statement.specifiers as Node[] | undefined) ?? [];

    if (statement.type === 'ImportDeclaration' && from) {
      for (const it of specifiers) {
        mod.imports.set(nameOf(it.local), {
          file: declarationFile(file, from),
          name: it.type === 'ImportSpecifier' ? nameOf(it.imported) : 'default',
        });
      }
      continue;
    }
    if (statement.type === 'ExportNamedDeclaration' && !statement.declaration) {
      for (const it of specifiers) {
        const exported = nameOf(it.exported);
        if (from) {
          // `export { a as b } from`, which binds no local name: one is made up
          // for it that no declaration can have
          mod.imports.set(`\0${exported}`, {
            file: declarationFile(file, from),
            name: nameOf(it.local),
          });
          mod.exports.set(exported, `\0${exported}`);
        } else {
          mod.exports.set(exported, nameOf(it.local));
        }
      }
      continue;
    }

    const node = (
      statement.type === 'ExportNamedDeclaration' ? statement.declaration : statement
    ) as Node | undefined;
    const id =
      (node?.id as { name?: string } | undefined)?.name ??
      (node?.declarations as { id?: { name?: string } }[] | undefined)?.[0]?.id?.name;
    // the first declaration of a name wins: an overloaded function's first
    // signature is the one an editor shows first
    if (node && id && !mod.decls.has(id)) {
      mod.decls.set(id, node);
    }
    if (node && id && statement.type === 'ExportNamedDeclaration') {
      mod.exports.set(id, id);
    }
  }

  return mod;
}

/** Each file once it has been read. */
const modules = new Map<string, Module>();
const moduleAt = (file: string): Module => {
  let mod = modules.get(file);
  if (!mod) {
    mod = load(file);
    modules.set(file, mod);
  }
  return mod;
};

/** The declaration a name used in `mod` refers to, wherever it is written. */
function declared(mod: Module, local: string): Decl | undefined {
  const node = mod.decls.get(local);
  if (node) {
    return { mod, node };
  }
  const imported = mod.imports.get(local);
  return imported ? exportedFrom(moduleAt(imported.file), imported.name) : undefined;
}

/** The declaration a module exports under `name`. */
function exportedFrom(mod: Module, name: string): Decl | undefined {
  const local = mod.exports.get(name);
  return local === undefined ? undefined : declared(mod, local);
}

/** The name a declaration gives itself, whatever it was imported as. */
const declName = (decl: Decl): string =>
  (decl.node.id as { name?: string } | undefined)?.name ??
  (decl.node.declarations as { id?: { name?: string } }[] | undefined)?.[0]?.id?.name ??
  '';

/** The text of a node, in the file it is in. */
const text = (mod: Module, node: Node) => mod.source.slice(node.start, node.end);

/** The JSDoc directly above `at` in `mod`, with nothing but whitespace between. */
function docBefore(mod: Module, at: number): string {
  const { comments, source } = mod;
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
function keysOf(mod: Module, node: Node | undefined): Set<string> {
  return new Set(
    [...(node ? text(mod, node) : '').matchAll(/['"]([^'"]+)['"]/g)].map(([, key]) => key!)
  );
}

/**
 * The members of a type, its bases' first.
 *
 * @param decl - An interface or a type alias.
 * @param shared - Collects the shared mount options it reaches.
 * @returns The members, by name; a nearer declaration replaces a base's.
 */
function membersOf(decl: Decl | undefined, shared: Set<string>): Map<string, OptionDoc> {
  const out = new Map<string, OptionDoc>();
  if (!decl) {
    return out;
  }
  const { mod, node } = decl;

  if (node.type === 'TSInterfaceDeclaration') {
    for (const heritage of (node.extends as Node[] | undefined) ?? []) {
      addReference(mod, heritage, out, shared);
    }
    addAll(out, membersOfBody(mod, (node.body as { body: Node[] }).body));
  } else if (node.type === 'TSTypeAliasDeclaration') {
    addType(mod, node.typeAnnotation as Node, out, shared);
  }

  return out;
}

/** Copies `from` into `into`, the later winning. */
function addAll(into: Map<string, OptionDoc>, from: Map<string, OptionDoc>): void {
  for (const [key, member] of from) {
    into.set(key, member);
  }
}

/** Adds what a type in `mod` contributes: a reference, an intersection, or a literal. */
function addType(mod: Module, type: Node, into: Map<string, OptionDoc>, shared: Set<string>): void {
  if (type.type === 'TSTypeReference') {
    addReference(mod, type, into, shared);
  } else if (type.type === 'TSIntersectionType') {
    for (const part of type.types as Node[]) {
      addType(mod, part, into, shared);
    }
  } else if (type.type === 'TSTypeLiteral') {
    addAll(into, membersOfBody(mod, type.members as Node[]));
  }
}

/** Adds what a named base in `mod` contributes, through `Omit<>` and `Pick<>`. */
function addReference(
  mod: Module,
  ref: Node,
  into: Map<string, OptionDoc>,
  shared: Set<string>
): void {
  const typeName = (ref.typeName ?? ref.expression) as Node | undefined;
  const base = typeName ? text(mod, typeName) : '';
  const args = ((ref.typeArguments ?? ref.typeParameters) as { params?: Node[] } | undefined)
    ?.params;

  if ((base === 'Omit' || base === 'Pick') && args?.[0]) {
    const inner = new Map<string, OptionDoc>();
    addType(mod, args[0], inner, shared);
    const keys = keysOf(mod, args[1]);
    for (const [key, member] of inner) {
      if ((base === 'Omit') !== keys.has(key)) {
        into.set(key, member);
      }
    }
    return;
  }
  const decl = declared(mod, base);
  // by the name it declares itself under, which a chunk importing it may alias
  if (decl && SHARED.has(declName(decl))) {
    for (const key of [...membersOf(decl, new Set()).keys(), ...sharedBases(decl)]) {
      shared.add(key);
    }
    return;
  }
  addAll(into, membersOf(decl, shared));
}

/** Every member a shared interface brings, through its own bases. */
function sharedBases(decl: Decl): string[] {
  const names: string[] = [];
  for (const heritage of (decl.node.extends as Node[] | undefined) ?? []) {
    const base = declared(
      decl.mod,
      text(decl.mod, (heritage.expression ?? heritage.typeName) as Node)
    );
    if (base) {
      names.push(...membersOf(base, new Set()).keys(), ...sharedBases(base));
    }
  }
  return names;
}

/** The property signatures of an interface body or a type literal in `mod`. */
function membersOfBody(mod: Module, members: readonly Node[]): Map<string, OptionDoc> {
  const out = new Map<string, OptionDoc>();
  for (const member of members) {
    if (member.type !== 'TSPropertySignature' && member.type !== 'TSMethodSignature') {
      continue;
    }
    const key = member.key as Node & { name?: string; value?: string };
    const name = key.name ?? key.value ?? text(mod, key);
    const doc = docBefore(mod, member.start);
    const annotation = (member.typeAnnotation as { typeAnnotation?: Node } | undefined)
      ?.typeAnnotation;
    const type =
      member.type === 'TSMethodSignature'
        ? text(mod, member).slice(text(mod, key).length).replace(/;$/, '').trim()
        : annotation
          ? text(mod, annotation)
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
  const found = exportedFrom(moduleAt(DTS), exported);
  if (!found) {
    throw new Error(`${exported} is not declared in dist/components.d.mts: is it built?`);
  }
  const { mod, node: decl } = found;

  if (decl.type !== 'TSDeclareFunction' && decl.type !== 'FunctionDeclaration') {
    // a value, like `log`: its type is the API, and it has no options parameter
    return { options: [], shared: [], signature: text(mod, decl).replace(/^declare\s+/, '') };
  }

  const params = (decl.params as { items?: Node[] } | Node[]) ?? [];
  const list = Array.isArray(params) ? params : (params.items ?? []);
  const param = list.find((it) =>
    ['opts', 'props'].includes(text(mod, it).split(/[?:]/)[0]!.trim())
  );
  const annotation = (param?.typeAnnotation as { typeAnnotation?: Node } | undefined)
    ?.typeAnnotation;
  const interfaceName =
    annotation?.type === 'TSTypeReference' ? text(mod, annotation.typeName as Node) : undefined;

  const shared = new Set<string>();
  const options = interfaceName
    ? [...membersOf(declared(mod, interfaceName), shared).values()]
    : [];
  const signature = text(mod, decl)
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
