import { main } from '@ttylabs/sigil';

// the schema is written in the call and nothing is exported, so a built app has
// no schema to take from this module
await main({
  schema: { baseDir: import.meta.dirname, commands: './commands', name: 'inline-main' },
});
