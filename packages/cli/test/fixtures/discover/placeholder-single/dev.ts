// Runs one of the apps in `src/` from source, named by `SCHEMA`, so the
// built app -- or the refusal of it -- can be compared against it.
import { main } from '@ttylabs/sigil';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const { default: schema } = await import(pathToFileURL(resolve(process.env.SCHEMA!)).href);
await main({ argv: process.argv.slice(2), schema });
