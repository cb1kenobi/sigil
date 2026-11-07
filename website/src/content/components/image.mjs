import { image } from '@ttylabs/sigil/components';
import { readFileSync } from 'node:fs';

console.log(image(readFileSync('macaw.png'), { width: 40 }));
