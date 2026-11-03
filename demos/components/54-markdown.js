/**
 * Markdown drawn as styled terminal text: a changelog entry, wrapped at two
 * widths, with its links drawn the two ways a terminal allows.
 *
 *   node demos/components/54-markdown.js
 *   node demos/components/54-markdown.js | cat         <- no colour, URLs in words
 *   FORCE_HYPERLINK=1 node demos/components/54-markdown.js
 *
 * The document is the kind an app would want to show of itself -- a release's
 * notes, with a heading, emphasis, code, a nested list, a quote, a table, a few
 * links, and GitHub's task boxes, strikethrough and footnotes -- and it is drawn
 * three times: at the terminal's own width, narrow
 * enough that the table has to give up width and wrap its cells, and through a
 * theme that restyles it without touching the document.
 *
 * Then a fourth time, a short one, with code blocks highlighted by a highlighter
 * written below in a dozen lines. The framework ships no grammar -- it has no
 * dependencies to bring one in -- so `highlight` is the seam an app fills with
 * whatever it already has. It is handed each block and the language its fence
 * named, and returns spans whose tokens are the ones `diff()` and `multiline()`
 * draw: `keyword`, `string`, `comment` and the rest each come in a role of the
 * theme. A block in a language it does not know gets no spans and is drawn as it
 * always was, and the inline code span is never handed to it at all.
 *
 * Links are OSC 8 hyperlinks where the terminal is one known to draw them, which
 * hides the URL behind the words; anywhere else -- a pipe, an unknown terminal,
 * `NO_COLOR` -- the URL is printed after the words instead, so it is never lost.
 * `FORCE_HYPERLINK=1` says yes for a terminal the detection does not know.
 *
 * A struck-out run keeps its tildes everywhere, with the line through the words
 * where colour is drawn: no terminal says whether it drew the line, and struck-out
 * words with no mark on them would say the opposite. Piped, the line goes and the
 * tildes are what is left -- which is what the author typed. The footnotes are
 * gathered under a rule at the end, numbered by where each is first referred to.
 */
import { supportsHyperlinks } from '@ttylabs/sigil/ansi';
import { markdown, rule } from '@ttylabs/sigil/components';

const NOTES = `# Release 2.1.0

The **markdown** release: \`markdown()\` draws a document like this one, and
\`parseMarkdown()\` reads one. See the [README](https://github.com/cb1kenobi/sigil#readme)
or the [changelog][changes].

## Added

- A renderer for the subset a README is made of:
  - headings, *emphasis* and **strong emphasis**
  - lists that nest, and \`code\` spans
- Tables, with their columns lined up:

  | Option       | Default           | Meaning                              |
  | ------------ | :---------------: | ------------------------------------ |
  | \`width\`      | terminal          | The columns to wrap at               |
  | \`hyperlinks\` | detected          | OSC 8, or the URL after the words    |
  | \`baseUrl\`    |                   | What a relative link is resolved by  |

## Fixed

1. A link in a pipe kept its URL out of sight.
2. A wide character -- 日本語 -- put the columns after it out of line.

## Removed

- ~~\`--legacy\`~~, deprecated since 1.4.[^legacy] Use \`--mode\` instead.

## Still to do

- [x] Task lists, strikethrough and footnotes[^gfm]
- [ ] Multi-line reference definitions

> Anything the subset does not read, such as <b>raw HTML</b>, is shown the way
> it was written.

\`\`\`sh
npm install @ttylabs/sigil
\`\`\`

[changes]: https://github.com/cb1kenobi/sigil/releases
[^legacy]: It read its configuration from the working directory, which is
    nowhere an installed CLI can rely on.
[^gfm]: GitHub's extensions, read by default, since GitHub is where a README is
    written.
`;

const links = supportsHyperlinks() ? 'as OSC 8 hyperlinks' : 'with their URLs written out';

console.log(rule({ label: `at the terminal's width, links ${links}` }));
console.log();
console.log(markdown(NOTES));
console.log();
console.log(rule({ label: 'at 44 columns, the table wrapped', width: 44 }));
console.log();
console.log(markdown(NOTES, { width: 44 }));
console.log();
console.log(rule({ label: 'through a theme' }));
console.log();
console.log(
  markdown(NOTES, {
    theme: `
      .sigil-accent { color: magenta }
      .sigil-markdown-h2 { color: yellow }
      .sigil-markdown-strong { color: green }
      .sigil-markdown-quote-bar { color: magenta; dim: false }
    `,
  })
);

/**
 * A JavaScript highlighter, by hand: one pattern with a group per token, which
 * is enough for a demo and is what any real one would be swapped in for.
 */
const JS =
  /(\/\/[^\n]*|\/\*[\s\S]*?\*\/)|('(?:\\.|[^'\\\n])*')|\b(\d+)\b|\b(await|const|from|import|new|return)\b|\b([A-Za-z_$][\w$]*)(?=\()/g;
const TOKENS = ['comment', 'string', 'number', 'keyword', 'function'];

function highlight(code, lang) {
  if (lang !== 'js') {
    return [];
  }
  return [...code.matchAll(JS)].map((match) => ({
    end: match.index + match[0].length,
    start: match.index,
    token: TOKENS[match.slice(1).findIndex((group) => group !== undefined)],
  }));
}

const SNIPPET = `Code blocks take the app's own highlighter. \`markdown()\` here is inline
code, so it is not handed to it:

\`\`\`js
import { readFile } from 'node:fs/promises';
import { markdown } from '@ttylabs/sigil/components';

/* the app brings the grammar,
   and the theme brings the colours */
const notes = await readFile('CHANGELOG.md', 'utf8');
console.log(markdown(notes, { highlight, width: 80 }));
\`\`\`

A language the highlighter does not know is drawn as before:

\`\`\`sh
npm install @ttylabs/sigil
\`\`\`
`;

console.log();
console.log(rule({ label: 'with a highlighter the app wrote' }));
console.log();
console.log(markdown(SNIPPET, { highlight }));
