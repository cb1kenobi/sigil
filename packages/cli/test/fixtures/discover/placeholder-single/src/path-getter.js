export default {
  name: 'placeholder-single',
  baseDir: import.meta.dirname,
  commands: {
    x: {
      name: 'x',
      get path() {
        return './commands/a.js';
      },
    },
  },
};
