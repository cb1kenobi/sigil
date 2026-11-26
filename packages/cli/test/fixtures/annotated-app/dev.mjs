import schema from './index.ts';
// Runs the app from source, the way `sigil new` scaffolds.
import { main } from '@ttylabs/sigil';

await main({ schema });
