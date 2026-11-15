const named = { name: 'later' };
export default {
  name: 'placeholder-single',
  baseDir: import.meta.dirname,
  commands: {
    x: { name: 'early', ...named, path: './commands/a.js' },
  },
};
