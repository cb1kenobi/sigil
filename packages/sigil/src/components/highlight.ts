/**
 * Syntax highlighting: a small lexer per language, written here, answering with the
 * spans every highlight seam takes.
 *
 * `multiline()`, `TextArea()`, `diff()` and `markdown()` each ask a `Highlighter`
 * which stretches of some code are which tokens, and draw a token in its class and,
 * where `TOKEN_ROLE` gives one, its role. This is a highlighter to hand them:
 *
 * ```js
 * import { highlightCode } from '@ttylabs/sigil/components/highlight';
 *
 * markdown(source, { highlight: highlightCode });
 * TextArea({ highlight: highlightCode, lang: 'ts' });
 * ```
 *
 * **A lexer, not a grammar.** Each language is one forward pass that knows what a
 * comment, a string, a number and a keyword look like, which is what a reader scans
 * code for; it builds no tree and never asks what an expression means. So a regular
 * expression in JavaScript is told from a division by what came before it, a YAML
 * key by the colon after it, and a shell command by where it stands -- the same
 * guesses every editor's quick highlighter makes, and wrong in the same corners.
 * Tree-sitter is a dependency and lives in a package of its own if anywhere: see
 * "Syntax highlighting" in `src/components/AGENTS.md`.
 *
 * **Linear, whatever it is handed.** A highlighter runs on every keystroke in a text
 * area and on whatever a user pipes into a diff, so every scan either consumes what
 * it read or remembers that it failed: a regular expression that does not close on
 * its line is not looked for again on that line, a search for a closing delimiter
 * that found none is not repeated, and no pattern here can backtrack over more than
 * the token it is matching. `test/components/highlight.test.ts` reads thirty
 * pathological inputs at two sizes rather than trusting this sentence.
 *
 * **Spans come out in order and never overlap**, which is what lets a text area file
 * them by line with a step or two rather than a search.
 */

import type { HighlightSpan } from './prompt.js';

/** A language `highlightCode()` reads, by the name it is filed under. */
export type CodeLanguage = 'diff' | 'js' | 'json' | 'markdown' | 'sh' | 'ts' | 'yaml';

/** Every language `highlightCode()` reads. */
export const CODE_LANGUAGES: readonly CodeLanguage[] = [
  'diff',
  'js',
  'json',
  'markdown',
  'sh',
  'ts',
  'yaml',
];

/**
 * Every name a language goes by: a fence's info word, a file's extension, or what
 * somebody would type. A `Map`, since a name is the app's or the document's and
 * `constructor` reads back truthy off a plain object.
 */
const ALIASES: ReadonlyMap<string, CodeLanguage> = new Map([
  ['bash', 'sh'],
  ['cjs', 'js'],
  ['cts', 'ts'],
  ['diff', 'diff'],
  ['javascript', 'js'],
  ['js', 'js'],
  ['json', 'json'],
  ['jsonc', 'json'],
  ['jsx', 'js'],
  ['markdown', 'markdown'],
  ['md', 'markdown'],
  ['mjs', 'js'],
  ['mts', 'ts'],
  ['patch', 'diff'],
  ['sh', 'sh'],
  ['shell', 'sh'],
  ['ts', 'ts'],
  ['tsx', 'ts'],
  ['typescript', 'ts'],
  ['yaml', 'yaml'],
  ['yml', 'yaml'],
  ['zsh', 'sh'],
]);

/**
 * The language a name stands for, if it is one `highlightCode()` reads.
 *
 * Case does not matter and space around the name is ignored, so a fence opened with
 * three backticks and `TypeScript` is read as `ts`. A name it does not know is
 * `undefined` rather than a guess: a highlighter that guessed would colour a block
 * of prose as though it were code.
 *
 * @param name - A language name, an alias, or a file extension without its dot.
 * @returns The language, or `undefined`.
 */
export function codeLanguage(name: string | undefined): CodeLanguage | undefined {
  return typeof name === 'string' ? ALIASES.get(name.trim().toLowerCase()) : undefined;
}

/**
 * Says which stretches of some code are which tokens, in the shape every highlight
 * seam takes.
 *
 * The tokens are the seven every highlighter emits -- `comment`, `function`,
 * `invalid`, `keyword`, `number`, `string` and `type` -- and `constant`, `regexp`,
 * `property` and `variable` for code, `heading`, `link` and `code` for Markdown, and
 * `inserted`, `deleted`, `meta` and `hunk` for a patch. Each of those draws in a
 * role, which `TOKEN_ROLE` says, so the theme colours the code; `emphasis` and
 * `strong` in Markdown draw in none and are there for an app's sheet.
 *
 * A language it does not know -- or none -- answers with no spans, which every seam
 * draws as code nobody highlighted.
 *
 * @param code - The code.
 * @param lang - Its language: a name `codeLanguage()` knows.
 * @returns The spans, in order, none overlapping.
 */
export function highlightCode(code: string, lang?: string): HighlightSpan[] {
  const language = codeLanguage(lang);
  return language === undefined || typeof code !== 'string' ? [] : LEXERS[language](code);
}

const LEXERS: Record<CodeLanguage, (code: string) => HighlightSpan[]> = {
  diff: lexDiff,
  js: (code) => lexScript(code, false),
  json: lexJson,
  markdown: lexMarkdown,
  sh: lexShell,
  ts: (code) => lexScript(code, true),
  yaml: lexYaml,
};

/**
 * The spans of one pass, merging a span into the one before it where they are the
 * same token and touch, so a run of bad characters is one span and not forty.
 */
class Spans {
  readonly list: HighlightSpan[] = [];

  add(start: number, end: number, token: string): void {
    if (end <= start) {
      return;
    }
    const last = this.list[this.list.length - 1];
    if (last !== undefined && last.token === token && last.end === start) {
      last.end = end;
      return;
    }
    this.list.push({ end, start, token });
  }
}

/**
 * Where the next `needle` is at or after an offset, for offsets that only move
 * forward -- which is what makes a search for a closer that is not there cost one
 * scan, however many openers ask.
 *
 * @param code - What to search.
 * @param needle - What to find.
 * @returns A search: the offset, or `-1` for none.
 */
function finder(code: string, needle: string): (from: number) => number {
  let asked = -1;
  let found = -1;
  return (from) => {
    // nothing between `asked` and `found`, and nothing at all past `asked` if none
    if (asked >= 0 && from >= asked && (found === -1 || found >= from)) {
      return found;
    }
    asked = from;
    found = code.indexOf(needle, from);
    return found;
  };
}

/** Where the line an offset is on ends: its `\n`, or the end of the code. */
function lineEnd(code: string, at: number): number {
  const end = code.indexOf('\n', at);
  return end === -1 ? code.length : end;
}

/** Space that is not a line break. */
function isBlank(c: string | undefined): boolean {
  return c === ' ' || c === '\t' || c === '\r' || c === '\f' || c === '\v';
}

// -- JavaScript and TypeScript ----------------------------------------------------

const JS_KEYWORDS = new Set([
  'as',
  'async',
  'await',
  'break',
  'case',
  'catch',
  'class',
  'const',
  'continue',
  'debugger',
  'default',
  'delete',
  'do',
  'else',
  'export',
  'extends',
  'finally',
  'for',
  'function',
  'if',
  'import',
  'in',
  'instanceof',
  'let',
  'new',
  'of',
  'return',
  'static',
  'super',
  'switch',
  'this',
  'throw',
  'try',
  'typeof',
  'var',
  'void',
  'while',
  'with',
  'yield',
]);

/** TypeScript's own words, which are identifiers in JavaScript. */
const TS_KEYWORDS = new Set([
  'abstract',
  'accessor',
  'asserts',
  'declare',
  'enum',
  'implements',
  'infer',
  'interface',
  'is',
  'keyof',
  'namespace',
  'override',
  'private',
  'protected',
  'public',
  'readonly',
  'satisfies',
  'unique',
]);

const TS_TYPES = new Set([
  'any',
  'bigint',
  'boolean',
  'never',
  'number',
  'object',
  'string',
  'symbol',
  'unknown',
]);

const JS_CONSTANTS = new Set(['Infinity', 'NaN', 'false', 'null', 'true', 'undefined']);

/** Keywords that end an expression, after which a `/` divides. */
const JS_VALUE_KEYWORDS = new Set(['super', 'this']);

/** Keywords whose next name is a type: `class Foo`, `new Foo`. */
const JS_TYPE_NEXT = new Set([
  'class',
  'enum',
  'extends',
  'implements',
  'interface',
  'new',
  'type',
]);

const IDENT = /[\p{ID_Start}$_][\p{ID_Continue}$‌‍]*/uy;
const JS_NUMBER =
  /(?:0[xX][\da-fA-F_]*|0[oO][0-7_]*|0[bB][01_]*|(?:\d[\d_]*\.?[\d_]*|\.\d[\d_]*)(?:[eE][+-]?[\d_]+)?)n?/y;

/**
 * JavaScript, or TypeScript with `ts`.
 *
 * What it reads: comments, a `#!` line, the three kinds of string with a template's
 * `${}` holes lexed as code (to any depth), regular expressions where an operand is
 * expected, numbers in every base, keywords (TypeScript's too, with `type` only where
 * a name follows it), the literal constants, a name before `(` as a `function`, a
 * name after `class`, `new` or `extends` as a `type`, and a capitalized name as a
 * `type` and an upper-case one as a `constant`, which is the convention rather than
 * the language. A name after `.` is a property, and only a call makes it anything.
 * JSX tags are read as the operators and names they are spelled with.
 *
 * @param code - The code.
 * @param ts - Whether TypeScript's words are words.
 * @returns The spans.
 */
function lexScript(code: string, ts: boolean): HighlightSpan[] {
  const out = new Spans();
  const n = code.length;
  /** Whether a `/` here would start a regular expression rather than divide. */
  let operand = true;
  /** A regular expression that did not close: none is looked for again before here. */
  let noRegexBefore = -1;
  /** The keyword before this name, for `class Foo` and `function foo`. */
  let lastKeyword = '';
  /** Whether the last thing read was a `.`, so a name is a member. */
  let member = false;
  /** Brace depth, and for each open `${`, the depth it opened at. */
  let depth = 0;
  const holes: number[] = [];
  let i = 0;

  if (code.startsWith('#!')) {
    i = lineEnd(code, 0);
    out.add(0, i, 'comment');
  }

  /**
   * Reads template text from `from` to its end or to a `${`, and says which.
   *
   * @param from - Just inside the backtick, or just after a hole's `}`.
   * @returns Where the text stopped, after the backtick or the `${`.
   */
  const template = (from: number): { end: number; hole: boolean } => {
    let j = from;
    while (j < n) {
      const c = code[j];
      if (c === '\\') {
        j += 2;
      } else if (c === '`') {
        return { end: j + 1, hole: false };
      } else if (c === '$' && code[j + 1] === '{') {
        return { end: j + 2, hole: true };
      } else {
        j++;
      }
    }
    return { end: n, hole: false };
  };

  const readTemplate = (start: number, from: number): void => {
    const piece = template(from);
    out.add(start, piece.end, 'string');
    i = piece.end;
    if (piece.hole) {
      holes.push(depth);
      depth++;
      operand = true;
    } else {
      operand = false;
    }
  };

  while (i < n) {
    const c = code[i]!;

    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') {
      i++;
      continue;
    }

    if (c === '/') {
      const next = code[i + 1];
      if (next === '/') {
        const end = lineEnd(code, i);
        out.add(i, end, 'comment');
        i = end;
        continue;
      }
      if (next === '*') {
        const close = code.indexOf('*/', i + 2);
        const end = close === -1 ? n : close + 2;
        out.add(i, end, 'comment');
        i = end;
        continue;
      }
      if (operand && i >= noRegexBefore) {
        const end = scanRegex(code, i);
        if (end > 0) {
          out.add(i, end, 'regexp');
          i = end;
          operand = false;
          member = false;
          continue;
        }
        noRegexBefore = lineEnd(code, i);
      }
      i++;
      operand = true;
      member = false;
      continue;
    }

    if (c === '"' || c === "'") {
      const end = scanQuoted(code, i, c);
      out.add(i, end, 'string');
      i = end;
      operand = false;
      member = false;
      continue;
    }

    if (c === '`') {
      member = false;
      readTemplate(i, i + 1);
      continue;
    }

    if (c === '{') {
      depth++;
      i++;
      operand = true;
      member = false;
      continue;
    }

    if (c === '}') {
      if (holes.length > 0 && holes[holes.length - 1] === depth - 1) {
        // the `}` that closes a hole is part of the template's text again
        holes.pop();
        depth--;
        readTemplate(i, i + 1);
        continue;
      }
      depth = Math.max(0, depth - 1);
      i++;
      operand = false;
      member = false;
      continue;
    }

    const digit = c >= '0' && c <= '9';
    if (digit || (c === '.' && code[i + 1]! >= '0' && code[i + 1]! <= '9')) {
      JS_NUMBER.lastIndex = i;
      const found = JS_NUMBER.exec(code);
      const end = found ? i + found[0].length : i + 1;
      out.add(i, end, 'number');
      i = end;
      operand = false;
      member = false;
      continue;
    }

    IDENT.lastIndex = i;
    const word = IDENT.exec(code)?.[0];
    if (word !== undefined) {
      const end = i + word.length;
      const token = member ? memberToken(code, end) : scriptWord(code, word, end, ts, lastKeyword);
      if (token !== undefined) {
        out.add(i, end, token);
      }
      const keyword = token === 'keyword';
      lastKeyword = keyword ? word : '';
      operand = keyword && !JS_VALUE_KEYWORDS.has(word);
      member = false;
      i = end;
      continue;
    }

    // punctuation and operators: a `.` makes the next name a member, a closer ends
    // an operand, and anything else expects one
    member = c === '.' && code[i - 1] !== '.' && code[i + 1] !== '.';
    operand = c !== ')' && c !== ']';
    if (c !== '.') {
      lastKeyword = '';
    }
    i++;
  }

  return out.list;
}

/**
 * What a name after `.` is: a `function` where it is called, and nothing otherwise.
 *
 * @param code - The code.
 * @param end - Where the name ends.
 * @returns The token, or `undefined`.
 */
function memberToken(code: string, end: number): string | undefined {
  return calledAt(code, end) ? 'function' : undefined;
}

/**
 * Whether a `(` follows, past any space on the same line.
 *
 * @param code - The code.
 * @param at - Where to look from.
 * @returns Whether it is a call.
 */
function calledAt(code: string, at: number): boolean {
  let j = at;
  while (code[j] === ' ' || code[j] === '\t') {
    j++;
  }
  return code[j] === '(';
}

/**
 * What a name in script is.
 *
 * @param code - The code.
 * @param word - The name.
 * @param end - Where it ends.
 * @param ts - Whether TypeScript's words are words.
 * @param after - The keyword just before it, if one was.
 * @returns The token, or `undefined` for a plain name.
 */
function scriptWord(
  code: string,
  word: string,
  end: number,
  ts: boolean,
  after: string
): string | undefined {
  if (JS_CONSTANTS.has(word)) {
    return 'constant';
  }
  if (JS_KEYWORDS.has(word)) {
    return 'keyword';
  }
  if (word === 'from') {
    // `import x from 'y'`, and a variable called `from` everywhere else
    let j = end;
    while (code[j] === ' ' || code[j] === '\t') {
      j++;
    }
    return code[j] === '"' || code[j] === "'" ? 'keyword' : undefined;
  }
  if (ts) {
    if (TS_KEYWORDS.has(word)) {
      return 'keyword';
    }
    if (word === 'type') {
      // `type Name =`, and a property or variable called `type` everywhere else
      let j = end;
      while (code[j] === ' ' || code[j] === '\t') {
        j++;
      }
      IDENT.lastIndex = j;
      if (j > end && IDENT.test(code)) {
        return 'keyword';
      }
    }
    if (TS_TYPES.has(word)) {
      return 'type';
    }
  }
  if (after === 'function') {
    return 'function';
  }
  if (JS_TYPE_NEXT.has(after)) {
    return 'type';
  }
  if (calledAt(code, end)) {
    return 'function';
  }
  const first = word[0]!;
  if (first >= 'A' && first <= 'Z') {
    return word.toUpperCase() === word ? (word.length > 1 ? 'constant' : 'type') : 'type';
  }
  return undefined;
}

/**
 * Where a regular expression starting at `/` ends, or `0` when it does not end on
 * its line -- in which case the `/` was a division after all.
 *
 * @param code - The code.
 * @param start - The opening `/`.
 * @returns The offset after its flags, or `0`.
 */
function scanRegex(code: string, start: number): number {
  let inClass = false;
  for (let j = start + 1; j < code.length; j++) {
    const c = code[j];
    if (c === '\n' || c === '\r') {
      return 0;
    }
    if (c === '\\') {
      j++;
    } else if (c === '[') {
      inClass = true;
    } else if (c === ']') {
      inClass = false;
    } else if (c === '/' && !inClass) {
      let end = j + 1;
      while (/[a-z]/.test(code[end] ?? '')) {
        end++;
      }
      return end;
    }
  }
  return 0;
}

/**
 * Where a quoted string ends: after its closing quote, or at the end of its line
 * where it has none, so one unclosed quote colours one line rather than the file.
 *
 * @param code - The code.
 * @param start - The opening quote.
 * @param quote - Which quote.
 * @returns The offset after it.
 */
function scanQuoted(code: string, start: number, quote: string): number {
  for (let j = start + 1; j < code.length; j++) {
    const c = code[j];
    if (c === '\\') {
      j++;
    } else if (c === quote) {
      return j + 1;
    } else if (c === '\n') {
      return j;
    }
  }
  return code.length;
}

// -- JSON -------------------------------------------------------------------------

const JSON_NUMBER = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y;
const JSON_WORD = /[^\s{}[\],:"/]+/y;

/**
 * JSON, with the comments JSONC allows -- the format sigil's own config is read in.
 *
 * A string followed by a `:` is a `property`, `true`, `false` and `null` are
 * constants, and anything JSON has no reading of is `invalid`, so a stray word or a
 * single-quoted string shows where a file stopped being JSON. An unclosed string is
 * a string to the end of its line.
 *
 * @param code - The JSON.
 * @returns The spans.
 */
function lexJson(code: string): HighlightSpan[] {
  const out = new Spans();
  const n = code.length;
  let i = 0;

  while (i < n) {
    const c = code[i]!;
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') {
      i++;
      continue;
    }
    if (c === '{' || c === '}' || c === '[' || c === ']' || c === ',' || c === ':') {
      i++;
      continue;
    }
    if (c === '/' && (code[i + 1] === '/' || code[i + 1] === '*')) {
      const close = code[i + 1] === '/' ? lineEnd(code, i) : code.indexOf('*/', i + 2);
      const end = close === -1 ? n : code[i + 1] === '/' ? close : close + 2;
      out.add(i, end, 'comment');
      i = end;
      continue;
    }
    if (c === '"') {
      const end = scanQuoted(code, i, '"');
      let j = end;
      while (code[j] === ' ' || code[j] === '\t' || code[j] === '\r' || code[j] === '\n') {
        j++;
      }
      out.add(i, end, code[j] === ':' ? 'property' : 'string');
      i = end;
      continue;
    }
    JSON_NUMBER.lastIndex = i;
    const number = JSON_NUMBER.exec(code)?.[0];
    JSON_WORD.lastIndex = i;
    const word = JSON_WORD.exec(code)?.[0] ?? c;
    const end = i + word.length;
    if (number !== undefined && number.length === word.length) {
      out.add(i, end, 'number');
    } else if (word === 'true' || word === 'false' || word === 'null') {
      out.add(i, end, 'constant');
    } else {
      out.add(i, end, 'invalid');
    }
    i = end;
  }

  return out.list;
}

// -- shell ------------------------------------------------------------------------

const SH_KEYWORDS = new Set([
  'case',
  'coproc',
  'do',
  'done',
  'elif',
  'else',
  'esac',
  'fi',
  'for',
  'function',
  'if',
  'in',
  'select',
  'then',
  'time',
  'until',
  'while',
  '[[',
]);

/** Keywords after which a command is expected. */
const SH_COMMAND_NEXT = new Set(['do', 'elif', 'else', 'if', 'then', 'time', 'until', 'while']);

/** Keywords after which a name is expected: a loop variable, or a function's. */
const SH_NAME_NEXT = new Set(['case', 'for', 'function', 'select']);

const SH_ASSIGN = /^[A-Za-z_]\w*(?:\[[^\]]*\])?\+?=/;
const SH_NAME = /[A-Za-z_]\w*/y;
const SH_WORD_END = /[\s;&|()<>'"`$]/;

/**
 * POSIX shell, and the bash and zsh most of it is written in.
 *
 * The first word of a command is a `function` -- what is being run -- or a keyword,
 * or an assignment whose name is a `variable`; `$name`, `${...}` and the special
 * parameters are variables inside double quotes as well as outside them; quotes of
 * both kinds and `$'...'` are strings; a `#` that starts a word starts a comment; and
 * a here-document's body is a string up to its delimiter. A `$(...)` inside double
 * quotes is read as the command it is, quotes and all, and the string carries on
 * after it; a `case` pattern is a word and not a command. What is not read:
 * arithmetic as anything but operators, and the command inside a backquoted
 * substitution, which stays plain.
 *
 * @param code - The script.
 * @returns The spans.
 */
function lexShell(code: string): HighlightSpan[] {
  const out = new Spans();
  const n = code.length;
  const braces = finder(code, '}');
  const breaks = finder(code, '\n');
  /** Whether the next word is a command's name. */
  let command = true;
  /** The keyword the next word is a name for: `for`, `function`. */
  let naming = '';
  /** The keyword an `in` here belongs to, after `for x` or `case $x`. */
  let wantIn = '';
  /** Whether the next word is a `case` pattern, and how many `case`s are open. */
  let pattern = false;
  let cases = 0;
  /**
   * What each open parenthesis was: a group, a `$(`, or a `$(` inside a
   * double-quoted string, whose `)` goes back to reading the string.
   */
  const parens: ('group' | 'string' | 'sub')[] = [];
  /** Here-documents whose bodies start on the next line. */
  const heredocs: { strip: boolean; word: string }[] = [];
  let i = 0;

  /**
   * Where a `$` expansion ends, or `at` itself where the `$` starts none.
   *
   * @param at - The `$`.
   * @returns The offset after it.
   */
  const expansion = (at: number): number => {
    const next = code[at + 1];
    if (next === '{') {
      const close = braces(at + 2);
      const stop = breaks(at + 2);
      return close === -1 || (stop !== -1 && stop < close) ? at + 2 : close + 1;
    }
    if (next !== undefined && /[A-Za-z_]/.test(next)) {
      SH_NAME.lastIndex = at + 1;
      return at + 1 + SH_NAME.exec(code)![0].length;
    }
    if (next !== undefined && /[\d@*#?$!-]/.test(next)) {
      return at + 2;
    }
    return at;
  };

  /**
   * A double-quoted string, with what it expands cut out of it as variables, read
   * to its close quote or to a `$(` -- whose command is read as a command, quotes
   * and all, before the string carries on after its `)`.
   *
   * @param from - Where the string's text starts: its quote, or just after a `)`.
   * @param at - Where to read from.
   * @returns Where reading stopped.
   */
  const doubleQuoted = (from: number, at: number): number => {
    let j = at;
    while (j < n) {
      const c = code[j];
      if (c === '\\') {
        j += 2;
      } else if (c === '"') {
        out.add(from, j + 1, 'string');
        return j + 1;
      } else if (c === '$' && code[j + 1] === '(') {
        out.add(from, j, 'string');
        parens.push('string');
        command = code[j + 2] !== '(';
        return j + 2;
      } else if (c === '$' && expansion(j) > j) {
        const end = expansion(j);
        out.add(from, j, 'string');
        out.add(j, end, 'variable');
        from = end;
        j = end;
      } else {
        j++;
      }
    }
    out.add(from, n, 'string');
    return n;
  };

  /** The bodies of the here-documents opened on the line just ended. */
  const bodies = (start: number): number => {
    let at = start;
    while (heredocs.length > 0) {
      const doc = heredocs.shift()!;
      const from = at;
      for (;;) {
        if (at >= n) {
          out.add(from, n, 'string');
          return n;
        }
        const end = lineEnd(code, at);
        let line = code.slice(at, end);
        if (line.endsWith('\r')) {
          line = line.slice(0, -1);
        }
        if ((doc.strip ? line.replace(/^\t+/, '') : line) === doc.word) {
          out.add(from, at, 'string');
          at = Math.min(n, end + 1);
          break;
        }
        at = end + 1;
      }
    }
    return at;
  };

  const ended = (): void => {
    command = true;
    naming = '';
    wantIn = '';
  };

  while (i < n) {
    const c = code[i]!;

    if (c === '\n') {
      i++;
      ended();
      if (heredocs.length > 0) {
        i = bodies(i);
      }
      continue;
    }
    if (isBlank(c)) {
      i++;
      continue;
    }
    if (c === '#') {
      const end = lineEnd(code, i);
      out.add(i, end, 'comment');
      i = end;
      continue;
    }
    if ((c === "'" || c === '"' || c === '$') && naming !== '') {
      // `case "$x" in`: the subject is a quoted word or an expansion, not a name
      wantIn = naming === 'function' ? '' : naming;
      naming = '';
    }
    if (c === "'") {
      const close = code.indexOf("'", i + 1);
      const end = close === -1 ? n : close + 1;
      out.add(i, end, 'string');
      i = end;
      command = false;
      continue;
    }
    if (c === '"') {
      command = false;
      i = doubleQuoted(i, i + 1);
      continue;
    }
    if (c === '$') {
      if (code[i + 1] === "'") {
        const end = scanQuoted(code, i + 1, "'");
        out.add(i, end, 'string');
        i = end;
        command = false;
        continue;
      }
      if (code[i + 1] === '(') {
        const arithmetic = code[i + 2] === '(';
        parens.push('sub');
        i += 2;
        command = !arithmetic;
        continue;
      }
      const end = expansion(i);
      if (end > i) {
        out.add(i, end, 'variable');
        i = end;
      } else {
        i++;
      }
      command = false;
      continue;
    }
    if (c === '`') {
      i++;
      command = true;
      continue;
    }
    if ((c === ';' || c === '&' || c === '|') && !(c === '&' && code[i + 1] === '>')) {
      // `;;`, `;&` and `;;&` end a `case` branch, and a pattern comes next
      const branch = c === ';' && (code[i + 1] === ';' || code[i + 1] === '&');
      i += branch ? (code[i + 2] === '&' ? 3 : 2) : 1;
      ended();
      pattern = branch && cases > 0;
      continue;
    }
    if (c === '(') {
      parens.push('group');
      i++;
      command = true;
      continue;
    }
    if (c === ')') {
      // a substitution's close leaves an argument, or the rest of the string it
      // was in; a group's, or a `case` pattern's, leaves a command
      const opened = parens.pop();
      i++;
      if (opened === 'string') {
        i = doubleQuoted(i, i);
        command = false;
        continue;
      }
      command = opened !== 'sub';
      pattern = false;
      continue;
    }
    if (c === '<' || c === '>' || c === '&') {
      if (code.startsWith('<<', i) && code[i + 2] !== '<') {
        i = heredoc(code, i, heredocs);
      } else {
        // `>`, `>>`, `&>`, `>|`, and a `>&2` or `<&-` that names a descriptor
        i++;
        while (code[i] === '<' || code[i] === '>' || code[i] === '&' || code[i] === '|') {
          i++;
        }
        if (code[i - 1] === '&') {
          while ((code[i]! >= '0' && code[i]! <= '9') || code[i] === '-') {
            i++;
          }
        }
      }
      command = false;
      continue;
    }
    if ((c === '{' || c === '}') && (i + 1 >= n || /[\s;]/.test(code[i + 1]!))) {
      i++;
      command = c === '{';
      continue;
    }

    // a word: everything up to a separator, with a backslash escaping the next --
    // and at least one character, since a space the cases above do not name is one
    let j = i;
    while (j < n && !SH_WORD_END.test(code[j]!)) {
      j += code[j] === '\\' ? 2 : 1;
    }
    j = Math.min(Math.max(j, i + 1), n);
    const word = code.slice(i, j);

    if (naming !== '') {
      out.add(i, j, naming === 'function' ? 'function' : 'variable');
      wantIn = naming === 'function' ? '' : naming;
      naming = '';
      command = false;
    } else if (wantIn !== '' && word === 'in') {
      out.add(i, j, 'keyword');
      if (wantIn === 'case') {
        cases++;
        pattern = true;
      }
      wantIn = '';
      command = false;
    } else if (word === 'esac' && cases > 0) {
      out.add(i, j, 'keyword');
      cases--;
      pattern = false;
      command = false;
    } else if (pattern) {
      // a `case` pattern is a word to match, up to the `)` that ends it
    } else if (word === ']]' || (command && SH_KEYWORDS.has(word))) {
      out.add(i, j, 'keyword');
      naming = SH_NAME_NEXT.has(word) ? word : '';
      command = SH_COMMAND_NEXT.has(word);
    } else if (command && SH_ASSIGN.test(word)) {
      // `NAME=value` before a command: the name is a variable and a command follows
      SH_NAME.lastIndex = i;
      out.add(i, i + SH_NAME.exec(code)![0].length, 'variable');
    } else if (command) {
      out.add(i, j, 'function');
      command = false;
    } else if (/^\d+$/.test(word)) {
      out.add(i, j, 'number');
    }
    i = j;
  }

  return out.list;
}

/**
 * Reads a `<<` or `<<-` and the delimiter after it, and queues the body.
 *
 * @param code - The script.
 * @param at - The `<<`.
 * @param queue - The here-documents waiting for the next line.
 * @returns The offset after the delimiter.
 */
function heredoc(code: string, at: number, queue: { strip: boolean; word: string }[]): number {
  let j = at + 2;
  const strip = code[j] === '-';
  if (strip) {
    j++;
  }
  while (code[j] === ' ' || code[j] === '\t') {
    j++;
  }
  const quote = code[j] === "'" || code[j] === '"' ? code[j] : undefined;
  if (quote !== undefined) {
    j++;
  }
  SH_NAME.lastIndex = j;
  const word = SH_NAME.exec(code)?.[0];
  if (word === undefined) {
    return at + 2;
  }
  j += word.length;
  if (quote !== undefined && code[j] === quote) {
    j++;
  }
  queue.push({ strip, word });
  return j;
}

// -- YAML -------------------------------------------------------------------------

const YAML_CONSTANT = /^(?:true|false|yes|no|on|off|null|~)$/i;
const YAML_NUMBER =
  /^[-+]?(?:\d[\d_]*(?:\.\d*)?(?:[eE][-+]?\d+)?|\.\d+(?:[eE][-+]?\d+)?|0x[\da-fA-F]+|0o[0-7]+|\.inf|\.Inf|\.INF|\.nan|\.NaN|\.NAN)$/;

/**
 * YAML, line by line.
 *
 * A key before its `:` is a `property`, a quoted scalar a string, a plain one a
 * `constant` or a `number` where it reads as one and nothing otherwise, an anchor and
 * an alias `variable`s, a tag a `type`, a `---` or `...` a `meta`, and a block
 * scalar's lines -- everything indented under a `|` or a `>` -- a string. Inside a
 * flow collection, `{` and `[`, each item is read the same way. What is not read: a
 * quoted scalar folded over several lines, which is a string to the end of its first,
 * and the `?` complex key.
 *
 * @param code - The YAML.
 * @returns The spans.
 */
function lexYaml(code: string): HighlightSpan[] {
  const out = new Spans();
  const n = code.length;
  /** The indentation of the line that opened a block scalar, or -1 outside one. */
  let block = -1;
  let start = 0;

  while (start <= n) {
    const end = lineEnd(code, start);
    let i = start;
    while (code[i] === ' ') {
      i++;
    }
    const indent = i - start;
    let stop = end;
    while (stop > i && isBlank(code[stop - 1])) {
      stop--;
    }

    if (block >= 0) {
      if (i >= stop || indent > block) {
        out.add(i, stop, 'string');
        start = end + 1;
        continue;
      }
      block = -1;
    }

    if ((code.startsWith('---', i) || code.startsWith('...', i)) && indent === 0) {
      const after = code[i + 3];
      if (after === undefined || after === '\n' || isBlank(after)) {
        out.add(i, i + 3, 'meta');
        i += 3;
      }
    }

    // `- ` list markers, any number of them
    for (;;) {
      while (isBlank(code[i])) {
        i++;
      }
      if (code[i] === '-' && (i + 1 >= stop || isBlank(code[i + 1]))) {
        i++;
      } else {
        break;
      }
    }

    if (code[i] === '#') {
      out.add(i, stop, 'comment');
      start = end + 1;
      continue;
    }

    // a block scalar ends at the first line indented no deeper than the node
    // that holds it: the key, whose column is past any `- ` markers -- so in
    // `- run: |` the item's next key, `env:`, ends it -- or, for a bare `- |`
    // with no key, the line itself
    const keyAt = i;
    i = yamlKey(code, i, stop, out);
    if (yamlValue(code, i, stop, out)) {
      block = i > keyAt ? keyAt - start : indent;
    }
    start = end + 1;
  }

  return out.list;
}

/**
 * Reads a key and its `:` if the line has one there, and colours it.
 *
 * @returns Where the value starts: after the `:`, or `at` where there is no key.
 */
function yamlKey(code: string, at: number, stop: number, out: Spans): number {
  const c = code[at];
  if (c === '"' || c === "'") {
    const end = yamlQuoted(code, at, stop);
    let j = end;
    while (isBlank(code[j]) && j < stop) {
      j++;
    }
    if (code[j] === ':' && (j + 1 >= stop || isBlank(code[j + 1]))) {
      out.add(at, end, 'property');
      return j + 1;
    }
    return at;
  }
  if (c === '{' || c === '[' || c === '|' || c === '>' || c === undefined) {
    return at;
  }
  for (let j = at; j < stop; j++) {
    const here = code[j];
    if (here === '#' && j > at && isBlank(code[j - 1])) {
      return at;
    }
    if (here === ':' && (j + 1 >= stop || isBlank(code[j + 1]))) {
      let keyEnd = j;
      while (keyEnd > at && isBlank(code[keyEnd - 1])) {
        keyEnd--;
      }
      out.add(at, keyEnd, 'property');
      return j + 1;
    }
  }
  return at;
}

/**
 * Where a quoted scalar ends on its line: `''` is a quote inside single quotes and a
 * backslash escapes inside double ones.
 */
function yamlQuoted(code: string, at: number, stop: number): number {
  const quote = code[at];
  for (let j = at + 1; j < stop; j++) {
    const c = code[j];
    if (quote === '"' && c === '\\') {
      j++;
    } else if (c === quote) {
      if (quote === "'" && code[j + 1] === "'") {
        j++;
      } else {
        return j + 1;
      }
    }
  }
  return stop;
}

/**
 * Reads a value to the end of its line and colours it.
 *
 * @returns Whether it opened a block scalar, whose lines follow.
 */
function yamlValue(code: string, at: number, stop: number, out: Spans): boolean {
  let i = at;
  let flow = 0;

  while (i < stop) {
    const c = code[i]!;
    if (isBlank(c)) {
      i++;
      continue;
    }
    if (c === '#' && (i === at || isBlank(code[i - 1]))) {
      out.add(i, stop, 'comment');
      return false;
    }
    if (c === '"' || c === "'") {
      const end = yamlQuoted(code, i, stop);
      let j = end;
      while (isBlank(code[j]) && j < stop) {
        j++;
      }
      out.add(i, end, flow > 0 && code[j] === ':' ? 'property' : 'string');
      i = end;
      continue;
    }
    if (c === '{' || c === '[') {
      flow++;
      i++;
      continue;
    }
    if (c === '}' || c === ']') {
      flow = Math.max(0, flow - 1);
      i++;
      continue;
    }
    if (c === ',' || (c === ':' && flow > 0)) {
      i++;
      continue;
    }
    if (flow === 0 && (c === '|' || c === '>')) {
      let j = i + 1;
      while (j < stop && /[-+0-9]/.test(code[j]!)) {
        j++;
      }
      while (isBlank(code[j]) && j < stop) {
        j++;
      }
      if (j >= stop || code[j] === '#') {
        if (j < stop) {
          out.add(j, stop, 'comment');
        }
        return true;
      }
    }

    // a plain scalar, or an anchor, an alias or a tag: one word in a flow, and the
    // rest of the line before a comment outside one
    let j = i;
    while (j < stop) {
      const here = code[j]!;
      if (here === '#' && isBlank(code[j - 1])) {
        break;
      }
      if (flow > 0 && (here === ',' || here === '}' || here === ']')) {
        break;
      }
      if (flow > 0 && here === ':' && (j + 1 >= stop || isBlank(code[j + 1]))) {
        break;
      }
      if ((c === '&' || c === '*' || c === '!') && isBlank(here)) {
        break;
      }
      j++;
    }
    let end = j;
    while (end > i && isBlank(code[end - 1])) {
      end--;
    }
    const word = code.slice(i, end);
    if (c === '&' || c === '*') {
      out.add(i, end, 'variable');
    } else if (c === '!') {
      out.add(i, end, 'type');
    } else if (flow > 0 && code[j] === ':') {
      out.add(i, end, 'property');
    } else if (YAML_CONSTANT.test(word)) {
      out.add(i, end, 'constant');
    } else if (YAML_NUMBER.test(word)) {
      out.add(i, end, 'number');
    }
    i = Math.max(j, i + 1);
  }

  return false;
}

// -- Markdown ---------------------------------------------------------------------

const MD_FENCE = /^ {0,3}(`{3,}|~{3,})/;
const MD_HEADING = /^ {0,3}#{1,6}(?:[ \t]|$)/;
const MD_RULE = /^ {0,3}(?:(?:-[ \t]*){3,}|(?:\*[ \t]*){3,}|(?:_[ \t]*){3,}|={3,}[ \t]*)$/;
const MD_LIST = /^[ \t]*(?:[-*+]|\d{1,9}[.)])(?=[ \t]|$)/;
const MD_AUTOLINK = /<[A-Za-z][\w+.-]*:[^\s<>]*>/y;

/**
 * Markdown source, which is what an editor for a README shows.
 *
 * A heading line is a `heading`, a thematic break or a setext underline a `meta`, a
 * fenced block's fences `meta` and its body `code` -- or the body highlighted in its
 * own language, where the fence names one this module reads, so a JSON block in a
 * README is coloured as JSON. Inline: a code span is `code`, a link's text `link`
 * and its destination a `string`, an autolink a `link`, `**strong**` and `*emphasis*`
 * their own names, and an HTML comment a `comment`. A list marker and a quote's `>`
 * are left plain. Indented code is not told from a list's continuation and is left
 * as text.
 *
 * @param code - The Markdown.
 * @returns The spans.
 */
function lexMarkdown(code: string): HighlightSpan[] {
  const out = new Spans();
  const n = code.length;
  const next = closers(code);
  let start = 0;

  while (start <= n) {
    const end = lineEnd(code, start);
    const line = code.slice(start, end);

    const fence = MD_FENCE.exec(line);
    if (fence) {
      start = fencedBlock(code, start, end, fence[1]!, out);
      continue;
    }

    if (line.trimStart().startsWith('<!--')) {
      const open = start + line.indexOf('<!--');
      const close = code.indexOf('-->', open + 4);
      const stop = close === -1 ? n : close + 3;
      out.add(open, stop, 'comment');
      start = lineEnd(code, stop) + 1;
      continue;
    }

    if (MD_HEADING.test(line)) {
      out.add(start, end, 'heading');
    } else if (MD_RULE.test(line)) {
      out.add(start + line.length - line.trimStart().length, end, 'meta');
    } else {
      // the quote markers, then the list marker, are skipped as plain
      let at = start;
      while (code[at] === ' ' || code[at] === '>') {
        at++;
      }
      const list = MD_LIST.exec(code.slice(at, end));
      if (list) {
        at += list[0].length;
      }
      inline(code, at, end, out, next);
    }
    start = end + 1;
  }

  return out.list;
}

/**
 * A fenced block from its opening fence, and the offset of the line after it.
 *
 * The fences are `meta`; the body is highlighted in the language the info string
 * names, where this module reads it and it is not Markdown again, and is `code`
 * otherwise. A fence that never closes runs to the end, as CommonMark says.
 */
function fencedBlock(code: string, start: number, end: number, fence: string, out: Spans): number {
  const n = code.length;
  const info = code.slice(start, end).trim().slice(fence.length).trim().split(/\s/, 1)[0];
  const language = codeLanguage(info);
  out.add(start, end, 'meta');

  const bodyStart = Math.min(n, end + 1);
  let at = bodyStart;
  let close = -1;
  while (at < n) {
    const stop = lineEnd(code, at);
    const trimmed = code.slice(at, stop).trim();
    if (
      trimmed.length >= fence.length &&
      trimmed[0] === fence[0] &&
      [...trimmed].every((c) => c === fence[0])
    ) {
      close = at;
      break;
    }
    at = stop + 1;
  }

  const bodyEnd = close === -1 ? n : Math.max(bodyStart, close - 1);
  if (language !== undefined && language !== 'markdown') {
    for (const span of LEXERS[language](code.slice(bodyStart, bodyEnd))) {
      out.add(bodyStart + span.start, bodyStart + span.end, span.token);
    }
  } else {
    out.add(bodyStart, bodyEnd, 'code');
  }

  if (close === -1) {
    return n + 1;
  }
  const closeEnd = lineEnd(code, close);
  out.add(close, closeEnd, 'meta');
  return closeEnd + 1;
}

/** Where the next `needle` is at or after `at` and before `end`, or -1. */
type Closer = (needle: string, at: number, end: number) => number;

/**
 * The searches for a closing delimiter, one per delimiter for the whole document.
 *
 * One per document rather than per line, which is the difference that matters: a
 * search that finds nothing on its line runs on to the next occurrence, and per line
 * that is a scan to the end of the document from every line that asks.
 */
function closers(code: string): Closer {
  const finders = new Map<string, (at: number) => number>();
  return (needle, at, end) => {
    let find = finders.get(needle);
    if (find === undefined) {
      find = finder(code, needle);
      finders.set(needle, find);
    }
    const found = find(at);
    return found === -1 || found + needle.length > end ? -1 : found;
  };
}

/**
 * The inline marks of one line of text.
 *
 * Every search for a closer is bounded by the line and remembered once it fails, so
 * a line of a thousand unclosed `*`s costs one scan for a `*` rather than a thousand.
 */
function inline(code: string, from: number, end: number, out: Spans, find: Closer): void {
  const next = (needle: string, at: number): number => find(needle, at, end);
  const ticks = backtickRuns(code, from, end, find);
  let i = from;

  while (i < end) {
    const c = code[i]!;

    if (c === '\\') {
      i += 2;
      continue;
    }

    if (c === '`') {
      const run = ticks.closer(i);
      if (run.close === -1) {
        i += run.length;
      } else {
        out.add(i, run.close + run.length, 'code');
        i = run.close + run.length;
      }
      continue;
    }

    if (c === '<') {
      if (code.startsWith('<!--', i)) {
        const close = next('-->', i + 4);
        if (close !== -1) {
          out.add(i, close + 3, 'comment');
          i = close + 3;
          continue;
        }
      }
      MD_AUTOLINK.lastIndex = i;
      const link = MD_AUTOLINK.exec(code)?.[0];
      if (link !== undefined && i + link.length <= end) {
        out.add(i, i + link.length, 'link');
        i += link.length;
        continue;
      }
      i++;
      continue;
    }

    if (c === '[' || (c === '!' && code[i + 1] === '[')) {
      const open = c === '!' ? i + 1 : i;
      const shut = next(']', open + 1);
      if (shut !== -1 && code[shut + 1] === '(') {
        const paren = next(')', shut + 2);
        if (paren !== -1) {
          out.add(i, shut + 1, 'link');
          out.add(shut + 1, paren + 1, 'string');
          i = paren + 1;
          continue;
        }
      }
      i = open + 1;
      continue;
    }

    if (c === '*' || c === '_') {
      const double = code[i + 1] === c;
      const marker = double ? c + c : c;
      const after = code[i + marker.length];
      const before = code[i - 1];
      const opens =
        after !== undefined &&
        !/\s/.test(after) &&
        !(c === '_' && before !== undefined && /[\p{L}\p{N}]/u.test(before));
      if (opens) {
        const close = next(marker, i + marker.length + 1);
        if (close !== -1 && !/\s/.test(code[close - 1]!)) {
          out.add(i, close + marker.length, double ? 'strong' : 'emphasis');
          i = close + marker.length;
          continue;
        }
      }
      i += marker.length;
      continue;
    }

    i++;
  }
}

/**
 * The backtick runs of a line, read once, and the closer of each.
 *
 * A code span is closed by the next run of exactly as many backticks, so a line of
 * runs of every length would be a search per run; reading the runs once and walking
 * a cursor per length makes it one pass.
 */
function backtickRuns(
  code: string,
  from: number,
  end: number,
  find: Closer
): { closer: (at: number) => { close: number; length: number } } {
  const byLength = new Map<number, number[]>();
  const lengthAt = new Map<number, number>();
  for (let j = find('`', from, end); j !== -1;) {
    let k = j;
    while (k < end && code[k] === '`') {
      k++;
    }
    const length = k - j;
    lengthAt.set(j, length);
    let list = byLength.get(length);
    if (list === undefined) {
      list = [];
      byLength.set(length, list);
    }
    list.push(j);
    j = find('`', k, end);
  }
  const cursor = new Map<number, number>();

  return {
    closer: (at) => {
      const length = lengthAt.get(at) ?? 1;
      const list = byLength.get(length) ?? [];
      let index = cursor.get(length) ?? 0;
      while (index < list.length && list[index]! <= at) {
        index++;
      }
      cursor.set(length, index);
      return { close: index < list.length ? list[index]! : -1, length };
    },
  };
}

// -- diff -------------------------------------------------------------------------

const DIFF_META =
  /^(?:diff |index |new file mode|deleted file mode|old mode|new mode|similarity index|dissimilarity index|rename from|rename to|copy from|copy to|Binary files )/;

/**
 * A unified diff, as `diff -u` and `git diff` print it.
 *
 * An added line is `inserted`, a removed one `deleted`, a file header -- `---`
 * followed by `+++`, which is what tells it from a removed line that starts `--` --
 * and git's own lines are `meta`, a hunk's `@@ ... @@` is a `hunk` and the heading
 * after it plain, and `\ No newline at end of file` a `comment`. The diff view draws
 * a patch itself; this is for a patch in a text area, a document or a pager.
 *
 * @param code - The patch.
 * @returns The spans.
 */
function lexDiff(code: string): HighlightSpan[] {
  const out = new Spans();
  const n = code.length;
  let start = 0;
  /** Whether this line is the `+++` of a header whose `---` was the line before. */
  let header = false;

  while (start < n) {
    const end = lineEnd(code, start);
    const line = code.slice(start, end);
    const next = end + 1;

    if (header) {
      out.add(start, end, 'meta');
      header = false;
    } else if (line.startsWith('--- ') && code.startsWith('+++ ', next)) {
      out.add(start, end, 'meta');
      header = true;
    } else if (line.startsWith('@@')) {
      const close = line.indexOf('@@', 2);
      out.add(start, close === -1 ? end : start + close + 2, 'hunk');
    } else if (line[0] === '+') {
      out.add(start, end, 'inserted');
    } else if (line[0] === '-') {
      out.add(start, end, 'deleted');
    } else if (line[0] === '\\') {
      out.add(start, end, 'comment');
    } else if (DIFF_META.test(line)) {
      out.add(start, end, 'meta');
    }
    start = next;
  }

  return out.list;
}
