import { autocompleteMultiselect } from '@ttylabs/sigil/components';

const packages = await autocompleteMultiselect({
  message: 'Packages',
  choices: ['react', 'react-dom', 'redux', 'express', 'axios', 'lodash', 'chalk'],
});

console.log(`Installing ${packages.join(', ')}`);
