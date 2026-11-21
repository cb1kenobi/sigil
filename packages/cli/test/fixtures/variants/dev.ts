// Runs the app from source, which is the answer for an unbuilt app: the base
// utility sheet and no variants, so `focus:` and `md:` match nothing.
import schema from './src/index.ts';
import { main } from '@ttylabs/sigil';

await main({ argv: process.argv.slice(2), schema });
