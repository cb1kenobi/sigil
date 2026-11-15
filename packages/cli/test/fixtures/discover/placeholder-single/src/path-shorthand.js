const path = './commands/a.js';
export default {
  name: 'placeholder-single',
  baseDir: import.meta.dirname,
  commands: {
    x: { name: 'x', path },
  },
};
