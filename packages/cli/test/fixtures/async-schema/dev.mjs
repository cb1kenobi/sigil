import schema from './index.js';
// Runs the app from source. The schema is a function, so it is called and
// awaited here exactly as the entry `sigil build` generates has to.
import { main } from '@ttylabs/sigil';

await main({ schema: await schema() });
