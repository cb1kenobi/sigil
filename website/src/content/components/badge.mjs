import { badge } from '@ttylabs/sigil/components';

console.log(
  [
    badge('PASS', { variant: 'success' }),
    badge('FAIL', { variant: 'error' }),
    badge('beta', { variant: 'warning' }),
    badge('v2.0.0'),
  ].join(' ')
);
