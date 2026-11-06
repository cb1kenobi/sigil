import { pickDate } from '@ttylabs/sigil/components';

const day = await pickDate({ message: 'Which day?' });

console.log(`Booked for ${day.toDateString()}`);
