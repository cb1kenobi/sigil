// Runs the app from source, so the built app can be compared against it.
import schema from './src/index.ts';
import { main } from '@ttylabs/sigil';

await main({ argv: process.argv.slice(2), schema });
