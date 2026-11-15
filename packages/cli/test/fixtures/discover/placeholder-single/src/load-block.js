export default {
  name: 'placeholder-single',
  baseDir: import.meta.dirname,
  commands: {
    x: {
      name: 'x',
      load: () => {
        return import('./commands/a.js');
      },
    },
  },
};
