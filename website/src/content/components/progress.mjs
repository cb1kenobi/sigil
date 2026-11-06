import { createProgress } from '@ttylabs/sigil/components';

const files = Array.from({ length: 40 }, (_, i) => `src/file-${i + 1}.js`);
const bar = createProgress({ text: 'Copying', total: files.length });

for (const file of files) {
  bar.text = `Copying ${file}`;
  await new Promise((resolve) => setTimeout(resolve, 50));
  bar.tick();
}
bar.done(`Copied ${files.length} files`);
