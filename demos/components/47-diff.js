/**
 * A diff view: unified or side by side, over two texts or a unified patch, with
 * the edited words set apart and a seam for syntax highlighting.
 *
 *   node demos/components/47-diff.js
 *   NO_COLOR=1 node demos/components/47-diff.js
 */
import { DIFF_SIDE_BY_SIDE_MIN_WIDTH, diff, diffView } from '@ttylabs/sigil/components';

const before = `import { read } from './fs.js';

export function load(path, retries = 1) {
  const text = read(path);
  if (!text) {
    return null;
  }
  return JSON.parse(text);
}
`;

const after = `import { read } from './fs.js';

export function load(path, retries = 3) {
  const text = read(path, 'utf-8');
  if (!text) {
    throw new Error(\`Could not read \${path}\`);
  }
  return JSON.parse(text);
}
`;

const names = { newName: 'b/load.js', oldName: 'a/load.js' };

console.log('unified, with the words that changed in bold:\n');
console.log(diff({ new: after, old: before, ...names }, { width: 64 }));

console.log('\nside by side, where there is the width for it:\n');
console.log(diff({ new: after, old: before }, { layout: 'side-by-side', width: 100 }));

const narrow = DIFF_SIDE_BY_SIDE_MIN_WIDTH - 1;
const view = diffView({ new: after, old: before }, { layout: 'side-by-side', width: narrow });
console.log(`\nasked for side by side at ${narrow} columns, it draws ${view.layout}:\n`);
console.log(
  diff({ new: 'retries = 1;', old: 'retries = 3;' }, { layout: 'side-by-side', width: narrow })
);

console.log('\na unified patch, as git prints one:\n');
const patch = [
  'diff --git a/README.md b/README.md',
  '--- a/README.md',
  '+++ b/README.md',
  '@@ -1,4 +1,5 @@ # sigil',
  ' # sigil',
  ' ',
  '-A framework for CLI apps.',
  '+A framework for building CLI apps in Node.js.',
  '+Zero dependencies.',
  ' ',
].join('\n');
console.log(diff({ patch }, { width: 64 }));

// the app's own highlighter goes here: this one knows two keywords, and the diff
// asks it for whole sides, so a span that crosses lines is one span
console.log('\nwith a highlighter, whose tokens draw in their roles on the changed lines:\n');
const keywords = (value) =>
  [...value.matchAll(/\b(?:const|export|function|import|return|throw|new|if)\b/g)].map((match) => ({
    end: match.index + match[0].length,
    start: match.index,
    token: 'keyword',
  }));
console.log(diff({ new: after, old: before }, { highlight: keywords, width: 64 }));

console.log('\nwide characters are measured in columns, and a long line is folded:\n');
console.log(
  diff(
    { new: '日本語のテキストが長すぎて一行に収まらない場合は折り返される', old: '日本語' },
    { lineNumbers: false, width: 32 }
  )
);
