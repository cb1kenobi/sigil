import { date } from '@ttylabs/sigil/components';

const release = await date({ message: 'Release date' });

console.log(`Releasing on ${release.toDateString()}`);
