import { tempDir } from './temp.js';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
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
 *
 * The line and paragraph separators, U+2028 and U+2029 (`\p{Zl}` and `\p{Zp}`),
 * go with them although they are not `Cf`. Each is a line terminator to
 * JavaScript and nothing an editor draws, so one ends a `//` comment and the
 * code after it runs while it reads as the comment -- and that is a place
 * `oxlint`'s `no-irregular-whitespace` does not look, measured: it flags one in
 * code and in a block comment, and is silent on one ending a line comment as it
 * is in a string. The four in the tree, on three lines of a YAML test and a
 * history file, were escapes a tool write had turned into the characters, and
 * are escapes again.
 *
 * The no-break space, the other spaces, the variation selectors and the blank
 * letters are refused with them (SIG-511), and what lint leaves open is why.
 * The first answer to leaving a no-break space out was that lint refuses it in
 * JavaScript, and that is true of code and of a comment and false of a string,
 * a template literal and a regular expression -- measured, `oxlint`'s
 * `no-irregular-whitespace` is silent on all three, and it reads nothing but
 * JavaScript, so Markdown, JSON, YAML and CSS are nobody's. All ten lines in
 * the tree were in a string, so lint was the check that did not look where they
 * were, and it only warns, so `pnpm check` exits 0 over the places it does look.
 * A string is where it matters: `'a\u00A0b.mjs'` is a file name nobody can type
 * and a diff draws as `'a b.mjs'`. So:
 *
 * - `\p{Zs}` but for U+0020: the no-break space, the en and em spaces, the
 *   narrow no-break and the ideographic space. Each draws as a gap and none is
 *   the space a shell or a path means. Markdown has `&nbsp;` for the one a document needs.
 * - The variation selectors, U+FE00 to U+FE0F, U+180B to U+180D and U+180F,
 *   and U+E0100 to U+E01EF. A selector after an emoji chooses between two
 *   glyphs, which is a real literal use and also the reason one is no use as
 *   text: it has no glyph of its own, and the supplementary ones are
 *   the characters a payload has been hidden in, after a visible one. JavaScript has an escape for each, so a test that measures
 *   what a selector does writes the escape between the characters it joins, as
 *   the joiners already are.
 * - The blank letters: the Hangul fillers U+115F, U+1160, U+3164 and U+FFA0,
 *   the Khmer inherent vowels U+17B4 and U+17B5, the combining grapheme joiner
 *   U+034F, and the blank braille pattern U+2800. Each is a letter or a mark
 *   that renders as nothing. The rest of the braille block is visible and is
 *   not refused.
 *
 * The sweep that settled it: ten lines held a no-break space, two of them
 * another space as well, seven held a variation selector and three a blank
 * braille pattern -- all in TypeScript, all escapes now -- and nothing held a
 * Hangul filler, a Khmer vowel, a combining grapheme joiner or a supplementary
 * selector. So nothing new joins `FORMAT_ALLOWED`, which is
 * where a document that has to show one would be listed.
 */
const FORMAT = new RegExp(
  [
    '[\\p{Cf}\\p{Zl}\\p{Zp}\\u115F\\u1160\\u2800\\u3164\\uFFA0]',
    '(?!\\u0020)\\p{Zs}',
    // marks, each alone in its own class: `no-misleading-character-class` is right that a
    // combining character beside others in one is read as a sequence, and these are not
    '\\u034F',
    '\\u17B4',
    '\\u17B5',
    '[\\u180B-\\u180D]',
    '\\u180F',
    '[\\uFE00-\\uFE0F]',
    '[\\u{E0100}-\\u{E01EF}]',
  ].join('|'),
  'gu'
);

/**
 * The tracked names that hold a character a reader cannot see: `FORMAT`, and a
 * control character as well. A path is in a diff as much as a line is, and a
 * right-to-left override in a file name is the oldest form of this -- a name
 * ending in `exe` drawn as one that does not.
 */
function hiddenInNames(names: readonly string[]): string[] {
  const hidden = new RegExp(`${FORMAT.source}|\\p{Cc}`, 'u');
  return names.filter((name) => hidden.test(name)).map((name) => JSON.stringify(name));
}

/** A file allowed to hold format characters: which ones, and why it has to. */
interface Allowance {
  readonly codes: readonly number[];
  readonly reason: string;
}

/**
 * What may hold one literally anyway: per file, and per character.
 *
 * JavaScript and TypeScript have an escape for every one of these characters,
 * so code never needs the literal: the joiners inside the family emoji the tests
 * measure are written as escapes between the pictographs they join, which is
 * the same string and shows the reader what is there. Markdown is where there is
 * no escape, because a code span shows a backslash sequence and a character
 * reference exactly as typed -- so a document whose example *is* the character
 * has to hold it. Listed by file rather than inferred from where a joiner sits,
 * so that the next one is a decision somebody makes.
 *
 * An entry names the characters as well as the file, because a reason for a
 * joiner is no reason for a right-to-left override: allowing the whole file
 * would let one into the README, which is the page npm renders.
 */
const FORMAT_ALLOWED = new Map<string, Allowance>([
  [
    'packages/sigil/README.md',
    {
      codes: [0x200d],
      reason:
        'the `stringWidth()` example and `charLimit` each show a family emoji, which is ' +
        'one grapheme cluster because of its joiners, and npm renders the README for people',
    },
  ],
]);

/** Each line that holds a format character, with the characters it holds. */
function scan(raw: Buffer): { line: number; codes: number[] }[] {
  const found: { line: number; codes: number[] }[] = [];

  // `Buffer#toString()` keeps a leading byte order mark where a `TextDecoder`
  // would strip it, so a mark is found at the start of a file as well as part
  // way down, which is where the four in `@ttylabs/config-xml`'s comments were
  const lines = raw.toString('utf8').split('\n');
  for (const [index, line] of lines.entries()) {
    const codes = new Set([...line.matchAll(FORMAT)].map((match) => match[0].codePointAt(0) ?? 0));
    if (codes.size > 0) {
      found.push({ codes: [...codes].sort((a, b) => a - b), line: index + 1 });
    }
  }

  return found;
}

/**
 * Each line of each file that holds a format character its `FORMAT_ALLOWED`
 * entry does not name, as `name:line: U+202E`.
 *
 * A file git would call binary is skipped only if it is on `ALLOWED`: it has no
 * diff for an invisible character to mislead, and it is somebody's decision
 * already. A NUL anywhere else does not buy a way past this check -- that file
 * is read like any other, and `should be text to git` fails it besides.
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
    if (allowed(name) && raw.subarray(0, 8000).includes(0)) {
      continue;
    }

    const exempt = new Set(FORMAT_ALLOWED.get(name)?.codes);
    for (const { codes, line } of scan(raw)) {
      const refused = codes.filter((code) => !exempt.has(code));
      if (refused.length > 0) {
        offenders.push(`${name}:${line}: ${refused.map(codePoint).join(', ')}`);
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
    const offenders = formatCharacters(root, tracked());

    expect(offenders, offenders.join('\n')).toEqual([]);
  });

  it('should list only what a file holds, so that the list cannot outlive its reason', () => {
    const all = new Set(tracked());

    for (const [name, { codes }] of FORMAT_ALLOWED) {
      expect(all.has(name), name).toBe(true);
      const held = new Set(scan(readFileSync(join(root, name))).flatMap((found) => found.codes));
      expect(
        codes.filter((code) => !held.has(code)).map(codePoint),
        `${name} is allowed what it does not hold`
      ).toEqual([]);
    }
  });

  it('should name no tracked file with a character a reader cannot see', () => {
    expect(hiddenInNames(tracked())).toEqual([]);
  });

  describe('a planted format character', () => {
    // built from code points rather than written as escapes, because an escape
    // written through a tool can land as the character itself, which is how this
    // check came to be asked for
    const planted = [
      0x061c, 0x200b, 0x200c, 0x200d, 0x200e, 0x200f, 0x202a, 0x202b, 0x202c, 0x202d, 0x202e,
      0x2028, 0x2029, 0x2060, 0x2066, 0x2067, 0x2068, 0x2069, 0xfeff, 0xe0041,
      // SIG-511: spaces that are not U+0020, the selectors, and the blank letters
      0x00a0, 0x1680, 0x2003, 0x202f, 0x205f, 0x3000, 0xfe00, 0xfe0e, 0xfe0f, 0x180b, 0xe0100,
      0xe01ef, 0x034f, 0x115f, 0x1160, 0x17b4, 0x17b5, 0x2800, 0x3164, 0xffa0,
    ];
    const zwj = String.fromCodePoint(0x200d);
    const rlo = String.fromCodePoint(0x202e);

    /** Writes `content` at `name` under a fresh directory, and checks it. */
    function plant(content: string | Buffer, name = 'planted.ts'): string[] {
      const dir = tempDir('sigil-sources-');
      mkdirSync(dirname(join(dir, name)), { recursive: true });
      writeFileSync(join(dir, name), content);
      return formatCharacters(dir, [name]);
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
      const pdf = String.fromCodePoint(0x202c);
      expect(plant(`a${rlo}b${pdf}${rlo}\nok\nc${rlo}\n`)).toEqual([
        'planted.ts:1: U+202C, U+202E',
        'planted.ts:3: U+202E',
      ]);
    });

    it('should pass a plain space and what sits beside the refused characters', () => {
      // each is next to a refused code point and is not one: the space, the
      // visible braille cells either side of the blank one, and the
      // characters just outside each selector block
      const beside = [
        0x20, 0x2801, 0x28ff, 0xfe10, 0x34e, 0xe00ff, 0xe01f0, 0x3165, 0xff9f, 0xffa1,
      ];
      const text = beside.map((code) => String.fromCodePoint(code)).join('');
      expect(plant(`const label = 'a b ${text}';\n`)).toEqual([]);
    });

    it('should pass the same character written as an escape, which is the fix', () => {
      const backslash = String.fromCodePoint(0x5c);
      expect(plant(`const label = 'a${backslash}u202Eb';\n`)).toEqual([]);
    });

    it('should let a listed file hold what it is listed for, and nothing else', () => {
      const name = 'packages/sigil/README.md';
      expect(FORMAT_ALLOWED.get(name)?.codes).toEqual([0x200d]);
      expect(plant(`a family: x${zwj}y\n`, name)).toEqual([]);
      expect(plant(`a family: x${zwj}y\nand ${rlo}more\n`, name)).toEqual([`${name}:2: U+202E`]);
    });

    it('should skip a binary file only when somebody listed it', () => {
      const binary = Buffer.from(`\0${rlo}`, 'utf8');
      expect(plant(binary, 'website/src/app/favicon.ico')).toEqual([]);
      expect(plant(binary)).toEqual(['planted.ts:1: U+202E']);
    });

    it('should refuse one in a file name, and a control character there too', () => {
      const names = ['src/ok.ts', `src/gnp${rlo}.exe`, 'src/a\tb.ts', `src/c${zwj}d.ts`];
      expect(hiddenInNames(names)).toEqual(names.slice(1).map((name) => JSON.stringify(name)));
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
