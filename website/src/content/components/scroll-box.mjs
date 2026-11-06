import { runApp } from '@ttylabs/sigil/app';
import { ScrollBox } from '@ttylabs/sigil/components';
import { box, text } from '@ttylabs/sigil/element';

const lines = Array.from(
  { length: 200 },
  (_, i) => `line ${i + 1}: compiled src/module-${i + 1}.ts`
);

const app = runApp(() =>
  ScrollBox({
    props: { height: 8 },
    children: () => box({ 'flex-direction': 'column' }, ...lines.map((line) => text(line))),
  })
);

process.exitCode = await app.exited;
