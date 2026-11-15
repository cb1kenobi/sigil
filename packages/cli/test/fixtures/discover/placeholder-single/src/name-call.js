const nm = () => 'later';
export default {
  name: 'placeholder-single',
  baseDir: import.meta.dirname,
  commands: {
    x: { name: nm(), path: './commands/a.js' },
  },
};
