import { tempDir } from './temp.js';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * What is committed, read as bytes.
 *
 * The other half of the rule `should ship no raw control character` in
 * `packages/cli/test/cli.test.ts` keeps. That one says what ships
 * carries no raw control character, because the minifier puts back what the
 * source was careful to avoid; this one says the *source* carries none either,
 * which is the half that had never been checked and was being broken by the very
 * file that fixes the other.
 *
 * `tsdown.config.ts` held its escape regex as a character class of literal
 * bytes, a NUL among them, and git calls a file binary the moment it finds one
 * in the first 8000 bytes -- so the file whose whole job is to keep raw control
 * characters out of the build was unreviewable on GitHub, showing `Bin 2786 ->
 * 2858 bytes` instead of a diff. `canvas/style.ts` had the same literal NUL far
 * enough in that the heuristic missed it, which is the same bug waiting for the
 * file to grow.
 *
 * Neither was wrong to the regex engine. That is the point: a raw control
 * character in source is invisible in an editor and in a diff, and the damage it
 * does is to the people reading it.
 */

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/** Tab, newline and carriage return: the file's own formatting, not a sequence. */
const FORMATTING = new Set([0x09, 0x0a, 0x0d]);

/**
 * What is allowed to hold one anyway.
 *
 * A test that feeds a terminal's own bytes to a decoder is describing those
 * bytes, and writing `ESC [ A` as an escape there would be describing something
 * else. They are listed rather than inferred so that a new one is a decision.
 */
const ALLOWED = new Set([
  'demos/canvas/01-sparkline.js',
  'demos/canvas/02-image.js',
  'demos/canvas/03-links.js',
  'demos/components/images/macaw.png',
  'packages/screenshot/fonts/DejaVuSans.ttf',
  'packages/screenshot/fonts/JetBrainsMono-Bold.ttf',
  'packages/screenshot/fonts/JetBrainsMono-BoldItalic.ttf',
  'packages/screenshot/fonts/JetBrainsMono-Italic.ttf',
  'packages/screenshot/fonts/JetBrainsMono-Regular.ttf',
  'packages/screenshot/test/golden/showcase-light@2x.png',
  'packages/screenshot/test/golden/showcase.png',
  'packages/sigil/test/ansi/strip.test.ts',
  'packages/sigil/test/components/helpers.ts',
  'packages/sigil/test/components/keys.test.ts',
  'packages/sigil/test/components/prompt.test.ts',
  'packages/sigil/test/input/input.test.ts',
  'website/public/icon-192.png',
  'website/public/icon-512.png',
  'website/src/app/apple-icon.png',
  'website/src/app/favicon.ico',
  'website/src/fonts/barlow-semi-condensed-latin-600.woff2',
  'website/src/fonts/instrument-sans-latin.woff2',
  'website/src/fonts/jetbrains-mono-latin-400.woff2',
  'website/src/fonts/jetbrains-mono-latin-500.woff2',
  'website/src/fonts/jetbrains-mono-latin-700.woff2',
  'website/src/fonts/jetbrains-mono-terminal-400.woff2',
  'website/src/fonts/martian-mono-latin-500.woff2',
]);

/**
 * A vendored corpus of binary files, allowed as a directory rather than by name.
 *
 * PngSuite is 176 images whose bytes are the subject, and listing each would
 * bury the named entries above, each of which is a decision about one file,
 * under one decision about one directory. What keeps the directory from being a
 * hole is the test below it: only `.png` files are skipped, so the suite's own
 * README and licence are still read as text, and anything else put there is
 * read like every other file.
 */
const CORPORA = ['packages/sigil/test/png/fixtures/pngsuite/'];

function allowed(name: string): boolean {
  return ALLOWED.has(name) || CORPORA.some((dir) => name.startsWith(dir) && name.endsWith('.png'));
}

/** Everything git is tracking, which is what a reviewer sees. */
function tracked(): string[] {
  return execFileSync('git', ['ls-files', '-z'], { cwd: root, maxBuffer: 1 << 24 })
    .toString('utf8')
    .split('\0')
    .filter(Boolean);
}

/** A code point as a reader looks it up: `U+202E`. */
function codePoint(code: number): string {
  return `U+${code.toString(16).toUpperCase().padStart(4, '0')}`;
}

/**
 * A character that is not there to the eye: `\p{Cf}`, the format characters.
 *
 * The control character check is C0, `DEL` and C1, and none of these is one,
 * so they went through it. The bidi controls -- U+202A to U+202E, U+2066 to
 * U+2069, and the marks U+200E, U+200F and U+061C -- reorder what an editor and
 * a diff draw without changing what a compiler reads, which is the "Trojan
 * Source" attack and the reason GitHub flags them. The zero-width ones --
 * U+200B to U+200D, and U+FEFF -- are simply invisible, and a byte order mark
 * also changes how a file parses. SIG-483 was a tool write that turned the
 * escape for U+202E in a test into the character itself: the check passed it,
 * and only `od` showed it.
 *
 * Every one of them is `\p{Cf}`, so the class is named rather than enumerated,
 * for the reason the build's escape pass says `\p{Cc}`: a list is a second
 * definition of a set Unicode already defines. Naming it also takes in the word
 * joiner, the invisible operators and the tag characters, which are as invisible
 * as the rest and which no file here holds.
 */
const FORMAT = /\p{Cf}/gu;

/**
 * What may hold one literally anyway, each with the reason it has to.
 *
 * JavaScript and TypeScript have an escape for every one of these characters,
 * so code never needs the literal: the joiners inside the family emoji the tests
 * measure are written as escapes between the pictographs they join, which is
 * the same string and shows the reader what is there. Markdown is where there is
 * no escape, because a code span shows a backslash sequence and a character
 * reference exactly as typed -- so a document whose example *is* the character
 * has to hold it. Listed by file rather than inferred from where a joiner sits,
 * so that the next one is a decision somebody makes.
 */
const FORMAT_ALLOWED = new Map([
  [
    'packages/sigil/README.md',
    'the `stringWidth()` example and `charLimit` each show a family emoji, which is one ' +
      'grapheme cluster because of its joiners, and npm renders the README for people',
  ],
]);

/**
 * Each line of each file that holds a format character, as `name:line: U+202E`.
 *
 * A file git would call binary is skipped: it has no diff for an invisible
 * character to mislead, and `should be text to git` keeps every file that is not
 * on `ALLOWED` text, so a binary file here is one somebody already listed.
 */
function formatCharacters(dir: string, names: readonly string[]): string[] {
  const offenders: string[] = [];

  for (const name of names) {
    let raw: Buffer;
    try {
      raw = readFileSync(join(dir, name));
    } catch {
      continue;
    }
    if (raw.subarray(0, 8000).includes(0)) {
      continue;
    }

    // `Buffer#toString()` keeps a leading byte order mark where a `TextDecoder`
    // would strip it, so a mark is found at the start of a file as well as part
    // way down, which is where the four in `@ttylabs/config-xml`'s comments were
    const lines = raw.toString('utf8').split('\n');
    for (const [index, line] of lines.entries()) {
      const codes = new Set(
        [...line.matchAll(FORMAT)].map((match) => match[0].codePointAt(0) ?? 0)
      );
      if (codes.size > 0) {
        const labels = [...codes].sort((a, b) => a - b).map(codePoint);
        offenders.push(`${name}:${index + 1}: ${labels.join(', ')}`);
      }
    }
  }

  return offenders;
}

describe('committed sources', () => {
  const files = tracked().filter((name) => !allowed(name));

  it('should be tracked, so that this is testing something', () => {
    expect(files.length).toBeGreaterThan(100);
  });

  it('should skip only the images of a corpus, and read the rest of it', () => {
    const corpus = tracked().filter((name) => CORPORA.some((dir) => name.startsWith(dir)));
    expect(corpus.filter((name) => name.endsWith('.png')).length).toBeGreaterThan(100);
    expect(files.filter((name) => CORPORA.some((dir) => name.startsWith(dir))).sort()).toEqual(
      corpus.filter((name) => !name.endsWith('.png')).sort()
    );
    expect(files).toContain('packages/sigil/test/png/fixtures/pngsuite/PngSuite.LICENSE');
  });

  it('should carry no raw control character', () => {
    const offenders: string[] = [];

    for (const name of files) {
      let raw: Buffer;
      try {
        raw = readFileSync(join(root, name));
      } catch {
        // a path git knows about and the disk does not: a submodule, or a file
        // removed but not yet staged. Neither is this test's business
        continue;
      }

      const found = new Set<number>();
      for (const byte of raw) {
        if (FORMATTING.has(byte)) {
          continue;
        }
        // C0 and DEL as bytes. C1 arrives as UTF-8 rather than as a byte, so it
        // is read from the decoded text below instead
        if (byte < 0x20 || byte === 0x7f) {
          found.add(byte);
        }
      }

      for (const char of raw.toString('utf8')) {
        const code = char.codePointAt(0) ?? 0;
        if (code >= 0x80 && code <= 0x9f) {
          found.add(code);
        }
      }

      if (found.size > 0) {
        const names = [...found].sort((a, b) => a - b).map(codePoint);
        offenders.push(`${name}: ${names.join(', ')}`);
      }
    }

    expect(offenders, offenders.join('\n')).toEqual([]);
  });

  it('should carry no format character, which is invisible and can reorder a line', () => {
    // read over every tracked file rather than over `files`, because a file on
    // `ALLOWED` holds a terminal's own bytes for a reason and has none to hold a
    // bidi control. This closes what the byte order mark check that used to
    // stand here was a first step towards: it was the mark alone, because the
    // two U+200D in the tree then would have needed a list and the mark needed
    // none (SIG-483 took the list, and found fifteen files rather than two)
    const offenders = formatCharacters(
      root,
      tracked().filter((name) => !FORMAT_ALLOWED.has(name))
    );

    expect(offenders, offenders.join('\n')).toEqual([]);
  });

  it('should list only files that hold one, so that the list cannot outlive its reason', () => {
    const all = new Set(tracked());

    for (const name of FORMAT_ALLOWED.keys()) {
      expect(all.has(name), name).toBe(true);
      expect(formatCharacters(root, [name]), name).not.toEqual([]);
    }
  });

  describe('a planted format character', () => {
    // built from code points rather than written as escapes, because an escape
    // written through a tool can land as the character itself, which is how this
    // check came to be asked for
    const planted = [
      0x061c, 0x200b, 0x200c, 0x200d, 0x200e, 0x200f, 0x202a, 0x202b, 0x202c, 0x202d, 0x202e,
      0x2060, 0x2066, 0x2067, 0x2068, 0x2069, 0xfeff, 0xe0041,
    ];

    function plant(content: string | Buffer): string[] {
      const dir = tempDir('sigil-sources-');
      writeFileSync(join(dir, 'planted.ts'), content);
      return formatCharacters(dir, ['planted.ts']);
    }

    it.each(planted.map((code) => [codePoint(code), code]))('should refuse %s', (name, code) => {
      const char = String.fromCodePoint(code as number);
      expect(plant(`const ok = 1;\nconst label = 'a${char}b';\n`)).toEqual([
        `planted.ts:2: ${name}`,
      ]);
    });

    it('should refuse a byte order mark at the very start, which a decoder would strip', () => {
      expect(plant(`${String.fromCodePoint(0xfeff)}const ok = 1;\n`)).toEqual([
        'planted.ts:1: U+FEFF',
      ]);
    });

    it('should name each character once per line, and every line it is on', () => {
      const rlo = String.fromCodePoint(0x202e);
      const pdf = String.fromCodePoint(0x202c);
      expect(plant(`a${rlo}b${pdf}${rlo}\nok\nc${rlo}\n`)).toEqual([
        'planted.ts:1: U+202C, U+202E',
        'planted.ts:3: U+202E',
      ]);
    });

    it('should pass the same character written as an escape, which is the fix', () => {
      const backslash = String.fromCodePoint(0x5c);
      expect(plant(`const label = 'a${backslash}u202Eb';\n`)).toEqual([]);
    });

    it('should skip a file git would call binary, which has no diff to mislead', () => {
      expect(plant(Buffer.from(`\0${String.fromCodePoint(0x202e)}`, 'utf8'))).toEqual([]);
    });
  });

  it('should be text to git, which is what makes a diff readable', () => {
    // the observable half of the same rule, and the one that was actually
    // costing something: git's own test is a NUL in the first 8000 bytes, so a
    // file can hold raw control characters for years and only become binary the
    // day one of them moves far enough up
    const binary: string[] = [];

    for (const name of files) {
      let raw: Buffer;
      try {
        raw = readFileSync(join(root, name));
      } catch {
        continue;
      }
      if (raw.subarray(0, 8000).includes(0)) {
        binary.push(name);
      }
    }

    expect(binary, binary.join('\n')).toEqual([]);
  });
});
