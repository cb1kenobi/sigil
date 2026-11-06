import { main } from '@ttylabs/sigil';

await main({
  schema: {
    name: 'unbaked',
    commands: {
      // an inline handler, and no module for the built app to take one from
      hi: { desc: 'say hi', run: () => 'hi' },
      // properties the runtime merges in when the module leaves them undefined
      remove: {
        args: [{ name: 'target' }],
        examples: 'unbaked remove x',
        format: true,
        hooks: { init: () => undefined },
        load: () => import('./commands/remove.js'),
        options: { '--force': { type: 'bool' } },
      },
      // custom data, which a hook reads off the command
      tagged: { load: () => import('./commands/remove.js'), tag: 'x' },
      // a nested `commands` in a form the build only reads as an object
      nested: { commands: './sub' },
      db: { commands: { drop: { run: () => 'dropped' } } },
      // and what is baked is not mentioned
      quiet: {
        alias: 'q',
        default: false,
        desc: 'quiet',
        hidden: true,
        load: () => import('./commands/remove.js'),
      },
    },
  },
});
