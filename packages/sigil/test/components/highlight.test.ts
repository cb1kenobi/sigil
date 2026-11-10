import { diff } from '../../src/components/diff.js';
import { CODE_LANGUAGES, codeLanguage, highlightCode } from '../../src/components/highlight.js';
import { markdown } from '../../src/components/markdown.js';
import { type HighlightSpan, multiline, tokensOf } from '../../src/components/prompt.js';
import { TextArea } from '../../src/components/text-area.js';
import { renderToString } from '../../src/element/index.js';
import { FRAMEWORK_CSS, TOKEN_ROLE, themedCascade } from '../../src/theme/index.js';
import { screenSetup, tick } from './helpers.js';
import { describe, expect, it } from 'vitest';

/**
 * `highlightCode()`: a lexer per language, and the four seams it feeds.
 *
 * Most of these read the spans as `[text, token]` pairs, which says what was
 * marked without anybody counting offsets by hand. The rest are the properties
 * every language has to keep -- in order, never overlapping, inside the code, and
 * linear on the inputs a lexer is classically quadratic on -- and the seams, each
 * handed `highlightCode` as it is.
 */

const ESC = String.fromCharCode(0x1b);

/** The marked stretches of some code, as the text and the token. */
function pairs(code: string, lang: string): [string, string][] {
  return highlightCode(code, lang).map((span) => [code.slice(span.start, span.end), span.token]);
}

/** The token a stretch of text was marked as, the first time it appears marked. */
function tokenOf(code: string, lang: string, text: string): string | undefined {
  return pairs(code, lang).find(([marked]) => marked === text)?.[1];
}

/** Something written in each language, touching most of what its lexer reads. */
const SAMPLES: Record<string, string> = {
  diff: [
    'diff --git a/x.ts b/x.ts',
    'index 1234..5678 100644',
    '--- a/x.ts',
    '+++ b/x.ts',
    '@@ -1,3 +1,3 @@ function f() {',
    ' context',
    '-old',
    '--- removed, not a header',
    '+new',
    '\\ No newline at end of file',
  ].join('\n'),
  js: [
    '#!/usr/bin/env node',
    "import { a } from 'b';",
    '// a comment',
    '/* a block',
    '   comment */',
    'const re = /ab+c[/]/gi, n = 0x1f + 1_000n + .5e-3;',
    'const t = `x ${a + `y ${b}`} z`;',
    'class Foo extends Bar { static x = null; }',
    'export default function f(x) { return x / 2 / g(this.default); }',
  ].join('\n'),
  json: '{\n  // a comment\n  "a": [1, -2.5e3, true, null],\n  "b": "c",\n  "d": oops\n}',
  markdown: [
    '# A title',
    '',
    'Some *em*, **strong**, `code` and a [link](https://x.dev).',
    '',
    '- item <https://y.dev>',
    '> quoted <!-- note -->',
    '',
    '```json',
    '{ "k": 1 }',
    '```',
    '',
    '---',
  ].join('\n'),
  sh: [
    '#!/bin/sh',
    'NAME=world # a comment',
    'for f in *.txt; do',
    '  echo "hello $NAME ${f%.txt}" \'raw $x\' 2>&1 | grep -v x',
    'done',
    'cat <<EOF',
    'body $x',
    'EOF',
    'if [ -n "$1" ]; then exit 1; fi',
  ].join('\n'),
  ts: [
    'interface A { b: string; type: number }',
    'type C = keyof A;',
    'export abstract class D implements A {}',
    'const e = f satisfies unknown as any;',
  ].join('\n'),
  yaml: [
    '--- # doc',
    'name: sigil',
    'version: 1.2',
    'on: true',
    'url: http://x.dev:80/a',
    'list:',
    '  - "quoted": yes',
    '  - &anchor !!str value',
    '  - *anchor',
    'flow: {a: 1, "b": [x, null]}',
    'script: |',
    '  echo one',
    '',
    '  echo two',
    'after: ~',
  ].join('\n'),
};

describe('highlightCode()', () => {
  describe('the languages', () => {
    it('should read every name a language goes by, and nothing it does not know', () => {
      expect(codeLanguage('TypeScript')).toBe('ts');
      expect(codeLanguage(' yml ')).toBe('yaml');
      expect(codeLanguage('mjs')).toBe('js');
      expect(codeLanguage('zsh')).toBe('sh');
      expect(codeLanguage('patch')).toBe('diff');
      expect(codeLanguage('md')).toBe('markdown');
      expect(codeLanguage('python')).toBeUndefined();
      expect(codeLanguage('constructor')).toBeUndefined();
      expect(codeLanguage(undefined)).toBeUndefined();
      for (const language of CODE_LANGUAGES) {
        expect(codeLanguage(language)).toBe(language);
      }
    });

    it('should mark nothing in a language it does not know, rather than guess', () => {
      expect(highlightCode('const a = 1', 'python')).toEqual([]);
      expect(highlightCode('const a = 1')).toEqual([]);
    });

    it.each(Object.keys(SAMPLES))(
      'should keep its %s spans in order, apart, inside the code and nameable',
      (lang) => {
        const code = SAMPLES[lang]!;
        const spans = highlightCode(code, lang);
        expect(spans.length).toBeGreaterThan(3);
        let last = 0;
        for (const span of spans) {
          expect(span.start).toBeGreaterThanOrEqual(last);
          expect(span.end).toBeGreaterThan(span.start);
          expect(span.end).toBeLessThanOrEqual(code.length);
          last = span.end;
        }
        // the validator every seam runs them through
        expect(() => tokensOf(code, spans)).not.toThrow();
      }
    );

    it('should give a role to every token it emits but the two Markdown leaves to a sheet', () => {
      const emitted = new Set(
        Object.entries(SAMPLES).flatMap(([lang, code]) =>
          highlightCode(code, lang).map((span) => span.token)
        )
      );
      const roleless = [...emitted].filter((token) => !TOKEN_ROLE.has(token)).sort();
      expect(roleless).toEqual(['emphasis', 'strong']);
    });

    it('should name only roles the framework sheet declares', () => {
      for (const role of new Set(TOKEN_ROLE.values())) {
        expect(FRAMEWORK_CSS, role).toContain(`.${role} {`);
      }
    });
  });

  describe('JavaScript and TypeScript', () => {
    const js = SAMPLES.js!;

    it('should read comments, the shebang and every kind of string', () => {
      expect(tokenOf(js, 'js', '#!/usr/bin/env node')).toBe('comment');
      expect(tokenOf(js, 'js', '// a comment')).toBe('comment');
      expect(tokenOf(js, 'js', '/* a block\n   comment */')).toBe('comment');
      expect(tokenOf(js, 'js', "'b'")).toBe('string');
    });

    it('should tell a regular expression from a division by what came before it', () => {
      expect(tokenOf(js, 'js', '/ab+c[/]/gi')).toBe('regexp');
      expect(pairs('a / b / c', 'js')).toEqual([]);
      expect(pairs('x = (a) / 2 / 3', 'js')).toEqual([
        ['2', 'number'],
        ['3', 'number'],
      ]);
      expect(pairs('return /x/.test(y)', 'js')).toEqual([
        ['return', 'keyword'],
        ['/x/', 'regexp'],
        ['test', 'function'],
      ]);
    });

    it('should read the code in a template hole, at any depth', () => {
      expect(pairs('`a ${b + `c ${d()}`} e`', 'js')).toEqual([
        ['`a ${', 'string'],
        ['`c ${', 'string'],
        ['d', 'function'],
        // two strings that touch are one span, which is the same cells
        ['}`} e`', 'string'],
      ]);
      expect(pairs('`${ {a: 1} }`', 'js')).toEqual([
        ['`${', 'string'],
        ['1', 'number'],
        ['}`', 'string'],
      ]);
    });

    it('should read numbers in every base', () => {
      expect(pairs('0x1f 0o17 0b101 1_000n .5 1e-3 2.', 'js').map(([, token]) => token)).toEqual(
        Array.from({ length: 7 }, () => 'number')
      );
    });

    it('should mark keywords, constants, calls and the names of types', () => {
      expect(tokenOf(js, 'js', 'class')).toBe('keyword');
      expect(tokenOf(js, 'js', 'Foo')).toBe('type');
      expect(tokenOf(js, 'js', 'Bar')).toBe('type');
      expect(tokenOf(js, 'js', 'null')).toBe('constant');
      expect(tokenOf(js, 'js', 'f')).toBe('function');
      expect(tokenOf(js, 'js', 'g')).toBe('function');
      expect(tokenOf('const MAX = 1', 'js', 'MAX')).toBe('constant');
    });

    it('should leave a member alone unless it is called', () => {
      expect(pairs('a.default + a.new + a.b', 'js')).toEqual([]);
      expect(pairs('a.b()', 'js')).toEqual([['b', 'function']]);
      // a spread is not a member access
      expect(pairs('[...Foo]', 'js')).toEqual([['Foo', 'type']]);
    });

    it('should read `from` as a keyword only before a module name', () => {
      expect(pairs("import a from 'b'", 'js')).toEqual([
        ['import', 'keyword'],
        ['from', 'keyword'],
        ["'b'", 'string'],
      ]);
      expect(pairs('const from = 1', 'js')).toEqual([
        ['const', 'keyword'],
        ['1', 'number'],
      ]);
    });

    it("should read TypeScript's words only as TypeScript", () => {
      const ts = SAMPLES.ts!;
      expect(tokenOf(ts, 'ts', 'interface')).toBe('keyword');
      expect(tokenOf(ts, 'ts', 'string')).toBe('type');
      expect(tokenOf(ts, 'ts', 'keyof')).toBe('keyword');
      expect(tokenOf(ts, 'ts', 'satisfies')).toBe('keyword');
      expect(tokenOf('interface A {}', 'js', 'interface')).toBeUndefined();
    });

    it('should read `type` as a keyword only where a name follows it', () => {
      expect(pairs('type C = D', 'ts')[0]).toEqual(['type', 'keyword']);
      expect(pairs('{ type: number }', 'ts')).toEqual([['number', 'type']]);
      expect(pairs('a.type', 'ts')).toEqual([]);
    });

    it('should stop an unclosed string at the end of its line', () => {
      expect(pairs("'abc\nconst", 'js')).toEqual([
        ["'abc", 'string'],
        ['const', 'keyword'],
      ]);
    });
  });

  describe('JSON', () => {
    const json = SAMPLES.json!;

    it('should tell a key from a string by the colon after it', () => {
      expect(tokenOf(json, 'json', '"a"')).toBe('property');
      expect(tokenOf(json, 'json', '"c"')).toBe('string');
      expect(pairs('{"a"\n  : 1}', 'json')[0]).toEqual(['"a"', 'property']);
    });

    it('should read numbers, the constants and JSONC comments', () => {
      expect(tokenOf(json, 'json', '-2.5e3')).toBe('number');
      expect(tokenOf(json, 'json', 'true')).toBe('constant');
      expect(tokenOf(json, 'json', 'null')).toBe('constant');
      expect(tokenOf(json, 'json', '// a comment')).toBe('comment');
    });

    it('should mark what JSON has no reading of as invalid, as one span', () => {
      expect(tokenOf(json, 'json', 'oops')).toBe('invalid');
      expect(pairs("{'a': 1x}", 'json')).toEqual([
        ["'a'", 'invalid'],
        ['1x', 'invalid'],
      ]);
    });
  });

  describe('shell', () => {
    const sh = SAMPLES.sh!;

    it('should mark the command each line runs, and keywords where a command would be', () => {
      expect(tokenOf(sh, 'sh', 'echo')).toBe('function');
      expect(tokenOf(sh, 'sh', 'grep')).toBe('function');
      expect(tokenOf(sh, 'sh', 'for')).toBe('keyword');
      expect(tokenOf(sh, 'sh', 'in')).toBe('keyword');
      expect(tokenOf(sh, 'sh', 'done')).toBe('keyword');
      expect(tokenOf(sh, 'sh', 'fi')).toBe('keyword');
      // an argument that happens to be a keyword is an argument
      expect(pairs('echo if then', 'sh')).toEqual([['echo', 'function']]);
    });

    it('should cut expansions out of a double-quoted string, and leave single quotes whole', () => {
      expect(pairs('"hello $NAME ${f%.txt}"', 'sh')).toEqual([
        ['"hello ', 'string'],
        ['$NAME', 'variable'],
        [' ', 'string'],
        ['${f%.txt}', 'variable'],
        ['"', 'string'],
      ]);
      expect(tokenOf(sh, 'sh', "'raw $x'")).toBe('string');
    });

    it('should read an assignment, and the loop variable, as variables', () => {
      expect(tokenOf(sh, 'sh', 'NAME')).toBe('variable');
      expect(pairs('for f in a', 'sh')).toEqual([
        ['for', 'keyword'],
        ['f', 'variable'],
        ['in', 'keyword'],
      ]);
      expect(pairs('case "$x" in', 'sh')).toEqual([
        ['case', 'keyword'],
        ['"', 'string'],
        ['$x', 'variable'],
        ['"', 'string'],
        ['in', 'keyword'],
      ]);
    });

    it('should step over a space it has no case for, rather than read nothing forever', () => {
      // a no-break space is `\s` to the word pattern and not a blank to the loop
      expect(pairs('a\u00a0b', 'sh')).toEqual([['a', 'function']]);
    });

    it('should start a comment only where a word starts', () => {
      expect(tokenOf(sh, 'sh', '# a comment')).toBe('comment');
      expect(pairs('echo a#b', 'sh')).toEqual([['echo', 'function']]);
    });

    it('should not read a redirection or a substitution as the next command', () => {
      expect(pairs('a 2>&1 b', 'sh')).toEqual([
        ['a', 'function'],
        ['2', 'number'],
      ]);
      expect(pairs('echo $(date) now', 'sh')).toEqual([
        ['echo', 'function'],
        ['date', 'function'],
      ]);
    });

    it('should read the command in a substitution inside a string, quotes and all', () => {
      expect(pairs('X="$(cd "$d" && pwd)/bin"', 'sh')).toEqual([
        ['X', 'variable'],
        ['"', 'string'],
        ['cd', 'function'],
        ['"', 'string'],
        ['$d', 'variable'],
        ['"', 'string'],
        ['pwd', 'function'],
        ['/bin"', 'string'],
      ]);
    });

    it('should read a `case` pattern as a word, and the command after it as a command', () => {
      expect(pairs('case $1 in\n  test) run ;;\n  *) echo ;;&\nesac', 'sh')).toEqual([
        ['case', 'keyword'],
        ['$1', 'variable'],
        ['in', 'keyword'],
        ['run', 'function'],
        ['echo', 'function'],
        ['esac', 'keyword'],
      ]);
    });

    it("should read a here-document's body as a string, up to its delimiter", () => {
      expect(tokenOf(sh, 'sh', 'body $x\n')).toBe('string');
      expect(pairs('cat <<-EOF\n\tone\n\tEOF\nls', 'sh')).toEqual([
        ['cat', 'function'],
        ['\tone\n', 'string'],
        ['ls', 'function'],
      ]);
    });
  });

  describe('YAML', () => {
    const yaml = SAMPLES.yaml!;

    it('should read a key by its colon, and not a colon inside a value', () => {
      expect(tokenOf(yaml, 'yaml', 'name')).toBe('property');
      expect(tokenOf(yaml, 'yaml', 'url')).toBe('property');
      expect(pairs('url: http://x.dev:80/a', 'yaml')).toEqual([['url', 'property']]);
      expect(tokenOf(yaml, 'yaml', '"quoted"')).toBe('property');
    });

    it('should read the scalars that are constants and numbers, and leave the rest plain', () => {
      expect(tokenOf(yaml, 'yaml', '1.2')).toBe('number');
      expect(tokenOf(yaml, 'yaml', 'true')).toBe('constant');
      expect(tokenOf(yaml, 'yaml', 'yes')).toBe('constant');
      expect(tokenOf(yaml, 'yaml', '~')).toBe('constant');
      expect(tokenOf(yaml, 'yaml', 'sigil')).toBeUndefined();
    });

    it('should read anchors, aliases, tags, comments and the document marker', () => {
      expect(tokenOf(yaml, 'yaml', '&anchor')).toBe('variable');
      expect(tokenOf(yaml, 'yaml', '*anchor')).toBe('variable');
      expect(tokenOf(yaml, 'yaml', '!!str')).toBe('type');
      expect(tokenOf(yaml, 'yaml', '# doc')).toBe('comment');
      expect(tokenOf(yaml, 'yaml', '---')).toBe('meta');
    });

    it('should read the keys and scalars inside a flow collection', () => {
      expect(pairs('flow: {a: 1, "b": [x, null]}', 'yaml')).toEqual([
        ['flow', 'property'],
        ['a', 'property'],
        ['1', 'number'],
        ['"b"', 'property'],
        ['null', 'constant'],
      ]);
    });

    it("should read a block scalar's lines as a string, blank lines and all", () => {
      expect(tokenOf(yaml, 'yaml', 'echo one')).toBe('string');
      expect(tokenOf(yaml, 'yaml', 'echo two')).toBe('string');
      expect(tokenOf(yaml, 'yaml', 'after')).toBe('property');
    });
  });

  describe('Markdown', () => {
    const md = SAMPLES.markdown!;

    it('should read the block structure', () => {
      expect(tokenOf(md, 'markdown', '# A title')).toBe('heading');
      expect(tokenOf(md, 'markdown', '```json')).toBe('meta');
      expect(tokenOf(md, 'markdown', '---')).toBe('meta');
      expect(tokenOf(md, 'markdown', '<!-- note -->')).toBe('comment');
    });

    it('should read the inline marks', () => {
      expect(tokenOf(md, 'markdown', '*em*')).toBe('emphasis');
      expect(tokenOf(md, 'markdown', '**strong**')).toBe('strong');
      expect(tokenOf(md, 'markdown', '`code`')).toBe('code');
      expect(tokenOf(md, 'markdown', '[link]')).toBe('link');
      expect(tokenOf(md, 'markdown', '(https://x.dev)')).toBe('string');
      expect(tokenOf(md, 'markdown', '<https://y.dev>')).toBe('link');
    });

    it('should highlight a fenced block in its own language, where it reads that one', () => {
      expect(tokenOf(md, 'markdown', '"k"')).toBe('property');
      expect(pairs('```python\nx = 1\n```', 'markdown')).toEqual([
        ['```python', 'meta'],
        ['x = 1', 'code'],
        ['```', 'meta'],
      ]);
    });

    it('should close a code span on a run of exactly as many backticks', () => {
      expect(pairs('a `` b ` c `` d', 'markdown')).toEqual([['`` b ` c ``', 'code']]);
    });

    it('should not read emphasis inside a word spelled with underscores', () => {
      expect(pairs('snake_case_name', 'markdown')).toEqual([]);
    });
  });

  describe('a diff', () => {
    const patch = SAMPLES.diff!;

    it('should read the lines a patch is made of', () => {
      expect(tokenOf(patch, 'diff', 'diff --git a/x.ts b/x.ts')).toBe('meta');
      expect(tokenOf(patch, 'diff', '--- a/x.ts')).toBe('meta');
      expect(tokenOf(patch, 'diff', '+++ b/x.ts')).toBe('meta');
      expect(tokenOf(patch, 'diff', '@@ -1,3 +1,3 @@')).toBe('hunk');
      expect(tokenOf(patch, 'diff', '-old')).toBe('deleted');
      expect(tokenOf(patch, 'diff', '+new')).toBe('inserted');
      expect(tokenOf(patch, 'diff', '\\ No newline at end of file')).toBe('comment');
    });

    it('should read a removed line that starts with dashes as removed, not as a header', () => {
      expect(tokenOf(patch, 'diff', '--- removed, not a header')).toBe('deleted');
    });
  });

  describe('linear time', () => {
    // A quadratic scan over these is tens of seconds at this size and a linear one
    // a few milliseconds, so a generous absolute deadline tells them apart however
    // loaded the machine is -- a ratio of two timings would not. A million, because
    // a quadratic made of `indexOf()` calls runs at memory speed: at 200,000 the
    // sabotage pass had two of them finish inside the deadline.
    const SIZE = 1_000_000;
    const DEADLINE = 2_000;

    const repeat = (unit: string): string => unit.repeat(Math.ceil(SIZE / unit.length));

    const PATHOLOGICAL: [string, string][] = [
      ['js', `/*${'a'.repeat(SIZE)}`],
      ['js', `'${'a'.repeat(SIZE)}`],
      ['js', `\`${'a'.repeat(SIZE)}`],
      ['js', repeat('(/[')],
      ['js', repeat('`${')],
      ['js', repeat('a / ')],
      ['ts', repeat('type ')],
      ['json', repeat('"')],
      ['json', repeat('"a" ')],
      ['json', repeat('{[')],
      ['sh', repeat('${')],
      ['sh', repeat('"$')],
      ['sh', repeat('a[ ')],
      ['sh', repeat('<<')],
      ['sh', repeat('$(')],
      ['yaml', repeat('a:a')],
      ['yaml', repeat('  ')],
      ['yaml', repeat('{"')],
      ['yaml', repeat('- ')],
      ['markdown', repeat('[')],
      ['markdown', repeat('*')],
      ['markdown', repeat('_a')],
      ['markdown', repeat('![x](')],
      ['markdown', repeat('<a:')],
      ['markdown', repeat('<!--')],
      ['markdown', repeat('[a\n')],
      ['markdown', repeat('*a\n')],
      ['markdown', repeat('x\n')],
      // a run of each length, so every opener is unclosed: a search per opener
      // is two thousand scans of a line two million long
      ['markdown', Array.from({ length: 2000 }, (_, i) => '`'.repeat(i + 1)).join('a')],
      ['diff', repeat('--- a\n')],
    ];

    it.each(PATHOLOGICAL)('should read %s %#  in linear time', (lang, code) => {
      const started = performance.now();
      const spans = highlightCode(code, lang);
      const took = performance.now() - started;
      expect(took, `${lang}: ${code.slice(0, 12)}...`).toBeLessThan(DEADLINE);
      expect(Array.isArray(spans)).toBe(true);
    });
  });
});

describe('the four seams, each handed highlightCode as it is', () => {
  it('should colour a markdown code block in the language its fence names', () => {
    const out = markdown('```json\n{ "key": 1 }\n```', {
      colorLevel: 1,
      env: {},
      highlight: highlightCode,
      platform: 'linux',
      width: 40,
    });
    // a key is a property, which is the accent; a number is info, which is blue
    expect(out).toContain(`${ESC}[36m"key"`);
    expect(out).toMatch(new RegExp(`${ESC}\\[34m1`));
  });

  it("should hand a diff's highlighter each file's own language, from its name", () => {
    const patch = [
      '--- a/config.json',
      '+++ b/config.json',
      '@@ -1 +1 @@',
      '-{ "a": 1 }',
      '+{ "a": 2 }',
      '--- /dev/null',
      '+++ b/run.sh',
      '@@ -0,0 +1 @@',
      '+echo hi',
    ].join('\n');
    const asked: (string | undefined)[] = [];
    const out = diff(
      { patch },
      {
        colorLevel: 1,
        env: {},
        highlight: (code, lang) => {
          asked.push(lang);
          return highlightCode(code, lang);
        },
        platform: 'linux',
        width: 60,
      }
    );

    // the deleted side of a new file is named /dev/null, so it takes the other's
    expect(asked).toEqual(['json', 'json', 'sh', 'sh']);
    expect(out).toContain(`${ESC}[36m"a"`);
    expect(out).toContain('echo');
  });

  it("should let a diff's `lang` beat the names, and name none for two unnamed texts", () => {
    const asked: (string | undefined)[] = [];
    const hook = (code: string, lang?: string): HighlightSpan[] => {
      asked.push(lang);
      return highlightCode(code, lang);
    };
    diff({ new: 'b', newName: 'x.ts', old: 'a', oldName: 'x.js' }, { highlight: hook });
    diff({ new: 'b', newName: 'x.ts', old: 'a' }, { highlight: hook, lang: 'yaml' });
    diff({ new: 'b', old: 'a' }, { highlight: hook });

    expect(asked).toEqual(['js', 'ts', 'yaml', 'yaml', undefined, undefined]);
  });

  it("should hand a text area's highlighter its `lang`", () => {
    const area = TextArea({ highlight: highlightCode, lang: 'ts', value: 'const n = 1' });
    const out = renderToString(area, {
      cascade: themedCascade(),
      colorLevel: 1,
      height: 1,
      width: 20,
    });

    expect(out).toMatch(new RegExp(`${ESC}\\[36mconst`));
    expect(out).toMatch(new RegExp(`${ESC}\\[34m1`));
    expect(() => TextArea({ lang: 7 as never })).toThrow(/lang to be a string/);
  });

  it("should hand the multiline prompt's highlighter its `lang`", async () => {
    const asked: (string | undefined)[] = [];
    const ui = screenSetup();
    const answer = multiline({
      ansi: ui.ansi,
      colorLevel: 1,
      highlight: (code, lang) => {
        asked.push(lang);
        return highlightCode(code, lang);
      },
      initial: 'a: true',
      lang: 'yaml',
      message: 'Config',
      terminal: ui.terminal,
    });

    ui.stdin.send('\u0004');
    await tick();
    expect(await answer).toBe('a: true');
    expect(asked[0]).toBe('yaml');
    expect(ui.output).toMatch(new RegExp(`${ESC}\\[(?:\\d+;)*36ma`));
  });
});
