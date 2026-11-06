import { list } from '@ttylabs/sigil/components';

const tags = await list({ message: 'Tags' });

console.log(`Tagged ${tags.length}: ${tags.join(' / ')}`);
