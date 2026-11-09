import schema from './index.ts';
// Settings passed here reach the app from source and are lost once it is built.
import { main } from '@ttylabs/sigil';

await main({
  schema,
  settings: { allowUnknownOptions: false },
});
