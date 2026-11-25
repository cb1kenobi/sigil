// the const is written to after it is declared, so what it held when the file was
// read is not what the app spreads (SIG-440): the app answers to `later`
const named = { name: 'earlier' };
named.name = 'later';
export default {
  name: 'placeholder-single',
  baseDir: import.meta.dirname,
  commands: {
    x: { ...named, path: './commands/a.js' },
  },
};
