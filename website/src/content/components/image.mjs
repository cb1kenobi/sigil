import { image } from '@ttylabs/sigil/components/image';
import { readFileSync } from 'node:fs';

console.log(image(readFileSync('macaw.png'), { width: 40 }));
