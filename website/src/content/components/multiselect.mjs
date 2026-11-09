import { multiselect } from '@ttylabs/sigil/components/prompt';

const features = await multiselect({
  message: 'Features',
  choices: ['TypeScript', 'Linting', 'Testing', 'Shell completion'],
});

console.log(`Adding ${features.join(', ')}`);
