import { list } from '@ttylabs/sigil/components/list';

const tags = await list({ message: 'Tags' });

console.log(`Tagged ${tags.length}: ${tags.join(' / ')}`);
