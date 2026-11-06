import { multiline } from '@ttylabs/sigil/components';

const message = await multiline({ message: 'Commit message' });

console.log(message);
