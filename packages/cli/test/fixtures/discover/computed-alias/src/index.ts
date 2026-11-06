import { main } from '@ttylabs/sigil';

const spellings = ['del', 'rm'];

await main({
  schema: {
    name: 'computed-alias',
    commands: {
      // none of these can be read from source
      remove: { alias: spellings, load: () => import('./commands/remove.js') },
      list: { alias: ['ls', spellings[0]], load: () => import('./commands/remove.js') },
      ship: { default: Math.random() > 2, load: () => import('./commands/remove.js') },
      push: { name: spellings[0], load: () => import('./commands/remove.js') },
    },
  },
});
