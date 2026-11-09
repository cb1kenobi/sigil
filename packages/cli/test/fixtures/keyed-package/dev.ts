// Runs the app from source, so the packages are registered the way the runtime
// registers them and the built app can be compared against it.
import schema from './src/index.ts';
import { main } from '@ttylabs/sigil';

await main({ argv: process.argv.slice(2), schema });
