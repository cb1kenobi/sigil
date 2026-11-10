import schema from './index.ts';
// Runs the app from source, the way `sigil new` scaffolds. It passes no settings:
// the schema has them, which is the point.
import { main } from '@ttylabs/sigil';

await main({ schema });
