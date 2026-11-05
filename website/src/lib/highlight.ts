import {
  createHighlighterCoreSync,
  type HighlighterCore,
  type ThemeRegistration,
} from 'shiki/core';
import { createJavaScriptRegexEngine } from 'shiki/engine/javascript';
import diff from 'shiki/langs/diff.mjs';
import javascript from 'shiki/langs/javascript.mjs';
import json from 'shiki/langs/json.mjs';
import jsonc from 'shiki/langs/jsonc.mjs';
import jsx from 'shiki/langs/jsx.mjs';
import tsx from 'shiki/langs/tsx.mjs';
import typescript from 'shiki/langs/typescript.mjs';
import xml from 'shiki/langs/xml.mjs';
import yaml from 'shiki/langs/yaml.mjs';

/**
 * Syntax highlighting for the code blocks, at build time.
 *
 * Ported from titaniumsdk.com's `highlight.ts`, and the two decisions it records
 * carry over: **synchronous** -- `createHighlighterCoreSync` with static grammar
 * imports, so a code block stays an ordinary server component -- and the
 * **JavaScript RegExp engine** rather than the oniguruma WASM one, which has to
 * compile a binary before it can do anything. Every page here is prerendered,
 * so all of it happens in `next build` and none of it reaches a browser: what
 * ships is spans.
 *
 * ## The theme is the tokens
 *
 * A Shiki theme is a list of colours, and the site's syntax colours are already
 * written down once, as `--color-syn-*` in `globals.css`, where
 * `check-contrast.ts` measures them. So the theme below names those variables
 * instead of their values: every token comes out styled `var(--color-syn-
 * keyword)` rather than `#C4A7FF`, and the stylesheet is the only place a colour
 * is. Nothing reads the CSS at build time and nothing could drift from it; the
 * one thing that could go wrong -- a variable named here that the stylesheet
 * does not declare -- is what `test/highlight.test.ts` checks.
 *
 * ## The five colours
 *
 * Keyword, string, function, number and comment, with comment italic, and
 * everything else the block's own `fg-code`. That is fewer distinctions than an
 * editor theme makes, on purpose: an operator, a property, a type and a
 * punctuation mark are all plain text, so what is coloured is what a reader
 * scans a sample for.
 */

/** What a token is drawn in when the theme says nothing more specific. */
const PLAIN = 'var(--color-fg-code)';

const KEYWORD = 'var(--color-syn-keyword)';
const STRING = 'var(--color-syn-string)';
const FUNCTION = 'var(--color-syn-function)';
const NUMBER = 'var(--color-syn-number)';
const COMMENT = 'var(--color-syn-comment)';

/**
 * The sigil theme, as TextMate scopes.
 *
 * A more specific scope wins over a less specific one, which is how the broad
 * rules are cut back: `keyword` covers `keyword.operator.assignment`, so `=` and
 * `+` are handed back to plain text by `keyword.operator`, and the two operators
 * that are words -- `new`, and `typeof`/`in`/`of` -- are handed back again. The
 * arrow is `storage.type.function.arrow`, which `storage` would otherwise colour
 * as though `=>` were `function`.
 */
export const THEME: ThemeRegistration = {
  name: 'sigil',
  type: 'dark',
  fg: PLAIN,
  bg: 'var(--color-surface)',
  settings: [
    { settings: { foreground: PLAIN } },
    {
      scope: ['comment', 'punctuation.definition.comment'],
      settings: { fontStyle: 'italic', foreground: COMMENT },
    },
    {
      scope: ['keyword', 'storage', 'constant.language', 'variable.language'],
      settings: { foreground: KEYWORD },
    },
    {
      scope: ['keyword.operator', 'storage.type.function.arrow'],
      settings: { foreground: PLAIN },
    },
    {
      scope: ['keyword.operator.new', 'keyword.operator.expression'],
      settings: { foreground: KEYWORD },
    },
    {
      scope: ['string', 'punctuation.definition.string'],
      settings: { foreground: STRING },
    },
    // the inside of `${...}` is code again, not string
    {
      scope: ['meta.template.expression'],
      settings: { foreground: PLAIN },
    },
    {
      scope: ['entity.name.function', 'support.function'],
      settings: { foreground: FUNCTION },
    },
    {
      scope: ['constant.numeric'],
      settings: { foreground: NUMBER },
    },
  ],
};

/**
 * The fence languages that are highlighted, by every name a fence might use.
 *
 * `sh` and `console` are not here: those fences are terminals, and
 * `fence.ts` sends them to a `TerminalBlock` before this is asked.
 */
export const LANGS = {
  cjs: 'javascript',
  cts: 'typescript',
  diff: 'diff',
  javascript: 'javascript',
  js: 'javascript',
  json: 'json',
  jsonc: 'jsonc',
  jsx: 'jsx',
  mjs: 'javascript',
  mts: 'typescript',
  ts: 'typescript',
  tsx: 'tsx',
  typescript: 'typescript',
  xml: 'xml',
  yaml: 'yaml',
  yml: 'yaml',
} as const;

let highlighter: HighlighterCore | undefined;

function core(): HighlighterCore {
  highlighter ??= createHighlighterCoreSync({
    engine: createJavaScriptRegexEngine(),
    langs: [diff, javascript, json, jsonc, jsx, tsx, typescript, xml, yaml],
    themes: [THEME],
  });
  return highlighter;
}

/** One token: its text, and what it is drawn in when that is not plain. */
export interface Token {
  readonly color?: string;
  readonly italic?: boolean;
  readonly text: string;
}

/** Shiki's `FontStyle.Italic`, which is a bit flag. */
const ITALIC = 1;

/**
 * Highlights a block of code.
 *
 * A language this does not know -- or none, which is what an untagged fence is
 * -- is left uncoloured rather than guessed at, the call titaniumsdk.com makes
 * for the same reason: a guess colours some blocks wrongly with more confidence
 * than the source supports.
 *
 * @param code - The code.
 * @param lang - The fence's language, as written.
 * @returns The lines, as tokens, or nothing when the language is not one this
 *   highlights.
 */
export function highlight(code: string, lang: string | undefined): Token[][] | undefined {
  const resolved = lang && LANGS[lang.toLowerCase() as keyof typeof LANGS];

  if (!resolved) {
    return undefined;
  }

  try {
    return core()
      .codeToTokens(code, { lang: resolved, theme: 'sigil' })
      .tokens.map((line) =>
        line.map((token) => ({
          ...(token.color && token.color !== PLAIN ? { color: token.color } : {}),
          ...((token.fontStyle ?? 0) & ITALIC ? { italic: true } : {}),
          text: token.content,
        }))
      );
  } catch {
    // a grammar can refuse input, and an uncoloured block is a far better
    // outcome than a page that will not render
    return undefined;
  }
}
