import { main } from '@ttylabs/sigil';

await main({
  schema: {
    name: 'wrong-types',
    commands: {
      // each of these throws from source, so none of them can be a warning
      number: { alias: 42, load: () => import('./commands/remove.js') },
      mixed: { alias: ['del', 42], load: () => import('./commands/remove.js') },
      nothing: { alias: null, load: () => import('./commands/remove.js') },
      text: { default: 'yes', load: () => import('./commands/remove.js') },
      empty: { name: '', load: () => import('./commands/remove.js') },
      named: { name: 42, load: () => import('./commands/remove.js') },
      // a boolean is no more a string than a number is
      flag: { alias: !0, load: () => import('./commands/remove.js') },
      // ...but it is a boolean, however it is spelled
      negated: { default: !0, load: () => import('./commands/remove.js') },
      // ...and `undefined` is what the runtime reads as absent
      absent: { alias: undefined, default: undefined, load: () => import('./commands/remove.js') },
      // ...however it is spelled
      voided: {
        alias: void 0,
        default: void 0,
        name: void 0,
        load: () => import('./commands/remove.js'),
      },
    },
  },
});
