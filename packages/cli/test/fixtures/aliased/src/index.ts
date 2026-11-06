// Commands declared in the schema with an `alias` property on the placeholder,
// which is the one place a built app has to be told: the module behind a
// placeholder is not read until argv has matched it.
export default {
  desc: 'A fixture app whose commands have aliases',
  name: 'aliased',
  baseDir: import.meta.dirname,
  commands: {
    // a string
    remove: { alias: 'del', desc: 'remove it', path: './commands/remove.ts' },
    // a list, with a template literal and the `as const` a typed app writes
    list: { alias: ['ls', `dir`] as const, desc: 'list them', path: './commands/list.ts' },
    // beside `hidden`, which is lifted from the same placeholder
    secret: { alias: 'sh', desc: 'not listed', hidden: true, path: './commands/secret.ts' },
    // the declaration's own `name` wins over the key, and its extra labels route
    // and are listed -- a name string, parsed by the runtime and not by the build
    purge: { name: 'purge, pg', desc: 'purge it', path: './commands/purge.ts' },
    // a prefixed label is an alias that is not published
    clear: { name: '@zz, clear', desc: 'clear it', path: './commands/clear.ts' },
    // a nested placeholder, and one that is the default of its parent: routing is
    // read off the placeholder, so `default` needs to arrive for the same reason
    db: {
      desc: 'database commands',
      commands: {
        drop: { alias: 'rm', default: true, desc: 'drop it', path: './commands/drop.ts' },
      },
    },
  },
};
