import { createTypewriter } from '@ttylabs/sigil/components/typewriter';

const line = createTypewriter({
  cursor: '█',
  text: 'Resolving dependencies, compiling, and writing the bundle.',
}).start();

await new Promise((resolve) => setTimeout(resolve, 3_000));
line.done();
