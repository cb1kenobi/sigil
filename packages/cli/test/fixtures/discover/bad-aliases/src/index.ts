import { main } from '@ttylabs/sigil';

await main({
  schema: {
    name: 'bad-aliases',
    commands: {
      // each of these throws from source, so a build that baked one is an app that cannot start
      spaced: { alias: ['ok', 'a b'], load: () => import('./commands/remove.js') },
      hidden: { alias: '!ls', load: () => import('./commands/remove.js') },
      comma: { alias: ['a,b'], load: () => import('./commands/remove.js') },
      empty: { alias: [''], load: () => import('./commands/remove.js') },
      // ...and these are what an alias is
      fine: { alias: ['f', 'a!b', 'a@b'], load: () => import('./commands/remove.js') },
    },
  },
});
