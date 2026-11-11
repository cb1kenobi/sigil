/**
 * Syntax highlighting: one highlighter, handed to every seam that takes one.
 *
 *   node demos/components/65-highlight.js
 *   NO_COLOR=1 node demos/components/65-highlight.js
 *
 * `highlightCode()` is a small lexer per language -- JavaScript and TypeScript,
 * JSON, shell, YAML, Markdown and a diff -- and it is the shape every highlight
 * seam already took: the code, and what is known of its language. So the same
 * function goes to `markdown()`, which hands it each fence's language; to
 * `diff()`, which hands it each file's extension; and to a `TextArea`, which hands
 * it the `lang` the app gave. `multiline()` takes it the same way.
 *
 * It names tokens and never colours: a keyword is drawn in the accent role, a
 * string in the success role, and so on through `TOKEN_ROLE`, so the last section
 * is the same document under a theme that says nothing about code at all and
 * recolours it anyway. Piped, there is no colour to see; what the run shows is
 * what each seam was handed.
 */
import { diff, highlightCode, markdown, TextArea } from '@ttylabs/sigil/components';
import { renderToString } from '@ttylabs/sigil/element';
import { themedCascade } from '@ttylabs/sigil/theme';

const document = `# Configuring the app

The app reads \`app.json\`, and a missing key takes its default:

\`\`\`json
{
  // JSONC: comments are allowed
  "port": 8080,
  "verbose": false,
  "name": "sigil"
}
\`\`\`

Start it from a script:

\`\`\`sh
PORT=8080 node ./bin/app.js --verbose "$@" 2>&1 | tee app.log
\`\`\`

Or from code:

\`\`\`ts
import { start } from './app.js';

const server: Server = await start({ port: 8080 }); // resolves once listening
\`\`\`
`;

console.log('markdown(), which hands the highlighter each fence’s language:\n');
console.log(markdown(document, { highlight: highlightCode, width: 72 }));

const patch = [
  'diff --git a/app.json b/app.json',
  '--- a/app.json',
  '+++ b/app.json',
  '@@ -1,4 +1,4 @@',
  ' {',
  '-  "port": 3000,',
  '+  "port": 8080,',
  '   "verbose": false,',
  'diff --git a/start.sh b/start.sh',
  '--- a/start.sh',
  '+++ b/start.sh',
  '@@ -1 +1 @@',
  '-node ./bin/app.js',
  '+PORT=8080 node ./bin/app.js "$@"',
].join('\n');

console.log('\ndiff(), which hands it each file’s extension -- json for one, sh for the other:\n');
console.log(diff({ patch }, { highlight: highlightCode, width: 72 }));

const yaml = `# a text area holds a value, and lang says what it is
name: sigil
port: 8080
tags: [cli, tui]
script: |
  node ./bin/app.js`;

console.log('\na TextArea, with `lang: "yaml"`:\n');
const area = TextArea({ highlight: highlightCode, lang: 'yaml', lineNumbers: true, value: yaml });
console.log(renderToString(area, { cascade: themedCascade(), height: 6, width: 72 }));

console.log('\nthe same code block under a theme that names roles and never a token:\n');
const theme = `
  .sigil-accent { color: magenta }
  .sigil-success { color: yellow }
  .sigil-info { color: green }
`;
console.log(
  markdown('```ts\nconst greeting: string = `hi ${name}`; // 2 words\n```', {
    highlight: highlightCode,
    theme,
    width: 72,
  })
);
