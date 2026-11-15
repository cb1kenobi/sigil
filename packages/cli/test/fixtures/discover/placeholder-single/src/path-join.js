import { join } from 'node:path';
export default {
  name: 'placeholder-single',
  baseDir: import.meta.dirname,
  commands: {
    x: { name: 'x', path: join(import.meta.dirname, 'commands', 'a.js') },
  },
};
