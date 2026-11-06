import { password } from '@ttylabs/sigil/components';

const token = await password({ message: 'npm token' });

console.log(`Saved a token of ${token.length} characters`);
