import { schemasWith, sealedObject } from '../../src/build/bindings.ts';
import { flatten, PLACEHOLDER_KEYS, propertyKey } from '../../src/build/literals.ts';
import { parseModule } from '../../src/build/parse-module.ts';
import type { ObjectExpression, ObjectProperty } from 'oxc-parser';
import { describe, expect, it } from 'vitest';

/** The keys a module's `base` is read as, or `undefined` where the build refuses to read it. */
function sealedKeys(source: string, name = 'base'): string[] | undefined {
  const object = sealedObject(parseModule('/virtual/schema.ts', source), name);
  return object?.properties.map((member) =>
    member.type === 'SpreadElement' ? '...' : (propertyKey(member) ?? '[computed]')
  );
}

describe('a same-module const a spread may be resolved through', () => {
  it('should resolve a const that is only ever spread', () => {
    // SIG-440. The one shape the build reads: a name that nothing can have changed
    expect(
      sealedKeys(`const base = { hidden: true, path: './a.js' };
export default { commands: { x: { ...base }, y: { ...(base), desc: 'y' }, z: { ...base!, ...base } } };`)
    ).toEqual(['hidden', 'path']);
    // ...in a nested literal and under a type assertion as well
    expect(
      sealedKeys(`const base = { hidden: true };
export default { commands: { x: { ...{ ...(base as object) } } } };`)
    ).toEqual(['hidden']);
    // ...and with no use at all, which is not a reason to refuse it
    expect(sealedKeys(`const base = { hidden: true };`)).toEqual(['hidden']);
  });

  it.each([
    // [what is wrong with it, the module]
    ['a reassignment', `const base = { a: 1 };\nbase = {};\nexport default { ...base };`],
    [
      'a member assignment',
      `const base = { a: 1 };\nbase.path = './x.js';\nexport default { ...base };`,
    ],
    [
      'a computed member assignment',
      `const base = { a: 1 };\nbase['path'] = './x.js';\nexport default { ...base };`,
    ],
    ['an update', `const base = { a: 1 };\nbase.count++;\nexport default { ...base };`],
    ['a delete', `const base = { a: 1 };\ndelete base.a;\nexport default { ...base };`],
    [
      'a destructuring assignment',
      `const base = { a: 1 };\n({ x: base.path } = { x: './x.js' });\nexport default { ...base };`,
    ],
    [
      'Object.assign',
      `const base = { a: 1 };\nObject.assign(base, { path: './x.js' });\nexport default { ...base };`,
    ],
    ['a call', `const base = { a: 1 };\nmutate(base);\nexport default { ...base };`],
    [
      'Object.defineProperty',
      `const base = { a: 1 };\nObject.defineProperty(base, 'path', { value: 'x' });\nexport default { ...base };`,
    ],
    [
      'a spread into a call',
      `const base = { a: 1 };\nmutate(...[base]);\nexport default { ...base };`,
    ],
    [
      'an alias of it',
      `const base = { a: 1 };\nconst same = base;\nsame.path = './x.js';\nexport default { ...base };`,
    ],
    [
      'a closure over it',
      `const base = { a: 1 };\nconst fix = () => { base.path = './x.js'; };\nfix();\nexport default { ...base };`,
    ],
    [
      'a closure called before it is declared',
      `fix();\nfunction fix() { base.path = './x.js'; }\nconst base = { a: 1 };\nexport default { ...base };`,
    ],
    ['a member read', `const base = { a: 1 };\nconsole.log(base.a);\nexport default { ...base };`],
    ['an array spread', `const base = { a: 1 };\nexport default { ...base, list: [...base] };`],
    ['a use as a value', `const base = { a: 1 };\nexport default { ...base, again: base };`],
    ['a shorthand property', `const base = { a: 1 };\nexport default { ...base, base };`],
    ['an export', `export const base = { a: 1 };\nexport default { ...base };`],
    ['a named export', `const base = { a: 1 };\nexport { base };\nexport default { ...base };`],
    ['a default export', `const base = { a: 1 };\nexport default base;`],
    [
      'a renamed export',
      `const base = { a: 1 };\nexport { base as common };\nexport default { ...base };`,
    ],
    [
      'a type query',
      `const base = { a: 1 };\ntype Base = typeof base;\nexport default { ...base };`,
    ],
    ['a let', `let base = { a: 1 };\nexport default { ...base };`],
    ['a var', `var base = { a: 1 };\nexport default { ...base };`],
    ['an import', `import { base } from './base.js';\nexport default { ...base };`],
    ['an unbound name', `export default { ...base };`],
    [
      'a parameter of the same name',
      `const base = { a: 1 };\nexport const f = (base) => ({ ...base });\nexport default { ...base };`,
    ],
    [
      'a block binding of the same name',
      `const base = { a: 1 };\n{ let base = { path: './x.js' }; var x = { ...base }; }\nexport default { ...base };`,
    ],
    [
      'a function of the same name',
      `const base = { a: 1 };\nexport function wrap() { function base() {} return { ...base }; }\nexport default { ...base };`,
    ],
    [
      'a catch parameter of the same name',
      `const base = { a: 1 };\ntry {} catch (base) {}\nexport default { ...base };`,
    ],
    [
      'a declaration in a function',
      `function make() { const base = { a: 1 }; return { ...base }; }\nexport default make();`,
    ],
    ['a call result', `const base = freeze({ a: 1 });\nexport default { ...base };`],
    ['a command() wrapper', `const base = command({ a: 1 });\nexport default { ...base };`],
    ['a name', `const other = { a: 1 };\nconst base = other;\nexport default { ...base };`],
    [
      'a spread of a spread',
      `const other = { a: 1 };\nconst base = { ...other };\nexport default { ...base };`,
    ],
    ['a getter', `const base = { get path() { return './x.js'; } };\nexport default { ...base };`],
    ['a setter', `const base = { set path(v) {} };\nexport default { ...base };`],
    [
      'a computed key',
      `const key = 'path';\nconst base = { [key]: './x.js' };\nexport default { ...base };`,
    ],
    ['a __proto__', `const base = { __proto__: { path: './x.js' } };\nexport default { ...base };`],
    [
      'an array value',
      `const base = { alias: ['b'] };\nconst copy = { ...base };\ncopy.alias.push('zz');\nexport default { ...base };`,
    ],
    [
      'a commands wrapped in a call, which is read as the literal it holds',
      `const base = { commands: command({ a: './a.js' }) };\nexport default { ...base };`,
    ],
    ['an object value', `const base = { commands: { a: './a.js' } };\nexport default { ...base };`],
    [
      'an array value under a type assertion',
      `const base = { alias: ['b'] as string[] };\nexport default { ...base };`,
    ],
    ['a spread above the declaration', `export default { ...base };\nconst base = { a: 1 };`],
    [
      'a direct eval',
      `const base = { a: 1 };\neval("base.path = './x.js'");\nexport default { ...base };`,
    ],
    [
      'a with statement',
      `const base = { a: 1 };\nwith (other) { var x = 1; }\nexport default { ...base };`,
    ],
    [
      'a destructured declaration',
      `const { base } = { base: { a: 1 } };\nexport default { ...base };`,
    ],
    [
      'a declaration in a class',
      `class Holder { static base = { a: 1 }; }\nexport default { ...base };`,
    ],
  ])('should refuse %s', (_what, source) => {
    expect(sealedKeys(source)).toBeUndefined();
  });

  it('should resolve a const carrying options, args, examples and hooks, which nothing reads', () => {
    // SIG-725. A shared base is most often one carrying `options`, and the build
    // names those keys without looking inside them, so a mutation of the shared
    // object changes nothing the build took off the placeholder
    expect(
      sealedKeys(`const base = {
  args: [{ name: 'target' }],
  examples: ['one', 'two'],
  hidden: true,
  hooks: { init() {} },
  options: { '--force': { type: 'bool' } },
};
export default { ...base };`)
    ).toEqual(['args', 'examples', 'hidden', 'hooks', 'options']);
  });

  it.each(['alias', 'commands', 'default', 'desc', 'hidden', 'load', 'name', 'path'])(
    'should refuse a %s that is an array or an object, which the build reads',
    (key) => {
      // the keys whose value the build reads are the ones a shared array or object
      // can change under it: `{ ...base }.alias.push('x')` writes the const's own
      expect(
        sealedKeys(`const base = { ${key}: [] };\nexport default { ...base };`)
      ).toBeUndefined();
      expect(
        sealedKeys(`const base = { ${key}: {} };\nexport default { ...base };`)
      ).toBeUndefined();
      expect(
        sealedKeys(`const base = { '${key}': ([] as string[]) };\nexport default { ...base };`)
      ).toBeUndefined();
    }
  );

  it('should resolve a const whose key the build reads holds a call around an object', () => {
    // only the nested `commands` read looks through a call, so a `desc` that is a
    // call with an object argument shares nothing the build reads
    expect(
      sealedKeys(
        `const base = { desc: t({ id: 'x' }), load: lazy(() => ({})) };\nexport default { ...base };`
      )
    ).toEqual(['desc', 'load']);
  });

  it('should read what each key the build reads is, so a key added to one is added to the other', () => {
    // the placeholder's seven keys and `commands` are asked by name in
    // `holdsReadObject()`; a key the build starts reading is a key it has to ask
    // about, and this is the list a reviewer is shown
    expect([...PLACEHOLDER_KEYS].sort()).toEqual([
      'alias',
      'default',
      'desc',
      'hidden',
      'load',
      'name',
      'path',
    ]);
  });

  it('should place a resolved const where it was spread, at every depth', () => {
    // SIG-725. The members are the const's own text, and the position a
    // diagnostic about one reports is the spread the author wrote
    const source = [
      `const base = { desc: async () => 'x', name: 'later' };`,
      ``,
      `export default {`,
      `  path: './a.js',`,
      `  ...base,`,
      `};`,
    ].join('\n');
    const parsed = parseModule('/virtual/place.js', source);
    const exported = parsed.program.body.find((node) => node.type === 'ExportDefaultDeclaration');
    const object = exported?.declaration as never as Parameters<typeof flatten>[0];
    const spread = source.indexOf('...base');
    const members = flatten(object, (name) => sealedObject(parsed, name));

    expect(
      members.map((member) => (member.type === 'SpreadElement' ? '...' : propertyKey(member)))
    ).toEqual(['path', 'desc', 'name']);
    const [, desc, name] = members as ObjectProperty[];
    for (const node of [
      desc!,
      desc!.value,
      (desc!.value as { body: { start: number } }).body,
      name!,
      name!.value,
    ]) {
      expect(node.start).toBe(spread);
    }

    // the tree itself is not touched, since it is shared by every pass
    const declared = parsed.program.body[0] as { declarations: { init: ObjectExpression }[] };
    expect(declared.declarations[0]!.init.properties[0]!.start).toBeLessThan(spread);
  });

  it('should refuse a name a JSX expression reads a member of', () => {
    const parsed = parseModule(
      '/virtual/view.tsx',
      `const base = { a: 1 };\nconst el = <base.a />;\nexport default { ...base };`
    );
    expect(sealedObject(parsed, 'base')).toBeUndefined();
  });

  it('should refuse a name nothing here can tell from a literal, when a literal spread is read', () => {
    // what `flatten()` does with the answer: a refused name stays a spread, which
    // `mayCarry()` says may carry anything -- the refusal this narrows
    const parsed = parseModule(
      '/virtual/refused.js',
      `const base = { hidden: true };\nbase.path = './x.js';\nexport default { ...base, desc: 'x' };`
    );
    const exported = parsed.program.body.find((node) => node.type === 'ExportDefaultDeclaration');
    const object = exported?.declaration as never as Parameters<typeof flatten>[0];
    const members = flatten(object, (name) => sealedObject(parsed, name));
    expect(members.map((member) => member.type)).toEqual(['SpreadElement', 'Property']);
  });

  it('should read a resolved const where it was spread, in the order the object has', () => {
    const parsed = parseModule(
      '/virtual/order.js',
      `const base = { path: './a.js', hidden: true };\nexport default { desc: 'x', ...base, path: './b.js' };`
    );
    const exported = parsed.program.body.find((node) => node.type === 'ExportDefaultDeclaration');
    const object = exported?.declaration as never as Parameters<typeof flatten>[0];
    const keys = flatten(object, (name) => sealedObject(parsed, name)).map((member) =>
      member.type === 'SpreadElement' ? '...' : propertyKey(member)
    );
    expect(keys).toEqual(['desc', 'path', 'hidden', 'path']);
  });
});

describe('the schemas a module has once a shared base is not counted as one', () => {
  /** The `commands` literals counted as schemas, by the first key each holds. */
  const schemas = (source: string): string[] =>
    schemasWith(parseModule('/virtual/schema.ts', source), 'commands').map((object) =>
      source.slice(object.start, object.end).replace(/\s+/g, ' ').slice(0, 24)
    );

  it('should leave out a const that is only spread into another literal that has the key', () => {
    // SIG-728
    expect(
      schemas(`const base = { commands: { a: './a.js' } };
export default { ...base, commands: { b: './b.js' } };`)
    ).toEqual(['{ ...base, commands: { b']);
    // ...at any depth, which is where a placeholder's spread sits
    expect(
      schemas(`const base = { commands: { a: './a.js' } };
export default { commands: { x: { ...base, path: './x.js' } } };`)
    ).toEqual(['{ commands: { x: { ...ba']);
    // ...whether or not the build could read what it holds
    expect(
      schemas(`const base = { commands: './commands' };
export default { ...base, commands: { b: './b.js' } };`)
    ).toEqual(['{ ...base, commands: { b']);
  });

  it('should read a schema that has the key only through a sealed spread', () => {
    // the literal is the schema although it spells no `commands`; the base is what
    // it spreads and not a second one
    expect(
      schemas(`const base = { commands: './commands' };
export default { ...base, name: 'app' };`)
    ).toEqual(["{ ...base, name: 'app' }"]);
  });

  it.each([
    ['a let', `let base = { commands: { a: './a.js' } };`],
    ['an export', `export const base = { commands: { a: './a.js' } };`],
    ['a call', `const base = { commands: { a: './a.js' } };\nmutate(base);`],
    ['a member read', `const base = { commands: { a: './a.js' } };\nbase.commands;`],
  ])('should keep %s as a schema of its own', (_what, declaration) => {
    expect(
      schemas(`${declaration}\nexport default { ...base, commands: { b: './b.js' } };`)
    ).toHaveLength(2);
  });

  it('should keep a const spread nowhere inside another literal that has the key', () => {
    // not spread at all, and spread into something that is no schema: it is the
    // only object that has the key, so it is the schema
    expect(schemas(`const base = { commands: { a: './a.js' } };`)).toHaveLength(1);
    expect(
      schemas(`const base = { commands: { a: './a.js' } };
const other = { ...base, name: 'x' };`)
    ).toHaveLength(1);
  });

  it('should keep a const that is also spread somewhere that is not a literal it found', () => {
    // SIG-728, review. One spread inside a literal that has the key is not every
    // spread: the real schema `{ ...base, run() {} }` cannot claim an unreadable
    // base, and dropping it because a helper literal spreads it would leave the
    // helper as the only schema there is
    const found = schemas(`const base = { commands: { a: './a.js' } };
const other = { commands: './unused', nested: { ...base } };
export default { ...base, run() {} };`);

    expect(found).toHaveLength(2);
  });

  it('should count two literals that spread one sealed base as two schemas, which is what they are', () => {
    // SIG-728, review. Both claim `commands` through the base, so the module has two
    // schemas and the build says it cannot choose. It used to read the base, which
    // was the one answer neither of them is
    expect(
      schemas(`const base = { commands: './commands' };
export const one = { ...base, name: 'one' };
export default { ...base, name: 'two' };`)
    ).toHaveLength(2);
  });
});
