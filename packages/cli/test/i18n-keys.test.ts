import { bindingName, importBindings } from '../src/build/bindings.ts';
import { keysIn } from '../src/build/i18n.ts';
import { MODULE_RE, parseModule } from '../src/build/parse-module.ts';
import { walk } from '../src/build/walk.ts';
import { SIGIL_KEYS, SIGIL_PLURAL_KEYS } from '@ttylabs/sigil/i18n-keys';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Node } from 'oxc-parser';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..', 'sigil', 'src');
const tag = join(root, 'i18n', 'index.ts');
const generated = join(root, 'i18n', 'keys.ts');

/** Every module under the runtime's `src/`, bar the i18n module itself. */
function* modules(dir: string): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
    a.name < b.name ? -1 : 1
  )) {
    const path = join(dir, entry.name);

    if (entry.isDirectory()) {
      yield* modules(path);
    } else if (MODULE_RE.test(entry.name) && path !== tag && path !== generated) {
      yield path;
    }
  }
}

/** The specifier a module reaches the tag by, which depends on how deep it is. */
function specifierFrom(file: string): string {
  const rel = relative(dirname(file), tag).replaceAll('\\', '/').replace(/\.ts$/, '.js');

  return rel.startsWith('.') ? rel : `./${rel}`;
}

/** A module as a finding names it: under `src/` when it is a real one. */
function named(file: string): string {
  return isAbsolute(file) ? relative(root, file) : file;
}

/** Whether a node is `new TypeError(...)` or `new RangeError(...)`. */
function isProgrammingError(node: Node): node is Node & { type: 'NewExpression' } {
  return (
    node.type === 'NewExpression' &&
    node.callee.type === 'Identifier' &&
    (node.callee.name === 'TypeError' || node.callee.name === 'RangeError')
  );
}

/** Every function in a module with a name, by that name: a declaration or a bound arrow. */
function namedFunctions(parsed: ReturnType<typeof parseModule>): Map<string, Node> {
  const found = new Map<string, Node>();

  walk(parsed.program, (node) => {
    if (node.type === 'FunctionDeclaration' && node.id) {
      found.set(node.id.name, node);
    } else if (
      node.type === 'VariableDeclarator' &&
      node.id.type === 'Identifier' &&
      (node.init?.type === 'ArrowFunctionExpression' || node.init?.type === 'FunctionExpression')
    ) {
      found.set(node.id.name, node.init);
    }

    return true;
  });

  return found;
}

/** The name each parameter binds, by position, where a parameter is a plain name. */
function parameterNames(fn: Node): (string | undefined)[] {
  return (fn as { params: Node[] }).params.map((param) => {
    const plain = param.type === 'AssignmentPattern' ? param.left : param;

    return plain.type === 'Identifier' ? plain.name : undefined;
  });
}

/** Every `__` tag written anywhere inside a node, as the source text of the tag. */
function tagsIn(node: Node, source: string, tags: ReturnType<typeof importBindings>): string[] {
  const found: string[] = [];

  walk(node, (inner) => {
    if (inner.type === 'TaggedTemplateExpression' && bindingName(inner.tag, tags) !== undefined) {
      found.push(source.slice(inner.start, inner.end));
    }

    return true;
  });

  return found;
}

/**
 * Every `__` tag that reaches a `TypeError` or a `RangeError` by a helper.
 *
 * The constructor rule above sees a tag written inside the call. Two shapes put
 * the message somewhere else, and both are read off the tree rather than listed:
 *
 * - A function that **throws what it is handed** -- a parameter passed straight
 *   to `new TypeError(message)`, as `controlFlag()` and `finite()` do. A call to a
 *   function of that name with a tag in **that argument** is a tagged message;
 *   in another it is not, since `describeControls()` throws its last parameter
 *   and takes a callback that tags key descriptions.
 * - A function that **builds the message** -- `new TypeError(name(...))`, as
 *   `hiddenTypeMessage()` does. A tag anywhere in that function is one.
 *
 * Both match a callee by its name across the whole tree and not by the module it
 * was imported from. That is a rule that can only over-reach: two unrelated
 * functions sharing a name fail it loudly, where following imports would be the
 * place a tag slips past. A message built into a variable first, or returned from
 * a method, is still not seen.
 *
 * @param modules - Every module, with the specifier it reaches the tag by.
 */
function taggedThroughHelpers(
  modules: { file: string; source: string; from?: string }[]
): string[] {
  const parsedModules = modules.map(({ file, source, from }) => {
    const parsed = parseModule(file, source);

    return {
      file,
      source,
      parsed,
      tags: importBindings(parsed, from ?? '@ttylabs/sigil/i18n', '__'),
      functions: namedFunctions(parsed),
    };
  });

  const throwers = new Map<string, Set<number>>();
  const builders = new Set<string>();

  for (const { parsed, functions } of parsedModules) {
    for (const [name, fn] of functions) {
      const params = parameterNames(fn);

      walk(fn, (node) => {
        if (isProgrammingError(node)) {
          const [message] = node.arguments;

          const at = message?.type === 'Identifier' ? params.indexOf(message.name) : -1;

          if (at !== -1) {
            throwers.set(name, (throwers.get(name) ?? new Set()).add(at));
          }
        }

        return true;
      });
    }

    walk(parsed.program, (node) => {
      if (isProgrammingError(node)) {
        const [message] = node.arguments;

        if (message?.type === 'CallExpression' && message.callee.type === 'Identifier') {
          builders.add(message.callee.name);
        }
      }

      return true;
    });
  }

  const found: string[] = [];

  for (const { file, source, parsed, tags, functions } of parsedModules) {
    walk(parsed.program, (node) => {
      if (node.type === 'CallExpression' && node.callee.type === 'Identifier') {
        const callee = node.callee.name;

        // only the argument that is thrown: `describeControls()` takes a callback
        // that tags the key descriptions it returns, which are no error
        for (const at of throwers.get(callee) ?? []) {
          for (const argument of node.arguments.slice(at, at + 1)) {
            found.push(
              ...tagsIn(argument, source, tags).map((text) => `${named(file)}: ${callee}(${text})`)
            );
          }
        }
      }

      return true;
    });

    for (const name of builders) {
      const fn = functions.get(name);

      if (fn) {
        found.push(
          ...tagsIn(fn, source, tags).map((text) => `${named(file)}: ${name}() builds ${text}`)
        );
      }
    }
  }

  return found;
}

/** The keys the framework's source declares, read the way the generator reads them. */
function fromSource(): { plurals: string[]; strings: string[] } {
  const plurals = new Set<string>();
  const strings = new Set<string>();

  for (const file of modules(root)) {
    const source = readFileSync(file, 'utf8');

    if (!source.includes('__`') && !source.includes('__n(')) {
      continue;
    }

    for (const found of keysIn(parseModule(file, source), { from: specifierFrom(file) })) {
      (found.kind === 'plural' ? plurals : strings).add(found.key);
    }
  }

  return { plurals: [...plurals].sort(), strings: [...strings].sort() };
}

/**
 * Every `__` tag written inside a `new TypeError(...)` or `new RangeError(...)`.
 *
 * Read off the tree the way the generator reads it, so the tag is whatever the
 * module imported from the i18n module rather than the two characters `__`.
 */
function taggedProgrammingErrors(file: string, source: string, from?: string): string[] {
  const parsed = parseModule(file, source);
  const tags = importBindings(parsed, from ?? '@ttylabs/sigil/i18n', '__');
  const found: string[] = [];

  walk(parsed.program, (node) => {
    if (
      node.type === 'NewExpression' &&
      node.callee.type === 'Identifier' &&
      (node.callee.name === 'TypeError' || node.callee.name === 'RangeError')
    ) {
      walk(node, (inner) => {
        if (
          inner.type === 'TaggedTemplateExpression' &&
          bindingName(inner.tag, tags) !== undefined
        ) {
          found.push(source.slice(inner.start, inner.end));
        }

        return true;
      });
    }

    return true;
  });

  return found;
}

describe('the committed key set', () => {
  // the shape `the committed utility sheet` already has, and for its reason:
  // the generator and its output are two files, so a key added to the source
  // without a regeneration is a key `sigil check` never mentions -- which is
  // silence in exactly the place the whole build-time check exists to break
  it('should hold every key the framework`s source declares', () => {
    const { plurals, strings } = fromSource();

    expect([...SIGIL_KEYS].sort()).toEqual([...new Set([...strings, ...plurals])].sort());
  });

  it('should name the plural keys, and only those', () => {
    expect([...SIGIL_PLURAL_KEYS].sort()).toEqual(fromSource().plurals);
  });

  it('should be sorted, so that two regenerations are one file', () => {
    expect([...SIGIL_KEYS]).toEqual([...SIGIL_KEYS].sort());
    expect([...SIGIL_PLURAL_KEYS]).toEqual([...SIGIL_PLURAL_KEYS].sort());
  });

  it('should repeat nothing', () => {
    expect(SIGIL_KEYS).toHaveLength(new Set(SIGIL_KEYS).size);
  });

  it('should hold the keys a reader would check by hand', () => {
    // a handful named outright, because an assertion that only compares two
    // derived lists passes if both derivations break the same way
    expect(SIGIL_KEYS).toContain('Unknown option "{0}"');
    expect(SIGIL_KEYS).toContain('Invalid value "{0}" for {1}');
    expect(SIGIL_KEYS).toContain('Usage:');
    expect(SIGIL_KEYS).toContain('option {0}');
    // seven: the multiline field's log line counts lines -- `Alias:` was the
    // only plural until SIG-135 -- SIG-203's tasks count the failures a
    // `failFast: false` list rejects with and the running rows a frame cut,
    // SIG-177's line form of the multiline field says its character limit,
    // SIG-241's line path() says how many candidates it is asking to list, and
    // SIG-480's treemap counts the items a tile gathers
    expect(SIGIL_PLURAL_KEYS).toEqual([
      '(+{0} more line)',
      '(at most {0} character)',
      'Alias:',
      'Display {0} possibility?',
      '{0} more',
      '{0} task failed',
      '… {0} more running',
    ]);
  });

  // SIG-658: 175 of them were in the table, tagged with `__` one component at a
  // time, and they were most of why the i18n-keys entry doubled. SIG-53 decided
  // the developer-facing errors stay English -- a translated `Expected option
  // choices to be an array` is a bug report in a language the maintainer cannot
  // read -- and `the committed key set` above could not say so, since it only
  // asks that the table equal the source. `Expected ...` is the spelling every
  // one of them used, so it is the spelling this looks for. The one exception is
  // a user's mistake rather than a developer's, which `src/config/AGENTS.md`
  // lists by name as translated: a config file holding a scalar where the schema
  // declares a list
  it('should hold no developer error', () => {
    expect(SIGIL_KEYS.filter((key) => key.startsWith('Expected '))).toEqual([
      'Expected a list of values',
    ]);
  });

  // SIG-668: the test above is a convention -- `Expected ` is how most of them
  // begin -- and five more had been tagged under other words. This is the other
  // half, and it is a rule rather than a spelling: a `TypeError` or a
  // `RangeError` is the runtime saying a caller handed it something it cannot
  // use, which is a mistake in the app's code and never in its user's argv, so
  // its reader is the developer and SIG-53's decision applies. A user's mistake
  // is a `UsageError` or an `Error` (a `PromptError`, a config layer's refusal),
  // which this leaves alone: 87 tagged `new Error(...)` sites were read for it and
  // are not all one kind, so no rule over them is made here (SIG-677 read all 92 and
  // found one that is only ever a developer's, which lost its tag)
  //
  // what it reads is a tag lexically inside the constructor's call. A tag handed to
  // a helper that throws, or built by a helper, is the next test; one built into a
  // variable first is still not seen, and a file that never writes the two
  // characters is skipped unread. No such site exists today; the `Expected ` test
  // above is the other net
  it('should tag no TypeError or RangeError', () => {
    const tagged: string[] = [];

    for (const file of modules(root)) {
      const source = readFileSync(file, 'utf8');

      if (!source.includes('__`')) {
        continue;
      }

      for (const text of taggedProgrammingErrors(file, source, specifierFrom(file))) {
        tagged.push(`${relative(root, file)}: ${text}`);
      }
    }

    expect(tagged).toEqual([]);
  });

  // SIG-677: `controlFlag()` and `finite()` throw the message they are handed and
  // `hiddenTypeMessage()` builds one, so a tag written at their call sites or in
  // their body reaches a `TypeError` without being inside the constructor's call.
  // None does today
  it('should tag no message a helper throws as a TypeError or RangeError', () => {
    const everything = [...modules(root)].map((file) => ({
      file,
      source: readFileSync(file, 'utf8'),
      from: specifierFrom(file),
    }));

    expect(taggedThroughHelpers(everything)).toEqual([]);
  });

  it('should see a tag handed to a helper that throws it, and one a helper builds', () => {
    const call = "import { __ } from '@ttylabs/sigil/i18n';\n";
    const helper = 'function flag(v: unknown, message: string) { throw new TypeError(message); }\n';
    const build = 'function say(x: string) { return __`Bad ${x}`; }\n';

    expect(
      taggedThroughHelpers([
        { file: 'a.ts', source: `${call}${helper}flag(1, __\`Bad\`);\n` },
        { file: 'b.ts', source: `${call}${build}throw new RangeError(say('x'));\n` },
      ])
    ).toEqual(['a.ts: flag(__`Bad`)', 'b.ts: say() builds __`Bad ${x}`']);
    // the helper in one module and the call in another, and a helper bound to an
    // arrow with a default on the parameter: the shapes of the real ones that the
    // fixtures above are not
    expect(
      taggedThroughHelpers([
        {
          file: 'e.ts',
          source: `export const arrow = (v: unknown, message = 'x') => { throw new RangeError(message); };\n`,
        },
        { file: 'f.ts', source: `${call}arrow(1, __\`Bad\`);\n` },
      ])
    ).toEqual(['f.ts: arrow(__`Bad`)']);
    // a tag handed to a function that does not throw it, or to a parameter of one
    // that is not the one thrown, is no finding
    expect(
      taggedThroughHelpers([
        {
          file: 'c.ts',
          source: `${call}function show(m: string) { return m; }\nshow(__\`Ok\`);\n`,
        },
        {
          file: 'd.ts',
          source: `${call}function two(a: unknown, m: string) { throw new TypeError(m); }\ntwo(__\`Ok\`, 'plain');\n`,
        },
      ])
    ).toEqual([]);
  });

  it('should see a tag inside a TypeError, so that the test above can fail', () => {
    const call = "import { __ } from '@ttylabs/sigil/i18n';\n";

    expect(
      taggedProgrammingErrors('a.ts', `${call}throw new TypeError(__\`Bad ${'${x}'}\`);\n`)
    ).toEqual(['__`Bad ${x}`']);
    expect(
      taggedProgrammingErrors('a.ts', `${call}throw new RangeError(a ? __\`One\` : 'two');\n`)
    ).toEqual(['__`One`']);
    expect(taggedProgrammingErrors('a.ts', `${call}throw new Error(__\`Bad\`);\n`)).toEqual([]);
  });

  it('should number a slot per interpolation, never name one', () => {
    // the tag hands over values rather than names, so a key with a `{name}` in
    // it is a key nothing will ever look up
    for (const key of SIGIL_KEYS) {
      expect(key.match(/\{[^}]*\}/g) ?? [], key).toEqual(
        (key.match(/\{[^}]*\}/g) ?? []).filter((slot) => /^\{\d+\}$/.test(slot))
      );
    }
  });
});

// SIG-579: a plural written through a wrapper that erases is the same call
describe.each([
  ['<T>', (callee: string) => `<Type>${callee}`],
  ['as', (callee: string) => `${callee} as Type`],
  ['satisfies', (callee: string) => `${callee} satisfies Type`],
  ['!', (callee: string) => `${callee}!`],
])('a plural written under %s', (_wrapper, wrap) => {
  it('should still be found', () => {
    const source = `import { __n } from '@ttylabs/sigil/i18n';\nexport const s = (${wrap('__n')})(2, 'one', 'many');\n`;

    expect(keysIn(parseModule('app.ts', source)).map((found) => found.key)).toEqual(['one']);
  });
});

const PLURAL = "import { __n } from '@ttylabs/sigil/i18n';\n";
const PLURAL_NAMESPACE = "import * as i from '@ttylabs/sigil/i18n';\n";

// SIG-588, SIG-589: `fn<T>` is type syntax that erases, and so is a wrapper on the
// namespace object of `i.__n(...)`, so each is the same call and its key was not
// found. SIG-590: an optional call is a `CallExpression` inside a chain, which the
// walk reaches on its own -- pinned
describe.each([
  ['an instantiation', PLURAL, '(__n<Type>)'],
  ['a namespace under as', PLURAL_NAMESPACE, '(i as any).__n'],
  ['a namespace under !', PLURAL_NAMESPACE, 'i!.__n'],
  ['a namespace under <T>', PLURAL_NAMESPACE, '(<any>i).__n'],
  ['a namespace under satisfies', PLURAL_NAMESPACE, '(i satisfies object).__n'],
  ['an optional call', PLURAL, '__n?.'],
  ['an optional namespace member', PLURAL_NAMESPACE, 'i?.__n'],
])('a plural called through %s', (_what, preamble, callee) => {
  it('should still be found', () => {
    const source = `${preamble}export const s = ${callee}(2, 'one', 'many');\n`;

    expect(keysIn(parseModule('app.ts', source)).map((found) => found.key)).toEqual(['one']);
  });
});

// SIG-589: the tag readers are deliberately not changed -- a wrapped tag is not
// recognised, because rewriting a template that might not be ours is the louder
// failure (packages/cli/AGENTS.md). `calleeName()` is for callees only
describe('a translated tag', () => {
  const keys = (tag: string): string[] =>
    keysIn(
      parseModule(
        'app.ts',
        `import { __ } from '@ttylabs/sigil/i18n';\nimport * as i from '@ttylabs/sigil/i18n';\nexport const s = ${tag}\`Build the app\`;\n`
      )
    ).map((found) => found.key);

  it.each([['__'], ['i.__'], ['(i.__)']])('should be found written as %s', (tag) => {
    expect(keys(tag)).toEqual(['Build the app']);
  });

  it.each([['(i as any).__'], ['i!.__'], ['(<any>i).__'], ['(__<Type>)']])(
    'should still not be found written as %s',
    (tag) => {
      expect(keys(tag)).toEqual([]);
    }
  );
});
