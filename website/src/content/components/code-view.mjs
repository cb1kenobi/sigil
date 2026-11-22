import { runApp } from '@ttylabs/sigil/app';
import { codeView } from '@ttylabs/sigil/components/code-view';
import { highlightCode } from '@ttylabs/sigil/components/highlight';

const source = `export function retry(run) {
  // try again, a few times
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      return run();
    } catch (err) {
      console.error(\`attempt \${attempt} failed\`);
    }
  }
  throw new Error('gave up');
}`;

const app = runApp(() =>
  codeView(source, {
    gutter: true,
    highlight: highlightCode,
    lang: 'ts',
    width: 80,
    props: { 'flex-grow': 1 },
  })
);

process.exitCode = await app.exited;
