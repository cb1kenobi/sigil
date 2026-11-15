export default {
  name: 'placeholder-single',
  baseDir: import.meta.dirname,
  commands: {
    x: {
      get name() {
        return 'later';
      },
      path: './commands/a.js',
    },
  },
};
