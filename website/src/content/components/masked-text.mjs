import { maskedText } from '@ttylabs/sigil/components';

const phone = await maskedText({ message: 'Phone', template: '(###) ###-####' });

console.log(`Texting ${phone}`);
