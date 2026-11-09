import { multiline } from '@ttylabs/sigil/components/prompt';

const message = await multiline({ message: 'Commit message' });

console.log(message);
