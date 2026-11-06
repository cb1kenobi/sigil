import { multiselect } from '@ttylabs/sigil/components';

const features = await multiselect({
  message: 'Features',
  choices: ['TypeScript', 'Linting', 'Testing', 'Shell completion'],
});

console.log(`Adding ${features.join(', ')}`);
