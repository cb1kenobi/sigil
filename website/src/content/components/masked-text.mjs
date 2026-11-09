import { maskedText } from '@ttylabs/sigil/components/masked-text';

const phone = await maskedText({ message: 'Phone', template: '(###) ###-####' });

console.log(`Texting ${phone}`);
