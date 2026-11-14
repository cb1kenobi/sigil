const key = 'name';
export default {
  name: 'placeholder-single',
  baseDir: import.meta.dirname,
  commands: {
    x: { [key]: 'later', path: './commands/a.js' },
  },
};
