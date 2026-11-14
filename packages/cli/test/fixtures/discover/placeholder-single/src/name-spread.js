const named = { name: 'later' };
export default {
  name: 'placeholder-single',
  baseDir: import.meta.dirname,
  commands: {
    x: { ...named, path: './commands/a.js' },
  },
};
