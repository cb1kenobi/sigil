import { directoryTree } from '@ttylabs/sigil/components/tree';

const file = await directoryTree({ message: 'Open which file?' });

console.log(`Opening ${file}`);
