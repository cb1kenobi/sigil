// the same three declarations, from modules a schema points at. Where the
// schema says them is where they route, so only the module saying them warns
export default {
  name: 'module-routing-inline',
  baseDir: import.meta.dirname,
  commands: {
    // the module's name string repeats the key's: nothing to say
    'list, ls': './commands/list.ts',
    // the placeholder declares the alias, so the module repeating it says
    // nothing wrong
    show: { alias: 'sh', default: true, path: './commands/show.ts' },
    // and here the module is the only one saying it
    open: { desc: 'Open it', path: './commands/open.ts' },
  },
};
