import { number } from '@ttylabs/sigil/components/number';

const retries = await number({ message: 'Retries', initial: 3, min: 0, max: 10 });

console.log(`Retrying up to ${retries} times`);
