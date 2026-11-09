import { path } from '@ttylabs/sigil/components/path';

const config = await path({ message: 'Config file', extensions: ['.ts', '.json'] });

console.log(`Reading ${config}`);
