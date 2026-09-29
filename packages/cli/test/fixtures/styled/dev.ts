// Runs the app from source, so the *whole* utility sheet is what the cascade
// reads and a shaken build can be diffed against it.
import schema from './src/index.ts';
import { main } from '@ttylabs/sigil';

await main({ argv: process.argv.slice(2), schema });
