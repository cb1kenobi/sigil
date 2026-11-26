// A shared base spread into the schema, which spells its own `commands` after it
// (SIG-728). The base is part of the schema and not a second one, and the
// commands that run are the ones written last: `a` and `b`, never `old`.
const base = { baseDir: import.meta.dirname, commands: { old: './commands/a.js' } };

export default {
  ...base,
  name: 'shared-base',
  commands: { a: './commands/a.js', b: './commands/b.js' },
};
