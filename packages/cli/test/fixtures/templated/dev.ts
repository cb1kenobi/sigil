// Runs the app from source, so the *interpreted* `ui` tag is what renders and a
// compiled build can be diffed against it.
import schema from './src/index.ts';
import { main } from '@ttylabs/sigil';

await main({ argv: process.argv.slice(2), schema });
