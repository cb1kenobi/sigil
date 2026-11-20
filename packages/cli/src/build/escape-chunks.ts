/**
 * The last thing done to a bundle: no control character a terminal would act on
 * is left in what was written.
 *
 * The runtime builds `ESC` with `String.fromCharCode()` precisely so a raw
 * control character never sits in source -- and the minifier constant-folds
 * that straight back into a raw byte. A built app inlines the runtime, so
 * without this every minified app ships the sequence: three raw control
 * characters in one fixture's bundle, the first time minification was turned
 * on, and three is all it takes -- one of them opens a hyperlink.
 *
 * It matters because Node prints the offending source line on an uncaught
 * error, so a crash near one writes `ESC ] 8 ; ;` to the user's terminal and
 * leaves everything after it inside a hyperlink nothing closes. A CLI that dies
 * must not take the terminal with it.
 *
 * Done to the **files**, not in a `generateBundle` hook, which is where this
 * started: minification is an output stage that runs after the hooks, so the
 * escapes were folded straight back. What is written is the only thing the
 * minifier is finished with. Escaping a raw byte inside a string to `\xNN` is
 * the same string to JavaScript and inert to a terminal, so doing it last is
 * safe as well as sufficient -- **except in three places, which are the reason
 * this is a module of its own** (SIG-394):
 *
 * - **A tagged template's raw strings.** `\xNN` is the same *cooked* string, and
 *   `strings.raw` -- which `String.raw` and any tag that reads it use -- is the
 *   text as written, so a tag was handed seven characters where its source said
 *   four. Nothing can be written that keeps the invariant and the `.raw`, so a
 *   chunk with such a byte is refused rather than rewritten; see
 *   `unescapableControl()`.
 * - **A regular expression literal's source.** The same shape, found by review:
 *   matching is unchanged, but `re.source` and `String(re)` are text as written,
 *   and the minifier leaves a raw byte in a literal raw. Refused alongside.
 * - **The sourcemap.** A one-line minified chunk has every token on line one,
 *   and widening it by three columns per escape moved each later token off the
 *   column the map recorded for it. See `shiftMappings()`.
 *
 * The same rule `packages/sigil`'s own build runs over its own output, said here
 * because an app's bundle is the other place the runtime's source ends up. That
 * copy needs neither of the two: it writes no sourcemap, and nothing in the
 * source it reads can hold a raw control character to begin with.
 */

import { parseTree } from './parse-module.ts';
import { walk } from './walk.ts';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Every control character, as a property rather than as a range.
 *
 * `\p{Cc}` is exactly C0, `DEL` and C1 -- the same set a class of
 * `\u0000-\u0008\u000B...` spelled out, checked against all 1,112,064 code
 * points -- and it names what is being matched instead of enumerating it. It
 * also carries no control character, escaped or otherwise, so `no-control-regex`
 * has nothing to say and there is no suppression to keep in place.
 *
 * Which is what this replaced: the class was covered by an
 * `eslint-disable-next-line`, the formatter later wrapped the call and moved the
 * regex to its own line, and the comment stayed above the line it had been
 * written over. A suppression a formatter can detach from its target is one that
 * stops working without anybody editing it.
 */
const CONTROL = /\p{Cc}/gu;

/**
 * What the pass has to look at: a control character, and the two separators that
 * are not one.
 *
 * `U+2028` and `U+2029` are `\p{Zl}` and `\p{Zp}` and are left as they are, but
 * a sourcemap starts a new generated line at either -- measured, a raw one in a
 * tagged template's quasi gave a map of three lines over a chunk of one `\n`
 * line -- so a column recorded after one is counted from it. Named by property
 * for the reason `CONTROL` is.
 */
const LINES = /\p{Cc}|\p{Zl}|\p{Zp}/gu;

/** The three a file is allowed to keep, because they are its own formatting. */
const FORMATTING = new Set(['\t', '\n', '\r']);

/** What a `\xNN` escape adds to one character, which is one column. */
const WIDENS_BY = 3;

/** A raw control character found where it cannot be escaped. */
export interface UnescapableControl {
  /** What holds it, for the sentence that names it. */
  readonly in: 'a regular expression literal' | 'a tagged template';
  /** The chunk, as rolldown named it. */
  readonly chunk: string;
  /** One-based, in the chunk. */
  readonly column: number;
  /** The control character's code point. */
  readonly codePoint: number;
  /** One-based, in the chunk. */
  readonly line: number;
}

/**
 * The escape for one control character.
 *
 * @param c - The character.
 * @returns `\xNN`.
 */
function escapeOne(c: string): string {
  return `\\x${c.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}`;
}

/**
 * Escapes what a chunk holds, and records where, so a sourcemap can follow.
 *
 * @param code - The chunk.
 * @returns The escaped text, and per line the column of every character that was
 *   replaced, in order. A line with none has no entry.
 */
export function escapeCode(code: string): { code: string; moved: Map<number, number[]> } {
  const moved = new Map<number, number[]>();
  let line = 0;
  let lineStart = 0;
  let out = '';
  let from = 0;

  for (const match of code.matchAll(LINES)) {
    const c = match[0];
    const at = match.index;

    if (c === '\n' || c === '\u2028' || c === '\u2029') {
      line++;
      lineStart = at + 1;
      continue;
    }

    if (FORMATTING.has(c)) {
      continue;
    }

    out += code.slice(from, at) + escapeOne(c);
    from = at + 1;
    const columns = moved.get(line) ?? [];
    columns.push(at - lineStart);
    moved.set(line, columns);
  }

  return { code: moved.size ? out + code.slice(from) : code, moved };
}

/**
 * The first raw control character sitting where an escape would change what the
 * program can read.
 *
 * A tagged template's `.raw` is the text as it was written, which is the one
 * string an escape cannot keep: `` String.raw`<ESC>x` `` is two characters and
 * `` String.raw`\x1Bx` `` is five, and a tag that reads `strings.raw` -- a
 * styling tag handing a sequence through, say -- behaves differently once built.
 * A regular expression literal is the same shape: it matches the same text
 * either way, but `re.source` and `String(re)` are what was written. An untagged
 * template has no `.raw` anybody can read, and its cooked value is the same
 * string either way, so only a *tagged* one is looked for.
 *
 * The only way one reaches a chunk is from source -- the minifier folds a
 * constant into a string or an untagged template and never into a quasi a tag
 * will read or a regular expression, since that would change what is read -- so
 * the author can fix it by writing the escape, which is exactly what the pass
 * would have done and now says so rather than doing it behind their back.
 *
 * A chunk that does not parse is not asked: it is a refusal of its own, made
 * before this runs, and there is no tree to read.
 *
 * @param file - The chunk's name, which decides the language the way it does for
 *   every other read of one.
 * @param code - The chunk.
 * @returns Where it is, or `undefined` if there is none.
 */
export function unescapableControl(file: string, code: string): UnescapableControl | undefined {
  const program = parseTree(file, code);
  if (!program) {
    return undefined;
  }

  let found: UnescapableControl | undefined;

  /** Records the first control character in `text`, searched for from `from`. */
  const look = (text: string, from: number, holder: UnescapableControl['in']): void => {
    const c = [...text.matchAll(CONTROL)].find((m) => !FORMATTING.has(m[0]))?.[0];
    if (c === undefined) {
      return;
    }

    // from the start of the part that holds it rather than of the template, so
    // that an expression's string with the same character in it is not the one
    // named. A raw `\r` is normalised to `\n` in `.raw`, so the character asked
    // for is never one of those
    const at = code.indexOf(c, from);
    const before = code.slice(0, at);
    found = {
      chunk: file,
      codePoint: c.codePointAt(0)!,
      column: at - (before.lastIndexOf('\n') + 1) + 1,
      in: holder,
      line: before.split('\n').length,
    };
  };

  walk(program, (node) => {
    if (found) {
      return false;
    }

    if (node.type === 'TaggedTemplateExpression') {
      for (const quasi of node.quasi.quasis) {
        look(quasi.value.raw, quasi.start, 'a tagged template');

        if (found) {
          break;
        }
      }
    } else if (node.type === 'Literal' && 'regex' in node && node.regex) {
      look(node.regex.pattern, node.start, 'a regular expression literal');
    }

    return !found;
  });

  return found;
}

/**
 * The base64 alphabet a sourcemap's variable-length quantities are written in.
 */
const BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/**
 * Reads one variable-length quantity off the front of a segment.
 *
 * @param segment - A segment, or what is left of one.
 * @returns The signed value and how many characters it took.
 */
function decodeVlq(segment: string): { length: number; value: number } {
  let result = 0;
  let shift = 0;
  let length = 0;

  for (;;) {
    const char = segment[length++];
    const digit = char === undefined ? -1 : BASE64.indexOf(char);
    if (digit < 0) {
      throw new Error(`Malformed sourcemap segment "${segment}"`);
    }

    result += (digit & 31) * 2 ** shift;
    shift += 5;

    if (!(digit & 32)) {
      break;
    }
  }

  return { length, value: result % 2 ? -(result - 1) / 2 : result / 2 };
}

/**
 * Writes one variable-length quantity.
 *
 * @param value - A signed integer.
 * @returns Its base64 text.
 */
function encodeVlq(value: number): string {
  let rest = value < 0 ? -value * 2 + 1 : value * 2;
  let out = '';

  do {
    let digit = rest % 32;
    rest = Math.floor(rest / 32);

    if (rest > 0) {
      digit |= 32;
    }

    out += BASE64[digit];
  } while (rest > 0);

  return out;
}

/**
 * Moves a sourcemap's generated columns to where the escapes put them.
 *
 * The map was written for the chunk as the minifier emitted it, and `\x9B` is
 * four columns where the character was one. On a minified chunk every token is
 * on one line, so one escape early in it moved every token after it: measured,
 * four raw C1 characters ahead of `console.log` put the map's entry for it on
 * the ` c); console.wa` of the source, and a stack frame from a built app pointed
 * at the wrong token by three columns per escape. Every app carries at least one,
 * since the runtime's own `U+009B` is folded back raw.
 *
 * Only the first field of each segment is a *generated* column, and it is
 * written as a difference from the segment before it, so the segment is read to
 * an absolute column, moved, and written back as a difference; the rest of the
 * segment -- source, original line and column, name -- is copied as it is. A
 * segment at the column of a replaced character stays where that character
 * starts, which is what the next one's difference is taken from.
 *
 * @param mappings - The map's `mappings`.
 * @param moved - What `escapeCode()` replaced, per line.
 * @returns The `mappings` for the escaped chunk.
 */
export function shiftMappings(
  mappings: string,
  moved: ReadonlyMap<number, readonly number[]>
): string {
  return mappings
    .split(';')
    .map((line, index) => {
      const columns = moved.get(index);
      if (!columns || !line) {
        return line;
      }

      let was = 0;
      let now = 0;
      let passed = 0;

      return line
        .split(',')
        .map((segment) => {
          const { length, value } = decodeVlq(segment);
          was += value;

          while (passed < columns.length && columns[passed]! < was) {
            passed++;
          }

          const to = was + passed * WIDENS_BY;
          const out = encodeVlq(to - now) + segment.slice(length);
          now = to;
          return out;
        })
        .join(',');
    })
    .join(';');
}

/**
 * Escapes every chunk of a build, or refuses before writing any of them.
 *
 * Two phases because a refusal has to leave the output as rolldown wrote it for
 * the caller to unwind: it is asked of every chunk first, and only if none
 * holds a raw control character where an escape would change what is read is anything written. The
 * sourcemap beside a chunk that changed is moved with it.
 *
 * An asset is not a module and is left as it is, a sourcemap's own column
 * shifts aside.
 *
 * @param out - The output directory.
 * @param output - What rolldown wrote.
 * @returns The first raw control character that cannot be escaped, or `undefined`
 *   once everything is escaped.
 */
export function escapeChunks(
  out: string,
  output: readonly { fileName: string; type: string }[]
): UnescapableControl | undefined {
  const names = new Set(output.map((one) => one.fileName));
  const changed: { code: string; file: string; map?: { file: string; text: string } }[] = [];

  for (const chunk of output) {
    if (chunk.type !== 'chunk') {
      continue;
    }

    const file = join(out, chunk.fileName);
    const code = readFileSync(file, 'utf-8');
    const escaped = escapeCode(code);

    if (escaped.code === code) {
      continue;
    }

    const refused = unescapableControl(chunk.fileName, code);
    if (refused) {
      return refused;
    }

    // read and moved here, with the refusal, so a map that cannot be read as
    // one stops the build before any file has been written
    const mapFile = names.has(`${chunk.fileName}.map`) ? `${file}.map` : undefined;
    let map: { file: string; text: string } | undefined;

    if (mapFile) {
      const parsed = JSON.parse(readFileSync(mapFile, 'utf-8')) as { mappings?: string };
      if (typeof parsed.mappings === 'string') {
        parsed.mappings = shiftMappings(parsed.mappings, escaped.moved);
        map = { file: mapFile, text: JSON.stringify(parsed) };
      }
    }

    changed.push({ code: escaped.code, file, map });
  }

  for (const { code, file, map } of changed) {
    writeFileSync(file, code);

    if (map) {
      writeFileSync(map.file, map.text);
    }
  }

  return undefined;
}
