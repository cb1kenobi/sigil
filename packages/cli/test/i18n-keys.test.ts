import { bindingName, importBindings } from '../src/build/bindings.ts';
import { keysIn } from '../src/build/i18n.ts';
import { MODULE_RE, parseModule } from '../src/build/parse-module.ts';
import { walk } from '../src/build/walk.ts';
import { SIGIL_KEYS, SIGIL_PLURAL_KEYS } from '@ttylabs/sigil/i18n-keys';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
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
  // are not all one kind, so no rule over them is made here
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
