/**
 * Markdown drawn as styled terminal text: a changelog entry, wrapped at two
 * widths, with its links drawn the two ways a terminal allows.
 *
 *   node demos/components/54-markdown.js
 *   node demos/components/54-markdown.js | cat         <- no colour, URLs in words
 *   FORCE_HYPERLINK=1 node demos/components/54-markdown.js
 *
 * The document is the kind an app would want to show of itself -- a release's
 * notes, with a heading, emphasis, code, a nested list, a quote, a table and a
 * few links -- and it is drawn three times: at the terminal's own width, narrow
 * enough that the table has to give up width and wrap its cells, and through a
 * theme that restyles it without touching the document.
 *
 * Links are OSC 8 hyperlinks where the terminal is one known to draw them, which
 * hides the URL behind the words; anywhere else -- a pipe, an unknown terminal,
 * `NO_COLOR` -- the URL is printed after the words instead, so it is never lost.
 * `FORCE_HYPERLINK=1` says yes for a terminal the detection does not know.
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

> Anything the subset does not read, such as ~~this~~ or <b>raw HTML</b>, is
> shown the way it was written.

\`\`\`sh
npm install @ttylabs/sigil
\`\`\`

[changes]: https://github.com/cb1kenobi/sigil/releases
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
