import {
  escapeChunks,
  escapeCode,
  unescapableControl,
  shiftMappings,
} from '../src/build/escape-chunks.ts';
import { linkedFixture } from './copy-fixture.ts';
import { run } from './spawned.ts';
import { tempDir } from './temp.ts';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { SourceMap } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * SIG-394: the pass that escapes every control character in what a build wrote
 * rewrote the **raw** strings of a tagged template, which is the one string an
 * escape does not keep -- `` String.raw`<ESC>x` `` is two characters from source
 * and five once built -- and widened a minified one-line chunk after its
 * sourcemap was written, so every token past an escape was three columns off the
 * entry the map recorded for it.
 *
 * Written with escapes, never raw bytes, for the reason `sources.test.ts` exists.
 */

const here = dirname(fileURLToPath(import.meta.url));
const cli = resolve(here, '../src/sigil.ts');
const buildable = resolve(here, 'fixtures', 'buildable');

const ESC = '\u001b';
const CSI = '\u009b';

describe('escapeCode', () => {
  it('should escape what a terminal would act on and keep the file its own formatting', () => {
    const { code } = escapeCode(`a${ESC}b${CSI}c\td\ne\rf\u007fg`);

    expect(code).toBe('a\\x1Bb\\x9Bc\td\ne\rf\\x7Fg');
  });

  it('should hand back the same string when there is nothing to escape', () => {
    const text = 'const a = `x\ty`;\n';

    expect(escapeCode(text).code).toBe(text);
    expect(escapeCode(text).moved.size).toBe(0);
  });

  it('should start a line at U+2028 and U+2029 as a sourcemap does', () => {
    expect([...escapeCode(`ab\u2028c${ESC}\u2029${CSI}`).moved]).toEqual([
      [1, [1]],
      [2, [0]],
    ]);
  });

  it('should record the column each replaced character stood at, per line', () => {
    const { moved } = escapeCode(`ab${ESC}${CSI}\n${ESC}x\n\ny${ESC}`);

    expect([...moved]).toEqual([
      [0, [2, 3]],
      [1, [0]],
      [3, [1]],
    ]);
  });
});

describe('shiftMappings', () => {
  // `AAAA` is column 0, `CAAC` one column on, and a column is a difference from
  // the segment before it: so an escape at column 0 pushes every later one by 3
  it('should move each generated column past a replaced character by three', () => {
    expect(shiftMappings('AAAA,CAAC,CAAC', new Map([[0, [0]]]))).toBe('AAAA,IAAC,CAAC');
  });

  it('should write a column that takes more than one digit', () => {
    // column 100 is `oG` and 103 is `uG`
    expect(shiftMappings('AAAA,oGAAC', new Map([[0, [0]]]))).toBe('AAAA,uGAAC');
  });

  it('should leave a segment that starts at the replaced character where it is', () => {
    // the escape is the text that segment points at, so it starts there
    expect(shiftMappings('AAAA,KAAK', new Map([[0, [5]]]))).toBe('AAAA,KAAK');
    expect(shiftMappings('AAAA,MAAM', new Map([[0, [5]]]))).toBe('AAAA,SAAM');
  });

  it('should touch only the line that was widened, and keep the rest of each segment', () => {
    // a column starts again from nothing on every line
    expect(shiftMappings('AAAA;AAAA,CAAC;CACA', new Map([[1, [0]]]))).toBe('AAAA;AAAA,IAAC;CACA');
    expect(shiftMappings('AAAA,CAGC,CAAC', new Map([[0, [0]]]))).toBe('AAAA,IAGC,CAAC');
  });

  it('should refuse a segment it cannot read rather than loop on it', () => {
    expect(() => shiftMappings('AAAA,g', new Map([[0, [0]]]))).toThrow(
      'Malformed sourcemap segment'
    );
  });

  it('should count every character before a column, not only the nearest', () => {
    // three replaced before column 6: 6 + 9
    expect(shiftMappings('MAAA', new Map([[0, [0, 2, 4]]]))).toBe('eAAA');
  });
});

describe('unescapableControl', () => {
  it('should find a control character a backslash makes part of an escape, in a template', () => {
    // `\<ESC>` cooks to ESC, and `\\x1B` is a backslash and four more characters
    expect(unescapableControl('app.mjs', `const a = \`a\\${ESC}b\`;\n`)).toEqual({
      chunk: 'app.mjs',
      codePoint: 0x1b,
      column: 14,
      in: 'a template, after a backslash',
      line: 1,
    });
    // an even run is a backslash and then a character an escape is right for,
    // and a backslash before a tab or a line break is the file's own formatting
    expect(unescapableControl('app.mjs', `const a = \`a\\\\${ESC}b\`;\n`)).toBeUndefined();
    expect(unescapableControl('app.mjs', 'const a = `a\\\tb\\\nc`;\n')).toBeUndefined();
  });

  it('should find a raw control character in a tagged template, and say where', () => {
    expect(unescapableControl('app.mjs', `const a = 1;\nconst b = tag\`x${ESC}[1m\`;\n`)).toEqual({
      chunk: 'app.mjs',
      codePoint: 0x1b,
      column: 16,
      in: 'a tagged template',
      line: 2,
    });
    expect(unescapableControl('app.mjs', `String.raw\`${CSI}\`\n`)?.codePoint).toBe(0x9b);
  });

  it('should find one in a tag nested in a template that is not tagged', () => {
    expect(unescapableControl('app.mjs', `const a = \`\${tag\`${ESC}\`}\`;\n`)?.line).toBe(1);
    expect(unescapableControl('app.mjs', `tag\`\${tag\`a\`}${ESC}\`;\n`)?.line).toBe(1);
  });

  it('should say nothing of a template nobody can read the raw string of', () => {
    expect(unescapableControl('app.mjs', `const a = \`x${ESC}\`;\n`)).toBeUndefined();
    expect(unescapableControl('app.mjs', `const a = "${CSI}";\n`)).toBeUndefined();
    // an expression is not a quasi, whatever the tag is handed
    expect(unescapableControl('app.mjs', `tag\`a\${"${ESC}"}b\`;\n`)).toBeUndefined();
  });

  it("should say nothing of an escape the author wrote, nor of the file's own formatting", () => {
    expect(unescapableControl('app.mjs', 'tag`\\x1B[1m`;\n')).toBeUndefined();
    expect(unescapableControl('app.mjs', 'tag`a\tb\nc`;\n')).toBeUndefined();
  });

  it('should name the character in the quasi and not the same one in an expression', () => {
    const found = unescapableControl('app.mjs', `tag\`a\${"${ESC}"}bbbb\${1}c${ESC}\`;\n`);

    expect(found?.column).toBe(21);
  });

  it('should find a raw control character in a regular expression literal', () => {
    // matching is the same either way and `re.source` is not
    expect(unescapableControl('app.mjs', `const re = /a${ESC}b/;\n`)).toEqual({
      chunk: 'app.mjs',
      codePoint: 0x1b,
      column: 14,
      in: 'a regular expression literal',
      line: 1,
    });
    expect(unescapableControl('app.mjs', 'const re = /a\\x1Bb/;\n')).toBeUndefined();
  });

  it('should say nothing of a chunk that does not parse', () => {
    expect(unescapableControl('app.mjs', `const = tag\`${ESC}\``)).toBeUndefined();
  });
});

/** The app, with its hidden command replaced by `source`. */
function appWith(source: string): string {
  const app = linkedFixture(buildable, 'sigil-escape-chunks-');
  writeFileSync(join(app, 'src', 'commands', 'quiet.js'), source);
  return app;
}

describe('a build with a control character in it', () => {
  it('should refuse a raw one inside a tagged template, and leave nothing behind', async () => {
    const app = appWith(
      `const tag = (s) => s.raw[0];\nexport default { desc: 'x', hidden: true, run: () => process.stdout.write(\`\${tag\`${ESC}[1m\`.length}\\n\`) };\n`
    );

    const { code, stderr } = await run(cli, app, ['build', app]);

    expect(code, stderr).toBe(1);
    expect(stderr).toContain('inside a tagged template');
    expect(stderr).toContain('(U+001B)');
    expect(stderr).toMatch(/chunks\/quiet-[\w-]+\.mjs:1:\d+ holds/);
    expect(stderr).not.toContain(ESC);
    expect(existsSync(join(app, 'dist', 'buildable.mjs'))).toBe(false);
    expect(existsSync(join(app, 'dist', 'chunks'))).toBe(false);
  }, 60_000);

  it('should build the same template written as an escape, and give the tag what the source did', async () => {
    const app = appWith(
      "const tag = (s) => s.raw[0];\nexport default { desc: 'x', hidden: true, run: () => process.stdout.write(`${tag`\\x1B[1m`.length}:${String.raw`\\x1B`.length}\\n`) };\n"
    );

    const built = await run(cli, app, ['build', app]);
    expect(built.code, built.stderr).toBe(0);

    const ran = await run(join(app, 'dist', 'buildable.mjs'), app, ['quiet']);
    expect(ran.stdout).toBe('7:4\n');
  }, 60_000);

  // a raw `U+2028` or `U+2029` is left alone and is a line to a sourcemap, so a
  // chunk can be one `\n` line and several map lines
  it.each([
    ['', 'a chunk of one line'],
    ['globalThis.t = String.raw`a\u2028b\u2029c`;\n', 'a template that holds line separators'],
  ])(
    'should keep a sourcemap on the token it recorded after the characters it widened (%#)',
    async (before) => {
      // C1 are not escaped by the minifier, so they are the characters that reach
      // the pass raw -- which is what every app's runtime does with `U+009B`
      const app = appWith(
        [
          `${before}const c = String.fromCharCode(0x9b).repeat(1) + String.fromCharCode(0x9c) + String.fromCharCode(0x9d) + String.fromCharCode(0x9e);`,
          "export default { desc: 'x', hidden: true, run: () => { console.log(c); console.warn('alpha'); console.error('beta'); console.info('gamma'); } };",
          '',
        ].join('\n')
      );

      const built = await run(cli, app, ['build', app]);
      expect(built.code, built.stderr).toBe(0);

      const chunks = join(app, 'dist', 'chunks');
      const name = readdirSync(chunks).find((one) => /^quiet-.*\.mjs$/.test(one))!;
      const chunk = readFileSync(join(chunks, name), 'utf-8');
      const map = new SourceMap(JSON.parse(readFileSync(join(chunks, `${name}.map`), 'utf-8')));
      const lines = /\n|\u2028|\u2029/;
      const source = readFileSync(join(app, 'src', 'commands', 'quiet.js'), 'utf-8').split(lines);

      // what was written has none, which is what makes the columns move at all
      expect(chunk).toContain('\\x9B');
      expect(chunk).not.toContain(CSI);

      for (const token of ['console.log', 'console.warn', 'console.error', 'console.info']) {
        const upTo = chunk.slice(0, chunk.indexOf(token)).split(lines);
        const entry = map.findEntry(upTo.length - 1, upTo.at(-1)!.length) as {
          originalColumn: number;
          originalLine: number;
        };

        expect(
          source[entry.originalLine]?.slice(
            entry.originalColumn,
            entry.originalColumn + token.length
          )
        ).toBe(token);
      }
    },
    60_000
  );

  it('should refuse a raw control character in a regular expression, which has a source too', async () => {
    const app = appWith(
      `export default { desc: 'x', hidden: true, run: () => process.stdout.write(\`\${(globalThis.re = /a${ESC}b/).source.length}\\n\`) };\n`
    );

    const { code, stderr } = await run(cli, app, ['build', app]);

    expect(code, stderr).toBe(1);
    expect(stderr).toContain('inside a regular expression literal');
  }, 60_000);
});

describe('escapeChunks', () => {
  /** An output directory with one chunk and a map beside it. */
  function written(code: string, mappings: string): string {
    const dir = tempDir('sigil-escape-chunks-out-');
    writeFileSync(join(dir, 'a.mjs'), code);
    writeFileSync(join(dir, 'a.mjs.map'), JSON.stringify({ mappings, version: 3 }));
    return dir;
  }

  const output = [
    { fileName: 'a.mjs', type: 'chunk' },
    { fileName: 'a.mjs.map', type: 'asset' },
  ];

  it('should escape the chunk and move its map', () => {
    const dir = written(`x(${CSI});`, 'AAAA,GAAG');

    expect(escapeChunks(dir, output)).toBeUndefined();
    expect(readFileSync(join(dir, 'a.mjs'), 'utf-8')).toBe('x(\\x9B);');
    expect(JSON.parse(readFileSync(join(dir, 'a.mjs.map'), 'utf-8')).mappings).toBe('AAAA,MAAG');
  });

  it('should write nothing when a chunk is refused', () => {
    const dir = written(`a(${ESC});\n`, 'AAAA');
    writeFileSync(join(dir, 'b.mjs'), `tag\`${ESC}\`;\n`);

    expect(escapeChunks(dir, [...output, { fileName: 'b.mjs', type: 'chunk' }])?.chunk).toBe(
      'b.mjs'
    );
    expect(readFileSync(join(dir, 'a.mjs'), 'utf-8')).toBe(`a(${ESC});\n`);
  });

  it('should write nothing when a map cannot be read, which is not a refusal', () => {
    const dir = written(`a(${ESC});\n`, 'AAAA,g');

    expect(() => escapeChunks(dir, output)).toThrow('Malformed sourcemap segment');
    expect(readFileSync(join(dir, 'a.mjs'), 'utf-8')).toBe(`a(${ESC});\n`);
  });
});
